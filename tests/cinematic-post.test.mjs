import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  AMBIENT_OCCLUSION_MIN_RENDER_SCALE,
  BLOOM_LEVELS,
  CINEMATIC_STRENGTH_DEFAULT,
  CINEMATIC_STRENGTH_MAX,
  CinematicPost,
  DEFAULT_CINEMATIC_PROFILE,
  FILMIC_KNEE,
  FILMIC_WHITE,
  SHAFT_AIR_YARDS,
  SHAFT_SAMPLES,
  SHAFT_SOURCE_LIMIT,
  CINEMATIC_TUNING,
  bloomContribution,
  bloomMipSizes,
  cinematicGrade,
  cinematicNeedsDepth,
  cinematicPostActive,
  cinematicShaftSource,
  cinematicStrength,
  cinematicZoneAtmosphere,
  filmicContrast,
  filmicShoulder,
  normaliseCinematicProfile,
  scatteringPhase,
  shaftCeiling,
  unitLuminanceHue,
} from "../dist/code/browser/CinematicPost.js";
import { GOD_RAY_STRENGTH_SCALE_MAX } from "../dist/code/browser/LightingQuality.js";
import { lowSunRimStrength, createWorldLightUniforms, setWorldLightRim, WORLD_LIGHT_BODY } from "../dist/code/browser/WorldLighting.js";
import { copyWaterSkyBands, createWaterShaderSharedUniforms, setLiquidWaterShaderProfile } from "../dist/code/browser/Water.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";

const luma = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test("the filmic shoulder is the identity below the knee, C1 at it, and reaches white exactly", () => {
  for (const x of [0, 0.01, 0.18, 0.5, FILMIC_KNEE]) assert.equal(filmicShoulder(x), x);
  assert.equal(filmicShoulder(-1), 0);
  assert.ok(close(filmicShoulder(FILMIC_WHITE), 1, 1e-9));
  assert.equal(filmicShoulder(FILMIC_WHITE * 3), 1);
  const h = 1e-5;
  const slope = (filmicShoulder(FILMIC_KNEE + h) - filmicShoulder(FILMIC_KNEE)) / h;
  assert.ok(close(slope, 1, 1e-3), `slope at knee ${slope}`);
  let previous = -1;
  for (let x = 0; x <= FILMIC_WHITE; x += 0.01) {
    const y = filmicShoulder(x);
    assert.ok(y >= previous, "monotonic");
    assert.ok(y <= 1);
    previous = y;
  }
  // Display white (linear 1) keeps real headroom but is not crushed.
  const white = filmicShoulder(1);
  assert.ok(white > 0.85 && white < 0.95, `linear 1 -> ${white}`);
});

test("log-space contrast pivots on mid grey", () => {
  assert.ok(close(filmicContrast(0.18, 1.2), 0.18));
  assert.ok(filmicContrast(0.6, 1.1) > 0.6);
  assert.ok(filmicContrast(0.05, 1.1) < 0.05);
  assert.equal(filmicContrast(0, 1.1), 0);
});

const ELWYNN_DUSK = {
  diffuse: { r: 1.0, g: 0.62, b: 0.32 },
  ambient: { r: 0.42, g: 0.36, b: 0.52 },
  fog: { r: 0.75, g: 0.55, b: 0.45 },
};

test("the grade follows the zone's Light.dbc hues and the sun elevation", () => {
  const golden = cinematicGrade({ ...ELWYNN_DUSK, sunElevation: 0.1, storm: 0, underwater: false });
  const noon = cinematicGrade({ ...ELWYNN_DUSK, diffuse: { r: 1, g: 0.95, b: 0.85 }, sunElevation: 0.95, storm: 0, underwater: false });
  const night = cinematicGrade({ ...ELWYNN_DUSK, diffuse: { r: 0.3, g: 0.35, b: 0.55 }, sunElevation: -0.6, storm: 0, underwater: false });
  assert.ok(golden.golden > 0.9, `golden ${golden.golden}`);
  assert.ok(noon.golden < 0.01);
  assert.ok(night.night > 0.99 && night.golden === 0);
  // Warm highlights at golden hour, from the diffuse band itself.
  assert.ok(golden.highlightTint.r > golden.highlightTint.b * 1.4);
  assert.ok(golden.highlightTint.r - golden.highlightTint.b > noon.highlightTint.r - noon.highlightTint.b);
  // Cool night shadows.
  assert.ok(night.shadowTint.b > night.shadowTint.r);
  assert.ok(night.saturation < golden.saturation);
  assert.ok(golden.contrast > noon.contrast);
  // Tints only change hue, never brightness.
  for (const grade of [golden, noon, night]) {
    assert.ok(close(luma(grade.highlightTint), 1, 1e-9));
    assert.ok(close(luma(grade.shadowTint), 1, 1e-9));
  }
  // A storm flattens the grade.
  const storm = cinematicGrade({ ...ELWYNN_DUSK, sunElevation: 0.1, storm: 1, underwater: false });
  assert.ok(storm.saturation < golden.saturation && storm.daylight === 0);
});

test("the grade is finite and allocation-free for garbage input", () => {
  const target = cinematicGrade({ ...ELWYNN_DUSK, sunElevation: 0.3, storm: 0, underwater: false });
  const same = cinematicGrade({
    diffuse: { r: NaN, g: -1, b: Infinity }, ambient: { r: 0, g: 0, b: 0 }, fog: ELWYNN_DUSK.fog,
    sunElevation: NaN, storm: NaN, underwater: true,
  }, target);
  assert.equal(same, target);
  for (const value of [same.exposure, same.contrast, same.saturation, same.vignette, same.golden,
    same.highlightTint.r, same.highlightTint.g, same.highlightTint.b, same.shadowTint.r, same.shadowTint.b]) {
    assert.ok(Number.isFinite(value));
  }
  assert.deepEqual(unitLuminanceHue({ r: 0, g: 0, b: 0 }), { r: 1, g: 1, b: 1 });
});

test("forward scattering peaks toward the sun", () => {
  const g = 0.58;
  assert.ok(scatteringPhase(1, g) > scatteringPhase(0, g) * 8);
  assert.ok(scatteringPhase(0, g) > scatteringPhase(-1, g));
  assert.ok(close(scatteringPhase(0.3, 0), 1));
  assert.ok(Number.isFinite(scatteringPhase(NaN, g)));
});

test("the bloom chain halves from half resolution and never reaches zero", () => {
  const sizes = bloomMipSizes(1920, 1080);
  assert.equal(sizes.length, BLOOM_LEVELS);
  assert.deepEqual(sizes[0], { width: 960, height: 540 });
  assert.deepEqual(sizes[5], { width: 30, height: 16 });
  for (const size of bloomMipSizes(3, 1)) assert.ok(size.width >= 1 && size.height >= 1);
});

test("profiles normalise, and only post leaves select the composited path", () => {
  assert.deepEqual(normaliseCinematicProfile(undefined), DEFAULT_CINEMATIC_PROFILE);
  assert.equal(normaliseCinematicProfile({ grade: "yes" }).grade, false);
  assert.equal(cinematicPostActive(DEFAULT_CINEMATIC_PROFILE), false);
  const material = normaliseCinematicProfile({ rimLight: true, waterSunGlitter: true, sceneryShadows: true });
  assert.equal(cinematicPostActive(material), false, "material leaves never force a capture");
  assert.equal(cinematicNeedsDepth(normaliseCinematicProfile({ grade: true })), false);
  for (const leaf of ["bloom", "sunScattering", "ambientOcclusion"]) {
    assert.equal(cinematicNeedsDepth(normaliseCinematicProfile({ [leaf]: true })), true, leaf);
  }
  assert.ok(AMBIENT_OCCLUSION_MIN_RENDER_SCALE > 0.5 && AMBIENT_OCCLUSION_MIN_RENDER_SCALE < 1);
});

test("the post chain builds without a context and keeps its shaders self-consistent", () => {
  const post = new CinematicPost();
  assert.equal(post.materials.length, 8);
  assert.equal(post.active, false);
  assert.equal(post.setProfile({ bloom: true }), true);
  assert.equal(post.active, true);
  assert.equal(post.needsDepth, true);
  assert.equal(post.setProfile({ bloom: true, rimLight: true }), false, "a material leaf is not a post change");
  for (const material of post.materials) {
    assert.equal(material.toneMapped, false);
    assert.equal(material.depthTest, false);
    assert.equal(material.fog, false);
    assert.doesNotMatch(material.fragmentShader, /colorspace_fragment|tonemapping_fragment/);
  }
  assert.match(post.composite.fragmentShader, new RegExp(`knee = ${FILMIC_KNEE.toFixed(4)}`));
  assert.match(post.composite.fragmentShader, new RegExp(`white = ${FILMIC_WHITE.toFixed(4)}`));
  assert.equal(post.upsample.blending, THREE.AdditiveBlending);
  // Per-frame light push writes into the existing uniform objects.
  const sunColour = post.uniforms.sunColour.value;
  post.updateLight({ ...ELWYNN_DUSK, fogFar: 400, sun: { x: 0, y: 0.1, z: -1 }, storm: 0, underwater: false, indoors: false });
  assert.equal(post.uniforms.sunColour.value, sunColour);
  assert.ok(post.uniforms.haze.value.x > 0 && post.uniforms.sunDisc.value.x > 0);
  const outdoorHaze = post.uniforms.haze.value.x;
  post.updateLight({ ...ELWYNN_DUSK, fogFar: 400, sun: { x: 0, y: 0.1, z: -1 }, storm: 0, underwater: false, indoors: true });
  assert.ok(post.uniforms.haze.value.x > 0, "walking under a roof fades the haze rather than cutting it");
  post.settle();
  assert.equal(post.shelter, 1);
  assert.equal(post.uniforms.haze.value.x, 0, "no sky haze or sun disc indoors");
  assert.equal(post.uniforms.sunDisc.value.x, 0);
  post.updateLight({ ...ELWYNN_DUSK, fogFar: 400, sun: { x: 0, y: 0.1, z: -1 }, storm: 0, underwater: false, indoors: false });
  post.settle();
  assert.ok(close(post.uniforms.haze.value.x, outdoorHaze), "and it comes back outdoors");
  post.setProfile({});
  assert.equal(post.active, false);
});

test("the strength slider scales grade, bloom glare, haze and shafts together; 0 is neutral", () => {
  assert.equal(cinematicStrength(1.2), 1.2);
  assert.equal(cinematicStrength(-3), 0);
  assert.equal(cinematicStrength(99), CINEMATIC_STRENGTH_MAX);
  assert.equal(cinematicStrength(Number.NaN), CINEMATIC_STRENGTH_DEFAULT);
  const light = { ...ELWYNN_DUSK, fogFar: 400, sun: { x: 0, y: 0.1, z: -1 }, storm: 0, underwater: false, indoors: false, glow: 0.65 };
  const at = (strength) => {
    const post = new CinematicPost();
    post.setProfile({ grade: true, bloom: true, sunScattering: true });
    post.setStrength(strength);
    post.updateLight(light);
    const u = post.uniforms;
    return { haze: u.haze.value.x, glare: u.sunGlare.value.x, hazeGlare: u.hazeGlare.value, disc: u.sunDisc.value.x,
      contrast: post.grade.contrast, saturation: post.grade.saturation, vignette: post.grade.vignette,
      tint: post.grade.highlightTint.r - post.grade.highlightTint.b };
  };
  const zero = at(0), full = at(1), max = at(1.5);
  for (const key of ["haze", "glare", "hazeGlare", "disc", "vignette", "tint"]) {
    assert.ok(close(zero[key], 0, 1e-9), `${key} at 0`);
    assert.ok(max[key] > full[key] && full[key] > 0, `${key} grows with the slider`);
  }
  assert.equal(zero.contrast, 1);
  assert.equal(zero.saturation, 1);
  assert.ok(close(max.haze / full.haze, 1.5, 1e-9), "haze is exactly proportional below its cap");
  assert.ok(max.contrast > full.contrast && full.contrast > 1);
});

test("zone atmosphere follows the authored LightParams.Glow; roofs are a separate smoothed factor", () => {
  assert.equal(cinematicZoneAtmosphere(0), 0.5, "Ironforge, Dun Morogh, Dalaran author 0");
  assert.equal(cinematicZoneAtmosphere(0.65), 1, "Elwynn, Stranglethorn, Booty Bay");
  assert.equal(cinematicZoneAtmosphere(1), 1, "Darnassus");
  const stormwind = cinematicZoneAtmosphere(0.3);
  assert.ok(stormwind > 0.5 && stormwind < 1);
  assert.equal(cinematicZoneAtmosphere(undefined), 0.75);
  assert.equal(cinematicZoneAtmosphere(Number.NaN), 0.75);
  const haze = (glow) => {
    const post = new CinematicPost();
    post.setProfile({ sunScattering: true });
    post.updateLight({ ...ELWYNN_DUSK, fogFar: 400, sun: { x: 0, y: 0.6, z: -0.8 }, storm: 0, underwater: false, indoors: false, glow });
    return { haze: post.uniforms.haze.value.x, saturation: post.grade.saturation };
  };
  const crisp = haze(0), soft = haze(0.65);
  assert.ok(close(crisp.haze / soft.haze, 0.5, 1e-9), "a crisp zone keeps half the haze");
  assert.ok(crisp.saturation < soft.saturation, "and a gentler grade");
});

test("daytime grade lifts shadows and stays lighter in contrast than golden hour", () => {
  const noon = cinematicGrade({ ...ELWYNN_DUSK, diffuse: { r: 1, g: 0.95, b: 0.85 }, sunElevation: 0.95, storm: 0, underwater: false });
  const golden = cinematicGrade({ ...ELWYNN_DUSK, sunElevation: 0.1, storm: 0, underwater: false });
  const night = cinematicGrade({ ...ELWYNN_DUSK, sunElevation: -0.6, storm: 0, underwater: false });
  assert.ok(noon.lift > 0.1 && noon.lift < 0.2, `noon lift ${noon.lift}`);
  assert.ok(noon.exposure > 1, "midday is not darkened by the grade");
  assert.equal(night.lift, 0);
  assert.ok(golden.contrast > noon.contrast);
  assert.ok(golden.highlightTint.r - golden.highlightTint.b > 0.5, "golden hour is decidedly warm");
});

test("shaft source: in front it is the sun's projection; behind it marches away from the antisolar point", () => {
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 2000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  const ahead = cinematicShaftSource(camera, new THREE.Vector3(0, 0.1, -1).normalize());
  assert.equal(ahead.direction, 1);
  assert.ok(Math.abs(ahead.u - 0.5) < 1e-9 && ahead.v > 0.5 && ahead.v < 1, "low sun ahead sits in the frame");
  assert.ok(ahead.weight > 0.9);
  // Sun just beyond the right edge still throws its shafts in, weaker.
  const edge = cinematicShaftSource(camera, new THREE.Vector3(Math.sin(1.0), 0.1, -Math.cos(1.0)).normalize());
  assert.ok(edge.u > 1 && edge.weight > 0.45 && edge.weight < ahead.weight, `edge ${edge.u} ${edge.weight}`);
  // Low sun straight behind: nothing.
  const behind = cinematicShaftSource(camera, new THREE.Vector3(0, 0.1, 1).normalize());
  assert.equal(behind.direction, -1);
  assert.equal(behind.weight, 0);
  // High noon sun above a level camera: vertical shafts from the top, whichever way it faces.
  for (const sun of [new THREE.Vector3(0.35, 1, 0).normalize(), new THREE.Vector3(0, 1, 0.3).normalize()]) {
    const overhead = cinematicShaftSource(camera, sun);
    assert.ok(overhead.weight >= 0.5, `overhead weight ${overhead.weight}`);
    const marchUp = (overhead.v - 0.5) * overhead.direction;
    assert.ok(marchUp > 0, "the march heads up the screen toward the canopy gaps");
    assert.ok(Math.hypot(overhead.u - 0.5, overhead.v - 0.5) <= SHAFT_SOURCE_LIMIT / 2 + 1e-9, "source is bounded");
  }
  const garbage = cinematicShaftSource(camera, { x: Number.NaN, y: 0, z: 0 });
  assert.equal(garbage.weight, 0);
});

test("shaft passes are fixed-cost two-pass marches and only the composite adds them", () => {
  const post = new CinematicPost();
  assert.equal(SHAFT_SAMPLES, 32);
  assert.match(post.shaftBlur.fragmentShader, new RegExp(`for \\(int i = 0; i < ${SHAFT_SAMPLES}; i\\+\\+\\)`));
  assert.match(post.shaftBlur.fragmentShader, /step\(vec2\(0\.0\), uv\) \* step\(uv, vec2\(1\.0\)\)/,
    "off-screen taps add nothing");
  assert.match(post.shaftMask.fragmentShader, /step\(1\.0, texture2D\(depthTexture/, "only clear sky emits");
  assert.match(post.composite.fragmentShader, /vec3 shaftRays = texture2D\(shaftTexture, vUV\)\.rgb;/);
  assert.match(post.composite.fragmentShader, /pow\(shaftRays\.r, 1\.25\)/);
  // Beams are weighted by how much of the ray's way to the sun is blocked: sky coverage (blue) over
  // the unblocked lobe (green), with the sky's brightness kept out of it; open rays add little.
  assert.match(post.composite.fragmentShader, /1\.0 - clamp\(shaftRays\.b \/ max\(shaftRays\.g, 1e-4\), 0\.0, 1\.0\)/);
  assert.match(post.composite.fragmentShader, /shaft \*= mix\(0\.12, 1\.0, smoothstep\(0\.1, 0\.5, blocked\)\);/);
  // The near-sun guard is a few degrees wide, not the golden-hour emission lobe's whole width.
  assert.match(post.composite.fragmentShader, /shaft \*= 1\.0 - 0\.6 \* smoothstep\(0\.94, 0\.995, facing\);/);
  // Scattered along the view ray: the ground at the character's feet carries almost none of it.
  assert.match(post.composite.fragmentShader, /float shaftPath = sky \? 1\.0 : 1\.0 - exp\(-length\(view\) \* shaftMarch\.w\);/);
  assert.ok(Math.abs(post.uniforms.shaftMarch.value.w - 1 / SHAFT_AIR_YARDS) < 1e-12);
  assert.doesNotMatch(post.composite.fragmentShader, /smoothstep\(0\.9, 0\.99, facing\)/);
  assert.match(post.shaftMask.fragmentShader, /gl_FragColor = vec4\(emit \* above, lobe \* above, sky \* lobe \* above, 1\.0\);/);
  assert.match(post.shaftBlur.fragmentShader, /texture2D\(source, uv\)\.rgb \* weight/);
  assert.match(post.composite.fragmentShader, /shaft \* shaftStrength/);
  assert.equal(post.renderTargets.length, 0, "no buffers before a frame is drawn");
});

test("low-sun rim light is gated, zero at noon and at night, and never touches terrain", () => {
  assert.equal(lowSunRimStrength(false, 0.1), 0);
  assert.equal(lowSunRimStrength(true, 0.95), 0);
  assert.equal(lowSunRimStrength(true, -0.5), 0);
  assert.ok(lowSunRimStrength(true, 0.1) > 0.9);
  const uniforms = createWorldLightUniforms();
  assert.equal(uniforms.wowRimStrength.value, 0);
  setWorldLightRim(uniforms, true, 0.1);
  assert.ok(uniforms.wowRimStrength.value > 0.9);
  const rim = WORLD_LIGHT_BODY.indexOf("wowRimStrength > 0.0001");
  const immersive = WORLD_LIGHT_BODY.indexOf("wowImmersiveStrength > 0.0001");
  assert.ok(immersive >= 0 && rim > immersive, "rim sits inside the immersive branch (quality 0 never runs it)");
  assert.match(WORLD_LIGHT_BODY, /#if !defined\( WOW_LIGHT_TERRAIN \)\s+if \( wowRimStrength/);
});

test("water glitter is its own mask bit; without it the water program is unchanged", () => {
  const profile = { waterFresnel: true, waterMicroWaves: true, waterSunSparkle: true, waterFoam: true, fantasyGlow: false };
  const shared = createWaterShaderSharedUniforms();
  const base = new THREE.MeshBasicMaterial();
  const glitter = new THREE.MeshBasicMaterial();
  setLiquidWaterShaderProfile(base, "ocean", profile, shared);
  setLiquidWaterShaderProfile(glitter, "ocean", { ...profile, waterSunGlitter: true }, shared);
  assert.match(base.customProgramCacheKey(), /-15$/);
  assert.match(glitter.customProgramCacheKey(), /-31$/);
  const compile = (material) => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
    material.onBeforeCompile(shader, undefined);
    return shader.fragmentShader;
  };
  assert.doesNotMatch(compile(base), /glitter/);
  assert.match(compile(glitter), /glitterFacet/);
});

test("sky reflection is mask bit 32: it mirrors the dome's bands and supersedes the fog Fresnel", () => {
  const profile = { waterFresnel: true, waterMicroWaves: true, waterSunSparkle: true, waterFoam: true, fantasyGlow: false };
  const shared = createWaterShaderSharedUniforms();
  const base = new THREE.MeshBasicMaterial();
  const sky = new THREE.MeshBasicMaterial();
  setLiquidWaterShaderProfile(base, "water", profile, shared);
  setLiquidWaterShaderProfile(sky, "water", { ...profile, waterSunGlitter: true, waterSkyReflection: true }, shared);
  assert.match(base.customProgramCacheKey(), /-15$/);
  assert.match(sky.customProgramCacheKey(), /-63$/);
  const compile = (material) => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
    material.onBeforeCompile(shader, undefined);
    return shader;
  };
  const off = compile(base);
  assert.doesNotMatch(off.fragmentShader, /waterSky(Top|Upper|Mirror)/, "without the leaf nothing is added");
  assert.equal(off.uniforms.waterSkyTop, undefined);
  const on = compile(sky);
  assert.match(on.fragmentShader, /water-sky-reflection-v2/);
  assert.doesNotMatch(on.fragmentShader, /waterSkyColourLinear \+ waterSunColourLinear \* 0\.10/,
    "the flat fog-colour Fresnel is replaced, not stacked");
  assert.match(on.fragmentShader, /glitterFacet/, "glitter keeps working on top");
  assert.match(on.fragmentShader, /waterSkyAmount = waterSkyFresnel \* waterSkyAbove/,
    "a liquid plane above the eye (lower shore) is not turned into an opaque mirror");
  for (const band of ["Top", "Upper", "Middle", "Lower", "Horizon"]) {
    assert.equal(on.uniforms[`waterSky${band}`], shared[`sky${band}`], `${band} band is the shared object`);
  }
  // The renderer copies the dome's bands in place, without replacing the bound objects.
  const bound = shared.skyHorizon.value;
  const dome = {
    skyTop: { value: new THREE.Color(0.1, 0.1, 0.3) }, skyUpper: { value: new THREE.Color(0.3, 0.2, 0.3) },
    skyMiddle: { value: new THREE.Color(0.8, 0.4, 0.2) }, skyLower: { value: new THREE.Color(1, 0.5, 0.2) },
    skyHorizon: { value: new THREE.Color(1, 0.6, 0.3) },
  };
  copyWaterSkyBands(shared, dome);
  assert.equal(shared.skyHorizon.value, bound);
  assert.ok(shared.skyHorizon.value.equals(dome.skyHorizon.value));
});

test("every cinematic leaf is a Russian-labelled effect the enhanced preset enables and the control profile disables", async () => {
  const ids = ["experimentalCinematicGrade", "experimentalCinematicBloom", "experimentalSunScattering",
    "experimentalAmbientOcclusion", "experimentalLowSunRimLight", "experimentalWaterSunGlitter",
    "experimentalSceneryShadows", "experimentalWaterSkyReflection"];
  for (const id of ids) {
    const definition = settingDefinition(id);
    assert.ok(definition, id);
    assert.equal(definition.group, "Эффекты");
    assert.equal(definition.kind, "boolean");
    assert.match(definition.label, /[А-Яа-я]/);
    assert.equal(ENHANCED_GRAPHICS_OVERRIDES[id], true, `${id} in the enhanced preset`);
    assert.equal(COMPARISON_GRAPHICS_OVERRIDES[id], false, `${id} off in the comparison profile`);
  }
  // Pass-costing leaves stay off for players who did not pick the preset.
  for (const id of [...ids.slice(0, 4), "experimentalSceneryShadows"]) {
    assert.equal(settingDefinition(id).fallback, false, id);
  }
  const settings = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  assert.match(settings, /setCinematicProfile\?\.\(\{/);
  assert.match(settings, /waterSkyReflection: settingBoolean\(values, "experimentalWaterSkyReflection"\)/);
  // One strength slider over the cinematic leaves, in percent like the other percentage sliders.
  const slider = settingDefinition("cinematicStrength");
  assert.ok(slider);
  assert.equal(slider.kind, "number");
  assert.equal(slider.group, "Эффекты");
  assert.match(slider.label, /^Сила кинематографичных эффектов/);
  assert.deepEqual([slider.min, slider.max, slider.fallback], [0, 150, 100]);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.cinematicStrength, slider.fallback, "the preset sets the default");
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.cinematicStrength, slider.fallback);
  assert.match(settings, /setCinematicStrength\?\.\(settingNumber\(values, "cinematicStrength"\) \/ 100\)/);
});

test("the frame's shaft ceiling passes the account's multiplier above one instead of clipping it", async () => {
  assert.equal(shaftCeiling(undefined), 0, "no leaf, no shafts");
  assert.equal(shaftCeiling(Number.NaN), 0);
  assert.equal(shaftCeiling(-0.5), 0);
  assert.equal(shaftCeiling(0.6), 0.6, "the balanced quality's share is unchanged");
  assert.equal(shaftCeiling(1), 1, "100 % at the high quality is today's ceiling");
  assert.equal(shaftCeiling(3), 3, "300 % survives to the march's strength");
  assert.equal(shaftCeiling(10), GOD_RAY_STRENGTH_SCALE_MAX, "and a settings file stops at the shared bound");
  const source = await readFile(new URL("../src/browser/CinematicPost.ts", import.meta.url), "utf8");
  assert.match(source, /const ceiling = shaftCeiling\(frame\.shafts\);/);
  assert.match(source, /const wanted = this\.#shaftGain \* ceiling \* source\.weight;/,
    "the ceiling multiplies the strength linearly: three times the ceiling is three times the beams");
  assert.match(source, /shaftStrength = wanted;/);
});

test("the renderer only enters the cinematic path when a post leaf is active", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!this\.#fullscreenGlowEnabled && !this\.#godRaysActive\(\) && !this\.#cinematic\.active\) return undefined;/);
  assert.match(source, /if \(this\.#cinematic\.active\) \{\s+const depth = targets\.scene\.depthTexture;/);
  // Scenery shadows need a shadow map and the leaf; off, the branch is walked once to clear flags.
  // And not inside a building made only of rooms, where the sun's term is suppressed for every
  // receiver and its casters would only cost shadow-pass draws (`#interiorLight`, set by the room
  // the player stands in).
  assert.match(source, /const wanted = this\.#cinematic\.profile\.sceneryShadows && this\.#lightingProfile\.shadowMapSize > 0\s+&& this\.#interiorLight === undefined;/);
  assert.match(source, /if \(!wanted && !this\.#sceneryShadowsApplied\) return;/);
  // Lighting quality 0 is the faithful frame: it overrides every requested cinematic leaf.
  assert.match(source, /const profile = this\.#lightingProfile\.quality === 0 \? undefined : this\.#cinematicRequested;/);
  // Under the cinematic chain the shaft leaf is CinematicPost's march; the classic pass is skipped.
  assert.match(source, /const rayStrength = this\.#cinematic\.active \? 0 : this\.#prepareGodRays\(targets\);/);
  assert.match(source, /shafts: cinematicShafts,/);
  assert.match(source, /copyWaterSkyBands\(this\.#waterShaderUniforms, this\.#skyUniforms\);/);
});

test("bright authored textures do not bloom onto themselves; the sun's glare stays near the disc", () => {
  // The capture is display-referred: sunlit sand, snow and white stone sit at 0.6-0.9 linear, like
  // a lamp. Those must pass (almost) nothing; only near-white texels and injected HDR spread.
  assert.equal(bloomContribution(0.6), 0, "sunlit sand");
  assert.ok(bloomContribution(0.75) < 0.05, `bright stone ${bloomContribution(0.75)}`);
  assert.ok(bloomContribution(1.0) <= 0.2 + 1e-9, "a flat white field gains at most 0.16 from its own bloom");
  assert.ok(bloomContribution(3) > 0.7, "HDR sun energy still blooms");
  const post = new CinematicPost();
  const t = post.uniforms.threshold.value;
  assert.equal(t.x, CINEMATIC_TUNING.bloomThreshold);
  assert.equal(t.y, CINEMATIC_TUNING.bloomKnee);
  assert.ok(Math.abs(t.z - 1 / (4 * CINEMATIC_TUNING.bloomKnee)) < 1e-12, "the GLSL knee is the JS twin's");
  // Energy-conserving: the texel's own share (x the level count the strength is divided by) leaves
  // as its blur arrives, so a uniform bright field gains nothing at any slider value.
  assert.match(post.composite.fragmentShader,
    new RegExp(`- bloomScene \\* \\(bloomShare\\(bloomScene\\) \\* bloomStrength \\* ${BLOOM_LEVELS}\\.0\\)`));
  assert.equal(post.composite.fragmentShader.split("uniform vec4 threshold;").length - 1, 1);
  // Glare at half strength within ~5 degrees of the disc, a tenth by 10: no quarter-sky halo.
  const glare = (degrees) => Math.pow(Math.cos(degrees * Math.PI / 180), CINEMATIC_TUNING.glareExponent);
  assert.ok(glare(5) > 0.4 && glare(5) < 0.6, `glare at 5 deg ${glare(5)}`);
  assert.ok(glare(10) < 0.1, `glare at 10 deg ${glare(10)}`);
  assert.ok(CINEMATIC_TUNING.glare + CINEMATIC_TUNING.glareGolden <= 0.35);
  assert.ok(CINEMATIC_TUNING.sunDisc <= 8);
  // The shoulder keeps hue: one curve on the brightest channel scales all three.
  assert.match(post.composite.fragmentShader, /colour \*= cinematicShoulder\(peak\) \/ max\(peak, 1e-6\);/);
  assert.doesNotMatch(post.composite.fragmentShader, /cinematicShoulder\(colour\.g\)/);
  assert.ok(FILMIC_KNEE >= 0.85, "authored whites up to sRGB ~239 pass unchanged");
  // Exposure stays a small step at noon: the lift carries the shade, not a global gain.
  const noon = cinematicGrade({ ...ELWYNN_DUSK, diffuse: { r: 1, g: 0.95, b: 0.85 }, sunElevation: 0.95, storm: 0, underwater: false });
  assert.ok(noon.exposure > 1 && noon.exposure <= 1.035, `noon exposure ${noon.exposure}`);
});

test("enhanced world light never exceeds the authored headroom; the gamma step is untouched", () => {
  // Rim, fixture and immersive light all fill toward one; pow(wowLight, 2.2) stays as it was.
  assert.match(WORLD_LIGHT_BODY, /wowImmersiveLight \/ max\( wowImmersivePeak, 1\.0 \)/);
  assert.match(WORLD_LIGHT_BODY, /1\.0 - 0\.75 \* smoothstep\( 0\.7, 1\.0, wowAuthoredPeak \)/,
    "sunlit surfaces keep (almost) their authored light; the lift goes to the shade");
  assert.match(WORLD_LIGHT_BODY, /wowLight = min\( wowLight, vec3\( 1\.0 \) \);\n\}\nreflectedLight\.directDiffuse/);
  assert.match(WORLD_LIGHT_BODY, /reflectedLight\.directDiffuse = diffuseColor\.rgb \* pow\( wowLight, vec3\( 2\.2 \) \);/);
  assert.doesNotMatch(WORLD_LIGHT_BODY, /vec3\( 1\.15 \)/);
});

test("every uniform a post pass reads is declared in that pass", () => {
  // The passes share one uniforms object, so a name resolves in JS whether or not the shader that
  // uses it declares it; only the GLSL compiler notices, and a pass that fails to compile is a
  // white frame. Reading `shaftMarch.w` in the composite without declaring it was exactly that.
  const post = new CinematicPost();
  const names = Object.keys(post.uniforms);
  for (const material of post.materials) {
    const code = material.fragmentShader.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
    for (const name of names) {
      const swizzled = new RegExp(`\\b${name}\\.[xyzwrgb]`).test(code);
      const camel = /[A-Z]/.test(name) && new RegExp(`\\b${name}\\b`).test(code);
      if (!swizzled && !camel) continue;
      assert.match(code, new RegExp(`uniform (highp )?\\w+ ${name};`), `${name} is read but not declared`);
    }
  }
});
