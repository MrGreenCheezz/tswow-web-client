import assert from "node:assert/strict";
import test from "node:test";
import { lua } from "fengari";

// P1-14a: decoding a widget's `self` reads the frame from its Lua table's identity
// (`lua_topointer` → WeakMap), not from a `__glueFrameId` string key pushed and hashed per call.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");

function setup() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"), args[1] === undefined ? undefined : String(args[1]), args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  return { vm, bridge, binder };
}

test("fengari's lua_topointer is the same object for one table and a different one for another", () => {
  const vm = new GlueLuaVm();
  try {
    const L = vm.state;
    lua.lua_newtable(L);
    lua.lua_pushvalue(L, -1);
    lua.lua_newtable(L);
    const [first, again, other] = [lua.lua_topointer(L, -3), lua.lua_topointer(L, -2), lua.lua_topointer(L, -1)];
    assert.equal(typeof first, "object");
    assert.equal(first, again, "the same table, the same object");
    assert.notEqual(first, other, "another table, another object");
    lua.lua_settop(L, 0);
  } finally { vm.close(); }
});

test("a hundred method calls on a widget push no string to decode self", () => {
  const { vm, binder } = setup();
  try {
    assert.equal(vm.execute('DecodeProbe = CreateFrame("Frame", "DecodeProbe")', "@decode-setup").ok, true);
    const loop = vm.compileFunction("local f = DecodeProbe local n for i = 1, 100 do n = f:GetName() end return n", "decode-loop", []);
    const original = lua.lua_pushstring;
    let pushed = 0;
    lua.lua_pushstring = (state, value) => { pushed += 1; return original(state, value); };
    let answer;
    try { answer = vm.call(loop, [], 1); } finally { lua.lua_pushstring = original; }
    assert.deepEqual(answer, ["DecodeProbe"]);
    assert.equal(pushed, 0, "GetName answers through pushValue, and self is decoded without lua_pushstring");
    assert.equal(binder.frameDecodeFallbacks, 0);
    vm.release(loop);
  } finally { vm.close(); }
});

test("a foreign table is not a frame; a copy carrying __glueFrameId still resolves through the id", () => {
  const { vm, bridge, binder } = setup();
  const seen = [];
  vm.registerGlobal("Probe", (args) => { seen.push(args[0]); return []; });
  try {
    const result = vm.execute(`
      local frame = CreateFrame("Frame", "CopyProbe")
      Probe({ answer = 42 })
      local copy = {}
      for key, value in pairs(frame) do copy[key] = value end
      Probe(copy)
      Probe(frame)
    `, "@decode-copy");
    assert.equal(result.ok, true, result.error);
    const frame = bridge.getFrame("CopyProbe");
    assert.ok(frame);
    assert.notEqual(seen[0], frame, "a plain table stays a reference");
    assert.equal(typeof seen[0], "object");
    assert.equal(seen[1], frame, "a copy with the id field resolves the way it always has");
    assert.equal(seen[2], frame);
    assert.equal(binder.frameDecodeFallbacks, 1, "only the copy took the fallback");
  } finally { vm.close(); }
});
