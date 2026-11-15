// 6.18 (line A7a, slice G, 05.10; 15.11): where the glue figures hold their weapons.
// Select screen: Wow.exe 0x004e3cd0 hangs the weapons through 0x004eacd0 with no sheath state and the
// gun flag 0 — the ranged weapon of any type in the left hand (point 2).
// Creation screen (15.11): 0x004e0fd0 → 0x004ef900 / 0x004f29c0 — the main hand on 1, an off-hand weapon
// on 2, a shield on 0; a hunter's bow in the left hand and gun or crossbow (type 26) in the right; the head
// never, a hunter's melee never, and no ranged weapon for anyone but a hunter.
import assert from "node:assert/strict";
import test from "node:test";
import { SHEATH_MELEE, SHEATH_RANGED } from "../dist/code/browser/Attachment.js";
import { creationWears, figurePoint, figureSheath } from "../dist/code/browser/glue/CharSelectWorn.js";
import { characterLook, figurePieces } from "../dist/code/browser/glue/GlueCharacterScene.js";

const HAND_RIGHT = 1;
const HAND_LEFT = 2;
const SHIELD = 0;

function summary(classId) {
  const equipment = Array.from({ length: 23 }, () => ({ displayId: 0, inventoryType: 0, enchantVisual: 0 }));
  equipment[17] = { displayId: 1017, inventoryType: 15, enchantVisual: 0 };
  return {
    guid: 7n, name: "Тест", race: 1, classId, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0,
    facialHair: 0, flags: 0, equipment,
  };
}

const piece = (slot, inventoryType) => ({ slot, inventoryType, side: "right", model: `m${slot}.m2`, texture: "" });

test("the select screen holds the ranged weapon of any type in the left hand", () => {
  assert.equal(figureSheath(17, true), SHEATH_RANGED);
  assert.equal(figureSheath(15, true), SHEATH_MELEE);
  assert.equal(figurePoint(piece(17, 15), true), HAND_LEFT, "a bow");
  assert.equal(figurePoint(piece(17, 26), true), HAND_LEFT, "a gun: 0x004e3cd0 passes the gun flag 0");
  assert.equal(figurePoint(piece(15, 13), true), HAND_RIGHT);
  assert.equal(figurePoint(piece(16, 14), true), SHIELD);
});

test("the creation screen: main hand right, off hand left, shield on 0, bow left and gun right", () => {
  assert.equal(figurePoint(piece(15, 17), false), HAND_RIGHT);
  assert.equal(figurePoint(piece(16, 22), false), HAND_LEFT);
  assert.equal(figurePoint(piece(16, 14), false), SHIELD);
  assert.equal(figurePoint(piece(17, 15), false), HAND_LEFT, "0x004e0fd0: a bow's flag is 0");
  assert.equal(figurePoint(piece(17, 26), false), HAND_RIGHT, "0x004e0fd0: type 26 sets the right-hand flag");
});

test("the creation screen wears no head, a hunter no melee, nobody else a ranged weapon", () => {
  assert.equal(creationWears(1, 1), false, "the head (0x004e0fd0 skips type 1)");
  assert.equal(creationWears(5, 1), true);
  assert.equal(creationWears(13, 4), true, "a rogue's dagger");
  assert.equal(creationWears(22, 4), true, "a rogue's off-hand dagger");
  assert.equal(creationWears(25, 4), false, "a rogue's thrown knife (0x004f29c0 has no case for it)");
  assert.equal(creationWears(17, 3), false, "a hunter's two-hander");
  assert.equal(creationWears(15, 3), true, "a hunter's bow");
  assert.equal(creationWears(26, 3), true, "a hunter's gun");
  assert.equal(creationWears(15, 1), false, "a warrior's bow");
  assert.equal(creationWears(23, 8), false, "a holdable (0x004f29c0 has no case for 23)");
  assert.equal(creationWears(14, 1), true, "a shield");
});

test("a select-screen look hangs by the select rule, a creation look by its own", () => {
  assert.equal(characterLook(summary(3), 49).charSelect, true);
  const appearance = { attached: [piece(17, 26)] };
  assert.equal(figurePieces(appearance, { charSelect: true }, undefined)[0].point, HAND_LEFT);
  assert.equal(figurePieces(appearance, {}, undefined)[0].point, HAND_RIGHT);
});
