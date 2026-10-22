// 22.10 (7.47): «Объём земли» — relief maps derived from the ground textures (band-passed
// luminance, the `_s` mask mixed in), parallax and derived normals on the splatted ground with a
// distance fade, enhanced levels only, its own program key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  TERRAIN_RELIEF_CONTRAST_FLOOR, TERRAIN_RELIEF_DOWNSAMPLE, deriveTerrainRelief, terrainReliefHeight, terrainReliefSize,
} from "../dist/code/browser/TerrainReliefDerive.js";
import {
  TERRAIN_RELIEF_FADE_FAR, TERRAIN_RELIEF_FADE_NEAR, TERRAIN_RELIEF_MARKER, TERRAIN_RELIEF_MAX_STEPS,
  TERRAIN_RELIEF_MIN_STEPS, setTerrainReliefWanted, setTerrainSplatRelief, terrainReliefActive, terrainReliefFade,
  terrainReliefSteps, terrainReliefWanted, terrainSplatReliefDrawing,
} from "../dist/code/browser/TerrainReliefShader.js";
import { TerrainSplatClient, applyTerrainSplat, setTerrainSplatMicroNormals } from "../dist/code/browser/TerrainSplat.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { setTerrainWetness } from "../dist/code/browser/WetSurfaces.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const source = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");

// ---- the height derivation ---------------------------------------------------------------------

/** A size² RGBA texture from a luminance function of (x, y) in texels. */
function texture(size, luminance) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = Math.round(Math.min(1, Math.max(0, luminance(x, y))) * 255);
      pixels.set([value, value, value, 255], (y * size + x) * 4);
    }
  }
  return pixels;
}

/** Stones: bright disks (radius 10 texels) on a dark ground, every 32 texels. */
const stones = (contrast) => (x, y) => {
  const dx = ((x % 32) + 32) % 32 - 16;
  const dy = ((y % 32) + 32) % 32 - 16;
  return 0.4 + (Math.hypot(dx, dy) < 10 ? contrast : 0);
};

test("relief: half the layer's side; a flat texture is flat (height 128, normal straight up)", () => {
  assert.equal(TERRAIN_RELIEF_DOWNSAMPLE, 2);
  assert.equal(terrainReliefSize(256), 128);
  assert.equal(terrainReliefSize(512), 256);
  const relief = deriveTerrainRelief({ pixels: texture(64, () => 0.5), size: 64 });
  assert.equal(relief.length, 32 * 32 * 4);
  for (let texel = 0; texel < 32 * 32; texel++) {
    assert.deepEqual([...relief.subarray(texel * 4, texel * 4 + 4)], [128, 128, 128, 255], `texel ${texel}`);
  }
});

test("relief: the band-pass drops shading wider than the texture's detail (a full-width wave is not a hill)", () => {
  const size = 256;
  // Stones, and the same stones under one smooth light-dark wave across the whole (tiling) texture
  // — painted shading, not height, as strong as the stones' own contrast.
  const wave = (x) => 0.2 * Math.sin((2 * Math.PI * x) / size);
  const plain = terrainReliefHeight({ pixels: texture(size, stones(0.3)), size });
  const shaded = terrainReliefHeight({ pixels: texture(size, (x, y) => stones(0.3)(x, y) + wave(x)), size });
  const span = (list) => Math.max(...list) - Math.min(...list);
  const difference = plain.map((value, index) => shaded[index] - value);
  assert.ok(span(plain) > 0.45, `stones must become relief (span ${span(plain)})`);
  // Raw luminance would have put the whole wave (0.4 wide, more than the stones) into the height.
  assert.ok(span(difference) < 0.15, `the wave must stay out of the height (span ${span(difference)})`);
});

test("relief: stones stand above their joints, and the normal leans away from the stone's centre", () => {
  const size = 128;
  const relief = deriveTerrainRelief({ pixels: texture(size, stones(0.3)), size });
  const side = terrainReliefSize(size);
  const at = (x, y, channel) => relief[(y * side + x) * 4 + channel];
  // Output texel (8, 8) is source (16, 16): a stone's centre; (0, 0) is a joint.
  assert.ok(at(8, 8, 2) > 170, `stone centre height ${at(8, 8, 2)}`);
  assert.ok(at(0, 0, 2) < 110, `joint height ${at(0, 0, 2)}`);
  // On the stone's right rim the height falls towards +u, so the normal tips towards +u (R > 128);
  // on its left rim towards −u. The same along v (G).
  assert.ok(at(13, 8, 0) > 140, `right rim normal ${at(13, 8, 0)}`);
  assert.ok(at(3, 8, 0) < 116, `left rim normal ${at(3, 8, 0)}`);
  assert.ok(at(8, 13, 1) > 140, `lower rim normal ${at(8, 13, 1)}`);
  assert.ok(at(8, 3, 1) < 116, `upper rim normal ${at(8, 3, 1)}`);
});

test("relief: the texture tiles — the map of a shifted texture is the shifted map", () => {
  const size = 64;
  const base = (x, y) => 0.5 + 0.25 * Math.sin(x * 0.9) * Math.cos(y * 1.3) + (((x * 7 + y * 13) % 5) / 40);
  const a = deriveTerrainRelief({ pixels: texture(size, base), size });
  const b = deriveTerrainRelief({ pixels: texture(size, (x, y) => base((x + 8) % size, y)), size });
  const side = terrainReliefSize(size);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      for (let channel = 0; channel < 3; channel++) {
        const expected = a[(y * side + ((x + 4) % side)) * 4 + channel];
        assert.ok(Math.abs(b[(y * side + x) * 4 + channel] - expected) <= 1, `texel ${x},${y}.${channel}`);
      }
    }
  }
});

test("relief: low-contrast ground gets proportionally less relief than cobbles (the contrast floor)", () => {
  assert.ok(TERRAIN_RELIEF_CONTRAST_FLOOR > 0.02 && TERRAIN_RELIEF_CONTRAST_FLOOR < 0.1);
  const size = 128;
  const span = (contrast) => {
    const height = terrainReliefHeight({ pixels: texture(size, stones(contrast)), size });
    return Math.max(...height) - Math.min(...height);
  };
  const faint = span(0.02);
  const strong = span(0.3);
  assert.ok(faint < strong * 0.5, `faint ${faint} vs strong ${strong}`);
  assert.ok(Math.abs(span(0.3) - span(0.5)) < 0.05, "above the floor contrast is normalised");
});

test("relief: the `_s` mask moves the height where luminance alone reads the wrong way", () => {
  const size = 64;
  const pixels = texture(size, stones(0.3));
  // A mask that is bright exactly where the luminance is dark (moss in the joints is not high).
  const mask = texture(size, (x, y) => 1 - stones(0.3)(x, y));
  const plain = terrainReliefHeight({ pixels, size });
  const masked = terrainReliefHeight({ pixels, size, mask });
  const centre = 8 * 32 + 8;
  assert.ok(masked[centre] < plain[centre], "an opposing mask lowers the stone");
  assert.ok(masked[centre] > 0.5, "luminance keeps the larger share");
  assert.throws(() => terrainReliefHeight({ pixels: new Uint8ClampedArray(16), size: 64 }), /RGBA texels/);
});

// ---- fade, steps, gating -----------------------------------------------------------------------

test("relief fade: full to 35 yards, none past 85, smooth and monotonic between", () => {
  assert.equal(TERRAIN_RELIEF_FADE_NEAR, 35);
  assert.equal(TERRAIN_RELIEF_FADE_FAR, 85);
  assert.equal(terrainReliefFade(0), 1);
  assert.equal(terrainReliefFade(35), 1);
  assert.equal(terrainReliefFade(85), 0);
  assert.equal(terrainReliefFade(200), 0);
  assert.ok(Math.abs(terrainReliefFade(60) - 0.5) < 1e-9);
  let previous = 1;
  for (let distance = 35; distance <= 85; distance += 2.5) {
    const fade = terrainReliefFade(distance);
    assert.ok(fade <= previous + 1e-12, `monotonic at ${distance}`);
    previous = fade;
  }
});

test("relief steps: few looking down, at most ten at a grazing view", () => {
  assert.equal(terrainReliefSteps(1), TERRAIN_RELIEF_MIN_STEPS);
  assert.equal(terrainReliefSteps(0), TERRAIN_RELIEF_MAX_STEPS);
  assert.ok(TERRAIN_RELIEF_MAX_STEPS <= 10 && TERRAIN_RELIEF_MIN_STEPS >= 4);
  for (let e = 0; e <= 1; e += 0.1) {
    assert.ok(terrainReliefSteps(e) >= TERRAIN_RELIEF_MIN_STEPS && terrainReliefSteps(e) <= TERRAIN_RELIEF_MAX_STEPS);
  }
});

test("relief gating: enhanced levels only — never lighting quality 0 or the comparison level 3", () => {
  assert.equal(terrainReliefActive(true, 0), false);
  assert.equal(terrainReliefActive(true, 3), false);
  assert.equal(terrainReliefActive(true, 1), true);
  assert.equal(terrainReliefActive(true, 2), true);
  assert.equal(terrainReliefActive(false, 2), false);
});

test("relief setting: «Объём земли», on in the enhanced preset, off in the comparison profile, pushed by both appliers", async () => {
  const definition = settingDefinition("experimentalTerrainRelief");
  assert.equal(definition?.label, "Объём земли");
  assert.equal(definition?.kind, "boolean");
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalTerrainRelief, true);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalTerrainRelief, false);
  assert.ok(SETTING_SECTIONS["Эффекты"]?.some((section) => section.title === "Тени и рельеф" && section.ids.includes("experimentalTerrainRelief")));
  assert.equal(RENDER_WORKER_COMMANDS.setTerrainRelief, "setting");
  for (const file of ["ui/Settings.ts", "RendererGraphicsSettings.ts"]) {
    assert.match(await source(file), /setTerrainRelief\?\.\(settingBoolean\(values, "experimentalTerrainRelief"\)\)/, file);
  }
  const renderer = await source("WorldRenderer3D.ts");
  // The lighting level decides with the leaf, and a level change re-decides.
  assert.match(renderer, /terrainReliefActive\(this\.#terrainReliefSetting, this\.#lightingProfile\.quality\)/);
  assert.match(renderer, /this\.#syncTerrainRelief\(\); \/\/ 22\.10 \(7\.47\): the classic levels never draw the relief/);
  assert.match(await source("FormalRenderBenchmarkConsole.ts"), /base\.experimentalTerrainRelief = false;/);
});

// ---- the program -------------------------------------------------------------------------------

function splat(layers = 2) {
  return {
    layers: new THREE.DataArrayTexture(new Uint8Array(4 * layers), 1, 1, layers),
    alpha: new THREE.Texture(),
    index: new THREE.Texture(),
  };
}

function compile(material) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  return shader;
}

function terrainMaterial() {
  const material = new THREE.MeshLambertMaterial();
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, splat());
  setTerrainSplatMicroNormals(material, true);
  return material;
}

test("relief program: off (or no relief array) wraps nothing — the exact program and key", () => {
  const baseline = terrainMaterial();
  const material = terrainMaterial();
  const relief = new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2);
  assert.equal(setTerrainSplatRelief(material, relief, false), false, "inactive: nothing to re-key");
  assert.equal(setTerrainSplatRelief(material, undefined, true), false, "no array yet: nothing to draw");
  assert.equal(material.customProgramCacheKey(), baseline.customProgramCacheKey());
  assert.equal(compile(material).fragmentShader, compile(baseline).fragmentShader);
  assert.equal(terrainSplatReliefDrawing(material), false);
});

test("relief program: its own versioned key; marches before the colour, taps with the unshifted gradients", () => {
  const material = terrainMaterial();
  const offKey = material.customProgramCacheKey();
  const offShader = compile(material);
  const relief = new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2);
  assert.equal(setTerrainSplatRelief(material, relief, true), true);
  assert.equal(material.customProgramCacheKey(), `${offKey}|${TERRAIN_RELIEF_MARKER}`);
  assert.equal(TERRAIN_RELIEF_MARKER, "terrain-relief-v1");
  const shader = compile(material);
  const fragment = shader.fragmentShader;
  assert.equal(shader.uniforms.splatRelief.value, relief);
  assert.match(fragment, /uniform sampler2DArray splatRelief;/);
  assert.ok(fragment.indexOf("precision highp sampler2DArray;") < fragment.indexOf("uniform sampler2DArray splatRelief;"));
  // Every colour tap reads at the shifted UV with the unshifted UV's gradients.
  assert.doesNotMatch(fragment, /texture\(splatLayers, vec3\(splatDetail/);
  assert.doesNotMatch(fragment, /splatLayer\(splatSlots\.r, splatDetail/);
  assert.equal(fragment.split("textureGrad(splatLayers, vec3(splatDetail,").length - 1, 4);
  // The march sits between the detail UV and the first colour tap.
  const march = fragment.indexOf("float terrainSteps");
  assert.ok(fragment.indexOf("vec2 splatDetail = vSplatUv * splatRepeat;") < march);
  assert.ok(march < fragment.indexOf("vec3 splatColour ="));
  // The fade the tests pin, in the program.
  assert.match(fragment, /smoothstep\( 35\.0000, 85\.0000, length\( vViewPosition \) \)/);
  assert.match(fragment, /for \( int terrainStep = 0; terrainStep < 10; terrainStep\+\+ \)/);
  // The derived normal goes in before the world light reads `normal`; the micro normals keep the far ground.
  assert.ok(fragment.indexOf("terrainReliefViewNormal") < fragment.indexOf("vec3 wowViewSunDirection"));
  assert.match(fragment, /terrainMicroGradient \*= 0\.08 \* terrainMicroOutlierFade \* terrainDistanceFade \* \( 1\.0 - terrainReliefFade \);/);
  // The soft self-shadow multiplies the sun term only.
  assert.ok(fragment.indexOf("wowShadow *= 1.0 -") < fragment.indexOf("vec3 wowAuthoredLight ="));
  assert.ok(fragment.indexOf("wowShadow *= 1.0 -") > fragment.indexOf("float wowShadow = 1.0;"));

  // Off again: the same wrapper, the old key and program; on and off flip the version once each.
  const wrapper = material.onBeforeCompile;
  const version = material.version;
  assert.equal(setTerrainSplatRelief(material, relief, true), false);
  assert.equal(material.version, version);
  assert.equal(setTerrainSplatRelief(material, undefined, false), true);
  assert.equal(material.onBeforeCompile, wrapper);
  assert.equal(material.customProgramCacheKey(), offKey);
  const reverted = compile(material);
  assert.equal(reverted.fragmentShader, offShader.fragmentShader);
  // three re-uses a material's cached program by key with the uniforms of the last compile: every
  // program of a bound material carries the sampler, so the relief program finds it again.
  assert.ok("splatRelief" in reverted.uniforms);
});

test("relief program: a wet-surface hook bound later still sees the relief key change", () => {
  const material = terrainMaterial();
  const relief = new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2);
  setTerrainSplatRelief(material, relief, true);
  setTerrainWetness(material, true, false);
  const onKey = material.customProgramCacheKey();
  assert.match(onKey, /terrain-relief-v1/);
  setTerrainSplatRelief(material, undefined, false);
  assert.doesNotMatch(material.customProgramCacheKey(), /terrain-relief-v1/, "the outer hook must not keep a stale key");
  assert.notEqual(material.customProgramCacheKey(), onKey);
});

// ---- the splat client --------------------------------------------------------------------------

const layerId = (value) => value.repeat(40);
const wait = async (turns = 30) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function installMocks(splats) {
  const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  const load = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const loaded = new THREE.Texture();
    queueMicrotask(() => onLoad?.(loaded));
    return loaded;
  };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const match = /^\/terrain-splat\/\d+\/(\d+)\/(\d+)$/.exec(path);
    if (match) return new Response(JSON.stringify(splats[`${match[1]}-${match[2]}`]), { status: 200 });
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width) { this.width = width; }
    getContext() {
      const side = this.width;
      return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(side * side * 4).fill(100) }) };
    }
  };
  return () => {
    Object.assign(globalThis, saved);
    THREE.TextureLoader.prototype.load = load;
  };
}

test("splat client: with the leaf wanted a tile arrives with its relief array; turned off it is released, on again re-attached", async () => {
  const restore = installMocks({ "32-32": { layers: [layerId("a"), layerId("b"), layerId("a")] } });
  const wanted = terrainReliefWanted();
  try {
    setTerrainReliefWanted(true);
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await wait();
    const loaded = client.get(1, grid);
    assert.ok(loaded?.relief instanceof THREE.DataArrayTexture, "the relief joins the tile before it is handed out");
    assert.equal(loaded.relief.image.width, 128);
    assert.equal(loaded.relief.image.depth, 3, "one relief layer per splat slot");
    assert.equal(loaded.relief.colorSpace, THREE.NoColorSpace);
    assert.equal(client.reliefBytes, 2 * 128 * 128 * 4, "derived once per layer id");

    let disposed = false;
    loaded.relief.addEventListener("dispose", () => { disposed = true; });
    setTerrainReliefWanted(false);
    assert.equal(client.get(1, grid)?.relief, undefined);
    assert.equal(disposed, true);

    setTerrainReliefWanted(true);
    client.get(1, grid);
    await wait();
    assert.ok(client.get(1, grid)?.relief instanceof THREE.DataArrayTexture, "re-attached from the cached layer maps");

    client.dispose();
    assert.equal(client.reliefBytes, 0, "released with the layers");
  } finally {
    setTerrainReliefWanted(wanted);
    restore();
  }
});

test("splat client: with the leaf off nothing is derived", async () => {
  const restore = installMocks({ "32-32": { layers: [layerId("c")] } });
  try {
    setTerrainReliefWanted(false);
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await wait();
    assert.ok(client.get(1, grid));
    assert.equal(client.get(1, grid)?.relief, undefined);
    assert.equal(client.reliefBytes, 0);
    client.dispose();
  } finally {
    restore();
  }
});

// 22.10 (7.47, owner): «слишком много острых выпуклостей» — two [1 2 1] passes after the high-pass halve the
// fine detail (a 4-texel period) against the stones' own scale (16 texels) compared with one pass.
test("the relief keeps the stones' scale and softens the fine detail under it", () => {
  const size = 256;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const luma = 0.5 + 0.1 * Math.sin((2 * Math.PI * x) / 32) + 0.1 * Math.sin((2 * Math.PI * x) / 8);
      const byte = Math.round(luma * 255);
      pixels.set([byte, byte, byte, 255], (y * size + x) * 4);
    }
  }
  const height = terrainReliefHeight({ pixels, size });
  const side = terrainReliefSize(size);
  const amplitude = (period) => {
    let re = 0;
    let im = 0;
    for (let x = 0; x < side; x++) {
      const value = height[7 * side + x] - 0.5;
      re += value * Math.cos((2 * Math.PI * x) / period);
      im += value * Math.sin((2 * Math.PI * x) / period);
    }
    return Math.hypot(re, im);
  };
  const ratio = amplitude(4) / amplitude(16);
  assert.ok(ratio < 0.3, `fine detail ${ratio.toFixed(3)} of the stones' scale`);
});
