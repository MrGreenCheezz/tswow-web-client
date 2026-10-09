import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { frameXmlHasPetUI, frameXmlIsHunterPet } from "../dist/code/browser/framexml/FrameXmlHasPetUI.js";

/*
 * L15-review (04.10, 5.05): HasPetUI's second value, Wow.exe 0x0071b630 — the creator guid is looked up
 * through 0x004d4db0 with type mask 0x10 (TYPEMASK_PLAYER), so only a player object can be the hunter
 * (.runtime/re-2026-10-04/l14-small/g2.c). A creature that summoned the pet is no hunter whatever its
 * class byte says.
 */

const CREATOR = 0x20n;
const PET = 0x30n;

function unitObject(guid, typeId, fields) {
  return { guid, typeId, fields: new Map(fields), position: { x: 0, y: 0, z: 0, orientation: 0 } };
}

const hunterClass = (typeId) => unitObject(CREATOR, typeId, [[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 2 | (3 << 8)]]);
const pet = () => unitObject(PET, 3, [
  [UPDATE_FIELDS.UNIT_FIELD_PETNUMBER.offset, 12],
  [UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset, Number(CREATOR)],
  [UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset + 1, 0],
]);

test("L15-review: only a player creator of class 3 makes a hunter's pet (0x0071b630, TYPEMASK_PLAYER)", () => {
  const player = hunterClass(4);
  const creature = hunterClass(3);
  assert.equal(frameXmlIsHunterPet(pet(), () => player), true, "a hunter");
  assert.equal(frameXmlIsHunterPet(pet(), () => creature), false, "a creature with class byte 3 is not looked up");
  assert.deepEqual([...frameXmlHasPetUI(pet(), () => creature)], [true, false]);
  assert.deepEqual([...frameXmlHasPetUI(pet(), () => player)], [true, true]);
});
