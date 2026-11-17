// Library dialogs: Add (pick library, pick files, name a single file), Edit an asset (rename /
// replace its file / remove), and the per-node Libraries dropdown (toggle, edit, export, delete,
// import). Editing a
// library (rename it, manage its assets) is lib_manager.js.
import { KINDS, assetKind, formatDuration, kindOfPath, library, stem, tagName, toast } from "./common.js";
import { openLibraryManager } from "./lib_manager.js";
import { field, h, icon, installUiStyle, modal } from "./ui.js";

// Prompt rewriting lives in tp_pins.js; tagged_prompt.js registers these so renames update the prompts.
let hooks = {
  enabledSet: () => null, // node -> Set of enabled library ids
  setLibEnabled: () => {}, // (node, libId, on)
  snapshot: null, // () -> which file every tag points at (before a library change)
  restore: () => 0, // snapshot -> re-points moved tags, returns how many changed
};
export const setHooks = (h) => (hooks = { ...hooks, ...h });
/** Libraries enabled in a Reference Prompt (a Set of ids), or null = all. */
export const enabledSetFor = (node) => hooks.enabledSet(node);

/** Runs a library change with tags pinned to their files (renames followed, take-overs prevented). */
export async function pinned(change) {
  if (!hooks.snapshot) console.warn("[LibraryImage] tag hooks not registered; tags won't follow renames");
  library.hold(); // strips and outputs update once, after the tags are re-pinned
  try {
    const snap = hooks.snapshot?.();
    const result = await change();
    return { result, fixed: snap ? hooks.restore(snap) : 0 };
  } finally {
    library.release();
  }
}

const article = (w) => (/^[aeiou]/i.test(w) ? "an" : "a");

function assetPreview(asset, { path = asset?.path, kind = assetKind(asset), isNew = false } = {}) {
  const missing = !isNew && asset?.exists === false; // a newly picked file exists by definition
  const box = h("div", "tpm-asset");
  const thumbUrl = isNew ? library.pickedThumbUrl(path, kind) : asset ? library.thumbUrl(asset, 128) : null;
  let thumb;
  if (thumbUrl && !missing) {
    thumb = h("img", "tpm-thumb", { alt: "", src: thumbUrl });
    thumb.onerror = () => thumb.replaceWith(iconThumb(kind));
  } else {
    thumb = iconThumb(missing ? "alert" : kind);
  }
  const meta = h("div", "tpm-meta");
  const dur = asset && !isNew ? formatDuration(asset.duration) : "";
  meta.append(
    h("div", "", { textContent: `${kind}${dur ? ` · ${dur}` : ""}${asset?.width && !isNew ? ` · ${asset.width}×${asset.height}` : ""}` }),
    h("div", `tpm-path${missing ? " tpm-missing" : ""}${isNew ? " tpm-new" : ""}`,
      { textContent: missing ? `File not found: ${path}` : isNew ? `New file: ${path}` : path }),
  );
  box.append(thumb, meta);
  return box;
}

/**
 * Opens the server's native file dialog while the modal stays cancellable (Cancel / Escape still
 * work; the other buttons wait). Resolves to the picked paths, or null if the modal was closed
 * meanwhile, so a late selection is ignored.
 */
async function pickWhileOpen(ctl, kinds, multi, onError) {
  const buttons = [...ctl.box.querySelectorAll(".tpm-foot button")].filter((b) => b.dataset.label !== "Cancel");
  buttons.forEach((b) => (b.disabled = true));
  const waiting = h("div", "tpm-note", { textContent: "Waiting for the file dialog… (it may be behind this window)" });
  ctl.body.append(waiting);
  let paths = [];
  try {
    paths = await library.pick(kinds, multi);
  } catch (e) {
    if (!ctl.closed) onError(e);
  }
  waiting.remove();
  if (ctl.closed) return null;
  buttons.forEach((b) => (b.disabled = false));
  return paths;
}

function iconThumb(name) {
  const d = h("div", "tpm-thumb");
  d.append(icon(name));
  return d;
}

// ---------------------------------------------------------------- Add

/**
 * Add files to a library. Step 1: choose a library (switched-off ones included) or name a new
 * one, then pick files. One file: step 2 asks for its name (defaults to the file name). Several
 * files go straight in, named after their files. Resolves to the added assets ([] if cancelled).
 */
export function openAddDialog({ node = null, preselectNew = false } = {}) {
  return new Promise((resolve) => {
    let result = [];
    const enabled = hooks.enabledSet(node);
    const NEW = "__new__";
    const libs = library.libraries;

    const select = h("select", "tpm-select");
    for (const l of libs) {
      const off = enabled && !enabled.has(l.id);
      select.append(h("option", "", { value: l.id, textContent: `${l.name} (${l.count})${off ? " · off in this node" : ""}` }));
    }
    select.append(h("option", "", { value: NEW, textContent: "New library…" }));
    const firstOn = libs.find((l) => !enabled || enabled.has(l.id));
    select.value = preselectNew || !libs.length ? NEW : (firstOn ?? libs[0]).id;

    const libField = field("Library", select);
    const newName = field("New library name", h("input", "tpm-input", { value: library.nextLibraryName, spellcheck: false }));
    const note = h("div", "tpm-note");

    const step1 = () => {
      ctl.titleEl.textContent = libs.length ? "Add to library" : "Add to your first library";
      ctl.body.replaceChildren(...(libs.length ? [libField.el] : []), newName.el, note);
      const sync = () => {
        newName.el.hidden = select.value !== NEW;
        const lib = library.lib(select.value);
        note.textContent = !libs.length ? "Name your first library. New libraries are created once a file has been added."
          : select.value === NEW ? "The library is created once at least one file has been added."
          : enabled && lib && !enabled.has(lib.id) ? `${lib.name} is switched off in this node, so its files won't show here until you turn it on.`
          : "Pick one file to name it, or several to add them under their file names.";
      };
      select.onchange = sync;
      sync();
      ctl.setActions([
        { label: "Cancel", onClick: () => ctl.close() },
        { label: "Pick files…", icon: "plus", kind: "primary", onClick: pickFiles },
      ]);
      setTimeout(() => (select.value === NEW ? newName.input : select).focus(), 0);
    };

    /** The chosen target: { library_id } or { new_library } (validated locally first). */
    const target = () => {
      if (select.value !== NEW) return { library_id: select.value };
      const name = tagName(newName.input.value);
      newName.input.classList.toggle("tpm-invalid", !name || !!library.libByName(name));
      newName.error.textContent = !name ? "Give the library a name." : library.libByName(name) ? `A library called ${name} already exists.` : "";
      return newName.error.textContent ? null : { new_library: name };
    };
    const targetName = (t) => (t.library_id ? library.libName(t.library_id) : `${t.new_library} (new)`);

    const pickFiles = async () => {
      const t = target();
      if (!t) return;
      const paths = await pickWhileOpen(ctl, KINDS, true, (e) => (note.textContent = `File dialog: ${e.message}`));
      if (!paths?.length) return;
      if (paths.length === 1) return nameStep(t, paths[0]);
      ctl.busy(true);
      try {
        const { result: res } = await pinned(() => library.add(t, paths.map((path) => ({ path }))));
        result = res.added;
        report(res, t);
        ctl.close(true);
      } catch (e) {
        ctl.busy(false);
        showTargetError(e);
      }
    };

    const showTargetError = (e) => {
      if (e.field === "library" && select.value === NEW) newName.error.textContent = e.message;
      else note.textContent = e.message;
    };

    const nameStep = (t, path) => {
      const kind = kindOfPath(path) ?? "image";
      const name = field("Display name (used as @tag)", h("input", "tpm-input", { value: tagName(stem(path)), spellcheck: false }));
      const fileErr = h("div", "tpm-error");
      ctl.titleEl.textContent = `Add to ${targetName(t)}`;
      ctl.body.replaceChildren(assetPreview(null, { path, kind, isNew: true }), fileErr, name.el);
      ctl.setActions([
        { label: "Back", left: true, onClick: step1 },
        { label: "Cancel", onClick: () => ctl.close() },
        {
          label: "Add", kind: "primary", onClick: async () => {
            const n = tagName(name.input.value);
            if (!n) return void (name.error.textContent = "Names need at least one letter or digit.");
            ctl.busy(true);
            try {
              const { result: res } = await pinned(() => library.add(t, [{ path, name: n }]));
              result = res.added;
              report(res, t);
              ctl.close(true);
            } catch (e) {
              ctl.busy(false);
              if (e.field === "name") {
                name.error.textContent = e.message;
                name.input.classList.add("tpm-invalid");
                name.input.select();
              } else if (e.field === "library") {
                step1();
                showTargetError(e);
              } else fileErr.textContent = e.message;
            }
          },
        },
      ]);
      setTimeout(() => name.input.select(), 0);
      name.input.oninput = () => {
        name.error.textContent = "";
        name.input.classList.remove("tpm-invalid");
      };
    };

    const report = (res, t) => {
      const lib = library.lib(res.library) ?? { name: t.new_library };
      const bits = [];
      if (res.added.length) bits.push(`Added ${res.added.length === 1 ? `@${res.added[0].name}` : `${res.added.length} files`} to ${lib.name}.`);
      if (res.renamed?.length) bits.push(`Renamed to avoid clashes: ${res.renamed.map((r) => `${r.from} → ${r.to}`).join(", ")}.`);
      if (res.rejected?.length) bits.push(`Skipped ${res.rejected.length}: ${res.rejected.map((r) => r.error).join(" ")}`);
      // Fresh check: a library created by this add didn't exist when the dialog opened.
      const enabledNow = hooks.enabledSet(node);
      if (enabledNow && res.library && !enabledNow.has(res.library)) bits.push(`${lib.name} is off in this node.`);
      toast(res.added.length ? (res.rejected?.length ? "warn" : "success") : "warn", bits.join(" ") || "Nothing was added.");
    };

    const ctl = modal({ title: "", onClose: () => resolve(result) });
    step1();
  });
}

// ---------------------------------------------------------------- Edit asset

/**
 * Edit an asset: rename it, replace its file (same type only; the name defaults to the new
 * file's name), or remove it. Renames update the tags in the open workflow. Assets in libraries
 * that are off in this node are read-only.
 */
export function openEditDialog(asset, { node = null } = {}) {
  const enabled = hooks.enabledSet(node);
  const readOnly = !!(enabled && !enabled.has(asset.library));
  const kind = assetKind(asset);
  const libName = library.libName(asset.library);
  let newPath = null;

  const preview = h("div");
  const fileErr = h("div", "tpm-error");
  const name = field("Display name (used as @tag)", h("input", "tpm-input", { value: asset.name, spellcheck: false, disabled: readOnly }));
  const note = h("div", "tpm-note", {
    textContent: readOnly ? `${libName} is switched off in this node. Turn it on to edit or replace this ${kind}.`
      : `In ${libName}. Renaming updates its tags in this workflow.`,
  });
  const showPreview = () => preview.replaceChildren(newPath
    ? assetPreview(asset, { path: newPath, kind, isNew: true })
    : assetPreview(asset));
  showPreview();
  name.input.oninput = () => {
    name.error.textContent = "";
    name.input.classList.remove("tpm-invalid");
  };

  const save = async (ctl) => {
    const n = tagName(name.input.value);
    if (!n) return void (name.error.textContent = "Names need at least one letter or digit.");
    if (!newPath && n === asset.name) return ctl.close();
    ctl.busy(true);
    let fixed = 0;
    try {
      ({ fixed } = await pinned(() => (newPath ? library.replace(asset.id, newPath, n) : library.rename(asset.id, n))));
    } catch (e) {
      ctl.busy(false);
      if (e.field === "name") {
        name.error.textContent = e.message;
        name.input.classList.add("tpm-invalid");
        name.input.select();
      } else fileErr.textContent = e.message;
      return;
    }
    const renamed = n !== asset.name ? `@${asset.name} is now @${n}` : `@${n}`;
    toast("success", `${renamed}${newPath ? ` (${kind} replaced)` : ""}.${fixed ? ` Updated ${fixed} tag${fixed > 1 ? "s" : ""}.` : ""}`);
    ctl.close(true);
  };

  const replace = async (ctl) => {
    const paths = await pickWhileOpen(ctl, [kind], false, (e) => (fileErr.textContent = `File dialog: ${e.message}`));
    if (!paths?.length) return;
    newPath = paths[0];
    fileErr.textContent = "";
    name.input.value = tagName(stem(newPath)); // replaced files default to their own file name
    name.error.textContent = "";
    showPreview();
    name.input.select();
  };

  const remove = async (ctl) => {
    ctl.busy(true); // no double clicks, and Save/Replace can't run meanwhile
    const ok = await confirmModal(`Remove @${asset.name}?`,
      `It is removed from ${libName}; the file itself stays on disk. Tags that use it will turn red.`, "Remove");
    if (!ok) return ctl.busy(false);
    try {
      await pinned(() => library.remove(asset.id)); // its tags turn red, never re-point
      toast("success", `Removed @${asset.name} from ${libName}.`);
      ctl.close(true);
    } catch (e) {
      ctl.busy(false);
      fileErr.textContent = e.message;
    }
  };

  const actions = readOnly
    ? [{ label: "Close", kind: "primary", onClick: (c) => c.close() }]
    : [
      { label: "Replace file…", icon: "replace", left: true, onClick: replace },
      { label: "Remove", icon: "trash", left: true, onClick: remove },
      { label: "Cancel", onClick: (c) => c.close() },
      { label: "Save", kind: "primary", onClick: save },
    ];
  modal({ title: `Edit @${asset.name}`, content: [preview, fileErr, name.el, note], actions });
}

/** Yes/no modal; resolves true when confirmed. */
export function confirmModal(title, message, confirmLabel = "OK", danger = true) {
  return new Promise((resolve) => {
    let answer = false;
    modal({
      title,
      content: [h("div", "", { textContent: message })],
      actions: [
        { label: "Cancel", onClick: (c) => c.close() },
        { label: confirmLabel, kind: danger ? "danger" : "primary", onClick: (c) => { answer = true; c.close(); } },
      ],
      onClose: () => resolve(answer),
      focus: danger ? "Cancel" : confirmLabel, // destructive actions need a deliberate click or Tab
    });
  });
}

// ---------------------------------------------------------------- Libraries dropdown

const PANEL_CSS = `
.tpl-panel{position:fixed;z-index:100050;width:280px;max-height:320px;display:flex;flex-direction:column;
  background:var(--comfy-menu-bg,#202124);color:var(--input-text,#eee);border:1px solid var(--border-color,#444);
  border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.45);font:12px/1.3 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.tpl-list{overflow:auto;overscroll-behavior:contain;padding:4px}
.tpl-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px}
.tpl-row:hover{background:var(--secondary-background,#262729)}
.tpl-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tpl-row.tpl-off .tpl-name{color:var(--muted-foreground,#8a8a8a)}
.tpl-count{color:var(--muted-foreground,#8a8a8a);font-size:11px}
.tpl-icon{border:0;background:transparent;color:var(--muted-foreground,#8a8a8a);cursor:pointer;border-radius:4px;padding:3px;display:flex}
.tpl-icon:hover{color:var(--base-foreground,#fff);background:color-mix(in srgb,var(--base-foreground,#fff) 10%,transparent)}
.tpl-icon svg{width:14px;height:14px}
.tpl-switch{position:relative;width:28px;height:16px;flex:none;border-radius:999px;border:0;cursor:pointer;padding:0;
  background:var(--secondary-background,#3a3a3a);transition:background .15s}
.tpl-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:var(--muted-foreground,#8a8a8a);transition:transform .15s,background .15s}
.tpl-switch[aria-checked="true"]{background:var(--base-foreground,#fff)}
.tpl-switch[aria-checked="true"]::after{transform:translateX(12px);background:var(--base-background,#171718)}
.tpl-empty{padding:10px;color:var(--muted-foreground,#8a8a8a)}
.tpl-foot{border-top:1px solid var(--secondary-background,#262729);padding:4px}
.tpl-new{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:var(--input-text,#eee);
  cursor:pointer;border-radius:6px;padding:6px;font:inherit}
.tpl-new:hover{background:var(--secondary-background,#262729)}
.tpl-new svg{width:14px;height:14px}
`;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const someNames = (names) => names.slice(0, 5).join(", ") + (names.length > 5 ? `, and ${names.length - 5} more` : "");

const EXPORT_CSS = `
.tpx-list{display:flex;flex-direction:column;max-height:min(46vh,340px);overflow:auto;overscroll-behavior:contain;
  border:1px solid var(--secondary-background,#262729);border-radius:8px;padding:4px}
.tpx-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer}
.tpx-row:hover{background:var(--secondary-background,#262729)}
.tpx-row input{width:15px;height:15px;margin:0;flex:none;cursor:pointer;accent-color:var(--base-foreground,#fff)}
.tpx-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tpx-count{color:var(--muted-foreground,#8a8a8a);font-size:12px;white-space:nowrap}
.tpx-count.tpx-warn{color:var(--tp-tag-bad,#ff6b6b)}
`;
const EXPORT_LABEL = "Choose folder and export…";

/**
 * Export dialog: every library with a checkbox, `first` (the one whose export button was clicked)
 * ticked. The ticked libraries go into one zip, in a folder picked in the server's folder dialog.
 */
export function openExportDialog(first) {
  installUiStyle();
  if (!document.getElementById("tpx-style")) {
    document.head.append(Object.assign(document.createElement("style"), { id: "tpx-style", textContent: EXPORT_CSS }));
  }
  const picked = new Set(first ? [first.id] : []);
  const list = h("div", "tpx-list");
  const status = h("div", "tpm-note");
  const error = h("div", "tpm-error");
  const boxes = new Map(); // library id -> its checkbox
  const chosen = () => library.libraries.filter((l) => picked.has(l.id));
  let ctl = null;
  const sync = () => {
    const libs = chosen();
    const files = libs.reduce((n, l) => n + l.count, 0);
    status.textContent = !libs.length ? "Tick at least one library."
      : `${plural(libs.length, "library").replace("librarys", "libraries")}, ${plural(files, "file")}, in one zip`
        + ` (${libs.length === 1 ? `${libs[0].name}.zip` : "Reference_Libraries.zip"}).`;
    const b = ctl?.button(EXPORT_LABEL);
    if (b) b.disabled = !libs.length;
  };
  for (const lib of library.libraries) {
    const missing = library.assets.filter((a) => a.library === lib.id && a.exists === false).length;
    const row = h("label", "tpx-row");
    const box = h("input", "", { type: "checkbox", checked: picked.has(lib.id) });
    box.onchange = () => {
      if (box.checked) picked.add(lib.id);
      else picked.delete(lib.id);
      error.textContent = "";
      sync();
    };
    boxes.set(lib.id, box);
    row.append(box, h("span", "tpx-name", { textContent: lib.name, title: lib.name }),
      h("span", `tpx-count${missing ? " tpx-warn" : ""}`, {
        textContent: plural(lib.count, "file") + (missing ? `, ${missing} missing` : ""),
        title: missing ? "Files missing on disk are left out of the export." : "",
      }));
    list.append(row);
  }
  const setAll = (on) => {
    for (const [id, box] of boxes) {
      box.checked = on;
      if (on) picked.add(id);
      else picked.delete(id);
    }
    error.textContent = "";
    sync();
  };
  const run = async (c) => {
    const libs = chosen();
    if (!libs.length) return;
    error.textContent = "";
    status.textContent = "Choose a folder in the window that opened (it may be behind ComfyUI). Large libraries take a moment to copy.";
    c.busy(true);
    let done;
    try {
      done = await library.exportLibraries(libs.map((l) => l.id));
    } catch (e) {
      c.busy(false);
      sync();
      error.textContent = `Export failed: ${e.message}`;
      return;
    }
    c.busy(false);
    sync();
    if (!done) return; // folder dialog cancelled: the selection stays
    c.close();
    const files = done.libraries.reduce((n, l) => n + l.files, 0);
    const skipped = done.libraries.flatMap((l) => l.skipped.map((name) => (done.libraries.length > 1 ? `${l.name}/${name}` : name)));
    const parts = [`Exported ${someNames(done.libraries.map((l) => l.name))} (${plural(files, "file")}) to ${done.path}.`];
    if (skipped.length) parts.push(`Left out (file missing on disk): ${someNames(skipped)}.`);
    if (done.empty.length) parts.push(`Not exported (no files on disk): ${someNames(done.empty)}.`);
    parts.push("On the other computer: Libraries → Import library…");
    toast(skipped.length || done.empty.length ? "warn" : "success", parts.join(" "), "Reference Library", true);
  };
  ctl = modal({
    title: "Export libraries",
    content: [
      h("div", "tpm-note", { textContent: "Tick the libraries to export. They are saved together as one zip (a copy of their files and names) in a folder you choose next." }),
      list, status, error,
    ],
    actions: [
      { label: "All", left: true, onClick: () => setAll(true) },
      { label: "None", left: true, onClick: () => setAll(false) },
      { label: "Cancel", onClick: (c) => c.close() },
      { label: EXPORT_LABEL, kind: "primary", icon: "exportOut", onClick: run },
    ],
    focus: EXPORT_LABEL,
  });
  sync();
  return ctl;
}

/** What an import did to one library of the zip, as a sentence or two. */
function importedText(d) {
  if (d.failed) return `${d.name}: nothing could be imported.`;
  const parts = [];
  if (d.new) parts.push(`Imported ${d.name} (${plural(d.added.length, "file")}).`);
  else if (d.added.length) parts.push(`Added ${plural(d.added.length, "new file")} to ${d.name}; ${d.already} were already there.`);
  else parts.push(`${d.name} already has everything in this export.`);
  if (d.wanted_name) parts.push(`A library called ${d.wanted_name} already exists, so it is named ${d.name}: tags written as @${d.wanted_name}/… won't find it.`);
  if (d.renamed.length) parts.push(`Renamed: ${someNames(d.renamed.map((r) => `${r.from} → ${r.to}`))}.`);
  return parts.join(" ");
}

/** Imports a zip picked in the file dialog: new libraries, or more files for ones that are already here. */
async function importLibrary() {
  try {
    const { result: done } = await pinned(() => library.importLibrary());
    if (!done) return; // dialog cancelled
    const libs = done.libraries;
    const parts = libs.map(importedText);
    const rejected = libs.flatMap((d) => d.rejected.map((r) => `${libs.length > 1 ? `${d.name}/` : ""}${r.name} (${r.error})`));
    if (rejected.length) parts.push(`Not imported: ${someNames(rejected)}.`);
    const added = libs.filter((d) => d.added.length);
    if (added.length) parts.push(`Files are in ${added.length === 1 ? added[0].folder : added[0].folder.replace(/[\\/][^\\/]*$/, "")}.`);
    const trouble = rejected.length || libs.some((d) => d.failed || d.wanted_name);
    toast(trouble ? "warn" : "success", parts.join(" "), "Reference Library", !!trouble || added.length > 0);
  } catch (e) {
    toast("error", `Import failed: ${e.message}`);
  }
}

let openPanel = null;

/** Opens (or closes, if already open for this node) the Libraries dropdown under `anchor`. */
export function toggleLibraryPanel(anchor, node, onChange) {
  if (openPanel) {
    const same = openPanel.node === node;
    openPanel.close();
    if (same) return;
  }
  installUiStyle();
  if (!document.getElementById("tpl-style")) {
    document.head.append(Object.assign(document.createElement("style"), { id: "tpl-style", textContent: PANEL_CSS }));
  }
  const panel = h("div", "tpl-panel");
  const list = h("div", "tpl-list");
  const foot = h("div", "tpl-foot");
  const add = h("button", "tpl-new", { type: "button" });
  add.append(icon("plus"), document.createTextNode("New library"));
  add.onclick = () => {
    close();
    openAddDialog({ node, preselectNew: true });
  };
  const imp = h("button", "tpl-new", { type: "button", title: "Add a library from a zip exported on another computer" });
  imp.append(icon("importIn"), document.createTextNode("Import library…"));
  imp.onclick = () => {
    close();
    importLibrary();
  };
  foot.append(add, imp);
  panel.append(list, foot);

  const render = () => {
    const enabled = hooks.enabledSet(node);
    list.replaceChildren();
    if (!library.libraries.length) list.append(h("div", "tpl-empty", { textContent: "No libraries yet. Add files to create one." }));
    for (const lib of library.libraries) {
      const on = !enabled || enabled.has(lib.id);
      const row = h("div", `tpl-row${on ? "" : " tpl-off"}`);
      const sw = h("button", "tpl-switch", { type: "button", title: `${lib.name}: ${on ? "shown in this node. Click to hide." : "hidden in this node. Click to show."}` });
      sw.setAttribute("aria-label", `${lib.name} enabled in this node`);
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(on));
      sw.onclick = () => {
        hooks.setLibEnabled(node, lib.id, !on);
        render();
        onChange?.();
      };
      const ren = h("button", "tpl-icon", { type: "button", title: "Edit library: rename it, manage its assets" });
      ren.append(icon("pencil"));
      ren.onclick = () => {
        close();
        openLibraryManager(lib, { node });
      };
      const exp = h("button", "tpl-icon", { type: "button", title: "Export: save this library (and others you tick) as a zip to share or move to another computer" });
      exp.append(icon("exportOut"));
      exp.onclick = () => {
        close();
        openExportDialog(lib);
      };
      const del = h("button", "tpl-icon", { type: "button", title: "Delete library" });
      del.append(icon("trash"));
      del.onclick = async () => {
        close();
        const ok = await confirmModal(`Delete ${lib.name}?`,
          `This removes the library and its ${lib.count} asset record${lib.count === 1 ? "" : "s"}. Files on disk are not touched. Tags that use it will turn red.`,
          "Delete library");
        if (!ok) return;
        try {
          await pinned(() => library.deleteLibrary(lib.id));
          toast("success", `Deleted ${lib.name}.`);
        } catch (e) {
          toast("error", `Delete failed: ${e.message}`);
        }
      };
      row.append(sw, h("span", "tpl-name", { textContent: lib.name, title: lib.name }),
        h("span", "tpl-count", { textContent: String(lib.count) }), ren, exp, del);
      list.append(row);
    }
  };

  const place = () => {
    const r = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 288))}px`;
    const below = r.bottom + 4;
    panel.style.top = `${below + 320 < window.innerHeight ? below : Math.max(8, r.top - 324)}px`;
  };
  const outside = (e) => {
    if (!panel.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const esc = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation(); // not a ComfyUI shortcut
    close();
  };
  // The panel sits over the canvas but can't follow it: zooming or resizing closes it (panning
  // starts with a pointerdown outside, which already does).
  const away = (e) => {
    if (!panel.contains(e.target)) close();
  };
  const unsub = library.onChange(render);
  function close() {
    panel.remove();
    unsub();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", esc, true);
    document.removeEventListener("wheel", away, true);
    window.removeEventListener("resize", close);
    openPanel = null;
    if (panel.contains(document.activeElement) || document.activeElement === document.body) anchor.focus?.();
  }
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  panel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", esc, true);
  document.addEventListener("wheel", away, { capture: true, passive: true });
  window.addEventListener("resize", close);
  render();
  document.body.append(panel);
  place();
  openPanel = { node, close };
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Libraries in this node");
  panel.querySelector("button")?.focus(); // keyboard users land in the panel
}
