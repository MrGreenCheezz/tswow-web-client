import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: undefined,
      style,
      hidden: false,
      className: "",
      textContent: "",
      value: "",
      disabled: false,
      classList: { add(...names) { node.className = [...names].join(" "); } },
      addEventListener(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.parentElement = node;
          node.children.push(child);
        }
      },
      remove() {
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = undefined;
      },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

test("reversed PlayerFrame TexCoords use a valid crop and one horizontal mirror", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Texture name="PlayerFrameTexture" width="100" height="20" file="Interface\\PlayerFrame">
      <TexCoords left="1" right="0.09375" top="0" bottom="0.78125"/>
      <Anchors><Anchor point="CENTER"/></Anchors>
    </Texture>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const frame = bridge.getFrame("PlayerFrameTexture");
  const element = renderer.elementFor(frame);
  assert.ok(frame && element);
  assert.equal(element.getAttribute("data-framexml-texcoords"), "1:0.09375:0:0.78125");
  assert.equal(element.style["--framexml-texcoord-inset"], "0% 0% 21.875% 9.375%");
  assert.equal((element.style.transform.match(/scaleX\(-1\)/g) ?? []).length, 1);
  assert.equal((element.style.transform.match(/scaleY\(-1\)/g) ?? []).length, 0);
  assert.match(element.style.transform, /translateX\(-50%\).*translateY\(-50%\)/);

  bridge.update(frame, (mutable) => { mutable.textureRotation = Math.PI / 2; });
  assert.equal((element.style.transform.match(/scaleX\(-1\)/g) ?? []).length, 1);
  assert.match(element.style.transform, /rotate\(-1\.5707963267948966rad\)/);
  renderer.destroy();
});

test("normal TexCoords keep their crop and clearing reversal removes mirrors", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Texture name="NormalTexture" width="100" height="20" file="Interface\\Atlas">
      <TexCoords left="1" right="0.09375" top="0" bottom="0.78125"/>
    </Texture>
  </Frame></Ui>`);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const frame = bridge.getFrame("NormalTexture");
  const element = renderer.elementFor(frame);
  assert.ok(frame && element);

  bridge.update(frame, (mutable) => {
    mutable.texCoords = { left: 0, right: 0.5, top: 0.25, bottom: 1 };
  });
  assert.equal(element.style["--framexml-texcoord-inset"], "25% 50% 0% 0%");
  const normalTransform = element.style.transform ?? "";
  assert.equal((normalTransform.match(/scaleX\(-1\)/g) ?? []).length, 0);
  assert.equal((normalTransform.match(/scaleY\(-1\)/g) ?? []).length, 0);
  assert.equal(normalTransform, "");

  bridge.update(frame, (mutable) => {
    mutable.texCoords = { left: 0, right: 0.5, top: 1, bottom: 0.25 };
  });
  assert.equal((element.style.transform.match(/scaleX\(-1\)/g) ?? []).length, 0);
  assert.equal((element.style.transform.match(/scaleY\(-1\)/g) ?? []).length, 1);
  renderer.destroy();
});

test("tinted file textures stay invisible until their picture arrives, while colour-only textures paint", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root">
    <Texture name="PendingIcon" width="32" height="32" file="Interface\\Icons\\INV_Potion_54"/>
    <Texture name="ColourOnly" width="32" height="32"/>
    <Texture name="VertexOnly" width="32" height="32"/>
  </Frame></Ui>`);
  const icon = bridge.getFrame("PendingIcon");
  const colour = bridge.getFrame("ColourOnly");
  const vertexOnly = bridge.getFrame("VertexOnly");
  assert.ok(icon && colour && vertexOnly);
  bridge.update(icon, (frame) => { frame.vertexColor = { r: 1, g: 1, b: 1, a: 1 }; });
  // A colour texture is made by SetTexture(r,g,b) or an XML <Color> (colorFill); SetVertexColor alone
  // on a file-less texture draws nothing, as stock TargetFrame.lua's portrait tint relies on.
  bridge.update(colour, (frame) => { frame.vertexColor = { r: 0.2, g: 0.4, b: 0.6, a: 1 }; frame.colorFill = true; });
  bridge.update(vertexOnly, (frame) => { frame.vertexColor = { r: 1, g: 1, b: 1, a: 1 }; });

  let picture;
  const textures = {
    acquire() { return picture; },
    peek() { return picture; },
    release() {},
    acquireEdge() { return undefined; },
    peekEdge() { return undefined; },
    releaseEdge() {},
  };
  const renderer = new FrameXmlDomRenderer(document.createElement("section"), { bridge, textures });
  renderer.mount(loaded.roots);
  const iconElement = renderer.elementFor(icon);
  const colourElement = renderer.elementFor(colour);
  assert.ok(iconElement && colourElement);
  assert.equal(iconElement.getAttribute("src"), null);
  assert.equal(iconElement.getAttribute("data-framexml-blank"), "true");
  assert.equal(colourElement.getAttribute("data-framexml-blank"), null);
  assert.match(colourElement.style.backgroundColor, /^rgba\(/);
  const vertexOnlyElement = renderer.elementFor(vertexOnly);
  assert.equal(vertexOnlyElement?.getAttribute("data-framexml-blank"), "true");

  picture = "blob:loaded-item-icon";
  bridge.touch();
  assert.equal(iconElement.getAttribute("src"), picture);
  assert.equal(iconElement.getAttribute("data-framexml-blank"), null);
  renderer.destroy();
});
