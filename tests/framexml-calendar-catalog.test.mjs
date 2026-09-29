import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";

// The stock calendar's client tables (src/gateway/CalendarCatalog.ts): read from the dataset's DBCs,
// served on /dbc/calendar in process, and read back by the browser's FrameXmlCalendarCatalogClient.
const { FrameXmlCalendarCatalogClient } = await import("../dist/code/browser/framexml/FrameXmlCalendarOwner.js");

const dataset = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const withDataset = { skip: existsSync(`${dataset}/Holidays.dbc`) ? false : "no dataset DBC on this machine" };

test("the catalog: Holidays with their names, the icon picker's LFGDungeons rows, raid maps with MapDifficulty", withDataset, async () => {
  const { loadCalendarCatalog, CALENDAR_CATALOG_VERSION } = await import("../dist/code/gateway/CalendarCatalog.js");
  const started = performance.now();
  const catalog = await loadCalendarCatalog(dataset);
  const ms = performance.now() - started;
  const bytes = JSON.stringify(catalog).length;
  console.log(`[calendar catalog] ${catalog.holidays.length} holidays, ${catalog.textures.length} icons, ${catalog.raids.length} raids, ${bytes} bytes JSON, ${Math.round(ms)} ms`);
  assert.equal(catalog.version, CALENDAR_CATALOG_VERSION);
  // Measured on the tswow dataset (2026-09-25): 26 named Holidays rows; 64 dungeon (TypeID 1) and 35
  // raid (TypeID 2) LFGDungeons rows; 24 raid maps (Map.InstanceType 2).
  assert.equal(catalog.holidays.length, 26);
  assert.equal(catalog.textures.filter((row) => row.type === 1).length, 64);
  assert.equal(catalog.textures.filter((row) => row.type === 2).length, 35);
  assert.equal(catalog.raids.length, 24);
  const brewfest = catalog.holidays.find((row) => row.id === 372);
  assert.deepEqual([brewfest.name, brewfest.texture, brewfest.filterType, brewfest.dates[0], brewfest.durations.slice(0, 3), brewfest.flags.slice(0, 3)],
    ["Хмельной фестиваль", "Calendar_Brewfest", -1, 0x1f833800, [168, 384, 0], [0, 3, 0]]);
  assert.match(brewfest.description, /дворфы/);
  const fishing = catalog.holidays.find((row) => row.id === 301);
  assert.deepEqual([fishing.dates[0], fishing.filterType, fishing.durations[0]], [0x1fffc380, 0, 2]);
  assert.equal(catalog.holidays.find((row) => row.id === 62).region, 1, "the US-only fireworks");
  assert.deepEqual(catalog.textures.find((row) => row.id === 227), {
    id: 227, name: "Наксрамас", texture: "NAXXRAMAS", expansion: 2, type: 2, faction: -1, difficulty: 1, difficultyToken: "RAID_DIFFICULTY_25PLAYER",
  });
  assert.deepEqual(catalog.textures.find((row) => row.id === 6).difficultyToken, "");
  assert.deepEqual(catalog.raids.find((row) => row.mapId === 533), {
    mapId: 533, name: "Наксрамас", difficulties: [
      { difficulty: 0, token: "RAID_DIFFICULTY_10PLAYER", resetSeconds: 604_800 },
      { difficulty: 1, token: "RAID_DIFFICULTY_25PLAYER", resetSeconds: 604_800 },
    ],
  });
  assert.ok(bytes < 64 * 1024, "one small fetch on the window's first open");
});

test("/dbc/calendar is origin-protected, versioned, uncached, and the browser client reads it", withDataset, async () => {
  // In process, on an ephemeral port; the realm addresses point nowhere and are never dialled.
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const origin = "http://127.0.0.1:5173";
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [origin], dbcDirectory: dataset, datasetPollMs: 0,
  });
  const base = `http://127.0.0.1:${gateway.port}/dbc/calendar`;
  try {
    assert.equal((await fetch(`${base}?v=1`)).status, 403);
    assert.equal((await fetch(`${base}?v=2`, { headers: { origin } })).status, 400);
    const response = await fetch(`${base}?v=1`, { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    void response.body?.cancel();
    const client = new FrameXmlCalendarCatalogClient(`http://127.0.0.1:${gateway.port}`, (url) => fetch(url, { headers: { origin } }));
    const [first, second] = await Promise.all([client.load(), client.load()]);
    assert.equal(first, second, "one fetch per page");
    assert.equal(client.failure, undefined);
    assert.equal(first.holidays.length, 26);
    assert.equal(first.textures.length, 99);
    assert.equal(first.raids.find((row) => row.mapId === 533).name, "Наксрамас");
  } finally {
    await gateway.close();
  }
});

test("a gateway without the route (404) or a malformed body leaves the calendar without a catalog", async () => {
  const missing = new FrameXmlCalendarCatalogClient("http://127.0.0.1:1", async () => new Response("", { status: 404 }));
  assert.equal(await missing.load(), undefined);
  assert.match(missing.failure, /404/);
  const hostile = new FrameXmlCalendarCatalogClient("http://127.0.0.1:1", async () => Response.json({
    version: 1, holidays: [{ id: 1, name: "x", dates: [1] }], textures: [], raids: [],
  }));
  assert.equal(await hostile.load(), undefined);
  assert.match(hostile.failure, /malformed/);
  const future = new FrameXmlCalendarCatalogClient("http://127.0.0.1:1", async () => Response.json({ version: 2, holidays: [], textures: [], raids: [] }));
  assert.equal(await future.load(), undefined);
  assert.match(future.failure, /version/);
});
