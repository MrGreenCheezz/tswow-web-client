/**
 * ARC-4 (A4): FrameXmlBoot's shims for the PUC Lua 5.1.5 VM (wasm), in place of `FRAMEXML_LUA51_SHIMS`,
 * whose `bit` is written with 5.3 operators (a syntax error in 5.1) and whose `getfenv(0)`/`newproxy`
 * stand-ins 5.1 does not need. First written as the P2-12 prototype's substitution
 * (`.runtime/perf-step23/arc4/shims/framexml-lua51.lua`).
 */
export const FRAMEXML_LUA51_NATIVE_SHIMS = `
-- Dropped: the getfenv(0) and newproxy stand-ins (5.1's own come back through the load hook's
-- installFrameXmlLuaEnvironment), and the \`bit\` table written with 5.3 operators (\`&\`, \`|\`, \`~\`,
-- \`<<\`, \`>>\`, \`//\` are syntax errors in 5.1) — \`bit\` is native here (wow/wowbit.c, same semantics).
-- Kept as they are: hooksecurefunc, scrub, forceinsecure, debugstack, table.wipe,
-- debugprofilestart/stop and the error-census wrapper of seterrorhandler.
function hooksecurefunc(target, name, hook)
  if hook == nil then
    target, name, hook = _G, target, name
  end
  if type(target) ~= "table" or type(hook) ~= "function" then return end
  local original = target[name]
  if type(original) ~= "function" then return end
  target[name] = function(...)
    local results = { original(...) }
    hook(...)
    return unpack(results)
  end
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
