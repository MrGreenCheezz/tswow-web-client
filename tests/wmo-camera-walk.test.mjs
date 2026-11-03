// 02.11: which groups of a building the camera sees (`WmoCameraWalk.ts`): the rule on small graphs, then the rule against
// what Wow.exe 12340 drew on recorded cameras (fixtures/wmo-camera-walk-wow.json: the draw calls matched to each WMO's
// batches; cameras and group indices only).

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { parseAdtPlacements } from "../tools/adt-placements.mjs";
import { parseWmoVisual, wmoDependencies, wmoGroupMeshes } from "../tools/wmo-visual.mjs";
import { encodeWwm } from "../tools/wwm.mjs";
import { decodeWwm } from "../dist/code/browser/WmoModel.js";
import { placeEnvironmentNode, setOutsideInView } from "../dist/code/browser/WorldRenderer3D.js";
import { SHADOW_FAR_LAYER, SHADOW_PROXY_LAYER } from "../dist/code/browser/CascadedShadows.js";
import { createWmoPortalWalkScratch } from "../dist/code/browser/WmoOcclusion.js";
import {
  WMO_GROUP_ALWAYS_DRAW, createWmoCameraWalkState, walkWmoFromCamera, wmoCameraWalkNote, wmoCameraWalkStale,
  wmoGroupIsRoom, wmoGroupOfCollision, wmoGroupTwinCount, wmoGroupTwinsUncertain, wmoHasOutdoorGroup, wmoPlacementOwns, wmoPortalPlanes, wmoWalkReachedOutside,
} from "../dist/code/browser/WmoCameraWalk.js";
import { CollisionMesh, CollisionWorld } from "../dist/code/browser/game/Collision.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const INDOOR = 0x2000, OUTDOOR = 0x8;
const CAMERA = { x: 0, y: 0, z: 0 };

const box = (size = 1) => ({ minX: -size, minY: -size, minZ: -size, maxX: size, maxY: size, maxZ: size });
function group(flags, portalStart = 0, portalCount = 0, triangleCount = 10) {
  return {
    bounds: box(), flags, indoor: (flags & INDOOR) !== 0, exterior: false, portalStart, portalCount, triangleCount,
  };
}
/** A square portal at x = 0.5, facing +x from the vertices' winding, on screen under the identity matrix. */
const SQUARE = [0.5, -0.1, -0.1, 0.5, 0.1, -0.1, 0.5, 0.1, 0.1, 0.5, -0.1, 0.1];
const portals = (references) => ({
  vertices: new Float32Array(SQUARE),
  definitions: [{ startVertex: 0, vertexCount: 4 }],
  references,
});
/** Clip space that sees the square: w = 1 in front of everything. */
const walk = (groups, graph, room, camera = CAMERA, matrix = IDENTITY) =>
  walkWmoFromCamera(groups, graph, room, camera, matrix, undefined, createWmoPortalWalkScratch());

test("a room is the file's indoor flag without the open-sky one", () => {
  assert.equal(wmoGroupIsRoom({ indoor: true, flags: INDOOR }), true);
  assert.equal(wmoGroupIsRoom({ indoor: false, flags: OUTDOOR }), false);
  assert.equal(wmoGroupIsRoom({ indoor: true, flags: INDOOR | OUTDOOR }), false);
  assert.equal(wmoGroupIsRoom({ indoor: false, flags: 0 }), false, "neither bit: not a room, as the older rule read it");
});

test("from a room only that room and what its portals reach: a stand-in with no portals of its own stays out", () => {
  // The cathedral's case: 0 the square, 1 the next room, 2 the far stand-in (outdoor, no portals), 3 an unrelated room.
  const groups = [group(INDOOR, 0, 1), group(INDOOR), group(OUTDOOR), group(INDOOR)];
  const answer = walk(groups, portals([{ portal: 0, group: 1, side: 0 }]), 0);
  assert.equal(answer.used, true);
  assert.deepEqual([...answer.groups], [0, 1]);
});

test("from outside every outdoor group seeds the walk, and a room shows only through a portal", () => {
  const groups = [group(OUTDOOR, 0, 1), group(INDOOR), group(OUTDOOR), group(INDOOR)];
  const answer = walk(groups, portals([{ portal: 0, group: 1, side: 0 }]), -1);
  assert.deepEqual([...answer.groups], [0, 1, 2], "the stand-in shows; the room no portal reaches does not");
});

test("MOGP 0x10000 shows wherever the camera is; having no portals earns nothing", () => {
  const groups = [group(INDOOR, 0, 0), group(INDOOR | WMO_GROUP_ALWAYS_DRAW), group(OUTDOOR | WMO_GROUP_ALWAYS_DRAW), group(OUTDOOR), group(INDOOR)];
  // A graph is needed for the walk to run at all; its one reference leaves group 4, which nothing seeds.
  groups[4].portalCount = 1;
  assert.deepEqual([...walk(groups, portals([{ portal: 0, group: 0, side: 0 }]), 0).groups], [0, 1, 2]);
});

test("a portal leads one way, from the side its reference says", () => {
  const groups = [group(INDOOR, 0, 1), group(INDOOR)];
  const planes = wmoPortalPlanes(portals([{ portal: 0, group: 1, side: 1 }]));
  // Newell's normal of the square's winding: +x, through x = 0.5.
  assert.deepEqual([planes[0], planes[1], planes[2]].map((v) => Math.round(v)), [1, 0, 0]);
  assert.ok(Math.abs(planes[3] + 0.5) < 1e-6);
  const before = { x: 0, y: 0, z: 0 }, beyond = { x: 1, y: 0, z: 0 };
  assert.deepEqual([...walk(groups, portals([{ portal: 0, group: 1, side: 1 }]), 0, before).groups], [0], "behind a +1 reference");
  assert.deepEqual([...walk(groups, portals([{ portal: 0, group: 1, side: 1 }]), 0, beyond).groups], [0, 1], "in front of it");
  assert.deepEqual([...walk(groups, portals([{ portal: 0, group: 1, side: -1 }]), 0, before).groups], [0, 1], "a -1 reference, the other way");
  assert.deepEqual([...walk(groups, portals([{ portal: 0, group: 1, side: -1 }]), 0, beyond).groups], [0]);
});

test("a portal off the screen leads nowhere", () => {
  const groups = [group(INDOOR, 0, 1), group(INDOOR)];
  const moved = [...IDENTITY];
  moved[12] = 5; // Everything five half-screens to the right.
  assert.deepEqual([...walk(groups, portals([{ portal: 0, group: 1, side: 0 }]), 0, CAMERA, moved).groups], [0]);
});

test("a group with nothing to draw is not chosen, and a walk that cannot start says so", () => {
  const empty = [group(INDOOR, 0, 1, 0), group(INDOOR, 0, 0, 0)];
  assert.deepEqual([...walk(empty, portals([{ portal: 0, group: 1, side: 0 }]), 0).groups], []);
  const rooms = [group(INDOOR, 0, 1), group(INDOOR)];
  assert.equal(walk(rooms, portals([{ portal: 0, group: 1, side: 0 }]), -1).used, false, "no outside to start from");
  assert.equal(walk(rooms, portals([{ portal: 0, group: 1, side: 0 }]), 9).used, false, "a room the model does not have");
  assert.equal(walk(rooms, portals([{ portal: 7, group: 1, side: 0 }]), 0).used, false, "a broken graph");
  assert.equal(wmoHasOutdoorGroup(rooms), false);
  assert.equal(wmoHasOutdoorGroup([group(INDOOR), group(OUTDOOR)]), true);
  assert.equal(wmoHasOutdoorGroup([group(INDOOR), group(OUTDOOR, 0, 0, 0)]), false, "an empty outdoor group seeds nothing");
});

test("the collision's group is found by flags and box, not by its index", () => {
  const visual = [
    { flags: INDOOR, bounds: box(1) }, { flags: OUTDOOR, bounds: box(2) }, { flags: INDOOR, bounds: box(3) },
  ];
  // The `.vmo` left group 1 out, so the third group is collision group 1.
  assert.equal(wmoGroupOfCollision(visual, INDOOR, box(3)), 2);
  assert.equal(wmoGroupOfCollision(visual, OUTDOOR, box(2)), 1);
  assert.equal(wmoGroupOfCollision(visual, INDOOR, box(4)), -1, "no such box");
  assert.equal(wmoGroupOfCollision(visual, OUTDOOR, box(1)), -1, "no such flags");
});

test("7.56: twins are told apart by their place among themselves, while the .vmo kept them all", () => {
  const groups = [
    { flags: INDOOR, bounds: box(1) }, { flags: INDOOR, bounds: box(2) }, { flags: OUTDOOR, bounds: box(2) }, { flags: INDOOR, bounds: box(1) },
  ];
  assert.equal(wmoGroupOfCollision(groups, INDOOR, box(1)), 0, "the first by default");
  assert.equal(wmoGroupOfCollision(groups, INDOOR, box(1), 1), 3, "the second twin is the later group, not the first");
  assert.equal(wmoGroupOfCollision(groups, INDOOR, box(1), 2), -1, "there is no third");
  assert.equal(wmoGroupTwinCount(groups, 0), 2);
  assert.equal(wmoGroupTwinCount(groups, 3), 2);
  assert.equal(wmoGroupTwinCount(groups, 1), 1, "the same box with other flags is another group");
  assert.equal(wmoGroupTwinCount(groups, -1), 0, "the group was not found");
  assert.equal(wmoGroupTwinsUncertain(groups, 3, 2), false, "all kept: the count is exact");
  assert.equal(wmoGroupTwinsUncertain(groups, 0, 1), true, "the .vmo left one out: which is which is not known");
  assert.equal(wmoGroupTwinsUncertain(groups, 1, 1), false, "no twins at all");
  assert.equal(wmoGroupTwinsUncertain(groups, -1, 1), true, "not found");
});

test("a still camera walks once", () => {
  const state = createWmoCameraWalkState();
  const rooms = {};
  assert.equal(wmoCameraWalkStale(state, IDENTITY, 3, rooms), true, "never walked");
  wmoCameraWalkNote(state, IDENTITY, 3, rooms);
  assert.equal(wmoCameraWalkStale(state, [...IDENTITY], 3, rooms), false);
  assert.equal(wmoCameraWalkStale(state, IDENTITY, -1, rooms), true, "another room");
  assert.equal(wmoCameraWalkStale(state, IDENTITY, 3, {}), true, "another record to write rectangles into");
  const moved = [...IDENTITY];
  moved[14] += 1e-9;
  assert.equal(wmoCameraWalkStale(state, moved, 3, rooms), true, "the camera moved");
});

test("the surface under a point can be a roof too steep to stand on", () => {
  // A steep slab above a flat floor; both over (0, 0).
  const triangles = (zLow, zHigh) => new Float32Array([-1, -1, zLow, 1, -1, zLow, 0, 1, zHigh]);
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(triangles(10, 10), [{ first: 0, flags: INDOOR, groupIndex: 0, groupId: 1 }]));
  world.set(2, new CollisionMesh(triangles(20, 30), [{ first: 0, flags: OUTDOOR, groupIndex: 1, groupId: 2 }]));
  assert.equal(world.floorHitUnder(0, 0, 100, -100)?.groupIndex, 0, "the floor passes under the roof");
  const surface = world.floorHitUnder(0, 0, 100, -100, undefined, true);
  assert.equal(surface?.groupIndex, 1, "the surface does not");
  assert.equal(surface?.flags, OUTDOOR);
  assert.equal(world.floorHitUnder(0, 0, 15, -100, undefined, true)?.groupIndex, 0, "under the roof, the floor again");
});

test("the renderer asks the walk first, keeps what it leaves out hung, and is told by the live loop", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const update = renderer.slice(renderer.indexOf("  #updateWmoGroups("), renderer.indexOf("  #wmoGroupsFromCamera("));
  assert.match(update, /this\.#wmoGroupsFromCamera\(placed, player\)/);
  assert.match(update, /hung = distanceGroups;/, "the distance leash stays attached for its shadows");
  assert.match(update, /if \(!fromCamera && viewed && \(this\.#indoors \|\| entered\)/, "the older walks stand aside");
  assert.match(update, /if \(!fromCamera && viewed && !entered/);
  assert.match(update, /placed\.appliedHung === hung/, "a change of what hangs is a change");
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /staticWmoSurfaceState\(/);
  assert.match(loop, /if \(cameraWmoSurface !== undefined\) game\.renderer\?\.setCameraWmoSurface\(cameraWmoSurface\);/,
    "while the collision is not current the last answer stands");
});

// 7.53: from a room the outside world is drawn exactly when the walk comes out of the building on screen.
test("the walk comes out of a building only through a portal on screen", () => {
  const out = (groups, graph, room, matrix = IDENTITY) => {
    const scratch = createWmoPortalWalkScratch();
    walkWmoFromCamera(groups, graph, room, CAMERA, matrix, undefined, scratch);
    return wmoWalkReachedOutside(groups, scratch);
  };
  const door = portals([{ portal: 0, group: 1, side: 0 }]);
  assert.equal(out([group(INDOOR, 0, 1), group(OUTDOOR)], door, 0), true);
  assert.equal(out([group(INDOOR, 0, 1), group(INDOOR)], door, 0), false, "the next room is not outside");
  const moved = [...IDENTITY];
  moved[12] = 5; // Everything five half-screens to the right.
  assert.equal(out([group(INDOOR, 0, 1), group(OUTDOOR)], door, 0, moved), false, "the door is off the screen");
  assert.equal(out([group(INDOOR, 0, 1), group(INDOOR), group(OUTDOOR | WMO_GROUP_ALWAYS_DRAW)], door, 0), false,
    "what draws wherever the camera is does not lead out");
  // Three rooms, the far one with the door: the walk has to get there.
  const chain = {
    vertices: new Float32Array(SQUARE), definitions: [{ startVertex: 0, vertexCount: 4 }],
    references: [{ portal: 0, group: 1, side: 0 }, { portal: 0, group: 2, side: 0 }],
  };
  assert.equal(out([group(INDOOR, 0, 1), group(INDOOR, 1, 1), group(OUTDOOR)], chain, 0), true);
});

test("a building owns itself and its doodads; a neighbour's doodads are the world outside", () => {
  const doodad = (placement, ordinal) => ({ id: -(placement * 1_000_000 + ordinal + 1), interior: true });
  assert.equal(wmoPlacementOwns(7, { id: 7 }), true);
  assert.equal(wmoPlacementOwns(7, doodad(7, 0)), true);
  assert.equal(wmoPlacementOwns(7, doodad(7, 999_999)), true);
  assert.equal(wmoPlacementOwns(7, doodad(8, 0)), false);
  assert.equal(wmoPlacementOwns(7, doodad(6, 999_999)), false);
  assert.equal(wmoPlacementOwns(7, { id: 8 }), false, "another building");
  assert.equal(wmoPlacementOwns(7, { id: -7_000_001 }), false, "a negative id without the doodad flag is not one");
});

test("out of the view a mesh still casts: only the shadow cameras see it", () => {
  const view = new THREE.Camera();
  const near = new THREE.Camera();
  near.layers.set(0);
  near.layers.enable(SHADOW_PROXY_LAYER);
  const far = new THREE.Camera();
  far.layers.set(SHADOW_FAR_LAYER);
  const mesh = new THREE.Mesh();
  mesh.layers.enable(SHADOW_FAR_LAYER);
  const seen = () => [view, near, far].map((camera) => camera.layers.test(mesh.layers));
  assert.deepEqual(seen(), [true, true, true]);
  setOutsideInView(mesh, false);
  assert.deepEqual(seen(), [false, true, true]);
  setOutsideInView(mesh, false);
  assert.deepEqual(seen(), [false, true, true], "asked twice, it stays");
  setOutsideInView(mesh, true);
  assert.deepEqual(seen(), [true, true, true]);
  assert.equal(mesh.layers.isEnabled(SHADOW_PROXY_LAYER), false, "and leaves nothing behind");
  const ground = new THREE.Mesh();
  setOutsideInView(ground, true);
  assert.equal(ground.layers.mask, 1, "in the view already: untouched");
});

test("the renderer hides the world before admission, and hears a door coming into view at once", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const at = renderer.indexOf("this.#updateOutsideHidden(player.position);");
  assert.ok(renderer.indexOf("this.#updateCamera(player.position, cameraYaw") < at, "the walk needs this frame's camera");
  assert.ok(renderer.indexOf("this.#updateHorizon(player.position, map") < at, "what lands this frame is hidden this frame");
  assert.ok(at < renderer.indexOf("this.#updateEnvironment(", at), "admission reads the answer");
  const hide = renderer.slice(renderer.indexOf("  #updateOutsideHidden("), renderer.indexOf("  #walkFromCamera("));
  assert.match(hide, /walk\.walkedRoom >= 0 && !walk\.reachedOutside && !placed\.cameraSurfaceTwin/, "from a room, sure of which");
  assert.match(hide, /!wmoInteriorOnly\(placed\.model\)/, "a building with no outdoors stays on its own path");
  for (const part of ["rendered.mesh", "rendered.water", "this.#horizon.mesh", "this.#horizonLod.meshes", "this.#groundCoverMeshes", "this.#farLightGlows.mesh"]) {
    assert.ok(hide.includes(part), part);
  }
  assert.match(hide, /if \(hiddenFor === undefined && before === undefined\) return;/, "nothing to do costs nothing");
  assert.match(renderer, /this\.#admissionRejected,\n\s*this\.#outsideHiddenFor,\n\s*\);/, "admission turns the rest away");
  assert.match(renderer, /\|\| this\.#admittedOutsideHiddenFor !== this\.#outsideHiddenFor/, "half-rate admission does not delay a door");
  const reset = renderer.slice(renderer.indexOf("this.#cameraSurfaceKnown = false;\n    this.#outsideHiddenFor"));
  assert.match(reset, /^this\.#cameraSurfaceKnown = false;\n\s*this\.#outsideHiddenFor = undefined;/, "a new world starts with the world shown");
});

// ---- Against the recordings.

const clientDirectory = process.env.CLIENT_DIR ?? "F:/Circle";
const withClient = { skip: existsSync(`${clientDirectory}/Data`) ? false : `no client at ${clientDirectory}` };
const toClient = (name) => name.split("/").join(String.fromCharCode(92));
const VMAP_TO_THREE = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

async function loadBuilding(archives, path, adtPath) {
  const name = toClient(path);
  const rootBytes = await archives.read(name);
  const dependencies = wmoDependencies(rootBytes, name);
  const groupBytes = [];
  for (const file of dependencies.groups) groupBytes.push(await archives.read(file));
  const city = wmoGroupMeshes(parseWmoVisual(rootBytes, groupBytes, name));
  const header = encodeWwm(city, city.textures.map(() => ""), new Set());
  const model = decodeWwm(header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength), "");
  const file = path.split("/").pop().toLowerCase();
  const placement = parseAdtPlacements(await archives.read(toClient(adtPath)))
    .find((object) => object.kind === "wmo" && object.name.split(/[\\/]/).pop().toLowerCase() === file);
  assert.ok(placement, `${file} is placed by the tile`);
  const node = placeEnvironmentNode(new THREE.Group(), placement);
  node.updateMatrixWorld(true);
  const modelToWorld = node.matrixWorld.clone().multiply(VMAP_TO_THREE);
  // The nearest surface below a point, on the file's own triangles without the unreachable groups: what the `.vmo`
  // holds, with the tests' client as the one source. Unreachable is what TrinityCore's extractor leaves out.
  const surfaces = city.groups.map((source, index) => ({ source, index }))
    .filter(({ index }) => (model.groups[index].flags & 0x80) === 0);
  const roomUnder = (x, y, z) => {
    let best = -Infinity, at = -1;
    for (const { source, index } of surfaces) {
      const b = model.groups[index].bounds;
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      const { positions, indices } = source;
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t] * 3, i1 = indices[t + 1] * 3, i2 = indices[t + 2] * 3;
        const ax = positions[i0], ay = positions[i0 + 1], bx = positions[i1], by = positions[i1 + 1], cx = positions[i2], cy = positions[i2 + 1];
        if ((x < ax && x < bx && x < cx) || (x > ax && x > bx && x > cx) || (y < ay && y < by && y < cy) || (y > ay && y > by && y > cy)) continue;
        const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (d === 0) continue;
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const h = w0 * positions[i0 + 2] + w1 * positions[i1 + 2] + w2 * positions[i2 + 2];
        if (h <= z && h > best) { best = h; at = index; }
      }
    }
    return at >= 0 && wmoGroupIsRoom(model.groups[at]) ? at : -1;
  };
  return { model, modelToWorld, worldToModel: modelToWorld.clone().invert(), roomUnder };
}

function inFrustum(bounds, m) {
  const out = [0, 0, 0, 0, 0, 0];
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? bounds.maxX : bounds.minX, y = c & 2 ? bounds.maxY : bounds.minY, z = c & 4 ? bounds.maxZ : bounds.minZ;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14], w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cx < -w) out[0]++;
    if (cx > w) out[1]++;
    if (cy < -w) out[2]++;
    if (cy > w) out[3]++;
    if (cz < -w) out[4]++;
    if (cz > w) out[5]++;
  }
  return out.every((n) => n < 8);
}

test("against what Wow.exe drew: nothing missing, no far-view copy, the same triangles from a room", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const archives = await clientArchives(clientDirectory);
  const recorded = JSON.parse(await readFile(new URL("./fixtures/wmo-camera-walk-wow.json", import.meta.url), "utf8"));
  const buildings = new Map();
  const scratch = createWmoPortalWalkScratch();
  const report = [];
  for (const frame of recorded.frames) {
    const building = buildings.get(frame.wmo) ?? await loadBuilding(archives, frame.wmo, frame.adt);
    buildings.set(frame.wmo, building);
    const { model, modelToWorld, worldToModel, roomUnder } = building;
    const [cx, cy, cz] = frame.position, [fx, fy, fz] = frame.forward, [ux, uy, uz] = frame.up;
    const camera = new THREE.PerspectiveCamera(2 * Math.atan(1 / recorded.yScale) * 180 / Math.PI, recorded.aspect, frame.near, frame.far);
    camera.position.set(cx, cz, -cy);
    camera.up.set(ux, uz, -uy);
    camera.lookAt(cx + fx, cz + fz, -(cy + fy));
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const clip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(modelToWorld).elements;
    const at = new THREE.Vector3(cx, cz, -cy).applyMatrix4(worldToModel);
    const room = roomUnder(at.x, at.y, at.z);
    const answer = walkWmoFromCamera(model.groups, model.portals, room, at, clip, undefined, scratch);
    assert.equal(answer.used, true, frame.name);
    const chosen = answer.groups.filter((index) => inFrustum(model.groups[index].bounds, clip));
    const set = new Set(chosen), drawn = new Set(frame.drawn), maybe = new Set(frame.maybe);
    const missing = frame.drawn.filter((index) => !set.has(index));
    const extra = chosen.filter((index) => !drawn.has(index) && !maybe.has(index));
    assert.deepEqual(missing, [], `${frame.name}: drawn by Wow.exe and left out`);
    if (room >= 0) assert.deepEqual(extra, [], `${frame.name}: from a room, not drawn by Wow.exe and chosen`);
    report.push(`${frame.name}: ${room >= 0 ? "room" : "outside"}, ${frame.drawn.length} drawn, ${chosen.length} chosen, ${extra.length} extra`);
    if (frame.name === "c04-plaza-z160") {
      assert.ok(chosen.includes(95), "holy01, the real cathedral");
      assert.ok(!chosen.includes(92) && !chosen.includes(93), "cathy_facade01 and bazaarfacade03 stay out");
    }
    if (frame.name === "c12-road-outside") {
      assert.ok(chosen.includes(92), "from the road the stand-in shows");
      assert.ok(!chosen.includes(95), "and the real cathedral does not");
    }
  }
  // From outside the walk's rectangles are looser than Wow.exe's clipped frusta; this is how much, and it may only shrink.
  const extraOutside = report.filter((line) => line.includes("outside")).reduce((total, line) => total + Number(/(\d+) extra/.exec(line)[1]), 0);
  assert.ok(extraOutside <= 55, `from outside ${extraOutside} groups more than Wow.exe drew:\n${report.join("\n")}`);
  // The owner's report, on its own camera: over the square the real cathedral and neither of its copies.
  const square = report.filter((line) => line.startsWith("c04-plaza-z160"));
  assert.deepEqual(square, ["c04-plaza-z160: room, 4 drawn, 5 chosen, 0 extra"]);
});

// fixtures/wmo-world-through-doors-wow.json: every recorded frame with the camera over a room, 28 of them at real exits,
// facing the door and with their back to it; the terrain chunks Wow.exe drew there, counted from its draw calls.
test("against what Wow.exe drew: from a room terrain appears exactly when the walk comes out", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const archives = await clientArchives(clientDirectory);
  const recorded = JSON.parse(await readFile(new URL("./fixtures/wmo-world-through-doors-wow.json", import.meta.url), "utf8"));
  // The mode of this camera is misjudged by the rule for groups too: Warrior01 60 yards below it, at a height of 200.
  const MISREAD = new Set(["g-8860-340-200"]);
  const buildings = new Map();
  const scratch = createWmoPortalWalkScratch();
  const wrong = [];
  let out = 0, shut = 0;
  for (const frame of recorded.frames) {
    const building = buildings.get(frame.wmo) ?? await loadBuilding(archives, frame.wmo, frame.adt);
    buildings.set(frame.wmo, building);
    const { model, modelToWorld, worldToModel } = building;
    const [cx, cy, cz] = frame.position, [fx, fy, fz] = frame.forward, [ux, uy, uz] = frame.up;
    const camera = new THREE.PerspectiveCamera(2 * Math.atan(1 / recorded.yScale) * 180 / Math.PI, recorded.aspect, frame.near, frame.far);
    camera.position.set(cx, cz, -cy);
    camera.up.set(ux, uz, -uy);
    camera.lookAt(cx + fx, cz + fz, -(cy + fy));
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const clip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(modelToWorld).elements;
    const at = new THREE.Vector3(cx, cz, -cy).applyMatrix4(worldToModel);
    const room = frame.room;
    assert.ok(wmoGroupIsRoom(model.groups[room]), `${frame.name}: the camera is over a room`);
    assert.equal(walkWmoFromCamera(model.groups, model.portals, room, at, clip, undefined, scratch).used, true, frame.name);
    const reached = wmoWalkReachedOutside(model.groups, scratch);
    if (reached) out++;
    else shut++;
    if (reached !== frame.terrainChunks > 0) wrong.push(frame.name);
  }
  assert.deepEqual(wrong.filter((name) => !MISREAD.has(name)), [], "reached outside but no terrain, or the other way round");
  assert.deepEqual(wrong, [...MISREAD], "the misread camera is still the only miss; if it agrees now, drop it");
  assert.deepEqual([out, shut], [17, 54], "both answers are exercised");
});
