/**
 * Which of the spells a character knows are older ranks of another one they also know.
 *
 * There is no rank column. `Spell.dbc` carries `NameSubtext_lang`, a *localised sentence* — of the
 * 7,369 spells that reach the book on this dataset 4,618 leave it empty, 2,521 read «Уровень N»,
 * 43 «Расовая, пассивная», 22 «Расовая», 15 «Ученик», 14 «Подмастерье», 14 «Умелец» and 13 «Ур. N»
 * — so parsing it is parsing the translator's prose. `SpellChain.dbc` does not exist in 3.3.5a, and
 * `SkillLineAbility.SupercededBySpell` is filled on 1,059 of 10,220 rows: all sixteen «Огненный
 * шар» rows have a zero there.
 *
 * What does identify a chain is the family. Two ranks of one spell share `SkillLine`,
 * `SpellClassSet`, all three words of `SpellClassMask` and `Name_lang`; measured over the book,
 * that key finds 488 groups holding 2,777 spells. The name has to be in the key — «Морозный
 * доспех» ranks 1-3 and «Ледяной доспех» ranks 1-6 are one skill line, one class set and one class
 * mask (34078720,0,0), and without the name they collapse into a single nine-link chain that would
 * hide the mage's first three armours behind the sixth of a different spell.
 *
 * **The rank string is in the key too, with its digits masked out.** Without that, the ten
 * «Превращение» rows — four ranks and six shapes (Черепаха, Свинья, Змей, Черный кот, Кролик,
 * Индейка) — form one group, the gates below open because all ten rank strings are non-empty and
 * distinct, and the sort keeps «Индейка» while hiding 12826, «Превращение (Уровень 4)», the real
 * top rank. Masking the digits splits the four numbered ranks from the six shapes: 12826 survives
 * and only 118, 12824 and 12825 go. It costs breadth — 469 groups and 2,674 members instead of 488
 * and 2,777 — and that breadth was buying wrong answers.
 *
 * DOM-free on purpose: the whole of it is testable against the real tables, and
 * `tests/spellbook.test.mjs` runs it over all 7,369 rows on every build.
 */

/** What the predicate needs of a spell. `SpellMetadata` plus the skill line from `/dbc/talents`. */
export interface RankedSpell {
  id: number;
  name: string;
  /** `NameSubtext_lang`, verbatim and localised. Never parsed — only compared and digit-masked. */
  rank: string;
  spellLevel: number;
  spellClassSet: number;
  spellClassMask: readonly number[];
  /** The `SkillLine` the book files the spell under, which is also its tab. */
  skillLine: number;
}

/**
 * The chain a spell belongs to.
 *
 * Exported so a test can show two spells share one and so the sort below has something to group
 * on; nothing outside reads the shape of the string.
 */
export function rankChainKey(spell: RankedSpell): string {
  return [
    spell.skillLine,
    spell.spellClassSet,
    spell.spellClassMask.join(","),
    spell.name,
    spell.rank.replace(/[0-9]+/g, "#"),
  ].join("|");
}

/**
 * Highest first: by `SpellLevel`, then by id.
 *
 * `SpellLevel` alone leaves ties — «Огненный шар» ranks 11 and 12 are both level 60 — and the id
 * settles them because a later rank was authored later. The oracle for the whole arrangement is
 * the number the translator wrote in the rank string: over the book it agrees with this order in
 * **372 of 375** comparable groups, and the three that disagree are «Стихийное опустошение» (line
 * 375), «Контроль популяции» (270) and «Крепость» (186), where the table's own levels contradict
 * the printed rank. The plan asked for `SkillLineAbility.ID` as the tie-break rather than the
 * spell id; measured over the same 469 groups the two orders pick the same spell every time — 0 of
 * 2,674 members differ — and the id is already on the wire, so `/dbc/talents` keeps its size.
 */
const highestFirst = (left: RankedSpell, right: RankedSpell): number =>
  right.spellLevel - left.spellLevel || right.id - left.id;

/**
 * Whether a group may be reduced at all: every member has to carry its own rank string.
 *
 * Two members with the *same* string mean the key has swept up something that is not a chain —
 * 60192 and 60202 are both «Замораживающая стрела (Уровень 1)», one written for level 80 and one
 * for 60 — and a group of rows that all carry *no* rank string is the same thing said another way:
 * the hunter's «Приручение зверя» 1515 and 13481, one skill line, one name, both at `SpellLevel`
 * 10 and neither with a word in the rank string; it is the only one of the 70 blank groups a
 * hunter owns. This one gate covers both, and covering both is not a choice — the key above holds
 * the digit-masked rank string, and masking digits turns "" into "" and nothing else into "", so a
 * group holding a blank rank holds only blank ranks. Measured over the book: 94 of the 469 groups
 * are rejected, 70 of them for a blank rank and 24 for a repeated one, **0** for a blank rank the
 * duplicate rule would have let through. The gate costs 301 of the 2,205 candidates; without it
 * the book would hide 2,205 spells, some of which the player would then have no way to cast.
 *
 * There used to be a separate `rank.trim() === ""` line above this one. It could not fire: it was
 * measured at 0 groups of its own, deleting it left `lowerRankSpells` hiding the same 1,904 of
 * 7,369, and no test could tell the two versions apart.
 */
function reducible(group: readonly RankedSpell[]): boolean {
  return new Set(group.map((spell) => spell.rank)).size === group.length;
}

/**
 * The ids to leave out of the book, given everything the character knows.
 *
 * Known spells, not the corpus: a chain the character owns one link of is a group of one and
 * nothing is hidden, which is what makes the answer change as they level. Measured over the whole
 * book — the widest this can ever get — it hides 1,904 of 7,369.
 */
export function lowerRankSpells(spells: readonly RankedSpell[]): Set<number> {
  const chains = new Map<string, RankedSpell[]>();
  for (const spell of spells) {
    const key = rankChainKey(spell);
    const chain = chains.get(key);
    if (chain) chain.push(spell);
    else chains.set(key, [spell]);
  }

  const lower = new Set<number>();
  for (const chain of chains.values()) {
    if (chain.length < 2 || !reducible(chain)) continue;
    const sorted = [...chain].sort(highestFirst);
    for (const spell of sorted.slice(1)) lower.add(spell.id);
  }
  return lower;
}
