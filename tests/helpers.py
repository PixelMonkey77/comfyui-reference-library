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
    """PromptServer.instance.routes: every route decorator hands the handler back unchanged."""
    def __getattr__(self, _):
        return lambda *a, **k: (lambda f: f)


def load_pack(scratch):
    """A fresh copy of the pack (its own caches and locks) whose user / input / output folders are
    inside `scratch`."""
    server = types.ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": type("Instance", (), {"routes": _Routes()})()})
    sys.modules["server"] = server
    fp = types.ModuleType("folder_paths")
    fp.get_user_directory = lambda: scratch
    fp.get_input_directory = lambda: os.path.join(scratch, "comfy_input")
    fp.get_output_directory = lambda: os.path.join(scratch, "comfy_output")
    sys.modules["folder_paths"] = fp
    if not HAS_TORCH:
        sys.modules.setdefault("torch", types.ModuleType("torch"))
    spec = importlib.util.spec_from_file_location("reference_library_under_test", os.path.join(PACK_DIR, "__init__.py"))
    pack = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pack)
    pack._CACHE_DIR = os.path.join(scratch, "cache")  # not the repo's own .cache
    pack.folder_paths_stub = fp
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
