import assert from "node:assert/strict";
import test, { after } from "node:test";

// frame10 (15.11, plan item 3.21): the stock `WorldFrame` global. WorldFrame.xml (stock TOC line 12, before
// UIParent.xml) is in the production vertical; the frame answers as Wow.exe's CGWorldFrame does (read-only Ghidra,
// .runtime/re-2026-11-15/frame10): GetObjectType "Frame" (its type-name slot is the plain frame's 0x00492750),
// strata 0 = "UNKNOWN" (0x004fabd0 → 0x00491020(0); 0x00814e90 names only 1-8), the keyboard, mouse and wheel bits
// (0x0048f6a0 for bits 1-3), no parent and setAllPoints — the screen at scale 1, apart from UIParent.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { installFrameXmlWorldFrameMouse } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlWorldFrame.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const SCREEN = Object.freeze({ width: 1365, height: 768 });

async function load(subset) {
  const errors = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam: new CannedWorldSeam(), exercise: true,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => SCREEN,
    lua: { onError: (message) => errors.push(message) },
  });
  const inventory = await boot.load();
  // As the world mount does: UIParent measures the logical screen, which every root is placed on.
  boot.bridge.setMeasure((frame) => (frame.name === "UIParent" ? SCREEN : undefined));
  return { boot, inventory, errors };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "worldframe-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("WorldFrame.xml sits before UIParent.xml; the vertical gains the global, five widgets and no Lua error", withClient, async () => {
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(vertical.indexOf("worldframe.xml") + 1, vertical.indexOf("uiparent.xml"), "stock TOC lines 12-13");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "worldframe.xml"));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(lua(baseline.boot, "return type(WorldFrame)")[0], "nil", "without the file there is no global");
    const metric = (inventory) => ({ files: inventory.files.total, widgets: inventory.widgets.total,
      errors: inventory.lua.errorsRaised, distinct: inventory.errors.length, luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    // WorldFrame, FramerateLabel, FramerateText, ActionStatus, ActionStatusText.
    assert.deepEqual(delta, { files: 2, widgets: 5, errors: 0, distinct: 0, luaFailed: 0 }, JSON.stringify(delta));

    const { boot } = candidate;
    assert.deepEqual(lua(boot, `return type(WorldFrame), WorldFrame:GetName(), WorldFrame:GetObjectType(),
      WorldFrame:IsObjectType("Frame"), WorldFrame:IsObjectType("WorldFrame"), WorldFrame:GetParent()`, 6),
    ["table", "WorldFrame", "Frame", true, false, undefined]);
    assert.deepEqual(lua(boot, `return WorldFrame:GetFrameStrata(), WorldFrame:GetFrameLevel(), WorldFrame:GetScale(),
      WorldFrame:GetEffectiveScale(), WorldFrame:IsShown(), WorldFrame:IsVisible()`, 6),
    ["UNKNOWN", 0, 1, 1, true, true]);
    assert.deepEqual(lua(boot, "return WorldFrame:GetWidth(), WorldFrame:GetHeight(), GetScreenWidth(), GetScreenHeight()", 4),
      [SCREEN.width, SCREEN.height, SCREEN.width, SCREEN.height], "the whole screen at scale 1");
    assert.deepEqual(lua(boot, "local x, y = WorldFrame:GetCenter() return x, y", 2), [SCREEN.width / 2, SCREEN.height / 2]);
    assert.deepEqual(lua(boot, "return WorldFrame:IsMouseEnabled(), WorldFrame:IsKeyboardEnabled(), WorldFrame:IsMouseWheelEnabled()", 3),
      [1, 1, true], "the constructor's bits 1-3");
    assert.deepEqual(lua(boot, `return WorldFrame:IsMovable(), WorldFrame:IsResizable(), WorldFrame:GetNumChildren(),
      (select(1, WorldFrame:GetChildren())):GetName()`, 4), [true, true, 1, "ActionStatus"],
    "the XML's movable/resizable and its one stock child; name plates are not FrameXML frames here");

    // A frame parented to WorldFrame keeps its own scale under a scaled UIParent and stays shown when UIParent hides.
    assert.deepEqual(lua(boot, `
      WorldFrameTestChild = CreateFrame("Frame", "WorldFrameTestChild", WorldFrame)
      WorldFrameTestChild:SetSize(10, 10) WorldFrameTestChild:SetPoint("CENTER")
      UIParent:SetScale(0.5)
      local underUi = CreateFrame("Frame", nil, UIParent)
      return WorldFrameTestChild:GetEffectiveScale(), underUi:GetEffectiveScale(), WorldFrameTestChild:GetFrameStrata(),
        WorldFrame:GetNumChildren()`, 4), [1, 0.5, "UNKNOWN", 2]);
    assert.deepEqual(lua(boot, "UIParent:Hide() return UIParent:IsVisible(), WorldFrame:IsVisible(), WorldFrameTestChild:IsVisible()", 3),
      [false, true, true], "Alt+Z hides UIParent, not the world's children");
    lua(boot, "UIParent:Show() UIParent:SetScale(1)", 0);

    // Scripts run as on any frame: an add-on's OnUpdate every frame, beside the stock WorldFrame_OnUpdate.
    lua(boot, `WorldFrameTestTicks = 0 WorldFrame:HookScript("OnUpdate", function(self, elapsed)
      WorldFrameTestTicks = WorldFrameTestTicks + 1 WorldFrameTestElapsed = elapsed end)`, 0);
    const errorsBefore = candidate.errors.length;
    boot.bridge.tick(0.25);
    boot.bridge.tick(0.5);
    assert.deepEqual(lua(boot, "return WorldFrameTestTicks, WorldFrameTestElapsed", 2), [2, 0.5]);
    assert.deepEqual(candidate.errors.slice(errorsBefore), [], "the stock WorldFrame_OnUpdate runs without an error");
    lua(boot, "UIParent:Hide()", 0);
    boot.bridge.tick(0.25);
    assert.equal(lua(boot, "return WorldFrameTestTicks")[0], 3, "it keeps running while UIParent is hidden");
    lua(boot, "UIParent:Show()", 0);
  } finally {
    baseline?.boot.close();
    candidate?.boot.close();
  }
});

/** A pointer event as the page sends it: `buttons` is the mask after the change. */
function pointer(type, buttons) {
  return Object.assign(new Event(type, { cancelable: true }), { buttons });
}

function fakeWorld(attributes = {}) {
  const frame = { name: "WorldFrame", type: "WorldFrame", attributes, visible: true };
  const calls = [];
  const bridge = {
    getFrame: (name) => (name === "WorldFrame" ? frame : undefined),
    isVisible: (candidate) => candidate.visible,
    fireScript: (_frame, script, button) => { calls.push(`${script} ${button}`); return true; },
  };
  return { frame, calls, bridge };
}

test("a press on the world runs WorldFrame's OnMouseDown/OnMouseUp and is never cancelled", () => {
  const { calls, bridge } = fakeWorld();
  const canvas = new EventTarget();
  const cleanup = installFrameXmlWorldFrameMouse(bridge, canvas, canvas);
  const down = pointer("pointerdown", 1);
  canvas.dispatchEvent(down);
  canvas.dispatchEvent(pointer("pointermove", 3)); // the right button joins as a chord
  canvas.dispatchEvent(pointer("pointermove", 2));
  canvas.dispatchEvent(pointer("pointerup", 0));
  assert.deepEqual(calls, ["OnMouseDown LeftButton", "OnMouseDown RightButton", "OnMouseUp LeftButton", "OnMouseUp RightButton"]);
  assert.equal(down.defaultPrevented, false, "the world keeps the click");
  cleanup();
  canvas.dispatchEvent(pointer("pointerdown", 4));
  assert.equal(calls.length, 4, "the cleanup removes the listeners");
});

test("only a press that lands on the world counts, and only while WorldFrame takes the mouse", () => {
  const offWorld = fakeWorld();
  const view = new EventTarget();
  installFrameXmlWorldFrameMouse(offWorld.bridge, new EventTarget(), view);
  view.dispatchEvent(pointer("pointerdown", 1));
  view.dispatchEvent(pointer("pointerup", 0));
  assert.deepEqual(offWorld.calls, [], "a press on the interface is not the world's");

  const muted = fakeWorld({ enableMouse: "false" });
  const canvas = new EventTarget();
  installFrameXmlWorldFrameMouse(muted.bridge, canvas, canvas);
  canvas.dispatchEvent(pointer("pointerdown", 1));
  canvas.dispatchEvent(pointer("pointerup", 0));
  assert.deepEqual(muted.calls, [], "EnableMouse(false) takes the mouse focus away");

  const hidden = fakeWorld();
  hidden.frame.visible = false;
  const surface = new EventTarget();
  installFrameXmlWorldFrameMouse(hidden.bridge, surface, surface);
  surface.dispatchEvent(pointer("pointerdown", 2));
  assert.deepEqual(hidden.calls, [], "a hidden WorldFrame has no press");
});
