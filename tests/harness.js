// Regression harness: builds scenarios on the canvas, records strip chips + API binding, cleans up.
const { app } = await import("/scripts/app.js");
const m = await import("/extensions/comfyui-library-image/common.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40 && !window.LiteGraph?.registered_node_types?.TaggedPrompt; i++) await wait(500);
await m.library.load(true);
// Its own library, so the results don't depend on yours: two files from ComfyUI's input folder (the
// same folder the Load Image scenarios use). Set window.__harnessInput first if yours is elsewhere.
const INPUT_DIR = window.__harnessInput ?? "C:/Users/chabu/Documents/ComfyUI/input/";
const harnessLib = (await m.library.add({ new_library: "Zz_Harness" }, ["Buttons.png", "Biscuit.png"].map((f) => ({ path: INPUT_DIR + f })))).library;
await wait(2500); // let a freshly loaded page restore its workflow first
const LG = window.LiteGraph;
const G = app.graph;
const made = [];
const add = (type, x, y, g = G) => { const n = LG.createNode(type); g.add(n); n.pos = [x, y]; made.push([g, n]); return n; };
const idx = (n, name) => n.inputs.findIndex((i) => i.name === name);
const loadImg = (file, x, y, g) => { const n = add("LoadImage", x, y, g); n.widgets.find((w) => w.name === "image").value = file; return n; };
const chips = (tp) => [...(document.querySelectorAll(`.lg-node[data-node-id="${tp.id}"] .tp-chip`))]
  .map((c) => `${c.querySelector(".tp-cname")?.textContent}[${c.querySelector(".tp-idx")?.textContent}]`).join(" ");
const ink = (tp) => [...(document.querySelectorAll(`.lg-node[data-node-id="${tp.id}"] .tp-ink`))].map((s) => `${s.textContent}=${s.dataset.state}`).join(" ");
const describe = (o, id) => { const n = o[id]; if (!n) return `?${id}`; return `${n.class_type}:${String(n.inputs.image ?? n.inputs.image_path ?? n.inputs.path ?? "").split(/[\\/]/).pop()}`; };
async function api() {
  try {
    const { output: o } = await app.graphToPrompt();
    const { problemsOf } = await import("/extensions/comfyui-library-image/compat.js");
    const problems = problemsOf(o);
    if (problems) return [`ERROR ${problems.join(" / ")}`];
    const res = [];
    for (const [id, n] of Object.entries(o)) {
      const imgs = Object.entries(n.inputs).filter(([k, v]) => /image_\d+$/.test(k) && Array.isArray(v) && n.class_type !== "TaggedPrompt");
      if (!imgs.length && !/Nano|Seedance/i.test(n.class_type)) continue;
      const pv = n.inputs.prompt;
      const flat = (v, d = 0) => (typeof v === "string" ? v : Array.isArray(v) && d < 8 && o[v[0]]
        ? `${o[v[0]].class_type}(${Object.values(o[v[0]].inputs ?? {}).filter((x) => typeof x === "string" || (Array.isArray(x) && !/Load|Library/.test(o[x[0]]?.class_type ?? ""))).map((x) => flat(x, d + 1)).join("|")})` : "");
      const text = flat(pv);
      res.push(`${n._meta?.title ?? n.class_type} «${text}» ${imgs.sort().map(([k, v]) => `${k.split(".").pop()}←${describe(o, v[0])}`).join(", ")}`);
    }
    return res.sort();
  } catch (e) { return [`ERROR ${e.message}`]; }
}
// Changes like muting fire no event: the strips catch them on their tick, which pauses while the
// page is hidden (as the browser pane often is), so refresh explicitly.
const settle = async () => {
  await wait(1700);
  (await import("/extensions/comfyui-library-image/tp_strip.js")).refreshAllStrips();
  await wait(200);
};
const planOf = async (node) => {
  const { planFor } = await import("/extensions/comfyui-library-image/tp_plan.js");
  const p = planFor(node);
  return { target: p.target?.title ?? null, rows: p.rows.map((r) => `@${r.tok}=${r.state}[${r.label ?? r.status}]`).join(" "),
    extras: p.extras.map((x) => `${x.input}:${x.tag ?? x.name}[${x.label ?? "-"}]`).join(" ") };
};
const results = {};
async function scenario(name, build) {
  const before = new Set(app.graph._nodes.map((n) => n.id));
  try {
    const nodes = await build();
    await settle();
    results[name] = { ...Object.fromEntries((nodes.tps ?? []).map((tp, i) => [`chips${i}`, chips(tp)])), ...Object.fromEntries((nodes.tps ?? []).map((tp, i) => [`ink${i}`, ink(tp)])), api: await api(), ...(nodes.extra?.inner ? { planInner: await planOf(nodes.extra.inner) } : {}) };
  } catch (e) { results[name] = { crash: String(e.stack ?? e) }; }
  for (const [g, n] of made.splice(0).reverse()) try { g.remove(n); } catch {}
  for (const n of [...app.graph._nodes]) if (!before.has(n.id)) try { app.graph.remove(n); } catch {}
  await wait(300);
}

// 1. library tags + First and Last extras
await scenario("lib+extras", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 600, 2000);
  await wait(400);
  m.setWidget(tp, "text", "@Biscuit with @Buttons and @Giftwood and @CAPIBARA");
  const a = loadImg("Giftwood.png", -400, 2000), b = loadImg("CAPIBARA.jpg", -400, 2300);
  a.connect(0, tp, idx(tp, "image_1")); await wait(300); b.connect(0, tp, idx(tp, "image_2")); await wait(300);
  tp.properties.tp_before = { image_2: false };
  tp.connect(0, t, idx(t, "prompt"));
  return { tps: [tp] };
});
// 2. hand-wired Load Image on the target + library tag of another name
await scenario("hand-wired", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 600, 2000);
  await wait(400);
  m.setWidget(tp, "text", "@Giftwood next to @Buttons");
  const a = loadImg("Giftwood.png", 300, 2400); a.connect(0, t, idx(t, "model.images.image_1"));
  tp.connect(0, t, idx(t, "prompt"));
  return { tps: [tp] };
});
// 3. @name output wired by hand into the target
await scenario("output-wired", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 600, 2000);
  await wait(400);
  m.setWidget(tp, "text", "@Buttons and @Biscuit");
  await settle();
  const o = tp.outputs.findIndex((x) => x.name === "@Biscuit");
  tp.connect(o, t, idx(t, "model.images.image_1"));
  tp.connect(0, t, idx(t, "prompt"));
  return { tps: [tp] };
});
// 4. one prompt, two targets
await scenario("two-targets", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t1 = add("GeminiNanoBanana2V2", 600, 2000); const t2 = add("GeminiNanoBanana2V2", 600, 2600);
  await wait(400);
  m.setWidget(tp, "text", "@Buttons and @Biscuit");
  const a = loadImg("Giftwood.png", 300, 2600); a.connect(0, t2, idx(t2, "model.images.image_1"));
  t2.title = "Second";
  tp.connect(0, t1, idx(t1, "prompt")); tp.connect(0, t2, idx(t2, "prompt"));
  return { tps: [tp] };
});
// 5. errors: unknown tag, library off
await scenario("errors", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 600, 2000);
  await wait(400);
  m.setWidget(tp, "text", "@Buttons and @NoSuchThing_xyz");
  tp.connect(0, t, idx(t, "prompt"));
  return { tps: [tp] };
});
// 6. through a string node (R2-9)
await scenario("via-concat", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 900, 2000);
  const c = add("StringConcatenate", 450, 2000);
  await wait(400);
  m.setWidget(tp, "text", "@Buttons and @Giftwood");
  const a = loadImg("Giftwood.png", -400, 2000); a.connect(0, tp, idx(tp, "image_1"));
  tp.connect(0, c, idx(c, "string_a"));
  c.widgets.find((w) => w.name === "string_b").value = ", watercolor";
  c.connect(0, t, idx(t, "prompt"));
  return { tps: [tp] };
});

// 7. one chain read by two targets (cloned per target)
await scenario("concat-shared", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t1 = add("GeminiNanoBanana2V2", 900, 2000); const t2 = add("GeminiNanoBanana2V2", 900, 2600);
  const c = add("StringConcatenate", 450, 2000);
  await wait(400);
  m.setWidget(tp, "text", "@Buttons and @Biscuit");
  t2.title = "Second";
  const a = loadImg("Giftwood.png", 600, 2600); a.connect(0, t2, idx(t2, "model.images.image_1"));
  tp.connect(0, c, idx(c, "string_a"));
  c.connect(0, t1, idx(t1, "prompt")); c.connect(0, t2, idx(t2, "prompt"));
  return { tps: [tp] };
});
// 8. @tags typed in a plain string node, through concat (no Tagged Prompt)
await scenario("typed-in-concat", async () => {
  const t = add("GeminiNanoBanana2V2", 900, 2000);
  const c = add("StringConcatenate", 450, 2000);
  await wait(400);
  c.widgets.find((w) => w.name === "string_a").value = "portrait of @Buttons";
  c.widgets.find((w) => w.name === "string_b").value = " in snow";
  c.connect(0, t, idx(t, "prompt"));
  return { tps: [] };
});
// 9. muted plugged-in file: not used, its tag shows unplugged
await scenario("muted-extra", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 600, 2000);
  await wait(400);
  const a = loadImg("Giftwood.png", -400, 2000); a.connect(0, tp, idx(tp, "image_1"));
  await settle();
  m.setWidget(tp, "text", "@Giftwood and @Buttons");
  tp.connect(0, t, idx(t, "prompt"));
  await settle();
  a.mode = 2;
  return { tps: [tp] };
});
// 10. subgraph: Tagged Prompt inside, its text leaves through the subgraph output to a target outside;
//     a Load Image outside feeds an extra input through the subgraph input
await scenario("subgraph-boundary", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 900, 2000);
  await wait(400);
  m.setWidget(tp, "text", "@Buttons and @Giftwood");
  const a = loadImg("Giftwood.png", -500, 2000);
  a.connect(0, tp, idx(tp, "image_1"));
  tp.connect(0, t, idx(t, "prompt"));
  await settle();
  made.splice(made.findIndex(([, n]) => n === tp), 1);
  const res = G.convertToSubgraph(new Set([tp]));
  const sg = res?.node ?? res;
  made.push([G, sg]);
  await settle();
  const inner = sg.subgraph._nodes.find((n) => n.type === "TaggedPrompt");
  window.__sgInner = inner;
  return { tps: [] , extra: { inner } };
});

// 11. user's Test 01: plugging a same-name file qualifies the library tag; unplugged, its tag is red
await scenario("claims-test01", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 600, 2000);
  await wait(400);
  m.setWidget(tp, "text", "a photo of @Biscuit");
  tp.connect(0, t, idx(t, "prompt"));
  await settle();
  const a = loadImg("Biscuit.png", -400, 2000); a.connect(0, tp, idx(tp, "image_1"));
  await settle();
  m.setWidget(tp, "text", m.getWidget(tp, "text").value + " next to @Biscuit");
  await settle();
  tp.disconnectInput(idx(tp, "image_1"));
  return { tps: [tp] };
});
// 12. user's Test 02: two Load Images of the same file; unplug the first
await scenario("claims-test02", async () => {
  const tp = add("TaggedPrompt", 0, 2000); const t = add("GeminiNanoBanana2V2", 600, 2000);
  await wait(400);
  tp.connect(0, t, idx(t, "prompt"));
  const a = loadImg("Biscuit.png", -400, 2000), b = loadImg("Biscuit.png", -400, 2350);
  a.connect(0, tp, idx(tp, "image_1")); await settle();
  m.setWidget(tp, "text", "@Biscuit and @Zz_Harness/Biscuit"); await settle();
  b.connect(0, tp, idx(tp, "image_2")); await settle();
  m.setWidget(tp, "text", m.getWidget(tp, "text").value + " and @Biscuit_2"); await settle();
  tp.disconnectInput(idx(tp, "image_1"));
  return { tps: [tp] };
});

await m.library.deleteLibrary(harnessLib);
// Save the cleaned-up canvas, so a reload never restores a scenario's nodes from an autosave made mid-run.
app.extensionManager.workflow.activeWorkflow?.changeTracker?.checkState();
window.__harness = results;
JSON.stringify(results, null, 1)
