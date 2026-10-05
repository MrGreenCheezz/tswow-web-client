import assert from "node:assert/strict";
import test from "node:test";
import {
  SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED,
  attachmentPoint, attachmentRefusal, attachmentRotation, stowedOnBack, stowedOnHip,
} from "../dist/code/browser/Attachment.js";
import { charSelectWears, figureSheath } from "../dist/code/browser/glue/CharSelectWorn.js"; // 05.10-A7a-H
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

// 05.10-A7a-H (6.08, review G2): bows, guns and crossbows no longer ride the back stowed — Wow.exe
// hangs a stowed ranged weapon by its SheatheType (0x0072b7f0(1, …) → 0x004eacd0), and those carry 0.
test("two-handers and shields ride the back when stowed; bows, guns and crossbows do not", () => {
  assert.equal(stowedOnBack(item(15, 17)), true, "a 2H axe is SheatheType 1");
  assert.equal(stowedOnBack(item(16, 14)), true, "a shield is SheatheType 4");
  assert.equal(stowedOnBack(item(17, 15, 2)), false, "a bow is SheatheType 0");
  assert.equal(stowedOnBack(item(17, 15, 3)), false, "a gun too");
  assert.equal(stowedOnBack(item(17, 15, 18)), false, "a crossbow too");
  assert.equal(attachmentPoint(item(15, 17), SHEATH_UNARMED), ATTACHMENT_BACK);
  assert.equal(attachmentPoint(item(15, 17), SHEATH_RANGED), ATTACHMENT_BACK, "melee stowed while aiming");
  assert.equal(attachmentPoint(item(16, 14), SHEATH_UNARMED), ATTACHMENT_BACK);
  assert.equal(attachmentPoint(item(17, 15, 2), SHEATH_MELEE), undefined);
  assert.equal(attachmentPoint(item(17, 15, 2), SHEATH_UNARMED), undefined);
});

// 05.10 review A7a-B 6.02: the dataset's guns and crossbows are INVTYPE_RANGEDRIGHT (26), not 15 —
// Item.dbc class 2: subclass 3 → 249 rows of type 26 and one of 21, subclass 18 → 156 of type 26 and
// one of 15; only bows (subclass 2) are type 15. The fixtures above spell them as type 15, which no
// real gun is, so an NPC rifleman's (and a player's) gun never showed stowed.
// 05.10-A7a-H: superseded by Wow.exe 0x0072b7f0/0x004eacd0 (SheatheType 0 has no point) — stowed, none of them hangs.
test("05.10 review: real guns and crossbows (INVTYPE_RANGEDRIGHT) are held when aimed, not hung stowed", () => {
  assert.equal(stowedOnBack(item(17, 26, 3)), false, "a gun as Item.dbc spells it");
  assert.equal(stowedOnBack(item(17, 26, 18)), false, "a crossbow as Item.dbc spells it");
  assert.equal(attachmentPoint(item(17, 26, 3), SHEATH_MELEE), undefined, "a rifleman with a sword out");
  assert.equal(attachmentPoint(item(17, 26, 3), SHEATH_RANGED), ATTACHMENT_HAND_LEFT);
  assert.equal(stowedOnBack(item(17, 26, 19)), false, "a wand is type 26 too and still hides");
  assert.equal(stowedOnBack(item(17, 26, undefined)), false, "type 26 without its subclass is not guessed");
  assert.equal(stowedOnBack(item(17, 25, 16)), false, "thrown stays hidden");
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

// 05.10-A7a-H (6.08, review G2): the glue figure. Wow.exe 0x004e3cd0 → 0x004eacd0(slot 17, SheatheType 0,
// not stowed, not right-handed): a hunter's ranged weapon — bow, gun or crossbow alike — in the left hand
// (point 2); other classes show no ranged slot; the creation screen's stowed bow hangs nowhere.
test("05.10-A7a-H glue: the hunter holds any ranged weapon in the left hand; stowed, it hangs nowhere", () => {
  for (const ranged of [item(17, 15, 2), item(17, 26, 3), item(17, 26, 18)]) {
    assert.equal(charSelectWears(17, 3, 0), true);
    assert.equal(attachmentPoint(ranged, figureSheath(17, true)), ATTACHMENT_HAND_LEFT);
    assert.equal(attachmentPoint(ranged, figureSheath(17, false)), undefined, "creation screen: not on the back");
  }
  assert.equal(charSelectWears(17, 1, 0), false, "a warrior's ranged slot is not shown");
  assert.equal(attachmentPoint(item(15, 17), figureSheath(15, true)), ATTACHMENT_HAND_RIGHT);
});
