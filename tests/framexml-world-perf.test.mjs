import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlWorldPerf } from "../dist/code/browser/framexml/FrameXmlWorldPerf.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_, tag) => make(tag) };
  function make(tag) {
    const attrs = new Map();
    const node = { ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      dataset: {}, className: "", hidden: false, textContent: "",
      classList: { add(...names) { node.className += names.join(" "); } }, addEventListener() {},
      setAttribute(name, value) { attrs.set(name, String(value)); }, getAttribute(name) { return attrs.get(name) ?? null; },
      removeAttribute(name) { attrs.delete(name); },
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      remove() { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node); },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

test("frame counters split the step into seam, OnUpdate and its pass, and passes outside it", () => {
  let now = 0;
  const perf = new FrameXmlWorldPerf(() => now);
  // Frame 1: a step with a paint pass inside it, then a packet's layout pass before the next step.
  perf.stepBegin();
  perf.stepPieces(0.5, 1.25, 30);
  now += 0.5;
  perf.sync("paint", 0.75);
  now += 2;
  perf.stepEnd();
  now += 5;
  perf.sync("layout", 3);
  perf.sync("noop", 0);
  perf.touch();
  perf.picture(0.25);
  now += 9;
  // Frame 2 closes frame 1 (interval 16.5 ms).
  perf.stepBegin();
  perf.stepPieces(0.25, 1, 28);
  now += 1;
  perf.stepEnd();
  now += 15;
  perf.stepBegin();
  const view = perf.snapshot();
  assert.equal(view.frames, 2);
  assert.equal(view.frameMs.max, 16.5);
  assert.equal(view.seamTickMs.max, 0.5);
  assert.equal(view.onUpdateMs.max, 1.25);
  assert.equal(view.onUpdateHandlers.max, 30);
  assert.equal(view.syncInStepMs.max, 0.75);
  assert.equal(view.stepMs.max, 2.5);
  assert.equal(view.syncOutsideStepMsPerFrame.max, 3, "the packet's pass is charged to the frame it fell in");
  assert.equal(view.syncsOutsideStep.count, 1, "a pass with nothing to do is not an outside sync");
  assert.equal(view.syncs.paint.count, 1);
  assert.equal(view.syncs.layout.count, 1);
  assert.equal(view.syncs.noop.count, 1);
  assert.equal(view.touches.count, 1);
  assert.equal(view.pictures.count, 1);
  assert.equal(view.worstFrame.syncOutsideStepMs, 3);
  perf.reset();
  assert.equal(perf.snapshot().frames, 0);
  assert.equal(perf.snapshot().syncs.layout.count, 0);
});

test("the renderer reports each pass with what it had to do", async () => {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": `<Ui><Frame name="Root" width="100" height="100">
      <Layers><Layer level="ARTWORK"><Texture name="Art"><Size x="10" y="10"/></Texture>
      <FontString name="Label" text="a"/></Layer></Layers></Frame></Ui>`,
  }) });
  await boot.load();
  const kinds = [];
  const renderer = new FrameXmlDomRenderer(fakeDocument().createElement("section"), {
    bridge: boot.bridge, perf: { sync: (kind, ms) => { assert.ok(ms >= 0); kinds.push(kind); } },
  });
  try {
    renderer.mount(boot.roots);
    assert.deepEqual(kinds, ["structural"]);
    kinds.length = 0;
    assert.equal(boot.vm.execute("Art:SetAlpha(0.5)", "@perf").ok, true);
    assert.equal(boot.vm.execute("Label:SetText('b')", "@perf").ok, true);
    boot.bridge.touch();
    assert.deepEqual(kinds, ["paint", "layout", "structural"]);
  } finally {
    renderer.destroy();
    boot.close();
  }
});

test("a running freeze recording hears long steps and long between-frame passes, nothing else", async () => {
  const { setCaptureProbe } = await import("../dist/code/world/CaptureProbe.js");
  let now = 100;
  const heard = [];
  const perf = new FrameXmlWorldPerf(() => now);
  // Nothing listens: counters only.
  perf.stepBegin(); now += 30; perf.stepEnd();
  setCaptureProbe((kind, at, details) => heard.push([kind, at, { ...details }]));
  try {
    perf.stepBegin(); perf.stepPieces(20, 3, 7); perf.sync("paint", 2); now += 25; perf.stepEnd();
    now += 1; perf.sync("layout", 6); perf.sync("paint", 1);
    perf.stepBegin(); now += 1; perf.stepEnd();
  } finally { setCaptureProbe(undefined); }
  perf.stepBegin(); now += 40; perf.stepEnd();
  assert.deepEqual(heard, [
    ["frameXmlSteps", 130, { stepMs: 25, seamTickMs: 20, onUpdateMs: 3, handlers: 7, syncInStepMs: 2 }],
    ["frameXmlSyncs", 150, { kind: "layout", ms: 6 }],
  ]);
});
