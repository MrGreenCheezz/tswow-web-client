/**
 * ARC-4 (A3): which Lua VM the interface runs on while the move from fengari to PUC Lua 5.1.5 in
 * WebAssembly is under way (`docs/implementation/line-ARC4.ru.md`). Every module of the glue and FrameXML
 * runtimes imports the Lua API from here, never from `fengari` directly, so one switch decides:
 *
 * - `?luavm=wasm` / `?luavm=fengari` in the page URL, or `WEBCLIENT_LUA_VM` under Node (tests, tools);
 * - otherwise the default below.
 *
 * Both expose fengari's shapes (`LuaApi.ts` mirrors them), so callers do not branch; where the two Lua
 * versions differ in behaviour (5.1 vs fengari's 5.3), a caller asks {@link LUA_VM} or {@link LUA51_NATIVE}.
 * The switch and fengari go away in stage A6.
 */

import * as fengari from "fengari";
import * as fengariInterop from "fengari-interop";
import * as wasm from "./LuaApi.js";

export type { LuaJsFunction, LuaState, LuaString } from "fengari";

export type LuaVmKind = "wasm" | "fengari";

/**
 * A4 done (09.10): every Lua text has its 5.1-native form and the whole test suite passes on the wasm VM,
 * so it is the default; fengari stays reachable (`?luavm=fengari`, `WEBCLIENT_LUA_VM=fengari`) until the
 * owner's live check in A6.
 */
const DEFAULT_LUA_VM: LuaVmKind = "wasm";

function chooseLuaVm(): LuaVmKind {
  const fromUrl = typeof location === "object" && location !== null && typeof location.search === "string"
    ? new URLSearchParams(location.search).get("luavm") : null;
  const fromEnvironment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.["WEBCLIENT_LUA_VM"];
  const requested = fromUrl ?? fromEnvironment;
  return requested === "wasm" || requested === "fengari" ? requested : DEFAULT_LUA_VM;
}

/** The VM this realm runs. */
export const LUA_VM: LuaVmKind = chooseLuaVm();
/** True when Lua 5.1's own library is native (the wasm VM), false under fengari's 5.3 with emulations. */
export const LUA51_NATIVE = LUA_VM === "wasm";

const api = LUA51_NATIVE ? wasm : fengari;
export const lua: typeof fengari.lua = api.lua;
export const lauxlib: typeof fengari.lauxlib = api.lauxlib;
export const lualib: typeof fengari.lualib = api.lualib;
export const to_luastring: typeof fengari.to_luastring = api.to_luastring;
export const to_jsstring: typeof fengari.to_jsstring = api.to_jsstring;
export const push: typeof fengariInterop.push = LUA51_NATIVE ? wasm.push : fengariInterop.push;
export const tojs: typeof fengariInterop.tojs = LUA51_NATIVE ? wasm.tojs : fengariInterop.tojs;

/** On the wasm VM, 5.1's own `setfenv`/`getfenv`/`newproxy` back into `_G` (undefined under fengari, which emulates them). */
export const restoreLua51Environment: ((L: fengari.LuaState) => void) | undefined = LUA51_NATIVE ? wasm.luaWasmRestoreEnvironment : undefined;

/** On the wasm VM, forgets a `lua_topointer` token (see `LuaApi.releaseLuaPointer`); nothing under fengari. */
export const releaseLuaPointer: (pointer: unknown) => void = LUA51_NATIVE ? wasm.releaseLuaPointer : () => {};
