import assert from "node:assert/strict";
import test from "node:test";

// The stock scripts end to end over the canned seam and the client's own FrameXML: an action
// dragged off ActionButton12 empties it and the grid keeps the empty slot shown while held, a
// spell dragged out of SpellBookFrame lands on it through ActionButton's OnReceiveDrag, and
// LEARNED_SPELL_IN_TAB flashes a tab instead of raising.
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

const decoder = new TextDecoder("utf-8");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("MPQ: a spell dragged from the stock book lands on an emptied stock action button", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }), exercise: false,
  });
  try {
    await boot.load();
    const errors = boot.errorCount;
    const frame = (name) => boot.bridge.getFrame(name);
    const lua = (source, results = 1) => {
      const chunk = boot.vm.compileFunction(source, "@spellbook-drag", []);
      try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
    };
    // Lift Глухая оборона off ActionButton12 (ActionBarFrame.xml:18-24) and let go of it.
    assert.equal(boot.bridge.fireScript(frame("ActionButton12"), "OnDragStart", "LeftButton"), true);
    await settle();
    assert.deepEqual(lua("return HasAction(12), GetCursorInfo()", 2), [false, "spell"]);
    assert.equal(frame("ActionButton12").visible, true, "the grid keeps the emptied slot on screen while held");
    lua("ClearCursor()", 0);
    await settle();
    assert.equal(frame("ActionButton12").visible, false, "HIDEGRID hides an empty slot again");

    assert.equal(boot.bridge.Show(frame("SpellBookFrame")), true);
    // SpellButton3 is the book's second row (the stock ids run down the left column first).
    assert.equal(boot.bridge.fireScript(frame("SpellButton3"), "OnDragStart", "LeftButton"), true);
    await settle();
    assert.deepEqual(lua("return GetCursorInfo()", 3), ["spell", 2, "spell"]);
    assert.equal(frame("ActionButton12").visible, true, "ACTIONBAR_SHOWGRID showed the empty slot to drop on");
    assert.equal(boot.bridge.fireScript(frame("ActionButton12"), "OnReceiveDrag"), true);
    await settle();
    assert.deepEqual(lua("return GetActionInfo(12)", 4), ["spell", 2, "spell", 772]);
    assert.deepEqual(lua("return ActionButton12Icon:GetTexture(), GetCursorInfo()", 2),
      ["Interface\\Icons\\Ability_Gouge", undefined], "ACTIONBAR_SLOT_CHANGED redrew the button; the hand is empty");
    assert.equal(frame("ActionButton12").visible, true);

    // SPELL_LEARNED → LEARNED_SPELL_IN_TAB with the tab: SpellBookFrame.lua:62-70 flashes it.
    boot.pump.fire("LEARNED_SPELL_IN_TAB", 1);
    assert.equal(frame("SpellBookSkillLineTab1Flash").visible, true);
    await settle();
    assert.equal(boot.errorCount, errors, boot.vm.errors.slice(errors).join(" | "));
  } finally {
    boot.close();
    chain.close();
  }
});
