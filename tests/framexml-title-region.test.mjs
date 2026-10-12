import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// Plan item 3.48 (12.10): Frame:CreateTitleRegion, Frame:GetTitleRegion and `<TitleRegion>`, as Wow.exe 3.3.5a 12340
// has them (read-only Ghidra, FrameXmlTitleRegion.ts): CreateTitleRegion (0x0049e630) makes the frame's one title region
// or hands back the one it has with its points cleared; GetTitleRegion (0x0049e5b0) answers it or nil; the region is a
// plain "Region" (0x004881c0), neither a child frame nor a layered region; the frame loader (0x004932c0) builds one per
// `<TitleRegion>` (LootFrame's `setAllPoints="true"`). A press inside a shown title region of the frame that took the
// mouse moves that frame from the press (0x00495470 → 0x00494060 mode 2, no `movable` test, any button) and is spent:
// no OnMouseDown; the release ends it (0x004947a0) and is spent too: no OnMouseUp.

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

const WINDOWS = `
  UIParent = CreateFrame("Frame", "UIParent")
  UIParent:SetSize(1248, 768)
  -- MSBT's options window (MSBTOptionsMain.lua:146-161): a title strip 50 units in and 10 down, 525 by 20.
  Main = CreateFrame("Frame", "Main", UIParent)
  Main:SetMovable(true)
  Main:EnableMouse(true)
  Main:SetSize(600, 400)
  Main:SetPoint("CENTER")
  Downs, Ups = 0, 0
  Main:SetScript("OnMouseDown", function() Downs = Downs + 1 end)
  Main:SetScript("OnMouseUp", function() Ups = Ups + 1 end)
  Title = Main:CreateTitleRegion()
  Title:SetWidth(525)
  Title:SetHeight(20)
  Title:SetPoint("TOPLEFT", Main, "TOPLEFT", 50, -10)
  -- A button-less child that takes the mouse, over the title strip's right end.
  Child = CreateFrame("Frame", "Child", Main)
  Child:EnableMouse(true)
  Child:SetSize(40, 20)
  Child:SetPoint("TOPRIGHT", Main, "TOPRIGHT", -40, -10)
  -- A child that does not take the mouse, over the strip's left part: a press passes through it.
  Glass = CreateFrame("Frame", "Glass", Main)
  Glass:SetSize(40, 20)
  Glass:SetPoint("TOPLEFT", Main, "TOPLEFT", 100, -10)
  Plain = CreateFrame("Frame", "Plain", UIParent)
  -- FloatingChatFrameTemplate's shape: a title region over a frame that does not take the mouse.
  Inert = CreateFrame("Frame", "Inert", UIParent)
  Inert:SetSize(200, 100)
  Inert:SetPoint("BOTTOMLEFT")
  Inert:CreateTitleRegion():SetAllPoints(Inert)
  InertDowns = 0
  Inert:SetScript("OnMouseDown", function() InertDowns = InertDowns + 1 end)
`;

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "title-region", []);
  assert.ok(fn, code);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

async function booted(files = {}) {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Windows.lua\nLoot.xml",
      "interface/framexml/windows.lua": WINDOWS,
      "interface/framexml/loot.xml": `<Ui><Frame name="Loot" parent="UIParent" movable="true" enableMouse="true">
        <Size><AbsDimension x="256" y="256"/></Size>
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="0" y="-104"/></Offset></Anchor></Anchors>
        <TitleRegion setAllPoints="true"/>
      </Frame></Ui>`,
      ...files,
    }), subset: ["Windows.lua", "Loot.xml"], exercise: false,
  });
  await boot.load();
  return boot;
}

test("3.48: CreateTitleRegion makes the frame's one Region, GetTitleRegion answers it, `<TitleRegion>` builds one", async () => {
  const boot = await booted();
  try {
    assert.deepEqual(boot.errors, []);
    assert.deepEqual(lua(boot, "return select('#', Plain:GetTitleRegion()), Plain:GetTitleRegion()", 2), [1, undefined],
      "nil for a frame without one");
    assert.deepEqual(lua(boot, `return Title:GetObjectType(), Title:IsObjectType("Region"), Title:IsObjectType("Frame"),
      Title:GetParent() == Main, Main:GetTitleRegion() == Title, Title:IsShown()`, 6),
    ["Region", true, false, true, true, true], "a plain Region of the frame's, shown");
    assert.deepEqual(lua(boot, "return Title:GetWidth(), Title:GetHeight(), Title:GetNumPoints()", 3), [525, 20, 1]);
    assert.deepEqual(lua(boot, "return Title:GetLeft() - Main:GetLeft(), Main:GetTop() - Title:GetTop()", 2), [50, 10]);
    assert.deepEqual(lua(boot, "return #{ Main:GetChildren() }, #{ Main:GetRegions() }", 2), [2, 0],
      "neither a child frame (Child and Glass are the two) nor a layered region");
    assert.deepEqual(lua(boot, "return Main:CreateTitleRegion() == Title, Title:GetNumPoints()", 2), [true, 0],
      "a second CreateTitleRegion hands back the same region, its points cleared (0x0048a200)");
    assert.deepEqual(lua(boot, "local r = Loot:GetTitleRegion() return r:GetObjectType(), r:GetNumPoints(), r:GetWidth()", 3),
      ["Region", 2, 256], "<TitleRegion setAllPoints=\"true\"/> spans its frame");
  } finally {
    boot.close();
  }
});

test("3.48: a press inside the title region moves the frame and is spent; elsewhere it is the frame's own", async () => {
  const boot = await booted();
  const host = document.createElement("section");
  const events = new Map();
  const doc = host.ownerDocument;
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => { const set = events.get(type) ?? new Set(); set.add(listener); events.set(type, set); };
  doc.removeEventListener = (type, listener) => events.get(type)?.delete(listener);
  const countListeners = () => [...events.values()].reduce((sum, set) => sum + set.size, 0);
  const stage = { left: 80, top: 40, width: 624, height: 384 }; // the 1248x768 UI drawn at half size
  host.offsetWidth = 1248; host.offsetHeight = 768;
  host.getBoundingClientRect = () => ({ ...stage, right: stage.left + stage.width, bottom: stage.top + stage.height });
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  const size = (frame) => ({ width: Number(frame.attributes.width) || 0, height: Number(frame.attributes.height) || 0 });
  const rect = (frame) => {
    const authored = boot.bridge.geometry(frame);
    const element = renderer.elementFor(frame);
    const shift = (element?.style.translate ?? "0px 0px").split(" ").map(parseFloat);
    const left = stage.left + (authored.left + (shift[0] || 0)) * 0.5;
    const top = stage.top + (768 - authored.top + (shift[1] || 0)) * 0.5;
    return { left, top, width: authored.width * 0.5, height: authored.height * 0.5,
      right: left + authored.width * 0.5, bottom: top + authored.height * 0.5 };
  };
  /**
   * One event to the document's capture listeners, then to the element it lands on and up through `ancestors` (the
   * bubbling the fake DOM does not do), as a browser delivers it.
   */
  const deliver = (type, x, y, target, button = 0, ancestors = []) => {
    let stopped = false;
    const event = { type, clientX: x, clientY: y, button, target, preventDefault() {}, stopPropagation() { stopped = true; } };
    for (const listener of [...(events.get(type) ?? [])]) listener(event);
    for (const element of [target, ...ancestors]) {
      if (stopped || element === undefined) break;
      element.dispatchEvent(event);
    }
    return event;
  };
  try {
    renderer.mount(boot.roots);
    for (const frame of boot.bridge.frames) {
      const node = renderer.elementFor(frame);
      if (!node) continue;
      Object.defineProperties(node, { offsetWidth: { get: () => size(frame).width }, offsetHeight: { get: () => size(frame).height } });
      node.getBoundingClientRect = () => rect(frame);
    }
    boot.bridge.touch();
    const main = boot.bridge.getFrame("Main");
    const node = renderer.elementFor(main);
    assert.ok(node, "the window is drawn");
    assert.equal(renderer.elementFor(boot.vm.getGlobal("Title")), undefined, "the title region is never drawn");
    const start = rect(main);
    // Inside the strip (50 + 10 units in, 10 + 5 down), the right button: the frame moves at once, nothing else runs.
    const x = start.left + 30;
    const y = start.top + 7;
    deliver("mousedown", x, y, node, 2);
    assert.equal(boot.vm.getGlobal("Downs"), 0, "the press is spent (0x00495470): no OnMouseDown");
    deliver("mousemove", x - 1, y + 1, undefined, 2);
    assert.equal(rect(main).left, start.left - 1, "no dead zone: the first pixel moves it");
    deliver("mousemove", x - 20, y + 30, undefined, 2);
    assert.equal(rect(main).left, start.left - 20);
    assert.equal(rect(main).top, start.top + 30);
    deliver("mouseup", x - 20, y + 30, node, 2);
    assert.equal(boot.vm.getGlobal("Ups"), 0, "the release is spent too (0x004947a0)");
    assert.equal(countListeners(), 0, "the release ends the move");
    assert.equal(main.moving, false);
    assert.equal(main.points[0].point, "TOPLEFT", "the dropped position is the frame's");
    boot.bridge.touch();
    assert.equal(rect(main).left, start.left - 20, "a later layout keeps it");

    // Below the strip: the frame's own press, and no move.
    const moved = rect(main);
    deliver("mousedown", moved.left + 30, moved.top + 100, node);
    assert.equal(boot.vm.getGlobal("Downs"), 1, "OnMouseDown");
    deliver("mousemove", moved.left + 80, moved.top + 150);
    assert.equal(rect(main).left, moved.left, "outside the title region nothing moves");
    deliver("mouseup", moved.left + 80, moved.top + 150, node);
    assert.equal(boot.vm.getGlobal("Ups"), 1);

    // On the child that takes the mouse over the strip: the child's press bubbles here, and is not the window's.
    const child = renderer.elementFor(boot.bridge.getFrame("Child"));
    const over = rect(boot.bridge.getFrame("Child"));
    assert.ok(over.top < moved.top + 15 && over.left > moved.left + 25, "the child lies over the title strip");
    deliver("mousedown", over.left + 2, over.top + 2, child, 0, [node]);
    deliver("mousemove", over.left + 40, over.top + 40);
    assert.equal(rect(main).left, moved.left, "a press another frame took drags nothing here");
    deliver("mouseup", over.left + 40, over.top + 40, child, 0, [node]);

    // Through a child that does not take the mouse: the window is the frame under it, and moves.
    const glass = renderer.elementFor(boot.bridge.getFrame("Glass"));
    const pane = rect(boot.bridge.getFrame("Glass"));
    const downs = boot.vm.getGlobal("Downs");
    deliver("mousedown", pane.left + 2, pane.top + 2, glass, 0, [node]);
    deliver("mousemove", pane.left + 7, pane.top + 2);
    assert.equal(rect(main).left, moved.left + 5, "the press passed through to the window's title region");
    deliver("mouseup", pane.left + 7, pane.top + 2, glass, 0, [node]);
    assert.equal(boot.vm.getGlobal("Downs"), downs, "and was spent there");
    boot.vm.execute("Main:ClearAllPoints() Main:SetPoint('CENTER')", "@recentre");
    boot.bridge.touch();

    // A frame that does not take the mouse never reaches the title test (the chat frames' shape).
    const inert = boot.bridge.getFrame("Inert");
    const inertNode = renderer.elementFor(inert);
    const inertStart = rect(inert);
    deliver("mousedown", inertStart.left + 10, inertStart.top + 10, inertNode);
    deliver("mousemove", inertStart.left + 60, inertStart.top + 10);
    assert.equal(rect(inert).left, inertStart.left, "nothing moves");
    deliver("mouseup", inertStart.left + 60, inertStart.top + 10, inertNode);
    assert.equal(countListeners(), 0);

    // `movable` is not asked (0x00495470, 0x00494060, 0x0048abd0); a hidden title region drags nothing (0x00489270).
    boot.vm.execute("Main:SetMovable(false)", "@unmovable");
    const here = rect(main);
    assert.equal(here.left, start.left, "recentred");
    deliver("mousedown", here.left + 30, here.top + 7, node);
    deliver("mousemove", here.left + 40, here.top + 7);
    assert.equal(rect(main).left, here.left + 10, "an unmovable frame moves by its title region");
    deliver("mouseup", here.left + 40, here.top + 7, node);
    boot.vm.execute("Title:Hide()", "@hide-title");
    const shown = rect(main);
    deliver("mousedown", shown.left + 30, shown.top + 7, node);
    deliver("mousemove", shown.left + 60, shown.top + 7);
    assert.equal(rect(main).left, shown.left, "a hidden title region holds no point");
    deliver("mouseup", shown.left + 60, shown.top + 7, node);
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy(); boot.close();
    [doc.addEventListener, doc.removeEventListener] = previous;
  }
});
