"""The parsed-library cache, file probes and file checks outside the lock, and a 1000-asset library."""
import asyncio
import json
import os
import time

import pytest


@pytest.fixture(scope="module")
def parses(pack):
    """Counts real reads of library.json."""
    count, real = {"n": 0}, pack._read_library_file

    def counting(path):
        count["n"] += 1
        return real(path)

    pack._read_library_file = counting
    yield count
    pack._read_library_file = real


def test_reads_come_from_cache(pack, img, parses):
    data = pack._load_library()
    pack._add(data, {"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}, {"path": img("Giftwood.png")}]})
    parses["n"] = 0
    a = pack._load_library()
    pack._load_library()
    assert parses["n"] == 0, "after a save, reads don't parse the file again"
    a["libraries"][0]["name"] = "MUTATED"
    a["libraries"][0]["assets"].clear()
    c = pack._load_library()["libraries"][0]
    assert c["name"] == "Lib_A" and len(c["assets"]) == 2, "a caller's changes never reach the cache"


def test_outside_edit_is_picked_up(pack, parses):
    f = pack._library_file()
    time.sleep(0.05)
    with open(f, encoding="utf-8") as fh:
        disk = json.load(fh)
    disk["libraries"][0]["name"] = "Edited_By_Hand"
    with open(f, "w", encoding="utf-8") as fh:
        json.dump(disk, fh)
    assert pack._load_library()["libraries"][0]["name"] == "Edited_By_Hand" and parses["n"] == 1


def test_failed_change_does_not_stick(pack):
    with pack._LIB_LOCK:
        x = pack._load_library()
        x["libraries"][0]["name"] = "HALF"  # ...and then the request fails before saving
    assert pack._load_library()["libraries"][0]["name"] == "Edited_By_Hand"


def test_add_uses_pre_probed_files(pack, img, monkeypatch):
    calls, real = {"n": 0}, pack._probe

    def counting(path, kind):
        calls["n"] += 1
        return real(path, kind)

    monkeypatch.setattr(pack, "_probe", counting)
    items = [{"path": img("CAPIBARA.jpg")}, {"path": img("Biscuit.png")}]
    probes = pack._probe_all([i["path"] for i in items])
    assert calls["n"] == 2
    data = pack._load_library()
    r = pack._add(data, {"library_id": data["libraries"][0]["id"], "items": items}, probes)
    assert calls["n"] == 2 and len(r["added"]) == 2, "no probing while the lock is held"

    missing = os.path.join(os.path.dirname(img("x")), "nope", "x.png")
    bad = pack._probe_all([missing])
    data = pack._load_library()
    r = pack._add(data, {"library_id": data["libraries"][0]["id"], "items": [{"path": missing}, {"path": img("Buttons.png")}]}, bad)
    assert len(r["rejected"]) == 2, "errors are reported per file (missing; already in the library)"


def test_file_checks_run_after_lock_released(pack, monkeypatch):
    held, real = [], pack._asset_view
    monkeypatch.setattr(pack, "_asset_view", lambda lib, a: held.append(pack._LIB_LOCK.locked()) or real(lib, a))
    resp = asyncio.run(pack._read_library())
    assert resp.status == 200 and held and not any(held)


def test_thousand_assets(pack, img):
    big = {"version": 2, "libraries": [{"id": f"L{k}", "name": f"Lib_{k}", "assets": [
        {"id": f"a{k}_{i}", "name": f"n{k}_{i}", "kind": "image",
         "path": img("Buttons.png") if i % 2 else os.path.join(os.path.dirname(img("x")), "missing", f"{i}.png")}
        for i in range(250)]} for k in range(4)]}
    pack._save_library(big)
    pack._CACHE.update(key=None, data=None)
    t = time.perf_counter()
    assert sum(len(lib["assets"]) for lib in pack._load_library()["libraries"]) == 1000
    cold = time.perf_counter() - t
    t = time.perf_counter()
    resp = asyncio.run(pack._read_library())
    full = time.perf_counter() - t
    assert resp.status == 200 and len(json.loads(resp.text)["assets"]) == 1000
    assert pack._find_asset("a3_249")["name"] == "n3_249"
    print(f"1000 assets: first read {cold * 1000:.1f} ms, full /assets response {full * 1000:.0f} ms")
    assert full < 10, "generous: catches a per-file slowdown, not machine speed"
