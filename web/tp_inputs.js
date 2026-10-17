// Tagged Prompt: auto-grow extra inputs (image_N / video_N / audio_N) kept in canonical order.
import { KINDS } from "./common.js";
import { linkById, reconnectorFor } from "./compat.js";
import { EXTRA_RE, isBefore, OUTPUT_TYPE } from "./tp_model.js";

/** Keeps exactly one free extra input of each kind at the end (auto-grow) and labels them First/Last. */
export function syncInputs(node) {
  if (!node.inputs || node._tpSyncing) return;
  node._tpSyncing = true;
  try {
    syncInputsNow(node);
  } finally {
    node._tpSyncing = false;
  }
}

function syncInputsNow(node) {
  let changed = false;
  const graph = node.graph;
  const linkOf = (inp) => linkById(graph, inp.link);

  // The one layout we keep: after the node's own inputs come image_1..n, video_1..n, audio_1..n,
  // where each kind has its plugged-in inputs numbered from 1 without gaps, then one free input.
  const current = node.inputs.map((inp, i) => ({ inp, i, m: EXTRA_RE.exec(inp.name) })).filter((x) => x.m);
  const desired = [];
  for (const kind of KINDS) {
    const linked = current.filter((x) => x.m[1] === kind && linkOf(x.inp)).sort((a, b) => a.m[2] - b.m[2]);
    linked.forEach((x, k) => desired.push({ name: `${kind}_${k + 1}`, type: OUTPUT_TYPE[kind], from: x }));
    desired.push({ name: `${kind}_${linked.length + 1}`, type: OUTPUT_TYPE[kind], from: null });
  }
  const first = node.inputs.length - current.length;
  // First position where the layout differs; everything before it is left untouched.
  let k0 = desired.findIndex((d, k) => {
    const x = current[k];
    return !x || x.i !== first + k || x.inp.name !== d.name || !!linkOf(x.inp) !== !!d.from || (d.from && d.from !== x);
  });
  if (k0 === -1 && current.length > desired.length) k0 = desired.length;

  if (k0 !== -1 && graph) {
    // Rebuild from k0 through LiteGraph's own remove/add/connect, which keep links and Nodes 2.0's
    // slot store consistent (moving or renaming input objects in place does not). Each wire is
    // re-created from its real source (a node or the subgraph's input) and keeps its reroute.
    const plan = desired.slice(k0).map((d) => ({ ...d, reconnect: d.from ? reconnectorFor(graph, linkOf(d.from.inp)) : null }));
    if (plan.some((p) => p.from && !p.reconnect)) {
      // A source we can't re-create: leave the layout as it is rather than drop a wire.
      if (!node._tpWarned) console.warn("[TaggedPrompt] left extra inputs unsorted: a link's source can't be reconnected");
      node._tpWarned = true;
    } else {
      const before = {};
      for (const d of desired) if (d.from && !isBefore(node, d.from.inp.name)) before[d.name] = false; // follows its wire
      for (const x of current.slice(k0).sort((a, b) => b.i - a.i)) node.removeInput(x.i);
      for (const p of plan) {
        node.addInput(p.name, p.type);
        p.reconnect?.(node, node.inputs.length - 1);
      }
      node.properties ??= {};
      node.properties.tp_before = before;
      changed = true;
    }
  }
  for (const inp of node.inputs) {
    const m = EXTRA_RE.exec(inp.name);
    if (!m) continue;
    const label = inp.link == null ? inp.name : `${inp.name} ${isBefore(node, inp.name) ? "⇤" : "⇥"}`;
    if (inp.label !== label) {
      inp.label = label;
      changed = true;
    }
  }
  if (changed) node.setDirtyCanvas?.(true, true);
}
