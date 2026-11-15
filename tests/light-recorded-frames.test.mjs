// 15.11 (light11, 7.67): the zone light against frames of the original client (WowOracle stand, `runs/light11-*`,
// read with `tools/light11-read.mjs`: the terrain's VS c25/c26, PS c2 and the fog constants VS c12).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { resolveLighting } from "../dist/code/browser/LightClient.js";
import { loadLightMetadata } from "../dist/code/gateway/LightMetadata.js";
import { LightOverrideList } from "../dist/code/world/LightOverrideList.js";
import { SUN_GLARE, dimLightSampleByGlare, glareDimming } from "../dist/code/browser/SkyGlare.js";
import { SUN_AZIMUTH, SUN_POLAR, skyKeyCurve } from "../dist/code/browser/SkyCelestials.js";

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const byte = (value) => Math.round(value * 255);
const bytes = (colour) => [byte(colour.r), byte(colour.g), byte(colour.b)];

function set(fogEnd, fogScale, ambient) {
  const colours = {};
  for (const channel of ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower", "skyHorizon", "fog",
    "oceanClose", "oceanFar", "riverClose", "riverFar"]) colours[channel] = { times: [0], values: [ambient] };
  return { colours, fogEnd: { times: [0], values: [fogEnd] }, fogScale: { times: [0], values: [fogScale] } };
}

test("across a volume's band the fog end and the start's share are blended, not the start", () => {
  // Light.dbc 15's set (end 180.56, share 0.1) over the map default (end 500, share 0.25), halfway through the band.
  const entry = {
    fallback: 1, params: { 1: set(500, 0.25, 0x808080), 2: set(180.56, 0.1, 0x404040) },
    volumes: [{ id: 15, x: 0, y: 0, z: 0, innerRadius: 100, outerRadius: 200, params: 2 }],
  };
  const half = resolveLighting(entry, 150, 0, 0);
  const end = 500 + (180.56 - 500) * 0.5;
  assert.ok(Math.abs(half.fogEnd - end) < 1e-6);
  // Wow.exe 0x007ed4c0 lerps band 1 (the share) and 0x007f16f0 puts the start at end × share: 340.28 × 0.175.
  assert.ok(Math.abs(half.fogStart - end * 0.175) < 1e-6, `start ${half.fogStart}`);
});

// Each frame: the player's position (the stand's teleport point; the first-person camera is 1.86 yards above it, and
// the light follows the unit, not the eye), the game time in half-minutes, and what Wow.exe drew.
const FRAMES = [
  // Inside Light.dbc 15 (Duskwood's set 14), then a quarter, half and three quarters across its band (3D distance
  // 719.5 / 773.0 / 826.2 of inner 667, outer 879): linear weights 0.75 / 0.5 / 0.25.
  { name: "v15-in", at: [-10062.6, -1058, 150], t: 1467.01, amb: [62, 100, 136], dif: [128, 184, 222], fog: [0, 116, 154], end: 180.56, start: 18.06 },
  { name: "v15-q25", at: [-9998.4, -1058, 150], t: 1467.75, amb: [73, 107, 140], dif: [160, 171, 166], fog: [19, 116, 151], end: 260.18, start: 35.77 },
  { name: "v15-q50", at: [-9944.4, -1058, 150], t: 1468.49, amb: [83, 114, 144], dif: [192, 159, 110], fog: [38, 117, 147], end: 339.94, start: 59.49 },
  { name: "v15-q75", at: [-9890.6, -1058, 150], t: 1469.38, amb: [93, 121, 148], dif: [223, 147, 55], fog: [57, 117, 144], end: 419.54, start: 89.14 },
  // Above the half point by 300 yards: the distance is three-dimensional (873 yards, weight 0.03; in 2D 0.55).
  { name: "v15-q50-z450", at: [-9944.4, -1058, 450], t: 1470.12, amb: [102, 128, 152], dif: [251, 136, 6], fog: [74, 117, 141], end: 490.03, start: 120.39 },
  // Light 2 (624 yards, weight 0.51) and Light 8 (792 yards, 0.55): 8, the farther, first, 2 last (the other order
  // gives diffuse 226,146,51).
  { name: "ov-2-8", at: [-10713.6, 681.2, 80], t: 1470.86, amb: [73, 112, 146], dif: [190, 159, 113], fog: [31, 120, 149], end: 322.11, start: 34.13 },
  // Light 57 (471 yards, 0.44) and Light 19 (501 yards, 0.21): 19 first, 57 last.
  { name: "ov-57-19", at: [-11995.5, -2007.1, 230], t: 1472.34, amb: [101, 115, 135], dif: [244, 136, 15], fog: [79, 103, 127], end: 493.24, start: 52.36 },
];

test("map 0's light at the recorded points is what Wow.exe drew", { skip: existsSync(DATASET_DBC) ? false : `no dataset at ${DATASET_DBC}` }, async () => {
  const azeroth = (await loadLightMetadata(DATASET_DBC)).get(0);
  for (const frame of FRAMES) {
    const [x, y, z] = frame.at;
    const sample = resolveLighting(azeroth, x, y, frame.t, 0, z);
    for (const key of ["amb", "dif", "fog"]) {
      const ours = bytes(sample.colours[{ amb: "ambient", dif: "diffuse", fog: "fog" }[key]]);
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(ours[channel] - frame[key][channel]) <= 1, `${frame.name} ${key}: ours ${ours}, Wow.exe ${frame[key]}`);
      }
    }
    assert.ok(Math.abs(sample.fogEnd - frame.end) < 0.3, `${frame.name} fog end: ours ${sample.fogEnd}, Wow.exe ${frame.end}`);
    assert.ok(Math.abs(sample.fogStart - frame.start) < 0.3, `${frame.name} fog start: ours ${sample.fogStart}, Wow.exe ${frame.start}`);
  }
  // Light 40 (set 54, 25 yards away, inside its 35-yard inner radius) sits inside Light 2's inner radius (464 yards of
  // 533): both weigh 1, and the frame (ov-2-40) drew 40's fog colour 34,28,80 with 17 draws under its 42-yard fog —
  // the nearer volume is blended last.
  const nested = resolveLighting(azeroth, -10324.8, 370.4, 1471.6, 0, 71);
  assert.deepEqual(bytes(nested.colours.fog).map((value, index) => Math.abs(value - [34, 28, 80][index]) <= 1), [true, true, true]);
  assert.ok(nested.fogEnd < 45);
});

test("SMSG_OVERRIDE_LIGHT fades in, hands over and fades out as Wow.exe drew it", { skip: existsSync(DATASET_DBC) ? false : `no dataset at ${DATASET_DBC}` }, async () => {
  const azeroth = (await loadLightMetadata(DATASET_DBC)).get(0);
  // WowOracle light11-o-*: the player inside Light 15's inner radius at noon; packets through the stand's /raw as
  // TrinityCore's OverrideLight writes them (area, override, ms). Each frame: ms after its packet, then Wow.exe's fog
  // end and diffuse. The weight runs on the packet's own clock; the stand's frames lag ours by about one frame (35 ms),
  // so the fog end is held to 4 yards and the colours to 2.
  const at = (overrides, ms) => resolveLighting(azeroth, -10062.6, -1058, 1440 + ms / 30000, 0, 150, overrides);
  const check = (name, sample, end, diffuse) => {
    assert.ok(Math.abs(sample.fogEnd - end) < 4, `${name} fog end: ours ${sample.fogEnd}, Wow.exe ${end}`);
    const ours = bytes(sample.colours.diffuse);
    for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(ours[channel] - diffuse[channel]) <= 2, `${name} diffuse: ours ${ours}, Wow.exe ${diffuse}`);
  };
  const list = new LightOverrideList();
  // Light 1, the map's default row at the origin, keeps its radii of 0 unscaled: an override on it reaches nothing.
  list.receive(1, 6, 1000, 0);
  check("o-area1", at(list.advance(3045), 0), 180.56, [130, 184, 222]);
  list.receive(1, 0, 500, 3045);
  list.advance(5000);
  // Light 6 (set 21) over Light 15's place, 8 s.
  list.receive(15, 6, 8000, 10000);
  for (const [ms, end, diffuse] of [[1558, 272, [153, 187, 205]], [4016, 422.46, [192, 193, 179]], [6467, 570.84, [230, 200, 152]], [9920, 666.67, [254, 204, 136]]]) {
    check(`o-a-${ms}`, at(list.advance(10000 + ms), 0), end, diffuse);
  }
  // A second packet for the same area: the first entry fades out while Light 41 (set 55) fades in, both laid in list order.
  list.receive(15, 41, 8000, 20000);
  for (const [ms, end, diffuse] of [[2046, 474.66, [204, 191, 181]], [4011, 346.39, [171, 182, 215]], [5978, 274.89, [152, 175, 240]], [9937, 263.89, [148, 170, 254]]]) {
    check(`o-b-${ms}`, at(list.advance(20000 + ms), 0), end, diffuse);
  }
  // Override 0 fades the area's first live entry (41) out over 4 s.
  list.receive(15, 0, 4000, 30000);
  for (const [ms, end, diffuse] of [[1046, 243.33, [144, 174, 246]], [3008, 202.1, [134, 180, 230]], [5961, 180.56, [130, 184, 222]]]) {
    check(`o-c-${ms}`, at(list.advance(30000 + ms), 0), end, diffuse);
  }
  assert.equal(list.size, 0);
});

// The outlines live only in the user's own Wow.exe (zone-light-outlines.test.mjs reads them the same way).
const CLIENT = process.env.CLIENT_DIR ?? "F:/Circle";
test("across a Northrend zone border the two outline lights mix as Wow.exe drew them", {
  skip: existsSync(DATASET_DBC) && existsSync(`${CLIENT}/Wow.exe`) ? false : "no dataset or no Wow.exe",
}, async () => {
  const northrend = (await loadLightMetadata(DATASET_DBC, CLIENT)).get(571);
  assert.equal(northrend.zoneOutlines?.length, 11);
  // WowOracle light11-nc-* (Borean Tundra 914 | Dragonblight 825, over the sea) and light11-nd-* (Crystalsong 1740 |
  // Dragonblight 825), noon, no Light.dbc volume within 120 yards. At the edge both outlines weigh about 0.5 and 914 is
  // blended before 825 (table order): the other order gives diffuse 137 red instead of 93.
  for (const [name, x, y, z, ambient, diffuse, fog] of [
    ["nc-m100", 2769.0, 3319.9, 80, [94, 104, 114], [176, 164, 152], [118, 136, 166]],
    ["nc-m25", 2763.9, 3245.1, 80, [84, 108, 116], [135, 165, 160], [93, 147, 169]],
    ["nc-0", 2762.2, 3220.2, 80, [80, 114, 118], [93, 167, 169], [73, 154, 170]],
    ["nc-p25", 2760.5, 3195.2, 80, [84, 124, 118], [47, 169, 182], [55, 156, 163]],
    ["nc-p100", 2755.4, 3120.4, 80, [96, 136, 116], [0, 170, 196], [42, 152, 152]],
    ["nd-m100", 4941.5, -699.9, 680, [164, 130, 188], [162, 140, 182], [80, 60, 116]],
    ["nd-m25", 4866.5, -697.9, 680, [130, 120, 169], [158, 148, 172], [79, 93, 139]],
    ["nd-0", 4841.6, -697.3, 680, [109, 118, 151], [127, 155, 173], [71, 117, 151]],
    ["nd-p25", 4816.6, -696.6, 680, [97, 123, 133], [72, 163, 181], [58, 138, 155]],
  ]) {
    const sample = resolveLighting(northrend, x, y, 1441.5, 0, z);
    for (const [key, recorded] of [["ambient", ambient], ["diffuse", diffuse], ["fog", fog]]) {
      const ours = bytes(sample.colours[key]);
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(ours[channel] - recorded[channel]) <= 2, `${name} ${key}: ours ${ours}, Wow.exe ${recorded}`);
      }
    }
  }
});

test("looking toward the sun dims the terrain's light as Wow.exe drew it (0x007816f0)", () => {
  // WowOracle light11-d-*: 19:30, the player inside Light 15's inner radius, first-person view. With the glare out
  // (facing away, the sun off the screen to the side, or the sun behind the ground) the terrain pair is the light itself.
  const light = { ambient: [40, 72, 104], diffuse: [106, 164, 206] };
  const fraction = 2340 / 2880;
  const polar = skyKeyCurve(SUN_POLAR, fraction);
  const azimuth = skyKeyCurve(SUN_AZIMUTH, fraction);
  const sun = [Math.cos(azimuth) * Math.sin(polar), Math.sin(azimuth) * Math.sin(polar), Math.cos(polar)];
  const sample = {
    colours: {
      ambient: { r: light.ambient[0] / 255, g: light.ambient[1] / 255, b: light.ambient[2] / 255 },
      diffuse: { r: light.diffuse[0] / 255, g: light.diffuse[1] / 255, b: light.diffuse[2] / 255 },
    },
  };
  // The frame's view (K forward) and the terrain pair it drew; the glare's `current` is 1 (open sky, settled).
  for (const [name, forward, ambient, diffuse] of [
    ["d-z150", [0.69664, 0.69609, -0.17365], [33, 59, 85], [88, 133, 167]],
    ["d-side23", [0.37058, 0.91242, -0.17365], [37, 67, 96], [100, 151, 190]],
  ]) {
    const facing = forward.reduce((sum, value, index) => sum + value * sun[index], 0);
    const dimmed = dimLightSampleByGlare(sample, glareDimming(SUN_GLARE, facing, 1));
    const ours = { ambient: bytes(dimmed.colours.ambient), diffuse: bytes(dimmed.colours.diffuse) };
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(ours.ambient[channel] - ambient[channel]) <= 2, `${name} ambient: ours ${ours.ambient}, Wow.exe ${ambient}`);
      assert.ok(Math.abs(ours.diffuse[channel] - diffuse[channel]) <= 2, `${name} diffuse: ours ${ours.diffuse}, Wow.exe ${diffuse}`);
    }
  }
});
