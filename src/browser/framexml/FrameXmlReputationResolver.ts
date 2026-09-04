import type { FactionClient } from "../FactionClient.js";
import type { WorldClient } from "../../world/WorldClient.js";
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
}

export type FrameXmlReputationMetadata = Pick<FactionClient, "ready" | "name">;

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
    const standing = state.standing;
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
