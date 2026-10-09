import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseCreatureModelMetadata } from "../dist/code/gateway/CreatureModelMetadata.js";
import { openDbc } from "../dist/code/gateway/Dbc.js";
import { creatureGeosetDataGeosets } from "../dist/code/browser/CreatureGeosetData.js";

// 6.11а (line A7a): three CreatureDisplayInfo columns the gateway now publishes. The numbers are the
// dataset's own (`.runtime/re-2026-10-05/A7a-A/probe-display-fields.mjs`): 1,264 displays with
// CreatureModelAlpha ≠ 255 (146 is 128), 39 with CreatureGeosetData (25748 is 0x1111), 560 with
// ParticleColorID (110 is 290), seven with alpha 0 (5125 among them).
let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
  if (!existsSync(join(dbcDirectory, "CreatureDisplayInfo.dbc"))) dbcDirectory = undefined;
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

let parsed;
function displays() {
  parsed ??= parseCreatureModelMetadata(
    readFileSync(join(dbcDirectory, "CreatureDisplayInfo.dbc")),
    readFileSync(join(dbcDirectory, "CreatureModelData.dbc")));
  return parsed;
}

test("6.11а a translucent display carries its alpha; an opaque one carries none of the three", withDataset, () => {
  const ghost = displays().get(146);
  assert.ok(ghost, "display 146 exists");
  assert.ok(Math.abs(ghost.alpha - 128 / 255) < 1e-9, `alpha ${ghost.alpha}`);
  assert.equal(displays().get(5125)?.alpha, 0, "alpha 0 is published, not dropped");
  const plain = displays().get(49);
  assert.ok(plain, "display 49 (HumanMale) exists");
  for (const field of ["alpha", "geosetData", "particleColor"]) {
    assert.equal(Object.hasOwn(plain, field), false, `${field} is absent on a plain display`);
  }
});

test("6.11а geoset data and particle colour pass through as numbers", withDataset, () => {
  assert.equal(displays().get(25748)?.geosetData, 0x1111);
  assert.equal(displays().get(110)?.particleColor, 290);
});

test("6.11а the counts match the census", withDataset, () => {
  let alpha = 0;
  let geoset = 0;
  let particle = 0;
  for (const metadata of displays().values()) {
    if (metadata.alpha !== undefined) alpha++;
    if (metadata.geosetData !== undefined) geoset++;
    if (metadata.particleColor !== undefined) particle++;
  }
  // Every row with a value has a model too; the census counted rows, this counts published displays.
  const table = openDbc(readFileSync(join(dbcDirectory, "CreatureDisplayInfo.dbc")), "CreatureDisplayInfo");
  let rowsAlpha = 0;
  for (const row of table.rows()) {
    if (displays().has(table.id(row)) && table.int(row, "CreatureModelAlpha") !== 255) rowsAlpha++;
  }
  assert.equal(alpha, rowsAlpha);
  assert.equal(geoset, 39);
  assert.ok(particle >= 1 && particle <= 560, `particle colours ${particle}`);
});

test("6.11а the nibble reading: lowest nibble is group 1, zero selects nothing, up to eight groups", () => {
  assert.deepEqual(creatureGeosetDataGeosets(0x1111), [101, 201, 301, 401]);
  assert.deepEqual(creatureGeosetDataGeosets(0x1213), [103, 201, 302, 401]);
  assert.deepEqual(creatureGeosetDataGeosets(0x22222211), [101, 201, 302, 402, 502, 602, 702, 802]);
  assert.deepEqual(creatureGeosetDataGeosets(0x11), [101, 201]);
  assert.deepEqual(creatureGeosetDataGeosets(0), []);
  assert.deepEqual(creatureGeosetDataGeosets(undefined), []);
});

// IronDwarf.m2's geosets, from the census (`probe-geosets.mjs`, 05.10) — the one model all 39 wear.
const IRON_DWARF_GEOSETS = new Set([0, 101, 102, 103, 104, 201, 202, 301, 302, 303, 401, 402]);

test("6.11а every one of the 39 displays decodes to geosets IronDwarf carries", withDataset, () => {
  let checked = 0;
  for (const metadata of displays().values()) {
    if (metadata.geosetData === undefined) continue;
    assert.match(metadata.model, /^Creature\\IronDwarf\\IronDwarf\.m2$/i, `display ${metadata.id}`);
    const geosets = creatureGeosetDataGeosets(metadata.geosetData);
    assert.equal(geosets.length, 4, `display ${metadata.id}: four groups`);
    for (const id of geosets) assert.ok(IRON_DWARF_GEOSETS.has(id), `display ${metadata.id}: ${id}`);
    checked++;
  }
  assert.equal(checked, 39);
});
