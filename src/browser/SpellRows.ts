import type { SpellMetadata } from "./SpellMetadata.js";

/**
 * 22.10 ARC-2 S2a: the page's spell rows (`game.spells`), with the attribute words of every row that carries them
 * kept beside it in step with each write — a plain map the renderer is handed as data (RenderInputs.ts) instead of
 * asking `world/PetCastSpell.ts` `spellAttributeWords`, which reads this same map through a registered callback.
 */
export class SpellRows extends Map<number, SpellMetadata> {
  /** Spell id → `attributes`, for the rows that have them; never replaced, only written. */
  readonly attributeWords = new Map<number, readonly number[]>();
  /** Bumped on every write. */
  revision = 0;

  override set(id: number, row: SpellMetadata): this {
    super.set(id, row);
    // `super()` runs before the field initialisers; Map's constructor writes nothing without an iterable.
    if (this.attributeWords !== undefined) {
      if (row.attributes !== undefined) this.attributeWords.set(id, row.attributes);
      else this.attributeWords.delete(id);
      this.revision++;
    }
    return this;
  }

  override delete(id: number): boolean {
    this.attributeWords.delete(id);
    this.revision++;
    return super.delete(id);
  }

  override clear(): void {
    this.attributeWords.clear();
    this.revision++;
    super.clear();
  }
}

/** The attribute words of `spells`: the kept map of a `SpellRows`, else collected now (a plain map, as tests set). */
export function spellAttributeWordsOf(spells: ReadonlyMap<number, SpellMetadata>): ReadonlyMap<number, readonly number[]> {
  if (spells instanceof SpellRows) return spells.attributeWords;
  const words = new Map<number, readonly number[]>();
  for (const [id, row] of spells) if (row.attributes !== undefined) words.set(id, row.attributes);
  return words;
}
