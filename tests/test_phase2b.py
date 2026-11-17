"""Missing-file recovery, BOM, duplicate ids, kind repair, per-item add errors, replace onto a path
already in the library, 16-bit thumbnails, one dialog at a time."""
import asyncio
import io
import json
import os
import threading
import types

import numpy as np
import pytest
from PIL import Image

from helpers import needs_torch


def _assets(pack, data):
    return [a for _, a in pack.store._all_assets(data)]


def test_missing_file_restored_from_backup(pack, img):
    f = pack.store._library_file()
    data = pack.store._load_library()
    pack.library._add(data, {"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}]})
    data = pack.store._load_library()
    pack.library._add(data, {"library_id": data["libraries"][0]["id"], "items": [{"path": img("Giftwood.png")}]})
    os.remove(f)
    pack.store._RECOVERY_NOTE = None
    data = pack.store._load_library()
    assert [a["name"] for a in data["libraries"][0]["assets"]] == ["Buttons"]
    assert os.path.exists(f) and os.path.exists(f + ".bak") and pack.store._RECOVERY_NOTE


def test_nothing_on_disk_is_an_empty_library(pack):
    d = os.path.dirname(pack.store._library_file())
    for x in os.listdir(d):
        os.remove(os.path.join(d, x))
    pack.store._RECOVERY_NOTE = None
    assert pack.store._load_library()["libraries"] == []
    assert not os.listdir(d) and not pack.store._RECOVERY_NOTE, "nothing written, nothing to report"


def test_bom_file_reads_fine(pack, img):
    f = pack.store._library_file()
    with open(f, "wb") as fh:
        fh.write(b"\xef\xbb\xbf" + json.dumps({"version": 2, "libraries": [
            {"id": "L1", "name": "Bom", "assets": [{"id": "a1", "name": "X", "path": img("Buttons.png"), "kind": "image"}]}]}).encode())
    assert [lib["name"] for lib in pack.store._load_library()["libraries"]] == ["Bom"]
    assert not any(".corrupt-" in x for x in os.listdir(os.path.dirname(f))), "not treated as damaged"


def test_duplicate_ids_reissued_and_kind_repaired(pack, img):
    f = pack.store._library_file()
    with open(f, "w", encoding="utf-8") as fh:
        json.dump({"version": 2, "libraries": [
            {"id": "L1", "name": "One", "assets": [{"id": "dup", "name": "A", "path": img("Buttons.png"), "kind": "image"},
                                                   {"id": "dup", "name": "B", "path": img("Giftwood.png"), "kind": "picture"}]},
            {"id": "L1", "name": "Two", "assets": [{"id": "dup", "name": "C", "path": img("CAPIBARA.jpg")}]}]}, fh)
    data = pack.store._load_library()
    ids = [lib["id"] for lib in data["libraries"]] + [a["id"] for a in _assets(pack, data)]
    with open(f, encoding="utf-8") as fh:
        disk = json.load(fh)
    disk_ids = [lib["id"] for lib in disk["libraries"]] + [a["id"] for lib in disk["libraries"] for a in lib["assets"]]
    assert len(set(ids)) == len(ids) == 5 and disk_ids == ids, "fixed and saved"
    assert _assets(pack, data)[1].get("kind") == "image"
    assert [a["id"] for a in _assets(pack, pack.store._load_library())] == [a["id"] for a in _assets(pack, data)], "stable on the next read"


def test_bad_items_do_not_sink_good_ones(pack, img, scratch):
    data = pack.store._load_library()
    bad = os.path.join(scratch, "broken.png")
    with open(bad, "wb") as fh:
        fh.write(b"not a png")
    missing = os.path.join(scratch, "nope", "missing.png")
    r = pack.library._add(data, {"library_id": data["libraries"][0]["id"], "items": [
        {"path": bad}, {"path": 12}, "junk", {"path": img("Biscuit.png")}, {"path": img("Buttons.png")}, {"path": missing}]})
    assert len(r["added"]) == 1, "Biscuit, the one good new file"
    rejected = [x["path"] for x in r["rejected"]]
    # (entries that are not {"path": "..."} at all are skipped; Buttons is already in the library)
    assert sorted(rejected) == sorted([bad, missing, img("Buttons.png")])
    with pytest.raises(pack.store.LibError) as e:
        pack.library._add(data, {"items": "nope"})
    assert e.value.status == 400


def test_replace_onto_existing_path_refused(pack):
    data = pack.store._load_library()
    a, b = data["libraries"][0]["assets"][:2]
    with pytest.raises(pack.store.LibError) as e:
        pack.library._replace(data, {"id": a["id"], "path": b["path"]})
    assert e.value.field == "file"
    with pytest.raises(pack.store.LibError) as e:
        pack.library._replace(data, {"id": a["id"], "path": ["x"]})
    assert e.value.status == 400


@pytest.fixture(scope="module")
def grey16(scratch):
    """A 16-bit greyscale ramp, black to white."""
    path = os.path.join(scratch, "grey16.png")
    Image.fromarray(np.tile(np.linspace(0, 65535, 64), (64, 1)).astype(np.uint16)).save(path)
    return path


def test_16bit_thumbnail_is_not_white(pack, grey16):
    arr = np.array(Image.open(io.BytesIO(pack.thumbs._make_thumb(grey16, 64, "image"))).convert("L"))
    assert arr.min() < 20 and arr.max() > 235 and 100 < arr.mean() < 155


@needs_torch
def test_16bit_loader_agrees_with_thumbnail(pack, grey16):
    pack.store._trust_folders([grey16])  # loader nodes only read trusted folders
    tensor, _ = pack.nodes.ReferenceImage().load(grey16)
    assert abs(float(tensor.mean()) - 0.5) < 0.05


def test_one_dialog_at_a_time(pack, monkeypatch):
    monkeypatch.delenv("LIBRARY_IMAGE_FAKE_DIALOG", raising=False)
    started, release = threading.Event(), threading.Event()

    def slow_run(*a, **k):
        started.set()
        release.wait(5)
        return types.SimpleNamespace(returncode=0, stdout=b"C:/a.png\n", stderr=b"")

    monkeypatch.setattr(pack.dialogs.subprocess, "run", slow_run)

    async def both():
        first = asyncio.create_task(pack.dialogs._dialog_response("paths", "", True, ("image",)))
        await asyncio.to_thread(started.wait, 5)
        second = await pack.dialogs._dialog_response("paths", "", True, ("image",))
        release.set()
        return await first, second

    r1, r2 = asyncio.run(both())
    assert r1.status == 200 and r2.status == 409


def test_dialog_timeout_releases_lock(pack, monkeypatch):
    monkeypatch.delenv("LIBRARY_IMAGE_FAKE_DIALOG", raising=False)

    def timeout_run(*a, **k):
        raise pack.dialogs.subprocess.TimeoutExpired("x", 1)

    monkeypatch.setattr(pack.dialogs.subprocess, "run", timeout_run)
    r = asyncio.run(pack.dialogs._dialog_response("path", "", False, ("image",)))
    assert r.status == 200 and json.loads(r.text) == {"path": None} and not pack.dialogs._DIALOG_LOCK.locked()


def test_requested_kinds(pack):
    assert tuple(pack.dialogs._requested_kinds({"kinds": "image"})) == ("image",)
    assert tuple(pack.dialogs._requested_kinds({"kinds": [1, "video", "video", "x"]})) == ("video",)
