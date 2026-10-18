"""Phase 1 checks: damaged file recovery, locked-file retry, random ids, malformed entries."""
import importlib.util, json, os, sys, types

PACK, COMFY, SCRATCH, INPUT = sys.argv[1:5]
sys.path.insert(0, COMFY)

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
pack._CACHE_DIR = os.path.join(SCRATCH, "cache")  # not the repo's own .cache

f = pack._library_file()
d = os.path.dirname(f)
os.makedirs(d, exist_ok=True)
img = lambda n: os.path.join(INPUT, n)
listdir = lambda: sorted(x for x in os.listdir(d))

# 1. two saves -> .bak holds the previous good version
data = pack._load_library()
pack._add(data, {"new_library": "Lib A", "items": [{"path": img("Buttons.png")}]})
data = pack._load_library()
pack._add(data, {"library_id": data["libraries"][0]["id"], "items": [{"path": img("Giftwood.png")}]})
bak = json.load(open(f + ".bak", encoding="utf-8"))
print("1. files:", listdir(), "| bak assets:", [a["name"] for a in bak["libraries"][0]["assets"]])

# 2. damage the file -> recovered from .bak, damaged copy kept, warning set
open(f, "w", encoding="utf-8").write('{"version": 2, "libraries": [ {"id": "x", "name": "Lib_A", "assets": [ TRUNCATED')
data = pack._load_library()
print("2. recovered:", [(l["name"], [a["name"] for a in l["assets"]]) for l in data["libraries"]],
      "| corrupt kept:", any(x.startswith("library.json.corrupt-") for x in listdir()),
      "| note:", (pack._RECOVERY_NOTE or "")[:60])
body = pack._library_payload(data)
print("   warning sent once:", "warning" in body, "then:", "warning" in pack._library_payload(data))

# 3. damaged file and no backup -> empty library, but nothing deleted
for x in listdir():
    if x.endswith(".bak"): os.remove(os.path.join(d, x))
open(f, "w", encoding="utf-8").write("not json at all")
data = pack._load_library()
print("3. no backup:", data["libraries"], "| corrupt copies:", sum(x.startswith("library.json.corrupt-") for x in listdir()))

# 4. ids are random: replace then re-add the original path gives a different id
data = pack._load_library()
pack._add(data, {"new_library": "Lib B", "items": [{"path": img("Buttons.png")}]})
data = pack._load_library(); lib = data["libraries"][0]; a1 = lib["assets"][0]["id"]
pack._replace(data, {"id": a1, "path": img("CAPIBARA.jpg"), "name": "Capy"})
data = pack._load_library(); lib = data["libraries"][0]
pack._add(data, {"library_id": lib["id"], "items": [{"path": img("Buttons.png")}]})
ids = [a["id"] for a in pack._load_library()["libraries"][0]["assets"]]
print("4. ids:", ids, "| unique:", len(ids) == len(set(ids)))

# 5. malformed entries are dropped instead of crashing
json.dump({"version": 2, "libraries": [{"id": "L", "name": "Lib_C", "assets": [{"id": "ok1", "name": "Fine", "path": "C:/x.png"}, {"name": "no id"}, "junk"]}, {"name": "no id lib"}]}, open(f, "w"))
print("5. normalized:", [(l["name"], [a["name"] for a in l["assets"]]) for l in pack._load_library()["libraries"]])

# 6. a locked file during save is retried (simulate one PermissionError)
real = os.replace; calls = {"n": 0}
def flaky(a, b):
    calls["n"] += 1
    if calls["n"] == 1: raise PermissionError("locked")
    return real(a, b)
pack.os.replace = flaky
pack._save_library({"version": 2, "libraries": []})
pack.os.replace = real
print("6. retried save ok:", calls["n"] == 2, "| leftover tmp files:", [x for x in listdir() if x.endswith(".tmp")])
