// 22.10 (7.47 stage 2): «Объём зданий» — relief maps for building (WMO) textures, read back from their
// PNGs, derived like the ground's; parallax and derived normals on opaque, unclamped, non-window runs;
// enhanced levels only, its own program key fixed at build time, the map through a uniform.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PNG } from "pngjs";
import * as THREE from "three";

import { decodePngRgba } from "../dist/code/browser/WmoReliefPng.js";
import {
  WMO_RELIEF_INPUT_MAX, WMO_RELIEF_MIN_CONTRAST, deriveWmoRelief, wmoReliefInputFrom, wmoReliefInputSide, wmoReliefMapSide,
} from "../dist/code/browser/WmoReliefDerive.js";
import { WMO_RELIEF_FLAT, WmoReliefMaps } from "../dist/code/browser/WmoReliefMaps.js";
import {
  WMO_RELIEF_CAVITY, WMO_RELIEF_DEPTH_MAX, WMO_RELIEF_DEPTH_UV, WMO_RELIEF_LOCAL_SPAN, WMO_RELIEF_MARKER, WMO_RELIEF_NORMAL_MAX_TILT,
  WMO_RELIEF_NORMAL_STRENGTH, WMO_RELIEF_SHADOW_STRENGTH, WMO_RELIEF_SKY, WMO_RELIEF_SUN_FACING, WMO_RELIEF_SUN_GAIN,
  WMO_RELIEF_SUN_RANGE, WMO_RELIEF_WALL_TILT, injectWmoRelief, setWmoReliefActive, trackWmoReliefMaterial,
  wmoReliefActive, wmoReliefDepth, wmoReliefDrawing, wmoReliefMapReady, wmoReliefMaps, wmoReliefStats, wmoRunReliefVariant,
} from "../dist/code/browser/WmoReliefShader.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { setTerrainWetness } from "../dist/code/browser/WetSurfaces.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const source = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");

// The relief maps of this test file come from here: no worker, no fetch.
const answers = new Map();
const derived = [];
wmoReliefMaps(new WmoReliefMaps(async (url) => {
  derived.push(url);
  const answer = answers.get(url);
  if (answer instanceof Error) throw answer;
  return answer ?? { side: 0, contrast: 0 };
}));
const settle = async () => { for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// ---- reading the PNG back ----------------------------------------------------------------------

test("png: every filter and the RGBA, RGB, grey and grey+alpha families read back byte for byte", async () => {
  const width = 37;
  const height = 21;
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    // Alpha low where the colour matters: a canvas read-back would multiply it away.
    data.set([(index * 7) & 255, (index * 13) & 255, (index * 29) & 255, index % 5 === 0 ? 0 : (index * 3) & 255], index * 4);
  }
  for (const filterType of [0, 1, 2, 3, 4, -1]) {
    for (const [colorType, inputHasAlpha] of [[6, true], [2, true], [0, true], [4, true]]) {
      const png = new PNG({ width, height, colorType, inputHasAlpha, filterType });
      data.copy(png.data);
      const bytes = PNG.sync.write(png, { colorType, filterType });
      const decoded = await decodePngRgba(new Uint8Array(bytes));
      const expected = PNG.sync.read(bytes); // pngjs's own reading (RGBA)
      assert.equal(decoded.width, width);
      assert.equal(decoded.height, height);
      assert.deepEqual(Buffer.from(decoded.data), expected.data, `filter ${filterType} colour ${colorType}`);
    }
  }
  await assert.rejects(decodePngRgba(new Uint8Array([1, 2, 3])), /not a PNG/);
});

// ---- the derivation ----------------------------------------------------------------------------

function rgba(width, height, luminance, alpha = () => 255) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.round(Math.min(1, Math.max(0, luminance(x, y))) * 255);
      pixels.set([value, value, value, alpha(x, y)], (y * width + x) * 4);
    }
  }
  return pixels;
}
const bricks = (x, y) => {
  const row = Math.floor(y / 16);
  const shift = row % 2 === 0 ? 0 : 16;
  const inX = ((x + shift) % 32 + 32) % 32;
  const inY = y % 16;
  return inX < 2 || inY < 2 ? 0.25 : 0.65;
};

test("derive: the read side is the larger side rounded up to a power of two, at most 256 — the map half of it", () => {
  assert.equal(WMO_RELIEF_INPUT_MAX, 256);
  assert.equal(wmoReliefInputSide(256, 256), 256);
  assert.equal(wmoReliefInputSide(512, 512), 256);
  assert.equal(wmoReliefInputSide(1024, 2048), 256);
  assert.equal(wmoReliefInputSide(128, 128), 128);
  assert.equal(wmoReliefInputSide(256, 64), 256);
  assert.equal(wmoReliefInputSide(64, 64), 64);
  assert.equal(wmoReliefInputSide(4, 8), 16);
  assert.equal(wmoReliefMapSide(512, 512), 128, "never more than 128² (64 KiB) per texture");
  assert.equal(wmoReliefMapSide(256, 128), 128);
  assert.equal(wmoReliefMapSide(64, 64), 32);
});

test("derive: a non-square texture is box-resampled to the square, its alpha ignored", () => {
  // 64×16, the left half bright with alpha 0 (a specular mask), the right half dark.
  const input = wmoReliefInputFrom(rgba(64, 16, (x) => (x < 32 ? 0.8 : 0.2), () => 0), 64, 16);
  assert.equal(input.size, 64);
  const at = (x, y) => input.pixels[(y * 64 + x) * 4];
  assert.equal(at(10, 0), 204);
  assert.equal(at(10, 63), 204, "16 rows stretched over 64");
  assert.equal(at(50, 30), 51);
  assert.equal(input.pixels[3], 255, "alpha is not shape");
  // A 512² texture averages each 2×2 block.
  const big = wmoReliefInputFrom(rgba(512, 512, (x, y) => ((x + y) % 2 === 0 ? 1 : 0)), 512, 512);
  assert.equal(big.size, 256);
  assert.ok(Math.abs(big.pixels[0] - 127.5) <= 0.5);
});

test("derive: a flat texture answers no map; bricks answer a 128² map with the bricks above their joints", () => {
  assert.equal(WMO_RELIEF_MIN_CONTRAST, 0.02);
  const flat = deriveWmoRelief(rgba(256, 256, () => 0.5), 256, 256);
  assert.equal(flat.relief, undefined);
  assert.ok(flat.contrast < WMO_RELIEF_MIN_CONTRAST);
  // Plaster with a faint mottle (one grey step) stays flat too.
  const plaster = deriveWmoRelief(rgba(256, 256, (x, y) => 0.6 + ((x * 7 + y * 13) % 3 === 0 ? 0.004 : 0)), 256, 256);
  assert.equal(plaster.relief, undefined);
  const map = deriveWmoRelief(rgba(256, 256, bricks), 256, 256);
  assert.ok(map.relief, `bricks must get relief (contrast ${map.contrast})`);
  assert.equal(map.side, 128);
  assert.equal(map.relief.length, 128 * 128 * 4);
  const height = (x, y) => map.relief[(y * 128 + x) * 4 + 2];
  // Map texel (8, 4) is source (16, 8): a brick's middle; (0, 0) is a joint corner.
  assert.ok(height(8, 4) > height(0, 0) + 40, `brick ${height(8, 4)} over joint ${height(0, 0)}`);
});

// ---- which runs ----------------------------------------------------------------------------------

const RUN = Object.freeze({
  url: "/visual/texture/abc-0.png", blendMode: 0, materialFlags: 0, unlit: false, clamped: false, envOrComposite: false, interior: false,
});

test("eligibility: opaque, unclamped, non-window, plainly lit runs get relief; rooms get the parallax variant", () => {
  assert.equal(wmoRunReliefVariant(RUN), "lit");
  assert.equal(wmoRunReliefVariant({ ...RUN, interior: true }), "room");
  assert.equal(wmoRunReliefVariant({ ...RUN, materialFlags: 0x01 }), "lit", "F_UNLIT the client does not honour is drawn lit");
  assert.equal(wmoRunReliefVariant({ ...RUN, materialFlags: 0x04 }), "lit", "two-sided is fine");
  for (const [label, run] of [
    ["no texture", { ...RUN, url: "" }],
    ["alpha-tested", { ...RUN, blendMode: 1 }],
    ["blended", { ...RUN, blendMode: 2 }],
    ["clamped (decals, trims)", { ...RUN, clamped: true }],
    ["window 0x20", { ...RUN, materialFlags: 0x20 }],
    ["night-lit glass 0x10", { ...RUN, materialFlags: 0x10 }],
    ["drawn unlit (MOCV only)", { ...RUN, unlit: true }],
    ["environment-mapped or Composite", { ...RUN, envOrComposite: true }],
  ]) {
    assert.equal(wmoRunReliefVariant(run), undefined, label);
  }
});

test("gating: enhanced levels only — never lighting quality 0 or the comparison level 3", () => {
  assert.equal(wmoReliefActive(true, 0), false);
  assert.equal(wmoReliefActive(true, 3), false);
  assert.equal(wmoReliefActive(true, 1), true);
  assert.equal(wmoReliefActive(true, 2), true);
  assert.equal(wmoReliefActive(false, 2), false);
});

test("shading: the tuned strengths (22.10, 7.47: stage 2 read flat)", () => {
  // The height's slope at full strength (stage 2: half) under a ≈ 31° cap (stage 2: ≈ 17°).
  assert.equal(WMO_RELIEF_NORMAL_STRENGTH, 1.0);
  assert.equal(WMO_RELIEF_NORMAL_MAX_TILT, 0.6);
  assert.equal(WMO_RELIEF_SHADOW_STRENGTH, 0.6);
  // The shading's tilt on walls, the cavity and the sky (new), the relief's sun as a bounded factor.
  assert.equal(WMO_RELIEF_WALL_TILT, 0.7);
  assert.equal(WMO_RELIEF_CAVITY, 0.35);
  assert.equal(WMO_RELIEF_SKY, 0.4);
  assert.equal(WMO_RELIEF_LOCAL_SPAN, 16);
  assert.equal(WMO_RELIEF_SUN_GAIN, 1.0);
  assert.equal(WMO_RELIEF_SUN_RANGE, 0.5);
  assert.equal(WMO_RELIEF_SUN_FACING, 0.2);
});

test("depth: a fiftieth of the texture's repeat, gentler than the ground, never past 0.08 yards", () => {
  assert.equal(WMO_RELIEF_DEPTH_UV, 0.02);
  assert.equal(WMO_RELIEF_DEPTH_MAX, 0.08);
  assert.equal(wmoReliefDepth(2), 0.04);
  assert.equal(wmoReliefDepth(4), 0.08);
  assert.equal(wmoReliefDepth(12), 0.08);
});

// ---- the program ---------------------------------------------------------------------------------

function compile(material) {
  const lib = material instanceof THREE.MeshBasicMaterial ? THREE.ShaderLib.basic : THREE.ShaderLib.standard;
  const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return shader;
}

function litMaterial() {
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  applyWorldLight(material, createWorldLightUniforms(), "surface");
  return material;
}

test("program: off (inactive, or a classic level) wraps nothing — the exact program and key", () => {
  setWmoReliefActive(false);
  const baseline = litMaterial();
  const material = litMaterial();
  const key = material.customProgramCacheKey();
  const wrapper = material.onBeforeCompile;
  trackWmoReliefMaterial(material, "/visual/texture/off-0.png", "lit");
  assert.equal(material.onBeforeCompile, wrapper, "nothing wrapped while inactive");
  assert.equal(material.customProgramCacheKey(), key);
  assert.equal(compile(material).fragmentShader, compile(baseline).fragmentShader);
  assert.equal(wmoReliefDrawing(material), false);
  assert.equal(derived.includes("/visual/texture/off-0.png"), false, "nothing derived while inactive");
  material.dispose();
});

test("program: its own versioned key, set at build time; the map arrives through a uniform without a recompile", async () => {
  const url = "/visual/texture/build-0.png";
  let release;
  answers.set(url, new Promise((resolve) => { release = resolve; }).then(() => ({ relief: new Uint8Array(4 * 4 * 4).fill(200), side: 4, contrast: 0.1 })));
  setWmoReliefActive(true);
  try {
    const material = litMaterial();
    const offKey = material.customProgramCacheKey();
    const offShader = compile(material);
    trackWmoReliefMaterial(material, url, "lit");
    assert.equal(WMO_RELIEF_MARKER, "wmo-relief-v2", "22.10 (7.47): the tuned program is a new key");
    const onKey = material.customProgramCacheKey();
    assert.equal(onKey, `${offKey}|wmo-relief-v2:lit`);
    const shader = compile(material);
    assert.equal(shader.uniforms.wmoRelief.value, WMO_RELIEF_FLAT, "the 1×1 flat stand-in until the map arrives");
    assert.equal(shader.uniforms.wmoReliefOn.value, 0);
    assert.equal(wmoReliefMapReady(material), false);
    const version = material.version;
    release();
    await settle();
    assert.equal(wmoReliefMapReady(material), true);
    assert.equal(shader.uniforms.wmoRelief.value.image.width, 4);
    assert.equal(shader.uniforms.wmoReliefOn.value, 1);
    assert.equal(material.version, version, "no needsUpdate when the map arrives");
    assert.equal(material.customProgramCacheKey(), onKey, "and no new key");
    // Off again: the old key and the old program.
    assert.equal(setWmoReliefActive(false) >= 1, true);
    assert.equal(material.customProgramCacheKey(), offKey);
    assert.equal(compile(material).fragmentShader, offShader.fragmentShader);
    assert.equal(wmoReliefStats().maps, 0, "the map is released with its last material");
    material.dispose();
  } finally {
    setWmoReliefActive(false);
  }
});

test("program: marches before the colour, taps with the unshifted gradients, the ground's fade and steps", () => {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  const material = litMaterial();
  material.onBeforeCompile(shader, {});
  injectWmoRelief(shader, "lit");
  const fragment = shader.fragmentShader;
  assert.match(fragment, /uniform sampler2D wmoRelief;/);
  assert.match(shader.vertexShader, /vWmoReliefView = - mvPosition\.xyz;/);
  // The frame from the screen derivatives (cotangent frame), computed outside any branch.
  assert.match(fragment, /vec3 wmoReliefDp1 = dFdx\( - vWmoReliefView \);/);
  assert.match(fragment, /vec2 wmoReliefGx = dFdx\( vMapUv \);/);
  // The march sits before the colour tap, which reads at the shifted UV with the unshifted gradients.
  assert.ok(fragment.indexOf("float wmoSteps") < fragment.indexOf("vec4 sampledDiffuseColor"));
  assert.match(fragment, /vec4 sampledDiffuseColor = textureGrad\( map, wmoReliefUv, wmoReliefGx, wmoReliefGy \);/);
  assert.doesNotMatch(fragment, /#include <map_fragment>/);
  // The ground's fade (full to 35 yards, none past 85), ten steps at most, the 0.3 cap on the shift.
  assert.match(fragment, /smoothstep\( 35\.0000, 85\.0000, length\( vWmoReliefView \) \)/);
  assert.match(fragment, /for \( int wmoStep = 0; wmoStep < 10; wmoStep\+\+ \)/);
  assert.match(fragment, /\/ max\( wmoReliefVN, 0\.3 \) \* wmoReliefScale;/);
  assert.match(fragment, /wmoReliefFade = wmoReliefOn \*/, "the switch uniform gates it all");
  // 22.10 (7.47): the shape (tilt, cavity, sky) right after the colour tap; the relief's sun is a
  // hue-neutral factor on the colour before the sun term. `normal`, `wowDot` and `wowShadow` stay the
  // face's, so the world light's cool shade tint and rim never follow a joint (stage 2's blue joints).
  const shape = fragment.indexOf("diffuseColor.rgb *= wmoReliefCavity * wmoReliefSky;");
  assert.ok(shape > fragment.indexOf("vec4 sampledDiffuseColor"));
  assert.doesNotMatch(fragment, /normal = normalize\( normal \+ wmoReliefBump/);
  assert.doesNotMatch(fragment, /wowShadow \*=/);
  assert.match(fragment, /float wowDot = dot\( normalize\( normal \), wowViewSunDirection \);/);
  const sun = fragment.indexOf("diffuseColor.rgb *= clamp( wmoReliefSun, 0.5000, 1.5000 );");
  assert.ok(sun > fragment.indexOf("float wowShadow = 1.0;"));
  assert.ok(sun < fragment.indexOf("vec3 wowAuthoredLight ="));
  // Mean-keeping: the shading terms read the height and the slope against a mip about a stone wide.
  assert.match(fragment, /wmoReliefGx \* 16\.0000, wmoReliefGy \* 16\.0000 \)/);
  assert.match(fragment, /float wmoReliefLocal = wmoReliefTexel\.b - wmoReliefAround\.b;/);
  assert.match(fragment, /vec2 wmoReliefTilt = \( wmoReliefTexel\.rg - wmoReliefAround\.rg \) \* 2\.0;/);
  // A wall leans by its shading, up the face in world space; a face turned from the sun takes none of the relief's sun.
  assert.match(fragment, /vec3 wmoReliefUp = normalize\( \( viewMatrix \* vec4\( 0\.0, 1\.0, 0\.0, 0\.0 \) \)\.xyz \);/);
  assert.match(fragment, /clamp\( wmoReliefLocal \* 2\.0, -1\.0, 1\.0 \) \* 0\.7000/);
  assert.match(fragment, /smoothstep\( 0\.0, 0\.2000, wowDot \)/);
  // Injected once only.
  const before = shader.fragmentShader;
  injectWmoRelief(shader, "lit");
  assert.equal(shader.fragmentShader, before);
});

test("program: a room's run takes the parallax, the cavity and the sky — no sun", () => {
  const material = new THREE.MeshBasicMaterial({ map: new THREE.Texture(), vertexColors: true });
  const shader = compile(material);
  injectWmoRelief(shader, "room");
  assert.match(shader.fragmentShader, /textureGrad\( map, wmoReliefUv, wmoReliefGx, wmoReliefGy \)/);
  // 22.10 (7.47): stage 2 gave rooms the parallax alone, which read as nothing in MOCV light.
  assert.match(shader.fragmentShader, /diffuseColor\.rgb \*= wmoReliefCavity \* wmoReliefSky;/);
  assert.doesNotMatch(shader.fragmentShader, /wmoReliefSun/);
  assert.doesNotMatch(shader.fragmentShader, /wowShadow/);
});

test("program: a shader without the markers is left exactly as it was", () => {
  const shader = { uniforms: {}, vertexShader: "void main() {}", fragmentShader: "void main() {}" };
  injectWmoRelief(shader, "lit");
  assert.equal(shader.fragmentShader, "void main() {}");
  assert.equal(shader.vertexShader, "void main() {}");
});

test("program: a wet-surface hook bound later still sees the relief key change", () => {
  setWmoReliefActive(true);
  try {
    const material = litMaterial();
    trackWmoReliefMaterial(material, "/visual/texture/wet-0.png", "lit");
    setTerrainWetness(material, true, false);
    assert.match(material.customProgramCacheKey(), /wmo-relief-v2:lit/);
    setWmoReliefActive(false);
    assert.doesNotMatch(material.customProgramCacheKey(), /wmo-relief-v2/, "the outer hook must not keep a stale key");
    material.dispose();
  } finally {
    setWmoReliefActive(false);
  }
});

// ---- the maps ------------------------------------------------------------------------------------

test("maps: one per URL, shared, disposed with its last holder; a flat or failed texture keeps the stand-in", async () => {
  const calls = [];
  const maps = new WmoReliefMaps(async (url) => {
    calls.push(url);
    if (url === "flat") return { side: 0, contrast: 0.001 };
    if (url === "bad") throw new Error("404");
    return { relief: new Uint8Array(16).fill(9), side: 2, contrast: 0.2 };
  });
  const seen = [];
  const first = maps.acquire("stone", (texture) => seen.push(texture));
  const second = maps.acquire("stone", (texture) => seen.push(texture));
  maps.acquire("flat", () => assert.fail("a flat texture has no map"));
  maps.acquire("bad", () => assert.fail("a failed texture has no map"));
  await settle();
  assert.deepEqual(calls, ["stone", "flat", "bad"], "derived once per URL");
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[0].flipY, false);
  assert.equal(seen[0].wrapS, THREE.RepeatWrapping);
  assert.equal(seen[0].colorSpace, THREE.NoColorSpace);
  assert.deepEqual({ ...maps.stats }, { entries: 3, maps: 1, bytes: 16, pending: 0 });
  let disposed = false;
  seen[0].addEventListener("dispose", () => { disposed = true; });
  first();
  first();
  assert.equal(disposed, false, "still held");
  second();
  assert.equal(disposed, true);
  assert.equal(maps.stats.bytes, 0);
  // A late answer for a released URL keeps nothing.
  let late;
  const slow = new WmoReliefMaps(() => new Promise((resolve) => { late = resolve; }));
  slow.acquire("late", () => assert.fail("released before it arrived"))();
  late({ relief: new Uint8Array(16), side: 2, contrast: 0.2 });
  await settle();
  assert.equal(slow.stats.entries, 0);
  assert.equal(slow.stats.bytes, 0);
});

// ---- settings and wiring -------------------------------------------------------------------------

test("setting: «Объём зданий», its own leaf beside «Объём земли», on in the enhanced preset, off in the comparison profile", async () => {
  const definition = settingDefinition("experimentalWmoRelief");
  assert.equal(definition?.label, "Объём зданий");
  assert.equal(definition?.kind, "boolean");
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalWmoRelief, true);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalWmoRelief, false);
  const section = SETTING_SECTIONS["Эффекты"]?.find((entry) => entry.title === "Тени и рельеф");
  assert.ok(section?.ids.includes("experimentalWmoRelief"));
  assert.equal(section.ids.indexOf("experimentalWmoRelief"), section.ids.indexOf("experimentalTerrainRelief") + 1);
  assert.equal(RENDER_WORKER_COMMANDS.setWmoRelief, "setting");
  for (const file of ["ui/Settings.ts", "RendererGraphicsSettings.ts"]) {
    assert.match(await source(file), /setWmoRelief\?\.\(settingBoolean\(values, "experimentalWmoRelief"\)\)/, file);
  }
  assert.match(await source("FormalRenderBenchmarkConsole.ts"), /base\.experimentalWmoRelief = false;/);
});

test("renderer: the lighting level decides with the leaf; a run's relief is decided by parts of its key and bound after every hook", async () => {
  const renderer = await source("WorldRenderer3D.ts");
  assert.match(renderer, /setWmoReliefActive\(wmoReliefActive\(this\.#wmoReliefSetting, this\.#lightingProfile\.quality\)\)/);
  assert.match(renderer, /this\.#syncWmoRelief\(\); \/\/ 22\.10 \(7\.47 stage 2\)/);
  assert.match(renderer, /const relief = wmoRunReliefVariant\(\{\s*url, blendMode: run\.blendMode, materialFlags: run\.materialFlags, unlit: state\.unlit, clamped,/);
  const track = renderer.indexOf("trackWmoReliefMaterial(value, url, relief)");
  assert.ok(track > renderer.indexOf("trackWmoWetSurface(value);"), "after the world light and the wet hook");
  assert.ok(track < renderer.indexOf("return value;", track));
  const build = await readFile(new URL("../bench/build.mjs", import.meta.url), "utf8");
  assert.match(build, /'\/WmoRelief\.worker\.ts': 'WmoRelief\.worker\.js'/);
  assert.match(build, /'WmoRelief\.worker': 'src\/browser\/WmoRelief\.worker\.ts'/);
});
