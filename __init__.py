"""Reference Library for ComfyUI: named libraries of reference images, videos and audio, tagged as
@name in a Reference Prompt.

ComfyUI imports this file. The backend is the reference_library package next to it:
  pathutil  file kinds, path handling
  guard     which requests the routes answer (this computer / another machine / refused)
  store     library.json: load, repair, cache, save, locks, names, trusted folders
  dialogs   native file and folder dialogs
  library   add / rename / replace / remove, listing and serving files
  transfer  export and import (zip)
  slices    cutting a rectangle out of a library image
  thumbs    thumbnails and their cache
  nodes     the ComfyUI nodes
  routes    every HTTP route, registered when it is imported
The interface is in web/.
"""
from .reference_library import nodes
from .reference_library import routes  # noqa: F401  (importing it registers the HTTP routes)

NODE_CLASS_MAPPINGS = {
    "ReferenceImage": nodes.ReferenceImage,
    "ReferenceVideo": nodes.ReferenceVideo,
    "ReferenceAudio": nodes.ReferenceAudio,
    "ReferencePrompt": nodes.ReferencePrompt,
    "ReferenceImagesBatch": nodes.ReferenceImagesBatch,
    "LibraryImage": nodes.LibraryImage,
    "LibraryVideo": nodes.LibraryVideo,
    "LibraryAudio": nodes.LibraryAudio,
    "TaggedPrompt": nodes.TaggedPrompt,
    "LibraryImageBatch": nodes.LibraryImageBatch,
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
