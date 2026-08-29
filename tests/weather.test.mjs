import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  WEATHER_BLACK_RAIN, WEATHER_BLACK_SNOW, WEATHER_DRIZZLE, WEATHER_FINE, WEATHER_FOG,
  WEATHER_HEAVY_RAIN, WEATHER_HEAVY_SANDSTORM, WEATHER_HEAVY_SNOW, WEATHER_LIGHT_RAIN,
  WEATHER_MEDIUM_SNOW, WEATHER_THUNDERS,
  LIGHT_SLOT_CLEAR, LIGHT_SLOT_STORM, weatherIsBlack, weatherKind,
} from "../dist/code/world/WorldMessageProtocol.js";
import {
  WEATHER_CAPACITY, WEATHER_FADE_SECONDS, WEATHER_PRESETS, WeatherEffect,
  advanceWeather, buildWeatherGeometry, weatherDensity, weatherDrawCount,
} from "../dist/code/browser/WeatherEffect.js";

test("every weather state the server can send resolves to something to draw", () => {
  assert.equal(weatherKind(WEATHER_FINE), "fine");
  assert.equal(weatherKind(WEATHER_LIGHT_RAIN), "rain");
  assert.equal(weatherKind(WEATHER_HEAVY_RAIN), "rain");
  assert.equal(weatherKind(WEATHER_MEDIUM_SNOW), "snow");
  assert.equal(weatherKind(WEATHER_HEAVY_SANDSTORM), "sand");
  // Thunder is rain with a soundtrack: the server has no separate visual and this client has no
  // lightning, so drawing it as anything else would be inventing weather.
  assert.equal(weatherKind(WEATHER_THUNDERS), "rain");
  // Drizzle is the lightest rain there is, and the weather timer can never produce it —
  // `GetWeatherState` has no branch for it. It is reachable only from a script.
  assert.equal(weatherKind(WEATHER_DRIZZLE), "rain");
  // Both of these come from scripts, and both are in places a player goes: fog from the Trial of
  // the Crusader and Icecrown Citadel, black snow from the Lich King's own encounter.
  assert.equal(weatherKind(WEATHER_FOG), "fog");
  assert.equal(weatherKind(WEATHER_BLACK_SNOW), "snow");
  assert.equal(weatherIsBlack(WEATHER_BLACK_SNOW), true);
  assert.equal(weatherIsBlack(WEATHER_BLACK_RAIN), true);
  assert.equal(weatherIsBlack(WEATHER_HEAVY_RAIN), false);
});

test("there is one storm light slot of the eight, and it is slot 2", () => {
  // Measured over the 715 rows this client resolves: slot 0 and slot 2 agree on 47.1% of rows and
  // slot 1 and slot 3 on 57.2%, every cross pairing under 1.5%, and slots 1 and 3 are the short
  // teal fog — the underwater pair. A function used to pick one by weather state and sent rain to
  // slot 1, which is the underwater sky; there is nothing to pick, so there is no function.
  assert.equal(LIGHT_SLOT_CLEAR, 0);
  assert.equal(LIGHT_SLOT_STORM, 2);
});

test("the packet's intensity is read the same way the server derived the state from it", () => {
  // Below 0.27 the server sends FINE, and the three rains split at 0.40 and 0.70, so a linear
  // reading agrees with the state instead of contradicting it.
  assert.equal(weatherDensity("fine", 1), 0);
  assert.ok(Math.abs(weatherDensity("rain", 0.9999) - 0.9999) < 1e-6);
  assert.ok(Math.abs(weatherDensity("snow", 0.5) - 0.5) < 1e-6);
  // The floor: the lightest weather the server can ask for still has to be visible.
  assert.equal(weatherDensity("rain", 0), 0.15);
  // Fog is the exception, and not by taste: both scripts that call for it call for it with zero.
  assert.equal(weatherDensity("fog", 0), 0.6);
  assert.equal(weatherDensity("fog", 0.9), 0.9);
});

test("weather arrives and leaves over five seconds", () => {
  let fade = { kind: "fine", density: 0, storm: 0 };
  const target = { kind: "rain", density: 1 };
  fade = advanceWeather(fade, target, WEATHER_FADE_SECONDS / 2);
  assert.equal(fade.kind, "rain");
  assert.ok(Math.abs(fade.density - 0.5) < 1e-6, `halfway: ${fade.density}`);
  assert.ok(Math.abs(fade.storm - 0.5) < 1e-6);
  fade = advanceWeather(fade, target, WEATHER_FADE_SECONDS);
  assert.equal(fade.density, 1, "and it does not overshoot");
  assert.equal(fade.storm, 1);

  fade = advanceWeather(fade, { kind: "fine", density: 0 }, WEATHER_FADE_SECONDS * 2);
  assert.equal(fade.density, 0);
  assert.equal(fade.storm, 0);
});

test("zoning into a storm does not begin with a clear sky dissolving", () => {
  // What the `abrupt` flag is for: the server sets it on the packet the player gets on arrival.
  const fade = advanceWeather({ kind: "fine", density: 0, storm: 0 },
    { kind: "snow", density: 0.8 }, 0.016, true);
  assert.equal(fade.kind, "snow");
  assert.ok(Math.abs(fade.density - 0.8) < 1e-6);
  assert.ok(Math.abs(fade.storm - 0.8) < 1e-6);
});

test("rain does not crossfade into snow, and the sky does not brighten while it changes", () => {
  let fade = { kind: "rain", density: 1, storm: 1 };
  const target = { kind: "snow", density: 1 };
  fade = advanceWeather(fade, target, WEATHER_FADE_SECONDS / 2);
  assert.equal(fade.kind, "rain", "the old one is still what is on screen");
  assert.ok(Math.abs(fade.density - 0.5) < 1e-6, "and it is on its way out");
  assert.equal(fade.storm, 1, "but the storm sky is driven by the target, so it does not dip");
  fade = advanceWeather(fade, target, WEATHER_FADE_SECONDS / 2);
  assert.equal(fade.kind, "snow");
  assert.equal(fade.density, 0);
  fade = advanceWeather(fade, target, WEATHER_FADE_SECONDS);
  assert.equal(fade.density, 1);
});

test("the cloud is one buffer, built once, and the same one every session", () => {
  const geometry = buildWeatherGeometry();
  const position = geometry.getAttribute("position");
  const corner = geometry.getAttribute("corner");
  assert.equal(position.count, WEATHER_CAPACITY * 4);
  assert.equal(corner.count, WEATHER_CAPACITY * 4);
  assert.equal(geometry.getIndex().count, WEATHER_CAPACITY * 6);
  assert.deepEqual(geometry.drawRange, { start: 0, count: 0 });

  // Four corners of a unit square, and one seed shared by all four: the shader turns the seed into
  // a place and the corner into a size, so a quad whose corners disagreed would be a torn one.
  for (let axis = 0; axis < 3; axis++) {
    for (let vertex = 1; vertex < 4; vertex++) {
      assert.equal(position.array[vertex * 3 + axis], position.array[axis]);
    }
  }
  const corners = new Set();
  for (let vertex = 0; vertex < 4; vertex++) corners.add(`${corner.getX(vertex)},${corner.getY(vertex)}`);
  assert.equal(corners.size, 4);

  // Every seed inside the unit cube, or the drop lands outside the box the shader wraps in.
  for (let index = 0; index < position.array.length; index++) {
    assert.ok(position.array[index] >= 0 && position.array[index] <= 1);
  }
  // No index past the end of the buffer.
  const indices = geometry.getIndex().array;
  for (let index = 0; index < indices.length; index++) assert.ok(indices[index] < position.count);

  // A reload has to be the same rain. A cloud seeded from Math.random would be a different one
  // every session, and nothing here could be asserted about at all.
  const again = buildWeatherGeometry();
  assert.deepEqual([...again.getAttribute("position").array.slice(0, 64)],
    [...position.array.slice(0, 64)]);
});

test("intensity changes the draw range and never the buffer", () => {
  const rain = WEATHER_PRESETS.rain;
  assert.equal(weatherDrawCount(rain, 0), 0);
  assert.equal(weatherDrawCount(rain, 1), rain.maxCount * 6);
  assert.equal(weatherDrawCount(rain, 0.5), Math.round(rain.maxCount * 0.5) * 6);
  // Always whole quads: half an index triple is a torn triangle.
  assert.equal(weatherDrawCount(rain, 0.333) % 6, 0);
  // And clamped, so a bad intensity cannot ask for more than was built.
  assert.equal(weatherDrawCount(rain, 4), rain.maxCount * 6);
  assert.equal(weatherDrawCount(rain, -1), 0);
  for (const preset of Object.values(WEATHER_PRESETS)) {
    assert.ok(preset.maxCount <= WEATHER_CAPACITY, "the shared buffer holds the largest preset");
  }
});

test("a raindrop is a streak and a snowflake is a square, which is what the textures are", () => {
  // RainDrop01.blp is 16x128 and Snowflake01.blp is 64x64; a sprite whose shape disagrees with its
  // texture stretches it.
  const rain = WEATHER_PRESETS.rain;
  assert.ok(Math.abs(rain.height / rain.width - 8) < 0.01, `${rain.width} by ${rain.height}`);
  assert.equal(WEATHER_PRESETS.snow.width, WEATHER_PRESETS.snow.height);
  // Sand is blown sideways faster than it falls; snow is not.
  assert.ok(WEATHER_PRESETS.sand.drift > WEATHER_PRESETS.sand.fall);
  assert.ok(WEATHER_PRESETS.snow.drift < WEATHER_PRESETS.snow.fall);
});

function trackedTexture() {
  const texture = new THREE.Texture();
  let disposals = 0;
  texture.dispose = () => { disposals++; };
  return { texture, get disposals() { return disposals; } };
}

test("weather disposal is idempotent and releases each aliased texture identity once", () => {
  const shared = trackedTexture();
  let loads = 0;
  const effect = new WeatherEffect(() => {
    loads++;
    return shared.texture;
  });
  let geometryDisposals = 0;
  let materialDisposals = 0;
  effect.object.geometry.addEventListener("dispose", () => { geometryDisposals++; });
  effect.object.material.addEventListener("dispose", () => { materialDisposals++; });

  effect.set({ kind: "rain", density: 1, storm: 1 }, false);
  effect.set({ kind: "snow", density: 1, storm: 1 }, false);
  assert.equal(loads, 2, "each weather path is loaded once even when the loader aliases identities");

  effect.dispose();
  effect.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(shared.disposals, 1);
});

test("a failed kind change rolls back and retries instead of drawing with the previous map", () => {
  const rain = trackedTexture();
  const snow = trackedTexture();
  let snowAttempts = 0;
  const effect = new WeatherEffect((path) => {
    if (!path.includes("Snowflake")) return rain.texture;
    snowAttempts++;
    if (snowAttempts === 1) throw new Error("snow loader exploded");
    return snow.texture;
  });

  effect.set({ kind: "rain", density: 1, storm: 1 }, false);
  assert.equal(effect.object.material.uniforms.uMap.value, rain.texture);
  assert.throws(() => effect.set({ kind: "snow", density: 1, storm: 1 }, false), /snow loader exploded/);
  assert.equal(effect.object.material.uniforms.uMap.value, rain.texture,
    "the failed change leaves the previously committed kind intact");

  effect.set({ kind: "snow", density: 1, storm: 1 }, false);
  assert.equal(snowAttempts, 2, "the next renderer frame retries the uncommitted kind");
  assert.equal(effect.object.material.uniforms.uMap.value, snow.texture);
  effect.dispose();
  assert.equal(rain.disposals, 1);
  assert.equal(snow.disposals, 1);
});

test("a reentrant weather change cannot publish the stale returned texture", () => {
  const rain = trackedTexture();
  const snow = trackedTexture();
  let effect;
  let reentered = false;
  const loader = (path) => {
    const returned = path.includes("Snowflake") ? snow.texture : rain.texture;
    if (!reentered) {
      reentered = true;
      effect.set({ kind: "snow", density: 1, storm: 1 }, false);
    }
    return returned;
  };
  effect = new WeatherEffect(loader);
  effect.set({ kind: "rain", density: 1, storm: 1 }, false);

  assert.equal(effect.object.material.uniforms.uMap.value, snow.texture,
    "the inner committed kind keeps control after the outer loader returns");
  assert.equal(rain.disposals, 0, "the old kind remains a valid cached identity until disposal");
  assert.equal(snow.disposals, 0);
  assert.equal(effect.object.visible, true);
  effect.dispose();
  assert.equal(rain.disposals, 1);
  assert.equal(snow.disposals, 1);
});

test("a reentrant clear rolls back the provisional kind before the next weather frame", () => {
  const rain = trackedTexture();
  let effect;
  let loads = 0;
  const loader = () => {
    loads++;
    if (loads === 1) effect.set({ kind: "fine", density: 0, storm: 0 }, false);
    return rain.texture;
  };
  effect = new WeatherEffect(loader);

  effect.set({ kind: "rain", density: 1, storm: 1 }, false);
  assert.equal(effect.object.visible, false, "the reentrant clear wins the in-flight change");
  assert.equal(effect.object.material.uniforms.uMap.value, null);

  effect.set({ kind: "rain", density: 1, storm: 1 }, false);
  assert.equal(loads, 1, "the safely cached handle is reused after the provisional kind rolls back");
  assert.equal(effect.object.material.uniforms.uMap.value, rain.texture);
  assert.equal(effect.object.visible, true);
  effect.dispose();
  assert.equal(rain.disposals, 1);
});

test("weather disposal clears the material map before synchronous listeners", () => {
  const loaded = trackedTexture();
  const effect = new WeatherEffect(() => loaded.texture);
  effect.set({ kind: "rain", density: 1, storm: 1 }, false);
  let observed = "not-called";
  effect.object.material.addEventListener("dispose", () => {
    observed = effect.object.material.uniforms.uMap.value;
  });

  effect.dispose();
  assert.equal(observed, null);
  assert.equal(effect.object.material.uniforms.uMap.value, null);
  assert.equal(loaded.disposals, 1);
});

test("post-dispose weather operations are safe and inert", () => {
  const loaded = trackedTexture();
  let loads = 0;
  const effect = new WeatherEffect(() => {
    loads++;
    return loaded.texture;
  });
  effect.set({ kind: "rain", density: 1, storm: 1 }, false);
  effect.dispose();
  const visibleBefore = effect.object.visible;
  let visits = 0;
  const visitor = {
    referenceCpu() {},
    referenceGpuBuffer() {},
    referenceGpuTexture() { visits++; },
    referenceGpuRenderTarget() {},
    referenceUnsupported() {},
  };

  effect.set({ kind: "snow", density: 1, storm: 1 }, false);
  effect.update(undefined, Number.NaN);
  effect.reset(-1);
  effect.visitRetainedResources(visitor);
  assert.equal(loads, 1);
  assert.equal(effect.object.visible, visibleBefore);
  assert.equal(effect.object.geometry.drawRange.count, 0);
  assert.equal(visits, 0);
  assert.equal(loaded.disposals, 1);
});
