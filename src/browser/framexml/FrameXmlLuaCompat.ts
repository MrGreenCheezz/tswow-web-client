/**
 * The global aliases Wow.exe 3.3.5a 12340 defines in every Lua state, where this VM had none.
 *
 * The client runs a compat chunk embedded in the executable (its text at 0x00a44980; read-only)
 * whenever FrameScript_Initialize (0x00819bb0) makes a Lua state — the glue state at client start
 * and the game UI's at each start — so the text lives with the VM itself (GlueLua.ts
 * `WOW_COMPAT_LUA`, run by every GlueLuaVm). The FrameXML boot runs it once more before the corpus;
 * the chunk only assigns, so a second run changes nothing. Without it the stock
 * MainMenuBar_GetRightABPos (`sin(fraction*90)`, MainMenuBar.lua:26) — reached by the second
 * PLAYER_ENTERING_WORLD, a loading screen's — and any module using WoW's degree math raised on a nil.
 */

import { WOW_COMPAT_LUA, type GlueLuaVm } from "../glue/GlueLua.js";

export const FRAMEXML_LUA_COMPAT_PRELUDE = WOW_COMPAT_LUA;

export function installFrameXmlLuaCompat(vm: GlueLuaVm, chunk: string): boolean {
  return vm.execute(FRAMEXML_LUA_COMPAT_PRELUDE, chunk).ok;
}
