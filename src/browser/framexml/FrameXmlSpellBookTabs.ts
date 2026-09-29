import type { SpellMetadata } from "../SpellMetadata.js";
import type { TalentClient } from "../TalentClient.js";
import type { WorldClient } from "../../world/WorldClient.js";
import {
  SPELLBOOK_GENERAL_TAB, SPELLBOOK_OTHER_CLASS_TAB, spellbookActor, spellbookClassLines,
  spellbookOtherClassTabName, spellbookTabFor,
} from "../ui/SpellbookTabs.js";
import { className } from "../ui/UnitSnapshot.js";
import { globalString } from "../../generated/globalStrings.js";
import { lowerRankSpells, type RankedSpell } from "../ui/SpellRanks.js";
import type { FrameXmlSpellTabInfo } from "./FrameXmlWorldSeam.js";

/** The small live-data surface needed to answer the stock spellbook's skill-line tabs. */
export interface FrameXmlSpellBookTabSource {
  readonly world: WorldClient | undefined;
  readonly talent: TalentClient | undefined;
  readonly spells: ReadonlyMap<number, SpellMetadata>;
}

/**
 * The General tab's picture, `INV_Misc_Book_09`: the client draws it for the tab it makes itself
 * (`SkillLine` 183 is the "GENERIC (DND)" row and carries the question mark). The native book's
 * `GENERAL_TAB_ICON` is the same picture by `SpellIcon` id.
 */
const GENERAL_TAB_TEXTURE = "Interface\\Icons\\INV_Misc_Book_09";

/** `GENERAL_SPELLS` in the client's GlobalStrings, the General tab's tooltip; ruRU's is «Общие». */
const generalTabName = (): string => globalString("GENERAL_SPELLS") ?? "Общие";

export interface FrameXmlSpellBookTabResolvers {
  readonly spellTabs: () => readonly FrameXmlSpellTabInfo[];
  readonly spellTabFor: (spellId: number) => number | undefined;
  /** A known spell another known rank of its chain outranks; folded away while ShowAllSpellRanks is off. */
  readonly spellIsLowerRank: (spellId: number) => boolean;
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
  let lowerRanks = new Set<number>();

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
    lowerRanks = new Set();
    if (!world || !talent || !ready) {
      tabs = Object.freeze([]);
      return;
    }
    // The same class-tabs-plus-General model as the native book, from the same classifier, and
    // the same actor: the character's class and race out of the live world, so a row for another
    // class keeps its spell out of a tab here exactly as it does in the native book. (Tests drive
    // this with no world at all, which makes the masks permissive, as an empty actor always did.)
    const actor = spellbookActor();
    const data = {
      skillOfSpell: (id: number) => talent.skillOfSpell(id),
      spellAbilitiesOf: (id: number) => talent.spellAbilitiesOf?.(id),
      skillLine: (id: number) => talent.skillLine(id),
      skillLineClass: (line: number) => talent.skillLineClass?.(line),
    };
    const knownIds = world.knownSpells.map((knownSpell) => knownSpell.id);
    const classLines = spellbookClassLines(data, knownIds, actor);
    const groups = new Map<number, Array<{ id: number; slot: number; icon: string }>>();
    for (const [order, knownSpell] of world.knownSpells.entries()) {
      const metadata = spells.get(knownSpell.id);
      if (!metadata || metadata.hidden === true) continue;
      // `SPELL_ATTR0_TRADESPELL`: a learned recipe is cast from its profession window and the
      // client's book never lists it. Measured on the owner's realm (2026-09-28): the General tab
      // opened with a custom recipe row, «QA Test +2000 Spell Power Ring» (98379, attributes
      // 0x10030), above the character's spells. The attribute alone is the client's rule — an
      // item-creating class spell (Conjure Water, Create Healthstone) stays in its tab.
      if (metadata.tradeSkill === true) continue;
      const line = spellbookTabFor(knownSpell.id, data, classLines, actor);
      const list = groups.get(line) ?? [];
      list.push({
        id: knownSpell.id,
        slot: Number.isFinite(knownSpell.slot) ? knownSpell.slot : order,
        icon: metadata.iconPath,
      });
      groups.set(line, list);
    }
    // After General, the class lines in the order of the class's talent trees, which is the order
    // the original book shows them (Arcane, Fire, Frost; Arms, Fury, Protection — the trees and the
    // lines share their names). A line no tree is named after — a custom class, a realm's own line
    // — follows by name.
    const treeOrder = new Map<string, number>();
    if (actor.classId !== undefined) {
      for (const [index, tab] of talent.tabsForClass(actor.classId).entries()) treeOrder.set(tab.name, index);
    }
    // The other classes' spells come last, under the character's class name when the class has no
    // tree of its own (SpellbookTabs.ts), with the first spell's picture: no SkillLine stands for it.
    const otherName = spellbookOtherClassTabName(className(actor.classId), classLines.size > 0);
    const rank = (line: number): number => (line === SPELLBOOK_GENERAL_TAB ? 0 : line === SPELLBOOK_OTHER_CLASS_TAB ? 2 : 1);
    const ordered = [...groups.entries()].map(([line, entries]) => {
      entries.sort((left, right) => left.slot - right.slot || left.id - right.id);
      const info = line === SPELLBOOK_OTHER_CLASS_TAB ? undefined : talent.skillLine(line);
      return {
        line,
        entries,
        name: line === SPELLBOOK_GENERAL_TAB ? generalTabName()
          : line === SPELLBOOK_OTHER_CLASS_TAB ? otherName : info?.name ?? `Навык ${line}`,
        // The tab's picture is the line's own `SpellIcon` (Arcane's sentry, Fire's flame), as the
        // client draws it; a gateway that predates `iconPath` falls back to the first spell's.
        texture: line === SPELLBOOK_GENERAL_TAB ? GENERAL_TAB_TEXTURE : info?.iconPath || "",
      };
    }).sort((left, right) => rank(left.line) - rank(right.line)
      || (treeOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (treeOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name) || left.line - right.line);
    let offset = 0;
    let highestOffset = 0;
    tabs = Object.freeze(ordered.map((group, index) => {
      for (const entry of group.entries) tabBySpell.set(entry.id, index + 1);
      const texture = group.texture || (group.entries.find((entry) => entry.icon)?.icon ?? "");
      // The last two values are the book with lower ranks folded away — what SpellBook_GetTabInfo
      // reads while `ShowAllSpellRanks` is off (SpellBookFrame.lua:656-663). They are the native
      // book's chains (ui/SpellRanks.ts), so the two books hide the same rows.
      const ranked: RankedSpell[] = [];
      for (const entry of group.entries) {
        const metadata = spells.get(entry.id);
        // A row without the chain columns is its own highest rank (`rankChainKey` joins the mask).
        if (!metadata || !Array.isArray(metadata.spellClassMask) || typeof metadata.spellLevel !== "number") continue;
        ranked.push({
          id: entry.id, name: metadata.name, rank: metadata.rank, spellLevel: metadata.spellLevel,
          spellClassSet: metadata.spellClassSet, spellClassMask: metadata.spellClassMask,
          skillLine: talent.skillOfSpell(entry.id) ?? group.line,
        });
      }
      const lower = lowerRankSpells(ranked);
      for (const id of lower) lowerRanks.add(id);
      const highest = group.entries.length - lower.size;
      const result: FrameXmlSpellTabInfo = [
        group.name, texture, offset, group.entries.length, highestOffset, highest,
      ];
      offset += group.entries.length;
      highestOffset += highest;
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
    spellIsLowerRank: (spellId) => {
      refresh();
      return lowerRanks.has(spellId);
    },
  };
}
