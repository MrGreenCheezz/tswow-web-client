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
import { plainFrameXmlText } from "./FrameXmlText.js";
import {
  FRAME_XML_MESSAGE_FADE_DURATION,
  FRAME_XML_MESSAGE_TIME_VISIBLE,
  FrameXmlMessageFades,
  frameXmlInsertMode,
  frameXmlMessageLayout, // L5 3.34
  frameXmlReviveMessageFades, // L5 3.34 (was frameXmlResetMessageFades)
  frameXmlRetimeFading,
  frameXmlRetimeShown,
  frameXmlStampMessage,
} from "./FrameXmlMessageFade.js";

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
  // The rest of the handler names the dataset's FrameXML declares, audited against their bodies —
  // a name missing here compiles with `self` alone, so a body reading its arguments reads globals.
  // `GameTooltipTemplate.xml:248-253` is `GameTooltip_OnTooltipAddMoney(self, cost, maxcost)`; the
  // ScrollingEdit bodies (12 of them) pass `x, y-10, w, h` on; `ActionBarFrame.xml` passes
  // `name, value` and, from its `<PostClick>`, `button, down`. The GameTooltip notifications carry
  // only the tooltip. `PreClick`/`PostClick` are the two script names without the `On` (see
  // `SCRIPT_NODE`; `Click` raises them around OnClick).
  OnTooltipAddMoney: ["self", "cost", "maxcost"],
  OnTooltipSetDefaultAnchor: ["self"],
  OnTooltipCleared: ["self"],
  OnTooltipSetItem: ["self"],
  OnTooltipSetSpell: ["self"],
  OnTooltipSetUnit: ["self"],
  OnTooltipSetQuest: ["self"],
  OnTooltipSetAchievement: ["self"],
  OnHyperlinkEnter: ["self", "link", "text"],
  OnHyperlinkLeave: ["self", "link", "text"],
  OnAttributeChanged: ["self", "name", "value"],
  OnCursorChanged: ["self", "x", "y", "w", "h"],
  PreClick: ["self", "button", "down"],
  PostClick: ["self", "button", "down"],
  OnInputLanguageChanged: ["self", "language"],
  OnColorSelect: ["self", "r", "g", "b"],
  OnMinMaxChanged: ["self", "min", "max"],
});

/**
 * Everything the bridge treats as a script node inside `<Scripts>`: the `On…` handlers, and the
 * click wrappers `PreClick`/`PostClick`, which 3.3.5 names without the prefix. The dataset declares
 * four such bodies — `<PostClick>` on ActionButtonTemplate (`ActionButton_UpdateState(self, button,
 * down)`) and MultiCastActionButton, `<PreClick>self:SetChecked(0)` on SpellButtonTemplate and
 * PetActionButtonTemplate — and before they were read here none of them ever ran.
 */
const SCRIPT_NODE = /^(?:On[A-Z][A-Za-z0-9_]*|PreClick|PostClick)$/;

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

/** Which axes a frame's anchors pin on both edges, so that its size there is theirs. */
function anchoredEdges(frame: FrameXmlFrame): { readonly x: boolean; readonly y: boolean } {
  let left = false;
  let right = false;
  let top = false;
  let bottom = false;
  for (const point of frame.points) {
    const roles = anchorRoles(point.point);
    if (roles.x === "LEFT") left = true;
    else if (roles.x === "RIGHT") right = true;
    if (roles.y === "TOP") top = true;
    else if (roles.y === "BOTTOM") bottom = true;
  }
  return { x: left && right, y: top && bottom };
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
    // An AnimationGroup's (or an Animation's) own <Scripts> belong to that object — GlueWidgets
    // bindAnimations binds them there. Walking into <Animations> gave the owning frame the group's
    // handlers too: AnimTimerFrame.xml:27-30's group OnLoad `self:Play()` ran as the frame's OnLoad
    // and reached a Frame:Play census stub (plan item 3.21).
    if (name === "Animations") return;
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

/** What a change can affect, from least to most: see `FrameXmlUiBridge.layoutVersion`. */
export type FrameXmlMutationKind = "paint" | "layout" | "structure";

/** How `SetText` announces a FontString's new text; see `FrameXmlUiBridge.setTextLayoutPolicy`. */
export type FrameXmlTextLayoutPolicy = "auto" | "always";

/** A line break the string draws: a real one, or the `|n` escape. */
const TEXT_LINE_BREAK = /\r|\n|\|n/;

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
  /** Bumped by every announced change to this frame; see `FrameXmlUiBridge.notifyMutation`. */
  renderVersion = 0;
  /**
   * Some anchor has named this frame as its `relativeTo` — the frame's box is measured by another
   * frame's placement. Monotonic: set by every anchor writer (`readAnchor`,
   * `resolvePendingRelativePoints`, `SetPoint`, `SetAllPoints`, and `update` of any kind but paint as
   * the safety net) and never cleared, so a string that was ever a target keeps announcing its
   * text as layout (`FrameXmlUiBridge.textOnlyPaints`).
   */
  anchorTarget = false;
  text = "";
  texture = "";
  loaded = false;

  drawLayer = "ARTWORK";
  drawSubLevel = 0;
  texCoords: FrameXmlTexCoords | undefined;
  vertexColor: FrameXmlColor | undefined;
  /** See `FrameXmlFrame.colorFill`. */
  colorFill = false;
  gradient: FrameXmlGradient | undefined;
  alphaMode = "BLEND";
  desaturated = false;
  textureRotation = 0;
  portrait = false;
  readonly clickRegistrations = new Set<string>();
  readonly dragRegistrations = new Set<string>();
  clampedToScreen = false;
  movable = false;
  moving = false;
  tooltipCursorAnchor: { readonly x: number; readonly y: number } | undefined;
  tooltipMinimumWidth = 0;
  backdrop: FrameXmlBackdrop | undefined;
  backdropColor: FrameXmlColor | undefined;
  backdropBorderColor: FrameXmlColor | undefined;
  fontObject = "";
  inheritsButtonFont = false;
  textColor: FrameXmlColor | undefined;
  justifyH = "CENTER";
  justifyV = "MIDDLE";
  /**
   * The alignment is the string's own — a `justifyH`/`justifyV` on its `<ButtonText>`, or
   * `SetJustifyH`/`SetJustifyV` — rather than its font object's. Only a label that draws in its
   * button's state font reads these; see `syncButtonLabelFont`.
   */
  ownJustifyH = false;
  ownJustifyV = false;
  readonly stateTextures = new Map<string, FrameXmlFrame>();
  stateTexture = "";
  readonly stateFonts = new Map<string, string>();
  buttonState = "NORMAL";
  highlightLocked = false;
  enabled = true;
  checked = false;
  alpha = 1;
  animationAlpha: number | undefined;
  animationTransform: string | undefined;
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
    autoFocus: true, history: [], historyIndex: -1, cursorPosition: 0, selectionRevision: 0,
  };
  readonly messageFrame: FrameXmlMessageFrameState = {
    maxLines: 128, displayDuration: FRAME_XML_MESSAGE_TIME_VISIBLE, nonSpaceWrap: false, messages: [], revision: 0,
    fading: true, fadeDuration: FRAME_XML_MESSAGE_FADE_DURATION, insertMode: "BOTTOM", fadeClock: 0, fadeRevision: 0,
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
    // The client starts typed text at the left edge; only a FontString centres by default. No
    // EditBox in the dataset corpus declares a justifyH (61 declarations, none on the box or its
    // font string), and each pairs a `<TextInsets left=…>` with that left edge — the chat box's
    // `SetTextInsets(15 + header width, …)`, the login boxes' `left="12"`.
    if (type === "EditBox") this.justifyH = "LEFT";
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

/**
 * The screen a host that measures nothing is assumed to have: 3.3.5 lays its UI out on a
 * 768-unit-high logical screen (`GetScreenHeight()` answers 768 at UI scale 1, and
 * `UIDropDownMenu.lua:746` still says «GetCenter() is returning coords relative to 1024x768»).
 */
const FRAME_XML_FALLBACK_SCREEN = Object.freeze({ width: 1024, height: 768 });

/** P1-14d: the hooks of a script nobody hooked — shared and frozen instead of a `[]` per dispatch. */
export const NO_HOOKS: readonly FrameXmlScriptHandler[] = Object.freeze([]);

/** How many frames `layoutReaches` walks before it assumes a change reaches the box it asks about. */
const LAYOUT_REACH_LIMIT = 256;

/**
 * A box the page sizes from what is inside it: a tooltip, whose grid of lines is its size, or a
 * button with an axis that neither a size of its own nor two anchors on opposite edges fix — it keeps
 * its label in flow (`FrameXmlDomRenderer.applyButtonLabel`). Every other child is absolutely
 * positioned and sizes nothing around it; a string's text is its own change.
 */
function sizedByContent(frame: FrameXmlFrame): boolean {
  if (frame.type === "GameTooltip") return true;
  if (frame.type !== "Button" && frame.type !== "CheckButton") return false;
  const pinned = anchoredEdges(frame);
  return !((pinned.x || Number(frame.attributes["width"]) > 0) && (pinned.y || Number(frame.attributes["height"]) > 0));
}

/** The frames the next dispatch of one event leaves out; see `withEventOwnersExcluded`. */
let pendingEventExclusion: { readonly event: string; readonly owners: ReadonlySet<string> } | undefined;

/**
 * `dispatchEventExcept` for a caller that holds only an event pump — a world seam, whose `fire` is
 * the bridge's `dispatchEvent` one call down. The first dispatch of `event` that `fire` causes, on
 * whichever bridge, skips the frames named in `owners`; the exclusion is taken by that dispatch, so
 * a handler firing the same event again is delivered as usual, and it never outlives `fire`.
 */
export function withEventOwnersExcluded<T>(event: string, owners: ReadonlySet<string>, fire: () => T): T {
  const previous = pendingEventExclusion;
  pendingEventExclusion = { event, owners };
  try {
    return fire();
  } finally {
    pendingEventExclusion = previous;
  }
}

function takeEventExclusion(event: string): ReadonlySet<string> | undefined {
  const pending = pendingEventExclusion;
  if (pending === undefined || pending.event !== event) return undefined;
  pendingEventExclusion = undefined;
  return pending.owners;
}

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
  /** Per-frame change observers; see `observeFrameMutations`. */
  readonly #frameObservers = new Set<(frame: FrameXmlFrame, kind: FrameXmlMutationKind) => void>();
  /** event name -> frames registered for it; kept so dispatch is not O(all frames). */
  readonly #byEvent = new Map<string, Set<MutableFrameXmlFrame>>();
  /**
   * Frames with any OnUpdate at all. The corpus declares 33 of them across
   * ~2,000 widgets, so ticking the index instead of the whole set is the
   * difference between a per-frame walk of tens and one of thousands.
   */
  readonly #updateFrames = new Set<MutableFrameXmlFrame>();
  /** Message frames whose lines are counting down (3.34); only these are looked at by `tick`. */
  readonly #messageFades = new FrameXmlMessageFades();
  readonly #messageFadeHost = {
    visible: (frame: FrameXmlFrame): boolean => this.isVisible(frame),
    cleared: (frame: FrameXmlFrame): void => {
      const mutable = this.own(frame);
      if (!mutable) return;
      mutable.messageFrame.revision += 1;
      this.refreshMessageScroll(mutable, true);
      this.notifyMutation(mutable, "paint");
    },
  };
  readonly #createdRoots: FrameXmlFrame[] = [];
  /** Frames created through the Lua/host CreateFrame APIs, for root bookkeeping after SetParent. */
  readonly #createdFrames = new Set<MutableFrameXmlFrame>();
  readonly #modelFrames = new Set<FrameXmlFrame>();
  #measure: ((frame: FrameXmlFrame) => { width: number; height: number } | undefined) | undefined;
  #measureText: ((frame: FrameXmlFrame, text: string) => number | undefined) | undefined;
  #screenRectSource: ((frame: FrameXmlFrame) => FrameXmlRect | undefined) | undefined;
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
  /** The pending notification carries a change that can move something, not paint only. */
  #pendingLayout = false;
  /** See `setPaintDeferral`. */
  #deferPaint = false;
  /** See `setLayoutDeferral`. */
  #deferLayout = false;
  /** See `setTextLayoutPolicy`. */
  #textLayoutPolicy: FrameXmlTextLayoutPolicy = "always";
  /**
   * A notification held at the outermost level carries a change that can move something, so the
   * page is not what the bridge says until it is announced; see `settleDeferredLayout`.
   */
  #heldLayout = false;
  /**
   * With `setLayoutDeferral` on: the frames given a layout change by a batch that has ended and is
   * held, and whether a change that names no frame was among them. A read settles held layout only
   * when one of these can have moved the box it reads (`layoutReaches`).
   */
  readonly #heldLayoutFrames = new Set<FrameXmlFrame>();
  #heldFrameless = false;
  /**
   * The same for the outermost batch still running. A read inside a batch never saw that batch's
   * own changes on the page, and still does not unless a held change makes it settle.
   */
  readonly #batchLayoutFrames = new Set<FrameXmlFrame>();
  #batchFrameless = false;
  /** Inside a renderer's own reconciliation walk; see `runInRenderPass`. */
  #renderPassDepth = 0;
  #mutationVersion = 0;
  /** Changes to the tree itself (create, reparent, scroll child) and frameless touches. */
  #structureVersion = 0;
  /** Changes that can move or resize something (anchors, sizes, text, visibility). */
  #layoutVersion = 0;
  /** Lua `SetFocus`/`ClearFocus` calls so far; `Show` compares it across its OnShow scripts. */
  #focusRequests = 0;

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

  /**
   * Bumped by a change to the frame tree, or by a notification that names no frame. A renderer
   * that sees it unchanged may skip hidden subtrees and the ownership sweep; see
   * `FrameXmlDomRenderer.syncPass`.
   */
  get structureVersion(): number {
    return this.#structureVersion;
  }

  /**
   * Bumped by anything that can move or resize a frame. Unchanged means every change since the
   * last render was paint only — alpha, colour, texcoords, a bar's fill, a cooldown — and nothing
   * measured from the layout needs measuring again.
   */
  get layoutVersion(): number {
    return this.#layoutVersion;
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

  /** Intrinsic glyph width, independent of the box a tab or wrapped label currently occupies. */
  setTextMeasure(measure: ((frame: FrameXmlFrame, text: string) => number | undefined) | undefined): void {
    this.#measureText = measure;
  }

  measureText(frame: FrameXmlFrame): number {
    const label = frame.stateTextures.get("BUTTONTEXT") ?? frame;
    const text = plainFrameXmlText(label.text);
    if (!text) return 0;
    const measured = this.#measureText?.(label, text);
    if (measured !== undefined && Number.isFinite(measured) && measured > 0) return measured;
    // OnLoad runs before a renderer exists. Keep auto-sized labels useful during that pass;
    // once mounted, the host supplies font metrics even for hidden panels.
    const style = label.fontObject ? this.fontObjectStyle(label.fontObject) : undefined;
    const height = Number(label.attributes["fontHeight"] ?? style?.height ?? 14);
    return Math.max(...text.split(/\r\n|\r|\n/).map((line) => [...line].length)) * height * 0.5;
  }

  /**
   * 3.35-bounds: the glyph width of `text` in a font object — a SimpleHTML block's lines, which are no
   * frame of their own. The host's measure reads only a frame's font fields, so it is handed those.
   */
  measureFontText(fontObject: string, text: string): number {
    if (!text) return 0;
    const probe = { fontObject, attributes: {}, stateTextures: new Map(), text } as unknown as FrameXmlFrame;
    const measured = this.#measureText?.(probe, text);
    if (measured !== undefined && Number.isFinite(measured) && measured > 0) return measured;
    const style = fontObject ? this.fontObjectStyle(fontObject) : undefined;
    return [...text].length * Number(style?.height ?? 14) * 0.5;
  }

  /** Trusted host cursor coordinates in logical UI units, with Y measured from the bottom. */
  setMousePosition(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) this.#mousePosition = [x, y];
  }

  get mousePosition(): readonly [number, number] { return this.#mousePosition; }

  /**
   * Effective size: what the host laid out, else the distance between two opposite anchors, else
   * the declared attributes.
   *
   * Two anchors on opposite edges size a region in the client whatever it declares: the LFD list's
   * dungeon name is `<Size x="0">` with LEFT on its row at 40 and RIGHT on the level text's LEFT at
   * -10 (LFGFrame.xml:118-134). Before a host has laid it out — OnLoad, a Node boot — its width
   * used to be the text's own width, so `GetRight` answered `left + text width`.
   */
  measure(frame: FrameXmlFrame): { readonly width: number; readonly height: number } {
    return this.sizeOf(frame, true);
  }

  private sizeOf(frame: FrameXmlFrame, spans: boolean): { readonly width: number; readonly height: number } {
    // The host measures the page, so the page has to show every change that can reach this box.
    if (this.#heldLayout) this.settleDeferredLayout(frame);
    const measured = this.#measure?.(frame);
    let width = measured && measured.width > 0 ? measured.width : undefined;
    let height = measured && measured.height > 0 ? measured.height : undefined;
    if (spans && (width === undefined || height === undefined) && frame.points.length > 1) {
      const pinned = anchoredEdges(frame);
      if ((pinned.x && width === undefined) || (pinned.y && height === undefined)) {
        const rect = this.screenRect(frame, this.logicalScreen());
        const scale = this.effectiveScale(frame);
        if (pinned.x && width === undefined) width = rect.width / scale;
        if (pinned.y && height === undefined) height = rect.height / scale;
      }
    }
    const declaredWidth = Number(frame.attributes["width"]);
    const declaredHeight = Number(frame.attributes["height"]);
    const autoTextWidth = frame.type === "FontString" && (!Number.isFinite(declaredWidth) || declaredWidth === 0);
    // A string with no height of its own is as tall as its text, as `GetStringHeight` already said:
    // `OpenMail_Update` stacks the attachment rows under `OpenMailAttachmentText:GetHeight()`
    // (MailFrame.lua:612), and a 0 put «Забрать приложения:» 14 units low, under the letter button.
    const autoTextHeight = frame.type === "FontString" && (!Number.isFinite(declaredHeight) || declaredHeight === 0);
    return {
      width: width ?? (autoTextWidth ? this.measureText(frame) : Number.isFinite(declaredWidth) ? declaredWidth : 0),
      height: height ?? (autoTextHeight ? this.textHeight(frame) : Number.isFinite(declaredHeight) ? declaredHeight : 0),
    };
  }

  /** The height of a string's own lines in its font: explicit line breaks only, no wrapping. */
  private textHeight(frame: FrameXmlFrame): number {
    const text = plainFrameXmlText(frame.text);
    if (!text) return 0;
    const style = frame.fontObject ? this.fontObjectStyle(frame.fontObject) : undefined;
    const fontHeight = Number(frame.attributes["fontHeight"] ?? style?.height ?? 14);
    return text.split(/\r\n|\r|\n/).length * (Number.isFinite(fontHeight) && fontHeight > 0 ? fontHeight : 14);
  }

  /**
   * `GetEffectiveScale`: the product of this frame's scale and every ancestor's.
   *
   * Bounded like the renderer's walks — a malformed parent chain must not loop — and a scale that
   * is not a positive number counts as 1, which is what the setters already refuse to store.
   */
  effectiveScale(frame: FrameXmlFrame): number {
    let scale = 1;
    let current: FrameXmlFrame | undefined = frame;
    for (let depth = 0; current && depth < 64; depth += 1) {
      scale *= Number.isFinite(current.scale) && current.scale > 0 ? current.scale : 1;
      current = current.parent;
    }
    return scale;
  }

  /**
   * The logical screen every frame is placed on, in UI units: what `UIParent` (in the world) or
   * `GlueParent` (on the glue screens) measures, else the client's 768-unit-high default.
   *
   * A frame with no parent is positioned against the *screen* in the client, not against its own
   * box. `DropDownList1/2` are the stock case (`UIDropDownMenu.xml:5,16`, toplevel and parentless):
   * measured against themselves, the tracking list's `GetCenter()` came out at y = -28 and
   * `GetTop()` -5 with `GetScreenHeight()` 768, so `ToggleDropDownMenu`'s «off the bottom of the
   * screen» test (`UIDropDownMenu.lua:757`) fired on every list and flipped it upward, off the top.
   */
  private logicalScreen(): { readonly width: number; readonly height: number } {
    for (const name of ["UIParent", "GlueParent"]) {
      const root = this.#byName.get(name);
      if (!root) continue;
      // Not `measure`: the screen is what the anchor arithmetic starts from, so it cannot ask it.
      const size = this.sizeOf(root, false);
      if (size.width > 0 && size.height > 0) return size;
    }
    return { width: FRAME_XML_FALLBACK_SCREEN.width, height: FRAME_XML_FALLBACK_SCREEN.height };
  }

  /**
   * Where a frame sits on the logical screen, in unscaled UI units with a CSS (top-origin) Y axis.
   *
   * Scale is folded in the way the renderer draws it: a frame's size and its anchor offsets are in
   * its *own* units, so both are multiplied by its effective scale on the way to the screen (the
   * renderer writes `offset * scale` in the parent's box, and the parent's box is itself scaled by
   * the parent's effective scale).
   *
   * Every anchor counts, the way the renderer places the box: two anchors on opposite edges of an
   * axis span it (the second one used to be ignored, so a region pinned LEFT and RIGHT reported its
   * text's width from its left edge); otherwise an edge wins over a centre, and the last anchor of a
   * role over an earlier one. Rectangles are memoised per question, so a chain of two-anchor frames
   * resolves each ancestor once.
   */
  private screenRect(frame: FrameXmlFrame, screen: { readonly width: number; readonly height: number }): FrameXmlRect {
    // Keep anchor recursion in CSS/top-origin coordinates. The public WoW methods use a
    // bottom-origin vertical axis, so converting each recursive rectangle would make relative
    // anchors mix coordinate systems.
    const screenBox: FrameXmlRect = { left: 0, top: 0, width: screen.width, height: screen.height,
      right: screen.width, bottom: screen.height };
    const resolved = new Map<FrameXmlFrame, FrameXmlRect>();
    const resolve = (current: FrameXmlFrame, visiting: Set<FrameXmlFrame>): FrameXmlRect => {
      const known = resolved.get(current);
      if (known) return known;
      const scale = this.effectiveScale(current);
      if (visiting.has(current)) {
        const own = this.sizeOf(current, false);
        return { left: 0, top: 0, width: own.width * scale, height: own.height * scale,
          right: own.width * scale, bottom: own.height * scale };
      }
      visiting.add(current);
      // No parent means the screen itself, which is also what `UIParent` covers.
      const parent = current.parent ? resolve(current.parent, visiting) : screenBox;
      const x: Partial<Record<"LEFT" | "RIGHT" | "CENTER", number>> = {};
      const y: Partial<Record<"TOP" | "BOTTOM" | "CENTER", number>> = {};
      for (const point of current.points) {
        const relative = point.relativeTo ? resolve(point.relativeTo, visiting) : parent;
        const anchor = anchorRoles(point.point);
        const target = anchorRoles(point.relativePoint ?? point.point);
        x[anchor.x] = (target.x === "LEFT" ? relative.left
          : target.x === "RIGHT" ? relative.right : relative.left + relative.width / 2) + (point.x ?? 0) * scale;
        // FrameXML's positive Y points upward; the rectangle is CSS/top-origin.
        y[anchor.y] = (target.y === "TOP" ? relative.top
          : target.y === "BOTTOM" ? relative.bottom : relative.top + relative.height / 2) - (point.y ?? 0) * scale;
      }
      visiting.delete(current);
      const spanX = x.LEFT !== undefined && x.RIGHT !== undefined;
      const spanY = y.TOP !== undefined && y.BOTTOM !== undefined;
      const own = spanX && spanY ? { width: 0, height: 0 } : this.sizeOf(current, false);
      const width = spanX ? Math.max(0, x.RIGHT! - x.LEFT!) : own.width * scale;
      const height = spanY ? Math.max(0, y.BOTTOM! - y.TOP!) : own.height * scale;
      // An unanchored axis sits at the parent's origin — where the renderer's absolutely positioned
      // box without offsets lands.
      const left = x.LEFT ?? (x.RIGHT !== undefined ? x.RIGHT - width
        : x.CENTER !== undefined ? x.CENTER - width / 2 : parent.left);
      const top = y.TOP ?? (y.BOTTOM !== undefined ? y.BOTTOM - height
        : y.CENTER !== undefined ? y.CENTER - height / 2 : parent.top);
      const rect = { left, top, width, height, right: left + width, bottom: top + height };
      resolved.set(current, rect);
      return rect;
    };
    return resolve(frame, new Set());
  }

  /**
   * `GetLeft`/`GetRight`/`GetTop`/`GetBottom`/`GetCenter`/`GetRect`: WoW's bottom-origin rectangle,
   * in the frame's own (scaled) coordinate system — screen position divided by the effective scale,
   * which is what stock code pairs with `GetCursorPosition() / GetEffectiveScale()` and `GetWidth()`.
   */
  geometry(frame: FrameXmlFrame): FrameXmlRect {
    const screen = this.logicalScreen();
    const css = this.screenRect(frame, screen);
    const scale = this.effectiveScale(frame);
    return {
      left: css.left / scale,
      top: (screen.height - css.top) / scale,
      width: css.width / scale,
      height: css.height / scale,
      right: css.right / scale,
      bottom: (screen.height - css.bottom) / scale,
    };
  }

  /**
   * Let the host answer "where is this frame on the screen right now": unscaled UI units, left
   * origin, Y measured upward — `GetCursorPosition`'s own frame. The renderer answers from the laid
   * out page and keeps the answer until its next paint; see `FrameXmlDomRenderer.screenRectOf`.
   */
  setScreenRectSource(source: ((frame: FrameXmlFrame) => FrameXmlRect | undefined) | undefined): void {
    this.#screenRectSource = source;
  }

  /**
   * `Frame:IsMouseOver(top, bottom, left, right)`: the cursor inside the frame's box, each edge
   * pushed out by its offset (in the frame's own units; positive top/right grow the box).
   *
   * Stock code calls it every frame — `FCF_OnUpdate` three times per chat window
   * (`FloatingChatFrame.lua:1074-1076`, the chat fade) and `WorldMapButton_OnUpdate` once per unit
   * button — so it reads a rectangle the renderer already has, never the bridge's recursive anchor
   * walk unless there is no renderer. A frame that is not visible is never under the cursor.
   */
  isMouseOver(frame: FrameXmlFrame, top = 0, bottom = 0, left = 0, right = 0): boolean {
    if (!this.own(frame) || !this.isVisible(frame)) return false;
    if (this.#heldLayout) this.settleDeferredLayout(frame);
    let rect = this.#screenRectSource?.(frame);
    if (!rect) {
      const screen = this.logicalScreen();
      const css = this.screenRect(frame, screen);
      rect = { left: css.left, right: css.right, width: css.width, height: css.height,
        top: screen.height - css.top, bottom: screen.height - css.bottom };
    }
    const scale = this.effectiveScale(frame);
    const [x, y] = this.#mousePosition;
    return x >= rect.left + left * scale && x <= rect.right + right * scale
      && y >= rect.bottom + bottom * scale && y <= rect.top + top * scale;
  }

  /**
   * Keep the size a host actually laid a frame out at, for Lua's `GetWidth`/`GetHeight`, without
   * announcing it.
   *
   * The GameTooltip is the user: its box is sized by the page from the measured rows, and stock
   * code reads it back (`SetTooltipMoney`, `GameTooltip_ShowCompareItem`'s `GetRight`/`GetWidth`).
   * Nothing is re-rendered, because the page already shows exactly this size; announcing it would
   * make the renderer re-apply the tooltip once more after every content change, for nothing.
   */
  recordLaidOutSize(frame: FrameXmlFrame, width: number, height: number): boolean {
    const mutable = this.own(frame);
    if (!mutable || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
    const nextWidth = String(Math.round(width * 100) / 100);
    const nextHeight = String(Math.round(height * 100) / 100);
    if (mutable.attributes["width"] === nextWidth && mutable.attributes["height"] === nextHeight) return false;
    mutable.setAttribute("width", nextWidth);
    mutable.setAttribute("height", nextHeight);
    return true;
  }

  /**
   * Put a Button's inheriting label in the font its state calls for: the `<DisabledFont>` while the
   * button is disabled, otherwise the `<NormalFont>` (or `SetNormalFontObject`).
   *
   * 3.3.5 draws a button's text in the button's state fonts; the label FontString has none of its
   * own. Before this the stock `CharacterFrameTabButtonTemplate` label (NormalFont
   * GameFontNormalSmall, DisabledFont GameFontHighlightSmall) had no font object at all, painted in
   * the host's 16px default and measured `GetStringWidth("Персонаж")` = 65.46 instead of the
   * 10-point Friz width, which is what sized every tab too wide; the selected (disabled) tab never
   * turned white. The highlight font is a pointer state and belongs to the renderer.
   *
   * The label is justified by that font too, unless it has an alignment of its own (`ownJustifyH`):
   * a FontString's justification is its font object's until the string sets one. Every row of the
   * stock profession and trainer lists is `ClassTrainerSkillButtonTemplate`, a bare `<ButtonText>`
   * over `<NormalFont style="GameFontNormalLeft"/>` that Lua re-fonts per row
   * (`SetNormalFontObject(TradeSkillTypeColor[…].font)`, all `…Left`); with the label kept at its
   * CENTER default the recipe names, the headings and the collapse-all «Все» were drawn centred.
   */
  syncButtonLabelFont(frame: FrameXmlFrame, announce = true): boolean {
    const button = this.own(frame);
    const label = this.own(button?.stateTextures.get("BUTTONTEXT"));
    if (!button || !label || !label.inheritsButtonFont) return false;
    const font = (!button.enabled ? button.stateFonts.get("DISABLED") : undefined)
      || button.stateFonts.get("NORMAL") || button.fontObject;
    if (!font || label.fontObject === font) return false;
    label.fontObject = font;
    if (!label.ownJustifyH || !label.ownJustifyV) {
      const style = this.fontStyle(font) ?? this.fontObjectStyle(font);
      if (!label.ownJustifyH) label.justifyH = style?.justifyH || "CENTER";
      if (!label.ownJustifyV) label.justifyV = style?.justifyV || "MIDDLE";
    }
    if (announce) this.notifyMutation(label);
    return true;
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
   * Hear every announced change to a named frame, with its kind, as it is made (before the batch
   * that holds it notifies `subscribe`rs). A renderer uses it to reconcile the frames that changed
   * instead of walking every drawn frame to find them; frameless changes (`touch`, tree
   * creation) are not reported and bump `structureVersion`, which asks for the full walk.
   * Host-side only, like `subscribe`.
   */
  observeFrameMutations(observer: (frame: FrameXmlFrame, kind: FrameXmlMutationKind) => void): () => void {
    this.#frameObservers.add(observer);
    return () => this.#frameObservers.delete(observer);
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
   * `runInMutationBatch` for a world event: with `setLayoutDeferral` on, an outermost batch keeps
   * whatever it changed — a move, a new text, a shown frame included — for the host's frame step
   * instead of announcing it when it ends.
   *
   * The seam's pump opens one of these per event it delivers, and those arrive in bursts outside the
   * step: the store flush at the top of the game frame delivers every field that moved (a raid's
   * worth of health and power), and every packet in between delivers its own. A health event alone
   * sets the bar's value and its text, and the text is a layout change, so each such event used to
   * reconcile the page on its own — measured with the stock vertical and 40 health/power events of
   * five units: 40 layout passes before the step's own. Nested, or with deferral off, it is a plain
   * batch; nothing a script reads goes stale, because every layout read settles first
   * (`settleDeferredLayout`).
   */
  runInDeferrableBatch<T>(operation: () => T): T {
    if (!this.#deferLayout || this.#dispatchDepth !== 0 || this.#mutationDepth !== 0) {
      return this.runInMutationBatch(operation);
    }
    this.#mutationDepth += 1;
    try {
      return operation();
    } finally {
      this.#mutationDepth -= 1;
      // Held, not announced: the step's `flushDeferredPaint` (or the next announcement) carries it.
      if (this.#dispatchDepth === 0 && this.#mutationDepth === 0) this.holdBatch();
    }
  }

  /** The outermost batch ended without an announcement: what it changed is held now. */
  private holdBatch(): void {
    if (this.#pendingNotification && this.#pendingLayout) this.#heldLayout = true;
    for (const frame of this.#batchLayoutFrames) this.#heldLayoutFrames.add(frame);
    this.#batchLayoutFrames.clear();
    if (this.#batchFrameless) this.#heldFrameless = true;
    this.#batchFrameless = false;
  }

  /**
   * A renderer's own reconciliation walk, as one batch.
   *
   * The walk reads the bridge's geometry while it places frames (`FrameXmlDomRenderer`'s texture
   * corners), and a read settles held layout by announcing it (`settleDeferredLayout`) — which would
   * start the renderer's next pass inside the one still walking. A pass already reconciles every
   * change made before it, so reads inside one never settle.
   */
  runInRenderPass<T>(operation: () => T): T {
    return this.runInMutationBatch(() => {
      this.#renderPassDepth += 1;
      try {
        return operation();
      } finally {
        this.#renderPassDepth -= 1;
      }
    });
  }

  /**
   * Coalesce mutations raised while a handler or host transaction is running.
   *
   * One OnShow of the login frame performs hundreds of Show/SetText/SetPoint
   * calls; re-rendering after each would make the screen quadratic in its own
   * size. Notification is deferred to the outermost dispatch/transaction instead.
   */
  private notifyMutation(frame?: MutableFrameXmlFrame, kind: FrameXmlMutationKind = "layout"): void {
    // The frame's own version lets a renderer re-apply only what changed; a notification without
    // one is a change nobody can localise, and counts as structural.
    if (frame) {
      frame.renderVersion += 1;
      for (const observer of this.#frameObservers) observer(frame, kind);
    }
    if (!frame || kind === "structure") this.#structureVersion += 1;
    const layout = !frame || kind !== "paint";
    if (layout) this.#layoutVersion += 1;
    if (layout && this.#deferLayout) {
      if (frame) this.#batchLayoutFrames.add(frame);
      else this.#batchFrameless = true;
    }
    if (this.#dispatchDepth > 0 || this.#mutationDepth > 0) {
      this.#pendingNotification = true;
      if (layout) this.#pendingLayout = true;
      return;
    }
    if (this.#deferPaint && !layout) {
      this.#pendingNotification = true;
      return;
    }
    this.announce();
  }

  /**
   * Hold back notifications of paint-only changes made outside a batch the host marks as its frame
   * (`flushDeferredPaint`), and of batches that changed paint only.
   *
   * A paint change (alpha, colour, a bar's value, a cooldown, a message line) neither moves nor
   * shows anything, so nothing a script or the host reads — geometry, visibility, focus — depends
   * on when it reaches the page, and the page draws it no earlier than its next animation frame
   * anyway. The world mount turns this on and flushes at the end of its frame step, so every packet
   * event between two frames that only paints shares that frame's reconciliation instead of paying
   * one of its own (measured on the rich route: one paint pass per packet batch, 0.6 ms a frame in
   * a ten-events-a-frame storm). A layout or structural change is still announced at once, and it
   * carries whatever paint was held with it — unless a world event made it and `setLayoutDeferral`
   * holds that too.
   */
  setPaintDeferral(enabled: boolean): void {
    this.#deferPaint = enabled;
    if (!enabled) this.flushDeferredPaint();
  }

  /**
   * Hold back, as well, every change a world event makes (`runInDeferrableBatch`): moves, texts and
   * shown frames included, until the host's frame step announces them with `flushDeferredPaint`.
   *
   * What Lua and the host read stays what it was. Anything that measures the page — `GetWidth`,
   * `GetLeft`, `GetCenter`, `IsMouseOver`, the logical screen, a host's `elementFor` — first settles
   * held layout (`settleDeferredLayout`), so a script that reads after an earlier event moved a frame
   * gets the frame where that event put it, exactly as when every event was reconciled on its own.
   * Only the pump's events are held: a click or a key still reaches the page when its batch ends, so
   * focus and the pressed state follow the hand, not the next frame.
   */
  setLayoutDeferral(enabled: boolean): void {
    this.#deferLayout = enabled;
    if (!enabled) this.flushDeferredPaint();
  }

  /**
   * How `SetText` announces a FontString's new text (P1-15a). `"always"` (the default) is a layout
   * change, as it always was; `"auto"` makes it paint when nothing measures the string's box
   * (`textOnlyPaints`), so a buff timer or a health text rewritten every frame no longer costs the
   * frame step a layout pass. The world mount turns `"auto"` on next to `setPaintDeferral`;
   * `"always"` is the fallback and the oracle of the DOM-snapshot differential.
   */
  setTextLayoutPolicy(policy: FrameXmlTextLayoutPolicy): void {
    this.#textLayoutPolicy = policy === "auto" ? "auto" : "always";
  }

  get textLayoutPolicy(): FrameXmlTextLayoutPolicy {
    return this.#textLayoutPolicy;
  }

  /**
   * Whether `SetText(frame, next)` on a FontString can be announced as paint: no layout read
   * depends on the string's box, so the page may draw the new text with the next paint pass.
   *
   * All at once:
   * 1. the text stays empty or non-empty (`Boolean(old) === Boolean(new)`: emptiness shows/hides
   *    a button's native name and a modal's message); and a string without a fixed height neither
   *    wraps (a declared width, or `wordWrap="true"`) nor has a line break in the old or the new
   *    text — `GetHeight` reads its height from the page (`StaticPopup_Resize` right after
   *    `SetFormattedText`);
   * 2. nobody measures its box: no anchor names it (`anchorTarget`), or the box is fixed on both
   *    axes (a declared size > 0, or two opposite anchors); no ancestor is sized by its content
   *    (a tooltip, a sizeless button) or a ScrollFrame; it is not clamped to the screen;
   * 3. its own placement does not read its own size: the box is fixed, or every anchor is on its
   *    parent (a CSS expression; a sibling anchor's RIGHT/CENTER edge is «edge − size», measured);
   * 4. no accessible name is made of its text: no EditBox or Slider ancestor (their label is the
   *    caption's text), and not `<control>Text` beside a control (`namedPeer`).
   */
  private textOnlyPaints(frame: MutableFrameXmlFrame, next: string): boolean {
    if (frame.type !== "FontString") return false;
    const previous = frame.text;
    // Empty as drawn: a colour- or icon-only or blank string measures and names like no text
    // (P1-15a review: `"|cffff0000|r"` on a button's only label kept a stale aria-label).
    const drawn = (text: string | undefined): boolean => plainFrameXmlText(text ?? "").trim() !== "";
    if (drawn(previous) !== drawn(next)) return false;
    if (frame.clampedToScreen) return false;
    const pinned = anchoredEdges(frame);
    const width = Number(frame.attributes["width"]);
    const height = Number(frame.attributes["height"]);
    const fixedX = pinned.x || width > 0;
    const fixedY = pinned.y || height > 0;
    if (!fixedY) {
      if (width > 0 || frame.attributes["wordWrap"] === "true") return false;
      if (TEXT_LINE_BREAK.test(previous) || TEXT_LINE_BREAK.test(next)) return false;
    }
    const fixed = fixedX && fixedY;
    if (frame.anchorTarget && !fixed) return false;
    if (!fixed) {
      for (const point of frame.points) {
        if (point.relativeTo !== undefined && point.relativeTo !== frame.parent) return false;
      }
    }
    for (let at = frame.parent, depth = 0; at; at = at.parent, depth += 1) {
      if (depth >= 64) return false;
      if (at.type === "ScrollFrame" || at.type === "EditBox" || at.type === "Slider" || sizedByContent(at)) return false;
    }
    if (frame.named && frame.name.endsWith("Text")) {
      const peer = this.#byName.get(frame.name.slice(0, -4));
      if (peer && (peer.type === "Button" || peer.type === "CheckButton" || peer.type === "EditBox"
        || peer.type === "Slider")) return false;
    }
    return true;
  }

  /** Flag every frame `frame`'s anchors name as an anchor target; see `anchorTarget`. */
  private markAnchorTargets(frame: MutableFrameXmlFrame): void {
    for (const point of frame.points) {
      const target = point.relativeTo;
      if (target instanceof MutableFrameXmlFrame) target.anchorTarget = true;
    }
  }

  /**
   * Announce what `setPaintDeferral` and `setLayoutDeferral` held back, if anything and outside a
   * batch: the world mount's frame step, once per frame.
   */
  flushDeferredPaint(): void {
    if (this.#dispatchDepth !== 0 || this.#mutationDepth !== 0 || !this.#pendingNotification) return;
    this.announce();
  }

  /**
   * Announce held layout now, inside a batch too: something is about to measure the page.
   *
   * A held notification that can move something means the page is not yet what the bridge says, and
   * every read of the page goes through here first — the bridge's own (`sizeOf`, `isMouseOver`) and
   * the host's (`FrameXmlDomRenderer.elementFor`/`measure`). Paint alone is left for the step, as
   * before: it moves nothing a read could see. Inside a renderer's walk it does nothing
   * (`runInRenderPass`).
   *
   * A read of one frame's box (`frame`) settles only when an unannounced change can have moved or
   * resized that box (`layoutReaches`). Stock OnUpdate code measures the same few frames every frame
   * — `FCF_OnUpdate` asks each chat frame `IsMouseOver` and the combat log's button bar `GetHeight`,
   * `CastingBarFrame_OnUpdate` asks the bar `GetWidth` for its spark — and a health text a packet
   * rewrote moves none of them: settling for those reads cost the step a second pass on every frame
   * a world event had changed any layout (measured with the stock vertical: two passes a frame, one
   * of them forced from inside OnUpdate). A read that names no frame settles whatever is held.
   */
  settleDeferredLayout(frame?: FrameXmlFrame): void {
    if (!this.#heldLayout || this.#renderPassDepth !== 0) return;
    if (frame !== undefined && !this.#heldFrameless && !this.layoutReaches(frame)) return;
    this.announce();
  }

  /**
   * Whether a layout change not yet announced can have moved or resized `frame`'s drawn box.
   *
   * The box is placed from the frame itself, its parents (the containing blocks), and whatever any
   * of those is anchored to — a sibling anchor is a measured position, re-placed when its target
   * moves — and from those frames' own placement in turn. A box on that path that its content sizes
   * (`sizedByContent`: a tooltip's grid, a sizeless button around its label) also follows what is
   * inside it; a string sized by its text is its own change. Anything the walk cannot finish within
   * its bound is assumed to reach.
   */
  private layoutReaches(frame: FrameXmlFrame): boolean {
    const changed = this.#heldLayoutFrames;
    if (changed.size === 0) return false;
    const seen = new Set<FrameXmlFrame>();
    const pending: FrameXmlFrame[] = [frame];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      if (seen.size >= LAYOUT_REACH_LIMIT) return true;
      seen.add(current);
      if (changed.has(current)) return true;
      // A box on the path that its content sizes (a tooltip a money frame hangs under, a sizeless
      // button) moves with a change anywhere inside it.
      if (sizedByContent(current) && this.changedInside(current)) return true;
      if (current.parent) pending.push(current.parent);
      for (const point of current.points) if (point.relativeTo) pending.push(point.relativeTo);
    }
    return false;
  }

  /** Whether a held layout change was made to a frame inside `frame`. */
  private changedInside(frame: FrameXmlFrame): boolean {
    for (const moved of this.#heldLayoutFrames) {
      for (let at = moved.parent, depth = 0; at && depth < 64; at = at.parent, depth += 1) {
        if (at === frame) return true;
      }
    }
    return false;
  }

  /** Whether changes are waiting for `flushDeferredPaint`. */
  get paintDeferred(): boolean {
    return this.#pendingNotification && this.#dispatchDepth === 0 && this.#mutationDepth === 0;
  }

  /** Whether a held notification carries layout, i.e. whether a read would settle it. */
  get layoutDeferred(): boolean {
    return this.#heldLayout;
  }

  /** Announce every change not yet announced; nothing is pending or held afterwards. */
  private announce(): void {
    this.#pendingNotification = false;
    this.#pendingLayout = false;
    this.#heldLayout = false;
    this.#heldLayoutFrames.clear();
    this.#heldFrameless = false;
    this.#batchLayoutFrames.clear();
    this.#batchFrameless = false;
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
    if (this.#deferPaint && !this.#pendingLayout) {
      this.holdBatch();
      return;
    }
    this.announce();
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
      if (child.name === "Scripts" || child.name === "Events" || child.name === "Animations") continue;
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
    // Before OnLoad, so a template's own sizing code (`PanelTemplates_TabResize` measuring
    // `CharacterFrameTab1Text`) already measures the label in the font it will be drawn in.
    if (frame.type === "Button" || frame.type === "CheckButton") this.syncButtonLabelFont(frame, false);
    const animations = element.children.filter((child) => child.name === "Animations");
    if (animations.length > 0) this.#runtime?.bindAnimations?.(frame, animations.flatMap((child) => child.children));
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
    // A frame that declares no strata is in its parent's, as `CreateFrame(type, name, parent)` puts
    // it: `GetFrameStrata` answers the parent's, and the renderer draws the child in that strata.
    // Defaulting every child to MEDIUM made 522 widgets of the MPQ vertical look "above" their
    // parent (the dock's tabs under a LOW `GeneralDockManager`, the minimap under a BACKGROUND
    // cluster), which the strata layer of FrameXmlDomRenderer would have lifted out of place.
    frame.frameStrata = frameXmlAttribute(element, "frameStrata")?.trim().toUpperCase()
      ?? frame.parent?.frameStrata ?? "MEDIUM";
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
      frame.editBox.autoFocus = frameXmlBoolean(element, "autoFocus") ?? true;
    }
    if (frame.type === "MessageFrame" || frame.type === "ScrollingMessageFrame") {
      const maxLines = frameXmlNumber(element, "maxLines");
      const displayDuration = frameXmlNumber(element, "displayDuration");
      frame.messageFrame.maxLines = maxLines === undefined ? 128 : Math.max(0, Math.trunc(maxLines));
      // The client's loader (0x00968da0) takes a duration only above 0; otherwise its default stays.
      if (displayDuration !== undefined && displayDuration > 0) frame.messageFrame.displayDuration = displayDuration;
      const fadeDuration = frameXmlNumber(element, "fadeDuration");
      if (fadeDuration !== undefined && fadeDuration > 0) frame.messageFrame.fadeDuration = fadeDuration;
      frame.messageFrame.fading = frameXmlBoolean(element, "fade") ?? true;
      const insertMode = frameXmlAttribute(element, "insertMode");
      if (insertMode !== undefined && insertMode.trim() !== "") {
        frame.messageFrame.insertMode = insertMode.trim().toUpperCase() === "BOTTOM" ? "BOTTOM" : "TOP";
        // L5 3.34: a ScrollingMessageFrame's loader (0x0096ac50) is the other way round: TOP only for "TOP".
        if (frame.type === "ScrollingMessageFrame") {
          frame.messageFrame.insertMode = insertMode.trim().toUpperCase() === "TOP" ? "TOP" : "BOTTOM";
        }
      }
    }
    if (frame.type === "Slider" || frame.type === "StatusBar") {
      const state = frame.type === "Slider" ? frame.slider : frame.statusBar;
      state.orientation = frameXmlAttribute(element, "orientation")?.trim().toUpperCase()
        ?? (frame.type === "StatusBar" ? "HORIZONTAL" : "VERTICAL");
      state.min = frameXmlNumber(element, "minValue") ?? 0;
      state.max = frameXmlNumber(element, "maxValue") ?? 0;
      state.value = frameXmlNumber(element, "defaultValue") ?? state.min;
      state.valueStep = frameXmlNumber(element, "valueStep") ?? 0;
      if (frame.type === "Slider") {
        // L5b-review: the client's loader (0x0096c500) sets a range only from minValue with maxValue,
        // and a value only from defaultValue on top of that range.
        const ranged = frameXmlNumber(element, "minValue") !== undefined && frameXmlNumber(element, "maxValue") !== undefined;
        state.rangeSet = ranged;
        state.valueSet = ranged && frameXmlNumber(element, "defaultValue") !== undefined;
      }
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
    // 3.35-bounds: the page font's line spacing, which also parts its paragraphs (0x0096cc90, +0x2cc).
    const htmlSpacing = frame.type === "SimpleHTML" ? frameXmlNumber(child, "spacing") : undefined;
    if (htmlSpacing !== undefined) frame.setAttribute("spacing", String(htmlSpacing)); // 3.35-bounds
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
            if (built) {
              frame.children.push(built);
              frame.scroll.child = built;
            }
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
        // 3.35-bounds: a SimpleHTML header's own spacing (`<FontStringHeader1 spacing="4">`).
        const headerSpacing = element.name.startsWith("FontStringHeader") ? frameXmlNumber(element, "spacing") : undefined;
        if (headerSpacing !== undefined) frame.setAttribute(`spacing${element.name.slice(-1)}`, String(headerSpacing)); // 3.35-bounds
        return true;
      }
      case "ButtonText": {
        // A Button has one font string. A second `<ButtonText>` — the instance's, after its template's
        // (`TradeFrameTradeButton inherits="UIPanelButtonTemplate"` with `<ButtonText text="TRADE"/>`,
        // TradeFrame.xml:501-519) — describes that same string, so it is merged into it: measured on
        // the MPQ vertical, 2 buttons drew their label twice («Обмен» over «Обмен») before this.
        const existing = this.own(frame.stateTextures.get("BUTTONTEXT"));
        if (existing && existing.parent === frame) {
          this.mergeButtonText(existing, element);
          return true;
        }
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
          // A label that names no font of its own draws in the button's state font. The state fonts
          // may be declared after it (`CharacterFrameTemplates.xml:82-96` puts `<ButtonText>` before
          // `<NormalFont>`), so the font is applied once the whole button is built — see
          // `syncButtonLabelFont`. A label with an `inherits` of its own keeps that font, whatever
          // kind of template it names (`PaperDollFrame.xml:112`'s title: `GameFontHighlightSmallLeft`).
          mutable.inheritsButtonFont = !mutable.fontObject
            && frameXmlAttribute(element, "inherits") === undefined
            && mutable.attributes["font"] === undefined;
          mutable.ownJustifyH = frameXmlAttribute(element, "justifyH") !== undefined;
          mutable.ownJustifyV = frameXmlAttribute(element, "justifyV") !== undefined;
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
        if (frame.type === "Texture") {
          frame.vertexColor = colorOf(element);
          // A Texture's `<Color>` makes the Texture that colour (see `colorFill`).
          frame.colorFill = true;
        } else frame.textColor = colorOf(element);
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
   * A later `<ButtonText>` applied to the button's existing font string: its text, font, alignment,
   * colour, size and anchors, each only where the later declaration says something. Anchors follow
   * `<Anchor>`'s own rule (one per point); the name stays the first declaration's, which is the global
   * stock Lua reaches the label by (`$parentText`).
   */
  private mergeButtonText(label: MutableFrameXmlFrame, element: FrameXmlElement): void {
    const text = frameXmlAttribute(element, "text");
    if (text !== undefined) label.text = this.globalString(text);
    const inherits = frameXmlAttribute(element, "inherits")?.split(",")[0]?.trim();
    const template = inherits ? this.#registry.get(inherits) : undefined;
    if (inherits && (!template || template.element.name === FRAME_XML_FONT_ELEMENT)) {
      label.fontObject = inherits;
      label.inheritsButtonFont = false;
    }
    const justifyH = frameXmlAttribute(element, "justifyH")?.trim().toUpperCase();
    const justifyV = frameXmlAttribute(element, "justifyV")?.trim().toUpperCase();
    if (justifyH) {
      label.justifyH = justifyH;
      label.ownJustifyH = true;
    }
    if (justifyV) {
      label.justifyV = justifyV;
      label.ownJustifyV = true;
    }
    const size = effectiveSizeAttributes(element);
    if (size["width"] !== undefined) label.setAttribute("width", size["width"]);
    if (size["height"] !== undefined) label.setAttribute("height", size["height"]);
    const color = colorOf(frameXmlChild(element, "Color"));
    if (color) label.textColor = color;
    for (const child of element.children) this.collectPointDeclarations(child, label);
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
        const anchor = {
          point,
          ...(relativeTo ? { relativeTo } : {}),
          ...(relativePoint ? { relativePoint } : {}),
          x: dimension.x,
          y: dimension.y,
        };
        if (relativeTo instanceof MutableFrameXmlFrame) relativeTo.anchorTarget = true;
        // An `<Anchor>` is the client's `SetPoint`: one anchor per point name, whatever it is relative
        // to, so the instance's own anchor replaces the template's rather than joining it. The merged
        // element carries the template's `<Anchors>` first. Measured on the MPQ vertical before this:
        // 17 frames held a point twice, among them `ChatFrame1` — FloatingChatFrameTemplate's
        // `BOTTOMLEFT 100,100` plus its own `BOTTOMLEFT 32,95`. `FCF_UpdateDockPosition`'s
        // `SetPoint("BOTTOMLEFT", UIParent, …, 32, 115)` then replaced only the first, the renderer
        // pinned both, and ChatFrame1 was drawn 140 units tall against Lua's 120.
        const name = point.trim().toUpperCase();
        const existing = frame.points.findIndex((candidate) => candidate.point.trim().toUpperCase() === name);
        let pointIndex: number;
        if (existing >= 0) {
          frame.points[existing] = anchor;
          pointIndex = existing;
          // A template anchor still waiting for its target must not overwrite its replacement.
          for (let index = this.#pendingRelativePoints.length - 1; index >= 0; index -= 1) {
            const pending = this.#pendingRelativePoints[index];
            if (pending?.frame === frame && pending.index === existing) this.#pendingRelativePoints.splice(index, 1);
          }
        } else {
          pointIndex = frame.points.push(anchor) - 1;
        }
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
      relativeTo.anchorTarget = true;
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
      // A copy: a child's OnLoad may reparent it (ArenaEnemyPetFrame_OnLoad's
      // `self:SetParent(ArenaEnemyFrames)`, Blizzard_ArenaUI.lua:255), and splicing the live list
      // skipped the next sibling's OnLoad — ArenaEnemyFrameNCastingBar never got its unit.
      for (const child of [...root.children]) this.dispatchOnLoad([child]);
      // XML child widgets are initialized before their owner in the stock client.  Parent OnLoad
      // handlers routinely perform their first update against child state; TargetFrame.lua is a
      // concrete example because TargetFrame_OnLoad immediately updates the health/mana bars,
      // whose TextStatusBar initialization lives in the child OnLoad scripts.
      this.dispatchScript(root, "OnLoad", []);
    }
  }

  /** Whether any frame is registered for the event right now (what `dispatchEvent` would reach). */
  hasEventListeners(event: string): boolean {
    const frames = this.#byEvent.get(event.trim());
    if (!frames) return false;
    for (const frame of frames) if (frame.registeredEvents.has(event.trim())) return true;
    return false;
  }

  dispatchEvent(event: string, ...args: readonly unknown[]): number {
    return this.runInMutationBatch(() => {
      const name = event.trim();
      if (!name) return 0;
      const excluded = takeEventExclusion(name);
      let delivered = 0;
      // P1-14d: one argument list for every frame (dispatchScript only reads it), made on the first.
      let eventArgs: readonly unknown[] | undefined;
      for (const frame of [...(this.#byEvent.get(name) ?? [])]) {
        if (!frame.registeredEvents.has(name) || excluded?.has(frame.name)) continue;
        this.dispatchScript(frame, "OnEvent", eventArgs ??= [name, ...args]);
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
      const excluded = takeEventExclusion(name);
      let delivered = 0;
      for (const frame of [...(this.#byEvent.get(name) ?? [])]) {
        if (!frame.registeredEvents.has(name) || excludedFrameNames.has(frame.name)
          || excluded?.has(frame.name)) continue;
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
      this.#runtime?.tickAnimations?.(elapsedSeconds);
      this.#messageFades.tick(elapsedSeconds, this.#messageFadeHost);
      let dispatched = 0;
      const updateArgs = [elapsedSeconds]; // P1-14d: one list for every frame
      for (const frame of [...this.#updateFrames]) {
        if (!this.#frames.has(frame) || !this.isVisible(frame)) continue;
        this.dispatchScript(frame, "OnUpdate", updateArgs);
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
      // L5 3.27: the hooks this call runs are the ones hooked when it began — a handler that clears its
      // own script still has them called, as Wow.exe's hooking closure (0x00817050) goes on running.
      const hooks = mutable.scriptHooks.get(script);
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
      for (const hook of hooks ?? NO_HOOKS) { // L5 3.27 (was the list at this point); P1-14d: NO_HOOKS
        try {
          hook(mutable, ...args);
        } catch (error) {
          this.diagnostic("script", `${frame.name}.${script} hook failed: ${String(error)}`);
        }
      }
    } finally {
      this.#dispatchDepth -= 1;
      this.flushPendingNotification();
      this.flushReleasedScriptHandlers(); // L5 3.27
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

  CreateFrame(
    type: string, name?: string, parent?: FrameXmlFrame, inherits?: string, id?: number,
  ): FrameXmlFrame | undefined {
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
    // 3.3's fifth argument, the frame's ID, set before the template's OnLoad reads it as the XML
    // `id` attribute would be (FCF_OpenTemporaryWindow's ChatFrame<N>, FloatingChatFrame_OnLoad).
    if (id !== undefined && Number.isFinite(id)) attributes["id"] = String(Math.trunc(id));
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
        if (oldParent.scroll.child === mutable) oldParent.scroll.child = undefined;
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
    this.notifyMutation(this.own(frame), "structure");
    return true;
  }

  /** Adopt a real scroll child without confusing it with the scrollbar in GetChildren(). */
  SetScrollChild(frame: FrameXmlFrame, child?: FrameXmlFrame): boolean {
    const owner = this.own(frame);
    const content = this.own(child);
    if (!owner || owner.type !== "ScrollFrame" || (child !== undefined && !content)) return false;
    if (content && (content.type === "Texture" || content.type === "FontString")) return false;
    return this.runInMutationBatch(() => {
      if (content && !this.SetParent(content, owner)) return false;
      owner.scroll.child = content;
      this.notifyMutation();
      return true;
    });
  }

  /** User input and Lua share the same range clamp and change-only dispatch. */
  SetValue(frame: FrameXmlFrame, value: number, snapToStep = false): boolean {
    const mutable = this.own(frame);
    if (!mutable || !Number.isFinite(value)) return false;
    if (mutable.type !== "Slider" && mutable.type !== "StatusBar") return false;
    const state = mutable.type === "StatusBar" ? mutable.statusBar : mutable.slider;
    const { min, max, valueStep } = state;
    const wanted = snapToStep && valueStep > 0
      ? min + Math.round((value - min) / valueStep) * valueStep : value;
    const clamped = Math.max(min, Math.min(Math.max(min, max), wanted));
    // L5b-review: a slider's value counts as set once SetValue runs with a range (0x0096c090).
    if (mutable.type === "Slider" && state.rangeSet) state.valueSet = true;
    if (clamped === state.value) return false;
    return this.runInMutationBatch(() => {
      state.value = clamped;
      this.notifyMutation(this.own(frame), "paint");
      this.dispatchScript(mutable, "OnValueChanged", [clamped]);
      return true;
    });
  }

  SetScript(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler | null): boolean {
    const mutable = this.own(frame);
    const name = script.trim();
    if (!mutable || !name) return false;
    mutable.scriptOverrides.add(name);
    mutable.compiledScripts.delete(name);
    const previous = mutable.scripts.get(name); // L5 3.27
    if (handler) mutable.scripts.set(name, handler);
    else mutable.scripts.delete(name);
    if (handler) this.holdScriptHandler(handler); // L5 3.27
    if (previous) this.dropScriptHandler(previous); // L5 3.27
    if (name === "OnUpdate") {
      if (handler) this.#updateFrames.add(mutable);
      // L5 3.27: a frame with a hook left (the host's; Lua's go with SetScript) keeps ticking.
      else if (!(mutable.scriptHooks.get(name)?.length)) this.#updateFrames.delete(mutable);
    }
    return true;
  }

  /**
   * L5 3.27: take one hook off a script — the widget layer's SetScript drops the hooks Lua added, as
   * Wow.exe's slot loses the hooking closure (0x0049ec80, 0x0049edb0). A dispatch already walking
   * the hooks still calls it: the list is replaced, not edited.
   */
  unhookScript(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler): boolean {
    const mutable = this.own(frame);
    const name = script.trim();
    const hooks = mutable?.scriptHooks.get(name);
    if (!mutable || !hooks?.includes(handler)) return false;
    const kept = hooks.filter((hook) => hook !== handler);
    if (kept.length > 0) mutable.scriptHooks.set(name, kept);
    else mutable.scriptHooks.delete(name);
    if (name === "OnUpdate" && kept.length === 0 && !mutable.scripts.has(name)) this.#updateFrames.delete(mutable);
    this.dropScriptHandler(handler);
    return true;
  }

  /** L5 3.27: who is told when no script slot or hook list holds a handler any more (the widget layer frees its Lua function). */
  onScriptHandlerReleased(listener: ((handler: FrameXmlScriptHandler) => void) | undefined): void {
    this.#onScriptHandlerReleased = listener;
  }

  /** L5 3.27: how many script slots and hook lists hold each handler. */
  readonly #scriptHandlerHolds = new WeakMap<FrameXmlScriptHandler, number>();
  /** L5 3.27: handlers let go while a script runs; announced when the outermost dispatch ends. */
  #releasedScriptHandlers: FrameXmlScriptHandler[] = [];
  #onScriptHandlerReleased: ((handler: FrameXmlScriptHandler) => void) | undefined;

  private holdScriptHandler(handler: FrameXmlScriptHandler): void {
    this.#scriptHandlerHolds.set(handler, (this.#scriptHandlerHolds.get(handler) ?? 0) + 1);
  }

  private dropScriptHandler(handler: FrameXmlScriptHandler): void {
    const holds = this.#scriptHandlerHolds.get(handler) ?? 0;
    if (holds > 1) {
      this.#scriptHandlerHolds.set(handler, holds - 1);
      return;
    }
    this.#scriptHandlerHolds.delete(handler);
    if (!this.#onScriptHandlerReleased) return;
    this.#releasedScriptHandlers.push(handler);
    this.flushReleasedScriptHandlers();
  }

  /** L5 3.27: outside any dispatch, announce the handlers nothing holds — unless one was set again meanwhile. */
  private flushReleasedScriptHandlers(): void {
    if (this.#dispatchDepth !== 0 || this.#releasedScriptHandlers.length === 0) return;
    const released = this.#releasedScriptHandlers;
    this.#releasedScriptHandlers = [];
    for (const handler of released) {
      if (!this.#scriptHandlerHolds.has(handler)) this.#onScriptHandlerReleased?.(handler);
    }
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
    // L5-review: a new list, not the old one grown — a dispatch walking the old list (its call began
    // before this hook) does not call it, as the client's running closure does not (0x0049edb0).
    const hooks = [...(mutable.scriptHooks.get(name) ?? []), handler];
    mutable.scriptHooks.set(name, hooks);
    this.holdScriptHandler(handler); // L5 3.27
    if (name === "OnUpdate") this.#updateFrames.add(mutable);
    return true;
  }

  /**
   * Dispatch a button activation with only the scalar arguments FrameXML exposes to Lua.
   *
   * A click is three scripts in the client's order — `PreClick`, `OnClick`, `PostClick`, each with
   * `(button, down)` — after a CheckButton has flipped its check. That order is what the stock
   * bodies rely on: SpellButtonTemplate's `<PreClick>self:SetChecked(0)` takes back the flip before
   * `SpellButton_OnClick` casts, and ActionButtonTemplate's `<PostClick>` re-reads
   * `IsCurrentAction` once `SecureActionButton_OnClick` has used the action.
   */
  Click(frame: FrameXmlFrame, button = "LeftButton", down = false): boolean {
    return this.runInMutationBatch(() => {
      const mutable = this.own(frame);
      const name = button.trim();
      if (!mutable || (mutable.type !== "Button" && mutable.type !== "CheckButton") || !name) return false;
      if (!mutable.enabled) return false;
      if (mutable.type === "CheckButton") mutable.checked = !mutable.checked;
      const args = [name, down === true] as const;
      this.dispatchScript(mutable, "PreClick", args);
      this.dispatchScript(mutable, "OnClick", args);
      this.dispatchScript(mutable, "PostClick", args);
      this.notifyMutation(this.own(frame), "paint");
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
      // Showing a shown frame changes nothing the renderer draws; announcing it anyway is what
      // made every idle frame a full re-render (ActionButton_OnUpdate shows its count 5×/s).
      if (mutable.visible) return true;
      mutable.visible = true;
      this.raiseToplevel(mutable);
      const focusRequests = this.#focusRequests;
      this.dispatchShowTree(mutable, "OnShow");
      this.autoFocus(mutable, focusRequests);
      this.notifyMutation(mutable);
      return true;
    });
  }

  /** `EditBox:SetFocus()`: this box holds the keyboard; the renderer moves the caret into it. */
  SetFocus(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    this.#focusRequests += 1;
    mutable.editBox.focused = true;
    this.notifyMutation(mutable);
    return true;
  }

  /** `EditBox:ClearFocus()`: the box lets the keyboard go and hears OnEditFocusLost. */
  ClearFocus(frame: FrameXmlFrame): boolean {
    return this.runInMutationBatch(() => {
      const mutable = this.own(frame);
      if (!mutable) return false;
      this.#focusRequests += 1;
      mutable.editBox.focused = false;
      this.notifyMutation(mutable);
      this.dispatchScript(mutable, "OnEditFocusLost", []);
      return true;
    });
  }

  /**
   * `autoFocus`: an edit box that comes into view takes the keyboard. That is what puts the caret
   * in the eight stock StaticPopups whose OnShow never calls `SetFocus` — measured on the rich route,
   * CHANNEL_INVITE opened with the focus on `StaticPopup1Button1` and the typed «xyz» went nowhere.
   *
   * It runs after the OnShow scripts, and only when none of them placed the focus itself: in the
   * client an OnShow that chooses has the last word. `AccountLogin_OnShow` picks the account or the
   * password box although both are `autoFocus` (GlueXML never says otherwise) and the password box
   * is the later one, and SET_FRIENDNOTE's `wideEditBox:SetFocus()` picks its box the same way.
   * Among several boxes shown at once the last in the tree wins, as the last `SetFocus` would. A
   * frame shown under a hidden parent is not in view, so it waits for the parent's `Show`.
   */
  private autoFocus(root: MutableFrameXmlFrame, focusRequests: number): void {
    if (this.#focusRequests !== focusRequests || !this.isVisible(root)) return;
    let target: MutableFrameXmlFrame | undefined;
    const visit = (frame: MutableFrameXmlFrame): void => {
      if (frame.type === "EditBox" && frame.editBox.autoFocus) target = frame;
      for (const child of frame.children) {
        const mutable = this.own(child);
        if (mutable?.visible) visit(mutable);
      }
    };
    if (root.visible) visit(root);
    if (target) this.SetFocus(target);
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
      if (!mutable.visible) return true;
      mutable.visible = false;
      this.dispatchShowTree(mutable, "OnHide");
      this.notifyMutation(mutable);
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
    if (script === "OnHide") this.#runtime?.hideAnimations?.(frame);
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
    if (anchor.relativeTo instanceof MutableFrameXmlFrame) anchor.relativeTo.anchorTarget = true;
    // A frame holds at most one anchor per point name: `SetPoint("BOTTOM", …)` on a frame whose
    // XML already anchored BOTTOM *moves* it, and only `ClearAllPoints` empties the set. Appending
    // instead is what put the owner's Options button on top of Exit game — measured:
    // `AccountLogin.xml:559` anchors `OptionsButton` BOTTOM to the hidden `…ManageAccountButton`
    // and `XlIlHI.lua:78` re-anchors it BOTTOM to `AccountLoginExitButton`, so the button carried
    // both. One of the two pinned its top edge and the other its bottom, the declared height was
    // dropped as over-constrained, and a 38-unit button laid itself out 126 units tall, reaching
    // down through the button below it.
    const existing = mutable.points.findIndex((candidate) => candidate.point.toUpperCase() === name);
    if (existing >= 0) {
      const current = mutable.points[existing]!;
      if (current.point === anchor.point && current.relativeTo === anchor.relativeTo
        && current.relativePoint === anchor.relativePoint && current.x === anchor.x && current.y === anchor.y) {
        return true;
      }
      mutable.points[existing] = anchor;
    } else mutable.points.push(anchor);
    this.notifyMutation(mutable);
    return true;
  }

  ClearAllPoints(frame: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    if (mutable.points.length === 0) return true;
    mutable.points = [];
    this.notifyMutation(mutable);
    return true;
  }

  SetAllPoints(frame: FrameXmlFrame, relativeTo?: FrameXmlFrame): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    // Same rule as the XML attribute: no target at all means the containing block, which for a
    // frame with no parent is the screen. Refusing there left a Lua-created root unpositioned.
    const target = this.own(relativeTo) ?? mutable.parent;
    if (target instanceof MutableFrameXmlFrame) target.anchorTarget = true;
    const anchor = target ? { relativeTo: target } : {};
    mutable.points = [
      { point: "TOPLEFT", ...anchor, relativePoint: "TOPLEFT", x: 0, y: 0 },
      { point: "BOTTOMRIGHT", ...anchor, relativePoint: "BOTTOMRIGHT", x: 0, y: 0 },
    ];
    mutable.setAllPoints = true;
    this.notifyMutation(mutable);
    return true;
  }

  SetText(frame: FrameXmlFrame, text: string): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    // An EditBox's SetText also moves its caret and resets history, so it always counts.
    if (mutable.type !== "EditBox" && mutable.text === String(text)) {
      const label = this.own(mutable.stateTextures.get("BUTTONTEXT"));
      if (!label || label.text === mutable.text) return true;
    }
    // P1-15a: decided against the text the page still shows, before it is replaced.
    const paints = this.#textLayoutPolicy === "auto" && this.textOnlyPaints(mutable, String(text));
    mutable.text = String(text);
    if (mutable.type === "EditBox") {
      mutable.editBox.cursorPosition = mutable.text.length;
      mutable.editBox.highlightStart = undefined;
      mutable.editBox.highlightEnd = undefined;
      mutable.editBox.selectionRevision++;
      mutable.editBox.historyIndex = -1;
    }
    // A Button owns its label as a separate FontString; SetText on the button
    // has to reach it, or every glue button would render empty.
    const label = mutable.stateTextures.get("BUTTONTEXT");
    const labelFrame = this.own(label);
    if (labelFrame) labelFrame.text = mutable.text;
    this.notifyMutation(mutable, paints ? "paint" : "layout");
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
    mutable.editBox.highlightStart = undefined;
    mutable.editBox.highlightEnd = undefined;
    mutable.editBox.selectionRevision++;
    mutable.editBox.historyIndex = -1;
    this.notifyMutation(mutable);
    return true;
  }

  SetCursorPosition(frame: FrameXmlFrame, position: number): boolean {
    const mutable = this.own(frame);
    if (!mutable || mutable.type !== "EditBox") return false;
    mutable.editBox.cursorPosition = Math.max(0, Math.min(mutable.text.length,
      Number.isFinite(position) ? Math.trunc(position) : mutable.text.length));
    mutable.editBox.highlightStart = undefined;
    mutable.editBox.highlightEnd = undefined;
    mutable.editBox.selectionRevision++;
    this.notifyMutation(mutable);
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
    mutable.editBox.highlightStart = undefined;
    mutable.editBox.highlightEnd = undefined;
    mutable.editBox.selectionRevision++;
    this.notifyMutation(mutable);
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
    addToTop?: unknown,
    accessID?: unknown,
    extraData?: unknown,
  ): boolean {
    if (!this.isMessageFrame(frame)) return false;
    // A MessageFrame's is `AddMessage(text[, r, g, b[, a]])` and draws nothing for an empty string
    // (Wow.exe 0x009747c0); its lines then fade (3.34, FrameXmlMessageFade.ts).
    if (frame.type === "MessageFrame") return this.addFadingMessage(frame, text, r, g, b, lineID);
    const state = frame.messageFrame;
    // 3.3.5 `AddMessage(text, r, g, b, id, addToTop, accessID, typeID)`: the combat log refill walks
    // newest → oldest with addToTop (Blizzard_CombatLog.lua:747), so the window reads oldest first.
    // A full window keeps what it shows: the line that would go above the oldest does not fit.
    const top = addToTop !== undefined && addToTop !== null && addToTop !== false;
    if (top && state.messages.length >= state.maxLines) return true;
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
    frameXmlStampMessage(state, message);
    if (top) state.messages.unshift(message);
    else state.messages.push(message);
    if (state.messages.length > state.maxLines) {
      state.messages.splice(0, state.messages.length - state.maxLines);
    }
    this.#messageFades.track(frame, message);
    state.revision += 1;
    this.refreshMessageScroll(frame, stickToBottom);
    // Paint: the lines live in the frame's private message layer, which neither moves nor resizes
    // the frame (and so nothing measured against it). As a layout change every chat line re-applied
    // the chat frame's whole subtree and its dependents — measured on the rich route, 35 frames,
    // 79 sibling measures and the accessibility walk, 2.1 ms a line on the fast cores. The same
    // holds for every other message-layer change below.
    this.notifyMutation(this.own(frame), "paint");
    return true;
  }

  /**
   * MessageFrame:AddMessage. `messages` stays oldest first whatever the insert mode (the renderer
   * puts the newest at the insert edge), and holds no more lines than the frame's height does: the
   * client lays its lines into `floor(height / line height)` slots (0x00968790) and a new line
   * pushes the last slot's out (0x00968210). The height is the declared one, so adding a line never
   * measures the page; a frame without one keeps `maxLines`.
   */
  private addFadingMessage(
    frame: MutableFrameXmlFrame, text: unknown, r: unknown, g: unknown, b: unknown, alpha: unknown,
  ): boolean {
    const value = text === undefined || text === null ? "" : String(text);
    if (value === "") return true;
    const state = frame.messageFrame;
    const channel = (input: unknown): number => {
      const number = typeof input === "number" ? input : Number(input);
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
    };
    const message: FrameXmlMessage = {
      text: value,
      color: { r: channel(r), g: channel(g), b: channel(b), a: alpha === undefined || alpha === null ? 1 : channel(alpha) },
    };
    frameXmlStampMessage(state, message);
    state.messages.push(message);
    const height = Number(frame.attributes["height"]);
    const insets = frame.textInsets;
    const usable = height - (insets ? insets.top + insets.bottom : 0);
    const style = frame.fontObject ? this.fontObjectStyle(frame.fontObject) : undefined;
    const line = Number(frame.attributes["fontHeight"] ?? style?.height);
    const keep = usable > 0 && line > 0 ? Math.min(state.maxLines, Math.floor(usable / line + 1e-4)) : state.maxLines;
    if (state.messages.length > keep) state.messages.splice(0, state.messages.length - keep);
    this.#messageFades.track(frame, message);
    state.revision += 1;
    this.refreshMessageScroll(frame, true);
    this.notifyMutation(frame, "paint");
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
    this.notifyMutation(this.own(frame), "paint");
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
    // 3.34-review: the client's call (Lua 0x00973270 → 0x0096a510) ends at the newest line with the
    // lines it shows at full alpha and fresh countdowns (0x00969fa0, 0x00969410), whether or not a
    // line went — as a scroll call does.
    if (frame.type === "ScrollingMessageFrame" && state.messages.length > 0) {
      frame.scroll.verticalScroll = frame.scroll.verticalScrollRange;
      frameXmlReviveMessageFades(state, state.messages.length - 1, true); // L5 3.34 (was every line)
      this.#messageFades.track(frame);
      if (state.messages.length === before) {
        this.refreshMessageScroll(frame, true);
        this.notifyMutation(this.own(frame), "paint");
        return true;
      }
    }
    if (state.messages.length === before) return true;
    state.revision += 1;
    this.refreshMessageScroll(frame, frame.scroll.verticalScroll >= frame.scroll.verticalScrollRange);
    this.notifyMutation(this.own(frame), "paint");
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
    // Every scroll call — one that cannot move at a boundary too — shows the lines again with fresh
    // countdowns (Wow.exe 0x00969410; 3.34, FrameXmlMessageFade.ts).
    const revived = frame.type === "ScrollingMessageFrame" && frame.messageFrame.messages.length > 0;
    if (revived) {
      // L5 3.34: at the bottom only the lines that can be in view (the renderer's measure), as the client's slots.
      frameXmlReviveMessageFades(frame.messageFrame, wanted, wanted >= frame.scroll.verticalScrollRange);
      this.#messageFades.track(frame);
    }
    if (wanted === frame.scroll.verticalScroll) {
      if (revived) this.notifyMutation(this.own(frame), "paint");
      return true;
    }
    frame.scroll.verticalScroll = wanted;
    this.notifyMutation(this.own(frame), "paint");
    return true;
  }

  GetVerticalScroll(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.scroll.verticalScroll : 0;
  }

  GetVerticalScrollRange(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.scroll.verticalScrollRange : 0;
  }

  ScrollUp(frame: FrameXmlFrame): boolean {
    // L5 3.34: every line in view is the client's "at top" (0x0096a8a0, +0x2d0): no move, the lines revive.
    if (frame.type === "ScrollingMessageFrame" && frameXmlMessageLayout(frame.messageFrame)?.fits === true) {
      return this.SetVerticalScroll(frame, this.GetVerticalScroll(frame));
    }
    return this.SetVerticalScroll(frame, this.GetVerticalScroll(frame) - 1);
  }

  /**
   * L5 3.34: ScrollingMessageFrame `SetScrollOffset(offset)` (0x00973470 → 0x0096a970): the line
   * `offset` lines before the newest becomes the current one — the bottom line, or with insertMode TOP
   * the top one — taken modulo the line count; `GetCurrentScroll` (0x009690c0) answers that offset and
   * `ScrollToTop` (0x0096a920) makes the oldest line current. Scroll calls, so the lines revive.
   */
  SetMessageScrollOffset(frame: FrameXmlFrame, offset: number): boolean {
    if (frame.type !== "ScrollingMessageFrame" || !Number.isFinite(offset)) return false;
    const count = frame.messageFrame.messages.length;
    if (count === 0) return true;
    // The client truncates the number (0x0088b9c0) and works in its ring of lines.
    let target = (count - Math.trunc(offset) + count - 1) % count;
    if (target < 1) target = 0;
    return this.SetVerticalScroll(frame, Math.min(target, count - 1));
  }

  GetMessageCurrentScroll(frame: FrameXmlFrame): number {
    if (frame.type !== "ScrollingMessageFrame" || frame.messageFrame.messages.length === 0) return 0;
    return frame.scroll.verticalScrollRange - frame.scroll.verticalScroll;
  }

  ScrollToTop(frame: FrameXmlFrame): boolean {
    return this.SetVerticalScroll(frame, 0);
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
    this.notifyMutation(this.own(frame), "paint");
    return true;
  }

  GetMaxLines(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.messageFrame.maxLines : 0;
  }

  SetTimeVisible(frame: FrameXmlFrame, duration: number): boolean {
    if (!this.isMessageFrame(frame)) return false;
    // A shown line starts its "shown" countdown again at the new value (3.34).
    frameXmlRetimeShown(frame.messageFrame, Math.max(0,
      Number.isFinite(duration) ? duration : frame.messageFrame.displayDuration),
    frame.type === "ScrollingMessageFrame"); // L5 3.34: its rule is 0x00969280's
    this.#messageFades.track(frame);
    this.notifyMutation(this.own(frame), "paint");
    return true;
  }

  GetTimeVisible(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.messageFrame.displayDuration : 0;
  }

  /** `SetFadeDuration`: a line with fading left starts that countdown again at the new value (3.34). */
  SetFadeDuration(frame: FrameXmlFrame, duration: number): boolean {
    if (!this.isMessageFrame(frame) || !Number.isFinite(duration)) return false;
    frameXmlRetimeFading(frame.messageFrame, Math.max(0, duration), frame.type === "ScrollingMessageFrame"); // L5 3.34: 0x009692c0's rule
    this.#messageFades.track(frame);
    this.notifyMutation(this.own(frame), "paint");
    return true;
  }

  GetFadeDuration(frame: FrameXmlFrame): number {
    return this.isMessageFrame(frame) ? frame.messageFrame.fadeDuration : 0;
  }

  /** `SetFading`: off, nothing counts and every line keeps the alpha it has (3.34). */
  SetMessageFading(frame: FrameXmlFrame, fading: boolean): boolean {
    if (!this.isMessageFrame(frame)) return false;
    if (frame.messageFrame.fading === fading) return true;
    frame.messageFrame.fading = fading;
    frame.messageFrame.fadeRevision += 1;
    this.#messageFades.track(frame);
    this.notifyMutation(this.own(frame), "paint");
    return true;
  }

  GetMessageFading(frame: FrameXmlFrame): boolean {
    return this.isMessageFrame(frame) && frame.messageFrame.fading;
  }

  /** `SetInsertMode("TOP" | "BOTTOM")`: which edge a MessageFrame puts its newest line at. */
  SetInsertMode(frame: FrameXmlFrame, mode: unknown): boolean {
    const insertMode = frameXmlInsertMode(typeof mode === "string" ? mode : undefined);
    if (!this.isMessageFrame(frame) || insertMode === undefined) return false;
    if (frame.messageFrame.insertMode === insertMode) return true;
    frame.messageFrame.insertMode = insertMode;
    frame.messageFrame.revision += 1;
    this.notifyMutation(this.own(frame), "paint");
    return true;
  }

  GetInsertMode(frame: FrameXmlFrame): string | undefined {
    return this.isMessageFrame(frame) ? frame.messageFrame.insertMode : undefined;
  }

  SetTexture(frame: FrameXmlFrame, texture: unknown): boolean {
    const mutable = this.own(frame);
    if (!mutable || typeof texture !== "string") return false;
    // A file (or nil) replaces a colour texture, so the flat fill goes with it.
    const wasFill = mutable.colorFill;
    mutable.colorFill = false;
    if (mutable.texture === texture && !wasFill) return true;
    mutable.texture = texture;
    this.notifyMutation(mutable);
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
    // The value is stored either way; only a change is news to the renderer (the host still
    // fires OnAttributeChanged on every call, see above).
    const changed = mutable.secureAttributes.get(key) !== value || !mutable.secureAttributes.has(key);
    mutable.secureAttributes.set(key, value);
    if (changed) this.notifyMutation(mutable, "paint");
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
    const nextStart = Number.isFinite(start) ? start : 0;
    const nextDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    if (mutable.cooldown.start === nextStart && mutable.cooldown.duration === nextDuration) return true;
    mutable.cooldown.start = nextStart;
    mutable.cooldown.duration = nextDuration;
    this.notifyMutation(mutable, "paint");
    return true;
  }

  /**
   * Mutate one widget field and raise a single coalesced render notification. `kind` is what the
   * change can affect: "paint" only for fields that never move or resize anything.
   */
  update(frame: FrameXmlFrame, mutate: (frame: MutableFrameXmlFrame) => void,
    kind: FrameXmlMutationKind = "layout"): boolean {
    const mutable = this.own(frame);
    if (!mutable) return false;
    mutate(mutable);
    // The safety net for anchor writers outside the bridge (the renderer's drag placement, the
    // widget layer): a change that can move something may have written anchors.
    if (kind !== "paint") this.markAnchorTargets(mutable);
    this.notifyMutation(mutable, kind);
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
