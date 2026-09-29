import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 2.01 — area triggers (docs/implementation/line-A3.ru.md): the AreaTrigger.dbc catalog
// (gateway/AreaTriggerMetadata.ts) against this dataset's file, the core's geometry
// (Player::IsInAreaTriggerRadius, Position::IsWithinBox) without its slack, and the stock client's
// model as Wow.exe 12340 runs it: one current trigger, a check every 100 ms, the first volume in DBC
// order reported once it holds the position and nothing else tested while it still does, the current
// trigger forgotten on world enter and on a map change and by nothing else — so the arrival point of
// any transfer is reported. Then the bytes of CMSG_AREATRIGGER, the heartbeat-then-report order on a
// real WorldClient, the corpse that is not checked, the catalog client through an old gateway's 404
// and a world leave, and the hook lines in Loop.ts and EnterWorld.ts.
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { buildAreaTrigger } = await import("../dist/code/world/InstanceProtocol.js");
const { DbcError } = await import("../dist/code/gateway/Dbc.js");
const { parseFixed } = await import("../dist/code/gateway/DbcFixed.js");
const {
  AREA_TRIGGERS_VERSION, AREA_TRIGGER_LAYOUT, areaTriggerCatalog, loadAreaTriggers, shortestFloat,
} = await import("../dist/code/gateway/AreaTriggerMetadata.js");
const {
  AREA_TRIGGER_ROUTE_PATH, AREA_TRIGGER_ROUTE_VERSION, areaTriggerRows, startAreaTriggers, stopAreaTriggers,
} = await import("../dist/code/browser/AreaTriggerClient.js");
const {
  AREA_TRIGGER_TICK, AreaTriggerIndex, AreaTriggerTracker, AreaTriggerWatcher, areaTriggers, triggerContains,
  updateAreaTriggers,
} = await import("../dist/code/browser/game/AreaTriggers.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const bytes = (payload) => [...payload];
const at = (x, y = 0, z = 0) => ({ x, y, z });

// ---- the route and the packet -----------------------------------------------------------------

test("the route version is pinned on both sides", () => {
  assert.equal(AREA_TRIGGER_ROUTE_VERSION, AREA_TRIGGERS_VERSION);
  assert.equal(AREA_TRIGGER_ROUTE_PATH, `/dbc/area-triggers?v=${AREA_TRIGGERS_VERSION}`);
  assert.deepEqual({ ...AREA_TRIGGER_LAYOUT }, { fieldCount: 10, recordSize: 40 }, "niffffffff: ten fields, forty bytes");
});

test("CMSG_AREATRIGGER is the trigger's id and nothing else (HandleAreaTriggerOpcode)", () => {
  assert.deepEqual(bytes(buildAreaTrigger(2166)), [0x76, 0x08, 0x00, 0x00]);
  assert.deepEqual(bytes(buildAreaTrigger(5872)), [0xf0, 0x16, 0x00, 0x00]);
});

// ---- the gateway catalog ----------------------------------------------------------------------

/** A WDBC image of AreaTrigger rows. */
function areaTriggerDbc(rows, { fields = 10, recordSize = 40 } = {}) {
  const data = Buffer.alloc(20 + rows.length * recordSize + 1);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => {
    const offset = 20 + index * recordSize;
    data.writeInt32LE(row[0], offset);
    data.writeInt32LE(row[1], offset + 4);
    for (let field = 2; field < 10 && field * 4 < recordSize; field++) data.writeFloatLE(row[field], offset + field * 4);
  });
  return data;
}

test("the catalog reads floats as floats, keeps the file's yaw and refuses another layout", () => {
  const rows = [
    [5326, 617, 1330, 800, -10, 0, 214, 216, 20, 90],
    [2166, 369, 76.027, 10.5043, -4.29659, 0, 9.417, 19, 20.64, 0],
    [0, 1, 1, 2, 3, 4, 0, 0, 0, 0],
    [7, 1, Number.NaN, 2, 3, 4, 0, 0, 0, 0],
  ];
  const catalog = areaTriggerCatalog(parseFixed("AreaTrigger", areaTriggerDbc(rows), AREA_TRIGGER_LAYOUT));
  assert.equal(catalog.version, AREA_TRIGGERS_VERSION);
  assert.deepEqual(catalog.triggers, [rows[1], rows[0]], "ascending, a row without an id or with NaN dropped");
  assert.equal(catalog.triggers[1][9], 90, "the file's yaw; sine and cosine do not care how it is folded");
  assert.equal(shortestFloat(Math.fround(76.027)), 76.027);
  assert.equal(Math.fround(shortestFloat(Math.fround(-4.29659))), Math.fround(-4.29659), "the file's float exactly");
  assert.throws(() => parseFixed("AreaTrigger", areaTriggerDbc(rows, { fields: 9, recordSize: 36 }), AREA_TRIGGER_LAYOUT),
    DbcError);
  assert.throws(() => parseFixed("AreaTrigger", areaTriggerDbc(rows), { fieldCount: 9, recordSize: 36 }), DbcError,
    "a layout that disagrees with the file is refused, not read at the wrong offsets");
});

test("the browser validator takes the route's rows and skips malformed ones", () => {
  const good = [2166, 369, 76.027, 10.5043, -4.29659, 0, 9.417, 19, 20.64, 0];
  assert.equal(areaTriggerRows({ version: 2, triggers: [good] }), undefined, "another shape");
  assert.equal(areaTriggerRows({ version: 1 }), undefined);
  assert.deepEqual(areaTriggerRows({
    version: 1,
    triggers: [good, [1, 2, 3], [0, 1, 0, 0, 0, 1, 0, 0, 0, 0], [3, -1, 0, 0, 0, 1, 0, 0, 0, 0], [4, 1, "x", 0, 0, 1, 0, 0, 0, 0]],
  }), [good]);
});

// ---- the geometry against this dataset --------------------------------------------------------

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/AreaTrigger.dbc`) ? false : "no dataset DBCs on this machine",
};
let realIndex;
async function datasetIndex() {
  if (!realIndex) {
    const catalog = await loadAreaTriggers(dbcDirectory);
    realIndex = { catalog, index: new AreaTriggerIndex(areaTriggerRows(JSON.parse(JSON.stringify(catalog)))) };
  }
  return realIndex;
}

test("this dataset's AreaTrigger.dbc: every row served, the browser takes the route's own answer", withDataset, async () => {
  const { catalog, index } = await datasetIndex();
  assert.equal(catalog.version, AREA_TRIGGERS_VERSION);
  assert.ok(catalog.triggers.length >= 1200, `rows: ${catalog.triggers.length}`);
  const ids = catalog.triggers.map((row) => row[0]);
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right), "ascending by id");
  assert.equal(new Set(ids).size, ids.length, "one row per id");
  // The three all-zero boxes (5048, 5049, 5626) are the only rows without a volume.
  assert.equal(index.size, catalog.triggers.length - 3);
  for (const id of [5048, 5049, 5626]) assert.equal(index.get(id), undefined, `${id} has no volume`);
  assert.ok(JSON.stringify(catalog).length < 100_000, "the answer stays small");
  // Fixtures the spec names: a turned box in Northrend and the Deeprun Tram's Ironforge-side box.
  const turned = index.get(4871);
  assert.deepEqual([turned.mapId, turned.radius, turned.halfLength * 2, turned.halfWidth * 2, turned.halfHeight * 2],
    [571, 0, 109.2, 48.46, 5]);
  assert.ok(Math.abs(turned.cos - Math.cos(0.6943)) < 1e-6 && Math.abs(turned.sin - Math.sin(0.6943)) < 1e-6);
  const tram = index.get(2166);
  assert.deepEqual([tram.mapId, tram.halfLength * 2, tram.halfWidth * 2, tram.halfHeight * 2], [369, 9.417, 19, 20.64]);
  // 3646 is a sphere that also carries box fields; the box is ignored, as the core ignores it.
  assert.equal(index.get(3646).radius, 5);
  assert.ok(!triggerContains(index.get(3646), index.get(3646).x + 5.1, index.get(3646).y, index.get(3646).z));
  // The scan order is the file's: ascending id within a map.
  for (const mapId of new Set(catalog.triggers.map((row) => row[1]))) {
    const list = index.triggersOn(mapId).map((volume) => volume.id);
    assert.deepEqual(list, [...list].sort((left, right) => left - right), `map ${mapId} in DBC order`);
  }
});

test("every sphere holds its centre, not a point 1 % or one yard past its radius (no 1.5-yard reach)", withDataset, async () => {
  const { catalog, index } = await datasetIndex();
  let spheres = 0;
  for (const [id] of catalog.triggers) {
    const volume = index.get(id);
    if (!volume || volume.radius <= 0) continue;
    spheres++;
    const { x, y, z, radius } = volume;
    assert.equal(index.triggersOn(volume.mapId).includes(volume), true, `${id}: indexed under its map`);
    assert.ok(triggerContains(volume, x, y, z), `${id}: centre`);
    assert.ok(triggerContains(volume, x + radius * 0.99, y, z), `${id}: just inside`);
    assert.ok(!triggerContains(volume, x + radius * 1.01, y, z), `${id}: 1 % past along x`);
    assert.ok(!triggerContains(volume, x, y - radius * 1.01, z), `${id}: 1 % past along y`);
    assert.ok(!triggerContains(volume, x, y, z + radius * 1.01), `${id}: 1 % past along z`);
    // The core's own check adds the player's combat reach; the client must not report early.
    assert.ok(!triggerContains(volume, x + radius + 1, y, z), `${id}: a yard past the radius`);
  }
  assert.ok(spheres >= 680, `spheres: ${spheres}`);
});

test("every box holds its centre and a corner point turned by its yaw; unturned, the point leaves", withDataset, async () => {
  const { catalog, index } = await datasetIndex();
  let boxes = 0;
  let strong = 0;
  let unturnedOutside = 0;
  for (const row of catalog.triggers) {
    const [id, , , , , , , , , yaw] = row;
    const volume = index.get(id);
    if (!volume || volume.radius > 0 || !(volume.halfLength > 0.1 && volume.halfWidth > 0.1 && volume.halfHeight > 0.1)) continue;
    boxes++;
    const { x, y, z, halfLength, halfWidth, halfHeight } = volume;
    // From the row's own yaw, not from the volume's sine and cosine: the test turns the point.
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    assert.ok(triggerContains(volume, x, y, z), `${id}: centre`);
    assert.ok(!triggerContains(volume, x, y, z + halfHeight + 0.1), `${id}: above the top`);
    assert.ok(triggerContains(volume, x, y, z + halfHeight - 0.1), `${id}: under the top`);
    const localX = halfLength - 0.1;
    const localY = halfWidth - 0.1;
    // Local to world: the box's axes turned by +yaw (IsWithinBox turns the point back by 2π − yaw).
    const turnedX = x + localX * cos - localY * sin;
    const turnedY = y + localX * sin + localY * cos;
    assert.ok(triggerContains(volume, turnedX, turnedY, z), `${id}: the corner turned by the yaw`);
    assert.ok(!triggerContains(volume, x + (localX + 0.2) * cos - localY * sin, y + (localX + 0.2) * sin + localY * cos, z),
      `${id}: past the end of its length`);
    if (Math.abs(sin) > 0.2) {
      strong++;
      if (!triggerContains(volume, x + localX, y + localY, z)) unturnedOutside++;
    }
  }
  assert.ok(boxes >= 520, `boxes: ${boxes}`);
  assert.ok(strong >= 250, `boxes turned by more than |sin| 0.2: ${strong}`);
  // Measured 263 of 266: three near-symmetric boxes (3197, 4153, 5148) map the corner back inside.
  assert.ok(unturnedOutside >= strong - 5, `the unturned corner leaves ${unturnedOutside} of ${strong} turned boxes`);
});

test("the turned fixture 4871 and the tram box 2166, point by point", withDataset, async () => {
  const { index } = await datasetIndex();
  const turned = index.get(4871);
  const along = (distance) => [turned.x + distance * turned.cos, turned.y + distance * turned.sin, turned.z];
  assert.ok(triggerContains(turned, ...along(54)), "54 yards down its 109.2-yard axis");
  assert.ok(!triggerContains(turned, ...along(55)), "past its end");
  assert.ok(!triggerContains(turned, turned.x + 50, turned.y, turned.z), "50 yards along world X is outside the turned box");
  const tram = index.get(2166);
  assert.ok(triggerContains(tram, tram.x + 4.7, tram.y + 9.4, tram.z + 10.3));
  assert.ok(!triggerContains(tram, tram.x + 4.72, tram.y, tram.z));
  assert.ok(!triggerContains(tram, tram.x, tram.y + 9.51, tram.z));
});

test("walking out of the tram's arrival points: 2166 and 2171 are each reported once", withDataset, async () => {
  const { index } = await datasetIndex();
  // The Ironforge side: areatrigger_teleport 2175 lands at (69.2277, 10.3932, -4.29665), two yards
  // short of box 2166; the Stormwind side: 2173 lands at (67.7607, 2490.98, -4.29649) by sphere 2171.
  for (const [arrival, expected] of [[at(69.2277, 10.3932, -4.29665), 2166], [at(67.7607, 2490.98, -4.29649), 2171]]) {
    const sent = [];
    const watcher = new AreaTriggerWatcher({ heartbeat() {}, enter: (id) => sent.push(id) });
    watcher.start({ triggersOn: (mapId) => index.triggersOn(mapId) });
    for (let frame = 0; frame <= 180; frame++) {
      watcher.frame(369, at(arrival.x + frame * (7 / 60), arrival.y, arrival.z), true, frame * (1000 / 60));
    }
    assert.deepEqual(sent, [expected], `three seconds at a run from the arrival point report ${expected} once`);
  }
});

test("the overlapping taverns of the Sanctum of the Stars: one current inn at a time (4607, then 4608)", withDataset, async () => {
  const { index } = await datasetIndex();
  const tracker = new AreaTriggerTracker((mapId) => index.triggersOn(mapId));
  const both = at(-4150.3, 1130.94, 54);
  const upperOnly = at(-4157.8, 1127.44, 65);
  assert.ok(triggerContains(index.get(4607), both.x, both.y, both.z) && triggerContains(index.get(4608), both.x, both.y, both.z));
  assert.equal(tracker.update(530, both, true), 4607, "the first in DBC order, and only that one");
  assert.equal(tracker.update(530, both, true), undefined, "nothing else is tested while 4607 holds the player");
  assert.equal(tracker.update(530, upperOnly, true), 4608, "4607 left: the core is told the inn it is still in");
  assert.equal(tracker.update(530, both, true), undefined, "back under 4607 while 4608 is current: nothing");
});

// ---- the tracker: one current trigger ---------------------------------------------------------

const SPHERE = [1, 0, 0, 0, 0, 5, 0, 0, 0, 0];
/** A second volume far from the first. */
const INN = [4, 0, 100, 0, 0, 0, 20, 20, 10, 0];
const ELSEWHERE = [3, 1, 0, 0, 0, 5, 0, 0, 0, 0];
/** Two overlapping spheres: 10 wide and low in the DBC order, 11 larger. */
const LOW = [10, 0, 200, 0, 0, 5, 0, 0, 0, 0];
const HIGH = [11, 0, 204, 0, 0, 8, 0, 0, 0, 0];

function synthetic(rows = [SPHERE, INN, ELSEWHERE, LOW, HIGH]) {
  const index = new AreaTriggerIndex(rows);
  return { index, tracker: new AreaTriggerTracker((mapId) => index.triggersOn(mapId)) };
}

test("tracker: entering reports once, staying is silent, leaving and coming back reports again", () => {
  const { tracker } = synthetic();
  assert.equal(tracker.update(0, at(20), true), undefined);
  assert.equal(tracker.update(0, at(4.9), true), 1, "entered");
  assert.equal(tracker.current, 1);
  for (let tick = 0; tick < 30; tick++) assert.equal(tracker.update(0, at(4.9 - tick * 0.1), true), undefined, "inside: nothing more");
  assert.equal(tracker.update(0, at(5.2), true), undefined, "left");
  assert.equal(tracker.current, undefined);
  assert.equal(tracker.update(0, at(4.8), true), 1, "came back");
});

test("tracker: overlapping volumes follow the one current trigger, lowest id first", () => {
  const { tracker } = synthetic();
  assert.equal(tracker.update(0, at(202), true), 10, "inside both: the first in DBC order");
  assert.equal(tracker.update(0, at(202), true), undefined);
  assert.equal(tracker.update(0, at(209), true), 11, "the first left while the second still holds: the second");
  assert.equal(tracker.update(0, at(203), true), undefined, "back inside the first while the second is current");
  assert.equal(tracker.update(0, at(220), true), undefined);
  assert.equal(tracker.update(0, at(211), true), 11, "into the second alone");
});

test("tracker: a transfer's arrival point is reported — only world enter and a map change forget the current trigger", () => {
  const { tracker } = synthetic();
  assert.equal(tracker.update(0, at(1), true), 1);
  assert.equal(tracker.update(1, at(1), true), 3, "another map: the arrival point's volume, at once");
  assert.equal(tracker.update(0, at(1), true), 1, "and back: the map change forgot the old one");
  assert.equal(tracker.update(0, at(100), true), 4, "a same-map teleport (a hearthstone into the inn) is reported");
  assert.equal(tracker.update(0, at(101), true), undefined, "no teleport handler touches the current trigger");
  tracker.clear();
  assert.equal(tracker.update(0, at(101), true), 4, "world enter forgets it");
});

test("tracker: under the curtain or on a taxi nothing is reported or made current; leaving is still noticed", () => {
  const { tracker } = synthetic();
  assert.equal(tracker.update(0, at(1), true), 1);
  assert.equal(tracker.update(0, at(100), false), undefined);
  assert.equal(tracker.current, undefined, "the sphere was left under the curtain");
  assert.equal(tracker.update(0, at(100), true), 4, "the inn, on the first tick the report can go out");
  assert.equal(tracker.update(0, at(1), false), undefined);
  assert.equal(tracker.update(0, at(1), true), 1, "flown back to the sphere: reported again");
});

test("tracker: another map's volume is not this map's; no map, no position, no catalog: nothing", () => {
  let index;
  const tracker = new AreaTriggerTracker((mapId) => index?.triggersOn(mapId));
  assert.equal(tracker.update(0, at(1), true), undefined, "the catalog has not landed");
  index = new AreaTriggerIndex([SPHERE, ELSEWHERE]);
  assert.equal(tracker.update(2, at(1), true), undefined, "map 2 has none");
  assert.equal(tracker.update(undefined, at(1), true), undefined);
  assert.equal(tracker.update(0, undefined, true), undefined);
  assert.equal(tracker.update(0, at(1), true), 1, "the catalog landed while the player stood inside");
});

// ---- the watcher and the packets --------------------------------------------------------------

test("watcher: the heartbeat goes first, then the id; one check and at most one report per 100 ms tick", () => {
  const { index } = synthetic();
  const log = [];
  const watcher = new AreaTriggerWatcher({ heartbeat: () => log.push("heartbeat"), enter: (id) => log.push(id) });
  watcher.start({ triggersOn: (mapId) => index.triggersOn(mapId) });
  assert.equal(AREA_TRIGGER_TICK, 100);
  watcher.frame(0, at(30), true, 0);
  assert.equal(watcher.ticks, 1, "the first frame of a session checks at once");
  for (let now = 16; now < 100; now += 16) watcher.frame(0, at(1), true, now);
  assert.deepEqual(log, [], "frames between two ticks check nothing");
  assert.equal(watcher.ticks, 1);
  watcher.frame(0, at(1), true, 100);
  assert.deepEqual(log, ["heartbeat", 1]);
  // Out of the sphere and into the inn within one tick: the inn waits for the next tick.
  watcher.frame(0, at(100), true, 150);
  watcher.frame(0, at(100), true, 199);
  assert.deepEqual(log, ["heartbeat", 1]);
  watcher.frame(0, at(100), true, 200);
  assert.deepEqual(log, ["heartbeat", 1, "heartbeat", 4]);
  // Inside two volumes at once: one report per tick, and the other never while the first holds.
  for (let now = 300; now <= 1_000; now += 16) watcher.frame(0, at(202), true, now);
  assert.deepEqual(log, ["heartbeat", 1, "heartbeat", 4, "heartbeat", 10]);
  assert.equal(watcher.reported, 3);
});

test("watcher: start() forgets the previous character's current trigger", () => {
  const { index } = synthetic();
  const log = [];
  const watcher = new AreaTriggerWatcher({ heartbeat() {}, enter: (id) => log.push(id) });
  const source = { triggersOn: (mapId) => index.triggersOn(mapId) };
  watcher.start(source);
  watcher.frame(0, at(1), true, 0);
  assert.deepEqual(log, [1]);
  assert.equal(watcher.current, 1);
  // Logged out in the sphere; the next character logs in standing in the same place.
  watcher.start(source);
  assert.equal(watcher.current, undefined);
  watcher.frame(0, at(1), true, 50);
  assert.deepEqual(log, [1, 1], "the new session reports the volume it starts in");
});

test("watcher: volumes crossed before the catalog landed are not reported; walking back into one is", () => {
  const index = new AreaTriggerIndex([INN]);
  let landed = false;
  const log = [];
  const watcher = new AreaTriggerWatcher({ heartbeat() {}, enter: (id) => log.push(id) });
  watcher.start({ triggersOn: (mapId) => (landed ? index.triggersOn(mapId) : undefined) });
  for (let step = 0; step <= 60; step++) watcher.frame(0, at(80 + step * 0.7), true, step * 100);
  landed = true;
  watcher.frame(0, at(122), true, 7_000);
  assert.deepEqual(log, [], "the inn at x = 90…110 was walked through before anything could check it");
  for (let step = 1; step <= 20; step++) watcher.frame(0, at(122 - step * 0.7), true, 7_000 + step * 100);
  assert.deepEqual(log, [4]);
});

const SELF = 0x42n;

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  await client.loginCharacter(SELF);
  await settle();
  client.movementReady = true;
  connection.sent.length = 0;
  return { client, connection };
}

function stand(client, x, y = 0, z = 0) {
  client.state.move(SELF, { flags: 0, position: { x, y, z, orientation: 0 } });
}

/** The real frame hook over a WorldClient, the page's watcher given a synthetic catalog. */
async function liveWorld(rows = [SPHERE, INN, ELSEWHERE]) {
  const { client, connection } = await loggedIn();
  const index = new AreaTriggerIndex(rows);
  const saved = { world: game.world, worldLoading: game.worldLoading };
  game.world = client;
  game.worldLoading = false;
  areaTriggers.start({ triggersOn: (mapId) => index.triggersOn(mapId) });
  let now = 0;
  return {
    client,
    connection,
    /** Frames for a while, at 60 a second: at least one 100 ms tick. */
    frames(milliseconds = 120) {
      for (const end = now + milliseconds; now < end; now += 1000 / 60) updateAreaTriggers(now);
    },
    opcodes: () => connection.sent.map((packet) => packet.opcode),
    reports: () => connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_AREATRIGGER)
      .map((packet) => new DataView(packet.payload.buffer, packet.payload.byteOffset).getUint32(0, true)),
    close() {
      areaTriggers.start(undefined);
      game.world = saved.world;
      game.worldLoading = saved.worldLoading;
      client.close();
    },
  };
}

test("WorldClient: MSG_MOVE_HEARTBEAT goes out before CMSG_AREATRIGGER, and a closed client sends neither", async () => {
  const live = await liveWorld();
  try {
    stand(live.client, 20);
    live.frames();
    assert.deepEqual(live.connection.sent, [], "outside: nothing");
    stand(live.client, 4);
    live.frames();
    assert.deepEqual(live.opcodes(), [OPCODES.MSG_MOVE_HEARTBEAT, OPCODES.CMSG_AREATRIGGER],
      "the core checks the volume against the last position it heard");
    assert.deepEqual(bytes(live.connection.sent[1].payload), bytes(buildAreaTrigger(1)));
    stand(live.client, 3);
    live.frames(500);
    assert.equal(live.connection.sent.length, 2, "inside: nothing more");
    live.client.close();
    assert.doesNotThrow(() => live.client.enterAreaTrigger(1));
    assert.deepEqual(live.reports(), [1]);
  } finally {
    live.close();
  }
});

test("WorldClient: a hearthstone into an inn and a worldport onto another map report the arrival once, after the curtain", async () => {
  const live = await liveWorld();
  try {
    stand(live.client, 2);
    live.frames();
    assert.deepEqual(live.reports(), [1]);
    // A same-map teleport into the inn (the hearthstone): MSG_MOVE_TELEPORT_ACK, then the curtain.
    game.worldLoading = true;
    live.connection.push(OPCODES.MSG_MOVE_TELEPORT_ACK, new PacketWriter()
      .packedGuid(SELF).u32(1).u32(0).u16(0).u32(0).f32(100).f32(0).f32(0).f32(0).u32(0).toUint8Array());
    await settle();
    assert.equal(live.client.state.objects.get(SELF).position.x, 100, "the server put the character in the inn");
    live.frames(500);
    assert.deepEqual(live.reports(), [1], "nothing goes out under the curtain");
    game.worldLoading = false;
    live.frames();
    assert.deepEqual(live.reports(), [1, 4], "the first tick after the curtain reports the inn: the rest flag");
    live.frames(1_000);
    assert.deepEqual(live.reports(), [1, 4], "once");
    // SMSG_NEW_WORLD onto map 1, landing inside its sphere.
    game.worldLoading = true;
    live.connection.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(1).f32(1).f32(0).f32(0).f32(0).toUint8Array());
    await settle();
    assert.equal(live.client.mapId, 1);
    live.frames(500);
    game.worldLoading = false;
    live.frames(500);
    assert.equal(live.client.movementReady, false, "the mover is claimed again behind the destination's first packets");
    assert.deepEqual(live.reports(), [1, 4], "nothing before it");
    live.client.movementReady = true;
    live.frames();
    assert.deepEqual(live.reports(), [1, 4, 3], "the arrival point's volume, once the report can go out");
    live.frames(1_000);
    assert.deepEqual(live.reports(), [1, 4, 3]);
    const heartbeat = live.opcodes().lastIndexOf(OPCODES.MSG_MOVE_HEARTBEAT);
    assert.ok(heartbeat >= 0 && heartbeat < live.opcodes().lastIndexOf(OPCODES.CMSG_AREATRIGGER));
  } finally {
    live.close();
  }
});

test("WorldClient: a corpse is not checked, a ghost (1 health) is; a taxi and a refused mover send nothing", async () => {
  const live = await liveWorld();
  const self = live.client.state.objects.get(SELF) ?? (stand(live.client, 20), live.client.state.objects.get(SELF));
  try {
    stand(live.client, 20);
    live.frames();
    self.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    stand(live.client, 2);
    live.frames(500);
    assert.deepEqual(live.connection.sent, [], "an unreleased corpse checks nothing");
    self.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1);
    live.frames();
    assert.deepEqual(live.reports(), [1], "the ghost walking into its instance's portal is how it reaches its body");
    stand(live.client, 20);
    live.frames();
    live.client.state.objects.get(SELF).motion = {
      splineId: 1, points: [], lengths: [], totalLength: 0, startedAt: 0, duration: 1, cyclic: false, flying: true,
    };
    live.client.state.objects.get(SELF).position = { x: 2, y: 0, z: 0, orientation: 0 };
    live.frames(500);
    assert.deepEqual(live.reports(), [1], "the core ignores the packet in flight anyway");
    live.client.state.objects.get(SELF).motion = undefined;
    live.client.movementReady = false;
    live.frames(500);
    assert.deepEqual(live.reports(), [1], "no mover granted, no report");
    live.client.movementReady = true;
    live.frames();
    assert.deepEqual(live.reports(), [1, 1]);
  } finally {
    live.close();
  }
});

// ---- the catalog client -----------------------------------------------------------------------

function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    setTimeout(callback, milliseconds) {
      const timer = { at: now + milliseconds, milliseconds, callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    get pending() {
      return timers.map((timer) => timer.milliseconds);
    },
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const due = timers[0];
        if (!due || due.at > until) break;
        timers.shift();
        now = due.at;
        due.callback();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

function scripted(answers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const answer = answers.shift() ?? 404;
    return typeof answer === "number" ? new Response("", { status: answer }) : new Response(JSON.stringify(answer));
  };
  return { calls, fetch };
}

test("an old gateway's 404: the watcher keeps quiet, the next world mount asks again and the volumes arrive", async () => {
  const clock = fakeClock();
  const { calls, fetch } = scripted([404, 404, { version: 1, triggers: [SPHERE] }]);
  const log = [];
  try {
    const catalog = startAreaTriggers("ws://127.0.0.1:18090", { fetch, clock });
    await settle();
    assert.deepEqual(calls, ["http://127.0.0.1:18090/dbc/area-triggers?v=1"], "started at the mount, at once");
    assert.equal(catalog.triggersOn(0), undefined);
    assert.doesNotThrow(() => areaTriggers.frame(0, at(1), true, 0), "nothing to check yet, and no complaint");
    await clock.advance(15_000);
    assert.equal(calls.length, 2, "one more attempt after 15 s");
    assert.equal(catalog.state, "failed");
    await clock.advance(3_600_000);
    assert.equal(calls.length, 2, "then quiet");

    const again = startAreaTriggers("ws://127.0.0.1:18090/world", { fetch, clock });
    await settle();
    assert.equal(again, catalog, "the same gateway keeps its one catalog");
    assert.equal(calls.length, 3, "the next mount revives it");
    assert.equal(catalog.state, "ready");
    assert.equal(catalog.triggersOn(0).length, 1);

    const watcher = new AreaTriggerWatcher({ heartbeat: () => log.push("heartbeat"), enter: (id) => log.push(id) });
    watcher.start(catalog);
    watcher.frame(0, at(10), true, 0);
    watcher.frame(0, at(4), true, 100);
    assert.deepEqual(log, ["heartbeat", 1]);
  } finally {
    stopAreaTriggers();
  }
});

test("a world leave stops the catalog's retries and forgets the session; the next mount starts again", async () => {
  const clock = fakeClock();
  const { calls, fetch } = scripted(["x", 500, { version: 1, triggers: [SPHERE] }]);
  try {
    const catalog = startAreaTriggers("ws://127.0.0.2:18090", { fetch, clock });
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(clock.pending, [2_000], "a failure waits two seconds");
    areaTriggers.frame(0, at(1), true, 0);
    stopAreaTriggers();
    assert.deepEqual(clock.pending, [], "no retry keeps running behind the character screen");
    await clock.advance(600_000);
    assert.equal(calls.length, 1);
    assert.equal(catalog.state, "idle");
    startAreaTriggers("ws://127.0.0.2:18090", { fetch, clock });
    await settle();
    assert.equal(calls.length, 2, "the next mount asks at once");
    await clock.advance(2_000);
    assert.equal(catalog.state, "ready");
    areaTriggers.frame(0, at(1), true, 10_000);
    assert.equal(areaTriggers.current, 1);
    stopAreaTriggers();
    assert.equal(areaTriggers.current, undefined, "the leave forgets the session's current trigger");
    assert.equal(catalog.state, "ready", "and keeps the catalog for the next mount");
  } finally {
    stopAreaTriggers();
  }
});

// ---- the hook lines ---------------------------------------------------------------------------

test("Loop.ts checks right after the physics step; EnterWorld.ts starts the catalog at the mount and stops it at the leave", async () => {
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const physics = loop.indexOf("advancePhysics(elapsed);");
  const check = loop.indexOf("updateAreaTriggers(now);");
  const heartbeat = loop.indexOf("sendMovement(OPCODES.MSG_MOVE_HEARTBEAT)");
  assert.ok(physics > 0 && check > physics, "after the step that moved the character");
  assert.ok(check < heartbeat, "before the periodic heartbeat, which the report's own heartbeat defers");
  assert.ok(loop.lastIndexOf("if (world && player?.position && !worldPanel.hidden)", check) > 0, "inside the world block");

  const enter = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  const login = enter.indexOf("await world.loginCharacter(character.guid)");
  const start = enter.indexOf("startAreaTriggers(gatewayInput.value);");
  assert.ok(login > 0 && start > login, "the catalog starts when the world mounts");
  assert.ok(enter.indexOf("entryLifecycle.track(stopAreaTriggers);", start) > start, "and stops when the session is retired");
  const changed = enter.indexOf("world.onWorldChanged = (mapId, position) => {");
  const changedEnd = enter.indexOf("\n  };", changed);
  assert.ok(changed > 0 && !enter.slice(changed, changedEnd).includes("areaTriggers"),
    "no transfer handler touches the current trigger (the stock client's does not)");
});
