# Walkthrough screenshots

`make_screenshots.mjs` recreates the README walkthrough images, callouts included, so they can be
redone after every UI change with one command:

```
node tools/screenshots/make_screenshots.mjs
```

It writes `01_…png` to `12_…png` into `docs/images/` (the images the main README shows) using the demo files in
`../Resources/{Characters,Environments,Icons}`. Options:

| Option | Default | |
|---|---|---|
| `--out DIR` | `<repo>/docs/images` | where the PNGs go (existing files with the same names are replaced) |
| `--resources DIR` | `<repo>/../Resources` | demo files: `Characters/` (first library, several at once), `Environments/` (`Ancient_Temple` is added on its own), `Icons/` |
| `--port N` | `8190` | port of the temporary ComfyUI (Chrome's debug port is N+1000) |
| `--keep` | | keep the temp folder (ComfyUI log, settings) for debugging |
| `--show` | | run Chrome with a visible window |

## What it does

1. Starts a **separate, temporary ComfyUI** with your Desktop install's Python and frontend, in a fresh
   temp folder (empty library, own settings: Nodes 2.0, dark theme, no first-run popups), loading only
   this pack, copied from the repo. Your real ComfyUI, libraries and workflows are never touched.
2. Answers the native file dialog with the demo files (`LIBRARY_IMAGE_FAKE_DIALOG`, which only the
   script sets), since a Windows dialog can't be driven by automation.
3. Drives headless Chrome over the DevTools protocol (no packages needed: Node 22+ has WebSocket),
   draws the orange callouts into the page, captures each step at 2x, cleans up.

## Requirements and paths

Node 22 or newer, Chrome (or Edge), and ComfyUI Desktop on Windows. Other setups: set
`COMFYUI_DIR` (folder with `main.py`), `COMFYUI_PYTHON`, `COMFYUI_FRONTEND` (frontend folder, Desktop:
`web_custom_versions/desktop_app`) and `CHROME`.

## Changing the walkthrough

Each step in `walkthrough()` clicks, types, then calls
`shot(name, [elements to frame], [callouts])`. A callout is
`{ target, text, side: "right" | "left" | "top" | "bottom", from, dx, dy, bend }`: the label goes beyond the
`from` element's edge (default: the target) and an arrow points at the target. Targets are
`{ sel, text?, index? }`, where `{node}` in a selector stands for the Tagged Prompt node; `bend`
(pixels, negative = the other way) curves the arrow around content.
