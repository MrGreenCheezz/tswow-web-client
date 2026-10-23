// 23.10 (7.49): silhouettes keep their contours under the cinematic chain (CinematicSilhouettes.ts).
// Owner, 23.10: the sun's light and the haze trace characters' and some textures' outlines.
// Goldshire, owner settings, 1280x720, the volume term (on - off) along walks away from every
// silhouette: the far veil on the near object 0-3 px in +9.1/+8.0/+6.8/+5.6 -> +3.4/+0.2/-0.1/0 luma
// at noon (+13.6 -> +2.2 looking up), the dark gap outside it -6.5/-4.3/-2.1 at 3-5 px -> 0;
// sky-depth texels holding geometry: |error| 13.6-21.0 -> 2.4-2.9.
import assert from "node:assert/strict";
import test from "node:test";

import { CinematicPost, VOLUME_FADE_YARDS, VOLUME_REACH_YARDS, VOLUME_STEPS } from "../dist/code/browser/CinematicPost.js";
import { VOLUME_SOFTEN_SPACING, VOLUME_SOFTEN_TAPS } from "../dist/code/browser/CinematicVolumeSide.js";
import { VOLUME_SOFTEN_PASSES } from "../dist/code/browser/CinematicVolumeWidth.js";
import {
  CINEMATIC_EDGE_PURE, VOLUME_AIR_FLOOR, VOLUME_AIR_SIGMA, cinematicEdgeCover, cinematicEdgeLayers, volumeAirConfidence,
  volumeAirReference, volumeAirWeight, volumeRayAir,
} from "../dist/code/browser/CinematicSilhouettes.js";

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const air = (yards) => volumeRayAir(yards, VOLUME_REACH_YARDS, VOLUME_FADE_YARDS);

test("a ray's own air, from its depth, is the march's green", () => {
  // The march's green, averaged over its jitter: steps weighted by exp(-t / fade) out to the depth.
  const march = (yards) => {
    const reach = Math.min(yards, VOLUME_REACH_YARDS);
    const full = (1 - Math.exp(-VOLUME_REACH_YARDS / VOLUME_FADE_YARDS)) * VOLUME_FADE_YARDS;
    let mean = 0;
    for (let j = 0; j < 64; j++) {
      const step = reach / VOLUME_STEPS;
      let sum = 0;
      for (let i = 0; i < VOLUME_STEPS; i++) sum += Math.exp(-(i + (j + 0.5) / 64) * step / VOLUME_FADE_YARDS);
      mean += Math.min(1, sum * step / full) / 64;
    }
    return mean;
  };
  // Within the clamp the march puts on a jittered full reach (a percent short at 40 yards).
  for (const yards of [1, 4, 8, 15, 25, 39, 40, 120]) close(air(yards), march(yards), 0.02);
  assert.equal(air(Number.POSITIVE_INFINITY), 1, "the sky's ray is a whole reach");
  assert.equal(air(0), 0);
  assert.ok(air(8) < 0.4 && air(40) === 1, "a walker four yards off holds a third of the forest's air");
});

test("a tap of another reach does not speak for a ray", () => {
  assert.equal(volumeAirWeight(0.7, 0.7), 1);
  close(volumeAirWeight(0.7 + VOLUME_AIR_SIGMA, 0.7), Math.exp(-1), 1e-12);
  assert.ok(volumeAirWeight(air(8), 1) < 1e-8, "a walker's ray against the forest's");
  assert.ok(volumeAirWeight(air(10), air(12)) > 0.5, "the ground a few yards on is the same air");
  assert.ok(volumeAirWeight(air(60), air(400)) === 1, "every ray past the reach is alike");
  assert.equal(volumeAirWeight(Number.NaN, 1), 0);
});

/** One soften pass along a row of half-resolution texels, with bilinear taps as the GPU reads them. */
function soften(row, bilateral) {
  const sample = (x) => {
    const clamped = Math.max(0, Math.min(row.length - 1, x));
    const i = Math.min(row.length - 2, Math.floor(clamped));
    const f = clamped - i;
    return [row[i][0] + (row[i + 1][0] - row[i][0]) * f, row[i][1] + (row[i + 1][1] - row[i][1]) * f];
  };
  return row.map((centre, x) => {
    let sum = [centre[0] * VOLUME_SOFTEN_TAPS[0][1], centre[1] * VOLUME_SOFTEN_TAPS[0][1]];
    let total = VOLUME_SOFTEN_TAPS[0][1];
    for (const [offset, weight] of VOLUME_SOFTEN_TAPS.slice(1)) {
      for (const sign of [1, -1]) {
        const tap = sample(x + sign * offset * VOLUME_SOFTEN_SPACING);
        const w = weight * (bilateral ? volumeAirWeight(tap[1], centre[1]) + VOLUME_AIR_FLOOR : 1);
        sum = [sum[0] + tap[0] * w, sum[1] + tap[1] * w];
        total += w;
      }
    }
    return [sum[0] / total, sum[1] / total];
  });
}

test("the soften pass keeps a walker's rays out of the forest's: no ring round him", () => {
  // A walker four yards off (all lit, little air) before a forest whose air is lit in stretches.
  const walker = [1, air(8)];
  const forest = [0.4, 1];
  const row = Array.from({ length: 60 }, (_, x) => (x >= 25 && x < 35 ? walker : forest));
  let plain = row;
  let bilateral = row;
  for (let pass = 0; pass < VOLUME_SOFTEN_PASSES; pass++) {
    plain = soften(plain, false);
    bilateral = soften(bilateral, true);
  }
  // The plain gaussian (before 23.10) lit the forest's rays beside him and dimmed their air: the
  // side-on term, gated by air, then fired where the air came back — the bright ring.
  assert.ok(plain[23][0] - forest[0] > 0.1 && plain[23][1] < 0.85, `plain ${plain[23]}`);
  for (const x of [20, 21, 22, 23, 24, 35, 36, 37, 38]) {
    close(bilateral[x][0], forest[0], 0.02);
    close(bilateral[x][1], forest[1], 0.02);
  }
  // And the walker keeps his own: the forest's lit share no longer bleeds onto him.
  for (const x of [25, 26, 33, 34]) close(bilateral[x][0], walker[0], 0.02);
  // The shader is this: each tap weighed by its air against the centre's, normalised.
  const shader = new CinematicPost().volumeSoften.fragmentShader;
  assert.ok(shader.includes("float volumeAirWeight(float tapAir, float ownAir)"));
  assert.ok(shader.includes("* (volumeAirWeight(tap.g, centre.g) + "));
  assert.ok(shader.includes("gl_FragColor = vec4(sum / total, 0.0, 1.0);"));
  // Rays of one reach soften exactly as before: the weights still sum to the gaussian's.
  const even = soften(Array.from({ length: 40 }, (_, x) => [x % 7 < 3 ? 0.9 : 0.2, 1]), true);
  const gauss = soften(Array.from({ length: 40 }, (_, x) => [x % 7 < 3 ? 0.9 : 0.2, 1]), false);
  for (let x = 0; x < 40; x++) close(even[x][0], gauss[x][0], 1e-4);
});

test("the composite reads the march against the ray's own air, from its full-resolution depth", () => {
  // No tap of its reach near: read as its neighbourhood, scaled by its own air over that.
  const gap = volumeAirReference(1, air(3), 0); // a far ray through a pinhole between near leaves
  close(gap.ref, air(3), 1e-12);
  assert.equal(gap.scale, 1, "no brighter than the leaves round it");
  const edge = volumeAirReference(air(2), 1, 0); // a walker's edge texel over the forest's march
  assert.equal(edge.ref, 1);
  close(edge.scale, air(2), 1e-12);
  assert.ok(edge.scale < 0.15, "a tenth of the forest's light, not all of it");
  const own = volumeAirReference(0.97, 0.6, 0.15); // one tap of its reach is enough
  close(own.ref, 0.97, 1e-12);
  assert.equal(own.scale, 1);
  assert.equal(volumeAirConfidence(0), 0);
  assert.equal(volumeAirConfidence(1), 1);
  const composite = new CinematicPost().composite.fragmentShader;
  assert.ok(composite.includes("float volumeAdd = cinematicVolumeLight(volumeRayAir(nearYards), volumeLobe);"));
  assert.ok(composite.includes("float refAir = mix(m0.g * 0.4 + (m1.g + m2.g + m3.g + m4.g) * 0.15, ownAir, volumeAirConfidence(alike));"));
  assert.ok(composite.includes("/ (w0 + w1 + w2 + w3 + w4), refAir);"), "the ray's lit share from taps of its reach");
  assert.ok(composite.includes("* min(1.0, ownAir / max(refAir, 1e-3));"));
  // The shade around, the side-on taps and the width ring: a tap of another reach is the ray itself.
  assert.ok(composite.includes("mix(march.r, a0.r, volumeAirWeight(a0.g, refAir))"));
  assert.ok(composite.includes("float w = volumeAirWeight(tap.g, refAir) + "));
  assert.ok(composite.includes("ringLit += mix(wideLit, ringTap.r, volumeAirWeight(ringTap.g, refAir));"));
  assert.ok(!composite.includes("vec2 march = texture2D(volumeTexture, vUV).rg * 0.4"), "no plain cross of the march");
});

test("a silhouette texel's colour tells how much of each layer it holds", () => {
  const near = [0.1, 0.1, 0.1];
  const far = [0.6, 0.7, 0.8];
  const mix = (a) => near.map((v, i) => v * a + far[i] * (1 - a));
  assert.equal(cinematicEdgeCover(near, near, far, false), 1);
  assert.equal(cinematicEdgeCover(far, near, far, true), 0);
  close(cinematicEdgeCover(mix(0.5), near, far, true), 0.5, 1e-9);
  assert.equal(cinematicEdgeCover(mix(1 - CINEMATIC_EDGE_PURE / 2), near, far, false), 1, "texture noise is no mix");
  assert.equal(cinematicEdgeCover([0.3, 0.3, 0.3], [0.31, 0.3, 0.3], [0.29, 0.3, 0.3], true), 1, "alike colours: the own layer");
  assert.equal(cinematicEdgeCover([0.3, 0.3, 0.3], [0.31, 0.3, 0.3], [0.29, 0.3, 0.3], false), 0);
  // Which neighbours are the layers.
  const walker = cinematicEdgeLayers(8, 8, 350);
  assert.ok(walker.edge && walker.ownNear);
  assert.ok(cinematicEdgeLayers(Infinity, 8, Infinity).edge, "a walker against the sky");
  assert.equal(cinematicEdgeLayers(Infinity, 8, Infinity).ownNear, false);
  assert.equal(cinematicEdgeLayers(30, Infinity, Infinity).edge, false, "a texel among sky alone stays as it is");
  assert.equal(cinematicEdgeLayers(10, 10, 11).edge, false, "the ground under his feet is no silhouette");
  assert.equal(cinematicEdgeLayers(5, 40, 60).nearReference, "own", "a twig nearer than all four");
  assert.equal(cinematicEdgeLayers(Infinity, 20, 30).farReference, "own", "a pinhole of sky in a canopy");
  assert.equal(cinematicEdgeLayers(8, 8, 350).nearReference, "neighbour");
});

test("the composite blends a silhouette texel's layers and never sends a mixed texel out as sky", () => {
  const composite = new CinematicPost().composite.fragmentShader;
  const sky = composite.indexOf("bool sky = useDepth > 0.5 && depth >= 1.0;");
  const edge = composite.indexOf("float nearShare = 1.0;");
  const exit = composite.indexOf("gl_FragColor = vec4(clamp(display, vec3(0.0), vec3(1.0)), 1.0);");
  assert.ok(sky > 0 && edge > sky && exit > edge, "the layers are found before the sky's exit");
  assert.ok(composite.includes("sky = cover <= 0.0;"), "a sky-depth texel holding geometry stays in");
  assert.ok(composite.includes("uniform vec2 depthTexel;"));
  assert.match(composite, /texture2D\(depthTexture, vUV - vec2\(depthTexel\.x, 0\.0\)\)\.r, texture2D\(depthTexture, vUV \+ vec2\(depthTexel\.x, 0\.0\)\)\.r/);
  // Per-distance terms by each layer's share.
  assert.ok(composite.includes("if (nearShare < 1.0) amount = mix(cinematicHazeAmount(farYards, ray.y, lobe), amount, nearShare);"));
  assert.ok(composite.includes("if (nearShare < 1.0) shaftPath = mix(1.0 - exp(-farYards * shaftMarch.w), shaftPath, nearShare);"));
  assert.ok(composite.includes("if (nearShare < 1.0) volumeAdd = mix(cinematicVolumeLight(volumeRayAir(farYards), volumeLobe), volumeAdd, nearShare);"));
  // The sky's share back to the classic composite's bytes, after the chain and before the dither.
  const blend = composite.indexOf("if (skyShare > 0.0) outColour = mix(outColour, clamp(display, vec3(0.0), vec3(1.0)), skyShare);");
  assert.ok(blend > composite.indexOf("vec3 outColour = cinematicToDisplay(colour);"));
  assert.ok(blend < composite.indexOf("// Triangular dither"));
});
