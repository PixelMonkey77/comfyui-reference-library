"""The nodes a queued prompt uses for tagged library files: they name the file by library id and
names, never by path, so an exported API prompt has no disk paths and runs wherever the library is."""
import json
import os
import shutil

import pytest

from helpers import load_pack, needs_torch

state = {}


@pytest.fixture(scope="module")
def other(tmp_path_factory):
    """A second computer with its own folders."""
    return load_pack(str(tmp_path_factory.mktemp("other_pc")))


def _lib(pack, name):
    return next(l for l in pack.store._load_library()["libraries"] if l["name"] == name)


def test_found_by_id(pack, img, scratch):
    own = os.path.join(scratch, "pics")
    os.makedirs(own)
    for f in ("Buttons.png", "Giftwood.png"):
        shutil.copy(img(f), own)
    pack.library._add(pack.store._load_library(), {"new_library": "Team", "items": [
        {"path": os.path.join(own, "Buttons.png")}, {"path": os.path.join(own, "Giftwood.png")}]})
    lib = _lib(pack, "Team")
    buttons = lib["assets"][0]
    node = pack.nodes.ReferenceLibraryImage
    assert node.VALIDATE_INPUTS(name="Buttons", asset=buttons["id"], library="Team") is True
    # The id decides: stale names from an older export don't matter, nor does a rename since.
    assert node.VALIDATE_INPUTS(name="Old_Name", asset=buttons["id"], library="Old_Library") is True
    found, why = pack.nodes._resolve_asset("image", buttons["id"])
    assert why is None and found["path"] == buttons["path"]
    state.update(lib=lib, own=own)


def test_found_by_names(pack):
    """A prompt written by hand, or a library that has other ids here."""
    node = pack.nodes.ReferenceLibraryImage
    assert node.VALIDATE_INPUTS(name="giftwood", library="team") is True, "names compare like tags: case-insensitive"
    assert node.VALIDATE_INPUTS(name="Giftwood") is True, "no library named: fine while only one has the name"
    assert node.VALIDATE_INPUTS(name="Giftwood", asset="id-from-elsewhere", library="Team") is True


def test_problems_are_said_without_paths(pack, img, scratch):
    node, own = pack.nodes.ReferenceLibraryImage, state["own"]
    cases = {
        "unknown": node.VALIDATE_INPUTS(name="Nobody", asset="nope", library="Team"),
        "other library": node.VALIDATE_INPUTS(name="Buttons", library="Elsewhere"),
        "nothing given": node.VALIDATE_INPUTS(),
        "wrong kind": pack.nodes.ReferenceLibraryVideo.VALIDATE_INPUTS(name="Buttons", library="Team"),
    }
    assert "isn't in this computer's libraries" in cases["unknown"] and "@Nobody (library Team)" in cases["unknown"]
    assert "isn't in this computer's libraries" in cases["other library"], "a named library is never swapped for another"
    assert "isn't in this computer's libraries" in cases["nothing given"]
    assert "is an image file, not a video" in cases["wrong kind"]

    # The same name in a second library: ambiguous without the library's name, fine with it.
    twin = os.path.join(scratch, "twin")
    os.makedirs(twin)
    shutil.copy(img("Biscuit.png"), os.path.join(twin, "Buttons.png"))
    pack.library._add(pack.store._load_library(), {"new_library": "Props", "items": [{"path": os.path.join(twin, "Buttons.png")}]})
    cases["ambiguous"] = node.VALIDATE_INPUTS(name="Buttons")
    assert "more than one library here (Team, Props)" in cases["ambiguous"]
    assert node.VALIDATE_INPUTS(name="Buttons", library="Props") is True

    os.remove(os.path.join(own, "Giftwood.png"))
    cases["missing"] = node.VALIDATE_INPUTS(name="Giftwood", library="Team")
    assert "its file is missing on this computer" in cases["missing"]
    for what, message in cases.items():
        assert scratch not in message and own not in message, f"{what}: a disk path in the message"
    with pytest.raises(ValueError, match="missing on this computer"):
        pack.nodes.ReferenceLibraryImage().load(name="Giftwood", library="Team")


def test_cache_key_follows_the_file(pack):
    node, buttons = pack.nodes.ReferenceLibraryImage, state["lib"]["assets"][0]
    before = node.IS_CHANGED(name="Buttons", asset=buttons["id"])
    assert before == node.IS_CHANGED(name="whatever", asset=buttons["id"]) and state["own"] not in before
    os.utime(buttons["path"], ns=(1_000_000_000, 1_000_000_000))  # 1970: also older than a zip can store (export below)
    assert node.IS_CHANGED(name="Buttons", asset=buttons["id"]) != before, "an edited file isn't served from ComfyUI's cache"
    assert node.IS_CHANGED(name="Nobody") == node.IS_CHANGED(name="Nobody")


def test_exported_library_resolves_on_another_computer(pack, other, tmp_path):
    """The round trip that makes an exported API prompt portable: same ids after export / import."""
    zip_path = pack.transfer._export_libraries([state["lib"]["id"]], str(tmp_path))["path"]
    buttons = state["lib"]["assets"][0]
    node = other.nodes.ReferenceLibraryImage
    api_node = {"name": "Buttons", "asset": buttons["id"], "library": "Team"}  # as the Reference Prompt writes it
    assert state["own"] not in json.dumps(api_node)
    assert "Import the library" in node.VALIDATE_INPUTS(**api_node), "before the import: says what to do"
    other.transfer._finish_import(other.store._load_library(), other.transfer._prepare_import(zip_path))
    assert node.VALIDATE_INPUTS(**api_node) is True
    found, _ = other.nodes._resolve_asset("image", buttons["id"], "Team", "Buttons")
    assert found["path"].startswith(other.folder_paths_stub.get_input_directory()) and found["path"] != buttons["path"]


@needs_torch
def test_loads_like_the_path_loader(pack):
    buttons = state["lib"]["assets"][0]
    by_id = pack.nodes.ReferenceLibraryImage().load(name="Buttons", asset=buttons["id"])
    by_path = pack.nodes.ReferenceImage().load(buttons["path"])
    assert by_id[0].shape == by_path[0].shape and float((by_id[0] - by_path[0]).abs().max()) == 0
