import asyncio
import contextlib
import hashlib
import io
import ipaddress
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import folder_paths
import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps, ImageSequence
from server import PromptServer

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"}
KIND_EXTS = {"image": IMAGE_EXTS, "video": VIDEO_EXTS, "audio": AUDIO_EXTS}
routes = PromptServer.instance.routes


def _raw_path(p):
    """A typed or pasted path as the user wrote it, minus the quotes of Windows "Copy as path"."""
    return str(p or "").strip().strip('"').strip("'")


def _clean_path(p):
    """A typed or pasted path, tidied: quotes removed, ~ expanded, absolute paths normalized. No
    %VAR% / $VAR expansion: a queued path could otherwise read environment variables (API keys) back
    through error messages. Relative paths are left as they are and rejected where a file is needed
    (they would depend on ComfyUI's working folder)."""
    p = _raw_path(p)
    if not p:
        return ""
    p = os.path.expanduser(p)
    return os.path.abspath(p) if os.path.isabs(p) else p


_RELATIVE = r"Use a full path (for example D:\Pictures\cat.png), not one relative to ComfyUI's folder."


def _kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    return next((k for k, exts in KIND_EXTS.items() if ext in exts), None)


async def _json_body(request):
    try:
        body = await request.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def _loopback(host):
    host = (host or "").strip("[]").removeprefix("::ffff:").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _trust(request):
    """How far to trust a request to the library routes:
      "local"   from this computer, addressed to it by a loopback name (127.0.0.1, localhost, [::1]);
      "remote"  from another machine (ComfyUI started with --listen): may browse the library only;
      None      refused: a cross-site request, or one that arrives from this computer under another
                host name, which is what DNS rebinding (a web page whose domain points at
                127.0.0.1) and local proxies look like. ComfyUI's own origin check misses both, and
                is off entirely with --enable-cors-header."""
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        return None
    peer_local = _loopback(request.remote)
    host_local = _loopback(urllib.parse.urlsplit("//" + (request.host or "")).hostname)
    if peer_local:
        return "local" if host_local else None
    return "remote"


_LOCAL_ONLY = "Changing the library works only on the computer running ComfyUI."
_REFUSED = ("Refused: open ComfyUI at http://127.0.0.1 or http://localhost to use the Reference Library "
            "(requests through other host names or from other websites are blocked for safety).")


def _guard(handler, local=False):
    """Wraps a library route: refuses untrusted requests, and remote ones too when `local`."""
    async def guarded(request):
        trust = _trust(request)
        if trust is None:
            return web.json_response({"error": _REFUSED}, status=403)
        if local and trust != "local":
            return web.json_response({"error": _LOCAL_ONLY}, status=403)
        return await handler(request)
    guarded.__name__ = getattr(handler, "__name__", "guarded")
    return guarded


# ---------------------------------------------------------------- native file dialog
# Browsers never expose real file paths, so the server (same machine) opens a native dialog.

def _patterns(kinds):
    return [f"*{e}" for k in kinds for e in sorted(KIND_EXTS[k])]


def _dialog_filters(kinds):
    """[(label, [patterns])], with an "all supported" entry first when several kinds are allowed."""
    rows = [(k.capitalize() + "s" if k != "audio" else "Audio", _patterns([k])) for k in kinds]
    if len(kinds) > 1:
        rows.insert(0, ("Images, videos and audio", _patterns(kinds)))
    return rows + [("All files", ["*.*"])]


_PS_DIALOG = r"""
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Reference Library'
$d.Multiselect = ($env:LI_MULTI -eq '1')
$d.Filter = $env:LI_FILTER
if ($env:LI_INIT -and (Test-Path -LiteralPath $env:LI_INIT -PathType Container)) { $d.InitialDirectory = $env:LI_INIT }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($d.FileNames -join "`n")) }
"""

_TK_DIALOG = r"""
import json, os, sys, tkinter as tk
from tkinter import filedialog
r = tk.Tk(); r.withdraw(); r.attributes("-topmost", True)
types = [(label, " ".join(p)) for label, p in json.loads(os.environ["LI_FILTER"])]
kw = dict(parent=r, initialdir=os.environ.get("LI_INIT") or None, title="Reference Library", filetypes=types)
if os.environ.get("LI_MULTI") == "1":
    sys.stdout.write("\n".join(filedialog.askopenfilenames(**kw)))
else:
    sys.stdout.write(filedialog.askopenfilename(**kw) or "")
"""

# macOS: Tk is often unusable in bundled Pythons (Comfy Desktop's can't find init.tcl); osascript is always
# there. Arguments come in as argv (never pasted into the script), so any path is safe. Cancel returns "".
_MAC_DIALOG = r"""
on run argv
	set multi to (item 1 of argv) is "1"
	set init to item 2 of argv
	set exts to items 3 thru -1 of argv
	activate
	try
		if init is "" then
			set picked to choose file with prompt "Reference Library" of type exts multiple selections allowed multi
		else
			set picked to choose file with prompt "Reference Library" of type exts default location (POSIX file init) multiple selections allowed multi
		end if
	on error number -128
		return ""
	end try
	if class of picked is not list then set picked to {picked}
	set out to {}
	repeat with f in picked
		set end of out to POSIX path of f
	end repeat
	set AppleScript's text item delimiters to linefeed
	return out as text
end run
"""


def _fake_dialog(queue_file):
    """Automation only (tools/screenshots): when LIBRARY_IMAGE_FAKE_DIALOG names a JSON file holding a
    list of answers (each a list of paths), each dialog takes the next answer instead of opening a
    window. Only whoever starts the server can set it."""
    with _DIALOG_LOCK:
        try:
            with open(queue_file, encoding="utf-8") as f:
                answers = json.load(f)
        except (OSError, ValueError):
            return []
        answer = answers.pop(0) if answers else []
        with open(queue_file, "w", encoding="utf-8") as f:
            json.dump(answers, f)
    return [str(p) for p in answer if isinstance(p, str)]


def _open_file_dialog(initial_dir, multi=False, kinds=("image",)):
    if os.environ.get("LIBRARY_IMAGE_FAKE_DIALOG"):
        return _fake_dialog(os.environ["LIBRARY_IMAGE_FAKE_DIALOG"])
    filters = _dialog_filters(list(kinds))
    if sys.platform == "win32":
        flt = "|".join(f"{label}|{';'.join(p)}" for label, p in filters)
        cmd = ["powershell", "-NoProfile", "-STA", "-NonInteractive", "-Command", _PS_DIALOG]
        flags = subprocess.CREATE_NO_WINDOW
    elif sys.platform == "darwin":
        # No "All files" choice on the Mac picker: only supported extensions can be picked.
        flt = ""
        init = initial_dir if initial_dir and os.path.isdir(initial_dir) else ""  # choose file fails on a missing folder
        exts = [e[1:] for k in kinds for e in sorted(KIND_EXTS[k])]
        cmd = ["osascript", "-e", _MAC_DIALOG, "1" if multi else "0", init, *exts]
        flags = 0
    else:
        flt = json.dumps(filters)
        cmd = [sys.executable, "-c", _TK_DIALOG]
        flags = 0
    env = {**os.environ, "LI_INIT": initial_dir or "", "LI_MULTI": "1" if multi else "0", "LI_FILTER": flt}
    # One dialog at a time: a second one would open behind the first and look like a hang.
    if not _DIALOG_LOCK.acquire(blocking=False):
        raise DialogBusy("A file dialog is already open (it may be behind the ComfyUI window).")
    try:
        res = subprocess.run(cmd, capture_output=True, env=env, creationflags=flags, timeout=_DIALOG_TIMEOUT)
    except subprocess.TimeoutExpired:
        return []
    finally:
        _DIALOG_LOCK.release()
    if res.returncode != 0:
        err = res.stderr.decode("utf-8", "replace").strip()
        logging.warning("[library_image] file dialog exited with %s: %s", res.returncode, err)
        raise RuntimeError(err.splitlines()[-1] if err else f"the dialog helper exited with code {res.returncode}")
    out = res.stdout.decode("utf-8", "replace")
    return [p.strip() for p in out.splitlines() if p.strip()]


_DIALOG_LOCK = threading.Lock()
_DIALOG_TIMEOUT = 300  # seconds; a forgotten dialog shouldn't hold the lock forever


class DialogBusy(Exception):
    pass


# Files the user picked in the dialog recently: only these get a thumbnail by path (before they're
# in the library), so /thumb can't be used to read arbitrary files.
_PICKED = OrderedDict()


def _remember_pick(path):
    key = os.path.normcase(_clean_path(path))
    _PICKED[key] = True
    _PICKED.move_to_end(key)
    while len(_PICKED) > 500:
        _PICKED.popitem(last=False)


def _was_picked(path):
    return os.path.normcase(_clean_path(path)) in _PICKED


async def _dialog_response(key, current, multi, kinds):
    try:
        # _initial_dir checks the disk: in the worker thread too (a network path can hang).
        paths = await asyncio.to_thread(lambda: _open_file_dialog(_initial_dir(current), multi, kinds))
    except DialogBusy as e:
        return web.json_response({"error": str(e)}, status=409)
    except Exception as e:
        logging.exception("[library_image] file dialog failed")
        return web.json_response({"error": f"File dialog failed: {e}"}, status=500)
    for p in paths:
        _remember_pick(p)
    if paths:
        await asyncio.to_thread(_trust_folders, paths)
    return web.json_response({key: (paths[0] if paths else None) if key == "path" else paths})


def _initial_dir(current):
    current = _clean_path(current)
    return current if os.path.isdir(current) else os.path.dirname(current)


def _requested_kinds(body, default=("image",)):
    raw = body.get("kinds")
    kinds = [k for k in raw if isinstance(k, str) and k in KIND_EXTS] if isinstance(raw, list) else []
    return tuple(dict.fromkeys(kinds)) or default


async def _browse(request):
    body = await _json_body(request)
    return await _dialog_response("path", str(body.get("current") or ""), False, _requested_kinds(body))


routes.post("/library_image/browse")(_guard(_browse, local=True))


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
    if "kind" not in a or a["kind"] in KIND_EXTS:
        return False
    a["kind"] = _kind_of(a["path"]) or "image"
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
    folders = {os.path.dirname(_clean_path(p)) for p in paths if _clean_path(p)}
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
    path = _clean_path(raw)
    kind = _kind_of(path)
    if path and not os.path.isabs(path):
        raise LibError(_RELATIVE, 400, "file")
    if not os.path.isfile(path):
        raise LibError(f"File not found: {path}", 400, "file")
    if kind is None:
        raise LibError(f"Not an image, video or audio file: {os.path.basename(path)}", 400, "file")
    try:
        return path, kind, _probe(path, kind)
    except Exception as e:
        raise LibError(f"Can't read {os.path.basename(path)}: {e}", 400, "file")


def _probe_all(raws):
    """Checks and probes files before the library lock is taken (PyAV on a large video, or a slow
    disk, can take seconds): raw path -> (path, kind, info) or the LibError to report."""
    out = {}
    for raw in raws:
        if isinstance(raw, str) and raw and raw not in out:
            try:
                out[raw] = _checked_file(raw)
            except Exception as e:
                out[raw] = e if isinstance(e, LibError) else LibError(f"Can't read {raw}: {e}", 400, "file")
    return out


def _checked(raw, probes):
    """A pre-probed result (see _probe_all), or a fresh check."""
    res = (probes or {}).get(raw)
    if res is None:
        res = _probe_all([raw]).get(raw) or LibError("No file given.", 400, "file")
    if isinstance(res, Exception):
        raise res
    return res


def _asset_view(lib, a):
    a = {**a, "kind": a.get("kind") or _kind_of(a["path"]) or "image", "library": lib["id"]}
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


def _for_remote(body):
    """Another machine sees file names, not where they are on this computer."""
    return {**body, "assets": [{**a, "path": os.path.basename(a["path"])} for a in body.get("assets", [])]}


def _locked(fn=None):
    """Runs fn(data) (or just a read) under the lock in a worker thread, so slow disks never block
    ComfyUI's event loop; the response (which checks every file on disk) is built after the lock is
    released (from a copy, or the never-changed cache for reads). LibError -> JSON error with its field; anything else -> JSON 500."""
    async def run(*args):
        def work():
            with _LIB_LOCK, (_FileLock() if fn else contextlib.nullcontext()):
                data = _load_library(readonly=fn is None)
                extra = (fn(data, *args) or {}) if fn else {}
            return _library_payload(data, **extra)
        try:
            return web.json_response(await asyncio.to_thread(work))
        except LibError as e:
            return web.json_response({"error": str(e), "field": e.field}, status=e.status)
        except LibraryUnreadable as e:
            return web.json_response({"error": str(e)}, status=503)
        except Exception as e:
            logging.exception("[library_image] request failed")
            return web.json_response({"error": f"Library error: {e}"}, status=500)
    return run


def _find_asset(asset_id):
    try:
        with _LIB_LOCK:
            return _find(_load_library(readonly=True), asset_id)[1]
    except LibraryUnreadable:
        return None


_read_library = _locked()


async def _assets(request):
    resp = await _read_library()
    if resp.status == 200 and _trust(request) == "remote":
        return web.json_response(_for_remote(json.loads(resp.text)))
    return resp


routes.get("/library_image/assets")(_guard(_assets))


async def _pick(request):
    """Native file dialog only (nothing is added): {"paths": [...]}."""
    body = await _json_body(request)
    kinds = _requested_kinds(body, default=tuple(KIND_EXTS))
    return await _dialog_response(
        "paths", str(body.get("current") or ""), bool(body.get("multi", True)), kinds)


routes.post("/library_image/pick")(_guard(_pick, local=True))


def _add(data, body, probes=None):
    """Adds files to an existing library, or to a new one (created only if something was added).

    A single file with an explicit name must not clash (the dialog asks again); several files
    get unique names automatically and the renames are reported.
    """
    raw = body.get("items")
    items = [i for i in raw if isinstance(i, dict) and isinstance(i.get("path"), str) and i["path"]
             and isinstance(i.get("name") or "", str)] if isinstance(raw, list) else []
    if not items:
        raise LibError("No files given.", 400, "file")
    lib = _find_lib(data, body.get("library_id")) if body.get("library_id") else None
    new_lib = lib is None
    if new_lib:
        if body.get("library_id"):
            raise LibError("That library no longer exists.", 404, "library")
        name = _check_lib_name(data, body.get("new_library") or _default_lib_name(data))
        lib = {"id": _random_id(), "name": name, "assets": []}
    strict = len(items) == 1 and bool(items[0].get("name"))
    added, rejected, renamed = [], [], []
    known = {os.path.normcase(a["path"]) for a in lib["assets"]}
    for it in items:
        try:
            path, kind, info = _checked(it["path"], probes)
        except Exception as e:  # one bad file (odd path, decoder crash) mustn't sink the others
            if strict:
                raise e if isinstance(e, LibError) else LibError(str(e), 400, "file")
            rejected.append({"path": it["path"], "error": str(e)})
            continue
        if os.path.normcase(path) in known:
            msg = f"{os.path.basename(path)} is already in {lib['name']}."
            if strict:
                raise LibError(msg, 409, "file")
            rejected.append({"path": path, "error": msg})
            continue
        want = _tag_name(it.get("name") or os.path.splitext(os.path.basename(path))[0])
        if strict and _name_taken(want, lib["assets"]):
            raise LibError(f"@{want} is already in {lib['name']}.", 409, "name")
        final = _unique_name(want, lib["assets"])
        if final != want:
            renamed.append({"from": want, "to": final})
        asset = {"id": _random_id(), "name": final, "path": path,
                 "kind": kind, **info, "added": int(time.time())}
        lib["assets"].append(asset)
        known.add(os.path.normcase(path))
        added.append(asset["id"])
    if added:
        if new_lib:
            data["libraries"].append(lib)
        _save_library(data)
    return {"added": added, "rejected": rejected, "renamed": renamed, "library": lib["id"] if added else None}


def _rename(data, body):
    lib, asset = _find(data, body.get("id"))
    if asset is None:
        raise LibError("That asset is no longer in the library.", 404)
    name = _tag_name(body.get("name"), fallback="")
    if not name:
        raise LibError("Names need at least one letter or digit.", 400, "name")
    if _name_taken(name, lib["assets"], skip_id=asset["id"]):
        raise LibError(f"@{name} is already in {lib['name']}.", 409, "name")
    old = asset["name"]
    asset["name"] = name
    _save_library(data)
    return {"renamed": name, "old": old}


def _replace(data, body, probes=None):
    """Points an asset at another file of the same kind (and optionally renames it); the id stays."""
    lib, asset = _find(data, body.get("id"))
    if asset is None:
        raise LibError("That asset is no longer in the library.", 404)
    if not isinstance(body.get("path"), str):
        raise LibError("No file given.", 400, "file")
    path, kind, info = _checked(body["path"], probes)
    other = next((a for a in lib["assets"] if a["id"] != asset["id"]
                  and os.path.normcase(a["path"]) == os.path.normcase(path)), None)
    if other:
        raise LibError(f"{os.path.basename(path)} is already in {lib['name']} as @{other['name']}.", 409, "file")
    old_kind = asset.get("kind") or _kind_of(asset["path"])
    if kind != old_kind:
        raise LibError(f"@{asset['name']} is {'an' if old_kind[0] in 'aeiou' else 'a'} {old_kind}; "
                       f"pick {'an' if old_kind[0] in 'aeiou' else 'a'} {old_kind} file.", 400, "file")
    name = _tag_name(body.get("name") or asset["name"], fallback="")
    if not name:
        raise LibError("Names need at least one letter or digit.", 400, "name")
    if _name_taken(name, lib["assets"], skip_id=asset["id"]):
        raise LibError(f"@{name} is already in {lib['name']}.", 409, "name")
    old = asset["name"]
    for k in ("duration", "width", "height"):
        asset.pop(k, None)
    asset.update({"path": path, "kind": kind, "name": name, **info})
    _save_library(data)
    return {"renamed": name, "old": old}


def _remove(data, body):
    lib, asset = _find(data, body.get("id"))
    if asset is not None:
        lib["assets"].remove(asset)
        _save_library(data)


def _lib_rename(data, body):
    lib = _find_lib(data, body.get("id"))
    if lib is None:
        raise LibError("That library no longer exists.", 404, "library")
    old = lib["name"]
    lib["name"] = _check_lib_name(data, body.get("name"), skip_id=lib["id"])
    _save_library(data)
    return {"renamed": lib["name"], "old": old}


def _lib_delete(data, body):
    lib = _find_lib(data, body.get("id"))
    if lib is not None:
        data["libraries"].remove(lib)
        _save_library(data)


for _route, _fn in {
    "/library_image/add": _add,
    "/library_image/rename": _rename,
    "/library_image/replace": _replace,
    "/library_image/remove": _remove,
    "/library_image/library/rename": _lib_rename,
    "/library_image/library/delete": _lib_delete,
}.items():
    def _make(fn):
        run = _locked(fn)
        # Add / Replace read the new files first, outside the lock (see _probe_all).
        precheck = {_add: lambda b: [i.get("path") for i in b.get("items") or [] if isinstance(i, dict)]
                    if isinstance(b.get("items"), list) else [],
                    _replace: lambda b: [b.get("path")]}.get(fn)

        async def handler(request):
            body = await _json_body(request)
            if precheck is None:
                return await run(body)
            return await run(body, await asyncio.to_thread(_probe_all, precheck(body)))
        return _guard(handler, local=True)  # every change: this computer only
    routes.post(_route)(_make(_fn))


async def _file(request):
    """Streams a library file (with range support) for video/audio previews. Only media files: an
    entry pointing at an .html/.svg file (hand-edited library.json) must not become a page on
    ComfyUI's origin."""
    asset = await asyncio.to_thread(_find_asset, request.query.get("id"))
    if asset is None or _kind_of(asset["path"]) is None or not await asyncio.to_thread(os.path.isfile, asset["path"]):
        return web.Response(status=404)
    resp = web.FileResponse(asset["path"])
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


routes.get("/library_image/file")(_guard(_file))


_THUMBS = OrderedDict()
_THUMB_MAX = 400
_MASTER = 512  # one master thumbnail per file is kept on disk; smaller sizes are made from it
_THUMB_DISK_MAX = 3000


# Caches live inside the pack's own folder, so uninstalling the pack (which just deletes that folder)
# leaves nothing behind. Only the libraries themselves (library.json) are kept in the user folder.
_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")


def _thumb_dir():
    return os.path.join(_CACHE_DIR, "thumbs")


def _remove_old_thumb_cache():
    """Versions up to 0.1.2 kept the thumbnail cache in user/default/library_image/thumbs: remove it once.
    Only that folder, and only if it holds nothing but cache files."""
    old = os.path.join(folder_paths.get_user_directory(), "default", "library_image", "thumbs")
    try:
        names = os.listdir(old)
    except OSError:
        return
    if all(n.endswith((".webp", ".tmp")) for n in names):
        shutil.rmtree(old, ignore_errors=True)


_remove_old_thumb_cache()


_MASTER_LOCKS = {}  # thumbnail key -> lock: simultaneous requests for a new file make it once
_MASTER_GUARD = threading.Lock()


def _master_thumb(path, st, kind):
    """The 512 px thumbnail of a file, from the disk cache (survives restarts) or made now."""
    key = hashlib.sha1(f"{os.path.normcase(path)}|{st.st_mtime_ns}|{st.st_size}|1".encode("utf-8")).hexdigest()
    with _MASTER_GUARD:
        lock = _MASTER_LOCKS.setdefault(key, threading.Lock())
    try:
        with lock:  # a second request waits here, then finds the file the first one wrote
            return _master_thumb_locked(path, kind, key)
    finally:
        with _MASTER_GUARD:
            if not lock.locked():
                _MASTER_LOCKS.pop(key, None)


def _master_thumb_locked(path, kind, key):
    cached = os.path.join(_thumb_dir(), key + ".webp")
    try:
        with open(cached, "rb") as f:
            return f.read()
    except OSError:
        pass
    data = _make_thumb(path, _MASTER, kind)
    try:
        os.makedirs(_thumb_dir(), exist_ok=True)
        tmp = f"{cached}.{uuid.uuid4().hex[:6]}.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, cached)
        if uuid.uuid4().int % 50 == 0:
            _prune_thumbs()
    except OSError as e:
        logging.debug("[library_image] thumbnail cache write failed: %s", e)
    return data


def _prune_thumbs():
    """Keeps the disk cache bounded: drops the least recently written files beyond the limit."""
    d = _thumb_dir()
    files = sorted((e for e in os.scandir(d) if e.name.endswith(".webp")), key=lambda e: e.stat().st_mtime)
    for e in files[:max(0, len(files) - _THUMB_DISK_MAX)]:
        try:
            os.remove(e.path)
        except OSError:
            pass


def _sized_thumb(path, st, kind, size):
    master = _master_thumb(path, st, kind)
    if size >= _MASTER:
        return master
    with Image.open(io.BytesIO(master)) as im:
        im.thumbnail((size, size))
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=85)
        return buf.getvalue()


def _video_frame(path):
    """A frame ~10% into the video (skips black intros)."""
    import av
    with av.open(path) as c:
        s = c.streams.video[0]
        if c.duration:
            try:
                c.seek(int(c.duration * 0.1))
            except Exception:
                pass
        for frame in c.decode(s):
            return frame.to_image()
    raise ValueError("no frames")


def _to_8bit(frame):
    """16/32-bit greyscale frames scaled to 0..255 (a plain convert() clips them, so a 16-bit PNG
    would come out almost white); palette transparency kept as RGBA. Other modes pass through."""
    if frame.mode.startswith("I;16"):
        frame = frame.convert("I").point(lambda v: v * (1 / 257))
    elif frame.mode == "I":
        frame = frame.point(lambda v: v * (1 / 255))
    if frame.mode == "I":
        frame = frame.convert("L")
    if frame.mode == "P" and "transparency" in frame.info:
        frame = frame.convert("RGBA")
    return frame


_THUMB_MAX_PIXELS = 64_000_000  # e.g. 8000x8000; bigger files get the placeholder, not gigabytes of RAM


def _make_thumb(path, size, kind):
    if kind == "video":
        im = _video_frame(path)
    else:
        with Image.open(path) as src:
            if src.size[0] * src.size[1] > _THUMB_MAX_PIXELS:
                raise ValueError(f"{src.size[0]}x{src.size[1]} is too large for a thumbnail")
            src.draft("RGB", (size * 2, size * 2))  # JPEG: decode at a reduced size (no effect on other formats)
            im = _to_8bit(ImageOps.exif_transpose(src))
            im.load()
    with im:
        im.thumbnail((size, size))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA")
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=85)
        return buf.getvalue()


async def _thumb(request):
    """Thumbnail of a library asset (?id=) or of a file just picked in the dialog (?path=)."""
    if "path" in request.query:
        path = _clean_path(request.query["path"])
        if not _was_picked(path):
            return web.Response(status=403)
        kind = _kind_of(path)
    else:
        asset = await asyncio.to_thread(_find_asset, request.query.get("id"))
        if asset is None:
            return web.Response(status=404)
        path, kind = asset["path"], asset.get("kind") or _kind_of(asset["path"])
    if kind not in ("image", "video"):
        return web.Response(status=415)  # audio: the frontend draws a placeholder
    try:
        size = max(32, min(512, int(request.query.get("s", 128))))
    except ValueError:
        size = 128
    try:
        st = await asyncio.to_thread(os.stat, path)
    except OSError:
        return web.Response(status=404)
    key = (path, st.st_mtime_ns, size)
    data = _THUMBS.get(key)
    if data is None:
        try:
            data = await asyncio.to_thread(_sized_thumb, path, st, kind, size)
        except Exception:
            return web.Response(status=415)
        _THUMBS[key] = data
        while len(_THUMBS) > _THUMB_MAX:
            _THUMBS.popitem(last=False)
    else:
        _THUMBS.move_to_end(key)
    return web.Response(body=data, content_type="image/webp",
                        headers={"Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff"})


routes.get("/library_image/thumb")(_guard(_thumb))


async def _trusted_route(request):
    """For the node UI: may the loader nodes read this path? {"trusted": true/false/null} (null: not a
    full path to a media file). Local only: it describes this computer's trusted folders."""
    path = _clean_path(request.query.get("path", ""))
    if not path or not os.path.isabs(path) or _kind_of(path) is None:
        return web.json_response({"trusted": None})
    trusted = await asyncio.to_thread(_is_trusted, path)
    return web.json_response({"trusted": trusted, "message": None if trusted else _UNTRUSTED})


routes.get("/library_image/trusted")(_guard(_trusted_route, local=True))


# ---------------------------------------------------------------- nodes

def _path_inputs(kind):
    return {
        "required": {
            "path": ("STRING", {"default": "", "tooltip": f"Full path to a {kind} file anywhere on disk."}),
            "name": ("STRING", {"default": "", "tooltip": "Tag used as @name in the prompt. Empty = file name without extension."}),
        }
    }


def _fingerprint(path):
    path = _clean_path(path)
    try:
        if not os.path.isabs(path) or not _is_trusted(path) or not os.path.isfile(path):
            return path
    except LibraryUnreadable:
        return path
    st = os.stat(path)
    return hashlib.sha256(f"{path}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()


_UNTRUSTED = ("this folder hasn't been used with the Reference Library yet. For safety, Reference Image/Video/Audio nodes only "
              "read files from folders you picked a file in (Browse… or + Add) or that hold library files. "
              "Click Browse… on the node and pick the file once; after that, paths in this folder work.")


def _validate(kind, path, name):
    """True, or the reason the node can't load `path`. Checks run in an order that reveals nothing
    about the disk to whoever queued the workflow: the path's form, its type, whether its folder is
    trusted, and only then whether the file exists. Messages show the path as written, never expanded."""
    raw = _raw_path(path)
    path = _clean_path(path)
    label = f"Library {kind.capitalize()}: " + (f"@{name}: " if name else "")
    if not path:
        return f"{label}path is empty"
    if not os.path.isabs(path):
        return f"{label}{_RELATIVE}"
    if os.path.splitext(path)[1].lower() not in KIND_EXTS[kind]:
        return f"{label}not {'an' if kind[0] in 'aeiou' else 'a'} {kind} file: {raw}"
    try:
        trusted = _is_trusted(path)
    except LibraryUnreadable as e:
        return f"{label}{e}"
    if not trusted:
        return f"{label}{raw}: {_UNTRUSTED}"
    if not os.path.isfile(path):
        return f"{label}file not found: {raw}"
    return True


def _load_check(kind, path):
    """The same rules again at load time (validation can be skipped by other code paths)."""
    ok = _validate(kind, path, "")
    if ok is not True:
        raise ValueError(ok)
    return _clean_path(path)


class ReferenceImage:
    """Load an image from any absolute path on disk (not limited to ComfyUI/input)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_path": ("STRING", {
                    "default": "",
                    "tooltip": "Full path to an image file anywhere on disk.",
                }),
                "name": ("STRING", {
                    "default": "",
                    "tooltip": "Tag used as @name in the prompt. Empty = file name without extension.",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load"
    CATEGORY = "Reference Library"

    def load(self, image_path, name=""):
        path = _load_check("image", image_path)
        images, masks = [], []
        # `with`: release the file at once (an open handle locks it on Windows).
        with Image.open(path) as img:
            w = h = None
            for frame in ImageSequence.Iterator(img):
                frame = _to_8bit(ImageOps.exif_transpose(frame))
                rgb = frame.convert("RGB")
                if w is None:
                    w, h = rgb.size
                if rgb.size != (w, h):
                    continue
                images.append(torch.from_numpy(np.array(rgb).astype(np.float32) / 255.0)[None,])
                if "A" in frame.getbands():
                    a = np.array(frame.getchannel("A")).astype(np.float32) / 255.0
                    masks.append(1.0 - torch.from_numpy(a))
                else:
                    # Same size as the image, so frames with and without alpha can be stacked.
                    masks.append(torch.zeros((h, w), dtype=torch.float32))
                if img.format == "MPO":
                    break

        image = torch.cat(images, dim=0) if len(images) > 1 else images[0]
        mask = torch.stack(masks, dim=0) if len(masks) > 1 else masks[0].unsqueeze(0)
        return (image, mask)

    @classmethod
    def IS_CHANGED(cls, image_path, name=""):
        return _fingerprint(image_path)

    @classmethod
    def VALIDATE_INPUTS(cls, image_path, name=""):
        return _validate("image", image_path, name)


class ReferenceVideo:
    """Load a video from any absolute path on disk."""

    @classmethod
    def INPUT_TYPES(cls):
        return _path_inputs("video")

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "load"
    CATEGORY = "Reference Library"

    def load(self, path, name=""):
        from comfy_api.latest import InputImpl
        return (InputImpl.VideoFromFile(_load_check("video", path)),)

    @classmethod
    def IS_CHANGED(cls, path, name=""):
        return _fingerprint(path)

    @classmethod
    def VALIDATE_INPUTS(cls, path, name=""):
        return _validate("video", path, name)


class ReferenceAudio:
    """Load an audio file from any absolute path on disk."""

    @classmethod
    def INPUT_TYPES(cls):
        return _path_inputs("audio")

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "load"
    CATEGORY = "Reference Library"

    def load(self, path, name=""):
        from comfy_extras.nodes_audio import load as load_audio
        waveform, sample_rate = load_audio(_load_check("audio", path))
        return ({"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate},)

    @classmethod
    def IS_CHANGED(cls, path, name=""):
        return _fingerprint(path)

    @classmethod
    def VALIDATE_INPUTS(cls, path, name=""):
        return _validate("audio", path, name)


class ReferencePrompt:
    """Multiline prompt with @tag autocomplete over the shared asset library.

    The tagging and wiring happen in the frontend when the prompt is queued;
    by the time this runs, @tags have already been rewritten to "image N" / "Video N" etc.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "Type @ to tag a library image, video or audio file",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "Reference Library"

    def run(self, text):
        return (text,)


class ReferenceImagesBatch:
    """Stacks the Reference Prompt's images into one batch (for models with a single `images` input, like
    Nano Banana Pro). Added at queue time for the Reference Prompt's "images" output; never on the canvas.

    A batch needs one size: every image is made the size of the first. "pad" (default) fits each one
    inside and fills the rest, so nothing is cut off; "crop" fills and cuts the edges (ComfyUI's Batch
    Images behaviour); "stretch" ignores the aspect ratio."""

    MAX_IMAGES = 64
    # Internal: keeps it out of the node search (the Reference Prompt adds it when needed).
    DEPRECATED = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"mode": (["pad", "crop", "stretch"], {"default": "pad"})},
            "optional": {f"image_{i}": ("IMAGE",) for i in range(1, cls.MAX_IMAGES + 1)},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "batch"
    CATEGORY = "Reference Library"

    def batch(self, mode="pad", **images):
        import comfy.utils
        keys = sorted((k for k, v in images.items() if k.startswith("image_") and v is not None), key=lambda k: int(k[6:]))
        frames = [f[None] for k in keys for f in images[k]]  # every image of every input, in order
        if not frames:
            raise ValueError("No images to batch.")
        h, w = frames[0].shape[1:3]
        c = min(f.shape[-1] for f in frames)
        out = []
        for f in frames:
            f = f[..., :c]
            fh, fw = f.shape[1:3]
            if (fh, fw) == (h, w):
                out.append(f)
                continue
            src = f.movedim(-1, 1)
            if mode == "stretch":
                out.append(comfy.utils.common_upscale(src, w, h, "lanczos", "disabled").movedim(1, -1))
            elif mode == "crop":
                out.append(comfy.utils.common_upscale(src, w, h, "lanczos", "center").movedim(1, -1))
            else:
                scale = min(w / fw, h / fh)
                nw, nh = max(1, round(fw * scale)), max(1, round(fh * scale))
                fitted = comfy.utils.common_upscale(src, nw, nh, "lanczos", "disabled").movedim(1, -1)
                canvas = torch.zeros((1, h, w, c), dtype=f.dtype, device=f.device)
                top, left = (h - nh) // 2, (w - nw) // 2
                canvas[:, top:top + nh, left:left + nw, :] = fitted
                out.append(canvas)
        return (torch.cat(out, dim=0).clamp(0, 1),)


# Ids before the rename to Reference Library (saved workflows use them): same nodes, hidden from the
# node search (DEPRECATED), so old workflows load and run unchanged.
class LibraryImage(ReferenceImage):
    DEPRECATED = True


class LibraryVideo(ReferenceVideo):
    DEPRECATED = True


class LibraryAudio(ReferenceAudio):
    DEPRECATED = True


class TaggedPrompt(ReferencePrompt):
    DEPRECATED = True


class LibraryImageBatch(ReferenceImagesBatch):
    pass


NODE_CLASS_MAPPINGS = {
    "ReferenceImage": ReferenceImage,
    "ReferenceVideo": ReferenceVideo,
    "ReferenceAudio": ReferenceAudio,
    "ReferencePrompt": ReferencePrompt,
    "ReferenceImagesBatch": ReferenceImagesBatch,
    "LibraryImage": LibraryImage,
    "LibraryVideo": LibraryVideo,
    "LibraryAudio": LibraryAudio,
    "TaggedPrompt": TaggedPrompt,
    "LibraryImageBatch": LibraryImageBatch,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ReferenceImage": "Reference Image",
    "ReferenceVideo": "Reference Video",
    "ReferenceAudio": "Reference Audio",
    "ReferencePrompt": "Reference Prompt",
    "ReferenceImagesBatch": "Reference Images Batch (internal)",
    "LibraryImage": "Reference Image (old id)",
    "LibraryVideo": "Reference Video (old id)",
    "LibraryAudio": "Reference Audio (old id)",
    "TaggedPrompt": "Reference Prompt (old id)",
    "LibraryImageBatch": "Reference Images Batch (old id)",
}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
