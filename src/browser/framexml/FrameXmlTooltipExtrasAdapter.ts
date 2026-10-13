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
 *   the player's guid): `$N`, `$R`, `$C`, `$G…;`, `$B` — since 13.10 Wow.exe's own parser (FrameXmlQuestText.ts).
 * * The shopping tooltips' item records (0x00630c70 reads the cache without asking) and whether a
 *   merchant is open.
 */
import type { TooltipContent } from "../ui/Widgets.js";
import type {
  GameTooltipExtrasAdapter, GameTooltipQuest, GameTooltipTalent, GameTooltipTalentRequirement,
} from "../glue/GlueTooltipExtras.js";
import type { GameTooltipItemAura, GameTooltipStatSource } from "../glue/GlueTooltipStatDelta.js"; // 3.12 (04.10, L4)
import { frameXmlQuestText } from "./FrameXmlQuestText.js"; // 3.12 (13.10): was ui/NpcText.ts formatNpcText
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
      readonly spells?: readonly { readonly spellId: number }[]; // 3.12 (13.10)
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
  /** 3.12 (13.10): the page's spell rows (`game.spells`), for the item auras of the stat difference. */
  readonly spells?: ReadonlyMap<number, FrameXmlItemAuraSpellRow>;
}

/** 3.12 (13.10): a tab's learned and previewed points, as 0x006224f0 adds them (0x005c5b30's +4 and +8). */
function tabPoints(tab: { readonly pointsSpent: number; readonly previewPointsSpent?: number }): number {
  return tab.pointsSpent + (tab.previewPointsSpent ?? 0);
}

function cellOf(snapshot: FrameXmlTalentSnapshot | undefined, tab: number, index: number, group: number | undefined) {
  const wanted = group ?? snapshot?.activeTalentGroup;
  const groupSnapshot = snapshot?.groups.find((row) => row.group === wanted);
  const tabSnapshot = groupSnapshot?.tabs[tab - 1];
  const cell = tabSnapshot?.talents.find((row) => row.index === index);
  return groupSnapshot && tabSnapshot && cell ? { group: groupSnapshot, tab: tabSnapshot, cell } : undefined;
}

/** 3.12 (13.10): the spell columns 0x0061b5e0 reads from an item spell's row. */
export interface FrameXmlItemAuraSpellRow {
  readonly passive: boolean;
  readonly effects?: readonly number[];
  readonly effectAura?: readonly number[];
  readonly effectMiscValue?: readonly number[];
  readonly effectBasePoints?: readonly number[];
}

/** SPELL_EFFECT_APPLY_AURA, the only effect 0x0061b5e0 reads. */
const SPELL_EFFECT_APPLY_AURA = 6;

/**
 * 3.12 (13.10): 0x0061f350 — every spell of an item record (all five, whatever the trigger) whose row is passive
 * (SPELL_ATTR0_PASSIVE) gives its APPLY_AURA effects to the stat table. `null` while a row is not loaded (the
 * missing ids go to `request`), and for a row without the aura columns (an older gateway).
 */
export function frameXmlItemSpellAuras(
  spells: readonly { readonly spellId: number }[] | undefined,
  row: (id: number) => FrameXmlItemAuraSpellRow | undefined,
  request?: (ids: readonly number[]) => void,
): GameTooltipItemAura[] | null {
  const auras: GameTooltipItemAura[] = [];
  const missing: number[] = [];
  for (const { spellId } of spells ?? []) {
    if (!(spellId > 0)) continue;
    const metadata = row(spellId);
    if (!metadata) { missing.push(spellId); continue; }
    if (!metadata.passive) continue;
    if (!metadata.effects || !metadata.effectAura || !metadata.effectMiscValue || !metadata.effectBasePoints) return null;
    for (let effect = 0; effect < 3; effect += 1) {
      if (metadata.effects[effect] !== SPELL_EFFECT_APPLY_AURA) continue;
      auras.push({
        aura: metadata.effectAura[effect] ?? 0, misc: metadata.effectMiscValue[effect] ?? 0,
        basePoints: metadata.effectBasePoints[effect] ?? 0,
      });
    }
  }
  if (missing.length === 0) return auras;
  request?.(missing);
  return null;
}

export function frameXmlTooltipExtrasAdapter(
  seam: FrameXmlWorldSeam,
  context: () => FrameXmlTooltipExtrasWorld,
  spell: (id: number) => TooltipContent | undefined,
  requestSpells?: (ids: readonly number[]) => void, // 3.12 (13.10): the item auras' rows
): GameTooltipExtrasAdapter {
  const ranksOf = (tabId: number, talentId: number): readonly number[] | undefined =>
    context().talentData?.talentsIn(tabId).find((row) => row.id === talentId)?.ranks;
  const describe = (tab: {
    id: number; name: string | undefined; pointsSpent: number; previewPointsSpent?: number;
    talents: readonly FrameXmlTalentCellSnapshot[];
  }, cell: FrameXmlTalentCellSnapshot, rank: number, pet: boolean, own: boolean, preview = false): GameTooltipTalent | undefined => {
    const ranks = ranksOf(tab.id, cell.id);
    if (!ranks || ranks.length === 0) return undefined;
    const requirements: GameTooltipTalentRequirement[] = [];
    // 3.12 (04.10, L4): only an unlearned talent lists them (0x00626e20 → 0x006224f0).
    if (own && rank === 0) {
      const points = (cell.tier - 1) * (pet ? PET_POINTS_PER_TIER : CLASS_POINTS_PER_TIER);
      // 3.12 (13.10): 0x006224f0 counts the tab's learned and previewed points (0x005c5b30: +4 + +8) either way.
      if (tabPoints(tab) < points && tab.name) requirements.push({ kind: "tier", points, tabName: tab.name });
      for (const prerequisite of cell.prerequisites) {
        // 3.12 (13.10): with isPreview the prerequisite's preview rank (+0x20) decides, else its learned one (+0x1c).
        if ((preview ? prerequisite.meetsPreviewPrereq : prerequisite.meetsPrereq) !== false) continue;
        const first = ranksOf(tab.id, prerequisite.talentId)?.[0];
        const name = first === undefined ? undefined : spell(first)?.title;
        if (name) requirements.push({ kind: "talent", rank: prerequisite.requiredRank, name });
      }
    }
    return { ranks, rank, requirements };
  };
  return {
    talent: (tab, index, inspect, pet, group, preview = false) => {
      // 3.12 (04.10, L4): the inspected trees (FrameXmlInspect.ts), requirements by their ranks, no learn hint.
      const snapshot = inspect ? seam.inspect?.talentSnapshot?.() : seam.talentSnapshot(pet);
      const found = cellOf(snapshot, tab, index, group);
      if (!found) return undefined;
      // 3.12 (13.10): with isPreview 0x00626e20 shows the preview rank (+0x20, learned + previewed), else the learned one.
      const rank = preview ? found.cell.previewRank ?? found.cell.rank : found.cell.rank;
      const described = describe(found.tab, found.cell, rank, pet, true, preview);
      if (!described || inspect) return described;
      // 3.12 (04.10, L4): 0x00622800's TOOLTIP_TALENT_LEARN.
      // L4-review: met as 0x006224f0 answers it — an unmet one counts even when its line has no name to write.
      const tierPoints = (found.cell.tier - 1) * (pet ? PET_POINTS_PER_TIER : CLASS_POINTS_PER_TIER);
      const unmet = rank === 0 && (tabPoints(found.tab) < tierPoints
        || found.cell.prerequisites.some((prerequisite) =>
          (preview ? prerequisite.meetsPreviewPrereq : prerequisite.meetsPrereq) === false));
      const active = found.group.group === snapshot?.activeTalentGroup;
      if (preview) {
        // 3.12 (13.10): 0x00622800 with isPreview — the tooltip's group active, every requirement met: the green
        // TALENT_TOOLTIP_ADDPREVIEWPOINT when a point could be placed (0x005c76e0(+1)), then the red
        // TALENT_TOOLTIP_REMOVEPREVIEWPOINT when one could be taken back (0x005c76e0(-1)); never TOOLTIP_TALENT_LEARN.
        const model = seam.talentPreview;
        if (!active || unmet || !model) return described;
        const previewAdd = model.wouldChange(pet, found.group.group, found.tab.index, found.cell.id, 1);
        const previewRemove = model.wouldChange(pet, found.group.group, found.tab.index, found.cell.id, -1);
        return previewAdd || previewRemove ? { ...described, previewAdd, previewRemove } : described;
      }
      const learnable = active && (snapshot.unspentPoints ?? 0) > 0
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
      // 3.12 (13.10): that parser itself (FrameXmlQuestText.ts, 0x00578f20): `$c`/`$r` lowered by `_strlwr`, ASCII
      // only, so a ruRU class keeps its capital; `$G a:b:C;`'s third part never printed; an unknown marker stays.
      const objectivesText = template.objectivesText.includes("$") ? frameXmlQuestText(template.objectivesText, {
        name: seam.unitName("player"),
        className: seam.unitClass("player")?.[0],
        raceName: seam.unitRace("player")?.[0],
        female: seam.unitSex("player") === 3,
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
      if (template?.found !== true) return undefined;
      // 3.12 (13.10): the passive spells' auras (0x0061f350); a row not here yet is asked for, and the
      // table stays unknown (`spellAuras: null` — no difference) until it lands.
      const spellAuras = frameXmlItemSpellAuras(template.spells, (id) => context().spells?.get(id), requestSpells);
      return { ...template, spellAuras };
    },
    playerIsDruid: () => seam.unitClass("player")?.[1] === "DRUID", // 3.12 (13.10): ChrClasses 11
    merchantOpen: () => context().world?.vendor !== undefined && context().world?.vendor !== null,
  };
}
