import assert from "node:assert/strict";
import test from "node:test";

// The skinnable line GameTooltip:SetUnit writes itself (Wow.exe 3.3.5a 12340: 0x00621070 calls
// 0x00620EE0; read 2026-09-30): condition, word, requirement and colour.
const { frameXmlSkinnableLine, frameXmlSkinningRequirement, frameXmlUnitSkinnableLine } =
  await import("../dist/code/browser/framexml/FrameXmlSkinnableTooltip.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const SKINNABLE = 0x04000000;
const hex = (color) => [color.r, color.g, color.b].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
const line = (input) => {
  const result = frameXmlSkinnableLine(input);
  return result === undefined ? undefined : [result.globalName, result.prefix, hex(result.color)];
};
const body = { unitFlags: SKINNABLE, isPlayer: false, templateFlags: 0, unitLevel: 30 };

test("the line needs UNIT_FLAG_SKINNABLE on a unit that is not a player", () => {
  assert.equal(line({ ...body, unitFlags: 0, playerSkill: 300 }), undefined);
  assert.equal(line({ ...body, isPlayer: true, playerSkill: 300 }), undefined);
  assert.deepEqual(line({ ...body, playerSkill: 300 })?.[0], "UNIT_SKINNABLE_LEATHER");
});

test("type_flags choose the word in the client's order", () => {
  assert.equal(line({ ...body, templateFlags: 0x100, playerSkill: 1 })?.[0], "UNIT_SKINNABLE_HERB");
  assert.equal(line({ ...body, templateFlags: 0x200, playerSkill: 1 })?.[0], "UNIT_SKINNABLE_ROCK");
  assert.equal(line({ ...body, templateFlags: 0x8000, playerSkill: 1 })?.[0], "UNIT_SKINNABLE_BOLTS");
  // Two bits: herbalism is tested first.
  assert.equal(line({ ...body, templateFlags: 0x300, playerSkill: 1 })?.[0], "UNIT_SKINNABLE_HERB");
});

test("the requirement follows the unit's level", () => {
  assert.deepEqual([1, 10, 11, 15, 19, 20, 60, 80].map(frameXmlSkinningRequirement), [1, 1, 10, 50, 90, 100, 300, 400]);
});

test("the colour is the difficulty of the player's skill against the requirement, red without a spell", () => {
  // Level 30: 150 required. The skill counts as 1 + 5 × ⌊skill / 5⌋.
  assert.deepEqual(line({ ...body, playerSkill: undefined }), ["UNIT_SKINNABLE_LEATHER", "", "ff2020"]);
  assert.deepEqual(line({ ...body, playerSkill: 145 }), ["UNIT_SKINNABLE_LEATHER", "", "ff2020"]); // 146 < 150
  assert.deepEqual(line({ ...body, playerSkill: 150 }), ["UNIT_SKINNABLE_LEATHER", "", "ff8040"]); // 151
  assert.deepEqual(line({ ...body, playerSkill: 174 }), ["UNIT_SKINNABLE_LEATHER", "", "ff8040"]); // 171 < 175
  assert.deepEqual(line({ ...body, playerSkill: 175 }), ["UNIT_SKINNABLE_LEATHER", "", "ffff00"]); // 176
  assert.deepEqual(line({ ...body, playerSkill: 200 }), ["UNIT_SKINNABLE_LEATHER", "", "40c040"]);
  assert.deepEqual(line({ ...body, playerSkill: 250 }), ["UNIT_SKINNABLE_LEATHER", "", "808080"]);
  // Low levels: anything from skill 1 is orange up to 25 above.
  assert.deepEqual(line({ ...body, unitLevel: 5, playerSkill: 1 }), ["UNIT_SKINNABLE_LEATHER", "", "ff8040"]);
  // The +1 of the spell's value shows at requirement 1: skill 25 counts as 26, and a known spell
  // at skill 0 as 1.
  assert.deepEqual(line({ ...body, unitLevel: 5, playerSkill: 25 }), ["UNIT_SKINNABLE_LEATHER", "", "ffff00"]);
  assert.deepEqual(line({ ...body, unitLevel: 5, playerSkill: 0 }), ["UNIT_SKINNABLE_LEATHER", "", "ff8040"]);
});

test("colour-blind mode prefixes the difficulty mark, but not for a player without the spell", () => {
  assert.deepEqual(line({ ...body, playerSkill: 150, colorblind: true })?.[1], "[+++]");
  assert.deepEqual(line({ ...body, playerSkill: 175, colorblind: true })?.[1], "[++]");
  assert.deepEqual(line({ ...body, playerSkill: 200, colorblind: true })?.[1], "[+]");
  assert.deepEqual(line({ ...body, playerSkill: 250, colorblind: true })?.[1], "");
  assert.deepEqual(line({ ...body, playerSkill: 10, colorblind: true })?.[1], "[-]");
  assert.deepEqual(line({ ...body, playerSkill: undefined, colorblind: true })?.[1], "");
});

function unitObject({ typeId = 3, flags = SKINNABLE, level = 30, entry = 100 } = {}) {
  return {
    guid: 0x20n,
    typeId,
    fields: new Map([
      [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
      [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags],
      [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, level],
    ]),
  };
}
function playerWith(skills) {
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  const fields = new Map();
  skills.forEach(([skillId, value], index) => {
    fields.set(base + index * 3, skillId);
    fields.set(base + index * 3 + 1, value | (450 << 16));
  });
  return { guid: 0x10n, typeId: 4, fields };
}
const skinningRow = { effects: [95, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 0 };
const herbRow = { effects: [95, 0, 0], effectMiscValue: [1, 0, 0], spellLevel: 0 };
const rows = new Map([[8613, skinningRow], [32605, herbRow]]);
const live = (object, { player = playerWith([[393, 200], [182, 10]]), known = [8613, 32605], templateFlags = 0 } = {}) => {
  const result = frameXmlUnitSkinnableLine({
    object,
    player,
    templateFlags: () => templateFlags,
    knownSpells: known.map((id) => ({ id })),
    spellRow: (id) => rows.get(id),
  });
  return result === undefined ? undefined : [result.globalName, hex(result.color)];
};

test("a world unit: its flags, level and template, and the player's spell and skill rank", () => {
  assert.deepEqual(live(unitObject()), ["UNIT_SKINNABLE_LEATHER", "40c040"]); // skinning 200 vs 150
  assert.deepEqual(live(unitObject(), { templateFlags: 0x100 }), ["UNIT_SKINNABLE_HERB", "ff2020"]); // herb 10 vs 150
  assert.deepEqual(live(unitObject(), { known: [32605] }), ["UNIT_SKINNABLE_LEATHER", "ff2020"]); // no skinning spell
  assert.equal(live(unitObject({ flags: 0 })), undefined);
  assert.equal(live(unitObject({ typeId: 4 })), undefined);
  // The template still being queried: no guessed word.
  const pending = frameXmlUnitSkinnableLine({
    object: unitObject(), player: undefined, templateFlags: () => undefined, knownSpells: [], spellRow: () => undefined,
  });
  assert.equal(pending, undefined);
});

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");

test("the live seam's line carries the colour-blind mark only when the binder read colorblindMode on", async () => {
  const target = unitObject();
  const player = playerWith([[393, 175]]); // skinning 176 vs 150: yellow, «[++]»
  const world = {
    targetGuid: target.guid,
    state: { selfGuid: player.guid, objects: new Map([[player.guid, player], [target.guid, target]]) },
    knownSpells: [{ id: 8613 }],
    creatureTemplate: () => ({ found: true, flags: 0 }),
  };
  const seam = new LiveWorldSeam({ world: () => world, spell: (id) => rows.get(id) });
  const read = (colorblind) => {
    const result = seam.unitSkinnableLine("target", colorblind);
    return result === undefined ? undefined : [result.globalName, result.prefix, hex(result.color)];
  };
  assert.deepEqual(read(true), ["UNIT_SKINNABLE_LEATHER", "[++]", "ffff00"]);
  assert.deepEqual(read(false), ["UNIT_SKINNABLE_LEATHER", "", "ffff00"]);
  assert.deepEqual(read(undefined), ["UNIT_SKINNABLE_LEATHER", "", "ffff00"], "no reading is the client default, off");
  // The GameTooltip adapter hands the binder's reading on to the seam.
  const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");
  const adapter = createFrameXmlCharacterTooltipAdapter(seam);
  assert.equal(adapter.unitSkinnable("target", true)?.prefix, "[++]");
  assert.equal(adapter.unitSkinnable("target", false)?.prefix, "");
});
