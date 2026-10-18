// Reference Prompt: keeping tags on their files across library changes.
import { getWidget, library, mentionRe, splitTag, tagKey } from "./common.js";
import { editorOf } from "./tp_ink.js";
import {
  allPromptNodes, claimedKeys, enabledLibs, libToken, outputAsset, outputAssetName, renameOutput,
} from "./tp_model.js";
import { planFor } from "./tp_plan.js";
import { scheduleStrip } from "./tp_strip.js";

export function setNodeText(node, text) {
  const w = getWidget(node, "text");
  if (w) w.value = text;
  const ta = editorOf(node);
  if (ta && ta.value !== text) {
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  node.graph?.change?.();
  scheduleStrip(node);
}

/**
 * Records which file every tag (and "@name" output) in the open workflow points at, before a
 * library change (add, rename, replace, library rename).
 */
export function snapshotTags() {
  const pin = (tok, libs) => {
    const a = library.resolve(tok, libs).asset;
    return a ? { id: a.id, lib: library.libName(a.library), name: a.name } : null;
  };
  return allPromptNodes().map((node) => {
    const libs = enabledLibs(node);
    const text = getWidget(node, "text")?.value ?? "";
    // Tags claimed by a plugged-in or hand-wired file (even unplugged) aren't library tags: leave them alone.
    const local = new Set(planFor(node, text).rows.filter((r) => r.claim).map((r) => tagKey(r.tok)));
    const spans = [...text.matchAll(mentionRe())]
      .filter((m) => !local.has(tagKey(m[2])))
      .map((m) => ({ start: m.index + m[1].length, end: m.index + m[0].length, tok: m[2], ...pin(m[2], libs) }))
      .filter((sp) => sp.id);
    const outs = (node.outputs ?? [])
      .filter((o) => outputAssetName(o) != null)
      .map((o) => {
        const a = outputAsset(node, o)?.asset;
        return { o, ...(a ? { id: a.id, lib: library.libName(a.library), name: a.name } : {}) };
      })
      .filter((x) => x.id);
    return { node, text, spans, outs };
  });
}

/**
 * The tag a snapshot entry should have now: unchanged if it still reaches its file; the shortest
 * tag for that file if it moved (renamed, or another library now answers the plain name); for a
 * removed file, its old qualified name, so it shows red instead of quietly using another
 * library's file of the same name. Null = leave as is.
 */
function pinnedToken(node, entry, tok, libs, local) {
  const asset = library.byId(entry.id);
  // A plain name a plugged-in file answers no longer reaches the library: qualify it.
  const now = !splitTag(tok).lib && local.has(tagKey(tok)) ? {} : library.resolve(tok, libs);
  if (asset) return now.asset?.id === asset.id ? null : libToken(node, asset, libs, local);
  return now.status === "unknown" ? null : `${entry.lib}/${entry.name}`;
}

/**
 * After the change, re-points every tag whose target moved back at its original file, using the
 * shortest tag that reaches it. This follows renames ("@Capy" -> "@Capybara") and stops a new or
 * renamed asset in an earlier library from taking over existing tags ("@Biscuit" -> "@Lib_02/Biscuit").
 * Tags of removed files are left alone (they turn red). Returns how many text tags changed.
 */
export function restoreTags(snap) {
  let n = 0;
  for (const c of snap ?? []) {
    const libs = enabledLibs(c.node);
    const local = claimedKeys(c.node);
    const text = getWidget(c.node, "text")?.value ?? "";
    if (text === c.text) { // skip if the text was edited meanwhile
      let next = text;
      for (const sp of [...c.spans].reverse()) {
        const tok = pinnedToken(c.node, sp, sp.tok, libs, local);
        if (tok == null) continue;
        next = `${next.slice(0, sp.start)}@${tok}${next.slice(sp.end)}`;
        n++;
      }
      if (next !== text) setNodeText(c.node, next);
    }
    let outs = 0;
    for (const entry of c.outs) {
      const tok = pinnedToken(c.node, entry, outputAssetName(entry.o), libs, local);
      if (tok == null) continue;
      renameOutput(c.node, entry.o, `@${tok}`);
      outs++;
    }
    if (outs) c.node.setDirtyCanvas?.(true, true);
  }
  return n;
}

/** Runs a library change with every tag kept on its file; strips update once, at the end. */
export async function pinnedChange(change) {
  library.hold();
  try {
    const snap = snapshotTags();
    const result = await change();
    restoreTags(snap);
    return result;
  } finally {
    library.release();
  }
}
