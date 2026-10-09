import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

// 05.10-11.01: leaving a ship in the air by its convex volume (WMO MCVP).
//
// Wow.exe facts these pin (Ghidra notes .runtime/re-2026-10-04/l16-transport r7–r9 and
// .runtime/re-2026-10-05/l-1101-mcvp r1): every falling step of a passenger (0x007618b0) asks to
// leave the transport (0x006ec7b0 with no new one), and the request is refused while the passenger's
// offset is inside the model (0x0074b5e0 → GO vt+0xf0 → 0x0070b360 → 0x0077ffb0). For a WMO the
// test is 0x007aea10: outside as soon as one plane gives a·x + b·y + c·z + d > 0. The planes are the
// root's MCVP chunk, read by 0x007d7470 only as the chunk right after MFOG, 16 bytes a plane
// (size >> 4). The gateway serves them as GET /vmap/gobject-volumes?v=1&ids=…; without it (an older
// gateway) the ride keeps the wowee rule of RIDE_LEAVE_FRAMES frames.
import { WMO_CONVEX_VOLUME_EXTENSION, wmoConvexVolume } from "../tools/convex-volumes.mjs";
import {
  GAME_OBJECT_VOLUMES_PATHNAME, GAME_OBJECT_VOLUMES_VERSION, serveGameObjectVolumesRoute,
} from "../dist/code/gateway/GameObjectVolumes.js";
import {
  CARRIER_VOLUMES_ROUTE_VERSION, CarrierVolumes, carrierVolumesFrom, insideConvexVolume,
} from "../dist/code/browser/game/CarrierVolumes.js";
import { RIDE_LEAVE_FRAMES, newRideState, rideVerdict } from "../dist/code/browser/game/TransportRide.js";
import {
  beginRideFrame, currentRide, endRideFrame, setRideCarriers, setRideVolumes,
} from "../dist/code/browser/input/MovementRide.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

const ORIGIN = "http://127.0.0.1:5173";

// ---------------------------------------------------------------------------------------------
// Fixtures.

function chunk(tag, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out.write(tag.split("").reverse().join(""), 0, "latin1");
  out.writeUInt32LE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}

function floats(values) {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeFloatLE(value, index * 4));
  return out;
}

/** The fixed order of a 3.3.5 root as 0x007d7470 walks it; `after` goes right behind MFOG. */
function wmoRoot(after = []) {
  const order = ["MOHD", "MOTX", "MOMT", "MOGN", "MOGI", "MOSB", "MOPV", "MOPT", "MOPR", "MOVV", "MOVB", "MOLT", "MODS", "MODN", "MODD", "MFOG"];
  return Buffer.concat([
    chunk("MVER", Buffer.from([17, 0, 0, 0])),
    ...order.map((tag) => chunk(tag, Buffer.alloc(tag === "MOHD" ? 64 : 0))),
    ...after,
  ]);
}

/** A box −2…2 on x and y, 0…4 on z, as six outward planes. */
const BOX = [
  1, 0, 0, -2, -1, 0, 0, -2,
  0, 1, 0, -2, 0, -1, 0, -2,
  0, 0, 1, -4, 0, 0, -1, 0,
];

// ---------------------------------------------------------------------------------------------
// The WMO root.

test("wmoConvexVolume: the MCVP right after MFOG, 16 bytes a plane; none, misplaced or not a root", () => {
  assert.equal(WMO_CONVEX_VOLUME_EXTENSION, ".wmo");
  assert.deepEqual(wmoConvexVolume(wmoRoot([chunk("MCVP", floats(BOX))])), BOX);
  // A trailing partial plane is not a plane (size >> 4).
  assert.deepEqual(wmoConvexVolume(wmoRoot([chunk("MCVP", Buffer.concat([floats(BOX), Buffer.alloc(12)]))])), BOX);
  assert.deepEqual(wmoConvexVolume(wmoRoot()), [], "a root without one");
  // 0x007d7470 looks only right behind MFOG.
  assert.deepEqual(wmoConvexVolume(wmoRoot([chunk("GFID", Buffer.alloc(4)), chunk("MCVP", floats(BOX))])), []);
  // A non-finite plane never refuses anything in 0x007aea10 (0 < NaN is false): dropped.
  assert.deepEqual(wmoConvexVolume(wmoRoot([chunk("MCVP", floats([...BOX, Number.NaN, 0, 0, 1]))])), BOX);
  assert.equal(wmoConvexVolume(Buffer.from("MD20")), null, "an M2 is no root");
  assert.equal(wmoConvexVolume(chunk("MVER", Buffer.alloc(4))), null, "a root needs MOHD");
});

const clientChain = (() => {
  for (const directory of ["F:/Circle", "F:/CircleClean"]) if (existsSync(`${directory}/Data`)) return directory;
  return undefined;
})();

test("the client's ship and zeppelin roots carry their volumes (one child, as the gateway runs it)", {
  skip: clientChain ? false : "no client on this machine",
}, () => {
  const ship = "World\\wmo\\transports\\transport_ship\\transportship.wmo";
  const zeppelin = "World\\wmo\\transports\\transport_zeppelin\\transport_zeppelin.wmo";
  const result = spawnSync(process.execPath, ["tools/convex-volumes.mjs", ship, zeppelin, "World\\wmo\\nothing\\here.wmo"], {
    env: { ...process.env, CLIENT_DIR: clientChain, CLIENT_PACK_DIR: "" }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stderr);
  // Counts the L16 probe measured over the clean client (note on 11.01, 04.10).
  assert.equal(answer[ship].length / 4, 30);
  assert.equal(answer[zeppelin].length / 4, 32);
  assert.equal(answer["World\\wmo\\nothing\\here.wmo"], null, "absent from the chain");
  const planes = Float64Array.from(answer[ship]);
  assert.equal(insideConvexVolume(planes, 0, 0, 10), true, "over the middle of the deck");
  assert.equal(insideConvexVolume(planes, 0, 0, 12), true, "a jump over it");
  assert.equal(insideConvexVolume(planes, 0, 30, 10), false, "abeam, past the hull");
  assert.equal(insideConvexVolume(planes, 0, 0, -10), false, "under the keel");
  // 05.10 review: the planes are in the frame of the passenger offsets the server keeps. TDB 335.24081
  // creature rows on the Grom'gol–Undercity zeppelin's map 591 (offsets, not world positions) stand
  // inside; the same offsets turned by π — the frame a half-turn off — fall outside, and so does a
  // drop of 5 yd under the lower deck. The ship's own deck row on map 584 likewise.
  const zeppelinPlanes = Float64Array.from(answer[zeppelin]);
  for (const [x, y, z] of [[4.36, -2.25, -23.59], [-4.52, -13.11, -22.59], [7.01, -7.65, -16.11], [10.83, -12.19, -23.49]]) {
    assert.equal(insideConvexVolume(zeppelinPlanes, x, y, z), true, `zeppelin passenger ${x},${y},${z}`);
    assert.equal(insideConvexVolume(zeppelinPlanes, -x, -y, z), false, `half a turn off ${x},${y},${z}`);
  }
  assert.equal(insideConvexVolume(zeppelinPlanes, 4.36, -2.25, -28.59), false, "under the gondola");
  assert.equal(insideConvexVolume(planes, -2.23, 2.55, 6.1), true, "a ship passenger on the deck");
  assert.equal(insideConvexVolume(planes, -2.23, 2.55, 1.1), false, "a ship passenger 5 yd lower, under the volume");
});

// ---------------------------------------------------------------------------------------------
// The gateway route.

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

const DISPLAYS = new Map([
  [3015, { id: 3015, model: "World\\wmo\\transports\\transport_ship\\transportship.wmo" }],
  [3031, { id: 3031, model: "World\\wmo\\transports\\transport_zeppelin\\transport_zeppelin.wmo" }],
  [360, { id: 360, model: "World\\Generic\\elevatorcar.m2" }],
  [77, { id: 77, model: "World\\wmo\\gone.wmo" }],
]);

test("GET /vmap/gobject-volumes: Origin, version, ids, one child per new root, memo, no-store and a failed read", async () => {
  assert.equal(GAME_OBJECT_VOLUMES_PATHNAME, "/vmap/gobject-volumes");
  const asked = [];
  let fail = false;
  const options = {
    dbcDirectory: "unused",
    allowedOrigins: [ORIGIN],
    loadDisplays: async () => DISPLAYS,
    readConvexVolumes: async (paths) => {
      asked.push([...paths]);
      if (fail) throw new Error("child died");
      return Object.fromEntries(paths.map((path) => [path, path.includes("gone") ? null : path.includes("ship") ? BOX : []]));
    },
  };
  const cache = new Map();
  const serve = async (path, origin) => {
    const { url, request, response } = fakeExchange(path, origin);
    const handled = await serveGameObjectVolumesRoute(request, response, url, cache, options);
    return { handled, ...response };
  };
  assert.equal((await serve("/vmap/other?v=1&ids=1")).handled, false);
  assert.equal((await serve("/vmap/gobject-volumes?v=1&ids=3015", "http://evil.test")).status, 403);
  assert.equal((await serve("/vmap/gobject-volumes?v=2&ids=3015")).status, 400);
  assert.equal((await serve("/vmap/gobject-volumes?v=1&ids=")).status, 400);
  assert.equal(asked.length, 0);

  const ok = await serve("/vmap/gobject-volumes?v=1&ids=3015,3031,360,77,5");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
  const answer = JSON.parse(ok.body);
  assert.equal(answer.version, GAME_OBJECT_VOLUMES_VERSION);
  // An M2, a root not in the chain and an unknown display carry no row: the browser keeps its old rule.
  assert.deepEqual(answer.volumes, [{ displayId: 3015, planes: BOX }, { displayId: 3031, planes: [] }]);
  assert.deepEqual(asked, [[DISPLAYS.get(3015).model, DISPLAYS.get(3031).model, DISPLAYS.get(77).model]], "M2s never go to the child");

  // Memoised per root: a second request with one root already read asks for nothing.
  assert.equal((await serve("/vmap/gobject-volumes?v=1&ids=3031,3015")).status, 200);
  assert.equal(asked.length, 1);

  // A failed child: 500, and the root is asked again next time.
  const fresh = new Map();
  fail = true;
  const first = fakeExchange("/vmap/gobject-volumes?v=1&ids=3015");
  await serveGameObjectVolumesRoute(first.request, first.response, first.url, fresh, options);
  assert.equal(first.response.status, 500);
  fail = false;
  const again = fakeExchange("/vmap/gobject-volumes?v=1&ids=3015");
  await serveGameObjectVolumesRoute(again.request, again.response, again.url, fresh, options);
  assert.equal(again.response.status, 200);
  assert.deepEqual(JSON.parse(again.response.body).volumes, [{ displayId: 3015, planes: BOX }]);

  // Without a reader (no client on the machine) the route is not this gateway's: 404, old rule.
  const none = fakeExchange("/vmap/gobject-volumes?v=1&ids=3015");
  assert.equal(await serveGameObjectVolumesRoute(none.request, none.response, none.url, new Map(), { ...options, readConvexVolumes: undefined }), false);
});

test("the route is wired into the gateway with the child reader", async () => {
  const { readFile } = await import("node:fs/promises");
  const gateway = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
  const configuration = await readFile(new URL("../src/gateway/GatewayConfiguration.ts", import.meta.url), "utf8");
  assert.match(gateway, /serveGameObjectVolumesRoute\(request, response, url, indexes\.catalogs/);
  assert.match(gateway, /readConvexVolumes\?:/);
  assert.match(configuration, /convex-volumes\.mjs/);
});

// ---------------------------------------------------------------------------------------------
// The browser.

test("insideConvexVolume: 0x007aea10 — outside once any plane is positive; on a plane is inside", () => {
  const planes = Float64Array.from(BOX);
  assert.equal(insideConvexVolume(planes, 0, 0, 1), true);
  assert.equal(insideConvexVolume(planes, 2, 2, 4), true, "on the faces");
  assert.equal(insideConvexVolume(planes, 2.01, 0, 1), false);
  assert.equal(insideConvexVolume(planes, 0, 0, -0.01), false);
  assert.equal(insideConvexVolume(new Float64Array(0), 99, 99, 99), true, "no plane refuses nothing");
});

test("carrierVolumesFrom: the answer checked; ids without a row are null", () => {
  assert.equal(CARRIER_VOLUMES_ROUTE_VERSION, 1);
  const rows = carrierVolumesFrom({ version: 1, volumes: [{ displayId: 3015, planes: BOX }] }, [3015, 360]);
  assert.deepEqual([...rows.get(3015)], BOX);
  assert.equal(rows.get(360), null);
  for (const bad of [
    null, { version: 2, volumes: [] }, { version: 1 },
    { version: 1, volumes: [{ displayId: 9, planes: BOX }] },
    { version: 1, volumes: [{ displayId: 3015, planes: [1, 2, 3] }] },
    { version: 1, volumes: [{ displayId: 3015, planes: [1, 2, 3, "x"] }] },
  ]) assert.equal(carrierVolumesFrom(bad, [3015, 360]), undefined, JSON.stringify(bad));
});

function fakeFetch(answer) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    return typeof answer === "number"
      ? { ok: false, status: answer, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => answer };
  };
  return { urls, fetch };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("CarrierVolumes: one batched request; an older gateway (404) leaves every volume unknown", async () => {
  const { urls, fetch } = fakeFetch({ version: 1, volumes: [{ displayId: 3015, planes: BOX }] });
  const volumes = new CarrierVolumes(ORIGIN, { fetch, schedule: (flush) => queueMicrotask(flush) });
  assert.equal(volumes.volume(3015), undefined);
  assert.equal(volumes.volume(360), undefined);
  assert.equal(volumes.volume(3015), undefined, "asked once");
  await settle();
  await settle();
  assert.deepEqual(urls, [`${ORIGIN}/vmap/gobject-volumes?v=1&ids=360,3015`]);
  assert.deepEqual([...volumes.volume(3015)], BOX);
  assert.equal(volumes.volume(360), null);
  assert.equal(volumes.volume(0), null, "no display");

  const old = fakeFetch(404);
  const stale = new CarrierVolumes(ORIGIN, { fetch: old.fetch, maxAttempts: 1 });
  assert.equal(stale.volume(3015), undefined);
  await settle();
  await settle();
  assert.equal(old.urls.length, 1);
  assert.equal(stale.volume(3015), undefined, "unknown, not null: the old rule stays");
  stale.stop();
});

// ---------------------------------------------------------------------------------------------
// The rule.

function footing(overrides = {}) {
  return { deckZ: undefined, deckKnown: true, worldFloorZ: undefined, poseZ: 10, mode: "air", flying: false, ...overrides };
}

test("rideVerdict: in the air a known volume decides at once — inside stays however long, outside leaves", () => {
  const pose = { x: 0, y: 0, z: 10, orientation: 0 };
  const inside = newRideState(1n, pose);
  for (let frame = 0; frame < 3 * RIDE_LEAVE_FRAMES; frame++) {
    assert.equal(rideVerdict(inside, { x: 1, y: 0, z: 1 }, footing({ inside: true })), false, `frame ${frame}`);
  }
  assert.equal(inside.offDeckFrames, 0);
  assert.equal(rideVerdict(newRideState(1n, pose), { x: 3, y: 0, z: 1 }, footing({ inside: false })), true, "first step outside");
  // Unknown volume: the wowee rule as before.
  const unknown = newRideState(1n, pose);
  for (let frame = 1; frame < RIDE_LEAVE_FRAMES; frame++) assert.equal(rideVerdict(unknown, { x: 3, y: 0, z: 1 }, footing()), false);
  assert.equal(rideVerdict(unknown, { x: 3, y: 0, z: 1 }, footing()), true);
  // On the ground the volume is not asked: the pier and the frames rule as before.
  const ground = newRideState(1n, pose);
  assert.equal(rideVerdict(ground, { x: 3, y: 0, z: 1 }, footing({ mode: "ground", inside: false, deckZ: 1 })), false);
  assert.equal(rideVerdict(newRideState(1n, pose), { x: 1, y: 0, z: 1 }, footing({ inside: true, worldFloorZ: 11 })), true,
    "landing on a pier inside the volume still ends it");
  assert.equal(rideVerdict(newRideState(1n, pose), { x: 1, y: 0, z: 1 }, footing({ inside: true, flying: true })), true);
});

// ---------------------------------------------------------------------------------------------
// The page's half (MovementRide): the volume of the ridden carrier's display decides.

const SELF = 0x1234n;
const SHIP = 0x1fc0_0000_0000_0007n;
const DISPLAY = 3015;

function rideObjects(offset) {
  const ship = {
    guid: SHIP, typeId: 5, position: { x: 100, y: 200, z: 10, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8], [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, DISPLAY]]),
  };
  const self = {
    guid: SELF, typeId: 4, position: { x: 100 + offset.x, y: 200 + offset.y, z: 10 + offset.z, orientation: 0 },
    fields: new Map(), transport: { guid: SHIP, ...offset, orientation: 0, seat: 0xff },
  };
  return { objects: new Map([[SHIP, ship], [SELF, self]]), self };
}

const NO_WORLD = {
  ground: () => undefined, liquid: () => undefined, hole: () => true, loaded: () => true,
  floor: () => undefined, pushOut: (x, y) => ({ x, y }), ceiling: () => undefined,
};
/** A deck with no floor anywhere: only the leave rule decides. */
const NO_DECK = { floorUnder: () => undefined, pushOut: (x, y) => ({ x, y }), ceilingAbove: () => undefined };

function airFrames(offset, volume, frames) {
  setRideCarriers({ forObject: () => NO_DECK, retain() {}, clear() {} });
  setRideVolumes({ forObject: (object) => (object.guid === SHIP ? volume : null) });
  const { objects, self } = rideObjects(offset);
  const motion = { mode: "air", velocityZ: -1 };
  let ridden = 0;
  for (let frame = 0; frame < frames; frame++) {
    const frameInput = { objects, self, world: NO_WORLD, motion, flying: false, elapsed: 1 / 60, now: frame * 16 };
    beginRideFrame(frameInput);
    endRideFrame(frameInput);
    if (currentRide() === undefined) break;
    ridden++;
  }
  setRideCarriers(undefined);
  setRideVolumes(undefined);
  return { ridden, seat: self.transport };
}

test("MovementRide: falling outside the carrier's volume leaves on the first frame, inside never, unknown after the frames", () => {
  const box = Float64Array.from(BOX);
  const outside = airFrames({ x: 3, y: 0, z: 1 }, box, 60);
  assert.equal(outside.ridden, 0, "the first frame outside ends it");
  assert.equal(outside.seat, undefined);
  const inside = airFrames({ x: 1, y: 0, z: 1 }, box, 60);
  assert.equal(inside.ridden, 60, "inside the volume the ride holds");
  assert.equal(inside.seat?.guid, SHIP);
  const unknown = airFrames({ x: 3, y: 0, z: 1 }, undefined, 60);
  assert.equal(unknown.ridden, RIDE_LEAVE_FRAMES - 1, "an older gateway: the wowee frames");
  const empty = airFrames({ x: 3, y: 0, z: 1 }, new Float64Array(0), 60);
  assert.equal(empty.ridden, RIDE_LEAVE_FRAMES - 1, "a root without MCVP: the wowee frames (Wow.exe unverified there)");
});
