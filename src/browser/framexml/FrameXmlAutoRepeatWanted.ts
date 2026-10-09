/**
 * L18 5.05: the shot the autoRangedCombat controller wants (world/AutoRangedCombat.ts `wantedSpellId`)
 * as the stock action buttons see it.
 *
 * Wow.exe 3.3.5a 12340 (Ghidra read-only; .runtime/re-2026-10-04/l15-combat/g1.c, .runtime/re-2026-10-01/
 * a9-combat/e2.c) keeps two spell slots: the repeating spell (0x00d397d0, read by 0x007fe130) and the
 * spell the controller wants repeated (0x00d397cc, 0x007fe180). IsAutoRepeatAction 0x005a9470 (and
 * IsAutoRepeatSpell 0x005415d0) answer 1 when the action's spell is either — so the Auto Shot button is
 * checked from the moment the controller wants the shot, before the first one goes out (while the player
 * runs, faces away or is out of range).
 *
 * START/STOP_AUTOREPEAT_SPELL: the wanted slot's setter 0x007fe140 fires them only while nothing repeats,
 * the repeat's setter 0x00800a00 and its cancel 0x00807560 only while nothing is wanted. The controller
 * sets the wanted slot before it shoots and clears it before it cancels (0x006e2be0, 0x006e1660), so the
 * edges are those of "the repeating spell, else the wanted one" ({@link frameXmlAutoRepeatShown}); the
 * two slots differ only when a second repeating spell is hand-cast while Auto Shot is wanted, which a
 * hunter's book does not offer.
 */

/** What this reads of the world client; a stand-in without the controller reads as no wanted spell. */
export interface FrameXmlAutoRepeatSlots {
  readonly autoRepeatSpellId: number | undefined;
  readonly autoRanged?: { readonly wantedSpellId: number | undefined } | undefined;
}

/** 0x005a9470: the spell is the repeating one or the wanted one. */
export function frameXmlIsAutoRepeatSpell(spellId: number, repeating: number | undefined, wanted: number | undefined): boolean {
  return (repeating !== undefined && spellId === repeating) || (wanted !== undefined && spellId === wanted);
}

/** The spell START/STOP_AUTOREPEAT_SPELL follow: the repeating one, else the wanted one. */
export function frameXmlAutoRepeatShown(world: FrameXmlAutoRepeatSlots | undefined): number | undefined {
  if (world === undefined) return undefined;
  return world.autoRepeatSpellId ?? world.autoRanged?.wantedSpellId;
}
