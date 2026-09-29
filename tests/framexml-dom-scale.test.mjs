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
      <Frames><Frame name="Center" width="200" height="100"/><Frame name="TopLeft" width="200" height="100"/>
      <Frame name="Panel" width="400" height="300"><Frames><Frame name="Nested" width="100" height="40"/></Frames></Frame>
      <Frame name="Sibling" width="10" height="10"/></Frames></Frame></Ui>`,
    "interface/framexml/frames.lua": `
      Center:SetScale(0.5); Center:SetPoint("CENTER", Root, "CENTER")
      TopLeft:SetScale(0.5); TopLeft:SetPoint("TOPLEFT", Root, "TOPLEFT", 20, -10)
      Panel:SetScale(0.5); Panel:SetPoint("TOPLEFT", Root, "TOPLEFT", 200, -100)
      Nested:SetScale(0.5); Nested:SetPoint("TOPLEFT", Panel, "TOPLEFT", 20, -10)
      NestedScale = Nested:GetEffectiveScale()
      Sibling:SetPoint("TOPLEFT", Center, "BOTTOMRIGHT", 5, -7)
      Icon = Root:CreateTexture("Icon", "OVERLAY")
      Icon:SetSize(24, 24)
      Icon:SetPoint("CENTER", TopLeft, "CENTER")
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

test("SetScale changes painted CENTER/TOPLEFT geometry and resets cleanly to one", async () => {
  const { boot, element, close } = await setup();
  try {
    assert.equal(element("Center").style.width, "200px", "Lua width remains in the frame's own units");
    assert.equal(element("Center").style.transform, "translateX(-50%) translateY(-50%) scale(0.5)");
    assert.equal(element("Center").style.transformOrigin, "50% 50%");
    assert.equal(element("TopLeft").style.left, "10px");
    assert.equal(element("TopLeft").style.top, "5px");
    assert.equal(element("TopLeft").style.transform, "translateX(-25%) translateY(-25%) scale(0.5)");
    assert.equal(boot.vm.execute('Center:SetScale(1); TopLeft:SetScale(1)', '@scale-reset').ok, true);
    assert.equal(element("Center").style.transform, "translateX(-50%) translateY(-50%)");
    assert.equal(element("TopLeft").style.transform, "");
    assert.equal(element("TopLeft").style.left, "20px");
  } finally { close(); }
});

test("sibling-centred textures use their declared size while intrinsic pixels are loading", async () => {
  const { boot, element, close } = await setup();
  try {
    const paintedIcon = element("Icon");
    Object.assign(element("TopLeft"), { offsetLeft: 10, offsetTop: 5, offsetWidth: 200, offsetHeight: 100, offsetParent: element("Root") });
    // applyGeometry temporarily removes the inline size. A real <img> then reports its intrinsic
    // (possibly texcoord-cropped) size until the authored 24px is restored.
    Object.assign(paintedIcon, { offsetLeft: 0, offsetTop: 0, offsetWidth: 56, offsetHeight: 56, offsetParent: element("Root") });
    // The mocked metrics changed without a widget change; a browser reports that through the
    // bridge's touch() (a picture or font arrived). Repeating a value already set is not a change.
    boot.bridge.touch();
    assert.equal(paintedIcon.style.left, "48px");
    assert.equal(paintedIcon.style.top, "18px");
  } finally { close(); }
});

test("GetEffectiveScale and sibling anchor measurements include nested ancestor scales", async () => {
  const { boot, renderer, element, close } = await setup();
  try {
    assert.equal(boot.vm.getGlobal("NestedScale"), 0.25);
    Object.assign(element("Root"), { offsetLeft: 0, offsetTop: 0, offsetWidth: 1000, offsetHeight: 800, offsetParent: renderer.container });
    Object.assign(element("Center"), { offsetLeft: 500, offsetTop: 400, offsetWidth: 200, offsetHeight: 100, offsetParent: element("Root") });
    Object.assign(element("Sibling"), { offsetLeft: 0, offsetTop: 0, offsetWidth: 10, offsetHeight: 10, offsetParent: element("Root") });
    // The mocked metrics changed without a widget change; a browser reports that through the
    // bridge's touch() (a picture or font arrived). Repeating a value already set is not a change.
    boot.bridge.touch();
    assert.equal(element("Sibling").style.left, "555px");
    assert.equal(element("Sibling").style.top, "432px");
    Object.assign(element("Panel"), { offsetLeft: 100, offsetTop: 50, offsetWidth: 400, offsetHeight: 300, offsetParent: element("Root") });
    Object.assign(element("Nested"), { offsetLeft: 10, offsetTop: 5, offsetWidth: 100, offsetHeight: 40, offsetParent: element("Panel") });
    assert.equal(boot.vm.execute('Sibling:ClearAllPoints(); Sibling:SetPoint("TOPLEFT", Nested, "BOTTOMRIGHT")', '@nested-anchor').ok, true);
    renderer.sync();
    assert.equal(element("Sibling").style.left, "130px");
    assert.equal(element("Sibling").style.top, "62.5px");
    assert.equal(boot.vm.execute('Nested:ClearAllPoints(); Nested:SetPoint("TOPLEFT", Center, "BOTTOMRIGHT")', '@cross-branch-anchor').ok, true);
    assert.equal(element("Nested").style.left, "900px", "target edges are converted into the scaled parent's units");
    assert.equal(element("Nested").style.top, "750px");
  } finally { close(); }
});
