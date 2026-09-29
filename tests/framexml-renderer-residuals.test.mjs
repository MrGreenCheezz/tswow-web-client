import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");
const { FrameXmlDomRenderer } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

// Renderer residuals: a frame riding on a laid-out tooltip row, hit-rect insets, a text-sized string's
// width between SetText and the paint, the EditBox's left edge, a Button's own label, and a mounted
// root that Lua re-parents. A DOM stub whose nodes count every time they are appended somewhere.
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
      appended: 0,
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
          child.appended += 1;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
        child.parentElement = node;
        child.appended += 1;
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

function mounted(xml, options = {}) {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const loaded = bridge.loadAddon(xml);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  bridge.registerFontObjects?.();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, ...options });
  bridge.setMeasure((frame) => renderer.measure(frame));
  renderer.mount(options.roots?.(loaded.roots, bridge) ?? loaded.roots);
  const frame = (name) => bridge.getFrame(name);
  const element = (name) => renderer.elementFor(frame(name));
  return { bridge, renderer, host, frame, element, loaded };
}

test("a frame riding on a tooltip row is placed where the grid put the row", () => {
  const { bridge, renderer, frame, element } = mounted(`<Ui><Frame name="UIParent" width="1024" height="768"><Frames>
    <GameTooltip name="RideTip" hidden="true"><Layers><Layer level="ARTWORK">
      <FontString name="$parentTextLeft1" hidden="true"/>
      <FontString name="$parentTextLeft2" hidden="true"/>
      <FontString name="$parentTextLeft3" hidden="true"/>
    </Layer></Layers><Frames>
      <Frame name="$parentMoneyFrame1" hidden="true"><Size x="175" y="13"/>
        <Anchors><Anchor point="LEFT" relativeTo="$parentTextLeft3" relativePoint="LEFT" x="4" y="0"/></Anchors></Frame>
    </Frames></GameTooltip>
  </Frames></Frame></Ui>`);
  const tip = element("RideTip");
  Object.defineProperties(tip, { offsetWidth: { get: () => 220 }, offsetHeight: { get: () => 70 } });
  // A row reads its grid position once the tooltip has laid it out; until then it stands where its
  // own anchor chain stacked it, far below (the page measured y = 1617 against a row at 559).
  for (const index of [1, 2, 3]) {
    const row = element(`RideTipTextLeft${index}`);
    Object.defineProperties(row, {
      offsetParent: { get: () => tip },
      offsetLeft: { get: () => (row.style.gridRow ? 10 : 300) },
      offsetTop: { get: () => (row.style.gridRow ? 10 + (Number(row.style.gridRow) - 1) * 16 : 900) },
      offsetWidth: { get: () => 60 },
      offsetHeight: { get: () => 14 },
    });
  }
  bridge.runInMutationBatch(() => {
    for (const [index, text] of [[1, "Секира"], [2, "Двуручное"], [3, " "]]) {
      bridge.SetText(frame(`RideTipTextLeft${index}`), text);
      bridge.Show(frame(`RideTipTextLeft${index}`));
    }
    bridge.Show(frame("RideTipMoneyFrame1"));
    bridge.Show(frame("RideTip"));
  });
  const money = element("RideTipMoneyFrame1").style;
  assert.equal(element("RideTipTextLeft3").style.gridRow, "3");
  // Row 3 sits at 10 + 2 * 16 = 42, 14 tall: its LEFT point is (10, 49); the 13-unit frame centres on it.
  assert.equal(money.left, "14px", "four units right of the row's left edge");
  assert.equal(money.top, "42.5px", "centred on the row the grid laid out, not on its stale stack");
  renderer.destroy();
});

test("hit-rect insets hand the pointer to a private node that is cut in, or grown out", () => {
  const { bridge, renderer, frame, element } = mounted(`<Ui><Frame name="UIParent" width="1024" height="768"><Frames>
    <Frame name="Panel" enableMouse="true"><Size x="384" y="512"/>
      <HitRectInsets><AbsInset left="0" right="30" top="0" bottom="45"/></HitRectInsets>
      <Frames><Button name="PanelTab"><Size x="80" y="32"/></Button></Frames>
    </Frame>
    <CheckButton name="Check"><Size x="26" y="26"/>
      <HitRectInsets><AbsInset left="0" right="-100" top="0" bottom="0"/></HitRectInsets>
    </CheckButton>
    <Frame name="Art"><Size x="100" y="100"/>
      <HitRectInsets><AbsInset left="0" right="30" top="0" bottom="45"/></HitRectInsets>
    </Frame>
  </Frames></Frame></Ui>`);
  const hitNode = (name) => element(name).children.find((child) => child.getAttribute("data-framexml-hit-rect"));
  assert.equal(element("Panel").style.pointerEvents, "none", "the box itself no longer takes the pointer");
  const panelHit = hitNode("Panel");
  assert.ok(panelHit, "a private node does");
  assert.equal(element("Panel").children[0], panelHit, "below every authored child");
  assert.deepEqual([panelHit.style.left, panelHit.style.right, panelHit.style.top, panelHit.style.bottom, panelHit.style.pointerEvents],
    ["0px", "30px", "0px", "45px", "auto"]);
  assert.equal(element("PanelTab").style.pointerEvents, "auto", "a child frame keeps its own hit box, strip or not");
  assert.equal(hitNode("Check").style.right, "-100px", "a check button's hit box grows over its label");
  assert.equal(element("Check").style.pointerEvents, "none");
  assert.equal(hitNode("Art"), undefined, "a frame that takes no pointer gets no hit node");
  assert.equal(element("Art").style.pointerEvents, "none");

  // SetHitRectInsets(0, 0, 0, 0): the whole box again.
  bridge.update(frame("Panel"), (mutable) => { mutable.hitRectInsets = { left: 0, right: 0, top: 0, bottom: 0 }; }, "paint");
  assert.equal(element("Panel").style.pointerEvents, "auto");
  assert.equal(panelHit.style.display, "none");
  bridge.update(frame("Panel"), (mutable) => { mutable.hitRectInsets = { left: 5, right: 6, top: 7, bottom: 8 }; }, "paint");
  assert.deepEqual([panelHit.style.display, panelHit.style.left, panelHit.style.bottom], ["", "5px", "8px"]);
  assert.equal(element("Panel").children.filter((child) => child.getAttribute("data-framexml-hit-rect")).length, 1, "one node, reused");
  renderer.destroy();
});

test("a string sized by its text answers its new width before the next paint", () => {
  const { bridge, renderer, frame, element } = mounted(`<Ui><Frame name="UIParent" width="1024" height="768"><Frames>
    <Frame name="Box"><Size x="400" y="30"/><Layers><Layer level="ARTWORK">
      <FontString name="$parentHeader" text="Сказать: "><Anchors><Anchor point="LEFT" x="15" y="0"/></Anchors></FontString>
      <FontString name="$parentSpan" text="Сказать: "><Anchors>
        <Anchor point="LEFT" x="15" y="0"/><Anchor point="RIGHT" x="-15" y="0"/>
      </Anchors></FontString>
    </Layer></Layers></Frame>
  </Frames></Frame></Ui>`);
  // The page lays a string out 6 units a character; the bridge's own fallback measure is another rule.
  for (const name of ["BoxHeader", "BoxSpan"]) {
    const node = element(name);
    Object.defineProperties(node, {
      offsetWidth: { get: () => (name === "BoxSpan" ? 370 : node.textContent.length * 6) },
      offsetHeight: { get: () => 12 },
    });
  }
  const header = frame("BoxHeader");
  assert.equal(bridge.measure(header).width, 54, "painted: the page's width");
  let pending;
  let spanPending;
  bridge.runInMutationBatch(() => {
    bridge.SetText(header, "Шепнуть Bob: ");
    bridge.SetText(frame("BoxSpan"), "Шепнуть Bob: ");
    pending = bridge.measure(header).width;
    spanPending = bridge.measure(frame("BoxSpan")).width;
  });
  assert.notEqual(pending, 54, "not the width of the text the page still showed");
  assert.equal(pending, bridge.measureText(header), "the new string's own width");
  assert.equal(spanPending, 370, "a string pinned on both sides is as wide as its anchors, whatever its text");
  assert.equal(bridge.measure(header).width, 13 * 6, "painted again: the page's width");
  renderer.destroy();
});

test("an EditBox starts its text at the left edge and draws its text insets", () => {
  const { bridge, renderer, frame, element } = mounted(`<Ui><Frame name="UIParent" width="1024" height="768"><Frames>
    <EditBox name="ChatBox"><Size x="400" y="32"/><TextInsets><AbsInset left="12"/></TextInsets></EditBox>
    <EditBox name="CentredBox"><Size x="100" y="32"/><FontString justifyH="CENTER"/></EditBox>
  </Frames></Frame></Ui>`);
  assert.equal(frame("ChatBox").justifyH, "LEFT", "the client's EditBox default");
  assert.equal(element("ChatBox").style.textAlign, "left");
  assert.equal(frame("CentredBox").justifyH, "CENTER", "a declared justification still wins");
  bridge.update(frame("ChatBox"), (mutable) => { mutable.textInsets = { left: 64, right: 13, top: 0, bottom: 0 }; });
  const input = element("ChatBox").children.find((child) => child.getAttribute("data-framexml-input"));
  assert.equal(input.style.padding, "0px 13px 0px 64px");
  renderer.destroy();
});

test("a button's own text spans the button and follows its state font's justification", () => {
  const { bridge, renderer, frame, element } = mounted(String.raw`<Ui>
    <Font name="MenuFont" font="Fonts\FRIZQT__.TTF" justifyH="LEFT"><FontHeight><AbsValue val="12"/></FontHeight></Font>
    <Frame name="UIParent" width="1024" height="768"><Frames>
      <Button name="MenuButton1"><Size x="128" y="16"/><NormalFont style="MenuFont"/></Button>
      <Button name="Sizeless"><NormalFont style="MenuFont"/></Button>
    </Frames></Frame></Ui>`);
  bridge.registerFontObjects();
  bridge.SetText(frame("MenuButton1"), "Сказать");
  bridge.SetText(frame("Sizeless"), "Текст");
  const label = element("MenuButton1").children.find((child) => child.getAttribute("data-framexml-label"));
  assert.equal(label.textContent, "Сказать");
  assert.equal(label.style.textAlign, "left", "the font's justification, not the button's centred default");
  assert.deepEqual([label.style.position, label.style.inset, label.style.justifyContent, label.style.alignItems],
    ["absolute", "0", "flex-start", "center"], "across the whole button, vertically centred");
  const sizeless = element("Sizeless").children.find((child) => child.getAttribute("data-framexml-label"));
  // In flow (not absolute), and `relative` only so its OVERLAY z-index stacks it over the button's art.
  assert.equal(sizeless.style.position, "relative", "a button with no width keeps its label in flow");
  assert.equal(sizeless.style.textAlign, "left");
  renderer.destroy();
});

test("a mounted root that Lua gives a drawn parent is placed by that parent alone", () => {
  const { bridge, renderer, host, frame, element } = mounted(`<Ui>
    <Frame name="Dock"><Size x="300" y="30"/></Frame>
    <Button name="Tab"><Size x="60" y="30"/></Button>
    <Frame name="Undrawn"><Size x="10" y="10"/></Frame>
    <Button name="Orphan"><Size x="60" y="30"/></Button>
  </Ui>`, { roots: (roots, bridge) => roots.filter((root) => root !== bridge.getFrame("Undrawn")) });
  const tab = element("Tab");
  assert.equal(tab.parentElement, host);
  // FCF_DockFrame: the tab moves into the dock after the mount.
  bridge.SetParent(frame("Tab"), frame("Dock"));
  assert.equal(tab.parentElement, element("Dock"));
  const appended = tab.appended;
  for (let pass = 0; pass < 5; pass += 1) {
    bridge.touch();
    bridge.update(frame("Dock"), (mutable) => { mutable.alpha = pass % 2 ? 1 : 0.5; }, "paint");
  }
  assert.equal(tab.parentElement, element("Dock"), "still in the dock after every kind of pass");
  assert.equal(tab.appended, appended, "and never moved out and back: no DOM churn per sync");

  // A root whose new parent is not drawn here stays a root and keeps being drawn.
  bridge.SetParent(frame("Orphan"), frame("Undrawn"));
  bridge.touch();
  assert.equal(element("Orphan")?.parentElement, host);
  renderer.destroy();
});
