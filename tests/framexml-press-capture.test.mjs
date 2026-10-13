// Plan item 1.10 (12.10): a release belongs to the frame that took the press. Wow.exe 3.3.5a's mouse-down
// (0x00495470) stores the frame under the mouse in CSimpleTop +0x7c and the mouse-up (0x004947a0) hands the release
// to +0x7c alone (vtable +0xb0), letting it go once no button is held; with nothing captured the world has the
// release (.runtime/re-2026-10-11/glue-1110/a347-6.txt, a347-10.txt). In the browser a mouseup reaches whatever is
// under the pointer, so a press on a bar button or on the world released over a unit portrait clicked the portrait
// (SecureUnitButton: with an item on the cursor that click is DropItemOnUnit), and a release over a frame with an
// OnMouseUp (Minimap's ping) ran it. The L1 review fixed the started drag's release (framexml-drag-release-no-click);
// this is the press that never became a drag.
import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

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
      // Bubbles to the ancestors, as a page event does, unless a listener stops it.
      dispatchEvent(event) {
        for (let current = node; current && !event.stopped; current = current.parentElement) {
          for (const listener of current.listeners?.get(event.type) ?? []) listener(event);
        }
      },
      listeners,
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

async function scene() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Press.lua",
      "interface/framexml/press.lua": `
        UIParent = CreateFrame("Frame", "UIParent")
        UIParent:SetSize(1024, 768)
        Log = ""
        local function button(name, x)
          local frame = CreateFrame("Button", name, UIParent)
          frame:SetSize(40, 40)
          frame:SetPoint("TOPLEFT", x, 0)
          frame:RegisterForClicks("LeftButtonUp", "RightButtonUp")
          frame:SetScript("OnClick", function(self, button) Log = Log .. name .. ":" .. button .. ";" end)
          return frame
        end
        -- A bar button: no drag, nothing on the cursor.
        button("BarButton", 0)
        -- A unit button (SecureUnitButton: PetFrame, PartyMemberFrame1, TargetFrame) with its portrait art.
        local portrait = button("PetPortrait", 100)
        local art = portrait:CreateTexture("PetPortraitArt", "ARTWORK")
        art:SetAllPoints()
        -- A frame that answers OnMouseUp, as Minimap's ping does (Minimap.xml: Minimap_OnClick).
        local pinger = CreateFrame("Frame", "Pinger", UIParent)
        pinger:SetSize(40, 40)
        pinger:SetPoint("TOPLEFT", 200, 0)
        pinger:EnableMouse(true)
        pinger:SetScript("OnMouseDown", function(self, button) Log = Log .. "Pinger:down;" end)
        pinger:SetScript("OnMouseUp", function(self, button) Log = Log .. "Pinger:up;" end)
      `,
    }), subset: ["Press.lua"], exercise: false,
  });
  await boot.load();
  const host = document.createElement("section");
  const listeners = new Map();
  const windowListeners = new Map();
  const doc = host.ownerDocument;
  const previous = [doc.addEventListener, doc.removeEventListener, doc.defaultView];
  doc.addEventListener = (type, listener) => {
    const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);
  };
  doc.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  doc.defaultView = {
    addEventListener(type, listener) {
      const set = windowListeners.get(type) ?? new Set(); set.add(listener); windowListeners.set(type, set);
    },
    removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
  };
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768 });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge, textureResolver: (path) => `/t/${path}` });
  renderer.mount(boot.roots);
  const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
  // The 3D canvas: on the page, not inside the UI's container.
  const world = document.createElement("canvas");
  /** A page event: the window's and the document's capture listeners first, then the target and its ancestors. */
  const send = (type, x, y, target, button = 0, buttons = type === "mousedown" ? (button === 2 ? 2 : 1) : 0) => {
    const event = {
      type, clientX: x, clientY: y, button, buttons, detail: 1, target, stopped: false,
      stopPropagation() { this.stopped = true; }, preventDefault() {},
    };
    for (const listener of [...(windowListeners.get(type) ?? [])]) listener(event);
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    if (!event.stopped && target) target.dispatchEvent(event);
  };
  const log = () => boot.vm.getGlobal("Log");
  const reset = () => boot.vm.execute('Log = ""', "@reset");
  const close = () => {
    renderer.destroy();
    [doc.addEventListener, doc.removeEventListener, doc.defaultView] = previous;
    boot.close();
  };
  return { element, world, send, log, reset, close, boot, windowListeners };
}

test("a press on another button, released over the portrait, clicks neither", async () => {
  const s = await scene();
  try {
    s.send("mousedown", 10, 10, s.element("BarButton"));
    s.send("mousemove", 110, 10, s.element("PetPortraitArt"));
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "", "the portrait under the release did not take the press: no OnClick, no DropItemOnUnit");
    s.send("mousedown", 10, 10, s.element("BarButton"));
    s.send("mouseup", 210, 10, s.element("Pinger"));
    assert.equal(s.log(), "", "nor does a frame with OnMouseUp under the release hear it");
    assert.deepEqual(s.boot.errors, []);
  } finally { s.close(); }
});

test("a press on the world, released over the portrait or an OnMouseUp frame, reaches no frame", async () => {
  const s = await scene();
  try {
    s.send("mousedown", 600, 400, s.world, 2);
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"), 2);
    assert.equal(s.log(), "", "turning the camera and letting go over the portrait opens no unit menu");
    s.send("mousedown", 600, 400, s.world, 2);
    s.send("mouseup", 210, 10, s.element("Pinger"), 2);
    assert.equal(s.log(), "", "nor pings the minimap");
    // A press on the portrait let go over the world ends there; the next press, on the world, owns its release.
    s.send("mousedown", 110, 10, s.element("PetPortraitArt"));
    s.send("mouseup", 600, 400, s.world);
    s.send("mousedown", 600, 400, s.world);
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "", "the portrait's old press is not revived by a release over it");
    assert.deepEqual(s.boot.errors, []);
  } finally { s.close(); }
});

test("ordinary presses are unchanged; a release without a press clicks nothing", async () => {
  const s = await scene();
  try {
    s.send("mousedown", 110, 10, s.element("PetPortraitArt"));
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "PetPortrait:LeftButton;", "a press and release on the portrait is its OnClick");
    s.reset();
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "", "the capture ended with the release: a stray release is nobody's click");
    s.send("mousedown", 110, 10, s.element("PetPortrait"), 2);
    s.send("mouseup", 110, 10, s.element("PetPortrait"), 2);
    assert.equal(s.log(), "PetPortrait:RightButton;", "the right button too (the unit menu)");
    s.reset();
    s.send("mousedown", 210, 10, s.element("Pinger"));
    s.send("mouseup", 210, 10, s.element("Pinger"));
    assert.equal(s.log(), "Pinger:down;Pinger:up;", "a press and release on the OnMouseUp frame runs both");
    s.reset();
    s.send("mousedown", 210, 10, s.element("Pinger"));
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "Pinger:down;Pinger:up;", "the frame that took the press hears its release wherever it is; the portrait does not");
    assert.deepEqual(s.boot.errors, []);
  } finally { s.close(); }
});

test("while a button is held the held frame keeps the capture (0x00495470 reads +0x7c first)", async () => {
  const s = await scene();
  try {
    s.send("mousedown", 110, 10, s.element("PetPortraitArt"), 0, 1);
    s.send("mousedown", 10, 10, s.element("BarButton"), 2, 3);
    s.send("mouseup", 10, 10, s.element("BarButton"), 2, 1);
    assert.equal(s.log(), "", "the right press went to the held portrait: its release over the bar button clicks nothing");
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"), 0, 0);
    assert.equal(s.log(), "PetPortrait:LeftButton;", "the left release over the portrait is still its click");
    s.reset();
    s.send("mouseup", 10, 10, s.element("BarButton"), 0, 0);
    assert.equal(s.log(), "", "the last release let the capture go");
    assert.deepEqual(s.boot.errors, []);
  } finally { s.close(); }
});

test("the press listeners live on the window and go with the renderer", async () => {
  const s = await scene();
  assert.equal(s.windowListeners.get("mousedown")?.size, 1);
  assert.equal(s.windowListeners.get("mouseup")?.size, 1);
  s.close();
  assert.equal(s.windowListeners.get("mousedown")?.size, 0, "destroy removes the press listener");
  assert.equal(s.windowListeners.get("mouseup")?.size, 0);
});
