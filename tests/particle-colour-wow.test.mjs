import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { particleColourOverride, particleTableMiddle } from "../dist/code/browser/CreatureDisplayLook.js";
import { mountBuildKey, mountGeosets } from "../dist/code/browser/MountDisplayLook.js";
import { EVERY_GEOSET, geosetVisible } from "../dist/code/browser/ModelBuild.js";

// 13.10 6.11: the display's ParticleColor placement and the mount's display look, as Wow.exe 3.3.5a 12340 does
// them (read-only Ghidra). 0x0097d370 builds an emitter's three-segment table (start, middle at +0x118, end)
// only under its conditions; 0x0097aff0 fills it from the override 0x0097a990 stored, 0x00979d60 samples it.
// Without the table 0x00979e90 → 0x009795d0 samples the emitter's own colour keys, key k from override colour k.
// 0x0073d5d0 (the unit's mount) runs 0x004e7790 (CreatureGeosetData) and 0x004f20c0 (skins, ParticleColor) on the
// mount model.

const ramp = (times, values, components = 1) => ({ components, times: Float32Array.from(times), values: Float32Array.from(values) });
const emitter = (overrides = {}) => ({
  particleColorIndex: 11, flags: 0, lifespanVary: 0, scaleVary: [0, 0], textureRows: 1, textureColumns: 1,
  color: ramp([0, 0.3, 1], new Array(9).fill(0), 3), opacity: ramp([0, 1], [1, 0]), scale: ramp([0, 1], [1, 1, 2, 2], 2),
  headCell: ramp([], []), tailCell: ramp([], []),
  ...overrides,
});
const COLOURS = [0xff102030, 0, 0, 0xff405060, 0, 0, 0xff708090, 0, 0];
const near = (actual, expected) => actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]) < 1e-6);

test("6.11 the table's middle is the shared second key of the first three-key ramp", () => {
  assert.equal(particleTableMiddle(emitter()), Math.fround(0.3), "colour's own middle");
  assert.equal(particleTableMiddle(emitter({ color: ramp([0, 1], new Array(6).fill(0), 3),
    opacity: ramp([0, 0.6, 1], [0, 1, 0]) })), Math.fround(0.6), "or opacity's when colour has two keys");
  assert.equal(particleTableMiddle(emitter({ color: ramp([0, 1], new Array(6).fill(0), 3) })), 0, "none with three: 0");
  assert.equal(particleTableMiddle(emitter({ opacity: ramp([0, 0.5, 1], [0, 1, 0]) })), undefined, "middles that disagree: no table");
  assert.equal(particleTableMiddle(emitter({ lifespanVary: 0.2 })), undefined, "a varied lifespan: no table");
  assert.equal(particleTableMiddle(emitter({ scaleVary: [0.1, 0] })), undefined, "a scale vary: no table");
  assert.equal(particleTableMiddle(emitter({ scale: ramp([0, 1], [1, 2, 2, 2], 2) })), undefined, "a non-uniform scale: no table");
  assert.equal(particleTableMiddle(emitter({ color: ramp([0, 0.2, 0.5, 1], new Array(12).fill(0), 3) })), undefined, "four colour keys: no table");
});

test("6.11 with the table the colours sit at 0, its middle and 1", () => {
  const over = particleColourOverride(COLOURS, 0, emitter({ color: ramp([0, 1], new Array(6).fill(0), 3),
    opacity: ramp([0, 0.6, 1], [0, 1, 0]) }));
  assert.ok(near([...over.times], [0, Math.fround(0.6), 1]));
  assert.ok(near([...over.values], [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90].map((v) => v / 255)));
});

test("6.11 without the table the colours ride the emitter's own keys, and one key keeps its colour", () => {
  const four = emitter({ color: ramp([0, 0.2, 0.5, 1], new Array(12).fill(0), 3) });
  const over = particleColourOverride(COLOURS, 0, four);
  assert.deepEqual([...over.times], [...four.color.times]);
  assert.ok(near([...over.values].slice(9), [0x70 / 255, 0x80 / 255, 0x90 / 255]), "past the third key: the end colour");
  const single = emitter({ color: ramp([0], [0.5, 0.5, 0.5], 3), lifespanVary: 1 });
  assert.equal(particleColourOverride(COLOURS, 0, single), single.color, "0x009795d0 reads a one-key ramp as it is");
});

test("6.11 a mount's display picks its geosets and keys its build by them", () => {
  const model = { submeshes: [0, 101, 102, 201, 202].map((geosetId) => ({ geosetId })) };
  const choice = mountGeosets(model, EVERY_GEOSET, 0x12);
  assert.deepEqual([0, 101, 102, 201, 202].filter((id) => geosetVisible(id, choice)), [0, 102, 201]);
  assert.equal(mountGeosets(model, EVERY_GEOSET, undefined), EVERY_GEOSET);
  assert.equal(mountBuildKey("drake.m2|a", 0x12), "drake.m2|a#g18");
  assert.equal(mountBuildKey("drake.m2|a", undefined), "drake.m2|a");
  assert.equal(mountBuildKey("drake.m2|a", 0), "drake.m2|a");
});

test("6.11 the renderer applies the mount display's geosets and particle colours", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /const key = mountBuildKey\(modelKey\(metadata\.model, metadata\.textures\), metadata\.geosetData\);/);
  assert.match(source, /mountGeosets\(wvm, unitGeosets\(undefined,[\s\S]{0,120}?metadata\.geosetData\)/);
  assert.match(source, /wvm: particleColouredWvm\(mount\.wvm, mount\.metadata\.particleColors\)/);
});
