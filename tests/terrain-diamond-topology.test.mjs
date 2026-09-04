import assert from "node:assert/strict";
import test from "node:test";
import { TERRAIN_GRID_SIZE, TerrainTile } from "../dist/code/browser/Terrain.js";
import { terrainGeometryData } from "../dist/code/browser/WorldRenderer3D.js";

const CELLS = 128;
const CORNERS = CELLS + 1;

function fourCC(bytes, offset, value) {
  for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
}

/** A minimal TrinityCore map tile whose V9 corners are flat but whose authored V8 centres are not. */
function diamondTile(centres) {
  const heightOffset = 44;
  const v9Offset = heightOffset + 16;
  const v8Offset = v9Offset + CORNERS * CORNERS * 4;
  const liquidOffset = v8Offset + CELLS * CELLS * 4;
  const holesOffset = liquidOffset + 16;
  const data = new ArrayBuffer(holesOffset + 16 * 16 * 2);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);

  fourCC(bytes, 0, "MAPS");
  view.setUint32(4, 10, true);
  view.setUint32(20, heightOffset, true);
  view.setUint32(28, liquidOffset, true);
  view.setUint32(32, 16, true);
  view.setUint32(36, holesOffset, true);
  view.setUint32(40, 16 * 16 * 2, true);

  fourCC(bytes, heightOffset, "MHGT");
  view.setUint32(heightOffset + 4, 0, true);
  view.setFloat32(heightOffset + 8, 0, true);
  view.setFloat32(heightOffset + 12, Math.max(...centres.map(({ height }) => height)), true);
  for (const { row, column, height } of centres) {
    view.setFloat32(v8Offset + (row * CELLS + column) * 4, height, true);
  }

  fourCC(bytes, liquidOffset, "MLIQ");
  view.setUint8(liquidOffset + 4, 0x03);
  view.setUint8(liquidOffset + 5, 0x01);
  view.setUint8(liquidOffset + 10, 128);
  view.setUint8(liquidOffset + 11, 128);
  return new TerrainTile(data);
}

const centres = [
  { row: 0, column: 0, height: 8 },
  { row: 37, column: 91, height: 19 },
  { row: 127, column: 127, height: 31 },
];

test("TerrainTile indexes V8 centres at the first, middle, and final cell", () => {
  const tile = diamondTile(centres);
  const step = TERRAIN_GRID_SIZE / CELLS;
  for (const { row, column, height } of centres) {
    const worldX = -(row + 0.5) * step;
    const worldY = -(column + 0.5) * step;
    assert.equal(tile.heightAt(worldX, worldY), height);
  }
});

test("the rendered terrain keeps authored V8 centres instead of bridging across them", () => {
  // Three far-apart cells model the same report recurring in unrelated map locations. A V9-only
  // quad bridges straight across each authored V8 centre, leaving the visible ground displaced
  // from the source terrain (and therefore from WMO/doodad joins authored against that terrain).
  const tile = diamondTile(centres);
  const step = TERRAIN_GRID_SIZE / CELLS;
  const geometry = terrainGeometryData(
    { x: 32, y: 32 },
    { x: 0, y: 0, z: 0, orientation: 0 },
    (x, y) => tile.heightAt(x, y),
  );
  assert.equal(geometry.positions.length / 3, CORNERS * CORNERS + CELLS * CELLS);
  assert.equal(geometry.uvs.length / 2, geometry.positions.length / 3);
  assert.equal(geometry.normals.length, geometry.positions.length);
  assert.equal(geometry.indices.length, CELLS * CELLS * 4 * 3);

  for (const { row, column, height } of centres) {
    const worldX = -(row + 0.5) * step;
    const worldY = -(column + 0.5) * step;
    assert.equal(tile.heightAt(worldX, worldY), height, "the map decoder sees the authored centre");
    const cell = row * CELLS + column;
    const centre = CORNERS * CORNERS + cell;
    assert.equal(geometry.positions[centre * 3 + 1], height,
      `cell ${row}/${column}: rendered ground passes through its authored centre`);
    assert.ok(Math.abs(geometry.uvs[centre * 2] - (column + 0.5) / CELLS) < 1e-7);
    assert.ok(Math.abs(geometry.uvs[centre * 2 + 1] - (1 - (row + 0.5) / CELLS)) < 1e-7);

    const a = row * CORNERS + column;
    const b = a + 1;
    const c = a + CORNERS;
    const d = c + 1;
    assert.deepEqual(geometry.indices.slice(cell * 12, cell * 12 + 12), [
      a, c, centre, c, d, centre, d, b, centre, b, a, centre,
    ], `cell ${row}/${column}: four authored triangles meet at V8`);
    const normal = [...geometry.normals.slice(centre * 3, centre * 3 + 3)];
    assert.ok(normal.every(Number.isFinite), `cell ${row}/${column}: centre normal is finite`);
    assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-5,
      `cell ${row}/${column}: centre normal is unit length`);
  }
});

test("a terrain hole removes the complete four-triangle diamond and nothing beside it", () => {
  const tile = diamondTile([{ row: 12, column: 34, height: 7 }]);
  const step = TERRAIN_GRID_SIZE / CELLS;
  const hole = { x: -(12 + 0.5) * step, y: -(34 + 0.5) * step };
  const geometry = terrainGeometryData(
    { x: 32, y: 32 },
    { x: 0, y: 0, z: 0, orientation: 0 },
    (x, y) => tile.heightAt(x, y),
    (x, y) => Math.abs(x - hole.x) < 1e-7 && Math.abs(y - hole.y) < 1e-7,
  );
  const holeCentre = CORNERS * CORNERS + 12 * CELLS + 34;
  const neighbourCentre = holeCentre + 1;
  assert.equal(geometry.indices.length, (CELLS * CELLS - 1) * 4 * 3);
  assert.equal(geometry.indices.filter((index) => index === holeCentre).length, 0);
  assert.equal(geometry.indices.filter((index) => index === neighbourCentre).length, 4);
});

test("terrain-hole normals ignore the omitted V8 fan", () => {
  const row = 12;
  const column = 34;
  const step = TERRAIN_GRID_SIZE / CELLS;
  const hole = { x: -(row + 0.5) * step, y: -(column + 0.5) * step };
  const atHole = (x, y) => Math.abs(x - hole.x) < 1e-7 && Math.abs(y - hole.y) < 1e-7;
  const build = (omittedHeight) => terrainGeometryData(
    { x: 32, y: 32 },
    { x: 0, y: 0, z: 0, orientation: 0 },
    (x, y) => atHole(x, y) ? omittedHeight : 0,
    atHole,
  );
  const flat = build(0);
  const peaked = build(1000);
  const corners = [
    row * CORNERS + column,
    row * CORNERS + column + 1,
    (row + 1) * CORNERS + column,
    (row + 1) * CORNERS + column + 1,
  ];
  for (const corner of corners) {
    assert.deepEqual(
      [...peaked.normals.slice(corner * 3, corner * 3 + 3)],
      [...flat.normals.slice(corner * 3, corner * 3 + 3)],
      `V9 ${corner}: an omitted centre cannot affect a rendered normal`,
    );
  }
});

test("diamond geometry keeps canonical V9 positions and normals at a tile join", () => {
  const ownerHeight = (x, y) => {
    const gridX = Math.floor(32 - x / TERRAIN_GRID_SIZE);
    const gridY = Math.floor(32 - y / TERRAIN_GRID_SIZE);
    return gridX * 100 + gridY;
  };
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const left = terrainGeometryData({ x: 32, y: 32 }, player, ownerHeight);
  const right = terrainGeometryData({ x: 33, y: 32 }, player, ownerHeight);
  for (const column of [0, 37, 64, 127, 128]) {
    const leftVertex = 128 * CORNERS + column;
    const rightVertex = column;
    assert.deepEqual(
      [...left.positions.slice(leftVertex * 3, leftVertex * 3 + 3)],
      [...right.positions.slice(rightVertex * 3, rightVertex * 3 + 3)],
      `shared V9 position ${column}`,
    );
    const leftNormal = [...left.normals.slice(leftVertex * 3, leftVertex * 3 + 3)];
    const rightNormal = [...right.normals.slice(rightVertex * 3, rightVertex * 3 + 3)];
    assert.ok(leftNormal.every(Number.isFinite) && rightNormal.every(Number.isFinite));
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(leftNormal[axis] - rightNormal[axis]) < 1e-7,
        `shared V9 normal ${column}/${axis}`);
    }
  }
});
