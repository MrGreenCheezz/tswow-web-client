import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_RANGE,
  ENVIRONMENT_RESIDENT_HYSTERESIS,
  environmentCandidatesInRange,
  environmentResidentsInRange,
  selectEnvironmentAdmission,
  selectPrefetchModels,
} from "../dist/code/browser/WorldRenderer3D.js";

const D2R = Math.PI / 180;
const HALF_FOV = 35 * D2R;

function rot2(x, z, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [x * cos - z * sin, x * sin + z * cos];
}

/** Two side frustum planes for a world bearing, in scene space. Camera at `at`. */
function yawPlanes(yaw, at = { x: 0, y: 0 }) {
  const fx = Math.cos(yaw), fz = -Math.sin(yaw);
  const [elx, elz] = rot2(fx, fz, HALF_FOV);
  const [erx, erz] = rot2(fx, fz, -HALF_FOV);
  const [nlx, nlz] = rot2(elx, elz, -Math.PI / 2);
  const [nrx, nrz] = rot2(erx, erz, Math.PI / 2);
  const cx = at.x, cz = -at.y;
  return [
    { normal: { x: nlx, y: 0, z: nlz }, constant: -(nlx * cx + nlz * cz) },
    { normal: { x: nrx, y: 0, z: nrz }, constant: -(nrx * cx + nrz * cz) },
  ];
}

function placement(id, x, y, options = {}) {
  return {
    id, kind: "m2", name: `World\\Props\\Rock${id}.m2`,
    x, y, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, ...options,
  };
}

function tree(id, x, y, options = {}) {
  return placement(id, x, y, { name: `World\\Trees\\Pine${id}.m2`, ...options });
}

/** Scene-space spheres, as the renderer measures them after the first build. */
function spheresFor(objects, radius = 4) {
  const spheres = new Map(objects.map((object) => [object.id, { x: object.x, y: 0, z: -object.y, radius }]));
  return (object) => spheres.get(object.id);
}

function ids(entries) {
  return entries.map((entry) => entry.object.id);
}

test("turn harness sees straight ahead and rejects behind", () => {
  const planes = yawPlanes(0);
  const kept = (sx, sz) => planes.every((plane) => {
    const n = plane.normal;
    return n.x * sx + n.z * sz + plane.constant >= 0;
  });
  assert.equal(kept(100, 0), true);
  assert.equal(kept(-100, 0), false);
  assert.equal(kept(100, 100), false, "45 degrees exceeds the 35-degree half-FOV");
  assert.equal(kept(100, 20), true, "~11 degrees is inside");
});

test("a small frustum slack admits the edge row without the far field", () => {
  // At 200 yards, 35.5 degrees sits ~2.6 yards past the geometric edge: inside the slack.
  const near = 200 * Math.cos(35.5 * D2R), side = 200 * Math.sin(35.5 * D2R);
  const edge = tree(1, near, side);
  // At 42 degrees (~40 yards past the edge) even the slack gives up.
  const far = tree(2, 200 * Math.cos(42 * D2R), 200 * Math.sin(42 * D2R));
  const player = { x: 0, y: 0 };
  const candidates = environmentCandidatesInRange([edge, far], player);
  assert.deepEqual(ids(candidates).sort(), [1, 2], "both are distance candidates");
  const admitted = ids(selectEnvironmentAdmission(candidates, yawPlanes(0), spheresFor([edge, far])));
  assert.ok(admitted.includes(1), "the edge row survives small turns");
  assert.ok(!admitted.includes(2), "the slack is a band, not a second scene");
});

test("residents outlive candidates by one hysteresis band", () => {
  const player = { x: 0, y: 0 };
  const objects = [
    placement("near", ENVIRONMENT_RANGE - 10, 0),
    placement("gap", ENVIRONMENT_RANGE + 20, 0),
    placement("out", ENVIRONMENT_RANGE + 200, 0),
  ];
  assert.deepEqual(ids(environmentCandidatesInRange(objects, player)), ["near"]);
  assert.deepEqual(ids(environmentResidentsInRange(objects, player)).sort(), ["gap", "near"],
    "load/unload boundaries differ by the hysteresis band");
});

test("prefetch selection is deterministic, rotating, budgeted and gated", () => {
  const player = { x: 0, y: 0 };
  const objects = Array.from({ length: 40 }, (_, index) => tree(index, 50 + index * 5, 0));
  const candidates = environmentCandidatesInRange(objects, player);
  const none = () => false;
  const first = selectPrefetchModels(candidates, none, 0);
  assert.deepEqual(selectPrefetchModels(candidates, none, 0), first, "same inputs, same answer");
  assert.ok(first.names.length <= 32, "per-frame budget holds");
  assert.equal(new Set(first.names).size, first.names.length, "names deduplicated");
  // Rotation covers everything eventually: walk the cursor until it wraps.
  const seen = new Set(first.names);
  let cursor = first.nextCursor;
  for (let round = 0; round < 10 && seen.size < 40; round++) {
    const scan = selectPrefetchModels(candidates, (id) => seen.has(`World\\Trees\\Pine${id}.m2`), cursor);
    for (const name of scan.names) seen.add(name);
    cursor = scan.nextCursor;
  }
  assert.equal(seen.size, 40, "rotation reaches every needy candidate");
  // Gates: far castles never prefetch; far vegetation does; content is skipped.
  const castle = {
    id: "castle", kind: "wmo", name: "World\\Wmo\\Castle.wmo", x: 500, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
    bounds: { minX: 430, minY: -70, minZ: 0, maxX: 570, maxY: 70, maxZ: 40 },
  };
  const pine = tree("pine", 500, 50);
  const gated = environmentCandidatesInRange([castle, pine], player);
  assert.deepEqual(ids(gated).sort(), ["castle", "pine"].sort());
  const picked = selectPrefetchModels(gated, none, 0).names;
  assert.ok(!picked.includes(castle.name), "a 26 MB city model is fetched on admission, not speculatively");
  assert.ok(picked.includes(pine.name), "far vegetation warms (small shared models)");
  assert.deepEqual(selectPrefetchModels(gated, () => true, 0).names, [],
    "nothing to warm means no requests");
  assert.deepEqual(selectPrefetchModels([], none, 0), { names: [], nextCursor: 0 });
  assert.deepEqual(selectPrefetchModels(gated, none, 0, 0, 32).names, [],
    "a zero scan warms nothing");
  const shared = [
    tree(1000, 60, 0, { name: "World\\Trees\\OakShared.m2" }),
    tree(1001, 70, 0, { name: "World\\Trees\\OakShared.m2" }),
  ];
  const sharedCandidates = environmentCandidatesInRange(shared, player);
  assert.deepEqual(selectPrefetchModels(sharedCandidates, none, 0).names,
    ["World\\Trees\\OakShared.m2"], "one shared model queues one request");
});

test("prefetch visits every off-screen model even when none has a rendered node", () => {
  for (const count of [40, 256, 768]) {
    const candidates = environmentCandidatesInRange(
      Array.from({ length: count }, (_, id) => tree(id, 50 + id % 100, 0)),
      { x: 0, y: 0 },
    );
    const seen = new Set();
    let cursor = 0;
    for (let round = 0; round < Math.ceil(count / 32); round++) {
      // Decoding a prefetched model does not create a renderer node. The production predicate
      // remains false until the camera actually admits that placement.
      const scan = selectPrefetchModels(candidates, () => false, cursor);
      for (const name of scan.names) seen.add(name);
      cursor = scan.nextCursor;
    }
    assert.equal(seen.size, count, 'every off-screen model is visited within one bounded sweep');
  }
});

test("a 180-degree snap finds warmed models instead of cold-fetching the wedge", () => {
  // Small dense field with unique models (worst case: no name dedupe help).
  const objects = [];
  let id = 0;
  for (let gx = -300; gx <= 300; gx += 60) {
    for (let gy = -300; gy <= 300; gy += 60) {
      objects.push(tree(id++, gx, gy));
    }
  }
  const player = { x: 0, y: 0 };
  const spheres = spheresFor(objects);
  const candidates = environmentCandidatesInRange(objects, player);
  // Stand facing east for a while: prefetch sweeps the position-circular set.
  const warmed = new Set();
  const byId = new Map(objects.map((object) => [object.id, object.name]));
  let cursor = 0;
  for (let round = 0; round < 12; round++) {
    const scan = selectPrefetchModels(candidates, (candidateId) => warmed.has(byId.get(candidateId)), cursor);
    for (const name of scan.names) warmed.add(name);
    cursor = scan.nextCursor;
  }
  const snap = (yaw) => new Set(ids(selectEnvironmentAdmission(candidates, yawPlanes(yaw), spheres)));
  const before = snap(0);
  const after = snap(Math.PI);
  const firstSights = [...after].filter((entry) => !before.has(entry));
  assert.ok(firstSights.length > 0, "the snap really reveals unseen placements");
  const cold = firstSights.filter((entry) => {
    const object = objects.find((candidate) => candidate.id === entry);
    return !warmed.has(object.name);
  });
  assert.deepEqual(cold, [], "every revealed model was warmed while facing away");
});

test("repeated sweeps do not grow the resident set", () => {
  const objects = [];
  let id = 0;
  for (let gx = -500; gx <= 500; gx += 50) {
    for (let gy = -500; gy <= 500; gy += 50) {
      objects.push((id % 3 === 0 ? tree : placement)(id++, gx, gy));
    }
  }
  const player = { x: 0, y: 0 };
  const peaks = [];
  for (let sweep = 0; sweep < 3; sweep++) {
    let peak = 0;
    for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const residents = environmentResidentsInRange(objects, player);
      const admitted = selectEnvironmentAdmission(
        environmentCandidatesInRange(objects, player), yawPlanes(yaw), spheresFor(objects));
      peak = Math.max(peak, residents.length, admitted.length);
    }
    peaks.push(peak);
  }
  assert.deepEqual(peaks, [peaks[0], peaks[0], peaks[0]], "no accumulation across sweeps");
});

test("the renderer retains the wider resident set and warms ahead", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /objectsAround\(world\.mapId, position\.x, position\.y, ENVIRONMENT_STREAM_RANGE\)/,
    "the placement pool covers the far tier and its resident band");
  assert.match(source, /this\.#environmentResidents = environmentResidentsInRange\(pool, player, this\.#environmentDetail\);/,
    "residents are computed from the wide pool on reselect, like candidates");
  // The actual disposal/admission decisions are exercised through #updateEnvironment in
  // environment-membership-cache.test.mjs. This test covers the wider source and prefetch path.
  assert.match(source, /this\.#prefetchEnvironmentModels\(client\);/,
    "near off-screen models warm every frame without building anything");
  const prefetch = source.slice(source.indexOf("  #prefetchEnvironmentModels(client:"),
    source.indexOf("  #updateVegetationGrowth(client:"));
  assert.match(prefetch, /const candidates = this\.#environmentResidents;/,
    "small models warm in the band before their draw leash");
  assert.doesNotMatch(prefetch, /this\.#prefetchCursor = 0;/,
    "walking must not restart a dense sweep at its first candidate");
  assert.ok(prefetch.indexOf("client.retainModelPrefetch(") < prefetch.indexOf("this.#submissionSerial & 3"),
    "skipped scans still renew pending background demand");
  assert.match(prefetch, /for \(const name of names\) client\.prefetchModel\(name\);/,
    "speculative loads use the unpinned background queue");
});

test("prefetch warms the approach band without increasing draw admission", () => {
  const objects = [
    placement(1, ENVIRONMENT_RANGE + 20, 0),
    tree(2, 620, 0),
    placement(3, 90, 0, { interior: true }),
    placement(4, ENVIRONMENT_RANGE + ENVIRONMENT_RESIDENT_HYSTERESIS + 1, 0),
    tree(5, 661, 0),
    placement(6, 121, 0, { interior: true }),
  ];
  const player = { x: 0, y: 0 };
  assert.deepEqual(environmentCandidatesInRange(objects, player), [], "the extra band is not drawn");
  const residents = environmentResidentsInRange(objects, player);
  assert.deepEqual(selectPrefetchModels(residents, () => false, 0).names,
    objects.slice(0, 3).map(object => object.name));
});
