// 12.10-7.29 / 7.30: morning and noon on the enhanced look read as daylight, not as an orange or
// yellow cast; warmth is the low sun's; the sky keeps Light.dbc's own bands.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  DAYLIGHT_KEY_WHITE, HIGH_SUN_KEY_NEUTRAL, WORLD_LIGHT_BODY, applyLightHeadroom, createWorldLightUniforms,
  highSunKeyPair, highSunKeyWeight, setWorldLightDaylight, setWorldLightIndoor, setWorldLightUniforms,
} from "../dist/code/browser/WorldLighting.js";
import {
  CinematicPost, SKY_GRADE_SHARE, cinematicGrade, cinematicSunColour, highSunWeight,
} from "../dist/code/browser/CinematicPost.js";

const close = (actual, expected, epsilon = 1e-3) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const byte = (value) => Math.round(value * 255);
// Elwynn / Stormwind, this dataset's Light.dbc (resolveLighting at -9460,-120).
const NOON = { ambient: { r: 104 / 255, g: 130 / 255, b: 154 / 255 }, diffuse: { r: 1, g: 136 / 255, b: 0 } };
const DAWN = { ambient: { r: 93 / 255, g: 125 / 255, b: 156 / 255 }, diffuse: { r: 1, g: 103 / 255, b: 0 } };
// The enhanced arc's physical sun: -cos(time / 2880 · 2π).
const elevation = (halfMinute) => -Math.cos(halfMinute / 2880 * Math.PI * 2);

test("the high-sun weight: nothing at dawn, dusk and night, all of it from 08:00 on the enhanced arc", () => {
  assert.equal(highSunKeyWeight(elevation(720)), 0, "06:00");
  assert.equal(highSunKeyWeight(elevation(0)), 0, "midnight");
  assert.equal(highSunKeyWeight(0.1), 0);
  assert.ok(highSunKeyWeight(elevation(960)) > 0.99, "08:00");
  assert.equal(highSunKeyWeight(elevation(1440)), 1, "noon");
  assert.ok(highSunKeyWeight(elevation(840)) > 0 && highSunKeyWeight(elevation(840)) < 0.5, "07:00 is on its way");
  assert.equal(highSunKeyWeight(Number.NaN), 0);
  assert.equal(highSunWeight(0.3), highSunKeyWeight(0.3), "the post fades on the material's clock");
});

test("an Elwynn noon key is warm white in the sun against a cool authored shade", () => {
  const before = applyLightHeadroom(NOON.ambient, NOON.diffuse);
  const after = highSunKeyPair(NOON.ambient, NOON.diffuse, 1);
  const sunlit = (pair, nl) => ["r", "g", "b"].map((c) => byte(pair.ambient[c] + pair.diffuse[c] * nl));
  // Through the headroom alone the sunlit ground was orange: green at 72 % of red, blue at 43 %.
  assert.deepEqual(sunlit(before, 0.94), [244, 183, 109]);
  const lit = sunlit(after, 0.94);
  assert.deepEqual(lit, [245, 224, 192]);
  assert.ok(lit[1] / lit[0] > 0.9 && lit[2] / lit[0] > 0.75, `${lit}: daylight, not orange`);
  // The shade is the authored ambient's hue, under the new pair's headroom: cool, blue above red.
  const shade = sunlit(after, 0);
  assert.ok(shade[2] > shade[1] && shade[1] > shade[0], `${shade}`);
  // A low sun is the authored pair exactly.
  assert.deepEqual(highSunKeyPair(DAWN.ambient, DAWN.diffuse, 0), applyLightHeadroom(DAWN.ambient, DAWN.diffuse));
  assert.equal(HIGH_SUN_KEY_NEUTRAL, 0.6);
  close(DAYLIGHT_KEY_WHITE[0] * 0.2126 + DAYLIGHT_KEY_WHITE[1] * 0.7152 + DAYLIGHT_KEY_WHITE[2] * 0.0722, 1);
});

test("the uniforms carry the weight and the authored peak, and a room resets them", () => {
  const uniforms = createWorldLightUniforms();
  setWorldLightUniforms(uniforms, NOON.ambient, NOON.diffuse);
  close(uniforms.wowHighSunKey.value.y, 359 / 255);
  setWorldLightDaylight(uniforms, elevation(1440));
  assert.equal(uniforms.wowHighSunKey.value.x, 1);
  setWorldLightDaylight(uniforms, elevation(720));
  assert.equal(uniforms.wowHighSunKey.value.x, 0);
  setWorldLightDaylight(uniforms, elevation(1440));
  setWorldLightIndoor(uniforms, [0.4, 0.3, 0.2], [0, 1, 0]);
  assert.deepEqual([uniforms.wowHighSunKey.value.x, uniforms.wowHighSunKey.value.y], [0, 1]);
  // The shader rebuilds the authored pair from the peak and only inside the enhanced branch.
  const grade = WORLD_LIGHT_BODY.slice(WORLD_LIGHT_BODY.indexOf("if ( wowImmersiveStrength > 0.0001 )"));
  assert.ok(grade.includes("if ( wowHighSun > 0.0001 ) {"));
  assert.ok(grade.includes("vec3 wowRawDiffuse = wowDiffuse * wowHighSunKey.y;"));
  assert.ok(grade.includes(`wowKeyLuma * vec3( ${DAYLIGHT_KEY_WHITE.map((v) => v.toFixed(4)).join(", ")} )`));
  assert.ok(grade.includes("wowKeyAmbient = wowRawAmbient / wowPairPeak;"));
  assert.ok(!WORLD_LIGHT_BODY.slice(0, WORLD_LIGHT_BODY.indexOf("if ( wowImmersiveStrength > 0.0001 )"))
    .includes("wowHighSunKey"), "the classic light never reads it");
});

test("the grade's warm highlight tint belongs to a low sun: neutral at noon, as before at dawn and night", () => {
  const input = (sunElevation) => ({ ...NOON, fog: { r: 0.3, g: 0.47, b: 0.56 }, sunElevation, storm: 0, underwater: false });
  const noon = cinematicGrade(input(elevation(1440)));
  for (const c of ["r", "g", "b"]) close(noon.highlightTint[c], 1, 1e-6);
  const morning = cinematicGrade(input(elevation(960)));
  for (const c of ["r", "g", "b"]) close(morning.highlightTint[c], 1, 0.01);
  // Dawn (06:00, the sun on the horizon) keeps the 0.16 base plus its golden share.
  const dawn = cinematicGrade(input(elevation(720)));
  assert.ok(dawn.highlightTint.r > 1.05 && dawn.highlightTint.b < 0.95, JSON.stringify(dawn.highlightTint));
  const night = cinematicGrade(input(-0.9));
  assert.ok(night.highlightTint.r > 1.005, "the night's small base share stays");
});

test("the post's sun is the diffuse band's hue when low and near-white when high", () => {
  const low = cinematicSunColour(DAWN.diffuse, DAWN.ambient, 0, undefined);
  close(low.r, 1); close(low.g, 103 / 255); close(low.b, 0);
  const high = cinematicSunColour(NOON.diffuse, NOON.ambient, elevation(1440), undefined);
  // MIN(ambient + diffuse, 1) halfway to white: (255, 255, 205) for an Elwynn noon.
  assert.deepEqual([high.r, high.g, high.b].map(byte), [255, 255, 205]);
  // Light int band 9 when the push carries it (the sun body's own colour, Elwynn noon #fff7de).
  const band = cinematicSunColour(NOON.diffuse, NOON.ambient, elevation(1440), 0xfff7de);
  assert.deepEqual([band.r, band.g, band.b].map(byte), [255, 247, 222]);
  assert.deepEqual(cinematicSunColour(NOON.diffuse, NOON.ambient, elevation(1440), 0), high, "0 is a v4 body: derived");
});

test("sky texels keep only a fifth of the grade's departures", () => {
  assert.equal(SKY_GRADE_SHARE, 0.2);
  const post = new CinematicPost();
  const shader = post.composite.fragmentShader;
  assert.ok(shader.includes(`float tone = sky ? ${SKY_GRADE_SHARE.toFixed(3)} : 1.0;`));
  assert.ok(shader.includes("vec3(mix(1.0, grade.y, tone))"), "contrast");
  assert.ok(shader.includes("float highlight = smoothstep(0.05, 0.75, luma) * tone;"), "split toning");
  assert.ok(shader.includes("mix(1.0, grade.z, tone)"), "saturation");
  post.updateLight({
    diffuse: NOON.diffuse, ambient: NOON.ambient, fog: { r: 0.3, g: 0.47, b: 0.56 }, fogFar: 500,
    sun: new THREE.Vector3(0.35, 1, 0).normalize(), storm: 0, underwater: false, indoors: false, glow: 0.65,
  });
  // The noon sun the shader receives is near-white, not the orange band (linear: g > 0.9).
  const sun = post.uniforms.sunColour.value;
  assert.ok(sun.g > 0.9 && sun.r > 0.99, `${sun.r} ${sun.g} ${sun.b}`);
  post.dispose();
});
