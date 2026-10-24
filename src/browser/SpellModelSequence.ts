/**
 * 25.10 (6.27): which sequence a spell effect model plays, and where in it — as Wow.exe's effect callbacks chain them.
 *
 * Every effect starts on Stand (CEffect::CreateModelFromEffect 0x006f7680 sets sequence 0). When Stand ends:
 *   * a one-shot kit (cast, impact, …; CGObject_C::EffectOnceHandler 0x00744870) plays Decay (159) if the model has
 *     one and is gone when it ends, or is gone at once;
 *   * an aura's state kit (CGObject_C::AuraEffectHandler 0x007449c0, AuraEffectHoldHandler 0x00744920) loops Hold (158)
 *     if the model has one — the authored "while it lasts" loop — until the aura ends (Decay then, OnSpellEffectClear
 *     0x00743250). A kit with flag 0x20 loops Stand instead; one with neither, here, keeps looping Stand as before.
 * Census 25.10: 297 of the 1,554 spell effect models carry Hold and 191 Decay. Power Word: Shield's
 * `HolyDivineShield_State_Base.m2` is the plain case: a 0.7 s Stand whose ring flashes at full weight at 300 ms, then a
 * 0.633 s Hold that only shimmers (weights 0…0.2) — looping Stand flashed the ring every 0.7 s for the whole aura.
 */

export const SPELL_ANIM_STAND = 0;
export const SPELL_ANIM_HOLD = 158;
export const SPELL_ANIM_DECAY = 159;

/** Clip lengths in seconds; a missing one is a sequence the model lacks (or whose clip has not arrived yet). */
export interface SpellSequenceDurations {
  stand: number;
  hold?: number | undefined;
  decay?: number | undefined;
}

export interface SpellSequencePick {
  animation: number;
  /** Seconds into that sequence. */
  time: number;
  loop: boolean;
}

/** The sequence and its time `age` seconds after the effect started (`hold`: a state kit's held aura model). */
export function spellModelSequence(
  age: number, hold: boolean, durations: SpellSequenceDurations, out: SpellSequencePick,
): SpellSequencePick {
  const stand = durations.stand > 0 ? durations.stand : 0;
  const t = age > 0 ? age : 0;
  if (t < stand || stand === 0) {
    out.animation = SPELL_ANIM_STAND;
    out.time = hold && stand > 0 ? t % stand : Math.min(t, stand);
    out.loop = hold;
    return out;
  }
  if (hold) {
    const loop = durations.hold;
    if (loop !== undefined && loop > 0) {
      out.animation = SPELL_ANIM_HOLD;
      out.time = (t - stand) % loop;
    } else {
      out.animation = SPELL_ANIM_STAND;
      out.time = t % stand;
    }
    out.loop = true;
    return out;
  }
  const decay = durations.decay;
  if (decay !== undefined && decay > 0) {
    out.animation = SPELL_ANIM_DECAY;
    out.time = Math.min(t - stand, decay);
  } else {
    out.animation = SPELL_ANIM_STAND;
    out.time = stand;
  }
  out.loop = false;
  return out;
}

/** How long a one-shot effect plays in all: Stand, then Decay if it has one (0x00744870), in milliseconds. */
export function spellOneShotModelMs(durations: SpellSequenceDurations): number {
  return Math.max(0, durations.stand) * 1000 + Math.max(0, durations.decay ?? 0) * 1000;
}
