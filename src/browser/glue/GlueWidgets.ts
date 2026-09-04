import { lauxlib, lua, to_luastring, type LuaState } from "fengari";
import { GlueLuaRef, type GlueLuaVm } from "./GlueLua.js";
import type { FrameXmlUiBridge, MutableFrameXmlFrame } from "../ui/framexml_compat/FrameXmlRuntime.js";
import {
  type FrameXmlColor,
  type FrameXmlFrame,
  type FrameXmlScriptCompileRequest,
  type FrameXmlScriptHandler,
  type LuaAddonRuntime,
  type LuaScriptContext,
} from "../ui/framexml_compat/FrameXmlTypes.js";
import type { TooltipContent } from "../ui/Widgets.js";

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
 * when the inner one returns.
 */
const GLUE_INVOKE = `
local _saved = {}
function __glueInvoke(fn, self, isEvent, ...)
  local depth = #_saved + 1
  _saved[depth] = { this, event, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 }
  this = self
  if isEvent then
    event = ...
    arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 = select(2, ...)
  else
    arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 = ...
  end
  local ok, err = pcall(fn, self, ...)
  local previous = _saved[depth]
  _saved[depth] = nil
  this, event = previous[1], previous[2]
  arg1, arg2, arg3 = previous[3], previous[4], previous[5]
  arg4, arg5, arg6 = previous[6], previous[7], previous[8]
  arg7, arg8, arg9 = previous[9], previous[10], previous[11]
  if not ok then geterrorhandler()(err) end
end
`;

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

// GameTooltip's XML template supplies lines and backdrop but no usable Size in this renderer.
// Keep the C-method adapter bounded: enough room for the longest visible line, a small padding,
// and no untrusted payload can grow the root without limit.
const GAME_TOOLTIP_CHAR_WIDTH = 7;
const GAME_TOOLTIP_LINE_HEIGHT = 14;
const GAME_TOOLTIP_HORIZONTAL_PADDING = 24;
const GAME_TOOLTIP_VERTICAL_PADDING = 16;
const GAME_TOOLTIP_MIN_WIDTH = 32;
const GAME_TOOLTIP_MIN_HEIGHT = 20;
const GAME_TOOLTIP_MAX_WIDTH = 640;
const GAME_TOOLTIP_MAX_LINES = 64;

interface MinimapWidgetState {
  zoom: number;
  zoomLevels: number;
}

/** State kept by the bounded GameTooltip C-method surface. */
interface GameTooltipWidgetState {
  owner: FrameXmlFrame | undefined;
  anchor: string;
  nextLine: number;
}

/** Item-specific data supplied by the world owner; the binder keeps the common API surface. */
export interface GameTooltipWidgetAdapter {
  readonly inventoryItem: (unit: string, slot: number) => TooltipContent | undefined;
  readonly containerItem: (bag: number, slot: number) => TooltipContent | undefined;
  /** Bounded action-slot content; the callback receives the stock 1-based slot, never a spell id. */
  readonly action?: (slot: number) => TooltipContent | undefined;
}

function boundedMinimapNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MINIMAP_NUMERIC_LIMIT ? parsed : undefined;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
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

function colorArgs(args: readonly unknown[], from = 0): FrameXmlColor {
  return {
    r: num(args[from], 1), g: num(args[from + 1], 1), b: num(args[from + 2], 1),
    a: args[from + 3] === undefined ? 1 : num(args[from + 3], 1),
  };
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
  readonly #stubbed = new Set<string>();
  #invoke: GlueLuaRef | undefined;
  #nextId = 0;

  constructor(vm: GlueLuaVm, bridge: FrameXmlUiBridge, options: GlueWidgetBinderOptions = {}) {
    this.#vm = vm;
    this.#bridge = bridge;
    this.#options = options;
    const installed = vm.execute(GLUE_INVOKE, "@GlueWidgets:invoke");
    if (!installed.ok) throw new Error(`glue dispatch helper failed to load: ${installed.error}`);
    this.#invoke = vm.globalFunction("__glueInvoke");
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

  /** The `LuaAddonRuntime.execute` fallback is unused: every body is compiled. */
  execute(source: string, context: LuaScriptContext): void {
    this.#vm.executeReported(source, `@${context.frame.name}:inline`);
  }

  compileScript(request: FrameXmlScriptCompileRequest): FrameXmlScriptHandler | undefined {
    const ref = this.#vm.compileFunction(request.source, request.chunkName, request.parameters);
    if (!ref) return undefined;
    return this.wrapHandler(ref, request.script === "OnEvent");
  }

  resolveGlobalHandler(name: string): FrameXmlScriptHandler | undefined {
    const ref = this.#vm.globalFunction(name);
    if (!ref) return undefined;
    return this.wrapHandler(ref, false);
  }

  bindFrame(frame: FrameXmlFrame): void {
    if (this.#refs.has(frame)) return;
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
    // `parentKey="Border"` publishes the child on its parent as `parent.Border`.
    if (frame.parentKey && frame.parent) this.setParentKey(frame.parent, frame.parentKey, frame);
  }

  releaseFrame(frame: FrameXmlFrame): void {
    const ref = this.#refs.get(frame);
    if (!ref) return;
    this.#vm.release(ref);
    this.#refs.delete(frame);
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

  private clearParentKey(parent: FrameXmlFrame, key: string, child: FrameXmlFrame): void {
    const parentRef = this.#refs.get(parent);
    const childRef = this.#refs.get(child);
    if (!parentRef || !childRef) return;
    const L = this.#vm.state;
    const top = lua.lua_gettop(L);
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, parentRef.key);
    const parentIndex = lua.lua_gettop(L);
    lua.lua_getfield(L, parentIndex, to_luastring(key));
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, childRef.key);
    if (lua.lua_compare(L, -1, -2, lua.LUA_OPEQ)) {
      lua.lua_pushnil(L);
      lua.lua_setfield(L, parentIndex, to_luastring(key));
    }
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
  private wrapHandler(ref: GlueLuaRef, isEvent: boolean): FrameXmlScriptHandler {
    const handler: FrameXmlScriptHandler = (self, ...args) => {
      if (!this.#invoke) return;
      this.#vm.call(this.#invoke, [ref, self, isEvent, ...args], 0);
    };
    this.#handlerSources.set(handler, ref);
    return handler;
  }

  private stub(method: string): WidgetMethod {
    return () => {
      if (!this.#stubbed.has(method)) {
        this.#stubbed.add(method);
        this.#options.onStub?.(method);
      }
    };
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
      state = { owner: undefined, anchor: "ANCHOR_RIGHT", nextLine: 1 };
      this.#gameTooltipState.set(frame, state);
    }
    return state;
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

  private clearGameTooltipLines(frame: FrameXmlFrame): void {
    const state = this.gameTooltipState(frame);
    for (let index = 1; index <= GAME_TOOLTIP_MAX_LINES; index += 1) {
      for (const side of ["Left", "Right"] as const) {
        const line = this.gameTooltipLine(frame, side, index);
        if (!line) continue;
        this.#bridge.SetText(line, "");
        this.#bridge.Hide(line);
      }
    }
    state.nextLine = 1;
    this.#bridge.fireScript(frame, "OnTooltipCleared");
  }

  private setGameTooltipLine(
    frame: FrameXmlFrame,
    text: string,
    side: "Left" | "Right" = "Left",
    color?: FrameXmlColor,
    wrap = false,
  ): boolean {
    const state = this.gameTooltipState(frame);
    const line = this.gameTooltipLine(frame, side, state.nextLine, true);
    if (!line) return false;
    this.#bridge.update(line, (mutable) => {
      mutable.textColor = color;
      mutable.setAttribute("wordWrap", String(wrap));
    });
    this.#bridge.SetText(line, text);
    this.#bridge.Show(line);
    state.nextLine += 1;
    return true;
  }

  private setGameTooltipContent(frame: FrameXmlFrame, content: TooltipContent): boolean {
    this.clearGameTooltipLines(frame);
    if (!this.setGameTooltipLine(frame, content.title)) return false;
    for (const line of content.lines ?? []) {
      const text = typeof line === "string" ? line : line.text;
      if (text.length > 0) this.setGameTooltipLine(frame, text);
    }
    for (const line of content.footer ?? []) {
      if (line.length > 0) this.setGameTooltipLine(frame, line);
    }
    this.sizeGameTooltip(frame);
    this.#bridge.Show(frame);
    return true;
  }

  /** Size the authored root from the visible text lines, with deterministic bounded estimates. */
  private sizeGameTooltip(frame: FrameXmlFrame): void {
    let lines = 0;
    let longest = 0;
    for (let index = 1; index <= GAME_TOOLTIP_MAX_LINES; index += 1) {
      for (const side of ["Left", "Right"] as const) {
        const line = this.gameTooltipLine(frame, side, index);
        if (!line?.visible || line.text.length === 0) continue;
        lines += 1;
        longest = Math.max(longest, [...line.text].length);
      }
    }
    const width = Math.max(
      GAME_TOOLTIP_MIN_WIDTH,
      Math.min(GAME_TOOLTIP_MAX_WIDTH, longest * GAME_TOOLTIP_CHAR_WIDTH
        + GAME_TOOLTIP_HORIZONTAL_PADDING),
    );
    const height = Math.max(
      GAME_TOOLTIP_MIN_HEIGHT,
      lines * GAME_TOOLTIP_LINE_HEIGHT + GAME_TOOLTIP_VERTICAL_PADDING,
    );
    this.#bridge.update(frame, (mutable) => {
      mutable.setAttribute("width", String(width));
      mutable.setAttribute("height", String(height));
    });
  }

  /** Reject an unsupported/empty payload without leaving the previous tooltip visible. */
  private hideGameTooltip(frame: FrameXmlFrame): void {
    this.clearGameTooltipLines(frame);
    this.sizeGameTooltip(frame);
    this.#bridge.Hide(frame);
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
    return {
      SetOwner: ({ frame, args }) => {
        const requested = args[0];
        const owner = requested === undefined || requested === null
          ? undefined : bridge.resolve(requested as FrameXmlFrame);
        if (requested !== undefined && requested !== null && !owner) return;
        const anchor = typeof args[1] === "string" ? args[1].trim().toUpperCase() : "ANCHOR_RIGHT";
        const state = this.gameTooltipState(frame);
        state.owner = owner;
        state.anchor = anchor;
        bridge.update(frame, (mutable) => {
          mutable.tooltipCursorAnchor = owner && anchor === "ANCHOR_CURSOR"
            ? { x: num(args[2]), y: num(args[3]) } : undefined;
          mutable.clampedToScreen = true;
        });
        if (owner === undefined) return;
        bridge.ClearAllPoints(frame);
        // ANCHOR_NONE deliberately leaves geometry to the caller (the stock default-anchor helper
        // immediately calls SetPoint); the four common side anchors can be positioned directly.
        const placement: Readonly<Record<string, readonly [string, string, number, number]>> = {
          ANCHOR_RIGHT: ["TOPLEFT", "TOPRIGHT", 4, 0],
          ANCHOR_LEFT: ["TOPRIGHT", "TOPLEFT", -4, 0],
          ANCHOR_TOP: ["BOTTOMLEFT", "TOPLEFT", 0, 4],
          ANCHOR_BOTTOM: ["TOPLEFT", "BOTTOMLEFT", 0, -4],
        };
        const point = placement[anchor];
        if (point) bridge.SetPoint(frame, point[0], owner, point[1], point[2], point[3]);
      },
      GetOwner: ({ frame }) => [this.gameTooltipState(frame).owner],
      IsOwned: ({ frame, args }) => [this.gameTooltipState(frame).owner === bridge.resolve(args[0] as FrameXmlFrame)],
      SetText: ({ frame, args }) => {
        const value = args[0];
        if (value !== undefined && value !== null && typeof value !== "string") {
          this.hideGameTooltip(frame);
          return [false];
        }
        this.clearGameTooltipLines(frame);
        if (typeof value === "string" && value.length > 0) this.setGameTooltipLine(frame, value);
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
        this.clearGameTooltipLines(frame);
        this.setGameTooltipLine(frame, name);
        const rank = typeof values[1] === "string" ? values[1] : "";
        if (rank.length > 0) this.setGameTooltipLine(frame, rank);
        this.sizeGameTooltip(frame);
        bridge.Show(frame);
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
        return [true];
      },
      SetInventoryItem: ({ frame, args }) => {
        const unit = typeof args[0] === "string" ? args[0] : undefined;
        const slot = typeof args[1] === "number" ? args[1] : Number(args[1]);
        if (!unit || !Number.isSafeInteger(slot) || slot < 1) {
          this.hideGameTooltip(frame);
          return [false];
        }
        const content = this.#options.gameTooltipAdapter?.inventoryItem(unit, slot);
        if (content === undefined || !this.setGameTooltipContent(frame, content)) {
          this.hideGameTooltip(frame);
          return [false];
        }
        return [true];
      },
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
        return [true];
      },
      ClearLines: ({ frame }) => { this.clearGameTooltipLines(frame); },
      AddLine: ({ frame, args }) => {
        const value = args[0];
        if (typeof value !== "string") return;
        const color = { r: num(args[1], 1), g: num(args[2], 1), b: num(args[3], 1), a: 1 };
        this.setGameTooltipLine(frame, value, "Left", color, args[4] === true || args[4] === 1);
        this.sizeGameTooltip(frame);
      },
      NumLines: ({ frame }) => [Math.max(0, this.gameTooltipState(frame).nextLine - 1)],
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
      IsObjectType: ({ self, args }) => [str(args[0]) === self.type],
      GetParent: ({ self }) => [self.parent],
      SetParent: ({ frame, args }) => {
        const requested = args[0];
        const parent = requested === undefined || requested === null
          ? undefined : this.anchorTarget(requested);
        // WoW rejects a non-frame target; do not turn a bad addon argument into an
        // accidental unparent operation.
        if (requested !== undefined && requested !== null && !parent) return;
        const previous = frame.parent;
        if (!bridge.SetParent(frame, parent)) return;
        if (frame.parentKey && previous && previous !== frame.parent) {
          this.clearParentKey(previous, frame.parentKey, frame);
        }
        if (frame.parentKey && frame.parent) {
          this.setParentKey(frame.parent, frame.parentKey, frame);
        }
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
      SetWidth: ({ frame, args }) => {
        bridge.update(frame, (m) => m.setAttribute("width", String(num(args[0]))));
      },
      SetHeight: ({ frame, args }) => {
        bridge.update(frame, (m) => m.setAttribute("height", String(num(args[0]))));
      },
      SetSize: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.setAttribute("width", String(num(args[0])));
          m.setAttribute("height", String(num(args[1])));
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
        const size = bridge.measure(frame);
        return [size.width / 2, size.height / 2];
      },
      GetBoundsRect: ({ frame }) => {
        const size = bridge.measure(frame);
        return [0, 0, size.width, size.height];
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
      SetAlpha: ({ frame, args }) => { bridge.update(frame, (m) => { m.alpha = num(args[0], 1); }); },
      GetAlpha: ({ self }) => [self.alpha],
      SetScale: ({ frame, args }) => {
        const scale = num(args[0], 1);
        if (scale > 0) bridge.update(frame, (m) => { m.scale = scale; });
      },
      GetScale: ({ self }) => [self.scale],
      SetID: ({ frame, args }) => { bridge.update(frame, (m) => { m.id = num(args[0]); }); },
      GetID: ({ self }) => [self.id],
      GetEffectiveScale: ({ self }) => {
        let scale = 1;
        let current: FrameXmlFrame | undefined = self;
        for (let depth = 0; current && depth < 64; depth += 1) {
          scale *= Number.isFinite(current.scale) && current.scale > 0 ? current.scale : 1;
          current = current.parent;
        }
        return [scale];
      },
    };
  }

  private regionMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetTexture: ({ frame, args }) => {
        // SetTexture also takes a colour (r, g, b[, a]); the corpus uses the
        // path form, but a numeric first argument must not become a filename.
        if (typeof args[0] === "number") {
          bridge.update(frame, (m) => { m.texture = ""; m.vertexColor = colorArgs(args); });
          return;
        }
        const texture = textureReference(args[0]);
        if (texture === undefined) return;
        bridge.SetTexture(frame, texture);
      },
      GetTexture: ({ self }) => [self.texture || undefined],
      SetTexCoord: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.texCoords = {
            left: num(args[0]), right: num(args[1], 1), top: num(args[2]), bottom: num(args[3], 1),
          };
        });
      },
      SetVertexColor: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.vertexColor = colorArgs(args); });
      },
      GetVertexColor: ({ self }) => {
        const color = self.vertexColor ?? { r: 1, g: 1, b: 1, a: 1 };
        return [color.r, color.g, color.b, color.a];
      },
      SetDesaturated: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.desaturated = args[0] === true || args[0] === 1; });
        return [true];
      },
      SetBlendMode: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.alphaMode = str(args[0]).toUpperCase() || "BLEND"; });
      },
      SetGradient: this.stub("SetGradient"),
      SetGradientAlpha: this.stub("SetGradientAlpha"),
      // Radians, counter-clockwise, about the texture's centre. `lgzg.lua` turns the login logo
      // with it once per frame; recorded, the logo sat still.
      SetRotation: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.textureRotation = num(args[0]); });
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
      SetTextColor: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.textColor = colorArgs(args); });
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
        const style = self.fontObject ? bridge.fontStyle(self.fontObject) : undefined;
        const outline = style?.outline === "NORMAL" ? "OUTLINE"
          : style?.outline === "THICK" ? "THICKOUTLINE" : style?.outline;
        const inheritedFlags = [outline, style?.monochrome ? "MONOCHROME" : undefined]
          .filter(Boolean).join(",");
        return [self.attributes["fontFile"] ?? style?.file,
          num(self.attributes["fontHeight"], style?.height ?? 12),
          self.attributes["fontFlags"] ?? inheritedFlags];
      },
      SetJustifyH: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.justifyH = str(args[0]).toUpperCase() || m.justifyH; });
      },
      GetJustifyH: ({ self }) => [self.justifyH],
      SetJustifyV: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.justifyV = str(args[0]).toUpperCase() || m.justifyV; });
      },
      SetSpacing: this.stub("SetSpacing"),
      SetShadowColor: this.stub("SetShadowColor"),
      SetShadowOffset: this.stub("SetShadowOffset"),
      SetNonSpaceWrap: this.stub("SetNonSpaceWrap"),
      SetTextHeight: this.stub("SetTextHeight"),
      // A real measurement where the host has laid the text out, and the old monospace estimate
      // where it has not (a FontString that has never been mounted has no box to measure).
      GetStringWidth: ({ frame, self }) => [bridge.measure(frame).width || self.text.length * 7],
      GetTextWidth: ({ frame, self }) => [bridge.measure(frame).width || self.text.length * 7],
      GetStringHeight: ({ frame, self }) => [bridge.measure(frame).height || (self.text ? 14 : 0)],
    };
  }

  private frameMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetScript: ({ frame, args }) => {
        const script = str(args[0]);
        const handler = args[1];
        if (handler instanceof GlueLuaRef && handler.type === "function") {
          bridge.SetScript(frame, script, this.wrapHandler(this.#vm.retain(handler), script === "OnEvent"));
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
          bridge.HookScript(frame, str(args[0]), this.wrapHandler(this.#vm.retain(handler), str(args[0]) === "OnEvent"));
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
      SetFrameLevel: ({ frame, args }) => { bridge.update(frame, (m) => { m.frameLevel = num(args[0]); }); },
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
      EnableMouseWheel: this.stub("EnableMouseWheel"),
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
      SetHitRectInsets: this.stub("SetHitRectInsets"),
      StartMoving: ({ frame, self }) => {
        if (self.movable && bridge.isVisible(frame)) bridge.update(frame, (m) => { m.moving = true; });
      },
      StopMovingOrSizing: ({ frame }) => { bridge.update(frame, (m) => { m.moving = false; }); },
      GetChildren: ({ self }) => [...self.children],
      GetRegions: ({ self }) => self.children.filter((child) => child.type === "Texture" || child.type === "FontString"),
    };
  }

  private buttonMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    const setStateTexture = (state: string): WidgetMethod => ({ frame, self, args }) => {
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
    return {
      Enable: ({ frame }) => { bridge.update(frame, (m) => { m.enabled = true; }); },
      Disable: ({ frame }) => { bridge.update(frame, (m) => { m.enabled = false; }); },
      IsEnabled: ({ self }) => [self.enabled],
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
      SetNormalFontObject: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.stateFonts.set("NORMAL", str(args[0])); m.fontObject = str(args[0]); });
      },
      SetHighlightFontObject: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.stateFonts.set("HIGHLIGHT", str(args[0])); });
      },
      SetDisabledFontObject: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.stateFonts.set("DISABLED", str(args[0])); });
      },
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
      SetCheckedTexture: this.stub("SetCheckedTexture"),
      SetDisabledCheckedTexture: this.stub("SetDisabledCheckedTexture"),
    };
  }

  private editBoxMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetFocus: ({ frame }) => { bridge.update(frame, (m) => { m.editBox.focused = true; }); },
      ClearFocus: ({ frame }) => {
        bridge.update(frame, (m) => { m.editBox.focused = false; });
        bridge.fireScript(frame, "OnEditFocusLost");
      },
      HasFocus: ({ self }) => [self.editBox.focused],
      HighlightText: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          m.editBox.highlightStart = args[0] === undefined ? 0 : num(args[0]);
          m.editBox.highlightEnd = args[1] === undefined ? m.text.length : num(args[1]);
        });
      },
      Insert: ({ frame, args }) => { bridge.InsertText(frame, str(args[0])); },
      SetMaxLetters: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.letters = num(args[0]); }); },
      SetMaxBytes: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.letters = num(args[0]); }); },
      GetNumber: ({ self }) => [num(self.text)],
      SetNumber: ({ frame, args }) => { bridge.SetText(frame, String(num(args[0]))); },
      SetNumeric: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.numeric = args[0] !== false; }); },
      SetPassword: ({ frame, args }) => { bridge.update(frame, (m) => { m.editBox.password = args[0] !== false; }); },
      SetAutoFocus: this.stub("SetAutoFocus"),
      SetCursorPosition: ({ frame, args }) => { bridge.SetCursorPosition(frame, num(args[0])); },
      GetCursorPosition: ({ frame }) => [bridge.GetCursorPosition(frame)],
      GetUTF8CursorPosition: ({ frame }) => [bridge.GetCursorPosition(frame)],
      SetTextInsets: this.stub("SetTextInsets"),
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
      SetHyperlinksEnabled: this.stub("SetHyperlinksEnabled"),
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
      SetValue: ({ frame, self, args }) => {
        const wanted = num(args[0]);
        const state = self.type === "StatusBar" ? self.statusBar : self.slider;
        const { min, max } = state;
        const clamped = max > min ? Math.min(max, Math.max(min, wanted)) : wanted;
        if (clamped === state.value) return;
        bridge.update(frame, (m) => {
          (m.type === "StatusBar" ? m.statusBar : m.slider).value = clamped;
        });
        bridge.fireScript(frame, "OnValueChanged", clamped);
      },
      GetValue: ({ self }) => [self.type === "StatusBar" ? self.statusBar.value : self.slider.value],
      SetMinMaxValues: ({ frame, args }) => {
        bridge.update(frame, (m) => {
          const state = m.type === "StatusBar" ? m.statusBar : m.slider;
          state.min = num(args[0]);
          state.max = num(args[1]);
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
      IsEnabled: ({ self }) => [self.enabled],
    };
  }

  private statusBarMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    return {
      SetStatusBarTexture: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.statusBar.texture = str(args[0]); });
      },
      SetStatusBarColor: ({ frame, args }) => {
        bridge.update(frame, (m) => { m.statusBar.color = colorArgs(args); });
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
      UpdateScrollChildRect: this.stub("UpdateScrollChildRect"),
      SetScrollChild: this.stub("SetScrollChild"),
      GetScrollChild: ({ self }) => [self.children[0]],
    };
  }

  private modelMethods(): Record<string, WidgetMethod> {
    const bridge = this.#bridge;
    const record = (method: string): WidgetMethod => ({ frame, args }) => {
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
