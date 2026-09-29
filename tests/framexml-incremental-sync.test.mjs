import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_, tag) => make(tag) };
  function make(tag) {
    const attrs = new Map();
    const node = { ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) {
        delete this[name]; delete this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      } },
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

async function setup() {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": `<Ui><Frame name="Root" width="1000" height="800">
      <Frames>
        <Frame name="Bar" width="300" height="40">
          <Layers><Layer level="ARTWORK">
            <Texture name="Glow"><Size x="30" y="30"/><Anchors><Anchor point="LEFT"/></Anchors></Texture>
            <FontString name="Label" text="label"><Anchors><Anchor point="LEFT" relativeTo="Glow" relativePoint="RIGHT"/></Anchors></FontString>
          </Layer></Layers>
        </Frame>
        <Frame name="Window" width="400" height="400" hidden="true">
          <Frames>
            <Frame name="Pane" width="100" height="100"><Layers><Layer level="ARTWORK">
              <Texture name="PaneArt"><Size x="10" y="10"/></Texture>
            </Layer></Layers></Frame>
          </Frames>
        </Frame>
      </Frames></Frame></Ui>`,
  }) });
  await boot.load();
  const renderer = new FrameXmlDomRenderer(fakeDocument().createElement("section"), { bridge: boot.bridge });
  renderer.mount(boot.roots);
  // Count what each sync re-applies and which frames the walk reaches.
  const applied = [];
  const walked = new Set();
  const applyFrame = renderer.applyFrame.bind(renderer);
  const syncFrame = renderer.syncFrame.bind(renderer);
  renderer.applyFrame = (rendered, ...rest) => { applied.push(rendered.frame.name); return applyFrame(rendered, ...rest); };
  renderer.syncFrame = (frame, ...rest) => { walked.add(frame.name); return syncFrame(frame, ...rest); };
  let syncs = 0;
  const sync = renderer.sync.bind(renderer);
  renderer.sync = () => { syncs++; return sync(); };
  const run = (source) => assert.equal(boot.vm.execute(source, "@incremental").ok, true, source);
  const reset = () => { applied.length = 0; walked.clear(); syncs = 0; };
  return { boot, renderer, run, applied, walked, reset, get syncs() { return syncs; },
    close() { renderer.destroy(); boot.close(); } };
}

test("a paint change re-applies only its frame, and repeating a value is not a change", async () => {
  const fixture = await setup();
  try {
    fixture.reset();
    // Inside a handler or the frame tick, as the engine runs Lua: one render for the batch.
    fixture.boot.bridge.runInMutationBatch(() => fixture.run("Glow:SetAlpha(0.5); Glow:SetVertexColor(1, 1, 1, 1)"));
    assert.equal(fixture.syncs, 1);
    assert.deepEqual(fixture.applied, ["Glow"], "only the changed texture is re-applied");
    assert.equal(fixture.walked.has("PaneArt"), false, "a hidden window is not walked for a paint change");

    fixture.reset();
    fixture.run("Glow:SetAlpha(0.5); Glow:SetVertexColor(1, 1, 1, 1); Glow:SetVertexColor(1, 1, 1, 1); Bar:Show(); Label:SetText('label')");
    assert.deepEqual(fixture.applied, [], "repeated values re-apply nothing");

    // An alpha change is paint: CSS opacity composes over the subtree, so the children are not
    // re-applied with it (they used to be, measured at 7 frames a frame for 3 alpha flashes).
    fixture.reset();
    fixture.run("Bar:SetAlpha(0.25)");
    assert.deepEqual(fixture.applied, ["Bar"], "a paint change stays on its frame");
    assert.equal(fixture.walked.has("Glow"), false, "and its subtree is not walked");

    // A change that can move the frame still takes its subtree with it.
    fixture.reset();
    fixture.run("Bar:SetWidth(310)");
    assert.deepEqual(fixture.applied.sort(), ["Bar", "Glow", "Label"],
      "a re-applied frame takes its subtree with it");
  } finally { fixture.close(); }
});

test("layout and visibility changes still reach dependents and hidden subtrees", async () => {
  const fixture = await setup();
  try {
    fixture.reset();
    fixture.run("Label:SetText('a longer label')");
    assert.ok(fixture.applied.includes("Label"));

    fixture.reset();
    fixture.run("Window:Show()");
    assert.ok(fixture.applied.includes("Pane") && fixture.applied.includes("PaneArt"),
      "showing a window applies the subtree that waited while it was hidden");
    assert.equal(fixture.renderer.elementFor(fixture.boot.bridge.getFrame("Window")).hidden, false);

    fixture.reset();
    fixture.run("PaneArt:SetAlpha(0.3); Window:Hide()");
    assert.equal(fixture.renderer.elementFor(fixture.boot.bridge.getFrame("Window")).hidden, true);
    fixture.reset();
    fixture.run("Glow:SetAlpha(0.9)");
    assert.equal(fixture.walked.has("Pane"), false, "the hidden window is skipped again");

    // A change made while hidden is applied when the window returns.
    fixture.run("PaneArt:SetAlpha(0.6)");
    fixture.reset();
    fixture.run("Window:Show()");
    assert.ok(fixture.applied.includes("PaneArt"));

    // New widgets are a structural change: they are mounted even under a paint-only frame.
    fixture.reset();
    fixture.run("local made = Bar:CreateTexture('Made', 'ARTWORK'); made:SetSize(4, 4)");
    assert.ok(fixture.renderer.elementFor(fixture.boot.bridge.getFrame("Made")), "a created texture is mounted");
  } finally { fixture.close(); }
});
