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
const { CannedWorldSeam, CANNED_ACTION_BAR } = await import(
  "../dist/code/browser/framexml/CannedWorldSeam.js",
);

const decoder = new TextDecoder("utf-8");

test("MPQ SpellBook owns Show/Hide and SpellButton OnClick through the seam", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const provider = {
    async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
  });
  try {
    const inventory = await boot.load();
    const root = boot.bridge.getFrame("SpellBookFrame");
    assert.ok(root, "the stock root is present");
    assert.equal(root.visible, false, "the stock book starts hidden");
    assert.equal(inventory.lua.failed, 0, "the stock book Lua executes cleanly");
    assert.equal(boot.bridge.Show(root), true);
    assert.equal(root.visible, true, "bridge Show runs the stock OnShow path");
    const first = boot.bridge.getFrame("SpellButton1");
    assert.ok(first, "the first stock spell button is present");
    const tooltip = boot.bridge.getFrame("GameTooltip");
    const title = boot.bridge.getFrame("GameTooltipTextLeft1");
    assert.ok(tooltip && title, "the stock GameTooltip payload targets are present");
    assert.equal(boot.bridge.Enter(first), true, "stock SpellButton_OnEnter runs");
    assert.equal(tooltip.visible, true, "GameTooltip:SetOwner/SetSpell show the tooltip");
    assert.equal(title.visible, true, "the first tooltip line is shown");
    assert.equal(title.text, "Удар героя", "SetSpell publishes the seam's spell name");
    assert.ok(tooltip.points.some((point) => point.relativeTo === first),
      "SetOwner anchors the tooltip root to the hovered spell button");
    const spellTooltipSize = boot.bridge.measure(tooltip);
    assert.ok(Number(tooltip.attributes.width) > 0, "spell tooltip declares a non-zero width");
    assert.ok(Number(tooltip.attributes.height) > 0, "spell tooltip declares a non-zero height");
    assert.ok(spellTooltipSize.width > 0 && spellTooltipSize.height > 0,
      "spell tooltip has a non-zero measured rectangle");
    const setText = boot.vm.compileFunction(
      "return GameTooltip:SetText('Проверка размера')", "@spellbook-tooltip-text", [],
    );
    assert.ok(setText, "the SetText sizing probe compiles");
    try {
      assert.deepEqual(boot.vm.call(setText, [], 1), [true]);
    } finally {
      boot.vm.release(setText);
    }
    const oneLineHeight = Number(tooltip.attributes.height);
    const addLine = boot.vm.compileFunction(
      "GameTooltip:AddLine('Вторая строка')", "@spellbook-tooltip-add-line", [],
    );
    assert.ok(addLine, "the AddLine sizing probe compiles");
    try {
      boot.vm.call(addLine, [], 0);
    } finally {
      boot.vm.release(addLine);
    }
    assert.ok(Number(tooltip.attributes.width) > 0 && Number(tooltip.attributes.height) > oneLineHeight,
      "AddLine grows the declared tooltip rectangle by its visible line count");
    const actionButton = boot.bridge.getFrame("ActionButton1");
    assert.ok(actionButton, "the first stock action button is present");
    assert.equal(boot.bridge.Leave(first), true, "leaving the spell clears the stock tooltip");
    assert.equal(boot.bridge.Enter(actionButton), true, "stock ActionButton_OnEnter runs");
    assert.equal(tooltip.visible, true, "GameTooltip:SetOwner/SetAction show the action tooltip");
    assert.equal(title.text, "Удар героя", "SetAction resolves the 1-based action slot, not a spell slot");
    // UberTooltips is on by default, as in the client: the stock button hands its tooltip to
    // GameTooltip_SetDefaultAnchor (the bottom-right corner) rather than covering the bar.
    const uiParent = boot.bridge.getFrame("UIParent");
    assert.ok(tooltip.points.some((point) => point.relativeTo === uiParent && point.point === "BOTTOMRIGHT"),
      "the action tooltip takes the default bottom-right anchor");
    assert.equal(boot.bridge.Leave(actionButton), true);
    assert.equal(boot.vm.execute('SetCVar("UberTooltips", "0")', "@spellbook-uber-off").ok, true);
    assert.equal(boot.bridge.Enter(actionButton), true);
    assert.ok(tooltip.points.some((point) => point.relativeTo === actionButton),
      "with UberTooltips off, SetOwner re-anchors the root to the hovered action button");
    const actionTooltipSize = boot.bridge.measure(tooltip);
    assert.ok(Number(tooltip.attributes.width) > 0 && Number(tooltip.attributes.height) > 0,
      "action tooltip keeps declared width and height");
    assert.ok(actionTooltipSize.width > 0 && actionTooltipSize.height > 0,
      "action tooltip has a non-zero measured rectangle");
    const emptyActionCall = boot.vm.compileFunction(
      "return GameTooltip:SetAction(13)", "@spellbook-empty-action", [],
    );
    assert.ok(emptyActionCall, "the empty action probe compiles");
    try {
      assert.deepEqual(boot.vm.call(emptyActionCall, [], 1), [false],
        "an unknown action slot is rejected instead of using it as a spell id");
    } finally {
      boot.vm.release(emptyActionCall);
    }
    assert.equal(tooltip.visible, false, "an unknown action hides the stale tooltip");
    assert.equal(title.visible, false, "an unknown action clears tooltip lines");
    assert.equal(boot.bridge.Click(first, "LeftButton", false), true);
    assert.deepEqual(seam.castSpellIds, [78], "stock OnClick delegates exactly once to CastSpell");
    assert.equal(boot.bridge.Hide(root), true);
    assert.equal(root.visible, false, "bridge Hide runs the stock OnHide path");
  } finally {
    boot.close();
    chain.close();
  }
});
