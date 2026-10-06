/**
 * 3.27 / 3.09 (05.10-3.27b): `SetEuropeanNumbers(flag)` — Wow.exe 0x00510de0 (registration
 * 0x00ac86f4). It reads its first argument with 0x00815500 (default true), hands it to 0x00817da0,
 * which only calls 0x0084f010: the flag 0x00d413b8 is set to the argument, nothing else happens, and
 * nothing is returned. The flag is written only there and read only by 0x0084f030 (data references,
 * .runtime/re-2026-09-30/a1-de-review/r6.txt), which the `%F` item of str_format (0x00853c50) and of
 * the widget formatter (0x00818070; it also runs over `%d`/`%i`, where there is no point to change)
 * calls: inside a number a `.` with a digit after it becomes `,`. ruRU's LocalizeFrames
 * (Localization.lua:11) turns it on at VARIABLES_LOADED; no stock file formats with `%F`, so the
 * stock UI shows no change.
 *
 * 0x00815500: nil false, a boolean as it is, a number when its __ftol2 is not 0, a string by
 * 0x00815400 (frameXmlShowArgument), any other type and no argument at all the default, true.
 * Notes: .runtime/re-2026-10-05/l327b/g1.txt.
 */
import { lua, to_luastring, type LuaState } from "fengari";
import { setLuaFormatEuropeanNumbers } from "../glue/GlueLuaFormat.js";
import { frameXmlShowArgument } from "./FrameXmlHelmCloak.js";

interface Lua53Calls {
  lua_tonumber(L: LuaState, index: number): number;
  lua_toboolean(L: LuaState, index: number): boolean;
}
const api = lua as typeof lua & Lua53Calls;

/** 0x00815500(L, 1, true). */
function flagArgument(L: LuaState): boolean {
  switch (api.lua_type(L, 1)) {
    case api.LUA_TNIL: return false;
    case api.LUA_TBOOLEAN: return api.lua_toboolean(L, 1);
    case api.LUA_TNUMBER: {
      const whole = Math.trunc(api.lua_tonumber(L, 1));
      // __ftol2: NaN and values outside int32 become -2^31, which is not 0.
      return whole !== 0;
    }
    case api.LUA_TSTRING: return frameXmlShowArgument(api.lua_tojsstring(L, 1));
    default: return true;
  }
}

function setEuropeanNumbers(L: LuaState): number {
  setLuaFormatEuropeanNumbers(L, flagArgument(L));
  return 0;
}

/** Install `SetEuropeanNumbers` as a global C function of the FrameXML state. */
export function installFrameXmlEuropeanNumbers(L: LuaState): void {
  api.lua_pushjsfunction(L, setEuropeanNumbers);
  api.lua_setglobal(L, to_luastring("SetEuropeanNumbers"));
}
