// Tagged Prompt: the @ autocomplete popup and editor listeners.
import { assetKind, getWidget, library, MENTION_AT_CARET, tagKey, tagTail, toast } from "./common.js";
import { currentGraph, nodeFromElement, nodesOf, widgetElement } from "./compat.js";
import { confirmModal, openAddDialog, openEditDialog } from "./dialogs.js";
import { hover, suppressPopupUntil } from "./tp_hover.js";
import { renderInk } from "./tp_ink.js";
import {
  claimedKeys, enabledKinds, enabledLibs, extraMedia, isTaggedPrompt, libToken, MAX_RESULTS,
} from "./tp_model.js";
import { pinnedChange } from "./tp_pins.js";
import { planFor } from "./tp_plan.js";
import { extraThumb, refreshStrip, scheduleStrip } from "./tp_strip.js";
import { installStyle, mediaThumb } from "./tp_style.js";
import { h } from "./ui.js";

/** The Tagged Prompt node owning a textarea (works for Vue-rendered and classic nodes). */
function promptNodeFor(el) {
  if (!(el instanceof HTMLTextAreaElement)) return null;
  const node = nodeFromElement(el)
    ?? nodesOf(currentGraph()).find((n) => n.widgets?.some((w) => widgetElement(w) === el));
  return isTaggedPrompt(node) ? node : null;
}

/** The @query being typed at the caret, or null. */
function mentionAtCaret(el) {
  const caret = el.selectionStart ?? el.value.length;
  if (el.selectionEnd !== caret) return null;
  const before = el.value.slice(0, caret);
  const m = MENTION_AT_CARET.exec(before); // same rules as the tags in the text ("@Lib/Bis" included)
  return m ? { at: caret - m[2].length - 1, caret, query: m[2] } : null;
}

/** Writes new text into the editor and keeps the widget (and Vue's v-model) in sync. */
function setEditorText(el, node, value, caret) {
  el.value = value;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const w = getWidget(node, "text");
  if (w && w.value !== value) w.value = value;
  node.setDirtyCanvas?.(true, true);
}

/** Viewport position of the caret, via a hidden mirror of the textarea. */
function caretRect(el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const mirror = h("div");
  for (const p of ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize",
    "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "textTransform", "tabSize"]) {
    mirror.style[p] = cs[p];
  }
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", left: `${r.left}px`, top: `${r.top}px`,
    whiteSpace: "pre-wrap", wordWrap: "break-word", overflow: "hidden",
  });
  const caret = el.selectionStart ?? el.value.length;
  mirror.textContent = el.value.slice(0, caret);
  const mark = h("span", "", { textContent: "​" });
  mirror.append(mark);
  document.body.append(mirror);
  const m = mark.getBoundingClientRect();
  mirror.remove();
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 16;
  // Vue nodes are CSS-scaled with the canvas; the mirror isn't, so scale the offset.
  const scale = r.width / (el.offsetWidth || r.width) || 1;
  const left = r.left + (m.left - r.left) * scale;
  const top = r.top + (m.top - r.top - el.scrollTop) * scale;
  return { left, top, bottom: top + line * scale };
}

export const popup = {
  el: null, list: null, state: null,

  ensure() {
    if (this.el) return this.el;
    installStyle();
    const el = h("div", "tp-popup", { hidden: true });
    const head = h("div", "tp-head");
    const title = h("span", "tp-title", { textContent: "Image library" });
    const add = h("button", "tp-btn", { type: "button", textContent: "+ Add", title: "Add images, videos or audio files" });
    add.onclick = () => this.addImages();
    head.append(title, add);
    this.list = h("div", "tp-list");
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Files to tag");
    const foot = h("div", "tp-foot", { textContent: "↑↓ select · Enter/Tab insert · Esc close · ✎ edit · × remove" });
    el.append(head, this.list, foot);
    // Keep focus in the textarea, and keep clicks/wheel away from the canvas.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    document.body.append(el);
    this.title = title;
    this.el = el;
    return el;
  },

  get open() {
    return !!this.el && !this.el.hidden && !!this.state;
  },

  hide() {
    if (this.el) this.el.hidden = true;
    const node = this.state?.node;
    this.state = null;
    if (node) {
      renderInk(node);
      scheduleStrip(node); // a tag left half-typed now gets its chip
    }
  },

  async refresh(editor, node) {
    if (Date.now() < suppressPopupUntil) return; // a tag's action card was just opened
    const mention = mentionAtCaret(editor);
    if (!mention) {
      if (this.state?.editor === editor) this.hide();
      return;
    }
    // Re-check the files on disk when the list opens, not on every keystroke while it's open.
    if (!(this.open && this.state?.editor === editor)) await library.load(true, 2000);
    // The same click may have opened a tag's action card meanwhile (its listener runs after this one).
    if (Date.now() < suppressPopupUntil) return;
    if (hover.pinned) {
      if (hover.key instanceof Element && editor.parentElement?.contains(hover.key)) return; // this editor's card
      hover.hide(); // a card pinned in another node gives way
    }
    if (document.activeElement !== editor) return;
    const now = mentionAtCaret(editor);
    if (!now || now.at !== mention.at) return;
    this.render(editor, node, now);
  },

  render(editor, node, mention) {
    this.ensure();
    // "@Library_02/Bis": only that library's files, matched on the name part.
    const slash = mention.query.indexOf("/");
    const qLib = slash >= 0 ? mention.query.slice(0, slash).toLowerCase() : null;
    const q = tagKey(slash >= 0 ? mention.query.slice(slash + 1) : mention.query);
    const score = (it) => {
      const k = tagKey(it.name);
      if (!q) return 1;
      if (k === q) return 1000;
      if (k.startsWith(q)) return 800 - k.length;
      if (k.includes(q)) return 600 - k.indexOf(q);
      return String(it.sub).toLowerCase().includes(q) ? 300 : -1;
    };
    const kinds = new Set(enabledKinds(node));
    const libs = enabledLibs(node);
    const shown = library.assets.filter((a) => libs.has(a.library) && kinds.has(assetKind(a))
      && (qLib == null || library.libName(a.library).toLowerCase().startsWith(qLib)));
    // This node's plugged-in (non-library) files come first; they can be tagged by file name.
    const extras = planFor(node).extras
      .filter((x) => x.tag && kinds.has(x.kind) && qLib == null)
      .map((x) => {
        const m = extraMedia(x);
        return { id: `extra:${x.input}`, name: x.tag, insert: x.tag, kind: x.kind, extra: x, media: m,
          sub: `${x.src?.title ?? "input"}${m.file ? ` · ${m.file}` : ""} · ${x.input} · this run only` };
      });
    // Library files show their library; the inserted tag names it only when the plain name would
    // resolve to another library first ("@Library_02/Biscuit").
    const claimed = claimedKeys(node);
    const assets = shown.map((a) => ({ id: a.id, name: a.name, kind: assetKind(a),
      insert: qLib != null ? `${library.libName(a.library)}/${a.name}` : libToken(node, a, libs, claimed),
      asset: a, sub: `${library.libName(a.library)} ${a.path}` }));
    const rank = (list) => list
      .map((it) => ({ it, s: score(it) }))
      .filter((x) => x.s >= 0)
      .sort((x, y) => y.s - x.s || x.it.name.localeCompare(y.it.name))
      .map((x) => x.it);
    const items = [...rank(extras), ...rank(assets)].slice(0, MAX_RESULTS);

    const keep = this.state?.editor === editor ? this.state.items[this.state.selected]?.id : null;
    const sel = Math.max(0, items.findIndex((it) => it.id === keep));
    this.state = { editor, node, mention, items, selected: sel };
    const filtered = shown.length !== library.assets.length;
    this.title.textContent = filtered
      ? `Libraries (${shown.length} of ${library.assets.length})`
      : `Libraries (${library.assets.length})`;

    this.list.replaceChildren();
    if (!items.length) {
      const hidden = library.assets.length - shown.length;
      this.list.append(h("div", "tp-empty", {
        textContent: !library.libraries.length
          ? "No libraries yet. Use + Add to pick image, video or audio files; they stay where they are."
          : !libs.size ? "All libraries are switched off in this node's header."
          : !kinds.size ? "All types are switched off in this node's header."
          : `Nothing matches “${mention.query}”${hidden ? ` (${hidden} hidden by the header filters)` : ""}.`,
      }));
    }
    items.forEach((it, i) => {
      const a = it.asset;
      const row = h("div", `tp-item${a?.exists === false ? " tp-missing" : ""}${it.extra ? " tp-item-extra" : ""}`,
        { title: a ? a.path : `${it.sub}\nNot in the library: plugged into this node for this run.` });
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === sel));
      const meta = h("div");
      meta.style.minWidth = "0";
      const name = h("div", "tp-name", { textContent: `@${it.name}` });
      if (it.extra) name.append(h("span", "tp-runonly", { textContent: "this run" }));
      else name.append(h("span", "tp-libtag", { textContent: library.libName(a.library) }));
      meta.append(name, h("div", "tp-sub", { textContent: a?.exists === false ? `missing: ${a.path}` : a ? a.path : it.sub }));
      const acts = h("div", "tp-acts");
      if (a) {
        // Only library files can be edited or removed; plugged-in files belong to their loader node.
        const ren = h("button", "tp-act", { type: "button", textContent: "✎", title: "Edit: rename, replace the file, remove" });
        const del = h("button", "tp-act", { type: "button", textContent: "×", title: "Remove from library (file is kept)" });
        ren.onclick = (e) => { e.stopPropagation(); this.editAsset(a); };
        del.onclick = (e) => { e.stopPropagation(); this.removeAsset(a); };
        acts.append(ren, del);
      }
      row.append(a ? mediaThumb(a, 44, "tp-thumb") : extraThumb(it.extra, it.media, "tp-thumb"), meta, acts);
      row.onclick = () => this.choose(i);
      row.onmousemove = () => this.select(i);
      this.list.append(row);
    });

    this.el.hidden = false;
    this.position();
    hover.hide();
    renderInk(node);
  },

  position() {
    const s = this.state;
    if (!s) return;
    const c = caretRect(s.editor);
    const p = this.el;
    const w = p.offsetWidth, ht = p.offsetHeight;
    const below = window.innerHeight - c.bottom - 6;
    const top = below >= Math.min(ht, 240) ? c.bottom + 4 : Math.max(8, c.top - ht - 4);
    p.style.left = `${Math.max(8, Math.min(c.left, window.innerWidth - w - 8))}px`;
    p.style.top = `${Math.max(8, Math.min(top, window.innerHeight - ht - 8))}px`;
  },

  select(i) {
    const s = this.state;
    if (!s?.items.length) return;
    s.selected = (i + s.items.length) % s.items.length;
    [...this.list.children].forEach((r, j) => r.setAttribute?.("aria-selected", String(j === s.selected)));
    this.list.children[s.selected]?.scrollIntoView?.({ block: "nearest" });
  },

  choose(i = this.state?.selected) {
    const s = this.state;
    const a = s?.items[i];
    if (!a) return;
    const { editor, node, mention } = s;
    // Replace the whole tag the caret is in, not just the part before it ("@M|rs_Nibbles" -> "@Mr_Mole").
    const rest = tagTail(editor.value.slice(mention.caret), !!mention.query);
    const after = editor.value.slice(mention.caret + rest.length);
    const token = `@${a.insert ?? a.name}${/^\s/.test(after) ? "" : " "}`;
    const value = editor.value.slice(0, mention.at) + token + after;
    this.hide();
    setEditorText(editor, node, value, mention.at + token.length);
    editor.focus();
    refreshStrip(node);
  },

  /** Re-opens the popup for the same editor after an async library change. */
  async reopen(editor, node) {
    editor.focus();
    if (mentionAtCaret(editor)) this.render(editor, node, mentionAtCaret(editor));
    else this.hide();
  },

  async addImages() {
    const s = this.state;
    this.hide();
    const added = await openAddDialog({ node: s?.node });
    if (s && added.length) {
      // Insert the first new file straight away when the user was mid-@tag.
      await this.reopen(s.editor, s.node);
      const i = this.state?.items.findIndex((it) => it.id === added[0].id) ?? -1;
      if (i >= 0) this.choose(i);
    }
  },

  editAsset(a) {
    const node = this.state?.node;
    this.hide();
    openEditDialog(a, { node });
  },

  async removeAsset(a) {
    const s = this.state;
    this.hide();
    const ok = await confirmModal(`Remove @${a.name}?`,
      `It is removed from ${library.libName(a.library)}; the file itself stays on disk. Tags that use it will turn red.`, "Remove");
    if (ok) {
      try {
        // Tags of the removed file turn red instead of finding a same-name file elsewhere.
        await pinnedChange(() => library.remove(a.id));
      } catch (e) {
        toast("error", `Remove failed: ${e.message}`);
      }
    }
    if (s) await this.reopen(s.editor, s.node);
  },
};

export function installEditorListeners() {
  const editorFrom = (t) => {
    const node = promptNodeFor(t);
    return node ? { editor: t, node } : null;
  };
  const refresh = (e) => {
    const hit = editorFrom(e.target);
    if (hit) popup.refresh(hit.editor, hit.node).catch((err) => console.error("[TaggedPrompt]", err));
  };
  document.addEventListener("input", (e) => {
    refresh(e);
    const hit = editorFrom(e.target);
    if (hit) {
      renderInk(hit.node);
      scheduleStrip(hit.node);
    }
  }, true);
  document.addEventListener("click", refresh, true);
  document.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refresh(e);
  }, true);
  document.addEventListener("focusout", (e) => {
    if (popup.state?.editor === e.target) setTimeout(() => {
      if (popup.state?.editor === e.target && document.activeElement !== e.target) popup.hide();
    }, 120);
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (popup.open && !popup.el.contains(e.target) && e.target !== popup.state.editor) popup.hide();
  }, true);
  // Window capture runs before ComfyUI's own key handling.
  window.addEventListener("keydown", (e) => {
    if (!popup.open || e.target !== popup.state.editor) return;
    const s = popup.state;
    const eat = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === "ArrowDown") { eat(); popup.select(s.selected + 1); }
    else if (e.key === "ArrowUp") { eat(); popup.select(s.selected - 1); }
    else if ((e.key === "Enter" || e.key === "Tab") && s.items.length) { eat(); popup.choose(); }
    else if (e.key === "Escape") { eat(); popup.hide(); }
  }, true);
  window.addEventListener("resize", () => popup.open && popup.position());
}
