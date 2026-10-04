import assert from "node:assert/strict";
import test from "node:test";
import { lua } from "fengari";

// Plan item 3.27 (03.10, L5): `next` and `strsplit` as the host C functions of GlueLuaNatives.ts.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

function run(vm, source) {
  const result = vm.execute(source, "@natives-probe");
  assert.equal(result.ok, true, result.error);
}

/** A Lua chunk's `return` values, as strings joined with "|". */
function values(vm, source) {
  const fn = vm.compileFunction(source, "natives-values", []);
  assert.ok(fn, "compiles");
  try {
    return vm.call(fn, [], lua.LUA_MULTRET).map((value) => (value === undefined ? "nil" : String(value))).join("|");
  } finally {
    vm.release(fn);
  }
}

test("strsplit cuts at every byte of the delimiter set, as Wow.exe 0x00816a60 does", () => {
  const vm = new GlueLuaVm();
  try {
    // A set, not a substring.
    assert.equal(values(vm, 'return strsplit(",;", "a,b;c")'), "a|b|c");
    // …and only this call's set: the last call's delimiters are not left behind.
    assert.equal(values(vm, 'return strsplit(":", "a,b;c:d")'), "a,b;c|d");
    assert.equal(values(vm, 'return strsplit(" ", "a  b")'), "a||b");
    assert.equal(values(vm, 'return strsplit(":", "item:1:2")'), "item|1|2");
    // `pieces` stops after pieces − 1 cuts and leaves the rest whole.
    assert.equal(values(vm, 'return strsplit(",", "a,b,c", 2)'), "a|b,c");
    assert.equal(values(vm, 'return strsplit(",;", "a;b,c;d", 3)'), "a|b|c;d");
    // 0 is no limit; 1 and a negative count give the text back uncut.
    assert.equal(values(vm, 'return strsplit(",", "a,b,c", 0)'), "a|b|c");
    assert.equal(values(vm, 'return strsplit(",", "a,b,c", 1)'), "a,b,c");
    assert.equal(values(vm, 'return strsplit(",", "a,b,c", -2)'), "a,b,c");
    // A fractional count is rounded as the client's lua_tointeger rounds (FISTP: nearest, ties to even).
    assert.equal(values(vm, 'return strsplit(",", "a,b,c,d", 2.7)'), "a|b|c,d");
    assert.equal(values(vm, 'return strsplit(",", "a,b,c,d", 2.5)'), "a|b,c,d");
    assert.equal(values(vm, 'return strsplit(",", "a,b,c,d", 3.5)'), "a|b|c|d");
    // No delimiter, empty text, delimiters at both ends.
    assert.equal(values(vm, 'return strsplit("", "abc")'), "abc");
    assert.equal(values(vm, 'return select("#", strsplit(",", ""))'), "1");
    assert.equal(values(vm, 'return strsplit(",", ",a,")'), "|a|");
    // Magic characters of Lua patterns are plain bytes here.
    assert.equal(values(vm, 'return strsplit("%.", "a.b%c")'), "a|b|c");
    assert.equal(values(vm, 'return strsplit("]^-", "a]b^c-d")'), "a|b|c|d");
    // C strings: both stop at their first NUL byte.
    assert.equal(values(vm, 'return strsplit(",", "a,b\\0,c")'), "a|b");
    assert.equal(values(vm, 'return strsplit("\\0,", "a,b")'), "a,b");
    // Numbers are strings, spelt as 5.1 spelt them.
    assert.equal(values(vm, 'return strsplit(".", 12.5)'), "12|5");
    assert.equal(values(vm, 'return strsplit("0", 6 / 2 * 100)'), "3||");
    // Compat's `string.split` is the same function: the receiver is the delimiter set.
    assert.equal(values(vm, 'return (",;"):split("x,y;z")'), "x|y|z");
    // Arguments are checked the way luaL_checklstring checks them.
    const failed = vm.execute('strsplit(",", nil)', "@natives-bad-arg");
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /bad argument #2/);
  } finally {
    vm.close();
  }
});

test("next walks the array run first, ascending, then the rest — without measuring the run every step", () => {
  const vm = new GlueLuaVm();
  try {
    run(vm, `
      local t = { loaded = false, blend = 1, "a", "b", "c" }
      local order = {}
      for key, value in next, t do order[#order + 1] = tostring(key) .. "=" .. tostring(value) end
      __order = table.concat(order, ",")
      __first = table.concat({ tostring(next(t)), tostring(select(2, next(t))) }, "=")
      __empty = next({}) == nil
      __hashOnly = select("#", next({ x = 1 }))
      local holes = { [1] = "a", [3] = "c", y = 2 }
      local seen = {}
      for key in next, holes do seen[#seen + 1] = tostring(key) end
      table.sort(seen)
      __holes = table.concat(seen, ",")
    `);
    const order = String(vm.getGlobal("__order")).split(",");
    assert.deepEqual(order.slice(0, 3), ["1=a", "2=b", "3=c"], order.join(","));
    assert.deepEqual(order.slice(3).sort(), ["blend=1", "loaded=false"]);
    assert.equal(vm.getGlobal("__first"), "1=a");
    assert.equal(vm.getGlobal("__empty"), true);
    assert.equal(vm.getGlobal("__hashOnly"), 2);
    assert.equal(vm.getGlobal("__holes"), "1,3,y");

    // The preamble's `next` called the global `rawget` ≈ n²/2 times for a walk; this one never does.
    run(vm, `
      local count, raw = 0, rawget
      rawget = function(...) count = count + 1 return raw(...) end
      local list = {}
      for i = 1, 3000 do list[i] = i end
      list.name = "x"
      local steps = 0
      for key in next, list do steps = steps + 1 end
      rawget = raw
      __steps, __rawgets = steps, count
    `);
    assert.equal(vm.getGlobal("__steps"), 3001);
    assert.ok(vm.getGlobal("__rawgets") < 20 * 3001, `rawget calls: ${vm.getGlobal("__rawgets")}`);
    // …and the host side measures the run once per walk, not once per step.
    const rawgeti = lua.lua_rawgeti;
    let reads = 0;
    lua.lua_rawgeti = (...args) => { reads += 1; return rawgeti(...args); };
    try {
      run(vm, "local list = {} for i = 1, 3000 do list[i] = i end local steps = 0 for key in next, list do steps = steps + 1 end __steps = steps");
    } finally {
      lua.lua_rawgeti = rawgeti;
    }
    assert.equal(vm.getGlobal("__steps"), 3000);
    assert.ok(reads < 10 * 3000, `array reads for one walk: ${reads}`);

    // securecall(next, …) — OptionsFrameTemplates.lua's SecureNext — and errors on a non-table.
    run(vm, `
      local function SecureNext(elements, key) return securecall(next, elements, key) end
      local seen = {}
      for index, value in SecureNext, { "a", "b" } do seen[#seen + 1] = index .. "=" .. value end
      __secure = table.concat(seen, ",")
      __bad = select(2, pcall(next, nil))
    `);
    assert.equal(vm.getGlobal("__secure"), "1=a,2=b");
    assert.match(String(vm.getGlobal("__bad")), /bad argument #1 to 'next' \(table expected/);
  } finally {
    vm.close();
  }
});

test("next agrees with pairs on a table cleared while it is walked", () => {
  const vm = new GlueLuaVm();
  try {
    run(vm, `
      local function walk(iterate)
        local t = { "a", "b", "c", "d", x = 1, y = 2 }
        local seen = {}
        for key in iterate(t) do
          seen[#seen + 1] = tostring(key)
          t[key] = nil
          if key == 2 then t[3] = nil end
        end
        table.sort(seen)
        return table.concat(seen, ",")
      end
      __pairs = walk(pairs)
      __next = walk(function(t) return next, t, nil end)
    `);
    // `wipe`'s idiom plus an entry of the run cleared ahead of the walk: it is not handed out.
    assert.equal(vm.getGlobal("__next"), vm.getGlobal("__pairs"));
    assert.equal(vm.getGlobal("__next"), "1,2,4,x,y");
  } finally {
    vm.close();
  }
});
