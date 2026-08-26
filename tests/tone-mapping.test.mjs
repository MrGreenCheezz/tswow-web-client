import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as THREE from "three";

import {
  TONE_MAPPING_STUB_GLSL, TONE_SHOULDER_GLSL, lightingProfile, toneShoulder, withToneShoulder,
} from "../dist/code/browser/LightingQuality.js";

/**
 * The curve the client used to run, transcribed from three's own
 * `tonemapping_pars_fragment.glsl.js:44-73` so the two sides of every table below are asserted
 * rather than quoted. 1.08 is the exposure quality 1 — the default — carried before this slice.
 */
const PREVIOUS_EXPOSURE = 1.08;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// `colorspace_pars_fragment.glsl.js:7-13`: what three does either side of the tone-map call.
const srgbToLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : (c * 0.9478672986 + 0.0521327014) ** 2.4);
const linearToSrgb = (c) => (c < 0.0031308 ? c * 12.92 : 1.055 * c ** 0.41666 - 0.055);

const ACES_INPUT = [
  [0.59719, 0.07600, 0.02840],
  [0.35458, 0.90834, 0.13383],
  [0.04823, 0.01566, 0.83777],
];
const ACES_OUTPUT = [
  [1.60475, -0.10208, -0.00327],
  [-0.53108, 1.10813, -0.07276],
  [-0.07367, -0.00605, 1.07602],
];

/** The chunk's matrices are written as columns, which is how three transposed them from source. */
function mulColumns(m, v) {
  return [0, 1, 2].map((row) => m[0][row] * v[0] + m[1][row] * v[1] + m[2][row] * v[2]);
}

function aces(linear, exposure) {
  let colour = linear.map((x) => (x * exposure) / 0.6);
  colour = mulColumns(ACES_INPUT, colour);
  colour = colour.map((x) => {
    const a = x * (x + 0.0245786) - 0.000090537;
    const b = x * (0.983729 * x + 0.4329510) + 0.238081;
    return a / b;
  });
  return mulColumns(ACES_OUTPUT, colour).map(clamp01);
}

const toByte = (linear) => Math.round(clamp01(linearToSrgb(clamp01(linear))) * 255);
const throughAces = (rgb, exposure) => aces(rgb.map((b) => srgbToLinear(b / 255)), exposure).map(toByte);
const throughShoulder = (rgb) => rgb.map((b) => toByte(toneShoulder(srgbToLinear(b / 255))));

/**
 * Stormwind at noon, the five bands `LightIntBand` hands the sky dome, top to bottom. The middle
 * one is the band the eye reads as "how blue is the sky".
 */
const STORMWIND_NOON_SKY = [[0, 31, 73], [58, 162, 207], [153, 220, 245], [175, 218, 224], [180, 180, 180]];

test("the shoulder is the identity below 0.9 and rolls off only above it", () => {
  for (let step = 0; step <= 90; step += 1) {
    const value = step / 100;
    assert.ok(Math.abs(toneShoulder(value) - value) <= 1e-6,
      `${value} must survive the shoulder unchanged, got ${toneShoulder(value)}`);
  }
  for (const value of [0.9000001, 0.95, 1, 1.5, 2, 4, 13.45, 100]) {
    assert.ok(toneShoulder(value) < value, `${value} must be pulled down, got ${toneShoulder(value)}`);
    assert.ok(toneShoulder(value) > 0.9 && toneShoulder(value) < 1,
      `${value} must land inside the shoulder, got ${toneShoulder(value)}`);
  }
  // The reference's own arithmetic at linear white: 0.9 + 0.1 * 0.1 / (0.1 + 0.1).
  assert.ok(Math.abs(toneShoulder(1) - 0.95) <= 1e-6, `linear white lands at ${toneShoulder(1)}`);
  // Monotonic, so a brighter pixel never comes out darker than a dimmer one.
  let previous = -1;
  for (let step = 0; step <= 400; step += 1) {
    const mapped = toneShoulder(step / 100);
    assert.ok(mapped > previous);
    previous = mapped;
  }
  // Exposure multiplies ahead of the curve, exactly as the GLSL does.
  assert.equal(toneShoulder(0.5, 2), toneShoulder(1));
});

test("the shoulder GLSL is the reference's own and carries none of ACES", () => {
  assert.match(TONE_SHOULDER_GLSL, /vec3 CustomToneMapping\( vec3 color \)/);
  assert.match(TONE_SHOULDER_GLSL, /color \*= toneMappingExposure;/);
  assert.match(TONE_SHOULDER_GLSL, /if \( mapped\[ i \] > 0\.9 \)/);
  assert.match(TONE_SHOULDER_GLSL, /float excess = mapped\[ i \] - 0\.9;/);
  assert.match(TONE_SHOULDER_GLSL, /mapped\[ i \] = 0\.9 \+ 0\.1 \* excess \/ \( excess \+ 0\.1 \);/);
  assert.doesNotMatch(TONE_SHOULDER_GLSL, /mat3|ACESInputMat|ACESOutputMat|RRTAndODTFit|0\.59719|1\.60475|0\.6/,
    "no matrix, no channel mixing, no 1/0.6 scale — the reference mixes nothing");
});

test("three's tone chunk takes the shoulder in place of its stub", () => {
  const stock = THREE.ShaderChunk.tonemapping_pars_fragment;
  assert.ok(stock.includes(TONE_MAPPING_STUB_GLSL),
    "three 0.185.1 still ends the chunk with the identity stub this slice replaces");
  const patched = withToneShoulder(stock);
  assert.ok(patched.includes(TONE_SHOULDER_GLSL));
  assert.ok(!patched.includes(TONE_MAPPING_STUB_GLSL), "the stub definition must be gone, not shadowed");
  assert.equal(patched.match(/vec3 CustomToneMapping\(/g).length, 1, "one definition compiles; two do not");
  assert.equal(withToneShoulder(patched), patched, "installing twice in one process is a no-op");
  // The uniform the transcription multiplies by is declared by the chunk it is spliced into.
  assert.match(patched, /uniform float toneMappingExposure;/);
});

test("every quality profile leaves exposure at 1.0", () => {
  for (const quality of [0, 1, 2]) {
    const profile = lightingProfile(quality, { shadowMaps: true, maxTextureSize: 4096 });
    assert.equal(profile.quality, quality);
    assert.equal(profile.exposure, 1, `quality ${quality} must not push into the shoulder`);
  }
  assert.equal(lightingProfile(2, { shadowMaps: false, maxTextureSize: 16384 }).exposure, 1);
});

test("Stormwind's noon sky reaches the screen as authored, which it did not under ACES", () => {
  // Measured with the transcriptions above; the ACES column is what the client drew until now.
  const underAces = [[0, 14, 62], [89, 182, 210], [188, 217, 225], [198, 216, 218], [196, 196, 196]];
  STORMWIND_NOON_SKY.forEach((band, index) => {
    assert.deepEqual(throughShoulder(band), band, `band ${index} must survive the shoulder byte for byte`);
    assert.deepEqual(throughAces(band, PREVIOUS_EXPOSURE), underAces[index], `band ${index} under ACES`);
    assert.notDeepEqual(underAces[index], band, `band ${index} was changed by ACES`);
  });
  // The middle band is the one the eye reads as "how blue is the sky": blue minus red.
  const middle = STORMWIND_NOON_SKY[2];
  const shouldered = throughShoulder(middle);
  const acesed = throughAces(middle, PREVIOUS_EXPOSURE);
  assert.equal(middle[2] - middle[0], 92);
  assert.equal(shouldered[2] - shouldered[0], 92);
  assert.equal(acesed[2] - acesed[0], 37);
});

test("a grey ramp keeps its top under the shoulder and lost it under ACES", () => {
  // The plan's table, both sides asserted: sRGB in, sRGB out, exposure 1.08.
  const ramp = [[8, 0], [16, 3], [32, 15], [48, 33], [64, 54], [96, 102], [128, 146], [160, 180],
    [192, 204], [224, 219], [255, 229]];
  for (const [input, acesByte] of ramp) {
    assert.equal(throughAces([input, input, input], PREVIOUS_EXPOSURE)[0], acesByte);
    const shouldered = throughShoulder([input, input, input])[0];
    // Linear 0.9 is sRGB 243.4, so 255 is the only sample in this ramp the shoulder touches at
    // all: it lands on linear 0.95, which encodes to 249.
    assert.equal(shouldered, input < 255 ? input : 249);
  }

  // The whole ramp rather than eleven points of it: how much of the 8-bit range each curve moves.
  const moved = (map) => {
    let count = 0;
    let worst = 0;
    for (let input = 0; input < 256; input += 1) {
      const delta = Math.abs(map(input) - input);
      if (delta > 0) count += 1;
      worst = Math.max(worst, delta);
    }
    return { count, worst };
  };
  assert.deepEqual(moved((b) => throughAces([b, b, b], PREVIOUS_EXPOSURE)[0]), { count: 251, worst: 26 });
  assert.deepEqual(moved((b) => throughShoulder([b, b, b])[0]), { count: 9, worst: 6 },
    "nine of the twelve levels that lie above the knee — see the test below for the other three");
});

test("the shoulder moves nine of the twelve levels above the knee, and a white core is all of it", () => {
  // Nine is not "the levels above the knee", and writing it that way is what the reviews caught.
  // Twelve sRGB levels have a linear value above 0.9; the first three are pulled down by less than
  // half a byte and encode back into themselves, so only nine come out changed.
  const aboveKnee = [];
  const changed = [];
  for (let byte = 0; byte < 256; byte += 1) {
    if (srgbToLinear(byte / 255) > 0.9) aboveKnee.push(byte);
    if (throughShoulder([byte, byte, byte])[0] !== byte) changed.push(byte);
  }
  assert.equal(aboveKnee.length, 12);
  assert.deepEqual(aboveKnee.slice(0, 4), [244, 245, 246, 247]);
  assert.deepEqual(changed, [247, 248, 249, 250, 251, 252, 253, 254, 255],
    "the identity holds through sRGB 246, the first three levels above the knee included");

  // Which is why "byte for byte as authored" is true of the classes of material this slice leaves
  // `toneMapped` alone on only below the knee: an additive card's white core does move.
  assert.ok(Math.abs(toneShoulder(srgbToLinear(1)) - 0.95) <= 1e-6, "sRGB 255 is linear 1.0, which lands on 0.95");
  assert.deepEqual(throughShoulder([255, 255, 255]), [249, 249, 249]);
  assert.deepEqual(throughShoulder([246, 246, 246]), [246, 246, 246]);
});

test("the knee is a linear value here and a screen value in the file it came from", () => {
  // three calls `CustomToneMapping` ahead of `colorspace_fragment`, so the 0.9 in the transcription
  // is a linear value. In the reference it would be a screen value: the swapchain is
  // `VK_FORMAT_B8G8R8A8_UNORM` (`vk_context.cpp:1026,2223`), textures load as UNORM/BC blocks
  // (`vk_texture.cpp:273,278,280`) and none of its live fragment shaders does gamma. Same constant,
  // two different knees — which is what a later slice calibrating "against the tone curve" needs.
  const screenSide = (byte) => Math.round(toneShoulder(byte / 255) * 255);
  assert.equal(toByte(0.9), 243, "linear 0.9 encodes to sRGB 243.45, so the knee starts at 244");
  assert.equal(Math.round(0.9 * 255), 230, "screen 0.9 is sRGB 230");
  assert.equal(throughShoulder([240, 240, 240])[0], 240, "sRGB 240 is linear 0.8714: below the knee");
  assert.equal(screenSide(240), 237, "the same pixel if the constant were read as the file reads it");
  assert.equal(screenSide(230), 230, "and sRGB 230 is where that file's own knee sits");
});

/** Kept apart so restoring ACES in the renderer breaks three of them rather than the first one. */
const worldRenderer = readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");

async function rendererRegions() {
  const world = await worldRenderer;
  const built = world.indexOf("constructor(canvas: HTMLCanvasElement)");
  const quality = world.indexOf("setLightingQuality(quality: number)");
  return {
    world,
    constructorBody: world.slice(built, world.indexOf("this.setLightingQuality(1);", built)),
    qualityBody: world.slice(quality, world.indexOf("#syncSun(player", quality)),
  };
}

test("the chunk is patched once, ahead of the renderer and so ahead of the first material", async () => {
  const { constructorBody } = await rendererRegions();
  assert.match(constructorBody,
    /ShaderChunk\.tonemapping_pars_fragment = withToneShoulder\(THREE\.ShaderChunk\.tonemapping_pars_fragment\)/);
  assert.ok(constructorBody.indexOf("withToneShoulder") < constructorBody.indexOf("new THREE.WebGLRenderer"),
    "patching after a program is built would leave that program on the old curve");
});

test("the renderer is built on the custom curve", async () => {
  const { constructorBody } = await rendererRegions();
  assert.match(constructorBody, /this\.#renderer\.toneMapping = THREE\.CustomToneMapping;/);
  assert.equal(THREE.CustomToneMapping, 5, "the constant the renderer is set to is three's own");
});

test("changing lighting quality keeps the curve and only re-applies the profile exposure", async () => {
  const { qualityBody } = await rendererRegions();
  assert.match(qualityBody, /this\.#renderer\.toneMapping = THREE\.CustomToneMapping;/);
  assert.match(qualityBody, /this\.#renderer\.toneMappingExposure = next\.exposure;/);
});

test("nothing in the renderer names ACES", async () => {
  const { world } = await rendererRegions();
  assert.doesNotMatch(world, /ACESFilmicToneMapping/, "a curve the original client never had");
});

test("the portraits are outside the curve, because material.toneMapped is not the only gate", async () => {
  // three takes `renderer.toneMapping` only while it is drawing into the canvas; into any other
  // render target a program compiles with `NoToneMapping` whatever the material says. The five
  // portrait views are drawn into one, so they never went through ACES and do not go through the
  // shoulder — an exception worth a test because both curves are set on the renderer they share.
  const programs = await readFile(new URL(import.meta.resolve("three/src/renderers/webgl/WebGLPrograms.js")), "utf8");
  assert.match(programs, /if \( material\.toneMapped \)\s*\{\s*if \( currentRenderTarget === null \|\| currentRenderTarget\.isXRRenderTarget === true \)/,
    "three 0.185.1 still gates the curve on the render target as well as on the material");

  const portraits = await readFile(new URL("../src/browser/PortraitRenderer.ts", import.meta.url), "utf8");
  assert.match(portraits, /PORTRAIT_SLOTS = \["player", "target", "focus", "tot", "pet"\]/);
  assert.match(portraits, /this\.#renderer\.setRenderTarget\(surface\.target\);/,
    "every slot is painted through this one call, so the gate above covers all five");

  assert.doesNotMatch(portraits, /toneMapping|toneMapped/,
    "nothing here opts back in, so the gate is the whole story for these five");
  // The consequence, in bytes: a texel the world now brings to 249 reaches a portrait untouched.
  assert.equal(throughShoulder([255, 255, 255])[0], 249);
});
