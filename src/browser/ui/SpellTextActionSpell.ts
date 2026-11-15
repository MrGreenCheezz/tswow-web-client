/**
 * 3.43 (15.11): what an action button that is not a plain spell stands for, as 0x005a8c30 reads it for the cost
 * function's multi-cast step (0x008012f0 step 7, SpellTextCost.ts; Ghidra 2026-11-15, .runtime/re-2026-11-15/spell7/s1.c,
 * s2.c): a macro button its macro's spell — the item's on-use spell when the macro stands for an item (0x005a89f0 →
 * 0x005a89b0), else the macro's own (+0x564) — and an item button its item's spell (0x005a89b0). The stock interface
 * resolves macros (LiveWorldSeam, macro/MacroShownAction.ts) and installs the answer here while it is attached; without
 * one installed such a button is unknown and the cost with it.
 *
 * The resolver takes the 0-based slot and answers the spell id, 0 for none, undefined while it cannot tell.
 */
export type SpellTextActionSpellResolver = (slot: number) => number | undefined;

const resolvers: SpellTextActionSpellResolver[] = [];

/** Put a resolver over the current one until the returned function takes it off. */
export function installSpellTextActionSpell(resolver: SpellTextActionSpellResolver): () => void {
  resolvers.push(resolver);
  return () => {
    const index = resolvers.lastIndexOf(resolver);
    if (index >= 0) resolvers.splice(index, 1);
  };
}

/** The installed answer for a 0-based slot that holds a macro or an item; undefined without a resolver. */
export function spellTextActionSpell(slot: number): number | undefined {
  return resolvers[resolvers.length - 1]?.(slot);
}
