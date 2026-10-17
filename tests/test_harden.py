"""Phase 5b server checks: local-only routes, thumbnail disk cache + sizes, oversized images, damaged-entry note."""
import asyncio, importlib.util, io, json, os, shutil, sys, time, types

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
ok = lambda c: "OK " if c else "FAIL"
img = lambda n: os.path.join(INPUT, n)

class Req:
    def __init__(self, remote, body=None, query=None):
        self.remote, self._body, self.query = remote, body or {}, query or {}
        self.headers = {}
        self.host = "127.0.0.1:8188" if remote in ("127.0.0.1", "::1", "::ffff:127.0.0.1") else "192.168.1.5:8188"
    async def json(self):
        return self._body

# 1. local-only
pack._open_file_dialog = lambda *a, **k: ["C:/x.png"]
for remote, want in [("127.0.0.1", 200), ("::1", 200), ("::ffff:127.0.0.1", 200), ("192.168.1.20", 403)]:
    r = asyncio.run(pack._guard(pack._pick, local=True)(Req(remote, {"kinds": ["image"]})))
    print(ok(r.status == want), f"1. /pick from {remote}: {r.status}")
r = asyncio.run(pack._guard(pack._browse, local=True)(Req("10.0.0.5", {})))
print(ok(r.status == 403), "1b. /browse from another machine:", r.status, r.text)
add = pack._make(pack._add)
r = asyncio.run(add(Req("10.0.0.5", {"new_library": "X", "items": [{"path": img("Buttons.png")}]})))
print(ok(r.status == 403), "1c. /add from another machine:", r.status)
r = asyncio.run(add(Req("127.0.0.1", {"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}, {"path": img("Giftwood.png")}]})))
print(ok(r.status == 200), "1d. /add locally:", r.status)
ren = pack._make(pack._rename)
aid = pack._load_library()["libraries"][0]["assets"][0]["id"]
r = asyncio.run(ren(Req("10.0.0.5", {"id": aid, "name": "Renamed"})))
print(ok(r.status == 403), "1e. rename from another machine refused (all changes are local-only now):", r.status)
r = asyncio.run(pack._assets(Req("10.0.0.5")))
print(ok(r.status == 200), "1f. viewing the library from another machine:", r.status)

# 2. thumbnails: master on disk, sizes derived, survives a "restart" (memory cache cleared)
t = time.perf_counter(); r = asyncio.run(pack._thumb(Req("127.0.0.1", query={"id": aid, "s": "96"}))); first = time.perf_counter() - t
files = os.listdir(pack._thumb_dir())
w = Image.open(io.BytesIO(r.body)).size
pack._THUMBS.clear()
t = time.perf_counter(); r2 = asyncio.run(pack._thumb(Req("127.0.0.1", query={"id": aid, "s": "256"}))); second = time.perf_counter() - t
w2 = Image.open(io.BytesIO(r2.body)).size
print(ok(r.status == 200 and len(files) == 1 and max(w) == 96 and max(w2) == 256 and second < first),
      f"2. master cached on disk ({len(files)} file); 96 px -> {w}, after restart 256 px -> {w2}; {first*1000:.0f} ms then {second*1000:.0f} ms")

# 3. oversized image -> 415 placeholder, not a crash
big = os.path.join(SCRATCH, "huge.png")
Image.new("L", (9000, 8000)).save(big, optimize=False)
d = pack._load_library(); lib = d["libraries"][0]["id"]
rr = asyncio.run(add(Req("127.0.0.1", {"library_id": lib, "items": [{"path": big}]}))); print("   add big:", rr.status, rr.text[:300] if rr.status != 200 else json.loads(rr.text).get("rejected"))
bid = next(a["id"] for _, a in pack._all_assets(pack._load_library()) if os.path.normcase(a["path"]) == os.path.normcase(os.path.abspath(big)))
r = asyncio.run(pack._thumb(Req("127.0.0.1", query={"id": bid, "s": "96"})))
print(ok(r.status == 415), "3. 9000x8000 image thumbnail ->", r.status)

# 4. damaged entries -> note
f = pack._library_file()
raw = json.load(open(f, encoding="utf-8"))
raw["libraries"][0]["assets"].append({"name": "no id"}); raw["libraries"].append("junk")
json.dump(raw, open(f, "w", encoding="utf-8"))
pack._RECOVERY_NOTE = None
pack._load_library()
print(ok(pack._RECOVERY_NOTE and "2 damaged entries" in pack._RECOVERY_NOTE), "4. note:", pack._RECOVERY_NOTE)

# 5. save retries give up after ~1 s
real = os.replace
def locked(a, b):
    if a.endswith(".tmp") and not a.endswith(".bak.tmp") and ".bak." not in a:
        raise PermissionError("locked")
    return real(a, b)
pack.os.replace = locked
t = time.perf_counter()
try:
    pack._save_library({"version": 2, "libraries": []})
except PermissionError:
    pass
pack.os.replace = real
print(ok(time.perf_counter() - t < 1.5), f"5. a locked file gives up after {time.perf_counter() - t:.2f} s")
shutil.rmtree(SCRATCH, ignore_errors=True)
