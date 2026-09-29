/**
 * Diminishing returns (DR) categories for 3.3.5 PvP control.
 *
 * The server applies DR and only tells the client the aura; the client must track recency
 * itself to show why a second sheep lasts less. Categories follow the core's
 * `DiminishingGroup`/`GetDiminishingReturnsGroupForSpell` groupings, narrowed to what the
 * spellbook metadata can resolve without inventing data: roots, stuns, fears, silences,
 * disorients/incapacitates, sleeps, charms/possess, horrify, cyclone/banish-style immunity.
 * Unknown spells return undefined and never block.
 */

export type DrCategory =
  | "root" | "stun" | "fear" | "silence" | "disorient" | "sleep" | "charm" | "horror" | "cyclone";

const DR_WINDOW_MS = 18_000;
const DR_LEVELS = [1, 0.5, 0.25, 0];

export interface DrState {
  category: DrCategory;
  count: number;
  lastAppliedAt: number;
}

const states = new Map<string, DrState>();

function key(guid: bigint, category: DrCategory): string {
  return `${guid.toString(16)}:${category}`;
}

/**
 * Very small spell-family heuristic keyed off aura interrupt flags + mechanic, resolved by the
 * caller from DBC metadata. Keep it explicit: a wrong guess shortens a control that should be
 * full, which is worse than showing none.
 */
export function drCategoryForSpell(metadata: {
  mechanic?: number; auraInterruptFlags?: number; dispel?: number;
} | undefined): DrCategory | undefined {
  if (!metadata) return undefined;
  // Mechanics in `SpellMechanics.dbc`: 1 charm, 5 disorient, 7 fear, 9 root, 10 sleep,
  // 11 stun, 12 silence, 13 disarm (no DR), 16 horrify, 17 incapacitate->disorient.
  switch (metadata.mechanic) {
    case 9: return "root";
    case 11: return "stun";
    case 7: return "fear";
    case 12: return "silence";
    case 5:
    case 17: return "disorient";
    case 10: return "sleep";
    case 1: return "charm";
    case 16: return "horror";
    default: return undefined;
  }
}

export function noteDrApplication(guid: bigint, category: DrCategory, now = Date.now()): number {
  const id = key(guid, category);
  const previous = states.get(id);
  const count = previous && now - previous.lastAppliedAt < DR_WINDOW_MS ? Math.min(3, previous.count + 1) : 0;
  states.set(id, { category, count, lastAppliedAt: now });
  return DR_LEVELS[count] ?? 0;
}

export function drFactor(guid: bigint, category: DrCategory, now = Date.now()): number {
  const state = states.get(key(guid, category));
  if (!state || now - state.lastAppliedAt >= DR_WINDOW_MS) return 1;
  return DR_LEVELS[Math.min(3, state.count + 1)] ?? 0;
}

export function resetDr(guid?: bigint): void {
  if (guid === undefined) states.clear();
  else for (const id of [...states.keys()]) if (id.startsWith(`${guid.toString(16)}:`)) states.delete(id);
}
