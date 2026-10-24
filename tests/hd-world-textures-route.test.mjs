// 23.10 (7.48 step 2): the world set's compressed copies on `/terrain-layer` and `/visual/texture` (gateway/HdTextures.ts):
// only to an `hd=` request, only for a texture the manifest lists with a compressed copy and only while its stamp is
// current; a ground layer is found by its id, a building texture by the digest of the original PNG the route serves;
// no file is ever named by the request; the world set's PNGs are never answered; switched off, nothing changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { IMMUTABLE, REVALIDATE } from "../dist/code/gateway/CachePolicy.js";
import {
  HD_TEXTURE_CONTENT_TYPE, HdTextureSets, hdTextureId, terrainLayerIds, worldIndexOf,
} from "../dist/code/gateway/HdTextures.js";

const ORIGIN = "http://127.0.0.1:5173";
const GROUND = "tileset\\elwynn\\elwynngrassbase.blp";
const WALL = "world\\generic\\human\\passive doodads\\wall.blp";
const SHA1 = (text) => createHash("sha1").update(text).digest("hex");
const LAYER_ID = SHA1(`terrain-layer-v1\0${GROUND}`);
const WMO = "0123456789abcdef0123456789abcdef01234567-3";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "webclient-hd-world-"));
  const client = join(root, "client");
  const layers = join(root, "layers");
  const visual = join(root, "visual");
  const hd = join(root, "hd");
  await mkdir(join(client, "Data"), { recursive: true });
  await writeFile(join(client, "Data", "common.MPQ"), "MPQ-test");
  await mkdir(layers);
  await mkdir(visual);
  await writeFile(join(layers, `${LAYER_ID}.png`), "PNG-ground");
  await writeFile(join(visual, `${WMO}.png`), "PNG-wall");
  await writeFile(join(visual, "1111111111111111111111111111111111111111-0.png"), "PNG-other-building");
  await mkdir(join(hd, "world"), { recursive: true });
  await writeFile(join(hd, "world", "manifest.json"), JSON.stringify({ schema: "hd-textures-1", entries: {
    [GROUND]: { scale: 2, compressed: { pipeline: "x", bytes: 4 } },
    [WALL]: { scale: 2, compressed: { pipeline: "x", bytes: 4, originalPng: SHA1("PNG-wall") } },
    "tileset\\elwynn\\nocopy.blp": { scale: 2 },
  } }));
  await writeFile(join(hd, "world", `${hdTextureId(GROUND)}.wht`), "WHT1-ground");
  await writeFile(join(hd, "world", `${hdTextureId(WALL)}.wht`), "WHT1-wall");
  await writeFile(join(hd, "world", `${hdTextureId(WALL)}.png`), "PNG-intermediate");
  return { root, client, layers, visual, hd };
}

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
const get = (base, path) => fetch(`${base}${path}`, { headers: { origin: ORIGIN } });

test("a ground layer asked for with hd= is answered with its compressed copy; without hd=, or stale, the original", async () => {
  const { root, client, layers, visual, hd } = await fixture();
  let current = true;
  try {
    await withGateway({
      clientDirectory: client, terrainLayersDirectory: layers, visualModelsDirectory: visual,
      hdTextures: { sets: new HdTextureSets(hd, { refreshMs: 0 }), isCurrent: async () => current },
    }, async (base) => {
      const { cacheGeneration: g, hdTextureGeneration: hg } = await status(base);
      const plain = await get(base, `/terrain-layer/${LAYER_ID}.png?g=${g}`);
      assert.equal(await plain.text(), "PNG-ground", "no hd=: byte-identical to before");
      assert.equal(plain.headers.get("content-type"), "image/png");

      const hdAnswer = await get(base, `/terrain-layer/${LAYER_ID}.png?g=${g}&hd=${hg}`);
      assert.equal(await hdAnswer.text(), "WHT1-ground");
      assert.equal(hdAnswer.headers.get("content-type"), HD_TEXTURE_CONTENT_TYPE);
      assert.equal(hdAnswer.headers.get("cache-control"), IMMUTABLE, "under this cache and HD generation");
      assert.equal((await get(base, `/terrain-layer/${LAYER_ID}.png?hd=${hg}`)).headers.get("cache-control"), REVALIDATE);
      assert.equal((await get(base, `/terrain-layer/${LAYER_ID}.png?g=${g}&hd=0000`)).headers.get("cache-control"), REVALIDATE);

      // The v2 id of the same path (a texture that is not 256²) is the same copy.
      assert.equal(await (await get(base, `/terrain-layer/${terrainLayerIds(GROUND)[1]}.png?hd=${hg}`)).text(), "WHT1-ground");
      // An id no listed path has: the original route (here: not there at all).
      assert.equal((await get(base, `/terrain-layer/${"f".repeat(40)}.png?hd=${hg}`)).status, 404);
      current = false;
      const stale = await get(base, `/terrain-layer/${LAYER_ID}.png?g=${g}&hd=${hg}`);
      assert.equal(await stale.text(), "PNG-ground", "a stamp that no longer matches: the original");
      assert.equal(stale.headers.get("cache-control"), REVALIDATE, "and revalidated, as hd= was asked");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a building texture is found by the original PNG's digest; another building's is not; the world PNGs are never served", async () => {
  const { root, client, layers, visual, hd } = await fixture();
  try {
    await withGateway({
      clientDirectory: client, terrainLayersDirectory: layers, visualModelsDirectory: visual,
      texturesDirectory: join(root, "textures"),
      hdTextures: { sets: new HdTextureSets(hd, { refreshMs: 0 }), isCurrent: async () => true },
    }, async (base) => {
      const { hdTextureGeneration: hg } = await status(base);
      assert.equal(await (await get(base, `/visual/texture/${WMO}.png`)).text(), "PNG-wall");
      const hdAnswer = await get(base, `/visual/texture/${WMO}.png?hd=${hg}`);
      assert.equal(await hdAnswer.text(), "WHT1-wall");
      assert.equal(hdAnswer.headers.get("content-type"), HD_TEXTURE_CONTENT_TYPE);
      assert.equal(hdAnswer.headers.get("cache-control"), REVALIDATE);
      assert.equal(await (await get(base, `/visual/texture/1111111111111111111111111111111111111111-0.png?hd=${hg}`)).text(),
        "PNG-other-building");
      // The world set's PNG is the compressor's input: an effects-style request for the same path gets nothing from it.
      const effect = await get(base, `/texture?path=${encodeURIComponent(WALL)}&hd=${hg}`);
      assert.notEqual(effect.status === 200 ? await effect.text() : "", "PNG-intermediate");
      // A changed building PNG (republished) is digested again: no longer the listed one, so the original.
      await writeFile(join(visual, `${WMO}.png`), "PNG-wall-changed");
      assert.equal(await (await get(base, `/visual/texture/${WMO}.png?hd=${hg}`)).text(), "PNG-wall-changed");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switched off: hd= is ignored on both world routes", async () => {
  const { root, client, layers, visual } = await fixture();
  try {
    await withGateway({ clientDirectory: client, terrainLayersDirectory: layers, visualModelsDirectory: visual }, async (base) => {
      assert.equal(await (await get(base, `/terrain-layer/${LAYER_ID}.png?hd=x`)).text(), "PNG-ground");
      assert.equal(await (await get(base, `/visual/texture/${WMO}.png?hd=x`)).text(), "PNG-wall");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 24.10 (7.48 step 3): a scenery model's texture on `/texture?path=…&hd=` — the world set's compressed copy.
test("a scenery texture asked for on /texture with hd= is its compressed copy; ground, no copy, stale or off: the original", async () => {
  const { root, client, layers, visual, hd } = await fixture();
  const textures = join(root, "textures");
  await mkdir(textures);
  const original = (path) => join(textures, `${SHA1(`texture-v1\0${path.toLowerCase()}`)}.png`);
  const NO_COPY = "world\\azeroth\\elwynn\\nocopy.blp";
  await writeFile(original(WALL), "PNG-wall-texture");
  await writeFile(original(GROUND), "PNG-ground-texture");
  await writeFile(original(NO_COPY), "PNG-no-copy");
  let current = true;
  const ask = (base, path, query = "") => get(base, `/texture?path=${encodeURIComponent(path)}${query}`);
  try {
    await withGateway({
      clientDirectory: client, terrainLayersDirectory: layers, visualModelsDirectory: visual, texturesDirectory: textures,
      hdTextures: { sets: new HdTextureSets(hd, { refreshMs: 0 }), isCurrent: async () => current },
    }, async (base) => {
      const { visualGeneration: vg, hdTextureGeneration: hg } = await status(base);
      const plain = await ask(base, WALL, `&vg=${vg}`);
      assert.equal(await plain.text(), "PNG-wall-texture", "no hd=: byte-identical to before");
      assert.equal(plain.headers.get("content-type"), "image/png");

      const hdAnswer = await ask(base, WALL, `&vg=${vg}&hd=${hg}`);
      assert.equal(await hdAnswer.text(), "WHT1-wall");
      assert.equal(hdAnswer.headers.get("content-type"), HD_TEXTURE_CONTENT_TYPE);
      assert.equal(hdAnswer.headers.get("cache-control"), IMMUTABLE, "under the visual and the HD generation");
      assert.equal((await ask(base, WALL, `&vg=${vg}&hd=00000000000000000000`)).headers.get("cache-control"), REVALIDATE);
      assert.equal(await (await ask(base, "World/Generic/Human/Passive Doodads/WALL.BLP", `&hd=${hg}`)).text(), "WHT1-wall",
        "another spelling of the same path");

      const ground = await ask(base, GROUND, `&hd=${hg}`);
      assert.equal(await ground.text(), "PNG-ground-texture", "a ground copy is laid out for the terrain array: never on /texture");
      assert.equal(ground.headers.get("content-type"), "image/png");
      assert.equal(await (await ask(base, NO_COPY, `&hd=${hg}`)).text(), "PNG-no-copy", "the set has no copy: the original");

      current = false;
      const stale = await ask(base, WALL, `&vg=${vg}&hd=${hg}`);
      assert.equal(await stale.text(), "PNG-wall-texture", "a stamp that no longer matches: the original");
      assert.equal(stale.headers.get("cache-control"), REVALIDATE);
    });
    await withGateway({ clientDirectory: client, visualModelsDirectory: visual, texturesDirectory: textures }, async (base) => {
      assert.equal(await (await ask(base, WALL, "&hd=x")).text(), "PNG-wall-texture", "switched off: hd= is ignored");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the world index lists only entries with a compressed copy, only well-formed digests", () => {
  const index = worldIndexOf(JSON.stringify({ entries: {
    [GROUND]: { compressed: {} },
    "tileset\\a\\none.blp": {},
    [WALL]: { compressed: { originalPng: SHA1("x") } },
    "world\\bad.blp": { compressed: { originalPng: "../../etc" } },
  } }));
  assert.deepEqual([...new Set(index.terrainLayers.values())], [GROUND]);
  assert.deepEqual(new Set(index.terrainLayers.keys()), new Set(terrainLayerIds(GROUND)));
  assert.deepEqual([...index.buildingPngs], [[SHA1("x"), WALL]]);
  // 24.10 (7.48 step 3): `/texture` may answer every compressed entry but the ground.
  assert.deepEqual([...index.modelTextures].sort(), ["world\\bad.blp", WALL]);
  assert.equal(worldIndexOf("not json").terrainLayers.size, 0);
  assert.equal(worldIndexOf("not json").modelTextures.size, 0);
});
