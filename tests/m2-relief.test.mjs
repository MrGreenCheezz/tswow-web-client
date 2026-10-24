// 23.10 (7.47 stage 3): «Объём предметов» — the buildings' relief on the world's M2 doodads: the
// eligibility rule (opaque, lit, one plain texture, no environment map, no UV animation), the shared
// program (the buildings' text unchanged), the build-time key with the map through a uniform, the
// copies a placement makes, the gating and the settings wiring.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { EVERY_GEOSET, buildModel } from "../dist/code/browser/ModelBuild.js";
import {
  M2_RELIEF_BUILD, M2_RELIEF_BUILD_PREFIX, M2_RELIEF_DEPTH_MAX, M2_RELIEF_DEPTH_UV, M2_RELIEF_MARKER,
  installM2ReliefShape, installM2ReliefSun, m2BatchReliefRejection, m2ReliefActive, m2ReliefDrawing,
  m2ReliefMapKey, m2ReliefMapReady, m2ReliefMaps, m2ReliefStats, prepareM2ReliefTexture,
} from "../dist/code/browser/M2Relief.js";
import { RELIEF_SUN_MARKER, setReliefClock } from "../dist/code/browser/ReliefShader.js";
import { RELIEF_STRENGTH_TAG } from "../dist/code/browser/ReliefStrength.js"; // 24.10 (7.47)
import { injectWmoRelief } from "../dist/code/browser/WmoReliefShader.js";
import { WMO_RELIEF_FLAT, WmoReliefMaps } from "../dist/code/browser/WmoReliefMaps.js";
import { applyWorldLight, cloneMaterialForPortrait, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import {
  createModelPlacementLocalLightMaterials, createModelPlacementTintMaterials,
} from "../dist/code/browser/ModelPlacementTint.js";
import {
  BLEND_ADD, BLEND_ALPHA, BLEND_ALPHA_KEY, BLEND_OPAQUE, MATERIAL_BILLBOARD, MATERIAL_TWO_SIDED, MATERIAL_UNLIT,
  TEXTURE_WRAP_X, TEXTURE_WRAP_Y, decodeWvm9,
} from "../dist/code/browser/Wvm.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const source = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");

// The doodad maps of this test file come from here: no worker, no fetch.
const answers = new Map();
const derived = [];
m2ReliefMaps(new WmoReliefMaps(async (key) => {
  derived.push(key);
  const answer = answers.get(key);
  if (answer instanceof Error) throw answer;
  return answer ?? { side: 0, contrast: 0 };
}, 4, prepareM2ReliefTexture));
let now = 1000;
setReliefClock(() => now);
const settle = async () => { for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// ---- the rule ------------------------------------------------------------------------------------

const MODEL = {
  textures: [
    { type: 0, flags: TEXTURE_WRAP_X | TEXTURE_WRAP_Y, path: "World\\Rocks\\Rock01.blp" },
    { type: 11, flags: 0, path: "" },
    { type: 0, flags: 0, path: "World\\Generic\\Env.blp" },
  ],
  textureTransforms: [{ translation: {}, rotation: {}, scaling: {} }],
  shaderIdsResolved: true,
};
const BATCH = {
  blendMode: BLEND_OPAQUE, materialFlags: 0, textures: [0], uvSets: [0], shaderId: 0x10, textureTransform: -1,
};

test("rule: an opaque, lit batch with one plain self-named texture on UV set 0 may take relief", () => {
  assert.equal(m2BatchReliefRejection(MODEL, BATCH), undefined);
  assert.equal(m2BatchReliefRejection(MODEL, { ...BATCH, shaderId: 0x00 }), undefined, "Opaque");
  assert.equal(m2BatchReliefRejection(MODEL, { ...BATCH, materialFlags: MATERIAL_TWO_SIDED }), undefined, "two-sided is fine");
  // An artifact of the older generation has no resolved ids to read.
  assert.equal(m2BatchReliefRejection({ ...MODEL, shaderIdsResolved: undefined }, { ...BATCH, shaderId: 0x8001 }), undefined);
});

test("rule: foliage cards, blended and additive batches, unlit, billboards, env maps, layers and moving UVs are refused", () => {
  for (const [label, batch, reason] of [
    ["alpha-keyed (leaves, grass, atlases of a trunk and its leaves)", { ...BATCH, blendMode: BLEND_ALPHA_KEY }, "blend"],
    ["alpha-blended", { ...BATCH, blendMode: BLEND_ALPHA }, "blend"],
    ["additive (effects)", { ...BATCH, blendMode: BLEND_ADD }, "blend"],
    ["unlit (emissive)", { ...BATCH, materialFlags: MATERIAL_UNLIT }, "unlit"],
    ["billboard", { ...BATCH, materialFlags: MATERIAL_BILLBOARD }, "billboard"],
    ["a slot the client fills (skins)", { ...BATCH, textures: [1] }, "slot"],
    ["no texture", { ...BATCH, textures: [-1] }, "slot"],
    ["UV set 1", { ...BATCH, uvSets: [1] }, "uv-set"],
    ["a second texture stage (metal's environment map)", { ...BATCH, textures: [0, 2], uvSets: [0, 0], shaderId: 0x0b }, "layers"],
    ["a sphere-mapped first stage", { ...BATCH, shaderId: 0x90 }, "combiner"],
    ["a Mod2x first stage", { ...BATCH, shaderId: 0x40 }, "combiner"],
    ["a 0x8000 special id", { ...BATCH, shaderId: 0x8001 }, "combiner"],
    ["a texture transform (flowing, scrolling)", { ...BATCH, textureTransform: 0 }, "uv-animated"],
  ]) {
    assert.equal(m2BatchReliefRejection(MODEL, batch), reason, label);
  }
});

test("gating: enhanced levels only — never lighting quality 0 or the comparison level 3", () => {
  assert.equal(m2ReliefActive(true, 0), false);
  assert.equal(m2ReliefActive(true, 3), false);
  assert.equal(m2ReliefActive(true, 1), true);
  assert.equal(m2ReliefActive(true, 2), true);
  assert.equal(m2ReliefActive(false, 2), false);
});

test("depth: three quarters of the buildings' share of a repeat, at most 6 cm", () => {
  assert.equal(M2_RELIEF_DEPTH_UV, 0.015);
  assert.equal(M2_RELIEF_DEPTH_MAX, 0.06);
});

// ---- the shared program --------------------------------------------------------------------------

function libShader(lib, withSun = false) {
  return {
    uniforms: {}, vertexShader: lib.vertexShader,
    fragmentShader: withSun
      ? lib.fragmentShader.replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${RELIEF_SUN_MARKER}`)
      : lib.fragmentShader,
  };
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

test("program: the buildings' relief program is the stage-2 text to the byte after the move to ReliefShader.ts", () => {
  const lit = libShader(THREE.ShaderLib.standard, true);
  injectWmoRelief(lit, "lit");
  const room = libShader(THREE.ShaderLib.basic);
  injectWmoRelief(room, "room");
  // Hashes of `injectWmoRelief`'s output at 1dc29c0, before the move. 24.10 (7.47): «Сила объёма»'s
  // tagged lines and gain tokens stripped (tests/relief-strength.test.mjs pins that strip for all four programs).
  const strip = (text) => text.split("\n").filter((line) => !line.endsWith(RELIEF_STRENGTH_TAG)).join("\n")
    .replace(/ \* relief[A-Za-z]+Gain(\( [^()]* \))?/g, "");
  assert.equal(sha(strip(lit.fragmentShader)), "1f5528782644610f6034a4cbab28a02c7c15ce77fdeb88b6ae82b52481019c3a");
  assert.equal(sha(lit.vertexShader), "8a346fc18ae1d80265e8b847372ef70fe90651af4e1b72151cd8edaa71f721fb");
  assert.equal(sha(strip(room.fragmentShader)), "03889732631cd54ee5ec602a63aee8af4bf80eb0194e83e600e1ed5fc12d320f");
  assert.equal(sha(room.vertexShader), "323b826557acb983d2bd2c46e2d6649a81aed3689993e2e505752ce445e490f4");
});

function compile(material) {
  const lib = material instanceof THREE.MeshBasicMaterial ? THREE.ShaderLib.basic : THREE.ShaderLib.standard;
  const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return shader;
}

function quad(batchOverrides = {}, textureFlags = TEXTURE_WRAP_X | TEXTURE_WRAP_Y, path = "World\\Rocks\\Rock01.blp") {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 2, 0, 1, 2]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv0: Float32Array.from([0, 0, 1, 0, 0, 1]),
    uv1: new Float32Array(6),
    indices: Uint16Array.from([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [{
      submesh: 0, blendMode: BLEND_OPAQUE, materialFlags: 0, priorityPlane: 0, materialLayer: 0,
      textures: [0], uvSets: [0], shaderId: 0x10, colorIndex: 0xffff, textureWeight: -1, textureTransform: -1,
      ...batchOverrides,
    }],
    textures: [{ type: 0, flags: textureFlags, path }],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 2], radius: 2 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [], textureTransforms: [],
    shaderIdsResolved: true,
  };
}

function build(model, relief) {
  return buildModel(model, {
    modelPath: "World\\Rocks\\Rock01.m2", baseUrl: "http://gateway", geosets: EVERY_GEOSET,
    loadTexture: () => new THREE.Texture(), worldLight: createWorldLightUniforms(),
    ...(relief ? { relief: M2_RELIEF_BUILD } : {}),
  });
}

test("build: off (no relief option) is the exact program and key — the faithful and comparison profiles", () => {
  const off = build(quad()).materials[0];
  const again = build(quad()).materials[0];
  assert.equal(m2ReliefDrawing(off), false);
  assert.doesNotMatch(off.customProgramCacheKey(), /m2-relief/);
  assert.equal(off.customProgramCacheKey(), again.customProgramCacheKey());
  assert.equal(compile(off).fragmentShader, compile(again).fragmentShader);
  assert.doesNotMatch(compile(off).fragmentShader, /wmoRelief/);
  off.dispose();
  again.dispose();
});

test("build: its own versioned key at build time — shape in the chain, sun after the world light; the map arrives through a uniform", async () => {
  const url = "http://gateway/texture?path=World%5CRocks%5CRock01.blp";
  let release;
  answers.set(url, new Promise((resolve) => { release = resolve; }).then(() => ({ relief: new Uint8Array(4 * 4 * 4).fill(200), side: 4, contrast: 0.1 })));
  const offKey = build(quad()).materials[0].customProgramCacheKey();
  const material = build(quad(), true).materials[0];
  assert.equal(M2_RELIEF_MARKER, "m2-relief-v1");
  assert.equal(m2ReliefDrawing(material), true);
  const key = material.customProgramCacheKey();
  assert.match(key, /\|m2-relief-v1\|.*\|m2-relief-v1:sun$/, "shape before the world light's key, sun after it");
  assert.notEqual(key, offKey);
  const shader = compile(material);
  const fragment = shader.fragmentShader;
  assert.match(fragment, /m2-relief-v1: \(22\.10, 7\.47 stage 2\) the cotangent frame/);
  assert.match(fragment, /vec4 sampledDiffuseColor = textureGrad\( map, wmoReliefUv, wmoReliefGx, wmoReliefGy \);/);
  assert.match(fragment, /wmoReliefDepth = min\( 0\.0150 \/ max\( max\( length\( wmoReliefGu \), length\( wmoReliefGv \) \), 1e-6 \), 0\.0600 \);/);
  // 23.10 (7.47 stage 3): a magnified doodad texture keeps a neighbourhood the span wide in texels of the map.
  assert.ok(fragment.includes("float wmoAroundFloor = 16.0000 / float( textureSize( wmoRelief, 0 ).x );"));
  assert.ok(fragment.includes("vec4 wmoReliefAround = textureGrad( wmoRelief, wmoReliefUv, wmoAroundGx, wmoAroundGy );"));
  // 23.10 (7.47 stage 3): the factors scale the neighbourhood's mean colour (the base map's mip), added to
  // the texel — a factor on the texel itself lifted the stills' mean by 2–3 %.
  assert.ok(fragment.includes("wmoReliefMean = diffuse * textureGrad( map, wmoReliefUv, wmoAroundGx, wmoAroundGy ).rgb;"));
  assert.ok(fragment.includes("diffuseColor.rgb = max( diffuseColor.rgb + ( wmoReliefShape - 1.0 ) * wmoReliefMean, diffuseColor.rgb * min( wmoReliefShape, 1.0 ) );"),
    "never darker than the factor on the texel (no black holes)");
  assert.ok(fragment.includes("1.0 - 0.4500 * reliefShadowGain( 0.4500 ) * wmoReliefFade * clamp( wmoOccluded * 6.0, 0.0, 1.0 )"),
    "a softer self-shadow than the buildings' (24.10, 7.47: times «Сила объёма»'s gain)");
  assert.doesNotMatch(fragment, /diffuseColor\.rgb \*= wmoReliefCavity/);
  const sun = fragment.indexOf("diffuseColor.rgb = max( diffuseColor.rgb + ( wmoReliefSunFactor - 1.0 ) * wmoReliefMean,");
  assert.ok(sun > 0 && sun < fragment.indexOf("vec3 wowAuthoredLight ="), "the relief's sun before the sun term");
  assert.equal(shader.uniforms.wmoRelief.value, WMO_RELIEF_FLAT, "the flat stand-in until the map arrives");
  assert.equal(shader.uniforms.wmoReliefOn.value, 0);
  assert.equal(derived.at(-1), url, "derived from the URL the texture loads from (wrapping: no clamp suffix)");
  const version = material.version;
  release();
  await settle();
  assert.equal(m2ReliefMapReady(material), true);
  assert.equal(shader.uniforms.wmoRelief.value.image.width, 4);
  assert.equal(shader.uniforms.wmoReliefOn.value, 0, "fades in");
  now += 1000;
  assert.equal(shader.uniforms.wmoReliefOn.value, 1);
  assert.equal(material.version, version, "no needsUpdate when the map arrives");
  assert.equal(material.customProgramCacheKey(), key, "and no new key");
  assert.equal(m2ReliefStats().withMap >= 1, true);
  material.dispose();
});

test("build: refused batches and units' options take nothing; a clamped texture's map clamps", async () => {
  const keyed = build(quad({ blendMode: BLEND_ALPHA_KEY }), true).materials[0];
  assert.equal(m2ReliefDrawing(keyed), false);
  assert.doesNotMatch(keyed.customProgramCacheKey(), /m2-relief/);
  const unlit = build(quad({ materialFlags: MATERIAL_UNLIT }), true).materials[0];
  assert.equal(m2ReliefDrawing(unlit), false);
  const clampedUrl = "http://gateway/texture?path=World%5CBarrel%5CBarrel.blp";
  answers.set(`${clampedUrl}#clamp`, { relief: new Uint8Array(16).fill(100), side: 2, contrast: 0.1 });
  assert.equal(m2ReliefMapKey(clampedUrl, 0), `${clampedUrl}#clamp`);
  assert.equal(m2ReliefMapKey(clampedUrl, TEXTURE_WRAP_X), `${clampedUrl}#clamp`);
  assert.equal(m2ReliefMapKey(clampedUrl, TEXTURE_WRAP_X | TEXTURE_WRAP_Y), clampedUrl);
  const barrel = build(quad({}, 0, "World\\Barrel\\Barrel.blp"), true).materials[0];
  assert.equal(derived.at(-1), `${clampedUrl}#clamp`);
  await settle();
  const map = compile(barrel).uniforms.wmoRelief.value;
  assert.notEqual(map, WMO_RELIEF_FLAT);
  assert.equal(map.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(map.wrapT, THREE.ClampToEdgeWrapping);
  for (const material of [keyed, unlit, barrel]) material.dispose();
});

test("copies: a tinted placement keeps the whole relief; a locally lit indoor copy keeps the shape and drops the sun", () => {
  const material = build(quad(), true).materials[0];
  const [tinted] = createModelPlacementTintMaterials([material], [128, 200, 64, 255]);
  const tintedShader = compile(tinted);
  assert.match(tinted.customProgramCacheKey(), /m2-relief-v1:sun/);
  assert.match(tintedShader.fragmentShader, /wmoReliefSun/);
  assert.equal(tintedShader.uniforms.wmoRelief, compile(material).uniforms.wmoRelief, "one map uniform shared by the copies");
  const [indoor] = createModelPlacementLocalLightMaterials([material], [120, 100, 80, 255]);
  const indoorShader = compile(indoor);
  assert.match(indoor.customProgramCacheKey(), /m2-relief-v1/);
  assert.doesNotMatch(indoor.customProgramCacheKey(), /m2-relief-v1:sun/);
  assert.ok(indoorShader.fragmentShader.includes("( wmoReliefShape - 1.0 ) * wmoReliefMean"));
  assert.doesNotMatch(indoorShader.fragmentShader, /wmoReliefSun/);
  const portrait = cloneMaterialForPortrait(material);
  assert.doesNotMatch(portrait.customProgramCacheKey(), /:sun/);
  for (const value of [material, tinted, indoor, portrait]) value.dispose();
});

test("install: once per material; the sun only over a shape; release with the material", async () => {
  const url = "http://gateway/texture?path=once.blp";
  answers.set(url, { relief: new Uint8Array(16).fill(1), side: 2, contrast: 0.1 });
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  assert.equal(installM2ReliefSun(material), false, "no shape, no sun");
  assert.equal(installM2ReliefShape(material, url, TEXTURE_WRAP_X | TEXTURE_WRAP_Y), true);
  assert.equal(installM2ReliefShape(material, url, TEXTURE_WRAP_X | TEXTURE_WRAP_Y), false);
  applyWorldLight(material, createWorldLightUniforms(), "surface");
  assert.equal(installM2ReliefSun(material), true);
  assert.equal(installM2ReliefSun(material), false);
  await settle();
  const before = m2ReliefStats();
  material.dispose();
  const after = m2ReliefStats();
  assert.equal(after.drawing, before.drawing - 1);
  assert.equal(after.retained >= 1, true, "the released map is retained for a comeback");
});

// ---- real data (the bench cache), skipped without it ---------------------------------------------

const CACHE = new URL("../bench/cache/", import.meta.url);
const index = await readFile(new URL("index.json", CACHE), "utf8").then(JSON.parse).catch(() => undefined);
async function cachedModel(path) {
  const key = Object.keys(index ?? {}).find((entry) => entry.toLowerCase() === `/visual/model?path=${encodeURIComponent(path)}&v=3`.toLowerCase());
  if (!key) return undefined;
  const bytes = await readFile(new URL(index[key].sha256, CACHE));
  return decodeWvm9(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

test("data: an Elwynn tree's trunk takes relief and its canopy does not; a Durotar rock does", async (context) => {
  const tree = await cachedModel("WORLD\\AZEROTH\\ELWYNN\\PASSIVEDOODADS\\TREES\\ELWYNNTREEMID01.M2");
  const rock = await cachedModel("WORLD\\KALIMDOR\\DUROTAR\\PASSIVEDOODADS\\ROCKS\\DUROTARROCK04.M2");
  if (!tree || !rock) {
    context.skip("the bench cache has no Elwynn tree or Durotar rock (bench/cache)");
    return;
  }
  const verdicts = tree.batches.map((batch) => [tree.textures[batch.textures[0]]?.path ?? "", m2BatchReliefRejection(tree, batch)]);
  assert.ok(verdicts.some(([path, reason]) => /TallComp/i.test(path) && reason === undefined), JSON.stringify(verdicts));
  assert.ok(verdicts.some(([path, reason]) => /Canopy/i.test(path) && reason === "blend"), JSON.stringify(verdicts));
  assert.ok(rock.batches.every((batch) => m2BatchReliefRejection(rock, batch) === undefined));
});

// ---- settings and wiring -------------------------------------------------------------------------

test("setting: «Объём предметов» after «Объём зданий», on in the enhanced preset, off in the comparison profile and the formal bench", async () => {
  const definition = settingDefinition("experimentalModelRelief");
  assert.equal(definition?.label, "Объём предметов");
  assert.equal(definition?.kind, "boolean");
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalModelRelief, true);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalModelRelief, false);
  const section = SETTING_SECTIONS["Эффекты"]?.find((entry) => entry.title === "Тени и рельеф");
  assert.equal(section.ids.indexOf("experimentalModelRelief"), section.ids.indexOf("experimentalWmoRelief") + 1);
  assert.equal(RENDER_WORKER_COMMANDS.setM2Relief, "setting");
  for (const file of ["ui/Settings.ts", "RendererGraphicsSettings.ts"]) {
    assert.match(await source(file), /setM2Relief\?\.\(settingBoolean\(values, "experimentalModelRelief"\)\)/, file);
  }
  assert.match(await source("FormalRenderBenchmarkConsole.ts"), /base\.experimentalModelRelief = false;/);
  assert.match(await source("ClientRenderer.ts"), /"setM2Relief"/);
});

test("renderer: the leaf and the lighting level decide; placed doodads build and instance under one key; ground cover never", async () => {
  const renderer = await source("WorldRenderer3D.ts");
  assert.match(renderer, /const active = m2ReliefActive\(this\.#m2ReliefSetting, this\.#lightingProfile\.quality\);/);
  assert.match(renderer, /this\.#syncM2Relief\(\); \/\/ 23\.10 \(7\.47 stage 3\)/, "re-decided on a lighting change");
  assert.match(renderer, /this\.#m2ReliefActive = active;\s*this\.#rebuildSceneryModels\(\);/);
  assert.match(renderer, /return this\.#m2ReliefActive \? `\$\{M2_RELIEF_BUILD_PREFIX\}\$\{key\}` : key;/);
  assert.equal(M2_RELIEF_BUILD_PREFIX, "m2-relief|");
  assert.match(renderer, /const buildKey = this\.#doodadBuildKey\(name\);/);
  assert.match(renderer, /this\.#experimentalShaderProfile\.vegetationWind, undefined, this\.#m2ReliefBuild\(\),/);
  assert.match(renderer, /const instanceKey = this\.#doodadBuildKey\(object\.name\);/);
  assert.match(renderer, /const buildKey = "ground-cover\|" \+ this\.#vegetationBuildKey\(path\);/);
  assert.equal((renderer.match(/this\.#m2ReliefBuild\(\)/g) ?? []).length, 1, "the scenery build alone asks for it");
});

test("25.10 (perf): a relief switch whose fade has finished stops reading the clock", async () => {
  const { ReliefSwitch } = await import("../dist/code/browser/ReliefShader.js");
  let reads = 0;
  let clock = 5000;
  setReliefClock(() => { reads++; return clock; });
  try {
    const fading = new ReliefSwitch();
    assert.equal(fading.value, 0, "no map yet");
    fading.arrive(true);
    clock += 150;
    assert.ok(fading.value > 0.4 && fading.value < 0.6, "half way through the fade");
    clock += 300;
    assert.equal(fading.value, 1);
    reads = 0;
    for (let draw = 0; draw < 100; draw++) assert.equal(fading.value, 1);
    assert.equal(reads, 0, "three's per-draw reads of a settled switch never reach the clock");
    const atOnce = new ReliefSwitch();
    atOnce.arrive(false);
    assert.equal(atOnce.value, 1);
    assert.equal(reads, 0, "a map already derived is on at once");
    atOnce.clear();
    assert.equal(atOnce.value, 0, "cleared, it is off again");
    fading.arrive(true);
    assert.equal(fading.value, 0, "a new map fades in again");
  } finally {
    setReliefClock(() => now);
  }
});
