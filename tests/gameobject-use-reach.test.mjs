import assert from "node:assert/strict";
import test from "node:test";
import {
  chairSeatCount, chairSeats, gameObjectInReach, gameObjectUseRange, gameObjectWithinUseReach, insideGrownBox,
} from "../dist/code/world/GameObjectUseReach.js";
import { placedBoxCorners } from "../dist/code/world/GameObjectModelFrame.js";

// 4.15 (15.11): a game object's use reach as Wow.exe 12340 measures it (.runtime/re-2026-11-15/go8): the type helper's
// range (helper+0xC from each constructor of the factory 0x00714250) around the display's box in the object's own axes
// (0x0070FA70, strictly inside, 0x006CB930), the centre only for a spell focus, and the chairs' seats (0x00711DB0).
// Types are the protocol's GameobjectTypes; no object or spell id is used.

const DOOR = 0, QUESTGIVER = 2, BINDER = 4, CHAIR = 7, SPELL_FOCUS = 8, TEXT = 9, TRANSPORT = 11, AREADAMAGE = 12;
const CAMERA = 13, MAP_OBJECT = 14, MO_TRANSPORT = 15, FISHINGNODE = 17, MAILBOX = 19, DUNGEON_DIFFICULTY = 31;
const BARBER_CHAIR = 32, DESTRUCTIBLE = 33, GUILD_BANK = 34, TRAPDOOR = 35;

const yawQuat = (yaw) => ({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) });

function corners(box, position, yaw = 0, scale = 1) {
  return placedBoxCorners(box, position, yawQuat(yaw), scale, new Float64Array(24));
}

test("each helper keeps its own range (helper+0xC)", () => {
  assert.equal(gameObjectUseRange(DOOR), 5);
  assert.equal(gameObjectUseRange(QUESTGIVER), 5.5555553);
  assert.equal(gameObjectUseRange(TEXT), 5.5555553);
  assert.equal(gameObjectUseRange(BINDER), 10, "0x0070C4E0 loads 0x00A33578");
  assert.equal(gameObjectUseRange(CHAIR), 3, "0x0070C6A0 loads 0x00A3357C");
  assert.equal(gameObjectUseRange(BARBER_CHAIR), 3, "0x0070C7F0 loads 0x00A3357C");
  assert.equal(gameObjectUseRange(AREADAMAGE), 0);
  assert.equal(gameObjectUseRange(FISHINGNODE), 100);
  // The rest keep the common five yards: the transports (0x00713250), map object, camera, difficulty object,
  // destructible building, and the mailbox and guild vault (no special helper; not the server's ten).
  for (const type of [TRANSPORT, MO_TRANSPORT, TRAPDOOR, MAP_OBJECT, CAMERA, DUNGEON_DIFFICULTY, DESTRUCTIBLE, MAILBOX, GUILD_BANK]) {
    assert.equal(gameObjectUseRange(type), 5, `type ${type}`);
  }
});

test("the reach is the box grown by the range, not a sphere round the centre", () => {
  // A long object: ten yards along x, one across.
  const box = { minX: -5, minY: -0.5, minZ: 0, maxX: 5, maxY: 0.5, maxZ: 2 };
  const at = { x: 100, y: 200, z: 10 };
  const placed = corners(box, at);
  // Nine yards along the long side is within reach (the box ends at 5, plus 5) though the centre is 9 away.
  assert.equal(gameObjectInReach({ type: DOOR, player: { x: 109, y: 200, z: 10 }, position: at, corners: placed }), true);
  // Six yards off the narrow side is not (0.5 + 5 = 5.5).
  assert.equal(gameObjectInReach({ type: DOOR, player: { x: 100, y: 206, z: 10 }, position: at, corners: placed }), false);
  // Without a drawn box the centre is measured, as before.
  assert.equal(gameObjectInReach({ type: DOOR, player: { x: 109, y: 200, z: 10 }, position: at }), false);
});

test("the box turns with the object and the test is strict", () => {
  const box = { minX: -5, minY: -0.5, minZ: 0, maxX: 5, maxY: 0.5, maxZ: 2 };
  const at = { x: 0, y: 0, z: 0 };
  const turned = corners(box, at, Math.PI / 2);
  // Turned a quarter, the long side runs along y.
  assert.equal(gameObjectInReach({ type: DOOR, player: { x: 0, y: 9, z: 0 }, position: at, corners: turned }), true);
  assert.equal(gameObjectInReach({ type: DOOR, player: { x: 9, y: 0, z: 0 }, position: at, corners: turned }), false);
  // On the grown face exactly is outside (0x006CB930 compares with <).
  const straight = corners(box, at);
  assert.equal(insideGrownBox(straight, 5, { x: 10, y: 0, z: 1 }), false);
  assert.equal(insideGrownBox(straight, 5, { x: 9.999, y: 0, z: 1 }), true);
  // The scale grows the box, not the range.
  const scaled = corners(box, at, 0, 2);
  assert.equal(insideGrownBox(scaled, 5, { x: 14.9, y: 0, z: 1 }), true);
  assert.equal(insideGrownBox(scaled, 5, { x: 0, y: 6.1, z: 1 }), false);
});

test("a spell focus is measured from its centre, a lock spell's range replaces the helper's", () => {
  const box = { minX: -5, minY: -5, minZ: 0, maxX: 5, maxY: 5, maxZ: 2 };
  const at = { x: 0, y: 0, z: 0 };
  const placed = corners(box, at);
  assert.equal(gameObjectInReach({ type: SPELL_FOCUS, player: { x: 5, y: 0, z: 0 }, position: at, corners: placed }), true);
  assert.equal(gameObjectInReach({ type: SPELL_FOCUS, player: { x: 7, y: 0, z: 0 }, position: at, corners: placed }), false);
  assert.equal(gameObjectInReach({ type: DOOR, player: { x: 7, y: 0, z: 0 }, position: at, corners: placed }), true);
  assert.equal(gameObjectInReach({ type: DOOR, player: { x: 7, y: 0, z: 0 }, position: at, corners: placed, spellRange: 1 }), false);
});

test("a chair also wants a seat within three yards", () => {
  // Three seats along the chair's own y axis, a yard apart (0x004F55F0 with 0x009E1130 = 1, 0x009F70E8 = 0.5).
  const round = (value) => Math.round(value * 1e6) / 1e6 + 0;
  assert.deepEqual(chairSeats({ x: 0, y: 0, z: 0 }, 0, 1, 3).map((seat) => [round(seat.x), round(seat.y)]),
    [[0, -1], [0, 0], [0, 1]]);
  // Facing +y, the seats run along −x (the facing turned a quarter left).
  assert.deepEqual(chairSeats({ x: 0, y: 0, z: 0 }, Math.PI / 2, 2, 2).map((seat) => [round(seat.x), round(seat.y)]),
    [[1, 0], [-1, 0]]);
  assert.equal(chairSeatCount(CHAIR, [3, 1]), 3, "the chair's data word 0 (0x00746190 property 0xB)");
  assert.equal(chairSeatCount(BARBER_CHAIR, [0, 0]), 1, "0x008C8DE0 returns 1");
  const bench = { minX: -0.5, minY: -1.5, minZ: 0, maxX: 0.5, maxY: 1.5, maxZ: 1 };
  const at = { x: 0, y: 0, z: 0 };
  const placed = corners(bench, at);
  const base = { type: CHAIR, position: at, corners: placed, orientation: 0, scale: 1, data: [3, 1] };
  // Inside the grown box (1.5 + 3 = 4.5) and 2.9 from the last seat.
  assert.equal(gameObjectWithinUseReach({ ...base, player: { x: 0, y: 3.9, z: 0 } }), true);
  // Still inside the grown box, but 3.2 from the nearest seat: ERR_USE_TOO_FAR.
  assert.equal(gameObjectWithinUseReach({ ...base, player: { x: 0, y: 4.2, z: 0 } }), false);
  // The barber chair's one seat is its centre.
  assert.equal(gameObjectWithinUseReach({ ...base, type: BARBER_CHAIR, player: { x: 0, y: 3.9, z: 0 } }), false);
  assert.equal(gameObjectWithinUseReach({ ...base, type: BARBER_CHAIR, player: { x: 0, y: 2.9, z: 0 } }), true);
});
