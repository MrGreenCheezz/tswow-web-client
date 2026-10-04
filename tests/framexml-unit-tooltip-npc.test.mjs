import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.12e: the creature's sub-name line GameTooltip:SetUnit writes under the name (Wow.exe
// 3.3.5a 12340: 0x00621070 → 0x00719950, read 2026-10-02). A fixture corpus, no client needed.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { frameXmlUnitSubName } = await import("../dist/code/browser/framexml/FrameXmlUnitSubName.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function unit(typeId, entry, petNumber = 0) {
  const fields = new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]);
  if (petNumber) fields.set(UPDATE_FIELDS.UNIT_FIELD_PETNUMBER.offset, petNumber);
  return { guid: 0xf130000000001234n, typeId, fields };
}

const TRAINER = { found: true, name: "Архимаг Мэлин", subName: "Тренер магов" };

test("the sub-name is the creature record's own text, only for a creature without a pet number", () => {
  const asked = [];
  const template = (entry, guid) => { asked.push([entry, guid]); return entry === 3048 ? TRAINER : undefined; };
  assert.equal(frameXmlUnitSubName(unit(3, 3048), template), "Тренер магов", "written as sent, no brackets added");
  assert.deepEqual(asked, [[3048, 0xf130000000001234n]], "the record is looked up by entry and guid");
  assert.equal(frameXmlUnitSubName(unit(3, 3048, 7), template), undefined, "a pet (UNIT_FIELD_PETNUMBER) shows none");
  assert.equal(frameXmlUnitSubName(unit(4, 3048), template), undefined, "a player shows the guild line instead");
  assert.equal(frameXmlUnitSubName(unit(3, 99), template), undefined, "no record yet: no line");
  assert.equal(frameXmlUnitSubName(unit(3, 3048), () => ({ found: true, subName: "" })), undefined, "an empty sub-name: no line");
  assert.equal(frameXmlUnitSubName(unit(3, 3048), () => ({ found: false, subName: "x" })), undefined, "a missing record");
  assert.equal(frameXmlUnitSubName(undefined, template), undefined);
});

async function bootTooltip(adapter) {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
TOOLTIP_UNIT_LEVEL = "Уровень %s"
TOOLTIP_UNIT_LEVEL_TYPE = "Уровень %s (%s)"
TOOLTIP_UNIT_LEVEL_RACE_CLASS = "Уровень %s %s %s"
function UnitExists(unit) return unit == "target" or unit == "player" end
function UnitName(unit) if unit == "target" then return "Архимаг Мэлин" end if unit == "player" then return "Тест" end end
function UnitIsPlayer(unit) return unit == "player" end
function UnitRace() return "Человек" end
function UnitClass() return "Маг" end
function UnitLevel() return 80 end
function UnitCreatureType(unit) if unit == "target" then return "Гуманоид" end end
function UnitIsPVP() return false end
function GetGuildInfo(unit) if unit == "player" then return "Щит", "Член", 1 end end
`,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined, containerItem: () => undefined, item: () => undefined, spell: () => undefined,
      ...adapter,
    },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@unit-tooltip-npc", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const text = (index) => boot.bridge.getFrame(`GameTooltipTextLeft${index}`)?.text;
  return { boot, run, text };
}

test("SetUnit writes the sub-name right under a creature's name, before the level line", async () => {
  const asked = [];
  const { boot, run, text } = await bootTooltip({
    unitSubName: (unit) => { asked.push(unit); return unit === "target" ? "Тренер магов" : undefined; },
  });
  try {
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")`);
    assert.deepEqual(run(`return GameTooltip:SetUnit("target")`, 1), [true]);
    assert.deepEqual(run(`return GameTooltip:NumLines()`, 1), [3]);
    assert.equal(text(1), "Архимаг Мэлин");
    assert.equal(text(2), "Тренер магов");
    assert.equal(text(3), "Уровень 80 (Гуманоид)");
    assert.deepEqual(run(`return GameTooltip:SetUnit("player")`, 1), [true]);
    assert.equal(text(2), "Щит", "a player: the guild as it is (0x0061fec0 adds no brackets), no sub-name");
    assert.equal(text(3), "Уровень 80 Человек Маг");
    assert.deepEqual(asked, ["target"], "the adapter is not asked for a player");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("without an adapter answer the creature's tooltip keeps its two lines", async () => {
  const { boot, run, text } = await bootTooltip({});
  try {
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")`);
    run(`GameTooltip:SetUnit("target")`);
    assert.deepEqual(run(`return GameTooltip:NumLines()`, 1), [2]);
    assert.equal(text(2), "Уровень 80 (Гуманоид)");
  } finally { boot.close(); }
});
