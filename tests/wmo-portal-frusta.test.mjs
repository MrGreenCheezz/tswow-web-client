// 15.11 (7.54): the portal walk as Wow.exe 12340 runs it (`WmoPortalFrusta.ts`): a portal clipped to the view before
// it is bounded, a frustum per path, the top edge it does not narrow, the depth of ten, the camera standing in a portal,
// and from a room the outside seen through the views its doors leave. Against the recorded cameras: wmo-camera-walk.

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  WMO_PORTAL_MAX_DEPTH, createWmoPortalFrustaScratch, walkWmoPortalFrusta, wmoBoxInScreenRect, wmoCameraInPortal,
  wmoPortalScreenRect,
} from "../dist/code/browser/WmoPortalFrusta.js";
import { wmoPortalPlanes } from "../dist/code/browser/WmoCameraWalk.js";

const INDOOR = 0x2000, OUTDOOR = 0x8;
/** The eye at the origin looking down -z, 90 degrees, square: model space is view space. */
const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
camera.updateProjectionMatrix();
const CLIP = camera.projectionMatrix.elements;
const EYE = { x: 0, y: 0, z: 0 };

/** A square portal across the view at depth `z`, `half` wide around (`cx`, `cy`). */
const square = (z, half = 0.5, cx = 0, cy = 0) => [cx - half, cy - half, z, cx + half, cy - half, z, cx + half, cy + half, z, cx - half, cy + half, z];
const box = (minX, minY, minZ, maxX, maxY, maxZ) => ({ minX, minY, minZ, maxX, maxY, maxZ });
const group = (flags, bounds, portalStart = 0, portalCount = 0) => ({ flags, bounds, portalStart, portalCount });

/**
 * A graph from portal polygons and the references leaving each group, `[group, polygon index, target]`; each reference
 * gets the side the eye is on, so every portal is crossed from where the camera stands.
 */
function graph(polygons, links, groups) {
  const vertices = new Float32Array(polygons.flat());
  const definitions = polygons.map((_, index) => ({ startVertex: index * 4, vertexCount: 4 }));
  const probe = wmoPortalPlanes({ vertices, definitions, references: [] });
  const references = [];
  for (let index = 0; index < groups.length; index++) {
    groups[index].portalStart = references.length;
    for (const [from, portal, to] of links) {
      if (from !== index) continue;
      const facing = probe[portal * 4] * EYE.x + probe[portal * 4 + 1] * EYE.y + probe[portal * 4 + 2] * EYE.z + probe[portal * 4 + 3];
      references.push({ portal, group: to, side: facing >= 0 ? 1 : -1 });
    }
    groups[index].portalCount = references.length - groups[index].portalStart;
  }
  return { vertices, definitions, references };
}

function walk(groups, portals, seeds, fromRoom, eye = EYE) {
  const out = { reached: new Uint8Array(groups.length), drawn: new Uint8Array(groups.length), apertures: new Float64Array(groups.length * 4) };
  const ok = walkWmoPortalFrusta(groups, portals, wmoPortalPlanes(portals), eye, CLIP, seeds, seeds.length, fromRoom, out, createWmoPortalFrustaScratch());
  assert.equal(ok, true);
  return out;
}

test("a portal reaching behind the eye is clipped to the view before it is bounded (0x7a72a0)", () => {
  // A strip of floor from behind the eye to five yards ahead: cut at the bottom of the view a yard ahead, the far
  // end ends at y = -0.2. Bounding its corners would have said "the whole screen" (and the older walk did).
  const strip = new Float32Array([-0.5, -1, 1, 0.5, -1, 1, 0.5, -1, -5, -0.5, -1, -5]);
  const out = new Float64Array(4);
  assert.equal(wmoPortalScreenRect(strip, 0, 4, CLIP, createWmoPortalFrustaScratch(), out, 0), true);
  const [minX, maxX, minY, maxY] = out;
  assert.ok(Math.abs(minX + 0.5) < 1e-9 && Math.abs(maxX - 0.5) < 1e-9, `${minX} ${maxX}: where the strip leaves the bottom of the view`);
  assert.ok(Math.abs(minY + 1) < 1e-9, `${minY}`);
  assert.ok(Math.abs(maxY + 0.2) < 1e-6, `${maxY}: the far edge, not the top of the screen`);
  // Wholly behind the eye: not seen at all.
  const behind = new Float32Array(square(2));
  assert.equal(wmoPortalScreenRect(behind, 0, 4, CLIP, createWmoPortalFrustaScratch(), out, 0), false);
});

test("a room reached through a portal is drawn only where the portal's frustum meets its box", () => {
  // The camera's room 0, a small door straight ahead, and behind it room 1 off to the side of the door (still on screen)
  // and room 2 right behind it.
  const groups = [
    group(INDOOR, box(-1, -1, -1, 1, 1, 1)),
    group(INDOOR, box(3, -0.1, -6, 4, 0.1, -5)),
    group(INDOOR, box(-0.1, -0.1, -6, 0.1, 0.1, -5)),
  ];
  const portals = graph([square(-2, 0.2)], [[0, 0, 1], [0, 0, 2]], groups);
  const out = walk(groups, portals, [0], true);
  assert.deepEqual([...out.reached], [1, 1, 1], "both are behind the door");
  assert.deepEqual([...out.drawn], [1, 0, 1], "only the one the door shows is drawn");
  const onScreen = new Float64Array([-1, 1, -1, 1]);
  assert.equal(wmoBoxInScreenRect(groups[1].bounds, CLIP, onScreen, 0), true, "room 1 is on screen, so the frustum of the whole view would draw it");
});

test("a cut keeps the portal's own top edge (0x7ac060 never lowers it)", () => {
  // Door 0 shows only the lower half of the screen; door 1, behind it, reaches higher than door 0 does.
  const door0 = [-1, -1, -2, 1, -1, -2, 1, 0, -2, -1, 0, -2]; // y up to 0 at depth 2: NDC top 0
  const door1 = square(-4, 0.8, 0, 0.8); // y 0..1.6 at depth 4: NDC 0..0.4
  const groups = [group(INDOOR, box(-1, -1, -1, 1, 1, 1)), group(INDOOR, box(-2, -2, -3, 2, 2, -2)), group(INDOOR, box(-1, 1, -6, 1, 1.5, -5))];
  const portals = graph([door0, door1], [[0, 0, 1], [1, 1, 2]], groups);
  const out = walk(groups, portals, [0], true);
  assert.equal(out.reached[2], 1);
  assert.ok(Math.abs(out.apertures[2 * 4 + 3] - 0.4) < 1e-6, `top ${out.apertures[2 * 4 + 3]}: door 1's own`);
  assert.ok(Math.abs(out.apertures[2 * 4 + 2] - 0) < 1e-6, "the bottom is cut to door 0's");
  assert.equal(out.drawn[2], 1, "above door 0's top, and still drawn, as Wow.exe draws it");
});

test("a walk goes ten portals deep and no further", () => {
  const count = 14;
  const groups = [];
  const polygons = [];
  const links = [];
  for (let index = 0; index < count; index++) {
    groups.push(group(INDOOR, box(-0.5, -0.5, -index - 1, 0.5, 0.5, -index)));
    if (index + 1 < count) {
      polygons.push(square(-index - 1, 0.5));
      links.push([index, index, index + 1]);
    }
  }
  const out = walk(groups, graph(polygons, links, groups), [0], true);
  assert.equal(out.reached[WMO_PORTAL_MAX_DEPTH], 1);
  assert.equal(out.reached[WMO_PORTAL_MAX_DEPTH + 1], 0);
});

test("an opening thinner than a thousandth of the screen leads nowhere", () => {
  // Seen edge-on: the door's plane passes through the eye.
  const edge = [0, -0.5, -1, 0, -0.5, -3, 0, 0.5, -3, 0, 0.5, -1];
  const groups = [group(INDOOR, box(-1, -1, -1, 1, 1, 1)), group(INDOOR, box(0, -1, -4, 1, 1, -1))];
  const out = walk(groups, graph([edge], [[0, 0, 1]], groups), [0], true);
  assert.equal(out.reached[1], 0);
});

test("a camera standing in a portal sees through all of it (0x7a7210)", () => {
  // The door's plane passes through the eye: projected, it is a line; standing in it, it is the whole screen.
  const door = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  const vertices = new Float32Array(door);
  const planes = wmoPortalPlanes({ vertices, definitions: [{ startVertex: 0, vertexCount: 4 }], references: [] });
  assert.equal(wmoCameraInPortal(vertices, 0, 4, planes, 0, EYE), true);
  assert.equal(wmoCameraInPortal(vertices, 0, 4, planes, 0, { x: 3, y: 0, z: 0 }), false, "beside the door, in its plane");
  assert.equal(wmoCameraInPortal(vertices, 0, 4, planes, 0, { x: 0, y: 0, z: 0.05 }), false, "five centimetres from it");
  const groups = [group(INDOOR, box(-1, -1, 0, 1, 1, 1)), group(INDOOR, box(-1, -1, -2, 1, 1, 0))];
  const out = walk(groups, graph([door], [[0, 0, 1]], groups), [0], true);
  assert.equal(out.drawn[1], 1);
});

test("from a room the outside is not walked into: its door leaves a view, and the outside is walked from what it shows", () => {
  // Room 0 -> door -> street 1 -> door -> shop 2; street 3 is on screen but not in the door's view.
  const groups = [
    group(INDOOR, box(-1, -1, -1, 1, 1, 1)),
    group(OUTDOOR, box(-2, -2, -10, 2, 2, -2)),
    group(INDOOR, box(-0.2, -0.2, -14, 0.2, 0.2, -12)),
    group(OUTDOOR, box(8, -1, -10, 9, 1, -9)),
  ];
  const portals = graph([square(-2, 0.4), square(-12, 0.3)], [[0, 0, 1], [1, 1, 2]], groups);
  const out = walk(groups, portals, [0], true);
  assert.deepEqual([...out.reached], [1, 1, 1, 0]);
  assert.deepEqual([...out.drawn], [1, 1, 1, 0]);
  // From outside every outdoor group in the view starts a walk: street 3 too.
  const outside = walk(groups, portals, [1, 3], false);
  assert.deepEqual([...outside.drawn], [0, 1, 1, 1]);
});
