// 06.10-shadow: unit shadow casters must not come and go while nothing about the caster changed
// (owner's live report 06.10 on level 3 «сравнение»: «тени … пропадают и появляются резко»).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import {
  UNIT_SHADOW_DISTANCE_SLACK, UNIT_SHADOW_RANK_SLACK, UnitShadowCasterSet, unitShadowFootprint, unitShadowInReach,
} from "../dist/code/browser/UnitShadowCasters.js";
import { CascadedSunShadows, SHADOW_CASCADE_BLEND } from "../dist/code/browser/CascadedShadows.js";
import { directionalShadowBasis, lightingProfile, unitCastsEnhancedShadow } from "../dist/code/browser/LightingQuality.js";
import { selectUnitAdmission } from "../dist/code/browser/RenderAdmission.js";
import { classicKeyLightDirection } from "../dist/code/browser/ClassicSun.js";
import { unitSphereVisibleInFrustum } from "../dist/code/browser/WorldRenderer3D.js";

const comparison = lightingProfile(3);

test("the comparison level casts with quality 1's unit budget", () => {
  assert.equal(comparison.shadowCasters, 12);
  assert.equal(comparison.shadowExtent, 32);
  assert.ok(comparison.shadowMapSize > 0);
});

test("the footprint holds the unit and the shadow it throws away from the sun", () => {
  const out = { x: 0, y: 0, z: 0, radius: 0 };
  // Sun 20° above the horizon, towards +x: the shadow runs towards -x, 2.75 radii long.
  const elevation = (20 * Math.PI) / 180;
  const sun = { x: Math.cos(elevation), y: Math.sin(elevation), z: 0 };
  assert.equal(unitShadowFootprint(10, 5, 3, 2, sun, out), true);
  const reach = 2 / Math.tan(elevation);
  assert.ok(Math.abs(out.x - (10 - reach / 2)) < 1e-9, `centre x ${out.x}`);
  assert.equal(out.y, 5);
  assert.ok(Math.abs(out.z - 3) < 1e-9);
  assert.ok(Math.abs(out.radius - (2 + reach / 2)) < 1e-9);
  // The far end of the shadow and the unit itself are both inside.
  assert.ok(Math.hypot(10 - reach - out.x, 3 - out.z) <= out.radius + 1e-9);
  assert.ok(Math.hypot(10 + 2 - out.x, 3 - out.z) <= out.radius + 1e-9);
  // Length of `sun` does not matter.
  const scaled = { x: 0, y: 0, z: 0, radius: 0 };
  unitShadowFootprint(10, 5, 3, 2, { x: sun.x * 400, y: sun.y * 400, z: 0 }, scaled);
  assert.ok(Math.abs(scaled.radius - out.radius) < 1e-9);
  // A sun at the zenith: the shadow is under the feet.
  assert.equal(unitShadowFootprint(1, 2, 3, 2, { x: 0, y: 1, z: 0 }, out), true);
  assert.deepEqual([out.x, out.y, out.z, out.radius], [1, 2, 3, 2]);
  // No sun, a set sun, or garbage: nothing to admit for.
  assert.equal(unitShadowFootprint(0, 0, 0, 2, { x: 1, y: -0.2, z: 0 }, out), false);
  assert.equal(unitShadowFootprint(0, 0, 0, 2, { x: 0, y: 0, z: 0 }, out), false);
  assert.equal(unitShadowFootprint(Number.NaN, 0, 0, 2, sun, out), false);
  // A grazing sun is clamped: the footprint never exceeds ten radii of reach.
  unitShadowFootprint(0, 0, 0, 2, { x: 1, y: 0.06, z: 0 }, out);
  assert.ok(out.radius <= 2 + 10, `grazing radius ${out.radius}`);
});

test("a unit behind the camera whose shadow lies in the view is admitted for it", () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.2, 500);
  camera.position.set(0, 3, 0);
  camera.lookAt(0, 0, -20); // looking down -z
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  // A 3-yard unit 6.5 yards behind the camera, the level-3 key light behind it (towards +z, 20°).
  const elevation = (20 * Math.PI) / 180;
  const sun = { x: 0, y: Math.sin(elevation), z: Math.cos(elevation) };
  assert.equal(unitSphereVisibleInFrustum(0, 0, 6.5, 3, frustum.planes, 1), false, "the body is behind the camera");
  const out = { x: 0, y: 0, z: 0, radius: 0 };
  assert.equal(unitShadowFootprint(0, 0, 6.5, 3, sun, out), true);
  assert.equal(unitSphereVisibleInFrustum(out.x, out.y, out.z, out.radius, frustum.planes, 1), true,
    "its shadow, 8.2 yards long, reaches in front of the camera");
  // With the sun in front of the camera the shadow runs away behind it: not admitted.
  unitShadowFootprint(0, 0, 6.5, 3, { x: 0, y: sun.y, z: -sun.z }, out);
  assert.equal(unitSphereVisibleInFrustum(out.x, out.y, out.z, out.radius, frustum.planes, 1), false);
});

/** Cascades placed for a camera, with the fake renderer the cascaded-shadows tests use. */
function placedCascades(camera, sun, frame = 1) {
  const scene = new THREE.Scene();
  const primary = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(primary, primary.target);
  const fade = { value: new THREE.Vector3() };
  const cascades = new CascadedSunShadows(primary, fade);
  const renderer = { info: { render: { calls: 0 } }, shadowMap: { render() {} } };
  cascades.configure(scene, renderer, comparison);
  cascades.update(camera, sun, frame);
  return cascades;
}

function cityCamera() {
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 4000);
  camera.position.set(0, 8, 15);
  camera.lookAt(0, 1.5, 0);
  camera.updateMatrixWorld();
  return camera;
}

test("coverage is the view-fitted cascade's light-plane square, never the cached disc", () => {
  const sun = new THREE.Vector3(-1, 0.5, 0.4).normalize();
  const camera = cityCamera();
  const cascades = placedCascades(camera, sun);
  const near = cascades.stats.cascades[0];
  assert.ok(near.extent > 32, `the near cascade reaches past the old 32-yard edge: ${near.extent}`);
  const centre = cascades.lights[0].target.position;
  const basis = directionalShadowBasis(sun);
  const right = new THREE.Vector3(basis.right.x, basis.right.y, basis.right.z);
  // The square's centre and a point just inside its corner are covered; just outside, not.
  assert.equal(cascades.viewFittedCovers(centre.x, centre.y, centre.z, 0), true);
  const inside = centre.clone().addScaledVector(right, near.extent - 0.5);
  const outside = centre.clone().addScaledVector(right, near.extent + 1.5);
  assert.equal(cascades.viewFittedCovers(inside.x, inside.y, inside.z, 0), true);
  assert.equal(cascades.viewFittedCovers(outside.x, outside.y, outside.z, 0), false);
  assert.equal(cascades.viewFittedCovers(outside.x, outside.y, outside.z, 2), true, "the radius widens it");
  // The far disc (120 yards) is not a unit map: 100 yards out along the light plane is uncovered.
  const far = centre.clone().addScaledVector(right, near.extent + 60);
  assert.equal(cascades.viewFittedCovers(far.x, far.y, far.z, 0), false);
  // Before any placement nothing is covered.
  const fresh = new CascadedSunShadows(new THREE.DirectionalLight(), { value: new THREE.Vector3() });
  assert.equal(fresh.viewFittedCovers(0, 0, 0, 5), false);
});

test("reach: the strict extent plus the slack, and nothing without a shadow pass", () => {
  assert.equal(unitShadowInReach(32, comparison), true);
  assert.equal(unitShadowInReach(32 + UNIT_SHADOW_DISTANCE_SLACK, comparison), true);
  assert.equal(unitShadowInReach(32 + UNIT_SHADOW_DISTANCE_SLACK + 0.01, comparison), false);
  assert.equal(unitShadowInReach(5, lightingProfile(0)), false);
  assert.equal(unitShadowInReach(Number.NaN, comparison), false);
});

test("a caster keeps casting a few ranks and yards past the edges; a newcomer enters strictly", () => {
  const set = new UnitShadowCasterSet();
  const frame = (decisions) => {
    set.begin();
    const result = decisions.map(([key, rank, distance]) => set.decide(key, rank, distance, comparison));
    set.end();
    return result;
  };
  assert.deepEqual(frame([["a", 11, 31]]), [true]);
  // Slips to rank 15 and to 38 yards: still casting.
  assert.deepEqual(frame([["a", 12 + UNIT_SHADOW_RANK_SLACK - 1, 32 + UNIT_SHADOW_DISTANCE_SLACK]]), [true]);
  // Past either slack: stops.
  assert.deepEqual(frame([["a", 12 + UNIT_SHADOW_RANK_SLACK, 20]]), [false]);
  assert.deepEqual(frame([["e", 3, 10]]), [true]);
  assert.deepEqual(frame([["e", 3, 32 + UNIT_SHADOW_DISTANCE_SLACK + 0.5]]), [false]);
  // Stopped is stopped: the slack is for casters only.
  assert.deepEqual(frame([["a", 13, 20]]), [false]);
  assert.deepEqual(frame([["b", 13, 20], ["c", 3, 33]]), [false, false]);
  // A frame without the unit (not admitted) forgets it.
  assert.deepEqual(frame([["d", 2, 10]]), [true]);
  assert.deepEqual(frame([]), []);
  assert.deepEqual(frame([["d", 13, 10]]), [false]);
  // No shadow pass: never, held or not.
  const none = new UnitShadowCasterSet();
  none.begin();
  assert.equal(none.decide("x", 0, 1, lightingProfile(0)), false);
  none.end();
  none.begin();
  assert.equal(none.decide("x", 0, 1, lightingProfile(0)), false);
  // Unheld, the rule is the old one.
  for (const [rank, distance] of [[0, 0], [11, 32], [12, 1], [0, 32.5], [-1, 3]]) {
    const fresh = new UnitShadowCasterSet();
    fresh.begin();
    assert.equal(fresh.decide("k", rank, distance, comparison), unitCastsEnhancedShadow(rank, distance, comparison));
  }
});

/**
 * A deterministic crowd (230 spawns over 280 × 280 yards, the density of the Stormwind trade
 * district — 233 creature rows in that box in the realm's world DB) walked through at run speed for
 * 60 s while the camera swings ±60°, under the level-3 key light at 06:00 (its lowest, 20°), with the
 * real cascades placed every frame. Counts the hard pops: a unit's caster state switching while its
 * whole shadow footprint is on screen and inside the near map's unblended interior (at the map's
 * border the shader blends it out).
 */
function simulate(policy) {
  const units = [];
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let index = 0; index < 230; index++) units.push({ x: (random() - 0.5) * 280, z: (random() - 0.5) * 280, radius: 1.2 + random() * 2 });
  const sun = classicKeyLightDirection(2 * 60 * 6, new THREE.Vector3());
  const basis = directionalShadowBasis(sun);
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 4000);
  const matrix = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const scene = new THREE.Scene();
  const primary = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(primary, primary.target);
  const cascades = new CascadedSunShadows(primary, { value: new THREE.Vector3() });
  cascades.configure(scene, { info: { render: { calls: 0 } }, shadowMap: { render() {} } }, comparison);
  const casters = new UnitShadowCasterSet();
  const footprint = { x: 0, y: 0, z: 0, radius: 0 };
  let previous = new Map();
  let pops = 0;
  let maxCasters = 0;
  for (let frame = 0; frame < 60 * 60; frame++) {
    const t = frame / 60;
    const heading = 0.6;
    const px = Math.cos(heading) * (t - 30) * 7;
    const pz = Math.sin(heading) * (t - 30) * 7;
    const yaw = heading + Math.sin((t / 6) * 2 * Math.PI) * (Math.PI / 3);
    camera.position.set(px - Math.cos(yaw) * 15, 6, pz - Math.sin(yaw) * 15);
    camera.lookAt(px, 1.5, pz);
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    cascades.update(camera, sun, frame + 1);
    const near = cascades.lights[0].target.position;
    const nearR = near.x * basis.right.x + near.y * basis.right.y + near.z * basis.right.z;
    const nearU = near.x * basis.up.x + near.y * basis.up.y + near.z * basis.up.z;
    const interior = cascades.stats.cascades[0].extent * (1 - SHADOW_CASCADE_BLEND);
    const seen = new Map();
    const candidates = [];
    for (const [index, unit] of units.entries()) {
      const distance = Math.hypot(unit.x - px, unit.z - pz);
      if (distance > 100) continue;
      let visible = unitSphereVisibleInFrustum(unit.x, 0, unit.z, unit.radius, frustum.planes, 1);
      unitShadowFootprint(unit.x, 0, unit.z, unit.radius, sun, footprint);
      const r = footprint.x * basis.right.x + footprint.z * basis.right.z;
      const u = footprint.x * basis.up.x + footprint.y * basis.up.y + footprint.z * basis.up.z;
      const inInterior = Math.abs(r - nearR) + footprint.radius <= interior && Math.abs(u - nearU) + footprint.radius <= interior;
      const onScreen = unitSphereVisibleInFrustum(footprint.x, footprint.y, footprint.z, footprint.radius, frustum.planes, 1);
      seen.set(index, inInterior && onScreen);
      if (policy === "fixed" && !visible && unitShadowInReach(distance, comparison)
        && cascades.viewFittedCovers(footprint.x, footprint.y, footprint.z, footprint.radius)) visible = onScreen;
      candidates.push({ value: index, distance, pinned: false, visible });
    }
    const admitted = selectUnitAdmission(candidates, 64).admitted;
    const now = new Map();
    let casting = 0;
    casters.begin();
    for (const [rank0, { value, distance }] of admitted.entries()) {
      const rank = rank0 + 1; // the player is pinned at rank 0
      const casts = policy === "fixed"
        ? casters.decide(value, rank, distance, comparison)
        : unitCastsEnhancedShadow(rank, distance, comparison);
      now.set(value, casts);
      if (casts) casting++;
    }
    casters.end();
    maxCasters = Math.max(maxCasters, casting);
    for (const [index, visibleShadow] of seen) {
      if (frame > 0 && visibleShadow && (now.get(index) === true) !== (previous.get(index) === true)) pops++;
    }
    previous = now;
  }
  return { pops, maxCasters };
}

test("over a city walk the hard shadow pops halve, with the pass still bounded", () => {
  const before = simulate("old");
  const after = simulate("fixed");
  console.log(`[unit shadow casters] hard pops per minute: old ${before.pops}, fixed ${after.pops}; `
    + `max casters old ${before.maxCasters}, fixed ${after.maxCasters}`);
  assert.ok(before.pops > 40, `the old policy pops visibly: ${before.pops}`);
  assert.ok(after.pops * 1.8 < before.pops, `old ${before.pops} vs fixed ${after.pops}`);
  assert.ok(after.maxCasters <= comparison.shadowCasters + UNIT_SHADOW_RANK_SLACK, `casters ${after.maxCasters}`);
});

test("the renderer decides unit casters through the set and admits shadow-visible units", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /this\.#unitShadowCasters\.decide\(object\.guid, rank, distance, this\.#lightingProfile\)/);
  assert.match(source, /this\.#unitShadowCasters\.begin\(\);[^\n]*\n {4}for \(const \[rank, \{ value: object, distance \}\] of admission\.admitted\.entries\(\)\)/);
  assert.match(source, /this\.#unitShadowCasters\.end\(\);/);
  assert.match(source, /visible: visible \|\| this\.#unitShadowSeen\(object\.position, distance, radius!\)/);
  assert.match(source, /!unitShadowInReach\(distance, this\.#lightingProfile\)\) return false;/);
  assert.match(source, /this\.#sunCascades\.viewFittedCovers\(sphere\.x, sphere\.y, sphere\.z, sphere\.radius\)/);
  assert.doesNotMatch(source, /unitCastsEnhancedShadow\(rank, distance, this\.#lightingProfile\)\)/);
});
