// Tagged Prompt: colored @tags in the editor (a mirror layer behind the textarea).
import { getWidget, mentionRe, tagKey } from "./common.js";
import { currentGraph, elementOfNode, widgetElement } from "./compat.js";
import { planFor } from "./tp_plan.js";
import { popup } from "./tp_popup.js";
import { h } from "./ui.js";

// A textarea can't color parts of its text, so a mirror div behind it renders the same text with
// colored tags, and the textarea's own text is made transparent (the caret stays visible).
// Colors come from the --tp-tag-* CSS variables.

export const inks = new Map(); // node -> { node, ta, back, ro, sig }

const MIRROR_PROPS = ["boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "lineHeight",
  "letterSpacing", "wordSpacing", "textTransform", "textIndent", "tabSize", "whiteSpace", "overflowWrap", "wordBreak",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "borderTopLeftRadius", "borderTopRightRadius",
  "borderBottomLeftRadius", "borderBottomRightRadius"];

export function editorOf(node) {
  // Node ids repeat across workflow tabs; only the graph on screen owns the DOM.
  if (!node.graph || node.graph !== currentGraph()) return null;
  const vue = elementOfNode(node)?.querySelector("textarea");
  if (vue) return vue;
  const el = widgetElement(getWidget(node, "text"));
  return el instanceof HTMLTextAreaElement ? el : null;
}

export const inkOf = (ta) => [...inks.values()].find((i) => i.ta === ta) ?? null;

export function ensureInk(node) {
  const ta = editorOf(node);
  if (!ta?.isConnected || !ta.parentElement) return null;
  let ink = inks.get(node);
  if (ink && ink.ta === ta && ink.back.isConnected) {
    ta.classList.add("tp-ink-ta"); // Vue may have rewritten the class list
    // ResizeObserver doesn't fire while the page isn't rendering, so also check here.
    const b = ink.back.style;
    if (b.width !== `${ta.offsetWidth}px` || b.height !== `${ta.offsetHeight}px`
      || b.left !== `${ta.offsetLeft}px` || b.top !== `${ta.offsetTop}px`) layoutInk(ink);
    return ink;
  }
  ink?.ro.disconnect();
  ink?.back.remove();

  ta.classList.remove("tp-ink-ta");
  const cs = getComputedStyle(ta);
  const back = h("div", "tp-ink-back");
  back.style.color = cs.color;
  back.style.background = cs.backgroundColor;
  ta.style.caretColor = cs.color;
  const parent = ta.parentElement;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  // Never stack layers: drop any left behind by an earlier node object or textarea.
  parent.querySelectorAll(":scope > .tp-ink-back").forEach((el) => el.remove());
  parent.insertBefore(back, ta);
  ta.classList.add("tp-ink-ta");

  ink = { node, ta, back, sig: null };
  ink.ro = new ResizeObserver(() => layoutInk(ink));
  ink.ro.observe(ta);
  inks.set(node, ink);
  layoutInk(ink);
  return ink;
}

function layoutInk({ ta, back }) {
  const cs = getComputedStyle(ta);
  for (const p of MIRROR_PROPS) back.style[p] = cs[p];
  // Leave room for the textarea's scrollbar so lines wrap at the same place.
  const sb = Math.max(0, ta.offsetWidth - ta.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0));
  back.style.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + sb}px`;
  Object.assign(back.style, {
    left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`,
    width: `${ta.offsetWidth}px`, height: `${ta.offsetHeight}px`,
  });
  back.scrollTop = ta.scrollTop;
}

/**
 * Re-renders the colored mirror (colors by tag state, see planFor). A `plan` from planFor is reused
 * when it was made for this text.
 */
export function renderInk(node, plan = null) {
  const ink = ensureInk(node);
  if (!ink) return;
  const value = ink.ta.value;
  const { rows } = plan && plan.text === value ? plan : planFor(node, value);
  const known = new Map(rows.map((r) => [tagKey(r.tok), r.status === "unplugged" ? "unplugged" : r.state]));
  // The tag being typed while the popup is open stays neutral instead of flashing red.
  const typing = popup.open && popup.state.editor === ink.ta ? popup.state.mention.at : -1;
  const sig = JSON.stringify([value, [...known], typing]);
  if (sig === ink.sig) return;
  ink.sig = sig;

  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of value.matchAll(mentionRe())) {
    const start = m.index + m[1].length;
    const end = m.index + m[0].length;
    frag.append(value.slice(last, start));
    const state = known.get(tagKey(m[2])) ?? "bad";
    const cls = state === "ok" ? "tp-ink-ok" : start === typing ? "" : `tp-ink-${state === "unplugged" ? "bad" : state}`;
    const key = tagKey(m[2]);
    const hl = key === ink.hlKey ? " tp-ink-hl" : "";
    const span = h("span", `tp-ink ${cls}${hl}`, { textContent: value.slice(start, end) });
    span.dataset.tag = m[2];
    span.dataset.state = state;
    span.dataset.key = key;
    frag.append(span);
    last = end;
  }
  frag.append(value.slice(last) + "​"); // keeps a trailing newline's height
  ink.back.replaceChildren(frag);
  ink.back.scrollTop = ink.ta.scrollTop;
}

const inkSpans = (ink, key) => [...ink.back.querySelectorAll(".tp-ink")].filter((s) => s.dataset.key === key);

/** Strip hover: highlight every occurrence of the tag in yellow (null clears). */
export function highlightTag(node, key) {
  const ink = inks.get(node);
  if (!ink) return;
  ink.hlKey = key;
  for (const s of ink.back.querySelectorAll(".tp-ink")) s.classList.toggle("tp-ink-hl", s.dataset.key === key);
}

/** Strip click: scroll to the next occurrence of the tag (cycling) and ping it. */
export function jumpToTag(node, key) {
  renderInk(node);
  const ink = inks.get(node);
  if (!ink) return;
  const spans = inkSpans(ink, key);
  if (!spans.length) return;
  const i = ink.jump?.key === key ? (ink.jump.i + 1) % spans.length : 0;
  ink.jump = { key, i };
  const span = spans[i];
  // Spans sit in the mirror; offsetTop is relative to it, i.e. to the text's top.
  const target = span.offsetTop + span.offsetHeight / 2 - ink.ta.clientHeight / 2;
  ink.ta.scrollTop = Math.max(0, target);
  ink.back.scrollTop = ink.ta.scrollTop;
  const unping = () => ink.back.querySelectorAll(".tp-ink-ping").forEach((s) => s.classList.remove("tp-ink-ping"));
  unping();
  void span.offsetWidth; // restart the animation on repeated clicks
  span.classList.add("tp-ink-ping");
  clearTimeout(ink.pingTimer);
  ink.pingTimer = setTimeout(unping, 1700);
}

/** Drops ink layers whose node or textarea is gone, plus any layer no live ink owns. */
export function sweepInks() {
  for (const [node, ink] of inks) {
    if (node.graph === currentGraph() && ink.ta.isConnected && ink.back.isConnected) continue;
    ink.ro.disconnect();
    ink.back.remove();
    inks.delete(node);
    // The textarea may now belong to another live ink (same DOM, different node object).
    if (![...inks.values()].some((i) => i.ta === ink.ta)) ink.ta.classList.remove("tp-ink-ta");
  }
  const live = new Set([...inks.values()].map((i) => i.back));
  document.querySelectorAll(".tp-ink-back").forEach((el) => {
    if (!live.has(el)) el.remove();
  });
}
