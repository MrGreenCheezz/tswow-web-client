// Which spell opens a lock.
//
// Kept away from the table that feeds it because both ends need this: the gateway reads Lock.dbc
// and Spell.dbc off disk, and the browser does the matching, since the matching needs the player's
// spellbook and that only exists in the browser. A module that reads files cannot be bundled into
// a page, so the rule lives here and the reading lives beside the other DBC loaders.

/** `LockKeyType`. An item key is a key in the bag; a skill is a profession; a spell is one spell. */
export const LOCK_KEY_ITEM = 1;
export const LOCK_KEY_SKILL = 2;
export const LOCK_KEY_SPELL = 3;

/** One of a lock's eight cases: a way it can be opened, and how good you have to be at it. */
export interface LockCase {
  type: number;
  /** For a skill, the lock type it needs; for a spell, the spell's own id. */
  index: number;
  skill: number;
}

/** A spell that opens locks: which kind, and to what value. */
export interface LockOpener {
  spell: number;
  lockType: number;
  /** What the effect is worth, which the server compares against the lock's required skill. */
  value: number;
}

export interface LockData {
  /** Lock id to its non-empty cases. A lock with no cases at all is left out. */
  locks: Record<number, LockCase[]>;
  openers: LockOpener[];
}

/**
 * Which spell to cast at this lock, for a player who knows these spells, or 0 for none.
 *
 * The server accepts a cast in two cases and no others: the player knows the spell, or the spell
 * is exactly the one the server itself computed for this lock. So this walks the lock the same
 * way the server does — empty cases skipped, an item key ending the search rather than being
 * skipped — and picks something one of those two will accept.
 *
 * A spell key names its spell outright, and that one is accepted whether or not the player has
 * ever learned it. A skill key is matched against what the player knows, by the kind of lock the
 * spell opens and nothing else.
 *
 * Deliberately not compared: the lock's required skill against the spell's own value. Those are
 * different numbers — the spell's is what its rank is worth, and the server checks the player's
 * actual profession skill instead. Comparing them here let a miner open nothing at all, because
 * every rank of Mining is worth 0 by that measure while a copper vein asks for 25. When the skill
 * really is too low the cast fails and the server says which profession and what rank it wanted,
 * which is the right thing for the player to be told.
 */
export function spellForLock(data: LockData, lockId: number, known: Iterable<number>): number {
  const cases = data.locks[lockId];
  if (!cases) return 0;
  const spells = new Set(known);
  for (const entry of cases) {
    if (entry.type === LOCK_KEY_SPELL) return entry.index;
    if (entry.type !== LOCK_KEY_SKILL) break;
    for (const opener of data.openers) {
      if (opener.lockType === entry.index && spells.has(opener.spell)) return opener.spell;
    }
  }
  return 0;
}
