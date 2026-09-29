import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// A Texture with no file paints a flat rectangle only when it *is* a colour — `SetTexture(r, g, b,
// a)` or an XML `<Color>`. `SetVertexColor` tints a picture and draws nothing without one: stock
// TargetFrame.lua calls `self.portrait:SetVertexColor(1, 1, 1)` on every update, and painting that
// as a fill was the white square behind the target, focus and party portraits.

function stubDocument() {
  const doc = {
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
    getElementById: () => null,
    activeElement: null,
  };
  function make(tag) {
    const attributes = new Map();
    const node = {
      ownerDocument: doc,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: null,
      hidden: false,
      textContent: "",
      dataset: {},
      className: "",
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
      offsetParent: null, offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0,
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

const PORTRAITS = `<Ui>
  <Frame name="Unit"><Size x="200" y="100"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Layers>
      <Layer level="BACKGROUND">
        <Texture name="UnitBackground"><Size x="119" y="41"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
          <Color r="0" g="0" b="0" a="0.5"/></Texture>
      </Layer>
      <Layer level="ARTWORK">
        <Texture name="UnitPortrait"><Size x="64" y="64"/><Anchors><Anchor point="TOPRIGHT"/></Anchors></Texture>
      </Layer>
    </Layers>
  </Frame>
</Ui>`;

test("a vertex colour on a file-less Texture draws nothing; a colour texture fills", async () => {
  const loaded = new FrameXmlBoot({
    exercise: false,
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "frames.xml",
      "interface/framexml/frames.xml": PORTRAITS,
    }),
  });
  await loaded.load();
  const doc = stubDocument();
  const host = doc.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: loaded.bridge, textureResolver: (path) => `tex:${path}` });
  renderer.mount(loaded.roots);
  const element = (name) => renderer.elementFor(loaded.bridge.getFrame(name));
  const lua = (code) => {
    const fn = loaded.vm.compileFunction(code, "color-texture-test", []);
    assert.ok(fn, `compiles: ${code}`);
    try { return loaded.vm.call(fn, [], 0); } finally { loaded.vm.release(fn); }
  };
  try {
    // TargetFrame_CheckDead's live-unit branch, before any portrait picture exists.
    lua("UnitPortrait:SetVertexColor(1.0, 1.0, 1.0)");
    const portrait = element("UnitPortrait");
    assert.equal(portrait.style.backgroundColor ?? "", "", "a tint is not a fill: no white square");
    assert.equal(portrait.getAttribute("data-framexml-blank"), "true", "the empty <img> stays invisible");
    // The dead/tapped grey tint keeps drawing nothing as well.
    lua("UnitPortrait:SetVertexColor(0.5, 0.5, 0.5)");
    assert.equal(portrait.style.backgroundColor ?? "", "");

    // `SetTexture(r, g, b, a)` makes it a colour texture: it fills, and a later tint recolours it.
    lua("UnitPortrait:SetTexture(0, 0, 0, 1)");
    assert.match(portrait.style.backgroundColor, /^rgba\(0, 0, 0/);
    assert.equal(portrait.getAttribute("data-framexml-blank"), null);
    // A file replaces the colour; nil (no picture at all) leaves nothing to fill.
    lua("UnitPortrait:SetTexture(nil)");
    assert.equal(portrait.style.backgroundColor ?? "", "", "SetTexture(nil) clears the colour fill");
    assert.equal(portrait.getAttribute("data-framexml-blank"), "true");

    // An XML <Color> child is the colour-texture form: TargetFrameBackground's translucent black.
    const background = element("UnitBackground");
    assert.match(background.style.backgroundColor, /^rgba\(0, 0, 0/);
    assert.equal(background.style.opacity, "0.5");
    assert.equal(background.getAttribute("data-framexml-blank"), null);
    assert.equal(loaded.errorCount, 0);
  } finally {
    renderer.destroy();
    loaded.close();
  }
});
