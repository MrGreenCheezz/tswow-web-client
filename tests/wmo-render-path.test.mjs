import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { parseWmoVisual, wmoDependencies, wmoGroupMeshes } from "../tools/wmo-visual.mjs";
import { WWM_CLASSIC_VERTEX_LIGHT, WWM_VERTEX_ALPHA_UNFIXED, encodeWwm } from "../tools/wwm.mjs";
import {
  classicWmoLight, decodeWwm, wmoDoodadInAperture, wmoDoodadRoomVisible, wmoFloorLight, wmoInteriorGroupAt,
  wmoInteriorOnly, wmoVertexLight,
} from "../dist/code/browser/WmoModel.js";
import { selectWmoPortalGroups } from "../dist/code/browser/WmoOcclusion.js";
import { wmoGroupsInRange } from "../dist/code/browser/WorldRenderer3D.js";
import {
  INDOOR_M2_AMBIENT_PEAK, INDOOR_M2_DIFFUSE_PEAK, createWorldLightUniforms, indoorM2Light,
  setWorldLightIndoor, setWorldLightShadowSuppressed,
} from "../dist/code/browser/WorldLighting.js";

const srgbToLinear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const f32 = (value) => Math.fround(value);

/** One indoor group of `vertices` [x, y, z, r, g, b, a] over the given triangles, ready to encode. */
function room(vertices, triangles, { flags = 0x2805, runs } = {}) {
  const positions = new Float32Array(vertices.flatMap((vertex) => vertex.slice(0, 3)));
  const colours = new Uint8Array(vertices.flatMap((vertex) => vertex.slice(3, 7)));
  const indices = new Uint32Array(triangles.flat());
  const xs = vertices.map((vertex) => vertex[0]), ys = vertices.map((vertex) => vertex[1]), zs = vertices.map((vertex) => vertex[2]);
  return {
    flags, indoor: (flags & 0x2000) !== 0,
    min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
    portalStart: 0, portalCount: 0, lightRefs: [], fogIds: [],
    positions, uvs: new Float32Array(vertices.length * 2), colours, indices,
    runs: runs ?? [{ start: 0, count: indices.length, material: 0, blendMode: 0, materialFlags: 0, lighting: 1 }],
  };
}

function encodeModel(model) {
  const bytes = encodeWwm(model, [], undefined);
  return { bytes, decoded: decodeWwm(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "") };
}

const QUAD = room([
  [0, 0, 0, 100, 80, 90, 0], [4, 0, 0, 64, 50, 61, 0], [4, 4, 0, 30, 20, 10, 0], [0, 4, 0, 100, 80, 90, 128],
], [[0, 1, 2], [0, 2, 3]]);
const MODEL = { textures: [], ambient: [64, 50, 61], lights: [], groups: [QUAD], fogs: [], portals: undefined };

test("the MOHD render path travels in the WWM header", () => {
  // Gundrak's 0x5 is the classic MapObj path; Stormwind's 0xF the unified one with MOCV alpha left
  // unfixed. An artifact without the word keeps the unified light it was always given.
  const classic = encodeModel({ ...MODEL, renderFlags: 0x5 });
  assert.equal(classic.bytes[13] & (WWM_CLASSIC_VERTEX_LIGHT | WWM_VERTEX_ALPHA_UNFIXED), WWM_CLASSIC_VERTEX_LIGHT);
  assert.equal(classic.decoded.vertexLight, "classic");
  assert.equal(classic.decoded.vertexAlphaFixed, true);
  const unified = encodeModel({ ...MODEL, renderFlags: 0xf });
  assert.equal(unified.bytes[13] & (WWM_CLASSIC_VERTEX_LIGHT | WWM_VERTEX_ALPHA_UNFIXED), WWM_VERTEX_ALPHA_UNFIXED);
  assert.equal(unified.decoded.vertexLight, "unified");
  assert.equal(unified.decoded.vertexAlphaFixed, false);
  const unknown = encodeModel(MODEL);
  assert.equal(unknown.bytes[13] & (WWM_CLASSIC_VERTEX_LIGHT | WWM_VERTEX_ALPHA_UNFIXED), 0);
  assert.equal(unknown.decoded.vertexLight, "unified");
});

test("a classic room is lit by its baked colour, a unified one by the colour plus the ambient", () => {
  const normals = new Float32Array(12);
  const ambient = [64, 50, 61];
  const lamp = { position: [2, 2, 1], colour: [255, 200, 150], intensity: 1, attenuationStart: 0, attenuationEnd: 10, attenuates: true };
  const mesh = { ...QUAD, lightRefs: new Uint16Array([0]) };
  const classic = wmoVertexLight(mesh, normals, ambient, [lamp], "classic");
  // Vertex 0: MOCV alone. Vertex 1: MOCV equal to the ambient, the level Gundrak bakes its unlit
  // stone at on 35.4% of its vertices. Vertex 2: below the ambient, floored at it by the load step.
  // Vertex 3: alpha 128 brightens by 1 + 128/64, past white and up to twice the texture.
  assert.deepEqual([...classic.subarray(0, 3)], [100, 80, 90].map((c) => f32(srgbToLinear(c / 255))));
  assert.deepEqual([...classic.subarray(3, 6)], ambient.map((c) => f32(srgbToLinear(c / 255))));
  assert.deepEqual([...classic.subarray(6, 9)], ambient.map((c) => f32(srgbToLinear(c / 255))));
  assert.deepEqual([...classic.subarray(9, 12)], [300, 240, 270].map((c) => f32(srgbToLinear(c / 255))));
  assert.equal(classicWmoLight(255, 255, 0), srgbToLinear(2), "the Mod2x ceiling is twice the texture");
  // The classic bake already holds the lamps: a MOLR reference changes nothing on this path.
  assert.deepEqual(classic, wmoVertexLight({ ...mesh, lightRefs: new Uint16Array() }, normals, ambient, [], "classic"));
  // A group with no MOCV keeps the white the encoder wrote for it, and no alpha boost.
  assert.ok(wmoVertexLight(mesh, normals, ambient, [], "classic", false).every((value) => value === 1));

  const unified = wmoVertexLight({ ...mesh, lightRefs: new Uint16Array() }, normals, ambient, []);
  assert.deepEqual([...unified.subarray(0, 3)], [164, 130, 151].map((c) => f32(srgbToLinear(c / 255))),
    "the unified sum is unchanged: MOCV + MOHD ambient");
  assert.deepEqual([...unified.subarray(3, 6)], [128, 100, 122].map((c) => f32(srgbToLinear(c / 255))),
    "which lights a classic room's unlit stone at twice its ambient");

  // 05.10-A7b-2 (7.17): the unified vertex program (`mapobjudiffuse_t1.bls`, lit variants) is
  // clamp(ambient + sun + Σ lamps) · c28 + MOCV (+ emissive): a lamp the group names adds to the
  // ambient + MOCV sum; the classic one has no such term — its lamps are in MOCV.
  const lit = wmoVertexLight(mesh, normals, ambient, [lamp]);
  let added = 0;
  for (let index = 0; index < lit.length; index++) {
    assert.ok(lit[index] >= unified[index] - 1e-6, `the lamp never darkens (${index})`);
    if (lit[index] > unified[index] + 1e-4) added++;
  }
  assert.ok(added > 0, "the unified sum includes the group's lamp");
});

test("a building of rooms alone keeps its MODR rooms; one with a street does not carry them", () => {
  const rooms = [{ offsets: [0, 1, 3, 3], groups: [0, 0, 1] }];
  const second = room([[10, 0, 0, 90, 90, 90, 0], [14, 0, 0, 90, 90, 90, 0], [14, 4, 0, 90, 90, 90, 0]], [[0, 1, 2]]);
  const interior = encodeModel({ ...MODEL, groups: [QUAD, second], renderFlags: 0x5, doodadRooms: rooms }).decoded;
  assert.equal(wmoInteriorOnly(interior), true);
  assert.equal(interior.doodadRooms.length, 1);
  assert.deepEqual([...interior.doodadRooms[0].offsets], [0, 1, 3, 3]);
  assert.deepEqual([...interior.doodadRooms[0].groups], [0, 0, 1]);
  const shown = new Uint8Array([0, 1]);
  assert.equal(wmoDoodadRoomVisible(interior.doodadRooms[0], 0, shown), false, "its only room is hidden");
  assert.equal(wmoDoodadRoomVisible(interior.doodadRooms[0], 1, shown), true, "one of its two rooms shows");
  assert.equal(wmoDoodadRoomVisible(interior.doodadRooms[0], 2, shown), undefined, "a record no room names");
  assert.equal(wmoDoodadRoomVisible(interior.doodadRooms[0], 3, shown), undefined, "an ordinal past the table");

  const porch = { ...second, flags: 0x8 | 0x4, indoor: false };
  const street = encodeModel({ ...MODEL, groups: [QUAD, porch], renderFlags: 0x5, doodadRooms: rooms });
  assert.equal(wmoInteriorOnly(street.decoded), false);
  assert.deepEqual(street.decoded.doodadRooms, [], "no WME4 on a building with a street");
  const plain = encodeModel({ ...MODEL, groups: [QUAD, porch], renderFlags: 0x5 });
  assert.equal(street.bytes.length, plain.bytes.length, "and not a byte of it in its header");
  // A table naming a group the model does not have is dropped whole rather than guessed at.
  const damaged = encodeModel({ ...MODEL, renderFlags: 0x5, doodadRooms: [{ offsets: [0, 1], groups: [7] }] });
  assert.deepEqual(damaged.decoded.doodadRooms, []);
});

test("05.10-A7b-2: a v25 artifact carries MODR rooms for a building with a street too", () => {
  const rooms = [{ offsets: [0, 1, 3, 3], groups: [0, 0, 1] }];
  const porch = { ...room([[10, 0, 0, 90, 90, 90, 0], [14, 0, 0, 90, 90, 90, 0], [14, 4, 0, 90, 90, 90, 0]], [[0, 1, 2]]),
    flags: 0x8 | 0x4, indoor: false };
  const material = { flags: 0x10, shader: 0, blendMode: 0, groundType: 0, sidnColour: [1, 2, 3, 4],
    diffColour: [0, 0, 0, 0], colour2: [0, 0, 0, 0], texture2: "" };
  // v25: the material table rides along (WME5), and so does WME4 before it.
  const v25 = encodeModel({ ...MODEL, groups: [QUAD, porch], renderFlags: 0x5, doodadRooms: rooms, materialTable: [material] });
  assert.equal(wmoInteriorOnly(v25.decoded), false);
  assert.equal(v25.decoded.doodadRooms.length, 1);
  assert.deepEqual([...v25.decoded.doodadRooms[0].offsets], [0, 1, 3, 3]);
  assert.deepEqual([...v25.decoded.doodadRooms[0].groups], [0, 0, 1]);
  assert.equal(v25.decoded.materials?.length, 1, "WME5 is still found behind WME4");
  assert.deepEqual(v25.decoded.materials[0].sidnColour, [1, 2, 3, 4]);
  // v22: no table, no rooms — the same bytes as before the slice.
  const v22 = encodeModel({ ...MODEL, groups: [QUAD, porch], renderFlags: 0x5, doodadRooms: rooms });
  const plain = encodeModel({ ...MODEL, groups: [QUAD, porch], renderFlags: 0x5 });
  assert.deepEqual(v22.decoded.doodadRooms, []);
  assert.equal(Buffer.compare(v22.bytes, plain.bytes), 0);
});

test("the floor light is the room's own baked light under the feet", () => {
  const stacked = room([
    [0, 0, 0, 200, 100, 50, 0], [4, 0, 0, 200, 100, 50, 0], [4, 4, 0, 0, 0, 0, 0], [0, 4, 0, 0, 0, 0, 0],
    [0, 0, 5, 255, 255, 255, 0], [4, 0, 5, 255, 255, 255, 0], [4, 4, 5, 255, 255, 255, 0],
    [0, 0, -10, 10, 20, 30, 0], [4, 0, -10, 10, 20, 30, 0], [4, 4, -10, 10, 20, 30, 0], [0, 4, -10, 10, 20, 30, 0],
  ], [[0, 1, 2], [0, 2, 3], [4, 5, 6], [7, 8, 9], [7, 9, 10]]);
  const { decoded } = encodeModel({ ...MODEL, ambient: [20, 20, 20], groups: [stacked], renderFlags: 0x5 });
  const upper = wmoFloorLight(decoded, 3, 2, 0.1);
  // Halfway across the floor's gradient at (3, 2): half of (200, 100, 50) and half of its black
  // corner, which the classic load step floors at the ambient (20). The ceiling above is no floor.
  assert.deepEqual(upper.map((value) => Math.round(value * 255)), [110, 60, 35]);
  const lower = wmoFloorLight(decoded, 3, 2, -9.9);
  assert.deepEqual(lower.map((value) => Math.round(value * 255)), [20, 20, 30], "the storey below");
  assert.equal(wmoFloorLight(decoded, 20, 20, 0), undefined, "no room holds the point");
  assert.equal(wmoFloorLight(decoded, 2, 1, 30), undefined, "nothing within reach below");
  assert.equal(wmoInteriorGroupAt(decoded, 2, 2, -1), 0);
  assert.equal(wmoInteriorGroupAt(decoded, 2, 2, 50), -1);
});

test("an entered building of rooms alone draws its rooms to the environment range", () => {
  const box = (x) => new THREE.Box3(new THREE.Vector3(x, 0, -10), new THREE.Vector3(x + 10, 10, 0));
  const group = (flags) => ({ triangleCount: 2, indoor: (flags & 0x2000) !== 0, exterior: false, flags,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 } });
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const rooms = { groups: [group(0x2000), group(0x2000), group(0x2000)] };
  assert.equal(wmoInteriorOnly(rooms), true);
  // 0, 150 and 450 yards away: entered, a dungeon keeps the first two, as far as the environment
  // goes; from outside it keeps the sixty-yard room leash like any building.
  assert.deepEqual(wmoGroupsInRange(rooms, [box(0), box(150), box(450)], player, 400), [0, 1]);
  assert.deepEqual(wmoGroupsInRange(rooms, [box(0), box(150), box(450)], player), [0]);
  const withPorch = { groups: [group(0x2000), group(0x2000), group(0x8)] };
  assert.equal(wmoInteriorOnly(withPorch), false);
  assert.deepEqual(wmoGroupsInRange(withPorch, [box(0), box(150), box(200)], player), [0, 2],
    "a building with a street keeps its rooms on the sixty-yard leash, its porch on the shell's");
});

test("a room's doodads are kept only where its portals let the camera see them", () => {
  // Three rooms in a row, the camera in the first: the second is seen through portal zero, the
  // third's portal lies right of that opening and is culled (the corridor of wmo-occlusion.test).
  const bounds = (minX, maxX) => ({ minX, minY: -1, minZ: -1, maxX, maxY: 1, maxZ: 1 });
  const groups = [
    { bounds: bounds(-1, 1), indoor: true, exterior: false, portalStart: 0, portalCount: 1 },
    { bounds: bounds(2, 3), indoor: true, exterior: false, portalStart: 1, portalCount: 2 },
    { bounds: bounds(4, 5), indoor: true, exterior: false, portalStart: 3, portalCount: 1 },
  ];
  const portals = {
    vertices: new Float32Array([
      -0.25, -0.5, 0, 0.25, -0.5, 0, 0.25, 0.5, 0, -0.25, 0.5, 0,
      1.4, -0.5, 0, 1.8, -0.5, 0, 1.8, 0.5, 0, 1.4, 0.5, 0,
    ]),
    definitions: [{ startVertex: 0, vertexCount: 4 }, { startVertex: 4, vertexCount: 4 }],
    references: [
      { portal: 0, group: 1, side: 1 }, { portal: 0, group: 0, side: -1 },
      { portal: 1, group: 2, side: 1 }, { portal: 1, group: 1, side: -1 },
    ],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const apertures = new Float32Array(12).fill(7);
  const selection = selectWmoPortalGroups(groups, portals, [0, 1, 2], { x: 0, y: 0, z: 0 }, identity, undefined, apertures);
  assert.deepEqual(selection.groups, [0, 1]);
  assert.deepEqual([...apertures], [-1, 1, -1, 1, -0.25, 0.25, -0.5, 0.5, 1, -1, 1, -1],
    "the camera's room whole, the next through its portal, the culled one empty");
  const untouched = new Float32Array(12).fill(7);
  selectWmoPortalGroups(groups, portals, [0, 1, 2], { x: 20, y: 0, z: 0 }, identity, undefined, untouched);
  assert.ok(untouched.every((value) => value === 7), "a fallback answer writes no rectangles");

  // Doodad 0 stands in the camera's room; 1 in the second; 2 is named by the second and the third.
  const table = { offsets: new Uint32Array([0, 1, 2, 4]), groups: new Uint16Array([0, 1, 1, 2]) };
  const visible = new Uint8Array([1, 1, 0]);
  const at = (x, radius = 0.1) => ({ x, y: 0, z: 0, radius });
  assert.equal(wmoDoodadInAperture(table, 0, visible, apertures, identity, at(3), 0), true,
    "the camera's room is seen whole: even off screen, the frustum test decides, not a rectangle");
  assert.equal(wmoDoodadInAperture(table, 1, visible, apertures, identity, at(0), 0), true, "in the doorway's view");
  assert.equal(wmoDoodadInAperture(table, 1, visible, apertures, identity, at(0.8), 0), false, "behind the wall beside it");
  assert.equal(wmoDoodadInAperture(table, 1, visible, apertures, identity, at(0.4), 0), false);
  assert.equal(wmoDoodadInAperture(table, 1, visible, apertures, identity, at(0.4), 0.1), true,
    "the margin keeps an edge doodad for the frame admission runs behind");
  assert.equal(wmoDoodadInAperture(table, 2, visible, apertures, identity, at(0.8), 0), false,
    "a hidden second room lends no view");
  // A perspective w = -z: a sphere reaching the eye plane or behind it cannot be bounded by its
  // corners (behind the eye they project mirrored), so it is left to the frustum test.
  const perspective = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0];
  assert.equal(wmoDoodadInAperture(table, 1, visible, apertures, perspective, { x: 5, y: 0, z: 0.05, radius: 0.1 }, 0), true);
  assert.equal(wmoDoodadInAperture(table, 1, visible, apertures, perspective, { x: 5, y: 0, z: 2, radius: 0.1 }, 0), true);
  assert.equal(wmoDoodadInAperture(table, 1, visible, apertures, perspective, { x: 5, y: 0, z: -1, radius: 0.1 }, 0), false);
});

test("units in a building of rooms take the doodads' indoor equation and no sun", () => {
  const colour = [0.5, 0.4, 0.45];
  const pair = indoorM2Light(colour);
  const ambient = Math.min(1, INDOOR_M2_AMBIENT_PEAK / 0.5);
  const diffuse = Math.max(1, INDOOR_M2_DIFFUSE_PEAK / 0.5);
  assert.deepEqual(pair, {
    ambient: { r: 0.5 * ambient, g: 0.4 * ambient, b: 0.45 * ambient },
    diffuse: { r: 0.5 * diffuse, g: 0.4 * diffuse, b: 0.45 * diffuse },
  });
  const uniforms = createWorldLightUniforms();
  uniforms.wowRimStrength.value = 0.8;
  setWorldLightIndoor(uniforms, colour, [-0.30822, 0.9, 0.30822]);
  assert.ok(Math.abs(uniforms.wowAmbient.value.r - pair.ambient.r) < 1e-7);
  assert.ok(Math.abs(uniforms.wowDiffuse.value.g - pair.diffuse.g) < 1e-7, "no headroom, like the doodad shader");
  assert.ok(Math.abs(uniforms.wowSunDirection.value.length() - 1) < 1e-7);
  assert.equal(uniforms.wowRimStrength.value, 0);

  const fade = uniforms.wowShadowFade.value;
  fade.set(40, 92, 0.1);
  setWorldLightShadowSuppressed(uniforms, true);
  assert.deepEqual(fade.toArray(), [0, 0.0001, 0.1], "the sun's term fades out before the first fragment");
  setWorldLightShadowSuppressed(uniforms, false);
  assert.deepEqual(fade.toArray(), [40, 92, 0.1], "and comes back as configured");
  setWorldLightShadowSuppressed(uniforms, true);
  fade.set(30, 120, 0.1); // a lighting-quality change while indoors
  setWorldLightShadowSuppressed(uniforms, true);
  setWorldLightShadowSuppressed(uniforms, false);
  assert.deepEqual(fade.toArray(), [30, 120, 0.1], "the newer configuration wins over the stale copy");
});

test("the renderer notes interior-only buildings, lights units by the room and hides the dome", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /const entered = staticEnvironment && wmoInteriorOnly\(placed\.model\) && this\.#enteredInteriorOnly\(placed, player\);/);
  assert.match(source, /if \(entered\) distanceGroups = this\.#interiorOnlyRange\(placed, player\);/);
  assert.match(source, /entered \? this\.#interiorOnlyRoomsOf\(placed\)\.apertures : undefined,/);
  assert.match(source, /if \(portalSelection\.used\) \{\r?\n\s+selected = portalSelection\.groups;\r?\n\s+clipped = entered;/,
    "the rectangles count only when the walk was used");
  assert.match(source, /if \(entered && !clipped\) selected = roomLeash;/,
    "without a portal walk an entered building keeps the sixty-yard rooms");
  assert.match(source, /if \(entered\) this\.#noteInteriorOnly\(placed, player, selected, clipped\);/);
  assert.match(source, /#updateSkybox\(camera: THREE\.Camera, client: EnvironmentClient \| undefined\): void \{\r?\n\s+this\.#settleInteriorOnly\(\);/);
  assert.match(source, /setWorldLightIndoor\(this\.#worldLight, room, MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION\)/);
  assert.match(source, /setWorldLightShadowSuppressed\(this\.#worldLight, room !== undefined\)/);
  assert.match(source, /interiorOnlyDoodadShown\(object\) === false \? undefined : "interior"/);
  assert.match(source, /this\.#sky\.visible = !this\.#interiorOnlyCamera;/);
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

async function readBuilding(path) {
  const root = await archives.read(path);
  assert.ok(root, `${path} is in the client`);
  const groups = [];
  for (const group of wmoDependencies(root, path).groups) groups.push(await archives.read(group));
  return wmoGroupMeshes(parseWmoVisual(root, groups, path));
}

test("Gundrak is classic rooms alone, lit once by its ambient; Stormwind stays unified", withClient, async () => {
  const gundrak = await readBuilding("World\\wmo\\Dungeon\\ND_Gundrak\\GundrakInterior.wmo");
  assert.equal(gundrak.renderFlags, 0x5);
  assert.deepEqual(gundrak.ambient, [64, 50, 61]);
  const bytes = encodeWwm(gundrak, gundrak.textures.map(() => ""), new Set());
  const decoded = decodeWwm(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  assert.equal(decoded.vertexLight, "classic");
  assert.equal(wmoInteriorOnly(decoded), true, "all 24 groups are rooms");
  // One doodad set of 962, every one owned by a room; record 113 by four of them.
  assert.equal(decoded.doodadRooms.length, 1);
  assert.equal(decoded.doodadRooms[0].offsets.length, 963);
  const owners = (ordinal) => [...decoded.doodadRooms[0].groups.subarray(
    decoded.doodadRooms[0].offsets[ordinal], decoded.doodadRooms[0].offsets[ordinal + 1])];
  assert.deepEqual(owners(113), [0, 1, 2, 18]);
  for (let ordinal = 0; ordinal < 962; ordinal++) assert.ok(owners(ordinal).length > 0, `doodad ${ordinal} has a room`);
  // Group 18, HubSacrificeLinkPipe, is baked at exactly the ambient: the classic light is that
  // ambient, where the unified sum lit it at twice.
  const pipe = gundrak.groups[18];
  const normals = new Float32Array(pipe.positions.length);
  const classic = wmoVertexLight(pipe, normals, gundrak.ambient, [], "classic");
  const unified = wmoVertexLight(pipe, normals, gundrak.ambient, []);
  assert.deepEqual([...classic.subarray(0, 3)], [64, 50, 61].map((c) => f32(srgbToLinear(c / 255))));
  assert.deepEqual([...unified.subarray(0, 3)], [128, 100, 122].map((c) => f32(srgbToLinear(c / 255))));

  const stormwind = await readBuilding("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo");
  assert.equal(stormwind.renderFlags, 0xf);
  const city = encodeWwm(stormwind, stormwind.textures.map(() => ""), new Set());
  const cityDecoded = decodeWwm(city.buffer.slice(city.byteOffset, city.byteOffset + city.byteLength), "");
  assert.equal(cityDecoded.vertexLight, "unified");
  assert.equal(wmoInteriorOnly(cityDecoded), false);
  assert.deepEqual(cityDecoded.doodadRooms, []);
});
