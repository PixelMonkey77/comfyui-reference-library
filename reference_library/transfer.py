"""Export and import: libraries travel between computers as one zip."""
import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
import zipfile
import zlib

from aiohttp import web
import folder_paths

from . import dialogs, guard, library, pathutil, store

# ---------------------------------------------------------------- export / import
# Libraries travel as one zip: library.json (the manifest: each library's and its assets' ids and
# names, never a disk path) and files/<library>/ (a copy of each file). Ids are kept on import, so
# workflows made on another computer keep their tags and their switched-off libraries.

_EXPORT_FORMAT = "comfyui-reference-library"
_EXPORT_VERSION = 2  # 1: a single library, {"id", "name", "assets"}, its files directly in files/
_MANIFEST = "library.json"
_MANIFEST_MAX = 16 * 1024 * 1024
_ZIP_FILTERS = [("Reference Library export", ["*.zip"]), ("All files", ["*.*"])]
_ID_RE = re.compile(r"[\w-]{1,64}")
_FOLDER_RE = re.compile(r"[\w-]{1,200}")
_IMPORT_SPARE = 256 * 1024 * 1024  # disk space an import always leaves free
_SEVERAL_NAME = "Reference_Libraries.zip"  # an export of more than one library
_LAST_EXPORT_DIR = {"path": ""}  # where the folder dialog opens next time


def _free_path(folder, filename, taken=()):
    """`filename` in `folder`, or "name_2.ext", "name_3.ext"… if that exists (or is in `taken`, lowercased)."""
    stem, ext = os.path.splitext(filename)
    n, name = 2, filename
    while name.lower() in taken or os.path.exists(os.path.join(folder, name)):
        name = f"{stem}_{n}{ext}"
        n += 1
    return os.path.join(folder, name)


def _export_start_dir():
    """Where the export's folder dialog opens: the last folder used, else ComfyUI's output folder."""
    last = _LAST_EXPORT_DIR["path"]
    return last if last and os.path.isdir(last) else folder_paths.get_output_directory()


def _import_folder(lib_name):
    return os.path.join(folder_paths.get_input_directory(), "reference_library", store._tag_name(lib_name, fallback="library"))


def _export_libraries(lib_ids, raw_folder):
    """Writes the chosen libraries into one zip in `raw_folder`: <Name>.zip for a single library,
    Reference_Libraries.zip for several (never over an existing file). Files that are missing on disk
    are left out and reported; a library with no file left to export is left out and reported too."""
    wanted = {i for i in lib_ids if isinstance(i, str)} if isinstance(lib_ids, list) else set()
    with store._LIB_LOCK:
        libs = [l for l in store._load_library(readonly=True)["libraries"] if l["id"] in wanted]
    if not libs:
        raise store.LibError("Choose at least one library to export." if not wanted else "That library no longer exists.",
                       400 if not wanted else 404, "library")
    folder = pathutil._clean_path(raw_folder)
    if not folder or not os.path.isabs(folder) or not os.path.isdir(folder):
        raise store.LibError(f"Folder not found: {folder}", 400, "folder")
    target = _free_path(folder, f"{libs[0]['name']}.zip" if len(libs) == 1 else _SEVERAL_NAME)
    tmp = f"{target}.{uuid.uuid4().hex[:6]}.part"
    done, empty = [], []
    try:
        # Stored, not compressed: images, video and audio already are.
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            for lib in libs:
                entries, skipped, names = [], [], set()
                for a in lib["assets"]:
                    kind = pathutil._kind_of(a["path"])
                    if kind is None or not os.path.isfile(a["path"]):
                        skipped.append(a["name"])
                        continue
                    base, n, name = os.path.basename(a["path"]), 2, os.path.basename(a["path"])
                    while name.lower() in names:  # two files of one name from different folders
                        name = f"{os.path.splitext(base)[0]}_{n}{os.path.splitext(base)[1]}"
                        n += 1
                    names.add(name.lower())
                    zf.write(a["path"], f"files/{lib['name']}/{name}")
                    entries.append({"id": a["id"], "name": a["name"], "kind": kind, "file": name})
                if not entries:
                    empty.append(lib["name"])
                    continue
                done.append(({"id": lib["id"], "name": lib["name"], "folder": lib["name"], "assets": entries}, skipped))
            if not done:
                raise store.LibError(("Nothing to export: " + ", ".join(empty) + " ha" + ("s" if len(empty) == 1 else "ve")
                                + " no files on disk."), 400, "library")
            manifest = {"format": _EXPORT_FORMAT, "version": _EXPORT_VERSION, "exported": int(time.time()),
                        "libraries": [m for m, _ in done]}
            zf.writestr(_MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2), zipfile.ZIP_DEFLATED)
        os.replace(tmp, target)
    except OSError as e:
        raise store.LibError(f"Couldn't finish the export to {folder}: {e.strerror or e}", 400, "folder")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    _LAST_EXPORT_DIR["path"] = folder
    return {"path": target, "empty": empty,
            "libraries": [{"name": m["name"], "files": len(m["assets"]), "skipped": skipped} for m, skipped in done]}


def _manifest_library(raw, folder):
    """One library of a manifest, its assets reduced to well-formed entries; None if it isn't one."""
    if not isinstance(raw, dict) or not isinstance(raw.get("assets"), list):
        return None
    assets = [a for a in raw["assets"] if isinstance(a, dict)
              and all(isinstance(a.get(k), str) and a[k] for k in ("name", "file"))]
    return {"id": raw["id"] if isinstance(raw.get("id"), str) and _ID_RE.fullmatch(raw["id"]) else None,
            "name": raw["name"] if isinstance(raw.get("name"), str) else "",
            "folder": folder, "assets": assets, "dropped": len(raw["assets"]) - len(assets)}


def _read_manifest(zf):
    """The export's libraries, checked: [{"id", "name", "folder", "assets", "dropped"}]."""
    not_ours = store.LibError("This zip isn't a Reference Library export.", 400, "file")
    try:
        info = zf.getinfo(_MANIFEST)
    except KeyError:
        raise not_ours
    if info.file_size > _MANIFEST_MAX:
        raise not_ours
    try:
        m = json.loads(zf.read(info).decode("utf-8-sig"))
    except (ValueError, OSError, zipfile.BadZipFile):
        raise not_ours
    if not isinstance(m, dict) or m.get("format") != _EXPORT_FORMAT or not isinstance(m.get("version"), int):
        raise not_ours
    if m["version"] > _EXPORT_VERSION:
        raise store.LibError("This export was made by a newer version of the Reference Library. Update the pack to import it.", 400, "file")
    if m["version"] == 1:
        libs = [_manifest_library(m, None)]
    else:
        raw = m.get("libraries")
        # A library's folder inside the zip is one plain name: nothing in it can point elsewhere.
        libs = [_manifest_library(l, l["folder"]) if isinstance(l, dict) and isinstance(l.get("folder"), str)
                and _FOLDER_RE.fullmatch(l["folder"]) else None for l in raw] if isinstance(raw, list) else [None]
    if any(l is None for l in libs):
        raise not_ours
    return libs


def _same_file(path, info):
    """True if the file at `path` has the content of zip entry `info` (size, then checksum)."""
    try:
        if os.path.getsize(path) != info.file_size:
            return False
        crc = 0
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                crc = zlib.crc32(chunk, crc)
        return crc == info.CRC
    except OSError:
        return False


def _unpack_library(zf, members, m):
    """Unpacks the files of one exported library that this computer doesn't have yet into
    <ComfyUI input>/reference_library/<Name>/. Nothing in the zip chooses where a file lands: only
    its bare, media-typed file name is used."""
    with store._LIB_LOCK:
        lib = store._find_lib(store._load_library(readonly=True), m["id"]) if m["id"] else None
    have = {a["id"] for a in lib["assets"]} if lib else set()
    folder = _import_folder(lib["name"] if lib else m["name"])
    prefix = f"files/{m['folder']}/" if m["folder"] else "files/"
    ready, rejected, already = [], [], 0
    for a in m["assets"]:
        if a.get("id") in have:
            already += 1
            continue
        name = a["file"]
        info = members.get(prefix + name)
        if name != os.path.basename(name) or "\\" in name or ":" in name or pathutil._kind_of(name) is None:
            rejected.append({"name": a["name"], "error": "not an image, video or audio file"})
            continue
        if info is None:
            rejected.append({"name": a["name"], "error": "its file is missing from the export"})
            continue
        os.makedirs(folder, exist_ok=True)
        target = os.path.join(folder, name)
        if not _same_file(target, info):  # an identical file from an earlier import is used again
            if shutil.disk_usage(folder).free < info.file_size + _IMPORT_SPARE:
                rejected.append({"name": a["name"], "error": "not enough free disk space"})
                continue
            target = _free_path(folder, name)
            tmp = f"{target}.{uuid.uuid4().hex[:6]}.part"
            try:
                with zf.open(info) as src, open(tmp, "wb") as out:
                    shutil.copyfileobj(src, out, 1 << 20)
                os.replace(tmp, target)
            except (OSError, zipfile.BadZipFile, zlib.error) as e:
                rejected.append({"name": a["name"], "error": f"couldn't be unpacked: {e}"})
                continue
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        try:
            checked, kind, meta = library._checked_file(target)
        except store.LibError as e:
            os.remove(target)  # not a readable media file: don't leave it in the input folder
            rejected.append({"name": a["name"], "error": str(e)})
            continue
        ready.append({"id": a.get("id"), "name": a["name"], "path": checked, "kind": kind, "meta": meta})
    if m["dropped"]:
        rejected.append({"name": f"{m['dropped']} damaged entr{'y' if m['dropped'] == 1 else 'ies'}", "error": "skipped"})
    return {"id": m["id"], "name": m["name"], "ready": ready, "rejected": rejected, "already": already, "folder": folder}


def _prepare_import(raw_path):
    """Reads an export and unpacks what's new, outside the library lock (large files take a while)."""
    path = pathutil._clean_path(raw_path)
    if not os.path.isabs(path) or not os.path.isfile(path):
        raise store.LibError(f"File not found: {path}", 400, "file")
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        raise store.LibError("This file isn't a Reference Library export (not a zip file).", 400, "file")
    with zf:
        members = {i.filename: i for i in zf.infolist() if not i.is_dir()}
        return [_unpack_library(zf, members, m) for m in _read_manifest(zf)]


def _import_one(data, prep, used):
    """The unpacked files of one exported library become a new library, or join the library the
    export came from if it is already here (same id). Ids from the export are kept unless something
    else has them. Returns its summary; `changed` says whether `data` now differs."""
    lib = store._find_lib(data, prep["id"]) if prep["id"] else None
    new = lib is None
    if new:
        wanted = store._tag_name(prep["name"], fallback="") or store._default_lib_name(data)
        name = store._unique_name(wanted, [{"id": l["id"], "name": l["name"]} for l in data["libraries"]])
        lib = {"id": prep["id"] if prep["id"] and prep["id"] not in used else store._random_id(), "name": name, "assets": []}
    else:
        wanted = name = lib["name"]
    known = {os.path.normcase(a["path"]) for a in lib["assets"]}
    here = {a["id"] for a in lib["assets"]}
    added, renamed, already = [], [], prep["already"]
    for r in prep["ready"]:
        if r["id"] in here or os.path.normcase(r["path"]) in known:
            already += 1
            continue
        asset_id = r["id"] if isinstance(r["id"], str) and _ID_RE.fullmatch(r["id"]) and r["id"] not in used else store._random_id()
        want = store._tag_name(r["name"])
        final = store._unique_name(want, lib["assets"])
        if final != want:
            renamed.append({"from": want, "to": final})
        lib["assets"].append({"id": asset_id, "name": final, "path": r["path"], "kind": r["kind"], **r["meta"],
                              "added": int(time.time())})
        used.add(asset_id)
        known.add(os.path.normcase(r["path"]))
        added.append(asset_id)
    failed = new and not added  # nothing in it could be imported: no empty library is made
    if new and added:
        used.add(lib["id"])
        data["libraries"].append(lib)
    return {"library": None if failed else lib["id"], "name": wanted if failed else lib["name"], "new": new,
            "failed": failed, "added": added, "already": already, "wanted_name": wanted if wanted != name and not failed else None,
            "renamed": renamed, "rejected": prep["rejected"], "folder": prep["folder"]}


def _finish_import(data, preps):
    """Under the lock: every library of the export, one after the other; one save."""
    used = {l["id"] for l in data["libraries"]} | {a["id"] for _, a in store._all_assets(data)}
    results = [_import_one(data, p, used) for p in preps]
    if all(r["failed"] for r in results):
        first = next((x for r in results for x in r["rejected"]), None)
        raise store.LibError("Nothing in this export could be imported" + (f" ({first['name']}: {first['error']})." if first else "."), 400, "file")
    if any(r["added"] for r in results):
        store._save_library(data)
    return {"imported": {"libraries": results}}


async def _transfer(work):
    """Runs an export / import step; its errors become JSON like the other library routes'."""
    try:
        return await work(), None
    except dialogs.DialogBusy as e:
        return None, web.json_response({"error": str(e)}, status=409)
    except store.LibError as e:
        return None, web.json_response({"error": str(e), "field": e.field}, status=e.status)
    except store.LibraryUnreadable as e:
        return None, web.json_response({"error": str(e)}, status=503)
    except Exception as e:
        logging.exception("[library_image] export / import failed")
        return None, web.json_response({"error": f"Library error: {e}"}, status=500)


async def _export_route(request):
    """{"ids": [library ids], "folder"?: path} -> {"exported": {"path", "libraries": [{"name", "files",
    "skipped": [asset names]}], "empty": [library names]}}. Without "folder" a native folder dialog
    asks for it ("exported": null if cancelled)."""
    body = await guard._json_body(request)
    folder = body.get("folder") if isinstance(body.get("folder"), str) and body.get("folder") else None

    async def work():
        nonlocal folder
        if folder is None:
            picked = await asyncio.to_thread(lambda: dialogs._open_file_dialog(_export_start_dir(), folder=True))
            if not picked:
                return None
            folder = picked[0]
        return await asyncio.to_thread(_export_libraries, body.get("ids"), folder)

    done, error = await _transfer(work)
    return error or web.json_response({"exported": done})


async def _import_route(request):
    """Imports an export: {"path": zip} or, without one, the zip picked in a native dialog.
    -> the library payload plus {"imported": {"libraries": [...]}} ("imported": null if cancelled)."""
    body = await guard._json_body(request)
    path = body.get("path") if isinstance(body.get("path"), str) and body.get("path") else None

    async def work():
        nonlocal path
        if path is None:
            picked = await asyncio.to_thread(lambda: dialogs._open_file_dialog(_export_start_dir(), False, filters=_ZIP_FILTERS, exts=["zip"]))
            if not picked:
                return None
            path = picked[0]
        return await asyncio.to_thread(_prepare_import, path)

    preps, error = await _transfer(work)
    if error or preps is None:
        return error or web.json_response({"imported": None})
    return await library._locked(_finish_import)(preps)
