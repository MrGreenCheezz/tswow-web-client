import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWmoDoodadSets, wmoDependencies, wmoExteriorNamedDoodads } from "../tools/wmo-visual.mjs";

// 12.10 6.25 — the black sails of an ADT-placed ship. `visual-tile-v7` is v6 with no room light
// (`localLight`, the MODD colour) on a WMO doodad an exterior group names: transportship.wmo's sails
// (MODD[133]) are named by its three indoor groups and its outdoor deck with a colour of (0, 0, 0, 255),
// Booty Bay's entrance arch (MODD[3]) by interior group 22 and exterior group 42 — the vanilla client's
// "exterior wins" (benilla, 1.12 Wow.exe 0x694e90 / 0x695aa0). Every other record, and every field but
// that one, must come out exactly as v6 wrote it; a gateway that still names v6 keeps v6's bytes.

const hasDataset = (() => {
  try {
    return existsSync(join(process.env.DBC_DIR ?? "", "Map.dbc")) || existsSync("F:/tswowRoot/tswow-install");
  } catch {
    return false;
  }
})();

let client;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  client = await clientArchives(clientDirectory());
} catch {
  client = undefined;
}
const withClient = { skip: client ? false : "no 3.3.5a client on this machine" };

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const WMO = "World\\wmo\\Test\\Ship.wmo";
const WORLD_MID = 0.5 * 64 * 533.33333333;

/** Map 0 cell 32/32: the ship placed with doodad set 0. */
function adt() {
  const mwmo = Buffer.from(`${WMO}\0`, "latin1");
  const modf = Buffer.alloc(64);
  modf.writeUInt32LE(0, 0); modf.writeUInt32LE(7, 4);
  modf.writeFloatLE(WORLD_MID + 20, 8); modf.writeFloatLE(5, 12); modf.writeFloatLE(WORLD_MID + 20, 16);
  for (const [index, value] of [-10, -10, -10, 10, 10, 10].entries()) modf.writeFloatLE(WORLD_MID + 20 + value, 32 + index * 4);
  return Buffer.concat([
    chunk("MVER", Buffer.from([18, 0, 0, 0])),
    chunk("MMDX", Buffer.alloc(0)), chunk("MMID", Buffer.alloc(0)),
    chunk("MWMO", mwmo), chunk("MWID", Buffer.alloc(4)),
    chunk("MDDF", Buffer.alloc(0)), chunk("MODF", modf),
  ]);
}

/** MODD colours, BGRA as the file stores them. */
const COLOURS = [[30, 20, 10, 255], [0, 0, 0, 255], [60, 50, 40, 255], [90, 80, 70, 255]];

/**
 * Set 0 = records 0–3: 0 a cabin lamp (indoor only), 1 the sail (indoor and the outdoor deck, black),
 * 2 a deck barrel (outdoor only), 3 a record no group names.
 */
function shipRoot() {
  const mohd = Buffer.alloc(64);
  mohd.writeUInt32LE(2, 4);
  const sets = Buffer.alloc(32);
  sets.writeUInt32LE(0, 20); sets.writeUInt32LE(COLOURS.length, 24);
  const names = Buffer.from("World\\Lamp.m2\0World\\Sails.m2\0", "latin1");
  const placements = Buffer.alloc(40 * COLOURS.length);
  COLOURS.forEach((colour, index) => {
    placements.writeUInt32LE(index === 1 ? "World\\Lamp.m2\0".length : 0, index * 40);
    placements.writeFloatLE(index, index * 40 + 4);
    placements.writeFloatLE(1, index * 40 + 28);
    placements.writeFloatLE(1, index * 40 + 32);
    Buffer.from(colour).copy(placements, index * 40 + 36);
  });
  return Buffer.concat([chunk("MOHD", mohd), chunk("MODS", sets), chunk("MODN", names), chunk("MODD", placements)]);
}

function group(flags, references, coloured) {
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  const refs = Buffer.alloc(references.length * 2);
  references.forEach((reference, index) => refs.writeUInt16LE(reference, index * 2));
  return chunk("MOGP", Buffer.concat([header, ...(coloured ? [chunk("MOCV", Buffer.alloc(4))] : []), chunk("MODR", refs)]));
}

const INDOOR = 0x2000, OUTDOOR = 0x8;

function archives() {
  const files = new Map([
    ["world\\maps\\azeroth\\azeroth_32_32.adt", adt()],
    [WMO.toLowerCase(), shipRoot()],
    ["world\\wmo\\test\\ship_000.wmo", group(INDOOR, [0, 1], true)],
    ["world\\wmo\\test\\ship_001.wmo", group(OUTDOOR, [1, 2], false)],
  ]);
  return {
    read: async (path) => files.get(path.toLowerCase()),
    sourceOf: async (path) => (files.has(path.toLowerCase()) ? { path, name: "test.MPQ", kind: "archive" } : undefined),
    chainDigest: () => "test-chain",
  };
}

/** Publishes the generations in order into one box (one tile directory, one doodad cache). */
async function publishInOrder(generations) {
  const box = await mkdtemp(join(tmpdir(), "webclient-visual-tile-v7-"));
  const saved = { tiles: process.env.VISUAL_TILE_DIR, cache: process.env.WMO_DOODAD_CACHE_DIR };
  process.env.VISUAL_TILE_DIR = join(box, "tiles");
  process.env.WMO_DOODAD_CACHE_DIR = join(box, "doodads");
  try {
    const { publishVisualTile } = await import("../tools/generate-visual-tile.mjs");
    const tile = join(box, "tiles", "0", "32-32.json");
    const runs = [];
    for (const generation of generations) {
      await publishVisualTile(0, 32, 32, archives(), { generation });
      runs.push({
        generation,
        bytes: await readFile(tile, "utf8"),
        stamp: JSON.parse(await readFile(`${tile}.src`, "utf8")),
      });
    }
    const caches = await Promise.all((await readdir(join(box, "doodads"))).filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await readFile(join(box, "doodads", name), "utf8"))));
    return { runs, caches };
  } finally {
    if (saved.tiles === undefined) delete process.env.VISUAL_TILE_DIR; else process.env.VISUAL_TILE_DIR = saved.tiles;
    if (saved.cache === undefined) delete process.env.WMO_DOODAD_CACHE_DIR; else process.env.WMO_DOODAD_CACHE_DIR = saved.cache;
    await rm(box, { recursive: true, force: true });
  }
}

const withoutLight = ({ localLight: _light, ...rest }) => rest;

test("visual-tile-v7: the sail an exterior group names loses its black room light; nothing else moves", { skip: !hasDataset }, async () => {
  const { runs: [v6, v7], caches } = await publishInOrder(["visual-tile-v6", "visual-tile-v7"]);
  assert.equal(v6.stamp.generation, "visual-tile-v6");
  assert.equal(v7.stamp.generation, "visual-tile-v7");
  const before = JSON.parse(v6.bytes), after = JSON.parse(v7.bytes);
  const doodads = (objects) => objects.filter((object) => object.id < 0);
  assert.deepEqual(doodads(before).map((object) => object.localLight),
    [[10, 20, 30, 255], [0, 0, 0, 255], undefined, undefined], "v6: the indoor-named lamp and sail are room-lit");
  assert.deepEqual(doodads(after).map((object) => object.localLight),
    [[10, 20, 30, 255], undefined, undefined, undefined], "v7: the outdoor deck names the sail, so it is sky-lit");
  // Same records, same order, every other field the same; the lamp, the barrel and the orphan byte for byte.
  assert.deepEqual(after.map(withoutLight), before.map(withoutLight));
  for (const index of [0, 2, 3]) {
    assert.equal(JSON.stringify(doodads(after)[index]), JSON.stringify(doodads(before)[index]), `record ${index}`);
  }
  assert.equal(JSON.stringify(after.filter((object) => object.id >= 0)), JSON.stringify(before.filter((object) => object.id >= 0)),
    "the placement itself is untouched");
  // Each generation has its own doodad-set cache file, so neither can read the other's answer.
  assert.deepEqual(caches.map((cache) => cache.version).sort(), [2, 3]);
});

test("a gateway that still names v6 keeps v6's bytes, even after a v7 run filled the caches", { skip: !hasDataset }, async () => {
  const { runs: [first, , again] } = await publishInOrder(["visual-tile-v6", "visual-tile-v7", "visual-tile-v6"]);
  assert.equal(again.bytes, first.bytes);
  assert.equal(again.stamp.generation, "visual-tile-v6");
});

test("exterior wins: one rule for the tile and for a game object's doodad list", () => {
  const root = shipRoot();
  const groups = [group(INDOOR, [0, 1], true), group(OUTDOOR, [1, 2], false)];
  assert.deepEqual([...wmoExteriorNamedDoodads(groups)].sort(), [1, 2]);
  const lit = (options) => parseWmoDoodadSets(root, groups, { effective: true, ...options })[0]
    .map((doodad) => doodad.localLight ?? null);
  assert.deepEqual(lit({}), [[10, 20, 30, 255], [0, 0, 0, 255], null, null]);
  assert.deepEqual(lit({ exteriorWins: true }), [[10, 20, 30, 255], null, null, null]);
  // A malformed group names nothing and costs no other record its light.
  assert.deepEqual([...wmoExteriorNamedDoodads([Buffer.from("garbage"), ...groups])].sort(), [1, 2]);
});

test("the client's own cases: the ship's sails, the zeppelin's propellers, Booty Bay's arch", withClient, async () => {
  const cases = [
    ["World\\wmo\\transports\\transport_ship\\transportship.wmo", 133, /transportship_sails\.m2$/i],
    ["World\\wmo\\transports\\transport_zeppelin\\transport_zeppelin.wmo", 0, /zepanimation\.m2$/i],
    ["World\\wmo\\Azeroth\\Buildings\\Stranglethorn_BootyBay\\BootyBay.wmo", 3, /bootybayentrance_02\.m2$/i],
  ];
  for (const [path, index, name] of cases) {
    const root = await client.read(path);
    const groups = [];
    for (const groupPath of wmoDependencies(root, path).groups) {
      const data = await client.read(groupPath);
      if (data) groups.push(data);
    }
    const before = parseWmoDoodadSets(root, groups, { effective: true })[0];
    const after = parseWmoDoodadSets(root, groups, { effective: true, exteriorWins: true })[0];
    const record = before.find((doodad) => doodad.index === index);
    assert.match(record.name, name, path);
    assert.deepEqual(record.localLight, [0, 0, 0, 255], `${path}: v6 lit it black`);
    assert.equal(after.find((doodad) => doodad.index === index).localLight, undefined, `${path}: v7 does not`);
    // Only room light changes, and only on records an exterior group names.
    const exterior = wmoExteriorNamedDoodads(groups);
    assert.equal(after.length, before.length);
    for (let at = 0; at < before.length; at++) {
      assert.deepEqual(withoutLight(after[at]), withoutLight(before[at]));
      if (!exterior.has(before[at].index)) assert.deepEqual(after[at].localLight, before[at].localLight);
    }
  }
});
