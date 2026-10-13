// 13.10 (7.04): the classic sky dome — Wow.exe's mesh (0x7f2470) and its per-vertex colours with
// HighlightSky (0x7f0530) in `SkyDome.ts` — and the renderer showing it on the classic look only.
// What this does NOT prove: the dome against the original's frame at sunrise/sunset (14.25).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  CLASSIC_DOME_FRAGMENT_SHADER, CLASSIC_DOME_LIFT, CLASSIC_DOME_POLAR, CLASSIC_DOME_SEGMENTS, CLASSIC_DOME_VERTICES,
  HIGHLIGHT_AZIMUTH_KEYS, HIGHLIGHT_TIME_KEYS, buildClassicDome, buildClassicDomeGeometry, classicDomeColours,
  domeByte, domeLerp, domeVertexAzimuth, highlightStrength, packDisplayColour, writeClassicDomeColours,
} from "../dist/code/browser/SkyDome.js";

test("the client's byte rounding: fistp of x − 0.5, half to even", () => {
  assert.equal(domeByte(3.2), 3);
  assert.equal(domeByte(3.7), 3, "x − 0.5 = 3.2");
  assert.equal(domeByte(3.0), 2, "2.5 rounds to the even 2");
  assert.equal(domeByte(4.0), 4, "3.5 rounds to the even 4");
  assert.equal(domeByte(255), 254);
  assert.equal(domeByte(0), 0, "−0.5 rounds to −0, clamped");
  assert.equal(domeLerp(0x00ff00, 0xff0000, 0.5), (domeByte(127.5) << 16) | (domeByte(127.5) << 8));
  assert.equal(domeLerp(0x102030, 0x102030, 0), (domeByte(16) << 16) | (domeByte(32) << 8) | domeByte(48));
});

test("the tables, as read out of the executable", () => {
  assert.equal(CLASSIC_DOME_SEGMENTS, 24);
  assert.deepEqual(CLASSIC_DOME_POLAR.map((v) => Math.round(v * 100)), [0, 17, 20, 23, 24, 25, 100]);
  assert.ok(Math.abs(CLASSIC_DOME_LIFT - Math.SQRT1_2) < 1e-12);
  assert.equal(HIGHLIGHT_TIME_KEYS.length, 12);
  assert.equal(HIGHLIGHT_AZIMUTH_KEYS.length, 12);
  // h: dawn at 06:30 and dusk at 21:30 at full strength, nothing at noon, nothing without the flag.
  assert.equal(highlightStrength(0.2708333432674408, 1), 1);
  assert.equal(highlightStrength(0.8958333134651184, 1), 1);
  assert.equal(highlightStrength(0.5, 1), 0);
  assert.equal(highlightStrength(0.2708333432674408, 0), 0);
  assert.ok(Math.abs(highlightStrength(0.2, 1) - (0.2 - 0.125) / (0.2708333432674408 - 0.125)) < 1e-6);
});

const BANDS = { top: 0x1060b0, upper: 0x4090d0, middle: 0x80c0e0, lower: 0xe0a060, horizon: 0xf07030, fog: 0x605040 };

test("no highlight: every ring is its band (through the client's rounding), the bottom ring and pole are fog", () => {
  const out = classicDomeColours(BANDS, 0, new Uint32Array(CLASSIC_DOME_VERTICES));
  assert.equal(out[0], BANDS.top);
  const rings = [BANDS.upper, BANDS.middle, BANDS.lower, BANDS.horizon];
  for (let ring = 0; ring < 4; ring++) {
    const expected = domeLerp(rings[ring], domeLerp(rings[ring], BANDS.upper, 0), 0);
    for (let j = 0; j < 24; j++) assert.equal(out[1 + ring * 24 + j], expected, `ring ${ring + 1} vertex ${j}`);
  }
  for (let j = 0; j < 24; j++) assert.equal(out[97 + j], BANDS.fog);
  assert.equal(out[121], BANDS.fog);
});

test("highlight: the band colours stay toward the sun's bearing (45°) and go to bands 3 and 2 away from it", () => {
  const out = classicDomeColours(BANDS, 1, new Uint32Array(CLASSIC_DOME_VERTICES));
  // Vertex 3 sits at 45° (a turn of 0.125: w = 1), vertex 21 at 135° (w = 0), vertex 15 at 225° (w = −0.7).
  assert.ok(Math.abs(domeVertexAzimuth(3) - Math.PI / 4) < 1e-12);
  const ring = 3; // the horizon band, ring 4
  const band = BANDS.horizon;
  const highlighted = domeLerp(band, BANDS.upper, 1);
  assert.equal(out[1 + ring * 24 + 3], domeLerp(band, highlighted, 0), "toward the sun: the band itself");
  assert.equal(out[1 + ring * 24 + 21], domeLerp(band, highlighted, 1), "w = 0: the band pulled all the way to band 3");
  assert.equal(out[1 + ring * 24 + 15],
    domeLerp(highlighted, domeLerp(highlighted, BANDS.top, 0.699999988079071), 0.699999988079071), "w < 0: on to band 2");
  // Half strength halves every pull.
  const half = classicDomeColours(BANDS, 0.5, new Uint32Array(CLASSIC_DOME_VERTICES));
  assert.equal(half[1 + ring * 24 + 21], domeLerp(band, domeLerp(band, BANDS.upper, 0.5), 0.5));
});

test("the mesh: a cap whose 45° ring is the horizon, ring vertices at the azimuths the colours assume", () => {
  const geometry = buildClassicDomeGeometry();
  const position = geometry.getAttribute("position");
  assert.equal(position.count, CLASSIC_DOME_VERTICES);
  assert.equal(geometry.index.count, 24 * 30);
  assert.ok(Math.abs(position.getY(0) - (1 - Math.SQRT1_2)) < 1e-6, "the pole");
  for (let j = 0; j < 24; j++) assert.ok(Math.abs(position.getY(97 + j)) < 1e-6, "ring 5 on the horizon");
  assert.ok(Math.abs(position.getY(121) + 1 + Math.SQRT1_2) < 1e-6, "the bottom");
  for (const j of [0, 3, 9, 15]) {
    // Scene (x, z) is world (x, −y): the world azimuth is atan2(−z, x).
    const azimuth = Math.atan2(-position.getZ(1 + j), position.getX(1 + j));
    const expected = domeVertexAzimuth(j);
    assert.ok(Math.abs(Math.atan2(Math.sin(azimuth - expected), Math.cos(azimuth - expected))) < 1e-5, `vertex ${j}`);
  }
  // Each ring rises: elevation of ring 1 above ring 4 above the horizon.
  const elevation = (index) => Math.atan2(position.getY(index), Math.hypot(position.getX(index), position.getZ(index)));
  assert.ok(elevation(1) > elevation(25) && elevation(25) > elevation(49) && elevation(49) > elevation(73) && elevation(73) > 0);
  const colours = classicDomeColours(BANDS, 0, new Uint32Array(CLASSIC_DOME_VERTICES));
  writeClassicDomeColours(geometry, colours);
  const colour = geometry.getAttribute("color");
  assert.ok(Math.abs(colour.getX(0) - 0x10 / 255) < 1e-7 && Math.abs(colour.getZ(0) - 0xb0 / 255) < 1e-7);
  assert.equal(packDisplayColour({ r: 1, g: 0.5, b: 0 }), 0xff8000);
});

test("the dome material: vertex colours decoded once, no depth, drawn first", () => {
  const dome = buildClassicDome();
  assert.equal(dome.material.vertexColors, true);
  assert.equal(dome.material.depthTest, false);
  assert.equal(dome.material.depthWrite, false);
  assert.equal(dome.renderOrder, -1);
  assert.equal(dome.visible, false);
  assert.ok(CLASSIC_DOME_FRAGMENT_SHADER.indexOf("vec3 domeToLinear") < CLASSIC_DOME_FRAGMENT_SHADER.indexOf("domeToLinear(vDomeColour)"));
  assert.ok(THREE.ShaderChunk.tonemapping_fragment && THREE.ShaderChunk.colorspace_fragment);
});

test("the renderer shows it on the classic look only, the band shader's surface stepping aside", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  #updateClassicDome(sample"), source.indexOf("  #updateSkyCelestials(client"));
  assert.match(body, /const classic = sample !== undefined && lightingClassicLook\(this\.#lightingProfile\.quality\);/);
  assert.match(body, /\(this\.#sky\.material as THREE\.Material\)\.visible = !classic;/);
  assert.match(body, /this\.#classicDome\.visible = classic;/);
  assert.match(body, /highlightStrength\(skyDayFraction\(this\.#lightTime\), sample\.highlightSky\)/);
  assert.match(source, /this\.#sky\.add\(this\.#classicDome\);/);
  assert.match(source, /#updateSkyCelestials\(client: EnvironmentClient \| undefined\): void \{\r?\n\s+const sample = this\.#lightSample;\r?\n\s+this\.#updateClassicDome\(sample\);/);
});
