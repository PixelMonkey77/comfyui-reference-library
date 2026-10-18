// Reference Prompt: stylesheet and the asset thumbnail used by the popup and the strip.
import { assetKind, formatDuration, library } from "./common.js";
import { h } from "./ui.js";

export const CSS = `
.tp-popup{position:fixed;z-index:100000;width:380px;max-width:calc(100vw - 16px);max-height:min(420px,calc(100vh - 16px));
  display:flex;flex-direction:column;background:var(--comfy-menu-bg,#202124);color:var(--input-text,#eee);
  border:1px solid var(--border-color,#555);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.4);
  font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
.tp-popup[hidden]{display:none}
.tp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;
  border-bottom:1px solid color-mix(in srgb,var(--border-color,#555) 60%,transparent)}
.tp-title{font-weight:600}
.tp-btn{border:1px solid var(--border-color,#666);background:var(--comfy-input-bg,#353535);color:inherit;
  border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit;font-size:12px}
.tp-btn:hover{filter:brightness(1.15)}
.tp-list{overflow:auto;overscroll-behavior:contain;padding:4px}
.tp-item{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:9px;padding:4px 6px;
  border-radius:7px;cursor:pointer}
.tp-item[aria-selected="true"]{background:var(--comfy-input-bg,#353535);outline:1px solid var(--border-color,#666)}
.tp-thumb{width:44px;height:44px;object-fit:cover;border-radius:5px;background:#111;border:1px solid rgba(255,255,255,.1)}
.tp-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-sub{font-size:11px;color:var(--descrip-text,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.tp-missing .tp-sub{color:#e57373;direction:ltr}
.tp-runonly{margin-left:6px;padding:0 5px;border:1px dashed var(--muted-foreground,#8a8a8a);border-radius:4px;
  font-size:10px;font-weight:400;color:var(--muted-foreground,#8a8a8a)}
.tp-item-extra .tp-thumb{border-style:dashed}
.tp-thumb.tp-ph{display:grid;place-items:center;color:var(--muted-foreground,#8a8a8a)}
.tp-thumb.tp-ph svg{width:18px;height:18px}
.tp-acts{display:flex;gap:2px;visibility:hidden}
.tp-item:hover .tp-acts,.tp-item[aria-selected="true"] .tp-acts{visibility:visible}
.tp-act{border:0;background:transparent;color:var(--descrip-text,#aaa);cursor:pointer;padding:2px 5px;border-radius:4px;font-size:13px}
.tp-act:hover{background:rgba(255,255,255,.1);color:var(--input-text,#fff)}
.tp-empty{padding:14px 10px;color:var(--descrip-text,#999)}
.tp-foot{padding:5px 10px;font-size:11px;color:var(--descrip-text,#888);
  border-top:1px solid color-mix(in srgb,var(--border-color,#555) 60%,transparent)}
.tp-strip{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;padding:4px 2px;box-sizing:border-box;
  overflow:auto;font:11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--input-text,#ddd)}
.tp-chip{width:64px;display:flex;flex-direction:column;align-items:center;gap:2px}
.tp-chip img,.tp-chip .tp-ph{width:56px;height:56px;object-fit:cover;border-radius:6px;background:#111;
  border:1px solid rgba(255,255,255,.12)}
.tp-chip .tp-ph{display:grid;place-items:center;font-size:20px;color:#e57373}
.tp-chip .tp-cthumb{width:56px;height:56px;object-fit:cover;border-radius:6px;background:#111;border:1px solid rgba(255,255,255,.12);box-sizing:border-box}
.tp-chip:hover .tp-cthumb{outline:2px solid var(--tp-tag-hl);outline-offset:1px}
.tp-chip .tp-ph.tp-cthumb{color:var(--muted-foreground,#8a8a8a)}
.tp-chip .tp-ph.tp-cthumb svg{width:22px;height:22px}
.tp-extra .tp-cthumb{border-style:dashed;border-color:var(--muted-foreground,#8a8a8a)}
.tp-firstlast{width:60px;margin-top:2px;border:1px solid var(--border-color,#666);border-radius:5px;
  background:var(--secondary-background,#262729);color:var(--base-foreground,#fff);font:600 11px/20px Inter,system-ui,sans-serif;
  padding:0;cursor:pointer;white-space:nowrap}
.tp-firstlast:hover{border-color:var(--base-foreground,#fff);background:var(--secondary-background-hover,#333)}
/* With a First/Last button in the strip, the other chips keep their "image n" on the same line. */
.tp-strip:has(.tp-firstlast) .tp-chip:not(.tp-extra) .tp-idx{margin-top:26px}
.tp-chip .tp-idx{font-size:10px;color:var(--descrip-text,#999)}
.tp-chip.tp-bad .tp-idx{color:#e57373}
.tp-add{width:56px;height:56px;border:1px dashed var(--border-color,#666);border-radius:6px;background:transparent;
  color:var(--descrip-text,#aaa);cursor:pointer;font-size:22px}
.tp-add:hover{color:var(--input-text,#fff);border-color:var(--input-text,#aaa)}
.tp-hint{align-self:center;color:var(--descrip-text,#888)}
:root{--tp-tag-ok:#4da3ff;--tp-tag-ok-bg:rgba(77,163,255,.16);--tp-tag-bad:#ff6b6b;--tp-tag-bad-bg:rgba(255,107,107,.16);
  --tp-tag-hl:#ffd400;--tp-tag-hl-bg:rgba(255,212,0,.22);
  --tp-tag-missing:#c084fc;--tp-tag-missing-bg:rgba(192,132,252,.18);--tp-tag-off:var(--muted-foreground,#8a8a8a)}
.tp-chip{cursor:pointer;border-radius:6px}
.tp-chip:hover img,.tp-chip:hover .tp-ph{outline:2px solid var(--tp-tag-hl);outline-offset:1px}
.tp-ink.tp-ink-hl{color:var(--tp-tag-hl);background:var(--tp-tag-hl-bg)}
@keyframes tp-ping{0%{box-shadow:0 0 0 0 rgba(255,212,0,.95)}100%{box-shadow:0 0 0 9px rgba(255,212,0,0)}}
.tp-ink.tp-ink-ping{color:var(--tp-tag-hl);background:var(--tp-tag-hl-bg);animation:tp-ping .55s ease-out 3}
.tp-ink-back{position:absolute;overflow:hidden;pointer-events:none;margin:0;z-index:0;border-style:solid;border-color:transparent}
.tp-ink-ta{color:transparent!important;-webkit-text-fill-color:transparent!important;background:transparent!important;position:relative;z-index:1}
.tp-ink{border-radius:3px}
.tp-ink-ok{color:var(--tp-tag-ok);background:var(--tp-tag-ok-bg)}
.tp-ink-bad{color:var(--tp-tag-bad);background:var(--tp-tag-bad-bg)}
.tp-ink-missing{color:var(--tp-tag-missing);background:var(--tp-tag-missing-bg)}
.tp-ink-off{color:var(--tp-tag-off);text-decoration:line-through}
.tp-libtag{margin-left:6px;padding:0 5px;border-radius:4px;font-size:10px;font-weight:400;
  background:var(--secondary-background,#262729);color:var(--muted-foreground,#8a8a8a)}
.tp-chip.tp-missing .tp-idx{color:var(--tp-tag-missing)}
.tp-chip.tp-off{opacity:.55}
.tp-hover.tp-hmissing .tp-hname{color:var(--tp-tag-missing)}
.tp-hover.tp-hoff .tp-hname{color:var(--tp-tag-off);text-decoration:line-through}
.tp-hover.tp-pinned{pointer-events:auto}
.tp-hover .tp-hact{margin-top:4px;display:flex;gap:6px}
.tp-hover .tp-hact button{border:1px solid var(--secondary-background,#262729);background:var(--base-foreground,#fff);
  color:var(--base-background,#171718);border-radius:6px;padding:4px 10px;cursor:pointer;font:500 12px Inter,system-ui,sans-serif}
.tp-hover{position:fixed;z-index:100001;pointer-events:none;display:flex;flex-direction:column;gap:4px;max-width:220px;padding:6px;
  background:var(--comfy-menu-bg,#202124);color:var(--input-text,#eee);border:1px solid var(--border-color,#555);border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,.4);font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}
.tp-hover[hidden]{display:none}
.tp-hover img{width:200px;max-height:200px;object-fit:contain;border-radius:5px;background:#111}
.tp-hover .tp-hname{font-weight:600}
.tp-hover .tp-hsub{color:var(--descrip-text,#999);font-size:11px;word-break:break-all}
.tp-hover.tp-hbad .tp-hname{color:var(--tp-tag-bad)}
.tp-hover .tp-htitle{display:flex;align-items:center;gap:6px}
.tp-hover .tp-htitle svg{width:14px;height:14px;flex:none}
.tp-hover .tp-hslot{color:var(--input-text,#ddd);font-family:ui-monospace,Consolas,monospace}
.tp-hover video{width:200px;max-height:200px;border-radius:5px;background:#111}
.tp-media{position:relative;flex:none}
.tp-media .tp-badge{position:absolute;left:2px;bottom:2px;padding:0 4px;border-radius:4px;background:rgba(0,0,0,.72);
  color:#fff;font-size:9px;line-height:14px;pointer-events:none;white-space:nowrap}
.tp-audio{display:grid;place-items:center;background:linear-gradient(135deg,#2a3550,#1b2133)!important;color:#9fb6ff;font-size:20px}
/* Header: same look as the filter buttons in ComfyUI's node search dialog. It never stretches,
   and stays inside the node (shrinks/clips rather than overflowing). */
.tp-header{display:flex;align-items:center;gap:6px;height:30px;flex:none!important;min-width:0;max-width:100%;
  overflow:hidden;box-sizing:border-box}
.tp-hbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:34px;height:28px;padding:0;
  box-sizing:border-box;border-radius:6px;border:1px solid var(--secondary-background,#262729);background:transparent;
  color:var(--muted-foreground,#8a8a8a);cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.tp-hbtn:hover{border-color:color-mix(in srgb,var(--base-foreground,#fff) 60%,transparent);
  color:color-mix(in srgb,var(--base-foreground,#fff) 60%,transparent)}
.tp-hbtn[aria-pressed="true"]{background:var(--base-foreground,#fff);border-color:var(--base-foreground,#fff);
  color:var(--base-background,#171718)}
.tp-hbtn svg{width:16px;height:16px;pointer-events:none}
.tp-hbtn.tp-libs{width:auto;gap:4px;padding:0 6px 0 8px;font:500 12px Inter,system-ui,sans-serif;white-space:nowrap;min-width:0;flex:0 1 auto;overflow:hidden}
.tp-hbtn.tp-libs svg:last-child{width:14px;height:14px}
.tp-libs-label{overflow:hidden;text-overflow:ellipsis}
.tp-header .tp-spacer{flex:1 1 0;min-width:0}
/* Nodes 2.0 lays widgets out as grid rows and shares spare height between all of them; give it all
   to the text row so the header keeps its place and the text box grows from its top-left corner. */
.lg-node-widgets:has(.tp-header){grid-template-rows:auto minmax(64px,1fr) auto!important}
.lg-node-widgets:has(.tp-header) .tp-strip{max-height:200px}
`;

export function installStyle() {
  if (document.getElementById("tp-style")) return;
  const s = document.createElement("style");
  s.id = "tp-style";
  s.textContent = CSS;
  document.head.append(s);
}

/** Square preview for an asset: thumbnail (image/video frame) or an audio placeholder, with a type badge. */
export function mediaThumb(asset, size, cls) {
  const kind = assetKind(asset);
  const box = h("div", "tp-media");
  const url = library.thumbUrl(asset, size * 2);
  let vis;
  if (url) {
    vis = h("img", cls, { alt: "", src: url, loading: cls === "tp-thumb" ? "lazy" : "eager" });
    vis.onerror = () => (vis.style.visibility = "hidden");
  } else {
    vis = h("div", `${cls} tp-audio`, { textContent: "♪" });
  }
  box.append(vis);
  if (kind !== "image") {
    const dur = formatDuration(asset.duration);
    box.append(h("span", "tp-badge", { textContent: `${kind === "video" ? "▶" : "♪"}${dur ? " " + dur : ""}` }));
  }
  return box;
}
