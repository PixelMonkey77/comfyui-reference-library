"""Slices: a rectangle cut out of a library image, saved as a new PNG in ComfyUI's input folder."""
import asyncio
import contextlib
import logging
import os

from aiohttp import web
import folder_paths
from PIL import Image, ImageOps

from . import guard, pathutil, store, thumbs

# ---------------------------------------------------------------- slices
# A slice is a rectangle cut out of a library image, saved as a new PNG in ComfyUI's input folder and
# loaded by a plain Load Image node: it is never added to a library, and the library file is never
# changed. The rectangle comes in image fractions (0..1) of the picture as shown, which is the file
# with its EXIF orientation applied (browsers show it that way, and so do the thumbnails).

_SLICE_MAX_PIXELS = 300_000_000  # the source image; bigger files are refused rather than eat the RAM


def _slice_rect(raw):
    """(x, y, w, h) as floats within 0..1, or LibError."""
    try:
        x, y, w, h = (float(raw[k]) for k in ("x", "y", "w", "h"))
    except Exception:
        raise store.LibError("No area selected.", 400, "rect")
    if not all(v == v and abs(v) != float("inf") for v in (x, y, w, h)):
        raise store.LibError("No area selected.", 400, "rect")
    x, y = min(max(x, 0.0), 1.0), min(max(y, 0.0), 1.0)
    w, h = min(max(w, 0.0), 1.0 - x), min(max(h, 0.0), 1.0 - y)
    return x, y, w, h


def _slice_file_name(folder, base):
    """A free "<base>_slice_01.png" in `folder`, created empty right away so two slices never share it."""
    for n in range(1, 10000):
        name = f"{base}_slice_{n:02d}.png"
        try:
            with open(os.path.join(folder, name), "xb"):
                return name
        except FileExistsError:
            continue
    raise store.LibError("Too many slices of this image in the input folder.", 409)


def _make_slice(body):
    asset = store._find_asset(body.get("id"))
    if asset is None:
        raise store.LibError("That asset is no longer in the library.", 404)
    path = asset["path"]
    if (asset.get("kind") or pathutil._kind_of(path)) != "image" or pathutil._kind_of(path) != "image":
        raise store.LibError("Only images can be sliced.", 400)
    if not os.path.isfile(path):
        raise store.LibError(f"File not found: {path}", 404, "file")
    x, y, w, h = _slice_rect(body.get("rect") or {})
    with Image.open(path) as src:
        if src.size[0] * src.size[1] > _SLICE_MAX_PIXELS:
            raise store.LibError("This image is too large to slice here.", 400)
        im = thumbs._to_8bit(ImageOps.exif_transpose(src))
        W, H = im.size
        box = (round(x * W), round(y * H), round((x + w) * W), round((y + h) * H))
        box = (min(box[0], W - 1), min(box[1], H - 1), min(max(box[2], box[0] + 1), W), min(max(box[3], box[1] + 1), H))
        if box[2] - box[0] < 2 or box[3] - box[1] < 2:
            raise store.LibError("Select an area at least 2 pixels wide and high.", 400, "rect")
        part = im.crop(box)
        if part.mode not in ("RGB", "RGBA", "L", "LA"):
            has_alpha = part.mode in ("PA", "RGBa", "La") or "transparency" in part.info
            part = part.convert("RGBA" if has_alpha else "RGB")
        # Load Image lists the input folder's top level only, so the slice goes there.
        folder = folder_paths.get_input_directory()
        os.makedirs(folder, exist_ok=True)
        name = _slice_file_name(folder, store._tag_name(body.get("name") or asset["name"]))
        target = os.path.join(folder, name)
        try:
            part.save(target, format="PNG")
        except Exception:
            with contextlib.suppress(OSError):
                os.remove(target)
            raise
    return {"file": name, "name": os.path.splitext(name)[0], "width": part.size[0], "height": part.size[1],
            "box": list(box), "source": [W, H]}


async def _slice(request):
    body = await guard._json_body(request)
    try:
        return web.json_response(await asyncio.to_thread(_make_slice, body))
    except store.LibError as e:
        return web.json_response({"error": str(e), "field": e.field}, status=e.status)
    except Exception as e:
        logging.exception("[library_image] slice failed")
        return web.json_response({"error": f"Slice failed: {e}"}, status=500)
