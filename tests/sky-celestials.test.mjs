// 05.10-A7b-6 (7.04 slices 1–4, 7.21): the procedural sky's sun, moons, stars and clouds, and the
// LightSkybox flags, against the numbers read out of Wow.exe 12340 (addresses in SkyCelestials.ts).
// Also a static check of the two new sky programs (no WebGL in Node): every identifier declared,
// functions defined before use, float-only literals, uniforms and varyings matching the material.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  CELESTIAL_FRAGMENT_SHADER, CELESTIAL_VERTEX_SHADER, CLOUD_FRAGMENT_SHADER, CLOUD_VERTEX_SHADER,
  MOON_AZIMUTH, MOON_POLAR, MOON_SCALE, STAR_ALPHA, SUN_AZIMUTH, SUN_POLAR, SUN_SCALE,
  SkyCelestials, celestialDirection, cloudCoverThreshold, cloudLightIsSun, computeCelestialFrame,
  createCelestialFrame, createSkyCelestialInput, moon2Fraction, skyBasicMaterials, skyDayFraction,
  skyKeyCurve, skyboxClipTimeMs, skyboxCoversSky, starAlpha, starsDrawn,
} from "../dist/code/browser/SkyCelestials.js";
import { skyboxAnimationTimeMs } from "../dist/code/browser/LightClient.js";
import { godRaySunDirection, godRayVisibility } from "../dist/code/browser/WorldRenderer3D.js";

const near = (actual, expected, epsilon = 1e-6) => Math.abs(actual - expected) <= epsilon;
const degrees = (radians) => radians * 180 / Math.PI;

test("7.04 the key interpolator clamps, interpolates and wraps across midnight like 0x7ed3b0", () => {
  const keys = [0.25, 0, 0.75, 1];
  assert.equal(skyKeyCurve(keys, 0.25), 0);
  assert.equal(skyKeyCurve(keys, 0.5), 0.5);
  assert.equal(skyKeyCurve(keys, 0.75), 1);
  // Before the first key: between the last key and the first, a day apart.
  assert.equal(skyKeyCurve(keys, 0), 0.5);
  assert.equal(skyKeyCurve(keys, 0.875), 0.75);
  // Clamped to [0, 1] first.
  assert.equal(skyKeyCurve(keys, -3), 0.5);
  assert.equal(skyKeyCurve(keys, 7), 0.5);
  assert.equal(skyKeyCurve(keys, Number.NaN), 0.5);
  // A pair closer than 0.001 holds the earlier value.
  assert.equal(skyKeyCurve([0.5, 3, 0.5005, 9], 0.5003), 3);
  assert.equal(skyKeyCurve([], 0.5), 0);
});

test("7.04 the tables are the client's: sun on one bearing, moons at 35° from the zenith", () => {
  assert.ok(near(degrees(skyKeyCurve(SUN_POLAR, 0.5)), 5, 1e-4));
  assert.ok(near(degrees(skyKeyCurve(SUN_AZIMUTH, 0.3)), 45, 1e-4));
  assert.ok(near(degrees(skyKeyCurve(MOON_POLAR, 0)), 35, 1e-4));
  assert.ok(near(degrees(skyKeyCurve(MOON_AZIMUTH, 0.95)), 45, 1e-4));
  assert.equal(skyKeyCurve(SUN_SCALE, 0.25), 2);
  assert.equal(skyKeyCurve(SUN_SCALE, 0.5), 1);
  assert.equal(skyKeyCurve(MOON_SCALE, 0.5), 1.5);
  assert.equal(skyKeyCurve(STAR_ALPHA, 0.5), 0);
  assert.equal(skyKeyCurve(STAR_ALPHA, 0.05), 1);
});

test("7.04 a body's direction maps world (north X, west Y, up Z) to the scene (x, z, −y)", () => {
  const up = celestialDirection(0, 0, { x: 0, y: 0, z: 0 });
  assert.ok(near(up.y, 1) && near(up.x, 0) && near(up.z, 0));
  const north = celestialDirection(Math.PI / 2, 0, { x: 0, y: 0, z: 0 });
  assert.ok(near(north.x, 1) && near(north.y, 0));
  const west = celestialDirection(Math.PI / 2, Math.PI / 2, { x: 0, y: 0, z: 0 });
  // West is +Y in the world and −Z in the scene.
  assert.ok(near(west.z, -1) && near(west.x, 0));
});

test("7.04 sun high at noon, under the horizon at 06:00, rises near 06:10; moon up only at night", () => {
  const frame = createCelestialFrame();
  computeCelestialFrame(0.5, 0, frame);
  assert.ok(frame.sun.y > 0.99, `noon sun height ${frame.sun.y}`);
  assert.ok(frame.sun.x > 0 && frame.sun.z < 0, "the sun stands to the north-west");
  assert.equal(frame.sun.scale, 1);
  assert.ok(frame.moon.y < 0, "the moon is set at noon");
  computeCelestialFrame(0.25, 0, frame);
  assert.ok(frame.sun.y < 0, `06:00 sun height ${frame.sun.y}`);
  assert.equal(frame.sun.scale, 2);
  computeCelestialFrame(0.26, 0, frame);
  assert.ok(frame.sun.y > 0, `06:14 sun height ${frame.sun.y}`);
  computeCelestialFrame(0, 0, frame);
  assert.ok(near(frame.moon.y, Math.cos(35 * Math.PI / 180), 1e-6));
  assert.ok(near(frame.moon.scale, 1.75, 1e-9));
  assert.ok(frame.sun.y < 0, "no sun at midnight");
  assert.equal(frame.stars, 1);
});

test("7.04 the second moon runs on its own 1.7-day cycle", () => {
  assert.equal(moon2Fraction(0, 0), 0);
  assert.ok(near(moon2Fraction(0.85, 0), 0.5));
  assert.ok(near(moon2Fraction(1, 0.7), 0, 1e-9));
  assert.ok(near(moon2Fraction(2, 0.25), (2.25 / 1.7) % 1));
  const a = computeCelestialFrame(0, 0, createCelestialFrame());
  const b = computeCelestialFrame(0, 0.85, createCelestialFrame());
  assert.ok(a.moon2.y > 0 && b.moon2.y < 0, "the same hour, another day: the second moon has set");
  assert.ok(near(a.moon.y, b.moon.y), "the first moon keeps the game day");
});

test("7.04 stars: the client's alpha byte, gone by day", () => {
  assert.equal(starAlpha(0), 1);
  assert.equal(starAlpha(0.5), 1 / 255);
  assert.equal(starsDrawn(starAlpha(0.5)), false);
  assert.equal(starsDrawn(starAlpha(0)), true);
  const fading = starAlpha(0.15625);
  assert.ok(fading > 0.4 && fading < 0.6, `03:45 ${fading}`);
  let previous = 2;
  for (let t = 0.125; t <= 0.1875; t += 0.005) {
    const value = starAlpha(t);
    assert.ok(value <= previous, "monotone fade at dawn");
    previous = value;
  }
});

test("7.04 slice 4: a loaded skybox covers the sky unless Flags & 2", () => {
  assert.equal(skyboxCoversSky(true, 0), true);
  assert.equal(skyboxCoversSky(true, 1), true);
  assert.equal(skyboxCoversSky(true, 2), false);
  assert.equal(skyboxCoversSky(true, 3), false);
  assert.equal(skyboxCoversSky(false, 0), false);
});

test("7.04 slice 4: Flags & 1 lays the clip over the day; others loop on the wall clock; v4 unchanged", () => {
  const duration = 320_000;
  for (const time of [0, 700, 1440, 2879]) {
    // No v5 channels (old gateway): exactly what the renderer has always done, whatever the flags.
    assert.equal(skyboxClipTimeMs(time, duration, 123_456, 0, false), skyboxAnimationTimeMs(time, duration));
    assert.equal(skyboxClipTimeMs(time, duration, 123_456, 1, true), skyboxAnimationTimeMs(time, duration));
  }
  assert.equal(skyboxClipTimeMs(1440, duration, 400_000, 0, true), 80_000);
  assert.equal(skyboxClipTimeMs(1440, duration, 400_000, 2, true), 80_000);
  assert.equal(skyboxClipTimeMs(1440, 0, 400_000, 0, true), 0);
});

test("7.04 slice 3: cloud cover threshold is the client's low byte of (1 − band 3) × 255", () => {
  assert.equal(cloudCoverThreshold(0), 1);
  assert.equal(cloudCoverThreshold(1), 0);
  assert.equal(cloudCoverThreshold(0.5), 128 / 255);
  assert.equal(cloudCoverThreshold(2), 1 / 255);
  assert.equal(cloudLightIsSun(0.2), false);
  assert.equal(cloudLightIsSun(0.21), true);
  assert.equal(cloudLightIsSun(0.93), false);
});

function fakeSource(ready) {
  const loaded = [];
  return {
    loaded,
    load(path) {
      loaded.push(path);
      const texture = new THREE.Texture();
      texture.name = path;
      return texture;
    },
    ready: () => ready.value,
  };
}

const visible = (sky, name) => sky.group.getObjectByName(name)?.visible === true;

test("7.04 renderer layer: off without v5 channels; bodies only once their textures are ready", () => {
  const sky = new SkyCelestials();
  const input = createSkyCelestialInput();
  const camera = new THREE.Vector3(10, 20, 30);
  sky.update(input, camera);
  assert.equal(sky.group.visible, false, "an old gateway keeps today's sky");
  const ready = { value: false };
  const source = fakeSource(ready);
  sky.setTextureSource(source);
  input.enabled = true;
  input.time = 1440; // noon
  input.sunColour = 0xfff7de;
  sky.update(input, camera);
  assert.equal(sky.group.visible, true);
  assert.equal(visible(sky, "skySun"), false, "a texture still loading draws nothing");
  assert.deepEqual([...source.loaded].sort(), ["Textures\\moon.blp", "Textures\\moon02.blp", "Textures\\sunCenter.blp"]);
  ready.value = true;
  sky.update(input, camera);
  assert.equal(visible(sky, "skySun"), true);
  assert.equal(visible(sky, "skyMoon"), false, "no moon at noon");
  assert.equal(sky.group.position.x, 10);
  const sun = sky.group.getObjectByName("skySun");
  assert.ok(sun.position.y > 690, `sun quad height ${sun.position.y}`);
  const colour = sun.material.uniforms.celestialColour.value;
  const expected = new THREE.Color().setHex(0xfff7de, THREE.SRGBColorSpace);
  assert.ok(near(colour.r, expected.r) && near(colour.b, expected.b), "band 9 tints the bodies");
  assert.equal(source.loaded.length, 3, "textures are requested once");
  input.postSun = true;
  sky.update(input, camera);
  assert.equal(visible(sky, "skySun"), false, "the cinematic post owns the sun disc");
  input.postSun = false;
  input.storm = 1;
  sky.update(input, camera);
  assert.equal(visible(sky, "skySun"), false, "a full storm hides the bodies (alpha 1 − storm)");
  input.storm = 0.25;
  sky.update(input, camera);
  assert.equal(sun.material.uniforms.celestialOpacity.value, 0.75);
  input.storm = 0;
  input.time = 0;
  sky.update(input, camera);
  assert.equal(visible(sky, "skySun"), false);
  assert.equal(visible(sky, "skyMoon"), true, "the moon at midnight");
  assert.ok(near(sky.group.getObjectByName("skyMoon").material.uniforms.celestialSize.value, 1.75 * 700 / 12, 1e-9));
  input.enabled = false;
  sky.update(input, camera);
  assert.equal(sky.group.visible, false);
  sky.dispose();
});

test("7.04 renderer layer: clouds follow band 3; stars take the client's alpha", () => {
  const sky = new SkyCelestials();
  const input = createSkyCelestialInput();
  const camera = new THREE.Vector3();
  input.enabled = true;
  input.time = 1440;
  sky.update(input, camera);
  assert.equal(visible(sky, "skyClouds"), false, "band 3 = 0: no clouds");
  input.cloudDensity = 0.5;
  input.cloudA = 0x808080;
  input.cloudB = 0x202020;
  input.sunHalo = 0xffc78a;
  sky.update(input, camera);
  assert.equal(visible(sky, "skyClouds"), true);
  const clouds = sky.group.getObjectByName("skyClouds");
  assert.equal(clouds.material.uniforms.cloudThreshold.value, 128 / 255);
  assert.ok(near(clouds.material.uniforms.cloudBase.value.r, 0x20 / 255), "display-space bytes");
  assert.ok(clouds.material.uniforms.cloudLight.value.y > 0.99, "lit from the noon sun");
  // Stars: a built node handed over, its opacity the client's alpha times the material's own.
  const material = new THREE.MeshBasicMaterial({ opacity: 0.8, transparent: false });
  const node = new THREE.Mesh(new THREE.BufferGeometry(), material);
  node.name = "stars";
  input.time = 0;
  assert.equal(sky.hasStars, false);
  sky.update(input, camera);
  assert.equal(sky.wantsStars, true);
  sky.setStars(node, [material]);
  assert.equal(sky.wantsStars, false);
  sky.update(input, camera);
  assert.equal(node.visible, true);
  assert.ok(near(material.opacity, 0.8));
  assert.equal(material.transparent, true);
  input.time = 1440;
  sky.update(input, camera);
  assert.equal(node.visible, false, "no stars by day");
  sky.clearStars();
  assert.equal(sky.hasStars, false);
  assert.equal(sky.group.getObjectByName("stars"), undefined);
  sky.dispose();
});

test("7.04 skyBasicMaterials makes unlit, fog-free, depth-free copies and keeps the blend", () => {
  const original = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
  original.blending = THREE.AdditiveBlending;
  const node = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), original);
  node.add(mesh);
  const made = skyBasicMaterials(node);
  assert.equal(made.length, 1);
  assert.equal(mesh.material.type, "MeshBasicMaterial");
  assert.equal(mesh.material.depthTest, false);
  assert.equal(mesh.material.depthWrite, false);
  assert.equal(mesh.material.fog, false);
  assert.equal(mesh.material.blending, THREE.AdditiveBlending);
  assert.equal(mesh.material.opacity, 0.5);
  assert.equal(original.depthTest, true, "the shared model material is not touched");
});

test("7.21 night rays never come from the moon: the shafts follow the sun and need daylight", async () => {
  const sun = godRaySunDirection(0);
  assert.ok(sun.y < 0, "midnight: the visible sun is under the horizon");
  assert.equal(godRayVisibility(0, 0, sun.y, 1, 1, 0), 0);
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function godRayVisibility"), source.indexOf("function triangleCount"));
  assert.ok(body.length > 100);
  assert.doesNotMatch(body, /moon|celestial/i);
});

test("7.04 renderer hooks: gated on skyChannels, marked, no allocation in the frame hook", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #updateSkyCelestials(client");
  assert.ok(start > 0);
  const hook = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(hook, /sample\.skyChannels/);
  assert.match(hook, /skyboxCoversSky\(/);
  assert.match(hook, /!this\.#indoors/);
  assert.match(hook, /!this\.#underwater/);
  // Per-frame part (before the stars build) creates no objects or arrays.
  const perFrame = hook.slice(0, hook.indexOf("if (!this.#skyCelestials.wantsStars) return;"));
  assert.doesNotMatch(perFrame.replace(/skyTextureSource\([^)]*\)/, ""), /new |\[\]|\{\s*\w+:/);
  assert.ok((source.match(/05\.10-A7b-6/g) ?? []).length >= 8, "every shared edit is marked");
});

// --- static GLSL checks -------------------------------------------------------------------------

const GLSL_WORDS = new Set([
  "void", "float", "int", "bool", "vec2", "vec3", "vec4", "mat3", "mat4", "sampler2D", "uniform", "varying",
  "attribute", "if", "else", "return", "discard", "for", "true", "false", "main",
  "gl_Position", "gl_FragColor", "normalize", "cross", "length", "texture2D", "clamp", "mix",
  "smoothstep", "step", "pow", "fract", "floor", "sin", "dot", "max", "min", "abs",
  // three's ShaderMaterial prefix
  "modelMatrix", "viewMatrix", "projectionMatrix", "modelViewMatrix", "cameraPosition", "position", "uv",
]);

function stripped(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function checkProgram(label, vertex, fragment, uniforms) {
  const declaredUniforms = new Set();
  const varyings = { vertex: new Map(), fragment: new Map() };
  for (const [stage, text] of [["vertex", vertex], ["fragment", fragment]]) {
    const body = stripped(text);
    for (const line of body.split("\n")) {
      const include = /^\s*#include\s+<(\w+)>/.exec(line);
      if (include) assert.ok(THREE.ShaderChunk[include[1]] !== undefined, `${label}: unknown include ${include[1]}`);
    }
    const code = body.replace(/^\s*#.*$/gm, "");
    // Balanced braces and parentheses.
    for (const [open, close] of [["{", "}"], ["(", ")"]]) {
      assert.equal(code.split(open).length, code.split(close).length, `${label} ${stage}: unbalanced ${open}${close}`);
    }
    // Float-only literals: every number carries a decimal point.
    for (const match of code.matchAll(/(?<![\w.])(\d+\.?\d*)(?![\w.])/g)) {
      assert.match(match[1], /\./, `${label} ${stage}: integer literal ${match[1]}`);
    }
    const declared = new Set();
    for (const match of code.matchAll(/\buniform\s+\w+\s+(\w+)/g)) {
      declared.add(match[1]);
      declaredUniforms.add(match[1]);
    }
    for (const match of code.matchAll(/\bvarying\s+(\w+)\s+(\w+)/g)) {
      declared.add(match[2]);
      varyings[stage].set(match[2], match[1]);
    }
    // Functions: defined before their first use.
    const functions = [...code.matchAll(/\b(?:float|vec[234]|void)\s+(\w+)\s*\(([^)]*)\)\s*\{/g)];
    for (const fn of functions) {
      declared.add(fn[1]);
      for (const parameter of fn[2].split(",")) {
        const name = /(\w+)\s*$/.exec(parameter.trim())?.[1];
        if (name) declared.add(name);
      }
      const firstUse = code.search(new RegExp(`\\b${fn[1]}\\s*\\(`));
      assert.equal(firstUse, fn.index + fn[0].indexOf(fn[1]), `${label}: ${fn[1]} used before it is defined`);
    }
    for (const match of code.matchAll(/\b(?:float|vec[234]|mat[34])\s+(\w+)\s*[=;]/g)) declared.add(match[1]);
    // Every identifier (swizzles and member reads excluded) is declared or built in.
    const identifiers = code.replace(/\.\s*[A-Za-z_]\w*/g, "").matchAll(/\b[A-Za-z_]\w*\b/g);
    for (const [name] of identifiers) {
      assert.ok(declared.has(name) || GLSL_WORDS.has(name), `${label} ${stage}: undeclared ${name}`);
    }
  }
  // Varyings written by the vertex stage and read with the same type.
  assert.deepEqual([...varyings.fragment].sort(), [...varyings.vertex].sort(), `${label}: varyings differ`);
  // Every declared uniform is supplied by the material, and every supplied one is declared.
  assert.deepEqual([...declaredUniforms].sort(), Object.keys(uniforms).sort(), `${label}: uniforms differ`);
}

test("7.04 GLSL: the celestial and cloud programs pass the static checks", () => {
  const sky = new SkyCelestials();
  const [sun] = sky.materials();
  const clouds = sky.materials().at(-1);
  checkProgram("celestial", CELESTIAL_VERTEX_SHADER, CELESTIAL_FRAGMENT_SHADER, sun.uniforms);
  checkProgram("clouds", CLOUD_VERTEX_SHADER, CLOUD_FRAGMENT_SHADER, clouds.uniforms);
  // One program for the three bodies: same source text, uniforms only differ.
  const bodies = sky.materials().slice(0, 3);
  assert.equal(new Set(bodies.map((material) => material.fragmentShader)).size, 1);
  assert.equal(bodies.every((material) => material.transparent && !material.depthTest && !material.depthWrite), true);
  sky.dispose();
});

test("7.04 GLSL check catches the faults that cost a white frame (self-test)", () => {
  const uniforms = { celestialMap: {}, celestialColour: {}, celestialOpacity: {}, celestialHorizon: {}, celestialSize: {} };
  assert.throws(() => checkProgram("m", CELESTIAL_VERTEX_SHADER, CELESTIAL_FRAGMENT_SHADER.replace("0.0)", "0)"), uniforms));
  assert.throws(() => checkProgram("m", CELESTIAL_VERTEX_SHADER, CELESTIAL_FRAGMENT_SHADER.replace("celestialOpacity *", "celestialAlpha *"), uniforms));
  const { celestialHorizon: _, ...missing } = uniforms;
  assert.throws(() => checkProgram("m", CELESTIAL_VERTEX_SHADER, CELESTIAL_FRAGMENT_SHADER, missing));
  assert.throws(() => checkProgram("m", CELESTIAL_VERTEX_SHADER.replace("varying vec3 vCelestialDirection;", "varying vec2 vCelestialDirection;"), CELESTIAL_FRAGMENT_SHADER, uniforms));
  const reordered = CLOUD_FRAGMENT_SHADER.replace(/float cloudHash[\s\S]*?\n}\n/, "")
    .replace("float cloudField", "float cloudHash(vec2 p) {\n  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);\n}\nfloat cloudField");
  const cloudUniforms = Object.fromEntries(["cloudBase", "cloudBody", "cloudLit", "cloudLight", "cloudThreshold",
    "cloudLitScale", "cloudOpacity", "cloudOffset"].map((name) => [name, {}]));
  assert.throws(() => checkProgram("c", CLOUD_VERTEX_SHADER, reordered, cloudUniforms), /before it is defined/);
});

// 05.10: ревью A7b-6. The «one sun» rule: the client-placed sun quad gives way only to a pass that
// actually draws a sun. CinematicPost injects its disc in the bloom leaf alone (prefilter and
// composite, `sunDisc.x` ∝ strength); the classic radial shafts draw their source blob at
// `godRaySunDirection` whenever their scale is above zero and the cinematic chain is off.
test("05.10 review: the sun quad hides only when another pass really draws a sun", async () => {
  const { skyPostDrawsSun } = await import("../dist/code/browser/SkyCelestials.js");
  assert.equal(typeof skyPostDrawsSun, "function");
  // Classic look (no cinematic, no shafts): the client sun.
  assert.equal(skyPostDrawsSun(false, false, 1, false, 1), false);
  // Cinematic with bloom at a non-zero strength: the post's HDR disc is the sun.
  assert.equal(skyPostDrawsSun(true, true, 1, false, 1), true);
  assert.equal(skyPostDrawsSun(true, true, 1, true, 1), true);
  // Cinematic grade / AO / scattering without bloom: no disc anywhere — keep the quad.
  assert.equal(skyPostDrawsSun(true, false, 1, false, 1), false);
  assert.equal(skyPostDrawsSun(true, false, 1, true, 1), false, "the classic shafts are skipped under the cinematic chain");
  // Cinematic slider at 0 %: sunDisc.x = 0.
  assert.equal(skyPostDrawsSun(true, true, 0, false, 1), false);
  // Classic shafts: their source blob sits at the renderer's sun — unless the shaft slider is at 0.
  assert.equal(skyPostDrawsSun(false, false, 1, true, 1), true);
  assert.equal(skyPostDrawsSun(false, false, 1, true, 0), false);
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #updateSkyCelestials(client");
  const hook = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(hook, /input\.postSun = skyPostDrawsSun\(/);
});

// 05.10: ревью A7b-6. An old gateway (v4 body, skyChannels = false) must keep today's skybox clip
// time: the only new assignment in `#updateSkyboxAnimation` sits behind the skyChannels gate, after
// the original `skyboxAnimationTimeMs` line, and before the mixer reads the value.
test("05.10 review: v4 keeps the skybox clip timing line untouched", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #updateSkyboxAnimation(): void {");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  const original = body.indexOf("this.#skyboxAnimationMs = skyboxAnimationTimeMs(this.#lightTime, durationMs);");
  const gate = body.indexOf("if (skyFlags?.skyChannels && (skyFlags.skyboxFlags & 1) === 0) {");
  const mixer = body.indexOf("instance.mixer.setTime(this.#skyboxAnimationMs / 1000);");
  assert.ok(original > 0 && gate > original && mixer > gate, "original line, then the gated override, then the mixer");
  const assignments = body.match(/this\.#skyboxAnimationMs\s*=/g) ?? [];
  assert.equal(assignments.length, 2, "one original assignment and one gated override");
  const override = body.slice(gate, mixer);
  assert.match(override, /this\.#skyboxAnimationMs = skyboxClipTimeMs\(/);
  // And the function itself: skyChannels false is the old line for any flags and any wall clock.
  for (const flags of [0, 1, 2, 3, Number.NaN]) {
    for (const time of [0, 1, 719, 1440, 2879, 5000, -3]) {
      for (const duration of [33_000, 89_500, 320_000]) {
        assert.equal(skyboxClipTimeMs(time, duration, 987_654, flags, false), skyboxAnimationTimeMs(time, duration));
      }
    }
  }
});

test("7.04 day fraction wraps the Light.dbc clock", () => {
  assert.equal(skyDayFraction(1440), 0.5);
  assert.equal(skyDayFraction(2880 + 720), 0.25);
  assert.equal(skyDayFraction(-720), 0.75);
  assert.equal(skyDayFraction(Number.NaN), 0);
});
