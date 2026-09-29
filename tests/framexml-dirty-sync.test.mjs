import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// A non-structural pass starts at the frames the bridge named (dirtyWalk), and a paint-only change
// is applied without geometry, backdrop or subtree (applyFrame's paintOnly).

/**
 * A DOM stub with inline-pixel layout (as tests/framexml-renderer-anchors-strata.test.mjs) whose
 * layout getters count their reads: a read is what forces the browser to lay the page out.
 */
function layoutDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_namespace, tag) => make(tag), getElementById: () => null,
    activeElement: null, layoutReads: 0 };
  const pixels = (value) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? ""));
    return match ? Number(match[1]) : undefined;
  };
  const hiddenUp = (node) => {
    for (let current = node; current; current = current.parentElement) if (current.hidden) return true;
    return false;
  };
  function make(tag) {
    const attributes = new Map();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: null, hidden: false,
      textContent: "", dataset: {}, className: "", container: false,
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) {
          delete this[name];
          delete this[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
        },
      },
      classList: { add() {} },
      addEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.remove();
          child.parentElement = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.remove();
        child.parentElement = node;
        const index = node.children.indexOf(before);
        node.children.splice(index < 0 ? node.children.length : index, 0, child);
      },
      remove() {
        const parent = node.parentElement;
        if (!parent) return;
        parent.children.splice(parent.children.indexOf(node), 1);
        node.parentElement = null;
      },
      get offsetParent() { doc.layoutReads++; return node.container || hiddenUp(node) ? null : node.parentElement; },
      get offsetLeft() { doc.layoutReads++; return hiddenUp(node) ? 0 : box(node, "left", "right", "width") ?? 0; },
      get offsetTop() { doc.layoutReads++; return hiddenUp(node) ? 0 : box(node, "top", "bottom", "height") ?? 0; },
      get offsetWidth() { doc.layoutReads++; return hiddenUp(node) ? 0 : size(node, "left", "right", "width") ?? 0; },
      get offsetHeight() { doc.layoutReads++; return hiddenUp(node) ? 0 : size(node, "top", "bottom", "height") ?? 0; },
    };
    return node;
  }
  function length(value, base) {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    const direct = pixels(text);
    if (direct !== undefined) return direct;
    const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(text);
    if (percent) return base === undefined ? undefined : Number(percent[1]) * base / 100;
    const calc = /^calc\((-?\d+(?:\.\d+)?)% ([+-]) (-?\d+(?:\.\d+)?)px\)$/.exec(text);
    if (calc && base !== undefined) return Number(calc[1]) * base / 100 + (calc[2] === "+" ? 1 : -1) * Number(calc[3]);
    return undefined;
  }
  function parentSize(node, axis) {
    const parent = node.parentElement;
    if (!parent) return undefined;
    const declared = pixels(parent.style[axis]);
    return declared ?? (axis === "width" ? parent.offsetWidth : parent.offsetHeight);
  }
  function size(node, start, end, axis) {
    const declared = pixels(node.style[axis]);
    if (declared !== undefined) return declared;
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    const to = length(node.style[end], base);
    return from !== undefined && to !== undefined && base !== undefined ? base - from - to : undefined;
  }
  function box(node, start, end, axis) {
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    if (from !== undefined) return from;
    const to = length(node.style[end], base);
    const own = size(node, start, end, axis) ?? 0;
    return to !== undefined && base !== undefined ? base - to - own : undefined;
  }
  doc.head = make("head");
  return doc;
}

const FRAMES = `<Ui>
  <Frame name="Root" width="1000" height="800">
    <Frames>
      <Frame name="Bar" width="300" height="40">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-10"/></Offset></Anchor></Anchors>
        <Layers><Layer level="ARTWORK">
          <Texture name="Icon" file="Interface\\Icons\\A"><Size x="30" y="30"/><Anchors><Anchor point="LEFT"/></Anchors></Texture>
          <FontString name="Label" text="label"><Size x="100" y="20"/>
            <Anchors><Anchor point="LEFT" relativeTo="Icon" relativePoint="RIGHT"/></Anchors></FontString>
        </Layer></Layers>
        <Frames>
          <Frame name="Pop" frameStrata="DIALOG" width="50" height="50"><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
        </Frames>
      </Frame>
      <Frame name="Neighbour" width="40" height="40">
        <Anchors><Anchor point="LEFT" relativeTo="Bar" relativePoint="RIGHT"/></Anchors>
      </Frame>
      <Frame name="Flash" width="20" height="20" hidden="true">
        <Anchors><Anchor point="BOTTOMLEFT"/></Anchors>
      </Frame>
      <Frame name="Ghost" width="50" height="10" hidden="true">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-300"/></Offset></Anchor></Anchors>
      </Frame>
      <Frame name="Follower" width="30" height="10">
        <Anchors><Anchor point="LEFT" relativeTo="Ghost" relativePoint="RIGHT"/></Anchors>
      </Frame>
      <CheckButton name="Check" width="20" height="20">
        <Anchors><Anchor point="BOTTOMRIGHT"/></Anchors>
        <NormalTexture file="Interface\\Buttons\\Normal"/>
        <CheckedTexture file="Interface\\Buttons\\Checked"/>
      </CheckButton>
    </Frames>
  </Frame></Ui>`;

async function setup() {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": FRAMES,
  }) });
  await boot.load();
  const doc = layoutDocument();
  const host = doc.createElement("section");
  host.container = true;
  Object.assign(host.style, { width: "1000px", height: "800px" });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  renderer.mount(boot.roots);
  const calls = { applyFrame: [], applyGeometry: [], walked: [], cursor: 0, dependents: 0 };
  const wrap = (name, record) => {
    const original = renderer[name].bind(renderer);
    renderer[name] = (...args) => { record(...args); return original(...args); };
  };
  wrap("applyFrame", (rendered) => calls.applyFrame.push(rendered.frame.name));
  wrap("applyGeometry", (_element, frame) => calls.applyGeometry.push(frame.name));
  wrap("syncFrame", (frame) => calls.walked.push(frame.name));
  wrap("syncCursorTracking", () => { calls.cursor++; });
  wrap("replaceDependents", () => { calls.dependents++; });
  const reset = () => {
    calls.applyFrame.length = 0; calls.applyGeometry.length = 0; calls.walked.length = 0;
    calls.cursor = 0; calls.dependents = 0; doc.layoutReads = 0;
  };
  const run = (source) => assert.equal(boot.vm.execute(source, "@dirty").ok, true, source);
  const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
  return { boot, renderer, doc, calls, reset, run, element, close() { renderer.destroy(); boot.close(); } };
}

test("a paint-only change re-applies its frame alone, with no geometry and no layout read", async () => {
  const fixture = await setup();
  try {
    const { calls, doc, run, element } = fixture;
    fixture.reset();
    // Bar has a sibling anchored to it and a strata-layer child: neither is touched by an alpha.
    run("Bar:SetAlpha(0.5)");
    assert.deepEqual(calls.applyFrame, ["Bar"]);
    assert.deepEqual(calls.applyGeometry, [], "no geometry is applied for an alpha");
    assert.deepEqual(calls.walked, ["Bar"], "the pass starts at the changed frame and stays there");
    assert.equal(element("Bar").style.opacity, "0.5");
    assert.equal(calls.dependents, 0, "nothing is re-measured");
    assert.equal(calls.cursor, 0, "a paint pass is not a layout pass");

    fixture.reset();
    run("Icon:SetVertexColor(0.5, 0.5, 1); Label:SetTextColor(1, 0, 0)");
    assert.deepEqual(calls.applyFrame.sort(), ["Icon", "Label"]);
    assert.deepEqual(calls.applyGeometry, []);
    assert.equal(doc.layoutReads, 0, "a paint pass forces no layout");
    assert.equal(element("Label").style.color, "rgba(255, 0, 0, 1)");
  } finally { fixture.close(); }
});

test("a transform announced as paint is still drawn, and moves the strata layers over its frame", async () => {
  const fixture = await setup();
  try {
    const { calls, run, element } = fixture;
    fixture.reset();
    run("Icon:SetRotation(1.5)");
    assert.deepEqual(calls.applyGeometry, ["Icon"], "a rotation rides on the geometry's transform");
    assert.match(element("Icon").style.transform, /rotate\(-1\.5rad\)/);
  } finally { fixture.close(); }
});

test("an alpha change reaches the strata layer drawn over the frame", async () => {
  const fixture = await setup();
  try {
    const { host } = { host: fixture.renderer.container };
    const layer = () => host.children.find((child) => child.getAttribute("data-framexml-strata-layer") === "Pop");
    assert.ok(layer(), "Pop (DIALOG under a MEDIUM parent) is drawn in a strata layer");
    assert.equal(layer().style.opacity ?? "", "");
    fixture.run("Bar:SetAlpha(0.25)");
    assert.equal(layer().style.opacity, "0.25", "the layer carries the owner's new alpha");
    fixture.run("Root:SetAlpha(0.5)");
    assert.equal(layer().style.opacity, "0.125", "and every ancestor's");
  } finally { fixture.close(); }
});

test("a layout change re-places what is anchored to the frame and takes its subtree with it", async () => {
  const fixture = await setup();
  try {
    const { calls, run, element } = fixture;
    const before = element("Neighbour").style.left;
    fixture.reset();
    run("Bar:SetWidth(400)");
    assert.ok(calls.applyFrame.includes("Bar") && calls.applyFrame.includes("Icon") && calls.applyFrame.includes("Label"));
    assert.equal(calls.walked.includes("Flash"), false, "an unrelated frame is not walked");
    assert.notEqual(element("Neighbour").style.left, before, "the sibling anchored to Bar's RIGHT moved");
    assert.equal(element("Neighbour").style.left, "410px");
    assert.ok(calls.cursor > 0, "a layout pass");
  } finally { fixture.close(); }
});

test("a frame shown and hidden within one batch is not a layout pass; a real reveal is", async () => {
  const fixture = await setup();
  try {
    const { calls, run, element, boot } = fixture;
    fixture.reset();
    // PartyMemberFrame_OnUpdate's dispel flash: Show() then Hide() inside one OnUpdate.
    boot.bridge.runInMutationBatch(() => run("Flash:Show(); Flash:Hide()"));
    assert.equal(element("Flash").hidden, true);
    assert.equal(calls.cursor, 0, "no layout pass for a frame that ends where it began");
    assert.equal(calls.dependents, 0);
    assert.deepEqual(calls.applyFrame, []);

    fixture.reset();
    run("Flash:Show()");
    assert.equal(element("Flash").hidden, false);
    assert.deepEqual(calls.applyFrame, ["Flash"]);
    assert.ok(calls.cursor > 0, "a reveal is a layout pass");
  } finally { fixture.close(); }
});

test("a hidden anchor target that moves re-places the drawn frame measured against it", async () => {
  const fixture = await setup();
  try {
    const { run, element } = fixture;
    // Ghost is hidden at x = 10, 50 wide: Follower's LEFT is on its RIGHT at 60.
    assert.equal(element("Follower").style.left, "60px");
    run("Ghost:ClearAllPoints(); Ghost:SetPoint('TOPLEFT', Root, 'TOPLEFT', 100, -300)");
    assert.equal(element("Ghost").hidden, true);
    assert.equal(element("Follower").style.left, "150px", "measured again against the hidden target's new box");
  } finally { fixture.close(); }
});

test("a button whose drawn state changes redraws its state textures; a checked flip is enough", async () => {
  const fixture = await setup();
  try {
    const { run, element, boot } = fixture;
    const check = boot.bridge.getFrame("Check");
    const checked = check.stateTextures.get("CHECKED");
    assert.ok(checked);
    const checkedElement = () => fixture.renderer.elementFor(checked);
    assert.equal(checkedElement().style.visibility, "hidden");
    // Click flips `checked` and is announced as paint (FrameXmlUiBridge.Click).
    boot.bridge.Click(check);
    assert.equal(check.checked, true);
    assert.notEqual(checkedElement().style.visibility, "hidden", "the checked texture shows");
    run("Check:SetChecked(false)");
    assert.equal(checkedElement().style.visibility, "hidden");
    assert.equal(element("Check").getAttribute("aria-checked"), "false");
  } finally { fixture.close(); }
});

test("changes made while a subtree is hidden are applied once, when it is revealed", async () => {
  const fixture = await setup();
  try {
    const { calls, run, element } = fixture;
    run("Bar:Hide()");
    fixture.reset();
    run("Icon:SetAlpha(0.3); Label:SetText('while hidden')");
    assert.deepEqual(calls.applyFrame, [], "a hidden subtree is not applied");
    run("Bar:Show()");
    assert.equal(element("Icon").style.opacity, "0.3");
    assert.equal(element("Label").textContent, "while hidden");
  } finally { fixture.close(); }
});

test("a message line is paint: the message frame's subtree and its dependents are left alone", async () => {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": `<Ui><Frame name="Root" width="1000" height="800"><Frames>
      <ScrollingMessageFrame name="Log" width="300" height="100"><Anchors><Anchor point="BOTTOMLEFT"/></Anchors>
        <Frames><Button name="LogTab" width="60" height="20"><Anchors><Anchor point="BOTTOMLEFT" relativePoint="TOPLEFT"/></Anchors></Button></Frames>
      </ScrollingMessageFrame>
      <Frame name="Beside" width="20" height="20"><Anchors><Anchor point="LEFT" relativeTo="Log" relativePoint="RIGHT"/></Anchors></Frame>
    </Frames></Frame></Ui>`,
  }) });
  await boot.load();
  const doc = layoutDocument();
  const host = doc.createElement("section");
  host.container = true;
  Object.assign(host.style, { width: "1000px", height: "800px" });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    const applied = [];
    const geometry = [];
    const applyFrame = renderer.applyFrame.bind(renderer);
    renderer.applyFrame = (rendered, ...rest) => { applied.push(rendered.frame.name); return applyFrame(rendered, ...rest); };
    const applyGeometry = renderer.applyGeometry.bind(renderer);
    renderer.applyGeometry = (element, frame, ...rest) => { geometry.push(frame.name); return applyGeometry(element, frame, ...rest); };
    const layoutBefore = boot.bridge.layoutVersion;
    assert.equal(boot.vm.execute("Log:AddMessage('hello', 1, 1, 0)", "@log").ok, true);
    assert.equal(boot.bridge.layoutVersion, layoutBefore, "a line is not a layout change");
    assert.deepEqual(applied, ["Log"]);
    assert.deepEqual(geometry, []);
    const layer = renderer.elementFor(boot.bridge.getFrame("Log")).children.find((child) => child.getAttribute("data-framexml-message-layer"));
    assert.equal(layer.children.length, 1, "the line is drawn in the message layer");
    assert.equal(layer.children[0].textContent, "hello");
  } finally { renderer.destroy(); boot.close(); }
});

test("a pass places measured frames after its walk's writes, and a chain comes out right", async () => {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": `<Ui><Frame name="Root" width="1000" height="800"><Frames>
      <Frame name="Window" width="400" height="300" hidden="true"><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
        <Frame name="A" width="50" height="10"><Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-10"/></Offset></Anchor></Anchors></Frame>
        <Frame name="B" width="30" height="10"><Anchors><Anchor point="LEFT" relativeTo="A" relativePoint="RIGHT"/></Anchors></Frame>
        <Frame name="C" width="20" height="10"><Anchors><Anchor point="LEFT" relativeTo="B" relativePoint="RIGHT"/></Anchors></Frame>
        <Frame name="D" width="20" height="10"><Anchors><Anchor point="BOTTOMRIGHT"/></Anchors></Frame>
      </Frames></Frame>
    </Frames></Frame></Ui>`,
  }) });
  await boot.load();
  const doc = layoutDocument();
  const host = doc.createElement("section");
  host.container = true;
  Object.assign(host.style, { width: "1000px", height: "800px" });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    const order = [];
    const applyFrame = renderer.applyFrame.bind(renderer);
    renderer.applyFrame = (rendered, ...rest) => { order.push(`apply ${rendered.frame.name}`); return applyFrame(rendered, ...rest); };
    const measureSibling = renderer.measureSibling.bind(renderer);
    renderer.measureSibling = (element, target) => { order.push(`measure ${target.name}`); return measureSibling(element, target); };
    assert.equal(boot.vm.execute("A:SetWidth(80); Window:Show()", "@chain").ok, true);
    const lastApply = order.findLastIndex((entry) => entry.startsWith("apply"));
    const firstMeasure = order.findIndex((entry) => entry.startsWith("measure"));
    assert.ok(firstMeasure > lastApply, `every measure follows every write of the walk: ${order.join(", ")}`);
    const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
    assert.equal(element("B").style.left, "90px", "B on A's new right edge (10 + 80)");
    assert.equal(element("C").style.left, "120px", "C on B's right edge");
  } finally { renderer.destroy(); boot.close(); }
});

/** A fixture from one frames file, drawn over the inline-pixel layout stub. */
async function mountFrames(frames) {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": frames,
  }) });
  await boot.load();
  const doc = layoutDocument();
  const host = doc.createElement("section");
  host.container = true;
  Object.assign(host.style, { width: "1000px", height: "800px" });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  renderer.mount(boot.roots);
  const run = (source) => assert.equal(boot.vm.execute(source, "@held").ok, true, source);
  const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
  return { boot, host, renderer, run, element, close() { renderer.destroy(); boot.close(); } };
}

test("a strata layer over a frame placed after the walk follows that placement", async () => {
  // `Chat` is clamped to the screen and anchored to a sibling, so its placement is held until the
  // walk is done (a chat frame's is); its DIALOG children are drawn in layers over it and over
  // `Inner`, and `Hint`, inside a layer, is measured against a frame outside it.
  const fixture = await mountFrames(`<Ui><Frame name="Root" width="1000" height="800"><Frames>
    <Frame name="A" width="100" height="40"><Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-10"/></Offset></Anchor></Anchors></Frame>
    <Frame name="Chat" width="300" height="100" clampedToScreen="true">
      <Anchors><Anchor point="TOPLEFT" relativeTo="A" relativePoint="BOTTOMLEFT"/></Anchors>
      <Frames>
        <Frame name="Input" frameStrata="DIALOG" width="300" height="20"><Anchors><Anchor point="TOPLEFT" relativePoint="BOTTOMLEFT"/></Anchors>
          <Frames><Frame name="Hint" width="10" height="10"><Anchors><Anchor point="TOPLEFT" relativeTo="A" relativePoint="TOPRIGHT"/></Anchors></Frame></Frames>
        </Frame>
        <Frame name="Inner" width="100" height="50"><Anchors><Anchor point="BOTTOMRIGHT"/></Anchors>
          <Frames><Frame name="Deep" frameStrata="DIALOG" width="20" height="20"><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame></Frames>
        </Frame>
      </Frames>
    </Frame>
  </Frames></Frame></Ui>`);
  try {
    const { host, run, element } = fixture;
    const layer = (name) => host.children.find((child) => child.getAttribute("data-framexml-strata-layer") === name);
    const at = (node) => {
      let x = 0; let y = 0;
      for (let at = node; at && at !== host; at = at.parentElement) { x += at.offsetLeft; y += at.offsetTop; }
      return [x, y];
    };
    const box = (node) => [...at(node), node.offsetWidth, node.offsetHeight];
    const layerBox = (name) => ["left", "top", "width", "height"].map((edge) => Number.parseFloat(layer(name).style[edge]));
    const agree = (tag) => {
      assert.deepEqual(layerBox("Input"), box(element("Chat")), `${tag}: Input's layer is Chat's box`);
      assert.deepEqual(layerBox("Deep"), box(element("Inner")), `${tag}: Deep's layer is Inner's box`);
      assert.deepEqual(at(element("Hint")), [110, 10], `${tag}: Hint on A's top right, measured through the layer`);
    };
    assert.ok(layer("Input") && layer("Deep"), "both DIALOG children are drawn in strata layers");
    agree("mount");
    assert.deepEqual(box(element("Chat")), [10, 50, 300, 100]);
    run("Chat:SetWidth(420)");
    assert.deepEqual(box(element("Chat")), [10, 50, 420, 100]);
    agree("after SetWidth");
    run("Chat:ClearAllPoints(); Chat:SetPoint('TOPLEFT', A, 'BOTTOMLEFT', 150, -60)");
    assert.deepEqual(box(element("Chat")), [160, 110, 420, 100]);
    agree("after SetPoint");
  } finally { fixture.close(); }
});

test("a message frame resized and given a line in one batch stays pinned to its bottom", async () => {
  const fixture = await mountFrames(`<Ui><Frame name="Root" width="1000" height="800"><Frames>
    <ScrollingMessageFrame name="Log" width="300" height="100" clampedToScreen="true"><Anchors><Anchor point="BOTTOMLEFT"/></Anchors></ScrollingMessageFrame>
  </Frames></Frame></Ui>`);
  try {
    const { boot, run, element } = fixture;
    const frame = element("Log");
    const layer = frame.children.find((child) => child.getAttribute("data-framexml-message-layer"));
    assert.ok(layer, "the message layer is drawn");
    // Ten pixels a line, in a layer as tall as its frame.
    Object.defineProperty(layer, "scrollHeight", { get: () => layer.children.length * 10 });
    Object.defineProperty(layer, "clientHeight", { get: () => frame.offsetHeight });
    layer.scrollTop = 0;
    run("for i = 1, 30 do Log:AddMessage('line ' .. i) end");
    assert.equal(layer.scrollTop, 300 - 100, "at the bottom");
    boot.bridge.runInMutationBatch(() => run("Log:SetHeight(30); Log:AddMessage('newest')"));
    assert.equal(frame.offsetHeight, 30);
    assert.equal(layer.scrollTop, 310 - 30, "mapped against the new height: the newest line is in view");
  } finally { fixture.close(); }
});
