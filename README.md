# Library Image + Tagged Prompt for ComfyUI

Tag your reference images, videos and audio in a prompt with **`@name`**, and the **Tagged Prompt**
node wires them into model nodes with growing media inputs (**Nano Banana**, **Seedream**,
**GPT Image**, **FLUX 3**, **Seedance**, **MiniMax H3**, **Qwen Image**, … see
[Supported model nodes](#supported-model-nodes)) when you queue. Files stay where they are on disk:
no copying into ComfyUI's `input` folder.

## No image wires

**You don't connect any images to the model node.** Usually every reference image needs its own Load
Image node, wired into `image_1`, `image_2`, … of the model, and the prompt has to say "image 3" for the
right one. Here the Tagged Prompt is the **only** connection: its `text` goes to the model's `prompt`,
and that's it.

<p align="center">
  <img src="docs/images/00_no_image_wires.png" width="760" alt="A Tagged Prompt connected to Nano Banana by its text only; no image inputs are wired">
</p>

When you queue, every file you tagged is loaded and plugged into the model's image (video, audio)
inputs for you, in the order shown under the text, and `@Alex` becomes `image 1` in the prompt the
model receives. Add a tag, and one more image goes along; remove it, and it's gone. The canvas stays
the same two nodes, however many references you use.

- **Asset libraries:** named collections of your files, referenced in place, shared by all workflows.
- **`@` autocomplete** with thumbnails; tags colored by state; hover a tag for a preview.
- **Images, videos and audio**, plus [files from other nodes](#files-that-arent-in-a-library)
  (Load Image, …), placed before or after the library files.

## Contents

- [No image wires](#no-image-wires)
- [Getting started](#getting-started)
- [Tag colors](#tag-colors)
- [What happens when you queue](#what-happens-when-you-queue)
- [Supported model nodes](#supported-model-nodes)
- [Files that aren't in a library](#files-that-arent-in-a-library)
- [Outputs: every tagged file, and a batch](#outputs-every-tagged-file-and-a-batch)
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
as String Concatenate) and queue. Nothing else: the tagged files are wired into the model for you
(see [No image wires](#no-image-wires)). Works inside subgraphs too. Which models work:
[Supported model nodes](#supported-model-nodes).

### 11. Files that aren't in a library

Plug a Load Image (Video, Audio) into the node to tag its file for this run, before or after the
library files: see [Files that aren't in a library](#files-that-arent-in-a-library).

## Tag colors

| Color | Meaning | Click it to… |
|---|---|---|
| Blue | Found in an enabled library (or a plugged-in file) | — |
| Red | Unknown name, or its plugged-in file was unplugged / muted | use the library's file of that name, if any |
| Purple | The library entry's file is missing on disk | replace the file |
| Grey, struck through | Its library is switched off in this node | enable the library |

Red, purple and grey tags block the queue with a notice. **Export (API)** still works.

## What happens when you queue

For each model node with growing media inputs whose prompt contains `@tags`:

1. Files you wired into the model by hand keep their inputs.
2. Then, on the next free inputs, up to the model's limit:
   plugged-in files set to **First** → library tags, in the order they first appear in the text →
   plugged-in files set to **Last** (see [Files that aren't in a library](#files-that-arent-in-a-library)).
3. In the prompt sent to the server, `@tags` become `image N` (or `Image N`, `Video N`, `Audio N`),
   numbered by input order. The canvas keeps the `@tags`.

Queueing is refused, with a message saying why, when a tag can't be used (see [Tag colors](#tag-colors)),
when a prompt tags more files than the model takes, or when a Tagged Prompt with tags isn't connected to
any model it can fill (so raw `@tags` are never sent). A stray `@word` typed straight into a model's own
prompt is left as text, and e-mail addresses like `me@x.com` are ignored.

## Supported model nodes

Any node with **numbered media inputs that grow as you connect them** (`images.image_1`, `image_2`, …)
and a **prompt** works, partner/API and open models alike. The limits come from the node and follow
the model selected on it.

Checked by building the prompt each node receives (which file goes on which input, and how the tags
are rewritten), not by paid runs:

**Image**

| Node | Images |
|---|---|
| Nano Banana 2.1 | 14 |
| ByteDance Seedream 4.5 & 5.0 | 14 with 5.0 lite; 10 with 5.0 pro, 5.0 flash, 4.5, 4.0 |
| OpenAI GPT Image 2.5 | 16 |
| FLUX 3 Image | 10 |
| Flux.2 Image ([pro], [max]) | 8 |
| Tencent HY Image: Edit | 5 (at least 1) |
| Qwen Image 3 Edit | 3 (at least 1) |
| Grok Image Edit | 3 (1 with grok-imagine-image-pro) |
| Ideogram 4.5 Edit / Precise Edit | 5 |
| Luma UNI-1 Image / Image Edit | 9 / 8 |
| Meta Muse Image Edit | 10 |
| OpenRouter Image | 5 |

**Video**

| Node | Images | Videos | Audio |
|---|---|---|---|
| ByteDance Seedance 2.5 Reference to Video | 30 (9 with 2.0, 2.0 Fast, 2.0 Mini) | 10 (3) | 10 (3) |
| MiniMax H3 Reference to Video (H3, H3 Max) | 9 | 3 | 3 |
| Vidu Q4 Reference-to-Video | 15 | | 3 |
| HeyGen Video 1.0 Reference to Video | 9 | 3 | 3 |
| Google Gemini Omni (Video) | 14 | 3 | |

**Text (describe or compare images in a chat model)**

| Node | Images | Videos | Audio |
|---|---|---|---|
| Anthropic Claude | 20 | | |
| Google Gemini | 16 | 1 | 1 |

**Open models (local text encoders for image editing)**

| Node | Images |
|---|---|
| Text Encode Qwen Image 2.1 | 16 |
| Text Encode Ming Image Edit | 8 |
| TextEncodeBooguEdit, TextEncodeMageFlowEdit | 16 |

Reference-to-video nodes (Seedance, MiniMax H3, Vidu, HeyGen) are told `Image 1`, `Video 1`,
`Audio 1`; the others `image 1`.

**Models with one `images` batch input** (Nano Banana Pro, Nano Banana, …): connect the Tagged Prompt's
`images` output too, see [Outputs](#outputs-every-tagged-file-and-a-batch).

**Not supported:** nodes with a single image input, or one batch input, such as **LTX 2.5** (API: Image /
Audio to Video), the **LTX-2** open-model nodes, and the **MiniMax H3** open model (Reference to Video takes
`ref_images` as one batch). Wire files into those by hand (the `@name` outputs help), or try the `images`
batch output where the model accepts a batch. A Tagged Prompt with `@tags` whose text reaches only such a
node, with none of its outputs used, won't queue rather than send raw tags.

## Files that aren't in a library

Images, videos and audio from any other node (**Load Image**, **Load Video**, **Load Audio**, a
generated image, …) can be tagged too, for the current run, without adding them to a library.

**1. Plug it in.** Connect the file to the Tagged Prompt's `image_1` (or `video_1`, `audio_1`). A new
free input appears each time one is used.

**2. Tag it.** It is named after its file (`Night_Forest.png` → `@Night_Forest`; a Library Image node's
`name` works too). It is listed first in the `@` list, marked *this run*, and gets a thumbnail in the strip.

<img src="docs/images/11_plug_in_a_file.png" width="760" alt="A Load Image plugged into the Tagged Prompt and tagged by its file name">

**3. Choose its place: before or after the library files.** The button on its thumbnail switches between
**⇤ First** (the default: it takes the first inputs, before the library files) and **Last ⇥** (after
them). The numbers under the thumbnails show the result straight away.

<img src="docs/images/12_place_it_last.png" width="460" alt="Switched to Last: the plugged-in file moves after the library files">

Several plugged-in files keep their input order within each group (`image_1` before `image_2`).
The full order on the model is: files wired into the model by hand → **First** files → library tags →
**Last** files.

Good to know:

- A plugged-in file **never takes over a library asset** with the same name: existing tags become
  `@Library_01/Name`, the plain name means the plugged-in file, and a second one with that name gets
  `@Name_2`.
- Unplugged or muted, its tags turn red and the queue is refused, so the run never silently uses a
  different file. Plug it back in (or click the red tag to use a library file of that name).
- You can also wire a file **straight into the model's input**; it keeps that input, and its file name
  works as a tag.
- It also gets its own output on the Tagged Prompt, like library files: see [Outputs](#outputs-every-tagged-file-and-a-batch).

## Outputs: every tagged file, and a batch

Next to `text`, the Tagged Prompt has an output for **every tagged file**, library files and plugged-in
files alike, plus one **`images`** output with all tagged images as a batch. The number after each name is
where that file goes: **`@Coin (1)`** is `image_1` (`(2)` is `image_2`, …). The numbers follow First/Last
and match the numbers under the thumbnails and the "image 1, image 2…" in the prompt.

**For models with a single `images` input** (Nano Banana Pro, Nano Banana, and other models that take a
batch instead of growing inputs), connect two wires:

- `text` → the model's `prompt`
- `images` → the model's `images`

The prompt is rewritten in the batch's order ("image 1" is the first image of the batch), so the numbers
line up. The batch makes every image the size of image 1 by **fitting it inside and padding** (black
bars), so nothing is cut off. If you'd rather resize or crop each image yourself, use the separate
`@name` outputs instead, and batch them with your own nodes in the order of their numbers.

The `@name` outputs also work anywhere else an image (video, audio) goes: previews, upscalers,
IP-Adapter, … An output that is wired to something stays even if its tag is removed from the text.

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

Other tagging nodes that react to `@` in prompts can conflict with this one.

**Uninstall:** delete `custom_nodes/comfyui-library-image` and restart ComfyUI. The libraries in
`user/default/library_image` can be deleted too.

## Development

- `tests/`: offline server tests (run with ComfyUI's Python, no running server needed) and a browser
  regression harness for the canvas and queue binding; see [`tests/README.md`](tests/README.md).
- `tools/screenshots/`: recreates the images above, callouts included, with one command
  (`node tools/screenshots/make_screenshots.mjs`); see
  [`tools/screenshots/README.md`](tools/screenshots/README.md).

## License

MIT, see [`LICENSE`](LICENSE).
