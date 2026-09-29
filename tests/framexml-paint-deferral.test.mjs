import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");

// setPaintDeferral: paint-only changes made between two frame steps wait for the step's
// flushDeferredPaint; anything that can move or show a frame is announced at once, and carries the
// held paint with it.

function bridgeWithFrame() {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Frame", "DeferredFrame");
  assert.ok(frame);
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  return { bridge, frame, get notifications() { return notifications; } };
}

test("N paint changes between two steps are one notification, at the step", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  bridge.setPaintDeferral(true);
  for (let i = 0; i < 10; i++) {
    // As a packet event would: each its own batch, outside the step.
    bridge.runInMutationBatch(() => bridge.update(frame, (m) => { m.alpha = i / 10; }, "paint"));
    bridge.update(frame, (m) => { m.animationAlpha = i / 20; }, "paint");
  }
  assert.equal(fixture.notifications, 0, "held for the frame step");
  assert.equal(bridge.paintDeferred, true);
  bridge.flushDeferredPaint();
  assert.equal(fixture.notifications, 1, "one reconciliation for all of them");
  assert.equal(bridge.paintDeferred, false);
  bridge.flushDeferredPaint();
  assert.equal(fixture.notifications, 1, "nothing held, nothing announced");
});

test("a layout change is announced at once and takes the held paint with it", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  bridge.setPaintDeferral(true);
  bridge.update(frame, (m) => { m.alpha = 0.5; }, "paint");
  assert.equal(fixture.notifications, 0);
  bridge.SetText(frame, "moves");
  assert.equal(fixture.notifications, 1);
  assert.equal(bridge.paintDeferred, false, "the held paint went with it");
  // A batch that shows a frame is not held either, even when it also paints.
  bridge.runInMutationBatch(() => {
    bridge.update(frame, (m) => { m.alpha = 0.25; }, "paint");
    bridge.Hide(frame);
  });
  assert.equal(fixture.notifications, 2);
});

test("without deferral every change is announced when its batch ends, as before", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  bridge.update(frame, (m) => { m.alpha = 0.5; }, "paint");
  assert.equal(fixture.notifications, 1);
  bridge.setPaintDeferral(true);
  bridge.update(frame, (m) => { m.alpha = 0.4; }, "paint");
  assert.equal(fixture.notifications, 1);
  bridge.setPaintDeferral(false);
  assert.equal(fixture.notifications, 2, "turning it off announces what was held");
});

test("a host reading the page through elementFor sees the held paint applied", async () => {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": `<Ui><Frame name="Root" width="100" height="100"><Layers><Layer level="ARTWORK">
      <Texture name="Art"><Size x="10" y="10"/></Texture></Layer></Layers></Frame></Ui>`,
  }) });
  await boot.load();
  const doc = { createElement: (tag) => make(tag), createElementNS: (_, tag) => make(tag) };
  function make(tag) {
    const attrs = new Map();
    const node = { ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      dataset: {}, className: "", hidden: false, textContent: "",
      classList: { add() {} }, addEventListener() {},
      setAttribute(name, value) { attrs.set(name, String(value)); }, getAttribute(name) { return attrs.get(name) ?? null; },
      removeAttribute(name) { attrs.delete(name); },
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      remove() { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node); },
    };
    return node;
  }
  doc.head = make("head");
  const renderer = new FrameXmlDomRenderer(doc.createElement("section"), { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    const art = boot.bridge.getFrame("Art");
    const element = renderer.elementFor(art);
    boot.bridge.setPaintDeferral(true);
    assert.equal(boot.vm.execute("Art:SetAlpha(0.5)", "@defer").ok, true);
    assert.equal(element.style.opacity ?? "", "", "held until the frame step");
    assert.equal(renderer.elementFor(art).style.opacity, "0.5", "a host read gets the page current");
  } finally { renderer.destroy(); boot.close(); }
});
