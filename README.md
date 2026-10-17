# Library Image + Tagged Prompt (ComfyUI)

Tag reference images, videos and audio in a prompt with `@name` and have them wired into API nodes
with auto-growing media ports (e.g. **Nano Banana 2.1** `model.images.image_1…14`, **Seedance**
`model.reference_images/videos/audios.*`), without Load nodes and without copying files into
ComfyUI's `input` folder.

## Nodes

**Tagged Prompt** (`image/library`): a multiline prompt with a built-in asset library.
- Type `@` and a thumbnail list pops up at the cursor and filters as you type (`@Library_02/Bis`
  limits it to one library). `↑↓` select, `Enter`/`Tab` insert, `Esc` close; `✎` edit, `×` remove.
- Tags are colored: blue ok, red unknown or unplugged, purple file missing, grey struck-through
  library switched off in this node. Hover a tag for a preview card; click a grey/purple/red one
  for a fix (enable the library, replace the file, use the library's file).
- Header: **Libraries (n)** (switch libraries on/off per node, rename, delete, + New library),
  image/video/audio filters for the list, and **+ Add**.
- A strip under the text shows every tagged file and the `image N` it will become; hover a chip
  to highlight its tags, click it to cycle through them.
- `@name` outputs: one output per tagged library file, to wire it anywhere by hand.
- `image_N` / `video_N` / `audio_N` inputs take files that aren't in the library (Load Image etc.)
  for this run; tag them by file name and set each to come **First** or **Last** on its chip.
- Connect its `text` output to the model's `prompt` (directly or through string nodes such as
  String Concatenate). Works inside subgraphs.

**Library Image / Video / Audio**: load one file by full path, with **Browse…**. Optional, for
wiring files by hand; their `name` works as an `@tag` too (so does a Load Image's file name).
For safety they only read files from folders you've already used: folders you picked a file in
(Browse… or + Add), folders that hold library files, and ComfyUI's input/output folders. A path
typed into a new folder shows a yellow note on the node: click **Browse…** and pick the file once,
and from then on paths in that folder work. (Otherwise a shared workflow, a web page or another
machine could make these nodes read, and send to an API, any picture on your disk.)

## What happens when you queue

For each node with auto-grow media ports whose prompt contains `@tags`:
1. Files you wired by hand keep their ports.
2. Plugged-in files set to First, then library tags (in the order they first appear), then
   plugged-in files set to Last take the next free ports (up to the node's limit).
3. `@tags` in the prompt sent to the server become `image N` / `Image N` / `Video N`, numbered by
   port order; the canvas keeps the `@tags`.

Unknown, unplugged, missing or switched-off tags block the queue with a notice (Export (API) still
works). A stray `@word` typed straight into a model's own prompt is left as text.
E-mail addresses like `me@x.com` are ignored.

## The library

- Stored in `ComfyUI/user/default/library_image/library.json` (with a `.bak` of the previous
  version; a damaged file is set aside and the backup restored). Files are referenced in place.
- Several named libraries. A plain `@Biscuit` means the first enabled library that has it;
  `@Library_02/Biscuit` names the library. Names are unique within a library.
- Renaming, replacing or removing an asset, or deleting or switching a library, keeps every tag
  in the open workflow on its file (renames follow; a removed file's tag turns red).
- A plugged-in file with the same name as a library asset never takes over its tags: existing
  tags become `@Library_01/Biscuit`, and the plain name means the plugged-in file (`@Biscuit_2`
  for a second one). Unplugged, its tags turn red.
- Tag names use letters, digits, `_` and `-`; other characters become `_`. Tags are
  case-insensitive.
- The file dialogs are opened by the ComfyUI server, so picking files and changing the library only
  work on the PC running ComfyUI, opened as `http://127.0.0.1:…` or `http://localhost:…`. Other
  machines (`--listen`) can browse the library and see file names, not folders. Requests from other
  websites, or under other host names (DNS rebinding, proxies), are refused. Drag and drop isn't
  supported. Thumbnails are cached in `user/default/library_image/thumbs`.

## Install

ComfyUI loads custom nodes from `ComfyUI/custom_nodes/`. Pick one:

**A. Link (recommended while developing; edits here apply after a restart)**

Run in a Command Prompt (cmd.exe), replacing the ComfyUI path with yours:

```
mklink /J "C:\path\to\ComfyUI\custom_nodes\comfyui-library-image" "D:\ComfyUI_Node_experiments\Image_tagging\comfyui-library-image"
```

For ComfyUI Desktop, `custom_nodes` is inside the base folder you chose at setup (e.g. `Documents\ComfyUI\custom_nodes`). For the portable build it is `ComfyUI_windows_portable\ComfyUI\custom_nodes`.

**B. Copy**

Copy the whole `comfyui-library-image` folder into `ComfyUI/custom_nodes/`.

Then:

1. Restart ComfyUI (no extra Python packages needed; it uses torch, numpy and Pillow, which ComfyUI already has).
2. Hard-reload the browser tab (Ctrl+Shift+R) so the frontend scripts load.
3. Check: **Add Node → image → library** lists **Tagged Prompt** and **Library Image**.

Don't run this alongside ComfyUI-Universal-Image-Mentions: its `@` popup and queue hook also
act on `@tags`.

## Uninstall

Delete `custom_nodes/comfyui-library-image` (for a junction, deleting the link leaves this source folder intact) and restart ComfyUI. The library file in `user/default/library_image` can be deleted too.

## Development

`tests/` holds offline server tests (run with ComfyUI's Python, no running server needed) and a
browser regression harness for the canvas and queue binding; see `tests/README.md`.

## License

MIT, see `LICENSE`.
