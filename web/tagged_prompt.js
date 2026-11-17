// Reference Prompt node: registration. The node has an @tag autocomplete over the asset libraries
// (tp_popup), colored tags (tp_ink), a header and a strip of the tagged files (tp_strip), cards
// (tp_hover), and a queue-time hook that wires the files into the target's auto-grow ports and
// rewrites @tags to "image N" / "Video N" / "Audio N" (tp_bind, with placement from tp_plan).
import { app } from "../../scripts/app.js";
import { library, toast } from "./common.js";
import { environmentProblems, wrapGraphToPrompt } from "./compat.js";
import { setHooks } from "./dialogs.js";
import { bindPrompt, usesReferencePrompt } from "./tp_bind.js";
import { installInkListeners } from "./tp_hover.js";
import { inks } from "./tp_ink.js";
import { syncInputs } from "./tp_inputs.js";
import { enabledLibs, isTpType, syncClaims } from "./tp_model.js";
import { restoreTags, snapshotTags } from "./tp_pins.js";
import { installEditorListeners, popup } from "./tp_popup.js";
import {
  buildHeader, headers, refreshAllStrips, refreshStrip, scheduleStrip, setLibEnabled, strips, stripTimers,
} from "./tp_strip.js";
import { installStyle } from "./tp_style.js";
import { h } from "./ui.js";

const QUEUE_MAX_AGE = 2000; // ms: how old the library copy used for queueing may be

// Says, once per problem and until closed, why the Reference Prompt can't work in this ComfyUI (Nodes 2.0
// off, an older or unknown frontend). Only where a Reference Prompt is in use; said again if a problem
// that went away (Nodes 2.0 switched back on) returns.
const warned = new Set();
function warnEnvironment() {
  const problems = environmentProblems();
  for (const msg of [...warned]) if (!problems.includes(msg)) warned.delete(msg);
  for (const msg of problems) {
    if (warned.has(msg)) continue;
    warned.add(msg);
    toast("warn", msg, "Reference Library", true);
  }
}

app.registerExtension({
  name: "LibraryImage.TaggedPrompt",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!isTpType(nodeData.name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      installStyle();

      // Header (Libraries, + Add) goes first, above the text box.
      const hw = this.addDOMWidget("tagged_header", "tagged_header", buildHeader(this), {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 30,
        getMaxHeight: () => 30,
      });
      hw.serialize = false;
      this.widgets.splice(this.widgets.indexOf(hw), 1);
      this.widgets.unshift(hw);

      const el = h("div", "tp-strip");
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      const w = this.addDOMWidget("tagged_images", "tagged_images", el, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 92,
        getMaxHeight: () => 200,
      });
      w.serialize = false;
      strips.set(this, { el, sig: null });
      // One free image_1 / video_1 / audio_1 input for non-library files. Deferred: when a workflow
      // loads, configure() restores the saved inputs and links right after creation, and inputs
      // added before that would shift the saved link slots.
      setTimeout(() => {
        this._tpReady = true; // configure() (loading, undo) is over: connection changes are the user's now
        syncInputs(this);
      }, 0);
      this.setSize([Math.max(this.size[0], 420), Math.max(this.size[1], 330)]);
      library.load().then(() => refreshStrip(this));
      setTimeout(warnEnvironment, 500); // after a loading workflow's nodes are all there: one notice, not one per node
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => refreshStrip(this), 0);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      strips.delete(this);
      headers.delete(this);
      inks.get(this)?.ro.disconnect();
      inks.delete(this);
      clearTimeout(stripTimers.get(this));
      stripTimers.delete(this);
      if (popup.state?.node === this) popup.hide();
      return onRemoved?.apply(this, arguments);
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      // Re-sort the extra inputs within the same event as the user's change (a microtask runs before
      // ComfyUI's change tracker sees the mouseup), so one connection is one undo step. Never while
      // a workflow is being configured: its saved links are still being restored.
      if (this._tpReady && !this._tpSyncQueued) {
        this._tpSyncQueued = true;
        queueMicrotask(() => {
          this._tpSyncQueued = false;
          syncInputs(this);
          syncClaims(this); // a newly plugged file claims its name in the same step
        });
      }
      scheduleStrip(this);
      return r;
    };
  },

  setup() {
    installStyle();
    installEditorListeners();
    installInkListeners();
    setHooks({ enabledSet: (node) => (node ? enabledLibs(node) : null), setLibEnabled, snapshot: snapshotTags, restore: restoreTags });
    library.onChange(refreshAllStrips);
    library.load();
    // Files can be deleted or moved outside ComfyUI: re-check when the window regains focus.
    window.addEventListener("focus", () => library.load(true, 1500));
    // Wiring on the target node changes the predicted numbers; cheap local check, no network.
    // Nothing to show while the window is hidden; catch up as soon as it is visible again.
    setInterval(() => document.hidden || refreshAllStrips(), 1500);
    document.addEventListener("visibilitychange", () => document.hidden || refreshAllStrips());

    wrapGraphToPrompt(async (output) => {
      // Workflows without a Reference Prompt are none of this pack's business: no wait, no changes.
      if (!usesReferencePrompt(output)) return [];
      warnEnvironment();
      // Catch files deleted or moved since the page loaded; a copy from the last moment will do
      // (queueing a batch shouldn't re-check the disk for every item).
      await library.load(true, QUEUE_MAX_AGE);
      let errors;
      try {
        errors = bindPrompt(output);
      } catch (e) {
        console.error("[TaggedPrompt] binding failed", e);
        errors = [`Tag binding failed: ${e.message}`];
      }
      for (const msg of errors) toast("error", msg, "Reference prompt");
      return errors;
    });
  },
});
