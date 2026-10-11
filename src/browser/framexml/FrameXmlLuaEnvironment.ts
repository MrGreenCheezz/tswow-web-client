/**
 * 3.27 (03.10, L5): Lua 5.1's `newproxy`, `setfenv` and `getfenv` in the FrameXML state.
 *
 * Wow.exe 3.3.5a (12340) runs Lua 5.1 with its whole base library (`setfenv` 0x00854430 and
 * `getfenv` 0x008543e0 registered at 0x00a47ce8/0x00a47ca0; `newproxy` made with its weak-table
 * upvalue at 0x0085503d), and the stock secure layer leans on them: RestrictedFrames.lua makes every
 * frame handle with `newproxy(prototype)` and checks `type(handle) == "userdata"` (:602, :625), the
 * prototype's metatable sets `__metatable = false` (:71-73), and RestrictedExecution.lua builds every
 * secure snippet with `setfenv(def, {})` and `setfenv(def, env)` (:96, :103).
 *
 * The glue state runs without the three (GlueLua51NativeShims.ts removes them from `_G`); the VM's
 * openlibs keeps PUC 5.1's own aside, and this puts them back. (Until ARC-4 A6, 12.10, fengari's Lua
 * 5.3 had none of them and they were emulated here in JS: `setfenv` by joining `_ENV` upvalues.)
 */
import { restoreLua51Environment, type LuaState } from "../lua/LuaVm.js";

/** Install the three as globals (FrameXmlBoot.ts calls this after its preamble). */
export function installFrameXmlLuaEnvironment(L: LuaState): void {
  restoreLua51Environment(L);
}
