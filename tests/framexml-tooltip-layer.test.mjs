import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.24 (L5c, 04.10): a stock hover tooltip over the native windows. The overlay is lifted
// (GameWindows' own raise) while GameTooltip is shown and goes back to its order when it hides —
// unless a click on a stock control during the hover, or another raise, changed the order meanwhile.
const { createFrameXmlTooltipLift, watchFrameXmlTooltipLayer } = await import("../dist/code/browser/framexml/FrameXmlTooltipLayer.js");

function stage(initial = "") {
  let top = 40;
  const host = { style: { zIndex: initial } };
  const raise = () => { if (Number.parseInt(host.style.zIndex, 10) === top) return; top += 1; host.style.zIndex = String(top); };
  return { host, raise, nativeRaise: () => { top += 1; return top; } };
}

test("shown: the overlay over the native windows; hidden: back to where it was", () => {
  const { host, raise } = stage("");
  const lift = createFrameXmlTooltipLift(host, raise);
  lift.show();
  assert.equal(host.style.zIndex, "41");
  assert.equal(lift.lifted, true);
  lift.show();
  assert.equal(host.style.zIndex, "41", "a second show while up changes nothing");
  lift.hide();
  assert.equal(host.style.zIndex, "", "the stylesheet's order again");
  assert.equal(lift.lifted, false);
  lift.hide();
  assert.equal(host.style.zIndex, "");
});

test("a click on a stock control during the hover keeps the lift; another raise keeps its own order", () => {
  const { host, raise } = stage("");
  const lift = createFrameXmlTooltipLift(host, raise);
  lift.show();
  lift.pointerDown();
  lift.hide();
  assert.equal(host.style.zIndex, "41", "kept, as the click alone would have lifted it");
  lift.show();
  host.style.zIndex = "77";
  lift.hide();
  assert.equal(host.style.zIndex, "77", "a dialog or a click raised it meanwhile: left alone");
  lift.pointerDown();
  lift.show();
  lift.hide();
  assert.equal(host.style.zIndex, "77", "a click before the hover is not a keep for the next one");
});

test("GameTooltip's show and hide drive it through host hooks; the cleanup lowers and stops", () => {
  const { host, raise } = stage("");
  const hooks = new Map();
  let visible = false;
  const tooltip = { name: "GameTooltip" };
  const bridge = {
    getFrame: (name) => (name === "GameTooltip" ? tooltip : undefined),
    isVisible: () => visible,
    HookScript: (frame, script, fn) => { assert.equal(frame.name, "GameTooltip"); hooks.set(script, fn); return true; },
  };
  const lift = createFrameXmlTooltipLift(host, raise);
  const stop = watchFrameXmlTooltipLayer({ bridge }, lift);
  assert.deepEqual([...hooks.keys()].sort(), ["OnHide", "OnShow"]);
  hooks.get("OnShow")(tooltip);
  assert.equal(host.style.zIndex, "41");
  hooks.get("OnHide")(tooltip);
  assert.equal(host.style.zIndex, "");
  hooks.get("OnShow")(tooltip);
  stop();
  assert.equal(host.style.zIndex, "", "the cleanup takes the lift back");
  hooks.get("OnShow")(tooltip);
  assert.equal(host.style.zIndex, "", "stopped: no more lifts");
  // A tooltip already up when the watch starts is lifted at once; no GameTooltip, nothing to hook.
  visible = true;
  const again = createFrameXmlTooltipLift(host, raise);
  watchFrameXmlTooltipLayer({ bridge }, again);
  assert.equal(again.lifted, true);
  assert.doesNotThrow(() => watchFrameXmlTooltipLayer({ bridge: { getFrame: () => undefined } }, again)());
});

test("hovers reuse their level while no native window rose: the shared counter does not creep", () => {
  let top = 40;
  const host = { style: { zIndex: "" } };
  let raises = 0;
  const raise = () => { raises += 1; top += 1; host.style.zIndex = String(top); };
  const lift = createFrameXmlTooltipLift(host, raise, () => top);
  for (let hover = 0; hover < 5; hover += 1) { lift.show(); lift.hide(); }
  assert.equal(raises, 1, "one raise for five hovers");
  assert.equal(top, 41);
  top += 1; // a native window shown over the overlay (GameWindows raised it to 42)
  lift.show();
  assert.equal(host.style.zIndex, "43", "over that window again");
  assert.equal(raises, 2);
  lift.hide();
});

test("GameTooltip feeding a native window's own tooltip lifts nothing", () => {
  const { host, raise } = stage("");
  const hooks = new Map();
  const tooltip = { name: "GameTooltip" };
  const bridge = {
    getFrame: () => tooltip, isVisible: () => false,
    HookScript: (_frame, script, fn) => { hooks.set(script, fn); return true; },
  };
  let native = true;
  watchFrameXmlTooltipLayer({ bridge }, createFrameXmlTooltipLift(host, raise), () => native);
  hooks.get("OnShow")(tooltip);
  assert.equal(host.style.zIndex, "", "a native bag slot's hover: the overlay stays under its window");
  hooks.get("OnHide")(tooltip);
  native = false;
  hooks.get("OnShow")(tooltip);
  assert.equal(host.style.zIndex, "41");
});
