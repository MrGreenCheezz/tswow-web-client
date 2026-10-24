// 23.10 (7.46): Stormwind's lamp posts light up. Owner, 23.10 (the trade district at night): the lamp's
// glass glows faintly, but no halo, no far glow, no pool on the cobbles. The city's 215 lamp posts are
// its WMO's own geometry (four `StormwindLampGlass` panes each, MOMT SIDN) with no MOLT record by any of
// them, 131 of them in open-air groups flagged indoor (`bazaar01`, MOGP 0x2A41); and 124 lamp doodads
// stand in such groups too, all marked `interior` by the tile. Rooms keep their lamps to themselves.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { FarLightGlows, farLightSources } from "../dist/code/browser/FarLightGlows.js";
import { fixtureLightSource } from "../dist/code/browser/FixtureLightSources.js";
import {
  findWmoLanterns, sampleWmoLantern, wmoDoodadOpenAir, wmoGroupOpenAir, wmoLanternGeneration, wmoLanterns,
} from "../dist/code/browser/WmoOpenAirLamps.js";

const SIDN_CLAMPED = 0xd0; // StormwindLampGlass.blp's MOMT flags: SIDN, clamp S and T

/** Builds a mesh from panes: [centre, outward heading in degrees, offset, half width, half height]. */
function paneMesh(runs) {
  const positions = [];
  const indices = [];
  const built = [];
  for (const { panes, materialFlags } of runs) {
    const start = indices.length;
    for (const [[x, y, z], degrees, offset = 0.3, width = 0.2, height = 0.3] of panes) {
      const nx = Math.cos(degrees * Math.PI / 180), ny = Math.sin(degrees * Math.PI / 180);
      const tx = -ny, ty = nx; // n × up points along -t, so (t, up) winds outward
      const base = positions.length / 3;
      for (const [s, u] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        positions.push(x + nx * offset + tx * width * s, y + ny * offset + ty * width * s, z + height * u);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    built.push({ start, count: indices.length - start, material: 0, blendMode: 0, materialFlags, lighting: 0 });
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices), runs: built, uvs: new Float32Array(0),
    colours: new Uint8Array(0), lightRefs: new Uint16Array(0) };
}

const lantern = (centre, offset = 0.3) => [0, 90, 180, 270].map((degrees) => [centre, degrees, offset]);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} != ${expected}`);

test("a lamp post's glass is told from windows by its shape", () => {
  const mesh = paneMesh([
    { materialFlags: SIDN_CLAMPED, panes: lantern([10, 20, 5]) },
    // A window: one plane. A bay window (Dalaran's DAL_WINDOW_04): three adjacent headings, no opposite pair.
    { materialFlags: 0x10, panes: [[[40, 0, 5], 0], [[60, 0, 5], 0, 0.3, 1, 1], [[60, 0, 5], 45, 0.3, 1, 1], [[60, 0, 5], 90, 0.3, 1, 1]] },
    // A glass kiosk four yards across is no lantern; nor is a lantern-shaped box without the night glow.
    { materialFlags: 0x10, panes: lantern([80, 0, 5], 2) },
    { materialFlags: 0xc0, panes: lantern([100, 0, 5]) },
  ]);
  const found = findWmoLanterns(mesh);
  assert.equal(found.length, 3, "one lantern");
  close(found[0], 10); close(found[1], 20); close(found[2], 5);
  // Its panes facing two opposite pairs is the rule: a lantern of two opposite panes only is not one.
  assert.equal(findWmoLanterns(paneMesh([{ materialFlags: 0x10, panes: [[[0, 0, 0], 0], [[0, 0, 0], 90], [[0, 0, 0], 180]] }])).length, 0);
});

test("7.46 review: a lantern's panes found anywhere in a run among hundreds of windows", () => {
  // Stormwind's lanterns do not always keep their panes together in the run; the grid finder links
  // them wherever they are, and 400 window panes a yard apart in a row make no lantern.
  const panes = lantern([5, 5, 5]);
  const windows = Array.from({ length: 400 }, (_, index) => [[20 + index, 0, 5], 90]);
  const run = [panes[0], ...windows.slice(0, 200), panes[2], panes[1], ...windows.slice(200), panes[3]];
  const found = findWmoLanterns(paneMesh([{ materialFlags: 0x10, panes: run }]));
  assert.deepEqual([...found].map((v) => Math.round(v * 100) / 100), [5, 5, 5]);
});

test("open air is MOGP 0x8 or 0x40, the flags Wow.exe lights by the sun", () => {
  assert.equal(wmoGroupOpenAir({ flags: 0x2a41 }), true, "Stormwind's bazaar01: indoor and exterior-lit");
  assert.equal(wmoGroupOpenAir({ flags: 0x1809 }), true, "a canal: outdoor");
  assert.equal(wmoGroupOpenAir({ flags: 0x2a05 }), false, "a shop");
  assert.equal(wmoGroupOpenAir({ flags: 0x2805 }), false, "an inn's room");
});

test("only open-air groups give lanterns, found as their meshes arrive", () => {
  const glass = paneMesh([{ materialFlags: SIDN_CLAMPED, panes: lantern([1, 2, 3]) }]);
  const group = (flags, mesh) => ({ flags, triangleCount: 8, mesh });
  const street = group(0x2a41, glass);
  const room = group(0x2a05, paneMesh([{ materialFlags: SIDN_CLAMPED, panes: lantern([50, 2, 3]) }]));
  const late = group(0x2841, undefined);
  const model = { groups: [street, room, late], lights: [] };
  const before = wmoLanternGeneration();
  const first = wmoLanterns(model);
  assert.deepEqual([...first.positions].map((v) => Math.round(v)), [1, 2, 3], "the street's lantern, never the room's");
  assert.ok(wmoLanternGeneration() > before);
  const generation = first.generation;
  late.mesh = paneMesh([{ materialFlags: SIDN_CLAMPED, panes: lantern([7, 8, 9]) }]);
  const second = wmoLanterns(model);
  assert.equal(second.positions.length, 6);
  assert.ok(second.generation > generation, "a group that arrived later adds its lanterns");
  assert.equal(wmoLanterns({ groups: [room], lights: [] }).positions.length, 0, "an interior-only building has none");
});

test("a lantern lights like a doodad street lamp and wears a halo", () => {
  const sample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };
  assert.equal(sampleWmoLantern(1, 2, 3, undefined, sample), true);
  assert.equal(sample.halo, true);
  assert.equal(sample.client, false);
  assert.equal(sample.radius, 8);
  close(sample.intensity, 1.1);
  assert.deepEqual([sample.colour.x, sample.colour.y, sample.colour.z].map((v) => Math.round(v * 100)), [100, 56, 20]);
  assert.equal(sampleWmoLantern(Number.NaN, 2, 3, 0, sample), false);
});

test("a building's doodad is open air only when every group naming it is", () => {
  const model = {
    groups: [{ flags: 0x2a41 }, { flags: 0x2a05 }],
    doodadRooms: [{ offsets: new Uint32Array([0, 1, 2, 4, 4]), groups: new Uint16Array([0, 1, 0, 1]) }],
  };
  assert.equal(wmoDoodadOpenAir(model, 0, 0), true, "named by the street only");
  assert.equal(wmoDoodadOpenAir(model, 0, 1), false, "named by a room");
  assert.equal(wmoDoodadOpenAir(model, 0, 2), false, "named by both: the room wins");
  assert.equal(wmoDoodadOpenAir(model, 0, 3), false, "named by no group");
  assert.equal(wmoDoodadOpenAir(model, 0, 9), false, "past the table");
  assert.equal(wmoDoodadOpenAir(model, 4, 0), true, "a set without a table reads set 0's, as the renderer binds it");
  assert.equal(wmoDoodadOpenAir({ groups: model.groups }, 0, 0), false, "no WME4: no answer");
  // The fixture test lets such an interior doodad in on the cinematic profile only.
  const torch = { id: -(10047 * 1_000_000 + 1), interior: true };
  assert.equal(fixtureLightSource(torch, true, () => true), true);
  assert.equal(fixtureLightSource(torch, true, () => false), false);
  assert.equal(fixtureLightSource(torch, false, () => true), false, "the faithful profiles never");
  assert.equal(fixtureLightSource(torch, true), false, "and without the answer, as before");
  // 7.46 review: the renderer passes the answer it keeps on the entry.
  assert.equal(fixtureLightSource(torch, true, true), true);
  assert.equal(fixtureLightSource(torch, true, false), false);
  assert.equal(fixtureLightSource(torch, false, true), false);
  assert.equal(fixtureLightSource({ ...torch, localLight: [1, 2, 3, 255] }, true, () => true), false, "room-lit stays out");
  assert.equal(fixtureLightSource({ id: 5, interior: true }, true, () => true), false, "a terrain placement indoors stays out");
});

test("far glows: a city's lanterns glow from afar, and its later groups' lanterns join", () => {
  const glass = (centre) => paneMesh([{ materialFlags: SIDN_CLAMPED, panes: lantern(centre) }]);
  const late = { flags: 0x2a41, triangleCount: 8, mesh: undefined };
  const model = { groups: [{ flags: 0x2a41, triangleCount: 8, mesh: glass([150, 0, 5]) }, late], lights: [] };
  const placement = { source: { id: 10047, name: "WORLD\\WMO\\AZEROTH\\BUILDINGS\\STORMWIND\\STORMWIND.WMO" },
    node: new THREE.Object3D(), wmo: { model, modelToWorld: new THREE.Matrix4() } };
  assert.equal(farLightSources(placement).length, 8); // 24.10 (7.50): + the pool's reach and share (FAR_LIGHT_STRIDE)
  const glows = new FarLightGlows();
  const placements = new Map([[10047, placement]]);
  const camera = new THREE.Vector3(0, 0, 0);
  for (let frame = 0; frame < 40; frame++) glows.update(placements, camera, 0);
  assert.equal(glows.sourceCount, 1);
  assert.equal(glows.mesh.count, 1, "the lantern 150 yards off glows at night");
  late.mesh = glass([0, 200, 5]);
  wmoLanterns(model); // what the renderer's near pass does each frame
  for (let frame = 0; frame < 40; frame++) glows.update(placements, camera, 0);
  assert.equal(glows.sourceCount, 2, "rebuilt once the late group's lantern was found");
});

test("far glows: an interior lamp doodad glows only when its groups are open air", () => {
  const lamp = {
    positions: new Float32Array([0, 0, 0, 0, 0, 4, 1, 0, 4, 0, 1, 4]),
    indices: new Uint16Array([0, 1, 2, 1, 2, 3]),
    submeshes: [{ indexStart: 0, indexCount: 3 }, { indexStart: 3, indexCount: 3 }],
    batches: [
      { submesh: 0, materialFlags: 0, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 },
      { submesh: 1, materialFlags: 1, blendMode: 0, textures: [1], colorIndex: 65535, textureWeight: 0 },
    ],
    textures: [{ path: "KalidarStreetLamp.blp" }, { path: "Dungeons\\Textures\\Doodads\\StormwindLampGlass.blp" }],
    particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(),
  };
  const placement = () => {
    const visual = new THREE.Object3D();
    visual.position.set(100, 0, 0);
    return { source: { id: -(10047 * 1_000_000 + 7), name: "KalidarStreetLamp01.m2", interior: true }, node: visual, visual, wvm: lamp };
  };
  assert.equal(farLightSources(placement()).length, 0, "an interior doodad, as before");
  assert.equal(farLightSources(placement(), () => false).length, 0, "a room's lamp");
  assert.equal(farLightSources(placement(), () => true).length, 8, "a street lamp of an open-air group"); // 24.10 (7.50): FAR_LIGHT_STRIDE
});
