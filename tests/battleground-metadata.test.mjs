import assert from "node:assert/strict";
import test from "node:test";
import { loadBattlegroundMetadata } from "../dist/code/gateway/BattlegroundMetadata.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { dbcDirectory } from "../tools/paths.mjs";

const EXPECTED_IDS = [1, 2, 3, 7, 9, 30, 32];
const EXPECTED_MAPS = {
  1: [30],
  2: [489],
  3: [529],
  7: [566],
  9: [607],
  30: [628],
  32: [30, 489, 529, 566, 607, 628],
};
const EXPECTED_LIMITS = {
  1: [51, 80, 5, 1, 1941],
  2: [10, 80, 10, 1, 1942],
  3: [20, 80, 15, 1, 1943],
  7: [61, 80, 15, 1, 2851],
  9: [71, 80, 15, 1, 3695],
  30: [71, 80, 5, 1, 4273],
  32: [0, 0, 5, 1, 0],
};

test("BattlemasterList and Map produce the exact 3.3.5 battleground catalog", async () => {
  const metadata = await loadBattlegroundMetadata(dbcDirectory());
  assert.deepEqual(metadata.map(({ bgTypeId }) => bgTypeId), EXPECTED_IDS);
  for (const entry of metadata) {
    assert.deepEqual(entry.mapIds, EXPECTED_MAPS[entry.bgTypeId]);
    assert.deepEqual(
      [entry.minLevel, entry.maxLevel, entry.maxGroupSize, entry.groupsAllowed, entry.holidayWorldState],
      EXPECTED_LIMITS[entry.bgTypeId],
    );
    assert.equal(entry.maps.length, entry.mapIds.length);
    assert.ok(entry.name);
    assert.equal(entry.random, entry.bgTypeId === 32);
    for (const map of entry.maps) {
      assert.ok(map.name);
      assert.ok(map.description0 || map.description1);
    }
  }
  assert.equal(metadata.find(({ bgTypeId }) => bgTypeId === 32).maps.length, 6);
});

test("/dbc/battlegrounds is CORS-protected and session-cached like other DBC routes", async () => {
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    dbcDirectory: dbcDirectory(),
    datasetPollMs: 0,
  });
  const url = `http://127.0.0.1:${gateway.port}/dbc/battlegrounds`;
  try {
    assert.equal((await fetch(url)).status, 403);
    const first = await fetch(url, { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(first.status, 200);
    // 10.12: dataset answers revalidate (CachePolicy.ts) instead of living an hour past a build.
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.match(first.headers.get("etag") ?? "", /^"d1-[0-9a-f]+-[0-9a-f]+"$/);
    assert.equal(first.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    const firstBody = await first.json();
    const second = await fetch(url, { headers: { origin: "http://127.0.0.1:5173" } });
    assert.deepEqual(await second.json(), firstBody);
    const revalidated = await fetch(url, {
      headers: { origin: "http://127.0.0.1:5173", "if-none-match": first.headers.get("etag") },
    });
    assert.equal(revalidated.status, 304);
  } finally {
    await gateway.close();
  }
});
