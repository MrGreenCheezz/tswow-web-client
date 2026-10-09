// Review of lane L1 (03.10, items 1.10 / 5.24): a started drag released over a button that has no
// OnReceiveDrag must not click that button. Since `DropItemOnUnit` is real (FrameXmlDropItemOnUnit.ts),
// a unit button's click with a bag item held feeds the pet, proposes a trade or puts the item into an
// open trade (SECURE_ACTIONS.target, SecureTemplates.lua:402-415). The unit buttons (PetFrame,
// PartyMemberFrameN, TargetFrame) have no OnReceiveDrag, so in the browser the release of an item
// dragged out of a bag reached the button's own mouseup listener and ran its OnClick: a stack of food
// dragged across the pet's portrait fed the pet. The reference client clicks only on a release over the
// pressed frame, never after a started drag (benilla's reading of the mouse-up dispatcher,
// CPPClientExample/benilla/crates/benilla-ui/src/script/pointer.rs and cursor/drag.rs: `click = if
// started { None }`); the item stays on the cursor and a deliberate click on the portrait drops it.
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
      "interface/framexml/framexml.toc": "Drag.lua",
      "interface/framexml/drag.lua": `
        UIParent = CreateFrame("Frame", "UIParent")
        UIParent:SetSize(1024, 768)
        Log = ""
        local function button(name, x)
          local frame = CreateFrame("Button", name, UIParent)
          frame:SetSize(40, 40)
          frame:SetPoint("TOPLEFT", x, 0)
          frame:RegisterForClicks("LeftButtonUp", "RightButtonUp")
          frame:SetScript("OnClick", function(self, button) Log = Log .. name .. ":click;" end)
          return frame
        end
        -- A bag slot: picks up on drag start, takes a drop on itself.
        local bagSlot = button("BagSlot", 0)
        bagSlot:RegisterForDrag("LeftButton")
        bagSlot:SetScript("OnDragStart", function() Log = Log .. "start;" end)
        bagSlot:SetScript("OnReceiveDrag", function() Log = Log .. "BagSlot:receive;" end)
        -- A unit button: no OnReceiveDrag (PetFrame, PartyMemberFrame1, TargetFrame).
        local portrait = button("PetPortrait", 100)
        local art = portrait:CreateTexture("PetPortraitArt", "ARTWORK")
        art:SetAllPoints()
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
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768 });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge, textureResolver: (path) => `/t/${path}` });
  renderer.mount(boot.roots);
  const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
  /** A page event: the document's capture listeners first, then the target and its ancestors. */
  const send = (type, x, y, target) => {
    const event = {
      type, clientX: x, clientY: y, button: 0, detail: 1, target, stopped: false,
      stopPropagation() { this.stopped = true; }, preventDefault() {},
    };
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    if (!event.stopped && target) target.dispatchEvent(event);
  };
  const log = () => boot.vm.getGlobal("Log");
  const reset = () => boot.vm.execute('Log = ""', "@reset");
  const close = () => {
    renderer.destroy();
    [doc.addEventListener, doc.removeEventListener] = previous;
    boot.close();
  };
  return { element, send, log, reset, close, boot };
}

test("a started drag released over a button without OnReceiveDrag does not click it", async () => {
  const s = await scene();
  try {
    s.send("mousedown", 10, 10, s.element("BagSlot"));
    s.send("mousemove", 60, 10, s.element("PetPortraitArt"));
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "start;", "the drag started, and the portrait under the release was not clicked");
    assert.deepEqual(s.boot.errors, []);
  } finally { s.close(); }
});

test("ordinary clicks are unchanged: a press and release on the portrait, on the bag slot, and a drag that never started", async () => {
  const s = await scene();
  try {
    s.send("mousedown", 110, 10, s.element("PetPortraitArt"));
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "PetPortrait:click;", "a deliberate click on the portrait is its OnClick (DropItemOnUnit's route)");
    s.reset();
    s.send("mousedown", 10, 10, s.element("BagSlot"));
    s.send("mousemove", 11, 10, s.element("BagSlot"));
    s.send("mouseup", 11, 10, s.element("BagSlot"));
    assert.equal(s.log(), "BagSlot:click;", "under the threshold no drag starts: the release is the bag slot's click");
    s.reset();
    s.send("mousedown", 10, 10, s.element("BagSlot"));
    s.send("mousemove", 60, 10, s.element("BagSlot"));
    s.send("mouseup", 12, 10, s.element("BagSlot"));
    assert.equal(s.log(), "start;BagSlot:receive;", "a drop on a receiver is still its OnReceiveDrag, once");
    s.reset();
    // The next ordinary click after a drag is not swallowed.
    s.send("mousedown", 110, 10, s.element("PetPortraitArt"));
    s.send("mouseup", 110, 10, s.element("PetPortraitArt"));
    assert.equal(s.log(), "PetPortrait:click;");
    assert.deepEqual(s.boot.errors, []);
  } finally { s.close(); }
});
