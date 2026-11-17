# Tests for comfyui-reference-library

Development only: ComfyUI never loads this folder (it imports `__init__.py`, which loads the
`reference_library/` package, and serves `web/`).

## Server tests (pytest; no ComfyUI, no running server, no image files needed)

From the repo root:

    python -m pip install -r tests/requirements.txt
    python -m pytest tests

Any Python 3.10+ works. ComfyUI's own Python has everything but pytest, and also torch, so nothing is
skipped there, e.g. on Windows: `"<ComfyUI base folder>/.venv/Scripts/python.exe" -m pytest tests`.

- The pack is loaded with stand-ins for ComfyUI's `server` and `folder_paths` modules (`helpers.py`),
  the way ComfyUI loads it: from `__init__.py`, as a package. A test gets the backend package and reaches
  a function through the module that owns it (`pack.store._load_library`, `pack.transfer._export_libraries`).
- The four images the scenarios use are generated into a temp folder (`conftest.py`); every test file
  gets its own scratch folder as ComfyUI's user folder. Nothing touches your real library.
- Each file is one scenario whose tests run in order and build on each other: run whole files
  (`python -m pytest tests/test_security.py`), not single tests.
- Always pass `tests` (or a file in it): the repo root is itself a Python package, and `tests/pytest.ini`
  keeps pytest from importing it.
- Skipped: one Windows path check off Windows, one loader check without torch.

Files: test_safety.py (backups, damaged-file recovery), test_phase2b.py (repairs, per-item errors, 16-bit
images, one dialog at a time), test_perf.py (cache, locking, 1000 assets), test_harden.py (local-only
routes, thumbnails), test_leftovers.py (paths, names, cross-process lock, thumbnail de-dup, dialog errors),
test_security.py (request trust, trusted folders, no validation leaks, /file hardening),
test_transfer.py (library export / import: round trip to a second "computer", merge, hostile zips),
test_package.py (what ComfyUI sees: the nodes, the web folder, every route),
test_library_nodes.py (the nodes that take a library file by id / library / name, not by path).

GitHub runs them on every push and pull request (`.github/workflows/tests.yml`, Windows and Linux), and
the publish workflow won't publish unless they pass.

## Queue binding on the example workflow (bind_example.mjs)

    node tests/bind_example.mjs

Runs `web/tp_bind.js` in Node, with stand-ins for ComfyUI's `app` and `api` and a canvas rebuilt from
`example_workflows/Reference_Library_example.json`: which files are wired to which model inputs, that tags
become "image N" for every model, that the API prompt holds no disk paths, that a missing library stops the
queue, and that a workflow without a Reference Prompt is left untouched. No ComfyUI needed.

## Frontend regression harness (harness.js)
14 scenarios (incl. a workflow with the ids from before the rename): strip/ink on the canvas + the API prompt binding (incl. claims Test 01/02, string chains,
subgraph boundary, muted files). Needs a running ComfyUI, the library assets Buttons.png, Giftwood.png,
CAPIBARA.jpg and Biscuit.png in ComfyUI's input folder, and the Nano Banana 2.1 node.
To run: copy harness.js to custom_nodes/comfyui-reference-library/web/_harness.txt (a .js there would load as an
extension), then in the browser console:

    const src = await (await fetch("/extensions/comfyui-reference-library/_harness.txt")).text();
    await new (Object.getPrototypeOf(async function(){}).constructor)(src.replace(/JSON\.stringify\(results, null, 1\)\s*$/, "return results;"))();

Set `window.__harnessInput` to your ComfyUI input folder (ending in `/`) before running it.
Results land in window.__harness (takes ~70 s). Delete _harness.txt afterwards. It never queues anything.
