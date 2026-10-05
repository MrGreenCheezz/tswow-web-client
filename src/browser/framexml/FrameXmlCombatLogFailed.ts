/**
 * Plan item 3.01 (05.10, slice 05.10-3.01): the words of a SPELL_CAST_FAILED entry where Wow.exe 3.3.5a (12340)
 * does not take the refusal's own SPELL_FAILED_* sentence. Read-only notes: .runtime/re-2026-10-02/a2-m8/d2.c
 * (0x00808200, 0x00807f10) and the byte probes in .runtime/re-2026-10-05/l301-tails/.
 *
 * - SPELL_FAILED_TOO_MANY_OF_ITEM (129, case 0x81 of 0x00808200). With a limit category in the tail
 *   (Spell.cpp:4243-4262) whose ItemLimitCategory row the client has (the DB at 0x00ad3e60, looked up at
 *   0x00808a90), 0x00808200 says game error 0x272 — ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS
 *   (0x00807f10 gives 0x272 for 0x81 with a category, the message table 0x00ac8af0 row 0x272) — filled with
 *   the row's quantity (record +8) and name (+4) by 0x005216f0 (0x00808aa5), and writes what 0x00513df0
 *   returns — `mov eax, 0x00bcfb90; ret`, the buffer 0x005216f0 has just filled — to the log through
 *   0x00751ad0 (0x00808ac3) and then jumps past the repeat test (`local_14`) to the end. Its repeat state
 *   (0x00d397c0/c4/c8/bc) was updated before, as for any refusal. No category, or no row: the plain path.
 * - Every other refusal writes its SPELL_FAILED_* sentence (0x00808200's `local_10`, the same words as the
 *   error frame's ERR_SPELL_FAILED_S «%s»). An empty sentence falls back to 0x00513df0 — the error buffer
 *   0x005216f0 just formatted from «%s» with nothing in it — and 0x00751ad0 writes nothing for empty words:
 *   no words, no entry.
 */

/** SpellCastResult 129 (SharedDefines.h). */
export const SPELL_FAILED_TOO_MANY_OF_ITEM = 129;

/** The two fields of an ItemLimitCategory row 0x00808200 reads. */
export interface CombatLogLimitCategory {
  readonly name: string;
  readonly quantity: number;
}

export type CombatLogGlobalFormat = (name: string, args: readonly (string | number)[], fallback: string) => string;

/**
 * 0x00808200 case 0x81: the limit-category sentence, or undefined when the plain SPELL_FAILED_* path speaks
 * (another result, no category in the tail, or no row for it yet).
 */
export function combatLogLimitCategoryText(result: number, extra: readonly number[] | undefined,
  category: (id: number) => CombatLogLimitCategory | undefined, format: CombatLogGlobalFormat): string | undefined {
  if (result !== SPELL_FAILED_TOO_MANY_OF_ITEM) return undefined;
  const id = extra?.[0] ?? 0;
  if (id <= 0) return undefined;
  const row = category(id);
  if (row === undefined) return undefined;
  return format("ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS", [row.quantity, row.name],
    "You can only have %d %s at a time");
}
