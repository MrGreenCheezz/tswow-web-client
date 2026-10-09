import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 05.10-A7b-1 — one bump of the visual tile (M-A7b-1): `visual-tile-v5` carries the effective doodad
// set (7.02), outdoor-owned WMO doodads as scenery (7.03 slice 1), `wmoId`/`nameSet` (7.13) and the
// truncation sidecar (7.19). A gateway that names no generation (one still running v4, whose asset
// worker loads the tools fresh from disk) must keep receiving exactly what it got before.

const hasDataset = (() => {
  try {
    return existsSync(join(process.env.DBC_DIR ?? "", "Map.dbc")) || existsSync("F:/tswowRoot/tswow-install");
  } catch {
    return false;
  }
})();

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const WMO = "World\\wmo\\Test\\Inn.wmo";
const TREE = "World\\Tree.m2";
const WORLD_MID = 0.5 * 64 * 533.33333333;

/** Map 0 cell 32/32: one M2 and one WMO placed with doodad set 1, name set 3. */
function adt() {
  const mmdx = Buffer.from(`${TREE}\0`, "latin1");
  const mwmo = Buffer.from(`${WMO}\0`, "latin1");
  const mddf = Buffer.alloc(36);
  mddf.writeUInt32LE(0, 0); mddf.writeUInt32LE(11, 4);
  mddf.writeFloatLE(WORLD_MID + 10, 8); mddf.writeFloatLE(5, 12); mddf.writeFloatLE(WORLD_MID + 10, 16);
  mddf.writeUInt16LE(1024, 32);
  const modf = Buffer.alloc(64);
  modf.writeUInt32LE(0, 0); modf.writeUInt32LE(7, 4);
  modf.writeFloatLE(WORLD_MID + 20, 8); modf.writeFloatLE(5, 12); modf.writeFloatLE(WORLD_MID + 20, 16);
  for (const [index, value] of [-10, -10, -10, 10, 10, 10].entries()) modf.writeFloatLE(WORLD_MID + 20 + value, 32 + index * 4);
  modf.writeUInt16LE(1, 58);
  modf.writeUInt16LE(3, 60);
  return Buffer.concat([
    chunk("MVER", Buffer.from([18, 0, 0, 0])),
    chunk("MMDX", mmdx), chunk("MMID", Buffer.alloc(4)),
    chunk("MWMO", mwmo), chunk("MWID", Buffer.alloc(4)),
    chunk("MDDF", mddf), chunk("MODF", modf),
  ]);
}

/** Set 0 = records 0–1, set 1 = records 2–(2 + extra + 1); two groups: 0 outdoor (owns 0), 1 indoor. */
function wmoRoot(extra = 1) {
  const count = 3 + extra;
  const mohd = Buffer.alloc(64);
  mohd.writeUInt32LE(2, 4);
  mohd.writeUInt32LE(4711, 32);
  const sets = Buffer.alloc(64);
  sets.writeUInt32LE(0, 20); sets.writeUInt32LE(2, 24);
  sets.writeUInt32LE(2, 52); sets.writeUInt32LE(count - 2, 56);
  const names = Buffer.from("World\\Lamp.m2\0World\\Chair.m2\0", "latin1");
  const placements = Buffer.alloc(40 * count);
  for (let index = 0; index < count; index++) {
    placements.writeUInt32LE(index === 0 ? 0 : "World\\Lamp.m2\0".length, index * 40);
    placements.writeFloatLE(index, index * 40 + 4);
    placements.writeFloatLE(1, index * 40 + 28);
    placements.writeFloatLE(1, index * 40 + 32);
  }
  return Buffer.concat([chunk("MOHD", mohd), chunk("MODS", sets), chunk("MODN", names), chunk("MODD", placements)]);
}

function group(flags, references) {
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  const refs = Buffer.alloc(references.length * 2);
  references.forEach((reference, index) => refs.writeUInt16LE(reference, index * 2));
  return chunk("MOGP", Buffer.concat([header, chunk("MODR", refs)]));
}

function archives(extra) {
  const files = new Map([
    ["world\\maps\\azeroth\\azeroth_32_32.adt", adt()],
    [WMO.toLowerCase(), wmoRoot(extra)],
    ["world\\wmo\\test\\inn_000.wmo", group(0x8, [0])],
    ["world\\wmo\\test\\inn_001.wmo", group(0x2000, [1, 2])],
  ]);
  return {
    read: async (path) => files.get(path.toLowerCase()),
    sourceOf: async (path) => (files.has(path.toLowerCase()) ? { path, name: "test.MPQ", kind: "archive" } : undefined),
    chainDigest: () => "test-chain",
  };
}

async function publish(options, extra = 1, viaJob = false) {
  const box = await mkdtemp(join(tmpdir(), "webclient-visual-tile-v5-"));
  const saved = { tiles: process.env.VISUAL_TILE_DIR, cache: process.env.WMO_DOODAD_CACHE_DIR };
  process.env.VISUAL_TILE_DIR = join(box, "tiles");
  process.env.WMO_DOODAD_CACHE_DIR = join(box, "doodads");
  try {
    const { publishVisualTile } = await import("../tools/generate-visual-tile.mjs");
    const result = viaJob
      // The worker's way in (tools/asset-jobs.mjs): the gateway's job names the generation, or none.
      ? await (await import("../tools/asset-jobs.mjs")).runAssetJob(
        { kind: "visual-tile", map: 0, gridX: 32, gridY: 32, ...(options ?? {}) }, archives(extra))
      : await publishVisualTile(0, 32, 32, archives(extra), options);
    const tile = join(box, "tiles", "0", "32-32.json");
    const caches = await readdir(join(box, "doodads"));
    return {
      result,
      objects: JSON.parse(await readFile(tile, "utf8")),
      stamp: JSON.parse(await readFile(`${tile}.src`, "utf8")),
      meta: existsSync(join(box, "tiles", "0", "32-32.meta.json"))
        ? JSON.parse(await readFile(join(box, "tiles", "0", "32-32.meta.json"), "utf8")) : undefined,
      caches: await Promise.all(caches.filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(join(box, "doodads", name), "utf8")))),
    };
  } finally {
    if (saved.tiles === undefined) delete process.env.VISUAL_TILE_DIR; else process.env.VISUAL_TILE_DIR = saved.tiles;
    if (saved.cache === undefined) delete process.env.WMO_DOODAD_CACHE_DIR; else process.env.WMO_DOODAD_CACHE_DIR = saved.cache;
    await rm(box, { recursive: true, force: true });
  }
}

test("a job without a generation is the v4 tile, field for field (an older gateway's request)", { skip: !hasDataset }, async () => {
  const { objects, stamp, meta, caches } = await publish(undefined);
  assert.equal(stamp.generation, "visual-tile-v4");
  const wmo = objects.find((object) => object.kind === "wmo");
  assert.deepEqual(Object.keys(wmo),
    ["id", "kind", "name", "x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale", "doodadSet", "bounds"],
    "no wmoId, no nameSet");
  const doodads = objects.filter((object) => object.id < 0);
  assert.deepEqual(doodads.map((object) => object.id), [-7_000_001, -7_000_002], "set 1 alone, ordinals 0 and 1");
  assert.ok(doodads.every((object) => object.interior === true));
  assert.equal(meta, undefined);
  assert.equal(caches.length, 1);
  assert.equal(caches[0].version, 1, "the v1 doodad cache");
  assert.ok(caches[0].sets.flat().every((doodad) => !("index" in doodad)));
});

test("visual-tile-v5: set 0 joins the placement's set, outdoor-owned doodads are scenery, wmoId/nameSet travel", { skip: !hasDataset }, async () => {
  const { objects, stamp, meta, caches, result } = await publish({ generation: "visual-tile-v5" });
  assert.equal(stamp.generation, "visual-tile-v5");
  const wmo = objects.find((object) => object.kind === "wmo");
  assert.equal(wmo.wmoId, 4711, "MOHD.wmoID");
  assert.equal(wmo.nameSet, 3, "MODF.nameSet");
  const doodads = objects.filter((object) => object.id < 0);
  assert.deepEqual(doodads.map((object) => object.id), [-7_000_001, -7_000_002, -7_000_003, -7_000_004],
    "set 0's two records first, then set 1's two");
  assert.deepEqual(doodads.map((object) => object.interior), [false, true, true, true],
    "record 0 is owned only by the outdoor group; record 1 by the indoor one; 2 and 3 by the indoor one or none");
  assert.equal(meta, undefined, "a tile that fits writes no sidecar");
  assert.equal(result.truncated, 0);
  assert.equal(caches.length, 1);
  assert.equal(caches[0].version, 2, "the v2 doodad cache, its own file");
  assert.deepEqual(caches[0].sets[1].map((doodad) => doodad.index), [0, 1, 2, 3]);
  await assert.rejects(publish({ generation: "visual-tile-v7" }), /Unknown visual tile generation/);
});

test("the 10,000-object cap is counted into a sidecar under v5 and stays silent under v4 (7.19)", { skip: !hasDataset }, async () => {
  // 2 placements + set 0 (2) + set 1 (10,499): 10,503 objects for 10,000 slots.
  const v5 = await publish({ generation: "visual-tile-v5" }, 10_498);
  assert.equal(v5.objects.length, 10_000);
  assert.deepEqual(v5.meta, { truncated: 503 });
  assert.equal(v5.result.truncated, 503);
  const v4 = await publish(undefined, 10_498);
  assert.equal(v4.objects.length, 10_000);
  assert.equal(v4.meta, undefined, "the old generation writes nothing new");
});

test("the asset worker passes the job's generation through, and a job without one stays v4", { skip: !hasDataset }, async () => {
  assert.equal((await publish({ generation: "visual-tile-v5" }, 1, true)).stamp.generation, "visual-tile-v5");
  assert.equal((await publish(undefined, 1, true)).stamp.generation, "visual-tile-v4");
});

test("one generation name in the generator, the gateway, its configuration and the client", () => {
  const generator = readFileSync("tools/generate-visual-tile.mjs", "utf8");
  const gatewaySide = readFileSync("src/gateway/VisualTileGeneration.ts", "utf8");
  const gateway = readFileSync("src/gateway/Gateway.ts", "utf8");
  const configuration = readFileSync("src/gateway/GatewayConfiguration.ts", "utf8");
  const pregenerate = readFileSync("tools/pregenerate.mjs", "utf8");
  const decoder = readFileSync("src/browser/EnvironmentTileDecode.ts", "utf8");
  const name = generator.match(/export const VISUAL_TILE_GENERATION = "(visual-tile-v\d+)"/)?.[1];
  assert.equal(name, "visual-tile-v6"); // P2-04x
  assert.match(gatewaySide, new RegExp(`VISUAL_TILE_GENERATION = "${name}"`));
  assert.match(pregenerate, new RegExp(`VISUAL_TILE_GENERATION = "${name}"`));
  assert.equal(decoder.match(/VISUAL_TILE_ROUTE_VERSION = (\d+)/)?.[1], name.replace("visual-tile-v", ""),
    "the client's ?v= is the generation number");
  // Every freshness check of the route and the preloader names it; no literal v4 left behind.
  assert.equal(gateway.match(/ensureCurrent\(.*\{ generation: VISUAL_TILE_GENERATION \}/g)?.length, 3);
  assert.doesNotMatch(gateway, /visual-tile-v4/);
  assert.match(configuration, /kind: "visual-tile", map, gridX, gridY, generation: VISUAL_TILE_GENERATION/);
  assert.match(configuration, /"generate-visual-tile\.mjs", \[String\(map\), String\(gridX\), String\(gridY\), VISUAL_TILE_GENERATION\]/);
});

test("the WMO namespace turns over with the tile: visual-wmo-v25 in the gateway and in the tools' key", async () => {
  const { visualModelNamespace } = await import("../tools/visual-model-key.mjs");
  assert.equal(visualModelNamespace("World\\wmo\\Test\\Inn.WMO"), "visual-wmo-v25");
  assert.equal(visualModelNamespace("World\\Tree.m2"), "visual-v23", "M2 artifacts are untouched");
  const gateway = readFileSync("src/gateway/Gateway.ts", "utf8");
  assert.match(gateway, /endsWith\("\.wmo"\) \? "visual-wmo-v25" : "visual-v23"/);
  const model = readFileSync("tools/generate-visual-model.mjs", "utf8");
  assert.match(model, /const effectiveDoodadSets = hash === visualModelHash\(requestedPath\) \|\| hash === visualModelHash\(modelPath\);/,
    "the effective room tables only for a hash of the new namespace — a v22 request keeps its bytes");
});

test("/terrain-texture is documented as unused by the browser and the browser does not ask for it", () => {
  const gateway = readFileSync("src/gateway/Gateway.ts", "utf8");
  assert.match(gateway, /not used by the browser[\s\S]{0,200}terrain-texture/);
  const offenders = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(entry) && readFileSync(path, "utf8").includes("terrain-texture")) offenders.push(path);
    }
  };
  walk("src/browser");
  assert.deepEqual(offenders, []);
});
