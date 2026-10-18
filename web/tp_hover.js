// Reference Prompt: hover cards for tags, ports and chips, and their actions.
import { assetKind, getWidget, library, mentionRe, splitTag, tagKey } from "./common.js";
import { isOutputSlot, nodeFromElement, slotElementOf } from "./compat.js";
import { openEditDialog } from "./dialogs.js";
import { ensureInk, inkOf } from "./tp_ink.js";
import {
  enabledLibs, EXTRA_RE, extraMedia, isTaggedPrompt, outputAsset, outputAssetName, resolveFor, unpluggedText,
} from "./tp_model.js";
import { setNodeText } from "./tp_pins.js";
import { planFor } from "./tp_plan.js";
import { popup } from "./tp_popup.js";
import { setLibEnabled } from "./tp_strip.js";
import { h, icon } from "./ui.js";

/** Replaces every plain use of a tag in a node's text. */
function replaceTag(node, tok, next) {
  const key = tagKey(tok);
  const text = getWidget(node, "text")?.value ?? "";
  const out = text.replace(mentionRe(), (all, pre, t) => (!splitTag(t).lib && tagKey(t) === key ? `${pre}@${next}` : all));
  if (out !== text) setNodeText(node, out);
}

/**
 * Builds the card for a plan row (tag), an extra input, or a bare asset:
 *   [type icon] @name / slot line (or the problem) / library · path.
 * Tags whose library is off, or whose file is missing, get an action button.
 */
function cardInfo({ node, row, extra, asset, name, target }) {
  const item = row ?? extra;
  const kind = item?.kind ?? (asset ? assetKind(asset) : "image");
  const media = extra ? extraMedia(extra) : { asset: asset ?? row?.asset };
  const a = media.asset;
  const lib = a ? library.lib(a.library) : null;
  const status = row?.status ?? (a ? resolveFor(node, library.tokenFor(a, node ? enabledLibs(node) : null)).status : null);
  let slot, state = row?.state ?? (item?.unsupported ? "bad" : "ok"), action = null;
  if (status === "off" && !row?.wiredByHand && !row?.extra) {
    state = "off";
    slot = `In ${lib?.name}, which is switched off in this node.`;
    if (node && lib) action = { label: `Enable ${lib.name}`, run: () => setLibEnabled(node, lib.id, true) };
  } else if (status === "unplugged") {
    state = "bad";
    slot = unpluggedText(row.claim);
    // The library may have a file of that name: offer it, written so it can't be mistaken again.
    const res = node ? resolveFor(node, row.tok) : null;
    if (res?.asset) {
      const tok = `${library.libName(res.asset.library)}/${res.asset.name}`;
      action = { label: `Use @${tok} from the library`, run: () => replaceTag(node, row.tok, tok) };
    }
  } else if (status === "missing" && !row?.wiredByHand && !row?.extra) {
    state = "missing";
    slot = "File not found. Replace it, or remove it from the library.";
    if (a) action = { label: "Replace file…", run: () => openEditDialog(a, { node }) };
  } else {
    slot = item?.unsupported ? `⚠ ${item.unsupported}`
      : item?.slot ? (target ? `${item.slot} on ${target.title}` : item.slot)
      : row?.wiredByHand ? "wired into the target by hand"
      : row && !row.asset && !row.extra ? "not in the library: type @ to pick a file, or + to add one"
      : !target ? "not connected to a model" : "not used in the prompt";
  }
  const where = a ? `${lib?.name ?? "?"} · ${a.path}`
    : extra ? `${extra.src?.title ?? "input"}${media.file ? ` · ${media.file}` : ""} (via ${extra.input})`
    : "";
  return { kind, name: name ?? (a ? `@${a.name}` : extra?.tag ? `@${extra.tag}` : extra?.input ?? ""),
    a: state === "missing" ? null : a, url: media.url, slot, where, state, action };
}

export const hover = {
  el: null, key: null, pinned: false,

  ensure() {
    if (!this.el) {
      this.el = document.body.appendChild(h("div", "tp-hover", { hidden: true }));
      this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.el.addEventListener("mousedown", (e) => e.preventDefault());
    }
    return this.el;
  },

  hide() {
    if (this.el) {
      this.el.hidden = true;
      this.el.querySelector("video")?.pause();
    }
    this.key = null;
    this.pinned = false;
  },

  /**
   * `key` identifies what is hovered so the card isn't rebuilt on every mouse move. A pinned card
   * (opened by clicking a struck-through or purple tag) takes clicks and stays until dismissed.
   */
  show(key, info, rect, { pinned = false } = {}) {
    if (key === this.key && pinned === this.pinned) return;
    this.key = key;
    this.pinned = pinned;
    const el = this.ensure();
    el.className = `tp-hover${info.state && info.state !== "ok" ? ` tp-h${info.state}` : ""}${pinned ? " tp-pinned" : ""}`;
    el.replaceChildren();
    const { a, kind } = info;
    if (kind === "video" && (a ? a.exists !== false : info.url)) {
      // Muted, looping preview; the poster shows instantly while the file streams in.
      const v = h("video", "", { muted: true, autoplay: true, loop: true, playsInline: true,
        poster: a ? library.thumbUrl(a, 256) : "", src: a ? library.fileUrl(a) : info.url });
      el.append(v);
      v.play?.().catch(() => {});
    } else if (kind === "audio" && (a || info.url)) {
      el.append(h("div", "tp-audio", { textContent: "♪" }));
      el.lastChild.style.cssText = "width:200px;height:72px;border-radius:5px;font-size:28px";
    } else if (a || info.url) {
      const img = h("img", "", { alt: "", src: a ? library.thumbUrl(a, 256) : info.url });
      img.onerror = () => img.remove();
      el.append(img);
    }
    const title = h("div", "tp-hname tp-htitle");
    title.append(icon(kind), h("span", "", { textContent: info.name }));
    el.append(title, h("div", "tp-hsub tp-hslot", { textContent: info.slot }));
    if (info.where) el.append(h("div", "tp-hsub", { textContent: info.where }));
    if (info.action) {
      if (pinned) {
        const row = h("div", "tp-hact");
        const b = h("button", "", { type: "button", textContent: info.action.label });
        b.onclick = () => {
          this.hide();
          info.action.run();
        };
        row.append(b);
        el.append(row);
      } else {
        el.append(h("div", "tp-hsub", { textContent: "Click the tag for options." }));
      }
    }
    el.hidden = false;
    const w = el.offsetWidth, ht = el.offsetHeight;
    const top = rect.bottom + 6 + ht < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - ht - 6);
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
    el.style.top = `${top}px`;
  },
};

/** Card for a tag span in the editor (pinned = opened by a click, with its action button). */
function hoverTag(span, ink, pinned = false) {
  if (hover.key === span && hover.pinned === pinned) return;
  const plan = planFor(ink.node, ink.ta.value);
  const row = plan.rows.find((r) => tagKey(r.tok) === span.dataset.key);
  const info = cardInfo({ node: ink.node, row, extra: row?.extra, name: `@${span.dataset.tag}`, target: plan.target });
  hover.show(span, info, span.getClientRects()[0] ?? span.getBoundingClientRect(), { pinned });
}

/** Card for a Reference Prompt port (an "@name" output or an extra input) under the mouse. */
function hoverPort(slotEl) {
  if (hover.key === slotEl) return true;
  const node = nodeFromElement(slotEl);
  if (!isTaggedPrompt(node)) return false;
  const text = slotEl.textContent.trim();
  const isOut = isOutputSlot(slotEl);
  const list = (isOut ? node.outputs : node.inputs) ?? [];
  // The slot shows the label ("image_1 ⇤"); match the whole name, so image_1 never matches image_10.
  const port = list.find((p) => (p.label ?? p.name) === text)
    ?? list.find((p) => text === p.name || text.startsWith(`${p.name} `));
  if (!port) return false;
  const plan = planFor(node);
  let info;
  if (isOut) {
    const name = outputAssetName(port);
    if (name == null) return false;
    const row = plan.rows.find((r) => tagKey(r.tok) === tagKey(name));
    info = cardInfo({ node, row, asset: outputAsset(node, port)?.asset, name: port.name, target: plan.target });
  } else {
    const extra = plan.extras.find((x) => x.input === port.name);
    if (!EXTRA_RE.test(port.name)) return false;
    info = extra ? cardInfo({ node, extra, target: plan.target })
      : { kind: EXTRA_RE.exec(port.name)[1], name: port.name, slot: "empty: plug in a file for this run only",
        where: `First/Last is set on its chip under the text once connected.` };
  }
  hover.show(slotEl, info, slotEl.getBoundingClientRect());
  return true;
}

/** The ink span under a viewport point, or null. */
function spanAt(ink, x, y) {
  for (const sp of ink.back.querySelectorAll(".tp-ink")) {
    for (const r of sp.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return sp;
    }
  }
  return null;
}

export let suppressPopupUntil = 0;

export function installInkListeners() {
  document.addEventListener("mousemove", (e) => {
    if (hover.pinned) return;
    const ink = e.target instanceof HTMLTextAreaElement ? inkOf(e.target) : null;
    let hit = null;
    if (ink && !popup.open) {
      ensureInk(ink.node); // re-syncs the mirror's size/position if the node was resized
      hit = spanAt(ink, e.clientX, e.clientY);
    }
    if (hit) hoverTag(hit, ink);
    else {
      const slotEl = !ink && !popup.open && e.target instanceof Element ? slotElementOf(e.target) : null;
      if (!(slotEl && hoverPort(slotEl))) hover.hide();
    }
  }, true);
  // Clicking a struck-through (library off), purple (file missing) or unplugged tag pins its card with an action.
  document.addEventListener("click", (e) => {
    if (hover.pinned && !hover.el?.contains(e.target)) hover.hide();
    const ink = e.target instanceof HTMLTextAreaElement ? inkOf(e.target) : null;
    const sp = ink && spanAt(ink, e.clientX, e.clientY);
    if (sp && (sp.dataset.state === "off" || sp.dataset.state === "missing" || sp.dataset.state === "unplugged")) {
      suppressPopupUntil = Date.now() + 600;
      popup.hide();
      hoverTag(sp, ink, true);
    }
  }, true);
  document.addEventListener("scroll", (e) => {
    const ink = inkOf(e.target);
    if (ink) ink.back.scrollTop = e.target.scrollTop;
    hover.hide();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!hover.pinned || e.key === "Escape") hover.hide();
  }, true);
}
