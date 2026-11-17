// Runs the queue-time binding (web/tp_bind.js) on the example workflow, outside ComfyUI:
//   node tests/bind_example.mjs
// The frontend modules are copied next to stand-ins for ComfyUI's scripts/app.js and scripts/api.js,
// the canvas is rebuilt from example_workflows/Reference_Library_example.json, and the library holds
// the demo library's two files (ids as in example_workflows/assets/Demo.zip). It checks what a queued
// or exported API prompt looks like: files wired to the models, tags rewritten, no disk paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflib-bind-"));
const webDir = path.join(tmp, "extensions", "pack", "web");
fs.mkdirSync(path.join(tmp, "extensions", "scripts"), { recursive: true });
fs.cpSync(path.join(REPO, "web"), webDir, { recursive: true });
fs.writeFileSync(path.join(tmp, "extensions", "scripts", "app.js"), "export const app = globalThis.__app;\n");
fs.writeFileSync(path.join(tmp, "extensions", "scripts", "api.js"), "export const api = globalThis.__api;\n");
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');

// ---------------------------------------------------------------- the canvas, from the workflow file
const wf = JSON.parse(fs.readFileSync(path.join(REPO, "example_workflows", "Reference_Library_example.json"), "utf8"));
const links = new Map(wf.links.map(([id, origin_id, origin_slot, target_id, target_slot, type]) =>
  [id, { id, origin_id, origin_slot, target_id, target_slot, type }]));
const graph = { id: wf.id, links, _nodes: [], getNodeById: (id) => graph._nodes.find((n) => String(n.id) === String(id)) ?? null };
for (const n of wf.nodes) {
  graph._nodes.push({
    ...n, graph, comfyClass: n.type, title: n.title ?? n.type,
    widgets: Object.entries(n.widgets_values_named ?? {}).map(([name, value]) => ({ name, value })),
  });
}
const nodeDefs = { ReferencePrompt: { nodeData: { output: ["STRING"] } }, LoadImage: { nodeData: { output: ["IMAGE", "MASK"] } } };
globalThis.window = globalThis;
globalThis.LiteGraph = { registered_node_types: nodeDefs };
globalThis.document = { hidden: false, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
globalThis.__app = { graph, canvas: { graph }, registerExtension() {}, extensionManager: null };
globalThis.__api = { fetchApi: async () => { throw new Error("no server here"); }, apiURL: (p) => p, queuePrompt: async () => ({}), addEventListener() {} };

// The API prompt as the frontend builds it before the pack touches it: widgets as values, links as
// [node, slot]. `without`: model nodes left out (as if they were muted), with what they feed.
function apiPrompt(without = []) {
  const skip = new Set(without.map(String));
  for (let grew = true; grew;) {
    grew = false;
    for (const l of links.values()) {
      if (skip.has(String(l.origin_id)) && !skip.has(String(l.target_id))) { skip.add(String(l.target_id)); grew = true; }
    }
  }
  const out = {};
  for (const n of graph._nodes) {
    if (n.type === "MarkdownNote" || skip.has(String(n.id))) continue;
    const inputs = { ...(n.widgets_values_named ?? {}) };
    for (const inp of n.inputs ?? []) {
      const l = inp.link != null ? links.get(inp.link) : null;
      if (l) inputs[inp.name] = [String(l.origin_id), l.origin_slot];
    }
    delete inputs.upload;
    out[String(n.id)] = { class_type: n.type, inputs, _meta: { title: n.title } };
  }
  return out;
}
const output = apiPrompt();

// ---------------------------------------------------------------- the library: the demo library's two files
const load = (f) => import(pathToFileURL(path.join(webDir, f)).href);
const { library } = await load("common.js");
const DISK = "C:\\Users\\someone\\Private Folder\\";
library._set({
  libraries: [{ id: "ef3a46212c4c", name: "Demo", count: 2 }],
  assets: [
    { id: "fbda8ea52ba9", name: "Karl", library: "ef3a46212c4c", kind: "image", path: `${DISK}Karl.png`, exists: true },
    { id: "2ba6578d3b8e", name: "Alex", library: "ef3a46212c4c", kind: "image", path: `${DISK}Alex.png`, exists: true },
  ],
});

// ---------------------------------------------------------------- bind, then look at the result
const { bindPrompt, usesReferencePrompt } = await load("tp_bind.js");
assert.equal(usesReferencePrompt(output), true);
const errors = bindPrompt(output);
assert.deepEqual(errors, [], "the example binds without problems");

const byTypeIn = (o, t) => Object.entries(o).filter(([, n]) => n.class_type === t);
const byType = (t) => byTypeIn(output, t);
const loaders = Object.fromEntries(byType("ReferenceLibraryImage").map(([id, n]) => [n.inputs.name, id]));
assert.deepEqual(Object.keys(loaders).sort(), ["Alex", "Karl"], "one loader per tagged library file, shared by all models");
assert.deepEqual(output[loaders.Karl].inputs, { name: "Karl", asset: "fbda8ea52ba9", library: "Demo" });
assert.deepEqual(output[loaders.Alex].inputs, { name: "Alex", asset: "2ba6578d3b8e", library: "Demo" });

const textOf = (link) => {
  const src = output[link[0]];
  assert.ok(src && /^(ReferencePrompt|TaggedPrompt)$/.test(src.class_type), "the prompt comes from a Reference Prompt (or its copy)");
  return src.inputs.text;
};
const REWRITTEN = "The character in image 2 is eating the donut from image 1.\nIn the background image 3 is preparing a meal.";
for (const id of ["1", "8"]) {  // Nano Banana 2.1, Seedream: image_1, image_2, ... inputs
  const n = output[id];
  assert.deepEqual(n.inputs["model.images.image_1"], ["4", 0], `${n.class_type}: the plugged-in donut is First`);
  assert.deepEqual(n.inputs["model.images.image_2"], [loaders.Karl, 0], `${n.class_type}: @Karl`);
  assert.deepEqual(n.inputs["model.images.image_3"], [loaders.Alex, 0], `${n.class_type}: @Alex`);
  assert.ok(textOf(n.inputs.prompt).startsWith(REWRITTEN), `${n.class_type}: tags became image N: ${JSON.stringify(textOf(n.inputs.prompt))}`);
}
const pro = output["11"];  // Nano Banana Pro: one "images" input, fed by the Reference Prompt's "images" output
const [batchId, batch] = byType("ReferenceImagesBatch")[0];
assert.deepEqual(pro.inputs.images, [batchId, 0]);
assert.deepEqual([batch.inputs.image_1, batch.inputs.image_2, batch.inputs.image_3], [["4", 0], [loaders.Karl, 0], [loaders.Alex, 0]]);
assert.ok(textOf(pro.inputs.prompt).startsWith(REWRITTEN));

const sent = JSON.stringify(output);
assert.ok(!sent.includes("Private Folder") && !sent.includes("someone"), "no disk path in the API prompt");
assert.ok(!/@(Karl|Alex|Donut)\b/.test(Object.values(output).map((n) => n.inputs.text ?? n.inputs.prompt ?? "").filter((v) => typeof v === "string").join(" ")), "no raw @tags are sent");
for (const n of Object.values(output)) for (const k of Object.keys(n.inputs)) {
  if (/^(ReferencePrompt|TaggedPrompt)$/.test(n.class_type)) assert.ok(!/^(image|video|audio)_\d+$/.test(k), "the Reference Prompt's own file inputs are moved onto the models");
}

// One model with image_N inputs alone: the Reference Prompt's text is rewritten in place, nothing is copied.
const solo = apiPrompt([8, 11]);
assert.deepEqual(bindPrompt(solo), []);
assert.deepEqual(solo["1"].inputs.prompt, ["3", 0]);
assert.ok(solo["3"].inputs.text.startsWith(REWRITTEN) && !Object.keys(solo).some((k) => k.startsWith("tpcopy")));
assert.equal(byTypeIn(solo, "ReferenceImagesBatch").length, 0);

// The batch model alone: same numbering, through the "images" output.
const batchOnly = apiPrompt([1, 8]);
assert.deepEqual(bindPrompt(batchOnly), []);
assert.ok(batchOnly["3"].inputs.text.startsWith(REWRITTEN));
assert.equal(byTypeIn(batchOnly, "ReferenceImagesBatch").length, 1);

// The library isn't on this computer (the workflow was opened elsewhere without importing it): refused, with the reason.
const kept = { libraries: library.libraries, assets: library.assets };
library._set({ libraries: [], assets: [] });
const unknown = bindPrompt(apiPrompt());
assert.ok(unknown.length && unknown.every((m) => typeof m === "string") && unknown.some((m) => /@Karl/.test(m) && /not in any enabled library/.test(m)), JSON.stringify(unknown));
library._set(kept);

// A workflow without a Reference Prompt is left exactly as it is, even with an @word that is a library name.
const plain = { 1: { class_type: "GeminiNanoBanana2V2", inputs: { prompt: "a portrait of @Karl", "model.images.image_1": ["4", 0] } }, 4: output["4"] };
const before = JSON.stringify(plain);
assert.deepEqual(bindPrompt(plain), []);
assert.equal(JSON.stringify(plain), before);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("bind_example: ok");
process.exit(0);  // the frontend modules leave timers running
