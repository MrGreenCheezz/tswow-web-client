import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

// P1-19 (UI-12): the GameTooltip C-methods keep their line FontStrings instead of building
// `GameTooltipText<side><i>` and asking the bridge for it on every call. `AddLine` cleared and sized
// the tooltip over all 64 rows of both sides, so `SetOwner` + 10 lines cost 1,421 name lookups
// (measured offline before the change); the rows are read off the tooltip's children now, again
// whenever their number changes, and a kept line that has left the tooltip is not returned.

/** Eight rows of both sides exist before any C-method runs, as `GameTooltipTemplate`'s XML has them. */
const AUTHORED = Array.from({ length: 8 }, (_, i) => `
  GameTooltip:CreateFontString("GameTooltipTextLeft${i + 1}", "ARTWORK", "GameTooltipText")
  GameTooltip:CreateFontString("GameTooltipTextRight${i + 1}", "ARTWORK", "GameTooltipText")`).join("");

const FIXTURE = {
  "interface/framexml/framexml.toc": "TipFonts.xml\nTip.lua",
  "interface/framexml/tipfonts.xml": `<Ui>
    <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
    <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
  </Ui>`,
  "interface/framexml/tip.lua": `
    UIParent = CreateFrame("Frame", "UIParent")
    UIParent:SetSize(1000, 600)
    Owner = CreateFrame("Button", "Owner", UIParent)
    Owner:SetSize(100, 30)
    GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
    ${AUTHORED}
    GameTooltip:Hide()
    -- Every third row a double line, every fourth a wrapped one.
    function TipAdd(i)
      if i % 3 == 0 then GameTooltip:AddDoubleLine("Слева " .. i, "Справа " .. i, 1, 1, 1, 0.5, 0.5, 0.5)
      else GameTooltip:AddLine("Строка подсказки номер " .. i, 1, 0.82, 0, i % 4 == 0) end
    end
    function TipSizes(n)
      GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")
      local out = {}
      for i = 1, n do
        TipAdd(i)
        out[#out + 1] = GameTooltip:GetWidth() .. "x" .. GameTooltip:GetHeight()
      end
      GameTooltip:Show()
      return table.concat(out, ",")
    end
  `,
};

/**
 * `GetWidth`x`GetHeight` after each of 20 rows, taken from the 64 × 2 lookup algorithm before the
 * change (the binder's own estimate, no renderer mounted): the rows past the authored eight, the
 * double lines and the wrapped ones all size as they did.
 */
const SIZES_BEFORE = "164x32,164x46,164x60,164x74,164x88,164x102,164x116,164x130,164x144,170x158,"
  + "170x172,170x186,170x200,170x214,170x228,170x242,170x256,170x270,170x284,170x298";

async function booted() {
  const boot = new FrameXmlBoot({ provider: createFixtureProvider(FIXTURE), subset: ["TipFonts.xml", "Tip.lua"], exercise: false });
  await boot.load();
  const bridge = boot.bridge;
  const counts = { lookups: 0 };
  const getFrame = bridge.getFrame.bind(bridge);
  bridge.getFrame = (name) => {
    if (/Text(Left|Right)\d+$/.test(name)) counts.lookups += 1;
    return getFrame(name);
  };
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@tooltip-lines", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const line = (side, index) => getFrame(`GameTooltipText${side}${index}`);
  return { boot, run, line, counts };
}

test("SetOwner and ten AddLine look up at most 40 line names, from a cold tooltip", async () => {
  const { boot, run, counts } = await booted();
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") for i = 1, 10 do TipAdd(i) end GameTooltip:Show()`);
    assert.ok(counts.lookups <= 40, `line lookups: ${counts.lookups}`);
    assert.deepEqual(run("return GameTooltip:NumLines(), GameTooltipTextLeft10:GetText(), GameTooltipTextRight9:GetText()", 3),
      [10, "Строка подсказки номер 10", "Справа 9"]);
    const warm = counts.lookups;
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") for i = 1, 10 do TipAdd(i) end GameTooltip:Show()`);
    assert.equal(counts.lookups - warm, 0, "a warm update looks up no line by name");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("GetWidth and GetHeight after every row are the ones the lookup algorithm gave", async () => {
  const { boot, run } = await booted();
  try {
    assert.equal(run("return TipSizes(20)", 1)[0], SIZES_BEFORE, "cold");
    assert.equal(run("return TipSizes(20)", 1)[0], SIZES_BEFORE, "warm");
    // Shorter content after longer: the rows past it are cleared and size nothing.
    assert.equal(run("return TipSizes(3)", 1)[0], SIZES_BEFORE.split(",").slice(0, 3).join(","));
    assert.deepEqual(run("return GameTooltipTextLeft4:IsShown(), GameTooltipTextLeft4:GetText(), GameTooltipTextRight18:IsShown()", 3),
      [false, "", false]);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a kept line that Lua moved to another parent is not the tooltip's any more", async () => {
  const { boot, run, line } = await booted();
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(2) GameTooltip:Show()`);
    const moved = line("Left", 2);
    assert.equal(moved.text, "Строка подсказки номер 2");
    // Moved out, and a child added in the same breath: the tooltip's child count is what it was.
    const before = boot.bridge.getFrame("GameTooltip").children.length;
    run(`GameTooltipTextLeft2:SetParent(UIParent) GameTooltip:CreateTexture()`);
    assert.equal(moved.parent, boot.bridge.getFrame("UIParent"), "the line has a new parent");
    assert.equal(boot.bridge.getFrame("GameTooltip").children.length, before, "and the child count did not change");
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(2) GameTooltip:Show()`);
    assert.equal(moved.text, "Строка подсказки номер 2", "the moved line is neither cleared nor written");
    assert.deepEqual(run("return GameTooltip:NumLines()", 1), [1], "row 2 has no line: AddLine there writes nothing");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a kept line is checked against its parent on every hit, even for a parent change nobody announced", async () => {
  const { boot, run, line } = await booted();
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(2) GameTooltip:Show()`);
    const moved = line("Left", 2);
    // White-box: the parent field changed with no structural notification and no child-list edit,
    // so only the hit's own parent check can see it. `getFrame(name).parent` is what the old walk tested.
    const version = boot.bridge.structureVersion;
    boot.bridge.resolve(moved).parent = boot.bridge.getFrame("UIParent");
    assert.equal(boot.bridge.structureVersion, version);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(4)`);
    assert.deepEqual(run("return GameTooltip:NumLines()", 1), [1], "row 2 has no line");
    assert.equal(moved.text, "Строка подсказки номер 2", "the line is neither cleared nor written");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a line whose global name another widget took is not the row's once the rows are read again", async () => {
  const { boot, run, line } = await booted();
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(2) TipAdd(4) GameTooltip:Show()`);
    const authored = line("Left", 3);
    // The newcomer re-points the global (the client has no duplicate-name check); a texture added
    // to the tooltip changes its child count, so the rows are read again.
    run(`UIParent:CreateFontString("GameTooltipTextLeft3", "ARTWORK", "GameTooltipText") GameTooltip:CreateTexture()`);
    assert.notEqual(line("Left", 3), authored, "the name now belongs to the newcomer");
    assert.equal(authored.parent, boot.bridge.getFrame("GameTooltip"), "the authored line is still the tooltip's child");
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(2) TipAdd(4) GameTooltip:Show()`);
    assert.deepEqual(run("return GameTooltip:NumLines()", 1), [2], "row 3 has no line, as `getFrame(name)` answered");
    assert.equal(authored.text, "Строка подсказки номер 4", "the line that lost its name is not written");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a re-pointed global name alone, with no change to the tooltip's children, drops the row", async () => {
  const { boot, run, line } = await booted();
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(2) GameTooltip:Show()`);
    const authored = line("Left", 2);
    const count = boot.bridge.getFrame("GameTooltip").children.length;
    run(`UIParent:CreateFontString("GameTooltipTextLeft2", "ARTWORK", "GameTooltipText")`);
    assert.equal(boot.bridge.getFrame("GameTooltip").children.length, count, "the tooltip's child count is unchanged");
    assert.notEqual(line("Left", 2), authored);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) TipAdd(4)`);
    // `getFrame("GameTooltipTextLeft2")` is the newcomer under UIParent: row 2 has no line, so the
    // authored one is neither cleared nor written, and the second AddLine writes nothing.
    assert.deepEqual(run("return GameTooltip:NumLines()", 1), [1]);
    assert.equal(authored.text, "Строка подсказки номер 2");
    assert.equal(line("Left", 2).text, "", "nor is the newcomer");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a row line moved in while another child leaves (same child count) is cleared and sized", async () => {
  const { boot, run, line } = await booted();
  try {
    run(`Holder = CreateFrame("Frame", "Holder", UIParent)
      Spare = Holder:CreateFontString("GameTooltipTextLeft9", "ARTWORK", "GameTooltipText")
      Junk = GameTooltip:CreateTexture()`);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") TipAdd(1) GameTooltip:Show()`);
    const count = boot.bridge.getFrame("GameTooltip").children.length;
    run(`Junk:SetParent(UIParent) Spare:SetParent(GameTooltip) Spare:SetText("Строка 9") Spare:Show()`);
    assert.equal(boot.bridge.getFrame("GameTooltip").children.length, count, "the same child count");
    // Sized with row 9, as the 64-row walk sized it: one row more than row 1 alone.
    const [height] = run(`TipAdd(2) return GameTooltip:GetHeight()`, 1);
    assert.equal(height, Number(SIZES_BEFORE.split(",")[2].split("x")[1]), "rows 1, 2 and 9");
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    const spare = line("Left", 9);
    assert.equal(spare.text, "", "SetOwner clears row 9");
    assert.equal(spare.visible, false);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("a row another script creates after the first pass is found, cleared and sized", async () => {
  const { boot, run, line } = await booted();
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") for i = 1, 10 do TipAdd(i) end GameTooltip:Show()`);
    run(`local extra = GameTooltip:CreateFontString("GameTooltipTextLeft12", "ARTWORK", "GameTooltipText")
      extra:SetText("Чужая строка") extra:Show()`);
    const extra = line("Left", 12);
    assert.equal(extra.parent, boot.bridge.getFrame("GameTooltip"));
    // Sized with row 12 in it, as the 64-row walk sized it: one row more than ten rows alone.
    run("GameTooltip:AddLine('Одиннадцатая')");
    const [, withExtra] = run("return GameTooltip:GetWidth(), GameTooltip:GetHeight()", 2);
    const elevenRows = Number(SIZES_BEFORE.split(",")[10].split("x")[1]);
    assert.ok(withExtra > elevenRows, `row 12 counted: ${withExtra} > ${elevenRows}`);
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    assert.equal(extra.text, "", "SetOwner clears it");
    assert.equal(extra.visible, false, "and hides it");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
