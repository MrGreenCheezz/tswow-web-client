// 12.10 (7.27): the building minimap as Wow.exe 3.3.5a draws it — the choice of 0x007F5BA0 (WmoMinimapGate.ts),
// the tiles of 0x007A17E0 → 0x007B00A0 → 0x007AFC70/0x007AFE70/0x007AF8D0 and their order (WmoMinimapSelect.ts),
// the collision/file group line-up (WmoMinimapAlign.ts) and the lay of 0x0057E7F0 (WmoMinimapDraw.ts).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const { wmoMinimapMode, wmoMinimapKindMask, wmoMinimapKindValue } = await import("../dist/code/browser/WmoMinimapGate.js");
const {
  WMO_MINIMAP_TILE_LIMIT, WmoMinimapTileList, collectWmoMinimapTiles, orderWmoMinimapTiles, selectWmoMinimapTiles,
  wmoMinimapPictureCorners, wmoMinimapQueryBox, wmoMinimapTileCount, wmoMinimapTilePixels,
} = await import("../dist/code/browser/WmoMinimapSelect.js");
const { alignWmoMinimapGroups } = await import("../dist/code/browser/WmoMinimapAlign.js");
const { drawWmoMinimap, wmoMinimapTileAffine } = await import("../dist/code/browser/WmoMinimapDraw.js");

// Stormwind's rows (dataset WMOAreaTable.dbc): root 61|0|-1 Flags 0x10; Valley of Heroes 2539 and the exterior
// group 24611 Flags 0x20; Trade District groups 4 or 0. Dalaran 5164|0|-1 Flags 0x9; Trial of the Crusader 0x1.
test("0x007F5BA0: Stormwind's root 0x10 puts its streets on the building minimap; 0x20 vetoes; plain buildings", () => {
  // A street group lit as exterior (MOGP 0x2A41, e.g. group 257) and an open one (0x9, group 280): the whole city.
  assert.equal(wmoMinimapMode(0x2a41, 4, 0x10), "whole");
  assert.equal(wmoMinimapMode(0x2a41, undefined, 0x10), "whole");
  assert.equal(wmoMinimapMode(0x9, undefined, 0x10), "whole");
  // A shop (pure interior 0x2A05): its rooms, whatever the root says.
  assert.equal(wmoMinimapMode(0x2a05, 0, 0x10), "rooms");
  // The Valley of Heroes (0x809, row 0x20) and group 285 (0x8020080D, row 0x20): the terrain.
  assert.equal(wmoMinimapMode(0x809, 0x20, 0x10), "terrain");
  assert.equal(wmoMinimapMode(0x8020080d, 0x20, 0x10), "terrain");
  // 0x20 vetoes an interior too.
  assert.equal(wmoMinimapMode(0x2005, 0x20, undefined), "terrain");
  // An ordinary building: outdoors (0x8) the terrain, indoors its rooms; no rows at all.
  assert.equal(wmoMinimapMode(0x8, undefined, undefined), "terrain");
  assert.equal(wmoMinimapMode(0x809, 4, 0), "terrain");
  assert.equal(wmoMinimapMode(0x2005, undefined, undefined), "rooms");
  assert.equal(wmoMinimapMode(0x2041, undefined, undefined), "rooms");
  // Trial of the Crusader (root 0x1): the building minimap even on an open group, as a room walk.
  assert.equal(wmoMinimapMode(0x9, undefined, 0x1), "rooms");
  // Dalaran (root 0x9): the whole set on lit or open groups, rooms inside.
  assert.equal(wmoMinimapMode(0x2041, undefined, 0x9), "whole");
  assert.equal(wmoMinimapMode(0x2001, undefined, 0x9), "rooms");
});

test("0x007B00A0: the room walk keeps the start group's kind", () => {
  assert.deepEqual([wmoMinimapKindMask(0x2a05), wmoMinimapKindValue(0x2a05)], [0x48, 0], "pure interior with pure interior");
  assert.deepEqual([wmoMinimapKindMask(0x2a41), wmoMinimapKindValue(0x2a41)], [0x48, 0x40], "lit as exterior with its kind");
  assert.deepEqual([wmoMinimapKindMask(0x809), wmoMinimapKindValue(0x809)], [0x8, 0x8], "open with open");
});

const EVERYWHERE = { minX: -1e9, minY: -1e9, minZ: -1e9, maxX: 1e9, maxY: 1e9, maxZ: 1e9 };
const box = (minX, minY, maxX, maxY, minZ = 0, maxZ = 10) => ({ minX, minY, minZ, maxX, maxY, maxZ });
const rects = (list) => Array.from({ length: list.count }, (_, at) => [...list.rect.subarray(at * 4, at * 4 + 4)]);

test("0x007AF8D0: tile size and count from the box, the grid's outer margin, X/Y only, at most 256", () => {
  // pixels = clamp(2^ceil(log2(extent / 128 * 256)), 32, 256): the corpus's 10,984 of 10,992 bakes.
  assert.deepEqual([0, 8, 16, 16.01, 40, 64, 64.5, 300, Number.NaN].map(wmoMinimapTilePixels),
    [32, 32, 32, 64, 128, 128, 256, 256, 32]);
  // Stormwind's root box 1058.35 × 1059.93 yards: 9 × 9 = the 81 tiles of `stormwind_286_*`; Dalaran's
  // 613.69 × 702.30: 5 × 6 = the 30 of `nd_dalaran_091_*`.
  assert.equal(wmoMinimapTileCount(1058.35) * wmoMinimapTileCount(1059.93), 81);
  assert.equal(wmoMinimapTileCount(613.69) * wmoMinimapTileCount(702.3), 30);
  const list = new WmoMinimapTileList();
  // 20 × 40 yards: one tile, 64 × 128 pixels = 32 × 64 yards, pushed out 1 yard on every outer edge.
  collectWmoMinimapTiles(list, EVERYWHERE, 7, box(10, 20, 30, 60));
  assert.equal(list.count, 1);
  assert.deepEqual([list.group[0], list.x[0], list.y[0], list.z[0]], [7, 0, 0, 5]);
  assert.deepEqual(rects(list), [[9, 19, 43, 85]]);
  // 300 × 100 yards: 3 columns of 128, one row; only the outer edges move.
  list.count = 0;
  collectWmoMinimapTiles(list, EVERYWHERE, 2, box(0, 0, 300, 100));
  assert.deepEqual(rects(list), [[-1, -1, 128, 129], [128, -1, 256, 129], [256, -1, 385, 129]]);
  // The query meets tiles in X and Y only; its Z does not matter here.
  list.count = 0;
  collectWmoMinimapTiles(list, box(200, 50, 210, 60, 500, 600), 2, box(0, 0, 300, 100));
  assert.deepEqual([...list.x.subarray(0, list.count)], [1]);
  // A box edge on a tile edge: min ≤ max but min < max strictly (0x007AF8D0's comparisons).
  list.count = 0;
  collectWmoMinimapTiles(list, box(256, 0, 300, 10), 2, box(0, 0, 300, 100));
  assert.deepEqual([...list.x.subarray(0, list.count)], [1, 2]);
  list.count = 0;
  collectWmoMinimapTiles(list, box(0, 0, 3000, 3000), 2, box(0, 0, 128 * 20, 128 * 20));
  assert.equal(list.count, WMO_MINIMAP_TILE_LIMIT);
});

/** Groups 0…7 and their portals for the walk (portal polygons as squares at x = given, spanning y/z). */
function walkModel() {
  const vertices = [];
  const definitions = [];
  const square = (x, y0, y1, z0, z1) => {
    definitions.push({ startVertex: vertices.length / 3, vertexCount: 4 });
    vertices.push(x, y0, z0, x, y1, z0, x, y1, z1, x, y0, z1);
    return definitions.length - 1;
  };
  const near = square(5, 0, 5, 0, 5);
  const far = square(5, 0, 5, 500, 505); // above the query box: not walked through
  const references = [];
  const groups = [];
  const group = (flags, bounds, links) => {
    groups.push({ flags, bounds, portalStart: references.length, portalCount: links.length });
    for (const [portal, other] of links) references.push({ portal, group: other, side: 1 });
  };
  group(0x2005, box(0, 0, 10, 10), [[near, 1], [near, 2], [near, 3], [far, 4], [near, 6]]); // 0: the start
  group(0x2205, box(10, 0, 20, 10), [[near, 0], [near, 7]]); //                1: same kind (a stop in one run)
  group(0x2041, box(0, 10, 10, 20), [[near, 5]]); //                            2: lit as exterior — another kind
  group(0x2085, box(-10, 0, 0, 10), []); //                                      3: MOGP 0x80
  group(0x2005, box(0, -10, 10, 0), []); //                                      4: behind a portal outside the box
  group(0x2005, box(0, 20, 10, 30), []); //                                      5: only through group 2
  group(0x2005, box(20, 0, 30, 10), [[near, 0], [near, 1]]); //                  6: back to 0 and on to 1 (seen)
  group(0x2005, box(30, 0, 40, 10), []); //                                      7: only through stop 1
  return { groups, portals: { vertices: Float32Array.from(vertices), definitions, references } };
}

test("0x007AFC70: the portal walk — same kind, not back, not 0x80, portals inside the box, once each, stops", () => {
  const model = walkModel();
  const list = new WmoMinimapTileList();
  const query = box(-100, -100, 100, 100, -10, 10);
  // 2 is another kind, 3 is MOGP 0x80, 4's portal is above the box, 6 does not go back to 0 nor again into 1.
  selectWmoMinimapTiles(list, model, "rooms", 0, query);
  assert.deepEqual([...list.group.subarray(0, list.count)], [0, 1, 7, 6]);
  // A stop id (0x59E7/0x59E8) is never walked into — nor what lies behind it…
  const stops = new Uint8Array(model.groups.length);
  stops[1] = 1;
  selectWmoMinimapTiles(list, model, "rooms", 0, query, stops);
  assert.deepEqual([...list.group.subarray(0, list.count)], [0, 6]);
  // …and started in, it gives its own tiles and follows no portal.
  selectWmoMinimapTiles(list, model, "rooms", 1, query, stops);
  assert.deepEqual([...list.group.subarray(0, list.count)], [1]);
  // A group outside the query in X/Y adds nothing and is not walked through.
  selectWmoMinimapTiles(list, model, "rooms", 0, box(-100, -100, 15, 100, -10, 10));
  assert.deepEqual([...list.group.subarray(0, list.count)], [0, 1]);
  // From the lit group the kind is 0x40: its pure-interior neighbours are not its kind.
  selectWmoMinimapTiles(list, model, "rooms", 2, query);
  assert.deepEqual([...list.group.subarray(0, list.count)], [2]);
  // Without portals (a legacy artifact) the walk is the group alone.
  selectWmoMinimapTiles(list, { groups: model.groups }, "rooms", 0, query);
  assert.deepEqual([...list.group.subarray(0, list.count)], [0]);
});

test("0x007AFE70: the whole-building set is named nGroups and cut over the root box", () => {
  const model = walkModel();
  const list = new WmoMinimapTileList();
  selectWmoMinimapTiles(list, model, "whole", 0, EVERYWHERE);
  // The root box is the groups' union, −10…40 × −10…30: 50 × 40 yards → 128 × 128 pixels, one 64-yard tile.
  assert.equal(list.count, 1);
  assert.equal(list.group[0], model.groups.length);
  assert.deepEqual(rects(list), [[-11, -11, 55, 55]]);
});

test("0x007F5070/0x0057BD10: ascending by height above the character, the character's group on top", () => {
  const list = new WmoMinimapTileList();
  collectWmoMinimapTiles(list, EVERYWHERE, 3, box(0, 0, 10, 10, 0, 10)); //    z 5
  collectWmoMinimapTiles(list, EVERYWHERE, 1, box(0, 0, 10, 10, -40, -20)); // z −30
  collectWmoMinimapTiles(list, EVERYWHERE, 2, box(0, 0, 10, 10, 20, 40)); //   z 30
  collectWmoMinimapTiles(list, EVERYWHERE, 4, box(0, 0, 10, 10, -10, 0)); //   z −5
  orderWmoMinimapTiles(list, 3, 2);
  assert.deepEqual([...list.order.subarray(0, list.count)].map((at) => list.group[at]), [1, 4, 2, 3]);
});

test("0x007F5BA0: the query box — the radius cell, grown by a radius, in model space, topped by the group", () => {
  const placement = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const out = {};
  // x 100, y 50, radius 60: cell (60, 0) → world X 0…180, Y −60…120, Z 10 − 90 … 10 + 60; vmap's frame negates X/Y.
  wmoMinimapQueryBox(placement, 100, 50, 10, 60, 33, out);
  assert.deepEqual(out, { minX: -180, minY: -120, minZ: -80, maxX: 0, maxY: 60, maxZ: 33 });
  // A negative coordinate floors down: x −1 is cell −60.
  wmoMinimapQueryBox(placement, -1, 0, 0, 60, 0, out);
  assert.deepEqual([out.minX, out.maxX], [-60, 120]);
});

test("WmoMinimapAlign: the .vmo drops groups, the file keeps them; ids of 0x59E7/0x59E8 stop the walk", () => {
  const g = (flags, minX, groupId = 0) => ({ flags, bounds: box(minX, 0, minX + 1, 1), groupId });
  const visual = [g(0x2005, 0), g(0x22c1, 1), g(0x2005, 2), g(0x28c1, 3), g(0x2005, 4)];
  // Stormwind's case: file groups 1 and 3 (MOGP 0x80) are not in the collision model.
  const collision = [g(0x2005, 0, 100), g(0x2005, 2, 0x59e7), g(0x2005, 4, 101)];
  const alignment = alignWmoMinimapGroups(visual, collision);
  assert.deepEqual([...alignment.visualOfCollision], [0, 2, 4]);
  assert.deepEqual([...alignment.stops], [0, 0, 1, 0, 0]);
  // A collision group with no partner is no answer.
  assert.equal(alignWmoMinimapGroups(visual, [g(0x2005, 9, 1)]), undefined);
  assert.equal(alignWmoMinimapGroups(visual, [g(0x2005, 2), g(0x2005, 0)]), undefined, "order is kept");
});

/** Where a model point (X, Y) falls in a tile's picture, (0…1, 0…1), through the drawn corners. */
function picturePoint(list, at, x, y) {
  const w = list.world;
  const [ox, oy, ux, uy, vx, vy] = [...w.subarray(at * 6, at * 6 + 6)];
  // An unturned placement at the origin: world = (−X, −Y). Solve world = O + u·U + v·V.
  const px = -x - ox, py = -y - oy;
  const det = ux * vy - uy * vx;
  return [(px * vy - py * vx) / det, (ux * py - uy * px) / det];
}

test("0x0057E7F0: the picture's top-left is (minX, maxY), right along +X, down along −Y; the canvas affine", () => {
  const placement = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const list = new WmoMinimapTileList();
  collectWmoMinimapTiles(list, EVERYWHERE, 0, box(0, 0, 30, 60));
  wmoMinimapPictureCorners(list, 0, placement, 0);
  const [minX, minY, maxX, maxY] = rects(list)[0];
  const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < 1e-9);
  assert.ok(near(picturePoint(list, 0, minX, maxY), [0, 0]), "top-left");
  assert.ok(near(picturePoint(list, 0, maxX, maxY), [1, 0]), "top-right");
  assert.ok(near(picturePoint(list, 0, minX, minY), [0, 1]), "bottom-left");
  // The affine draws the unit square there on the ADT sheet (column = −Δworld Y, row = −Δworld X).
  const k = 256 / (1600 / 3);
  const affine = [...wmoMinimapTileAffine(list, 0, { x: 0, y: 0 }, 1, new Float64Array(6))];
  // Origin: world (−minX, −maxY) → column maxY·k, row minX·k; right: +X → world −X → row grows.
  assert.ok(near(affine, [0, (maxX - minX) * k, -(maxY - minY) * k, 0, maxY * k, minX * k]));
});

test("drawWmoMinimap: the list's order, half a texel in, nothing for a missing bake or picture or beyond the circle", () => {
  const placement = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const list = new WmoMinimapTileList();
  collectWmoMinimapTiles(list, EVERYWHERE, 0, box(0, 0, 10, 10));
  collectWmoMinimapTiles(list, EVERYWHERE, 1, box(0, 0, 10, 10, 20, 30));
  collectWmoMinimapTiles(list, EVERYWHERE, 2, box(0, 0, 10, 10, -30, -20));
  for (let at = 0; at < list.count; at++) wmoMinimapPictureCorners(list, at, placement, 0);
  list.hashes[0] = "a"; list.hashes[1] = "b"; list.hashes[2] = undefined;
  orderWmoMinimapTiles(list, 0, 0);
  const calls = [];
  const context = {
    save: () => calls.push("save"), restore: () => calls.push("restore"), transform: () => calls.push("transform"),
    drawImage: (picture, ...rest) => calls.push(["draw", picture.name, ...rest]),
  };
  const pictures = { a: { name: "a", width: 64, height: 32 }, b: { name: "b", width: 32, height: 32 } };
  assert.equal(drawWmoMinimap(context, list, (hash) => pictures[hash], { x: 0, y: 0 }, 1, 50), 2);
  assert.deepEqual(calls.filter((call) => call[0] === "draw"), [
    ["draw", "b", 0.5, 0.5, 31, 31, -0.002, -0.002, 1.004, 1.004],
    ["draw", "a", 0.5, 0.5, 63, 31, -0.002, -0.002, 1.004, 1.004],
  ], "group 1 above, then the character's group 0 on top; group 2 has no bake");
  calls.length = 0;
  assert.equal(drawWmoMinimap(context, list, () => undefined, { x: 0, y: 0 }, 1, 50), 0, "pictures on their way");
  assert.equal(calls.length, 0);
  // Tiles wholly beyond the circle's square in X or Y (world −17…1 here, radius 50) are not drawn.
  assert.equal(drawWmoMinimap(context, list, (hash) => pictures[hash], { x: 100, y: 0 }, 1, 50), 0);
  assert.equal(drawWmoMinimap(context, list, (hash) => pictures[hash], { x: 0, y: -80 }, 1, 50), 0);
  assert.equal(drawWmoMinimap(context, list, (hash) => pictures[hash], { x: 40, y: 40 }, 1, 50), 2, "the square, not the circle, decides");
});

// The lay against the bakes themselves: the opaque part of a group's picture is its box seen from above.
const CLEAN = "F:/CircleClean";
test("MPQ vertical: bakes put the group's box where 0x0057E7F0's lay and 0x007AF8D0's size say", { skip: !existsSync(`${CLEAN}/Data`) }, async () => {
  const [{ openClientArchives }, { loadMinimapIndex, wmoTilesOf }, { decodeBlp }] = await Promise.all([
    import("../tools/mpq.mjs"), import("../tools/minimap-index.mjs"), import("../tools/blp.mjs")]);
  const archives = await openClientArchives(CLEAN);
  try {
    const index = await loadMinimapIndex(archives);
    const placement = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
    const cases = [
      // [root, group]: 20 × 16 yards in a 64 × 32 bake; 6 × 5 in 32 × 32; Stormwind 36 × 54 in 128², 68 × 68 in 256².
      ["World\\wmo\\Azeroth\\Buildings\\DuskwoodAbandoned_Blacksmith\\DuskwoodAbandoned_Blacksmith.wmo", 0],
      ["World\\wmo\\Azeroth\\Buildings\\DuskwoodAbandoned_Inn\\AndorhalAbandoned_Inn.wmo", 1],
      ["World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo", 250],
      ["World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo", 189],
    ];
    for (const [root, group] of cases) {
      const file = await archives.read(root.replace(/\.wmo$/i, `_${String(group).padStart(3, "0")}.wmo`));
      const at = file.indexOf(Buffer.from("PGOM")) + 8;
      const [minX, minY, minZ, maxX, maxY, maxZ] = [0, 1, 2, 3, 4, 5].map((i) => file.readFloatLE(at + 0x0c + i * 4));
      const hash = wmoTilesOf(index, root)[group]["0-0"];
      const picture = decodeBlp(await archives.read(`textures\\Minimap\\${hash}.blp`));
      assert.deepEqual([picture.width, picture.height], [wmoMinimapTilePixels(maxX - minX), wmoMinimapTilePixels(maxY - minY)],
        `${root} ${group}: the bake's size is the rule's`);
      let s0 = picture.width, s1 = -1, t0 = picture.height, t1 = -1;
      for (let y = 0; y < picture.height; y++) for (let x = 0; x < picture.width; x++) {
        if (picture.data[(y * picture.width + x) * 4 + 3] === 0) continue;
        s0 = Math.min(s0, x); s1 = Math.max(s1, x + 1); t0 = Math.min(t0, y); t1 = Math.max(t1, y + 1);
      }
      const list = new WmoMinimapTileList();
      collectWmoMinimapTiles(list, EVERYWHERE, group, { minX, minY, minZ, maxX, maxY, maxZ });
      wmoMinimapPictureCorners(list, 0, placement, 0);
      const [u0, v0] = picturePoint(list, 0, minX, maxY);
      const [u1, v1] = picturePoint(list, 0, maxX, minY);
      const predicted = [u0 * picture.width, u1 * picture.width, v0 * picture.height, v1 * picture.height];
      const drawn = [s0, s1, t0, t1];
      assert.ok(predicted.every((value, index) => Math.abs(value - drawn[index]) <= 3),
        `${root} ${group}: opaque ${drawn} where the lay puts the box at ${predicted.map((value) => value.toFixed(1))}`);
    }
  } finally {
    archives.close();
  }
});

// The live wiring (AreaLocatorLive.ts) over a fake game: a building whose file group 1 (MOGP 0x80) is not in
// the collision model, so collision index 1 is file group 2 — the 05.10 slice drew file group 1's bake there.
test("live: a lit street draws the whole-building set, a shop its rooms by file index, never the collision index's", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const live = await import("../dist/code/browser/AreaLocatorLive.js");
  const { canonicalCollisionModelName } = await import("../dist/code/browser/CollisionClient.js");
  const name = "World\\wmo\\Test\\Test.wmo";
  const street = { flags: 0x2a41, bounds: box(-100, -100, 100, 100, -10, 30), portalStart: 0, portalCount: 0 };
  const hidden = { flags: 0x22c1, bounds: box(200, 200, 210, 210), portalStart: 0, portalCount: 0 };
  const shop = { flags: 0x2a05, bounds: box(0, 0, 20, 20), portalStart: 0, portalCount: 1 };
  const back = { flags: 0x2a05, bounds: box(20, 0, 40, 20), portalStart: 1, portalCount: 1 };
  const wmo = {
    groups: [street, hidden, shop, back],
    portals: {
      vertices: Float32Array.of(20, 0, 0, 20, 20, 0, 20, 20, 10, 20, 0, 10),
      definitions: [{ startVertex: 0, vertexCount: 4 }],
      references: [{ portal: 0, group: 3, side: 1 }, { portal: 0, group: 2, side: -1 }],
    },
  };
  const collisionGroups = [
    { ...street, groupId: 2623, vertexCount: 0, triangleCount: 0 },
    { ...shop, groupId: 2753, vertexCount: 0, triangleCount: 0 },
    { ...back, groupId: 2754, vertexCount: 0, triangleCount: 0 },
  ];
  const tiles = { 1: { "0-0": "1".repeat(32) }, 2: { "0-0": "2".repeat(32) }, 3: { "0-0": "3".repeat(32) }, 4: { "0-0": "4".repeat(32) } };
  const placement = {
    map: 0, key: "test", modelName: "Test.wmo", canonicalModelName: canonicalCollisionModelName(name),
    x: 1000, y: 1000, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  };
  const objects = [{ kind: "wmo", name, x: 1000, y: 1000, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, wmoId: 61, nameSet: 0 }];
  let floor = { placement, floorZ: 5, groupIndex: 0, groupId: 2623, groupFlags: 0x2a41 };
  let holdRows = false;
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const saved = { fetch: globalThis.fetch, ...Object.fromEntries(["areas", "gatewayOrigin", "collision", "environment", "terrain", "minimapTiles"].map((key) => [key, game[key]])) };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/dbc/wmo-areas") {
      if (holdRows) return new Promise(() => {});
      return json({ version: 1, rows: [[61, 0, -1, 1519, 0x10, "Штормград"]] });
    }
    if (url.pathname === "/minimap/wmo") return json({ version: 1, groups: tiles });
    return new Response("", { status: 404 });
  };
  const ticks = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const drawn = [];
  const context = { save() {}, restore() {}, transform() {}, drawImage: (picture) => drawn.push(picture.hash[0]) };
  try {
    game.areas = { map: () => undefined, area: () => undefined };
    game.gatewayOrigin = "http://127.0.0.1:8090";
    game.collision = { staticWmoFloorState: () => floor, models: { model: () => ({ groups: collisionGroups }) } };
    game.environment = { model: () => ({ wmo }) };
    game.terrain = { areaAt: () => 1519, heightAt: () => -1000 };
    game.minimapTiles = { picture: (hash) => ({ hash, width: 256, height: 256 }) };
    let now = 0;
    // World = placement − model in X/Y: model (−50, −50, 5) on the street, (10, 10, 5) in the shop.
    const at = (x, y) => ({ x: 1000 - x, y: 1000 - y, z: 5 });
    const step = async (position) => {
      live.updateLiveAreaLocator(now += 1000, 0, position, objects);
      await ticks();
      live.updateLiveAreaLocator(now += 1000, 0, position, objects);
      live.drawLiveWmoMinimap(context, 0, position, 1, 30);
      await ticks();
      drawn.length = 0;
      return live.drawLiveWmoMinimap(context, 0, position, 1, 30);
    };
    // Stormwind's root row 0x10 and a lit street group: the whole-building set, file group 4 = nGroups.
    assert.equal(await step(at(-50, -50)), true);
    assert.deepEqual(drawn, ["4"]);
    // The shop: collision index 1 is file group 2; its room walk reaches 3 through the portal.
    floor = { placement, floorZ: 5, groupIndex: 1, groupId: 2753, groupFlags: 0x2a05 };
    assert.equal(await step(at(10, 10)), true);
    assert.deepEqual(drawn.sort(), ["2", "3"], "file groups 2 and 3, never file group 1 (the collision index)");
    // A new realm session whose WMOAreaTable has not answered: without the root row the lit street is an
    // interior of its own kind with no bake near — the terrain minimap, not a dark circle.
    holdRows = true;
    game.gatewayOrigin = "http://127.0.0.1:8091";
    floor = { placement, floorZ: 5, groupIndex: 0, groupId: 2623, groupFlags: 0x2a41 };
    assert.equal(await step(at(-50, -50)), false);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const key of ["areas", "gatewayOrigin", "collision", "environment", "terrain", "minimapTiles"]) game[key] = saved[key];
    live.liveAreaLocator(); // drops the session with the gateway origin gone
  }
});
