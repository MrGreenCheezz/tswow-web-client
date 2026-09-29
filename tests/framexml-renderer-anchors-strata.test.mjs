import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// Anchor and strata semantics of the bridge and the DOM renderer (wave 3, lane RC): one anchor per
// point, strata inherited from the parent, mixed parent/sibling anchor pairs, hidden targets
// measured where they are laid out, single-line strings truncated, dependents re-placed through
// the reverse anchor index, and strata layers for frames drawn above their ancestors' strata.

/**
 * A DOM stub with just enough layout for anchor arithmetic: an element's offset box is its inline
 * pixel geometry inside its parent (`0%`, `auto` and other non-pixel values count as 0), hidden
 * elements have no box and no offset parent (as in a browser), and the container ends the chain.
 * Elements keep their listeners (`dispatch` delivers an event object to them) and the document
 * tracks the focused element, which is all the edit-box keys need.
 */
function layoutDocument() {
  const doc = {
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
    getElementById: () => null,
    activeElement: null,
  };
  const pixels = (value) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? ""));
    return match ? Number(match[1]) : undefined;
  };
  const hiddenUp = (node) => {
    for (let current = node; current; current = current.parentElement) if (current.hidden) return true;
    return false;
  };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const node = {
      ownerDocument: doc,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: null,
      hidden: false,
      textContent: "",
      dataset: {},
      className: "",
      container: false,
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) {
          delete this[name];
          delete this[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
        },
      },
      classList: { add() {} },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      /** Deliver one event object to this element's own listeners (no bubbling). */
      dispatch(type, event = {}) {
        for (const listener of listeners.get(type) ?? []) listener(event);
        return event;
      },
      focus() {
        if (doc.activeElement === node) return;
        const previous = doc.activeElement;
        doc.activeElement = node;
        previous?.dispatch("blur");
        node.dispatch("focus");
      },
      blur() {
        if (doc.activeElement !== node) return;
        doc.activeElement = null;
        node.dispatch("blur");
      },
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
      get offsetParent() { return node.container || hiddenUp(node) ? null : node.parentElement; },
      get offsetLeft() { return hiddenUp(node) ? 0 : box(node, "left", "right", "width") ?? 0; },
      get offsetTop() { return hiddenUp(node) ? 0 : box(node, "top", "bottom", "height") ?? 0; },
      get offsetWidth() { return hiddenUp(node) ? 0 : size(node, "left", "right", "width") ?? 0; },
      get offsetHeight() { return hiddenUp(node) ? 0 : size(node, "top", "bottom", "height") ?? 0; },
    };
    return node;
  }
  // The lengths the renderer writes for parent anchors: `12px`, `50%`, `calc(P% + Npx)`.
  function length(value, base) {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    const direct = pixels(text);
    if (direct !== undefined) return direct;
    const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(text);
    if (percent) return base === undefined ? undefined : Number(percent[1]) * base / 100;
    const calc = /^calc\((-?\d+(?:\.\d+)?)% ([+-]) (-?\d+(?:\.\d+)?)px\)$/.exec(text);
    if (calc && base !== undefined) return Number(calc[1]) * base / 100 + (calc[2] === "+" ? 1 : -1) * Number(calc[3]);
    return undefined;
  }
  function parentSize(node, axis) {
    const parent = node.parentElement;
    return parent ? (axis === "width" ? parent.offsetWidth : parent.offsetHeight) : undefined;
  }
  function size(node, start, end, axis) {
    const declared = pixels(node.style[axis]);
    if (declared !== undefined) return declared;
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    const to = length(node.style[end], base);
    if (from !== undefined && to !== undefined && base !== undefined) return base - from - to;
    // A text span with no height of its own is one line tall, as a browser lays it out.
    if (axis === "height" && node.tagName === "SPAN" && node.textContent) {
      return pixels(node.style.fontSize ?? node.style["font-size"]);
    }
    return undefined;
  }
  function box(node, start, end, axis) {
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    if (from !== undefined) return from;
    const to = length(node.style[end], base);
    const own = size(node, start, end, axis) ?? 0;
    return to !== undefined && base !== undefined ? base - to - own : undefined;
  }
  doc.head = make("head");
  return doc;
}

async function boot(files, { render = true, view, hostSize } = {}) {
  const loaded = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": Object.keys(files).map((name) => name.replace("interface/framexml/", "")).join("\n"),
    ...files,
  }) });
  await loaded.load();
  if (!render) return { boot: loaded, close: () => loaded.close() };
  const doc = layoutDocument();
  if (view) doc.defaultView = view;
  const host = doc.createElement("section");
  host.container = true;
  if (hostSize) Object.assign(host.style, { width: `${hostSize[0]}px`, height: `${hostSize[1]}px` });
  const renderer = new FrameXmlDomRenderer(host, { bridge: loaded.bridge });
  renderer.mount(loaded.roots);
  return {
    boot: loaded,
    renderer,
    host,
    doc,
    element: (name) => renderer.elementFor(loaded.bridge.getFrame(name)),
    lua(code, results = 1) {
      const fn = loaded.vm.compileFunction(code, "rc-test", []);
      assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
      try { return loaded.vm.call(fn, [], results); } finally { loaded.vm.release(fn); }
    },
    close() { renderer.destroy(); loaded.close(); },
  };
}

function luaOf(loaded) {
  return (code, results = 1) => {
    const fn = loaded.vm.compileFunction(code, "rc-test", []);
    assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
    try { return loaded.vm.call(fn, [], results); } finally { loaded.vm.release(fn); }
  };
}

test("an instance's <Anchor> replaces its template's anchor with the same point, as SetPoint does", async () => {
  const { boot: loaded, close } = await boot({
    "interface/framexml/frames.xml": `<Ui>
      <Frame name="Screen"><Size x="1024" y="768"/></Frame>
      <Frame name="FloatTemplate" virtual="true"><Size x="430" y="120"/>
        <Anchors><Anchor point="BOTTOMLEFT"><Offset><AbsDimension x="100" y="100"/></Offset></Anchor>
          <Anchor point="TOP" relativeTo="LateTarget"/></Anchors></Frame>
      <Frame name="Float1" inherits="FloatTemplate" parent="Screen">
        <Anchors><Anchor point="BOTTOMLEFT"><Offset><AbsDimension x="32" y="95"/></Offset></Anchor>
          <Anchor point="TOP" relativeTo="Screen" y="-5"/></Anchors></Frame>
      <Frame name="LateTarget" parent="Screen"><Size x="10" y="10"/></Frame>
    </Ui>`,
  }, { render: false });
  try {
    const lua = luaOf(loaded);
    // ChatFrame1's shape: template BOTTOMLEFT 100,100 + its own BOTTOMLEFT 32,95; a template anchor
    // whose target is declared later is replaced as well and not re-pointed afterwards.
    assert.deepEqual(lua(`local out = {} for i = 1, Float1:GetNumPoints() do
      local p, rel, rp, x, y = Float1:GetPoint(i) out[#out + 1] = p .. ">" .. rel:GetName() .. ":" .. rp .. ":" .. x .. "," .. y end
      return table.concat(out, " ")`), ["BOTTOMLEFT>Screen:BOTTOMLEFT:32,95 TOP>Screen:TOP:0,-5"]);
    lua(`Float1:SetPoint("BOTTOMLEFT", Screen, "BOTTOMLEFT", 32, 115)`, 0);
    assert.deepEqual(lua("return Float1:GetNumPoints(), Float1:GetBottom()", 2), [2, 115]);
  } finally { close(); }
});

test("a frame that declares no strata is in its parent's; a declared strata stays its own", async () => {
  const { boot: loaded, close } = await boot({
    "interface/framexml/frames.xml": `<Ui>
      <Frame name="Dock" frameStrata="LOW"><Frames>
        <Button name="DockTab"><Frames><Frame name="DockTabGlow"/></Frames></Button>
        <Frame name="DockPopup" frameStrata="DIALOG"><Frames><Frame name="DockPopupInner"/></Frames></Frame>
      </Frames></Frame>
      <Frame name="Loose"/>
    </Ui>`,
    "interface/framexml/frames.lua": `Created = CreateFrame("Frame", "Created", DockPopup)`,
  }, { render: false });
  try {
    assert.deepEqual(luaOf(loaded)(`return DockTab:GetFrameStrata(), DockTabGlow:GetFrameStrata(), DockPopup:GetFrameStrata(),
      DockPopupInner:GetFrameStrata(), Created:GetFrameStrata(), Loose:GetFrameStrata()`, 6),
    ["LOW", "LOW", "DIALOG", "DIALOG", "DIALOG", "MEDIUM"]);
  } finally { close(); }
});

const LIST_ROW = `<Ui>
  <Font name="RowFont" font="Fonts\\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="12"/></FontHeight></Font>
  <Font name="SmallFont" font="Fonts\\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="10"/></FontHeight></Font>
  <Frame name="Panel"><Size x="400" y="300"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
    <Frame name="Row"><Size x="295" y="16"/><Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="20" y="-40"/></Offset></Anchor></Anchors>
      <Layers><Layer level="ARTWORK">
        <FontString name="RowLevel" inherits="RowFont" justifyH="LEFT" text="(57 - 67)"><Size x="60" y="16"/>
          <Anchors><Anchor point="RIGHT"/></Anchors></FontString>
        <FontString name="RowName" inherits="RowFont" justifyH="LEFT" text="Бастионы Адского Пламени"><Size x="0" y="16"/>
          <Anchors><Anchor point="LEFT"><Offset><AbsDimension x="40" y="0"/></Offset></Anchor>
            <Anchor point="RIGHT" relativeTo="RowLevel" relativePoint="LEFT"><Offset><AbsDimension x="-10" y="0"/></Offset></Anchor>
          </Anchors></FontString>
        <Texture name="RowLock" hidden="true"><Size x="12" y="14"/>
          <Anchors><Anchor point="LEFT"><Offset><AbsDimension x="25" y="0"/></Offset></Anchor></Anchors></Texture>
        <FontString name="RowOneLine" inherits="SmallFont" justifyH="RIGHT" text="Случайное подземелье Burning Crusade"><Size x="155" y="10"/>
          <Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
        <FontString name="RowParagraph" inherits="SmallFont" text="a paragraph that wraps"><Size x="155" y="0"/>
          <Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
      </Layer></Layers>
      <Frames><CheckButton name="RowCheck"><Size x="20" y="20"/>
        <Anchors><Anchor point="CENTER" relativeTo="RowLock" relativePoint="CENTER"/></Anchors></CheckButton></Frames>
    </Frame>
  </Frames></Frame>
</Ui>`;

test("a LEFT(parent) + RIGHT(sibling) pair spans between them, and a hidden target is measured where it is laid out", async () => {
  const { element, close } = await boot({ "interface/framexml/frames.xml": LIST_ROW });
  try {
    const name = element("RowName").style;
    // Row 295 wide, level 60 wide at its RIGHT: the name runs from 40 to 295 - 60 - 10 = 225.
    assert.equal(name.left, "40px");
    assert.equal(name.right, "calc(100% - 225px)");
    assert.equal(name.width, undefined, "the containing block solves the width between the two edges");
    assert.ok(!/translate/.test(name.transform ?? ""), `no centring translate left over: ${name.transform}`);
    // Both anchors are vertically centred on the row (the level text is centred on it too).
    assert.equal(name.top, "0px");
    // The lock icon is hidden: LEFT at 25 on a 16-high row is `top: 50%` and a -50% translate, so
    // its centre is (31, 8), and the 20x20 check box centred on it sits at (21, -2) — not at
    // `top: -10px`, the hidden element's zero offset.
    const check = element("RowCheck").style;
    assert.equal(check.left, "21px");
    assert.equal(check.top, "-2px");
  } finally { close(); }
});

test("the bridge honours a second anchor: GetLeft/GetRight/GetWidth of a string pinned between two edges", async () => {
  const { boot: loaded, close } = await boot({ "interface/framexml/frames.xml": LIST_ROW }, { render: false });
  try {
    assert.deepEqual(luaOf(loaded)(`return RowName:GetLeft() - Row:GetLeft(), RowLevel:GetLeft() - RowName:GetRight(),
      RowName:GetWidth(), RowName:GetRight() - RowName:GetLeft()`, 4), [40, 10, 185, 185]);
  } finally { close(); }
});

test("a string whose box holds one line never wraps and ends in an ellipsis at its width", async () => {
  const { element, close } = await boot({ "interface/framexml/frames.xml": LIST_ROW });
  try {
    const oneLine = element("RowOneLine").style;
    assert.deepEqual([oneLine.whiteSpace, oneLine.overflowX, oneLine.textOverflow], ["pre", "clip", "ellipsis"],
      "UIDropDownMenu's 155x10 text in a 10-point font");
    const spanned = element("RowName").style;
    assert.deepEqual([spanned.whiteSpace, spanned.overflowX, spanned.textOverflow], ["pre", "clip", "ellipsis"],
      "a name spanned by two anchors stops at the level column");
    const paragraph = element("RowParagraph").style;
    assert.deepEqual([paragraph.whiteSpace, paragraph.overflowX ?? "", paragraph.textOverflow ?? ""], ["pre-wrap", "", ""],
      "a width with no height still wraps and grows");
  } finally { close(); }
});

const CHAIN = `<Ui>
  <Frame name="Strip"><Size x="600" y="40"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
    <Frame name="TabA"><Size x="50" y="20"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
    <Frame name="TabC"><Size x="30" y="20"/><Anchors><Anchor point="LEFT" relativeTo="TabB" relativePoint="RIGHT"/></Anchors></Frame>
    <Frame name="TabB"><Size x="40" y="20"/><Anchors><Anchor point="LEFT" relativeTo="TabA" relativePoint="RIGHT"/></Anchors></Frame>
    <Frame name="Unrelated"><Size x="10" y="10"/><Anchors><Anchor point="BOTTOMRIGHT"/></Anchors></Frame>
  </Frames></Frame>
</Ui>`;

test("a resized anchor target re-places its dependents in the same sync, in anchor order, and nothing else", async () => {
  const { boot: loaded, renderer, element, lua, close } = await boot({ "interface/framexml/frames.xml": CHAIN });
  try {
    assert.equal(element("TabB").style.left, "50px");
    assert.equal(element("TabC").style.left, "90px");
    const placed = [];
    const original = Object.getPrototypeOf(renderer).applyGeometry;
    Object.getPrototypeOf(renderer).applyGeometry = function (element, frame, ...rest) {
      placed.push(frame.name);
      return original.call(this, element, frame, ...rest);
    };
    try {
      // ChatFrame1Tab auto-sizing to its label after ChatFrame2Tab was put at its RIGHT. TabC was
      // created before TabB, so re-placing in creation order would measure TabB where it was.
      lua("TabA:SetWidth(80)", 0);
      assert.equal(element("TabB").style.left, "80px");
      assert.equal(element("TabC").style.left, "120px", "the second link of the chain follows in the same sync");
      placed.length = 0;
      lua("Unrelated:SetWidth(20)", 0);
      assert.deepEqual(placed.filter((name) => name === "TabB" || name === "TabC"), [],
        "a layout change elsewhere re-places no dependent");
      assert.ok(placed.includes("Unrelated"));
    } finally {
      Object.getPrototypeOf(renderer).applyGeometry = original;
    }
    assert.equal(loaded.errorCount, 0);
  } finally { close(); }
});

test("a hidden anchor chain is refreshed once per pass, however many paths lead through it", async () => {
  // Each hidden link anchors twice to the one before it (TOPLEFT to its TOPRIGHT, BOTTOMLEFT to its
  // BOTTOMRIGHT): 2^N paths from the visible dependent down to the first link.
  const links = 14;
  const hidden = Array.from({ length: links }, (_, index) => index === 0
    ? `<Frame name="Link0"><Size x="5" y="5"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>`
    : `<Frame name="Link${index}"><Size x="5" y="5"/><Anchors>
        <Anchor point="TOPLEFT" relativeTo="Link${index - 1}" relativePoint="TOPRIGHT"/>
        <Anchor point="BOTTOMLEFT" relativeTo="Link${index - 1}" relativePoint="BOTTOMRIGHT"/></Anchors></Frame>`).join("");
  const { renderer, element, lua, close } = await boot({ "interface/framexml/frames.xml": `<Ui>
    <Frame name="Holder" hidden="true"><Size x="400" y="40"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>${hidden}</Frames></Frame>
    <Frame name="Follower"><Size x="10" y="10"/><Anchors><Anchor point="LEFT" relativeTo="Link${links - 1}" relativePoint="RIGHT"/></Anchors></Frame>
  </Ui>` });
  try {
    assert.equal(element("Follower").style.left, `${links * 5}px`, "measured through the hidden chain");
    let placements = 0;
    const original = Object.getPrototypeOf(renderer).applyGeometry;
    Object.getPrototypeOf(renderer).applyGeometry = function (...args) {
      placements += 1;
      return original.apply(this, args);
    };
    try {
      lua("Follower:SetHeight(12)", 0);
    } finally {
      Object.getPrototypeOf(renderer).applyGeometry = original;
    }
    assert.ok(placements <= 4 * links, `${placements} placements for a ${links}-link chain`);
    assert.equal(element("Follower").style.left, `${links * 5}px`);
  } finally { close(); }
});

const STRATA = `<Ui>
  <Frame name="Root" frameStrata="MEDIUM"><Size x="800" y="600"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
    <Frame name="Eye" frameStrata="LOW"><Size x="100" y="100"/>
      <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-20"/></Offset></Anchor></Anchors><Frames>
      <Frame name="Status" frameStrata="TOOLTIP"><Size x="50" y="20"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
      <Frame name="EyeGlow"><Size x="10" y="10"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
    </Frames></Frame>
    <Frame name="PlayerBox" frameStrata="BACKGROUND"><Size x="100" y="50"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
      <Frame name="PetBox" frameStrata="LOW"><Size x="40" y="20"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
    </Frames></Frame>
  </Frames></Frame>
  <Frame name="Menu" frameStrata="FULLSCREEN_DIALOG"><Size x="50" y="50"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
</Ui>`;

test("a frame above every stacking context around it is drawn in a strata layer over its parent's box", async () => {
  const { boot: loaded, host, element, lua, close } = await boot({ "interface/framexml/frames.xml": STRATA });
  try {
    const status = element("Status");
    const layer = status.parentElement;
    assert.equal(layer.getAttribute("data-framexml-strata-layer"), "Status");
    assert.equal(layer.parentElement, host, "a container-level box, beside the roots");
    assert.equal(layer.style.zIndex, "8000", "TOOLTIP's own z-index, above the FULLSCREEN_DIALOG root's 7000");
    assert.equal(element("Menu").style.zIndex, "7000");
    // Laid over Eye's box: (10, 20) inside Root at the origin, 100x100 in Eye's own units.
    assert.deepEqual([layer.style.left, layer.style.top, layer.style.width, layer.style.height], ["10px", "20px", "100px", "100px"]);
    assert.equal(layer.hidden, false);
    // Lua sees no change of parent, and a child in the parent's own strata stays inside it.
    assert.deepEqual(lua("return Status:GetParent():GetName(), EyeGlow:GetFrameStrata()", 2), ["Eye", "LOW"]);
    assert.equal(element("EyeGlow").parentElement, element("Eye"));
    // PetFrame under PlayerFrame under UIParent: LOW is above its BACKGROUND parent but not above
    // the MEDIUM root around both, so it stays inside its parent, above the parent's own art.
    assert.equal(element("PetBox").parentElement, element("PlayerBox"));
    // The layer hides, fades and moves with its owner.
    lua("Eye:Hide()", 0);
    assert.equal(layer.hidden, true);
    lua("Eye:Show() Eye:SetAlpha(0.5) Eye:SetPoint('TOPLEFT', Root, 'TOPLEFT', 30, -40)", 0);
    assert.equal(layer.hidden, false);
    assert.equal(layer.style.opacity, "0.5");
    assert.deepEqual([layer.style.left, layer.style.top], ["30px", "40px"]);
    lua("Root:Hide()", 0);
    assert.equal(layer.hidden, true, "a hidden ancestor hides the layer as well");
    lua("Root:Show()", 0);
    assert.equal(layer.hidden, false);
    // A strata raised or lowered at run time moves the element into or out of a layer.
    lua("EyeGlow:SetFrameStrata('DIALOG')", 0);
    assert.equal(element("EyeGlow").parentElement.getAttribute("data-framexml-strata-layer"), "EyeGlow");
    lua("EyeGlow:SetFrameStrata('LOW')", 0);
    assert.equal(element("EyeGlow").parentElement, element("Eye"));
    assert.equal(host.children.filter((child) => child.getAttribute("data-framexml-strata-layer") === "EyeGlow").length, 0,
      "the emptied layer is removed");
    assert.equal(loaded.errorCount, 0);
  } finally { close(); }
});

/** A window whose `ResizeObserver` the test drives: `resized()` reports every observed box. */
function resizableView() {
  const observers = new Set();
  class ResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.target = target; observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  return {
    ResizeObserver,
    observers,
    addEventListener() {},
    removeEventListener() {},
    resized() { for (const observer of [...observers]) observer.callback([{ target: observer.target }], observer); },
  };
}

// MultiBarBottomLeft's shape: a HIGH bar under a MEDIUM screen root (so in a strata layer), anchored
// to a bar the screen places by its right edge.
const RESIZE = `<Ui>
  <Frame name="Screen" frameStrata="MEDIUM"><Anchors><Anchor point="TOPLEFT"/><Anchor point="BOTTOMRIGHT"/></Anchors><Frames>
    <Frame name="MainBar"><Size x="200" y="40"/><Anchors><Anchor point="BOTTOMRIGHT"/></Anchors></Frame>
    <Frame name="ExtraBar" frameStrata="HIGH"><Size x="100" y="20"/>
      <Anchors><Anchor point="BOTTOMLEFT" relativeTo="MainBar" relativePoint="TOPLEFT"/></Anchors></Frame>
  </Frames></Frame>
</Ui>`;

test("a container resize re-places strata layers and measured anchors without a Lua mutation", async () => {
  const view = resizableView();
  const { boot: loaded, renderer, host, element, close } = await boot({ "interface/framexml/frames.xml": RESIZE },
    { view, hostSize: [1000, 600] });
  try {
    const bar = element("ExtraBar");
    const layer = bar.parentElement;
    assert.equal(layer.getAttribute("data-framexml-strata-layer"), "ExtraBar");
    assert.equal(layer.style.width, "1000px");
    assert.equal(bar.style.left, "800px", "at MainBar's left, 200 from the screen's right edge");
    assert.equal(view.observers.size, 1, "the container is observed");
    // The browser, or the UI scale, gives the stage a new logical width. No sync runs.
    host.style.width = "1400px";
    const version = loaded.bridge.mutationVersion;
    view.resized();
    assert.equal(loaded.bridge.mutationVersion, version, "nothing was mutated in Lua");
    assert.equal(layer.style.width, "1400px", "the layer is laid over the resized owner again");
    assert.equal(bar.style.left, "1200px", "the measured anchor follows MainBar");
    // An observation of an unchanged box (the observer's first report) places nothing.
    let placements = 0;
    const original = Object.getPrototypeOf(renderer).applyGeometry;
    Object.getPrototypeOf(renderer).applyGeometry = function (...args) {
      placements += 1;
      return original.apply(this, args);
    };
    try {
      view.resized();
    } finally {
      Object.getPrototypeOf(renderer).applyGeometry = original;
    }
    assert.equal(placements, 0);
  } finally { close(); }
  assert.equal(view.observers.size, 0, "destroy disconnects the observer");
});

const LETTER = `<Ui>
  <Frame name="Letter"><Size x="300" y="200"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
    <EditBox name="LetterBody" multiLine="true" autoFocus="false"><Size x="280" y="150"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
      <Scripts><OnEscapePressed>BodyEscapes = (BodyEscapes or 0) + 1 self:ClearFocus()</OnEscapePressed></Scripts></EditBox>
    <EditBox name="LetterNote" multiLine="true" autoFocus="false"><Size x="280" y="20"/><Anchors><Anchor point="BOTTOMLEFT"/></Anchors>
      <Scripts><OnEscapePressed>NoteEscapes = (NoteEscapes or 0) + 1</OnEscapePressed></Scripts></EditBox>
    <EditBox name="LetterTo" autoFocus="false"><Size x="100" y="20"/><Anchors><Anchor point="TOPRIGHT"/></Anchors>
      <Scripts><OnEscapePressed>ToEscapes = (ToEscapes or 0) + 1 self:ClearFocus()</OnEscapePressed></Scripts></EditBox>
  </Frames></Frame>
</Ui>`;

test("Escape in a multi-line edit box is the box's own: its script runs, the page's back-out chain does not", async () => {
  const { boot: loaded, doc, element, lua, close } = await boot({ "interface/framexml/frames.xml": LETTER });
  try {
    const field = (name) => element(name).children.find((child) => child.getAttribute("data-framexml-input") === "true");
    const escape = (target) => target.dispatch("keydown", {
      key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    });
    const body = field("LetterBody");
    assert.equal(body.tagName, "TEXTAREA");
    // SendMailBodyEditBox: OnEscapePressed is EditBox_ClearFocus.
    lua("LetterBody:SetFocus()", 0);
    assert.equal(doc.activeElement, body);
    const press = escape(body);
    assert.equal(press.defaultPrevented, true, "Controls.ts stops at a prevented press");
    assert.deepEqual(lua("return BodyEscapes, LetterBody:HasFocus()", 2), [1, false]);
    assert.notEqual(doc.activeElement, body, "the box the script took focus from loses the caret");
    // A script that keeps the focus keeps the caret; the press is still the box's.
    const note = field("LetterNote");
    lua("LetterNote:SetFocus()", 0);
    assert.equal(escape(note).defaultPrevented, true);
    assert.deepEqual(lua("return NoteEscapes, LetterNote:HasFocus() and 1 or 0", 2), [1, 1]);
    assert.equal(doc.activeElement, note);
    // A one-line `<input>` is left to the page (Controls.ts blurs it in the world, keeps it in the glue).
    const to = field("LetterTo");
    assert.equal(to.tagName, "INPUT");
    lua("LetterTo:SetFocus()", 0);
    assert.equal(escape(to).defaultPrevented, false);
    assert.deepEqual(lua("return ToEscapes"), [1]);
    assert.equal(loaded.errorCount, 0);
  } finally { close(); }
});

const LOOT = `<Ui>
  <Font name="LootFont" font="Fonts\\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="12"/></FontHeight></Font>
  <Frame name="Loot"><Size x="200" y="200"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Layers><Layer level="ARTWORK">
      <FontString name="LootText" inherits="LootFont" justifyH="LEFT" text="1 золотая 23 серебряные 45 медных монет">
        <Size x="93" y="38"/><Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
      <FontString name="LootGrow" inherits="LootFont" text="a paragraph that grows"><Size x="93" y="0"/>
        <Anchors><Anchor point="TOPLEFT"/></Anchors></FontString>
      <FontString name="LootPinned" inherits="LootFont" text="a string pinned by two anchors"><Size x="93" y="38"/>
        <Anchors><Anchor point="TOPLEFT"/><Anchor point="BOTTOMRIGHT"/></Anchors></FontString>
    </Layer></Layers></Frame>
</Ui>`;

test("a string whose box holds several lines shows only those, the last one ending in an ellipsis", async () => {
  const { boot: loaded, element, lua, close } = await boot({ "interface/framexml/frames.xml": LOOT });
  try {
    const clamp = (name) => {
      const style = element(name).style;
      return [style.display || "", style.webkitBoxOrient || "", style.webkitLineClamp || "", style.overflowY || "", style.whiteSpace];
    };
    // LootButtonNText: 93x38 in a 12-point font holds three lines.
    assert.deepEqual(clamp("LootText"), ["-webkit-box", "vertical", "3", "clip", "pre-wrap"]);
    assert.deepEqual(clamp("LootGrow"), ["", "", "", "", "pre-wrap"], "a zero height fits the text");
    assert.deepEqual(clamp("LootPinned"), ["", "", "", "", "pre-wrap"], "two vertical anchors own the height");
    lua("LootText:SetHeight(24)", 0);
    assert.equal(clamp("LootText")[2], "2");
    // The inline display would outrank a plain `[hidden]` rule: it is only there while shown.
    lua("LootText:Hide()", 0);
    assert.deepEqual(clamp("LootText").slice(0, 4), ["", "", "", ""]);
    lua("LootText:Show()", 0);
    assert.equal(clamp("LootText")[0], "-webkit-box");
    // Hidden while its frame was hidden: parked on the frame's return, with no display left on it.
    lua("Loot:Hide() LootText:Hide() Loot:Show()", 0);
    assert.equal(element("LootText").hidden, true);
    assert.equal(element("LootText").style.display || "", "");
    assert.equal(loaded.errorCount, 0);
  } finally { close(); }
});

// SkillFrame.lua:81 anchors each rank text LEFT to its name's RIGHT; the rank's <Size> is
// x="128" y="0" (SkillFrame.xml), and a zero height on a FontString means "one line of text".
const SKILL_ROW = `<Ui>
  <Font name="SmallFont" font="Fonts\FRIZQT__.TTF" virtual="true"><FontHeight><AbsValue val="10"/></FontHeight></Font>
  <Frame name="Panel"><Size x="400" y="300"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
    <StatusBar name="Bar"><Size x="271" y="15"/><Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="38" y="-97"/></Offset></Anchor></Anchors>
      <Layers><Layer level="ARTWORK">
        <FontString name="BarName" inherits="SmallFont" text="Кузнечное дело">
          <Anchors><Anchor point="LEFT"><Offset><AbsDimension x="6" y="1"/></Offset></Anchor></Anchors></FontString>
        <FontString name="BarRank" inherits="SmallFont" text="407/450"><Size x="128" y="0"/>
          <Anchors><Anchor point="LEFT" relativeTo="BarName" relativePoint="RIGHT"><Offset><AbsDimension x="13" y="0"/></Offset></Anchor></Anchors></FontString>
      </Layer></Layers>
    </StatusBar>
  </Frames></Frame>
</Ui>`;

test("a zero-height string centred on a sibling is placed by its line height, not by half of nothing", async () => {
  const { element, close } = await boot({ "interface/framexml/frames.xml": SKILL_ROW });
  try {
    const name = element("BarName").style;
    // The name is a parent anchor: its centre is the bar's middle line, one unit up.
    assert.equal(name.top, "calc(50% + -1px)");
    assert.ok((name.transform ?? "").includes("translateY(-50%)"), `the name is centred by a translate: ${name.transform}`);
    const rank = element("BarRank").style;
    // The rank's centre is the name's centre (6.5 on a 15-high bar); a 10-unit line is 5 above it.
    // Half of the declared 0 put the *top* of «407/450» on the middle line instead — 6.5px — with
    // the lower half of the number under the next row's bar.
    assert.equal(rank.top, "1.5px");
    assert.equal(rank.left, "19px", "13 to the right of the name's (unmeasured) right edge");
    assert.equal(rank.height, undefined, "a zero height stays the text's own");
    assert.ok(!/translate/.test(rank.transform ?? ""), `a measured centre needs no translate: ${rank.transform}`);
  } finally { close(); }
});
