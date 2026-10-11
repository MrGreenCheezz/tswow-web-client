/**
 * ARC-4: the Lua API every module of the glue and FrameXML runtimes imports — PUC Lua 5.1.5 in
 * WebAssembly (`LuaWasm.ts`) behind the facade `LuaApi.ts`, typed by `LuaShapes.ts`
 * (`docs/implementation/line-ARC4.ru.md`). Until stage A6 (12.10) this module also chose between that VM
 * and fengari (Lua 5.3 in JS, `?luavm=fengari`); the wasm VM is the only one now.
 */

import * as api from "./LuaApi.js";
import type * as Shapes from "./LuaShapes.js";

export type { LuaJsFunction, LuaState, LuaString } from "./LuaShapes.js";

export const lua: typeof Shapes.lua = api.lua;
export const lauxlib: typeof Shapes.lauxlib = api.lauxlib;
export const lualib: typeof Shapes.lualib = api.lualib;
export const to_luastring: typeof Shapes.to_luastring = api.to_luastring;
export const to_jsstring: typeof Shapes.to_jsstring = api.to_jsstring;
export const push: typeof Shapes.push = api.push;
export const tojs: typeof Shapes.tojs = api.tojs;

/** 5.1's own `setfenv`/`getfenv`/`newproxy`, which openlibs keeps aside, put back into `_G`. */
export const restoreLua51Environment: (L: Shapes.LuaState) => void = api.luaWasmRestoreEnvironment;

/** Forgets a `lua_topointer` token (see `LuaApi.releaseLuaPointer`). */
export const releaseLuaPointer: (pointer: unknown) => void = api.releaseLuaPointer;
