import type { WorldObjectState } from "../../world/WorldState.js";
import { readSkills, type SkillEntry } from "../ui/Skills.js";

/** The part of TalentClient needed to turn a player skill field into stock SkillFrame rows. */
export interface FrameXmlSkillMetadata {
  readonly ready: boolean;
  /** Changes whenever the complete `/dbc/talents` snapshot is replaced. */
  readonly revision: number;
  skillLine(id: number): FrameXmlSkillLineMetadata | undefined;
  skillCategory(id: number): FrameXmlSkillCategoryMetadata | undefined;
  skillCategories(): readonly FrameXmlSkillCategoryMetadata[];
}

export interface FrameXmlSkillLineMetadata {
  readonly id: number;
  readonly name: string;
  readonly categoryId: number;
}

export interface FrameXmlSkillCategoryMetadata {
  readonly id: number;
  readonly name: string;
  /** The DBC `SkillLineCategory.SortIndex`, not the order of the transport response. */
  readonly orderIndex: number;
}

/** A heading row. Expansion and selection are deliberately owned by the live seam. */
export interface FrameXmlSkillHeaderRow {
  readonly kind: "header";
  /** Stable DBC category id, so a later seam can keep collapse state by id. */
  readonly id: number;
  readonly categoryId: number;
  readonly name: string;
}

/** A skill row with the exact distinct rank/bonus values the stock C API exposes. */
export interface FrameXmlSkillLineRow {
  readonly kind: "skill";
  /** Stable DBC SkillLine id. */
  readonly id: number;
  readonly skillId: number;
  readonly categoryId: number;
  readonly name: string;
  readonly step: number;
  /** Base rank: temporary and permanent bonuses are not folded into this value. */
  readonly skillRank: number;
  readonly numTempPoints: number;
  readonly skillModifier: number;
  readonly skillMaxRank: number;
}

export type FrameXmlSkillRow = FrameXmlSkillHeaderRow | FrameXmlSkillLineRow;

/** A caller-owned snapshot of the player object and the revision that changes when its fields do. */
export interface FrameXmlSkillResolverSource {
  readonly player: WorldObjectState | undefined;
  readonly playerRevision: number;
  readonly talent: FrameXmlSkillMetadata | undefined;
}

export interface FrameXmlSkillResolvers {
  /** The immutable flat list consumed by `GetNumSkillLines`/`GetSkillLineInfo`. */
  readonly skillRows: () => readonly FrameXmlSkillRow[];
}

const EMPTY_ROWS: readonly FrameXmlSkillRow[] = Object.freeze([]);
/** The stock 3.3.5 placeholder category, named "Not Displayed" in SkillLineCategory.dbc. */
const NOT_DISPLAYED_CATEGORY = 12;

function byNameThenId(left: { name: string; id: number }, right: { name: string; id: number }): number {
  return left.name.localeCompare(right.name) || left.id - right.id;
}

/**
 * Resolve one immutable SkillFrame snapshot from the same packed fields native Skills.ts reads.
 *
 * This function has no world or UI side effects. In particular it does not invent rows while the
 * metadata request is pending, and it drops a skill when either its SkillLine or category is not
 * known. The cached wrapper below is what the live seam should call from repeated Lua queries.
 */
export function resolveFrameXmlSkillRows(
  player: WorldObjectState | undefined,
  talent: FrameXmlSkillMetadata | undefined,
): readonly FrameXmlSkillRow[] {
  if (!player || !talent || talent.ready !== true) return EMPTY_ROWS;

  const categories = new Map<number, FrameXmlSkillCategoryMetadata>();
  for (const category of talent.skillCategories()) {
    if (category.id === NOT_DISPLAYED_CATEGORY || category.id <= 0 || category.name.length === 0) continue;
    if (!Number.isFinite(category.orderIndex)) continue;
    // Metadata is expected to be unique; retaining the first row makes a malformed response
    // deterministic instead of allowing transport order to change a stable heading.
    if (!categories.has(category.id)) categories.set(category.id, category);
  }

  const byCategory = new Map<number, Array<{ entry: SkillEntry; line: FrameXmlSkillLineMetadata }>>();
  for (const entry of readSkills(player)) {
    const line = talent.skillLine(entry.skillId);
    if (!line || line.id !== entry.skillId || line.name.length === 0) continue;
    if (line.categoryId === NOT_DISPLAYED_CATEGORY) continue;
    const category = categories.get(line.categoryId);
    // Ask the metadata index as well as the ordered category list. This keeps a line whose
    // category id is unknown from silently becoming a fabricated heading.
    if (!category || talent.skillCategory(line.categoryId)?.id !== category.id) continue;
    const list = byCategory.get(category.id) ?? [];
    list.push({ entry, line });
    byCategory.set(category.id, list);
  }

  const orderedCategories = [...byCategory.keys()]
    .map((id) => categories.get(id)!)
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);
  const rows: FrameXmlSkillRow[] = [];
  for (const category of orderedCategories) {
    const skills = byCategory.get(category.id)!;
    skills.sort((left, right) => byNameThenId(left.line, right.line));
    rows.push(Object.freeze({
      kind: "header",
      id: category.id,
      categoryId: category.id,
      name: category.name,
    }));
    for (const { entry, line } of skills) rows.push(skillRow(entry, line));
  }
  return Object.freeze(rows);
}

/**
 * `SkillLineCategory` 11, the primary professions: in 3.3.5 the rows SkillRaceClassInfo flags
 * SKILL_FLAG_UNLEARNABLE, and the only skills the core's HandleUnlearnSkillOpcode accepts. The
 * `/dbc/talents` rows carry the category, not the flag, so this is `isAbandonable` — the value
 * SkillFrame.lua:221 shows the unlearn button on.
 */
export const FRAMEXML_SKILL_CATEGORY_PROFESSION = 11;

export function frameXmlSkillAbandonable(row: FrameXmlSkillLineRow): boolean {
  return row.categoryId === FRAMEXML_SKILL_CATEGORY_PROFESSION;
}

function skillRow(entry: SkillEntry, line: FrameXmlSkillLineMetadata): FrameXmlSkillLineRow {
  return Object.freeze({
    kind: "skill",
    id: line.id,
    skillId: entry.skillId,
    categoryId: line.categoryId,
    name: line.name,
    step: entry.step,
    skillRank: entry.value,
    numTempPoints: entry.temporaryBonus,
    skillModifier: entry.permanentBonus,
    skillMaxRank: entry.max,
  });
}

/**
 * Cache immutable snapshots across the many `GetSkillLineInfo` calls made during one repaint.
 * `playerRevision` must be advanced by the caller when update-field words change; this avoids
 * scanning all 127 slots on every C API query while still allowing metadata to arrive late.
 */
export function createFrameXmlSkillResolvers(
  read: () => FrameXmlSkillResolverSource,
): FrameXmlSkillResolvers {
  let cachedPlayer: WorldObjectState | undefined;
  let cachedPlayerRevision = Number.NaN;
  let cachedTalent: FrameXmlSkillMetadata | undefined;
  let cachedTalentRevision = Number.NaN;
  let cachedTalentReady = false;
  let rows: readonly FrameXmlSkillRow[] = EMPTY_ROWS;

  const refresh = (): void => {
    const source = read();
    const talentRevision = source.talent?.revision ?? -1;
    const talentReady = source.talent?.ready === true;
    if (source.player === cachedPlayer && source.playerRevision === cachedPlayerRevision
      && source.talent === cachedTalent && talentRevision === cachedTalentRevision
      && talentReady === cachedTalentReady) return;

    cachedPlayer = source.player;
    cachedPlayerRevision = source.playerRevision;
    cachedTalent = source.talent;
    cachedTalentRevision = talentRevision;
    cachedTalentReady = talentReady;
    rows = resolveFrameXmlSkillRows(source.player, source.talent);
  };

  return {
    skillRows: () => {
      refresh();
      return rows;
    },
  };
}
