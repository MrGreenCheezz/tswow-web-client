import {
  lauxlib, lua, lualib, push as pushInterop, to_jsstring, to_luastring, tojs as interopToJs, type LuaState,
} from "../lua/LuaVm.js";
import { installGlueLuaNatives } from "./GlueLuaNatives.js"; // L5 3.27
import { GLUE_LUA51_NATIVE_SHIMS } from "./GlueLua51NativeShims.js"; // ARC-4 A4
import { luaStringToJs } from "./LuaStrings.js"; // P1-14b

/**
 * The part of Wow.exe 3.3.5a 12340's embedded «compat.lua» (text at 0x00a44980, read-only) that the
 * preamble (GlueLua51NativeShims.ts) does not already give. FrameScript_Initialize (0x00819bb0) runs that
 * chunk last, in every Lua state it makes: at client start (0x00404130 — the glue state) and at each
 * game-UI start (0x0052a980). `sin`, `cos`, `tan` take degrees and `asin`, `acos`, `atan`, `atan2` return
 * them; `deg`, `rad`, `exp`, `log`, `log10`, `frexp`, `ldexp` are the math library's; `foreach`,
 * `foreachi`, `strrev`, `PI`; `string.trim/split/join/replace` point at `strtrim`, `strsplit`,
 * `strjoin`, `strreplace`, and the chunk's `wipe = table.wipe` means the table library has `wipe`.
 * Without these the stock MainMenuBar_GetRightABPos (`sin(fraction*90)`, MainMenuBar.lua:26) raised on
 * a nil at every loading screen's PLAYER_ENTERING_WORLD. The four `== nil` guards for 5.1's
 * `math.log10`, `math.atan2` and `table.foreach(i)` were written for fengari's Lua 5.3; on PUC 5.1 they
 * never fire (12.10: kept so the chunk's line numbers, which tracebacks through it show, stay as they are).
 */
export const WOW_COMPAT_LUA = `
local math, table, string = math, table, string
if math.log10 == nil then math.log10 = function (x) return math.log(x, 10) end end
if math.atan2 == nil then math.atan2 = function (y, x) return math.atan(y, x) end end
if table.foreach == nil then
  table.foreach = function (t, f)
    for k, v in pairs(t) do
      local result = f(k, v)
      if result ~= nil then return result end
    end
  end
end
if table.foreachi == nil then
  table.foreachi = function (t, f)
    for i = 1, #t do
      local result = f(i, t[i])
      if result ~= nil then return result end
    end
  end
end
if table.wipe == nil then table.wipe = wipe end
foreach = table.foreach
foreachi = table.foreachi
acos = function (x) return math.deg(math.acos(x)) end
asin = function (x) return math.deg(math.asin(x)) end
atan = function (x) return math.deg(math.atan(x)) end
atan2 = function (x,y) return math.deg(math.atan2(x,y)) end
cos = function (x) return math.cos(math.rad(x)) end
deg = math.deg
exp = math.exp
frexp = math.frexp
ldexp = math.ldexp
log = math.log
log10 = math.log10
PI = math.pi
rad = math.rad
sin = function (x) return math.sin(math.rad(x)) end
tan = function (x) return math.tan(math.rad(x)) end
strrev = string.reverse
string.trim = strtrim
string.split = strsplit
string.join = strjoin
string.replace = strreplace
`;

/**
 * `lua_checkstack`, named in one place: a C function is promised `LUA_MINSTACK` slots, and anything that
 * means to push more has to ask.
 */
function checkStack(state: LuaState, slots: number): boolean {
  return lua.lua_checkstack(state, slots);
}

export interface GlueLuaOptions {
  /** Where an unhandled Lua error goes when the corpus has set no handler. */
  readonly onError?: (message: string) => void;
  /** `print()` from Lua; the corpus uses it only inside LibDeflate's test code. */
  readonly onPrint?: (message: string) => void;
}

/**
 * A handle to a Lua value living in the registry.
 *
 * Arguments that are not scalars reach a JS binding as one of these and are
 * released when the binding returns, unless it calls `vm.retain(ref)` — which
 * is exactly what `seterrorhandler(_ERRORMESSAGE)` needs.
 */
export class GlueLuaRef {
  constructor(readonly key: number, readonly type: string) {}
}

/**
 * 3.38: a Lua error a binding raises in its caller, with the message as it is — `callRaising`'s
 * failure, or a binding's own luaL_error. Any other exception from a binding is prefixed with its name.
 */
export class GlueLuaRaise extends Error {
  constructor(readonly luaMessage: string) {
    super(luaMessage);
  }
}

/** Decode a Lua table/function into a host object (frames, for instance). */
export type GlueLuaTableDecoder = (L: LuaState, index: number) => unknown | undefined;
/** Push a host object as a Lua value; return false to fall through to a table. */
export type GlueLuaValueEncoder = (L: LuaState, value: object) => boolean;

export type GlueLuaBinding = (args: readonly unknown[]) => readonly unknown[] | void;
/** P1-14d: a method binding — its first argument (the widget's self) apart from the rest. */
export type GlueLuaMethodBinding = (first: unknown, rest: readonly unknown[]) => readonly unknown[] | void;

const LUA_OK = 0;

/**
 * The glue screen's Lua interpreter.
 *
 * One VM per glue session. It owns the state, the 5.1 shim preamble, the
 * error-handler protocol the corpus installs from `GlueBasicControls.xml`, and
 * the marshalling seams the widget layer and the C-API plug into. The VM has no
 * `js` library, so no chunk it runs can reach `window`, `document`, fetch or
 * WebSocket except through a binding registered here.
 */
export class GlueLuaVm {
  readonly #state: LuaState;
  readonly #options: GlueLuaOptions;
  readonly #hostSources: string[] = [];
  #decoder: GlueLuaTableDecoder | undefined;
  #encoder: GlueLuaValueEncoder | undefined;
  #errorHandler: GlueLuaRef | undefined;
  #defaultErrorHandler: GlueLuaRef | undefined;
  #closed = false;
  /** P1-14d: the registry reference the last `toValue` made, for a binding's release list. */
  #fresh: GlueLuaRef | undefined;
  /** Errors that reached no handler; kept so a loader can report them. */
  readonly errors: string[] = [];

  constructor(options: GlueLuaOptions = {}) {
    this.#options = options;
    this.#state = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.#state);
    this.installErrorProtocol();
    // ARC-4: PUC 5.1's own library stands; the preamble adds Blizzard's vocabulary (GlueLua51NativeShims.ts).
    const shimmed = this.execute(GLUE_LUA51_NATIVE_SHIMS, "@GlueLua:shims");
    if (!shimmed.ok) throw new Error(`glue Lua shims failed to load: ${shimmed.error}`);
    installGlueLuaNatives(this.#state); // L5 3.27: Wow.exe's `strsplit` and `string.format` (GlueLuaNatives.ts)
    const compat = this.execute(WOW_COMPAT_LUA, "@GlueLua:compat");
    if (!compat.ok) throw new Error(`glue Lua compat failed to load: ${compat.error}`);
  }

  get state(): LuaState {
    return this.#state;
  }

  get luaVersion(): string {
    return "PUC Lua 5.1.5 (WebAssembly) with Blizzard's 3.3.5a globals";
  }

  setTableDecoder(decoder: GlueLuaTableDecoder | undefined): void {
    this.#decoder = decoder;
  }

  setValueEncoder(encoder: GlueLuaValueEncoder | undefined): void {
    this.#encoder = encoder;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    lua.lua_close(this.#state);
  }

  /**
   * Whether `close()` has run. A closed state must not be touched again (its memory is freed; fengari,
   * the VM before ARC-4, threw «Cannot set properties of null»), so host callbacks that can outlive the
   * VM — a tooltip redraw waiting on a late item row — ask this before calling in.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * `seterrorhandler`/`geterrorhandler`/`message`, plus `print`.
   *
   * `GlueBasicControls.xml` installs `_ERRORMESSAGE` as the handler at load
   * time and the whole corpus assumes a script error surfaces as a dialog
   * rather than as a dead screen — so the handler protocol has to exist before
   * the first corpus chunk runs, which is why it is installed here and not by
   * the C-API module.
   */
  private installErrorProtocol(): void {
    // `securecall` calls `geterrorhandler()(message)` unconditionally, so the
    // getter must always answer with something callable — before
    // GlueBasicControls.xml has installed `_ERRORMESSAGE`, and after a screen
    // has torn it down again.
    this.pushBinding("__glueDefaultErrorHandler", (args) => {
      const message = String(args[0] ?? "");
      this.errors.push(message);
      this.#options.onError?.(message);
      return [];
    });
    this.#defaultErrorHandler = new GlueLuaRef(
      lauxlib.luaL_ref(this.#state, lua.LUA_REGISTRYINDEX),
      "function",
    );
    this.registerGlobal("seterrorhandler", (args) => {
      const handler = args[0];
      if (handler instanceof GlueLuaRef && handler.type === "function") {
        this.releaseErrorHandler();
        this.#errorHandler = this.retain(handler);
      }
      return [];
    });
    this.registerGlobal("geterrorhandler", () => [this.#errorHandler ?? this.#defaultErrorHandler]);
    this.registerGlobal("print", (args) => {
      this.#options.onPrint?.(args.map((value) => String(value ?? "nil")).join("\t"));
      return [];
    });
  }

  private releaseErrorHandler(): void {
    if (!this.#errorHandler) return;
    lauxlib.luaL_unref(this.#state, lua.LUA_REGISTRYINDEX, this.#errorHandler.key);
    this.#errorHandler = undefined;
  }

  /**
   * Route an error the way the corpus expects.
   *
   * The glue error handler is Lua (`_ERRORMESSAGE` -> `ScriptErrors:Show()`),
   * so a failing script must not take the screen down; it must land in the
   * dialog. Only an error raised while the handler itself is running falls
   * through to the host sink.
   */
  reportError(message: string): void {
    this.errors.push(message);
    const handler = this.#errorHandler;
    if (handler) {
      const before = lua.lua_gettop(this.#state);
      lua.lua_rawgeti(this.#state, lua.LUA_REGISTRYINDEX, handler.key);
      lua.lua_pushstring(this.#state, to_luastring(message));
      const status = lua.lua_pcall(this.#state, 1, 0, 0);
      if (status === LUA_OK) {
        lua.lua_settop(this.#state, before);
        return;
      }
      lua.lua_settop(this.#state, before);
    }
    this.#options.onError?.(message);
  }

  /**
   * Load and run one chunk.
   *
   * `chunkName` is the file path, prefixed so Lua reports it verbatim: an
   * error inside `AccountLogin.lua` has to name that file, because the corpus
   * is 70 files deep and a bare "chunk" is useless.
   */
  execute(
    source: string,
    chunkName: string,
    args: readonly unknown[] = [],
  ): { readonly ok: boolean; readonly error?: string } {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    // The chunk, the traceback handler and every argument; see `call`.
    if (!checkStack(L, args.length + 3)) {
      return { ok: false, error: `${chunkName}: stack overflow passing ${args.length} arguments` };
    }
    const loaded = this.loadBuffer(source, chunkName);
    if (loaded !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      return { ok: false, error: message };
      }
      const handlerIndex = this.pushTracebackHandler(top + 1);
      for (const arg of args) this.pushValue(arg);
      const status = lua.lua_pcall(L, args.length, 0, handlerIndex);
    if (status !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      return { ok: false, error: message };
    }
    lua.lua_settop(L, top);
    return { ok: true };
  }

  /**
   * Load one chunk. 5.1's lexer drops the backslash of an unknown escape and keeps the character, as
   * the client's does: `Interface\SharedXML\SharedGlueStrings.lua` (the server's `patch-ruRU-F`) has
   * `"… пароль? \Небезопасно …"`. (Until ARC-4 A6, 12.10, fengari's 5.3 lexer refused it and a chunk
   * was retried with such escapes rewritten.)
   */
  private loadBuffer(source: string, chunkName: string): number {
    return lauxlib.luaL_loadbuffer(this.#state, to_luastring(source), null, to_luastring(chunkName));
  }

  /** Run a chunk and send any failure through the corpus' error handler. */
  executeReported(source: string, chunkName: string, args: readonly unknown[] = []): boolean {
    const result = this.execute(source, chunkName, args);
    if (!result.ok) this.reportError(result.error ?? `${chunkName} failed`);
    return result.ok;
  }

  /**
   * Compile `source` as `function(<parameters>, ...) <source> end`.
   *
   * This is the shape an XML script body has to take: the body is written as
   * if the parameters were already in scope (`AccountLogin_OnKeyDown(key)`),
   * and the trailing vararg is what `GlueParent_OnEvent(event, ...)` forwards.
   */
  compileFunction(
    source: string,
    chunkName: string,
    parameters: readonly string[],
  ): GlueLuaRef | undefined {
    const signature = [...parameters, "..."].join(", ");
    const wrapped = `return function(${signature})\n${source}\nend`;
    const L = this.#state;
    const top = lua.lua_gettop(L);
    if (this.loadBuffer(wrapped, `@${chunkName}`) !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      this.reportError(`${chunkName}: ${message}`);
      return undefined;
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      this.reportError(`${chunkName}: ${message}`);
      return undefined;
    }
    const ref = new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), "function");
    lua.lua_settop(L, top);
    return ref;
  }

  /** Call a retained Lua function; failures go through the corpus' handler. */
  call(ref: GlueLuaRef, args: readonly unknown[] = NO_VALUES, results = 0): readonly unknown[] {
    return this.callWith(ref, NO_VALUES, args, results);
  }

  /**
   * P1-14d: `call(ref, [...lead, ...args], results)` without building that array — the handler
   * dispatch's fn/self/isEvent go first, then the script's own arguments. Both lists are read only
   * while they are pushed, before the function runs.
   */
  callWith(ref: GlueLuaRef, lead: readonly unknown[], args: readonly unknown[], results = 0): readonly unknown[] {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    const count = lead.length + args.length;
    // The function, its arguments and the traceback handler, asked for before the first push. A
    // host call starts with `LUA_MINSTACK` (20) free slots and nothing grows them: a 3.3.5
    // `COMBAT_LOG_EVENT_UNFILTERED` dispatch (event name + 19 payload values, through
    // `__glueInvoke`'s fn/self/isEvent) threw fengari's «stack overflow» straight out of
    // `bridge.tick`, which nothing on the world mount's frame loop catches.
    if (!checkStack(L, count + 3)) {
      this.reportError(`stack overflow passing ${count} arguments`);
      return [];
    }
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
    if (!lua.lua_isfunction(L, -1)) {
      lua.lua_settop(L, top);
      return [];
    }
    for (let index = 0; index < lead.length; index += 1) this.pushValue(lead[index]);
    for (let index = 0; index < args.length; index += 1) this.pushValue(args[index]);
    const handlerIndex = this.pushTracebackHandler(top + 1);
    const status = lua.lua_pcall(L, count, results, handlerIndex);
    if (status !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      this.reportError(message);
      return [];
    }
    const resultCount = results === lua.LUA_MULTRET ? lua.lua_gettop(L) - top - 1 : results;
    // P1-14c: a call that asked for nothing (every handler dispatch) allocates no result array.
    if (resultCount === 0) {
      lua.lua_settop(L, top);
      return NO_VALUES;
    }
    const values: unknown[] = [];
    for (let index = 0; index < resultCount; index += 1) {
      values.push(this.toValue(top + 1 + index + 1));
    }
    lua.lua_settop(L, top);
    return values;
  }

  /**
   * 3.38: `call` for a binding's own work in Lua. A failure is not reported here: it comes back as a
   * thrown `GlueLuaRaise`, which the binding lets out, so it is raised in the binding's caller — that
   * caller's `pcall` sees it, as it sees a C function's `lua_error`. No traceback handler: the message
   * stays the one the function raised.
   */
  callRaising(ref: GlueLuaRef, args: readonly unknown[], results: number): readonly unknown[] {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    if (!checkStack(L, args.length + 1)) throw new GlueLuaRaise(`stack overflow passing ${args.length} arguments`);
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
    for (let index = 0; index < args.length; index += 1) this.pushValue(args[index]);
    const status = lua.lua_pcall(L, args.length, results, 0);
    if (status !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      throw new GlueLuaRaise(String(message));
    }
    if (results === 0) {
      lua.lua_settop(L, top);
      return NO_VALUES;
    }
    const values: unknown[] = [];
    for (let index = 0; index < results; index += 1) values.push(this.toValue(top + 1 + index));
    lua.lua_settop(L, top);
    return values;
  }

  /** Keep a Lua value alive past the binding call that produced it. */
  retain(ref: GlueLuaRef): GlueLuaRef {
    const L = this.#state;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
    return new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), ref.type);
  }

  release(ref: GlueLuaRef): void {
    lauxlib.luaL_unref(this.#state, lua.LUA_REGISTRYINDEX, ref.key);
  }

  /**
   * Bind a JS function as a Lua global.
   *
   * The binding sees decoded arguments and returns decoded results; it never
   * touches the stack, so a C-API entry cannot corrupt the VM by miscounting.
   */
  registerGlobal(name: string, binding: GlueLuaBinding): void {
    this.pushBinding(name, binding);
    lua.lua_setglobal(this.#state, to_luastring(name));
  }

  /** Allocate one stable Lua table for an add-on's second chunk argument. */
  createTable(): GlueLuaRef {
    lua.lua_newtable(this.#state);
    return new GlueLuaRef(lauxlib.luaL_ref(this.#state, lua.LUA_REGISTRYINDEX), "table");
  }

  /** Push a JS function as a Lua value without naming it (for method tables). */
  pushBinding(name: string, binding: GlueLuaBinding): void {
    this.pushBindingWith(name, binding, undefined);
  }

  /**
   * P1-14d: a widget method — the binding gets its first argument (the widget table, decoded) and
   * the rest as their own list, so no `args.slice(1)` per call.
   */
  pushMethodBinding(name: string, method: GlueLuaMethodBinding): void {
    this.pushBindingWith(name, undefined, method);
  }

  private pushBindingWith(name: string, binding: GlueLuaBinding | undefined, method: GlueLuaMethodBinding | undefined): void {
    const L = this.#state;
    lua.lua_pushjsfunction(L, (state: LuaState): number => {
      // `state` is the thread that actually called us, which is not the main
      // state when a coroutine is running (LibDeflate uses one). Marshal
      // against it; registry references are shared across threads either way.
      const count = lua.lua_gettop(state);
      const args: unknown[] = [];
      // P1-14d: only a call that made a registry reference gets a list to release them from.
      let scratch: GlueLuaRef[] | undefined;
      let first: unknown;
      for (let index = 1; index <= count; index += 1) {
        this.#fresh = undefined;
        const value = this.toValue(index, undefined, state);
        if (this.#fresh !== undefined) (scratch ??= []).push(this.#fresh);
        if (method !== undefined && index === 1) first = value;
        else args.push(value);
      }
      this.#fresh = undefined;
      let results: readonly unknown[];
      try {
        results = (method !== undefined ? method(first, args) : binding!(args)) ?? NO_VALUES;
      } catch (error) {
        if (scratch !== undefined) for (const ref of scratch) this.release(ref);
        // 3.38: a Lua error the binding passes on keeps its own words, as a C function's would.
        const message = error instanceof GlueLuaRaise ? error.luaMessage : `${name}: ${String(error)}`;
        lua.lua_pushstring(state, to_luastring(message));
        return lua.lua_error(state);
      }
      if (scratch !== undefined) for (const ref of scratch) this.release(ref);
      lua.lua_settop(state, 0);
      // A C function is guaranteed `LUA_MINSTACK` — **twenty** — free slots and nothing more, and
      // this is the first binding in the client to answer with more than that:
      // `GetAvailableRaces()` is three values per race, so ten races is thirty and the thirty-first
      // push overflows the stack. Measured before this check: `CharacterCreate_OnShow` died on the
      // call itself, the creation screen came up with no races, no classes and no backdrop, and the
      // corpus' own error handler swallowed the message so nothing said why.
      if (results.length > 0 && !checkStack(state, results.length)) {
        lua.lua_pushstring(state, to_luastring(`${name}: stack overflow returning ${results.length} values`));
        return lua.lua_error(state);
      }
      for (const value of results) this.pushValue(value, state);
      return results.length;
    });
  }

  setGlobal(name: string, value: unknown): void {
    this.pushValue(value);
    lua.lua_setglobal(this.#state, to_luastring(name));
  }

  /**
   * Read a global. A table or function comes back as a retained `GlueLuaRef`
   * that the caller owns and must `release`; scalars need no cleanup.
   */
  getGlobal(name: string): unknown {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    lua.lua_getglobal(L, to_luastring(name));
    const value = this.toValue(-1);
    lua.lua_settop(L, top);
    return value;
  }

  /** Host-only source attribution for a Lua callback, without exposing the debug library. */
  functionSource(ref: GlueLuaRef): string | undefined {
    if (ref.type !== "function") return undefined;
    const L = this.#state;
    const top = lua.lua_gettop(L);
    try {
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
      if (!lua.lua_isfunction(L, -1)) return undefined;
      const info = new lua.lua_Debug();
      return lua.lua_getinfo(L, to_luastring(">S"), info) ? to_jsstring(info.source) : undefined;
    } finally { lua.lua_settop(L, top); }
  }

  /** Inspect creation provenance in the host without enabling Lua's debug library. */
  callingSources(): readonly string[] {
    const sources: string[] = [];
    const info = new lua.lua_Debug();
    for (let level = 0; level < 64 && lua.lua_getstack(this.#state, level, info); level += 1) {
      if (lua.lua_getinfo(this.#state, to_luastring("S"), info)) sources.push(to_jsstring(info.source));
    }
    return [...sources, ...this.#hostSources.slice().reverse()];
  }

  /** Source and line only, not a full traceback (fengari's searched all globals for function names). */
  callingLocation(excludedSource: string): string {
    const info = new lua.lua_Debug();
    for (let level = 0; level < 64 && lua.lua_getstack(this.#state, level, info); level += 1) {
      if (!lua.lua_getinfo(this.#state, to_luastring("Sl", true), info)) continue;
      const source = to_jsstring(info.source);
      if (source === "=[C]" || source.includes(excludedSource) || info.currentline < 0) continue;
      return source.replace(/^@/, "") + ":" + info.currentline;
    }
    return "";
  }

  /** XML creation has no Lua file on the stack, but its inline handlers still belong to that file. */
  withCallingSource<T>(source: string, callback: () => T): T {
    this.#hostSources.push(source);
    try { return callback(); } finally { this.#hostSources.pop(); }
  }

  /** Retain the global `name` if it is a function, for a later `call`. */
  globalFunction(name: string): GlueLuaRef | undefined {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    lua.lua_getglobal(L, to_luastring(name));
    if (!lua.lua_isfunction(L, -1)) {
      lua.lua_settop(L, top);
      return undefined;
    }
    const ref = new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), "function");
    lua.lua_settop(L, top);
    return ref;
  }

  /**
   * Read a global as a string; the GlobalString resolver for XML `text=`.
   *
   * The type is checked on the stack rather than by converting first: this runs
   * once per `text=` attribute across the whole corpus, and a global that
   * happens to be a table would otherwise pin a registry reference on every
   * miss.
   */
  globalString(name: string): string | undefined {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    const type = lua.lua_getglobal(L, to_luastring(name));
    const value = type === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : undefined;
    lua.lua_settop(L, top);
    return value;
  }

  /** Push any host value. Scalars go through the API's scalar `push`; the rest here. */
  pushValue(value: unknown, state: LuaState = this.#state): void {
    const L = state;
    if (value === undefined || value === null) {
      lua.lua_pushnil(L);
      return;
    }
    // ARC-4 A4: 5.1 (Wow.exe's) has one number type and prints 1 as "1" by itself, so a whole number
    // is a plain double too and -0 keeps its sign ("-0", as Wow.exe's "%.14g" prints it). (Under
    // fengari's 5.3, until A6, a whole number was pushed as an integer so it did not print as "1.0".)
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      pushInterop(L, value);
      return;
    }
      if (value instanceof GlueLuaRef) {
        lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, value.key);
        return;
      }
    if (typeof value === "object" && this.#encoder?.(L, value as object)) return;
    // A nested table holds one more slot per level while its entries are pushed.
    if (typeof value === "object" && !checkStack(L, 2)) {
      lua.lua_pushnil(L);
      return;
    }
    if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((entry, index) => {
        this.pushValue(entry, L);
        lua.lua_rawseti(L, -2, index + 1);
      });
      return;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      lua.lua_createtable(L, 0, entries.length);
      for (const [key, entry] of entries) {
        this.pushValue(entry, L);
        lua.lua_setfield(L, -2, to_luastring(key));
      }
      return;
    }
    lua.lua_pushnil(L);
  }

  /**
   * Read the value at `index`.
   *
   * `scratch` collects the registry references created for non-scalars so a
   * binding call can free them all at once; without it, every table argument
   * the corpus passes would pin a value forever.
   */
  toValue(index: number, scratch?: GlueLuaRef[], state: LuaState = this.#state): unknown {
    const L = state;
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TNONE || type === lua.LUA_TNIL) return undefined;
    // P1-14b: the string's bytes decoded without a per-byte `+=` (LuaStrings.ts), same text.
    if (type === lua.LUA_TSTRING) return luaStringToJs(lua.lua_tolstring(L, index)!);
    if (type === lua.LUA_TBOOLEAN || type === lua.LUA_TNUMBER) {
      return interopToJs(L, index);
    }
    if (type === lua.LUA_TTABLE || type === lua.LUA_TFUNCTION) {
      const decoded = this.#decoder?.(L, index);
      if (decoded !== undefined) return decoded;
      lua.lua_pushvalue(L, index);
      const ref = new GlueLuaRef(
        lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX),
        type === lua.LUA_TFUNCTION ? "function" : "table",
      );
      scratch?.push(ref);
      this.#fresh = ref; // P1-14d
      return ref;
    }
    // L5 3.27: a userdata — `newproxy`'s frame handles (FrameXmlLuaEnvironment.ts) — crosses as a
    // reference too, so a binding that keeps a value (SetAttribute's frameref-*) hands it back.
    if (type === lua.LUA_TUSERDATA) {
      lua.lua_pushvalue(L, index);
      const ref = new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), "userdata");
      scratch?.push(ref);
      this.#fresh = ref; // P1-14d
      return ref;
    }
    return undefined;
  }

  /**
   * Push a message handler that appends a Lua traceback, and slide it under the
   * call already staged on the stack.
   *
   * `targetIndex` is where the called function currently sits. A traceback is
   * what makes an error in this corpus actionable: the failing line is usually
   * four calls deep inside one of 70 files.
   */
  private pushTracebackHandler(targetIndex: number): number {
    const L = this.#state;
    // P1-14c: one handler for every call — it captures nothing, so a closure per call was garbage.
    lua.lua_pushjsfunction(L, TRACEBACK_HANDLER);
    lua.lua_insert(L, targetIndex);
    return targetIndex;
  }
}

/** P1-14c: the message handler of every `call`/`execute`: the error message with a Lua traceback. */
function TRACEBACK_HANDLER(state: LuaState): number {
  const message = lua.lua_tojsstring(state, -1);
  lauxlib.luaL_traceback(state, state, to_luastring(message ?? "error"), 1);
  return 1;
}

/** P1-14c: what `call` answers with no results asked for — shared, frozen. */
const NO_VALUES: readonly unknown[] = Object.freeze([]);

/** The shim source, exported so a test can assert what is actually installed. */
export const GLUE_LUA51_SHIM_SOURCE = GLUE_LUA51_NATIVE_SHIMS;

/**
 * The shims this slice measured as load-bearing, with their corpus call counts.
 *
 * Kept as data rather than prose so the numbers in `README.md` and the ones a
 * test asserts cannot drift apart.
 */
export const GLUE_MEASURED_SHIMS: Readonly<Record<string, number>> = Object.freeze({
  strlen: 51, format: 25, strupper: 11, tinsert: 10, getglobal: 9, strsub: 8, gsub: 8,
  strbyte: 3, strchar: 2, gmatch: 2, unpack: 2, strfind: 1, tremove: 1, tconcat: 1,
  getn: 1, sort: 1, strreplace: 1,
  max: 32, time: 27, mod: 21, min: 16, floor: 14, date: 4, random: 3, ceil: 3, abs: 1,
  securecall: 10, issecure: 1, seterrorhandler: 1, debuginfo: 1, print: 2,
  "math.frexp": 1,
});

/** Measured as unused by the corpus; recorded so the absence is a decision. */
export const GLUE_UNUSED_SHIMS: readonly string[] = Object.freeze([
  "setfenv", "getfenv", "loadstring", "wipe", "strsplit", "strjoin", "strtrim", "strconcat",
]);
