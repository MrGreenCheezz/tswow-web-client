import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  WIND_FIELD_UNIFORM, WIND_GUST_UNIFORM, WIND_RAIN_SPEED, WindField, weatherWindTarget,
} from "../dist/code/browser/WindField.js";
import {
  VEGETATION_WIND_MAX_AMPLITUDE, WIND_FIELD_MARKER, installVegetationWind, windFieldAmplitude,
} from "../dist/code/browser/VegetationWind.js";
import {
  PRECIPITATION_LAYER_CAPACITY, PRECIPITATION_SWAY_PERIOD, PrecipitationLayer, RAIN_FAR_LAYER, RAIN_MID_LAYER,
  SNOW_MID_LAYER, advancePrecipitationOffset, advancePrecipitationPhase, enhancedWeatherParams, rainBacklight,
} from "../dist/code/browser/WeatherEnhanced.js";
import {
  WET_SURFACE_MARKER, WET_SURFACE_UNIFORMS, advanceWetness, setTerrainWetness, setWaterRainRipples,
} from "../dist/code/browser/WetSurfaces.js";
import {
  LIGHTNING_FLASH_SECONDS, LIGHTNING_MAX_GAP_SECONDS, LIGHTNING_MIN_GAP_SECONDS, Lightning, lightningEnvelope,
  lightningGap,
} from "../dist/code/browser/Lightning.js";
import { MOTE_DUST_CAPACITY, moteAmounts, moteDustPatch } from "../dist/code/browser/AmbientMotes.js";
import {
  RAIN_SPLASH_CELL, RAIN_SPLASH_GRID, RAIN_SPLASH_RADIUS, RAIN_SPLASH_REGRID_YARDS, RAIN_SPLASH_ROWS_PER_FRAME,
  RainSplashes, fillSplashHeights,
} from "../dist/code/browser/RainSplashes.js";
import {
  AtmosphereEffects, DEFAULT_ATMOSPHERE_PROFILE, applyPrecipitationHaze, atmosphereProfileActive, atmosphereQuality,
  isThunderState, normaliseAtmosphereProfile, precipitationHazeTarget,
} from "../dist/code/browser/AtmosphereEffects.js";
import { WeatherEffect } from "../dist/code/browser/WeatherEffect.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";

const ATMOSPHERE_SETTINGS = [
  "experimentalWindGusts", "experimentalRainStreaks", "experimentalRainSplashes",
  "experimentalWetSurfaces", "experimentalLightning", "experimentalAmbientMotes", "experimentalWeatherSounds",
];

test("every atmosphere leaf is a Russian-labelled effect the enhanced preset enables and comparison disables", () => {
  for (const id of ATMOSPHERE_SETTINGS) {
    const definition = settingDefinition(id);
    assert.ok(definition, id);
    assert.equal(definition.group, "Эффекты");
    assert.equal(definition.kind, "boolean");
    assert.equal(definition.fallback, false, `${id} is opt-in`);
    assert.match(definition.label, /[а-яё]/i);
    assert.equal(ENHANCED_GRAPHICS_OVERRIDES[id], true, id);
    assert.equal(COMPARISON_GRAPHICS_OVERRIDES[id], false, id);
  }
});

test("wind follows the weather: fog stillest, a calm day breezy, a thunderstorm strongest", () => {
  const fog = weatherWindTarget("fog", 1, false);
  const fine = weatherWindTarget("fine", 0, false);
  const drizzle = weatherWindTarget("rain", 0.15, false);
  const heavy = weatherWindTarget("rain", 1, false);
  const thunder = weatherWindTarget("rain", 0.3, true);
  assert.ok(fog < fine && fine < heavy && heavy <= thunder, JSON.stringify({ fog, fine, heavy, thunder }));
  assert.ok(drizzle < heavy);
  for (const value of [fog, fine, drizzle, heavy, thunder, weatherWindTarget("sand", 1, false)]) {
    assert.ok(value >= 0 && value <= 1);
  }
  // Only the server's THUNDERS state (86) is a storm.
  assert.equal(isThunderState(86), true);
  assert.equal(isThunderState(5), false);
  assert.equal(isThunderState(undefined), false);
});

test("the wind field is deterministic, bounded and leaves the vegetation mix at 0 while disabled", () => {
  const a = new WindField();
  const b = new WindField();
  for (let frame = 0; frame < 600; frame++) {
    a.update(frame / 60, 1 / 60, 0, 1);
    b.update(frame / 60, 1 / 60, 0, 1);
  }
  assert.equal(a.strength, b.strength);
  assert.equal(a.direction.x, b.direction.x);
  assert.ok(a.strength > 0.9 && a.strength <= 1);
  assert.ok(a.gust >= 0 && a.gust <= 1);
  assert.ok(Math.abs(Math.hypot(a.direction.x, a.direction.y) - 1) < 1e-9);
  assert.equal(WIND_FIELD_UNIFORM.value.w, 0, "never enabled: exact standing sway");
  a.setEnabled(true);
  a.update(10, 1 / 60, 0, 0.5);
  assert.equal(WIND_FIELD_UNIFORM.value.w, 1);
  a.setEnabled(false);
  a.reset();
  assert.equal(WIND_FIELD_UNIFORM.value.w, 0);
  assert.equal(WIND_GUST_UNIFORM.value.x, 0);
});

test("the wind-field amplitude never exceeds the standing sway's culling ceiling", () => {
  for (const height of [0.2, 0.8, 2, 6, 15, 60]) {
    const amplitude = Math.min(VEGETATION_WIND_MAX_AMPLITUDE, Math.max(0.012, height * 0.025));
    const field = windFieldAmplitude({ amplitude, height });
    assert.ok(field >= amplitude - 1e-12, `${height}: ${field} >= ${amplitude}`);
    assert.ok(field <= VEGETATION_WIND_MAX_AMPLITUDE + 1e-12, `${height}: ${field}`);
  }
  // Grass gets a visible gust amplitude instead of a centimetre.
  assert.ok(windFieldAmplitude({ amplitude: 0.02, height: 0.8 }) >= 0.07);
});

test("vegetation shaders carry the field branch, mixed out by the shared uniform", () => {
  const material = new THREE.MeshLambertMaterial();
  installVegetationWind(material, { amplitude: 0.1, frequency: 1.2, phase: 0.5, baseZ: 0, height: 4 });
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  material.onBeforeCompile(shader, undefined);
  assert.match(shader.vertexShader, new RegExp(WIND_FIELD_MARKER));
  assert.match(shader.vertexShader, /uniform vec4 uVegetationWindField;/);
  // P1-08: the amplitude is the profile uniform's x, no longer the literal 0.1.
  assert.match(shader.vertexShader, /mix\( uVegetationWindA\.x \* vegetationWindWave, vegetationWindFieldOffset\.x, vegetationWindFieldMix \)/);
  assert.equal(shader.uniforms.uVegetationWindA.value.x, 0.1);
  assert.doesNotMatch(shader.vertexShader, /transformed\.z \+=/);
  assert.equal(shader.uniforms.uVegetationWindField, WIND_FIELD_UNIFORM);
});

test("rain rides the wind at a bounded slant; a calm fine sky has none", () => {
  const out = {};
  enhancedWeatherParams("rain", 1, 0, 1, 1, out);
  assert.ok(Math.abs(out.windX - WIND_RAIN_SPEED) < 1e-9 && out.windZ === 0);
  assert.ok(out.streak > 1 && out.nearEnd > out.nearStart);
  enhancedWeatherParams("rain", 0, 1, 0, 0, out);
  assert.equal(out.windZ, 0);
  enhancedWeatherParams("snow", 0.6, 0.8, 0.5, 0.5, out);
  assert.ok(out.windX > 0 && out.windZ > 0, "snow drifts even in light wind");
  enhancedWeatherParams("fine", 1, 0, 1, 1, out);
  assert.equal(out.windX, 0);
});

test("the ground soaks faster than it dries and never leaves 0..1", () => {
  let wet = 0;
  for (let i = 0; i < 60; i++) wet = advanceWetness(wet, 1, 1);
  assert.ok(wet > 0.9 && wet <= 1);
  let dry = wet;
  for (let i = 0; i < 60; i++) dry = advanceWetness(dry, 0, 1);
  assert.ok(dry > 0.3, `still damp a minute later: ${dry}`);
  assert.equal(advanceWetness(0.5, 0.5, 5), 0.5);
  assert.equal(advanceWetness(Number.NaN, 2, 1) >= 0, true);
});

test("wet-surface and ripple hooks are strict no-ops when OFF and reversible when ON", () => {
  const terrain = new THREE.MeshLambertMaterial();
  terrain.customProgramCacheKey = () => "terrain-splat";
  const before = terrain.customProgramCacheKey();
  setTerrainWetness(terrain, false, false);
  assert.equal(terrain.customProgramCacheKey(), before, "OFF never wraps");
  setTerrainWetness(terrain, true, true);
  assert.match(terrain.customProgramCacheKey(), new RegExp(`${WET_SURFACE_MARKER}-rings$`));
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  terrain.onBeforeCompile(shader, undefined);
  assert.match(shader.fragmentShader, new RegExp(WET_SURFACE_MARKER));
  assert.match(shader.fragmentShader, /rainRipples/);
  setTerrainWetness(terrain, false, false);
  assert.equal(terrain.customProgramCacheKey(), before, "OFF again restores the exact key");
  const offShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  terrain.onBeforeCompile(offShader, undefined);
  assert.equal(offShader.fragmentShader, THREE.ShaderLib.lambert.fragmentShader);

  const water = new THREE.MeshBasicMaterial();
  const waterKey = water.customProgramCacheKey();
  setWaterRainRipples(water, false);
  assert.equal(water.customProgramCacheKey(), waterKey);
  setWaterRainRipples(water, true);
  assert.match(water.customProgramCacheKey(), /rain-ripple-v1$/);
});

test("a lightning strike flickers and fades inside its window; gaps shrink as the storm grows", () => {
  assert.equal(lightningEnvelope(-0.01), 0);
  assert.equal(lightningEnvelope(LIGHTNING_FLASH_SECONDS + 0.01), 0);
  let peak = 0;
  for (let t = 0; t <= LIGHTNING_FLASH_SECONDS; t += 0.005) peak = Math.max(peak, lightningEnvelope(t));
  assert.ok(peak > 0.8 && peak <= 1);
  assert.ok(lightningEnvelope(0.5) < lightningEnvelope(0.23));
  assert.ok(lightningGap(1, 0) >= LIGHTNING_MIN_GAP_SECONDS);
  assert.ok(lightningGap(0.05, 1) >= LIGHTNING_MAX_GAP_SECONDS);
  assert.ok(lightningGap(1, 0.5) < lightningGap(0.2, 0.5));
});

test("motes follow the moment: dust by day, fireflies at night over grass, nothing in rain or indoors", () => {
  const out = {};
  // A sunlit meadow at golden hour with a pollen patch passing.
  const base = {
    daylight: 1, meadow: 1, forest: 1, precipitation: 0, snowing: false, wind: 0.4, outdoors: true,
    sunHeight: 0.15, patch: 1,
  };
  moteAmounts(base, out);
  assert.ok(out.dust > 0.4 && out.firefly === 0 && out.leaf > 0, JSON.stringify(out));
  moteAmounts({ ...base, daylight: 0 }, out);
  assert.ok(out.firefly > 0.9 && out.dust === 0);
  moteAmounts({ ...base, daylight: 0, meadow: 0, forest: 0 }, out);
  assert.equal(out.firefly, 0, "no fireflies over bare rock");
  moteAmounts({ ...base, precipitation: 1 }, out);
  assert.equal(out.dust, 0);
  moteAmounts({ ...base, snowing: true }, out);
  assert.equal(out.leaf, 0);
  moteAmounts({ ...base, outdoors: false }, out);
  assert.equal(out.dust + out.firefly + out.leaf, 0);
});

test("pollen is occasional: a sunlit open meadow, strongest at golden hour, only while a patch passes", () => {
  const out = {};
  const meadow = {
    daylight: 1, meadow: 1, forest: 0.3, precipitation: 0, snowing: false, wind: 0.4, outdoors: true,
    sunHeight: 0.15, patch: 1,
  };
  const golden = moteAmounts(meadow, out).dust;
  const noon = moteAmounts({ ...meadow, sunHeight: 0.95 }, out).dust;
  assert.ok(golden > 0.9 && noon < golden * 0.5 && noon > 0, `${golden} ${noon}`);
  assert.equal(moteAmounts({ ...meadow, patch: 0 }, out).dust, 0, "no patch, no pollen");
  assert.equal(moteAmounts({ ...meadow, meadow: 0 }, out).dust, 0, "bare ground, a city street, a desert");
  assert.equal(moteAmounts({ ...meadow, sunHeight: -0.1 }, out).dust, 0, "after sunset");
  assert.ok(moteAmounts({ ...meadow, forest: 1 }, out).dust < golden, "deep forest shades it");
  // The patch window over ten simulated hours in several places: open about a fifth of the time,
  // in visits of tens of seconds, and most minutes see one arrive or leave.
  for (const [x, z] of [[0, 0], [-9460, 120], [-8840, -626], [1500, 4400]]) {
    let open = 0;
    let visits = 0;
    let was = false;
    let changing = 0;
    for (let t = 0; t < 36000; t++) {
      const on = moteDustPatch(t, x, z) >= 0.5;
      if (on) open++;
      if (on && !was) visits++;
      was = on;
    }
    for (let t = 0; t < 36000; t += 60) {
      const first = moteDustPatch(t, x, z) >= 0.5;
      for (let k = 1; k <= 60; k++) {
        if ((moteDustPatch(t + k, x, z) >= 0.5) !== first) { changing++; break; }
      }
    }
    const share = open / 36000;
    const visit = open / visits;
    assert.ok(share > 0.12 && share < 0.3, `open ${share}`);
    assert.ok(visit > 12 && visit < 45, `visit ${visit}s`);
    assert.ok(changing / 600 > 0.5, `minutes with a change ${changing / 600}`);
  }
  assert.ok(MOTE_DUST_CAPACITY <= 360, "a lower base density than the first version's 520");
});

test("splashes stand on the terrain, or flat at the feet on a WMO floor", () => {
  const heights = new Float32Array(RAIN_SPLASH_GRID * RAIN_SPLASH_GRID);
  const asked = [];
  // Scene (x, y, z) is WoW (x, z, -y): terrain is asked at (sceneX, -sceneZ).
  const slope = (x, y) => { asked.push([x, y]); return 50 + x * 0.1; };
  assert.equal(fillSplashHeights(heights, 100, -200, 60, slope), true);
  assert.deepEqual(asked[0], [100, 200]);
  const originX = 100 - (RAIN_SPLASH_GRID * RAIN_SPLASH_CELL) / 2;
  assert.ok(Math.abs(heights[0] - (50 + (originX + 0.5 * RAIN_SPLASH_CELL) * 0.1)) < 1e-4);
  const cliff = () => 20;
  assert.equal(fillSplashHeights(heights, 0, 0, 94, cliff), false);
  assert.ok(heights.every((value) => Math.abs(value - 94) < 1e-4));
});

test("an OFF profile creates nothing; turning leaves off releases them and restores the weather", () => {
  const scene = new THREE.Scene();
  const atmosphere = new AtmosphereEffects(scene, () => new THREE.Texture());
  assert.equal(atmosphere.setProfile(undefined), false);
  assert.equal(atmosphere.profile, DEFAULT_ATMOSPHERE_PROFILE);
  assert.equal(scene.children.length, 0);

  const weather = new WeatherEffect(() => new THREE.Texture());
  const faithful = weather.object.material;
  weather.set({ kind: "rain", density: 1, storm: 1 }, false);
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 800);
  const frame = {
    camera, feet: new THREE.Vector3(), heightAt: () => 0, seconds: 1, elapsed: 1 / 60, map: 0,
    weather, fade: { kind: "rain", density: 1, storm: 1 }, thunder: true, indoors: false,
    underwater: false, sunDirection: new THREE.Vector3(0, 1, 0), sunColour: new THREE.Color(1, 1, 1),
    ambient: new THREE.Color(0.4, 0.4, 0.4), daylight: 1, skyColour: new THREE.Color(0.5, 0.6, 0.7),
    pixelScale: 600, quality: 1, meadow: 1, forest: 1,
  };
  atmosphere.setProfile({
    windGusts: true, rainStreaks: true, rainSplashes: true, wetSurfaces: true, lightning: true, ambientMotes: true,
  });
  atmosphere.update(frame);
  assert.notEqual(weather.object.material, faithful, "rain draws with the enhanced material");
  assert.ok(scene.children.length >= 3);
  assert.ok(atmosphere.wetness > 0);
  atmosphere.setProfile({});
  assert.equal(weather.object.material, faithful, "and hands the faithful one back");
  assert.equal(scene.children.length, 0);
  assert.equal(WIND_FIELD_UNIFORM.value.w, 0);
  atmosphere.dispose();
  weather.dispose();
});

test("rain is lit by a low sun behind it, and not at all after sunset", () => {
  assert.equal(rainBacklight(-0.2, 1), 0);
  assert.ok(rainBacklight(0.1, 1) > rainBacklight(0.9, 1));
  assert.ok(rainBacklight(0.9, 1) > 0);
  assert.equal(rainBacklight(0.1, 0), 0, "no sun colour, no glint");
  const out = {};
  enhancedWeatherParams("rain", 1, 0, 0.5, 0.5, out);
  assert.ok(out.streak >= 1.8 && out.gain > 1.5, "longer, brighter streaks than the faithful drop");
  enhancedWeatherParams("snow", 1, 0, 0.5, 0.5, out);
  assert.ok(out.width > 1 && out.alphaScale > 1, "flakes a little larger and denser");
});

test("rain and snow thicken the fog into a veil that never accumulates", () => {
  assert.equal(precipitationHazeTarget("fine", 1), 0);
  assert.equal(precipitationHazeTarget("sand", 1), 0);
  assert.equal(precipitationHazeTarget("rain", 1), 1);
  assert.ok(precipitationHazeTarget("snow", 1) < 1 && precipitationHazeTarget("snow", 1) > 0.5);
  const fog = new THREE.Fog(0x808080, 100, 500);
  applyPrecipitationHaze(fog, 0);
  assert.deepEqual([fog.near, fog.far], [100, 500], "no rain: the zone fog exactly");
  applyPrecipitationHaze(fog, 1);
  assert.ok(Math.abs(fog.near - 38) < 1e-9 && Math.abs(fog.far - 275) < 1e-9, `${fog.near} ${fog.far}`);
  const tight = new THREE.Fog(0x808080, 10, 11);
  applyPrecipitationHaze(tight, 1);
  assert.ok(tight.far > tight.near);
});

test("the procedural rain layers draw only while it falls, and scale with density and quality", () => {
  const layer = new PrecipitationLayer();
  const camera = new THREE.Vector3(1, 2, 3);
  const light = new THREE.Color(1, 1, 1);
  const sun = new THREE.Vector3(0, 1, 0);
  layer.update(camera, 1 / 60, RAIN_MID_LAYER, 0, 0, 0, light, sun, 0, 1);
  assert.equal(layer.object.visible, false);
  layer.update(camera, 1 / 60, undefined, 1, 0, 0, light, sun, 0, 1);
  assert.equal(layer.object.visible, false);
  layer.update(camera, 1 / 60, RAIN_MID_LAYER, 1, 0, 0, light, sun, 0, 1);
  assert.equal(layer.drawn, PRECIPITATION_LAYER_CAPACITY);
  layer.update(camera, 1 / 60, RAIN_MID_LAYER, 0.3, 0, 0, light, sun, 0, 1);
  const light3 = layer.drawn;
  assert.ok(light3 > 0 && light3 < PRECIPITATION_LAYER_CAPACITY);
  layer.update(camera, 1 / 60, RAIN_MID_LAYER, 0.3, 0, 0, light, sun, 0, 0.45);
  assert.ok(layer.drawn < light3);
  layer.update(camera, 1 / 60, RAIN_FAR_LAYER, 1, 0, 0, light, sun, 0, 1);
  assert.ok(layer.drawn < PRECIPITATION_LAYER_CAPACITY * 0.4);
  layer.update(camera, 1 / 60, SNOW_MID_LAYER, 1, 0, 0, light, sun, 0, 1);
  assert.equal(layer.material.uniforms.uProcedural.value, 2, "snow is soft round flakes");
  assert.ok(layer.object.position.equals(camera));
  layer.dispose();
});

test("each lightning strike is counted with its distance and side for the thunder", () => {
  const lightning = new Lightning();
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 2000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  assert.equal(lightning.strikes, 0);
  lightning.strikeSoon();
  lightning.update(camera, 1 / 60, 1, false);
  assert.equal(lightning.strikes, 1);
  assert.ok(lightning.strikeDistance >= 240 && lightning.strikeDistance <= 500);
  assert.ok(Math.abs(lightning.strikePan) <= Math.sin(0.95) + 1e-9);
  assert.equal(lightning.strikeStrength, 1);
  lightning.reset();
  assert.equal(lightning.strikes, 0);
  lightning.dispose();
});

test("the sound leaf is a leaf like the others: on alone it runs the controller, off it is nothing", () => {
  assert.equal(DEFAULT_ATMOSPHERE_PROFILE.weatherSounds, false);
  assert.equal(atmosphereProfileActive(normaliseAtmosphereProfile({ weatherSounds: true })), true);
  const scene = new THREE.Scene();
  const atmosphere = new AtmosphereEffects(scene, () => new THREE.Texture());
  atmosphere.setProfile({ weatherSounds: true });
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 800);
  atmosphere.update({
    camera, feet: new THREE.Vector3(), heightAt: () => 0, seconds: 1, elapsed: 1 / 60, map: 0,
    weather: undefined, fade: { kind: "rain", density: 0.8, storm: 1 }, thunder: true, indoors: true,
    underwater: false, sunDirection: new THREE.Vector3(0, 1, 0), sunColour: new THREE.Color(1, 1, 1),
    ambient: new THREE.Color(0.4, 0.4, 0.4), daylight: 1, skyColour: new THREE.Color(0.5, 0.6, 0.7),
    pixelScale: 600, quality: 1, meadow: 0, forest: 0,
  });
  assert.equal(scene.children.length, 0, "sound draws nothing");
  assert.equal(atmosphere.haze, 0, "and thickens no fog");
  assert.equal(WET_SURFACE_UNIFORMS.haze.value, 0);
  assert.deepEqual([atmosphere.audio.kind, atmosphere.audio.density, atmosphere.audio.thunder, atmosphere.audio.indoors],
    ["rain", 0.8, true, true]);
  assert.ok(atmosphere.audio.wind > 0.8, "a thunderstorm blows");
  atmosphere.dispose();
});

test("counts drop as AutoQuality lowers the render scale", () => {
  assert.equal(atmosphereQuality(1), 1);
  assert.ok(atmosphereQuality(0.7) < 1);
  assert.ok(atmosphereQuality(0.4) < atmosphereQuality(0.7));
});

test("rain keeps its place when the wind turns: travel is integrated, never velocity times time", () => {
  const box = { x: 46, y: 26, z: 46 };
  const offset = { x: 0, y: 0, z: 0 };
  // Ten minutes of a steady westerly, then the wind swings ninety degrees in one frame.
  for (let i = 0; i < 36000; i++) advancePrecipitationOffset(offset, 12, 0, 22, 1 / 60, box);
  const before = { ...offset };
  advancePrecipitationOffset(offset, 0, 12, 22, 1 / 60, box);
  const wrapped = (value, size) => ((value % size) + size) % size;
  assert.ok(Math.abs(wrapped(offset.x - before.x, box.x)) < 1e-6, "no sideways jump on x");
  assert.ok(Math.abs(wrapped(offset.z - before.z, box.z) - 0.2) < 1e-6, "one frame of the new wind on z");
  assert.ok(Math.abs(wrapped(offset.y - before.y, box.y) - 22 / 60) < 1e-6, "one frame of fall");
  for (const key of ["x", "y", "z"]) assert.ok(offset[key] >= 0 && offset[key] < box[key], `${key} stays inside the box`);
  // Garbage steps and speeds are ignored rather than propagated.
  advancePrecipitationOffset(offset, Number.NaN, 5, 22, Number.NaN, box);
  assert.ok(Number.isFinite(offset.x) && Number.isFinite(offset.z));
  assert.ok(advancePrecipitationPhase(PRECIPITATION_SWAY_PERIOD - 0.001, 0.01) < 0.01, "the sway clock wraps");
  const layer = new PrecipitationLayer();
  assert.ok(layer.material.vertexShader.includes("uOffset"), "positions read the integrated travel");
  assert.ok(!layer.material.vertexShader.includes("uWind.x * uTime"), "and never wind times the clock");
  assert.ok(!layer.material.vertexShader.includes("uWind.y * uTime"));
  layer.dispose();
});

test("the splash field is wide, thins towards its rim and rebuilds its ground a few rows a frame", () => {
  assert.ok(RAIN_SPLASH_RADIUS >= 40, "past where a splash is still a few pixels");
  assert.ok(RAIN_SPLASH_GRID * RAIN_SPLASH_CELL / 2 >= RAIN_SPLASH_RADIUS + RAIN_SPLASH_REGRID_YARDS,
    "the grid outreaches the field by the regrid slack");
  const splashes = new RainSplashes();
  const shader = splashes.material.vertexShader;
  assert.ok(shader.includes("pow( b, 0.62 )"), "denser under the character than at the rim");
  assert.ok(shader.includes("smoothstep( 0.6, 1.0, radius / uRadius )"), "a soft rim, not an edge");
  assert.ok(shader.includes("smoothstep( 32.0, 64.0, depth )"), "and a fade with distance from the eye");
  const asked = [];
  const slope = (x, y) => { asked.push([x, y]); return 10 + x * 0.01; };
  const feet = new THREE.Vector3(100, 11, -50);
  const texture = new THREE.Texture();
  const light = new THREE.Color(1, 1, 1);
  splashes.update(feet, slope, 1 / 60, 1, texture, light, 1);
  assert.equal(splashes.regridding, false, "the first grid is built at once");
  const firstGrid = asked.length;
  assert.equal(firstGrid, 1 + RAIN_SPLASH_GRID * RAIN_SPLASH_GRID);
  assert.deepEqual(splashes.gridCentre, { x: 100, z: -50 });
  // A step short of the regrid distance asks nothing more.
  feet.x += RAIN_SPLASH_REGRID_YARDS - 1;
  splashes.update(feet, slope, 1 / 60, 1, texture, light, 1);
  assert.equal(asked.length, firstGrid);
  // Past it, the rebuild starts and takes a few rows a frame while the old grid keeps serving.
  feet.x += 2;
  splashes.update(feet, slope, 1 / 60, 1, texture, light, 1);
  assert.equal(splashes.regridding, true);
  assert.deepEqual(splashes.gridCentre, { x: 100, z: -50 }, "the old grid serves until the new one is whole");
  const perFrame = asked.length - firstGrid;
  assert.ok(perFrame <= 1 + RAIN_SPLASH_ROWS_PER_FRAME * RAIN_SPLASH_GRID, `${perFrame} queries in one frame`);
  for (let frame = 0; frame < 20 && splashes.regridding; frame++) splashes.update(feet, slope, 1 / 60, 1, texture, light, 1);
  assert.equal(splashes.regridding, false);
  assert.deepEqual(splashes.gridCentre, { x: feet.x, z: feet.z });
  splashes.dispose();
});
