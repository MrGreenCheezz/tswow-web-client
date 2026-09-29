/**
 * The word that floats over a head for one `SpellMissInfo`, in the core's own numbering
 * (`SharedDefines.h:1543-1556`): 1 MISS, 2 RESIST, 3 DODGE, 4 PARRY, 5 BLOCK, 6 EVADE, 7 IMMUNE,
 * 8 IMMUNE2 (the core's comment: one of the two is MISS_TEMPIMMUNE), 9 DEFLECT, 10 ABSORB,
 * 11 REFLECT. There is no 12.
 *
 * The table this replaces ran one step behind from 8 on — an immunity floated as «отражено», an
 * absorb as «отражено», a reflect as «не в цель» — and named a twelfth reason nothing sends. The
 * stock combat feedback (`FrameXmlCombatFeedback.ts`, `MISS_ACTIONS`) keys the same values and was
 * never wrong; this is the native floating text's copy.
 */
const MISS_REASON_TEXT: Readonly<Record<number, string>> = {
  1: "промах",
  2: "сопротивление",
  3: "уклонение",
  4: "парирование",
  5: "блок",
  // An evading creature is running home; «уклонение» is this client's word for it, the stock
  // client's «Мимо» is the owner's call.
  6: "уклонение",
  7: "иммунитет",
  8: "иммунитет",
  9: "отклонено",
  10: "поглощено",
  11: "отражено",
};

/** The floating word for a miss; anything the core does not define is a plain miss. */
export function missReasonText(missInfo: number): string {
  return MISS_REASON_TEXT[missInfo] ?? "промах";
}
