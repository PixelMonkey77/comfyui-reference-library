"""Paths, names, the cross-process lock, thumbnail de-dup, dialog failure reporting."""
import asyncio
import os
import subprocess
import sys
import threading
import time
import types
import unicodedata

import pytest

from helpers import Req, windows_only

_HOLD_LOCK = """
import sys, time
f = open(sys.argv[1], "a+b")
if sys.platform == "win32":
    import msvcrt; f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
else:
    import fcntl; fcntl.flock(f.fileno(), fcntl.LOCK_EX)
print("held", flush=True); time.sleep(1.5)
if sys.platform == "win32":
    f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
else:
    fcntl.flock(f.fileno(), fcntl.LOCK_UN)
"""


@windows_only
def test_windows_paths(pack, monkeypatch):
    monkeypatch.setenv("LI_TEST_DIR", r"D:\Pics")
    assert pack._clean_path(r"D:\work\$dollar\a.png") == r"D:\work\$dollar\a.png", "$NAME left alone"
    assert "%LI_TEST_DIR%" in pack._clean_path(r"%LI_TEST_DIR%\a.png"), "%VAR% not expanded"
    assert pack._clean_path('"D:\\x\\y.png"') == r"D:\x\y.png", 'quotes from "Copy as path" removed'


def test_no_variable_expansion(pack, monkeypatch):
    monkeypatch.setenv("LI_TEST_DIR", "/secret")
    assert "secret" not in pack._clean_path("$LI_TEST_DIR/a.png")
    assert "secret" not in pack._clean_path("%LI_TEST_DIR%/a.png")
    assert pack._raw_path('  "pics/cat.png" ') == "pics/cat.png"


def test_relative_paths_refused(pack):
    with pytest.raises(pack.LibError, match="full path"):
        pack._checked_file("pics/cat.png")
    assert "full path" in str(pack._validate("image", "cat.png", ""))


def test_names(pack):
    assert pack._tag_name(unicodedata.normalize("NFD", "Café_Noël")) == "Café_Noël", "decomposed accents stay one word"
    assert (pack._tag_name("-"), pack._tag_name("--x--"), pack._tag_name("my-cat")) == ("asset", "x", "my-cat")
    # Compared the way the browser does: ß isn't SS, É is é.
    assert pack._fold("Straße") != pack._fold("STRASSE") and pack._fold("ÉCOLE") == pack._fold("école")


def test_change_waits_for_other_process(pack, img):
    lockpath = pack._library_file() + ".lock"
    os.makedirs(os.path.dirname(lockpath), exist_ok=True)
    holder = subprocess.Popen([sys.executable, "-c", _HOLD_LOCK, lockpath], stdout=subprocess.PIPE, text=True)
    try:
        holder.stdout.readline()
        t = time.perf_counter()
        r = asyncio.run(pack._make(pack._add)(Req(body={"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}]})))
        waited = time.perf_counter() - t
    finally:
        holder.wait()
    assert r.status == 200 and 1.0 < waited < 8, f"waited {waited:.2f} s"


def test_simultaneous_thumbnails_made_once(pack, img, monkeypatch):
    calls, real = {"n": 0}, pack._make_thumb

    def slow(path, size, kind):
        calls["n"] += 1
        time.sleep(0.3)
        return real(path, size, kind)

    monkeypatch.setattr(pack, "_make_thumb", slow)
    path = img("Giftwood.png")
    st = os.stat(path)
    threads = [threading.Thread(target=pack._sized_thumb, args=(path, st, "image", 96)) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls["n"] == 1 and not pack._MASTER_LOCKS


def test_dialog_failure_is_reported(pack, monkeypatch):
    failed = types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"boom: STA thread\nAccess denied")
    monkeypatch.setattr(pack.subprocess, "run", lambda *a, **k: failed)
    monkeypatch.delenv("LIBRARY_IMAGE_FAKE_DIALOG", raising=False)
    r = asyncio.run(pack._dialog_response("paths", "", True, ("image",)))
    assert r.status == 500 and "Access denied" in r.text and not pack._DIALOG_LOCK.locked()
