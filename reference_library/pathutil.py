"""File kinds and path handling shared by the whole backend."""
import os

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"}
KIND_EXTS = {"image": IMAGE_EXTS, "video": VIDEO_EXTS, "audio": AUDIO_EXTS}


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
