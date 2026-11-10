import assert from "node:assert/strict";
import test from "node:test";
const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");
const { FrameXmlDomRenderer } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

// Plan item 4.04 (11.11): the DOM renderer keeps the indent GameTooltip:AddTexture gives a row through its TOPLEFT
// offset (glue/GlueTooltipTextures.ts, Wow.exe 0x0061c8b0), summed along the rows' anchor chain, while the tooltip
// lays its rows out as a grid. The DOM stub is the one of framexml-renderer-residuals.test.mjs.
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
      textContent: "",
      value: "",
      classList: { add() {} },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
          child.parentElement = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
        child.parentElement = node;
        const index = node.children.indexOf(before);
        node.children.splice(index < 0 ? node.children.length : index, 0, child);
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

test("a row moved right by AddTexture keeps that indent in the tooltip grid; the row below is back at 0", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const loaded = bridge.loadAddon(`<Ui><Frame name="UIParent" width="1024" height="768"><Frames>
    <GameTooltip name="IconTip" hidden="true"><Layers><Layer level="ARTWORK">
      <FontString name="$parentTextLeft1" hidden="true"/>
      <FontString name="$parentTextLeft2" hidden="true"/>
      <FontString name="$parentTextLeft3" hidden="true"/>
      <Texture name="$parentTexture1" hidden="true"><Size x="12" y="12"/></Texture>
    </Layer></Layers></GameTooltip>
  </Frames></Frame></Ui>`);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  bridge.setMeasure((frame) => renderer.measure(frame));
  renderer.mount(loaded.roots);
  const frame = (name) => bridge.getFrame(name);
  const element = (name) => renderer.elementFor(frame(name));
  bridge.runInMutationBatch(() => {
    bridge.SetPoint(frame("IconTipTextLeft1"), "TOPLEFT", frame("IconTip"), "TOPLEFT", 10, -10);
    bridge.SetPoint(frame("IconTipTextLeft2"), "TOPLEFT", frame("IconTipTextLeft1"), "BOTTOMLEFT", 18.4, -2);
    bridge.SetPoint(frame("IconTipTextLeft3"), "TOPLEFT", frame("IconTipTextLeft2"), "BOTTOMLEFT", -18.4, -2);
    bridge.ClearAllPoints(frame("IconTipTexture1"));
    bridge.SetPoint(frame("IconTipTexture1"), "TOPRIGHT", frame("IconTipTextLeft2"), "TOPLEFT", -6.4, 0);
    for (const [index, text] of [[1, "Волк"], [2, "100% угрозы"], [3, "Ниже"]]) {
      bridge.SetText(frame(`IconTipTextLeft${index}`), text);
      bridge.Show(frame(`IconTipTextLeft${index}`));
    }
    bridge.Show(frame("IconTipTexture1"));
    bridge.Show(frame("IconTip"));
  });
  assert.equal(element("IconTipTextLeft2").style.gridRow, "2");
  assert.equal(element("IconTipTextLeft2").style.marginLeft, "18.4px", "the icon's room");
  assert.equal(element("IconTipTextLeft1").style.marginLeft || undefined, undefined);
  assert.equal(element("IconTipTextLeft3").style.marginLeft || undefined, undefined, "18.4 − 18.4: back at the left edge");
  // ClearLines puts the row back: the indent goes.
  bridge.runInMutationBatch(() => {
    bridge.SetPoint(frame("IconTipTextLeft2"), "TOPLEFT", frame("IconTipTextLeft1"), "BOTTOMLEFT", 0, -2);
    bridge.SetPoint(frame("IconTipTextLeft3"), "TOPLEFT", frame("IconTipTextLeft2"), "BOTTOMLEFT", 0, 0);
    bridge.SetText(frame("IconTipTextLeft2"), "100% угрозы!");
    bridge.Hide(frame("IconTip"));
  });
  bridge.Show(frame("IconTip")); // the tooltip drawn again lays its rows out again
  assert.equal(element("IconTipTextLeft2").style.marginLeft || undefined, undefined);
  renderer.destroy();
});
