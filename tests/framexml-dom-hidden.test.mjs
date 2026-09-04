import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");
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

function textureSource() {
  const acquired = [];
  const released = [];
  const held = new Map();
  return {
    acquired,
    released,
    acquire(path) {
      acquired.push(path);
      const url = `blob:${path}`;
      held.set(path, url);
      return url;
    },
    peek(path) { return held.get(path); },
    release(path) { released.push(path); },
    acquireEdge() { return undefined; },
    peekEdge() { return undefined; },
    releaseEdge() {},
  };
}

function findByName(node, name) {
  if (node.getAttribute?.("data-framexml-name") === name) return node;
  for (const child of node.children ?? []) {
    const found = findByName(child, name);
    if (found) return found;
  }
  return undefined;
}

test("hidden subtrees keep DOM/texture ownership idle and reconcile on reveal", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const root = bridge.CreateFrame("Frame", "HiddenRoot");
  const picture = bridge.CreateFrame("Texture", "HiddenPicture", root);
  assert.ok(root);
  assert.ok(picture);
  bridge.SetTexture(picture, "first");
  const textures = textureSource();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  const applied = [];
  const applyFrame = renderer.applyFrame.bind(renderer);
  renderer.applyFrame = (rendered) => {
    applied.push(rendered.frame.name);
    return applyFrame(rendered);
  };
  renderer.mount([root]);
  const pictureElement = renderer.elementFor(picture);
  assert.ok(pictureElement);
  assert.equal(pictureElement.getAttribute("data-framexml-texture"), "first");
  assert.deepEqual(textures.acquired, ["first.blp"]);
  applied.length = 0;
  textures.acquired.length = 0;
  textures.released.length = 0;

  bridge.Hide(root);
  assert.deepEqual(applied, ["HiddenRoot"]);
  assert.deepEqual(textures.acquired, []);
  assert.deepEqual(textures.released, []);

  bridge.SetTexture(picture, "second");
  bridge.touch();
  assert.deepEqual(applied, ["HiddenRoot"]);
  assert.equal(pictureElement.getAttribute("data-framexml-texture"), "first");
  assert.deepEqual(textures.acquired, []);
  assert.deepEqual(textures.released, []);

  bridge.Show(root);
  assert.ok(applied.includes("HiddenRoot"));
  assert.ok(applied.includes("HiddenPicture"));
  assert.equal(pictureElement.getAttribute("data-framexml-texture"), "second");
  assert.deepEqual(textures.acquired, ["second.blp"]);
  assert.deepEqual(textures.released, ["first.blp"]);

  renderer.destroy();
});

test("an initially hidden subtree mounts once, defers changes, and applies current texture on reveal", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const root = bridge.CreateFrame("Frame", "InitiallyHiddenRoot");
  const picture = bridge.CreateFrame("Texture", "InitiallyHiddenPicture", root);
  assert.ok(root);
  assert.ok(picture);
  bridge.update(root, (frame) => { frame.visible = false; });
  bridge.SetTexture(picture, "first");
  const textures = textureSource();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  renderer.mount([root]);
  const pictureElement = renderer.elementFor(picture);
  assert.ok(pictureElement, "initially hidden descendants remain mounted");
  assert.deepEqual(textures.acquired, ["first.blp"]);
  textures.acquired.length = 0;
  textures.released.length = 0;

  bridge.SetTexture(picture, "second");
  assert.equal(pictureElement.getAttribute("data-framexml-texture"), "first");
  assert.deepEqual(textures.acquired, []);
  assert.deepEqual(textures.released, []);

  bridge.Show(root);
  assert.equal(pictureElement.getAttribute("data-framexml-texture"), "second");
  assert.deepEqual(textures.acquired, ["second.blp"]);
  assert.deepEqual(textures.released, ["first.blp"]);
  renderer.destroy();
});

test("a removed nested hidden subtree is released once and never resurrects", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const root = bridge.CreateFrame("Frame", "RemovalRoot");
  const panel = bridge.CreateFrame("Frame", "RemovedPanel", root);
  const picture = bridge.CreateFrame("Texture", "RemovedPicture", panel);
  assert.ok(root && panel && picture);
  bridge.SetTexture(picture, "nested");
  const textures = textureSource();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  renderer.mount([root]);
  assert.ok(findByName(host, "RemovedPicture"));
  assert.deepEqual(textures.acquired, ["nested.blp"]);
  textures.acquired.length = 0;
  textures.released.length = 0;

  bridge.Hide(root);
  bridge.resolve(root).children.splice(bridge.resolve(root).children.indexOf(panel), 1);
  bridge.touch();
  assert.deepEqual(textures.acquired, []);
  assert.deepEqual(textures.released, ["nested.blp"]);
  assert.equal(renderer.elementFor(panel), undefined);
  assert.equal(renderer.elementFor(picture), undefined);
  assert.equal(findByName(host, "RemovedPanel"), undefined);
  assert.equal(findByName(host, "RemovedPicture"), undefined);

  bridge.Show(root);
  assert.equal(findByName(host, "RemovedPanel"), undefined);
  assert.equal(findByName(host, "RemovedPicture"), undefined);
  assert.deepEqual(textures.acquired, []);
  assert.deepEqual(textures.released, ["nested.blp"]);
  renderer.destroy();
});

test("party rows anchor through hidden pet frames without showing or repainting them", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root" width="300" height="200">
    <Frame name="PartyRow1" width="64" height="26">
      <Frame name="PartyRow1PetHolder" hidden="true" width="80" height="40">
        <Frame name="PartyRow1Pet" hidden="true" width="64" height="26">
          <Anchors><Anchor point="TOPLEFT"><Offset x="23" y="-27"/></Anchor></Anchors>
          <Texture name="HiddenTexture" file="first"/>
        </Frame>
      </Frame>
    </Frame>
    <Frame name="PartyRow2" width="64" height="26">
      <Anchors><Anchor point="TOPLEFT" relativeTo="PartyRow1Pet" relativePoint="BOTTOMLEFT"/></Anchors>
      <Frame name="PartyRow2Pet" hidden="true" width="64" height="26"/>
    </Frame>
    <Frame name="PartyRow3" width="64" height="26">
      <Anchors><Anchor point="TOPLEFT" relativeTo="PartyRow2Pet" relativePoint="BOTTOMLEFT"/></Anchors>
    </Frame>
  </Frame></Ui>`);
  assert.equal(loaded.ok, true);
  const textures = textureSource();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  const applied = [];
  const applyFrame = renderer.applyFrame.bind(renderer);
  renderer.applyFrame = (rendered) => {
    applied.push(rendered.frame.name);
    return applyFrame(rendered);
  };
  renderer.mount(loaded.roots);

  const row1 = findByName(host, "PartyRow1");
  const holder = findByName(host, "PartyRow1PetHolder");
  const pet1 = findByName(host, "PartyRow1Pet");
  const row2 = findByName(host, "PartyRow2");
  const pet2 = findByName(host, "PartyRow2Pet");
  const row3 = findByName(host, "PartyRow3");
  assert.ok(row1 && holder && pet1 && row2 && pet2 && row3);
  // A browser reports zero layout metrics and no offsetParent for a display:none subtree. Read
  // those hidden frames through their authored inline pixels and the DOM ancestor chain instead.
  Object.assign(row1, { offsetLeft: 0, offsetTop: 0, offsetWidth: 64, offsetHeight: 26,
    offsetParent: findByName(host, "Root") });
  Object.assign(row2, { offsetLeft: 23, offsetTop: 53, offsetWidth: 64, offsetHeight: 26,
    offsetParent: findByName(host, "Root") });
  Object.assign(row3, { offsetLeft: 23, offsetTop: 79, offsetWidth: 64, offsetHeight: 26,
    offsetParent: findByName(host, "Root") });
  const hiddenOffsetParent = (element, fallback) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden) return null;
    }
    return fallback;
  };
  Object.defineProperties(holder, {
    offsetLeft: { get: () => 0 },
    offsetTop: { get: () => 0 },
    offsetWidth: { get: () => 0 },
    offsetHeight: { get: () => 0 },
    offsetParent: { get: () => hiddenOffsetParent(holder, row1) },
  });
  Object.defineProperties(pet1, {
    offsetLeft: { get: () => 0 },
    offsetTop: { get: () => 0 },
    offsetWidth: { get: () => 0 },
    offsetHeight: { get: () => 0 },
    offsetParent: { get: () => hiddenOffsetParent(pet1, holder) },
  });
  Object.defineProperties(pet2, {
    offsetLeft: { get: () => 0 },
    offsetTop: { get: () => 0 },
    offsetWidth: { get: () => 0 },
    offsetHeight: { get: () => 0 },
    offsetParent: { get: () => hiddenOffsetParent(pet2, row2) },
  });
  const texture = findByName(host, "HiddenTexture");
  assert.ok(texture);
  assert.equal(pet1.style.left, "23px");
  assert.equal(pet1.style.top, "27px");
  assert.equal(pet1.style.width, "64px");
  assert.equal(pet1.style.height, "26px");
  assert.deepEqual(textures.acquired, ["first.blp"], "initial hidden texture lease is retained");
  applied.length = 0;
  textures.acquired.length = 0;
  textures.released.length = 0;

  const trackHiddenWrites = (element) => {
    let value = element.hidden;
    let writes = 0;
    Object.defineProperty(element, "hidden", {
      configurable: true,
      get: () => value,
      set: (next) => { writes += 1; value = Boolean(next); },
    });
    return () => writes;
  };
  const holderHiddenWrites = trackHiddenWrites(holder);
  const pet1HiddenWrites = trackHiddenWrites(pet1);
  const pet2HiddenWrites = trackHiddenWrites(pet2);

  bridge.touch();
  assert.equal(row2.style.left, "23px", "row 2 uses hidden pet's authored X");
  assert.equal(row2.style.top, "53px", "row 2 uses hidden pet's authored bottom edge");
  assert.equal(row3.style.left, "23px", "row 3 keeps the party column X");
  assert.equal(row3.style.top, "79px", "row 3 chains through the next hidden pet");
  assert.equal(holder.hidden, true);
  assert.equal(pet1.hidden, true);
  assert.equal(pet2.hidden, true);
  assert.equal(holderHiddenWrites(), 0, "hidden pet holder is never shown for measurement");
  assert.equal(pet1HiddenWrites(), 0, "hidden pet 1 is never shown for measurement");
  assert.equal(pet2HiddenWrites(), 0, "hidden pet 2 is never shown for measurement");
  assert.equal(applied.includes("PartyRow1Pet"), false, "hidden pet 1 is not repainted");
  assert.equal(applied.includes("PartyRow2Pet"), false, "hidden pet 2 is not repainted");
  assert.deepEqual(textures.acquired, []);
  assert.deepEqual(textures.released, []);
  assert.equal(texture.getAttribute("data-framexml-texture"), "first");
  renderer.destroy();
});

test("hidden bottom-anchored tabs keep their authored row through hidden sibling chains", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const loaded = bridge.loadAddon(`<Ui><Frame name="CharacterLikeFrame" hidden="true" width="400" height="500">
    <Button name="CharacterLikeTab1" width="100" height="32">
      <Anchors><Anchor point="BOTTOMLEFT"><Offset x="11" y="46"/></Anchor></Anchors>
    </Button>
    <Button name="CharacterLikeTab2" hidden="true" width="100" height="32">
      <Anchors><Anchor point="LEFT" relativeTo="CharacterLikeTab1" relativePoint="RIGHT">
        <Offset x="-15" y="0"/>
      </Anchor></Anchors>
    </Button>
    <Button name="CharacterLikeTab3" width="100" height="32">
      <Anchors><Anchor point="LEFT" relativeTo="CharacterLikeTab2" relativePoint="RIGHT">
        <Offset x="-15" y="0"/>
      </Anchor></Anchors>
    </Button>
    <Button name="CharacterLikeTab4" width="100" height="32">
      <Anchors><Anchor point="LEFT" relativeTo="CharacterLikeTab3" relativePoint="RIGHT">
        <Offset x="-15" y="0"/>
      </Anchor></Anchors>
    </Button>
  </Frame></Ui>`);
  assert.equal(loaded.ok, true);
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);

  const tab1 = findByName(host, "CharacterLikeTab1");
  const tab2 = findByName(host, "CharacterLikeTab2");
  const tab3 = findByName(host, "CharacterLikeTab3");
  const tab4 = findByName(host, "CharacterLikeTab4");
  assert.ok(tab1 && tab2 && tab3 && tab4);
  assert.equal(tab1.style.bottom, "46px", "the first tab keeps its stock bottom anchor");
  assert.equal(tab2.hidden, true, "the optional middle tab stays hidden while providing geometry");
  assert.deepEqual(
    [tab2.style.top, tab3.style.top, tab4.style.top],
    ["422px", "422px", "422px"],
    "every sibling resolves the hidden first tab's bottom edge to the same authored row",
  );
  assert.deepEqual(
    [tab2.style.left, tab3.style.left, tab4.style.left],
    ["96px", "181px", "266px"],
    "the hidden sibling participates in the horizontal tab chain",
  );
  renderer.destroy();
});
