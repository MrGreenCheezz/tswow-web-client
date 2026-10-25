// 22.10 (6.26): restart-stable asset generations (gateway/AssetGeneration.ts). Character models, sidecars, textures
// and the display/appearance answers are immutable under the generation the gateway publishes, which moves with what
// they are made of and not with the process.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { IMMUTABLE, REVALIDATE } from "../dist/code/gateway/CachePolicy.js";
import {
  assetCacheControl, gatewayCodeIdentity, metadataGeneration, visualGeneration,
} from "../dist/code/gateway/AssetGeneration.js";
import { dbcDirectory } from "../tools/paths.mjs";

const ORIGIN = "http://127.0.0.1:5173";
const visualInput = { archivesHash: "a1", chain: "c1", namespaces: ["visual-v24", "visual-wmo-v27", "texture-v1"], coordinatedVisuals: true };

test("the visual generation names the archive chain and the namespaces, and nothing else", () => {
  const value = visualGeneration(visualInput);
  assert.match(value, /^[0-9a-f]{20}$/);
  assert.equal(visualGeneration({ ...visualInput }), value, "the same inputs, the same value: a restart keeps it");
  assert.equal(visualGeneration({ ...visualInput, namespaces: [...visualInput.namespaces].reverse() }), value, "order-free");
  for (const changed of [{ archivesHash: "a2" }, { chain: "c2" }, { coordinatedVisuals: false },
    { namespaces: ["visual-v25", "visual-wmo-v27", "texture-v1"] }]) {
    assert.notEqual(visualGeneration({ ...visualInput, ...changed }), value, JSON.stringify(changed));
  }
  assert.equal(visualGeneration({ ...visualInput, archivesHash: undefined }), undefined, "no archive walk: no promise");
});

test("the metadata generation moves with the code, the DBC half and the visual generation", () => {
  const input = { codeIdentity: "k1", dbcHash: "d1", visualGeneration: "v1" };
  const value = metadataGeneration(input);
  assert.match(value, /^[0-9a-f]{20}$/);
  assert.equal(metadataGeneration({ ...input }), value);
  for (const changed of [{ codeIdentity: "k2" }, { dbcHash: "d2" }, { visualGeneration: "v2" }]) {
    assert.notEqual(metadataGeneration({ ...input, ...changed }), value, JSON.stringify(changed));
  }
  assert.equal(metadataGeneration({ ...input, dbcHash: undefined }), undefined);
  assert.equal(metadataGeneration({ ...input, visualGeneration: undefined }), undefined);
});

test("assetCacheControl: immutable only for the current generation", () => {
  assert.equal(assetCacheControl("g1", "g1", REVALIDATE), IMMUTABLE);
  assert.equal(assetCacheControl("g0", "g1", REVALIDATE), REVALIDATE, "another generation is not pinned");
  assert.equal(assetCacheControl(null, "g1", "no-store"), "no-store", "a page that names none is served as before");
  assert.equal(assetCacheControl("g1", undefined, REVALIDATE), REVALIDATE, "no generation, no promise");
  assert.equal(assetCacheControl(undefined, undefined, REVALIDATE), REVALIDATE);
});

test("the code identity changes with a module's bytes and with nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-code-identity-"));
  try {
    await mkdir(join(root, "gateway"));
    await mkdir(join(root, "world"));
    await writeFile(join(root, "gateway", "A.js"), "export const a = 1;");
    await writeFile(join(root, "world", "B.js"), "export const b = 1;");
    await writeFile(join(root, "gateway", "notes.txt"), "not code");
    const first = await gatewayCodeIdentity(root);
    assert.equal(await gatewayCodeIdentity(root), first);
    await writeFile(join(root, "gateway", "notes.txt"), "still not code");
    assert.equal(await gatewayCodeIdentity(root), first, "a file that is not a module is not the code");
    await writeFile(join(root, "world", "B.js"), "export const b = 2;");
    assert.notEqual(await gatewayCodeIdentity(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withGateway(options, run) {
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], datasetPollMs: 0, ...options,
  });
  try {
    return await run(`http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
  }
}

const status = async (base) => (await fetch(`${base}/client/patch-status?summary=1`, { headers: { origin: ORIGIN } })).json();

test("/client/patch-status publishes both generations; a restart keeps them, an archive change moves the visual one", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-asset-generation-client-"));
  const dbc = await mkdtemp(join(tmpdir(), "webclient-asset-generation-dbc-"));
  try {
    await mkdir(join(client, "Data"));
    await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
    for (const name of ["BattlemasterList.dbc", "Map.dbc"]) await copyFile(join(dbcDirectory(), name), join(dbc, name));
    const options = { clientDirectory: client, dbcDirectory: dbc };
    const first = await withGateway(options, status);
    assert.match(first.visualGeneration, /^[0-9a-f]{20}$/);
    assert.match(first.metadataGeneration, /^[0-9a-f]{20}$/);
    const second = await withGateway(options, status);
    assert.equal(second.visualGeneration, first.visualGeneration, "a restart is not a new visual generation");
    assert.equal(second.metadataGeneration, first.metadataGeneration, "nor a new metadata generation");
    assert.notEqual(second.cacheGeneration, first.cacheGeneration, "unlike the tile generation, which names the process");

    // A DBC rewrite moves the metadata generation at once (no restart), the visual one not at all.
    await withGateway(options, async (base) => {
      const before = await status(base);
      const later = new Date(Date.now() + 5_000);
      await utimes(join(dbc, "Map.dbc"), later, later);
      const after = await status(base);
      assert.equal(after.visualGeneration, before.visualGeneration);
      assert.notEqual(after.metadataGeneration, before.metadataGeneration);
    });

    // A patch archive rewritten: the next process serves a new visual generation (this one latches; Gateway.ts).
    const later = new Date(Date.now() + 10_000);
    await utimes(join(client, "Data", "common.MPQ"), later, later);
    const third = await withGateway(options, status);
    assert.notEqual(third.visualGeneration, first.visualGeneration);
    assert.notEqual(third.metadataGeneration, first.metadataGeneration, "the metadata generation contains the visual one");
  } finally {
    await rm(client, { recursive: true, force: true });
    await rm(dbc, { recursive: true, force: true });
  }
});

test("/texture and /visual/model are immutable under vg=<visualGeneration>, revalidated otherwise", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-asset-generation-client-"));
  const textures = await mkdtemp(join(tmpdir(), "webclient-asset-generation-textures-"));
  const models = await mkdtemp(join(tmpdir(), "webclient-asset-generation-models-"));
  try {
    await mkdir(join(client, "Data"));
    await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
    const texturePath = "Character\\Human\\Male\\HumanMaleSkin00_00.blp";
    const textureId = createHash("sha1").update(`texture-v1\0${texturePath.toLowerCase()}`).digest("hex");
    await writeFile(join(textures, `${textureId}.png`), "PNG-skin");
    const modelPath = "Character\\Human\\Male\\HumanMale.m2";
    const modelId = createHash("sha1").update(`visual-v24\0${modelPath.toLowerCase()}`).digest("hex");
    await writeFile(join(models, `${modelId}.bin`), "WVM-test");
    await writeFile(join(models, `${modelId}.anim.bin`), "WVA-test");
    await withGateway({ clientDirectory: client, texturesDirectory: textures, visualModelsDirectory: models }, async (base) => {
      const { visualGeneration: vg } = await status(base);
      const ask = (route, query) => fetch(`${base}${route}${query}`, { headers: { origin: ORIGIN } });
      for (const [route, path, body] of [["/texture", texturePath, "PNG-skin"], ["/visual/model", modelPath, "WVM-test"],
        ["/visual/animations", modelPath, "WVA-test"]]) {
        const query = `?path=${encodeURIComponent(path)}&v=3`;
        const pinned = await ask(route, `${query}&vg=${vg}`);
        assert.equal(pinned.status, 200, route);
        assert.equal(await pinned.text(), body);
        assert.equal(pinned.headers.get("cache-control"), IMMUTABLE, `${route} under this generation`);
        // 25.10 (serve S1): + Accept-Encoding on a compressible type (ResponseCompression.ts).
        assert.match(pinned.headers.get("vary") ?? "", /^Origin(, Accept-Encoding)?$/, "an immutable copy echoes one Origin, so it varies on it");
        assert.equal((await ask(route, query)).headers.get("cache-control"), REVALIDATE, `${route} without vg, as before`);
        assert.equal((await ask(route, `${query}&vg=00000000000000000000`)).headers.get("cache-control"), REVALIDATE,
          `${route} under another generation`);
        const tag = pinned.headers.get("etag");
        const again = await fetch(`${base}${route}${query}&vg=${vg}`, { headers: { origin: ORIGIN, "if-none-match": tag } });
        assert.equal(again.status, 304);
        assert.equal(again.headers.get("cache-control"), IMMUTABLE);
      }
    });
  } finally {
    for (const directory of [client, textures, models]) await rm(directory, { recursive: true, force: true });
  }
});

test("/dbc/creature-models and /dbc/character-appearance are immutable under mg=<metadataGeneration>, no-store otherwise", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-asset-generation-client-"));
  try {
    await mkdir(join(client, "Data"));
    await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
    await withGateway({ clientDirectory: client, dbcDirectory: dbcDirectory() }, async (base) => {
      const { metadataGeneration: mg } = await status(base);
      assert.match(mg, /^[0-9a-f]{20}$/);
      const ask = (path) => fetch(`${base}${path}`, { headers: { origin: ORIGIN } });
      const appearance = "/dbc/character-appearance?v=15&race=1&sex=0&skin=0&face=0&hair=0&hairColor=0&facialHair=0";
      for (const path of ["/dbc/creature-models?v=14&ids=49", appearance]) {
        const pinned = await ask(`${path}&mg=${mg}`);
        assert.equal(pinned.status, 200, path);
        assert.equal(pinned.headers.get("cache-control"), IMMUTABLE, path);
        assert.equal(pinned.headers.get("vary"), "Origin, Accept-Encoding"); // 25.10 (serve S1): JSON is compressible
        assert.equal((await ask(path)).headers.get("cache-control"), "no-store", `${path} without mg, as before`);
        assert.equal((await ask(`${path}&mg=00000000000000000000`)).headers.get("cache-control"), "no-store");
      }
    });
  } finally {
    await rm(client, { recursive: true, force: true });
  }
});
