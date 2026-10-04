// Plan item 3.23 (lane L1, 03.10): the native creature-type words (CreatureMetadata.ts TYPE_NAMES, used by
// the native target frame and unit tooltip) are CreatureType.dbc's Name_lang, as Wow.exe reads the row
// for the unit's type (UnitCreatureType 0x611780 → 0x71f300; the stock side has `/dbc/creature-types`).
// Measured on the dataset's ruRU table: 1 «Животное», 8 «Существо», 10 «Не указано», 13 «Облако газа».
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const { creatureTypeName } = await import("../dist/code/browser/CreatureMetadata.js");

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc/CreatureType.dbc";

/** CreatureType.dbc rows: ID, Name_lang (16 locales + flags), Flags — the first non-empty locale string. */
function readCreatureTypes(path) {
  const buffer = readFileSync(path);
  assert.equal(buffer.toString("latin1", 0, 4), "WDBC");
  const records = buffer.readUInt32LE(4);
  const fields = buffer.readUInt32LE(8);
  const size = buffer.readUInt32LE(12);
  const strings = 20 + records * size;
  const text = (at) => {
    let end = strings + at;
    while (buffer[end] !== 0) end++;
    return buffer.toString("utf8", strings + at, end);
  };
  const rows = new Map();
  for (let index = 0; index < records; index++) {
    const base = 20 + index * size;
    const id = buffer.readUInt32LE(base);
    let name = "";
    for (let locale = 1; locale <= 16 && locale < fields; locale++) {
      const at = buffer.readUInt32LE(base + locale * 4);
      if (at !== 0) { name = text(at); break; }
    }
    rows.set(id, name);
  }
  return rows;
}

test("the native words are the dataset's CreatureType.dbc names", { skip: !existsSync(DATASET_DBC) && "no dataset DBC" }, () => {
  const rows = readCreatureTypes(DATASET_DBC);
  assert.ok(rows.size >= 13);
  for (const [id, name] of rows) assert.equal(creatureTypeName(id), name, `type ${id}`);
});

test("the four rows the table had wrong, and the fallback for no type", () => {
  assert.equal(creatureTypeName(1), "Животное");
  assert.equal(creatureTypeName(8), "Существо");
  assert.equal(creatureTypeName(10), "Не указано");
  assert.equal(creatureTypeName(13), "Облако газа");
  assert.equal(creatureTypeName(7), "Гуманоид", "an unchanged row");
  assert.equal(creatureTypeName(undefined), "Существо", "no metadata: the old fallback word");
});
