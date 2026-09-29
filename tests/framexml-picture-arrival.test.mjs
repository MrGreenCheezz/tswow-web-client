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

/** A texture source whose pictures arrive only when the test says so. */
function slowTextures() {
  const arrived = new Map();
  const edges = new Map();
  const refs = new Map();
  return {
    arrive(path) { arrived.set(path, `blob:${path}`); },
    arriveEdge(path) {
      edges.set(path, Object.fromEntries(["LEFT", "RIGHT", "TOP", "BOTTOM", "TOPLEFT", "TOPRIGHT", "BOTTOMLEFT", "BOTTOMRIGHT"]
        .map((piece) => [piece, `blob:${path}#${piece}`])));
    },
    refs,
    acquire(path) { refs.set(path, (refs.get(path) ?? 0) + 1); return arrived.get(path); },
    peek(path) { return arrived.get(path); },
    release(path) { refs.set(path, (refs.get(path) ?? 1) - 1); },
    acquireEdge(path) { return edges.get(path); },
    peekEdge(path) { return edges.get(path); },
    releaseEdge() {},
  };
}

async function setup() {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": `<Ui><Frame name="Root" width="1000" height="800">
      <Layers><Layer level="ARTWORK">
        <Texture name="IconA" file="Interface\\Icons\\A"><Size x="30" y="30"/></Texture>
        <Texture name="IconB" file="Interface\\Icons\\B"><Size x="30" y="30"/></Texture>
      </Layer></Layers>
      <Frames>
        <Frame name="Panel" width="200" height="200">
          <Backdrop bgFile="Interface\\Panel\\Bg" edgeFile="Interface\\Panel\\Edge"><EdgeSize val="16"/></Backdrop>
        </Frame>
        <Frame name="Window" width="100" height="100" hidden="true"><Layers><Layer level="ARTWORK">
          <Texture name="HiddenA" file="Interface\\Icons\\A"><Size x="10" y="10"/></Texture>
        </Layer></Layers></Frame>
      </Frames></Frame></Ui>`,
  }) });
  await boot.load();
  const textures = slowTextures();
  const renderer = new FrameXmlDomRenderer(fakeDocument().createElement("section"), { bridge: boot.bridge, textures });
  renderer.mount(boot.roots);
  const applied = [];
  const applyFrame = renderer.applyFrame.bind(renderer);
  renderer.applyFrame = (rendered, hidden) => { applied.push(rendered.frame.name); return applyFrame(rendered, hidden); };
  let syncs = 0;
  const syncPass = renderer.syncPass.bind(renderer);
  renderer.syncPass = () => { syncs++; return syncPass(); };
  const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
  return { boot, renderer, textures, applied, element, get syncs() { return syncs; },
    close() { renderer.destroy(); boot.close(); } };
}

test("an arriving picture is drawn on the drawn frames holding it, without a pass over the HUD", async () => {
  const fixture = await setup();
  try {
    const { renderer, textures, element } = fixture;
    assert.equal(element("IconA").getAttribute("src"), null, "nothing has arrived yet");
    textures.arrive("Interface\\Icons\\A.blp");
    renderer.pictureArrived("Interface\\Icons\\A.blp", "texture");
    assert.equal(element("IconA").getAttribute("src"), "blob:Interface\\Icons\\A.blp");
    assert.equal(element("IconB").getAttribute("src"), null, "another path is left alone");
    assert.equal(element("HiddenA").getAttribute("src"), null, "a hidden holder waits for its reveal");
    assert.deepEqual(fixture.applied, [], "no frame is re-applied in full");
    assert.equal(fixture.syncs, 0, "and no reconciliation pass runs");

    // The hidden holder takes the picture when it is shown.
    assert.equal(fixture.boot.vm.execute("Window:Show()", "@arrival").ok, true);
    assert.equal(element("HiddenA").getAttribute("src"), "blob:Interface\\Icons\\A.blp");

    // A path nobody holds any more is not drawn anywhere.
    assert.equal(fixture.boot.vm.execute("IconB:SetTexture('Interface\\\\Icons\\\\C')", "@arrival").ok, true);
    textures.arrive("Interface\\Icons\\B.blp");
    fixture.applied.length = 0;
    renderer.pictureArrived("Interface\\Icons\\B.blp", "texture");
    assert.equal(element("IconB").getAttribute("src"), null);
    assert.deepEqual(fixture.applied, []);
  } finally { fixture.close(); }
});

test("an arriving backdrop picture or edge file repaints only that backdrop", async () => {
  const fixture = await setup();
  try {
    const { renderer, textures, element } = fixture;
    const paint = (kind) => element("Panel").children.find((child) => child.getAttribute("data-framexml-backdrop-paint") === kind);
    assert.equal(paint("background").style.display, "none");
    textures.arrive("Interface\\Panel\\Bg.blp");
    renderer.pictureArrived("Interface\\Panel\\Bg.blp", "texture");
    assert.equal(paint("background").style.display, "block");
    assert.match(paint("background").style.backgroundImage, /blob:Interface\\Panel\\Bg\.blp/);
    textures.arriveEdge("Interface\\Panel\\Edge.blp");
    renderer.pictureArrived("Interface\\Panel\\Edge.blp", "edge");
    assert.equal(paint("edge").style.display, "block");
    assert.match(paint("edge").style.backgroundImage, /Edge\.blp#TOPLEFT/);
    assert.deepEqual(fixture.applied, []);
    assert.equal(fixture.syncs, 0);
  } finally { fixture.close(); }
});

test("a dropped holder leaves the picture index", async () => {
  const fixture = await setup();
  try {
    const { renderer, textures, element, boot } = fixture;
    const before = element("IconA");
    renderer.mount([]);
    textures.arrive("Interface\\Icons\\A.blp");
    renderer.pictureArrived("Interface\\Icons\\A.blp", "texture");
    assert.equal(before.getAttribute("src"), null, "an unmounted element is not painted");
    renderer.mount(boot.roots);
    assert.equal(element("IconA").getAttribute("src"), "blob:Interface\\Icons\\A.blp", "a remount takes what has arrived");
  } finally { fixture.close(); }
});
