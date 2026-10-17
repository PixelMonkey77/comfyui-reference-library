// Shared helpers for the Library Image / Tagged Prompt extensions.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export const KINDS = ["image", "video", "audio"];

// Auto-grow media ports, e.g. "model.images.image_3" (Nano Banana),
// "model.reference_images.image_3" / "model.reference_videos.video_2" / "model.reference_audios.audio_1" (Seedance).
// Luma names them "model.image_ref.image_3". Any group whose name mentions the kind counts; a bare
// "image_1" (the Tagged Prompt's own inputs) never does.
const PORT_RE = {
  image: /(?:^|\.)[a-z_]*image[a-z_]*\.image_(\d+)$/i,
  video: /(?:^|\.)[a-z_]*video[a-z_]*\.video_(\d+)$/i,
  audio: /(?:^|\.)[a-z_]*audio[a-z_]*\.audio_(\d+)$/i,
};

export const portNum = (name, kind = "image") => {
  const m = PORT_RE[kind].exec(name ?? "");
  return m ? Number(m[1]) : null;
};

/** How a target refers to its Nth input of a kind. Seedance's own code says "Image N" / "Video N" / "Audio N". */
export const mediaLabel = (portName, kind, n) =>
  /reference_/.test(portName ?? "") ? `${kind[0].toUpperCase()}${kind.slice(1)} ${n}` : `${kind} ${n}`;

/** Hidden loader node used for each kind of library asset at queue time. */
export const LOADERS = {
  image: { type: "LibraryImage", pathKey: "image_path" },
  video: { type: "LibraryVideo", pathKey: "path" },
  audio: { type: "LibraryAudio", pathKey: "path" },
};

export const assetKind = (asset) => asset?.kind ?? "image";

export const formatDuration = (s) => {
  if (!(s > 0)) return "";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m ? `${m}:${String(Math.floor(sec)).padStart(2, "0")}` : `${sec.toFixed(1)}s`;
};

/** The input that carries the prompt: "prompt"/"text", or nested like Seedance's "model.prompt". */
export const isPromptKey = (key) => /(?:^|\.)(?:prompt|text)$/.test(key ?? "");

export const stem = (p) => {
  const base = String(p ?? "").trim().replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
};

/** File extensions per kind; the same lists as the server's KIND_EXTS (keep them in step). */
export const EXTS = {
  image: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"],
  video: ["mp4", "mov", "webm", "mkv", "avi", "m4v"],
  audio: ["wav", "mp3", "flac", "ogg", "m4a", "aac", "opus"],
};

/** The kind of a file by its extension, or null. */
export const kindOfPath = (path) => {
  const ext = /\.([^.\\/]+)$/.exec(String(path ?? ""))?.[1]?.toLowerCase();
  return KINDS.find((k) => EXTS[k].includes(ext)) ?? null;
};

// Media file extensions a tag may carry ("@Giftwood.png"); they are ignored when matching.
const MEDIA_EXT = Object.values(EXTS).flat().join("|");
const MEDIA_EXT_RE = new RegExp(`\\.(?:${MEDIA_EXT})$`, "i");

/**
 * Tag-safe name, same rule as the server's _tag_name: "My Ref (2)" -> "My_Ref_2". NFC first (accents
 * pasted from macOS stay one word); empty unless it has a letter or digit ("-" alone is no name).
 */
export const tagName = (s) => {
  const out = String(s ?? "").normalize("NFC").trim().replace(MEDIA_EXT_RE, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^[_-]+|[_-]+$/g, "");
  return /[\p{L}\p{N}]/u.test(out) ? out : "";
};

/**
 * Matching key for a tag or name, lowercased. Tags may name their library ("@Library_02/Biscuit");
 * the key keeps that as "library_02/biscuit". "@Giftwood.png" and "@giftwood" match.
 */
export const tagKey = (s) => {
  const parts = String(s ?? "").split("/");
  const name = tagName(parts.pop());
  return (parts.length ? `${tagName(parts.join("_"))}/${name}` : name).toLowerCase();
};

/** "Library_02/Biscuit.png" -> { lib: "Library_02", name: "Biscuit" }; plain tags have lib null. */
export function splitTag(tok) {
  const parts = String(tok ?? "").split("/");
  const name = tagName(parts.pop());
  return { lib: parts.length ? tagName(parts.join("_")) : null, name };
}

// Tag characters: letters (with combining marks, e.g. a decomposed "é"), digits, _ and -.
const CH = "\\p{L}\\p{M}\\p{N}_-";
const SEG = `[${CH}]+`;

/**
 * @tags in text, in order. `pre` keeps e-mail addresses like me@x.com from matching; a tag may name
 * its library once ("@Lib/Name"); "@Lib/Name/More" is no tag at all.
 */
export const mentionRe = () =>
  new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}_@/])@((?:${SEG}/)?${SEG}(?:\\.(?:${MEDIA_EXT}))?)(?![${CH}]|/[${CH}])`, "giu");

/** The @query typed just before the caret ("Bis", "Library_02/Bis"); same rules as mentionRe. */
export const MENTION_AT_CARET = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}_@/])@((?:${SEG}/)?[${CH}]*)$`, "u");

/**
 * The rest of a tag after the caret, for replacing a whole tag ("rs_Nibbles", "wood.png"). `inTag`:
 * the caret is inside a name, so a "/Name" after it belongs to the tag; right after a bare "@", a
 * "/x" is just text.
 */
export const tagTail = (s, inTag = true) => {
  const name = inTag ? `[${CH}]*(?:/${SEG})?` : `(?:[${CH}]+(?:/${SEG})?)?`;
  return new RegExp(`^${name}(?:\\.(?:${MEDIA_EXT})(?![${CH}]))?`, "iu").exec(s)[0];
};

export function mentionsIn(text) {
  return [...String(text ?? "").matchAll(mentionRe())].map((m) => m[2]);
}

/** Auto-grow ports of one kind on a graph node, sorted by their number. */
export function mediaPorts(node, kind = "image") {
  return (node?.inputs ?? [])
    .map((inp, idx) => ({ inp, idx, n: portNum(inp.name, kind) }))
    .filter((p) => p.n != null)
    .sort((a, b) => a.n - b.n);
}

/** True if a node takes library media at all (any kind of auto-grow port). */
export const hasMediaPorts = (node) => KINDS.some((k) => mediaPorts(node, k).length);

export const getWidget = (node, name) => node?.widgets?.find((w) => w.name === name);

export const setWidget = (node, name, value) => {
  const w = getWidget(node, name);
  if (w) {
    w.value = value;
    w.callback?.(value);
  }
};

export function toast(severity, detail, summary = "Image library") {
  const t = app.extensionManager?.toast;
  if (t?.add) t.add({ severity, summary, detail, life: severity === "error" ? 6000 : 3500 });
  else console[severity === "error" ? "error" : "warn"]("[LibraryImage]", detail);
}

/** POST JSON; on failure throws an Error carrying the server's message and `field` (name/library/file). */
export async function postJson(path, body = {}) {
  const res = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${path}: HTTP ${res.status}`), { field: data.field });
  return data;
}

/** Opens the server-side native file dialog. Resolves to a path, or null if cancelled. */
export async function browseForFile(current = "", kind = "image") {
  return (await postJson("/library_image/browse", { current, kinds: [kind] })).path ?? null;
}

/** /view URL for a file picked in a core Load Image node ("sub/x.png", optionally "x.png [output]"). */
export function viewUrl(value) {
  const m = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(String(value ?? "").trim());
  if (!m?.[1]) return null;
  const parts = m[1].split("/");
  const filename = parts.pop();
  const q = new URLSearchParams({ filename, subfolder: parts.join("/"), type: m[2] ?? "input" });
  return api.apiURL(`/view?${q}`);
}

// ---------------------------------------------------------------- shared asset libraries
// Several named libraries; each node chooses which are enabled. A plain tag ("@Biscuit") resolves
// to the first enabled library (in list order) that has the name; "@Library_02/Biscuit" names one.

export const library = {
  libraries: [], // [{ id, name, count }]
  assets: [], // each with .library (its library id)
  nextLibraryName: "Library_01",
  loaded: false,
  loadedAt: 0,
  _pending: null,
  _listeners: new Set(),

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },

  _gen: 0, // bumped by every _set; a fetch that started before a newer _set is dropped
  error: null, // message of the last failed load, null once a load succeeds

  _set(data) {
    this._gen++;
    this.error = null;
    this.libraries = Array.isArray(data?.libraries) ? data.libraries : [];
    this.assets = Array.isArray(data?.assets) ? data.assets : [];
    this.nextLibraryName = data?.next_library_name ?? this.nextLibraryName;
    if (data?.warning) toast("warn", data.warning); // e.g. a damaged library file was restored from backup
    this.loaded = true;
    this.loadedAt = Date.now();
    if (this._hold) this._held = true;
    else this._notify();
    return data;
  },

  _notify() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error("[LibraryImage]", e); }
    }
  },

  _hold: 0,
  _held: false,
  /**
   * Holds change notifications (strips, outputs) until release(): a library change and the tag
   * pinning that follows it then look like one change, so nothing re-syncs against the half-done state.
   */
  hold() {
    this._hold++;
  },
  release() {
    this._hold = Math.max(0, this._hold - 1);
    if (!this._hold && this._held) {
      this._held = false;
      this._notify();
    }
  },

  /** Fetches the library (files are re-checked on disk); `force` refetches, `maxAge` (ms) allows a recent copy. */
  async load(force = false, maxAge = 0) {
    if (this.loaded && !force) return this.assets;
    if (this.loaded && maxAge && Date.now() - this.loadedAt < maxAge) return this.assets;
    // A forced load must see the disk as it is now, not join a fetch that started earlier.
    if (force && !maxAge && this._pending) await this._pending;
    if (!this._pending) {
      const gen = this._gen;
      this._pending = api
        .fetchApi("/library_image/assets")
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`))))
        .then((d) => {
          // The server sends a recovery warning once: show it even if this response is dropped.
          if (d?.warning) toast("warn", d.warning);
          // An add/rename that finished while this fetch was in flight is newer: keep it.
          if (this._gen === gen) this._set({ ...d, warning: null });
        })
        .catch((e) => {
          if (this._gen !== gen) return; // a newer state arrived meanwhile: this failure is moot
          console.warn("[LibraryImage] library unavailable", e);
          if (this.error !== e.message) toast("error", `Image library unavailable: ${e.message}`);
          this.error = e.message;
        })
        .finally(() => (this._pending = null));
    }
    await this._pending;
    return this.assets;
  },

  /**
   * Lowercased name -> assets of that name in library order. Rebuilt only when the asset list is
   * replaced (resolve() runs for every tag on every refresh).
   */
  _byName() {
    if (this._index?.assets !== this.assets || this._index.libraries !== this.libraries) {
      const order = new Map(this.libraries.map((l, i) => [l.id, i]));
      const map = new Map();
      for (const a of this.assets) {
        const k = a.name.toLowerCase();
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(a);
      }
      for (const list of map.values()) list.sort((a, b) => (order.get(a.library) ?? 0) - (order.get(b.library) ?? 0));
      this._index = { assets: this.assets, libraries: this.libraries, map };
    }
    return this._index.map;
  },

  lib: (id) => library.libraries.find((l) => l.id === id) ?? null,
  libName: (id) => library.lib(id)?.name ?? "?",
  libByName: (name) => library.libraries.find((l) => l.name.toLowerCase() === String(name).toLowerCase()) ?? null,
  byId: (id) => library.assets.find((a) => a.id === id) ?? null,

  /**
   * Resolves a tag against the enabled libraries (null = all). Returns
   *   { status: "ok" | "missing" | "off" | "unknown", asset, lib }
   * "missing": in an enabled library but the file is gone; "off": only in switched-off libraries.
   */
  resolve(tok, enabled = null) {
    const { lib, name } = splitTag(tok);
    const libKey = lib?.toLowerCase();
    const cands = (this._byName().get(name.toLowerCase()) ?? [])
      .filter((a) => !libKey || this.libName(a.library).toLowerCase() === libKey);
    if (!cands.length) return { status: "unknown", asset: null, lib: null };
    const on = enabled ? cands.find((a) => enabled.has(a.library)) : cands[0];
    if (!on) return { status: "off", asset: cands[0], lib: this.lib(cands[0].library) };
    return { status: on.exists === false ? "missing" : "ok", asset: on, lib: this.lib(on.library) };
  },

  /** Shortest tag that resolves to `asset` with these libraries enabled: "Biscuit" or "Library_02/Biscuit". */
  tokenFor(asset, enabled = null) {
    return this.resolve(asset.name, enabled).asset?.id === asset.id ? asset.name : `${this.libName(asset.library)}/${asset.name}`;
  },

  /** Native file dialog on the server; resolves to the picked paths ([] if cancelled). */
  async pick(kinds = KINDS, multi = true) {
    return (await postJson("/library_image/pick", { kinds, multi })).paths ?? [];
  },

  /**
   * Adds files to a library ({ library_id } or { new_library: name }); items = [{ path, name? }].
   * Resolves to { added: [assets], renamed, rejected, library }.
   */
  async add(target, items) {
    const data = this._set(await postJson("/library_image/add", { ...target, items }));
    const ids = new Set(data.added ?? []);
    return { ...data, added: this.assets.filter((a) => ids.has(a.id)) };
  },

  async remove(id) {
    this._set(await postJson("/library_image/remove", { id }));
  },

  /** Resolves to { renamed, old }. Throws (with .field) if the name is taken in its library. */
  async rename(id, name) {
    return this._set(await postJson("/library_image/rename", { id, name }));
  },

  /** Points an asset at another file of the same kind (optionally renaming it). */
  async replace(id, path, name) {
    return this._set(await postJson("/library_image/replace", { id, path, name }));
  },

  async renameLibrary(id, name) {
    return this._set(await postJson("/library_image/library/rename", { id, name }));
  },

  async deleteLibrary(id) {
    return this._set(await postJson("/library_image/library/delete", { id }));
  },

  /** Image/video thumbnail URL, or null for audio (the UI draws a placeholder). */
  thumbUrl(asset, size = 96) {
    if (assetKind(asset) === "audio") return null;
    return api.apiURL(`/library_image/thumb?id=${encodeURIComponent(asset.id)}&s=${size}&v=${asset.mtime ?? 0}`);
  },

  /** Thumbnail of a file just picked in the file dialog (not in the library yet), or null for audio. */
  pickedThumbUrl(path, kind, size = 128) {
    if (kind === "audio") return null;
    return api.apiURL(`/library_image/thumb?path=${encodeURIComponent(path)}&s=${size}`);
  },

  /** The file itself (streamed with range support), for video/audio previews. */
  fileUrl(asset) {
    return api.apiURL(`/library_image/file?id=${encodeURIComponent(asset.id)}&v=${asset.mtime ?? 0}`);
  },
};
