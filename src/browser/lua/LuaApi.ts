/**
 * ARC-4: fengari's API (`lua`, `lauxlib`, `lualib`, `to_luastring`, `to_jsstring`, and fengari-interop's
 * `push`/`tojs`) over PUC Lua 5.1.5 in WebAssembly (`LuaWasm.ts`), so the glue and FrameXML runtimes
 * keep their calls. First written as the P2-12 prototype (`.runtime/perf-step23/arc4/fengari-facade.mjs`);
 * see `docs/implementation/line-ARC4.ru.md`.
 *
 * Representation:
 * - A `LuaState` is a JS object `{ p, l_G }` per `lua_State` pointer (one per main state, one per
 *   coroutine thread met in a host call); `l_G` is shared by a state and its threads (GlueLuaFormat keys
 *   a WeakMap with it).
 * - Lua strings are `Uint8Array`, as in fengari.
 * - `lua_topointer` answers an interned token object per address (GlueWidgets keys a WeakMap with it;
 *   fengari answers the Table itself). Unlike a JS object, an address can be reused after Lua collects
 *   the table, so the owner of a token releases it ({@link releaseLuaPointer}) when it stops caring.
 * - A JS function pushed with `lua_pushjsfunction` is registered once (deduplicated by identity) and
 *   becomes a C closure of `wl_tramp` with its index as upvalue.
 * - Errors: `luaL_error`/`lua_error`/`luaL_argerror`/`luaL_check*` leave the error value on the stack and
 *   throw {@link LUA_RAISE}; the host-call dispatcher catches it and answers −1, and `wl_tramp` raises in
 *   C after the JS frames are gone, so the longjmp (a wasm exception) unwinds wasm frames only.
 * - Constants are Lua 5.1's (`LUA_REGISTRYINDEX = −10000`, `LUA_ERRERR = 5`); the 5.3 calls the runtime
 *   uses are emulated: getters answer the type they pushed, `lua_absindex`, `lua_pushglobaltable`,
 *   `lua_tonumberx`, `luaL_traceback` (5.1's `db_errorfb` text), `lua_isinteger` (always false: 5.1 has
 *   no integer subtype).
 */

import type * as Fengari from "fengari";
import { luaHeap, luaView, luaWasm, luaWasmLoad, setLuaHostCall } from "./LuaWasm.js";

/** The exports this facade calls (tools/lua-wasm/wow_lua.c). */
interface LuaExports {
  wl_scratch(): number; wl_scratch_size(): number; wl_names(): number; wl_names_size(): number; wl_lenptr(): number;
  wl_malloc(size: number): number; wl_free(pointer: number): void;
  wl_newstate(): number; wl_openlibs(L: number): void; wl_restore_env(L: number): void; wl_mainthread(L: number): number;
  lua_close(L: number): void;
  lua_gettop(L: number): number; lua_settop(L: number, index: number): void; lua_pushvalue(L: number, index: number): void;
  lua_remove(L: number, index: number): void; lua_insert(L: number, index: number): void; lua_replace(L: number, index: number): void;
  lua_checkstack(L: number, n: number): number;
  lua_type(L: number, index: number): number; lua_isnumber(L: number, index: number): number;
  lua_isstring(L: number, index: number): number; lua_iscfunction(L: number, index: number): number;
  lua_equal(L: number, a: number, b: number): number; lua_rawequal(L: number, a: number, b: number): number;
  lua_lessthan(L: number, a: number, b: number): number;
  lua_tonumber(L: number, index: number): number; lua_tointeger(L: number, index: number): number;
  lua_toboolean(L: number, index: number): number; wl_tolstring(L: number, index: number): number;
  lua_objlen(L: number, index: number): number; lua_topointer(L: number, index: number): number;
  lua_tothread(L: number, index: number): number; lua_touserdata(L: number, index: number): number;
  lua_pushnil(L: number): void; lua_pushnumber(L: number, n: number): void; lua_pushinteger(L: number, n: number): void;
  lua_pushlstring(L: number, s: number, length: number): void; lua_pushboolean(L: number, b: number): void;
  lua_pushlightuserdata(L: number, p: number): void;
  lua_createtable(L: number, narr: number, nrec: number): void; lua_newuserdata(L: number, size: number): number;
  lua_getmetatable(L: number, index: number): number; lua_setmetatable(L: number, index: number): number;
  wl_gettable(L: number, index: number): number; wl_getfield(L: number, index: number, key: number): number;
  wl_rawget(L: number, index: number): number; wl_rawgeti(L: number, index: number, n: number): number;
  wl_getglobal(L: number, key: number): number;
  lua_settable(L: number, index: number): void; lua_setfield(L: number, index: number, key: number): void;
  lua_rawset(L: number, index: number): void; lua_rawseti(L: number, index: number, n: number): void;
  wl_setglobal(L: number, key: number): void;
  lua_next(L: number, index: number): number; lua_concat(L: number, n: number): void;
  lua_getupvalue(L: number, f: number, n: number): number;
  lua_call(L: number, nargs: number, nresults: number): void;
  lua_pcall(L: number, nargs: number, nresults: number, errfunc: number): number;
  wl_loadbuffer(L: number, buffer: number, length: number, name: number): number;
  luaL_ref(L: number, t: number): number; luaL_unref(L: number, t: number, ref: number): void;
  luaL_callmeta(L: number, index: number, event: number): number; lua_gc(L: number, what: number, data: number): number;
  wl_getstack(L: number, level: number): number; wl_getinfo(L: number, what: number, ici: number): number;
  wl_ar_source(): number; wl_ar_short_src(): number; wl_ar_what(): number; wl_ar_name(): number;
  wl_ar_namewhat(): number; wl_ar_currentline(): number; wl_ar_linedefined(): number; wl_ar_nups(): number;
  wl_push_error(L: number, message: number, length: number): void;
  wl_push_argerror(L: number, narg: number, extramsg: number): void;
  wl_traceback(L: number, L1: number, message: number, length: number, level: number): void;
  wl_push_traceback_handler(L: number): void;
  wl_pushjsfunction(L: number, index: number): void;
}

const x = luaWasm as unknown as LuaExports;
const SCRATCH = x.wl_scratch();
const SCRATCH_SIZE = x.wl_scratch_size();
const NAMES = x.wl_names();
const NAMES_SIZE = x.wl_names_size();
const LEN_PTR = x.wl_lenptr();

/** A state as this facade represents it; handed out typed as fengari's opaque `LuaState`. */
interface WasmState { readonly p: number; readonly l_G: { readonly universe: number } }
type LuaState = Fengari.LuaState;
type LuaString = Fengari.LuaString;
const ptr = (L: LuaState): number => (L as unknown as WasmState).p;

// ---------------------------------------------------------------- constants (Lua 5.1 values)
const LUA_REGISTRYINDEX = -10000;
const LUA_ENVIRONINDEX = -10001;
const LUA_GLOBALSINDEX = -10002;
const T = { NONE: -1, NIL: 0, BOOLEAN: 1, LIGHTUSERDATA: 2, NUMBER: 3, STRING: 4, TABLE: 5, FUNCTION: 6, USERDATA: 7, THREAD: 8 } as const;
const TYPE_NAMES = ["no value", "nil", "boolean", "userdata", "number", "string", "table", "function", "userdata", "thread"];
const typeName = (type: number): string => TYPE_NAMES[type + 1] ?? "?";

// ---------------------------------------------------------------- strings
const encoder = new TextEncoder();
const lossy = new TextDecoder("utf-8", { ignoreBOM: true });
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const stringCache = new Map<string, LuaString>();
const STRING_CACHE_MAX = 16384;

export function to_luastring(value: string, _cache?: boolean): LuaString {
  if (typeof value !== "string") value = String(value);
  if (value.length <= 48) {
    let encoded = stringCache.get(value);
    if (encoded === undefined) {
      if (stringCache.size >= STRING_CACHE_MAX) stringCache.clear();
      encoded = encoder.encode(value);
      stringCache.set(value, encoded);
    }
    return encoded;
  }
  return encoder.encode(value);
}

export function to_jsstring(value: LuaString, from = 0, to = value.length, replacement = false): string {
  const slice = from === 0 && to === value.length ? value : value.subarray(from, to);
  if (!replacement) return strict.decode(slice);
  try {
    return strict.decode(slice);
  } catch {
    return fengariLossyDecode(slice);
  }
}

/**
 * fengari's replacement decoder (`defs.js` `to_jsstring(…, true)`), on malformed UTF-8 only: one U+FFFD
 * per bad lead byte or broken sequence, the bytes of a truncated sequence swallowed, overlongs and
 * encoded surrogates accepted as code points — so a Lua string reads as the same JS string on both VMs
 * (WHATWG's lossy TextDecoder replaces differently).
 */
function fengariLossyDecode(bytes: Uint8Array): string {
  let text = "";
  const end = bytes.length;
  for (let at = 0; at < end;) {
    const u0 = bytes[at++]!;
    if (u0 < 0x80) {
      text += String.fromCharCode(u0);
    } else if (u0 < 0xc2 || u0 > 0xf4) {
      text += "�";
    } else if (u0 <= 0xdf) {
      if (at >= end) { text += "�"; continue; }
      const u1 = bytes[at++]!;
      if ((u1 & 0xc0) !== 0x80) { text += "�"; continue; }
      text += String.fromCharCode(((u0 & 0x1f) << 6) + (u1 & 0x3f));
    } else if (u0 <= 0xef) {
      if (at + 1 >= end) { text += "�"; continue; }
      const u1 = bytes[at++]!;
      if ((u1 & 0xc0) !== 0x80) { text += "�"; continue; }
      const u2 = bytes[at++]!;
      if ((u2 & 0xc0) !== 0x80) { text += "�"; continue; }
      text += String.fromCharCode(((u0 & 0x0f) << 12) + ((u1 & 0x3f) << 6) + (u2 & 0x3f));
    } else {
      if (at + 2 >= end) { text += "�"; continue; }
      const u1 = bytes[at++]!;
      if ((u1 & 0xc0) !== 0x80) { text += "�"; continue; }
      const u2 = bytes[at++]!;
      if ((u2 & 0xc0) !== 0x80) { text += "�"; continue; }
      const u3 = bytes[at++]!;
      if ((u3 & 0xc0) !== 0x80) { text += "�"; continue; }
      const point = ((u0 & 0x07) << 18) + ((u1 & 0x3f) << 12) + ((u2 & 0x3f) << 6) + (u3 & 0x3f) - 0x10000;
      text += String.fromCharCode((point >> 10) + 0xd800, (point % 0x400) + 0xdc00);
    }
  }
  return text;
}

/** Bytes at [p, p + n) of the heap as a JS string (short ASCII by char codes, else TextDecoder). */
function decodeAt(p: number, n: number): string {
  const memory = luaHeap();
  if (n < 24) {
    let text = "";
    let at = 0;
    for (; at < n; at++) {
      const code = memory[p + at]!;
      if (code >= 0x80) break;
      text += String.fromCharCode(code);
    }
    if (at === n) return text;
  }
  // As fengari's lua_tojsstring: its replacement decoder (to_jsstring above).
  return to_jsstring(memory.subarray(p, p + n), 0, n, true);
}

function cstring(p: number): LuaString | null {
  if (!p) return null;
  const memory = luaHeap();
  let end = p;
  while (memory[end] !== 0) end++;
  return memory.slice(p, end);
}

const asBytes = (value: LuaString | string): LuaString => (typeof value === "string" ? to_luastring(value) : value);

/** Copies bytes into the scratch area (or a malloc'd block) and answers the pointer; `releaseData()` after use. */
let mallocked = 0;
function putData(source: LuaString): number {
  const n = source.length;
  if (n <= SCRATCH_SIZE) {
    luaHeap().set(source, SCRATCH);
    return SCRATCH;
  }
  const p = x.wl_malloc(n);
  luaHeap().set(source, p);
  mallocked = p;
  return p;
}
function releaseData(): void {
  if (mallocked !== 0) {
    x.wl_free(mallocked);
    mallocked = 0;
  }
}
/** A NUL-terminated copy in the names area (names, keys, chunk names, option strings). */
let nameMallocked = 0;
function putName(name: LuaString | string): number {
  const source = asBytes(name);
  const n = source.length;
  let p = NAMES;
  if (n + 1 > NAMES_SIZE) {
    p = x.wl_malloc(n + 1);
    nameMallocked = p;
  }
  const memory = luaHeap();
  memory.set(source, p);
  memory[p + n] = 0;
  return p;
}
function releaseName(): void {
  if (nameMallocked !== 0) {
    x.wl_free(nameMallocked);
    nameMallocked = 0;
  }
}
const lenOut = (): number => luaView().getUint32(LEN_PTR, true);

// ---------------------------------------------------------------- states and threads
const states = new Map<number, WasmState>();
/** Facade counters for telemetry and tests. */
export const luaWasmStats = { threadsSeen: 0, hostCalls: 0, raises: 0, jsErrors: 0, rangeErrors: 0, poisoned: null as string | null };

function mainState(p: number): LuaState {
  const L: WasmState = { p, l_G: { universe: p } };
  states.set(p, L);
  return L as unknown as LuaState;
}
function stateOf(p: number): LuaState {
  let L = states.get(p);
  if (L === undefined) {
    const main = states.get(x.wl_mainthread(p));
    L = { p, l_G: main ? main.l_G : { universe: p } };
    if (states.size > 50_000) {
      for (const [key, value] of states) if (value.l_G.universe !== key) states.delete(key);
    }
    states.set(p, L);
    luaWasmStats.threadsSeen++;
  }
  return L as unknown as LuaState;
}

// ---------------------------------------------------------------- JS functions
const functions: Fengari.LuaJsFunction[] = [];
const functionIndex = new Map<Fengari.LuaJsFunction, number>();

/** Thrown by a facade call that raised a Lua error (the value is on the stack). */
export const LUA_RAISE: object = Object.freeze({ toString: () => "Lua error raised through the wasm facade" });

/** `WebAssembly.Exception` (not in TypeScript's lib yet): the longjmp of a Lua error inside wasm. */
const WASM_EXCEPTION = (WebAssembly as unknown as { Exception?: abstract new (...args: never[]) => unknown }).Exception;

let lastPtr = 0;
let lastState: LuaState | null = null;
setLuaHostCall((p, index) => {
  luaWasmStats.hostCalls++;
  if (p !== lastPtr) {
    lastState = stateOf(p);
    lastPtr = p;
  }
  try {
    return functions[index]!(lastState!);
  } catch (error) {
    if (error === LUA_RAISE) {
      luaWasmStats.raises++;
      return -1;
    }
    // A longjmp passing through JS frames (an unprotected lua_call made from a host function): let the
    // wasm exception continue to the protected call that owns it.
    if (WASM_EXCEPTION !== undefined && error instanceof WASM_EXCEPTION) throw error;
    luaWasmStats.jsErrors++;
    if (error instanceof RangeError) {
      luaWasmStats.rangeErrors++;
      luaWasmStats.poisoned ??= String(error);
    }
    const message = to_luastring(String(error instanceof Error ? error.message : error));
    x.lua_pushlstring(p, putData(message), message.length);
    releaseData();
    return -1;
  }
});

function pushFunction(L: LuaState, fn: Fengari.LuaJsFunction): void {
  let index = functionIndex.get(fn);
  if (index === undefined) {
    index = functions.length;
    functions.push(fn);
    functionIndex.set(fn, index);
  }
  x.wl_pushjsfunction(ptr(L), index);
}

// ---------------------------------------------------------------- pointers
interface PointerToken { readonly pointer: number }
const tokens = new Map<number, PointerToken>();
function token(p: number): PointerToken | null {
  if (p === 0) return null;
  let found = tokens.get(p);
  if (found === undefined) {
    found = { pointer: p };
    tokens.set(p, found);
  }
  return found;
}

/**
 * Forgets the token `lua_topointer` gave for an object nobody keys on any more (a released frame), so
 * a new table Lua later builds at the same address gets a new token instead of the old one.
 */
export function releaseLuaPointer(pointer: unknown): void {
  const found = pointer as PointerToken | null;
  if (found && tokens.get(found.pointer) === found) tokens.delete(found.pointer);
}

// ---------------------------------------------------------------- errors
function raise(): never {
  throw LUA_RAISE;
}
function argError(L: LuaState, narg: number, extramsg: string): never {
  const p = putName(extramsg);
  x.wl_push_argerror(ptr(L), narg, p);
  releaseName();
  raise();
}
function typeError(L: LuaState, narg: number, type: number): never {
  argError(L, narg, `${typeName(type)} expected, got ${typeName(x.lua_type(ptr(L), narg))}`);
}

// ---------------------------------------------------------------- lua_Debug
class lua_Debug {
  i_ci = -1;
  source: LuaString = new Uint8Array(0);
  short_src: LuaString | null = null;
  what: LuaString | null = null;
  name: LuaString | null = null;
  namewhat: LuaString | null = null;
  currentline = -1;
  linedefined = -1;
  nups = 0;
}

const hasOption = (what: LuaString, code: number): boolean => what.indexOf(code) >= 0;

function pushBytes(L: LuaState, value: LuaString | string): void {
  const source = asBytes(value);
  x.lua_pushlstring(ptr(L), putData(source), source.length);
  releaseData();
}

/** lua_pushfstring's formats: %s %d %f %p %c %%. */
function formatF(format: LuaString, args: readonly unknown[]): LuaString {
  let out = "";
  let arg = 0;
  const text = lossy.decode(format);
  for (let at = 0; at < text.length; at++) {
    const character = text[at]!;
    if (character !== "%" || at + 1 >= text.length) {
      out += character;
      continue;
    }
    const kind = text[++at];
    const value = args[arg];
    if (kind === "%") out += "%";
    else if (kind === "s") { out += value instanceof Uint8Array ? lossy.decode(value) : String(value); arg++; }
    else if (kind === "d") { out += String(Math.trunc(Number(value))); arg++; }
    else if (kind === "f") { out += String(Number(value)); arg++; }
    else if (kind === "c") { out += String.fromCharCode(Number(value)); arg++; }
    else if (kind === "p") {
      const pointer = value && typeof value === "object" && "pointer" in value ? (value as PointerToken).pointer : Number(value) || 0;
      out += `0x${pointer.toString(16).padStart(8, "0")}`;
      arg++;
    } else out += `%${kind}`;
  }
  return to_luastring(out);
}

// ---------------------------------------------------------------- the API
const luaImpl = {
  LUA_REGISTRYINDEX, LUA_ENVIRONINDEX, LUA_GLOBALSINDEX,
  LUA_MULTRET: -1,
  LUA_OK: 0, LUA_YIELD: 1, LUA_ERRRUN: 2, LUA_ERRSYNTAX: 3, LUA_ERRMEM: 4, LUA_ERRERR: 5,
  LUA_TNONE: T.NONE, LUA_TNIL: T.NIL, LUA_TBOOLEAN: T.BOOLEAN, LUA_TLIGHTUSERDATA: T.LIGHTUSERDATA,
  LUA_TNUMBER: T.NUMBER, LUA_TSTRING: T.STRING, LUA_TTABLE: T.TABLE, LUA_TFUNCTION: T.FUNCTION,
  LUA_TUSERDATA: T.USERDATA, LUA_TTHREAD: T.THREAD,
  LUA_OPEQ: 0, LUA_OPLT: 1, LUA_OPLE: 2,
  LUA_MINSTACK: 20,
  lua_Debug,

  lua_close(L: LuaState): void {
    x.lua_close(ptr(L));
    const universe = (L as unknown as WasmState).l_G;
    for (const [key, value] of states) if (value.l_G === universe) states.delete(key);
    lastPtr = 0;
    lastState = null;
  },
  lua_gettop: (L: LuaState) => x.lua_gettop(ptr(L)),
  lua_settop: (L: LuaState, index: number) => x.lua_settop(ptr(L), index),
  lua_pop: (L: LuaState, n: number) => x.lua_settop(ptr(L), -n - 1),
  lua_pushvalue: (L: LuaState, index: number) => x.lua_pushvalue(ptr(L), index),
  lua_remove: (L: LuaState, index: number) => x.lua_remove(ptr(L), index),
  lua_insert: (L: LuaState, index: number) => x.lua_insert(ptr(L), index),
  lua_replace: (L: LuaState, index: number) => x.lua_replace(ptr(L), index),
  lua_checkstack: (L: LuaState, n: number) => x.lua_checkstack(ptr(L), n) !== 0,
  lua_absindex: (L: LuaState, index: number) => (index > 0 || index <= LUA_REGISTRYINDEX ? index : x.lua_gettop(ptr(L)) + index + 1),
  lua_upvalueindex: (index: number) => LUA_GLOBALSINDEX - index,

  lua_type: (L: LuaState, index: number) => x.lua_type(ptr(L), index),
  lua_typename: (_L: LuaState, type: number) => to_luastring(typeName(type)),
  lua_isnil: (L: LuaState, index: number) => x.lua_type(ptr(L), index) === T.NIL,
  lua_isnoneornil: (L: LuaState, index: number) => x.lua_type(ptr(L), index) <= T.NIL,
  lua_isboolean: (L: LuaState, index: number) => x.lua_type(ptr(L), index) === T.BOOLEAN,
  lua_istable: (L: LuaState, index: number) => x.lua_type(ptr(L), index) === T.TABLE,
  lua_isfunction: (L: LuaState, index: number) => x.lua_type(ptr(L), index) === T.FUNCTION,
  lua_isnumber: (L: LuaState, index: number) => x.lua_isnumber(ptr(L), index) !== 0,
  lua_isstring: (L: LuaState, index: number) => x.lua_isstring(ptr(L), index) !== 0,
  lua_iscfunction: (L: LuaState, index: number) => x.lua_iscfunction(ptr(L), index) !== 0,
  // Lua 5.1 has no integer subtype: no number is an "integer" in the 5.3 sense.
  lua_isinteger: (_L: LuaState, _index: number) => false,

  lua_tonumber: (L: LuaState, index: number) => x.lua_tonumber(ptr(L), index),
  lua_tonumberx: (L: LuaState, index: number) => (x.lua_isnumber(ptr(L), index) !== 0 ? x.lua_tonumber(ptr(L), index) : false),
  lua_tointeger: (L: LuaState, index: number) => x.lua_tointeger(ptr(L), index),
  lua_toboolean: (L: LuaState, index: number) => x.lua_toboolean(ptr(L), index) !== 0,
  lua_tolstring(L: LuaState, index: number): LuaString | null {
    const p = x.wl_tolstring(ptr(L), index);
    if (p === 0) return null;
    return luaHeap().slice(p, p + lenOut());
  },
  lua_tojsstring(L: LuaState, index: number): string | null {
    const p = x.wl_tolstring(ptr(L), index);
    if (p === 0) return null;
    return decodeAt(p, lenOut());
  },
  lua_topointer: (L: LuaState, index: number) => token(x.lua_topointer(ptr(L), index)),
  lua_rawlen: (L: LuaState, index: number) => x.lua_objlen(ptr(L), index),
  lua_objlen: (L: LuaState, index: number) => x.lua_objlen(ptr(L), index),
  lua_touserdata: (L: LuaState, index: number) => x.lua_touserdata(ptr(L), index),
  lua_tothread(L: LuaState, index: number): LuaState | null {
    const p = x.lua_tothread(ptr(L), index);
    return p === 0 ? null : stateOf(p);
  },

  lua_pushnil: (L: LuaState) => x.lua_pushnil(ptr(L)),
  lua_pushnumber: (L: LuaState, n: number) => x.lua_pushnumber(ptr(L), n),
  lua_pushinteger: (L: LuaState, n: number) => x.lua_pushinteger(ptr(L), n),
  lua_pushboolean: (L: LuaState, b: unknown) => x.lua_pushboolean(ptr(L), b ? 1 : 0),
  lua_pushstring(L: LuaState, s: LuaString | string | null | undefined): LuaString | null {
    if (s === null || s === undefined) {
      x.lua_pushnil(ptr(L));
      return null;
    }
    pushBytes(L, s);
    return asBytes(s);
  },
  lua_pushlstring(L: LuaState, value: LuaString | string, length?: number): LuaString {
    let source = asBytes(value);
    if (length !== undefined && length !== source.length) source = source.subarray(0, length);
    pushBytes(L, source);
    return source;
  },
  lua_pushliteral(L: LuaState, s: string): LuaString {
    pushBytes(L, s);
    return to_luastring(s);
  },
  lua_pushfstring(L: LuaState, format: LuaString | string, ...args: unknown[]): LuaString {
    const text = formatF(asBytes(format), args);
    pushBytes(L, text);
    return text;
  },
  lua_pushjsfunction: (L: LuaState, fn: Fengari.LuaJsFunction) => pushFunction(L, fn),
  lua_pushcfunction: (L: LuaState, fn: Fengari.LuaJsFunction) => pushFunction(L, fn),
  lua_pushjsclosure(L: LuaState, fn: Fengari.LuaJsFunction, upvalues: number): void {
    if (upvalues !== 0) throw new Error("lua wasm facade: lua_pushjsclosure with upvalues is not implemented");
    pushFunction(L, fn);
  },
  lua_pushglobaltable: (L: LuaState) => x.lua_pushvalue(ptr(L), LUA_GLOBALSINDEX),
  lua_pushlightuserdata: (L: LuaState, p: unknown) => x.lua_pushlightuserdata(ptr(L), typeof p === "number" ? p : 0),

  lua_createtable: (L: LuaState, narr: number, nrec: number) => x.lua_createtable(ptr(L), narr, nrec),
  lua_newtable: (L: LuaState) => x.lua_createtable(ptr(L), 0, 0),
  lua_newuserdata: (L: LuaState, size: number) => x.lua_newuserdata(ptr(L), size),
  lua_getmetatable: (L: LuaState, index: number) => x.lua_getmetatable(ptr(L), index) !== 0,
  lua_setmetatable: (L: LuaState, index: number) => x.lua_setmetatable(ptr(L), index),

  lua_gettable: (L: LuaState, index: number) => x.wl_gettable(ptr(L), index),
  lua_getfield(L: LuaState, index: number, name: LuaString | string): number {
    const type = x.wl_getfield(ptr(L), index, putName(name));
    releaseName();
    return type;
  },
  lua_rawget: (L: LuaState, index: number) => x.wl_rawget(ptr(L), index),
  lua_rawgeti: (L: LuaState, index: number, n: number) => x.wl_rawgeti(ptr(L), index, n),
  lua_getglobal(L: LuaState, name: LuaString | string): number {
    const type = x.wl_getglobal(ptr(L), putName(name));
    releaseName();
    return type;
  },
  lua_settable: (L: LuaState, index: number) => x.lua_settable(ptr(L), index),
  lua_setfield(L: LuaState, index: number, name: LuaString | string): void {
    x.lua_setfield(ptr(L), index, putName(name));
    releaseName();
  },
  lua_rawset: (L: LuaState, index: number) => x.lua_rawset(ptr(L), index),
  lua_rawseti: (L: LuaState, index: number, n: number) => x.lua_rawseti(ptr(L), index, n),
  lua_setglobal(L: LuaState, name: LuaString | string): void {
    x.wl_setglobal(ptr(L), putName(name));
    releaseName();
  },
  lua_next: (L: LuaState, index: number) => x.lua_next(ptr(L), index) !== 0,
  lua_concat: (L: LuaState, n: number) => x.lua_concat(ptr(L), n),
  lua_rawequal: (L: LuaState, a: number, b: number) => x.lua_rawequal(ptr(L), a, b) !== 0,
  lua_compare(L: LuaState, a: number, b: number, op: number): number {
    if (op === 0) return x.lua_equal(ptr(L), a, b);
    if (op === 1) return x.lua_lessthan(ptr(L), a, b);
    return x.lua_lessthan(ptr(L), b, a) === 0 ? 1 : 0;
  },
  lua_getupvalue(L: LuaState, funcIndex: number, n: number): LuaString | null {
    const p = x.lua_getupvalue(ptr(L), funcIndex, n);
    return p === 0 ? null : cstring(p);
  },
  lua_upvaluejoin(): never {
    throw new Error("lua wasm facade: lua_upvaluejoin does not exist in Lua 5.1 (setfenv is native there)");
  },

  lua_call: (L: LuaState, nargs: number, nresults: number) => x.lua_call(ptr(L), nargs, nresults),
  lua_pcall: (L: LuaState, nargs: number, nresults: number, msgh: number) => x.lua_pcall(ptr(L), nargs, nresults, msgh),
  lua_error: (_L: LuaState): never => raise(),
  lua_gc: (L: LuaState, what: number, data: number) => x.lua_gc(ptr(L), what, data),

  lua_getstack(L: LuaState, level: number, ar: lua_Debug): number {
    const ci = x.wl_getstack(ptr(L), level);
    if (ci < 0) return 0;
    ar.i_ci = ci;
    return 1;
  },
  lua_getinfo(L: LuaState, what: LuaString | string, ar: lua_Debug): number {
    const options = asBytes(what);
    const ok = x.wl_getinfo(ptr(L), putName(options), options[0] === 62 ? -1 : ar.i_ci);
    releaseName();
    if (!ok) return 0;
    if (hasOption(options, 83)) { // S
      ar.source = cstring(x.wl_ar_source()) ?? new Uint8Array(0);
      ar.short_src = cstring(x.wl_ar_short_src());
      ar.what = cstring(x.wl_ar_what());
      ar.linedefined = x.wl_ar_linedefined();
    }
    if (hasOption(options, 108)) ar.currentline = x.wl_ar_currentline(); // l
    if (hasOption(options, 110)) { // n
      ar.name = cstring(x.wl_ar_name());
      ar.namewhat = cstring(x.wl_ar_namewhat());
    }
    if (hasOption(options, 117)) ar.nups = x.wl_ar_nups(); // u
    return 1;
  },
};

const lauxlibImpl = {
  LUA_REFNIL: -1,
  LUA_NOREF: -2,
  luaL_newstate(): LuaState {
    const p = x.wl_newstate();
    if (p === 0) throw new Error("lua wasm facade: luaL_newstate failed");
    return mainState(p);
  },
  luaL_loadbuffer(L: LuaState, buffer: LuaString | string, size: number | null | undefined, chunkName: LuaString | string | null | undefined): number {
    const source = asBytes(buffer);
    const length = size === null || size === undefined ? source.length : size;
    const data = putData(length === source.length ? source : source.subarray(0, length));
    const name = putName(chunkName ?? source);
    const status = x.wl_loadbuffer(ptr(L), data, length, name);
    releaseName();
    releaseData();
    return status;
  },
  luaL_loadstring(L: LuaState, s: LuaString | string): number {
    return lauxlibImpl.luaL_loadbuffer(L, asBytes(s), null, asBytes(s));
  },
  luaL_ref: (L: LuaState, t: number) => x.luaL_ref(ptr(L), t),
  luaL_unref: (L: LuaState, t: number, ref: number) => x.luaL_unref(ptr(L), t, ref),
  luaL_traceback(L: LuaState, L1: LuaState, message: LuaString | string | null | undefined, level: number): void {
    let p = 0;
    let n = 0;
    if (message !== null && message !== undefined) {
      const source = asBytes(message);
      p = putData(source);
      n = source.length;
    }
    x.wl_traceback(ptr(L), ptr(L1), p, n, level);
    releaseData();
  },
  luaL_error(L: LuaState, message: LuaString | string): never {
    const source = asBytes(message);
    x.wl_push_error(ptr(L), putData(source), source.length);
    releaseData();
    raise();
  },
  luaL_argerror: (L: LuaState, narg: number, extramsg: string): never => argError(L, narg, extramsg),
  luaL_typename: (L: LuaState, index: number) => to_luastring(typeName(x.lua_type(ptr(L), index))),
  luaL_checkany(L: LuaState, narg: number): void {
    if (x.lua_type(ptr(L), narg) === T.NONE) argError(L, narg, "value expected");
  },
  luaL_checktype(L: LuaState, narg: number, type: number): void {
    if (x.lua_type(ptr(L), narg) !== type) typeError(L, narg, type);
  },
  luaL_checknumber(L: LuaState, narg: number): number {
    const value = x.lua_tonumber(ptr(L), narg);
    if (value === 0 && x.lua_isnumber(ptr(L), narg) === 0) typeError(L, narg, T.NUMBER);
    return value;
  },
  luaL_checkinteger(L: LuaState, narg: number): number {
    const value = x.lua_tointeger(ptr(L), narg);
    if (value === 0 && x.lua_isnumber(ptr(L), narg) === 0) typeError(L, narg, T.NUMBER);
    return value;
  },
  luaL_optinteger(L: LuaState, narg: number, fallback: number): number {
    return x.lua_type(ptr(L), narg) <= T.NIL ? fallback : lauxlibImpl.luaL_checkinteger(L, narg);
  },
  luaL_optnumber(L: LuaState, narg: number, fallback: number): number {
    return x.lua_type(ptr(L), narg) <= T.NIL ? fallback : lauxlibImpl.luaL_checknumber(L, narg);
  },
  luaL_checklstring(L: LuaState, narg: number): LuaString {
    const p = x.wl_tolstring(ptr(L), narg);
    if (p === 0) typeError(L, narg, T.STRING);
    return luaHeap().slice(p, p + lenOut());
  },
  luaL_checkstring(L: LuaState, narg: number): LuaString {
    return lauxlibImpl.luaL_checklstring(L, narg);
  },
  luaL_callmeta(L: LuaState, index: number, event: LuaString | string): boolean {
    const result = x.luaL_callmeta(ptr(L), index, putName(event));
    releaseName();
    return result !== 0;
  },
};

const lualibImpl = {
  luaL_openlibs: (L: LuaState) => x.wl_openlibs(ptr(L)),
};

/** fengari's `lua` over the wasm VM. */
export const lua = luaImpl as unknown as typeof Fengari.lua;
/** fengari's `lauxlib` over the wasm VM. */
export const lauxlib = lauxlibImpl as unknown as typeof Fengari.lauxlib;
/** fengari's `lualib` over the wasm VM. */
export const lualib = lualibImpl as unknown as typeof Fengari.lualib;
export const FENGARI_VERSION = "PUC Lua 5.1.5 in WebAssembly (wasi-sdk 34.0)";

/**
 * fengari-interop's scalar `push`: undefined/null → nil, boolean, number (5.1: always a double), string.
 * Like fengari-interop, it calls the VM directly rather than through the `lua` object, so a caller (or a
 * test) that wraps a method on `lua` does not see interop's own pushes.
 */
export function push(L: LuaState, value: unknown): void {
  switch (typeof value) {
    case "undefined": x.lua_pushnil(ptr(L)); return;
    case "boolean": x.lua_pushboolean(ptr(L), value ? 1 : 0); return;
    case "number": x.lua_pushnumber(ptr(L), value); return;
    case "string": pushBytes(L, to_luastring(value)); return;
    default:
      if (value === null) {
        x.lua_pushnil(ptr(L));
        return;
      }
      throw new TypeError("lua wasm facade: only scalars can be pushed");
  }
}

/** fengari-interop's scalar `tojs`: nil → undefined, booleans, numbers, strings; anything else → undefined. */
export function tojs(L: LuaState, index: number): unknown {
  switch (x.lua_type(ptr(L), index)) {
    case T.BOOLEAN: return x.lua_toboolean(ptr(L), index) !== 0;
    case T.NUMBER: return x.lua_tonumber(ptr(L), index);
    case T.STRING: {
      const p = x.wl_tolstring(ptr(L), index);
      return p === 0 ? undefined : decodeAt(p, lenOut());
    }
    default: return undefined;
  }
}

/** 5.1's own `setfenv`/`getfenv`/`newproxy`, which `wl_openlibs` keeps aside, put back into `_G`. */
export function luaWasmRestoreEnvironment(L: LuaState): void {
  x.wl_restore_env(ptr(L));
}

/** Pushes the C message handler with GlueLua's traceback text (no JS crossing per error). */
export function luaWasmPushTracebackHandler(L: LuaState): void {
  x.wl_push_traceback_handler(ptr(L));
}

/** Sizes of the facade's JS-side tables and the module's memory, for telemetry and leak tests. */
export function luaWasmFootprint(): { functions: number; tokens: number; states: number; memoryBytes: number; load: typeof luaWasmLoad } {
  return { functions: functions.length, tokens: tokens.size, states: states.size, memoryBytes: luaWasm.memory.buffer.byteLength, load: luaWasmLoad };
}

/** The Lua heap of a state in KB (`collectgarbage("count")`). */
export function luaWasmHeapKb(L: LuaState): number {
  return x.lua_gc(ptr(L), 3 /* LUA_GCCOUNT */, 0) + x.lua_gc(ptr(L), 4 /* LUA_GCCOUNTB */, 0) / 1024;
}
