import { lauxlib, lua, to_luastring, type LuaState } from "fengari";
import { GlueLuaRef, type GlueLuaVm } from "./GlueLua.js";
import { glueCallingAddon } from "./GlueAddonIdentity.js";
import { GLUE_ANIMATION_PRELUDE } from "./GlueAnimations.js";
import { frameXmlAttribute, frameXmlNumber, frameXmlChild } from "../ui/framexml_compat/FrameXmlParser.js";
import type { FrameXmlUiBridge, MutableFrameXmlFrame } from "../ui/framexml_compat/FrameXmlRuntime.js";
import {
  FRAME_XML_TOOLTIP_LAYOUT,
  type FrameXmlColor,
  type FrameXmlFrame,
  type FrameXmlElement,
  type FrameXmlScriptCompileRequest,
  type FrameXmlScriptHandler,
  type FrameXmlTexCoords,
  type LuaAddonRuntime,
  type LuaScriptContext,
} from "../ui/framexml_compat/FrameXmlTypes.js";
import type { TooltipContent, TooltipLine, TooltipTone } from "../ui/Widgets.js";

/**
 * The legacy implicit environment 3.3.5 glue code still relies on.
 *
 * Measured, not assumed. `GlueLocalizationPost.xml` calls `this:HighlightText()`
 * and `this:GetParent()` from three inline handlers, and
 * `TrialConvert_OnKeyDown()` — declared with no parameters at all — reads the
 * free global `arg1` for the key. Both are dead without this wrapper. `event`
 * is also published because 3.3.5 published it, even though every corpus
 * OnEvent body happens to take it as a named parameter instead.
 *
 * Save/restore is what makes nesting safe: an OnClick that calls `Show()` runs
 * an OnShow inside itself, and the outer handler must still see its own `arg1`
 * when the inner one returns. The saved values live in this call's locals, so the
 * Lua stack does the nesting.
 *
 * `rawget` rather than plain reads, and that is most of this wrapper's cost: the
 * eleven names are nil almost always, and a plain read of a nil global runs the
 * `_G` miss metamethod (FrameXML's stub floor, a pattern match and a census write)
 * — eleven times per handler, every OnUpdate of every frame. Measured on the dev
 * page: 0.17 ms per call even for a handler that only checks a timer.
 */
const GLUE_INVOKE = `
local rawget, select, pcall = rawget, select, pcall
local G = _G
function __glueInvoke(fn, self, isEvent, ...)
  local savedThis, savedEvent = rawget(G, "this"), rawget(G, "event")
  local s1, s2, s3 = rawget(G, "arg1"), rawget(G, "arg2"), rawget(G, "arg3")
  local s4, s5, s6 = rawget(G, "arg4"), rawget(G, "arg5"), rawget(G, "arg6")
  local s7, s8, s9 = rawget(G, "arg7"), rawget(G, "arg8"), rawget(G, "arg9")
  this = self
  if isEvent then
    event = ...
    arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 = select(2, ...)
  else
    arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 = ...
  end
  local ok, err = pcall(fn, self, ...)
  this, event = savedThis, savedEvent
  arg1, arg2, arg3 = s1, s2, s3
  arg4, arg5, arg6 = s4, s5, s6
  arg7, arg8, arg9 = s7, s8, s9
  if not ok then geterrorhandler()(err) end
end

-- The same call for a handler that reads none of those globals: nothing is written to _G.
function __glueCall(fn, self, ...)
  local ok, err = pcall(fn, self, ...)
  if not ok then geterrorhandler()(err) end
end
`;

/** A free `this`/`argN` (or `event`, outside an OnEvent body where it is a parameter). */
const LEGACY_GLOBALS = /(?:^|[^.:\w])(?:this|arg[1-9])\b/;
const LEGACY_GLOBALS_WITH_EVENT = /(?:^|[^.:\w])(?:this|arg[1-9]|event)\b/;
/** A function the stock corpus defined: it takes `self` and its arguments, never `this`. */
const STOCK_FUNCTION_SOURCE = /^@?interface\/(?:framexml|glues|addons\/blizzard_)/;

const FRAME_ID_KEY = "__glueFrameId";

type MethodContext = {
  readonly frame: FrameXmlFrame;
  readonly self: MutableFrameXmlFrame;
  readonly args: readonly unknown[];
  readonly binder: GlueWidgetBinder;
};
type WidgetMethod = (context: MethodContext) => readonly unknown[] | void;

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The six methods the 3.3.5 `Minimap` widget reaches for which are not ordinary frame methods.
 *
 * This is deliberately a state boundary rather than a world boundary: the boot can provide the
 * live map implementation, while a glue-only load still has a bounded local zoom state and does
 * not pretend that a ping reached the world. No callback receives a Lua table or a DOM node.
 */
export interface MinimapWidgetAdapter {
  readonly getZoom: () => number;
  readonly getZoomLevels: () => number;
  readonly setZoom: (zoom: number) => void;
  readonly pingLocation: (x: number, y: number) => void;
}

const MINIMAP_NUMERIC_LIMIT = 1_000_000;
const MINIMAP_DEFAULT_ZOOM_LEVELS = 1;

// GameTooltip's XML template supplies lines and backdrop but no Size: the client sizes the box from
// its lines. The C methods keep a bounded estimate for Lua that asks before the next paint (the
// renderer then writes back what it drew); no untrusted payload can grow the root without limit.
const GAME_TOOLTIP_MIN_HEIGHT = 20;
const GAME_TOOLTIP_MAX_WIDTH = 640;
const GAME_TOOLTIP_MAX_LINES = 64;
/**
 * A line box against its font's height. Measured on the dev page in UI units: TextLeft1 (14px
 * header) is 14 tall, a 12px body line 12, two wrapped 12px lines 24, and a title plus two body
 * rows makes a 62-unit box (14 + 12 + 12, two 2-unit row gaps, 10 + 10 inset).
 */
const GAME_TOOLTIP_LINE_BOX = 1;
/** Past this many characters a content line is prose, and the original wraps prose. */
const GAME_TOOLTIP_WRAP_CHARS = 48;

/**
 * Where `SetOwner` puts the tooltip against its owner: [tooltip point, owner point], the 3.3.5
 * anchor table. `ANCHOR_RIGHT` is BOTTOMLEFT on the owner's TOPRIGHT — the tooltip grows up and
 * to the right of it — and every corner anchor puts the opposite corner on it. `ANCHOR_CURSOR`,
 * `ANCHOR_PRESERVE` and `ANCHOR_NONE` place nothing here (see `placeGameTooltip`); a name this
 * table does not know is `ANCHOR_RIGHT`, never «no points».
 *
 * Measured over the stock corpus plus the client add-ons, 43 `SetOwner` sites used an anchor the
 * old four-entry table did not know (TOPRIGHT 27, BOTTOMLEFT 6, BOTTOMRIGHT 5, PRESERVE 3,
 * TOPLEFT 2) and landed at the top-left of the screen — every buff and debuff (`BuffFrame.xml:27`,
 * ANCHOR_BOTTOMLEFT) among them.
 */
const GAME_TOOLTIP_ANCHORS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  ANCHOR_RIGHT: ["BOTTOMLEFT", "TOPRIGHT"],
  ANCHOR_LEFT: ["BOTTOMRIGHT", "TOPLEFT"],
  ANCHOR_TOP: ["BOTTOM", "TOP"],
  ANCHOR_BOTTOM: ["TOP", "BOTTOM"],
  ANCHOR_TOPRIGHT: ["BOTTOMRIGHT", "TOPRIGHT"],
  ANCHOR_TOPLEFT: ["BOTTOMLEFT", "TOPLEFT"],
  ANCHOR_BOTTOMRIGHT: ["TOPLEFT", "BOTTOMRIGHT"],
  ANCHOR_BOTTOMLEFT: ["TOPRIGHT", "BOTTOMLEFT"],
});

const tooltipColor = (r: number, g: number, b: number): FrameXmlColor => ({ r, g, b, a: 1 });
/** FrameXML's font colour constants, the ones the 3.3.5 tooltips paint with. */
const TOOLTIP_WHITE = tooltipColor(1, 1, 1);
const TOOLTIP_NORMAL = tooltipColor(1, 0.82, 0);
const TOOLTIP_GREEN = tooltipColor(0.1, 1, 0.1);
const TOOLTIP_RED = tooltipColor(1, 0.1, 0.1);
const TOOLTIP_GRAY = tooltipColor(0.5, 0.5, 0.5);
/** `ITEM_QUALITY_COLORS` 0..7: an item tooltip's title. */
const TOOLTIP_QUALITY_COLORS: readonly FrameXmlColor[] = [
  tooltipColor(0x9d / 255, 0x9d / 255, 0x9d / 255),
  TOOLTIP_WHITE,
  tooltipColor(0x1e / 255, 1, 0),
  tooltipColor(0, 0x70 / 255, 0xdd / 255),
  tooltipColor(0xa3 / 255, 0x35 / 255, 0xee / 255),
  tooltipColor(1, 0x80 / 255, 0),
  tooltipColor(0xe6 / 255, 0xcc / 255, 0x80 / 255),
  tooltipColor(0xe6 / 255, 0xcc / 255, 0x80 / 255),
];
/**
 * The shared tooltip builders' tones in the original's colours. Those tones were chosen for the
 * native panels and fold several 3.3.5 colours together; this maps each to what most of its lines
 * are in the original: base stats, uniqueness, requirements and prices are white there, «Use:» and
 * «Equip:» green, unmet requirements red, a spell's description and an item's flavour gold.
 */
const TOOLTIP_TONE_COLORS: Readonly<Record<TooltipTone, FrameXmlColor>> = {
  stat: TOOLTIP_WHITE,
  gold: TOOLTIP_WHITE,
  muted: TOOLTIP_WHITE,
  spell: TOOLTIP_GREEN,
  unmet: TOOLTIP_RED,
  flavour: TOOLTIP_NORMAL,
  description: TOOLTIP_NORMAL,
};

/** A colour from Lua's `r, g, b[, a]`, each defaulting to `fallback`'s channel. */
function luaColor(args: readonly unknown[], at: number, fallback: FrameXmlColor, alpha = false): FrameXmlColor {
  return {
    r: num(args[at], fallback.r),
    g: num(args[at + 1], fallback.g),
    b: num(args[at + 2], fallback.b),
    a: alpha ? num(args[at + 3], fallback.a) : fallback.a,
  };
}

/** One content line as FontString text: colour runs become the corpus' own `|cff…|r` escapes. */
function tooltipLineText(line: string | TooltipLine): string {
  if (typeof line === "string" || !line.runs || line.runs.length === 0) return typeof line === "string" ? line : line.text;
  return line.runs.map((run) => {
    const text = run.text.replaceAll("|", "||");
    const hex = run.color && /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(run.color)?.[1];
    return hex ? `|cff${hex}${text}|r` : text;
  }).join("");
}

/**
 * `string.format` for the client's own templates, which use positional arguments: the ruRU
 * `TOOLTIP_UNIT_LEVEL_RACE_CLASS` is "%2$s, |3-6(%3$s) %1$s-го уровня". Lua 5.1's format has no
 * `%n$`; the original formats these in C. Grammar escapes are left for the text parser.
 */
export function formatClientTemplate(template: string, ...values: readonly unknown[]): string {
  let next = 0;
  return template.replace(/%(?:(\d+)\$)?([sd%])/g, (_, position: string | undefined, kind: string) => {
    if (kind === "%") return "%";
    const value = values[position === undefined ? next++ : Number(position) - 1];
    if (value === undefined || value === null) return "";
    return kind === "d" ? String(Math.trunc(num(value))) : String(value);
  });
}

/** A spell tooltip's rank: right of the name in the stock layout, the first line in the native one. */
function spellContentRank(content: TooltipContent): string {
  return content.titleRight ?? (typeof content.lines?.[0] === "string" ? content.lines[0] : "");
}

/** The id a hyperlink names: `item:`, `spell:` or `enchant:`, bare or inside `|H…|h`. */
function tooltipHyperlink(value: unknown): { kind: "item" | "spell"; id: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /(?:^|\|H)(item|spell|enchant):(\d+)/.exec(value);
  if (!match) return undefined;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return { kind: match[1] === "item" ? "item" : "spell", id };
}

interface MinimapWidgetState {
  zoom: number;
  zoomLevels: number;
}

/** State kept by the bounded GameTooltip C-method surface. */
interface GameTooltipWidgetState {
  owner: FrameXmlFrame | undefined;
  anchor: string;
  nextLine: number;
  /** `SetMinimumWidth`, in UI units; 0 when unset. */
  minimumWidth: number;
  /** What the tooltip currently describes, for `GetUnit`/`GetItem`/`GetSpell`. */
  unit: string | undefined;
  item: { name: string; link: string } | undefined;
  /** `id` is the spell's id when the setter knows it; a spellbook slot alone does not name it. */
  spell: { name: string; rank: string; id: number | undefined } | undefined;
  /** `IsEquippedItem`: the item shown came from one of the player's equipment slots. */
  equipped: boolean;
  /**
   * Withdraws the late-answer redraw the drawn content is waiting on (`TooltipContent.refresh`).
   * Cleared lines and a hidden tooltip take it with them, so a redraw never outlives what it
   * would redraw and its closure does not stay in the answer's registry until the answer comes.
   */
  cancelRefresh: (() => void) | undefined;
}

/** Item-specific data supplied by the world owner; the binder keeps the common API surface. */
export interface GameTooltipWidgetAdapter {
  readonly inventoryItem: (unit: string, slot: number) => TooltipContent | undefined;
  readonly containerItem: (bag: number, slot: number) => TooltipContent | undefined;
  /** Bounded action-slot content; the callback receives the stock 1-based slot, never a spell id. */
  readonly action?: (slot: number) => TooltipContent | undefined;
  /**
   * What an action slot holds, so `SetAction` can answer `GetSpell`/`GetItem` and raise
   * `OnTooltipSetSpell`/`OnTooltipSetItem` as the client does. Without it the binder falls back to
   * the Lua `GetActionInfo`, which answers nothing while that API is neutral.
   */
  readonly actionIdentity?: (slot: number) => { readonly kind: string; readonly id: number } | undefined;
  /**
   * The spell in a pet bar slot (1-based), so `SetPetAction` draws the spell's own tooltip and raises
   * `OnTooltipSetSpell`; nothing for a command, a reaction or an empty slot, which keep the name line.
   */
  readonly petActionSpell?: (index: number) => number | undefined;
  /** An item by entry, for `SetHyperlink` and the link-based setters (merchant, loot, quest). */
  readonly item?: (entry: number) => TooltipContent | undefined;
  /** A spell by id, for `SetHyperlink` (and aura tooltips without `aura`); undefined while nothing is known. */
  readonly spell?: (id: number) => TooltipContent | undefined;
  /**
   * A buff or debuff by its spell id: the spell's `AuraDescription` as the 3.3.5 buff bar shows it
   * («Сила атаки увеличена на 15.» where the spellbook says «Воин издает боевой крик.»). The aura
   * setters prefer it and fall back to `spell` when it is absent or answers nothing.
   */
  readonly aura?: (id: number) => TooltipContent | undefined;
}

function boundedMinimapNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MINIMAP_NUMERIC_LIMIT ? parsed : undefined;
}

/** Whether two optional colours paint the same; a setter that repeats one is not a change. */
function sameColor(a: FrameXmlColor | undefined, b: FrameXmlColor | undefined): boolean {
  if (a === b) return true;
  return a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * The 3.3.5 widget hierarchy `IsObjectType` answers by: every kind is also each of its parents, so a
 * CheckButton is a Button (stock `/click` of an action button, ChatFrame.lua:1412), a Frame, a Region
 * and a UIObject. FontString and the text frames are also FontInstances. Names match in any case.
 */
const WIDGET_PARENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Region", ["UIObject"]], ["LayeredRegion", ["Region"]], ["FontInstance", ["UIObject"]],
  ["Frame", ["Region"]], ["Texture", ["LayeredRegion"]], ["FontString", ["LayeredRegion", "FontInstance"]],
  ["Button", ["Frame"]], ["CheckButton", ["Button"]], ["EditBox", ["Frame", "FontInstance"]],
  ["MessageFrame", ["Frame", "FontInstance"]], ["ScrollingMessageFrame", ["Frame", "FontInstance"]],
  ["SimpleHTML", ["Frame", "FontInstance"]], ["Model", ["Frame"]], ["ModelFFX", ["Model"]],
  ["PlayerModel", ["Model"]], ["DressUpModel", ["PlayerModel"]], ["TabardModel", ["PlayerModel"]],
  ["ScrollFrame", ["Frame"]], ["Slider", ["Frame"]], ["StatusBar", ["Frame"]], ["Cooldown", ["Frame"]],
  ["ColorSelect", ["Frame"]], ["GameTooltip", ["Frame"]], ["Minimap", ["Frame"]], ["MovieFrame", ["Frame"]],
  ["QuestPOIFrame", ["Frame"]], ["WorldFrame", ["Frame"]],
]);

/** Each kind with every kind it inherits from, in lower case, built on first use. */
const WIDGET_KINDS = new Map<string, ReadonlySet<string>>();

function widgetKinds(type: string): ReadonlySet<string> {
  let kinds = WIDGET_KINDS.get(type);
  if (kinds === undefined) {
    const collected = new Set([type.toLowerCase()]);
    for (const parent of WIDGET_PARENTS.get(type) ?? []) for (const kind of widgetKinds(parent)) collected.add(kind);
    kinds = collected;
    WIDGET_KINDS.set(type, kinds);
  }
  return kinds;
}

/**
 * `IsObjectType(wanted)`: the kind or one it inherits from, compared without regard to case as the
 * client compares it — stock UIParent.lua:1301 asks `frame:IsObjectType("frame")`.
 */
function widgetIsA(type: string, wanted: string): boolean {
  return widgetKinds(type).has(wanted.toLowerCase());
}

/** A flag argument as Lua reads it: nil and false are off, and so is `0`, which 3.3.5's setters take. */
function luaTruthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

/**
 * Resolve the path overload of a texture setter without coercing Lua tables/handles.
 *
 * Lua tables arrive here as `GlueLuaRef` instances. Stringifying one produces the browser-looking
 * value `[object Object]`, which the texture renderer then turns into `[object Object].blp` and
 * sends to the gateway. `nil` remains the client's clear-texture operation; every other non-string
 * value is unsupported and is deliberately ignored.
 */
function textureReference(value: unknown): string | undefined {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : undefined;
}

/** Accept the object overload only for a Texture owned by this bridge. */
function textureHandle(value: unknown, bridge: FrameXmlUiBridge): FrameXmlFrame | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const frame = bridge.resolve(value as FrameXmlFrame);
  return frame?.type === "Texture" ? frame : undefined;
}

/**
 * Remember one 3D call, keeping the recorded list bounded.
 *
 * The list is a diagnostic, not a queue: nothing replays it. `AdvanceTime` and the light-stack
 * calls come out of OnUpdate bodies, so an unbounded list is one array entry per widget per frame
 * for as long as a glue screen is up.
 */
const MODEL_CALL_LOG_LIMIT = 64;
function pushModelCall(frame: MutableFrameXmlFrame, method: string, args: readonly unknown[]): void {
  const calls = frame.model.calls;
  calls.push({ method, args: [...args] });
  if (calls.length > MODEL_CALL_LOG_LIMIT) calls.splice(0, calls.length - MODEL_CALL_LOG_LIMIT);
}

/**
 * `SetTexCoord`'s two forms. Four numbers are (left, right, top, bottom); eight are the texture
 * coordinates of the four corners, (ULx, ULy, LLx, LLy, URx, URy, LRx, LRy), which is how
 * TaxiFrame's `DrawRouteLine` (TaxiFrame.lua:252) turns `UI-Taxi-Line` along a flight path and how
 * PaperDollFrame.lua:1158 points the flyout arrow sideways. Read as the four-number form, the
 * route line was a crop of nothing. Corners that still make an axis-aligned rectangle are the
 * four-number form (a mirror included) and are stored as one, so they keep the crop path.
 */
function texCoordArgs(args: readonly unknown[]): FrameXmlTexCoords {
  if (args.length >= 8 && args.slice(0, 8).every((value) => value !== undefined && value !== null
    && Number.isFinite(typeof value === "number" ? value : Number(value)))) {
    const corners = args.slice(0, 8).map((value) => num(value)) as unknown as
      readonly [number, number, number, number, number, number, number, number];
    const [ulx, uly, llx, lly, urx, ury, lrx, lry] = corners;
    const rectangle = ulx === llx && urx === lrx && uly === ury && lly === lry;
    return { left: ulx, right: urx, top: uly, bottom: lly, ...(rectangle ? {} : { corners }) };
  }
  return { left: num(args[0]), right: num(args[1], 1), top: num(args[2]), bottom: num(args[3], 1) };
}

function sameCorners(a: FrameXmlTexCoords["corners"], b: FrameXmlTexCoords["corners"]): boolean {
  if (a === b) return true;
  return a !== undefined && b !== undefined && a.every((value, index) => value === b[index]);
}

function colorArgs(args: readonly unknown[], from = 0): FrameXmlColor {
  return {
    r: num(args[from], 1), g: num(args[from + 1], 1), b: num(args[from + 2], 1),
    a: args[from + 3] === undefined ? 1 : num(args[from + 3], 1),
  };
}

export interface GlueWidgetStubDiagnostic {
  readonly module: string;
  readonly widgetType: string;
  readonly method: string;
  readonly calls: number;
}

export interface GlueWidgetBinderOptions {
  /** Host attribution, called while the Lua creation stack is still available. */
  readonly onBindFrame?: (frame: FrameXmlFrame) => void;
  /** Called once per widget method the corpus reaches that is only recorded. */
  readonly onStub?: (method: string) => void;
  /** Optional live owner for the measured special methods on a 3.3.5 `Minimap`. */
  readonly minimapAdapter?: MinimapWidgetAdapter;
  /** Optional item owner for GameTooltip's equipment and container methods. */
  readonly gameTooltipAdapter?: GameTooltipWidgetAdapter;
  /**
   * When handlers get the legacy `this`/`event`/`arg1..9` globals. "always" (the default) is
   * what the glue screens need: `TrialConvert_OnKeyDown()` reads `arg1` from inside the function
   * its body calls. "referenced" gives them only to a handler whose own source names one, to a
   * function defined outside the stock corpus, and to an add-on's frame — the in-world corpus
   * reads none of them elsewhere (measured: `this` in LocalizationPost.xml's inline bodies,
   * `arg1..9` nowhere) and writing eleven globals per handler was most of its cost.
   */
  readonly implicitGlobals?: "always" | "referenced";
}

/**
 * Exposes the bridge's widgets to Lua as real tables, and the bridge's script
 * dispatch to the VM.
 *
 * A widget is a plain Lua table whose metatable's `__index` is the method table
 * for its widget type — not a userdata proxy. That is the faithful shape: the
 * corpus assigns its own fields and even its own methods onto frames
 * (`self.SetOwner = function(...)` in GlueTooltip, `control.SetDisplayValue`
 * in OptionsPanelTemplates), and it *tests* for methods by truthiness
 * (`elseif ( checkButton.GetValue )`). A per-type method table is what makes
 * that test answer the way the real client answers; a universal fallback that
 * manufactured a method for every name would silently take the wrong branch.
 */
export class GlueWidgetBinder implements LuaAddonRuntime {
  readonly name = "glue-fengari";
  readonly #vm: GlueLuaVm;
  readonly #bridge: FrameXmlUiBridge;
  readonly #options: GlueWidgetBinderOptions;
  readonly #refs = new Map<FrameXmlFrame, GlueLuaRef>();
  readonly #byId = new Map<number, FrameXmlFrame>();
  readonly #metatables = new Map<string, GlueLuaRef>();
  readonly #handlerSources = new WeakMap<object, GlueLuaRef>();
  readonly #minimapState = new WeakMap<FrameXmlFrame, MinimapWidgetState>();
  readonly #gameTooltipState = new WeakMap<FrameXmlFrame, GameTooltipWidgetState>();
  /** The tooltip a failed setter is hiding right now; its OnHide keeps the owner (`hideGameTooltip`). */
  #tooltipKeepingOwner: FrameXmlFrame | undefined;
  readonly #stubbed = new Set<string>();
  readonly #stubCounts = new Map<string, GlueWidgetStubDiagnostic>();
  readonly #frameModules = new WeakMap<FrameXmlFrame, string>();
  #invoke: GlueLuaRef | undefined;
  #call: GlueLuaRef | undefined;
  #nextId = 0;
  #animationsActive = false;
  readonly #animationFunctions = new Map<string, GlueLuaRef>();

  constructor(vm: GlueLuaVm, bridge: FrameXmlUiBridge, options: GlueWidgetBinderOptions = {}) {
    this.#vm = vm;
    this.#bridge = bridge;
    this.#options = options;
    const installed = vm.execute(GLUE_INVOKE, "@GlueWidgets:invoke");
    if (!installed.ok) throw new Error(`glue dispatch helper failed to load: ${installed.error}`);
    this.#invoke = vm.globalFunction("__glueInvoke");
    this.#call = vm.globalFunction("__glueCall");
    vm.registerGlobal("__glueAnimationActive", (args) => { this.#animationsActive = args[0] === true; return []; });
    vm.registerGlobal("__glueSetAnimationAlpha", (args) => {
      const frame = bridge.resolve(args[0] as FrameXmlFrame | undefined);
      const alpha = typeof args[1] === "number" && Number.isFinite(args[1]) ? args[1] : undefined;
      if (frame && frame.animationAlpha !== alpha) bridge.update(frame, (mutable) => { mutable.animationAlpha = alpha; }, "paint");
      return [];
    });
    vm.registerGlobal("__glueSetAnimationTransform", (args) => {
      const frame = bridge.resolve(args[0] as FrameXmlFrame | undefined);
      const transform = typeof args[1] === "string" && args[1].length > 0 ? args[1] : undefined;
      if (frame && frame.animationTransform !== transform) {
        bridge.update(frame, (mutable) => { mutable.animationTransform = transform; }, "paint");
      }
      return [];
    });
    /**
     * `SetPortraitToTexture(texture, path)`: the picture drawn into a round portrait. The first
     * argument is a Texture or its global name — `MailFrame.lua:227` passes the string
     * `"OpenMailFrameIcon"` with the letter's stationery icon. The client renders the file cropped
     * to a circle under the ring art; the renderer draws the same crop (`FrameXmlFrame.portrait`).
     * Before this it was the stub plan's no-op and the ring kept its XML default icon.
     */
    vm.registerGlobal("SetPortraitToTexture", (args) => {
      const target = typeof args[0] === "string" ? bridge.getFrame(args[0]) : bridge.resolve(args[0] as FrameXmlFrame | undefined);
      const texture = textureReference(args[1]);
      if (!target || target.type !== "Texture" || texture === undefined) return [];
      bridge.SetTexture(target, texture);
      if (!target.portrait) bridge.update(target, (mutable) => { mutable.portrait = true; }, "paint");
      return [];
    });
    const animationPrelude = vm.execute(GLUE_ANIMATION_PRELUDE, "@GlueAnimations");
    if (!animationPrelude.ok) throw new Error(`animation runtime failed to load: ${animationPrelude.error}`);
    for (const name of ["__glueAttachAnimations", "__glueBindAnimations", "__glueTickAnimations", "__glueHideAnimations", "__glueReleaseAnimations"]) {
      const fn = vm.globalFunction(name);
      if (fn) this.#animationFunctions.set(name, fn);
    }
    vm.setTableDecoder((L, index) => this.decodeFrame(L, index));
    vm.setValueEncoder((L, value) => this.encodeFrame(L, value));
    this.buildMetatables();
  }

  get luaVersion(): string {
    return this.#vm.luaVersion;
  }

  /** Widget methods the corpus called that are recorded no-ops, in call order. */
  get stubbedMethods(): readonly string[] {
    return [...this.#stubbed];
  }

  get stubDiagnostics(): readonly GlueWidgetStubDiagnostic[] {
    return [...this.#stubCounts.values()].map((record) => ({ ...record }));
  }

  /** The `LuaAddonRuntime.execute` fallback is unused: every body is compiled. */
  execute(source: string, context: LuaScriptContext): void {
    this.#vm.executeReported(source, `@${context.frame.name}:inline`);
  }

  compileScript(request: FrameXmlScriptCompileRequest): FrameXmlScriptHandler | undefined {
    const ref = this.#vm.compileFunction(request.source, request.chunkName, request.parameters);
    if (!ref) return undefined;
    const pattern = request.parameters.includes("event") ? LEGACY_GLOBALS : LEGACY_GLOBALS_WITH_EVENT;
    return this.wrapHandler(ref, request.script === "OnEvent", this.needsLegacyGlobals(ref, pattern.test(request.source)));
  }

  resolveGlobalHandler(name: string): FrameXmlScriptHandler | undefined {
    const ref = this.#vm.globalFunction(name);
    if (!ref) return undefined;
    return this.wrapHandler(ref, false, this.needsLegacyGlobals(ref));
  }

  /** See `GlueWidgetBinderOptions.implicitGlobals`. */
  private needsLegacyGlobals(ref: GlueLuaRef, referencedInBody = false): boolean {
    if (this.#options.implicitGlobals !== "referenced" || referencedInBody) return true;
    const defined = this.#vm.functionSource(ref)?.replaceAll("\\", "/").toLowerCase() ?? "";
    // An inline XML body is compiled under its frame's name, and its own text was just checked.
    if (!defined.includes("/")) return false;
    return defined.includes("/tsaddons/") || !STOCK_FUNCTION_SOURCE.test(defined);
  }

  bindFrame(frame: FrameXmlFrame): void {
    if (this.#refs.has(frame)) return;
    const module = glueCallingAddon(this.#vm.callingSources())
      ?? (frame.parent ? this.#frameModules.get(frame.parent) : undefined);
    if (module) this.#frameModules.set(frame, module);
    this.#options.onBindFrame?.(frame);
    const L = this.#vm.state;
    const top = lua.lua_gettop(L);
    const id = ++this.#nextId;
    lua.lua_createtable(L, 0, 2);
    lua.lua_pushinteger(L, id);
    lua.lua_setfield(L, -2, to_luastring(FRAME_ID_KEY));
    const metatable = this.#metatables.get(frame.type) ?? this.#metatables.get("Frame");
    if (metatable) {
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, metatable.key);
      lua.lua_setmetatable(L, -2);
    }
    // A named widget is a global in the real client; `getglobal("AccountLogin"
    // .. "Bg")` and the corpus' `_G[...]` lookups both depend on it.
    if (frame.named) {
      lua.lua_pushvalue(L, -1);
      lua.lua_setglobal(L, to_luastring(frame.name));
    }
    const ref = new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), "table");
    lua.lua_settop(L, top);
    this.#refs.set(frame, ref);
    this.#byId.set(id, frame);
    const attachAnimations = this.#animationFunctions.get("__glueAttachAnimations");
    if (attachAnimations) this.#vm.call(attachAnimations, [frame]);
    // `parentKey="Border"` publishes the child on its parent as `parent.Border`.
    if (frame.parentKey && frame.parent) this.setParentKey(frame.parent, frame.parentKey, frame);
  }

  releaseFrame(frame: FrameXmlFrame): void {
    const ref = this.#refs.get(frame);
    if (!ref) return;
    const release = this.#animationFunctions.get("__glueReleaseAnimations");
    if (release) this.#vm.call(release, [frame]);
    this.#vm.release(ref);
    this.#refs.delete(frame);
  }

  bindAnimations(frame: FrameXmlFrame, elements: readonly FrameXmlElement[]): void {
    const bind = this.#animationFunctions.get("__glueBindAnimations");
    if (!bind) return;
    let ancestor: FrameXmlFrame | undefined = frame;
    while (ancestor && !ancestor.named) ancestor = ancestor.parent;
    const ownerName = ancestor?.name ?? "";
    const nameOf = (element: FrameXmlElement, parentName: string): string | undefined =>
      frameXmlAttribute(element, "name")?.replaceAll("$parent", parentName);
    const scriptsOf = (element: FrameXmlElement): Record<string, { source?: string; func?: string }> => {
      const scripts: Record<string, { source?: string; func?: string }> = {};
      for (const script of frameXmlChild(element, "Scripts")?.children ?? []) {
        const func = frameXmlAttribute(script, "function");
        scripts[script.name] = func ? { func } : { source: script.text };
      }
      return scripts;
    };
    const originOf = (element: FrameXmlElement): { point: string; x: number; y: number } => {
      const origin = frameXmlChild(element, "Origin");
      const offset = origin && frameXmlChild(origin, "Offset");
      const dimension = offset && frameXmlChild(offset, "AbsDimension");
      const values = dimension ?? offset ?? origin ?? element;
      return {
        point: frameXmlAttribute(origin ?? element, "point")?.toUpperCase() ?? "CENTER",
        x: frameXmlNumber(values, "x") ?? 0,
        y: frameXmlNumber(values, "y") ?? 0,
      };
    };
    const definitions = [];
    for (const element of elements) {
      if (element.name !== "AnimationGroup") continue;
      const name = nameOf(element, ownerName);
      const children = element.children.filter((child) => child.name !== "Scripts");
      const unsupported = children.filter((child) => !["Alpha", "Animation", "Translation", "Rotation", "Scale"].includes(child.name));
      if (unsupported.length > 0) {
        for (const child of unsupported) this.recordStubCall(`Animation:${child.name}`, frame.type, frame);
        continue;
      }
      definitions.push({
        name, parentKey: frameXmlAttribute(element, "parentKey"),
        looping: frameXmlAttribute(element, "looping")?.toUpperCase() ?? "NONE", scripts: scriptsOf(element),
        animations: children.map((child) => {
          const origin = originOf(child);
          return {
          // UI.xsd: Translation has offsets; Rotation/Scale may carry an Origin/Offset child.
          kind: child.name, name: nameOf(child, name ?? ownerName), parentKey: frameXmlAttribute(child, "parentKey"),
          duration: frameXmlNumber(child, "duration") ?? 0, startDelay: frameXmlNumber(child, "startDelay") ?? 0,
          endDelay: frameXmlNumber(child, "endDelay") ?? 0, order: frameXmlNumber(child, "order") ?? 1,
          change: frameXmlNumber(child, "change") ?? 0, smoothing: frameXmlAttribute(child, "smoothing")?.toUpperCase() ?? "NONE",
          offsetX: frameXmlNumber(child, "offsetX") ?? 0, offsetY: frameXmlNumber(child, "offsetY") ?? 0,
          radians: frameXmlNumber(child, "radians") ?? (frameXmlNumber(child, "degrees") ?? 0) * Math.PI / 180,
          scaleX: frameXmlNumber(child, "scaleX") ?? 1, scaleY: frameXmlNumber(child, "scaleY") ?? 1,
          originPoint: origin.point, originX: origin.x, originY: origin.y,
          scripts: scriptsOf(child),
          };
        }),
      });
    }
    if (definitions.length > 0) this.#vm.call(bind, [frame, definitions]);
  }

  tickAnimations(elapsedSeconds: number): void {
    if (!this.#animationsActive || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;
    const tick = this.#animationFunctions.get("__glueTickAnimations");
    if (tick) this.#vm.call(tick, [elapsedSeconds]);
  }

  hideAnimations(frame: FrameXmlFrame): void {
    // A hidden tooltip has no owner — whether it hid itself or an ancestor hid it. This is the one
    // OnHide hook every host forwards to the binder (see `LuaAddonRuntime.hideAnimations`). A
    // setter that found nothing hides the tooltip too, but it keeps its owner (`hideGameTooltip`).
    if (frame.type === "GameTooltip") {
      if (frame !== this.#tooltipKeepingOwner) this.releaseGameTooltipOwner(frame);
      // A late answer for rows nobody sees any more is not drawn: the redraw goes with the tooltip.
      this.cancelGameTooltipRefresh(frame);
    }
    const hide = this.#animationFunctions.get("__glueHideAnimations");
    if (hide) this.#vm.call(hide, [frame]);
  }

  /** The Lua table for a widget, or undefined when it was never bound. */
  tableOf(frame: FrameXmlFrame): GlueLuaRef | undefined {
    return this.#refs.get(frame);
  }

  private setParentKey(parent: FrameXmlFrame, key: string, child: FrameXmlFrame): void {
    const parentRef = this.#refs.get(parent);
    const childRef = this.#refs.get(child);
    if (!parentRef || !childRef) return;
    const L = this.#vm.state;
    const top = lua.lua_gettop(L);
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, parentRef.key);
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, childRef.key);
    lua.lua_setfield(L, -2, to_luastring(key));
    lua.lua_settop(L, top);
  }

  private decodeFrame(L: LuaState, index: number): FrameXmlFrame | undefined {
    if (lua.lua_type(L, index) !== lua.LUA_TTABLE) return undefined;
    const absolute = lua.lua_absindex(L, index);
    lua.lua_pushstring(L, to_luastring(FRAME_ID_KEY));
    // Raw, so a corpus table that merely has an `__index` metamethod is never
    // asked a question that could run Lua while a binding is marshalling.
    const type = lua.lua_rawget(L, absolute);
    const id = type === lua.LUA_TNUMBER ? lua.lua_tointeger(L, -1) : 0;
    lua.lua_pop(L, 1);
    return id ? this.#byId.get(id) : undefined;
  }

  private encodeFrame(L: LuaState, value: object): boolean {
    const ref = this.#refs.get(value as FrameXmlFrame);
    if (!ref) return false;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
    return true;
  }

  /** Turn a retained Lua function into a bridge handler with the implicit env. */
  private wrapHandler(ref: GlueLuaRef, isEvent: boolean, legacy = true): FrameXmlScriptHandler {
    const handler: FrameXmlScriptHandler = (self, ...args) => {
      const module = this.#frameModules.get(self);
      // An add-on's frame keeps the legacy globals whatever its handler looks like.
      const direct = legacy || module !== undefined ? undefined : this.#call;
      const invokeRef = this.#invoke;
      if (!invokeRef) return;
      const invoke = direct
        ? (): void => { this.#vm.call(direct, [ref, self, ...args], 0); }
        : (): void => { this.#vm.call(invokeRef, [ref, self, isEvent, ...args], 0); };
      if (module) this.#vm.withCallingSource(`interface/addons/${module}/handler`, invoke);
      else invoke();
    };
    this.#handlerSources.set(handler, ref);
    return handler;
  }

  private stub(method: string): WidgetMethod {
    return ({ frame }) => {
      this.recordStubCall(method, frame.type, frame);
      if (!this.#stubbed.has(method)) {
        this.#stubbed.add(method);
        this.#options.onStub?.(method);
      }
    };
  }

  /** Shared by the known no-op surface and FrameXML's measured unknown-method fallback. */
  recordStubCall(method: string, widgetType: string, frame?: FrameXmlFrame): void {
    const sources = this.#vm.callingSources();
    const module = glueCallingAddon(sources) ?? (frame ? this.#frameModules.get(frame) : undefined)
      ?? (sources.some((source) => /gluexml/i.test(source)) ? "blizzard_gluexml" : "blizzard_framexml");
    const key = `${module}:${widgetType}:${method}`;
    const prior = this.#stubCounts.get(key);
    this.#stubCounts.set(key, { module, widgetType, method, calls: Math.min(Number.MAX_SAFE_INTEGER, (prior?.calls ?? 0) + 1) });
  }

  /**
   * Build one metatable per widget type.
   *
   * The union below is the measured method census of the corpus (every
   * `:Method(` spelling across the 70 files) placed on the widget class that
   * owns it in 3.3.5, plus the handful the slice brief names. Anything that
   * cannot be honest yet is a recorded no-op rather than a missing key, so the
   * existence tests the corpus performs keep answering the way they do in the
   * real client.
   */
  private buildMetatables(): void {
    const base = this.baseMethods();
    const region = { ...base, ...this.regionMethods() };
    const frameLike = { ...base, ...this.frameMethods() };
    const fontString = { ...region, ...this.textMethods() };
    const button = { ...frameLike, ...this.textMethods(), ...this.buttonMethods() };
    const checkButton = { ...button, ...this.checkButtonMethods() };
    const editBox = { ...frameLike, ...this.textMethods(), ...this.editBoxMethods() };
    const slider = { ...frameLike, ...this.valueMethods(), ...this.sliderMethods() };
    const statusBar = { ...frameLike, ...this.valueMethods(), ...this.statusBarMethods() };
    const scrollFrame = { ...frameLike, ...this.scrollMethods() };
    const messageFrame = { ...frameLike, ...this.textMethods(), ...this.messageMethods() };
    const model = { ...frameLike, ...this.modelMethods() };
    const minimap = { ...frameLike, ...this.minimapMethods() };
    const simpleHtml = { ...frameLike, ...this.textMethods(), ...this.simpleHtmlMethods() };
    const movie = { ...frameLike, ...this.movieMethods() };
    const gameTooltip = { ...frameLike, ...this.textMethods(), ...this.gameTooltipMethods() };

    const byType: Readonly<Record<string, Record<string, WidgetMethod>>> = {
      Frame: frameLike,
      Texture: region,
      FontString: fontString,
      Button: button,
      CheckButton: checkButton,
      EditBox: editBox,
      Slider: slider,
      StatusBar: statusBar,
      ScrollFrame: scrollFrame,
      Model: model,
      ModelFFX: model,
      PlayerModel: model,
      DressUpModel: model,
      TabardModel: model,
      Minimap: minimap,
      SimpleHTML: simpleHtml,
      MovieFrame: movie,
      Cooldown: frameLike,
      MessageFrame: messageFrame,
      ScrollingMessageFrame: messageFrame,
      GameTooltip: gameTooltip,
    };
    for (const [type, methods] of Object.entries(byType)) {
      this.#metatables.set(type, this.createMetatable(type, methods));
    }
  }

  private createMetatable(type: string, methods: Record<string, WidgetMethod>): GlueLuaRef {
    const L = this.#vm.state;
    const top = lua.lua_gettop(L);
    const names = Object.keys(methods);
    lua.lua_createtable(L, 0, names.length);
    for (const name of names) {
      const method = methods[name]!;
      this.#vm.pushBinding(`${type}:${name}`, (args) => {
        const frame = args[0];
        const self = this.#bridge.resolve(frame as FrameXmlFrame | undefined);
        if (!self) return [];
        const result = method({
          frame: frame as FrameXmlFrame, self, args: args.slice(1), binder: this,
        });
        return result ?? [];
      });
      lua.lua_setfield(L, -2, to_luastring(name));
    }
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushvalue(L, -2);
    lua.lua_setfield(L, -2, to_luastring("__index"));
    const ref = new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), "table");
    lua.lua_settop(L, top);
    return ref;
  }

  private minimapState(frame: FrameXmlFrame): MinimapWidgetState {
    let state = this.#minimapState.get(frame);
    if (!state) {
      state = { zoom: 0, zoomLevels: MINIMAP_DEFAULT_ZOOM_LEVELS };
      this.#minimapState.set(frame, state);
    }
    return state;
  }

  private minimapZoomLevels(frame: FrameXmlFrame): number {
    const state = this.minimapState(frame);
    const supplied = this.#options.minimapAdapter?.getZoomLevels();
    const value = boundedMinimapNumber(supplied);
    if (value !== undefined && value >= 1) {
      state.zoomLevels = Math.max(1, Math.trunc(value));
      state.zoom = Math.min(state.zoom, state.zoomLevels - 1);
    }
    return state.zoomLevels;
  }

  private minimapZoom(frame: FrameXmlFrame): number {
    const state = this.minimapState(frame);
    const supplied = this.#options.minimapAdapter?.getZoom();
    const value = boundedMinimapNumber(supplied);
    if (value !== undefined) {
      const levels = this.minimapZoomLevels(frame);
      const integer = Math.trunc(value);
      state.zoom = Math.min(levels - 1, Math.max(0, integer));
    }
    return state.zoom;
  }

  private minimapMethods(): Record<string, WidgetMethod> {
    return {
      GetZoom: ({ frame }) => [this.minimapZoom(frame)],
      GetZoomLevels: ({ frame }) => [this.minimapZoomLevels(frame)],
      SetZoom: ({ frame, args }) => {
        const supplied = boundedMinimapNumber(args[0]);
        if (supplied === undefined) return;
        const levels = this.minimapZoomLevels(frame);
        const wanted = Math.min(levels - 1, Math.max(0, Math.trunc(supplied)));
        if (wanted === this.minimapZoom(frame)) return;
        this.#options.minimapAdapter?.setZoom(wanted);
        this.minimapState(frame).zoom = wanted;
      },
      PingLocation: ({ args }) => {
        const x = boundedMinimapNumber(args[0]);
        const y = boundedMinimapNumber(args[1]);
        if (x === undefined || y === undefined) return;
        // A glue-only load has no world to ping. Deliberately do not enqueue or synthesize one.
        this.#options.minimapAdapter?.pingLocation(x, y);
      },
      // The stock methods only size the authored player-arrow texture. This renderer has no such
      // region state, so they are an explicit no-op rather than a fabricated map mutation.
      SetPlayerTextureWidth: () => {},
      SetPlayerTextureHeight: () => {},
    };
  }

  private gameTooltipState(frame: FrameXmlFrame): GameTooltipWidgetState {
    let state = this.#gameTooltipState.get(frame);
    if (!state) {
      state = {
        owner: undefined, anchor: "ANCHOR_RIGHT", nextLine: 1, minimumWidth: 0,
        unit: undefined, item: undefined, spell: undefined, equipped: false, cancelRefresh: undefined,
      };
      this.#gameTooltipState.set(frame, state);
    }
    return state;
  }

  /**
   * What hiding a tooltip takes away: its owner, its anchor type and its cursor tracking.
   *
   * Stock code tests ownership to decide whether to *redraw* a tooltip: `AuraButton_OnUpdate`
   * (`BuffFrame.lua:216-217, 247-248`) refreshes while `GameTooltip:IsOwned(self)`, and
   * `ActionButton.lua:265-266, 354-355` while `GetOwner() == self`. With the owner kept past the
   * OnLeave `Hide()`, each of those put the tooltip straight back — measured on the dev page, five
   * `Show GameTooltip` within 0.9 s after `Leave BuffButton1` — and `GameTooltip_OnUpdate` kept
   * asking the stale owner to `UpdateTooltip` forever.
   */
  private releaseGameTooltipOwner(frame: FrameXmlFrame): void {
    const state = this.#gameTooltipState.get(frame);
    if (state) {
      state.owner = undefined;
      state.anchor = "ANCHOR_NONE";
    }
    if (frame.tooltipCursorAnchor) this.#bridge.update(frame, (mutable) => { mutable.tooltipCursorAnchor = undefined; });
  }

  /**
   * Put a tooltip against its owner the way `SetOwner(owner, anchor, x, y)` does. The offsets are in
   * the tooltip's own units, as `PaperDollFrame.lua:1334` passes them (`"ANCHOR_RIGHT", 6, -h-6`).
   */
  private placeGameTooltip(frame: FrameXmlFrame, owner: FrameXmlFrame, anchor: string, x: number, y: number): void {
    const bridge = this.#bridge;
    bridge.update(frame, (mutable) => {
      mutable.tooltipCursorAnchor = anchor === "ANCHOR_CURSOR" ? { x, y } : undefined;
      mutable.clampedToScreen = true;
    });
    // PRESERVE keeps the points a previous owner left; the other two leave placement to the caller
    // (`GameTooltip_SetDefaultAnchor` SetPoints right after ANCHOR_NONE) or to the pointer.
    if (anchor === "ANCHOR_PRESERVE") return;
    bridge.ClearAllPoints(frame);
    if (anchor === "ANCHOR_NONE" || anchor === "ANCHOR_CURSOR") return;
    const [point, relativePoint] = GAME_TOOLTIP_ANCHORS[anchor] ?? GAME_TOOLTIP_ANCHORS["ANCHOR_RIGHT"]!;
    bridge.SetPoint(frame, point, owner, relativePoint, x, y);
  }

  /**
   * An item setter's aftermath, as the client does it: `GetItem` answers (name, link) from now on
   * and `OnTooltipSetItem` runs — the stock handler (`GameTooltip.xml:20-25`, the Shift comparison)
   * and every add-on hook (AnyIDTooltip's «ItemID:» row) live there. Called after the content is
   * drawn, because drawing it clears the previous identity.
   */
  private announceTooltipItem(frame: FrameXmlFrame, name: string, link: string, equipped: boolean): void {
    const state = this.gameTooltipState(frame);
    state.item = { name, link };
    state.equipped = equipped;
    this.#bridge.fireScript(frame, "OnTooltipSetItem");
  }

  /** The spell counterpart: `GetSpell` answers (name, rank, spellID) and `OnTooltipSetSpell` runs. */
  private announceTooltipSpell(frame: FrameXmlFrame, name: string, rank: string, id: number | undefined): void {
    this.gameTooltipState(frame).spell = { name, rank, id };
    this.#bridge.fireScript(frame, "OnTooltipSetSpell");
  }

  /** Resolve authored tooltip lines; the DOM renderer already knows how to paint these widgets. */
  private gameTooltipLine(
    frame: FrameXmlFrame,
    side: "Left" | "Right",
    index: number,
    create = false,
  ): FrameXmlFrame | undefined {
    if (index < 1 || index > GAME_TOOLTIP_MAX_LINES) return undefined;
    const name = `${frame.name}Text${side}${index}`;
    let line = this.#bridge.getFrame(name);
    if (!line && create) {
      line = this.#bridge.createChild(frame, "FontString", name, "ARTWORK",
        index === 1 ? "GameTooltipHeaderText" : "GameTooltipText");
      if (line) {
        this.bindFrame(line);
        const previous = this.gameTooltipLine(frame, side, index - 1);
        this.#bridge.SetPoint(line, "TOPLEFT", previous ?? frame,
          previous ? "BOTTOMLEFT" : "TOPLEFT", previous ? 0 : 10, previous ? -2 : -10);
      }
    }
    return line?.parent === frame && line.type === "FontString" ? line : undefined;
  }

  /** Withdraw the redraw a tooltip's drawn content is waiting on; see `cancelRefresh`. */
  private cancelGameTooltipRefresh(frame: FrameXmlFrame): void {
    const state = this.#gameTooltipState.get(frame);
    const cancel = state?.cancelRefresh;
    if (!state || !cancel) return;
    state.cancelRefresh = undefined;
    cancel();
  }

  private clearGameTooltipLines(frame: FrameXmlFrame): void {
    const state = this.gameTooltipState(frame);
    this.cancelGameTooltipRefresh(frame);
    for (let index = 1; index <= GAME_TOOLTIP_MAX_LINES; index += 1) {
      for (const side of ["Left", "Right"] as const) {
        const line = this.gameTooltipLine(frame, side, index);
        // An action button refreshes its tooltip five times a second; lines that are already
        // blank and hidden are left alone rather than re-announced to the renderer.
        if (!line || (!line.visible && line.text === "")) continue;
        this.#bridge.SetText(line, "");
        this.#bridge.Hide(line);
      }
    }
    state.nextLine = 1;
    state.minimumWidth = 0;
    if (frame.tooltipMinimumWidth) this.#bridge.update(frame, (mutable) => { mutable.tooltipMinimumWidth = 0; });
    state.unit = undefined;
    state.item = undefined;
    state.spell = undefined;
    state.equipped = false;
    this.#bridge.fireScript(frame, "OnTooltipCleared");
  }

  /**
   * Writes one line. `index` names the row for the right half of a double line; without it the
   * line takes the next free row and advances past it.
   */
  private setGameTooltipLine(
    frame: FrameXmlFrame,
    text: string,
    side: "Left" | "Right" = "Left",
    color?: FrameXmlColor,
    wrap = false,
    index?: number,
  ): boolean {
    const state = this.gameTooltipState(frame);
    const line = this.gameTooltipLine(frame, side, index ?? state.nextLine, true);
    if (!line) return false;
    this.#bridge.update(line, (mutable) => {
      mutable.textColor = color;
      mutable.setAttribute("wordWrap", String(wrap));
    });
    this.#bridge.SetText(line, text);
    this.#bridge.Show(line);
    if (index === undefined) state.nextLine += 1;
    return true;
  }

  /** `AddDoubleLine`: a left and a right text on one row. */
  private setGameTooltipDoubleLine(
    frame: FrameXmlFrame, left: string, right: string, leftColor: FrameXmlColor, rightColor: FrameXmlColor,
  ): boolean {
    const state = this.gameTooltipState(frame);
    const index = state.nextLine;
    if (!this.setGameTooltipLine(frame, left, "Left", leftColor, false, index)) return false;
    if (right.length > 0) this.setGameTooltipLine(frame, right, "Right", rightColor, false, index);
    state.nextLine = index + 1;
    return true;
  }

  /**
   * Paints shared tooltip content the way the original paints the same tooltip: the title in its
   * item quality's colour with a spell's rank right of it in grey, each line in its tone's (or its
   * exact stock colour), a pair as one `AddDoubleLine` row, colour runs as the corpus' own escapes,
   * prose wrapped, a price as the corpus' own money row, and the trailing hints green.
   *
   * A price goes where the client sends it. Its C side draws no coins itself: it fires the
   * tooltip's own `OnTooltipAddMoney(cost)`, and only `GameTooltipTemplate` answers that
   * (`GameTooltipTemplate.xml:248-253`), with `GameTooltip_OnTooltipAddMoney` → `SetTooltipMoney`
   * (`GameTooltip.lua:86-135`: a blank row with the stock `TooltipMoneyFrameTemplate` over it),
   * cleared again by its `OnTooltipCleared`. So:
   * - no handler — `ShoppingTooltipTemplate` has none, nor has a template-less tooltip such as
   *   WCollections' `DataRequestTooltip` — no price at all. Calling `SetTooltipMoney` there anyway
   *   started a money frame per hover that nothing cleared: 50 hovers, 50 frames, all shown.
   * - an add-on's `SetScript` handler, a Lua function taking `(self, cost)`: that handler runs.
   * - the template's own body, fired like any handler now that `FRAME_XML_SCRIPT_PARAMETERS` names
   *   its `cost, maxcost` (before, the body read a global `cost` and was called around instead):
   *   `SetTooltipMoney` with the stock «Цена продажи:», and every `HookScript` on the script after
   *   it (no Lua or XML in the client's 29 `Interface\AddOns` folders hooks it; the one hit is the
   *   copy of `UI.xsd` WCollections ships).
   * - the template's body on an unnamed tooltip, where `frame:GetName().."MoneyFrame"` raises — one
   *   Lua error per hovered price, measured — or a binder without the corpus' `SetTooltipMoney` or
   *   a real `GetMinimumWidth` (that function ends on a compare with it): the price in words.
   *
   * Content still waiting for a late answer (`content.refresh`) is drawn again when the answer
   * lands, if the tooltip still shows these rows. Rows an add-on appended after them — the
   * AnyIDTooltip «ItemID:» double line — are carried over below, and what `GetItem`, `GetSpell`,
   * `GetUnit` and `IsEquippedItem` answer is kept, with the name and rank the answer brought. An
   * owner with an `UpdateTooltip` redraws five times a second on its own; this is for the setters
   * whose owner has none (a chat link, an add-on's hyperlink).
   */
  private setGameTooltipContent(frame: FrameXmlFrame, content: TooltipContent): boolean {
    this.clearGameTooltipLines(frame);
    const exact = (hex: string | undefined): FrameXmlColor | undefined => {
      const match = hex === undefined ? null : /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
      return match ? tooltipColor(parseInt(match[1]!, 16) / 255, parseInt(match[2]!, 16) / 255,
        parseInt(match[3]!, 16) / 255) : undefined;
    };
    const title = content.quality === undefined ? TOOLTIP_WHITE
      : TOOLTIP_QUALITY_COLORS[content.quality] ?? TOOLTIP_WHITE;
    if (!this.setGameTooltipLine(frame, content.title, "Left", title)) return false;
    if (content.titleRight) this.setGameTooltipLine(frame, content.titleRight, "Right", TOOLTIP_GRAY, false, 1);
    /** Where this tooltip's price goes (see above), decided at the first price. */
    let money: "none" | "script" | "coins" | "words" | undefined;
    const moneyRoute = (): "none" | "script" | "coins" | "words" => {
      if (!this.#bridge.hasScript(frame, "OnTooltipAddMoney")) return "none";
      if (frame.scripts.has("OnTooltipAddMoney")) return "script";
      if (!frame.named) return "words";
      const setter = this.#vm.globalFunction("SetTooltipMoney");
      if (setter) this.#vm.release(setter);
      return setter !== undefined && typeof this.gameTooltipMethods()["GetMinimumWidth"] === "function" ? "coins" : "words";
    };
    for (const line of content.lines ?? []) {
      const text = tooltipLineText(line);
      if (typeof line === "string") {
        if (text.length > 0) this.setGameTooltipLine(frame, text, "Left", TOOLTIP_WHITE, text.length > GAME_TOOLTIP_WRAP_CHARS);
        continue;
      }
      if (text.length === 0 && !line.right) continue;
      const color = exact(line.color) ?? (line.tone === undefined ? TOOLTIP_WHITE : TOOLTIP_TONE_COLORS[line.tone]);
      if (line.right) {
        this.setGameTooltipDoubleLine(frame, text, line.right, color, exact(line.rightColor) ?? TOOLTIP_WHITE);
        continue;
      }
      if (line.money && line.money.copper > 0) {
        money ??= moneyRoute();
        if (money === "none") continue;
        if (money === "script" || money === "coins") {
          this.#bridge.fireScript(frame, "OnTooltipAddMoney", line.money.copper);
          continue;
        }
      }
      const prose = line.wrap
        ?? (line.tone === "description" || line.tone === "flavour" || text.length > GAME_TOOLTIP_WRAP_CHARS);
      this.setGameTooltipLine(frame, text, "Left", color, prose);
    }
    for (const line of content.footer ?? []) {
      if (line.length > 0) this.setGameTooltipLine(frame, line, "Left", TOOLTIP_GREEN, line.length > GAME_TOOLTIP_WRAP_CHARS);
    }
    this.sizeGameTooltip(frame);
    this.#bridge.Show(frame);
    if (!content.refresh) return true;

    // What this call drew, row by row, so a late redraw can tell whether it is still on screen.
    const rows = (): string[] => {
      const drawnRows: string[] = [];
      for (let index = 1; index < this.gameTooltipState(frame).nextLine; index += 1) {
        const right = this.gameTooltipLine(frame, "Right", index);
        drawnRows.push(`${this.gameTooltipLine(frame, "Left", index)?.text ?? ""}\u0000${right?.visible ? right.text : ""}`);
      }
      return drawnRows;
    };
    const signature = (value: TooltipContent): string => JSON.stringify([value.title, value.titleRight, value.quality,
      (value.lines ?? []).map((line) => typeof line === "string" ? line : [tooltipLineText(line), line.right, line.money?.copper]),
      value.footer]);
    const drawn = rows();
    const state = this.gameTooltipState(frame);
    const watch = (current: TooltipContent): void => {
      const before = signature(current);
      let spent = false;
      let cancel: (() => void) | undefined;
      // The cancel is kept on the tooltip: clearing its lines or hiding it withdraws this redraw.
      cancel = current.refresh?.watch((next) => {
        spent = true;
        if (cancel !== undefined && state.cancelRefresh === cancel) state.cancelRefresh = undefined;
        // A redraw can outlive its HUD: `FrameXmlBoot.close` ends in `lua_close`, and the frames
        // (a shown `ItemRefTooltip` among them) still read as visible afterwards. fengari throws on
        // the first touch of a closed state («Cannot set properties of null», measured).
        if (this.#vm.closed) return;
        const now = rows();
        if (!frame.visible || drawn.some((row, index) => now[index] !== row)) return;
        // Something else arrived; this tooltip's own answer is still on its way.
        if (signature(next) === before) { watch(next); return; }
        const appended: { left: FrameXmlFrame | undefined; right: FrameXmlFrame | undefined }[] = [];
        for (let index = drawn.length + 1; index < state.nextLine; index += 1) {
          appended.push({ left: this.gameTooltipLine(frame, "Left", index), right: this.gameTooltipLine(frame, "Right", index) });
        }
        const carried = appended.map(({ left, right }) => ({
          left: left?.text ?? "", leftColor: left?.textColor ?? TOOLTIP_WHITE,
          wrap: left?.attributes["wordWrap"] === "true",
          right: right?.visible ? right.text : "", rightColor: right?.textColor ?? TOOLTIP_WHITE,
        }));
        // Drawing clears what the tooltip describes; the setter that described it is not re-run.
        // The drawing keeps a redraw of its own when the new content still waits for something.
        const {
          owner: _owner, anchor: _anchor, nextLine: _nextLine, minimumWidth: _minimumWidth,
          cancelRefresh: _cancelRefresh, ...identity
        } = state;
        this.#bridge.runInMutationBatch(() => {
          this.setGameTooltipContent(frame, next);
          for (const row of carried) {
            if (row.right.length > 0) this.setGameTooltipDoubleLine(frame, row.left, row.right, row.leftColor, row.rightColor);
            else this.setGameTooltipLine(frame, row.left, "Left", row.leftColor, row.wrap);
          }
          Object.assign(state, identity);
          // The same thing, now by the name the answer brought: a link drawn as «Предмет 40001»
          // answered `GetItem` with that placeholder for as long as it stayed up.
          if (state.item) state.item = { ...state.item, name: next.title };
          if (state.spell) state.spell = { ...state.spell, name: next.title, rank: next.titleRight ?? state.spell.rank };
          this.sizeGameTooltip(frame);
        });
      });
      if (!spent) state.cancelRefresh = cancel;
    };
    watch(content);
    return true;
  }

  /** Shows the content an item/spell link names; false (and a hidden tooltip) when nothing does. */
  private setGameTooltipLink(frame: FrameXmlFrame, link: unknown): boolean {
    const target = tooltipHyperlink(link);
    const adapter = this.#options.gameTooltipAdapter;
    const content = target === undefined ? undefined
      : target.kind === "item" ? adapter?.item?.(target.id) : adapter?.spell?.(target.id);
    if (content === undefined || !this.setGameTooltipContent(frame, content)) {
      this.hideGameTooltip(frame);
      return false;
    }
    const state = this.gameTooltipState(frame);
    if (target!.kind === "item") {
      state.item = { name: content.title, link: typeof link === "string" ? link : "" };
      this.#bridge.fireScript(frame, "OnTooltipSetItem");
    } else {
      // The stock spell layout carries the rank right of the name (`titleRight`), the native one as
      // its first line; `GetSpell()` after `SetHyperlink("spell:N")` answers it either way.
      state.spell = { name: content.title, rank: spellContentRank(content), id: target!.id };
      this.#bridge.fireScript(frame, "OnTooltipSetSpell");
    }
    return true;
  }

  /**
   * `SetUnit`: what the original writes for a unit, from the same Lua API the corpus reads — the
   * name in `GameTooltip_UnitColor`'s colour, the guild, the level line from the client's own
   * templates, and the PvP flag — then `OnTooltipSetUnit`, which is where the corpus and add-ons
   * extend it.
   */
  private setGameTooltipUnit(frame: FrameXmlFrame, unit: string): boolean {
    const exists = this.callGlobal("UnitExists", [unit], 1)[0];
    const name = this.callGlobal("UnitName", [unit], 1)[0];
    if (!exists || typeof name !== "string" || name.length === 0) {
      this.hideGameTooltip(frame);
      return false;
    }
    this.clearGameTooltipLines(frame);
    const color = this.callGlobal("GameTooltip_UnitColor", [unit], 3);
    this.setGameTooltipLine(frame, name, "Left", luaColor(color, 0, TOOLTIP_WHITE));
    const player = this.callGlobal("UnitIsPlayer", [unit], 1)[0] === true;
    const guild = player ? this.callGlobal("GetGuildInfo", [unit], 1)[0] : undefined;
    if (typeof guild === "string" && guild.length > 0) this.setGameTooltipLine(frame, `<${guild}>`, "Left", TOOLTIP_WHITE);
    const level = num(this.callGlobal("UnitLevel", [unit], 1)[0], 0);
    const levelText = level > 0 ? String(level) : "??";
    const global = (key: string): string | undefined => this.#vm.globalString(key);
    let levelLine: string | undefined;
    if (player) {
      const race = this.callGlobal("UnitRace", [unit], 1)[0];
      const className = this.callGlobal("UnitClass", [unit], 1)[0];
      const template = global("TOOLTIP_UNIT_LEVEL_RACE_CLASS");
      if (template && typeof race === "string" && typeof className === "string") {
        levelLine = formatClientTemplate(template, levelText, race, className);
      }
    } else {
      const type = this.callGlobal("UnitCreatureType", [unit], 1)[0];
      const template = typeof type === "string" && type.length > 0
        ? global("TOOLTIP_UNIT_LEVEL_TYPE") : global("TOOLTIP_UNIT_LEVEL");
      if (template) levelLine = formatClientTemplate(template, levelText, type);
      const classification = this.callGlobal("UnitClassification", [unit], 1)[0];
      const rank = classification === "worldboss" ? global("BOSS")
        : classification === "elite" || classification === "rareelite" ? global("ELITE") : undefined;
      if (levelLine && rank) levelLine = `${levelLine} (${rank})`;
    }
    if (levelLine) this.setGameTooltipLine(frame, levelLine, "Left", TOOLTIP_WHITE);
    if (this.callGlobal("UnitIsPVP", [unit], 1)[0] === true) {
      this.setGameTooltipLine(frame, global("PVP") ?? "PvP", "Left", TOOLTIP_WHITE);
    }
    this.gameTooltipState(frame).unit = unit;
    this.sizeGameTooltip(frame);
    this.#bridge.Show(frame);
    this.#bridge.fireScript(frame, "OnTooltipSetUnit");
    return true;
  }

  /**
   * An aura's tooltip: its name, what its spell is known to say, and — for an aura that runs out —
   * how long it has left.
   *
   * The time is the client's own row: `SPELL_TIME_REMAINING_DAYS/HOURS/MIN/SEC` (GlobalStrings
   * «Осталось: %d |4минута:минуты:минут;»), from `UnitAura`'s expirationTime less `GetTime()`, in the
   * largest whole unit the way the buff button's own countdown picks it (`SecondsToTimeAbbrev`,
   * UIParent.lua:2327-2342: a day, an hour or a minute and up round up, seconds are whole). It stays
   * current because `AuraButton_OnUpdate` sets the tooltip again while it owns it. Whether the C
   * tooltip rounds exactly like the button is not measured against the live client.
   *
   * The spell's words can arrive after the tooltip: a permanent aura is redrawn by nothing else —
   * `AuraButton_Update` gives it no OnUpdate (BuffFrame.lua:189-199) — so the spell content's late
   * redraw is passed through, rebuilt as the same aura rows.
   *
   * The words are the aura's own (`GameTooltipWidgetAdapter.aura`, the spell's `AuraDescription`)
   * where the adapter has them, and the cast description (`spell`) only without: spell 6673's row
   * says «Сила атаки увеличена на $s1.» for the buff and «Воин издает боевой крик.» for the book.
   */
  private setGameTooltipAura(frame: FrameXmlFrame, query: string, args: readonly unknown[]): boolean {
    const values = this.callGlobal(query, [args[0], args[1], args[2]], 11);
    const name = values[0];
    if (typeof name !== "string" || name.length === 0) {
      this.hideGameTooltip(frame);
      return false;
    }
    const duration = num(values[5], 0);
    const expiration = num(values[6], 0);
    const remaining = duration > 0 && expiration > 0 ? expiration - num(this.callGlobal("GetTime", [], 1)[0], 0) : 0;
    const time = remaining > 0 ? this.auraTimeRemaining(remaining) : undefined;
    const spellId = num(values[10], 0);
    const aura = (spell: TooltipContent | undefined): TooltipContent => {
      const lines: TooltipLine[] = (spell?.lines ?? [])
        .filter((line): line is TooltipLine => typeof line !== "string" && line.tone === "description");
      if (time) lines.push({ text: time, tone: "description", wrap: false });
      const refresh = spell?.refresh;
      return {
        title: name, lines,
        ...(refresh ? { refresh: { watch: (redraw: (next: TooltipContent) => void) => refresh.watch((next) => redraw(aura(next))) } } : {}),
      };
    };
    const adapter = this.#options.gameTooltipAdapter;
    const content = spellId > 0 ? adapter?.aura?.(spellId) ?? adapter?.spell?.(spellId) : undefined;
    return this.setGameTooltipContent(frame, aura(content));
  }

  /** «Осталось: 12 минут» for a positive number of seconds, from the VM's own GlobalStrings. */
  private auraTimeRemaining(seconds: number): string | undefined {
    let key = "SPELL_TIME_REMAINING_SEC";
    let count = Math.floor(seconds);
    if (seconds >= 86400) { key = "SPELL_TIME_REMAINING_DAYS"; count = Math.ceil(seconds / 86400); }
    else if (seconds >= 3600) { key = "SPELL_TIME_REMAINING_HOURS"; count = Math.ceil(seconds / 3600); }
    else if (seconds >= 60) { key = "SPELL_TIME_REMAINING_MIN"; count = Math.ceil(seconds / 60); }
    const template = this.#vm.globalString(key);
    // The plural escape stays in the string: the FontString resolves `|4` against the number.
    return template ? formatClientTemplate(template, count) : undefined;
  }

  /**
   * Size the authored root from the visible lines, by the same rules the renderer lays them out
   * with (`FRAME_XML_TOOLTIP_LAYOUT`), for Lua that asks `GetWidth`/`GetHeight` before the next
   * paint. Each line is measured in its own font through the bridge's text measure — the renderer's
   * canvas once one is mounted — instead of the old 7 units per character, which was 5 units short
   * on the 14px header («Боевой крик» 82 against 77) and 28 long on 12px body text. The renderer
   * writes back what it actually drew; this is only the answer until then.
   */
  private sizeGameTooltip(frame: FrameXmlFrame): void {
    const layout = FRAME_XML_TOOLTIP_LAYOUT;
    const wrapWidth = Math.max(1, layout.WRAP_WIDTH - 2 * layout.PADDING);
    const rows: { readonly width: number; readonly lines: readonly { natural: number; wraps: boolean; lineBox: number }[] }[] = [];
    let content = 0;
    for (let index = 1; index <= GAME_TOOLTIP_MAX_LINES; index += 1) {
      const lines: { natural: number; wraps: boolean; lineBox: number }[] = [];
      let width = 0;
      for (const side of ["Left", "Right"] as const) {
        const line = this.gameTooltipLine(frame, side, index);
        if (!line?.visible || line.text.length === 0) continue;
        const natural = this.#bridge.measureText(line);
        const wraps = line.attributes["wordWrap"] === "true";
        const style = line.fontObject
          ? this.#bridge.fontStyle(line.fontObject) ?? this.#bridge.fontObjectStyle(line.fontObject) : undefined;
        const fontHeight = num(line.attributes["fontHeight"], style?.height ?? 14);
        lines.push({ natural, wraps, lineBox: fontHeight * GAME_TOOLTIP_LINE_BOX });
        // A wrapped line never widens the box past the wrap width; a double line keeps its gap.
        width += (wraps ? Math.min(natural, wrapWidth) : natural) + (lines.length > 1 ? layout.COLUMN_GAP : 0);
      }
      if (lines.length === 0) continue;
      rows.push({ width, lines });
      content = Math.max(content, width);
    }
    const state = this.gameTooltipState(frame);
    const width = Math.min(GAME_TOOLTIP_MAX_WIDTH, Math.max(
      layout.MIN_WIDTH, state.minimumWidth, Math.ceil(content + 2 * layout.PADDING),
    ));
    const inner = Math.max(1, width - 2 * layout.PADDING);
    let textHeight = 0;
    for (const row of rows) {
      textHeight += Math.max(...row.lines.map((line) => line.lineBox
        * (line.wraps ? Math.max(1, Math.ceil(line.natural / inner)) : 1)));
    }
    const height = Math.max(GAME_TOOLTIP_MIN_HEIGHT, Math.ceil(textHeight
      + Math.max(0, rows.length - 1) * layout.ROW_GAP + 2 * layout.PADDING));
    if (frame.attributes["width"] === String(width) && frame.attributes["height"] === String(height)) return;
    this.#bridge.update(frame, (mutable) => {
      mutable.setAttribute("width", String(width));
      mutable.setAttribute("height", String(height));
    });
  }

  /**
   * Reject an unsupported/empty payload without leaving the previous tooltip visible.
   *
   * The owner stays: this is the setter answering «nothing here», not the caller letting go, and
   * stock code keeps writing to the tooltip it owns. `PaperDollItemSlotButton_OnEnter`
   * (`PaperDollFrame.lua:1336-1344`) follows a failed `SetInventoryItem` with `SetText(slot name)`
   * and never calls `SetOwner` again — it re-runs on MODIFIER_STATE_CHANGED while shown — and
   * `ActionButton_Update` (`ActionButton.lua:265`) re-fills an empty slot's tooltip while
   * `GetOwner() == self` once something is dropped into it. Measured before this: the OnHide release
   * left that shown slot tooltip with `GetOwner()` nil. Only `Hide`/`FadeOut` or a hidden ancestor
   * take the owner away.
   */
  private hideGameTooltip(frame: FrameXmlFrame): void {
    this.clearGameTooltipLines(frame);
    this.sizeGameTooltip(frame);
    const outer = this.#tooltipKeepingOwner;
    this.#tooltipKeepingOwner = frame;
    try {
      this.#bridge.Hide(frame);
    } finally {
      this.#tooltipKeepingOwner = outer;
    }
  }

  /** Call a C-style global through the same seam wrapper the stock Lua already uses. */
  private callGlobal(name: string, args: readonly unknown[], results: number): readonly unknown[] {
    const functionRef = this.#vm.globalFunction(name);
    if (!functionRef) return [];
    try {
      return this.#vm.call(functionRef, args, results);
    } finally {
      this.#vm.release(functionRef);
    }
  }

  /**
   * The common GameTooltip method table. Inventory/action additions belong here too, so there is
   * one owner for the method surface regardless of which stock module first touches it.
   */
  private gameTooltipMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    const hideTooltip: WidgetMethod = ({ frame }) => {
      bridge.Hide(frame);
      // A shown tooltip let go in its OnHide already; unless that OnHide showed it again, a
      // tooltip that was hidden before fired none and lets go here.
      if (!frame.visible) {
        this.releaseGameTooltipOwner(frame);
        this.cancelGameTooltipRefresh(frame);
      }
    };
    return {
      // The right-hand padding the stock code sets before a wide icon; kept for its getter.
      SetPadding: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.setAttribute("padding", String(num(args[0]))); }, "paint");
      },
      GetPadding: ({ self }) => [num(self.attributes["padding"])],
      /**
       * `SetOwner(owner, anchor, x, y)` hands the tooltip to a new owner and starts it empty.
       *
       * Emptying is the client's: stock code fills a tooltip straight after `SetOwner` with
       * `AddLine` alone — `Minimap_SetTooltip` re-runs `SetOwner(MinimapZoneTextButton,
       * "ANCHOR_LEFT")` + `AddLine(zoneName)` on every zone change while it is shown — and without
       * it the lines of whatever the tooltip showed before stayed above them. Measured on the
       * minimap probe: the zone button's tooltip read «Мои спутники», the companions button's text.
       */
      SetOwner: ({ frame, args }) => {
        const requested = args[0];
        const owner = requested === undefined || requested === null
          ? undefined : bridge.resolve(requested as FrameXmlFrame);
        if (requested !== undefined && requested !== null && !owner) return;
        const anchor = typeof args[1] === "string" ? args[1].trim().toUpperCase() : "ANCHOR_RIGHT";
        this.clearGameTooltipLines(frame);
        const state = this.gameTooltipState(frame);
        state.owner = owner;
        state.anchor = anchor;
        if (owner === undefined) {
          if (frame.tooltipCursorAnchor) bridge.update(frame, (mutable) => { mutable.tooltipCursorAnchor = undefined; });
          return;
        }
        this.placeGameTooltip(frame, owner, anchor, num(args[2]), num(args[3]));
      },
      GetOwner: ({ frame }) => [this.gameTooltipState(frame).owner],
      IsOwned: ({ frame, args }) => {
        const owner = this.gameTooltipState(frame).owner;
        return [owner !== undefined && owner === bridge.resolve(args[0] as FrameXmlFrame)];
      },
      GetAnchorType: ({ frame }) => {
        const state = this.gameTooltipState(frame);
        return [state.owner === undefined ? undefined : state.anchor];
      },
      // `GameTooltip_ShowCompareItem` slides a tooltip sideways with it to make room for the
      // comparison tooltips; the owner and the content stay.
      SetAnchorType: ({ frame, args }) => {
        const state = this.gameTooltipState(frame);
        if (state.owner === undefined || typeof args[0] !== "string") return;
        state.anchor = args[0].trim().toUpperCase();
        this.placeGameTooltip(frame, state.owner, state.anchor, num(args[1]), num(args[2]));
      },
      // `Hide` lets go of the owner even when the tooltip is already hidden, which the OnHide
      // release alone does not reach: over an empty action slot `SetAction` has hidden it already,
      // the OnLeave `Hide()` then fired no OnHide, and `ActionButton_Update` (`ActionButton.lua:265`,
      // `GetOwner() == self`) put the next page's spell up under a pointer that had left. Measured
      // before this on the dev page: `shownAfterUpdate=true`, «Глухая оборона». The release comes
      // after the hide, so OnHide scripts of a shown tooltip still see its owner as before.
      Hide: hideTooltip,
      // `UnitFrame_OnLeave` (`UnitFrame.lua:136-141`) fades the unit tooltip out unless newbie tips
      // are on. A recorded stub left it shown, and `GameTooltip_OnUpdate` re-ran the owner's
      // `UpdateTooltip` every 0.2 s for good. The client fades over about half a second; hiding at
      // once ends the refresh at the same moment, which is the part that matters.
      FadeOut: hideTooltip,
      // The stock `OnTooltipSetUnit` (GameTooltip.xml:15-19) colours a mouseover title with it.
      IsUnit: ({ frame, args }) => {
        const unit = this.gameTooltipState(frame).unit;
        if (unit === undefined || typeof args[0] !== "string") return [undefined];
        return [this.callGlobal("UnitIsUnit", [unit, args[0]], 1)[0] ? 1 : undefined];
      },
      IsEquippedItem: ({ frame }) => [this.gameTooltipState(frame).equipped ? 1 : undefined],
      // `SetTooltipMoney` (`GameTooltip.lua:135`) compares against it before widening the tooltip.
      GetMinimumWidth: ({ frame }) => [this.gameTooltipState(frame).minimumWidth],
      // SetText(text, r, g, b, a, wrap): the colour the caller asks for, white when it asks none.
      SetText: ({ frame, args }) => {
        const value = args[0];
        if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number") {
          this.hideGameTooltip(frame);
          return [false];
        }
        this.clearGameTooltipLines(frame);
        const text = value === undefined || value === null ? "" : String(value);
        if (text.length > 0) {
          this.setGameTooltipLine(frame, text, "Left", luaColor(args, 1, TOOLTIP_WHITE, true),
            args[5] === true || args[5] === 1);
        }
        this.sizeGameTooltip(frame);
        bridge.Show(frame);
        return [true];
      },
      SetSpell: ({ frame, args }) => {
        const id = args[0];
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const bookType = typeof args[1] === "string" ? args[1] : undefined;
        const values = this.callGlobal("GetSpellName", [id, bookType], 2);
        const name = typeof values[0] === "string" ? values[0] : "";
        if (!name) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const rank = typeof values[1] === "string" ? values[1] : "";
        // `SetSpell` takes a spellbook slot, and the slot's own link names the spell: with it the
        // spellbook hover draws what the action bar and a chat link draw for the same spell — cost
        // and range, cast time and cooldown, the gold description, the rank grey on the right.
        // A seam that does not answer `GetSpellLink` yet (or a spell nothing describes) keeps the
        // name and rank, in the same places.
        const link = this.callGlobal("GetSpellLink", [id, bookType], 1)[0];
        const known = tooltipHyperlink(link);
        const spellId = known?.kind === "spell" ? known.id : undefined;
        const content = spellId === undefined ? undefined : this.#options.gameTooltipAdapter?.spell?.(spellId);
        const drawn = content !== undefined && this.setGameTooltipContent(frame, content);
        if (!drawn) this.setGameTooltipContent(frame, rank ? { title: name, titleRight: rank } : { title: name });
        this.announceTooltipSpell(frame, name, rank || (content ? spellContentRank(content) : ""), spellId);
        return [true];
      },
      SetAction: ({ frame, args }) => {
        const slot = args[0];
        if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const content = this.#options.gameTooltipAdapter?.action?.(slot);
        if (content === undefined || !this.setGameTooltipContent(frame, content)) {
          // A stale tooltip is worse than a missing one. Unsupported/empty action rows never
          // enter a spell lookup and never stringify a table into a gateway texture path.
          this.hideGameTooltip(frame);
          return [false];
        }
        // The client raises the spell or item event for what the slot holds.
        const identity = this.#options.gameTooltipAdapter?.actionIdentity?.(slot) ?? (() => {
          const [kind, id] = this.callGlobal("GetActionInfo", [slot], 2);
          return typeof kind === "string" && typeof id === "number" ? { kind, id } : undefined;
        })();
        if (identity?.kind === "spell" && Number.isSafeInteger(identity.id) && identity.id > 0) {
          this.announceTooltipSpell(frame, content.title, spellContentRank(content), identity.id);
        } else if (identity?.kind === "item" && Number.isSafeInteger(identity.id) && identity.id > 0) {
          const link = this.callGlobal("GetItemInfo", [identity.id], 2)[1];
          this.announceTooltipItem(frame, content.title, typeof link === "string" ? link : "", false);
        }
        return [true];
      },
      // Returns (hasItem, hasCooldown, repairCost), the three values `PaperDollItemSlotButton_OnEnter`
      // (`PaperDollFrame.lua:1338`) reads; the repair cost is 0 until the seam knows one.
      SetInventoryItem: ({ frame, args }) => {
        const unit = typeof args[0] === "string" ? args[0] : undefined;
        const slot = typeof args[1] === "number" ? args[1] : Number(args[1]);
        // Slot 0 is the paper doll's AmmoSlot (Constants.lua `INVSLOT_AMMO`), answered from
        // PLAYER_AMMO_ID; the ammo stays in the bags, so it is not announced as worn gear.
        if (!unit || !Number.isSafeInteger(slot) || slot < 0) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const content = this.#options.gameTooltipAdapter?.inventoryItem(unit, slot);
        if (content === undefined || !this.setGameTooltipContent(frame, content)) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const link = this.callGlobal("GetInventoryItemLink", [unit, slot], 1)[0];
        const cooldown = num(this.callGlobal("GetInventoryItemCooldown", [unit, slot], 2)[1], 0) > 0;
        this.announceTooltipItem(frame, content.title, typeof link === "string" ? link : "",
          unit.toLowerCase() === "player" && slot >= 1 && slot <= 19);
        return [true, cooldown ? 1 : undefined, 0];
      },
      // Returns (hasCooldown, repairCost), what `ContainerFrameItemButton_OnEnter`
      // (`ContainerFrame.lua:774`) reads; a cooldown makes it refresh the tooltip every 0.2 s.
      SetBagItem: ({ frame, args }) => {
        const bag = typeof args[0] === "number" ? args[0] : Number(args[0]);
        const slot = typeof args[1] === "number" ? args[1] : Number(args[1]);
        if (!Number.isSafeInteger(bag) || !Number.isSafeInteger(slot) || slot < 1) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const content = this.#options.gameTooltipAdapter?.containerItem(bag, slot);
        if (content === undefined || !this.setGameTooltipContent(frame, content)) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const link = this.callGlobal("GetContainerItemLink", [bag, slot], 1)[0];
        const cooldown = num(this.callGlobal("GetContainerItemCooldown", [bag, slot], 2)[1], 0) > 0;
        this.announceTooltipItem(frame, content.title, typeof link === "string" ? link : "", false);
        return [cooldown ? 1 : undefined, 0];
      },
      ClearLines: ({ frame }) => { this.clearGameTooltipLines(frame); },
      AddLine: ({ frame, args }) => {
        const value = args[0];
        if (typeof value !== "string" && typeof value !== "number") return;
        this.setGameTooltipLine(frame, String(value), "Left", luaColor(args, 1, TOOLTIP_WHITE),
          args[4] === true || args[4] === 1);
        this.sizeGameTooltip(frame);
      },
      // AddDoubleLine(left, right, lr, lg, lb, rr, rg, rb): the stock sheet's «Label  value» rows.
      AddDoubleLine: ({ frame, args }) => {
        const left = args[0], right = args[1];
        if (typeof left !== "string" && typeof left !== "number") return;
        this.setGameTooltipDoubleLine(frame, String(left), right === undefined || right === null ? "" : String(right),
          luaColor(args, 2, TOOLTIP_WHITE), luaColor(args, 5, TOOLTIP_WHITE));
        this.sizeGameTooltip(frame);
      },
      // The original appends to the first line, the title.
      AppendText: ({ frame, args }) => {
        const title = this.gameTooltipLine(frame, "Left", 1);
        if (!title || (typeof args[0] !== "string" && typeof args[0] !== "number")) return;
        bridge.SetText(title, title.text + String(args[0]));
        this.sizeGameTooltip(frame);
      },
      SetMinimumWidth: ({ frame, args }) => {
        const minimum = Math.max(0, Math.min(GAME_TOOLTIP_MAX_WIDTH, num(args[0], 0)));
        this.gameTooltipState(frame).minimumWidth = minimum;
        // The renderer's floor for the drawn box, which is sized from the rows themselves.
        if (frame.tooltipMinimumWidth !== minimum) bridge.update(frame, (mutable) => { mutable.tooltipMinimumWidth = minimum; });
        this.sizeGameTooltip(frame);
      },
      // Inline icons in a line are not drawn; the call is accepted so the line itself still shows.
      AddTexture: () => {},
      NumLines: ({ frame }) => [Math.max(0, this.gameTooltipState(frame).nextLine - 1)],
      SetUnit: ({ frame, args }) => [typeof args[0] === "string" && this.setGameTooltipUnit(frame, args[0])],
      GetUnit: ({ frame }) => {
        const unit = this.gameTooltipState(frame).unit;
        return unit === undefined ? [] : [this.callGlobal("UnitName", [unit], 1)[0], unit];
      },
      SetHyperlink: ({ frame, args }) => [this.setGameTooltipLink(frame, args[0])],
      GetItem: ({ frame }) => {
        const item = this.gameTooltipState(frame).item;
        return item === undefined ? [] : [item.name, item.link];
      },
      GetSpell: ({ frame }) => {
        const spell = this.gameTooltipState(frame).spell;
        return spell === undefined ? [] : [spell.name, spell.rank, spell.id];
      },
      SetUnitAura: ({ frame, args }) => [this.setGameTooltipAura(frame, "UnitAura", args)],
      SetUnitBuff: ({ frame, args }) => [this.setGameTooltipAura(frame, "UnitBuff", args)],
      SetUnitDebuff: ({ frame, args }) => [this.setGameTooltipAura(frame, "UnitDebuff", args)],
      // The link-shaped setters: whatever the corpus' own link query names, as SetHyperlink shows it.
      SetMerchantItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetMerchantItemLink", [args[0]], 1)[0])],
      SetLootItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetLootSlotLink", [args[0]], 1)[0])],
      SetQuestItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetQuestItemLink", [args[0], args[1]], 1)[0])],
      SetQuestLogItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetQuestLogItemLink", [args[0], args[1]], 1)[0])],
      // Blizzard_TokenUI's currency rows and backpack strip (Blizzard_TokenUI.xml:112, :451): a 3.3.5
      // currency is an item (FrameXmlCurrency.ts), so the tooltip is that item's, by the itemID the
      // list answers (GetCurrencyListInfo's 9th value, GetBackpackCurrencyInfo's 5th).
      SetCurrencyToken: ({ frame, args }) => {
        const itemId = this.callGlobal("GetCurrencyListInfo", [args[0]], 9)[8];
        const link = typeof itemId === "number" ? this.callGlobal("GetItemInfo", [itemId], 2)[1] : undefined;
        return [this.setGameTooltipLink(frame, link)];
      },
      SetBackpackToken: ({ frame, args }) => {
        const itemId = this.callGlobal("GetBackpackCurrencyInfo", [args[0]], 5)[4];
        const link = typeof itemId === "number" ? this.callGlobal("GetItemInfo", [itemId], 2)[1] : undefined;
        return [this.setGameTooltipLink(frame, link)];
      },
      // GroupLootFrameTemplate's icon (LootFrame.xml:362-377), on enter and every update it owns.
      SetLootRollItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetLootRollItemLink", [args[0]], 1)[0])],
      // The mailbox: a letter's single item (MailFrame.lua:286, one argument) or one attachment of an
      // opened letter (:760, index and attachment); the attachment defaults to the first.
      SetInboxItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetInboxItemLink", [args[0], args[1] ?? 1], 1)[0])],
      SetSendMailItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetSendMailItemLink", [args[0]], 1)[0])],
      // The trade window's two columns (TradeFrame.xml:102-157, :493 for the enchant slot).
      SetTradePlayerItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetTradePlayerItemLink", [args[0]], 1)[0])],
      SetTradeTargetItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetTradeTargetItemLink", [args[0]], 1)[0])],
      // Blizzard_TradeSkillUI: the recipe icon (`TradeSkillItem_OnEnter`, one argument — the made
      // item, or the enchant itself for a recipe that makes none) and its eight reagent buttons
      // (`TradeSkillItemTemplate` OnEnter, the reagent's index second). An `enchant:` link draws
      // through the spell adapter, as SetHyperlink shows one.
      SetTradeSkillItem: ({ frame, args }) => {
        const reagent = args[1];
        const link = reagent === undefined || reagent === null
          ? this.callGlobal("GetTradeSkillItemLink", [args[0]], 1)[0]
          : this.callGlobal("GetTradeSkillReagentItemLink", [args[0], reagent], 1)[0];
        return [this.setGameTooltipLink(frame, link)];
      },
      // Blizzard_AuctionUI: a row of the three lists (`AuctionFrameItem_OnEnter`, "list" | "bidder" |
      // "owner" and the row on the page) and the Auctions tab's sell slot (`AuctionsItemButton`
      // OnEnter). 3.3.5 has no public link getter for the slot; the seam publishes one.
      SetAuctionItem: ({ frame, args }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("GetAuctionItemLink", [args[0], args[1]], 1)[0])],
      SetAuctionSellItem: ({ frame }) =>
        [this.setGameTooltipLink(frame, this.callGlobal("WebClientAuctionSellItemLink", [], 1)[0])],
      SetTrainerService: ({ frame, args }) => {
        const link = this.callGlobal("GetTrainerServiceItemLink", [args[0]], 1)[0];
        if (tooltipHyperlink(link)) return [this.setGameTooltipLink(frame, link)];
        const name = this.callGlobal("GetTrainerServiceInfo", [args[0]], 1)[0];
        if (typeof name !== "string" || name.length === 0) {
          this.hideGameTooltip(frame);
          return [false];
        }
        return [this.setGameTooltipContent(frame, { title: name })];
      },
      SetShapeshift: ({ frame, args }) => {
        const name = this.callGlobal("GetShapeshiftFormInfo", [args[0]], 2)[1];
        if (typeof name !== "string" || name.length === 0) {
          this.hideGameTooltip(frame);
          return [false];
        }
        return [this.setGameTooltipContent(frame, { title: name })];
      },
      SetPetAction: ({ frame, args }) => {
        const values = this.callGlobal("GetPetActionInfo", [args[0]], 2);
        const name = values[0];
        if (typeof name !== "string" || name.length === 0) {
          this.hideGameTooltip(frame);
          return [false];
        }
        // A pet spell is drawn as a spell — cost, range, cast time, description, the rank right of
        // the name — as the pet's spellbook draws it; the bare name is the fallback while its row loads.
        const index = typeof args[0] === "number" ? Math.trunc(args[0]) : Number.NaN;
        const spellId = Number.isInteger(index) ? this.#options.gameTooltipAdapter?.petActionSpell?.(index) : undefined;
        const content = spellId === undefined ? undefined : this.#options.gameTooltipAdapter?.spell?.(spellId);
        if (content !== undefined && this.setGameTooltipContent(frame, content)) {
          this.announceTooltipSpell(frame, name, typeof values[1] === "string" ? values[1] : spellContentRank(content), spellId);
          return [true];
        }
        const subtext = typeof values[1] === "string" && values[1].length > 0 ? [values[1]] : undefined;
        return [this.setGameTooltipContent(frame, subtext ? { title: name, lines: subtext } : { title: name })];
      },
      /**
       * The minimap tracking button's whole tooltip: its OnEnter (`Minimap.xml:495-497`) is
       * `SetOwner(self, "ANCHOR_RIGHT")` + `SetTracking()` and nothing else, so without this the
       * button showed no tooltip at all (a recorded stub on an emptied tooltip). What it lists is
       * the stock tracking API's own answer: the active trackers' names from `GetTrackingInfo`,
       * the first as the title, or the client's `MINIMAP_TRACKING_TOOLTIP_NONE` («Выбор объекта
       * слежения») while nothing is tracked. Whether the live client adds the tracking spell's
       * description under an active tracker is not known here; `GetTrackingInfo` gives no spell id.
       */
      SetTracking: ({ frame }) => {
        const count = Math.max(0, Math.min(GAME_TOOLTIP_MAX_LINES, Math.trunc(num(this.callGlobal("GetNumTrackingTypes", [], 1)[0], 0))));
        const active: string[] = [];
        for (let index = 1; index <= count; index += 1) {
          const [name, , on] = this.callGlobal("GetTrackingInfo", [index], 3);
          if (on && typeof name === "string" && name.length > 0) active.push(name);
        }
        const none = this.#vm.globalString("MINIMAP_TRACKING_TOOLTIP_NONE");
        const lines = active.length > 0 ? active : none ? [none] : [];
        this.clearGameTooltipLines(frame);
        if (lines.length === 0) {
          this.hideGameTooltip(frame);
          return;
        }
        for (const line of lines) this.setGameTooltipLine(frame, line, "Left", TOOLTIP_WHITE);
        this.sizeGameTooltip(frame);
        bridge.Show(frame);
      },
    };
  }

  /**
   * An anchor target, which the real API takes as a frame *or* a frame name.
   *
   * RealmList.xml relies on the name form —
   * `_G[self:GetName().."PVP"]:SetPoint("LEFT", self:GetName().."NormalText", "RIGHT", 10, 0)` —
   * so dropping a string here would silently unanchor a label.
   */
  private anchorTarget(value: unknown): FrameXmlFrame | undefined {
    if (typeof value === "string") return this.#bridge.getFrame(value);
    const frame = value as FrameXmlFrame | undefined;
    return frame && this.#refs.has(frame) ? frame : undefined;
  }

  // ---- method groups -----------------------------------------------------

  private baseMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      GetName: ({ self }) => [self.named ? self.name : undefined],
      GetObjectType: ({ self }) => [self.type],
      IsObjectType: ({ self, args }) => [widgetIsA(self.type, str(args[0]))],
      GetParent: ({ self }) => [self.parent],
      SetParent: ({ frame, args }) => {
        const requested = args[0];
        const parent = requested === undefined || requested === null
          ? undefined : this.anchorTarget(requested);
        // WoW rejects a non-frame target; do not turn a bad addon argument into an
        // accidental unparent operation.
        if (requested !== undefined && requested !== null && !parent) return;
        // parentKey is a field published on the XML creation owner, not a live
        // alias of GetParent(). Stock InterfaceOptionsPanels.lua moves the chat
        // edit box to UIParent for classic style, then ChatFrame.lua continues to
        // use DEFAULT_CHAT_FRAME.editBox through that original field.
        bridge.SetParent(frame, parent);
      },
      SetPoint: ({ frame, args }) => {
        const point = str(args[0]);
        // Both the target and relativePoint can be omitted independently. TSWoW's shared
        // widgets use (point, target, x, y); treating x as an anchor name collapses their rows.
        if (typeof args[1] === "number") {
          bridge.SetPoint(frame, point, undefined, point, num(args[1]), num(args[2]));
          return;
        }
        const omittedRelativePoint = typeof args[2] === "number";
        bridge.SetPoint(
          frame, point,
          this.anchorTarget(args[1]),
          omittedRelativePoint || args[2] === undefined ? point : str(args[2]),
          num(args[omittedRelativePoint ? 2 : 3]), num(args[omittedRelativePoint ? 3 : 4]),
        );
      },
      SetAllPoints: ({ frame, args }) => {
        bridge.SetAllPoints(frame, this.anchorTarget(args[0]));
      },
      ClearAllPoints: ({ frame }) => { bridge.ClearAllPoints(frame); },
      GetNumPoints: ({ self }) => [self.points.length],
      GetPoint: ({ self, args }) => {
        const point = self.points[Math.max(0, num(args[0], 1) - 1)];
        if (!point) return [];
        return [point.point, point.relativeTo, point.relativePoint ?? point.point, point.x ?? 0, point.y ?? 0];
      },
      // Size, alpha, colour and texcoord setters are the ones OnUpdate handlers repeat every frame
      // with the value already set; each compares first so a repeat is not a re-render.
      SetWidth: ({ frame, self, args }) => {
        const width = String(num(args[0]));
        if (self.attributes["width"] !== width) bridge.update(frame, (m) => m.setAttribute("width", width));
      },
      SetHeight: ({ frame, self, args }) => {
        const height = String(num(args[0]));
        if (self.attributes["height"] !== height) bridge.update(frame, (m) => m.setAttribute("height", height));
      },
      SetSize: ({ frame, self, args }) => {
        const width = String(num(args[0]));
        const height = String(num(args[1]));
        if (self.attributes["width"] === width && self.attributes["height"] === height) return;
        bridge.update(frame, (m) => {
          m.setAttribute("width", width);
          m.setAttribute("height", height);
        });
      },
      // The *effective* size, which for the many `setAllPoints` frames in this corpus is not the
      // declared one — see `FrameXmlUiBridge.measure`.
      GetWidth: ({ frame }) => [bridge.measure(frame).width],
      GetHeight: ({ frame }) => [bridge.measure(frame).height],
      GetSize: ({ frame }) => {
        const size = bridge.measure(frame);
        return [size.width, size.height];
      },
      GetCenter: ({ frame }) => {
        const rect = bridge.geometry(frame);
        return [(rect.left + rect.right) / 2, (rect.bottom + rect.top) / 2];
      },
      GetBoundsRect: ({ frame }) => {
        const rect = bridge.geometry(frame);
        return [rect.left, rect.bottom, rect.width, rect.height];
      },
      // FloatingChatFrame.lua uses these to dock a chat window to the right edge of
      // the screen. The bridge owns the same rectangle used by layout, so this stays
      // useful before a DOM mount as well as after one.
      GetLeft: ({ frame }) => [bridge.geometry(frame).left],
      GetRight: ({ frame }) => [bridge.geometry(frame).right],
      GetTop: ({ frame }) => [bridge.geometry(frame).top],
      GetBottom: ({ frame }) => [bridge.geometry(frame).bottom],
      Show: ({ frame }) => { bridge.Show(frame); },
      Hide: ({ frame }) => { bridge.Hide(frame); },
      SetShown: ({ frame, args }) => { if (args[0]) bridge.Show(frame); else bridge.Hide(frame); },
      IsShown: ({ self }) => [self.visible],
      IsVisible: ({ frame }) => [bridge.isVisible(frame)],
      SetAlpha: ({ frame, self, args }) => {
        const alpha = num(args[0], 1);
        if (self.alpha !== alpha) bridge.update(frame, (m) => { m.alpha = alpha; }, "paint");
      },
      GetAlpha: ({ self }) => [self.alpha],
      SetScale: ({ frame, self, args }) => {
        const scale = num(args[0], 1);
        if (scale > 0 && self.scale !== scale) bridge.update(frame, (m) => { m.scale = scale; });
      },
      GetScale: ({ self }) => [self.scale],
      SetID: ({ frame, args }) => { bridge.update(frame, (m) => { m.id = num(args[0]); }); },
      GetID: ({ self }) => [self.id],
      // The same product `GetLeft`/`GetTop`/`GetCenter` divide by, so the two always agree.
      GetEffectiveScale: ({ frame }) => [bridge.effectiveScale(frame)],
      /**
       * Real rather than recorded: `FCF_OnUpdate` asks it three times per chat window every frame
       * (`FloatingChatFrame.lua:1074-1076`) to fade the chat in under the pointer, and as a stub each
       * call also walked the Lua stack for the census (0.02-0.09 ms a frame on the dev page). 1 or
       * nil, like the client.
       */
      IsMouseOver: ({ frame, args }) => [bridge.isMouseOver(frame,
        num(args[0]), num(args[1]), num(args[2]), num(args[3])) ? 1 : undefined],
    };
  }

  private regionMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetTexture: ({ frame, args }) => {
        // SetTexture also takes a colour (r, g, b[, a]); the corpus uses the
        // path form, but a numeric first argument must not become a filename.
        if (typeof args[0] === "number") {
          bridge.update(frame, (m) => { m.texture = ""; m.vertexColor = colorArgs(args); m.colorFill = true; });
          return;
        }
        const texture = textureReference(args[0]);
        if (texture === undefined) return;
        bridge.SetTexture(frame, texture);
        // A plain picture replaces a portrait (`SetPortraitToTexture`) whole, crop included.
        if (frame.portrait) bridge.update(frame, (mutable) => { mutable.portrait = false; }, "paint");
      },
      GetTexture: ({ self }) => [self.texture || undefined],
      SetTexCoord: ({ frame, self, args }) => {
        const next = texCoordArgs(args);
        const current = self.texCoords;
        if (current && current.left === next.left && current.right === next.right
          && current.top === next.top && current.bottom === next.bottom
          && sameCorners(current.corners, next.corners)) return;
        bridge.update(frame, (m) => { m.texCoords = next; }, "paint");
      },
      // On a FontString the vertex colour is the text's colour: stock paints item names with it
      // (LootFrame.lua:111, Blizzard_AuctionUI.lua:819), and a common item reads white over
      // GameFontNormal's gold. The two setters write the same colour, the later call winning, so
      // `GetTextColor` answers it as well — what the loot and auction name adapters used to copy.
      SetVertexColor: ({ frame, self, args }) => {
        const color = colorArgs(args);
        const text = frame.type === "FontString";
        if (sameColor(self.vertexColor, color) && (!text || sameColor(self.textColor, color))) return;
        bridge.update(frame, (m) => {
          m.vertexColor = color;
          if (text) m.textColor = color;
        }, "paint");
      },
      GetVertexColor: ({ self }) => {
        const color = self.vertexColor ?? { r: 1, g: 1, b: 1, a: 1 };
        return [color.r, color.g, color.b, color.a];
      },
      SetDesaturated: ({ frame, self, args }) => {
        const desaturated = args[0] === true || args[0] === 1;
        if (self.desaturated !== desaturated) bridge.update(frame, (m) => { m.desaturated = desaturated; }, "paint");
        return [true];
      },
      SetBlendMode: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.alphaMode = str(args[0]).toUpperCase() || "BLEND"; }, "paint");
      },
      SetGradient: this.stub("SetGradient"),
      SetGradientAlpha: this.stub("SetGradientAlpha"),
      // Radians, counter-clockwise, about the texture's centre. `lgzg.lua` turns the login logo
      // with it once per frame; recorded, the logo sat still.
      SetRotation: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.textureRotation = num(args[0]); }, "paint");
      },
      GetRotation: ({ self }) => [self.textureRotation],
      SetNonBlocking: this.stub("SetNonBlocking"),
      SetDrawLayer: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.drawLayer = str(args[0]).toUpperCase() || m.drawLayer; });
      },
      GetDrawLayer: ({ self }) => [self.drawLayer],
    };
  }

  private textMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetText: ({ frame, args }) => { bridge.SetText(frame, str(args[0])); },
      GetText: ({ self }) => [self.text],
      SetFormattedText: ({ frame, args }) => {
        // The corpus reaches SetFormattedText through Lua's own format, which
        // the shim layer already made 5.1-shaped; reuse it rather than
        // re-implementing printf here.
        const [format, ...rest] = args;
        const formatted = this.formatThroughLua(str(format), rest);
        bridge.SetText(frame, formatted);
      },
      SetTextColor: ({ frame, self, args }) => {
        const color = colorArgs(args);
        if (!sameColor(self.textColor, color)) bridge.update(frame, (m) => { m.textColor = color; }, "paint");
      },
      GetTextColor: ({ self }) => {
        const color = self.textColor ?? { r: 1, g: 1, b: 1, a: 1 };
        return [color.r, color.g, color.b, color.a];
      },
      SetFontObject: ({ frame, args }) => {
        const value = args[0];
        const name = typeof value === "string" ? value
          : this.#bridge.resolve(value as FrameXmlFrame | undefined)?.fontObject ?? "";
        bridge.update(frame, (m) => {
          m.fontObject = name;
          for (const key of ["fontFile", "fontHeight", "fontFlags"]) m.setAttribute(key, undefined);
        });
      },
      GetFontObject: ({ self }) => [self.fontObject || undefined],
      SetFont: ({ frame, args }) => {
        const file = str(args[0]);
        const height = num(args[1]);
        if (!file || !Number.isFinite(height) || height <= 0) return [false];
        // These are per-widget overrides: changing one button must not mutate the shared font.
        bridge.update(frame, (m) => {
          m.setAttribute("fontFile", file);
          m.setAttribute("fontHeight", String(height));
          m.setAttribute("fontFlags", str(args[2]).toUpperCase());
        });
        return [true];
      },
      GetFont: ({ self }) => {
        // The registered `<Font>`s first; `fontObjectStyle` also answers a font object declared as a
        // virtual FontString and one asked for before `registerFontObjects` has run.
        const style = self.fontObject
          ? bridge.fontStyle(self.fontObject) ?? bridge.fontObjectStyle(self.fontObject) : undefined;
        const outline = style?.outline === "NORMAL" ? "OUTLINE"
          : style?.outline === "THICK" ? "THICKOUTLINE" : style?.outline;
        const inheritedFlags = [outline, style?.monochrome ? "MONOCHROME" : undefined]
          .filter(Boolean).join(",");
        return [self.attributes["fontFile"] ?? style?.file,
          num(self.attributes["fontHeight"], style?.height ?? 12),
          self.attributes["fontFlags"] ?? inheritedFlags];
      },
      // An alignment set here is the string's own: a later state font no longer re-justifies a
      // button's label (`syncButtonLabelFont`).
      SetJustifyH: ({ frame, self, args }) => {
        const justify = str(args[0]).toUpperCase();
        if (!justify || (self.justifyH === justify && self.ownJustifyH)) return;
        bridge.update(frame, (m) => { m.justifyH = justify; m.ownJustifyH = true; });
      },
      GetJustifyH: ({ self }) => [self.justifyH],
      SetJustifyV: ({ frame, self, args }) => {
        const justify = str(args[0]).toUpperCase();
        if (!justify || (self.justifyV === justify && self.ownJustifyV)) return;
        bridge.update(frame, (m) => { m.justifyV = justify; m.ownJustifyV = true; });
      },
      GetJustifyV: ({ self }) => [self.justifyV],
      SetSpacing: ({ frame, args }) => {
        const spacing = num(args[0], Number.NaN);
        if (!Number.isFinite(spacing)) return;
        bridge.update(frame, (m) => { m.setAttribute("spacing", String(spacing)); });
      },
      GetSpacing: ({ self }) => [num(self.attributes["spacing"],
        self.fontObject ? bridge.fontStyle(self.fontObject)?.spacing ?? 0 : 0)],
      // A shadow set from Lua is the string's own and outranks the font object's, as the client
      // has it: every TSWoW add-on label sets `SetShadowOffset(1, -1)`, and the stock code a few
      // headers. Attributes, like `fontFile`/`fontHeight`, so the renderer's font pass reads them
      // beside the other per-widget overrides.
      SetShadowColor: ({ frame, args }) => {
        const color = [num(args[0]), num(args[1]), num(args[2]), args[3] === undefined ? 1 : num(args[3], 1)];
        bridge.update(frame, (m) => { m.setAttribute("shadowColor", color.join(" ")); });
      },
      GetShadowColor: ({ self }) => {
        const own = (self.attributes["shadowColor"] ?? "").split(" ").map(Number);
        if (own.length === 4 && own.every(Number.isFinite)) return own;
        const color = self.fontObject ? bridge.fontObjectStyle(self.fontObject)?.shadowColor : undefined;
        return color ? [color.r, color.g, color.b, color.a] : [0, 0, 0, 0];
      },
      SetShadowOffset: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.setAttribute("shadowOffsetX", String(num(args[0])));
          m.setAttribute("shadowOffsetY", String(num(args[1])));
        });
      },
      GetShadowOffset: ({ self }) => {
        const style = self.fontObject ? bridge.fontObjectStyle(self.fontObject) : undefined;
        return [num(self.attributes["shadowOffsetX"], style?.shadowOffsetX ?? 0),
          num(self.attributes["shadowOffsetY"], style?.shadowOffsetY ?? 0)];
      },
      // `wordWrap` and `nonSpaceWrap` are the XML attributes of the same names, which the renderer
      // reads already; the setters write them.
      SetWordWrap: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.setAttribute("wordWrap", luaTruthy(args[0]) ? "true" : "false"); });
      },
      CanWordWrap: ({ self }) => [self.attributes["wordWrap"] !== "false"],
      SetNonSpaceWrap: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.setAttribute("nonSpaceWrap", luaTruthy(args[0]) ? "true" : "false"); });
      },
      CanNonSpaceWrap: ({ self }) => [self.attributes["nonSpaceWrap"] === "true"],
      // The client scales the glyphs to the height asked for; the nearest thing a font has is its size.
      SetTextHeight: ({ frame, args }) => {
        const height = num(args[0]);
        if (height > 0) bridge.update(frame, (m) => { m.setAttribute("fontHeight", String(height)); });
      },
      GetStringWidth: ({ frame }) => [bridge.measureText(frame)],
      GetTextWidth: ({ frame }) => [bridge.measureText(frame)],
      GetStringHeight: ({ frame, self }) => [bridge.measure(frame).height || (self.text ? 14 : 0)],
      GetTextHeight: ({ self }) => {
        if (!self.text) return [0];
        // Buttons keep their rendered label in a separate FontString. Measure that label when
        // mounted; during an early Lua layout pass use its actual font object's line height.
        const label = self.stateTextures.get("BUTTONTEXT");
        const measured = label ? bridge.measure(label).height : 0;
        if (measured > 0) return [measured];
        const font = label ?? self;
        const style = font.fontObject ? bridge.fontObjectStyle(font.fontObject) : undefined;
        const lineHeight = num(font.attributes["fontHeight"], style?.height ?? 14);
        return [lineHeight * self.text.split(/\r\n|\r|\n/).length];
      },
    };
  }

  private frameMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetScript: ({ frame, args }) => {
        const script = str(args[0]);
        const handler = args[1];
        if (handler instanceof GlueLuaRef && handler.type === "function") {
          const retained = this.#vm.retain(handler);
          bridge.SetScript(frame, script, this.wrapHandler(retained, script === "OnEvent", this.needsLegacyGlobals(retained)));
        } else {
          bridge.SetScript(frame, script, null);
        }
      },
      GetScript: ({ frame, args }) => {
        const handler = bridge.GetScript(frame, str(args[0]));
        const ref = handler ? this.#handlerSources.get(handler) : undefined;
        return ref ? [ref] : [];
      },
      HasScript: ({ frame, args }) => [bridge.hasScript(frame, str(args[0]))],
      HookScript: ({ frame, args }) => {
        const handler = args[1];
        if (handler instanceof GlueLuaRef && handler.type === "function") {
          const retained = this.#vm.retain(handler);
          bridge.HookScript(frame, str(args[0]), this.wrapHandler(retained, str(args[0]) === "OnEvent", this.needsLegacyGlobals(retained)));
        }
      },
      RegisterEvent: ({ frame, args }) => { bridge.RegisterEvent(frame, str(args[0])); },
      UnregisterEvent: ({ frame, args }) => { bridge.UnregisterEvent(frame, str(args[0])); },
      UnregisterAllEvents: ({ frame }) => { bridge.UnregisterAllEvents(frame); },
      IsEventRegistered: ({ self, args }) => [self.registeredEvents.has(str(args[0]))],
      CreateTexture: ({ frame, args }) => {
        const name = args[0] === undefined ? undefined : str(args[0]);
        return [bridge.createChild(frame, "Texture", name, str(args[1]) || undefined, args[2] === undefined ? undefined : str(args[2]))];
      },
      CreateFontString: ({ frame, args }) => {
        const name = args[0] === undefined ? undefined : str(args[0]);
        return [bridge.createChild(frame, "FontString", name, str(args[1]) || undefined, args[2] === undefined ? undefined : str(args[2]))];
      },
      SetBackdrop: ({ frame, args }) => {
        const table = args[0];
        if (table === undefined) {
          bridge.update(frame, (m) => { m.backdrop = undefined; });
          return;
        }
        // The Lua backdrop table is read field by field rather than converted
        // wholesale, so an addon table with extra keys cannot smuggle state in.
        const backdrop = table instanceof GlueLuaRef ? this.readBackdrop(table) : undefined;
        if (backdrop) bridge.update(frame, (m) => { m.backdrop = backdrop; });
      },
      /**
       * The whole backdrop table, not two of its fields.
       *
       * `AccountLogin.lua:86-95` reads one back and immediately does
       * `backdrop.insets.left = backdrop.insets.left - 2` on all four sides before handing it to
       * `SetBackdrop` again. With only `bgFile` and `edgeFile` coming back that is an index of nil,
       * and it took `AccountLogin_OnLoad` down — which took `LoginScreen_OnLoad` on the next line
       * with it, so the owner's entire login scene (background, logo, thirty models) never got
       * built. Measured: with the full table the same call completes and `LoginScene` exists.
       */
      GetBackdrop: ({ self }) => {
        const backdrop = self.backdrop;
        if (!backdrop) return [undefined];
        return [{
          bgFile: backdrop.bgFile ?? "",
          edgeFile: backdrop.edgeFile ?? "",
          tile: backdrop.tile,
          tileSize: backdrop.tileSize,
          edgeSize: backdrop.edgeSize,
          insets: { ...backdrop.insets },
        }];
      },
      SetBackdropColor: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.backdropColor = colorArgs(args); });
      },
      SetBackdropBorderColor: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.backdropBorderColor = colorArgs(args); });
      },
      SetFrameLevel: ({ frame, self, args }) => {
        const level = num(args[0]);
        if (self.frameLevel !== level) bridge.update(frame, (m) => { m.frameLevel = level; });
      },
      GetFrameLevel: ({ self }) => [self.frameLevel],
      SetFrameStrata: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.frameStrata = str(args[0]).toUpperCase() || m.frameStrata; });
      },
      GetFrameStrata: ({ self }) => [self.frameStrata],
      Raise: ({ frame }) => { bridge.update(frame, (m) => { m.frameLevel += 1; }); },
      Lower: ({ frame }) => { bridge.update(frame, (m) => { m.frameLevel = Math.max(0, m.frameLevel - 1); }); },
      EnableMouse: ({ frame, args }) => {
        bridge.update(frame, (m) => m.setAttribute("enableMouse", args[0] === false ? "false" : "true"));
      },
      EnableKeyboard: ({ frame, args }) => {
        bridge.update(frame, (m) => m.setAttribute("enableKeyboard", args[0] === false ? "false" : "true"));
      },
      EnableMouseWheel: ({ frame, args }) => {
        bridge.update(frame, (m) => m.setAttribute("enableMouseWheel", args[0] === false || args[0] === undefined ? "false" : "true"));
      },
      IsMouseWheelEnabled: ({ frame, self }) => {
        const enabled = self.attributes["enableMouseWheel"] ?? self.attributes["enablemousewheel"];
        return [enabled === undefined ? bridge.hasScript(frame, "OnMouseWheel") : /^(?:true|1)$/i.test(enabled)];
      },
      // Real rather than recorded: `toplevel` is what decides which screen is in front, and the
      // XML attribute of the same name is read alongside it. See `raiseToplevel`.
      SetToplevel: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.toplevel = args[0] !== false && args[0] !== undefined; });
      },
      IsToplevel: ({ self }) => [self.toplevel],
      SetClampedToScreen: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.clampedToScreen = args[0] !== false && args[0] !== undefined; });
      },
      IsClampedToScreen: ({ self }) => [self.clampedToScreen],
      SetMovable: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.movable = args[0] !== false && args[0] !== undefined;
          if (!m.movable) m.moving = false;
        });
      },
      IsMovable: ({ self }) => [self.movable],
      RegisterForDrag: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.dragRegistrations.clear();
          for (const button of args) if (typeof button === "string") m.dragRegistrations.add(button.toUpperCase());
        });
      },
      // (left, right, top, bottom): positive insets cut the clickable box in, negative ones grow it.
      // Paint only — nothing moves — and the renderer applies it to hit testing (`applyHitRect`).
      SetHitRectInsets: ({ frame, self, args }) => {
        const insets = { left: num(args[0]), right: num(args[1]), top: num(args[2]), bottom: num(args[3]) };
        const current = self.hitRectInsets;
        if (current && current.left === insets.left && current.right === insets.right
          && current.top === insets.top && current.bottom === insets.bottom) return;
        bridge.update(frame, (m) => { m.hitRectInsets = insets; }, "paint");
      },
      GetHitRectInsets: ({ self }) => {
        const insets = self.hitRectInsets;
        return [insets?.left ?? 0, insets?.right ?? 0, insets?.top ?? 0, insets?.bottom ?? 0];
      },
      // Flags the client keeps on the frame and the stock code reads back: a chat window the
      // player dragged stays put (`FCF_RestorePositionAndDimensions` and
      // `UIParent_ManageFramePositions` ask `IsUserPlaced`), a resizable one offers its grip.
      // Paint-only writes: nothing on the screen moves when a flag flips.
      SetUserPlaced: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.setAttribute("userPlaced", luaTruthy(args[0]) ? "true" : "false"); }, "paint");
      },
      IsUserPlaced: ({ self }) => [self.attributes["userPlaced"] === "true"],
      SetResizable: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.setAttribute("resizable", luaTruthy(args[0]) ? "true" : "false"); }, "paint");
      },
      IsResizable: ({ self }) => [self.attributes["resizable"] === "true"],
      SetClampRectInsets: ({ frame, args }) => {
        const insets = [num(args[0]), num(args[1]), num(args[2]), num(args[3])].join(" ");
        bridge.update(frame, (m) => { m.setAttribute("clampRectInsets", insets); }, "paint");
      },
      GetClampRectInsets: ({ self }) => {
        const insets = (self.attributes["clampRectInsets"] ?? "").split(" ").map(Number);
        return insets.length === 4 && insets.every(Number.isFinite) ? insets : [0, 0, 0, 0];
      },
      StartMoving: ({ frame, self }) => {
        if (self.movable && bridge.isVisible(frame)) bridge.update(frame, (m) => { m.moving = true; });
      },
      StopMovingOrSizing: ({ frame }) => { bridge.update(frame, (m) => { m.moving = false; }); },
      GetChildren: ({ self }) => self.children.filter((child) => child.type !== "Texture" && child.type !== "FontString"),
      GetNumChildren: ({ self }) => [self.children.filter((child) => child.type !== "Texture" && child.type !== "FontString").length],
      GetRegions: ({ self }) => self.children.filter((child) => child.type === "Texture" || child.type === "FontString"),
      GetNumRegions: ({ self }) => [self.children.filter((child) => child.type === "Texture" || child.type === "FontString").length],
    };
  }

  /**
   * `SetNormalTexture` and its siblings, for a state name: a filename or a `CreateTexture()` handle
   * becomes the button's region for that state. Shared with CheckButton's CHECKED and
   * DISABLEDCHECKED, which the stock code sets on its action buttons and its tabs.
   */
  private stateTextureSetter(state: string): WidgetMethod {
    const bridge = this.#bridge;
    return ({ frame, self, args }) => {
      // Lua SetHighlightTexture uses ADD unless its optional blend mode overrides it, for both
      // filenames and CreateTexture handles. StoreStyle's opaque highlight atlas relies on this.
      const highlightBlend = state === "HIGHLIGHT" ? str(args[1]).toUpperCase() || "ADD" : undefined;
      const handle = textureHandle(args[0], bridge);
      if (handle) {
        const existing = self.stateTextures.get(state);
        if (existing && existing !== handle) {
          bridge.update(existing, (m) => {
            if (m.stateTexture !== state) return;
            m.stateTexture = "";
            m.texture = "";
            m.vertexColor = undefined;
            m.colorFill = false;
          });
        }
        // A CreateTexture() handle normally already has this parent. Reparenting the valid handle
        // keeps the state texture in the button's rendered child tree without creating a duplicate.
        if (handle.parent !== frame && !bridge.SetParent(handle, frame)) return;
        bridge.update(handle, (m) => {
          m.stateTexture = state;
          m.drawLayer = state === "HIGHLIGHT" ? "HIGHLIGHT" : "ARTWORK";
          if (highlightBlend) m.alphaMode = highlightBlend;
        });
        bridge.update(frame, (m) => { m.stateTextures.set(state, handle); });
        return;
      }
      const texture = textureReference(args[0]);
      if (texture === undefined) return;
      const existing = self.stateTextures.get(state);
      if (existing) {
        bridge.SetTexture(existing, texture);
        if (highlightBlend) bridge.update(existing, (m) => { m.alphaMode = highlightBlend; });
        return;
      }
      const created = bridge.createChild(frame, "Texture", undefined, state === "HIGHLIGHT" ? "HIGHLIGHT" : "ARTWORK");
      if (!created) return;
      // Filename setters create a button-sized state region, just like an unanchored
      // <NormalTexture> declaration. Stock microbuttons create all their art through this path.
      // Only the new region gets defaults: replacing a filename or adopting a Texture handle
      // must retain the geometry the caller already authored.
      bridge.SetAllPoints(created, frame);
      bridge.SetTexture(created, texture);
      // The same mark `<NormalTexture>` gets from XML: without it a picture a script hangs on a
      // button would be drawn in every state, which is the defect this pair of lines closes on the
      // XML side. See `FrameXmlFrame.stateTexture`.
      bridge.update(created, (m) => {
        m.stateTexture = state;
        if (highlightBlend) m.alphaMode = highlightBlend;
      });
      bridge.update(frame, (m) => { m.stateTextures.set(state, created); });
    };
  }

  private buttonMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    const setStateTexture = (state: string): WidgetMethod => this.stateTextureSetter(state);
    // A label that takes its font from the button follows the enabled state and the font setters.
    const setEnabled = (frame: FrameXmlFrame, enabled: boolean): void => {
      bridge.runInMutationBatch(() => {
        if (frame.enabled !== enabled) bridge.update(frame, (m) => { m.enabled = enabled; });
        bridge.syncButtonLabelFont(frame);
      });
    };
    const setStateFont = (state: string): WidgetMethod => ({ frame, args }) => {
      bridge.runInMutationBatch(() => {
        bridge.update(frame, (m) => {
          m.stateFonts.set(state, str(args[0]));
          if (state === "NORMAL") m.fontObject = str(args[0]);
        });
        bridge.syncButtonLabelFont(frame);
      });
    };
    return {
      Enable: ({ frame }) => { setEnabled(frame, true); },
      Disable: ({ frame }) => { setEnabled(frame, false); },
      /**
       * 1 or 0, which is what 3.3.5 answers and what its own code compares against in both
       * directions — measured over the dataset's luaxml: `== 1` / `~= 1` on 14 lines
       * (`UIPanelButtonTemplate`'s press art, the micro-button tooltips, StaticPopup, LFD, LootFrame,
       * glue CharacterCreate/CharacterSelect) and `== 0` / `~= 0` on 10 more
       * (`MainMenuBarMicroButtons.xml:16` «available at level N», `:246/:257` the PvP button's own
       * press handling, Mail/Macro/GearManager Enter-to-accept, ChannelFrame, FriendsFrame,
       * TutorialFrame). A boolean satisfied neither, and nil would break every `0` site. Only the four
       * truthiness tests (both `OptionsPanelTemplates.xml`, `VehicleMenuBar.lua:1006`,
       * `TradeFrame.lua:17`) read 0 as true, as they do in the client.
       */
      IsEnabled: ({ self }) => [self.enabled ? 1 : 0],
      Click: ({ frame, args }) => { bridge.Click(frame, str(args[0]) || "LeftButton", args[1] === true); },
      SetNormalTexture: setStateTexture("NORMAL"),
      SetPushedTexture: setStateTexture("PUSHED"),
      SetHighlightTexture: setStateTexture("HIGHLIGHT"),
      SetDisabledTexture: setStateTexture("DISABLED"),
      GetNormalTexture: ({ self }) => [self.stateTextures.get("NORMAL")],
      GetPushedTexture: ({ self }) => [self.stateTextures.get("PUSHED")],
      GetHighlightTexture: ({ self }) => [self.stateTextures.get("HIGHLIGHT")],
      GetDisabledTexture: ({ self }) => [self.stateTextures.get("DISABLED")],
      GetFontString: ({ self }) => [self.stateTextures.get("BUTTONTEXT")],
      LockHighlight: ({ frame }) => { bridge.update(frame, (m) => { m.highlightLocked = true; }); },
      UnlockHighlight: ({ frame }) => { bridge.update(frame, (m) => { m.highlightLocked = false; }); },
      GetButtonState: ({ self }) => [self.buttonState],
      SetButtonState: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.buttonState = str(args[0]).toUpperCase() || "NORMAL"; });
      },
      SetNormalFontObject: setStateFont("NORMAL"),
      SetHighlightFontObject: setStateFont("HIGHLIGHT"),
      // `PanelTemplates_SelectTab` (`UIPanelTemplates.lua:133`) makes the selected, disabled tab white.
      SetDisabledFontObject: setStateFont("DISABLED"),
      SetDisabledTextColor: this.stub("SetDisabledTextColor"),
      SetHighlightTextColor: this.stub("SetHighlightTextColor"),
      // Which press/release pairs raise OnClick. Empty means 3.3.5's default of LeftButtonUp;
      // the rotation arrows on character select arm the Down half so they can spin while held.
      RegisterForClicks: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.clickRegistrations.clear();
          for (const value of args) {
            const name = str(value).trim().toUpperCase();
            if (name) m.clickRegistrations.add(name);
          }
        });
      },
      SetPushedTextOffset: this.stub("SetPushedTextOffset"),
      SetMotionScriptsWhileDisabled: this.stub("SetMotionScriptsWhileDisabled"),
    };
  }

  private checkButtonMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetChecked: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.checked = args[0] !== false && args[0] !== undefined && args[0] !== 0; });
      },
      GetChecked: ({ self }) => [self.checked ? 1 : undefined],
      SetCheckedTexture: this.stateTextureSetter("CHECKED"),
      SetDisabledCheckedTexture: this.stateTextureSetter("DISABLEDCHECKED"),
      GetCheckedTexture: ({ self }) => [self.stateTextures.get("CHECKED")],
      GetDisabledCheckedTexture: ({ self }) => [self.stateTextures.get("DISABLEDCHECKED")],
    };
  }

  private editBoxMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetFocus: ({ frame }) => { bridge.SetFocus(frame); },
      ClearFocus: ({ frame }) => { bridge.ClearFocus(frame); },
      HasFocus: ({ self }) => [self.editBox.focused],
      // Browser text input uses the OS keyboard directly; the WoW client IME
      // modes are not selectable here. Stock ChatFrame.lua concatenates
      // `INPUT_` with this value, and GlobalStrings.lua defines INPUT_ROMAN.
      GetInputLanguage: () => ["ROMAN"],
      HighlightText: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.editBox.highlightStart = args[0] === undefined ? 0 : num(args[0]);
          m.editBox.highlightEnd = args[1] === undefined ? m.text.length : num(args[1]);
          m.editBox.selectionRevision++;
        });
      },
      Insert: ({ frame, args }) => { bridge.InsertText(frame, str(args[0])); },
      SetMaxLetters: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.letters = num(args[0]); }); },
      SetMaxBytes: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.letters = num(args[0]); }); },
      GetNumber: ({ self }) => [num(self.text)],
      SetNumber: ({ frame, args }) => { bridge.SetText(frame, String(num(args[0]))); },
      SetNumeric: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.numeric = args[0] !== false; }); },
      SetPassword: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.password = args[0] !== false; }); },
      // Whether the box takes the keyboard when shown (see `FrameXmlUiBridge.autoFocus`); nothing
      // drawn changes. The argument is a Lua boolean, so only false and nil turn it off.
      SetAutoFocus: ({ self, args }) => {
        self.editBox.autoFocus = args[0] !== false && args[0] !== undefined && args[0] !== null;
      },
      IsAutoFocus: ({ self }) => [self.editBox.autoFocus ? 1 : undefined],
      SetCursorPosition: ({ frame, args }) => { bridge.SetCursorPosition(frame, num(args[0])); },
      GetCursorPosition: ({ frame }) => [bridge.GetCursorPosition(frame)],
      GetUTF8CursorPosition: ({ frame }) => [bridge.GetCursorPosition(frame)],
      /**
       * (left, right, top, bottom): the padding the typed text sits inside, which is what
       * `<TextInsets>` declares and the renderer draws as the input's padding. `ChatEdit_UpdateHeader`
       * ends with `SetTextInsets(15 + header:GetWidth(), 13, 0, 0)` (ChatFrame.lua:3627) to start the
       * text after «Сказать:»; as a recorded stub the text sat over the header.
       */
      SetTextInsets: ({ frame, self, args }) => {
        const insets = { left: num(args[0]), right: num(args[1]), top: num(args[2]), bottom: num(args[3]) };
        const current = self.textInsets;
        if (current && current.left === insets.left && current.right === insets.right
          && current.top === insets.top && current.bottom === insets.bottom) return;
        bridge.update(frame, (m) => { m.textInsets = insets; });
      },
      GetTextInsets: ({ self }) => {
        const insets = self.textInsets;
        return [insets?.left ?? 0, insets?.right ?? 0, insets?.top ?? 0, insets?.bottom ?? 0];
      },
      AddHistoryLine: ({ frame, args }) => {
        const value = str(args[0]);
        bridge.update(frame, (m) => {
          const limit = Math.max(0, Math.trunc(m.editBox.historyLines));
          if (limit === 0) return;
          m.editBox.history.push(value);
          if (m.editBox.history.length > limit) m.editBox.history.splice(0, m.editBox.history.length - limit);
          m.editBox.historyIndex = -1;
        });
      },
      ClearHistory: ({ frame }) => {
        bridge.update(frame, (m) => { m.editBox.history.length = 0; m.editBox.historyIndex = -1; });
      },
      ClearHistoryLines: ({ frame }) => {
        bridge.update(frame, (m) => { m.editBox.history.length = 0; m.editBox.historyIndex = -1; });
      },
      SetAltArrowKeyMode: this.stub("SetAltArrowKeyMode"),
    };
  }

  private messageMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      AddMessage: ({ frame, args }) => {
        bridge.AddMessage(frame, args[0], num(args[1], 1), num(args[2], 1), num(args[3], 1),
          args[4], args[5], args[6], args[7]);
      },
      Clear: ({ frame }) => { bridge.ClearMessageFrame(frame); },
      GetNumMessages: ({ frame, args }) => [bridge.GetNumMessages(frame, args[0])],
      GetMessageInfo: ({ frame, args }) => bridge.GetMessageInfo(frame, num(args[0], 1), args[1]),
      RemoveMessagesByAccessID: ({ frame, args }) => { bridge.RemoveMessagesByAccessID(frame, args[0]); },
      AtBottom: ({ frame }) => [bridge.AtBottom(frame)],
      SetVerticalScroll: ({ frame, args }) => { bridge.SetVerticalScroll(frame, num(args[0])); },
      GetVerticalScroll: ({ frame }) => [bridge.GetVerticalScroll(frame)],
      GetVerticalScrollRange: ({ frame }) => [bridge.GetVerticalScrollRange(frame)],
      ScrollUp: ({ frame }) => { bridge.ScrollUp(frame); },
      ScrollDown: ({ frame }) => { bridge.ScrollDown(frame); },
      PageUp: ({ frame }) => { bridge.PageUp(frame); },
      PageDown: ({ frame }) => { bridge.PageDown(frame); },
      ScrollToBottom: ({ frame }) => { bridge.ScrollToBottom(frame); },
      SetMaxLines: ({ frame, args }) => { bridge.SetMaxLines(frame, num(args[0])); },
      GetMaxLines: ({ frame }) => [bridge.GetMaxLines(frame)],
      SetTimeVisible: ({ frame, args }) => { bridge.SetTimeVisible(frame, num(args[0])); },
      GetTimeVisible: ({ frame }) => [bridge.GetTimeVisible(frame)],
      SetHyperlinksEnabled: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.setAttribute("hyperlinksEnabled", luaTruthy(args[0]) ? "true" : "false"); }, "paint");
      },
      GetHyperlinksEnabled: ({ self }) => [self.attributes["hyperlinksEnabled"] !== "false"],
    };
  }

  private valueMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      /**
       * Clamp, then fire OnValueChanged only on an actual change.
       *
       * This is not an optimisation, it is the semantic: a scroll frame and its
       * scroll bar drive each other (`OnValueChanged` -> `SetVerticalScroll`
       * -> `OnVerticalScroll` -> `SetValue`), and RealmList.xml wires exactly
       * that pair. Firing unconditionally makes the two bounce forever the
       * moment RealmList is instantiated — measured, by hanging.
       */
      SetValue: ({ frame, args }) => { bridge.SetValue(frame, num(args[0])); },
      GetValue: ({ self }) => [self.type === "StatusBar" ? self.statusBar.value : self.slider.value],
      SetMinMaxValues: ({ frame, args }) => {
        bridge.runInMutationBatch(() => {
          const current = frame.type === "StatusBar" ? frame.statusBar : frame.slider;
          const min = num(args[0]);
          const max = Math.max(min, num(args[1]));
          if (current.min !== min || current.max !== max) {
            bridge.update(frame, (m) => {
              const state = m.type === "StatusBar" ? m.statusBar : m.slider;
              state.min = min;
              state.max = max;
            }, frame.type === "StatusBar" ? "paint" : "layout");
          }
          const state = frame.type === "StatusBar" ? frame.statusBar : frame.slider;
          bridge.SetValue(frame, state.value);
        });
      },
      GetMinMaxValues: ({ self }) => {
        const state = self.type === "StatusBar" ? self.statusBar : self.slider;
        return [state.min, state.max];
      },
    };
  }

  private sliderMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetValueStep: ({ frame, args }) => { bridge.update(frame, (m) => { m.slider.valueStep = num(args[0]); }); },
      GetValueStep: ({ self }) => [self.slider.valueStep],
      SetOrientation: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.slider.orientation = str(args[0]).toUpperCase() || m.slider.orientation; });
      },
      GetOrientation: ({ self }) => [self.slider.orientation],
      SetThumbTexture: this.stub("SetThumbTexture"),
      GetThumbTexture: ({ self }) => [self.stateTextures.get("THUMB")],
      Enable: ({ frame }) => { bridge.update(frame, (m) => { m.enabled = true; }); },
      Disable: ({ frame }) => { bridge.update(frame, (m) => { m.enabled = false; }); },
      // 1 or 0, as `Button:IsEnabled` — see there.
      IsEnabled: ({ self }) => [self.enabled ? 1 : 0],
    };
  }

  private statusBarMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetStatusBarTexture: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.statusBar.texture = str(args[0]); });
      },
      SetStatusBarColor: ({ frame, self, args }) => {
        const color = colorArgs(args);
        if (!sameColor(self.statusBar.color, color)) bridge.update(frame, (m) => { m.statusBar.color = color; }, "paint");
      },
      GetStatusBarTexture: ({ self }) => [self.statusBar.texture || undefined],
      SetOrientation: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.statusBar.orientation = str(args[0]).toUpperCase() || m.statusBar.orientation;
        });
      },
      GetOrientation: ({ self }) => [self.statusBar.orientation],
    };
  }

  private scrollMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      // Same change-guard as the slider, and for the same measured reason: the
      // scroll frame and its bar drive each other.
      SetVerticalScroll: ({ frame, self, args }) => {
        const offset = num(args[0]);
        if (offset === self.scroll.verticalScroll) return;
        bridge.update(frame, (m) => { m.scroll.verticalScroll = offset; });
        bridge.fireScript(frame, "OnVerticalScroll", offset);
      },
      GetVerticalScroll: ({ self }) => [self.scroll.verticalScroll],
      GetVerticalScrollRange: ({ self }) => [self.scroll.verticalScrollRange],
      SetHorizontalScroll: ({ frame, self, args }) => {
        const offset = num(args[0]);
        if (offset === self.scroll.horizontalScroll) return;
        bridge.update(frame, (m) => { m.scroll.horizontalScroll = offset; });
        bridge.fireScript(frame, "OnHorizontalScroll", offset);
      },
      GetHorizontalScroll: ({ self }) => [self.scroll.horizontalScroll],
      GetHorizontalScrollRange: ({ self }) => [self.scroll.horizontalScrollRange],
      UpdateScrollChildRect: ({ frame }) => { bridge.update(frame, () => {}); },
      SetScrollChild: ({ frame, args }) => {
        const child = args[0] === undefined ? undefined : bridge.resolve(args[0] as FrameXmlFrame);
        if (args[0] === undefined || child) bridge.SetScrollChild(frame, child);
      },
      GetScrollChild: ({ self }) => [self.scroll.child],
    };
  }

  private modelMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    const record = (method: string): WidgetMethod => ({ frame, args }) => {
      this.recordStubCall(method, frame.type, frame);
      bridge.update(frame, (m) => { pushModelCall(m, method, args); });
    };
    return {
      SetModel: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.file = str(args[0]);
          m.model.creatureEntry = undefined;
          m.model.displayId = undefined;
          pushModelCall(m, "SetModel", args);
        });
      },
      SetCreature: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.file = "";
          m.model.creatureEntry = Math.max(0, Math.trunc(num(args[0])));
          m.model.displayId = undefined;
          pushModelCall(m, "SetCreature", args);
        });
      },
      SetDisplayInfo: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.file = "";
          m.model.creatureEntry = undefined;
          m.model.displayId = Math.max(0, Math.trunc(num(args[0])));
          pushModelCall(m, "SetDisplayInfo", args);
        });
      },
      ClearModel: ({ frame }) => {
        bridge.update(frame, (m) => {
          m.model.file = "";
          m.model.creatureEntry = undefined;
          m.model.displayId = undefined;
          pushModelCall(m, "ClearModel", []);
        });
      },
      SetCamera: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.camera = num(args[0]);
          pushModelCall(m, "SetCamera", args);
        });
      },
      SetSequence: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.sequence = num(args[0]);
          pushModelCall(m, "SetSequence", args);
        });
      },
      SetSequenceTime: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.sequenceTime = num(args[1]);
          pushModelCall(m, "SetSequenceTime", args);
        });
      },
      SetFacing: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.facing = num(args[0]);
          pushModelCall(m, "SetFacing", args);
        });
      },
      GetFacing: ({ self }) => [self.model.facing ?? 0],
      SetPosition: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.position = [num(args[0]), num(args[1]), num(args[2])];
          pushModelCall(m, "SetPosition", args);
        });
      },
      GetPosition: ({ self }) => [...(self.model.position ?? [0, 0, 0])],
      SetModelScale: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.model.modelScale = num(args[0], 1);
          pushModelCall(m, "SetModelScale", args);
        });
      },
      GetModelScale: ({ self }) => [self.model.modelScale ?? self.model.scale],
      SetFogColor: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.model.fogColor = colorArgs(args); });
      },
      SetFogNear: ({ frame, args }) => { bridge.update(frame, (m) => { m.model.fogNear = num(args[0]); }); },
      SetFogFar: ({ frame, args }) => { bridge.update(frame, (m) => { m.model.fogFar = num(args[0]); }); },
      ClearFog: ({ frame }) => {
        bridge.update(frame, (m) => { m.model.fogNear = undefined; m.model.fogFar = undefined; });
      },
      SetGlow: ({ frame, args }) => { bridge.update(frame, (m) => { m.model.glow = num(args[0]); }); },
      // Thirteen numbers that are exactly one ambient light and one directional light. The owner's
      // login screen drives every one of its thirty models through this, so it is read rather than
      // recorded; `GlueModelStage.glueModelLight` turns the list into the two lights.
      SetLight: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.model.light = args.map((value) => num(value)); });
      },
      ResetLights: ({ frame }) => {
        bridge.update(frame, (m) => { m.model.light = undefined; m.model.lights = undefined; });
      },
      /**
       * `AddLight(set, enabled, omni, dirX, dirY, dirZ, ambI, ambR, ambG, ambB, difI, difR, difG,
       * difB)` — the same thirteen numbers as `SetLight` behind a light-set index.
       *
       * This is how the stock character screens are lit, and until now it was recorded and dropped:
       * `GlueParent.lua`'s `SetLighting` calls `ResetLights()` and then adds `RaceLights[race]`,
       * which is three lights for a human and one for a night elf. With them gone the stage lit
       * every backdrop with a constant nobody measured.
       *
       * Only the background set is collected, and only `LIGHT_LIVE`. `SetLighting` hands the *same*
       * array to `AddCharacterLight`, `AddLight` and `AddPetLight` in one loop
       * (`GlueParent.lua:367`), so taking all three would count every light three times; and this
       * stage stands the character inside the backdrop's own scene, where the background set
       * already reaches it. `LIGHT_GHOST` (1) is the dead player's set and no glue screen shows one.
       */
      AddLight: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          pushModelCall(m, "AddLight", args);
          if (num(args[0], 0) !== 0) return;
          const values = args.slice(1).map((value) => num(value));
          if (values.length < 13) return;
          m.model.lights = [...(m.model.lights ?? []), values];
        });
      },
      AddCharacterLight: record("AddCharacterLight"),
      AddPetLight: record("AddPetLight"),
      AdvanceTime: record("AdvanceTime"),
      SetCustomCamera: record("SetCustomCamera"),
      ReplaceIconTexture: record("ReplaceIconTexture"),
      SetRotation: record("SetRotation"),
    };
  }

  private simpleHtmlMethods(): Record<string, WidgetMethod> {
    return {
      SetHyperlinkFormat: this.stub("SetHyperlinkFormat"),
      GetContentHeight: ({ self }) => [num(self.attributes["height"])],
    };
  }

  private movieMethods(): Record<string, WidgetMethod> {
    return {
      StartMovie: this.stub("StartMovie"),
      StopMovie: this.stub("StopMovie"),
      EnableSubtitles: this.stub("EnableSubtitles"),
      GetMovieResolution: () => [1024, 768],
    };
  }

  /** Read the six backdrop fields the corpus sets, and nothing else. */
  private readBackdrop(table: GlueLuaRef): MutableFrameXmlFrame["backdrop"] {
    const L = this.#vm.state;
    const top = lua.lua_gettop(L);
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, table.key);
    const field = (name: string): unknown => {
      lua.lua_getfield(L, -1, to_luastring(name));
      const value = this.#vm.toValue(-1);
      lua.lua_pop(L, 1);
      return value;
    };
    /** One member of the nested `insets` table, read the same field-by-field way. */
    const inset = (name: string): number => {
      lua.lua_getfield(L, -1, to_luastring("insets"));
      let value = 0;
      if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
        lua.lua_getfield(L, -1, to_luastring(name));
        value = num(this.#vm.toValue(-1));
        lua.lua_pop(L, 1);
      }
      lua.lua_pop(L, 1);
      return value;
    };
    const bgFile = field("bgFile");
    const edgeFile = field("edgeFile");
    const backdrop = {
      ...(typeof bgFile === "string" ? { bgFile } : {}),
      ...(typeof edgeFile === "string" ? { edgeFile } : {}),
      tile: field("tile") === true,
      tileSize: num(field("tileSize")),
      edgeSize: num(field("edgeSize")),
      // Read rather than zeroed: the corpus' only `SetBackdrop` call site is the one that has just
      // adjusted these four numbers, so dropping them would make the round trip a no-op.
      insets: {
        left: inset("left"), right: inset("right"), top: inset("top"), bottom: inset("bottom"),
      },
    };
    lua.lua_settop(L, top);
    return backdrop;
  }

  /** Format through the VM so SetFormattedText obeys the same 5.1 shim. */
  private formatThroughLua(format: string, args: readonly unknown[]): string {
    const ref = this.#vm.globalFunction("format");
    if (!ref) return format;
    const [result] = this.#vm.call(ref, [format, ...args], 1);
    this.#vm.release(ref);
    return typeof result === "string" ? result : format;
  }
}
