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
// 15.11, the +0x984 record (.runtime/re-2026-11-15/fx7/r2): a SpellVisualKit's CharProc 14 — 0x007265c0 removes the
// spell's earlier records (0x0071ab80), and for 0 < CharParamZero ≤ 1 links a new one at the list head with that alpha
// (+0xe8) and CharParamTwo × 1000 ms (+0xa0), then calls 0x0071abe0. The aura's removal (0x0071e930) and 0x0073eb50
// remove the spell's records and refade to the new head's alpha over its time (1000 without one). The records ride the
// plan's tints here (UnitTints.ts `alphaOf`); the caller passes their factor and time.
//
// The byte a unit starts with before its first model (0 in the constructor 0x00745e60) and its fade-in on creation
// (0x0073fcc0 → 0x00744a50) are UnitSpawnFade.ts: here the first look is taken at once and that factor multiplies it.

/**
 * 15.11 (6.11): the renderer's stealth/invisibility/ghost translucency (world/Fields.ts `unitAppearance`, a stand-in from
 * a reference client: "SpellVisual has no translucency column") yields to a live CharProc 14 record. Wow.exe's model
 * alpha is only the byte above (CreatureModelAlpha × the record) times the +0xcb byte (0x00743e10), and +0xcb is set by
 * 0x00737390 from callers that are not the stealth auras; Stealth's own look is its StateKit's record (spells 1784–1787,
 * visual 184, kit 312: 0.3 over 1 s), Fade/Vanish's kit 3450 (0.5). Without a record the stand-in stays.
 */
export function auraStandInOpacity(appearanceOpacity: number, recordHeld: boolean): number {
  return recordHeld ? 1 : appearanceOpacity;
}

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
 * `duration` ({@link DISPLAY_ALPHA_FADE_MS}, or a CharProc 14 record's time). `alpha` is CreatureModelAlpha times the
 * newest record's factor (0x0071abe0). Keyed by the renderer's own unit record, so it goes with it.
 */
export function unitDisplayAlpha(unit: object, alpha: number, now: number, duration = DISPLAY_ALPHA_FADE_MS): number {
  let fade = fades.get(unit);
  if (fade === undefined) {
    const byte = alphaByte(alpha);
    fade = { current: byte, from: byte, to: byte, startedAt: now, duration: 0 };
    fades.set(unit, fade);
  } else if (alphaByte(alpha) !== fade.to) {
    setDisplayAlpha(fade, alpha, now, duration);
  }
  return stepDisplayAlpha(fade, now) / 255;
}

/** 15.11 (6.11): whether `unit`'s display alpha is walking now (+0xc4 not 0). */
export function displayAlphaFading(unit: object): boolean {
  const fade = fades.get(unit);
  return fade !== undefined && fade.duration !== 0;
}

/** 15.11 (6.11): the byte `unit`'s display alpha walks to (+0xca), or undefined before its first look. */
export function displayAlphaTargetByte(unit: object): number | undefined {
  return fades.get(unit)?.to;
}
