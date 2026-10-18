// Small DOM kit shared by the Reference Prompt UI: element helper, inline icons and a modal
// styled like ComfyUI's own dialogs. Native prompt()/confirm() break keyboard input in
// ComfyUI Desktop, so all dialogs here are plain DOM.

export function h(tag, cls, props = {}) {
  const e = Object.assign(document.createElement(tag), props);
  if (cls) e.className = cls;
  return e;
}

// Lucide icons (ISC license), inlined so they don't depend on ComfyUI's bundled icon set.
const ICONS = {
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  audio: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  replace: '<path d="M14 4c0-1.1.9-2 2-2"/><path d="M20 2c1.1 0 2 .9 2 2"/><path d="M22 8c0 1.1-.9 2-2 2"/><path d="M16 10c-1.1 0-2-.9-2-2"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5c0-1.7 1.3-3 3-3h1"/><rect width="8" height="8" x="2" y="14" rx="2"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};

export function icon(name) {
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  return span.firstChild;
}

const CSS = `
.tpm-overlay{position:fixed;inset:0;z-index:100100;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}
.tpm{width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 48px);display:flex;flex-direction:column;
  background:var(--comfy-menu-bg,#202124);color:var(--input-text,#eee);border:1px solid var(--border-color,#444);
  border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.5);font:13px/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.tpm:focus{outline:none}
.tpm-btn:focus-visible,.tpm-x:focus-visible{outline:2px solid var(--base-foreground,#fff);outline-offset:2px}
.tpm-head{display:flex;align-items:center;gap:8px;padding:14px 16px 6px}
.tpm-title{flex:1;font-size:15px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tpm-x{border:0;background:transparent;color:var(--muted-foreground,#8a8a8a);cursor:pointer;border-radius:6px;padding:4px;display:flex}
.tpm-x:hover{background:var(--secondary-background,#262729);color:var(--base-foreground,#fff)}
.tpm-x svg{width:16px;height:16px}
.tpm-body{padding:6px 16px 10px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.tpm-foot{display:flex;align-items:center;gap:8px;padding:10px 16px 14px}
.tpm-foot .tpm-spacer{flex:1}
.tpm-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:6px;cursor:pointer;
  font:500 13px Inter,system-ui,sans-serif;border:1px solid var(--secondary-background,#262729);background:transparent;
  color:var(--base-foreground,#fff)}
.tpm-btn:hover{border-color:color-mix(in srgb,var(--base-foreground,#fff) 60%,transparent)}
.tpm-btn svg{width:15px;height:15px}
.tpm-btn.tpm-primary{background:var(--base-foreground,#fff);border-color:var(--base-foreground,#fff);color:var(--base-background,#171718)}
.tpm-btn.tpm-danger{background:#b3261e;border-color:#b3261e;color:#fff}
.tpm-btn:disabled{opacity:.45;cursor:default}
.tpm-field{display:flex;flex-direction:column;gap:4px}
.tpm [hidden]{display:none!important}
.tpm-label{font-size:11px;color:var(--muted-foreground,#8a8a8a)}
.tpm-input,.tpm-select{height:32px;box-sizing:border-box;padding:0 10px;border-radius:6px;border:1px solid var(--border-color,#444);
  background:var(--comfy-input-bg,#2a2a2a);color:var(--input-text,#eee);font:inherit;outline:none}
.tpm-input:focus,.tpm-select:focus{border-color:var(--base-foreground,#fff)}
.tpm-input.tpm-invalid{border-color:var(--tp-tag-bad,#ff6b6b)}
.tpm-error{color:var(--tp-tag-bad,#ff6b6b);font-size:12px;min-height:16px}
.tpm-note{color:var(--muted-foreground,#8a8a8a);font-size:12px}
.tpm-asset{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--secondary-background,#262729);border-radius:8px}
.tpm-asset .tpm-thumb{width:64px;height:64px;flex:none;border-radius:6px;object-fit:cover;background:#111;display:grid;place-items:center;
  color:var(--muted-foreground,#8a8a8a)}
.tpm-asset .tpm-thumb svg{width:22px;height:22px}
.tpm-asset .tpm-meta{min-width:0;display:flex;flex-direction:column;gap:2px}
.tpm-asset .tpm-path{font-size:11px;color:var(--muted-foreground,#8a8a8a);word-break:break-all}
.tpm-asset .tpm-path.tpm-missing{color:var(--tp-tag-missing,#c084fc)}
.tpm-asset .tpm-new{color:var(--base-foreground,#fff)}
`;

export function installUiStyle() {
  if (document.getElementById("tpm-style")) return;
  const s = document.createElement("style");
  s.id = "tpm-style";
  s.textContent = CSS;
  document.head.append(s);
}

// Open modals, top-most last. One document-level key handler serves the top one, so keys never
// reach ComfyUI's shortcuts (Delete, Ctrl+Z, …) or a modal underneath, wherever focus is.
const stack = [];
const FOCUSABLE = "input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])";

function onKey(e) {
  const ctl = stack.at(-1);
  if (!ctl) return;
  e.stopPropagation();
  // ComfyUI's own Ctrl+S/O/P never see the key while a dialog is open: don't let the browser's
  // save page / open file / print dialogs appear instead.
  if ((e.ctrlKey || e.metaKey) && /^[sop]$/i.test(e.key)) e.preventDefault();
  if (e.isComposing || e.keyCode === 229) return; // IME: Enter/Escape belong to the composition
  const box = ctl.box;
  if (!box.contains(document.activeElement)) box.focus();
  if (e.key === "Escape") {
    e.preventDefault();
    ctl.close();
  } else if (e.key === "Tab") {
    // Keep focus inside the dialog.
    const els = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!els.length) return e.preventDefault();
    const i = els.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1);
    e.preventDefault();
    els[next].focus();
  } else if (e.key === "Enter" && ctl.primary) {
    // Enter on a focused button presses that button (browser default); elsewhere it's the primary action.
    const t = e.target;
    if (t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.tagName === "SELECT") return;
    e.preventDefault();
    const b = ctl.button(ctl.primary.label);
    if (b && !b.disabled) b.click();
  }
}

/**
 * Opens a modal. `actions` = [{ label, icon?, kind?: "primary"|"danger", left?, onClick(ctl) }].
 * `focus`: label of the button to focus first (default: the first field, else the box itself).
 * Returns a controller: { body, close(), busy(bool), button(label), setActions(), closed }.
 * While busy (an async step is running) the dialog can't be closed; Escape closes otherwise.
 */
export function modal({ title, content = [], actions = [], onClose, focus = null }) {
  installUiStyle();
  const returnFocus = document.activeElement;
  const overlay = h("div", "tpm-overlay");
  const box = h("div", "tpm", { tabIndex: -1 });
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const head = h("div", "tpm-head");
  const titleEl = h("div", "tpm-title", { textContent: title });
  const x = h("button", "tpm-x", { type: "button", title: "Close" });
  x.append(icon("x"));
  head.append(titleEl, x);
  const body = h("div", "tpm-body");
  body.append(...[].concat(content));
  const foot = h("div", "tpm-foot");
  box.append(head, body, foot);
  overlay.append(box);

  let isBusy = false;
  const ctl = {
    body, box, overlay, titleEl,
    closed: false,
    /** Closes the dialog; ignored while busy unless `force`. */
    close(force = false) {
      if (ctl.closed || (isBusy && !force)) return;
      ctl.closed = true;
      overlay.remove();
      const i = stack.indexOf(ctl);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.removeEventListener("keydown", onKey, true);
      // Give focus back: to the opener if it's still there (and inside the dialog now on top),
      // else to the dialog now on top, so the next key isn't lost. Box first, then one tick later
      // the opener: a dialog that awaited this one (a confirm) re-enables its buttons in between.
      const top = stack.at(-1);
      top?.box.focus();
      setTimeout(() => {
        const at = document.activeElement;
        if (top ? top.closed || !top.box.contains(at) : at && at !== document.body) return; // moved on
        if (returnFocus?.isConnected && !returnFocus.disabled && (!top || top.box.contains(returnFocus))) returnFocus.focus?.();
      });
      onClose?.();
    },
    /** While busy, buttons and closing are disabled (an async step is running). */
    busy(on) {
      isBusy = on;
      x.disabled = on;
      foot.querySelectorAll("button").forEach((b) => (b.disabled = on));
    },
    button: (label) => [...foot.querySelectorAll("button")].find((b) => b.dataset.label === label),
    setActions(list) {
      foot.replaceChildren();
      const left = list.filter((a) => a.left), right = list.filter((a) => !a.left);
      const mk = (a) => {
        const b = h("button", `tpm-btn${a.kind ? ` tpm-${a.kind}` : ""}`, { type: "button" });
        b.dataset.label = a.label;
        if (a.icon) b.append(icon(a.icon));
        b.append(document.createTextNode(a.label));
        b.onclick = () => a.onClick?.(ctl);
        return b;
      };
      foot.append(...left.map(mk), h("span", "tpm-spacer"), ...right.map(mk));
      ctl.primary = list.find((a) => a.kind === "primary");
    },
  };
  ctl.setActions(actions);
  x.onclick = () => ctl.close();
  overlay.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.target === overlay) ctl.close();
  });
  overlay.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  document.body.append(overlay);
  if (!stack.length) document.addEventListener("keydown", onKey, true);
  stack.push(ctl);
  // Focus: the requested button, else the first field, else the dialog itself (so keys land here).
  const target = (focus && ctl.button(focus)) || box.querySelector("input:not([disabled]),select:not([disabled])") || box;
  target.focus();
  return ctl;
}

/** Labelled form field; returns { el, input, error }. */
export function field(label, input) {
  const el = h("label", "tpm-field");
  const error = h("div", "tpm-error");
  el.append(h("span", "tpm-label", { textContent: label }), input, error);
  return { el, input, error };
}
