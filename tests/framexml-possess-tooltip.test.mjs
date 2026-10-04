import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

// 11.02-IF-review: GameTooltip:SetPossession(slot), Wow.exe 3.3.5a 0x006257c0 — PossessButton_OnEnter
// (BonusActionBarFrame.lua:280-294) sends slot 1 here and draws CANCEL itself for slot 2. Slot 1 is the
// possess spell's own tooltip (0x006238a0 over 0x00c234e0, with its cooldown left) and answers 1 when it
// drew; any other slot, or no possess spell, answers nil and draws nothing. Over a fixture corpus.
installFakeUiDocument();

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");

const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
SpellEvents = 0
GameTooltip:SetScript("OnTooltipSetSpell", function() SpellEvents = SpellEvents + 1 end)
`;

const SPELLS = new Map([
  [605, { title: "Контроль над разумом", lines: [{ text: "Подчиняет цель.", tone: "description" }] }],
]);

async function boot(possessionSpell) {
  const booted = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": FIXTURE,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined, containerItem: () => undefined,
      spell: (id) => SPELLS.get(id),
      possessionSpell,
    },
  });
  await booted.load();
  const run = (source, results = 0) => {
    const chunk = booted.vm.compileFunction(source, "@possess-tooltip", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return booted.vm.call(chunk, [], results); } finally { booted.vm.release(chunk); }
  };
  const rows = () => {
    const out = [];
    const count = run("return GameTooltip:NumLines()", 1)[0];
    for (let index = 1; index <= count; index++) out.push(booted.bridge.getFrame(`GameTooltipTextLeft${index}`)?.text);
    return out;
  };
  return { boot: booted, run, rows };
}

test("11.02-IF-review: SetPossession(1) draws the possess spell and answers 1 (0x006257c0)", async () => {
  const { boot: b, run, rows } = await boot(() => 605);
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    assert.deepEqual(run("return GameTooltip:SetPossession(1)", 1), [1]);
    assert.deepEqual(rows(), ["Контроль над разумом", "Подчиняет цель."]);
    assert.deepEqual(run("return GameTooltip:GetSpell()", 3), ["Контроль над разумом", "", 605], "GetSpell names the spell");
    assert.deepEqual(run("return SpellEvents", 1), [1], "OnTooltipSetSpell, as every spell setter raises it");
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("11.02-IF-review: SetPossession answers nil for any other slot and with no possess spell, drawing nothing", async () => {
  const held = { spell: undefined };
  const { boot: b, run, rows } = await boot(() => held.spell);
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    assert.deepEqual(run("return GameTooltip:SetPossession(1)", 1), [undefined], "no possess spell (0x00c234e0 = 0)");
    assert.deepEqual(rows(), []);
    held.spell = 605;
    assert.deepEqual(run("return GameTooltip:SetPossession(2)", 1), [undefined], "slot 2 is the cancel button's: Lua draws CANCEL");
    assert.deepEqual(rows(), []);
    assert.deepEqual(run("return GameTooltip:SetPossession(1.4)", 1), [1], "the slot is rounded (0x006257c0 ROUND)");
    assert.deepEqual(run("return SpellEvents", 1), [1]);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("11.02-IF-review: the live tooltip adapter names the seam's possess spell (0x00c234e0), none for 0", () => {
  assert.equal(createFrameXmlCharacterTooltipAdapter({ possess: { possessSpell: 605 } }).possessionSpell?.(), 605);
  assert.equal(createFrameXmlCharacterTooltipAdapter({ possess: { possessSpell: 0 } }).possessionSpell?.(), undefined);
  assert.equal(createFrameXmlCharacterTooltipAdapter({}).possessionSpell?.(), undefined, "a seam without the model (canned)");
});
