/**
 * Minimal ambient types for `fengari` (a Lua 5.3 VM in JavaScript).
 *
 * The package ships no declarations. Rather than `any`-typing the whole VM,
 * this declares exactly the C-API surface `src/browser/glue/GlueLua.ts` uses,
 * with fengari's own conventions: `LuaState` is opaque, Lua strings cross the
 * boundary as `Uint8Array` (hence `to_luastring`/`to_jsstring`), and a JS
 * function registered with `lua_pushjsfunction` returns its result count.
 *
 * Anything not listed here is deliberately unavailable: adding a binding means
 * declaring it, which keeps the glue runtime's use of the VM auditable.
 */
declare module "fengari" {
  export interface LuaState {
    readonly __luaState: unique symbol;
  }

  export type LuaString = Uint8Array;
  export type LuaJsFunction = (L: LuaState) => number;

  export function to_luastring(value: string, cache?: boolean): LuaString;
  /** P1-14b: `from`/`to` bound the bytes; `replacement` gives U+FFFD for invalid UTF-8 instead of throwing. */
  export function to_jsstring(value: LuaString, from?: number, to?: number, replacement?: boolean): string;

  export const FENGARI_VERSION: string;

  export namespace lua {
    function lua_getmetatable(L: LuaState, index: number): boolean;
    function lua_topointer(L: LuaState, index: number): unknown;
    function lua_next(L: LuaState, index: number): boolean;
    function lua_pushglobaltable(L: LuaState): void;
    function lua_checkstack(L: LuaState, slots: number): boolean;
    class lua_Debug { source: LuaString; currentline: number; }
    function lua_getinfo(L: LuaState, what: LuaString, info: lua_Debug): number;
    function lua_getstack(L: LuaState, level: number, info: lua_Debug): number;
    const LUA_REGISTRYINDEX: number;
    const LUA_MULTRET: number;
    const LUA_OK: number;
    const LUA_ERRRUN: number;
    const LUA_ERRSYNTAX: number;
    const LUA_ERRMEM: number;
    const LUA_TNONE: number;
    const LUA_TNIL: number;
    const LUA_TBOOLEAN: number;
    const LUA_TLIGHTUSERDATA: number;
    const LUA_TNUMBER: number;
    const LUA_TSTRING: number;
    const LUA_TTABLE: number;
    const LUA_TFUNCTION: number;
    const LUA_TUSERDATA: number;
    const LUA_TTHREAD: number;
    const LUA_OPEQ: number;

    function lua_close(L: LuaState): void;
    function lua_gettop(L: LuaState): number;
    function lua_settop(L: LuaState, index: number): void;
    function lua_pop(L: LuaState, count: number): void;
    function lua_pushvalue(L: LuaState, index: number): void;
    function lua_remove(L: LuaState, index: number): void;
    function lua_insert(L: LuaState, index: number): void;
    function lua_type(L: LuaState, index: number): number;
    function lua_typename(L: LuaState, type: number): LuaString;
    function lua_isnil(L: LuaState, index: number): boolean;
    function lua_isnumber(L: LuaState, index: number): boolean;
    function lua_isstring(L: LuaState, index: number): boolean;
    function lua_isfunction(L: LuaState, index: number): boolean;
    function lua_istable(L: LuaState, index: number): boolean;
    function lua_toboolean(L: LuaState, index: number): boolean;
    function lua_tonumber(L: LuaState, index: number): number;
    function lua_tointeger(L: LuaState, index: number): number;
    function lua_tojsstring(L: LuaState, index: number): string;
    /** P1-14b: the string's own bytes (a number is converted in place); null when not a string or number. */
    function lua_tolstring(L: LuaState, index: number): LuaString | null;
    function lua_pushnil(L: LuaState): void;
    function lua_pushboolean(L: LuaState, value: boolean): void;
    function lua_pushnumber(L: LuaState, value: number): void;
    function lua_pushinteger(L: LuaState, value: number): void;
    function lua_pushstring(L: LuaState, value: LuaString): void;
    function lua_pushliteral(L: LuaState, value: string): void;
    function lua_pushjsfunction(L: LuaState, fn: LuaJsFunction): void;
    function lua_pushjsclosure(L: LuaState, fn: LuaJsFunction, upvalues: number): void;
    function lua_createtable(L: LuaState, narr: number, nrec: number): void;
    function lua_newtable(L: LuaState): void;
    function lua_setglobal(L: LuaState, name: LuaString): void;
    function lua_getglobal(L: LuaState, name: LuaString): number;
    function lua_setfield(L: LuaState, index: number, name: LuaString): void;
    function lua_getfield(L: LuaState, index: number, name: LuaString): number;
    function lua_settable(L: LuaState, index: number): void;
    function lua_gettable(L: LuaState, index: number): number;
    function lua_rawset(L: LuaState, index: number): void;
    function lua_rawget(L: LuaState, index: number): number;
    function lua_rawgeti(L: LuaState, index: number, n: number): number;
    function lua_rawseti(L: LuaState, index: number, n: number): void;
    function lua_setmetatable(L: LuaState, index: number): number;
    function lua_pcall(L: LuaState, nargs: number, nresults: number, msgh: number): number;
    function lua_call(L: LuaState, nargs: number, nresults: number): void;
    function lua_error(L: LuaState): never;
    function lua_upvalueindex(index: number): number;
    function lua_absindex(L: LuaState, index: number): number;
    function lua_compare(L: LuaState, index1: number, index2: number, op: number): number;
  }

  export namespace lauxlib {
    const LUA_REFNIL: number;
    const LUA_NOREF: number;

    function luaL_newstate(): LuaState;
    function luaL_loadbuffer(
      L: LuaState,
      buffer: LuaString,
      size: number | null,
      chunkName: LuaString,
    ): number;
    function luaL_ref(L: LuaState, table: number): number;
    function luaL_unref(L: LuaState, table: number, ref: number): void;
    function luaL_requiref(
      L: LuaState,
      name: LuaString,
      open: LuaJsFunction,
      global: number,
    ): void;
    function luaL_traceback(L: LuaState, L1: LuaState, message: LuaString | null, level: number): void;
    function luaL_error(L: LuaState, message: LuaString): never;
    function luaL_checkstring(L: LuaState, index: number): LuaString;
    function luaL_optinteger(L: LuaState, index: number, fallback: number): number;
  }

  export namespace lualib {
    function luaL_openlibs(L: LuaState): void;
  }
}
