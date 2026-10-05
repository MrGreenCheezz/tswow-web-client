import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visualTileTruncation } from "../dist/code/gateway/VisualTileGeneration.js";

// 05.10 review A7b-1 (7.19): the `<x>-<y>.meta.json` sidecar beside a visual tile is the only thing
// the gateway's `X-Tile-Truncated` reads, so it must say what the *current* tile lost: a v5 rebuild
// that fits removes a sidecar an earlier cut left behind, and the reader takes only a positive count.

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

/** Map 0 cell 32/32 with one M2 and no WMO: a tile that always fits. */
function adt() {
  const mddf = Buffer.alloc(36);
  mddf.writeUInt32LE(0, 0); mddf.writeUInt32LE(11, 4);
  const mid = 0.5 * 64 * 533.33333333;
  mddf.writeFloatLE(mid + 10, 8); mddf.writeFloatLE(5, 12); mddf.writeFloatLE(mid + 10, 16);
  mddf.writeUInt16LE(1024, 32);
  return Buffer.concat([
    chunk("MVER", Buffer.from([18, 0, 0, 0])),
    chunk("MMDX", Buffer.from("World\\Tree.m2\0", "latin1")), chunk("MMID", Buffer.alloc(4)),
    chunk("MWMO", Buffer.alloc(0)), chunk("MWID", Buffer.alloc(0)),
    chunk("MDDF", mddf), chunk("MODF", Buffer.alloc(0)),
  ]);
}

const archives = {
  read: async (path) => (path.toLowerCase() === "world\\maps\\azeroth\\azeroth_32_32.adt" ? adt() : undefined),
  sourceOf: async (path) => (path.toLowerCase().endsWith(".adt") ? { path, name: "test.MPQ", kind: "archive" } : undefined),
  chainDigest: () => "test-chain",
};

async function withTiles(run) {
  const box = await mkdtemp(join(tmpdir(), "webclient-visual-tile-sidecar-"));
  const saved = { tiles: process.env.VISUAL_TILE_DIR, cache: process.env.WMO_DOODAD_CACHE_DIR };
  process.env.VISUAL_TILE_DIR = join(box, "tiles");
  process.env.WMO_DOODAD_CACHE_DIR = join(box, "doodads");
  try {
    await mkdir(join(box, "tiles", "0"), { recursive: true });
    return await run(join(box, "tiles", "0"));
  } finally {
    if (saved.tiles === undefined) delete process.env.VISUAL_TILE_DIR; else process.env.VISUAL_TILE_DIR = saved.tiles;
    if (saved.cache === undefined) delete process.env.WMO_DOODAD_CACHE_DIR; else process.env.WMO_DOODAD_CACHE_DIR = saved.cache;
    await rm(box, { recursive: true, force: true });
  }
}

test("a v5 tile that fits removes the sidecar an earlier cut left; the v4 path never touches it", { skip: !hasDataset }, async () => {
  const { publishVisualTile } = await import("../tools/generate-visual-tile.mjs");
  await withTiles(async (directory) => {
    const meta = join(directory, "32-32.meta.json");
    await writeFile(meta, JSON.stringify({ truncated: 503 }));
    await publishVisualTile(0, 32, 32, archives);
    assert.ok(existsSync(meta), "an older gateway's v4 rebuild writes and removes nothing new");
    const result = await publishVisualTile(0, 32, 32, archives, { generation: "visual-tile-v5" });
    assert.equal(result.truncated, 0);
    assert.equal(existsSync(meta), false, "the stale count would otherwise reach X-Tile-Truncated");
    assert.equal(await visualTileTruncation(join(directory, "32-32.json")), 0);
  });
});

test("visualTileTruncation reads only a positive integer count from the sidecar", async () => {
  await withTiles(async (directory) => {
    const tile = join(directory, "1-2.json");
    const meta = join(directory, "1-2.meta.json");
    assert.equal(await visualTileTruncation(tile), 0, "no sidecar");
    for (const [body, expected] of [
      [JSON.stringify({ truncated: 503 }), 503],
      [JSON.stringify({ truncated: 0 }), 0],
      [JSON.stringify({ truncated: -4 }), 0],
      [JSON.stringify({ truncated: 2.5 }), 0],
      [JSON.stringify({ truncated: "9" }), 0],
      [JSON.stringify(null), 0],
      ["{torn", 0],
    ]) {
      await writeFile(meta, body);
      assert.equal(await visualTileTruncation(tile), expected, body);
    }
  });
});
