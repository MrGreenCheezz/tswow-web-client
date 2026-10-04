/**
 * The live inspection model's host: LiveWorldSeam's unit resolution, `WorldClient.inspections`
 * (`SMSG_INSPECT_TALENT`), the public visible-item fields, the honor and arena inspection maps, and
 * the talent trees the player's own talent frame reads. Reads never start a fetch; the request
 * handlers and `prefetch` ask for templates, metadata and arena tabards outside a C-API read.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { InspectResult } from "../../world/InspectProtocol.js";
import { readField, unit as unitField } from "../../world/Fields.js";
import { FrameXmlInspectModel, type FrameXmlInspectItem } from "./FrameXmlInspect.js";
import { followUnit } from "../input/FollowCommand.js";
import { resolveFrameXmlTalentSnapshot, type FrameXmlTalentMetadata, type FrameXmlTalentSnapshot } from "./FrameXmlTalentResolver.js";
import { frameXmlSocketItemLink } from "./FrameXmlSocketLive.js";
import type { FrameXmlQuestItemMetadata } from "./FrameXmlWorldSeam.js";

/** `TYPEID_PLAYER` (ObjectGuid.h). */
const TYPEID_PLAYER = 4;

export interface LiveFrameXmlInspectHost {
  world(): WorldClient | undefined;
  /** The object a unit token names while it is in this world. */
  unitObject(unit: string): WorldObjectState | undefined;
  /** `UnitCanAttack("player", unit)`: TrinityCore refuses to inspect a valid attack target. */
  canAttack(unit: string): boolean;
  itemInfo?(entry: number): FrameXmlQuestItemMetadata | undefined;
  itemTexture?(entry: number): string | undefined;
  prefetchItems?(itemIds: readonly number[], spellIds: readonly number[], onChanged: () => void): void;
  talentMetadata?(): FrameXmlTalentMetadata | undefined;
}

/** The entry and the permanent/temporary enchantment pair in `PLAYER_VISIBLE_ITEM_<slot>_*`. */
function visibleItem(object: WorldObjectState, slot: number): FrameXmlInspectItem | undefined {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  const entry = object.fields.get(first + (slot - 1) * stride) ?? 0;
  if (entry <= 0) return undefined;
  const word = object.fields.get(first + (slot - 1) * stride + 1) ?? 0;
  return { entry, enchantments: [word & 0xffff, (word >>> 16) & 0xffff], randomPropertyId: 0, suffixFactor: 0 };
}

export function createLiveFrameXmlInspect(host: LiveFrameXmlInspectHost): FrameXmlInspectModel {
  const object = (guid: bigint): WorldObjectState | undefined => {
    const world = host.world();
    return world && typeof world.state.objects?.get === "function" ? world.state.objects.get(guid) : undefined;
  };
  const template = (entry: number) => {
    const world = host.world();
    const found = world && world.itemTemplates instanceof Map ? world.itemTemplates.get(entry) : undefined;
    return found?.found === true ? found : undefined;
  };
  const inspection = (guid: bigint): InspectResult | undefined => {
    const world = host.world();
    return world?.inspections instanceof Map ? world.inspections.get(guid) : undefined;
  };
  const item = (guid: bigint, slot: number): FrameXmlInspectItem | undefined => {
    const answered = inspection(guid);
    if (answered) {
      const row = answered.items.find((candidate) => candidate.slot === slot - 1);
      return row ? { entry: row.entry, enchantments: row.enchantments, randomPropertyId: row.randomPropertyId, suffixFactor: row.suffixFactor } : undefined;
    }
    const player = object(guid);
    return player ? visibleItem(player, slot) : undefined;
  };
  // TalentFrame_Update reads every cell of a tab per redraw: resolve once per answer and metadata.
  let cachedResult: InspectResult | undefined;
  let cachedMetadata: FrameXmlTalentMetadata | undefined;
  let cachedRevision = -1;
  let cachedSnapshot: FrameXmlTalentSnapshot | undefined;
  const talents = (guid: bigint): FrameXmlTalentSnapshot | undefined => {
    const answered = inspection(guid);
    const metadata = host.talentMetadata?.();
    if (!answered || answered.talents.specs.length === 0) return undefined;
    if (answered !== cachedResult || metadata !== cachedMetadata || (metadata?.revision ?? -1) !== cachedRevision) {
      cachedResult = answered;
      cachedMetadata = metadata;
      cachedRevision = metadata?.revision ?? -1;
      cachedSnapshot = resolveFrameXmlTalentSnapshot(object(guid), answered.talents, metadata);
    }
    return cachedSnapshot;
  };
  const entries = (guid: bigint): number[] => {
    const found: number[] = [];
    for (let slot = 1; slot <= 19; slot += 1) {
      const row = item(guid, slot);
      if (row) found.push(row.entry);
    }
    return found;
  };
  const viewerLevel = (): number => {
    const world = host.world();
    const self = world?.state.selfGuid === undefined ? undefined : object(world.state.selfGuid);
    return self ? readField(self, "UNIT_FIELD_LEVEL") ?? 0 : 0;
  };
  return new FrameXmlInspectModel({
    unitGuid: (unit) => host.unitObject(unit)?.guid,
    inspectable: (unit) => {
      const target = host.unitObject(unit);
      return target?.typeId === TYPEID_PLAYER && !host.canAttack(unit);
    },
    distance: (unit) => {
      const world = host.world();
      const self = world?.state.selfGuid === undefined ? undefined : object(world.state.selfGuid);
      const target = host.unitObject(unit);
      const from = self?.position;
      const to = target === self ? from : target?.position;
      return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : undefined;
    },
    classId: (guid) => {
      const player = object(guid);
      return player ? unitField.classId(player) : undefined;
    },
    requestInspect: (guid) => host.world()?.inspect(guid),
    // 5.18: FollowUnit, by the stock unit tokens or a player's name (input/FollowCommand.ts).
    follow: (unit) => {
      const world = host.world();
      return world ? followUnit(world, unit, (token) => host.unitObject(token)) : "ERR_GENERIC_NO_TARGET";
    },
    requestHonor: (guid) => {
      const world = host.world();
      // A fresh request replaces the last answer: the arena list is merged by slot as its packets
      // arrive, so a team the player has left since would otherwise stay. Nothing else reads the two.
      world?.inspectedHonor.delete(guid);
      world?.inspectedArenaTeams.delete(guid);
      world?.inspectHonor(guid);
      world?.inspectArenaTeams(guid);
    },
    inspected: (guid) => inspection(guid) !== undefined,
    item,
    itemTexture: (entry) => host.itemTexture?.(entry),
    itemLink: (row) => frameXmlSocketItemLink(row.entry, host.itemInfo?.(row.entry)?.name || template(row.entry)?.name,
      template(row.entry)?.quality ?? host.itemInfo?.(row.entry)?.quality, row.enchantments,
      row.randomPropertyId, row.suffixFactor, viewerLevel()),
    talents,
    honor: (guid) => {
      const stats = host.world()?.inspectedHonor.get(guid);
      // PLAYER_FIELD_KILLS holds today's kills in its low half and yesterday's in its high half.
      return stats ? {
        todayKills: stats.kills & 0xffff, todayHonor: stats.todayHonor,
        yesterdayKills: (stats.kills >>> 16) & 0xffff, yesterdayHonor: stats.yesterdayHonor,
        lifetimeKills: stats.lifetimeKills,
      } : undefined;
    },
    arenaTeams: (guid) => {
      const world = host.world();
      return (world?.inspectedArenaTeams.get(guid) ?? []).map((team) => {
        const info = world?.arenaTeams.get(team.teamId);
        return {
          slot: team.slot, name: info?.name, size: info?.type, rating: team.teamRating, played: team.seasonGames,
          wins: team.seasonWins, playerPlayed: team.memberSeasonGames, playerRating: team.personalRating,
          backgroundColor: info?.backgroundColor ?? 0, emblemStyle: info?.emblemStyle ?? -1,
          emblemColor: info?.emblemColor ?? 0, borderStyle: info?.borderStyle ?? -1, borderColor: info?.borderColor ?? 0,
        };
      });
    },
    prefetch: (guid, onChanged) => {
      const found = entries(guid);
      const world = host.world();
      for (const entry of found) world?.itemTemplate?.(entry);
      host.prefetchItems?.(found, [], onChanged);
    },
    prefetchTalents: (guid, onChanged) => {
      // Talent rows carry no name or icon: the metadata takes both from the spell cache, which the
      // mount fills for the player's own class only (FrameXmlWorldMount.ts ensureTalentSpellNames).
      // Another class is named by each talent's first-rank spell, the one the metadata reads for a
      // talent the player has not learned. Already-cached ids cost nothing (ensureSpellNames).
      const player = object(guid);
      const classId = player ? unitField.classId(player) ?? 0 : 0;
      const metadata = host.talentMetadata?.();
      if (classId <= 0 || !metadata?.ready) return;
      const spellIds: number[] = [];
      for (const tab of metadata.tabsForClass(classId)) {
        for (const talent of metadata.talentsIn(tab.id)) {
          const first = talent.ranks[0] ?? 0;
          if (first > 0) spellIds.push(first);
        }
      }
      if (spellIds.length > 0) host.prefetchItems?.([], spellIds, onChanged);
    },
    subscribe: (model) => {
      const world = host.world();
      const events = world?.events;
      if (!world || !events || typeof events.on !== "function") return () => {};
      const off = [
        events.on("INSPECT_TALENT_READY", ({ guid }) => model.talentsReady(guid)),
        events.on("PVP_INSPECTION", ({ guid }) => {
          // A team named only by id: its name, size and tabard come from the team query.
          for (const team of world.inspectedArenaTeams.get(guid) ?? []) {
            if (!world.arenaTeams.has(team.teamId)) world.requestArenaTeam(team.teamId);
          }
          model.honorReady(guid);
        }),
        events.on("ARENA_TEAM_CHANGED", () => model.honorReady(undefined)),
      ];
      return () => { for (const unsubscribe of off) unsubscribe(); };
    },
  });
}
