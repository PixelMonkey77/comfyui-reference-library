"""Changing a library (add, rename, replace, remove) and the route handlers that list and serve its files."""
import asyncio
import contextlib
import json
import logging
import os
import time

from aiohttp import web
from PIL import Image

from . import guard, nodes, pathutil, store

def _probe(path, kind):
    """Checks the file decodes; returns extra metadata (duration, size) for video/audio."""
    if kind == "image":
        with Image.open(path) as im:
            im.verify()
        return {}
    import av
    with av.open(path) as c:
        streams = c.streams.video if kind == "video" else c.streams.audio
        if not streams:
            raise ValueError(f"no {kind} stream")
        s = streams[0]
        duration = c.duration / 1_000_000 if c.duration else (
            float(s.duration * s.time_base) if s.duration and s.time_base else None)
        info = {"duration": round(duration, 3)} if duration else {}
        if kind == "video":
            info["width"], info["height"] = s.codec_context.width, s.codec_context.height
        return info


def _checked_file(raw):
    """(path, kind, info) for a readable media file, or raises LibError."""
    path = pathutil._clean_path(raw)
    kind = pathutil._kind_of(path)
    if path and not os.path.isabs(path):
        raise store.LibError(pathutil._RELATIVE, 400, "file")
    if not os.path.isfile(path):
        raise store.LibError(f"File not found: {path}", 400, "file")
    if kind is None:
        raise store.LibError(f"Not an image, video or audio file: {os.path.basename(path)}", 400, "file")
    try:
        return path, kind, _probe(path, kind)
    except Exception as e:
        raise store.LibError(f"Can't read {os.path.basename(path)}: {e}", 400, "file")


def _probe_all(raws):
    """Checks and probes files before the library lock is taken (PyAV on a large video, or a slow
    disk, can take seconds): raw path -> (path, kind, info) or the LibError to report."""
    out = {}
    for raw in raws:
        if isinstance(raw, str) and raw and raw not in out:
            try:
                out[raw] = _checked_file(raw)
            except Exception as e:
                out[raw] = e if isinstance(e, store.LibError) else store.LibError(f"Can't read {raw}: {e}", 400, "file")
    return out


def _checked(raw, probes):
    """A pre-probed result (see _probe_all), or a fresh check."""
    res = (probes or {}).get(raw)
    if res is None:
        res = _probe_all([raw]).get(raw) or store.LibError("No file given.", 400, "file")
    if isinstance(res, Exception):
        raise res
    return res


def _for_remote(body):
    """Another machine sees file names, not where they are on this computer."""
    return {**body, "assets": [{**a, "path": os.path.basename(a["path"])} for a in body.get("assets", [])]}


def _locked(fn=None):
    """Runs fn(data) (or just a read) under the lock in a worker thread, so slow disks never block
    ComfyUI's event loop; the response (which checks every file on disk) is built after the lock is
    released (from a copy, or the never-changed cache for reads). LibError -> JSON error with its field; anything else -> JSON 500."""
    async def run(*args):
        def work():
            with store._LIB_LOCK, (store._FileLock() if fn else contextlib.nullcontext()):
                data = store._load_library(readonly=fn is None)
                extra = (fn(data, *args) or {}) if fn else {}
            return store._library_payload(data, **extra)
        try:
            return web.json_response(await asyncio.to_thread(work))
        except store.LibError as e:
            return web.json_response({"error": str(e), "field": e.field}, status=e.status)
        except store.LibraryUnreadable as e:
            return web.json_response({"error": str(e)}, status=503)
        except Exception as e:
            logging.exception("[library_image] request failed")
            return web.json_response({"error": f"Library error: {e}"}, status=500)
    return run


_read_library = _locked()


async def _assets(request):
    resp = await _read_library()
    if resp.status == 200 and guard._trust(request) == "remote":
        return web.json_response(_for_remote(json.loads(resp.text)))
    return resp


def _add(data, body, probes=None):
    """Adds files to an existing library, or to a new one (created only if something was added).

    A single file with an explicit name must not clash (the dialog asks again); several files
    get unique names automatically and the renames are reported.
    """
    raw = body.get("items")
    items = [i for i in raw if isinstance(i, dict) and isinstance(i.get("path"), str) and i["path"]
             and isinstance(i.get("name") or "", str)] if isinstance(raw, list) else []
    if not items:
        raise store.LibError("No files given.", 400, "file")
    lib = store._find_lib(data, body.get("library_id")) if body.get("library_id") else None
    new_lib = lib is None
    if new_lib:
        if body.get("library_id"):
            raise store.LibError("That library no longer exists.", 404, "library")
        name = store._check_lib_name(data, body.get("new_library") or store._default_lib_name(data))
        lib = {"id": store._random_id(), "name": name, "assets": []}
    strict = len(items) == 1 and bool(items[0].get("name"))
    added, rejected, renamed = [], [], []
    known = {os.path.normcase(a["path"]) for a in lib["assets"]}
    for it in items:
        try:
            path, kind, info = _checked(it["path"], probes)
        except Exception as e:  # one bad file (odd path, decoder crash) mustn't sink the others
            if strict:
                raise e if isinstance(e, store.LibError) else store.LibError(str(e), 400, "file")
            rejected.append({"path": it["path"], "error": str(e)})
            continue
        if os.path.normcase(path) in known:
            msg = f"{os.path.basename(path)} is already in {lib['name']}."
            if strict:
                raise store.LibError(msg, 409, "file")
            rejected.append({"path": path, "error": msg})
            continue
        want = store._tag_name(it.get("name") or os.path.splitext(os.path.basename(path))[0])
        if strict and store._name_taken(want, lib["assets"]):
            raise store.LibError(f"@{want} is already in {lib['name']}.", 409, "name")
        final = store._unique_name(want, lib["assets"])
        if final != want:
            renamed.append({"from": want, "to": final})
        asset = {"id": store._random_id(), "name": final, "path": path,
                 "kind": kind, **info, "added": int(time.time())}
        lib["assets"].append(asset)
        known.add(os.path.normcase(path))
        added.append(asset["id"])
    if added:
        if new_lib:
            data["libraries"].append(lib)
        store._save_library(data)
    return {"added": added, "rejected": rejected, "renamed": renamed, "library": lib["id"] if added else None}


def _rename(data, body):
    lib, asset = store._find(data, body.get("id"))
    if asset is None:
        raise store.LibError("That asset is no longer in the library.", 404)
    name = store._tag_name(body.get("name"), fallback="")
    if not name:
        raise store.LibError("Names need at least one letter or digit.", 400, "name")
    if store._name_taken(name, lib["assets"], skip_id=asset["id"]):
        raise store.LibError(f"@{name} is already in {lib['name']}.", 409, "name")
    old = asset["name"]
    asset["name"] = name
    store._save_library(data)
    return {"renamed": name, "old": old}


def _replace(data, body, probes=None):
    """Points an asset at another file of the same kind (and optionally renames it); the id stays."""
    lib, asset = store._find(data, body.get("id"))
    if asset is None:
        raise store.LibError("That asset is no longer in the library.", 404)
    if not isinstance(body.get("path"), str):
        raise store.LibError("No file given.", 400, "file")
    path, kind, info = _checked(body["path"], probes)
    other = next((a for a in lib["assets"] if a["id"] != asset["id"]
                  and os.path.normcase(a["path"]) == os.path.normcase(path)), None)
    if other:
        raise store.LibError(f"{os.path.basename(path)} is already in {lib['name']} as @{other['name']}.", 409, "file")
    old_kind = asset.get("kind") or pathutil._kind_of(asset["path"])
    if kind != old_kind:
        raise store.LibError(f"@{asset['name']} is {'an' if old_kind[0] in 'aeiou' else 'a'} {old_kind}; "
                       f"pick {'an' if old_kind[0] in 'aeiou' else 'a'} {old_kind} file.", 400, "file")
    name = store._tag_name(body.get("name") or asset["name"], fallback="")
    if not name:
        raise store.LibError("Names need at least one letter or digit.", 400, "name")
    if store._name_taken(name, lib["assets"], skip_id=asset["id"]):
        raise store.LibError(f"@{name} is already in {lib['name']}.", 409, "name")
    old = asset["name"]
    for k in ("duration", "width", "height"):
        asset.pop(k, None)
    asset.update({"path": path, "kind": kind, "name": name, **info})
    store._save_library(data)
    return {"renamed": name, "old": old}


def _remove(data, body):
    lib, asset = store._find(data, body.get("id"))
    if asset is not None:
        lib["assets"].remove(asset)
        store._save_library(data)


def _lib_rename(data, body):
    lib = store._find_lib(data, body.get("id"))
    if lib is None:
        raise store.LibError("That library no longer exists.", 404, "library")
    old = lib["name"]
    lib["name"] = store._check_lib_name(data, body.get("name"), skip_id=lib["id"])
    store._save_library(data)
    return {"renamed": lib["name"], "old": old}


def _lib_delete(data, body):
    lib = store._find_lib(data, body.get("id"))
    if lib is not None:
        data["libraries"].remove(lib)
        store._save_library(data)


async def _file(request):
    """Streams a library file (with range support) for video/audio previews. Only media files: an
    entry pointing at an .html/.svg file (hand-edited library.json) must not become a page on
    ComfyUI's origin."""
    asset = await asyncio.to_thread(store._find_asset, request.query.get("id"))
    if asset is None or pathutil._kind_of(asset["path"]) is None or not await asyncio.to_thread(os.path.isfile, asset["path"]):
        return web.Response(status=404)
    resp = web.FileResponse(asset["path"])
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


async def _trusted_route(request):
    """For the node UI: may the loader nodes read this path? {"trusted": true/false/null} (null: not a
    full path to a media file). Local only: it describes this computer's trusted folders."""
    path = pathutil._clean_path(request.query.get("path", ""))
    if not path or not os.path.isabs(path) or pathutil._kind_of(path) is None:
        return web.json_response({"trusted": None})
    trusted = await asyncio.to_thread(store._is_trusted, path)
    return web.json_response({"trusted": trusted, "message": None if trusted else nodes._UNTRUSTED})
