// 15.11 (sky8, 7.04): what hides the sun's and the moon's glare, as Wow.exe 3.3.5a (12340) decides it.
//
// 0x007ef6e0 multiplies a glare's target by its occlusion (vtable +8 = 0x009ac3c0) while the target is not 0. On a
// card with occlusion queries (the stand's) that is 0x009abe00: a colourless unit square at the glare, depth-tested
// against the finished world at the far end of the depth range, its passed pixels over its projected area, at most 1
// — a glare off the screen or behind the world counts 0. Without queries it is the ray 0x009abc60: from the camera,
// 0.5 yards along (0x009e2ec4), to the far clip toward the glare; world collision there (0x0077f310, flags 0x200112)
// or the scene test 0x004f9410 makes it 0, otherwise 1.
//
// Here the query is taken as its two halves: whether the glare's direction is on the screen (`glareOnScreen`, in
// the renderer, which has the camera) and the ray (`glareRayClear`, on the page, which has the terrain and the
// collision world; the result rides on the frame's light sample). The query's square has a size this client has not
// read (0x007edbe0 scales it by a field not identified), so its share at the screen's edge is all or nothing.

import * as THREE from "three";
import {
  computeCelestialFrame, createCelestialFrame, skyDayFraction, skyKeyCurve, type CelestialFrame, type SkyVector,
} from "./SkyCelestials.js";
import { MOON_GLARE, SUN_GLARE } from "./SkyGlare.js";
import { WOW_FAR_CLIP } from "./DistanceFog.js";
import type { LightSample } from "./LightTypes.js";

/** 0x009e2ec4: the ray leaves the camera half a yard along its direction. */
export const GLARE_RAY_START = 0.5;
/** How far apart the heightfield is asked about along the ray, in yards (the collision world takes the whole segment). */
export const GLARE_RAY_TERRAIN_STEP = 3;

/** What the ray can run into: the heightfield and the placed models (`CollisionWorld.firstHit`). */
export interface GlareRayWorld {
  heightAt?: ((x: number, y: number) => number | undefined) | undefined;
  firstHit?: ((from: SkyVector, to: SkyVector) => unknown) | undefined;
}

/**
 * 0x009abc60: whether nothing lies between the eye and the far clip toward `direction` (world axes, unit). The
 * heightfield is sampled every {@link GLARE_RAY_TERRAIN_STEP} yards; a point under the ground stops it.
 */
export function glareRayClear(eye: SkyVector, direction: SkyVector, far: number, world: GlareRayWorld): boolean {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0) || !(far > GLARE_RAY_START)) return true;
  const dx = direction.x / length, dy = direction.y / length, dz = direction.z / length;
  const from = { x: eye.x + dx * GLARE_RAY_START, y: eye.y + dy * GLARE_RAY_START, z: eye.z + dz * GLARE_RAY_START };
  const to = { x: eye.x + dx * far, y: eye.y + dy * far, z: eye.z + dz * far };
  const heightAt = world.heightAt;
  if (heightAt) {
    for (let along = GLARE_RAY_START; along <= far; along += GLARE_RAY_TERRAIN_STEP) {
      const x = eye.x + dx * along, y = eye.y + dy * along;
      const ground = heightAt(x, y);
      if (ground !== undefined && eye.z + dz * along < ground) return false;
    }
  }
  return !(world.firstHit && world.firstHit(from, to) !== undefined);
}

/** A scene-space body direction (`SkyCelestials`: world (x, y, z) drawn as (x, z, −y)) in world axes. */
export function sceneToWorldDirection(scene: SkyVector, out: SkyVector): SkyVector {
  out.x = scene.x;
  out.y = -scene.z;
  out.z = scene.y;
  return out;
}

/** The ray's answer for each glare: 1 clear, 0 hidden; 1 too when its glare cannot show and nothing was asked. */
export interface GlareRays {
  sun: number;
  moon: number;
}

// Made on first use: `SkyCelestials` imports this module, so nothing of it may run while the modules load.
let frame: CelestialFrame | undefined;
const direction: SkyVector = { x: 0, y: 0, z: 1 };

/**
 * One frame of rays for the client's sun and moon at this light time (half-minutes), from the eye, as far as the far
 * clip. A glare whose day curve is 0 is not asked (0x007ef6e0 asks only for a target that is not 0).
 */
export function glareRays(time: number, eye: SkyVector, far: number, world: GlareRayWorld, out: GlareRays): GlareRays {
  const fraction = skyDayFraction(time);
  frame = computeCelestialFrame(fraction, 0, frame ?? createCelestialFrame());
  out.sun = skyKeyCurve(SUN_GLARE.dayKeys, fraction) > 0
    && !glareRayClear(eye, sceneToWorldDirection(frame.sun, direction), far, world) ? 0 : 1;
  out.moon = skyKeyCurve(MOON_GLARE.dayKeys, fraction) > 0
    && !glareRayClear(eye, sceneToWorldDirection(frame.moon, direction), far, world) ? 0 : 1;
  return out;
}

const rays: GlareRays = { sun: 1, moon: 1 };

/**
 * The page's half, once a frame: the rays from the eye at this light time, written onto the frame's light sample
 * for the renderer (`LightSample.sunGlareRay`, `moonGlareRay`). The far clip is the stand's, 1277 yards.
 */
export function stampGlareRays(sample: LightSample, time: number, eye: SkyVector, world: GlareRayWorld): void {
  glareRays(time, eye, WOW_FAR_CLIP, world, rays);
  sample.sunGlareRay = rays.sun;
  sample.moonGlareRay = rays.moon;
}

const projected = new THREE.Vector3();

/**
 * Whether a glare's scene-space direction lands on the screen: in front of the camera and inside the frustum's sides.
 * The query's pixels are counted on the screen only, so a glare off it counts 0.
 */
export function glareOnScreen(camera: THREE.Camera, at: SkyVector): boolean {
  projected.set(camera.position.x + at.x, camera.position.y + at.y, camera.position.z + at.z);
  projected.applyMatrix4(camera.matrixWorldInverse);
  if (!(projected.z < 0)) return false;
  projected.applyMatrix4(camera.projectionMatrix);
  return Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
}
