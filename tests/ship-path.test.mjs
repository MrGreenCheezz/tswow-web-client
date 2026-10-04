import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 11.01 slice A1, the gateway half: gateway/TransportShipPaths.ts ports TransportMgr::GeneratePath
// (TransportMgr.cpp:122-355) and Transport::Update/CalculateSegmentPos (Transport.cpp:133-219,
// 584-613) and bakes the cycle every 100 ms for GET /dbc/ship-paths. The properties: the period is
// the sum of the stop-to-stop spans under the trapezoidal speed profile plus every stop's delay
// (that is the GAMEOBJECT_LEVEL the browser checks against); the ship never moves faster than its
// speed on an evenly spaced path; it stands still while it waits; the track is continuous except
// across a jump (a map change, a Flags & 1 node, the cycle's end). Nothing here talks to the
// running gateway: the route is called as a function and through a handler on 127.0.0.1 port 0.
const ships = await import("../dist/code/gateway/TransportShipPaths.js");
const { createGatewayAssetHandler } = await import("../dist/code/gateway/Gateway.js");

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const ORIGIN = "http://127.0.0.1:5173";
const STOP = 2;

/** One TaxiPathNode row; positions as single-precision values, which the DBC holds. */
function node(pathId, nodeIndex, mapId, x, y, z, flags = 0, delay = 0) {
  return {
    pathId, nodeIndex, mapId, x: Math.fround(x), y: Math.fround(y), z: Math.fround(z),
    flags, delay, arrivalEventId: 0, departureEventId: 0,
  };
}

/** Twelve nodes 100 yards apart along +x, stops (10 s) at nodes 3 and 8. */
function straightPath() {
  return Array.from({ length: 12 }, (_, i) =>
    node(1, i, 0, 1000 + i * 100, 500, 20, i === 3 || i === 8 ? STOP : 0, i === 3 || i === 8 ? 10 : 0));
}

/** The textbook trapezoid: accelerate, cruise, brake over `distance`; a triangle when too short. */
function spanSeconds(distance, speed, accel) {
  const accelDist = 0.5 * speed * speed / accel;
  return distance < 2 * accelDist ? 2 * Math.sqrt(distance / accel) : distance / speed + speed / accel;
}

/**
 * The period recomputed from the key frames' distances alone: stop to stop around the cycle (the
 * first frame stands in for a stop on a path without one, as `firstStop = lastStop = 0` does).
 */
function expectedPeriodMs(model) {
  const frames = model.keyFrames;
  const stops = frames.flatMap((frame, index) => (frame.node.flags === STOP ? [index] : []));
  const anchors = stops.length > 0 ? stops : [0];
  let seconds = 0;
  for (let s = 0; s < anchors.length; s++) {
    const from = anchors[s];
    const to = anchors[(s + 1) % anchors.length];
    let distance = 0;
    let k = from;
    do {
      k = (k + 1) % frames.length;
      distance += frames[k].distFromPrev;
    } while (k !== to);
    seconds += spanSeconds(distance, model.speed, model.accel);
  }
  for (const index of stops) seconds += frames[index].node.delay;
  return seconds * 1000;
}

function sampleDistance(track, i) {
  const j = i + 1;
  return Math.hypot(track.x[j] - track.x[i], track.y[j] - track.y[i], track.z[j] - track.z[i]);
}

test("the period is the stop-to-stop spans under the speed profile plus the stop delays", () => {
  // speed 10, accel 1: 50 yards to reach speed, so both spans (500 and 400 yards) cruise.
  const cruising = ships.generateShipPath(straightPath(), 10, 1);
  // The end nodes are spline guards and go (TransportMgr.cpp:171-180): ten frames for twelve nodes.
  assert.equal(cruising.keyFrames.length, 10);
  assert.deepEqual(cruising.keyFrames.map((frame) => frame.distFromPrev), [0, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
  // 500/10 + 10 + 400/10 + 10 + 2 × 10 s of waiting.
  assert.equal(cruising.pathTime, 130_000);
  assert.ok(Math.abs(cruising.pathTime - expectedPeriodMs(cruising)) <= 2);

  // speed 30, accel 1: 450 yards to reach speed, so both spans are triangles — 2√(D/a).
  const short = ships.generateShipPath(straightPath(), 30, 1);
  const triangles = (2 * Math.sqrt(500) + 2 * Math.sqrt(400) + 20) * 1000;
  assert.ok(Math.abs(short.pathTime - triangles) <= 2, `${short.pathTime} vs ${triangles}`);
  assert.equal(short.pathTime, short.keyFrames.at(-1).departureTime);
});

test("an evenly spaced path never runs faster than its speed and stands still at a stop", () => {
  const model = ships.generateShipPath(straightPath(), 10, 1);
  const track = ships.bakeShipTrack(model, 1);
  assert.equal(track.period, 130_000);
  assert.equal(track.step, 100);
  assert.equal(track.x.length, 1300);
  let fastest = 0;
  let fastestAnywhere = 0;
  let stopSamples = 0;
  for (let i = 0; i + 1 < track.x.length; i++) {
    if (track.flags[i] & ships.SHIP_SAMPLE_CUT) continue;
    const speed = sampleDistance(track, i) / 0.1;
    fastestAnywhere = Math.max(fastestAnywhere, speed);
    // A leg's first and last segments are not evenly parameterised: `InitCatmullRom` puts the
    // virtual point one yard behind the first node and repeats the last (Spline.cpp:246-259), so
    // the core's linear distance-to-parameter mapping runs a little fast there. Between them the
    // spline is the straight line at uniform parameter speed.
    if (track.x[i] >= 1200 && track.x[i + 1] <= 1900) fastest = Math.max(fastest, speed);
    if (track.flags[i] & ships.SHIP_SAMPLE_STOP) {
      stopSamples++;
      if (track.flags[i + 1] & ships.SHIP_SAMPLE_STOP) assert.equal(sampleDistance(track, i), 0, `moving at stop sample ${i}`);
    }
  }
  assert.ok(fastest <= 10 + 1e-3, `fastest ${fastest} yd/s`);
  assert.ok(fastest > 9.9, `the cruise reaches its speed: ${fastest}`);
  assert.ok(fastestAnywhere <= 10 * 1.2, `fastest at a leg's end ${fastestAnywhere} yd/s`);
  // Two 10 s waits, sampled every 100 ms.
  assert.ok(stopSamples >= 198 && stopSamples <= 202, `${stopSamples} stop samples`);
  // Waiting where the node is.
  const firstStop = track.flags.findIndex((flags) => flags & ships.SHIP_SAMPLE_STOP);
  assert.equal(track.x[firstStop], 1300);
  // The only jump is the cycle's own end (last frame to first).
  const cuts = track.flags.flatMap((flags, i) => (flags & ships.SHIP_SAMPLE_CUT ? [i] : []));
  assert.deepEqual(cuts, [track.x.length - 1]);
  // Facing: ship models face backwards along the path, atan2 + π (Transport.cpp:210-212).
  const moving = track.flags.findIndex((flags, i) => i > firstStop && !(flags & ships.SHIP_SAMPLE_STOP));
  assert.ok(Math.abs(track.o[moving + 5] - Math.PI) < 1e-3, `facing ${track.o[moving + 5]}`);
});

test("a map change or a Flags & 1 node is a jump: the track is continuous everywhere else", () => {
  const nodes = [
    ...Array.from({ length: 6 }, (_, i) => node(2, i, 0, i * 100, 0, 0, i === 2 ? STOP : 0, i === 2 ? 5 : 0)),
    ...Array.from({ length: 6 }, (_, i) => node(2, 6 + i, 1, 5000, i * 100, 0, i === 3 ? STOP : 0, i === 3 ? 5 : 0)),
  ];
  const model = ships.generateShipPath(nodes, 20, 2);
  // Node 5 (the last on map 0) and node 6 (the first on map 1) are guards; node 4's frame jumps.
  assert.deepEqual(model.keyFrames.map((frame) => frame.node.nodeIndex), [1, 2, 3, 4, 7, 8, 9, 10]);
  assert.deepEqual(model.keyFrames.map((frame) => frame.teleport), [false, false, false, true, false, false, false, true]);
  assert.ok(Math.abs(model.pathTime - expectedPeriodMs(model)) <= 2);
  const track = ships.bakeShipTrack(model, 2);
  assert.deepEqual([...new Set(track.map)].sort(), [0, 1]);
  const cuts = track.flags.flatMap((flags, i) => (flags & ships.SHIP_SAMPLE_CUT ? [i] : []));
  assert.equal(cuts.length, 2);
  assert.equal(cuts.at(-1), track.x.length - 1);
  assert.notEqual(track.map[cuts[0]], track.map[cuts[0] + 1], "the first cut is the map change");
  for (let i = 0; i + 1 < track.x.length; i++) {
    if (track.flags[i] & ships.SHIP_SAMPLE_CUT) continue;
    // 20 yd/s, with the leg-end allowance of the test above.
    assert.ok(sampleDistance(track, i) <= 20 * 0.1 * 1.2, `continuous at ${i}: ${sampleDistance(track, i)}`);
  }

  // The same path on one map with node 5 flagged 1: a jump without a map change.
  const flagged = nodes.map((row) => (row.nodeIndex === 5 ? { ...row, flags: 1 } : { ...row, mapId: 0 }));
  const sameMap = ships.generateShipPath(flagged, 20, 2);
  assert.deepEqual(sameMap.keyFrames.map((frame) => frame.teleport), [false, false, false, true, false, false, false, true]);
  const sameTrack = ships.bakeShipTrack(sameMap, 2);
  assert.equal(sameTrack.flags.filter((flags) => flags & ships.SHIP_SAMPLE_CUT).length, 2);
});

test("review: a very long cycle is sampled more sparsely, never past SHIP_TRACK_MAX_SAMPLES", () => {
  // speed 1 and hour-long waits: a cycle of 6 922 s, 69 220 samples at 100 ms. The route accepts
  // any speed from 1, so this is what one request could otherwise make the gateway bake and hold.
  const nodes = straightPath().map((row) => (row.flags === STOP ? { ...row, delay: 3000 } : row));
  const model = ships.generateShipPath(nodes, 1, 1);
  assert.ok(model.pathTime > ships.SHIP_TRACK_MAX_SAMPLES * ships.SHIP_PATH_STEP_MS, `${model.pathTime}`);
  const track = ships.bakeShipTrack(model, 1);
  assert.ok(track.x.length <= ships.SHIP_TRACK_MAX_SAMPLES, `${track.x.length} samples`);
  assert.equal(track.x.length, Math.ceil(track.period / track.step));
  assert.equal(track.period, model.pathTime, "the period is the server's whatever the spacing");
  assert.ok(track.step > ships.SHIP_PATH_STEP_MS);
  // An ordinary cycle keeps the 100 ms spacing.
  assert.equal(ships.bakeShipTrack(ships.generateShipPath(straightPath(), 10, 1), 1).step, ships.SHIP_PATH_STEP_MS);
});

test("a path the core cannot build is a refusal, not a crash", () => {
  const paths = new Map([[3, [node(3, 0, 0, 0, 0, 0)]]]);
  assert.match(ships.shipTrackFor(paths, 3, 30, 1).error, /two nodes/);
  assert.match(ships.shipTrackFor(paths, 4, 30, 1).error, /no path 4/);
  assert.throws(() => ships.generateShipPath(straightPath(), 30, 0), ships.ShipPathError);
});

/** A WDBC image of TaxiPathNode rows, "diiifffiiii" (DBCfmt.h:136) unless told otherwise. */
function taxiPathNodeDbc(rows, { fields = 11, recordSize = 44 } = {}) {
  const data = Buffer.alloc(20 + rows.length * recordSize + 1);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => {
    const at = 20 + index * recordSize;
    if (recordSize < 44) return;
    data.writeInt32LE(index + 1, at);
    data.writeInt32LE(row.pathId, at + 4);
    data.writeInt32LE(row.nodeIndex, at + 8);
    data.writeInt32LE(row.mapId, at + 12);
    data.writeFloatLE(row.x, at + 16);
    data.writeFloatLE(row.y, at + 20);
    data.writeFloatLE(row.z, at + 24);
    data.writeInt32LE(row.flags, at + 28);
    data.writeInt32LE(row.delay, at + 32);
  });
  return data;
}

function fakeExchange(path, origin = ORIGIN) {
  const url = new URL(`http://127.0.0.1${path}`);
  const request = { method: "GET", headers: origin ? { origin } : {} };
  const response = {
    status: undefined, headers: undefined, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(body) { this.body = body; return this; },
  };
  return { url, request, response };
}

test("GET /dbc/ship-paths: Origin, version, parameters, memo, no-store, refusal and a failed read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ship-paths-"));
  try {
    await writeFile(join(directory, "TaxiPathNode.dbc"), taxiPathNodeDbc(straightPath()));
    const cache = new Map();
    const options = { dbcDirectory: directory, allowedOrigins: [ORIGIN] };
    const serve = async (path, origin) => {
      const { url, request, response } = fakeExchange(path, origin);
      const handled = await ships.serveShipPathRoute(request, response, url, cache, options);
      return { handled, ...response };
    };

    assert.equal((await serve("/dbc/other?v=1")).handled, false);
    assert.equal((await serve("/dbc/ship-paths?v=1&path=1&speed=10&accel=1", "http://evil.test")).status, 403);
    assert.equal((await serve("/dbc/ship-paths?v=2&path=1&speed=10&accel=1")).status, 400);
    assert.equal((await serve("/dbc/ship-paths?v=1&path=1&speed=0&accel=1")).status, 400);
    assert.equal((await serve("/dbc/ship-paths?v=1&path=x&speed=10&accel=1")).status, 400);

    const ok = await serve("/dbc/ship-paths?v=1&path=1&speed=10&accel=1");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
    const track = JSON.parse(ok.body);
    assert.equal(track.version, ships.SHIP_PATHS_VERSION);
    assert.equal(track.period, 130_000);
    assert.equal(track.x.length, 1300);
    assert.equal(cache.size, 1, "memoised under its parameters");
    assert.equal((await serve("/dbc/ship-paths?v=1&path=1&speed=10&accel=1")).body, ok.body);

    const refused = JSON.parse((await serve("/dbc/ship-paths?v=1&path=9&speed=10&accel=1")).body);
    assert.match(refused.error, /no path 9/);

    // A table of another layout: 500, and the memo is dropped so a rebuilt file is read next time.
    const broken = await mkdtemp(join(tmpdir(), "ship-paths-broken-"));
    try {
      await writeFile(join(broken, "TaxiPathNode.dbc"), taxiPathNodeDbc(straightPath(), { fields: 10, recordSize: 40 }));
      const brokenCache = new Map();
      const { url, request, response } = fakeExchange("/dbc/ship-paths?v=1&path=1&speed=10&accel=1");
      await ships.serveShipPathRoute(request, response, url, brokenCache, { dbcDirectory: broken, allowedOrigins: [ORIGIN] });
      assert.equal(response.status, 500);
      assert.equal(brokenCache.size, 0);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the route is wired into the gateway handler, memoised with the dataset's catalogs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ship-paths-gateway-"));
  const { createServer } = await import("node:http");
  try {
    await writeFile(join(directory, "TaxiPathNode.dbc"), taxiPathNodeDbc(straightPath()));
    const assets = await createGatewayAssetHandler({
      host: "127.0.0.1", port: 0,
      auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
      allowedOrigins: [ORIGIN], dbcDirectory: directory, datasetPollMs: 3_600_000,
    });
    const server = createServer(assets.handle);
    await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(`${base}/dbc/ship-paths?v=1&path=1&speed=10&accel=1`, { headers: { origin: ORIGIN } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).period, 130_000);
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
      assets.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real TaxiPathNode paths: cross-continent tracks change map, periods add up", { skip: !existsSync(join(DATASET_DBC, "TaxiPathNode.dbc")) && "no dataset DBC" }, async () => {
  const paths = await ships.loadTaxiPathNodes(DATASET_DBC);
  assert.ok(paths.size > 100, `${paths.size} paths`);
  // A handful, not all 911: three that cross a continent and two with stops on one map.
  const crossing = [...paths].filter(([, nodes]) => new Set(nodes.map((row) => row.mapId)).size > 1).map(([id]) => id);
  const stopping = [...paths]
    .filter(([, nodes]) => new Set(nodes.map((row) => row.mapId)).size === 1 && nodes.some((row) => row.flags === STOP))
    .map(([id]) => id);
  assert.ok(crossing.length >= 3 && stopping.length >= 2);
  for (const id of [...crossing.slice(0, 3), ...stopping.slice(0, 2)]) {
    const model = ships.generateShipPath(paths.get(id), 30, 1);
    assert.ok(Math.abs(model.pathTime - expectedPeriodMs(model)) <= 2, `path ${id}: ${model.pathTime} vs ${expectedPeriodMs(model)}`);
    const track = ships.bakeShipTrack(model, id);
    const maps = new Set(track.map);
    if (crossing.includes(id)) assert.ok(maps.size >= 2, `path ${id} visits ${[...maps]}`);
    let moved = 0;
    for (let i = 0; i + 1 < track.x.length; i++) {
      if (track.flags[i] & ships.SHIP_SAMPLE_CUT) continue;
      assert.equal(track.map[i], track.map[i + 1], `path ${id}: a map change without a cut at ${i}`);
      const step = sampleDistance(track, i);
      moved += step;
      if ((track.flags[i] & ships.SHIP_SAMPLE_STOP) && (track.flags[i + 1] & ships.SHIP_SAMPLE_STOP)) assert.equal(step, 0);
      // The core maps distance onto the spline parameter linearly per segment
      // (CalculateSegmentPos), so on unevenly spaced nodes the ship runs locally faster than its
      // speed — up to 2.4× in this dataset (path 733). Faithful to the server, bounded here.
      assert.ok(step <= 30 * 0.1 * 3, `path ${id}: ${step / 0.1} yd/s at ${i}`);
    }
    assert.ok(moved > 0);
  }
});
