import assert from "node:assert/strict";
import test from "node:test";

// P1-14d: the per-dispatch and per-method allocations of the bridge: a method binding gets self
// apart from the rest (no args.slice(1)), a handler's leading fn/self/isEvent go through callWith
// (no [ref, self, isEvent, ...args] per dispatch), and an unhooked script shares one frozen list.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlUiBridge, NO_HOOKS } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");

function setup() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"), args[1] === undefined ? undefined : String(args[1]), args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  return { vm, bridge };
}

test("a hundred widget method calls slice no argument list", () => {
  const { vm } = setup();
  try {
    assert.equal(vm.execute('SliceProbe = CreateFrame("Frame", "SliceProbe")', "@slice-setup").ok, true);
    const loop = vm.compileFunction("local f = SliceProbe for i = 1, 100 do f:SetAlpha(0.5) f:GetName() end return f:GetAlpha()", "slice-loop", []);
    const original = Array.prototype.slice;
    let slices = 0;
    Array.prototype.slice = function (...rest) { slices += 1; return original.apply(this, rest); };
    let answer;
    try { answer = vm.call(loop, [], 1); } finally { Array.prototype.slice = original; }
    assert.deepEqual(answer, [0.5]);
    assert.equal(slices, 0);
    vm.release(loop);
  } finally { vm.close(); }
});

test("callWith pushes the lead, then the arguments, as call does with them joined", () => {
  const vm = new GlueLuaVm();
  try {
    const fn = vm.compileFunction("return select('#', ...), ...", "lead-probe", []);
    const joined = vm.call(fn, ["a", undefined, 3, "x", undefined], -1);
    const split = vm.callWith(fn, ["a", undefined, 3], ["x", undefined], -1);
    assert.deepEqual(split, joined);
    assert.deepEqual(split, [5, "a", undefined, 3, "x", undefined]);
    vm.release(fn);
  } finally { vm.close(); }
});

test("an unhooked script shares one frozen hook list; handlers still get self and their arguments in order", () => {
  assert.ok(Object.isFrozen(NO_HOOKS));
  assert.equal(NO_HOOKS.length, 0);
  const { vm, bridge } = setup();
  try {
    const result = vm.execute(`
      DispatchSeen = {}
      local outer = CreateFrame("Frame", "DispatchOuter")
      local inner = CreateFrame("Frame", "DispatchInner")
      outer:RegisterEvent("PROBE_EVENT")
      inner:RegisterEvent("PROBE_EVENT")
      local function record(self, event, a, b)
        DispatchSeen[#DispatchSeen + 1] = self:GetName() .. ":" .. event .. ":" .. tostring(a) .. ":" .. tostring(b)
      end
      outer:SetScript("OnEvent", record)
      inner:SetScript("OnEvent", record)
      outer:SetScript("OnShow", function(self) inner:Hide() inner:Show() DispatchSeen[#DispatchSeen + 1] = "show:" .. self:GetName() end)
      inner:SetScript("OnShow", function(self) DispatchSeen[#DispatchSeen + 1] = "show:" .. self:GetName() end)
    `, "@dispatch-order");
    assert.equal(result.ok, true, result.error);
    bridge.dispatchEvent("PROBE_EVENT", 7, "b");
    const outer = bridge.getFrame("DispatchOuter");
    bridge.Hide(outer);
    bridge.Show(outer);
    const seen = vm.compileFunction("return table.concat(DispatchSeen, ',')", "seen", []);
    assert.equal(vm.call(seen, [], 1)[0],
      "DispatchOuter:PROBE_EVENT:7:b,DispatchInner:PROBE_EVENT:7:b,show:DispatchInner,show:DispatchOuter",
      "a nested dispatch inside a handler leaves the outer self in place");
    vm.release(seen);
  } finally { vm.close(); }
});
