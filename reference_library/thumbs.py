"""Thumbnails: made once per file, cached on disk and in memory."""
import asyncio
from collections import OrderedDict
import hashlib
import io
import logging
import os
import shutil
import threading
import uuid

from aiohttp import web
import folder_paths
from PIL import Image, ImageOps

from . import dialogs, pathutil, store

_THUMBS = OrderedDict()
_THUMB_MAX = 400
_MASTER = 512  # one master thumbnail per file is kept on disk; smaller sizes are made from it
_THUMB_DISK_MAX = 3000


# Caches live inside the pack's own folder, so uninstalling the pack (which just deletes that folder)
# leaves nothing behind. Only the libraries themselves (library.json) are kept in the user folder.
_CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".cache")  # the pack's folder, one up


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
        path = pathutil._clean_path(request.query["path"])
        if not dialogs._was_picked(path):
            return web.Response(status=403)
        kind = pathutil._kind_of(path)
    else:
        asset = await asyncio.to_thread(store._find_asset, request.query.get("id"))
        if asset is None:
            return web.Response(status=404)
        path, kind = asset["path"], asset.get("kind") or pathutil._kind_of(asset["path"])
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
