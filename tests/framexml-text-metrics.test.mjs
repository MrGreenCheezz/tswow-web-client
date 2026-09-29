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
      style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
      dataset: {}, textContent: "", className: "", classList: { add() {} }, addEventListener() {},
      getContext(kind) { return kind === "2d" ? { font: "", measureText: (text) => ({ width: text.length * 8 }) } : null; },
      setAttribute(k, v) { attrs.set(k, String(v)); }, getAttribute(k) { return attrs.get(k) ?? null; }, removeAttribute(k) { attrs.delete(k); },
      append(...nodes) { for (const child of nodes) { child.remove(); child.parentElement = node; node.children.push(child); } },
      remove() { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node); },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

test("stock auto-width tab text stays intrinsic during OnLoad, resizing, and hidden rendering", async () => {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Tabs.xml",
    "interface/framexml/tabs.xml": '<Ui><Button name="Tab" text="Character" hidden="true"><Size x="1" y="32"/><ButtonText name="$parentText"><Size x="0" y="13"/><Anchors><Anchor point="BOTTOM" y="5"/></Anchors></ButtonText><Scripts><OnLoad>InitialTextWidth = TabText:GetWidth(); self:SetWidth(InitialTextWidth + 24)</OnLoad></Scripts></Button><FontString name="Wrapped" text="long wrapped text"><Size x="40" y="0"/></FontString></Ui>',
  }) });
  await boot.load();
  const doc = fakeDocument();
  const renderer = new FrameXmlDomRenderer(doc.createElement("section"), { bridge: boot.bridge });
  const run = (source) => { const r = boot.vm.execute(source, "@text-metrics"); assert.equal(r.ok, true, r.error); };
  try {
    assert.ok(boot.vm.getGlobal("InitialTextWidth") > 40, "OnLoad sees useful intrinsic text width before DOM exists");
    assert.ok(boot.bridge.measure(boot.bridge.getFrame("Tab")).width > 64);
    renderer.mount(boot.roots);
    const label = renderer.elementFor(boot.bridge.getFrame("TabText"));
    assert.notEqual(label.style.width, "0px");
    assert.equal(label.style.whiteSpace, "pre");
    assert.equal(renderer.elementFor(boot.bridge.getFrame("Wrapped")).style.whiteSpace, "pre-wrap");
    run('Tab:SetWidth(1); TabText:SetWidth(2); ButtonWidth = Tab:GetTextWidth(); StringWidth = TabText:GetStringWidth(); ClippedWidth = TabText:GetWidth(); TabText:SetWidth(0); AutoWidth = TabText:GetWidth()');
    assert.equal(boot.vm.getGlobal("ButtonWidth"), 72, "button text uses its FontString, never its resized box");
    assert.equal(boot.vm.getGlobal("StringWidth"), 72, "intrinsic width ignores clipping width");
    assert.equal(boot.vm.getGlobal("ClippedWidth"), 2);
    assert.equal(boot.vm.getGlobal("AutoWidth"), 72);
    run('Tab:SetText("|cffffcc00AB|r|nC"); MarkupWidth = Tab:GetTextWidth()');
    assert.equal(boot.vm.getGlobal("MarkupWidth"), 16, "escape bytes and other lines do not inflate glyph width");
  } finally { renderer.destroy(); boot.close(); }
});


test("an unrelated HUD mutation leaves settled anchor geometry intact", async () => {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Stable.xml",
    "interface/framexml/stable.xml": '<Ui><Frame name="Root" width="800" height="600"><Frames><Frame name="Panel" width="200" height="100"><Anchors><Anchor point="CENTER"/></Anchors><Layers><Layer><Texture name="Fill" setAllPoints="true"/><FontString name="Label" text="Ready"><Size x="0" y="14"/><Anchors><Anchor point="CENTER"/></Anchors></FontString></Layer></Layers></Frame></Frames></Frame></Ui>',
  }) });
  await boot.load();
  const doc = fakeDocument();
  const original = doc.createElement;
  const tracked = new Set(["left", "right", "top", "bottom", "width", "height", "transform"]);
  let geometryChanges = 0;
  doc.createElement = (tag) => {
    const node = original(tag);
    node.style = new Proxy(node.style, {
      set(style, key, value) { if (tracked.has(key) && style[key] !== value) geometryChanges++; style[key] = value; return true; },
      deleteProperty(style, key) { if (tracked.has(key) && style[key] !== undefined && style[key] !== "") geometryChanges++; delete style[key]; return true; },
    });
    return node;
  };
  const renderer = new FrameXmlDomRenderer(doc.createElement("section"), { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    geometryChanges = 0;
    boot.bridge.touch();
    assert.equal(geometryChanges, 0, "unchanged anchors must not clear and restore CSS between layout reads");
    const resized = boot.vm.execute('Panel:SetWidth(260)', "@stable-layout");
    assert.equal(resized.ok, true, resized.error);
    assert.equal(renderer.elementFor(boot.bridge.getFrame("Panel")).style.width, "260px");
    assert.ok(geometryChanges > 0, "a real Lua size change still updates the DOM");
  } finally { renderer.destroy(); boot.close(); }
});
