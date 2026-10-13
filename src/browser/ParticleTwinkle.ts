/**
 * 6.15 (05.10-A7a-F1): particle twinkle — `twinkleSpeed`, `twinklePercent`, `twinkleScale{Min,Max}`.
 *
 * The reading is benilla's of the 1.12.1 client's particle quad writer (`docs/BENILLA_REFERENCE.ru.md`;
 * `CPPClientExample/benilla/crates/benilla-world/src/particles/quads.rs`, citing `0x7b2a50`,
 * `0x7b2a86`, `0x7b2adc` there): each frame a particle samples a 128-entry table of uniform noise at
 * `(floor(clamp(twinkleSpeed · age, 0, 255)) + phase) & 0x7f`, where `phase` is a per-particle hash.
 * Below a `twinklePercent` of 1 a sample above it draws no quad that frame; otherwise the quad's
 * size is multiplied by `min + noise · (max − min)`, a multiplier skipped when `min == max`.
 * The 3.3.5a client's own writer has not been opened for this (Wow.exe, stage 14.25 frames decide),
 * which is why it rides the `particleTwinkle` switch (`RenderSwitches.ts`), off by default.
 *
 * 13.10 6.15: the 3.3.5a writer is opened — CParticleEmitter2's quad writer 0x0097be80 (and the model-particle
 * one 0x0097a670): index ((particle address >> 5) + round(twinkleSpeed · age)) & 0x7f into the 128-float table
 * 0x00dce690, no clamp; below a twinklePercent of 1 a sample above it skips the particle; and the size is
 * multiplied by min + noise · (max − min) (+0x144, +0x148 from 0x0097ac00) *always* — a {0, 0} range draws
 * nothing, a {1, 1} range nothing different. The reading below now follows it exactly; the switch stays off by
 * default until the frames of 14.25 settle turning it on.
 *
 * Census (`probes/A7a/probe-emitters.mjs`, 25,520 emitters of `F:/Circle`): a visible effect — speed
 * above zero and a partial percent or a scale range other than 1..1 — on 3,414 emitters (`world`
 * 1,477, `item` 652, `spells` 639, `creature` 618); the common ranges are 1..1.25, 0..1, 0.5..1.5.
 */
import type { WvmParticleEmitter } from "./Wvm.js";
import { renderSwitches } from "./RenderSwitches.js";

const LUT_SIZE = 128;

/**
 * The noise table: uniform in [0, 1) like the original's, from a fixed seed — the distribution
 * matches, the stream does not (the original fills its table at startup from its own generator).
 */
export const TWINKLE_NOISE: Float32Array = (() => {
  const table = new Float32Array(LUT_SIZE);
  let state = 0x7b2a50;
  for (let index = 0; index < LUT_SIZE; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    table[index] = (state >>> 8) / 0x1000000;
  }
  return table;
})();

/** A stable per-particle offset into the table, from the emitter's spawn serial (no random draw). */
export function twinklePhase(serial: number): number {
  return (Math.imul(serial >>> 0, 0x9e3779b1) >>> 25) & 0x7f;
}

/** The table sample for one particle at `ageSeconds`. */
export function twinkleNoise(speed: number, ageSeconds: number, phase: number): number {
  // 13.10 6.15: rounded and unclamped, as 0x0097be80 (FISTP of twinkleSpeed · age, then & 0x7f).
  const step = Math.round(speed * ageSeconds);
  return TWINKLE_NOISE[(step + phase) & 0x7f]!;
}

/**
 * The size multiplier this frame: 0 when the percent gate hides the particle, 1 when the switch is
 * off or the range is degenerate. Allocation-free; runs per particle per frame.
 */
export function twinkleSize(
  emitter: Pick<WvmParticleEmitter, "twinkleSpeed" | "twinklePercent" | "twinkleScaleMin" | "twinkleScaleMax">,
  ageSeconds: number,
  phase: number,
): number {
  if (!renderSwitches.particleTwinkle) return 1;
  const noise = twinkleNoise(emitter.twinkleSpeed, ageSeconds, phase);
  if (emitter.twinklePercent < 1 && noise > emitter.twinklePercent) return 0;
  const range = emitter.twinkleScaleMax - emitter.twinkleScaleMin;
  // 13.10 6.15: applied whatever the range (0x0097be80) — a degenerate one multiplies by its own value.
  return Math.max(0, emitter.twinkleScaleMin + noise * range);
}
