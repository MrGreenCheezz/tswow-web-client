/**
 * 24.10 (7.50): every lamp in view within `LIGHT_POOL_RANGE` lays its warm pool on the ground and
 * walls. Owner, 24.10 (Stormwind trade district, night): the far lamps' glass glows, but only the
 * nearest few have a pool on the cobbles — a few yards farther there is none, and pools appear as
 * one walks, as if loading late.
 *
 * The forward pool (`CinematicLights.ts`) is a per-pixel loop in every lit material over the
 * `WORLD_LOCAL_LIGHT_LIMIT` (12) lights `LocalLightSelection` keeps within 64 yards; the trade
 * district has far more lamps than that in view. The rest are lit here, in screen space
 * (`LightPoolPass.ts`): this class picks them from the far glows' source list (`FarLightGlows.ts`,
 * which already knows every outdoor lamp, built or not), weighs them and writes one instance each.
 *
 * - Hand-over: a lamp's deferred weight is the complement of its forward weight,
 *   `1 − localLightSelectionFade(rank, cut)`, ranked from the same focus and with the same WMO rank
 *   scale as the selection. A lamp in the forward set fades out of it over the band before the
 *   first lamp left out and into this set over the same band, so a pool neither pops nor doubles.
 * - The far end: a smooth fade over the last `LIGHT_POOL_FADE_OUT` yards of the range (and, when
 *   the instance cap binds, before the first lamp left out), under the far glow that stays.
 * - In view: a lamp is kept while its pool's sphere touches the view frustum.
 *
 * The list is re-picked only after the focus moved `LIGHT_POOL_REPICK` yards or the far sources
 * were rebuilt; a frame re-weights the picked few hundred into preallocated arrays.
 */
import * as THREE from "three";
import { CINEMATIC_POOL_REACH, localLightSelectionFade, WMO_LIGHT_RANK_SCALE } from "./CinematicLights.js";
import { FAR_LIGHT_STRIDE } from "./FarLightGlows.js";
import { LIGHT_HALO_STRENGTH } from "./LightHalos.js";

/** Ranked distance, yards from the selection's focus, past which no lamp lays a screen-space pool. */
export const LIGHT_POOL_RANGE = 150;
/** Yards at the range's end over which a pool fades out. */
export const LIGHT_POOL_FADE_OUT = 30;
/** Most screen-space pools drawn in one frame (nearest first). */
export const LIGHT_POOL_LIMIT = 256;
/** Yards the focus moves before the candidates are picked again. */
export const LIGHT_POOL_REPICK = 4;
/** Floats per instance in each of the two instance arrays (`poolLamp`, `poolColour`). */
export const LIGHT_POOL_INSTANCE_FLOATS = 4;

const smooth = (t: number): number => t * t * (3 - 2 * t);
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/**
 * The share of a lamp's light the screen-space pool lays, for a lamp ranked `rank` yards from the
 * selection's focus when the forward set faded out towards `cut`: what the forward set does not
 * draw, faded out over the range's last stretch (or before `range` when the cap binds).
 */
export function lightPoolWeight(rank: number, cut: number, range = LIGHT_POOL_RANGE): number {
  if (!Number.isFinite(rank) || rank < 0 || !(range > 0)) return 0;
  const forward = cut > 0 ? localLightSelectionFade(rank, cut) : 0;
  const band = Math.min(LIGHT_POOL_FADE_OUT, range);
  const far = 1 - smooth(clamp01((rank - (range - band)) / band));
  return (1 - forward) * far;
}

/** The pool's reach for a far source's signed reach, as the forward shader takes it (`wowPoolReach`). */
export function lightPoolReach(signedReach: number): number {
  return signedReach < 0 ? -signedReach : Math.max(signedReach, CINEMATIC_POOL_REACH);
}

/** What the far glows hand over (`FarLightGlows`). */
export interface LightPoolSources {
  readonly sources: Float32Array;
  readonly sourceCount: number;
  readonly sourceGeneration: number;
}

export class LightPools {
  /** View-space x, y, z and the light's signed radius per drawn pool (`poolLamp`, as `wowLocalLightPosition`). */
  readonly lamps = new Float32Array(LIGHT_POOL_LIMIT * LIGHT_POOL_INSTANCE_FLOATS);
  /** Display-space colour times strength per drawn pool, w unused (`poolColour`). */
  readonly colours = new Float32Array(LIGHT_POOL_LIMIT * LIGHT_POOL_INSTANCE_FLOATS);
  /** Scene x, y, z and the brightest channel of the colour per drawn pool, for the bench's census (`LightCensus.ts`). */
  readonly scene = new Float32Array(LIGHT_POOL_LIMIT * LIGHT_POOL_INSTANCE_FLOATS);
  #count = 0;
  #picked = new Uint32Array(LIGHT_POOL_LIMIT);
  #pickedCount = 0;
  #pickedRange = LIGHT_POOL_RANGE;
  readonly #pickedAt = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);
  #pickedGeneration = -1;
  #pickedFrom: Float32Array | undefined;
  #distances = new Float32Array(1024);
  #order = new Uint32Array(1024);
  readonly #byDistance = (a: number, b: number): number => this.#distances[a]! - this.#distances[b]!;
  readonly #frustum = new THREE.Frustum();
  readonly #matrix = new THREE.Matrix4();
  readonly #sphere = new THREE.Sphere();
  readonly #view = new THREE.Vector3();
  /** Bench only: lamps ranked past this draw no screen-space pool (a forward-against-deferred comparison). */
  debugMaxRank = Number.POSITIVE_INFINITY;
  /** Counters for the bench: candidates picked, pools drawn, and their ranks' extremes. */
  readonly stats = { picked: 0, drawn: 0, nearest: 0, farthest: 0 };

  /** Pools written by the last `update`. */
  get count(): number {
    return this.#count;
  }

  /** Draws nothing (the faithful profiles, or no screen-space pass this frame). */
  clear(): void {
    this.#count = 0;
    this.stats.drawn = 0;
  }

  /**
   * One frame: re-picks the candidates when the focus moved or the sources changed, then weighs
   * each against the forward set's `cut` and writes the ones in view. `camera` has its world and
   * projection matrices current (the selection just wrote with them).
   */
  update(far: LightPoolSources, focus: THREE.Vector3, cut: number, camera: THREE.Camera): number {
    const sources = far.sources;
    if (far.sourceGeneration !== this.#pickedGeneration || sources !== this.#pickedFrom
      || this.#pickedAt.distanceToSquared(focus) > LIGHT_POOL_REPICK * LIGHT_POOL_REPICK) {
      this.#pick(far, focus);
    }
    const view = camera.matrixWorldInverse;
    this.#frustum.setFromProjectionMatrix(this.#matrix.multiplyMatrices(camera.projectionMatrix, view));
    const range = Math.min(LIGHT_POOL_RANGE, this.#pickedRange);
    const lamps = this.lamps;
    const colours = this.colours;
    const sphere = this.#sphere;
    const position = this.#view;
    let count = 0;
    let nearest = Number.POSITIVE_INFINITY;
    let farthest = 0;
    for (let index = 0; index < this.#pickedCount; index++) {
      const at = this.#picked[index]! * FAR_LIGHT_STRIDE;
      const x = sources[at]!, y = sources[at + 1]!, z = sources[at + 2]!;
      const share = sources[at + 7]!;
      const dx = x - focus.x, dy = y - focus.y, dz = z - focus.z;
      const rank = Math.sqrt(dx * dx + dy * dy + dz * dz) * (share < 1 ? WMO_LIGHT_RANK_SCALE : 1);
      const weight = rank > this.debugMaxRank ? 0 : lightPoolWeight(rank, cut, range);
      if (!(weight > 0.002)) continue;
      const signedReach = sources[at + 6]!;
      const reach = lightPoolReach(signedReach);
      sphere.center.set(x, y, z);
      sphere.radius = reach;
      if (!this.#frustum.intersectsSphere(sphere)) continue;
      // The glow's colour is the light's colour · intensity · LIGHT_HALO_STRENGTH · share.
      const scale = weight / (LIGHT_HALO_STRENGTH * (share > 0 ? share : 1));
      const red = sources[at + 3]! * scale, green = sources[at + 4]! * scale, blue = sources[at + 5]! * scale;
      if (!(Math.max(red, green, blue) > 0.002)) continue;
      position.set(x, y, z).applyMatrix4(view);
      const out = count * LIGHT_POOL_INSTANCE_FLOATS;
      lamps[out] = position.x;
      lamps[out + 1] = position.y;
      lamps[out + 2] = position.z;
      // The light's own signed radius, as `wowLocalLightPosition.w` carries it; the shader widens it to the pool's reach.
      lamps[out + 3] = signedReach;
      colours[out] = red;
      colours[out + 1] = green;
      colours[out + 2] = blue;
      colours[out + 3] = 0;
      const scene = this.scene;
      scene[out] = x;
      scene[out + 1] = y;
      scene[out + 2] = z;
      scene[out + 3] = Math.max(red, green, blue);
      if (rank < nearest) nearest = rank;
      if (rank > farthest) farthest = rank;
      count++;
    }
    this.#count = count;
    this.stats.drawn = count;
    this.stats.nearest = count > 0 ? nearest : 0;
    this.stats.farthest = farthest;
    return count;
  }

  /**
   * Bench only (allocates): the lamps the last `update` had in view, by ranked distance in bins of
   * `bin` yards — how many there were, how many the forward set lit (at least half strength) and how
   * many the screen-space pools lit (at least half strength). Reads the same picked list and cut.
   */
  census(far: LightPoolSources, focus: THREE.Vector3, cut: number, camera: THREE.Camera, bin = 15):
    { readonly bin: number; readonly inView: number[]; readonly forward: number[]; readonly screen: number[] } {
    const sources = far.sources;
    const bins = Math.ceil(LIGHT_POOL_RANGE / bin);
    const inView = new Array<number>(bins).fill(0);
    const forward = new Array<number>(bins).fill(0);
    const screen = new Array<number>(bins).fill(0);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sphere = new THREE.Sphere();
    const range = Math.min(LIGHT_POOL_RANGE, this.#pickedRange);
    for (let index = 0; index < this.#pickedCount; index++) {
      const at = this.#picked[index]! * FAR_LIGHT_STRIDE;
      const dx = sources[at]! - focus.x, dy = sources[at + 1]! - focus.y, dz = sources[at + 2]! - focus.z;
      const rank = Math.sqrt(dx * dx + dy * dy + dz * dz) * (sources[at + 7]! < 1 ? WMO_LIGHT_RANK_SCALE : 1);
      const slot = Math.floor(rank / bin);
      if (slot >= bins) continue;
      sphere.center.set(sources[at]!, sources[at + 1]!, sources[at + 2]!);
      sphere.radius = lightPoolReach(sources[at + 6]!);
      if (!frustum.intersectsSphere(sphere)) continue;
      inView[slot]!++;
      if (cut > 0 && localLightSelectionFade(rank, cut) >= 0.5) forward[slot]!++;
      if (this.#count > 0 && lightPoolWeight(rank, cut, range) >= 0.5) screen[slot]!++;
    }
    return { bin, inView, forward, screen };
  }

  #pick(far: LightPoolSources, focus: THREE.Vector3): void {
    this.#pickedAt.copy(focus);
    this.#pickedGeneration = far.sourceGeneration;
    this.#pickedFrom = far.sources;
    const sources = far.sources;
    const total = far.sourceCount;
    if (this.#distances.length < total) {
      this.#distances = new Float32Array(Math.max(total, this.#distances.length * 2));
      this.#order = new Uint32Array(this.#distances.length);
    }
    const distances = this.#distances;
    const order = this.#order;
    // Ranked as the selection ranks (a WMO record half as far again); the margin covers the repick.
    const outer = LIGHT_POOL_RANGE + LIGHT_POOL_REPICK;
    let count = 0;
    for (let index = 0; index < total; index++) {
      const at = index * FAR_LIGHT_STRIDE;
      const dx = sources[at]! - focus.x, dy = sources[at + 1]! - focus.y, dz = sources[at + 2]! - focus.z;
      const scale = sources[at + 7]! < 1 ? WMO_LIGHT_RANK_SCALE : 1;
      const squared = (dx * dx + dy * dy + dz * dz) * scale * scale;
      if (squared > outer * outer) continue;
      distances[index] = squared;
      order[count++] = index;
    }
    this.#pickedRange = LIGHT_POOL_RANGE;
    if (count > LIGHT_POOL_LIMIT) {
      order.subarray(0, count).sort(this.#byDistance);
      // The first lamp left out ends the range: everything picked has faded out before it.
      this.#pickedRange = Math.max(0, Math.sqrt(distances[order[LIGHT_POOL_LIMIT]!]!) - LIGHT_POOL_REPICK);
      count = LIGHT_POOL_LIMIT;
    }
    this.#picked.set(order.subarray(0, count));
    this.#pickedCount = count;
    this.stats.picked = count;
  }
}
