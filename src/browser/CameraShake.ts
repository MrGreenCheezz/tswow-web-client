// 05.10-A7a-E (6.13): camera shake from SpellVisualKit.ShakeID, as Wow.exe 3.3.5a 12340 runs it.
//
// Read from Wow.exe (Ghidra, read-only; .runtime/re-2026-10-05/A7a-E/r2.c, r3.c):
//
// - 0x00606410 resolves a CameraShakes row and 0x00606330 queues it with the source position and the
//   start time; the row's Amplitude is stored multiplied by 1/36 (0x00a3f854).
// - 0x00606970, every frame: t = (now − start) / 1000 + Phase; at t ≥ Duration the shake is dropped.
//   The source is tested against a point (0x006004b0): beyond 80 yards (6,400 squared) it does nothing,
//   within 9 yards (81) it is at full amplitude, in between the amplitude is scaled by a falloff
//   (0x0088d0c0, arguments on the FPU stack, not read). Of the live shakes only the strongest
//   (attenuated amplitude) per Direction 0/1/2 is applied.
// - 0x005fe6c0 applies one: v = sin(2π · Frequency · t) · amplitude, times exp(−t · Coefficient) when
//   ShakeType is 1; Direction 0 moves along the facing (cos yaw, sin yaw), 1 along facing + 90°, 2 up.
//   The facing is that of the unit the camera follows (0x00717e50).
//
// Kept as hypotheses (listed in the plan): the falloff between 9 and 80 yards is linear here; the point the
// distance is measured from is the camera's subject; the offset moves the whole camera (position and aim).
// The stock interface has no camera-shake option in this build (no "cameraShake" string in Wow.exe).
//
// Cost: at most a few dozen live shakes; `offset` walks them once and allocates nothing.

import type { SpellVisualShake } from "../gateway/SpellVisual.js";

export type { SpellVisualShake };

/** Wow.exe 0x00a3f854: the stored amplitude is the table's divided by 36. */
export const SHAKE_AMPLITUDE_SCALE = 1 / 36;
/** Full amplitude within this many yards of the source (0x00a1e360 = 9, squared 81). */
export const SHAKE_FULL_RANGE = 9;
/** No shake beyond this many yards (0x00a1e364 = 80, squared 6,400). */
export const SHAKE_MAX_RANGE = 80;
/** A burst of kits cannot grow the bank without bound. */
export const SHAKE_CAPACITY = 64;

export interface ShakePoint {
  x: number;
  y: number;
  z: number;
}

interface LiveShake {
  def: SpellVisualShake;
  x: number;
  y: number;
  z: number;
  startedAt: number;
}

/** Linear falloff between SHAKE_FULL_RANGE and SHAKE_MAX_RANGE (hypothesis; see the header). */
export function shakeAttenuation(distance: number): number {
  if (!(distance > SHAKE_FULL_RANGE)) return 1;
  if (distance >= SHAKE_MAX_RANGE) return 0;
  return (SHAKE_MAX_RANGE - distance) / (SHAKE_MAX_RANGE - SHAKE_FULL_RANGE);
}

/** One shake's displacement along its direction at `t` seconds of its own clock (0x005fe6c0). */
export function shakeValue(def: SpellVisualShake, amplitude: number, t: number): number {
  let value = Math.sin(2 * Math.PI * def.frequency * t) * amplitude;
  if (def.type === 1) value *= Math.exp(-t * def.coefficient);
  return value;
}

export class CameraShakeBank {
  readonly #live: LiveShake[] = [];
  readonly #best = [0, 0, 0];
  readonly #bestT = [0, 0, 0];
  readonly #bestShake: (LiveShake | undefined)[] = [undefined, undefined, undefined];

  get size(): number {
    return this.#live.length;
  }

  /** Queues a kit's shakes at a source point (server coordinates) from `now` (ms). */
  add(defs: readonly SpellVisualShake[], source: ShakePoint, now: number): void {
    for (const def of defs) {
      if (!(def.duration > 0) || !(def.amplitude !== 0)) continue;
      if (this.#live.length >= SHAKE_CAPACITY) this.#live.shift();
      this.#live.push({ def, x: source.x, y: source.y, z: source.z, startedAt: now });
    }
  }

  clear(): void {
    this.#live.length = 0;
  }

  /**
   * The camera's displacement now (server coordinates, yards) for a subject at `listener` facing `facing`
   * (radians). Writes `out` and answers whether anything shakes; drops finished shakes.
   */
  offset(now: number, listener: ShakePoint, facing: number, out: ShakePoint): boolean {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    const live = this.#live;
    if (live.length === 0) return false;
    const best = this.#best;
    const bestT = this.#bestT;
    const bestShake = this.#bestShake;
    best[0] = best[1] = best[2] = 0;
    bestShake[0] = bestShake[1] = bestShake[2] = undefined;
    let write = 0;
    for (let index = 0; index < live.length; index++) {
      const shake = live[index]!;
      const t = (now - shake.startedAt) / 1000 + shake.def.phase;
      if (t >= shake.def.duration) continue; // dropped: not copied forward
      live[write++] = shake;
      if (t < 0) continue;
      const channel = shake.def.direction;
      if (channel !== 0 && channel !== 1 && channel !== 2) continue;
      const distance = Math.hypot(shake.x - listener.x, shake.y - listener.y, shake.z - listener.z);
      const amplitude = shake.def.amplitude * SHAKE_AMPLITUDE_SCALE * shakeAttenuation(distance);
      if (amplitude === 0 || Math.abs(amplitude) <= Math.abs(best[channel]!)) continue;
      best[channel] = amplitude;
      bestT[channel] = t;
      bestShake[channel] = shake;
    }
    live.length = write;
    let any = false;
    for (let channel = 0; channel < 3; channel++) {
      const shake = bestShake[channel];
      if (!shake) continue;
      const value = shakeValue(shake.def, best[channel]!, bestT[channel]!);
      if (channel === 2) out.z += value;
      else {
        const yaw = channel === 0 ? facing : facing + Math.PI / 2;
        out.x += Math.cos(yaw) * value;
        out.y += Math.sin(yaw) * value;
      }
      any = true;
    }
    return any;
  }
}
