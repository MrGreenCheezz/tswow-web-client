import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  creatureDisplayAlpha, creatureGeosetChoice, isParticleColours, particleColouredWvm,
} from "../dist/code/browser/CreatureDisplayLook.js";
import { EVERY_GEOSET, geosetList, geosetVisible } from "../dist/code/browser/ModelBuild.js";
import { attachParticleColors, parseParticleColors } from "../dist/code/gateway/ParticleColors.js";

// 6.11а (line A7a, slice H, 05.10): applying the three CreatureDisplayInfo columns.
// Wow.exe 3.3.5a 12340: 0x004e7790 (called with the unit's model and display record) walks the
// CreatureGeosetData word four bits at a time, lowest first, for groups 100..800: a non-zero value v
// hides the group's whole range g..g+99 (0x0082c7c0(g, g + 99, 0)) and shows g + v. 0x004ea9e0 sets the
// three ParticleColor sets as slots 11, 12 and 13 (start = column 1 + i, mid = 4 + i, end = 7 + i), and
// 0x00825410 hands them to every emitter whose particleColorIndex (record +0x2a) equals the slot;
// 0x0097a990 stores the three colours' RGB bytes as the emitter's colour override — alpha untouched.

const IRON_DWARF = [0, 101, 102, 103, 104, 201, 202, 301, 302, 303, 401, 402];
const model = (ids) => ({ submeshes: ids.map((geosetId) => ({ geosetId })) });
const drawn = (choice, ids) => ids.filter((id) => geosetVisible(id, choice));

test("6.11а alpha: absent is opaque, the column's fraction multiplies, nonsense is opaque", () => {
  assert.equal(creatureDisplayAlpha(undefined), 1);
  assert.equal(creatureDisplayAlpha({}), 1);
  assert.equal(creatureDisplayAlpha({ alpha: 128 / 255 }), 128 / 255);
  assert.equal(creatureDisplayAlpha({ alpha: 0 }), 0);
  assert.equal(creatureDisplayAlpha({ alpha: Number.NaN }), 1);
  assert.equal(creatureDisplayAlpha({ alpha: 3 }), 1);
});

test("6.11а geosets: each group with a value shows that one member and hides the rest (0x004e7790)", () => {
  const choice = creatureGeosetChoice(model(IRON_DWARF), EVERY_GEOSET, 0x1213);
  assert.deepEqual(drawn(choice, IRON_DWARF), [0, 103, 201, 302, 401]);
  assert.deepEqual(drawn(creatureGeosetChoice(model(IRON_DWARF), EVERY_GEOSET, 0x1111), IRON_DWARF),
    [0, 101, 201, 301, 401]);
});

test("6.11а geosets: no data, or nothing to say, returns the same choice", () => {
  assert.equal(creatureGeosetChoice(model(IRON_DWARF), EVERY_GEOSET, undefined), EVERY_GEOSET);
  assert.equal(creatureGeosetChoice(model(IRON_DWARF), EVERY_GEOSET, 0), EVERY_GEOSET);
  // A value whose geoset the model lacks names nothing it can show (group 9+ is never read either).
  assert.equal(creatureGeosetChoice(model(IRON_DWARF), EVERY_GEOSET, 0x5), EVERY_GEOSET);
});

test("6.11а geosets: a group whose id the model lacks is left as it was, never emptied", () => {
  // Group 1 asks for 105 (absent); groups 2..4 are applied (201, 302, 402).
  const choice = creatureGeosetChoice(model(IRON_DWARF), EVERY_GEOSET, 0x2215);
  assert.deepEqual(drawn(choice, IRON_DWARF), [0, 101, 102, 103, 104, 201, 302, 402]);
});

test("6.11а geosets: on an explicit list the chosen member is added and its siblings removed", () => {
  const base = geosetList([0, 101, 501]);
  const choice = creatureGeosetChoice(model([0, 101, 102, 501, 502]), base, 0x2);
  assert.deepEqual(drawn(choice, [0, 101, 102, 501, 502]), [0, 102, 501]);
});

const emitter = (particleColorIndex, keys = 3) => ({
  particleColorIndex,
  color: { components: 3, times: Float32Array.from(keys === 3 ? [0, 0.4, 1] : [0, 1]), values: new Float32Array(keys * 3) },
  opacity: { components: 1, times: Float32Array.from([0, 1]), values: Float32Array.from([1, 0]) },
});
// ParticleColor row: Start[3], Mid[3], End[3] as 0xAARRGGBB.
const COLOURS = [
  0xff102030, 0xff405060, 0xff708090,
  0xffa0b0c0, 0x80d0e0f0, 0xff010203,
  0xff040506, 0xff070809, 0xff0a0b0c,
];

test("6.11а particle colours: slots 11..13 take start/mid/end of their set, RGB only", () => {
  const wvm = { particleEmitters: [emitter(0), emitter(11), emitter(12), emitter(13, 2)], ribbonEmitters: [] };
  const coloured = particleColouredWvm(wvm, COLOURS);
  assert.notEqual(coloured, wvm);
  assert.equal(coloured.particleEmitters[0], wvm.particleEmitters[0], "index 0 keeps its own emitter");
  const twelve = coloured.particleEmitters[2];
  assert.deepEqual([...twelve.color.times], [...wvm.particleEmitters[2].color.times], "three authored keys keep their times");
  const near = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) < 1e-6);
  assert.ok(near([...twelve.color.values], [0x40 / 255, 0x50 / 255, 0x60 / 255, 0xd0 / 255, 0xe0 / 255, 0xf0 / 255, 0x07 / 255, 0x08 / 255, 0x09 / 255]),
    `set 1: ${[...twelve.color.values].map((v) => Math.round(v * 255).toString(16))}`);
  assert.equal(twelve.opacity, wvm.particleEmitters[2].opacity, "alpha stays the emitter's own");
  const eleven = coloured.particleEmitters[1];
  assert.ok(near([...eleven.color.values].slice(0, 3), [0x10 / 255, 0x20 / 255, 0x30 / 255]));
  assert.deepEqual([...coloured.particleEmitters[3].color.times], [0, 0.5, 1], "a ramp of another shape gets start/mid/end");
  assert.equal(particleColouredWvm(wvm, COLOURS), coloured, "memoised per model and row");
  assert.equal(particleColouredWvm(wvm, undefined), wvm);
  const plain = { particleEmitters: [emitter(0)], ribbonEmitters: [] };
  assert.equal(particleColouredWvm(plain, COLOURS), plain, "nothing to recolour is the same model");
});

test("6.11а particle colours: the wire shape is nine 32-bit numbers", () => {
  assert.equal(isParticleColours(undefined), true);
  assert.equal(isParticleColours(COLOURS), true);
  assert.equal(isParticleColours(COLOURS.slice(1)), false);
  assert.equal(isParticleColours([...COLOURS.slice(1), -1]), false);
  assert.equal(isParticleColours("ff"), false);
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
  if (!existsSync(join(dbcDirectory, "ParticleColor.dbc"))) dbcDirectory = undefined;
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

test("6.11а gateway: ParticleColor.dbc rows travel with the displays that name them", withDataset, () => {
  const colours = parseParticleColors(readFileSync(join(dbcDirectory, "ParticleColor.dbc")));
  assert.equal(colours.size, 106);
  assert.deepEqual(colours.get(282)?.slice(0, 2), [0xff000766, 0xff005966]);
  const displays = new Map([[110, { id: 110, particleColor: 282 }], [49, { id: 49 }], [7, { id: 7, particleColor: 99999 }]]);
  attachParticleColors(displays, colours);
  assert.equal(displays.get(110).particleColors.length, 9);
  assert.equal(displays.get(110).particleColors[8], colours.get(282)[8]);
  assert.equal(Object.hasOwn(displays.get(49), "particleColors"), false);
  assert.equal(Object.hasOwn(displays.get(7), "particleColors"), false, "a missing row sends nothing");
});

test("6.11а gateway: a file that is not a 10-column WDBC parses to nothing", () => {
  assert.equal(parseParticleColors(new Uint8Array(8)).size, 0);
  const wrong = Buffer.alloc(20 + 8);
  wrong.write("WDBC", 0, "latin1");
  wrong.writeUInt32LE(1, 4); wrong.writeUInt32LE(2, 8); wrong.writeUInt32LE(8, 12);
  assert.equal(parseParticleColors(wrong).size, 0);
});
