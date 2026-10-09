import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED, attachmentPoint,
} from "../dist/code/browser/Attachment.js";
import {
  ATTACHMENT_BACK, ATTACHMENT_HAND_LEFT, ATTACHMENT_HAND_RIGHT, ATTACHMENT_HIP_LEFT, ATTACHMENT_HIP_RIGHT,
  ATTACHMENT_SHIELD,
} from "../dist/code/browser/Wvm.js";
import {
  SHEATH_POINT_BACK_MAIN, SHEATH_POINT_BACK_OFF, SHEATH_POINT_SHIELD, SHEATH_POINT_STAFF_MAIN,
  SHEATH_POINT_STAFF_OFF, SHEATH_POINT_HIP_MAIN, SHEATH_POINT_HIP_OFF,
  sheathPoint, sheatheOf, worldAttachmentPoint, wornSheathes,
} from "../dist/code/browser/SheathPoints.js";

// 6.08 (line A7a, slice G2, 05.10): where a stowed weapon hangs, by Wow.exe 3.3.5a 12340.
// 0x004eacd0 (the one hang routine: character select, corpse, NPC virtual items 0x00725010 and the
// player's own slots 0x0072dbc0 all call it) picks, by the item's SheatheType, main hand / off hand:
// 1 → 26 / 27, 2 → 30 / 31, 3 → 32 / 33, 4 → 28 / 28; anything else (0 none, 5, 6, 7 fist) hangs
// nothing. 0x0072dbc0 takes the ranged weapon out of the hand whenever the sheath state is not 2; stowed,
// it hangs only by a SheatheType 1–4 (05.10: ревью G2).

const item = (slot, inventoryType, sheathe, subClass) => ({
  slot, inventoryType, side: "right", model: "Weapon\\Test.m2", texture: "",
  ...(subClass === undefined ? {} : { subClass }), ...(sheathe === undefined ? {} : { sheathe }),
});

test("the Wow.exe 0x004eacd0 table: main hand K-1, off hand K", () => {
  assert.deepEqual([SHEATH_POINT_BACK_MAIN, SHEATH_POINT_BACK_OFF, SHEATH_POINT_SHIELD,
    SHEATH_POINT_STAFF_MAIN, SHEATH_POINT_STAFF_OFF, SHEATH_POINT_HIP_MAIN, SHEATH_POINT_HIP_OFF],
  [26, 27, 28, 30, 31, 32, 33]);
  assert.equal(sheathPoint(15, 1), 26, "a two-hander high on the back");
  assert.equal(sheathPoint(15, 2), 30, "a staff");
  assert.equal(sheathPoint(15, 3), 32, "a one-hander on the left hip (cross draw)");
  assert.equal(sheathPoint(15, 4), 28);
  assert.equal(sheathPoint(16, 1), 27, "the second two-hander of Titan's Grip");
  assert.equal(sheathPoint(16, 2), 31);
  assert.equal(sheathPoint(16, 3), 33, "the off-hand blade on the right hip");
  assert.equal(sheathPoint(16, 4), 28, "a shield on the back");
  for (const none of [0, 5, 6, 7, 8, -1]) {
    assert.equal(sheathPoint(15, none), undefined, `SheatheType ${none} hangs nothing`);
    assert.equal(sheathPoint(16, none), undefined);
  }
  assert.equal(sheathPoint(0, 1), undefined, "only the two hands stow");
});

test("stowed with a known SheatheType: the authored points, two two-handers on two points", () => {
  assert.equal(worldAttachmentPoint(item(15, 17, 1), SHEATH_UNARMED), 26);
  assert.equal(worldAttachmentPoint(item(16, 17, 1), SHEATH_UNARMED), 27, "Titan's Grip: not both on one point");
  assert.equal(worldAttachmentPoint(item(15, 13, 3), SHEATH_RANGED), 32, "melee stowed while aiming");
  assert.equal(worldAttachmentPoint(item(16, 14, 4), SHEATH_UNARMED), 28);
  assert.equal(worldAttachmentPoint(item(15, 13, 7), SHEATH_UNARMED), undefined, "a fist weapon is not drawn stowed");
  assert.equal(worldAttachmentPoint(item(15, 13, 1), SHEATH_UNARMED), 26, "the item's own type wins over its kind");
});

test("drawn weapons and worn pieces are where they always were", () => {
  assert.equal(worldAttachmentPoint(item(15, 17, 1), SHEATH_MELEE), ATTACHMENT_HAND_RIGHT);
  assert.equal(worldAttachmentPoint(item(16, 14, 4), SHEATH_MELEE), ATTACHMENT_SHIELD);
  assert.equal(worldAttachmentPoint(item(16, 13, 3), SHEATH_MELEE), ATTACHMENT_HAND_LEFT);
  assert.equal(worldAttachmentPoint(item(0, 1), SHEATH_MELEE), attachmentPoint(item(0, 1), SHEATH_MELEE));
});

test("no SheatheType yet: the old points, so an old gateway or a dump row changes nothing", () => {
  assert.equal(worldAttachmentPoint(item(15, 17), SHEATH_UNARMED), ATTACHMENT_BACK);
  assert.equal(worldAttachmentPoint(item(15, 13), SHEATH_UNARMED), ATTACHMENT_HIP_RIGHT);
  assert.equal(worldAttachmentPoint(item(16, 13), SHEATH_UNARMED), ATTACHMENT_HIP_LEFT);
});

test("the ranged slot: only while drawn, a bow left and the rest right (0x0072dbc0, 0x0072b7f0)", () => {
  for (const sheath of [SHEATH_UNARMED, SHEATH_MELEE]) {
    assert.equal(worldAttachmentPoint(item(17, 26, 0, 3), sheath), undefined, "a stowed gun is not drawn");
    assert.equal(worldAttachmentPoint(item(17, 15, 0, 2), sheath), undefined, "nor a bow");
    assert.equal(worldAttachmentPoint(item(17, 26, undefined, 3), sheath), undefined, "or with none known");
    // 05.10: ревью G2 — 0x0072b7f0(1, …) (from 0x00731f40 and the sheathe events 0x007367b0/0x007368b0/
    // 0x007369b0) stows the ranged weapon through 0x004eacd0 with the stowed flag set: SheatheType 0 has no
    // point there (so the dataset's bows, guns and crossbows vanish), but a ranged item that carries 1–4 hangs
    // like a hand weapon — INVTYPE 26/25 by the main-hand column, a bow (15) by the off-hand one.
    assert.equal(worldAttachmentPoint(item(17, 26, 1, 3), sheath), 26, "a gun of SheatheType 1: the main back point");
    assert.equal(worldAttachmentPoint(item(17, 25, 3, 16), sheath), 32, "a thrown weapon of type 3: the main hip");
    assert.equal(worldAttachmentPoint(item(17, 15, 1, 2), sheath), 27, "a bow of SheatheType 1: the off-hand back point");
    assert.equal(worldAttachmentPoint(item(17, 15, 2, 2), sheath), 31);
    assert.equal(worldAttachmentPoint(item(17, 15, 5, 2), sheath), undefined, "type 5: no point");
  }
  assert.equal(worldAttachmentPoint(item(17, 15, 0, 2), SHEATH_RANGED), ATTACHMENT_HAND_LEFT, "a bow");
  assert.equal(worldAttachmentPoint(item(17, 26, 0, 3), SHEATH_RANGED), ATTACHMENT_HAND_RIGHT, "a gun (INVTYPE 26)");
  assert.equal(worldAttachmentPoint(item(17, 26, 0, 19), SHEATH_RANGED), ATTACHMENT_HAND_RIGHT, "a wand");
  assert.equal(worldAttachmentPoint(item(17, 25, 0, 16), SHEATH_RANGED), ATTACHMENT_HAND_RIGHT, "a thrown weapon (25)");
});

test("where the SheatheType comes from: the item, else the unit's worn table", () => {
  assert.equal(sheatheOf(item(15, 13, 3), { wornSheathe: { 15: 1 } }), 3);
  assert.equal(sheatheOf(item(15, 13), { wornSheathe: { 15: 1 } }), 1);
  assert.equal(sheatheOf(item(15, 13), undefined), undefined);
  assert.equal(sheatheOf(item(16, 13), { wornSheathe: { 15: 1 } }), undefined);
  assert.deepEqual(wornSheathes([{ slot: 15, inventoryType: 17, displayId: 1, sheathe: 1 },
    { slot: 16, inventoryType: 14, displayId: 2, sheathe: 4 }, { slot: 5, inventoryType: 5, displayId: 3, sheathe: 0 }]),
  { 15: 1, 16: 4 });
  assert.equal(wornSheathes([{ slot: 15, inventoryType: 17, displayId: 1 }]), undefined, "nothing known, no table");
});

test("the renderer hangs through worldAttachmentPoint and the corpse/item plumbing carries the type", () => {
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /worldAttachmentPoint\(item, sheath, sheatheOf\(item, metadata\)\)/);
  const frames = readFileSync(new URL("../src/browser/ui/Frames.ts", import.meta.url), "utf8");
  assert.match(frames, /wornSheathes\(equipment\)/);
  const metadata = readFileSync(new URL("../src/browser/ItemMetadata.ts", import.meta.url), "utf8");
  assert.match(metadata, /sheath: template\.sheath/);
  assert.match(metadata, /left\.sheath === right\.sheath/);
  const npc = readFileSync(new URL("../src/gateway/NpcWeapons.ts", import.meta.url), "utf8");
  assert.match(npc, /SheatheType/);
});
