// Tagged Prompt: the strip of tagged assets, the header, and the @name outputs.
import { assetKind, getWidget, KINDS, library, mentionsIn, splitTag, tagKey } from "./common.js";
import { openAddDialog, toggleLibraryPanel } from "./dialogs.js";
import { highlightTag, jumpToTag, renderInk, sweepInks } from "./tp_ink.js";
import { syncInputs } from "./tp_inputs.js";
import {
  claimedKeys, enabledKinds, enabledLibs, extraMedia, KIND_LABEL, libToken, OUTPUT_TYPE, outputAsset,
  outputAssetName, renameOutput, setOutputAsset, syncClaims, unpluggedText,
} from "./tp_model.js";
import { restoreTags, snapshotTags } from "./tp_pins.js";
import { planFor } from "./tp_plan.js";
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
  syncClaims(node);
  refreshHeader(node);
  syncOutputs(node);
  syncInputs(node);
  const plan = planFor(node); // once per refresh, shared with the ink
  renderInk(node, plan);
  const { rows, extras } = plan;
  const uses = mentionsIn(getWidget(node, "text")?.value).map(tagKey);
  const sig = JSON.stringify([rows.map((r) => [r.tok, r.label, r.state, r.status, r.unsupported, r.asset?.id, r.asset?.mtime, r.asset?.name]),
    extras.map((x) => [x.input, x.tag, x.before, x.label, x.unsupported, x.src?.id, extraMedia(x).file]),
    library.assets.length, library.libraries.map((l) => l.name), uses]);
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
    chip.title = r.state === "off" ? `In ${libName}, which is switched off in this node.`
      : r.state === "missing" ? `File not found: ${r.asset.path}`
      : r.unsupported ? `${r.asset.path}\n⚠ ${r.unsupported}`
      : r.asset ? `${libName} · ${r.asset.path}` : r.wiredByHand ? "Wired by hand"
      : r.status === "unplugged" ? unpluggedText(r.claim) : `@${r.tok} is not in the library`;
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
    chip.append(
      h("div", "tp-cname", { textContent: `@${r.tok}` }),
      h("div", "tp-idx", { textContent: idx }),
    );
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
  chip.append(
    tog,
    h("div", "tp-cname", { textContent: x.tag ? `@${x.tag}` : x.input }),
    h("div", "tp-idx", { textContent: x.label ?? (x.unsupported ? `no ${x.kind} input` : "") }),
  );
  chip.title = `${x.input} ← ${x.src?.title ?? "?"}${media.file ? ` (${media.file})` : ""}\nNot in the library: used for this run only.`
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
 * Keeps one output per tagged library file ("@name", typed IMAGE/VIDEO/AUDIO) after "text".
 * New ones are appended so existing slots never move; outputs that are wired to something are
 * never removed (editing a tag shouldn't cut links), only unwired ones whose tag is gone.
 */
function syncOutputs(node) {
  if (!library.loaded || !node.outputs) return;
  const libs = enabledLibs(node);
  const local = claimedKeys(node);
  const wanted = new Map(); // asset id -> asset
  for (const tok of mentionsIn(getWidget(node, "text")?.value)) {
    if (!splitTag(tok).lib && local.has(tagKey(tok))) continue; // a plugged-in file's tag, not the library's
    const res = library.resolve(tok, libs);
    if (res.status === "ok") wanted.set(res.asset.id, res.asset);
  }
  // undefined: not an asset output ("text"); null: an asset output whose file is gone.
  const assetOf = (out) => (outputAssetName(out) == null ? undefined : outputAsset(node, out)?.asset ?? null);
  let changed = false;
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

export function refreshAllStrips() {
  sweepInks();
  for (const [node] of strips) {
    if (node.graph) refreshStrip(node);
    else strips.delete(node);
  }
}
