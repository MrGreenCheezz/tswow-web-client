import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ASSET_FAMILIES, ASSET_JOBS, runAssetJob } from "../tools/asset-jobs.mjs";
import { repositoryRoot } from "../tools/paths.mjs";
import {
  ASSET_JOB_FAMILY, createAssetWorkers, parseAssetWorkers,
} from "../dist/code/gateway/AssetWorkers.js";

// 10.20, М-A10-1: one registry of what the persistent worker runs. The gateway spells the same
// list twice — the `AssetWorkerJob` union and `ASSET_JOB_FAMILY` — and all three must agree, or a
// job is sent that the worker calls unknown, or one runs in the wrong family's process.

async function unionKinds() {
  const source = await readFile(join(repositoryRoot, "src/gateway/AssetWorker.ts"), "utf8");
  const union = source.slice(source.indexOf("export type AssetWorkerJob"), source.indexOf(";\n", source.indexOf("export type AssetWorkerJob")));
  return [...union.matchAll(/kind: "([a-z-]+)"/g)].map((match) => match[1]).sort();
}

test("the registry, the gateway's job union and its family table name the same kinds", async () => {
  const registry = Object.keys(ASSET_JOBS).sort();
  assert.deepEqual(await unionKinds(), registry);
  assert.deepEqual(Object.keys(ASSET_JOB_FAMILY).sort(), registry);
  for (const [kind, entry] of Object.entries(ASSET_JOBS)) {
    assert.ok(ASSET_FAMILIES.includes(entry.family), `${kind} names a known family`);
    assert.equal(ASSET_JOB_FAMILY[kind], entry.family, `${kind}: the gateway sends it to the worker it belongs to`);
    assert.equal(typeof entry.load, "function");
    assert.equal(typeof entry.run, "function");
  }
  // Long jobs are kept apart from short ones: inside a worker jobs run one at a time.
  for (const kind of ["terrain-splat", "visual-tile", "horizon"]) assert.equal(ASSET_JOBS[kind].family, "tile");
  for (const kind of ["texture", "item-icon", "spell-icon", "creature-icon", "client-file"]) {
    assert.equal(ASSET_JOBS[kind].family, "texture");
  }
});

test("every registered generator exports the publish function its entry calls", async () => {
  const expected = {
    texture: "publishTexture", "visual-model": "publishVisualModel", "item-icon": "publishItemIcon",
    "spell-icon": "publishSpellIcon", "creature-icon": "publishCreatureIcon", "minimap-index": "publishMinimapIndex",
    "zone-map": "publishWorldMapZoneMap", liquid: "publishLiquidTexture", "client-file": "publishClientFile",
    "terrain-splat": "publishTerrainSplat", "visual-tile": "publishVisualTile", horizon: "publishHorizon",
    "tile-models": "publishTileModels",
    "horizon-colour": "publishHorizonColour", // 05.10-A7b-7
    "liquid-family": "publishLiquidFamily", // 05.10-A7b-8
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(ASSET_JOBS).sort());
  for (const [kind, name] of Object.entries(expected)) {
    const module = await ASSET_JOBS[kind].load();
    assert.equal(typeof module[name], "function", `${kind}: ${name} is exported`);
  }
});

test("an unknown kind is refused rather than ignored", async () => {
  await assert.rejects(runAssetJob({ kind: "toString" }, undefined), /Unknown asset job/);
  await assert.rejects(runAssetJob({ kind: "sound" }, undefined), /Unknown asset job/);
});

test("ASSET_WORKERS: 0 is none, unset or 1 is every family, a list is those, a typo is an error", () => {
  assert.deepEqual([...parseAssetWorkers("0")], []);
  assert.deepEqual([...parseAssetWorkers(undefined)].sort(), ["model", "texture", "tile"]);
  assert.deepEqual([...parseAssetWorkers("1")].sort(), ["model", "texture", "tile"]);
  assert.deepEqual([...parseAssetWorkers(" texture, model ")].sort(), ["model", "texture"]);
  assert.throws(() => parseAssetWorkers("textures"), /unknown family/);
  const none = createAssetWorkers({ env: { ASSET_WORKERS: "0" }, cwd: repositoryRoot });
  assert.equal(none.run({ kind: "texture", path: "a.blp" }), undefined, "no worker: the caller runs the one-shot generator");
  assert.equal(none.handles("horizon"), false);
  const some = createAssetWorkers({ env: { ASSET_WORKERS: "model" }, cwd: repositoryRoot });
  assert.equal(some.handles("visual-model"), true);
  assert.equal(some.handles("item-icon"), false);
  some.close();
  assert.equal(some.handles("visual-model"), false, "a closed set hands nothing to a worker");
});
