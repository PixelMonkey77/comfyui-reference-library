// Reference Image / Video / Audio nodes: Browse… button that fills the path via the server's native
// file dialog, and a note when a typed path points into a folder the library hasn't used yet.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { browseForFile, getWidget, setWidget, stem, tagName, toast } from "./common.js";

const NODES = {
  LibraryImage: { kind: "image", pathWidget: "image_path", title: "Reference Image" },
  LibraryVideo: { kind: "video", pathWidget: "path", title: "Reference Video" },
  LibraryAudio: { kind: "audio", pathWidget: "path", title: "Reference Audio" },
};

const CSS = `
.li-trust{box-sizing:border-box;margin:2px 0;padding:6px 8px;border-radius:6px;font:12px/1.35 system-ui,sans-serif;
  color:var(--input-text,#eee);background:rgba(234,179,8,.14);border:1px solid rgba(234,179,8,.55);
  overflow:auto;white-space:normal;user-select:text}
.li-trust[hidden]{display:none!important}
.li-trust b{color:#facc15}
`;

function installStyle() {
  if (document.getElementById("li-style")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "li-style", textContent: CSS }));
}

const notes = new Map(); // node -> { el, timer, cfg }

/** Points a loader node at a new file; the name/title follow unless the name was customised. */
function applyPath(node, cfg, path) {
  const old = getWidget(node, cfg.pathWidget)?.value ?? "";
  const name = getWidget(node, "name");
  setWidget(node, cfg.pathWidget, path);
  if (name && (!name.value || name.value === stem(old))) setWidget(node, "name", stem(path));
  if (!node.title || node.title === cfg.title || node.title.startsWith("@")) {
    node.title = `@${tagName(name?.value || stem(path)) || stem(path)}`;
  }
  node.setDirtyCanvas?.(true, true);
}

/**
 * Shows or hides the node's note: for safety the loader nodes only read files from folders the user
 * has used (picked a file in with Browse… / + Add, or that hold library files), so a path typed into
 * a new folder would fail at queue time. The note says so before that happens.
 */
function checkTrust(node, delay = 300) {
  const n = notes.get(node);
  if (!n) return;
  clearTimeout(n.timer);
  n.timer = setTimeout(async () => {
    const path = String(getWidget(node, n.cfg.pathWidget)?.value ?? "").trim();
    let trusted = null;
    if (path) {
      try {
        const r = await api.fetchApi(`/library_image/trusted?path=${encodeURIComponent(path)}`);
        if (r.ok) trusted = (await r.json()).trusted; // 403: another machine; nothing to show there
      } catch {
        // offline or the server is restarting: leave the note as it is
        return;
      }
    }
    const show = trusted === false;
    if (n.el.hidden !== !show) {
      n.el.hidden = !show;
      node.setSize?.([node.size[0], Math.max(node.computeSize?.()[1] ?? node.size[1], 0)]);
      node.setDirtyCanvas?.(true, true);
    }
  }, delay);
}

const checkAll = () => {
  for (const node of notes.keys()) {
    if (node.graph) checkTrust(node, 0);
    else notes.delete(node);
  }
};

function noteElement() {
  const el = document.createElement("div");
  el.className = "li-trust";
  el.hidden = true;
  const b = document.createElement("b");
  b.textContent = "⚠ New folder. ";
  el.append(b, document.createTextNode(
    "For safety, Reference Image/Video/Audio nodes only read files from folders you've already used: ones you picked a file in "
    + "with Browse… (or + Add in a Reference Prompt), or that hold library files. Click Browse… and pick this file "
    + "once; after that, paths in this folder work, typed ones too."));
  return el;
}

app.registerExtension({
  name: "LibraryImage.Node",

  setup() {
    installStyle();
    // A pick in any node (or + Add) can trust a folder that other nodes point into.
    window.addEventListener("focus", checkAll);
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const cfg = NODES[nodeData.name];
    if (!cfg) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      installStyle();
      const w = this.addWidget("button", "Browse…", null, async () => {
        const current = getWidget(this, cfg.pathWidget)?.value ?? "";
        const p = await browseForFile(current, cfg.kind).catch((e) => (toast("warn", e.message), null));
        if (p) applyPath(this, cfg, p);
        checkAll(); // the picked file's folder is trusted now, for every node pointing into it
      });
      w.serialize = false;
      w.options = { ...(w.options ?? {}), serialize: false };

      const el = noteElement();
      const nw = this.addDOMWidget("trust_note", "trust_note", el, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => (el.hidden ? 0 : 76),
        getMaxHeight: () => (el.hidden ? 0 : 140),
      });
      nw.serialize = false;
      notes.set(this, { el, timer: null, cfg });

      // Re-check whenever the path changes (typed, pasted, or set by Browse…).
      const pw = getWidget(this, cfg.pathWidget);
      if (pw) {
        const cb = pw.callback;
        pw.callback = (...args) => {
          const res = cb?.apply(pw, args);
          checkTrust(this);
          return res;
        };
      }
      // A loaded workflow sets the path after creation.
      setTimeout(() => checkTrust(this, 0), 0);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      clearTimeout(notes.get(this)?.timer);
      notes.delete(this);
      return onRemoved?.apply(this, arguments);
    };
  },
});
