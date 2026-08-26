import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  CLASS_DRUID, CLASS_WARLOCK, MEMBER_STATUS_DEAD, MEMBER_STATUS_ONLINE, MEMBER_STATUS_PVP,
  RAID_MARKS, classColor, generatedClassColor, healthFraction, raidMarkGlyph, raidMarksByUnit,
  threatFraction, unitSnapshot,
} from "../dist/code/browser/ui/UnitSnapshot.js";

/** A world object with just the fields a unit frame reads. */
function object({ level, health, maxHealth, classId, powerType, power, maxPower } = {}) {
  const fields = new Map();
  const set = (name, value) => {
    if (value !== undefined) fields.set(UPDATE_FIELDS[name].offset, value);
  };
  set("UNIT_FIELD_LEVEL", level);
  set("UNIT_FIELD_HEALTH", health);
  set("UNIT_FIELD_MAXHEALTH", maxHealth);
  // Race, class, gender and power type share one packed word, so a frame that wants either of the
  // last two has to read a byte rather than a field.
  if (classId !== undefined || powerType !== undefined) {
    fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, ((classId ?? 0) << 8) | ((powerType ?? 0) << 24));
  }
  if (power !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + (powerType ?? 0), power);
  if (maxPower !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + (powerType ?? 0), maxPower);
  return { guid: 1n, typeId: 4, fields };
}

const MEMBER = 0x0000_0000_0000_2a01n;

test("a raid member out of the grid is drawn from the stats packet instead", () => {
  // Twenty-eight of a forty-person raid have no object at all: the server sends object updates
  // only for the player's own grid, and SMSG_PARTY_MEMBER_STATS is the whole of what is known.
  const far = unitSnapshot(MEMBER, "Аллея", {
    stats: { health: 4_200, maxHealth: 9_000, level: 80, powerType: 0, power: 2_000, maxPower: 8_000, status: MEMBER_STATUS_ONLINE },
  });
  assert.equal(far.inGrid, false, "and this is also the answer to 'can I heal them'");
  assert.equal(far.health, 4_200);
  assert.equal(far.level, 80);
  assert.equal(far.online, true);
  assert.equal(far.classId, undefined, "the stats packet carries no class, so no class colour");

  // The same member walking into range: the grid is fresher and wins every field it has.
  const near = unitSnapshot(MEMBER, "Аллея", {
    stats: { health: 4_200, maxHealth: 9_000, level: 80, status: MEMBER_STATUS_ONLINE },
    object: object({ health: 8_900, maxHealth: 9_000, level: 80, classId: CLASS_DRUID }),
  });
  assert.equal(near.inGrid, true);
  assert.equal(near.health, 8_900, "a stats packet is throttled; an object update is not");
  assert.equal(near.classId, CLASS_DRUID);
});

test("dead is 0x0004 in the status word, and 0x0002 is the PvP flag next to it", () => {
  const flagged = unitSnapshot(MEMBER, "Аллея", { stats: { status: MEMBER_STATUS_ONLINE | MEMBER_STATUS_PVP } });
  assert.equal(flagged.dead, false, "taking 0x0002 for death buries every flagged member");

  const dead = unitSnapshot(MEMBER, "Аллея", { stats: { status: MEMBER_STATUS_ONLINE | MEMBER_STATUS_DEAD } });
  assert.equal(dead.dead, true);
  assert.equal(dead.online, true);

  const offline = unitSnapshot(MEMBER, "Аллея", { stats: { status: 0 } });
  assert.equal(offline.online, false, "no online bit is offline, which the group list also says");
});

test("zero health is a corpse and unknown health is a unit that has not arrived", () => {
  const corpse = unitSnapshot(MEMBER, "Аллея", { object: object({ health: 0, maxHealth: 9_000 }) });
  assert.equal(corpse.dead, true);
  assert.equal(healthFraction(corpse), 0);

  const arriving = unitSnapshot(MEMBER, "Аллея", { object: object({ maxHealth: 9_000 }) });
  assert.equal(arriving.dead, false, "or every unit is dead for the frame after it appears");
  assert.equal(healthFraction(arriving), 0, "and still draws empty, which is not the same claim");

  assert.equal(healthFraction(unitSnapshot(MEMBER, "", { object: object({ health: 45, maxHealth: 90 }) })), 0.5);
});

test("the power a frame draws is the unit's own, and rage arrives times ten", () => {
  // POWER_DISPLAY_SCALE: rage is slot 1 and runic power is slot 6, both scaled by ten.
  const warrior = unitSnapshot(MEMBER, "Аллея", {
    object: object({ powerType: 1, power: 450, maxPower: 1_000 }),
  });
  assert.equal(warrior.powerType, 1);
  assert.equal(warrior.power, 450);
  assert.equal(warrior.powerScale, 10, "45 rage out of 100, not 450 out of 1000");

  const mana = unitSnapshot(MEMBER, "Аллея", { object: object({ powerType: 0, power: 2_000, maxPower: 8_000 }) });
  assert.equal(mana.powerScale, 1);

  // Out of range there is no BYTES_0 to read a power type from, so the stats packet carries its own.
  const far = unitSnapshot(MEMBER, "Аллея", { stats: { powerType: 3, power: 60, maxPower: 100 } });
  assert.equal(far.powerType, 3, "energy, and not the mana slot everyone used to get");
});

test("class colours are a sparse table, and index 10 is a hole in it", () => {
  assert.equal(classColor(CLASS_DRUID), "#ff7d0a");
  assert.equal(classColor(CLASS_WARLOCK), "#9482c9");
  // The hole is still a hole — reading the table as a dense ten would hand the druid the
  // warlock's purple, which is what this test has always been for. What changed in Д3 is what
  // happens *past* the ten: 3.3.5 has no DBC source for class colours, so a class a module adds
  // had none at all, and an uncoloured nameplate reads as a bug rather than as a class nobody
  // wrote a colour for. Id 10 is not a class this dataset has, but it is a number the wire can
  // carry, and it now gets a colour of its own rather than the druid's or nothing.
  assert.notEqual(classColor(10), classColor(CLASS_DRUID));
  assert.notEqual(classColor(10), classColor(CLASS_WARLOCK));
  // Named rather than compared with itself: `classColor(10) === classColor(10)` is true of any
  // function that answers at all, `undefined` included, so it pinned nothing whatsoever.
  assert.equal(classColor(10), generatedClassColor(10), "the hole is filled from the id");
  assert.match(classColor(10), /^hsl\(/, "and filled with a colour, not with a word");
  // Zero is not a missing class but the absence of one: a creature, or a player whose bytes
  // arrived first. Colouring that would paint every nameplate in the world.
  assert.equal(classColor(0), undefined);
  assert.equal(classColor(undefined), undefined);
});

test("raid marks are inverted once per repaint, not looked up eight times per frame", () => {
  // The server indexes by icon because an icon is unique and a unit is not: moving the star off
  // one target and onto another is reported by naming the icon again.
  const byIcon = new Map([[0, 11n], [7, 22n], [3, 0n]]);
  const byUnit = raidMarksByUnit(byIcon);
  assert.equal(byUnit.get(11n), 0);
  assert.equal(byUnit.get(22n), 7);
  assert.equal(byUnit.has(0n), false, "a cleared icon names a zero guid, not a unit");

  assert.equal(raidMarkGlyph(0), RAID_MARKS[0]);
  assert.equal(raidMarkGlyph(7), RAID_MARKS[7]);
  assert.equal(raidMarkGlyph(8), undefined, "there are eight, and the eighth is index seven");
  assert.equal(raidMarkGlyph(undefined), undefined);
});

test("threat is a ratio to the highest, because the raw number says nothing", () => {
  const table = [{ guid: 1n, threat: 30_000 }, { guid: 2n, threat: 15_000 }, { guid: 3n, threat: 30_000 }];
  assert.equal(threatFraction(table, 2n), 0.5);
  assert.equal(threatFraction(table, 1n), 1, "tanking");
  assert.equal(threatFraction(table, 4n), undefined, "not on the list is not zero threat");
  // An empty table is no information at all, which is not the same as being safe.
  assert.equal(threatFraction([], 1n), undefined);
  assert.equal(threatFraction([{ guid: 1n, threat: 0 }], 1n), undefined);
});

test("the group list is the authority on being offline, and the stats packet on being dead", () => {
  // An offline member has no object and no stats: the group list is the only thing that names them.
  const offline = unitSnapshot(MEMBER, "Аллея", { online: false });
  assert.equal(offline.online, false);
  assert.equal(offline.inGrid, false);
  assert.equal(offline.health, undefined);

  // And an explicit online flag from the group list beats the status word, which can lag it.
  const both = unitSnapshot(MEMBER, "Аллея", { online: true, stats: { status: 0 } });
  assert.equal(both.online, true);
});
