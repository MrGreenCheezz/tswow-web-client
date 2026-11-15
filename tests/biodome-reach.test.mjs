// 15.11 (7.66 tail, far8): Netherstorm's biodomes. Wow.exe's doodad def takes the MDDF record's flag 0x1 as its 0x800
// (0x007becd0) and 0x00791cb0 skips the size-class distance for it; the stand frame fog6-o-netherstorm drew the
// Stormspire's dome with its origin 1,336 yards from the camera. The tile carries the flag (visual-tile-v8) and the
// renderer holds such a doodad to the shells' leash measured to its box.
import assert from "node:assert/strict";
import test from "node:test";
import { parseAdtPlacements } from "../tools/adt-placements.mjs";
import {
  biodomeDrawRange, clearDoodadModelBoxes, doodadWorldGroundExtent, recordDoodadModelBox,
} from "../dist/code/browser/DoodadReach.js";
import { validateEnvironmentTileReport } from "../dist/code/browser/EnvironmentTileDecode.js";
import { environmentDrawRange, environmentRankInRange } from "../dist/code/browser/WorldRenderer3D.js";
import { EnvironmentGridIndex } from "../dist/code/browser/EnvironmentGridIndex.js";

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** An ADT with two M2 records of one model: the first flagged 0x1 (biodome), the second 0x2 (Grizzly Hills' bushes). */
function adt() {
  const name = Buffer.from("World\\Dome.m2\0", "latin1");
  const records = [];
  for (const [id, flags] of [[7, 0x1], [8, 0x2]]) {
    const record = Buffer.alloc(36);
    record.writeUInt32LE(0, 0);
    record.writeUInt32LE(id, 4);
    record.writeUInt16LE(1024, 32);
    record.writeUInt16LE(flags, 34);
    records.push(record);
  }
  return Buffer.concat([
    chunk("MMDX", name), chunk("MMID", Buffer.alloc(4)), chunk("MDDF", Buffer.concat(records)),
  ]);
}

// NS_BIODOME_ALL_FX_STORMSPIRE.M2's header box (0xA0) and its placement (Expansion01_25_23 and three more tiles).
const STORMSPIRE_BOX = {
  min: [-344.56964111328125, -339.0067443847656, -211.13265991210938],
  max: [395.3534851074219, 401.82965087890625, 280.9752502441406],
};
const stormspire = (extra = {}) => ({
  id: 1051046, kind: "m2", name: "WORLD\\EXPANSION01\\DOODADS\\NETHERSTORM\\BIODOMES\\NS_BIODOME_ALL_FX_STORMSPIRE.M2",
  x: 4235.446939997499, y: 3095.8736978099987, z: 167.05914306640625,
  rotationX: 0, rotationY: 2, rotationZ: 0, scale: 1, biodome: true, ...extra,
});
/** The stand frame's camera (fog6-o-netherstorm K line). */
const CAMERA = { x: 3020, y: 3650 };

test("the ADT parser reads MDDF flag 0x1 as `biodome` when asked (visual-tile-v8), and nothing else", () => {
  const asked = parseAdtPlacements(adt(), { biodome: true });
  assert.deepEqual(asked.map((object) => object.biodome), [true, undefined], "flag 0x2 is not the biodome");
  assert.ok(parseAdtPlacements(adt()).every((object) => !("biodome" in object)), "older generations keep their bytes");
});

test("the tile check accepts `biodome: true` on an M2 and turns away any other use", () => {
  const base = { id: 1, kind: "m2", name: "a.m2", x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const report = validateEnvironmentTileReport([
    { ...base, biodome: true }, { ...base, id: 2, biodome: false }, { ...base, id: 3, kind: "wmo", biodome: true }, base,
  ]);
  assert.deepEqual(report.objects.map((object) => object.id), [1, 1]);
  assert.equal(report.rejected, 2);
});

test("a biodome is held to the reach plus its box's ground extent; before its box is known, to the footprint", () => {
  clearDoodadModelBoxes();
  const dome = stormspire();
  assert.equal(biodomeDrawRange({ ...dome, biodome: undefined }, 1277), undefined, "an unflagged doodad keeps its class");
  assert.equal(biodomeDrawRange(dome, 1277), Number.POSITIVE_INFINITY);
  recordDoodadModelBox(dome.name, STORMSPIRE_BOX);
  // The farthest corner across the ground: (395.35, 401.83) yards, whatever the turn about the vertical.
  const corner = Math.hypot(395.3534851074219, 401.82965087890625); // 563.7 yards
  assert.ok(Math.abs(doodadWorldGroundExtent(dome) - corner) < 1e-3);
  assert.ok(Math.abs(biodomeDrawRange(dome, 1277) - (1277 + corner)) < 1e-3);
});

test("the Stormspire's dome stands 1,336 yards out and is drawn on every lighting level; an unflagged twin is not", () => {
  clearDoodadModelBoxes();
  recordDoodadModelBox(stormspire().name, STORMSPIRE_BOX);
  const dome = stormspire();
  const twin = stormspire({ id: 2, biodome: undefined });
  for (const [faithful, shell] of [[true, 1277], [false, 1100]]) {
    const { candidates } = environmentRankInRange([dome, twin], CAMERA, 1.5, shell, faithful);
    assert.deepEqual(candidates.map(({ object }) => object.id), [1051046], `faithful ${faithful}`);
    assert.ok(candidates[0].distance > 1335 && candidates[0].distance < 1337);
  }
  // Without the flag: class 4 (a 740-yard box) on the faithful levels, the 400-yard name leash on the enhanced ones.
  assert.equal(environmentDrawRange(twin, 1.5, 1277, true), 1250);
  assert.equal(environmentDrawRange(twin, 1, 1100, false), 400);
  // The flag widens nothing indoors: a WMO's own doodad keeps its room leash.
  assert.equal(environmentDrawRange(stormspire({ interior: true }), 1, 1100, false), 60);
});

test("the placement index hands a biodome to every query: the enhanced path's 1,160-yard pool reaches it", () => {
  const dome = stormspire();
  const twin = stormspire({ id: 2, biodome: undefined });
  const pool = new EnvironmentGridIndex([dome, twin]).queryCached(CAMERA.x, CAMERA.y, 1160).objects;
  assert.deepEqual(pool.map((object) => object.id), [1051046], "its point is 1,215 yards north: outside the square");
});
