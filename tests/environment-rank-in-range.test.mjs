import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_RESIDENT_HYSTERESIS,
  environmentCandidatesInRange,
  environmentRankInRange,
  environmentResidentsInRange,
} from "../dist/code/browser/WorldRenderer3D.js";

// P2-04b: the fused reselection pass gives exactly what the two reference passes give — the same
// placements, distances, leashes and order — and a candidate is the very record of its resident.

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const NAMES = ["World\\Props\\Rock.m2", "World\\Trees\\Pine.m2", "World\\Azeroth\\Elwynn\\Bush.m2", "World\\Wmo\\Castle.wmo"];

function world(seed) {
  const next = random(seed);
  const objects = [];
  for (let index = 0, count = 50 + Math.floor(next() * 400); index < count; index++) {
    const kind = next() < 0.1 ? "wmo" : "m2";
    const x = (next() - 0.5) * 1800, y = (next() - 0.5) * 1800;
    const object = {
      id: index, kind, name: kind === "wmo" ? NAMES[3] : NAMES[Math.floor(next() * 3)],
      x, y, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 0.3 + next() * 3,
    };
    if (kind === "m2" && next() < 0.6) object.admissionRadius = next() < 0.05 ? Number.NaN : next() * 12;
    if (kind === "wmo" && next() < 0.7) {
      const half = 5 + next() * 120;
      object.bounds = { minX: x - half, maxX: x + half, minY: y - half, maxY: y + half, minZ: -10, maxZ: 40 };
    }
    if (kind === "m2" && next() < 0.08) object.interior = true;
    if (next() < 0.02) object.x = Number.NaN;
    objects.push(object);
  }
  // Placements exactly on a leash and on the resident edge: `<`, not `<=`, on both.
  objects.push({ id: "edge", kind: "m2", name: NAMES[0], x: 400, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 });
  objects.push({ id: "band", kind: "m2", name: NAMES[0], x: 400 + ENVIRONMENT_RESIDENT_HYSTERESIS, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 });
  return objects;
}

test("the fused pass equals the two reference passes on 300 random worlds and every detail step", () => {
  let candidatesSeen = 0, bandSeen = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed * 31);
    const objects = world(seed);
    const player = seed % 3 === 0 ? { x: 0, y: 0 } : { x: (next() - 0.5) * 600, y: (next() - 0.5) * 600 };
    const detail = [0.5, 0.75, 1, 1.25, 1.5][seed % 5];
    const fused = environmentRankInRange(objects, player, detail);
    assert.deepEqual(fused.candidates, environmentCandidatesInRange(objects, player, detail), `seed ${seed}: candidates`);
    assert.deepEqual(fused.residents, environmentResidentsInRange(objects, player, detail), `seed ${seed}: residents`);
    // A candidate is the resident's own record, in the residents' relative order.
    let at = 0;
    for (const candidate of fused.candidates) {
      while (at < fused.residents.length && fused.residents[at] !== candidate) at++;
      assert.ok(at < fused.residents.length, `seed ${seed}: candidate ${candidate.object.id} is a resident record, in order`);
    }
    candidatesSeen += fused.candidates.length;
    bandSeen += fused.residents.length - fused.candidates.length;
  }
  assert.ok(candidatesSeen > 1000 && bandSeen > 300, `both bands occur (${candidatesSeen} candidates, ${bandSeen} in the resident band)`);
});

test("leash edges: on the leash is a resident only, on the resident edge is neither", () => {
  const objects = world(7).filter((object) => object.id === "edge" || object.id === "band");
  const fused = environmentRankInRange(objects, { x: 0, y: 0 });
  assert.deepEqual(fused.candidates.map((entry) => entry.object.id), []);
  assert.deepEqual(fused.residents.map((entry) => entry.object.id), ["edge"]);
});
