/**
 * 3.24 (12.10): the world-PvP (Wintergrasp) queue behind the stock queue eye — GetWorldPVPQueueStatus, the
 * three BattlefieldMgr answers, CanHearthAndResurrectFromArea/HearthAndResurrectFromArea and the
 * BATTLEFIELD_MGR_* events BattlefieldFrame_OnEvent turns into the BFMGR_* StaticPopups and the
 * MiniMapBattlefieldDropDown rows (BattlefieldFrame.lua:60-122, 323-341, 695-772; StaticPopup.lua:521-624).
 *
 * Wow.exe (read-only Ghidra, `.runtime/re-2026-10-11/glue-1110/bf324-*.txt`):
 *   GetWorldPVPQueueStatus(1) (0x0054c8a0) — status by 0x00bea4b0 (0 none, 1 queued, 2 confirm, 3 active),
 *     the zone's AreaTable name (0x00bea4ac), the battle id (0x00bea4a8) and, for «confirm», the seconds
 *     left; any other index answers nothing. The packet handlers (0x0054e720's table) set it: a queue
 *     answer (0x0054b680) to queued/none by its first byte, an entry invitation (0x0054b610) to confirm
 *     with its zone and deadline, the entry (0x005498c0) and most ejections (0x005499c0) back to none.
 *   BattlefieldMgrQueueInviteResponse/EntryInviteResponse/ExitRequest (0x0054e1c0/0x0054e160/0x0054e200)
 *     send CMSG_BATTLEFIELD_MGR_QUEUE_INVITE_RESPONSE/ENTRY_INVITE_RESPONSE/EXIT_REQUEST with the given id.
 *   CanHearthAndResurrectFromArea (0x0054c810): the current area's AreaTable flag 0x08000000;
 *     HearthAndResurrectFromArea (0x0054c7a0): CMSG_HEARTH_AND_RESURRECT.
 *   The events (0x0081b530): QUEUE_INVITE 0x289 (id, warmup = byte == 1), QUEUE_REQUEST_RESPONSE 0x286
 *     (id, accepted, warmup = third byte == 1, inArea = the player's area or its parent is the zone,
 *     loggingIn = second byte), ENTRY_INVITE 0x284 (id), ENTERED 0x285 (id, two bytes), EJECTED 0x288 (id,
 *     playerExited = reason 8, relocated, battleActive = status 2, lowLevel = reason 10). TrinityCore 3.3.5
 *     never sends EJECT_PENDING or STATE_CHANGE (Opcodes.cpp:1384, 1387: STATUS_NEVER).
 *
 * The status reads the world's own fields (WorldClient: the war invitation, the queued battle) rather than
 * a second state machine: the world clears the queue optimistically on an exit request (5.21 — the core
 * never acknowledges it), and the eye follows the same answer.
 */
import type { BattlefieldMgrEdge, BattlefieldWarInvite } from "../../world/BattlefieldProtocol.js";

/** AreaTable flag «can hearth and resurrect from area» (TrinityCore AREA_FLAG_WINTERGRASP_2). */
const AREA_FLAG_HEARTH_AND_RESURRECT = 0x08000000;

/** The world fields and commands the model reads and drives (WorldClient's). */
export interface FrameXmlWorldPvpWorld {
  readonly battlefieldQueuedId: number;
  /** The zone of the queue answer that queued the player, when the world kept it. */
  readonly battlefieldQueuedZoneId?: number;
  readonly battlefieldWarInvite: BattlefieldWarInvite | undefined;
  answerBattlefieldQueueInvite(battleId: number, accept: boolean): void;
  answerBattlefieldWarInvite(battleId: number, accept: boolean): void;
  leaveBattlefieldQueue(battleId: number): void;
  /** CMSG_HEARTH_AND_RESURRECT (WorldClient sends it while a battle is on). */
  leaveBattlefield?(): void;
  /** Server unix seconds now, when the world knows the server's clock. */
  currentServerTime?(now?: number): number | undefined;
}

export interface FrameXmlWorldPvpArea {
  readonly name: string;
  readonly parentId: number;
  readonly flags?: number | undefined;
}

export interface FrameXmlWorldPvpSource {
  world(): FrameXmlWorldPvpWorld | undefined;
  /** AreaTable rows by id. */
  area(id: number): FrameXmlWorldPvpArea | undefined;
  /** The player's current area (sub-zone where known), 0 when unknown. */
  currentAreaId(): number;
}

/** One BATTLEFIELD_MGR_* event, as Wow.exe raises it for a packet edge. */
export type FrameXmlWorldPvpEvent = readonly [event: string, ...args: unknown[]];

export class FrameXmlWorldPvpModel {
  readonly #source: FrameXmlWorldPvpSource;

  constructor(source: FrameXmlWorldPvpSource) {
    this.#source = source;
  }

  /** GetWorldPVPQueueStatus(index) (0x0054c8a0). */
  queueStatus(index: number): readonly unknown[] {
    if (index !== 1) return [];
    const world = this.#source.world();
    const invite = world?.battlefieldWarInvite;
    if (world && invite) {
      const now = world.currentServerTime?.();
      return ["confirm", this.#zoneName(invite.zoneId), invite.battleId, now === undefined ? 0 : Math.max(0, invite.expiresAt - now)];
    }
    if (world && world.battlefieldQueuedId !== 0) {
      return ["queued", this.#zoneName(world.battlefieldQueuedZoneId ?? 0), world.battlefieldQueuedId, 0];
    }
    return ["none", undefined, 0, 0];
  }

  /**
   * The zone's name; "" for an unknown zone, where Wow.exe would push nil into stock's unguarded
   * `format(BATTLEFIELD_IN_QUEUE_SIMPLE, mapName)` (BattlefieldFrame.lua:330).
   */
  #zoneName(zoneId: number): string {
    return this.#source.area(zoneId)?.name ?? "";
  }

  /** CanHearthAndResurrectFromArea (0x0054c810). */
  canHearthAndResurrect(): boolean {
    const area = this.#source.area(this.#source.currentAreaId());
    return ((area?.flags ?? 0) & AREA_FLAG_HEARTH_AND_RESURRECT) !== 0;
  }

  hearthAndResurrect(): void {
    this.#source.world()?.leaveBattlefield?.();
  }

  queueInviteResponse(battleId: number, accept: boolean): void {
    this.#source.world()?.answerBattlefieldQueueInvite(battleId, accept);
  }

  entryInviteResponse(battleId: number, accept: boolean): void {
    this.#source.world()?.answerBattlefieldWarInvite(battleId, accept);
  }

  exitRequest(battleId: number): void {
    this.#source.world()?.leaveBattlefieldQueue(battleId);
  }

  /** The event Wow.exe raises for one SMSG_BATTLEFIELD_MGR_* packet, with its arguments. */
  edgeEvent(battleId: number, edge: BattlefieldMgrEdge): FrameXmlWorldPvpEvent {
    switch (edge.kind) {
      case "queueInvite": return ["BATTLEFIELD_MGR_QUEUE_INVITE", battleId, edge.warmup];
      case "queueResponse": {
        const areaId = this.#source.currentAreaId();
        const inArea = areaId !== 0 && (areaId === edge.zoneId || this.#source.area(areaId)?.parentId === edge.zoneId);
        return ["BATTLEFIELD_MGR_QUEUE_REQUEST_RESPONSE", battleId, edge.queued, edge.warmup, inArea, edge.loggingIn];
      }
      case "entryInvite": return ["BATTLEFIELD_MGR_ENTRY_INVITE", battleId];
      case "entered": return ["BATTLEFIELD_MGR_ENTERED", battleId, edge.flag1, edge.flag2];
      case "ejected": return ["BATTLEFIELD_MGR_EJECTED", battleId, edge.reason === 8, edge.relocated,
        edge.battleStatus === 2, edge.reason === 10];
    }
  }
}

export interface FrameXmlWorldPvpHost {
  readonly worldPvp?: FrameXmlWorldPvpModel | undefined;
}

function integerOf(value: unknown): number {
  // Wow.exe takes the Lua number through 0x0088b9c0 (float to int).
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function truthy(value: unknown): boolean {
  // 0x00815500 reads a number by its value and anything else by its Lua truth: stock passes 1 and 0 for
  // yes and no (StaticPopup.lua:547-585, BattlefieldFrame.lua:744-751).
  return value !== undefined && value !== null && value !== false && value !== 0;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_WORLD_PVP_BINDINGS: Readonly<Record<string,
  (host: FrameXmlWorldPvpHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetWorldPVPQueueStatus: (host, args) => host.worldPvp ? host.worldPvp.queueStatus(integerOf(args[0])) : ["none"],
  CanHearthAndResurrectFromArea: (host) => [host.worldPvp?.canHearthAndResurrect() === true ? 1 : undefined],
  HearthAndResurrectFromArea: (host) => { host.worldPvp?.hearthAndResurrect(); return NOTHING; },
  BattlefieldMgrQueueInviteResponse: (host, args) => {
    host.worldPvp?.queueInviteResponse(integerOf(args[0]), truthy(args[1]));
    return NOTHING;
  },
  BattlefieldMgrEntryInviteResponse: (host, args) => {
    host.worldPvp?.entryInviteResponse(integerOf(args[0]), truthy(args[1]));
    return NOTHING;
  },
  BattlefieldMgrExitRequest: (host, args) => {
    host.worldPvp?.exitRequest(integerOf(args[0]));
    return NOTHING;
  },
});
