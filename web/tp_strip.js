// Reference Prompt: the strip of tagged assets, the header, and the @name outputs.
import { assetKind, getWidget, KINDS, library, mentionsIn, splitTag, tagKey } from "./common.js";
import { currentGraph } from "./compat.js";
import { openAddDialog, toggleLibraryPanel } from "./dialogs.js";
import { highlightTag, jumpToTag, renderInk, sweepInks } from "./tp_ink.js";
import { syncInputs } from "./tp_inputs.js";
import {
  BATCH_OUTPUT, claimedKeys, enabledKinds, enabledLibs, extraMedia, extraOutputKey, isBatchOutput, KIND_LABEL,
  libToken, OUTPUT_TYPE, outputAsset, outputAssetName, renameOutput, setOutputAsset, syncClaims, unpluggedText,
} from "./tp_model.js";
import { restoreTags, snapshotTags } from "./tp_pins.js";
import { planFor, staleReason } from "./tp_plan.js";
import { popup } from "./tp_popup.js";
import { mediaThumb } from "./tp_style.js";
import { h, icon } from "./ui.js";

export function setLibEnabled(node, libId, on) {
  // Pinned both ways: switching a library off greys its tags ("@Library_02/Biscuit") instead of
  // letting a same-name file elsewhere answer them; switching one on can't take tags over either.
  const snap = snapshotTags();
  node.properties ??= {};
  const off = new Set(node.properties.tp_libs_off ?? []);
  if (on) off.delete(libId);
  else off.add(libId);
  node.properties.tp_libs_off = [...off];
  node.graph?.change?.();
  restoreTags(snap);
  refreshStrip(node);
}

export const strips = new Map(); // node -> { el, sig }

export const stripTimers = new Map(); // node -> timeout

export function scheduleStrip(node) {
  clearTimeout(stripTimers.get(node));
  stripTimers.set(node, setTimeout(() => refreshStrip(node), 120));
}

export function refreshStrip(node) {
  const s = strips.get(node);
  if (!s || !node.graph) return;
  if (!s.el.isConnected || !headers.get(node)?.el.isConnected) mountOwnElements(node);
  syncClaims(node);
  refreshHeader(node);
  syncInputs(node);
  const plan = planFor(node); // once per refresh, shared with the ink and the outputs
  syncOutputs(node, plan);
  renderInk(node, plan);
  // The tag being typed while the @ list is open gets no chip yet (like the ink, which stays neutral).
  const typing = popup.open && popup.state?.node === node ? tagKey(popup.state.mention.query) : null;
  const rows = plan.rows.filter((r) => !(typing && r.status === "unknown" && tagKey(r.tok) === typing));
  const { extras } = plan;
  const uses = mentionsIn(getWidget(node, "text")?.value).map(tagKey);
  const sig = JSON.stringify([rows.map((r) => [r.tok, r.label, r.state, r.status, r.unsupported, r.asset?.id, r.asset?.mtime, r.asset?.name]),
    extras.map((x) => [x.input, x.tag, x.before, x.label, x.unsupported, x.src?.id, extraMedia(x).url]),
    library.assets.length, library.libraries.map((l) => l.name), uses, typing]);
  if (sig === s.sig) return;
  s.sig = sig;

  s.el.replaceChildren();
  // Same order they take on the target: First extras, tags, Last extras.
  for (const x of extras) if (x.before) s.el.append(extraChip(node, x));
  for (const r of rows) {
    if (r.extra) continue; // shown as its extra-input chip
    if (r.shared) continue; // another tag for the same file already has a chip
    const chip = h("div", `tp-chip${r.state === "ok" ? "" : r.state === "bad" ? " tp-bad" : ` tp-${r.state}`}`);
    const libName = r.asset ? library.libName(r.asset.library) : "";
    // The tag itself isn't printed under the thumbnail (clicking finds it in the text); it leads the tooltip.
    chip.dataset.tag = `@${r.tok}`;
    chip.title = `@${r.tok}\n` + (r.state === "off" ? `In ${libName}, which is switched off in this node.`
      : r.state === "missing" ? `File not found: ${r.asset.path}`
      : r.unsupported ? `${r.asset.path}\n⚠ ${r.unsupported}`
      : r.asset ? `${libName} · ${r.asset.path}` : r.wiredByHand ? "Wired by hand"
      : r.status === "unplugged" ? unpluggedText(r.claim) : `@${r.tok} is not in the library`);
    if (r.asset && r.state !== "missing") {
      chip.append(mediaThumb(r.asset, 56, "tp-cthumb"));
    } else if (r.state === "missing") {
      const ph = h("div", "tp-cthumb tp-ph");
      ph.style.color = "var(--tp-tag-missing)";
      ph.append(icon("alert"));
      chip.append(ph);
    } else {
      chip.append(h("div", "tp-ph", { textContent: r.wiredByHand ? "⇢" : "?" }));
    }
    const idx = r.label ?? (r.state === "off" ? `${libName} is off` : r.state === "missing" ? "file missing"
      : r.unsupported ? `no ${r.kind} input` : r.status === "unplugged" ? (r.claim?.muted ? "muted" : "unplugged") : "unknown");
    chip.append(h("div", "tp-idx", { textContent: idx }));
    const key = tagKey(r.tok);
    const count = mentionsIn(getWidget(node, "text")?.value).filter((t) => tagKey(t) === key).length;
    chip.title += count > 1 ? `\nClick to cycle through its ${count} uses` : "\nClick to find it in the text";
    chip.onmouseenter = () => highlightTag(node, key);
    chip.onmouseleave = () => highlightTag(node, null);
    chip.onclick = (e) => {
      e.stopPropagation();
      jumpToTag(node, key);
    };
    s.el.append(keyboardChip(chip));
  }
  for (const x of extras) if (!x.before) s.el.append(extraChip(node, x));
  const add = h("button", "tp-add", { type: "button", textContent: "+", title: "Add images, videos or audio to the library" });
  add.onclick = (e) => {
    e.stopPropagation();
    openAddDialog({ node });
  };
  s.el.append(add);
  if (!rows.length && !extras.length) s.el.append(h("span", "tp-hint", { textContent: "Type @ in the prompt to tag a library file." }));
}

/** Thumbnail for a plugged-in (non-library) file: image preview, or a type icon. */
export function extraThumb(x, media, cls) {
  if (media.asset) return mediaThumb(media.asset, cls === "tp-thumb" ? 44 : 56, cls);
  const box = h("div", "tp-media");
  if (media.url && x.kind === "image") {
    const img = h("img", cls, { alt: "", src: media.url });
    img.onerror = () => (img.style.visibility = "hidden");
    box.append(img);
  } else {
    const ph = h("div", `${cls} tp-ph${x.kind === "audio" ? " tp-audio" : ""}`);
    ph.append(icon(x.kind));
    box.append(ph);
  }
  return box;
}

/** Chip for an extra (non-library) input, with its First/Last toggle. */
function extraChip(node, x) {
  const chip = h("div", `tp-chip tp-extra${x.unsupported ? " tp-bad" : ""}`);
  const media = extraMedia(x);
  chip.append(extraThumb(x, media, "tp-cthumb"));
  const tog = h("button", "tp-firstlast", { type: "button", textContent: x.before ? "⇤ First" : "Last ⇥" });
  tog.title = x.before
    ? "Placed before the library files (takes the first slots). Click to place it after them."
    : "Placed after the library files. Click to place it before them (first slots).";
  tog.onclick = (e) => {
    e.stopPropagation();
    node.properties ??= {};
    node.properties.tp_before = { ...(node.properties.tp_before ?? {}), [x.input]: !x.before };
    node.graph?.change?.();
    refreshStrip(node);
  };
  chip.dataset.tag = x.tag ? `@${x.tag}` : x.input;
  chip.append(tog, h("div", "tp-idx", { textContent: x.label ?? (x.unsupported ? `no ${x.kind} input` : "") }));
  chip.title = `${chip.dataset.tag}\n${x.input} ← ${x.src?.title ?? "?"}${media.file ? ` (${media.file})` : ""}\nNot in the library: used for this run only.`
    + (x.unsupported ? `\n⚠ ${x.unsupported}` : "");
  if (x.tag) {
    const key = tagKey(x.tag);
    chip.onmouseenter = () => highlightTag(node, key);
    chip.onmouseleave = () => highlightTag(node, null);
    chip.onclick = (e) => {
      e.stopPropagation();
      jumpToTag(node, key);
    };
  }
  return keyboardChip(chip);
}

/**
 * The node's outputs after "text":
 *   - "images": every tagged image as one batch, in the order they're numbered (added once);
 *   - one "@name" output per library file tagged in the text;
 *   - one "@name" output per plugged-in file (its tag), so each can be resized or batched by hand.
 * New ones are appended so existing slots never move. Each "@name" output shows where its file lands,
 * "@Coin (1)" = image_1, following First/Last and the target's own wiring. An output whose file is no
 * longer part of the run (tag gone, file unplugged or changed…) is removed, unless it's wired: a wire is
 * never cut for the user; it stays, labelled "@Coin ⚠ not in text", and the queue is refused.
 */
function syncOutputs(node, plan) {
  if (!library.loaded || !node.outputs) return;
  const libs = enabledLibs(node);
  const local = claimedKeys(node);
  const props = (node.properties ??= {});
  let changed = false;
  if (!node.outputs.some(isBatchOutput)) {
    node.addOutput(BATCH_OUTPUT, "IMAGE");
    changed = true;
  }
  const wanted = new Map(); // asset id -> asset
  for (const tok of mentionsIn(getWidget(node, "text")?.value)) {
    if (!splitTag(tok).lib && local.has(tagKey(tok))) continue; // a plugged-in file's tag, not the library's
    const res = library.resolve(tok, libs);
    if (res.status === "ok") wanted.set(res.asset.id, res.asset);
  }
  // undefined: not a library output ("text", "images", a plugged-in file's); null: its file is gone.
  const assetOf = (out) => (outputAssetName(out) == null || extraOutputKey(node, out) ? undefined
    : outputAsset(node, out)?.asset ?? null);
  for (let i = node.outputs.length - 1; i >= 1; i--) {
    const out = node.outputs[i];
    const asset = assetOf(out);
    if (asset === undefined || out.links?.length) continue;
    if (!asset || !wanted.has(asset.id) || out.type !== OUTPUT_TYPE[assetKind(asset)]) {
      const ids = { ...(node.properties?.tp_out ?? {}) };
      delete ids[out.name];
      node.properties.tp_out = ids;
      node.removeOutput(i);
      changed = true;
    }
  }
  // Record the asset of outputs made before ids were kept, and keep names current (a rename made
  // in another workflow tab doesn't reach this node's pins).
  for (const out of node.outputs.slice(1)) {
    const asset = assetOf(out);
    if (!asset) continue;
    if (node.properties?.tp_out?.[out.name] !== asset.id) setOutputAsset(node, out, asset);
    const want = `@${libToken(node, asset, libs, local)}`;
    if (out.name !== want && !node.outputs.some((o) => o !== out && o.name === want)) {
      renameOutput(node, out, want);
      changed = true;
    }
  }
  const have = new Set(node.outputs.map((o) => assetOf(o)?.id).filter(Boolean));
  for (const [id, asset] of wanted) {
    if (have.has(id)) continue;
    node.addOutput(`@${libToken(node, asset, libs, local)}`, OUTPUT_TYPE[assetKind(asset)]);
    setOutputAsset(node, node.outputs.at(-1), asset);
    changed = true;
  }

  // Plugged-in files: one output each, named by their tag.
  const extras = new Map(plan.extras.filter((x) => x.tag).map((x) => [tagKey(x.tag), x]));
  for (let i = node.outputs.length - 1; i >= 1; i--) {
    const out = node.outputs[i];
    const key = extraOutputKey(node, out);
    if (!key || out.links?.length) continue;
    const x = extras.get(key);
    if (!x || out.type !== OUTPUT_TYPE[x.kind] || out.name !== `@${x.tag}`) {
      const xout = { ...(props.tp_xout ?? {}) };
      const xsrc = { ...(props.tp_xsrc ?? {}) };
      delete xout[out.name];
      delete xsrc[out.name];
      props.tp_xout = xout;
      props.tp_xsrc = xsrc;
      node.removeOutput(i);
      changed = true;
    }
  }
  const haveX = new Set(node.outputs.map((o) => extraOutputKey(node, o)).filter(Boolean));
  for (const [key, x] of extras) {
    const name = `@${x.tag}`;
    if (haveX.has(key) || node.outputs.some((o) => o.name === name)) continue;
    node.addOutput(name, OUTPUT_TYPE[x.kind]);
    props.tp_xout = { ...(props.tp_xout ?? {}), [name]: key };
    props.tp_xsrc = { ...(props.tp_xsrc ?? {}), [name]: x.srcKey }; // to tell "file changed" from "unplugged" later
    changed = true;
  }

  // Where each file lands: "@Coin (1)" = image_1; or why it no longer carries a file of this run.
  const at = new Map();
  for (const r of plan.rows) if (r.asset && r.n && !r.claim) at.set(`a:${r.asset.id}`, r.n);
  for (const x of plan.extras) if (x.tag && x.n) at.set(`x:${tagKey(x.tag)}`, x.n);
  for (const out of node.outputs.slice(1)) {
    const xkey = extraOutputKey(node, out);
    const asset = xkey ? null : assetOf(out);
    const n = xkey ? at.get(`x:${xkey}`) : asset ? at.get(`a:${asset.id}`) : null;
    const reason = staleReason(node, out, plan);
    const label = reason ? `${out.name} ⚠ ${reason}` : n ? `${out.name} (${n})` : undefined;
    const x = xkey && !reason ? extras.get(xkey) : null;
    if (x && props.tp_xsrc?.[out.name] !== x.srcKey) props.tp_xsrc = { ...(props.tp_xsrc ?? {}), [out.name]: x.srcKey };
    if (out.label !== label && !(label === undefined && out.label === out.name)) {
      out.label = label;
      changed = true;
    }
  }
  if (changed) {
    node.graph?.change?.();
    node.setDirtyCanvas?.(true, true);
  }
}

export const headers = new Map(); // node -> { el, toggles: {kind: button}, libs: button, sig }

export function buildHeader(node) {
  const el = h("div", "tp-header");
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  // Libraries dropdown: which libraries this node uses (toggle), plus rename / delete / new.
  const libs = h("button", "tp-hbtn tp-libs", { type: "button" });
  libs.append(icon("library"), h("span", "tp-libs-label"), icon("chevron"));
  libs.onclick = (e) => {
    e.stopPropagation();
    toggleLibraryPanel(libs, node, () => refreshStrip(node));
  };
  el.append(libs);
  const toggles = {};
  for (const kind of KINDS) {
    const b = h("button", "tp-hbtn", { type: "button" });
    b.append(icon(kind));
    b.onclick = (e) => {
      e.stopPropagation();
      const on = new Set(enabledKinds(node));
      if (on.has(kind)) on.delete(kind);
      else on.add(kind);
      node.properties ??= {};
      node.properties.tp_kinds = KINDS.filter((k) => on.has(k));
      node.graph?.change?.(); // marks the workflow as modified
      refreshHeader(node);
      if (popup.state?.node === node) popup.reopen(popup.state.editor, node);
    };
    toggles[kind] = b;
    el.append(b);
  }
  const add = h("button", "tp-hbtn", { type: "button", title: "Add images, videos or audio to the library" });
  add.append(icon("plus"));
  add.onclick = (e) => {
    e.stopPropagation();
    openAddDialog({ node });
  };
  el.append(h("span", "tp-spacer"), add);
  headers.set(node, { el, toggles, libs, sig: null });
  return el;
}

function refreshHeader(node) {
  const hd = headers.get(node);
  if (!hd) return;
  const on = new Set(enabledKinds(node));
  const libsOn = enabledLibs(node);
  const counts = Object.fromEntries(KINDS.map((k) => [k, library.assets.filter((a) => libsOn.has(a.library) && assetKind(a) === k).length]));
  const sig = JSON.stringify([[...on], counts, [...libsOn], library.libraries.map((l) => l.name)]);
  if (sig === hd.sig) return;
  hd.sig = sig;
  const total = library.libraries.length;
  hd.libs.querySelector(".tp-libs-label").textContent = `Libraries (${libsOn.size})`;
  hd.libs.setAttribute("aria-pressed", "false");
  hd.libs.title = total
    ? `${libsOn.size} of ${total} ${total === 1 ? "library" : "libraries"} enabled in this node: ${library.libraries.filter((l) => libsOn.has(l.id)).map((l) => l.name).join(", ") || "none"}. Click to manage.`
    : "No libraries yet. Click to create one.";
  for (const kind of KINDS) {
    const b = hd.toggles[kind];
    b.setAttribute("aria-pressed", String(on.has(kind)));
    const n = counts[kind];
    b.title = `${KIND_LABEL[kind]} (${n} in the library): ${on.has(kind) ? "shown in" : "hidden from"} the @ list. Click to toggle.`;
  }
  // Icon-only buttons: screen readers read the same text as the tooltip.
  for (const b of hd.el.querySelectorAll("button")) if (b.title) b.setAttribute("aria-label", b.title);
}

/** Strip chips work from the keyboard too: Tab to reach one, Enter or Space to find its tag. */
function keyboardChip(chip) {
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", chip.title.split("\n")[0]);
  chip.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    chip.click();
  });
  return chip;
}

/**
 * Puts this node's own header and strip on screen. Undo / redo replace every node with a new one of the
 * same id, but the frontend keeps showing the old node's elements (its WidgetDOM mounts an element only
 * once): the strip would freeze and its buttons act on the removed node. Swap them in the way the
 * frontend mounts them (replaceChildren on the widget's container).
 */
function mountOwnElements(node) {
  if (node.graph !== currentGraph()) return;
  const box = document.querySelector(`.lg-node[data-node-id="${node.id}"]`);
  if (!box) return; // not rendered (yet): the frontend mounts the current elements itself
  for (const [name, cls] of [["tagged_header", "tp-header"], ["tagged_images", "tp-strip"]]) {
    const el = node.widgets?.find((w) => w.name === name)?.element;
    if (!el || el.isConnected) continue;
    box.querySelector(`.${cls}`)?.parentElement?.replaceChildren(el);
  }
}

export function refreshAllStrips() {
  sweepInks();
  for (const [node] of strips) {
    if (node.graph) refreshStrip(node);
    else strips.delete(node);
  }
}
