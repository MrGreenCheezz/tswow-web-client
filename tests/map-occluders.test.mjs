// 15.11 (7.54, portal8): Wow.exe's hand-placed map occluders (`MapOccluders.ts`): the shadow volume a polygon casts
// from the eye (0x7cd4e0), the sphere and point tests (0x7cce00, 0x7ccfa0), the frustum gate on the record's box
// (0x9839e0), and the walk that skips an outdoor group or a portal in a shadow (0x79a160, 0x7a85e0). The polygons are
// the client's own data: the gateway reads them from the user's Wow.exe (`MapOccluderTable.ts`); every polygon here
// is synthetic, and the real table is only counted when a Wow.exe is at hand.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import {
  buildMapOccluderVolumes, createMapOccluderFrame, createMapOccluderVolumes, mapOccluderVolumesInModel,
  mapOccludersForModel, mapOccludersHidePoints, mapOccludersHideSphere, wmoOccludersApply,
} from "../dist/code/browser/MapOccluders.js";
import { MapOccluderClient, parseMapOccluderBody } from "../dist/code/browser/MapOccluderClient.js";
import { parseMapOccluders, readMapOccluders } from "../dist/code/gateway/MapOccluderTable.js";
import { createWmoPortalFrustaScratch, walkWmoPortalFrusta } from "../dist/code/browser/WmoPortalFrusta.js";
import { wmoPortalPlanes } from "../dist/code/browser/WmoCameraWalk.js";

const WOW_TO_THREE = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
/** The eye at the origin, looking along WoW +y (this client's -z), 90 degrees, square. */
const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 500);
camera.updateProjectionMatrix();
const CLIP = camera.projectionMatrix.elements;
const WOW_TO_CLIP = camera.projectionMatrix.clone().multiply(WOW_TO_THREE).elements;
/** A wall 10 yards ahead, 6 wide and 6 high around the eye's line (WoW x, y, z). */
const WALL = [-3, 10, -3, -3, 10, 3, 3, 10, 3, 3, 10, -3];
const records = (points) => [{ flags: 0, points }];

function volumesFor(points, eye = [0, 0, 0], clip = WOW_TO_CLIP) {
  const out = createMapOccluderVolumes();
  buildMapOccluderVolumes(out, records(points), eye[0], eye[1], eye[2], clip);
  return out;
}

test("a polygon's shadow from the eye hides a sphere wholly behind it, not one that shows past an edge (0x7cd4e0, 0x7cce00)", () => {
  const volumes = volumesFor(WALL);
  assert.equal(volumes.volumeCount, 1);
  assert.equal(volumes.planeCount, 5, "one plane per edge, then the polygon's own");
  assert.equal(mapOccludersHideSphere(volumes, 0, 20, 0, 1), true, "behind the wall, inside its shadow");
  // At y = 20 the shadow's top is at z = 6 (the wall's top, 3, twice as far).
  assert.equal(mapOccludersHideSphere(volumes, 0, 20, 6.5, 0.3), false, "behind it but above the shadow's top");
  assert.equal(mapOccludersHideSphere(volumes, 0, 20, 5.5, 0.3), true, "just under the top");
  assert.equal(mapOccludersHideSphere(volumes, 0, 20, 5.5, 1), false, "the radius pokes out of the shadow");
  assert.equal(mapOccludersHideSphere(volumes, 0, 5, 0, 1), false, "in front of the wall");
  assert.equal(mapOccludersHideSphere(volumes, 0, 10.5, 0, 1), false, "straddling the wall's own plane");
});

test("the eye is always outside: from behind the polygon the planes are turned (0x7cd4e0's flip)", () => {
  const back = new THREE.PerspectiveCamera(90, 1, 0.1, 500);
  back.position.set(0, 0, -20);
  back.lookAt(0, 0, 0);
  back.updateMatrixWorld(true);
  back.updateProjectionMatrix();
  const clip = back.projectionMatrix.clone().multiply(back.matrixWorldInverse).multiply(WOW_TO_THREE).elements;
  const volumes = volumesFor(WALL, [0, 20, 0], clip);
  assert.equal(volumes.volumeCount, 1);
  assert.equal(mapOccludersHideSphere(volumes, 0, 0, 0, 1), true, "hidden behind it from the other side");
  assert.equal(mapOccludersHideSphere(volumes, 0, 15, 0, 1), false, "between the eye and the wall");
});

test("no records, no volumes; an occluder whose box (grown from the origin) misses the frustum makes none (0x9839e0)", () => {
  const none = createMapOccluderVolumes();
  assert.equal(buildMapOccluderVolumes(none, undefined, 0, 0, 0, WOW_TO_CLIP), 0);
  // 0x7ccd20 grows the box from (0, 0, 0), so the box of a polygon at y = -50 reaches the origin. An eye 100 yards
  // up the y axis looking further up sees neither: the box is wholly behind it.
  const far = [-3, -50, -30, -3, -50, -26, 3, -50, -26, 3, -50, -30];
  const eyeAhead = new THREE.PerspectiveCamera(90, 1, 0.1, 500);
  eyeAhead.position.set(0, 0, -100);
  eyeAhead.lookAt(0, 0, -200);
  eyeAhead.updateMatrixWorld(true);
  eyeAhead.updateProjectionMatrix();
  const clip = eyeAhead.projectionMatrix.clone().multiply(eyeAhead.matrixWorldInverse).multiply(WOW_TO_THREE).elements;
  const shifted = createMapOccluderVolumes();
  assert.equal(buildMapOccluderVolumes(shifted, records(far), 0, 100, 0, clip), 0, "a box wholly behind the view");
});

test("the occluders apply only with the camera known to hang over no WMO (Wow.exe 0x795d40)", () => {
  assert.equal(wmoOccludersApply(true, null), true, "over terrain");
  assert.equal(wmoOccludersApply(true, {}), false, "over a building, street or room");
  assert.equal(wmoOccludersApply(false, null), false, "nothing known this frame");
  assert.equal(wmoOccludersApply(true, undefined), false);
});

test("a portal polygon wholly in a shadow is hidden, one partly out is not (0x7ccfa0)", () => {
  const volumes = volumesFor(WALL);
  const inside = [-1, 20, -1, 1, 20, -1, 1, 20, 1, -1, 20, 1];
  const partly = [-1, 20, -1, 8, 20, -1, 8, 20, 1, -1, 20, 1];
  assert.equal(mapOccludersHidePoints(volumes, inside, 0, 4), true);
  assert.equal(mapOccludersHidePoints(volumes, partly, 0, 4), false);
});

test("the renderer's route: this client's camera and a placed model give the same shadow in the model's space", () => {
  // A synthetic wall across WoW x = 100..140 at y = 50, z 0..30; the eye at WoW (120, 0, 10) looks along +y.
  const wall = [{ flags: 0, points: [100, 50, 0, 100, 50, 30, 140, 50, 30, 140, 50, 0] }];
  const eye = new THREE.Vector3(120, 10, 0);
  const view = new THREE.PerspectiveCamera(60, 16 / 9, 0.2, 1277);
  view.position.copy(eye);
  view.lookAt(120, 10, -50);
  view.updateMatrixWorld(true);
  view.updateProjectionMatrix();
  // A model turned and moved: its own space is not the world's.
  const modelToThree = new THREE.Matrix4().makeRotationY(0.7).setPosition(110, 5, -60);
  const frame = createMapOccluderFrame();
  const ask = (list, camera = view) => mapOccludersForModel(frame, list, eye, camera.projectionMatrix.elements, camera.matrixWorldInverse.elements, modelToThree.elements);
  const volumes = ask(wall);
  assert.ok(volumes, "the wall is in view");
  assert.equal(volumes.volumeCount, 1);
  const toModel = modelToThree.clone().invert();
  const behind = new THREE.Vector3(120, 10, -100).applyMatrix4(toModel); // WoW (120, 100, 10)
  const before = new THREE.Vector3(120, 10, -30).applyMatrix4(toModel);
  assert.equal(mapOccludersHideSphere(volumes, behind.x, behind.y, behind.z, 1), true);
  assert.equal(mapOccludersHideSphere(volumes, before.x, before.y, before.z, 1), false);
  assert.equal(ask(undefined), undefined, "no records (none yet, or none for this map)");
  assert.equal(ask([]), undefined);
  assert.equal(ask(wall)?.volumeCount, 1, "built again for the same camera and records");
  const turned = new THREE.PerspectiveCamera(60, 16 / 9, 0.2, 1277);
  turned.position.copy(eye);
  turned.lookAt(120, 10, 50); // away from the wall
  turned.updateMatrixWorld(true);
  turned.updateProjectionMatrix();
  assert.equal(ask(wall, turned), undefined, "the wall's box is behind this view");
});

test("the walk: an outdoor group in a shadow starts nothing, a door in a shadow leads nowhere (0x79a160, 0x7a85e0)", () => {
  // Model space = this client's world here (identity placement). Outdoor group A near the eye, with a door to room R
  // 20 yards ahead behind the wall; outdoor group B wholly behind the wall with a door to room S.
  const box = (minX, minY, minZ, maxX, maxY, maxZ) => ({ minX, minY, minZ, maxX, maxY, maxZ });
  const door = (z, cx = 0) => [cx - 1, -1, z, cx + 1, -1, z, cx + 1, 1, z, cx - 1, 1, z];
  const polygons = [door(-20), door(-30)];
  const vertices = new Float32Array(polygons.flat());
  const definitions = polygons.map((_, index) => ({ startVertex: index * 4, vertexCount: 4 }));
  const probe = wmoPortalPlanes({ vertices, definitions, references: [] });
  const side = (portal) => (probe[portal * 4 + 3] >= 0 ? 1 : -1);
  const groups = [
    { flags: 0x8, bounds: box(-8, -2, -12, 8, 2, -1), portalStart: 0, portalCount: 1 },
    { flags: 0x2000, bounds: box(-1, -1, -25, 1, 1, -20), portalStart: 1, portalCount: 0 },
    { flags: 0x8, bounds: box(-0.5, -0.5, -31, 0.5, 0.5, -29), portalStart: 1, portalCount: 1 },
    { flags: 0x2000, bounds: box(-1, -1, -35, 1, 1, -30), portalStart: 2, portalCount: 0 },
  ];
  const portals = { vertices, definitions, references: [{ portal: 0, group: 1, side: side(0) }, { portal: 1, group: 3, side: side(1) }] };
  const run = (occluders) => {
    const out = { reached: new Uint8Array(4), drawn: new Uint8Array(4), apertures: new Float64Array(16) };
    assert.equal(walkWmoPortalFrusta(groups, portals, wmoPortalPlanes(portals), { x: 0, y: 0, z: 0 }, CLIP, [0, 2], 2, false, out,
      createWmoPortalFrustaScratch(), undefined, occluders), true);
    return [...out.drawn];
  };
  assert.deepEqual(run(undefined), [1, 1, 1, 1], "without occluders everything is seen");
  // The wall at WoW y = 15 (this client's z = -15), 6 by 6: door 0 (z = -20) and group B (z = -30) are behind it.
  const volumes = createMapOccluderVolumes();
  buildMapOccluderVolumes(volumes, records([-3, 15, -3, -3, 15, 3, 3, 15, 3, 3, 15, -3]), 0, 0, 0, WOW_TO_CLIP);
  const local = mapOccluderVolumesInModel(volumes, new THREE.Matrix4().elements, createMapOccluderVolumes());
  assert.deepEqual(run(local), [1, 0, 0, 0], "door 0 and group B are in the wall's shadow; A, nearer, is still drawn");
});

/** A synthetic PE with build 12340's layout: one section from rva 0x5e0000, the grid centre and a table of 62. */
function syntheticExe({ zeroPoint = 17066.666, firstMap = 0, firstCount = 4 } = {}) {
  const sectionRva = 0x5e0000, sectionSize = 0x120000, raw = 0x400;
  const exe = new Uint8Array(raw + sectionSize);
  const view = new DataView(exe.buffer);
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, 0x40, true);
  view.setUint32(0x40, 0x00004550, true);
  view.setUint16(0x40 + 6, 1, true);
  view.setUint16(0x40 + 20, 0xe0, true);
  view.setUint32(0x40 + 24 + 28, 0x400000, true);
  const section = 0x40 + 24 + 0xe0;
  view.setUint32(section + 8, sectionSize, true);
  view.setUint32(section + 12, sectionRva, true);
  view.setUint32(section + 16, sectionSize, true);
  view.setUint32(section + 20, raw, true);
  const at = (va) => raw + (va - 0x400000 - sectionRva);
  view.setFloat32(at(0x009e2acc), zeroPoint, true);
  const pointsVa = 0x00af1000;
  for (let index = 0; index < 62; index++) {
    const record = at(0x00af0040 + index * 40);
    view.setInt32(record, index === 0 ? firstMap : index < 20 ? 571 : 1, true);
    view.setUint32(record + 4, index % 3, true);
    view.setUint32(record + 0x20, pointsVa + index * 48, true);
    view.setInt32(record + 0x24, index === 0 ? firstCount : 4, true);
    for (let point = 0; point < 4; point++) {
      const p = at(pointsVa + index * 48 + point * 12);
      view.setFloat32(p, index * 10 + point, true);
      view.setFloat32(p + 4, -point, true);
      view.setFloat32(p + 8, point * 2, true);
    }
  }
  return exe;
}

test("the gateway reads the table at 0x00af0040 of build 12340's layout, and nothing from another", () => {
  const byMap = parseMapOccluders(syntheticExe());
  assert.ok(byMap);
  assert.equal(byMap.get(0).length, 1);
  assert.equal(byMap.get(571).length, 19);
  assert.equal(byMap.get(1).length, 42);
  assert.deepEqual(byMap.get(0)[0], { flags: 0, points: [0, -0, 0, 1, -1, 2, 2, -2, 4, 3, -3, 6] });
  assert.equal(parseMapOccluders(syntheticExe({ zeroPoint: 17000 })), undefined, "another grid centre: another build");
  assert.equal(parseMapOccluders(syntheticExe({ firstMap: -5 })), undefined, "a record that is not a map id");
  assert.equal(parseMapOccluders(syntheticExe({ firstCount: 2 })), undefined, "a polygon of two points");
  assert.equal(parseMapOccluders(new Uint8Array(64)), undefined, "not a PE");
});

test("the browser takes a map's records once, and none from a 404 or a junk body", async () => {
  assert.deepEqual(parseMapOccluderBody({ occluders: [{ flags: 1, points: [0, 0, 0, 1, 0, 0, 1, 1, 0] }] }),
    [{ flags: 1, points: [0, 0, 0, 1, 0, 0, 1, 1, 0] }]);
  assert.equal(parseMapOccluderBody({ occluders: [{ flags: 1, points: [0, 0] }] }), undefined);
  const asked = [];
  const body = { map: 7, occluders: [{ flags: 0, points: WALL }] };
  const client = new MapOccluderClient("http://gw", async (url) => {
    asked.push(String(url));
    return String(url).includes("/7?") ? new Response(JSON.stringify(body), { status: 200 }) : new Response("", { status: 404 });
  });
  assert.equal(client.records(7), undefined, "nothing waits: the first ask answers none");
  assert.equal(client.records(8), undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(client.records(7), body.occluders);
  assert.equal(client.records(8), undefined, "a 404 is none for good");
  assert.deepEqual(asked, ["http://gw/dbc/occluders/7?v=1", "http://gw/dbc/occluders/8?v=1"], "one request per map");
});

// The real table lives only in the user's Wow.exe.
const clientDirectory = process.env.CLIENT_DIR ?? "F:/Circle";
const clientExe = join(clientDirectory, "Wow.exe");
test("the client's own Wow.exe: one occluder on map 0, nineteen of Northrend's in Dalaran", { skip: existsSync(clientExe) ? false : `no Wow.exe at ${clientExe}` }, async () => {
  const byMap = await readMapOccluders(clientDirectory);
  assert.ok(byMap, "build 12340's table");
  assert.equal([...byMap.values()].reduce((total, list) => total + list.length, 0), 62);
  assert.equal(byMap.get(0)?.length, 1);
  assert.equal(byMap.get(571)?.length, 42);
  // Dalaran's: map 571 within its square (x 5500..6100, y 350..1000).
  const dalaran = byMap.get(571).filter(({ points }) => points.every((value, at) => at % 3 === 0 ? value > 5500 && value < 6100 : at % 3 === 1 ? value > 350 && value < 1000 : true));
  assert.equal(dalaran.length, 19);
});
