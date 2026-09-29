import assert from "node:assert/strict";
import test, { after } from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// Renderer and runtime residuals of wave 4 (lane RR): the eight-number SetTexCoord (TaxiFrame's
// route lines), vertex colour on textured images, a StaticPopup's edit box keeping the focus Lua
// or its `autoFocus` gave it, an inline root <Script> in a load-on-demand add-on (Blizzard_RaidUI),
// and a container resize that places again only what the new box can have moved. The MPQ-backed
// checks read the owner's client and skip without one.

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };
const chain = clientDirectory ? await (await import("../tools/mpq.mjs")).clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

/**
 * The DOM stub of framexml-renderer-anchors-strata.test.mjs: an element's offset box is its inline
 * pixel geometry inside its parent, hidden elements have no box, the container ends the chain, and
 * the document tracks the focused element (focus/blur are dispatched to the elements' listeners).
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
    return from !== undefined && to !== undefined && base !== undefined ? base - from - to : undefined;
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

/** A window whose `ResizeObserver` the test drives. */
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

async function boot(files, { view, hostSize, provider, installedAddons, rendererOptions } = {}) {
  const loaded = new FrameXmlBoot({
    exercise: false,
    ...(installedAddons ? { installedAddons } : {}),
    provider: provider ?? createFixtureProvider({
      "interface/framexml/framexml.toc": Object.keys(files).map((name) => name.replace("interface/framexml/", "")).join("\n"),
      ...files,
    }),
  });
  await loaded.load();
  const doc = layoutDocument();
  if (view) doc.defaultView = view;
  const host = doc.createElement("section");
  host.container = true;
  if (hostSize) Object.assign(host.style, { width: `${hostSize[0]}px`, height: `${hostSize[1]}px` });
  // A resolver makes every file texture a loaded picture, as the gateway's cache does.
  const renderer = new FrameXmlDomRenderer(host, {
    bridge: loaded.bridge, textureResolver: (path) => `tex:${path}`, ...rendererOptions,
  });
  renderer.mount(loaded.roots);
  return {
    boot: loaded,
    renderer,
    host,
    doc,
    element: (name) => renderer.elementFor(loaded.bridge.getFrame(name)),
    lua(code, results = 1) {
      const fn = loaded.vm.compileFunction(code, "rr-test", []);
      assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
      try { return loaded.vm.call(fn, [], results); } finally { loaded.vm.release(fn); }
    },
    close() { renderer.destroy(); loaded.close(); },
  };
}

/**
 * Where the CSS `transform` (origin at the box's centre) puts the untransformed point `[x, y]` of a
 * `width` × `height` box — the functions the renderer writes: translate/X/Y (px or % of the box),
 * scale/X/Y, rotate(rad) and matrix().
 */
function transformPoint(transform, width, height, [x, y]) {
  const steps = [...String(transform ?? "").matchAll(/(\w+)\(([^)]*)\)/g)].map(([, name, args]) => [name, args.split(",").map((value) => value.trim())]);
  const unit = (value, base) => (value.endsWith("%") ? Number(value.slice(0, -1)) * base / 100 : Number(value.replace("px", "")));
  let px = x - width / 2;
  let py = y - height / 2;
  for (const [name, args] of steps.reverse()) {
    if (name === "translate") { px += unit(args[0], width); py += unit(args[1] ?? "0", height); }
    else if (name === "translateX") px += unit(args[0], width);
    else if (name === "translateY") py += unit(args[0], height);
    else if (name === "scale") { px *= Number(args[0]); py *= Number(args[1] ?? args[0]); }
    else if (name === "scaleX") px *= Number(args[0]);
    else if (name === "scaleY") py *= Number(args[0]);
    else if (name === "rotate") {
      const angle = Number(args[0].replace("rad", ""));
      [px, py] = [px * Math.cos(angle) - py * Math.sin(angle), px * Math.sin(angle) + py * Math.cos(angle)];
    } else if (name === "matrix") {
      const [a, b, c, d, e, f] = args.map(Number);
      [px, py] = [a * px + c * py + e, b * px + d * py + f];
    } else throw new Error(`unexpected transform ${name}`);
  }
  return [px + width / 2, py + height / 2];
}

const close = (actual, expected, message) => {
  assert.ok(Math.abs(actual[0] - expected[0]) < 1e-3 && Math.abs(actual[1] - expected[1]) < 1e-3,
    `${message}: got ${actual.map((v) => v.toFixed(4))}, expected ${expected}`);
};

const TURNED = `<Ui>
  <Frame name="Canvas"><Size x="400" y="300"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Layers><Layer level="BACKGROUND">
      <Texture name="Turned" file="Interface\\TaxiFrame\\UI-Taxi-Line"><Size x="120" y="40"/>
        <Anchors><Anchor point="TOPLEFT" x="10" y="-20"/></Anchors></Texture>
    </Layer></Layers>
  </Frame>
</Ui>`;

test("the eight-number SetTexCoord lands its corners on the box's corners and cuts the picture to them", async () => {
  const { boot: loaded, element, lua, close: done } = await boot({ "interface/framexml/frames.xml": TURNED });
  try {
    const turned = element("Turned");
    // A sheared, turned parallelogram of texture coordinates: UL, LL, UR (LR = UR + LL − UL).
    lua("Turned:SetTexCoord(0.2, 0.1, 0.1, 0.7, 0.9, 0.3, 0.8, 0.9)", 0);
    assert.deepEqual(loaded.bridge.getFrame("Turned").texCoords.corners, [0.2, 0.1, 0.1, 0.7, 0.9, 0.3, 0.8, 0.9]);
    assert.equal(turned.getAttribute("data-framexml-texcoords"), null, "no crop inset for the host stylesheet");
    assert.equal(turned.style["clip-path"], "polygon(20% 10%, 90% 30%, 80% 90%, 10% 70%)");
    // The picture's texel (u, v) sits at (u·w, v·h) of the untransformed box; the transform must
    // put each corner's texel on that corner of the 120×40 box.
    const at = (u, v) => transformPoint(turned.style.transform, 120, 40, [u * 120, v * 40]);
    close(at(0.2, 0.1), [0, 0], "UL");
    close(at(0.9, 0.3), [120, 0], "UR");
    close(at(0.1, 0.7), [0, 40], "LL");
    close(at(0.8, 0.9), [120, 40], "LR");
    // Corners that are still an axis-aligned rectangle are the four-number form — here mirrored.
    lua("Turned:SetTexCoord(1, 0, 1, 1, 0, 0, 0, 1)", 0);
    assert.equal(loaded.bridge.getFrame("Turned").texCoords.corners, undefined);
    assert.equal(turned.getAttribute("data-framexml-texcoords"), "1:0:0:1");
    assert.equal(turned.style["clip-path"], undefined);
    assert.match(turned.style.transform, /scaleX\(-1\)/);
    // The four-number form is unchanged.
    lua("Turned:SetTexCoord(0, 0.5, 0.25, 1)", 0);
    assert.equal(turned.getAttribute("data-framexml-texcoords"), "0:0.5:0.25:1");
    assert.equal(turned.style["--framexml-texcoord-inset"], "25% 50% 0% 0%");
    assert.equal(turned.style.transform ?? "", "");
    assert.equal(loaded.errorCount, 0);
  } finally { done(); }
});

test("TaxiFrame's own DrawRouteLine draws its line from the start node to the end node", withClient, async () => {
  const decoder = new TextDecoder("utf-8");
  const files = {
    "interface/framexml/framexml.toc": "TaxiFrame.lua\nframes.xml\n",
    "interface/framexml/frames.xml": `<Ui><Frame name="Canvas"><Size x="316" y="352"/>
      <Anchors><Anchor point="TOPLEFT" x="30" y="-40"/></Anchors></Frame></Ui>`,
  };
  const fixture = createFixtureProvider(files);
  const provider = {
    async read(path) {
      if (path.toLowerCase() === "interface/framexml/taxiframe.lua") {
        return decoder.decode(await chain.read("Interface\\FrameXML\\TaxiFrame.lua"));
      }
      return fixture.read(path);
    },
  };
  const { boot: loaded, element, lua, close: done } = await boot({}, { provider });
  try {
    lua(`Route = Canvas:CreateTexture("Route", "BACKGROUND") Route:SetTexture("Interface\\\\TaxiFrame\\\\UI-Taxi-Line")`, 0);
    // Both branches of DrawRouteLine (dy >= 0 and dy < 0), a steep and a shallow line.
    for (const [sx, sy, ex, ey] of [[40, 60, 250, 190], [260, 300, 80, 110], [100, 250, 230, 40], [30, 30, 290, 45]]) {
      lua(`DrawRouteLine(Route, "Canvas", ${sx}, ${sy}, ${ex}, ${ey}, 32)`, 0);
      const [width, height, left, top] = lua(`return Route:GetWidth(), Route:GetHeight(),
        Route:GetLeft() - Canvas:GetLeft(), Route:GetTop() - Canvas:GetBottom()`, 4);
      const route = element("Route");
      // The line's body is the middle 30/32 of the picture along u, centred on v = 1/2.
      const onCanvas = (u) => {
        const [x, y] = transformPoint(route.style.transform, width, height, [u * width, 0.5 * height]);
        return [left + x, top - y];
      };
      const [from, to] = sx <= ex ? [[sx, sy], [ex, ey]] : [[ex, ey], [sx, sy]];
      close(onCanvas(1 / 32), from, `start of ${sx},${sy} → ${ex},${ey}`);
      close(onCanvas(31 / 32), to, `end of ${sx},${sy} → ${ex},${ey}`);
    }
    assert.equal(loaded.errorCount, 0);
  } finally { done(); }
});

const TINTED = `<Ui>
  <Frame name="Bag"><Size x="200" y="100"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Layers><Layer level="ARTWORK">
      <Texture name="Slot" file="Interface\\Icons\\INV_Misc_Bag_08"><Size x="37" y="37"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Texture>
      <Texture name="Other" file="Interface\\Icons\\INV_Misc_Bag_07"><Size x="37" y="37"/><Anchors><Anchor point="TOPRIGHT"/></Anchors></Texture>
      <Texture name="Glow" file="Interface\\Buttons\\UI-ActionButton-Border" alphaMode="ADD"><Size x="37" y="37"/>
        <Anchors><Anchor point="BOTTOMLEFT"/></Anchors></Texture>
      <Texture name="Swatch"><Size x="10" y="10"/><Anchors><Anchor point="BOTTOMRIGHT"/></Anchors></Texture>
    </Layer></Layers>
  </Frame>
</Ui>`;

test("a vertex colour multiplies a textured picture, before an ADD conversion and after a desaturate", async () => {
  const { boot: loaded, host, element, lua, close: done } = await boot({ "interface/framexml/frames.xml": TINTED });
  try {
    const filters = () => host.children.find((child) => child.getAttribute("data-framexml-tint-filters") === "true");
    // UpdateBagSlotStatus's unbought bank slot: SetItemButtonTextureVertexColor(1, 0.1, 0.1).
    lua("Slot:SetVertexColor(1, 0.1, 0.1)", 0);
    const slot = element("Slot");
    const id = /^url\(#(framexml-tint-\d+-ff1a1a)\)$/.exec(slot.style.filter)?.[1];
    assert.ok(id, `a tint filter: ${slot.style.filter}`);
    const filter = filters().children.find((child) => child.getAttribute("id") === id);
    assert.equal(filter.getAttribute("color-interpolation-filters"), "sRGB");
    assert.equal(filter.children[0].getAttribute("values"),
      `1 0 0 0 0 0 ${26 / 255} 0 0 0 0 0 ${26 / 255} 0 0 0 0 0 1 0`);
    // The alpha is the element's opacity, as before; the colour is not a variable nobody reads.
    lua("Slot:SetVertexColor(1, 0.1, 0.1, 0.5)", 0);
    assert.equal(slot.style.opacity, "0.5");
    assert.equal(slot.style.filter, `url(#${id})`);
    // A second picture in the same colour shares the filter; white is no filter at all.
    lua("Other:SetVertexColor(1, 0.1, 0.1)", 0);
    assert.equal(element("Other").style.filter, `url(#${id})`);
    assert.equal(filters().children.length, 1);
    lua("Other:SetVertexColor(1, 1, 1)", 0);
    assert.equal(element("Other").style.filter, "");
    // Grey first, then the colour; the ADD conversion last.
    lua("Slot:SetDesaturated(1)", 0);
    assert.equal(slot.style.filter, `grayscale(1) url(#${id})`);
    lua("Glow:SetVertexColor(0.5, 0.5, 1)", 0);
    assert.match(element("Glow").style.filter, /^url\(#framexml-tint-\d+-8080ff\) url\(#framexml-alphamode-add\)$/);
    // A colour-only texture paints its colour; it is not filtered by it as well.
    lua("Swatch:SetTexture(0.2, 0.4, 0.6, 1)", 0);
    assert.equal(element("Swatch").style.filter, "");
    assert.match(element("Swatch").style.backgroundColor, /^rgba\(51, 102, 153/);
    assert.equal(loaded.errorCount, 0);
  } finally { done(); }
  assert.equal(host.children.some((child) => child.getAttribute("data-framexml-tint-filters") === "true"), false,
    "destroy takes the filters away");
});

const POPUP = `<Ui>
  <Frame name="StaticPopup1" hidden="true" frameStrata="DIALOG" toplevel="true" enableMouse="true">
    <Size x="320" y="120"/><Anchors><Anchor point="TOP"/></Anchors>
    <Frames>
      <Button name="StaticPopup1Button1" text="Принять"><Size x="128" y="21"/><Anchors><Anchor point="BOTTOMLEFT"/></Anchors></Button>
      <EditBox name="StaticPopup1WideEditBox" autoFocus="false"><Size x="250" y="20"/><Anchors><Anchor point="CENTER"/></Anchors>
        <Scripts><OnEditFocusLost>FocusLost = (FocusLost or 0) + 1</OnEditFocusLost></Scripts></EditBox>
    </Frames>
    <Scripts><OnShow>StaticPopup1WideEditBox:SetFocus()</OnShow></Scripts>
  </Frame>
</Ui>`;

test("a dialog that gives its edit box the focus keeps it there instead of on its first button", async () => {
  const { boot: loaded, doc, element, lua, close: done } = await boot({ "interface/framexml/frames.xml": POPUP });
  try {
    const input = element("StaticPopup1WideEditBox").children.find((child) => child.getAttribute("data-framexml-input") === "true");
    // SET_FRIENDNOTE's OnShow is `self.wideEditBox:SetFocus()`.
    lua("StaticPopup1:Show()", 0);
    assert.equal(element("StaticPopup1").getAttribute("aria-modal"), "true", "the popup is the modal dialog");
    assert.equal(doc.activeElement, input, "the caret is in the box, not on StaticPopup1Button1");
    assert.deepEqual(lua("return StaticPopup1WideEditBox:HasFocus() and 1 or 0, FocusLost", 2), [1, undefined]);
    // Without a Lua focus the dialog still takes the keyboard, on its first control.
    lua("StaticPopup1:Hide() StaticPopup1WideEditBox:ClearFocus() StaticPopup1:SetScript('OnShow', nil) StaticPopup1:Show()", 0);
    assert.equal(doc.activeElement, element("StaticPopup1Button1"));
    assert.equal(loaded.errorCount, 0);
  } finally { done(); }
});

// StaticPopup_Show's order for CHANNEL_INVITE: the box is shown inside the still hidden dialog, then
// the dialog, whose OnShow never calls SetFocus. `Login` is AccountLogin's case: two boxes, both
// `autoFocus` by default, and an OnShow that chooses one of them.
const AUTOFOCUS = `<Ui>
  <Frame name="StaticPopup2" hidden="true" frameStrata="DIALOG" toplevel="true" enableMouse="true">
    <Size x="320" y="120"/><Anchors><Anchor point="TOP"/></Anchors>
    <Frames>
      <Button name="StaticPopup2Button1" text="Принять"><Size x="128" y="21"/><Anchors><Anchor point="BOTTOMLEFT"/></Anchors></Button>
      <EditBox name="StaticPopup2EditBox" hidden="true"><Size x="250" y="20"/><Anchors><Anchor point="CENTER"/></Anchors></EditBox>
      <EditBox name="StaticPopup2Quiet" autoFocus="false"><Size x="250" y="20"/><Anchors><Anchor point="TOP"/></Anchors></EditBox>
    </Frames>
  </Frame>
  <Frame name="Login" hidden="true">
    <Size x="300" y="200"/><Anchors><Anchor point="CENTER"/></Anchors>
    <Frames>
      <EditBox name="LoginAccount"><Size x="200" y="20"/><Anchors><Anchor point="TOP"/></Anchors></EditBox>
      <EditBox name="LoginPassword"><Size x="200" y="20"/><Anchors><Anchor point="BOTTOM"/></Anchors></EditBox>
    </Frames>
    <Scripts><OnShow>if ChooseAccount then LoginAccount:SetFocus() end</OnShow></Scripts>
  </Frame>
</Ui>`;

test("an autoFocus edit box takes the keyboard when it comes into view, unless an OnShow chose", async () => {
  const { boot: loaded, doc, element, lua, close: done } = await boot({ "interface/framexml/frames.xml": AUTOFOCUS });
  // Where the document focus is, by frame name ("… input" for an edit box's field).
  const focus = () => {
    const active = doc.activeElement;
    if (!active) return "none";
    const field = active.getAttribute("data-framexml-input") === "true";
    return `${(field ? active.parentElement : active).getAttribute("data-framexml-name")}${field ? " input" : ""}`;
  };
  try {
    assert.deepEqual(lua("return StaticPopup2EditBox:IsAutoFocus(), StaticPopup2Quiet:IsAutoFocus()", 2), [1, undefined],
      "true by default, false where the XML says so");
    lua("StaticPopup2EditBox:Show()", 0);
    assert.deepEqual(lua("return StaticPopup2EditBox:HasFocus() and 1 or 0"), [0], "not in view under the hidden dialog");
    lua("StaticPopup2:Show()", 0);
    assert.equal(element("StaticPopup2").getAttribute("aria-modal"), "true", "the popup is the modal dialog");
    assert.deepEqual(lua("return StaticPopup2EditBox:HasFocus() and 1 or 0, StaticPopup2Quiet:HasFocus() and 1 or 0", 2), [1, 0]);
    assert.equal(focus(), "StaticPopup2EditBox input", "the caret is in the box, not on StaticPopup2Button1");
    // SetAutoFocus(false) gives the dialog back its first control.
    lua("StaticPopup2:Hide() StaticPopup2EditBox:ClearFocus() StaticPopup2EditBox:SetAutoFocus(false) StaticPopup2:Show()", 0);
    assert.deepEqual(lua("return StaticPopup2EditBox:IsAutoFocus(), StaticPopup2EditBox:HasFocus() and 1 or 0", 2), [undefined, 0]);
    assert.equal(focus(), "StaticPopup2Button1");
    lua("StaticPopup2:Hide()", 0);
    // AccountLogin_OnShow's choice stands although LoginPassword is the later autoFocus box ...
    lua("ChooseAccount = true Login:Show()", 0);
    assert.equal(focus(), "LoginAccount input");
    assert.deepEqual(lua("return LoginAccount:HasFocus() and 1 or 0, LoginPassword:HasFocus() and 1 or 0", 2), [1, 0]);
    // ... and with no choice the last box shown takes it, as the last SetFocus would.
    lua("Login:Hide() LoginAccount:ClearFocus() ChooseAccount = nil Login:Show()", 0);
    assert.equal(focus(), "LoginPassword input");
    assert.deepEqual(lua("return LoginAccount:HasFocus() and 1 or 0, LoginPassword:HasFocus() and 1 or 0", 2), [0, 1]);
    assert.equal(loaded.errorCount, 0);
  } finally { done(); }
});

// The same two cases in a world renderer, whose dialogs are modeless: nothing traps the keyboard,
// so the caret comes only from the renderer's own EditBox focus (SetFocus, autoFocus), and a dialog
// without a focused box leaves the keyboard wherever the player had it.
const WORLD = { rendererOptions: { dialogs: "modeless" } };
const inputOf = (element, name) => element(name).children.find((child) => child.getAttribute("data-framexml-input") === "true");

test("world: a dialog that gives its edit box the focus puts the caret there; one that does not takes no focus", async () => {
  const { boot: loaded, doc, element, lua, close: done } = await boot({ "interface/framexml/frames.xml": POPUP }, WORLD);
  try {
    const input = inputOf(element, "StaticPopup1WideEditBox");
    lua("StaticPopup1:Show()", 0);
    assert.equal(element("StaticPopup1").getAttribute("aria-modal"), null, "a dialog, not a modal one");
    assert.equal(doc.activeElement === input, true, "the caret is in the box");
    assert.deepEqual(lua("return StaticPopup1WideEditBox:HasFocus() and 1 or 0, FocusLost", 2), [1, undefined]);
    lua("StaticPopup1:Hide() StaticPopup1WideEditBox:ClearFocus() StaticPopup1:SetScript('OnShow', nil)", 0);
    const chat = doc.createElement("input");
    chat.focus();
    lua("StaticPopup1:Show()", 0);
    assert.equal(doc.activeElement === chat, true, "no Lua focus: the keyboard stays with the chat box");
    assert.equal(doc.activeElement === element("StaticPopup1Button1"), false);
    assert.equal(loaded.errorCount, 0);
  } finally { done(); }
});

test("world: an autoFocus edit box takes the keyboard when it comes into view, unless an OnShow chose", async () => {
  const { boot: loaded, doc, element, lua, close: done } = await boot({ "interface/framexml/frames.xml": AUTOFOCUS }, WORLD);
  const focus = () => {
    const active = doc.activeElement;
    if (!active) return "none";
    const field = active.getAttribute("data-framexml-input") === "true";
    const owner = field ? active.parentElement : active;
    return `${owner?.getAttribute("data-framexml-name") ?? "outside"}${field ? " input" : ""}`;
  };
  try {
    lua("StaticPopup2EditBox:Show() StaticPopup2:Show()", 0);
    assert.equal(element("StaticPopup2").getAttribute("aria-modal"), null);
    assert.deepEqual(lua("return StaticPopup2EditBox:HasFocus() and 1 or 0, StaticPopup2Quiet:HasFocus() and 1 or 0", 2), [1, 0]);
    assert.equal(focus(), "StaticPopup2EditBox input", "the caret is in the box");
    lua("StaticPopup2:Hide() StaticPopup2EditBox:SetAutoFocus(false)", 0);
    doc.createElement("input").focus();
    lua("StaticPopup2:Show()", 0);
    assert.deepEqual(lua("return StaticPopup2EditBox:HasFocus() and 1 or 0"), [0]);
    assert.equal(focus(), "outside", "without an autoFocus box the dialog takes no focus of its own");
    lua("StaticPopup2:Hide() ChooseAccount = true Login:Show()", 0);
    assert.equal(focus(), "LoginAccount input", "an OnShow's SetFocus still has the last word");
    assert.equal(loaded.errorCount, 0);
  } finally { done(); }
});

const TAB = `<Ui>
  <Frame name="StaticPopup3" frameStrata="DIALOG" toplevel="true" enableMouse="true">
    <Size x="320" y="120"/><Anchors><Anchor point="TOP"/></Anchors>
    <Frames>
      <EditBox name="StaticPopup3EditBox" autoFocus="false"><Size x="250" y="20"/><Anchors><Anchor point="CENTER"/></Anchors>
        <Scripts><OnTabPressed>Tabbed = (Tabbed or 0) + 1</OnTabPressed></Scripts></EditBox>
      <EditBox name="StaticPopup3Plain" autoFocus="false"><Size x="250" y="20"/><Anchors><Anchor point="TOP"/></Anchors></EditBox>
    </Frames>
  </Frame>
</Ui>`;

test("Tab in a world edit box is the box's own (AutoCompleteEditBox_OnTabPressed); the login screens keep field-to-field Tab", async () => {
  for (const [label, options, spent] of [["world", WORLD, true], ["glue", {}, false]]) {
    const { element, lua, close: done } = await boot({ "interface/framexml/frames.xml": TAB }, options);
    try {
      for (const [name, scripted] of [["StaticPopup3EditBox", true], ["StaticPopup3Plain", false]]) {
        let prevented = false;
        inputOf(element, name).dispatch("keydown", { key: "Tab", preventDefault() { prevented = true; } });
        assert.equal(prevented, spent, `${label} ${name}: the browser's focus walk is ${spent ? "held" : "left alone"}`);
        if (scripted) assert.equal(lua("return Tabbed")[0], 1, `${label}: OnTabPressed ran`);
      }
      lua("Tabbed = nil", 0);
    } finally { done(); }
  }
});

test("the stock CHANNEL_INVITE popup, which never calls SetFocus, opens with its edit box focused", withClient, async () => {
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const decoder = new TextDecoder("utf-8");
  const loaded = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(), exercise: true,
    screen: () => ({ width: 1365, height: 768 }),
  });
  const lua = (code, results = 1) => {
    const fn = loaded.vm.compileFunction(code, "rr-autofocus", []);
    assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
    try { return loaded.vm.call(fn, [], results); } finally { loaded.vm.release(fn); }
  };
  try {
    await loaded.load();
    const errors = loaded.errors.length;
    // StaticPopup.xml:93 declares no autoFocus; ChatFrameEditBoxTemplate (ChatFrame.xml:21) and
    // SendMailNameEditBox (MailFrame.xml:859, over AutoCompleteEditBoxTemplate) say false.
    assert.deepEqual(lua("return StaticPopup1EditBox:IsAutoFocus(), ChatFrame1EditBox:IsAutoFocus(), SendMailNameEditBox:IsAutoFocus()", 3),
      [1, undefined, undefined]);
    assert.deepEqual(lua(`local dialog = StaticPopup_Show("CHANNEL_INVITE", "Общий")
      return dialog and dialog:GetName(), dialog and dialog.editBox:HasFocus() and 1 or 0`, 2), ["StaticPopup1", 1]);
    lua("StaticPopup_Hide('CHANNEL_INVITE')", 0);
    // An autoFocus="false" box stays out of the way when it is shown.
    assert.deepEqual(lua("ChatFrame1EditBox:Hide() ChatFrame1EditBox:Show() return ChatFrame1EditBox:HasFocus() and 1 or 0"), [0]);
    assert.deepEqual(loaded.errors.slice(errors).map((error) => `${error.file}:${error.line} ${error.message}`), []);
  } finally {
    loaded.close();
  }
});

test("an inline root <Script> in a load-on-demand add-on runs instead of failing the add-on", async () => {
  const files = {
    "interface/framexml/framexml.toc": "GlobalStrings.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    "interface/addons/inline_ui/inline_ui.toc": "## LoadOnDemand: 1\nInline_UI.xml\n",
    "interface/addons/inline_ui/inline_ui.xml": `<Ui>
      <Script file="Inline_UI.lua"/>
      <Frame name="InlineFrame"><Size x="10" y="10"/></Frame>
      <Script>
        InlineRan = (InlineRan or 0) + 1
        InlineSawFrame = InlineFrame ~= nil
      </Script>
    </Ui>`,
    "interface/addons/inline_ui/inline_ui.lua": "InlineLua = true",
    "interface/addons/bad_ui/bad_ui.toc": "Bad_UI.xml\n",
    "interface/addons/bad_ui/bad_ui.xml": `<Ui><Script file=""/></Ui>`,
  };
  const loaded = new FrameXmlBoot({ provider: createFixtureProvider(files), installedAddons: ["Inline_UI", "Bad_UI"], exercise: false });
  try {
    await loaded.load();
    const result = await loaded.loadAddon("Inline_UI");
    assert.equal(result.ok, true, result.message);
    assert.equal(loaded.vm.getGlobal("InlineLua"), true);
    assert.equal(loaded.vm.getGlobal("InlineRan"), 1, "the inline body ran once, after the frames above it");
    assert.equal(loaded.vm.getGlobal("InlineSawFrame"), true);
    // A declared but empty file is still refused.
    const bad = await loaded.loadAddon("Bad_UI");
    assert.equal(bad.ok, false);
    assert.match(bad.message, /invalid Script path/);
  } finally {
    loaded.close();
  }
});

test("Blizzard_RaidUI loads on demand with no Lua error, and the Raid tab's LoadUI adapter steps aside", withClient, async () => {
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { installFrameXmlFriendsAdapters } = await import("../dist/code/browser/framexml/FrameXmlFriendsOwner.js");
  const decoder = new TextDecoder("utf-8");
  const loaded = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(), exercise: true,
    screen: () => ({ width: 1365, height: 768 }), installedAddons: ["Blizzard_RaidUI"],
  });
  const lua = (code, results = 1) => {
    const fn = loaded.vm.compileFunction(code, "rr-raid", []);
    try { return loaded.vm.call(fn, [], results); } finally { loaded.vm.release(fn); }
  };
  try {
    await loaded.load();
    assert.equal(installFrameXmlFriendsAdapters(loaded), true);
    const errors = loaded.errors.length;
    const result = await loaded.loadAddon("Blizzard_RaidUI");
    assert.equal(result.ok, true, result.message);
    assert.ok(result.roots.length > 40, `${result.roots.length} roots (the group grid and its 40 buttons)`);
    assert.deepEqual(loaded.errors.slice(errors).map((error) => `${error.file}:${error.line} ${error.message}`), []);
    // Blizzard_RaidUI.xml ends with an inline `RaidGroupFrame_OnLoad();` that takes over RaidFrame.
    assert.deepEqual(lua("return RaidFrame:GetScript('OnEvent') == RaidGroupFrame_OnEvent and 1 or 0"), [1]);
    // LoadAddOn now answers loaded, so FrameXmlFriendsOwner's RaidFrame_LoadUI runs the stock body.
    assert.deepEqual(lua("return LoadAddOn('Blizzard_RaidUI')", 2), [true, undefined]);
    lua("RaidFrame_LoadUI()", 0);
    assert.deepEqual(loaded.errors.slice(errors).map((error) => error.message), []);
  } finally {
    loaded.close();
  }
});

// A bar the screen places by its bottom edge, whose buttons are anchored to each other inside it,
// and two frames measured against frames the resize does move.
const RESIZE = `<Ui>
  <Frame name="Screen"><Anchors><Anchor point="TOPLEFT"/><Anchor point="BOTTOMRIGHT"/></Anchors><Frames>
    <Frame name="Bar"><Size x="300" y="40"/><Anchors><Anchor point="BOTTOM"/></Anchors><Frames>
      <Button name="Slot1"><Size x="30" y="30"/><Anchors><Anchor point="LEFT"/></Anchors></Button>
      <Button name="Slot2"><Size x="30" y="30"/><Anchors><Anchor point="LEFT" relativeTo="Slot1" relativePoint="RIGHT" x="6"/></Anchors></Button>
      <Button name="Slot3"><Size x="30" y="30"/><Anchors><Anchor point="LEFT" relativeTo="Slot2" relativePoint="RIGHT" x="6"/></Anchors></Button>
    </Frames></Frame>
    <Frame name="Side"><Size x="50" y="50"/><Anchors><Anchor point="BOTTOMLEFT" relativeTo="Bar" relativePoint="TOPRIGHT"/></Anchors></Frame>
    <Frame name="Corner"><Size x="20" y="20"/><Anchors><Anchor point="TOPRIGHT"/></Anchors></Frame>
    <Frame name="Tag"><Size x="20" y="20"/><Anchors><Anchor point="TOPRIGHT" relativeTo="Corner" relativePoint="TOPLEFT"/></Anchors></Frame>
    <Frame name="Panel"><Size x="100" y="100"/><Anchors><Anchor point="TOPLEFT"/></Anchors><Frames>
      <Frame name="Badge"><Size x="10" y="10"/><Anchors><Anchor point="TOPLEFT" relativeTo="Corner" relativePoint="BOTTOMLEFT"/></Anchors></Frame>
    </Frames></Frame>
  </Frames></Frame>
</Ui>`;

test("a container resize places again only the frames its new box can have moved", async () => {
  const view = resizableView();
  const { renderer, host, element, close: done } = await boot({ "interface/framexml/frames.xml": RESIZE },
    { view, hostSize: [1000, 600] });
  try {
    assert.equal(element("Slot2").style.left, "36px");
    assert.equal(element("Side").style.left, "650px", "Bar's right edge: (1000 + 300) / 2");
    assert.equal(element("Tag").style.left, "960px", "Corner's left: 1000 - 20 - 20");
    assert.equal(element("Badge").style.left, "980px", "measured from its own 100-wide panel");
    const placed = [];
    const original = Object.getPrototypeOf(renderer).applyGeometry;
    Object.getPrototypeOf(renderer).applyGeometry = function (element, frame, ...rest) {
      placed.push(frame.name);
      return original.call(this, element, frame, ...rest);
    };
    try {
      host.style.width = "1400px";
      view.resized();
    } finally {
      Object.getPrototypeOf(renderer).applyGeometry = original;
    }
    // Slot2 and Slot3 are measured against a sibling inside the 300-wide bar: nothing about them
    // can change. Side and Tag are measured against frames the screen's new width moved, and so is
    // Badge, whose own panel keeps its size but whose target is drawn outside it.
    assert.deepEqual(placed.sort(), ["Badge", "Side", "Tag"]);
    assert.equal(element("Side").style.left, "850px");
    assert.equal(element("Tag").style.left, "1360px");
    assert.equal(element("Badge").style.left, "1380px");
    assert.equal(element("Slot2").style.left, "36px");
    assert.equal(element("Slot3").style.left, "72px");
  } finally { done(); }
});
