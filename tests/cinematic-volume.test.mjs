// 12.10-7.30: sun beams through canopies with the camera level and the sun off screen — the
// volumetric march through the sun's shadow cascades.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  CINEMATIC_TUNING, CinematicPost, VOLUME_CASCADES, VOLUME_CONTEXT_TEXELS, VOLUME_FADE_YARDS, VOLUME_REACH_YARDS,
  VOLUME_STEPS, volumeScatter,
} from "../dist/code/browser/CinematicPost.js";
import {
  VOLUME_SIDE_CONTRAST_FROM, VOLUME_SIDE_CONTRAST_FULL, VOLUME_SIDE_GAIN, VOLUME_SOFTEN_SPACING, VOLUME_SOFTEN_TAPS,
  volumeSideBeam,
} from "../dist/code/browser/CinematicVolumeSide.js";
import {
  VOLUME_SOFTEN_PASSES, VOLUME_WIDTH_FROM, VOLUME_WIDTH_FULL, VOLUME_WIDTH_TEXELS, volumeBeamWidthKeep,
} from "../dist/code/browser/CinematicVolumeWidth.js";

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test("beams are lit air among shade: nothing in open sun or full shade, a lit ray in a canopy all of it", () => {
  // volumeScatter(lit share of the ray, lit share around it, air, forward lobe)
  assert.equal(volumeScatter(1, 1, 1, 1), 0, "open sunlit air is the haze leaf's");
  assert.equal(volumeScatter(0, 0, 1, 1), 0, "full shade");
  close(volumeScatter(1, 0, 1, 1), 1, 1e-12);
  close(volumeScatter(0.25, 0, 1, 1), 0.5); // a thin beam over a dim canopy floor still reads
  close(volumeScatter(0.25, 0, 0.5, 1), 0.25); // a short ray (the ground a few yards off) carries less
  // 22.10 (7.30): side-on a tenth for the veil, but a lit ray among shade is a beam from the side too.
  close(volumeScatter(0.5, 0.5, 1, 0), 0.5 * Math.SQRT1_2 * 0.1);
  close(volumeScatter(0.25, 0, 1, 0), 0.05 + VOLUME_SIDE_GAIN);
  assert.ok(volumeScatter(1, 0, 1, 0) >= volumeScatter(1, 0, 1, 1), "a canopy beam reads side-on");
  assert.equal(volumeScatter(0, 1, 1, 1), 0, "a shaded ray among lit ones adds nothing");
  // Along a large shadow's edge the lit side glows softly, the shaded side not at all.
  assert.ok(volumeScatter(1, 0.5, 1, 1) <= 0.5);
  assert.equal(volumeScatter(Number.NaN, 0, 1, 1), 0);
  assert.ok(VOLUME_STEPS >= 16 && VOLUME_REACH_YARDS >= 30 && VOLUME_FADE_YARDS > 0 && VOLUME_CONTEXT_TEXELS > 4);
  assert.ok(CINEMATIC_TUNING.volume > 0 && CINEMATIC_TUNING.volumeGolden >= 0);
});

test("22.10 (7.30): side-on, a beam is told from the veil by contrast, not angle", () => {
  // volumeSideBeam(lit share of the ray, lit share around it, air)
  close(volumeSideBeam(1, 0, 1), 1, 1e-12); // a canopy gap's ray among dark shade
  assert.equal(volumeSideBeam(0.5, 0.5, 1), 0, "evenly crossed shadows (a street) add no side-on beam");
  assert.equal(volumeSideBeam(0.6, 0.6 - VOLUME_SIDE_CONTRAST_FROM / 2, 1), 0, "the march's noise is no beam");
  close(volumeSideBeam(VOLUME_SIDE_CONTRAST_FULL, 0, 1), 1, 1e-12);
  assert.equal(volumeSideBeam(1, 0, 0.3), 0, "a grass blade a few yards off against the far forest is no beam");
  assert.ok(volumeSideBeam(1, 0.5, 1) <= 0.5, "a large shadow's edge glows at most half");
  assert.equal(volumeSideBeam(Number.NaN, 0, 1), 0);
  // Toward the sun the forward term has it all; the side term fades with the lobe.
  close(volumeScatter(1, 0, 1, 1), 1, 1e-12);
  close(volumeScatter(1, 0, 1, 0), 0.1 + VOLUME_SIDE_GAIN, 1e-12);
  const composite = new CinematicPost().composite.fragmentShader;
  assert.ok(composite.includes(`+ ${VOLUME_SIDE_GAIN.toFixed(3)} * sideBeam * (1.0 - volumeLobe)) * volumeLight.x`));
  assert.ok(composite.includes("float sideBeam = clamp((wideLit - wideAround"));
});

test("the march reads the cascades the world material reads, nearest first", () => {
  const post = new CinematicPost();
  const march = post.volumeMarch.fragmentShader;
  for (let index = 0; index < VOLUME_CASCADES; index++) {
    assert.ok(march.includes(`uniform highp sampler2DShadow sunShadowMap${index};`));
    assert.ok(march.includes(`uniform mat4 sunShadowMatrix${index};`));
  }
  assert.ok(march.includes("return texture(sunShadowMap0, c.xyz);"), "hardware compare, as three's PCF maps are made");
  assert.ok(march.indexOf("sunShadowMatrix0 * vec4(world, 1.0)") < march.indexOf("sunShadowMatrix1 * vec4(world, 1.0)"));
  assert.ok(march.includes(`for (int i = 0; i < ${VOLUME_STEPS}; i++)`));
  assert.ok(march.includes("exp(-t * volume.z)"), "near air outweighs the far glow");
  assert.ok(post.materials.includes(post.volumeMarch), "warmed with the other passes");
  const composite = post.composite.fragmentShader;
  assert.ok(composite.includes("float beam = sqrt(march.r) * (1.0 - min(around, march.r)) * march.g;"));
  assert.ok(composite.includes(`vec2 vw = vt * ${VOLUME_CONTEXT_TEXELS.toFixed(1)};`), "the shade around, from a wide cross");
  assert.ok(composite.includes("(beam * (0.1 + 0.9 * volumeLobe) + "));
  post.dispose();
});

function fakeRenderer() {
  const targets = [];
  return {
    targets,
    extensions: { has: () => true },
    autoClear: true,
    setRenderTarget(target) { targets.push(target); },
    render() {},
  };
}

function frame(sunShadows, shafts = 1) {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 2000);
  camera.updateMatrixWorld();
  return {
    scene: new THREE.Texture(), depth: new THREE.DepthTexture(64, 36), glow: new THREE.Texture(), glowStrength: 0,
    rays: new THREE.Texture(), rayStrength: 0, shafts, sunShadows, camera, width: 64, height: 36,
    contextGeneration: 1, renderScale: 1, elapsedSeconds: 1 / 60,
  };
}

function cascade(withMap = true) {
  const light = new THREE.DirectionalLight();
  if (withMap) {
    light.shadow.map = new THREE.WebGLRenderTarget(16, 16);
    light.shadow.map.depthTexture = new THREE.DepthTexture(16, 16);
    light.shadow.map.depthTexture.compareFunction = THREE.LessEqualCompare;
  }
  light.shadow.matrix.makeTranslation(1, 2, 3);
  return light;
}

test("22.10 (7.30): the march is softened by a separable gaussian before the composite reads it", () => {
  // Owner, 22.10, Goldshire: hatched, dotted side-on stripes. The soften pass takes the stipple
  // (|Laplacian| per unit of beam 1.12 -> 0.31 in the Elwynn forest still); the steeper contrast
  // ramp gives the softened beams their strength back (beam mean 15.5 -> 16.4).
  assert.equal(VOLUME_SOFTEN_SPACING, 1.5);
  assert.equal(VOLUME_SIDE_CONTRAST_FULL, 0.12);
  const total = VOLUME_SOFTEN_TAPS[0][1] + 2 * VOLUME_SOFTEN_TAPS.slice(1).reduce((sum, [, weight]) => sum + weight, 0);
  close(total, 1, 1e-6);
  const post = new CinematicPost();
  assert.ok(post.materials.includes(post.volumeSoften), "warmed with the other passes");
  const soften = post.volumeSoften.fragmentShader;
  assert.ok(soften.includes("texture2D(source, vUV + sourceTexel * 1.3846153846).rg"));
  // 23.10 (7.49): normalised by its weights, which are bilateral (tests/cinematic-silhouettes.test.mjs).
  assert.ok(soften.includes("gl_FragColor = vec4(sum / total, 0.0, 1.0);"), "both the lit share and the air");
  // March -> soft (horizontal) -> back to the march target (vertical), at half resolution.
  const renderer = fakeRenderer();
  post.setProfile({ grade: true, bloom: true, sunScattering: true });
  post.updateLight({
    diffuse: { r: 1, g: 0.9, b: 0.8 }, ambient: { r: 0.4, g: 0.5, b: 0.6 }, fog: { r: 0.3, g: 0.47, b: 0.56 },
    fogFar: 500, sun: new THREE.Vector3(0.2, 0.9, 0.3).normalize(), storm: 0, underwater: false, indoors: false, glow: 0.65,
  });
  post.render(renderer, frame([cascade(), cascade()]));
  const names = renderer.targets.map((target) => target?.texture?.name);
  const march = names.indexOf("cinematic-volume");
  assert.ok(march >= 0, "the march ran");
  // 22.10 (7.30): twice over (CinematicVolumeWidth.ts).
  assert.equal(VOLUME_SOFTEN_PASSES, 2);
  assert.deepEqual(names.slice(march, march + 5),
    ["cinematic-volume", "cinematic-volume-soft", "cinematic-volume", "cinematic-volume-soft", "cinematic-volume"]);
  assert.equal(post.uniforms.volumeTexture.value.name, "cinematic-volume");
  assert.ok(post.renderTargets.some((target) => target.texture.name === "cinematic-volume-soft"));
  post.dispose();
});

test("the march runs only with cascades handed over, and never leaves a compare slot empty", () => {
  const post = new CinematicPost();
  post.setProfile({ grade: true, bloom: true, sunScattering: true });
  post.updateLight({
    diffuse: { r: 1, g: 0.53, b: 0 }, ambient: { r: 0.4, g: 0.5, b: 0.6 }, fog: { r: 0.3, g: 0.47, b: 0.56 },
    fogFar: 500, sun: new THREE.Vector3(0.2, 0.9, 0.3).normalize(), storm: 0, underwater: false, indoors: false, glow: 0.65,
  });
  const u = post.uniforms;
  // No cascades (the comparison level, lighting quality without a shadow map, an old renderer): off.
  post.render(fakeRenderer(), frame(undefined));
  assert.equal(u.volumeLight.value.x, 0);
  // Two cascades (lighting quality 1): the third slot holds a real compare texture, not three's
  // 1x1 stand-in, which ANGLE refused the whole draw for (GL 1282).
  const near = cascade(), far = cascade();
  post.render(fakeRenderer(), frame([near, far]));
  assert.ok(u.volumeLight.value.x > 0);
  assert.equal(u.volume.value.x, 2);
  assert.equal(u.sunShadowMap0.value, near.shadow.map.depthTexture);
  assert.equal(u.sunShadowMap1.value, far.shadow.map.depthTexture);
  assert.equal(u.sunShadowMap2.value, near.shadow.map.depthTexture);
  assert.deepEqual(u.sunShadowMatrix1.value.elements, far.shadow.matrix.elements);
  // A cascade not rendered yet ends the run.
  post.render(fakeRenderer(), frame([near, cascade(false), far]));
  assert.equal(u.volume.value.x, 1);
  // The shafts' ceiling is the march's too: the slider at zero turns it off.
  post.render(fakeRenderer(), frame([near, far], 0));
  assert.equal(u.volumeLight.value.x, 0);
  post.release();
  assert.equal(u.sunShadowMap0.value, null, "the cascades' maps are only borrowed for a frame");
  post.dispose();
});

test("22.10 (7.30): a thin volume beam fades, a wide one is kept", () => {
  // Owner, 22.10, Orgrimmar's gate: one long thin bright line across the frame. Owner settings, beam
  // contribution (on − godRays off), thin part p99.5 / max of 255: Elwynn forest side-on 15.5 / 40.4
  // -> 13.4 / 37.3 (beam mean 21.7 -> 21.5), Goldshire 17.7 / 73.5 -> 16.6 / 57.0.
  // volumeBeamWidthKeep(ray's lit share, ring's mean lit share, shade around)
  assert.equal(volumeBeamWidthKeep(1, 1, 0), 1, "a wide beam: the ring is as lit as the ray");
  assert.equal(volumeBeamWidthKeep(1, 0.25, 0), 0, "a thin line: only the two ring taps along it are lit");
  close(volumeBeamWidthKeep(1, (VOLUME_WIDTH_FROM + VOLUME_WIDTH_FULL) / 2, 0), 0.5, 1e-12);
  assert.equal(volumeBeamWidthKeep(0.51, 0.5, 0.5), 1, "no contrast to measure a width against: left as it was");
  assert.equal(volumeBeamWidthKeep(Number.NaN, 0, 0), 1);
  assert.ok(VOLUME_WIDTH_TEXELS >= 8, "the ring stands clear of a thin line's softened profile");
  const composite = new CinematicPost().composite.fragmentShader;
  const side = composite.indexOf("float sideBeam = clamp((wideLit - wideAround");
  const width = composite.indexOf("sideBeam *= widthKeep;");
  assert.ok(side > 0 && width > side && width < composite.indexOf("(beam * (0.1 + 0.9 * volumeLobe) + "));
  assert.ok(composite.includes("beam *= widthKeep;"), "the forward term too");
  // 23.10 (7.49): the ring reads the air too (a tap of another reach counts as the ray itself).
  assert.ok(composite.includes(`* vt * ${VOLUME_WIDTH_TEXELS.toFixed(1)}).rg;`));
});

test("22.10 (7.30): the sun's effects fade where the client draws no sun", async () => {
  // Owner, 22.10: «в некоторых местах солнце лишнее». Hellfire (HellfireSkyBox, flags 0), owner
  // settings: mean luma 40.7 -> 31.5 with the sun's glare and haze warmth gone; Elwynn unchanged.
  const { clientDrawsSun, stepSunShown, SUN_SHOWN_RATE } = await import("../dist/code/browser/CinematicSunGate.js");
  const { skyboxCoversSky } = await import("../dist/code/browser/SkyCelestials.js");
  assert.equal(clientDrawsSun(true, false), true);
  assert.equal(clientDrawsSun(true, skyboxCoversSky(true, 0)), false, "a LightSkybox without Flags & 2 covers the sky");
  assert.equal(clientDrawsSun(true, skyboxCoversSky(true, 2)), true, "an overlay skybox (Flags & 2) keeps the sun");
  assert.equal(clientDrawsSun(false, false), false, "no sky dome (an interior-only room)");
  close(stepSunShown(1, 0, 1 / 60), Math.exp(-SUN_SHOWN_RATE / 60), 1e-12);
  assert.equal(stepSunShown(0.0005, 0, 1 / 60), 0, "snaps at the end");
  const light = {
    diffuse: { r: 1, g: 0.9, b: 0.8 }, ambient: { r: 0.4, g: 0.5, b: 0.6 }, fog: { r: 0.3, g: 0.47, b: 0.56 },
    fogFar: 500, sun: new THREE.Vector3(0.2, 0.5, 0.3).normalize(), storm: 0, underwater: false, indoors: false, glow: 0.65,
  };
  const post = new CinematicPost();
  post.setProfile({ grade: true, bloom: true, sunScattering: true });
  post.updateLight(light);
  post.settle();
  const u = post.uniforms;
  assert.ok(u.sunDisc.value.x > 0 && u.sunGlare.value.x > 0 && u.hazeGlare.value > 0 && u.haze.value.y > 0);
  const haze = u.haze.value.x;
  post.updateLight({ ...light, sunHidden: true });
  const renderer = fakeRenderer();
  post.render(renderer, frame([cascade(), cascade()]));
  assert.ok(post.sunShown < 1 && post.sunShown > 0.9, `a fade, not a pop: ${post.sunShown}`);
  post.settle();
  assert.equal(post.sunShown, 0);
  assert.equal(u.sunDisc.value.x, 0);
  assert.equal(u.sunGlare.value.x, 0);
  assert.equal(u.hazeGlare.value, 0);
  assert.equal(u.haze.value.y, 0, "no sun warmth in the haze");
  assert.equal(u.haze.value.x, haze, "the zone's own haze stays");
  const before = renderer.targets.length;
  post.render(renderer, frame([cascade(), cascade()]));
  const names = renderer.targets.slice(before).map((target) => target?.texture?.name);
  assert.ok(!names.includes("cinematic-volume"), "no march without a sun");
  assert.equal(u.volumeLight.value.x, 0);
  post.dispose();
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /light\.sunHidden = !clientDrawsSun\(this\.#sky\.visible,\s*skyboxCoversSky\(this\.#skyboxGroup\.children\.length > 0, sample\.skyboxFlags\)\);/);
});
