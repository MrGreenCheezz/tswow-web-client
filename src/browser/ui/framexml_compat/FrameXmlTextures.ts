/**
 * Getting the client's own pictures onto a FrameXML widget.
 *
 * Two measured problems live here, and neither is about the renderer's layout.
 *
 * **The gateway will not answer a plain `<img>`.** `originAllowed` refuses a request that carries
 * no `Origin` header whatever the allow-list says, and a browser sends none for an image load or a
 * CSS `url()`. Measured on the live glue screen before this file existed: 150 distinct texture
 * paths, every single one a 403, so the login screen drew its whole interface as empty boxes with
 * nothing in the console but «Failed to load resource». `fetch` sends `Origin` because it is a
 * cross-origin request, so the bytes arrive and reach the element as a blob URL — the same route
 * `ui/IconImage.ts` takes for item icons, for the same reason.
 *
 * **The corpus does not spell texture names the way `/texture` wants.** The route takes a real
 * file and `validAssetPath(value, { extensions: ["blp"] })` refuses anything else, while GlueXML
 * writes what the game's interface code writes: `Interface\Glues\Credits\Parchment8` with no
 * extension at all, and `Interface\Glues\Login\Glues-KoreanRating-Drugs.tga` with the extension
 * of the source art rather than of the shipped file. Measured against the running gateway:
 * `…\Parchment8` answers 400 and `…\Parchment8.blp` answers 200 with 100,295 bytes;
 * `…-Drugs.tga` answers 400 and `…-Drugs.blp` answers 200 with 5,775. The client itself does the
 * same substitution — a `.tga` name in an XML file has never meant a TGA on disk.
 *
 * The blob cache is refcounted rather than permanent, because a glue session builds ~2,900 widgets
 * across seven screens and only one screen is up at a time. What it does *not* do is revoke the
 * instant a count reaches zero: a widget that is hidden and shown again — which is what changing
 * glue screens is — would then refetch every picture on it. Released entries stay addressable in
 * insertion order up to `UNREFERENCED_LIMIT` and are revoked oldest-first past it.
 */

/** How many unreferenced blobs stay addressable. The whole glue corpus names ~150 distinct files. */
const UNREFERENCED_LIMIT = 192;

/** Return the canonical form of an absolute HTTP(S) URL, if the reference is one. */
function normalizedHttpTextureUrl(reference: string): string | undefined {
  try {
    const absolute = new URL(reference);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return undefined;
    return absolute.href;
  } catch {
    return undefined;
  }
}

/**
 * The path `/texture` actually wants, given the name the corpus wrote, or the direct HTTP(S)
 * candidate supplied by a trusted mount seam.
 *
 * Only the last segment is touched, so a directory with a dot in it is left alone. An empty
 * reference stays empty: `…/texture?path=` is a real request and a real 400, and «no texture» is
 * not a broken picture.
 */
export function frameXmlTexturePath(reference: string): string {
  const trimmed = reference.trim();
  // This is transport normalization only. The injected resolver remains responsible for deciding
  // whether an absolute URL may be fetched directly (for example, by checking its gateway origin).
  const absolute = normalizedHttpTextureUrl(trimmed);
  if (absolute !== undefined) return absolute;

  const path = trimmed.replaceAll("/", "\\");
  if (path === "") return "";
  const cut = path.lastIndexOf("\\");
  const leaf = path.slice(cut + 1);
  // A reference that ends at a directory separator names no file. The corpus produces one —
  // `GetName() .. "\\"` with an empty suffix — and asking for it is a guaranteed 400.
  if (leaf === "") return "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return `${path}.blp`;
  return `${path.slice(0, cut + 1)}${leaf.slice(0, dot)}.blp`;
}

/**
 * The paths worth asking `/texture` for, best first, given the name the corpus wrote.
 *
 * Almost always one — {@link frameXmlTexturePath} and nothing else. The exception is the `_lg`
 * suffix, and it is a *named* exception rather than a rule invented here.
 *
 * The owner's `AccountLogin.xml:203` declares
 * `<Texture name="AccountLoginLogo" file="Interface\Glues\Common\Glues-WoW-WotLKLogo_lg" ...>`.
 * That widget is a derived copy of the stock one: the untouched 3.3.5a ruRU client's own
 * `Interface\GlueXML\AccountLogin.xml:130` (read out of `F:/CircleClean`, 84,576 bytes, through the
 * same archive chain) declares the same widget name, the same OVERLAY layer and the file
 * `Interface\Glues\Common\Glues-WoW-WotLKLogo` — no suffix. Measured against the running gateway,
 * `…WotLKLogo_lg.blp` answers 404 and `…WotLKLogo.blp` answers 200 with 163,223 bytes, and nothing
 * in either chain carries an `_lg` sibling for any of the four logos in that directory
 * (`…-Logo`, `…-BClogo`, `…-ChineseWotLKLogo`, `…-WotLKLogo` all resolve, none of their `_lg`
 * forms do). So `_lg` is a rename the module made and not a client convention, and the picture the
 * stock screen has behind that widget is the unsuffixed file.
 *
 * The fallback is tried *after* the primary rather than instead of it: whether a chain carries a
 * name is something only the gateway knows, and a client that rewrote the name up front would be
 * guessing. The cost of being right is one 404 on the first load of that one path.
 */
export function frameXmlTextureCandidates(reference: string): readonly string[] {
  const primary = frameXmlTexturePath(reference);
  if (primary === "") return [];
  if (normalizedHttpTextureUrl(primary) !== undefined) return [primary];
  const stripped = primary.replace(/_lg\.blp$/i, ".blp");
  return stripped === primary ? [primary] : [primary, stripped];
}

/**
 * The eight pieces of a WoW edge file, in the order the file stores them.
 *
 * Measured by reading the alpha of `Interface\Tooltips\UI-Tooltip-Border.blp` (128x16, eight 16x16
 * tiles) pixel by pixel: tiles 0..3 are a vertical bar with every row identical — 0 and 2 with the
 * bar against the left of the tile, 1 and 3 against the right — and tiles 4..7 each turn a
 * vertical bar into a horizontal one, which is what a corner looks like. Tile 4 runs its bar down
 * from the top-left and its arm to the right along the top, 5 mirrors it, 6 and 7 are the bottom
 * pair. `Interface\DialogFrame\UI-DialogBox-Border.blp` (256x32) separates 0/1 from 2/3 by mean
 * alpha — 71, 71, 63, 55 — which is the pairing that says which two are the vertical edges.
 *
 * The top and bottom edges are therefore stored *rotated*: their art is the same `:=@=:` profile
 * as the left and right edges, lying on its side. Rotating a tile a quarter turn clockwise sends
 * its left column to its top row, which puts tile 2's bar along the top and tile 3's along the
 * bottom — exactly where tiles 4..7 put the arms they have to join.
 */
export const FRAME_XML_EDGE_PIECES = Object.freeze([
  "LEFT", "RIGHT", "TOP", "BOTTOM", "TOPLEFT", "TOPRIGHT", "BOTTOMLEFT", "BOTTOMRIGHT",
] as const);

export type FrameXmlEdgePiece = (typeof FRAME_XML_EDGE_PIECES)[number];

/** Blob URLs for one sliced edge file, indexed by `FRAME_XML_EDGE_PIECES`. */
export type FrameXmlEdgeSet = Readonly<Record<FrameXmlEdgePiece, string>>;

/**
 * What the DOM renderer needs from a picture store, and nothing else.
 *
 * Narrow on purpose: the renderer stays a binding that never fetches, never decodes and never
 * touches a canvas, so the widget tests keep running against a DOM stub with no network at all.
 */
export interface FrameXmlTextureSource {
  acquire(path: string): string | undefined;
  peek(path: string): string | undefined;
  release(path: string): void;
  acquireEdge(path: string): FrameXmlEdgeSet | undefined;
  peekEdge(path: string): FrameXmlEdgeSet | undefined;
  releaseEdge(path: string): void;
}

interface Entry {
  refs: number;
  objectUrl?: string;
  /** HTTP status of the last attempt; 0 for a fetch that never got an answer. */
  status: number;
  settled: boolean;
}

export interface FrameXmlTextureCacheOptions {
  /** Trusted host mapping from a `/texture`-shaped path to a URL. */
  readonly resolve: (path: string) => string;
  /** Called once per newly arrived picture, so the renderer can re-apply it. */
  readonly onChange?: () => void;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Fetched pictures, addressable by the path the corpus wrote.
 *
 * Deliberately not a static module cache: a page owns one, and disposing it revokes every blob it
 * made. That keeps the glue screen's lifetime honest and keeps two runtimes in one document (which
 * the tests build) from sharing state.
 */
export class FrameXmlTextureCache implements FrameXmlTextureSource {
  readonly #resolve: (path: string) => string;
  readonly #onChange: (() => void) | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #entries = new Map<string, Entry>();
  /** Keys with `refs === 0`, oldest first, revoked past `UNREFERENCED_LIMIT`. */
  readonly #idle = new Set<string>();
  readonly #edges = new Map<string, { refs: number; set?: FrameXmlEdgeSet }>();
  #disposed = false;

  constructor(options: FrameXmlTextureCacheOptions) {
    this.#resolve = options.resolve;
    this.#onChange = options.onChange;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Distinct paths held, and how many of them have arrived. */
  get stats(): { readonly held: number; readonly ready: number; readonly failed: number } {
    let ready = 0;
    let failed = 0;
    for (const entry of this.#entries.values()) {
      if (entry.objectUrl) ready += 1;
      else if (entry.settled) failed += 1;
    }
    return { held: this.#entries.size, ready, failed };
  }

  /** The status the gateway gave for one path, once it has answered. */
  status(path: string): number | undefined {
    const entry = this.#entries.get(path);
    return entry?.settled === true ? entry.status : undefined;
  }

  /**
   * Take a reference on one picture and get its blob URL if it is already here.
   *
   * Synchronous whenever it can be, which is every draw after the first: the reconciliation pass
   * runs on every bridge mutation and would otherwise restart the wait each time.
   */
  acquire(path: string): string | undefined {
    if (this.#disposed || path === "") return undefined;
    let entry = this.#entries.get(path);
    if (entry) {
      entry.refs += 1;
      this.#idle.delete(path);
      return entry.objectUrl;
    }
    entry = { refs: 1, status: 0, settled: false };
    this.#entries.set(path, entry);
    void this.load(path, entry);
    return undefined;
  }

  /** The blob URL for a path already retained, without taking another reference. */
  peek(path: string): string | undefined {
    return this.#entries.get(path)?.objectUrl;
  }

  release(path: string): void {
    const entry = this.#entries.get(path);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    // Re-inserted so the idle set stays in least-recently-released order.
    this.#idle.delete(path);
    this.#idle.add(path);
    this.evictIdle();
  }

  /**
   * Take a reference on one edge file's eight drawn pieces.
   *
   * The pieces are cut once per file and cached as their own blobs, because CSS cannot rotate a
   * background layer and two of the eight have to be drawn a quarter turn round. Doing it here
   * means the renderer stays a binding: it sets nine background layers and never touches a canvas.
   */
  acquireEdge(path: string): FrameXmlEdgeSet | undefined {
    if (this.#disposed || path === "") return undefined;
    let held = this.#edges.get(path);
    if (held) {
      held.refs += 1;
      return held.set;
    }
    held = { refs: 1 };
    this.#edges.set(path, held);
    void this.sliceEdge(path, held);
    return undefined;
  }

  peekEdge(path: string): FrameXmlEdgeSet | undefined {
    return this.#edges.get(path)?.set;
  }

  releaseEdge(path: string): void {
    const held = this.#edges.get(path);
    if (!held) return;
    held.refs = Math.max(0, held.refs - 1);
  }

  /** Revoke every blob this cache made. Safe to call twice. */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    }
    this.#entries.clear();
    this.#idle.clear();
    for (const held of this.#edges.values()) {
      for (const url of Object.values(held.set ?? {})) URL.revokeObjectURL(url);
    }
    this.#edges.clear();
  }

  private evictIdle(): void {
    while (this.#idle.size > UNREFERENCED_LIMIT) {
      const oldest = this.#idle.values().next();
      if (oldest.done) return;
      const entry = this.#entries.get(oldest.value);
      this.#idle.delete(oldest.value);
      this.#entries.delete(oldest.value);
      if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    }
  }

  private async load(path: string, entry: Entry): Promise<void> {
    // The key is the name the *widget* wrote, so a fallback that answers is stored under the name
    // the renderer will ask for again. `status` keeps the last attempt's code, which for a repaired
    // path is the 200 and not the 404 that led to it.
    for (const candidate of frameXmlTextureCandidates(path)) {
      try {
        const response = await this.#fetch(this.#resolve(candidate));
        entry.status = response.status;
        if (!response.ok) continue;
        const objectUrl = URL.createObjectURL(await response.blob());
        if (this.#disposed || !this.#entries.has(path)) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        entry.objectUrl = objectUrl;
        entry.settled = true;
        this.#onChange?.();
        return;
      } catch {
        entry.status = 0;
      }
    }
    entry.settled = true;
  }

  private async sliceEdge(path: string, held: { refs: number; set?: FrameXmlEdgeSet }): Promise<void> {
    try {
      const response = await this.#fetch(this.#resolve(path));
      if (!response.ok) return;
      const set = await sliceEdgeFile(await response.blob());
      if (this.#disposed || !this.#edges.has(path) || !set) {
        if (set) for (const url of Object.values(set)) URL.revokeObjectURL(url);
        return;
      }
      held.set = set;
      this.#onChange?.();
    } catch {
      // A picture that will not decode is left absent; the caller keeps the frame's own colour.
    }
  }
}

/**
 * Cut one edge file into eight square blobs, rotating the two that are stored on their side.
 *
 * The source rectangle for piece `i` is `[i * width / 8, 0, width / 8, height]` — the client's own
 * mapping, a full-height eighth of the file — and it is drawn into a square of that eighth's width.
 * That squash matters for a file like the owner's `Interface\Glues\Common\LoginBorder.blp`, which
 * is 256x256 rather than the usual 8:1 strip: measured, its rows are identical for pieces 0..3 and
 * its corners are the same art stretched, so squaring it restores exactly the intended border.
 */
async function sliceEdgeFile(blob: Blob): Promise<FrameXmlEdgeSet | undefined> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return undefined;
  const bitmap = await createImageBitmap(blob);
  const tile = Math.max(1, Math.floor(bitmap.width / 8));
  const pieces: Partial<Record<FrameXmlEdgePiece, string>> = {};
  try {
    for (const [index, name] of FRAME_XML_EDGE_PIECES.entries()) {
      const canvas = document.createElement("canvas");
      canvas.width = tile;
      canvas.height = tile;
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      // A quarter turn clockwise sends the tile's left column to its top row, which is what puts
      // piece 2's bar along the top edge and piece 3's along the bottom.
      const rotated = name === "TOP" || name === "BOTTOM";
      if (rotated) {
        context.translate(tile, 0);
        context.rotate(Math.PI / 2);
      }
      context.drawImage(bitmap, index * tile, 0, tile, bitmap.height, 0, 0, tile, tile);
      const encoded = await canvasBlob(canvas);
      if (!encoded) return undefined;
      pieces[name] = URL.createObjectURL(encoded);
    }
  } finally {
    bitmap.close();
  }
  return pieces as FrameXmlEdgeSet;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? undefined), "image/png");
  });
}
