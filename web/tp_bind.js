// Tagged Prompt: queue-time binding of tags to the target's ports. Placement comes from the same
// core as the canvas (placeTags in tp_plan.js), fed from the API prompt.
import { assetKind, isPromptKey, KINDS, library, LOADERS, mediaPorts, mentionRe, mentionsIn, portNum, tagKey } from "./common.js";
import { nodeForExecId, outputTypeOf } from "./compat.js";
import {
  apiSourceName, autogrowMax, claimsOf, enabledLibs, EXTRA_RE, isBefore, NODE_TYPE, outputAsset, unpluggedText,
} from "./tp_model.js";
import { claimSpec, placeTags } from "./tp_plan.js";

/**
 * The nodes that produce a prompt input's text: the source node, and further up every node feeding
 * it through a STRING output (concat, replace, ...), stopping at Tagged Prompts. Head first.
 */
function promptChain(output, link) {
  const chain = [];
  const walk = (v, depth) => {
    if (!Array.isArray(v) || depth > 12) return;
    const id = String(v[0]);
    const n = output[id];
    if (!n || chain.includes(id)) return;
    if (n.class_type !== NODE_TYPE && outputTypeOf(n.class_type, v[1]) !== "STRING") return;
    chain.push(id);
    if (n.class_type === NODE_TYPE) return; // its text is the end of the chain
    for (const x of Object.values(n.inputs ?? {})) walk(x, depth + 1);
  };
  walk(link, 0);
  return chain;
}

const stringsOf = (node) => Object.values(node?.inputs ?? {}).filter((x) => typeof x === "string");

/**
 * For every node with auto-grow media ports in the API prompt:
 *   1. add a hidden Library Image/Video/Audio loader for each @tag that is in the library but not
 *      wired yet, and wire plugged-in files, on the ports placeTags picks;
 *   2. rewrite @tags in its prompt (wherever along the string chain they were typed) to "image N" /
 *      "Video N" / "Audio N" (N = rank among the connected ports of that kind).
 * A prompt chain read only by this target is rewritten in place; a shared one is copied per target
 * (numbering can differ). The canvas keeps its @tags.
 */
export function bindPrompt(output) {
  const errors = [];
  // Ids for added nodes can never be canvas ids, so progress and errors never point at a wrong node.
  let added = 0;
  const newId = (kind) => {
    let id;
    do id = `${kind}_${++added}`; while (output[id]);
    return id;
  };
  const cloned = new Set();

  // One hidden loader per library file, shared by every target and output that uses it.
  const loaders = new Map();
  const loaderFor = (asset) => {
    if (!loaders.has(asset.id)) {
      const loader = LOADERS[assetKind(asset)];
      const loaderId = newId("libimg");
      output[loaderId] = {
        class_type: loader.type,
        inputs: { [loader.pathKey]: asset.path, name: asset.name },
        _meta: { title: `@${asset.name}` },
      };
      loaders.set(asset.id, loaderId);
    }
    return loaders.get(asset.id);
  };

  // 0. Tagged Prompt "@name" outputs exist only on the canvas (the server node has just "text"):
  //    point whatever reads them at the asset's loader instead.
  for (const [id, node] of Object.entries(output)) {
    if (node.class_type !== NODE_TYPE) continue;
    const uiNode = nodeForExecId(id);
    for (const consumer of Object.values(output)) {
      for (const [k, v] of Object.entries(consumer.inputs ?? {})) {
        if (!Array.isArray(v) || String(v[0]) !== String(id) || !(v[1] > 0)) continue;
        const out = uiNode?.outputs?.[v[1]];
        const outName = out?.name;
        const res = (uiNode && out && outputAsset(uiNode, out)) || { status: "unknown", asset: null };
        if (res.status !== "ok") {
          errors.push(`${uiNode?.title ?? "Tagged Prompt"}: output ${outName ?? `#${v[1]}`} ${problem(res, uiNode)}`);
          continue;
        }
        consumer.inputs[k] = [loaderFor(res.asset), 0];
      }
    }
  }

  for (const [id, node] of Object.entries(Object.assign({}, output))) {
    const inputs = node.inputs ?? {};
    const uiNode = nodeForExecId(id);
    // Port prefix per kind, from the canvas node or (if it isn't on the canvas) the API inputs.
    const prefixes = {};
    for (const kind of KINDS) {
      const name = (uiNode ? mediaPorts(uiNode, kind)[0]?.inp.name : null)
        ?? Object.keys(inputs).find((k) => portNum(k, kind) != null);
      if (name) prefixes[kind] = name.replace(/\d+$/, "");
    }
    if (!Object.keys(prefixes).length) continue;
    const label = uiNode?.title ?? `node ${id}`;

    // The prompt: an input whose text (typed here, or produced upstream through string nodes) has
    // @tags, or (even without tags) one fed by a Tagged Prompt, whose plugged-in files need placing.
    const candidates = Object.keys(inputs).filter(isPromptKey).map((key) => {
      const v = inputs[key];
      const chain = Array.isArray(v) ? promptChain(output, v) : [];
      const texts = typeof v === "string" ? [v] : chain.flatMap((c) => stringsOf(output[c]));
      return { key, v, chain, texts, tps: chain.filter((c) => output[c].class_type === NODE_TYPE) };
    });
    const pick = candidates.find((c) => c.texts.some((t) => mentionsIn(t).length)) ?? candidates.find((c) => c.tps.length);
    if (!pick) continue;
    if (pick.tps.length > 1) {
      errors.push(`${label}: its prompt combines ${pick.tps.length} Tagged Prompts; use one Tagged Prompt per model node.`);
      continue;
    }
    const tpId = pick.tps[0] ?? null;
    const src = tpId ? output[tpId] : null;
    const tpUi = tpId ? nodeForExecId(tpId) : null;

    const wired = (kind) => Object.entries(inputs)
      .map(([k, v]) => ({ v, n: portNum(k, kind) }))
      .filter((p) => p.n != null && Array.isArray(p.v))
      .sort((a, b) => a.n - b.n);
    const loaderAsset = new Map([...loaders].map(([assetId, loaderId]) => [loaderId, assetId]));
    const kinds = {};
    for (const kind of KINDS) {
      const ports = wired(kind);
      const assetPorts = new Map();
      for (const p of ports) {
        const a = loaderAsset.get(String(p.v[0]));
        if (a && !assetPorts.has(a)) assetPorts.set(a, p.n); // a "@name" output wired by hand
      }
      kinds[kind] = { has: !!prefixes[kind], max: autogrowMax(uiNode, kind), used: new Set(ports.map((p) => p.n)),
        assetPorts, portName: prefixes[kind] ?? null };
    }

    // Plugged-in files of the Tagged Prompt, as they are in the API prompt.
    const extras = [];
    for (const inp of tpUi?.inputs ?? []) {
      const m = EXTRA_RE.exec(inp.name);
      const link = m && src.inputs?.[inp.name];
      if (Array.isArray(link)) extras.push({ kind: m[1], input: inp.name, link, before: isBefore(tpUi, inp.name) });
    }
    // Names of non-library files: the Tagged Prompt's claims; for a prompt typed into the target
    // itself, the files wired into it by hand answer to their names.
    let claims;
    if (tpUi) claims = claimSpec(claimsOf(tpUi));
    else {
      claims = new Map();
      for (const kind of KINDS) {
        for (const p of wired(kind)) {
          const name = !loaderAsset.has(String(p.v[0])) && apiSourceName(output[p.v[0]]);
          if (name && !claims.has(tagKey(name))) claims.set(tagKey(name), { claim: { name }, plugged: true, input: null, hand: p.n, kind });
        }
      }
    }

    const libs = tpUi ? enabledLibs(tpUi) : null;
    const tokens = pick.texts.flatMap(mentionsIn);
    const plan = placeTags({ title: label, kinds, extras, claims, tokens, resolve: (tok) => library.resolve(tok, libs) });

    // Problems stop the queue (one message per kind of overflow).
    const said = new Set();
    const say = (msg) => !said.has(msg) && (said.add(msg), errors.push(msg));
    for (const r of plan.rows) {
      if (r.status === "unplugged") say(`${label}: @${r.tok}: ${unpluggedText(r.claim)}`);
      // Without a Tagged Prompt, an unknown "@word" typed into the model's own prompt is just text.
      else if (!r.claim && r.status !== "ok" && (tpUi || r.status !== "unknown")) say(`${label}: @${r.tok} ${problem(r, tpUi)}`);
      else if (r.unsupported) say(`${label}: @${r.tok} can't be placed: ${r.unsupported}.`);
    }
    for (const x of plan.extras) if (x.unsupported) say(`${label}: ${tpUi?.title ?? "Tagged Prompt"} ${x.input} can't be placed: ${x.unsupported}.`);

    // 1. wire library files and plugged-in files onto the ports the plan picked
    for (const r of plan.rows) {
      if (r.status === "ok" && r.asset && !r.wiredByHand && !r.shared && r.n && prefixes[r.kind]) {
        inputs[`${prefixes[r.kind]}${r.n}`] = [loaderFor(r.asset), 0];
      }
    }
    for (const x of plan.extras) if (x.n && prefixes[x.kind]) inputs[`${prefixes[x.kind]}${x.n}`] = x.link;

    // 2. rewrite @tags to their labels
    const labelOf = new Map(plan.rows.filter((r) => r.ok && r.label).map((r) => [tagKey(r.tok), r.label]));
    const rewrite = (text) => text.replace(mentionRe(), (all, pre, tok) => {
      const lbl = labelOf.get(tagKey(tok));
      return lbl == null ? all : `${pre}${lbl}`;
    });
    const rewriteNode = (n) => {
      for (const [k, v] of Object.entries(n.inputs ?? {})) if (typeof v === "string") n.inputs[k] = rewrite(v);
    };
    if (typeof pick.v === "string") {
      inputs[pick.key] = rewrite(pick.v);
    } else if (pick.chain.every((c) => refCount(output, c) === 1)) {
      // Only this target reads the chain: rewrite it in place (keeps the ids).
      for (const c of pick.chain) rewriteNode(output[c]);
    } else {
      // Shared: this target gets its own rewritten copy of the chain (numbering differs per target).
      const copy = new Map(pick.chain.map((c) => [c, newId("tpcopy")]));
      for (const [c, cid] of copy) {
        const clone = structuredClone(output[c]);
        for (const [k, v] of Object.entries(clone.inputs ?? {})) {
          if (Array.isArray(v) && copy.has(String(v[0]))) clone.inputs[k] = [copy.get(String(v[0])), v[1]];
        }
        rewriteNode(clone);
        output[cid] = clone;
        cloned.add(c);
      }
      inputs[pick.key] = [copy.get(pick.chain[0]), pick.v[1]];
    }
  }
  // The server-side Tagged Prompt has only "text": its extra inputs were moved onto the targets above.
  for (const node of Object.values(output)) {
    if (node.class_type !== NODE_TYPE) continue;
    for (const k of Object.keys(node.inputs ?? {})) if (EXTRA_RE.test(k)) delete node.inputs[k];
  }
  // Originals that every target now reads through a copy are dead weight in the API prompt (a chain
  // frees its upstream nodes one by one, so repeat until nothing changes).
  for (let again = true; again;) {
    again = false;
    for (const id of cloned) {
      if (output[id] && refCount(output, id) === 0) {
        delete output[id];
        again = true;
      }
    }
  }
  return errors;
}

/** Why a tag can't be used: the end of an error sentence. */
export function problem(res, tpUi) {
  if (res.status === "off") return `is in ${res.lib?.name}, which is switched off in ${tpUi?.title ?? "this node"}.`;
  if (res.status === "missing") return `points to a file that no longer exists (${res.asset.path}). Replace or remove it in the library.`;
  return "is not in any enabled library.";
}

/** How many inputs in the API prompt are wired to node `id`. */
function refCount(output, id) {
  let n = 0;
  for (const node of Object.values(output)) {
    for (const v of Object.values(node.inputs ?? {})) if (Array.isArray(v) && String(v[0]) === String(id)) n++;
  }
  return n;
}
