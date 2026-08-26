/**
 * The name of a spell somebody else is casting.
 *
 * The spellbook and the aura strip both ask the gateway for the rows they need, and both ask for
 * rows the *character* owns: what it knows, and what is on it. A cast bar over an enemy is the
 * first thing in the client that needs a row for a spell the character has never seen, so
 * `SMSG_SPELL_START` from a mob used to draw «Заклинание 11831» over its head — the bar was right
 * and the only unreadable thing on it was the one word it existed to show.
 *
 * Asking is fire-and-forget and deduplicated for the session: a row never changes, a miss is
 * remembered so a spell the gateway has no row for is not asked for again every frame, and the
 * caller gets a placeholder until the answer lands.
 */

import { game } from "../game/Context.js";

/** Ids already asked for, whether or not the answer arrived. */
const asked = new Set<number>();
/** Ids waiting for the next batch, so a wave of casts is one request rather than twenty. */
const pending = new Set<number>();
let scheduled = false;

export function spellName(spellId: number): string {
  const metadata = game.spells.get(spellId);
  return metadata ? [metadata.name, metadata.rank].filter(Boolean).join(" ") : `Заклинание ${spellId}`;
}

/** Whoever wants to be told when the batch lands, because they draw an icon rather than a word. */
const listeners = new Set<() => void>();

/**
 * Asks for whatever rows are missing. Never throws and never awaits the caller.
 *
 * `onLoaded` is for a caller that drew something out of the row rather than reading it when asked:
 * a cast bar can look the name up at the moment it paints, but a talent square has already put an
 * icon on the page and has to be told to put a different one there.
 */
export function ensureSpellNames(ids: Iterable<number>, onLoaded?: () => void): void {
  for (const id of ids) {
    if (id <= 0 || asked.has(id) || game.spells.has(id)) continue;
    asked.add(id);
    pending.add(id);
  }
  if (onLoaded && pending.size > 0) listeners.add(onLoaded);
  if (pending.size === 0 || scheduled) return;
  scheduled = true;
  // A microtask rather than the next frame: the batch closes as soon as this frame's callers have
  // all had their say, and the request is in flight before the browser draws anything.
  void Promise.resolve().then(async () => {
    scheduled = false;
    const client = game.spellMetadataClient;
    if (!client) {
      // Between leaving one world and entering the next there is no client, and the frame loop is
      // still running behind the loading screen. Emptying the batch here would have retired those
      // ids into `asked` forever, and every one of them would have shown its number for the rest
      // of the session; forgetting them instead lets the next frame ask again.
      for (const id of pending) asked.delete(id);
      pending.clear();
      return;
    }
    const batch = [...pending];
    pending.clear();
    const told = [...listeners];
    listeners.clear();
    try {
      for (const [id, metadata] of await client.load(batch)) game.spells.set(id, metadata);
      for (const listener of told) listener();
    } catch (error) {
      // A failed batch is retried by nothing: the ids stay in `asked`, and the placeholder stands.
      console.warn("Spell metadata unavailable", error);
    }
  });
}

/** Forgets the session's asking, for a character that is no longer the one being played. */
export function clearSpellNames(): void {
  asked.clear();
  pending.clear();
  listeners.clear();
}
