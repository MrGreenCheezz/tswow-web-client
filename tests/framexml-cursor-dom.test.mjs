import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";
import { frameXmlCursorWorldTarget } from "../dist/code/browser/framexml/FrameXmlCursorDom.js";

// The renderer's half of the cursor: a registered drag released over a frame runs that frame's
// OnReceiveDrag (ActionButton's PlaceAction, SpellButton_OnDrag, a bag slot, the stable) and does
// not also click it; the held thing's picture follows the pointer and never takes the mouse.
function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_namespace, tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: null, attributes,
      style, dataset: {}, hidden: false, className: "", textContent: "", value: "", disabled: false,
      classList: { add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); } },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      insertBefore(child, reference) {
        child.parentElement = node;
        const index = node.children.indexOf(reference);
        if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
      },
      remove() {
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = null;
      },
      closest(selector) {
        for (let current = node; current; current = current.parentElement) {
          if (selector === "[data-framexml-name]" && current.attributes.has("data-framexml-name")) return current;
          if (selector.startsWith("input") && ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(current.tagName)) return current;
        }
        return null;
      },
    };
    return node;
  }
  doc.head = make("head");
  doc.body = make("body");
  return doc;
}

globalThis.document = fakeDocument();

test("a registered drag released over a frame runs its OnReceiveDrag, once, and does not click it", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Drag.lua",
      "interface/framexml/drag.lua": `
        UIParent = CreateFrame("Frame", "UIParent")
        UIParent:SetSize(1024, 768)
        Log = ""
        local function button(name, x)
          local frame = CreateFrame("Button", name, UIParent)
          frame:SetSize(40, 40)
          frame:SetPoint("TOPLEFT", x, 0)
          frame:RegisterForClicks("AnyUp")
          frame:SetScript("OnClick", function() Log = Log .. name .. ":click;" end)
          return frame
        end
        local source = button("Source", 0)
        source:RegisterForDrag("LeftButton")
        source:SetScript("OnDragStart", function() Log = Log .. "start;" end)
        source:SetScript("OnDragStop", function() Log = Log .. "stop;" end)
        local target = button("Target", 100)
        target:SetScript("OnReceiveDrag", function() Log = Log .. "receive;" end)
        local icon = target:CreateTexture("TargetIcon", "ARTWORK")
        icon:SetAllPoints()
        button("Plain", 200)
      `,
    }), subset: ["Drag.lua"], exercise: false,
  });
  await boot.load();
  const host = document.createElement("section");
  const listeners = new Map();
  const doc = host.ownerDocument;
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => {
    const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);
  };
  doc.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  let stopped = 0;
  const send = (type, x, y, target) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      listener({ type, clientX: x, clientY: y, button: 0, target, stopPropagation: () => { stopped += 1; } });
    }
  };
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768 });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge, textureResolver: (path) => `/t/${path}` });
  try {
    renderer.mount(boot.roots);
    const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
    const log = () => boot.vm.getGlobal("Log");
    const drag = (target) => {
      element("Source").dispatchEvent({ type: "mousedown", target: element("Source"), clientX: 10, clientY: 10, button: 0 });
      send("mousemove", 60, 10, target);
      send("mouseup", 110, 10, target);
    };
    // Released over the target's icon texture: the button above it receives.
    drag(element("TargetIcon"));
    assert.equal(log(), "start;receive;stop;");
    assert.equal(stopped, 1, "the release is the drop's: the target's own mouseup (its OnClick) never runs");
    // Released over a button without the script: it took the mouse, nothing is dropped.
    boot.vm.execute('Log = ""', "@reset");
    drag(element("Plain"));
    assert.equal(log(), "start;stop;");
    // Released over nothing drawn: the hand keeps what it holds (no receive, no click).
    boot.vm.execute('Log = ""', "@reset");
    drag(null);
    assert.equal(log(), "start;stop;");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy();
    [doc.addEventListener, doc.removeEventListener] = previous;
    boot.close();
  }
});

test("the cursor picture follows the pointer, never takes the mouse, and goes with ClearCursor", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Empty.lua",
      "interface/framexml/empty.lua": `UIParent = CreateFrame("Frame", "UIParent")`,
    }), subset: ["Empty.lua"], exercise: false,
  });
  await boot.load();
  const host = document.createElement("section");
  const listeners = new Map();
  const doc = host.ownerDocument;
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => {
    const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);
  };
  doc.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge, textureResolver: (path) => `/t/${path}` });
  try {
    renderer.setCursorPicture("Interface\\Icons\\INV_Potion_54");
    const picture = doc.body.children.find((node) => node.getAttribute("data-framexml-cursor-picture") === "true");
    assert.ok(picture, "the picture is drawn over the page");
    assert.equal(picture.getAttribute("src"), "/t/Interface\\Icons\\INV_Potion_54");
    assert.equal(picture.style.pointerEvents, "none", "the drop still lands on the frame under it");
    for (const listener of listeners.get("mousemove") ?? []) listener({ type: "mousemove", clientX: 300, clientY: 200 });
    assert.equal(picture.style.left, "284px");
    assert.equal(picture.style.top, "184px");
    renderer.setCursorPicture(undefined);
    assert.equal(doc.body.children.includes(picture), false);
    assert.equal(listeners.get("mousemove")?.size ?? 0, 0, "no tracking while nothing is held");
  } finally {
    renderer.destroy();
    [doc.addEventListener, doc.removeEventListener] = previous;
    boot.close();
  }
});

test("only a press on the world lets go: never one on a drawn frame or a native control", () => {
  const doc = fakeDocument();
  const frame = doc.createElement("div");
  frame.setAttribute("data-framexml-name", "ActionButton1");
  const inner = doc.createElement("img");
  frame.append(inner);
  const input = doc.createElement("input");
  const canvas = doc.createElement("canvas");
  assert.equal(frameXmlCursorWorldTarget(inner), false);
  assert.equal(frameXmlCursorWorldTarget(input), false);
  assert.equal(frameXmlCursorWorldTarget(canvas), true);
  assert.equal(frameXmlCursorWorldTarget(null), false);
});
