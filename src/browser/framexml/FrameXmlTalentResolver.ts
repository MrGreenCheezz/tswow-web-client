import type { TalentsInfo, TalentSpec } from "../../world/CharacterProgressProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { unit } from "../../world/Fields.js";

/**
 * The part of TalentClient needed by the stock talent bindings.
 *
 * The concrete client resolves tab icons/background basenames from the same DBC tables that stock
 * TalentFrameBase consumes. Optional aliases remain accepted for small synthetic fixtures.
 */
export interface FrameXmlTalentMetadata {
  readonly ready: boolean;
  /** Changes whenever the complete `/dbc/talents` snapshot is replaced. */
  readonly revision: number;
  tabsForClass(classId: number): readonly FrameXmlTalentTabMetadata[];
  /** Exact pet-tree membership from CreatureFamily and TalentTab DBC masks. */
  petTabs?(familyMask: number): readonly FrameXmlTalentTabMetadata[];
  petTalentMask?(creatureFamily: number): number;
  talentsIn(tabId: number): readonly FrameXmlTalentEntryMetadata[];
}

/** A `TalentTab.dbc` row as far as the resolver needs it. */
export interface FrameXmlTalentTabMetadata {
  readonly id: number;
  readonly name: string;
  readonly orderIndex: number;
  readonly classMask?: number;
  readonly petTalentMask?: number;
  /** The current TalentClient has this id, not a resolved texture path. */
  readonly iconId?: number;
  /** `SpellIcon.TextureFilename`, resolved by the gateway. */
  readonly iconPath?: string;
  /** Optional future resolved texture path. */
  readonly iconTexture?: string;
  /** Alias accepted for focused metadata fixtures and future loaders. */
  readonly icon?: string;
  /** Optional future `TalentFrame` background basename. */
  readonly background?: string;
  /** Alias used by the native helper's terminology. */
  readonly backgroundFile?: string;
}

/** A `Talent.dbc` row as far as the resolver needs it. */
export interface FrameXmlTalentEntryMetadata {
  readonly id: number;
  readonly tabId: number;
  /** DBC coordinates are zero-based; the snapshot reports the Lua 1-based coordinates. */
  readonly tier: number;
  readonly column: number;
  /** One spell id per rank; its length is the authoritative maximum rank. */
  readonly ranks: readonly number[];
  readonly prerequisites: readonly FrameXmlTalentPrerequisiteMetadata[];
  /** Not present in the current TalentClient response. */
  readonly name?: string;
  /** Optional resolved texture path; not present in the current response. */
  readonly iconTexture?: string;
  /** Alias accepted for future metadata. */
  readonly icon?: string;
  /** Optional numeric icon id if a future Talent metadata projection carries one. */
  readonly iconId?: number;
  /** Optional native flag; absent in the current DBC projection. */
  readonly isExceptional?: boolean;
}

export interface FrameXmlTalentPrerequisiteMetadata {
  readonly talentId: number;
  /** Already one-based: TalentMetadata raises the DBC's zero-based rank once. */
  readonly rank: number;
}

/** The caller-owned player and packet revisions used by the cached wrapper. */
export interface FrameXmlTalentResolverSource {
  readonly player: WorldObjectState | undefined;
  /** Must advance when the player's class/update fields change. */
  readonly playerRevision: number;
  readonly talents: TalentsInfo | undefined;
  /** Must advance when a new `SMSG_TALENTS_INFO` replaces the packet snapshot. */
  readonly talentsRevision: number;
  readonly petGuid?: bigint | undefined;
  readonly petFamilyMask?: number | undefined;
  readonly petTalents?: TalentsInfo | undefined;
  readonly petTalentsRevision?: number | undefined;
  readonly talent: FrameXmlTalentMetadata | undefined;
}

/** One prerequisite as `GetTalentPrereqs` can report it. */
export interface FrameXmlTalentPrerequisiteSnapshot {
  readonly talentId: number;
  /** Lua's one-based row; unavailable only when metadata names an unknown talent. */
  readonly tier: number | undefined;
  /** Lua's one-based column; unavailable only when metadata names an unknown talent. */
  readonly column: number | undefined;
  /** Required learned rank, one-based. */
  readonly requiredRank: number;
  readonly meetsPrereq: boolean | undefined;
  /** Preview allocations are not represented by the current packet. */
  readonly meetsPreviewPrereq: undefined;
}

/** One cell as `GetTalentInfo` can report it, plus its prerequisite coordinates. */
export interface FrameXmlTalentCellSnapshot {
  /** One-based position within the tab, the index all stock calls share. */
  readonly index: number;
  readonly id: number;
  /** Current metadata does not carry spell names. */
  readonly name: string | undefined;
  /** A resolved texture path, when metadata has one; numeric icon ids stay in `iconId`. */
  readonly iconTexture: string | undefined;
  readonly iconId: number | undefined;
  readonly tier: number;
  readonly column: number;
  /** Rank parsed from the packet, already one-based. */
  readonly rank: number;
  readonly maxRank: number;
  /** Current TalentClient has no exceptional marker. */
  readonly isExceptional: boolean | undefined;
  readonly meetsPrereq: boolean | undefined;
  /** Preview allocations are deliberately not fabricated. */
  readonly previewRank: undefined;
  readonly meetsPreviewPrereq: undefined;
  readonly prerequisites: readonly FrameXmlTalentPrerequisiteSnapshot[];
  /** Exact hyperlink syntax and localized spell name are not available here. */
  readonly link: undefined;
}

/** One tab as `GetTalentTabInfo`, `GetNumTalents`, and the talent lookup see it. */
export interface FrameXmlTalentTabSnapshot {
  /** Lua's one-based tab index. */
  readonly index: number;
  readonly id: number;
  readonly name: string | undefined;
  /** Numeric DBC icon id from current TalentClient metadata. */
  readonly iconId: number | undefined;
  /** Resolved icon path, unavailable in current metadata. */
  readonly iconTexture: string | undefined;
  readonly background: string | undefined;
  readonly pointsSpent: number;
  /** Preview allocation is unsupported for both owners; stock expects a numeric zero. */
  readonly previewPointsSpent: 0;
  readonly talents: readonly FrameXmlTalentCellSnapshot[];
}

/** One talent group; `group` is Lua-facing and `spec` is wire-facing. */
export interface FrameXmlTalentGroupSnapshot {
  /** Lua's one-based group argument. */
  readonly group: number;
  /** `TalentsInfo.activeSpec`/the packet's zero-based group index. */
  readonly spec: number;
  readonly active: boolean;
  /** Only the active group's pool is carried by the current packet. */
  readonly unspentPoints: number | undefined;
  readonly tabs: readonly FrameXmlTalentTabSnapshot[];
}

/** Immutable projection for one Blizzard_TalentUI talent owner. `classId` is zero for a pet. */
export interface FrameXmlTalentSnapshot {
  readonly classId: number;
  readonly activeTalentGroup: number;
  /** The same active group in packet/wire indexing. */
  readonly activeSpec: number;
  readonly numTalentGroups: number;
  /** The packet's unspent pool, which belongs to `activeTalentGroup`. */
  readonly unspentPoints: number;
  readonly groups: readonly FrameXmlTalentGroupSnapshot[];
}

export interface FrameXmlTalentResolvers {
  readonly talentSnapshot: () => FrameXmlTalentSnapshot | undefined;
  readonly petTalentSnapshot: () => FrameXmlTalentSnapshot | undefined;
}

const TYPEID_PLAYER = 4;
const EMPTY_PREREQUISITES: readonly FrameXmlTalentPrerequisiteSnapshot[] = Object.freeze([]);
const EMPTY_TABS: readonly FrameXmlTalentTabSnapshot[] = Object.freeze([]);
const EMPTY_GROUPS: readonly FrameXmlTalentGroupSnapshot[] = Object.freeze([]);

function finiteInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && Number.isFinite(value);
}

function optionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveNumber(value: number | undefined): number | undefined {
  return finiteInteger(value) && value > 0 ? value : undefined;
}

function learnedRanks(spec: TalentSpec): ReadonlyMap<number, number> {
  const learned = new Map<number, number>();
  for (const talent of spec.talents) {
    if (!finiteInteger(talent.talentId) || talent.talentId <= 0) continue;
    if (!finiteInteger(talent.rank) || talent.rank < 0) continue;
    learned.set(talent.talentId, talent.rank);
  }
  return learned;
}

function orderedTabs(metadata: FrameXmlTalentMetadata, classId: number): FrameXmlTalentTabMetadata[] {
  return [...metadata.tabsForClass(classId)]
    .filter((tab) => finiteInteger(tab.id) && tab.id > 0 && finiteInteger(tab.orderIndex))
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);
}

function orderedPetTabs(metadata: FrameXmlTalentMetadata, familyMask: number): FrameXmlTalentTabMetadata[] {
  return [...(metadata.petTabs?.(familyMask) ?? [])]
    .filter((tab) => finiteInteger(tab.id) && tab.id > 0 && finiteInteger(tab.orderIndex)
      && tab.classMask === 0 && finiteInteger(tab.petTalentMask)
      && ((tab.petTalentMask & familyMask) !== 0))
    .sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);
}

function orderedTalents(metadata: FrameXmlTalentMetadata, tabId: number): FrameXmlTalentEntryMetadata[] {
  return [...metadata.talentsIn(tabId)]
    .filter((talent) => finiteInteger(talent.id) && talent.id > 0
      && talent.tabId === tabId && finiteInteger(talent.tier) && talent.tier >= 0
      && finiteInteger(talent.column) && talent.column >= 0)
    .sort((left, right) => left.tier - right.tier || left.column - right.column || left.id - right.id);
}

function resolveFromTabs(
  classId: number,
  talents: TalentsInfo,
  metadata: FrameXmlTalentMetadata,
  tabs: readonly FrameXmlTalentTabMetadata[],
  pointsPerTier: number,
): FrameXmlTalentSnapshot | undefined {
  if (!finiteInteger(talents.activeSpec) || talents.activeSpec < 0
    || talents.activeSpec >= talents.specs.length || talents.specs.length === 0) return undefined;
  if (!finiteInteger(talents.unspentPoints) || talents.unspentPoints < 0) return undefined;
  const allEntries = new Map<number, FrameXmlTalentEntryMetadata>();
  for (const tab of tabs) {
    for (const entry of orderedTalents(metadata, tab.id)) {
      if (!allEntries.has(entry.id)) allEntries.set(entry.id, entry);
    }
  }

  const groups: FrameXmlTalentGroupSnapshot[] = [];
  for (let specIndex = 0; specIndex < talents.specs.length; specIndex++) {
    const spec = talents.specs[specIndex]!;
    const learned = learnedRanks(spec);
    const tabSnapshots: FrameXmlTalentTabSnapshot[] = [];

    for (let tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
      const tab = tabs[tabIndex]!;
      const entries = orderedTalents(metadata, tab.id);
      const cellSnapshots: FrameXmlTalentCellSnapshot[] = [];
      // Talent tier gating is based on the total points already spent in this tree, not on
      // the order in which DBC rows happen to be sorted.  A later-column talent in the same
      // tree can therefore unlock an earlier-column row; compute the tab total before resolving
      // any cell instead of accumulating a prefix while walking the rows.
      const pointsSpent = entries.reduce((total, entry) => {
        const rank = learned.get(entry.id) ?? 0;
        return total + (finiteInteger(rank) && rank > 0
          ? Math.min(rank, entry.ranks.length, pointsPerTier) : 0);
      }, 0);

      for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        const entry = entries[entryIndex]!;
        const rank = Math.min(learned.get(entry.id) ?? 0, entry.ranks.length, pointsPerTier);

        const prerequisites: FrameXmlTalentPrerequisiteSnapshot[] = [];
        let meetsPrereq: boolean | undefined = true;
        for (const required of entry.prerequisites) {
          if (!finiteInteger(required.talentId) || required.talentId <= 0
            || !finiteInteger(required.rank) || required.rank < 1) {
            meetsPrereq = undefined;
            continue;
          }
          const prerequisite = allEntries.get(required.talentId);
          const prerequisiteRank = learned.get(required.talentId) ?? 0;
          const known = prerequisite !== undefined;
          if (!known) meetsPrereq = undefined;
          else if (prerequisiteRank < required.rank && meetsPrereq !== undefined) meetsPrereq = false;
          prerequisites.push(Object.freeze({
            talentId: required.talentId,
            tier: prerequisite ? prerequisite.tier + 1 : undefined,
            column: prerequisite ? prerequisite.column + 1 : undefined,
            requiredRank: required.rank,
            meetsPrereq: known ? prerequisiteRank >= required.rank : undefined,
            meetsPreviewPrereq: undefined,
          }));
        }
        // The core and TalentFrameBase use five points per player tier and three per pet tier.
        if (pointsSpent < entry.tier * pointsPerTier && meetsPrereq !== undefined) meetsPrereq = false;

        const cell: FrameXmlTalentCellSnapshot = {
          index: entryIndex + 1,
          id: entry.id,
          name: optionalString(entry.name),
          iconTexture: optionalString(entry.iconTexture ?? entry.icon),
          iconId: optionalPositiveNumber(entry.iconId),
          tier: entry.tier + 1,
          column: entry.column + 1,
          rank,
          maxRank: Math.min(entry.ranks.length, pointsPerTier),
          isExceptional: entry.isExceptional,
          meetsPrereq,
          previewRank: undefined,
          meetsPreviewPrereq: undefined,
          prerequisites: prerequisites.length > 0 ? Object.freeze(prerequisites) : EMPTY_PREREQUISITES,
          link: undefined,
        };
        cellSnapshots.push(Object.freeze(cell));
      }

      const tabSnapshot: FrameXmlTalentTabSnapshot = {
        index: tabIndex + 1,
        id: tab.id,
        name: optionalString(tab.name),
        iconId: optionalPositiveNumber(tab.iconId),
        iconTexture: optionalString(tab.iconTexture ?? tab.iconPath ?? tab.icon),
        background: optionalString(tab.background ?? tab.backgroundFile),
        pointsSpent,
        // Preview allocations are intentionally unavailable.  A numeric zero is the honest
        // no-preview value because Blizzard_TalentUI adds this field during tab refresh.
        previewPointsSpent: 0,
        talents: Object.freeze(cellSnapshots),
      };
      tabSnapshots.push(Object.freeze(tabSnapshot));
    }

    groups.push(Object.freeze({
      group: specIndex + 1,
      spec: specIndex,
      active: specIndex === talents.activeSpec,
      unspentPoints: specIndex === talents.activeSpec ? talents.unspentPoints : undefined,
      tabs: tabSnapshots.length > 0 ? Object.freeze(tabSnapshots) : EMPTY_TABS,
    }));
  }

  const snapshot: FrameXmlTalentSnapshot = {
    classId,
    activeTalentGroup: talents.activeSpec + 1,
    activeSpec: talents.activeSpec,
    numTalentGroups: talents.specs.length,
    unspentPoints: talents.unspentPoints,
    groups: groups.length > 0 ? Object.freeze(groups) : EMPTY_GROUPS,
  };
  return Object.freeze(snapshot);
}

function resolveSnapshot(
  player: WorldObjectState | undefined,
  talents: TalentsInfo | undefined,
  metadata: FrameXmlTalentMetadata | undefined,
): FrameXmlTalentSnapshot | undefined {
  if (!player || player.typeId !== TYPEID_PLAYER || !talents || talents.pet
    || !metadata || metadata.ready !== true) return undefined;
  const classId = unit.classId(player);
  if (!finiteInteger(classId) || classId < 1 || classId > 11) return undefined;
  return resolveFromTabs(classId, talents, metadata, orderedTabs(metadata, classId), 5);
}

/** A pet has one group, its own rank packet and DBC mask, and three points per tier. */
export function resolveFrameXmlPetTalentSnapshot(
  petGuid: bigint | undefined,
  familyMask: number | undefined,
  talents: TalentsInfo | undefined,
  metadata: FrameXmlTalentMetadata | undefined,
): FrameXmlTalentSnapshot | undefined {
  if (petGuid === undefined || petGuid === 0n || !finiteInteger(familyMask) || familyMask === 0
    || !talents?.pet || talents.activeSpec !== 0 || talents.specs.length !== 1
    || !metadata || metadata.ready !== true) return undefined;
  const tabs = orderedPetTabs(metadata, familyMask);
  return tabs.length > 0 ? resolveFromTabs(0, talents, metadata, tabs, 3) : undefined;
}

/**
 * Resolve one immutable, player-only Blizzard_TalentUI snapshot.
 *
 * `TalentsInfo.activeSpec` and each packet rank are zero-based on the wire only at the parser
 * boundary.  The snapshot keeps both forms where a stock binding needs them: `spec`/`activeSpec`
 * remain wire-facing while `group`, `activeTalentGroup`, tab/talent indices, tiers, columns, and
 * learned ranks are the one-based values Lua displays. Inspect remains unavailable here.
 */
export function resolveFrameXmlTalentSnapshot(
  player: WorldObjectState | undefined,
  talents: TalentsInfo | undefined,
  metadata: FrameXmlTalentMetadata | undefined,
): FrameXmlTalentSnapshot | undefined {
  return resolveSnapshot(player, talents, metadata);
}

/**
 * Cache the immutable snapshot across the many stock calls made during one redraw.
 *
 * The caller owns revision increments.  Identity checks alone are insufficient because WorldClient
 * may update a mutable object in place, while revisions alone are insufficient when a new packet
 * object arrives without a counter change.
 */
export function createFrameXmlTalentResolvers(
  read: () => FrameXmlTalentResolverSource,
): FrameXmlTalentResolvers {
  let cachedPlayer: WorldObjectState | undefined;
  let cachedPlayerRevision = Number.NaN;
  let cachedTalents: TalentsInfo | undefined;
  let cachedTalentsRevision = Number.NaN;
  let cachedPetGuid: bigint | undefined;
  let cachedPetFamilyMask = -1;
  let cachedPetTalents: TalentsInfo | undefined;
  let cachedPetTalentsRevision = -1;
  let cachedMetadata: FrameXmlTalentMetadata | undefined;
  let cachedMetadataRevision = Number.NaN;
  let cachedMetadataReady = false;
  let snapshot: FrameXmlTalentSnapshot | undefined;
  let petSnapshot: FrameXmlTalentSnapshot | undefined;

  const refresh = (): void => {
    const source = read();
    const metadataRevision = source.talent?.revision ?? -1;
    const metadataReady = source.talent?.ready === true;
    if (source.player === cachedPlayer && source.playerRevision === cachedPlayerRevision
      && source.talents === cachedTalents && source.talentsRevision === cachedTalentsRevision
      && source.petGuid === cachedPetGuid && (source.petFamilyMask ?? -1) === cachedPetFamilyMask
      && source.petTalents === cachedPetTalents
      && (source.petTalentsRevision ?? -1) === cachedPetTalentsRevision
      && source.talent === cachedMetadata && metadataRevision === cachedMetadataRevision
      && metadataReady === cachedMetadataReady) return;

    cachedPlayer = source.player;
    cachedPlayerRevision = source.playerRevision;
    cachedTalents = source.talents;
    cachedTalentsRevision = source.talentsRevision;
    cachedPetGuid = source.petGuid;
    cachedPetFamilyMask = source.petFamilyMask ?? -1;
    cachedPetTalents = source.petTalents;
    cachedPetTalentsRevision = source.petTalentsRevision ?? -1;
    cachedMetadata = source.talent;
    cachedMetadataRevision = metadataRevision;
    cachedMetadataReady = metadataReady;
    snapshot = resolveSnapshot(source.player, source.talents, source.talent);
    petSnapshot = resolveFrameXmlPetTalentSnapshot(
      source.petGuid, source.petFamilyMask, source.petTalents, source.talent);
  };

  return {
    talentSnapshot: () => {
      refresh();
      return snapshot;
    },
    petTalentSnapshot: () => {
      refresh();
      return petSnapshot;
    },
  };
}
