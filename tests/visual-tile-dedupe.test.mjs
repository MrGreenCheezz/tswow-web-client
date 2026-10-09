import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// P2-04x: `visual-tile-v6` writes each non-WMO record only into the tile of its point, unless that
// tile cannot carry it (off the map, no ADT, or its ADT does not list the placement / the doodad's
// parent WMO). WMO placements stay in every tile that lists them; a map that is one WMO is untouched.
// Over any footprint the union of ids is the v5 union.

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

/** An M2 at world (x, y): the ADT stores rawZ = mid − x, rawX = mid − y. */
function mddf(id, x, y) {
  const record = Buffer.alloc(36);
  record.writeUInt32LE(0, 0); record.writeUInt32LE(id, 4);
  record.writeFloatLE(WORLD_MID - y, 8); record.writeFloatLE(5, 12); record.writeFloatLE(WORLD_MID - x, 16);
  record.writeUInt16LE(1024, 32);
  return record;
}

/** The inn (uniqueId 7) at world (x, y), set 0, its box `half` yards around it. */
function modf(x, y, half = 300) {
  const record = Buffer.alloc(64);
  record.writeUInt32LE(0, 0); record.writeUInt32LE(7, 4);
  record.writeFloatLE(WORLD_MID - y, 8); record.writeFloatLE(5, 12); record.writeFloatLE(WORLD_MID - x, 16);
  const low = [WORLD_MID - y - half, -10, WORLD_MID - x - half], high = [WORLD_MID - y + half, 10, WORLD_MID - x + half];
  [...low, ...high].forEach((value, index) => record.writeFloatLE(value, 32 + index * 4));
  return record;
}

function adt(m2s, wmos) {
  return Buffer.concat([
    chunk("MVER", Buffer.from([18, 0, 0, 0])),
    chunk("MMDX", Buffer.from(`${TREE}\0`, "latin1")), chunk("MMID", Buffer.alloc(4)),
    chunk("MWMO", Buffer.from(`${WMO}\0`, "latin1")), chunk("MWID", Buffer.alloc(4)),
    chunk("MDDF", Buffer.concat(m2s)), chunk("MODF", Buffer.concat(wmos)),
  ]);
}

/** A WDT whose one global object is the inn at the map's middle (MPHD flag 0x1). */
function wdt() {
  const mphd = Buffer.alloc(32);
  mphd.writeUInt32LE(1, 0);
  const record = modf(0, 0, 300);
  record.writeFloatLE(WORLD_MID, 8); record.writeFloatLE(WORLD_MID, 16);
  return Buffer.concat([chunk("MVER", Buffer.from([18, 0, 0, 0])), chunk("MPHD", mphd),
    chunk("MWMO", Buffer.from(`${WMO}\0`, "latin1")), chunk("MODF", record)]);
}

/** Set 0: doodad 0 at the inn's origin, doodad 1 110 yards to world +x (the MODD x is negated). */
function wmoRoot() {
  const mohd = Buffer.alloc(64);
  mohd.writeUInt32LE(2, 4);
  const sets = Buffer.alloc(32);
  sets.writeUInt32LE(0, 20); sets.writeUInt32LE(2, 24);
  const placements = Buffer.alloc(80);
  for (const [index, offsetX] of [0, -110].entries()) {
    placements.writeUInt32LE(0, index * 40);
    placements.writeFloatLE(offsetX, index * 40 + 4);
    placements.writeFloatLE(1, index * 40 + 28);
    placements.writeFloatLE(1, index * 40 + 32);
  }
  return Buffer.concat([chunk("MOHD", mohd), chunk("MODS", sets), chunk("MODN", Buffer.from("World\\Lamp.m2\0", "latin1")),
    chunk("MODD", placements)]);
}

function group(flags, references) {
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  const refs = Buffer.alloc(references.length * 2);
  references.forEach((reference, index) => refs.writeUInt16LE(reference, index * 2));
  return chunk("MOGP", Buffer.concat([header, chunk("MODR", refs)]));
}

// Tile 32/32 is world x ∈ (−533⅓, 0], tile 31/32 is x ∈ (0, 533⅓], tile 33/32 x ∈ (−1066⅔, −533⅓] —
// and 33/32 has no ADT. y = −10 keeps every point in grid row 32.
const Y = -10;
function world({ global = false } = {}) {
  const files = new Map([
    [WMO.toLowerCase(), wmoRoot()],
    ["world\\wmo\\test\\inn_000.wmo", group(0x2000, [0])],
    ["world\\wmo\\test\\inn_001.wmo", group(0x2000, [1])],
  ]);
  if (global) files.set("world\\maps\\azeroth\\azeroth.wdt", wdt());
  else {
    files.set("world\\maps\\azeroth\\azeroth_32_32.adt", adt([
      mddf(11, -10, Y), // own tile
      mddf(12, 100, Y), // owned by 31/32, which lists it
      mddf(13, -700, Y), // owned by 33/32, which has no ADT
      mddf(14, 200, Y), // owned by 31/32, which does not list it
      mddf(15, 20_000, Y), // off the map
      mddf(16, -20, Y), // own tile; 31/32 lists it too
    ], [modf(-10, Y)]));
    files.set("world\\maps\\azeroth\\azeroth_32_31.adt", adt([mddf(12, 100, Y), mddf(16, -20, Y)], [modf(-10, Y)]));
  }
  return {
    read: async (path) => files.get(path.toLowerCase()),
    sourceOf: async (path) => (files.has(path.toLowerCase()) ? { path, name: "test.MPQ", kind: "archive" } : undefined),
    chainDigest: () => "test-chain",
  };
}

async function publish(gridX, generation, options) {
  const box = await mkdtemp(join(tmpdir(), "webclient-visual-tile-dedupe-"));
  const saved = { tiles: process.env.VISUAL_TILE_DIR, cache: process.env.WMO_DOODAD_CACHE_DIR };
  process.env.VISUAL_TILE_DIR = join(box, "tiles");
  process.env.WMO_DOODAD_CACHE_DIR = join(box, "doodads");
  try {
    const { publishVisualTile } = await import("../tools/generate-visual-tile.mjs");
    const result = await publishVisualTile(0, gridX, 32, world(options), { generation });
    const tile = join(box, "tiles", "0", `${gridX}-32.json`);
    return { result, objects: JSON.parse(await readFile(tile, "utf8")), stamp: JSON.parse(await readFile(`${tile}.src`, "utf8")) };
  } finally {
    if (saved.tiles === undefined) delete process.env.VISUAL_TILE_DIR; else process.env.VISUAL_TILE_DIR = saved.tiles;
    if (saved.cache === undefined) delete process.env.WMO_DOODAD_CACHE_DIR; else process.env.WMO_DOODAD_CACHE_DIR = saved.cache;
    await rm(box, { recursive: true, force: true });
  }
}

const ids = (objects) => objects.map((object) => object.id);

test("v6 keeps a record in its own tile, or where its own tile cannot carry it; the inn stays in both", { skip: !hasDataset }, async () => {
  const home = await publish(32, "visual-tile-v6");
  assert.deepEqual(ids(home.objects), [11, 13, 14, 15, 16, 7, -7_000_001],
    "12 and the inn's far doodad live in 31/32; 13 (no ADT there), 14 (not listed there) and 15 (off the map) stay");
  assert.equal(home.result.doodads, 1);
  const west = await publish(31, "visual-tile-v6");
  assert.deepEqual(ids(west.objects), [12, 7, -7_000_002], "16 and the near doodad live in 32/32");
  assert.ok(home.stamp.sources.some((source) => /azeroth_32_31\.adt$/i.test(source.path)),
    "the neighbour ADT the decision read is a source of the tile");
});

test("over both tiles the ids are exactly v5's; v5 itself still carries the copies", { skip: !hasDataset }, async () => {
  const v6 = new Set([...ids((await publish(32, "visual-tile-v6")).objects), ...ids((await publish(31, "visual-tile-v6")).objects)]);
  const homeV5 = await publish(32, "visual-tile-v5");
  const westV5 = await publish(31, "visual-tile-v5");
  const v5 = new Set([...ids(homeV5.objects), ...ids(westV5.objects)]);
  assert.deepEqual([...v6].sort(), [...v5].sort());
  assert.deepEqual(ids(homeV5.objects), [11, 12, 13, 14, 15, 16, 7, -7_000_001, -7_000_002], "v5 bytes unchanged");
  assert.equal(homeV5.stamp.generation, "visual-tile-v5");
});

test("a map that is one WMO keeps every doodad its cell's copy expands", { skip: !hasDataset }, async () => {
  const { objects } = await publish(32, "visual-tile-v6", { global: true });
  assert.deepEqual(ids(objects), [7, -7_000_001, -7_000_002], "the far doodad (own cell 31/32) stays: no ADT, no dedupe");
});
