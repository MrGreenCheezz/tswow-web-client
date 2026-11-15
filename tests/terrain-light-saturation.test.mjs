// 15.11 (7.07, terrain7): the ground's light on the faithful levels saturates per channel on the authored
// Light.dbc pair, as the client's terrain vertex program does (`terrain.bls`: … `ADD c[25]` → `MIN 1`), instead
// of the whole pair scaled under one (`applyLightHeadroom`). The pair is the one Wow.exe set on a Storm Peaks
// terrain draw on the stand (`F:\WowOracle\runs\fog6-n-stormpeaks.tsv`, draw 619: c25 ambient, c26 diffuse).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  TERRAIN_CHANNEL_SATURATION, TERRAIN_SUN_TERM, injectTerrainChannelSaturation, terrainClassicLight,
} from "../dist/code/browser/TerrainLightSaturation.js";
import { applyTerrainSplat } from "../dist/code/browser/TerrainSplat.js";
import {
  WORLD_LIGHT_BODY, applyLightHeadroom, applyWorldLight, createWorldLightUniforms, setWorldLightUniforms, worldLightFactor,
} from "../dist/code/browser/WorldLighting.js";

const C25 = { r: 0.447059, g: 0.360784, b: 0.447059 };
const C26 = { r: 0.486275, g: 0.54902, b: 0.635294 };

test("7.07: the recorded pair is set unscaled (its blue sums past one), and the ground saturates per channel", () => {
  assert.ok(C25.b + C26.b > 1, "Wow.exe handed the shader a pair the headroom would have scaled");
  const uniforms = createWorldLightUniforms();
  const scaled = setWorldLightUniforms(uniforms, C25, C26);
  const peak = uniforms.wowHighSunKey.value.y;
  assert.ok(Math.abs(peak - (C25.b + C26.b)) < 1e-6);
  // Full sun: min(1, ambient + diffuse) per channel — red and green as authored, blue stops at one.
  const lit = terrainClassicLight(scaled.ambient, scaled.diffuse, 1, 1, peak);
  assert.ok(Math.abs(lit.r - (C25.r + C26.r)) < 1e-5, `red ${lit.r}`);
  assert.ok(Math.abs(lit.g - (C25.g + C26.g)) < 1e-5, `green ${lit.g}`);
  assert.equal(lit.b, 1);
  // The headroom path it replaces brought the peak channel to one and the other two down with it.
  const before = worldLightFactor(scaled.ambient, scaled.diffuse, 1, 1, 0, "terrain");
  assert.ok(Math.abs(before.b - 1) < 1e-6 && before.r < lit.r - 0.06 && before.g < lit.g - 0.06, JSON.stringify(before));
  // A slope facing away has the ambient alone, as authored; N·L is clamped at both ends.
  const shade = terrainClassicLight(scaled.ambient, scaled.diffuse, -0.4, 1, peak);
  assert.ok(Math.abs(shade.r - C25.r) < 1e-5 && Math.abs(shade.b - C25.b) < 1e-5);
  // A pair that never clipped is the same either way (peak 1).
  const soft = applyLightHeadroom({ r: 0.3, g: 0.3, b: 0.3 }, { r: 0.4, g: 0.4, b: 0.4 });
  assert.deepEqual(terrainClassicLight(soft.ambient, soft.diffuse, 0.5, 1, 1),
    worldLightFactor(soft.ambient, soft.diffuse, 0.5, 1, 0, "terrain"));
});

function terrainProgram() {
  const material = new THREE.MeshLambertMaterial({ color: 0x426b45 });
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, {
    layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1), alpha: new THREE.Texture(), index: new THREE.Texture(),
  });
  const lib = THREE.ShaderLib.lambert;
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return shader.fragmentShader;
}

test("7.07: the ground's program saturates right after the sun term, which other hooks still find once", () => {
  assert.ok(WORLD_LIGHT_BODY.includes(TERRAIN_SUN_TERM), "the world light still writes the term this follows");
  const fragment = terrainProgram();
  assert.equal(fragment.split(TERRAIN_SUN_TERM).length - 1, 1);
  assert.equal(fragment.split(TERRAIN_CHANNEL_SATURATION).length - 1, 1);
  assert.ok(fragment.includes(`${TERRAIN_SUN_TERM}\n${TERRAIN_CHANNEL_SATURATION}`));
  // Before `wowLight` takes it (the faithful levels) and after the uniform it reads is declared.
  assert.ok(fragment.indexOf(TERRAIN_CHANNEL_SATURATION) < fragment.indexOf("vec3 wowLight = wowAuthoredLight;"));
  assert.ok(fragment.indexOf("uniform vec2 wowHighSunKey;") < fragment.indexOf(TERRAIN_CHANNEL_SATURATION));
  // Only the ground: a world-lit surface that is not terrain is left as it was.
  const plain = "#define WOW_LIGHT_FOLIAGE\n" + TERRAIN_SUN_TERM;
  assert.equal(injectTerrainChannelSaturation(plain), plain);
});
