// 05.10-A7b-5 — slice 5 of line A7b, «Свет: данные»: the light payload v5 (7.04 slice 0: all 18
// LightIntBand and 6 LightFloatBand channels, HighlightSky, CloudTypeID, LightSkybox.Flags; 7.15:
// slot 4, the death light; 7.10: the Light rows LiquidType.LightID names and the darkening
// columns), the LiquidType v2 table (7.09 data) and the ghost fade.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveLighting } from "../dist/code/browser/LightClient.js";
import { GhostLightFade, GHOST_LIGHT_FADE_MS } from "../dist/code/browser/LightStateFade.js";

/** A WDBC file; a number is an int, `{ f }` a float and `{ s }` a string. */
function dbc(fields, rows) {
  const strings = [0];
  const offsets = new Map();
  const stringOffset = (text) => {
    if (text === "") return 0;
    if (!offsets.has(text)) {
      offsets.set(text, strings.length);
      strings.push(...new TextEncoder().encode(text), 0);
    }
    return offsets.get(text);
  };
  const body = 20 + rows.length * fields * 4;
  const cells = rows.map((row) => Array.from({ length: fields }, (_, field) => row[field] ?? 0)
    .map((value) => (typeof value === "object" && "s" in value ? { int: stringOffset(value.s) } : value)));
  const result = new Uint8Array(body + strings.length);
  result.set(new TextEncoder().encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.length, true);
  cells.forEach((row, index) => row.forEach((value, field) => {
    const at = 20 + (index * fields + field) * 4;
    if (typeof value === "object" && "f" in value) view.setFloat32(at, value.f, true);
    else if (typeof value === "object") view.setInt32(at, value.int, true);
    else view.setInt32(at, value, true);
  }));
  result.set(strings, body);
  return result;
}

function bandRow(id, times, values) {
  const row = new Array(34).fill(0);
  row[0] = id;
  row[1] = times.length;
  for (let key = 0; key < times.length; key++) {
    row[2 + key] = times[key];
    row[18 + key] = values[key];
  }
  return row;
}

const stored = (yards) => ({ f: yards * 36 });
const ZEROPOINT = 32 * 533.3333333333334;

/**
 * Light rows (15 fields: id, map, 3 coords, 2 falloffs, 8 slots):
 *   1 — map 0 default: clear 1, underwater 2, storm 1, underwater storm 2, death 3.
 *   2 — a map 0 volume whose death slot repeats slot 0 (so it must be absent).
 *   6 — a map 0 volume, the one LiquidType 4 (slime) names: clear 4, underwater 5, death 3.
 *   9 — map 33's default: clear 1, death 6.
 * Map 90 owns no row and inherits Light 1 through GLOBAL_FALLBACK_MAP.
 */
async function writeTables(directory, { liquid = true } = {}) {
  await writeFile(join(directory, "Light.dbc"), dbc(15, [
    [1, 0, 0, 0, 0, 0, 0, 1, 2, 1, 2, 3],
    [2, 0, stored(ZEROPOINT - 250), stored(80), stored(ZEROPOINT + 9000), stored(100), stored(200), 1, 2, 1, 2, 1],
    [6, 0, stored(ZEROPOINT - 900), stored(0), stored(ZEROPOINT + 900), stored(100), stored(200), 4, 5, 4, 5, 3],
    [9, 33, 0, 0, 0, 0, 0, 1, 1, 1, 1, 6],
  ]));
  // LightParams: id, HighlightSky, LightSkyboxID, CloudTypeID, Glow, four water alphas.
  await writeFile(join(directory, "LightParams.dbc"), dbc(9, [
    [1, 1, 0, 0, { f: 0.5 }], [2], [3, 0, 81, 0, { f: 0.6 }], [4], [5], [6, 0, 0, 7],
  ]));
  // LightSkybox: id, Name, Flags. 81 is the death sky, flagged 0x2 like the overlays.
  await writeFile(join(directory, "LightSkybox.dbc"), dbc(3, [[81, { s: "Environments\\Stars\\DeathSkybox.mdx" }, 2]]));
  // Eighteen colour rows and six float rows per set, one-based.
  const ints = [];
  for (let id = 1; id <= 6 * 18; id++) ints.push(bandRow(id, [0], [0]));
  // Set 1, channel 9 (row 10): a day curve through midnight, top byte set to prove the mask.
  ints[9] = bandRow(10, [0, 1440], [0x7fe8f1ff, 0x00fff7de]);
  ints[10] = bandRow(11, [0], [0x326184]);
  ints[11] = bandRow(12, [0], [0x123851]);
  ints[12] = bandRow(13, [0], [0x000001]);
  ints[13] = bandRow(14, [0], [0x5d5078]);
  ints[8] = bandRow(9, [0], [0x5c5c5c]);
  // Set 3 (the death set): ambient (row 2*18+2) grey-red.
  ints[2 * 18 + 1] = bandRow(2 * 18 + 2, [0], [0x804040]);
  await writeFile(join(directory, "LightIntBand.dbc"), dbc(34, ints));
  const floats = [];
  for (let id = 1; id <= 6 * 6; id++) floats.push(bandRow(id, [0], [{ f: 0 }]));
  floats[0] = bandRow(1, [0], [{ f: 18000 }]);
  floats[2] = bandRow(3, [0], [{ f: 1 }]);
  floats[3] = bandRow(4, [0], [{ f: 0.5 }]);
  floats[4] = bandRow(5, [0], [{ f: 0.95 }]);
  floats[5] = bandRow(6, [0], [{ f: 1 }]);
  await writeFile(join(directory, "LightFloatBand.dbc"), dbc(34, floats));
  if (!liquid) return;
  // LiquidType (45 fields): 2 Ocean darkens, 3 Magma names a Light row the table lacks, 4 Slime
  // names Light 6, 15 Green Lava, 181 Orange Slime.
  const liquidRow = (id, name, bank, darken, lightId, material, texture) => {
    const row = new Array(45).fill(0);
    row[0] = id;
    row[1] = { s: name };
    row[3] = bank;
    row[6] = { f: darken[0] };
    row[7] = { f: darken[1] };
    row[8] = { f: darken[2] };
    row[9] = { f: darken[3] };
    row[10] = lightId;
    row[14] = material;
    row[15] = { s: texture };
    row[23] = { f: 0.25 };
    row[41] = 7;
    return row;
  };
  await writeFile(join(directory, "LiquidType.dbc"), dbc(45, [
    liquidRow(2, "Ocean", 1, [30, 0.5, 0.5, 0.25], 0, 1, "XTextures\\ocean\\ocean_h.%d.blp"),
    liquidRow(3, "Magma", 2, [0, 0, 0, 0], 77, 2, "XTextures\\lava\\lava.%d.blp"),
    liquidRow(4, "Slime", 3, [0, 0, 0, 0], 6, 2, "XTextures\\slime\\slime.%d.blp"),
    liquidRow(15, "Green Lava", 2, [0, 0, 0, 0], 6, 2, "XTextures\\LavaGreen\\lavagreen.%d.blp"),
    liquidRow(181, "Orange Slime", 0, [0, 0, 0, 0], 0, 1, "XTEXTURES\\LavaOrange\\LavaOrange.%d.blp"),
    liquidRow(100, "Basic Procedural Water", 1, [30, 0.5, 0.5, 0], 0, 3, "XTextures\\procWater\\basicReflectionMap.blp"),
  ]));
  // LiquidMaterial: id, LVF, Flags — the dataset's three rows.
  await writeFile(join(directory, "LiquidMaterial.dbc"), dbc(3, [[1, 0, 1], [2, 1, 0], [3, 0, 1]]));
}

async function tables(t, options) {
  const directory = await mkdtemp(join(tmpdir(), "webclient-light-v5-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeTables(directory, options);
  return directory;
}

test("v5 payload: all eighteen colour channels and six float channels, masked to 24 bits", async (t) => {
  const { loadLightMetadata } = await import("../dist/code/gateway/LightMetadata.js");
  const index = await loadLightMetadata(await tables(t));
  const set = index.get(0).params[1];
  assert.deepEqual(Object.keys(set.colours).sort(), [
    "ambient", "cloudA", "cloudB", "diffuse", "extra13", "extra8", "fog", "oceanClose", "oceanFar",
    "riverClose", "riverFar", "skyHorizon", "skyLower", "skyMiddle", "skyTop", "skyUpper", "sunColour", "sunHalo",
  ]);
  assert.deepEqual(set.colours.sunColour.values, [0xe8f1ff, 0xfff7de], "channel 9, top byte masked");
  assert.deepEqual(set.colours.sunHalo.values, [0x326184], "channel 10");
  assert.deepEqual(set.colours.cloudA.values, [0x123851], "channel 11");
  assert.deepEqual(set.colours.cloudB.values, [0x000001], "channel 12");
  assert.deepEqual(set.colours.extra13.values, [0x5d5078], "channel 13");
  assert.deepEqual(set.colours.extra8.values, [0x5c5c5c], "channel 8");
  assert.deepEqual(set.celestialThrough.values, [1], "float 2");
  assert.deepEqual(set.cloudDensity.values, [0.5], "float 3");
  assert.ok(Math.abs(set.float4.values[0] - 0.95) < 1e-6, "float 4");
  assert.deepEqual(set.float5.values, [1], "float 5");
  assert.equal(set.highlightSky, 1);
  assert.equal(set.cloudType, 0);
  assert.equal(index.get(33).params[6].cloudType, 7);
  const death = index.get(0).params[3];
  assert.equal(death.skyboxPath, "Environments\\Stars\\DeathSkybox.m2");
  assert.equal(death.skyboxFlags, 2, "LightSkybox.Flags travels beside the path");
  assert.equal(set.skyboxFlags, undefined, "and only with one");
});

test("7.15: slot 4 is published where it differs, with a fallback and the global default", async (t) => {
  const { loadLightMetadata, GLOBAL_FALLBACK_MAP } = await import("../dist/code/gateway/LightMetadata.js");
  const index = await loadLightMetadata(await tables(t));
  const azeroth = index.get(0);
  assert.equal(azeroth.fallbackDeath, 3);
  assert.equal(azeroth.lights[1].deathParams, 3);
  assert.equal(azeroth.lights[2].deathParams, undefined, "a death slot repeating slot 0 is absent");
  assert.equal(azeroth.volumes.find((volume) => volume.id === 6).deathParams, 3);
  assert.ok(azeroth.params[3], "the death set travels with the map");
  assert.equal(index.get(33).fallbackDeath, 6, "a map's own default keeps its own death set");
  assert.ok(index.get(33).params[6]);
  const global = index.get(GLOBAL_FALLBACK_MAP);
  assert.equal(global.fallbackDeath, 3, "the 62 maps without a row die under Light 1's slot 4");
  assert.equal(global.lights[1].deathParams, 3);
  assert.ok(global.params[3]);
});

test("7.10: LiquidType light rows reach every map, with the darkening columns", async (t) => {
  const { loadLightMetadata, GLOBAL_FALLBACK_MAP } = await import("../dist/code/gateway/LightMetadata.js");
  const index = await loadLightMetadata(await tables(t));
  for (const map of [0, 33, GLOBAL_FALLBACK_MAP]) {
    const entry = index.get(map);
    assert.deepEqual(entry.lights[6], { params: 4, underwaterParams: 5, deathParams: 3 }, `map ${map}`);
    assert.ok(entry.params[4] && entry.params[5] && entry.params[3], `map ${map} carries Light 6's sets`);
    assert.deepEqual(entry.liquids[4], { lightId: 6 });
    assert.deepEqual(entry.liquids[15], { lightId: 6 });
    assert.deepEqual(entry.liquids[2], { maxDarkenDepth: 30, fogDarken: 0.5, ambDarken: 0.5, dirDarken: 0.25 });
    assert.deepEqual(entry.liquids[100], { maxDarkenDepth: 30, fogDarken: 0.5, ambDarken: 0.5, dirDarken: 0 });
    assert.equal(entry.liquids[3], undefined, "a light id with no Light row is not sent");
    assert.equal(entry.liquids[181], undefined, "nor a row with nothing to say");
  }
  assert.equal(index.get(33).volumes.length, 0, "Light 6 is added for lookup, never as a volume elsewhere");
});

test("a dataset without LiquidType still loads its light", async (t) => {
  const { loadLightMetadata } = await import("../dist/code/gateway/LightMetadata.js");
  const index = await loadLightMetadata(await tables(t, { liquid: false }));
  assert.equal(index.get(0).fallback, 1);
  assert.deepEqual(index.get(0).liquids ?? {}, {});
});

// ---- the browser side ----------------------------------------------------------------------

function colourSet(colour, extras = {}) {
  const colours = {};
  for (const channel of ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower",
    "skyHorizon", "fog", "oceanClose", "oceanFar", "riverClose", "riverFar"]) {
    colours[channel] = { times: [0], values: [colour] };
  }
  return { colours, fogEnd: { times: [0], values: [600] }, fogScale: { times: [0], values: [0.5] }, ...extras };
}
function v5Set(colour, sun) {
  const set = colourSet(colour);
  set.colours.sunColour = { times: [0, 1440], values: [sun[0], sun[1]] };
  for (const name of ["sunHalo", "cloudA", "cloudB", "extra8", "extra13"]) set.colours[name] = { times: [0], values: [0x010203] };
  set.celestialThrough = { times: [0], values: [1] };
  set.cloudDensity = { times: [0, 1440], values: [0, 2] };
  set.float4 = { times: [0], values: [0.95] };
  set.float5 = { times: [0], values: [1] };
  set.highlightSky = 1;
  set.cloudType = 0;
  return set;
}

const V5_ENTRY = {
  fallback: 1,
  fallbackLightId: 1,
  fallbackUnderwater: 2,
  fallbackDeath: 3,
  params: {
    1: v5Set(0x808080, [0x000000, 0xfefefe]),
    2: colourSet(0x0000ff),
    3: colourSet(0x400000, { skyboxPath: "Environments\\Stars\\DeathSkybox.m2", skyboxFlags: 2 }),
    4: colourSet(0x00ff00),
    5: colourSet(0xff8000),
  },
  volumes: [],
  lights: {
    1: { params: 1, underwaterParams: 2, deathParams: 3 },
    7: { params: 4, underwaterParams: 5 },
  },
  liquids: {
    2: { maxDarkenDepth: 30, fogDarken: 0.5, ambDarken: 0.5, dirDarken: 0.25 },
    3: { lightId: 7 },
    9: { lightId: 99 },
  },
};

test("7.04 slice 0: the sky channels sample as packed colours and blend through midnight", () => {
  const noon = resolveLighting(V5_ENTRY, 0, 0, 1440);
  assert.equal(noon.skyChannels, true);
  assert.equal(noon.sunColour, 0xfefefe);
  assert.equal(noon.sunHalo, 0x010203);
  assert.equal(noon.cloudDensity, 2);
  assert.equal(noon.celestialThrough, 1);
  assert.equal(noon.highlightSky, 1);
  // 2160 is half way from the 1440 key back round to the 0 key.
  const dusk = resolveLighting(V5_ENTRY, 0, 0, 2160);
  assert.equal(dusk.sunColour, 0x7f7f7f);
  assert.equal(dusk.cloudDensity, 1);
  // A v4 body (old gateway) carries none of it, and says so.
  const old = resolveLighting({ fallback: 1, params: { 1: colourSet(0x808080) }, volumes: [] }, 0, 0, 1440);
  assert.equal(old.skyChannels, false);
  assert.equal(old.sunColour, 0);
  assert.equal(old.skyboxFlags, 0);
});

test("7.15: a ghost reads slot 4, fades by weight, and an old body falls back to slot 0", () => {
  const alive = resolveLighting(V5_ENTRY, 0, 0, 1440);
  const ghost = resolveLighting(V5_ENTRY, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined, undefined, false, 1);
  assert.equal(alive.colours.ambient.r, 0x80 / 255);
  assert.equal(ghost.colours.ambient.r, 0x40 / 255, "the death set");
  assert.equal(ghost.skyboxPath, "Environments\\Stars\\DeathSkybox.m2");
  assert.equal(ghost.skyboxFlags, 2);
  const half = resolveLighting(V5_ENTRY, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined, undefined, false, 0.5);
  assert.ok(Math.abs(half.colours.ambient.r - (0x80 + 0x40) / 2 / 255) < 1e-6, "a fading ghost blends the two");
  assert.equal(half.sunColour, 0x7f7f7f, "and the packed sky channels with them, byte by byte");
  assert.equal(ghost.sunColour, 0, "the death sets carry no sun");
  const underwaterGhost = resolveLighting(V5_ENTRY, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined, undefined, true, 1);
  assert.equal(underwaterGhost.colours.ambient.r, 0x40 / 255, "the death light wins over the water");
  const old = { fallback: 1, params: { 1: colourSet(0x808080) }, volumes: [] };
  const oldGhost = resolveLighting(old, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined, undefined, false, 1);
  assert.equal(oldGhost.colours.ambient.r, 0x80 / 255, "no slot 4 in the body: the living light");
});

test("7.10: under magma the LiquidType light row's underwater slot replaces the zone", () => {
  const args = (underwater, liquid, depth) => [V5_ENTRY, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined,
    undefined, underwater, 0, liquid, depth];
  const zone = resolveLighting(...args(true, undefined, 0));
  assert.equal(zone.colours.ambient.b, 1, "zonal underwater set 2");
  const magma = resolveLighting(...args(true, 3, 2));
  assert.equal(magma.colours.ambient.r, 1, "Light 7's underwater set 5");
  assert.equal(magma.colours.ambient.g, 0x80 / 255);
  const above = resolveLighting(...args(false, 3, 0));
  assert.equal(above.colours.ambient.r, 0x80 / 255, "not under the surface: the ordinary sky");
  const unknown = resolveLighting(...args(true, 9, 2));
  assert.equal(unknown.colours.ambient.b, 1, "a light row missing from the body: the zone");
  const v4 = { ...V5_ENTRY, liquids: undefined };
  assert.equal(resolveLighting(v4, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined, undefined, true, 0, 3, 2)
    .colours.ambient.b, 1, "an old body: the zone");
});

test("7.10: the ocean darkens with depth by its LiquidType intensities", () => {
  const at = (depth) => resolveLighting(V5_ENTRY, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined,
    undefined, true, 0, 2, depth);
  const surface = at(0);
  const half = at(15);
  const deep = at(60);
  assert.equal(surface.fogEnd, 600);
  assert.equal(half.fogEnd, 600 * (1 - 0.5 * 0.5));
  assert.equal(half.fogStart, 300 * (1 - 0.5 * 0.5));
  assert.equal(deep.fogEnd, 600 * 0.5, "clamped at MaxDarkenDepth");
  assert.ok(Math.abs(deep.colours.ambient.b - 0.5) < 1e-6);
  assert.ok(Math.abs(deep.colours.diffuse.b - 0.75) < 1e-6);
  const dry = resolveLighting(V5_ENTRY, 0, 0, 1440, 0, 3, undefined, undefined, 1, undefined, undefined, false, 0, 2, 15);
  assert.equal(dry.fogEnd, 600, "darkening needs the eye under the surface");
});

test("the ghost light fades over two seconds and starts settled", () => {
  const fade = new GhostLightFade();
  assert.equal(GHOST_LIGHT_FADE_MS, 2000);
  assert.equal(fade.weight(true, 1000), 1, "entering the world dead does not fade in");
  assert.equal(fade.weight(false, 2000), 1);
  assert.equal(fade.weight(false, 3000), 0.5);
  assert.equal(fade.weight(false, 4000), 0);
  assert.equal(fade.weight(true, 5000), 0);
  assert.equal(fade.weight(true, 5500), 0.25);
  // Reversing mid-fade starts from where it stands rather than jumping.
  assert.equal(fade.weight(false, 5500), 0.25);
  assert.equal(fade.weight(false, 6000), 0);
});

test("7.09 data: LiquidType v2 rows carry family, material, light and darkening", async (t) => {
  const { loadLiquidRows } = await import("../dist/code/gateway/LiquidMetadata.js");
  const table = await loadLiquidRows(await tables(t));
  assert.equal(table.version, 2);
  assert.equal(table.classes[15], "magma");
  assert.equal(table.classes[181], "magma");
  const green = table.rows[15];
  assert.equal(green.family, "lavagreen");
  assert.equal(table.rows[3].family, "lava", "Green Lava is its own family, not red lava's");
  assert.equal(table.rows[181].family, "lavaorange");
  assert.equal(table.rows[2].family, "ocean_h");
  assert.equal(table.rows[100].family, "basicreflectionmap");
  assert.equal(green.name, "Green Lava");
  assert.equal(green.soundBank, 2);
  assert.equal(green.materialId, 2);
  assert.equal(green.vertexFormat, 1, "LiquidMaterial 2: height and UV");
  assert.equal(green.materialFlags, 0);
  assert.equal(table.rows[2].vertexFormat, 0);
  assert.equal(table.rows[2].materialFlags, 1);
  assert.equal(green.lightId, 6);
  assert.deepEqual([table.rows[2].maxDarkenDepth, table.rows[2].fogDarken, table.rows[2].ambDarken,
    table.rows[2].dirDarken], [30, 0.5, 0.5, 0.25]);
  assert.equal(green.textures[0], "XTextures\\LavaGreen\\lavagreen.%d.blp");
  assert.equal(green.floatParams.length, 18);
  assert.equal(green.floatParams[0], 0.25);
  assert.deepEqual(green.intParams, [7, 0, 0, 0]);
});

test("7.09 data: /dbc/liquid-types keeps its old body and answers ?v=2 with rows", async (t) => {
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const directory = await tables(t);
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    dbcDirectory: directory,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  try {
    const old = await (await fetch(`http://127.0.0.1:${gateway.port}/dbc/liquid-types`, { headers })).json();
    assert.equal(old[15], "magma", "the unversioned body is the old record, for the running Water.ts");
    assert.equal(old.rows, undefined);
    const v2 = await (await fetch(`http://127.0.0.1:${gateway.port}/dbc/liquid-types?v=2`, { headers })).json();
    assert.equal(v2.version, 2);
    assert.equal(v2.classes[15], "magma");
    assert.equal(v2.rows[15].family, "lavagreen");
    const refused = await fetch(`http://127.0.0.1:${gateway.port}/dbc/liquid-types?v=2`, { headers: { origin: "http://evil.test" } });
    assert.equal(refused.status, 403);
    const light = await (await fetch(`http://127.0.0.1:${gateway.port}/dbc/light/0?v=5`, { headers })).json();
    assert.equal(light.fallbackDeath, 3);
    assert.deepEqual(light.liquids[4], { lightId: 6 });
  } finally {
    await gateway.close();
  }
});
