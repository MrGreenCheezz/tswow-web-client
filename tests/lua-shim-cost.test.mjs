import assert from "node:assert/strict";
import test from "node:test";
import { GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from "fengari";

// The 5.1 `format` and `pairs` shims sit under every stock combat-log line: measured 02.10 on the
// vertical with Blizzard_CombatLog, 60 % of a COMBAT_LOG_EVENT's Lua time was the `format` shim
// re-scanning its format string with string.find/match on every call, 7 % the `pairs` shim walking
// a hash-only table (unitColoring) through `_afterArray`. Instruction counts from fengari's count
// hook are deterministic, so the budget is asserted on them rather than on wall time.

/** The pre-02.10 shim, kept verbatim as the oracle the planned one must agree with. */
const ORACLE = `
local _format = string.format
local function _positional(fmt, args)
  local out, values, taken, index, position = {}, {}, 0, 0, 1
  while true do
    local start = string.find(fmt, "%%", position)
    if not start then out[#out + 1] = string.sub(fmt, position) break end
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
function __oracleformat(fmt, ...)
  local count = select("#", ...)
  if type(fmt) ~= "string" or count == 0 then return _format(fmt, ...) end
  local args, index, position = {...}, 0, 1
  if string.find(fmt, "%%%d+%$") then fmt, args, count = _positional(fmt, args) end
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
          if type(value) == "number" then
            -- L5b 3.27: Wow.exe's casts (str_format 0x00853c50), not a floor: toward zero; d/i/c
            -- -2^31 outside int32 (NaN, inf too), o/u/x/X the low 32 bits of an int64 (0 outside).
            local n = value ~= value and 0 or (value < 0 and math.ceil(value) or math.floor(value))
            if spec == "o" or spec == "u" or spec == "x" or spec == "X" then
              n = (value ~= value or n >= 2^63 or n < -2^63) and 0 or n % 2^32
              if n >= 2^31 then n = n - 2^32 end
            elseif value ~= value or n >= 2^31 or n < -2^31 then
              n = -2^31
            end
            args[index] = n
          end
        end
      end
    end
  end
  return _format(fmt, table.unpack(args, 1, count))
end
`;

/** A pristine fengari state (5.3 `string.format`) running the oracle; answers `__r` as a string. */
function oracleState() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  assert.equal(lauxlib.luaL_dostring(L, to_luastring(ORACLE)), lua.LUA_OK);
  return {
    run(source) {
      assert.equal(lauxlib.luaL_dostring(L, to_luastring(source)), lua.LUA_OK, source);
      lua.lua_getglobal(L, to_luastring("__r"));
      const value = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      return value;
    },
  };
}

function instructions(vm, source, chunk) {
  let count = 0;
  lua.lua_sethook(vm.state, () => { count += 1; }, lua.LUA_MASKCOUNT, 1);
  try {
    const outcome = vm.execute(source, chunk);
    assert.equal(outcome.ok, true, outcome.error);
  } finally {
    lua.lua_sethook(vm.state, null, 0, 0);
  }
  return count;
}

test("format and pairs shims stay within an instruction budget on the combat log's shapes", () => {
  const vm = new GlueLuaVm();
  try {
    // Blizzard_CombatLog.lua:1799 (CombatLog_Color_FloatToText) and a plain %s, 100 calls each.
    const hex = instructions(vm, 'for i = 1, 100 do local s = ("%.2x%.2x%.2x%.2x"):format(255, 128, 64, 32) end', "@hex");
    const plain = instructions(vm, 'for i = 1, 100 do local s = format("%s hits %s", "a", "b") end', "@plain");
    // A hash-only table, as unitColoring is: masks as keys.
    const walk = instructions(vm, `
      local t = { [0x511] = 1, [0xa48] = 2, [0x1112] = 3, [0x80000000] = 4 }
      for i = 1, 100 do for k, v in pairs(t) do end end`, "@pairs");
    console.log(`instructions per call: hex ${hex / 100}, plain ${plain / 100}, pairs(4 hash keys) ${walk / 100}`);
    // Before 02.10: hex 249, plain 103, pairs 186 per call; after: 71, 24, 25.
    assert.ok(hex / 100 < 90, `hex format: ${hex / 100} instructions per call`);
    assert.ok(plain / 100 < 40, `plain format: ${plain / 100} instructions per call`);
    assert.ok(walk / 100 < 40, `pairs over a hash-only table: ${walk / 100} instructions per walk`);
  } finally {
    vm.close();
  }
});

// 05.10-3.27: the cases where Wow.exe's str_format (0x00853c50) answers otherwise than the shim did:
// %s is luaL_checklstring (nil raises), a missing argument is luaL_check*'s «got no value», a
// trailing '%' is «invalid option in `format'», and the function is named 'format'.
const CLIENT_ANSWERS = {
  '"%s", nil': "err:bad argument #2 to 'format' (string expected, got nil)",
  '"%s %s", "only"': "err:bad argument #3 to 'format' (string expected, got no value)",
  '"100%"': "err:invalid option in `format'",
  '"%d", "12abc"': "err:bad argument #2 to 'format' (number expected, got string)",
};

test("the planned format answers exactly as the scanning shim did", () => {
  const vm = new GlueLuaVm();
  try {
    const oracle = oracleState();
    const cases = [
      ['"%d", 3.7'], ['"%d items, 100%% done", 12 / 4'], ['"%2$s %1$d-го уровня", 7.9, "Воин"'],
      ['"%1$s and %1$s", "x"'], ['"%2$s %s", "a", "b", "c"'], ['"%s %3$d %s", "a", "b", 4.5, "d"'],
      ['"%.2x%.2x%.2x%.2x", 255.9, 128, 64.2, "32"'], ['"%5.1f|%-3d|%+d", 2.25, 3.9, -4.1'],
      ['"%s", nil'], ['"%s %s", "only"'], ['"%c%c", 72.4, 105'], ['"100%"', ''], ['"%q", "a\\nb"'],
      ['"%d", "12abc"'], ['"%x %X %o %u %i", 255.5, 255.5, 8.1, 3.3, -2.2'], ['"plain"', '1'],
      ['"%5$s", 1, 2, 3, 4, "five"'], ['"%% %d %%", 9.9'], ['"%.3s|%10s", "abcdef", "r"'],
      ['"%d", 1/0'], ['"%d", 0/0'],
    ];
    for (const [fmt, rest = ""] of cases) {
      const args = rest ? `${fmt}, ${rest}` : fmt;
      const body = (fn) => `local ok, v = pcall(${fn}, ${args}); __r = (ok and "ok:" or "err:") .. (string.gsub(tostring(v), "^.-:%d+: ", ""))`;
      const run = (fn) => {
        vm.setGlobal("__r", undefined);
        const outcome = vm.execute(body(fn), "@case");
        assert.equal(outcome.ok, true, outcome.error);
        return vm.getGlobal("__r");
      };
      // Twice: the second call goes through the cached plan.
      // 05.10-3.27: format is Wow.exe's str_format now (GlueLuaFormat.ts); where the client parts
      // from the scanning shim, its answer stands (tests/glue-lua-format.test.mjs has the rest).
      const expected = CLIENT_ANSWERS[args] ?? oracle.run(body("__oracleformat"));
      assert.equal(run("string.format"), expected, `format(${args})`);
      assert.equal(run("string.format"), expected, `format(${args}), cached`);
    }
    // Non-string formats and no arguments keep the raw behaviour.
    vm.setGlobal("__r", undefined);
    assert.equal(vm.execute('__r = format("%%") .. "|" .. format("%d", 5) .. "|" .. format(12)', "@edge").ok, true);
    assert.equal(vm.getGlobal("__r"), "%|5|12");
  } finally {
    vm.close();
  }
});

test("pairs keeps PUC order: array part ascending first, then the hash part, for every shape", () => {
  const vm = new GlueLuaVm();
  try {
    const order = (construct) => {
      vm.setGlobal("__r", undefined);
      const outcome = vm.execute(`local t = ${construct}; local out = {}
        for k, v in pairs(t) do out[#out + 1] = tostring(k) .. "=" .. tostring(v) end
        __r = table.concat(out, ",")`, "@order");
      assert.equal(outcome.ok, true, outcome.error);
      return vm.getGlobal("__r");
    };
    assert.equal(order("{ 10, 20, 30 }"), "1=10,2=20,3=30");
    assert.match(order("{ 10, 20, x = 1 }"), /^1=10,2=20,x=1$/);
    const hash = order("{ [0x511] = 1, [0xa48] = 2, name = 3 }").split(",").sort().join(",");
    assert.equal(hash, "1297=1,2632=2,name=3");
    assert.equal(order("{}"), "");
    // The wipe idiom over a hash-only table clears it.
    vm.setGlobal("__r", undefined);
    assert.equal(vm.execute('local t = { a = 1, b = 2, c = 3 }; wipe(t); __r = next(t) == nil', "@wipe").ok, true);
    assert.equal(vm.getGlobal("__r"), true);
  } finally {
    vm.close();
  }
});
