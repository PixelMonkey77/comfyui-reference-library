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


# ---------------------------------------------------------------- library files, by identity
# What the Reference Prompt adds to a queued prompt for each tagged library file. These nodes name
# the file by its library id and names, never by a disk path: an exported API prompt carries no
# folder names, and runs on any computer whose library has the file (ids survive export / import).

def _resolve_asset(kind, asset="", library="", name=""):
    """(the library's record of the file, None), or (None, why not). Found by id; if this computer's
    library doesn't know the id (or the prompt was written by hand), by library name + file name; with
    no library named, by file name alone when exactly one library file has it. A named library is
    never swapped for another one: the run must not quietly use a different file."""
    label = "Reference Library: " + (f"@{name}" if name else "a library file") + (f" (library {library})" if library else "")
    try:
        with store._LIB_LOCK:
            pairs = store._all_assets(store._load_library(readonly=True))
    except store.LibraryUnreadable as e:
        return None, f"{label}: {e}"
    hits = [(lib, a) for lib, a in pairs if asset and a["id"] == asset]
    if not hits and name:
        hits = [(lib, a) for lib, a in pairs if store._fold(a["name"]) == store._fold(name)
                and (not library or store._fold(lib["name"]) == store._fold(library))]
        if len(hits) > 1:
            return None, (f"{label} is in more than one library here ({', '.join(lib['name'] for lib, _ in hits)}). "
                          "Name the library, or give the file's id.")
    if not hits:
        return None, (f"{label} isn't in this computer's libraries. Import the library that has it "
                      "(Libraries → Import library… in a Reference Prompt).")
    found = hits[0][1]
    found_kind = found.get("kind") or pathutil._kind_of(found["path"])
    if found_kind != kind:
        return None, f"{label} is {'an' if str(found_kind)[:1] in 'aeiou' else 'a'} {found_kind} file, not {'an' if kind[0] in 'aeiou' else 'a'} {kind}."
    if not os.path.isfile(found["path"]):
        return None, f"{label}: its file is missing on this computer. Replace it in the library (Edit library)."
    return found, None


class _FromLibrary:
    """Makes a loader node take a library file by identity instead of a path (see above)."""

    KIND = None
    # Internal: keeps it out of the node search (the Reference Prompt adds it when needed).
    DEPRECATED = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"name": ("STRING", {"default": "", "tooltip": "The file's @name in its library."})},
            "optional": {
                "asset": ("STRING", {"default": "", "tooltip": "The file's id in the library (kept when a library is exported and imported). "
                                                                 "Empty or unknown here: the file is found by library and name."}),
                "library": ("STRING", {"default": "", "tooltip": "The library's name. Empty: any library, if only one has a file of this name."}),
            },
        }

    def load(self, name="", asset="", library=""):
        found, why = _resolve_asset(self.KIND, asset, library, name)
        if found is None:
            raise ValueError(why)
        return super().load(found["path"], found["name"])

    @classmethod
    def IS_CHANGED(cls, name="", asset="", library=""):
        found, _ = _resolve_asset(cls.KIND, asset, library, name)
        return _fingerprint(found["path"]) if found else f"{asset}|{library}|{name}"

    @classmethod
    def VALIDATE_INPUTS(cls, name="", asset="", library=""):
        found, why = _resolve_asset(cls.KIND, asset, library, name)
        return True if found else why


class ReferenceLibraryImage(_FromLibrary, ReferenceImage):
    """A library image, by id / library / name. Added at queue time for a tagged library file."""
    KIND = "image"


class ReferenceLibraryVideo(_FromLibrary, ReferenceVideo):
    """A library video, by id / library / name."""
    KIND = "video"


class ReferenceLibraryAudio(_FromLibrary, ReferenceAudio):
    """A library audio file, by id / library / name."""
    KIND = "audio"


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
