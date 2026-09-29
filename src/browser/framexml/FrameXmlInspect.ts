/**
 * The stock InspectFrame's C API (Blizzard_InspectUI: InspectPaperDollFrame, InspectPVPFrame,
 * InspectTalentFrame) over the three inspection packets this client already speaks:
 *
 * * `NotifyInspect(unit)` sends `CMSG_INSPECT`; `SMSG_INSPECT_TALENT` answers with the talents (when
 *   the realm shows them) and every equipped item's entry and enchantments (InspectProtocol.ts). The
 *   paper doll reads them through `GetInventoryItemTexture/Link/Count(unit, slot)` for the inspected
 *   unit; before the answer, the public `PLAYER_VISIBLE_ITEM_*` fields give the entries and the
 *   permanent enchantments. INSPECT_TALENT_READY and UNIT_INVENTORY_CHANGED(unit) follow the answer.
 * * The talent tab calls the player's talent API with `inspect = true`; those calls answer from a
 *   snapshot of the inspected class's trees and the packet's ranks (FrameXmlTalentResolver.ts).
 * * `RequestInspectHonorData()` sends `MSG_INSPECT_HONOR_STATS` and `MSG_INSPECT_ARENA_TEAMS`; their
 *   answers (and each team's `CMSG_ARENA_TEAM_QUERY` tabard) raise INSPECT_HONOR_UPDATE. Every
 *   NotifyInspect forgets the last answer, as the client does, so the PvP tab asks again.
 *
 * The inventory and talent readers are the player's own C API names, so FRAMEXML_INSPECT_PRELUDE
 * wraps them: a non-player unit that is the one being inspected, or an `inspect` argument, is answered
 * here, and everything else still reaches the seam's own binding.
 */
import type { FrameXmlTalentSnapshot } from "./FrameXmlTalentResolver.js";

/**
 * `CheckInteractDistance` indices: 1 inspect at 28 yards (`INSPECT_DISTANCE`, ObjectDefines.h), 2
 * trade at 11.11 (`TRADE_DISTANCE`), 3 duel at 9.9 — the client's own table. Index 4 (follow, 28
 * yards in the client) is left out: this client has no follow, `FollowUnit` is an unbound no-op, and
 * UnitPopup_OnUpdate enables its «Следовать» exactly when index 4 answers true (UnitPopup.lua:1041).
 */
export const FRAMEXML_INTERACT_DISTANCES: Readonly<Record<number, number>> = Object.freeze({ 1: 28, 2: 11.11, 3: 9.9 });

/** Classes whose ranged slot is a relic (`UnitHasRelicSlot`): paladin, shaman, death knight, druid. */
const RELIC_CLASSES: ReadonlySet<number> = new Set([2, 6, 7, 11]);

/** One equipped item of the inspected player, by `GetInventoryItem*`'s one-based slot. */
export interface FrameXmlInspectItem {
  readonly entry: number;
  /** Enchantment ids by slot, 0 permanent … (the inspection packet's twelve, or the visible pair). */
  readonly enchantments: readonly number[];
  readonly randomPropertyId: number;
  readonly suffixFactor: number;
}

export interface FrameXmlInspectHonor {
  readonly todayKills: number;
  readonly todayHonor: number;
  readonly yesterdayKills: number;
  readonly yesterdayHonor: number;
  readonly lifetimeKills: number;
}

/** One of the inspected player's arena teams, joined with its tabard once the team query answered. */
export interface FrameXmlInspectArenaTeam {
  readonly slot: number;
  readonly name: string | undefined;
  readonly size: number | undefined;
  readonly rating: number;
  readonly played: number;
  readonly wins: number;
  readonly playerPlayed: number;
  readonly playerRating: number;
  /** ARGB words as the team query carries them; -1 style when unknown. */
  readonly backgroundColor: number;
  readonly emblemStyle: number;
  readonly emblemColor: number;
  readonly borderStyle: number;
  readonly borderColor: number;
}

export interface FrameXmlInspectHost {
  /** The GUID a unit token names now (target, focus, partyN, mouseover, player). */
  unitGuid(unit: string): bigint | undefined;
  /** Whether that unit is a player this one may inspect: not attackable, in the world. */
  inspectable(unit: string): boolean;
  /** 2D distance in yards from the player, when both positions are known. */
  distance(unit: string): number | undefined;
  classId(guid: bigint): number | undefined;
  /** `CMSG_INSPECT`. */
  requestInspect(guid: bigint): void;
  /** `MSG_INSPECT_HONOR_STATS` and `MSG_INSPECT_ARENA_TEAMS`. */
  requestHonor(guid: bigint): void;
  /** Whether `SMSG_INSPECT_TALENT` has answered for this player. */
  inspected(guid: bigint): boolean;
  item(guid: bigint, slot: number): FrameXmlInspectItem | undefined;
  itemTexture(entry: number): string | undefined;
  itemLink(item: FrameXmlInspectItem): string | undefined;
  talents(guid: bigint): FrameXmlTalentSnapshot | undefined;
  honor(guid: bigint): FrameXmlInspectHonor | undefined;
  arenaTeams(guid: bigint): readonly FrameXmlInspectArenaTeam[];
  /** Ask for the equipped items' templates/metadata outside a read; `onChanged` when they land. */
  prefetch?(guid: bigint, onChanged: () => void): void;
  /**
   * Ask for the names and icons of the inspected class's talents (the player's own class is the only
   * one named in advance) outside a read; `onChanged` when they land.
   */
  prefetchTalents?(guid: bigint, onChanged: () => void): void;
  /** Subscribe to the inspection answers; returns the unsubscribe. */
  subscribe?(model: FrameXmlInspectModel): () => void;
}

interface InspectPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

interface Inspection {
  readonly guid: bigint;
  /** The token NotifyInspect was given; UNIT_INVENTORY_CHANGED carries it back. */
  readonly unit: string;
}

const NOTHING: readonly [] = Object.freeze([]);

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function index(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function unitOf(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function rgb(color: number): readonly [number, number, number] {
  return [((color >>> 16) & 0xff) / 255, ((color >>> 8) & 0xff) / 255, (color & 0xff) / 255];
}

/** One owner of the inspection C API and of INSPECT_TALENT_READY/INSPECT_HONOR_UPDATE. */
export class FrameXmlInspectModel {
  readonly #host: FrameXmlInspectHost;
  #pump: InspectPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #inspection: Inspection | undefined;
  /**
   * Honor has answered since the last NotifyInspect/ClearInspectPlayer, which reset the client's
   * inspect honor data: the world keeps every answer by GUID, so a player inspected again would
   * otherwise keep the first answer and never be asked again (InspectPVPFrame_OnShow).
   */
  #honorFresh = false;
  /** The VM's GlobalStrings, for UI_ERROR_MESSAGE wording; bound by the owner. */
  globalString: ((name: string) => string | undefined) | undefined;

  constructor(host: FrameXmlInspectHost) {
    this.#host = host;
  }

  attach(pump: InspectPump): void {
    this.detach();
    this.#pump = pump;
    this.#unsubscribe = this.#host.subscribe?.(this);
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#inspection = undefined;
    this.#honorFresh = false;
  }

  /** The player being inspected, for tests and the owner. */
  get inspectedGuid(): bigint | undefined { return this.#inspection?.guid; }

  canInspect(unit: string, showError: boolean): boolean {
    const allowed = this.#host.unitGuid(unit) !== undefined && this.#host.inspectable(unit);
    if (!allowed && showError) {
      this.#pump?.fire("UI_ERROR_MESSAGE", this.globalString?.("ERR_INVALID_INSPECT_TARGET") ?? "Нельзя осмотреть эту цель.");
    }
    return allowed;
  }

  notify(unit: string): void {
    const guid = this.#host.unitGuid(unit);
    if (guid === undefined || !this.#host.inspectable(unit)) return;
    this.#inspection = { guid, unit };
    this.#honorFresh = false;
    this.#host.requestInspect(guid);
    this.#host.prefetch?.(guid, () => this.#itemsChanged(guid));
    this.#host.prefetchTalents?.(guid, () => this.#talentsChanged(guid));
  }

  clear(): void {
    this.#inspection = undefined;
    this.#honorFresh = false;
  }

  checkInteractDistance(unit: string, which: number): boolean {
    const range = FRAMEXML_INTERACT_DISTANCES[which];
    const distance = range === undefined ? undefined : this.#host.distance(unit);
    return distance !== undefined && distance <= range!;
  }

  /** `GetInventoryItem*` for the inspected unit: undefined when `unit` is not the one inspected. */
  inventoryItem(unit: string, slot: number): readonly [texture: string | undefined, link: string | undefined, count: number] | undefined {
    const guid = this.#inspectedAs(unit);
    if (guid === undefined) return undefined;
    const item = slot >= 1 && slot <= 19 ? this.#host.item(guid, slot) : undefined;
    return item ? [this.#host.itemTexture(item.entry), this.#host.itemLink(item), 1] : [undefined, undefined, 0];
  }

  /** `UnitHasRelicSlot` for the inspected unit: undefined when `unit` is not the one inspected. */
  hasRelicSlot(unit: string): boolean | undefined {
    const guid = this.#inspectedAs(unit);
    if (guid === undefined) return undefined;
    return RELIC_CLASSES.has(this.#host.classId(guid) ?? 0);
  }

  hasHonorData(): boolean {
    const guid = this.#inspection?.guid;
    return this.#honorFresh && guid !== undefined && this.#host.honor(guid) !== undefined;
  }

  requestHonor(): void {
    const guid = this.#inspection?.guid;
    if (guid !== undefined) this.#host.requestHonor(guid);
  }

  /** `GetInspectHonorData`: today's kills and honor, yesterday's, lifetime kills and the rank (none in 3.3.5). */
  honorData(): readonly unknown[] {
    const guid = this.#inspection?.guid;
    const honor = guid === undefined || !this.#honorFresh ? undefined : this.#host.honor(guid);
    return honor
      ? [honor.todayKills, honor.todayHonor, honor.yesterdayKills, honor.yesterdayHonor, honor.lifetimeKills, 0]
      : [0, 0, 0, 0, 0, 0];
  }

  /** `GetInspectArenaTeamData(i)`, the stock PVP_TEAM layout (InspectPVPFrame.lua:84). */
  arenaTeamData(which: number): readonly unknown[] {
    const guid = this.#inspection?.guid;
    const team = guid === undefined || !this.#honorFresh ? undefined
      : this.#host.arenaTeams(guid).find((row) => row.slot === which - 1);
    if (!team || team.name === undefined || team.size === undefined) return NOTHING;
    return [
      team.name, team.size, team.rating, team.played, team.wins, team.playerPlayed, team.playerRating,
      ...rgb(team.backgroundColor), team.emblemStyle, ...rgb(team.emblemColor), team.borderStyle, ...rgb(team.borderColor),
    ];
  }

  /** The player talent API asked with `inspect = true`, answered from the inspected trees. */
  talentApi(name: string, args: readonly unknown[]): readonly unknown[] {
    const guid = this.#inspection?.guid;
    const snapshot = guid === undefined ? undefined : this.#host.talents(guid);
    const groupOf = (value: unknown): number => {
      const group = index(value);
      return group > 0 ? group : snapshot?.activeTalentGroup ?? 1;
    };
    const group = (value: unknown) => snapshot?.groups[groupOf(value) - 1];
    switch (name) {
      case "GetActiveTalentGroup": return [snapshot?.activeTalentGroup ?? 1];
      case "GetNumTalentGroups": return [snapshot?.numTalentGroups ?? 0];
      case "GetNumTalentTabs": return [group(args[2])?.tabs.length ?? 0];
      case "GetUnspentTalentPoints": return [group(args[2])?.unspentPoints ?? 0];
      case "GetTalentTabInfo": {
        const tab = group(args[3])?.tabs[index(args[0]) - 1];
        return tab ? [tab.name, tab.iconTexture, tab.pointsSpent, tab.background, 0] : NOTHING;
      }
      case "GetNumTalents": return [group(args[3])?.tabs[index(args[0]) - 1]?.talents.length ?? 0];
      case "GetTalentInfo": {
        const cell = group(args[4])?.tabs[index(args[0]) - 1]?.talents[index(args[1]) - 1];
        return cell ? [cell.name, cell.iconTexture, cell.tier, cell.column, cell.rank, cell.maxRank,
          cell.isExceptional, cell.meetsPrereq, cell.previewRank, cell.meetsPreviewPrereq] : NOTHING;
      }
      case "GetTalentPrereqs": {
        const cell = group(args[4])?.tabs[index(args[0]) - 1]?.talents[index(args[1]) - 1];
        if (!cell) return NOTHING;
        const values: unknown[] = [];
        for (const prerequisite of cell.prerequisites) {
          values.push(prerequisite.tier, prerequisite.column, prerequisite.meetsPrereq, prerequisite.meetsPreviewPrereq);
        }
        return values;
      }
      default: return NOTHING;
    }
  }

  // ---- the answers ----------------------------------------------------------------------------

  /** `SMSG_INSPECT_TALENT` for a player: the talent tab and the paper doll repaint. */
  talentsReady(guid: bigint): void {
    if (this.#inspection?.guid !== guid) return;
    // The answer can name items the visible fields did not (rings, trinkets): their names and icons.
    this.#host.prefetch?.(guid, () => this.#itemsChanged(guid));
    // … and its class's talents, when NotifyInspect could not ask yet (metadata or class still unknown).
    this.#host.prefetchTalents?.(guid, () => this.#talentsChanged(guid));
    this.#pump?.fire("INSPECT_TALENT_READY");
    this.#itemsChanged(guid);
  }

  /**
   * Honor or arena teams for the inspected player arrived (`guid`), or an arena team's name and
   * tabard did (`undefined`: a repaint, not an answer to RequestInspectHonorData).
   */
  honorReady(guid: bigint | undefined): void {
    if (this.#inspection === undefined || (guid !== undefined && this.#inspection.guid !== guid)) return;
    if (guid !== undefined) this.#honorFresh = true;
    this.#pump?.fire("INSPECT_HONOR_UPDATE");
  }

  /** The inspected class's talent names landed: the talent tab repaints (InspectTalentFrame_OnEvent). */
  #talentsChanged(guid: bigint): void {
    if (this.#inspection?.guid === guid && this.#host.inspected(guid)) this.#pump?.fire("INSPECT_TALENT_READY");
  }

  #itemsChanged(guid: bigint): void {
    const inspection = this.#inspection;
    if (inspection?.guid === guid) this.#pump?.fire("UNIT_INVENTORY_CHANGED", inspection.unit);
  }

  #inspectedAs(unit: string): bigint | undefined {
    const inspection = this.#inspection;
    if (!inspection || unit === "player" || unit === "") return undefined;
    return this.#host.unitGuid(unit) === inspection.guid ? inspection.guid : undefined;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlInspectSeam {
  readonly inspect?: FrameXmlInspectModel | undefined;
}

export type FrameXmlInspectBinding = (host: FrameXmlInspectSeam, args: readonly unknown[]) => readonly unknown[];

const withInspect = (answer: (inspect: FrameXmlInspectModel, args: readonly unknown[]) => readonly unknown[],
  fallback: readonly unknown[] = NOTHING): FrameXmlInspectBinding =>
  (host, args) => host.inspect ? answer(host.inspect, args) : fallback;

/**
 * The flat C API. The three `WebClientInspect*` names are the prelude's routes (not client APIs):
 * the stock readers they stand behind keep their own bindings for every other unit.
 */
export const FRAMEXML_INSPECT_BINDINGS: Readonly<Record<string, FrameXmlInspectBinding>> = Object.freeze({
  CanInspect: withInspect((inspect, args) => [inspect.canInspect(unitOf(args[0]), truthy(args[1]))], [false]),
  NotifyInspect: withInspect((inspect, args) => { inspect.notify(unitOf(args[0])); return NOTHING; }),
  ClearInspectPlayer: withInspect((inspect) => { inspect.clear(); return NOTHING; }),
  CheckInteractDistance: withInspect((inspect, args) => [inspect.checkInteractDistance(unitOf(args[0]), index(args[1]))], [false]),
  HasInspectHonorData: withInspect((inspect) => [inspect.hasHonorData()], [false]),
  RequestInspectHonorData: withInspect((inspect) => { inspect.requestHonor(); return NOTHING; }),
  GetInspectHonorData: withInspect((inspect) => inspect.honorData(), [0, 0, 0, 0, 0, 0]),
  GetInspectArenaTeamData: withInspect((inspect, args) => inspect.arenaTeamData(index(args[0]))),
  WebClientInspectItem: withInspect((inspect, args) => {
    const item = inspect.inventoryItem(unitOf(args[0]), index(args[1]));
    return item ? [true, ...item] : [false];
  }, [false]),
  WebClientInspectRelic: withInspect((inspect, args) => {
    const relic = inspect.hasRelicSlot(unitOf(args[0]));
    return relic === undefined ? [false] : [true, relic];
  }, [false]),
  WebClientInspectTalent: withInspect((inspect, args) => inspect.talentApi(String(args[0]), args.slice(1))),
});

/**
 * Route the player's own readers here for the inspected unit or an `inspect` argument. Installed
 * before the corpus runs (the seam prelude), so every later lookup of these names sees the wrapper;
 * `"player"` short-cuts to the seam's binding without a host call.
 */
export const FRAMEXML_INSPECT_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local item = rawget(_G, "__fxSeam_WebClientInspectItem")
  local relic = rawget(_G, "__fxSeam_WebClientInspectRelic")
  local talent = rawget(_G, "__fxSeam_WebClientInspectTalent")
  if impl ~= nil and item ~= nil then
    local function wrap(name, pick)
      local base = impl[name]
      impl[name] = function(unit, slot, ...)
        if unit ~= nil and unit ~= "player" then
          local handled, texture, link, count = item(unit, slot)
          if handled then return pick(texture, link, count) end
        end
        if base ~= nil then return base(unit, slot, ...) end
      end
    end
    wrap("GetInventoryItemTexture", function(texture) return texture end)
    wrap("GetInventoryItemLink", function(_, link) return link end)
    wrap("GetInventoryItemCount", function(_, _, count) return count end)
  end
  if impl ~= nil and relic ~= nil then
    local base = impl.UnitHasRelicSlot
    impl.UnitHasRelicSlot = function(unit, ...)
      if unit ~= nil and unit ~= "player" then
        local handled, has = relic(unit)
        if handled then return has end
      end
      if base ~= nil then return base(unit, ...) end
    end
  end
  if impl ~= nil and talent ~= nil then
    local select = select
    local function wrap(name, position)
      local base = impl[name]
      impl[name] = function(...)
        if select(position, ...) then return talent(name, ...) end
        if base ~= nil then return base(...) end
      end
    end
    wrap("GetActiveTalentGroup", 1)
    wrap("GetNumTalentGroups", 1)
    wrap("GetNumTalentTabs", 1)
    wrap("GetUnspentTalentPoints", 1)
    wrap("GetTalentTabInfo", 2)
    wrap("GetNumTalents", 2)
    wrap("GetTalentInfo", 3)
    wrap("GetTalentPrereqs", 3)
  end
end
`;
