import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27 (04.10, L5b): the Lua 5.1 base functions as Wow.exe 3.3.5a (12340) has them
// (notes .runtime/re-2026-10-04/l5b/h1.c). fengari's integers are 32-bit, so the preamble's
// `tostring` and `format("%d")` raised «number has no integer representation» on any whole float
// past 2^31 — `tostring(GetTime() * 1000)`, an epoch millisecond — where the client prints with
// "%.14g" (0x00856ea0, MSVC's printf: three exponent digits, 1.#INF) and casts like C
// (str_format 0x00853c50: %d/%i/%c through __ftol2_sse 0x0088b9c0, %o/%u/%x/%X through a
// chopping FISTP keeping the low 32 bits). `pairs` and `ipairs` are 5.1's (0x008546e0, 0x00854770
// with 0x00854720): the native `next` with the table and nil, and raw reads from 1.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

function withVm(body) {
  const vm = new GlueLuaVm();
  try {
    body(vm);
  } finally {
    vm.close();
  }
}

/** `expression`'s value, evaluated twice (a cached format plan answers the second time). */
function value(vm, expression) {
  const answers = [];
  for (let round = 0; round < 2; round += 1) {
    vm.setGlobal("__r", undefined);
    const result = vm.execute(`__r = ${expression}`, "@base51");
    assert.equal(result.ok, true, `${expression}: ${result.error}`);
    answers.push(vm.getGlobal("__r"));
  }
  assert.equal(answers[1], answers[0], `${expression}: the second call differs`);
  return answers[0];
}

/** The error `call` raises, without its "chunk:line:" prefix (or "ok" when it does not raise). */
function failure(vm, call) {
  vm.setGlobal("__r", undefined);
  const result = vm.execute(`local ok, message = pcall(${call}) __r = ok and "ok" or tostring(message)`, "@base51");
  assert.equal(result.ok, true, result.error);
  return String(vm.getGlobal("__r")).replace(/^[^:]*:\d+: /, "");
}

test("tostring prints a number as the client's \"%.14g\", whole floats past 32 bits included", () => {
  withVm((vm) => {
    const cases = [
      ["2^31", "2147483648"], ["2^31 - 1", "2147483647"], ["-2^31", "-2147483648"], ["-2^31 - 1", "-2147483649"],
      ["1759999999123", "1759999999123"], ["1759999999.123 * 1000", "1759999999123"],
      ["99999999999999", "99999999999999"], ["1e14", "1e+014"], ["1e15", "1e+015"], ["2^53", "9.007199254741e+015"],
      ["123456789012345", "1.2345678901235e+014"], ["1e100", "1e+100"], ["1e21", "1e+021"],
      ["0.1", "0.1"], ["1/3", "0.33333333333333"], ["2/3", "0.66666666666667"], ["12345678.9", "12345678.9"],
      ["0.0001", "0.0001"], ["0.00001", "1e-005"], ["-1.5e-7", "-1.5e-007"], ["5e-324", "4.9406564584125e-324"],
      ["3.0", "3"], ["6/2", "3"], ["-2.5", "-2.5"], ["5", "5"], ["-(0.0 + 0.0)", "-0"],
      ["1/0", "1.#INF"], ["-1/0", "-1.#INF"], ["0/0", "-1.#IND"],
      // L5b-review: the integer fast path's lower edge — fourteen digits stay whole, fifteen do not.
      ["-99999999999999", "-99999999999999"], ["-1e14", "-1e+014"],
    ];
    for (const [expression, expected] of cases) {
      assert.equal(value(vm, `tostring(${expression})`), expected, `tostring(${expression})`);
    }
    // Where the preamble raised: the value an add-on prints for an uptime in milliseconds.
    vm.registerGlobal("GetTime", () => [1759999999.123]);
    assert.equal(value(vm, "tostring(math.floor(GetTime() * 1000))"), "1759999999123");
  });
});

test("tostring keeps 5.1's rules: __tostring answers anything, no argument is an error", () => {
  withVm((vm) => {
    assert.equal(value(vm, 'tostring(setmetatable({}, { __tostring = function() return 42 end }))'), 42);
    assert.equal(value(vm, 'tostring(setmetatable({}, { __tostring = function() return "named" end }))'), "named");
    assert.equal(value(vm, "tostring(nil)"), "nil");
    assert.equal(value(vm, "tostring(true) .. tostring(false)"), "truefalse");
    assert.equal(value(vm, 'tostring("x")'), "x");
    assert.equal(vm.execute("SOME_TABLE = {}", "@base51").ok, true);
    assert.match(value(vm, "tostring(SOME_TABLE)"), /^table: /);
    assert.match(value(vm, "tostring(print)"), /^function: /);
    assert.equal(failure(vm, "tostring"), "bad argument #1 to 'tostring' (value expected)");
  });
});

test("format's integer conversions cast as the client's str_format does, and never raise on a number", () => {
  withVm((vm) => {
    const cases = [
      // %d/%i: toward zero; outside the int32 range, NaN and the infinities are -2147483648.
      ['"%d", 2^31', "-2147483648"], ['"%d", 1759999999123', "-2147483648"], ['"%d", -2^31', "-2147483648"],
      ['"%d", -2^31 - 0.5', "-2147483648"], ['"%d", -2^31 - 1', "-2147483648"], ['"%d", 2^31 - 0.5', "2147483647"],
      ['"%d", 3.7', "3"], ['"%d", -3.7', "-3"], ['"%+d", -4.1', "-4"], ['"%05d", -3.9', "-0003"],
      ['"%d", 1/0', "-2147483648"], ['"%d", -1/0', "-2147483648"], ['"%d", 0/0', "-2147483648"],
      ['"%d", "12"', "12"], ['"%i", "2147483648"', "-2147483648"], ['"%d items, 100%% done", 12 / 4', "3 items, 100% done"],
      // %o/%u/%x/%X: toward zero into 64 bits, the low 32 kept; 0 outside the int64 range.
      ['"%x", -1', "ffffffff"], ['"%X", -1.9', "FFFFFFFF"], ['"%x", 2^32 + 255', "ff"], ['"%x", 2^40', "0"],
      ['"%x", 2^63', "0"], ['"%x", -2^63', "0"], ['"%x", 1/0', "0"], ['"%x", 0/0', "0"], ['"%x", 2.9', "2"],
      ['"%u", -1', "4294967295"], ['"%u", 2^32 - 1', "4294967295"], ['"%o", 2^31', "20000000000"],
      ['"%.2x%.2x%.2x", 255.9, 128, "64"', "ff8040"],
      // %c: an int's low byte; a zero byte ends the item (luaL_addstring), padding before it stays.
      ['"%c", 65', "A"], ['"%c", 65.9', "A"], ['"%c", 256 + 65', "A"], ['"%c", -191', "A"], ['"%c%c", 72.4, 105', "Hi"],
      ['"[%c]", 0', "[]"], ['"[%c]", 2^31', "[]"], ['"[%c]", 256', "[]"], ['"[%3c]", 0', "[  ]"], ['"[%-3c]", 0', "[]"],
      ['"[%3c]", 65', "[  A]"], ['"[%-3c]", 66', "[B  ]"],
      // Blizzard's positional arguments go through the same casts.
      ['"%2$d %1$x", 2^32 + 1, 2^31', "-2147483648 1"], ['"%2$c%1$d", 7.9, 65', "A7"],
    ];
    for (const [args, expected] of cases) {
      assert.equal(value(vm, `format(${args})`), expected, `format(${args})`);
    }
    assert.equal(failure(vm, 'format, "%c", "x"'), "bad argument #2 to 'format' (number expected, got string)");
    assert.equal(failure(vm, 'format, "%2$c", 1, {}'), "bad argument #3 to 'format' (number expected, got table)");
    assert.match(failure(vm, 'format, "%d", "x"'), /number expected, got string/);
  });
});

test("math.fmod is C's fmod: a zero divisor answers NaN instead of raising, whole results stay whole", () => {
  withVm((vm) => {
    assert.equal(value(vm, "(function(v) return v ~= v end)(math.fmod(5, 0))"), true);
    assert.equal(value(vm, "(function(v) return v ~= v end)(mod(5, 0))"), true);
    assert.equal(value(vm, "(function(v) return v ~= v end)(math.mod(5.5, 0))"), true);
    // L5b-review: math.mod is the client's fmod too, integers included (fengari's raised «zero»).
    assert.equal(value(vm, "(function(v) return v ~= v end)(math.mod(5, 0))"), true);
    assert.equal(value(vm, "mod(-7, 3)"), -1);
    assert.equal(value(vm, '"x" .. math.fmod(7, 3)'), "x1");
    assert.equal(value(vm, "math.fmod(2^40 + 3, 7)"), 5);
    assert.equal(value(vm, "math.fmod(-2147483647 - 1, -1)"), 0);
    assert.equal(value(vm, "math.fmod(5.5, 2)"), 1.5);
    assert.equal(value(vm, "math.fmod(-5.5, 2)"), -1.5);
    assert.equal(value(vm, 'math.fmod("7", "4")'), 3);
    assert.equal(value(vm, "tostring(math.floor(2^40))"), "1099511627776");
    assert.equal(value(vm, "(2^40 + 3) % 7"), 5);
    assert.equal(failure(vm, "function() return math.fmod(5) end"), "bad argument #2 to 'fmod' (number expected, got no value)");
  });
});

test("pairs is 5.1's: the native next, the table and nil, whatever the metatable says", () => {
  withVm((vm) => {
    vm.setGlobal("__r", undefined);
    const result = vm.execute(String.raw`
      local t = { "a", "b", x = 1 }
      local f, s, c = pairs(t)
      local shape = tostring(f == next) .. tostring(s == t) .. tostring(c == nil)
      setmetatable(t, { __pairs = function() error("__pairs is 5.2's") end, __index = function() return "no" end })
      local keys = {}
      for k in pairs(t) do keys[#keys + 1] = tostring(k) end
      -- A run the table lost after an earlier walk: pairs walks it as next does (PUC's array part).
      local lost = {}
      for i = 1, 300 do lost[i] = i end
      for _ in next, lost do end
      for i = 1, 300 do lost[i] = nil end
      lost.a = 1 lost[50] = 50 lost.b = 2 lost[301] = 301 lost[3] = 3
      local viaNext, viaPairs = {}, {}
      for k in next, lost do viaNext[#viaNext + 1] = tostring(k) end
      for k in pairs(lost) do viaPairs[#viaPairs + 1] = tostring(k) end
      -- The wipe idiom with an emptiness check, through pairs.
      local w = { x = 1, y = 2, "a", "b", "c" }
      for k in pairs(w) do w[k] = nil local _ = next(w) end
      __r = table.concat({ shape, table.concat(keys, " "), table.concat(viaNext, " "), table.concat(viaPairs, " "),
        tostring(next(w)) }, "|")
    `, "@pairs");
    assert.equal(result.ok, true, result.error);
    const [shape, keys, viaNext, viaPairs, left] = String(vm.getGlobal("__r")).split("|");
    assert.equal(shape, "truetruetrue");
    assert.equal(keys, "1 2 x");
    assert.equal(viaPairs, viaNext);
    assert.equal(viaPairs, "3 50 a b 301");
    assert.equal(left, "nil");
    assert.equal(failure(vm, "pairs, nil"), "bad argument #1 to 'pairs' (table expected, got nil)");
    assert.equal(failure(vm, "pairs"), "bad argument #1 to 'pairs' (table expected, got no value)");
  });
});

test("ipairs is 5.1's: raw reads from 1 to the first nil, __index never asked", () => {
  withVm((vm) => {
    vm.setGlobal("__r", undefined);
    const result = vm.execute(String.raw`
      local function walk(t)
        local out = {}
        for i, v in ipairs(t) do
          out[#out + 1] = i .. "=" .. tostring(v)
          if #out > 10 then out[#out + 1] = "runaway" break end
        end
        return table.concat(out, ",")
      end
      local proxy = setmetatable({}, { __index = { "a", "b" } })
      local endless = setmetatable({ "x" }, { __index = function(_, k) return "y" .. k end })
      local f, s, c = ipairs(proxy)
      __r = table.concat({ walk(proxy), walk(endless), walk({ 1, 2, nil, 4 }),
        tostring(s == proxy) .. tostring(c), tostring(select("#", f({}, 0))) }, "|")
    `, "@ipairs");
    assert.equal(result.ok, true, result.error);
    assert.equal(vm.getGlobal("__r"), "|1=x|1=1,2=2|true0|0");
    assert.equal(failure(vm, "ipairs, nil"), "bad argument #1 to 'ipairs' (table expected, got nil)");
  });
});
