/**
 * ARC-4: the glue preamble — Blizzard's vocabulary over PUC Lua 5.1.5's own library (the wasm VM). First
 * written in A4 as the P2-12 prototype's substitution (`.runtime/perf-step23/arc4/shims/glue-lua51.lua`) for
 * GlueLua's `LUA51_SHIMS`, which emulated 5.1 on fengari's 5.3; the only preamble since A6 (12.10).
 */
export const GLUE_LUA51_NATIVE_SHIMS = `
-- Blizzard's vocabulary over PUC 5.1's own library: the capability boundary
-- (io/package/require/dofile/loadfile removed, os cut to date/time/clock, debug cut to traceback),
-- the flattened aliases, strjoin/strconcat/strtrim/strsplit/strreplace/wipe, getglobal/setglobal,
-- securecall/issecure/debuginfo, the collectgarbage stand-in (a full collection stays a no-op;
-- "count" answers the real heap), table.unpack/table.pack for the host's own 5.3-spelled Lua.
--
-- Not here, because PUC 5.1 has it natively (fengari's 5.3, the VM until ARC-4 A6, needed them):
--   string.format (the client's str_format is a host function, GlueLuaFormat.ts),
--   tostring (5.1 prints "3" for 6/2; MSVC's "%.14g" spelling is in luaconf.h, wl_number2str),
--   string.gfind / math.mod / math.pow / table.getn / unpack / loadstring / math.frexp / math.ldexp,
--   table.insert past the end (5.1's tinsert grows the array: \`if (pos > e) e = pos\`),
--   next / pairs in PUC order (they are PUC's), gcinfo (5.1's, real),
--   the \`_G\` "11.0" -> "11" __index retry (5.1 concatenates 11, not 11.0).
-- Removed from _G, as the glue state has always run without them: setfenv, getfenv, newproxy — the C side
-- keeps the originals and FrameXML's installFrameXmlLuaEnvironment puts them back (load hook).
local _date, _time, _clock, _traceback = os.date, os.time, os.clock, debug.traceback
os = { date = _date, time = _time, clock = _clock }
debug = { traceback = _traceback }
io, package, require, dofile, loadfile, module = nil, nil, nil, nil, nil, nil
setfenv, getfenv, newproxy = nil, nil, nil

table.unpack = unpack
function table.pack(...) return { n = select("#", ...), ... } end
string.gfind = string.gfind or string.gmatch
math.mod = math.mod or math.fmod

strlen, strsub, strupper, strlower = string.len, string.sub, string.upper, string.lower
strfind, strmatch, strrep, strbyte, strchar = string.find, string.match, string.rep, string.byte, string.char
format, gsub, gmatch, gfind = string.format, string.gsub, string.gmatch, string.gmatch
tinsert, tremove, tconcat, sort, getn = table.insert, table.remove, table.concat, table.sort, table.getn
abs, ceil, floor, max, min, mod, random, sqrt = math.abs, math.ceil, math.floor, math.max, math.min, math.fmod, math.random, math.sqrt
date, time, clock = os.date, os.time, os.clock

function strjoin(delimiter, ...) return table.concat({...}, delimiter) end
function strconcat(...) return table.concat({...}) end
function strtrim(text, chars)
  chars = chars or " \\t\\r\\n"
  return (tostring(text):gsub("^[" .. chars .. "]*(.-)[" .. chars .. "]*$", "%1"))
end
function strsplit(delimiter, text, limit)
  local parts, start, count = {}, 1, 0
  while true do
    count = count + 1
    if limit and count >= limit then break end
    local from, to = string.find(text, delimiter, start, true)
    if not from then break end
    parts[#parts + 1] = string.sub(text, start, from - 1)
    start = to + 1
  end
  parts[#parts + 1] = string.sub(text, start)
  return unpack(parts)
end
function strreplace(text, pattern, replacement)
  return (string.gsub(text, pattern, replacement))
end
function wipe(t) for key in pairs(t) do t[key] = nil end return t end

function getglobal(name) return _G[name] end
function setglobal(name, value) _G[name] = value end

local function __secureresults(ok, ...)
  if not ok then geterrorhandler()((...)) return end
  return ...
end
function securecall(func, ...)
  if type(func) == "string" then func = _G[func] end
  if type(func) ~= "function" then return end
  return __secureresults(pcall(func, ...))
end
function issecure() return false end
function debuginfo() end

local _collectgarbage = collectgarbage
local _gcOptions = { collect = 0, stop = 0, restart = 0, step = true,
  setpause = 200, setstepmul = 200, isrunning = true }
function collectgarbage(option, argument)
  option = option == nil and "collect" or option
  if option == "count" then return _collectgarbage("count") end
  local answer = _gcOptions[option]
  if answer == nil then
    error("bad argument #1 to 'collectgarbage' (invalid option '" .. tostring(option) .. "')", 2)
  end
  return answer
end
`;
