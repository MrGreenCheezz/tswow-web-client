// 3.62, 3.64: a stock window opened and closed from outside Lua has to tell UIParent's panel manager. Before
// this, N hid PlayerTalentFrame past HideUIPanel: it kept its slot, reopened one place over each time, and
// CloseWindows answered "found" on every Escape, so the game menu never came up again.
import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam, CANNED_ACTION_BAR } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { hideFrameXmlPanel, showFrameXmlPanel } = await import("../dist/code/browser/framexml/FrameXmlPanels.js");

const decoder = new TextDecoder("utf-8");

async function bootStock() {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam: new CannedWorldSeam(CANNED_ACTION_BAR),
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
  });
  await boot.load();
  const lua = (source, results = 1) => {
    const fn = boot.vm.compileFunction(source, "@panels-test", []);
    assert.ok(fn, source);
    try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
  };
  return {
    boot,
    lua,
    slot: (key) => lua(`local f = GetUIPanel("${key}") return f and f:GetName() or false`)[0],
    left: (name) => lua(`return ${name}:GetLeft()`)[0],
    frame: (name) => boot.bridge.getFrame(name),
  };
}

test("a panel closed through HideUIPanel gives its slot back, however many times it is toggled", withClient, async () => {
  const { boot, lua, slot, left, frame } = await bootStock();
  try {
    const book = frame("SpellBookFrame");
    for (let press = 0; press < 3; press += 1) {
      showFrameXmlPanel(boot, book);
      assert.equal(boot.bridge.isVisible(book), true);
      assert.equal(slot("left"), "SpellBookFrame");
      assert.equal(slot("center"), false, "it reopens in the same slot, not one place over");
      assert.equal(left("SpellBookFrame"), 0);
      hideFrameXmlPanel(boot, book);
      assert.equal(boot.bridge.isVisible(book), false);
      assert.equal(slot("left"), false, "the slot is free again");
    }
    assert.ok(!lua("return CloseWindows()")[0], "nothing left: Escape may go on to the game menu");
  } finally { boot.dispose?.(); }
});

test("the same panel hidden past the manager keeps its slot and blocks Escape: why the helper exists", withClient, async () => {
  const { boot, lua, slot, frame } = await bootStock();
  try {
    const book = frame("SpellBookFrame");
    showFrameXmlPanel(boot, book);
    boot.bridge.Hide(book);
    assert.equal(slot("left"), "SpellBookFrame", "a hidden frame still holds the slot");
    assert.ok(lua("return CloseWindows()")[0], "and every Escape stops at it");
    assert.ok(lua("return CloseWindows()")[0], "HideUIPanel returns early on a hidden frame, so it never lets go");
  } finally { boot.dispose?.(); }
});

test("a second panel takes the next place instead of lying over the first", withClient, async () => {
  const { boot, slot, left, frame } = await bootStock();
  try {
    const book = frame("SpellBookFrame");
    const character = frame("CharacterFrame");
    showFrameXmlPanel(boot, book);
    showFrameXmlPanel(boot, character);
    assert.equal(slot("left"), "SpellBookFrame");
    assert.equal(slot("center"), "CharacterFrame");
    assert.ok(left("CharacterFrame") >= left("SpellBookFrame") + 300, "beside it, not over it");
    hideFrameXmlPanel(boot, book);
    assert.equal(slot("left"), "CharacterFrame", "closing the left one slides the other over");
    assert.equal(left("CharacterFrame"), 0);
  } finally { boot.dispose?.(); }
});

test("a center panel refuses a left one, as stock does, and the helper does not force it", withClient, async () => {
  const { boot, frame } = await bootStock();
  try {
    showFrameXmlPanel(boot, frame("GameMenuFrame"));
    showFrameXmlPanel(boot, frame("SpellBookFrame"));
    assert.equal(boot.bridge.isVisible(frame("SpellBookFrame")), false);
    assert.equal(boot.bridge.isVisible(frame("GameMenuFrame")), true);
  } finally { boot.dispose?.(); }
});

test("without the stock functions a frame is still shown and hidden", () => {
  const frame = { name: "Anything", visible: false };
  const boot = {
    vm: { globalFunction: () => undefined },
    bridge: {
      isVisible: (target) => target.visible,
      Show: (target) => { target.visible = true; return true; },
      Hide: (target) => { target.visible = false; return true; },
    },
  };
  showFrameXmlPanel(boot, frame);
  assert.equal(frame.visible, true);
  hideFrameXmlPanel(boot, frame);
  assert.equal(frame.visible, false);
});
