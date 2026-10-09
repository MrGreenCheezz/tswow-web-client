import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { AssetWorker } from "../dist/code/gateway/AssetWorker.js";
import { assetWorkerSlot, createAssetWorkers } from "../dist/code/gateway/AssetWorkers.js";
import { repositoryRoot } from "../tools/paths.mjs";
import { tileModelNames } from "../tools/tile-models.mjs";

// 10.22: the preloader learns which models a tile places from `<x>-<y>.models.json`; a tile
// published before that file existed gets it from the tile worker's `tile-models` job, whose answer
// travels back as the worker reply's `result` — the one kind registered to send one.

const objects = [
  { kind: "wmo", name: "World\\wmo\\Town.wmo" },
  { kind: "m2", name: "World\\Tree.m2" },
  { kind: "m2", name: "WORLD\\TREE.M2", interior: true },
  { kind: "m2", name: "World\\Chair.m2", interior: true },
  { kind: "m2" },
];

test("tileModelNames: distinct by path ignoring case, first spelling, furniture included", () => {
  assert.deepEqual(tileModelNames(objects), ["World\\wmo\\Town.wmo", "World\\Tree.m2", "World\\Chair.m2"]);
});

test("the tile-models job answers the list through `result`, writes it beside the tile with the tile's stamp, and opens no archive", async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-tile-models-"));
  const spawned = [];
  try {
    const tiles = join(box, "visual-tiles", "0");
    await mkdir(tiles, { recursive: true });
    await writeFile(join(tiles, "32-48.json"), JSON.stringify(objects));
    await writeFile(join(tiles, "32-48.json.src"), JSON.stringify({ chain: "c", sources: [], files: [] }));
    const worker = new AssetWorker({
      script: resolve(repositoryRoot, "tools/asset-worker.mjs"), cwd: repositoryRoot, label: "tile-models",
      // No client at all: a job that opened the chain would fail.
      env: { ...process.env, CLIENT_DIR: join(box, "no-client"), CLIENT_PACK_DIR: "", VISUAL_TILE_DIR: join(box, "visual-tiles") },
      track: (child) => { spawned.push(child); return child; },
    });
    try {
      const result = await worker.run({ kind: "tile-models", map: 0, gridX: 32, gridY: 48 }, -1);
      assert.deepEqual(result, ["World\\wmo\\Town.wmo", "World\\Tree.m2", "World\\Chair.m2"]);
      assert.deepEqual(JSON.parse(await readFile(join(tiles, "32-48.models.json"), "utf8")), result);
      assert.equal(await readFile(join(tiles, "32-48.models.json.src"), "utf8"), await readFile(join(tiles, "32-48.json.src"), "utf8"));
      assert.equal(await worker.run({ kind: "tile-models", map: 0, gridX: 1, gridY: 1 }, -1), null, "an unpublished tile");
      assert.ok(!existsSync(join(tiles, "1-1.models.json")));
    } finally {
      worker.close();
    }
  } finally {
    for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(box, { recursive: true, force: true });
  }
});

test("tile-models rides the visual-tile worker instead of starting its own", async () => {
  const spawned = [];
  const workers = createAssetWorkers({
    env: { ...process.env, VISUAL_TILE_DIR: join(tmpdir(), "webclient-tile-models-none") }, cwd: repositoryRoot,
    track: (child) => { spawned.push(child); return child; },
  });
  try {
    assert.equal(await workers.run({ kind: "tile-models", map: 0, gridX: 2, gridY: 2 }, -1), null);
    assert.equal(await workers.run({ kind: "tile-models", map: 0, gridX: 3, gridY: 3 }, -1), null);
    assert.equal(spawned.length, 1);
    assert.equal(assetWorkerSlot("tile-models"), assetWorkerSlot("visual-tile"));
    assert.notEqual(assetWorkerSlot("terrain-splat"), assetWorkerSlot("visual-tile"));
  } finally {
    workers.close();
    for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
