import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
const water = await readFile(new URL("../src/browser/Water.ts", import.meta.url), "utf8");
const terrainSplat = await readFile(new URL("../src/browser/TerrainSplat.ts", import.meta.url), "utf8");
const terrain = await readFile(new URL("../src/browser/Terrain.ts", import.meta.url), "utf8");
const groundCover = await readFile(new URL("../src/browser/GroundCover.ts", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/browser/ui/SettingsModel.ts", import.meta.url), "utf8");

function methodSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} production seam exists`);
  return source.slice(start, end);
}

function currentGroundCoverDistanceScale() {
  const start = groundCover.indexOf("export function groundCoverDistanceScale(");
  const end = groundCover.indexOf("\n}", start) + 2;
  assert.ok(start >= 0 && end > start, "ground-cover fade helper source exists");
  const javascript = ts.transpileModule(groundCover.slice(start, end).replace("export function", "function"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function("GROUND_COVER_FADE_WIDTH", `${javascript}; return groundCoverDistanceScale;`)(20);
}

function currentDrawableModel() {
  const start = renderer.indexOf("export function legacyVisualHasRenderableMaterial(");
  const endMarker = "\n}\n\n/**\n * Whether a placement";
  const end = renderer.indexOf(endMarker, start) + 2;
  assert.ok(start >= 0 && end > start, "drawable visual predicate source exists");
  const javascript = ts.transpileModule(
    renderer.slice(start, end).replaceAll("export function", "function"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  return Function(`${javascript}; return drawableModel;`)();
}

test("production terrain micro-normals do not expose authored tile or chunk outlines", () => {
  assert.doesNotMatch(terrainSplat, /fract\(vSplatUv\s*\*\s*16\.0\)/,
    "a periodic zero-normal strip paints the 16x16 authored chunk grid onto otherwise continuous ground");
  assert.match(terrainSplat, /terrainMicroGradientLength/,
    "only actual derivative outliers are suppressed, without a square spatial mask");
});

test("water uses sparse broad waves instead of several crossing high-frequency bands", () => {
  // The broad swell (mask 2) used to be two crossing sines; their sum repeats as a lattice across a
  // lake. It is now two rotated octaves of value noise (Water.ts waterSwell). Keep the old intent:
  // at most two octaves, broad cells, slow drift — and no periodic sine band left in the wave.
  const waveSource = methodSource(water, "  // Broad swell from two rotated octaves", "\n  outgoingLight *=");
  assert.doesNotMatch(waveSource, /sin\(\s*dot\(vWaterWorldPosition/,
    "no periodic sine band may come back into the swell");
  const swell = methodSource(water, "vec3 waterSwell(vec2 p, float time, float footprint) {", "\n}\n");
  const octave = /waterNoise\(\(.*?\(time \* ([0-9.]+)\)\)\s*\/\s*([0-9.]+)\)/g;
  const octaves = [...swell.matchAll(octave)].map((match) => ({
    drift: Number(match[1]),
    cell: Number(match[2]),
  }));
  assert.ok(octaves.length > 0, "the live shader still contains a visible swell");
  assert.ok(octaves.length <= 2, `only two swell octaves may cross, found ${octaves.length}`);
  assert.ok(octaves.every(({ cell }) => cell >= 10),
    `broad waves need cells of at least 10 yd: ${JSON.stringify(octaves)}`);
  assert.ok(octaves.every(({ drift }) => drift <= 0.55),
    `slow waves need drift <= 0.55: ${JSON.stringify(octaves)}`);
});

test("missing environment visuals stay hidden without rejecting authored flat-colour legacy art", () => {
  const drawable = methodSource(renderer, "export function drawableModel(", "\n}\n\n/**\n * Whether a placement");
  assert.match(drawable, /legacyVisualHasRenderableMaterial\(model\)/,
    "legacy visual artifacts and untrusted collision geometry use one canonical gate");
  const accepts = currentDrawableModel();
  assert.equal(accepts({ vertices: [0, 0, 0], indices: [0, 0, 0] }), false);
  assert.equal(accepts({ vertices: [], indices: [], visual: true }), false);
  assert.equal(accepts({
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], visual: true,
  }), true, "the visual decoder's authored flat-colour model is not a collision proxy");
  assert.equal(accepts({
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
    textureUrl: "/texture.blp", visual: true,
  }), true);
  assert.equal(accepts({
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], visual: true,
    groups: [
      { start: 0, count: 3, material: 0 },
      { start: 0, count: 3, material: 1 },
    ],
    textureUrls: ["/texture.blp", ""],
  }), true, "one unresolved material must not hide every authored group");
  assert.equal(accepts({ vertices: [], indices: [], wvm: {} }), true);
});

test("environment and default grass draw farther out so their binary boundary is off-camera", () => {
  assert.match(terrain, /export const ENVIRONMENT_RANGE\s*=\s*(?:4\d\d|[5-9]\d\d|\d{4,})\s*;/,
    "environment visibility needs at least a 400-yard exterior radius");
  assert.match(groundCover, /export const GROUND_COVER_MAX_RADIUS\s*=\s*(?:18\d|19\d|[2-9]\d\d|\d{4,})\s*;/,
    "grass settings need headroom beyond the old 140-yard cap");
  assert.match(groundCover, /export const GROUND_COVER_BUDGET\s*=\s*(?:10_000|1\d{4,})\s*;/,
    "the default field must reach its fade band instead of ending at the old 6,000-instance cliff");
  assert.match(settings, /id:\s*"grassRadius"[\s\S]{0,160}?fallback:\s*(?:8\d|9\d|[1-9]\d{2,})\s*,/,
    "fresh settings start beyond the visibly abrupt 50-yard boundary");
  const scale = currentGroundCoverDistanceScale();
  assert.equal(scale(100, 100), 0);
  assert.equal(scale(80, 100), 1);
  assert.ok(scale(90, 100) > 0 && scale(90, 100) < 1,
  "grass instances shrink through the outer band rather than popping at one radius");
});
