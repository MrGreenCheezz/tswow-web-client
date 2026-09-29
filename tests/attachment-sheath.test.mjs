import assert from "node:assert/strict";
import test from "node:test";
import {
  SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED,
  attachmentPoint, attachmentRefusal, attachmentRotation, stowedOnBack, stowedOnHip,
} from "../dist/code/browser/Attachment.js";
import {
  ATTACHMENT_BACK, ATTACHMENT_HAND_LEFT, ATTACHMENT_HAND_RIGHT, ATTACHMENT_HIP_LEFT,
  ATTACHMENT_HIP_RIGHT, ATTACHMENT_SHIELD,
} from "../dist/code/browser/Wvm.js";

// V1: stowed back-carriers ride attachment 12 — grounded in Item.dbc SheatheType over this
// dataset (2H→1, staff→2, shield→4) and in the playable models' own attachment tables, where 12
// sits behind the back.
// M2: stowed one-handers ride the hips — 9 right, 10 left — read off the playable models'
// attachment tables (HumanMale 9/10 at waist height, Orc and Tauren the same pair) and confirmed
// by the reference client's sheath mapping. The blade turns down alongside the leg.

const item = (slot, inventoryType, subClass) => ({
  slot, inventoryType, ...(subClass === undefined ? {} : { subClass }),
  side: "right", model: "Weapon\\Sword_2H_Test.m2", texture: "",
});

test("drawn weapons stay exactly where they were", () => {
  assert.equal(attachmentPoint(item(15, 17), SHEATH_MELEE), ATTACHMENT_HAND_RIGHT);
  assert.equal(attachmentPoint(item(16, 14), SHEATH_MELEE), ATTACHMENT_SHIELD);
  assert.equal(attachmentPoint(item(16, 13), SHEATH_MELEE), ATTACHMENT_HAND_LEFT);
  assert.equal(attachmentPoint(item(17, 15, 2), SHEATH_RANGED), ATTACHMENT_HAND_LEFT);
});

test("two-handers, shields and bows ride the back when stowed", () => {
  assert.equal(stowedOnBack(item(15, 17)), true, "a 2H axe is SheatheType 1");
  assert.equal(stowedOnBack(item(16, 14)), true, "a shield is SheatheType 4");
  assert.equal(stowedOnBack(item(17, 15, 2)), true, "a bow names its subclass");
  assert.equal(stowedOnBack(item(17, 15, 3)), true, "a gun too");
  assert.equal(stowedOnBack(item(17, 15, 18)), true, "a crossbow too");
  assert.equal(attachmentPoint(item(15, 17), SHEATH_UNARMED), ATTACHMENT_BACK);
  assert.equal(attachmentPoint(item(15, 17), SHEATH_RANGED), ATTACHMENT_BACK, "melee stowed while aiming");
  assert.equal(attachmentPoint(item(16, 14), SHEATH_UNARMED), ATTACHMENT_BACK);
  assert.equal(attachmentPoint(item(17, 15, 2), SHEATH_MELEE), ATTACHMENT_BACK);
  assert.equal(attachmentPoint(item(17, 15, 2), SHEATH_UNARMED), ATTACHMENT_BACK);
});

test("stowed one-handers ride their own hip, main right and off left", () => {
  assert.equal(stowedOnHip(item(15, 13)), true, "INVTYPE_WEAPON in the main hand");
  assert.equal(stowedOnHip(item(16, 13)), true, "INVTYPE_WEAPON in the off hand");
  assert.equal(stowedOnHip(item(15, 21)), true, "a main-hand-locked blade");
  assert.equal(stowedOnHip(item(16, 22)), true, "an off-hand-locked blade");
  assert.equal(stowedOnHip(item(15, 17)), false, "a two-hander is back, never hip");
  assert.equal(stowedOnHip(item(16, 14)), false, "a shield is back, never hip");
  assert.equal(stowedOnHip(item(17, 15, 2)), false, "the ranged slot has no hip");
  assert.equal(attachmentPoint(item(15, 13), SHEATH_UNARMED), ATTACHMENT_HIP_RIGHT);
  assert.equal(attachmentPoint(item(15, 13), SHEATH_RANGED), ATTACHMENT_HIP_RIGHT, "melee stowed while aiming");
  assert.equal(attachmentPoint(item(16, 13), SHEATH_UNARMED), ATTACHMENT_HIP_LEFT);
  assert.equal(attachmentPoint(item(16, 13, 15), SHEATH_UNARMED), ATTACHMENT_HIP_LEFT, "a dagger too");
  assert.equal(attachmentRefusal(item(15, 13), SHEATH_UNARMED), undefined, "no refusal for a hung blade");
});

test("hip blades turn down the leg, everything else hangs as authored", () => {
  const right = attachmentRotation(ATTACHMENT_HIP_RIGHT);
  const left = attachmentRotation(ATTACHMENT_HIP_LEFT);
  assert.ok(right && left, "both hips turn");
  // A quarter turn about Y: the hand-authored +X blade lands on −Z, down alongside the leg.
  // The hand-authored blade runs along +X; the hip turn lands it on −Z, down the leg.
  const rotate = (q, v) => [
    v[0] * (1 - 2 * (q.y * q.y + q.z * q.z)) + v[1] * 2 * (q.x * q.y - q.z * q.w) + v[2] * 2 * (q.x * q.z + q.y * q.w),
    v[0] * 2 * (q.x * q.y + q.z * q.w) + v[1] * (1 - 2 * (q.x * q.x + q.z * q.z)) + v[2] * 2 * (q.y * q.z - q.x * q.w),
    v[0] * 2 * (q.x * q.z - q.y * q.w) + v[1] * 2 * (q.y * q.z + q.x * q.w) + v[2] * (1 - 2 * (q.x * q.x + q.y * q.y)),
  ];
  for (const rotation of [right, left]) {
    const turned = rotate(rotation, [1, 0, 0]);
    assert.ok(Math.abs(turned[0]) < 1e-6 && Math.abs(turned[1]) < 1e-6 && Math.abs(turned[2] + 1) < 1e-6,
      `the blade points down, got (${turned.map((n) => n.toFixed(3)).join(", ")})`);
  }
  assert.equal(attachmentRotation(ATTACHMENT_BACK), undefined);
  assert.equal(attachmentRotation(ATTACHMENT_HAND_RIGHT), undefined);
});

test("wands and the slotless stay hidden rather than guessed", () => {
  assert.equal(stowedOnBack(item(17, 26, 19)), false, "a wand never shows stowed");
  assert.equal(stowedOnBack(item(17, 15, undefined)), false, "a ranged slot with no subclass is not guessed");
  assert.equal(stowedOnHip(item(17, 26, 19)), false);
  assert.equal(attachmentPoint(item(17, 26, 19), SHEATH_MELEE), undefined);
  assert.match(attachmentRefusal(item(17, 26, 19), SHEATH_MELEE) ?? "", /стрелковое/);
  assert.match(attachmentRefusal({ ...item(15, 13), inventoryType: 99 }, SHEATH_UNARMED) ?? "", /ни в руку/);
});
