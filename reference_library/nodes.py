"""The ComfyUI nodes: Reference Image / Video / Audio loaders, Reference Prompt and the images batch."""
import hashlib
import os

import numpy as np
from PIL import Image, ImageOps, ImageSequence
import torch

from . import pathutil, store, thumbs

# ---------------------------------------------------------------- nodes

def _path_inputs(kind):
    return {
        "required": {
            "path": ("STRING", {"default": "", "tooltip": f"Full path to a {kind} file anywhere on disk."}),
            "name": ("STRING", {"default": "", "tooltip": "Tag used as @name in the prompt. Empty = file name without extension."}),
        }
    }


def _fingerprint(path):
    path = pathutil._clean_path(path)
    try:
        if not os.path.isabs(path) or not store._is_trusted(path) or not os.path.isfile(path):
            return path
    except store.LibraryUnreadable:
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
    raw = pathutil._raw_path(path)
    path = pathutil._clean_path(path)
    label = f"Library {kind.capitalize()}: " + (f"@{name}: " if name else "")
    if not path:
        return f"{label}path is empty"
    if not os.path.isabs(path):
        return f"{label}{pathutil._RELATIVE}"
    if os.path.splitext(path)[1].lower() not in pathutil.KIND_EXTS[kind]:
        return f"{label}not {'an' if kind[0] in 'aeiou' else 'a'} {kind} file: {raw}"
    try:
        trusted = store._is_trusted(path)
    except store.LibraryUnreadable as e:
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
    return pathutil._clean_path(path)


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
                frame = thumbs._to_8bit(ImageOps.exif_transpose(frame))
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
