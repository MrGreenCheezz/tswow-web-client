import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_, tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) {
        delete this[name]; delete this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      } }, dataset: {}, className: "", hidden: false, textContent: "", value: "", disabled: false,
      classList: { add(...names) { node.className += names.join(" "); } },
      addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
      dispatchEvent(event) { for (const handler of listeners.get(event.type) ?? []) handler(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; }, removeAttribute(name) { attributes.delete(name); },
      append(...children) { for (const child of children) { child.remove(); child.parentElement = node; node.children.push(child); } },
      remove() { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node); },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

async function setup() {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Controls.xml",
    "interface/framexml/controls.xml": `<Ui><Frame name="UIParent" width="800" height="600"><Frames>
      <ScrollFrame name="Scroll" width="200" height="100"><Anchors><Anchor point="TOPLEFT" x="20" y="-30"/></Anchors>
        <Layers><Layer><Texture name="ScrollArt"/></Layer></Layers>
        <Frames><Slider name="ScrollBar" minValue="0" maxValue="300" valueStep="5">
          <Size x="16" y="100"/><Anchors><Anchor point="TOPLEFT" relativePoint="TOPRIGHT" x="6"/></Anchors>
          <ThumbTexture name="ScrollThumb"><Size x="18" y="24"/></ThumbTexture>
          <Scripts><OnValueChanged>Scroll:SetVerticalScroll(value); ValueChanges = (ValueChanges or 0) + 1</OnValueChanged></Scripts>
        </Slider></Frames>
        <Scripts>
          <OnMouseWheel>WheelSeen = delta; ScrollBar:SetValue(ScrollBar:GetValue() - delta * 50)</OnMouseWheel>
          <OnScrollRangeChanged>ScrollBar:SetMinMaxValues(0, yrange); SeenX = xrange; SeenY = yrange</OnScrollRangeChanged>
          <OnVerticalScroll>ScrollBar:SetValue(offset)</OnVerticalScroll>
        </Scripts>
        <ScrollChild><Frame name="Content" width="260" height="400"/></ScrollChild>
      </ScrollFrame>
    </Frames></Frame></Ui>`,
  }) });
  await boot.load();
  const doc = fakeDocument();
  const renderer = new FrameXmlDomRenderer(doc.createElement("section"), { bridge: boot.bridge });
  renderer.mount(boot.roots);
  const frame = (name) => boot.bridge.getFrame(name);
  const element = (name) => renderer.elementFor(frame(name));
  const viewport = element("Scroll").children.find((node) => node.getAttribute("data-framexml-scroll-viewport") === "true");
  const range = element("ScrollBar").children.find((node) => node.getAttribute("data-framexml-slider-input") === "true");
  const lua = (source) => { const result = boot.vm.execute(source, "@controls"); assert.equal(result.ok, true, result.error); };
  return { boot, renderer, frame, element, viewport, range, lua, close() { renderer.destroy(); boot.close(); } };
}

test("original scroll children are distinct from scrollbar frames and regions", async () => {
  const { boot, frame, element, viewport, lua, close } = await setup();
  try {
    lua(`ScrollChildOK = Scroll:GetScrollChild() == Content
      ChildCount = Scroll:GetNumChildren(); RegionCount = Scroll:GetNumRegions()
      FirstChild, SecondChild, ThirdChild = Scroll:GetChildren()
      CenterX, CenterY = Scroll:GetCenter()`);
    assert.equal(boot.vm.getGlobal("ScrollChildOK"), true);
    assert.equal(boot.vm.getGlobal("ChildCount"), 2);
    assert.equal(boot.vm.getGlobal("RegionCount"), 1);
    assert.equal(boot.vm.getGlobal("FirstChild"), frame("ScrollBar"));
    assert.equal(boot.vm.getGlobal("SecondChild"), frame("Content"));
    assert.equal(boot.vm.getGlobal("ThirdChild"), undefined);
    assert.equal(boot.vm.getGlobal("CenterX"), 120);
    assert.equal(boot.vm.getGlobal("CenterY"), 520);
    assert.equal(element("Content").parentElement, viewport);
    assert.equal(element("ScrollBar").parentElement, element("Scroll"));
    assert.equal(element("ScrollArt").parentElement, element("Scroll"));
    assert.equal(element("Scroll").style.overflow, "visible");
    lua(`NewContent = CreateFrame("Frame", "NewContent", UIParent)
      Scroll:SetScrollChild(NewContent); NewChildOK = Scroll:GetScrollChild() == NewContent`);
    assert.equal(boot.vm.getGlobal("NewChildOK"), true);
    assert.equal(element("NewContent").parentElement, viewport);
    assert.equal(element("Content").parentElement, element("Scroll"));
    lua(`NewContent:SetParent(UIParent); DetachedOK = Scroll:GetScrollChild() == nil`);
    assert.equal(boot.vm.getGlobal("DetachedOK"), true);
  } finally { close(); }
});

test("wheel input calls original Lua once, honors disable, and never escapes into world camera", async () => {
  const { boot, element, lua, close } = await setup();
  try {
    const owner = element("Scroll");
    let prevented = 0, stopped = 0;
    const wheel = (deltaY) => owner.dispatchEvent({ type: "wheel", deltaY,
      preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    wheel(120);
    assert.equal(boot.vm.getGlobal("WheelSeen"), -1);
    assert.equal(boot.vm.getGlobal("ValueChanges"), 1);
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    lua(`Scroll:EnableMouseWheel(false); WheelEnabled = Scroll:IsMouseWheelEnabled()`);
    wheel(-120);
    assert.equal(boot.vm.getGlobal("WheelEnabled"), false);
    assert.equal(boot.vm.getGlobal("ValueChanges"), 1);
    lua(`Scroll:EnableMouseWheel(true)`);
    wheel(-1);
    assert.equal(boot.vm.getGlobal("WheelSeen"), 1);
    assert.equal(boot.vm.getGlobal("ValueChanges"), 2);
    lua(`UIParent:Hide()`);
    wheel(120);
    assert.equal(boot.vm.getGlobal("ValueChanges"), 2);
  } finally { close(); }
});

test("slider drag/keyboard input reaches stock OnValueChanged and scrolls only content", async () => {
  const { boot, renderer, frame, element, viewport, range, lua, close } = await setup();
  try {
    Object.assign(viewport, { clientWidth: 200, clientHeight: 100, scrollWidth: 260, scrollHeight: 400, scrollTop: 0, scrollLeft: 0 });
    lua("Scroll:UpdateScrollChildRect()");
    renderer.sync();
    assert.equal(boot.vm.getGlobal("SeenX"), 60);
    assert.equal(boot.vm.getGlobal("SeenY"), 300);
    range.value = "73";
    range.dispatchEvent({ type: "input" });
    renderer.sync();
    assert.equal(frame("ScrollBar").slider.value, 75);
    assert.equal(frame("Scroll").scroll.verticalScroll, 75);
    assert.equal(viewport.scrollTop, 75);
    assert.equal(boot.vm.getGlobal("ValueChanges"), 1, "reciprocal stock scripts must not loop");
    assert.equal(element("ScrollThumb").style.top, "25%");
    assert.equal(range.value, "75");
    assert.equal(range.step, "5");
    range.dispatchEvent({ type: "input" });
    assert.equal(boot.vm.getGlobal("ValueChanges"), 1);
    lua(`Scroll:SetHorizontalScroll(30)`);
    assert.equal(viewport.scrollLeft, 30);
    lua(`ScrollBar:SetOrientation("HORIZONTAL"); ScrollBar:SetValue(150)`);
    assert.equal(range.style.writingMode, "horizontal-tb");
    assert.equal(element("ScrollThumb").style.left, "50%");
    lua(`ScrollBar:Disable()`);
    assert.equal(range.disabled, true);
    range.value = "250"; range.dispatchEvent({ type: "input" });
    assert.equal(frame("ScrollBar").slider.value, 150);
    // Collapsed ranges must clamp to zero instead of preserving an impossible value.
    lua(`ScrollBar:Enable(); ScrollBar:SetMinMaxValues(0, 0); ScrollBar:SetValue(90)`);
    assert.equal(frame("ScrollBar").slider.value, 0);
    assert.equal(range.disabled, true);
  } finally { close(); }
});


test("a layout pass that leaves a slider where it was writes nothing to its input or thumb", async () => {
  const { renderer, element, range, lua, close } = await setup();
  try {
    renderer.sync();
    const thumb = element("ScrollThumb");
    let writes = 0;
    const counting = (target, properties) => {
      for (const property of properties) {
        let value = target[property];
        Object.defineProperty(target, property, {
          configurable: true,
          get: () => value,
          set: (next) => { writes += 1; value = next; },
        });
      }
    };
    counting(range, ["min", "max", "step", "value", "disabled"]);
    counting(range.style, ["writingMode", "direction"]);
    counting(thumb.style, ["left", "top", "right", "bottom", "transform", "pointerEvents"]);
    const orientation = range.getAttribute("aria-orientation");
    // A layout change beside the slider: every drawn slider is applied again in that pass.
    lua("ScrollArt:SetWidth(50)");
    assert.equal(writes, 0, "every value the slider shows is already on the page");
    assert.equal(range.getAttribute("aria-orientation"), orientation);
    // And a real change still reaches it.
    lua("ScrollBar:SetValue(150)");
    assert.equal(range.value, "150");
    assert.ok(writes > 0);
  } finally { close(); }
});

test("initial scroll ranges publish together instead of recursively traversing the complete HUD per frame", async () => {
  const count = 24;
  const rows = Array.from({ length: count }, (_, i) => '<ScrollFrame name="Scroll' + i + '" width="200" height="100"><Scripts><OnScrollRangeChanged>RangeCalls = (RangeCalls or 0) + 1; self:SetAttribute("observed", yrange)</OnScrollRangeChanged></Scripts><ScrollChild><Frame width="200" height="300"/></ScrollChild></ScrollFrame>').join("");
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Initial.xml",
    "interface/framexml/initial.xml": '<Ui><Frame name="UIParent"><Frames>' + rows + '</Frames></Frame></Ui>',
  }) });
  await boot.load();
  const doc = fakeDocument();
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const element = create(tag);
    Object.assign(element, { clientHeight: 100, clientWidth: 200, scrollHeight: 300, scrollWidth: 200 });
    return element;
  };
  const renderer = new FrameXmlDomRenderer(doc.createElement("section"), { bridge: boot.bridge });
  const original = renderer.sync.bind(renderer);
  let depth = 0, maximumDepth = 0, syncs = 0;
  renderer.sync = () => {
    depth++; syncs++; maximumDepth = Math.max(maximumDepth, depth);
    try { original(); } finally { depth--; }
  };
  try {
    renderer.mount(boot.roots);
    assert.equal(boot.vm.getGlobal("RangeCalls"), count, "every stock handler observes its first range");
    assert.equal(boot.bridge.getFrame("Scroll23").scroll.verticalScrollRange, 200);
    assert.equal(boot.errors.length, 0);
    assert.ok(maximumDepth <= 2, "first paint and one coalesced update cannot recurse once per ScrollFrame");
    assert.equal(syncs, 2);
  } finally { renderer.destroy(); boot.close(); }
});
