import assert from "node:assert/strict";
import test from "node:test";

const {
  compileFrameXmlWorldMouseoverScripts,
  createFrameXmlWorldMouseover,
  FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS,
  FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldMouseover.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

function recorder(hover) {
  const calls = [];
  const mouseover = createFrameXmlWorldMouseover({
    hovered: () => hover.value,
    enter: () => calls.push(`enter:${hover.value}`),
    leave: () => calls.push("leave"),
    expire: () => calls.push("expire"),
  });
  return { calls, mouseover };
}

test("a world unit enters at once and leaves only after the hover stays clear", () => {
  const hover = { value: undefined };
  const { calls, mouseover } = recorder(hover);
  mouseover.tick(0);
  assert.deepEqual(calls, [], "no hover, no tooltip");
  hover.value = 7n;
  mouseover.tick(16);
  assert.deepEqual(calls, ["enter:7"], "the first committed pick shows the stock tooltip");
  // Controls.ts clears the pick for ~16 ms around every throttled pointermove.
  hover.value = undefined;
  mouseover.tick(33);
  hover.value = 7n;
  mouseover.tick(50);
  assert.deepEqual(calls, ["enter:7"], "a throttle gap neither fades nor re-runs SetUnit");
  hover.value = 9n;
  mouseover.tick(66);
  assert.deepEqual(calls, ["enter:7", "enter:9"], "a different unit re-runs SetUnit");
  hover.value = undefined;
  mouseover.tick(100);
  mouseover.tick(100 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS - 1);
  assert.deepEqual(calls, ["enter:7", "enter:9"], "leave waits for the settle delay");
  mouseover.tick(100 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS);
  assert.deepEqual(calls, ["enter:7", "enter:9", "leave"], "a settled clear fades the tooltip");
  mouseover.tick(200 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS + FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS);
  assert.deepEqual(calls, ["enter:7", "enter:9", "leave", "expire"],
    "a tooltip that outlived its fade is hidden once");
  mouseover.tick(10_000);
  assert.equal(calls.length, 4, "nothing repeats while nothing is hovered");
});

test("re-entering before the fade expires cancels the expiry", () => {
  const hover = { value: 3n };
  const { calls, mouseover } = recorder(hover);
  mouseover.tick(0);
  hover.value = undefined;
  mouseover.tick(10);
  mouseover.tick(10 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS);
  hover.value = 3n;
  mouseover.tick(200);
  // Still hovering long past the first fade's expiry time.
  mouseover.tick(100 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS + FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS);
  assert.deepEqual(calls, ["enter:3", "leave", "enter:3"],
    "the first fade's expiry never hides the tooltip of the unit hovered again");
});

/** A Lua GameTooltip double that records the engine calls the stock client makes. */
function tooltipVm({ mouseoverExists = true, fadeOut = true } = {}) {
  const vm = new GlueLuaVm();
  const setup = vm.execute(`
    __calls = {}
    local function note(text) __calls[#__calls + 1] = text end
    UIParent = { name = "UIParent" }
    OtherButton = { name = "OtherButton" }
    GameTooltip = { shown = false, owner = nil }
    function GameTooltip:IsShown() return self.shown end
    function GameTooltip:IsOwned(frame) return self.owner == frame end
    function GameTooltip:SetUnit(unit) note("SetUnit:" .. unit); self.shown = true end
    function GameTooltip:Hide() note("Hide"); self.shown = false; self.owner = nil end
    ${fadeOut ? 'function GameTooltip:FadeOut() note("FadeOut"); self.shown = false; self.owner = nil end' : ""}
    function GameTooltip_SetDefaultAnchor(tooltip, parent) note("SetDefaultAnchor:" .. parent.name); tooltip.owner = parent end
    function UnitExists(unit) return unit == "mouseover" and ${mouseoverExists ? "1" : "nil"} or nil end
  `, "@world-mouseover:test");
  assert.equal(setup.ok, true, setup.error);
  const calls = () => {
    vm.execute("__joined = table.concat(__calls, ',')", "@t");
    return vm.getGlobal("__joined");
  };
  return { vm, calls };
}

test("the Lua bodies make the stock engine calls and fade only the world tooltip", () => {
  const { vm, calls } = tooltipVm();
  try {
    const scripts = compileFrameXmlWorldMouseoverScripts(vm);
    scripts.enter();
    assert.equal(calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover");
    scripts.leave();
    assert.equal(calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover,FadeOut");
    // A frame's own OnEnter re-owned the tooltip: the world leave must not touch it.
    vm.execute('GameTooltip.shown = true; GameTooltip.owner = OtherButton', "@t");
    scripts.leave();
    scripts.expire();
    assert.equal(calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover,FadeOut",
      "a tooltip owned by another frame is left alone");
  } finally {
    vm.close();
  }
});

test("the Lua bodies degrade without the mouseover token or a real FadeOut", () => {
  const missing = tooltipVm({ mouseoverExists: false });
  try {
    compileFrameXmlWorldMouseoverScripts(missing.vm).enter();
    assert.equal(missing.calls(), "", "no mouseover unit yet: no tooltip");
  } finally {
    missing.vm.close();
  }
  const noFade = tooltipVm({ fadeOut: false });
  try {
    const scripts = compileFrameXmlWorldMouseoverScripts(noFade.vm);
    scripts.enter();
    scripts.leave();
    assert.equal(noFade.calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover,Hide",
      "without FadeOut the world tooltip is hidden");
  } finally {
    noFade.vm.close();
  }
  const bare = new GlueLuaVm();
  try {
    const scripts = compileFrameXmlWorldMouseoverScripts(bare);
    scripts.enter();
    scripts.leave();
    scripts.expire();
    assert.equal(bare.errors?.length ?? 0, 0, "a VM without GameTooltip raises nothing");
  } finally {
    bare.close();
  }
});
