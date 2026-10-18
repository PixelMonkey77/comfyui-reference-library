# Tests for comfyui-reference-library

Development only: ComfyUI never loads this folder (it imports `__init__.py` and serves `web/`).

## Server tests (offline, no running ComfyUI needed)
Run with ComfyUI's venv Python; args: <pack dir> <ComfyUI code dir> <scratch dir (deleted)> <input dir with Buttons.png, Giftwood.png, CAPIBARA.jpg, Biscuit.png>

    "<ComfyUI base folder>/.venv/Scripts/python.exe" -I test_harden.py \
      "<this repo>" \
      "<ComfyUI code folder>" \
      "<some temp dir>" "<ComfyUI base folder>/input"

For ComfyUI Desktop on Windows the base folder is the one chosen at setup (e.g. `Documents/ComfyUI`) and the
code folder is `%LOCALAPPDATA%/Programs/@comfyorgcomfyui-electron/resources/ComfyUI`.

Files: test_safety.py (Phase 1), test_phase2b.py, test_perf.py (cache/locking), test_harden.py (local-only, thumbnails),
test_leftovers.py (paths, names, cross-process lock, thumbnail de-dup, dialog errors),
test_security.py (request trust, trusted folders, no validation leaks, /file hardening).

## Frontend regression harness (harness.js)
13 scenarios (incl. a workflow with the ids from before the rename): strip/ink on the canvas + the API prompt binding (incl. claims Test 01/02, string chains,
subgraph boundary, muted files). Needs a running ComfyUI, the library assets above, and the Nano Banana 2.1 node.
To run: copy harness.js to custom_nodes/comfyui-reference-library/web/_harness.txt (a .js there would load as an
extension), then in the browser console:

    const src = await (await fetch("/extensions/comfyui-reference-library/_harness.txt")).text();
    await new (Object.getPrototypeOf(async function(){}).constructor)(src.replace(/JSON\.stringify\(results, null, 1\)\s*$/, "return results;"))();

Set `window.__harnessInput` to your ComfyUI input folder (ending in `/`) before running it.
Results land in window.__harness (takes ~70 s). Delete _harness.txt afterwards. It never queues anything.
