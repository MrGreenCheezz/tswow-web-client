import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { adtSplatVerdict } from "../tools/adt-alpha.mjs";
import { SourceMissing } from "../tools/source-missing.mjs";
import { dbcDirectory } from "../tools/paths.mjs";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { TerrainSplatClient } from "../dist/code/browser/TerrainSplat.js";

// 7.23: a tile whose ADT has nothing to paint (the flat stubs under dungeons — every Gundrak tile)
// or that the client does not hold is a final 404, remembered on disk by a stamped `.nosplat`, and
// the browser takes that 404 quietly. A tile where only some chunks are bare is a real tile.

const ORIGIN = "http://127.0.0.1:5173";

test("adtSplatVerdict: all chunks bare is none, some bare is partial, five layers is broken", () => {
  assert.equal(adtSplatVerdict(Array(256).fill(0), 3), "none");
  assert.equal(adtSplatVerdict([0, ...Array(255).fill(2)], 3), "partial");
  assert.equal(adtSplatVerdict(Array(256).fill(1), 1), "ok");
  assert.equal(adtSplatVerdict(Array(256).fill(1), 0), "none", "no MTEX");
  assert.equal(adtSplatVerdict([], 4), "none", "no MCNK");
  assert.throws(() => adtSplatVerdict([1, 5], 2), /Invalid ADT map chunk header/);
});

/** A chunk of an ADT, `tag` as it reads, stored reversed like the client stores it. */
function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** MTEX plus 256 MCNK whose layer counts `layersOf(index)` gives (one texture, no alpha). */
function adt(layersOf) {
  const parts = [chunk("MTEX", Buffer.from("Tileset\\Stub\\Ground.blp\0", "latin1"))];
  for (let index = 0; index < 256; index++) {
    const layers = layersOf(index);
    const payload = Buffer.alloc(128 + layers * 16);
    payload.writeUInt32LE(index % 16, 0x04);
    payload.writeUInt32LE(Math.floor(index / 16), 0x08);
    payload.writeUInt32LE(layers, 0x0c);
    payload.writeUInt32LE(128, 0x1c);
    parts.push(chunk("MCNK", payload));
  }
  return Buffer.concat(parts);
}

const realDbc = (() => {
  try {
    const directory = dbcDirectory();
    return existsSync(join(directory, "Map.dbc")) ? directory : undefined;
  } catch {
    return undefined;
  }
})();

/** A client with Gundrak (604) tile 27/29 a stub and 28/29 a partial tile; nothing else. */
async function fixture() {
  const box = await mkdtemp(join(tmpdir(), "webclient-splat-stub-"));
  const client = join(box, "client");
  const dbc = join(box, "dbc");
  const maps = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "World", "Maps", "GunDrak");
  await mkdir(maps, { recursive: true });
  await mkdir(dbc, { recursive: true });
  await copyFile(join(realDbc, "Map.dbc"), join(dbc, "Map.dbc"));
  await writeFile(join(maps, "GunDrak_29_27.adt"), adt(() => 0));
  await writeFile(join(maps, "GunDrak_29_28.adt"), adt((index) => (index === 5 ? 0 : 1)));
  return {
    box, client, dbc, stubAdt: join(maps, "GunDrak_29_27.adt"),
    textures: join(box, "terrain-textures"), layers: join(box, "terrain-layers"),
  };
}

/** Runs `publishTerrainSplat` in this process against the fixture, with env pointed at it. */
async function publishIn(paths, map, x, y) {
  const saved = {};
  const env = {
    CLIENT_DIR: paths.client, CLIENT_PACK_DIR: "", DBC_DIR: paths.dbc,
    TERRAIN_TEXTURE_DIR: paths.textures, TERRAIN_LAYER_DIR: paths.layers,
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  const [{ publishTerrainSplat }, { openClientArchives }] = await Promise.all([
    import("../tools/generate-terrain-splat.mjs"), import("../tools/mpq.mjs"),
  ]);
  const archives = await openClientArchives(paths.client);
  try {
    return await publishTerrainSplat(map, x, y, archives).then(() => undefined, (error) => error);
  } finally {
    archives.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("generator: a stub tile writes a stamped .nosplat and says «missing»; a partial tile publishes; no ADT is «missing» without a marker", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const paths = await fixture();
  try {
    const stub = await publishIn(paths, 604, 27, 29);
    assert.ok(stub instanceof SourceMissing, `stub: ${stub?.message}`);
    const marker = join(paths.textures, "604", "27-29.nosplat");
    assert.equal((await readFile(marker)).length, 0, "the marker is empty");
    const stamp = JSON.parse(await readFile(`${marker}.src`, "utf8"));
    assert.ok(stamp.sources.some((source) => /GunDrak_29_27\.adt$/i.test(source.path)), "stamped with its ADT");
    assert.ok(!existsSync(join(paths.textures, "604", "27-29.splat.json")), "no splat for a stub");

    const partial = await publishIn(paths, 604, 28, 29);
    assert.equal(partial, undefined, `partial: ${partial?.message}`);
    const index = await readFile(join(paths.textures, "604", "28-29.index.png"));
    assert.ok(index.length > 0, "a partial tile is published");
    assert.ok(!existsSync(join(paths.textures, "604", "28-29.nosplat")), "and gets no marker");

    const absent = await publishIn(paths, 604, 40, 40);
    assert.ok(absent instanceof SourceMissing, `no ADT: ${absent?.message}`);
    assert.ok(!existsSync(join(paths.textures, "604", "40-40.nosplat")), "no ADT writes no marker");
  } finally {
    await rm(paths.box, { recursive: true, force: true });
  }
});

async function get(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { origin: ORIGIN } });
  await response.arrayBuffer();
  return response.status;
}

test("route: «missing» from the generator is a remembered 404, a crash is a 500", async () => {
  const textures = await mkdtemp(join(tmpdir(), "webclient-splat-route-"));
  let calls = 0;
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
    allowedOrigins: [ORIGIN], terrainTexturesDirectory: textures,
    generateTerrainSplat: async (map) => {
      calls++;
      throw Object.assign(new Error("no"), { exitCode: map === 604 ? 3 : 1 });
    },
  });
  try {
    assert.equal(await get(gateway.port, "/terrain-splat/604/27/29"), 404);
    assert.equal(await get(gateway.port, "/terrain-splat/604/27/29"), 404);
    assert.equal(calls, 1, "the second 404 comes from the lane's memory, not a second run");
    assert.equal(await get(gateway.port, "/terrain-splat/1/30/30"), 500);
  } finally {
    await gateway.close();
    await rm(textures, { recursive: true, force: true });
  }
});

test("route: a current .nosplat answers 404 without the generator across restarts; a stale one is deleted", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const paths = await fixture();
  let calls = 0;
  const start = () => startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
    allowedOrigins: [ORIGIN], terrainTexturesDirectory: paths.textures,
    clientDirectory: paths.client, dbcDirectory: paths.dbc, datasetPollMs: 0,
    generateTerrainSplat: async () => {
      calls++;
      throw Object.assign(new Error("crashed"), { exitCode: 1 });
    },
  });
  try {
    assert.ok((await publishIn(paths, 604, 27, 29)) instanceof SourceMissing);
    const marker = join(paths.textures, "604", "27-29.nosplat");
    for (let restart = 0; restart < 2; restart++) {
      const gateway = await start();
      try {
        assert.equal(await get(gateway.port, "/terrain-splat/604/27/29"), 404);
        assert.equal(await get(gateway.port, "/terrain-splat/604/27/29/alpha.png"), 404);
      } finally {
        await gateway.close();
      }
    }
    assert.equal(calls, 0, "the marker answered; the generator never ran");

    // A module repaints the tile: the ADT's stamp no longer matches, so the marker goes and the
    // generator is asked again.
    const later = new Date(Date.now() + 60_000);
    await writeFile(paths.stubAdt, adt(() => 1));
    await utimes(paths.stubAdt, later, later);
    const gateway = await start();
    try {
      assert.equal(await get(gateway.port, "/terrain-splat/604/27/29"), 500);
    } finally {
      await gateway.close();
    }
    assert.equal(calls, 1, "a stale marker no longer answers");
    assert.ok(!existsSync(marker), "and is deleted");
  } finally {
    await rm(paths.box, { recursive: true, force: true });
  }
});

test("TerrainSplatClient: a 404 is final and quiet — no error status, no second request", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const statuses = [];
  globalThis.fetch = async () => {
    requests++;
    return new Response("", { status: 404 });
  };
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    client.onStatus = (message, error) => statuses.push({ message, error });
    client.setActiveTiles(604, [{ x: 27, y: 29 }]);
    client.get(604, { x: 27, y: 29 });
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
    client.get(604, { x: 27, y: 29 });
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.deepEqual(statuses.filter((status) => status.error), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
