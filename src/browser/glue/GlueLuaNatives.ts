/**
 * 3.27 (03.10, L5): Lua globals the preamble used to give in Lua, as host C functions.
 *
 * `strsplit(delimiters, text [, pieces])` — Wow.exe 3.3.5a (12340) 0x00816a60 (registration
 * 0x00a443c0; notes .runtime/re-2026-10-03/l5-runtime/g1.c): every byte of `delimiters` is a
 * delimiter (a set, not a substring: `strsplit(",;", "a,b;c")` is three pieces); `pieces`
 * (`luaL_optinteger`, default 0) stops after `pieces − 1` cuts and leaves the rest whole; 0 means
 * no limit, and 1 or a negative count gives the text back uncut. Both strings are read as C
 * strings — up to their first NUL byte. Too many pieces for the stack raise "strsplit(): Stack
 * overflow", as the client's does. The preamble's Lua version looked for the delimiter as one
 * substring and counted `pieces` one short.
 *
 * `string.format` / `format` — Wow.exe's str_format (GlueLuaFormat.ts).
 *
 * (Until ARC-4 A6, 12.10, this file also gave fengari's Lua 5.3 a host `next` in PUC's traversal order,
 * and through GlueLuaBase51.ts 5.1's `tostring`, `pairs`, `ipairs` and `math.fmod`; PUC 5.1, the wasm
 * VM, has its own.)
 */
import { lauxlib, lua as luaApi, to_luastring, type LuaState } from "../lua/LuaVm.js";
import { installGlueLuaFormat } from "./GlueLuaFormat.js"; // 05.10-3.27

/** The C-API calls this file needs beyond LuaShapes.ts, named one by one; LuaApi.ts implements each. */
interface ExtraCalls {
  lua_replace(L: LuaState, index: number): void;
  lua_pushlstring(L: LuaState, bytes: Uint8Array, length: number): void;
}
interface AuxCalls {
  luaL_checklstring(L: LuaState, arg: number): Uint8Array;
  luaL_checknumber(L: LuaState, arg: number): number;
}
const lua = luaApi as typeof luaApi & ExtraCalls;
const aux = lauxlib as typeof lauxlib & AuxCalls;

/** Bytes of a string argument up to its first NUL, as the client's C string sees them. */
function cString(L: LuaState, index: number): Uint8Array {
  // A whole number below 1e15 is spelt as JS's String spells it (written for fengari's 5.3, whose
  // luaL_checklstring made 3.0 "3.0"); every other number by luaL_checklstring, "%.14g". The two agree
  // except on -0 ("0" here) and 1e14 ≤ |n| < 1e15 (all digits here, "1e+014" in "%.14g").
  if (lua.lua_type(L, index) === lua.LUA_TNUMBER) {
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
 * Install `strsplit` and Wow.exe's str_format (0x00853c50) as `string.format` and `format`
 * (GlueLuaFormat.ts). GlueLuaVm calls this after its preamble and before Wow.exe's compat chunk, so
 * `string.split` (compat: `string.split = strsplit`) is this one too.
 */
export function installGlueLuaNatives(L: LuaState): void {
  lua.lua_pushjsfunction(L, strsplit);
  lua.lua_setglobal(L, to_luastring("strsplit"));
  installGlueLuaFormat(L);
}
