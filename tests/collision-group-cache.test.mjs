import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  COLLISION_TRIANGLE_BUDGET, decodeCollisionModel, encodeCollisionModel,
} from "../dist/code/world/CollisionFormat.js";
import {
  CollisionMesh, CollisionWorld, transformCollisionBounds, transformCollisionMesh,
} from "../dist/code/browser/game/Collision.js";
import { CollisionSource } from "../dist/code/browser/game/CollisionSource.js";
import { CollisionClient } from "../dist/code/browser/CollisionClient.js";
import { parseVMapModelGroups } from "../dist/code/gateway/VMapModel.js";
import { parseVMapTile } from "../dist/code/gateway/VMapProtocol.js";

// Collision is held a placed group at a time: each (spawn, group) is transformed and gridded once,
// kept while it is wanted and cached after, and a rebuild only moves meshes in and out of the
// world. These tests pin down that it answers exactly what the merged-placement build answered,
// and the cache's own rules: reuse, hysteresis, eviction, deferral and readiness.

let vmapsDirectory;
try {
  vmapsDirectory = (await import("../tools/paths.mjs")).vmapsDirectory();
} catch {
  vmapsDirectory = undefined;
}
const withDataset = {
  skip: vmapsDirectory && existsSync(join(vmapsDirectory, "Stormwind.wmo.vmo")) ? false : "no tswow dataset on this machine",
};

const RANGE = 90;
const flushed = () => new Promise((resolve) => setImmediate(resolve));

/** World-space triangles, placed under a spawn with no turn, as the model-space group the wire carries. */
function group(worldTriangles, placement, { flags = 0x2000, groupId = 900 } = {}) {
  const vertices = new Float32Array(worldTriangles.length);
  for (let index = 0; index < worldTriangles.length; index += 3) {
    // The inverse of `transformCollisionMesh` for an unturned, unscaled spawn: vmap's x/y mirror.
    vertices[index] = placement.x - worldTriangles[index];
    vertices[index + 1] = placement.y - worldTriangles[index + 1];
    vertices[index + 2] = worldTriangles[index + 2] - placement.z;
  }
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let index = 0; index < vertices.length; index += 3) {
    bounds.minX = Math.min(bounds.minX, vertices[index]);
    bounds.minY = Math.min(bounds.minY, vertices[index + 1]);
    bounds.minZ = Math.min(bounds.minZ, vertices[index + 2]);
    bounds.maxX = Math.max(bounds.maxX, vertices[index]);
    bounds.maxY = Math.max(bounds.maxY, vertices[index + 1]);
    bounds.maxZ = Math.max(bounds.maxZ, vertices[index + 2]);
  }
  return { bounds, flags, groupId, vertices, indices: Uint32Array.from({ length: vertices.length / 3 }, (_unused, index) => index) };
}

/** A flat floor over a rectangle at height z, cut into `cells` squares a side so it can carry a grid. */
function slab(minX, minY, maxX, maxY, z, cells = 1) {
  const out = [];
  const stepX = (maxX - minX) / cells;
  const stepY = (maxY - minY) / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const x0 = minX + i * stepX, y0 = minY + j * stepY, x1 = x0 + stepX, y1 = y0 + stepY;
      out.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z);
    }
  }
  return out;
}

/** A wall in the plane x = at, from y0 to y1, rising from z0 to z1, in `cells` strips. */
function wallX(at, y0, y1, z0, z1, cells = 1) {
  const out = [];
  const step = (y1 - y0) / cells;
  for (let i = 0; i < cells; i++) {
    const a = y0 + i * step, b = a + step;
    out.push(at, a, z0, at, b, z0, at, b, z1, at, a, z0, at, b, z1, at, a, z1);
  }
  return out;
}

/** A wall in the plane y = at. */
function wallY(at, x0, x1, z0, z1, cells = 1) {
  const out = [];
  const step = (x1 - x0) / cells;
  for (let i = 0; i < cells; i++) {
    const a = x0 + i * step, b = a + step;
    out.push(a, at, z0, b, at, z0, b, at, z1, a, at, z0, b, at, z1, a, at, z1);
  }
  return out;
}

function spawn(id, name, x, y, z = 0, extra = {}) {
  return { id, kind: name.toLowerCase().endsWith(".wmo") ? "wmo" : "m2", name, x, y, z, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, ...extra };
}

/** A spawn with the world box a `.vmtile` records for it, around every triangle it will place. */
function placed(id, name, x, y, worldTriangles) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let index = 0; index < worldTriangles.length; index += 3) {
    bounds.minX = Math.min(bounds.minX, worldTriangles[index]);
    bounds.minY = Math.min(bounds.minY, worldTriangles[index + 1]);
    bounds.minZ = Math.min(bounds.minZ, worldTriangles[index + 2]);
    bounds.maxX = Math.max(bounds.maxX, worldTriangles[index]);
    bounds.maxY = Math.max(bounds.maxY, worldTriangles[index + 1]);
    bounds.maxZ = Math.max(bounds.maxZ, worldTriangles[index + 2]);
  }
  return spawn(id, name, x, y, 0, { bounds });
}

/**
 * A gateway in `globalThis.fetch`: every tile answers `placements(map, gx, gy)`, a model named in
 * `headerFirst` answers its first request with the header alone, and `?groups=` with those groups.
 */
function gateway({ placements, models, headerFirst = new Set(), hold }) {
  const original = globalThis.fetch;
  const log = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    log.push(`${url.pathname}${url.search}`);
    if (hold) await hold(url);
    const tile = url.pathname.match(/^\/environment\/(\d+)\/(\d+)\/(\d+)$/);
    if (tile) {
      const objects = placements(Number(tile[1]), Number(tile[2]), Number(tile[3]));
      return objects ? new Response(JSON.stringify(objects), { status: 200 }) : new Response(null, { status: 404 });
    }
    const model = url.pathname.match(/^\/collision\/model\/(.+)$/);
    const groups = model && models.get(decodeURIComponent(model[1]));
    if (!groups) return new Response(null, { status: 204 });
    const wanted = url.searchParams.get("groups");
    const include = wanted !== null
      ? new Set(wanted.split(",").map(Number))
      : headerFirst.has(decodeURIComponent(model[1])) ? new Set() : undefined;
    return new Response(encodeCollisionModel(groups, include), { status: 200 });
  };
  return { log, restore: () => { globalThis.fetch = original; } };
}

/** Frames at one spot until nothing more arrives: refresh, let the responses land, repeat. */
async function settle(source, map, x, y, frames = 12) {
  for (let frame = 0; frame < frames; frame++) {
    source.refresh(map, x, y);
    await flushed();
    await flushed();
  }
  source.refresh(map, x, y);
}

function hitOf(world, x, y, fromZ, minZ) {
  const hit = world.floorHitUnder(x, y, fromZ, minZ);
  return hit && { z: hit.z, flags: hit.flags, instanceId: hit.instanceId, groupIndex: hit.groupIndex, groupId: hit.groupId };
}

function boxDistance(box, x, y) {
  return Math.hypot(Math.max(box.minX - x, 0, x - box.maxX), Math.max(box.minY - y, 0, y - box.maxY));
}

/**
 * The build this replaced, as a reference: nearest placement first under the same ceilings, each
 * placement's in-range groups merged into one mesh with a run table, keyed by spawn id.
 */
function mergedPlacementWorld(objects, modelOf, x, y) {
  const byId = new Map();
  for (const object of objects) if (!byId.has(object.id)) byId.set(object.id, object);
  const distanceTo = (object) => object.bounds ? boxDistance(object.bounds, x, y) : Math.hypot(object.x - x, object.y - y);
  const near = [...byId.values()].map((object) => ({ object, distance: distanceTo(object) }))
    .filter((entry) => entry.distance < RANGE)
    .sort((left, right) => left.distance - right.distance || left.object.id - right.object.id);
  const world = new CollisionWorld();
  let instances = 0;
  let triangles = 0;
  for (const { object } of near) {
    if (instances >= 400 || triangles >= 300_000) continue;
    const model = modelOf(object.name);
    if (!model) continue;
    const parts = [];
    const runs = [];
    let length = 0;
    for (const [index, piece] of model.groups.entries()) {
      if (piece.triangleCount === 0) continue;
      if (boxDistance(transformCollisionBounds(piece.bounds, object), x, y) >= RANGE) continue;
      const part = transformCollisionMesh(piece.vertices, piece.indices, object);
      runs.push({ first: length / 9, flags: piece.flags, groupIndex: index, groupId: piece.groupId });
      parts.push(part);
      length += part.length;
    }
    if (length === 0) continue;
    const merged = new Float32Array(length);
    let cursor = 0;
    for (const part of parts) {
      merged.set(part, cursor);
      cursor += part.length;
    }
    world.set(object.id, new CollisionMesh(merged, runs));
    instances++;
    triangles += length / 9;
  }
  return { world, instances, triangles };
}

/**
 * A building of four groups — a gridded ground floor, an upper storey co-planar with a second
 * group's floor, walls meeting at a right angle — and two doodads, one standing on the floor.
 */
function town() {
  const rooms = [
    slab(-20, -20, 20, 20, 0, 8),
    [...slab(-10, -10, 10, 10, 4, 3), ...slab(-10, -10, 10, 10, 0.5, 2)],
    // Co-planar with group 1's upper floor over half of it: the tie is broken by authored group id.
    slab(0, -10, 10, 10, 4, 3),
    [...wallX(12, -12, 12, 0, 6, 10), ...wallY(12, -12, 12, 0, 6, 10), ...wallX(-12, -12, 12, 0, 6, 4)],
    // A lintel whose underside is just over a character's head: the top sphere still reaches it.
    // Merged, the inn spanned every height and was never culled by height; held as groups, this
    // one would be, unless the cull asks about the whole inn.
    wallX(0, -15, -5, 2.1, 4, 3),
  ];
  const inn = placed(77, "Inn.wmo", 10, 5, rooms.flat());
  const innGroups = [
    group(rooms[0], inn, { flags: 0x8, groupId: 893 }),
    group(rooms[1], inn, { flags: 0x2000, groupId: 904 }),
    group(rooms[2], inn, { flags: 0x2000, groupId: 901 }),
    group(rooms[3], inn, { flags: 0x2000, groupId: 950 }),
    group(rooms[4], inn, { flags: 0x2000, groupId: 951 }),
  ];
  const box = [...slab(4, 4, 6, 6, 1), ...wallX(4, 4, 6, 0, 1), ...wallX(6, 4, 6, 0, 1)];
  const crate = placed(12, "Crate.m2", 5, 5, box);
  const crateGroups = [group(box, crate, { flags: 0 })];
  const post = [...wallX(-30.2, -0.2, 0.2, 0, 3), ...wallY(-0.2, -30.2, -29.8, 0, 3)];
  const lamp = placed(13, "Lamp.m2", -30, 0, post);
  const lampGroups = [group(post, lamp, { flags: 0 })];
  const placements = [inn, crate, lamp];
  const models = new Map([["Inn.wmo", innGroups], ["Crate.m2", crateGroups], ["Lamp.m2", lampGroups]]);
  return { placements, models };
}

test("per-group meshes answer exactly what merged placements answered", async () => {
  const { placements, models } = town();
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    await settle(source, 1, 0, 0);
    const decoded = new Map([...models].map(([name, groups]) => [name, decodeCollisionModel(encodeCollisionModel(groups).buffer)]));
    const reference = mergedPlacementWorld(placements, (name) => decoded.get(name), 0, 0);
    assert.equal(source.counts.instances, reference.instances);
    assert.equal(source.counts.triangles, reference.triangles);
    assert.ok(source.world.size > reference.world.size, "the inn is held as its groups, not as one mesh");

    let floors = 0;
    for (let i = 0; i <= 80; i++) {
      for (let j = 0; j <= 80; j++) {
        const x = -30 + i * 0.75 + 0.11;
        const y = -30 + j * 0.75 + 0.07;
        for (const [fromZ, minZ] of [[100, -100], [5, -100], [4, 3.9], [1.2, -100], [0.25, -100]]) {
          const expected = hitOf(reference.world, x, y, fromZ, minZ);
          assert.deepEqual(hitOf(source.world, x, y, fromZ, minZ), expected, `floor at ${x}, ${y} from ${fromZ}`);
          assert.equal(source.world.indoorsAt(x, y, fromZ, minZ), reference.world.indoorsAt(x, y, fromZ, minZ));
          if (expected) floors++;
        }
      }
    }
    assert.ok(floors > 10_000, `only ${floors} floors were found at all`);

    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let hits = 0;
    for (let k = 0; k < 3000; k++) {
      const from = { x: -25 + random() * 50, y: -25 + random() * 50, z: 0.5 + random() * 6 };
      const to = { x: from.x + (random() - 0.5) * 60, y: from.y + (random() - 0.5) * 60, z: from.z + (random() - 0.5) * 10 };
      const expected = reference.world.firstHit(from, to);
      assert.deepEqual(source.world.firstHit(from, to), expected);
      if (expected) hits++;
    }
    assert.ok(hits > 500, `only ${hits} segments hit anything`);

    // Push-out resolves walls one triangle at a time, so it is only as order-free as the geometry
    // lets it be: where a body overlaps the ends of two walls at once, whichever is resolved first
    // decides which way it comes out, and the merged grid visited triangles in an order set by
    // the cells of the whole placement. Everywhere else — along a wall, inside the right-angled
    // corner — the answer is the same to the last few bits. What must never differ is whether a
    // point is pushed at all.
    let pushed = 0;
    const differing = [];
    for (let i = 0; i <= 100; i++) {
      for (let j = 0; j <= 100; j++) {
        const x = -15 + i * 0.3 + 0.013;
        const y = -15 + j * 0.3 + 0.029;
        const expected = reference.world.pushOut(x, y, 0, 0.389, 2.03128, 1.6);
        const actual = source.world.pushOut(x, y, 0, 0.389, 2.03128, 1.6);
        const moved = expected.x !== x || expected.y !== y;
        assert.equal(actual.x !== x || actual.y !== y, moved, `pushed in one world only at ${x}, ${y}`);
        if (moved) pushed++;
        if (Math.hypot(actual.x - expected.x, actual.y - expected.y) > 1e-9) differing.push([x, y]);
      }
    }
    assert.ok(pushed > 100, `only ${pushed} points were inside a wall`);
    // Only where a body can touch two wall ends at once: the walls end at (+-12, +-12).
    for (const [x, y] of differing) {
      assert.ok(Math.abs(Math.abs(x) - 12) < 0.389 * 2 && Math.abs(Math.abs(y) - 12) < 0.389 * 2,
        `push-out resolved differently away from a wall end at ${x}, ${y}`);
    }
    assert.ok(differing.length <= pushed / 50, `${differing.length} of ${pushed} push-outs resolved differently`);
    // And the lintel pushes a head that comes up under it, as it did when the inn was one mesh.
    const underLintel = source.world.pushOut(0.1, -10, 0, 0.389, 2.03128, 1.6);
    assert.ok(underLintel.x > 0.3, `the lintel let the head through at ${underLintel.x}`);
  } finally {
    server.restore();
  }
});

test("push-out culls an instance by the height of everything it holds, and only that", () => {
  // A room's floor and, over it, a lintel starting just above a character's head.
  const floorMesh = new CollisionMesh(Float32Array.from(slab(-5, -5, 5, 5, 0)));
  const lintel = new CollisionMesh(Float32Array.from(wallX(0, -5, 5, 2.1, 4)));
  const world = new CollisionWorld();
  world.set(1, floorMesh, 7);
  world.set(2, lintel, 7);
  // Together they span the body, as one merged mesh would, and the top sphere meets the lintel.
  assert.ok(world.pushOut(0.1, 0, 0, 0.389, 2.03128, 1.6).x > 0.3);
  assert.deepEqual([world.instanceOf(1), world.instanceOf(2), world.instanceOf(3)], [7, 7, undefined]);
  // Without the floor the instance starts above the head and is culled, exactly like the lintel
  // stored on its own.
  world.delete(1);
  const alone = new CollisionWorld();
  alone.set(2, lintel);
  assert.deepEqual(world.pushOut(0.1, 0, 0, 0.389, 2.03128, 1.6), alone.pushOut(0.1, 0, 0, 0.389, 2.03128, 1.6));
  assert.deepEqual(world.pushOut(0.1, 0, 0, 0.389, 2.03128, 1.6), { x: 0.1, y: 0 });
  // Stored again under the same key for another instance, it leaves the first one entirely.
  world.set(2, lintel, 8);
  world.set(3, floorMesh, 7);
  assert.deepEqual(world.pushOut(0.1, 0, 0, 0.389, 2.03128, 1.6), { x: 0.1, y: 0 });
});

test("floor hits name the spawn, and the locator its authored room, whichever group was hit", async () => {
  const { placements, models } = town();
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    await settle(source, 1, 0, 0);
    // Over the co-planar half of the upper storey: groups 1 and 2 both answer at 4, and the lower
    // authored id wins, reported against the inn's own spawn id.
    const upper = source.world.floorHitUnder(5, 0, 5, 3);
    assert.deepEqual([upper.z, upper.instanceId, upper.groupIndex, upper.groupId], [4, 77, 2, 901]);
    const located = source.staticWmoFloorUnder(1, 5, 0, 5, 3);
    assert.equal(located.placement.key, "1:77");
    assert.equal(located.placement.modelName, "Inn.wmo");
    assert.deepEqual([located.groupIndex, located.groupId, located.groupFlags, located.floorZ], [2, 901, 0x2000, 4]);
    // The crate stands on the inn's floor and is an M2: the locator passes over it to the inn.
    const onCrate = source.world.floorHitUnder(5, 5, 2, -1);
    assert.equal(onCrate.instanceId, 12);
    assert.equal(source.staticWmoFloorUnder(1, 5, 5, 2, -1).placement.spawnId, 77);
  } finally {
    server.restore();
  }
});

/** A street of single-group buildings every 40 yards along x, each a gridded floor with a wall. */
function street(count, spacing = 40) {
  const placements = [];
  const models = new Map();
  for (let index = 0; index < count; index++) {
    const x = index * spacing;
    const triangles = [...slab(x - 5, -5, x + 5, 5, 0, 6), ...wallY(4, x - 5, x + 5, 0, 5, 4)];
    const house = placed(100 + index, `House${index}.wmo`, x, 0, triangles);
    placements.push(house);
    models.set(house.name, [group(triangles, house, { groupId: 1000 + index })]);
  }
  return { placements, models };
}

/** The mesh objects standing in a world, by the spawn they answer for. */
function standingMeshes(world) {
  const meshes = new Map();
  for (const key of world.ids()) meshes.set(world.instanceOf(key), world.get(key));
  return meshes;
}

test("a group is transformed once while it stays in range, and walking back reuses it", async () => {
  const { placements, models } = street(12);
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    await settle(source, 1, 0, 0);
    const first = standingMeshes(source.world);
    assert.equal(source.groupCache.built, first.size, "one build per standing group");
    // Walk the street in 10-yard steps and back, one evaluation per step.
    for (let x = 10; x <= 440; x += 10) await settle(source, 1, x, 0, 2);
    const far = source.groupCache;
    for (let x = 430; x >= 0; x -= 10) await settle(source, 1, x, 0, 2);
    const back = source.groupCache;
    assert.equal(far.built, 12, "every house was built exactly once on the way out");
    assert.equal(back.built, 12, "and none again on the way back: the cache had them");
    assert.ok(back.evaluations > 80, `${back.evaluations} evaluations`);
    const again = standingMeshes(source.world);
    for (const [id, mesh] of first) assert.equal(again.get(id), mesh, `spawn ${id} came back as the same mesh`);
  } finally {
    server.restore();
  }
});

test("a group leaves the world only once it is clearly out of range, so a boundary does not churn", async () => {
  // One house whose floor box ends at x = 5; the player walks out along +x.
  const { placements, models } = street(1);
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    await settle(source, 1, 90, 0);
    assert.equal(source.world.size, 1, "85 yards from its box: in range");
    const revisions = [];
    // Along the ninety-yard boundary and back, eight and a half yards at a time.
    for (const x of [99.5, 91, 99.5, 91, 99.5]) {
      await settle(source, 1, x, 0, 2);
      assert.equal(source.world.size, 1, `still standing at ${x - 5} yards`);
      revisions.push(source.revision);
    }
    assert.equal(source.groupCache.built, 1);
    await settle(source, 1, 118, 0, 2);
    assert.equal(source.world.size, 1, "113 yards: still inside the thirty-yard margin");
    await settle(source, 1, 127, 0, 2);
    assert.equal(source.world.size, 0, "122 yards: gone from the world");
    assert.equal(source.groupCache.groups, 1, "but kept in the cache");
    await settle(source, 1, 90, 0, 2);
    assert.equal(source.world.size, 1);
    assert.equal(source.groupCache.built, 1, "and it came back without a rebuild");
  } finally {
    server.restore();
  }
});

test("walking a street, the cache stays under its cap and still has what was just walked past", async () => {
  const { placements, models } = street(12);
  const probe = new CollisionMesh(transformCollisionMesh(models.get("House0.wmo")[0].vertices, models.get("House0.wmo")[0].indices, placements[0]));
  const cap = probe.byteLength * 6;
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world", { cacheBytes: cap });
    await settle(source, 1, 0, 0);
    for (let x = 10; x <= 440; x += 10) {
      await settle(source, 1, x, 0, 2);
      const cache = source.groupCache;
      let standingBytes = 0;
      for (const key of source.world.ids()) standingBytes += source.world.get(key).byteLength;
      assert.ok(cache.bytes <= Math.max(cap, standingBytes),
        `${cache.bytes} bytes held at x = ${x} with ${standingBytes} standing`);
      assert.ok(cache.bytes >= standingBytes, "a standing group was evicted");
    }
    const out = source.groupCache;
    assert.ok(out.evicted > 0, "walking the street pushed early houses out");
    assert.equal(out.built, 12);
    // The last houses left behind are still cached; the first ones were evicted and are rebuilt.
    await settle(source, 1, 300, 0, 2);
    assert.equal(source.groupCache.built, 12, "recently wanted houses came back from the cache");
    await settle(source, 1, 0, 0, 2);
    assert.ok(source.groupCache.built > 12, "the least recently wanted were the ones evicted");
  } finally {
    server.restore();
  }
});

test("eviction takes the least recently wanted group first, and never the one underfoot", async () => {
  // Four houses a kilometre apart, visited in turn: only one is ever in range.
  const { placements, models } = street(4, 1000);
  const one = models.get("House0.wmo")[0];
  const bytes = new CollisionMesh(transformCollisionMesh(one.vertices, one.indices, placements[0])).byteLength;
  const server = gateway({ placements: () => placements, models });
  try {
    // Room for the house underfoot and two more (and a little slack: the grids of houses a
    // kilometre apart can differ by a triangle reference or two).
    const source = new CollisionSource("ws://localhost:1234/world", { cacheBytes: bytes * 3.5 });
    for (const x of [0, 1000, 2000]) await settle(source, 1, x, 0);
    assert.deepEqual([source.groupCache.built, source.groupCache.evicted], [3, 0]);
    await settle(source, 1, 3000, 0);
    assert.deepEqual([source.groupCache.built, source.groupCache.evicted, source.groupCache.groups], [4, 1, 3]);
    await settle(source, 1, 1000, 0);
    assert.equal(source.groupCache.built, 4, "the house left second-longest ago was still cached");
    await settle(source, 1, 0, 0);
    assert.equal(source.groupCache.built, 5, "the house left longest ago was the one evicted");

    // No room at all beyond what is standing: everything idle goes, and what is standing stays.
    const tight = new CollisionSource("ws://localhost:1234/world", { cacheBytes: 1 });
    for (const x of [0, 1000, 2000, 1000]) {
      await settle(tight, 1, x, 0);
      assert.equal(tight.world.floorUnder(x, 0, 1.6, -10), 0, `the floor under x = ${x} is standing`);
      assert.equal(tight.groupCache.groups, 1);
    }
    assert.equal(tight.groupCache.built, 4);
  } finally {
    server.restore();
  }
});

test("the ceilings are spent nearest first, and what the margin keeps only uses what is left", async () => {
  // Four 100,000-triangle floors 30 yards apart along x: three of them fill the triangle ceiling.
  const quad = slab(-1, -1, 1, 1, 0);
  const heavy = [];
  for (let copy = 0; copy < 50_000; copy++) heavy.push(...quad);
  const placements = [0, 30, 60, 90].map((x, index) => {
    const moved = heavy.map((value, at) => at % 3 === 0 ? value + x : value);
    return placed(300 + index, `Slab${index}.m2`, x, 0, moved.slice(0, 18));
  });
  const models = new Map(placements.map((spawned, index) => [spawned.name,
    [group(heavy.map((value, at) => at % 3 === 0 ? value + [0, 30, 60, 90][index] : value), spawned, { flags: 0 })]]));
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    await settle(source, 1, 0, 0);
    // Nearest first: 0, 30 and 60 make 300,000, and the fourth, 89 yards off, does not fit.
    assert.deepEqual(source.counts, { instances: 3, triangles: 300_000, dropped: 1 });
    assert.equal(source.world.floorUnder(90, 0, 1, -1), undefined);
    // Walk to x = 100: the slab at 0 is now 99 yards off, inside the margin, but the three in
    // range already fill the ceiling, so it goes rather than being kept on top of them.
    await settle(source, 1, 100, 0);
    assert.deepEqual(source.counts, { instances: 3, triangles: 300_000, dropped: 0 });
    assert.equal(source.world.floorUnder(0, 0, 1, -1), undefined, "the margin never breaks a ceiling");
    assert.equal(source.world.floorUnder(90, 0, 1, -1), 0);
  } finally {
    server.restore();
  }
});

test("a map change, a reset and a dispose each drop every built group", async () => {
  const { placements, models } = street(3);
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    await settle(source, 1, 0, 0);
    assert.ok(source.groupCache.groups > 0 && source.world.size > 0);
    source.refresh(2, 0, 0);
    assert.equal(source.world.size, 0, "nothing from map 1 stands on map 2");
    assert.equal(source.groupCache.groups, 0);
    assert.equal(source.counts.triangles, 0);
    await settle(source, 2, 0, 0);
    assert.ok(source.world.size > 0);
    source.reset();
    assert.equal(source.world.size, 0);
    assert.equal(source.groupCache.groups, 0);
    await settle(source, 2, 0, 0);
    source.dispose();
    assert.equal(source.groupCache.groups, 0);
    assert.equal(source.world.size, 0);
  } finally {
    server.restore();
  }
});

/** One building of five groups: one under the player, one beside them, three down the street. */
function block() {
  const rooms = [
    slab(-6, -6, 6, 6, 0, 9),
    slab(10, -6, 16, 6, 0, 9),
    slab(30, -6, 40, 6, 0, 9),
    slab(50, -6, 60, 6, 0, 9),
    slab(70, -6, 80, 6, 0, 9),
  ];
  const hall = placed(55, "Hall.wmo", 0, 0, rooms.flat());
  const groups = rooms.map((room, index) => group(room, hall, { groupId: 500 + index }));
  return { placements: [hall], models: new Map([["Hall.wmo", groups]]) };
}

test("a deferred build never defers the floor under the player or the groups beside them", async () => {
  const { placements, models } = block();
  const server = gateway({ placements: () => placements, models });
  try {
    // No budget at all: only what the player can touch, plus one group a frame to keep moving.
    const source = new CollisionSource("ws://localhost:1234/world", { buildBudgetMs: 0 });
    source.refresh(1, 0, 0);
    await flushed();
    await flushed();
    source.refresh(1, 0, 0);
    await flushed();
    await flushed();
    source.refresh(1, 0, 0);
    assert.equal(source.world.floorUnder(0, 0, 1.6, -10), 0, "the floor under the feet is there on the first frame");
    assert.equal(source.world.floorUnder(13, 0, 1.6, -10), 0, "and the room four yards away");
    const deferred = source.groupCache.deferred;
    assert.ok(deferred >= 2 && deferred <= 3, `${deferred} far groups waiting`);
    assert.equal(source.stats.pending >= deferred, true, "deferred builds are pending work");
    // A teleport into the middle of the street: the group now underfoot is built at once, ahead
    // of the queue, and the rest keep coming a frame at a time.
    source.refresh(1, 55, 0);
    assert.equal(source.world.floorUnder(55, 0, 1.6, -10), 0);
  } finally {
    server.restore();
  }
});

test("the transfer barrier stays closed until every wanted group is built, not only answered", async () => {
  const { placements, models } = block();
  const server = gateway({ placements: () => placements, models });
  try {
    const source = new CollisionSource("ws://localhost:1234/world", { buildBudgetMs: 0 });
    let opened;
    for (let frame = 0; frame < 20; frame++) {
      source.refresh(1, 0, 0);
      const ready = source.isReady(1, 0, 0);
      const cache = source.groupCache;
      if (ready) {
        opened ??= frame;
        assert.equal(cache.deferred, 0, "open with builds still queued");
        assert.equal(cache.standing, 5);
      } else {
        assert.equal(opened, undefined, "the barrier closed again");
      }
      await flushed();
      await flushed();
    }
    assert.ok(opened !== undefined, "the barrier never opened");
  } finally {
    server.restore();
  }
});

test("only a landing the world is waiting for makes it evaluate, and a frame's landings are one evaluation", async () => {
  const { placements, models } = block();
  models.set("Far.wmo", [group(slab(-1, -1, 1, 1, 0), spawn(1, "Far.wmo", 2000, 0))]);
  // A second building beside the hall, so its rooms come back in a response of their own.
  const annexRoom = slab(-6, 20, 6, 30, 0, 9);
  const annex = placed(56, "Annex.wmo", 0, 25, annexRoom);
  models.set("Annex.wmo", [group(annexRoom, annex, { groupId: 600 })]);
  // Both arrive as a header first, like a city: their rooms are asked for separately.
  const held = [];
  const server = gateway({
    placements: () => [...placements, annex],
    models,
    headerFirst: new Set(["Hall.wmo", "Annex.wmo"]),
    hold: (url) => url.searchParams.has("groups") ? new Promise((resolve) => held.push(resolve)) : undefined,
  });
  try {
    const source = new CollisionSource("ws://localhost:1234/world");
    await settle(source, 1, 0, 0);
    assert.equal(source.world.size, 0, "the rooms are still on the wire");
    assert.equal(held.length, 2, "one room request per building");
    const before = source.groupCache.evaluations;
    // The renderer's water probe asks for some other building through the same client.
    assert.equal(source.models.model("Far.wmo"), undefined);
    await flushed();
    await flushed();
    assert.ok(source.models.model("Far.wmo"), "the probe's answer landed");
    source.refresh(1, 0, 0);
    source.refresh(1, 0, 0);
    assert.equal(source.groupCache.evaluations, before, "an answer nobody here asked for rebuilt nothing");
    // Now the rooms: both responses land between two frames, and that is one evaluation.
    for (const release of held.splice(0)) release();
    await flushed();
    await flushed();
    await flushed();
    source.refresh(1, 0, 0);
    assert.equal(source.groupCache.evaluations, before + 1);
    assert.equal(source.world.size, 6);
  } finally {
    server.restore();
  }
});

test("one spawn repeated in two tiles resolves to the same placement whichever tile lands first", async () => {
  const floor = slab(-8, -8, 8, 8, 0, 4);
  const floorAt = (x) => placed(88, "Keep.wmo", x, 0, floor.map((value, index) => index % 3 === 0 ? value + x : value));
  // Two copies of spawn 88 that disagree by half a yard, in the tiles either side of x = 0.
  const copies = { "32/32": floorAt(0.5), "31/32": floorAt(0) };
  const model = [group(floor, floorAt(0), { groupId: 7 })];
  const located = [];
  for (const order of [["32/32", "31/32"], ["31/32", "32/32"]]) {
    const gates = new Map();
    const server = gateway({
      placements: (_map, gx, gy) => {
        const copy = copies[`${gx}/${gy}`];
        return copy ? [copy] : [];
      },
      models: new Map([["Keep.wmo", model]]),
      // The second tile of the order waits until the first has been answered and built.
      hold: (url) => {
        const key = url.pathname.split("/").slice(3).join("/");
        if (key !== order[1]) return undefined;
        return new Promise((resolve) => { gates.set(key, resolve); });
      },
    });
    try {
      const source = new CollisionSource("ws://localhost:1234/world");
      await settle(source, 1, 0, 0, 6);
      assert.ok(gates.has(order[1]), "the second tile was held back");
      gates.get(order[1])();
      await settle(source, 1, 0, 0, 6);
      located.push(source.staticWmoFloorUnder(1, 0.25, 0.25, 1, -1)?.placement.x);
    } finally {
      server.restore();
    }
  }
  assert.deepEqual(located, [0, 0], "the lower transform wins in both orders");
});

test("one file is fetched once whatever case its name is asked in", async () => {
  const groups = [group(slab(-1, -1, 1, 1, 0), spawn(1, "Stormwind.wmo", 0, 0))];
  const log = [];
  const original = globalThis.fetch;
  // A case-sensitive gateway: only the extractor's own spelling is a file.
  globalThis.fetch = async (input) => {
    const name = decodeURIComponent(new URL(String(input)).pathname.split("/").pop());
    log.push(name);
    return name === "Stormwind.wmo"
      ? new Response(encodeCollisionModel(groups), { status: 200 })
      : new Response(null, { status: 204 });
  };
  try {
    // Tile first: the renderer's archive spelling is folded onto the tile's.
    const folded = new CollisionClient("ws://localhost:1234/world");
    folded.preferSpelling("Stormwind.wmo");
    assert.equal(folded.model("STORMWIND.WMO"), undefined);
    assert.equal(folded.model("Stormwind.wmo"), undefined);
    await flushed();
    await flushed();
    const model = folded.model("Stormwind.wmo");
    assert.ok(model);
    assert.equal(folded.model("STORMWIND.WMO"), model);
    assert.deepEqual(log, ["Stormwind.wmo"]);

    // Probe first, on a case-insensitive disk: the second spelling waits for the first's answer.
    log.length = 0;
    globalThis.fetch = async (input) => {
      log.push(decodeURIComponent(new URL(String(input)).pathname.split("/").pop()));
      return new Response(encodeCollisionModel(groups), { status: 200 });
    };
    const shared = new CollisionClient("ws://localhost:1234/world");
    assert.equal(shared.model("STORMWIND.WMO"), undefined);
    assert.equal(shared.model("Stormwind.wmo"), undefined);
    assert.equal(shared.isResolved("Stormwind.wmo"), false);
    await flushed();
    await flushed();
    assert.equal(shared.isResolved("Stormwind.wmo"), true);
    assert.equal(shared.model("Stormwind.wmo"), shared.model("STORMWIND.WMO"));
    assert.deepEqual(log, ["STORMWIND.WMO"]);
    assert.equal(shared.counts.models, 1);

    // Probe first, on a case-sensitive disk: its 204 does not stop the tile's spelling asking.
    log.length = 0;
    globalThis.fetch = async (input) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.split("/").pop());
      log.push(name);
      return name === "Stormwind.wmo"
        ? new Response(encodeCollisionModel(groups), { status: 200 })
        : new Response(null, { status: 204 });
    };
    const sensitive = new CollisionClient("ws://localhost:1234/world");
    sensitive.model("STORMWIND.WMO");
    await flushed();
    await flushed();
    assert.equal(sensitive.isResolved("STORMWIND.WMO"), true);
    assert.equal(sensitive.model("Stormwind.wmo"), undefined);
    await flushed();
    await flushed();
    const found = sensitive.model("Stormwind.wmo");
    assert.ok(found);
    assert.equal(sensitive.model("STORMWIND.WMO"), found, "and the probe then gets the water after all");
    assert.deepEqual(log, ["STORMWIND.WMO", "Stormwind.wmo"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("the real Trade District answers the same as its merged placements did", withDataset, async () => {
  // The route the freezes were measured on, from the server's own files through the gateway's own
  // encoder: Stormwind is one spawn and 284 groups, and 34-46 of them are in range here.
  const [x, y] = [-8830, 640];
  const tiles = new Map();
  const tileObjects = async (gx, gy) => {
    const key = `${gx}/${gy}`;
    if (!tiles.has(key)) {
      const path = join(vmapsDirectory, `000_${String(gy).padStart(2, "0")}_${String(gx).padStart(2, "0")}.vmtile`);
      tiles.set(key, existsSync(path) ? parseVMapTile(new Uint8Array(await readFile(path))) : null);
    }
    return tiles.get(key);
  };
  // The gateway's own lookup: `<name>.vmo` beside a WMO, the bare name for an M2 with a `.vmo`
  // fallback. The disk here ignores case the way the gateway's does on this machine.
  const files = new Map();
  const serverGroups = async (name) => {
    const key = name.toLowerCase();
    if (!files.has(key)) {
      let path = join(vmapsDirectory, key.endsWith(".wmo") ? `${name}.vmo` : name);
      if (!existsSync(path) && !key.endsWith(".wmo")) path = join(vmapsDirectory, `${name}.vmo`);
      files.set(key, existsSync(path) ? parseVMapModelGroups(await readFile(path)) : null);
    }
    return files.get(key);
  };
  // The tiles the source itself reads here: 140 yards either side, as `terrainGrid` cuts them.
  const grids = new Set();
  for (const dx of [-140, 0, 140]) {
    for (const dy of [-140, 0, 140]) grids.add(`${Math.floor(32 - (x + dx) / (1600 / 3))}/${Math.floor(32 - (y + dy) / (1600 / 3))}`);
  }
  const objects = [];
  for (const grid of grids) objects.push(...(await tileObjects(...grid.split("/").map(Number)) ?? []));
  // Everything read before the clock starts, so the frames below wait on nothing but themselves.
  for (const object of objects) await serverGroups(object.name);
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const tile = url.pathname.match(/^\/environment\/0\/(\d+)\/(\d+)$/);
    if (tile) {
      const found = await tileObjects(Number(tile[1]), Number(tile[2]));
      return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response(null, { status: 404 });
    }
    const name = decodeURIComponent(url.pathname.split("/").pop());
    const groups = await serverGroups(name);
    if (!groups) return new Response(null, { status: 204 });
    const wanted = url.searchParams.get("groups");
    const triangles = groups.reduce((sum, piece) => sum + piece.indices.length / 3, 0);
    const include = wanted !== null ? new Set(wanted.split(",").map(Number))
      : triangles > COLLISION_TRIANGLE_BUDGET ? new Set() : undefined;
    return new Response(encodeCollisionModel(groups, include), { status: 200 });
  };
  try {
    const source = new CollisionSource("ws://localhost:8090/world");
    for (let frame = 0; frame < 400; frame++) {
      source.refresh(0, x, y);
      if (source.isReady(0, x, y) && source.groupCache.deferred === 0 && source.stats.pending === 0) break;
      await flushed();
      await flushed();
    }
    assert.equal(source.isReady(0, x, y), true);
    const whole = new Map();
    for (const object of objects) {
      if (whole.has(object.name)) continue;
      const groups = await serverGroups(object.name);
      whole.set(object.name, groups && decodeCollisionModel(encodeCollisionModel(groups).buffer));
    }
    const reference = mergedPlacementWorld(objects, (name) => whole.get(name), x, y);
    assert.equal(source.counts.instances, reference.instances);
    assert.equal(source.counts.triangles, reference.triangles);
    const stormwind = [...source.world.ids()].filter((key) => source.world.get(key).runs[0]?.groupIndex !== undefined
      && source.world.instanceOf(key) === objects.find((object) => object.name === "Stormwind.wmo")?.id);
    assert.ok(stormwind.length >= 30, `Stormwind stands as ${stormwind.length} group meshes`);

    let floors = 0;
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        const px = x - 60 + i * 3 + 0.37;
        const py = y - 60 + j * 3 + 0.61;
        const top = hitOf(reference.world, px, py, 1000, -1000);
        const heights = [[1000, -1000]];
        if (top) heights.push([top.z + 1.6, top.z - 400], [top.z - 0.5, top.z - 400]);
        for (const [fromZ, minZ] of heights) {
          assert.deepEqual(hitOf(source.world, px, py, fromZ, minZ), hitOf(reference.world, px, py, fromZ, minZ));
          if (top) floors++;
        }
      }
    }
    assert.ok(floors > 3000, `${floors} floors`);
    let seed = 99;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 1500; k++) {
      const px = x - 50 + random() * 100;
      const py = y - 50 + random() * 100;
      const z = (hitOf(reference.world, px, py, 1000, -1000)?.z ?? 100) + 1.6 + random() * 6;
      const angle = random() * Math.PI * 2;
      const length = 5 + random() * 35;
      const from = { x: px, y: py, z };
      const to = { x: px + Math.cos(angle) * length, y: py + Math.sin(angle) * length, z: z + (random() - 0.5) * 20 };
      assert.deepEqual(source.world.firstHit(from, to), reference.world.firstHit(from, to));
    }
    // A character standing anywhere on the district's floors is pushed exactly where it was, with
    // one kind of exception. Push-out resolves one triangle at a time, and in a concave corner the
    // order decides where it comes out; the merged build's order came from a grid laid over
    // whichever groups were in range, so it moved with the player. Measured on this grid at this
    // radius, the merged build disagreed with *itself* at 3 of 212 pushed points when built 12.7
    // yards away, and the group build disagrees with it at 1. What must never differ is whether a
    // point is pushed at all: a missing wall or a phantom one is a different world.
    let pushed = 0;
    let differing = 0;
    for (let i = 0; i <= 60; i++) {
      for (let j = 0; j <= 60; j++) {
        const px = x - 30 + i + 0.13;
        const py = y - 30 + j + 0.29;
        const top = hitOf(reference.world, px, py, 1000, -1000);
        if (!top) continue;
        const ground = hitOf(reference.world, px, py, top.z + 1.6, top.z - 400)?.z ?? top.z;
        const expected = reference.world.pushOut(px, py, ground, 0.389, 2.03128, 1.6);
        const actual = source.world.pushOut(px, py, ground, 0.389, 2.03128, 1.6);
        const moved = expected.x !== px || expected.y !== py;
        assert.equal(actual.x !== px || actual.y !== py, moved, `pushed in one world only at ${px}, ${py}`);
        if (moved) pushed++;
        if (Math.hypot(actual.x - expected.x, actual.y - expected.y) > 1e-9) differing++;
      }
    }
    assert.ok(pushed > 100, `${pushed} push-outs`);
    assert.ok(differing <= pushed / 100, `${differing} of ${pushed} push-outs resolved differently`);
  } finally {
    globalThis.fetch = original;
  }
});
