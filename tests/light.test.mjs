import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { advanceGameTime, formatGameTime, halfMinuteOfDay, parseLoginSetTimeSpeed } from "../dist/code/world/GameTimeProtocol.js";
import { lightOverrideWeight, resolveLighting, skyboxAnimationTimeMs } from "../dist/code/browser/LightClient.js";
import { eyeUnderwater } from "../dist/code/browser/game/Physics.js";

function timeSpeedPacket({ minute, hour, weekday = 3, day = 14, month = 7, year = 26, speed = 1 / 60 }) {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  // secsToTimeBitFields: minute 0-5, hour 6-10, weekday 11-13, day 14-19, month 20-23, year 24-31.
  view.setUint32(0, (year << 24) | (month << 20) | (day << 14) | (weekday << 11) | (hour << 6) | minute, true);
  view.setFloat32(4, speed, true);
  return payload;
}

test("the world clock comes out of the packed calendar the core sends", () => {
  const time = parseLoginSetTimeSpeed(timeSpeedPacket({ hour: 13, minute: 37 }));
  assert.equal(time.minuteOfDay, 13 * 60 + 37);
  assert.equal(formatGameTime(time), "13:37");
  assert.equal(time.weekday, 3);
  assert.ok(Math.abs(time.minutesPerSecond - 1 / 60) < 1e-6);

  // The light bands are keyed in half-minutes of a 2880-unit day, not in minutes.
  assert.equal(halfMinuteOfDay(parseLoginSetTimeSpeed(timeSpeedPacket({ hour: 12, minute: 0 }))), 1440);
  assert.equal(halfMinuteOfDay(parseLoginSetTimeSpeed(timeSpeedPacket({ hour: 0, minute: 0 }))), 0);

  // A speed of zero would freeze the sky and a huge one would spin it; the core's own is 1/60.
  const broken = parseLoginSetTimeSpeed(timeSpeedPacket({ hour: 6, minute: 0, speed: 0 }));
  assert.ok(Math.abs(broken.minutesPerSecond - 1 / 60) < 1e-6);
});

test("the world clock runs on after the one packet that reports it, and wraps at midnight", () => {
  // A game minute per real second, so two seconds carry 23:59 over into the next day.
  const time = parseLoginSetTimeSpeed(timeSpeedPacket({ hour: 23, minute: 59, speed: 1 }));
  const later = advanceGameTime(time, 2);
  assert.ok(Math.abs(later.minuteOfDay - 1) < 1e-6, `expected 00:01, got ${formatGameTime(later)}`);
  assert.equal(formatGameTime(advanceGameTime(time, 61)), "01:00");
  assert.equal(advanceGameTime(time, 0).minuteOfDay, time.minuteOfDay);
});

// A tiny stand-in for one map: a default set and one volume with a different one.
const NIGHT = 0x102040;
const DAY = 0xa0c0e0;
function band(times, values) {
  return { times, values };
}
function set(colour, skyboxPath) {
  const colours = {};
  for (const channel of ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower",
    "skyHorizon", "fog", "oceanClose", "oceanFar", "riverClose", "riverFar"]) {
    colours[channel] = band([0, 1440], [NIGHT, colour]);
  }
  return {
    colours, fogEnd: band([0, 1440], [500, 900]), fogScale: band([0], [0.25]),
    ...(skyboxPath ? { skyboxPath } : {}),
  };
}
const ENTRY = {
  fallback: 1,
  params: { 1: set(DAY), 2: set(0xff0000) },
  volumes: [{ id: 7, x: 100, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 2 }],
};

// The same map with a storm set on both the default and the volume, which is what slice R7 added.
const STORM_ENTRY = {
  fallback: 1,
  fallbackStorm: 3,
  params: { 1: set(DAY), 2: set(0xff0000), 3: set(0x0000ff), 4: set(0x00ff00) },
  volumes: [{ id: 7, x: 100, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 2, stormParams: 4 }],
};

test("lighting is sampled along the band curves and wraps through midnight", () => {
  const noon = resolveLighting(ENTRY, 0, 0, 1440);
  assert.ok(Math.abs(noon.colours.skyTop.r - 0xa0 / 255) < 1e-6);
  assert.equal(noon.fogEnd, 900);
  assert.equal(noon.fogStart, 900 * 0.25);

  const midnight = resolveLighting(ENTRY, 0, 0, 0);
  assert.ok(Math.abs(midnight.colours.skyTop.r - 0x10 / 255) < 1e-6);

  // Halfway between the two keys, and halfway between the two colours.
  const morning = resolveLighting(ENTRY, 0, 0, 720);
  assert.ok(Math.abs(morning.colours.skyTop.r - (0x10 + 0xa0) / 2 / 255) < 0.01);

  // 22:00 is past the last key, so the curve runs on into the first one the long way round rather
  // than stopping. Two thirds of the way from 1440 to 2880, which is where 0 sits again.
  const evening = resolveLighting(ENTRY, 0, 0, 2400);
  assert.ok(evening.colours.skyTop.r < morning.colours.skyTop.r, "the evening has to be darker than the morning");
  assert.ok(evening.colours.skyTop.r > midnight.colours.skyTop.r, "and lighter than midnight");
});

test("a light volume takes over inside its radius and fades out at the edge of it", () => {
  const outside = resolveLighting(ENTRY, 0, 0, 1440);
  assert.ok(Math.abs(outside.colours.fog.r - 0xa0 / 255) < 1e-6, "well outside, the map default stands alone");

  const inside = resolveLighting(ENTRY, 100, 0, 1440);
  assert.equal(inside.colours.fog.r, 1, "inside the inner radius the volume is the whole answer");
  assert.equal(inside.colours.fog.g, 0);

  // On the falloff the two are mixed, and the mix is smooth rather than a step: halfway between
  // the radii smoothstep gives exactly a half.
  const edge = resolveLighting(ENTRY, 130, 0, 1440);
  assert.ok(Math.abs(edge.colours.fog.r - (0xa0 / 255 + (1 - 0xa0 / 255) * 0.5)) < 0.02,
    `expected the halfway mix, got ${edge.colours.fog.r}`);

  // And a map with no default and nothing in range answers with nothing rather than with black.
  assert.equal(resolveLighting({ fallback: undefined, params: {}, volumes: [] }, 0, 0, 1440), undefined);
});

test("skybox path follows the dominant light profile, including procedural profiles", () => {
  const authored = "Environments\\Stars\\DalaranSkyBox.m2";
  const proceduralToAuthored = {
    fallback: 1,
    params: { 1: set(DAY), 2: set(0xff0000, authored) },
    volumes: [{ id: 7, x: 100, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 2 }],
  };
  const authoredAtHalf = resolveLighting(proceduralToAuthored, 130, 0, 1440);
  assert.equal(authoredAtHalf.skyboxPath, authored, "the newer profile owns an equal-weight boundary");
  const authoredBelowHalf = resolveLighting(proceduralToAuthored, 131, 0, 1440);
  assert.equal(authoredBelowHalf.skyboxPath, undefined, "a weak authored profile must not appear early");

  const authoredToProcedural = {
    fallback: 1,
    params: { 1: set(DAY, authored), 2: set(0xff0000) },
    volumes: [{ id: 7, x: 100, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 2 }],
  };
  const proceduralAtHalf = resolveLighting(authoredToProcedural, 130, 0, 1440);
  assert.equal(proceduralAtHalf.skyboxPath, undefined, "the procedural volume clears at equal weight");
  const proceduralDominant = resolveLighting(authoredToProcedural, 129, 0, 1440);
  assert.equal(proceduralDominant.skyboxPath, undefined, "a dominant procedural volume clears the dome");
  const authoredDominant = resolveLighting(authoredToProcedural, 131, 0, 1440);
  assert.equal(authoredDominant.skyboxPath, authored, "the authored fallback remains while dominant");
});

test("stacked light volumes resolve against the player's height", () => {
  const stacked = {
    fallback: 1,
    params: { ...ENTRY.params, 3: set(0x00ff00) },
    volumes: [
      { id: 1, x: 0, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 2 },
      { id: 2, x: 0, y: 0, z: 100, innerRadius: 10, outerRadius: 50, params: 3 },
    ],
  };
  const ground = resolveLighting(stacked, 0, 0, 1440, 0, 3, 0);
  const air = resolveLighting(stacked, 0, 0, 1440, 0, 3, 100);
  assert.equal(ground.colours.fog.r, 1, "the lower volume owns the ground");
  assert.equal(ground.colours.fog.g, 0);
  assert.equal(air.colours.fog.r, 0, "the upper volume is selected in the air");
  assert.equal(air.colours.fog.g, 1);
});

test("nested light falloff composites the broad layer before the tighter layer", () => {
  const nested = {
    fallback: 1,
    params: {
      1: set(DAY),
      2: set(0xff0000),
      3: set(0x00ff00),
    },
    volumes: [
      { id: 7, x: 100, y: 0, z: 0, innerRadius: 20, outerRadius: 100, params: 2 },
      { id: 9, x: 100, y: 0, z: 0, innerRadius: 0, outerRadius: 20, params: 3 },
    ],
  };
  // At distance 10 the broad volume is solid while the tight volume is halfway through its
  // smooth falloff. A tight-first compositor would let the broad red layer repaint that green
  // contribution and return pure red.
  const sample = resolveLighting(nested, 110, 0, 1440);
  assert.ok(Math.abs(sample.colours.fog.r - 0.5) < 0.03, `got red ${sample.colours.fog.r}`);
  assert.ok(Math.abs(sample.colours.fog.g - 0.5) < 0.03, `got green ${sample.colours.fog.g}`);
});

// A whole light table, small enough to reason about: two parameter sets, a map default and one
// volume, with the band rows the arithmetic has to find laid out where it expects them.
function dbcFixture(fields, rows) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + 1);
  result.set(new TextEncoder().encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, 1, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) {
      const value = rows[row][field] ?? 0;
      const at = 20 + (row * fields + field) * 4;
      // A float field says so, because a whole number is still a float on disk: 938400 written as
      // an int and read back as a float is a denormal, not the coordinate it was meant to be.
      if (typeof value === "object") view.setFloat32(at, value.f, true);
      else view.setInt32(at, value, true);
    }
  }
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

test("the light tables resolve their band rows, their yards and their axes", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadLightMetadata } = await import("../dist/code/gateway/LightMetadata.js");

  const directory = await mkdtemp(join(tmpdir(), "webclient-light-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Light: 15 fields. id, continent, three coords, two falloffs, eight parameter slots.
  // Row 1 is the whole-map default; row 2 is a volume one ADT tile across, and its stored triple
  // runs (y, height, x) in thirty-sixths of a yard the way the ADT placement chunks do.
  const stored = (yards) => ({ f: yards * 36 });
  const ZEROPOINT = 32 * 533.3333333333334;
  // Field 7 is slot 0 — clear above water — and field 9 is slot 2, the same place under a storm.
  // Row 2's volume names a storm set of its own; row 3's names the one it already has, which is
  // what 47.1% of the real rows do and which has to come back as no storm set at all.
  await writeFile(join(directory, "Light.dbc"), dbcFixture(15, [
    [1, 0, 0, 0, 0, 0, 0, 1, 0, 3],
    [2, 0, stored(ZEROPOINT - 250), stored(80), stored(ZEROPOINT + 9000), stored(100), stored(200), 2, 0, 3],
    // A second map with no default of its own, to prove it inherits Light row 1. Map 33 is one of
    // the nine real ones; 571 used to stand here and stopped being an example under Ж0.
    [3, 33, stored(ZEROPOINT), stored(0), stored(ZEROPOINT), stored(10), stored(20), 2, 0, 2],
    // Ж0: a map default written the way 44 of the real ones are — at the origin, with a falloff on
    // it anyway. Both parameter slots name the same set, which is what 34 of those 44 rows do.
    [4, 530, { f: 0 }, { f: 0 }, { f: 0 }, stored(10), stored(46.5), 2, 0, 2],
  ]));
  // LightParams points at an optional authored M2 sky model. The browser must retain the path
  // alongside the sampled colours so the renderer can request it when the profile is active.
  await writeFile(join(directory, "LightParams.dbc"), dbcFixture(9, [[1, 0, 77], [2], [3]]));
  // WotLK's LightSkybox table still stores the authoring extension. The archive route only serves
  // the converted M2, so this is the real Dalaran spelling rather than an already-normalized one.
  const skyName = "ENVIRONMENTS\\Stars\\DalaranSkyBox.mdx";
  const skyNameBytes = new TextEncoder().encode(skyName);
  const skyStrings = new Uint8Array(skyNameBytes.length + 2);
  skyStrings.set(skyNameBytes, 1);
  const sky = new Uint8Array(20 + 3 * 4 + skyStrings.length);
  sky.set(new TextEncoder().encode("WDBC"));
  const skyView = new DataView(sky.buffer);
  skyView.setUint32(4, 1, true);
  skyView.setUint32(8, 3, true);
  skyView.setUint32(12, 12, true);
  skyView.setUint32(16, skyStrings.length, true);
  skyView.setInt32(20, 77, true);
  skyView.setInt32(24, 1, true);
  skyView.setInt32(28, 0, true);
  sky.set(skyStrings, 32);
  await writeFile(join(directory, "LightSkybox.dbc"), sky);

  // Eighteen colour rows per parameter set and six float rows, both one-based: set 1 owns int rows
  // 1..18 and float rows 1..6, set 2 owns 19..36 and 7..12. Channel 7 is the fog, so it is int
  // row 8 of the first set and row 26 of the second.
  const ints = [];
  for (let id = 1; id <= 36; id++) ints.push(bandRow(id, [0, 1440], [0x000000, 0x000000]));
  ints[7] = bandRow(8, [0, 1440], [0x102030, 0x405060]);
  ints[18 + 7] = bandRow(26, [0, 1440], [0xff0000, 0x00ff00]);
  await writeFile(join(directory, "LightIntBand.dbc"), dbcFixture(34, ints));

  const floats = [];
  for (let id = 1; id <= 12; id++) floats.push(bandRow(id, [0], [{ f: 0 }]));
  floats[0] = bandRow(1, [0], [{ f: 18000 }]);
  floats[1] = bandRow(2, [0], [{ f: 0.25 }]);
  await writeFile(join(directory, "LightFloatBand.dbc"), dbcFixture(34, floats));

  const index = await loadLightMetadata(directory);
  const azeroth = index.get(0);
  assert.equal(azeroth.fallback, 1);
  assert.equal(azeroth.fallbackLightId, 1, "fallbackLightId is the Light row, not the params id");
  assert.equal(azeroth.volumes.length, 1);

  // The fog band of set 1 is channel 7, which is int row 8. Finding it anywhere else means the
  // one-based block arithmetic is off, which silently gives every zone another zone's sky.
  assert.deepEqual(azeroth.params[1].colours.fog, { times: [0, 1440], values: [0x102030, 0x405060] });
  assert.deepEqual(azeroth.params[2].colours.fog, { times: [0, 1440], values: [0xff0000, 0x00ff00] });
  assert.equal(azeroth.params[1].skyboxPath, "ENVIRONMENTS\\Stars\\DalaranSkyBox.m2");
  assert.deepEqual(azeroth.lights[2], { params: 2, stormParams: 3 });

  // Positions and radii are thirty-sixths of a yard, and the stored triple is (y, height, x).
  const volume = azeroth.volumes[0];
  assert.ok(Math.abs(volume.x - -9000) < 0.01, `expected x -9000, got ${volume.x}`);
  assert.ok(Math.abs(volume.y - 250) < 0.01, `expected y 250, got ${volume.y}`);
  assert.ok(Math.abs(volume.z - 80) < 0.01);
  assert.equal(volume.innerRadius, 100);
  assert.equal(volume.outerRadius, 200);

  // Fog distance is in the same thirty-sixths: 18000 is 500 yards, not 18 kilometres.
  assert.equal(azeroth.params[1].fogEnd.values[0], 500);
  assert.equal(azeroth.params[1].fogScale.values[0], 0.25);

  // A map with no default row of its own falls back to Light row 1 rather than to nothing.
  // Measured on this dataset: 9 of the 73 lit maps have none — 33, 37, 129, 169, 209, 451, 489,
  // 572 and 573. It was 53 until Ж0 stopped requiring a default row's falloff to be zero as well
  // as its position, and Northrend is no longer one of them: its own default is Light row 752,
  // which leaves it 96 volumes of its 97 rows.
  const inheritor = index.get(33);
  assert.equal(inheritor.fallback, 1);
  assert.equal(inheritor.fallbackLightId, 1, "inherited fallback keeps the global Light row id");
  assert.ok(inheritor.params[1], "the inherited set has to travel with the map that inherits it");
  // And so does the storm set it inherits, or the weather changes the light inside a volume and
  // snaps back the moment the player walks out of one.
  assert.equal(inheritor.fallbackStorm, 3);
  assert.ok(inheritor.params[3]);

  assert.equal(azeroth.fallbackStorm, 3, "the map's own default carries its storm set too");
  assert.equal(volume.stormParams, 3);
  assert.ok(azeroth.params[3], "and the set itself travels with it");
  // A row whose two slots name the same set says so by carrying no storm set at all.
  assert.equal(inheritor.volumes[0].stormParams, undefined);

  // Ж0: a row at the origin is the map's default whatever radius it carries. Requiring the radius
  // to be zero as well threw the default of 44 maps into the corner of the tile grid, where it
  // reached nothing, and the map then inherited Light 1 — the sky over Elwynn. Measured on this
  // machine's `Light.dbc` (715 rows): 64 rows sit at (0,0,0), 20 with a zero radius and 44 with
  // 0.28 to 987.20 yards — 1.28 is Northrend's row 752 alone, not the floor of the range; rows
  // with a real position and a zero radius number **0**, so the half
  // that was dropped filtered nothing. Maps holding their own default go 20 → 64 of 73, and the
  // two sets do not overlap — the 20 are Light ids 1…379, the 44 are ids 415…2538.
  const outland = index.get(530);
  assert.equal(outland.fallbackLightId, 4, "the row is the map's own default, not Light 1's");
  assert.equal(outland.fallback, 2);
  assert.deepEqual(outland.volumes, [], "and it is not a volume: there is nothing to fall off from");
  assert.ok(outland.params[2], "the parameter set travels with the map that defaults to it");
  // The named price: with both slots on one set there is no storm set, so weather stops changing
  // this map's light outside a volume. 34 of the 44 real rows are like this, Northrend's 752 among
  // them. Today those maps change the light by inheriting a stranger's row, which is worse.
  assert.equal(outland.fallbackStorm, undefined);

  // And the count moved by exactly the number of such rows — one here, 44 on the real table.
  const ownDefaults = [...index.values()].filter((entry) => entry.fallbackLightId !== 1);
  assert.deepEqual(ownDefaults.map((entry) => entry.fallbackLightId), [4]);

  // З1: the same default once more, standing alone under a key no URL can produce, because the
  // loop above can only hand it to maps that already have an entry. Measured on this dataset:
  // `Light.dbc` names 73 distinct continents while `Map.dbc` has 135 rows, so 62 maps own no row
  // of any kind — Gnomeregan (90), Molten Core (409), Blackrock Depths (230), Uldaman (70),
  // Maraudon (349), Gundrak (604) and the 28 `Transport*` maps among them.
  const standalone = index.get(-1);
  assert.ok(standalone, "the global default has to be published on its own, not only handed out");
  assert.equal(standalone.fallbackLightId, 1, "it is Light row 1 and says so");
  assert.equal(standalone.fallback, 1);
  assert.equal(standalone.fallbackStorm, 3, "with row 1's storm slot, or weather changes nothing");
  assert.deepEqual(standalone.volumes, [], "the default alone: no map's volumes ride along");
  assert.ok(standalone.params[1], "and the parameter set travels with it");
  assert.ok(standalone.params[3]);
  // `SMSG_OVERRIDE_LIGHT` names a Light.dbc row rather than a LightParams row, and
  // `resolveLighting` looks the target up in `lights`, so row 1 has to be resolvable here too.
  assert.deepEqual(standalone.lights, { 1: { params: 1, stormParams: 3 } });
  // A fresh object rather than map 0's, which the loop above mutates in place.
  assert.notEqual(standalone, azeroth);
});

test("a map with no Light.dbc row at all is served the global default instead of a 404", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");

  const directory = await mkdtemp(join(tmpdir(), "webclient-light-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Row 1 is the global default and map 0's own; row 2 is a volume on map 0. A map with no row of
  // its own has to get the first without the second.
  const stored = (yards) => ({ f: yards * 36 });
  const ZEROPOINT = 32 * 533.3333333333334;
  await writeFile(join(directory, "Light.dbc"), dbcFixture(15, [
    [1, 0, 0, 0, 0, 0, 0, 1, 0, 3],
    [2, 0, stored(ZEROPOINT - 250), stored(80), stored(ZEROPOINT + 9000), stored(100), stored(200), 2, 0, 2],
  ]));
  await writeFile(join(directory, "LightParams.dbc"), dbcFixture(9, [[1], [2], [3]]));
  // Eighteen colour rows per set, one-based: set 1 owns 1..18 and set 3 owns 37..54, so channel 7
  // — the fog — is row 8 and row 44.
  const ints = [];
  for (let id = 1; id <= 54; id++) ints.push(bandRow(id, [0], [0]));
  ints[7] = bandRow(8, [0], [0x102030]);
  ints[43] = bandRow(44, [0], [0x445566]);
  await writeFile(join(directory, "LightIntBand.dbc"), dbcFixture(34, ints));
  const floats = [];
  for (let id = 1; id <= 18; id++) floats.push(bandRow(id, [0], [{ f: 0 }]));
  floats[0] = bandRow(1, [0], [{ f: 18000 }]);
  await writeFile(join(directory, "LightFloatBand.dbc"), dbcFixture(34, floats));

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
    // Map 90 is Gnomeregan. Until this slice the route answered 404 there, `LightClient` cached
    // the failure as `null` and printed a red status line, and the renderer stayed on the
    // compiled-in `SKY_COLOR` 0x35506a with fog 180…640 and `#lightTime` pinned to zero — no
    // daily cycle at all on 62 of the 135 maps.
    const served = await fetch(`http://127.0.0.1:${gateway.port}/dbc/light/90`, { headers });
    assert.equal(served.status, 200);
    const body = await served.json();
    assert.equal(body.fallbackLightId, 1);
    assert.equal(body.fallback, 1);
    assert.equal(body.fallbackStorm, 3);
    assert.deepEqual(body.volumes, [], "map 0's volume must not follow the default across");
    assert.equal(body.params[1].colours.fog.values[0], 0x102030);
    assert.equal(body.params[1].fogEnd.values[0], 500, "and its bands, in yards");
    assert.ok(body.params[3], "and the storm set, or weather cannot change the light");

    // A map that does have rows keeps them.
    const azeroth = await (await fetch(`http://127.0.0.1:${gateway.port}/dbc/light/0`, { headers })).json();
    assert.equal(azeroth.volumes.length, 1);

    // And the key itself is unreachable from outside: the route matches `(\d{1,4})`.
    const negative = await fetch(`http://127.0.0.1:${gateway.port}/dbc/light/-1`, { headers });
    assert.notEqual(negative.status, 200);
  } finally {
    await gateway.close();
  }
});

test("the fog distance keeps its own clock, so no single range describes the whole day", () => {
  // The bands of `LightParams` 12 — the set behind `Light` row 1, which is what the 62 maps with
  // no row of their own are served — copied from this dataset key for key. The reviews caught the
  // README and two comments saying its fog is 125…500 yards at every hour: that is midnight and
  // noon only. `fogScale` is authored to exactly 0 at key 720, and the near plane is the far one
  // times the scale (`LightClient.ts:85-87`), so at dawn the fog starts in the camera plane.
  const set12 = {
    colours: Object.fromEntries(["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower",
      "skyHorizon", "fog", "oceanClose", "oceanFar", "riverClose", "riverFar"]
      .map((channel) => [channel, band([0], [0])])),
    fogEnd: band([0, 360, 720, 1440, 2520, 2640],
      [500, 500, 444.44444444444446, 500, 472.22222222222223, 481.48149956597223]),
    fogScale: band([0, 360, 720, 1440, 2520, 2640], [0.25, 0.25, 0, 0.25, 0.25, 0.25]),
  };
  const entry = { fallback: 12, params: { 12: set12 }, volumes: [] };
  const range = (time) => {
    const sample = resolveLighting(entry, 0, 0, time);
    return [Number(sample.fogStart.toFixed(2)), Number(sample.fogEnd.toFixed(2))];
  };

  // Band times are half-minutes of a 2880-unit day, so dawn is 720 and dusk 2160.
  assert.deepEqual(range(0), [125, 500], "midnight");
  assert.deepEqual(range(1440), [125, 500], "noon");
  assert.deepEqual(range(720), [0, 444.44], "dawn: the zero scale puts the near plane on the camera");
  assert.deepEqual(range(2160), [120.37, 481.48], "dusk, interpolated between the 1440 and 2520 keys");
});

test("the weather crossfades a zone into its own storm sky rather than a made-up one", () => {
  // Light.dbc has no intensity axis: a row names a clear parameter set and a storm one and nothing
  // between them, so the fade is made here. Zero has to be exactly what it was before the slice.
  const clear = resolveLighting(STORM_ENTRY, 0, 0, 1440, 0);
  assert.ok(Math.abs(clear.colours.fog.r - 0xa0 / 255) < 1e-6);
  const stormy = resolveLighting(STORM_ENTRY, 0, 0, 1440, 1);
  assert.equal(stormy.colours.fog.b, 1, "fully rolled in, the storm set is the whole answer");
  assert.equal(stormy.colours.fog.r, 0);
  // Halfway is halfway between the two colours channel by channel, and the clear sky's blue is
  // 0xe0 rather than nothing: 0.5 * 0xe0/255 + 0.5 * 1.0.
  const halfway = resolveLighting(STORM_ENTRY, 0, 0, 1440, 0.5);
  assert.ok(Math.abs(halfway.colours.fog.b - (0xe0 / 255 + 1) / 2) < 0.01, `got ${halfway.colours.fog.b}`);
  assert.ok(Math.abs(halfway.colours.fog.r - 0xa0 / 255 / 2) < 0.01);
});

test("a volume's own storm set is what a storm does inside it", () => {
  // Blended per layer, not once at the end: otherwise a town's own weather is averaged against the
  // clear sky of the zone around it and the town stops having weather of its own.
  const inside = resolveLighting(STORM_ENTRY, 100, 0, 1440, 1);
  assert.equal(inside.colours.fog.g, 1, "the volume's storm set, not the map's");
  assert.equal(inside.colours.fog.r, 0);
  assert.equal(inside.colours.fog.b, 0);
});

test("a zone whose two slots name the same set simply has no weather in its sky", () => {
  // 47.1% of the client's 715 rows are like this, and the gateway leaves the field off for them
  // rather than sending the same set twice.
  const stormless = resolveLighting(ENTRY, 0, 0, 1440, 1);
  const clear = resolveLighting(ENTRY, 0, 0, 1440, 0);
  assert.deepEqual(stormless.colours.fog, clear.colours.fog);
});

test("a scripted Light.dbc override replaces spatial volumes and carries the authored sky model", () => {
  const entry = {
    fallback: 1,
    fallbackLightId: 100,
    params: {
      1: set(DAY),
      2: set(0xff0000, "Environments\\Stars\\DalaranSky.m2"),
    },
    volumes: [{ id: 7, x: 100, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 2 }],
    lights: { 42: { params: 2 } },
  };
  // The fallback Light.dbc row is 100 while its LightParams row is 1. Comparing the packet's area
  // id to `fallback` would silently reject this valid map-wide override.
  const overridden = resolveLighting(entry, 0, 0, 1440, 0, 3, 0, 42, 1, 100);
  assert.equal(overridden.colours.fog.r, 1);
  assert.equal(overridden.skyboxPath, "Environments\\Stars\\DalaranSky.m2");
  const halfway = resolveLighting(entry, 0, 0, 1440, 0, 3, 0, 42, 0.5, 100);
  assert.ok(Math.abs(halfway.colours.fog.r - (1 + 0xa0 / 255) / 2) < 0.01);
  // A clear packet (target id 0) transitions from the previous scripted row back to the spatial
  // layer instead of snapping at receipt; A -> B uses the same source/target path.
  const cleared = resolveLighting(entry, 0, 0, 1440, 0, 3, 0, 0, 0.5, 100, 42);
  assert.ok(Math.abs(cleared.colours.fog.r - (1 + 0xa0 / 255) / 2) < 0.01);
  const changing = {
    ...entry,
    params: { ...entry.params, 3: set(0x00ff00) },
    lights: { ...entry.lights, 43: { params: 3 } },
  };
  const aToB = resolveLighting(changing, 0, 0, 1440, 0, 3, 0, 43, 0.5, 100, 42);
  assert.ok(Math.abs(aToB.colours.fog.r - 0.5) < 0.01);
  assert.ok(Math.abs(aToB.colours.fog.g - 0.5) < 0.01);
  // The packet's area id substitutes only that active Light.dbc layer. A tighter inner volume
  // remains authoritative instead of being repainted by an outer-zone transition.
  const nested = {
    ...entry,
    params: { ...entry.params, 3: set(0x00ff00) },
    volumes: [
      ...entry.volumes,
      { id: 9, x: 100, y: 0, z: 0, innerRadius: 5, outerRadius: 25, params: 3 },
    ],
  };
  const inner = resolveLighting(nested, 100, 0, 1440, 0, 3, 0, 42, 1, 7);
  assert.equal(inner.colours.fog.g, 1, "the tighter volume remains authoritative");
  assert.equal(inner.colours.fog.r, 0);
  assert.equal(resolveLighting(entry, 100, 0, 1440, 0, 3, 0, 42, 1, 999).colours.fog.r, 1);
  // Clearing the override (id 0) returns to ordinary spatial resolution.
  assert.equal(resolveLighting(entry, 100, 0, 1440, 0, 3, 0, 0).colours.fog.r, 1);
});

test("authored sky clips follow the game day rather than a five-minute wall-clock loop", () => {
  assert.equal(skyboxAnimationTimeMs(0, 320000), 0);
  assert.equal(skyboxAnimationTimeMs(1440, 320000), 160000);
  assert.equal(skyboxAnimationTimeMs(2880, 320000), 0);
  assert.equal(skyboxAnimationTimeMs(-1440, 320000), 160000);
  assert.equal(skyboxAnimationTimeMs(1440, 0), 0);
});

test("a clear override keeps its transition duration instead of snapping at packet receipt", () => {
  assert.equal(lightOverrideWeight(1000, 1000, 1000), 0);
  assert.equal(lightOverrideWeight(1500, 1000, 1000), 0.5);
  assert.equal(lightOverrideWeight(2000, 1000, 1000), 1);
  assert.equal(lightOverrideWeight(1500, 1000, 0), 1, "instant transitions remain immediate");
});

test("transparent authored sky is a background prepass, never a main-scene overlay", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const sky = source.indexOf("this.#renderer.render(this.#skyScene, this.#camera)");
  const depth = source.indexOf("this.#renderer.clearDepth()", sky);
  const world = source.indexOf("this.#renderer.render(this.#scene, this.#camera)", depth);
  assert.ok(sky >= 0 && depth > sky && world > depth, "sky must render before world depth");
  assert.match(source.slice(sky, world), /autoClear = false/);
});

test("a missing light sample clears the previous map's authored skybox", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const method = source.indexOf("updateLighting(sample");
  const missing = source.indexOf("if (!sample) {", method);
  const assignment = source.indexOf("this.#lightSample = sample;", missing);
  assert.ok(method >= 0 && missing > method && assignment > missing);
  assert.match(source.slice(missing, assignment), /this\.#skyboxPath = undefined/);
  assert.match(source.slice(missing, assignment), /this\.#resetLightingDefaults\(\)/);
  assert.match(source, /#resetLightingDefaults\(\): void[\s\S]*fog\.near = 180[\s\S]*fog\.far = 640/);
  assert.match(source, /#resetLightingDefaults\(\): void[\s\S]*#sunOffset\.set\(0, 400, 0\)[\s\S]*#sun\.position\.copy\(this\.#sun\.target\.position\)\.add\(this\.#sunOffset\)/);
});

test("a liquid cell's class comes out of the flag byte the map file already carries", async () => {
  const { liquidClassOf } = await import("../dist/code/browser/Water.js");
  // MAP_LIQUID_TYPE_WATER 0x01, OCEAN 0x02, MAGMA 0x04, SLIME 0x08, DARK_WATER 0x10. Every cell
  // used to draw as one translucent blue sheet because this byte was read and then discarded.
  assert.equal(liquidClassOf(0x01), "water");
  assert.equal(liquidClassOf(0x02), "ocean");
  assert.equal(liquidClassOf(0x04), "magma");
  assert.equal(liquidClassOf(0x08), "slime");

  // Dark water drains the swimmer; it is not a different surface.
  assert.equal(liquidClassOf(0x11), "water");
  assert.equal(liquidClassOf(0x12), "ocean");

  // A cell that somehow claims to be several is drawn as the one that would burn: showing lava as
  // a lake is the mistake that costs the player something.
  assert.equal(liquidClassOf(0x05), "magma");
  assert.equal(liquidClassOf(0x0a), "slime");
});

test("the liquid row beats the flag byte, because one row of the table lies about itself", async () => {
  const { liquidClassOf } = await import("../dist/code/browser/Water.js");
  const { liquidClassFromTexture } = await import("../dist/code/gateway/LiquidMetadata.js");

  // Row 181, "Orange Slime": sound bank 0, which the map file's flag repeats as water, and a
  // texture of XTEXTURES\LavaOrange. 49 chunks of Northrend were drawing lava as a blue river.
  assert.equal(liquidClassFromTexture("XTEXTURES\\LavaOrange\\LavaOrange.%d.blp", 0), "magma");
  assert.equal(liquidClassFromTexture("XTextures\\LavaGreen\\lavagreen.%d.blp", 2), "magma");
  assert.equal(liquidClassFromTexture("XTextures\\river\\lake_a.%d.blp", 0), "water");
  assert.equal(liquidClassFromTexture("XTextures\\ocean\\ocean_h.%d.blp", 1), "ocean");
  assert.equal(liquidClassFromTexture("XTextures\\slime\\slime.%d.blp", 3), "slime");
  // Row 100 names a reflection map rather than one of the four families, so its bank decides.
  assert.equal(liquidClassFromTexture("XTextures\\procWater\\basicReflectionMap.blp", 1), "ocean");

  const classes = new Map([[181, "magma"], [81, "water"]]);
  assert.equal(liquidClassOf(0x01, 181, classes), "magma", "the row, not the bank");
  assert.equal(liquidClassOf(0x01, 81, classes), "water");
  // Until the table lands, and on the 1,561 tiles that carry no id at all, the flag still answers.
  assert.equal(liquidClassOf(0x04, 181, undefined), "magma");
  assert.equal(liquidClassOf(0x02, 0, classes), "ocean");
  assert.equal(liquidClassOf(0x02, 999, classes), "ocean", "an id the table does not know is not a class");
});

test("each liquid class resolves to the texture family the client gives it", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { liquidTexturePattern, LIQUID_CLASSES } = await import("../tools/generate-liquid-texture.mjs");

  const directory = await mkdtemp(join(tmpdir(), "webclient-liquid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // LiquidType: 45 fields. Only the id, the name, the sound bank and the first texture matter.
  // Twenty-six rows in the real file collapse onto four sound banks, and the lowest-numbered row
  // of each bank is the one whose family the class takes: 1 Water, 2 Ocean, 3 Magma, 4 Slime,
  // against 5 "Slow Water" and 9 "Fast Water", which name the same lake texture.
  const names = ["", "XTextures\river\lake_a.%d.blp", "XTextures\ocean\ocean_h.%d.blp",
    "XTextures\lava\lava.%d.blp", "XTextures\slime\slime.%d.blp", "XTextures\river\fast_a.%d.blp"];
  const encoder = new TextEncoder();
  const offsets = new Map();
  let stringBytes = 0;
  for (const name of names) { offsets.set(name, stringBytes); stringBytes += encoder.encode(name).length + 1; }
  const rows = [
    [1, offsets.get(names[1]), 0, 0], [2, offsets.get(names[2]), 0, 1],
    [3, offsets.get(names[3]), 0, 2], [4, offsets.get(names[4]), 0, 3],
    // A higher-numbered row of the same bank, with a different texture, must not win.
    [9, offsets.get(names[5]), 0, 0],
  ];
  const fields = 45;
  const bytes = new Uint8Array(20 + rows.length * fields * 4 + stringBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("WDBC"));
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, stringBytes, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < 4; field++) view.setInt32(20 + (row * fields + field) * 4, rows[row][field], true);
    // Texture[0] is field 15.
    view.setInt32(20 + (row * fields + 15) * 4, rows[row][1], true);
  }
  let cursor = 20 + rows.length * fields * 4;
  for (const name of names) { bytes.set(encoder.encode(name), cursor); cursor += encoder.encode(name).length + 1; }
  await writeFile(join(directory, "LiquidType.dbc"), bytes);

  const expected = {
    water: "XTextures\river\lake_a.%d.blp",
    ocean: "XTextures\ocean\ocean_h.%d.blp",
    magma: "XTextures\lava\lava.%d.blp",
    slime: "XTextures\slime\slime.%d.blp",
  };
  for (const liquidClass of LIQUID_CLASSES) {
    assert.equal(await liquidTexturePattern(directory, liquidClass), expected[liquidClass]);
  }
  await assert.rejects(() => liquidTexturePattern(directory, "custard"));
});

test("the water bands are read as the pairs the file keeps them in", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadLightMetadata } = await import("../dist/code/gateway/LightMetadata.js");

  const directory = await mkdtemp(join(tmpdir(), "webclient-water-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "Light.dbc"), dbcFixture(15, [[1, 0, 0, 0, 0, 0, 0, 1]]));
  await writeFile(join(directory, "LightParams.dbc"), dbcFixture(9, [[1]]));

  // Channels 14 and 15 are ocean close and far, 16 and 17 river close and far. Measured: across
  // 553 tiles of open ocean taken from the minimap - where the surface colour is all there is,
  // the texture being black - channel 15 sits 6.2 away and the next nearest 35.6; and 14/15 are
  // the most correlated adjacent pair in the file at 0.576, 16/17 the next at 0.438 and greener.
  const ints = [];
  for (let id = 1; id <= 18; id++) ints.push(bandRow(id, [0], [0]));
  ints[14] = bandRow(15, [0], [0x111111]);
  ints[15] = bandRow(16, [0], [0x222222]);
  ints[16] = bandRow(17, [0], [0x333333]);
  ints[17] = bandRow(18, [0], [0x444444]);
  await writeFile(join(directory, "LightIntBand.dbc"), dbcFixture(34, ints));
  const floats = [];
  for (let id = 1; id <= 6; id++) floats.push(bandRow(id, [0], [{ f: 0 }]));
  await writeFile(join(directory, "LightFloatBand.dbc"), dbcFixture(34, floats));

  const set = (await loadLightMetadata(directory)).get(0).params[1];
  assert.equal(set.colours.oceanClose.values[0], 0x111111);
  assert.equal(set.colours.oceanFar.values[0], 0x222222);
  assert.equal(set.colours.riverClose.values[0], 0x333333);
  assert.equal(set.colours.riverFar.values[0], 0x444444);
});

test("the underwater light slot follows the camera eye rather than submerged feet", () => {
  const surface = { height: 12 };
  assert.equal(eyeUnderwater(11.99, surface), true, "eye below the surface selects slot 1");
  assert.equal(eyeUnderwater(12, surface), false, "the crossing itself remains above water");
  assert.equal(eyeUnderwater(13, surface), false,
    "eye above stays in slot 0 even if the character's feet are below the same surface");
  assert.equal(eyeUnderwater(0, undefined), false);
  assert.equal(eyeUnderwater(Number.NaN, surface), false);
});

test("only the underwater slot follows the eye; spatial Light.dbc volumes still follow the player", async () => {
  const source = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const camera = source.indexOf("const lightCamera = createCamera(");
  const sample = source.indexOf("const lightSample = game.light?.sample(", camera);
  assert.ok(camera >= 0 && sample > camera);
  const region = source.slice(camera, source.indexOf("game.renderer?.updateLighting", sample));
  assert.match(region,
    /liquidAt\(world\.mapId, lightCamera\.position\.x, lightCamera\.position\.y\)/,
    "the surface crossing is measured at the actual eye");
  assert.match(region, /world\.mapId, position\.x, position\.y, half, storm, position\.z/,
    "turning or zooming the camera must not jump between spatial light volumes");
});

test("the underwater slots reach the browser, and a slot that repeats does not", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadLightMetadata } = await import("../dist/code/gateway/LightMetadata.js");

  const directory = await mkdtemp(join(tmpdir(), "webclient-underwater-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Fields 7 to 10 are slots 0 to 3: clear above water, clear under it, stormy above, stormy
  // under. Row 1 is the map default and fills all four with different sets. Row 2 is a volume
  // that repeats: its slot 3 names the same set as its slot 1, which is what 409 of the 715 real
  // rows do, and it has to come back with no underwater storm set at all.
  const stored = (yards) => ({ f: yards * 36 });
  const ZEROPOINT = 32 * 533.3333333333334;
  await writeFile(join(directory, "Light.dbc"), dbcFixture(15, [
    [1, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4],
    [2, 0, stored(ZEROPOINT - 250), stored(80), stored(ZEROPOINT + 9000), stored(100), stored(200), 1, 2, 3, 2],
  ]));
  await writeFile(join(directory, "LightParams.dbc"), dbcFixture(9, [[1], [2], [3], [4]]));
  const ints = [];
  for (let id = 1; id <= 72; id++) ints.push(bandRow(id, [0], [0]));
  // Channel 7 is the fog colour, so it is int row 8 of set 1 and 8 + 18·(set − 1) after that.
  for (const [index, colour] of [0x101010, 0x202020, 0x303030, 0x404040].entries()) {
    ints[index * 18 + 7] = bandRow(index * 18 + 8, [0], [colour]);
  }
  await writeFile(join(directory, "LightIntBand.dbc"), dbcFixture(34, ints));
  const floats = [];
  for (let id = 1; id <= 24; id++) floats.push(bandRow(id, [0], [{ f: 0 }]));
  // Float channel 0 is the fog end, in thirty-sixths of a yard: 500 above water, 184 under it.
  for (const [index, yards] of [500, 184, 468, 216].entries()) {
    floats[index * 6] = bandRow(index * 6 + 1, [0], [{ f: yards * 36 }]);
    floats[index * 6 + 1] = bandRow(index * 6 + 2, [0], [{ f: 0.25 }]);
  }
  await writeFile(join(directory, "LightFloatBand.dbc"), dbcFixture(34, floats));

  const entry = (await loadLightMetadata(directory)).get(0);
  assert.equal(entry.fallback, 1);
  assert.equal(entry.fallbackStorm, 3);
  assert.equal(entry.fallbackUnderwater, 2, "slot 1 is published, which nothing did before this");
  assert.equal(entry.fallbackUnderwaterStorm, 4);
  assert.deepEqual(entry.lights[1], { params: 1, stormParams: 3, underwaterParams: 2, underwaterStormParams: 4 });
  assert.deepEqual(entry.lights[2], { params: 1, stormParams: 3, underwaterParams: 2 },
    "a slot 3 that repeats slot 1 is left out, the way a slot 2 that repeats slot 0 is");
  // And the sets they name travel with them, or the browser holds an id it cannot resolve.
  assert.deepEqual(Object.keys(entry.params).map(Number).sort((left, right) => left - right), [1, 2, 3, 4]);

  // The camera decides which pair is read. Above water the fog ends where slot 0 says and under it
  // where slot 1 does; this is the whole of what a swimming player was missing.
  const above = resolveLighting(entry, 0, 0, 0);
  const below = resolveLighting(entry, 0, 0, 0, 0, 3, undefined, undefined, 1, undefined, undefined, true);
  assert.equal(above.fogEnd, 500);
  assert.equal(below.fogEnd, 184);
  assert.equal(Math.round(above.colours.fog.r * 255), 0x10);
  assert.equal(Math.round(below.colours.fog.r * 255), 0x20);

  // A storm under water is slot 3, and where slot 3 repeats slot 1 the weather changes nothing —
  // which is the same answer the row's own data gives.
  const storm = resolveLighting(entry, 0, 0, 0, 1, 3, undefined, undefined, 1, undefined, undefined, true);
  assert.equal(storm.fogEnd, 216);
  const volume = entry.volumes[0];
  assert.equal(volume.underwaterParams, 2);
  assert.equal(volume.underwaterStormParams, undefined);
  const inside = resolveLighting(entry, -9000, 250, 0, 1, 3, 80, undefined, 1, undefined, undefined, true);
  assert.equal(inside.fogEnd, 184, "inside the volume the storm cannot move a slot the row did not fill");
});

test("in the client's own tables the underwater sky is a different sky in all but six zones", async (t) => {
  // The measurement the slice rests on, taken from the dataset rather than asserted from memory.
  let dbcDirectory;
  try {
    dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
  } catch {
    t.skip("no tswow dataset on this machine");
    return;
  }
  const { openDbcFile } = await import("../dist/code/gateway/Dbc.js");
  const { loadLightMetadata } = await import("../dist/code/gateway/LightMetadata.js");
  const light = await openDbcFile(dbcDirectory, "Light");
  const rows = [...light.rows()];
  assert.equal(rows.length, 715);

  let differ = 0;
  for (const row of rows) {
    if (light.int(row, "LightParamsID", 1) !== light.int(row, "LightParamsID", 0)) differ++;
  }
  assert.equal(differ, 709, "709 of the 715 rows name a different profile under water");

  // And it is a short teal fog rather than a long clear one. Averaged at noon over every row whose
  // profile carries a fog band at all: 501.9 yards above water against 184.1 under it. Slot 1's
  // sample is 695 rows and not 715 — 20 name a profile whose `LightFloatBand` row has a key count
  // of zero, and the client answers those with `sampleSet`'s own 500-yard default.
  const index = await loadLightMetadata(dbcDirectory);
  const params = new Map();
  for (const entry of index.values()) {
    for (const [id, set] of Object.entries(entry.params)) params.set(Number(id), set);
  }
  const NOON = 1440;
  const endAt = (id) => {
    const set = params.get(id);
    if (!set || set.fogEnd.times.length === 0) return undefined;
    let before = set.fogEnd.times.length - 1;
    for (let key = 0; key < set.fogEnd.times.length; key++) if (set.fogEnd.times[key] <= NOON) before = key;
    const after = (before + 1) % set.fogEnd.times.length;
    const span = (set.fogEnd.times[after] - set.fogEnd.times[before] + 2880) % 2880;
    if (span === 0) return set.fogEnd.values[before];
    const progress = ((NOON - set.fogEnd.times[before] + 2880) % 2880) / span;
    return set.fogEnd.values[before] + (set.fogEnd.values[after] - set.fogEnd.values[before]) * progress;
  };
  const means = [0, 1, 2, 3].map((slot) => {
    let total = 0;
    let count = 0;
    for (const row of rows) {
      const end = endAt(light.int(row, "LightParamsID", slot));
      if (end === undefined) continue;
      total += end;
      count++;
    }
    return { mean: total / count, count };
  });
  assert.equal(means[1].count, 695);
  assert.ok(Math.abs(means[0].mean - 501.9) < 0.05, `slot 0 at noon: ${means[0].mean.toFixed(1)}`);
  assert.ok(Math.abs(means[1].mean - 184.1) < 0.05, `slot 1 at noon: ${means[1].mean.toFixed(1)}`);
  assert.ok(Math.abs(means[2].mean - 468.2) < 0.05, `slot 2 at noon: ${means[2].mean.toFixed(1)}`);
  assert.ok(Math.abs(means[3].mean - 215.6) < 0.05, `slot 3 at noon: ${means[3].mean.toFixed(1)}`);

  // 645 of the 651 volumes across every map carry their own underwater profile, and the map
  // defaults carry one too — including the global one, Light row 1, whose slot 1 is LightParams 13.
  let volumes = 0;
  let withUnderwater = 0;
  for (const entry of index.values()) {
    for (const volume of entry.volumes) {
      volumes++;
      if (volume.underwaterParams !== undefined) withUnderwater++;
    }
  }
  assert.equal(volumes, 651);
  assert.equal(withUnderwater, 645);
  assert.equal(index.get(-1).fallbackUnderwater, 13);
});
