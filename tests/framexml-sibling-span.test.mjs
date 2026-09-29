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
    "interface/framexml/framexml.toc": "Frames.xml\nFrames.lua",
    "interface/framexml/frames.xml": `<Ui><Frame name="Root" width="1000" height="800">
      <Frames><Frame name="Dialog" width="300" height="100">
        <Layers><Layer level="BACKGROUND">
          <Texture name="HeadLeft"><Size x="5" y="19"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Texture>
          <Texture name="HeadRight"><Size x="4" y="19"/><Anchors><Anchor point="TOPRIGHT"/></Anchors></Texture>
          <Texture name="HeadMiddle"><Size x="10" y="19"/><Anchors>
            <Anchor point="LEFT" relativeTo="HeadLeft" relativePoint="RIGHT"/>
            <Anchor point="RIGHT" relativeTo="HeadRight" relativePoint="LEFT"/>
          </Anchors></Texture>
          <FontString name="WrappedText" text="first second third"><Size x="220" y="0"/>
            <Anchors><Anchor point="TOPLEFT" x="0" y="0"/></Anchors></FontString>
          <FontString name="PlainLabel" text="short label"><Anchors><Anchor point="TOPLEFT" x="0" y="-40"/></Anchors></FontString>
          <FontString name="LockedText" text="first second third" wordWrap="false"><Size x="220" y="0"/>
            <Anchors><Anchor point="TOPLEFT" x="0" y="-60"/></Anchors></FontString>
        </Layer></Layers>
        <Frames>
          <Button name="WideButton"><Size x="200" y="30"/>
            <Anchors><Anchor point="TOPLEFT" x="0" y="-80"/></Anchors>
            <ButtonText text="a much longer label than half"/>
          </Button>
          <ScrollFrame name="Scroller"><Size x="220" y="220"/>
            <Anchors><Anchor point="TOPLEFT" x="0" y="-120"/></Anchors>
            <ScrollChild><Frame name="ScrollerChild"><Size x="220" y="10"/></Frame></ScrollChild>
          </ScrollFrame>
        </Frames>
      </Frame></Frames></Frame></Ui>`,
    "interface/framexml/frames.lua": `
      Scroller:SetScript("OnScrollRangeChanged", function(self, xrange, yrange) ScrollRangeSeen = yrange end)
    `,
  }) });
  await boot.load();
  const doc = fakeDocument();
  const host = doc.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  renderer.mount(boot.roots);
  return { boot, renderer, element: (name) => renderer.elementFor(boot.bridge.getFrame(name)),
    close() { renderer.destroy(); boot.close(); } };
}

test("a three-slice middle with two sibling anchors spans the caps instead of keeping its size", async () => {
  const { boot, renderer, element, close } = await setup();
  try {
    // A 300-wide dialog: left cap 0..5, right cap 296..300.
    Object.assign(element("Dialog"), { offsetLeft: 0, offsetTop: 0, offsetWidth: 300, offsetHeight: 100, offsetParent: element("Root") });
    Object.assign(element("HeadLeft"), { offsetLeft: 0, offsetTop: 0, offsetWidth: 5, offsetHeight: 19, offsetParent: element("Dialog") });
    Object.assign(element("HeadRight"), { offsetLeft: 296, offsetTop: 0, offsetWidth: 4, offsetHeight: 19, offsetParent: element("Dialog") });
    Object.assign(element("HeadMiddle"), { offsetLeft: 0, offsetTop: 0, offsetWidth: 10, offsetHeight: 19, offsetParent: element("Dialog") });
    // The mocked metrics changed without a widget change; a browser reports that through the
    // bridge's touch() (a picture or font arrived). Repeating a value already set is not a change.
    boot.bridge.touch();
    renderer.sync();
    assert.equal(element("HeadMiddle").style.left, "5px");
    assert.equal(element("HeadMiddle").style.width, "291px",
      "the middle must stretch from the left cap to the right cap, not keep its declared 10px");
    // A second quiet pass must not drift or refire.
    renderer.sync();
    assert.equal(element("HeadMiddle").style.left, "5px");
    assert.equal(element("HeadMiddle").style.width, "291px");
  } finally { close(); }
});

test("FontString wrapping follows the authored width, and button labels stay single-line", async () => {
  const { boot, renderer, element, close } = await setup();
  try {
    assert.equal(element("WrappedText").style.whiteSpace, "pre-wrap");
    assert.equal(element("WrappedText").style.overflowWrap, "break-word");
    assert.ok(!element("WrappedText").style.height, "a zero height fits the wrapped lines instead of collapsing");
    assert.equal(element("LockedText").style.whiteSpace, "pre", "wordWrap=false opts out");
    assert.equal(element("PlainLabel").style.whiteSpace, "pre",
      "a widthless string has nothing to wrap against and stays one line");
    const owner = boot.bridge.getFrame("WideButton");
    const label = owner.stateTextures.get("BUTTONTEXT");
    assert.ok(label, "the button owns its label as a separate string");
    assert.equal(renderer.elementFor(label).style.whiteSpace, "pre",
      "a CENTER-anchored label must not wrap at half its button");
  } finally { close(); }
});

test("a ScrollFrame clips to its box and publishes its measured content range", async () => {
  const { boot, renderer, element, close } = await setup();
  try {
    const owner = element("Scroller");
    const scroller = owner.children.find((child) => child.getAttribute("data-framexml-scroll-viewport") === "true");
    assert.ok(scroller, "only the ScrollChild belongs to the clipped viewport");
    Object.assign(scroller, { clientHeight: 220, scrollHeight: 314, scrollTop: 0 });
    // The mocked metrics changed without a widget change; a browser reports that through the
    // bridge's touch() (a picture or font arrived). Repeating a value already set is not a change.
    boot.bridge.touch();
    renderer.sync();
    assert.equal(scroller.style.overflow, "hidden");
    assert.equal(owner.style.overflow, "visible", "outside scrollbars must not be clipped");
    assert.equal(boot.vm.getGlobal("ScrollRangeSeen"), 94);
    assert.equal(boot.vm.execute("ScrollAtTop = Scroller:GetVerticalScroll()", "@read-top").ok, true);
    assert.equal(boot.vm.getGlobal("ScrollAtTop"), 0);
    assert.equal(boot.vm.execute("Scroller:SetVerticalScroll(50)", "@scroll").ok, true);
    renderer.sync();
    assert.equal(scroller.scrollTop, 50);
    assert.equal(boot.vm.execute("ScrollMoved = Scroller:GetVerticalScroll()", "@read-moved").ok, true);
    assert.equal(boot.vm.getGlobal("ScrollMoved"), 50);
    // Collapsed content reports no range and parks the offset at zero.
    Object.assign(scroller, { clientHeight: 220, scrollHeight: 220, scrollTop: 50 });
    boot.bridge.touch();
    renderer.sync();
    assert.equal(boot.vm.getGlobal("ScrollRangeSeen"), 0);
    assert.equal(scroller.scrollTop, 0);
  } finally { close(); }
});
