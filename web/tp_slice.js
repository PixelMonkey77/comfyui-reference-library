// Reference Prompt: "Replace with slice". The slicer cuts an area out of a library image into a new
// file in ComfyUI's input folder; here that file gets a Load Image node, plugged into the prompt's
// next free image_N input (a file for this run, never added to the library), and the prompt's tags
// for the library image are rewritten to the slice's own tag.
import { getWidget, mentionRe, splitTag, tagKey, toast } from "./common.js";
import { openSlicer } from "./slicer.js";
import { syncInputs } from "./tp_inputs.js";
import { claimedKeys, EXTRA_RE, resolveFor, syncClaims } from "./tp_model.js";
import { setNodeText } from "./tp_pins.js";
import { refreshStrip } from "./tp_strip.js";

/** Opens the slicer for `asset` (a library image tagged in `node`'s text). */
export function sliceIntoPrompt(node, asset) {
  openSlicer(asset, {
    intro: `The area you select is saved as a new image in ComfyUI's input folder and plugged into this Reference Prompt `
      + `with a Load Image node. Its tag replaces @${asset.name} in the prompt; the library isn't changed.`,
    onSlice: (res) => plugSlice(node, asset, res),
  });
}

/** Tags in `text` that mean `asset` in this node (plain or "@Library/Name"), not a plugged-in file's. */
function rewriteTags(node, text, asset, to) {
  const local = claimedKeys(node);
  let n = 0;
  const out = text.replace(mentionRe(), (all, pre, tok) => {
    if (!splitTag(tok).lib && local.has(tagKey(tok))) return all; // a plugged-in file's tag
    if (resolveFor(node, tok).asset?.id !== asset.id) return all;
    n++;
    return `${pre}@${to}`;
  });
  return { out, n };
}

function plugSlice(node, asset, res) {
  const graph = node.graph;
  const LG = window.LiteGraph;
  if (!graph || !LG?.createNode) throw new Error("The workflow isn't ready; try again.");
  const load = LG.createNode("LoadImage");
  if (!load) throw new Error("Couldn't create a Load Image node.");
  load.title = `Slice of @${asset.name}`;
  // Left of the prompt; each further slice a little lower, so they don't stack exactly.
  const count = (node.properties?.tp_slices ?? 0) % 12;
  const w = load.size?.[0] ?? 315;
  load.pos = [node.pos[0] - w - 60, node.pos[1] + count * 48];
  graph.add(load);

  const widget = getWidget(load, "image");
  if (!widget) {
    graph.remove(load);
    throw new Error("The Load Image node has no image field.");
  }
  // The file is new: put it in the list the node offers, then pick it (the node loads its preview).
  const values = widget.options?.values;
  if (Array.isArray(values) && !values.includes(res.file)) values.push(res.file);
  widget.value = res.file;
  widget.callback?.(res.file);

  // The free image_N input (there is always one at the end of the image inputs).
  syncInputs(node);
  const slot = node.inputs?.findIndex((inp) => EXTRA_RE.exec(inp.name)?.[1] === "image" && inp.link == null) ?? -1;
  if (slot < 0) {
    graph.remove(load);
    throw new Error("This Reference Prompt has no free image input.");
  }
  load.connect(0, node, slot);
  syncInputs(node);
  syncClaims(node); // the slice claims its tag now: its file name, or Name_2 if that's taken

  const srcKey = `${load.id}:0`;
  const claim = Object.values(node.properties?.tp_ext ?? {}).find((c) => c?.src === srcKey);
  const tag = claim?.name ?? res.name;
  const text = getWidget(node, "text")?.value ?? "";
  const { out, n } = rewriteTags(node, text, asset, tag);
  if (out !== text) setNodeText(node, out);
  node.properties ??= {};
  node.properties.tp_slices = (node.properties.tp_slices ?? 0) + 1;
  graph.change?.();
  node.setDirtyCanvas?.(true, true);
  refreshStrip(node);
  toast("success", `Sliced @${asset.name} (${res.width} × ${res.height} px) into @${tag}`
    + `${n ? `: ${n === 1 ? "its tag was" : `${n} tags were`} replaced.` : "."} The slice is ${res.file} in the input folder.`);
}
