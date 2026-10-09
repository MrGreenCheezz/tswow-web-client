/**
 * 05.10-3.01: what a refusal hands the combat log beside its result — Wow.exe 0x00808200 writes the same words
 * to the error frame and to SPELL_CAST_FAILED (its `local_10`), and reads the tail for TOO_MANY_OF_ITEM's
 * limit category (case 0x81). Only the fields that exist are set, so an event without either keeps its shape.
 */
export interface CastFailureWords {
  text?: string;
  extra?: readonly number[];
}

export function castFailureWords(failure: { readonly extra?: readonly number[] }, words: () => string | undefined): CastFailureWords {
  const result: CastFailureWords = {};
  const text = words();
  if (text) result.text = text;
  if (failure.extra !== undefined && failure.extra.length > 0) result.extra = failure.extra;
  return result;
}
