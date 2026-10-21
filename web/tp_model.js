// Reference Prompt: per-node settings, what is plugged in where (extras, targets, sources), and claims.
import {
  getWidget, hasMediaPorts, KINDS, library, mediaPorts, mentionsIn, splitTag, stem, tagKey, tagName, viewUrl,
} from "./common.js";
import { allGraphs, currentGraph, isMuted, linkById, nodeDefOf, nodesOf, originOf, targetsOf } from "./compat.js";

export const NODE_TYPE = "ReferencePrompt";
// Ids from before the rename to Reference Library (saved workflows use them): the same nodes.
export const OLD_TYPES = { TaggedPrompt: "ReferencePrompt", LibraryImage: "ReferenceImage", LibraryVideo: "ReferenceVideo", LibraryAudio: "ReferenceAudio" };
/** A node type (or API class_type) in today's id: old ids mapped to their new one. */
export const typeId = (t) => OLD_TYPES[t] ?? t;
export const isTpType = (t) => typeId(t) === NODE_TYPE;

export const MAX_RESULTS = 60;

export const KIND_LABEL = { image: "Images", video: "Videos", audio: "Audio" };

/** Types shown in this node's @ list (header toggles), saved with the workflow. */
export function enabledKinds(node) {
  const k = node?.properties?.tp_kinds;
  return Array.isArray(k) ? k.filter((x) => KINDS.includes(x)) : [...KINDS];
}

/**
 * Libraries enabled in this node (the header's Libraries dropdown), as a Set of ids. Stored as the
 * list of switched-off ids, so libraries created later start enabled everywhere.
 */
export function enabledLibs(node) {
  const off = new Set(node?.properties?.tp_libs_off ?? []);
  return new Set(library.libraries.filter((l) => !off.has(l.id)).map((l) => l.id));
}

/** Resolves a tag for a node: { status: ok | missing | off | unknown, asset, lib }. */
export const resolveFor = (node, tok) => library.resolve(tok, node ? enabledLibs(node) : null);

export const isTaggedPrompt = (node) => isTpType(node?.comfyClass ?? node?.type);

/**
 * First downstream node with auto-grow media ports fed by this prompt node. Follows the text through
 * string nodes (concat, replace, ...) and across subgraph boundaries, like the queue does.
 */
export function targetOf(node) {
  const graph = node.graph ?? currentGraph();
  const seen = new Set();
  let queue = targetsOf(graph, node, 0);
  for (let steps = 0; queue.length && steps < 64; steps++) {
    const { graph: g, node: t } = queue.shift();
    if (seen.has(t) || isMuted(t)) continue;
    seen.add(t);
    if (hasMediaPorts(t)) return t;
    (t.outputs ?? []).forEach((o, i) => {
      if (o.type === "STRING") queue.push(...targetsOf(g, t, i));
    });
  }
  return null;
}

/**
 * The real source of an input (across subgraph boundaries) as { graph, node, slot }, or null when
 * nothing is plugged in or the source is muted (muted nodes don't run).
 */
export function sourceOfInput(graph, inp) {
  if (inp?.link == null) return null;
  const o = originOf(graph, linkById(graph, inp.link));
  return o && !isMuted(o.node) ? o : null;
}

/** Identity of a source for claims: "nodeId:slot", prefixed with its graph when it isn't the node's own. */
const sourceKey = (node, o) => `${o.graph === node.graph ? "" : `${o.graph?.id ?? "?"}/`}${o.node.id}:${o.slot}`;

// Tag name a wired source node contributes: Library loaders use their name (or file stem),
// core loaders their file stem. [widget holding the name, widget holding the path]
const SOURCE_WIDGETS = {
  ReferenceImage: ["name", "image_path"], ReferenceVideo: ["name", "path"], ReferenceAudio: ["name", "path"],
  LoadImage: [null, "image"], LoadVideo: [null, "file"], LoadAudio: [null, "audio"],
};

function uiSourceName(src, slot = 0) {
  // A Reference Prompt's own "@name" outputs carry that asset.
  if (isTaggedPrompt(src)) return slot > 0 ? outputAssetName(src.outputs?.[slot]) : null;
  const w = SOURCE_WIDGETS[typeId(src?.comfyClass ?? src?.type)];
  if (!w) return null;
  return (w[0] && getWidget(src, w[0])?.value) || stem(getWidget(src, w[1])?.value) || null;
}

export function apiSourceName(src) {
  const w = SOURCE_WIDGETS[src?.class_type];
  if (!w) return null;
  const name = w[0] && typeof src.inputs?.[w[0]] === "string" ? src.inputs[w[0]].trim() : "";
  const path = src.inputs?.[w[1]];
  return name || (typeof path === "string" ? stem(path) : null);
}

// image_N / video_N / audio_N inputs on the Reference Prompt itself, for files used in this run only.
// Each is placed First (before library tags) or Last (after them) on the target; within a group
// they keep their input order.

export const EXTRA_RE = /^(image|video|audio)_(\d+)$/;

export const isBefore = (node, inputName) => node.properties?.tp_before?.[inputName] !== false;

/**
 * Plugged-in extra inputs, in input order: { kind, input, src, srcSlot, srcKey, name, before }.
 * The source is the real one (through subgraph boundaries); muted sources don't count.
 */
export function extraInputs(node) {
  const graph = node.graph ?? currentGraph();
  const out = [];
  for (const inp of node.inputs ?? []) {
    const m = EXTRA_RE.exec(inp.name);
    const o = m ? sourceOfInput(graph, inp) : null;
    if (!o) continue;
    const name = uiSourceName(o.node, o.slot) || null;
    out.push({ kind: m[1], input: inp.name, src: o.node, srcSlot: o.slot, srcKey: sourceKey(node, o), name,
      before: isBefore(node, inp.name) });
  }
  return out;
}

// A plugged-in file (an extra input) or a file wired into the target by hand gets a tag name when it
// is plugged in: its file name, or "Biscuit_2" if another non-library file of this node already has
// it. The claim is stored on the node (properties.tp_ext) and tied to that source node, so:
//   - a claimed plain "@Biscuit" always means that file; unplugged, the tag turns red (never falls
//     back to the library or to another file of the same name);
//   - library tags are never overridden: when a claim is made, plain tags that meant the library
//     asset become "@Library_01/Biscuit", and the popup inserts library assets qualified;
//   - a claim ends once its file is unplugged and its tag is gone from the text.
// claim: { name, base, src: "nodeId:slot", kind, file, from }

/** The non-library files this node can tag: its connected extras and files hand-wired to the target. */
export function localSources(node, extras = extraInputs(node), target = targetOf(node)) {
  const out = [];
  for (const x of extras) {
    if (x.name) out.push({ src: x.srcKey, base: tagName(x.name), kind: x.kind, extra: x, node: x.src });
  }
  if (target) {
    const graph = target.graph ?? currentGraph();
    for (const kind of KINDS) {
      for (const p of mediaPorts(target, kind)) {
        const o = sourceOfInput(graph, p.inp);
        if (!o || isTaggedPrompt(o.node)) continue; // a Reference Prompt's @outputs are library assets
        const name = uiSourceName(o.node, o.slot);
        if (name) out.push({ src: sourceKey(node, o), base: tagName(name), kind, hand: p.n, node: o.node });
      }
    }
  }
  return out;
}

/**
 * The node's stored claims, or null if it has none yet. They come from the workflow file, which may
 * be someone else's: only tag-shaped keys and object values are kept, in a prototype-free map (a
 * "__proto__" key can't change how the map behaves).
 */
function claimsStored(node) {
  const raw = node.properties?.tp_ext;
  if (raw == null) return null;
  const out = Object.create(null);
  if (typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, claim] of Object.entries(raw)) {
      if (/^[\p{L}\p{N}_-]+$/u.test(key) && claim && typeof claim === "object" && typeof claim.name === "string") out[key] = claim;
    }
  }
  return out;
}

/**
 * Read-only view: tag key -> { claim, source } (source null = its file is unplugged). Sources not
 * claimed yet (syncClaims hasn't run since they were plugged in) aren't listed.
 */
export function claimsOf(node, sources = localSources(node)) {
  const out = new Map();
  for (const [key, claim] of Object.entries(claimsStored(node) ?? {})) {
    const source = sources.find((s) => s.src === claim.src && s.base === claim.base) ?? null;
    // Still wired but muted: say so instead of "unplugged" (only for sources in the node's own graph).
    const [id] = String(claim.src ?? "").includes("/") ? [] : String(claim.src ?? "").split(":");
    const muted = !source && id != null && isMuted(node.graph?.getNodeById(id));
    out.set(key, { claim: muted ? { ...claim, muted } : claim, source });
  }
  return out;
}

/** Keys of every claimed name (plugged in or not): plain tags with these names aren't library tags. */
export const claimedKeys = (node) => new Set(Object.keys(claimsStored(node) ?? {}));

/** The tag that reaches a library asset from this node: qualified when a plugged-in file has its name. */
export function libToken(node, asset, libs = enabledLibs(node), claimed = claimedKeys(node)) {
  const tok = library.tokenFor(asset, libs);
  return splitTag(tok).lib || !claimed.has(tagKey(tok)) ? tok : `${library.libName(asset.library)}/${asset.name}`;
}

const sourceFile = (s) => {
  const media = s.extra ? extraMedia(s.extra) : {};
  return media.file ?? media.asset?.path?.split(/[\\/]/).pop() ?? null;
};

/**
 * Brings the node's claims up to date with what is plugged in (runs on every strip refresh):
 *   1. a source keeps its claim while it's plugged in and its name is unchanged;
 *   2. a new source takes over an unplugged claim with the same file name (it was re-plugged
 *      through another node, or the workflow was pasted), else gets a new unique name: one that no
 *      other claim and no library file of this node has ("Biscuit_2" next to a library "Biscuit"),
 *      so the text is never rewritten and a plain library tag keeps meaning the library file;
 *   3. claims whose file is unplugged and whose tag is gone from the text are dropped.
 */
export function syncClaims(node) {
  if (!library.loaded || !node.graph) return;
  const stored = claimsStored(node);
  const first = stored == null;
  const claims = Object.assign(Object.create(null), stored ?? {});
  const sources = localSources(node);
  const assigned = new Map(); // key -> source
  // 1. still plugged in, same name
  for (const s of sources) {
    const key = Object.keys(claims).find((k) => claims[k].src === s.src && claims[k].base === s.base && !assigned.has(k));
    if (key) assigned.set(key, (s.key = key, s));
  }
  // 2. adopt an unplugged claim with the same file name, or claim a new name
  const libs = enabledLibs(node);
  for (const s of sources) {
    if (s.key || [...assigned.values()].some((o) => o.src === s.src)) continue; // same source, two inputs
    let key = Object.keys(claims).find((k) => claims[k].base === s.base && !assigned.has(k));
    if (!key) {
      let name = s.base;
      // (A workflow saved before claims existed keeps the names it was made with.)
      const taken = (nm) => claims[tagKey(nm)] || (!first && library.resolve(nm, libs).asset);
      for (let n = 2; taken(name); n++) name = `${s.base}_${n}`;
      key = tagKey(name);
      claims[key] = { name, base: s.base };
    }
    assigned.set(key, (s.key = key, s));
  }
  for (const [key, s] of assigned) {
    claims[key] = { ...claims[key], src: s.src, kind: s.kind, file: sourceFile(s) ?? claims[key].file ?? null,
      from: s.node?.title ?? claims[key].from ?? null };
  }
  // 3. drop claims that nothing uses any more
  const text = getWidget(node, "text")?.value ?? "";
  const mentioned = new Set(mentionsIn(text).filter((t) => !splitTag(t).lib).map(tagKey));
  for (const key of Object.keys(claims)) if (!assigned.has(key) && !mentioned.has(key)) delete claims[key];

  const changed = JSON.stringify(claims) !== JSON.stringify(stored ?? {});
  if (changed || first) {
    node.properties ??= {};
    node.properties.tp_ext = claims;
    if (changed && !first) node.graph?.change?.();
  }
}

/** Plain tags (and "@name" outputs) in `keys` that meant a library asset become "@Library/Name". */

// Hover card for tags in the text, the "@name" outputs and the extra inputs:
//   [type icon] @name
//   image_2 (the slot it fills on the target)
//   file path / source

/** Preview media for an extra input's source node (core loaders only; files in ComfyUI's input folder). */
export function extraMedia(extra) {
  const src = extra.src;
  const type = typeId(src?.comfyClass ?? src?.type);
  if ((type === "ReferenceImage" || type === "ReferenceVideo" || type === "ReferenceAudio") && extra.name) {
    const asset = library.resolve(extra.name).asset;
    if (asset) return { asset };
  }
  const file = { LoadImage: "image", LoadVideo: "file", LoadAudio: "audio" }[type];
  const value = file && getWidget(src, file)?.value;
  return value ? { url: nodePreviewUrl(src, value) ?? viewUrl(value), file: value } : {};
}

/** The image a Load Image node shows itself: its URL carries a cache-buster ("&rand="), so a file
 * replaced under the same name (re-upload, mask editor, paste) shows its new content. Only when it
 * belongs to the node's current file; otherwise null. */
function nodePreviewUrl(src, value) {
  const url = src?.imgs?.[0]?.src;
  if (!url) return null;
  try {
    const q = new URL(url, location.href).searchParams;
    const name = String(value).replace(/\s*\[(input|output|temp)\]$/, "");
    const parts = name.split("/");
    return q.get("filename") === parts.pop() && (q.get("subfolder") ?? "") === parts.join("/") ? url : null;
  } catch {
    return null;
  }
}

/** Hover/chip text for a tag whose plugged-in file was unplugged. */
export const unpluggedText = (claim) => {
  const file = `${claim?.file ?? "its file"}${claim?.from ? ` (${claim.from})` : ""}`;
  return claim?.muted ? `Not used: ${file} is muted. Unmute it, or pick another file.`
    : `Not connected: ${file} was unplugged. Plug it back in, or pick another file.`;
};

export const OUTPUT_TYPE = { image: "IMAGE", video: "VIDEO", audio: "AUDIO" };

/** Tag carried by a Reference Prompt output ("@Buttons" -> "Buttons", "@Lib_02/Buttons"), or null for "text". */
export function outputAssetName(out) {
  const n = out?.name;
  return typeof n === "string" && n.startsWith("@") ? n.slice(1) : null;
}

/**
 * The library asset an "@name" output carries: the one recorded when the output was made (so it
 * can't drift to another file of the same name, e.g. after a change in another workflow tab), else
 * by name. Returns a library.resolve()-style { status, asset, lib }, or null for non-asset outputs.
 */
export function outputAsset(node, out) {
  const name = outputAssetName(out);
  if (name == null || extraOutputKey(node, out)) return null;
  const libs = enabledLibs(node);
  const a = library.byId(node?.properties?.tp_out?.[out.name]);
  if (!a) return library.resolve(name, libs);
  return { asset: a, lib: library.lib(a.library), status: !libs.has(a.library) ? "off" : a.exists === false ? "missing" : "ok" };
}

/** The output that carries all tagged images as one batch (frontend-only, like the "@name" outputs). */
export const BATCH_OUTPUT = "images";
export const isBatchOutput = (out) => out?.name === BATCH_OUTPUT && out?.type === "IMAGE";

/**
 * The claim key of an "@name" output that carries a plugged-in file (properties.tp_xout), or null for
 * library outputs. Plugged-in files get outputs too, so each tagged file can be resized or batched by hand.
 */
export const extraOutputKey = (node, out) => {
  const key = node?.properties?.tp_xout?.[out?.name];
  return typeof key === "string" ? key : null;
};

/** Records which asset an output carries (properties.tp_out, saved with the workflow). */
export function setOutputAsset(node, out, asset) {
  node.properties ??= {};
  node.properties.tp_out = { ...(node.properties.tp_out ?? {}), [out.name]: asset.id };
}

/** Renames an "@name" output, keeping its recorded asset. */
export function renameOutput(node, out, name) {
  const ids = { ...(node.properties?.tp_out ?? {}) };
  const id = ids[out.name];
  delete ids[out.name];
  out.name = name;
  if (out.label) out.label = name;
  if (id) ids[name] = id;
  node.properties ??= {};
  node.properties.tp_out = ids;
}

/**
 * How many auto-grow ports of a kind the node accepts (e.g. 14 images for Nano Banana 2.1). Many API
 * nodes nest their inputs under a model choice (a dynamic combo) whose options differ: Seedream 5.0
 * pro takes 10 images, 5.0 lite 14. The option selected on the node counts; if it can't be told, the
 * largest of all options.
 */
export function autogrowMax(uiNode, kind) {
  const def = nodeDefOf(uiNode)?.input;
  if (!def) return null;
  let max = null;
  const re = new RegExp(`^${kind}_\\d+$`);
  const walk = (v, prefix) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v.names) && v.names.some((n) => re.test(n))) max = Math.max(max ?? 0, v.names.length);
    for (const [key, x] of Object.entries(v)) {
      if (Array.isArray(x) && x[0] === "COMFY_DYNAMICCOMBO_V3" && Array.isArray(x[1]?.options)) {
        // Its widget is named by the path ("model", "model.mode", ...); only the chosen option's inputs exist.
        const name = `${prefix}${key}`;
        const value = getWidget(uiNode, name)?.value;
        const chosen = x[1].options.filter((o) => o?.key === value);
        for (const o of chosen.length ? chosen : x[1].options) walk(o?.inputs, `${name}.`);
      } else {
        walk(x, prefix);
      }
    }
  };
  walk(def, "");
  return max;
}

/** Every Reference Prompt node in the open workflow, including those inside subgraphs. */
export function allPromptNodes() {
  const out = new Set();
  for (const g of allGraphs()) for (const n of nodesOf(g)) if (isTaggedPrompt(n)) out.add(n);
  return [...out];
}
