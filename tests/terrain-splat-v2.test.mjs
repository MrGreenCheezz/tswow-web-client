// 05.10-A7b-7 (7.06 + 7.16, M-A7b-1): the `terrain-splat-v2` generation of the ground splat.
//   * 7.06 — MCSH, the shadow the world editor baked into each chunk, rides in the alpha of
//     `alpha.png` (255 lit, 0 shadow), on the alpha map's own raster;
//   * 7.16 — a ground texture that is not 256² is resampled (box down, wrapping bilinear up) under a
//     `terrain-layer-v2` id, and `splat.json` names the array's `layerSize`;
//   * a job without a generation (a gateway still running the old route) keeps its exact files.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";

import { startGateway } from "../dist/code/gateway/Gateway.js";
import { MCNK_HAS_SHADOW, mapChunkShadow } from "../tools/adt-alpha.mjs";
import { blpSize, resampledLayerPng } from "../tools/generate-terrain-splat.mjs";
import { dbcDirectory } from "../tools/paths.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the generation is one string in the generator, the gateway, its job and pregenerate", async () => {
  const tool = /export const TERRAIN_SPLAT_GENERATION = "([^"]+)"/.exec(await read("tools/generate-terrain-splat.mjs"))?.[1];
  const gateway = /export const TERRAIN_SPLAT_GENERATION = "([^"]+)"/.exec(await read("src/gateway/TerrainSplatGeneration.ts"))?.[1];
  const pregenerate = /const TERRAIN_SPLAT_GENERATION = "([^"]+)"/.exec(await read("tools/pregenerate.mjs"))?.[1];
  assert.equal(tool, "terrain-splat-v2");
  assert.equal(gateway, tool);
  assert.equal(pregenerate, tool);
  const route = await read("src/gateway/Gateway.ts");
  assert.match(route, /ensureCurrent\(filename, \{ generation: TERRAIN_SPLAT_GENERATION \}/, "the route asks for the generation");
  const configuration = await read("src/gateway/GatewayConfiguration.ts");
  assert.match(configuration, /kind: "terrain-splat", map, gridX, gridY, generation: TERRAIN_SPLAT_GENERATION/, "the job names it");
  assert.match(configuration, /"generate-terrain-splat\.mjs", \[String\(map\), String\(gridX\), String\(gridY\), TERRAIN_SPLAT_GENERATION\]/,
    "and so does the command-line fallback");
  const jobs = await read("tools/asset-jobs.mjs");
  const entry = jobs.slice(jobs.indexOf('"terrain-splat": {'), jobs.indexOf('"visual-tile": {'));
  assert.match(entry, /job\.generation === undefined \? undefined : \{ generation: String\(job\.generation\) \}/,
    "the worker passes it on");
});

/** A chunk of an ADT, `tag` as it reads, stored reversed like the client stores it. */
function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * One MCNK payload: a 128-byte header, `layers` MCLY records (texture ids from `textures`), and an
 * MCSH block when `shadow` (a function of x, y) is given. Offsets count from the chunk's tag, as
 * the client's do.
 */
function mapChunk(index, { textures = [0], shadow, flag = shadow !== undefined } = {}) {
  const header = Buffer.alloc(128);
  const layers = Buffer.alloc(textures.length * 16);
  textures.forEach((texture, at) => layers.writeUInt32LE(texture, at * 16));
  let mcsh = Buffer.alloc(0);
  if (shadow) {
    const bits = Buffer.alloc(512);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) if (shadow(x, y)) bits[y * 8 + (x >> 3)] |= 1 << (x & 7);
    }
    mcsh = chunk("MCSH", bits);
  }
  header.writeUInt32LE(flag ? MCNK_HAS_SHADOW | 0x8000 : 0x8000, 0x00);
  header.writeUInt32LE(index % 16, 0x04);
  header.writeUInt32LE(Math.floor(index / 16), 0x08);
  header.writeUInt32LE(textures.length, 0x0c);
  header.writeUInt32LE(128, 0x1c);
  if (shadow) {
    // The tag sits right after the layers; the offset names the byte after the tag's own eight.
    header.writeUInt32LE(128 + layers.length + 8, 0x2c);
    header.writeUInt32LE(512, 0x30);
  }
  return Buffer.concat([header, layers, mcsh]);
}

test("mapChunkShadow: 64x64 bits, row y at byte y*8, column x at bit x&7, lowest bit first", () => {
  // Shadow on column 5 of row 2 only — its transpose (column 2, row 5) must stay lit.
  const payload = mapChunk(0, { shadow: (x, y) => x === 5 && y === 2 });
  const shadow = mapChunkShadow(payload, 0, payload.length);
  assert.equal(shadow.length, 4096);
  assert.equal(shadow[2 * 64 + 5], 1);
  assert.equal(shadow[5 * 64 + 2], 0, "not transposed");
  assert.equal(shadow.reduce((sum, bit) => sum + bit, 0), 1);
  // The last column of a row is bit 7 of its eighth byte.
  const edge = mapChunk(0, { shadow: (x, y) => x === 63 && y === 0 });
  assert.equal(mapChunkShadow(edge, 0, edge.length)[63], 1);
});

test("mapChunkShadow: no flag, no offset or no MCSH tag is no shadow", () => {
  const unflagged = mapChunk(0, { shadow: () => true, flag: false });
  assert.equal(mapChunkShadow(unflagged, 0, unflagged.length), undefined);
  const bare = mapChunk(0);
  assert.equal(mapChunkShadow(bare, 0, bare.length), undefined);
  const wrongTag = mapChunk(0, { shadow: () => true });
  wrongTag.write("XXXX", 128 + 16, "latin1");
  assert.equal(mapChunkShadow(wrongTag, 0, wrongTag.length), undefined);
  const short = mapChunk(0, { shadow: () => true });
  assert.equal(mapChunkShadow(short, 0, short.length - 100), undefined, "a block past the chunk's end");
});

/** A raw BGRA BLP2 (no alpha), `colour(x, y)` → [r, g, b]. */
function blp(width, height, colour) {
  const header = Buffer.alloc(148);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 3;
  header.writeUInt32LE(width, 12);
  header.writeUInt32LE(height, 16);
  header.writeUInt32LE(148, 20);
  header.writeUInt32LE(width * height * 4, 84);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      pixels.set([b, g, r, 255], (y * width + x) * 4);
    }
  }
  return Buffer.concat([header, pixels]);
}

test("blpSize reads the header only", () => {
  assert.deepEqual(blpSize(blp(16, 8, () => [0, 0, 0])), { width: 16, height: 8 });
  assert.equal(blpSize(Buffer.from("not a blp at all, no")), undefined);
  assert.equal(blpSize(undefined), undefined);
});

function decoded(width, height, colour) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

test("resampledLayerPng: a big texture is box-averaged to 512, nothing dropped", () => {
  // 1024² of 2x2 blocks [0, 200; 100, 50] → every output texel is their mean, 87.5 → 88.
  const png = resampledLayerPng(decoded(1024, 1024, (x, y) => {
    const value = [[0, 200], [100, 50]][y & 1][x & 1];
    return [value, value, value];
  }), 0);
  assert.equal(png.width, 512);
  assert.equal(png.height, 512);
  for (const pixel of [0, 1, 511, 512 * 300 + 77]) assert.equal(png.data[pixel * 4], 88);
  assert.equal(png.data[3], 255);
});

test("resampledLayerPng: a small texture is filtered up to 256 and wraps at its edges", () => {
  // Columns 0..15 hold 0, 16, …, 240: output column 0 sits at source x −0.46875, between column 15
  // (240) and column 0 (0) — the texture repeats, so its left edge blends with its right.
  const png = resampledLayerPng(decoded(16, 16, (x) => [x * 16, 0, 0]), 0);
  assert.equal(png.width, 256);
  assert.equal(Math.abs(png.data[0] - Math.round(240 * 0.46875)) <= 1, true, `wrapped edge: ${png.data[0]}`);
  // Output column 136 samples source x 8.03: column 8's own value (128) and a thirty-second of the next.
  assert.ok(Math.abs(png.data[136 * 4] - 128.5) <= 0.5, `column 136: ${png.data[136 * 4]}`);
  // Smooth, not blocky: neighbours inside one source texel differ.
  assert.notEqual(png.data[130 * 4], png.data[140 * 4]);
});

test("resampledLayerPng: a strip below 512² of pixels stays at 256 (768x128 does not quadruple its tile)", () => {
  const png = resampledLayerPng(decoded(768, 128, (x, y) => [x % 256, y, 7]), 0);
  assert.equal(png.width, 256);
  assert.equal(png.height, 256);
  // 3:1 box across: output column 0 averages source columns 0, 1, 2 → 1.
  assert.equal(png.data[0], 1);
  assert.equal(png.data[2], 7);
});

const realDbc = (() => {
  try {
    const directory = dbcDirectory();
    return existsSync(join(directory, "Map.dbc")) ? directory : undefined;
  } catch {
    return undefined;
  }
})();

/**
 * A client with one ADT of Gundrak (604), tile 28/29: chunk 0 has a shadow on its left half, chunk
 * 1 is flagged with no bit set, chunk 2 has no MCSH; chunks 3.. draw the 16x16 texture.
 */
async function fixture() {
  const box = await mkdtemp(join(tmpdir(), "webclient-splat-v2-"));
  const client = join(box, "client");
  const dbc = join(box, "dbc");
  const data = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
  const maps = join(data, "World", "Maps", "GunDrak");
  const tileset = join(data, "Tileset", "Test");
  await mkdir(maps, { recursive: true });
  await mkdir(tileset, { recursive: true });
  await mkdir(dbc, { recursive: true });
  await copyFile(join(realDbc, "Map.dbc"), join(dbc, "Map.dbc"));
  await writeFile(join(tileset, "Big.blp"), blp(256, 256, (x, y) => [x, y, 9]));
  await writeFile(join(tileset, "Small.blp"), blp(16, 16, (x) => [x * 16, 3, 5]));
  const parts = [chunk("MTEX", Buffer.from("Tileset\\Test\\Big.blp\0Tileset\\Test\\Small.blp\0", "latin1"))];
  for (let index = 0; index < 256; index++) {
    if (index === 0) parts.push(chunk("MCNK", mapChunk(index, { shadow: (x) => x < 32 })));
    else if (index === 1) parts.push(chunk("MCNK", mapChunk(index, { shadow: () => false })));
    else if (index === 2) parts.push(chunk("MCNK", mapChunk(index)));
    else parts.push(chunk("MCNK", mapChunk(index, { textures: [1] })));
  }
  await writeFile(join(maps, "GunDrak_29_28.adt"), Buffer.concat(parts));
  return { box, client, dbc };
}

/** Runs `publishTerrainSplat` in this process with env pointed at the fixture and `out`. */
async function publishInto(paths, out, generation) {
  const saved = {};
  const env = {
    CLIENT_DIR: paths.client, CLIENT_PACK_DIR: "", DBC_DIR: paths.dbc,
    TERRAIN_TEXTURE_DIR: join(out, "textures"), TERRAIN_LAYER_DIR: join(out, "layers"),
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
    await publishTerrainSplat(604, 28, 29, archives, generation === undefined ? undefined : { generation });
  } finally {
    archives.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const tile = (part) => join(out, "textures", "604", `28-29.${part}`);
  const splat = JSON.parse(await readFile(tile("splat.json"), "utf8"));
  return {
    splat,
    alphaBytes: await readFile(tile("alpha.png")),
    alpha: PNG.sync.read(await readFile(tile("alpha.png"))),
    stamp: JSON.parse(await readFile(`${tile("alpha.png")}.src`, "utf8")),
    index: await readFile(tile("index.png")),
    cover: await readFile(tile("cover.bin")),
    layer: async (id) => readFile(join(out, "layers", `${id}.png`)),
  };
}

test("generator: v2 writes MCSH into the alpha, resamples the odd layer, names layerSize; legacy is untouched", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const paths = await fixture();
  try {
    const legacy = await publishInto(paths, join(paths.box, "legacy"));
    const v2 = await publishInto(paths, join(paths.box, "v2"), "terrain-splat-v2");

    // Legacy: RGB alpha map, no generation in the stamp, v1 ids, no layerSize.
    assert.equal(legacy.alphaBytes[25], 2, "legacy alpha.png is colour type 2 (RGB)");
    assert.equal(legacy.stamp.generation, undefined);
    assert.equal(legacy.splat.layerSize, undefined);
    assert.equal(v2.alphaBytes[25], 6, "v2 alpha.png is colour type 6 (RGBA)");
    assert.equal(v2.stamp.generation, "terrain-splat-v2");
    assert.equal(v2.splat.layerSize, 256);

    // Chunk 0 (row 0, column 0): left half in shadow → alpha 0; right half lit → 255.
    const a = (x, y) => v2.alpha.data[(y * 1024 + x) * 4 + 3];
    assert.equal(a(0, 0), 0);
    assert.equal(a(31, 63), 0);
    assert.equal(a(32, 0), 255);
    // Chunk 1 (column 1) flagged with no bit, chunk 2 without MCSH: lit throughout.
    assert.equal(a(64, 10), 255);
    assert.equal(a(128 + 5, 5), 255);
    let shadowed = 0;
    for (let pixel = 0; pixel < 1024 * 1024; pixel++) if (v2.alpha.data[pixel * 4 + 3] === 0) shadowed++;
    assert.equal(shadowed, 32 * 64, "exactly chunk 0's left half");
    // The blend channels are the same bytes in both generations.
    for (let pixel = 0; pixel < 1024 * 1024; pixel += 997) {
      for (let channel = 0; channel < 3; channel++) {
        assert.equal(v2.alpha.data[pixel * 4 + channel], legacy.alpha.data[pixel * 4 + channel]);
      }
    }
    assert.deepEqual(v2.index, legacy.index, "index.png unchanged");
    assert.deepEqual(v2.cover, legacy.cover, "cover.bin unchanged");

    // 256² keeps its v1 id and its exact file; the 16x16 gets a v2 id and a filtered 256² picture.
    assert.equal(v2.splat.layers[0], legacy.splat.layers[0]);
    assert.deepEqual(await v2.layer(v2.splat.layers[0]), await legacy.layer(legacy.splat.layers[0]));
    assert.notEqual(v2.splat.layers[1], legacy.splat.layers[1]);
    const small = PNG.sync.read(await v2.layer(v2.splat.layers[1]));
    const point = PNG.sync.read(await legacy.layer(legacy.splat.layers[1]));
    assert.equal(small.width, 256);
    assert.equal(point.data[130 * 4], point.data[140 * 4], "legacy point-samples: one source texel is a 16-wide block");
    assert.notEqual(small.data[130 * 4], small.data[140 * 4], "v2 filters inside the block");
  } finally {
    await rm(paths.box, { recursive: true, force: true });
  }
});

const ORIGIN = "http://127.0.0.1:5173";

test("route: a splat published without the generation is rebuilt once as v2, then served as it stands", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const paths = await fixture();
  const out = join(paths.box, "data");
  let calls = 0;
  try {
    await publishInto(paths, out); // what an older gateway left on disk
    const gateway = await startGateway({
      host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
      allowedOrigins: [ORIGIN], terrainTexturesDirectory: join(out, "textures"),
      clientDirectory: paths.client, dbcDirectory: paths.dbc, datasetPollMs: 0,
      generateTerrainSplat: async () => {
        calls++;
        await publishInto(paths, out, "terrain-splat-v2");
      },
    });
    try {
      const get = async (path) => {
        const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers: { origin: ORIGIN } });
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
      };
      const splat = await get("/terrain-splat/604/28/29?v=2");
      assert.equal(splat.status, 200);
      assert.equal(JSON.parse(splat.body.toString("utf8")).layerSize, 256, "the v2 splat.json");
      assert.equal(calls, 1, "the unversioned file was stale for this gateway");
      const alpha = await get("/terrain-splat/604/28/29/alpha.png?v=2");
      assert.equal(alpha.status, 200);
      assert.equal(alpha.body[25], 6, "RGBA: the baked shadow rides along");
      assert.equal((await get("/terrain-splat/604/28/29/index.png")).status, 200);
      assert.equal(calls, 1, "the v2 files are current: no second run");
    } finally {
      await gateway.close();
    }
  } finally {
    await rm(paths.box, { recursive: true, force: true });
  }
});
