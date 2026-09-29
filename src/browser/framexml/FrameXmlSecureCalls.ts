/**
 * `issecure()` for the stock entry points that read it, without a taint model.
 *
 * GlueLua.ts answers `issecure()` false: this VM models no taint, and «not secure» is the honest
 * answer for code an add-on could have written. Blizzard's own code runs secure in the client,
 * though, and a few stock paths show or hide things by that answer alone:
 *
 * * `ActionButton_ShowGrid`/`ActionButton_HideGrid` count a button's `showgrid` only
 *   `if ( issecure() )` (ActionButton.lua:275, :291) — the empty slots a held spell is dropped on;
 * * `UnitPopup_HideButtons` hides «Выбрать целью» (TARGET, UnitPopup.lua:593) and the raid menu's
 *   «Главный танк»/«Главный помощник» (RAID_MAINTANK/RAID_MAINASSIST, :752, :758) when
 *   `not issecure()`, and `UIDropDownMenu_CreateInfo` (UIDropDownMenu.lua:167) picks its secure info
 *   table by the same answer — so the whole `UnitPopup_ShowMenu` entry (UnitPopup.lua:190) runs
 *   secure, not only its HideButtons half.
 *
 * The first install replaces the global `issecure` with one that answers the client's 1 while the
 * running coroutine is inside a wrapped entry and nil otherwise; each wrapped call counts itself on
 * its own coroutine. Nesting keeps the outer call secure, an error leaves it (the count comes off
 * in a protected call), and a coroutine that yields inside a wrapped call does not leave the
 * coroutine that resumed it secure. FrameXmlOptionsOwner's own secure transaction swaps the global
 * for its span and puts this one back. Code that took `local issecure = issecure` before the install
 * (RestrictedExecution.lua:18, SecureHandlers.lua:13) keeps the glue's constant false, as before.
 *
 * An error inside a wrapped call is raised again from the wrapper; its message carries the
 * traceback taken where it was raised (the census reads only the first line, `chunk:line: message`),
 * so the frames inside the wrapped function are not lost. Every return value — a nil in the middle
 * included — reaches the caller.
 *
 * Accepted gap: an add-on that calls a wrapped entry runs it secure too, where the client would
 * taint it. The strict rule (no add-on chunk on the Lua stack) would be a host `issecure` walking the
 * stack; nothing asks for it while taint is not modelled.
 */
import type { GlueLuaVm } from "../glue/GlueLua.js";

/** The stock functions that run as Blizzard's code: the action bars' grid and the unit menus' entry. */
export const FRAMEXML_SECURE_ENTRY_POINTS: readonly string[] = Object.freeze([
  "ActionButton_ShowGrid", "ActionButton_HideGrid", "UnitPopup_ShowMenu",
]);

const LUA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESULT_GLOBAL = "__fxSecureWrapResult";

/**
 * `...` is the names. The shared state — the per-coroutine depth, the wrappers already made, the
 * `issecure` answering from them — lives in one table created by the first install, so a second
 * install over the same VM leaves an already wrapped entry alone and keeps counting in one place.
 */
const SECURE_WRAPPERS = `
local names = { ... }
local rawget, type, xpcall, error = rawget, type, xpcall, error
local running = coroutine.running
local traceback = debug and debug.traceback
local state = rawget(_G, "__fxSecureCalls")
if state == nil then
  local depth = {}
  state = { depth = depth, wrappers = {} }
  state.issecure = function()
    if (depth[running()] or 0) > 0 then return 1 end
    return nil
  end
  issecure = state.issecure
  __fxSecureCalls = state
end
local depth, wrappers = state.depth, state.wrappers
local function withTraceback(message)
  if type(message) == "string" and traceback then return traceback(message, 2) end
  return message
end
local function leave(thread, ok, ...)
  local level = (depth[thread] or 1) - 1
  if level > 0 then depth[thread] = level else depth[thread] = nil end
  if not ok then error((...), 0) end
  return ...
end
local wrapped = {}
for index = 1, #names do
  local name = names[index]
  local original = rawget(_G, name)
  if type(original) == "function" and not wrappers[original] then
    local wrapper = function(...)
      local thread = running()
      depth[thread] = (depth[thread] or 0) + 1
      return leave(thread, xpcall(original, withTraceback, ...))
    end
    wrappers[wrapper] = true
    _G[name] = wrapper
    wrapped[#wrapped + 1] = name
  end
end
${RESULT_GLOBAL} = table.concat(wrapped, "\\n")
`;

/**
 * Wrap each named global function so it runs with `issecure()` answering 1. Names that are not a
 * function right now, or are already wrapped, are skipped. Returns the names wrapped by this call.
 */
export function installFrameXmlSecureWrappers(vm: GlueLuaVm, names: readonly string[]): readonly string[] {
  const valid = names.filter((name) => LUA_NAME.test(name));
  if (valid.length === 0) return [];
  const ran = vm.execute(SECURE_WRAPPERS, "@webclient/secure-calls", valid);
  const result = vm.getGlobal(RESULT_GLOBAL);
  vm.setGlobal(RESULT_GLOBAL, undefined);
  if (!ran.ok) {
    console.warn(`[FrameXML] secure entry points: ${ran.error}`);
    return [];
  }
  return typeof result === "string" && result.length > 0 ? result.split("\n") : [];
}
