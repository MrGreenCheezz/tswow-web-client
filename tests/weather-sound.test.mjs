import assert from "node:assert/strict";
import test from "node:test";
import {
  SPEED_OF_SOUND_YARDS, THUNDER_KIT, THUNDER_ROLL_ONLY_YARDS, WEATHER_LOOP_KITS, WIND_GALE_KIT, WIND_STIFF_KIT,
  WeatherSoundDriver, thunderDelaySeconds, thunderFiles, thunderLevel, thunderLowpassHz, weatherLoopKit,
  weatherLoopLevel, weatherLoopTier, windKit, windLevel,
} from "../dist/code/browser/WeatherSound.js";
import { SoundPlayer } from "../dist/code/browser/Sound.js";

/** The kits exactly as the gateway's /dbc/sounds answers them for this client (SoundEntries.dbc). */
const THUNDER = {
  id: 8439, type: 25, name: "LightningBolt - ZulGurub", volume: 1, minDistance: 50, maxDistance: 100, flags: 0,
  files: [
    "Sound\\Doodad\\BlastedLandsLightningbolt01Stand-Bolt.wav",
    "Sound\\Doodad\\BlastedLandsLightningbolt01Stand-Bolt1.wav",
    "Sound\\Doodad\\BlastedLandsLightningbolt01Stand-Bolt2.wav",
    "Sound\\Doodad\\BlastedLandsLightningbolt01Stand-Bolt3.wav",
  ],
};
const loop = (id, name, file) => ({
  id, type: 50, name, volume: 0.69, minDistance: 7, maxDistance: 30, flags: 0, files: [`Sound\\Ambience\\Weather\\${file}`],
});
const KITS = new Map([
  [8439, THUNDER],
  [8533, loop(8533, "Weather - RainLight", "RainLightLoop.wav")],
  [8534, loop(8534, "Weather - RainMedium", "RainMediumLoop.wav")],
  [8535, loop(8535, "Weather - RainHeavy", "RainHeavyLoop.wav")],
  [8536, loop(8536, "Weather - SnowLight", "SnowLight.wav")],
  [8537, loop(8537, "Weather - SnowMedium", "SnowMedium.wav")],
  [8538, loop(8538, "Weather - SnowHeavy", "SnowHeavy.wav")],
]);

test("thunder arrives after the time sound takes to cover the distance", () => {
  assert.ok(Math.abs(SPEED_OF_SOUND_YARDS - 375.109) < 0.01, `${SPEED_OF_SOUND_YARDS}`);
  // The storm's bolts land 240..500 yards out (Lightning.ts).
  assert.ok(Math.abs(thunderDelaySeconds(240) - 0.6398) < 1e-3, `${thunderDelaySeconds(240)}`);
  assert.ok(Math.abs(thunderDelaySeconds(500) - 1.3330) < 1e-3, `${thunderDelaySeconds(500)}`);
  assert.equal(thunderDelaySeconds(-5), 0);
  assert.equal(thunderDelaySeconds(Number.NaN), 0);
});

test("a far clap is quieter, duller and only a roll; a wall muffles it further", () => {
  assert.ok(thunderLevel(240, 1, false) > thunderLevel(500, 1, false));
  assert.ok(thunderLevel(500, 1, false) > 0.5, "still a proper clap at the storm's far edge");
  assert.ok(thunderLevel(240, 0.2, false) < thunderLevel(240, 1, false));
  assert.ok(Math.abs(thunderLevel(300, 1, true) - thunderLevel(300, 1, false) / 2) < 1e-9);
  assert.ok(thunderLevel(240, 1, false) <= 1);
  assert.ok(Math.abs(thunderLowpassHz(240, false) - 7000) < 1e-6);
  assert.ok(thunderLowpassHz(500, false) < 3000 && thunderLowpassHz(500, false) > 2000);
  assert.ok(thunderLowpassHz(240, true) <= 700);
  assert.deepEqual(thunderFiles(THUNDER, 250), THUNDER.files, "near: the crack as well");
  const far = thunderFiles(THUNDER, THUNDER_ROLL_ONLY_YARDS + 1);
  assert.deepEqual(far, THUNDER.files.slice(1), "far: only the rolls Bolt1..3");
});

test("the loops are the client's own light/medium/heavy rows at the server's thresholds", () => {
  assert.deepEqual([...WEATHER_LOOP_KITS.rain], [8533, 8534, 8535]);
  assert.deepEqual([...WEATHER_LOOP_KITS.snow], [8536, 8537, 8538]);
  assert.deepEqual([...WEATHER_LOOP_KITS.sand], [8556, 8557, 8558]);
  assert.equal(weatherLoopTier(0.15, false), 0);
  assert.equal(weatherLoopTier(0.39, false), 0);
  assert.equal(weatherLoopTier(0.4, false), 1);
  assert.equal(weatherLoopTier(0.69, false), 1);
  assert.equal(weatherLoopTier(0.7, false), 2);
  assert.equal(weatherLoopTier(0.2, true), 2, "a thunderstorm is the heavy loop");
  assert.equal(weatherLoopTier(0.67, false, 2), 2, "a fading storm does not flip files at the line");
  assert.equal(weatherLoopTier(0.6, false, 2), 1);
  assert.equal(weatherLoopKit("rain", 2), 8535);
  assert.equal(weatherLoopKit("fine", 0), undefined);
  assert.equal(weatherLoopKit("fog", 1), undefined);
  assert.equal(weatherLoopLevel("rain", 0.6, false, false), 1);
  assert.equal(weatherLoopLevel("rain", 0.6, true, false), 0.4);
  assert.equal(weatherLoopLevel("rain", 0.6, false, true), 0);
  assert.ok(weatherLoopLevel("rain", 0.05, false, false) < 0.2, "follows the weather's own fade-in");
});

test("the wind is heard only when it blows hard, and breathes with the gusts", () => {
  assert.equal(windLevel("fine", 0.42, 1, false, false), 0, "a calm day has the zone's own breeze");
  assert.equal(windLevel("rain", 0.95, 1, false, true), 0);
  assert.equal(windLevel("snow", 0.95, 1, false, false), 0, "the snow loop is the wind");
  const storm = windLevel("rain", 0.95, 1, false, false);
  assert.ok(storm > 0.9);
  assert.ok(windLevel("rain", 0.95, 0, false, false) < storm);
  assert.ok(windLevel("rain", 0.95, 1, true, false) < storm * 0.5);
  assert.equal(windKit(0.7), WIND_STIFF_KIT);
  assert.equal(windKit(0.9), WIND_GALE_KIT);
});

function fakeOutput() {
  const calls = [];
  return {
    calls,
    setAmbientLayer: (slot, kit, level, options) => calls.push(["layer", slot, kit?.id, level, options]),
    playAmbientShot: (kit, options) => calls.push(["shot", kit.id, options]),
    stopAmbientLayers: (fade) => calls.push(["stop", fade]),
  };
}
const kits = { kit: (id) => KITS.get(id) };
function stormState(overrides = {}) {
  return {
    kind: "rain", density: 0.9, thunder: true, indoors: false, underwater: false, wind: 0.92, gust: 0.8,
    strikes: 0, strikeDistance: 0, strikePan: 0, strikeStrength: 1, ...overrides,
  };
}

test("the driver plays one clap per strike, delayed by distance, and the storm's loops", () => {
  const driver = new WeatherSoundDriver(() => 0.99);
  const out = fakeOutput();
  driver.update(0, stormState({ strikes: 3 }), true, out, kits);
  assert.equal(out.calls.filter((c) => c[0] === "shot").length, 0, "switched on mid-storm: old strikes are history");
  const layers = out.calls.filter((c) => c[0] === "layer");
  assert.deepEqual(layers.map((c) => [c[1], c[2]]), [["weather", 8535], ["wind", WIND_GALE_KIT]]);
  out.calls.length = 0;
  driver.update(16, stormState({ strikes: 4, strikeDistance: 400, strikePan: 0.5 }), true, out, kits);
  const shots = out.calls.filter((c) => c[0] === "shot");
  assert.equal(shots.length, 1);
  const [, id, options] = shots[0];
  assert.equal(id, THUNDER_KIT);
  assert.ok(Math.abs(options.delaySeconds - 400 / SPEED_OF_SOUND_YARDS) < 1e-9);
  assert.ok(Math.abs(options.pan - 0.35) < 1e-9);
  assert.match(options.file, /Bolt3\.wav$/, "far: a roll");
  assert.equal(driver.thunder.at(-1).distance, 400);
  out.calls.length = 0;
  driver.update(32, stormState({ strikes: 4, strikeDistance: 400 }), true, out, kits);
  assert.equal(out.calls.filter((c) => c[0] === "shot").length, 0, "the same strike is not heard twice");
  driver.update(48, stormState({ strikes: 0 }), true, out, kits);
  driver.update(64, stormState({ strikes: 1, strikeDistance: 250 }), true, out, kits);
  assert.equal(out.calls.filter((c) => c[0] === "shot").length, 1, "a replay restart resynchronises the counter");
  driver.update(80, stormState({ strikes: 2, strikeDistance: 250, underwater: true }), true, out, kits);
  assert.equal(out.calls.filter((c) => c[0] === "shot").length, 1, "nothing is heard under water");
});

test("switching the leaf off fades out what it started; fine weather empties both slots", () => {
  const driver = new WeatherSoundDriver();
  const out = fakeOutput();
  driver.update(0, stormState(), true, out, kits);
  driver.update(1000, stormState({ kind: "fine", density: 0, thunder: false, wind: 0.42 }), true, out, kits);
  const last = out.calls.slice(-2);
  assert.deepEqual(last.map((c) => [c[1], c[2], c[3]]), [["weather", undefined, 0], ["wind", undefined, 0]]);
  driver.update(2000, stormState(), false, out, kits);
  assert.deepEqual(out.calls.at(-1), ["stop", 1.5]);
  const before = out.calls.length;
  driver.update(3000, stormState(), false, out, kits);
  assert.equal(out.calls.length, before, "and OFF stays silent");
});

class FakeParam {
  constructor(value) { this.value = value; this.events = []; }
  setValueAtTime(v, t) { this.events.push(["set", v, t]); this.value = v; }
  setTargetAtTime(v, t, c) { this.events.push(["target", v, t, c]); }
  linearRampToValueAtTime(v, t) { this.events.push(["ramp", v, t]); }
  cancelScheduledValues(t) { this.events.push(["cancel", t]); }
}
class FakeNode {
  constructor(kind) { this.kind = kind; this.to = []; this.listeners = {}; }
  connect(to) { this.to.push(to); return to; }
  disconnect() { this.to = []; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
class FakeContext {
  constructor() { this.state = "running"; this.currentTime = 10; this.destination = new FakeNode("out"); this.nodes = []; }
  resume() { return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
  #add(node) { this.nodes.push(node); return node; }
  createGain() { const n = new FakeNode("gain"); n.gain = new FakeParam(1); return this.#add(n); }
  createBiquadFilter() { const n = new FakeNode("filter"); n.frequency = new FakeParam(350); return this.#add(n); }
  createStereoPanner() { const n = new FakeNode("pan"); n.pan = new FakeParam(0); return this.#add(n); }
  createBufferSource() {
    const n = new FakeNode("source");
    n.start = (when, offset) => { n.started = [when, offset]; };
    n.stop = (when) => { n.stopped = when; };
    return this.#add(n);
  }
  async decodeAudioData() { return { duration: 20 }; }
}

test("the player's weather layers crossfade by kit and its claps start after their delay", async () => {
  const originalContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  const fetched = [];
  let context;
  globalThis.AudioContext = class extends FakeContext { constructor() { super(); context = this; } };
  globalThis.fetch = async (url) => {
    fetched.push(decodeURIComponent(String(url).split("path=")[1]));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  try {
    const player = new SoundPlayer("ws://127.0.0.1:8090/world");
    player.setAmbientLayer("weather", KITS.get(8535), 0.8, { rampSeconds: 1.5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(player.ambientLayer("weather"), { kitId: 8535, level: 0.8, playing: true });
    const source = context.nodes.find((node) => node.kind === "source");
    assert.equal(source.loop, true);
    assert.ok(source.started[1] >= 0 && source.started[1] < 20, "starts somewhere inside the loop");
    // Same kit: only a retarget, no second fetch or source.
    player.setAmbientLayer("weather", KITS.get(8535), 0.4, { rampSeconds: 1.5, lowpassHz: 1200 });
    assert.equal(context.nodes.filter((node) => node.kind === "source").length, 1);
    // Another kit: the old one fades out and stops, the new one fades in.
    player.setAmbientLayer("weather", KITS.get(8534), 0.8, { rampSeconds: 1.5 });
    assert.equal(source.stopped, context.currentTime + 1.5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(player.ambientLayer("weather").kitId, 8534);
    player.setAmbientLayer("weather", KITS.get(8534), 0, { rampSeconds: 1 });
    assert.equal(player.ambientLayer("weather"), undefined, "level 0 empties the slot");

    const shotsBefore = context.nodes.filter((node) => node.kind === "source").length;
    player.playAmbientShot(THUNDER, { delaySeconds: 1.2, level: 0.7, lowpassHz: 3000, pan: -0.4, file: THUNDER.files[2] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shot = context.nodes.filter((node) => node.kind === "source")[shotsBefore];
    assert.equal(shot.loop, undefined);
    assert.ok(Math.abs(shot.started[0] - 11.2) < 1e-9, `starts 1.2 s after the call: ${shot.started}`);
    const gains = context.nodes.filter((node) => node.kind === "gain");
    assert.ok(Math.abs(gains.at(-1).gain.value - 0.7) < 1e-9);
    assert.equal(context.nodes.filter((node) => node.kind === "pan").at(-1).pan.value, -0.4);
    assert.equal(context.nodes.filter((node) => node.kind === "filter").at(-1).frequency.value, 3000);
    assert.ok(fetched.includes(THUNDER.files[2]));
    assert.ok(fetched.includes("Sound\\Ambience\\Weather\\RainHeavyLoop.wav"));
    player.close();
    assert.equal(player.ambientLayer("weather"), undefined);
  } finally {
    globalThis.AudioContext = originalContext;
    globalThis.fetch = originalFetch;
  }
});
