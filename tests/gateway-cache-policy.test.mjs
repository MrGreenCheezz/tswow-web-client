// 10.12 — HTTP cache classes: `dataset` answers revalidate with a body-independent tag (304 before
// the route runs), `tile` answers are immutable only under this gateway's `g`, older pages keep the
// old lifetimes. 25.10 (serve S2): the tag and `g` name the served inputs, so a restart keeps them.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  IMMUTABLE, LEGACY_TILE_DAY, REVALIDATE, cacheGeneration, contentEtag, datasetEtag, etagMatches, isDatasetCacheRoute,
  servedConfigIdentity, servedIdentity, tileCacheControl,
} from "../dist/code/gateway/CachePolicy.js";
import { dbcDirectory } from "../tools/paths.mjs";
import { lockfileIdentity, scriptDirectoryIdentity, statTreeIdentity } from "../dist/code/gateway/AssetGeneration.js";

const ORIGIN = "http://127.0.0.1:5173";

test("etagMatches compares weakly, accepts lists and *, and nothing else", () => {
  const tag = datasetEtag("abc123");
  assert.equal(tag, '"d2-abc123"');
  assert.equal(etagMatches(undefined, tag), false);
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches(`W/${tag}`, tag), true, "a compressing proxy weakens the tag");
  assert.equal(etagMatches(`"other", ${tag}`, tag), true);
  assert.equal(etagMatches("*", tag), true);
  assert.equal(etagMatches('"d2-abc124"', tag), false);
  assert.equal(etagMatches(tag.slice(1, -1), tag), false, "an unquoted value is not the tag");
});

test("tileCacheControl: no g keeps the old lifetime, this generation is immutable, another revalidates", () => {
  assert.equal(tileCacheControl(null, "g1", LEGACY_TILE_DAY), "public, max-age=86400");
  assert.equal(tileCacheControl("g1", "g1", LEGACY_TILE_DAY), IMMUTABLE);
  assert.equal(tileCacheControl("g0", "g1", LEGACY_TILE_DAY), REVALIDATE);
  assert.equal(tileCacheControl("", "g1", LEGACY_TILE_DAY), REVALIDATE);
});

test("25.10 (serve S2): the served identity moves with every input, and with the process only when nothing vouches", () => {
  const base = {
    codeIdentity: "c", toolsIdentity: "t", configIdentity: "k", dbcHash: "d", archivesHash: "a", chain: "ch",
    patchGeneration: "p", nonce: "n1",
  };
  const id = servedIdentity(base);
  assert.match(id, /^[0-9a-f]{20}$/);
  assert.equal(cacheGeneration(id), id);
  assert.equal(servedIdentity({ ...base, nonce: "n2" }), id, "a restart over the same inputs keeps it");
  for (const key of ["codeIdentity", "toolsIdentity", "configIdentity", "packagesIdentity", "dataTreeIdentity", "salt",
    "dbcHash", "archivesHash", "chain", "patchGeneration"]) {
    assert.notEqual(servedIdentity({ ...base, [key]: "other" }), id, `${key} moves it`);
  }
  const unvouched = { ...base, dbcHash: undefined, archivesHash: undefined };
  assert.notEqual(servedIdentity(unvouched), servedIdentity({ ...unvouched, nonce: "n2" }),
    "with no dataset or archive walk a restart still moves it, as in 10.12");
  assert.equal(servedConfigIdentity({ mapsDirectory: "a", port: 1, allowedOrigins: ["x"], localAssetNonce: "z" }),
    servedConfigIdentity({ mapsDirectory: "a", port: 2 }), "who may ask is not what is answered");
  assert.notEqual(servedConfigIdentity({ mapsDirectory: "a" }), servedConfigIdentity({ mapsDirectory: "b" }));
  assert.notEqual(servedConfigIdentity({ coordinatedVisuals: true }), servedConfigIdentity({ coordinatedVisuals: false }));
  assert.notEqual(servedConfigIdentity({ audioDbcDirectory: null }), servedConfigIdentity({}), "null switches the overlay off");
  assert.match(contentEtag(Buffer.from("abc")), /^"c1-3-[0-9a-f]{16}"$/);
  assert.notEqual(contentEtag(Buffer.from("abc")), contentEtag(Buffer.from("abd")));
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
      assert.equal(first.headers.get("vary"), "Origin, Accept-Encoding"); // 25.10 (serve S1)
      const tag = first.headers.get("etag");
      assert.match(tag ?? "", /^(W\/)?"d2-[0-9a-f]{20}"$/); // 25.10 (serve S1): weak when compressed; S2: d2
      const body = await first.text();

      const again = await fetch(url, { headers: { origin: ORIGIN, "if-none-match": tag } });
      assert.equal(again.status, 304);
      assert.equal(await again.text(), "", "no body");
      assert.equal(again.headers.get("etag"), tag);
      assert.equal(again.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal((await fetch(url, { headers: { origin: ORIGIN, "if-none-match": `W/${tag.replace(/^W\//, "")}` } })).status, 304);
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
    // 25.10 (serve S2): a restart over the same disk and code keeps the tag — and the browser's copy.
    const tags = [];
    for (let run = 0; run < 2; run++) {
      await withGateway({ dbcDirectory: directory }, async (base) => {
        tags.push((await fetch(`${base}/dbc/battlegrounds`, { headers: { origin: ORIGIN } })).headers.get("etag"));
      });
    }
    assert.equal(tags[0], tags[1]);
    // Another configuration is another identity.
    await withGateway({ dbcDirectory: directory, mapsDirectory: directory }, async (base) => {
      assert.notEqual((await fetch(`${base}/dbc/battlegrounds`, { headers: { origin: ORIGIN } })).headers.get("etag"), tags[0]);
    });
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
      // 25.10 (serve S2): the tile names its bytes, so a revalidation is a 304.
      const first = await fetch(`${base}/horizon/1?g=0000`, { headers: { origin: ORIGIN } });
      const tag = first.headers.get("etag");
      assert.match(tag ?? "", /^"c1-8-[0-9a-f]{16}"$/);
      const again = await fetch(`${base}/horizon/1?g=0000`, { headers: { origin: ORIGIN, "if-none-match": tag } });
      assert.equal(again.status, 304);
      assert.equal(again.headers.get("cache-control"), REVALIDATE);
      assert.equal(again.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal(await again.text(), "");
      await writeFile(join(directory, "1.wdl"), Buffer.from("WDL-tes2"));
      assert.equal((await fetch(`${base}/horizon/1?g=0000`, { headers: { origin: ORIGIN, "if-none-match": tag } })).status, 200,
        "a rewritten tile is a new tag");
    });
    // Nothing vouches for this gateway's bytes (no dataset, no client): a restart still moves `g`, as in 10.12.
    const generations = [];
    for (let run = 0; run < 2; run++) {
      await withGateway({ horizonDirectory: directory }, async (base) => {
        generations.push((await (await fetch(`${base}/client/patch-status?summary=1`, { headers: { origin: ORIGIN } })).json()).cacheGeneration);
      });
    }
    assert.notEqual(generations[0], generations[1]);
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

test("25.10 (serve S2, review): generator tree, lock file and maps/vmaps trees each move the identity they feed", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-identity-"));
  try {
    const tools = join(root, "tools");
    await mkdir(join(tools, "dbd"), { recursive: true });
    await mkdir(join(root, "dbc")); // the gateway watches this one alone: nothing below may move its DBC half
    await writeFile(join(tools, "gen.mjs"), "export {};");
    await writeFile(join(tools, "dbd", "Map.dbd"), "COLUMNS\nint ID");
    const toolsBefore = await scriptDirectoryIdentity(tools);
    await writeFile(join(tools, "dbd", "Map.dbd"), "COLUMNS\nint ID\nint Flags");
    assert.notEqual(await scriptDirectoryIdentity(tools), toolsBefore, "(a) a nested definition file the generators load");
    assert.equal(await scriptDirectoryIdentity(join(root, "absent")), "none");

    const lock = join(root, "package-lock.json");
    await writeFile(lock, '{"packages":{"node_modules/three":{"version":"0.170.0"}}}');
    const lockBefore = await lockfileIdentity(lock);
    await writeFile(lock, '{"packages":{"node_modules/three":{"version":"0.171.0"}}}');
    assert.notEqual(await lockfileIdentity(lock), lockBefore, "(b) another package version");

    const maps = join(root, "maps");
    await mkdir(maps);
    await writeFile(join(maps, "0003238.map"), "MAP1");
    const mapsBefore = await statTreeIdentity(maps);
    assert.equal(await statTreeIdentity(maps), mapsBefore, "nothing changed, nothing moves");
    const later = new Date(Date.now() + 5_000);
    await utimes(join(maps, "0003238.map"), later, later);
    const touched = await statTreeIdentity(maps);
    assert.notEqual(touched, mapsBefore, "(c) a re-extracted map");
    await writeFile(join(maps, "0003239.map"), "MAP2");
    assert.notEqual(await statTreeIdentity(maps), touched, "(c) a new map");

    // Through the gateway: the same disk across a restart keeps the tile generation; a touched map or the salt moves it.
    const generation = async (options) => withGateway({ dbcDirectory: join(root, "dbc"), ...options }, async (base) =>
      (await (await fetch(`${base}/client/patch-status?summary=1`, { headers: { origin: ORIGIN } })).json()).cacheGeneration);
    const first = await generation({ mapsDirectory: maps });
    assert.equal(await generation({ mapsDirectory: maps }), first, "a restart over the same maps");
    const later2 = new Date(Date.now() + 10_000);
    await utimes(join(maps, "0003239.map"), later2, later2);
    const afterMap = await generation({ mapsDirectory: maps });
    assert.notEqual(afterMap, first, "(c) a re-extracted map moves g after the restart");
    assert.notEqual(await generation({ mapsDirectory: maps, cacheSalt: "bump-1" }), afterMap, "(d) GATEWAY_CACHE_SALT");
    const withLock = await generation({ mapsDirectory: maps, lockFile: lock });
    await writeFile(lock, '{"packages":{"node_modules/three":{"version":"0.172.0"}}}');
    assert.notEqual(await generation({ mapsDirectory: maps, lockFile: lock }), withLock, "(b) an upgraded package moves g after the restart");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
