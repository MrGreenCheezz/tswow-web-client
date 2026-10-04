/**
 * The world facts behind plan item 3.12's GameTooltip setters (glue/GlueTooltipExtras.ts): a
 * talent's rank spells and unmet requirements, a quest link's rows, the reward spells of the quest
 * log and the quest dialog, and a glyph's spell. Built beside the item/spell adapter
 * (FrameXmlCharacterTooltip.ts) from the same seam.
 *
 * 04.10, L4 (Wow.exe 3.3.5a 12340, read 2026-10-04):
 * * `SetTalent(…, inspect)` reads the inspected player's trees (0x0062f740 → 0x005c5c60/0x005c6080
 *   with the inspect flag): its ranks and, for an unlearned talent, the requirements it does not
 *   meet — 0x006224f0 checks the inspected ranks and the inspected tab's points (0x005c5b30 on the
 *   same rank source). The requirements are written only for a talent with no current rank
 *   (0x00626e20 calls 0x006224f0 only then).
 * * TOOLTIP_TALENT_LEARN (0x00622800): the tooltip's group is the player's active one, no
 *   requirement was unmet, the group has free points (0x005c5f70), not inspect, not a link, and the
 *   talent is below its last rank.
 * * A quest link's objectives text goes through the quest text parser (0x00622960 → 0x00579590 with
 *   the player's guid): `$N`, `$R`, `$C`, `$G…;`, `$B` (ui/NpcText.ts formatNpcText).
 * * The shopping tooltips' item records (0x00630c70 reads the cache without asking) and whether a
 *   merchant is open.
 */
import type { TooltipContent } from "../ui/Widgets.js";
import type {
  GameTooltipExtrasAdapter, GameTooltipQuest, GameTooltipTalent, GameTooltipTalentRequirement,
} from "../glue/GlueTooltipExtras.js";
import type { GameTooltipStatSource } from "../glue/GlueTooltipStatDelta.js"; // 3.12 (04.10, L4)
import { formatNpcText } from "../ui/NpcText.js"; // 3.12 (04.10, L4)
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import type { FrameXmlTalentCellSnapshot, FrameXmlTalentSnapshot } from "./FrameXmlTalentResolver.js";

/** Points a tier needs spent in its tab before it opens: 5 for a class (3.3.5), 3 for a pet. */
const CLASS_POINTS_PER_TIER = 5;
const PET_POINTS_PER_TIER = 3;

/** The parts of the world the adapter reads; the page's `game` satisfies it. */
export interface FrameXmlTooltipExtrasWorld {
  readonly world?: {
    readonly questTemplates: ReadonlyMap<number, {
      readonly title: string; readonly objectivesText: string; readonly rewardDisplaySpell: number;
      readonly objectives: readonly { readonly text: string }[];
    }>;
    readonly questDialog?: { readonly kind: string; readonly rewards?: { readonly displaySpell?: number } } | undefined;
    queryQuest?(questId: number): void;
    /** 3.12 (04.10, L4): the item cache, read without asking. */
    readonly itemTemplates?: ReadonlyMap<number, GameTooltipStatSource & {
      readonly found: boolean; readonly scalingStatValue: number;
    }>;
    /** 3.12 (04.10, L4): the open merchant's list (SMSG_LIST_INVENTORY), undefined once closed. */
    readonly vendor?: unknown;
    /** 3.12 (04.10, L4): the player's declined names, for `|3-N($N)` in quest text. */
    readonly names?: { declined(guid: bigint): readonly string[] | undefined };
    readonly state?: { readonly selfGuid?: bigint | undefined };
  } | undefined;
  readonly talentData?: {
    talentsIn(tabId: number): readonly { readonly id: number; readonly ranks: readonly number[] }[];
    glyph(id: number): { readonly spellId: number; readonly flags: number } | undefined;
  } | undefined;
}

function cellOf(snapshot: FrameXmlTalentSnapshot | undefined, tab: number, index: number, group: number | undefined) {
  const wanted = group ?? snapshot?.activeTalentGroup;
  const groupSnapshot = snapshot?.groups.find((row) => row.group === wanted);
  const tabSnapshot = groupSnapshot?.tabs[tab - 1];
  const cell = tabSnapshot?.talents.find((row) => row.index === index);
  return groupSnapshot && tabSnapshot && cell ? { group: groupSnapshot, tab: tabSnapshot, cell } : undefined;
}

export function frameXmlTooltipExtrasAdapter(
  seam: FrameXmlWorldSeam,
  context: () => FrameXmlTooltipExtrasWorld,
  spell: (id: number) => TooltipContent | undefined,
): GameTooltipExtrasAdapter {
  const ranksOf = (tabId: number, talentId: number): readonly number[] | undefined =>
    context().talentData?.talentsIn(tabId).find((row) => row.id === talentId)?.ranks;
  const describe = (tab: { id: number; name: string | undefined; pointsSpent: number; talents: readonly FrameXmlTalentCellSnapshot[] },
    cell: FrameXmlTalentCellSnapshot, rank: number, pet: boolean, own: boolean): GameTooltipTalent | undefined => {
    const ranks = ranksOf(tab.id, cell.id);
    if (!ranks || ranks.length === 0) return undefined;
    const requirements: GameTooltipTalentRequirement[] = [];
    // 3.12 (04.10, L4): only an unlearned talent lists them (0x00626e20 → 0x006224f0).
    if (own && rank === 0) {
      const points = (cell.tier - 1) * (pet ? PET_POINTS_PER_TIER : CLASS_POINTS_PER_TIER);
      if (tab.pointsSpent < points && tab.name) requirements.push({ kind: "tier", points, tabName: tab.name });
      for (const prerequisite of cell.prerequisites) {
        if (prerequisite.meetsPrereq !== false) continue;
        const first = ranksOf(tab.id, prerequisite.talentId)?.[0];
        const name = first === undefined ? undefined : spell(first)?.title;
        if (name) requirements.push({ kind: "talent", rank: prerequisite.requiredRank, name });
      }
    }
    return { ranks, rank, requirements };
  };
  return {
    talent: (tab, index, inspect, pet, group) => {
      // 3.12 (04.10, L4): the inspected trees (FrameXmlInspect.ts), requirements by their ranks, no learn hint.
      const snapshot = inspect ? seam.inspect?.talentSnapshot?.() : seam.talentSnapshot(pet);
      const found = cellOf(snapshot, tab, index, group);
      if (!found) return undefined;
      const described = describe(found.tab, found.cell, found.cell.rank, pet, true);
      if (!described || inspect) return described;
      // 3.12 (04.10, L4): 0x00622800's TOOLTIP_TALENT_LEARN.
      // L4-review: met as 0x006224f0 answers it — an unmet one counts even when its line has no name to write.
      const tierPoints = (found.cell.tier - 1) * (pet ? PET_POINTS_PER_TIER : CLASS_POINTS_PER_TIER);
      const unmet = found.cell.rank === 0 && (found.tab.pointsSpent < tierPoints
        || found.cell.prerequisites.some((prerequisite) => prerequisite.meetsPrereq === false));
      const learnable = found.group.group === snapshot?.activeTalentGroup && (snapshot.unspentPoints ?? 0) > 0
        && described.rank < described.ranks.length && (described.requirements?.length ?? 0) === 0 && !unmet; // L4-review: && !unmet
      return learnable ? { ...described, learnable } : described;
    },
    talentById: (talentId, rank) => {
      for (const pet of [false, true]) {
        for (const group of seam.talentSnapshot(pet)?.groups ?? []) {
          for (const tab of group.tabs) {
            const cell = tab.talents.find((row) => row.id === talentId);
            if (cell) return describe(tab, cell, rank ?? 0, pet, false);
          }
        }
      }
      return undefined;
    },
    quest: (questId): GameTooltipQuest | undefined => {
      const world = context().world;
      const template = world?.questTemplates.get(questId);
      if (!template) { world?.queryQuest?.(questId); return undefined; }
      const index = seam.questLog?.indexOfQuest(questId);
      const requirements: string[] = [];
      if (index !== undefined) {
        const count = seam.questLogLeaderBoardCount(index);
        for (let objective = 1; objective <= count; objective++) {
          const row = seam.questLogLeaderBoard(objective, index);
          if (row && row[0]) requirements.push(row[0]);
        }
      } else {
        for (const objective of template.objectives) if (objective.text) requirements.push(objective.text);
      }
      // 3.12 (04.10, L4): the objectives text through the quest text parser (0x00579590), for the player.
      const self = world?.state?.selfGuid;
      const objectivesText = template.objectivesText.includes("$") ? formatNpcText(template.objectivesText, {
        name: seam.unitName("player") ?? "",
        className: seam.unitClass("player")?.[0] ?? "",
        raceName: seam.unitRace("player")?.[0] ?? "",
        gender: seam.unitSex("player") === 3 ? 1 : 0,
        declined: self === undefined ? undefined : world?.names?.declined(self),
      }) : template.objectivesText;
      return { title: template.title, objectivesText, active: index !== undefined, requirements };
    },
    questLogRewardSpell: () => {
      const questId = seam.questLog?.entryAt(seam.questLogSelection())?.questId;
      const id = questId === undefined ? undefined : context().world?.questTemplates.get(questId)?.rewardDisplaySpell;
      return id !== undefined && id > 0 ? id : undefined;
    },
    questRewardSpell: () => {
      const dialog = context().world?.questDialog;
      const id = dialog && (dialog.kind === "details" || dialog.kind === "reward") ? dialog.rewards?.displaySpell : undefined;
      return id !== undefined && id > 0 ? id : undefined;
    },
    glyph: (glyphId) => {
      const row = context().talentData?.glyph(glyphId);
      // GlyphProperties.GlyphType: 0 major, 1 minor.
      return row && row.spellId > 0 ? { spellId: row.spellId, major: (row.flags & 1) === 0 } : undefined;
    },
    // 3.12 (04.10, L4): cached records only, as 0x00630c70 reads them.
    itemStats: (entry) => {
      const template = context().world?.itemTemplates?.get(entry);
      return template?.found === true ? template : undefined;
    },
    merchantOpen: () => context().world?.vendor !== undefined && context().world?.vendor !== null,
  };
}
