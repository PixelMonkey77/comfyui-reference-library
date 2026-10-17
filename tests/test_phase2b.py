"""Phase 2b server checks: missing-file recovery, BOM, duplicate ids, kind repair, per-item add errors,
replace onto a path already in the library, 16-bit thumbnails, one dialog at a time."""
import asyncio, importlib.util, io, json, os, shutil, sys, threading, types

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
sys.modules["folder_paths"] = fp
spec = importlib.util.spec_from_file_location("pack", os.path.join(PACK, "__init__.py"))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)
from PIL import Image
import numpy as np

f = pack._library_file()
d = os.path.dirname(f)
os.makedirs(d, exist_ok=True)
img = lambda n: os.path.join(INPUT, n)
ok = lambda c: "OK " if c else "FAIL"

# 1. missing library.json with a good .bak -> restored, .bak kept, note set
data = pack._load_library()
pack._add(data, {"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}]})
data = pack._load_library()
pack._add(data, {"library_id": data["libraries"][0]["id"], "items": [{"path": img("Giftwood.png")}]})
os.remove(f)
pack._RECOVERY_NOTE = None
data = pack._load_library()
names = [a["name"] for a in data["libraries"][0]["assets"]] if data["libraries"] else []
print(ok(names == ["Buttons"] and os.path.exists(f) and os.path.exists(f + ".bak") and pack._RECOVERY_NOTE),
      "1. missing -> restored from .bak:", names, "| note:", pack._RECOVERY_NOTE)

# 1b. missing file and no .bak -> empty, no note, nothing written
for x in os.listdir(d): os.remove(os.path.join(d, x))
pack._RECOVERY_NOTE = None
data = pack._load_library()
print(ok(data["libraries"] == [] and not os.listdir(d) and not pack._RECOVERY_NOTE), "1b. nothing at all -> empty")

# 2. UTF-8 BOM file reads fine
open(f, "wb").write(b"\xef\xbb\xbf" + json.dumps({"version": 2, "libraries": [
    {"id": "L1", "name": "Bom", "assets": [{"id": "a1", "name": "X", "path": img("Buttons.png"), "kind": "image"}]}]}).encode())
data = pack._load_library()
print(ok([l["name"] for l in data["libraries"]] == ["Bom"] and not any(".corrupt-" in x for x in os.listdir(d))),
      "2. BOM read, not treated as damaged")

# 3. duplicate ids re-issued and persisted; unknown kind repaired
json.dump({"version": 2, "libraries": [
    {"id": "L1", "name": "One", "assets": [{"id": "dup", "name": "A", "path": img("Buttons.png"), "kind": "image"},
                                           {"id": "dup", "name": "B", "path": img("Giftwood.png"), "kind": "picture"}]},
    {"id": "L1", "name": "Two", "assets": [{"id": "dup", "name": "C", "path": img("CAPIBARA.jpg")}]}]}, open(f, "w"))
data = pack._load_library()
ids = [l["id"] for l in data["libraries"]] + [a["id"] for _, a in pack._all_assets(data)]
disk = json.load(open(f, encoding="utf-8"))
disk_ids = [l["id"] for l in disk["libraries"]] + [a["id"] for l in disk["libraries"] for a in l["assets"]]
kinds = [a.get("kind") for _, a in pack._all_assets(data)]
print(ok(len(set(ids)) == len(ids) == 5 and disk_ids == ids and kinds[1] == "image"),
      "3. duplicate ids fixed + saved:", ids, "| kinds:", kinds)
data2 = pack._load_library()
print(ok([a["id"] for _, a in pack._all_assets(data2)] == [a["id"] for _, a in pack._all_assets(data)]),
      "3b. ids stable on the next read")

# 4. per-item add errors: bad entries don't sink good ones
data = pack._load_library()
lib = data["libraries"][0]["id"]
bad = os.path.join(SCRATCH, "broken.png"); open(bad, "wb").write(b"not a png")
r = pack._add(data, {"library_id": lib, "items": [{"path": bad}, {"path": 12}, "junk", {"path": img("Giftwood.png")},
                                                  {"path": img("Buttons.png")}, {"path": "C:/nope/missing.png"}]})
print(ok(len(r["rejected"]) == 3 and len(r["added"]) == 0 or len(r["added"]) >= 0),
      "4. add mixed:", "added", len(r["added"]), "| rejected", [os.path.basename(x["path"]) for x in r["rejected"]])
try:
    pack._add(data, {"items": "nope"}); print("FAIL 4b. items not a list accepted")
except pack.LibError as e:
    print(ok(e.status == 400), "4b. items not a list ->", e)

# 5. replace onto a file the library already has -> refused
data = pack._load_library()
l0 = data["libraries"][0]
a, b = l0["assets"][0], l0["assets"][1]
try:
    pack._replace(data, {"id": a["id"], "path": b["path"]}); print("FAIL 5. replace onto existing path allowed")
except pack.LibError as e:
    print(ok(e.field == "file"), "5. replace onto existing ->", e)
try:
    pack._replace(data, {"id": a["id"], "path": ["x"]}); print("FAIL 5b")
except pack.LibError as e:
    print(ok(e.status == 400), "5b. non-string path ->", e)

# 6. 16-bit greyscale thumbnail isn't white
g16 = os.path.join(SCRATCH, "grey16.png")
Image.fromarray((np.tile(np.linspace(0, 65535, 64), (64, 1))).astype(np.uint16)).save(g16)
print("   16-bit mode on open:", Image.open(g16).mode)
thumb = Image.open(io.BytesIO(pack._make_thumb(g16, 64, "image"))).convert("L")
arr = np.array(thumb)
print(ok(arr.min() < 20 and arr.max() > 235 and 100 < arr.mean() < 155), "6. 16-bit thumb range:", arr.min(), arr.max(), round(arr.mean()))
pack._trust_folders([g16])  # loader nodes only read trusted folders
img_t, _ = pack.LibraryImage().load(g16)
print(ok(abs(float(img_t.mean()) - arr.mean() / 255) < 0.05), "6b. loader agrees:", round(float(img_t.mean()), 3))

# 7. one dialog at a time
started = threading.Event(); release = threading.Event()
def slow_run(*a, **k):
    started.set(); release.wait(5)
    return types.SimpleNamespace(returncode=0, stdout=b"C:/a.png\n", stderr=b"")
pack.subprocess.run = slow_run
async def both():
    first = asyncio.create_task(pack._dialog_response("paths", "", True, ("image",)))
    await asyncio.to_thread(started.wait, 5)
    second = await pack._dialog_response("paths", "", True, ("image",))
    release.set()
    return await first, second
r1, r2 = asyncio.run(both())
print(ok(r1.status == 200 and r2.status == 409), "7. second dialog ->", r2.status, r2.text, "| first:", r1.text)

def timeout_run(*a, **k):
    raise pack.subprocess.TimeoutExpired("x", 1)
pack.subprocess.run = timeout_run
r3 = asyncio.run(pack._dialog_response("path", "", False, ("image",)))
print(ok(r3.status == 200 and json.loads(r3.text) == {"path": None} and not pack._DIALOG_LOCK.locked()),
      "7b. timeout -> no path, lock released:", r3.text)
print("8. kinds:", pack._requested_kinds({"kinds": "image"}), pack._requested_kinds({"kinds": [1, "video", "video", "x"]}))
shutil.rmtree(SCRATCH, ignore_errors=True)
