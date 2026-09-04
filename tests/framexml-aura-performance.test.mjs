import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");

function makeAuraStrip(bridge, prefix, count, onUpdate) {
  const root = bridge.CreateFrame("Frame", `${prefix}Frame`);
  assert.ok(root);
  const buttons = [];
  for (let index = 1; index <= count; index += 1) {
    const button = bridge.CreateFrame("Button", `${prefix}AuraButton${index}`, root);
    assert.ok(button);
    const duration = bridge.createChild(button, "FontString", `${prefix}Duration${index}`);
    const applications = bridge.createChild(button, "FontString", `${prefix}Applications${index}`);
    assert.ok(duration);
    assert.ok(applications);
    bridge.SetScript(button, "OnUpdate", (self, elapsed) => onUpdate({
      index,
      self,
      elapsed,
      duration,
      applications,
    }));
    buttons.push({ button, duration, applications });
  }
  return { root, buttons };
}

test("one bridge tick batches all 48 visible aura-button updates into one renderer sync", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  let updates = 0;
  const strip = makeAuraStrip(bridge, "Visible", 48, ({ index, elapsed, duration, applications }) => {
    updates += 1;
    bridge.SetText(duration, `${(index * 0.1 + elapsed).toFixed(3)}s`);
    bridge.SetText(applications, String((index % 5) + 1));
    bridge.update(duration, (frame) => {
      frame.alpha = 0.5 + ((index + updates) % 2) * 0.5;
    });
  });

  let rendererSyncs = 0;
  bridge.subscribe(() => { rendererSyncs += 1; });

  assert.equal(bridge.tick(0.016), 48);
  assert.equal(updates, 48, "every visible AuraButton OnUpdate must run");
  assert.equal(rendererSyncs, 1, "all aura mutations must flush through one outer batch");
  assert.equal(strip.buttons[0].duration.text, "0.116s");
  assert.equal(strip.buttons[47].applications.text, "4");
  assert.equal(strip.buttons[0].duration.alpha, 0.5);
});

test("hidden aura subtrees do not dispatch OnUpdate or produce renderer work", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  let visibleUpdates = 0;
  let hiddenUpdates = 0;
  makeAuraStrip(bridge, "VisibleIdle", 48, () => { visibleUpdates += 1; });
  const hidden = makeAuraStrip(bridge, "HiddenIdle", 48, ({ index, duration }) => {
    hiddenUpdates += 1;
    // This mutation is intentional: a broken visibility guard would now also cause a renderer
    // notification, rather than merely incrementing an otherwise invisible counter.
    bridge.SetText(duration, `hidden-${index}`);
    bridge.update(duration, (frame) => { frame.alpha = 0; });
  });
  assert.equal(bridge.Hide(hidden.root), true);

  let rendererSyncs = 0;
  bridge.subscribe(() => { rendererSyncs += 1; });

  assert.equal(bridge.tick(0.016), 48);
  assert.equal(visibleUpdates, 48);
  assert.equal(hiddenUpdates, 0, "hidden AuraButton descendants must not run OnUpdate");
  assert.equal(rendererSyncs, 0, "handlers without mutations must not trigger a render sync");

  // Once the visible strip is hidden too, the update index still contains all 96 handlers, but
  // effective visibility prevents any of them from doing work.
  const visibleRoot = bridge.getFrame("VisibleIdleFrame");
  assert.ok(visibleRoot);
  assert.equal(bridge.Hide(visibleRoot), true);
  visibleUpdates = 0;
  hiddenUpdates = 0;
  rendererSyncs = 0;
  assert.equal(bridge.tick(0.016), 0);
  assert.equal(visibleUpdates, 0);
  assert.equal(hiddenUpdates, 0);
  assert.equal(rendererSyncs, 0);
});
