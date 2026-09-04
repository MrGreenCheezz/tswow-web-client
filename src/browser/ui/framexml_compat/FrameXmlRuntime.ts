import {
  FRAME_XML_DRAW_LAYERS,
  FRAME_XML_FONT_ELEMENT,
  FRAME_XML_MODEL_TYPES,
  FRAME_XML_WIDGET_TYPES,
  canonicalFrameXmlWidgetType,
  type FrameXmlAddonLoadResult,
  type FrameXmlBackdrop,
  type FrameXmlColor,
  type FrameXmlCooldownState,
  type FrameXmlDiagnostic,
  type FrameXmlEditBoxState,
  type FrameXmlElement,
  type FrameXmlFontStyle,
  type FrameXmlFrame,
  type FrameXmlGradient,
  type FrameXmlInsets,
  type FrameXmlModelState,
  type FrameXmlMessage,
  type FrameXmlMessageFrameState,
  type FrameXmlPoint,
  type FrameXmlRect,
  type FrameXmlScriptHandler,
  type FrameXmlScrollState,
  type FrameXmlSliderState,
  type FrameXmlStatusBarState,
  type FrameXmlTexCoords,
  type FrameXmlUiApi,
  type FrameXmlUiBridgeOptions,
  type LuaAddonRuntime,
  type LuaScriptContext,
} from "./FrameXmlTypes.js";
import {
  frameXmlAttributeCandidates,
  frameXmlAttributeKey,
  frameXmlAttributeValue,
} from "./FrameXmlAttributes.js";
import {
  FrameXmlTemplateRegistry,
  frameXmlAttribute,
  frameXmlBoolean,
  frameXmlChild,
  frameXmlLastChild,
  frameXmlNumber,
  mergeFrameXmlElements,
  parseFrameXml,
} from "./FrameXmlParser.js";

// Keep the runtime's public type spelling local until FrameXmlTypes can be
// consumed by generated declaration users. The cast is constrained by the
// allow-list above and never exposes a DOM node.
type RuntimeWidgetType = Extract<FrameXmlFrame["type"], string>;

/** Lower-cased widget name to its canonical spelling, for `CreateFrame`'s free-form type. */
const WIDGET_TYPE_BY_LOWER_CASE: ReadonlyMap<string, string> = new Map(
  [...FRAME_XML_WIDGET_TYPES].map((type) => [type.toLowerCase(), type]),
);

/**
 * The canonical spelling of a `CreateFrame` type argument, or undefined.
 *
 * 3.3.5's `CreateFrame` matches the type name case-insensitively, and the
 * corpus relies on it: `GlueDropDownMenu.lua:159` is
 * `CreateFrame("BUTTON", listFrameName .. "Button" .. index, listFrame,
 * "GlueDropDownMenuButtonTemplate")`. An exact-case lookup returned nil there,
 * the next `:SetID(index)` indexed it, and the login screen came up with the
 * corpus' own error dialog reading «attempt to index a nil value» over the top
 * of everything — measured in the live page before this fix.
 */
function canonicalWidgetType(type: string): string | undefined {
  return WIDGET_TYPE_BY_LOWER_CASE.get(type.trim().toLowerCase());
}

/**
 * Measured 3.3.5 handler signatures.
 *
 * This table is not decorative: an XML script body has no `function` header, so
 * the bridge has to compile it with exactly these parameter names. The glue
 * corpus writes `AccountLogin_OnKeyDown(key)`, `GlueParent_OnEvent(event, ...)`
 * and `LoginScreen_OnUpdate(self, elapsed)` straight into the body and would
 * see nil for every one of them if the names were wrong. Names came from the
 * corpus itself (`CharacterSelect_OnKeyDown(self,key)`,
 * `VideoOptionsEffectsPanelSlider_OnValueChanged(self, value)`, …), not from a
 * wiki page.
 */
export const FRAME_XML_SCRIPT_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  OnLoad: ["self"],
  OnShow: ["self"],
  OnHide: ["self"],
  OnEnter: ["self", "motion"],
  OnLeave: ["self", "motion"],
  OnUpdate: ["self", "elapsed"],
  OnEvent: ["self", "event"],
  OnClick: ["self", "button", "down"],
  OnDoubleClick: ["self", "button"],
  OnMouseDown: ["self", "button"],
  OnMouseUp: ["self", "button"],
  OnMouseWheel: ["self", "delta"],
  OnKeyDown: ["self", "key"],
  OnKeyUp: ["self", "key"],
  OnChar: ["self", "text"],
  OnValueChanged: ["self", "value"],
  OnTextChanged: ["self", "isUserInput"],
  OnEnterPressed: ["self"],
  OnEscapePressed: ["self"],
  OnSpacePressed: ["self"],
  OnTabPressed: ["self"],
  OnEditFocusGained: ["self"],
  OnEditFocusLost: ["self"],
  OnVerticalScroll: ["self", "offset"],
  OnHorizontalScroll: ["self", "offset"],
  OnScrollRangeChanged: ["self", "xrange", "yrange"],
  OnHyperlinkClick: ["self", "link", "text", "button"],
  OnUpdateModel: ["self"],
  OnMovieFinished: ["self"],
  OnMovieShowSubtitle: ["self", "text"],
  OnMovieHideSubtitle: ["self"],
  OnSizeChanged: ["self", "width", "height"],
  OnDragStart: ["self", "button"],
  OnDragStop: ["self"],
  OnReceiveDrag: ["self"],
});

/** Everything the bridge treats as a script node inside `<Scripts>`. */
const SCRIPT_NODE = /^On[A-Z][A-Za-z0-9_]*$/;

function truthyAttribute(value: string | undefined): boolean {
  return value !== undefined && /^(?:1|true|yes)$/i.test(value.trim());
}

function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * FrameXML normally declares dimensions as `<Size><AbsDimension x="..."
 * y="..."/></Size>`, rather than as HTML-like attributes.  Templates are
 * merged in source order, so applying every declared component in order gives
 * derived templates a safe partial override while retaining an inherited axis
 * that they did not specify.  The corpus also uses the terse `<Size x=".."
 * y=".."/>` spelling, which is why both levels are read.
 */
function effectiveSizeAttributes(element: FrameXmlElement): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = { ...element.attributes };
  const explicitWidth = attributes["width"] !== undefined;
  const explicitHeight = attributes["height"] !== undefined;
  for (const size of element.children) {
    if (size.name !== "Size") continue;
    const dimensions = frameXmlChild(size, "AbsDimension");
    const x = frameXmlAttribute(size, "x") ?? (dimensions ? frameXmlAttribute(dimensions, "x") : undefined);
    const y = frameXmlAttribute(size, "y") ?? (dimensions ? frameXmlAttribute(dimensions, "y") : undefined);
    if (!explicitWidth && x !== undefined) attributes["width"] = x;
    if (!explicitHeight && y !== undefined) attributes["height"] = y;
  }
  return Object.freeze(attributes);
}

function isWidget(element: FrameXmlElement): boolean {
  return FRAME_XML_WIDGET_TYPES.has(element.name);
}

function anchorRoles(point: string): {
  readonly x: "LEFT" | "RIGHT" | "CENTER";
  readonly y: "TOP" | "BOTTOM" | "CENTER";
} {
  const name = point.toUpperCase();
  return {
    x: name.includes("LEFT") ? "LEFT" : name.includes("RIGHT") ? "RIGHT" : "CENTER",
    y: name.includes("TOP") ? "TOP" : name.includes("BOTTOM") ? "BOTTOM" : "CENTER",
  };
}

function isVirtual(element: FrameXmlElement): boolean {
  return truthyAttribute(frameXmlAttribute(element, "virtual"));
}

const DECLARATION_CONTAINERS = new Set(["Scripts", "Events", "Frames", "Layers", "Layer"]);

interface Declarations {
  readonly scriptSources: Map<string, string>;
  readonly scriptFunctions: Map<string, string>;
  readonly events: Set<string>;
}

interface PendingRelativePoint {
  readonly frame: MutableFrameXmlFrame;
  readonly index: number;
  readonly relativeName: string;
}

function collectDeclarations(element: FrameXmlElement): Declarations {
  const scriptSources = new Map<string, string>();
  const scriptFunctions = new Map<string, string>();
  const events = new Set<string>();
  const visit = (current: FrameXmlElement, declarationScope: boolean): void => {
    const name = current.name;
    if (SCRIPT_NODE.test(name)) {
      const body = current.text.trim();
      // `function="Global_Name"` is the other half of the grammar: 11 of the
      // corpus' `OnValueChanged` nodes carry no body at all and only name a
      // global. Both spellings are recorded; a later declaration (a derived
      // template, or the concrete frame) replaces the inherited one.
      const named = frameXmlAttribute(current, "function")?.trim();
      if (body) scriptSources.set(name, body);
      else if (named) scriptSources.delete(name);
      if (named) scriptFunctions.set(name, named);
      else if (body) scriptFunctions.delete(name);
      return;
    }
    if (name === "Event") {
      const eventName = frameXmlAttribute(current, "name")?.trim() ?? current.text.trim();
      if (eventName) events.add(eventName);
      return;
    }
    // Wrapper containers (Frames/Layers/etc.) may be nested inside the
    // current frame, but a nested widget starts a new declaration scope.  Do
    // not let a child's OnLoad/OnEvent overwrite the parent's handlers while
    // walking through a wrapper.
    if (current !== element && isWidget(current)) return;
    const nextScope = declarationScope || DECLARATION_CONTAINERS.has(name);
    for (const child of current.children) visit(child, nextScope);
  };
  visit(element, false);
  return { scriptSources, scriptFunctions, events };
}

function colorOf(element: FrameXmlElement | undefined): FrameXmlColor | undefined {
  if (!element) return undefined;
  return {
    r: frameXmlNumber(element, "r") ?? 1,
    g: frameXmlNumber(element, "g") ?? 1,
    b: frameXmlNumber(element, "b") ?? 1,
    a: frameXmlNumber(element, "a") ?? 1,
  };
}

function insetsOf(element: FrameXmlElement | undefined): FrameXmlInsets | undefined {
  if (!element) return undefined;
  const abs = frameXmlChild(element, "AbsInset") ?? element;
  return {
    left: frameXmlNumber(abs, "left") ?? 0,
    right: frameXmlNumber(abs, "right") ?? 0,
    top: frameXmlNumber(abs, "top") ?? 0,
    bottom: frameXmlNumber(abs, "bottom") ?? 0,
  };
}

/** `<EdgeSize><AbsValue val="32"/></EdgeSize>` and its terse `val=` spelling. */
function absValueOf(element: FrameXmlElement | undefined): number | undefined {
  if (!element) return undefined;
  const abs = frameXmlChild(element, "AbsValue");
  return frameXmlNumber(abs ?? element, "val") ?? frameXmlNumber(element, "val");
}

function dimensionOf(element: FrameXmlElement | undefined): { readonly x: number; readonly y: number } | undefined {
  if (!element) return undefined;
  const abs = frameXmlChild(element, "AbsDimension") ?? element;
  return { x: frameXmlNumber(abs, "x") ?? 0, y: frameXmlNumber(abs, "y") ?? 0 };
}

class MutableFrameXmlFrame implements FrameXmlFrame {
  readonly type: RuntimeWidgetType;
  readonly name: string;
  readonly named: boolean;
  parent?: FrameXmlFrame;
  readonly children: FrameXmlFrame[] = [];
  attributes: Readonly<Record<string, string>>;
  points: FrameXmlPoint[] = [];
  readonly scriptSources: ReadonlyMap<string, string>;
  readonly scriptFunctions: ReadonlyMap<string, string>;
  readonly registeredEvents: Set<string>;
  readonly scripts = new Map<string, FrameXmlScriptHandler>();
  /** Handlers appended with HookScript; they run after the primary handler. */
  readonly scriptHooks = new Map<string, FrameXmlScriptHandler[]>();
  /** Lazily compiled XML bodies, so OnUpdate does not recompile 60 times a second. */
  readonly compiledScripts = new Map<string, FrameXmlScriptHandler | null>();
  /** SetScript replaces an XML handler, including when the replacement is nil. */
  readonly scriptOverrides = new Set<string>();
  visible: boolean;
  text = "";
  texture = "";
  loaded = false;

  drawLayer = "ARTWORK";
  drawSubLevel = 0;
  texCoords: FrameXmlTexCoords | undefined;
  vertexColor: FrameXmlColor | undefined;
  gradient: FrameXmlGradient | undefined;
  alphaMode = "BLEND";
  desaturated = false;
  textureRotation = 0;
  readonly clickRegistrations = new Set<string>();
  readonly dragRegistrations = new Set<string>();
  clampedToScreen = false;
  movable = false;
  moving = false;
  tooltipCursorAnchor: { readonly x: number; readonly y: number } | undefined;
  backdrop: FrameXmlBackdrop | undefined;
  backdropColor: FrameXmlColor | undefined;
  backdropBorderColor: FrameXmlColor | undefined;
  fontObject = "";
  textColor: FrameXmlColor | undefined;
  justifyH = "CENTER";
  justifyV = "MIDDLE";
  readonly stateTextures = new Map<string, FrameXmlFrame>();
  stateTexture = "";
  readonly stateFonts = new Map<string, string>();
  buttonState = "NORMAL";
  highlightLocked = false;
  enabled = true;
  checked = false;
  alpha = 1;
  scale = 1;
  frameLevel = 0;
  frameStrata = "MEDIUM";
  toplevel = false;
  id = 0;
  setAllPoints = false;
  parentKey = "";
  hitRectInsets: FrameXmlInsets | undefined;
  textInsets: FrameXmlInsets | undefined;
  /** `SetAttribute`/`GetAttribute`, keyed by `frameXmlAttributeKey`; see the interface. */
  readonly secureAttributes = new Map<string, unknown>();
  readonly cooldown: FrameXmlCooldownState = { start: 0, duration: 0 };
  readonly model: FrameXmlModelState = { file: "", scale: 1, calls: [] };
  readonly editBox: FrameXmlEditBoxState = {
    letters: 0, password: false, numeric: false, multiLine: false, historyLines: 0, focused: false,
    history: [], historyIndex: -1, cursorPosition: 0,
  };
  readonly messageFrame: FrameXmlMessageFrameState = {
    maxLines: 128, displayDuration: 0, nonSpaceWrap: false, messages: [], revision: 0,
  };
  readonly slider: FrameXmlSliderState = {
    min: 0, max: 0, value: 0, valueStep: 0, orientation: "VERTICAL",
  };
  readonly statusBar: FrameXmlStatusBarState = {
    min: 0, max: 0, value: 0, valueStep: 0, orientation: "HORIZONTAL",
    texture: "", color: { r: 1, g: 1, b: 1, a: 1 },
  };
  readonly scroll: FrameXmlScrollState = {
    horizontalScroll: 0, verticalScroll: 0, horizontalScrollRange: 0, verticalScrollRange: 0,
  };

  constructor(
    type: RuntimeWidgetType,
    name: string,
    named: boolean,
    attributes: Readonly<Record<string, string>>,
    parent: FrameXmlFrame | undefined,
    declarations: Declarations,
  ) {
    this.type = type;
    this.name = name;
    this.named = named;
    if (parent !== undefined) this.parent = parent;
    this.attributes = Object.freeze({ ...attributes });
    this.scriptSources = new Map(declarations.scriptSources);
    this.scriptFunctions = new Map(declarations.scriptFunctions);
    this.registeredEvents = new Set(declarations.events);
    this.visible = !truthyAttribute(attributes["hidden"]);
    this.text = attributes["text"] ?? "";
    this.texture = attributes["file"] ?? attributes["texture"] ?? "";
  }

  /** Width/height are attribute-backed so `<Size>`, `width=` and SetWidth agree. */
  setAttribute(key: string, value: string | undefined): void {
    const next: Record<string, string> = { ...this.attributes };
    if (value === undefined) delete next[key];
    else next[key] = value;
    this.attributes = Object.freeze(next);
  }
}

/**
 * In-memory WoW UI API surface. It deliberately stores state rather than
 * creating HTML; the native HUD has no shared mutation path and a Lua adapter
 * receives only this capability object plus the widgets it created.
 */
/** The renderer packs one strata into a thousand z-index values; a raise may not leave the band. */
const TOPLEVEL_MAX_FRAME_LEVEL = 999;

export class FrameXmlUiBridge implements FrameXmlUiApi {
  readonly #registry: FrameXmlTemplateRegistry;
  #runtime: LuaAddonRuntime | undefined;
  readonly #diagnostics: FrameXmlDiagnostic[] = [];
  readonly #diagnosticSink: ((diagnostic: FrameXmlDiagnostic) => void) | undefined;
  #globalStringResolver: ((key: string) => string | undefined) | undefined;
  readonly #frames = new Set<MutableFrameXmlFrame>();
  readonly #byName = new Map<string, MutableFrameXmlFrame>();
  readonly #pendingRelativePoints: PendingRelativePoint[] = [];
  readonly #unavailableScriptNotices = new Set<string>();
  readonly #mutationListeners = new Set<() => void>();
  /** event name -> frames registered for it; kept so dispatch is not O(all frames). */
  readonly #byEvent = new Map<string, Set<MutableFrameXmlFrame>>();
  /**
   * Frames with any OnUpdate at all. The corpus declares 33 of them across
   * ~2,000 widgets, so ticking the index instead of the whole set is the
   * difference between a per-frame walk of tens and one of thousands.
   */
  readonly #updateFrames = new Set<MutableFrameXmlFrame>();
  readonly #createdRoots: FrameXmlFrame[] = [];
  /** Frames created through the Lua/host CreateFrame APIs, for root bookkeeping after SetParent. */
  readonly #createdFrames = new Set<MutableFrameXmlFrame>();
  readonly #modelFrames = new Set<FrameXmlFrame>();
  #measure: ((frame: FrameXmlFrame) => { width: number; height: number } | undefined) | undefined;
  #mousePosition: readonly [number, number] = [0, 0];
  readonly #fontStyles = new Map<string, FrameXmlFontStyle>();
  /** `fontObjectStyle`'s cache; a superset of `#fontStyles`, filled on demand. */
  readonly #fontObjectStyles = new Map<string, FrameXmlFontStyle>();
  #anonymousId = 0;
  /** `<Attribute>` elements applied while instantiating; a census number, nothing reads it twice. */
  #declaredAttributes = 0;
  #dispatchDepth = 0;
  #mutationDepth = 0;
  #pendingNotification = false;
  #mutationVersion = 0;

  constructor(registry = new FrameXmlTemplateRegistry(), options: FrameXmlUiBridgeOptions = {}) {
    this.#registry = registry;
    this.#runtime = options.runtime;
    this.#diagnosticSink = options.onDiagnostic;
    this.#globalStringResolver = options.globalStringResolver;
  }

  get registry(): FrameXmlTemplateRegistry {
    return this.#registry;
  }

  get diagnostics(): readonly FrameXmlDiagnostic[] {
    return [...this.#diagnostics];
  }

  /** Monotonic host-side revision; renderers use it to skip idempotent syncs. */
  get mutationVersion(): number {
    return this.#mutationVersion;
  }

  get frames(): readonly FrameXmlFrame[] {
    return [...this.#frames];
  }

  /** Every `Model`/`ModelFFX` widget, in creation order. The 3D layer's work list. */
  /** Secure attributes this bridge applied from XML `<Attributes>` blocks. */
  get declaredAttributes(): number {
    return this.#declaredAttributes;
  }

  get modelFrames(): ReadonlySet<FrameXmlFrame> {
    return this.#modelFrames;
  }

  /**
   * Let a host answer "how big is this widget really".
   *
   * The bridge holds declarations, not geometry: a frame with `setAllPoints` and no size attribute
   * has no width of its own to report, and `GlueParent` is exactly that. The corpus asks anyway —
   * `lgzg.lua`'s `LoginScreen_OnLoad` opens with `local width, height = GlueParent:GetSize()` and
   * sizes the entire login scene from it — so `GetSize` returning the declared 0x0 collapsed the
   * background, the logo and all thirty models to nothing. Measured in the live page: `LoginScene`
   * laid out at 0 wide with a 1x250 background inside it.
   *
   * The host that owns the document is the only thing that knows, so it hands the answer back.
   */
  setMeasure(measure: ((frame: FrameXmlFrame) => { width: number; height: number } | undefined) | undefined): void {
    this.#measure = measure;
  }

  /** Trusted host cursor coordinates in logical UI units, with Y measured from the bottom. */
  setMousePosition(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) this.#mousePosition = [x, y];
  }

  get mousePosition(): readonly [number, number] { return this.#mousePosition; }

  /** Effective size: what the host laid out, or the declared attributes when nothing has. */
  measure(frame: FrameXmlFrame): { readonly width: number; readonly height: number } {
    const measured = this.#measure?.(frame);
    const declaredWidth = Number(frame.attributes["width"]);
    const declaredHeight = Number(frame.attributes["height"]);
    return {
      width: measured && measured.width > 0 ? measured.width
        : Number.isFinite(declaredWidth) ? declaredWidth : 0,
      height: measured && measured.height > 0 ? measured.height
        : Number.isFinite(declaredHeight) ? declaredHeight : 0,
    };
  }

  /** Resolve the small rectangle surface used by stock chat docking code. */
  geometry(frame: FrameXmlFrame): FrameXmlRect {
    // Keep anchor recursion in CSS/top-origin coordinates. The public WoW
    // methods use a bottom-origin vertical axis, so converting each recursive
    // rectangle would make relative anchors mix coordinate systems.
    const resolve = (current: FrameXmlFrame, visiting: Set<FrameXmlFrame>): FrameXmlRect => {
      const size = this.measure(current);
      if (visiting.has(current)) {
        return { left: 0, top: 0, width: size.width, height: size.height,
          right: size.width, bottom: size.height };
      }
      visiting.add(current);
      const parent = current.parent
        ? resolve(current.parent, visiting)
        : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      const point = current.points[0];
      visiting.delete(current);
      if (!point) {
        return { left: 0, top: 0, width: size.width, height: size.height,
          right: size.width, bottom: size.height };
      }
      const relative = point.relativeTo ? resolve(point.relativeTo, visiting) : parent;
      const own = anchorRoles(point.point);
      const target = anchorRoles(point.relativePoint ?? point.point);
      const targetX = target.x === "LEFT" ? relative.left
        : target.x === "RIGHT" ? relative.right : relative.left + relative.width / 2;
      const targetY = target.y === "TOP" ? relative.top
        : target.y === "BOTTOM" ? relative.bottom : relative.top + relative.height / 2;
      const ownX = own.x === "LEFT" ? 0 : own.x === "RIGHT" ? size.width : size.width / 2;
      const ownY = own.y === "TOP" ? 0 : own.y === "BOTTOM" ? size.height : size.height / 2;
      const left = targetX + (point.x ?? 0) - ownX;
      // FrameXML's positive Y points upward; the rectangle is CSS/top-origin.
      const top = targetY - (point.y ?? 0) - ownY;
      return { left, top, width: size.width, height: size.height,
        right: left + size.width, bottom: top + size.height };
    };
    const css = resolve(frame, new Set());
    let topAncestor = frame;
    while (topAncestor.parent) topAncestor = topAncestor.parent;
    const screenHeight = this.measure(topAncestor).height;
    // GetLeft/GetRight are already screen-left-origin. WoW's GetTop/GetBottom
    // count upward from the bottom edge, unlike CSS's top-origin rectangle.
    return {
      left: css.left,
      top: screenHeight - css.top,
      width: css.width,
      height: css.height,
      right: css.right,
      bottom: screenHeight - css.bottom,
    };
  }

  /**
   * Install the Lua adapter after construction.
   *
   * The glue runtime needs this order: the VM must already know the bridge to
   * expose widgets to Lua, and the bridge must know the VM before the first
   * XML file is parsed. Neither can be constructed inside the other.
   */
  setRuntime(runtime: LuaAddonRuntime | undefined): void {
    this.#runtime = runtime;
  }

  setGlobalStringResolver(resolver: ((key: string) => string | undefined) | undefined): void {
    this.#globalStringResolver = resolver;
  }

  getFrame(name: string): FrameXmlFrame | undefined {
    return this.#byName.get(name);
  }

  /**
   * Subscribe to state changes made through the bounded UI API.  This is a
   * host-side observation seam for renderers; it is deliberately not exposed
   * through LuaScriptContext, so an addon cannot observe or mutate the DOM.
   */
  subscribe(listener: () => void): () => void {
    this.#mutationListeners.add(listener);
    return () => this.#mutationListeners.delete(listener);
  }

  /**
   * Group a host-side operation into one render transaction.
   *
   * A single C-side operation can dispatch several FrameXML handlers — a screen switch walks
   * OnHide/OnShow trees and a tick walks every visible OnUpdate frame.  Handlers are already
   * coalesced individually by `#dispatchDepth`; this outer scope keeps the renderer from
   * traversing the whole tree once per handler.  Nesting is intentional: helpers such as
   * `dispatchEvent` can be called from a transaction without changing the caller's boundary.
   */
  runInMutationBatch<T>(operation: () => T): T {
    this.#mutationDepth += 1;
    try {
      return operation();
    } finally {
      this.#mutationDepth -= 1;
      this.flushPendingNotification();
    }
  }

  /**
   * Coalesce mutations raised while a handler or host transaction is running.
   *
   * One OnShow of the login frame performs hundreds of Show/SetText/SetPoint
   * calls; re-rendering after each would make the screen quadratic in its own
   * size. Notification is deferred to the outermost dispatch/transaction instead.
   */
  private notifyMutation(): void {
    if (this.#dispatchDepth > 0 || this.#mutationDepth > 0) {
      this.#pendingNotification = true;
      return;
    }
    this.emitMutation();
  }

  private emitMutation(): void {
    this.#mutationVersion += 1;
    for (const listener of [...this.#mutationListeners]) {
      try {
        listener();
      } catch (error) {
        this.diagnostic("addon", `FrameXML host observer failed: ${String(error)}`);
      }
    }
  }

  private flushPendingNotification(): void {
    if (this.#dispatchDepth !== 0 || this.#mutationDepth !== 0 || !this.#pendingNotification) return;
    this.#pendingNotification = false;
    this.emitMutation();
  }

  private diagnostic(scope: FrameXmlDiagnostic["scope"], message: string): void {
    const diagnostic = { scope, message } satisfies FrameXmlDiagnostic;
    this.#diagnostics.push(diagnostic);
    this.#diagnosticSink?.(diagnostic);
  }

  private own(frame: FrameXmlFrame | undefined): MutableFrameXmlFrame | undefined {
    return frame instanceof MutableFrameXmlFrame && this.#frames.has(frame) ? frame : undefined;
  }

  /** `text="OKAY"` is a GlobalString key first and a literal only as a fallback. */
  private globalString(value: string): string {
    if (!value || !/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
    return this.#globalStringResolver?.(value) ?? value;
  }

  /**
   * `$parentFoo` names the nearest named ancestor, not the synthetic identity
   * we keep for an anonymous wrapper such as `<Frames><Frame>…`.  The wrapper
   * is still the layout parent; this helper is deliberately used only for
   * name/reference expansion, never for the exact `relativeTo="$parent"`
   * spelling (which is resolved against the immediate parent below).
   */
  private nearestNamedAncestor(parent: FrameXmlFrame | undefined): FrameXmlFrame | undefined {
    let current = parent;
    while (current && !current.named) current = current.parent;
    return current;
  }

  private expandParentName(name: string, parent: FrameXmlFrame | undefined): string {
    if (!name.includes("$parent")) return name;
    const parentName = this.nearestNamedAncestor(parent)?.name ?? "";
    return name.replaceAll("$parent", parentName);
  }

  private buildElement(
    source: FrameXmlElement,
    parent: FrameXmlFrame | undefined = undefined,
    forcedName?: string,
    forcedType?: RuntimeWidgetType,
  ): FrameXmlFrame | undefined {
    if (!isWidget(source) && forcedType === undefined) {
      this.diagnostic("addon", `unsupported FrameXML element <${source.name}> was skipped`);
      return undefined;
    }
    let element = source;
    const inherits = frameXmlAttribute(source, "inherits")?.trim() ?? "";
    if (inherits) {
      const resolved = this.#registry.resolve(inherits);
      if (!resolved.ok || !resolved.element) {
        for (const message of resolved.diagnostics) this.diagnostic("template", message);
        return undefined;
      }
      const own = {
        ...source,
        attributes: Object.fromEntries(
          Object.entries(source.attributes).filter(([key]) => key.toLowerCase() !== "inherits"),
        ),
      } as FrameXmlElement;
      element = mergeFrameXmlElements(resolved.element, own);
      // `name` and `virtual` belong to the template declaration, not to an
      // unnamed instance.  In particular CreateFrame(..., nil, ...,
      // "Template") must receive a fresh anonymous identity instead of
      // accidentally reusing the virtual template's global name.
      const attributes = { ...element.attributes };
      if (frameXmlAttribute(source, "name") === undefined) delete attributes["name"];
      delete attributes["virtual"];
      element = { ...element, attributes: Object.freeze(attributes) };
    }

    const declaredName = (forcedName ?? frameXmlAttribute(element, "name") ?? "").trim();
    const expanded = this.expandParentName(declaredName, parent);
    const named = expanded.length > 0;
    const name = named ? expanded : `__framexml_${++this.#anonymousId}`;
    if (this.#byName.has(name)) {
      // The real client has no duplicate-name check: a second widget with the
      // same name is created and simply re-points the global. The corpus
      // depends on it — the server's `XlIlHI.lua` calls
      // `AccountLoginUI:CreateFontString("$parentText", ...)` twice and uses
      // both results. Refusing the second one returned nil and killed the
      // chunk, so the collision is recorded and the newcomer wins the name.
      this.diagnostic("addon", `duplicate FrameXML frame name "${name}" replaced the earlier widget's global`);
    }
    const declarations = collectDeclarations(element);
    const frame = new MutableFrameXmlFrame(
      (forcedType ?? canonicalFrameXmlWidgetType(element.name) ?? element.name) as RuntimeWidgetType,
      name,
      named,
      effectiveSizeAttributes(element),
      parent,
      declarations,
    );
    this.#frames.add(frame);
    // Indexed rather than filtered per frame: the 3D layer asks for this list once an animation
    // frame and `frames` copies all ~2,900 widgets out of a Set every time it is read.
    if (FRAME_XML_MODEL_TYPES.has(frame.type)) this.#modelFrames.add(frame);
    this.#byName.set(name, frame);
    this.indexEvents(frame);
    this.applyWidgetAttributes(frame, element, inherits);

    // Bind the owner before constructing descendants.  The Lua bridge publishes a
    // child's `parentKey` on its parent only once both widget tables exist; binding
    // after recursion made every nested template child arrive first and silently
    // dropped that publication.  This order also matches CreateFrame's observable
    // semantics: the returned frame is available to its template's child setup.
    this.#runtime?.bindFrame?.(frame);

    for (const child of element.children) {
      // `Attributes` used to be skipped here beside `Scripts` and `Events`, which is why F1
      // recorded the element as unparsed: it never reached `applyDeclaration`.
      if (child.name === "Scripts" || child.name === "Events") continue;
      if (isWidget(child)) {
        if (!isVirtual(child) && !this.applyEmbeddedWidget(frame, child)) {
          const built = this.buildElement(child, frame);
          if (built) frame.children.push(built);
        }
      } else if (!this.applyDeclaration(frame, child)) {
        this.buildWrappedChildren(child, frame);
      }
    }
    for (const anchor of element.children) this.collectPointDeclarations(anchor, frame);
    if (frame.setAllPoints && frame.points.length === 0) {
      // `setAllPoints="true"` is the corpus' most common layout: every glue
      // screen root and every `*UI` container uses it. Expanding it into the
      // two anchors it means keeps one layout path instead of two.
      //
      // A frame with no parent is expanded too, and that is the whole login screen: `GlueParent`
      // is `setAllPoints` at the top level, so requiring a parent here left it with no anchors and
      // no size at all. Measured in the live page at 1280x720 — `GlueParent` 0x0, and the module's
      // 1024x768 login scene, anchored CENTER inside it, laid out at (-480, -360): three quarters
      // of the screen off the top-left corner, which is what the "scene pinned to the top-left"
      // and "the account and password boxes are invisible" reports were both looking at. An
      // anchor with no `relativeTo` already means "my containing block" everywhere else in the
      // layout pass, and for a root that block is the stage.
      const anchor = parent ? { relativeTo: parent } : {};
      frame.points.push({ point: "TOPLEFT", ...anchor, relativePoint: "TOPLEFT", x: 0, y: 0 });
      frame.points.push({ point: "BOTTOMRIGHT", ...anchor, relativePoint: "BOTTOMRIGHT", x: 0, y: 0 });
    }
    return frame;
  }

  /** Attributes that exist on every widget plus the per-type extras. */
  private applyWidgetAttributes(
    frame: MutableFrameXmlFrame,
    element: FrameXmlElement,
    declaredInherits: string,
  ): void {
    frame.visible = !(frameXmlBoolean(element, "hidden") ?? false);
    frame.setAllPoints = frameXmlBoolean(element, "setAllPoints") ?? false;
    frame.parentKey = frameXmlAttribute(element, "parentKey")?.trim() ?? "";
    frame.id = frameXmlNumber(element, "id") ?? 0;
    frame.alpha = frameXmlNumber(element, "alpha") ?? 1;
    frame.scale = frameXmlNumber(element, "scale") ?? 1;
    frame.frameLevel = frameXmlNumber(element, "frameLevel") ?? 0;
    frame.frameStrata = frameXmlAttribute(element, "frameStrata")?.trim().toUpperCase() ?? "MEDIUM";
    frame.toplevel = frameXmlBoolean(element, "toplevel") ?? false;
    frame.clampedToScreen = frameXmlBoolean(element, "clampedToScreen") ?? false;
    frame.movable = frameXmlBoolean(element, "movable") ?? false;
    frame.alphaMode = frameXmlAttribute(element, "alphaMode")?.trim().toUpperCase() ?? "BLEND";
    frame.justifyH = frameXmlAttribute(element, "justifyH")?.trim().toUpperCase() ?? frame.justifyH;
    frame.justifyV = frameXmlAttribute(element, "justifyV")?.trim().toUpperCase() ?? frame.justifyV;
    // `inherits` is read from the *declaration*, not the merged element: the
    // merge deliberately drops it, and a FontString names its font object
    // exactly there (`<FontString inherits="GlueFontNormalHuge"/>`). Only a
    // name that resolves to a `<Font>` counts, so inheriting a FontString
    // template does not invent a font object out of the template's name.
    const inheritedFont = declaredInherits.split(",")[0]?.trim() ?? "";
    if (inheritedFont && (frame.type === "FontString" || frame.type === "EditBox" || frame.type === "SimpleHTML")) {
      const template = this.#registry.get(inheritedFont);
      if (!template || template.element.name === FRAME_XML_FONT_ELEMENT) frame.fontObject = inheritedFont;
    }
    const text = frameXmlAttribute(element, "text");
    if (text !== undefined) frame.text = this.globalString(text);
    const file = frameXmlAttribute(element, "file") ?? frameXmlAttribute(element, "texture");
    if (file !== undefined) frame.texture = file;
    if (FRAME_XML_MODEL_TYPES.has(frame.type)) {
      // A `<Model>`/`<ModelFFX>` `file=` is an .mdx path, not a texture: keep
      // it on the model record and off the texture path so no renderer ever
      // tries to load a model as an image.
      frame.model.file = frame.texture;
      frame.texture = "";
      frame.model.scale = frameXmlNumber(element, "scale") ?? 1;
      const fogNear = frameXmlNumber(element, "fogNear");
      const fogFar = frameXmlNumber(element, "fogFar");
      const glow = frameXmlNumber(element, "glow");
      if (fogNear !== undefined) frame.model.fogNear = fogNear;
      if (fogFar !== undefined) frame.model.fogFar = fogFar;
      if (glow !== undefined) frame.model.glow = glow;
    }
    if (frame.type === "EditBox") {
      frame.editBox.letters = frameXmlNumber(element, "letters") ?? 0;
      frame.editBox.password = frameXmlBoolean(element, "password") ?? false;
      frame.editBox.numeric = frameXmlBoolean(element, "numeric") ?? false;
      frame.editBox.multiLine = frameXmlBoolean(element, "multiLine") ?? false;
      frame.editBox.historyLines = frameXmlNumber(element, "historyLines") ?? 0;
    }
    if (frame.type === "MessageFrame" || frame.type === "ScrollingMessageFrame") {
      const maxLines = frameXmlNumber(element, "maxLines");
      const displayDuration = frameXmlNumber(element, "displayDuration");
      frame.messageFrame.maxLines = maxLines === undefined ? 128 : Math.max(0, Math.trunc(maxLines));
      frame.messageFrame.displayDuration = displayDuration === undefined ? 0 : Math.max(0, displayDuration);
    }
    if (frame.type === "Slider" || frame.type === "StatusBar") {
      const state = frame.type === "Slider" ? frame.slider : frame.statusBar;
      state.orientation = frameXmlAttribute(element, "orientation")?.trim().toUpperCase()
        ?? (frame.type === "StatusBar" ? "HORIZONTAL" : "VERTICAL");
      state.min = frameXmlNumber(element, "minValue") ?? 0;
      state.max = frameXmlNumber(element, "maxValue") ?? 0;
      state.value = frameXmlNumber(element, "defaultValue") ?? state.min;
      state.valueStep = frameXmlNumber(element, "valueStep") ?? 0;
    }
  }

  /**
   * Widget children that are *properties* of the parent rather than siblings in
   * its frame list: a Button's four state textures, a CheckButton's check
   * marks, a Slider's thumb, and an EditBox's font string.
   */
  private applyEmbeddedWidget(frame: MutableFrameXmlFrame, child: FrameXmlElement): boolean {
    if (child.name !== "FontString") return false;
    // An unnamed `<FontString inherits="…"/>` directly inside an EditBox,
    // SimpleHTML or message frame names that widget's own font object rather
    // than declaring a visible sibling. ChatFrameTemplate uses this shape for
    // ChatFontNormal, including LEFT/nonspacewrap text layout.
    if ((frame.type !== "EditBox" && frame.type !== "SimpleHTML"
      && frame.type !== "MessageFrame" && frame.type !== "ScrollingMessageFrame")
      || frameXmlAttribute(child, "name") !== undefined) return false;
    const inherits = frameXmlAttribute(child, "inherits")?.trim();
    if (inherits) frame.fontObject = inherits.split(",")[0]?.trim() ?? frame.fontObject;
    const justifyH = frameXmlAttribute(child, "justifyH")?.trim().toUpperCase();
    const justifyV = frameXmlAttribute(child, "justifyV")?.trim().toUpperCase();
    if (justifyH) frame.justifyH = justifyH;
    if (justifyV) frame.justifyV = justifyV;
    if (frame.type === "MessageFrame" || frame.type === "ScrollingMessageFrame") {
      frame.messageFrame.nonSpaceWrap = frameXmlBoolean(child, "nonspacewrap") ?? false;
    }
    return true;
  }

  /** Non-widget declarations: layers, anchors, backdrops, state textures, fonts. */
  private applyDeclaration(frame: MutableFrameXmlFrame, element: FrameXmlElement): boolean {
    switch (element.name) {
      case "Layers":
        for (const layer of element.children) {
          if (layer.name !== "Layer") continue;
          const level = frameXmlAttribute(layer, "level")?.trim().toUpperCase() ?? "ARTWORK";
          let sub = 0;
          for (const child of layer.children) {
            if (!isWidget(child) || isVirtual(child)) continue;
            const built = this.buildElement(child, frame);
            const mutable = this.own(built);
            if (!mutable) continue;
            mutable.drawLayer = FRAME_XML_DRAW_LAYERS.includes(level) ? level : "ARTWORK";
            mutable.drawSubLevel = sub++;
            // A layer region with neither anchors nor a size fills its parent — the same rule the
            // state-texture branch below already applies, and the same reason. Measured on the
            // action bar: `ActionButtonTemplate` declares `<Texture name="$parentIcon"/>` and
            // `<Texture name="$parentFlash" .../>` with no `<Size>` and no `<Anchors>` at all, and
            // both are meant to cover the 36x36 button. Without this the icon was laid out at the
            // picture's own 64x64, sixteen pixels below the button it belongs to, and every slot on
            // the bar showed its art hanging out of the bottom of its border.
            if (mutable.points.length === 0 && mutable.attributes["width"] === undefined
              && mutable.attributes["height"] === undefined) {
              mutable.setAllPoints = true;
              mutable.points = [
                { point: "TOPLEFT", relativeTo: frame, relativePoint: "TOPLEFT", x: 0, y: 0 },
                { point: "BOTTOMRIGHT", relativeTo: frame, relativePoint: "BOTTOMRIGHT", x: 0, y: 0 },
              ];
            }
            frame.children.push(mutable);
          }
        }
        return true;
      case "NormalTexture":
      case "PushedTexture":
      case "HighlightTexture":
      case "DisabledTexture":
      case "CheckedTexture":
      case "DisabledCheckedTexture":
      case "ThumbTexture":
      case "ScrollChild": {
        const state = element.name.replace(/Texture$/, "").toUpperCase();
        if (element.name === "ScrollChild") {
          for (const child of element.children) {
            if (!isWidget(child) || isVirtual(child)) continue;
            const built = this.buildElement(child, frame);
            if (built) frame.children.push(built);
          }
          return true;
        }
        const built = this.buildElement({ ...element, name: "Texture" }, frame, undefined, "Texture");
        const mutable = this.own(built);
        if (mutable) {
          mutable.drawLayer = element.name === "HighlightTexture" ? "HIGHLIGHT" : "ARTWORK";
          // Which of the owner's states this picture belongs to. The draw layer cannot answer that:
          // a `<HighlightTexture>` and a plain `<Texture>` declared on the HIGHLIGHT layer are the
          // same layer and only one of them is state.
          mutable.stateTexture = state;
          // A button's state texture with neither anchors nor a size fills the button — that is
          // what makes a button *look* like its art rather than like the file's own dimensions.
          // Measured: `GlueButtonTemplate`'s `<NormalTexture file="…Glues-BigButton-Up"/>` drew at
          // 747x219, the size of the picture, over three quarters of the login screen.
          if (mutable.points.length === 0 && mutable.attributes["width"] === undefined
            && mutable.attributes["height"] === undefined) {
            mutable.setAllPoints = true;
            mutable.points = [
              { point: "TOPLEFT", relativeTo: frame, relativePoint: "TOPLEFT", x: 0, y: 0 },
              { point: "BOTTOMRIGHT", relativeTo: frame, relativePoint: "BOTTOMRIGHT", x: 0, y: 0 },
            ];
          }
          frame.stateTextures.set(state, mutable);
          frame.children.push(mutable);
        }
        return true;
      }
      case "NormalFont":
      case "HighlightFont":
      case "DisabledFont":
      case "FontStringHeader1":
      case "FontStringHeader2":
      case "FontStringHeader3": {
        const style = frameXmlAttribute(element, "style")?.trim()
          ?? frameXmlAttribute(element, "inherits")?.trim();
        if (style) frame.stateFonts.set(element.name.replace(/Font$/, "").toUpperCase() || "NORMAL", style);
        if (element.name === "NormalFont" && style && !frame.fontObject) frame.fontObject = style;
        return true;
      }
      case "ButtonText": {
        const built = this.buildElement({ ...element, name: "FontString" }, frame, undefined, "FontString");
        const mutable = this.own(built);
        if (mutable) {
          mutable.drawLayer = "OVERLAY";
          if (!mutable.text) mutable.text = frame.text;
          // UIPanelButtonTemplate leaves ButtonText anchors implicit. The native button centers
          // that label; otherwise an absolutely positioned DOM span uses its static text position.
          if (mutable.points.length === 0) {
            mutable.points.push({ point: "CENTER", relativeTo: frame, relativePoint: "CENTER", x: 0, y: 0 });
          }
          frame.stateTextures.set("BUTTONTEXT", mutable);
          frame.children.push(mutable);
        }
        return true;
      }
      case "TexCoords":
        frame.texCoords = {
          left: frameXmlNumber(element, "left") ?? 0,
          right: frameXmlNumber(element, "right") ?? 1,
          top: frameXmlNumber(element, "top") ?? 0,
          bottom: frameXmlNumber(element, "bottom") ?? 1,
        };
        return true;
      case "Color":
        // On a Texture this is the vertex colour; on a FontString it is the
        // text colour. Same element, different destination — the corpus uses
        // both spellings inside the same file.
        if (frame.type === "Texture") frame.vertexColor = colorOf(element);
        else frame.textColor = colorOf(element);
        return true;
      case "BarTexture":
        if (frame.type === "StatusBar") {
          frame.statusBar.texture = frameXmlAttribute(element, "file")
            ?? frameXmlAttribute(element, "texture") ?? "";
          return true;
        }
        return false;
      case "BarColor":
        if (frame.type === "StatusBar") {
          frame.statusBar.color = colorOf(element) ?? { r: 1, g: 1, b: 1, a: 1 };
          return true;
        }
        return false;
      case "Gradient": {
        const min = colorOf(frameXmlChild(element, "MinColor"));
        const max = colorOf(frameXmlChild(element, "MaxColor"));
        if (min && max) {
          frame.gradient = {
            orientation: frameXmlAttribute(element, "orientation")?.trim().toUpperCase() ?? "HORIZONTAL",
            min,
            max,
          };
        }
        return true;
      }
      case "Backdrop": {
        const bgFile = frameXmlAttribute(element, "bgFile");
        const edgeFile = frameXmlAttribute(element, "edgeFile");
        frame.backdrop = {
          ...(bgFile === undefined ? {} : { bgFile }),
          ...(edgeFile === undefined ? {} : { edgeFile }),
          tile: frameXmlBoolean(element, "tile") ?? false,
          tileSize: absValueOf(frameXmlChild(element, "TileSize")) ?? 0,
          edgeSize: absValueOf(frameXmlChild(element, "EdgeSize")) ?? 0,
          insets: insetsOf(frameXmlChild(element, "BackgroundInsets")) ?? { left: 0, right: 0, top: 0, bottom: 0 },
        };
        frame.backdropColor = colorOf(frameXmlChild(element, "Color"));
        frame.backdropBorderColor = colorOf(frameXmlChild(element, "BorderColor"));
        return true;
      }
      case "HitRectInsets":
        frame.hitRectInsets = insetsOf(element);
        return true;
      case "TextInsets":
        frame.textInsets = insetsOf(element);
        return true;
      /**
       * `<Attributes><Attribute name= type= value=/></Attributes>` — a secure attribute declared
       * in XML rather than written from Lua.
       *
       * F1 recorded this element as unparsed and F2 left it there. It is not decoration: fourteen
       * declarations in three files, and one of them is the whole of how a paged action bar knows
       * its page. `MultiActionBars.xml:41` gives `MultiBarBottomLeft` an `actionpage` of 6, and
       * `ActionButton_CalculateAction` finds it by walking `useparent-actionpage` up to the bar —
       * so without this every extra bar addressed page 1 and drew the main bar's twelve actions.
       */
      case "Attributes":
        for (const child of element.children) {
          if (child.name !== "Attribute") continue;
          const key = frameXmlAttributeKey(frameXmlAttribute(child, "name"));
          if (key === undefined || key === "") continue;
          frame.secureAttributes.set(key, frameXmlAttributeValue(
            frameXmlAttribute(child, "type"), frameXmlAttribute(child, "value"),
          ));
          this.#declaredAttributes += 1;
        }
        return true;
      case "Size":
      case "Anchors":
        return true;
      case "FogColor":
        frame.model.fogColor = colorOf(element);
        return true;
      default:
        return false;
    }
  }

  private buildWrappedChildren(element: FrameXmlElement, parent: FrameXmlFrame | undefined): FrameXmlFrame[] {
    const roots: FrameXmlFrame[] = [];
    if (element.name === "Scripts" || element.name === "Events" || element.name === "Attributes") return roots;
    for (const child of element.children) {
      if (isWidget(child)) {
        if (!isVirtual(child)) {
          const built = this.buildElement(child, parent);
          if (built && parent instanceof MutableFrameXmlFrame) parent.children.push(built);
          else if (built) roots.push(built);
        }
      } else {
        roots.push(...this.buildWrappedChildren(child, parent));
      }
    }
    return roots;
  }

  /**
   * A widget's own anchors: the `<Anchor>` entries of its own `<Anchors>` block, and nothing else.
   *
   * This used to recurse through every child that was not a widget, and that reached into the
   * declaration wrappers — `<ButtonText>`, `<NormalTexture>`, `<ThumbTexture>`, the bare
   * `<FontString>` inside an EditBox — whose anchors belong to the region they declare and *not* to
   * the frame declaring it. Those regions are built separately by `applyDeclaration`, which reads
   * the same anchors again, so every one of them was applied twice: once correctly to the region
   * and once wrongly to its owner.
   *
   * Measured on the whole corpus, before and after: 3,298 widgets carrying 5,007 anchors against
   * 4,671 — **336 of them were stolen**, and the five widgets left with no anchor at all are the
   * dialog buttons the corpus positions from Lua when it shows the dialog.
   * `GlueButtonTemplate` declares `<ButtonText><Anchor point="CENTER" y="3"/>`, so
   * *every* glue button had a spurious CENTER anchor — `CharSelectEnterWorldButton` came out as
   * CENTER + BOTTOM and CSS resolved the over-constrained box by keeping `top`, which put the
   * "Enter World" button in the middle of the character-select screen instead of at its foot.
   * `GlueDialogButton1` had the stolen anchor and nothing else at all, which is why every dialog's
   * three buttons stacked on top of each other in the centre.
   */
  private collectPointDeclarations(element: FrameXmlElement, frame: MutableFrameXmlFrame): void {
    if (element.name !== "Anchors") return;
    for (const child of element.children) this.readAnchor(child, frame);
  }

  private readAnchor(element: FrameXmlElement, frame: MutableFrameXmlFrame): void {
    if (element.name === "Anchor") {
      const point = frameXmlAttribute(element, "point");
      if (point) {
        const offset = frameXmlChild(element, "Offset");
        const relativeName = frameXmlAttribute(element, "relativeTo")?.trim();
        const relativeTo = relativeName === "$parent"
          ? frame.parent
          : relativeName
            ? this.#byName.get(this.expandParentName(relativeName, frame.parent))
            : frame.parent;
        const relativePoint = frameXmlAttribute(element, "relativePoint");
        const dimension = dimensionOf(offset)
          ?? { x: frameXmlNumber(element, "x") ?? 0, y: frameXmlNumber(element, "y") ?? 0 };
        const pointIndex = frame.points.push({
          point,
          ...(relativeTo ? { relativeTo } : {}),
          ...(relativePoint ? { relativePoint } : {}),
          x: dimension.x,
          y: dimension.y,
        }) - 1;
        if (relativeName && relativeName !== "$parent" && !relativeTo) {
          this.#pendingRelativePoints.push({
            frame, index: pointIndex, relativeName: this.expandParentName(relativeName, frame.parent),
          });
        }
      }
    }
  }

  private resolvePendingRelativePoints(): void {
    for (let index = this.#pendingRelativePoints.length - 1; index >= 0; index -= 1) {
      const pending = this.#pendingRelativePoints[index];
      if (!pending) continue;
      const relativeTo = this.#byName.get(pending.relativeName);
      if (!relativeTo) continue;
      const point = pending.frame.points[pending.index];
      if (point) pending.frame.points[pending.index] = { ...point, relativeTo };
      this.#pendingRelativePoints.splice(index, 1);
    }
  }

  private indexEvents(frame: MutableFrameXmlFrame): void {
    for (const event of frame.registeredEvents) {
      let set = this.#byEvent.get(event);
      if (!set) this.#byEvent.set(event, (set = new Set()));
      set.add(frame);
    }
    if (frame.scriptSources.has("OnUpdate") || frame.scriptFunctions.has("OnUpdate")) {
      this.#updateFrames.add(frame);
    }
  }

  /**
   * Register a `<Font>` object.
   *
   * Font objects inherit exactly like widget templates, so the flattening runs
   * through the same registry; only the leaf reading differs.
   */
  registerFontObjects(): void {
    for (const name of this.#registry.names) {
      const template = this.#registry.get(name);
      if (!template || template.element.name !== FRAME_XML_FONT_ELEMENT) continue;
      const style = this.readFontStyle(name);
      if (style) this.#fontStyles.set(name, style);
    }
  }

  /**
   * Flatten one declaration's font properties against the registry's cascade.
   *
   * Split out of `registerFontObjects` so a single object can also be resolved
   * on demand — see `fontObjectStyle`, which the in-world corpus needs while it
   * is still loading, long before the whole TOC has been walked.
   */
  private readFontStyle(name: string): FrameXmlFontStyle | undefined {
    const template = this.#registry.get(name);
    if (!template) return undefined;
    const resolved = this.#registry.resolve(name);
    const element = resolved.element ?? template.element;
    // Last-wins: an inherits chain appends the derived declarations, so the
    // override is the last copy of each singleton property element.
    const shadow = frameXmlLastChild(element, "Shadow");
    const shadowOffset = dimensionOf(shadow ? frameXmlLastChild(shadow, "Offset") : undefined);
    const file = frameXmlAttribute(element, "font");
    const height = absValueOf(frameXmlLastChild(element, "FontHeight"));
    const outline = frameXmlAttribute(element, "outline")?.trim().toUpperCase();
    const color = colorOf(frameXmlLastChild(element, "Color"));
    const shadowColor = colorOf(shadow ? frameXmlLastChild(shadow, "Color") : undefined);
    const justifyH = frameXmlAttribute(element, "justifyH")?.trim().toUpperCase();
    const justifyV = frameXmlAttribute(element, "justifyV")?.trim().toUpperCase();
    const spacing = frameXmlNumber(element, "spacing");
    return {
      name,
      ...(file === undefined ? {} : { file }),
      ...(height === undefined ? {} : { height }),
      ...(outline === undefined || outline === "NONE" ? {} : { outline }),
      monochrome: frameXmlBoolean(element, "monochrome") ?? false,
      ...(color ? { color } : {}),
      ...(shadowColor ? { shadowColor } : {}),
      ...(shadowOffset ? { shadowOffsetX: shadowOffset.x, shadowOffsetY: shadowOffset.y } : {}),
      ...(justifyH === undefined ? {} : { justifyH }),
      ...(justifyV === undefined ? {} : { justifyV }),
      ...(spacing === undefined ? {} : { spacing }),
    };
  }

  fontStyle(name: string): FrameXmlFontStyle | undefined {
    return this.#fontStyles.get(name.trim());
  }

  get fontStyles(): readonly FrameXmlFontStyle[] {
    return [...this.#fontStyles.values()];
  }

  /**
   * A *font object* as the client publishes it, resolved the moment it is asked
   * for.
   *
   * Two differences from `fontStyle`, and both are facts about the client rather
   * than conveniences. First, a font object is not only `<Font>`: the corpus
   * declares most of them as `<FontString virtual="true" inherits="…">`
   * (`GameFontHighlightSmallLeft`, `GameFontDisableSmallLeft`, …) and names them
   * exactly the same way, so both element kinds answer here while `fontStyles`
   * keeps meaning "the `<Font>` declarations" for the renderer. Second, the
   * whole TOC has not been walked yet when the corpus first reaches for one —
   * `registerFontObjects` runs at the end of the load, and `GameFontNormal` is
   * read by files that run in the middle of it — so this resolves against
   * whatever the registry holds *now* and caches the answer.
   */
  fontObjectStyle(name: string): FrameXmlFontStyle | undefined {
    const key = name.trim();
    const cached = this.#fontObjectStyles.get(key);
    if (cached) return cached;
    const template = this.#registry.get(key);
    if (!template) return undefined;
    if (template.element.name !== FRAME_XML_FONT_ELEMENT
      && template.element.name !== "FontString") {
      return undefined;
    }
    const style = this.readFontStyle(key);
    if (style) this.#fontObjectStyles.set(key, style);
    return style;
  }

  /** Load one addon in isolation; malformed input never reaches native HUD code. */
  loadAddon(
    source: string,
    options: { readonly registerTemplates?: boolean } = {},
  ): FrameXmlAddonLoadResult {
    const before = this.#diagnostics.length;
    const parsed = parseFrameXml(source);
    // A parser result with diagnostics is not a usable document even when it
    // contains a recoverable root.  Building that root would let malformed
    // addon input partially mutate the compatibility bridge.
    if (!parsed.ok || !parsed.root) {
      for (const message of parsed.diagnostics) this.diagnostic("xml", message);
      this.diagnostic("addon", "FrameXML addon has no usable root; native HUD was left untouched");
      return {
        ok: false,
        roots: [],
        diagnostics: this.#diagnostics.slice(before),
        nativeHudUnaffected: true,
      };
    }
    // Do not register templates from an unsupported root.  Otherwise a
    // rejected document such as <Bad><Frame virtual="true" .../></Bad> could
    // still poison the shared template registry for a later addon.
    if (!isWidget(parsed.root) && parsed.root.name !== "Ui") {
      this.diagnostic("addon", `FrameXML root <${parsed.root.name}> is not <Ui> or a supported widget`);
      return {
        ok: false,
        roots: [],
        diagnostics: this.#diagnostics.slice(before),
        nativeHudUnaffected: true,
      };
    }
    const registration = options.registerTemplates === false
      ? { ok: true, diagnostics: [] as readonly string[] }
      : this.#registry.registerDocument(source);
    for (const message of registration.diagnostics) this.diagnostic("xml", message);
    const roots: FrameXmlFrame[] = [];
    // `created` is every widget this document declared at top level; `roots` is
    // only the parentless ones. A `parent="GlueParent"` frame belongs to that
    // tree and must not be mounted twice, but its OnLoad still has to run.
    const created: FrameXmlFrame[] = [];
    if (isWidget(parsed.root) && !isVirtual(parsed.root)) {
      const root = this.buildElement(parsed.root);
      if (root) {
        created.push(root);
        roots.push(root);
      }
    } else if (parsed.root.name === "Ui") {
      for (const child of parsed.root.children) {
        if (isWidget(child) && !isVirtual(child)) {
          const parentFrame = this.own(this.parentFrameOf(child));
          const root = this.buildElement(child, parentFrame);
          if (!root) continue;
          created.push(root);
          if (parentFrame) parentFrame.children.push(root);
          else roots.push(root);
        } else if (child.name !== "Script" && child.name !== "Include"
          && child.name !== FRAME_XML_FONT_ELEMENT && !isVirtual(child)) {
          const wrapped = this.buildWrappedChildren(child, undefined);
          created.push(...wrapped);
          roots.push(...wrapped);
        }
      }
    } else {
      this.diagnostic("addon", `FrameXML root <${parsed.root.name}> is not <Ui> or a supported widget`);
    }
    this.resolvePendingRelativePoints();
    this.dispatchOnLoad(created);
    return {
      // A template-only XML file is a valid load even though it creates no
      // roots. Diagnostics (including an unsupported Lua chunk) make this
      // result non-clean, but never roll back the native HUD.
      ok: registration.ok && this.#diagnostics.length === before,
      roots,
      diagnostics: this.#diagnostics.slice(before),
      nativeHudUnaffected: true,
    };
  }

  /**
   * Instantiate one top-level widget declaration, in document order.
   *
   * The glue loader needs this rather than `loadAddon` because a real GlueXML
   * file interleaves `<Script file="AccountLogin.lua"/>` with the frames that
   * call into it: AccountLogin.xml loads its Lua at line 5, a second chunk at
   * 164, declares the frame at 165 and a third chunk at 2407. Building the
   * whole document at once would run OnLoad against functions that do not
   * exist yet.
   */
  instantiate(element: FrameXmlElement): FrameXmlFrame | undefined {
    if (!isWidget(element) || isVirtual(element)) return undefined;
    const parentFrame = this.own(this.parentFrameOf(element));
    const frame = this.buildElement(element, parentFrame);
    if (!frame) return undefined;
    if (parentFrame) parentFrame.children.push(frame);
    this.resolvePendingRelativePoints();
    this.dispatchOnLoad([frame]);
    this.notifyMutation();
    return frame;
  }

  /** Register one `<... virtual="true">` or `<Font>` declaration by name. */
  registerTemplateElement(element: FrameXmlElement, source?: string): boolean {
    const name = frameXmlAttribute(element, "name")?.trim();
    if (!name) return false;
    return this.#registry.registerTemplate(name, element, source);
  }

  /**
   * `parent="GlueParent"` on a top-level frame.
   *
   * Every glue screen declares itself a child of GlueParent by name rather than
   * by nesting, because each screen lives in its own file. Honouring it is what
   * makes the screens inherit GlueParent's rectangle — and therefore its
   * pillarbox past 16:9 — instead of anchoring to the document.
   */
  private parentFrameOf(element: FrameXmlElement): FrameXmlFrame | undefined {
    const parentName = frameXmlAttribute(element, "parent")?.trim();
    return parentName ? this.#byName.get(parentName) : undefined;
  }

  dispatchOnLoad(roots: readonly FrameXmlFrame[]): void {
    for (const root of roots) {
      for (const child of root.children) this.dispatchOnLoad([child]);
      // XML child widgets are initialized before their owner in the stock client.  Parent OnLoad
      // handlers routinely perform their first update against child state; TargetFrame.lua is a
      // concrete example because TargetFrame_OnLoad immediately updates the health/mana bars,
      // whose TextStatusBar initialization lives in the child OnLoad scripts.
      this.dispatchScript(root, "OnLoad", []);
    }
  }

  dispatchEvent(event: string, ...args: readonly unknown[]): number {
    return this.runInMutationBatch(() => {
      const name = event.trim();
      if (!name) return 0;
      let delivered = 0;
      for (const frame of [...(this.#byEvent.get(name) ?? [])]) {
        if (!frame.registeredEvents.has(name)) continue;
        this.dispatchScript(frame, "OnEvent", [name, ...args]);
        delivered += 1;
      }
      return delivered;
    });
  }

  /**
   * Dispatch an event while leaving named owners of an unavailable surface untouched.
   *
   * This is intentionally narrower than a global event gate: a vertical mount may keep the
   * native world-map owner while Minimap and Battlefield still consume zone notifications. The
   * caller names the one stock owner whose handler requires the omitted frame; every other
   * registered handler follows the normal dispatch path.
   */
  dispatchEventExcept(
    event: string,
    excludedFrameNames: ReadonlySet<string>,
    ...args: readonly unknown[]
  ): number {
    return this.runInMutationBatch(() => {
      const name = event.trim();
      if (!name) return 0;
      let delivered = 0;
      for (const frame of [...(this.#byEvent.get(name) ?? [])]) {
        if (!frame.registeredEvents.has(name) || excludedFrameNames.has(frame.name)) continue;
        this.dispatchScript(frame, "OnEvent", [name, ...args]);
        delivered += 1;
      }
      return delivered;
    });
  }

  /**
   * Advance one frame of OnUpdate.
   *
   * `elapsed` is seconds, as 3.3.5 delivers it; the glue corpus multiplies it
   * straight into fade alphas (`GlueFrameFadeUpdate(elapsed)`), so a
   * milliseconds value here would make every fade 1000x too fast.
   */
  tick(elapsedSeconds: number): number {
    return this.runInMutationBatch(() => {
      let dispatched = 0;
      for (const frame of [...this.#updateFrames]) {
        if (!this.#frames.has(frame) || !this.isVisible(frame)) continue;
        this.dispatchScript(frame, "OnUpdate", [elapsedSeconds]);
        dispatched += 1;
      }
      return dispatched;
    });
  }

  hasScript(frame: FrameXmlFrame, script: string): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    if (mutable.scripts.has(script)) return true;
    if (mutable.scriptOverrides.has(script)) return false;
    return mutable.scriptSources.has(script) || mutable.scriptFunctions.has(script);
  }

  /** Visible means "shown, and every ancestor shown", exactly as IsVisible does. */
  isVisible(frame: FrameXmlFrame): boolean {
    let current: FrameXmlFrame | undefined = frame;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  /**
   * Resolve the callable for one script, compiling the XML body at most once.
   *
   * Precedence follows the real client: a SetScript handler replaces the XML
   * body entirely (including when it replaces it with nil), a `function="…"`
   * attribute resolves against the Lua globals, and an inline body is compiled
   * with the measured parameter names for that script.
   */
  private resolveHandler(frame: MutableFrameXmlFrame, script: string): FrameXmlScriptHandler | undefined {
    const explicit = frame.scripts.get(script);
    if (explicit) return explicit;
    if (frame.scriptOverrides.has(script)) return undefined;
    const cached = frame.compiledScripts.get(script);
    if (cached !== undefined) return cached ?? undefined;
    const runtime = this.#runtime;
    const globalName = frame.scriptFunctions.get(script);
    if (globalName && runtime?.resolveGlobalHandler) {
      const resolved = runtime.resolveGlobalHandler(globalName);
      // A miss is not cached: `<OnLoad function="X"/>` can name a global that a
      // later file in the TOC defines, and caching nil would make the frame
      // permanently inert instead of merely late.
      if (resolved) frame.compiledScripts.set(script, resolved);
      return resolved;
    }
    const source = frame.scriptSources.get(script);
    if (!source || !runtime?.compileScript) return undefined;
    const parameters = FRAME_XML_SCRIPT_PARAMETERS[script] ?? ["self"];
    let compiled: FrameXmlScriptHandler | undefined;
    try {
      compiled = runtime.compileScript({
        script, source, parameters, frame,
        chunkName: `${frame.name}:${script}`,
      });
    } catch (error) {
      this.diagnostic("script", `${frame.name}.${script} failed to compile: ${String(error)}`);
    }
    frame.compiledScripts.set(script, compiled ?? null);
    return compiled;
  }

  private dispatchScript(frame: FrameXmlFrame, script: string, args: readonly unknown[]): void {
    const mutable = this.own(frame);
    if (!mutable) return;
    if (script === "OnLoad" && mutable.loaded) return;
    if (script === "OnLoad") mutable.loaded = true;
    this.#dispatchDepth += 1;
    try {
      const handler = this.resolveHandler(mutable, script);
      if (handler) {
        try {
          handler(mutable, ...args);
        } catch (error) {
          this.diagnostic("script", `${frame.name}.${script} handler failed: ${String(error)}`);
        }
      } else if (!mutable.scriptOverrides.has(script) && mutable.scriptSources.has(script)) {
        this.executeLegacyScript(mutable, script, args);
      }
      for (const hook of mutable.scriptHooks.get(script) ?? []) {
        try {
          hook(mutable, ...args);
        } catch (error) {
          this.diagnostic("script", `${frame.name}.${script} hook failed: ${String(error)}`);
        }
      }
    } finally {
      this.#dispatchDepth -= 1;
      this.flushPendingNotification();
    }
  }

  /** Adapter without `compileScript`: one-shot execution, or a recorded refusal. */
  private executeLegacyScript(frame: MutableFrameXmlFrame, script: string, args: readonly unknown[]): void {
    const source = frame.scriptSources.get(script);
    if (!source) return;
    if (!this.#runtime) {
      if (!this.#unavailableScriptNotices.has(source)) {
        this.#unavailableScriptNotices.add(source);
        this.diagnostic("script", `${frame.name}.${script} retained Lua source but no LuaAddonRuntime adapter is installed`);
      }
      return;
    }
    const context: LuaScriptContext = {
      frame,
      args,
      ui: this,
      ...(script === "OnEvent" && args[0] && typeof args[0] === "string" ? { event: args[0] } : {}),
    };
    try {
      this.#runtime.execute(source, context);
    } catch (error) {
      this.diagnostic("script", `${frame.name}.${script} Lua adapter failed: ${String(error)}`);
    }
  }

  /** Public dispatch used by the glue widget layer (`frame:Click()`, key input, …). */
  fireScript(frame: FrameXmlFrame, script: string, ...args: readonly unknown[]): boolean {
    return this.runInMutationBatch(() => {
      const mutable = this.own(frame);
      if (!mutable) return false;
      this.dispatchScript(mutable, script, args);
      return true;
    });
  }

  CreateFrame(type: string, name?: string, parent?: FrameXmlFrame, inherits?: string): FrameXmlFrame | undefined {
    const resolvedType = canonicalWidgetType(type);
    if (!resolvedType) {
      this.diagnostic("addon", `CreateFrame("${type}") is not supported by the bounded bridge`);
      return undefined;
    }
    const resolvedParent = parent === undefined ? undefined : this.own(parent);
    if (parent !== undefined && !resolvedParent) return undefined;
    const attributes: Record<string, string> = {};
    if (name) attributes["name"] = name;
    if (inherits) attributes["inherits"] = inherits;
    const element: FrameXmlElement = {
      name: resolvedType,
      attributes,
      children: [],
      text: "",
    };
    const frame = this.buildElement(element, resolvedParent, name);
    const mutable = this.own(frame);
    if (mutable) this.#createdFrames.add(mutable);
    if (frame && resolvedParent) resolvedParent.children.push(frame);
    // A frame created with no parent is a top-level frame in the real client and
    // draws like one. `GlueLoader` only collects the roots it saw in XML, so
    // without this list `lgzg.lua`'s rotating logo — `CreateFrame("Frame", nil,
    // LoginScene)` where `LoginScene` is still nil at file scope — existed in
    // the bridge and was never mounted anywhere.
    if (frame && !resolvedParent) this.#createdRoots.push(frame);
    this.resolvePendingRelativePoints();
    if (frame) {
      this.dispatchOnLoad([frame]);
      this.notifyMutation();
    }
    return frame;
  }

  /** Top-level frames Lua created after the load, in creation order. */
  get createdRoots(): readonly FrameXmlFrame[] {
    return this.#createdRoots;
  }

  /** Create a Texture/FontString owned by `parent`, as `CreateTexture` does. */
  createChild(
    parent: FrameXmlFrame,
    type: "Texture" | "FontString",
    name?: string,
    layer?: string,
    inherits?: string,
  ): FrameXmlFrame | undefined {
    const owner = this.own(parent);
    if (!owner) return undefined;
    const attributes: Record<string, string> = {};
    if (name) attributes["name"] = name;
    if (inherits) attributes["inherits"] = inherits;
    const built = this.buildElement({ name: type, attributes, children: [], text: "" }, owner, name);
    const mutable = this.own(built);
    if (!mutable) return undefined;
    this.#createdFrames.add(mutable);
    const level = layer?.trim().toUpperCase() ?? "ARTWORK";
    mutable.drawLayer = FRAME_XML_DRAW_LAYERS.includes(level) ? level : "ARTWORK";
    mutable.drawSubLevel = owner.children.length;
    owner.children.push(mutable);
    this.notifyMutation();
    return mutable;
  }

  /** Move a widget between containing frames, preserving its identity and authored state. */
  SetParent(frame: FrameXmlFrame, parent?: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    const next = parent === undefined ? undefined : this.own(parent);
    if (parent !== undefined && !next) return false;
    if (next === mutable) return false;

    // A malformed caller must not create a cycle that makes visibility, geometry or renderer
    // walks recurse forever. Also reject a pre-existing cyclic parent chain defensively.
    const seen = new Set<FrameXmlFrame>();
    for (let current: FrameXmlFrame | undefined = next; current; current = current.parent) {
      if (current === mutable || seen.has(current)) return false;
      seen.add(current);
    }

    const previous = mutable.parent;
    if (previous === next) return true;
    if (previous) {
      const oldParent = this.own(previous);
      if (oldParent) {
        for (let index = oldParent.children.length - 1; index >= 0; index -= 1) {
          if (oldParent.children[index] === mutable) oldParent.children.splice(index, 1);
        }
      }
    }
    if (next) mutable.parent = next;
    else delete mutable.parent;
    if (next && !next.children.includes(mutable)) next.children.push(mutable);

    // Only frames created dynamically belong to `createdRoots`; XML roots are already owned by
    // the loader's mounted root list and must not become an extra top-level source on unparent.
    if (this.#createdFrames.has(mutable)) {
      const rootIndex = this.#createdRoots.indexOf(mutable);
      if (next === undefined) {
        if (rootIndex < 0) this.#createdRoots.push(mutable);
      } else if (rootIndex >= 0) {
        this.#createdRoots.splice(rootIndex, 1);
      }
    }
    this.notifyMutation();
    return true;
  }

  SetScript(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler | null): boolean {
    const mutable = this.own(frame);
    const name = script.trim();
    if (!mutable || !name) return false;
    mutable.scriptOverrides.add(name);
    mutable.compiledScripts.delete(name);
    if (handler) mutable.scripts.set(name, handler);
    else mutable.scripts.delete(name);
    if (name === "OnUpdate") {
      if (handler) this.#updateFrames.add(mutable);
      else this.#updateFrames.delete(mutable);
    }
    return true;
  }

  GetScript(frame: FrameXmlFrame, script: string): FrameXmlScriptHandler | undefined {
    const mutable = this.own(frame);
    if (!mutable) return undefined;
    return this.resolveHandler(mutable, script.trim());
  }

  HookScript(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler): boolean {
    const mutable = this.own(frame);
    const name = script.trim();
    if (!mutable || !name) return false;
    const hooks = mutable.scriptHooks.get(name) ?? [];
    hooks.push(handler);
    mutable.scriptHooks.set(name, hooks);
    if (name === "OnUpdate") this.#updateFrames.add(mutable);
    return true;
  }

  /** Dispatch a button activation with only the scalar arguments FrameXML exposes to Lua. */
  Click(frame: FrameXmlFrame, button = "LeftButton", down = false): boolean {
    return this.runInMutationBatch(() => {
      const mutable = this.own(frame);
      const name = button.trim();
      if (!mutable || (mutable.type !== "Button" && mutable.type !== "CheckButton") || !name) return false;
      if (!mutable.enabled) return false;
      if (mutable.type === "CheckButton") mutable.checked = !mutable.checked;
      this.dispatchScript(mutable, "OnClick", [name, down === true]);
      this.notifyMutation();
      return true;
    });
  }

  /** Dispatch the FrameXML hover callback without exposing the browser event. */
  Enter(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    this.dispatchScript(mutable, "OnEnter", [true]);
    return true;
  }

  /** Dispatch the FrameXML hover callback without exposing the browser event. */
  Leave(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    this.dispatchScript(mutable, "OnLeave", [true]);
    return true;
  }

  RegisterEvent(frame: FrameXmlFrame, event: string): boolean {
    const mutable = this.own(frame);
    const name = event.trim();
    if (!mutable || !name) return false;
    mutable.registeredEvents.add(name);
    let set = this.#byEvent.get(name);
    if (!set) this.#byEvent.set(name, (set = new Set()));
    set.add(mutable);
    return true;
  }

  UnregisterEvent(frame: FrameXmlFrame, event: string): boolean {
    const mutable = this.own(frame);
    const name = event.trim();
    if (!mutable || !name) return false;
    mutable.registeredEvents.delete(name);
    this.#byEvent.get(name)?.delete(mutable);
    return true;
  }

  UnregisterAllEvents(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    for (const event of [...mutable.registeredEvents]) this.UnregisterEvent(mutable, event);
    return true;
  }

  Show(frame: FrameXmlFrame): boolean {
    return this.runInMutationBatch(() => {
      const mutable = this.own(frame);
      if (!mutable) return false;
      const changed = !mutable.visible;
      mutable.visible = true;
      if (changed) this.raiseToplevel(mutable);
      if (changed) this.dispatchShowTree(mutable, "OnShow");
      this.notifyMutation();
      return true;
    });
  }

  /**
   * `toplevel="true"`: put this frame above every other frame in its strata.
   *
   * The glue screens are the reason. Measured in the live page before this existed: the module's
   * rotating logo is `CreateFrame("Frame", nil, LoginScene)` at `lgzg.lua:146`, where `LoginScene`
   * is still nil — the file is `<Script file="lgzg.lua"/>` at `AccountLogin.xml:164` and
   * `LoginScene` is not assigned until `LoginScreen_OnLoad` — so the frame is parentless, keeps the
   * default `MEDIUM` strata, and `SetFrameLevel(1)` puts it one above every screen. `CharacterSelect`
   * is `MEDIUM` level 0, so the logo drew over the character-select screen. It is declared
   * `toplevel="true"` (`CharacterSelect.xml:153`), and in the client that is exactly what stops it:
   * showing a toplevel frame raises it to the top of its strata.
   *
   * Only within the strata, and only on a frame that is not already the top one, so repeatedly
   * switching screens does not walk the level upwards without bound.
   */
  private raiseToplevel(frame: MutableFrameXmlFrame): void {
    if (!frame.toplevel) return;
    let highest = frame.frameLevel;
    for (const other of this.#frames) {
      if (other === frame || other.frameStrata !== frame.frameStrata) continue;
      if (other.frameLevel > highest) highest = other.frameLevel;
    }
    if (highest <= frame.frameLevel) return;
    // The renderer packs a strata into a thousand z-index values, so a level may not leave the band.
    frame.frameLevel = Math.min(highest + 1, TOPLEVEL_MAX_FRAME_LEVEL);
  }

  Hide(frame: FrameXmlFrame): boolean {
    return this.runInMutationBatch(() => {
      const mutable = this.own(frame);
      if (!mutable) return false;
      const changed = mutable.visible;
      mutable.visible = false;
      if (changed) this.dispatchShowTree(mutable, "OnHide");
      this.notifyMutation();
      return true;
    });
  }

  /**
   * OnShow/OnHide reach descendants too.
   *
   * `SetGlueScreen("login")` shows exactly one frame; every visible child of it
   * — the login dialog, the survey notice, the cinematics panel — expects its
   * own OnShow to have run. Only children that are themselves shown propagate,
   * which is what keeps a `hidden="true"` sub-dialog quiet.
   */
  private dispatchShowTree(frame: MutableFrameXmlFrame, script: "OnShow" | "OnHide"): void {
    this.dispatchScript(frame, script, []);
    for (const child of frame.children) {
      const mutable = this.own(child);
      if (mutable?.visible) this.dispatchShowTree(mutable, script);
    }
  }

  SetPoint(
    frame: FrameXmlFrame,
    point: string,
    relativeTo?: FrameXmlFrame,
    relativePoint?: string,
    x?: number,
    y?: number,
  ): boolean {
    const mutable = this.own(frame);
    const relative = relativeTo === undefined ? undefined : this.own(relativeTo);
    if (!mutable || !point.trim() || (relativeTo !== undefined && !relative)) return false;
    const name = point.trim().toUpperCase();
    const anchor = {
      point: name,
      ...(relative ? { relativeTo: relative } : mutable.parent ? { relativeTo: mutable.parent } : {}),
      ...(relativePoint ? { relativePoint: relativePoint.toUpperCase() } : {}),
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
    };
    // A frame holds at most one anchor per point name: `SetPoint("BOTTOM", …)` on a frame whose
    // XML already anchored BOTTOM *moves* it, and only `ClearAllPoints` empties the set. Appending
    // instead is what put the owner's Options button on top of Exit game — measured:
    // `AccountLogin.xml:559` anchors `OptionsButton` BOTTOM to the hidden `…ManageAccountButton`
    // and `XlIlHI.lua:78` re-anchors it BOTTOM to `AccountLoginExitButton`, so the button carried
    // both. One of the two pinned its top edge and the other its bottom, the declared height was
    // dropped as over-constrained, and a 38-unit button laid itself out 126 units tall, reaching
    // down through the button below it.
    const existing = mutable.points.findIndex((candidate) => candidate.point.toUpperCase() === name);
    if (existing >= 0) mutable.points[existing] = anchor;
    else mutable.points.push(anchor);
    this.notifyMutation();
    return true;
  }

  ClearAllPoints(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutable.points = [];
    this.notifyMutation();
    return true;
  }

  SetAllPoints(frame: FrameXmlFrame, relativeTo?: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    // Same rule as the XML attribute: no target at all means the containing block, which for a
    // frame with no parent is the screen. Refusing there left a Lua-created root unpositioned.
    const target = this.own(relativeTo) ?? mutable.parent;
    const anchor = target ? { relativeTo: target } : {};
    mutable.points = [
      { point: "TOPLEFT", ...anchor, relativePoint: "TOPLEFT", x: 0, y: 0 },
      { point: "BOTTOMRIGHT", ...anchor, relativePoint: "BOTTOMRIGHT", x: 0, y: 0 },
    ];
    mutable.setAllPoints = true;
    this.notifyMutation();
    return true;
  }

  SetText(frame: FrameXmlFrame, text: string): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutable.text = String(text);
    if (mutable.type === "EditBox") {
      mutable.editBox.cursorPosition = mutable.text.length;
      mutable.editBox.historyIndex = -1;
    }
    // A Button owns its label as a separate FontString; SetText on the button
    // has to reach it, or every glue button would render empty.
    const label = mutable.stateTextures.get("BUTTONTEXT");
    const labelFrame = this.own(label);
    if (labelFrame) labelFrame.text = mutable.text;
    this.notifyMutation();
    return true;
  }

  /** Insert text at the bounded EditBox caret, which is what chat link insertion uses. */
  InsertText(frame: FrameXmlFrame, text: string): boolean {
    const mutable = this.own(frame);
    if (!mutable || mutable.type !== "EditBox") return false;
    const position = Math.max(0, Math.min(mutable.text.length, mutable.editBox.cursorPosition));
    const value = `${mutable.text.slice(0, position)}${String(text)}${mutable.text.slice(position)}`;
    mutable.text = value;
    mutable.editBox.cursorPosition = position + String(text).length;
    mutable.editBox.historyIndex = -1;
    this.notifyMutation();
    return true;
  }

  SetCursorPosition(frame: FrameXmlFrame, position: number): boolean {
    const mutable = this.own(frame);
    if (!mutable || mutable.type !== "EditBox") return false;
    mutable.editBox.cursorPosition = Math.max(0, Math.min(mutable.text.length,
      Number.isFinite(position) ? Math.trunc(position) : mutable.text.length));
    this.notifyMutation();
    return true;
  }

  GetCursorPosition(frame: FrameXmlFrame): number {
    const mutable = this.own(frame);
    return mutable?.type === "EditBox" ? mutable.editBox.cursorPosition : 0;
  }

  /** Browser arrows provide the native EditBox history behaviour for stock chat. */
  NavigateEditBoxHistory(frame: FrameXmlFrame, direction: -1 | 1): boolean {
    const mutable = this.own(frame);
    if (!mutable || mutable.type !== "EditBox" || mutable.editBox.history.length === 0) return false;
    const history = mutable.editBox.history;
    const current = mutable.editBox.historyIndex < 0 ? history.length : mutable.editBox.historyIndex;
    const next = Math.max(0, Math.min(history.length, current + direction));
    mutable.editBox.historyIndex = next;
    mutable.text = next === history.length ? "" : history[next] ?? "";
    mutable.editBox.cursorPosition = mutable.text.length;
    this.notifyMutation();
    return true;
  }

  private isMessageFrame(frame: FrameXmlFrame | undefined): frame is MutableFrameXmlFrame {
    const mutable = this.own(frame);
    return mutable !== undefined
      && (mutable.type === "MessageFrame" || mutable.type === "ScrollingMessageFrame");
  }

  private refreshMessageScroll(frame: MutableFrameXmlFrame, stickToBottom: boolean): void {
    const state = frame.messageFrame;
    frame.scroll.verticalScrollRange = Math.max(0, state.messages.length - 1);
    frame.scroll.verticalScroll = stickToBottom
      ? frame.scroll.verticalScrollRange
      : Math.min(frame.scroll.verticalScroll, frame.scroll.verticalScrollRange);
  }

  /** The bounded MessageFrame surface used by ChatFrame.lua/FloatingChatFrame.lua. */
  AddMessage(
    frame: FrameXmlFrame,
    text: unknown,
    r = 1,
    g = 1,
    b = 1,
    lineID?: unknown,
    _isProtected?: unknown,
    accessID?: unknown,
    extraData?: unknown,
  ): boolean {
    if (!this.isMessageFrame(frame)) return false;
    const state = frame.messageFrame;
    const stickToBottom = frame.scroll.verticalScroll >= frame.scroll.verticalScrollRange;
    const channel = (value: unknown): number => {
      const number = typeof value === "number" ? value : Number(value);
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
    };
    const message: FrameXmlMessage = {
      text: String(text ?? ""),
      color: { r: channel(r), g: channel(g), b: channel(b), a: 1 },
      ...(lineID === undefined ? {} : { lineID }),
      ...(accessID === undefined ? {} : { accessID }),
      ...(extraData === undefined ? {} : { extraData }),
    };
    state.messages.push(message);
    if (state.messages.length > state.maxLines) {
      state.messages.splice(0, state.messages.length - state.maxLines);
    }
    state.revision += 1;
    this.refreshMessageScroll(frame, stickToBottom);
    this.notifyMutation();
    return true;
  }

  ClearMessageFrame(frame: FrameXmlFrame): boolean {
    if (!this.isMessageFrame(frame)) return false;
    const state = frame.messageFrame;
    if (state.messages.length === 0 && frame.scroll.verticalScroll === 0
      && frame.scroll.verticalScrollRange === 0) return true;
    state.messages.length = 0;
    state.revision += 1;
    frame.scroll.verticalScroll = 0;
    frame.scroll.verticalScrollRange = 0;
    this.notifyMutation();
    return true;
  }

  GetNumMessages(frame: FrameXmlFrame, accessID?: unknown): number {
    if (!this.isMessageFrame(frame)) return 0;
    return frame.messageFrame.messages.filter((message) =>
      accessID === undefined || message.accessID === accessID).length;
  }

  GetMessageInfo(frame: FrameXmlFrame, index: number, accessID?: unknown): readonly unknown[] {
    if (!this.isMessageFrame(frame)) return [];
    const messages = frame.messageFrame.messages.filter((message) =>
      accessID === undefined || message.accessID === accessID);
    const message = messages[Math.max(0, Math.trunc(index) - 1)];
    if (!message) return [];
    return [message.text, message.accessID, message.lineID, message.extraData];
  }

  RemoveMessagesByAccessID(frame: FrameXmlFrame, accessID: unknown): boolean {
    if (!this.isMessageFrame(frame)) return false;
    const state = frame.messageFrame;
    const before = state.messages.length;
    state.messages = state.messages.filter((message) => message.accessID !== accessID);
    if (state.messages.length === before) return true;
    state.revision += 1;
    this.refreshMessageScroll(frame, frame.scroll.verticalScroll >= frame.scroll.verticalScrollRange);
    this.notifyMutation();
    return true;
  }

  AtBottom(frame: FrameXmlFrame): boolean {
    return this.isMessageFrame(frame)
      && frame.scroll.verticalScroll >= frame.scroll.verticalScrollRange;
  }

  SetVerticalScroll(frame: FrameXmlFrame, offset: number): boolean {
    if (!this.isMessageFrame(frame)) return false;
    const wanted = Math.max(0, Math.min(frame.scroll.verticalScrollRange,
      Number.isFinite(offset) ? offset : 0));
    if (wanted === frame.scroll.verticalScroll) return true;
    frame.scroll.verticalScroll = wanted;
    this.notifyMutation();
    return true;
  }

  GetVerticalScroll(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.scroll.verticalScroll : 0;
  }

  GetVerticalScrollRange(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.scroll.verticalScrollRange : 0;
  }

  ScrollUp(frame: FrameXmlFrame): boolean {
    return this.SetVerticalScroll(frame, this.GetVerticalScroll(frame) - 1);
  }

  ScrollDown(frame: FrameXmlFrame): boolean {
    return this.SetVerticalScroll(frame, this.GetVerticalScroll(frame) + 1);
  }

  PageUp(frame: FrameXmlFrame): boolean {
    return this.SetVerticalScroll(frame, this.GetVerticalScroll(frame) - 10);
  }

  PageDown(frame: FrameXmlFrame): boolean {
    return this.SetVerticalScroll(frame, this.GetVerticalScroll(frame) + 10);
  }

  ScrollToBottom(frame: FrameXmlFrame): boolean {
    return this.SetVerticalScroll(frame, this.GetVerticalScrollRange(frame));
  }

  SetMaxLines(frame: FrameXmlFrame, maxLines: number): boolean {
    if (!this.isMessageFrame(frame)) return false;
    const next = Math.max(0, Math.trunc(Number.isFinite(maxLines) ? maxLines : frame.messageFrame.maxLines));
    if (next === frame.messageFrame.maxLines) return true;
    frame.messageFrame.maxLines = next;
    const stickToBottom = this.AtBottom(frame);
    if (frame.messageFrame.messages.length > next) {
      frame.messageFrame.messages.splice(0, frame.messageFrame.messages.length - next);
    }
    frame.messageFrame.revision += 1;
    this.refreshMessageScroll(frame, stickToBottom);
    this.notifyMutation();
    return true;
  }

  GetMaxLines(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.messageFrame.maxLines : 0;
  }

  SetTimeVisible(frame: FrameXmlFrame, duration: number): boolean {
    if (!this.isMessageFrame(frame)) return false;
    frame.messageFrame.displayDuration = Math.max(0,
      Number.isFinite(duration) ? duration : frame.messageFrame.displayDuration);
    this.notifyMutation();
    return true;
  }

  GetTimeVisible(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.messageFrame.displayDuration : 0;
  }

  SetTexture(frame: FrameXmlFrame, texture: unknown): boolean {
    const mutable = this.own(frame);
    if (!mutable || typeof texture !== "string") return false;
    mutable.texture = texture;
    this.notifyMutation();
    return true;
  }

  /**
   * `Frame:SetAttribute(name, value)` — a real store, and the `OnAttributeChanged` that follows it.
   *
   * The handler fires on **every** call rather than only on a change, which is the client's own
   * behaviour and the one the corpus is written against: `UIDropDownMenuDelegate` re-opens a menu
   * by writing `openmenu` with the frame it already holds, and a change guard would silently drop
   * that. The name the handler receives is the normalised one — see `FrameXmlAttributes.ts` for
   * why that matches every handler in this corpus.
   *
   * Dispatch is the caller's, not this method's: the bridge stores and reports, and the host
   * decides whether a script runs (`fireScript`). That keeps this file free of the re-entrancy
   * question and keeps the Lua side able to write an attribute without one.
   */
  SetAttribute(frame: FrameXmlFrame, name: unknown, value: unknown): string | undefined {
    const mutable = this.own(frame);
    const key = frameXmlAttributeKey(name);
    if (!mutable || key === undefined) return undefined;
    mutable.secureAttributes.set(key, value);
    this.notifyMutation();
    return key;
  }

  /**
   * `Frame:GetAttribute(name)` and `Frame:GetAttribute(prefix, name, suffix)`.
   *
   * `argumentCount` is what tells the two apart, exactly as the real API does — not "is the third
   * argument nil", because `SecureButton_GetAttribute` calls the three-argument form with two
   * empty strings and the one-argument form is a plain lookup.
   */
  GetAttribute(
    frame: FrameXmlFrame,
    first: unknown,
    second?: unknown,
    third?: unknown,
    argumentCount = third === undefined && second === undefined ? 1 : 3,
  ): unknown {
    const mutable = this.own(frame);
    if (!mutable) return undefined;
    if (argumentCount < 3) {
      const key = frameXmlAttributeKey(first);
      return key === undefined ? undefined : mutable.secureAttributes.get(key);
    }
    for (const candidate of frameXmlAttributeCandidates(first, second, third)) {
      const value = mutable.secureAttributes.get(candidate);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** `Cooldown:SetCooldown(start, duration)`, both in `GetTime()` seconds. */
  SetCooldown(frame: FrameXmlFrame, start: number, duration: number): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutable.cooldown.start = Number.isFinite(start) ? start : 0;
    mutable.cooldown.duration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    this.notifyMutation();
    return true;
  }

  /** Mutate one widget field and raise a single coalesced render notification. */
  update(frame: FrameXmlFrame, mutate: (frame: MutableFrameXmlFrame) => void): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutate(mutable);
    this.notifyMutation();
    return true;
  }

  /** Read-only accessor used by the glue widget layer to reach mutable state. */
  resolve(frame: FrameXmlFrame | undefined): MutableFrameXmlFrame | undefined {
    return this.own(frame);
  }

  /** Announce that a widget changed; coalesced while a handler is running. */
  touch(): void {
    this.notifyMutation();
  }
}

export type { MutableFrameXmlFrame };
