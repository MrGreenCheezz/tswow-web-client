/**
 * Plan item 5.05 (15.11): the active player's cast mark between its own request and the answer — Wow.exe 3.3.5a 12340
 * unit +0xa5c (the cast count) and +0xa60 (the spell), which the animation sheath rule 0x00738180 reads as "a cast in
 * progress" (world/AnimationSheathRule.ts, branch 3). Read-only Ghidra: .runtime/re-2026-11-11/combat/d3.c (0x00805330),
 * re-2026-11-11/vehicle2/v1.c (0x00715a80), re-2026-11-11/sheathvis/d1.c, d2.c (0x007fec00, 0x007fecc0),
 * re-2026-10-02/a2-m8/d2.c (0x00805610, 0x00806200, 0x00806ad0).
 *
 * Set: the request builder 0x0080ac90 (a cast and an item use alike) calls 0x00805330 after its packet, and that stores
 * the request's count and spell through 0x00715a80 when no cast holds the mark yet — for an instant spell too (cast time
 * 0). Cleared: 0x007fecc0, the end of a cast — SMSG_SPELL_GO (0x0080e1b0), the realm's refusal (0x00808200), a spell
 * failure (0x00809c70, 0x00806ad0), the own cancel (0x00806200) — clears it through 0x007fec00 only when the ending cast's
 * count and spell are the ones held.
 *
 * Measured on the stand's Wow.exe (15.11, F:/WowOracle/runs/sheath6-*.json, *.bones): with the answer held back 150,
 * 600 and 2000 ms, an animation start of the character inside that window — stopping from a run, the Run clip coming
 * round, the Stand clip coming round — put the two-handed sword on the back that very frame and sent CMSG_SET_SHEATHED 0
 * for Commanding Shout (469, attributes 0x10), and nothing for Battle Shout (6673, 0x50010: SPELL_ATTR0
 * DONT_AFFECT_SHEATH_STATE); after the GO nothing drew it again. WebClient's cast bar (`casts`) holds no instant spell,
 * so this mark stands in for +0xa60 between the request and its answer.
 */
/**
 * The cast in progress 0x00738180 judges for the active player: its cast bar when that is a cast (SMSG_SPELL_START also
 * goes through 0x00805330), else the mark of a request still unanswered. A channel is never +0xa60 (its GO cleared it).
 * `attributes0` is undefined for a spell row not known, which leaves the sheath alone as 0x004cfd20 finding no row does.
 */
export function ownSheathCasting(
  cast: { readonly spellId: number; readonly channel: boolean } | undefined,
  markSpellId: number | undefined,
  attributes0Of: (spellId: number) => number | undefined,
): { readonly attributes0: number | undefined } | undefined {
  const spellId = cast !== undefined && !cast.channel ? cast.spellId : markSpellId;
  return spellId === undefined ? undefined : { attributes0: attributes0Of(spellId) };
}

export class OwnCastMark {
  #spellId: number | undefined;
  #castCount = 0;

  /**
   * 0x00805330 after the request goes out: the mark is taken only when it is free and no cast bar of the player's holds
   * +0xa60 (`busy`); a second request inside the window leaves the first one's mark.
   */
  send(spellId: number, castCount: number, busy = false): void {
    if (this.#spellId !== undefined || busy) return;
    this.#spellId = spellId;
    this.#castCount = castCount & 0xff;
  }

  /** 0x007fecc0 → 0x007fec00: the end of the cast with this count and spell; any other leaves the mark. */
  end(spellId: number, castCount: number): void {
    if (this.#spellId === spellId && this.#castCount === (castCount & 0xff)) this.#spellId = undefined;
  }

  /** A new session or a new spell book: nothing is in flight any more. */
  clear(): void {
    this.#spellId = undefined;
  }

  /** The spell the mark holds (+0xa60), or undefined when none does. */
  get spellId(): number | undefined {
    return this.#spellId;
  }
}
