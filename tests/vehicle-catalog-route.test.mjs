import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 11.02-F1: `GET /dbc/vehicles?v=1` — a CatalogRoutes.ts row over gateway/VehicleMetadata.ts — and the
// page's VehicleClient. The gateway listens on 127.0.0.1 port 0 over synthetic DBC files; nothing here
// talks to the running gateway (which answers 404 until the owner restarts it: the client must keep
// quiet then and pick the tables up on a later world mount).
const { createGatewayAssetHandler } = await import("../dist/code/gateway/Gateway.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { VEHICLES_VERSION, float32Json } = await import("../dist/code/gateway/VehicleMetadata.js");
const {
  VEHICLE_CATALOG_PATHNAME, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_ROUTE_PATH, startVehicleData, stopVehicleData, vehicleCatalog } = await import("../dist/code/browser/VehicleClient.js");

const ORIGIN = "http://127.0.0.1:5173";
const ROUTE = "/dbc/vehicles";

/** A WDBC image: each row's values written as the format says; strings go to the string block. */
function dbc(format, rows, { fields = format.length } = {}) {
  const strings = [Buffer.from([0])];
  let stringsSize = 1;
  const offsetOf = (text) => {
    if (!text) return 0;
    const at = stringsSize;
    const bytes = Buffer.from(`${text}\0`, "utf8");
    strings.push(bytes);
    stringsSize += bytes.length;
    return at;
  };
  const recordSize = fields * 4;
  const body = Buffer.alloc(rows.length * recordSize);
  rows.forEach((row, index) => {
    for (let column = 0; column < fields; column++) {
      const at = index * recordSize + column * 4;
      const kind = format[column] ?? "i";
      const value = row[column] ?? 0;
      if (kind === "f") body.writeFloatLE(value, at);
      else if (kind === "s") body.writeUInt32LE(offsetOf(value), at);
      else if (kind === "u") body.writeUInt32LE(value >>> 0, at);
      else body.writeInt32LE(value, at);
    }
  });
  const header = Buffer.alloc(20);
  header.write("WDBC", 0, "latin1");
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(fields, 8);
  header.writeUInt32LE(recordSize, 12);
  header.writeUInt32LE(stringsSize, 16);
  return Buffer.concat([header, body, ...strings]);
}

function vehicle(id, seats, extra = {}) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  for (const [column, value] of Object.entries(extra)) row[VEHICLE_COLUMN[column]] = value;
  return row;
}

function seat(id, extra = {}) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  for (const [column, value] of Object.entries(extra)) row[VEHICLE_SEAT_COLUMN[column]] = value;
  return row;
}

const SIEGE = vehicle(117, [1648, 0, 0, 0, 0, 0, 0, 1652], {
  Flags: 0x5018_f027, PitchMin: -0.6981317, PitchMax: 1.3962634, VehicleUIIndicatorID: 223,
  MsslTrgtArcTexture: "Interface\\Vehicles\\Arc.blp", PowerDisplayID: 41,
});
const DRIVER = seat(1648, { Flags: 0x6710_8a0b, UiSkin: 1, CameraSeatZoomMax: 50, AttachmentOffsetZ: 2.25 });
const ODD = seat(1652, { Flags: 0xde00_800b, FlagsB: 0x8000_0020, UiSkin: -1 });

async function dataset({ seatFields } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vehicles-route-"));
  await writeFile(join(directory, "Vehicle.dbc"), dbc(VEHICLE_FORMAT, [SIEGE]));
  await writeFile(join(directory, "VehicleSeat.dbc"), dbc(VEHICLE_SEAT_FORMAT, [DRIVER, ODD], { fields: seatFields }));
  await writeFile(join(directory, "VehicleUIIndicator.dbc"), dbc("ns", [[223, "Interface\\Vehicles\\SeatIndicator\\Vehicle-SiegeEngine.blp"]]));
  await writeFile(join(directory, "VehicleUIIndSeat.dbc"), dbc("niiff", [[227, 223, 2, 0.698, 0.799], [226, 223, 1, 0.501, 0.14]]));
  return directory;
}

async function listen(dbcDirectory, datasetPollMs = 3_600_000) {
  const assets = await createGatewayAssetHandler({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    ...(dbcDirectory ? { dbcDirectory } : {}),
    datasetPollMs,
  });
  const server = createServer(assets.handle);
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    get: (path, origin = ORIGIN) => fetch(`${base}${path}`, origin ? { headers: { origin } } : {}),
    async close() {
      await new Promise((resolve) => { server.close(resolve); });
      assets.close();
    },
  };
}

test("the route is a catalog row at the version its loader answers with", () => {
  const route = CATALOG_ROUTES.find((candidate) => candidate.pathname === ROUTE);
  assert.ok(route, "/dbc/vehicles is a row of CATALOG_ROUTES");
  assert.equal(route.version, VEHICLES_VERSION);
  assert.equal(VEHICLES_VERSION, 1);
  assert.equal(VEHICLE_CATALOG_PATHNAME, ROUTE);
  assert.equal(VEHICLE_ROUTE_PATH, "/dbc/vehicles?v=1", "the page asks for the gateway's version");
});

test("403 without the Origin, 400 for another ?v=, 200 JSON never cached, every column as the file holds it", async () => {
  const directory = await dataset();
  const gateway = await listen(directory);
  try {
    assert.equal((await gateway.get(`${ROUTE}?v=1`, null)).status, 403, "no Origin at all");
    assert.equal((await gateway.get(`${ROUTE}?v=1`, "http://evil.example")).status, 403);
    const wrong = await gateway.get(`${ROUTE}?v=2`);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal((await gateway.get(ROUTE)).status, 400, "a request that names no shape");

    const response = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type"), /^application\/json/);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.version, 1);
    assert.equal(body.vehicles.length, 1);
    assert.equal(body.vehicles[0].length, 40);
    assert.equal(body.seats[0].length, 58);
    const [row] = body.vehicles;
    assert.equal(row[VEHICLE_COLUMN.Flags], 0x5018_f027);
    assert.equal(row[VEHICLE_COLUMN.PitchMin], -0.6981317, "the shortest decimal of the float32");
    assert.ok(!text.includes("0.698131680"), "not the double the float widens to");
    assert.deepEqual(row.slice(VEHICLE_COLUMN.SeatID, VEHICLE_COLUMN.SeatID + 8), [1648, 0, 0, 0, 0, 0, 0, 1652]);
    assert.equal(row[VEHICLE_COLUMN.MsslTrgtArcTexture], "Interface\\Vehicles\\Arc.blp");
    assert.equal(row[VEHICLE_COLUMN.MsslTrgtImpactTexture], "", "an empty string column");
    assert.equal(row[VEHICLE_COLUMN.PowerDisplayID], 41);
    const odd = body.seats[1];
    assert.equal(odd[VEHICLE_SEAT_COLUMN.Flags], 0xde00_800b, "bit 31 as an unsigned word");
    assert.equal(odd[VEHICLE_SEAT_COLUMN.FlagsB], 0x8000_0020);
    assert.equal(odd[VEHICLE_SEAT_COLUMN.UiSkin], -1, "UiSkin is signed");
    assert.equal(body.seats[0][VEHICLE_SEAT_COLUMN.CameraSeatZoomMax], 50, "a column the core skips");
    assert.equal(body.seats[0][VEHICLE_SEAT_COLUMN.AttachmentOffsetZ], 2.25);
    assert.deepEqual(body.indicators, [[223, "Interface\\Vehicles\\SeatIndicator\\Vehicle-SiegeEngine.blp"]]);
    assert.deepEqual(body.indicatorSeats, [[227, 223, 2, 0.698, 0.799], [226, 223, 1, 0.501, 0.14]], "file order");

    // The whole table at once: the route takes no id list, and one does not change the answer.
    const withIds = await gateway.get(`${ROUTE}?v=1&ids=1,abc,-5`);
    assert.equal(withIds.status, 200);
    assert.equal(await withIds.text(), text, "memoised, and ids are not a parameter of this route");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("500 for a table of another layout, and the next request reads the disk again", async () => {
  const directory = await dataset({ seatFields: 57 });
  const gateway = await listen(directory);
  try {
    const broken = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(broken.status, 500);
    assert.equal(broken.headers.get("access-control-allow-origin"), ORIGIN);
    await writeFile(join(directory, "VehicleSeat.dbc"), dbc(VEHICLE_SEAT_FORMAT, [DRIVER]));
    const fixed = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(fixed.status, 200, "a rejected read is not what the next request is served");
    assert.equal((await fixed.json()).seats.length, 1);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing table is a 500, not a crash; without a DBC directory the route is not there", async () => {
  const directory = await dataset();
  await rm(join(directory, "VehicleUIIndSeat.dbc"));
  const gateway = await listen(directory);
  try {
    assert.equal((await gateway.get(`${ROUTE}?v=1`)).status, 500);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
  const bare = await listen(undefined);
  try {
    assert.equal((await bare.get(`${ROUTE}?v=1`)).status, 404);
  } finally {
    await bare.close();
  }
});

test("float32Json: the shortest decimal that reads back as the same float, null for NaN", () => {
  assert.equal(float32Json(Math.fround(0.1)), 0.1);
  assert.equal(float32Json(Math.fround(-0.6981317)), -0.6981317);
  assert.equal(float32Json(0), 0);
  assert.equal(float32Json(Math.fround(3.4028234663852886e38)), 3.4028235e38);
  assert.equal(float32Json(Number.NaN), null);
  assert.equal(float32Json(Number.POSITIVE_INFINITY), null);
  for (const value of [1e-45, 123456.789, -2.5e-12, 0.30000001192092896]) {
    const float = Math.fround(value);
    assert.equal(Math.fround(float32Json(float)), float, `${value} survives`);
  }
});

// ---- the page's client ------------------------------------------------------------------------

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

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

test("the page against the real handler: the mount fetches once, the tables answer by id", async () => {
  const directory = await dataset();
  const gateway = await listen(directory);
  try {
    // A browser sends the page's Origin by itself; Node's fetch is told to.
    const withOrigin = (url) => fetch(url, { headers: { origin: ORIGIN } });
    const client = startVehicleData(gateway.base.replace(/^http/, "ws"), { fetch: withOrigin });
    await client.load();
    const catalog = vehicleCatalog();
    assert.ok(catalog, "loaded");
    assert.equal(catalog.vehicle(117).vehicleUIIndicatorId, 223);
    assert.equal(catalog.seatInSlot(117, 0).uiSkin, 1);
    assert.equal(catalog.seat(1652).flags, 0xde00_800b);
    assert.deepEqual(catalog.indicator(223).seats.map((row) => row.virtualSeatIndex), [1, 2]);
    assert.equal(startVehicleData(`${gateway.base.replace(/^http/, "ws")}/world`), client, "the same gateway keeps one client");
  } finally {
    stopVehicleData();
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an old gateway's 404: no tables and no complaint; the next world mount asks again and they arrive", async () => {
  const clock = fakeClock();
  const calls = [];
  const answers = [404, 404];
  const directory = await dataset();
  const gateway = await listen(directory);
  const fetchVia = async (url) => {
    calls.push(url);
    const answer = answers.shift();
    if (answer !== undefined) return new Response("", { status: answer });
    return fetch(url.replace(/^http:\/\/127\.0\.0\.2:18090/, gateway.base), { headers: { origin: ORIGIN } });
  };
  try {
    const client = startVehicleData("ws://127.0.0.2:18090", { fetch: fetchVia, clock });
    await settle();
    assert.deepEqual(calls, ["http://127.0.0.2:18090/dbc/vehicles?v=1"]);
    assert.equal(vehicleCatalog(), undefined, "nothing yet, nothing thrown");
    await clock.advance(15_000);
    assert.equal(calls.length, 2, "one more attempt after 15 s");
    assert.equal(client.state, "failed");
    await clock.advance(3_600_000);
    assert.equal(calls.length, 2, "then quiet until the next mount");

    stopVehicleData();
    const again = startVehicleData("ws://127.0.0.2:18090", { fetch: fetchVia, clock });
    assert.equal(again, client);
    await again.load();
    await settle();
    assert.equal(calls.length, 3, "the mount revives it");
    assert.equal(client.state, "ready");
    assert.equal(vehicleCatalog().vehicle(117).id, 117);
  } finally {
    stopVehicleData();
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a world leave stops the retries and keeps what arrived; another gateway is another client", async () => {
  const clock = fakeClock();
  const calls = [];
  const fetchVia = async (url) => {
    calls.push(url);
    return new Response("", { status: 500 });
  };
  try {
    const client = startVehicleData("ws://127.0.0.3:18090", { fetch: fetchVia, clock });
    await settle();
    assert.deepEqual(clock.pending, [2_000], "a failure waits two seconds");
    stopVehicleData();
    assert.deepEqual(clock.pending, [], "no retry behind the character screen");
    assert.equal(client.state, "idle");
    assert.equal(vehicleCatalog(), undefined);
    const other = startVehicleData("ws://127.0.0.4:18090", { fetch: fetchVia, clock });
    assert.notEqual(other, client);
    await settle();
    assert.equal(calls.at(-1), "http://127.0.0.4:18090/dbc/vehicles?v=1");
  } finally {
    stopVehicleData();
  }
});

test("EnterWorld.ts starts the tables at the world mount and stops them with the session", async () => {
  const enter = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  const login = enter.indexOf("await world.loginCharacter(character.guid)");
  const start = enter.indexOf("startVehicleData(gatewayInput.value);");
  assert.ok(login > 0 && start > login, "after the world mounts");
  assert.ok(enter.indexOf("entryLifecycle.track(stopVehicleData);", start) > start, "and retired with the session");
});
