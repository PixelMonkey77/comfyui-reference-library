// Tagged Prompt: where every tag and plugged-in file lands on the target. One placement core
// (placeTags) is fed from the canvas (planFor: strip, ink, cards) and from the API prompt at queue
// time (tp_bind.js), so what the node shows is what runs.
import { assetKind, getWidget, KINDS, mediaLabel, mediaPorts, mentionsIn, splitTag, tagKey } from "./common.js";
import { currentGraph } from "./compat.js";
import {
  autogrowMax, claimsOf, extraInputs, isTaggedPrompt, localSources, outputAsset, resolveFor, sourceOfInput,
  targetOf,
} from "./tp_model.js";

/**
 * Places tags and plugged-in files on a target's auto-grow ports. Per kind, ports already wired keep
 * their numbers; then First extras, library tags (mention order) and Last extras take the lowest
 * free numbers. Labels ("image 2", "Video 1") are ranks among the used ports; slot names
 * ("image_2") are the port numbers.
 *
 * spec = {
 *   title:   target title for messages (null: no target, nothing is limited),
 *   kinds:   { image: { has, max, used: Set<n>, assetPorts: Map<assetId, n>, portName }, video, audio },
 *   extras:  [{ kind, before, input, ... }] plugged-in files in input order (annotated with n, label, unsupported),
 *   claims:  Map<tag key, { claim, plugged, input, hand, kind }> names of non-library files,
 *   tokens:  tags in mention order,
 *   resolve: tok -> library.resolve() result for this node's enabled libraries,
 * }
 * Returns { rows, extras }; each row: { tok, kind, status, asset, lib, claim, extra, wiredByHand,
 * shared, n, slot, label, unsupported, ok, state }.
 */
export function placeTags(spec) {
  const per = spec.kinds;
  const take = (item) => {
    const p = per[item.kind];
    if (!p) return (item.unsupported = `unknown file type`);
    if (!p.has) return (item.unsupported = `${spec.title} has no ${item.kind} inputs`);
    let n = 1;
    while (p.used.has(n)) n++;
    if (p.max != null && n > p.max) return (item.unsupported = `${spec.title} takes at most ${p.max} ${item.kind} inputs`);
    p.used.add(n);
    item.n = n;
  };
  const extraByInput = new Map(spec.extras.map((x) => [x.input, x]));
  for (const x of spec.extras) if (x.before) take(x);

  const seen = new Set();
  const byAsset = new Map(); // asset id -> row that took its slot ("@Biscuit" and "@Library_01/Biscuit" share)
  const rows = [];
  for (const tok of spec.tokens) {
    const key = tagKey(tok);
    if (seen.has(key)) continue;
    seen.add(key);
    // A plain name claimed by a plugged-in / hand-wired file means that file, even unplugged.
    const c = splitTag(tok).lib ? null : spec.claims.get(key);
    if (c) {
      const extra = c.input != null ? extraByInput.get(c.input) : null;
      const plugged = c.plugged && (c.input == null || !!extra);
      const row = { tok, asset: null, status: plugged ? "ok" : "unplugged", claim: c.claim, kind: c.kind ?? null };
      if (plugged && extra) row.extra = extra; // numbered with the extras
      else if (plugged) Object.assign(row, { wiredByHand: true, n: c.hand });
      rows.push(row);
      continue;
    }
    const res = spec.resolve(tok);
    const asset = res.asset;
    const row = { tok, asset, status: res.status, lib: res.lib, kind: asset ? assetKind(asset) : null };
    const handN = asset ? per[row.kind]?.assetPorts.get(asset.id) : null;
    if (res.status === "ok" && handN != null) Object.assign(row, { wiredByHand: true, n: handN });
    else if (res.status === "ok") {
      const prev = byAsset.get(asset.id);
      if (prev) Object.assign(row, { n: prev.n, unsupported: prev.unsupported, shared: true });
      else {
        take(row);
        byAsset.set(asset.id, row);
      }
    }
    rows.push(row);
  }
  for (const x of spec.extras) if (!x.before) take(x);

  const label = (item) => {
    const n = item.extra ? item.extra.n : item.n;
    if (!n || !per[item.kind]) return;
    const used = [...per[item.kind].used].sort((a, b) => a - b);
    item.n = n;
    item.slot = `${item.kind}_${n}`;
    item.label = mediaLabel(per[item.kind].portName, item.kind, used.indexOf(n) + 1);
  };
  for (const r of rows) {
    if (r.extra) r.unsupported = r.extra.unsupported;
    label(r);
    r.ok = !!((r.wiredByHand || r.extra || r.status === "ok") && !r.unsupported);
    // Ink: blue ok, purple file missing, grey struck-through library off, red everything else.
    r.state = r.ok ? "ok" : r.status === "missing" ? "missing" : r.status === "off" ? "off" : "bad";
  }
  spec.extras.forEach(label);
  return { rows, extras: spec.extras };
}

/** Claims in the core's form, from claimsOf() on the canvas. */
export const claimSpec = (claims) => new Map([...claims].map(([key, { claim, source }]) => [key, {
  claim, plugged: !!source, input: source?.extra?.input ?? null, hand: source?.hand ?? null, kind: source?.kind ?? claim.kind,
}]));

/** The plan for a Tagged Prompt on the canvas: { rows, extras, target } (see placeTags). */
export function planFor(node, text = getWidget(node, "text")?.value ?? "") {
  const target = targetOf(node);
  const graph = target?.graph ?? currentGraph();
  const kinds = {};
  for (const kind of KINDS) {
    const ports = target ? mediaPorts(target, kind) : [];
    const used = new Set();
    const assetPorts = new Map(); // library asset id -> port, for Tagged Prompt "@name" outputs wired by hand
    for (const p of ports.filter((x) => x.inp.link != null)) {
      used.add(p.n);
      const o = sourceOfInput(graph, p.inp);
      if (!o || !isTaggedPrompt(o.node)) continue;
      const out = o.node.outputs?.[o.slot];
      const a = out ? outputAsset(o.node, out)?.asset : null;
      if (a && !assetPorts.has(a.id)) assetPorts.set(a.id, p.n);
    }
    kinds[kind] = { portName: ports[0]?.inp.name ?? null, has: !target || ports.length > 0, used, assetPorts,
      max: target ? autogrowMax(target, kind) : null };
  }
  const extras = extraInputs(node);
  const claims = claimsOf(node, localSources(node, extras, target));
  for (const { claim, source } of claims.values()) if (source?.extra) source.extra.tag = claim.name;
  const plan = placeTags({
    title: target?.title ?? null, kinds, extras, claims: claimSpec(claims),
    tokens: mentionsIn(text), resolve: (tok) => resolveFor(node, tok),
  });
  return { ...plan, target, text };
}
