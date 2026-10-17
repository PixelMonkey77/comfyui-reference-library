#!/usr/bin/env node
// Makes the walkthrough screenshots for the README: starts a throwaway ComfyUI (own temp folder,
// only this pack loaded, straight from this repo), drives headless Chrome through the Tagged Prompt
// flows with a demo library built from a resources folder, draws the callouts, saves PNGs.
// No dependencies: Node 22+ (built-in WebSocket) and an installed Chrome.
//
//   node tools/screenshots/make_screenshots.mjs [--out DIR] [--resources DIR] [--keep] [--show]
//
// Defaults: --out "<repo>/docs/images" (shown in the README), --resources "<repo>/../Resources". Paths to ComfyUI,
// its Python and Chrome are detected for ComfyUI Desktop on Windows; override with the env vars
// COMFYUI_DIR, COMFYUI_PYTHON, COMFYUI_FRONTEND, CHROME. --keep leaves the temp folder (logs),
// --show runs Chrome with a window.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const OUT = path.resolve(opt("out", path.join(REPO, "docs", "images")));
const RES = path.resolve(opt("resources", path.join(REPO, "..", "Resources")));
const PORT = Number(opt("port", 8190));
const CDP_PORT = PORT + 1000;
const LOCAL = process.env.LOCALAPPDATA ?? "";
const COMFY = process.env.COMFYUI_DIR ?? path.join(LOCAL, "Programs", "@comfyorgcomfyui-electron", "resources", "ComfyUI");
const PYTHON = process.env.COMFYUI_PYTHON ?? path.join(os.homedir(), "Documents", "ComfyUI", ".venv", "Scripts", "python.exe");
const FRONTEND = process.env.COMFYUI_FRONTEND ?? path.join(COMFY, "web_custom_versions", "desktop_app");
const CHROME = process.env.CHROME ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
  .find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[screens]", ...a);

// ---------------------------------------------------------------- the demo files
const files = (sub) => {
  const dir = path.join(RES, sub);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => path.join(dir, f)) : [];
};
const CHARACTERS = files("Characters");
const ENVIRONMENTS = files("Environments");
const ICONS = files("Icons");
const pickFile = (list, stemName) => list.find((p) => path.parse(p).name.toLowerCase() === stemName.toLowerCase()) ?? list[0];

// ---------------------------------------------------------------- temp ComfyUI
function prepareBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "library-image-screens-"));
  const pack = path.join(base, "custom_nodes", "comfyui-library-image");
  fs.mkdirSync(pack, { recursive: true });
  fs.copyFileSync(path.join(REPO, "__init__.py"), path.join(pack, "__init__.py"));
  fs.cpSync(path.join(REPO, "web"), path.join(pack, "web"), { recursive: true });
  for (const d of ["input", "output", "temp", path.join("user", "default")]) fs.mkdirSync(path.join(base, d), { recursive: true });
  // A file outside the library for the Load Image step (a copy, under a name the library doesn't use).
  const outside = pickFile(ENVIRONMENTS, "Cursed_Forest");
  if (outside) fs.copyFileSync(outside, path.join(base, "input", "Night_Forest.png"));
  // A clean, quiet UI: Nodes 2.0, dark theme, no first-run popups, no spellcheck squiggles.
  fs.writeFileSync(path.join(base, "user", "default", "comfy.settings.json"), JSON.stringify({
    "Comfy.VueNodes.Enabled": true, "Comfy.VueNodes.AutoScaleLayout": false, "Comfy.ColorPalette": "dark",
    "Comfy.UseNewMenu": "Top", "Comfy.TutorialCompleted": true, "Comfy.Release.Status": "what's new seen",
    "Comfy.Minimap.Visible": false, "Comfy.RightSidePanel.IsOpen": false, "Comfy.TextareaWidget.Spellcheck": false,
    "Comfy.NodeBadge.NodeIdBadgeMode": "None", "Comfy.PartnerNodesEducation.Dismissed": true,
    "Comfy.OnboardingCoachmarks.Seen": ["appMode"], "Comfy.Workflow.ShowMissingModelsWarning": false,
    "Comfy.Toast.DisableReconnectingToast": true,
  }, null, 2));
  // Answers for the "native file dialog", in the order the flows open it.
  const answers = [
    CHARACTERS, // first library: several files at once
    [pickFile(ENVIRONMENTS, "Ancient_Temple")], // one file, named in the dialog
  ];
  const fake = path.join(base, "fake_dialog.json");
  fs.writeFileSync(fake, JSON.stringify(answers));
  return { base, fake };
}

async function startComfy(base, fake) {
  const logFile = fs.openSync(path.join(base, "comfy.log"), "w");
  const proc = spawn(PYTHON, [path.join(COMFY, "main.py"), "--base-directory", base, "--port", String(PORT),
    "--listen", "127.0.0.1", "--cpu", "--disable-auto-launch", "--disable-all-custom-nodes",
    "--whitelist-custom-nodes", "comfyui-library-image", "--front-end-root", FRONTEND], {
    cwd: COMFY, env: { ...process.env, LIBRARY_IMAGE_FAKE_DIALOG: fake }, stdio: ["ignore", logFile, logFile],
    windowsHide: true,
  });
  for (let i = 0; i < 240; i++) {
    if (proc.exitCode != null) throw new Error(`ComfyUI exited (${proc.exitCode}); see ${path.join(base, "comfy.log")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/object_info/TaggedPrompt`);
      if (r.ok && Object.keys(await r.json()).length) return proc;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("ComfyUI didn't start within 2 minutes");
}

// ---------------------------------------------------------------- Chrome over the DevTools protocol
async function startChrome(base) {
  const proc = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(base, "chrome")}`,
    ...(flag("show") ? [] : ["--headless=new"]), "--no-first-run", "--no-default-browser-check",
    "--window-size=1500,1000", "--hide-scrollbars", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return { proc, ws: page.webSocketDebuggerUrl };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome didn't start");
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    };
  }
  open() {
    return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
}

let cdp;
async function ev(fnOrExpr, ...fnArgs) {
  const expression = typeof fnOrExpr === "function" ? `(${fnOrExpr})(...${JSON.stringify(fnArgs)})` : fnOrExpr;
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const mouse = async (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
async function hover(target) {
  const p = await center(target);
  await mouse("mouseMoved", p.x, p.y);
  return p;
}
async function click(target) {
  const p = await hover(target);
  await mouse("mousePressed", p.x, p.y);
  await mouse("mouseReleased", p.x, p.y);
  await sleep(250);
}
async function center(target) {
  const r = await ev((t) => window.__shot.rect(t), target);
  if (!r) throw new Error(`not found: ${JSON.stringify(target)}`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
const type = (text) => cdp.send("Input.insertText", { text });
const KEYS = { Enter: 13, Escape: 27, a: 65 };
async function key(k, modifiers = 0) {
  const base = { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: KEYS[k], modifiers };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(150);
}

// ---------------------------------------------------------------- in-page helpers
// window.__shot: element lookup (selector + optional text), callouts, and the clip to capture.
const PAGE_HELPERS = String.raw`
window.__shot = {
  nodeSel: ".lg-node",
  sels: {}, // more named nodes: "{li}" etc.
  el(t) {
    if (!t) return null;
    const sel = t.sel.replaceAll("{node}", this.nodeSel).replace(/\{(\w+)\}/g, (all, k) => this.sels[k] ?? all);
    const list = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden");
    return (t.text ? list.find((e) => e.textContent.trim().startsWith(t.text)) : list[t.index ?? 0]) ?? null;
  },
  rect(t) {
    const r = t?.rect ?? this.el(t)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  },
  layer() {
    let l = document.getElementById("shot-notes");
    if (!l) {
      l = Object.assign(document.createElement("div"), { id: "shot-notes" });
      l.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
      l.innerHTML = '<svg width="100%" height="100%" style="position:absolute;inset:0;overflow:visible"><defs>'
        + '<marker id="shot-head" markerWidth="12" markerHeight="12" refX="9" refY="6" orient="auto">'
        + '<path d="M1,1 L10,6 L1,11" fill="none" stroke="#f5a524" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs></svg>';
      document.body.append(l);
    }
    return l;
  },
  clear() { document.getElementById("shot-notes")?.remove(); },
  /** A callout: label at (dx, dy) from the target's edge on "side", with a curved arrow to the target. */
  note({ target, text, side = "right", dx = 70, dy = 0, color = "#f5a524", size = 24, from = null, bend = 28 }) {
    const r = this.rect(target);
    const f = this.rect(from) ?? r; // the label is placed beyond this element's edge (default: the target)
    if (!r) throw new Error("note target not found: " + JSON.stringify(target));
    const l = this.layer();
    const lab = document.createElement("div");
    lab.textContent = text;
    lab.style.cssText = "position:absolute;white-space:pre;font:800 " + size + "px/1.1 'Segoe UI Black','Segoe UI',system-ui,sans-serif;"
      + "color:" + color + ";text-shadow:0 2px 0 #000,0 0 8px rgba(0,0,0,.85);letter-spacing:.2px";
    l.append(lab);
    const w = lab.offsetWidth, h = lab.offsetHeight;
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    let lx, ly, ax, ay, tx, ty;
    if (side === "right") { lx = f.x + f.width + dx; ly = cy - h / 2 + dy; ax = lx - 8; ay = ly + h / 2; tx = r.x + r.width + 6; ty = cy; }
    else if (side === "left") { lx = f.x - dx - w; ly = cy - h / 2 + dy; ax = lx + w + 8; ay = ly + h / 2; tx = r.x - 6; ty = cy; }
    else if (side === "bottom") { lx = cx - w / 2 + dx; ly = f.y + f.height + Math.abs(dy || 60); ax = lx + w / 2; ay = ly - 6; tx = cx; ty = r.y + r.height + 6; }
    else { lx = cx - w / 2 + dx; ly = f.y - Math.abs(dy || 60) - h; ax = lx + w / 2; ay = ly + h + 6; tx = cx; ty = r.y - 6; }
    lab.style.left = lx + "px";
    lab.style.top = ly + "px";
    const mx = (ax + tx) / 2, my = (ay + ty) / 2;
    const ctrl = side === "right" || side === "left" ? [mx, my - bend] : [mx + bend, my]; // bend < 0 curves the other way
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M" + ax + "," + ay + " Q" + ctrl[0] + "," + ctrl[1] + " " + tx + "," + ty);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", color);
    p.setAttribute("stroke-width", "3");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("marker-end", "url(#shot-head)");
    l.querySelector("svg").append(p);
  },
  /** Union of the given targets and all callouts, padded, inside the viewport. */
  clip(targets, pad = 24) {
    const rects = targets.map((t) => this.rect(t)).filter(Boolean);
    for (const e of document.querySelectorAll("#shot-notes > div")) rects.push(e.getBoundingClientRect());
    for (const e of document.querySelectorAll("#shot-notes svg > path")) rects.push(e.getBoundingClientRect());
    const x1 = Math.max(0, Math.min(...rects.map((r) => r.x)) - pad);
    const y1 = Math.max(0, Math.min(...rects.map((r) => r.y)) - pad);
    const x2 = Math.min(innerWidth, Math.max(...rects.map((r) => r.x + r.width)) + pad);
    const y2 = Math.min(innerHeight, Math.max(...rects.map((r) => r.y + r.height)) + pad);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, scale: 1 };
  },
};
`;

async function shot(name, targets, notes = []) {
  await ev((n) => { window.__shot.clear(); for (const x of n) window.__shot.note(x); }, notes);
  await sleep(200);
  const clip = await ev((t) => window.__shot.clip(t), targets);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  await ev(() => window.__shot.clear());
  log("saved", `${name}.png`);
}

// ---------------------------------------------------------------- the walkthrough
const NODE = { sel: "{node}" };
const TA = { sel: "{node} textarea" };
const MODAL = { sel: ".tpm" };
const POPUP = { sel: ".tp-popup" };
const btn = (text, scope = ".tpm") => ({ sel: `${scope} button`, text });

async function setupPage() {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 2, mobile: false });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  // Our modules may only be imported once ComfyUI registered them (an early import breaks them).
  for (let i = 0; i < 120; i++) {
    const ready = await ev("(window.app?.extensions ?? []).some((e) => e.name === 'LibraryImage.TaggedPrompt')").catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  await sleep(2500);
  await ev(PAGE_HELPERS);
  // Close whatever greets a new user, then one Tagged Prompt on an empty canvas.
  await ev(async () => {
    for (let i = 0; i < 4; i++) {
      document.querySelectorAll(".p-dialog-close-button, .p-dialog-header-close, .p-toast-close-button").forEach((b) => b.click());
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    }
    const app = window.app;
    app.graph.clear();
    const node = window.LiteGraph.createNode("TaggedPrompt");
    app.graph.add(node);
    node.pos = [0, 0];
    node.setSize([560, 470]);
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [330, 190];
    app.canvas.setDirty(true, true);
    await new Promise((r) => setTimeout(r, 1200));
    window.__shot.nodeSel = `.lg-node[data-node-id="${node.id}"]`;
    window.__shot.node = node;
    window.__shot.setText = (text) => {
      node.widgets.find((x) => x.name === "text").value = text;
      const ta = document.querySelector(window.__shot.nodeSel + " textarea");
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    };
  });
  await sleep(800);
}

async function walkthrough() {
  // 1. The node
  await shot("01_tagged_prompt_node", [NODE], [
    { target: { sel: ".tp-libs" }, text: "Your libraries", side: "left", from: NODE, dx: 50, dy: 40 },
    { target: { sel: ".tp-hbtn", index: 2 }, text: "Show images / videos / audio in the @ list", side: "top", from: NODE, dx: 140, dy: 30 },
    { target: { sel: ".tp-hbtn", index: 4 }, text: "Add files", side: "right", from: NODE, dx: 50 },
  ]);

  // 2. Create the first library
  await click({ sel: ".tp-libs" });
  await shot("02_create_first_library", [NODE, { sel: ".tpl-panel" }], [
    { target: { sel: ".tpl-new" }, text: "Create your 1st library", side: "right", dx: 90, dy: 50 },
  ]);

  // 3. Name it
  await click({ sel: ".tpl-new" });
  await sleep(400);
  await click({ sel: ".tpm .tpm-input" });
  await key("a", 2); // Ctrl+A
  await type("Game_Assets");
  await sleep(300);
  await shot("03_name_your_first_library", [MODAL], [
    { target: { sel: ".tpm .tpm-input" }, text: "Name your library", side: "right", from: MODAL, dx: 50 },
    { target: btn("Pick files"), text: "Then pick files", side: "bottom", dx: -60, dy: 50 },
  ]);

  // 4. Several files at once (the dialog answers with the whole Characters folder)
  await click(btn("Pick files"));
  await sleep(1500);
  await click(TA);
  await type("@");
  await sleep(1500);
  await shot("04_add_several_files", [NODE, POPUP], [
    { target: { sel: ".tp-popup .tp-list" }, text: "Several files picked:\nall added, named after their files", side: "right", from: NODE, dx: 50 },
  ]);
  await key("Escape");
  await ev(() => window.__shot.setText(""));

  // 5. One file: preview and its name
  await click({ sel: ".tp-hbtn", index: 4 });
  await sleep(400);
  await click(btn("Pick files"));
  await sleep(1500);
  await click({ sel: ".tpm .tpm-input" });
  await key("a", 2);
  await type("Temple");
  await sleep(600);
  await shot("05_add_one_file", [MODAL], [
    { target: { sel: ".tpm .tpm-asset" }, text: "One file picked: check the preview", side: "right", from: MODAL, dx: 50 },
    { target: { sel: ".tpm .tpm-input" }, text: "…and choose its @name", side: "right", from: MODAL, dx: 50 },
  ]);
  await click(btn("Add"));
  await sleep(1200);

  // 6. Rename (display name)
  await click(TA);
  await type("@Jos");
  await sleep(1500);
  await hover({ sel: ".tp-popup .tp-item" });
  await sleep(300);
  await click({ sel: ".tp-popup .tp-item .tp-act" });
  await sleep(600);
  await ev(() => window.__shot.setText(""));
  await sleep(400);
  await click({ sel: ".tpm .tpm-input" });
  await key("a", 2);
  await type("Sir_Josef");
  await sleep(300);
  await shot("06_change_display_name", [MODAL], [
    { target: { sel: ".tpm .tpm-input" }, text: "Rename it: your prompts follow", side: "right", from: MODAL, dx: 50 },
    { target: btn("Replace file"), text: "or point it at another file", side: "bottom", dx: 40, dy: 50 },
  ]);
  await click(btn("Save"));
  await sleep(1000);

  // More demo files for a fuller prompt (no screenshots): two more libraries
  await ev(async (env, icons) => {
    const { library } = await import("/extensions/comfyui-library-image/common.js");
    if (env.length) await library.add({ new_library: "Environments" }, env.map((p) => ({ path: p })));
    if (icons.length) await library.add({ new_library: "Icons" }, icons.map((p) => ({ path: p })));
    window.__shot.setText("");
  }, ENVIRONMENTS.filter((p) => !/ancient_temple/i.test(p)), ICONS);
  await sleep(1200);

  // 7. Mention: type @ and a few letters
  await click(TA);
  await type("@Al");
  await sleep(1500);
  await shot("07_mention_an_asset", [NODE, POPUP], [
    { target: { sel: ".tp-popup .tp-item" }, text: "Type @ and a few letters,\nEnter to insert", side: "right", from: NODE, dx: 50 },
  ]);
  await key("Enter");
  await type("and @Sir_Josef search the @Temple for the lost @Gem while @Joe waits on the @Beach");
  await sleep(300);
  await key("Escape");
  await sleep(1800);

  // 8. The prompt with tags and the strip
  await hover({ sel: "{node} .lg-node-header", index: 0 }).catch(() => {});
  await sleep(300);
  await shot("08_prompt_with_tags", [NODE], [
    { target: { sel: "{node} .tp-ink", index: 5 }, text: "Blue: found in your library", side: "right", from: NODE, dx: 50, bend: -24 },
    { target: { sel: "{node} .tp-strip" }, text: "Tagged files, as they will be sent: image 1, 2…", side: "bottom", dx: 60, dy: 50 },
  ]);

  // 9. Hover a tag
  await hover({ sel: "{node} .tp-ink", index: 2 });
  await sleep(900);
  await shot("09_hover_a_tag", [NODE, { sel: ".tp-hover" }], [
    { target: { sel: ".tp-hover" }, text: "Hover a tag for a preview", side: "right", from: NODE, dx: 50 },
  ]);

  // 10. Click a thumbnail: its tag lights up
  const gem = await ev(() => [...document.querySelectorAll(window.__shot.nodeSel + " .tp-chip")].findIndex((c) => c.textContent.includes("@Gem")));
  await click({ sel: "{node} .tp-chip", index: Math.max(0, gem) });
  await sleep(120);
  await shot("10_click_a_thumbnail_to_find_its_tag", [NODE], [
    { target: { sel: "{node} .tp-chip", index: Math.max(0, gem) }, text: "Click a thumbnail: its tag lights up", side: "bottom", dx: 40, dy: 50 },
  ]);

  // 00. The main idea: only the text goes to the model; no image wires at all
  await mouse("mouseMoved", 5, 5);
  await ev(async () => {
    const app = window.app;
    const node = window.__shot.node;
    app.canvas.ds.offset = [60, 190];
    const nb = window.LiteGraph.createNode("GeminiNanoBanana2V2");
    app.graph.add(nb);
    nb.pos = [720, 60];
    // Nano Banana 2.1 when this ComfyUI offers it. A throwaway ComfyUI isn't signed in, and may only
    // be offered "Nano Banana 2": that one stays (same inputs; an unknown model would remove them).
    const model = nb.widgets?.find((w) => w.name === "model");
    const v21 = model?.options?.values?.find?.((v) => /2\.1/.test(v));
    if (v21) {
      model.value = v21;
      model.callback?.(v21);
    }
    node.connect(0, nb, nb.inputs.findIndex((i) => i.name === "prompt"));
    app.canvas.setDirty(true, true);
    window.__shot.sels.nb = `.lg-node[data-node-id="${nb.id}"]`;
    window.__shot.nb = nb;
    await new Promise((r) => setTimeout(r, 1500));
  });
  await sleep(1500);
  const NB = { sel: "{nb}" };
  const nbImages = await ev(() => {
    // The empty image input on the model node, if its slot can be found; else the node itself.
    const el = [...document.querySelectorAll(window.__shot.sels.nb + " .lg-slot")].find((e) => /image_1/.test(e.textContent));
    if (el) el.dataset.shotTarget = "nb-images";
    return !!el;
  });
  await shot("00_no_image_wires", [NODE, NB], [
    { target: nbImages ? { sel: '[data-shot-target="nb-images"]' } : NB, text: "No images wired into the model", side: "top", from: NB, dx: 40, dy: 30 },
    { target: { sel: "{node} .tp-strip" }, text: "The tagged files go to its image inputs\nwhen you queue: image 1, image 2…", side: "bottom", from: NODE, dx: 40, dy: 40 },
  ]);
  await ev(() => window.app.graph.remove(window.__shot.nb));
  await sleep(500);

  // 11. A file that isn't in a library: a Load Image plugged into the Tagged Prompt
  await mouse("mouseMoved", 5, 5);
  await ev(async () => {
    const app = window.app;
    const node = window.__shot.node;
    app.canvas.ds.offset = [560, 190];
    const li = window.LiteGraph.createNode("LoadImage");
    app.graph.add(li);
    li.pos = [-470, 120];
    li.widgets.find((w) => w.name === "image").value = "Night_Forest.png";
    li.connect(0, node, node.inputs.findIndex((i) => i.name === "image_1"));
    app.canvas.setDirty(true, true);
    window.__shot.sels.li = `.lg-node[data-node-id="${li.id}"]`;
    await new Promise((r) => setTimeout(r, 1500));
    window.__shot.setText("@Alex explores the @Night_Forest at dusk");
  });
  await sleep(2200);
  const LI = { sel: "{li}" };
  await shot("11_plug_in_a_file", [NODE, LI], [
    { target: LI, text: "Any Load Image / Video / Audio…", side: "top", dx: 0, dy: 40 },
    { target: { sel: "{node} .tp-ink", index: 1 }, text: "…tagged by its file name", side: "top", from: NODE, dx: 260, dy: 24 },
    { target: { sel: "{node} .tp-chip.tp-extra" }, text: "⇤ First: before the library files", side: "bottom", from: NODE, dx: 220, dy: 30 },
  ]);

  // 12. Switch it to Last: it moves after the library files
  await click({ sel: "{node} .tp-firstlast" });
  await mouse("mouseMoved", 5, 5);
  await sleep(900);
  await shot("12_place_it_last", [NODE], [
    { target: { sel: "{node} .tp-chip.tp-extra" }, text: "Click it: Last ⇥ puts it after the library files", side: "bottom", from: NODE, dx: 160, dy: 30 },
  ]);
}

// ---------------------------------------------------------------- main
async function main() {
  for (const [what, p] of [["ComfyUI", path.join(COMFY, "main.py")], ["Python", PYTHON], ["frontend", FRONTEND], ["Chrome", CHROME ?? ""], ["resources", RES]]) {
    if (!p || !fs.existsSync(p)) throw new Error(`${what} not found: ${p || "(set the env var)"}`);
  }
  if (!CHARACTERS.length) throw new Error(`no images in ${path.join(RES, "Characters")}`);
  fs.mkdirSync(OUT, { recursive: true });
  const { base, fake } = prepareBase();
  log("temp folder", base);
  let comfy, chrome;
  try {
    log("starting ComfyUI on port", PORT);
    comfy = await startComfy(base, fake);
    log("starting Chrome");
    chrome = await startChrome(base);
    cdp = new Cdp(chrome.ws);
    await cdp.open();
    await setupPage();
    await walkthrough();
    log("done:", OUT);
  } finally {
    chrome?.proc.kill();
    comfy?.kill();
    await sleep(1500);
    if (!flag("keep")) fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("[screens] failed:", e.message);
  process.exit(1);
});
