// 15.11 (6.11): a unit's CreatureModelAlpha changes over a second, as Wow.exe 3.3.5a 12340 fades it (Ghidra read-only,
// .runtime/re-2026-11-11/spellvis4/d1.c 0x00744030, 0x0071abe0; .runtime/re-2026-11-15/fx5/r2/d.c 0x0071ac30, 0x0073e410;
// constants read from the PE: 0x009e30c0 = 255, 0x00a34c10 = 1/65025):
//
// - A new model for the unit (0x0073e410, its display changed) calls 0x0071abe0: the target is CreatureModelAlpha
//   (vfunc +0xe8), times the alpha of the record at +0x984 when there is one, over that record's time or 1000 ms.
// - 0x00744030 keeps it as a byte, round(alpha · 255): a target equal to the current byte is taken at once; any other
//   fades from the current byte (+0xc8) to it, starting now (+0xc0), over the time (+0xc4).
// - Each frame 0x0071ac30 moves the byte linearly — from + trunc((to − from) · elapsed / time), integer arithmetic —
//   and once the time is up it is the target; the model's alpha is that byte × the unit's other fade byte (+0xcb) / 65025.
//
// Not taken: the +0x984 record (its alpha and time; read by 0x0071abe0, set elsewhere) and the byte a unit starts with
// before its first model — here the first look a unit is seen with is taken at once, and only a later change fades.

/** 0x0071abe0's time without a record. */
export const DISPLAY_ALPHA_FADE_MS = 1000;

/** One unit's fade byte (+0xc0…+0xca). */
export interface DisplayAlphaFade {
  current: number;
  from: number;
  to: number;
  startedAt: number;
  duration: number;
}

/** round(alpha · 255) as 0x00744030 stores it (round to nearest, ties to even as the FPU's default). */
export function alphaByte(alpha: number): number {
  const scaled = Math.min(1, Math.max(0, alpha)) * 255;
  const floor = Math.floor(scaled);
  const rest = scaled - floor;
  return rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
}

/** 0x00744030: a new target for the fade. */
export function setDisplayAlpha(fade: DisplayAlphaFade, alpha: number, now: number, duration = DISPLAY_ALPHA_FADE_MS): void {
  const target = alphaByte(alpha);
  if (target === fade.current) {
    fade.to = target;
    fade.duration = 0;
    return;
  }
  fade.startedAt = now;
  fade.duration = duration;
  fade.from = fade.current;
  fade.to = target;
  if (duration === 0) fade.current = target;
}

/** 0x0071ac30: the byte now. */
export function stepDisplayAlpha(fade: DisplayAlphaFade, now: number): number {
  if (fade.duration !== 0) {
    const elapsed = Math.floor(now - fade.startedAt);
    if (elapsed - fade.duration < 0) {
      fade.current = (fade.from + Math.trunc(((fade.to - fade.from) * elapsed) / fade.duration)) & 0xff;
    } else {
      fade.duration = 0;
      fade.current = fade.to;
    }
  }
  return fade.current;
}

const fades = new WeakMap<object, DisplayAlphaFade>();

/**
 * The CreatureModelAlpha share of `unit`'s opacity now (0…1): the first look's at once, a change of it over
 * {@link DISPLAY_ALPHA_FADE_MS}. Keyed by the renderer's own unit record, so it goes with it.
 */
export function unitDisplayAlpha(unit: object, alpha: number, now: number): number {
  let fade = fades.get(unit);
  if (fade === undefined) {
    const byte = alphaByte(alpha);
    fade = { current: byte, from: byte, to: byte, startedAt: now, duration: 0 };
    fades.set(unit, fade);
  } else if (alphaByte(alpha) !== fade.to) {
    setDisplayAlpha(fade, alpha, now);
  }
  return stepDisplayAlpha(fade, now) / 255;
}
