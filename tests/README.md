# Tests for comfyui-library-image

Development only: ComfyUI never loads this folder (it imports `__init__.py` and serves `web/`).

## Server tests (offline, no running ComfyUI needed)
Run with ComfyUI's venv Python; args: <pack dir> <ComfyUI code dir> <scratch dir (deleted)> <input dir with Buttons.png, Giftwood.png, CAPIBARA.jpg, Biscuit.png>

    "C:/Users/chabu/Documents/ComfyUI/.venv/Scripts/python.exe" -I test_harden.py \
      "D:/ComfyUI_Node_experiments/Image_tagging/comfyui-library-image" \
      "C:/Users/chabu/AppData/Local/Programs/@comfyorgcomfyui-electron/resources/ComfyUI" \
      "<some temp dir>" "C:/Users/chabu/Documents/ComfyUI/input"

Files: test_safety.py (Phase 1), test_phase2b.py, test_perf.py (cache/locking), test_harden.py (local-only, thumbnails),
test_leftovers.py (paths, names, cross-process lock, thumbnail de-dup, dialog errors),
test_security.py (request trust, trusted folders, no validation leaks, /file hardening).

## Frontend regression harness (harness.js)
13 scenarios: strip/ink on the canvas + the API prompt binding (incl. claims Test 01/02, string chains,
subgraph boundary, muted files). Needs a running ComfyUI, the library assets above, and the Nano Banana 2.1 node.
To run: copy harness.js to custom_nodes/comfyui-library-image/web/_harness.txt (a .js there would load as an
extension), then in the browser console:

    const src = await (await fetch("/extensions/comfyui-library-image/_harness.txt")).text();
    await new (Object.getPrototypeOf(async function(){}).constructor)(src.replace(/JSON\.stringify\(results, null, 1\)\s*$/, "return results;"))();

Results land in window.__harness (takes ~70 s). Delete _harness.txt afterwards. It never queues anything.
