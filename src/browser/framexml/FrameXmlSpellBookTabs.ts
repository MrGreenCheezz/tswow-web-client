import type { SpellMetadata } from "../SpellMetadata.js";
import type { TalentClient } from "../TalentClient.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { FrameXmlSpellTabInfo } from "./FrameXmlWorldSeam.js";

/** The small live-data surface needed to answer the stock spellbook's skill-line tabs. */
export interface FrameXmlSpellBookTabSource {
  readonly world: WorldClient | undefined;
  readonly talent: TalentClient | undefined;
  readonly spells: ReadonlyMap<number, SpellMetadata>;
}

export interface FrameXmlSpellBookTabResolvers {
  readonly spellTabs: () => readonly FrameXmlSpellTabInfo[];
  readonly spellTabFor: (spellId: number) => number | undefined;
}

/**
 * Cache truthful skill-line tabs until one of the world, talent, readiness, or metadata snapshots
 * changes.  The spell-map size matters: metadata arrives after the known-spell packet, and a first
 * empty result must not permanently hide those rows.
 */
export function createFrameXmlSpellBookTabResolvers(
  read: () => FrameXmlSpellBookTabSource,
): FrameXmlSpellBookTabResolvers {
  let cachedWorld: WorldClient | undefined;
  let cachedKnown: unknown;
  let cachedTalent: TalentClient | undefined;
  let cachedReady = false;
  let cachedSpellCount = -1;
  let tabs: readonly FrameXmlSpellTabInfo[] = Object.freeze([]);
  let tabBySpell = new Map<number, number>();

  const refresh = (): void => {
    const { world, talent, spells } = read();
    const known = world?.knownSpells;
    const ready = talent?.ready === true;
    const spellCount = spells.size;
    if (world === cachedWorld && known === cachedKnown && talent === cachedTalent
      && ready === cachedReady && spellCount === cachedSpellCount) return;
    cachedWorld = world;
    cachedKnown = known;
    cachedTalent = talent;
    cachedReady = ready;
    cachedSpellCount = spellCount;
    tabBySpell = new Map();
    if (!world || !talent || !ready) {
      tabs = Object.freeze([]);
      return;
    }
    const groups = new Map<number, Array<{ id: number; slot: number; icon: string }>>();
    for (const [order, knownSpell] of world.knownSpells.entries()) {
      const metadata = spells.get(knownSpell.id);
      const line = talent.skillOfSpell(knownSpell.id);
      if (!metadata || metadata.hidden === true || line === undefined || line <= 0) continue;
      const list = groups.get(line) ?? [];
      list.push({
        id: knownSpell.id,
        slot: Number.isFinite(knownSpell.slot) ? knownSpell.slot : order,
        icon: metadata.iconPath,
      });
      groups.set(line, list);
    }
    const ordered = [...groups.entries()].map(([line, entries]) => {
      entries.sort((left, right) => left.slot - right.slot || left.id - right.id);
      const info = talent.skillLine(line);
      return {
        line,
        entries,
        name: line === 183 ? "Общий" : info?.name ?? `Навык ${line}`,
      };
    }).sort((left, right) => right.entries.length - left.entries.length
      || left.name.localeCompare(right.name) || left.line - right.line);
    let offset = 0;
    tabs = Object.freeze(ordered.map((group, index) => {
      for (const entry of group.entries) tabBySpell.set(entry.id, index + 1);
      const texture = group.entries.find((entry) => entry.icon)?.icon ?? "";
      const result: FrameXmlSpellTabInfo = [
        group.name, texture, offset, group.entries.length, offset, group.entries.length,
      ];
      offset += group.entries.length;
      return result;
    }));
  };

  return {
    spellTabs: () => {
      refresh();
      return tabs;
    },
    spellTabFor: (spellId) => {
      refresh();
      return tabBySpell.get(spellId);
    },
  };
}
