import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// 3.24 (12.10): a drag whose OnDragStart calls StartMoving on another frame moves that frame — Blizzard_RaidUI's
// group label opens a new pullout window and starts moving it (RaidPulloutButton_OnDragStart,
// Blizzard_RaidUI.lua:1148-1159); its OnDragStop (RaidPulloutStopMoving, :1161-1177) clears the window's points
// and re-anchors it at its own GetCenter/GetTop, which a cleared frame still answers (Wow.exe keeps the rect).

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_namespace, tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) {
        delete this[name];
        if (!name.startsWith("--") && name.includes("-")) this[name.replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase())] = "";
      },
    };
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined, attributes, style,
      dataset: {}, hidden: false, className: "", src: "", textContent: "", value: "", disabled: false,
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
        node.parentElement = undefined;
      },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

globalThis.document ??= fakeDocument();

const SCENE = `
  UIParent = CreateFrame("Frame", "UIParent")
  UIParent:SetSize(1024, 768)
  -- The group label: a button that drags, inside a window that does not move.
  Tab = CreateFrame("Frame", "Tab", UIParent)
  Tab:SetSize(300, 400)
  Tab:SetPoint("TOPLEFT", 10, -10)
  Label = CreateFrame("Button", "Label", Tab)
  Label:SetSize(100, 20)
  Label:SetPoint("TOPLEFT", 10, -10)
  Label:RegisterForDrag("LeftButton")
  -- The pullout: a separate movable window the label's drag opens and starts moving.
  Pullout = CreateFrame("Button", "Pullout", UIParent)
  Pullout:SetMovable(true)
  Pullout:SetSize(80, 120)
  Pullout:Hide()
  Label:SetScript("OnDragStart", function()
    local x, y = GetCursorPosition()
    Pullout:Show()
    Pullout:StartMoving()
    Pullout:ClearAllPoints()
    Pullout:SetPoint("TOP", nil, "BOTTOMLEFT", x, y)
  end)
  Label:SetScript("OnDragStop", function()
    Pullout:StopMovingOrSizing()
    Pullout:ClearAllPoints()
    local x = Pullout:GetCenter()
    local y = Pullout:GetTop()
    Pullout:SetPoint("TOP", nil, "BOTTOMLEFT", x, y)
    Dropped = x .. ":" .. y
  end)
`;

test("3.24: StartMoving in OnDragStart moves that frame, and a cleared frame keeps its place for GetCenter", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({ "interface/framexml/framexml.toc": "Scene.lua", "interface/framexml/scene.lua": SCENE }),
    subset: ["Scene.lua"], exercise: false,
  });
  await boot.load();
  const host = document.createElement("section");
  const events = new Map();
  const doc = host.ownerDocument;
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => { const set = events.get(type) ?? new Set(); set.add(listener); events.set(type, set); };
  doc.removeEventListener = (type, listener) => events.get(type)?.delete(listener);
  const stage = { left: 0, top: 0, width: 1024, height: 768 };
  host.offsetWidth = 1024; host.offsetHeight = 768;
  host.getBoundingClientRect = () => ({ ...stage, right: stage.width, bottom: stage.height });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  const rect = (frame) => {
    const authored = boot.bridge.geometry(frame);
    const left = authored.left;
    const top = 768 - authored.top;
    return { left, top, width: authored.width, height: authored.height, right: left + authored.width, bottom: top + authored.height };
  };
  const deliver = (type, x, y, target) => {
    const event = { type, clientX: x, clientY: y, button: 0, target, preventDefault() {}, stopPropagation() {} };
    for (const listener of [...(events.get(type) ?? [])]) listener(event);
    target?.dispatchEvent(event);
  };
  try {
    renderer.mount(boot.roots);
    const attach = () => {
      for (const frame of boot.bridge.frames) {
        const node = renderer.elementFor(frame);
        if (!node || node.getBoundingClientRect) continue;
        Object.defineProperties(node, {
          offsetWidth: { get: () => boot.bridge.geometry(frame).width },
          offsetHeight: { get: () => boot.bridge.geometry(frame).height },
        });
        node.getBoundingClientRect = () => rect(frame);
      }
    };
    attach();
    const label = renderer.elementFor(boot.bridge.getFrame("Label"));
    const pullout = boot.bridge.getFrame("Pullout");
    deliver("mousedown", 30, 25, label);
    deliver("mousemove", 400, 300, label);
    attach();
    assert.equal(pullout.moving, true, "OnDragStart started moving the pullout");
    const opened = rect(pullout);
    assert.equal(opened.left, 400 - 40, "it opened with its top centre under the cursor");
    deliver("mousemove", 500, 350);
    assert.equal(rect(pullout).left, opened.left + 100, "and follows the cursor though it is not the label's ancestor");
    assert.equal(rect(pullout).top, opened.top + 50);
    deliver("mouseup", 500, 350, label);
    assert.equal(pullout.moving, false);
    assert.equal(boot.vm.getGlobal("Dropped"), `${opened.left + 100 + 40}:${768 - (opened.top + 50)}`,
      "OnDragStop's GetCenter/GetTop after ClearAllPoints answered the dropped place");
    assert.equal(rect(pullout).left, opened.left + 100, "and the pullout stays there");
    assert.equal(rect(boot.bridge.getFrame("Tab")).left, 10, "the label's window never moved");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy(); boot.close();
    [doc.addEventListener, doc.removeEventListener] = previous;
  }
});
