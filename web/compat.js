// Every place this pack relies on ComfyUI frontend internals (LiteGraph / Nodes 2.0 details that
// aren't a documented extension API) lives here, so a frontend update breaks one file, not ten.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

/** The oldest ComfyUI frontend this pack is known to work with (keep in step with pyproject.toml). */
export const MIN_FRONTEND = "1.55.18";

const versionParts = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
/** True if version `v` ("1.54.2") is older than `min`. */
export function versionBelow(v, min) {
  const a = versionParts(v), b = versionParts(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Whether Nodes 2.0 is on: true / false, or null when this frontend doesn't say (nothing is claimed then). */
export function nodes2Enabled() {
  try {
    const v = app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled");
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

let queueHooked = false;

/** What about this ComfyUI keeps the pack from working: messages for the user ([] when all is well). */
export function environmentProblems() {
  const out = [];
  const v = window.__COMFYUI_FRONTEND_VERSION__;
  if (v && versionBelow(v, MIN_FRONTEND)) {
    out.push(`This ComfyUI's interface (frontend ${v}) is older than the Reference Library needs (${MIN_FRONTEND}). Update ComfyUI.`);
  }
  if (nodes2Enabled() === false) {
    out.push("The Reference Prompt needs Nodes 2.0: on classic nodes its thumbnails, @ list and tag colors don't work. "
      + "Turn on Settings → Comfy → Nodes 2.0 → Modern Node Design (Nodes 2.0).");
  }
  if (!queueHooked) {
    out.push("This ComfyUI version queues prompts in a way the Reference Library doesn't know: @tags would be sent as "
      + "typed, without their files. Update the Reference Library pack.");
  }
  return out;
}

/** The graph shown on the canvas (a subgraph while you're inside one). */
export const currentGraph = () => app.canvas?.graph ?? app.graph;

/** A graph's nodes. */
export const nodesOf = (graph) => graph?._nodes ?? graph?.nodes ?? [];

/** A link by id; `graph.links` is a Map in newer frontends and a plain object in older ones. */
export const linkById = (graph, id) =>
  id == null ? null : (graph?.links?.get?.(id) ?? graph?.links?.[id] ?? graph?.getLink?.(id) ?? null);

/**
 * A function that re-creates `link` into (targetNode, targetSlotIndex) from the same source, or
 * null if the source can't be reconnected. Handles normal nodes and a subgraph's input (a virtual
 * node), and keeps the link's reroute (parentId).
 */
export function reconnectorFor(graph, link) {
  if (!link) return null;
  const inputNode = graph?.inputNode;
  if (inputNode && String(link.origin_id) === String(inputNode.id)) {
    const slot = inputNode.slots?.[link.origin_slot];
    return slot ? (node, i) => slot.connect(node.inputs[i], node, link.parentId) : null;
  }
  const origin = graph?.getNodeById(link.origin_id);
  return origin ? (node, i) => origin.connect(link.origin_slot, node, i, link.parentId) : null;
}

/** All links of a graph (Map or plain object). */
const linksOf = (graph) => (graph?.links instanceof Map ? [...graph.links.values()] : Object.values(graph?.links ?? {}));

/**
 * The graph containing a subgraph and the node that instances it. A subgraph definition used by
 * several nodes is ambiguous; the first instance wins.
 */
export function parentOf(graph) {
  for (const g of allGraphs()) for (const n of nodesOf(g)) if (n.subgraph === graph) return { graph: g, node: n };
  return null;
}

/**
 * Where a link really comes from, across subgraph boundaries: a subgraph's input is followed out
 * to what feeds the subgraph node, a subgraph node's output in to what feeds it inside.
 * Returns { graph, node, slot } (slot = output index) or null if nothing is connected.
 */
export function originOf(graph, link, depth = 0) {
  if (!link || !graph || depth > 8) return null;
  if (graph.inputNode && String(link.origin_id) === String(graph.inputNode.id)) {
    const p = parentOf(graph);
    const inp = p?.node.inputs?.[link.origin_slot];
    return inp?.link != null ? originOf(p.graph, linkById(p.graph, inp.link), depth + 1) : null;
  }
  const node = graph.getNodeById(link.origin_id);
  if (!node) return null;
  if (node.subgraph) {
    const sg = node.subgraph;
    const inner = linksOf(sg).find((l) => String(l.target_id) === String(sg.outputNode?.id) && l.target_slot === link.origin_slot);
    return inner ? originOf(sg, inner, depth + 1) : null;
  }
  return { graph, node, slot: link.origin_slot };
}

/** The real inputs an output slot feeds, across subgraph boundaries: [{ graph, node, slot }] (slot = input index). */
export function targetsOf(graph, node, slot, depth = 0) {
  const out = [];
  for (const id of node?.outputs?.[slot]?.links ?? []) out.push(...linkTargets(graph, linkById(graph, id), depth));
  return out;
}

function linkTargets(graph, link, depth) {
  if (!link || depth > 8) return [];
  if (graph.outputNode && String(link.target_id) === String(graph.outputNode.id)) {
    const p = parentOf(graph);
    return p ? targetsOf(p.graph, p.node, link.target_slot, depth + 1) : [];
  }
  const t = graph.getNodeById(link.target_id);
  if (!t) return [];
  if (t.subgraph) {
    const sg = t.subgraph;
    return linksOf(sg).filter((l) => String(l.origin_id) === String(sg.inputNode?.id) && l.origin_slot === link.target_slot)
      .flatMap((l) => linkTargets(sg, l, depth + 1));
  }
  return [{ graph, node: t, slot: link.target_slot }];
}

/** Output types a node type declares (from the server's object_info), e.g. "STRING". */
export const outputTypeOf = (classType, slot) => window.LiteGraph?.registered_node_types?.[classType]?.nodeData?.output?.[slot] ?? null;

/** Muted ("never") nodes don't run and aren't in the API prompt. */
export const isMuted = (node) => node?.mode === 2;

/** The graph plus every subgraph nested in it, each once. */
export function allGraphs(root = app.graph) {
  const seen = new Set();
  const walk = (g) => {
    if (!g || seen.has(g)) return;
    seen.add(g);
    for (const n of nodesOf(g)) if (n.subgraph) walk(n.subgraph);
  };
  walk(root);
  return [...seen];
}

/**
 * The canvas node for an id in the API prompt. Nodes inside subgraphs are sent with a path of
 * ids ("5:2" = node 2 inside subgraph node 5), so walk down one subgraph per segment.
 */
export function nodeForExecId(execId) {
  let graph = app.graph;
  let node = null;
  for (const part of String(execId).split(":")) {
    node = graph?.getNodeById(part) ?? graph?.getNodeById(Number(part)) ?? null;
    if (!node) return null;
    graph = node.subgraph ?? null;
  }
  return node;
}

/** The node a DOM element belongs to (Nodes 2.0 renders nodes as `.lg-node[data-node-id]`). */
export function nodeFromElement(el) {
  const id = el?.closest?.(".lg-node")?.dataset?.nodeId;
  return id != null ? currentGraph()?.getNodeById(id) ?? null : null;
}

/** The port (slot) element under a DOM element, and whether it's an output. */
export const slotElementOf = (el) => el?.closest?.(".lg-node .lg-slot") ?? null;
export const isOutputSlot = (slotEl) => slotEl.classList.contains("lg-slot--output");

/**
 * Runs `fn(output)` on every API prompt the frontend builds (queueing, Export (API)) before it is
 * used. `fn` returns a list of error messages; with any error the prompt can't be queued and can't
 * be written out as JSON (Export (API)). The workflow itself still exports and saves.
 */
export function wrapGraphToPrompt(fn) {
  // Wrap once, even if the pack is loaded twice (another extension may wrap graphToPrompt after us,
  // so a marker on the function wouldn't be seen).
  if (window.__libraryImageQueueHook) {
    queueHooked = true; // by the copy of the pack that loaded first
    return;
  }
  // Internals this hook stands on: without them, say so (environmentProblems) instead of failing quietly.
  if (typeof app.graphToPrompt !== "function" || typeof api.queuePrompt !== "function") return;
  window.__libraryImageQueueHook = true;
  queueHooked = true;
  const orig = app.graphToPrompt;
  const wrapped = async function (...args) {
    const res = await orig.apply(this, args);
    if (res?.output) {
      const errors = await fn(res.output);
      if (errors?.length) {
        blocked.set(res.output, errors);
        blockedJson.set(JSON.stringify(res.output), errors);
        refuseJson(res.output, errors);
      }
    }
    return res;
  };
  app.graphToPrompt = wrapped;

  const queue = api.queuePrompt;
  api.queuePrompt = async function (number, data, ...rest) {
    const out = data?.output;
    // By object first: a blocked prompt refuses to be turned into JSON (refuseJson).
    const errors = out && (blocked.get(out) ?? blockedJson.get(JSON.stringify(out)));
    if (errors) throw new Error(errors.join("\n"));
    return queue.call(this, number, data, ...rest);
  };
}

/**
 * Makes an API prompt with tag problems fail when it is written out as JSON, which is how Export (API)
 * saves it: the file would hold raw @tags and half-wired files, and nobody would see the notice once
 * it is shared. The frontend builds the workflow and the API prompt in one call for both Export and
 * Export (API), so the build itself can't be refused: only the API prompt is, and only as JSON.
 * (Hidden from loops over the prompt's nodes: not enumerable.)
 */
function refuseJson(output, errors) {
  Object.defineProperty(output, "toJSON", {
    enumerable: false,
    configurable: true,
    value() {
      throw new Error(`Not exported: this workflow's Reference Prompt tags have problems. ${errors.join(" ")}`);
    },
  });
}

// Prompts with tag problems, by object and (if the queue copies the prompt) by content.
const blocked = new WeakMap();
/** The tag problems found in a built API prompt (null if none): queueing it is refused. */
export const problemsOf = (output) => blocked.get(output) ?? null;
const blockedJson = new Map();
setInterval(() => blockedJson.clear(), 60_000); // only needed between building and queueing

/** The rendered element of a node on the canvas, if any. */
export const elementOfNode = (node) => document.querySelector(`.lg-node[data-node-id="${node.id}"]`);

/** The node type's definition from the server (object_info), e.g. to read auto-grow port limits. */
export const nodeDefOf = (node) => node?.constructor?.nodeData ?? null;

/** A widget's DOM element (DOM widgets and classic multiline widgets). */
export const widgetElement = (widget) => widget?.element ?? widget?.inputEl ?? null;
