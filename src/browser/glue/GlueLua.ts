import { lauxlib, lua, lualib, to_luastring, to_jsstring, type LuaState } from "fengari";
import { push as pushInterop, tojs as interopToJs } from "fengari-interop";

// Fengari's lua_Integer is a signed 32-bit value in the browser build. Keep the
// integer path for ids/counts (so Lua 5.1-style tostring still says "1"), but
// send safe integers outside that ABI range through the number interop path.
const LUA_INTEGER_MIN = -2147483648;
const LUA_INTEGER_MAX = 2147483647;

/**
 * The Lua 5.1 compatibility preamble, measured against this client's own
 * `Interface\GlueXML` corpus rather than against a wiki list.
 *
 * fengari is Lua 5.3. The corpus is 3.3.5a Lua 5.1 with Blizzard's flattened
 * "C globals" on top, so three separate gaps have to be closed and each entry
 * below exists because a real file calls it:
 *
 *  - 5.1 aliases Blizzard flattened into globals: `strlen` (51 call sites),
 *    `format` (25), `strupper` (11), `tinsert` (10), `strsub` (8), `getglobal`
 *    (9), `unpack` (2), `strbyte`/`strchar` (AceSerializer), `strfind`, `gsub`,
 *    `gmatch`, `tremove`, `tconcat`, `getn`, `sort`.
 *  - `math`/`os` members promoted to globals: `max` (32), `time` (27), `mod`
 *    (21), `min` (16), `floor` (14), `date` (4), `random` (3), `ceil` (3),
 *    `abs` (1), plus `math.frexp`, which 5.3 removed and AceSerializer calls.
 *  - Blizzard's error/secure vocabulary: `seterrorhandler` (GlueBasicControls),
 *    `securecall` (10), `issecure`, `debuginfo`, `message`.
 *
 * Deliberately absent, and this is a measurement, not an omission:
 * `setfenv`/`getfenv` have **zero** call sites in the corpus (grep over all 70
 * files, .lua bodies and inline XML script bodies alike), so the `_ENV`
 * upvalue surgery they would need in 5.3 is not implemented. `loadstring`,
 * `wipe`, `strsplit`, `strjoin` and `strtrim` are likewise unused; the cheap
 * one-line aliases are still provided because a custom login screen is the
 * kind of file that grows one, and an alias costs nothing.
 *
 * A fourth gap is not a missing name but a different *order*: `next`/`pairs`
 * walk a table differently in fengari than in PUC-Lua, and the owner's login
 * screen depends on PUC's. See the shim itself for the measurement.
 *
 * Two 5.3-vs-5.1 divergences cannot be aliased away and are handled here:
 * `string.format("%d", 3.7)` is a hard error in 5.3 (5.1 truncated), and
 * `tostring(6/2)` is `"3.0"` in 5.3 against `"3"` in 5.1. `format` and
 * `tostring` are both wrapped. The remaining hole is documented in
 * `src/browser/glue/README.md`: `"x"..(6/2)` still concatenates as `x3.0`,
 * because 5.3 coerces numbers to strings inside the VM where no metamethod can
 * intercept it.
 */
const LUA51_SHIMS = `
local _format, _tostring = string.format, tostring

-- The corpus runs behind the same capability boundary the rest of
-- framexml_compat maintains. Only the three os functions it actually calls
-- survive; the file, loader and package surface is removed outright, so a
-- third-party library shipped inside a patch archive (LibDeflate,
-- AceSerializer) cannot reach the host filesystem or load more code.
local _date, _time, _clock, _traceback = os.date, os.time, os.clock, debug.traceback
os = { date = _date, time = _time, clock = _clock }
debug = { traceback = _traceback }
io, package, require, dofile, loadfile = nil, nil, nil, nil, nil

-- 5.1 truncated a float for an integer conversion; 5.3 raises. Truncate the
-- arguments that reach an integer specifier so the corpus' arithmetic (which
-- divides, and so produces floats) formats instead of erroring. \`%%\` is
-- stepped over explicitly: it consumes no argument, and counting it would
-- shift every later specifier onto the wrong value.
-- Blizzard's own extension to \`format\`: a specifier may name which argument it
-- takes, as \`%2$s %1$d\`. Localisers need it because word order changes between
-- languages, and this client is ruRU: measured, the corpus' own
-- \`CHARACTER_SELECT_INFO\` is "%2$s %1$d-го уровня" and
-- \`CHARACTER_SELECT_INFO_GHOST\` is "%2$s %1$d-го уровня (Призрак)", against
-- the enUS "Level %d %s" with no positions at all. PUC-Lua has never had it and
-- raises "invalid option '%5' to 'format'", which is what the character list
-- died of. Rewritten here into the plain form with the arguments reordered, so
-- exactly one implementation of the rest of the shim has to exist.
local function _positional(fmt, args)
  local out, values, taken, index, position = {}, {}, 0, 0, 1
  while true do
    local start = string.find(fmt, "%%", position)
    if not start then
      out[#out + 1] = string.sub(fmt, position)
      break
    end
    out[#out + 1] = string.sub(fmt, position, start - 1)
    if string.sub(fmt, start + 1, start + 1) == "%" then
      out[#out + 1] = "%%"
      position = start + 2
    else
      local argnum, rest, stop = string.match(fmt, "^%%(%d+)%$([-+ #0-9.]*%a)()", start)
      if argnum then
        index = tonumber(argnum)
        out[#out + 1] = "%" .. rest
        position = stop
      else
        local spec, plain = string.match(fmt, "^(%%[-+ #0-9.]*%a)()", start)
        if not spec then
          -- Not a specifier at all; copy the character and carry on rather than
          -- swallowing the rest of the string.
          out[#out + 1] = string.sub(fmt, start, start)
          position = start + 1
        else
          index = index + 1
          out[#out + 1] = spec
          position = plain
        end
      end
      if position > start + 1 then
        taken = taken + 1
        values[taken] = args[index]
      end
    end
  end
  return table.concat(out), values, taken
end

function string.format(fmt, ...)
  local count = select("#", ...)
  if type(fmt) ~= "string" or count == 0 then return _format(fmt, ...) end
  local args, index, position = {...}, 0, 1
  if string.find(fmt, "%%%d+%$") then
    fmt, args, count = _positional(fmt, args)
  end
  while true do
    local start = string.find(fmt, "%%", position)
    if not start then break end
    if string.sub(fmt, start + 1, start + 1) == "%" then
      position = start + 2
    else
      local spec, stop = string.match(fmt, "^%%[-+ #0-9.]*(%a)()", start)
      position = stop or (start + 2)
      if spec then
        index = index + 1
        if spec == "d" or spec == "i" or spec == "u" or spec == "o"
           or spec == "x" or spec == "X" or spec == "c" then
          local value = args[index]
          if type(value) == "string" then value = tonumber(value) end
          if type(value) == "number" and value == value
             and value ~= math.huge and value ~= -math.huge then
            args[index] = math.floor(value)
          end
        end
      end
    end
  end
  return _format(fmt, table.unpack(args, 1, count))
end

-- 5.1 printed a whole float as "3"; 5.3 prints "3.0". Glue text is assembled
-- from these, so restore the 5.1 spelling for integral floats.
function tostring(value)
  if type(value) == "number" and value % 1 == 0 and value == value
     and value ~= math.huge and value ~= -math.huge then
    return _format("%d", value)
  end
  return _tostring(value)
end

string.gfind = string.gmatch
math.mod = math.fmod
math.pow = function(x, y) return x ^ y end
table.getn = function(t) return #t end
unpack = table.unpack

-- 5.1's \`table.insert(list, pos, value)\` did not bounds-check \`pos\`: its C body was
-- \`if (pos > e) e = pos\` and then a shift, so a position past the end simply grew the array and
-- left a hole. 5.2 added the check and turned that into a hard error.
--
-- The corpus depends on the old rule twice, both in \`lgzg.lua\`: \`Generate_M\` inserts each model
-- at its own index in \`ModelList\` (\`:187\`) and \`GetModelData\`/\`GetModel\` rebuild sparse lists
-- the same way (\`:381\`, \`:391\`, \`:406\`, \`:416\`) — the second pair genuinely skip indices, so
-- even a correctly ordered traversal lands past \`#t + 1\`. Measured: with the check in place the
-- owner's login scene raised «position out of bounds» once per frame and never lit a model.
local _tinsert = table.insert
function table.insert(list, ...)
  if select("#", ...) < 2 then return _tinsert(list, ...) end
  local pos, value = ...
  local last = #list + 1
  if pos > last then last = pos end
  if pos >= 1 then
    for index = last, pos + 1, -1 do list[index] = list[index - 1] end
  end
  list[pos] = value
end
loadstring = load

-- 5.3 dropped frexp; AceSerializer needs it to round-trip a double.
function math.frexp(value)
  if value == 0 or value ~= value or value == math.huge or value == -math.huge then return value, 0 end
  local exponent = math.floor(math.log(math.abs(value), 2)) + 1
  local mantissa = value / (2 ^ exponent)
  -- log2 rounding can land one bit outside [0.5, 1); nudge it back.
  while math.abs(mantissa) >= 1 do mantissa, exponent = mantissa / 2, exponent + 1 end
  while math.abs(mantissa) < 0.5 do mantissa, exponent = mantissa * 2, exponent - 1 end
  return mantissa, exponent
end
math.ldexp = function(mantissa, exponent) return mantissa * 2 ^ exponent end

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
  return table.unpack(parts)
end
-- AccountLogin.lua calls this; 3.3.5 has it as a global helper, not in string.
function strreplace(text, pattern, replacement)
  return (string.gsub(text, pattern, replacement))
end
function wipe(t) for key in pairs(t) do t[key] = nil end return t end

-- Table traversal order.
--
-- The manual leaves \`next\`'s order unspecified, but the corpus was written
-- against PUC-Lua, which walks a table's array part in ascending order and only
-- then its hash part. fengari does neither. Measured on the exact shape
-- \`lgzg.lua\`'s \`ModelList\` has — named fields plus positional entries — the
-- traversal comes out hash-first and the array part *descending*:
-- \`loaded, blend_start_duration, max_scenes, sceneData, 3, 2, 1\`.
--
-- That is not cosmetic here. \`lgzg.lua:187\` is
-- \`table.insert(scene, num, newModel(...))\` with \`num\` taken straight from
-- \`pairs(ModelList)\`, and 5.3's \`table.insert\` rejects a position past
-- \`#t + 1\`. The first model the owner's login screen tried to build therefore
-- raised «bad argument #2 to 'insert' (position out of bounds)», \`Generate_M\`
-- died inside \`LoginScreen_OnLoad\`, and the screen ended up with no
-- background texture, no logo and none of its thirty models — measured, by
-- counting Model widgets in the live page: 85 from XML, 0 from Lua.
--
-- Restoring PUC's order is a shim of the same kind as the rest of this
-- preamble: walk the contiguous run 1..n first, then whatever else the table
-- holds, skipping the keys already handed out.
local _next = next
local function _isArrayKey(key, n)
  return type(key) == "number" and key >= 1 and key <= n and key % 1 == 0
end
local function _arrayLength(t)
  local n = 0
  while rawget(t, n + 1) ~= nil do n = n + 1 end
  return n
end
local function _afterArray(t, n, from)
  local key, value = _next(t, from)
  while key ~= nil and _isArrayKey(key, n) do key, value = _next(t, key) end
  return key, value
end
function next(t, key)
  local n = _arrayLength(t)
  if key == nil then
    if n > 0 then return 1, rawget(t, 1) end
    return _afterArray(t, n, nil)
  end
  if _isArrayKey(key, n) then
    if key < n then return key + 1, rawget(t, key + 1) end
    return _afterArray(t, n, nil)
  end
  return _afterArray(t, n, key)
end
-- \`pairs\` gets its own closure rather than returning \`next\`: the array length
-- is then measured once per loop instead of once per step, and a body that
-- clears the field it was just handed (the \`wipe\` idiom) cannot shrink the run
-- out from under the traversal.
function pairs(t)
  local n = _arrayLength(t)
  local index, hashKey, inHash = 0, nil, false
  return function()
    if not inHash then
      while index < n do
        index = index + 1
        local value = rawget(t, index)
        if value ~= nil then return index, value end
      end
      inHash = true
      local key, value = _afterArray(t, n, nil)
      hashKey = key
      return key, value
    end
    if hashKey == nil then return nil end
    local key, value = _afterArray(t, n, hashKey)
    hashKey = key
    return key, value
  end, t, nil
end

function getglobal(name) return _G[name] end
function setglobal(name, value) _G[name] = value end

-- Taint is not modelled: this client runs the user's own interface files and
-- has no protected-function boundary to guard. securecall keeps the corpus'
-- call shape (and its error isolation), issecure answers honestly.
-- Every result, not the first one. \`OptionsFrameTemplates.lua\` wraps \`next\` in it —
-- \`local function SecureNext(elements, key) return securecall(next, elements, key) end\` — and
-- \`for i, element in SecureNext, categoryList do if ( not element.hidden )\` then indexed the
-- value \`next\` returned. Handing back only the key made that «attempt to index a nil value
-- (local 'element')» on the first iteration of every options list. The two-function shape is what
-- keeps a nil in the middle of the result list: \`{pcall(...)}\` plus \`#\` would truncate at one.
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

-- fengari keeps no collector of its own and raises «lua_gc not implemented» for every
-- \`collectgarbage\` option. Client add-ons call it: MikScrollingBattleText runs
-- \`collectgarbage("collect")\` at the end of loading its profiles (MSBTProfiles.lua:2097), and the
-- raise took the rest of that function with it. The JavaScript engine owns the memory, so a
-- collection request is accepted and does nothing, and the counters answer 0 kilobytes; the tuning
-- options answer 5.1's defaults, and an unknown option still raises the way 5.1 does.
local _gcOptions = { collect = 0, stop = 0, restart = 0, count = 0, step = true,
  setpause = 200, setstepmul = 200, isrunning = true }
function collectgarbage(option, argument)
  option = option == nil and "collect" or option
  local answer = _gcOptions[option]
  if answer == nil then
    error("bad argument #1 to 'collectgarbage' (invalid option '" .. tostring(option) .. "')", 2)
  end
  return answer
end
function gcinfo() return 0 end

-- 5.3's \`/\` always answers a float, and a numeric \`for\` whose *initial* value is one runs its
-- control variable as a float too. That is not cosmetic where the corpus builds a global's name
-- out of it: \`CharacterCreate.numClasses = select("#", ...)/3\` is \`10.0\` on this dataset, so
-- \`for i = CharacterCreate.numClasses + 1, MAX_CLASSES_PER_RACE\` starts at \`11.0\` and
-- \`_G["CharacterCreateClassButton"..i]\` looks up \`CharacterCreateClassButton11.0\`, which is nil.
-- \`CharacterCreateEnumerateClasses\` then died on \`:Hide()\` (\`CharacterCreate.lua:233\`), taking
-- the rest of \`CharacterCreate_OnShow\` with it: no class buttons, no race labels and no backdrop
-- model — measured in the live page, where the creation screen came up with its XML placeholders.
--
-- 5.1 had one number type and spelled \`11.0\` as \`11\`, so the name the corpus builds is the name
-- the widget has. The lookup is repaired rather than the arithmetic, because the arithmetic is
-- the client's own and the divergence only ever shows here: a miss whose key ends in \`.0\` is
-- retried without it. \`rawget\`, so a chain of missing globals cannot recurse.
--
-- \`__index\` runs only on a miss, and the corpus misses globals on purpose — \`ABILITY_INFO_<race>n\`
-- is walked until it runs out — so this is one pattern match on a path that was already returning
-- nil, and nothing at all on a hit.
setmetatable(_G, {
  __index = function(globals, key)
    if type(key) ~= "string" then return nil end
    local whole = string.match(key, "^(.-)%.0$")
    if whole == nil then return nil end
    return rawget(globals, whole)
  end,
})
`;

/**
 * `lua_checkstack`, which fengari implements and its bundled types do not declare.
 *
 * Narrow rather than a blanket cast so the missing declaration is one line and is named: a C
 * function is promised `LUA_MINSTACK` slots, and anything that means to push more has to ask.
 */
function checkStack(state: LuaState, slots: number): boolean {
  const api = lua as unknown as { lua_checkstack?: (state: LuaState, slots: number) => boolean };
  return api.lua_checkstack ? api.lua_checkstack(state, slots) : true;
}

/** Escape characters Lua 5.3 accepts after a backslash inside a short string. */
const LUA53_ESCAPES = new Set(["a", "b", "f", "n", "r", "t", "v", "\\", '"', "'", "x", "z", "u", "\n", "\r"]);

/** `[[`, `[=[`, … — returns the level, or -1 when this is not a long bracket. */
function longBracketLevel(source: string, offset: number): number {
  if (source[offset] !== "[") return -1;
  let level = 0;
  let index = offset + 1;
  while (source[index] === "=") {
    level += 1;
    index += 1;
  }
  return source[index] === "[" ? level : -1;
}

/**
 * Apply Lua 5.1's escape rule to a chunk 5.3 refuses to lex.
 *
 * 5.1's lexer dropped the backslash of an unknown escape and kept the
 * character; 5.2 made the same input a syntax error. The corpus depends on the
 * old rule: `Interface\SharedXML\SharedGlueStrings.lua` (from the server's own
 * `patch-ruRU-F`) contains `"… пароль? \Небезопасно …"` and the same bug again
 * in its deDE line, and the real client loads that file. Under 5.3 it would
 * take the whole chunk — and with it every string the login screen localises —
 * out of the run.
 *
 * The rewrite is confined to short string literals: comments and long-bracket
 * strings are copied through untouched, and every escape 5.3 already
 * understands is preserved, so nothing that lexes today can change meaning.
 */
export function relaxLua51Escapes(source: string): { readonly source: string; readonly rewrites: number } {
  let out = "";
  let index = 0;
  let rewrites = 0;
  const length = source.length;
  const copyLongBracket = (start: number, level: number): number => {
    const closing = `]${"=".repeat(level)}]`;
    const end = source.indexOf(closing, start);
    const stop = end < 0 ? length : end + closing.length;
    out += source.slice(start, stop);
    return stop;
  };
  while (index < length) {
    const char = source[index]!;
    if (char === "-" && source[index + 1] === "-") {
      const level = longBracketLevel(source, index + 2);
      if (level >= 0) {
        out += "--";
        index = copyLongBracket(index + 2, level);
        continue;
      }
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? length : end;
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    const level = longBracketLevel(source, index);
    if (level >= 0) {
      index = copyLongBracket(index, level);
      continue;
    }
    if (char === '"' || char === "'") {
      out += char;
      index += 1;
      while (index < length) {
        const inner = source[index]!;
        if (inner === "\\") {
          const next = source[index + 1];
          if (next !== undefined && (LUA53_ESCAPES.has(next) || (next >= "0" && next <= "9"))) {
            out += inner + next;
          } else {
            rewrites += 1;
            out += next ?? "";
          }
          index += 2;
          continue;
        }
        out += inner;
        index += 1;
        if (inner === char || inner === "\n") break;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return { source: out, rewrites };
}

export interface GlueLuaOptions {
  /** Where an unhandled Lua error goes when the corpus has set no handler. */
  readonly onError?: (message: string) => void;
  /** `print()` from Lua; the corpus uses it only inside LibDeflate's test code. */
  readonly onPrint?: (message: string) => void;
}

/**
 * A handle to a Lua value living in the registry.
 *
 * Arguments that are not scalars reach a JS binding as one of these and are
 * released when the binding returns, unless it calls `vm.retain(ref)` — which
 * is exactly what `seterrorhandler(_ERRORMESSAGE)` needs.
 */
export class GlueLuaRef {
  constructor(readonly key: number, readonly type: string) {}
}

/** Decode a Lua table/function into a host object (frames, for instance). */
export type GlueLuaTableDecoder = (L: LuaState, index: number) => unknown | undefined;
/** Push a host object as a Lua value; return false to fall through to a table. */
export type GlueLuaValueEncoder = (L: LuaState, value: object) => boolean;

export type GlueLuaBinding = (args: readonly unknown[]) => readonly unknown[] | void;

const LUA_OK = 0;

/**
 * The glue screen's Lua interpreter.
 *
 * One VM per glue session. It owns the state, the 5.1 shim preamble, the
 * error-handler protocol the corpus installs from `GlueBasicControls.xml`, and
 * the marshalling seams the widget layer and the C-API plug into. It never
 * opens fengari-interop's `js` library, so no chunk it runs can reach `window`,
 * `document`, fetch or WebSocket except through a binding registered here.
 */
export class GlueLuaVm {
  readonly #state: LuaState;
  readonly #options: GlueLuaOptions;
  readonly #hostSources: string[] = [];
  #decoder: GlueLuaTableDecoder | undefined;
  #encoder: GlueLuaValueEncoder | undefined;
  #errorHandler: GlueLuaRef | undefined;
  #defaultErrorHandler: GlueLuaRef | undefined;
  #closed = false;
  /** Errors that reached no handler; kept so a loader can report them. */
  readonly errors: string[] = [];
  /** Chunks that only lexed after Lua 5.1's unknown-escape rule was applied. */
  readonly relaxedChunks: string[] = [];

  constructor(options: GlueLuaOptions = {}) {
    this.#options = options;
    this.#state = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.#state);
    this.installErrorProtocol();
    const shimmed = this.execute(LUA51_SHIMS, "@GlueLua:shims");
    if (!shimmed.ok) throw new Error(`glue Lua shims failed to load: ${shimmed.error}`);
  }

  get state(): LuaState {
    return this.#state;
  }

  get luaVersion(): string {
    return "Lua 5.3 (fengari) with a measured 5.1 compatibility layer";
  }

  setTableDecoder(decoder: GlueLuaTableDecoder | undefined): void {
    this.#decoder = decoder;
  }

  setValueEncoder(encoder: GlueLuaValueEncoder | undefined): void {
    this.#encoder = encoder;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    lua.lua_close(this.#state);
  }

  /**
   * Whether `close()` has run. fengari throws on the first touch of a closed state («Cannot set
   * properties of null»), so host callbacks that can outlive the VM — a tooltip redraw waiting on
   * a late item row — ask this before calling in, rather than probing with a call that throws.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * `seterrorhandler`/`geterrorhandler`/`message`, plus `print`.
   *
   * `GlueBasicControls.xml` installs `_ERRORMESSAGE` as the handler at load
   * time and the whole corpus assumes a script error surfaces as a dialog
   * rather than as a dead screen — so the handler protocol has to exist before
   * the first corpus chunk runs, which is why it is installed here and not by
   * the C-API module.
   */
  private installErrorProtocol(): void {
    // `securecall` calls `geterrorhandler()(message)` unconditionally, so the
    // getter must always answer with something callable — before
    // GlueBasicControls.xml has installed `_ERRORMESSAGE`, and after a screen
    // has torn it down again.
    this.pushBinding("__glueDefaultErrorHandler", (args) => {
      const message = String(args[0] ?? "");
      this.errors.push(message);
      this.#options.onError?.(message);
      return [];
    });
    this.#defaultErrorHandler = new GlueLuaRef(
      lauxlib.luaL_ref(this.#state, lua.LUA_REGISTRYINDEX),
      "function",
    );
    this.registerGlobal("seterrorhandler", (args) => {
      const handler = args[0];
      if (handler instanceof GlueLuaRef && handler.type === "function") {
        this.releaseErrorHandler();
        this.#errorHandler = this.retain(handler);
      }
      return [];
    });
    this.registerGlobal("geterrorhandler", () => [this.#errorHandler ?? this.#defaultErrorHandler]);
    this.registerGlobal("print", (args) => {
      this.#options.onPrint?.(args.map((value) => String(value ?? "nil")).join("\t"));
      return [];
    });
  }

  private releaseErrorHandler(): void {
    if (!this.#errorHandler) return;
    lauxlib.luaL_unref(this.#state, lua.LUA_REGISTRYINDEX, this.#errorHandler.key);
    this.#errorHandler = undefined;
  }

  /**
   * Route an error the way the corpus expects.
   *
   * The glue error handler is Lua (`_ERRORMESSAGE` -> `ScriptErrors:Show()`),
   * so a failing script must not take the screen down; it must land in the
   * dialog. Only an error raised while the handler itself is running falls
   * through to the host sink.
   */
  reportError(message: string): void {
    this.errors.push(message);
    const handler = this.#errorHandler;
    if (handler) {
      const before = lua.lua_gettop(this.#state);
      lua.lua_rawgeti(this.#state, lua.LUA_REGISTRYINDEX, handler.key);
      lua.lua_pushstring(this.#state, to_luastring(message));
      const status = lua.lua_pcall(this.#state, 1, 0, 0);
      if (status === LUA_OK) {
        lua.lua_settop(this.#state, before);
        return;
      }
      lua.lua_settop(this.#state, before);
    }
    this.#options.onError?.(message);
  }

  /**
   * Load and run one chunk.
   *
   * `chunkName` is the file path, prefixed so Lua reports it verbatim: an
   * error inside `AccountLogin.lua` has to name that file, because the corpus
   * is 70 files deep and a bare "chunk" is useless.
   */
  execute(
    source: string,
    chunkName: string,
    args: readonly unknown[] = [],
  ): { readonly ok: boolean; readonly error?: string } {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    // The chunk, the traceback handler and every argument; see `call`.
    if (!checkStack(L, args.length + 3)) {
      return { ok: false, error: `${chunkName}: stack overflow passing ${args.length} arguments` };
    }
    const loaded = this.loadBuffer(source, chunkName);
    if (loaded !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      return { ok: false, error: message };
      }
      const handlerIndex = this.pushTracebackHandler(top + 1);
      for (const arg of args) this.pushValue(arg);
      const status = lua.lua_pcall(L, args.length, 0, handlerIndex);
    if (status !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      return { ok: false, error: message };
    }
    lua.lua_settop(L, top);
    return { ok: true };
  }

  /**
   * Load one chunk, retrying under Lua 5.1's escape rule if 5.3 refuses it.
   *
   * The retry is narrow on purpose: it fires only on the exact lexer error the
   * old rule explains, and only for a chunk that would otherwise not run at
   * all. Which chunks needed it is recorded rather than hidden, because it is a
   * property of the corpus worth knowing.
   */
  private loadBuffer(source: string, chunkName: string): number {
    const L = this.#state;
    const status = lauxlib.luaL_loadbuffer(L, to_luastring(source), null, to_luastring(chunkName));
    if (status === LUA_OK) return status;
    const message = lua.lua_tojsstring(L, -1) ?? "";
    if (!/invalid escape sequence/i.test(message)) return status;
    const relaxed = relaxLua51Escapes(source);
    if (relaxed.rewrites === 0) return status;
    lua.lua_pop(L, 1);
    const retried = lauxlib.luaL_loadbuffer(L, to_luastring(relaxed.source), null, to_luastring(chunkName));
    if (retried === LUA_OK) this.relaxedChunks.push(chunkName);
    return retried;
  }

  /** Run a chunk and send any failure through the corpus' error handler. */
  executeReported(source: string, chunkName: string, args: readonly unknown[] = []): boolean {
    const result = this.execute(source, chunkName, args);
    if (!result.ok) this.reportError(result.error ?? `${chunkName} failed`);
    return result.ok;
  }

  /**
   * Compile `source` as `function(<parameters>, ...) <source> end`.
   *
   * This is the shape an XML script body has to take: the body is written as
   * if the parameters were already in scope (`AccountLogin_OnKeyDown(key)`),
   * and the trailing vararg is what `GlueParent_OnEvent(event, ...)` forwards.
   */
  compileFunction(
    source: string,
    chunkName: string,
    parameters: readonly string[],
  ): GlueLuaRef | undefined {
    const signature = [...parameters, "..."].join(", ");
    const wrapped = `return function(${signature})\n${source}\nend`;
    const L = this.#state;
    const top = lua.lua_gettop(L);
    if (this.loadBuffer(wrapped, `@${chunkName}`) !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      this.reportError(`${chunkName}: ${message}`);
      return undefined;
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      this.reportError(`${chunkName}: ${message}`);
      return undefined;
    }
    const ref = new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), "function");
    lua.lua_settop(L, top);
    return ref;
  }

  /** Call a retained Lua function; failures go through the corpus' handler. */
  call(ref: GlueLuaRef, args: readonly unknown[] = [], results = 0): readonly unknown[] {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    // The function, its arguments and the traceback handler, asked for before the first push. A
    // host call starts with `LUA_MINSTACK` (20) free slots and nothing grows them: a 3.3.5
    // `COMBAT_LOG_EVENT_UNFILTERED` dispatch (event name + 19 payload values, through
    // `__glueInvoke`'s fn/self/isEvent) threw fengari's «stack overflow» straight out of
    // `bridge.tick`, which nothing on the world mount's frame loop catches.
    if (!checkStack(L, args.length + 3)) {
      this.reportError(`stack overflow passing ${args.length} arguments`);
      return [];
    }
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
    if (!lua.lua_isfunction(L, -1)) {
      lua.lua_settop(L, top);
      return [];
    }
    for (const arg of args) this.pushValue(arg);
    const handlerIndex = this.pushTracebackHandler(top + 1);
    const status = lua.lua_pcall(L, args.length, results, handlerIndex);
    if (status !== LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      this.reportError(message);
      return [];
    }
    const values: unknown[] = [];
    const resultCount = results === lua.LUA_MULTRET ? lua.lua_gettop(L) - top - 1 : results;
    for (let index = 0; index < resultCount; index += 1) {
      values.push(this.toValue(top + 1 + index + 1));
    }
    lua.lua_settop(L, top);
    return values;
  }

  /** Keep a Lua value alive past the binding call that produced it. */
  retain(ref: GlueLuaRef): GlueLuaRef {
    const L = this.#state;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
    return new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), ref.type);
  }

  release(ref: GlueLuaRef): void {
    lauxlib.luaL_unref(this.#state, lua.LUA_REGISTRYINDEX, ref.key);
  }

  /**
   * Bind a JS function as a Lua global.
   *
   * The binding sees decoded arguments and returns decoded results; it never
   * touches the stack, so a C-API entry cannot corrupt the VM by miscounting.
   */
  registerGlobal(name: string, binding: GlueLuaBinding): void {
    this.pushBinding(name, binding);
    lua.lua_setglobal(this.#state, to_luastring(name));
  }

  /** Allocate one stable Lua table for an add-on's second chunk argument. */
  createTable(): GlueLuaRef {
    lua.lua_newtable(this.#state);
    return new GlueLuaRef(lauxlib.luaL_ref(this.#state, lua.LUA_REGISTRYINDEX), "table");
  }

  /** Push a JS function as a Lua value without naming it (for method tables). */
  pushBinding(name: string, binding: GlueLuaBinding): void {
    const L = this.#state;
    lua.lua_pushjsfunction(L, (state: LuaState): number => {
      // `state` is the thread that actually called us, which is not the main
      // state when a coroutine is running (LibDeflate uses one). Marshal
      // against it; registry references are shared across threads either way.
      const count = lua.lua_gettop(state);
      const args: unknown[] = [];
      const scratch: GlueLuaRef[] = [];
      for (let index = 1; index <= count; index += 1) {
        args.push(this.toValue(index, scratch, state));
      }
      let results: readonly unknown[] = [];
      try {
        results = binding(args) ?? [];
      } catch (error) {
        for (const ref of scratch) this.release(ref);
        lua.lua_pushstring(state, to_luastring(`${name}: ${String(error)}`));
        return lua.lua_error(state);
      }
      for (const ref of scratch) this.release(ref);
      lua.lua_settop(state, 0);
      // A C function is guaranteed `LUA_MINSTACK` — **twenty** — free slots and nothing more, and
      // this is the first binding in the client to answer with more than that:
      // `GetAvailableRaces()` is three values per race, so ten races is thirty and the thirty-first
      // push overflows the stack. Measured before this check: `CharacterCreate_OnShow` died on the
      // call itself, the creation screen came up with no races, no classes and no backdrop, and the
      // corpus' own error handler swallowed the message so nothing said why.
      if (results.length > 0 && !checkStack(state, results.length)) {
        lua.lua_pushstring(state, to_luastring(`${name}: stack overflow returning ${results.length} values`));
        return lua.lua_error(state);
      }
      for (const value of results) this.pushValue(value, state);
      return results.length;
    });
  }

  setGlobal(name: string, value: unknown): void {
    this.pushValue(value);
    lua.lua_setglobal(this.#state, to_luastring(name));
  }

  /**
   * Read a global. A table or function comes back as a retained `GlueLuaRef`
   * that the caller owns and must `release`; scalars need no cleanup.
   */
  getGlobal(name: string): unknown {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    lua.lua_getglobal(L, to_luastring(name));
    const value = this.toValue(-1);
    lua.lua_settop(L, top);
    return value;
  }

  /** Host-only source attribution for a Lua callback, without exposing the debug library. */
  functionSource(ref: GlueLuaRef): string | undefined {
    if (ref.type !== "function") return undefined;
    const L = this.#state;
    const top = lua.lua_gettop(L);
    try {
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref.key);
      if (!lua.lua_isfunction(L, -1)) return undefined;
      const info = new lua.lua_Debug();
      return lua.lua_getinfo(L, to_luastring(">S"), info) ? to_jsstring(info.source) : undefined;
    } finally { lua.lua_settop(L, top); }
  }

  /** Inspect creation provenance in the host without enabling Lua's debug library. */
  callingSources(): readonly string[] {
    const sources: string[] = [];
    const info = new lua.lua_Debug();
    for (let level = 0; level < 64 && lua.lua_getstack(this.#state, level, info); level += 1) {
      if (lua.lua_getinfo(this.#state, to_luastring("S"), info)) sources.push(to_jsstring(info.source));
    }
    return [...sources, ...this.#hostSources.slice().reverse()];
  }

  /** Source and line only: a full traceback searches all globals for function names in Fengari. */
  callingLocation(excludedSource: string): string {
    const info = new lua.lua_Debug();
    for (let level = 0; level < 64 && lua.lua_getstack(this.#state, level, info); level += 1) {
      if (!lua.lua_getinfo(this.#state, to_luastring("Sl", true), info)) continue;
      const source = to_jsstring(info.source);
      if (source === "=[C]" || source.includes(excludedSource) || info.currentline < 0) continue;
      return source.replace(/^@/, "") + ":" + info.currentline;
    }
    return "";
  }

  /** XML creation has no Lua file on the stack, but its inline handlers still belong to that file. */
  withCallingSource<T>(source: string, callback: () => T): T {
    this.#hostSources.push(source);
    try { return callback(); } finally { this.#hostSources.pop(); }
  }

  /** Retain the global `name` if it is a function, for a later `call`. */
  globalFunction(name: string): GlueLuaRef | undefined {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    lua.lua_getglobal(L, to_luastring(name));
    if (!lua.lua_isfunction(L, -1)) {
      lua.lua_settop(L, top);
      return undefined;
    }
    const ref = new GlueLuaRef(lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX), "function");
    lua.lua_settop(L, top);
    return ref;
  }

  /**
   * Read a global as a string; the GlobalString resolver for XML `text=`.
   *
   * The type is checked on the stack rather than by converting first: this runs
   * once per `text=` attribute across the whole corpus, and a global that
   * happens to be a table would otherwise pin a registry reference on every
   * miss.
   */
  globalString(name: string): string | undefined {
    const L = this.#state;
    const top = lua.lua_gettop(L);
    const type = lua.lua_getglobal(L, to_luastring(name));
    const value = type === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : undefined;
    lua.lua_settop(L, top);
    return value;
  }

  /** Push any host value. Scalars go through fengari-interop; the rest here. */
  pushValue(value: unknown, state: LuaState = this.#state): void {
    const L = state;
    if (value === undefined || value === null) {
      lua.lua_pushnil(L);
      return;
    }
    if (
      typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= LUA_INTEGER_MIN
      && value <= LUA_INTEGER_MAX
    ) {
      // A whole number crosses as a Lua *integer*, not as a float, and the difference is visible in
      // the corpus' own text: 5.3 concatenates a float as "1.0", so `_G["CharSelectCharacterButton"
      // ..index]` with the index this host had pushed looked up `CharSelectCharacterButton1.0` and
      // indexed nil (`CharacterSelect.lua:305`, measured in the live page). 5.1 had one number type
      // and printed "1". Everything the C API answers with that is conceptually a count, an index
      // or an id is integral; `GetTime()` and the fade deltas are not, and stay floats.
      lua.lua_pushinteger(L, value);
      return;
    }
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      pushInterop(L, value);
      return;
    }
      if (value instanceof GlueLuaRef) {
        lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, value.key);
        return;
      }
    if (typeof value === "object" && this.#encoder?.(L, value as object)) return;
    // A nested table holds one more slot per level while its entries are pushed.
    if (typeof value === "object" && !checkStack(L, 2)) {
      lua.lua_pushnil(L);
      return;
    }
    if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((entry, index) => {
        this.pushValue(entry, L);
        lua.lua_rawseti(L, -2, index + 1);
      });
      return;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      lua.lua_createtable(L, 0, entries.length);
      for (const [key, entry] of entries) {
        this.pushValue(entry, L);
        lua.lua_setfield(L, -2, to_luastring(key));
      }
      return;
    }
    lua.lua_pushnil(L);
  }

  /**
   * Read the value at `index`.
   *
   * `scratch` collects the registry references created for non-scalars so a
   * binding call can free them all at once; without it, every table argument
   * the corpus passes would pin a value forever.
   */
  toValue(index: number, scratch?: GlueLuaRef[], state: LuaState = this.#state): unknown {
    const L = state;
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TNONE || type === lua.LUA_TNIL) return undefined;
    if (type === lua.LUA_TBOOLEAN || type === lua.LUA_TNUMBER || type === lua.LUA_TSTRING) {
      return interopToJs(L, index);
    }
    if (type === lua.LUA_TTABLE || type === lua.LUA_TFUNCTION) {
      const decoded = this.#decoder?.(L, index);
      if (decoded !== undefined) return decoded;
      lua.lua_pushvalue(L, index);
      const ref = new GlueLuaRef(
        lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX),
        type === lua.LUA_TFUNCTION ? "function" : "table",
      );
      scratch?.push(ref);
      return ref;
    }
    return undefined;
  }

  /**
   * Push a message handler that appends a Lua traceback, and slide it under the
   * call already staged on the stack.
   *
   * `targetIndex` is where the called function currently sits. A traceback is
   * what makes an error in this corpus actionable: the failing line is usually
   * four calls deep inside one of 70 files.
   */
  private pushTracebackHandler(targetIndex: number): number {
    const L = this.#state;
    lua.lua_pushjsfunction(L, (state: LuaState): number => {
      const message = lua.lua_tojsstring(state, -1);
      lauxlib.luaL_traceback(state, state, to_luastring(message ?? "error"), 1);
      return 1;
    });
    lua.lua_insert(L, targetIndex);
    return targetIndex;
  }
}

/** The shim source, exported so a test can assert what is actually installed. */
export const GLUE_LUA51_SHIM_SOURCE = LUA51_SHIMS;

/**
 * The shims this slice measured as load-bearing, with their corpus call counts.
 *
 * Kept as data rather than prose so the numbers in `README.md` and the ones a
 * test asserts cannot drift apart.
 */
export const GLUE_MEASURED_SHIMS: Readonly<Record<string, number>> = Object.freeze({
  strlen: 51, format: 25, strupper: 11, tinsert: 10, getglobal: 9, strsub: 8, gsub: 8,
  strbyte: 3, strchar: 2, gmatch: 2, unpack: 2, strfind: 1, tremove: 1, tconcat: 1,
  getn: 1, sort: 1, strreplace: 1,
  max: 32, time: 27, mod: 21, min: 16, floor: 14, date: 4, random: 3, ceil: 3, abs: 1,
  securecall: 10, issecure: 1, seterrorhandler: 1, debuginfo: 1, print: 2,
  "math.frexp": 1,
});

/** Measured as unused by the corpus; recorded so the absence is a decision. */
export const GLUE_UNUSED_SHIMS: readonly string[] = Object.freeze([
  "setfenv", "getfenv", "loadstring", "wipe", "strsplit", "strjoin", "strtrim", "strconcat",
]);
