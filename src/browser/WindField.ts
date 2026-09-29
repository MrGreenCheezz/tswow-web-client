/**
 * One wind for the whole outdoor scene.
 *
 * Trees, ground cover, rain, snow, blown sand and the ambient motes all read the same direction
 * and strength, so a gust that bends a meadow also slants the rain above it. The field is cheap
 * on purpose: the CPU only eases four numbers per frame, and every vertex that moves reads them
 * from the two shared uniforms below.
 *
 * Nothing here is authored by the original client — 3.3.5a has no wind model at all — so the
 * field is an enhancement behind `experimentalWindGusts`. OFF leaves `WIND_FIELD_UNIFORM.w` at 0,
 * which makes the vegetation shader take exactly its pre-field sway (see VegetationWind.ts).
 */

import * as THREE from "three";
import type { IUniform } from "three";
import type { WeatherKind } from "../world/WorldMessageProtocol.js";

/** Scene-space wind: (direction x, direction z, strength 0..1, field mix 0..1). */
export const WIND_FIELD_UNIFORM: IUniform<THREE.Vector4> = { value: new THREE.Vector4(1, 0, 0, 0) };
/** (gust amount 0..1, travelling wave phase in radians, unused, unused). */
export const WIND_GUST_UNIFORM: IUniform<THREE.Vector4> = { value: new THREE.Vector4(0, 0, 0, 0) };
export const WIND_FIELD_UNIFORM_NAME = "uVegetationWindField";
export const WIND_GUST_UNIFORM_NAME = "uVegetationWindGust";

/** Seconds for the strength to cover ~63% of a weather change (the weather itself fades in 5 s). */
export const WIND_STRENGTH_TIME_CONSTANT = 4;
/** How far the direction wanders either side of the prevailing one, in radians. */
export const WIND_DIRECTION_WANDER = 0.42;
/** Yards per second a full-strength wind pushes rain sideways; 12 against a 22 yd/s fall is ~29°. */
export const WIND_RAIN_SPEED = 12;

/**
 * How hard the wind blows for a weather, 0..1.
 *
 * Calm is not zero — a fine day still has a breeze in the leaves. Rain scales with the server's
 * own intensity; `thunders` is the one state the server sends for a storm, so only it reaches the
 * top of the scale. Sand is a storm by definition. Fog is still air.
 */
export function weatherWindTarget(kind: WeatherKind, density: number, thunder: boolean): number {
  const d = Math.max(0, Math.min(1, Number.isFinite(density) ? density : 0));
  switch (kind) {
    case "fine": return 0.42;
    case "fog": return 0.12;
    case "snow": return 0.3 + 0.4 * d;
    case "sand": return 0.7 + 0.3 * d;
    case "rain": return thunder ? Math.max(0.85, 0.6 + 0.4 * d) : 0.36 + 0.4 * d;
  }
}

/** Stable prevailing direction for a map, so a zone keeps its wind across sessions. */
export function prevailingWindAngle(map: number | undefined): number {
  const seed = Math.imul((map ?? 0) + 0x9e37, 0x85ebca6b) >>> 0;
  return (seed / 4294967296) * Math.PI * 2;
}

/**
 * Smooth, deterministic noise from a few incommensurate sines: no per-frame allocation, no
 * randomness, identical in a replayed benchmark.
 */
export function slowNoise(t: number, seed: number): number {
  return (Math.sin(t * 0.071 + seed) * 0.5
    + Math.sin(t * 0.173 + seed * 2.3) * 0.3
    + Math.sin(t * 0.419 + seed * 4.1) * 0.2);
}

export class WindField {
  #strength = 0.42;
  #angle = 0;
  #wavePhase = 0;
  #gust = 0;
  #enabled = false;
  #initialised = false;

  /** Scene-space unit direction; read by rain, snow and motes. */
  readonly direction = new THREE.Vector2(1, 0);

  get strength(): number { return this.#strength; }
  get gust(): number { return this.#gust; }
  get enabled(): boolean { return this.#enabled; }

  /** Whether trees and grass take the field (mix 1) or their original standing sway (mix 0). */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    WIND_FIELD_UNIFORM.value.w = enabled ? 1 : 0;
  }

  /**
   * Advances the field one frame. `seconds` is the frame clock (deterministic in the bench),
   * `elapsed` the frame's step.
   */
  update(seconds: number, elapsed: number, map: number | undefined, target: number): void {
    const step = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.25, elapsed)) : 0;
    const clamped = Math.max(0, Math.min(1, target));
    if (!this.#initialised) {
      this.#strength = clamped;
      this.#initialised = true;
    } else {
      this.#strength += (clamped - this.#strength) * (1 - Math.exp(-step / WIND_STRENGTH_TIME_CONSTANT));
    }
    const t = Number.isFinite(seconds) ? seconds : 0;
    this.#angle = prevailingWindAngle(map) + WIND_DIRECTION_WANDER * slowNoise(t * 0.35, 1.7);
    this.direction.set(Math.cos(this.#angle), Math.sin(this.#angle));
    // Gusts: slow noise mapped to 0..1, stronger and more frequent in a stronger wind.
    const gustNoise = 0.5 + 0.5 * slowNoise(t * (0.9 + this.#strength), 5.3);
    this.#gust = Math.max(0, Math.min(1, gustNoise * (0.45 + 0.55 * this.#strength)));
    // The travelling wave's phase is integrated, never recomputed from t × speed: a change of
    // speed then changes how fast the waves roll rather than teleporting them.
    this.#wavePhase = (this.#wavePhase + step * (0.6 + 1.3 * this.#strength)) % (Math.PI * 2000);
    WIND_FIELD_UNIFORM.value.set(this.direction.x, this.direction.y, this.#strength, this.#enabled ? 1 : 0);
    WIND_GUST_UNIFORM.value.set(this.#gust, this.#wavePhase, 0, 0);
  }

  /** Back to the calm default, and the shared uniforms to the exact OFF values. */
  reset(): void {
    this.#strength = 0.42;
    this.#angle = 0;
    this.#wavePhase = 0;
    this.#gust = 0;
    this.#initialised = false;
    this.direction.set(1, 0);
    WIND_FIELD_UNIFORM.value.set(1, 0, 0, this.#enabled ? 1 : 0);
    WIND_GUST_UNIFORM.value.set(0, 0, 0, 0);
  }
}
