// Edit library: rename the library and manage its assets in one large dialog. A scrollable grid of
// the library's files on the left (thumbnail size set by a slider); the selected one's properties on
// the right (preview, name, file name, local path), with Remove and Replace file…. Several assets can
// be selected (⌘/Ctrl-click, Shift-click, Shift+arrows, ⌘/Ctrl+A): then only Remove applies, to all
// of them. Every change is saved at once, with tags pinned to their files (renames followed, a
// removed file's tags turn red), like the smaller dialogs.
import { KINDS, assetKind, formatDuration, library, tagName, toast } from "./common.js";
import { confirmModal, enabledSetFor, pinned } from "./dialogs.js";
import { h, icon, installUiStyle, modal } from "./ui.js";

const CSS = `
.tpm.tlm{width:min(1040px,calc(100vw - 32px));height:min(720px,calc(100vh - 48px))}
.tlm .tpm-body{flex:1;min-height:0;overflow:hidden}
.tlm-top{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.tlm-top .tpm-field{flex:1;min-width:220px;max-width:420px}
.tlm-row{display:flex;gap:6px}
.tlm-row .tpm-input{flex:1;min-width:0}
.tlm-filters{display:flex;align-items:center;gap:6px;margin:19px 0 0 auto}
.tlm-search{width:190px}
.tlm-kind{display:inline-flex;align-items:center;justify-content:center;flex:none;width:34px;height:32px;padding:0;box-sizing:border-box;
  border-radius:6px;border:1px solid var(--secondary-background,#262729);background:transparent;color:var(--muted-foreground,#8a8a8a);
  cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.tlm-kind:hover{border-color:color-mix(in srgb,var(--base-foreground,#fff) 60%,transparent);color:color-mix(in srgb,var(--base-foreground,#fff) 60%,transparent)}
.tlm-kind[aria-pressed="true"]{background:var(--base-foreground,#fff);border-color:var(--base-foreground,#fff);color:var(--base-background,#171718)}
.tlm-kind:focus-visible{outline:2px solid var(--base-foreground,#fff);outline-offset:2px}
.tlm-kind:disabled{opacity:.35;cursor:default}
.tlm-kind svg{width:16px;height:16px;pointer-events:none}
.tlm-size{display:flex;flex-direction:column;gap:4px;width:170px}
.tlm-sizerow{display:flex;align-items:center;gap:6px;height:32px;color:var(--muted-foreground,#8a8a8a)}
.tlm-sizerow svg{flex:none;width:12px;height:12px}
.tlm-sizerow svg.tlm-big{width:18px;height:18px}
.tlm-sizerow input{flex:1;min-width:0;accent-color:var(--base-foreground,#fff);cursor:pointer}
.tlm-main{flex:1;min-height:0;display:flex;gap:12px}
.tlm-gridwrap{flex:1;min-width:0;overflow:auto;overscroll-behavior:contain;border:1px solid var(--secondary-background,#262729);
  border-radius:8px;padding:8px}
.tlm-grid{--tlm-tile:112px;display:grid;grid-template-columns:repeat(auto-fill,var(--tlm-tile));gap:8px}
.tlm-grid.tlm-small .tlm-name{font-size:11px}
.tlm-grid.tlm-small .tlm-badge{top:6px;right:6px;padding:2px}
.tlm-tile{position:relative;display:flex;flex-direction:column;gap:4px;padding:4px;border-radius:8px;border:1px solid transparent;
  background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left;min-width:0}
.tlm-tile:hover{background:var(--secondary-background,#262729)}
.tlm-tile:focus-visible{outline:2px solid var(--base-foreground,#fff);outline-offset:1px}
.tlm-tile.tlm-sel{border-color:var(--tp-tag-hl,#ffd400);background:var(--secondary-background,#262729)}
.tlm-tile.tlm-sel::after{content:"";position:absolute;inset:-1px;border-radius:8px;pointer-events:none;
  background:color-mix(in srgb,var(--tp-tag-hl,#ffd400) 8%,transparent)}
.tlm-thumb{aspect-ratio:1;width:100%;border-radius:6px;object-fit:cover;background:#111;display:grid;place-items:center;
  color:var(--muted-foreground,#8a8a8a)}
.tlm-thumb svg{width:26px;height:26px}
.tlm-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tlm-badge{position:absolute;top:8px;right:8px;display:flex;padding:3px;border-radius:5px;background:rgba(0,0,0,.6);color:#fff}
.tlm-badge svg{width:12px;height:12px}
.tlm-badge.tlm-video{color:var(--tp-tag-video,#34d7d9)}
.tlm-badge.tlm-audio{color:var(--tp-tag-audio,#4bd15b)}
.tlm-badge.tlm-gone{color:var(--tp-tag-missing,#c084fc)}
.tlm-tile.tlm-missing .tlm-name{color:var(--tp-tag-missing,#c084fc)}
.tlm-tile.tlm-missing .tlm-thumb{outline:1px dashed var(--tp-tag-missing,#c084fc);outline-offset:-1px}
.tlm-empty{padding:24px;text-align:center;color:var(--muted-foreground,#8a8a8a)}
.tlm-props{width:300px;flex:none;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;
  border:1px solid var(--secondary-background,#262729);border-radius:8px;padding:10px;box-sizing:border-box}
.tlm-preview{width:100%;aspect-ratio:4/3;box-sizing:border-box;border-radius:6px;background:#111;display:flex;align-items:center;justify-content:center;overflow:hidden;
  color:var(--muted-foreground,#8a8a8a)}
.tlm-preview img,.tlm-preview video{width:100%;height:100%;object-fit:contain;display:block}
.tlm-preview audio{width:92%}
.tlm-preview svg{width:32px;height:32px}
.tlm-preview.tlm-gone{flex-direction:column;gap:6px;text-align:center;padding:10px;color:var(--tp-tag-missing,#c084fc);font-size:12px}
.tlm-info{font-size:11px;color:var(--muted-foreground,#8a8a8a)}
.tlm-prop{display:flex;flex-direction:column;gap:2px}
.tlm-val{font-size:12px;word-break:break-all;user-select:text}
.tlm-val.tlm-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.tlm-val.tlm-gone{color:var(--tp-tag-missing,#c084fc)}
.tlm-pathrow{display:flex;gap:6px;align-items:flex-start}
.tlm-pathrow .tlm-val{flex:1;min-width:0}
.tlm-copy{flex:none;height:24px;padding:0 8px;font-size:11px}
.tlm-actions{display:flex;flex-direction:column;gap:6px;margin-top:auto;padding-top:4px}
.tlm-actions .tpm-btn{justify-content:center}
.tlm-actions .tlm-remove{color:var(--tp-tag-bad,#ff6b6b)}
.tlm-actions .tlm-remove:hover{border-color:var(--tp-tag-bad,#ff6b6b)}
.tlm-off{opacity:.5}
.tlm-val.tlm-none{color:var(--muted-foreground,#8a8a8a)}
.tlm-preview.tlm-multi{flex-direction:column;gap:6px;text-align:center;padding:10px;font-size:12px}
.tlm-stack{position:relative;width:96px;height:72px}
.tlm-stack img,.tlm-stack div{position:absolute;width:56px;height:56px;border-radius:6px;object-fit:cover;background:#222;
  border:2px solid #111;display:grid;place-items:center}
.tlm-stack svg{width:20px;height:20px}
.tlm-hint{margin:auto;text-align:center;color:var(--muted-foreground,#8a8a8a);font-size:12px;padding:24px 8px}
@media (max-width:720px){.tlm-main{flex-direction:column}.tlm-props{width:auto;max-height:45%}}
`;

function installStyle() {
  installUiStyle();
  if (document.getElementById("tlm-style")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "tlm-style", textContent: CSS }));
}

const baseName = (p) => String(p ?? "").split(/[\\/]/).pop() ?? "";
const describe = (a) => {
  const kind = assetKind(a);
  const dur = formatDuration(a.duration);
  return [kind, dur, a.width ? `${a.width}×${a.height}` : ""].filter(Boolean).join(" · ");
};
/** What a tile/preview depends on: re-render only when one of these changes. */
const sig = (a) => (a ? `${a.id}|${a.name}|${a.path}|${a.mtime}|${a.exists}|${a.width}|${a.duration}` : "");

/** Opens the Edit library dialog for `lib` ({ id, name }). `node`: the Reference Prompt it was opened from. */
export function openLibraryManager(lib, { node = null } = {}) {
  installStyle();
  const libId = lib.id;
  const libNow = () => library.lib(libId);
  const sel = new Set(); // selected asset ids
  let focusId = null; // the tile the keyboard is on (and the panel shows when one is selected)
  let anchorId = null; // where Shift-click / Shift+arrow ranges start
  const single = () => (sel.size === 1 ? library.byId([...sel][0]) : null);
  let working = false; // an async step is running (buttons disabled)
  let pickToken = 0; // a file dialog's result is dropped if the dialog was closed / superseded meanwhile
  let ctl = null; // the modal, once open

  // ---- top: library name + search
  const libInput = h("input", "tpm-input", { value: lib.name, spellcheck: false });
  libInput.setAttribute("aria-label", "Library name");
  const libSave = h("button", "tpm-btn", { type: "button", textContent: "Rename", disabled: true });
  const libErr = h("div", "tpm-error");
  const libField = h("label", "tpm-field");
  const libRow = h("div", "tlm-row");
  libRow.append(libInput, libSave);
  libField.append(h("span", "tpm-label", { textContent: "Library name" }), libRow, libErr);
  const search = h("input", "tpm-input tlm-search", { type: "search", placeholder: "Filter assets…", spellcheck: false });
  search.setAttribute("aria-label", "Filter assets by name");
  // Thumbnail size, remembered in this browser.
  const SIZE_KEY = "tlm.thumbSize";
  let tileSize = 112;
  try { tileSize = Math.max(64, Math.min(256, Number(localStorage.getItem(SIZE_KEY)) || 112)); } catch { /* storage blocked */ }
  const size = h("input", "", { type: "range", min: 64, max: 256, step: 8, value: tileSize });
  size.setAttribute("aria-label", "Thumbnail size");
  size.title = "Thumbnail size";
  const sizeField = h("label", "tlm-size");
  const sizeRow = h("div", "tlm-sizerow");
  const small = icon("image"), big = icon("image");
  big.classList.add("tlm-big");
  sizeRow.append(small, size, big);
  sizeField.append(h("span", "tpm-label", { textContent: "Thumbnail size" }), sizeRow);
  // Type filters (image / video / audio), all shown at first.
  const shownKinds = new Set(KINDS);
  const kindBtns = {};
  const filters = h("div", "tlm-filters");
  for (const k of KINDS) {
    const b = h("button", "tlm-kind", { type: "button" });
    b.append(icon(k));
    b.onclick = () => {
      if (shownKinds.has(k)) shownKinds.delete(k);
      else shownKinds.add(k);
      filterChanged();
    };
    kindBtns[k] = b;
    filters.append(b);
  }
  filters.append(search);
  const top = h("div", "tlm-top");
  top.append(libField, sizeField, filters);

  // ---- main: grid + properties
  const grid = h("div", "tlm-grid");
  grid.setAttribute("role", "listbox");
  grid.setAttribute("aria-multiselectable", "true");
  grid.setAttribute("aria-label", "Assets");
  const gridWrap = h("div", "tlm-gridwrap");
  gridWrap.append(grid);
  const props = h("div", "tlm-props");
  props.setAttribute("aria-label", "Asset properties");
  const main = h("div", "tlm-main");
  main.append(gridWrap, props);
  const note = h("div", "tpm-note");

  const assets = () => library.assets.filter((a) => a.library === libId);
  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return assets().filter((a) => shownKinds.has(assetKind(a))
      && (!q || a.name.toLowerCase().includes(q) || baseName(a.path).toLowerCase().includes(q)));
  };

  // ---- grid
  const tiles = new Map(); // asset id -> { el, sig }
  function tile(a) {
    const kind = assetKind(a);
    const missing = a.exists === false;
    const el = h("button", `tlm-tile${missing ? " tlm-missing" : ""}`, { type: "button", title: missing ? `${a.name}: file not found` : `${a.name}\n${a.path}` });
    el.setAttribute("role", "option");
    el.dataset.id = a.id;
    const url = !missing ? library.thumbUrl(a, thumbRes()) : null;
    let thumb;
    if (url) {
      thumb = h("img", "tlm-thumb", { alt: "", src: url, loading: "lazy", draggable: false });
      thumb.onerror = () => thumb.replaceWith(iconBox("tlm-thumb", kind));
    } else thumb = iconBox("tlm-thumb", missing ? "alert" : kind);
    el.append(thumb, h("span", "tlm-name", { textContent: a.name }));
    if (missing || kind !== "image") {
      const b = h("span", `tlm-badge ${missing ? "tlm-gone" : `tlm-${kind}`}`, { title: missing ? "File not found" : kind });
      b.append(icon(missing ? "alert" : kind));
      el.append(b);
    }
    el.onclick = (e) => select(a.id, e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "only");
    el.ondblclick = (e) => {
      if (e.shiftKey || e.metaKey || e.ctrlKey) return;
      select(a.id);
      focusName();
    };
    return el;
  }

  /** Thumbnail resolution for the current tile size (sharp on high-density screens). */
  const thumbRes = () => (tileSize > 128 ? 512 : 256);
  function applySize() {
    grid.style.setProperty("--tlm-tile", `${tileSize}px`);
    grid.classList.toggle("tlm-small", tileSize < 96);
  }
  size.oninput = () => {
    tileSize = Number(size.value);
    applySize();
    renderGrid(); // tiles that need a sharper thumbnail are rebuilt
    tiles.get(focusId)?.el.scrollIntoView({ block: "nearest" });
    try { localStorage.setItem(SIZE_KEY, String(tileSize)); } catch { /* storage blocked */ }
  };

  function renderGrid() {
    const list = visible();
    const ids = new Set(list.map((a) => a.id));
    for (const [id, t] of tiles) if (!ids.has(id)) { t.el.remove(); tiles.delete(id); }
    const els = list.map((a) => {
      const s = `${sig(a)}|${thumbRes()}`;
      let t = tiles.get(a.id);
      if (!t || t.sig !== s) {
        const el = tile(a);
        if (t) t.el.replaceWith(el);
        t = { el, sig: s };
        tiles.set(a.id, t);
      }
      t.el.classList.toggle("tlm-sel", sel.has(a.id));
      t.el.setAttribute("aria-selected", String(sel.has(a.id)));
      t.el.tabIndex = a.id === focusId || (!ids.has(focusId) && a === list[0]) ? 0 : -1;
      return t.el;
    });
    // Keep the existing elements (no image reloads); only fix their order.
    els.forEach((el, i) => { if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] ?? null); });
    grid.querySelector(".tlm-empty")?.remove();
    if (!list.length) {
      const all = assets().length;
      grid.append(h("div", "tlm-empty", {
        textContent: !all ? "This library is empty. Add files to it with + Add files… below."
          : !shownKinds.size ? "All types are hidden. Turn on images, videos or audio above."
          : search.value.trim() ? `No ${shownKinds.size < KINDS.length ? "shown " : ""}asset matches “${search.value.trim()}”.`
          : "No assets of the shown types.",
      }));
      grid.lastChild.style.gridColumn = "1 / -1";
    }
    const n = assets().length;
    for (const k of KINDS) {
      const c = assets().filter((a) => assetKind(a) === k).length;
      const on = shownKinds.has(k);
      const label = { image: "Images", video: "Videos", audio: "Audio" }[k];
      kindBtns[k].setAttribute("aria-pressed", String(on));
      kindBtns[k].title = `${label} (${c}): ${on ? "shown" : "hidden"}. Click to ${on ? "hide" : "show"} them.`;
      kindBtns[k].setAttribute("aria-label", kindBtns[k].title);
    }
    const enabled = enabledSetFor(node);
    const shown = list.length < n ? `, ${list.length} shown` : "";
    note.textContent = `${n} asset${n === 1 ? "" : "s"}${shown}${sel.size > 1 ? `, ${sel.size} selected` : ""}. ⌘/Ctrl-click or Shift-click to select several. `
      + "Changes are saved straight away; tags in this workflow follow renames and replaced files."
      + (enabled && !enabled.has(libId) ? ` ${libNow()?.name ?? lib.name} is switched off in this node.` : "");
  }

  const iconBox = (cls, name) => {
    const d = h("div", cls);
    d.append(icon(name));
    return d;
  };

  // ---- properties
  let propsSig = null;
  let nameInput = null;
  let nameSave = null;
  let propErr = null;
  let buttons = []; // [{ el, ok }]: `ok` = usable for this selection (Rename/Replace/Copy need exactly one asset)

  function renderProps(force = false) {
    const picked = [...sel].map((id) => library.byId(id)).filter(Boolean);
    const a = picked.length === 1 ? picked[0] : null;
    const multi = picked.length > 1;
    const s = a ? sig(a) : multi ? `multi|${picked.map((x) => x.id).join(",")}` : `none|${assets().length}`;
    if (!force && s === propsSig) return;
    // Don't throw away a name being typed when something unrelated refreshes the library.
    const typing = nameInput && document.activeElement === nameInput && a && propsSig?.startsWith(`${a.id}|${a.name}|`);
    if (typing && !force) return;
    propsSig = s;
    nameInput = nameSave = propErr = null;
    buttons = [];
    if (!a && !multi) {
      props.replaceChildren(h("div", "tlm-hint", { textContent: assets().length ? "Select an asset to see its properties." : "No assets yet." }));
      return;
    }
    const kind = a ? assetKind(a) : null;
    const missing = a?.exists === false;

    let preview;
    if (multi) {
      // No preview of several files: a small stack and what's in the selection.
      preview = h("div", "tlm-preview tlm-multi tlm-off");
      const stack = h("div", "tlm-stack");
      picked.slice(0, 3).forEach((x, i) => {
        const url = x.exists !== false ? library.thumbUrl(x, 128) : null;
        const el = url ? h("img", "", { alt: "", src: url, draggable: false }) : iconBox("", x.exists === false ? "alert" : assetKind(x));
        Object.assign(el.style, { left: `${i * 16}px`, top: `${i * 6}px` });
        stack.append(el);
      });
      const counts = KINDS.map((k) => [k, picked.filter((x) => assetKind(x) === k).length]).filter(([, n]) => n)
        .map(([k, n]) => `${n} ${k === "audio" ? "audio" : `${k}${n > 1 ? "s" : ""}`}`).join(", ");
      preview.append(stack, h("div", "", { textContent: `${picked.length} assets selected` }), h("div", "tlm-info", { textContent: counts }));
    } else if (missing) {
      preview = h("div", "tlm-preview tlm-gone");
      preview.append(icon("alert"), h("div", "", { textContent: "File not found. Replace it to point this asset at its new location." }));
    } else if (kind === "video") {
      preview = h("div", "tlm-preview");
      const v = h("video", "", { src: library.fileUrl(a), poster: library.thumbUrl(a, 512), controls: true, preload: "metadata", muted: true, loop: true });
      v.playsInline = true;
      preview.append(v);
    } else if (kind === "audio") {
      preview = h("div", "tlm-preview");
      preview.append(h("audio", "", { src: library.fileUrl(a), controls: true, preload: "metadata" }));
    } else {
      preview = h("div", "tlm-preview");
      const img = h("img", "", { alt: a.name, src: library.thumbUrl(a, 512), draggable: false });
      img.onerror = () => img.replaceWith(icon("image"));
      preview.append(img);
    }

    // Name (the @tag)
    nameInput = h("input", "tpm-input", { value: a?.name ?? "", spellcheck: false, disabled: multi });
    if (multi) nameInput.placeholder = "Several assets selected";
    nameInput.setAttribute("aria-label", "Name (used as @tag)");
    nameSave = h("button", "tpm-btn", { type: "button", textContent: "Rename", disabled: true });
    const nameRow = h("div", "tlm-row");
    nameRow.append(nameInput, nameSave);
    propErr = h("div", "tpm-error");
    nameInput.oninput = () => {
      propErr.textContent = "";
      nameInput.classList.remove("tpm-invalid");
      nameSave.disabled = working || !a || tagName(nameInput.value) === a.name;
    };
    nameSave.onclick = () => renameAsset();

    const prop = (label, ...val) => {
      const el = h("div", `tlm-prop${multi ? " tlm-off" : ""}`);
      el.append(h("span", "tpm-label", { textContent: label }), ...val);
      return el;
    };
    const nameProp = h("label", `tlm-prop${multi ? " tlm-off" : ""}`);
    nameProp.append(h("span", "tpm-label", { textContent: "Name (used as @tag)" }), nameRow);

    const pathRow = h("div", "tlm-pathrow");
    const pathVal = multi ? h("div", "tlm-val tlm-path tlm-none", { textContent: "—" })
      : h("div", `tlm-val tlm-path${missing ? " tlm-gone" : ""}`, { textContent: a.path });
    const copy = h("button", "tpm-btn tlm-copy", { type: "button", textContent: "Copy", title: multi ? "Select one asset to copy its path" : "Copy the path" });
    copy.onclick = async () => {
      if (!a) return;
      try {
        await navigator.clipboard.writeText(a.path);
        copy.textContent = "Copied";
      } catch {
        const r = document.createRange(); // clipboard blocked (http on another host): select it instead
        r.selectNodeContents(pathVal);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        copy.textContent = "Selected";
      }
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    };
    pathRow.append(pathVal, copy);

    const replaceBtn = h("button", "tpm-btn", { type: "button" });
    replaceBtn.append(icon("replace"), document.createTextNode(missing ? "Locate / replace file…" : "Replace file…"));
    replaceBtn.title = multi ? "Select one asset to replace its file" : `Point @${a.name} at another ${kind} file. Its name and tags stay.`;
    replaceBtn.onclick = () => replaceAsset();
    const removeBtn = h("button", "tpm-btn tlm-remove", { type: "button" });
    removeBtn.append(icon("trash"), document.createTextNode(multi ? `Remove ${picked.length} assets from library` : "Remove from library"));
    removeBtn.title = `Remove ${multi ? "them" : "it"} from this library. Files on disk are not touched.`;
    removeBtn.onclick = () => removeSelected();
    buttons = [{ el: copy, ok: !multi }, { el: replaceBtn, ok: !multi }, { el: removeBtn, ok: true }];
    const actions = h("div", "tlm-actions");
    actions.append(replaceBtn, removeBtn);

    props.replaceChildren(
      preview,
      h("div", "tlm-info", { textContent: a ? describe(a) : "" }),
      nameProp, propErr,
      prop("Filename", multi ? h("div", "tlm-val tlm-none", { textContent: "—" }) : h("div", "tlm-val", { textContent: baseName(a.path) })),
      prop("Local file path", pathRow),
      actions,
    );
    setWorking(working);
  }

  // ---- selection & keyboard
  /**
   * Selects by click or key. "only": just this one; "toggle": add / take it out (⌘/Ctrl-click);
   * "range": everything from the anchor to it, in grid order (Shift-click, Shift+arrows).
   */
  function select(id, mode = "only", { focus = true } = {}) {
    if (mode === "toggle") {
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      anchorId = id;
    } else if (mode === "range" && anchorId && visible().some((a) => a.id === anchorId)) {
      const list = visible().map((a) => a.id);
      const [i, j] = [list.indexOf(anchorId), list.indexOf(id)].sort((x, y) => x - y);
      sel.clear();
      list.slice(i, j + 1).forEach((x) => sel.add(x));
    } else {
      sel.clear();
      sel.add(id);
      anchorId = id;
    }
    focusId = id;
    renderGrid();
    renderProps();
    const el = tiles.get(id)?.el;
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      if (focus) el.focus({ preventScroll: true });
    }
  }
  function selectAll() {
    const list = visible();
    if (!list.length) return;
    list.forEach((a) => sel.add(a.id));
    focusId ??= list[0].id;
    anchorId ??= list[0].id;
    renderGrid();
    renderProps();
  }
  const focusName = () => setTimeout(() => nameInput && !nameInput.disabled && nameInput.select(), 0);

  function moveSelection(key, extend) {
    const list = visible();
    if (!list.length) return;
    let i = list.findIndex((a) => a.id === focusId);
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, Home: -Infinity, End: Infinity }[key];
    i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + step));
    select(list[i].id, extend ? "range" : "only");
  }

  const onKey = (e) => {
    const t = e.target;
    const onTile = t.classList?.contains("tlm-tile");
    if (e.key === "Enter") {
      if (t === libInput) return libRename(), e.preventDefault(), true;
      if (t === nameInput) return renameAsset(), e.preventDefault(), true;
      if (t === search) return e.preventDefault(), true;
      if (onTile) return focusName(), e.preventDefault(), true;
      return false; // a focused button: the browser presses it
    }
    if (onTile && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "a") return selectAll(), e.preventDefault(), true;
    if (onTile && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (/^Arrow|^Home$|^End$/.test(e.key)) return moveSelection(e.key, e.shiftKey), e.preventDefault(), true;
      if (e.key === " ") return select(t.dataset.id, "toggle"), e.preventDefault(), true;
      if (e.key === "Delete" || e.key === "Backspace") return removeSelected(), e.preventDefault(), true;
      if (e.key === "F2") return focusName(), e.preventDefault(), true;
    }
    return false;
  };

  // ---- actions
  /**
   * Disables the buttons while a step runs. `closable`: waiting on the native file dialog, which
   * can't be cancelled from here, so Done / × / Escape still close (its late answer is then dropped).
   */
  function setWorking(on, closable = false) {
    working = on;
    ctl?.busy(on && !closable);
    const add = ctl?.button("Add files…");
    if (add) add.disabled = on;
    libSave.disabled = on || tagName(libInput.value) === (libNow()?.name ?? lib.name);
    if (nameSave && nameInput) nameSave.disabled = on || !single() || tagName(nameInput.value) === single().name;
    for (const b of buttons) b.el.disabled = on || !b.ok;
  }

  /** Runs one change; returns its result, or undefined if it failed (the error is shown in `errEl`). */
  async function run(change, errEl) {
    setWorking(true);
    try {
      return await pinned(change);
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
      else toast("error", e.message);
      return undefined;
    } finally {
      setWorking(false);
    }
  }

  const tagsNote = (fixed) => (fixed ? ` Updated ${fixed} tag${fixed > 1 ? "s" : ""}.` : "");

  libInput.oninput = () => {
    libErr.textContent = "";
    libInput.classList.remove("tpm-invalid");
    libSave.disabled = working || tagName(libInput.value) === (libNow()?.name ?? lib.name);
  };
  libSave.onclick = () => libRename();
  async function libRename() {
    if (working) return;
    const cur = libNow()?.name ?? lib.name;
    const n = tagName(libInput.value);
    if (!n) {
      libErr.textContent = "Library names need at least one letter or digit.";
      return libInput.classList.add("tpm-invalid");
    }
    if (n === cur) return void (libInput.value = cur);
    const res = await run(() => library.renameLibrary(libId, n), libErr);
    if (!res) return libInput.classList.add("tpm-invalid");
    libInput.value = n;
    ctl.titleEl.textContent = `Edit ${n}`;
    toast("success", `${cur} is now ${n}.${tagsNote(res.fixed)}`);
  }

  async function renameAsset() {
    const a = single();
    if (!a || working || !nameInput) return;
    const n = tagName(nameInput.value);
    if (!n) {
      propErr.textContent = "Names need at least one letter or digit.";
      return nameInput.classList.add("tpm-invalid");
    }
    if (n === a.name) return void (nameInput.value = a.name);
    const input = nameInput, err = propErr;
    const res = await run(() => library.rename(a.id, n), err);
    if (!res) {
      input.classList.add("tpm-invalid");
      return input.select();
    }
    renderProps(true);
    toast("success", `@${a.name} is now @${n}.${tagsNote(res.fixed)}`);
  }

  async function replaceAsset() {
    const a = single();
    if (!a || working) return;
    const kind = assetKind(a);
    const token = ++pickToken;
    setWorking(true, true);
    const waiting = h("div", "tpm-note", { textContent: "Waiting for the file dialog… (it may be behind this window)" });
    props.append(waiting);
    let paths = [];
    try {
      paths = await library.pick([kind], false);
    } catch (e) {
      if (token === pickToken && !ctl.closed) propErr.textContent = `File dialog: ${e.message}`;
    }
    waiting.remove();
    setWorking(false);
    if (token !== pickToken || ctl.closed || !paths.length || single()?.id !== a.id) return;
    const path = paths[0];
    const err = propErr;
    const res = await run(() => library.replace(a.id, path, a.name), err);
    if (!res) return;
    renderProps(true);
    toast("success", `@${a.name} now uses ${baseName(path)}.${tagsNote(res.fixed)}`);
  }

  async function removeSelected() {
    const picked = [...sel].map((id) => library.byId(id)).filter(Boolean);
    if (!picked.length || working) return;
    const libName = libNow()?.name ?? lib.name;
    const n = picked.length;
    const names = picked.slice(0, 5).map((a) => `@${a.name}`).join(", ") + (n > 5 ? ` and ${n - 5} more` : "");
    setWorking(true);
    const ok = await confirmModal(n === 1 ? `Remove @${picked[0].name}?` : `Remove ${n} assets?`,
      n === 1 ? `It is removed from ${libName}; the file itself stays on disk. Tags that use it will turn red.`
        : `${names} are removed from ${libName}; the files themselves stay on disk. Tags that use them will turn red.`,
      n === 1 ? "Remove" : `Remove ${n}`);
    setWorking(false);
    if (!ok || ctl.closed) return;
    // Afterwards, select the asset after the last removed one (else the one before the first).
    const list = visible();
    const gone = new Set(picked.map((a) => a.id));
    const idx = list.map((a, i) => (gone.has(a.id) ? i : -1)).filter((i) => i >= 0);
    const next = list.slice((idx.at(-1) ?? -1) + 1).find((a) => !gone.has(a.id))
      ?? list.slice(0, idx[0] ?? 0).reverse().find((a) => !gone.has(a.id)) ?? null;
    let done = 0;
    const res = await run(async () => {
      for (const a of picked) {
        await library.remove(a.id); // one at a time: a failure leaves the rest as they were
        done++;
      }
    });
    if (res === undefined && !done) return;
    if (done < n) toast("warn", `Removed ${done} of ${n} assets from ${libName}.`);
    else toast("success", n === 1 ? `Removed @${picked[0].name} from ${libName}.` : `Removed ${n} assets from ${libName}.`);
    sel.clear();
    if (next && library.byId(next.id)) select(next.id);
    else {
      focusId = anchorId = null;
      renderGrid();
      renderProps();
      grid.querySelector(".tlm-tile")?.focus();
    }
  }

  async function addFiles() {
    if (working) return;
    const token = ++pickToken;
    setWorking(true, true);
    note.textContent = "Waiting for the file dialog… (it may be behind this window)";
    let paths = [];
    try {
      paths = await library.pick(KINDS, true);
    } catch (e) {
      if (token === pickToken && !ctl.closed) toast("error", `File dialog: ${e.message}`);
    }
    setWorking(false);
    if (token !== pickToken || ctl.closed) return;
    if (!paths.length) return renderGrid();
    const out = await run(() => library.add({ library_id: libId }, paths.map((path) => ({ path }))));
    if (!out) return renderGrid();
    const res = out.result;
    const bits = [];
    if (res.added.length) bits.push(`Added ${res.added.length === 1 ? `@${res.added[0].name}` : `${res.added.length} files`}.`);
    if (res.renamed?.length) bits.push(`Renamed to avoid clashes: ${res.renamed.map((r) => `${r.from} → ${r.to}`).join(", ")}.`);
    if (res.rejected?.length) bits.push(`Skipped ${res.rejected.length}: ${res.rejected.map((r) => r.error).join(" ")}`);
    toast(res.added.length ? (res.rejected?.length ? "warn" : "success") : "warn", bits.join(" ") || "Nothing was added.");
    if (res.added.length) {
      search.value = "";
      for (const a of res.added) shownKinds.add(assetKind(a)); // new files are never added out of sight
      select(res.added[0].id);
    }
  }

  // ---- dialog
  /**
   * Filters changed: the selection keeps only what's still shown, so Remove never takes assets you
   * can't see. If nothing selected is left, the first shown asset is selected.
   */
  function filterChanged() {
    const ids = new Set(visible().map((a) => a.id));
    for (const id of [...sel]) if (!ids.has(id)) sel.delete(id);
    if (!ids.has(focusId)) focusId = null;
    if (!ids.has(anchorId)) anchorId = null;
    if (!sel.size && ids.size) {
      const first = visible()[0].id;
      sel.add((focusId = anchorId = first));
    }
    focusId ??= [...sel][0] ?? null;
    renderGrid();
    renderProps();
  }
  search.oninput = () => filterChanged();

  const unsub = library.onChange(() => {
    if (ctl.closed) return;
    const l = libNow();
    if (!l) {
      toast("warn", `${lib.name} was deleted.`);
      return ctl.close(true);
    }
    if (document.activeElement !== libInput) libInput.value = l.name;
    ctl.titleEl.textContent = `Edit ${l.name}`;
    for (const id of [...sel]) if (!library.byId(id)) sel.delete(id);
    if (focusId && !library.byId(focusId)) focusId = null;
    renderGrid();
    renderProps();
  });

  ctl = modal({
    title: `Edit ${lib.name}`,
    cls: "tlm",
    content: [top, main, note],
    actions: [
      { label: "Add files…", icon: "plus", left: true, onClick: () => addFiles() },
      { label: "Done", onClick: (c) => c.close() }, // not "primary": Enter belongs to the fields
    ],
    onKey,
    onClose: () => {
      pickToken++;
      unsub();
    },
  });

  const first = assets()[0];
  if (first) sel.add((focusId = anchorId = first.id));
  applySize();
  renderGrid();
  renderProps();
  (tiles.get(focusId)?.el ?? search).focus();
  // Re-check the files on disk (moved / deleted since the last look); the dialog follows.
  library.load(true, 3000);
  return ctl;
}
