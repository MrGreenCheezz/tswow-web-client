// P1-05 (UNT-5): the shadow-pass cull sphere of skinned bodies and mounts. The renderer wiring was
// measured NO-GO on 07.10 (no unit shadow draw culled in city / world-crowd-64) and reverted; the
// module stays for P2-01b, which uses the unit spheres.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  SKINNED_CULL_MARGIN, SKINNED_CULL_SCALE, skinnedCullRadius, sphereMissesCascade,
  unitCullingEnabled,
} from "../dist/code/browser/SkinnedCullSphere.js";
import { buildSkinnedTemplateFrom, instantiateSkinned } from "../dist/code/browser/AnimatedModel.js";

const header = (min, max, radius) => ({ min, max, radius });

test("(i) the sphere encloses the header box's eight corners and its origin sphere", () => {
  const cases = [
    { bounds: header([-2.74, -1.86, -1.19], [3.32, 2.12, 4.37], 4.49), center: { x: -0.255, y: 0, z: 1.042 }, rest: 1.338 },
    { bounds: header([-0.6, -0.67, -0.01], [0.19, 0.67, 1.93], 1.25), center: { x: -0.2, y: 0, z: 0.96 }, rest: 1.245 },
    { bounds: header([0, 0, 0], [0, 0, 0], 6), center: { x: 1, y: 2, z: 3 }, rest: 0.5 },
  ];
  for (const { bounds, center, rest } of cases) {
    const radius = skinnedCullRadius(bounds, center, rest);
    assert.ok(radius !== undefined);
    const c = new THREE.Vector3(center.x, center.y, center.z);
    for (let index = 0; index < 8; index++) {
      const corner = new THREE.Vector3(
        index & 1 ? bounds.max[0] : bounds.min[0],
        index & 2 ? bounds.max[1] : bounds.min[1],
        index & 4 ? bounds.max[2] : bounds.min[2]);
      assert.ok(corner.distanceTo(c) * SKINNED_CULL_SCALE <= radius - SKINNED_CULL_MARGIN + 1e-9, `corner ${index}`);
    }
    // Every point of the origin-centred header sphere: its farthest point from c.
    assert.ok((bounds.radius + c.length()) * SKINNED_CULL_SCALE <= radius - SKINNED_CULL_MARGIN + 1e-9);
    assert.ok(rest * SKINNED_CULL_SCALE <= radius - SKINNED_CULL_MARGIN + 1e-9);
  }
});

test("(ii) non-finite, negative and inverted inputs give no radius", () => {
  const good = header([-1, -1, 0], [1, 1, 2], 2);
  const centre = { x: 0, y: 0, z: 1 };
  assert.ok(skinnedCullRadius(good, centre, 1) !== undefined);
  assert.equal(skinnedCullRadius(header([Number.NaN, -1, 0], [1, 1, 2], 2), centre, 1), undefined);
  assert.equal(skinnedCullRadius(header([-1, -1, 0], [1, Infinity, 2], 2), centre, 1), undefined);
  assert.equal(skinnedCullRadius(header([1, -1, 0], [-1, 1, 2], 2), centre, 1), undefined, "inverted x");
  assert.equal(skinnedCullRadius(header([-1, -1, 3], [1, 1, 2], 2), centre, 1), undefined, "inverted z");
  assert.equal(skinnedCullRadius(good, centre, -1), undefined);
  assert.equal(skinnedCullRadius(header([-1, -1, 0], [1, 1, 2], -2), centre, 1), undefined);
  assert.equal(skinnedCullRadius(good, { x: 0, y: Number.NaN, z: 1 }, 1), undefined);
  assert.equal(skinnedCullRadius(good, centre, Number.POSITIVE_INFINITY), undefined);
});

/**
 * A three-bone rig whose arm (bone 2) points up at rest and is swung out by its one clip until its
 * tip lands on the header box's far corner — the case the header's animation extents exist for.
 */
function armRig() {
  const position = Float32Array.from([
    0, -0.1, 0, 0, 0.1, 0, // feet, bone 0
    0, -0.1, 1, 0, 0.1, 1, // waist, bone 1
    0, -0.1, 2, 0, 0.1, 2, // arm tip, bone 2
  ]);
  const skinIndex = Uint16Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]);
  const skinWeight = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex([0, 1, 2, 2, 3, 4, 4, 5, 0]);
  geometry.addGroup(0, 9, 0);
  // Bone 2 turns +90° about y over the clip: its (0, 0, 2) tip goes to (2, 0, 0).
  const values = new Float32Array(8);
  new THREE.Quaternion().toArray(values, 0);
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).toArray(values, 4);
  const template = buildSkinnedTemplateFrom(geometry, {
    parents: Int16Array.from([-1, 0, 1]),
    pivots: new Float32Array(9),
    flags: new Uint16Array(3),
    animations: [0],
    clips: [{ animationId: 0, duration: 1, channels: [{ bone: 2, kind: 1, times: Float32Array.from([0, 1]), values }] }],
  }, 2);
  assert.ok(template);
  // Header: the rest box joined with the swung arm, and an origin sphere a file might carry.
  const bounds = header([0, -0.1, 0], [2, 0.1, 2], 1);
  return { template, bounds };
}

test("(iii) every skinned vertex of the clip stays inside the sphere with a 1.05 margin", () => {
  const { template, bounds } = armRig();
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  const { mesh, mixer, root } = instance;
  const sphere = mesh.boundingSphere;
  const radius = skinnedCullRadius(bounds, sphere.center, sphere.radius);
  assert.ok(radius !== undefined);
  const action = mixer.clipAction(template.clips.get(0));
  action.play();
  const vertex = new THREE.Vector3();
  let farthest = 0;
  let tipAtCorner = false;
  for (let time = 0; time <= 1 + 1e-9; time += 1 / 30) {
    mixer.setTime(Math.min(time, 0.999999));
    root.updateMatrixWorld(true);
    mesh.skeleton.update();
    for (let at = 0; at < 6; at++) {
      mesh.getVertexPosition(at, vertex);
      const distance = vertex.distanceTo(sphere.center);
      farthest = Math.max(farthest, distance);
      assert.ok(distance * 1.05 <= radius, `vertex ${at} at t=${time.toFixed(2)}: ${distance} vs ${radius}`);
      if (vertex.distanceTo(new THREE.Vector3(2, vertex.y, 0)) < 0.02) tipAtCorner = true;
    }
  }
  assert.ok(tipAtCorner, "the clip really swings the arm to the header box's corner");
  assert.ok(farthest > sphere.radius * 1.5, "the swung arm leaves the rest sphere");
});

test("(iv) a sphere touching the cascade square is kept, one wholly outside is culled, on both axes", () => {
  const extent = 30;
  const radius = 4;
  for (const [cr, cu] of [[0, 0], [-1000, 250]]) {
    assert.equal(sphereMissesCascade(cr, cu, radius, cr, cu, extent), false, "centre");
    for (const sign of [-1, 1]) {
      // Touching: the sphere's edge on the square's edge.
      assert.equal(sphereMissesCascade(cr + sign * (extent + radius), cu, radius, cr, cu, extent), false);
      assert.equal(sphereMissesCascade(cr, cu + sign * (extent + radius), radius, cr, cu, extent), false);
      // Centre outside, sphere still reaching in.
      assert.equal(sphereMissesCascade(cr + sign * (extent + radius / 2), cu, radius, cr, cu, extent), false);
      assert.equal(sphereMissesCascade(cr, cu + sign * (extent + radius / 2), radius, cr, cu, extent), false);
      // Wholly outside.
      assert.equal(sphereMissesCascade(cr + sign * (extent + radius + 0.01), cu, radius, cr, cu, extent), true);
      assert.equal(sphereMissesCascade(cr, cu + sign * (extent + radius + 0.01), radius, cr, cu, extent), true);
    }
  }
  assert.equal(sphereMissesCascade(Number.NaN, 0, 1, 0, 0, 10), false, "NaN keeps the mesh");
});

test("(v) ?unitcull=0 turns the cull off, anything else leaves it on", () => {
  assert.equal(unitCullingEnabled("?unitcull=0"), false);
  assert.equal(unitCullingEnabled("?a=1&unitcull=0"), false);
  assert.equal(unitCullingEnabled(""), true);
  assert.equal(unitCullingEnabled("?unitcull=1"), true);
  assert.equal(unitCullingEnabled("?bench=city"), true);
});

