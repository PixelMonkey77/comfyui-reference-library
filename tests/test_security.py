"""Request trust (DNS rebinding, cross-site, same-site, remote), trusted folders for the loader nodes,
no env-var / existence leaks in validation, local-only changes, names-only for remote, /file media-only."""
import asyncio
import json
import os

import pytest
from PIL import Image

from helpers import OTHER_PC, Req

run = asyncio.run
XS = {"Sec-Fetch-Site": "cross-site"}

TRUST_CASES = [
    ("browser on this PC", Req(), "local"),
    ("localhost name", Req(host="localhost:8188"), "local"),
    ("IPv6 loopback", Req(remote="::1", host="[::1]:8188"), "local"),
    ("DNS rebinding (evil domain -> 127.0.0.1)", Req(host="attacker.example:8188"), None),
    ("cross-site request", Req(headers=XS), None),
    ("another machine (--listen)", Req(OTHER_PC), "remote"),
    ("other machine, cross-site", Req(OTHER_PC, headers=XS), None),
    ("same-origin fetch", Req(headers={"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8188"}), "local"),
    ("typed address / bookmark", Req(headers={"Sec-Fetch-Site": "none"}), "local"),
    ("same-site: page on another localhost port",
     Req(host="localhost:8188", headers={"Sec-Fetch-Site": "same-site", "Origin": "http://localhost:3000"}), None),
    ("same-site without Origin (GET from another port)", Req(host="localhost:8188", headers={"Sec-Fetch-Site": "same-site"}), None),
    ("Origin on another port, no Sec-Fetch-Site (old browser)", Req(host="localhost:8188", headers={"Origin": "http://localhost:3000"}), None),
    ("Origin: null (sandboxed page)", Req(headers={"Origin": "null"}), None),
    ("Origin differs only in case", Req(host="localhost:8188", headers={"Origin": "http://LOCALHOST:8188"}), "local"),
    ("other machine, same-origin",
     Req(OTHER_PC, headers={"Sec-Fetch-Site": "same-origin", "Origin": "http://192.168.1.5:8188"}), "remote"),
    ("other machine, other port's page",
     Req(OTHER_PC, headers={"Sec-Fetch-Site": "same-site", "Origin": "http://192.168.1.5:3000"}), None),
]


@pytest.mark.parametrize("req, want", [c[1:] for c in TRUST_CASES], ids=[c[0] for c in TRUST_CASES])
def test_request_trust(pack, req, want):
    assert pack._trust(req) == want


# ---------------------------------------------------------------- routes under the guard

def test_dialog_route(pack, img, monkeypatch):
    monkeypatch.setattr(pack, "_open_file_dialog", lambda *a, **k: [img("Buttons.png")])
    pick = pack._guard(pack._pick, local=True)
    r = run(pick(Req(host="attacker.example:8188", body={"kinds": ["image"]})))
    assert r.status == 403 and "127.0.0.1" in r.text, "refused through DNS rebinding"
    assert run(pick(Req(body={"kinds": ["image"]}))).status == 200


def test_changes_only_from_this_pc(pack, img):
    r = run(pack._make(pack._add)(Req(body={"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}, {"path": img("Giftwood.png")}]})))
    assert r.status == 200
    lib = pack._load_library()["libraries"][0]
    asset = lib["assets"][0]["id"]
    for route, body in [(pack._rename, {"id": asset, "name": "X"}), (pack._remove, {"id": asset}),
                        (pack._lib_rename, {"id": lib["id"], "name": "Y"}), (pack._lib_delete, {"id": lib["id"]})]:
        assert run(pack._make(route)(Req(OTHER_PC, body=body))).status == 403, route.__name__


def test_library_list(pack):
    assets = pack._guard(pack._assets)
    r = run(assets(Req(OTHER_PC)))
    paths = [a["path"] for a in json.loads(r.text)["assets"]]
    assert r.status == 200 and paths and all(os.sep not in p and "/" not in p for p in paths), "another machine sees file names only"
    assert all(os.path.isabs(a["path"]) for a in json.loads(run(assets(Req())).text)["assets"]), "this PC sees full paths"
    assert run(assets(Req(host="attacker.example:8188"))).status == 403


# ---------------------------------------------------------------- trusted folders, validation leaks

def test_validation_does_not_leak(pack, scratch, monkeypatch):
    validate = pack.ReferenceImage.VALIDATE_INPUTS
    monkeypatch.setenv("FAKE_API_KEY", "sk-SECRET-123")
    assert "sk-SECRET" not in str(validate(r"C:\%FAKE_API_KEY%\x.png"))
    assert "sk-SECRET" not in str(validate(os.path.join(scratch, "$FAKE_API_KEY", "x.png")))

    # Wrong type: the same answer whether or not the file exists.
    other = os.path.join(scratch, "other")
    os.makedirs(other)
    open(os.path.join(other, "real.ini"), "w").close()
    a, b = validate(os.path.join(other, "real.ini")), validate(os.path.join(other, "nope.ini"))
    assert "not an image" in a and a.replace("real.ini", "X") == b.replace("nope.ini", "X")


def test_trusted_folders(pack, img, scratch):
    validate = pack.ReferenceImage.VALIDATE_INPUTS
    private = os.path.join(scratch, "private")
    os.makedirs(private)
    mine, missing = os.path.join(private, "me.png"), os.path.join(private, "missing.png")
    Image.new("RGB", (8, 8), "red").save(mine)

    # A folder never used with the library: the same message for an existing and a missing file.
    a, b = validate(mine), validate(missing)
    assert "hasn't been used" in a and a.replace("me.png", "X") == b.replace("missing.png", "X")
    with pytest.raises(ValueError, match="hasn't been used"):
        pack._load_check("image", mine)  # the loader refuses it too, not just validation

    assert validate(img("Buttons.png")) is True, "a folder holding library files is trusted"
    pack._trust_folders([mine])
    assert validate(mine) is True, "after a pick in that folder"
    assert "file not found" in validate(missing), "...and now a missing file says so"

    sub = os.path.join(private, "sub")
    os.makedirs(sub)
    Image.new("RGB", (8, 8)).save(os.path.join(sub, "x.png"))
    assert "hasn't been used" in validate(os.path.join(sub, "x.png")), "its subfolders aren't trusted by that"

    deep = os.path.join(pack.folder_paths_stub.get_input_directory(), "deep")
    os.makedirs(deep)
    Image.new("RGB", (8, 8)).save(os.path.join(deep, "y.png"))
    assert validate(os.path.join(deep, "y.png")) is True, "ComfyUI's input folder and its subfolders are trusted"

    saved = [os.path.normcase(f) for f in pack._load_library().get("trusted_folders", [])]
    assert os.path.normcase(os.path.abspath(private)) in saved and os.path.normcase(os.path.abspath(sub)) not in saved

    trusted = pack._guard(pack._trusted_route, local=True)
    assert json.loads(run(trusted(Req(query={"path": os.path.join(sub, "x.png")}))).text)["trusted"] is False
    assert run(trusted(Req(OTHER_PC, query={"path": "C:/x.png"}))).status == 403


# ---------------------------------------------------------------- /file

def test_file_route_serves_media_only(pack, scratch):
    f = pack._library_file()
    with open(f, encoding="utf-8") as fh:
        d = json.load(fh)
    page = os.path.join(scratch, "evil.html")
    with open(page, "w") as fh:
        fh.write("<script>alert(1)</script>")
    d["libraries"][0]["assets"].append({"id": "evil", "name": "evil", "path": page, "kind": "image"})
    with open(f, "w", encoding="utf-8") as fh:
        json.dump(d, fh)
    serve = pack._guard(pack._file)
    assert run(serve(Req(query={"id": "evil"}))).status == 404
    good = next(a for a in pack._load_library()["libraries"][0]["assets"] if a["path"].endswith(".png"))
    assert run(serve(Req(query={"id": good["id"]}))).headers.get("X-Content-Type-Options") == "nosniff"
