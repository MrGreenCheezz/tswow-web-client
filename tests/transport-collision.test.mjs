import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 11.01 slice A2: game-object collision. The gateway reads vmaps/GameObjectModels.dtree
// (LoadGameObjectModelList, GameObjectModel.cpp:44-95) for GET /vmap/gobject-models; the browser
// keeps one CollisionWorld per carrier in the carrier's own frame. The core places a game object's
// model as iPos + iScale·Rz(o)·v with no vmap mirror (GameObjectModel.cpp:124-137, 174-175), so the
// local mesh is scale·v — the frame passenger offsets live in (TransportMath). Every check against
// "the core" below builds that world mesh independently, by the core's formula, and compares.
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { parseVMapModelGroups } from "../dist/code/gateway/VMapModel.js";
import {
  GAME_OBJECT_MODELS_VERSION, gameObjectModelsFor, loadGameObjectModels, parseDisplayIds, parseGameObjectModels,
  serveGameObjectModelsRoute,
} from "../dist/code/gateway/GameObjectModels.js";
import { CollisionMesh, CollisionWorld, transformCollisionMesh } from "../dist/code/browser/game/Collision.js";
import {
  TransportCollision, gameObjectLocalPlacement, toCarrierLocal, toCarrierWorld,
} from "../dist/code/browser/game/TransportCollision.js";
import { GameObjectCollisionModels, gameObjectModelsFrom } from "../dist/code/browser/game/GameObjectCollisionModels.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

const VMAPS = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/vmaps";
const ORIGIN = "http://127.0.0.1:5173";
const withVmaps = { skip: existsSync(join(VMAPS, "GameObjectModels.dtree")) ? false : "no dataset vmaps on this machine" };

// ---------------------------------------------------------------------------------------------
// Fixtures.

/** A quad as two triangles, counter-clockwise seen from +z for a floor. */
function quad(vertices, indices, a, b, c, d) {
  const base = vertices.length / 3;
  vertices.push(...a, ...b, ...c, ...d);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function group(vertices, indices, flags = 0, groupId = 0) {
  const v = Float32Array.from(vertices);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]);
    minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1]);
    minZ = Math.min(minZ, v[i + 2]); maxZ = Math.max(maxZ, v[i + 2]);
  }
  return { bounds: { minX, minY, minZ, maxX, maxY, maxZ }, flags, groupId, vertices: v, indices: Uint32Array.from(indices) };
}

/**
 * A carrier lopsided along its keel, so a mirrored or turned mesh cannot pass for it: a deck at
 * z = 2 over x ∈ [−10, 10], y ∈ [−4, 4]; a roof at z = 6 over x, y ∈ [−2, 2]; one wall, at x = +8.
 */
function syntheticCarrierGroups() {
  const deck = [], deckIndices = [];
  quad(deck, deckIndices, [-10, -4, 2], [10, -4, 2], [10, 4, 2], [-10, 4, 2]);
  quad(deck, deckIndices, [-2, -2, 6], [2, -2, 6], [2, 2, 6], [-2, 2, 6]);
  const wall = [], wallIndices = [];
  quad(wall, wallIndices, [8, -4, 2], [8, 4, 2], [8, 4, 7], [8, -4, 7]);
  return [group(deck, deckIndices, 0x8, 11), group(wall, wallIndices, 0x8, 12)];
}

/** The wire round trip the browser gets; `include` as the gateway's budget would choose. */
function wireModel(groups, include) {
  return decodeCollisionModel(encodeCollisionModel(groups, include).slice().buffer);
}

/** The core's own placement: world = pos + scale · Rz(o) · v, no mirror (GameObjectModel.cpp). */
function coreWorldMesh(groups, pose, scale) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const world = new CollisionWorld();
  groups.forEach((g, index) => {
    const triangles = new Float32Array(g.indices.length * 3);
    for (let i = 0; i < g.indices.length; i++) {
      const v = g.indices[i] * 3;
      const x = g.vertices[v] * scale, y = g.vertices[v + 1] * scale, z = g.vertices[v + 2] * scale;
      triangles[i * 3] = pose.x + x * cos - y * sin;
      triangles[i * 3 + 1] = pose.y + x * sin + y * cos;
      triangles[i * 3 + 2] = pose.z + z;
    }
    world.set(index, new CollisionMesh(triangles));
  });
  return world;
}

function fakeSource(model, revision = 0) {
  const requests = [];
  return {
    revision,
    model: () => model,
    requestGroups(displayId, groups) { requests.push([displayId, [...groups]]); },
    requests,
  };
}

const POSES = [
  { x: 0, y: 0, z: 0, orientation: 0 },
  { x: 1234.5, y: -567.25, z: 40, orientation: 0.7 },
  { x: -3000, y: 1500, z: 120.5, orientation: 2.3 },
  { x: 10, y: 10, z: -3, orientation: 5.9 },
];
const RADIUS = 0.5;
const BODY = 2;
const STEP = 1;

// ---------------------------------------------------------------------------------------------
// The local frame.

test("the 180° placement turns transformCollisionMesh into scale·v (the mirror cancels)", () => {
  const vertices = Float32Array.from([3, -1, 2, -7, 5, 0.5, 11, 2, -4]);
  const indices = Uint32Array.from([0, 1, 2]);
  for (const scale of [1, 1.5, 0.25]) {
    const local = transformCollisionMesh(vertices, indices, gameObjectLocalPlacement(scale));
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(local[i] - scale * vertices[i]) < 1e-5, `component ${i} at scale ${scale}`);
  }
  // A bad OBJECT_FIELD_SCALE_X (0, NaN) is the core's default 1, not a collapsed mesh.
  assert.equal(gameObjectLocalPlacement(0).scale, 1);
  assert.equal(gameObjectLocalPlacement(Number.NaN).scale, 1);
});

test("toCarrierLocal/toCarrierWorld are inverse and match the passenger compose", () => {
  const out = { x: 0, y: 0, z: 0 };
  for (const pose of POSES) {
    const world = toCarrierWorld(pose, 3, -2, 1.5, { x: 0, y: 0, z: 0 });
    const cos = Math.cos(pose.orientation), sin = Math.sin(pose.orientation);
    assert.ok(Math.abs(world.x - (pose.x + 3 * cos + 2 * sin)) < 1e-9);
    assert.ok(Math.abs(world.y - (pose.y + 3 * sin - 2 * cos)) < 1e-9);
    toCarrierLocal(pose, world.x, world.y, world.z, out);
    assert.ok(Math.abs(out.x - 3) < 1e-9 && Math.abs(out.y + 2) < 1e-9 && Math.abs(out.z - 1.5) < 1e-9);
  }
});

test("synthetic carrier: floorHitUnder, pushOut and ceilingAbove work locally and agree with the core's world placement at every pose", () => {
  const groups = syntheticCarrierGroups();
  const scale = 1.5;
  const collision = new TransportCollision(fakeSource(wireModel(groups)));
  const local = collision.carrier(7n, 4242, scale);
  assert.ok(local instanceof CollisionWorld);
  assert.equal(local.size, 2);
  assert.equal(collision.isComplete(7n), true);

  // Local answers, in yards of the carrier's frame: deck at 2·scale, roof at 6·scale, wall at +8·scale.
  const floor = local.floorHitUnder(3, 1, 4, -10);
  assert.ok(Math.abs(floor.z - 2 * scale) < 1e-4);
  assert.equal(floor.groupId, 11);
  assert.equal(floor.flags, 0x8);
  assert.ok(Math.abs(local.ceilingAbove(0, 0, 2 * scale + 0.1, 20) - 6 * scale) < 1e-4);
  assert.equal(local.ceilingAbove(5, 0, 2 * scale + 0.1, 20), undefined, "no roof away from the middle");
  const pushed = local.pushOut(8 * scale - 0.2, 0, 2 * scale, RADIUS, BODY, STEP);
  assert.ok(Math.abs(pushed.x - (8 * scale - RADIUS)) < 1e-3, `pushed to ${pushed.x}`);
  assert.equal(local.floorUnder(-8 * scale + 0.1, 0, 20, -10) !== undefined, true);

  const at = { x: 0, y: 0, z: 0 };
  for (const pose of POSES) {
    const core = coreWorldMesh(groups, pose, scale);
    // The same world point asked of both: the local answer composed back equals the core's.
    for (const [lx, ly] of [[3, 1], [-12, 3], [11.5, -5]]) {
      const world = toCarrierWorld(pose, lx, ly, 4 * scale, { x: 0, y: 0, z: 0 });
      toCarrierLocal(pose, world.x, world.y, world.z, at);
      const localZ = local.floorUnder(at.x, at.y, at.z, -10);
      const coreZ = core.floorUnder(world.x, world.y, world.z, pose.z - 10);
      assert.ok(localZ !== undefined && coreZ !== undefined, `floor at ${lx},${ly}`);
      assert.ok(Math.abs(pose.z + localZ - coreZ) < 1e-3, `pose ${pose.orientation}: ${pose.z + localZ} vs ${coreZ}`);
    }
    const head = toCarrierWorld(pose, 0.5, 0.5, 2 * scale + 0.1, { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(pose.z + local.ceilingAbove(0.5, 0.5, 2 * scale + 0.1, 20) - core.ceilingAbove(head.x, head.y, head.z, head.z + 20)) < 1e-3);
    // Against the wall: pushed out the same way in both frames.
    const body = toCarrierWorld(pose, 8 * scale - 0.2, 1, 2 * scale, { x: 0, y: 0, z: 0 });
    const corePushed = core.pushOut(body.x, body.y, body.z, RADIUS, BODY, STEP);
    toCarrierLocal(pose, corePushed.x, corePushed.y, body.z, at);
    const localPushed = local.pushOut(8 * scale - 0.2, 1, 2 * scale, RADIUS, BODY, STEP);
    assert.ok(Math.abs(at.x - localPushed.x) < 1e-3 && Math.abs(at.y - localPushed.y) < 1e-3, `pose ${pose.orientation}`);
  }
});

test("carrier lifecycle: loading, no model, groups asked for, rebuilt on scale/display id, released", () => {
  const groups = syntheticCarrierGroups();
  let current;
  const source = {
    revision: 0,
    model: () => current,
    requests: [],
    requestGroups(displayId, wanted) { this.requests.push([displayId, [...wanted]]); },
  };
  const collision = new TransportCollision(source);
  assert.equal(collision.carrier(1n, 100, 1), undefined, "nothing yet");
  current = null;
  source.revision++;
  assert.equal(collision.carrier(1n, 100, 1), null, "the core gives this display id no collision");
  assert.equal(collision.size, 0);

  // Over the budget: group boxes only, the geometry asked for, nothing solid yet.
  current = wireModel(groups, new Set());
  source.revision++;
  assert.equal(collision.carrier(1n, 100, 1), undefined);
  assert.deepEqual(source.requests, [[100, [0, 1]]]);
  assert.equal(collision.isComplete(1n), false);
  // The groups land in place (CollisionClient.#fetchGroups writes them into the same model).
  const full = wireModel(groups);
  current.groups[0].vertices = full.groups[0].vertices;
  current.groups[0].indices = full.groups[0].indices;
  source.revision++;
  const partial = collision.carrier(1n, 100, 1);
  assert.equal(partial.size, 1);
  assert.deepEqual(source.requests.at(-1), [100, [1]]);
  current.groups[1].vertices = full.groups[1].vertices;
  current.groups[1].indices = full.groups[1].indices;
  source.revision++;
  const world = collision.carrier(1n, 100, 1);
  assert.equal(world, partial, "the same world, grown");
  assert.equal(world.size, 2);
  assert.equal(collision.isComplete(1n), true);

  // Nothing moved: the same meshes, no rebuild, no request.
  const mesh = world.get(0);
  const asked = source.requests.length;
  assert.equal(collision.carrier(1n, 100, 1).get(0), mesh);
  assert.equal(source.requests.length, asked);

  // OBJECT_FIELD_SCALE_X or the display id changed: a new world at the new size.
  const bigger = collision.carrier(1n, 100, 2);
  assert.notEqual(bigger, world);
  assert.ok(Math.abs(bigger.floorUnder(0, 0, 5, -10) - 4) < 1e-4, "deck at 2 · 2");
  assert.notEqual(collision.carrier(1n, 101, 2), bigger);

  collision.carrier(2n, 100, 1);
  assert.equal(collision.size, 2);
  collision.retain(new Set([2n]));
  assert.equal(collision.size, 1);
  collision.release(2n);
  assert.equal(collision.size, 0);
});

test("forObject reads GAMEOBJECT_DISPLAYID and OBJECT_FIELD_SCALE_X", () => {
  const seen = [];
  const collision = new TransportCollision({
    revision: 0,
    model: (displayId) => { seen.push(displayId); return wireModel(syntheticCarrierGroups()); },
    requestGroups() {},
  });
  const fields = new Map([[UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, 3015]]);
  const object = { guid: 9n, fields };
  assert.ok(Math.abs(collision.forObject(object).floorUnder(0, 0, 3, -10) - 2) < 1e-4, "no scale field: 1");
  const scaleBits = new DataView(new ArrayBuffer(4));
  scaleBits.setFloat32(0, 1.5, true);
  fields.set(UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset, scaleBits.getUint32(0, true));
  assert.ok(Math.abs(collision.forObject(object).floorUnder(0, 0, 4, -10) - 3) < 1e-4, "scale 1.5");
  assert.deepEqual([...new Set(seen)], [3015]);
  assert.equal(collision.forObject({ guid: 10n, fields: new Map() }), null, "no display id");
});

// ---------------------------------------------------------------------------------------------
// The gateway table.

function dtree(rows, { magic = "VMAP_4.8", tail } = {}) {
  const parts = [Buffer.from(magic, "latin1")];
  for (const row of rows) {
    const name = Buffer.from(row.name, "latin1");
    const head = Buffer.alloc(9);
    head.writeUInt32LE(row.displayId, 0);
    head.writeUInt8(row.isWmo ? 1 : 0, 4);
    head.writeUInt32LE(name.length, 5);
    const bounds = Buffer.alloc(24);
    row.bounds.forEach((value, index) => bounds.writeFloatLE(value, index * 4));
    parts.push(head, name, bounds);
  }
  if (tail) parts.push(tail);
  return new Uint8Array(Buffer.concat(parts));
}

const DTREE_ROWS = [
  { displayId: 3015, isWmo: true, name: "Transportship.wmo", bounds: [-58.5, -25.75, -7, 44.5, 27, 59] },
  { displayId: 360, isWmo: false, name: "Elevatorcar.m2", bounds: [-5, -5, -2.5, 5, 5, 13] },
  { displayId: 77, isWmo: false, name: "Broken.m2", bounds: [Number.NaN, 0, 0, 1, 1, 1] },
  { displayId: 78, isWmo: false, name: "Empty.m2", bounds: [0, 0, 0, 0, 0, 0] },
  { displayId: 360, isWmo: false, name: "Second.m2", bounds: [-1, -1, -1, 1, 1, 1] },
];

test("GameObjectModels.dtree: the core's records, NaN and zero boxes skipped, first record wins, a cut tail ends it", () => {
  const table = parseGameObjectModels(dtree(DTREE_ROWS, { tail: Buffer.from([1, 2, 3, 4, 0, 9]) }));
  assert.deepEqual([...table.keys()].sort((a, b) => a - b), [360, 3015]);
  assert.equal(table.get(360).name, "Elevatorcar.m2");
  assert.equal(table.get(360).isWmo, false);
  assert.deepEqual(table.get(3015).bounds, [-58.5, -25.75, -7, 44.5, 27, 59]);
  assert.throws(() => parseGameObjectModels(dtree([], { magic: "VMAP_4.7" })), /wrong header/);
  assert.deepEqual(gameObjectModelsFor(table, [3015, 1, 360]).models.map((row) => row.displayId), [3015, 360]);
  assert.deepEqual(parseDisplayIds("3015,360,3015"), [3015, 360]);
  // Review: the core emplaces a zero-box or nameless record before `initialize` rejects it
  // (GameObjectModel.cpp:91 then :112-116, :118-121), so a later record for that id is ignored too —
  // only a NaN record (`continue` at :85-88, never emplaced) leaves the id free for the next one.
  const claimed = parseGameObjectModels(dtree([
    { displayId: 79, isWmo: false, name: "Zero.m2", bounds: [0, 0, 0, 0, 0, 0] },
    { displayId: 79, isWmo: false, name: "Late.m2", bounds: [-1, -1, -1, 1, 1, 1] },
    { displayId: 80, isWmo: false, name: "", bounds: [-1, -1, -1, 1, 1, 1] },
    { displayId: 80, isWmo: false, name: "Late.m2", bounds: [-1, -1, -1, 1, 1, 1] },
    { displayId: 81, isWmo: false, name: "Nan.m2", bounds: [Number.NaN, 0, 0, 1, 1, 1] },
    { displayId: 81, isWmo: false, name: "After.m2", bounds: [-1, -1, -1, 1, 1, 1] },
  ]));
  assert.deepEqual([...claimed.keys()], [81]);
  assert.equal(claimed.get(81).name, "After.m2");
  for (const bad of [null, "", "0", "1,,2", "x", "4294967296", Array.from({ length: 257 }, (_, i) => i + 1).join(",")]) {
    assert.equal(parseDisplayIds(bad), undefined, String(bad).slice(0, 20));
  }
});

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

test("GET /vmap/gobject-models: Origin, version, ids, memo, no-store and a failed read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gobject-models-"));
  try {
    await writeFile(join(directory, "GameObjectModels.dtree"), dtree(DTREE_ROWS));
    const cache = new Map();
    const options = { vmapsDirectory: directory, allowedOrigins: [ORIGIN] };
    const serve = async (path, origin) => {
      const { url, request, response } = fakeExchange(path, origin);
      const handled = await serveGameObjectModelsRoute(request, response, url, cache, options);
      return { handled, ...response };
    };
    assert.equal((await serve("/vmap/other?v=1&ids=1")).handled, false);
    assert.equal((await serve("/vmap/gobject-models?v=1&ids=3015", "http://evil.test")).status, 403);
    assert.equal((await serve("/vmap/gobject-models?v=2&ids=3015")).status, 400);
    assert.equal((await serve("/vmap/gobject-models?v=1&ids=")).status, 400);
    assert.equal((await serve("/vmap/gobject-models?v=1")).status, 400);

    const ok = await serve("/vmap/gobject-models?v=1&ids=3015,99,360");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
    const answer = JSON.parse(ok.body);
    assert.equal(answer.version, GAME_OBJECT_MODELS_VERSION);
    assert.deepEqual(answer.models.map((row) => [row.displayId, row.name, row.isWmo]), [
      [3015, "Transportship.wmo", true], [360, "Elevatorcar.m2", false],
    ]);
    // Memoised: the file going away does not change the next answer.
    await rm(join(directory, "GameObjectModels.dtree"));
    assert.equal((await serve("/vmap/gobject-models?v=1&ids=3015,99,360")).body, ok.body);

    // A failed read: 500, and the next request reads the disk again.
    const fresh = new Map();
    const { url, request, response } = fakeExchange("/vmap/gobject-models?v=1&ids=3015");
    await serveGameObjectModelsRoute(request, response, url, fresh, options);
    assert.equal(response.status, 500);
    await writeFile(join(directory, "GameObjectModels.dtree"), dtree(DTREE_ROWS));
    const again = fakeExchange("/vmap/gobject-models?v=1&ids=3015");
    await serveGameObjectModelsRoute(again.request, again.response, again.url, fresh, options);
    assert.equal(again.response.status, 200);
    // Without a vmaps directory the route is not this gateway's.
    const none = fakeExchange("/vmap/gobject-models?v=1&ids=3015");
    assert.equal(await serveGameObjectModelsRoute(none.request, none.response, none.url, new Map(), { allowedOrigins: [ORIGIN] }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the route is wired into the gateway handler", async () => {
  const { createGatewayAssetHandler } = await import("../dist/code/gateway/Gateway.js");
  const { createServer } = await import("node:http");
  const directory = await mkdtemp(join(tmpdir(), "gobject-models-gateway-"));
  try {
    await writeFile(join(directory, "GameObjectModels.dtree"), dtree(DTREE_ROWS));
    const assets = await createGatewayAssetHandler({
      host: "127.0.0.1", port: 0,
      auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
      allowedOrigins: [ORIGIN], vmapsDirectory: directory, datasetPollMs: 3_600_000,
    });
    const server = createServer(assets.handle);
    await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(`${base}/vmap/gobject-models?v=1&ids=360`, { headers: { origin: ORIGIN } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).models[0].name, "Elevatorcar.m2");
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
      assets.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The browser loader.

function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length; },
    clearTimeout() {},
  };
}

function fakeGeometry(models = new Map()) {
  return {
    revision: 0,
    asked: [],
    groupRequests: [],
    model(name) { this.asked.push(name); return models.get(name); },
    isResolved(name) { return models.has(name); },
    requestGroups(name, groups) { this.groupRequests.push([name, [...groups]]); },
  };
}

test("GameObjectCollisionModels: one batched request, rows by display id, null for no model, geometry by name", async () => {
  const urls = [];
  const answer = gameObjectModelsFor(parseGameObjectModels(dtree(DTREE_ROWS)), [360, 3015, 5]);
  const fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  const flushes = [];
  const model = wireModel(syntheticCarrierGroups());
  const geometry = fakeGeometry(new Map([["Transportship.wmo", model], ["Elevatorcar.m2", null]]));
  geometry.isResolved = (name) => name === "Transportship.wmo" || name === "Elevatorcar.m2";
  geometry.model = function (name) { this.asked.push(name); return name === "Transportship.wmo" ? model : undefined; };
  const models = new GameObjectCollisionModels(ORIGIN, geometry, { fetch, clock: fakeClock(), schedule: (flush) => flushes.push(flush) });

  assert.equal(models.info(3015), undefined);
  assert.equal(models.info(360), undefined);
  assert.equal(models.info(5), undefined);
  assert.equal(models.info(3015), undefined, "asked once");
  assert.equal(models.info(0), null, "no display id, no model");
  assert.equal(flushes.length, 1, "one flush for the turn");
  const before = models.revision;
  flushes[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(urls, [`${ORIGIN}/vmap/gobject-models?v=1&ids=5,360,3015`]);
  assert.ok(models.revision > before);
  assert.equal(models.info(3015).name, "Transportship.wmo");
  assert.equal(models.info(3015).bounds.minX, -58.5);
  assert.equal(models.info(5), null, "not in the .dtree");
  assert.equal(models.model(3015), model);
  assert.equal(models.model(360), null, "the gateway has no file for it");
  assert.equal(models.model(5), null);
  models.requestGroups(3015, [2, 3]);
  assert.deepEqual(geometry.groupRequests, [["Transportship.wmo", [2, 3]]]);
  assert.equal(urls.length, 1);
});

test("GameObjectCollisionModels against a gateway without the route: nothing solid, one more try, retry() on the next mount", async () => {
  let status = 404;
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    if (status !== 200) return new Response("", { status });
    return new Response(JSON.stringify({ version: 1, models: [] }), { status: 200 });
  };
  const clock = fakeClock();
  const flushes = [];
  const models = new GameObjectCollisionModels(ORIGIN, fakeGeometry(), { fetch, clock, schedule: (flush) => flushes.push(flush) });
  models.info(3015);
  flushes[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(models.info(3015), undefined);
  assert.equal(models.model(3015), undefined);
  assert.equal(clock.timers.length, 1, "one more attempt after a pause");
  clock.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 2);
  assert.equal(clock.timers.length, 1, "and then it waits for retry()");
  assert.equal(models.info(3015), undefined);
  status = 200;
  models.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 3);
  assert.equal(models.info(3015), null);
});

test("GameObjectCollisionModels: a world leave drops display ids not yet sent; the next ask sends them", async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ version: 1, models: [] }), { status: 200 });
  };
  const flushes = [];
  const models = new GameObjectCollisionModels(ORIGIN, fakeGeometry(), { fetch, clock: fakeClock(), schedule: (flush) => flushes.push(flush) });
  models.info(3015);
  models.stop();
  flushes[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(urls, [], "nothing asked behind the character screen");
  models.retry();
  assert.equal(models.info(3015), undefined);
  for (const flush of flushes.slice(1)) flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(urls, [`${ORIGIN}/vmap/gobject-models?v=1&ids=3015`]);
  assert.equal(models.info(3015), null);
});

test("gameObjectModelsFrom refuses another shape", () => {
  assert.equal(gameObjectModelsFrom({ version: 2, models: [] }, [1]), undefined);
  assert.equal(gameObjectModelsFrom({ version: 1 }, [1]), undefined);
  assert.equal(gameObjectModelsFrom({ version: 1, models: [{ displayId: 2, name: "a", isWmo: true, bounds: [0, 0, 0, 1, 1, 1] }] }, [1]), undefined, "an id not asked for");
  assert.equal(gameObjectModelsFrom({ version: 1, models: [{ displayId: 1, name: "a", isWmo: true, bounds: [0, 0, 0, 1, 1] }] }, [1]), undefined);
  assert.equal(gameObjectModelsFrom({ version: 1, models: [] }, [1]).get(1), null);
});

// ---------------------------------------------------------------------------------------------
// Real data: three ships through the same path the browser takes.

/** The collision file as the gateway reads it (`/collision/model/<name>`), as the browser decodes it. */
async function realCarrier(table, displayId) {
  const entry = table.get(displayId);
  let path = join(VMAPS, entry.isWmo ? `${entry.name}.vmo` : entry.name);
  if (!existsSync(path)) path = join(VMAPS, `${entry.name}.vmo`);
  const groups = parseVMapModelGroups(new Uint8Array(await readFile(path)));
  return { entry, groups, model: wireModel(groups) };
}

function worldBounds(world) {
  const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const id of world.ids()) {
    const b = world.get(id).bounds;
    box.minX = Math.min(box.minX, b.minX); box.minY = Math.min(box.minY, b.minY); box.minZ = Math.min(box.minZ, b.minZ);
    box.maxX = Math.max(box.maxX, b.maxX); box.maxY = Math.max(box.maxY, b.maxY); box.maxZ = Math.max(box.maxZ, b.maxZ);
  }
  return box;
}

/** Transportship (the Stormwind–Auberdine boat), Transportship_Ne, Transport_Icebreaker_Ship. */
const SHIPS = [3015, 7087, 7446];

test("real ships: the local mesh is the .dtree box (scaled), unmirrored, and the deck lies on the centre line", withVmaps, async () => {
  const table = await loadGameObjectModels(VMAPS);
  for (const displayId of SHIPS) {
    const { entry, model } = await realCarrier(table, displayId);
    const [lowX, lowY, lowZ, highX, highY, highZ] = entry.bounds;
    // Lopsided along the keel: a mirrored mesh would come out as [−highX, −lowX] and fail below.
    assert.ok(Math.abs(lowX + highX) > 2, `${entry.name} is not symmetric along x`);
    for (const scale of [1, 1.5]) {
      const collision = new TransportCollision(fakeSource(model));
      const world = collision.carrier(BigInt(displayId), displayId, scale);
      assert.equal(collision.isComplete(BigInt(displayId)), true);
      const box = worldBounds(world);
      const expected = [lowX, lowY, lowZ, highX, highY, highZ].map((value) => value * scale);
      const got = [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ];
      got.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 0.01 * scale,
        `${entry.name} ×${scale} bound ${index}: ${value} vs ${expected[index]}`));
    }

    // The deck: a walkable floor on the centre line y = 0 amidships, port and starboard alike.
    const collision = new TransportCollision(fakeSource(model));
    const world = collision.carrier(1n, displayId, 1);
    const below = lowZ + 0.4 * (highZ - lowZ);
    const differences = [];
    let covered = 0;
    let weightedY = 0;
    for (const x of [-20, -10, 0, 10, 20]) {
      const centre = world.floorUnder(x, 0, below, lowZ);
      assert.ok(centre !== undefined && centre > lowZ && centre < below, `${entry.name}: deck at x = ${x}`);
      for (let y = 1; y <= 10; y++) {
        const port = world.floorUnder(x, y, below, lowZ);
        const starboard = world.floorUnder(x, -y, below, lowZ);
        if (port !== undefined && starboard !== undefined) differences.push(Math.abs(port - starboard));
        if (port !== undefined) { covered++; weightedY += y; }
        if (starboard !== undefined) { covered++; weightedY -= y; }
      }
    }
    differences.sort((a, b) => a - b);
    assert.ok(differences.length >= 40, `${entry.name}: ${differences.length} paired samples`);
    assert.ok(differences[Math.floor(differences.length / 2)] < 0.25, `${entry.name}: port/starboard median ${differences[Math.floor(differences.length / 2)]}`);
    assert.ok(Math.abs(weightedY / covered) < 1, `${entry.name}: deck centred at y = ${weightedY / covered}`);
    // Its width: the deck spans most of the beam the .dtree records, and no more.
    let widest = 0;
    for (let y = 0; y <= Math.ceil(highY); y += 0.5) if (world.floorUnder(0, y, below, lowZ) !== undefined) widest = y;
    assert.ok(widest > 0.3 * highY && widest <= highY, `${entry.name}: deck to y = ${widest} of ${highY}`);
  }
});

/**
 * Review: transport passengers as the database spawns them — offsets in the carrier's frame, taken
 * from the real client (TDB `creature` rows whose map is the transport's `data6`; TDB 335.24081).
 * They stand on the local mesh `scale · v`; in the half-turned frame `−x, −y` they do not. This is
 * the axes question of line-A9 risk (3) settled by the real client's own numbers.
 */
const SNIFFED_PASSENGERS = [
  // The Bravery (map 588), Transportship.wmo.
  [3015, [[13.2057, -2.817, 6.09989], [18.1475, -7.41572, 6.09809], [0.194107, 9.84585, 6.09941], [-0.532552, -8.68575, 6.09815],
    [34.0669, 0.119702, 18.287], [-11.1276, 6.60326, 6.09852], [6.22581, 9.13103, 11.4836], [10.2474, 2.78122, 11.803]]],
  // Moonspray (map 582), Transportship_Ne.wmo.
  [7087, [[29.5013, 0.000602, 24.4455], [4.9897, -1.72901, 5.41924], [13.1874, 7.71381, 6.07001], [13.3456, -7.63689, 6.09325],
    [-0.258897, -7.62734, 4.80823], [21.2462, 1.87803, 11.7334]]],
  // The Thundercaller (map 591), Transport_Zeppelin.wmo: the gondola hangs off the centre line.
  [3031, [[7.0053, -7.64791, -16.1126], [-4.5165, -13.1125, -22.5947], [-9.40787, -8.02398, -17.1578], [4.36215, -2.25417, -23.59],
    [10.7034, -3.50542, -23.49], [-19.6886, -8.17058, -14.3765], [-5.2125, -4.92702, -17.5966]]],
  // Northspear (map 612), Transport_Icebreaker_Ship.wmo.
  [7446, [[-9.17065, -9.22241, 9.44523], [-24.342, -1.4956, 11.7907], [17.25, 3.98267, 9.8274], [34.0835, -0.002845, 19.7971],
    [30.1151, -5.08848, 19.3282], [26.0707, 2.05775, 19.328]]],
];

test("real ships: the database's passengers stand on the local deck, not on a half-turned one", withVmaps, async () => {
  const table = await loadGameObjectModels(VMAPS);
  for (const [displayId, passengers] of SNIFFED_PASSENGERS) {
    const { entry, model } = await realCarrier(table, displayId);
    const world = new TransportCollision(fakeSource(model)).carrier(1n, displayId, 1);
    const standing = (sign) => passengers.filter(([x, y, z]) => {
      const floor = world.floorUnder(sign * x, sign * y, z + 1.5, z - 6);
      return floor !== undefined && Math.abs(floor - z) < 0.6;
    }).length;
    assert.equal(standing(1), passengers.length, `${entry.name}: every passenger on the deck`);
    assert.ok(standing(-1) <= passengers.length / 2, `${entry.name}: ${standing(-1)} of ${passengers.length} would stand on a half-turned deck`);
  }
});

test("real ship at a pose: the deck under a passenger equals the core's world placement", withVmaps, async () => {
  const table = await loadGameObjectModels(VMAPS);
  const { entry, groups, model } = await realCarrier(table, 3015);
  const collision = new TransportCollision(fakeSource(model));
  const local = collision.carrier(1n, 3015, 1);
  const pose = { x: -8650.5, y: 1340.25, z: 0.5, orientation: 4.1 };
  const core = coreWorldMesh(groups, pose, 1);
  const at = { x: 0, y: 0, z: 0 };
  const top = entry.bounds[2] + 0.4 * (entry.bounds[5] - entry.bounds[2]);
  let compared = 0;
  for (const [lx, ly] of [[-20, 0], [0, 3], [10, -6], [20, 5]]) {
    const world = toCarrierWorld(pose, lx, ly, top, { x: 0, y: 0, z: 0 });
    toCarrierLocal(pose, world.x, world.y, world.z, at);
    const localZ = local.floorUnder(at.x, at.y, at.z, entry.bounds[2]);
    const coreZ = core.floorUnder(world.x, world.y, world.z, pose.z + entry.bounds[2]);
    assert.ok(localZ !== undefined && coreZ !== undefined);
    assert.ok(Math.abs(pose.z + localZ - coreZ) < 0.01, `${lx},${ly}: ${pose.z + localZ} vs ${coreZ}`);
    compared++;
  }
  assert.equal(compared, 4);
});
