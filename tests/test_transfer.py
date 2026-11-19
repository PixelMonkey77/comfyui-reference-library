"""Library export / import: what the zip holds, several libraries in one zip, a round trip to "another
computer" (a second copy of the pack with its own folders), re-import and merge, name clashes, hostile
zips, the folder and file dialogs, local-only routes."""
import asyncio
import json
import os
import shutil
import zipfile

import pytest

from helpers import OTHER_PC, Req, load_pack

run = asyncio.run
state = {}
FORMAT = "comfyui-reference-library"


@pytest.fixture(scope="module")
def other(tmp_path_factory):
    """A second computer: its own user, input and output folders, an empty library."""
    return load_pack(str(tmp_path_factory.mktemp("other_pc")))


@pytest.fixture(scope="module")
def share(tmp_path_factory):
    """The folder the user picks for exports (a USB stick, a shared drive...)."""
    return str(tmp_path_factory.mktemp("share"))


def _lib(pack, name):
    return next(l for l in pack.store._load_library()["libraries"] if l["name"] == name)


def _manifest(path):
    with zipfile.ZipFile(path) as zf:
        return json.loads(zf.read("library.json")), sorted(zf.namelist())


def _files_under(folder):
    return sorted(os.path.join(d, f) for d, _, fs in os.walk(folder) for f in fs)


def _make_zip(path, manifest, files):
    with zipfile.ZipFile(path, "w") as zf:
        if manifest is not None:
            zf.writestr("library.json", manifest if isinstance(manifest, str) else json.dumps(manifest))
        for name, data in files.items():
            zf.writestr(name, data)
    return path


def _import(pack, path):
    """Imports through the route; returns (status, the per-library summaries or the error text)."""
    r = run(pack.guard._guard(pack.transfer._import_route, local=True)(Req(body={"path": path})))
    body = json.loads(r.text)
    return r.status, body["imported"]["libraries"] if r.status == 200 else body["error"]


def test_export_one_library(pack, img, scratch, share):
    # Two files, a second Buttons.png from another folder (same file name), and one that then goes missing.
    twin_dir = os.path.join(scratch, "elsewhere")
    os.makedirs(twin_dir)
    twin, gone = os.path.join(twin_dir, "Buttons.png"), os.path.join(twin_dir, "Gone.png")
    shutil.copy(img("Biscuit.png"), twin)
    shutil.copy(img("Giftwood.png"), gone)
    r = pack.library._add(pack.store._load_library(), {"new_library": "Team_Refs", "items": [
        {"path": img("Buttons.png")}, {"path": img("Giftwood.png")}, {"path": twin}, {"path": gone}]})
    assert len(r["added"]) == 4
    os.remove(gone)

    lib = _lib(pack, "Team_Refs")
    out = pack.transfer._export_libraries([lib["id"]], share)
    assert out["path"] == os.path.join(share, "Team_Refs.zip"), "one library: the zip is named after it, in the chosen folder"
    assert out["libraries"] == [{"name": "Team_Refs", "files": 3, "skipped": ["Gone"]}], "a file missing on disk is left out and named"

    manifest, names = _manifest(out["path"])
    assert names == ["files/Team_Refs/Buttons.png", "files/Team_Refs/Buttons_2.png", "files/Team_Refs/Giftwood.png", "library.json"]
    assert manifest["format"] == FORMAT and manifest["version"] == 2 and len(manifest["libraries"]) == 1
    m = manifest["libraries"][0]
    assert m["id"] == lib["id"] and m["name"] == "Team_Refs"
    assert [(a["id"], a["name"]) for a in m["assets"]] == [(a["id"], a["name"]) for a in lib["assets"][:3]]
    text = json.dumps(manifest)
    assert scratch not in text and os.path.dirname(img("x")) not in text and "path" not in text, "no disk paths travel"
    state.update(zip=out["path"], lib=lib)


def test_export_never_overwrites(pack, share):
    again = pack.transfer._export_libraries([state["lib"]["id"]], share)
    assert os.path.basename(again["path"]) == "Team_Refs_2.zip" and os.path.exists(state["zip"])
    assert not [f for f in os.listdir(share) if f.endswith(".part")]


def test_export_several_libraries_in_one_zip(pack, img, scratch, share):
    pack.library._add(pack.store._load_library(), {"new_library": "Props", "items": [{"path": img("CAPIBARA.jpg")}, {"path": img("Buttons.png")}]})
    lonely = os.path.join(scratch, "lonely.png")
    shutil.copy(img("Biscuit.png"), lonely)
    pack.library._add(pack.store._load_library(), {"new_library": "Ghosts", "items": [{"path": lonely}]})
    os.remove(lonely)
    ids = [_lib(pack, n)["id"] for n in ("Ghosts", "Props", "Team_Refs")]

    out = pack.transfer._export_libraries(ids, share)
    assert os.path.basename(out["path"]) == "Reference_Libraries.zip"
    assert [(l["name"], l["files"]) for l in out["libraries"]] == [("Team_Refs", 3), ("Props", 2)], "in library order"
    assert out["empty"] == ["Ghosts"], "a library with no file left on disk is left out and named"
    manifest, names = _manifest(out["path"])
    assert [l["name"] for l in manifest["libraries"]] == ["Team_Refs", "Props"]
    # Both libraries hold a Buttons.png: each library has its own folder in the zip.
    assert "files/Team_Refs/Buttons.png" in names and "files/Props/Buttons.png" in names and len(names) == 6
    state.update(both=out["path"], props=_lib(pack, "Props"))


def test_export_refusals(pack, share, scratch):
    files = sorted(os.listdir(share))
    for ids, folder, status, field in [
        (["no-such-library"], share, 404, "library"),
        ([], share, 400, "library"),
        ("Team_Refs", share, 400, "library"),
        ([_lib(pack, "Ghosts")["id"]], share, 400, "library"),          # nothing on disk to export
        ([state["lib"]["id"]], os.path.join(scratch, "nope"), 400, "folder"),
        ([state["lib"]["id"]], "relative/folder", 400, "folder"),
        ([state["lib"]["id"]], state["zip"], 400, "folder"),             # a file, not a folder
    ]:
        with pytest.raises(pack.store.LibError) as e:
            pack.transfer._export_libraries(ids, folder)
        assert (e.value.status, e.value.field) == (status, field), (ids, folder)
    assert sorted(os.listdir(share)) == files, "no half-written zip left"


def test_import_on_another_computer(pack, other):
    status, done = _import(pack, state["zip"])  # same id here: nothing new
    assert status == 200 and done[0]["added"] == [] and not done[0]["new"]

    r = run(other.guard._guard(other.transfer._import_route, local=True)(Req(body={"path": state["zip"]})))
    body = json.loads(r.text)
    assert r.status == 200, r.text
    (done,) = body["imported"]["libraries"]
    assert done["new"] and done["name"] == "Team_Refs" and len(done["added"]) == 3 and not done["rejected"]
    assert [l["name"] for l in body["libraries"]] == ["Team_Refs"], "the response is the refreshed library list"

    src, lib = state["lib"], _lib(other, "Team_Refs")
    assert lib["id"] == src["id"], "library id kept: workflows' switched-off libraries still match"
    assert [(a["id"], a["name"], a["kind"]) for a in lib["assets"]] == [(a["id"], a["name"], a["kind"]) for a in src["assets"][:3]]
    folder = os.path.join(other.folder_paths_stub.get_input_directory(), "reference_library", "Team_Refs")
    assert done["folder"] == folder and all(os.path.dirname(a["path"]) == folder for a in lib["assets"])
    for mine, theirs in zip(src["assets"], lib["assets"]):
        with open(mine["path"], "rb") as a, open(theirs["path"], "rb") as b:
            assert a.read() == b.read()
        assert other.nodes.ReferenceImage.VALIDATE_INPUTS(theirs["path"]) is True, "the loader nodes may read imported files"


def test_reimport_adds_nothing(other):
    folder = os.path.join(other.folder_paths_stub.get_input_directory(), "reference_library")
    before = _files_under(folder)
    _, (done,) = _import(other, state["zip"])
    assert not done["new"] and done["added"] == [] and done["already"] == 3
    assert _files_under(folder) == before and len(_lib(other, "Team_Refs")["assets"]) == 3


def test_several_libraries_import_and_merge(pack, other, img, share):
    """The two-library zip on a computer that has one of them: Props is new, Team_Refs is already there."""
    status, done = _import(other, state["both"])
    assert status == 200 and [(d["name"], d["new"], len(d["added"]), d["already"]) for d in done] == [("Team_Refs", False, 0, 3), ("Props", True, 2, 0)]
    props = _lib(other, "Props")
    assert props["id"] == state["props"]["id"] and [a["name"] for a in props["assets"]] == ["CAPIBARA", "Buttons"]
    root = os.path.join(other.folder_paths_stub.get_input_directory(), "reference_library")
    assert sorted(os.listdir(root)) == ["Props", "Team_Refs"], "each library unpacks into its own folder"

    # A newer export of Team_Refs, after the other computer renamed one of its assets: only the new file arrives.
    pack.library._add(pack.store._load_library(), {"library_id": state["lib"]["id"], "items": [{"path": img("CAPIBARA.jpg")}]})
    newer = pack.transfer._export_libraries([state["lib"]["id"]], share)["path"]
    other.library._rename(other.store._load_library(), {"id": _lib(other, "Team_Refs")["assets"][0]["id"], "name": "My_Buttons"})
    _, (done,) = _import(other, newer)
    assert not done["new"] and len(done["added"]) == 1 and done["already"] == 3
    assert [a["name"] for a in _lib(other, "Team_Refs")["assets"]] == ["My_Buttons", "Giftwood", "Buttons_2", "CAPIBARA"]


def test_deleted_library_reimport_reuses_files(other):
    folder = os.path.join(other.folder_paths_stub.get_input_directory(), "reference_library")
    before = _files_under(folder)
    other.library._lib_delete(other.store._load_library(), {"id": state["lib"]["id"]})
    _, (done,) = _import(other, state["zip"])
    assert done["new"] and len(done["added"]) == 3
    assert _files_under(folder) == before, "identical files already unpacked are used again, not copied"


def test_name_clash_gets_a_new_name(tmp_path_factory, img):
    third = load_pack(str(tmp_path_factory.mktemp("third_pc")))
    third.library._add(third.store._load_library(), {"new_library": "team_refs", "items": [{"path": img("Biscuit.png")}]})
    _, (done,) = _import(third, state["zip"])
    assert done["new"] and done["name"] == "Team_Refs_2" and done["wanted_name"] == "Team_Refs"
    assert sorted(l["name"] for l in third.store._load_library()["libraries"]) == ["Team_Refs_2", "team_refs"]


def test_ids_already_in_use_are_reissued(tmp_path_factory, img):
    """An unrelated library that happens to hold an asset with an exported id keeps it."""
    fourth = load_pack(str(tmp_path_factory.mktemp("fourth_pc")))
    taken = state["lib"]["assets"][0]["id"]
    f = fourth.store._library_file()
    os.makedirs(os.path.dirname(f))
    with open(f, "w", encoding="utf-8") as fh:
        json.dump({"version": 2, "libraries": [{"id": "L9", "name": "Mine", "assets": [
            {"id": taken, "name": "Keep", "path": img("Biscuit.png"), "kind": "image"}]}]}, fh)
    _import(fourth, state["both"])
    ids = [l["id"] for l in fourth.store._load_library()["libraries"]] + [a["id"] for _, a in fourth.store._all_assets(fourth.store._load_library())]
    assert len(ids) == 3 + 6 and len(set(ids)) == len(ids) and _lib(fourth, "Mine")["assets"][0]["id"] == taken


def test_first_format_still_imports(tmp_path_factory, img):
    """Version 1 zips (one library, files directly in files/) from the first export build."""
    fifth_root = str(tmp_path_factory.mktemp("fifth_pc"))
    fifth = load_pack(fifth_root)
    with open(img("Buttons.png"), "rb") as f:
        png = f.read()
    z = _make_zip(os.path.join(fifth_root, "old.zip"), {"format": FORMAT, "version": 1, "id": "old-lib", "name": "Old",
                  "assets": [{"id": "a1", "name": "Btn", "kind": "image", "file": "Buttons.png"}]}, {"files/Buttons.png": png})
    status, (done,) = _import(fifth, z)
    assert status == 200 and done["new"] and done["name"] == "Old"
    assert [(l["id"], [a["name"] for a in l["assets"]]) for l in fifth.store._load_library()["libraries"]] == [("old-lib", ["Btn"])]


V2 = {"format": FORMAT, "version": 2}
BAD_ZIPS = {
    "no manifest": (None, "isn't a Reference Library export"),
    "manifest isn't JSON": ("{ nope", "isn't a Reference Library export"),
    "another format": ({"format": "something-else", "version": 2, "libraries": []}, "isn't a Reference Library export"),
    "no version": ({"format": FORMAT, "libraries": []}, "isn't a Reference Library export"),
    "libraries isn't a list": ({**V2, "libraries": "x"}, "isn't a Reference Library export"),
    "a library that isn't one": ({**V2, "libraries": ["junk"]}, "isn't a Reference Library export"),
    "a library folder that climbs": ({**V2, "libraries": [{"id": "x", "name": "X", "folder": "../X", "assets": []}]}, "isn't a Reference Library export"),
    "a newer version": ({"format": FORMAT, "version": 99, "libraries": []}, "newer version"),
    "no libraries": ({**V2, "libraries": []}, "Nothing in this export"),
    "nothing usable": ({**V2, "libraries": [{"id": "x", "name": "X", "folder": "X", "assets": []}]}, "Nothing in this export"),
}


@pytest.mark.parametrize("manifest, message", BAD_ZIPS.values(), ids=BAD_ZIPS.keys())
def test_bad_zip_refused(other, tmp_path, manifest, message):
    before = other.store._load_library()
    status, error = _import(other, _make_zip(str(tmp_path / "bad.zip"), manifest, {}))
    assert status == 400 and message in error
    assert other.store._load_library() == before


def test_not_a_zip_refused(other, tmp_path, img):
    for path in (img("Buttons.png"), str(tmp_path / "missing.zip"), "relative.zip"):
        assert _import(other, path)[0] == 400


def test_hostile_zip_stays_in_its_folder(tmp_path_factory, img):
    """File names in the zip can't choose where a file lands, and only real media files are kept."""
    victim_root = str(tmp_path_factory.mktemp("victim_pc"))
    victim = load_pack(victim_root)
    with open(img("Buttons.png"), "rb") as f:
        png = f.read()
    asset = lambda name, file: {"id": name, "name": name, "kind": "image", "file": file}
    manifest = {**V2, "libraries": [
        {"id": "evil-lib", "name": "../../Evil", "folder": "E", "assets": [
            asset("good", "good.png"), asset("climb", "../../climb.png"), asset("abs", "/tmp/abs.png"),
            asset("drive", "C:\\x\\drive.png"), asset("page", "page.html"), asset("fake", "fake.png"),
            asset("absent", "absent.png"), {"name": 5}, "junk"]},
        {"id": "empty-lib", "name": "Hollow", "folder": "H", "assets": [asset("page2", "page.html")]}]}
    z = _make_zip(os.path.join(victim_root, "evil.zip"), manifest, {
        "files/E/good.png": png, "files/E/../../climb.png": png, "../../climb.png": png, "/tmp/abs.png": png,
        "files/E/page.html": "<script>alert(1)</script>", "files/E/fake.png": "<script>alert(1)</script>",
        "files/H/page.html": "<script>alert(1)</script>"})
    before = set(_files_under(victim_root))
    status, (evil, hollow) = _import(victim, z)
    assert status == 200 and len(evil["added"]) == 1
    assert sorted(x["name"] for x in evil["rejected"]) == ["2 damaged entries", "abs", "absent", "climb", "drive", "fake", "page"]
    assert hollow["failed"] and hollow["library"] is None and hollow["name"] == "Hollow", "no empty library is made"
    libs = victim.store._load_library()["libraries"]
    assert [(l["name"], [a["name"] for a in l["assets"]]) for l in libs] == [("Evil", ["good"])]
    folder = os.path.join(victim.folder_paths_stub.get_input_directory(), "reference_library", "Evil")
    new = set(_files_under(victim_root)) - before
    stray = {p for p in new if os.path.dirname(p) != folder and "library_image" not in p}
    assert not stray and os.listdir(folder) == ["good.png"], "nothing outside the import folder; rejected files removed"


def test_routes_are_local_only(pack, other, share):
    export, imp = pack.guard._guard(pack.transfer._export_route, local=True), other.guard._guard(other.transfer._import_route, local=True)
    ids = {"ids": [state["lib"]["id"]], "folder": share}
    assert run(export(Req(OTHER_PC, body=ids))).status == 403
    assert run(export(Req(host="attacker.example:8188", body=ids))).status == 403
    assert run(imp(Req(OTHER_PC, body={"path": state["zip"]}))).status == 403
    assert run(imp(Req(host="attacker.example:8188", body={"path": state["zip"]}))).status == 403
    assert run(export(Req(body={"ids": ["nope"], "folder": share}))).status == 404
    r = run(export(Req(body=ids)))
    assert r.status == 200 and json.loads(r.text)["exported"]["libraries"][0]["files"] == 4


def test_export_asks_for_the_folder(pack, share, tmp_path, monkeypatch):
    asked = []

    def dialog(initial_dir, multi=False, kinds=("image",), filters=None, exts=None, folder=False):
        asked.append((initial_dir, folder))
        return asked_answer

    monkeypatch.setattr(pack.dialogs, "_open_file_dialog", dialog)
    monkeypatch.setitem(pack.transfer._LAST_EXPORT_DIR, "path", "")
    export = pack.guard._guard(pack.transfer._export_route, local=True)
    asked_answer = []
    r = run(export(Req(body={"ids": [state["lib"]["id"]]})))
    assert r.status == 200 and json.loads(r.text) == {"exported": None}, "cancelled: nothing happens"
    assert asked == [(pack.folder_paths_stub.get_output_directory(), True)], "a folder dialog, opening at ComfyUI's output folder"
    asked_answer = [str(tmp_path)]
    done = json.loads(run(export(Req(body={"ids": [state["lib"]["id"]]}))).text)["exported"]
    assert done["path"] == os.path.join(str(tmp_path), "Team_Refs.zip") and os.path.isfile(done["path"])
    run(export(Req(body={"ids": [state["lib"]["id"]]})))
    assert asked[-1] == (str(tmp_path), True), "next time the dialog opens where the last export went"


def test_import_asks_for_the_zip(other, monkeypatch):
    asked = {}

    def dialog(initial_dir, multi=False, kinds=("image",), filters=None, exts=None, folder=False):
        asked.update(multi=multi, filters=filters, exts=exts, folder=folder)
        return asked.get("answer", [])

    monkeypatch.setattr(other.dialogs, "_open_file_dialog", dialog)
    imp = other.guard._guard(other.transfer._import_route, local=True)
    r = run(imp(Req()))
    assert r.status == 200 and json.loads(r.text) == {"imported": None}, "cancelled: nothing happens"
    assert asked["multi"] is False and asked["folder"] is False and asked["exts"] == ["zip"] and asked["filters"][0][1] == ["*.zip"]
    asked["answer"] = [state["zip"]]
    assert json.loads(run(imp(Req())).text)["imported"]["libraries"][0]["already"] == 3


def test_folder_dialog_command(pack, monkeypatch):
    """The folder picker runs the folder helper of this platform, not the file one."""
    import types
    ran = {}

    def fake_run(cmd, **kw):
        ran.update(cmd=cmd, env=kw["env"])
        return types.SimpleNamespace(returncode=0, stdout=b"/picked/folder\n", stderr=b"")

    monkeypatch.delenv("LIBRARY_IMAGE_FAKE_DIALOG", raising=False)
    monkeypatch.setattr(pack.dialogs.subprocess, "run", fake_run)
    monkeypatch.setattr(pack.dialogs.subprocess, "CREATE_NO_WINDOW", 0, raising=False)
    for platform, script in [("win32", pack.dialogs._PS_FOLDER_DIALOG), ("darwin", pack.dialogs._MAC_FOLDER_DIALOG), ("linux", pack.dialogs._TK_FOLDER_DIALOG)]:
        monkeypatch.setattr(pack.dialogs.sys, "platform", platform)
        assert pack.dialogs._open_file_dialog(os.getcwd(), folder=True) == ["/picked/folder"]
        assert script in ran["cmd"] and ran["env"]["LI_INIT"] == os.getcwd()
        assert pack.dialogs._FOLDER_PROMPT in script
    # Windows: the Explorer-style picker first, the old tree window only if that can't be set up.
    ps = pack.dialogs._PS_FOLDER_DIALOG
    assert "@PROMPT@" not in ps and ps.count("@'") == 1 and ps.count("\n'@\n") == 1, "one C# here-string, closed at a line start"
    assert ps.index("LiFolderPicker]::Pick") < ps.index("FolderBrowserDialog") and "0x20 | 0x40 | 0x800" in ps
    assert len(ps) < 8000, "passed on the command line: keep it well under Windows' limit"
