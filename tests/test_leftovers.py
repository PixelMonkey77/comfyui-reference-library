"""Leftovers (server): path expansion, relative paths, NFC names, name folding, cross-process lock,
thumbnail de-dup, dialog failure reporting."""
import asyncio, importlib.util, os, shutil, subprocess, sys, threading, time, types, unicodedata

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
img = lambda n: os.path.join(INPUT, n)

# 1. paths
os.environ["LI_TEST_DIR"] = r"D:\Pics"
print(ok(pack._clean_path(r"D:\work\$dollar\a.png") == r"D:\work\$dollar\a.png"), "1a. $NAME left alone:", pack._clean_path(r"D:\work\$dollar\a.png"))
print(ok("%LI_TEST_DIR%" in pack._clean_path(r"%LI_TEST_DIR%\a.png")), "1b. %VAR% not expanded (security round 3):", pack._clean_path(r"%LI_TEST_DIR%\a.png"))
print(ok(pack._clean_path('"D:\\x\\y.png"') == r"D:\x\y.png"), "1c. quotes from Copy as path removed")
try:
    pack._checked_file("pics/cat.png"); print("FAIL 1d. relative path accepted")
except pack.LibError as e:
    print(ok("full path" in str(e)), "1d. relative path ->", e)
print(ok("full path" in str(pack._validate("image", "cat.png", ""))), "1e. node validation:", pack._validate("image", "cat.png", ""))

# 2. names
decomposed = unicodedata.normalize("NFD", "Café_Noël")
print(ok(pack._tag_name(decomposed) == "Café_Noël"), "2a. decomposed accents stay one word:", pack._tag_name(decomposed))
print(ok(pack._tag_name("-") == "asset" and pack._tag_name("--x--") == "x" and pack._tag_name("my-cat") == "my-cat"),
      "2b. '-' alone isn't a name:", pack._tag_name("-"), pack._tag_name("--x--"), pack._tag_name("my-cat"))
print(ok(pack._fold("Straße") != pack._fold("STRASSE") and pack._fold("ÉCOLE") == pack._fold("école")),
      "2c. names compared like the browser (ß != SS, É == é)")

# 3. cross-process lock: another process holds library.json.lock -> a change waits, then proceeds
lockpath = pack._library_file() + ".lock"
os.makedirs(os.path.dirname(lockpath), exist_ok=True)
holder = subprocess.Popen([sys.executable, "-c", f"""
import msvcrt, time
f = open(r"{lockpath}", "a+b"); f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
print("held", flush=True); time.sleep(1.5); f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
"""], stdout=subprocess.PIPE, text=True)
holder.stdout.readline()
add = pack._make(pack._add)
class Req:
    remote = "127.0.0.1"
    host = "127.0.0.1:8188"
    headers = {}
    def __init__(self, body): self.b = body
    async def json(self): return self.b
t = time.perf_counter()
r = asyncio.run(add(Req({"new_library": "Lib_A", "items": [{"path": img("Buttons.png")}]})))
waited = time.perf_counter() - t
holder.wait()
print(ok(r.status == 200 and 1.0 < waited < 5), f"3. change waited {waited:.2f} s for the other process, then saved ({r.status})")

# 4. thumbnail de-dup: 6 simultaneous requests for a new file -> generated once
calls = {"n": 0}
real = pack._make_thumb
def slow(path, size, kind):
    calls["n"] += 1
    time.sleep(0.3)
    return real(path, size, kind)
pack._make_thumb = slow
st = os.stat(img("Giftwood.png"))
threads = [threading.Thread(target=pack._sized_thumb, args=(img("Giftwood.png"), st, "image", 96)) for _ in range(6)]
[t.start() for t in threads]; [t.join() for t in threads]
print(ok(calls["n"] == 1 and not pack._MASTER_LOCKS), f"4. 6 simultaneous requests -> generated {calls['n']}x, no locks left over")

# 5. dialog helper failure is reported, not silent
pack.subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"boom: STA thread\nAccess denied")
r = asyncio.run(pack._dialog_response("paths", "", True, ("image",)))
print(ok(r.status == 500 and "Access denied" in r.text and not pack._DIALOG_LOCK.locked()), "5. dialog failure ->", r.status, r.text)
shutil.rmtree(SCRATCH, ignore_errors=True)
