import {
  FRAME_XML_MODEL_TYPES,
  type FrameXmlColor,
  type FrameXmlFontStyle,
  type FrameXmlFrame,
  type FrameXmlMessage,
} from "./FrameXmlTypes.js";
import type { FrameXmlUiBridge } from "./FrameXmlRuntime.js";
import { FRAME_XML_EDGE_PIECES, frameXmlTexturePath, type FrameXmlTextureSource } from "./FrameXmlTextures.js";
import { hasFrameXmlEscapes, parseFrameXmlText } from "./FrameXmlText.js";

export interface FrameXmlDomRendererOptions {
  /**
   * Trusted host mapping from a WoW texture name to an application asset URL.
   * Without this capability the renderer never sets an image `src`, so an
   * addon-controlled value cannot create a browser network request.
   */
  readonly textureResolver?: (texture: string) => string;
  /**
   * Trusted host mapping from a WoW font path (`Fonts\FRIZQT__.TTF`) to a URL.
   * Returning an empty string keeps the CSS fallback stack and emits no
   * `@font-face`, which is the safe default when the gateway has no font.
   */
  readonly fontResolver?: (font: string) => string;
  /** Prefix for the stable classes/data attributes used by the renderer. */
  readonly classPrefix?: string;
  /**
   * The frame a parentless Lua-created frame is drawn inside, by name.
   *
   * A host decision rather than the renderer's, exactly like `textureResolver`: on the glue screens
   * that frame is `GlueParent`, in the world it would be `UIParent`. Without it such a frame is a
   * DOM sibling of every mounted root, and a sibling's `z-index` wins outright over a root's whole
   * subtree however the strata inside it compare — measured, the login module's rotating logo
   * (`MEDIUM`, level 1, z-index 3001) drew over `AccountLogin` at strata `HIGH` (z-index 4000) and
   * over the whole character-select screen. Inside the named frame the two compare the way the
   * client's one global strata order compares them.
   */
  readonly createdRootParent?: string;
  /**
   * Whether parentless frames created through the Lua bridge are discovered and painted automatically.
   *
   * Glue keeps the historical default (`true`) because its dynamically-created logo/dropdowns are
   * part of that screen.  The world mount opts out and promotes a dynamic root explicitly with
   * `addRoots()` only after its owner/lifecycle gate has passed; otherwise a dropdown created while
   * a world is loading would become an unsolicited top-level overlay.
   */
  readonly includeCreatedRoots?: boolean;
  /** Host-selected subtrees; omitted widgets never paint or receive input. */
  readonly frameFilter?: (frame: FrameXmlFrame) => boolean;
  /** Keep a stock ancestor's geometry/visibility without painting its native UI twice. */
  readonly layoutOnly?: (frame: FrameXmlFrame) => boolean;
  /** Subscribe to bridge mutations so sync() is automatic after UI API calls. */
  readonly bridge?: FrameXmlUiBridge;
  /**
   * Where the bytes of a picture come from.
   *
   * Without it the renderer keeps pointing elements straight at `textureResolver`'s URL, which is
   * right for a page-relative asset and for the DOM-stub tests. Against the gateway it is not: a
   * plain `<img>` sends no `Origin` and is refused, so a host that talks to the gateway hands one
   * of these in and the renderer applies blob URLs instead. See `FrameXmlTextures.ts`.
   */
  readonly textures?: FrameXmlTextureSource;
  /**
   * Where a font file is turned into a usable CSS family.
   *
   * With it, `registerFonts` hands each (file, family) pair over instead of writing an
   * `@font-face` rule: the client's own TrueType files need a two-byte `cmap` repair before
   * Chrome's sanitiser will take them (see `FrameXmlFonts.ts`), and that cannot be expressed in
   * CSS. Without it the rules are emitted exactly as before.
   */
  readonly fontLoader?: (file: string, family: string) => void;
  /**
   * `GetTime()` in seconds — the clock a Cooldown widget's sweep is measured against.
   *
   * It has to be the *same* clock the host binds to `GetTime`, because the corpus hands
   * `SetCooldown` a start stamp it got from `GetActionCooldown` in those units and nothing
   * converts anything in between. Defaults to `Date.now() / 1000`, which is what
   * `FrameXmlBoot` binds.
   */
  readonly clock?: () => number;
}

interface RenderedFrame {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
  /** Effective hidden state on the last sync, including hidden ancestors. */
  effectiveHidden?: boolean;
  readonly label?: HTMLElement;
  /** A private paint node for a Backdrop's inset background, below every authored region. */
  backdropBackground?: HTMLElement;
  /** A private paint node owning a Backdrop's eight edge layers, below every authored region. */
  backdropEdge?: HTMLElement;
  /** Per-frame SVG tint filters; never attached to the authored frame or its children. */
  backdropFilters?: BackdropFilters | undefined;
  /**
   * The `<input>` inside an EditBox.
   *
   * An EditBox is *not* rendered as a bare `<input>`, and that is a measured fix rather than a
   * preference: `<input>` is a void element, so every child the corpus declares inside one — the
   * `$parentFill` placeholder FontString, the `<FontString inherits="GlueEditBoxFont"/>` that
   * carries the font, the left/right cap textures of the stock templates — was appended to a node
   * that cannot draw children and laid out at 0x0. On this client's login screen that is both edit
   * boxes: `AccountLoginAccountEdit` and `AccountLoginPasswordEdit` each own a `$parentFill`
   * («Account Name», «Password») that never appeared, which is the whole of "the account and
   * password fields are invisible". So the widget is a `<div>` like every other frame and the text
   * field lives inside it.
   */
  readonly input?: HTMLElement & { value?: string; disabled?: boolean };
  /** The single internal fill owned by a StatusBar; authored regions remain ordinary children. */
  readonly statusBarFill?: HTMLElement;
  /** Private scrolling paint layer owned by a MessageFrame; authored children remain untouched. */
  readonly messageLayer?: HTMLElement & {
    scrollTop?: number;
    readonly scrollHeight?: number;
    readonly clientHeight?: number;
  };
  /** Last message revision and scroll offset painted into messageLayer. */
  messageRevision?: number;
  messageScroll?: number;
  /** Message object references that correspond to the private layer's child order. */
  messageSnapshot?: readonly FrameXmlMessage[];
  /** Monotonic debug ordinal for message lines; retained nodes never need reindexing after a shift. */
  messageNextIndex?: number;
  readonly children: Map<FrameXmlFrame, RenderedFrame>;
  /** Slot name to the `/texture` path this element currently holds a reference on. */
  readonly pictures: Map<string, string>;
  /** The edge file this element currently holds a reference on, if any. */
  edge?: string | undefined;
  /**
   * The source string the text nodes were last built from.
   *
   * A string carrying escapes becomes several `<span>`s, so `textContent` is no longer the thing
   * that was set and cannot be the change guard any more — it comes back with the codes already
   * stripped and would rebuild the runs on every frame.
   */
  textSource?: string | undefined;
}

interface BackdropFilters {
  readonly svg: Element;
  readonly backgroundId: string | undefined;
  readonly edgeId: string | undefined;
  readonly backgroundMatrix: Element | undefined;
  readonly edgeMatrix: Element | undefined;
}

interface FrameDrag {
  readonly source: FrameXmlFrame;
  readonly button: string;
  readonly startX: number;
  readonly startY: number;
  readonly registered: boolean;
  readonly captureMouseUp: boolean;
  readonly cleanup: () => void;
  started: boolean;
  moving?: FrameXmlFrame;
  left?: number;
  top?: number;
}

let nextBackdropFilterId = 0;

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function px(value: number): string {
  return `${value}px`;
}

/** WoW colours are 0..1 floats; CSS wants 0..255 with the alpha left as a float. */
function cssColor(color: FrameXmlColor): string {
  const channel = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${color.a})`;
}

/** A CSS/SVG tint matrix that multiplies every source channel, including coverage, by the Lua tint. */
function backdropMatrixValues(color?: FrameXmlColor): string {
  const tint = color ?? { r: 1, g: 1, b: 1, a: 1 };
  return [
    `${tint.r} 0 0 0 0`,
    `0 ${tint.g} 0 0 0`,
    `0 0 ${tint.b} 0 0`,
    `0 0 0 ${tint.a} 0`,
  ].join(" ");
}

function isIdentityBackdropColor(color?: FrameXmlColor): boolean {
  return color === undefined || (color.r === 1 && color.g === 1 && color.b === 1 && color.a === 1);
}

function mouseButtonName(event: Event): string {
  const button = (event as Event & { readonly button?: unknown }).button;
  if (button === 1) return "MiddleButton";
  if (button === 2) return "RightButton";
  if (button === 3) return "Button4";
  if (button === 4) return "Button5";
  return "LeftButton";
}

/** Horizontal/vertical role of an anchor name, e.g. TOPLEFT -> ("LEFT", "TOP"). */
function anchorRoles(point: string): { readonly x: "LEFT" | "RIGHT" | "CENTER"; readonly y: "TOP" | "BOTTOM" | "CENTER" } {
  const name = point.toUpperCase();
  return {
    x: name.includes("LEFT") ? "LEFT" : name.includes("RIGHT") ? "RIGHT" : "CENTER",
    y: name.includes("TOP") ? "TOP" : name.includes("BOTTOM") ? "BOTTOM" : "CENTER",
  };
}

const LAYER_Z: Readonly<Record<string, number>> = Object.freeze({
  BACKGROUND: 1, BORDER: 2, ARTWORK: 3, OVERLAY: 4, HIGHLIGHT: 5,
});

/**
 * Frame strata, lowest first, as the base of a frame's z-index.
 *
 * Not decorative: `lgzg.lua` builds its whole login scene inside a frame it puts in `LOW`, and
 * `AccountLoginUI` — the account boxes, the buttons, the logo — is a sibling of it in the default
 * `MEDIUM`. With strata dropped, the two were separated by frame level alone, both were zero, and
 * the later-created scene painted the entire interface out of sight. Widget frames start at 1,000
 * so that a child frame is always above its parent's own regions, which top out at 599.
 */
const STRATA_Z: Readonly<Record<string, number>> = Object.freeze({
  WORLD: 0, BACKGROUND: 0, LOW: 1, MEDIUM: 2, HIGH: 3,
  DIALOG: 4, FULLSCREEN: 5, FULLSCREEN_DIALOG: 6, TOOLTIP: 7,
});

/**
 * Render the stateful FrameXML widget tree into a caller-owned DOM host.
 *
 * This is intentionally a binding, not a second WoW UI implementation: it
 * only mirrors the in-memory frame tree and never gives an addon `document`,
 * `window`, network access, or an arbitrary element.  A caller chooses the
 * exact host and the roots to mount, which keeps the native HUD untouched.
 *
 * Layout is resolved declaratively wherever the anchor target is the parent —
 * which is the overwhelming majority of the glue corpus, and the only case that
 * has to work before the host has ever laid the page out. Sibling-relative
 * anchors still fall back to measured rectangles.
 */
export class FrameXmlDomRenderer {
  readonly #container: HTMLElement;
  readonly #textureResolver: ((texture: string) => string) | undefined;
  readonly #fontResolver: ((font: string) => string) | undefined;
  readonly #classPrefix: string;
  readonly #bridge: FrameXmlUiBridge | undefined;
  readonly #rendered = new Map<FrameXmlFrame, RenderedFrame>();
  readonly #roots: FrameXmlFrame[] = [];
  readonly #unsubscribe: (() => void) | undefined;
  readonly #registeredFonts = new Map<string, string>();
  readonly #textures: FrameXmlTextureSource | undefined;
  readonly #fontLoader: ((file: string, family: string) => void) | undefined;
  readonly #createdRootParent: string;
  readonly #includeCreatedRoots: boolean;
  readonly #frameFilter: ((frame: FrameXmlFrame) => boolean) | undefined;
  readonly #layoutOnly: ((frame: FrameXmlFrame) => boolean) | undefined;
  /** Every mounted `Cooldown` widget, so the sweep is advanced without walking the whole tree. */
  readonly #cooldowns = new Set<RenderedFrame>();
  readonly #clock: () => number;
  #fontStyleElement: HTMLStyleElement | undefined;
  #addFilterElement: Element | undefined;
  #lastMutationVersion = -1;
  #drag: FrameDrag | undefined;
  #cursor: { readonly x: number; readonly y: number } | undefined;
  #cursorCleanup: (() => void) | undefined;

  constructor(container: HTMLElement, options: FrameXmlDomRendererOptions = {}) {
    this.#container = container;
    this.#textureResolver = options.textureResolver;
    this.#fontResolver = options.fontResolver;
    this.#classPrefix = options.classPrefix?.trim() || "framexml";
    this.#bridge = options.bridge;
    this.#textures = options.textures;
    this.#fontLoader = options.fontLoader;
    this.#createdRootParent = options.createdRootParent?.trim() ?? "";
    this.#includeCreatedRoots = options.includeCreatedRoots ?? true;
    this.#frameFilter = options.frameFilter;
    this.#layoutOnly = options.layoutOnly;
    this.#clock = options.clock ?? ((): number => Date.now() / 1000);
    this.#unsubscribe = options.bridge?.subscribe(() => this.sync());
  }

  /** Replace the mounted roots. The container itself is never cleared. */
  mount(roots: readonly FrameXmlFrame[]): void {
    this.finishDrag(false);
    for (const rendered of this.#rendered.values()) this.dropRendered(rendered);
    this.#rendered.clear();
    this.#roots.splice(0, this.#roots.length, ...roots);
    this.#lastMutationVersion = -1;
    this.sync();
  }

  /**
   * Add roots produced by a load-on-demand module without rebuilding the existing tree.
   *
   * A FrameXML add-on shares this bridge and can create a small window after the world HUD is
   * already live. Replacing the whole root list would drop and reacquire every picture and detach
   * borrowed canvases (portraits/minimap), so the incremental path only appends genuinely new
   * roots and lets the normal reconciliation walk mount those subtrees.
   */
  addRoots(roots: readonly FrameXmlFrame[]): void {
    let changed = false;
    for (const root of roots) {
      if (this.#roots.includes(root)) continue;
      this.#roots.push(root);
      changed = true;
    }
    if (!changed) return;
    this.#lastMutationVersion = -1;
    this.sync();
  }

  /**
   * Every frame that draws at the top level.
   *
   * The mounted list plus whatever Lua has created since with no parent — `lgzg.lua` makes its
   * rotating logo that way, and before the bridge published these it existed and drew nowhere.
   */
  private topLevel(): readonly FrameXmlFrame[] {
    if (!this.#includeCreatedRoots) return this.#roots;
    const created = this.#bridge?.createdRoots ?? [];
    if (created.length === 0) return this.#roots;
    const all = [...this.#roots];
    for (const frame of created) if (!all.includes(frame)) all.push(frame);
    return all;
  }

  /** Where a parentless Lua-created frame is drawn: the named host frame, or the container. */
  private createdRootHost(): HTMLElement {
    if (!this.#createdRootParent) return this.#container;
    const frame = this.#bridge?.getFrame(this.#createdRootParent);
    const element = frame ? this.#rendered.get(frame)?.element : undefined;
    return element ?? this.#container;
  }

  /** Apply current frame state and reconcile child widgets. */
  sync(): void {
    if (this.#bridge && this.#lastMutationVersion === this.#bridge.mutationVersion) return;
    if (this.#drag && !this.#bridge?.isVisible(this.#drag.source)) this.finishDrag(true);
    const active = new Set<FrameXmlFrame>();
    // The mounted roots first, so the frame `createdRootParent` names has an element to adopt into
    // by the time the parentless Lua frames are reached.
    for (const root of this.#roots) {
      if (this.#frameFilter && !this.#frameFilter(root)) continue;
      this.syncFrame(root, this.#container, active);
    }
    const adopted = this.createdRootHost();
    for (const root of this.topLevel()) {
      if (this.#roots.includes(root)) continue;
      if (this.#frameFilter && !this.#frameFilter(root)) continue;
      this.syncFrame(root, adopted, active);
    }
    for (const [frame, rendered] of this.#rendered) {
      if (!active.has(frame)) {
        this.dropRendered(rendered);
        this.#rendered.delete(frame);
      }
    }
    // A sibling may be declared after the frame that points to it. Re-apply
    // anchors once the whole mounted tree exists so relative geometry can be
    // resolved when the host DOM provides layout rectangles.
    // A hidden target has no browser layout rectangle (`display:none` makes all
    // offset* metrics zero). `measureSibling` falls back to the authored inline
    // pixel geometry for that target and its hidden ancestors; no hidden frame
    // needs to be shown or reconciled during this pass.
    for (const rendered of this.#rendered.values()) {
      if (rendered.effectiveHidden) continue;
      if (rendered.frame.points.some((point) => point.relativeTo && point.relativeTo !== rendered.frame.parent)) {
        this.applyGeometry(rendered.element, rendered.frame);
      }
    }
    // Tooltip paragraphs must be laid out after their FontStrings and sibling anchors. Their
    // rendered height can exceed the C-method's pre-DOM estimate by several wrapped lines.
    for (const rendered of this.#rendered.values()) {
      if (rendered.frame.type === "GameTooltip" && !rendered.effectiveHidden) this.layoutGameTooltip(rendered);
    }
    this.syncCursorTracking();
    if (this.#bridge) this.#lastMutationVersion = this.#bridge.mutationVersion;
  }

  /** Take an element off the page and give back every picture it was holding. */
  private dropRendered(rendered: RenderedFrame): void {
    if (this.#drag?.source === rendered.frame || this.#drag?.moving === rendered.frame) this.finishDrag(false);
    rendered.element.remove();
    rendered.backdropFilters?.svg.remove();
    rendered.backdropFilters = undefined;
    this.#cooldowns.delete(rendered);
    if (!this.#textures) return;
    for (const path of rendered.pictures.values()) this.#textures.release(path);
    rendered.pictures.clear();
    if (rendered.edge) {
      this.#textures.releaseEdge(rendered.edge);
      rendered.edge = undefined;
    }
  }

  /** Remove the renderer's nodes and stop observing bridge mutations. */
  destroy(): void {
    this.#unsubscribe?.();
    this.finishDrag(false);
    this.#cursorCleanup?.();
    this.#cursorCleanup = undefined;
    this.#cursor = undefined;
    this.#bridge?.setMousePosition(0, 0);
    for (const rendered of this.#rendered.values()) this.dropRendered(rendered);
    this.#rendered.clear();
    this.#roots.splice(0, this.#roots.length);
    this.#lastMutationVersion = -1;
    this.#fontStyleElement?.remove();
    this.#fontStyleElement = undefined;
    this.#addFilterElement?.remove();
    this.#addFilterElement = undefined;
    this.#registeredFonts.clear();
  }

  /**
   * The one SVG filter that turns an ADD-blended picture into the light it stands for.
   *
   * **Why a filter and not the blend alone.** `alphaMode="ADD"` is the corpus' whole additive
   * vocabulary — measured over the clean 3.3.5 UI (`F:/CleanTswow` luaxml): **414** `alphaMode`
   * attributes in the corpus, **413** of them `ADD` and one `BLEND`; no `MOD`, no `ALPHAKEY`, no
   * `DISABLE`. In the glue alone it is 45, all ADD. The plates those attributes name are **fully
   * opaque**: measured off the live gateway, `Glue-CharacterSelect-Highlight`,
   * `Glue-Panel-Button-Highlight`, `-Highlight-Blue`, `UI-Character-Tab-Highlight`,
   * `ButtonHilight-Square`, `UI-Common-MouseHilight`, `UI-CheckBox-Highlight` and
   * `UI-Panel-MinimizeButton-Highlight` are α = 255 on **100 %** of their pixels, with mean
   * luminance 2.9 … 81.8 of 255. Their alpha carries no shape at all; their RGB is the light, which
   * is exactly the blend the original gives them.
   *
   * `mix-blend-mode: plus-lighter` has the right arithmetic but cannot reach the picture behind the
   * button: blending stops at the nearest ancestor stacking context, every FrameXML widget has an
   * explicit `z-index` (measured: 3000 on a character row), and G8's own probe in this browser
   * showed a `difference` square staying white through the whole chain. So the group is the button
   * itself, whose backdrop is transparent for a `CharSelectCharacterButtonTemplate` — it declares no
   * `<NormalTexture>` at all, only the highlight — and adding to nothing leaves the opaque black
   * plate on screen. That is the owner's «чёрная окантовка».
   *
   * **What the filter does.** `feColorMatrix` writes the luminance into alpha, and `feComposite`
   * intersects that with the picture's own alpha, so coverage becomes `α · luminance` and the colour
   * is left alone. On the opaque plates (α = 1) that is coverage = luminance: black stops covering
   * and the gold stays gold. On an ADD picture that *does* carry alpha — `Glues-BigButton-Rays` is
   * 81.5 % fully clear with luminance up to 193 under it — the `α` factor is what keeps the clear
   * part clear, which luminance alone would have lit up.
   *
   * The blend stays on top of it: where the button *does* have art of its own, `plus-lighter` still
   * adds over that art inside the button's group, which is the exact original.
   */
  private addFilterId(): string {
    const document = this.#container.ownerDocument;
    const id = `${this.#classPrefix}-alphamode-add`;
    if (this.#addFilterElement || !document || typeof document.createElementNS !== "function") {
      return id;
    }
    // A document that already carries it — `index.html` and `glue.html` each build a renderer, and
    // a second identical <defs> would only duplicate the id.
    const existing = document.getElementById?.(id);
    if (existing) return id;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", id);
    // sRGB, not the SVG default linearRGB: the picture's bytes are what the client adds, and a
    // colour-space round trip would change the light it stands for.
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const matrix = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("result", "lit");
    matrix.setAttribute("values", [
      "1 0 0 0 0",
      "0 1 0 0 0",
      "0 0 1 0 0",
      // Rec. 709 luminance into the alpha row, the same weights the measurement above used.
      "0.2126 0.7152 0.0722 0 0",
    ].join(" "));
    const composite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
    composite.setAttribute("in", "lit");
    composite.setAttribute("in2", "SourceGraphic");
    composite.setAttribute("operator", "in");
    filter.append(matrix, composite);
    svg.append(filter);
    this.#container.append(svg);
    this.#addFilterElement = svg;
    return id;
  }

  get container(): HTMLElement {
    return this.#container;
  }

  /**
   * The element one widget is currently drawn as, if it is drawn at all.
   *
   * The seam the 3D layer hangs off: a Model widget's canvas belongs *inside* its own box, so the
   * host needs the box, and only the renderer knows which element that is.
   */
  elementFor(frame: FrameXmlFrame): HTMLElement | undefined {
    return this.#rendered.get(frame)?.element;
  }

  /**
   * How big one widget actually came out, in UI units.
   *
   * `offsetWidth`/`offsetHeight` rather than `getBoundingClientRect`, and that is the whole point:
   * the stage is laid out in UI units and only *visually* scaled by a transform, so the offset
   * pair is already in the corpus' own coordinate system while the client rect would be in device
   * pixels and would have to be divided by a scale this layer does not know.
   */
  measure(frame: FrameXmlFrame): { width: number; height: number } | undefined {
    const element = this.#rendered.get(frame)?.element;
    if (!element || typeof element.offsetWidth !== "number") return undefined;
    return { width: element.offsetWidth, height: element.offsetHeight };
  }

  /**
   * Register every font file the bridge's font objects name, as `@font-face`.
   *
   * The family name is derived from the WoW path, so two font objects sharing
   * `Fonts\FRIZQT__.TTF` share one download. Without a resolver nothing is
   * emitted at all and font objects degrade to the CSS fallback stack.
   */
  registerFonts(styles: readonly FrameXmlFontStyle[]): number {
    if (!this.#fontResolver && !this.#fontLoader) return 0;
    let added = 0;
    for (const style of styles) {
      const file = style.file?.trim();
      if (!file || this.#registeredFonts.has(file.toLowerCase())) continue;
      if (this.#fontResolver && !this.#fontResolver(file)) continue;
      const family = fontFamilyName(file);
      this.#registeredFonts.set(file.toLowerCase(), family);
      this.#fontLoader?.(file, family);
      added += 1;
    }
    if (added === 0 || !this.#fontResolver || this.#fontLoader) return added;
    const document = this.#container.ownerDocument;
    if (!document) return 0;
    if (!this.#fontStyleElement) {
      this.#fontStyleElement = document.createElement("style");
      this.#fontStyleElement.setAttribute("data-framexml-fonts", "true");
      (document.head ?? this.#container).append(this.#fontStyleElement);
    }
    const rules: string[] = [];
    for (const [file, family] of this.#registeredFonts) {
      const url = this.#fontResolver(file);
      if (!url) continue;
      // The URL comes from the trusted host resolver, never from XML; quotes
      // are still escaped so a pathological path cannot close the rule early.
      rules.push(`@font-face{font-family:"${family}";src:url("${url.replaceAll('"', "%22")}");font-display:block;}`);
    }
    this.#fontStyleElement.textContent = rules.join("\n");
    return added;
  }

  private syncFrame(
    frame: FrameXmlFrame,
    parent: HTMLElement,
    active: Set<FrameXmlFrame>,
    ancestorHidden = false,
  ): RenderedFrame {
    active.add(frame);
    let rendered = this.#rendered.get(frame);
    if (!rendered) {
      rendered = this.createFrame(frame);
      this.#rendered.set(frame, rendered);
    }
    if (rendered.element.parentElement !== parent) parent.append(rendered.element);
    const hidden = ancestorHidden || !frame.visible;
    const wasHidden = rendered.effectiveHidden;
    const firstSync = wasHidden === undefined;
    rendered.effectiveHidden = hidden;
    // A hidden ancestor already suppresses the browser subtree. Keep the existing DOM and
    // resource ownership in place until the ancestor is shown, when the state is applied once.
    // The first sync still walks the subtree so a later Show retains the same mounted shape.
    if (!firstSync && hidden && wasHidden) {
      this.reparentExistingSubtree(frame, rendered);
      this.dropRemovedHiddenChildren(frame, rendered);
      this.markActiveSubtree(frame, active);
      return rendered;
    }
    if (this.#layoutOnly?.(frame)) {
      rendered.element.hidden = hidden;
      rendered.element.style.display = hidden ? "none" : "";
      rendered.element.style.pointerEvents = "none";
      this.applyGeometry(rendered.element, frame);
    } else {
      this.ensureBackdropPaint(rendered);
      this.applyFrame(rendered, hidden);
    }

    // A visible frame becoming hidden needs its own `hidden` bit applied, but its descendants can
    // now wait. Mark them active so the ownership sweep below does not mistake a skipped subtree
    // for an unmounted one, and record the effective state for the eventual reveal.
    if (hidden && !firstSync) {
      this.reparentExistingSubtree(frame, rendered);
      this.dropRemovedHiddenChildren(frame, rendered);
      this.markActiveSubtree(frame, active);
      return rendered;
    }

    // Message lines are private paint state. Keep them dormant with the rest of a hidden subtree;
    // the next reveal applies the latest bounded history exactly once.
    if (!this.#layoutOnly?.(frame)) this.applyMessageFrame(rendered);

    const wanted = new Set(frame.children);
    for (const child of frame.children) {
      if (this.#frameFilter && !this.#frameFilter(child)) continue;
      const childRendered = this.syncFrame(child, rendered.element, active, hidden);
      rendered.children.set(child, childRendered);
    }
    for (const [child, childRendered] of rendered.children) {
      if (!wanted.has(child)) {
        // A live child may have moved to another parent since this rendered map
        // was built. The destination sync adopts its existing node; only remove
        // children that left the bridge tree entirely.
        if (child.parent !== frame) {
          rendered.children.delete(child);
          continue;
        }
        this.dropRendered(childRendered);
        rendered.children.delete(child);
        this.#rendered.delete(child);
      }
    }
    return rendered;
  }

  /** Adopt already-rendered descendants while a destination ancestor is hidden. */
  private reparentExistingSubtree(frame: FrameXmlFrame, rendered: RenderedFrame): void {
    for (const child of frame.children) {
      const childRendered = this.#rendered.get(child);
      if (!childRendered) continue;
      if (childRendered.element.parentElement !== rendered.element) {
        rendered.element.append(childRendered.element);
      }
      rendered.children.set(child, childRendered);
      this.reparentExistingSubtree(child, childRendered);
    }
  }

  /** Keep the rendered map bounded when a child was removed while its ancestor stayed hidden. */
  private dropRemovedHiddenChildren(frame: FrameXmlFrame, rendered: RenderedFrame): void {
    const wanted = new Set(frame.children);
    for (const [child, childRendered] of rendered.children) {
      if (wanted.has(child)) continue;
      // Reparenting removes the child from this bridge list, but the destination
      // still owns the same rendered identity and will adopt it during this sync.
      if (child.parent !== frame) {
        rendered.children.delete(child);
        continue;
      }
      this.dropRendered(childRendered);
      rendered.children.delete(child);
      this.#rendered.delete(child);
    }
  }

  /** Mark a skipped subtree as live without touching its DOM, styles, or texture leases. */
  private markActiveSubtree(frame: FrameXmlFrame, active: Set<FrameXmlFrame>): void {
    if (this.#frameFilter && !this.#frameFilter(frame)) return;
    active.add(frame);
    const rendered = this.#rendered.get(frame);
    if (rendered) rendered.effectiveHidden = true;
    for (const child of frame.children) this.markActiveSubtree(child, active);
  }

  private createFrame(frame: FrameXmlFrame): RenderedFrame {
    const tag = frame.type === "Button" || frame.type === "CheckButton" ? "button"
      : frame.type === "Texture" ? "img"
        : frame.type === "FontString" ? "span" : "div";
    const element = this.#container.ownerDocument?.createElement(tag)
      ?? document.createElement(tag);
    element.classList.add(`${this.#classPrefix}-${frame.type.toLowerCase()}`);
    element.setAttribute("data-framexml-name", frame.name);
    element.setAttribute("data-framexml-type", frame.type);

    if (frame.type === "Button" || frame.type === "CheckButton") {
      element.setAttribute("type", "button");
      element.addEventListener("click", (event) => {
        if (this.#layoutOnly?.(frame)) return;
        // Never forward the browser event itself to an addon.  The bridge gets
        // only FrameXML's stable button name and key-state scalar.
        //
        // A button that armed its own combinations with RegisterForClicks is driven by the two
        // listeners below instead, or it would fire twice on a release it asked for.
        if (frame.clickRegistrations.size > 0) return;
        this.#bridge?.Click(frame, mouseButtonName(event), false);
      });
      element.addEventListener("mousedown", (event) => this.registeredClick(frame, event, true));
      element.addEventListener("mouseup", (event) => this.registeredClick(frame, event, false));
    }
    let input: (HTMLElement & { value?: string; disabled?: boolean }) | undefined;
    if (frame.type === "EditBox") {
      const field = (this.#container.ownerDocument?.createElement("input")
        ?? document.createElement("input")) as HTMLElement & { value?: string; disabled?: boolean };
      field.setAttribute("type", frame.editBox.password ? "password" : "text");
      field.setAttribute("data-framexml-input", "true");
      field.classList.add(`${this.#classPrefix}-input`);
      // Focus is a widget event in FrameXML, and both edit boxes on this login screen use it:
      // `OnEditFocusGained` brightens the border and selects the text, `OnEditFocusLost` puts it
      // back. Without them the box never changed when it was clicked into.
      field.addEventListener("focus", () => {
        if (this.#layoutOnly?.(frame)) return;
        this.#bridge?.update(frame, (mutable) => { mutable.editBox.focused = true; });
        this.#bridge?.fireScript(frame, "OnEditFocusGained");
      });
      field.addEventListener("blur", () => {
        if (this.#layoutOnly?.(frame)) return;
        this.#bridge?.update(frame, (mutable) => { mutable.editBox.focused = false; });
        this.#bridge?.fireScript(frame, "OnEditFocusLost");
      });
      field.addEventListener("input", () => {
        if (this.#layoutOnly?.(frame)) return;
        const value = field.value ?? "";
        const selection = (field as HTMLElement & { selectionStart?: number | null }).selectionStart;
        this.#bridge?.update(frame, (mutable) => {
          mutable.text = value;
          if (typeof selection === "number") mutable.editBox.cursorPosition = selection;
          mutable.editBox.historyIndex = -1;
        });
        this.#bridge?.fireScript(frame, "OnTextChanged", true);
      });
      field.addEventListener("keydown", (event) => {
        if (this.#layoutOnly?.(frame)) return;
        const key = (event as KeyboardEvent).key;
        if (key === "Enter") this.#bridge?.fireScript(frame, "OnEnterPressed");
        else if (key === "Escape") this.#bridge?.fireScript(frame, "OnEscapePressed");
        else if (key === " ") this.#bridge?.fireScript(frame, "OnSpacePressed");
        else if (key === "Tab") this.#bridge?.fireScript(frame, "OnTabPressed");
        else if (key === "ArrowUp" || key === "ArrowDown") {
          const changed = this.#bridge?.NavigateEditBoxHistory(frame, key === "ArrowUp" ? -1 : 1) ?? false;
          if (changed) (event as KeyboardEvent & { preventDefault?: () => void }).preventDefault?.();
        }
      });
      element.append(field);
      input = field;
    }
    if (FRAME_XML_MODEL_TYPES.has(frame.type)) {
      // The 3D content is G3's; G2 leaves a positioned, named box carrying the
      // recorded model state so the canvas can be dropped into exactly it.
      element.setAttribute("data-framexml-model-placeholder", "true");
    }
    let statusBarFill: HTMLElement | undefined;
    if (frame.type === "StatusBar") {
      statusBarFill = this.#container.ownerDocument?.createElement("div")
        ?? document.createElement("div");
      statusBarFill.classList.add(`${this.#classPrefix}-statusbar-fill`);
      statusBarFill.setAttribute("data-framexml-statusbar-fill", "true");
      // It is inserted before every authored region below, so the authored frame XML stays on top.
      element.append(statusBarFill);
    }

    let messageLayer: (HTMLElement & {
      scrollTop?: number;
      readonly scrollHeight?: number;
      readonly clientHeight?: number;
    }) | undefined;
    if (frame.type === "MessageFrame" || frame.type === "ScrollingMessageFrame") {
      const layer = (this.#container.ownerDocument?.createElement("div")
        ?? document.createElement("div")) as HTMLElement & {
          scrollTop?: number;
          readonly scrollHeight?: number;
          readonly clientHeight?: number;
        };
      layer.classList.add(`${this.#classPrefix}-message-layer`);
      layer.setAttribute("data-framexml-message-layer", "true");
      layer.style.position = "absolute";
      layer.style.left = "0";
      layer.style.right = "0";
      layer.style.top = "0";
      layer.style.bottom = "0";
      layer.style.overflowY = "auto";
      layer.style.pointerEvents = "none";
      element.append(layer);
      messageLayer = layer;
    }

    // Pointer and mouse enter/leave are equivalent hover transitions for the
    // bounded bridge. Browsers may emit both for a mouse, so coalesce them
    // before dispatching the Lua callback. The browser event itself never
    // crosses the FrameXML capability boundary.
    let hovering = false;
    const enter = (event: Event) => {
      if (this.#layoutOnly?.(frame)) return;
      this.rememberCursor(event);
      if (hovering) return;
      hovering = true;
      this.#bridge?.Enter(frame);
    };
    const leave = () => {
      if (!hovering) return;
      hovering = false;
      if (this.#layoutOnly?.(frame)) return;
      this.#bridge?.Leave(frame);
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("mouseenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("mouseleave", leave);

    // OnMouseDown/OnMouseUp are separate scripts from OnClick and the character-select screen is
    // built on them: `CharacterSelectFrame_OnMouseDown` starts the drag that turns the character
    // and `CharacterSelectFrame_OnUpdate` keeps turning it until the release. With these unbound
    // the frame could not be turned at all. A press that landed on a control *inside* the frame is
    // not the frame's — in FrameXML the click belongs to the button and stops there — so a bubbled
    // event whose target is an interactive widget is dropped rather than forwarded.
    element.addEventListener("mousedown", (event) => {
      if (this.#layoutOnly?.(frame)) return;
      if (this.bubbledFromControl(element, event)) return;
      this.rememberCursor(event);
      this.#bridge?.fireScript(frame, "OnMouseDown", mouseButtonName(event));
      this.prepareDrag(frame, event);
    });
    element.addEventListener("mouseup", (event) => {
      if (this.#layoutOnly?.(frame)) return;
      if (this.bubbledFromControl(element, event)) return;
      this.#bridge?.fireScript(frame, "OnMouseUp", mouseButtonName(event));
    });

    let label: HTMLElement | undefined;
    if (frame.type === "Frame" || frame.type === "Button" || frame.type === "CheckButton") {
      const labelElement = this.#container.ownerDocument?.createElement("span")
        ?? document.createElement("span");
      labelElement.classList.add(`${this.#classPrefix}-label`);
      labelElement.setAttribute("data-framexml-label", "true");
      element.append(labelElement);
      label = labelElement;
    }
    return {
      frame,
      element,
      ...(label ? { label } : {}),
      ...(input ? { input } : {}),
      ...(statusBarFill ? { statusBarFill } : {}),
      ...(messageLayer ? { messageLayer } : {}),
      children: new Map(),
      pictures: new Map(),
    };
  }

  /** Capture only a drag the original Lua registered or started in OnMouseDown. */
  private prepareDrag(frame: FrameXmlFrame, event: Event): void {
    if (!this.#bridge || !frame.enabled || !this.#bridge.isVisible(frame)) return;
    const mouse = event as MouseEvent;
    if (!Number.isFinite(mouse.clientX) || !Number.isFinite(mouse.clientY)) return;
    const button = mouseButtonName(event);
    const registered = frame.dragRegistrations.has(button.toUpperCase());
    const captureMouseUp = this.#bridge.GetScript(frame, "OnMouseUp") !== undefined;
    if (!registered && !captureMouseUp && !this.movingAncestor(frame)) return;
    // A child owns its registered drag; a bubbled press must not replace it with the parent.
    if (this.#drag) return;
    const doc = this.#container.ownerDocument;
    if (typeof doc?.addEventListener !== "function") return;
    let drag: FrameDrag;
    const move = (next: Event): void => this.moveDrag(drag, next as MouseEvent);
    const up = (next: Event): void => {
      if (mouseButtonName(next) === button) {
        this.rememberCursor(next);
        this.finishDrag(true, next);
      }
    };
    const blur = (): void => this.finishDrag(true);
    drag = {
      source: frame, button, startX: mouse.clientX, startY: mouse.clientY, registered, captureMouseUp, started: false,
      cleanup: () => {
        doc.removeEventListener("mousemove", move, true);
        doc.removeEventListener("mouseup", up, true);
        doc.defaultView?.removeEventListener("blur", blur);
      },
    };
    this.#drag = drag;
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("mouseup", up, true);
    doc.defaultView?.addEventListener("blur", blur);
    mouse.preventDefault?.();
  }

  private movingAncestor(frame: FrameXmlFrame): FrameXmlFrame | undefined {
    for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
      if (current.moving && current.movable) return current;
    }
    return undefined;
  }

  private moveDrag(drag: FrameDrag, event: MouseEvent): void {
    if (this.#drag !== drag || !this.#bridge?.isVisible(drag.source)) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    this.rememberCursor(event);
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
      drag.started = true;
      if (drag.registered) this.#bridge.fireScript(drag.source, "OnDragStart", drag.button);
      if (this.#drag !== drag) return;
      const moving = this.movingAncestor(drag.source);
      const element = moving && this.#rendered.get(moving)?.element;
      if (!moving || !element?.getBoundingClientRect) return;
      const rect = element.getBoundingClientRect();
      drag.moving = moving;
      drag.left = rect.left;
      drag.top = rect.top;
    }
    if (!drag.moving || drag.left === undefined || drag.top === undefined) return;
    if (!drag.moving.moving || !drag.moving.movable) { this.finishDrag(false); return; }
    this.placeAtClientPosition(drag.moving,
      drag.left + event.clientX - drag.startX, drag.top + event.clientY - drag.startY);
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  /** Re-anchor in the same parent while converting CSS pixels to the frame's own UI units. */
  private placeAtClientPosition(frame: FrameXmlFrame, left: number, top: number): void {
    const element = this.#rendered.get(frame)?.element;
    const parent = element?.parentElement ?? this.#container;
    if (!parent.getBoundingClientRect) return;
    const rect = parent.getBoundingClientRect();
    const scaleX = parent.offsetWidth > 0 ? rect.width / parent.offsetWidth : 1;
    const scaleY = parent.offsetHeight > 0 ? rect.height / parent.offsetHeight : 1;
    if (!(scaleX > 0 && scaleY > 0)) return;
    const ownScale = Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : 1;
    const relativeTo = frame.parent ?? this.#bridge?.getFrame(this.#createdRootParent);
    this.#bridge?.update(frame, (mutable) => {
      mutable.setAllPoints = false;
      mutable.points = [{ point: "TOPLEFT", relativePoint: "TOPLEFT",
        ...(relativeTo ? { relativeTo } : {}),
        x: (left - rect.left) / scaleX / ownScale,
        y: (rect.top - top) / scaleY / ownScale }];
    });
  }

  private finishDrag(dispatch: boolean, event?: Event): void {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = undefined;
    drag.cleanup();
    if (drag.captureMouseUp) {
      const element = this.#rendered.get(drag.source)?.element;
      const target = event?.target;
      const inside = target && element && (target === element || element.contains?.(target as Node));
      // Inside releases reach the existing element listener. Outside releases, blur, hide and
      // renderer teardown must invoke the original model's cleanup before detaching its nodes.
      if (!inside) this.#bridge?.fireScript(drag.source, "OnMouseUp", drag.button);
    }
    if (dispatch && drag.moving && this.#bridge?.isVisible(drag.moving)) {
      const element = this.#rendered.get(drag.moving)?.element;
      const rect = element?.getBoundingClientRect?.();
      // Commit the position after screen clamping, so GetPoint and the next layout keep it there.
      if (rect) this.placeAtClientPosition(drag.moving, rect.left, rect.top);
    }
    if (dispatch && drag.started && drag.registered && this.#bridge?.isVisible(drag.source)) {
      this.#bridge.fireScript(drag.source, "OnDragStop", drag.button);
    }
    const moving = drag.moving ?? this.movingAncestor(drag.source);
    if (moving?.moving) this.#bridge?.update(moving, (mutable) => { mutable.moving = false; });
  }

  /** True when a mouse event reached this element only by bubbling out of a control inside it. */
  private bubbledFromControl(element: HTMLElement, event: Event): boolean {
    const target = event.target;
    if (target === element || !target || typeof (target as Element).closest !== "function") return false;
    const owner = (target as Element).closest("[data-framexml-type]");
    if (!owner || owner === element) return false;
    const type = owner.getAttribute("data-framexml-type") ?? "";
    return type === "Button" || type === "CheckButton" || type === "EditBox" || type === "Slider";
  }

  /** Raise OnClick for a press or a release the frame actually registered for. */
  private registeredClick(frame: FrameXmlFrame, event: Event, down: boolean): void {
    if (this.#layoutOnly?.(frame)) return;
    if (frame.clickRegistrations.size === 0) return;
    const button = mouseButtonName(event);
    const phase = down ? "DOWN" : "UP";
    if (!frame.clickRegistrations.has(`${button}${phase}`.toUpperCase()) &&
        !frame.clickRegistrations.has(`ANY${phase}`)) return;
    this.#bridge?.Click(frame, button, down);
  }

  private applyFrame(rendered: RenderedFrame, effectiveHidden = !rendered.frame.visible): void {
    const { frame, element } = rendered;
    const mouse = frame.attributes["enableMouse"] ?? frame.attributes["enablemouse"];
    // Module cards and model previews are Frames with mouse scripts, not necessarily Buttons.
    // Explicitly enabled frames must escape the transparent world/layout parent's inherited rule.
    element.style.pointerEvents = mouse === undefined ? "" : /^(?:true|1)$/i.test(mouse) ? "auto" : "none";
    const hidden = effectiveHidden;
    if (element.hidden !== hidden) element.hidden = hidden;
    const ariaHidden = String(hidden);
    if (element.getAttribute("aria-hidden") !== ariaHidden) {
      element.setAttribute("aria-hidden", ariaHidden);
    }

    if (frame.type === "EditBox") {
      const input = rendered.input;
      if (input) {
        // The value is what somebody typed, so it is never run through the escape parser and never
        // becomes spans: `|` is a character an account name may legitimately contain.
        if (input.value !== frame.text) input.value = frame.text;
        input.disabled = !frame.enabled;
        input.setAttribute("type", frame.editBox.password ? "password" : "text");
        if (frame.editBox.letters > 0) input.setAttribute("maxlength", String(frame.editBox.letters));
        // `<TextInsets>` is the padding the client draws the caret inside; on this login screen it
        // is `left="12"`, which is what keeps the text off the border art.
        const insets = frame.textInsets;
        input.style.padding = insets
          ? `${px(insets.top)} ${px(insets.right)} ${px(insets.bottom)} ${px(insets.left)}`
          : "";
        // `EditBox:SetFocus()` is a real focus: `AccountLogin_OnShow` puts the caret in whichever
        // of the two boxes is still empty, and until this the caret never moved.
        const active = input.ownerDocument?.activeElement;
        if (frame.editBox.focused && active !== undefined && active !== input) input.focus?.();
        const selection = (input as HTMLElement & {
          selectionStart?: number | null;
          selectionEnd?: number | null;
          setSelectionRange?: (start: number, end: number) => void;
        }).selectionStart;
        if (typeof input.ownerDocument?.activeElement === "object"
          && input.ownerDocument?.activeElement === input
          && typeof frame.editBox.cursorPosition === "number"
          && selection !== frame.editBox.cursorPosition) {
          (input as HTMLElement & {
            setSelectionRange?: (start: number, end: number) => void;
          }).setSelectionRange?.(frame.editBox.cursorPosition, frame.editBox.cursorPosition);
        }
      }
    } else if (rendered.label) {
      // A Button's real label is its ButtonText FontString child; the inline
      // label span only carries text a Frame or a texture-less button set
      // directly, so it must not duplicate the child.
      const owned = frame.stateTextures.has("BUTTONTEXT") ? "" : frame.text;
      this.applyText(rendered, rendered.label, owned);
    } else if (frame.type === "FontString") {
      this.applyText(rendered, element, frame.text);
    }

    const width = numberValue(frame.attributes["width"]);
    const height = numberValue(frame.attributes["height"]);
    this.applyGeometry(element, frame, width, height);

    element.style.opacity = frame.alpha === 1 ? "" : String(frame.alpha);
    const zIndex = frame.type === "Texture" || frame.type === "FontString"
      ? String((LAYER_Z[frame.drawLayer] ?? 3) * 100 + frame.drawSubLevel)
      : String(1000 + (STRATA_Z[frame.frameStrata] ?? 2) * 1000 + frame.frameLevel);
    if (element.style.zIndex !== zIndex) element.style.zIndex = zIndex;

    this.applyBackdrop(rendered);
    this.applyFontStyle(element, frame);

    if (frame.type === "Texture") this.applyTexture(rendered);
    if (frame.type === "StatusBar") this.applyStatusBar(rendered);
    if (frame.stateTexture !== "") this.applyStateTexture(element, frame);
    if (frame.type === "Cooldown") {
      this.#cooldowns.add(rendered);
      this.applyCooldown(rendered, this.#clock());
    }
    if (FRAME_XML_MODEL_TYPES.has(frame.type)) this.applyModel(element, frame);
    if (frame.type === "Button" || frame.type === "CheckButton") {
      element.setAttribute("data-framexml-state", frame.buttonState);
      (element as HTMLElement & { disabled?: boolean }).disabled = !frame.enabled;
      if (frame.type === "CheckButton") {
        element.setAttribute("aria-checked", String(frame.checked));
      }
    }
  }

  /** Paint only the private visible message layer; authored children are reconciled separately. */
  private applyMessageFrame(rendered: RenderedFrame): void {
    const layer = rendered.messageLayer;
    if (!layer) return;
    const { frame } = rendered;
    const state = frame.messageFrame;
    this.applyFontStyle(layer, frame);
    layer.style.whiteSpace = "pre-wrap";
    layer.style.overflowWrap = state.nonSpaceWrap ? "anywhere" : "normal";
    layer.setAttribute("data-framexml-max-lines", String(state.maxLines));
    layer.setAttribute("data-framexml-display-duration", String(state.displayDuration));
    layer.setAttribute("data-framexml-nonspacewrap", String(state.nonSpaceWrap));
    layer.setAttribute("data-framexml-scroll-range", String(frame.scroll.verticalScrollRange));
    if (rendered.messageRevision === state.revision
      && rendered.messageScroll === frame.scroll.verticalScroll) return;

    if (rendered.messageRevision !== state.revision) {
      const previous = rendered.messageSnapshot;
      const current = state.messages;
      // A bridge transaction may coalesce several message mutations into one sync. Even if its
      // final arrays happen to look like a one-line shift, the intermediate operation is unknown,
      // so only a single revision gets an incremental paint.
      const singleRevision = rendered.messageRevision !== undefined
        && state.revision === rendered.messageRevision + 1;
      const canIncrement = previous !== undefined && singleRevision && layer.children.length === previous.length;
      const pureAppend = canIncrement && current.length === previous.length + 1
        && previous.every((message, index) => message === current[index]);
      const shiftOneAppend = canIncrement && previous.length > 0 && current.length === previous.length
        && current[current.length - 1] !== previous[previous.length - 1]
        && previous.slice(1).every((message, index) => message === current[index]);

      if (pureAppend) {
        layer.append(this.createMessageLine(
          layer,
          frame,
          current[current.length - 1]!,
          this.nextMessageIndex(rendered),
        ));
      } else if (shiftOneAppend) {
        layer.children[0]?.remove();
        layer.append(this.createMessageLine(
          layer,
          frame,
          current[current.length - 1]!,
          this.nextMessageIndex(rendered),
        ));
      } else {
        if (typeof layer.replaceChildren === "function") layer.replaceChildren();
        else while (layer.children.length > 0) layer.children[layer.children.length - 1]?.remove();
        rendered.messageNextIndex = 0;
        for (const [index, message] of current.entries()) {
          layer.append(this.createMessageLine(layer, frame, message, this.nextMessageIndex(rendered)));
        }
      }
      // Keep a private copy: the runtime mutates its bounded array in place when it shifts.
      rendered.messageSnapshot = current.slice();
      rendered.messageRevision = state.revision;
    }
    layer.setAttribute("data-framexml-scroll", String(frame.scroll.verticalScroll));
    const scrollHeight = Number(layer.scrollHeight);
    const clientHeight = Number(layer.clientHeight);
    const pixelRange = Number.isFinite(scrollHeight) && Number.isFinite(clientHeight)
      ? Math.max(0, scrollHeight - clientHeight) : 0;
    const logicalRange = frame.scroll.verticalScrollRange;
    const fraction = logicalRange > 0
      ? Math.min(1, Math.max(0, frame.scroll.verticalScroll / logicalRange)) : 0;
    // The bridge stores a stable logical line offset; the browser owns the actual
    // line wrapping and therefore the pixel range. This keeps bottom pinned after
    // a resize or a long wrapped message instead of treating one line as one pixel.
    if (typeof layer.scrollTop === "number") layer.scrollTop = pixelRange * fraction;
    rendered.messageScroll = frame.scroll.verticalScroll;
  }

  private nextMessageIndex(rendered: RenderedFrame): number {
    rendered.messageNextIndex = (rendered.messageNextIndex ?? 0) + 1;
    return rendered.messageNextIndex;
  }

  /** Create one private message line, shared by full and incremental paints. */
  private createMessageLine(
    layer: HTMLElement,
    frame: FrameXmlFrame,
    message: FrameXmlMessage,
    index: number,
  ): HTMLElement {
    const line = layer.ownerDocument?.createElement("div") ?? document.createElement("div");
    line.setAttribute("data-framexml-message-index", String(index));
    if (message.accessID !== undefined) line.setAttribute("data-framexml-access-id", String(message.accessID));
    if (message.lineID !== undefined) line.setAttribute("data-framexml-line-id", String(message.lineID));
    line.style.color = cssColor(message.color);
    line.style.whiteSpace = "pre-wrap";
    line.style.overflowWrap = frame.messageFrame.nonSpaceWrap ? "anywhere" : "normal";
    line.textContent = message.text;
    return line;
  }

  /** Render the bounded scalar state of a StatusBar without manufacturing a Texture object. */
  private applyStatusBar(rendered: RenderedFrame): void {
    const fill = rendered.statusBarFill;
    if (!fill) return;
    const { frame } = rendered;
    const { min, max, value, orientation, texture, color } = frame.statusBar;
    const range = max - min;
    const fraction = Number.isFinite(range) && range > 0 && Number.isFinite(min)
      && Number.isFinite(value)
      ? Math.min(1, Math.max(0, (value - min) / range)) : 0;
    fill.style.position = "absolute";
    fill.style.left = "0";
    fill.style.top = "0";
    fill.style.height = "100%";
    fill.style.pointerEvents = "none";
    fill.style.zIndex = "0";
    fill.style.width = `${fraction * 100}%`;
    fill.style.backgroundColor = cssColor(color);
    fill.setAttribute("data-framexml-statusbar-value", String(value));
    fill.setAttribute("data-framexml-statusbar-min", String(min));
    fill.setAttribute("data-framexml-statusbar-max", String(max));
    fill.setAttribute("data-framexml-statusbar-orientation", orientation);
    fill.setAttribute("data-framexml-statusbar-texture", texture);

    // `bindPicture` owns the same stable slot as every other picture on this element. A missing
    // resolver/source leaves the raw declaration as inert metadata rather than opening a URL.
    const resolved = this.bindPicture(rendered, "statusBar", texture) ?? "";
    if (resolved) {
      fill.style.backgroundImage = `url("${resolved.replaceAll('"', "%22")}")`;
      fill.style.backgroundSize = "100% 100%";
      // The stock StatusBar bitmap is an opaque bar; SetStatusBarColor is a tint, not a colour
      // hidden underneath that bitmap. Multiplying the trusted image over the state colour keeps
      // the authored texture while making the Lua colour visible in the browser.
      fill.style.backgroundBlendMode = "multiply";
    } else {
      fill.style.removeProperty("background-image");
      fill.style.removeProperty("background-size");
      fill.style.removeProperty("background-blend-mode");
    }
  }

  /**
   * Show the one picture the owner's state calls for, and hide the other five.
   *
   * A `<Button>` declares up to six state textures and a 3.3.5 client draws **one** of them —
   * disabled instead of normal, pushed instead of normal while held — plus the highlight, and the
   * highlight only under the pointer or while `LockHighlight` holds it. The renderer used to draw
   * every one of them as an ordinary child, stacked, with the highlight on top because HIGHLIGHT is
   * the last draw layer. That is not a subtle error, because a highlight plate is authored for
   * *additive* blending and therefore carries no transparency of its own. Measured on the owner's
   * live chain (`F:/Circle`, the same bytes the gateway serves):
   *
   * | picture | owner | mean RGB | mean α | α > 250 |
   * |---|---|---|---|---|
   * | `Glue-Panel-Button-Highlight` | realm list OK/Cancel, charselect buttons | 22 / 3 / 0 | 255 | 100 % |
   * | `UI-Character-Tab-Highlight` | realm list tabs and sort headers | 0 / 23 / 54 | 255 | 100 % |
   * | `Glue-CharacterSelect-Highlight` | every character row | 103 / 83 / 4 | 255 | 100 % |
   * | `Glue-Panel-Button-Up` (normal, for scale) | the same buttons | 41 / 5 / 5 | 155 | 12 % |
   *
   * So an opaque near-black plate was painted over the whole of every dialog button and every realm
   * row, always — "чёрные кнопки без материала" — while the picture that carries the material
   * underneath it is the one with real transparency in it.
   *
   * The highlight is left to CSS `:hover` rather than to a hover flag here: a pointer that enters a
   * button raises `OnEnter`, and a button whose `OnEnter` does nothing raises no mutation at all, so
   * a re-render is not guaranteed to happen at the moment the pointer arrives. `LockHighlight` is
   * state and is honoured here, inline, which is what wins over the stylesheet.
   */
  private applyStateTexture(element: HTMLElement, frame: FrameXmlFrame): void {
    element.setAttribute("data-framexml-state-texture", frame.stateTexture);
    const owner = frame.parent;
    if (frame.stateTexture === "HIGHLIGHT") {
      // Visible only while locked; otherwise the stylesheet's `:hover` rule owns it.
      if (owner?.highlightLocked) element.style.visibility = "visible";
      else element.style.removeProperty("visibility");
      return;
    }
    const visible = owner ? stateTextureVisible(owner, frame.stateTexture) : true;
    if (visible) element.style.removeProperty("visibility");
    else element.style.visibility = "hidden";
  }

  /**
   * Put one widget's string on the page, escapes and all.
   *
   * The single place text reaches the DOM: a FontString's own element and the inline label a
   * Frame or a plain Button carries both come through here, so `|cAARRGGBB…|r`, `|n`, `||` and
   * `|Hlink|htext|h` are parsed once rather than once per widget kind. An EditBox is deliberately
   * *not* routed here — its text is the value somebody typed, and running a parser over that would
   * silently rewrite what the account field is about to send to the server.
   *
   * The plain path is kept exactly as it was: a string with no pipe in it is one `textContent`
   * assignment guarded by a comparison, which is what every widget on the screen but a handful
   * actually does.
   */
  private applyText(rendered: RenderedFrame, element: HTMLElement, text: string): void {
    if (!hasFrameXmlEscapes(text)) {
      rendered.textSource = undefined;
      if (element.textContent !== text) element.textContent = text;
      return;
    }
    if (rendered.textSource === text) return;
    rendered.textSource = text;
    const runs = parseFrameXmlText(text);
    element.textContent = "";
    // `textContent = ""` empties a real element; the tests' DOM stub keeps its `children` array,
    // so the elements are taken off explicitly as well. Both are cheap and neither is wrong.
    while (element.children.length > 0) element.children[element.children.length - 1]?.remove();
    const document = element.ownerDocument;
    const only = runs.length === 1 ? runs[0] : undefined;
    if (only && only.color === undefined) {
      element.textContent = only.text;
      return;
    }
    for (const run of runs) {
      const span = document?.createElement("span");
      if (!span) {
        element.textContent += run.text;
        continue;
      }
      span.setAttribute("data-framexml-run", "true");
      if (run.color !== undefined) span.style.color = run.color;
      span.textContent = run.text;
      element.append(span);
    }
  }

  /**
   * Point one slot of one element at a picture, taking and giving back references as it moves.
   *
   * Returns the URL to use now, which is `undefined` while the bytes are still on their way — the
   * cache calls back through the bridge's mutation seam when they land, so the next reconciliation
   * pass fills it in. Without a texture source this degrades to the resolver's own URL, which is
   * the right answer for a page-relative asset and for the DOM-stub tests.
   */
  private bindPicture(rendered: RenderedFrame, slot: string, reference: string): string | undefined {
    const source = this.#textures;
    if (!source) {
      return this.#textureResolver && reference ? this.#textureResolver(reference) : undefined;
    }
    const wanted = reference ? frameXmlTexturePath(reference) : "";
    const held = rendered.pictures.get(slot) ?? "";
    if (held !== wanted) {
      if (held) source.release(held);
      if (wanted) {
        source.acquire(wanted);
        rendered.pictures.set(slot, wanted);
      } else {
        rendered.pictures.delete(slot);
      }
    }
    return wanted ? source.peek(wanted) : undefined;
  }

  private applyTexture(rendered: RenderedFrame): void {
    const { frame, element } = rendered;
    const source = frame.texture.trim();
    if (element.getAttribute("data-framexml-texture") !== source) {
      element.setAttribute("data-framexml-texture", source);
    }
    if (element.getAttribute("alt") !== "") element.setAttribute("alt", "");
    // No resolver and no texture source is a deliberate safe default. In
    // particular, values such as https://..., //host/... and /path/... remain
    // inert metadata.
    const resolved = this.bindPicture(rendered, "texture", source) ?? "";
    if (element.getAttribute("src") !== resolved) {
      if (resolved) element.setAttribute("src", resolved);
      else element.removeAttribute("src");
    }

    if (frame.texCoords) {
      const { left, right, top, bottom } = frame.texCoords;
      // TexCoords name a sub-rectangle of an atlas that is then *stretched* over the widget, so a
      // crop alone is not the operation: `clip-path` hides the rest of the picture and leaves the
      // kept part at its original place and size, which is wrong for every atlas the corpus reads
      // a button state out of. `object-view-box` is exactly this operation — it replaces the
      // element's view of its own image, and the default `object-fit: fill` then stretches that
      // view to the box. The same inset is published for both, and the host stylesheet decides
      // which property gets it (`@supports (object-view-box: inset(0))`), so a browser without it
      // still gets the crop rather than the whole atlas.
      element.setAttribute("data-framexml-texcoords", `${left}:${right}:${top}:${bottom}`);
      // PlayerFrameTexture uses a reversed U range (`left=1`, `right=.09375`). CSS insets
      // describe an unordered rectangle, so normalise the crop bounds and keep the authored
      // direction separately in applyGeometry's transform.
      const minX = Math.min(left, right);
      const maxX = Math.max(left, right);
      const minY = Math.min(top, bottom);
      const maxY = Math.max(top, bottom);
      const inset = `${minY * 100}% ${(1 - maxX) * 100}% ${(1 - maxY) * 100}% ${minX * 100}%`;
      element.style.setProperty("--framexml-texcoord-inset", inset);
    } else {
      element.removeAttribute("data-framexml-texcoords");
      element.style.removeProperty("--framexml-texcoord-inset");
    }

    // ADD-blended textures are the glue screen's highlight vocabulary (45 in the glue, 413 in the
    // whole corpus). `plus-lighter` is the CSS compositing operator with the same maths, and
    // `addFilterId` is what makes the plate stop covering what it is supposed to light — see the
    // measurements there.
    const additive = frame.alphaMode === "ADD";
    if (additive) element.style.mixBlendMode = "plus-lighter";
    else element.style.removeProperty("mix-blend-mode");

    if (frame.vertexColor) {
      element.style.setProperty("--framexml-vertex-color", cssColor(frame.vertexColor));
      element.style.opacity = String(frame.vertexColor.a * frame.alpha);
      // `SetTexture(r, g, b, a)` is the other half of the API: a Texture with no file at all,
      // painted flat. `lgzg.lua` builds the login screen's fade-in that way —
      // `LoginScreenBlend:SetTexture(0, 0, 0, 1)` over the whole of GlueParent, faded to zero once
      // the scene has loaded — and with only an `<img>` and no source it drew nothing, so the
      // screen had no fade at all. A file, when there is one, keeps its own pixels.
      element.style.backgroundColor = source ? "" : cssColor({ ...frame.vertexColor, a: 1 });
    } else {
      element.style.removeProperty("--framexml-vertex-color");
      element.style.removeProperty("background-color");
    }
    if (frame.gradient) {
      element.style.setProperty(
        "--framexml-gradient",
        `linear-gradient(${frame.gradient.orientation === "VERTICAL" ? "to top" : "to right"}, `
          + `${cssColor(frame.gradient.min)}, ${cssColor(frame.gradient.max)})`,
      );
    }
    // A Texture with neither a picture nor a colour draws nothing in the original; here it is an
    // `<img>` with no `src`, and a sized one of those is drawn by the browser as its own broken
    // -image placeholder. Measured on the owner's login screen: `AccountLogin.xml:171` declares
    // `<Texture file="">` at 100x100 anchored to the bottom edge, and it came out as an empty
    // 100x100 outline in the middle of the screen, eight units above the bottom.
    const blank = !resolved && !frame.vertexColor && !frame.gradient;
    if (blank) element.setAttribute("data-framexml-blank", "true");
    else element.removeAttribute("data-framexml-blank");
    // One property, two effects, so they are composed rather than overwriting each other. The ADD
    // conversion goes first: it is what the picture *is*, and a desaturate afterwards then greys
    // the light rather than the plate it was cut out of.
    const filters: string[] = [];
    if (additive && resolved) filters.push(`url(#${this.addFilterId()})`);
    if (frame.desaturated) filters.push("grayscale(1)");
    element.style.filter = filters.join(" ");
  }

  /**
   * Advance every mounted cooldown sweep to `now`, and say how many are still running.
   *
   * A separate entry point rather than a bridge mutation, and that is a measurement: `sync()`
   * re-applies **every** rendered widget, which is 846 of them for the action-bar vertical and
   * 25,308 for the whole corpus — so driving a once-per-frame animation through it would make the
   * cheapest thing on screen the most expensive. The set below holds only the `Cooldown` widgets
   * (12 on the main bar, 60 with the multi-bars), so a frame of animation costs one style write
   * each and nothing else is touched.
   *
   * `now` is `GetTime()` seconds — the same clock `SetCooldown` was given.
   */
  tickCooldowns(now = this.#clock()): number {
    let running = 0;
    for (const rendered of this.#cooldowns) {
      if (this.applyCooldown(rendered, now)) running += 1;
    }
    return running;
  }

  /** How many Cooldown widgets are mounted at all; the denominator of `tickCooldowns`. */
  get cooldownCount(): number {
    return this.#cooldowns.size;
  }

  /**
   * The radial wipe, as a conic gradient.
   *
   * The original is a mesh whose triangles are re-cut every frame around the icon's centre; a
   * `conic-gradient` is that shape exactly — one hard colour stop swept about the centre of the
   * box — so the sweep is a background rather than a mask, an overlay element or a canvas. Two
   * consequences worth writing down: the wipe is square-cornered because the box is (which is what
   * the original does too, the art underneath being a square icon), and the sweep runs *clockwise
   * from twelve o'clock*, revealing the icon as the cooldown elapses, which is the direction
   * `conic-gradient`'s own zero angle and winding already give.
   *
   * `duration <= 0` is «no cooldown»: the corpus has already called `Hide()` through
   * `CooldownFrame_SetTimer`, and clearing the background here means a widget that is shown again
   * for another reason does not carry a stale sector.
   */
  private applyCooldown(rendered: RenderedFrame, now: number): boolean {
    const { start, duration } = rendered.frame.cooldown;
    const element = rendered.element;
    const elapsed = duration > 0 ? now - start : 0;
    if (duration <= 0 || elapsed >= duration || elapsed < 0) {
      if (element.style.backgroundImage) element.style.removeProperty("background-image");
      element.removeAttribute("data-framexml-cooldown");
      return false;
    }
    const swept = (elapsed / duration) * 360;
    // Rounded to a tenth of a degree: at 36 px across, a tenth of a degree is well under a pixel,
    // and the rounding is what keeps the style string stable between two frames of a long cooldown
    // instead of rewriting it sixty times a second with a value nothing can see.
    const angle = `${swept.toFixed(1)}deg`;
    const image = `conic-gradient(from 0deg, transparent 0deg ${angle}, `
      + `rgba(0, 0, 0, 0.62) ${angle}, rgba(0, 0, 0, 0.62) 360deg)`;
    if (element.style.backgroundImage !== image) element.style.backgroundImage = image;
    // The remaining fraction, published for a test and for anything that wants to read the sweep
    // without parsing a gradient.
    element.setAttribute("data-framexml-cooldown", (1 - elapsed / duration).toFixed(3));
    return true;
  }

  private applyModel(element: HTMLElement, frame: FrameXmlFrame): void {
    const model = frame.model;
    const set = (name: string, value: number | string | undefined): void => {
      if (value === undefined || value === "") element.removeAttribute(name);
      else element.setAttribute(name, String(value));
    };
    set("data-framexml-model", model.file);
    set("data-framexml-model-scale", model.scale === 1 ? undefined : model.scale);
    set("data-framexml-fog-near", model.fogNear);
    set("data-framexml-fog-far", model.fogFar);
    set("data-framexml-glow", model.glow);
    set("data-framexml-sequence", model.sequence);
    set("data-framexml-camera", model.camera);
    set("data-framexml-facing", model.facing);
    if (model.fogColor) set("data-framexml-fog-color", cssColor(model.fogColor));
  }

  /** Allocate backdrop DOM only for frames that actually carry a Backdrop declaration. */
  private ensureBackdropPaint(rendered: RenderedFrame):
  { readonly background: HTMLElement; readonly edge: HTMLElement } | undefined {
    if (!rendered.frame.backdrop) return undefined;
    if (rendered.backdropBackground && rendered.backdropEdge) {
      return { background: rendered.backdropBackground, edge: rendered.backdropEdge };
    }
    const document = this.#container.ownerDocument;
    const make = (kind: string): HTMLElement => {
      const paint = document?.createElement("div") ?? globalThis.document.createElement("div");
      paint.setAttribute("aria-hidden", "true");
      paint.setAttribute("data-framexml-backdrop-paint", kind);
      paint.style.position = "absolute";
      paint.style.pointerEvents = "none";
      paint.style.zIndex = kind === "edge" ? "1" : "0";
      paint.style.display = "none";
      return paint;
    };
    const background = rendered.backdropBackground ?? make("background");
    const edge = rendered.backdropEdge ?? make("edge");
    const first = rendered.element.children[0];
    const insert = (paint: HTMLElement): void => {
      if (paint.parentElement === rendered.element) return;
      if (first && typeof rendered.element.insertBefore === "function") rendered.element.insertBefore(paint, first);
      else rendered.element.append(paint);
    };
    insert(background);
    insert(edge);
    rendered.backdropBackground = background;
    rendered.backdropEdge = edge;
    return { background, edge };
  }

  /** Create only the per-frame SVG matrices needed by non-identity Lua tints. */
  private ensureBackdropFilters(
    rendered: RenderedFrame,
    backgroundTint?: FrameXmlColor,
    edgeTint?: FrameXmlColor,
  ): BackdropFilters | undefined {
    const needsBackground = !isIdentityBackdropColor(backgroundTint);
    const needsEdge = !isIdentityBackdropColor(edgeTint);
    const existing = rendered.backdropFilters;
    const existingBackground = existing?.backgroundMatrix !== undefined;
    const existingEdge = existing?.edgeMatrix !== undefined;
    if (!needsBackground && !needsEdge) {
      if (existing) this.removeBackdropFilters(rendered);
      return undefined;
    }
    if (existing && existingBackground === needsBackground && existingEdge === needsEdge) return existing;
    if (existing) this.removeBackdropFilters(rendered);
    const document = this.#container.ownerDocument;
    if (!document || typeof document.createElementNS !== "function") return undefined;
    const serial = nextBackdropFilterId++;
    const prefix = `${this.#classPrefix}-backdrop-${serial}`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
    svg.setAttribute("data-framexml-backdrop-filters", rendered.frame.name);
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const makeFilter = (id: string, kind: string): { readonly id: string; readonly matrix: Element } => {
      const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
      filter.setAttribute("id", id);
      filter.setAttribute("filterUnits", "objectBoundingBox");
      filter.setAttribute("x", "-1");
      filter.setAttribute("y", "-1");
      filter.setAttribute("width", "3");
      filter.setAttribute("height", "3");
      filter.setAttribute("color-interpolation-filters", "sRGB");
      const matrix = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
      matrix.setAttribute("type", "matrix");
      matrix.setAttribute("color-interpolation-filters", "sRGB");
      matrix.setAttribute("data-framexml-backdrop-matrix", kind);
      matrix.setAttribute("values", backdropMatrixValues());
      filter.append(matrix);
      defs.append(filter);
      return { id, matrix };
    };
    const background = needsBackground ? makeFilter(`${prefix}-background`, "background") : undefined;
    const edge = needsEdge ? makeFilter(`${prefix}-edge`, "edge") : undefined;
    svg.append(defs);
    this.#container.append(svg);
    rendered.backdropFilters = {
      svg,
      backgroundId: background?.id,
      edgeId: edge?.id,
      backgroundMatrix: background?.matrix,
      edgeMatrix: edge?.matrix,
    };
    return rendered.backdropFilters;
  }

  private removeBackdropFilters(rendered: RenderedFrame): void {
    rendered.backdropFilters?.svg.remove();
    rendered.backdropFilters = undefined;
  }

  /** Clear the legacy root paint properties so only the private backdrop nodes can draw. */
  private clearBackdropRootStyles(element: HTMLElement): void {
    element.style.background = "";
    element.style.backgroundImage = "";
    element.style.backgroundPosition = "";
    element.style.backgroundSize = "";
    element.style.backgroundRepeat = "";
    element.style.backgroundColor = "";
    element.style.removeProperty("background");
    element.style.removeProperty("background-image");
    element.style.removeProperty("background-position");
    element.style.removeProperty("background-size");
    element.style.removeProperty("background-repeat");
    element.style.removeProperty("background-color");
    element.style.removeProperty("--framexml-backdrop-border");
  }

  private clearBackdropPaint(element: HTMLElement): void {
    element.style.display = "none";
    element.style.backgroundImage = "";
    element.style.backgroundPosition = "";
    element.style.backgroundSize = "";
    element.style.backgroundRepeat = "";
    element.style.backgroundColor = "";
    element.style.opacity = "";
    element.style.filter = "";
    element.style.removeProperty("background-image");
    element.style.removeProperty("background-position");
    element.style.removeProperty("background-size");
    element.style.removeProperty("background-repeat");
    element.style.removeProperty("background-color");
    element.style.removeProperty("opacity");
    element.style.removeProperty("filter");
    element.removeAttribute("data-framexml-backdrop-source");
  }

  /**
   * A Backdrop's background and its eight-piece border, as private paint nodes.
   *
   * The root frame must not carry this paint: a backdrop's Lua colour modulates the source pixels,
   * including their alpha, and the border colour tints the edge pixels. Two private nodes let each
   * source be filtered independently without applying a filter to authored children. The inset
   * background is behind the full-size eight-piece edge node, and both are pointer-transparent.
   */
  private applyBackdrop(rendered: RenderedFrame): void {
    const { frame, element } = rendered;
    const backdrop = frame.backdrop;
    const existingPaint = rendered.backdropBackground && rendered.backdropEdge
      ? { background: rendered.backdropBackground, edge: rendered.backdropEdge }
      : undefined;
    const paint = backdrop ? this.ensureBackdropPaint(rendered) : existingPaint;
    this.clearBackdropRootStyles(element);
    if (!backdrop) {
      element.removeAttribute("data-framexml-backdrop");
      element.removeAttribute("data-framexml-backdrop-edge");
      // Clearing through the normal binding seams gives the backdrop picture and edge exactly one
      // release each, including a Lua SetBackdrop(nil) while the frame remains mounted.
      this.bindPicture(rendered, "backdrop", "");
      this.acquireEdges(rendered, "");
      if (paint) {
        this.clearBackdropPaint(paint.background);
        this.clearBackdropPaint(paint.edge);
      }
      this.removeBackdropFilters(rendered);
      return;
    }
    element.setAttribute("data-framexml-backdrop", backdrop.bgFile ?? "");
    if (backdrop.edgeFile) element.setAttribute("data-framexml-backdrop-edge", backdrop.edgeFile);
    else element.removeAttribute("data-framexml-backdrop-edge");

    if (!paint) return;

    const background = this.bindPicture(rendered, "backdrop", backdrop.bgFile ?? "") ?? "";
    const edges = this.acquireEdges(rendered, backdrop.edgeFile ?? "");
    const filters = this.ensureBackdropFilters(rendered, frame.backdropColor, frame.backdropBorderColor);
    filters?.backgroundMatrix?.setAttribute("values", backdropMatrixValues(frame.backdropColor));
    filters?.edgeMatrix?.setAttribute("values", backdropMatrixValues(frame.backdropBorderColor));

    const backgroundPaint = paint.background;
    const edgePaint = paint.edge;
    const insets = backdrop.insets;
    backgroundPaint.style.left = px(insets.left);
    backgroundPaint.style.right = px(insets.right);
    backgroundPaint.style.top = px(insets.top);
    backgroundPaint.style.bottom = px(insets.bottom);
    edgePaint.style.left = "0px";
    edgePaint.style.right = "0px";
    edgePaint.style.top = "0px";
    edgePaint.style.bottom = "0px";

    const size = backdrop.tile && backdrop.tileSize > 0
      ? `${px(backdrop.tileSize)} ${px(backdrop.tileSize)}`
      : "100% 100%";
    if (background) {
      backgroundPaint.style.display = "block";
      backgroundPaint.style.backgroundImage = `url("${background.replaceAll('"', "%22")}")`;
      backgroundPaint.style.backgroundPosition = "left top";
      backgroundPaint.style.backgroundSize = size;
      backgroundPaint.style.backgroundRepeat = backdrop.tile ? "repeat" : "no-repeat";
      backgroundPaint.style.backgroundColor = "";
      backgroundPaint.style.filter = filters?.backgroundId ? `url(#${filters.backgroundId})` : "";
      backgroundPaint.setAttribute("data-framexml-backdrop-source", backdrop.bgFile ?? "");
    } else if (!backdrop.bgFile && frame.backdropColor) {
      // A colour-only Backdrop still draws in the inset rectangle. There is no source alpha to
      // modulate, so the Lua colour is already the complete paint in this branch.
      backgroundPaint.style.display = "block";
      backgroundPaint.style.backgroundColor = cssColor(frame.backdropColor);
      backgroundPaint.setAttribute("data-framexml-backdrop-source", "");
    } else {
      this.clearBackdropPaint(backgroundPaint);
    }

    const layers: { image: string; position: string; size: string; repeat: string }[] = [];
    if (edges && backdrop.edgeSize > 0) {
      const edge = px(backdrop.edgeSize);
      const corner = `${edge} ${edge}`;
      layers.push(
        { image: edges.TOPLEFT, position: "left top", size: corner, repeat: "no-repeat" },
        { image: edges.TOPRIGHT, position: "right top", size: corner, repeat: "no-repeat" },
        { image: edges.BOTTOMLEFT, position: "left bottom", size: corner, repeat: "no-repeat" },
        { image: edges.BOTTOMRIGHT, position: "right bottom", size: corner, repeat: "no-repeat" },
        { image: edges.TOP, position: "left top", size: corner, repeat: "repeat-x" },
        { image: edges.BOTTOM, position: "left bottom", size: corner, repeat: "repeat-x" },
        { image: edges.LEFT, position: "left top", size: corner, repeat: "repeat-y" },
        { image: edges.RIGHT, position: "right top", size: corner, repeat: "repeat-y" },
      );
    }
    if (layers.length === 0) {
      this.clearBackdropPaint(edgePaint);
    } else {
      edgePaint.style.display = "block";
      edgePaint.style.backgroundImage = layers
        .map((layer) => `url("${layer.image.replaceAll('"', "%22")}")`).join(", ");
      edgePaint.style.backgroundPosition = layers.map((layer) => layer.position).join(", ");
      edgePaint.style.backgroundSize = layers.map((layer) => layer.size).join(", ");
      edgePaint.style.backgroundRepeat = layers.map((layer) => layer.repeat).join(", ");
      edgePaint.style.filter = filters?.edgeId ? `url(#${filters.edgeId})` : "";
      edgePaint.setAttribute("data-framexml-backdrop-source", backdrop.edgeFile ?? "");
    }
  }

  /** Hold the eight pieces of one edge file for this element, releasing whatever it held before. */
  private acquireEdges(rendered: RenderedFrame, file: string):
  Readonly<Record<(typeof FRAME_XML_EDGE_PIECES)[number], string>> | undefined {
    const source = this.#textures;
    if (!source) return undefined;
    const wanted = file ? frameXmlTexturePath(file) : "";
    if ((rendered.edge ?? "") !== wanted) {
      if (rendered.edge) source.releaseEdge(rendered.edge);
      rendered.edge = wanted || undefined;
      if (wanted) source.acquireEdge(wanted);
    }
    return wanted ? source.peekEdge(wanted) : undefined;
  }

  private applyFontStyle(element: HTMLElement, frame: FrameXmlFrame): void {
    if (frame.type !== "FontString" && frame.type !== "EditBox" && frame.type !== "SimpleHTML"
      && frame.type !== "MessageFrame" && frame.type !== "ScrollingMessageFrame") return;
    const style = frame.fontObject ? this.#bridge?.fontStyle(frame.fontObject) : undefined;
    if (frame.fontObject) element.setAttribute("data-framexml-font", frame.fontObject);
    const file = frame.attributes["fontFile"] ?? style?.file;
    // Lua may first name a face while opening an addon after the initial font registry was loaded.
    if (file && !this.#registeredFonts.has(file.toLowerCase())) {
      this.registerFonts([{ name: frame.fontObject, file, monochrome: false }]);
    }
    const family = file ? this.#registeredFonts.get(file.toLowerCase()) : undefined;
    element.style.fontFamily = family ? `"${family}", sans-serif` : "";
    const height = numberValue(frame.attributes["fontHeight"]) ?? style?.height;
    element.style.fontSize = height === undefined ? "" : px(height);
    const color = frame.textColor ?? style?.color;
    element.style.color = color ? cssColor(color) : "";
    const justify = frame.justifyH || style?.justifyH;
    element.style.textAlign = justify === "LEFT" ? "left" : justify === "RIGHT" ? "right" : "center";
    if (frame.type === "FontString") {
      // Block alignment preserves the inline color runs and explicit newlines. Flex would turn
      // each WoW escape span into a separate item and change wrapping/justification.
      const vertical = frame.justifyV || style?.justifyV;
      element.style.alignContent = vertical === "TOP" ? "start" : vertical === "BOTTOM" ? "end" : "center";
    }
    if (style?.shadowColor) {
      const dx = style.shadowOffsetX ?? 1;
      const dy = -(style.shadowOffsetY ?? -1);
      element.style.textShadow = `${px(dx)} ${px(dy)} 0 ${cssColor(style.shadowColor)}`;
    } else {
      element.style.removeProperty("text-shadow");
    }
    // OUTLINE/THICKOUTLINE has no direct CSS equivalent; a four-way shadow is
    // the same silhouette and is what the corpus' outlined glue fonts read as.
    const flags = frame.attributes["fontFlags"];
    const outline = flags === undefined ? style?.outline
      : flags.split(/[\s,]+/).find((flag) => flag === "THICKOUTLINE")
        ?? flags.split(/[\s,]+/).find((flag) => flag === "OUTLINE");
    if (outline) {
      const width = outline === "THICKOUTLINE" || outline === "THICK" ? 2 : 1;
      const ring = [`${width}px 0`, `-${width}px 0`, `0 ${width}px`, `0 -${width}px`]
        .map((offset) => `${offset} 0 #000`)
        .join(", ");
      element.style.textShadow = element.style.textShadow ? `${element.style.textShadow}, ${ring}` : ring;
    }
  }

  /** The stock tooltip's text rows flow inside one bounded background instead of overflowing it. */
  private layoutGameTooltip(rendered: RenderedFrame): void {
    const { frame, element } = rendered;
    const rows = new Map<number, { left?: HTMLElement; right?: HTMLElement }>();
    let wrapped = false;
    for (const child of frame.children) {
      if (child.type !== "FontString" || !child.name.startsWith(`${frame.name}Text`)) continue;
      const match = /^(Left|Right)(\d+)$/.exec(child.name.slice(`${frame.name}Text`.length));
      const line = this.#rendered.get(child);
      if (!match || !line || line.effectiveHidden || !child.text) continue;
      const index = Number(match[2]);
      const row = rows.get(index) ?? {};
      row[match[1] === "Left" ? "left" : "right"] = line.element;
      rows.set(index, row);
      wrapped ||= child.attributes["wordWrap"] === "true";
    }
    if (rows.size === 0) return;
    const screen = this.#container.getBoundingClientRect?.();
    const parent = element.parentElement ?? this.#container;
    const parentRect = parent.getBoundingClientRect?.();
    const parentScale = parentRect && parent.offsetWidth > 0 ? parentRect.width / parent.offsetWidth : 1;
    const ownScale = Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : 1;
    const available = screen && screen.width > 0 && parentScale > 0
      ? Math.max(1, screen.width / (parentScale * ownScale) - 16) : 640;
    const declared = numberValue(frame.attributes["width"]) ?? 640;
    element.style.width = px(Math.min(declared, wrapped ? 360 : 640, available));
    element.style.height = "auto";
    element.style.boxSizing = "border-box";
    element.style.padding = "10px";
    element.style.display = "grid";
    element.style.gridTemplateColumns = "minmax(0, 1fr) auto";
    element.style.columnGap = "8px";
    element.style.rowGap = "2px";
    let index = 0;
    for (const [, row] of [...rows].sort(([left], [right]) => left - right)) {
      index++;
      for (const side of ["left", "right"] as const) {
        const line = row[side];
        if (!line) continue;
        // Preserve the actual text/color spans. Grid lays out paragraphs, not the inline runs.
        line.style.position = "relative";
        for (const property of ["left", "right", "top", "bottom", "transform", "translate", "width", "height"]) {
          line.style.removeProperty(property);
        }
        line.style.minWidth = "0px";
        line.style.maxWidth = "100%";
        line.style.whiteSpace = "pre-wrap";
        line.style.overflowWrap = "anywhere";
        line.style.textAlign = side;
        line.style.alignContent = "start";
        line.style.gridRow = String(index);
        line.style.gridColumn = side === "right" ? "2" : row.right ? "1" : "1 / -1";
      }
    }
    this.clampToScreen(element, frame);
  }

  /** Clamp the painted box, including stage/ancestor scales, without rewriting authored anchors. */
  private clampToScreen(element: HTMLElement, frame: FrameXmlFrame): void {
    this.positionCursorTooltip(element, frame);
    element.style.removeProperty("translate");
    if (!frame.clampedToScreen || !element.getBoundingClientRect || !this.#container.getBoundingClientRect) return;
    const screen = this.#container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (!(screen.width > 0 && screen.height > 0 && rect.width > 0 && rect.height > 0)) return;
    const left = Math.max(screen.left, Math.min(rect.left, screen.right - rect.width));
    const top = Math.max(screen.top, Math.min(rect.top, screen.bottom - rect.height));
    const parent = element.parentElement ?? this.#container;
    const parentRect = parent.getBoundingClientRect?.();
    const scaleX = parentRect && parent.offsetWidth > 0 ? parentRect.width / parent.offsetWidth : 1;
    const scaleY = parentRect && parent.offsetHeight > 0 ? parentRect.height / parent.offsetHeight : 1;
    if (!(scaleX > 0 && scaleY > 0)) return;
    if (left !== rect.left || top !== rect.top) {
      element.style.translate = `${(left - rect.left) / scaleX}px ${(top - rect.top) / scaleY}px`;
    }
  }

  private rememberCursor(event: Event): void {
    const mouse = event as MouseEvent;
    if (Number.isFinite(mouse.clientX) && Number.isFinite(mouse.clientY)) {
      this.#cursor = { x: mouse.clientX, y: mouse.clientY };
      const rect = this.#container.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) {
        const width = this.#container.offsetWidth || rect.width;
        const height = this.#container.offsetHeight || rect.height;
        this.#bridge?.setMousePosition((mouse.clientX - rect.left) * width / rect.width,
          height - (mouse.clientY - rect.top) * height / rect.height);
      }
    }
  }

  private positionCursorTooltip(element: HTMLElement, frame: FrameXmlFrame): void {
    const anchor = frame.tooltipCursorAnchor;
    const cursor = this.#cursor;
    if (!anchor || !cursor) return;
    const parent = element.parentElement ?? this.#container;
    const rect = parent.getBoundingClientRect?.();
    if (!rect) return;
    const scaleX = parent.offsetWidth > 0 ? rect.width / parent.offsetWidth : 1;
    const scaleY = parent.offsetHeight > 0 ? rect.height / parent.offsetHeight : 1;
    if (!(scaleX > 0 && scaleY > 0)) return;
    const ownScale = Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : 1;
    const height = element.offsetHeight || numberValue(frame.attributes["height"]) || 0;
    // ANCHOR_CURSOR uses the pointer itself; the gap keeps the tooltip clear of its hotspot.
    element.style.left = px((cursor.x - rect.left) / scaleX + (16 + anchor.x) * ownScale);
    element.style.top = px((cursor.y - rect.top) / scaleY - (height + 16 + anchor.y) * ownScale);
    element.style.removeProperty("right");
    element.style.removeProperty("bottom");
  }

  /** Cursor tracking exists only while an authored cursor tooltip is visible. */
  private syncCursorTracking(): void {
    const tooltips = [...this.#rendered.values()].filter((rendered) =>
      rendered.frame.tooltipCursorAnchor && !rendered.effectiveHidden);
    if (tooltips.length === 0) {
      this.#cursorCleanup?.();
      this.#cursorCleanup = undefined;
      return;
    }
    if (this.#cursorCleanup) return;
    const doc = this.#container.ownerDocument;
    if (typeof doc?.addEventListener !== "function") return;
    const move = (event: Event): void => {
      this.rememberCursor(event);
      for (const rendered of this.#rendered.values()) {
        if (rendered.frame.tooltipCursorAnchor && !rendered.effectiveHidden) {
          this.applyGeometry(rendered.element, rendered.frame);
          this.layoutGameTooltip(rendered);
        }
      }
    };
    doc.addEventListener("mousemove", move, true);
    this.#cursorCleanup = () => doc.removeEventListener("mousemove", move, true);
  }

  /**
   * Turn the anchor set into CSS.
   *
   * Two anchors on the same axis (`TOPLEFT` + `BOTTOMRIGHT`, which is what
   * `setAllPoints` expands to) pin both edges and drop the declared size, which
   * is how a glue screen root inherits GlueParent's pillarboxed rectangle.
   */
  private applyGeometry(
    element: HTMLElement,
    frame: FrameXmlFrame,
    declaredWidth?: number,
    declaredHeight?: number,
  ): void {
    if (element.style.position !== "absolute") element.style.position = "absolute";
    for (const property of ["left", "right", "top", "bottom", "transform", "width", "height"]) {
      element.style.removeProperty(property);
    }
    const width = declaredWidth ?? numberValue(frame.attributes["width"]);
    const height = declaredHeight ?? numberValue(frame.attributes["height"]);
    const scale = Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : 1;
    // Keep texture rotation/mirroring about the centre. The scale translation below keeps the
    // authored anchor fixed while leaving layout dimensions in the frame's own Lua units.
    element.style.transformOrigin = "50% 50%";
    const scaleTransform = (x: number, y: number): string[] => scale === 1 ? [] : [
      ...(x === 0.5 ? [] : [`translateX(${(x - 0.5) * (1 - scale) * 100}%)`]),
      ...(y === 0.5 ? [] : [`translateY(${(y - 0.5) * (1 - scale) * 100}%)`]),
      `scale(${scale})`,
    ];

    // `SetRotation` turns the picture about its own centre, counter-clockwise, which is the
    // opposite sense to CSS's positive angle. It rides on the same transform as the centring
    // translate rather than a second property, because an element has only one.
    const rotation = frame.type === "Texture" && frame.textureRotation !== 0
      ? `rotate(${-frame.textureRotation}rad)` : "";
    const mirrorX = frame.type === "Texture" && frame.texCoords !== undefined
      && frame.texCoords.left > frame.texCoords.right;
    const mirrorY = frame.type === "Texture" && frame.texCoords !== undefined
      && frame.texCoords.top > frame.texCoords.bottom;
    const textureMirrors = [
      ...(mirrorX ? ["scaleX(-1)"] : []),
      ...(mirrorY ? ["scaleY(-1)"] : []),
    ];

    const points = frame.points;
    if (points.length === 0) {
      element.removeAttribute("data-framexml-point");
      element.removeAttribute("data-framexml-relative");
      if (width !== undefined) element.style.width = px(width);
      if (height !== undefined) element.style.height = px(height);
      const transform = [...scaleTransform(0, 0), ...textureMirrors, rotation].filter(Boolean).join(" ");
      if (transform) element.style.transform = transform;
      this.clampToScreen(element, frame);
      return;
    }
    const primary = points[0]!;
    element.setAttribute(
      "data-framexml-point",
      `${primary.point.toUpperCase()}:${(primary.relativePoint ?? primary.point).toUpperCase()}:${primary.x ?? 0}:${primary.y ?? 0}`,
    );
    if (primary.relativeTo) element.setAttribute("data-framexml-relative", primary.relativeTo.name);
    else element.removeAttribute("data-framexml-relative");

    let pinnedLeft = false;
    let pinnedRight = false;
    let pinnedTop = false;
    let pinnedBottom = false;
    let translateX = false;
    let translateY = false;
    for (const point of points) {
      const own = anchorRoles(point.point);
      const offsetX = (point.x ?? 0) * scale;
      // FrameXML's positive Y points upward; CSS's positive Y points downward.
      const offsetY = -(point.y ?? 0) * scale;
      const sibling = point.relativeTo && point.relativeTo !== frame.parent
        ? this.measureSibling(element, point.relativeTo)
        : undefined;
      if (sibling) {
        // A sibling anchor needs the frame's own size to place an edge other
        // than its top-left, so it is positioned from measured rectangles
        // rather than from percentages of the containing block.
        const target = anchorRoles(point.relativePoint ?? point.point);
        // Layout pixels, for the same reason `offsetWithin` uses them: a client rectangle is in
        // device pixels and the stage is scaled.
        // Width/height were cleared above. An <img> now reports its intrinsic pixel dimensions,
        // so an authored 24px icon must take precedence over the temporary texture dimensions.
        const ownWidth = width ?? (typeof element.offsetWidth === "number" ? element.offsetWidth : 0);
        const ownHeight = height ?? (typeof element.offsetHeight === "number" ? element.offsetHeight : 0);
        const ownLeft = own.x === "LEFT" ? 0 : own.x === "RIGHT" ? ownWidth : ownWidth / 2;
        const ownTop = own.y === "TOP" ? 0 : own.y === "BOTTOM" ? ownHeight : ownHeight / 2;
        element.style.left = px(sibling.x[target.x] + offsetX - ownLeft);
        element.style.top = px(sibling.y[target.y] + offsetY - ownTop);
        pinnedLeft = true;
        pinnedTop = true;
        continue;
      }
      // Without measurable geometry a cross-frame anchor degrades to the
      // frame's own edge on its parent — the same rectangle the anchor would
      // land on when the sibling fills the parent, and never an unpositioned
      // element stacked at the origin.
      const degraded = point.relativeTo !== undefined && point.relativeTo !== frame.parent;
      const target = degraded ? own : anchorRoles(point.relativePoint ?? point.point);
      const relative = PARENT_ORIGIN;
      const targetX = relative.x[target.x];
      const targetY = relative.y[target.y];
      if (own.x === "LEFT") {
        element.style.left = offsetExpression(targetX, offsetX);
        pinnedLeft = true;
        translateX = false;
      } else if (own.x === "RIGHT") {
        element.style.right = offsetExpression(invert(targetX), -offsetX);
        pinnedRight = true;
      } else if (!pinnedLeft && !pinnedRight) {
        element.style.left = offsetExpression(targetX, offsetX);
        translateX = true;
      }
      if (own.y === "TOP") {
        element.style.top = offsetExpression(targetY, offsetY);
        pinnedTop = true;
        translateY = false;
      } else if (own.y === "BOTTOM") {
        element.style.bottom = offsetExpression(invert(targetY), -offsetY);
        pinnedBottom = true;
      } else if (!pinnedTop && !pinnedBottom) {
        element.style.top = offsetExpression(targetY, offsetY);
        translateY = true;
      }
    }
    // Only a single-edge anchor keeps the declared size; a pinned pair defines
    // the box itself, and re-applying width would fight the second anchor.
    if (width !== undefined && !(pinnedLeft && pinnedRight)) element.style.width = px(width);
    if (height !== undefined && !(pinnedTop && pinnedBottom)) element.style.height = px(height);
    // …except for a Texture, which is an `<img>`, and CSS sizes an absolutely positioned
    // *replaced* element from its intrinsic dimensions when width is `auto` — it does not solve
    // for the distance between the two pinned edges the way it does for a `<div>`. Measured on the
    // login screen: `LoginScreenBackground`, pinned to all four sides of a 1341x768 scene, laid
    // itself out at 2048x2048 — the size of `Fondo.blp` — and `setAllPoints` on the rotating logo
    // did the same at 1400. So the distance is written out as the width; `right`/`bottom` then
    // become the over-constrained edge and are dropped, which is exactly the intent.
    //
    // **Whatever the region declares**, and that clause is the owner's golden frame at the bottom
    // left of the login screen. `GlueButtons.xml:263` declares the Website button's glow as
    // `<Texture name="$parentGlow" setAllPoints="true" alphaMode="ADD">` **with** a
    // `<Size x="150" y="51"/>` inside it. Two anchors outrank a size in the original, so the branch
    // above (rightly) does not write the 150 — and the branch here used to skip it too, because a
    // size *was* declared. Neither wrote anything, and an `<img>` with `inset: 0` and no width fell
    // back to its own picture: measured live at 1920x969, `AccountLoginCommunityButtonGlow` came out
    // **747x219** UI units instead of the button's 150x38 — `Glues-BigButton-Glow` is 1024x256 and
    // its `object-view-box` crop is exactly 0.7295 x 0.8555 of that — an ADD-blended gold plate five
    // times the button, anchored at its top-left corner. Its `$parentRays` twin is the same
    // declaration and appears on hover.
    if (frame.type === "Texture" || scale !== 1) {
      if (pinnedLeft && pinnedRight) {
        const span = `100% - (${element.style.left}) - (${element.style.right})`;
        element.style.width = scale === 1 ? `calc(${span})` : `calc((${span}) / ${scale})`;
      }
      if (pinnedTop && pinnedBottom) {
        const span = `100% - (${element.style.top}) - (${element.style.bottom})`;
        element.style.height = scale === 1 ? `calc(${span})` : `calc((${span}) / ${scale})`;
      }
    }
    const anchor = anchorRoles(primary.point);
    const scaleX = pinnedLeft && pinnedRight ? 0 : anchor.x === "LEFT" ? 0 : anchor.x === "RIGHT" ? 1 : 0.5;
    const scaleY = pinnedTop && pinnedBottom ? 0 : anchor.y === "TOP" ? 0 : anchor.y === "BOTTOM" ? 1 : 0.5;
    element.style.transform = [
      ...(translateX ? ["translateX(-50%)"] : []),
      ...(translateY ? ["translateY(-50%)"] : []),
      ...scaleTransform(scaleX, scaleY),
      ...textureMirrors,
      rotation,
    ].filter(Boolean).join(" ");
    this.clampToScreen(element, frame);
  }

  /** Anchor target edges in pixels inside this element's containing block. */
  private measureSibling(
    element: HTMLElement,
    target: FrameXmlFrame,
  ): {
    readonly x: Readonly<Record<"LEFT" | "RIGHT" | "CENTER", number>>;
    readonly y: Readonly<Record<"TOP" | "BOTTOM" | "CENTER", number>>;
  } | undefined {
    const targetElement = this.#rendered.get(target)?.element;
    const parent = element.parentElement ?? this.#container;
    if (!targetElement) return undefined;
    const at = offsetBetween(targetElement, parent);
    if (!at) return undefined;
    const geometry = offsetMetrics(targetElement);
    if (!geometry) return undefined;
    const width = geometry.width * at.scale;
    const height = geometry.height * at.scale;
    const { left, top } = at;
    return {
      x: { LEFT: left, CENTER: left + width / 2, RIGHT: left + width },
      y: { TOP: top, CENTER: top + height / 2, BOTTOM: top + height },
    };
  }
}

/**
 * Where one element sits inside an ancestor, in layout pixels.
 *
 * The offset chain rather than `getBoundingClientRect`, and it is the same distinction `measure()`
 * makes: the stage is laid out in UI units and only *visually* scaled by a transform, so client
 * rectangles come back in device pixels. Written back as a UI-unit `left`, a client rectangle is
 * short by the scale — and the error compounds down a chain of siblings, because each one is
 * anchored to the one above. Measured on the live character-select screen at scale 0.9375: the ten
 * `CharSelectCharacterButton`s, each anchored TOP to the previous one's BOTTOM, walked left by
 * about nine pixels and up by four per row (24.0, 14.5, 5.6, −2.8 …) instead of forming a column.
 *
 * `undefined` when the chain does not reach the ancestor or the host has no layout at all (the
 * tests' DOM stub), which is the caller's signal to degrade to a parent-edge anchor.
 */
function offsetWithin(
  element: HTMLElement,
  ancestor: HTMLElement,
): ScaledOffset | undefined {
  let left = 0;
  let top = 0;
  let scale = 1;
  let node: HTMLElement | null = element;
  // Bounded: a glue screen is a handful of levels deep, and a cycle would be a broken document.
  for (let depth = 0; node && node !== ancestor && depth < 64; depth += 1) {
    const geometry = offsetMetrics(node);
    if (!geometry) return undefined;
    const shift = centringShift(node, geometry.width, geometry.height);
    left = geometry.left + shift.left + shift.scale * left;
    top = geometry.top + shift.top + shift.scale * top;
    scale *= shift.scale;
    node = geometry.parent;
  }
  return node === ancestor ? { left, top, scale } : undefined;
}

/** Every offset ancestor of one element and how far inside it that element sits, nearest first. */
function offsetChain(element: HTMLElement): Map<HTMLElement, ScaledOffset> {
  const chain = new Map<HTMLElement, ScaledOffset>();
  let left = 0;
  let top = 0;
  let scale = 1;
  let node: HTMLElement | null = element;
  for (let depth = 0; node && depth < 64; depth += 1) {
    const geometry = offsetMetrics(node);
    if (!geometry) break;
    const shift = centringShift(node, geometry.width, geometry.height);
    left = geometry.left + shift.left + shift.scale * left;
    top = geometry.top + shift.top + shift.scale * top;
    scale *= shift.scale;
    node = geometry.parent;
    if (node && !chain.has(node)) chain.set(node, { left, top, scale });
  }
  return chain;
}

interface Offset { readonly left: number; readonly top: number }
interface ScaledOffset extends Offset { readonly scale: number }

interface OffsetMetrics extends Offset {
  readonly width: number;
  readonly height: number;
  readonly parent: HTMLElement | null;
}

/**
 * Read layout metrics without forcing a display:none subtree to participate in layout.
 *
 * Hidden FrameXML widgets already carry the geometry authored by `applyGeometry` in inline CSS,
 * but browsers report zero `offset*` metrics and a null `offsetParent` for them. Pixel-valued
 * inline properties are sufficient for the fixed-size widget chains that use cross-frame anchors;
 * visible elements continue to use the browser's measured metrics exactly as before.
 */
function offsetMetrics(node: HTMLElement): OffsetMetrics | undefined {
  const hidden = hiddenInLayout(node);
  const width = hidden ? inlinePixel(node.style?.width) ?? node.offsetWidth : node.offsetWidth;
  const height = hidden ? inlinePixel(node.style?.height) ?? node.offsetHeight : node.offsetHeight;
  const parent = node.parentElement;
  // A hidden bottom/right-anchored widget has no offset geometry, but its containing block and its
  // own fixed FrameXML size are still authored inline. Resolve the missing leading edge before
  // accepting the browser's hidden-subtree zero. CharacterFrameTab1 is the important stock case:
  // Tab3 and Tab4 chain through a hidden Tab2, so one bogus top=0 moves the whole row to the title.
  const parentWidth = parent
    ? inlinePixel(parent.style?.width) ?? (parent.offsetWidth > 0 ? parent.offsetWidth : undefined)
    : undefined;
  const parentHeight = parent
    ? inlinePixel(parent.style?.height) ?? (parent.offsetHeight > 0 ? parent.offsetHeight : undefined)
    : undefined;
  const right = hidden ? inlinePixel(node.style?.right) : undefined;
  const bottom = hidden ? inlinePixel(node.style?.bottom) : undefined;
  const derivedLeft = right !== undefined && parentWidth !== undefined && typeof width === "number"
    ? parentWidth - right - width : undefined;
  const derivedTop = bottom !== undefined && parentHeight !== undefined && typeof height === "number"
    ? parentHeight - bottom - height : undefined;
  const left = hidden
    ? inlinePixel(node.style?.left) ?? derivedLeft ?? node.offsetLeft
    : node.offsetLeft;
  const top = hidden
    ? inlinePixel(node.style?.top) ?? derivedTop ?? node.offsetTop
    : node.offsetTop;
  if (typeof left !== "number" || typeof top !== "number"
    || typeof width !== "number" || typeof height !== "number") return undefined;
  const offsetParent = node.offsetParent as HTMLElement | null;
  return {
    left,
    top,
    width,
    height,
    // A hidden element's offsetParent is null even though its parent is the containing block. The
    // renderer positions every widget absolutely, so its DOM parent is the corresponding fallback.
    parent: offsetParent ?? (hidden ? node.parentElement : null),
  };
}

function hiddenInLayout(node: HTMLElement): boolean {
  let current: HTMLElement | null = node;
  // Bounded for the same reason as the offset walk: malformed host DOM must not loop forever.
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (current.hidden === true) return true;
    current = current.parentElement;
  }
  return false;
}

function inlinePixel(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))px\s*$/i.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * How far one element is *painted* from where it is laid out.
 *
 * A widget anchored by its own centre — `<Anchor point="TOP"/>`, `point="LEFT"`, `point="CENTER"` —
 * is placed by `applyGeometry` as `left: 50%` plus `transform: translateX(-50%)`, which is the only
 * way to centre a box whose width the renderer does not know in advance. A transform does not move
 * layout, so `offsetLeft` reports the pre-transform edge and the walk above measured such a target
 * half a box too far right (or too far down).
 *
 * Both halves of the owner's realm dialog are this one error:
 *
 * - «Выбор мира» is a FontString anchored `point="TOP" relativeTo="RealmListHeader"`
 *   (`RealmList.xml:352`), and `RealmListHeader` is itself anchored `point="TOP"` — so the title was
 *   placed against a centre that was **+128** units off, half of the header plate's declared 256,
 *   and sat to the right of the notch the plate is cut for.
 * - Every column's sort arrow is `<Anchor point="LEFT" relativeTo="$parentText"
 *   relativePoint="RIGHT" y="-2"/>` (`RealmList.xml:147`), and `$parentText` is a `ButtonText`
 *   anchored `point="LEFT"` — vertically centred, therefore translated — so the arrow was placed
 *   half the label's line box **below** its middle and hung under the heading.
 *
 * The shift is applied at every step of the offset walk rather than only at the target, because an
 * intermediate `offsetParent` that is centre-anchored displaces everything inside it by the same
 * amount. On the two walks `offsetBetween` subtracts, shared ancestors cancel out, so the correction
 * only ever adds what is genuinely between the two boxes.
 */
function centringShift(node: HTMLElement, width = node.offsetWidth, height = node.offsetHeight): ScaledOffset {
  // The renderer writes this transform itself; nothing here parses a computed style, so a page that
  // has no layout at all (the tests' DOM stub) simply answers zero.
  const transform = typeof node.style?.transform === "string" ? node.style.transform : "";
  const measuredWidth = typeof width === "number" ? width : 0;
  const measuredHeight = typeof height === "number" ? height : 0;
  const parsedScale = Number(/(?:^|\s)scale\(([^)]+)\)/.exec(transform)?.[1] ?? 1);
  const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
  let left = (1 - scale) * measuredWidth / 2;
  let top = (1 - scale) * measuredHeight / 2;
  for (const match of transform.matchAll(/translate([XY])\((-?[\d.e+]+)%\)/g)) {
    if (match[1] === "X") left += Number(match[2]) * measuredWidth / 100;
    else top += Number(match[2]) * measuredHeight / 100;
  }
  // Screen clamping uses the individual translate property, which is already in parent units.
  const translate = typeof node.style?.translate === "string" ? node.style.translate.trim().split(/\s+/) : [];
  return {
    left: left + (inlinePixel(translate[0]) ?? 0),
    top: top + (inlinePixel(translate[1]) ?? 0),
    scale,
  };
}

/**
 * Where the anchor target sits in the coordinate space of the anchored element's containing block,
 * whatever branch of the tree it lives in.
 *
 * FrameXML lets a region anchor to *any* frame; the parent decides clipping and draw order, not
 * coordinates. The DOM does not: `left` is measured from the containing block, so a target outside
 * that block has to be brought into it. Walking up from the target alone answers only the case
 * where the target happens to sit inside the same box.
 *
 * Measured on the owner's live corpus (3,298 widgets): of **853** anchors that name a frame other
 * than the anchored one's own parent, **13** point at a frame that is not inside that parent — and
 * one of them is the login screen's "Запомнить логин и пароль", a FontString the module declares
 * inside an anonymous, sizeless `<Frame>` (`AccountLogin.xml:631`) while anchoring it to the
 * checkbox two branches over. With nothing to measure it degraded to its parent's own edge, and
 * that parent is a 0x0 box at the origin: the label rendered as a sliver in the screen's top-left
 * corner.
 *
 * So both chains are walked and subtracted at their nearest shared offset ancestor. `undefined`
 * when they share none, or when the host has no layout at all (the tests' DOM stub) — the caller's
 * signal to degrade to a parent-edge anchor.
 */
function offsetBetween(target: HTMLElement, parent: HTMLElement): ScaledOffset | undefined {
  // The common case, and the only one a host with partial layout can answer: the target is inside
  // the containing block, so the walk stops there and never touches an ancestor it cannot measure.
  const direct = offsetWithin(target, parent);
  if (direct) return direct;
  const fromTarget = offsetChain(target);
  const fromParent = offsetChain(parent);
  for (const [node, at] of fromTarget) {
    const parentAt = fromParent.get(node);
    if (!parentAt) continue;
    return {
      left: (at.left - parentAt.left) / parentAt.scale,
      top: (at.top - parentAt.top) / parentAt.scale,
      scale: at.scale / parentAt.scale,
    };
  }
  return undefined;
}

/**
 * Whether one of a button's state pictures is the one its current state draws.
 *
 * The rules are 3.3.5's, and each of the two "…if the button has one" clauses matters: a button
 * with no `<DisabledTexture>` keeps showing its normal picture while disabled (only its font
 * changes), and a button with no `<PushedTexture>` keeps showing it while held. HIGHLIGHT is not
 * decided here — see `applyStateTexture`.
 */
export function stateTextureVisible(owner: FrameXmlFrame, state: string): boolean {
  const pushed = owner.buttonState.toUpperCase() === "PUSHED";
  switch (state) {
    case "NORMAL":
      if (!owner.enabled && owner.stateTextures.has("DISABLED")) return false;
      return !(pushed && owner.stateTextures.has("PUSHED"));
    case "PUSHED":
      return pushed;
    case "DISABLED":
      return !owner.enabled;
    case "CHECKED":
      return owner.checked && !(!owner.enabled && owner.stateTextures.has("DISABLEDCHECKED"));
    case "DISABLEDCHECKED":
      return owner.checked && !owner.enabled;
    default:
      // THUMB and anything a later widget type adds: not a state, always drawn.
      return true;
  }
}

/** Percentages of the containing block; a parent anchor needs no measurement. */
const PARENT_ORIGIN = Object.freeze({
  x: Object.freeze({ LEFT: "0%", CENTER: "50%", RIGHT: "100%" }),
  y: Object.freeze({ TOP: "0%", CENTER: "50%", BOTTOM: "100%" }),
});

/** `100%` -> `0%` and `120px` -> `calc(100% - 120px)`, for a right/bottom edge. */
function invert(value: string): string {
  if (value === "0%") return "100%";
  if (value === "100%") return "0%";
  if (value === "50%") return "50%";
  return `calc(100% - ${value})`;
}

function offsetExpression(base: string, offset: number): string {
  if (offset === 0) return base;
  if (base === "0%") return px(offset);
  return `calc(${base} + ${px(offset)})`;
}

/** A CSS family name derived from the WoW font path, stable across reloads. */
export function fontFamilyName(file: string): string {
  const leaf = file.replaceAll("\\", "/").split("/").pop() ?? file;
  return `framexml-${leaf.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
