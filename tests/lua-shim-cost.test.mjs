import assert from "node:assert/strict";
import test from "node:test";
import { GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";

// The 5.1 `format` and `pairs` shims sat under every stock combat-log line (measured 02.10 on the
// vertical with Blizzard_CombatLog: 60 % of a COMBAT_LOG_EVENT's Lua time was the `format` shim
// re-scanning its format string, 7 % the `pairs` shim). Both were fengari's alone and went with it in
// ARC-4 A6 (12.10), with their instruction-budget tests: `format` is the client's str_format as a host
// function (tests/glue-lua-format.test.mjs), `pairs` is PUC 5.1's own. What stays is the order the
// corpus depends on.

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
