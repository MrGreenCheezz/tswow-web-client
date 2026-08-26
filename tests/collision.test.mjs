import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COLLISION_TRIANGLE_BUDGET, collisionTriangleCount, decodeCollisionModel, encodeCollisionModel,
} from "../dist/code/world/CollisionFormat.js";
import {
  CollisionMesh, CollisionWorld, closestPointOnTriangle, inverseTransformCollisionPoint,
  isFloorTriangle, transformCollisionBounds, transformCollisionMesh, uprightness, verticalHit,
} from "../dist/code/browser/game/Collision.js";
import { CollisionSource } from "../dist/code/browser/game/CollisionSource.js";
import {
  VMAP_LIQUID_CELL_YARDS, collisionModelLiquidAtEye, sampleCollisionLiquid,
} from "../dist/code/browser/game/CollisionLiquid.js";
import { parseVMapModelGroups } from "../dist/code/gateway/VMapModel.js";
import { parseVMapTile } from "../dist/code/gateway/VMapProtocol.js";

let vmapsDirectory;
try {
  vmapsDirectory = (await import("../tools/paths.mjs")).vmapsDirectory();
} catch {
  vmapsDirectory = undefined;
}
const withDataset = { skip: vmapsDirectory ? false : "no tswow dataset on this machine" };

const at = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };

test("collision readiness waits for the destination tiles, including empty VMAP tiles", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    source.refresh(1, 0, 0);
    assert.equal(source.isReady(1, 0, 0), false, "the barrier must not release while tile requests are pending");
    await new Promise((resolve) => setImmediate(resolve));
    source.refresh(1, 0, 0);
    assert.equal(source.isReady(1, 0, 0), true, "a completed 204 means there is no collision to wait for");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collision readiness starts every bounded pending model in one pass", async () => {
  const originalFetch = globalThis.fetch;
  const placements = ["Inn.wmo", "Lamp.m2"].map((name, index) => ({
    id: index + 1, kind: name.endsWith(".wmo") ? "wmo" : "m2", name,
    x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  }));
  globalThis.fetch = async (input) => {
    if (String(input).includes("/environment/")) {
      return new Response(JSON.stringify(placements), { status: 200 });
    }
    throw new Error("model fetch should be stubbed by the test");
  };
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    const pending = new Set();
    source.models.model = (name) => { pending.add(name); return undefined; };
    source.models.isResolved = () => false;
    source.refresh(1, 0, 0);
    await new Promise((resolve) => setImmediate(resolve));
    source.refresh(1, 0, 0);
    assert.equal(source.isReady(1, 0, 0), false);
    assert.deepEqual([...pending].sort(), ["Inn.wmo", "Lamp.m2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collision readiness requests all missing groups for loaded models", async () => {
  const originalFetch = globalThis.fetch;
  const placements = ["Inn.wmo", "Lamp.m2"].map((name, index) => ({
    id: index + 1, kind: name.endsWith(".wmo") ? "wmo" : "m2", name,
    x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  }));
  globalThis.fetch = async () => new Response(JSON.stringify(placements), { status: 200 });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    const requested = [];
    source.models.model = () => ({
      groups: [{
        triangleCount: 2,
        bounds: { minX: -2, minY: -2, minZ: -1, maxX: 2, maxY: 2, maxZ: 3 },
      }],
    });
    source.models.isResolved = () => true;
    source.models.requestGroups = (name, groups) => requested.push([name, ...groups]);
    source.refresh(1, 0, 0);
    await new Promise((resolve) => setImmediate(resolve));
    source.refresh(1, 0, 0);
    assert.equal(source.isReady(1, 0, 0), false);
    assert.deepEqual(new Set(requested.map(([name]) => name)), new Set(["Inn.wmo", "Lamp.m2"]));
    assert.ok(requested.every(([, group]) => group === 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the static WMO locator returns stable placement and authored floor-group identity", async () => {
  const originalFetch = globalThis.fetch;
  const placement = {
    id: 77, kind: "wmo", name: "GoldshireInn.wmo",
    x: 12, y: 34, z: 5, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  };
  globalThis.fetch = async () => new Response(JSON.stringify([placement]), { status: 200 });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    const vertices = floor(0, 4);
    source.models.model = () => ({
      groups: [{
        bounds: { minX: -4, minY: -4, minZ: 0, maxX: 4, maxY: 4, maxZ: 0 },
        vertexCount: 6,
        triangleCount: 2,
        flags: 0x2000,
        groupId: 904,
        vertices,
        indices: Uint32Array.from({ length: 6 }, (_unused, index) => index),
      }],
    });
    source.models.isResolved = () => true;
    source.refresh(1, placement.x, placement.y);
    await new Promise((resolve) => setImmediate(resolve));
    source.refresh(1, placement.x, placement.y);

    const located = source.staticWmoFloorUnder(1, placement.x, placement.y, 10, -10);
    assert.ok(located);
    assert.deepEqual(located.placement, {
      map: 1,
      spawnId: 77,
      key: "1:77",
      modelName: "GoldshireInn.wmo",
      canonicalModelName: "goldshireinn.wmo",
      x: 12,
      y: 34,
      z: 5,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      scale: 1,
    });
    assert.equal(located.floorZ, 5);
    assert.equal(located.groupIndex, 0);
    assert.equal(located.groupId, 904);
    assert.equal(located.groupFlags, 0x2000);
    assert.equal(located.revision, source.revision);
    assert.equal(source.staticWmoFloorUnder(2, placement.x, placement.y, 10, -10), undefined,
      "a locator must never leak the last map's WMO");

    const revision = source.revision;
    source.reset();
    assert.ok(source.revision > revision);
    assert.equal(source.staticWmoFloorUnder(1, placement.x, placement.y, 10, -10), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** One axis-aligned quad, as two triangles, from four corners. */
function quad(a, b, c, d) {
  return Float32Array.of(...a, ...b, ...c, ...a, ...c, ...d);
}

/** A flat floor of one square, at height z, spanning [-size, size] in x and y. */
function floor(z, size = 5) {
  return quad([-size, -size, z], [size, -size, z], [size, size, z], [-size, size, z]);
}

/** A wall standing in the plane x = at, spanning y and rising from z. */
function wall(at, z = 0, height = 4, size = 5) {
  return quad([at, -size, z], [at, size, z], [at, size, z + height], [at, -size, z + height]);
}

test("a model placed with no rotation lands where the tile says, mirrored in x and y", () => {
  // The transform is `ModelInstance`'s, unwound out of vmap's internal frame: rotate, scale,
  // negate x and y, offset. The negation is the part that is easy to get wrong and impossible to
  // miss when it is wrong — every building's collision ends up mirrored through itself.
  const vertices = Float32Array.of(1, 2, 3);
  const world = transformCollisionMesh(vertices, Uint32Array.of(0), { ...at, x: 100, y: 200, z: 300 });
  assert.deepEqual([...world], [99, 198, 303]);
});

test("a quarter turn about the vertical goes the way the server turns it", () => {
  const vertices = Float32Array.of(1, 0, 0);
  const turned = transformCollisionMesh(vertices, Uint32Array.of(0), { ...at, rotationY: 90 });
  // Rz(90) takes (1,0,0) to (0,1,0) in the internal frame, and both of those are then negated.
  assert.ok(Math.abs(turned[0] - 0) < 1e-6, `x ${turned[0]}`);
  assert.ok(Math.abs(turned[1] + 1) < 1e-6, `y ${turned[1]}`);
  assert.ok(Math.abs(turned[2] - 0) < 1e-6, `z ${turned[2]}`);
});

test("scale multiplies the model and not the placement", () => {
  const world = transformCollisionMesh(Float32Array.of(2, 0, 1), Uint32Array.of(0), { ...at, x: 10, y: 0, z: 0, scale: 3 });
  assert.deepEqual([...world], [4, 0, 3]);
});

test("a box in model space becomes a box around the same geometry", () => {
  const bounds = { minX: -1, minY: -2, minZ: 0, maxX: 1, maxY: 2, maxZ: 3 };
  const box = transformCollisionBounds(bounds, { ...at, x: 50, y: 60, z: 70, rotationY: 90 });
  // Turned a quarter, the extents swap; the box still has to contain every corner.
  const corners = transformCollisionMesh(
    Float32Array.of(-1, -2, 0, 1, 2, 3),
    Uint32Array.of(0, 1),
    { ...at, x: 50, y: 60, z: 70, rotationY: 90 },
  );
  for (let index = 0; index < corners.length; index += 3) {
    assert.ok(corners[index] >= box.minX - 1e-4 && corners[index] <= box.maxX + 1e-4);
    assert.ok(corners[index + 1] >= box.minY - 1e-4 && corners[index + 1] <= box.maxY + 1e-4);
    assert.ok(corners[index + 2] >= box.minZ - 1e-4 && corners[index + 2] <= box.maxZ + 1e-4);
  }
});

test("a vertical line finds the triangle it passes through and misses the rest", () => {
  const triangles = floor(7);
  assert.equal(verticalHit(triangles, 0, 0, -1), 7);
  assert.equal(verticalHit(triangles, 0, 20, 0), undefined, "outside the square");
  // A wall is edge-on to the vertical and has no height at a point at all.
  assert.equal(verticalHit(wall(0), 0, 0, 0), undefined);
});

test("flat is a floor and vertical is not, whichever way round the triangle is wound", () => {
  assert.ok(Math.abs(uprightness(floor(0), 0) - 1) < 1e-6);
  assert.ok(uprightness(wall(0), 0) < 1e-6);
  assert.equal(isFloorTriangle(floor(0), 0), true);
  assert.equal(isFloorTriangle(wall(0), 0), false);
  // Wound the other way, a floor is still a floor: vmap triangles are not consistently wound and
  // treating a ceiling-facing normal as a wall would drop half of every building's floors.
  const flipped = Float32Array.of(-1, -1, 0, -1, 1, 0, 1, -1, 0);
  assert.equal(isFloorTriangle(flipped, 0), true);
});

test("the closest point on a triangle is on it", () => {
  const triangles = floor(0, 1);
  const inside = closestPointOnTriangle(triangles, 0, 0, -0.5, 5);
  assert.deepEqual([inside.x, inside.y, inside.z], [0, -0.5, 0]);
  const beyond = closestPointOnTriangle(triangles, 0, 10, -0.5, 0);
  assert.ok(Math.abs(beyond.x - 1) < 1e-6, `clamped to ${beyond.x}`);
});

test("the highest floor under the feet is the one that is stood on", () => {
  // A building: ground at zero, an upper storey at four.
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(floor(0)));
  world.set(2, new CollisionMesh(floor(4)));

  // Standing downstairs, the upper storey is over the character's head and is not the floor.
  assert.equal(world.floorUnder(0, 0, 0 + 1.6, -400), 0);
  // Standing upstairs it is.
  assert.equal(world.floorUnder(0, 0, 4 + 1.6, -400), 4);
  // And off the end of the building there is nothing at all, which is what lets the terrain win.
  assert.equal(world.floorUnder(50, 0, 10, -400), undefined);
});

test("a wall is not a floor, however the column passes through it", () => {
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(0, 0, 4)));
  assert.equal(world.floorUnder(0, 0, 10, -400), undefined);
});

test("walking into a wall stops at it rather than through it", () => {
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(2)));
  const radius = 0.4;
  // A fifth of a yard past the wall, which is inside the character's own radius and therefore
  // inside the wall. Standing further off than the radius is not a collision at all, and a test
  // that starts there passes without anything having happened.
  const out = world.pushOut(2.2, 0, 0, radius, 2, 1.6);
  assert.ok(out.x >= 2 + radius - 1e-3, `ended up at ${out.x}`);
  // Approached from the other side it comes out on that side.
  const behind = world.pushOut(1.8, 0, 0, radius, 2, 1.6);
  assert.ok(behind.x <= 2 - radius + 1e-3, `ended up at ${behind.x}`);
  // And a character standing clear of it is left exactly where it was.
  const clear = world.pushOut(2.5, 0, 0, radius, 2, 1.6);
  assert.deepEqual([clear.x, clear.y], [2.5, 0]);
});

test("a corner pushes out of both walls at once", () => {
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(2)));
  const acrossY = Float32Array.of(-5, 2, 0, 5, 2, 0, 5, 2, 4, -5, 2, 0, 5, 2, 4, -5, 2, 4);
  world.set(2, new CollisionMesh(acrossY));
  const out = world.pushOut(1.85, 1.85, 0, 0.4, 2, 1.6);
  assert.ok(out.x <= 2 - 0.4 + 1e-3 && out.y <= 2 - 0.4 + 1e-3, `${out.x}, ${out.y}`);
});

test("a floor never pushes sideways", () => {
  // A character standing on a roof is inside the roof's own triangles by every measure a sphere
  // takes; if floors pushed, it would be shoved off every one it stood on.
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(floor(0)));
  const out = world.pushOut(0, 0, 0, 0.4, 2, 1.6);
  assert.deepEqual([out.x, out.y], [0, 0]);
});

test("a kerb lower than a step does not block, because it is something to walk up", () => {
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(2, 0, 1)));
  const out = world.pushOut(2.2, 0, 0, 0.4, 2, 1.6);
  assert.deepEqual([out.x, out.y], [2.2, 0], "a one-yard lip is a step, not a wall");
});

test("the grid answers the same as walking every triangle", () => {
  // Built past the threshold where a grid appears, so the two paths are actually different.
  const triangles = [];
  for (let x = 0; x < 12; x++) {
    for (let y = 0; y < 12; y++) {
      triangles.push(...quad([x, y, x + y], [x + 1, y, x + y], [x + 1, y + 1, x + y], [x, y + 1, x + y]));
    }
  }
  const mesh = new CollisionMesh(Float32Array.from(triangles));
  assert.ok(mesh.triangleCount > 64, "not enough triangles to have a grid at all");
  const world = new CollisionWorld();
  world.set(1, mesh);
  for (const [x, y] of [[0.5, 0.5], [5.5, 6.5], [11.5, 11.5]]) {
    assert.equal(world.floorUnder(x, y, 100, -100), Math.floor(x) + Math.floor(y));
  }
});

test("the wire format survives a round trip, whole and in parts", () => {
  const groups = [
    { bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, flags: 0x2000, groupId: 893, vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2) },
    { bounds: { minX: 5, minY: 5, minZ: 5, maxX: 6, maxY: 6, maxZ: 6 }, flags: 0x1809, groupId: 904, vertices: Float32Array.of(5, 5, 5, 6, 5, 5, 5, 6, 5), indices: Uint32Array.of(0, 1, 2) },
  ];
  const whole = decodeCollisionModel(encodeCollisionModel(groups).buffer);
  assert.equal(whole.groups.length, 2);
  assert.deepEqual([...whole.groups[0].vertices], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...whole.groups[1].indices], [0, 1, 2]);
  assert.equal(collisionTriangleCount(whole), 2);
  // The flags travel whether or not the geometry does: they are the header's business, and the
  // browser reads them to tell a room from open air the way the server does.
  assert.deepEqual(whole.groups.map((group) => group.flags), [0x2000, 0x1809]);
  assert.deepEqual(whole.groups.map((group) => group.groupId), [893, 904]);

  // The point of the format: a header for every group, geometry for the ones asked for. Without
  // this a city is eighteen megabytes and a browser has to take all of it to stand in one room.
  const partial = decodeCollisionModel(encodeCollisionModel(groups, new Set([1])).buffer);
  assert.equal(partial.groups[0].vertices, undefined);
  assert.equal(partial.groups[0].triangleCount, 1, "and its size is still known");
  assert.equal(partial.groups[0].flags, 0x2000, "and so are its flags");
  assert.equal(partial.groups[0].groupId, 893, "and so is its authored group id");
  assert.deepEqual(partial.groups[0].bounds, groups[0].bounds);
  assert.deepEqual([...partial.groups[1].vertices], [5, 5, 5, 6, 5, 5, 5, 6, 5]);

  const none = decodeCollisionModel(encodeCollisionModel(groups, new Set()).buffer);
  assert.equal(none.groups.length, 2);
  assert.equal(none.groups[1].vertices, undefined);
});

test("a payload that is not a collision model is refused rather than misread", () => {
  assert.throws(() => decodeCollisionModel(new ArrayBuffer(4)), /truncated/);
  assert.throws(() => decodeCollisionModel(new Uint8Array(64).buffer), /Not a collision model/);
});

test("the real Goldshire inn has two floors, and they are where the tile puts them", withDataset, async () => {
  // The acceptance case from the plan, run against the server's own files rather than a fixture:
  // the inn is a WMO with an upper storey, and a client that cannot tell one floor from the other
  // leaves the player standing in the grass under the building.
  const tile = parseVMapTile(new Uint8Array(await readFile(join(vmapsDirectory, "000_31_49.vmtile"))));
  const inn = tile.find((object) => object.name === "Goldshireinn.wmo");
  assert.ok(inn, "the Goldshire tile no longer holds the inn");

  const groups = parseVMapModelGroups(await readFile(join(vmapsDirectory, "Goldshireinn.wmo.vmo")));
  const triangles = groups.reduce((sum, group) => sum + group.indices.length / 3, 0);
  assert.ok(triangles > 20_000, `only ${triangles} triangles`);
  assert.ok(triangles < COLLISION_TRIANGLE_BUDGET, "the inn is small enough to arrive whole");

  const world = new CollisionWorld();
  for (const [index, group] of groups.entries()) {
    if (group.indices.length === 0) continue;
    world.set(index, new CollisionMesh(transformCollisionMesh(group.vertices, group.indices, inn)));
  }

  // Sampled over the placement's own box rather than at its origin, which for this building sits
  // out on the porch. What is being asked is whether the inn has two storeys where it has a floor
  // at all — an inn with one is an inn this client cannot walk upstairs in.
  const bounds = inn.bounds;
  assert.ok(bounds);
  let columns = 0;
  let twoStoreys = 0;
  for (let stepX = 0; stepX <= 10; stepX++) {
    for (let stepY = 0; stepY <= 10; stepY++) {
      const x = bounds.minX + ((bounds.maxX - bounds.minX) * stepX) / 10;
      const y = bounds.minY + ((bounds.maxY - bounds.minY) * stepY) / 10;
      // The lowest floor first, from just above the bottom of the building.
      const ground = world.floorUnder(x, y, bounds.minZ + 6, bounds.minZ - 3);
      if (ground === undefined) continue;
      columns++;
      assert.ok(ground <= bounds.maxZ, `floor at ${ground} above the building's own box`);

      // Standing on it, the query from a step above the feet answers with that floor or with
      // something within a step of it — a stair tread, a low platform — and never with the ceiling.
      // That is the whole difference between walking about inside and standing on a roof.
      const downstairs = world.floorUnder(x, y, ground + 1.6, ground - 50);
      assert.ok(downstairs !== undefined, `nothing under the feet at ${x}, ${y}`);
      assert.ok(downstairs >= ground - 1e-3 && downstairs <= ground + 1.6 + 1e-3,
        `${downstairs} is not within a step of ${ground}`);

      const upstairs = world.floorUnder(x, y, ground + 14, ground + 2.5);
      if (upstairs !== undefined) twoStoreys++;
    }
  }
  assert.ok(columns >= 10, `only ${columns} of 121 sampled columns had any floor at all`);
  assert.ok(twoStoreys >= columns / 2, `only ${twoStoreys} of ${columns} columns had a storey above`);
});

test("the inn's walls stop a character, and its doorway does not", withDataset, async () => {
  const tile = parseVMapTile(new Uint8Array(await readFile(join(vmapsDirectory, "000_31_49.vmtile"))));
  const inn = tile.find((object) => object.name === "Goldshireinn.wmo");
  const groups = parseVMapModelGroups(await readFile(join(vmapsDirectory, "Goldshireinn.wmo.vmo")));
  const world = new CollisionWorld();
  for (const [index, group] of groups.entries()) {
    if (group.indices.length === 0) continue;
    world.set(index, new CollisionMesh(transformCollisionMesh(group.vertices, group.indices, inn)));
  }
  const ground = world.floorUnder(inn.x, inn.y, inn.bounds.maxZ, inn.bounds.minZ);

  // Walked in a straight line across the whole building at floor height, a character has to be
  // pushed somewhere by something: a building whose walls never push is a building you walk
  // through. This is the measure that the geometry landed in the right place at all — a mirrored
  // or unrotated inn would sit somewhere else entirely and never be touched.
  let pushes = 0;
  const span = inn.bounds.maxX - inn.bounds.minX;
  for (let step = 0; step <= 40; step++) {
    const x = inn.bounds.minX + (span * step) / 40;
    const out = world.pushOut(x, inn.y, ground + 0.1, 0.389, 2.03, 1.6);
    if (Math.hypot(out.x - x, out.y - inn.y) > 1e-3) pushes++;
  }
  assert.ok(pushes >= 2, `only ${pushes} of 41 points along the inn were inside anything`);
  assert.ok(pushes <= 30, `${pushes} of 41 points were solid, which is not a building but a block`);
});

test("indoors is the floor under the feet, not the box the district lives in", () => {
  // Two floors in the same column: a street slab at z = 0 belonging to an outdoor group, and a
  // room floor at z = 10 belonging to an indoor one. This is the shape a city has, and the shape
  // the box rule got wrong — an indoor group's box covers the street below it.
  const slab = (z) => Float32Array.of(
    0, 0, z, 20, 0, z, 0, 20, z,
    20, 0, z, 20, 20, z, 0, 20, z,
  );
  const triangles = new Float32Array(36);
  triangles.set(slab(0), 0);
  triangles.set(slab(10), 18);
  const mesh = new CollisionMesh(triangles, [
    { first: 0, flags: 0x1809 },
    { first: 2, flags: 0x2000 },
  ]);
  const world = new CollisionWorld();
  world.set(1, mesh);

  // Standing on the street, with the room's floor overhead and its box all around.
  assert.equal(world.indoorsAt(10, 10, 1, -100), false);
  assert.equal(world.floorUnder(10, 10, 1, -100), 0);
  // Standing on the room's floor.
  assert.equal(world.indoorsAt(10, 10, 11, -100), true);
  assert.equal(world.floorUnder(10, 10, 11, -100), 10);
  // The one walk answers both, and it answers about the triangle it chose.
  assert.deepEqual(world.floorInfoUnder(10, 10, 11, -100), { z: 10, flags: 0x2000 });

  // Off the mesh entirely there is no floor and no answer, which is open air.
  assert.equal(world.indoorsAt(100, 100, 11, -100), false);
});

test("a merged placement remembers which group each triangle came from", () => {
  const mesh = new CollisionMesh(new Float32Array(9 * 5), [
    { first: 0, flags: 0x8, groupIndex: 3, groupId: 893 },
    { first: 2, flags: 0x2000, groupIndex: 7, groupId: 904 },
  ]);
  assert.equal(mesh.flagsAt(0), 0x8);
  assert.equal(mesh.flagsAt(1), 0x8);
  assert.equal(mesh.flagsAt(2), 0x2000);
  assert.equal(mesh.flagsAt(4), 0x2000);
  assert.deepEqual(mesh.runAt(1), { first: 0, flags: 0x8, groupIndex: 3, groupId: 893 });
  assert.deepEqual(mesh.runAt(4), { first: 2, flags: 0x2000, groupIndex: 7, groupId: 904 });
  // A mesh built before flags travelled says so rather than guessing at zero, which would read as
  // "indoors" for everything.
  assert.equal(new CollisionMesh(new Float32Array(9)).flagsAt(0), undefined);
});

test("overlapping floors choose stable placement and group identity, not insertion order", () => {
  const mesh = (groupId) => new CollisionMesh(floor(5), [
    { first: 0, flags: 0x2000, groupIndex: groupId - 800, groupId },
  ]);
  const locate = (order) => {
    const world = new CollisionWorld();
    for (const id of order) world.set(id, mesh(id === 11 ? 904 : 893));
    return world.floorHitUnder(0, 0, 6, -10);
  };
  const forward = locate([11, 22]);
  const reverse = locate([22, 11]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.instanceId, 11, "the lower stable spawn id wins a co-planar overlap");
  assert.equal(forward.groupId, 904);

  // Pairwise epsilon equality is non-transitive: A≈B and B≈C while A is not ≈C. The locator's
  // quantised height key must therefore produce the same winner for the whole chain in any order.
  const chained = (order) => {
    const world = new CollisionWorld();
    const heights = new Map([[1, 5], [2, 5.00009], [3, 5.00018]]);
    for (const id of order) world.set(id, new CollisionMesh(floor(heights.get(id)), [
      { first: 0, flags: 0x2000, groupIndex: 0, groupId: 900 + id },
    ]));
    return world.floorHitUnder(0, 0, 6, -10);
  };
  assert.deepEqual(chained([1, 2, 3]), chained([3, 2, 1]));
  assert.equal(chained([2, 1, 3]).instanceId, 3);

  const triangles = new Float32Array(36);
  triangles.set(floor(5), 0);
  triangles.set(floor(5), 18);
  const withinPlacement = new CollisionWorld();
  withinPlacement.set(77, new CollisionMesh(triangles, [
    { first: 0, flags: 0x2000, groupIndex: 4, groupId: 904 },
    { first: 2, flags: 0x2000, groupIndex: 8, groupId: 893 },
  ]));
  const group = withinPlacement.floorHitUnder(0, 0, 6, -10);
  assert.equal(group.groupId, 893, "authored id breaks a same-placement group overlap");
  assert.equal(group.groupIndex, 8);
});

test("a model's own water crosses the wire even when its rooms do not", async () => {
  // Stormwind's canals are five grids inside the city model, and the map file has no liquid under
  // the city at all. A city is sent as a header with its rooms fetched one at a time, so water
  // that waited for a room request would leave the canals dry until the player walked into them.
  const liquid = {
    tilesX: 2,
    tilesY: 3,
    cornerX: -475,
    cornerY: -304.25,
    cornerZ: -6.5,
    type: 13,
    heights: Float32Array.from({ length: 3 * 4 }, (_, i) => -6.5 + i / 100),
    flags: Uint8Array.of(0x00, 0x0f, 0x01, 0x0f, 0x00, 0x0f),
  };
  const groups = [
    { bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, flags: 0x2000, groupId: 893, vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2) },
    { bounds: { minX: 5, minY: 5, minZ: 5, maxX: 6, maxY: 6, maxZ: 6 }, flags: 0x1809, groupId: 904, liquid, vertices: Float32Array.of(5, 5, 5, 6, 5, 5, 5, 6, 5), indices: Uint32Array.of(0, 1, 2) },
  ];

  const headerOnly = decodeCollisionModel(encodeCollisionModel(groups, new Set()).buffer);
  assert.equal(headerOnly.groups[1].vertices, undefined, "no geometry was asked for");
  const carried = headerOnly.groups[1].liquid;
  assert.ok(carried, "and the water came anyway");
  assert.equal(carried.tilesX, 2);
  assert.equal(carried.tilesY, 3);
  assert.equal(carried.type, 13);
  assert.deepEqual([...carried.flags], [0x00, 0x0f, 0x01, 0x0f, 0x00, 0x0f]);
  assert.equal(carried.heights.length, 12);
  assert.ok(Math.abs(carried.heights[11] - (-6.5 + 11 / 100)) < 1e-5);
  assert.equal(headerOnly.groups[0].liquid, undefined, "a dry group says so by absence");

  // And it survives the whole trip too, beside the geometry rather than instead of it.
  const whole = decodeCollisionModel(encodeCollisionModel(groups).buffer);
  assert.equal(whole.groups[1].liquid.tilesY, 3);
  assert.deepEqual([...whole.groups[1].vertices], [5, 5, 5, 6, 5, 5, 5, 6, 5]);
});

test("WMO liquid uses the rendered triangle diagonal and tests the transformed camera eye", () => {
  const liquid = {
    tilesX: 1,
    tilesY: 1,
    cornerX: 0,
    cornerY: 0,
    cornerZ: 0,
    type: 13,
    // 00, 10, 01, 11: deliberately non-planar so bilinear interpolation cannot pass this test.
    heights: Float32Array.of(0, 10, 20, 40),
    flags: Uint8Array.of(0),
  };
  const lower = sampleCollisionLiquid(liquid, 0.25 * VMAP_LIQUID_CELL_YARDS, 0.25 * VMAP_LIQUID_CELL_YARDS);
  assert.ok(Math.abs(lower.height - 7.5) < 1e-6);
  const upper = sampleCollisionLiquid(liquid, 0.75 * VMAP_LIQUID_CELL_YARDS, 0.75 * VMAP_LIQUID_CELL_YARDS);
  assert.ok(Math.abs(upper.height - 27.5) < 1e-6);
  assert.equal(sampleCollisionLiquid({ ...liquid, flags: Uint8Array.of(0x0f) }, 1, 1), undefined,
    "the low-nibble dry marker is not water");

  const placement = { x: 100, y: 200, z: 10, rotationX: 0, rotationY: 90, rotationZ: 0, scale: 2 };
  const localEye = {
    x: 0.75 * VMAP_LIQUID_CELL_YARDS,
    y: 0.75 * VMAP_LIQUID_CELL_YARDS,
    z: 27,
  };
  const placed = transformCollisionMesh(
    Float32Array.of(localEye.x, localEye.y, localEye.z),
    Uint32Array.of(0),
    placement,
  );
  const worldEye = { x: placed[0], y: placed[1], z: placed[2] };
  const roundTrip = inverseTransformCollisionPoint(worldEye, placement);
  assert.ok(Math.abs(roundTrip.x - localEye.x) < 1e-5);
  assert.ok(Math.abs(roundTrip.y - localEye.y) < 1e-5);
  assert.ok(Math.abs(roundTrip.z - localEye.z) < 1e-5);
  const liquidGroup = {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: VMAP_LIQUID_CELL_YARDS, maxY: VMAP_LIQUID_CELL_YARDS, maxZ: 50 },
    groupId: 904,
    liquid,
  };
  const submerged = collisionModelLiquidAtEye([liquidGroup], 0, placement, worldEye);
  assert.ok(submerged);
  assert.equal(submerged.groupIndex, 0);
  assert.equal(submerged.groupId, 904);
  assert.ok(Math.abs(submerged.height - 27.5) < 1e-5);

  const above = transformCollisionMesh(
    Float32Array.of(localEye.x, localEye.y, 28),
    Uint32Array.of(0),
    placement,
  );
  assert.equal(collisionModelLiquidAtEye(
    [liquidGroup], 0, placement, { x: above[0], y: above[1], z: above[2] },
  ), undefined);

  const dryLower = { ...liquidGroup, groupId: 893, liquid: undefined };
  const wetUpper = { ...liquidGroup, groupId: 904 };
  assert.equal(collisionModelLiquidAtEye([dryLower, wetUpper], 0, placement, worldEye), undefined,
    "a wet upper group must not make the authoritative dry lower group underwater");
});

test("the liquid of the real Stormwind reads as five grids and 2,702 wet cells", async (t) => {
  // The measurement that started the work, against the server's own file. Skipped where the
  // dataset is not installed, because this test names a path outside the repository.
  if (!vmapsDirectory) return t.skip("no tswow dataset on this machine");
  const path = join(vmapsDirectory, "Stormwind.wmo.vmo");
  let file;
  try {
    file = await readFile(path);
  } catch {
    t.skip("Stormwind.wmo.vmo is not on this machine");
    return;
  }
  const groups = parseVMapModelGroups(file);
  const withLiquid = groups.filter((group) => group.liquid);
  assert.equal(groups.length, 284);
  assert.equal(withLiquid.length, 5);
  let wet = 0;
  for (const group of withLiquid) {
    assert.equal(group.liquid.type, 13, "LiquidType 13 is WMO Water, whatever MOGP says");
    for (const flag of group.liquid.flags) if ((flag & 0x0f) !== 0x0f) wet++;
  }
  assert.equal(wet, 2702);
});
