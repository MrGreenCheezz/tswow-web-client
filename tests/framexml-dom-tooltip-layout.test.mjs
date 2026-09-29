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
      textContent: "",
      classList: { add() {} },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) { child.parentElement = node; node.children.push(child); }
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

function tooltipBridge() {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const loaded = bridge.loadAddon(`<Ui><Frame name="UIParent" width="1024" height="768"><Frames>
    <GameTooltip name="LayoutTip" hidden="true"><Layers><Layer level="ARTWORK">
      <FontString name="$parentTextLeft1" hidden="true"/>
      <FontString name="$parentTextLeft2" hidden="true"/>
      <FontString name="$parentTextRight2" hidden="true"/>
      <FontString name="$parentTextLeft3" hidden="true"/>
      <FontString name="$parentTextLeft4" hidden="true"/>
    </Layer></Layers></GameTooltip>
  </Frames></Frame></Ui>`);
  assert.equal(loaded.ok, true);
  return { bridge, loaded, tip: bridge.getFrame("LayoutTip"), line: (name) => bridge.getFrame(`LayoutTip${name}`) };
}

test("tooltip rows: unwrapped lines never wrap, wrapped ones never widen, the box is its rows", () => {
  globalThis.document = fakeDocument();
  const { bridge, loaded, tip, line } = tooltipBridge();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const element = (name) => renderer.elementFor(line(name));
  const set = (name, text, wrap = false) => {
    bridge.update(line(name), (mutable) => mutable.setAttribute("wordWrap", String(wrap)));
    bridge.SetText(line(name), text);
    bridge.Show(line(name));
  };
  bridge.runInMutationBatch(() => {
    set("TextLeft1", "Боевой крик");
    set("TextLeft2", "SpellID:");
    set("TextRight2", "81830");
    set("TextLeft3", "Увеличивает силу атаки всех членов группы и рейда в радиусе 30 м на 550 ед.", true);
    bridge.update(tip, (mutable) => { mutable.tooltipMinimumWidth = 250; });
    bridge.Show(tip);
  });
  const root = renderer.elementFor(tip).style;
  assert.equal(root.display, "grid");
  assert.equal(root.width, "max-content", "the box is as wide as its widest unwrapped row");
  assert.equal(root.minWidth, "250px", "SetMinimumWidth is the floor");
  assert.equal(root.gridTemplateColumns, "auto auto",
    "no flexible track: an item spanning one would not size the box at all");
  for (const name of ["TextLeft1", "TextLeft2", "TextRight2"]) {
    assert.equal(element(name).style.whiteSpace, "pre", `${name} never wraps`);
    assert.equal(element(name).style.overflowWrap, "normal", `${name} never breaks inside a word`);
    assert.equal(element(name).style.minWidth, "0px");
  }
  assert.equal(element("TextLeft3").style.whiteSpace, "pre-wrap");
  assert.equal(element("TextLeft3").style.overflowWrap, "break-word");
  assert.equal(element("TextLeft3").style.maxWidth, "340px", "a wrapped line widens the box by at most the wrap width");
  assert.equal(element("TextLeft3").style.minWidth, "100%");
  assert.deepEqual([element("TextLeft2").style.gridColumn, element("TextRight2").style.gridColumn], ["1", "2"]);
  assert.equal(element("TextLeft1").style.gridColumn, "1 / -1");

  // A line still shown but emptied leaves the rows and gives its cell back.
  bridge.SetText(line("TextLeft3"), "");
  assert.equal(line("TextLeft3").visible, true);
  assert.equal(element("TextLeft3").style.gridRow, "");
  assert.equal(element("TextLeft3").style.position, "absolute");

  bridge.Hide(tip);
  assert.equal(renderer.elementFor(tip).style.display, undefined, "a hidden tooltip keeps no inline grid");
  renderer.destroy();
});

test("the laid-out tooltip size reaches GetWidth/GetHeight without another render pass", () => {
  globalThis.document = fakeDocument();
  const { bridge, loaded, tip, line } = tooltipBridge();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const tipElement = renderer.elementFor(tip);
  Object.defineProperties(tipElement, { offsetWidth: { get: () => 187.5 }, offsetHeight: { get: () => 64 } });
  bridge.update(tip, (mutable) => { mutable.setAttribute("width", "136"); mutable.setAttribute("height", "128"); });
  const syncs = [];
  bridge.subscribe(() => syncs.push(bridge.mutationVersion));
  bridge.runInMutationBatch(() => {
    bridge.SetText(line("TextLeft1"), "Тестовый");
    bridge.Show(line("TextLeft1"));
    bridge.Show(tip);
  });
  const version = tip.renderVersion;
  assert.equal(tip.attributes.width, "187.5");
  assert.equal(tip.attributes.height, "64");
  assert.deepEqual(bridge.measure(tip), { width: 187.5, height: 64 });
  assert.equal(syncs.length, 1, "writing the measured size back announced nothing");
  bridge.touch();
  assert.equal(tip.renderVersion, version, "and the next paint does not re-apply the tooltip for it");
  renderer.destroy();
});

test("a button label takes its HighlightFont under the pointer, in the page only", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Font name="TabNormal" font="Fonts\FRIZQT__.TTF"><FontHeight><AbsValue val="10"/></FontHeight><Color r="1" g="0.82" b="0"/></Font>
    <Font name="TabHighlight" font="Fonts\FRIZQT__.TTF"><FontHeight><AbsValue val="10"/></FontHeight><Color r="1" g="1" b="1"/></Font>
    <Button name="HoverTab" text="Репутация" width="90" height="32">
      <ButtonText name="$parentText"/>
      <NormalFont style="TabNormal"/>
      <HighlightFont style="TabHighlight"/>
    </Button>
  </Ui>`);
  assert.equal(loaded.ok, true);
  bridge.registerFontObjects();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const button = bridge.getFrame("HoverTab");
  const label = renderer.elementFor(bridge.getFrame("HoverTabText"));
  assert.equal(label.getAttribute("data-framexml-font"), "TabNormal");
  assert.equal(label.style.fontSize, "10px", "the label is drawn at the state font's size, not the host default");
  assert.equal(label.style.color, "rgba(255, 209, 0, 1)");
  const version = button.renderVersion;
  renderer.elementFor(button).dispatchEvent({ type: "pointerenter" });
  assert.equal(label.getAttribute("data-framexml-font"), "TabHighlight");
  assert.equal(label.style.color, "rgba(255, 255, 255, 1)");
  assert.equal(bridge.getFrame("HoverTabText").fontObject, "TabNormal", "Lua still sees the normal font object");
  renderer.elementFor(button).dispatchEvent({ type: "pointerleave" });
  assert.equal(label.getAttribute("data-framexml-font"), "TabNormal");
  assert.equal(button.renderVersion, version, "a hover restyles the label without a bridge mutation");
  renderer.destroy();
});

test("IsMouseOver's rectangle is read once between paints", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const loaded = bridge.loadAddon(`<Ui><Frame name="Screen" width="1024" height="768"><Frames>
    <Frame name="ChatBox" width="400" height="120"><Anchors><Anchor point="BOTTOMLEFT"><Offset x="20" y="100"/></Anchor></Anchors></Frame>
  </Frames></Frame></Ui>`);
  assert.equal(loaded.ok, true);
  const host = document.createElement("section");
  // The stage is drawn at half size inside a page offset by (80, 40).
  host.offsetWidth = 1024; host.offsetHeight = 768;
  host.getBoundingClientRect = () => ({ left: 80, top: 40, width: 512, height: 384, right: 592, bottom: 424 });
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  let reads = 0;
  renderer.elementFor(bridge.getFrame("ChatBox")).getBoundingClientRect = () => {
    reads += 1;
    // UI box 20..420 x (768-220)..(768-100) = 548..668 from the top, halved and offset.
    return { left: 80 + 10, right: 80 + 210, top: 40 + 274, bottom: 40 + 334, width: 200, height: 60 };
  };
  const chat = bridge.getFrame("ChatBox");
  bridge.setMousePosition(200, 150);
  assert.equal(bridge.isMouseOver(chat), true);
  bridge.setMousePosition(200, 250);
  assert.equal(bridge.isMouseOver(chat), false);
  assert.equal(bridge.isMouseOver(chat, 45, -10, -5, 5), true);
  assert.equal(reads, 1, "three questions, one layout read");
  bridge.touch();
  assert.equal(bridge.isMouseOver(chat, 45, -10, -5, 5), true);
  assert.equal(reads, 2, "a paint may have moved it, so the next question reads again");
  renderer.destroy();
});
