"""Phase 5 (R2-12) checks: parsed-library cache, probes outside the lock, payload outside the lock, timing."""
import asyncio, importlib.util, json, os, shutil, sys, threading, time, types

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
ok = lambda c: "OK " if c else "FAIL"
f = pack._library_file()
os.makedirs(os.path.dirname(f), exist_ok=True)
img = lambda n: os.path.join(INPUT, n)

# count real parses
parses = {"n": 0}
real_read = pack._read_library_file
def counting(path):
    parses["n"] += 1
    return real_read(path)
pack._read_library_file = counting

data = pack._load_library()
pack._add(data, {"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}, {"path": img("Giftwood.png")}]})
parses["n"] = 0
a = pack._load_library(); b = pack._load_library()
print(ok(parses["n"] == 0), "1. after a save, reads come from the cache (parses:", parses["n"], ")")
a["libraries"][0]["name"] = "MUTATED"; a["libraries"][0]["assets"].clear()
c = pack._load_library()
print(ok(c["libraries"][0]["name"] == "Lib_A" and len(c["libraries"][0]["assets"]) == 2), "2. a caller's changes never reach the cache")

# external edit is picked up
time.sleep(0.05)
disk = json.load(open(f, encoding="utf-8")); disk["libraries"][0]["name"] = "Edited_By_Hand"
json.dump(disk, open(f, "w", encoding="utf-8"))
d = pack._load_library()
print(ok(d["libraries"][0]["name"] == "Edited_By_Hand" and parses["n"] == 1), "3. edited outside ComfyUI -> re-read:", d["libraries"][0]["name"])

# a request that fails half-way leaves the library untouched
try:
    def bad(data, body):
        data["libraries"][0]["name"] = "HALF"
        raise pack.LibError("boom")
    with pack._LIB_LOCK:
        x = pack._load_library(); bad(x, {})
except pack.LibError:
    pass
print(ok(pack._load_library()["libraries"][0]["name"] == "Edited_By_Hand"), "4. failed change doesn't stick")

# probes happen before the lock: _add with probes does no probing itself
probe_calls = {"n": 0}
real_probe = pack._probe
def counting_probe(path, kind):
    probe_calls["n"] += 1
    return real_probe(path, kind)
pack._probe = counting_probe
items = [{"path": img("CAPIBARA.jpg")}, {"path": img("Biscuit.png")}]
probes = pack._probe_all([i["path"] for i in items])
before = probe_calls["n"]
lock_held_probe = {"n": 0}
data = pack._load_library()
r = pack._add(data, {"library_id": data["libraries"][0]["id"], "items": items}, probes)
print(ok(before == 2 and probe_calls["n"] == 2 and len(r["added"]) == 2), "5. add uses the pre-probed files (probes total:", probe_calls["n"], ")")
bad_probe = pack._probe_all(["C:/nope/x.png"])
data = pack._load_library()
r = pack._add(data, {"library_id": data["libraries"][0]["id"], "items": [{"path": "C:/nope/x.png"}, {"path": img("Buttons.png")}]}, bad_probe)
print(ok(len(r["rejected"]) == 2), "5b. pre-probe errors reported per file:", [x["error"][:40] for x in r["rejected"]])

# the lock is free while the response checks files on disk
statted_with_lock = []
real_view = pack._asset_view
def view(lib, a):
    statted_with_lock.append(pack._LIB_LOCK.locked())
    return real_view(lib, a)
pack._asset_view = view
resp = asyncio.run(pack._read_library())
print(ok(resp.status == 200 and statted_with_lock and not any(statted_with_lock)), "6. file checks run after the lock is released")
pack._asset_view = real_view

# timing with a 1000-asset library
big = {"version": 2, "libraries": [{"id": f"L{k}", "name": f"Lib_{k}", "assets": [
    {"id": f"a{k}_{i}", "name": f"n{k}_{i}", "path": img("Buttons.png") if i % 2 else f"C:/missing/{i}.png", "kind": "image"}
    for i in range(250)]} for k in range(4)]}
pack._save_library(big)
pack._CACHE.update(key=None, data=None)
t = time.perf_counter(); pack._load_library(); cold = time.perf_counter() - t
t = time.perf_counter()
for _ in range(20): pack._load_library()
warm = (time.perf_counter() - t) / 20
t = time.perf_counter(); asyncio.run(pack._read_library()); full = time.perf_counter() - t
t = time.perf_counter()
for _ in range(20): pack._find_asset("a3_249")
find = (time.perf_counter() - t) / 20
print(f"7. 1000 assets: first read {cold*1000:.1f} ms, cached read {warm*1000:.1f} ms, full /assets response {full*1000:.0f} ms, thumbnail lookup {find*1000:.1f} ms")
shutil.rmtree(SCRATCH, ignore_errors=True)
