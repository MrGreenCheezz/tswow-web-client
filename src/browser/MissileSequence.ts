/**
 * 6.31 (26.10): which sequence a missile's model plays in flight, and how fast — as Wow.exe's Missile_C sets it when
 * the missile is launched at its target (wowdecomp Missile_C.cpp, the target setup next to NewMissile 0x00702b10).
 *
 * A missile with no distance to cover plays Stand (0) at its own speed. Every other plays InFlight (144); when the
 * model has it and the sequence's flag 0x1 is set, the speed is `duration × speed / distance` — one cycle of the
 * clip stretched over the whole flight — otherwise its own speed. A model without 144 falls back to Stand.
 *
 * Owner, 26.10: «Чародейские стрелы … после сужения вновь расходятся». `Arcane_Missile_Lvl1/Lvl3.m2` author a 1 s
 * InFlight (an alias of Stand, flags 0x61) in which three bolts spread and meet again; this client looped Stand at
 * its own speed, so a flight longer than a second converged and spread again. Census of 26.10: 76 of the 1,567 spell
 * models carry 144, 44 of them with the flag.
 */

export const MISSILE_ANIM_STAND = 0;
export const MISSILE_ANIM_IN_FLIGHT = 144;
/** `M2Sequence.flags` bit Missile_C tests before stretching InFlight over the flight. */
export const MISSILE_SEQUENCE_STRETCH = 0x1;

export interface MissileSequencePick {
  animation: number;
  /** Clip seconds per second of flight. */
  timeScale: number;
}

/**
 * `inFlight`: the model's InFlight clip length in seconds and its sequence flags, or undefined when it has none (or
 * its clip has not arrived). `flightSeconds`: the flight's planned length; 0 or less is a missile with no distance.
 */
export function missileSequence(
  inFlight: { readonly seconds: number; readonly flags: number | undefined } | undefined,
  flightSeconds: number,
  out: MissileSequencePick,
): MissileSequencePick {
  if (!(flightSeconds > 0) || !inFlight || !(inFlight.seconds > 0)) {
    out.animation = MISSILE_ANIM_STAND;
    out.timeScale = 1;
    return out;
  }
  out.animation = MISSILE_ANIM_IN_FLIGHT;
  out.timeScale = ((inFlight.flags ?? 0) & MISSILE_SEQUENCE_STRETCH) !== 0 ? inFlight.seconds / flightSeconds : 1;
  return out;
}

/** The clip time `age` seconds into the flight: the sequence loops (`SetBoneSequence(…, 144, …)` repeats). */
export function missileSequenceTime(age: number, timeScale: number, clipSeconds: number): number {
  if (!(clipSeconds > 0)) return 0;
  const time = Math.max(0, age) * timeScale;
  return time % clipSeconds;
}
