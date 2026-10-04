import type { FactionClient } from "../FactionClient.js";
import type { ReputationCatalog } from "../../gateway/ReputationMetadata.js";
import { readByte } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { FrameXmlFactionRow } from "./FrameXmlWorldSeam.js";

/** The server flags carried by `SMSG_INITIALIZE_FACTIONS`/`FactionState.flags`. */
export const FRAMEXML_FACTION_FLAGS = Object.freeze({
  visible: 0x01,
  atWar: 0x02,
  hidden: 0x04,
  invisibleForced: 0x08,
  peaceForced: 0x10,
  inactive: 0x20,
  rival: 0x40,
});

export interface FrameXmlReputationWorld {
  readonly factions: ReadonlyMap<number, { listId: number; flags: number; standing: number }>;
  /** The player object, for the race and class Faction.dbc's base standing is chosen by. */
  readonly state?: { readonly selfGuid: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
}

/**
 * Names, and — once `FactionClient.loadReputation` has landed — Faction.dbc's reputation rows,
 * whose race/class base the client adds to the wire's standing.
 */
export type FrameXmlReputationMetadata = Pick<FactionClient, "ready" | "name"> & {
  readonly reputationCatalog?: ReputationCatalog | undefined;
};

/**
 * 5.19: the base standing Faction.dbc gives this character for a reputation list id — the first of
 * the row's four race/class entries that matches (`ReputationMgr::GetBaseReputation`,
 * ReputationMgr.cpp:97; the same rule as `Repair.ts` `baseReputation`). The wire's standing
 * (SMSG_INITIALIZE_FACTIONS, SMSG_SET_FACTION_STANDING) is the stored standing *without* it;
 * Wow.exe keeps both per row and reads their sum (0x005d05b0), which is what 0x005d0a10's peace
 * test and the reputation frame compare. 0 without the catalog or the player object.
 */
export function frameXmlReputationBase(
  world: FrameXmlReputationWorld, catalog: ReputationCatalog | undefined, listId: number,
): number {
  const faction = catalog?.factions[listId];
  const selfGuid = world.state?.selfGuid;
  const self = selfGuid === undefined ? undefined : world.state?.objects.get(selfGuid);
  if (!faction || !self) return 0;
  const race = readByte(self, "UNIT_FIELD_BYTES_0", 0) ?? 0;
  const playerClass = readByte(self, "UNIT_FIELD_BYTES_0", 1) ?? 0;
  const raceMask = race > 0 ? 1 << (race - 1) : 0;
  const classMask = playerClass > 0 ? 1 << (playerClass - 1) : 0;
  for (let index = 0; index < 4; index++) {
    const races = faction.raceMasks[index] ?? 0;
    const classes = faction.classMasks[index] ?? 0;
    if (((races & raceMask) !== 0 || (races === 0 && classes !== 0))
      && ((classes & classMask) !== 0 || classes === 0)) return faction.bases[index] ?? 0;
  }
  return 0;
}

function standingBounds(standing: number): readonly [number, number, number] {
  return standing >= 42_000
    ? [8, 42_000, 42_000]
    : standing >= 21_000
      ? [7, 21_000, 42_000]
      : standing >= 9_000
        ? [6, 9_000, 21_000]
        : standing >= 3_000
          ? [5, 3_000, 9_000]
          : standing >= 0
            ? [4, 0, 3_000]
            : standing >= -3_000
              ? [3, -3_000, 0]
              : standing >= -6_000
                ? [2, -6_000, -3_000]
                : [1, -42_000, -6_000];
}

/**
 * Resolve only visible, named server rows.  FactionClient supplies names; it does not supply
 * invented category parents or descriptions, so this intentionally returns a flat list.
 */
export function resolveFrameXmlReputationRows(
  world: FrameXmlReputationWorld,
  factionMetadata: FrameXmlReputationMetadata | undefined,
): readonly FrameXmlFactionRow[] {
  if (!factionMetadata?.ready) return [];
  const rows: FrameXmlFactionRow[] = [];
  for (const state of world.factions.values()) {
    const flags = state.flags;
    if ((flags & FRAMEXML_FACTION_FLAGS.visible) === 0
      || (flags & (FRAMEXML_FACTION_FLAGS.hidden | FRAMEXML_FACTION_FLAGS.invisibleForced)) !== 0) {
      continue;
    }
    const name = factionMetadata.name(state.listId);
    if (!name) continue;
    // What the client shows is the base plus the wire's standing (0x005d05b0), not the delta alone.
    const standing = frameXmlReputationBase(world, factionMetadata.reputationCatalog, state.listId) + state.standing;
    const [standingId, barMin, barMax] = standingBounds(standing);
    rows.push({
      listId: state.listId,
      name,
      description: "",
      standingId,
      barMin,
      barMax,
      barValue: Math.max(barMin, Math.min(barMax, standing)),
      // PEACE_FORCED blocks ordinary war changes; RIVAL is the stock exception.
      canToggleAtWar: (flags & FRAMEXML_FACTION_FLAGS.peaceForced) === 0
        || (flags & FRAMEXML_FACTION_FLAGS.rival) !== 0,
      isHeader: false,
      isChild: false,
      hasRep: true,
      atWarWith: (flags & FRAMEXML_FACTION_FLAGS.atWar) !== 0,
      isInactive: (flags & FRAMEXML_FACTION_FLAGS.inactive) !== 0,
    });
  }
  return rows.sort((left, right) => left.listId - right.listId);
}
