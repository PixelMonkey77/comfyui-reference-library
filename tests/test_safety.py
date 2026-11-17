"""Library file safety: backups, damaged-file recovery, random ids, malformed entries, locked-file retry."""
import json
import os


def _names(data):
    return [(lib["name"], [a["name"] for a in lib["assets"]]) for lib in data["libraries"]]


def _folder(pack):
    return os.path.dirname(pack.store._library_file())


def test_backup_holds_previous_version(pack, img):
    data = pack.store._load_library()
    pack.library._add(data, {"new_library": "Lib A", "items": [{"path": img("Buttons.png")}]})
    data = pack.store._load_library()
    pack.library._add(data, {"library_id": data["libraries"][0]["id"], "items": [{"path": img("Giftwood.png")}]})
    with open(pack.store._library_file() + ".bak", encoding="utf-8") as f:
        bak = json.load(f)
    assert [a["name"] for a in bak["libraries"][0]["assets"]] == ["Buttons"]


def test_damaged_file_recovered_from_backup(pack):
    f = pack.store._library_file()
    with open(f, "w", encoding="utf-8") as fh:
        fh.write('{"version": 2, "libraries": [ {"id": "x", "name": "Lib_A", "assets": [ TRUNCATED')
    data = pack.store._load_library()
    assert _names(data) == [("Lib_A", ["Buttons"])]
    assert any(x.startswith("library.json.corrupt-") for x in os.listdir(_folder(pack))), "damaged copy kept"
    assert pack.store._RECOVERY_NOTE
    assert "warning" in pack.store._library_payload(data), "the warning is sent"
    assert "warning" not in pack.store._library_payload(data), "...once"


def test_damaged_file_without_backup_is_kept(pack):
    f, d = pack.store._library_file(), _folder(pack)
    for x in os.listdir(d):
        if x.endswith(".bak"):
            os.remove(os.path.join(d, x))
    with open(f, "w", encoding="utf-8") as fh:
        fh.write("not json at all")
    assert pack.store._load_library()["libraries"] == []
    assert sum(x.startswith("library.json.corrupt-") for x in os.listdir(d)) == 2, "nothing deleted"


def test_ids_are_random(pack, img):
    """Replace a file, then add the original path again: it gets a different id."""
    data = pack.store._load_library()
    pack.library._add(data, {"new_library": "Lib B", "items": [{"path": img("Buttons.png")}]})
    data = pack.store._load_library()
    first = data["libraries"][0]["assets"][0]["id"]
    pack.library._replace(data, {"id": first, "path": img("CAPIBARA.jpg"), "name": "Capy"})
    data = pack.store._load_library()
    pack.library._add(data, {"library_id": data["libraries"][0]["id"], "items": [{"path": img("Buttons.png")}]})
    ids = [a["id"] for a in pack.store._load_library()["libraries"][0]["assets"]]
    assert len(ids) == 2 and len(set(ids)) == 2


def test_malformed_entries_dropped(pack):
    with open(pack.store._library_file(), "w", encoding="utf-8") as fh:
        json.dump({"version": 2, "libraries": [
            {"id": "L", "name": "Lib_C", "assets": [{"id": "ok1", "name": "Fine", "path": "C:/x.png"}, {"name": "no id"}, "junk"]},
            {"name": "no id lib"}]}, fh)
    assert ("Lib_C", ["Fine"]) in _names(pack.store._load_library())


def test_locked_file_save_is_retried(pack, monkeypatch):
    real, calls = os.replace, {"n": 0}

    def flaky(a, b):
        calls["n"] += 1
        if calls["n"] == 1:
            raise PermissionError("locked")
        return real(a, b)

    monkeypatch.setattr(pack.store.os, "replace", flaky)
    pack.store._save_library({"version": 2, "libraries": []}, backup=False)
    assert calls["n"] == 2
    assert not [x for x in os.listdir(_folder(pack)) if x.endswith(".tmp")]
