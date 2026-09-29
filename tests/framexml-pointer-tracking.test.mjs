import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// A renderer whose page is off the display (the glue screens under the world, `Bootstrap.ts`'s
// `suspend`) follows no pointer: its window-level `pointermove` listener read the hidden stage's
// rectangle and offset box on every move over the world, a forced layout per frame of movement.

/** Listeners by type, as a window or a document holds them. */
function listenerTarget() {
  const listeners = new Map();
  return {
    listeners,
    count(type) { return listeners.get(type)?.size ?? 0; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    send(type, event) { for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...event }); },
  };
}

function fakePage() {
  const view = listenerTarget();
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
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      remove() {
        if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
      },
    };
    return node;
  }
  doc.head = make("head");
  return { doc, view };
}

const CURSOR_FIXTURE = {
  "interface/framexml/framexml.toc": "Cursor.lua",
  "interface/framexml/cursor.lua": `
    UIParent = CreateFrame("Frame", "UIParent")
    UIParent:SetSize(1000, 600)
    Owner = CreateFrame("Button", "Owner", UIParent)
    Owner:SetSize(100, 30)
    GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
    GameTooltip:Hide()
    Owner:SetScript("OnEnter", function(self)
      GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
      GameTooltip:SetText("Под курсором")
    end)
  `,
};

async function mounted() {
  const boot = new FrameXmlBoot({ provider: createFixtureProvider(CURSOR_FIXTURE), subset: ["Cursor.lua"], exercise: false });
  await boot.load();
  const { doc, view } = fakePage();
  const host = doc.createElement("section");
  let rectangleReads = 0;
  host.getBoundingClientRect = () => {
    rectangleReads += 1;
    return { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 };
  };
  host.offsetWidth = 1000;
  host.offsetHeight = 600;
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  renderer.mount(boot.roots);
  return { boot, renderer, doc, view, get rectangleReads() { return rectangleReads; } };
}

test("a paused renderer keeps no window listener and reads nothing when the pointer moves", async () => {
  const page = await mounted();
  const { boot, renderer, view } = page;
  try {
    assert.equal(view.count("pointermove"), 1);
    assert.equal(view.count("resize"), 1);
    view.send("pointermove", { clientX: 100, clientY: 500 });
    assert.deepEqual(boot.bridge.mousePosition, [100, 100], "a mounted renderer follows the pointer");
    const reads = page.rectangleReads;

    renderer.setPointerTracking(false);
    renderer.setPointerTracking(false);
    assert.equal(view.count("pointermove"), 0, "suspended: no pointer listener on the window");
    assert.equal(view.count("resize"), 0);
    view.send("pointermove", { clientX: 700, clientY: 100 });
    assert.equal(page.rectangleReads, reads, "and nothing measured while the world has the screen");
    assert.deepEqual(boot.bridge.mousePosition, [100, 100]);

    renderer.setPointerTracking(true);
    renderer.setPointerTracking(true);
    assert.equal(view.count("pointermove"), 1, "resumed once, not twice");
    assert.equal(view.count("resize"), 1);
    view.send("pointermove", { clientX: 700, clientY: 100 });
    assert.deepEqual(boot.bridge.mousePosition, [700, 500], "back on the display, the cursor is reported again");

    renderer.setPointerTracking(false);
    renderer.destroy();
    renderer.setPointerTracking(true);
    assert.equal(view.count("pointermove"), 0, "nothing re-arms a destroyed renderer");
  } finally { renderer.destroy(); boot.close(); }
});

test("a paused renderer drops the cursor tooltip's document listener, and no pass brings it back", async () => {
  const { boot, renderer, doc } = await mounted();
  try {
    const owner = renderer.elementFor(boot.bridge.getFrame("Owner"));
    owner.dispatchEvent({ type: "mouseenter", target: owner, clientX: 300, clientY: 200 });
    const tooltip = boot.bridge.getFrame("GameTooltip");
    assert.deepEqual(tooltip.tooltipCursorAnchor, { x: 0, y: 0 });
    assert.equal(doc.count("mousemove"), 1, "an ANCHOR_CURSOR tooltip follows the pointer");
    renderer.setPointerTracking(false);
    assert.equal(doc.count("mousemove"), 0);
    // A layout pass while suspended (a late name table redrawing the character list, say).
    const version = boot.bridge.mutationVersion;
    assert.equal(boot.vm.execute("Owner:SetWidth(120)", "@suspended-pass").ok, true);
    assert.ok(boot.bridge.mutationVersion > version, "the page was reconciled");
    assert.equal(doc.count("mousemove"), 0, "the pass does not re-arm it");
    renderer.setPointerTracking(true);
    assert.equal(doc.count("mousemove"), 1, "resumed with the tooltip still up, it follows again");
    assert.deepEqual(boot.errors, []);
  } finally { renderer.destroy(); boot.close(); }
});

test("the glue screens pause the renderer's pointer tracking on suspend and resume it on resume", async () => {
  // `Bootstrap.ts` imports its stylesheet and cannot be loaded here; its two handlers are read.
  const source = await readFile(new URL("../src/browser/glue/Bootstrap.ts", import.meta.url), "utf8");
  const body = (name) => {
    const start = source.indexOf(`    ${name}(`);
    assert.ok(start >= 0, `${name} is in the handle`);
    const end = source.indexOf("\n    },", start);
    return source.slice(start, end);
  };
  assert.match(body("suspend"), /renderer\.setPointerTracking\(false\);/);
  assert.match(body("resume"), /renderer\.setPointerTracking\(true\);/);
});
