# Changelog

> **Highly experimental.** Reference Library is provided as is, without warranty of any kind. Use it at
> your own risk: you are responsible for how you use it and for any damage or loss it may cause (to files,
> libraries, workflows, API credits or anything else). The author accepts no liability.

## 0.1.11

- **Windows:** exporting libraries now opens the Explorer-style folder picker (address bar, search, quick
  access), like the file picker for adding files, in place of the old tree-only window.

## 0.1.10

- **Queued and exported API prompts no longer hold disk paths.** Each tagged library file is sent as a
  `ReferenceLibraryImage` / `Video` / `Audio` node that names it by library, name and id; the server looks
  the file up in its own library. An **Export (API)** file can be shared without showing your folder names,
  and runs on any ComfyUI where the library was imported (ids survive export / import), headless included.
  See "Run a workflow without the interface (API)" in the README. Older API files with paths still run.
- Queueing from another machine (`--listen`) now sends library files correctly (it only ever saw file names).
- **Fixed:** a Reference Prompt feeding both a model with `image_1`, `image_2`… inputs and a model with one
  `images` input (as in the example workflow) sent its raw `@tags` to the second one. It now gets
  "image 1", "image 2"… like the first.
- **Fixed:** exporting a library failed when one of its files was dated before 1980.
- The example now includes its **Export (API)** file (`example_workflows/api/`), and the screenshot tool
  takes two new images for export and import.
- Development: `node tests/bind_example.mjs` runs the queue-time binding on the example workflow outside
  ComfyUI.

## 0.1.9

- **Share libraries: export and import.** The export button next to a library in the **Libraries** menu
  opens a list of all libraries with that one ticked; the ticked ones are saved together as one zip (a copy
  of their files and names, no disk paths) in a folder picked in the system's folder dialog. **Import
  library…** unpacks a zip into `ComfyUI/input/reference_library/<name>/`. Libraries arrive with the same
  names and ids, so a workflow from another computer finds its tags and keeps its switched-off libraries.
  Importing a newer export of a library that is already there adds only the new files.
- **Only acts where a Reference Prompt is used.** Workflows without a Reference Prompt are no longer
  touched at queue time, and queueing them no longer waits on a library check. `@tags` are bound only in
  prompts fed by a Reference Prompt (directly or through string nodes). **Changed:** an `@name` typed
  straight into a model's own prompt, or into a string node no Reference Prompt feeds, is now left as text
  even when it matches a library name; type it in a Reference Prompt instead.
- With a Reference Prompt, the library check before queueing reuses a copy from the last 2 seconds.
- **Security:** the library routes now also refuse requests from a page of another origin on the same site
  (for example another `localhost` port, which got through when ComfyUI was started with
  `--enable-cors-header`). `Origin` must match the address ComfyUI was opened at. If ComfyUI sits behind a
  reverse proxy, the proxy must pass the original `Host` header through.
- **Export (API) is refused while tags have problems** (red, purple or grey tags), like queueing: the file
  would hold raw `@tags` without their files. Saving and exporting the workflow itself is unaffected.
- **Example workflow** in `example_workflows/` (listed in ComfyUI's Templates), with a demo library to
  import and the image it plugs in.
- README: the nodes are under **Add Node → Reference Library**.
- **Minimum versions declared:** ComfyUI 0.45.0 and frontend 1.55.18 (`pyproject.toml`). When a Reference
  Prompt is used with Nodes 2.0 off, on an older frontend, or on a ComfyUI whose queueing the pack can't
  hook into, a notice that stays until closed says what to do, instead of the node quietly not working.
- Development: the backend, one 1,900-line `__init__.py`, is now the `reference_library/` package (one module
  per concern); nothing about its behavior changed.
- Development: the server tests are now pytest (`python -m pytest tests`), need no ComfyUI checkout or
  image files, run on GitHub for every push, and gate publishing.

## 0.1.8

- **Slices:** hovering a library image's tag shows a dotted-square button that opens the image large. Zoom
  and pan, mark a rectangle or square, and **Replace with slice**: the area is cut from the full-size file
  into a new PNG in ComfyUI's input folder, loaded by a new Load Image node plugged into the Reference
  Prompt's next free image input, and the prompt's tags of that image are replaced by the slice's tag.
  The library isn't changed.
- The image / video / audio filters moved from the Reference Prompt's header to the top of the `@` list.

## 0.1.7

- **Edit library:** the ✎ next to a library in the Libraries menu opens a large dialog instead of just a
  rename box. Rename the library at the top; below, a scrollable grid of its files (filterable), and a
  properties panel for the selected one: preview (video and audio play), `@name` (rename), file name and
  local path (copy), **Replace file…** (keeps its name and tags; locates a missing file) and
  **Remove from library**. **+ Add files…** adds to this library. Keyboard: arrows, Delete, F2 / Enter.
- Several assets can be selected (⌘/Ctrl-click, Shift-click, Shift+arrows, Space, ⌘/Ctrl+A) and removed
  together; rename, replace, copy path and the preview are off until one asset is selected.
- A **Thumbnail size** slider in the header sets the grid's tile size (remembered in this browser).
- Image / video / audio buttons next to the filter field show or hide each type. The selection only keeps
  assets that are shown, so Remove never takes hidden ones.

## 0.1.6

- A plugged-in file's tag follows its file: picking or pasting another image into the plugged-in Load Image
  renames its tag in the text and its `@name` output (wires kept) to the new file's name, instead of leaving
  a red tag to fix by hand. A notice says what was renamed; undo restores both.
- Tags in the prompt are colored by kind: images blue, videos cyan, audio green (problem colors unchanged).
- Hovering the `@name` output of a plugged-in file shows its preview, as library outputs already did.

## 0.1.5

- Outputs follow the tags: a wired `@name` output whose tag left the text, or whose plugged-in file was
  unplugged or changed, keeps its wire but is marked (`⚠ not in text`, `⚠ unplugged`, `⚠ file changed`…),
  and the queue is refused. Before, a library file could still be sent though the prompt no longer named it.
  Those labels are shown in red.
- A plugged-in file named like a library file gets `@Name_2`; the text is no longer rewritten
  (`@Library/Name`) and the library output keeps its name.

## 0.1.4

- Undo / redo no longer freeze the Reference Prompt: its thumbnails and header stayed in the old state, and
  their buttons acted on the replaced node.
- A plugged-in Load Image's thumbnail follows the node's own preview, so a file replaced under the same name
  shows its new content.

## 0.1.3

- Clean uninstall: the thumbnail cache moved into the pack's own folder (`.cache/thumbs`), so uninstalling
  removes it. The old cache in `user/default/library_image/thumbs` is deleted once on start. Only your
  libraries (`library.json` and its backup) stay, on purpose; the README explains how to remove them too.

## 0.1.2

- Node ids match the new name: `ReferencePrompt`, `ReferenceImage`, `ReferenceVideo`, `ReferenceAudio`, in the
  node search category **Reference Library**. Workflows saved with the old ids (`TaggedPrompt`,
  `LibraryImage`, …) still load and run; those ids are just hidden from the search.

## 0.1.1

- Registry icon and banner.

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

Known limitations:

- Local libraries only: files on the computer running ComfyUI. No web or cloud storage links, no Comfy
  Cloud, and libraries aren't shared between computers yet.
