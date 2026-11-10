// What it takes to open a locked thing, and which spell does it.
//
// A chest, an ore vein and a herb are not in the server's `GameObject::Use` switch — the only way
// to open one is to cast a lock-opening spell at it. The server works out which spell that should
// be and will accept it even from a player who has never learned it, but only if the client sends
// exactly that spell, so the client has to reach the same answer independently.
//
// Both halves of that answer are small enough to send whole and decide in the browser, where the
// spellbook is: 388 locks and 222 spells that open them, against 57,988 item displays. Asking per
// object would be a round trip for every rock in Elwynn.

import { stat } from "node:fs/promises"; // 5.17 (11.11)
import { join } from "node:path"; // 5.17 (11.11)
import { openDbcFile, type Dbc } from "./Dbc.js";
import type { LockCase, LockData, LockOpener } from "../world/LockRules.js";

/** `SPELL_EFFECT_OPEN_LOCK`. Not 3 — that is the dummy effect, and 3,958 spells carry it. */
const SPELL_EFFECT_OPEN_LOCK = 33;
const LOCK_CASES = 8;
const SPELL_EFFECTS = 3;

/**
 * 5.17 (11.11): LockType.dbc when the dataset has it, else undefined — only the cursor column comes from it, and
 * without the column the browser shows the stock names (LockClient, Cursors.ts), so the locks are still served.
 * A file that is there but unreadable or malformed still fails the route.
 */
async function openLockTypes(dbcDirectory: string): Promise<Dbc<"LockType"> | undefined> {
  try {
    await stat(join(dbcDirectory, "LockType.dbc"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return openDbcFile(dbcDirectory, "LockType");
}

export async function loadLockData(dbcDirectory: string): Promise<LockData> {
  const [lock, spell, lockType] = await Promise.all([
    openDbcFile(dbcDirectory, "Lock"),
    openDbcFile(dbcDirectory, "Spell"),
    openLockTypes(dbcDirectory), // 05.10-5.17; 5.17 (11.11): optional
  ]);

  const locks: Record<number, LockCase[]> = {};
  for (const row of lock.rows()) {
    const id = lock.id(row);
    if (id <= 0) continue;
    const cases: LockCase[] = [];
    for (let index = 0; index < LOCK_CASES; index++) {
      const type = lock.int(row, "Type", index);
      if (type === 0) continue;
      cases.push({ type, index: lock.int(row, "Index", index), skill: lock.int(row, "Skill", index) });
    }
    if (cases.length > 0) locks[id] = cases;
  }

  const openers: LockOpener[] = [];
  for (const row of spell.rows()) {
    for (let effect = 0; effect < SPELL_EFFECTS; effect++) {
      if (spell.int(row, "Effect", effect) !== SPELL_EFFECT_OPEN_LOCK) continue;
      openers.push({
        spell: spell.id(row),
        lockType: spell.int(row, "EffectMiscValue", effect),
        // The server compares the effect's computed value against the lock's skill, and a spell's
        // stored base points are one short of what it is worth.
        value: spell.int(row, "EffectBasePoints", effect) + 1,
      });
    }
  }
  // 05.10-5.17: the cursor a lock type shows (Wow.exe 0x0070F9B0 reads the lock's first type's
  // CursorName): four stock types and whatever a dataset adds, such as 1000 → Mine.
  if (lockType === undefined) return { locks, openers }; // 5.17 (11.11): no LockType.dbc — the stock names
  const lockTypeCursors: Record<number, string> = {};
  for (const row of lockType.rows()) {
    const cursor = lockType.string(row, "CursorName");
    if (cursor) lockTypeCursors[lockType.id(row)] = cursor;
  }
  return { locks, openers, lockTypeCursors };
}
