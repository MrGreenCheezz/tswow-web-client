import assert from "node:assert/strict";
import test from "node:test";

// widgets7 (15.11): Frame:StartSizing with a real resize (FrameXmlSizing.ts, Wow.exe 0x004a0b10 → 0x0048abd0), the
// XML <ResizeBounds>, Get/SetBackdrop colours (0x004a19a0, 0x004a2d40), GameTooltip:AddFontStrings (0x006201f0),
// OnMessageScrollChanged on RemoveMessagesByAccessID (0x0096a510) and SetSpellByID's pet-bar fallback (0x0053b930).
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { frameXmlSizeStep, frameXmlSizingOf } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSizing.js");
const { tooltipSpellByIdMethods } = await import("../dist/code/browser/glue/GlueWidgetMethodFills.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

function fixture() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]),
    args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  const run = (source) => {
    const result = vm.execute(source, "@widgets7-test");
    assert.equal(result.ok, true, result.error ?? "chunk failed");
  };
  const raised = (source) => {
    run(`__ok, __err = pcall(function() ${source} end)`);
    assert.equal(vm.getGlobal("__ok"), false, `raises: ${source}`);
    return String(vm.getGlobal("__err"));
  };
  return { vm, bridge, run, raised };
}

const NONE = { minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0 };

test("0x0048abd0: the side the point names follows the cursor, clamped, and a top or left edge moves the corner", () => {
  // BOTTOMRIGHT (8): wider by dx, taller by a cursor going down (dy < 0); the TOPLEFT stays.
  assert.deepEqual(frameXmlSizeStep(8, 300, 200, 50, -30, NONE), { width: 350, height: 230, moveX: 0, moveY: 0 });
  const bounds = { minWidth: 200, minHeight: 150, maxWidth: 400, maxHeight: 300 };
  assert.deepEqual(frameXmlSizeStep(8, 380, 160, 50, 30, bounds), { width: 400, height: 150, moveX: 0, moveY: 0 });
  // TOPLEFT (0): narrower by dx and the left edge moves with it, but only as far as the bound lets it.
  assert.deepEqual(frameXmlSizeStep(0, 300, 200, 20, 10, NONE), { width: 280, height: 210, moveX: 20, moveY: 10 });
  assert.deepEqual(frameXmlSizeStep(0, 210, 290, 30, 30, bounds), { width: 200, height: 300, moveX: 10, moveY: 10 });
  // LEFT (3) and BOTTOM (7) leave the other dimension; RIGHT (5) moves nothing.
  assert.deepEqual(frameXmlSizeStep(3, 300, 200, -40, 99, NONE), { width: 340, height: 200, moveX: -40, moveY: 0 });
  assert.deepEqual(frameXmlSizeStep(7, 300, 200, 99, 25, NONE), { width: 300, height: 175, moveX: 0, moveY: 0 });
  assert.deepEqual(frameXmlSizeStep(5, 300, 200, 15, 99, NONE), { width: 315, height: 200, moveX: 0, moveY: 0 });
  // CENTER (4) moves the frame by the delta.
  assert.deepEqual(frameXmlSizeStep(4, 300, 200, 15, -5, bounds), { width: 300, height: 200, moveX: 15, moveY: -5 });
});

test("StartSizing: «Frame X is not resizable», the point by name, one sizing at a time, stopped by its own frame", () => {
  const { vm, bridge, run, raised } = fixture();
  try {
    run(`A = CreateFrame("Frame", "SizeA") A:SetSize(100, 100) B = CreateFrame("Frame", "SizeB") B:SetSize(100, 100)`);
    assert.match(raised(`A:StartSizing()`), /^Frame SizeA is not resizable$/);
    assert.match(raised(`CreateFrame("Frame"):StartSizing()`), /^Frame <unnamed> is not resizable$/);
    run(`A:SetResizable(true) B:SetResizable(true) A:StartSizing("left")`);
    assert.equal(frameXmlSizingOf(bridge)?.frame, bridge.getFrame("SizeA"));
    assert.equal(frameXmlSizingOf(bridge)?.point, 3, "a case-insensitive name");
    run(`B:StartSizing() B:StopMovingOrSizing()`);
    assert.equal(frameXmlSizingOf(bridge)?.frame, bridge.getFrame("SizeA"), "B neither took nor ended A's sizing");
    run(`A:StopMovingOrSizing() B:StartSizing("NOWHERE")`);
    assert.equal(frameXmlSizingOf(bridge)?.point, 8, "an unknown name keeps BOTTOMRIGHT");
    run(`B:StopMovingOrSizing()`);
    assert.equal(frameXmlSizingOf(bridge), undefined);
  } finally {
    vm.close();
  }
});

test("GetBackdropColor: nothing without a backdrop, white bytes × 0x009ead78 from a new one, reset by SetBackdrop", () => {
  const { vm, run } = fixture();
  try {
    run(`F = CreateFrame("Frame") n = select("#", F:GetBackdropColor())
      F:SetBackdrop({ bgFile = "Interface\\\\Tooltips\\\\UI-Tooltip-Background" })
      r, g, b, a = F:GetBackdropColor() br = F:GetBackdropBorderColor()
      F:SetBackdropColor(0.5, 0.25, 0, 0.5) F:SetBackdropBorderColor(0, 1, 0)
      r2, g2, b2, a2 = F:GetBackdropColor() _, bg = F:GetBackdropBorderColor()
      F:SetBackdrop({ bgFile = "Interface\\\\Tooltips\\\\UI-Tooltip-Background" }) r3 = F:GetBackdropColor() _, g3 = F:GetBackdropBorderColor()`);
    assert.equal(vm.getGlobal("n"), 0);
    const white = Math.fround(255 * Math.fround(0.003921560011804104));
    assert.equal(white, 0.9999977946281433);
    assert.deepEqual(["r", "g", "b", "a", "br"].map((k) => vm.getGlobal(k)), [white, white, white, white, white]);
    const at = (byte) => Math.fround(byte * Math.fround(0.003921560011804104));
    assert.deepEqual(["r2", "g2", "b2", "a2", "bg"].map((k) => vm.getGlobal(k)), [at(128), at(64), 0, at(128), white]);
    assert.equal(vm.getGlobal("r3"), white, "a new backdrop object starts white again");
    assert.equal(vm.getGlobal("g3"), white);
  } finally {
    vm.close();
  }
});

test("AddFontStrings: argument checks of 0x006201f0, and the pair becomes the tooltip's next line", () => {
  const { vm, run, raised } = fixture();
  try {
    run(`T = CreateFrame("GameTooltip", "ScanTip") L = T:CreateFontString() R = T:CreateFontString()
      L:SetFontObject("GameFontNormal") R:SetFontObject("GameFontNormal")`);
    assert.match(raised(`T:AddFontStrings("x", R)`), /^Usage: ScanTip:AddFontStrings\(leftstring, rightstring\)$/);
    assert.match(raised(`T:AddFontStrings(L)`), /^Usage: ScanTip:AddFontStrings\(leftstring, rightstring\)$/);
    assert.match(raised(`T:AddFontStrings({}, R)`), /^ScanTip:AddFontStrings\(\): Couldn't find 'this' in fontstring$/);
    assert.match(raised(`T:AddFontStrings(L, T)`), /^ScanTip:AddFontStrings\(\): Wrong object type, expected fontstring$/);
    run(`T:AddFontStrings(L, R) T:SetOwner(T, "ANCHOR_NONE") T:AddDoubleLine("left", "right")
      lt = L:GetText() rt = R:GetText() n = T:NumLines()`);
    assert.equal(vm.getGlobal("lt"), "left", "line 1 is the added pair");
    assert.equal(vm.getGlobal("rt"), "right");
    assert.equal(vm.getGlobal("n"), 1);
  } finally {
    vm.close();
  }
});

test("RemoveMessagesByAccessID: OnMessageScrollChanged when the newest kept line is not the old current one", () => {
  const { vm, run } = fixture();
  try {
    run(`M = CreateFrame("ScrollingMessageFrame", "AccessLog") moves = 0
      M:SetScript("OnMessageScrollChanged", function() moves = moves + 1 end)
      M:AddMessage("a", 1, 1, 1, nil, false, 1) M:AddMessage("b", 1, 1, 1, nil, false, 2)
      M:AddMessage("c", 1, 1, 1, nil, false, 1) added = moves
      M:RemoveMessagesByAccessID(2) lost = moves
      M:RemoveMessagesByAccessID(99) none = moves
      M:ScrollUp() up = moves
      M:RemoveMessagesByAccessID(99) back = moves bottom = M:AtBottom()
      M:RemoveMessagesByAccessID(1) empty = moves`);
    assert.equal(vm.getGlobal("added"), 3);
    assert.equal(vm.getGlobal("lost"), 4, "at the bottom, a line went: the newest index moved");
    assert.equal(vm.getGlobal("none"), 4, "nothing removed at the bottom: the same index");
    assert.equal(vm.getGlobal("up"), 5);
    assert.equal(vm.getGlobal("back"), 6, "scrolled up, the call goes back to the newest line");
    assert.equal(vm.getGlobal("bottom"), true);
    assert.equal(vm.getGlobal("empty"), 6, "no line left: the ring is cleared, nothing is raised");
  } finally {
    vm.close();
  }
});

test("SetSpellByID: with isPet, a spell missing from the pet book is found on the pet bar (0x0053b930 → 0x005d3560)", () => {
  const drawn = [];
  const bar = [undefined, undefined, undefined, 26090, undefined, undefined, undefined, undefined, undefined, undefined];
  const host = {
    callGlobal: () => [false],
    spell: (_frame, id) => { drawn.push(id); return true; },
    adapter: () => ({ petActionSpell: (index) => bar[index - 1] }),
  };
  const { SetSpellByID } = tooltipSpellByIdMethods(host);
  const tooltip = { type: "GameTooltip", name: "GameTooltip" };
  const call = (...args) => SetSpellByID({ frame: tooltip, self: tooltip, args });
  assert.deepEqual(call(26090, true), [1], "on the bar");
  assert.deepEqual(call(26090, false), [], "without isPet the bar is not asked");
  assert.deepEqual(call(17253, true), [], "not on the bar either");
  assert.deepEqual(drawn, [26090]);
});

// The renderer's pointer loop (as tests/framexml-drag-starts-moving.test.mjs drives it).
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

const SCENE_LUA = `
  UIParent = CreateFrame("Frame", "UIParent")
  UIParent:SetSize(1024, 768)
`;
const SCENE_XML = `<Ui>
  <Frame name="Win" parent="UIParent" resizable="true">
    <Size><AbsDimension x="300" y="200"/></Size>
    <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="100" y="-100"/></Offset></Anchor></Anchors>
    <ResizeBounds>
      <minResize><AbsDimension x="200" y="150"/></minResize>
      <maxResize><AbsDimension x="400" y="300"/></maxResize>
    </ResizeBounds>
  </Frame>
</Ui>`;
const SCENE_GRIP = `
  Grip = CreateFrame("Button", "Grip", Win)
  Grip:SetSize(16, 16)
  Grip:SetPoint("BOTTOMRIGHT")
  Grip:SetScript("OnMouseDown", function() Win:StartSizing("BOTTOMRIGHT") end)
  Grip:SetScript("OnMouseUp", function() Win:StopMovingOrSizing() end)
  minW, minH = Win:GetMinResize()
`;

test("StartSizing follows the pointer from the press within <ResizeBounds>, the grip parting from the cursor at a bound", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Scene.lua\nScene.xml\nGrip.lua",
      "interface/framexml/scene.lua": SCENE_LUA,
      "interface/framexml/scene.xml": SCENE_XML,
      "interface/framexml/grip.lua": SCENE_GRIP,
    }),
    subset: ["Scene.lua", "Scene.xml", "Grip.lua"], exercise: false,
  });
  await boot.load();
  const host = document.createElement("section");
  const events = new Map();
  const doc = host.ownerDocument;
  const previous = [doc.addEventListener, doc.removeEventListener];
  doc.addEventListener = (type, listener) => { const set = events.get(type) ?? new Set(); set.add(listener); events.set(type, set); };
  doc.removeEventListener = (type, listener) => events.get(type)?.delete(listener);
  host.offsetWidth = 1024; host.offsetHeight = 768;
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768 });
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
    for (const frame of boot.bridge.frames) {
      const node = renderer.elementFor(frame);
      if (!node || node.getBoundingClientRect) continue;
      Object.defineProperties(node, {
        offsetWidth: { get: () => boot.bridge.geometry(frame).width },
        offsetHeight: { get: () => boot.bridge.geometry(frame).height },
      });
      node.getBoundingClientRect = () => rect(frame);
    }
    assert.deepEqual([boot.vm.getGlobal("minW"), boot.vm.getGlobal("minH")], [200, 150], "the XML bounds");
    const win = boot.bridge.getFrame("Win");
    const grip = renderer.elementFor(boot.bridge.getFrame("Grip"));
    assert.deepEqual([rect(win).left, rect(win).top, rect(win).width, rect(win).height], [100, 100, 300, 200]);
    deliver("mousedown", 392, 292, grip);
    deliver("mousemove", 442, 322);
    assert.deepEqual([rect(win).left, rect(win).top, rect(win).width, rect(win).height], [100, 100, 350, 230],
      "the first move counts from the press, no dead zone, the TOPLEFT stays");
    deliver("mousemove", 542, 422);
    assert.deepEqual([rect(win).width, rect(win).height], [400, 300], "held at maxResize");
    deliver("mousemove", 532, 412);
    assert.deepEqual([rect(win).width, rect(win).height], [390, 290], "the cursor's whole delta went: back 10 is 10 less");
    deliver("mouseup", 532, 412, grip);
    deliver("mousemove", 600, 500);
    assert.deepEqual([rect(win).width, rect(win).height], [390, 290], "StopMovingOrSizing in OnMouseUp ended it");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy(); boot.close();
    [doc.addEventListener, doc.removeEventListener] = previous;
  }
});
