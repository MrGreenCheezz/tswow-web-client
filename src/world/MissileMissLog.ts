// 13.10 (3.01): when SMSG_SPELL_GO's misses are told — the combat log entry (SPELL_MISSED / RANGE_MISSED),
// the word over the target and UNIT_COMBAT — as Wow.exe 3.3.5a 12340 does it (Ghidra read-only;
// .runtime/re-2026-10-02/a2-m8/d2.c 0x0080e1b0, .runtime/re-2026-10-11/glue-1110/1013-m1.txt, m2.txt).
//
// - The GO handler 0x0080e1b0 writes the miss list itself (0x00751b80 for the log, 0x0071f990 and 0x00513410
//   for the text and the event) only when the spell's Speed (record +0xbc) is 0 and AttributesEx2 has no 0x80
//   (record +0x18). A spell with 0x80 and no speed writes none at all.
// - A spell with a speed hands its misses to its missile: the Missile_C carries the GO's targets and their miss
//   reasons, and its impact (0x00700e20; 0x00702fc0 for a lost target) writes the same three calls for the first
//   missile of the volley (+0x110 = 0), once (+0x68 |= 0x100). The missile left the caster with the GO and flies
//   at Speed to the target, so it lands round(|caster − target| / Speed · 1000) ms later — the clock
//   0x0080e1b0 itself keeps for the cast (0x00804b20 with now − round(d / speed · −1000), 0x009ea15c = −1000).
//
// Kept from before (listed): a row not known yet, and a caster or target whose position is not known, tell the
// miss at once (Wow.exe would have no missile and tell nothing); the distance is between the two units' positions.

/** What of a spell row this reads (`/dbc/spells?v=20`: `speed`; `attributes[2]` is AttributesEx2). */
export interface MissileMissSpell {
  readonly speed?: number | undefined;
  readonly attributes?: readonly number[] | undefined;
}

export interface MissilePosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** AttributesEx2 0x80: with no speed, 0x0080e1b0 tells no miss. */
export const SPELL_ATTR2_NO_GO_MISSES = 0x80;

/** "now", "never", or the milliseconds until the missile lands. */
export type MissileMissTiming = "now" | "never" | number;

/** When a GO's miss on `target` is told. */
export function missileMissTiming(spell: MissileMissSpell | undefined, caster: MissilePosition | undefined,
  target: MissilePosition | undefined): MissileMissTiming {
  if (spell === undefined || spell.speed === undefined || !Number.isFinite(spell.speed)) return "now";
  if (!(spell.speed > 0)) return ((spell.attributes?.[2] ?? 0) & SPELL_ATTR2_NO_GO_MISSES) !== 0 ? "never" : "now";
  if (!caster || !target) return "now";
  const distance = Math.hypot(target.x - caster.x, target.y - caster.y, target.z - caster.z);
  const delay = Math.round((distance / spell.speed) * 1000);
  return delay > 0 ? delay : "now";
}

/** The misses waiting for their missiles; `clear` drops them all (a new world). */
export class MissileMissSchedule {
  readonly #pending = new Set<ReturnType<typeof setTimeout>>();
  readonly #setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer: ReturnType<typeof setTimeout>) => void = (timer) => clearTimeout(timer),
  ) {
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Runs `tell` now, later, or never, by `missileMissTiming`. */
  tell(timing: MissileMissTiming, tell: () => void): void {
    if (timing === "never") return;
    if (timing === "now") {
      tell();
      return;
    }
    const timer = this.#setTimer(() => {
      this.#pending.delete(timer);
      tell();
    }, timing);
    this.#pending.add(timer);
  }

  clear(): void {
    for (const timer of this.#pending) this.#clearTimer(timer);
    this.#pending.clear();
  }
}
