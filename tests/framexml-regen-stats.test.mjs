// Plan item 3.23C: GetCritChanceFromAgility, GetUnitHealthRegenRateFromSpirit and
// GetUnitManaRegenRateFromSpirit over the game tables of /dbc/character-regen (Wow.exe 3.3.5a 12340:
// 0x60e130 → 0x71bae0, 0x612980 → 0x71ba60, 0x612a00 → 0x71b9f0 + 0.001; read 2026-10-02).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const {
  frameXmlCritChanceFromAgility, frameXmlHealthRegenFromSpirit, frameXmlManaRegenFromSpirit, FRAMEXML_MANA_REGEN_EPSILON,
} = await import("../dist/code/browser/framexml/FrameXmlRegenStats.js");
const { characterRegenTablesFrom, CHARACTER_REGEN_ROUTE_VERSION, CHARACTER_REGEN_ROUTE_PATH } =
  await import("../dist/code/browser/CharacterRegenClient.js");
const { CHARACTER_REGEN_VERSION, loadCharacterRegen } = await import("../dist/code/gateway/CharacterRegenMetadata.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";

/** Two classes; class 2, level 80 carries the numbers the cases below use. */
function tables() {
  const rows = 2 * 100;
  const at = (values) => { const table = new Array(rows).fill(0); for (const [index, value] of values) table[index] = value; return table; };
  return {
    meleeCritBase: [0.05, 0.03],
    meleeCritPerAgility: at([[100 + 79, 0.0002]]),
    healthPerBaseSpirit: at([[100 + 79, 0.5]]),
    healthPerSpirit: at([[100 + 79, 0.25]]),
    manaPerSpirit: at([[100 + 79, 0.004]]),
  };
}

test("the formulas: crit base + ratio × agility, the first 50 spirit at their own rate, √int × spirit for mana", () => {
  const t = tables();
  const unit = { classId: 2, level: 80, agility: 1000, intellect: 400, spirit: 130 };
  assert.ok(Math.abs(frameXmlCritChanceFromAgility(t, unit) - (0.0002 * 1000 + 0.03) * 100) < 1e-9);
  assert.equal(frameXmlHealthRegenFromSpirit(t, unit), 50 * 0.5 + 80 * 0.25);
  assert.equal(frameXmlHealthRegenFromSpirit(t, { ...unit, spirit: 30 }), 30 * 0.5, "below 50 only the base rate");
  assert.ok(Math.abs(frameXmlManaRegenFromSpirit(t, unit) - (20 * 0.004 * 130 + FRAMEXML_MANA_REGEN_EPSILON)) < 1e-9);
  assert.equal(FRAMEXML_MANA_REGEN_EPSILON, Math.fround(0.001), "the float the Lua function adds");
  assert.equal(frameXmlCritChanceFromAgility(t, { ...unit, level: 79 }), 0, "a zero ratio answers 0, not the base");
  assert.equal(frameXmlHealthRegenFromSpirit(t, { ...unit, spirit: -40 }), 0, "a negative stat reads as 0");
  assert.equal(frameXmlCritChanceFromAgility(t, { ...unit, classId: 3 }), 0, "a class outside the table");
  assert.equal(frameXmlCritChanceFromAgility(undefined, unit), 0, "no table yet: 0, as before the route");
  assert.equal(frameXmlManaRegenFromSpirit(undefined, unit), 0);
});

function seamFixture(regen) {
  const selfGuid = 0x10n;
  const petGuid = 0x20n;
  const npcGuid = 0x30n;
  const stats = (classId, level, agility, intellect, spirit) => new Map([
    [offset("UNIT_FIELD_BYTES_0"), 1 | (classId << 8)], [offset("UNIT_FIELD_LEVEL"), level],
    [offset("UNIT_FIELD_STAT0") + 1, agility], [offset("UNIT_FIELD_STAT0") + 3, intellect], [offset("UNIT_FIELD_STAT0") + 4, spirit],
  ]);
  const self = { guid: selfGuid, typeId: 4, fields: stats(2, 80, 1000, 400, 130) };
  const pet = { guid: petGuid, typeId: 3, fields: stats(2, 80, 100, 0, 60) };
  pet.fields.set(offset("UNIT_FIELD_PETNUMBER"), 7);
  pet.fields.set(offset("UNIT_FIELD_SUMMONEDBY"), Number(selfGuid));
  const npc = { guid: npcGuid, typeId: 3, fields: stats(2, 80, 1000, 400, 130) };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [petGuid, pet], [npcGuid, npc]]) },
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0, partyStats: new Map(), targetGuid: npcGuid,
    petSpells: { guid: petGuid },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1000,
    globalCooldownUntil: () => 0, castSpell: () => {}, targetGuid: () => npcGuid,
    characterRegen: () => regen,
  });
  return { seam, self };
}

test("the seam measures the player and a pet by their own fields; another unit answers 0", () => {
  const { seam } = seamFixture(tables());
  const call = (name, unit) => FRAMEXML_SEAM_BINDINGS[name](seam, [unit])[0];
  assert.ok(Math.abs(call("GetCritChanceFromAgility", "player") - 23) < 1e-9);
  assert.equal(call("GetUnitHealthRegenRateFromSpirit", "player"), 45);
  assert.ok(Math.abs(call("GetUnitManaRegenRateFromSpirit", "player") - (20 * 0.004 * 130 + FRAMEXML_MANA_REGEN_EPSILON)) < 1e-9);
  assert.equal(call("GetCritChanceFromAgility", "target"), 0, "a creature without a pet number");
  assert.equal(call("GetUnitManaRegenRateFromSpirit", "target"), 0, "no 0.001 for a unit the client does not measure");
  assert.equal(call("GetUnitHealthRegenRateFromSpirit", "pet"), 50 * 0.5 + 10 * 0.25, "the pet by its own spirit");
  assert.equal(call("GetCritChanceFromAgility", "focus"), 0);
});

test("before the route answers the three stay 0", () => {
  const { seam } = seamFixture(undefined);
  for (const name of ["GetCritChanceFromAgility", "GetUnitHealthRegenRateFromSpirit", "GetUnitManaRegenRateFromSpirit"]) {
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS[name](seam, ["player"])], [0], name);
  }
});

test("the route's version, path and validator agree with the gateway", () => {
  assert.equal(CHARACTER_REGEN_ROUTE_VERSION, CHARACTER_REGEN_VERSION);
  assert.equal(CHARACTER_REGEN_ROUTE_PATH, "/dbc/character-regen?v=1");
  const route = CATALOG_ROUTES.find((row) => row.pathname === "/dbc/character-regen");
  assert.equal(route?.version, CHARACTER_REGEN_VERSION);
  const answer = { version: 1, ...tables() };
  assert.ok(characterRegenTablesFrom(answer));
  assert.equal(characterRegenTablesFrom({ ...answer, version: 2 }), undefined);
  assert.equal(characterRegenTablesFrom({ ...answer, manaPerSpirit: [1] }), undefined, "rows must be classes × 100");
  assert.equal(characterRegenTablesFrom({ ...answer, healthPerSpirit: answer.healthPerSpirit.map(() => "x") }), undefined);
});

test("the dataset's five tables load as the route serves them", { skip: !existsSync(DBC) && "no dataset DBC directory" }, async () => {
  const catalog = await loadCharacterRegen(DBC);
  const table = characterRegenTablesFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table, "the served JSON validates");
  const classes = table.meleeCritBase.length;
  assert.ok(classes >= 11, `classes: ${classes}`);
  // A level-80 warrior: the core's own crit base and the agility rate stay in the ranges 3.3.5 shows.
  const warrior = { classId: 1, level: 80, agility: 100, intellect: 0, spirit: 100 };
  const crit = frameXmlCritChanceFromAgility(table, warrior);
  assert.ok(crit > 0 && crit < 50, `warrior crit ${crit}`);
  assert.ok(frameXmlHealthRegenFromSpirit(table, warrior) > 0);
  assert.ok(table.manaPerSpirit[(8 - 1) * 100 + 79] > 0, "a mage regenerates mana from spirit");
});
