/**
 * The character's spell rows: filling `game.spells` for what it knows, and which rank of a chain is
 * its best. No page: the book window (Spellbook.ts) follows it through HtmlWindowHosts.ts.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { syncMountSpellIds } from "../MountSpells.js";
import { spellBookHost } from "./HtmlWindowHosts.js";
import { spellAbilityMatchesActor, spellbookActor } from "./SpellbookTabs.js";
import { isCurrentSpellMetadataRequest, spellMetadataEpoch } from "./SpellNames.js";
import { lowerRankSpells, rankChainKey, type RankedSpell } from "./SpellRanks.js";
import { spellDescriptionRows } from "./SpellText.js";

/** The book window's status line, when there is a book window. */
export function spellBookStatus(message: string, tone: "muted" | "error"): void {
  spellBookHost()?.status(message, tone);
}

/** The last metadata request settled, even when the gateway omitted a requested custom row. */
let spellMetadataSettledWorld: WorldClient | undefined;

export function spellMetadataSettled(world: WorldClient | undefined): boolean {
  return world !== undefined && spellMetadataSettledWorld === world;
}

export function forgetSpellMetadataSettled(): void {
  spellMetadataSettledWorld = undefined;
}

/** Pick the skill line from the row the current character is actually allowed to use. */
function spellSkillLineForBook(id: number): number | undefined {
  const talents = game.talentData;
  const rows = typeof talents?.spellAbilitiesOf === "function"
    ? talents.spellAbilitiesOf(id)
    : undefined;
  if (rows !== undefined) {
    const actor = spellbookActor();
    return rows.find((row) => spellAbilityMatchesActor(row, actor))?.skillLine;
  }
  return talents?.skillOfSpell(id);
}

/**
 * Everything the rank predicate needs about a spell, or undefined while its row is in flight.
 *
 * A spell whose metadata has not landed is never a candidate for hiding: without a name, a family
 * and a level there is nothing to compare it to, and a book that hid rows while it loaded would be
 * the same defect `belongsInSpellbook` avoids at the other end.
 */
export function rankedSpell(id: number): RankedSpell | undefined {
  const metadata = game.spells.get(id);
  const skillLine = spellSkillLineForBook(id);
  if (!metadata || skillLine === undefined) return undefined;
  return {
    id, skillLine,
    name: metadata.name,
    rank: metadata.rank,
    spellLevel: metadata.spellLevel,
    spellClassSet: metadata.spellClassSet,
    spellClassMask: metadata.spellClassMask,
  };
}

/**
 * The highest known rank in this spell's chain, or the spell itself.
 *
 * Chains are the same `rankChainKey` groups the book hides lower ranks by: without the same
 * key the bar would "upgrade" a frost armour into an ice armour. Unknown rows (metadata or
 * skill line still in flight) answer the input unchanged, so a repaint can never demote a
 * slot while the tables load.
 */
export function highestKnownRank(id: number): number {
  const world = game.world;
  const self = rankedSpell(id);
  if (!world || !self) return id;
  const key = rankChainKey(self);
  const chain = world.knownSpells
    .map((spell) => rankedSpell(spell.id))
    .filter((spell): spell is RankedSpell => spell !== undefined && rankChainKey(spell) === key);
  if (chain.length < 2) return id;
  const lower = lowerRankSpells(chain);
  if (!lower.has(id)) return id;
  const top = chain.find((spell) => !lower.has(spell.id));
  return top?.id ?? id;
}

export async function loadSpellMetadata(world: WorldClient): Promise<void> {
  const client = game.spellMetadataClient;
  if (!client) return;
  const epoch = spellMetadataEpoch();
  if (!isCurrentSpellMetadataRequest(world, client, epoch)) return;
  spellMetadataSettledWorld = undefined;
  try {
    const known = await client.load(world.knownSpells.map((spell) => spell.id));
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    for (const [id, metadata] of known) game.spells.set(id, metadata);
    // Mount classification belongs to the world client: the book, action bar, tracking window and
    // module actions all eventually call the same `WorldClient.castSpell` entry point.
    syncMountSpellIds(world);
    // WotLK descriptions legitimately point at a base/rank row that is not in the character's
    // known-spell list (`$21084d` in Seal of Righteousness). Fetch those rows as well so the live
    // context can resolve the marker instead of leaving an otherwise answerable duration visible.
    const referenced = new Set<number>();
    for (const metadata of known.values()) {
      // 11.10: with the `$/10;29131o1` spelling too (SpellText.ts spellDescriptionReferences).
      // 12.10: and the rows its SpellDescriptionVariables formulas and its aura text read.
      for (const id of [...spellDescriptionRows(metadata), ...spellDescriptionRows(metadata, true)]) {
        if (!game.spells.has(id)) referenced.add(id);
      }
    }
    const loadedReferences = await client.load([...referenced]);
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    for (const [id, metadata] of loadedReferences) game.spells.set(id, metadata);
    syncMountSpellIds(world);
    spellMetadataSettledWorld = world;
    if (game.world === world) spellBookHost()?.redraw();
  } catch (error) {
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    // A failed known-spell batch must not discard a classification that another loader already
    // supplied (for example the action bar or aura strip landing first).
    syncMountSpellIds(world);
    spellMetadataSettledWorld = world;
    // Repaint before writing the error: the guard above no longer blanks the book for a missing
    // row, but a repaint suppressed before this call would otherwise leave the page stale until
    // some unrelated event. The message goes back on top afterwards.
    if (game.world === world) spellBookHost()?.redraw();
    spellBookStatus(error instanceof Error ? error.message : String(error), "error");
  }
}
