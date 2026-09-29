import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock GameMenuFrame as the game menu. StackSplitFrame.xml joins the vertical at its
// stock slot so the bag owner no longer borrows the menu as an alias; the host adapters and the two
// WebClient extras run on the real GameMenuFrame.xml.
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

// The world mount module reads `document`/`window` at import; the bag gate test below needs it.
function fakeNode() {
  return {
    children: [], style: {}, dataset: {}, hidden: false, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append() {}, replaceChildren() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }, getContext() { return {}; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? fakeNode() : null; },
  };
}
globalThis.document ??= {
  head: fakeNode(), body: fakeNode(), createElement: fakeNode, getElementById: fakeNode, querySelectorAll() { return []; },
};
globalThis.window ??= {
  innerWidth: 1024, innerHeight: 768, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
};
globalThis.location ??= globalThis.window.location;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  FRAMEXML_GAME_MENU_EXTRAS, createFrameXmlGameMenuOwner, frameXmlGameMenuGate, installFrameXmlGameMenuButtons,
} = await import("../dist/code/browser/framexml/FrameXmlGameMenuOwner.js");
const { frameXmlBagGate } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

async function load(subset = FRAMEXML_VERTICAL_TOC) {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "gamemenu-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A renderer stand-in whose element tree mirrors the frame tree, as FrameXmlDomRenderer's does. */
function treeRenderer() {
  const elements = new Map();
  const elementFor = (frame) => {
    if (!frame) return null;
    if (!elements.has(frame)) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      elements.set(frame, { dataset: {}, get parentElement() { return elementFor(frame.parent); },
        getAttribute: (name) => attributes.get(name) ?? null });
    }
    return elements.get(frame);
  };
  return { elementFor };
}

const relativeName = (point) => typeof point.relativeTo === "string" ? point.relativeTo : point.relativeTo?.name;

function recorder() {
  const calls = [];
  const actions = Object.fromEntries(["video", "sound", "interface", "keybindings", "macros", "diagnostics", "resetLayout", "toggle"]
    .map((name) => [name, () => calls.push(name)]));
  return { calls, actions };
}

test("StackSplitFrame.xml joins at its stock slot after MirrorTimer: two files, a real frame, no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc.indexOf("stacksplitframe.xml"), toc.indexOf("mirrortimer.xml") + 2, "retail: MirrorTimer, CoinPickupFrame, StackSplitFrame");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(vertical.indexOf("stacksplitframe.xml"), vertical.indexOf("mirrortimer.xml") + 1);
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "stacksplitframe.xml"));
    candidate = await load();
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 2, bytes: 8205, widgets: 23, errors: 0, distinct: 0 }, `delta ${JSON.stringify(delta)}`);
    assert.equal(baseline.boot.bridge.getFrame("StackSplitFrame")?.name, undefined);
    const frame = candidate.boot.bridge.getFrame("StackSplitFrame");
    assert.equal(frame?.type, "Frame");
    assert.equal(frame.visible, false);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the stock menu shows and hides cleanly with its ruRU labels; Mac options stay hidden", withClient, async () => {
  const { boot } = await load();
  try {
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, "ShowUIPanel(GameMenuFrame) return GameMenuFrame:IsShown() and 1 or 0, GameMenuFrame:GetHeight(), GameMenuButtonMacOptions:IsShown() and 1 or 0", 3),
      [1, 240, 0]);
    const labels = lua(boot, `local r = {}
      for _, name in ipairs({ "GameMenuButtonOptions", "GameMenuButtonSoundOptions", "GameMenuButtonUIOptions", "GameMenuButtonKeybindings",
        "GameMenuButtonMacros", "GameMenuButtonLogout", "GameMenuButtonQuit", "GameMenuButtonContinue" }) do r[#r + 1] = _G[name]:GetText() end
      return table.concat(r, "|")`)[0];
    assert.equal(labels, "Изображение|Звук|Интерфейс|Назначение клавиш|Макросы|Выход из мира|Выход из игры|Назад");
    lua(boot, "HideUIPanel(GameMenuFrame)", 0);
    assert.equal(boot.bridge.getFrame("GameMenuFrame").visible, false);
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});

test("adapters reach the native owners, the extras sit between Quit and Continue, and the menu grows by their step", withClient, async () => {
  const { boot } = await load();
  try {
    const errors = boot.errorCount;
    const { calls, actions } = recorder();
    assert.equal(installFrameXmlGameMenuButtons(boot, actions), true);
    // No TSWoW store in this subset: the stock 1 px gap, 22 px per 21 px button.
    assert.deepEqual(lua(boot, "return GameMenuFrame:GetHeight()"), [240 + 2 * 22]);
    for (const [index, extra] of FRAMEXML_GAME_MENU_EXTRAS.entries()) {
      const button = boot.bridge.getFrame(extra.name);
      assert.equal(button?.type, "Button", extra.name);
      assert.equal(button.parent?.name, "GameMenuFrame");
      const anchor = button.points[0];
      assert.deepEqual([anchor.point, relativeName(anchor), anchor.relativePoint, anchor.y],
        ["TOP", index === 0 ? "GameMenuButtonQuit" : FRAMEXML_GAME_MENU_EXTRAS[index - 1].name, "BOTTOM", -1]);
      assert.deepEqual(lua(boot, `return ${extra.name}:GetText()`), [extra.text]);
    }
    const continueAnchor = boot.bridge.getFrame("GameMenuButtonContinue").points[0];
    assert.deepEqual([relativeName(continueAnchor), continueAnchor.y], ["GameMenuButtonWebClientResetLayout", -16]);
    assert.deepEqual(lua(boot, "return GameMenuButtonWebClientResetLayout:GetFontString():GetFontObject() == GameFontHighlightSmall and 1 or 0"), [1],
      "the long label falls back to the template's small font");
    for (const [button, action] of [["GameMenuButtonOptions", "video"], ["GameMenuButtonSoundOptions", "sound"],
      ["GameMenuButtonUIOptions", "interface"], ["GameMenuButtonKeybindings", "keybindings"], ["GameMenuButtonMacros", "macros"],
      ["GameMenuButtonWebClientDiagnostics", "diagnostics"], ["GameMenuButtonWebClientResetLayout", "resetLayout"]]) {
      lua(boot, "ShowUIPanel(GameMenuFrame)", 0);
      boot.bridge.Click(boot.bridge.getFrame(button));
      assert.equal(calls.at(-1), action, `${button} → ${action}`);
      assert.equal(boot.bridge.getFrame("GameMenuFrame").visible, false, `${button} hides the menu first`);
    }
    lua(boot, "ToggleGameMenu()", 0);
    assert.equal(calls.at(-1), "toggle", "stock ToggleGameMenu (add-ons) reaches the host toggle, not UIParent's HelpFrame branch");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => e.message)));
  } finally {
    boot.close();
  }
});

test("the gate proves the menu silently and ends hidden; the owner disables Logout/Quit while a logout counts down", withClient, async () => {
  const { boot, seam } = await load();
  try {
    installFrameXmlGameMenuButtons(boot, recorder().actions);
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    const errors = boot.errorCount;
    const gate = frameXmlGameMenuGate(boot, treeRenderer());
    assert.ok(gate, "the stock menu, its eight buttons and both extras pass");
    assert.equal(gate.frame.visible, false);
    assert.deepEqual(sounds, [], "the probe plays no sound");
    assert.equal(frameXmlGameMenuGate(boot, { elementFor: () => undefined }), undefined, "an unrendered menu fails");
    let pending = false;
    const owner = createFrameXmlGameMenuOwner(boot, gate.frame, () => pending);
    owner.show();
    assert.equal(owner.isOpen(), true);
    assert.deepEqual(sounds, ["igMainMenuOpen"], "stock ToggleGameMenu's open sound");
    assert.deepEqual(lua(boot, "return GameMenuButtonLogout:IsEnabled(), GameMenuButtonQuit:IsEnabled()", 2), [1, 1]);
    owner.hide();
    assert.equal(owner.isOpen(), false);
    pending = true;
    owner.show();
    assert.deepEqual(lua(boot, "return GameMenuButtonLogout:IsEnabled(), GameMenuButtonQuit:IsEnabled()", 2), [0, 0],
      "as GameMenuButtonLogout's OnShow does while the CAMP countdown is visible");
    owner.hide();
    assert.deepEqual(sounds.at(-1), "igMainMenuQuit");
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});

test("with the stock menu open, a bag right-click (UseContainerItem) leaves the menu alone", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const renderer = treeRenderer();
    const owner = frameXmlBagGate(boot, renderer);
    assert.ok(owner, "the bag owner passes with the real StackSplitFrame");
    assert.equal(boot.vm.getGlobal("StackSplitFrame"), boot.bridge.getFrame("StackSplitFrame"));
    const options = boot.vm.getGlobal("InterfaceOptionsFrame");
    assert.ok(options && options !== boot.bridge.getFrame("GameMenuFrame") && options.visible === false,
      "IsOptionFrameOpen() reads a dedicated hidden stand-in");
    owner.toggleBackpack();
    lua(boot, "ShowUIPanel(GameMenuFrame)", 0);
    const errors = boot.errorCount;
    const used = seam.usedContainerItems.length;
    lua(boot, `for index = 1, 16 do
        local button = _G["ContainerFrame1Item" .. index]
        if button and button:IsShown() and GetContainerItemInfo(0, button:GetID()) then
          ContainerFrameItemButton_OnClick(button, "RightButton")
          return
        end
      end
      error("no filled backpack slot")`, 0);
    assert.equal(seam.usedContainerItems.length, used + 1, "the right-click used the item");
    assert.equal(boot.bridge.getFrame("GameMenuFrame").visible, true,
      "StackSplitFrame:Hide() hid the real stack-split frame, not the menu");
    assert.deepEqual(lua(boot, "return IsOptionFrameOpen() and 1 or 0"), [1],
      "GameMenuFrame:IsShown() is the one IsOptionFrameOpen answer while the menu is up");
    lua(boot, "HideUIPanel(GameMenuFrame)", 0);
    assert.deepEqual(lua(boot, "return IsOptionFrameOpen() and 1 or 0"), [0], "the options stand-in is not an open panel");
    assert.equal(boot.errorCount, errors);
    owner.close();
    owner.dispose?.();
  } finally {
    boot.close();
  }
});
