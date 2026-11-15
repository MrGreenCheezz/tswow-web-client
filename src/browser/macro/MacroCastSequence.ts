/**
 * 1.14 (15.11): a `/castsequence` entry's current step, as Wow.exe asks for it (0x00564900, called by 0x005650c0 for a
 * command of kind 4; Ghidra .runtime/re-2026-11-11/fxapi/d4.c, .runtime/re-2026-11-15/spell7/s1-refs.txt): the client
 * calls the stock Lua global `QueryCastSequence(sequence)` with the entry's text (after its options, `reset=` included)
 * and takes three results — the item when it is not nil, else the spell — as the text it resolves further. A Lua error,
 * or neither, leaves the text as it was. The step itself lives where the sequence runs: ChatFrame.lua's
 * CastSequenceTable, which `/castsequence` advances on UNIT_SPELLCAST_SUCCEEDED and resets on `reset=` (target,
 * combat, seconds, modifier keys) and on death — so the button follows those rules by asking the same table.
 *
 * The stock interface installs the query while its chat API is up (FrameXmlChatApi.ts); without one, the first entry
 * stands for the sequence, as before.
 */

/** The answer: the step's item or spell text; null when the Lua answered neither (or raised). */
export type MacroCastSequenceQuery = (sequence: string) => string | null;

const queries: MacroCastSequenceQuery[] = [];

/** Put a query over the current one until the returned function takes it off. */
export function installMacroCastSequence(query: MacroCastSequenceQuery): () => void {
  queries.push(query);
  return () => {
    const index = queries.lastIndexOf(query);
    if (index >= 0) queries.splice(index, 1);
  };
}

/** The installed query's answer; undefined when none is installed. */
export function queryMacroCastSequence(sequence: string): string | null | undefined {
  const query = queries[queries.length - 1];
  return query ? query(sequence) : undefined;
}

/** One `QueryCastSequence` result list read as 0x00564900 reads it: the item (−2) first, then the spell (−1). */
export function macroCastSequenceAnswer(results: readonly unknown[]): string | null {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
  return text(results[1]) ?? text(results[2]) ?? null;
}

/** The part of a Lua VM (glue/GlueLua.ts GlueLuaVm) the query calls through. */
export interface MacroCastSequenceVm<Ref> {
  globalFunction(name: string): Ref | undefined;
  call(ref: Ref, args: readonly unknown[], results: number): readonly unknown[];
  release(ref: Ref): void;
}

/** The query over a VM's global `QueryCastSequence` (3 results, as 0x00564900 asks); null while it has none. */
export function luaMacroCastSequenceQuery<Ref>(vm: MacroCastSequenceVm<Ref>): MacroCastSequenceQuery {
  return (sequence) => {
    const ref = vm.globalFunction("QueryCastSequence");
    if (!ref) return null;
    try {
      return macroCastSequenceAnswer(vm.call(ref, [sequence], 3));
    } finally {
      vm.release(ref);
    }
  };
}
