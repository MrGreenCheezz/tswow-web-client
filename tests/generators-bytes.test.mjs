import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AssetWorker } from "../dist/code/gateway/AssetWorker.js";
import { SOURCE_MISSING_EXIT } from "../dist/code/gateway/GenerationLane.js";
import { clientDirectory, dbcDirectory, repositoryRoot } from "../tools/paths.mjs";

// 10.20: a family moved from "one process per miss" onto the persistent worker must publish the
// very same files — bytes and stamps — or every cached entry turns stale on the first restart and
// the browser is handed something the old route never served. Each case runs the command-line
// generator (what `ASSET_WORKERS=0` still does) and the worker into two separate directories and
// compares the two trees file by file.

const encoder = new TextEncoder();

function stringBlock(values) {
  const offsets = new Map();
  const bytes = [0];
  for (const value of values) {
    offsets.set(value, bytes.length);
    bytes.push(...encoder.encode(value), 0);
  }
  return { bytes: Uint8Array.from(bytes), offsets };
}

function dbcFixture(fields, rows, strings) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + strings.byteLength);
  result.set(encoder.encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.byteLength, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) view.setUint32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
  }
  result.set(strings, 20 + rows.length * fields * 4);
  return result;
}

/** A 2x2 palette BLP2 (the smallest thing `tools/blp.mjs` decodes). */
function blp(colour = [10, 20, 30, 255]) {
  const header = Buffer.alloc(148 + 1024);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 1;
  header[11] = 1;
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(148 + 1024, 20);
  header.writeUInt32LE(4, 84);
  for (const [index, entry] of [colour, [200, 100, 50, 255]].entries()) {
    for (let channel = 0; channel < 4; channel++) header[148 + index * 4 + channel] = entry[channel];
  }
  return Buffer.concat([header, Buffer.from([0, 1, 1, 0])]);
}

/** Every file under `directory`, by its relative path, with its bytes. */
async function tree(directory) {
  const files = new Map();
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(directory, path).replaceAll("\\", "/"), await readFile(path));
    }
  };
  if (existsSync(directory)) await walk(directory);
  return files;
}

function assertSameTree(processTree, workerTree, label) {
  assert.ok(processTree.size > 0, `${label}: the generator published something`);
  assert.deepEqual([...workerTree.keys()].sort(), [...processTree.keys()].sort(), `${label}: the same files`);
  for (const [name, bytes] of processTree) {
    assert.ok(workerTree.get(name).equals(bytes), `${label}: ${name} is byte-identical`);
  }
  assert.ok([...processTree.keys()].some((name) => name.endsWith(".src.json") || name.includes(".src")),
    `${label}: stamps are compared too`);
}

const run = promisify(execFile);

/** The command-line generator, as `runAssetGenerator` spawns it. */
function generate(script, args, env) {
  return run(process.execPath, [resolve(repositoryRoot, "tools", script), ...args], { cwd: repositoryRoot, env });
}

/** The persistent worker, as `AssetWorkers` forks it. */
function workerFor(env, spawned) {
  return new AssetWorker({
    script: resolve(repositoryRoot, "tools/asset-worker.mjs"),
    cwd: repositoryRoot, env, label: "bytes",
    track: (child) => { spawned.push(child); return child; },
  });
}

test("icons: the worker publishes the same pictures and stamps as the generator, and says «missing» as a 404", async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-bytes-icons-"));
  const spawned = [];
  try {
    const client = join(box, "client");
    const dbc = join(box, "dbc");
    const patch = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Interface", "Icons");
    await mkdir(patch, { recursive: true });
    await mkdir(dbc, { recursive: true });
    await writeFile(join(patch, "Custom_Fire.blp"), blp());
    await writeFile(join(patch, "Custom_Ice.blp"), blp([90, 140, 230, 255]));
    const strings = stringBlock(["Interface\\Icons\\Custom_Fire", "Interface\\Icons\\Missing", "Custom_Ice"]);
    await writeFile(join(dbc, "SpellIcon.dbc"), dbcFixture(2, [
      [80900, strings.offsets.get("Interface\\Icons\\Custom_Fire")],
      [80901, strings.offsets.get("Interface\\Icons\\Missing")],
    ], strings.bytes));
    const family = Array(28).fill(0);
    family[0] = 61;
    family[27] = strings.offsets.get("Interface\\Icons\\Custom_Fire");
    await writeFile(join(dbc, "CreatureFamily.dbc"), dbcFixture(28, [family], strings.bytes));
    // ItemDisplayInfo in 3.3.5: 25 fields, InventoryIcon[0] is field 5 (the bare name form).
    const display = Array(25).fill(0);
    display[0] = 70000;
    display[5] = strings.offsets.get("Custom_Ice");
    await writeFile(join(dbc, "ItemDisplayInfo.dbc"), dbcFixture(25, [display], strings.bytes));

    const directories = (side) => ({
      SPELL_ICON_DIR: join(box, side, "spell"), CREATURE_ICON_DIR: join(box, side, "family"),
      ITEM_ICON_DIR: join(box, side, "item"),
    });
    const base = { ...process.env, CLIENT_DIR: client, CLIENT_PACK_DIR: "", DBC_DIR: dbc };
    const processEnv = { ...base, ...directories("process") };
    await generate("generate-spell-icons.mjs", ["80900"], processEnv);
    await generate("generate-spell-icons.mjs", ["--family", "61"], processEnv);
    await generate("generate-item-icon.mjs", ["70000"], processEnv);

    const worker = workerFor({ ...base, ...directories("worker") }, spawned);
    try {
      await worker.run({ kind: "spell-icon", iconId: 80900 }, 0);
      await worker.run({ kind: "creature-icon", familyId: 61 }, 0);
      await worker.run({ kind: "item-icon", displayId: 70000 }, 0);
      const missing = await worker.run({ kind: "spell-icon", iconId: 80901 }, 0).catch((error) => error);
      assert.equal(missing.exitCode, SOURCE_MISSING_EXIT, "a row naming a picture the client lacks is «missing»");
      const unknown = await worker.run({ kind: "item-icon", displayId: 1234 }, 0).catch((error) => error);
      assert.equal(unknown.exitCode, SOURCE_MISSING_EXIT, "a display with no row is «missing»");
      assert.equal(spawned.length, 1, "five jobs, one process");
    } finally {
      worker.close();
    }
    assertSameTree(await tree(join(box, "process")), await tree(join(box, "worker")), "icons");
  } finally {
    for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(box, { recursive: true, force: true });
  }
});

function realClient() {
  try {
    const client = clientDirectory();
    const dbc = dbcDirectory();
    return existsSync(join(dbc, "Map.dbc")) && existsSync(join(client, "Data")) ? { client, dbc } : undefined;
  } catch {
    return undefined;
  }
}

const real = realClient();

test("tiles: splat, visual tile and horizon out of the worker match the generators byte for byte (real client)", {
  skip: real ? false : "needs the installed client and dataset",
}, async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-bytes-tiles-"));
  const spawned = [];
  try {
    const directories = (side) => ({
      TERRAIN_TEXTURE_DIR: join(box, side, "terrain-textures"), TERRAIN_LAYER_DIR: join(box, side, "terrain-layers"),
      VISUAL_TILE_DIR: join(box, side, "visual-tiles"), WMO_DOODAD_CACHE_DIR: join(box, side, "wmo-doodads"),
      HORIZON_DIR: join(box, side, "horizon"),
    });
    const base = { ...process.env, CLIENT_DIR: real.client, CLIENT_PACK_DIR: "", DBC_DIR: real.dbc };
    // Goldshire: 6,638 WMO doodads and a painted, ground-covered splat.
    const tile = ["0", "49", "31"];
    const processEnv = { ...base, ...directories("process") };
    await generate("generate-terrain-splat.mjs", tile, processEnv);
    await generate("generate-visual-tile.mjs", tile, processEnv);
    await generate("generate-horizon.mjs", ["0"], processEnv);

    const worker = workerFor({ ...base, ...directories("worker") }, spawned);
    try {
      await worker.run({ kind: "terrain-splat", map: 0, gridX: 49, gridY: 31 }, 0);
      await worker.run({ kind: "visual-tile", map: 0, gridX: 49, gridY: 31 }, 0);
      await worker.run({ kind: "horizon", map: 0 }, 0);
      // A second tile through the same process: nothing of the first one's state leaks into it.
      await worker.run({ kind: "horizon", map: 1 }, 0);
    } finally {
      worker.close();
    }
    await generate("generate-horizon.mjs", ["1"], processEnv);
    assertSameTree(await tree(join(box, "process")), await tree(join(box, "worker")), "tiles");
    // 10.22: the tile's model list, computed here independently of `tools/tile-models.mjs`, with the
    // tile's own stamp.
    const tiles = join(box, "process", "visual-tiles", "0");
    const objects = JSON.parse(await readFile(join(tiles, "49-31.json"), "utf8"));
    const expected = [];
    for (const object of objects) {
      if (!expected.some((name) => name.toLowerCase() === object.name.toLowerCase())) expected.push(object.name);
    }
    assert.deepEqual(JSON.parse(await readFile(join(tiles, "49-31.models.json"), "utf8")), expected);
    assert.ok(expected.some((name) => /\.wmo$/i.test(name)) && expected.some((name) => /\.m2$/i.test(name)),
      "Goldshire places both kinds, furniture included");
    assert.equal(await readFile(join(tiles, "49-31.models.json.src"), "utf8"), await readFile(join(tiles, "49-31.json.src"), "utf8"));
  } finally {
    for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(box, { recursive: true, force: true });
  }
});

test("light families: liquid, minimap index, zone map and an interface file match too (real client)", {
  skip: real ? false : "needs the installed client and dataset",
}, async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-bytes-light-"));
  const spawned = [];
  try {
    const directories = (side) => ({
      LIQUID_DIR: join(box, side, "liquid"), MINIMAP_DIR: join(box, side, "minimap"),
      WORLD_MAP_ZONE_MAP_DIR: join(box, side, "zone-maps"), CLIENT_FILE_DIR: join(box, side, "client-files"),
    });
    const base = { ...process.env, CLIENT_DIR: real.client, CLIENT_PACK_DIR: "", DBC_DIR: real.dbc };
    const processEnv = { ...base, ...directories("process") };
    await generate("generate-liquid-texture.mjs", ["magma"], processEnv);
    await generate("generate-minimap-index.mjs", ["0"], processEnv);
    await generate("generate-worldmap-zone-map.mjs", ["0"], processEnv);
    await generate("generate-client-file.mjs", ["Interface/GlueXML/GlueXML.toc"], processEnv);

    const worker = workerFor({ ...base, ...directories("worker") }, spawned);
    try {
      await worker.run({ kind: "liquid", liquidClass: "magma" }, 1);
      await worker.run({ kind: "minimap-index", map: 0 }, 0);
      await worker.run({ kind: "zone-map", map: 0 }, 0);
      await worker.run({ kind: "client-file", path: "Interface/GlueXML/GlueXML.toc" }, 2);
      const absent = await worker.run({ kind: "client-file", path: "Interface/GlueXML/Absent.lua" }, 2).catch((error) => error);
      assert.equal(absent.exitCode, SOURCE_MISSING_EXIT, "a file the chain lacks is still the route's 404");
    } finally {
      worker.close();
    }
    assertSameTree(await tree(join(box, "process")), await tree(join(box, "worker")), "light families");
  } finally {
    for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(box, { recursive: true, force: true });
  }
});
