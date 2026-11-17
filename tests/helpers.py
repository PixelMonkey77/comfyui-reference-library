"""Shared by the server tests: loads the pack without a ComfyUI checkout and fakes a request.

The pack imports `server` and `folder_paths` from ComfyUI; both are replaced by small stand-ins, so
the tests need only Pillow, numpy, aiohttp and pytest. torch is optional: without it the pack still
imports (a stand-in module), and the few checks that load an image as a tensor are skipped.
"""
import importlib.util
import os
import sys
import types

import pytest

PACK_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAS_TORCH = importlib.util.find_spec("torch") is not None

needs_torch = pytest.mark.skipif(not HAS_TORCH, reason="torch isn't installed")
windows_only = pytest.mark.skipif(os.name != "nt", reason="checks Windows path forms (D:\\...)")


class _Routes:
    """PromptServer.instance.routes: every route decorator hands the handler back unchanged, and
    what was registered is kept in `registered` as (method, path)."""

    def __init__(self):
        self.registered = []

    def __getattr__(self, method):
        def register(path, *a, **k):
            self.registered.append((method, path))
            return lambda f: f
        return register


_loaded = 0


def load_pack(scratch):
    """A fresh copy of the pack (its own caches and locks) whose user / input / output folders are
    inside `scratch`. Returns the backend package: its modules are attributes (pack.store,
    pack.library, pack.routes, ...), so a test reaches a function as pack.store._load_library and
    patches it in the module that owns it."""
    global _loaded
    server = types.ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": type("Instance", (), {"routes": _Routes()})()})  # new routes per copy
    sys.modules["server"] = server
    fp = types.ModuleType("folder_paths")
    fp.get_user_directory = lambda: scratch
    fp.get_input_directory = lambda: os.path.join(scratch, "comfy_input")
    fp.get_output_directory = lambda: os.path.join(scratch, "comfy_output")
    sys.modules["folder_paths"] = fp
    if not HAS_TORCH:
        sys.modules.setdefault("torch", types.ModuleType("torch"))
    # Loaded the way ComfyUI loads a custom node: the pack's folder as a package, from its __init__.py.
    # A new name each time, so every copy gets its own modules (and its own state).
    _loaded += 1
    name = f"reference_library_under_test_{_loaded}"
    spec = importlib.util.spec_from_file_location(name, os.path.join(PACK_DIR, "__init__.py"),
                                                  submodule_search_locations=[PACK_DIR])
    root = importlib.util.module_from_spec(spec)
    sys.modules[name] = root
    spec.loader.exec_module(root)
    pack = sys.modules[f"{name}.reference_library"]
    pack.thumbs._CACHE_DIR = os.path.join(scratch, "cache")  # not the repo's own .cache
    pack.folder_paths_stub = fp
    pack.root = root  # what ComfyUI sees: NODE_CLASS_MAPPINGS, WEB_DIRECTORY
    return pack


LOCAL = "127.0.0.1"
OTHER_PC = "192.168.1.20"


class Req:
    """The parts of an aiohttp request the pack reads. By default: a browser on this computer; a
    non-loopback `remote` is another machine reaching ComfyUI at 192.168.1.5 (--listen)."""

    def __init__(self, remote=LOCAL, host=None, headers=None, body=None, query=None):
        loopback = remote in ("127.0.0.1", "::1", "::ffff:127.0.0.1")
        self.remote = remote
        self.host = host or ("127.0.0.1:8188" if loopback else "192.168.1.5:8188")
        self.headers = headers or {}
        self._body, self.query = body or {}, query or {}

    async def json(self):
        return self._body
