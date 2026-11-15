import assert from "node:assert/strict";
import test from "node:test";

// 3.13 (15.11): the WMO floor under an object past the collision, cast by the renderer through the group triangles of
// the buildings it holds — Wow.exe 0x007C2A70 → 0x007C28F0: a segment from 0.1 above the feet to 1000 below, and with
// nothing below the same segment upwards (.runtime/re-2026-11-15/go8/d.c, e.c).

const {
  FAR_WMO_CASTS_PER_PASS, FAR_WMO_NEAR, FAR_WMO_RECHECK_MS, FarWmoFloors, castFarWmoFloor, segmentHitFraction,
} = await import("../dist/code/browser/FarWmoFloors.js");

const IDENTITY = { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };

/** A square at height `y` (scene axes: WoW x, z, −y) over x, z ∈ [-half, half] around (cx, cz), as two triangles. */
function square(cx, cz, half, y) {
  return {
    positions: new Float32Array([cx - half, y, cz - half, cx + half, y, cz - half, cx + half, y, cz + half, cx - half, y, cz + half]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/**
 * A building whose model space is the scene (identity placement): group 0 a room with its floor at 5 over WoW
 * x ∈ [100, 120], y ∈ [-10, 10]; group 1 a street open to the sky (MOGP 0x8) at 0 over x ∈ [130, 150].
 */
function inn(overrides = {}) {
  return {
    name: "World\\wmo\\Azeroth\\Buildings\\Inn\\Inn.wmo",
    worldToModel: IDENTITY,
    model: {
      groups: [
        { flags: 0x2000, mesh: square(110, 0, 10, 5) },
        { flags: 0x8, mesh: square(140, 0, 10, 0) },
      ],
    },
    boxes: [
      { min: { x: 100, y: 4, z: -10 }, max: { x: 120, y: 12, z: 10 } },
      { min: { x: 130, y: -1, z: -10 }, max: { x: 150, y: 3, z: 10 } },
    ],
    ...overrides,
  };
}

test("the segment: the nearest triangle under the feet, either winding", () => {
  const floor = square(0, 0, 1, 5);
  assert.equal(segmentHitFraction([0, 6, 0, 0, -4, 0], floor.positions, floor.indices, Infinity), 0.1);
  const flipped = { positions: floor.positions, indices: new Uint16Array([0, 2, 1, 0, 3, 2]) };
  assert.equal(segmentHitFraction([0, 6, 0, 0, -4, 0], flipped.positions, flipped.indices, Infinity), 0.1);
  assert.equal(segmentHitFraction([3, 6, 0, 3, -4, 0], floor.positions, floor.indices, Infinity), Infinity, "beside it");
});

test("castFarWmoFloor: the room's floor under the feet, the street's flags, the model as the collision names it", () => {
  const room = castFarWmoFloor([inn()], 110, 0, 5.05);
  assert.equal(room.model, "inn.wmo");
  assert.equal(room.groupFlags ?? room.flags, 0x2000);
  assert.ok(Math.abs(room.floorZ - 5) < 1e-6);
  assert.equal(room.up, false);
  const street = castFarWmoFloor([inn()], 140, 0, 0);
  assert.equal(street.flags, 0x8);
  const open = castFarWmoFloor([inn()], 200, 0, 0);
  assert.equal(open.model, "");
  assert.ok(Number.isNaN(open.floorZ));
});

test("castFarWmoFloor: nothing below, so the segment goes up (0x007C28F0): a roof over the feet", () => {
  const roof = castFarWmoFloor([inn()], 110, 0, 1);
  assert.equal(roof.up, true);
  assert.equal(roof.model, "inn.wmo");
  assert.ok(Math.abs(roof.floorZ - 5) < 1e-6);
});

test("castFarWmoFloor: a group over the point whose mesh has not arrived leaves the object unknown", () => {
  const held = inn();
  held.model.groups[0] = { flags: 0x2000 };
  assert.equal(castFarWmoFloor([held], 110, 0, 5.05), undefined);
  assert.equal(castFarWmoFloor([held], 140, 0, 0).flags, 0x8, "elsewhere the building still answers");
});

test("castFarWmoFloor: a placed building — the segment goes into the model's space", () => {
  // The model sits 1000 yards east in the scene: worldToModel shifts x back by 1000.
  const moved = inn({ worldToModel: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1000, 0, 0, 1] },
    boxes: [{ min: { x: 1100, y: 4, z: -10 }, max: { x: 1120, y: 12, z: 10 } }, undefined] });
  assert.equal(castFarWmoFloor([moved], 1110, 0, 5.05).model, "inn.wmo");
  assert.equal(castFarWmoFloor([moved], 110, 0, 5.05).model, "", "the model's own coordinates are not the scene's");
});

function objects(entries) {
  return new Map(entries.map(([guid, x, y, z, typeId = 3]) => [guid, { guid, typeId, position: { x, y, z } }]));
}

test("FarWmoFloors: only the ring past the collision, once a second, again after a move; rows follow the objects", () => {
  const floors = new FarWmoFloors();
  const rows = new Map();
  const environment = new Map([[1, { wmo: inn() }], [2, { wmo: undefined }]]);
  const player = { x: 0, y: 0 };
  let world = objects([[10n, 110, 0, 5.05], [11n, FAR_WMO_NEAR - 5, 0, 0], [12n, 140, 0, 0, 5], [13n, 110, 0, 5.05, 7]]);
  floors.publish(rows, world, player, 0, environment, 0);
  assert.deepEqual([...rows.keys()].sort(), [10n, 12n], "near objects are the collision's; a corpse is not listed");
  assert.equal(rows.get(10n).model, "inn.wmo");
  assert.equal(rows.get(12n).groupFlags, 0x8, "game objects too (the town tracker)");
  assert.equal(floors.casts, 2);
  floors.publish(rows, world, player, 0, environment, 500);
  assert.equal(floors.casts, 2);
  world = objects([[10n, 140, 0, 0], [12n, 140, 0, 0, 5]]);
  floors.publish(rows, world, player, 0, environment, 800);
  assert.equal(floors.casts, 2, "moved, but within the second of its last cast");
  floors.publish(rows, world, player, 0, environment, FAR_WMO_RECHECK_MS + 10);
  assert.equal(floors.casts, 3, "a second on, the moved one is cast again");
  assert.equal(rows.get(10n).groupFlags, 0x8);
  floors.publish(rows, world, player, 0, environment, 2 * FAR_WMO_RECHECK_MS + 100);
  assert.equal(floors.casts, 3, "standing still: no cast");
  floors.publish(rows, objects([[12n, 140, 0, 0, 5]]), player, 0, environment, 3 * FAR_WMO_RECHECK_MS);
  assert.deepEqual([...rows.keys()], [12n], "a gone object's row goes");
  floors.publish(rows, undefined, player, 0, environment, 4 * FAR_WMO_RECHECK_MS);
  assert.equal(rows.size, 0, "no world: no rows");
});

test("FarWmoFloors: a building drawn later is cast again for an object that stood still", () => {
  const floors = new FarWmoFloors();
  const rows = new Map();
  const environment = new Map();
  const world = objects([[10n, 110, 0, 5.05]]);
  floors.publish(rows, world, { x: 0, y: 0 }, 0, environment, 0);
  assert.equal(rows.get(10n).model, "");
  environment.set(1, { wmo: inn() });
  floors.publish(rows, world, { x: 0, y: 0 }, 0, environment, FAR_WMO_RECHECK_MS + 1);
  assert.equal(rows.get(10n).model, "inn.wmo");
});

test("FarWmoFloors: at most a fixed number of casts a pass; the rest come on the next", () => {
  const floors = new FarWmoFloors();
  const rows = new Map();
  const environment = new Map([[1, { wmo: inn() }]]);
  const entries = [];
  for (let index = 0; index < FAR_WMO_CASTS_PER_PASS + 5; index++) entries.push([BigInt(100 + index), 110, 0, 5.05]);
  const world = objects(entries);
  floors.publish(rows, world, { x: 0, y: 0 }, 0, environment, 0);
  assert.equal(rows.size, FAR_WMO_CASTS_PER_PASS);
  floors.publish(rows, world, { x: 0, y: 0 }, 0, environment, 250);
  assert.equal(rows.size, FAR_WMO_CASTS_PER_PASS + 5);
});
