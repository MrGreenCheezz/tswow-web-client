import assert from "node:assert/strict";
import test from "node:test";
import {
  CollisionMesh, CollisionWorld, segmentHit,
} from "../dist/code/browser/game/Collision.js";

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

/** A floor made of `across` by `across` one-yard squares, which is enough to build a grid over. */
function tiledFloor(across, z = 0) {
  const triangles = new Float32Array(across * across * 18);
  let cursor = 0;
  for (let ix = 0; ix < across; ix++) {
    for (let iy = 0; iy < across; iy++) {
      triangles.set(quad([ix, iy, z], [ix + 1, iy, z], [ix + 1, iy + 1, z], [ix, iy + 1, z]), cursor);
      cursor += 18;
    }
  }
  return triangles;
}

test("Ж1.1 a segment finds the wall in front of it, and stops at its own far end", () => {
  const mesh = new CollisionMesh(wall(2));
  // Head-on: the wall is at x = 2, the segment runs from 0 to 4, so it is crossed halfway.
  const across = mesh.firstHit({ x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 1 });
  assert.ok(across);
  assert.ok(Math.abs(across.t - 0.5) < 1e-6, `${across.t}`);

  // A segment that stops short of it is not a ray that carries on.
  assert.equal(mesh.firstHit({ x: 0, y: 0, z: 1 }, { x: 1.9, y: 0, z: 1 }), undefined);
  // Over the top of it, and past the end of its span in y.
  assert.equal(mesh.firstHit({ x: 0, y: 0, z: 5 }, { x: 4, y: 0, z: 5 }), undefined);
  assert.equal(mesh.firstHit({ x: 0, y: 9, z: 1 }, { x: 4, y: 9, z: 1 }), undefined);
});

test("Ж1.1 a wall is not one-way glass, whichever way its triangles wind", () => {
  // `verticalHit` takes the absolute value of the normal because vmap winding is not consistent.
  // A back-face cull here would make half the walls in the world invisible from one side.
  const mesh = new CollisionMesh(wall(2));
  const forwards = mesh.firstHit({ x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 1 });
  const backwards = mesh.firstHit({ x: 4, y: 0, z: 1 }, { x: 0, y: 0, z: 1 });
  assert.ok(forwards && backwards);
  assert.ok(Math.abs(forwards.t - backwards.t) < 1e-6);
});

test("Ж1.1 a plumb line finds the floor, which is the query `verticalHit` cannot generalise", () => {
  const mesh = new CollisionMesh(floor(3));
  const down = mesh.firstHit({ x: 1, y: -2, z: 10 }, { x: 1, y: -2, z: 0 });
  assert.ok(down);
  assert.ok(Math.abs(down.t - 0.7) < 1e-6, `${down.t}`);
  // Straight down is the degenerate case for a walk over a grid of columns: it never leaves one.
  const tiled = new CollisionMesh(tiledFloor(12, 3));
  assert.ok(tiled.triangleCount > 64, "the grid has to exist for this to test the walk");
  const column = tiled.firstHit({ x: 6.5, y: 6.5, z: 10 }, { x: 6.5, y: 6.5, z: 0 });
  assert.ok(column);
  assert.ok(Math.abs(column.t - 0.7) < 1e-6, `${column.t}`);
});

test("Ж1.1 the walk over the grid answers exactly what walking every triangle answers", () => {
  // The whole point of the DDA is that it does less work, so the only thing worth asserting about
  // it is that it does not do less work than the question needs. Brute force is the oracle.
  const triangles = tiledFloor(16, 0);
  const mesh = new CollisionMesh(triangles);
  assert.ok(mesh.triangleCount > 64, "the grid has to exist for this to test anything");

  const brute = (from, to) => {
    let best;
    for (let triangle = 0; triangle < triangles.length / 9; triangle++) {
      const t = segmentHit(triangles, triangle, from, to);
      if (t !== undefined && (best === undefined || t < best)) best = t;
    }
    return best;
  };

  let hits = 0;
  // Deterministic sweep rather than random points, so a failure is the same failure twice.
  for (let index = 0; index < 400; index++) {
    const from = { x: -4 + (index * 7) % 26, y: -4 + (index * 11) % 26, z: 5 - (index % 9) };
    const to = { x: -4 + (index * 13) % 26, y: -4 + (index * 5) % 26, z: -3 + (index % 7) };
    const walked = mesh.firstHit(from, to);
    const expected = brute(from, to);
    if (expected === undefined) {
      assert.equal(walked, undefined, `segment ${index} was answered where brute force found nothing`);
      continue;
    }
    hits++;
    assert.ok(walked, `segment ${index} was missed by the walk`);
    assert.ok(Math.abs(walked.t - expected) < 1e-6, `segment ${index}: ${walked.t} against ${expected}`);
  }
  assert.ok(hits > 100, `only ${hits} of the sweep's segments hit anything; it proves nothing`);
});

test("Ж1.1 the world answers with the nearest mesh and what the mesh was made of", () => {
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(6), [{ first: 0, flags: 0x2005 }]));
  world.set(2, new CollisionMesh(wall(2), [{ first: 0, flags: 0x8009 }]));

  const hit = world.firstHit({ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 1 });
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - 0.2) < 1e-6, `${hit.t}`);
  assert.equal(hit.flags, 0x8009, "the near wall's group, not the far one's");

  // A mesh that carried no group table answers `undefined` flags — which is not the same as the
  // whole query answering nothing, and a caller has to be able to tell those apart.
  const bare = new CollisionWorld();
  bare.set(1, new CollisionMesh(wall(2)));
  assert.deepEqual(bare.firstHit({ x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 1 }), { t: 0.5, flags: undefined });
  assert.equal(bare.firstHit({ x: 0, y: 0, z: 9 }, { x: 4, y: 0, z: 9 }), undefined);
});

test("Ж1.1 an empty world and an empty mesh both answer nothing rather than throwing", () => {
  const world = new CollisionWorld();
  assert.equal(world.firstHit({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }), undefined);
  // An empty mesh's box is all zeros rather than inverted, so a segment through the origin gets
  // past the broad phase; it must still find nothing to test.
  world.set(1, new CollisionMesh(new Float32Array(0)));
  assert.equal(world.firstHit({ x: -1, y: -1, z: -1 }, { x: 1, y: 1, z: 1 }), undefined);
});
