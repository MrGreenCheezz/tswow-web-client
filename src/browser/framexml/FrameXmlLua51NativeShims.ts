/**
 * ARC-4 (A4): FrameXmlBoot's shims for the PUC Lua 5.1.5 VM (wasm). First written as the P2-12
 * prototype's substitution (`.runtime/perf-step23/arc4/shims/framexml-lua51.lua`) for
 * `FRAMEXML_LUA51_SHIMS`, fengari's 5.3 text, whose `bit` was written with 5.3 operators (a syntax error
 * in 5.1) and whose `getfenv(0)`/`newproxy` stand-ins 5.1 does not need; the only text since A6 (12.10).
 */
export const FRAMEXML_LUA51_NATIVE_SHIMS = `
-- Dropped: the getfenv(0) and newproxy stand-ins (5.1's own come back through the load hook's
-- installFrameXmlLuaEnvironment), and the \`bit\` table written with 5.3 operators (\`&\`, \`|\`, \`~\`,
-- \`<<\`, \`>>\`, \`//\` are syntax errors in 5.1) — \`bit\` is native here (wow/wowbit.c, same semantics).
-- Kept as they are: hooksecurefunc (9.10: it also records its wrappers), scrub, forceinsecure,
-- debugstack, table.wipe, debugprofilestart/stop and the error-census wrapper of seterrorhandler.
-- Each wrapper is recorded with the function it wraps (weak keys): an entry point an add-on only
-- hooked is still UIParent's own (FrameXmlStockEntryPoints.ts).
local hookOriginals = setmetatable({}, { __mode = "k" })
__fxSecureHookOriginals = hookOriginals
function hooksecurefunc(target, name, hook)
  if hook == nil then
    target, name, hook = _G, target, name
  end
  if type(target) ~= "table" or type(hook) ~= "function" then return end
  local original = target[name]
  if type(original) ~= "function" then return end
  local wrapper = function(...)
    local results = { original(...) }
    hook(...)
    return unpack(results)
  end
  hookOriginals[wrapper] = original
  target[name] = wrapper
end

function scrub(...) return ... end
function forceinsecure() end
function debugstack(level) return debug.traceback("", (level or 1) + 1) end
table.wipe = wipe
function debugprofilestart() end
function debugprofilestop() return 0 end

do
  local install = seterrorhandler
  function seterrorhandler(handler)
    if type(handler) ~= "function" then return install(handler) end
    return install(function(message)
      __fxNoteError(tostring(message))
      return handler(message)
    end)
  end
end
`;
