"""Local-only routes, thumbnail disk cache and sizes, oversized images, damaged-entry note, cache folder."""
import asyncio
import io
import json
import os
import time

import pytest
from PIL import Image

from helpers import LOCAL, Req

run = asyncio.run
state = {}


@pytest.mark.parametrize("remote, want", [("127.0.0.1", 200), ("::1", 200), ("::ffff:127.0.0.1", 200), ("192.168.1.20", 403)])
def test_pick_is_local_only(pack, monkeypatch, remote, want):
    monkeypatch.setattr(pack.dialogs, "_open_file_dialog", lambda *a, **k: ["C:/x.png"])
    assert run(pack.guard._guard(pack.dialogs._pick, local=True)(Req(remote, body={"kinds": ["image"]}))).status == want


def test_changes_are_local_only(pack, img):
    assert run(pack.guard._guard(pack.dialogs._browse, local=True)(Req("10.0.0.5"))).status == 403
    add = pack.routes._make(pack.library._add)
    assert run(add(Req("10.0.0.5", body={"new_library": "X", "items": [{"path": img("Buttons.png")}]}))).status == 403
    r = run(add(Req(body={"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}, {"path": img("Giftwood.png")}]})))
    assert r.status == 200
    state["aid"] = pack.store._load_library()["libraries"][0]["assets"][0]["id"]
    assert run(pack.routes._make(pack.library._rename)(Req("10.0.0.5", body={"id": state["aid"], "name": "Renamed"}))).status == 403
    assert run(pack.library._assets(Req("10.0.0.5"))).status == 200, "another machine may still view the library"


def test_thumbnail_master_cached_on_disk(pack, monkeypatch):
    made, real = [], pack.thumbs._make_thumb
    monkeypatch.setattr(pack.thumbs, "_make_thumb", lambda *a: made.append(a) or real(*a))
    r = run(pack.thumbs._thumb(Req(query={"id": state["aid"], "s": "96"})))
    assert r.status == 200 and max(Image.open(io.BytesIO(r.body)).size) == 96
    assert len(os.listdir(pack.thumbs._thumb_dir())) == 1 and len(made) == 1
    pack.thumbs._THUMBS.clear()  # a "restart": the memory cache is gone, the master on disk isn't
    r = run(pack.thumbs._thumb(Req(query={"id": state["aid"], "s": "256"})))
    assert r.status == 200 and max(Image.open(io.BytesIO(r.body)).size) == 256
    # The second size comes from the master on disk: the source file isn't read again.
    assert len(os.listdir(pack.thumbs._thumb_dir())) == 1 and len(made) == 1


def test_oversized_image_gets_placeholder(pack, scratch):
    big = os.path.join(scratch, "huge.png")
    Image.new("L", (9000, 8000)).save(big, optimize=False)
    lib = pack.store._load_library()["libraries"][0]["id"]
    assert run(pack.routes._make(pack.library._add)(Req(body={"library_id": lib, "items": [{"path": big}]}))).status == 200
    bid = next(a["id"] for _, a in pack.store._all_assets(pack.store._load_library())
               if os.path.normcase(a["path"]) == os.path.normcase(os.path.abspath(big)))
    assert run(pack.thumbs._thumb(Req(query={"id": bid, "s": "96"}))).status == 415


def test_damaged_entries_noted(pack):
    f = pack.store._library_file()
    with open(f, encoding="utf-8") as fh:
        raw = json.load(fh)
    raw["libraries"][0]["assets"].append({"name": "no id"})
    raw["libraries"].append("junk")
    with open(f, "w", encoding="utf-8") as fh:
        json.dump(raw, fh)
    pack.store._RECOVERY_NOTE = None
    pack.store._load_library()
    assert pack.store._RECOVERY_NOTE and "2 damaged entries" in pack.store._RECOVERY_NOTE


def test_locked_file_save_gives_up(pack, monkeypatch):
    real = os.replace

    def locked(a, b):
        if a.endswith(".tmp") and not a.endswith(".bak.tmp") and ".bak." not in a:
            raise PermissionError("locked")
        return real(a, b)

    monkeypatch.setattr(pack.store.os, "replace", locked)
    t = time.perf_counter()
    with pytest.raises(PermissionError):
        pack.store._save_library({"version": 2, "libraries": []})
    assert time.perf_counter() - t < 3, "retries for about a second, then reports it"


def test_caches_live_in_pack_folder(pack, scratch):
    assert os.path.dirname(pack.thumbs._thumb_dir()) == pack.thumbs._CACHE_DIR
    # The thumbs/ folder older versions kept in the user folder is removed once...
    old = os.path.join(scratch, "default", "library_image", "thumbs")
    os.makedirs(old, exist_ok=True)
    open(os.path.join(old, "a.webp"), "wb").close()
    pack.thumbs._remove_old_thumb_cache()
    assert not os.path.exists(old) and os.path.exists(pack.store._library_file())
    # ...unless it holds anything else.
    os.makedirs(old, exist_ok=True)
    open(os.path.join(old, "mine.txt"), "w").close()
    pack.thumbs._remove_old_thumb_cache()
    assert os.path.exists(os.path.join(old, "mine.txt"))
