// 4.08: an equipment set's slots that it leaves alone travel as the raw guid 1 (the server's
// IgnoreMask, CharacterHandler.cpp:1544-1556), and «Записать» keeps them instead of saving what is worn.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const model = await import("../dist/code/browser/ui/EquipmentSetModel.js");
const { buildEquipmentSetSave, EQUIPMENT_SET_IGNORED } = await import("../dist/code/world/CharacterProgressProtocol.js");

test("ignored slots are 1, the others what is worn, an empty slot 0", () => {
  const worn = (slot) => (slot === 0 ? 0x100n : slot === 14 ? 0x200n : undefined);
  const pieces = model.equipmentSetPieces(worn, new Set([3, 14]));
  assert.equal(pieces.length, 19);
  assert.equal(pieces[0], 0x100n);
  assert.equal(pieces[3], EQUIPMENT_SET_IGNORED);
  assert.equal(pieces[14], 1n, "an ignored slot is 1 even with something worn there");
  assert.equal(pieces[5], 0n);
});

test("a saved set's mask comes back from its pieces, and the save carries 01 01 for the slot", () => {
  const pieces = Array.from({ length: 19 }, (_, slot) => (slot === 3 ? 1n : slot === 0 ? 0x100n : 0n));
  assert.deepEqual([...model.ignoredSlotsOf(pieces)], [3]);
  const bytes = buildEquipmentSetSave(0n, 0, "", "", pieces);
  // packed setGuid (00), u32 index, two empty strings, then 19 packed guids.
  const slots = bytes.subarray(1 + 4 + 1 + 1);
  // Slot 0: guid 0x100 is mask 0x02 and the byte 0x01; slots 1 and 2 are empty (mask 0); slot 3 is
  // the raw 1: mask 0x01 and the byte 0x01.
  assert.deepEqual([...slots.subarray(0, 6)], [0x02, 0x01, 0x00, 0x00, 0x01, 0x01]);
});

test("«Записать» saves with the set's own mask; «Ячейки…» opens the per-slot list", async () => {
  const source = await readFile(new URL("../src/browser/ui/EquipmentSets.ts", import.meta.url), "utf8");
  assert.match(source, /saveSet\(set\.setId, set\.name, set\.guid, ignoredSlotsOf\(set\.pieces\)\)/);
  assert.match(source, /const pieces = equipmentSetPieces\(\(slot\) => inventory\.equipment\[slot\]\?\.guid, ignored\);/);
  assert.equal(model.equipmentSlotName(14).length > 0, true);
});
