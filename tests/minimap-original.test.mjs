// 03.11: what Wow.exe's minimap is made of (ui/MinimapArt.ts, ui/TownTracking.ts), against what its frames showed
// (fixtures/minimap-wow.json; docs/implementation/minimap-original.ru.md says how each number was taken).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  MINIMAP_DEFAULT_INDOOR_ZOOM, MINIMAP_DEFAULT_OUTDOOR_ZOOM, MINIMAP_ZOOM_LEVELS, minimapPartyCell, minimapPastRim,
  minimapPoiHasArrow, minimapRimAngle, minimapRimPois, minimapTileTint, minimapTrackedCell, minimapYards, minimapZoomIndex,
} from "../dist/code/browser/ui/MinimapArt.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "../dist/code/world/FactionRules.js";

const recorded = JSON.parse(readFileSync(new URL("./fixtures/minimap-wow.json", import.meta.url), "utf8"));

test("six steps of zoom, each table widest first, the fitted yards within two of the outdoor one", () => {
  assert.equal(MINIMAP_ZOOM_LEVELS, 6);
  recorded.outdoorYards.forEach((fitted, zoom) => {
    assert.ok(Math.abs(minimapYards(false, zoom) - fitted) < 2, `zoom ${zoom}: ${minimapYards(false, zoom)} against ${fitted}`);
  });
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((zoom) => minimapYards(true, zoom)), [300, 240, 180, 120, 80, 50]);
  assert.equal(MINIMAP_DEFAULT_OUTDOOR_ZOOM, 0, "the client's minimapZoom");
  assert.equal(MINIMAP_DEFAULT_INDOOR_ZOOM, 3, "the client's minimapInsideZoom");
  assert.equal(minimapZoomIndex(6, 2), 2, "a stored value out of range");
  assert.equal(minimapZoomIndex("3", 2), 2, "or not a step at all");
  assert.equal(minimapZoomIndex(5, 2), 5);
});

test("tracking's dot follows what the unit is to the player", () => {
  assert.deepEqual(minimapTrackedCell(REACTION_HOSTILE), { column: 5, row: 0 });
  assert.deepEqual(minimapTrackedCell(REACTION_NEUTRAL), { column: 6, row: 0 });
  assert.deepEqual(minimapTrackedCell(REACTION_FRIENDLY), { column: 7, row: 0 });
});

test("a party dot is its class's cell, white when the class is not known", () => {
  assert.deepEqual(minimapPartyCell(1), { column: 0, row: 0 }, "the warrior's tan, as on the frame");
  assert.deepEqual(minimapPartyCell(8), { column: 7, row: 0 });
  assert.deepEqual(minimapPartyCell(9), { column: 0, row: 1 });
  assert.deepEqual(minimapPartyCell(undefined), { column: 4, row: 0 });
  assert.deepEqual(minimapPartyCell(0), { column: 4, row: 0 });
});

test("the rim begins at 0.8 of the radius, and an arrow's picture turns towards what it names", () => {
  const player = { x: 0, y: 0 };
  assert.equal(minimapPastRim(player, { x: 79, y: 0 }, 100), false, "Stormwind from the road at zoom 4: no arrow");
  assert.equal(minimapPastRim(player, { x: 79, y: 0 }, 66.67), true, "at zoom 5: an arrow");
  assert.equal(minimapPoiHasArrow(player, { x: 690, y: 0 }, 233), true);
  assert.equal(minimapPoiHasArrow(player, { x: 720, y: 0 }, 233), false);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(minimapRimAngle(player, { x: 10, y: 0 }), 0), "north is up");
  assert.ok(near(minimapRimAngle(player, { x: 0, y: -10 }), Math.PI / 2), "east, which is falling y, is to the right");
  assert.ok(near(minimapRimAngle(player, { x: 10, y: 0 }, Math.PI / 2), Math.PI / 2), "with the map turning under a character facing west, north is to the right");
});

test("the tile tint stays within a tenth of what the frames showed", () => {
  for (const { name, ambient, diffuse, tint } of recorded.tint) {
    const colour = (v) => ({ r: v[0], g: v[1], b: v[2] });
    minimapTileTint(colour(ambient), colour(diffuse)).forEach((value, channel) => {
      assert.ok(Math.abs(value - tint[channel]) < 0.1, `${name}, channel ${channel}: ${value} against ${tint[channel]}`);
    });
  }
  assert.deepEqual(minimapTileTint({ r: 2, g: 2, b: 2 }, { r: 2, g: 2, b: 2 }), [1, 1, 1], "never above the picture");
});

const clientDirectory = process.env.CLIENT_DIR ?? "F:/Circle";
const withClient = { skip: existsSync(`${clientDirectory}/Data`) ? false : `no client at ${clientDirectory}` };

test("against Wow.exe's frames: which positions get how many arrows", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const archives = await clientArchives(clientDirectory);
  const data = Buffer.from(await archives.read(["DBFilesClient", "AreaPOI.dbc"].join(String.fromCharCode(92))));
  const records = data.readUInt32LE(4), size = data.readUInt32LE(12);
  const pois = [];
  for (let record = 0; record < records; record++) {
    const at = 20 + record * size;
    pois.push({
      x: data.readFloatLE(at + 12 * 4), y: data.readFloatLE(at + 13 * 4), mapId: data.readUInt32LE(at + 15 * 4),
      flags: data.readUInt32LE(at + 16 * 4), worldStateId: data.readUInt32LE(at + 52 * 4),
    });
  }
  for (const { name, map, x, y, yards, count } of recorded.arrows) {
    const got = minimapRimPois(pois, map).filter((poi) => minimapPoiHasArrow({ x, y }, poi, yards / 2)).length;
    assert.equal(got, count, name);
  }
});

test("the town trackers: the client's order, and the two a class alone gets", async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { townTrackersOf } = await import("../dist/code/browser/ui/TownTracking.js");
  const names = (classId) => townTrackersOf(classId).map((row) => row.name.replace("MINIMAP_TRACKING_", ""));
  const common = ["REPAIR", "VENDOR_FOOD", "VENDOR_AMMO", "VENDOR_REAGENT", "INNKEEPER", "FLIGHTMASTER", "BATTLEMASTER", "TRAINER_CLASS",
    "TRAINER_PROFESSION", "AUCTIONEER", "BANKER", "MAILBOX", "TRIVIAL_QUESTS"];
  assert.deepEqual(names(1), common, "as Wow.exe listed them for a warrior");
  const rogue = [...common];
  rogue.splice(2, 0, "VENDOR_POISON");
  assert.deepEqual(names(4), rogue);
  const hunter = [...common];
  hunter.splice(6, 0, "STABLEMASTER");
  assert.deepEqual(names(3), hunter);
});
