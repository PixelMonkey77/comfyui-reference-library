// Image slicer: shows a library image large, with zoom and pan, and lets the user mark a rectangle
// (or a square) to cut out. The cut itself is done by the server, from the full-size file
// (/library_image/slice), into a new PNG in ComfyUI's input folder; what happens with it next is the
// caller's (tp_slice.js plugs it into a Reference Prompt). The library file is never changed.
import { library, postJson } from "./common.js";
import { h, icon, installUiStyle, modal } from "./ui.js";

const CSS = `
.tpm.tsl{width:min(1180px,calc(100vw - 32px));height:min(860px,calc(100vh - 48px))}
.tsl .tpm-body{flex:1;min-height:0;overflow:hidden}
.tsl-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tsl-bar .tpm-btn{height:30px;padding:0 9px}
.tsl-bar .tsl-ib{width:30px;padding:0;justify-content:center}
.tsl-zoom{min-width:58px;justify-content:center;font-variant-numeric:tabular-nums}
.tsl-sep{width:1px;height:20px;background:var(--secondary-background,#262729);margin:0 4px}
.tsl-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none}
.tsl-check input{accent-color:var(--base-foreground,#fff);margin:0}
.tsl-size{margin-left:auto;font-size:12px;color:var(--muted-foreground,#8a8a8a);font-variant-numeric:tabular-nums}
.tsl-size b{color:var(--input-text,#eee);font-weight:600}
.tsl-stage{position:relative;flex:1;min-height:0;overflow:hidden;border-radius:8px;cursor:crosshair;touch-action:none;
  border:1px solid var(--secondary-background,#262729);
  background:#141414 repeating-conic-gradient(#1b1b1b 0 25%,#141414 0 50%) 0 0/20px 20px}
.tsl-stage.tsl-panning,.tsl-stage.tsl-pan-ready{cursor:grab}
.tsl-stage.tsl-panning{cursor:grabbing}
.tsl-img{position:absolute;left:0;top:0;transform-origin:0 0;user-select:none;pointer-events:none;max-width:none;
  image-rendering:auto}
.tsl-img.tsl-pixels{image-rendering:pixelated}
.tsl-sel{position:absolute;box-sizing:border-box;border:1px dashed #fff;outline:1px dashed #000;outline-offset:-2px;
  box-shadow:0 0 0 100000px rgba(0,0,0,.55);cursor:move}
.tsl-sel[hidden]{display:none}
.tsl-h{position:absolute;width:10px;height:10px;margin:-6px 0 0 -6px;background:#fff;border:1px solid #000;border-radius:2px}
.tsl-h[data-d="nw"],.tsl-h[data-d="se"]{cursor:nwse-resize}
.tsl-h[data-d="ne"],.tsl-h[data-d="sw"]{cursor:nesw-resize}
.tsl-h[data-d="n"],.tsl-h[data-d="s"]{cursor:ns-resize}
.tsl-h[data-d="e"],.tsl-h[data-d="w"]{cursor:ew-resize}
.tsl-msg{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted-foreground,#8a8a8a);font-size:13px;pointer-events:none}
.tsl-foot{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.tsl-foot .tpm-note{flex:1;min-width:200px}
`;

function installStyle() {
  installUiStyle();
  if (document.getElementById("tsl-style")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "tsl-style", textContent: CSS }));
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_SCALE = 0.02, MAX_SCALE = 32;

/**
 * Opens the slicer for an image asset. `onSlice(result)` gets the server's answer
 * ({ file, name, width, height }) and may be async; the dialog stays open (busy) until it is done,
 * and shows its error if it throws. `actionLabel`: the confirm button's text.
 */
export function openSlicer(asset, { onSlice, actionLabel = "Replace with slice", intro = "" } = {}) {
  installStyle();
  let nw = 0, nh = 0; // the shown picture's size in its own pixels
  let realW = 0, realH = 0; // the file's size (the preview may be a smaller stand-in)
  let scale = 1, tx = 0, ty = 0; // view: image pixel (x, y) is at stage (tx + x*scale, ty + y*scale)
  let sel = null; // { x, y, w, h } in image pixels
  let fitted = false;
  let spaceDown = false;
  let drag = null;

  // ---- toolbar
  const btn = (cls, iconName, title, onclick, text) => {
    const b = h("button", `tpm-btn ${cls}`, { type: "button", title });
    if (iconName) b.append(icon(iconName));
    if (text != null) b.append(document.createTextNode(text));
    b.setAttribute("aria-label", title);
    b.onclick = onclick;
    return b;
  };
  const zoomLabel = h("span", "", { textContent: "100%" });
  const zoomOut = btn("tsl-ib", "zoomOut", "Zoom out (−)", () => zoomBy(1 / 1.25));
  const zoomBtn = btn("tsl-zoom", null, "Fit to window (0)", () => fit());
  zoomBtn.append(zoomLabel);
  const zoomIn = btn("tsl-ib", "zoomIn", "Zoom in (+)", () => zoomBy(1.25));
  const fitBtn = btn("", "fit", "Fit to window (0)", () => fit(), "Fit");
  const oneBtn = btn("", null, "Actual pixels (1)", () => actual(), "1:1");
  const squareBox = h("input", "", { type: "checkbox" });
  const square = h("label", "tsl-check", { title: "Keep the selection square (or hold Shift while dragging)" });
  square.append(squareBox, document.createTextNode("Square"));
  squareBox.onchange = () => {
    if (squareBox.checked && sel) {
      const s = Math.min(sel.w, sel.h);
      sel = clampRect({ x: sel.x + (sel.w - s) / 2, y: sel.y + (sel.h - s) / 2, w: s, h: s });
      layout();
    }
  };
  const allBtn = btn("", null, "Select the whole image (A)", () => { sel = { x: 0, y: 0, w: nw, h: nh }; if (squareBox.checked) squareBox.onchange(); layout(); }, "Select all");
  const clearBtn = btn("", null, "Clear the selection (Delete)", () => { sel = null; layout(); }, "Clear");
  const sizeOut = h("span", "tsl-size");
  const bar = h("div", "tsl-bar");
  bar.append(zoomOut, zoomBtn, zoomIn, fitBtn, oneBtn, h("span", "tsl-sep"), square, allBtn, clearBtn, sizeOut);

  // ---- stage
  const stage = h("div", "tsl-stage");
  stage.setAttribute("aria-label", "Image: drag to select an area");
  const img = h("img", "tsl-img", { alt: asset.name, draggable: false, decoding: "async" });
  const box = h("div", "tsl-sel", { hidden: true });
  const handles = HANDLES.map((d) => {
    const el = h("div", "tsl-h");
    el.dataset.d = d;
    box.append(el);
    return el;
  });
  const msg = h("div", "tsl-msg", { textContent: "Loading…" });
  stage.append(img, box, msg);

  const err = h("div", "tpm-error");
  const note = h("div", "tpm-note", {
    textContent: "Drag to select · drag inside to move · handles resize · Shift: square · wheel or pinch: zoom · "
      + "Space+drag or middle button: pan · arrows nudge.",
  });
  const foot = h("div", "tsl-foot");
  foot.append(note);
  const content = [bar, stage, err, foot];
  if (intro) content.unshift(h("div", "tpm-note", { textContent: intro }));

  // ---- geometry
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const clampRect = (r) => {
    const w = clamp(r.w, 0, nw), hgt = clamp(r.h, 0, nh);
    return { x: clamp(r.x, 0, nw - w), y: clamp(r.y, 0, nh - hgt), w, h: hgt };
  };
  const toImage = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left - tx) / scale, y: (e.clientY - r.top - ty) / scale };
  };
  const ratio = () => (realW && nw ? realW / nw : 1); // file pixels per shown pixel
  const pixelSize = (r) => ({ w: Math.max(0, Math.round(r.w * ratio())), h: Math.max(0, Math.round(r.h * (realH && nh ? realH / nh : 1))) });
  const valid = () => !!sel && pixelSize(sel).w >= 2 && pixelSize(sel).h >= 2;

  /** Rectangle from a fixed corner (ax, ay) to a point (px, py), kept inside the image; square if asked. */
  function fromCorner(ax, ay, px, py, sq) {
    px = clamp(px, 0, nw);
    py = clamp(py, 0, nh);
    let w = px - ax, hh = py - ay;
    if (sq) {
      const sx = w < 0 ? -1 : 1, sy = hh < 0 ? -1 : 1;
      let s = Math.max(Math.abs(w), Math.abs(hh));
      s = Math.min(s, sx > 0 ? nw - ax : ax, sy > 0 ? nh - ay : ay);
      w = sx * s;
      hh = sy * s;
    }
    return { x: Math.min(ax, ax + w), y: Math.min(ay, ay + hh), w: Math.abs(w), h: Math.abs(hh) };
  }

  /** Resizes `r0` by dragging handle `d` to image point p. */
  function resize(r0, d, p, sq) {
    const x2 = r0.x + r0.w, y2 = r0.y + r0.h;
    if (d.length === 2) {
      // Corner: the opposite corner stays.
      const ax = d.includes("w") ? x2 : r0.x, ay = d.includes("n") ? y2 : r0.y;
      return fromCorner(ax, ay, p.x, p.y, sq);
    }
    let r;
    if (d === "e" || d === "w") {
      const ax = d === "w" ? x2 : r0.x;
      const px = clamp(p.x, 0, nw);
      r = { x: Math.min(ax, px), y: r0.y, w: Math.abs(px - ax), h: r0.h };
      if (sq) {
        const cy = r0.y + r0.h / 2;
        const s = Math.min(r.w, 2 * cy, 2 * (nh - cy)); // grows both ways from the middle, inside the image
        r = { x: px >= ax ? ax : ax - s, y: cy - s / 2, w: s, h: s };
      }
    } else {
      const ay = d === "n" ? y2 : r0.y;
      const py = clamp(p.y, 0, nh);
      r = { x: r0.x, y: Math.min(ay, py), w: r0.w, h: Math.abs(py - ay) };
      if (sq) {
        const cx = r0.x + r0.w / 2;
        const s = Math.min(r.h, 2 * cx, 2 * (nw - cx));
        r = { x: cx - s / 2, y: py >= ay ? ay : ay - s, w: s, h: s };
      }
    }
    return r;
  }

  // ---- view
  function layout() {
    if (!nw) return;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.classList.toggle("tsl-pixels", scale >= 4);
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    if (sel && sel.w > 0 && sel.h > 0) {
      box.hidden = false;
      Object.assign(box.style, { left: `${tx + sel.x * scale}px`, top: `${ty + sel.y * scale}px`,
        width: `${sel.w * scale}px`, height: `${sel.h * scale}px` });
      const W = sel.w * scale, H = sel.h * scale;
      const pos = { nw: [0, 0], n: [W / 2, 0], ne: [W, 0], e: [W, H / 2], se: [W, H], s: [W / 2, H], sw: [0, H], w: [0, H / 2] };
      handles.forEach((el) => {
        const [x, y] = pos[el.dataset.d];
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.hidden = (W < 24 || H < 24) && el.dataset.d.length === 1; // tiny boxes: corners only
      });
    } else box.hidden = true;
    const px = sel ? pixelSize(sel) : null;
    sizeOut.replaceChildren();
    if (px && px.w && px.h) sizeOut.append("Selection ", h("b", "", { textContent: `${px.w} × ${px.h}` }), " px");
    else sizeOut.append(`Image ${realW || nw} × ${realH || nh} px`);
    const go = ctl.button(actionLabel);
    if (go) go.disabled = busy || !valid();
    clearBtn.disabled = !sel;
  }

  /** Keeps at least part of the image on screen. */
  function clampView() {
    const r = stage.getBoundingClientRect();
    const iw = nw * scale, ih = nh * scale, keep = 48;
    tx = clamp(tx, keep - iw, r.width - keep);
    ty = clamp(ty, keep - ih, r.height - keep);
  }

  function setScale(s, cx, cy) {
    const r = stage.getBoundingClientRect();
    cx ??= r.width / 2;
    cy ??= r.height / 2;
    s = clamp(s, MIN_SCALE, MAX_SCALE);
    // The image point under (cx, cy) stays there.
    tx = cx - ((cx - tx) / scale) * s;
    ty = cy - ((cy - ty) / scale) * s;
    scale = s;
    clampView();
    layout();
  }
  const zoomBy = (f, cx, cy) => setScale(scale * f, cx, cy);

  function fit() {
    const r = stage.getBoundingClientRect();
    if (!nw || !r.width) return;
    scale = Math.min((r.width - 24) / nw, (r.height - 24) / nh, 8);
    tx = (r.width - nw * scale) / 2;
    ty = (r.height - nh * scale) / 2;
    layout();
  }
  function actual() {
    const r = stage.getBoundingClientRect();
    const c = sel ? { x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 } : { x: nw / 2, y: nh / 2 };
    scale = 1 / ratio(); // one file pixel per screen pixel
    tx = r.width / 2 - c.x * scale;
    ty = r.height / 2 - c.y * scale;
    clampView();
    layout();
  }

  // ---- pointer
  stage.addEventListener("pointerdown", (e) => {
    if (!nw || busy) return;
    const p = toImage(e);
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, tx, ty };
      stage.classList.add("tsl-panning");
    } else if (e.button !== 0) return;
    else if (e.target.classList.contains("tsl-h")) drag = { mode: "resize", d: e.target.dataset.d, r0: { ...sel } };
    else if (e.target === box) drag = { mode: "move", p0: p, r0: { ...sel } };
    else {
      const a = { x: clamp(p.x, 0, nw), y: clamp(p.y, 0, nh) };
      drag = { mode: "draw", a, moved: false };
    }
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toImage(e);
    const sq = squareBox.checked || e.shiftKey;
    if (drag.mode === "pan") {
      tx = drag.tx + e.clientX - drag.sx;
      ty = drag.ty + e.clientY - drag.sy;
      clampView();
    } else if (drag.mode === "move") {
      sel = clampRect({ ...drag.r0, x: drag.r0.x + p.x - drag.p0.x, y: drag.r0.y + p.y - drag.p0.y });
    } else if (drag.mode === "resize") {
      sel = resize(drag.r0, drag.d, p, sq);
    } else if (drag.mode === "draw") {
      const r = fromCorner(drag.a.x, drag.a.y, p.x, p.y, sq);
      if (r.w * scale > 2 || r.h * scale > 2) drag.moved = true;
      if (drag.moved) sel = r;
    }
    layout();
  });
  const endDrag = (e) => {
    if (!drag) return;
    if (drag.mode === "draw" && !drag.moved) sel = null; // a click outside the selection clears it
    if (sel && (sel.w < 1 || sel.h < 1)) sel = null;
    drag = null;
    stage.classList.remove("tsl-panning");
    try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    layout();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!nw) return;
    const r = stage.getBoundingClientRect();
    // Mouse wheel and trackpad pinch (ctrlKey) zoom around the pointer.
    const f = Math.exp(-clamp(e.deltaY * (e.deltaMode === 1 ? 33 : 1), -120, 120) * (e.ctrlKey ? 0.01 : 0.0025));
    zoomBy(f, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // ---- keys (routed by the modal: elements never get keydown themselves)
  const onKey = (e) => {
    if (e.target?.tagName === "INPUT" && e.target.type !== "checkbox") return false;
    const k = e.key;
    if (k === " ") {
      if (!spaceDown) {
        spaceDown = true;
        stage.classList.add("tsl-pan-ready");
      }
      e.preventDefault();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === "+" || k === "=") return zoomBy(1.25), e.preventDefault(), true;
    if (k === "-" || k === "_") return zoomBy(1 / 1.25), e.preventDefault(), true;
    if (k === "0") return fit(), e.preventDefault(), true;
    if (k === "1") return actual(), e.preventDefault(), true;
    if (k === "a" || k === "A") return allBtn.click(), e.preventDefault(), true;
    if ((k === "Delete" || k === "Backspace") && sel) return clearBtn.click(), e.preventDefault(), true;
    if (k.startsWith("Arrow") && sel) {
      const step = (e.shiftKey ? 10 : 1) / ratio();
      const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
      const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
      sel = clampRect({ ...sel, x: sel.x + dx, y: sel.y + dy });
      layout();
      e.preventDefault();
      return true;
    }
    return false;
  };
  const onKeyUp = (e) => {
    if (e.key === " ") {
      spaceDown = false;
      stage.classList.remove("tsl-pan-ready");
    }
  };
  document.addEventListener("keyup", onKeyUp, true);

  // ---- confirm
  let busy = false;
  async function confirm(c) {
    if (!valid() || busy) return;
    busy = true;
    c.busy(true);
    err.textContent = "";
    try {
      const rect = { x: sel.x / nw, y: sel.y / nh, w: sel.w / nw, h: sel.h / nh };
      const res = await postJson("/library_image/slice", { id: asset.id, rect, name: asset.name });
      await onSlice?.(res);
      busy = false;
      c.close(true);
    } catch (e) {
      busy = false;
      c.busy(false);
      err.textContent = e.message;
      layout();
    }
  }

  const ro = new ResizeObserver(() => {
    if (!nw) return;
    if (!fitted) {
      fitted = true;
      fit();
    } else {
      clampView();
      layout();
    }
  });

  const ctl = modal({
    title: `Slice @${asset.name}`,
    cls: "tsl",
    content,
    actions: [
      { label: "Cancel", onClick: (c) => c.close() },
      { label: actionLabel, icon: "slice", kind: "primary", onClick: confirm },
    ],
    onKey,
    onClose: () => {
      ro.disconnect();
      document.removeEventListener("keyup", onKeyUp, true);
    },
  });
  ctl.box.focus();
  layout();

  // The file itself (full size, with the browser's EXIF orientation, like the server's crop); a
  // format the browser can't show (TIFF) falls back to the large thumbnail, cut from the same file.
  let fellBack = false;
  img.onload = () => {
    nw = img.naturalWidth;
    nh = img.naturalHeight;
    const rotated = asset.width && asset.height && (nw > nh) !== (asset.width > asset.height) && nw !== nh;
    realW = fellBack && asset.width ? (rotated ? asset.height : asset.width) : nw;
    realH = fellBack && asset.height ? (rotated ? asset.width : asset.height) : nh;
    img.style.width = `${nw}px`;
    img.style.height = `${nh}px`;
    msg.remove();
    if (fellBack) note.textContent = `Showing a smaller preview (the browser can't show this file type full size); the slice is cut from the full-size file. ${note.textContent}`;
    ro.observe(stage);
  };
  img.onerror = () => {
    if (!fellBack && asset.kind !== "video") {
      fellBack = true;
      img.src = library.thumbUrl(asset, 512);
    } else msg.textContent = "This image can't be shown.";
  };
  img.src = library.fileUrl(asset);
  return ctl;
}
