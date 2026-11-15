// 15.11 (sky8, 7.67): SMSG_OVERRIDE_LIGHT's list and the order overlapping Light.dbc volumes are blended in, as
// Wow.exe 12340 runs them (0x412 → 0x007f11a0 / 0x007f10a0; 0x007f1360 with the heap 0x007f0dc0 / 0x007f1280 and the
// comparator 0x007ed0a0). The places and radii are this dataset's Light.dbc rows (the gateway's /dbc/light/0?v=7 and
// /dbc/light/631?v=7 on 15.11, and the client's Light.dbc for the default row's stored radii); the colour sets are
// flat stand-ins so the blend can be read off.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveLighting, wowVolumeBlendOrder } from "../dist/code/browser/LightClient.js";
import { LightOverrideList } from "../dist/code/world/LightOverrideList.js";

function band(times, values) {
  return { times, values };
}
function set(colour) {
  const colours = {};
  for (const channel of ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower",
    "skyHorizon", "fog", "oceanClose", "oceanFar", "riverClose", "riverFar"]) {
    colours[channel] = band([0], [colour]);
  }
  return { colours, fogEnd: band([0], [500]), fogScale: band([0], [0.25]) };
}
const NOON = 1440;
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-3, `${label}: expected ${expected}, got ${actual}`);

test("the list fades each entry over its own duration and drops a faded one (0x007f11a0, 0x007f10a0, 0x007f1360)", () => {
  const list = new LightOverrideList();
  list.receive(2488, 2509, 5000, 0);
  assert.deepEqual(list.advance(0).map((entry) => entry.weight), [0], "a new entry starts at 0");
  assert.deepEqual(list.advance(2500).map((entry) => entry.weight), [0.5]);
  // The next packet for the same area fades the first entry out over its own milliseconds and adds the new one.
  list.receive(2488, 2508, 10000, 2500);
  let live = list.advance(5000);
  assert.deepEqual(live.map((entry) => [entry.overrideLightId, entry.weight]), [[2509, 0.25], [2508, 0.25]]);
  live = list.advance(7500);
  assert.deepEqual(live.map((entry) => [entry.overrideLightId, entry.weight]), [[2508, 0.5]],
    "an entry fading out is gone the frame it reaches 0");
  // A clear (override 0) only fades out; a zero duration lands at once.
  list.receive(2488, 0, 0, 8000);
  assert.equal(list.advance(8000).length, 0);
  list.receive(1773, 1822, 0, 9000);
  assert.deepEqual(list.advance(9000).map((entry) => entry.weight), [1]);
  // Only the first entry naming the area is faded (0x007f11a0 stops at it); a second one keeps fading in.
  list.receive(1773, 1824, 1000, 9000);
  list.receive(1773, 0, 1000, 9000);
  live = list.advance(9500);
  assert.deepEqual(live.map((entry) => [entry.overrideLightId, entry.weight]), [[1822, 0.5], [1824, 0.5]]);
  list.clear();
  assert.equal(list.size, 0);
});

// Icecrown Citadel (map 631): the default row 2488 stands at the grid origin with its stored falloff 25514.1 / 30829.6,
// unscaled (0x007eaf60), so the Lich King's snowstorm (2490) over it covers the whole citadel.
const CITADEL = {
  fallback: 905,
  fallbackLightId: 2488,
  fallbackReach: [25514.107421875, 30829.62109375],
  params: { 905: set(0x808080), 894: set(0xffffff) },
  volumes: [],
  lights: { 2488: { params: 905 }, 2490: { params: 894 } },
};

test("a scripted light over the map default covers the citadel, faded by its weight", () => {
  const list = new LightOverrideList();
  list.receive(2488, 2490, 5000, 0);
  const frame = (now) => resolveLighting(CITADEL, -500, 2200, NOON, 0, 200,list.advance(now));
  close(frame(0).colours.fog.r, 0x80 / 255, "at once, the default");
  close(frame(2500).colours.fog.r, (0x80 / 255 + 1) / 2, "half-way through the five seconds");
  close(frame(5000).colours.fog.r, 1, "the snowstorm whole");
  list.receive(2488, 0, 5000, 5000);
  close(frame(6250).colours.fog.r, 0x80 / 255 + (1 - 0x80 / 255) * 0.75, "and back over the clear's own five seconds");
  close(frame(10000).colours.fog.r, 0x80 / 255, "gone");
});

// Elwynn/Westfall/Duskwood corner of map 0: Light 57 (set 67) and Light 19 (set 36) both reach this point, 57's centre
// nearer (434 yards, weight 0.645) and wider (outer 601.7), 19's farther (446 yards, weight 0.618) and tighter (529.4).
const V57 = { id: 57, x: -11953.055555555555, y: -1598, z: 0, innerRadius: 306.3333333333333, outerRadius: 601.7222222222222, params: 67 };
const V19 = { id: 19, x: -12041.5, y: -2450.2777777777774, z: 0, innerRadius: 393.8333333333333, outerRadius: 529.3611111111111, params: 36 };
const POINT = { x: -11995.508888888888, y: -2007.0933333333332, z: 0 };
const OVERLAP = {
  fallback: 12,
  fallbackLightId: 1,
  params: { 12: set(0x000000), 67: set(0xff0000), 36: set(0x0000ff) },
  // Map order as the gateway sends it: 19 before 57.
  volumes: [{ ...V19 }, { ...V57 }],
};

test("overlapping volumes blend the farther centre first and the nearer last (heap 0x007f0dc0, comparator 0x007ed0a0)", () => {
  const falloff = (volume) => {
    const distance = Math.hypot(volume.x - POINT.x, volume.y - POINT.y, volume.z - POINT.z);
    return Math.min(1, 1 - (distance - volume.innerRadius) / (volume.outerRadius - volume.innerRadius));
  };
  const near = falloff(V57);
  const far = falloff(V19);
  assert.ok(near > 0 && near < 1 && far > 0 && far < 1, "both are in their falloff here");
  const sample = resolveLighting(OVERLAP, POINT.x, POINT.y, NOON, 0, POINT.z);
  // 19 (blue) first over the black default, then 57 (red) over that: red = near, blue = far × (1 − near).
  close(sample.colours.fog.r, near, "the nearer volume, last");
  close(sample.colours.fog.b, far * (1 - near), "the farther volume, first and partly covered");
  // The broad-to-tight order it replaces would have left blue = far and red = near × (1 − far).
  assert.ok(Math.abs(sample.colours.fog.b - far) > 0.1);
});

test("one centre orders by the inner radius, widest first; many volumes keep the heap's own order", () => {
  const at = (id, x, inner, key) => ({ volume: { id, x, y: 0, z: 0, innerRadius: inner }, key, weight: 1 });
  // Same centre: the inner radius decides, whatever the distance key says.
  const sameCentre = wowVolumeBlendOrder([at(1, 0, 5, 9), at(2, 0.2, 50, 1), at(3, 0.1, 20, 4)]);
  assert.deepEqual(sameCentre.map((item) => item.volume.id), [2, 3, 1]);
  // Apart: the squared distance, largest first, popped out of the heap one by one.
  const apart = wowVolumeBlendOrder([at(1, 0, 0, 4), at(2, 10, 0, 16), at(3, 20, 0, 1), at(4, 30, 0, 25), at(5, 40, 0, 9)]);
  assert.deepEqual(apart.map((item) => item.volume.id), [4, 2, 5, 1, 3]);
});
