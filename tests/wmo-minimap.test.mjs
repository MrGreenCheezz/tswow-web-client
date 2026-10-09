// 05.10-A7b-3 (7.14, data and route): the baked WMO minimap tiles md5translate names
// `<root>_<group %03d>_<x %02d>_<y %02d>.blp`, the `/minimap/wmo` route and the browser's loader.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WMO_MINIMAP_TILE_YARDS, parseMd5Translate, tilesOfMap, wmoMinimapRoot, wmoMinimapRoots, wmoTilesOf,
} from "../tools/minimap-index.mjs";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { WMO_MINIMAP_ROUTE_VERSION, wmoMinimapKey } from "../dist/code/gateway/WmoMinimapRoute.js";
import {
  WMO_MINIMAP_TILE_SIZE, WmoMinimapTileClient, wmoMinimapCell,
} from "../dist/code/browser/WmoMinimapTiles.js";

const HASH = (n) => n.toString(16).padStart(32, "0");
const TRS = [
  "dir: wmo\\Dungeon\\AZ_StormwindPrisons",
  `wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail_000_00_00.blp\t${HASH(1)}.blp`,
  `wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail_005_01_00.blp\t${HASH(2)}.blp`,
  `wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail_005_00_02.blp\t${HASH(3)}.blp`,
  // Off-grammar: two-digit group, one-digit cell, and a longer root that shares the prefix.
  `wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail_05_00_00.blp\t${HASH(4)}.blp`,
  `wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail_006_0_00.blp\t${HASH(5)}.blp`,
  `wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail_Annex_001_00_00.blp\t${HASH(6)}.blp`,
  "dir: Azeroth",
  `Azeroth\\map31_49.blp\t${HASH(7)}.blp`,
].join("\r\n");

test("wmoTilesOf: group, then x (model X), then y — strict grammar, exact root", () => {
  const index = parseMd5Translate(Buffer.from(TRS, "latin1"));
  const tiles = wmoTilesOf(index, "World\\wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail.wmo");
  // `_005_01_00` is x 1, y 0: measured over 80 groups whose two counts differ, ceil(box/128) along
  // model X equals the first number on all 80 and the swapped reading on none.
  assert.deepEqual(tiles, { 0: { "0-0": HASH(1) }, 5: { "1-0": HASH(2), "0-2": HASH(3) } });
  assert.deepEqual(wmoTilesOf(index, "world/wmo/dungeon/az_stormwindprisons/stormwindjail_annex.WMO"),
    { 1: { "0-0": HASH(6) } });
  assert.deepEqual(wmoTilesOf(index, "World\\wmo\\Nowhere.wmo"), {});
  // The ADT reading is untouched by the WMO lines beside it.
  assert.deepEqual(tilesOfMap(index, "Azeroth"), { "49-31": HASH(7) });
  assert.equal(WMO_MINIMAP_TILE_YARDS, 128);
});

test("wmoMinimapRoot: the client's key — `World\\` and `.wmo` dropped, lower case, backslashes", () => {
  assert.equal(wmoMinimapRoot("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo"),
    "wmo\\azeroth\\buildings\\stormwind\\stormwind");
  assert.equal(wmoMinimapRoot("WORLD/WMO/A/B.wmo"), "wmo\\a\\b");
  assert.equal(wmoMinimapKey("World/wmo/A/B.WMO"), "wmo\\a\\b");
  assert.equal(wmoMinimapKey("World\\wmo\\A\\B.m2"), undefined);
  assert.equal(wmoMinimapKey(""), undefined);
});

test("wmoMinimapRoots: one pass over the index answers every root", () => {
  const roots = wmoMinimapRoots(parseMd5Translate(Buffer.from(TRS, "latin1")));
  assert.deepEqual(Object.keys(roots).sort(), [
    "wmo\\dungeon\\az_stormwindprisons\\stormwindjail", "wmo\\dungeon\\az_stormwindprisons\\stormwindjail_annex",
  ]);
  assert.deepEqual(roots["wmo\\dungeon\\az_stormwindprisons\\stormwindjail"][5], { "1-0": HASH(2), "0-2": HASH(3) });
});

test("MPQ vertical: the Stockade has 26 tiles over its 26 groups", { skip: !existsSync("F:/Circle/Data") }, async () => {
  const [{ clientArchives }, { loadMinimapIndex }] = await Promise.all([
    import("../tools/mpq.mjs"), import("../tools/minimap-index.mjs")]);
  const archives = await clientArchives("F:/Circle");
  try {
    const tiles = wmoTilesOf(await loadMinimapIndex(archives), "World\\wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail.wmo");
    assert.equal(Object.keys(tiles).length, 26);
    assert.equal(Object.values(tiles).reduce((total, cells) => total + Object.keys(cells).length, 0), 26);
  } finally {
    archives.close();
  }
});

async function withGateway(run, { generate = true } = {}) {
  const minimapDirectory = await mkdtemp(join(tmpdir(), "webclient-wmo-minimap-"));
  let generated = 0;
  const writeIndex = (roots) => writeFile(join(minimapDirectory, "wmo.json"), JSON.stringify({ version: 1, roots }));
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    minimapDirectory,
    ...(generate ? {
      generateWmoMinimapIndex: async () => {
        generated++;
        await writeIndex(wmoMinimapRoots(parseMd5Translate(Buffer.from(TRS, "latin1"))));
      },
    } : {}),
  });
  try {
    await run({ base: `http://127.0.0.1:${gateway.port}`, generated: () => generated, writeIndex, minimapDirectory });
  } finally {
    await gateway.close();
    await rm(minimapDirectory, { recursive: true, force: true });
  }
}

const headers = { origin: "http://localhost:5173" };
const jail = encodeURIComponent("World\\wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail.wmo");

test("/minimap/wmo: Origin, version and path are checked before anything is read", async () => {
  await withGateway(async ({ base, generated }) => {
    const url = `${base}/minimap/wmo?path=${jail}&v=${WMO_MINIMAP_ROUTE_VERSION}`;
    const refused = await fetch(url);
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();
    for (const bad of [`${base}/minimap/wmo?path=${jail}`, `${base}/minimap/wmo?path=${jail}&v=99`,
      `${base}/minimap/wmo?v=${WMO_MINIMAP_ROUTE_VERSION}`,
      `${base}/minimap/wmo?path=${encodeURIComponent("World\\wmo\\a.m2")}&v=${WMO_MINIMAP_ROUTE_VERSION}`]) {
      const response = await fetch(bad, { headers });
      assert.equal(response.status, 400, bad);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
      await response.arrayBuffer();
    }
    assert.equal(generated(), 0);
  });
});

test("/minimap/wmo: one generation for callers arriving together; tiles by group; 404 for none", async () => {
  await withGateway(async ({ base, generated }) => {
    const url = `${base}/minimap/wmo?path=${jail}&v=${WMO_MINIMAP_ROUTE_VERSION}`;
    const [first, second] = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(generated(), 1);
    const body = await first.json();
    await second.arrayBuffer();
    assert.equal(body.version, WMO_MINIMAP_ROUTE_VERSION);
    assert.equal(body.path, "wmo\\dungeon\\az_stormwindprisons\\stormwindjail");
    assert.deepEqual(body.groups["5"], { "1-0": HASH(2), "0-2": HASH(3) });
    // Forward slashes and case are the same building.
    const slashed = await fetch(`${base}/minimap/wmo?path=${encodeURIComponent("world/WMO/dungeon/az_stormwindprisons/STORMWINDJAIL.wmo")}&v=1`, { headers });
    assert.equal(slashed.status, 200);
    await slashed.arrayBuffer();
    const none = await fetch(`${base}/minimap/wmo?path=${encodeURIComponent("World\\wmo\\Nowhere.wmo")}&v=1`, { headers });
    assert.equal(none.status, 404);
    assert.equal(none.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(none.headers.get("cache-control"), "no-store");
    await none.arrayBuffer();
    assert.equal(generated(), 1);
  });
});

test("/minimap/wmo: the memo follows the file — a republished index is read again", async () => {
  await withGateway(async ({ base, writeIndex, minimapDirectory }) => {
    const url = `${base}/minimap/wmo?path=${jail}&v=1`;
    const before = await fetch(url, { headers });
    assert.equal(before.status, 200);
    await before.arrayBuffer();
    await writeIndex({ "wmo\\dungeon\\az_stormwindprisons\\stormwindjail": { 9: { "0-0": HASH(9) } } });
    const later = new Date(Date.now() + 5_000);
    await utimes(join(minimapDirectory, "wmo.json"), later, later);
    const after = await fetch(url, { headers });
    assert.deepEqual((await after.json()).groups, { 9: { "0-0": HASH(9) } });
  });
});

test("/minimap/wmo without a generator and without a file is a 404, not a hang", async () => {
  await withGateway(async ({ base }) => {
    const response = await fetch(`${base}/minimap/wmo?path=${jail}&v=1`, { headers });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }, { generate: false });
});

test("WmoMinimapTileClient: v-versioned request, groups, a 404 is final, a failure climbs the ladder", async () => {
  const original = globalThis.fetch;
  let now = 0;
  const requests = [];
  const answers = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
  try {
    const client = new WmoMinimapTileClient("ws://127.0.0.1:8090/auth", () => now);
    const path = "World\\wmo\\Dungeon\\AZ_StormwindPrisons\\StormwindJail.wmo";
    answers.push({ status: 200, body: { version: 1, path: "x", groups: { 5: { "1-0": HASH(2), "0-2": "not-a-hash" } } } });
    assert.equal(client.groupTiles(path, 5), undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(requests[0], /^http:\/\/127\.0\.0\.1:8090\/minimap\/wmo\?path=World%5Cwmo%5C.*&v=1/);
    assert.equal(client.groupTiles(path, 5)?.get("1-0"), HASH(2));
    assert.equal(client.groupTiles(path, 5)?.size, 1, "a malformed hash is dropped");
    assert.equal(client.groupTiles(path, 6)?.size ?? 0, 0);
    assert.equal(requests.length, 1);

    // An old gateway (or a building without bakes): 404, asked once for the session.
    answers.push({ status: 404 });
    const old = "World\\wmo\\Old.wmo";
    assert.equal(client.groupTiles(old, 0), undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(client.hasTiles(old), false);
    now += 60_000;
    client.groupTiles(old, 0);
    assert.equal(requests.length, 2);

    // A transient failure waits 2 s before the next try.
    answers.push(new Error("offline"));
    const flaky = "World\\wmo\\Flaky.wmo";
    client.groupTiles(flaky, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.groupTiles(flaky, 0);
    assert.equal(requests.length, 3);
    now += 2_000;
    answers.push({ status: 200, body: { version: 1, path: "y", groups: { 0: { "0-0": HASH(1) } } } });
    client.groupTiles(flaky, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests.length, 4);
    assert.equal(client.hasTiles(flaky), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("wmoMinimapCell: 128-yard cells from the group box's minimum corner", () => {
  assert.equal(WMO_MINIMAP_TILE_SIZE, 128);
  assert.deepEqual(wmoMinimapCell({ minX: -100, minY: 50 }, -100, 50), { x: 0, y: 0 });
  assert.deepEqual(wmoMinimapCell({ minX: -100, minY: 50 }, 29, 177.9), { x: 1, y: 0 });
  assert.deepEqual(wmoMinimapCell({ minX: -100, minY: 50 }, -99, 306), { x: 0, y: 2 });
});
