"""library.json: reading, repairing, caching and saving it, the locks around changes, names and lookups,
and the folders the loader nodes may read."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
import unicodedata
import uuid

import folder_paths

from . import pathutil

# ---------------------------------------------------------------- asset libraries
# library.json: {"version": 2, "libraries": [{"id", "name", "assets": [{id, name, path, kind, ...}]}]}
# Files are referenced in place, never copied. Asset names are unique within their library,
# library names are unique overall; both are tag-safe, so "@Library_02/Biscuit" always parses.

_LIB_LOCK = threading.Lock()
_STAT_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="library_image_stat")


class LibError(Exception):
    def __init__(self, message, status=409, field=None):
        super().__init__(message)
        self.status, self.field = status, field


def _library_file():
    return os.path.join(folder_paths.get_user_directory(), "default", "library_image", "library.json")


def _stable_id(*parts):
    """Deterministic id (only for migrating the v1 file, which must map the same way on every read)."""
    return hashlib.sha1("|".join(map(str, parts)).encode("utf-8")).hexdigest()[:12]


def _random_id():
    # Never derived from the path: Replace keeps an asset's id while its path changes, so a
    # path-based id could later be handed to a second asset.
    return uuid.uuid4().hex[:12]


class LibraryUnreadable(Exception):
    pass


# A warning for the UI (shown once) when the library file had to be recovered.
_RECOVERY_NOTE = None


def _read_json(path):
    # utf-8-sig: Notepad and PowerShell save UTF-8 with a BOM, which plain utf-8 rejects.
    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("libraries", data.get("assets", [])), list):
        raise ValueError("unexpected structure")
    return data


def _valid_asset(a):
    return isinstance(a, dict) and all(isinstance(a.get(k), str) and a[k] for k in ("id", "name", "path"))


def _fix_kind(a):
    """An unknown kind (hand edit) would break thumbnails and loaders: derive it from the file
    type. Returns True if the entry changed."""
    if "kind" not in a or a["kind"] in pathutil.KIND_EXTS:
        return False
    a["kind"] = pathutil._kind_of(a["path"]) or "image"
    return True


def _entry_count(data):
    """Libraries + assets in a (possibly unnormalized) library file."""
    libs = data.get("libraries") if isinstance(data.get("libraries"), list) else None
    if libs is None:
        return len(data.get("assets") or [])
    return sum(1 + (len(l["assets"]) if isinstance(l, dict) and isinstance(l.get("assets"), list) else 0) for l in libs)


def _folder_key(folder):
    return os.path.normcase(os.path.realpath(folder))


def _trusted_folders(data):
    """Folders the loader nodes may read: those holding library files, those the user picked a file
    in (Browse… / + Add, kept in library.json), and ComfyUI's input and output folders (with their
    subfolders, like core Load Image)."""
    exact = {_folder_key(os.path.dirname(a["path"])) for _, a in _all_assets(data)}
    exact |= {_folder_key(f) for f in data.get("trusted_folders", [])}
    trees = []
    for get in ("get_input_directory", "get_output_directory"):
        try:
            trees.append(_folder_key(getattr(folder_paths, get)()))
        except Exception:
            pass
    return exact, trees


def _is_trusted(path, data=None):
    """True if the loader nodes may read `path` (an absolute path). The file's real location counts,
    so a link inside a trusted folder can't point elsewhere."""
    data = data if data is not None else _load_library(readonly=True)
    exact, trees = _trusted_folders(data)
    folder = _folder_key(os.path.dirname(os.path.realpath(path)))
    return folder in exact or any(folder == t or folder.startswith(t.rstrip("\\/") + os.sep) for t in trees)


def _trust_folders(paths):
    """Remembers the folders of files the user picked in the dialog (their choice = their consent)."""
    folders = {os.path.dirname(pathutil._clean_path(p)) for p in paths if pathutil._clean_path(p)}
    with _LIB_LOCK, _FileLock():
        data = _load_library()
        known = {_folder_key(f) for f in data.get("trusted_folders", [])}
        new = [f for f in sorted(folders) if _folder_key(f) not in known]
        if new:
            data["trusted_folders"] = data.get("trusted_folders", []) + new
            _save_library(data)


def _normalize(data):
    """The v2 structure with malformed entries dropped and duplicate ids re-issued (a hand-edited
    or merged file could repeat one, and every lookup by id would then hit the wrong entry).
    Returns (data, changed) so a repaired file is written back once."""
    if isinstance(data.get("libraries"), list):
        raw = data["libraries"]
        libs = [l for l in raw if isinstance(l, dict) and isinstance(l.get("id"), str) and l["id"]
                and isinstance(l.get("name"), str) and l["name"] and isinstance(l.get("assets"), list)]
        changed = len(libs) != len(raw)
        for l in libs:
            assets = [a for a in l["assets"] if _valid_asset(a)]
            changed |= len(assets) != len(l["assets"])
            changed |= any([_fix_kind(a) for a in assets])
            l["assets"] = assets
    else:
        # Version 1 was one flat list: it becomes Library_01 (ids are kept, so nothing breaks).
        assets = [a for a in data.get("assets") or [] if _valid_asset(a)]
        libs = [{"id": _stable_id("lib", "Library_01"), "name": "Library_01", "assets": assets}] if assets else []
        changed = False  # migrated on the next save; nothing to repair
    seen = set()
    for item in libs + [a for l in libs for a in l["assets"]]:
        if item["id"] in seen:
            item["id"] = _random_id()
            changed = True
        seen.add(item["id"])
    raw_trusted = data.get("trusted_folders")
    trusted = [f for f in raw_trusted if isinstance(f, str) and os.path.isabs(f)] if isinstance(raw_trusted, list) else []
    changed |= isinstance(raw_trusted, list) and len(trusted) != len(raw_trusted)
    return {"version": 2, "libraries": libs, "trusted_folders": trusted}, changed


# The parsed library, kept until library.json changes (mtime + size): reads, thumbnails and file
# requests no longer re-parse the whole file. The cached object is never changed in place (a save
# replaces it), so read-only callers can share it; writers work on a copy.
_CACHE = {"key": None, "data": None}


def _file_key(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _copy(data):
    """A copy deep enough to change freely: assets hold only plain values, so copying the dicts suffices."""
    return {**data, "libraries": [{**l, "assets": [dict(a) for a in l["assets"]]} for l in data["libraries"]],
            "trusted_folders": list(data.get("trusted_folders", []))}


def _load_library(readonly=False):
    """The library, parsed again only when the file changed. A private copy that callers may change,
    or with readonly=True the shared cached one (must not be changed; much faster for lookups)."""
    path = _library_file()
    key = _file_key(path)
    if key is None or key != _CACHE["key"]:
        data = _read_library_file(path)
        if key is None or _file_key(path) != key:  # missing, or rewritten meanwhile (repair / recovery)
            return data
        _CACHE.update(key=key, data=data)
    return _CACHE["data"] if readonly else _copy(_CACHE["data"])


def _read_library_file(path):
    """Reads the library. A missing file is an empty library unless a backup exists; an unreadable
    one is never treated as empty (the next save would wipe it): it is moved aside and the last
    good backup is used."""
    global _RECOVERY_NOTE
    try:
        raw = _read_json(path)
        before = _entry_count(raw)
        data, changed = _normalize(raw)
        if changed:
            logging.warning("[library_image] repaired the library file (malformed entries or duplicate ids)")
            _save_library(data)  # the unrepaired file becomes library.json.bak
            dropped = before - _entry_count(data)
            if dropped > 0:
                _RECOVERY_NOTE = (f"{dropped} damaged entr{'y was' if dropped == 1 else 'ies were'} removed from the "
                                  f"library file; the previous version was kept as library.json.bak.")
        return data
    except FileNotFoundError:
        # Gone but a backup exists (deleted by hand, or a crash between saves): restore the backup
        # rather than starting empty. Copied, not moved, so the backup survives a failed save.
        try:
            data, _ = _normalize(_read_json(path + ".bak"))
        except (OSError, ValueError):
            return {"version": 2, "libraries": []}
        _save_library(data, backup=False)
        _RECOVERY_NOTE = "The library file was missing; restored it from the last backup."
        logging.warning("[library_image] %s", _RECOVERY_NOTE)
        return data
    except OSError as e:
        # Locked or unreadable right now (e.g. antivirus): fail this request, keep the file.
        raise LibraryUnreadable(f"The library file can't be read right now ({e}). Try again in a moment.")
    except (ValueError, RecursionError):  # bad JSON/encoding, absurd nesting or wrong structure
        aside = f"{path}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
        try:
            os.replace(path, aside)
        except OSError:
            raise LibraryUnreadable(f"The library file is damaged and couldn't be set aside: {path}")
        try:
            data, _ = _normalize(_read_json(path + ".bak"))
            note = (f"The library file was damaged; restored the last good backup. "
                    f"The damaged file was kept as {os.path.basename(aside)}.")
        except (OSError, ValueError, RecursionError):
            data = {"version": 2, "libraries": []}
            note = (f"The library file was damaged and there was no usable backup; it was kept as "
                    f"{os.path.basename(aside)}, and the library starts empty.")
        # backup=False: the damaged file is already aside, and the .bak must not be overwritten.
        _save_library(data, backup=False)
        _RECOVERY_NOTE = note  # only once the recovered library is safely on disk
        logging.warning("[library_image] %s", note)
        return data


def _backup(path):
    """Copies the current good file to library.json.bak atomically (a crash mid-copy must not
    leave a half-written backup). A failed backup is logged, never fatal to the save."""
    tmp = f"{path}.bak.{uuid.uuid4().hex[:6]}.tmp"
    try:
        shutil.copy2(path, tmp)
        os.replace(tmp, path + ".bak")
    except OSError as e:
        logging.warning("[library_image] couldn't update the library backup: %s", e)
        try:
            os.remove(tmp)
        except OSError:
            pass


def _save_library(data, backup=True):
    """Atomic write via a unique temp file; the previous good file is kept as library.json.bak."""
    path = _library_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        if backup and os.path.exists(path):
            _backup(path)
        # Windows: antivirus, sync clients or editors can hold the file for a moment.
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                _CACHE.update(key=_file_key(path), data=_copy(data))
                return
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.05 * (attempt + 1))  # ~1 s in all, under the library lock
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _fold(name):
    """Name comparison key; the same rule as the browser's toLowerCase(), so both agree on clashes."""
    return name.lower()


def _tag_name(s, fallback="asset"):
    """Tag-safe name: letters, digits, _ and - only (the frontend's tagName() follows the same rule).
    NFC first, so an accented name pasted in decomposed form (macOS) stays one word; it must contain
    a letter or digit ("-" alone is no name)."""
    out = re.sub(r"[^\w-]+", "_", unicodedata.normalize("NFC", str(s or "")), flags=re.UNICODE).strip("_-")
    return out if re.search(r"[^\W_]", out) else fallback


def _unique_name(name, assets, skip_id=None):
    taken = {_fold(a["name"]) for a in assets if a["id"] != skip_id}
    base, n, out = name, 2, name
    while _fold(out) in taken:
        out = f"{base}_{n}"
        n += 1
    return out


def _name_taken(name, assets, skip_id=None):
    return any(_fold(a["name"]) == _fold(name) for a in assets if a["id"] != skip_id)


def _all_assets(data):
    return [(lib, a) for lib in data["libraries"] for a in lib["assets"]]


def _find(data, asset_id):
    return next(((lib, a) for lib, a in _all_assets(data) if a["id"] == asset_id), (None, None))


def _find_lib(data, lib_id):
    return next((l for l in data["libraries"] if l["id"] == lib_id), None)


def _default_lib_name(data):
    taken = {_fold(l["name"]) for l in data["libraries"]}
    n = 1
    while f"library_{n:02d}" in taken:
        n += 1
    return f"Library_{n:02d}"


def _check_lib_name(data, raw, skip_id=None):
    name = _tag_name(raw, fallback="")
    if not name:
        raise LibError("Library names need at least one letter or digit.", 400, "library")
    if any(_fold(l["name"]) == _fold(name) for l in data["libraries"] if l["id"] != skip_id):
        raise LibError(f"A library called {name} already exists.", 409, "library")
    return name


def _asset_view(lib, a):
    a = {**a, "kind": a.get("kind") or pathutil._kind_of(a["path"]) or "image", "library": lib["id"]}
    try:
        st = os.stat(a["path"])
        return {**a, "exists": True, "mtime": st.st_mtime_ns}
    except OSError:
        return {**a, "exists": False, "mtime": 0}


def _library_payload(data, **extra):
    """Response body: libraries, assets (each stat'ed on disk) and, once, a recovery warning."""
    global _RECOVERY_NOTE
    libs = [{"id": l["id"], "name": l["name"], "count": len(l["assets"])} for l in data["libraries"]]
    pairs = _all_assets(data)
    # A file on a slow or offline drive can take a while to check: check several at once.
    assets = list(_STAT_POOL.map(lambda p: _asset_view(*p), pairs)) if len(pairs) > 16 else [_asset_view(*p) for p in pairs]
    body = {"libraries": libs, "assets": assets, "next_library_name": _default_lib_name(data), **extra}
    if _RECOVERY_NOTE:
        body["warning"], _RECOVERY_NOTE = _RECOVERY_NOTE, None
    return body


class _FileLock:
    """Cross-process lock (library.json.lock) for changes: two ComfyUI instances sharing one user
    folder can't interleave read-change-save. Reads don't need it (saves replace the file atomically)."""

    def __enter__(self):
        path = _library_file() + ".lock"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.f = open(path, "a+b")
        deadline = time.monotonic() + 10
        while True:
            try:
                if sys.platform == "win32":
                    import msvcrt
                    self.f.seek(0)
                    msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() > deadline:
                    self.f.close()
                    raise LibraryUnreadable("The library is busy in another ComfyUI. Try again in a moment.")
                time.sleep(0.05)

    def __exit__(self, *exc):
        try:
            if sys.platform == "win32":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self.f.close()


def _find_asset(asset_id):
    try:
        with _LIB_LOCK:
            return _find(_load_library(readonly=True), asset_id)[1]
    except LibraryUnreadable:
        return None
