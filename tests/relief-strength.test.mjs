// 24.10 (7.47): «Сила объёма» — one slider over the three relief leaves. The setting (its range, the
// presets, the appliers and the render worker), the one uniform every relief program binds, the
// programs of before the slider recovered to the byte by stripping its lines and gain tokens (so 100 %
// is today's look), the gains' bounds, and no program key or material change when the slider moves.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  RELIEF_CAVITY_GAIN_MAX, RELIEF_DEPTH_GAIN_MAX, RELIEF_SHADOW_MAX, RELIEF_STRENGTH, RELIEF_STRENGTH_GLSL, RELIEF_STRENGTH_MAX,
  RELIEF_STRENGTH_TAG, RELIEF_TILT_CAP, TERRAIN_RELIEF_SLOPE_CAP, reliefDepthGain, reliefStrengthScale, reliefTiltLength, setReliefStrength,
} from "../dist/code/browser/ReliefStrength.js";
import { setTerrainSplatRelief } from "../dist/code/browser/TerrainReliefShader.js";
import { applyTerrainSplat, setTerrainSplatMicroNormals } from "../dist/code/browser/TerrainSplat.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { RELIEF_SUN_MARKER } from "../dist/code/browser/ReliefShader.js";
import { injectWmoRelief, setWmoReliefActive, trackWmoReliefMaterial, wmoReliefMaps } from "../dist/code/browser/WmoReliefShader.js";
import { M2_RELIEF_BUILD, m2ReliefMaps, prepareM2ReliefTexture } from "../dist/code/browser/M2Relief.js";
import { EVERY_GEOSET, buildModel } from "../dist/code/browser/ModelBuild.js";
import { WmoReliefMaps } from "../dist/code/browser/WmoReliefMaps.js";
import { BLEND_OPAQUE, TEXTURE_WRAP_X, TEXTURE_WRAP_Y } from "../dist/code/browser/Wvm.js";
import { RenderWorkerClient } from "../dist/code/browser/RenderWorkerClient.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";
import { applyRenderCommand } from "../dist/code/browser/RenderWorkerCommands.js";
import { applyRendererGraphicsSettings } from "../dist/code/browser/RendererGraphicsSettings.js";
import { enhancedGraphicsSettings } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { defaultSettings, parseSettings, settingDefinition, settingNumber } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";

const source = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");

// No worker, no fetch: every relief map request answers "no map".
const noMap = async () => ({ side: 0, contrast: 0 });
m2ReliefMaps(new WmoReliefMaps(noMap, 4, prepareM2ReliefTexture));
wmoReliefMaps(new WmoReliefMaps(noMap, 4));

// ---- the setting ---------------------------------------------------------------------------------

test("setting: «Сила объёма, %», 0–300 in steps of 25, 100 by default, next to the three leaves", () => {
  const definition = settingDefinition("reliefStrength");
  assert.ok(definition, "defined");
  assert.equal(definition.label, "Сила объёма, %");
  assert.equal(definition.group, "Эффекты");
  assert.equal(definition.kind, "number");
  assert.equal(definition.fallback, 100);
  assert.equal(definition.min, 0);
  assert.equal(definition.max, 300);
  assert.equal(definition.step, 25);
  assert.equal(defaultSettings().reliefStrength, 100, "the default is today's look");
  assert.equal(settingNumber(parseSettings('{"reliefStrength":900}'), "reliefStrength"), 300, "clamped");
  const section = SETTING_SECTIONS["Эффекты"].find((entry) => entry.title === "Тени и рельеф");
  const ids = section.ids;
  assert.equal(ids[ids.indexOf("experimentalModelRelief") + 1], "reliefStrength", "right after the third leaf");
});

test("setting: the enhanced preset keeps the player's value; the comparison profile pins 100 (its leaves are off)", () => {
  assert.equal(enhancedGraphicsSettings({ ...defaultSettings(), reliefStrength: 250 }).reliefStrength, 250);
  assert.equal(enhancedGraphicsSettings(defaultSettings()).reliefStrength, 100);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.reliefStrength, 100);
  for (const leaf of ["experimentalTerrainRelief", "experimentalWmoRelief", "experimentalModelRelief"]) {
    assert.equal(COMPARISON_GRAPHICS_OVERRIDES[leaf], false, `${leaf} off in the comparison profile`);
  }
});

test("setting: both appliers push it as a multiplier; the render worker forwards it as a setting", async () => {
  for (const [file, receiver] of [["RendererGraphicsSettings.ts", "renderer"], ["ui/Settings.ts", "game\\.renderer\\?"]]) {
    assert.match(await source(file),
      new RegExp(`${receiver}\\.setReliefStrength\\?\\.\\(settingNumber\\(values, "reliefStrength"\\) / 100\\);`), file);
  }
  assert.equal(RENDER_WORKER_COMMANDS.setReliefStrength, "setting");
  const calls = [];
  const target = new Proxy({}, { get: (_, method) => method === "then" ? undefined : (...args) => { calls.push([method, args]); } });
  const tasks = [];
  const port = { postMessage(message) {
    for (const command of structuredClone(message).commands ?? []) applyRenderCommand(target, command, () => undefined);
  } };
  const proxy = new RenderWorkerClient(port, { clientsUrl: () => "ws://127.0.0.1:8090/auth",
    steps: new Proxy({}, { get: () => () => {} }), queueTask: (run) => tasks.push(run) });
  applyRendererGraphicsSettings(proxy, { ...defaultSettings(), reliefStrength: 250 }, undefined);
  for (const task of tasks.splice(0)) task();
  assert.deepEqual(calls.filter(([method]) => method === "setReliefStrength").at(-1), ["setReliefStrength", [2.5]]);
});

test("renderer: the setter writes the shared value only — no rebuild, no re-key, nothing re-synced", async () => {
  const renderer = await source("WorldRenderer3D.ts");
  const start = renderer.indexOf("  setReliefStrength(scale: number): void {");
  assert.ok(start > 0);
  const body = renderer.slice(start, renderer.indexOf("\n  }\n", start));
  assert.match(body, /setSharedReliefStrength\(scale\);/);
  assert.doesNotMatch(body, /rebuild|sync|needsUpdate|this\.#/i);
});

test("scale: clamped to 0–3, garbage is the default", () => {
  assert.equal(reliefStrengthScale(1), 1);
  assert.equal(reliefStrengthScale(2.5), 2.5);
  assert.equal(reliefStrengthScale("2"), 2);
  assert.equal(reliefStrengthScale(9), RELIEF_STRENGTH_MAX);
  assert.equal(reliefStrengthScale(-1), 0);
  assert.equal(reliefStrengthScale(Number.NaN), 1);
  assert.equal(reliefStrengthScale(undefined), 1);
  setReliefStrength(2);
  assert.equal(RELIEF_STRENGTH.value, 2);
  setReliefStrength(1);
  assert.equal(RELIEF_STRENGTH.value, 1);
});

test("gains: 1 at 100 %; the depth at most 2× and only from well above; the tilt capped, never below its own length", () => {
  for (const e of [0, 0.2, 0.45, 1]) assert.equal(reliefDepthGain(1, e), 1);
  assert.equal(reliefDepthGain(3, 1), RELIEF_DEPTH_GAIN_MAX);
  assert.equal(reliefDepthGain(3, 0.2), 1, "a grazing view keeps today's depth");
  assert.ok(reliefDepthGain(3, 0.45) > 1 && reliefDepthGain(3, 0.45) < 2);
  assert.equal(reliefDepthGain(0.5, 0.2), 0.5, "weaker is weaker everywhere");
  for (const length of [0, 0.3, 0.7]) assert.equal(reliefTiltLength(length, RELIEF_TILT_CAP, 1), length);
  assert.ok(Math.abs(reliefTiltLength(0.2, RELIEF_TILT_CAP, 3) - 0.6) < 1e-12);
  assert.equal(reliefTiltLength(0.6, RELIEF_TILT_CAP, 3), RELIEF_TILT_CAP);
  assert.equal(reliefTiltLength(1.2, RELIEF_TILT_CAP, 3), 1.2, "a tilt already past the cap is not shortened");
  assert.equal(reliefTiltLength(0.6, RELIEF_TILT_CAP, 0.5), 0.3);
  // The caps the stills settled on (24.10): past these, 300 % gave blue rims on the ground's stone edges
  // and the statues' mean drifted ≈ 3 %.
  assert.equal(RELIEF_TILT_CAP, 0.85);
  assert.equal(TERRAIN_RELIEF_SLOPE_CAP, 0.6);
  assert.equal(RELIEF_CAVITY_GAIN_MAX, 2);
  assert.equal(RELIEF_SHADOW_MAX, 0.7);
  // The GLSL's gains are the number forms above.
  assert.ok(RELIEF_STRENGTH_GLSL.includes("#define reliefDepthGain( e ) ( reliefStrength < 1.0 ? reliefStrength : 1.0 + ( min( reliefStrength, 2.0000 ) - 1.0 ) * smoothstep( 0.3000, 0.6000, e ) )"));
  assert.ok(RELIEF_STRENGTH_GLSL.includes("#define reliefStepGain( e ) max( reliefDepthGain( e ), 1.0 )"),
    "the steps never fewer than today's (and at most 10: 5 × 2)");
  assert.ok(RELIEF_STRENGTH_GLSL.includes("#define reliefCavityGain min( reliefStrength, 2.0000 )"));
  assert.ok(RELIEF_STRENGTH_GLSL.includes("#define reliefShadowGain( s ) min( reliefStrength, 0.7000 / s )"));
  assert.ok(RELIEF_STRENGTH_GLSL.includes("float most = max( l, cap ); return l * reliefStrength > most ? tilt * ( most / l ) : tilt * reliefStrength; }"));
});

// ---- the programs --------------------------------------------------------------------------------

/** The program of before the slider: its tagged lines and its `* relief…Gain` tokens removed. */
function strip(text) {
  return text
    .split("\n").filter((line) => !line.endsWith(RELIEF_STRENGTH_TAG)).join("\n")
    .replace(/ \* relief[A-Za-z]+Gain(\( [^()]* \))?/g, "");
}

function terrainShader() {
  const material = new THREE.MeshLambertMaterial();
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, {
    layers: new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2), alpha: new THREE.Texture(), index: new THREE.Texture(),
  });
  setTerrainSplatMicroNormals(material, true);
  setTerrainSplatRelief(material, new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2), true);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  material.onBeforeCompile(shader, {});
  return { material, shader };
}

function libShader(lib, withSun = false) {
  return {
    uniforms: {}, vertexShader: lib.vertexShader,
    fragmentShader: withSun
      ? lib.fragmentShader.replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${RELIEF_SUN_MARKER}`)
      : lib.fragmentShader,
  };
}

function m2Material() {
  const model = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 2, 0, 1, 2]), normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv0: Float32Array.from([0, 0, 1, 0, 0, 1]), uv1: new Float32Array(6), indices: Uint16Array.from([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [{
      submesh: 0, blendMode: BLEND_OPAQUE, materialFlags: 0, priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0],
      shaderId: 0x10, colorIndex: 0xffff, textureWeight: -1, textureTransform: -1,
    }],
    textures: [{ type: 0, flags: TEXTURE_WRAP_X | TEXTURE_WRAP_Y, path: "World\\Rocks\\Rock01.blp" }],
    attachments: [], bounds: { min: [0, 0, 0], max: [1, 1, 2], radius: 2 }, globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [], colours: [], textureWeights: [], textureTransforms: [], shaderIdsResolved: true,
  };
  return buildModel(model, {
    modelPath: "World\\Rocks\\Rock01.m2", baseUrl: "http://gateway", geosets: EVERY_GEOSET,
    loadTexture: () => new THREE.Texture(), worldLight: createWorldLightUniforms(), relief: M2_RELIEF_BUILD,
  }).materials[0];
}

function compile(material) {
  const lib = material instanceof THREE.MeshBasicMaterial ? THREE.ShaderLib.basic : THREE.ShaderLib.standard;
  const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return shader;
}

// sha256 of each program at c7183d3, before the slider.
const BEFORE = {
  terrain: "28dd243af65b9f374b10f5c949108509ae604564fddcbef042e00a94554cdfe6",
  wmoLit: "1f5528782644610f6034a4cbab28a02c7c15ce77fdeb88b6ae82b52481019c3a",
  wmoRoom: "03889732631cd54ee5ec602a63aee8af4bf80eb0194e83e600e1ed5fc12d320f",
  m2: "78b3baefe6645c4444c86bdcd20e1dc8f32ac90452211e64c9063fac08e76c23",
};

test("programs: stripped of the slider's lines and gains, each is the program of before the slider to the byte", () => {
  const terrain = terrainShader().shader.fragmentShader;
  const lit = libShader(THREE.ShaderLib.standard, true);
  injectWmoRelief(lit, "lit");
  const room = libShader(THREE.ShaderLib.basic);
  injectWmoRelief(room, "room");
  const m2 = compile(m2Material()).fragmentShader;
  const got = { terrain: sha(strip(terrain)), wmoLit: sha(strip(lit.fragmentShader)), wmoRoom: sha(strip(room.fragmentShader)), m2: sha(strip(m2)) };
  assert.deepEqual(got, BEFORE);
  for (const [name, text] of [["terrain", terrain], ["wmoLit", lit.fragmentShader], ["wmoRoom", room.fragmentShader], ["m2", m2]]) {
    assert.equal(text.split("uniform float reliefStrength;").length - 1, 1, `${name}: the uniform once`);
    assert.match(text, / \* reliefDepthGain\( /, `${name}: the march's depth`);
    assert.match(text, / \* reliefStepGain\( /, `${name}: the march's steps`);
  }
  assert.ok(terrain.includes("  slope = reliefTilt( slope, 0.6000 );"), "terrain: the slope through the tilt");
  for (const [name, text] of [["wmoLit", lit.fragmentShader], ["wmoRoom", room.fragmentShader], ["m2", m2]]) {
    assert.ok(text.includes("    wmoReliefBump = reliefTilt( wmoReliefBump, 0.8500 );"), `${name}: the bump through the tilt`);
  }
  for (const [name, text] of [["terrain", terrain], ["wmoLit", lit.fragmentShader], ["m2", m2]]) {
    assert.match(text, / \* reliefShadowGain\( /, `${name}: the self-shadow`);
  }
  for (const [name, text] of [["wmoLit", lit.fragmentShader], ["wmoRoom", room.fragmentShader], ["m2", m2]]) {
    assert.match(text, / \* reliefCavityGain \* /, `${name}: the cavity`);
    assert.match(text, /wmoRelief(Shape|Cavity) = clamp\( wmoRelief(Shape|Cavity), 0\.4500( \/ wmoReliefSky)?, 1\.8000/, `${name}: the shading's factor held`);
  }
});

test("uniform: every relief program binds the one shared value; moving it changes no key, version or program", () => {
  try {
    const { material, shader } = terrainShader();
    assert.equal(shader.uniforms.reliefStrength, RELIEF_STRENGTH, "terrain");

    const wmo = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    trackWmoReliefMaterial(wmo, "http://gateway/visual/texture/a-0.png", "lit");
    setWmoReliefActive(true);
    const wmoShader = compile(wmo);
    assert.equal(wmoShader.uniforms.reliefStrength, RELIEF_STRENGTH, "buildings");

    const m2 = m2Material();
    const m2Shader = compile(m2);
    assert.equal(m2Shader.uniforms.reliefStrength, RELIEF_STRENGTH, "doodads");

    const before = [material, wmo, m2].map((each) => [each.version, each.customProgramCacheKey()]);
    const text = [shader, wmoShader, m2Shader].map((each) => each.fragmentShader);
    setReliefStrength(3);
    assert.deepEqual([material, wmo, m2].map((each) => [each.version, each.customProgramCacheKey()]), before);
    assert.deepEqual([terrainShader().shader, compile(wmo), compile(m2)].map((each) => each.fragmentShader).slice(1), text.slice(1));
    for (const each of [shader, wmoShader, m2Shader]) assert.equal(each.uniforms.reliefStrength.value, 3);
    setWmoReliefActive(false);
  } finally {
    setReliefStrength(1);
  }
});

test("off (faithful and comparison): no relief program, so nothing reads the slider", () => {
  const material = new THREE.MeshLambertMaterial();
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, {
    layers: new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2), alpha: new THREE.Texture(), index: new THREE.Texture(),
  });
  setTerrainSplatRelief(material, new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2), false);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  material.onBeforeCompile(shader, {});
  assert.doesNotMatch(shader.fragmentShader, /reliefStrength/);
  assert.equal("reliefStrength" in shader.uniforms, false);
});
