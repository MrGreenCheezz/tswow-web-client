/**
 * 3.27 (03.10, L5): two Lua globals the 5.1 preamble used to give in Lua, as host C functions.
 *
 * `next` — the preamble's `next` (GlueLua.ts) restores PUC-Lua's traversal order (the array run
 * 1..n ascending, then the rest) but measured the run again on every step: `_arrayLength` is a
 * `rawget` loop up to the first hole, so a walk with `next` was O(n²) — 2·10⁶ `rawget` calls for a
 * 2000-entry list (`SecureNext` in OptionsFrameTemplates.lua and InterfaceOptionsFrame.lua is
 * `securecall(next, …)`). Here the run is measured once per walk: `next(t, nil)` starts a walk and
 * forgets the table's length, the first step with a key measures it and remembers it in a WeakMap
 * keyed by the table (fengari has no weak tables; the map lets the table go). The order is the
 * preamble's — `pairs` measures once per loop as well, so `next` and `pairs` now agree on a table
 * changed during the walk: a cleared entry of the run is skipped rather than handed out as nil, and
 * no entry is handed out twice. The preamble's Lua `next` stays in its text as the oracle.
 *
 * L5-review (04.10): `next` has no walk of its own to remember the run in — `if next(t) then` or a
 * nested `for k in next, t` inside a walk is another walk of the same table — so the run is the
 * table's, like PUC's array part, which a cleared field never shrinks (only an insertion's rehash
 * does): it grows when a new walk that handed out `t[1]` finds entries right after it, and never
 * shrinks. Keys 1..n are then always walked by index and the rest by the raw order without 1..n,
 * so clearing any field, at any time, moves no key between the two (tests/glue-lua-next-walks: the
 * wipe that asks `next(t)` lost every key after the first, a nested walk past a cleared hole handed
 * keys out twice). A table nothing changes walks in the oracle's order; one whose run lost entries
 * since an earlier walk keeps them in index order, as PUC does. (L5b, 04.10: `pairs` is 5.1's now
 * and answers this `next` — GlueLuaBase51.ts — so a `pairs` loop walks every table as `next` does;
 * the preamble's measured its own run and walked such a table in raw order.)
 *
 * `strsplit(delimiters, text [, pieces])` — Wow.exe 3.3.5a (12340) 0x00816a60 (registration
 * 0x00a443c0; notes .runtime/re-2026-10-03/l5-runtime/g1.c): every byte of `delimiters` is a
 * delimiter (a set, not a substring: `strsplit(",;", "a,b;c")` is three pieces); `pieces`
 * (`luaL_optinteger`, default 0) stops after `pieces − 1` cuts and leaves the rest whole; 0 means
 * no limit, and 1 or a negative count gives the text back uncut. Both strings are read as C
 * strings — up to their first NUL byte. Too many pieces for the stack raise "strsplit(): Stack
 * overflow", as the client's does. The preamble's Lua version looked for the delimiter as one
 * substring and counted `pieces` one short.
 */
import { lauxlib, lua as luaApi, to_luastring, type LuaState } from "fengari";
import { installGlueLuaBase51 } from "./GlueLuaBase51.js"; // L5b
import { installGlueLuaFormat } from "./GlueLuaFormat.js"; // 05.10-3.27

/**
 * The C-API calls this file needs beyond src/types/fengari.d.ts, named one by one (as GlueLua's
 * `checkStack` names `lua_checkstack`); fengari implements every one of them.
 */
interface Lua53Calls {
  lua_isinteger(L: LuaState, index: number): boolean;
  lua_replace(L: LuaState, index: number): void;
  lua_pushlstring(L: LuaState, bytes: Uint8Array, length: number): void;
}
interface AuxCalls {
  luaL_checktype(L: LuaState, arg: number, type: number): void;
  luaL_checklstring(L: LuaState, arg: number): Uint8Array;
  luaL_checknumber(L: LuaState, arg: number): number;
}
const lua = luaApi as typeof luaApi & Lua53Calls;
const aux = lauxlib as typeof lauxlib & AuxCalls;

/**
 * L5-review: each table's run n — keys 1..n are walked by index, the rest in raw order. It only
 * grows (see the header); `pending`: a walk began by handing out `t[1]`, and its step with key 1
 * looks for entries after the run.
 */
const runs = new WeakMap<object, number>();
const pending = new WeakSet<object>();

/** `from`..n with no hole, n at least `from − 1`: the run the preamble's `_arrayLength` measures. */
function arrayRun(L: LuaState, from = 1): number {
  let n = from - 1;
  while (lua.lua_rawgeti(L, 1, n + 1) !== lua.LUA_TNIL) {
    lua.lua_pop(L, 1);
    n += 1;
  }
  lua.lua_pop(L, 1);
  return n;
}

/** An integer key inside 1..n — one the array phase hands out (`_isArrayKey`). */
function runKey(L: LuaState, index: number, n: number): number {
  if (lua.lua_type(L, index) !== lua.LUA_TNUMBER) return 0;
  const key = lua.lua_tonumber(L, index);
  return Number.isInteger(key) && key >= 1 && key <= n ? key : 0;
}

/** The rest of the table after the key at index 2 (nil: from the start), integers 1..n skipped. */
function afterRun(L: LuaState, n: number): number {
  for (;;) {
    if (!lua.lua_next(L, 1)) {
      lua.lua_pushnil(L);
      return 1;
    }
    if (n > 0 && runKey(L, -2, n) !== 0) {
      lua.lua_pop(L, 1);
      continue;
    }
    return 2;
  }
}

/**
 * L5-review: the smallest key of `from`..`to` the table holds, or 0. By index while the run is
 * dense; past a few holes the index scan and a raw walk of the table go in step and the first to
 * finish answers, so a long run the table has since lost costs what the table holds, not the run.
 */
function firstInRun(L: LuaState, from: number, to: number): number {
  let index = from;
  for (const end = Math.min(to, from + 7); index <= end; index += 1) {
    const held = lua.lua_rawgeti(L, 1, index) !== lua.LUA_TNIL;
    lua.lua_pop(L, 1);
    if (held) return index;
  }
  if (index > to) return 0;
  let least = 0;
  lua.lua_pushnil(L);
  for (;;) {
    if (index > to) {
      lua.lua_pop(L, 1);
      return 0;
    }
    const held = lua.lua_rawgeti(L, 1, index) !== lua.LUA_TNIL;
    lua.lua_pop(L, 1);
    if (held) {
      lua.lua_pop(L, 1);
      return index;
    }
    index += 1;
    // Every key below `index` is absent, so whatever the raw walk finds is at least `index`.
    if (!lua.lua_next(L, 1)) return least;
    lua.lua_pop(L, 1);
    if (lua.lua_type(L, -1) === lua.LUA_TNUMBER) {
      const key = lua.lua_tonumber(L, -1);
      if (Number.isInteger(key) && key >= from && key <= to && (least === 0 || key < least)) least = key;
    }
  }
}

/** The walk's step from `from`: the next key of the run up to n, else the rest of the table from its start. */
function stepFrom(L: LuaState, from: number, n: number): number {
  const index = firstInRun(L, from, n);
  lua.lua_settop(L, 1);
  if (index !== 0) {
    lua.lua_pushinteger(L, index);
    lua.lua_rawgeti(L, 1, index);
    return 2;
  }
  lua.lua_pushnil(L);
  return afterRun(L, n);
}

/** A key that is the number 1, integer or float (`next(t, k + 0.0)`), as `_isArrayKey` accepts it. */
function isOne(L: LuaState, index: number): boolean {
  return lua.lua_type(L, index) === lua.LUA_TNUMBER && lua.lua_tonumber(L, index) === 1;
}

function next(L: LuaState): number {
  aux.luaL_checktype(L, 1, lua.LUA_TTABLE);
  lua.lua_settop(L, 2);
  const table = lua.lua_topointer(L, 1) as object;
  if (lua.lua_isnil(L, 2)) {
    // L5-review: a new walk. With `t[1]` it hands that out and its step with key 1 looks for growth;
    // without, it walks the run the table has (an emptiness check inside another walk changes nothing).
    if (lua.lua_rawgeti(L, 1, 1) !== lua.LUA_TNIL) {
      pending.add(table);
      lua.lua_pushinteger(L, 1);
      lua.lua_insert(L, -2);
      return 2;
    }
    lua.lua_pop(L, 1);
    let n = runs.get(table);
    if (n === undefined) runs.set(table, (n = 0));
    return stepFrom(L, 2, n);
  }
  let n = runs.get(table);
  if (pending.has(table) && isOne(L, 2)) {
    // L5-review: the walk handed out 1 (the body may have cleared it — the `wipe` idiom): the run
    // grows by what follows it, and never shrinks.
    pending.delete(table);
    n = arrayRun(L, Math.max(n ?? 0, 1) + 1);
    runs.set(table, n);
  } else if (n === undefined) {
    // A walk resumed at a key on a table no walk has measured: the preamble's run.
    n = arrayRun(L, 1);
    runs.set(table, n);
  }
  const key = runKey(L, 2, n);
  if (key === 0) return afterRun(L, n);
  return stepFrom(L, key + 1, n);
}

/** Bytes of a string argument up to its first NUL, as the client's C string sees them. */
function cString(L: LuaState, index: number): Uint8Array {
  // 5.1 spelt a whole float without ".0"; luaL_checklstring would convert 3.0 to "3.0" in place.
  if (lua.lua_type(L, index) === lua.LUA_TNUMBER && !lua.lua_isinteger(L, index)) {
    const value = lua.lua_tonumber(L, index);
    if (Number.isInteger(value) && Math.abs(value) < 1e15) {
      lua.lua_pushstring(L, to_luastring(String(value)));
      lua.lua_replace(L, index);
    }
  }
  const bytes = aux.luaL_checklstring(L, index);
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}

const STACK_OVERFLOW = to_luastring("strsplit(): Stack overflow");
/** The delimiter bytes of the call in progress (1), all 0 between calls. */
const delimiterSet = new Uint8Array(256);

/**
 * A number as the client's `lua_tointeger` makes it an int (0x0084e070, through luaL_optinteger
 * 0x0084fbd0/0x0084fb60): FISTP, round to nearest, a tie to the even one (the FPU's default mode).
 */
function fistp(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function strsplit(L: LuaState): number {
  const delimiters = cString(L, 1);
  const text = cString(L, 2);
  const pieces = lua.lua_type(L, 3) <= lua.LUA_TNIL ? 0 : fistp(aux.luaL_checknumber(L, 3));
  lua.lua_settop(L, 0);
  let start = 0;
  let count = 0;
  if ((pieces === 0 || pieces > 1) && delimiters.length > 0) {
    // One shared table of the set's bytes, cleared again whatever happens: no allocation per call.
    for (const byte of delimiters) delimiterSet[byte] = 1;
    try {
      for (let index = 0; index < text.length; index += 1) {
        if (delimiterSet[text[index]!] === 0) continue;
        count += 1;
        if (!lua.lua_checkstack(L, 1)) return raise(L);
        lua.lua_pushlstring(L, text.subarray(start, index), index - start);
        start = index + 1;
        if (count === pieces - 1) break;
      }
    } finally {
      for (const byte of delimiters) delimiterSet[byte] = 0;
    }
  }
  if (!lua.lua_checkstack(L, 1)) return raise(L);
  lua.lua_pushlstring(L, text.subarray(start), text.length - start);
  return count + 1;
}

function raise(L: LuaState): number {
  lua.lua_settop(L, 0);
  lua.lua_pushstring(L, STACK_OVERFLOW);
  return lua.lua_error(L);
}

/**
 * Install `next` and `strsplit` as globals. GlueLuaVm calls this after its preamble and before
 * Wow.exe's compat chunk, so `string.split` (compat: `string.split = strsplit`) is this one too.
 * L5b (04.10): also 5.1's `tostring`, `pairs` (answering this `next`), `ipairs` and `math.fmod`
 * (GlueLuaBase51.ts).
 */
export function installGlueLuaNatives(L: LuaState): void {
  lua.lua_pushjsfunction(L, next);
  lua.lua_setglobal(L, to_luastring("next"));
  lua.lua_pushjsfunction(L, strsplit);
  lua.lua_setglobal(L, to_luastring("strsplit"));
  // L5b: 5.1's `tostring`, `pairs` (over this `next`), `ipairs` and `math.fmod` (GlueLuaBase51.ts).
  installGlueLuaBase51(L, next);
  // 05.10-3.27: Wow.exe's str_format (0x00853c50) as `string.format` and `format` (GlueLuaFormat.ts).
  installGlueLuaFormat(L);
}
