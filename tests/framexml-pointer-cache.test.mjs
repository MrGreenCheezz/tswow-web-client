import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// P1-18 (UI-11): following the pointer reads no layout on a stable page. `rememberCursor` read the
// container's `getBoundingClientRect()` and offset box on every window `pointermove`, every widget
// enter/leave and press; the box is kept now, dropped by a window resize, any `ResizeObserver` call,
// a scroll, a resume, a mount and a 250 ms expiry.

/**
 * Listeners by type, as a window or a document holds them: one registration per (listener, capture),
 * removed only by a call with the same capture flag, as the DOM does it.
 */
function listenerTarget() {
  const listeners = new Map();
  const captureOf = (options) => (typeof options === "boolean" ? options : Boolean(options?.capture));
  return {
    listeners,
    count(type) { return listeners.get(type)?.size ?? 0; },
    addEventListener(type, listener, options) {
      if (!listeners.has(type)) listeners.set(type, new Map());
      const key = `${captureOf(options)}`;
      const entries = listeners.get(type);
      if (![...entries.values()].some((entry) => entry.listener === listener && entry.key === key)) {
        entries.set(Symbol(), { listener, key });
      }
    },
    removeEventListener(type, listener, options) {
      const entries = listeners.get(type);
      const key = `${captureOf(options)}`;
      for (const [id, entry] of entries ?? []) if (entry.listener === listener && entry.key === key) entries.delete(id);
    },
    send(type, event) {
      for (const { listener } of [...(listeners.get(type)?.values() ?? [])]) listener({ type, ...event });
    },
  };
}

function fakePage() {
  const view = listenerTarget();
  const observers = [];
  view.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { observers.splice(observers.indexOf(this), 1); }
  };
  const doc = { ...listenerTarget(), defaultView: view };
  doc.createElement = (tag) => make(tag);
  doc.createElementNS = (_namespace, tag) => make(tag);
  function make(tag) {
    const attributes = new Map();
    const own = listenerTarget();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: undefined,
      style: { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } },
      dataset: {}, className: "", hidden: false, textContent: "",
      classList: { add() {} },
      addEventListener: own.addEventListener, removeEventListener: own.removeEventListener,
      dispatchEvent(event) { own.send(event.type, event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      // Every drawn box is somewhere on the page: the element rectangles stay live reads.
      getBoundingClientRect() { return { left: 100, top: 100, width: 50, height: 20, right: 150, bottom: 120 }; },
      offsetWidth: 50, offsetHeight: 20,
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      remove() {
        if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
      },
    };
    return node;
  }
  doc.head = make("head");
  return { doc, view, observers };
}

const FIXTURE = {
  "interface/framexml/framexml.toc": "PointerFonts.xml\nPointer.lua",
  "interface/framexml/pointerfonts.xml": `<Ui>
    <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
    <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
  </Ui>`,
  "interface/framexml/pointer.lua": `
    UIParent = CreateFrame("Frame", "UIParent")
    UIParent:SetSize(1000, 600)
    Plate = CreateFrame("Button", "Plate", UIParent)
    Plate:SetSize(100, 30)
    Plate:SetPoint("CENTER")
    -- One tooltip under UIParent, one drawn straight in the container (no parent): both follow the
    -- cursor, so their layout, clamp and cursor placement all run on a move.
    GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
    GameTooltip:Hide()
    FreeTip = CreateFrame("GameTooltip", "FreeTip")
    FreeTip:Hide()
    function ShowTips()
      GameTooltip:SetOwner(Plate, "ANCHOR_CURSOR")
      GameTooltip:AddLine("Под курсором")
      GameTooltip:AddLine("Вторая строка")
      GameTooltip:Show()
      FreeTip:SetOwner(Plate, "ANCHOR_CURSOR")
      FreeTip:AddLine("Без родителя")
      FreeTip:Show()
    end
  `,
};

/** The container as the page has it: a stage drawn at 2× from (40, 30), 500×300 layout pixels. */
const BOX = { left: 40, top: 30, width: 1000, height: 600, right: 1040, bottom: 630 };

async function mounted() {
  const boot = new FrameXmlBoot({ provider: createFixtureProvider(FIXTURE), subset: ["PointerFonts.xml", "Pointer.lua"], exercise: false });
  await boot.load();
  const { doc, view, observers } = fakePage();
  const host = doc.createElement("section");
  const counts = { rect: 0, offset: 0 };
  let box = { ...BOX };
  host.getBoundingClientRect = () => {
    counts.rect += 1;
    return { ...box };
  };
  Object.defineProperty(host, "offsetWidth", { get() { counts.offset += 1; return 500; } });
  Object.defineProperty(host, "offsetHeight", { get() { counts.offset += 1; return 300; } });
  const clock = { now: 1000 };
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge, boxClock: () => clock.now });
  renderer.mount(boot.roots);
  return {
    boot, renderer, doc, view, observers, counts, clock, host,
    moveBox(next) { box = { ...box, ...next }; },
    /** What a direct read gives for a client point: the old `rememberCursor` arithmetic. */
    expected(x, y) {
      const rect = box;
      return [(x - rect.left) * 500 / rect.width, 300 - (y - rect.top) * 300 / rect.height];
    },
  };
}

test("fifty pointer moves on a stable page read the container box at most once", async () => {
  const page = await mounted();
  const { boot, renderer, view, counts } = page;
  try {
    const rect = counts.rect;
    const offset = counts.offset;
    for (let index = 0; index < 50; index++) {
      const x = 100 + index * 7;
      const y = 600 - index * 5;
      view.send("pointermove", { clientX: x, clientY: y });
      assert.deepEqual(boot.bridge.mousePosition, page.expected(x, y), `move ${index} reports the cursor a direct read gives`);
    }
    assert.ok(counts.rect - rect <= 1, `rectangle reads over 50 moves: ${counts.rect - rect}`);
    assert.ok(counts.offset - offset <= 2, `offset reads over 50 moves: ${counts.offset - offset}`);
    assert.deepEqual(boot.errors, []);
  } finally { renderer.destroy(); boot.close(); }
});

test("a resize, an observer call, a scroll, a resume and the 250 ms expiry each read the box once", async () => {
  const page = await mounted();
  const { boot, renderer, view, observers, counts, clock } = page;
  try {
    const move = (x, y) => view.send("pointermove", { clientX: x, clientY: y });
    move(200, 200); // warm
    const settled = () => {
      const before = counts.rect;
      move(210, 220);
      move(230, 240);
      return counts.rect - before;
    };
    assert.equal(settled(), 0, "a warm box is not read again");

    const reset = (label, action) => {
      action();
      const before = counts.rect;
      move(300, 310);
      move(320, 330);
      move(340, 350);
      assert.equal(counts.rect - before, 1, `${label}: exactly one new read`);
      assert.deepEqual(boot.bridge.mousePosition, page.expected(340, 350), `${label}: the cursor a direct read gives`);
    };

    reset("window resize", () => { page.moveBox({ left: 0, top: 0, right: 1000, bottom: 600 }); view.send("resize", {}); });
    // The same size from the observer's side: the stage only moved, and the call still counts.
    assert.equal(observers.length, 1, "the container is observed");
    reset("observer call", () => { page.moveBox({ left: 12, right: 1012 }); observers[0].callback([]); });
    reset("scroll", () => { page.moveBox({ top: -40, bottom: 560 }); view.send("scroll", {}); });
    reset("resume", () => {
      renderer.setPointerTracking(false);
      page.moveBox({ left: 5, right: 1005 });
      renderer.setPointerTracking(true);
    });

    // The expiry: 249 ms keeps the box, 250 ms reads it once.
    move(400, 400);
    clock.now += 249;
    assert.equal(settled(), 0, "within 250 ms the kept box answers");
    page.moveBox({ left: 60, right: 1060 });
    clock.now += 1;
    assert.equal(settled(), 1, "at 250 ms it is read again");
    assert.deepEqual(boot.bridge.mousePosition, page.expected(230, 240));
    assert.equal(settled(), 0, "and kept from there");
    assert.deepEqual(boot.errors, []);
  } finally { renderer.destroy(); boot.close(); }
});

test("widget enter and leave on a warm box read no container layout", async () => {
  const page = await mounted();
  const { boot, renderer, view, counts } = page;
  try {
    view.send("pointermove", { clientX: 500, clientY: 300 });
    const element = renderer.elementFor(boot.bridge.getFrame("Plate"));
    assert.ok(element, "the button is drawn");
    const before = counts.rect;
    for (let index = 0; index < 10; index++) {
      for (const type of ["pointerenter", "mouseenter", "pointerleave", "mouseleave"]) {
        element.dispatchEvent({ type, target: element, clientX: 520 + index, clientY: 310 });
      }
    }
    assert.equal(counts.rect - before, 0, "enter/leave keep to the kept box");
    assert.deepEqual(boot.bridge.mousePosition, page.expected(529, 310));
    assert.deepEqual(boot.errors, []);
  } finally { renderer.destroy(); boot.close(); }
});

test("a renderer with no movable box keeps reading: an unlaid container is not cached", async () => {
  const page = await mounted();
  const { boot, renderer, view, counts } = page;
  try {
    page.moveBox({ width: 0, height: 0, right: 40, bottom: 30 });
    view.send("resize", {});
    const before = counts.rect;
    view.send("pointermove", { clientX: 10, clientY: 10 });
    view.send("pointermove", { clientX: 20, clientY: 20 });
    assert.equal(counts.rect - before, 2, "a zero-size box is measured on each move, as before");
    page.moveBox({ ...BOX });
    view.send("pointermove", { clientX: 140, clientY: 130 });
    assert.deepEqual(boot.bridge.mousePosition, page.expected(140, 130), "and the laid-out box is seen at once");
  } finally { renderer.destroy(); boot.close(); }
});

test("pause and destroy take every window listener with them, scroll included, capture flags matched", async () => {
  const page = await mounted();
  const { boot, renderer, view } = page;
  try {
    const types = ["pointermove", "resize", "scroll"];
    const counts = () => Object.fromEntries(types.map((type) => [type, view.count(type)]));
    assert.deepEqual(counts(), { pointermove: 1, resize: 1, scroll: 1 }, "mounted");
    renderer.setPointerTracking(false);
    assert.deepEqual(counts(), { pointermove: 0, resize: 0, scroll: 0 }, "paused");
    renderer.setPointerTracking(true);
    assert.deepEqual(counts(), { pointermove: 1, resize: 1, scroll: 1 }, "resumed once");
    renderer.destroy();
    assert.deepEqual(counts(), { pointermove: 0, resize: 0, scroll: 0 }, "destroyed");
  } finally { renderer.destroy(); boot.close(); }
});

test("tooltip layout, clamp, cursor placement and IsMouseOver read no container box while it is kept", async () => {
  const page = await mounted();
  const { boot, renderer, view, doc, counts } = page;
  try {
    const run = (source, results = 0) => {
      const chunk = boot.vm.compileFunction(source, "@pointer-cache", []);
      assert.ok(chunk, source);
      try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
    };
    view.send("pointermove", { clientX: 300, clientY: 200 }); // warm
    const before = counts.rect;
    run("ShowTips()");
    const tip = renderer.elementFor(boot.bridge.getFrame("GameTooltip"));
    const free = renderer.elementFor(boot.bridge.getFrame("FreeTip"));
    assert.ok(tip && !tip.hidden && free && !free.hidden, "both tooltips are drawn");
    assert.equal(free.parentElement, page.host, "FreeTip is drawn straight in the container");
    assert.equal(tip.style.display, "grid", "GameTooltip was laid out (`layoutGameTooltip`)");
    assert.equal(doc.count("mousemove"), 1, "and they follow the cursor");
    for (let index = 0; index < 5; index++) doc.send("mousemove", { clientX: 320 + index, clientY: 210 });
    assert.equal(free.style.left, `${(324 - BOX.left) / 2 + 16}px`, "the cursor placement used the container's box");
    assert.deepEqual(run("return Plate:IsMouseOver(), GameTooltip:IsMouseOver()", 2).length, 2);
    assert.equal(counts.rect - before, 0, `container rectangle reads: ${counts.rect - before}`);
    // A stale box is still dropped by the next resize, and every one of those paths reads it once.
    view.send("resize", {});
    run("ShowTips()");
    assert.equal(counts.rect - before, 1, "one read after a resize");
    assert.deepEqual(boot.errors, []);
  } finally { renderer.destroy(); boot.close(); }
});

test("mount and addRoots drop the kept box", async () => {
  const page = await mounted();
  const { boot, renderer, view, counts } = page;
  try {
    view.send("pointermove", { clientX: 300, clientY: 200 }); // warm
    page.moveBox({ left: 0, top: 0, right: 1000, bottom: 600 });
    renderer.mount(boot.roots);
    let before = counts.rect;
    view.send("pointermove", { clientX: 310, clientY: 210 });
    assert.deepEqual(boot.bridge.mousePosition, page.expected(310, 210), "after mount, the new box");
    assert.ok(counts.rect - before <= 1);

    page.moveBox({ left: 20, top: 10, right: 1020, bottom: 610 });
    assert.equal(boot.vm.execute(`Extra = CreateFrame("Frame", "Extra")`, "@extra").ok, true);
    renderer.addRoots([boot.bridge.getFrame("Extra")]);
    before = counts.rect;
    view.send("pointermove", { clientX: 330, clientY: 230 });
    assert.deepEqual(boot.bridge.mousePosition, page.expected(330, 230), "after addRoots, the new box");
    assert.ok(counts.rect - before <= 1);
    assert.deepEqual(boot.errors, []);
  } finally { renderer.destroy(); boot.close(); }
});
