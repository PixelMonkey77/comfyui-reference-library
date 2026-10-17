"""Round 3 security fixes: request trust (DNS rebinding, cross-site, remote), trusted folders for the
loader nodes, no env-var / existence leaks in validation, local-only changes, names-only for remote,
/file media-only + nosniff."""
import asyncio, importlib.util, json, os, shutil, sys, types

PACK, COMFY, SCRATCH, INPUT = sys.argv[1:5]
sys.path.insert(0, COMFY)
shutil.rmtree(SCRATCH, ignore_errors=True)

class _Routes:
    def __getattr__(self, _):
        return lambda *a, **k: (lambda f: f)
server = types.ModuleType("server")
server.PromptServer = type("PS", (), {"instance": type("I", (), {"routes": _Routes()})()})
sys.modules["server"] = server
fp = types.ModuleType("folder_paths")
fp.get_user_directory = lambda: SCRATCH
fp.get_input_directory = lambda: os.path.join(SCRATCH, "comfy_input")
fp.get_output_directory = lambda: os.path.join(SCRATCH, "comfy_output")
sys.modules["folder_paths"] = fp
spec = importlib.util.spec_from_file_location("pack", os.path.join(PACK, "__init__.py"))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)
from PIL import Image
ok = lambda c: "OK " if c else "FAIL"
img = lambda n: os.path.join(INPUT, n)

class Req:
    def __init__(self, remote="127.0.0.1", host="127.0.0.1:8188", headers=None, body=None, query=None):
        self.remote, self.host, self.headers = remote, host, headers or {}
        self._body, self.query = body or {}, query or {}
    async def json(self):
        return self._body

# 1. request trust
cases = [
    ("browser on this PC", Req(), "local"),
    ("localhost name", Req(host="localhost:8188"), "local"),
    ("IPv6 loopback", Req(remote="::1", host="[::1]:8188"), "local"),
    ("DNS rebinding (evil domain -> 127.0.0.1)", Req(host="attacker.example:8188"), None),
    ("cross-site request", Req(headers={"Sec-Fetch-Site": "cross-site"}), None),
    ("another machine (--listen)", Req(remote="192.168.1.20", host="192.168.1.5:8188"), "remote"),
    ("other machine, cross-site", Req(remote="192.168.1.20", host="192.168.1.5:8188", headers={"Sec-Fetch-Site": "cross-site"}), None),
]
for label, req, want in cases:
    got = pack._trust(req)
    print(ok(got == want), f"1. {label}: {got}")

# 2. routes under the guard
pack._open_file_dialog = lambda *a, **k: [img("Buttons.png")]
pick = pack._guard(pack._pick, local=True)
r = asyncio.run(pick(Req(host="attacker.example:8188", body={"kinds": ["image"]})))
print(ok(r.status == 403 and "127.0.0.1" in r.text), "2a. dialog via DNS rebinding refused:", r.status)
r = asyncio.run(pick(Req(body={"kinds": ["image"]})))
print(ok(r.status == 200), "2b. dialog from this PC:", r.status)
add = pack._make(pack._add)
r = asyncio.run(add(Req(body={"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}, {"path": img("Giftwood.png")}]})))
print(ok(r.status == 200), "2c. add from this PC:", r.status)
lib = pack._load_library()["libraries"][0]
for route, body in [(pack._rename, {"id": lib["assets"][0]["id"], "name": "X"}), (pack._remove, {"id": lib["assets"][0]["id"]}),
                    (pack._lib_rename, {"id": lib["id"], "name": "Y"}), (pack._lib_delete, {"id": lib["id"]})]:
    r = asyncio.run(pack._make(route)(Req(remote="192.168.1.20", host="192.168.1.5:8188", body=body)))
    print(ok(r.status == 403), f"2d. {route.__name__} from another machine: {r.status}")
assets = pack._guard(pack._assets)
r = asyncio.run(assets(Req(remote="192.168.1.20", host="192.168.1.5:8188")))
paths = [a["path"] for a in json.loads(r.text)["assets"]]
print(ok(r.status == 200 and paths and all(os.sep not in p and "/" not in p for p in paths)), "2e. remote sees file names only:", paths)
r = asyncio.run(assets(Req()))
print(ok(all(os.path.isabs(a["path"]) for a in json.loads(r.text)["assets"])), "2f. this PC sees full paths")
r = asyncio.run(assets(Req(host="attacker.example:8188")))
print(ok(r.status == 403), "2g. library list via DNS rebinding refused:", r.status)

# 3. trusted folders + validation leaks
os.environ["FAKE_API_KEY"] = "sk-SECRET-123"
v = pack.LibraryImage.VALIDATE_INPUTS(r"C:\%FAKE_API_KEY%\x.png")
print(ok("sk-SECRET" not in str(v)), "3a. no env-var leak:", v[:110])
a = pack.LibraryImage.VALIDATE_INPUTS(r"C:\Windows\win.ini")
b = pack.LibraryImage.VALIDATE_INPUTS(r"C:\Windows\nope.ini")
print(ok(a.replace("win.ini", "X") == b.replace("nope.ini", "X") and "not an image" in a), "3b. wrong type: same answer whether it exists:", a)
secret_dir = os.path.join(SCRATCH, "private"); os.makedirs(secret_dir)
Image.new("RGB", (8, 8), "red").save(os.path.join(secret_dir, "me.png"))
a = pack.LibraryImage.VALIDATE_INPUTS(os.path.join(secret_dir, "me.png"))
b = pack.LibraryImage.VALIDATE_INPUTS(os.path.join(secret_dir, "missing.png"))
print(ok("hasn't been used" in a and a.replace("me.png", "X") == b.replace("missing.png", "X")),
      "3c. untrusted folder: same message for an existing and a missing file:", a[:120])
try:
    pack.LibraryImage().load(os.path.join(secret_dir, "me.png")); print("FAIL 3d. loaded an untrusted file")
except ValueError as e:
    print(ok("hasn't been used" in str(e)), "3d. load() refuses it too")
print(ok(pack.LibraryImage.VALIDATE_INPUTS(img("Buttons.png")) is True), "3e. folder holding library files is trusted")
pack._trust_folders([os.path.join(secret_dir, "me.png")])
print(ok(pack.LibraryImage.VALIDATE_INPUTS(os.path.join(secret_dir, "me.png")) is True), "3f. after a pick in that folder: trusted")
print(ok("file not found" in pack.LibraryImage.VALIDATE_INPUTS(os.path.join(secret_dir, "missing.png"))), "3g. ...and now a missing file says so")
sub = os.path.join(secret_dir, "sub"); os.makedirs(sub); Image.new("RGB", (8, 8)).save(os.path.join(sub, "x.png"))
print(ok("hasn't been used" in pack.LibraryImage.VALIDATE_INPUTS(os.path.join(sub, "x.png"))), "3h. its subfolders aren't trusted by that")
inp = fp.get_input_directory(); os.makedirs(os.path.join(inp, "deep"))
Image.new("RGB", (8, 8)).save(os.path.join(inp, "deep", "y.png"))
print(ok(pack.LibraryImage.VALIDATE_INPUTS(os.path.join(inp, "deep", "y.png")) is True), "3i. ComfyUI input folder (and subfolders) trusted")
saved = [os.path.normcase(f) for f in pack._load_library().get("trusted_folders", [])]
print(ok(os.path.normcase(os.path.abspath(secret_dir)) in saved and os.path.normcase(os.path.abspath(sub)) not in saved), "3j. trusted folders saved in library.json:", pack._load_library().get("trusted_folders"))
r = asyncio.run(pack._guard(pack._trusted_route, local=True)(Req(query={"path": os.path.join(sub, "x.png")})))
print(ok(json.loads(r.text)["trusted"] is False), "3k. /trusted for the node UI:", r.text[:60])
r = asyncio.run(pack._guard(pack._trusted_route, local=True)(Req(remote="192.168.1.20", host="192.168.1.5:8188", query={"path": "C:/x.png"})))
print(ok(r.status == 403), "3l. /trusted from another machine refused:", r.status)

# 4. /file serves media only, with nosniff
f = pack._library_file()
d = json.load(open(f, encoding="utf-8"))
page = os.path.join(SCRATCH, "evil.html"); open(page, "w").write("<script>alert(1)</script>")
d["libraries"][0]["assets"].append({"id": "evil", "name": "evil", "path": page, "kind": "image"})
json.dump(d, open(f, "w", encoding="utf-8"))
r = asyncio.run(pack._guard(pack._file)(Req(query={"id": "evil"})))
print(ok(r.status == 404), "4a. /file refuses a non-media entry:", r.status)
good = next(a for a in pack._load_library()["libraries"][0]["assets"] if a["path"].endswith(".png"))
r = asyncio.run(pack._guard(pack._file)(Req(query={"id": good["id"]})))
print(ok(r.headers.get("X-Content-Type-Options") == "nosniff"), "4b. media served with nosniff")
shutil.rmtree(SCRATCH, ignore_errors=True)
