// 10.12 — HTTP cache classes: `dataset` answers revalidate with a body-independent tag (304 before
// the route runs), `tile` answers are immutable only under this process's `g`, older pages keep the
// old lifetimes.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  IMMUTABLE, LEGACY_TILE_DAY, REVALIDATE, cacheGeneration, datasetEtag, etagMatches, isDatasetCacheRoute,
  tileCacheControl,
} from "../dist/code/gateway/CachePolicy.js";
import { dbcDirectory } from "../tools/paths.mjs";

const ORIGIN = "http://127.0.0.1:5173";

test("etagMatches compares weakly, accepts lists and *, and nothing else", () => {
  const tag = datasetEtag("abc123", 7);
  assert.equal(tag, '"d1-abc123-7"');
  assert.equal(etagMatches(undefined, tag), false);
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches(`W/${tag}`, tag), true, "a compressing proxy weakens the tag");
  assert.equal(etagMatches(`"other", ${tag}`, tag), true);
  assert.equal(etagMatches("*", tag), true);
  assert.equal(etagMatches('"d1-abc123-8"', tag), false);
  assert.equal(etagMatches(tag.slice(1, -1), tag), false, "an unquoted value is not the tag");
});

test("tileCacheControl: no g keeps the old lifetime, this generation is immutable, another revalidates", () => {
  assert.equal(tileCacheControl(null, "g1", LEGACY_TILE_DAY), "public, max-age=86400");
  assert.equal(tileCacheControl("g1", "g1", LEGACY_TILE_DAY), IMMUTABLE);
  assert.equal(tileCacheControl("g0", "g1", LEGACY_TILE_DAY), REVALIDATE);
  assert.equal(tileCacheControl("", "g1", LEGACY_TILE_DAY), REVALIDATE);
  assert.notEqual(cacheGeneration("n", 1, "abcdef0123"), cacheGeneration("n", 2, "abcdef0123"), "an epoch moves it");
  assert.notEqual(cacheGeneration("n", 1, "abcdef0123"), cacheGeneration("m", 1, "abcdef0123"), "a restart moves it");
});

test("the dataset class names exactly the /dbc routes built from the dataset", () => {
  for (const path of ["/dbc/spells", "/dbc/areas", "/dbc/light/0", "/dbc/light/571", "/dbc/character-creation"]) {
    assert.equal(isDatasetCacheRoute(path), true, path);
  }
  for (const path of ["/dbc/light/x", "/dbc/achievements", "/dbc/spell-visuals", "/dbc/character-appearance",
    "/texture", "/terrain/0/32/48", "/modules/index", "/dbc/spells/"]) {
    assert.equal(isDatasetCacheRoute(path), false, path);
  }
});

test("Gateway.ts names no hour- or day-long lifetime of its own any more", async () => {
  const source = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"cache-control": "public, max-age=(3600|86400)"/);
});

async function withGateway(options, run) {
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    datasetPollMs: 0,
    ...options,
  });
  try {
    return await run(`http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
  }
}

test("a dataset answer revalidates: 304 for this epoch's tag, 200 with a new tag after the DBCs move", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-cache-policy-"));
  try {
    for (const name of ["BattlemasterList.dbc", "Map.dbc"]) await copyFile(join(dbcDirectory(), name), join(directory, name));
    await withGateway({ dbcDirectory: directory }, async (base) => {
      const url = `${base}/dbc/battlegrounds`;
      const first = await fetch(url, { headers: { origin: ORIGIN } });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("cache-control"), REVALIDATE);
      assert.equal(first.headers.get("vary"), "Origin");
      const tag = first.headers.get("etag");
      assert.match(tag ?? "", /^"d1-[0-9a-f]{12}-[0-9a-f]+"$/);
      const body = await first.text();

      const again = await fetch(url, { headers: { origin: ORIGIN, "if-none-match": tag } });
      assert.equal(again.status, 304);
      assert.equal(await again.text(), "", "no body");
      assert.equal(again.headers.get("etag"), tag);
      assert.equal(again.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal((await fetch(url, { headers: { origin: ORIGIN, "if-none-match": `W/${tag}` } })).status, 304);
      const foreign = await fetch(url, { headers: { origin: "http://evil.test", "if-none-match": tag } });
      assert.equal(foreign.status, 403, "a matching tag is no way past the Origin check");

      // `build data` rewrote a table: the epoch moves, the old copy is refused, the answer is rebuilt.
      const later = new Date(Date.now() + 5_000);
      await utimes(join(directory, "Map.dbc"), later, later);
      const after = await fetch(url, { headers: { origin: ORIGIN, "if-none-match": tag } });
      assert.equal(after.status, 200);
      assert.notEqual(after.headers.get("etag"), tag);
      assert.equal(await after.text(), body, "same bytes here: only the validator had to move");
    });
    // A restart is a new process nonce: the same disk, a different tag.
    const tags = [];
    for (let run = 0; run < 2; run++) {
      await withGateway({ dbcDirectory: directory }, async (base) => {
        tags.push((await fetch(`${base}/dbc/battlegrounds`, { headers: { origin: ORIGIN } })).headers.get("etag"));
      });
    }
    assert.notEqual(tags[0], tags[1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tile is immutable only under the generation /client/patch-status hands out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-cache-policy-tile-"));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "1.wdl"), Buffer.from("WDL-test"));
    await withGateway({ horizonDirectory: directory }, async (base) => {
      const status = await (await fetch(`${base}/client/patch-status?summary=1`, { headers: { origin: ORIGIN } })).json();
      assert.equal(typeof status.cacheGeneration, "string");
      assert.ok(status.cacheGeneration.length >= 12);
      const ask = async (query) => (await fetch(`${base}/horizon/1${query}`, { headers: { origin: ORIGIN } })).headers.get("cache-control");
      assert.equal(await ask(""), "public, max-age=86400", "a page that sends no g is served as before");
      assert.equal(await ask(`?g=${status.cacheGeneration}`), IMMUTABLE);
      assert.equal(await ask("?g=0000"), REVALIDATE, "a stale generation is not pinned");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("10.21 (b): with a poll interval, a DBC edit is seen within a request or two, without a request waiting on the walk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-cache-policy-poll-"));
  try {
    for (const name of ["BattlemasterList.dbc", "Map.dbc"]) await copyFile(join(dbcDirectory(), name), join(directory, name));
    await withGateway({ dbcDirectory: directory, datasetPollMs: 100 }, async (base) => {
      const tagOf = async () => {
        const response = await fetch(`${base}/dbc/battlegrounds`, { headers: { origin: ORIGIN } });
        await response.arrayBuffer();
        return response.headers.get("etag");
      };
      const before = await tagOf();
      const later = new Date(Date.now() + 5_000);
      await utimes(join(directory, "Map.dbc"), later, later);
      await new Promise((done) => setTimeout(done, 150));
      const seen = [];
      for (let ask = 0; ask < 4; ask++) {
        seen.push(await tagOf());
        await new Promise((done) => setTimeout(done, 30));
      }
      assert.ok(seen.slice(1).some((tag) => tag !== before), `the edit becomes visible: ${before} → ${seen.join(", ")}`);
      assert.equal(seen.at(-1) !== before, true, "and stays visible");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
