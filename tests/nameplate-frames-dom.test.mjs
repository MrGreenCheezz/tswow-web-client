import assert from "node:assert/strict";
import test from "node:test";

// plates12 (15.11, plan item 6.37): the plate frames drawn by the FrameXML renderer under WorldFrame, and moved every
// frame without a reconciliation pass (FrameXmlDomRenderer.placeMovedFrames): what an add-on changes on a plate shows,
// and a frame in which no plate changed writes nothing.

let styleWrites = 0;
function fakeDocument() {
  const doc = { createElement: (tag) => make(tag) };
  const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const values = {};
    const style = new Proxy(values, {
      get(target, property) {
        if (property === "setProperty") return (name, value) => { styleWrites += 1; target[camel(name)] = String(value); };
        if (property === "removeProperty") return (name) => { delete target[camel(name)]; };
        return target[property] ?? "";
      },
      set(target, property, value) {
        styleWrites += 1;
        target[property] = String(value);
        return true;
      },
    });
    const node = {
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: undefined,
      style,
      hidden: false,
      className: "",
      textContent: "",
      offsetWidth: 0,
      offsetHeight: 0,
      classList: { add(...names) { node.className = [...names].join(" "); }, toggle() {}, remove() {} },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      removeEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.remove?.();
          child.parentElement = node;
          node.children.push(child);
        }
      },
      after(other) {
        const parent = node.parentElement;
        other.remove();
        const index = parent.children.indexOf(node);
        parent.children.splice(index + 1, 0, other);
        other.parentElement = parent;
      },
      get nextElementSibling() {
        const siblings = node.parentElement?.children ?? [];
        return siblings[siblings.indexOf(node) + 1] ?? null;
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

globalThis.document = fakeDocument();
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlNamePlatePool, frameXmlNamePlateState } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlNamePlatePool.js");
const { createNamePlateFrameHost } = await import("../dist/code/browser/ui/NamePlateFrames.js");
const { REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");

function mounted() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]), args[2], args[3] === undefined ? undefined : String(args[3]))]);
  assert.equal(bridge.loadAddon(String.raw`<Ui><WorldFrame name="WorldFrame" setAllPoints="true"/></Ui>`).ok, true);
  const worldFrame = bridge.getFrame("WorldFrame");
  const passes = [];
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, perf: { sync: (kind) => passes.push(kind) } });
  renderer.mount([worldFrame]);
  return { vm, bridge, worldFrame, renderer, passes };
}

function plates(count, x0 = 100) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const state = frameXmlNamePlateState();
    state.name = `Unit ${i}`;
    state.level = 80;
    state.health = 700;
    state.healthMax = 1000;
    list.push({ guid: BigInt(i + 1), x: x0 + i * 20, y: 400, state });
  }
  return list;
}

test("the plates are drawn under WorldFrame's element, and what an add-on changes on one is drawn", () => {
  const { vm, bridge, worldFrame, renderer } = mounted();
  const pool = new FrameXmlNamePlatePool(bridge, worldFrame, {
    placeMoved: (frames) => renderer.placeMovedFrames(frames),
    stack: (frames) => renderer.stackSiblings(frames),
  });
  pool.present(plates(1));
  const plate = pool.frames[0];
  const element = renderer.elementFor(plate);
  assert.ok(element);
  assert.equal(element.parentElement, renderer.elementFor(worldFrame));
  assert.equal(element.style.left, "calc(100px - 78.3255px)", "TOP on WorldFrame's BOTTOMLEFT at x 100");
  assert.equal(element.style.top, "calc(100% + -400px)");
  const border = plate.children.filter((child) => child.type === "Texture")[1];
  const health = plate.children.find((child) => child.type === "StatusBar");
  assert.equal(renderer.elementFor(border).hidden, false);

  const outcome = vm.execute(String.raw`
    local plate = WorldFrame:GetChildren()
    local _, border = plate:GetRegions()
    border:Hide()
    local health = plate:GetChildren()
    health:ClearAllPoints()
    health:SetPoint("TOP", plate, "TOP", 0, -3)
    Mine = CreateFrame("Frame", nil, plate)
    Mine:SetSize(10, 10)
    Mine:SetPoint("LEFT", plate, "RIGHT")
    local t = Mine:CreateTexture()
    t:SetAllPoints()
    t:SetTexture(1, 0, 0, 1)
  `, "@addon");
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(renderer.elementFor(border).hidden, true, "the hidden border is not drawn");
  const healthElement = renderer.elementFor(health);
  assert.equal(healthElement.getAttribute("data-framexml-point"), "TOP:TOP:0:-3", "the bar is drawn where the add-on put it");
  const mine = vm.getGlobal("Mine");
  const mineElement = renderer.elementFor(bridge.resolve(mine) ?? mine);
  assert.ok(mineElement, "the add-on's own frame is drawn");
  assert.equal(mineElement.parentElement, element, "inside the plate, so it moves with it");
  // The health bar's own fill is its Texture region; the renderer's private fill stays out.
  const fill = healthElement.children.find((child) => child.getAttribute("data-framexml-statusbar-fill") === "true");
  assert.equal(fill?.style.display, "none");
});

test("moving plates writes only their own boxes, with no reconciliation pass; a still frame writes nothing", () => {
  const { bridge, worldFrame, renderer, passes } = mounted();
  const pool = new FrameXmlNamePlatePool(bridge, worldFrame, {
    placeMoved: (frames) => renderer.placeMovedFrames(frames),
    stack: (frames) => renderer.stackSiblings(frames),
  });
  const list = plates(40);
  pool.present(list);
  const elements = pool.frames.map((frame) => renderer.elementFor(frame));
  passes.length = 0;
  const version = bridge.mutationVersion;

  for (const plate of list) plate.x += 3;
  styleWrites = 0;
  pool.present(list);
  assert.deepEqual(passes, [], "no renderer pass");
  assert.equal(bridge.mutationVersion, version, "nothing announced to the bridge");
  assert.equal(elements[0].style.left, "calc(103px - 78.3255px)");
  assert.equal(elements[39].style.left, `calc(${100 + 39 * 20 + 3}px - 78.3255px)`);
  assert.ok(styleWrites <= 40 * 3, `only the plates' own boxes were written: ${styleWrites}`);

  styleWrites = 0;
  pool.present(list);
  assert.deepEqual(passes, []);
  assert.equal(bridge.mutationVersion, version);
  assert.equal(styleWrites, 0, "a still frame writes nothing");

  // Lua reads the moved point.
  const point = pool.frames[0].points[0];
  assert.equal(point.x, 103);
  assert.deepEqual(bridge.geometry(pool.frames[0]).top, 400);
});

test("the plates are stacked far under near, and only an order change moves an element", () => {
  const { bridge, worldFrame, renderer } = mounted();
  const pool = new FrameXmlNamePlatePool(bridge, worldFrame, {
    placeMoved: (frames) => renderer.placeMovedFrames(frames),
    stack: (frames) => renderer.stackSiblings(frames),
  });
  const list = plates(3);
  pool.present(list);
  const parent = renderer.elementFor(worldFrame);
  const order = () => pool.frames.map((frame) => parent.children.indexOf(renderer.elementFor(frame)));
  const [a, b, c] = pool.frames;
  pool.present([list[2], list[0], list[1]]);
  const index = (frame) => parent.children.indexOf(renderer.elementFor(frame));
  assert.ok(index(c) < index(a) && index(a) < index(b), `drawn in the order given: ${order()}`);
});

test("the host turns the scene's boxes into WorldFrame points", () => {
  const { bridge, worldFrame, renderer } = mounted();
  const host = createNamePlateFrameHost({ bridge, worldFrame, renderer, uiScale: () => 100 });
  const data = {
    guid: 5n, name: "Mob", level: 12, playerLevel: 12, reaction: REACTION_HOSTILE, classColour: undefined, health: 0.5,
    raidMark: undefined, rank: 0, cast: undefined, target: false,
  };
  // A 1536-pixel-high overlay: half a WorldFrame unit per pixel.
  host.present([{ box: { x: 200, y: 300, width: 313.302, height: 78.326, scale: 2 }, data }], 2730, 1536);
  const plate = host.pool.frameFor(5n);
  assert.ok(plate);
  const point = plate.points[0];
  assert.equal(point.relativeTo, worldFrame);
  assert.ok(Math.abs(point.x - (200 + 313.302 / 2) / 2) < 1e-9);
  assert.ok(Math.abs(point.y - (1536 - 300) / 2) < 1e-9);
  host.clear();
  assert.equal(plate.visible, false);
});
