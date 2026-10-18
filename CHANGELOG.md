# Changelog

> **Highly experimental.** Reference Library is provided as is, without warranty of any kind. Use it at
> your own risk: you are responsible for how you use it and for any damage or loss it may cause (to files,
> libraries, workflows, API credits or anything else). The author accepts no liability.

## 0.1.0

First release.

- **Reference Prompt**: type `@name` to tag library files; they're wired into the model's image / video /
  audio inputs when you queue, and the prompt is rewritten to "image 1", "image 2"…
- Named **libraries** of images, videos and audio that reference files in place (no copying).
- Files that aren't in a library: plug any Load Image / Video / Audio into the Reference Prompt and tag
  it by its file name, placed **First** or **Last**.
- An output per tagged file, plus an `images` batch for models with one image input (Nano Banana Pro, …).
- **Reference Image / Video / Audio** loader nodes.
- Requires ComfyUI's Nodes 2.0 (Modern Node Design).
