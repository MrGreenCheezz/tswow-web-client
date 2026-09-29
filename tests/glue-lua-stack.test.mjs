import assert from "node:assert/strict";
import test from "node:test";
import { GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";
import { lua } from "fengari";

// A host call starts with LUA_MINSTACK (20) free slots. A 3.3.5 COMBAT_LOG_EVENT_UNFILTERED carries
// the event name and nineteen payload values, and `__glueInvoke` adds fn/self/isEvent in front.
test("a host call with more arguments than LUA_MINSTACK reaches Lua instead of throwing", () => {
  const args = Array.from({ length: 25 }, (_, index) => index + 1);
  // Each path on a fresh state: a successful grow on one would leave room for the other.
  const errors = [];
  const vm = new GlueLuaVm({ onError: (message) => errors.push(message) });
  const count = vm.compileFunction("return select('#', ...), (select(25, ...))", "@many-args", []);
  try {
    const top = lua.lua_gettop(vm.state);
    assert.deepEqual(vm.call(count, args, 2), [25, 25]);
    assert.equal(lua.lua_gettop(vm.state), top, "the caller's stack is left as it was");
    assert.deepEqual(errors, []);
  } finally { vm.release(count); vm.close(); }
  const chunkVm = new GlueLuaVm();
  try {
    const result = chunkVm.execute("ManyArgs = select('#', ...)", "@many-args-chunk", args);
    assert.equal(result.ok, true, result.error);
    assert.equal(chunkVm.getGlobal("ManyArgs"), 25);
  } finally { chunkVm.close(); }
});

test("collectgarbage answers every 5.1 option without raising, and still rejects an unknown one", () => {
  const vm = new GlueLuaVm();
  try {
    const run = (source) => {
      const result = vm.execute(`Out = { pcall(function() ${source} end) }`, "@gc");
      assert.equal(result.ok, true, result.error);
      const out = vm.execute("OutOk, OutValue = Out[1], Out[2]", "@gc-read");
      assert.equal(out.ok, true);
      return [vm.getGlobal("OutOk"), vm.getGlobal("OutValue")];
    };
    // MSBTProfiles.lua:2097, measured raising «lua_gc not implemented» at boot.
    assert.deepEqual(run(`return collectgarbage("collect")`), [true, 0]);
    assert.deepEqual(run(`return collectgarbage()`), [true, 0]);
    assert.deepEqual(run(`return type(collectgarbage("count"))`), [true, "number"]);
    assert.deepEqual(run(`return collectgarbage("step")`), [true, true]);
    assert.deepEqual(run(`return type(gcinfo())`), [true, "number"]);
    const [ok, message] = run(`return collectgarbage("nonsense")`);
    assert.equal(ok, false);
    assert.match(String(message), /invalid option 'nonsense'/);
  } finally { vm.close(); }
});
