import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { visualModelHash as gatewayHash } from "../dist/code/gateway/Gateway.js";
import { openClientArchives } from "../tools/mpq.mjs";
import { dbcDirectory } from "../tools/paths.mjs";
import { mapTiles, pregenerate } from "../tools/pregenerate.mjs";
import { visualModelHash } from "../tools/visual-model-key.mjs";

// 10.22: `tools/pregenerate.mjs` builds what is missing for a map out of one open chain, skips what
// is current, leaves 7.23's stubs as markers, and never writes on `--dry-run`. Every directory here
// is a temporary one: the published cache is the owner's.

test("the tool's model key is the gateway's", () => {
  for (const path of ["World\\Tree.m2", "World\\wmo\\Town.WMO", "Character\\Human\\Male\\HumanMale.m2"]) {
    assert.equal(visualModelHash(path), gatewayHash(path));
  }
});

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** MTEX, one M2 placement of a model the client lacks, and 256 MCNK with `layers` layers each. */
function adt(layers) {
  const name = Buffer.from("World\\Absent\\Thing.mdx\0", "latin1");
  const placement = Buffer.alloc(36);
  placement.writeUInt16LE(1024, 32);
  const parts = [
    chunk("MTEX", Buffer.from("Tileset\\Stub\\Ground.blp\0", "latin1")),
    chunk("MMDX", name), chunk("MMID", Buffer.alloc(4)), chunk("MDDF", placement),
  ];
  for (let index = 0; index < 256; index++) {
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
    return existsSync(join(dbcDirectory(), "Map.dbc")) ? dbcDirectory() : undefined;
  } catch {
    return undefined;
  }
})();

async function files(directory) {
  if (!existsSync(directory)) return [];
  return (await readdir(directory, { recursive: true })).map(String).sort();
}

test("pregenerate: dry run writes nothing; a run builds splat, marker, tile and list; a second run builds nothing", {
  skip: realDbc ? false : "needs the dataset's Map.dbc",
}, async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-pregenerate-"));
  const env = {
    DBC_DIR: join(box, "dbc"), TERRAIN_TEXTURE_DIR: join(box, "out", "terrain-textures"),
    TERRAIN_LAYER_DIR: join(box, "out", "terrain-layers"), VISUAL_TILE_DIR: join(box, "out", "visual-tiles"),
    WMO_DOODAD_CACHE_DIR: join(box, "out", "wmo-doodads"), VISUAL_MODEL_DIR: join(box, "out", "visual-models"),
    TEXTURE_DIR: join(box, "out", "textures"),
  };
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  const client = join(box, "client");
  const maps = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "World", "Maps", "GunDrak");
  await mkdir(maps, { recursive: true });
  await mkdir(env.DBC_DIR, { recursive: true });
  await copyFile(join(realDbc, "Map.dbc"), join(env.DBC_DIR, "Map.dbc"));
  await writeFile(join(maps, "GunDrak_29_27.adt"), adt(0));
  await writeFile(join(maps, "GunDrak_29_28.adt"), adt(1));
  const archives = await openClientArchives(client);
  const lines = [];
  const run = (extra = {}) => pregenerate({ map: 604, families: ["splat", "tile", "models"], limit: Infinity, dryRun: false, ...extra },
    archives, (line) => lines.push(line));
  try {
    assert.deepEqual(await mapTiles(archives, "GunDrak"), [{ gridX: 27, gridY: 29 }, { gridX: 28, gridY: 29 }]);

    const dry = await run({ dryRun: true });
    assert.equal(dry.planned, 4, "two splats and two tiles; models are unknown until a tile exists");
    assert.deepEqual(await files(join(box, "out")), [], "a dry run writes nothing");

    const first = await run();
    assert.equal(first.failed, 0, lines.join("\n"));
    assert.equal(first.built, 3, "the partial splat and two visual tiles");
    assert.equal(first.missing, 2, "the stub's splat (marker) and the model the client lacks");
    const textures = join(env.TERRAIN_TEXTURE_DIR, "604");
    assert.ok(existsSync(join(textures, "27-29.nosplat")));
    assert.ok(existsSync(join(textures, "28-29.splat.json")));
    assert.ok(existsSync(join(env.VISUAL_TILE_DIR, "604", "27-29.models.json")));

    const second = await run();
    assert.equal(second.built, 0, `everything is current:\n${lines.join("\n")}`);
    assert.equal(second.skipped, 4);

    const limited = await run({ families: ["players"], limit: 0 });
    assert.equal(limited.built + limited.planned, 0, "--limit 0 builds nothing");
  } finally {
    archives.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(box, { recursive: true, force: true });
  }
});
