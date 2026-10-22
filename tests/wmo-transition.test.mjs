// 22.10 (7.37): a WMO's transition vertices — the doorways between a room and the street — as Wow.exe
// 12340 lights them: `FixColorVertexAlpha` (0x007D7380) halves them where it brightens every other
// vertex by its alpha, `AttenTransVerts` (0x007D78C0) mixes them towards 127 by the nearness of an
// outdoor portal and makes that the alpha, and the batch renderers draw them sun-lit × α plus room-lit
// × (1 − α). The tools write the result into a `visual-wmo-v27` block (`tools/wmo-transition.mjs`,
// `tools/wwm.mjs` stream bit 2); the browser reads it (`WmoModel.ts`, `WmoTransitionLight.ts`).
// What this does NOT prove: the picture in game (the owner's Goldshire night check).

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  wmoApplyTransitionLight, wmoTransitionAttenuation, wmoTransitionVertexEnd,
} from "../tools/wmo-transition.mjs";
import { WWM_TRANSITION_VERTICES, encodeWwmGroup } from "../tools/wwm.mjs";
import { parseWmoVisual, wmoDependencies, wmoGroupMeshes } from "../tools/wmo-visual.mjs";
import {
  WMO_LIGHT_INTERIOR, WMO_LIGHT_TRANSITION, classicStoredByte, classicWmoLight, decodeWwmGroup, wmoVertexLight,
} from "../dist/code/browser/WmoModel.js";
import { buildWmoGroupGeometry } from "../dist/code/browser/WmoGeometry.js";
import {
  WMO_TRANSITION_GLSL, WMO_TRANSITION_SUN_ATTRIBUTE, applyWmoTransitionBlend, wmoRunBlendsSun,
} from "../dist/code/browser/WmoTransitionLight.js";

const srgb = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} against ${expected}`);

/** A one-quad portal in the plane x = 0, normal +x, the square y, z ∈ [−2, 2]. */
const doorway = (exterior, side = 1) => ({
  normal: [1, 0, 0], distance: 0, side, exterior,
  polygon: [[0, -2, -2], [0, 2, -2], [0, 2, 2], [0, -2, 2]],
});

test("AttenTransVerts: 1 − 0.15·d towards an outdoor portal, 0 within a yard of an inner one", () => {
  // Inside the polygon the distance is the signed plane distance, flipped unless MOPR side is 1.
  near(wmoTransitionAttenuation([2, 0, 0], [doorway(true)]), 0.7, 1e-12, "two yards in front of a door");
  near(wmoTransitionAttenuation([-2, 0, 0], [doorway(true)]), 1, 1e-12, "behind the plane clamps d to 0");
  near(wmoTransitionAttenuation([-2, 0, 0], [doorway(true, -1)]), 0.7, 1e-12, "side −1 flips the distance");
  // Outside the polygon it is the distance from the nearest edge (the one at y = 2).
  near(wmoTransitionAttenuation([0, 5, 0], [doorway(true)]), 1 - 0.15 * 3, 1e-12, "three yards beside the frame");
  assert.equal(wmoTransitionAttenuation([7, 0, 0], [doorway(true)]), 0, "past 6.67 yards the sun has no share");
  // Two outdoor portals sum and clamp to one; any inner portal within a yard wins outright.
  assert.equal(wmoTransitionAttenuation([1, 0, 0], [doorway(true), doorway(true)]), 1);
  assert.equal(wmoTransitionAttenuation([0.5, 0, 0], [doorway(true), doorway(false)]), 0);
  near(wmoTransitionAttenuation([1.5, 0, 0], [doorway(true), doorway(false)]), 1 - 0.15 * 1.5, 1e-12,
    "an inner portal further than a yard is ignored");
  assert.equal(wmoTransitionAttenuation([1, 0, 0], []), 0, "a group without portals is all room");
});

test("the transition range is MOBA[transBatchCount − 1].maxIndex + 1, the bytes the client keeps", () => {
  const mogp = Buffer.alloc(68);
  const moba = Buffer.alloc(24 * 3);
  moba.writeUInt16LE(9, 20);
  moba.writeUInt16LE(41, 24 + 20);
  moba.writeUInt16LE(99, 48 + 20);
  assert.equal(wmoTransitionVertexEnd(mogp, moba, 100), 0, "no transition batches");
  mogp.writeUInt16LE(2, 40);
  assert.equal(wmoTransitionVertexEnd(mogp, moba, 100), 42);
  assert.equal(wmoTransitionVertexEnd(mogp, moba, 30), 30, "never past the group's vertices");

  // Classic (MOHD 0x8 clear): halved, then pulled to 127 by the attenuation; alpha = atten·255.
  const colours = new Uint8Array([200, 100, 0, 255, 200, 100, 0, 7]);
  const positions = [2, 0, 0, 9, 0, 0];
  wmoApplyTransitionLight(colours, positions, 2, [doorway(true)], true);
  const a = Math.fround(0.7);
  assert.deepEqual([...colours.subarray(0, 4)], [
    Math.trunc(100 + 27 * a), Math.trunc(50 + 77 * a), Math.trunc(127 * a), Math.trunc(a * 255)]);
  assert.deepEqual([...colours.subarray(4)], [100, 50, 0, 0], "deep inside: halved, alpha 0, no boost");
  // MOHD 0x8: `FixColorVertexAlpha` never ran, so nothing is halved.
  const unfixed = new Uint8Array([200, 100, 0, 255]);
  wmoApplyTransitionLight(unfixed, [9, 0, 0], 1, [doorway(true)], false);
  assert.deepEqual([...unfixed], [200, 100, 0, 0]);
});

test("classic light: a transition vertex is 2·stored, never boosted by its alpha", () => {
  const ambient = [19, 16, 14];
  // Vertex 0 is a transition vertex (stored bytes 60/40/3, sun share 128); vertex 1 is not (raw 60/40/3, α 100).
  const mesh = {
    positions: new Float32Array(6), uvs: new Float32Array(4), indices: new Uint16Array(0), runs: [],
    lightRefs: new Uint16Array(0), colours: new Uint8Array([60, 40, 3, 128, 60, 40, 3, 100]),
    transitionVertices: 1,
  };
  const light = wmoVertexLight(mesh, new Float32Array(6), ambient, [], "classic");
  for (let channel = 0; channel < 3; channel++) {
    const stored = mesh.colours[channel];
    // 22.10 (7.38): no floor at the ambient — the blue 3 draws as 6, not as the ambient's 14.
    near(light[channel], srgb((2 * stored) / 255), 1e-6, `transition channel ${channel}`);
    near(light[3 + channel], classicWmoLight(classicStoredByte(stored, 100)), 1e-6, `room channel ${channel}`);
  }
  // The room vertex in integers, as 0x007D7380 stores it: (c + (c·100 >> 6)) >> 1 = 76, 51, 3.
  near(light[3], srgb(152 / 255), 1e-6, "room red");
  near(light[5], srgb(6 / 255), 1e-6, "room blue");
  // The same bytes read the old way, brightened by c·(1 + 128/64): more than twice the light.
  assert.ok(srgb(180 / 255) > 2 * light[0]);
});

test("v27 group blocks carry the range in stream bit 2 and decode it; a v26 block has none", () => {
  const group = {
    positions: new Float32Array(9), uvs: new Float32Array(6),
    colours: new Uint8Array([10, 20, 30, 40, 1, 2, 3, 4, 5, 6, 7, 8]), indices: [0, 1, 2],
    runs: [{ start: 0, count: 3, material: 0, lighting: WMO_LIGHT_TRANSITION }],
  };
  const v26 = encodeWwmGroup(group, 3);
  const v27 = encodeWwmGroup({ ...group, transitionVertices: 2 }, 3);
  assert.equal(v26[11] & WWM_TRANSITION_VERTICES, 0);
  assert.equal(v27[11] & WWM_TRANSITION_VERTICES, WWM_TRANSITION_VERTICES);
  assert.equal(v27.length, v26.length + 4);
  const decoded = decodeWwmGroup(v27.buffer.slice(v27.byteOffset, v27.byteOffset + v27.length));
  assert.equal(decoded.mesh.transitionVertices, 2);
  assert.deepEqual([...decoded.mesh.indices], [0, 1, 2]);
  assert.equal(decodeWwmGroup(v26.buffer.slice(v26.byteOffset, v26.byteOffset + v26.length)).mesh.transitionVertices, undefined);
  assert.equal(wmoRunBlendsSun(decoded.mesh, decoded.mesh.runs[0]), true);
  assert.equal(wmoRunBlendsSun(decoded.mesh, { lighting: WMO_LIGHT_INTERIOR }), false);
  assert.equal(wmoRunBlendsSun({ transitionVertices: undefined }, decoded.mesh.runs[0]), false, "an older artifact");

  const bad = Buffer.from(v27);
  const offset = 16 + 3 * 24;
  assert.equal(v27.readUInt32LE(offset), 2, "the count follows the vertex streams");
  bad.writeUInt32LE(4, offset);
  assert.throws(() => decodeWwmGroup(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.length)), /transition range/);

  // The geometry gets the room light and the sun share; the lit material mixes them before the fog.
  const geometry = buildWmoGroupGeometry({
    ambient: [0, 0, 0], textureUrls: [], lights: [], fogs: [], complete: true, vertexLight: "classic",
    groups: [{ bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, flags: 0x4, indoor: false,
      exterior: true, portalStart: 0, portalCount: 0, fogIds: [], vertexCount: 3, triangleCount: 1, mesh: decoded.mesh }],
  }, 0);
  assert.ok(geometry.getAttribute("color"), "a transition run reads the room light even in an outdoor group");
  assert.deepEqual([...geometry.getAttribute(WMO_TRANSITION_SUN_ATTRIBUTE).array].map((v) => Math.round(v * 255)), [40, 4, 0]);
  const material = new THREE.MeshStandardMaterial();
  applyWmoTransitionBlend(material);
  const shader = {
    vertexShader: "#include <begin_vertex>", fragmentShader: "#include <opaque_fragment>", uniforms: {},
  };
  material.onBeforeCompile(shader, undefined);
  assert.match(shader.fragmentShader, /mix\( diffuseColor\.rgb \* vWowWmoRoomLight, outgoingLight, clamp\( vWowWmoSunShare/);
  assert.ok(shader.fragmentShader.indexOf("mix(") < shader.fragmentShader.indexOf("#include <opaque_fragment>"));
  assert.match(WMO_TRANSITION_GLSL.vertexPars, /#ifndef USE_COLOR\s+attribute vec3 color;/);
  assert.match(material.customProgramCacheKey(), /wmo-transition-v1/);
});

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

test("the Goldshire Inn's vestibule: 4.77× the client's light before, the client's own after", withClient, async () => {
  const path = "World\\wmo\\Azeroth\\Buildings\\GoldshireInn\\GoldshireInn.wmo";
  const root = await archives.read(path);
  const groups = [];
  for (const group of wmoDependencies(root, path).groups) groups.push(await archives.read(group));
  const meshOf = (transition) => {
    const block = encodeWwmGroup(wmoGroupMeshes(parseWmoVisual(root, groups, path, { transition })).groups[0], 0);
    return decodeWwmGroup(block.buffer.slice(block.byteOffset, block.byteOffset + block.length)).mesh;
  };
  const before = meshOf(false);
  const after = meshOf(true);
  // Group 0 is the vestibule: 70 vertices, every one drawn by its 3 transition batches (MOHD 0x0, classic).
  assert.equal(after.transitionVertices, 70);
  assert.equal(after.colours.length / 4, 70);
  assert.ok(after.runs.every((run) => run.lighting === WMO_LIGHT_TRANSITION));
  const mean = (mesh) => {
    const light = wmoVertexLight(mesh, new Float32Array(mesh.positions.length), [19, 16, 14], [], "classic");
    return light.reduce((sum, value) => sum + value, 0) / light.length;
  };
  // 22.10 (7.38): 2.649 before the integer store of 0x007D7380 (>> 6, >> 1).
  near(mean(before), 2.644, 0.002, "v26: raw MOCV brightened by its alpha");
  near(mean(after), 0.554, 0.002, "v27: FixColorVertexAlpha + AttenTransVerts");
  let share = 0;
  for (let vertex = 0; vertex < 70; vertex++) share += after.colours[vertex * 4 + 3] / 255;
  near(share / 70, 0.447, 0.003, "mean sun share");
});
