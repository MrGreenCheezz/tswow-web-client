import assert from "node:assert/strict";
import test from "node:test";
import { TERRAIN_GRID_SIZE, terrainGrid } from "../dist/code/browser/Terrain.js";
import {
  MINIMAP_TILE_PIXELS, MINIMAP_YARDS_PER_PIXEL, WORLD_MAP_FRAME_HEIGHT, WORLD_MAP_FRAME_WIDTH,
  clampToCircle, hasMapBounds, minimapBlip, minimapPixel, minimapTileOf, minimapWorldAt,
  worldMapPoint, worldMapWorld,
} from "../dist/code/browser/MinimapGeometry.js";
import { loadMinimapIndex, minimapTexturePath, parseMd5Translate, tilesOfMap } from "../tools/minimap-index.mjs";
import { openClientArchives } from "../tools/mpq.mjs";

// The index itself lives in the archives, which not every machine has.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("a minimap pixel is the terrain grid at 256 to the tile", () => {
  assert.equal(MINIMAP_YARDS_PER_PIXEL, TERRAIN_GRID_SIZE / MINIMAP_TILE_PIXELS);

  // The world origin sits on the corner of tile 32, which is pixel 32 * 256 on both axes.
  assert.deepEqual(minimapPixel(0, 0), { row: 32 * 256, column: 32 * 256 });

  // North is +X and east is -Y, so both a row and a column grow as their axis falls.
  const north = minimapPixel(TERRAIN_GRID_SIZE, 0);
  const east = minimapPixel(0, -TERRAIN_GRID_SIZE);
  assert.equal(north.row, 31 * 256, "going north moves up the sheet");
  assert.equal(east.column, 33 * 256, "going east moves right along the sheet");
});

test("a tile index agrees with the terrain grid inside it and beats it outside", () => {
  for (let step = 0; step < 100; step++) {
    const x = -17_000 + step * 340;
    const y = 17_000 - step * 340;
    const terrain = terrainGrid(x, y);
    const tile = minimapTileOf(x, y);
    if (terrain) assert.deepEqual({ gridX: terrain.x, gridY: terrain.y }, tile, `at ${x}, ${y}`);
  }

  // Half a tile past the southern edge of the world. trunc rounds towards zero and hands back a
  // tile index that passes a ">= 0" bounds check, painting the far corner of the map under the
  // character; floor says what it is.
  const beyond = TERRAIN_GRID_SIZE * 32.5;
  assert.ok(Math.trunc(32 - beyond / TERRAIN_GRID_SIZE) >= 0, "trunc lets an off-map position look on-map");
  assert.equal(minimapTileOf(beyond, 0).gridX, -1);
});

test("a blip points where the world does, not where the camera does", () => {
  const player = { x: 100, y: 200 };
  const yardsPerPixel = 2;

  // North of the player is up (negative row) and dead ahead on the column.
  const north = minimapBlip(player, { x: 140, y: 200 }, yardsPerPixel);
  assert.equal(north.row, -20);
  assert.ok(Math.abs(north.column) < 1e-9);

  // East is falling Y, and it is to the right. The radar this replaces had this mirrored.
  const east = minimapBlip(player, { x: 100, y: 160 }, yardsPerPixel);
  assert.equal(east.column, 20);
  assert.ok(Math.abs(east.row) < 1e-9);

  // Facing west (orientation π/2 is +Y), north lies to the right on a rotating map.
  const rotated = minimapBlip(player, { x: 140, y: 200 }, yardsPerPixel, Math.PI / 2);
  assert.ok(rotated.column > 19.99, `north should swing right, got column ${rotated.column}`);
  assert.ok(Math.abs(rotated.row) < 1e-9, `and stop being ahead, got row ${rotated.row}`);

  // Facing north is the same as north up.
  const straight = minimapBlip(player, { x: 140, y: 160 }, yardsPerPixel, 0);
  assert.deepEqual(
    [Math.round(straight.row), Math.round(straight.column)],
    [-20, 20],
  );

  // Out of range keeps its direction and loses its distance.
  const far = clampToCircle(minimapBlip(player, { x: 1000, y: 200 }, yardsPerPixel), 64);
  assert.equal(Math.round(Math.hypot(far.row, far.column)), 64);
  assert.ok(far.row < 0 && Math.abs(far.column) < 1e-9);
  const near = minimapBlip(player, { x: 110, y: 200 }, yardsPerPixel);
  assert.deepEqual(clampToCircle(near, 64), near, "inside the rim nothing moves");
});

test("a world-map rectangle projects and unprojects the axes the DBC actually names", () => {
  // WorldMapArea 4, Durotar, straight out of the table: Left and Right bound world Y, Top and
  // Bottom bound world X, and both pairs run backwards — left > right, top > bottom.
  const durotar = { left: -1962.4999, right: -7249.9995, top: 1808.3333, bottom: -1716.6666 };
  assert.equal(hasMapBounds(durotar), true);
  assert.equal(hasMapBounds({ left: 0, right: 0, top: 0, bottom: 0 }), false);

  const centre = worldMapPoint(durotar, (durotar.top + durotar.bottom) / 2, (durotar.left + durotar.right) / 2);
  assert.ok(Math.abs(centre.u - 0.5) < 1e-9 && Math.abs(centre.v - 0.5) < 1e-9);

  // The northern edge is the top of the picture, and going east moves right.
  assert.ok(Math.abs(worldMapPoint(durotar, durotar.top, durotar.left).v) < 1e-9);
  const west = worldMapPoint(durotar, 0, -2500);
  const east = worldMapPoint(durotar, 0, -6500);
  assert.ok(east.u > west.u, "east is the higher u");

  // A click has to come back out as the position it stood over.
  const back = worldMapWorld(durotar, worldMapPoint(durotar, 900, -3000));
  assert.ok(Math.abs(back.x - 900) < 1e-6 && Math.abs(back.y + 3000) < 1e-6);
});

test("real WorldMapArea anchors land on the clipped 3.3.5 detail frame", () => {
  // Durotar's shipped WorldMapArea row is a useful ground-map anchor: its four DBC bounds must
  // reach the visible detail frame edges, while its midpoint must remain the visual centre.  The
  // source art is 1024x768 tiles, but Blizzard's WorldMapDetailFrame is 1002x668 and clips the
  // unused last column/row.
  const durotar = { left: -1962.4999, right: -7249.9995, top: 1808.3333, bottom: -1716.6666 };
  assert.deepEqual({ width: WORLD_MAP_FRAME_WIDTH, height: WORLD_MAP_FRAME_HEIGHT }, { width: 1002, height: 668 });
  const northWest = worldMapPoint(durotar, durotar.top, durotar.left);
  const southEast = worldMapPoint(durotar, durotar.bottom, durotar.right);
  assert.ok(Math.abs(northWest.u * WORLD_MAP_FRAME_WIDTH) < 1e-6);
  assert.ok(Math.abs(northWest.v * WORLD_MAP_FRAME_HEIGHT) < 1e-6);
  assert.ok(Math.abs(southEast.u * WORLD_MAP_FRAME_WIDTH - WORLD_MAP_FRAME_WIDTH) < 1e-6);
  assert.ok(Math.abs(southEast.v * WORLD_MAP_FRAME_HEIGHT - WORLD_MAP_FRAME_HEIGHT) < 1e-6);
  const centre = worldMapPoint(
    durotar,
    (durotar.top + durotar.bottom) / 2,
    (durotar.left + durotar.right) / 2,
  );
  assert.ok(Math.abs(centre.u * WORLD_MAP_FRAME_WIDTH - 501) < 1e-6);
  assert.ok(Math.abs(centre.v * WORLD_MAP_FRAME_HEIGHT - 334) < 1e-6);
});

test("clicking the frame lands where the same point was drawn, rotated or not", () => {
  // The invariant that matters: the click handler and the blip projection must agree about the
  // sign of the rotation. A mismatch is invisible until a ping arrives somewhere nobody clicked.
  const player = { x: -9450, y: -60 };
  const yardsPerPixel = 2.5;
  for (const facing of [undefined, 0, Math.PI / 2, Math.PI, -1.2, 5.9]) {
    for (const object of [{ x: -9200, y: -60 }, { x: -9450, y: 300 }, { x: -9600, y: -420 }]) {
      const drawn = minimapBlip(player, object, yardsPerPixel, facing);
      const back = minimapWorldAt(player, drawn, yardsPerPixel, facing);
      assert.ok(
        Math.abs(back.x - object.x) < 1e-6 && Math.abs(back.y - object.y) < 1e-6,
        `facing ${facing}: ${JSON.stringify(object)} came back as ${JSON.stringify(back)}`,
      );
    }
  }

  // And a click straight up on a north-up frame is due north, not due south.
  const north = minimapWorldAt(player, { row: -40, column: 0 }, yardsPerPixel);
  assert.ok(north.x > player.x);
  const east = minimapWorldAt(player, { row: 0, column: 40 }, yardsPerPixel);
  assert.ok(east.y < player.y, "east is falling Y");
});

test("a custom map's tiles are indexed even where the first number lost its zero", () => {
  // Exactly what tswow appends to md5translate.trs for a map of its own: a `dir:` header, then one
  // line per tile, and the leading zero stripped from the *first* number only — «md5translate
  // quirk: only y padded with 0 (mapx_0y), we must remove it from x» (BuildMinimaps.ts:123-128).
  // The two-digit rule this parser used to carry matched none of the ten values that produces, so
  // a custom map whose tiles sit in that band had no minimap and no error to say why.
  const block = [
    "dir:\tMyMap",
    "MyMap\\map8_30.blp\tMyMap_08_30.blp",
    "MyMap\\map0_31.blp\tMyMap_00_31.blp",
    "MyMap\\map10_30.blp\tMyMap_10_30.blp",
    "MyMap\\MyMapDoodad.blp\t7f1e5a0c9b3d4e2f8a6c1b0d5e9f3a72.blp",
    "",
  ].join("\r\n");

  const index = parseMd5Translate(block);
  assert.equal(index.size, 4);
  const tiles = tilesOfMap(index, "MyMap");
  // `map<gridY>_<gridX>`, the same reading as a stock tile: 8/30 is row 8, column 30.
  assert.deepEqual(tiles, { "30-8": "MyMap_08_30", "31-0": "MyMap_00_31", "30-10": "MyMap_10_30" },
    "the doodad bake is not a tile and the single-digit tiles are");
  // And the value is a plain filename rather than an MD5, which is the other half of tswow's
  // layout: the BLP it points at is the one it puts in the patch directory under that name.
  assert.equal(minimapTexturePath(tiles["30-8"]), "textures\\Minimap\\MyMap_08_30.blp");
});

test("the client's own minimap index still parses whole", withClient, async () => {
  // The regression the looser rule could have caused, measured rather than argued. Of the 18,644
  // mappings in the file on this machine, 7,534 are tiles and every one of them is two digits on
  // both halves, so the looser pattern has to find exactly the same set — and it must not start
  // reading the 11,110 baked WMO and doodad entries as tiles either.
  //
  // An equality and not a floor, because the danger of this change is in the widening direction and
  // a floor cannot see it: every one of those 11,110 bakes ends in `_<dd>_<dd>.blp` (they are named
  // `<thing>_<ddd>_<gridY>_<gridX>`), so a rule that lost its `^map` anchor while gaining the
  // one-digit form counts 9,673 tiles here — measured — and sails past a `>= 7,534` check. The
  // number moves for one honest reason, a custom map built into the dataset whose tiles tswow
  // appends to this same file, and that is the day to re-measure it here and in
  // `tools/minimap-index.mjs`, not the day to loosen it.
  const archives = await openClientArchives(clientDirectory);
  try {
    const index = await loadMinimapIndex(archives);
    assert.ok(index.size > 18_000, `expected the real index, got ${index.size} mappings`);
    const directories = new Set([...index.keys()].map((key) => key.slice(0, key.lastIndexOf("\\"))));
    let tiles = 0;
    for (const directory of directories) tiles += Object.keys(tilesOfMap(index, directory)).length;
    assert.equal(tiles, 7_534, `the index yielded 7,534 tiles when this was written and now yields ${tiles}`);

    // The four continents, as golden numbers: a rule that started matching something that is not a
    // tile would show up here first, because these are the directories with the most neighbours.
    assert.equal(Object.keys(tilesOfMap(index, "Azeroth")).length, 687);
    assert.equal(Object.keys(tilesOfMap(index, "Kalimdor")).length, 1_018);
    assert.equal(Object.keys(tilesOfMap(index, "Northrend")).length, 1_131);
    assert.equal(Object.keys(tilesOfMap(index, "Expansion01")).length, 800);
  } finally {
    archives.close();
  }
});
