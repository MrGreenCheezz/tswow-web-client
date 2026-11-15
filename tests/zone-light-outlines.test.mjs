// 15.11 (light7): Northrend's zone lights come from Wow.exe's own zone outlines, not from Light.dbc radii.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveLighting } from "../dist/code/browser/LightClient.js";
import { zoneOutlineSignedDistance, zoneOutlineWeights } from "../dist/code/browser/ZoneLightOutlines.js";
import { parseOutlinePath, parseZoneLightOutlines } from "../dist/code/gateway/ZoneLightOutlines.js";
import { attachZoneLightOutlines } from "../dist/code/gateway/LightMetadata.js";

const ZP = 17066.666;
const NOON = 1440;

// Light sets at noon as this dataset's LightParams rows give them (the gateway's /dbc/light/571?v=6 on 15.11):
// 569 is Northrend's default row 752; 810 is Light row 1777's slot 0, the Storm Peaks outline's light.
function noonSet(ambient, diffuse, fog, fogEnd, fogScale) {
  const colours = {};
  for (const channel of ["skyTop", "skyUpper", "skyMiddle", "skyLower", "skyHorizon", "oceanClose", "oceanFar",
    "riverClose", "riverFar"]) colours[channel] = { times: [NOON], values: [fog] };
  colours.ambient = { times: [NOON], values: [ambient] };
  colours.diffuse = { times: [NOON], values: [diffuse] };
  colours.fog = { times: [NOON], values: [fog] };
  return { colours, fogEnd: { times: [NOON], values: [fogEnd] }, fogScale: { times: [NOON], values: [fogScale] } };
}
const DEFAULT_569 = noonSet(0x1f527d, 0xc7a886, 0x56b3d4, 888.8888888888889, 0);
const STORM_PEAKS_810 = noonSet(0x725c72, 0x7c8ca2, 0x444364, 1111.111111111111, 0.1);
// The stand's camera at fog6-n-stormpeaks (WowOracle runs, 15.11).
const STAND = { x: 6127, y: -1027, z: 480 };

// A square outline around the point: the real ones are Wow.exe's own data and live only in the user's client.
function square(cx, cy, half, lightId) {
  return { map: 571, lightId, points: [cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half] };
}

function northrend(outlines) {
  return {
    fallback: 569, fallbackLightId: 752,
    params: { 569: DEFAULT_569, 810: STORM_PEAKS_810 },
    // Row 1777 as Light.dbc has it: a 13.5-yard sphere, 1478 yards from the stand's point.
    volumes: [{ id: 1777, x: 7263.1, y: -1051.6, z: 1425, innerRadius: 13.5, outerRadius: 13.7, params: 810 }],
    lights: { 752: { params: 569 }, 1777: { params: 810 } },
    ...(outlines ? { zoneOutlines: outlines } : {}),
  };
}

const byte = (value) => Math.round(value * 255);
const bytes = (colour) => [byte(colour.r), byte(colour.g), byte(colour.b)];

test("inside a zone outline the frame takes the outline's light, as Wow.exe drew Storm Peaks", () => {
  const before = resolveLighting(northrend(undefined), STAND.x, STAND.y, NOON, 0, 3, STAND.z);
  assert.deepEqual(bytes(before.colours.ambient), [0x1f, 0x52, 0x7d], "without the outlines: Northrend's default");

  const sample = resolveLighting(northrend([square(STAND.x, STAND.y, 400, 1777)]), STAND.x, STAND.y, NOON, 0, 3, STAND.z);
  // Recorded terrain constants on draw 619 of fog6-n-stormpeaks: c25 = 0.44706 0.36078 0.44706, c26 = 0.48628
  // 0.54902 0.63529, PS c2 = 0.26667 0.25882 0.39216; VS c12 gives start 127.7 of 1277, a share of 0.1.
  assert.deepEqual(bytes(sample.colours.ambient), [114, 92, 114]);
  assert.deepEqual(bytes(sample.colours.diffuse), [124, 140, 162]);
  const fog = bytes(sample.colours.fog);
  for (const [index, recorded] of [68, 66, 100].entries()) assert.ok(Math.abs(fog[index] - recorded) <= 1, `fog ${fog}`);
  assert.ok(Math.abs(sample.fogStart / sample.fogEnd - 0.1) < 1e-6);
});

test("the outline's light fades over 50 yards on each side of its edge", () => {
  const outline = square(0, 0, 1000, 1777);
  // 0x0077eed0: distance negative inside; 0x007ee6b0: weight (50 - distance) / 100, clamped.
  assert.ok(Math.abs(zoneOutlineSignedDistance(outline, 0, 0) + 1000) < 1e-6);
  assert.ok(Math.abs(zoneOutlineSignedDistance(outline, 1025, 0) - 25) < 1e-6);
  assert.deepEqual(zoneOutlineWeights([outline], undefined, 0, 0), [{ lightId: 1777, weight: 1 }]);
  assert.deepEqual(zoneOutlineWeights([outline], undefined, 1000, 0), [{ lightId: 1777, weight: 0.5 }]);
  assert.deepEqual(zoneOutlineWeights([outline], undefined, 1025, 0), [{ lightId: 1777, weight: 0.25 }]);
  assert.deepEqual(zoneOutlineWeights([outline], undefined, 960, 0), [{ lightId: 1777, weight: 0.9 }]);
  assert.deepEqual(zoneOutlineWeights([outline], undefined, 1050, 0), []);
  assert.deepEqual(zoneOutlineWeights([outline], undefined, 0, 1200), []);
  // At most five on the list (0x007ed150).
  const many = Array.from({ length: 7 }, (_, index) => square(0, 0, 500, 2000 + index));
  assert.equal(zoneOutlineWeights(many, undefined, 0, 0).length, 5);

  // Across the edge the two lights mix by that weight.
  const entry = northrend([square(STAND.x + 1000, STAND.y, 1000, 1777)]);
  const edge = resolveLighting(entry, STAND.x, STAND.y, NOON, 0, 3, STAND.z);
  assert.ok(Math.abs(edge.colours.ambient.r - (0x1f + (114 - 0x1f) * 0.5) / 255) < 1e-6);
});

test("a Light.dbc volume falls off linearly between its radii (Wow.exe 0x007ee5d0)", () => {
  const entry = {
    fallback: 569, params: { 569: DEFAULT_569, 810: STORM_PEAKS_810 },
    volumes: [{ id: 1777, x: 100, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 810 }],
  };
  // A quarter of the way out: 0.75 of the volume (a smoothstep gave 0.84).
  const quarter = resolveLighting(entry, 120, 0, NOON);
  assert.ok(Math.abs(quarter.colours.ambient.r - (0x1f + (114 - 0x1f) * 0.75) / 255) < 1e-6);
  const threeQuarters = resolveLighting(entry, 140, 0, NOON);
  assert.ok(Math.abs(threeQuarters.colours.ambient.r - (0x1f + (114 - 0x1f) * 0.25) / 255) < 1e-6);
});

test("the gateway reads the outline paths the way Wow.exe 0x0077ed40 does", () => {
  assert.deepEqual(parseOutlinePath("L 10,20 L 30.5,40.25 M 50,60 z"), [10, 20, 30.5, 40.25, 50, 60]);
  assert.deepEqual(parseOutlinePath("L 1,2 L 3,4z"), [1, 2, 3, 4]);
  assert.equal(parseOutlinePath("L 1,2 L 3,4"), undefined, "no closing z");

  // A minimal image with build 12340's layout: one section holding the table, the pointers, the constants and the
  // strings at their virtual addresses.
  const SECTION_VA = 0x005e0000;
  const size = 0x110000;
  const raw = 0x400;
  const exe = new Uint8Array(raw + size);
  const view = new DataView(exe.buffer);
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x00004550, true);
  view.setUint16(0x80 + 6, 1, true);
  view.setUint16(0x80 + 20, 0xe0, true);
  view.setUint32(0x80 + 24 + 28, 0x00400000, true);
  const section = 0x80 + 24 + 0xe0;
  view.setUint32(section + 8, size, true);
  view.setUint32(section + 12, SECTION_VA, true);
  view.setUint32(section + 16, size, true);
  view.setUint32(section + 20, raw, true);
  const at = (va) => raw + (va - 0x00400000 - SECTION_VA);
  view.setFloat32(at(0x00a3e8ac), -1.6623375, true);
  view.setFloat32(at(0x00a3e8a8), -145.7316, true);
  view.setFloat32(at(0x00a3e554), 33.333332, true);
  view.setFloat32(at(0x00a1c8a0), 1 / 1024, true);
  view.setFloat32(at(0x009e2ac8), 34133.332, true);
  view.setFloat32(at(0x009e2acc), ZP, true);
  let text = 0x00a00000;
  for (let index = 0; index < 11; index++) {
    view.setUint32(at(0x00adef58 + index * 48), 571, true);
    view.setInt32(at(0x00adef5c + index * 48), -1, true);
    view.setUint32(at(0x00adef60 + index * 48), 1000 + index, true);
    view.setUint32(at(0x00adee48 + index * 4), text, true);
    const path = new TextEncoder().encode(`L ${100 + index},200 L 300,200 L 300,400 z`);
    exe.set(path, at(text));
    text += path.length + 1;
  }
  const outlines = parseZoneLightOutlines(exe);
  assert.equal(outlines.length, 11);
  assert.equal(outlines[3].map, 571);
  assert.equal(outlines[3].lightId, 1003);
  // x' = (103 - 1.66) * 33.33 runs along -y of the world, y' = (200 - 145.73) / 1024 * 34133.33 along -x.
  const along = (103 - 1.6623375) * 33.333332;
  const across = (200 - 145.7316) / 1024 * 34133.332;
  assert.ok(Math.abs(outlines[3].points[0] - (ZP - across)) < 0.05);
  assert.ok(Math.abs(outlines[3].points[1] - (ZP - along)) < 0.05);

  view.setFloat32(at(0x009e2acc), 17000, true);
  assert.equal(parseZoneLightOutlines(exe), undefined, "another build's grid is not read");
  assert.equal(parseZoneLightOutlines(new Uint8Array(64)), undefined);

  // Only to the map that owns the outline's Light row.
  const index = new Map([[571, { volumes: [], params: {}, lights: { 1003: { params: 1 } }, fallback: 1 }]]);
  view.setFloat32(at(0x009e2acc), ZP, true);
  attachZoneLightOutlines(index, parseZoneLightOutlines(exe));
  assert.deepEqual(index.get(571).zoneOutlines.map((outline) => outline.lightId), [1003]);
});

// The real outlines are in the user's own Wow.exe; check the four recorded Northrend frames against them when one is
// on this machine.
const clientExe = process.env.CLIENT_DIR ? join(process.env.CLIENT_DIR, "Wow.exe") : join(process.cwd(), "..", "..", "Circle", "Wow.exe");
test("the client's own outlines put the recorded Northrend points in their zones", { skip: existsSync(clientExe) ? false : `no Wow.exe at ${clientExe}` }, async () => {
  const outlines = parseZoneLightOutlines(await readFile(clientExe));
  assert.ok(outlines, "build 12340's table");
  assert.equal(outlines.length, 11);
  // WowOracle fog6-n-*: each frame's terrain pair and fog colour equal that light's noon set (616, 792, 810, 748).
  for (const [x, y, lightId] of [[2238, 5143, 914], [3712, -700, 825], [6127, -1027, 1777], [6224, -40, 1703]]) {
    assert.deepEqual(zoneOutlineWeights(outlines, 571, x, y), [{ lightId, weight: 1 }], `${x} ${y}`);
  }
  // Dalaran's air (5804, 624) is inside Crystalsong's outline (Light 1740), and volume 1802 (87 yards from its centre,
  // inner radius 405) is blended over it at full weight afterwards, so the frame shows 1802's set 793, as the stand drew.
  assert.deepEqual(zoneOutlineWeights(outlines, 571, 5804, 624), [{ lightId: 1740, weight: 1 }]);
});
