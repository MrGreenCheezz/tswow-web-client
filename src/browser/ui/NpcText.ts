/**
 * What a quest giver actually says.
 *
 * A `npc_text` or `quest_template` row is written for whoever happens to be reading it: «Приветствую,
 * $N. Слышишь зов охоты, |3-6($c)?» is one sentence with four decisions in it. Until now two of
 * those decisions were made — the name and the line break — and the rest reached the screen as
 * their own markers.
 *
 * Measured on the base world dump this dataset is built from: `npc_text` carries 930 `$n`, 911
 * `$c`, 339 `$r`, 320 `$g` and 36 `$G`; `quest_template` carries 2,021 `$N`, 492 `$c`, 257 `$r`,
 * 145 `$g`. So the markers left unread were **1,646 in one table and 1,014 in the other**.
 *
 * DOM-free on purpose: `Npc.ts` cannot be imported in a test — it reaches `Dom.js`, which resolves
 * 166 element ids at module load and throws on the first one missing — and a grammar is exactly
 * the thing that has to be testable.
 */

/** Who the sentence is addressed to. Everything a marker can ask about the reader. */
export interface NpcTextSubject {
  name: string;
  /** From `ChrClasses`, already in the reader's language. */
  className: string;
  /** From `ChrRaces`, likewise. */
  raceName: string;
  /** `UNIT_FIELD_BYTES_0` byte 2: 0 male, 1 female. */
  gender: number;
  /**
   * The five declensions the name query carries, when the player filled them in.
   *
   * Indexed from case 1, so `declined[0]` is the genitive. `|3-6(…)` asks for a sixth case the
   * name query has no room for; that one falls through to the word it was given.
   */
  declined?: readonly string[] | undefined;
}

const FEMALE = 1;

/**
 * `$g<male>:<female>;` and the ruRU three-part form `$g<male>:<female>:<case>;`.
 *
 * The spellings in the dump are not tidy — `$ggood sir:my lady;`, `$g lad : lass;`,
 * `$gbrother:sister;` — so the segments are trimmed. The third segment names a grammatical case
 * and there is nothing here to decline with, so it is dropped rather than printed: the word before
 * it is already the right one for the gender, and the case only refines it.
 */
const GENDER = /\$g([^:;]*):([^:;]*)(?::([^;]*))?;/gi;

/** `|3-N(word)` — decline `word` into case N. The same marker `EmoteRules` reads. */
const DECLENSION = /\|3-(\d+)\(([^)]*)\)/g;

/** `|Hitem:…|hword|h` — a chat link. The brackets belong to it; the word is the visible part. */
const HYPERLINK = /\|H[^|]*\|h(.*?)\|h/g;

/** `|cAARRGGBB` … `|r` — a colour escape. Nothing here paints, so both ends come out. */
const COLOUR = /\|c[0-9a-f]{8}|\|r/gi;

/**
 * One line of NPC or quest text, written for one reader.
 *
 * Unknown markers are left standing rather than blanked, for the same reason a spell description
 * keeps the ones it cannot resolve: a sentence with a marker in it reads as unfinished, and a
 * sentence with a hole in it reads as finished and wrong.
 */
export function formatNpcText(text: string, subject: NpcTextSubject): string {
  if (!text) return "";
  const female = subject.gender === FEMALE;

  let result = text
    // Gender first: the segments it chooses between can contain any of the others.
    .replace(GENDER, (_whole, male: string, femaleForm: string) => (female ? femaleForm : male).trim())
    .replace(/\$n/gi, subject.name || "герой")
    .replace(/\$c/gi, subject.className)
    .replace(/\$r/gi, subject.raceName)
    // `$t` is the NPC's own name in the original client, which nothing here has: the packet names
    // a text id and never says who is speaking. Left standing rather than filled with a guess.
    .replace(/\$b/gi, "\n");

  result = result.replace(DECLENSION, (_whole, grammaticalCase: string, word: string) => {
    // The declensions the name query carries are the player's own name and nothing else, so a
    // `|3-6($c)` — a declined *class* name, which is what the ruRU rows actually use it for — has
    // nothing to look up and keeps the word it was handed. Case 6 is past the five the packet has
    // room for in any event.
    if (word !== subject.name) return word;
    const declined = subject.declined?.[Number(grammaticalCase) - 1];
    return declined && declined.length > 0 ? declined : word;
  });

  return result.replace(HYPERLINK, (_whole, label: string) => label).replace(COLOUR, "");
}
