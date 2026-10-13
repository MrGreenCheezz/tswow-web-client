// 13.10 (6.12): the world test a ground-following missile asks (Wow.exe 0x006fffc0 → 0x0077f310, mask 0x111:
// terrain, WMO and doodad collision), answered here from the renderer's terrain height alone: the first point
// of the segment where it goes from above the ground to on or under it. A segment that starts under the ground
// meets nothing, as a one-sided terrain triangle met from behind does. Server coordinates.
//
// Cost: at most MAX_SAMPLES height samples and 8 bisection steps a call; nothing is allocated.

import * as THREE from "three";

export interface GroundPoint {
  x: number;
  y: number;
  z: number;
}

/** The terrain's height at a server (x, y), undefined where it is not known. */
export type GroundHeight = (x: number, y: number) => number | undefined;

/** Samples along a segment (one every half yard, at most this many). */
const MAX_SAMPLES = 64;
const SAMPLE_YARDS = 0.5;
const BISECTIONS = 8;

/** The fraction 0…1 of `from → to` where it meets the ground, with the point in `hit`; undefined for none. */
export function missileGroundHit(heightAt: GroundHeight | undefined, from: Readonly<GroundPoint>, to: Readonly<GroundPoint>,
  hit: GroundPoint): number | undefined {
  if (!heightAt) return undefined;
  const above = (t: number): boolean | undefined => {
    const ground = heightAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    return ground === undefined ? undefined : from.z + (to.z - from.z) * t > ground;
  };
  if (above(0) !== true) return undefined;
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const samples = Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(length / SAMPLE_YARDS)));
  let low = 0;
  for (let index = 1; index <= samples; index++) {
    const t = index / samples;
    const state = above(t);
    if (state === undefined) return undefined;
    if (state) {
      low = t;
      continue;
    }
    let high = t;
    for (let step = 0; step < BISECTIONS; step++) {
      const middle = (low + high) / 2;
      if (above(middle) === true) low = middle;
      else high = middle;
    }
    hit.x = from.x + (to.x - from.x) * high;
    hit.y = from.y + (to.y - from.y) * high;
    hit.z = heightAt(hit.x, hit.y) ?? from.z + (to.z - from.z) * high;
    return high;
  }
  return undefined;
}

const _offset = new THREE.Vector3();
const _turn = new THREE.Quaternion();

/**
 * 13.10: a SpellVisual offset (M2 frame: x forward, y left, z up) added to `out` (scene coordinates) in the
 * model frame of `node` (its world turn), as 0x006ff6d0/0x007fabf0 move the attachment-less aim point.
 */
export function addModelFrameOffset(node: THREE.Object3D, offset: readonly [number, number, number], out: THREE.Vector3): void {
  _offset.set(offset[0], offset[2], -offset[1]).applyQuaternion(node.getWorldQuaternion(_turn));
  out.add(_offset);
}
