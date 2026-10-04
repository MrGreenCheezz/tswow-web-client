/**
 * 3.27 (04.10, L5b): Lua 5.1 base functions as Wow.exe 3.3.5a (12340) has them, as host C functions
 * installed after the preamble (GlueLuaNatives.installGlueLuaNatives). Notes:
 * .runtime/re-2026-10-04/l5b/h1.c (registration table: `tostring` 0x00a47d00 → 0x00854a20, `fmod`
 * 0x00a47658 → 0x008512c0; `pairs`/`ipairs` are made by the base library's auxopen at 0x00854fc2).
 *
 * `tostring` — 0x00854a20: one argument required (luaL_checkany); a `__tostring` metamethod answers
 * whatever it returns (luaL_callmeta, no string check); a number is converted by 0x00856ea0,
 * `sprintf("%.14g")` of the MSVC runtime the client links (its "1#INF"/"1#IND"/"1#QNAN" strings
 * are at 0x009e4adc/0x009e4ae4/0x009e4ad4): fourteen significant digits, trailing zeros dropped,
 * the exponent form below 1e-4 and from 1e14 on, with at least three exponent digits ("1e+015"),
 * "-0" for negative zero, "1.#INF"/"-1.#INF", and "-1.#IND" for 0/0's NaN. The preamble's `tostring`
 * formatted a whole float with fengari's "%d", which needs a 32-bit integer: any whole float from
 * 2^31 on — `GetTime() * 1000`, an epoch millisecond — raised «number has no integer
 * representation». Not reproduced: a NaN whose sign bit is clear prints "1.#QNAN" in the client
 * (JS keeps no NaN sign), and the integer `-0` of fengari's lexer is 0 ("0" where 5.1 says "-0").
 *
 * `pairs` — 0x008546e0: `luaL_checktype(1, table)`, then the base library's own `next` (an upvalue),
 * the table and nil; 5.1 has no `__pairs`. Here that `next` is the native one (GlueLuaNatives.ts),
 * so a `pairs` loop and a `next` loop walk a table alike, always: the preamble's `pairs` measured
 * the table's array run anew per loop, and after a run lost keys (cleared since an earlier `next`
 * walk) it walked them in raw order where `next` — like PUC's array part — keeps index order.
 *
 * `ipairs` — 0x00854770 with 0x00854720: `luaL_checktype(1, table)`, then the iterator, the table
 * and 0; the iterator reads `t[i + 1]` raw (lua_rawgeti) and stops at the first nil. fengari's 5.3
 * `ipairs` goes through `__index` (and accepts any value): a proxy table yielded its prototype's
 * array, and an `__index` that answers every key never ended the loop.
 *
 * `math.fmod` — 0x008512c0: both arguments as doubles, the CRT's fmod (0x0088d93a): a zero divisor
 * is NaN, not fengari's «bad argument #2 to 'fmod' (zero)» (5.3's integer branch). Two integer
 * arguments still answer an integer here, so `"x" .. mod(7, 3)` stays "x1" rather than 5.3's "x1.0".
 * (The `%` operator on two integers with a zero divisor is fengari's VM and still raises.)
 */
import { lauxlib, lua as luaApi, to_luastring, type LuaState } from "fengari";

/** The C-API calls this file needs beyond src/types/fengari.d.ts; fengari implements each one. */
interface Lua53Calls {
  lua_isinteger(L: LuaState, index: number): boolean;
  lua_pushfstring(L: LuaState, format: Uint8Array, ...args: unknown[]): Uint8Array;
}
interface AuxCalls {
  luaL_checkany(L: LuaState, arg: number): void;
  luaL_checktype(L: LuaState, arg: number, type: number): void;
  luaL_checkinteger(L: LuaState, arg: number): number;
  luaL_checknumber(L: LuaState, arg: number): number;
  luaL_callmeta(L: LuaState, index: number, event: Uint8Array): boolean;
  luaL_typename(L: LuaState, index: number): Uint8Array;
}
const lua = luaApi as typeof luaApi & Lua53Calls;
const aux = lauxlib as typeof lauxlib & AuxCalls;

const TOSTRING_EVENT = to_luastring("__tostring");
const POINTER_FORMAT = to_luastring("%s: %p");
const NIL_TEXT = to_luastring("nil");
const TRUE_TEXT = to_luastring("true");
const FALSE_TEXT = to_luastring("false");

/**
 * A number as Wow.exe's lua_Number → string conversion (0x00856ea0) writes it: MSVC `"%.14g"`.
 * Exported for the host's own text built from Lua numbers.
 */
export function lua51NumberText(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  // Fourteen digits or fewer: the integer itself (the common case, ids and counts).
  if (Number.isInteger(value) && value > -1e14 && value < 1e14) return String(value);
  if (value !== value) return "-1.#IND";
  if (value === Infinity) return "1.#INF";
  if (value === -Infinity) return "-1.#INF";
  // d.ddddddddddddde±x: fourteen significant digits, correctly rounded, ties away from zero.
  const scientific = value.toExponential(13);
  const at = scientific.indexOf("e");
  const exponent = Number(scientific.slice(at + 1));
  const sign = value < 0 ? "-" : "";
  const digits = scientific.slice(sign.length, at).replace(".", "");
  const significant = digits.replace(/0+$/, "");
  if (exponent < -4 || exponent >= 14) {
    const mantissa = significant.length > 1 ? `${significant[0]}.${significant.slice(1)}` : significant;
    return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(3, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${significant}`;
  const fraction = significant.slice(exponent + 1);
  return `${sign}${digits.slice(0, exponent + 1)}${fraction ? `.${fraction}` : ""}`;
}

function tostring(L: LuaState): number {
  aux.luaL_checkany(L, 1);
  if (aux.luaL_callmeta(L, 1, TOSTRING_EVENT)) return 1;
  switch (lua.lua_type(L, 1)) {
    case lua.LUA_TNUMBER:
      lua.lua_pushstring(L, to_luastring(lua51NumberText(lua.lua_tonumber(L, 1))));
      return 1;
    case lua.LUA_TSTRING:
      lua.lua_pushvalue(L, 1);
      return 1;
    case lua.LUA_TNIL:
      lua.lua_pushstring(L, NIL_TEXT);
      return 1;
    case lua.LUA_TBOOLEAN:
      lua.lua_pushstring(L, lua.lua_toboolean(L, 1) ? TRUE_TEXT : FALSE_TEXT);
      return 1;
    default:
      lua.lua_pushfstring(L, POINTER_FORMAT, aux.luaL_typename(L, 1), lua.lua_topointer(L, 1));
      return 1;
  }
}

function ipairsStep(L: LuaState): number {
  const index = aux.luaL_checkinteger(L, 2) + 1;
  aux.luaL_checktype(L, 1, lua.LUA_TTABLE);
  lua.lua_pushinteger(L, index);
  return lua.lua_rawgeti(L, 1, index) === lua.LUA_TNIL ? 0 : 2;
}

function ipairs(L: LuaState): number {
  aux.luaL_checktype(L, 1, lua.LUA_TTABLE);
  lua.lua_pushjsfunction(L, ipairsStep);
  lua.lua_pushvalue(L, 1);
  lua.lua_pushinteger(L, 0);
  return 3;
}

function fmod(L: LuaState): number {
  if (lua.lua_isinteger(L, 1) && lua.lua_isinteger(L, 2)) {
    const divisor = lua.lua_tointeger(L, 2);
    if (divisor === 0) {
      lua.lua_pushnumber(L, Number.NaN);
      return 1;
    }
    // C's `%` on ints, which JS's is; -2^31 % -1 is 0 (JS: -0).
    lua.lua_pushinteger(L, (lua.lua_tointeger(L, 1) % divisor) | 0);
    return 1;
  }
  // JS's `%` on doubles is C's fmod: the dividend's sign, NaN for a zero divisor or an infinite dividend.
  const dividend = aux.luaL_checknumber(L, 1);
  lua.lua_pushnumber(L, dividend % aux.luaL_checknumber(L, 2));
  return 1;
}

/**
 * Install `tostring`, `pairs` (over `next`, the native `next` GlueLuaNatives installs), `ipairs`
 * and `math.fmod` with its 5.1 aliases `math.mod` and `mod` (the preamble's are fengari's fmod).
 */
export function installGlueLuaBase51(L: LuaState, next: (L: LuaState) => number): void {
  lua.lua_pushjsfunction(L, tostring);
  lua.lua_setglobal(L, to_luastring("tostring"));
  lua.lua_pushjsfunction(L, (state: LuaState): number => {
    aux.luaL_checktype(state, 1, lua.LUA_TTABLE);
    lua.lua_pushjsfunction(state, next);
    lua.lua_pushvalue(state, 1);
    lua.lua_pushnil(state);
    return 3;
  });
  lua.lua_setglobal(L, to_luastring("pairs"));
  lua.lua_pushjsfunction(L, ipairs);
  lua.lua_setglobal(L, to_luastring("ipairs"));
  lua.lua_pushjsfunction(L, fmod);
  lua.lua_setglobal(L, to_luastring("mod"));
  lua.lua_getglobal(L, to_luastring("math"));
  if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
    lua.lua_pushjsfunction(L, fmod);
    lua.lua_setfield(L, -2, to_luastring("fmod"));
    lua.lua_pushjsfunction(L, fmod);
    lua.lua_setfield(L, -2, to_luastring("mod"));
  }
  lua.lua_pop(L, 1);
}
