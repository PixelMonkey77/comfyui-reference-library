# Walkthrough screenshots

`make_screenshots.mjs` recreates the README walkthrough images, callouts included, so they can be
redone after every UI change with one command:

```
node tools/screenshots/make_screenshots.mjs
```

It writes `00_…png` to `19_…png` into `docs/images/` (the images the main README shows) using the demo images in
`../Resources` (next to the repo). They are found by file name, flat or in subfolders; which file plays which
part is set in `DEMO` at the top of the script:

| Part | Files |
|---|---|
| First library (picked several at once) | `frog_warrior`, `rooster_cowboy`, `zombie_chef` |
| One file, named in the dialog (`@Temple`) | `temple_ruin` |
| Two more libraries | `Environments`: `forest`, `temple_02`; `Items`: `golden_coin`, `red_gem` |
| A file outside the library (Load Image) | `forest_02`, copied as `Night_Forest.png` |

Options:

| Option | Default | |
|---|---|---|
| `--out DIR` | `<repo>/docs/images` | where the PNGs go (existing files with the same names are replaced) |
| `--resources DIR` | `<repo>/../Resources` | the demo images (see above) |
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

Node 22 or newer, Chrome (or Edge, or Chromium), and ComfyUI Desktop on Windows. Other setups (macOS, Linux, a
git checkout of ComfyUI): set `COMFYUI_DIR` (folder with `main.py`), `COMFYUI_PYTHON`, `COMFYUI_FRONTEND`
(frontend folder; Desktop: `web_custom_versions/desktop_app`, a pip install:
`site-packages/comfyui_frontend_package/static`) and `CHROME`. Callouts use Segoe UI Black, or Inter Display
where that isn't installed.

## Changing the walkthrough

Each step in `walkthrough()` clicks, types, then calls
`shot(name, [elements to frame], [callouts])`. A callout is
`{ target, text, side: "right" | "left" | "top" | "bottom", from, dx, dy, bend }`: the label goes beyond the
`from` element's edge (default: the target) and an arrow points at the target. Targets are
`{ sel, text?, index? }`, where `{node}` in a selector stands for the Reference Prompt node; `bend`
(pixels, negative = the other way) curves the arrow around content.

`make_registry_art.py` draws the Comfy Registry banner and icon (`docs/images/registry_*.png`, linked from
`pyproject.toml`) from the same demo files: `python tools/screenshots/make_registry_art.py` (needs Pillow).
