import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// 3.36 (11.11): GetPetHappiness's thresholds and damage are constants in FrameXmlPetHappiness.ts with no gateway
// route; Wow.exe 0x0071f390/0x0071f400 read them from PetPersonality.dbc row 1. This pins them to the base
// dataset's row (HappinessThreshold[3] at fields 18-20, HappinessDamage[3] at 21-23) so an edited table is seen.

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { frameXmlPetHappiness, frameXmlPetHappinessLevel } = await import("../dist/code/browser/framexml/FrameXmlPetHappiness.js");

let dbcPath;
try {
  dbcPath = join((await import("../tools/paths.mjs")).dbcDirectory(), "PetPersonality.dbc");
  await readFile(dbcPath);
} catch {
  dbcPath = undefined;
}

test("PetPersonality.dbc row 1 is what GetPetHappiness answers by", { skip: dbcPath ? false : "no dataset DBC on this machine" }, async () => {
  const data = await readFile(dbcPath);
  assert.equal(data.toString("latin1", 0, 4), "WDBC");
  const rows = data.readUInt32LE(4);
  const size = data.readUInt32LE(12);
  let row;
  for (let index = 0; index < rows; index++) if (data.readInt32LE(20 + index * size) === 1) row = 20 + index * size;
  assert.ok(row !== undefined, "row 1 is in the table");
  const thresholds = [18, 19, 20].map((field) => data.readInt32LE(row + field * 4));
  const damage = [21, 22, 23].map((field) => data.readFloatLE(row + field * 4));
  assert.equal(frameXmlPetHappinessLevel(thresholds[1] - 1), 1);
  assert.equal(frameXmlPetHappinessLevel(thresholds[1]), 2);
  assert.equal(frameXmlPetHappinessLevel(thresholds[2] - 1), 2);
  assert.equal(frameXmlPetHappinessLevel(thresholds[2]), 3);

  const offset = (name) => UPDATE_FIELDS[name].offset;
  const HUNTER = 0x10n;
  const hunter = { guid: HUNTER, typeId: 4, fields: new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8)]]) };
  for (const [level, power] of [[1, 0], [2, thresholds[1]], [3, thresholds[2]]]) {
    const pet = { guid: 0x20n, typeId: 3, fields: new Map([
      [offset("UNIT_FIELD_PETNUMBER"), 7], [offset("UNIT_FIELD_CREATEDBY"), Number(HUNTER)], [offset("UNIT_FIELD_CREATEDBY") + 1, 0],
      [offset("UNIT_FIELD_POWER1") + 4, power],
    ]) };
    const [happiness, percent] = frameXmlPetHappiness(pet, (guid) => (guid === HUNTER ? hunter : undefined));
    assert.equal(happiness, level);
    assert.equal(percent, Math.fround(Math.fround(damage[level - 1]) * 100), `damage at level ${level}`);
  }
});
