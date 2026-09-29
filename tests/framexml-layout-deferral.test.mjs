import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");

// setLayoutDeferral: what a world event (the seam's pump, `runInDeferrableBatch`) changes — a move,
// a text, a shown frame — waits for the world mount's frame step instead of reconciling the page
// once per event, while every read of the page settles it first, so Lua and the host read what they
// read when every event was reconciled on its own.

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}

function bridgeWithFrame() {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Frame", "DeferredFrame");
  assert.ok(frame);
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  bridge.setPaintDeferral(true);
  bridge.setLayoutDeferral(true);
  return { bridge, frame, get notifications() { return notifications; } };
}

test("world events' layout waits for the step: N events, one announcement", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  for (let i = 0; i < 40; i++) {
    bridge.runInDeferrableBatch(() => {
      bridge.SetText(frame, `health ${i}`);
      bridge.update(frame, (mutable) => { mutable.alpha = i / 40; }, "paint");
    });
  }
  assert.equal(fixture.notifications, 0, "held for the frame step");
  assert.equal(bridge.layoutDeferred, true);
  bridge.flushDeferredPaint();
  assert.equal(fixture.notifications, 1, "one reconciliation for all forty");
  assert.equal(bridge.layoutDeferred, false);
});

test("a host batch — a click, a key — is still announced when it ends, and carries what was held", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  bridge.runInDeferrableBatch(() => bridge.SetText(frame, "held"));
  assert.equal(fixture.notifications, 0);
  bridge.runInMutationBatch(() => bridge.SetPoint(frame, "CENTER"));
  assert.equal(fixture.notifications, 1, "the click's layout reaches the page at once");
  assert.equal(bridge.layoutDeferred, false, "and the held event went with it");
  // Nested inside any other batch the event batch is a plain one: that batch's end decides.
  bridge.runInMutationBatch(() => bridge.runInDeferrableBatch(() => bridge.SetText(frame, "nested")));
  assert.equal(fixture.notifications, 2);
});

test("without layout deferral the pump's batch is a plain batch, as before", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Frame", "PlainFrame");
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  bridge.setPaintDeferral(true);
  bridge.runInDeferrableBatch(() => bridge.SetText(frame, "moves"));
  assert.equal(notifications, 1);
  bridge.setLayoutDeferral(true);
  bridge.runInDeferrableBatch(() => bridge.SetText(frame, "held"));
  assert.equal(notifications, 1);
  bridge.setLayoutDeferral(false);
  assert.equal(notifications, 2, "turning it off announces what was held");
});

test("a read of the page settles held layout first, inside a later event's batch too", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  const answers = [];
  bridge.setMeasure(() => {
    // What the host would measure: the page as of the last announcement.
    answers.push(fixture.notifications);
    return { width: 10, height: 10 };
  });
  bridge.runInDeferrableBatch(() => bridge.update(frame, (mutable) => mutable.setAttribute("width", "200")));
  assert.equal(fixture.notifications, 0);
  // The next event reads (`GetWidth` in its handler).
  bridge.runInDeferrableBatch(() => bridge.measure(frame));
  assert.deepEqual(answers, [1], "the page was reconciled before it was measured");
  assert.equal(fixture.notifications, 1);
  // Nothing held: a read costs nothing further.
  bridge.runInDeferrableBatch(() => bridge.measure(frame));
  assert.equal(fixture.notifications, 1);
  // Paint alone moves nothing a measure could see, and stays for the step.
  bridge.runInDeferrableBatch(() => bridge.update(frame, (mutable) => { mutable.alpha = 0.5; }, "paint"));
  bridge.measure(frame);
  assert.equal(fixture.notifications, 1);
  assert.equal(bridge.paintDeferred, true);
});

test("a read settles only when a held change can reach the box it reads", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const root = bridge.CreateFrame("Frame", "ReachRoot");
  const make = (name, parent = root) => {
    const frame = bridge.CreateFrame("Frame", name, parent);
    bridge.update(frame, (mutable) => { mutable.setAttribute("width", "50"); mutable.setAttribute("height", "20"); });
    return frame;
  };
  const moved = make("ReachMoved");
  const sibling = make("ReachSibling");
  const child = make("ReachChild", moved);
  const anchored = make("ReachAnchored");
  bridge.SetPoint(anchored, "TOPLEFT", moved, "BOTTOMLEFT", 0, 0);
  const chained = make("ReachChained");
  bridge.SetPoint(chained, "LEFT", anchored, "RIGHT", 0, 0);
  // Sized by its content: no size of its own, one anchor.
  const sizeless = bridge.CreateFrame("Button", "ReachSizeless", root);
  const label = make("ReachLabel", sizeless);
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  bridge.setMeasure(() => ({ width: 10, height: 10 }));
  bridge.setPaintDeferral(true);
  bridge.setLayoutDeferral(true);
  const hold = (frame) => bridge.runInDeferrableBatch(() => bridge.SetPoint(frame, "CENTER", undefined, undefined, notifications, 0));

  hold(moved);
  bridge.measure(sibling);
  bridge.isMouseOver(sibling);
  bridge.geometry(sibling);
  assert.equal(notifications, 0, "a sibling's box does not follow the moved frame: nothing settles");
  bridge.measure(child);
  assert.equal(notifications, 1, "a child's box does");

  hold(moved);
  bridge.measure(chained);
  assert.equal(notifications, 2, "a frame anchored to one anchored to it does, transitively");

  hold(label);
  bridge.measure(anchored);
  assert.equal(notifications, 2, "a label moved inside another button reaches nothing here");
  bridge.measure(sizeless);
  assert.equal(notifications, 3, "the button its label sizes does");

  // A money frame hung under a tooltip: the tooltip's lines size it, so a line moves the frame.
  const tooltip = bridge.CreateFrame("GameTooltip", "ReachTooltip", root);
  const line = make("ReachTooltipLine", tooltip);
  const rider = make("ReachRider");
  bridge.SetPoint(rider, "TOP", tooltip, "BOTTOM", 0, 0);
  bridge.flushDeferredPaint();
  const before = notifications;
  hold(line);
  bridge.measure(sibling);
  assert.equal(notifications, before);
  bridge.measure(rider);
  assert.equal(notifications, before + 1, "what hangs under the tooltip follows its lines");

  // A change that names no frame could be anything.
  bridge.runInDeferrableBatch(() => bridge.touch());
  bridge.measure(sibling);
  assert.equal(notifications, before + 2);
});

test("IsMouseOver settles held layout before asking the renderer for the box", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  const asked = [];
  bridge.setScreenRectSource(() => {
    asked.push(fixture.notifications);
    return { left: 0, right: 10, top: 10, bottom: 0, width: 10, height: 10 };
  });
  bridge.setMousePosition(5, 5);
  bridge.runInDeferrableBatch(() => bridge.SetPoint(frame, "TOPLEFT"));
  assert.equal(bridge.isMouseOver(frame), true);
  assert.deepEqual(asked, [1]);
});

test("a read inside a renderer's own pass never starts another pass inside it", () => {
  const fixture = bridgeWithFrame();
  const { bridge, frame } = fixture;
  bridge.setMeasure(() => ({ width: 10, height: 10 }));
  bridge.runInDeferrableBatch(() => bridge.update(frame, (mutable) => mutable.setAttribute("width", "300")));
  let inside = -1;
  bridge.runInRenderPass(() => {
    bridge.measure(frame);
    inside = fixture.notifications;
  });
  assert.equal(inside, 0, "no announcement from inside the pass");
  // Like any batch, the pass announces what is still pending when it ends; outside it, not inside.
  assert.equal(fixture.notifications, 1);
});

// ---------------------------------------------------------------------------------------------
// Through the real renderer and Lua: what a script reads after an earlier event moved a frame.

/**
 * An element's offset box is its inline pixel geometry inside its parent (the rr/anchors-strata
 * stub), and a client rectangle is the offset chain up to the container, which sits at the origin.
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
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: null,
      hidden: false, textContent: "", dataset: {}, className: "", container: false,
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) {
          delete this[name];
          delete this[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
        },
      },
      classList: { add() {} },
      addEventListener() {},
      removeEventListener() {},
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
      get offsetLeft() { return hiddenUp(node) ? 0 : box(node, "left", "right", "width") ?? 0; },
      get offsetTop() { return hiddenUp(node) ? 0 : box(node, "top", "bottom", "height") ?? 0; },
      get offsetWidth() { return hiddenUp(node) ? 0 : size(node, "left", "right", "width") ?? 0; },
      get offsetHeight() { return hiddenUp(node) ? 0 : size(node, "top", "bottom", "height") ?? 0; },
      getBoundingClientRect() {
        let left = 0;
        let top = 0;
        for (let current = node; current && !current.container; current = current.parentElement) {
          left += current.offsetLeft;
          top += current.offsetTop;
        }
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        return { left, top, width, height, right: left + width, bottom: top + height };
      },
    };
    return node;
  }
  function length(value, base) {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    const direct = pixels(text);
    if (direct !== undefined) return direct;
    const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(text);
    return percent && base !== undefined ? Number(percent[1]) * base / 100 : undefined;
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

const EVENTS_XML = `<Ui>
  <Frame name="Screen"><Size x="1024" y="768"/><Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Frames>
      <Frame name="Box"><Size x="100" y="100"/><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
    </Frames>
  </Frame>
  <Frame name="Mover">
    <Scripts>
      <OnLoad>self:RegisterEvent("TEST_RESIZE")</OnLoad>
      <OnEvent>local width = ...; Box:SetWidth(width)</OnEvent>
    </Scripts>
  </Frame>
  <Frame name="Reader">
    <Scripts>
      <OnLoad>self:RegisterEvent("TEST_READ_WIDTH"); self:RegisterEvent("TEST_READ_OVER")</OnLoad>
      <OnEvent>
        if event == "TEST_READ_WIDTH" then READ_WIDTH = Box:GetWidth() end
        if event == "TEST_READ_OVER" then READ_OVER = Box:IsMouseOver() and 1 or 0 end
      </OnEvent>
    </Scripts>
  </Frame>
</Ui>`;

async function mountedEvents(deferLayout) {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": EVENTS_XML,
  }) });
  await boot.load();
  const doc = layoutDocument();
  const host = doc.createElement("section");
  host.container = true;
  Object.assign(host.style, { width: "1024px", height: "768px" });
  let passes = 0;
  const renderer = new FrameXmlDomRenderer(host, {
    bridge: boot.bridge, perf: { sync: (kind) => { if (kind !== "noop") passes += 1; } },
  });
  // The world mount's measure seam: what the page laid the frame out at.
  boot.bridge.setMeasure((frame) => renderer.measure(frame));
  renderer.mount(boot.roots);
  boot.bridge.setPaintDeferral(true);
  if (deferLayout) boot.bridge.setLayoutDeferral(true);
  return {
    boot, renderer,
    get passes() { return passes; },
    close() { renderer.destroy(); boot.close(); },
  };
}

for (const deferLayout of [false, true]) {
  test(`Lua reads a frame where an earlier world event put it (layout deferral ${deferLayout ? "on" : "off"})`, async () => {
    const world = await mountedEvents(deferLayout);
    const { boot } = world;
    try {
      const box = boot.bridge.getFrame("Box");
      assert.equal(world.renderer.elementFor(box).style.width, "100px");
      boot.pump.fire("TEST_RESIZE", 200);
      boot.pump.fire("TEST_READ_WIDTH");
      assert.equal(boot.vm.getGlobal("READ_WIDTH"), 200, "GetWidth answers the width the page now has");
      // The cursor 150 units in from the left, 50 down from the top (GetCursorPosition's Y is up).
      boot.bridge.setMousePosition(150, 768 - 50);
      boot.pump.fire("TEST_RESIZE", 100);
      boot.pump.fire("TEST_READ_OVER");
      assert.equal(boot.vm.getGlobal("READ_OVER"), 0, "a 100-wide box is not under a cursor at x = 150");
      boot.pump.fire("TEST_RESIZE", 200);
      boot.pump.fire("TEST_READ_OVER");
      assert.equal(boot.vm.getGlobal("READ_OVER"), 1, "the 200-wide one is");
      assert.deepEqual(boot.errors, []);
    } finally { world.close(); }
  });
}

test("held layout reaches the page at the step, or at a host's elementFor, with one pass", async () => {
  const world = await mountedEvents(true);
  const { boot, renderer } = world;
  try {
    const box = boot.bridge.getFrame("Box");
    const element = renderer.elementFor(box);
    const before = world.passes;
    for (let width = 101; width <= 140; width++) boot.pump.fire("TEST_RESIZE", width);
    assert.equal(world.passes, before, "forty events, no pass");
    assert.equal(element.style.width, "100px", "the page waits");
    // A host reading the page inside a batch (a Lua call asking for a portrait's box) gets it now.
    let seen;
    boot.bridge.runInMutationBatch(() => { seen = renderer.elementFor(box)?.style.width; });
    assert.equal(seen, "140px");
    assert.equal(world.passes, before + 1);
    // A host measuring directly (`FrameXmlDomRenderer.measure`, not through the bridge) likewise.
    boot.pump.fire("TEST_RESIZE", 145);
    assert.equal(renderer.measure(box)?.width, 145);
    assert.equal(world.passes, before + 2);
    // And the step announces what the next burst held, in one pass.
    for (let width = 141; width <= 150; width++) boot.pump.fire("TEST_RESIZE", width);
    boot.bridge.flushDeferredPaint();
    assert.equal(element.style.width, "150px");
    assert.equal(world.passes, before + 3);
  } finally { world.close(); }
});

// ---------------------------------------------------------------------------------------------
// The stock HUD: the store flush of a fight, measured.

test("forty stock health/power events of five units cost no pass until the frame step", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { FRAMEXML_POWER_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  // Every unit's health and power move on each event, so each event is a real change.
  class PulsingSeam extends CannedWorldSeam {
    pulse = 0;
    unitHealth(unit) { const base = super.unitHealth(unit); return base > 0 ? Math.max(1, base - (this.pulse % 97)) : base; }
    unitPower(unit) { const base = super.unitPower(unit); return base > 0 ? Math.max(0, base - (this.pulse % 13)) : base; }
  }
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new PulsingSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false,
    screen: () => ({ width: 1365, height: 768 }),
  });
  let renderer;
  try {
    const inventory = await boot.load();
    assert.equal(inventory.lua.failed, 0);
    const doc = layoutDocument();
    const host = doc.createElement("section");
    host.container = true;
    Object.assign(host.style, { width: "1365px", height: "768px" });
    let phase = "mount";
    const passes = { flush: 0, step: 0 };
    renderer = new FrameXmlDomRenderer(host, {
      bridge: boot.bridge, textureResolver: (path) => `tex:${path}`,
      perf: { sync: (kind) => { if (kind !== "noop" && phase in passes) passes[phase] += 1; } },
    });
    boot.bridge.setMeasure((frame) => frame.name === "UIParent" ? { width: 1365, height: 768 } : renderer.measure(frame));
    renderer.mount(boot.roots);
    boot.bridge.setPaintDeferral(true);
    boot.bridge.setLayoutDeferral(true);
    const units = ["player", "pet", "party1", "party2", "party3"];
    const powerEvent = (unit) => FRAMEXML_POWER_EVENTS[seam.unitPowerType(unit)?.[0] ?? 0] ?? "UNIT_MANA";
    let now = boot.pump.now();
    for (let frame = 0; frame < 4; frame++) {
      passes.flush = 0;
      passes.step = 0;
      phase = "flush";
      for (let index = 0; index < 40; index++) {
        seam.pulse += 1;
        const unit = units[index % units.length];
        if (Math.floor(index / units.length) % 2 === 0) boot.pump.fire("UNIT_HEALTH", unit);
        else boot.pump.fire(powerEvent(unit), unit);
      }
      phase = "step";
      now += 1 / 60;
      boot.bridge.runInMutationBatch(() => { seam.tick(now); boot.bridge.tick(1 / 60); });
      boot.bridge.flushDeferredPaint();
      phase = "idle";
      // Measured before the change: forty layout passes during the flush, one in the step.
      assert.equal(passes.flush, 0, `frame ${frame}: the flush reconciles nothing on its own`);
      // One, at the step's end, for what the flush held and what OnUpdate changed. The stock chat
      // fade's IsMouseOver/GetHeight and the cast bar's GetWidth read the page mid-step every frame;
      // no health text reaches those boxes, so they do not force a pass of their own.
      assert.equal(passes.step, 1, `frame ${frame}: ${passes.step} passes in the step`);
    }
    // The page shows what Lua last wrote: the drawn bars carry the values of the last events.
    for (const name of ["PlayerFrameHealthBar", "PetFrameHealthBar", "PartyMemberFrame1HealthBar"]) {
      const bar = boot.bridge.getFrame(name);
      const fill = renderer.elementFor(bar)?.children
        .find((child) => child.getAttribute("data-framexml-statusbar-value") !== null);
      assert.ok(fill, `${name} is drawn with its fill`);
      assert.equal(fill.getAttribute("data-framexml-statusbar-value"), String(bar.statusBar.value), name);
    }
    assert.equal(boot.vm.execute("WEBCLIENT_TEST_HEALTH = PlayerFrameHealthBar:GetValue()", "@deferral-read").ok, true);
    assert.equal(boot.vm.getGlobal("WEBCLIENT_TEST_HEALTH"), boot.bridge.getFrame("PlayerFrameHealthBar").statusBar.value);
  } finally {
    renderer?.destroy();
    boot.close();
    chain.close();
  }
});
