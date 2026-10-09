/**
 * 3.27 (03.10, L5): Lua 5.1's `newproxy`, `setfenv` and `getfenv` in the FrameXML state.
 *
 * Wow.exe 3.3.5a (12340) runs Lua 5.1 with its whole base library (`setfenv` 0x00854430 and
 * `getfenv` 0x008543e0 registered at 0x00a47ce8/0x00a47ca0; `newproxy` made with its weak-table
 * upvalue at 0x0085503d). fengari is 5.3, which has none of the three, and the stock secure layer
 * leans on them: RestrictedFrames.lua makes every frame handle with `newproxy(prototype)` and checks
 * `type(handle) == "userdata"` (:602, :625), the prototype's metatable sets `__metatable = false`
 * (:71-73), and RestrictedExecution.lua builds every secure snippet with `setfenv(def, {})` and
 * `setfenv(def, env)` (:96, :103). The preamble's stand-ins (FrameXmlBoot.ts) answered tables from
 * `newproxy` — `type()` said "table", and `newproxy(handle)` raised once the prototype's metatable
 * hid itself — and had no `setfenv` at all.
 *
 * - `newproxy([true | false | proxy])` is lbaselib's: a zero-size userdata; `true` gives it a new
 *   metatable that is remembered as a proxy's; a proxy (anything whose raw metatable is one of
 *   those) gives it that same metatable; anything else is "boolean or proxy expected".
 * - A 5.3 function's environment is its `_ENV` upvalue. `setfenv(f, t)` gives `f` a fresh `_ENV`
 *   upvalue holding `t` (upvalue join), so the closures that shared the old one — every function of
 *   the same file — keep theirs; `f` may be a function or a stack level (1: the caller). A function
 *   that reads no global has no `_ENV` and is answered unchanged, as 5.1 would answer it. Level 0
 *   (the thread's environment) and C functions are refused as 5.1 refuses a C function.
 * - `getfenv([f | level])`: that `_ENV`, or the globals for level 0, a C function or a function
 *   without one. The old stand-in answered level 0 only.
 */
import { lauxlib, lua as luaApi, to_jsstring, to_luastring, type LuaState } from "fengari";

/** The C-API calls beyond src/types/fengari.d.ts, named one by one; fengari implements them all. */
interface Lua53Calls {
  lua_newuserdata(L: LuaState, size: number): unknown;
  lua_getupvalue(L: LuaState, funcIndex: number, n: number): Uint8Array | null;
  lua_upvaluejoin(L: LuaState, funcIndex1: number, n1: number, funcIndex2: number, n2: number): void;
  lua_iscfunction(L: LuaState, index: number): boolean;
}
interface AuxCalls {
  luaL_argerror(L: LuaState, arg: number, message: Uint8Array): never;
  luaL_checktype(L: LuaState, arg: number, type: number): void;
}
const lua = luaApi as typeof luaApi & Lua53Calls;
const aux = lauxlib as typeof lauxlib & AuxCalls;

/** Metatables `newproxy(true)` made (lbaselib's weak table). */
const proxyMetatables = new WeakSet<object>();

function newproxy(L: LuaState): number {
  lua.lua_settop(L, 1);
  lua.lua_newuserdata(L, 0);
  if (!lua.lua_toboolean(L, 1)) return 1;
  if (lua.lua_type(L, 1) === lua.LUA_TBOOLEAN) {
    lua.lua_newtable(L);
    proxyMetatables.add(lua.lua_topointer(L, -1) as object);
  } else if (!lua.lua_getmetatable(L, 1) || !proxyMetatables.has(lua.lua_topointer(L, -1) as object)) {
    return aux.luaL_argerror(L, 1, to_luastring("boolean or proxy expected"));
  }
  lua.lua_setmetatable(L, 2);
  return 1;
}

/**
 * Push the function `setfenv`/`getfenv` names with argument 1 — the function itself or a stack
 * level — and answer true, or answer false for level 0 (pushing nothing).
 */
function pushTarget(L: LuaState, fallbackLevel: number | undefined): boolean {
  if (lua.lua_type(L, 1) === lua.LUA_TFUNCTION) {
    lua.lua_pushvalue(L, 1);
    return true;
  }
  const level = fallbackLevel !== undefined && lua.lua_type(L, 1) <= lua.LUA_TNIL
    ? fallbackLevel : lauxlib.luaL_optinteger(L, 1, 1);
  if (level < 0) aux.luaL_argerror(L, 1, to_luastring("level must be non-negative"));
  if (level === 0) return false;
  const info = new lua.lua_Debug();
  if (!lua.lua_getstack(L, level, info)) aux.luaL_argerror(L, 1, to_luastring("invalid level"));
  lua.lua_getinfo(L, to_luastring("f"), info);
  if (lua.lua_isnil(L, -1)) {
    lauxlib.luaL_error(L, to_luastring(`no function environment for tail call at level ${level}`));
  }
  return true;
}

/** The index of the `_ENV` upvalue of the Lua function at `index`, or 0. */
function environmentUpvalue(L: LuaState, index: number): number {
  for (let n = 1; ; n += 1) {
    const name = lua.lua_getupvalue(L, index, n);
    if (name === null) return 0;
    lua.lua_pop(L, 1);
    if (to_jsstring(name) === "_ENV") return n;
  }
}

/** `local e = ... return function() return e end`: a Lua closure whose one upvalue holds `e`. */
const HOLDER = to_luastring("local e = ... return function() return e end");
const HOLDER_NAME = to_luastring("=setfenv");

function setfenv(L: LuaState): number {
  aux.luaL_checktype(L, 2, lua.LUA_TTABLE);
  lua.lua_settop(L, 2);
  if (!pushTarget(L, undefined)) {
    return lauxlib.luaL_error(L, to_luastring("setfenv: a thread's environment (level 0) cannot be changed in this client"));
  }
  const target = lua.lua_gettop(L);
  if (lua.lua_iscfunction(L, target)) {
    return lauxlib.luaL_error(L, to_luastring("'setfenv' cannot change environment of given object"));
  }
  const upvalue = environmentUpvalue(L, target);
  if (upvalue !== 0) {
    if (lauxlib.luaL_loadbuffer(L, HOLDER, null, HOLDER_NAME) !== lua.LUA_OK) return lua.lua_error(L);
    lua.lua_pushvalue(L, 2);
    lua.lua_call(L, 1, 1);
    lua.lua_upvaluejoin(L, target, upvalue, -1, 1);
    lua.lua_pop(L, 1);
  }
  return 1;
}

function getfenv(L: LuaState): number {
  lua.lua_settop(L, 1);
  if (!pushTarget(L, 1) || lua.lua_iscfunction(L, -1)) {
    lua.lua_pushglobaltable(L);
    return 1;
  }
  const target = lua.lua_gettop(L);
  const upvalue = environmentUpvalue(L, target);
  if (upvalue === 0) lua.lua_pushglobaltable(L);
  else lua.lua_getupvalue(L, target, upvalue);
  return 1;
}

/** Install the three as globals, over the preamble's stand-ins (FrameXmlBoot.ts calls this after them). */
export function installFrameXmlLuaEnvironment(L: LuaState): void {
  lua.lua_pushjsfunction(L, newproxy);
  lua.lua_setglobal(L, to_luastring("newproxy"));
  lua.lua_pushjsfunction(L, setfenv);
  lua.lua_setglobal(L, to_luastring("setfenv"));
  lua.lua_pushjsfunction(L, getfenv);
  lua.lua_setglobal(L, to_luastring("getfenv"));
}
