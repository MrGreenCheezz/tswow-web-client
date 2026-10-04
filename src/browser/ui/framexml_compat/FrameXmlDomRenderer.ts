import {
  FRAME_XML_MODEL_TYPES,
  FRAME_XML_TOOLTIP_LAYOUT,
  type FrameXmlColor,
  type FrameXmlFontStyle,
  type FrameXmlFrame,
  type FrameXmlMessage,
  type FrameXmlRect,
} from "./FrameXmlTypes.js";
import type { FrameXmlUiBridge } from "./FrameXmlRuntime.js";
import { FRAME_XML_EDGE_PIECES, frameXmlTexturePath, type FrameXmlTextureSource } from "./FrameXmlTextures.js";
import { hasFrameXmlEscapes, parseFrameXmlText } from "./FrameXmlText.js";
import { FrameXmlAccessibility, frameXmlAccessibilityCares } from "./FrameXmlAccessibility.js";
import { frameXmlPaintLineFade, frameXmlPaintLineFades } from "./FrameXmlMessageFade.js";
import { frameXmlMessageAlphaReplaced, frameXmlNoteMessageLayout } from "./FrameXmlMessageFade.js"; // L5 3.34
import { frameXmlSimpleHtmlFontKey, frameXmlSimpleHtmlLevelFont } from "./FrameXmlSimpleHtmlFonts.js"; // L5 3.35
import { FRAME_XML_SIMPLE_HTML_LINK_FORMAT, parseFrameXmlSimpleHtml } from "./FrameXmlSimpleHtml.js";
import { buildFrameXmlSimpleHtml, type FrameXmlSimpleHtmlDomHooks } from "./FrameXmlSimpleHtmlDom.js";

/** What one reconciliation pass had to do: see `FrameXmlDomRenderer.syncPass`. */
export type FrameXmlSyncKind = "structural" | "layout" | "paint" | "noop";

/** Where a host collects pass timings (`FrameXmlWorldPerf`); see `FrameXmlDomRendererOptions.perf`. */
export interface FrameXmlRenderPerfSink {
  sync(kind: FrameXmlSyncKind, ms: number): void;
  /** A texture or font arrived and was applied to the frames holding it. */
  picture?(ms: number): void;
}

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
  /** Localized host names for icon controls whose captions live outside the FrameXML tree. */
  readonly accessibilityName?: (frame: FrameXmlFrame) => string | undefined;
  /**
   * What a shown dialog does to the rest of the page (FrameXmlAccessibility.ts). "modal", the
   * default, is the login screens': everything outside the dialog goes inert and it holds the
   * keyboard. A world mount passes "modeless": the client's StaticPopups sit over a live game, so
   * #world-canvas, the native HUD and other windows keep their input and the chat box its focus.
   */
  readonly dialogs?: "modal" | "modeless";
  /**
   * Live counters (`FrameXmlWorldPerf`): each reconciliation pass is reported with what it had to
   * do and how long it took. Two `performance.now()` reads per pass; nothing when absent.
   */
  readonly perf?: FrameXmlRenderPerfSink;
}

interface RenderedFrame {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
  /** Effective hidden state on the last sync, including hidden ancestors. */
  effectiveHidden?: boolean;
  /** `frame.renderVersion` when this frame was last applied; see `syncFrame`. */
  appliedVersion?: number | undefined;
  /** `frame.renderVersion` at which a Cooldown was last found idle; see `tickCooldowns`. */
  cooldownIdleAt?: number | undefined;
  readonly label?: HTMLElement;
  /** A private paint node for a Backdrop's inset background, below every authored region. */
  backdropBackground?: HTMLElement;
  /** A private paint node owning a Backdrop's eight edge layers, below every authored region. */
  backdropEdge?: HTMLElement;
  /** The private node that takes the pointer for a frame with hit-rect insets; see `applyHitRect`. */
  hitRect?: HTMLElement;
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
  /** Last explicit Lua selection request applied to the focused DOM input. */
  editBoxSelectionRevision?: number;
  /** Invisible native control handles drag/keyboard input while the original XML paints the art. */
  readonly sliderInput?: HTMLInputElement;
  /** Clips the ScrollChild alone; stock scrollbar buttons often sit outside the viewport. */
  readonly scrollViewport?: HTMLElement;
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
  /**
   * Last measured ScrollFrame content range published through `OnScrollRangeChanged`.
   * `undefined` before the first laid-out pass; layout-less hosts (the DOM stub) never set it.
   */
  scrollRange?: number;
  horizontalScrollRange?: number;
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
  // The fields below are all set by `createFrame`, so every rendered frame keeps one shape.
  /** The `trap` this frame was last synced with, so a pass can start at it; see `syncContext`. */
  trap: number;
  /** The pass (`#pass`) that last reached this frame. */
  syncedPass: number;
  /** The pass that last re-applied this frame's geometry; see `syncPass`'s paint branch. */
  placedPass: number;
  /** Paint state last applied, so a paint-only change re-applies only what moved; see `applyFrame`. */
  appliedAnimationTransform: string | undefined;
  appliedRotation: number | undefined;
  appliedTexCoords: unknown;
  appliedScale: number | undefined;
  appliedAlpha: number | undefined;
  appliedBackdrop: unknown;
  appliedBackdropColor: unknown;
  appliedBackdropBorderColor: unknown;
  /** A button's drawn state (`stateKey`), which its state-texture children are drawn from. */
  stateKey: string | undefined;
}

/**
 * A strata layer: the box one frame is drawn in when its strata is above every stacking context
 * around it (see `escapesStrata`).
 *
 * The client orders every frame by (strata, level) across the whole screen; the DOM orders a
 * z-index only inside the nearest stacking context, and every FrameXML box is one. So a `TOOLTIP`
 * child of a `LOW` frame used to count its z-index inside that frame only: measured on the rich
 * route, `LFDSearchStatus` (TOOLTIP, LFDFrame.xml:688, a child of `MiniMapLFGFrame` in
 * `MinimapCluster`) painted under `WatchFrame`'s tracker lines, and `GameTooltip` (TOOLTIP, under
 * `UIParent`) under the parentless `DropDownList1` (FULLSCREEN_DIALOG) it describes.
 *
 * The frame's element is appended here instead of into its parent: a container-level box laid over
 * the parent's painted rectangle — same size in the parent's own units, same cumulative scale and
 * opacity, hidden with it — whose z-index is the frame's own. Coordinates, percentages, sibling
 * measurement and hit testing inside it are those of the parent's box. Lua sees nothing:
 * `GetParent`, visibility and geometry are the bridge's, unchanged.
 */
interface StrataLayer {
  readonly element: HTMLElement;
  /** The parent box last written, so an owner that did not move costs no style write. */
  box?: string;
  /** Hidden with a hidden owner or frame; the next visible walk places it again. */
  parked?: boolean;
}

/** One `applyGeometry` held by a pass until its walk is done; see `syncPass`. */
interface DeferredPlacement {
  readonly element: HTMLElement;
  readonly frame: FrameXmlFrame;
  readonly declaredWidth: number | undefined;
  readonly declaredHeight: number | undefined;
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
let nextRendererSerial = 0;

/**
 * How many distinct vertex colours get a filter of their own. The client's colours are 8-bit
 * (`CImVector`), and the stock UI uses a handful — white, 0.4 grey for an unusable action, 0.5/0.5/1
 * for no mana, 1/0.1/0.1 for an unusable item or an unbought bank slot — so this only bounds a
 * script that animates a tint through thousands of values; past it a picture is drawn untinted.
 */
const TINT_FILTER_LIMIT = 4096;

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function px(value: number): string {
  return `${value}px`;
}

/** WoW colours are 0..1 floats; CSS wants 0..255 with the alpha left as a float. */
/** The `shadowColor` attribute `SetShadowColor` writes: four channels in [0, 1], space-separated. */
function shadowColorAttribute(value: string | undefined): FrameXmlColor | undefined {
  if (value === undefined) return undefined;
  const channels = value.split(" ").map(Number);
  if (channels.length !== 4 || !channels.every(Number.isFinite)) return undefined;
  const [r, g, b, a] = channels as [number, number, number, number];
  return { r, g, b, a };
}

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

/**
 * Whether placing a frame reads the laid-out page: an anchor on anything but its parent (measured,
 * `measureSibling`), a clamp to the screen or a cursor anchor (both read client rectangles).
 */
function measuresLayout(frame: FrameXmlFrame): boolean {
  if (frame.clampedToScreen || frame.tooltipCursorAnchor) return true;
  for (const point of frame.points) if (point.relativeTo && point.relativeTo !== frame.parent) return true;
  return false;
}

/** Two anchors on opposite horizontal edges: the width is theirs, not the text's. */
function horizontallyPinned(frame: FrameXmlFrame): boolean {
  let left = false;
  let right = false;
  for (const point of frame.points) {
    const role = anchorRoles(point.point).x;
    if (role === "LEFT") left = true;
    else if (role === "RIGHT") right = true;
  }
  return left && right;
}

/** Two anchors on opposite vertical edges: the height is theirs, not the declared one. */
function verticallyPinned(frame: FrameXmlFrame): boolean {
  let top = false;
  let bottom = false;
  for (const point of frame.points) {
    const role = anchorRoles(point.point).y;
    if (role === "TOP") top = true;
    else if (role === "BOTTOM") bottom = true;
  }
  return top && bottom;
}

/** Horizontal/vertical role of an anchor name, e.g. TOPLEFT -> ("LEFT", "TOP"). */
function anchorRoles(point: string): { readonly x: "LEFT" | "RIGHT" | "CENTER"; readonly y: "TOP" | "BOTTOM" | "CENTER" } {
  const name = point.toUpperCase();
  return {
    x: name.includes("LEFT") ? "LEFT" : name.includes("RIGHT") ? "RIGHT" : "CENTER",
    y: name.includes("TOP") ? "TOP" : name.includes("BOTTOM") ? "BOTTOM" : "CENTER",
  };
}

/**
 * What `applyFontFace` reads of a widget, empty: a SimpleHTML header block is dressed in its header
 * font object alone — the widget's `SetTextColor` and font overrides are its default font's (3.35).
 */
const SIMPLE_HTML_HEADER_FACE = { attributes: {}, textColor: undefined, justifyH: "" } as unknown as FrameXmlFrame;

const LAYER_Z: Readonly<Record<string, number>> = Object.freeze({
  BACKGROUND: 1, BORDER: 2, ARTWORK: 3, OVERLAY: 4, HIGHLIGHT: 5,
});
/** A button's implicit label, in OVERLAY like a template's `<ButtonText>`; see `applyButtonLabel`. */
const BUTTON_LABEL_Z = String(LAYER_Z["OVERLAY"]! * 100);

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
 * How many times one layout pass may place a frame through the anchor graph. A chain settles in
 * one placement per link; the bound only matters for an anchor cycle, which the client refuses and
 * the corpus does not contain, and it keeps a malformed add-on from spinning the pass.
 */
const MAX_PLACEMENTS_PER_PASS = 3;

/** How much of one frame a pass re-applies; see `syncFrame`. */
type ApplyMode = 0 | 1 | 2;
const APPLY_NONE: ApplyMode = 0;
/** Paint only: no geometry, backdrop or subtree unless what they draw from changed. */
const APPLY_PAINT: ApplyMode = 1;
const APPLY_FULL: ApplyMode = 2;

/** What the bridge announced for one frame since the last pass, as a bit mask. */
const CHANGE_PAINT = 1;
const CHANGE_LAYOUT = 2;
const CHANGE_STRUCTURE = 4;

/**
 * Past this many changed frames a pass walks the drawn tree as before instead of starting at each
 * changed frame: the walk costs the same whatever changed, the per-frame route grows with it.
 */
const DIRTY_WALK_LIMIT = 512;

/** What a button's state textures and label are drawn from (`stateTextureVisible`, `applyStateTexture`). */
function stateKey(frame: FrameXmlFrame): string | undefined {
  if (frame.stateTextures.size === 0) return undefined;
  return `${frame.buttonState}|${frame.enabled}|${frame.checked}|${frame.highlightLocked}`;
}

function strataRank(frame: FrameXmlFrame): number {
  return STRATA_Z[frame.frameStrata] ?? 2;
}

/**
 * Whether a child frame draws above every stacking context it would be drawn inside, and so in a
 * strata layer of its own. `trap` is the highest strata among those contexts: its parent and the
 * parent's ancestors up to the container or the nearest strata layer.
 *
 * Regions (textures, font strings) draw in their frame's strata by definition. Frames declare a
 * strata or inherit their parent's (FrameXmlRuntime's build), so a child is above its parent only
 * when something said so: measured on the MPQ vertical, 60 frames, among them `GameTooltip`, the
 * shopping tooltips and `SmallTextTooltip` (TOOLTIP), `StaticPopup1-4` and `GameMenuFrame` (DIALOG),
 * the four extra action bars (HIGH) — all under a MEDIUM `UIParent` — the chat edit boxes (DIALOG
 * under a BACKGROUND chat frame) and `LFDSearchStatus` (TOOLTIP) under the minimap eye.
 *
 * Only above the whole chain, not merely above the parent: `PetFrame` (LOW) is a child of
 * `PlayerFrame` (BACKGROUND) inside `UIParent` (MEDIUM). Lifted to the container it would draw at
 * LOW under *all* of `UIParent`, `PlayerFrame` included; inside `PlayerFrame` it stays above its
 * parent and below `UIParent`'s MEDIUM frames, which is the client's order.
 */
function escapesStrata(child: FrameXmlFrame, trap: number): boolean {
  if (child.type === "Texture" || child.type === "FontString") return false;
  return strataRank(child) > trap;
}

function setAttributeIfChanged(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** An inline style property written only when it reads differently (a long percentage reads back rounded, and is written). */
function setStyleIfChanged(
  element: HTMLElement,
  property: "left" | "top" | "right" | "bottom" | "transform" | "pointerEvents" | "writingMode" | "direction",
  value: string,
): void {
  if (element.style[property] !== value) element.style[property] = value;
}

function indexHolder<T>(index: Map<string, Set<T>>, key: string, holder: T): void {
  let holders = index.get(key);
  if (!holders) index.set(key, (holders = new Set()));
  holders.add(holder);
}

function unindexHolder<T>(index: Map<string, Set<T>>, key: string, holder: T): void {
  const holders = index.get(key);
  if (!holders) return;
  holders.delete(holder);
  if (holders.size === 0) index.delete(key);
}

function hideStrataLayer(layer: StrataLayer): void {
  layer.parked = true;
  if (layer.element.hidden) return;
  layer.element.hidden = true;
  // The page's own `[hidden]` rule may be outranked; the layer carries no other display.
  layer.element.style.display = "none";
}

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
  readonly #accessibility: FrameXmlAccessibility;
  readonly #dialogs: "modal" | "modeless";
  readonly #textureResolver: ((texture: string) => string) | undefined;
  readonly #fontResolver: ((font: string) => string) | undefined;
  readonly #classPrefix: string;
  readonly #bridge: FrameXmlUiBridge | undefined;
  readonly #rendered = new Map<FrameXmlFrame, RenderedFrame>();
  /** The frame an element draws, for the drop target under a released drag (`receiveDrag`). */
  readonly #frameOfElement = new WeakMap<Element, FrameXmlFrame>();
  /** The held thing's picture following the pointer (`setCursorPicture`), while one is held. */
  #cursorPicture: { element: HTMLImageElement; path: string; cleanup: () => void } | undefined;
  readonly #measuringHiddenGeometry = new Set<FrameXmlFrame>();
  /** Hidden frames whose geometry this sync pass already refreshed; see `refreshHiddenGeometry`. */
  #hiddenRefreshed: Set<FrameXmlFrame> | undefined;
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
  /**
   * Message frames with a drawn line whose alpha can still change (3.34), and how far `tickMessageFades`
   * got: the clock, line timing and lines it last drew, the first line not yet cleared, and the clock
   * at which a line next changes. Kept beside the rendered frame so it keeps its shape.
   */
  readonly #messageFades = new Map<RenderedFrame, {
    clock: number; fadeRevision: number; revision: number; from: number; next: number;
  }>();
  /** SimpleHTML widgets drawn so far (3.35): their private block layer and what it was built from. */
  readonly #simpleHtml = new Map<RenderedFrame, { readonly layer: HTMLElement; key: string | undefined }>();
  /**
   * The widgets the layout pass lays out by type, indexed at creation so a layout sync does not scan
   * all ~15,500 rendered frames of the world vertical three times to find a dozen of them.
   */
  readonly #tooltips = new Set<RenderedFrame>();
  readonly #scrollFrames = new Set<RenderedFrame>();
  readonly #sliders = new Set<RenderedFrame>();
  /** The rendered frames the accessibility pass labels or checks for a modal, in creation order. */
  readonly #a11yNodes = new Map<FrameXmlFrame, RenderedFrame>();
  /**
   * Anchor target → the frames anchored to it from outside their own parent's box (the anchors
   * the layout pass has to measure). With `#anchorTargets`, its inverse, maintained by every
   * `applyGeometry`; see `replaceDependents`.
   */
  readonly #dependents = new Map<FrameXmlFrame, Set<FrameXmlFrame>>();
  readonly #anchorTargets = new Map<FrameXmlFrame, readonly FrameXmlFrame[]>();
  /**
   * Drawn frames last measured against a hidden target. A hidden target is measured from its inline
   * geometry and does not take part in a sync, so nothing announces that its parent moved; these few
   * are re-placed on every layout pass instead (the LFD list's 15 check boxes, centred on hidden lock
   * icons, while the finder is open).
   */
  readonly #hiddenAnchored = new Set<FrameXmlFrame>();
  /** Frames drawn above the strata of every stacking context around them, and their layers. */
  readonly #strataLayers = new Map<FrameXmlFrame, StrataLayer>();
  /**
   * Texture-source path → the rendered frames holding it in one of their picture slots, and edge
   * file → the frames holding its eight pieces; see `pictureArrived`.
   */
  readonly #pictureHolders = new Map<string, Set<RenderedFrame>>();
  readonly #edgeHolders = new Map<string, Set<RenderedFrame>>();
  readonly #clock: () => number;
  readonly #perf: FrameXmlRenderPerfSink | undefined;
  #fontStyleElement: HTMLStyleElement | undefined;
  #textMeasureContext: CanvasRenderingContext2D | null | undefined;
  #addFilterElement: Element | undefined;
  /** This renderer's own tint filters (`tintFilterId`), keyed by `rrggbb`, and the SVG holding them. */
  readonly #tintFilters = new Map<string, string>();
  #tintFilterElement: Element | undefined;
  readonly #serial = nextRendererSerial++;
  #lastMutationVersion = -1;
  /** The bridge's structure/layout versions at the last sync; -1 forces a full pass. */
  #lastStructureVersion = -1;
  #lastLayoutVersion = -1;
  /** Frames re-applied by the sync in progress, for the paint-only follow-up passes. */
  #appliedThisPass: RenderedFrame[] | undefined;
  /** Frames whose geometry the sync in progress re-applied: the layout pass's anchor seeds. */
  #movedThisPass: RenderedFrame[] | undefined;
  /**
   * Placements that read the page (`measuresLayout`), held while a pass walks the tree and made
   * once the walk's writes are done; see `syncPass`.
   */
  #deferredPlacements: DeferredPlacement[] | undefined;
  /**
   * Message frames whose scroll offset the pass in progress has to map to pixels, held with the
   * placements above: the mapping reads the layer's height; see `scrollMessageLayer`.
   */
  #messageScrolls: RenderedFrame[] | undefined;
  /**
   * Frames the bridge announced a change to since the last pass, with the kinds of change
   * (`CHANGE_*`); drained by each pass into `#passDirty`. See `dirtyWalk`.
   */
  #dirty = new Map<FrameXmlFrame, number>();
  #passDirty: ReadonlyMap<FrameXmlFrame, number> | undefined;
  /** Serial of the pass in progress; see `RenderedFrame.syncedPass`. */
  #pass = 0;
  /** The pass in progress moved, resized, showed or hid a drawn frame. */
  #passLayout = false;
  readonly #unobserveFrames: (() => void) | undefined;
  #drag: FrameDrag | undefined;
  /** L1-review: the releases that ended a started drag; they click nothing (finishDrag, registeredClick). */
  readonly #dragReleases = new WeakSet<Event>();
  #cursor: { readonly x: number; readonly y: number } | undefined;
  #cursorCleanup: (() => void) | undefined;
  /** Buttons under the pointer, for the `<HighlightFont>` their inheriting label switches to. */
  readonly #hoveredButtons = new Set<FrameXmlFrame>();
  /**
   * Screen rectangles `IsMouseOver` has read since the last paint; `null` records "not drawn".
   * Cleared by every sync that actually runs, by a window resize and by cursor-tooltip moves, the
   * only things that move a drawn box.
   */
  readonly #screenRects = new Map<FrameXmlFrame, FrameXmlRect | null>();
  /** The window-level pointer tracker and resize listener, released by `destroy`. */
  #pointerCleanup: (() => void) | undefined;
  /** See `setPointerTracking`. */
  #pointerPaused = false;
  /** Set by `destroy`: nothing re-arms a listener afterwards. */
  #destroyed = false;
  /** The container's resize observer, released by `destroy`; see `watchContainer`. */
  #containerCleanup: (() => void) | undefined;

  constructor(container: HTMLElement, options: FrameXmlDomRendererOptions = {}) {
    this.#container = container;
    this.#dialogs = options.dialogs ?? "modal";
    this.#accessibility = new FrameXmlAccessibility(container, {
      ...(options.accessibilityName ? { nameForFrame: options.accessibilityName } : {}),
      dialogs: this.#dialogs,
    });
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
    this.#perf = options.perf;
    this.#unobserveFrames = options.bridge?.observeFrameMutations((frame, kind) => {
      const bit = kind === "paint" ? CHANGE_PAINT : kind === "layout" ? CHANGE_LAYOUT : CHANGE_STRUCTURE;
      this.#dirty.set(frame, (this.#dirty.get(frame) ?? 0) | bit);
    });
    this.#unsubscribe = options.bridge?.subscribe(() => this.sync());
    options.bridge?.setTextMeasure((frame, text) => this.measureText(frame, text));
    options.bridge?.setScreenRectSource((frame) => this.screenRectOf(frame));
    this.trackPointer();
    this.watchContainer();
  }

  /**
   * Follow the container's own box: a browser resize, or a UI-scale change, gives the stage a new
   * logical width (the world mount's and the glue's `fit`) without a single Lua mutation, so no sync
   * runs and nothing in the frame tree is re-applied.
   *
   * Most of the screen follows by itself — a parent anchor is CSS of its containing block — but two
   * kinds of box are numbers written from a measurement and would stay where they were:
   *
   * - strata layers, which copy their owner's box in layout pixels (`placeStrataLayer`). Measured on
   *   the rich route after resizing 1400 → 2400 wide: `MultiBarBottomLeft`'s and `UIErrorsFrame`'s
   *   layers stayed 1400 wide over a 2400-wide `UIParent`, and the bar stayed at x=97 while
   *   `MainMenuBar` moved to 588;
   * - sibling anchors, measured in pixels from the containing block (`measureSibling`), whose target
   *   moved with a centred or right-anchored parent edge — the same bar, anchored to `ActionButton1`.
   *
   * A `ResizeObserver` rather than the window's `resize` event: it is delivered after layout, so the
   * stage's new width is already the one measured, whichever of the page's listeners ran first; and
   * it also sees the settings' UI-scale change, which resizes no window. A transform-only change (the
   * same aspect at another size) does not change the logical box and costs nothing.
   */
  private watchContainer(): void {
    const view = this.#container.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined;
    const Observer = view?.ResizeObserver;
    if (typeof Observer !== "function") return;
    const sizeOf = (): string => `${this.#container.offsetWidth}x${this.#container.offsetHeight}`;
    // The observer reports the initial box once; only a box other than the one laid out counts.
    let size = sizeOf();
    const observer = new Observer(() => {
      const now = sizeOf();
      if (now === size) return;
      size = now;
      this.containerResized();
    });
    observer.observe(this.#container);
    this.#containerCleanup = () => observer.disconnect();
  }

  /**
   * Place again everything measured from the container's old box: every drawn strata layer (outer
   * owners first, as the walk reaches them), every drawn frame with a measured anchor that the new
   * box can have moved (`resizeInvariant`), every drawn frame clamped to the screen, and then —
   * through the reverse anchor index — the dependents of whatever that moved. The walk covers the
   * drawn tree once (O(drawn frames), on a resize only); a hidden subtree is placed when it is next
   * shown, which re-applies it.
   *
   * It used to place every measured frame and every dependent of every drawn frame: measured on the
   * rich route, 163 placements per observed resize, 3 of which moved anything, 3.6–4.7 ms a resize —
   * once per frame of a window drag.
   */
  private containerResized(): void {
    this.#screenRects.clear();
    if (this.#strataLayers.size === 0 && this.#anchorTargets.size === 0) return;
    const run = (): void => {
      const queue: FrameXmlFrame[] = [];
      const place = this.boundedPlacer();
      const fixed = new Map<Element, boolean>();
      for (const root of this.topLevel()) {
        if (this.#frameFilter && !this.#frameFilter(root)) continue;
        if (root.parent && this.#rendered.has(root.parent)) continue;
        const drawn = this.#rendered.get(root);
        if (!drawn || drawn.effectiveHidden !== false) continue;
        if (this.#anchorTargets.has(root)) {
          if (place(root)) this.queueMoved(root, queue);
        } else if (root.clampedToScreen) this.clampToScreen(drawn.element, root);
        this.resizeWalk(root, queue, place, fixed);
      }
      this.drainDependents(queue, place);
    };
    // The same per-pass memo a sync has: a measured frame behind a hidden anchor chain refreshes
    // that chain once, not once per path through it (see `refreshHiddenGeometry`).
    const outer = this.#hiddenRefreshed;
    this.#hiddenRefreshed = new Set();
    try {
      // Placed against a page that shows every change already made (`settleDeferredLayout`).
      this.#bridge?.settleDeferredLayout();
      if (this.#bridge) this.#bridge.runInRenderPass(run);
      else run();
    } finally {
      this.#hiddenRefreshed = outer;
    }
  }

  /**
   * Keep `GetCursorPosition`/`IsMouseOver`'s cursor current wherever the pointer is.
   *
   * The bridge only heard of the pointer when it entered a widget or pressed one, so leaving a
   * chat window for the world canvas left the cursor inside the chat window and the stock fade
   * (`FCF_OnUpdate` asking `chatFrame:IsMouseOver(…)`) could never see it go. On the window, not the
   * document, so it reaches the pointer over the 3D canvas too; Chrome delivers `pointermove` once
   * per animation frame, so this is one container rectangle read per frame of movement.
   */
  private trackPointer(): void {
    const view = this.#container.ownerDocument?.defaultView;
    if (!this.#bridge || typeof view?.addEventListener !== "function") return;
    const move = (event: Event): void => this.rememberCursor(event);
    const resize = (): void => this.#screenRects.clear();
    view.addEventListener("pointermove", move, { capture: true, passive: true });
    view.addEventListener("resize", resize);
    this.#pointerCleanup = () => {
      view.removeEventListener("pointermove", move, { capture: true });
      view.removeEventListener("resize", resize);
    };
  }

  /**
   * Stop or resume following the pointer, for a page taken off the display without being torn down.
   *
   * The glue screens are the case (`Bootstrap.ts`'s `suspend`): they stay mounted under the world so
   * the way back costs no reload, and their window-level `pointermove` listener stayed with them —
   * `rememberCursor` reads the hidden container's rectangle and offset box on every move over the
   * world, one forced layout per frame of mouse movement in the middle of the world's frame. Paused,
   * no window listener is left (the cursor tooltip's document listener included, and the next layout
   * pass does not bring it back); resumed, the listeners return and the boxes `IsMouseOver` kept are
   * dropped, because the window may have changed size in between. The next move reports the cursor.
   */
  setPointerTracking(active: boolean): void {
    if (active === !this.#pointerPaused || this.#destroyed) return;
    this.#pointerPaused = !active;
    if (!active) {
      this.#pointerCleanup?.();
      this.#pointerCleanup = undefined;
      this.#cursorCleanup?.();
      this.#cursorCleanup = undefined;
      return;
    }
    this.#screenRects.clear();
    this.trackPointer();
    this.syncCursorTracking();
  }

  /** Replace the mounted roots. The container itself is never cleared. */
  mount(roots: readonly FrameXmlFrame[]): void {
    this.finishDrag(false);
    this.#accessibility.destroy();
    for (const rendered of this.#rendered.values()) this.dropRendered(rendered);
    this.#rendered.clear();
    this.#roots.splice(0, this.#roots.length, ...roots);
    this.#lastMutationVersion = -1;
    this.#lastStructureVersion = -1;
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
    this.#lastStructureVersion = -1;
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
    // Range callbacks mutate sliders and other frames. Publish them after the whole layout pass,
    // otherwise each ScrollFrame synchronously starts another full traversal before the next
    // scroll range is measured (N scroll frames would build N nested renderer stacks). A render
    // pass as well, so a geometry read in the walk cannot start the next pass inside this one.
    if (this.#bridge) this.#bridge.runInRenderPass(() => this.measuredPass());
    else this.measuredPass();
  }

  /** One `syncPass` with a per-pass measurement memo of its own (a nested pass follows new state). */
  private measuredPass(): void {
    const outer = this.#hiddenRefreshed;
    this.#hiddenRefreshed = new Set();
    const perf = this.#perf;
    const kind = perf ? this.pendingKind() : "noop";
    const started = perf ? performance.now() : 0;
    try {
      this.syncPass();
    } finally {
      this.#hiddenRefreshed = outer;
      perf?.sync(kind, performance.now() - started);
    }
  }

  /** What the next pass has to do, from the bridge's versions (the same test `syncPass` makes). */
  private pendingKind(): FrameXmlSyncKind {
    const bridge = this.#bridge;
    if (!bridge) return "structural";
    if (this.#lastMutationVersion === bridge.mutationVersion) return "noop";
    if (this.#lastStructureVersion !== bridge.structureVersion) return "structural";
    return this.#lastLayoutVersion !== bridge.layoutVersion ? "layout" : "paint";
  }

  private syncPass(): void {
    const bridge = this.#bridge;
    if (bridge && this.#lastMutationVersion === bridge.mutationVersion) return;
    if (this.#drag && !bridge?.isVisible(this.#drag.source)) this.finishDrag(true);
    // Most syncs carry a handful of named changes — a pulsing highlight's alpha, a health bar's
    // fill — and the whole tree used to be re-applied and re-measured for each of them: measured
    // on the dev page, 24 ms of a 35 ms idle frame. Only a change to the tree itself can add, move
    // or drop a widget (`structural`), and only a layout change can move what another frame is
    // measured against (`layout`); everything else is applied to the frames it names.
    const structural = !bridge || this.#lastStructureVersion !== bridge.structureVersion;
    let layout = structural || this.#lastLayoutVersion !== bridge.layoutVersion;
    // A change to the tree can move any box; the boxes `IsMouseOver` cached go before the walk.
    if (structural) this.#screenRects.clear();
    const dirty = this.#dirty;
    this.#dirty = new Map();
    this.#passDirty = dirty;
    this.#pass += 1;
    this.#passLayout = false;
    const active = structural ? new Set<FrameXmlFrame>() : undefined;
    const applied: RenderedFrame[] = [];
    const moved: RenderedFrame[] = [];
    this.#appliedThisPass = applied;
    this.#movedThisPass = moved;
    // A measured placement made in the middle of the walk forces the browser to lay out every write
    // made before it: measured on the first CharacterFrame open, 155 sibling measures at 0.1 ms each,
    // 130 of which placed the frame exactly where it already was. They are made after the walk.
    const deferred: DeferredPlacement[] = [];
    this.#deferredPlacements = deferred;
    const messageScrolls: RenderedFrame[] = [];
    this.#messageScrolls = messageScrolls;
    let hiddenMoved: readonly FrameXmlFrame[] = [];
    try {
      const walked = structural ? undefined : this.dirtyWalk(dirty);
      if (walked) {
        // Only what was drawn before or after the pass decides whether it is a layout pass: a
        // hidden frame shown and hidden again within one frame (the party member's dispel flash,
        // `PartyMemberFrame_OnUpdate`, every frame once its countdown ends) moved nothing drawn.
        layout = this.#passLayout;
        hiddenMoved = walked.hiddenMoved;
      } else {
        // The mounted roots first, so the frame `createdRootParent` names has an element to adopt
        // into by the time the parentless Lua frames are reached.
        for (const root of this.#roots) {
          if (this.#frameFilter && !this.#frameFilter(root)) continue;
          // A root Lua has since given a drawn parent is that parent's child now, and the parent's
          // walk places it. Synced as a root as well, it went back to the container on every pass
          // and the parent's walk took it back again: measured on framexml.html, `ChatFrame1Tab`
          // (docked into `GeneralDockManager` by `FCF_DockFrame`) moved 1,092 times in 2 s of idle,
          // two DOM moves per sync. A root whose parent is not drawn here (filtered out, or never
          // mounted) stays one.
          if (root.parent && this.#rendered.has(root.parent)) continue;
          this.syncFrame(root, this.#container, active, false, structural);
        }
        const created = this.#includeCreatedRoots ? this.#bridge?.createdRoots ?? [] : [];
        if (created.length > 0) {
          const adopted = this.createdRootHost();
          const mounted = new Set(this.#roots);
          for (const root of created) {
            if (mounted.has(root)) continue;
            if (this.#frameFilter && !this.#frameFilter(root)) continue;
            this.syncFrame(root, adopted, active, false, structural);
          }
        }
      }
    } finally {
      this.#appliedThisPass = undefined;
      this.#movedThisPass = undefined;
      this.#passDirty = undefined;
      this.#deferredPlacements = undefined;
      this.#messageScrolls = undefined;
    }
    if (active) {
      for (const [frame, rendered] of this.#rendered) {
        if (!active.has(frame)) {
          this.dropRendered(rendered);
          this.#rendered.delete(frame);
        }
      }
    }
    // In walk order, after every write of the walk: a placement that changes nothing leaves the
    // page clean for the next one's measure.
    let layered: ReadonlySet<FrameXmlFrame> | undefined;
    for (const placement of deferred) {
      if (this.#rendered.get(placement.frame)?.element !== placement.element) continue;
      if (!this.applyGeometry(placement.element, placement.frame, placement.declaredWidth, placement.declaredHeight)) continue;
      // The walk laid the strata layers over this frame, and over whatever is drawn inside it, while
      // it still had its old box: `childElementHost` places a layer as soon as its owner is
      // re-applied, and this placement was held until now. Measured on the rich route, the open
      // chat input (`ChatFrame1EditBox`, DIALOG) stayed where a moved chat frame had been. Laid
      // again here, before the placements after this one in walk order — the frames inside those
      // layers among them — measure anything.
      if (this.#strataLayers.size === 0) continue;
      layered ??= this.layeredFrames();
      if (layered.has(placement.frame)) this.placeLayersBelow(placement.frame, layered);
    }
    for (const rendered of messageScrolls) {
      if (this.#rendered.get(rendered.frame) === rendered) this.scrollMessageLayer(rendered);
    }
    if (!layout) {
      // Paint only: nothing drawn moved, so nothing is re-measured. A frame whose geometry was
      // re-applied anyway (a transform: an animation, a rotation, a mirrored texcoord) takes back
      // the layouts other passes own for it — tooltip rows, scroll ranges, slider inputs.
      // A hidden frame that moved can still be what a drawn frame is measured against.
      const replaced = hiddenMoved.length > 0 && this.#hiddenAnchored.size > 0
        && this.replaceHiddenAnchored(new Set(hiddenMoved));
      const tooltips = new Set<RenderedFrame>();
      for (const rendered of applied) {
        if (rendered.effectiveHidden) continue;
        const frame = rendered.frame;
        if (rendered.placedPass === this.#pass) {
          const owner = frame.type === "GameTooltip" ? rendered
            : frame.parent?.type === "GameTooltip" ? this.#rendered.get(frame.parent) : undefined;
          if (owner && !owner.effectiveHidden) tooltips.add(owner);
        }
        if (frame.type === "ScrollFrame") this.applyScrollFrame(rendered);
        if (frame.type === "Slider") this.applySlider(rendered);
      }
      for (const tooltip of tooltips) this.layoutGameTooltip(tooltip);
      // `IsMouseOver`'s boxes stay valid across a pass that moved nothing: the chat fade's three
      // questions a frame read the layout once, not after every alpha flash.
      if (moved.length > 0 || replaced) this.#screenRects.clear();
      this.commitVersions();
      return;
    }
    // A sibling may be declared after the frame that points to it, and a target may move or resize
    // after its dependents were placed (ChatFrame1Tab auto-sizing to its label after ChatFrame2Tab
    // was put at its RIGHT). Everything anchored to a frame this pass re-applied is placed again,
    // and whatever is anchored to *those*, through the reverse index — not every sibling-anchored
    // frame on the screen: measured on the dev page, that loop was 88–123 re-applies and 101–128
    // sibling measures (3.9 ms of a 7–11 ms health-text sync) whatever had changed.
    // A hidden target has no browser layout rectangle (`display:none` makes all
    // offset* metrics zero). `measureSibling` falls back to the authored inline
    // geometry for that target and its hidden ancestors; no hidden frame
    // needs to be shown or reconciled during this pass.
    this.replaceDependents(moved);
    // Tooltip paragraphs must be laid out after their FontStrings and sibling anchors. Their
    // rendered height can exceed the C-method's pre-DOM estimate by several wrapped lines.
    for (const rendered of this.#tooltips) {
      if (!rendered.effectiveHidden) this.layoutGameTooltip(rendered);
    }
    // ScrollFrame viewports clip after every child has been laid out, so the measured content
    // range observes the same pass. Firing here keeps stock scrollbar Lua (which only listens to
    // `OnScrollRangeChanged`) working without the renderer guessing at slider state.
    for (const rendered of this.#scrollFrames) {
      if (!rendered.effectiveHidden) this.applyScrollFrame(rendered);
    }
    // Scroll-range handlers can change slider values during this same pass.
    for (const rendered of this.#sliders) {
      if (!rendered.effectiveHidden) this.applySlider(rendered);
    }
    this.syncCursorTracking();
    this.#accessibility.sync(this.#rendered, this.#a11yNodes.values());
    this.#screenRects.clear();
    this.commitVersions();
  }

  private commitVersions(): void {
    const bridge = this.#bridge;
    if (!bridge) return;
    this.#lastMutationVersion = bridge.mutationVersion;
    this.#lastStructureVersion = bridge.structureVersion;
    this.#lastLayoutVersion = bridge.layoutVersion;
  }

  /**
   * A non-structural pass that starts at the frames the bridge named (`observeFrameMutations`)
   * instead of walking the whole drawn tree to find them: measured on the rich route, the walk
   * visited 769 frames and 721 child hosts to re-apply the 3–7 that an idle frame changes.
   *
   * Changed frames are reconciled outermost first, each from where its parent draws it, with the
   * same `syncFrame` as the walk; a frame an ancestor's pass already reached is not visited twice.
   * A frame's subtree is walked only when it has to be — a reveal, a change that moves or resizes
   * it, or a button state its state textures are drawn from — so a paint change stays on its
   * frame. `undefined` (the caller walks the tree as before) when a host filter decides what is
   * drawn, when a changed frame is not where the last walk left it, or when so many frames changed
   * that the walk is as cheap.
   */
  private dirtyWalk(dirty: ReadonlyMap<FrameXmlFrame, number>): { readonly hiddenMoved: readonly FrameXmlFrame[] } | undefined {
    if (!this.#bridge || this.#frameFilter || this.#layoutOnly || dirty.size > DIRTY_WALK_LIMIT) return undefined;
    const entries: { frame: FrameXmlFrame; rendered: RenderedFrame; depth: number; kinds: number; wasHidden: boolean }[] = [];
    for (const [frame, kinds] of dirty) {
      const rendered = this.#rendered.get(frame);
      // Not drawn by this renderer (an unmounted root's subtree): the walk would not reach it either.
      if (!rendered) continue;
      if (rendered.effectiveHidden === undefined || !this.syncContext(frame, rendered, false)) return undefined;
      let depth = 0;
      for (let at = frame.parent; at && depth < 64; at = at.parent) depth += 1;
      entries.push({ frame, rendered, depth, kinds, wasHidden: rendered.effectiveHidden });
    }
    entries.sort((left, right) => left.depth - right.depth);
    for (const entry of entries) {
      if (entry.rendered.syncedPass === this.#pass) continue;
      const context = this.syncContext(entry.frame, entry.rendered, true);
      if (!context) continue;
      this.syncFrame(entry.frame, context.parent, undefined, context.ancestorHidden, false, APPLY_NONE, context.trap, true);
    }
    const hiddenMoved: FrameXmlFrame[] = [];
    for (const entry of entries) {
      if ((entry.kinds & ~CHANGE_PAINT) === 0) continue;
      if (entry.wasHidden && entry.rendered.effectiveHidden) hiddenMoved.push(entry.frame);
      else this.#passLayout = true;
    }
    return { hiddenMoved };
  }

  /**
   * A layout change to hidden frames only: place again the drawn frames measured against a hidden
   * target (`#hiddenAnchored`) that one of `moved` can have moved — the target itself, a hidden
   * ancestor whose box it resolves against, or a hidden frame it is anchored to, transitively.
   * Answers whether anything was placed.
   */
  private replaceHiddenAnchored(moved: ReadonlySet<FrameXmlFrame>): boolean {
    const place = this.boundedPlacer();
    const queue: FrameXmlFrame[] = [];
    let placed = false;
    for (const frame of [...this.#hiddenAnchored]) {
      const seen = new Set<FrameXmlFrame>();
      if (!(this.#anchorTargets.get(frame) ?? []).some((target) => this.hiddenBoxFollows(target, moved, seen, 0))) continue;
      placed = true;
      if (place(frame)) this.collectMoved(frame, queue, place);
    }
    this.drainDependents(queue, place);
    return placed;
  }

  /** Whether a hidden target's authored box (`offsetMetrics`) can follow one of `moved`. */
  private hiddenBoxFollows(target: FrameXmlFrame, moved: ReadonlySet<FrameXmlFrame>, seen: Set<FrameXmlFrame>, depth: number): boolean {
    if (depth > 16) return true;
    for (let at: FrameXmlFrame | undefined = target, up = 0; at && up < 64; at = at.parent, up += 1) {
      if (seen.has(at)) return false;
      seen.add(at);
      if (moved.has(at)) return true;
      // A drawn ancestor's box is the browser's; had it moved, this would be a layout pass.
      if (this.#rendered.get(at)?.effectiveHidden === false) break;
      for (const next of this.#anchorTargets.get(at) ?? []) {
        if (this.hiddenBoxFollows(next, moved, seen, depth + 1)) return true;
      }
    }
    return false;
  }

  /**
   * Where the last walk drew one frame: its parent's host element for it, whether an ancestor
   * hides it, and the strata trap it is drawn under. `place` also resolves the host the way the
   * parent's walk does (`childElementHost`, which places a strata layer that was never placed);
   * without it this only answers whether the frame can be located.
   */
  private syncContext(frame: FrameXmlFrame, rendered: RenderedFrame, place: boolean):
  { readonly parent: HTMLElement; readonly ancestorHidden: boolean; readonly trap: number } | undefined {
    const parent = frame.parent;
    const parentRendered = parent ? this.#rendered.get(parent) : undefined;
    if (parent && parentRendered) {
      if (parentRendered.children.get(frame) !== rendered || parentRendered.effectiveHidden === undefined) return undefined;
      const ancestorHidden = parentRendered.effectiveHidden;
      const inner = Math.max(parentRendered.trap ?? -1, strataRank(parent));
      if (!place) return { parent: parentRendered.element, ancestorHidden, trap: inner };
      const host = this.childElementHost(parentRendered, frame, ancestorHidden, false, inner);
      const escaped = host !== parentRendered.element && host !== parentRendered.scrollViewport;
      return { parent: host, ancestorHidden, trap: escaped ? -1 : inner };
    }
    if (this.#roots.includes(frame)) return { parent: this.#container, ancestorHidden: false, trap: -1 };
    if (!parent && this.#includeCreatedRoots && this.#bridge?.createdRoots.includes(frame)) {
      return { parent: place ? this.createdRootHost() : this.#container, ancestorHidden: false, trap: -1 };
    }
    return undefined;
  }

  /** The kinds of change announced for one frame, including any made while this pass runs. */
  private changeKinds(frame: FrameXmlFrame): number {
    return (this.#passDirty?.get(frame) ?? 0) | (this.#dirty.get(frame) ?? 0);
  }

  /** Take an element off the page and give back every picture it was holding. */
  private dropRendered(rendered: RenderedFrame): void {
    if (this.#drag?.source === rendered.frame || this.#drag?.moving === rendered.frame) this.finishDrag(false);
    rendered.element.remove();
    rendered.backdropFilters?.svg.remove();
    rendered.backdropFilters = undefined;
    this.#cooldowns.delete(rendered);
    this.#messageFades.delete(rendered);
    this.#simpleHtml.delete(rendered);
    this.#tooltips.delete(rendered);
    this.#scrollFrames.delete(rendered);
    this.#sliders.delete(rendered);
    this.#a11yNodes.delete(rendered.frame);
    this.indexAnchors(rendered.frame, undefined);
    this.#hiddenAnchored.delete(rendered.frame);
    this.dropStrataLayer(rendered.frame);
    if (!this.#textures) return;
    for (const path of rendered.pictures.values()) {
      this.#textures.release(path);
      unindexHolder(this.#pictureHolders, path, rendered);
    }
    rendered.pictures.clear();
    if (rendered.edge) {
      this.#textures.releaseEdge(rendered.edge);
      unindexHolder(this.#edgeHolders, rendered.edge, rendered);
      rendered.edge = undefined;
    }
  }

  /** Remove the renderer's nodes and stop observing bridge mutations. */
  destroy(): void {
    this.#destroyed = true;
    this.#unsubscribe?.();
    this.#unobserveFrames?.();
    this.#dirty.clear();
    this.#accessibility.destroy();
    this.#bridge?.setTextMeasure(undefined);
    this.#bridge?.setScreenRectSource(undefined);
    this.#textMeasureContext = undefined;
    this.finishDrag(false);
    this.setCursorPicture(undefined);
    this.#cursorCleanup?.();
    this.#cursorCleanup = undefined;
    this.#pointerCleanup?.();
    this.#pointerCleanup = undefined;
    this.#containerCleanup?.();
    this.#containerCleanup = undefined;
    this.#hoveredButtons.clear();
    this.#screenRects.clear();
    this.#cursor = undefined;
    this.#bridge?.setMousePosition(0, 0);
    for (const rendered of this.#rendered.values()) this.dropRendered(rendered);
    this.#rendered.clear();
    this.#roots.splice(0, this.#roots.length);
    this.#lastMutationVersion = -1;
    this.#lastStructureVersion = -1;
    this.#fontStyleElement?.remove();
    this.#fontStyleElement = undefined;
    this.#addFilterElement?.remove();
    this.#addFilterElement = undefined;
    this.#tintFilterElement?.remove();
    this.#tintFilterElement = undefined;
    this.#tintFilters.clear();
    this.#registeredFonts.clear();
  }

  /**
   * The filter that multiplies a picture by its vertex colour, or `undefined` for white.
   *
   * `SetVertexColor` on a textured region is a multiply in the client — every texel's RGB times the
   * colour, its alpha times the colour's alpha — and stock uses it as state: `UpdateBagSlotStatus`
   * turns an unbought bank bag slot red with `SetItemButtonTextureVertexColor(1, 0.1, 0.1)`
   * (BankFrame.lua:124), `ActionButton_UpdateUsable` greys an unusable action to 0.4 and blues an
   * unaffordable one. The renderer used to keep the colour as an unused CSS variable, so all of them
   * drew as plain pictures. `feColorMatrix` scales the three channels exactly (in sRGB, as the
   * client's bytes are multiplied, not in the SVG default linearRGB); the alpha stays on `opacity`.
   * One filter per 8-bit colour, shared by every picture of this renderer that wears it.
   */
  private tintFilterId(color: FrameXmlColor): string | undefined {
    const channel = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
    const r = channel(color.r);
    const g = channel(color.g);
    const b = channel(color.b);
    if (r === 255 && g === 255 && b === 255) return undefined;
    const key = ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
    const known = this.#tintFilters.get(key);
    if (known !== undefined) return known;
    if (this.#tintFilters.size >= TINT_FILTER_LIMIT) return undefined;
    const document = this.#container.ownerDocument;
    if (!document || typeof document.createElementNS !== "function") return undefined;
    let svg = this.#tintFilterElement;
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
      svg.setAttribute("data-framexml-tint-filters", "true");
      this.#container.append(svg);
      this.#tintFilterElement = svg;
    }
    const id = `${this.#classPrefix}-tint-${this.#serial}-${key}`;
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const matrix = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", `${r / 255} 0 0 0 0 0 ${g / 255} 0 0 0 0 0 ${b / 255} 0 0 0 0 0 1 0`);
    filter.append(matrix);
    svg.append(filter);
    this.#tintFilters.set(key, id);
    return id;
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

  /** The `dialogs` option this renderer was built with. */
  get dialogs(): "modal" | "modeless" {
    return this.#dialogs;
  }

  /**
   * The element one widget is currently drawn as, if it is drawn at all.
   *
   * The seam the 3D layer hangs off: a Model widget's canvas belongs *inside* its own box, so the
   * host needs the box, and only the renderer knows which element that is.
   */
  elementFor(frame: FrameXmlFrame): HTMLElement | undefined {
    // A host reading the page gets it current: held layout even from inside a batch (a Lua call
    // that asks the host for a portrait box), and outside one the paint held for the frame step.
    this.#bridge?.settleDeferredLayout();
    if (this.#bridge?.paintDeferred) this.#bridge.flushDeferredPaint();
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
    // The bridge settles before it asks (`sizeOf`); a host asking directly gets the same page.
    this.#bridge?.settleDeferredLayout(frame);
    const rendered = this.#rendered.get(frame);
    const element = rendered?.element;
    if (!rendered || !element || typeof element.offsetWidth !== "number") return undefined;
    // A string sized by its text, asked between its `SetText` and the next paint, would answer the
    // width of the text the page still shows. Width 0 hands the question to the bridge, whose text
    // measure reads the new string in its own font: measured on the stock chat box, «Шепнуть Bob:»
    // answered the previous header's 49 while `GetStringWidth` was already right, and
    // `ChatEdit_UpdateHeader`'s `SetTextInsets(15 + header:GetWidth(), …)` put the text over it.
    if (frame.type === "FontString" && this.textPending(rendered) && !horizontallyPinned(frame)) {
      return { width: 0, height: element.offsetHeight };
    }
    return { width: element.offsetWidth, height: element.offsetHeight };
  }

  /** Whether a FontString's text or font changed since it was last painted. */
  private textPending(rendered: RenderedFrame): boolean {
    const { frame, element } = rendered;
    const font = this.drawnFontObject(frame);
    if (font && element.getAttribute("data-framexml-font") !== font) return true;
    return hasFrameXmlEscapes(frame.text) ? rendered.textSource !== frame.text : element.textContent !== frame.text;
  }

  private measureText(frame: FrameXmlFrame, text: string): number | undefined {
    if (this.#textMeasureContext === undefined) {
      const canvas = this.#container.ownerDocument?.createElement("canvas");
      this.#textMeasureContext = canvas?.getContext?.("2d") ?? null;
    }
    const context = this.#textMeasureContext;
    if (!context || typeof context.measureText !== "function") return undefined;
    const style = this.fontStyleOf(frame.fontObject);
    const file = frame.attributes["fontFile"] ?? style?.file;
    const family = file ? this.#registeredFonts.get(file.toLowerCase()) : undefined;
    const height = numberValue(frame.attributes["fontHeight"]) ?? style?.height ?? 14;
    context.font = height + "px " + (family ? '"' + family + '", ' : "") + "sans-serif";
    return Math.max(...text.split(/\r\n|\r|\n/).map((line) => context.measureText(line).width));
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

  /**
   * One frame and its subtree. `structural` is a pass that may have added, moved or removed
   * widgets: it walks hidden subtrees too and records every live frame in `active` for the sweep.
   * Otherwise a frame is re-applied only when its own version moved, its effective visibility
   * changed, or an ancestor was re-applied (z-order, scale and anchors reach it through that
   * ancestor); the rest of the visible tree is only walked, to find the frames that did change.
   * `trap` is the highest strata of the stacking contexts `parent` is inside (see `escapesStrata`);
   * -1 at the container and in a strata layer.
   *
   * `cascade` is what the parent's pass asks of this frame: a full re-apply (the parent moved,
   * resized or was revealed), a paint re-apply (the parent is a button whose drawn state changed)
   * or nothing. A frame whose own change was paint only (`CHANGE_PAINT`: alpha, colour, a bar's
   * fill) is re-applied without its geometry or subtree; see `applyFrame`. `dirtyWalk` (a pass that
   * started at the changed frames) does not walk a subtree nothing asked it to.
   */
  private syncFrame(
    frame: FrameXmlFrame,
    parent: HTMLElement,
    active: Set<FrameXmlFrame> | undefined,
    ancestorHidden = false,
    structural = true,
    cascade: ApplyMode = APPLY_NONE,
    trap = -1,
    dirtyWalk = false,
  ): RenderedFrame {
    active?.add(frame);
    let rendered = this.#rendered.get(frame);
    if (!rendered) {
      rendered = this.createFrame(frame);
      this.#rendered.set(frame, rendered);
      if (frame.type === "GameTooltip") this.#tooltips.add(rendered);
      else if (frame.type === "ScrollFrame") this.#scrollFrames.add(rendered);
      else if (frame.type === "Slider") this.#sliders.add(rendered);
      if (frameXmlAccessibilityCares(frame)) this.#a11yNodes.set(frame, rendered);
    }
    rendered.trap = trap;
    rendered.syncedPass = this.#pass;
    if (rendered.element.parentElement !== parent) parent.append(rendered.element);
    const hidden = ancestorHidden || !frame.visible;
    const wasHidden = rendered.effectiveHidden;
    const firstSync = wasHidden === undefined;
    rendered.effectiveHidden = hidden;
    // A hidden ancestor already suppresses the browser subtree. Keep the existing DOM and
    // resource ownership in place until the ancestor is shown, when the state is applied once.
    // The first sync still walks the subtree so a later Show retains the same mounted shape.
    if (!firstSync && hidden && wasHidden) {
      // …except the frame's own `hidden` bit. `markActiveSubtree` records the effective state of a
      // subtree it parks without writing it, so a child that was *shown* when its ancestor was
      // hidden and was hidden itself meanwhile still has `hidden=false` in the page. Once the
      // ancestor is revealed nothing else would write it, and the child stayed on screen with its
      // old text. Measured on the stock GameTooltip: after `Hide()` the next `SetText("Тестовый")`
      // clears and hides TextLeft2..8 while the tooltip is hidden, and the DOM still painted
      // "Stale line 1..6" and "SpellID: 81830" under the new title — the owner's player tooltip
      // with item lines under it. Only the bit is written: the subtree stays parked, its textures
      // and text are applied when the frame itself is next shown.
      if (!ancestorHidden && !rendered.element.hidden) this.parkHidden(rendered);
      if (structural) {
        this.reparentExistingSubtree(frame, rendered, trap);
        this.dropRemovedHiddenChildren(frame, rendered);
        this.markActiveSubtree(frame, active);
      }
      return rendered;
    }
    const reveal = firstSync || hidden !== wasHidden;
    const changed = frame.renderVersion === undefined || rendered.appliedVersion !== frame.renderVersion;
    const kinds = changed ? this.changeKinds(frame) : 0;
    let mode: ApplyMode;
    if (structural || reveal || cascade === APPLY_FULL) mode = APPLY_FULL;
    else if (changed) mode = kinds === CHANGE_PAINT ? APPLY_PAINT : APPLY_FULL;
    else mode = cascade;
    // A drawn frame shown, hidden, moved or resized: the pass has to measure what depends on it.
    if (!firstSync && (hidden !== wasHidden || (changed && kinds !== CHANGE_PAINT && !hidden))) this.#passLayout = true;
    const apply = mode !== APPLY_NONE;
    let childCascade: ApplyMode = APPLY_NONE;
    if (apply) {
      if (this.#layoutOnly?.(frame)) {
        rendered.element.hidden = hidden;
        rendered.element.style.display = hidden ? "none" : "";
        rendered.element.style.pointerEvents = "none";
        this.applyGeometry(rendered.element, frame);
        rendered.placedPass = this.#pass;
        this.#movedThisPass?.push(rendered);
        childCascade = APPLY_FULL;
      } else {
        this.ensureBackdropPaint(rendered);
        const paint = mode === APPLY_PAINT;
        // `false` is a paint-only apply that left the geometry alone.
        const placed = this.applyFrame(rendered, hidden, paint) !== false;
        if (placed) {
          rendered.placedPass = this.#pass;
          this.#movedThisPass?.push(rendered);
        }
        // A button's state textures and label are drawn from its state; a transform moves every
        // strata layer drawn over it; anything else painted stays on the frame.
        const state = stateKey(frame);
        const stateChanged = state !== rendered.stateKey;
        rendered.stateKey = state;
        childCascade = !paint || placed ? APPLY_FULL : stateChanged ? APPLY_PAINT : APPLY_NONE;
      }
      rendered.appliedVersion = frame.renderVersion;
      this.#appliedThisPass?.push(rendered);
      // A strata, toplevel or attribute change can make a frame a modal dialog, or stop it being one.
      if (changed) {
        if (frameXmlAccessibilityCares(frame)) {
          if (!this.#a11yNodes.has(frame)) this.#a11yNodes.set(frame, rendered);
        } else this.#a11yNodes.delete(frame);
      }
    }

    // A visible frame becoming hidden needs its own `hidden` bit applied, but its descendants can
    // now wait. Mark them active so the ownership sweep below does not mistake a skipped subtree
    // for an unmounted one, and record the effective state for the eventual reveal.
    if (hidden && !firstSync) {
      if (structural) {
        this.reparentExistingSubtree(frame, rendered, trap);
        this.dropRemovedHiddenChildren(frame, rendered);
      }
      this.markActiveSubtree(frame, active);
      return rendered;
    }

    // Message lines are private paint state. Keep them dormant with the rest of a hidden subtree;
    // the next reveal applies the latest bounded history exactly once.
    if (!this.#layoutOnly?.(frame)) this.applyMessageFrame(rendered);
    // SimpleHTML's blocks are private paint state too, built on a reveal when the page changed.
    if (frame.type === "SimpleHTML" && !this.#layoutOnly?.(frame)) this.applySimpleHtml(rendered);
    // A pass that started at the changed frames reaches their changed descendants on its own.
    if (dirtyWalk && childCascade === APPLY_NONE) return rendered;

    // This frame's element is a stacking context of its own: its children are trapped by it too.
    const inner = Math.max(trap, strataRank(frame));
    const moved = childCascade === APPLY_FULL;
    for (const child of frame.children) {
      if (this.#frameFilter && !this.#frameFilter(child)) continue;
      const parentElement = this.childElementHost(rendered, child, hidden, moved, inner);
      const escaped = parentElement !== rendered.element && parentElement !== rendered.scrollViewport;
      const childRendered = this.syncFrame(child, parentElement, active, hidden, structural, childCascade,
        escaped ? -1 : inner, dirtyWalk);
      if (rendered.children.get(child) !== childRendered) rendered.children.set(child, childRendered);
    }
    if (!structural) return rendered;
    const wanted = new Set(frame.children);
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

  /**
   * The element one child of a drawn frame is appended to: the scroll viewport for a ScrollFrame's
   * scroll child, a strata layer for a frame whose strata is above `trap` (see `escapesStrata`), the
   * parent's own element otherwise.
   *
   * The layer is placed here, in the parent's walk, right after the parent itself was applied and
   * before the child is — so the child's own anchors measure a box that is already where the parent
   * is. It is measured only when the parent was re-applied this pass (a move, a resize, an alpha or
   * a reveal all re-apply it) or the layer was never placed; otherwise this is two comparisons.
   */
  private childElementHost(
    rendered: RenderedFrame,
    child: FrameXmlFrame,
    hidden: boolean,
    applied: boolean,
    trap: number,
  ): HTMLElement {
    const frame = rendered.frame;
    if (frame.scroll.child === child && rendered.scrollViewport) return rendered.scrollViewport;
    // Regions never escape, and they are most of the walk: 1,554 child visits per sync, measured on
    // the dev page's vertical.
    if (child.type === "Texture" || child.type === "FontString") return rendered.element;
    if (!escapesStrata(child, trap)) {
      if (this.#strataLayers.has(child)) this.dropStrataLayer(child);
      return rendered.element;
    }
    let layer = this.#strataLayers.get(child);
    if (!layer) {
      const element = this.#container.ownerDocument?.createElement("div") ?? document.createElement("div");
      element.setAttribute("data-framexml-strata-layer", child.name);
      Object.assign(element.style, {
        position: "absolute", left: "0px", top: "0px", width: "0px", height: "0px",
        margin: "0", padding: "0", border: "0", pointerEvents: "none", transformOrigin: "50% 50%",
      });
      layer = { element };
      hideStrataLayer(layer);
      this.#strataLayers.set(child, layer);
      this.#container.append(element);
    }
    const zIndex = String(1000 + (STRATA_Z[child.frameStrata] ?? 2) * 1000 + child.frameLevel);
    if (layer.element.style.zIndex !== zIndex) layer.element.style.zIndex = zIndex;
    if (hidden || !child.visible) {
      hideStrataLayer(layer);
    } else if (applied || layer.box === undefined || layer.parked) {
      this.placeStrataLayer(layer, rendered);
    }
    return layer.element;
  }

  /**
   * Lay a strata layer over its owner's painted box: the owner's own size (the child's percentages
   * resolve against it), the cumulative scale of the owner and every ancestor about the centre (the
   * transform `centringShift` reads back), and the product of their alphas, which is what CSS
   * opacity would have composed inside them. A layout-only ancestor paints nothing and has none.
   */
  private placeStrataLayer(layer: StrataLayer, owner: RenderedFrame): void {
    const element = layer.element;
    // The page can take an owner off screen without Lua knowing: the world mount's stylesheet
    // `display: none`s `PetActionBarFrame` (the native pet bar owns it), whose ten buttons are
    // MEDIUM children of a LOW bar and would otherwise show up in their layers. Checked when the
    // owner is re-applied, not on every walk (the layer is not left parked).
    const boxes = owner.element.getClientRects?.();
    if (boxes && boxes.length === 0) {
      hideStrataLayer(layer);
      layer.parked = false;
      layer.box = "off-page";
      return;
    }
    layer.parked = false;
    if (element.hidden) {
      element.hidden = false;
      element.style.removeProperty("display");
    }
    let alpha = 1;
    for (let frame: FrameXmlFrame | undefined = owner.frame, depth = 0; frame && depth < 64; frame = frame.parent, depth += 1) {
      if (!this.#layoutOnly?.(frame)) alpha *= frame.animationAlpha ?? frame.alpha;
    }
    const at = offsetWithin(owner.element, this.#container);
    const width = owner.element.offsetWidth;
    const height = owner.element.offsetHeight;
    let box: string;
    if (at && typeof width === "number" && typeof height === "number") {
      const left = at.left - (1 - at.scale) * width / 2;
      const top = at.top - (1 - at.scale) * height / 2;
      box = `${left} ${top} ${width} ${height} ${at.scale} ${alpha}`;
      if (box === layer.box) return;
      Object.assign(element.style, {
        left: px(left), top: px(top), width: px(width), height: px(height),
        transform: at.scale === 1 ? "" : `scale(${at.scale})`,
      });
    } else {
      // A host with no layout (the tests' DOM stub): the whole container, which is the box of a
      // root owner and harmless for any other.
      box = `stage ${alpha}`;
      if (box === layer.box) return;
      Object.assign(element.style, { left: "0px", top: "0px", width: "100%", height: "100%", transform: "" });
    }
    element.style.opacity = alpha === 1 ? "" : String(alpha);
    layer.box = box;
  }

  private dropStrataLayer(frame: FrameXmlFrame): void {
    const layer = this.#strataLayers.get(frame);
    if (!layer) return;
    this.#strataLayers.delete(frame);
    layer.element.remove();
  }

  /** Adopt already-rendered descendants while a destination ancestor is hidden. */
  private reparentExistingSubtree(frame: FrameXmlFrame, rendered: RenderedFrame, trap: number): void {
    const inner = Math.max(trap, strataRank(frame));
    for (const child of frame.children) {
      const childRendered = this.#rendered.get(child);
      if (!childRendered) continue;
      const parentElement = this.childElementHost(rendered, child, true, false, inner);
      if (childRendered.element.parentElement !== parentElement) {
        parentElement.append(childRendered.element);
      }
      rendered.children.set(child, childRendered);
      const escaped = parentElement !== rendered.element && parentElement !== rendered.scrollViewport;
      this.reparentExistingSubtree(child, childRendered, escaped ? -1 : inner);
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

  /**
   * Hide one element that is already hidden in the bridge, and nothing more: no text, geometry or
   * texture work, and no walk of its subtree, which its own `hidden` bit now suppresses.
   */
  private parkHidden(rendered: RenderedFrame): void {
    const { frame, element } = rendered;
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
    if (this.#layoutOnly?.(frame)) element.style.display = "none";
    // An inline `display` outranks the user-agent `[hidden]` rule; only the live page's stylesheet
    // restores it with `!important`. The tooltip's grid and a clamped string's line box are the
    // inline displays this renderer sets.
    if (frame.type === "GameTooltip") element.style.removeProperty("display");
    if (frame.type === "FontString" && element.style.webkitLineClamp) element.style.display = "";
  }

  /** Mark a skipped subtree as live without touching its DOM, styles, or texture leases. */
  private markActiveSubtree(frame: FrameXmlFrame, active: Set<FrameXmlFrame> | undefined): void {
    if (this.#frameFilter && !this.#frameFilter(frame)) return;
    active?.add(frame);
    const rendered = this.#rendered.get(frame);
    if (rendered) rendered.effectiveHidden = true;
    // A strata layer is not inside its parent's element, so the parked ancestor does not hide it.
    const layer = this.#strataLayers.get(frame);
    if (layer) hideStrataLayer(layer);
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
    this.#frameOfElement.set(element, frame);

    if (frame.type === "Button" || frame.type === "CheckButton") {
      element.setAttribute("type", "button");
      element.addEventListener("click", (event) => {
        if (this.#layoutOnly?.(frame)) return;
        // Never forward the browser event itself to an addon.  The bridge gets
        // only FrameXML's stable button name and key-state scalar.
        //
        // A button that armed its own combinations with RegisterForClicks is driven by the two
        // listeners below instead, or it would fire twice on a release it asked for.
        if (frame.clickRegistrations.size > 0) {
          // Native Enter/Space and assistive activation have no mouse press/release events.
          // Honor the registered phases once; ordinary mouse clicks already dispatched them.
          if ((event as MouseEvent).detail === 0) {
            this.registeredClick(frame, event, true);
            this.registeredClick(frame, event, false);
          }
          return;
        }
        this.#bridge?.Click(frame, mouseButtonName(event), false);
      });
      element.addEventListener("mousedown", (event) => this.registeredClick(frame, event, true));
      element.addEventListener("mouseup", (event) => this.registeredClick(frame, event, false));
    }
    let input: (HTMLElement & { value?: string; disabled?: boolean }) | undefined;
    let sliderInput: HTMLInputElement | undefined;
    if (frame.type === "Slider") {
      const range = element.ownerDocument.createElement("input");
      range.setAttribute("type", "range");
      range.setAttribute("data-framexml-slider-input", "true");
      range.setAttribute("aria-label", frame.name);
      Object.assign(range.style, {
        position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
        margin: "0", padding: "0", opacity: "0", zIndex: "999", cursor: "pointer",
      });
      range.addEventListener("input", () => {
        if (this.#layoutOnly?.(frame) || !frame.enabled || !this.#bridge?.isVisible(frame)) return;
        this.#bridge.SetValue(frame, Number(range.value), true);
      });
      element.append(range);
      sliderInput = range;
    }
    let scrollViewport: HTMLElement | undefined;
    if (frame.type === "ScrollFrame") {
      scrollViewport = element.ownerDocument.createElement("div");
      scrollViewport.setAttribute("data-framexml-scroll-viewport", "true");
      Object.assign(scrollViewport.style, {
        position: "absolute", left: "0", top: "0", width: "100%", height: "100%", overflow: "hidden",
      });
      element.append(scrollViewport);
    }
    if (frame.type === "EditBox") {
      // A `multiLine` box writes its text from the top down and breaks lines: a `<textarea>`. An
      // `<input>` centres its one line vertically — measured, `SendMailBodyEditBox` (MailFrame.xml:819,
      // the corpus' one multi-line box) drew the letter's first line in the middle of the parchment.
      const multiLine = frame.editBox.multiLine;
      const tag = multiLine ? "textarea" : "input";
      const field = (this.#container.ownerDocument?.createElement(tag)
        ?? document.createElement(tag)) as HTMLElement & { value?: string; disabled?: boolean };
      if (multiLine) {
        // The pages' own edit-box rule targets `input`; the same box, inline.
        Object.assign(field.style, {
          position: "absolute", left: "0", top: "0", width: "100%", height: "100%", minHeight: "0",
          margin: "0", padding: "0", border: "0", borderRadius: "0", background: "none", boxShadow: "none",
          color: "inherit", font: "inherit", textAlign: "inherit", outline: "none", zIndex: "900",
          resize: "none", overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word",
        });
      } else {
        field.setAttribute("type", frame.editBox.password ? "password" : "text");
      }
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
      field.addEventListener("select", () => {
        if (this.#layoutOnly?.(frame)) return;
        const selection = (field as HTMLInputElement).selectionStart;
        if (typeof selection !== "number" || selection === frame.editBox.cursorPosition) return;
        this.#bridge?.update(frame, mutable => { mutable.editBox.cursorPosition = selection; });
      });
      field.addEventListener("keydown", (event) => {
        if (this.#layoutOnly?.(frame)) return;
        const key = (event as KeyboardEvent).key;
        if (key === "Enter") this.#bridge?.fireScript(frame, "OnEnterPressed");
        else if (key === "Escape") {
          this.#bridge?.fireScript(frame, "OnEscapePressed");
          // The script is the whole meaning of the press. The page's key handler knows this
          // renderer's `<input>` (and stops there, see Controls.ts) but not the `<textarea>`: it took
          // the press for its own back-out chain and closed every open window — measured, Escape in
          // `SendMailBodyEditBox` (whose OnEscapePressed is `EditBox_ClearFocus`, MailFrame.xml:843)
          // closed `MailFrame`. So the press is spent here, and a box the script took focus from
          // loses the caret too, the way the client's does.
          if (multiLine) {
            (event as KeyboardEvent & { preventDefault?: () => void }).preventDefault?.();
            if (!frame.editBox.focused && field.ownerDocument?.activeElement === field) field.blur?.();
          }
        } else if (key === " ") this.#bridge?.fireScript(frame, "OnSpacePressed");
        else if (key === "Tab") {
          this.#bridge?.fireScript(frame, "OnTabPressed");
          // The client has no page focus order: in the world the press is the box's own
          // (AutoCompleteEditBox_OnTabPressed keeps the caret and walks its list; a box without the
          // script ignores it), so the browser does not carry the caret off to another node now that
          // no modal trap holds it. The login screens keep field-to-field Tab (NativeAppShell.ts).
          if (this.#dialogs === "modeless") (event as KeyboardEvent & { preventDefault?: () => void }).preventDefault?.();
        } else if (key === "ArrowUp" || key === "ArrowDown") {
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
      // Lua's chat buttons and mouse-wheel handlers own the scroll offset. Keep a scrollable
      // clipping box for scrollTop, without browser bars shrinking the text or appearing on HUD
      // messages; unlike overflow: clip, hidden still permits programmatic scrolling.
      layer.style.overflowX = "hidden";
      layer.style.overflowY = "hidden";
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
      this.hoverButtonFont(frame, true);
      this.#bridge?.Enter(frame);
    };
    const leave = (event: Event) => {
      if (!hovering) return;
      hovering = false;
      this.rememberCursor(event);
      this.hoverButtonFont(frame, false);
      if (this.#layoutOnly?.(frame)) return;
      this.#bridge?.Leave(frame);
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("mouseenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("mouseleave", leave);
    element.addEventListener("wheel", (event) => {
      if (this.#layoutOnly?.(frame) || !this.#bridge?.isVisible(frame) || !frame.enabled) return;
      const enabled = frame.attributes["enableMouseWheel"] ?? frame.attributes["enablemousewheel"];
      // Stock scroll templates declare OnMouseWheel without enableMouseWheel. An explicit
      // EnableMouseWheel(false) still disables them (InterfaceOptionsPanels.lua relies on it).
      if (enabled !== undefined && !/^(?:true|1)$/i.test(enabled)) return;
      if (!this.#bridge.hasScript(frame, "OnMouseWheel")) return;
      const delta = (event as WheelEvent).deltaY;
      if (!Number.isFinite(delta) || delta === 0) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      this.#bridge.fireScript(frame, "OnMouseWheel", delta < 0 ? 1 : -1);
    }, { passive: false });

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
      trap: -1,
      syncedPass: 0,
      placedPass: 0,
      appliedAnimationTransform: undefined,
      appliedRotation: undefined,
      appliedTexCoords: undefined,
      appliedScale: undefined,
      appliedAlpha: undefined,
      appliedBackdrop: undefined,
      appliedBackdropColor: undefined,
      appliedBackdropBorderColor: undefined,
      stateKey: undefined,
      ...(label ? { label } : {}),
      ...(input ? { input } : {}),
      ...(sliderInput ? { sliderInput } : {}),
      ...(scrollViewport ? { scrollViewport } : {}),
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
    // The moving box is read off the page below; a world event may have moved it since the last pass.
    this.#bridge.settleDeferredLayout();
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
    // The drop: the frame under the pointer receives what the drag put on the cursor. A drop
    // consumes the release, so the element listeners below never see it.
    const dropped = dispatch && drag.started && drag.registered && event !== undefined && this.receiveDrag(event);
    // L1-review: nor is a release after a started drag anybody's click — the reference clicks only a
    // release over the pressed frame and never after a drag (benilla pointer.rs, cursor/drag.rs). Over a
    // unit button (no OnReceiveDrag) that click was DropItemOnUnit: a dragged stack fed the pet.
    if (!dropped && dispatch && drag.started && drag.registered && event !== undefined) this.#dragReleases.add(event);
    if (drag.captureMouseUp) {
      const element = this.#rendered.get(drag.source)?.element;
      const target = event?.target;
      const inside = target && element && (target === element || element.contains?.(target as Node));
      // Inside releases reach the existing element listener. Outside releases, blur, hide and
      // renderer teardown must invoke the original model's cleanup before detaching its nodes.
      if (!inside || dropped) this.#bridge?.fireScript(drag.source, "OnMouseUp", drag.button);
    }
    if (dispatch && drag.moving && this.#bridge?.isVisible(drag.moving)) {
      this.#bridge.settleDeferredLayout();
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

  /**
   * `OnReceiveDrag` on the frame a registered drag was released over — ActionButton's PlaceAction
   * (ActionBarFrame.xml:25-29), SpellButton_OnDrag, a bag slot's PickupContainerItem, the stable's
   * slots. The release is the drop's, so it does not also click the frame it landed on: the
   * document-capture listener that got here stops it before the element's own mouseup.
   *
   * The receiver is the nearest frame up from the element under the pointer that has the script; a
   * button or check button without one is the frame that took the mouse, and nothing is dropped.
   */
  private receiveDrag(event: Event): boolean {
    const bridge = this.#bridge;
    if (!bridge) return false;
    for (let node = event.target as Element | null; node && node !== this.#container; node = node.parentElement) {
      const frame = this.#frameOfElement.get(node);
      if (!frame) continue;
      if (frame.type === "Texture" || frame.type === "FontString") continue;
      if (this.#layoutOnly?.(frame) || !bridge.isVisible(frame)) return false;
      if (bridge.hasScript(frame, "OnReceiveDrag")) {
        event.stopPropagation?.();
        bridge.fireScript(frame, "OnReceiveDrag");
        return true;
      }
      if (frame.type === "Button" || frame.type === "CheckButton") return false;
    }
    return false;
  }

  /**
   * The icon of what the FrameXML cursor holds, drawn at the pointer (the client draws it as the
   * cursor itself) until it is called with nothing. It never takes the mouse, so the drop still
   * lands on the frame under it.
   */
  setCursorPicture(texture: string | undefined): void {
    const path = texture?.trim() ?? "";
    const held = this.#cursorPicture;
    if (held && held.path === path) return;
    if (held) {
      held.cleanup();
      held.element.remove();
      if (this.#textures && held.path) this.#textures.release(frameXmlTexturePath(held.path));
      this.#cursorPicture = undefined;
    }
    const doc = this.#container.ownerDocument;
    if (!path || typeof doc?.addEventListener !== "function") return;
    const element = doc.createElement("img");
    element.setAttribute("data-framexml-cursor-picture", "true");
    element.setAttribute("alt", "");
    Object.assign(element.style, {
      position: "fixed", width: "32px", height: "32px", pointerEvents: "none", zIndex: "2147483647",
      left: "-64px", top: "-64px", opacity: "0.85",
    });
    const key = this.#textures ? frameXmlTexturePath(path) : "";
    const source = (): string => (this.#textures ? this.#textures.peek(key) : this.#textureResolver?.(path)) ?? "";
    if (this.#textures) this.#textures.acquire(key);
    const place = (x: number, y: number): void => {
      element.style.left = `${x - 16}px`;
      element.style.top = `${y - 16}px`;
      // A picture still being fetched is applied as soon as a move finds it arrived.
      if (!element.getAttribute("src")) {
        const url = source();
        if (url) element.setAttribute("src", url);
      }
    };
    const move = (next: Event): void => {
      const mouse = next as MouseEvent;
      if (Number.isFinite(mouse.clientX) && Number.isFinite(mouse.clientY)) place(mouse.clientX, mouse.clientY);
    };
    doc.addEventListener("mousemove", move, true);
    doc.body?.append(element);
    if (this.#cursor) place(this.#cursor.x, this.#cursor.y);
    // A picture the cache is still fetching lands without waiting for the pointer to move.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const land = (): void => {
      timer = undefined;
      if (element.getAttribute("src")) return;
      const url = source();
      if (url) element.setAttribute("src", url);
      else if ((tries += 1) < 50) timer = setTimeout(land, 100);
    };
    land();
    this.#cursorPicture = {
      element, path,
      cleanup: () => {
        doc.removeEventListener("mousemove", move, true);
        if (timer !== undefined) clearTimeout(timer);
      },
    };
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
    if (!down && this.#dragReleases.has(event)) return; // L1-review: a drag's release clicks nothing
    const button = mouseButtonName(event);
    const phase = down ? "DOWN" : "UP";
    if (!frame.clickRegistrations.has(`${button}${phase}`.toUpperCase()) &&
        !frame.clickRegistrations.has(`ANY${phase}`)) return;
    this.#bridge?.Click(frame, button, down);
  }

  /**
   * Apply one frame's state to its element. Answers whether its geometry was applied.
   *
   * `paintOnly` is a frame whose every change since the last apply was announced as paint
   * (`FrameXmlUiApi.update(…, "paint")`: alpha, vertex and text colour, a bar's value and colour,
   * a cooldown, texcoords, a rotation, an animation's alpha or transform). Its box did not move, so
   * the geometry — which measures sibling anchors and so forces a style and layout pass after the
   * writes before it — is applied again only when a transform it carries changed, and the backdrop
   * only when the backdrop or its colours did. Measured on the rich route: the aura and party-status
   * alpha flashes re-applied 7 frames a frame at 0.97 ms (P-cores), 0.69 ms of it two sibling
   * measures, `ConsolidatedBuffs` and `PartyMemberFrame1Portrait`.
   */
  private applyFrame(rendered: RenderedFrame, effectiveHidden = !rendered.frame.visible, paintOnly = false): boolean {
    const { frame, element } = rendered;
    const mouse = frame.attributes["enableMouse"] ?? frame.attributes["enablemouse"];
    // Module cards and model previews are Frames with mouse scripts, not necessarily Buttons.
    // Explicitly enabled frames must escape the transparent world/layout parent's inherited rule.
    const wheel = frame.attributes["enableMouseWheel"] ?? frame.attributes["enablemousewheel"];
    const receivesWheel = wheel === undefined ? this.#bridge?.hasScript(frame, "OnMouseWheel")
      : /^(?:true|1)$/i.test(wheel);
    const isControl = frame.type === "Button" || frame.type === "CheckButton"
      || frame.type === "EditBox" || frame.type === "Slider";
    const receives = mouse === undefined ? Boolean(receivesWheel || isControl) : /^(?:true|1)$/i.test(mouse);
    // With hit-rect insets the box itself stops taking the pointer and a private node takes it
    // instead; see `applyHitRect`.
    const insetHit = this.applyHitRect(rendered, receives);
    element.style.pointerEvents = receives && !insetHit ? "auto" : "none";
    const hidden = effectiveHidden;
    if (element.hidden !== hidden) element.hidden = hidden;
    const ariaHidden = String(hidden);
    if (element.getAttribute("aria-hidden") !== ariaHidden) {
      element.setAttribute("aria-hidden", ariaHidden);
    }
    // `layoutGameTooltip` gives a shown tooltip an inline `display: grid`, which outranks the
    // user-agent `[hidden]` rule; a hidden tooltip must not keep it (see `parkHidden`).
    if (hidden && frame.type === "GameTooltip" && element.style.display) element.style.removeProperty("display");

    if (frame.type === "EditBox") {
      const input = rendered.input;
      if (input) {
        // The value is what somebody typed, so it is never run through the escape parser and never
        // becomes spans: `|` is a character an account name may legitimately contain.
        const valueChanged = input.value !== frame.text;
        if (valueChanged) input.value = frame.text;
        input.disabled = !frame.enabled;
        const textarea = input.tagName === "TEXTAREA";
        if (!textarea) input.setAttribute("type", frame.editBox.password ? "password" : "text");
        if (frame.editBox.letters > 0) input.setAttribute("maxlength", String(frame.editBox.letters));
        // `<TextInsets>` is the padding the client draws the caret inside; on this login screen it
        // is `left="12"`, which is what keeps the text off the border art.
        const insets = frame.textInsets;
        input.style.padding = insets
          ? `${px(insets.top)} ${px(insets.right)} ${px(insets.bottom)} ${px(insets.left)}`
          : textarea ? "0" : "";
        // `EditBox:SetFocus()` is a real focus: `AccountLogin_OnShow` puts the caret in whichever
        // of the two boxes is still empty, and until this the caret never moved.
        const active = input.ownerDocument?.activeElement;
        if (frame.editBox.focused && active !== undefined && active !== input) input.focus?.();
        if (typeof input.ownerDocument?.activeElement === "object"
          && input.ownerDocument?.activeElement === input
          && (valueChanged || rendered.editBoxSelectionRevision !== frame.editBox.selectionRevision)) {
          const start = frame.editBox.highlightStart ?? frame.editBox.cursorPosition;
          const end = frame.editBox.highlightEnd ?? start;
          // Animation and unrelated UI mutations must not undo Ctrl+A, a drag selection, or
          // native arrow navigation. Only an explicit Lua request owns the next selection.
          rendered.editBoxSelectionRevision = frame.editBox.selectionRevision;
          (input as HTMLElement & {
            setSelectionRange?: (start: number, end: number) => void;
          }).setSelectionRange?.(start, end);
        }
      }
    } else if (rendered.label) {
      // A Button's real label is its ButtonText FontString child; the inline
      // label span only carries text a Frame or a texture-less button set
      // directly, so it must not duplicate the child.
      const owned = frame.stateTextures.has("BUTTONTEXT") ? "" : frame.text;
      this.applyText(rendered, rendered.label, owned);
      // A button with no `<ButtonText>` that is given text draws it in its state font, as the
      // client's implicit font string does.
      if (owned && (frame.type === "Button" || frame.type === "CheckButton")) this.applyButtonLabel(rendered.label, frame);
    } else if (frame.type === "FontString") {
      this.applyText(rendered, element, frame.text);
    }

    const placed = !paintOnly || rendered.appliedAnimationTransform !== frame.animationTransform
      || rendered.appliedRotation !== frame.textureRotation || rendered.appliedTexCoords !== frame.texCoords
      || rendered.appliedScale !== frame.scale;
    if (placed) {
      const width = numberValue(frame.attributes["width"]);
      const height = numberValue(frame.attributes["height"]);
      this.applyGeometry(element, frame, width, height);
      rendered.appliedAnimationTransform = frame.animationTransform;
      rendered.appliedRotation = frame.textureRotation;
      rendered.appliedTexCoords = frame.texCoords;
      rendered.appliedScale = frame.scale;
    }

    const alpha = frame.animationAlpha ?? frame.alpha;
    element.style.opacity = alpha === 1 ? "" : String(alpha);
    // A strata layer carries the product of its owners' alphas (`placeStrataLayer`); a full apply
    // re-places the layers of its children, a paint-only one has to pass a new alpha on itself.
    if (paintOnly && !placed && rendered.appliedAlpha !== alpha && this.#strataLayers.size > 0) this.refreshLayerAlphas(frame);
    rendered.appliedAlpha = alpha;
    const zIndex = frame.type === "Texture" || frame.type === "FontString"
      ? String((LAYER_Z[frame.drawLayer] ?? 3) * 100 + frame.drawSubLevel)
      : String(1000 + (STRATA_Z[frame.frameStrata] ?? 2) * 1000 + frame.frameLevel);
    if (element.style.zIndex !== zIndex) element.style.zIndex = zIndex;

    if (!paintOnly || rendered.appliedBackdrop !== frame.backdrop || rendered.appliedBackdropColor !== frame.backdropColor
      || rendered.appliedBackdropBorderColor !== frame.backdropBorderColor) {
      this.applyBackdrop(rendered);
      rendered.appliedBackdrop = frame.backdrop;
      rendered.appliedBackdropColor = frame.backdropColor;
      rendered.appliedBackdropBorderColor = frame.backdropBorderColor;
    }
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
    return placed;
  }

  /**
   * Pass one frame's new alpha on to the strata layers drawn over it: every drawn layer of a frame
   * inside it (the layer is laid over the escaped frame's parent, `placeStrataLayer`).
   */
  private refreshLayerAlphas(owner: FrameXmlFrame): void {
    for (const [child, layer] of this.#strataLayers) {
      if (layer.parked || layer.box === undefined || layer.box === "off-page") continue;
      let inside = false;
      for (let at = child.parent, depth = 0; at && depth < 64; at = at.parent, depth += 1) {
        if (at === owner) {
          inside = true;
          break;
        }
      }
      const host = inside && child.parent ? this.#rendered.get(child.parent) : undefined;
      if (host && host.effectiveHidden === false) this.placeStrataLayer(layer, host);
    }
  }

  /**
   * `<HitRectInsets>` / `SetHitRectInsets`: the part of a frame's box that takes the pointer.
   *
   * Positive insets cut the clickable box in from its edges, negative ones grow it past them — and
   * neither touches what the frame or its children *draw*, nor where a child frame takes clicks of
   * its own: the client hit-tests every frame by its own rectangle. So this is not a clip. The box
   * itself stops taking the pointer (`pointer-events: none`, which also reaches its private label)
   * and one transparent node inset by the four numbers takes it instead; press, release, wheel and
   * enter/leave on that node reach the frame's own listeners exactly as before, because they bubble
   * and the node belongs to no other frame. Measured in Chrome: a disabled `<button>` with such a
   * node still gets enter/leave from it (and, like before, no press), and a node grown past the box
   * (`right = -100`) takes the press out there.
   *
   * Measured over the dataset's FrameXML and Blizzard add-ons: 90 declarations. 39 are the
   * 384×512-art panels — `CharacterFrame`/`PaperDollFrame` (`right=30 bottom=45`) and 37 more cut
   * 30-35 off the right and 45-75 off the bottom — whose strip below the drawn art otherwise took
   * the clicks meant for the chat frame under it; the unit frames (`PlayerFrame`,
   * `TargetFrameTemplate`, `PartyMemberFrameTemplate`) cut away their empty corners; the micro
   * buttons cut 18 off the top; and 8 check buttons grow right (`-55` … `-145`) over their label.
   *
   * A Slider's own range input already covers its box and takes the drag, so the insets go on that
   * input. An EditBox keeps its box: its input is where the text is drawn (no corpus EditBox
   * declares insets). Returns whether a private node now takes the pointer for the frame.
   */
  private applyHitRect(rendered: RenderedFrame, receives: boolean): boolean {
    const { frame } = rendered;
    const insets = receives && frame.type !== "EditBox" ? frame.hitRectInsets : undefined;
    const active = insets !== undefined
      && (insets.left !== 0 || insets.right !== 0 || insets.top !== 0 || insets.bottom !== 0);
    const place = (node: HTMLElement): void => {
      node.style.left = px(insets!.left);
      node.style.right = px(insets!.right);
      node.style.top = px(insets!.top);
      node.style.bottom = px(insets!.bottom);
    };
    if (frame.type === "Slider") {
      const input = rendered.sliderInput;
      if (!input) return false;
      if (active) {
        place(input);
        input.style.width = "auto";
        input.style.height = "auto";
        input.style.pointerEvents = "auto";
      } else if (input.style.pointerEvents) {
        Object.assign(input.style, { left: "0", top: "0", right: "", bottom: "", width: "100%", height: "100%", pointerEvents: "" });
      }
      return active;
    }
    if (!active) {
      if (rendered.hitRect) rendered.hitRect.style.display = "none";
      return false;
    }
    let node = rendered.hitRect;
    if (!node) {
      node = this.#container.ownerDocument?.createElement("div") ?? document.createElement("div");
      node.setAttribute("aria-hidden", "true");
      node.setAttribute("data-framexml-hit-rect", "true");
      node.style.position = "absolute";
      // Below every authored child: a child frame with a hit box of its own stays on top of it.
      node.style.zIndex = "0";
      node.style.pointerEvents = "auto";
      const first = rendered.element.children[0];
      if (first && typeof rendered.element.insertBefore === "function") rendered.element.insertBefore(node, first);
      else rendered.element.append(node);
      rendered.hitRect = node;
    }
    node.style.display = "";
    place(node);
    return true;
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
    // Unchanged values are not written again: each write is a mutation record and a style
    // invalidation of the layer, measured at 5 a pass on UIErrorsFrame and ChatFrame1.
    setAttributeIfChanged(layer, "data-framexml-max-lines", String(state.maxLines));
    setAttributeIfChanged(layer, "data-framexml-display-duration", String(state.displayDuration));
    setAttributeIfChanged(layer, "data-framexml-nonspacewrap", String(state.nonSpaceWrap));
    setAttributeIfChanged(layer, "data-framexml-scroll-range", String(frame.scroll.verticalScrollRange));
    if (frame.type === "MessageFrame") {
      this.paintMessageFrameLines(rendered, layer);
      return;
    }
    if (rendered.messageRevision === state.revision
      && rendered.messageScroll === frame.scroll.verticalScroll) {
      this.trackMessageFades(rendered);
      return;
    }

    // L5 3.34: insertMode TOP (the guild bank log): the newest line first, from the top (Wow.exe
    // 0x00969fa0 lays the current line in the top slot and the older ones below it). Rebuilt whole;
    // such a frame is short and refilled at once (Blizzard_GuildBankUI.lua:571-594).
    if (state.insertMode === "TOP" && rendered.messageRevision !== state.revision) {
      if (typeof layer.replaceChildren === "function") layer.replaceChildren();
      else while (layer.children.length > 0) layer.children[layer.children.length - 1]?.remove();
      rendered.messageNextIndex = 0;
      const drawn = state.messages.slice().reverse();
      for (const message of drawn) layer.append(this.createMessageLine(layer, frame, message, this.nextMessageIndex(rendered)));
      rendered.messageSnapshot = drawn;
      rendered.messageRevision = state.revision;
    }
    if (rendered.messageRevision !== state.revision) {
      const previous = rendered.messageSnapshot;
      const current = state.messages;
      // A bridge transaction coalesces every message mutation between two syncs — a deferred world
      // event burst holds a whole frame's worth (02.10: a dungeon pull prints 20+ combat-log lines
      // between two frames, and each such frame used to rebuild all 300 lines of ChatFrame2). The
      // intermediate operations are unknown, but the result is all that is painted: the bridge makes
      // a new message object per AddMessage and never changes one, so when the old lines from some
      // point on are, in order and by identity, exactly the first lines now, the paint is "drop that
      // many from the top, append the rest" whatever happened in between. Anything else — a line
      // removed from the middle, a clear, a line added at the top — takes the full path.
      const canIncrement = previous !== undefined && rendered.messageRevision !== undefined
        && layer.children.length === previous.length;
      const dropped = canIncrement ? keptTail(previous, current) : -1;

      if (dropped >= 0) {
        for (let index = 0; index < dropped; index++) layer.children[0]?.remove();
        for (let index = previous!.length - dropped; index < current.length; index++) {
          layer.append(this.createMessageLine(layer, frame, current[index]!, this.nextMessageIndex(rendered)));
        }
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
    rendered.messageScroll = frame.scroll.verticalScroll;
    // Inside a pass, after its held placements: the frame's own (a chat frame is clamped to the
    // screen) or an ancestor's can still change the height the offset is mapped against, and a
    // resize and a new line in one batch then left the newest lines below the bottom edge.
    const held = this.#messageScrolls;
    if (held) held.push(rendered);
    else this.scrollMessageLayer(rendered);
    this.trackMessageFades(rendered);
  }

  /**
   * A MessageFrame's lines (3.34): stacked from the insert edge with the newest there — TOP, the
   * newest first; BOTTOM, oldest first and packed to the bottom — and never scrolled: the bridge
   * keeps only the lines the height holds, as the client's slots do. Few lines, so a change rebuilds.
   */
  private paintMessageFrameLines(rendered: RenderedFrame, layer: HTMLElement): void {
    const state = rendered.frame.messageFrame;
    const top = state.insertMode === "TOP";
    if (layer.style.display !== "flex") layer.style.display = "flex";
    if (layer.style.flexDirection !== "column") layer.style.flexDirection = "column";
    const justify = top ? "flex-start" : "flex-end";
    if (layer.style.justifyContent !== justify) layer.style.justifyContent = justify;
    if (rendered.messageRevision !== state.revision) {
      if (typeof layer.replaceChildren === "function") layer.replaceChildren();
      else while (layer.children.length > 0) layer.children[layer.children.length - 1]?.remove();
      rendered.messageNextIndex = 0;
      const drawn = state.messages.slice();
      if (top) drawn.reverse();
      for (const message of drawn) {
        const line = this.createMessageLine(layer, rendered.frame, message, this.nextMessageIndex(rendered));
        line.style.flexShrink = "0";
        layer.append(line);
      }
      rendered.messageSnapshot = drawn;
      rendered.messageRevision = state.revision;
    }
    const scrolled = layer as HTMLElement & { scrollTop?: number };
    if (typeof scrolled.scrollTop === "number" && scrolled.scrollTop !== 0) scrolled.scrollTop = 0;
    this.trackMessageFades(rendered);
  }

  /** After a paint: draw the lines' alphas once, and keep ticking the frame while one can change. */
  private trackMessageFades(rendered: RenderedFrame): void {
    const state = rendered.frame.messageFrame;
    const entry = this.#messageFades.get(rendered);
    if (entry === undefined && (state.messages.length === 0 || !state.fading)) return;
    if (entry && entry.revision === state.revision && entry.fadeRevision === state.fadeRevision
      && entry.clock === state.fadeClock) return;
    this.paintMessageFades(rendered);
  }

  /** Walk one frame's drawn lines at its clock; stop tracking it once no line can change. */
  private paintMessageFades(rendered: RenderedFrame): void {
    const state = rendered.frame.messageFrame;
    const layer = rendered.messageLayer;
    const drawn = rendered.messageSnapshot;
    let entry = this.#messageFades.get(rendered);
    if (!layer || !drawn || drawn.length === 0) {
      this.#messageFades.delete(rendered);
      return;
    }
    if (entry === undefined) {
      entry = { clock: state.fadeClock, fadeRevision: -1, revision: -1, from: 0, next: Infinity };
      this.#messageFades.set(rendered, entry);
    }
    if (entry.revision !== state.revision || entry.fadeRevision !== state.fadeRevision) entry.from = 0;
    frameXmlPaintLineFades(state, layer.children as unknown as ArrayLike<HTMLElement | undefined>, drawn, entry);
    entry.clock = state.fadeClock;
    entry.revision = state.revision;
    entry.fadeRevision = state.fadeRevision;
    if (entry.next === Infinity) this.#messageFades.delete(rendered);
  }

  /**
   * Advance the drawn alpha of every message line that is fading to its frame's clock (3.34), and
   * say how many frames had a line to draw. Like `tickCooldowns`, a separate entry point over only
   * the frames with such a line: a frame whose lines are all shown is passed by until the first of
   * them is due, a paused or hidden one until its clock moves, so a frame of nothing costs nothing.
   */
  tickMessageFades(): number {
    let walked = 0;
    for (const rendered of this.#messageFades.keys()) {
      const entry = this.#messageFades.get(rendered)!;
      if (rendered.effectiveHidden) continue;
      const state = rendered.frame.messageFrame;
      if (entry.revision === state.revision && entry.fadeRevision === state.fadeRevision) {
        if (entry.clock === state.fadeClock) continue;
        if (state.fadeClock < entry.next) {
          entry.clock = state.fadeClock;
          continue;
        }
      }
      walked += 1;
      this.paintMessageFades(rendered);
    }
    return walked;
  }

  /**
   * SimpleHTML (3.35): the page (FrameXmlSimpleHtml.ts) drawn as blocks in a private layer, rebuilt
   * only when the text, a header font or the link format changed. The widget's own font, colour and
   * shadow (`applyFontStyle`) are the paragraphs' by inheritance, as the client's default font is
   * theirs; a header with a font object of its own (`<FontStringHeader1>`, `SetFontObject("h1", …)`)
   * is dressed in it, one without falls back to the default (0x0096cc90). Text only ever becomes text
   * nodes — the page is a server's or an add-on's string.
   */
  private applySimpleHtml(rendered: RenderedFrame, force = false): void {
    const { frame, element } = rendered;
    const linkFormat = frame.attributes["hyperlinkFormat"] ?? FRAME_XML_SIMPLE_HTML_LINK_FORMAT;
    const h1 = frame.stateFonts.get("FONTSTRINGHEADER1") ?? "";
    const h2 = frame.stateFonts.get("FONTSTRINGHEADER2") ?? "";
    const h3 = frame.stateFonts.get("FONTSTRINGHEADER3") ?? "";
    const key = `${linkFormat}\u0000${h1}\u0000${h2}\u0000${h3}\u0000${frame.text}`
      + frameXmlSimpleHtmlFontKey(frame); // L5 3.35: the headers' own settings and the line spacing redraw it too
    let held = this.#simpleHtml.get(rendered);
    if (!force && held?.key === key) return;
    if (!held) {
      const layer = element.ownerDocument?.createElement("div") ?? document.createElement("div");
      layer.classList.add(`${this.#classPrefix}-html-layer`);
      layer.setAttribute("data-framexml-html-layer", "true");
      layer.style.position = "absolute";
      layer.style.left = "0";
      layer.style.top = "0";
      layer.style.width = "100%";
      layer.style.pointerEvents = "none";
      layer.style.whiteSpace = "pre-wrap";
      layer.style.overflowWrap = "break-word";
      element.append(layer);
      held = { layer, key: undefined };
      this.#simpleHtml.set(rendered, held);
    }
    held.key = key;
    let pictures = 0;
    const hooks: FrameXmlSimpleHtmlDomHooks = {
      headerFont: (block, level) => {
        // L5 3.35: the header's own font — a font object or SetFont — with its own colour and shadow
        // (SetTextColor("h1", …)); a header without one is drawn in the page's (0x0096cc90).
        const font = frameXmlSimpleHtmlLevelFont(frame, level);
        if (font.level === 0) return;
        const face = { ...SIMPLE_HTML_HEADER_FACE, attributes: font.attributes, textColor: font.textColor };
        this.applyFontFace(block, face as unknown as FrameXmlFrame, font.fontObject);
      },
      // L5 3.35: a block's line height and spacing, the numbers GetBoundsRect measures with.
      metrics: (level) => {
        const font = frameXmlSimpleHtmlLevelFont(frame, level);
        const style = font.fontObject ? this.fontStyleOf(font.fontObject) : undefined;
        const height = font.height ?? style?.height;
        return height !== undefined && height > 0 ? { height, spacing: font.spacing ?? style?.spacing ?? 0 } : undefined;
      },
      hyperlink: (span, link, text) => {
        span.setAttribute("role", "link");
        span.setAttribute("tabindex", "0");
        span.setAttribute("data-framexml-hyperlink", link);
        span.style.cursor = "pointer";
        span.style.pointerEvents = "auto";
        const activate = (button: string): void => {
          this.#bridge?.fireScript(frame, "OnHyperlinkClick", link, text, button);
        };
        span.addEventListener("click", (event) => {
          event.stopPropagation?.();
          activate("LeftButton");
        });
        span.addEventListener("contextmenu", (event) => {
          event.preventDefault?.(); event.stopPropagation?.();
          activate("RightButton");
        });
        span.addEventListener("keydown", (event) => {
          if ((event as KeyboardEvent).key === "Enter" || (event as KeyboardEvent).key === " ") {
            event.preventDefault?.(); event.stopPropagation?.(); activate("LeftButton");
          }
        });
        span.addEventListener("mouseenter", () => this.#bridge?.fireScript(frame, "OnHyperlinkEnter", link, text));
        span.addEventListener("mouseleave", () => this.#bridge?.fireScript(frame, "OnHyperlinkLeave", link, text));
      },
      picture: (index, src) => {
        pictures = Math.max(pictures, index + 1);
        return this.bindPicture(rendered, `html:${index}`, src);
      },
    };
    buildFrameXmlSimpleHtml(held.layer, parseFrameXmlSimpleHtml(frame.text, linkFormat), hooks);
    // Give back the pictures of a longer page this one replaced.
    for (const slot of [...rendered.pictures.keys()]) {
      if (slot.startsWith("html:") && Number(slot.slice(5)) >= pictures) this.bindPicture(rendered, slot, "");
    }
  }

  /** Map a message frame's logical scroll offset to its layer's `scrollTop`; reads its layout. */
  private scrollMessageLayer(rendered: RenderedFrame): void {
    const layer = rendered.messageLayer;
    if (!layer) return;
    const { frame } = rendered;
    const scrollHeight = Number(layer.scrollHeight);
    const clientHeight = Number(layer.clientHeight);
    const pixelRange = Number.isFinite(scrollHeight) && Number.isFinite(clientHeight)
      ? Math.max(0, scrollHeight - clientHeight) : 0;
    const logicalRange = frame.scroll.verticalScrollRange;
    const fraction = logicalRange > 0
      ? Math.min(1, Math.max(0, frame.scroll.verticalScroll / logicalRange)) : 0;
    // L5 3.34: insertMode TOP draws the newest line first, so the current line is near the top.
    const top = frame.type === "ScrollingMessageFrame" && frame.messageFrame.insertMode === "TOP";
    // The bridge stores a stable logical line offset; the browser owns the actual
    // line wrapping and therefore the pixel range. This keeps bottom pinned after
    // a resize or a long wrapped message instead of treating one line as one pixel.
    if (typeof layer.scrollTop === "number") layer.scrollTop = pixelRange * (top && logicalRange > 0 ? 1 - fraction : fraction);
    // L5 3.34: the heights just read, for the runtime's scroll calls — how many lines can be in view
    // (the font's height in px, one more for a line cut at an edge) and whether every line is.
    if (frame.type === "ScrollingMessageFrame" && Number.isFinite(scrollHeight) && clientHeight > 0) {
      const fontPx = Number.parseFloat(layer.style.fontSize);
      frameXmlNoteMessageLayout(frame.messageFrame, fontPx > 0 ? Math.ceil(clientHeight / fontPx) + 1 : undefined, pixelRange < 1);
    }
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
    // A line drawn after it began to fade (a reveal, a rebuild) starts at its alpha now (3.34).
    if (frameXmlMessageAlphaReplaced(frame.messageFrame, message)) frameXmlPaintLineFade(line, frame.messageFrame, message); // L5 3.34: a held alpha too
    if (!hasFrameXmlEscapes(message.text)) line.textContent = message.text;
    else for (const run of parseFrameXmlText(message.text, true)) {
      const span = line.ownerDocument.createElement("span");
      span.textContent = run.text;
      if (run.color !== undefined) span.style.color = run.color;
      if (run.hyperlink !== undefined) {
        const link = run.hyperlink;
        span.setAttribute("role", "link");
        span.setAttribute("tabindex", "0");
        span.setAttribute("data-framexml-hyperlink", link);
        span.style.cursor = "pointer";
        span.style.pointerEvents = "auto";
        const activate = (button: string): void => {
          this.#bridge?.fireScript(frame, "OnHyperlinkClick", link, message.text, button);
        };
        span.addEventListener("click", (event) => {
          event.stopPropagation?.();
          activate("LeftButton");
        });
        span.addEventListener("contextmenu", (event) => {
          event.preventDefault?.(); event.stopPropagation?.();
          activate("RightButton");
        });
        span.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault?.(); event.stopPropagation?.(); activate("LeftButton");
          }
        });
        span.addEventListener("mouseenter", () => this.#bridge?.fireScript(frame, "OnHyperlinkEnter", link, message.text));
        span.addEventListener("mouseleave", () => this.#bridge?.fireScript(frame, "OnHyperlinkLeave", link, message.text));
      }
      line.append(span);
    }
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
   * Draw again every string that carries a `|3` declension — for the host, after it installs the
   * client's dictionary with `setFrameXmlDeclensionSource`: the strings already on the page were
   * declined without it, and an unchanged string is otherwise never parsed again. Answers how many.
   */
  refreshDeclinedText(): number {
    let redrawn = 0;
    for (const rendered of this.#rendered.values()) {
      const text = rendered.textSource;
      if (text === undefined || !text.includes("|3")) continue;
      const target = rendered.frame.type === "FontString" ? rendered.element : rendered.label;
      if (!target) continue;
      rendered.textSource = undefined;
      this.applyText(rendered, target, text);
      redrawn += 1;
    }
    return redrawn;
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
        indexHolder(this.#pictureHolders, wanted, rendered);
      } else {
        rendered.pictures.delete(slot);
      }
      if (held && ![...rendered.pictures.values()].includes(held)) unindexHolder(this.#pictureHolders, held, rendered);
    }
    return wanted ? source.peek(wanted) : undefined;
  }

  /**
   * A picture the texture source was still fetching has arrived: draw it on the frames holding it.
   *
   * The host's `FrameXmlTextureSource` calls this (through its `onChange`) instead of announcing a
   * frameless bridge change, which is structural and re-applied every drawn frame of the HUD —
   * measured on the rich route, 18 ms a picture on the fast cores and 33 ms on the slow ones, 606
   * times in the 12 s after a mount and once per new icon afterwards. Only the slots that hold
   * `path` are painted again, on frames that are drawn now; a hidden holder is applied in full when
   * it is next shown. A texture drawn at the picture's own size (an `<img>` with no width or no
   * height of its own) can change size when it arrives, so frames measured against it are placed
   * again, as a layout pass would.
   */
  pictureArrived(path: string, kind: "texture" | "edge" = "texture"): void {
    const holders = (kind === "edge" ? this.#edgeHolders : this.#pictureHolders).get(path);
    if (!holders || holders.size === 0) return;
    const perf = this.#perf;
    const started = perf ? performance.now() : 0;
    const run = (): void => {
      for (const rendered of [...holders]) {
        if (rendered.effectiveHidden !== false || this.#layoutOnly?.(rendered.frame)) continue;
        if (kind === "edge") {
          this.applyBackdrop(rendered);
          continue;
        }
        for (const [slot, held] of rendered.pictures) {
          if (held !== path) continue;
          if (slot === "texture") {
            this.applyTexture(rendered);
            const style = rendered.element.style;
            if (!style.width || !style.height) this.relayoutWhenDecoded(rendered);
          } else if (slot === "statusBar") this.applyStatusBar(rendered);
          else if (slot === "backdrop") this.applyBackdrop(rendered);
          else if (slot.startsWith("html:")) {
            // A SimpleHTML page's picture (3.35): the page is built again with its URL, once.
            this.applySimpleHtml(rendered, true);
            break;
          }
        }
      }
    };
    try {
      // Painted and measured on a page that shows every change already made.
      this.#bridge?.settleDeferredLayout();
      if (this.#bridge) this.#bridge.runInRenderPass(run);
      else run();
    } finally {
      perf?.picture?.(performance.now() - started);
    }
  }

  /**
   * An `<img>` with no width or no height of its own takes the picture's size, which the browser
   * knows only once the bytes are decoded — after `src` is set, not when. Its measured dependents
   * are placed again then. Measured on the rich route: 53 of the 10,932 textures, none drawn idle.
   */
  private relayoutWhenDecoded(rendered: RenderedFrame): void {
    const element = rendered.element as HTMLElement & { complete?: boolean };
    const settle = (): void => {
      if (this.#rendered.get(rendered.frame) !== rendered || rendered.effectiveHidden !== false) return;
      // Outside a pass (a `load` listener), held layout first: the relayout measures the page.
      this.#bridge?.settleDeferredLayout();
      if (this.#bridge) this.#bridge.runInRenderPass(() => this.relayout([rendered], true));
      else this.relayout([rendered], true);
    };
    if (element.complete === false && typeof element.addEventListener === "function") {
      element.addEventListener("load", settle, { once: true });
    } else settle();
  }

  /**
   * A font face finished loading: every string drawn in it has new metrics, which the page lays out
   * by itself. What the renderer measured from the old metrics — frames anchored to a string, a
   * string placed by a measured edge, tooltip boxes, scroll ranges — is measured again, instead of
   * the structural re-apply of every drawn frame a frameless `bridge.touch()` costs.
   */
  fontArrived(): void {
    const perf = this.#perf;
    const started = perf ? performance.now() : 0;
    const run = (): void => {
      const measured: RenderedFrame[] = [];
      for (const frame of this.#anchorTargets.keys()) {
        const drawn = this.#rendered.get(frame);
        if (drawn && drawn.effectiveHidden === false) measured.push(drawn);
      }
      for (const frame of this.#dependents.keys()) {
        const drawn = this.#rendered.get(frame);
        if (drawn && drawn.effectiveHidden === false) measured.push(drawn);
      }
      this.relayout(measured, true);
    };
    try {
      this.#bridge?.settleDeferredLayout();
      if (this.#bridge) this.#bridge.runInRenderPass(run);
      else run();
    } finally {
      perf?.picture?.(performance.now() - started);
    }
  }

  /**
   * The measured half of a layout pass for frames that changed size or position outside a sync:
   * their dependents through the anchor graph, then the tooltips, scroll ranges and slider inputs
   * the layout pass lays out. `placeSeeds` places the seeds themselves first (a frame whose own
   * placement was measured).
   */
  private relayout(seeds: readonly RenderedFrame[], placeSeeds = false): void {
    this.#screenRects.clear();
    const outer = this.#hiddenRefreshed;
    this.#hiddenRefreshed = new Set();
    try {
      if (placeSeeds) {
        const place = this.boundedPlacer();
        const queue: FrameXmlFrame[] = [];
        for (const rendered of seeds) {
          const frame = rendered.frame;
          // A seed that moved takes its drawn subtree with it; one that only changed size still
          // moves whatever is anchored to its far edges.
          if (this.#anchorTargets.has(frame) && place(frame)) this.collectMoved(frame, queue, place);
          else if (this.#dependents.has(frame)) queue.push(frame);
        }
        this.drainDependents(queue, place);
      } else {
        this.replaceDependents(seeds);
      }
      for (const rendered of this.#tooltips) if (!rendered.effectiveHidden) this.layoutGameTooltip(rendered);
      for (const rendered of this.#scrollFrames) if (!rendered.effectiveHidden) this.applyScrollFrame(rendered);
      for (const rendered of this.#sliders) if (!rendered.effectiveHidden) this.applySlider(rendered);
    } finally {
      this.#hiddenRefreshed = outer;
    }
  }

  private applyTexture(rendered: RenderedFrame): void {
    const { frame, element } = rendered;
    // `SetPortraitToTexture`: the picture cropped to the circle the portrait ring is cut for.
    const radius = frame.portrait ? "50%" : "";
    if ((element.style.borderRadius ?? "") !== radius) element.style.borderRadius = radius;
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

    const corners = frame.texCoords?.corners;
    if (corners) {
      // The eight-number form: the picture is laid out by `textureCornerTransform` in
      // `placeFrame`, and cut here to the quad the four corners name, in the image's own (untransformed)
      // coordinates — which that transform then lands exactly on the widget's box. No crop inset:
      // the host stylesheet's `[data-framexml-texcoords]` rules would re-crop the turned picture.
      element.removeAttribute("data-framexml-texcoords");
      element.style.removeProperty("--framexml-texcoord-inset");
      const [ulx, uly, llx, lly, urx, ury, lrx, lry] = corners;
      const clip = `polygon(${ulx * 100}% ${uly * 100}%, ${urx * 100}% ${ury * 100}%, `
        + `${lrx * 100}% ${lry * 100}%, ${llx * 100}% ${lly * 100}%)`;
      if (element.getAttribute("data-framexml-texcorners") !== clip) {
        element.setAttribute("data-framexml-texcorners", clip);
        element.style.setProperty("clip-path", clip);
      }
    } else if (element.getAttribute("data-framexml-texcorners") !== null) {
      element.removeAttribute("data-framexml-texcorners");
      element.style.removeProperty("clip-path");
    }
    if (frame.texCoords && !corners) {
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
    } else if (!corners) {
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
      // screen had no fade at all. A file, when there is one, keeps its own pixels. Only a colour
      // texture fills (`colorFill`): a bare `SetVertexColor` on a file-less Texture draws nothing.
      element.style.backgroundColor = source || !frame.colorFill ? "" : cssColor({ ...frame.vertexColor, a: 1 });
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
    // A vertex tint describes how to paint a *loaded* picture. While that picture is pending (or
    // missing), an <img> with no src must stay invisible or Chrome paints its white broken-image
    // placeholder in the item slot. A colour-only texture still paints its own rectangle.
    const blank = !resolved
      && (source !== "" || (!(frame.colorFill && frame.vertexColor) && !frame.gradient));
    if (blank) element.setAttribute("data-framexml-blank", "true");
    else element.removeAttribute("data-framexml-blank");
    // One property, three effects, composed rather than overwriting each other, in the order the
    // client shades a texel: grey it (`SetDesaturated`), multiply it by the vertex colour, and only
    // then turn it into the light an ADD picture adds. `grayscale(1)` and the ADD conversion use the
    // same Rec. 709 weights, so the grey-first order draws an untinted ADD picture exactly as the
    // former ADD-first order did; a tint is the one step that has to sit between them.
    const filters: string[] = [];
    if (frame.desaturated) filters.push("grayscale(1)");
    const tint = frame.vertexColor && resolved ? this.tintFilterId(frame.vertexColor) : undefined;
    if (tint) filters.push(`url(#${tint})`);
    if (additive && resolved) filters.push(`url(#${this.addFilterId()})`);
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
      // Hidden, the sweep is drawn again by `applyFrame` when it is shown; idle, it can only start
      // through `SetCooldown`, which moves the frame's version. Six hundred of the vertical's
      // Cooldown widgets are one or the other on any frame.
      if (rendered.effectiveHidden) continue;
      const version = rendered.frame.renderVersion;
      if (version !== undefined && rendered.cooldownIdleAt === version) continue;
      if (this.applyCooldown(rendered, now)) {
        running += 1;
        rendered.cooldownIdleAt = undefined;
      } else rendered.cooldownIdleAt = version;
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
      if (rendered.edge) {
        source.releaseEdge(rendered.edge);
        unindexHolder(this.#edgeHolders, rendered.edge, rendered);
      }
      rendered.edge = wanted || undefined;
      if (wanted) {
        source.acquireEdge(wanted);
        indexHolder(this.#edgeHolders, wanted, rendered);
      }
    }
    return wanted ? source.peekEdge(wanted) : undefined;
  }

  /**
   * A font object's style, whichever way the corpus declared it.
   *
   * The registered `<Font>`s answer first, exactly as before — every state font the stock button
   * templates name is one (`GameFontNormalSmall`, `GameFontHighlightSmallLeft`, …). The bridge's
   * `fontObjectStyle` covers the rest the same way Lua's `GetFontObject` does: a font object
   * declared as a virtual `<FontString>` (FrameXML has two, `WatchFontTemplate` and
   * `ClassColorLegendFontStringTemplate`) and a name asked for before `registerFontObjects` ran.
   */
  private fontStyleOf(name: string): FrameXmlFontStyle | undefined {
    if (!name) return undefined;
    return this.#bridge?.fontStyle(name) ?? this.#bridge?.fontObjectStyle(name);
  }

  /** A button's current state font: highlight under the pointer, disabled, else normal. */
  private buttonStateFont(button: FrameXmlFrame): string {
    const fonts = button.stateFonts;
    if (button.enabled && this.#hoveredButtons.has(button) && fonts.get("HIGHLIGHT")) return fonts.get("HIGHLIGHT")!;
    return (!button.enabled ? fonts.get("DISABLED") : undefined) || fonts.get("NORMAL") || button.fontObject;
  }

  /**
   * The font object one text widget is drawn in now. An inheriting `<ButtonText>` carries its
   * button's normal/disabled font in the bridge (`syncButtonLabelFont`); the highlight font is a
   * pointer state, so it is decided here and never written back to Lua.
   */
  private drawnFontObject(frame: FrameXmlFrame): string {
    const owner = frame.inheritsButtonFont ? frame.parent : undefined;
    if (owner && owner.enabled && this.#hoveredButtons.has(owner)) {
      return owner.stateFonts.get("HIGHLIGHT") || frame.fontObject;
    }
    return frame.fontObject;
  }

  private applyFontStyle(element: HTMLElement, frame: FrameXmlFrame): void {
    if (frame.type !== "FontString" && frame.type !== "EditBox" && frame.type !== "SimpleHTML"
      && frame.type !== "MessageFrame" && frame.type !== "ScrollingMessageFrame") return;
    const style = this.applyFontFace(element, frame, this.drawnFontObject(frame));
    if (frame.type === "FontString") {
      // Block alignment preserves the inline color runs and explicit newlines. Flex would turn
      // each WoW escape span into a separate item and change wrapping/justification.
      const vertical = frame.justifyV || style?.justifyV;
      element.style.alignContent = vertical === "TOP" ? "start" : vertical === "BOTTOM" ? "end" : "center";
      // A FontString wraps at its own width unless the corpus opts out: quest text, tooltips
      // and the character-creation info panels all rely on it, and none of them sets `wordWrap`.
      // `pre-wrap` keeps the authored `|n` line breaks that `pre` was originally set for.
      //
      // Widthless strings stay single-line: with no width to wrap against the original draws one
      // line, and that is also what keeps CENTER-anchored button labels whole — an absolutely
      // positioned shrink-to-fit box at `left: 50%` would otherwise wrap them at half the button.
      const wrapAttr = frame.attributes["wordWrap"];
      const hasWidth = (numberValue(frame.attributes["width"]) ?? 0) > 0;
      // A box that holds a single line never wraps, `wordWrap` or not: the client lays out as many
      // lines as fit the height and truncates the last with "…". Stock UIDropDownMenu sets its text
      // 155 wide and 10 high in GameFontHighlightSmall (10 px), and «Случайное подземелье Burning
      // Crusade» was drawn on two lines, over the dropdown's art.
      const fontHeight = numberValue(frame.attributes["fontHeight"]) ?? style?.height;
      const declaredHeight = numberValue(frame.attributes["height"]);
      const oneLine = declaredHeight !== undefined && declaredHeight > 0 && fontHeight !== undefined
        && fontHeight > 0 && declaredHeight < 2 * fontHeight;
      const wrap = !oneLine && (wrapAttr === "true" || (wrapAttr === undefined && hasWidth));
      element.style.whiteSpace = wrap ? "pre-wrap" : "pre";
      // `nonSpaceWrap` lets a line break inside a word with no space to break at, as the client's
      // flag does; the default breaks between words only.
      element.style.overflowWrap = wrap ? (frame.attributes["nonSpaceWrap"] === "true" ? "anywhere" : "break-word") : "";
      // An unwrapped line in a box with a width of its own — declared, or spanned by two anchors,
      // like the LFD list's dungeon name between its row's LEFT and the level text — stops at that
      // width with an ellipsis instead of running into the next column. Clipped on x only (`clip`,
      // unlike `hidden`, leaves the other axis visible), so descenders and the shadow still draw.
      const bounded = !wrap && (hasWidth || horizontallyPinned(frame));
      const overflowX = bounded ? "clip" : "";
      if (element.style.overflowX !== overflowX) element.style.overflowX = overflowX;
      const textOverflow = bounded ? "ellipsis" : "";
      if (element.style.textOverflow !== textOverflow) element.style.textOverflow = textOverflow;
      // …and a box of several lines shows the lines it holds, the last one ending in "…". The browser
      // drew the rest below the box, over the next widget: measured on the rich route,
      // `LootButton2Text` (93x38 in GameFontNormal, 12 px; LootFrame.xml:19-21) wrapped «Огромный
      // флакон с лечебным зельем» to four lines and painted «зельем» over `LootButton3`.
      //
      // `-webkit-line-clamp` is the clamp this Chrome has: an unprefixed `line-clamp: 3` left the box
      // `display: block` and every line painted. Measured in it: with `display: -webkit-box` and a
      // vertical orient the box computes to `flow-root`, so `align-content` still justifies the string
      // (a two-line label in a 38-unit box stays centred at 6/18), the ellipsis follows the last kept
      // line, and the lines after it are still painted unless the box clips — on y only, so the
      // shadow and the side bearings still draw. A line is one font height: every page sets
      // `line-height: 1` on the widgets. The box's
      // height is its declared one unless two vertical anchors pin it, and then it is left alone.
      // The inline display outranks the `[hidden]` rule of a page that does not make it `!important`
      // (glue.css), so it is written only while the string itself is shown; `parkHidden` drops it.
      const lines = wrap && declaredHeight !== undefined && fontHeight !== undefined && fontHeight > 0
        && !element.hidden && !verticallyPinned(frame) ? Math.floor(declaredHeight / fontHeight) : 0;
      const clamped = lines >= 2;
      if (clamped) {
        if (element.style.display !== "-webkit-box") element.style.display = "-webkit-box";
        if (element.style.webkitBoxOrient !== "vertical") element.style.webkitBoxOrient = "vertical";
        if (element.style.webkitLineClamp !== String(lines)) element.style.webkitLineClamp = String(lines);
        if (element.style.overflowY !== "clip") element.style.overflowY = "clip";
      } else if (element.style.webkitLineClamp) {
        element.style.display = "";
        element.style.webkitBoxOrient = "";
        element.style.webkitLineClamp = "";
        element.style.overflowY = "";
      }
    }
  }

  /**
   * The face, size, colour, alignment, shadow and outline of one font object on one element. Split
   * from `applyFontStyle` so a button's state font can dress a label that is not its own widget.
   */
  private applyFontFace(element: HTMLElement, frame: FrameXmlFrame, fontObject: string): FrameXmlFontStyle | undefined {
    const style = this.fontStyleOf(fontObject);
    if (fontObject) setAttributeIfChanged(element, "data-framexml-font", fontObject);
    const file = frame.attributes["fontFile"] ?? style?.file;
    // Lua may first name a face while opening an addon after the initial font registry was loaded.
    if (file && !this.#registeredFonts.has(file.toLowerCase())) {
      this.registerFonts([{ name: fontObject, file, monochrome: false }]);
    }
    const family = file ? this.#registeredFonts.get(file.toLowerCase()) : undefined;
    element.style.fontFamily = family ? `"${family}", sans-serif` : "";
    const height = numberValue(frame.attributes["fontHeight"]) ?? style?.height;
    element.style.fontSize = height === undefined ? "" : px(height);
    const color = frame.textColor ?? style?.color;
    element.style.color = color ? cssColor(color) : "";
    const justify = frame.justifyH || style?.justifyH;
    element.style.textAlign = justify === "LEFT" ? "left" : justify === "RIGHT" ? "right" : "center";
    // A shadow the string set for itself (`SetShadowColor`/`SetShadowOffset`, kept as attributes
    // by the widget layer) outranks the font object's, the way `fontFile`/`fontHeight` do above.
    const shadowColor = shadowColorAttribute(frame.attributes["shadowColor"]) ?? style?.shadowColor;
    if (shadowColor) {
      const dx = numberValue(frame.attributes["shadowOffsetX"]) ?? style?.shadowOffsetX ?? 1;
      const dy = -(numberValue(frame.attributes["shadowOffsetY"]) ?? style?.shadowOffsetY ?? -1);
      element.style.textShadow = `${px(dx)} ${px(dy)} 0 ${cssColor(shadowColor)}`;
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
    return style;
  }

  /**
   * The stock tooltip's rows, laid out the way the client sizes a GameTooltip: as wide as its
   * widest unwrapped row plus the template's text inset, never narrower than `SetMinimumWidth` and
   * never wider than the screen.
   *
   * This used to be a fixed box from the C-method's per-character estimate (7 units a character):
   * measured on the dev page, the 14px header «Боевой крик» is 82 units against an estimate of 77,
   * so a buff tooltip's title wrapped inside a 101-unit box, and every line had
   * `overflow-wrap: anywhere`, so it broke mid-word — «SpellID:» came out 16 units wide and four
   * lines tall. Now the box is sized by the browser from the rows themselves:
   *
   * - an unwrapped row (`wordWrap` false: titles, double lines, stat lines) is `white-space: pre`,
   *   which never wraps and keeps an explicit `\n`, and it is what the box's `max-content` width
   *   is made of;
   * - a wrapped row (`AddLine(…, wrap)`, prose) wraps at word boundaries and contributes at most
   *   `WRAP_WIDTH` to the box (`max-width`), while `min-width: 100%` lets it fill a box the
   *   unwrapped rows made wider;
   * - the columns are `auto auto`, not a flexible track: an item that spans a flexible track does
   *   not contribute to a grid's intrinsic width, and every single-column row spans both.
   *
   * The laid-out size is written back to the bridge (`recordLaidOutSize`, unannounced) so
   * `GetWidth`/`GetHeight` answer what is on the screen.
   */
  private layoutGameTooltip(rendered: RenderedFrame): void {
    const { frame, element } = rendered;
    // A hidden tooltip keeps no inline grid: that display would outrank `[hidden]`.
    if (rendered.effectiveHidden) return;
    const layout = FRAME_XML_TOOLTIP_LAYOUT;
    const prefix = `${frame.name}Text`;
    const rows = new Map<number, { left?: RenderedFrame; right?: RenderedFrame }>();
    const idle: RenderedFrame[] = [];
    /** Every row FontString, and the other children anchored to one (see the end of this method). */
    const lines = new Set<FrameXmlFrame>();
    const riders: FrameXmlFrame[] = [];
    for (const child of frame.children) {
      if (child.type !== "FontString" || !child.name.startsWith(prefix)) {
        if (child.points.some((point) => point.relativeTo?.parent === frame)) riders.push(child);
        continue;
      }
      const match = /^(Left|Right)(\d+)$/.exec(child.name.slice(prefix.length));
      const line = this.#rendered.get(child);
      if (!match || !line) continue;
      lines.add(child);
      if (line.effectiveHidden || !child.text) {
        idle.push(line);
        continue;
      }
      const index = Number(match[2]);
      const row = rows.get(index) ?? {};
      row[match[1] === "Left" ? "left" : "right"] = line;
      rows.set(index, row);
    }
    // A line that left the rows gives its grid cell back. Hidden ones are not drawn anyway; a shown
    // line with no text would otherwise stay a relatively positioned grid item holding a stale row.
    for (const line of idle) {
      const style = line.element.style;
      if (!style.gridRow && !style.gridColumn) continue;
      style.gridRow = "";
      style.gridColumn = "";
      style.position = "absolute";
    }
    if (rows.size === 0) return;
    const screen = this.#container.getBoundingClientRect?.();
    const parent = element.parentElement ?? this.#container;
    const parentRect = parent.getBoundingClientRect?.();
    const parentScale = parentRect && parent.offsetWidth > 0 ? parentRect.width / parent.offsetWidth : 1;
    const ownScale = Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : 1;
    const available = screen && screen.width > 0 && parentScale > 0
      ? Math.max(1, screen.width / (parentScale * ownScale) - 16) : 640;
    const floor = Math.min(available, Math.max(layout.MIN_WIDTH, frame.tooltipMinimumWidth ?? 0));
    element.style.boxSizing = "border-box";
    element.style.padding = px(layout.PADDING);
    element.style.display = "grid";
    element.style.width = "max-content";
    element.style.minWidth = px(floor);
    element.style.maxWidth = px(available);
    element.style.height = "auto";
    element.style.gridTemplateColumns = "auto auto";
    element.style.columnGap = px(layout.COLUMN_GAP);
    element.style.rowGap = px(layout.ROW_GAP);
    let index = 0;
    for (const [, row] of [...rows].sort(([left], [right]) => left - right)) {
      index++;
      for (const side of ["left", "right"] as const) {
        const line = row[side];
        if (!line) continue;
        const style = line.element.style;
        // Preserve the actual text/color spans. Grid lays out paragraphs, not the inline runs.
        style.position = "relative";
        for (const property of ["left", "right", "top", "bottom", "transform", "translate", "width", "height"]) {
          style.removeProperty(property);
        }
        if (line.frame.attributes["wordWrap"] === "true") {
          style.whiteSpace = "pre-wrap";
          style.overflowWrap = "break-word";
          style.maxWidth = px(Math.max(1, layout.WRAP_WIDTH - 2 * layout.PADDING));
          style.minWidth = "100%";
        } else {
          style.whiteSpace = "pre";
          style.overflowWrap = "normal";
          style.maxWidth = "";
          style.minWidth = "0px";
        }
        style.textAlign = side;
        style.alignContent = "start";
        style.gridRow = String(index);
        style.gridColumn = side === "right" ? "2" : row.right ? "1" : "1 / -1";
      }
    }
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0
      && this.#bridge?.recordLaidOutSize(frame, width, height)
      && frame.points.some((point) => point.relativeTo && point.relativeTo !== frame.parent)) {
      // An owner anchor (`SetOwner`'s ANCHOR_LEFT/BOTTOMLEFT/TOPRIGHT… put the tooltip's right or
      // bottom edge on the owner) was placed with the size the C-method estimated before this
      // paint; place it once more with the size just drawn.
      this.applyGeometry(element, frame);
      element.style.width = "max-content";
      element.style.height = "auto";
    }
    // A frame riding on a row — stock `SetTooltipMoney` puts its `TooltipMoneyFrameTemplate` at
    // `LEFT` of the blank row it just added (`GameTooltip.lua:124`) — was placed by the layout pass
    // against where that row stood *before* this grid took it: the row's own anchor chain, absolute
    // positions stacked from `TextLeft1`. Measured on the rich route (a priced two-handed axe, 14
    // rows): the coins drawn at y = 1617 against their row at y = 559, then at x + 168 on the next
    // hover. Placed again now, it measures the row where the grid put it.
    for (const rider of riders) {
      if (!rider.points.some((point) => point.relativeTo && lines.has(point.relativeTo))) continue;
      const drawn = this.#rendered.get(rider);
      if (!drawn || drawn.effectiveHidden) continue;
      this.applyGeometry(drawn.element, rider);
      this.#screenRects.delete(rider);
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

  /**
   * `<HighlightFont>`: a button's label switches to it under the pointer, and back on leave.
   *
   * Page-only, like the highlight texture's `:hover` rule — the bridge keeps the normal/disabled
   * font object, so a hover restyles one label and costs no render pass. Measured stock users:
   * `CharacterFrameTabButtonTemplate` (yellow GameFontNormalSmall → white GameFontHighlightSmall),
   * `UIPanelButtonTemplate` (GameFontNormal → GameFontHighlight).
   */
  private hoverButtonFont(frame: FrameXmlFrame, hovered: boolean): void {
    if (frame.type !== "Button" && frame.type !== "CheckButton") return;
    if (hovered) this.#hoveredButtons.add(frame);
    else this.#hoveredButtons.delete(frame);
    if (!frame.stateFonts.get("HIGHLIGHT")) return;
    const label = frame.stateTextures.get("BUTTONTEXT");
    if (label) {
      const drawn = this.#rendered.get(label);
      if (label.inheritsButtonFont && drawn && !drawn.effectiveHidden) this.applyFontStyle(drawn.element, label);
      return;
    }
    const own = this.#rendered.get(frame);
    if (own?.label && frame.text) this.applyButtonLabel(own.label, frame);
  }

  /**
   * The text a Button with no `<ButtonText>` was given, drawn the way the client's implicit font
   * string draws it: across the whole button, vertically centred, in the state font and justified
   * by that font — a Button has no justification of its own, its font string does.
   *
   * Left to the page, the label was an inline run inside a `<button>`, and the user-agent centres
   * those whatever the font says. Measured on the stock chat menu (`UIMenuButtonTemplate`, whose
   * `<NormalFont>` is `GameFontNormalLeft`): «Сказать» was drawn centred at x = 95 in a button
   * spanning 50…189, where the client starts it at the button's left edge.
   *
   * Only a button with a width of its own is spanned: a sizeless one keeps the label in flow, which
   * is what has always given such a button (a script's `CreateFrame("Button")` + `SetText` and no
   * `SetSize`) a box to click.
   *
   * Either way it is stacked where a template's `<ButtonText>` draws: OVERLAY, over the button's
   * Normal/Pushed/Disabled textures (ARTWORK, 300) and under the HIGHLIGHT one (500). With no stacking
   * of its own the span lay under them: measured on the rich route, UIPanelButtonGrayTemplate's
   * «Удалить» (MacroDeleteButton) and «По умолчанию» (KeyBindingFrameDefaultButton) were blank grey
   * plates. Only a label that carries text is positioned: 2,587 buttons draw on the rich route, and
   * an empty span needs no paint layer of its own.
   */
  private applyButtonLabel(label: HTMLElement, frame: FrameXmlFrame): void {
    const font = this.buttonStateFont(frame);
    const style = font ? this.applyFontFace(label, frame, font) : undefined;
    const justify = style?.justifyH || frame.justifyH;
    const align = justify === "LEFT" ? "left" : justify === "RIGHT" ? "right" : "center";
    label.style.textAlign = align;
    if (label.style.zIndex !== BUTTON_LABEL_Z) label.style.zIndex = BUTTON_LABEL_Z;
    if (!((numberValue(frame.attributes["width"]) ?? 0) > 0 || horizontallyPinned(frame))) {
      // `relative` stacks an in-flow label without moving it.
      if (label.style.position !== "relative") label.style.position = "relative";
      return;
    }
    label.style.position = "absolute";
    label.style.inset = "0";
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.justifyContent = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    label.style.whiteSpace = "pre";
  }

  /**
   * One frame's box on the logical screen — unscaled UI units, left origin, Y measured upward, the
   * frame `rememberCursor` gives the bridge the cursor in — for `IsMouseOver`.
   *
   * Kept until the next paint (see `#screenRects`), so the three `FCF_OnUpdate` questions per chat
   * window per frame read the layout once between paints, not once per call. A frame that is not
   * drawn answers `undefined` and the bridge falls back to its own anchor arithmetic.
   */
  private screenRectOf(frame: FrameXmlFrame): FrameXmlRect | undefined {
    const cached = this.#screenRects.get(frame);
    if (cached !== undefined) return cached ?? undefined;
    const rendered = this.#rendered.get(frame);
    let rect: FrameXmlRect | undefined;
    const box = rendered && !rendered.effectiveHidden ? this.#container.getBoundingClientRect?.() : undefined;
    const drawn = box ? rendered?.element.getBoundingClientRect?.() : undefined;
    if (box && drawn && box.width > 0 && box.height > 0) {
      const width = this.#container.offsetWidth || box.width;
      const height = this.#container.offsetHeight || box.height;
      const scaleX = width / box.width;
      const scaleY = height / box.height;
      const left = (drawn.left - box.left) * scaleX;
      const right = (drawn.right - box.left) * scaleX;
      const top = height - (drawn.top - box.top) * scaleY;
      const bottom = height - (drawn.bottom - box.top) * scaleY;
      rect = { left, right, top, bottom, width: right - left, height: top - bottom };
    }
    this.#screenRects.set(frame, rect ?? null);
    return rect;
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
    // `SetOwner(…, "ANCHOR_CURSOR")` is a GameTooltip method, so the tooltip index is the whole set.
    let tracking = false;
    for (const rendered of this.#tooltips) {
      if (rendered.frame.tooltipCursorAnchor && !rendered.effectiveHidden) tracking = true;
    }
    // A page off the display follows nothing (`setPointerTracking`).
    if (!tracking || this.#pointerPaused || this.#destroyed) {
      this.#cursorCleanup?.();
      this.#cursorCleanup = undefined;
      return;
    }
    if (this.#cursorCleanup) return;
    const doc = this.#container.ownerDocument;
    if (typeof doc?.addEventListener !== "function") return;
    const move = (event: Event): void => {
      this.rememberCursor(event);
      const follow = (): void => {
        for (const rendered of this.#tooltips) {
          if (rendered.frame.tooltipCursorAnchor && !rendered.effectiveHidden) {
            this.applyGeometry(rendered.element, rendered.frame);
            this.layoutGameTooltip(rendered);
            this.#screenRects.delete(rendered.frame);
          }
        }
      };
      // Laid out like a pass: on a page showing every change that can reach a following tooltip
      // (its lines, its parents), and without starting a pass inside this one. Once per move while
      // one follows the pointer, so a world event's text elsewhere does not cost a pass per move.
      for (const rendered of this.#tooltips) {
        if (rendered.frame.tooltipCursorAnchor && !rendered.effectiveHidden) this.#bridge?.settleDeferredLayout(rendered.frame);
      }
      if (this.#bridge) this.#bridge.runInRenderPass(follow);
      else follow();
    };
    doc.addEventListener("mousemove", move, true);
    this.#cursorCleanup = () => doc.removeEventListener("mousemove", move, true);
  }

  /**
   * Clip a ScrollFrame to its authored box and publish how far its content extends past it.
   *
   * The original clips unconditionally and reports the overflow through `OnScrollRangeChanged`,
   * which is what the stock scrollbar template (slider min/max, thumb visibility) listens to.
   * The Lua-facing scroll accessors already read and write `frame.scroll`, so publishing the
   * measured range here is what connects the existing slider chain to real layout: slider drags
   * and mouse-wheel steps land in `verticalScroll`, and the viewport follows through `scrollTop`.
   *
   * Stage children are laid out in UI units under a visual scale transform, so client/scroll
   * pixels read here are already the Lua units the range is reported in. Hosts without layout
   * (the DOM stub) report non-finite metrics and keep the previous Lua state untouched.
   */
  private applyScrollFrame(rendered: RenderedFrame): void {
    const { frame, element, scrollViewport } = rendered;
    if (!scrollViewport) return;
    // The stock UIPanelScrollFrame puts its scrollbar to the RIGHT of this rectangle.
    // Clipping the owner would hide that scrollbar and scroll its arrow buttons with the text.
    if (element.style.overflow !== "visible") element.style.overflow = "visible";
    const viewportHeight = Number(scrollViewport.clientHeight);
    const viewportWidth = Number(scrollViewport.clientWidth);
    const contentHeight = Number(scrollViewport.scrollHeight);
    const contentWidth = Number(scrollViewport.scrollWidth);
    const measurableY = Number.isFinite(viewportHeight) && Number.isFinite(contentHeight) && viewportHeight > 0;
    const measurableX = Number.isFinite(viewportWidth) && Number.isFinite(contentWidth) && viewportWidth > 0;
    const yrange = measurableY ? Math.max(0, contentHeight - viewportHeight) : frame.scroll.verticalScrollRange;
    const xrange = measurableX ? Math.max(0, contentWidth - viewportWidth) : frame.scroll.horizontalScrollRange;
    if ((measurableY || measurableX)
      && (yrange !== (rendered.scrollRange ?? 0) || xrange !== (rendered.horizontalScrollRange ?? 0))) {
      rendered.scrollRange = yrange;
      rendered.horizontalScrollRange = xrange;
      this.#bridge?.runInMutationBatch(() => {
        this.#bridge?.update(frame, (mutable) => {
          mutable.scroll.verticalScrollRange = yrange;
          mutable.scroll.horizontalScrollRange = xrange;
          mutable.scroll.verticalScroll = Math.max(0, Math.min(mutable.scroll.verticalScroll, yrange));
          mutable.scroll.horizontalScroll = Math.max(0, Math.min(mutable.scroll.horizontalScroll, xrange));
        });
        this.#bridge?.fireScript(frame, "OnScrollRangeChanged", xrange, yrange);
      });
    }
    if (typeof scrollViewport.scrollTop === "number" && scrollViewport.scrollTop !== frame.scroll.verticalScroll) {
      scrollViewport.scrollTop = frame.scroll.verticalScroll;
    }
    if (typeof scrollViewport.scrollLeft === "number" && scrollViewport.scrollLeft !== frame.scroll.horizontalScroll) {
      scrollViewport.scrollLeft = frame.scroll.horizontalScroll;
    }
  }

  /**
   * The invisible native range input under a Slider, and its THUMB placed at the value.
   *
   * Every layout pass applies every drawn slider — a stock scroll frame's scrollbar is one — so each
   * property is written only when it reads differently: the same values written back on every pass
   * were attribute and style invalidations for nothing. The final state is the one the unconditional
   * writes left, including a thumb whose own geometry a pass just re-applied.
   */
  private applySlider(rendered: RenderedFrame): void {
    const { frame, sliderInput } = rendered;
    if (!sliderInput) return;
    const { min, max, value, valueStep, orientation } = frame.slider;
    const vertical = orientation !== "HORIZONTAL";
    const minText = String(min);
    const maxText = String(Math.max(min, max));
    const stepText = valueStep > 0 ? String(valueStep) : "any";
    const valueText = String(value);
    const disabled = !frame.enabled || max <= min;
    if (sliderInput.min !== minText) sliderInput.min = minText;
    if (sliderInput.max !== maxText) sliderInput.max = maxText;
    if (sliderInput.step !== stepText) sliderInput.step = stepText;
    if (sliderInput.value !== valueText) sliderInput.value = valueText;
    if (sliderInput.disabled !== disabled) sliderInput.disabled = disabled;
    // WoW vertical scrollbars grow downward; horizontal sliders grow rightward.
    setStyleIfChanged(sliderInput, "writingMode", vertical ? "vertical-lr" : "horizontal-tb");
    setStyleIfChanged(sliderInput, "direction", "ltr");
    setAttributeIfChanged(sliderInput, "aria-orientation", vertical ? "vertical" : "horizontal");
    const thumb = frame.stateTextures.get("THUMB");
    const thumbElement = thumb ? this.#rendered.get(thumb)?.element : undefined;
    if (!thumbElement) return;
    const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
    setStyleIfChanged(thumbElement, "left", vertical ? "50%" : `${ratio * 100}%`);
    setStyleIfChanged(thumbElement, "top", vertical ? `${ratio * 100}%` : "50%");
    setStyleIfChanged(thumbElement, "right", "");
    setStyleIfChanged(thumbElement, "bottom", "");
    setStyleIfChanged(thumbElement, "transform", vertical ? `translate(-50%, ${-ratio * 100}%)`
      : `translate(${-ratio * 100}%, -50%)`);
    setStyleIfChanged(thumbElement, "pointerEvents", "none");
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
  ): boolean {
    const deferred = this.#deferredPlacements;
    if (deferred && measuresLayout(frame)) {
      deferred.push({ element, frame, declaredWidth, declaredHeight });
      return true;
    }
    const translated = element.style.translate;
    const moved = this.placeFrame(element, frame, declaredWidth, declaredHeight);
    return moved || element.style.translate !== translated;
  }

  /** `applyGeometry`'s body; answers whether any inline edge, size or transform was rewritten. */
  private placeFrame(
    element: HTMLElement,
    frame: FrameXmlFrame,
    declaredWidth?: number,
    declaredHeight?: number,
  ): boolean {
    this.indexAnchorTargets(frame);
    if (element.style.position !== "absolute") element.style.position = "absolute";
    const geometry: Partial<Record<"left" | "right" | "top" | "bottom" | "transform" | "width" | "height", string>> = {};
    const rawWidth = declaredWidth ?? numberValue(frame.attributes["width"]);
    // Stock tab labels use SetWidth(0) to restore their intrinsic width after clipping.
    const width = frame.type === "FontString" && rawWidth === 0 ? undefined : rawWidth;
    const height = declaredHeight ?? numberValue(frame.attributes["height"]);
    // A zero height on a FontString means "fit the text": the creation-screen info strings declare
    // `y="0"` and the original grows them over their wrapped lines. Writing `0px` collapses the
    // box while its unwrapped line still paints, which is the cut-off race/class text.
    const autoHeight = frame.type === "FontString" && height === 0;
    // A Lua reset to automatic text size must expose its intrinsic metrics before sibling
    // anchoring. Stable geometry is otherwise kept intact while we read the existing layout.
    if (frame.type === "FontString" && rawWidth === 0 && element.style.width) element.style.removeProperty("width");
    if (autoHeight && element.style.height) element.style.removeProperty("height");
    const commit = (): boolean => {
      let changed = false;
      for (const property of ["left", "right", "top", "bottom", "transform", "width", "height"] as const) {
        const value = geometry[property];
        if (value === undefined) {
          if (element.style[property]) {
            element.style.removeProperty(property);
            changed = true;
          }
        } else if (element.style[property] !== value) {
          element.style[property] = value;
          changed = true;
        }
      }
      return changed;
    };
    const scale = Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : 1;
    // Keep texture rotation/mirroring about the centre. The scale translation below keeps the
    // authored anchor fixed while leaving layout dimensions in the frame's own Lua units.
    if (element.style.transformOrigin !== "50% 50%") element.style.transformOrigin = "50% 50%";
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
    const corners = frame.type === "Texture" ? frame.texCoords?.corners : undefined;
    const mirrorX = frame.type === "Texture" && frame.texCoords !== undefined && !corners
      && frame.texCoords.left > frame.texCoords.right;
    const mirrorY = frame.type === "Texture" && frame.texCoords !== undefined && !corners
      && frame.texCoords.top > frame.texCoords.bottom;
    // The eight-number SetTexCoord is the innermost step: it puts the picture into the box, and
    // `SetRotation`, a scale and the centring translate then move the box as they always did.
    const turned = corners ? this.textureCornerTransform(element, frame, corners) : undefined;
    const textureMirrors = [
      ...(mirrorX ? ["scaleX(-1)"] : []),
      ...(mirrorY ? ["scaleY(-1)"] : []),
    ];
    const animated = frame.animationTransform ?? "";

    const points = frame.points;
    if (points.length === 0) {
      element.removeAttribute("data-framexml-point");
      element.removeAttribute("data-framexml-relative");
      if (width !== undefined) geometry.width = px(width);
      if (height !== undefined && !autoHeight) geometry.height = px(height);
      else if (autoHeight) delete geometry.height;
      const transform = [...scaleTransform(0, 0), animated, ...textureMirrors, rotation, turned]
        .filter(Boolean).join(" ");
      if (transform) geometry.transform = transform;
      const changed = commit();
      this.clampToScreen(element, frame);
      return changed;
    }
    const primary = points[0]!;
    element.setAttribute(
      "data-framexml-point",
      `${primary.point.toUpperCase()}:${(primary.relativePoint ?? primary.point).toUpperCase()}:${primary.x ?? 0}:${primary.y ?? 0}`,
    );
    if (primary.relativeTo) element.setAttribute("data-framexml-relative", primary.relativeTo.name);
    else element.removeAttribute("data-framexml-relative");

    // Each axis keeps at most one constraint per role — LEFT/RIGHT/CENTER, TOP/BOTTOM/CENTER — the
    // last anchor of a role winning, as the client keeps one anchor per point. A parent anchor is a
    // CSS expression of the containing block (a `left`/`top` distance, a `right`/`bottom` distance,
    // or a centre that a translate finishes); a sibling anchor is a measured number, in layout
    // pixels from the containing block's left/top edge. The axes are resolved separately below.
    //
    // They used to be resolved anchor by anchor, each overwriting `left`/`top`, so a *mixed* pair
    // came out as neither: the LFD list's dungeon name (LEFT on its row at 40, RIGHT on the level
    // text's LEFT at -10; LFGFrame.xml:118-134) was drawn at `left: 92px; top: 0px` with the parent
    // anchor's `translateY(-50%)` still on it — right-aligned against the level and half a row up.
    const xEdges: Partial<Record<"LEFT" | "RIGHT" | "CENTER", string | number>> = {};
    const yEdges: Partial<Record<"TOP" | "BOTTOM" | "CENTER", string | number>> = {};
    let lastX: "LEFT" | "RIGHT" | "CENTER" = "LEFT";
    let lastY: "TOP" | "BOTTOM" | "CENTER" = "TOP";
    for (const point of points) {
      const own = anchorRoles(point.point);
      const offsetX = (point.x ?? 0) * scale;
      // FrameXML's positive Y points upward; CSS's positive Y points downward.
      const offsetY = -(point.y ?? 0) * scale;
      const sibling = point.relativeTo && point.relativeTo !== frame.parent
        ? this.measureSibling(element, point.relativeTo)
        : undefined;
      lastX = own.x;
      lastY = own.y;
      if (sibling) {
        // A sibling anchor is positioned from measured rectangles (layout pixels, for the same
        // reason `offsetWithin` uses them: a client rectangle is in device pixels and the stage is
        // scaled), not from percentages of the containing block.
        const target = anchorRoles(point.relativePoint ?? point.point);
        xEdges[own.x] = sibling.x[target.x] + offsetX;
        yEdges[own.y] = sibling.y[target.y] + offsetY;
        continue;
      }
      // Without measurable geometry a cross-frame anchor degrades to the
      // frame's own edge on its parent — the same rectangle the anchor would
      // land on when the sibling fills the parent, and never an unpositioned
      // element stacked at the origin.
      const degraded = point.relativeTo !== undefined && point.relativeTo !== frame.parent;
      const target = degraded ? own : anchorRoles(point.relativePoint ?? point.point);
      const targetX = PARENT_ORIGIN.x[target.x];
      const targetY = PARENT_ORIGIN.y[target.y];
      xEdges[own.x] = own.x === "RIGHT" ? offsetExpression(invert(targetX), -offsetX) : offsetExpression(targetX, offsetX);
      yEdges[own.y] = own.y === "BOTTOM" ? offsetExpression(invert(targetY), -offsetY) : offsetExpression(targetY, offsetY);
    }
    // Authored dimensions win over an image's intrinsic size and the previous layout. Read only when
    // a measured edge other than the leading one needs the frame's own size, so unchanged CSS is
    // not re-measured per widget.
    const ownWidth = (): number => width ?? (typeof element.offsetWidth === "number" ? element.offsetWidth : 0);
    // A FontString's zero height is "fit the text" (`autoHeight` above), never a box of no height:
    // a sibling centre anchor that subtracted half of 0 put the skill rank's *top* on the row's
    // middle line, with the lower half of «407/450» under the next bar (SkillFrame.lua:81 anchors
    // it LEFT to the name's RIGHT, and the name is a centred parent anchor that never hit this).
    const ownHeight = (): number => (height !== undefined && !autoHeight)
      ? height : (typeof element.offsetHeight === "number" ? element.offsetHeight : 0);
    const x = resolveAnchorAxis(xEdges.LEFT, xEdges.RIGHT, xEdges.CENTER, lastX === "RIGHT", ownWidth);
    const y = resolveAnchorAxis(yEdges.TOP, yEdges.BOTTOM, yEdges.CENTER, lastY === "BOTTOM", ownHeight);
    if (x.start !== undefined) geometry.left = x.start;
    if (x.end !== undefined) geometry.right = x.end;
    if (x.span !== undefined) geometry.width = x.span;
    if (y.start !== undefined) geometry.top = y.start;
    if (y.end !== undefined) geometry.bottom = y.end;
    if (y.span !== undefined) geometry.height = y.span;
    const pinnedLeft = x.pinnedStart;
    const pinnedRight = x.pinnedEnd;
    const pinnedTop = y.pinnedStart;
    const pinnedBottom = y.pinnedEnd;
    const translateX = x.centred;
    const translateY = y.centred;
    // Only a single-edge anchor keeps the declared size; a pinned pair defines
    // the box itself, and re-applying width would fight the second anchor.
    // A sibling pair on opposing edges spans the distance the same way: the declared size only
    // serves a single-edge anchor (the three-slice `$parentMiddle` between `$parentLeft` and
    // `$parentRight`).
    const spannedX = x.span !== undefined;
    const spannedY = y.span !== undefined;
    if (width !== undefined && !(pinnedLeft && pinnedRight) && !spannedX) geometry.width = px(width);
    if (height !== undefined && !(pinnedTop && pinnedBottom) && !spannedY && !autoHeight) {
      geometry.height = px(height);
    } else if (autoHeight && !spannedY) {
      delete geometry.height;
    }
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
        const span = `100% - (${geometry.left}) - (${geometry.right})`;
        geometry.width = scale === 1 ? `calc(${span})` : `calc((${span}) / ${scale})`;
      }
      if (pinnedTop && pinnedBottom) {
        const span = `100% - (${geometry.top}) - (${geometry.bottom})`;
        geometry.height = scale === 1 ? `calc(${span})` : `calc((${span}) / ${scale})`;
      }
    }
    const anchor = anchorRoles(primary.point);
    const scaleX = pinnedLeft && pinnedRight ? 0 : anchor.x === "LEFT" ? 0 : anchor.x === "RIGHT" ? 1 : 0.5;
    const scaleY = pinnedTop && pinnedBottom ? 0 : anchor.y === "TOP" ? 0 : anchor.y === "BOTTOM" ? 1 : 0.5;
    geometry.transform = [
      ...(translateX ? ["translateX(-50%)"] : []),
      ...(translateY ? ["translateY(-50%)"] : []),
      ...scaleTransform(scaleX, scaleY),
      animated,
      ...textureMirrors,
      rotation,
      turned,
    ].filter(Boolean).join(" ");
    const changed = commit();
    this.clampToScreen(element, frame);
    return changed;
  }

  /**
   * `SetTexCoord(ULx, ULy, LLx, LLy, URx, URy, LRx, LRy)` as one CSS transform about the box's
   * centre (the transform origin every widget has): the affine map that takes the untransformed
   * picture — texture coordinate (u, v) at (u·w, v·h) of the box, `object-fit: fill` — to where the
   * client samples it, UL at the top-left corner, UR at the top-right and LL at the bottom-left.
   * `applyTexture` cuts the picture to the corners' quad in those same untransformed coordinates.
   *
   * With A = UR − UL, B = LL − UL and N = [A B]⁻¹, the box point q shows the texel
   * UL + A·q.x/w + B·q.y/h, so the picture moves by N about the centre: in pixels the linear part is
   * D·N·D⁻¹ (D = diag(w, h)) and the translation D·(N·(½ − UL) − ½). The translation is a
   * percentage of the box, so only the aspect w/h is needed — taken from the bridge's own anchor
   * walk, which has no rounding and forces no layout, and from the laid-out box without a bridge.
   *
   * Exact for a parallelogram of corners, which is every corpus call: the route line's rotation
   * (TaxiFrame.lua:224-252) and the flyout arrows' quarter turns (PaperDollFrame.lua:1158, 2143).
   * The client draws two triangles, so a quad whose LR is not UR + LL − UL differs in its LR half.
   * Outside the picture the client clamps to its edge texels where the page shows nothing; the
   * route line's picture has a clear border, so the two agree there.
   */
  private textureCornerTransform(
    element: HTMLElement,
    frame: FrameXmlFrame,
    corners: readonly [number, number, number, number, number, number, number, number],
  ): string | undefined {
    const [ulx, uly, llx, lly, urx, ury] = corners;
    const ax = urx - ulx;
    const ay = ury - uly;
    const bx = llx - ulx;
    const by = lly - uly;
    const determinant = ax * by - bx * ay;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
    let box: { readonly width: number; readonly height: number } | undefined = this.#bridge?.geometry(frame);
    if (!box || !(box.width > 0) || !(box.height > 0)) {
      box = { width: element.offsetWidth, height: element.offsetHeight };
    }
    if (!(box.width > 0) || !(box.height > 0)) return undefined;
    const aspect = box.width / box.height;
    const n11 = by / determinant;
    const n12 = -bx / determinant;
    const n21 = -ay / determinant;
    const n22 = ax / determinant;
    const tx = n11 * (0.5 - ulx) + n12 * (0.5 - uly) - 0.5;
    const ty = n21 * (0.5 - ulx) + n22 * (0.5 - uly) - 0.5;
    const round = (value: number): number => Math.round(value * 1e6) / 1e6 || 0;
    return `translate(${round(tx * 100)}%, ${round(ty * 100)}%) `
      + `matrix(${round(n11)}, ${round(n21 / aspect)}, ${round(n12 * aspect)}, ${round(n22)}, 0, 0)`;
  }

  /**
   * Keep the reverse anchor index current for one frame: the frames it is measured against (anchors
   * relative to anything but its parent), and whether one of them is hidden.
   */
  private indexAnchorTargets(frame: FrameXmlFrame): void {
    let targets: FrameXmlFrame[] | undefined;
    let hiddenTarget = false;
    for (const point of frame.points) {
      const target = point.relativeTo;
      if (!target || target === frame.parent) continue;
      if (!targets) targets = [target];
      else if (!targets.includes(target)) targets.push(target);
      if (this.#rendered.get(target)?.effectiveHidden) hiddenTarget = true;
    }
    this.indexAnchors(frame, targets);
    // Only a drawn frame: a hidden one is placed again when it is revealed, which re-applies it.
    if (hiddenTarget && this.#rendered.get(frame)?.effectiveHidden === false) this.#hiddenAnchored.add(frame);
    else if (this.#hiddenAnchored.size > 0) this.#hiddenAnchored.delete(frame);
  }

  private indexAnchors(frame: FrameXmlFrame, targets: readonly FrameXmlFrame[] | undefined): void {
    const previous = this.#anchorTargets.get(frame);
    if (previous === undefined && targets === undefined) return;
    if (previous && targets && previous.length === targets.length
      && previous.every((target, index) => target === targets[index])) return;
    for (const target of previous ?? []) {
      if (targets?.includes(target)) continue;
      const dependents = this.#dependents.get(target);
      dependents?.delete(frame);
      if (dependents?.size === 0) this.#dependents.delete(target);
    }
    for (const target of targets ?? []) {
      if (previous?.includes(target)) continue;
      let dependents = this.#dependents.get(target);
      if (!dependents) this.#dependents.set(target, (dependents = new Set()));
      dependents.add(frame);
    }
    if (targets) this.#anchorTargets.set(frame, targets);
    else this.#anchorTargets.delete(frame);
  }

  /**
   * Place again every drawn frame anchored to one of `moved` — the frames this pass re-applied,
   * which include every drawn descendant of a re-applied frame — and, when one of those comes out
   * somewhere else, everything anchored to it or to anything drawn inside it, transitively.
   *
   * The order is the anchor graph's, not the tree's, so a chain C → B → A settles in one pass when A
   * resizes, whatever order the three were created in. Each frame is placed at most
   * `MAX_PLACEMENTS_PER_PASS` times, which bounds an anchor cycle. Frames measured against a hidden
   * target are placed again as well (see `#hiddenAnchored`).
   */
  private replaceDependents(moved: readonly RenderedFrame[]): void {
    if (this.#dependents.size === 0 && this.#hiddenAnchored.size === 0) return;
    const queue: FrameXmlFrame[] = [];
    for (const rendered of moved) if (this.#dependents.has(rendered.frame)) queue.push(rendered.frame);
    const place = this.boundedPlacer();
    for (const frame of [...this.#hiddenAnchored]) if (place(frame)) this.collectMoved(frame, queue, place);
    this.drainDependents(queue, place);
  }

  /**
   * One pass's placement of a drawn frame through the anchor graph: at most
   * `MAX_PLACEMENTS_PER_PASS` times each, answering whether it came out somewhere else. A frame
   * that is not drawn is not placed (and leaves `#hiddenAnchored`); its reveal re-applies it.
   */
  private boundedPlacer(): (frame: FrameXmlFrame) => boolean {
    const placements = new Map<FrameXmlFrame, number>();
    return (dependent: FrameXmlFrame): boolean => {
      const drawn = this.#rendered.get(dependent);
      if (!drawn || drawn.effectiveHidden !== false) {
        this.#hiddenAnchored.delete(dependent);
        return false;
      }
      const count = placements.get(dependent) ?? 0;
      if (count >= MAX_PLACEMENTS_PER_PASS) return false;
      placements.set(dependent, count + 1);
      return this.applyGeometry(drawn.element, dependent);
    };
  }

  /** Place the dependents of every queued target, queueing in turn each one that moved. */
  private drainDependents(queue: FrameXmlFrame[], place: (frame: FrameXmlFrame) => boolean): void {
    for (let index = 0; index < queue.length; index += 1) {
      const dependents = this.#dependents.get(queue[index]!);
      if (!dependents) continue;
      for (const dependent of [...dependents]) if (place(dependent)) this.collectMoved(dependent, queue, place);
    }
  }

  /**
   * A frame came out somewhere else without being re-applied, and everything drawn inside it went
   * with it: queue it and its drawn descendants as anchor targets, place again the descendants that
   * are themselves measured against something (their distance to it changed), and move the strata
   * layers of descendants drawn above it. (A container resize has its own walk, `resizeWalk`.)
   */
  private collectMoved(
    frame: FrameXmlFrame,
    queue: FrameXmlFrame[],
    place: (frame: FrameXmlFrame) => boolean,
  ): void {
    if (this.#dependents.has(frame)) queue.push(frame);
    const owner = this.#rendered.get(frame);
    for (const child of frame.children) {
      const drawn = this.#rendered.get(child);
      if (!drawn || drawn.effectiveHidden !== false) continue;
      const layer = this.#strataLayers.get(child);
      if (layer && owner) this.placeStrataLayer(layer, owner);
      if (this.#anchorTargets.has(child)) place(child);
      this.collectMoved(child, queue, place);
    }
  }

  /** Every frame with a drawn strata layer below it: the layers' owners and their ancestors. */
  private layeredFrames(): Set<FrameXmlFrame> {
    const frames = new Set<FrameXmlFrame>();
    for (const child of this.#strataLayers.keys()) {
      if (this.#rendered.get(child)?.effectiveHidden !== false) continue;
      for (let at = child.parent, depth = 0; at && depth < 64 && !frames.has(at); at = at.parent, depth += 1) frames.add(at);
    }
    return frames;
  }

  /**
   * Lay the drawn strata layers below a frame that moved over their owners again, outer layers
   * first (an inner owner's box is read through the layers around it). `layered` is
   * `layeredFrames`, so the walk only goes down the paths that lead to a layer.
   */
  private placeLayersBelow(frame: FrameXmlFrame, layered: ReadonlySet<FrameXmlFrame>): void {
    const owner = this.#rendered.get(frame);
    if (!owner || owner.effectiveHidden !== false) return;
    for (const child of frame.children) {
      const layer = this.#strataLayers.get(child);
      if (layer && this.#rendered.get(child)?.effectiveHidden === false) this.placeStrataLayer(layer, owner);
      if (layered.has(child)) this.placeLayersBelow(child, layered);
    }
  }

  /**
   * `containerResized`'s walk below one drawn frame: strata layers and clamps are redone, a measured
   * frame is placed again unless the resize cannot have moved what it is measured against, and a
   * placement that moved queues everything inside it whose dependents are elsewhere.
   */
  private resizeWalk(
    frame: FrameXmlFrame,
    queue: FrameXmlFrame[],
    place: (frame: FrameXmlFrame) => boolean,
    fixed: Map<Element, boolean>,
  ): void {
    const owner = this.#rendered.get(frame);
    for (const child of frame.children) {
      const drawn = this.#rendered.get(child);
      if (!drawn || drawn.effectiveHidden !== false) continue;
      const layer = this.#strataLayers.get(child);
      if (layer && owner) this.placeStrataLayer(layer, owner);
      if (this.#anchorTargets.has(child)) {
        if (!this.resizeInvariant(child, drawn, fixed) && place(child)) this.queueMoved(child, queue);
      } else if (child.clampedToScreen) this.clampToScreen(drawn.element, child);
      this.resizeWalk(child, queue, place, fixed);
    }
  }

  /** A frame that moved, and every drawn frame inside it, as anchor targets whose dependents move. */
  private queueMoved(frame: FrameXmlFrame, queue: FrameXmlFrame[]): void {
    if (this.#dependents.has(frame)) queue.push(frame);
    for (const child of frame.children) {
      const drawn = this.#rendered.get(child);
      if (drawn && drawn.effectiveHidden === false) this.queueMoved(child, queue);
    }
  }

  /**
   * Whether a container resize leaves a measured frame where it is. A sibling anchor is a number
   * measured from the frame's containing block (`measureSibling`), and it cannot change when every
   * target is drawn in the same containing block and that block's size does not follow the
   * container (`fixedBox`): the target's CSS resolves against the same unchanged box, and a target
   * that is itself placed again queues its dependents if it moves. Anything else — a target in
   * another block or a strata layer, a hidden target, a clamp — is placed as before.
   */
  private resizeInvariant(frame: FrameXmlFrame, drawn: RenderedFrame, fixed: Map<Element, boolean>): boolean {
    if (frame.clampedToScreen) return false;
    const block = drawn.element.parentElement;
    if (!block || !this.fixedBox(block, fixed)) return false;
    for (const target of this.#anchorTargets.get(frame) ?? []) {
      const measured = this.#rendered.get(target);
      if (!measured || measured.effectiveHidden !== false || target.clampedToScreen) return false;
      if (measured.element.parentElement !== block) return false;
    }
    return true;
  }

  /**
   * Whether a drawn frame's box keeps its size when the container is resized: both dimensions in
   * pixels, or whatever is not in pixels (a pinned span's `calc`, content) resolved against a block
   * that keeps its own. The container and strata layers (boxes copied from their owners) never do.
   */
  private fixedBox(element: Element, memo: Map<Element, boolean>): boolean {
    const known = memo.get(element);
    if (known !== undefined) return known;
    let result = false;
    const box = element as HTMLElement;
    if (element !== this.#container && element.getAttribute("data-framexml-name") !== null
      && element.getAttribute("data-framexml-strata-layer") === null) {
      const pixels = /^-?\d+(?:\.\d+)?px$/;
      const width = pixels.test(box.style.width ?? "");
      const height = pixels.test(box.style.height ?? "");
      result = (width && height) || (element.parentElement !== null && this.fixedBox(element.parentElement, memo));
    }
    memo.set(element, result);
    return result;
  }

  /** A hidden intermediary still participates in the live anchor graph of visible widgets. */
  private refreshHiddenGeometry(frame: FrameXmlFrame): void {
    const rendered = this.#rendered.get(frame);
    if (!rendered?.effectiveHidden || this.#measuringHiddenGeometry.has(frame)) return;
    // Once per pass: every visible dependent of a hidden frame used to refresh its whole hidden
    // chain again, each hidden link refreshing its own hidden targets in turn — a count that grows
    // with the number of paths through the hidden anchor graph. Measured under the DOM stub with the
    // MPQ vertical and the TSAddons: 100,000+ refreshes of `LFRBrowseFrame`'s column chain in one sync.
    if (this.#hiddenRefreshed) {
      if (this.#hiddenRefreshed.has(frame)) return;
      this.#hiddenRefreshed.add(frame);
    }
    this.#measuringHiddenGeometry.add(frame);
    try {
      // Resolve hidden ancestors first, without revealing them or updating their paint/assets.
      if (frame.parent) this.refreshHiddenGeometry(frame.parent);
      this.applyGeometry(rendered.element, frame);
    } finally {
      this.#measuringHiddenGeometry.delete(frame);
    }
  }

  /** Anchor target edges in pixels inside this element's containing block. */
  private measureSibling(
    element: HTMLElement,
    target: FrameXmlFrame,
  ): {
    readonly x: Readonly<Record<"LEFT" | "RIGHT" | "CENTER", number>>;
    readonly y: Readonly<Record<"TOP" | "BOTTOM" | "CENTER", number>>;
  } | undefined {
    this.refreshHiddenGeometry(target);
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
  const parent = node.parentElement;
  // A hidden bottom/right-anchored widget has no offset geometry, but its containing block and its
  // own fixed FrameXML size are still authored inline. Resolve the missing leading edge before
  // accepting the browser's hidden-subtree zero. CharacterFrameTab1 is the important stock case:
  // Tab3 and Tab4 chain through a hidden Tab2, so one bogus top=0 moves the whole row to the title.
  //
  // Parent anchors are percentages of that block (`top: 50%` + a -50% translate for a LEFT anchor,
  // `calc(100% - …)` for a right edge), and they are resolved against it too: read as pixels only,
  // they fell back to the browser's zero. Measured on the LFD list: every row's check box is centred
  // on its hidden lock icon (LEFT, x = 25, i.e. `left: 25px; top: 50%`), and it came out at
  // `top: -10px`, half a row above its dungeon.
  const parentWidth = hidden && parent ? blockSize(parent, "width") : undefined;
  const parentHeight = hidden && parent ? blockSize(parent, "height") : undefined;
  const width = hidden ? inlineLength(node.style?.width, parentWidth) ?? node.offsetWidth : node.offsetWidth;
  const height = hidden ? inlineLength(node.style?.height, parentHeight) ?? node.offsetHeight : node.offsetHeight;
  const right = hidden ? inlineLength(node.style?.right, parentWidth) : undefined;
  const bottom = hidden ? inlineLength(node.style?.bottom, parentHeight) : undefined;
  const derivedLeft = right !== undefined && parentWidth !== undefined && typeof width === "number"
    ? parentWidth - right - width : undefined;
  const derivedTop = bottom !== undefined && parentHeight !== undefined && typeof height === "number"
    ? parentHeight - bottom - height : undefined;
  const left = hidden
    ? inlineLength(node.style?.left, parentWidth) ?? derivedLeft ?? node.offsetLeft
    : node.offsetLeft;
  const top = hidden
    ? inlineLength(node.style?.top, parentHeight) ?? derivedTop ?? node.offsetTop
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

/**
 * One size of a containing block, for resolving a hidden child's percentages: an inline pixel size,
 * else the laid-out one, else — a hidden block that is itself sized by percentages of its own
 * parent — its inline expression resolved against that parent, up the hidden chain.
 */
function blockSize(node: HTMLElement, axis: "width" | "height", depth = 0): number | undefined {
  const inline = node.style?.[axis];
  const pixels = inlinePixel(inline);
  if (pixels !== undefined) return pixels;
  const measured = axis === "width" ? node.offsetWidth : node.offsetHeight;
  if (typeof measured === "number" && measured > 0) return measured;
  const parent = node.parentElement;
  if (!parent || depth >= 64) return undefined;
  return inlineLength(inline, blockSize(parent, axis, depth + 1));
}

/**
 * An inline length the renderer wrote — `12px`, `50%`, `calc(100% - 70px)`,
 * `calc(100% - (40px) - (calc(100% - 150px)))` — in pixels of a containing block `base` units long.
 *
 * Only the linear forms `applyGeometry` emits are understood: numbers in `px` or `%`, `+ - * /`,
 * parentheses and nested `calc()`, where a product or quotient has a plain number on one side.
 * Anything else (`auto`, `max-content`, a `%` with no base) is `undefined`, the caller's cue to fall
 * back to the browser's own answer.
 */
function inlineLength(value: unknown, base: number | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const pixels = inlinePixel(value);
  if (pixels !== undefined) return pixels;
  const linear = parseCssLinear(value);
  if (!linear) return undefined;
  if (linear.percent === 0) return linear.pixels;
  if (base === undefined) return undefined;
  const resolved = linear.percent * base / 100 + linear.pixels;
  return Number.isFinite(resolved) ? resolved : undefined;
}

/** `a·% + b·px`, the value of a linear CSS length; a plain number has neither unit. */
interface CssLinear { readonly percent: number; readonly pixels: number; readonly number?: boolean }

function parseCssLinear(source: string): CssLinear | undefined {
  const tokens = source.match(/calc\(|[()+*/]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|%)?|-/gi);
  if (!tokens || tokens.join("").length !== source.replace(/\s+/g, "").length) return undefined;
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const expression = (): CssLinear | undefined => {
    let left = term();
    while (left && (peek() === "+" || peek() === "-")) {
      const sign = tokens[index++] === "+" ? 1 : -1;
      const right = term();
      if (!right || Boolean(left.number) !== Boolean(right.number)) return undefined;
      left = { percent: left.percent + sign * right.percent, pixels: left.pixels + sign * right.pixels,
        ...(left.number ? { number: true } : {}) };
    }
    return left;
  };
  const term = (): CssLinear | undefined => {
    let left = factor();
    while (left && (peek() === "*" || peek() === "/")) {
      const divide = tokens[index++] === "/";
      const right = factor();
      if (!right) return undefined;
      if (divide) {
        if (!right.number || right.pixels === 0) return undefined;
        left = { percent: left.percent / right.pixels, pixels: left.pixels / right.pixels,
          ...(left.number ? { number: true } : {}) };
      } else if (right.number) {
        left = { percent: left.percent * right.pixels, pixels: left.pixels * right.pixels,
          ...(left.number ? { number: true } : {}) };
      } else if (left.number) {
        left = { percent: right.percent * left.pixels, pixels: right.pixels * left.pixels };
      } else {
        return undefined;
      }
    }
    return left;
  };
  const factor = (): CssLinear | undefined => {
    const token = tokens[index++];
    if (token === undefined) return undefined;
    if (token === "(" || token.toLowerCase() === "calc(") {
      const inner = expression();
      return tokens[index++] === ")" ? inner : undefined;
    }
    if (token === "-") {
      const inner = factor();
      return inner && { percent: -inner.percent, pixels: -inner.pixels, ...(inner.number ? { number: true } : {}) };
    }
    const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|%)?$/i.exec(token);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;
    const unit = match[2]?.toLowerCase();
    return unit === "%" ? { percent: amount, pixels: 0 }
      : unit === "px" ? { percent: 0, pixels: amount }
        : { percent: 0, pixels: amount, number: true };
  };
  const result = expression();
  return result && index === tokens.length && !result.number ? result : undefined;
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

/** One axis of a frame's box, as CSS: see `resolveAnchorAxis`. */
interface AnchorAxis {
  /** `left`/`top`. */
  readonly start?: string;
  /** `right`/`bottom`, a distance from the containing block's far edge. */
  readonly end?: string;
  /** `width`/`height` between two measured edges. */
  readonly span?: string;
  readonly pinnedStart: boolean;
  readonly pinnedEnd: boolean;
  /** The start is a centre, finished by a -50% translate. */
  readonly centred: boolean;
}

/**
 * Resolve one axis from its three anchor roles. A string is a parent anchor's CSS (a start distance,
 * an end distance, or a centre); a number is a sibling anchor's measured edge, in layout pixels
 * from the containing block's start.
 *
 * - Both edges pin the box: two measured edges span it (`start` + `span`); a pair that involves a
 *   parent anchor writes both CSS edges and lets the containing block solve the size, a measured
 *   end becoming `calc(100% - edge)`. A measured pair that does not open (end ≤ start) keeps the
 *   later anchor, at the frame's own size.
 * - One edge, or only a centre, places the box at its own size; a measured end or centre needs
 *   that size now, a parent centre leaves it to the translate.
 */
function resolveAnchorAxis(
  start: string | number | undefined,
  end: string | number | undefined,
  centre: string | number | undefined,
  endLast: boolean,
  size: () => number,
): AnchorAxis {
  const placed = (value: string, centred = false): AnchorAxis =>
    ({ start: value, pinnedStart: !centred, pinnedEnd: false, centred });
  if (start !== undefined && end !== undefined) {
    if (typeof start === "number" && typeof end === "number") {
      if (end > start) return { start: px(start), span: px(end - start), pinnedStart: true, pinnedEnd: false, centred: false };
      return placed(px(endLast ? end - size() : start));
    }
    return {
      start: typeof start === "number" ? px(start) : start,
      end: typeof end === "number" ? `calc(100% - ${px(end)})` : end,
      pinnedStart: true,
      pinnedEnd: true,
      centred: false,
    };
  }
  if (start !== undefined) return placed(typeof start === "number" ? px(start) : start);
  if (end !== undefined) {
    return typeof end === "number" ? placed(px(end - size()))
      : { end, pinnedStart: false, pinnedEnd: true, centred: false };
  }
  if (centre !== undefined) {
    return typeof centre === "number" ? placed(px(centre - size() / 2)) : placed(centre, true);
  }
  return { pinnedStart: false, pinnedEnd: false, centred: false };
}

/** A CSS family name derived from the WoW font path, stable across reloads. */
export function fontFamilyName(file: string): string {
  const leaf = file.replaceAll("\\", "/").split("/").pop() ?? file;
  return `framexml-${leaf.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * How many of `previous`' first lines a paint drops when the rest of it is, in order and by identity,
 * the start of `current` and at least one line survives (or nothing was painted yet); -1 otherwise.
 */
function keptTail(previous: readonly FrameXmlMessage[], current: readonly FrameXmlMessage[]): number {
  let dropped = 0;
  if (previous.length > 0) {
    dropped = current.length > 0 ? previous.indexOf(current[0]!) : -1;
    if (dropped < 0) return -1;
  }
  const kept = previous.length - dropped;
  if (kept > current.length) return -1;
  for (let index = 0; index < kept; index++) if (current[index] !== previous[dropped + index]) return -1;
  return dropped;
}
