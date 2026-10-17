# Library Image + Tagged Prompt for ComfyUI

Tag your reference images, videos and audio in a prompt with **`@name`**, and the **Tagged Prompt**
node wires them into API nodes with auto-growing media ports (**Nano Banana**, **Seedream**,
**GPT Image**, **FLUX 3**, **Seedance**, … see [Supported model nodes](#supported-model-nodes))
when you queue. Files stay where they are on disk: no Load nodes, no copying into ComfyUI's `input`
folder.

<p align="center">
  <img src="docs/images/08_prompt_with_tags.png" width="640" alt="A Tagged Prompt with tags and thumbnails">
</p>

- **Asset libraries:** named collections of your files, referenced in place, shared by all workflows.
- **`@` autocomplete** with thumbnails; tags colored by state; hover a tag for a preview.
- **Queue-time wiring:** `@Alex` becomes `image 1` in the prompt sent to the model, and the file goes
  to the matching input port.
- **Images, videos and audio**, plus files plugged in from other nodes (Load Image, …).

## Contents

- [Getting started](#getting-started)
- [Tag colors](#tag-colors)
- [What happens when you queue](#what-happens-when-you-queue)
- [Supported model nodes](#supported-model-nodes)
- [Files that aren't in a library](#files-that-arent-in-a-library)
- [Libraries in detail](#libraries-in-detail)
- [Library Image / Video / Audio nodes](#library-image--video--audio-nodes)
- [Safety](#safety)
- [Install](#install)
- [Development](#development)

## Getting started

### 1. The Tagged Prompt node

Add it from **Add Node → image → library → Tagged Prompt**. The header holds your libraries, the
filters for the `@` list, and the button to add files.

<img src="docs/images/01_tagged_prompt_node.png" width="720" alt="The Tagged Prompt node">

### 2. Create your first library

Open **Libraries** and click **+ New library**.

<img src="docs/images/02_create_first_library.png" width="560" alt="Create your first library">

### 3. Name it, then pick files

Give the library a name. It is created as soon as the first file is added.

<img src="docs/images/03_name_your_first_library.png" width="720" alt="Name your first library">

### 4. Add several files at once

Select several files in the file dialog: they are all added, each named after its file. Type `@`
in the prompt to see them.

<img src="docs/images/04_add_several_files.png" width="720" alt="Several files added at once">

### 5. Add a single file

With **+ Add**, pick one file: you see its preview and can choose its `@name` before adding it.

<img src="docs/images/05_add_one_file.png" width="720" alt="Add a single file and name it">

### 6. Change a display name

In the `@` list, hover a file and click **✎**. Rename it (tags already in your prompts follow), or
**Replace file…** to point it at another file of the same type.

<img src="docs/images/06_change_display_name.png" width="720" alt="Rename an asset">

### 7. Mention an asset

Type `@` and a few letters, then **Enter** or **Tab** to insert. `↑` `↓` select, **Esc** closes.

<img src="docs/images/07_mention_an_asset.png" width="720" alt="Type @ to mention an asset">

Tagged files appear under the text, in the order they will be sent (`image 1`, `image 2`, …):

<img src="docs/images/08_prompt_with_tags.png" width="720" alt="The prompt with tags and the strip">

### 8. Hover a tag

Hover a tag in the text for a large preview, where it goes, and where the file is.

<img src="docs/images/09_hover_a_tag.png" width="720" alt="Hover a tag for a preview">

### 9. Find a tag from its thumbnail

Hover a thumbnail to highlight its tags; click it to jump to the tag (click again for the next one).

<img src="docs/images/10_click_a_thumbnail_to_find_its_tag.png" width="560" alt="Click a thumbnail to find its tag">

### 10. Connect it to a model

Connect the node's **text** output to the model's `prompt` (directly, or through string nodes such
as String Concatenate) and queue. Works inside subgraphs too.

## Tag colors

| Color | Meaning | Click it to… |
|---|---|---|
| Blue | Found in an enabled library (or a plugged-in file) | — |
| Red | Unknown name, or its plugged-in file was unplugged / muted | use the library's file of that name, if any |
| Purple | The library entry's file is missing on disk | replace the file |
| Grey, struck through | Its library is switched off in this node | enable the library |

Red, purple and grey tags block the queue with a notice. **Export (API)** still works.

## What happens when you queue

For each node with auto-grow media ports whose prompt contains `@tags`:

1. Files you wired into the model by hand keep their ports.
2. Plugged-in files set to **First**, then library tags (in the order they first appear), then
   plugged-in files set to **Last** take the next free ports, up to the model's limit.
3. In the prompt sent to the server, `@tags` become `image N`, `Image N`, `Video N` or `Audio N`,
   numbered by port order. The canvas keeps the `@tags`.

A stray `@word` typed straight into a model's own prompt is left as text, and e-mail addresses like
`me@x.com` are ignored.

## Supported model nodes

Any partner/API node whose media inputs grow as you connect them (`images.image_1`, `image_2`, …)
works. The limits come from the node itself and follow the model selected on it: when a prompt tags
more files than the model takes, the node shows it and queueing is refused with a clear message,
before anything is sent.

| Node | Model | Images | Videos | Audio |
|---|---|---|---|---|
| Nano Banana 2.1 | all models | 14 | | |
| ByteDance Seedream 4.5 & 5.0 | 5.0 lite | 14 | | |
| | 5.0 pro, 5.0 flash, 4.5, 4.0 | 10 | | |
| OpenAI GPT Image 2.5 | all models | 16 | | |
| FLUX 3 Image | | 10 | | |
| Tencent HY Image: Edit | HY Image 3.5 | 5 (at least 1) | | |
| Qwen Image 3 Edit | 3.0 pro, 3.0 | 3 (at least 1) | | |
| ByteDance Seedance 2.5 Reference to Video | 2.5, 2.5 Draft | 30 | 10 | 10 |
| | 2.0, 2.0 Fast, 2.0 Mini | 9 | 3 | 3 |

Tested by building the prompt each node receives (which file goes on which input, and how the tags
are rewritten), not by paid runs. Seedance says `Image 1` / `Video 1` / `Audio 1`, the others `image 1`.

## Files that aren't in a library

- **`image_N` / `video_N` / `audio_N` inputs** take files from other nodes (Load Image, …) for this
  run. Tag them by file name; a new input appears whenever one is used. On its thumbnail, set each
  to come **First** or **Last** on the model.
- A plugged-in file **never takes over a library asset** with the same name: existing tags become
  `@Library_01/Name`, the plain name means the plugged-in file, and a second one with that name gets
  `@Name_2`. Unplugged, its tags turn red.
- **`@name` outputs:** one output per tagged library file, to wire it anywhere by hand.

## Libraries in detail

- **Several libraries.** A plain `@Biscuit` means the first enabled library that has it;
  `@Library_02/Biscuit` names the library (typing `@Library_02/` in the list shows only that library).
- **Per node:** switch libraries on or off in each node's **Libraries** menu, which also renames and
  deletes libraries.
- **Tags follow changes.** Renaming, replacing or removing an asset, or deleting or switching a
  library, keeps every tag in the open workflow on its file (renames follow; a removed file's tag
  turns red).
- **Names** use letters, digits, `_` and `-` (other characters become `_`), are unique within a
  library, and are case-insensitive.
- **Storage:** `ComfyUI/user/default/library_image/library.json`, with a `.bak` of the previous
  version (a damaged file is set aside and the backup restored). Thumbnails are cached next to it in
  `thumbs/`.

## Library Image / Video / Audio nodes

Load one file by full path, with **Browse…**. Optional, for wiring files by hand; their `name` works as
an `@tag` too (so does a Load Image's file name).

For safety they only read files from **folders you've already used**: folders you picked a file in
(Browse… or + Add), folders that hold library files, and ComfyUI's input/output folders. A path typed
into a new folder shows a yellow note on the node: click **Browse…** and pick the file once, and from
then on paths in that folder work.

## Safety

- Picking files and changing libraries work only on the PC running ComfyUI, opened as
  `http://127.0.0.1:…` or `http://localhost:…`.
- Other machines (ComfyUI started with `--listen`) can browse the libraries and see file names, but not
  your folders.
- Requests from other websites, or under other host names (DNS rebinding, proxies), are refused.
- Without the trusted-folder rule above, a shared workflow, a web page or another machine could make
  the loader nodes read, and send to an API, any picture on your disk.

## Install

ComfyUI loads custom nodes from `ComfyUI/custom_nodes/`. For ComfyUI Desktop that folder is inside the
base folder you chose at setup (e.g. `Documents\ComfyUI\custom_nodes`); for the portable build it is
`ComfyUI_windows_portable\ComfyUI\custom_nodes`.

**ComfyUI Manager:** **Install via Git URL** → `https://github.com/PixelMonkey77/comfyui-library-image`

**Git:**

```
cd ComfyUI/custom_nodes
git clone https://github.com/PixelMonkey77/comfyui-library-image
```

**For development**, link the folder instead (Command Prompt), so edits apply after a restart:

```
mklink /J "C:\path\to\ComfyUI\custom_nodes\comfyui-library-image" "D:\path\to\comfyui-library-image"
```

Then restart ComfyUI and reload the browser tab. No extra Python packages are needed (it uses torch,
numpy, Pillow and PyAV, which ComfyUI already has). Check that **Add Node → image → library** lists
**Tagged Prompt** and **Library Image**.

Don't run it alongside ComfyUI-Universal-Image-Mentions: its `@` popup and queue hook also act on
`@tags`.

**Uninstall:** delete `custom_nodes/comfyui-library-image` (for a link, that removes only the link) and
restart ComfyUI. The libraries in `user/default/library_image` can be deleted too.

## Development

- `tests/`: offline server tests (run with ComfyUI's Python, no running server needed) and a browser
  regression harness for the canvas and queue binding; see [`tests/README.md`](tests/README.md).
- `tools/screenshots/`: recreates the images above, callouts included, with one command
  (`node tools/screenshots/make_screenshots.mjs`); see
  [`tools/screenshots/README.md`](tools/screenshots/README.md).

## License

MIT, see [`LICENSE`](LICENSE).
