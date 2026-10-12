/**
 * 3.24 (12.10): the canned seam's queues for the stock queue eye (`?battlemaster=queue`, tests): the two
 * battleground queue slots GetBattlefieldStatus reads and a Wintergrasp world that records every
 * BattlefieldMgr answer instead of sending it. The zone row is Lake Wintergrasp's (AreaTable 4197, flag
 * 0x08000000 «can hearth and resurrect»), in the client's ruRU wording.
 */
import type { BattlefieldWarInvite } from "../../world/BattlefieldProtocol.js";
import type { FrameXmlWorldPvpArea, FrameXmlWorldPvpWorld } from "./FrameXmlWorldPvpQueue.js";

/** GetBattlefieldStatus's seven values (BattlefieldFrame.lua:237). */
export type FrameXmlCannedBattlefieldStatus = readonly [string, string | undefined, number, number, number, number, boolean];

const NO_QUEUE: FrameXmlCannedBattlefieldStatus = Object.freeze(["none", undefined, 0, 0, 0, 0, false] as const);

export const FRAMEXML_CANNED_WINTERGRASP_ZONE = 4197;

const AREAS = new Map<number, FrameXmlWorldPvpArea>([
  [FRAMEXML_CANNED_WINTERGRASP_ZONE, Object.freeze({ name: "Озеро Ледяных Оков", parentId: 0, flags: 0x08000000 })],
]);

export type FrameXmlCannedWorldPvpCall =
  | { readonly kind: "queueInvite" | "entryInvite"; readonly battleId: number; readonly accept: boolean }
  | { readonly kind: "exit"; readonly battleId: number }
  | { readonly kind: "hearth" };

export class FrameXmlCannedWorldPvp implements FrameXmlWorldPvpWorld {
  readonly calls: FrameXmlCannedWorldPvpCall[] = [];
  /** The two battleground queue slots, 1-based as stock reads them. */
  readonly queues: FrameXmlCannedBattlefieldStatus[] = [NO_QUEUE, NO_QUEUE];
  battlefieldQueuedId = 0;
  battlefieldQueuedZoneId = 0;
  battlefieldWarInvite: BattlefieldWarInvite | undefined;
  /** The canned player's area; 0 is nowhere special. */
  areaId = 0;

  battlefieldStatus(index: number): FrameXmlCannedBattlefieldStatus {
    return Number.isInteger(index) && index >= 1 && index <= 2 ? this.queues[index - 1]! : NO_QUEUE;
  }

  area(id: number): FrameXmlWorldPvpArea | undefined {
    return AREAS.get(id);
  }

  /** Queue for Wintergrasp, as SMSG_BATTLEFIELD_MGR_QUEUE_REQUEST_RESPONSE would leave the world. */
  queueForWintergrasp(battleId = 1): void {
    this.battlefieldQueuedId = battleId;
    this.battlefieldQueuedZoneId = FRAMEXML_CANNED_WINTERGRASP_ZONE;
  }

  answerBattlefieldQueueInvite(battleId: number, accept: boolean): void {
    this.calls.push({ kind: "queueInvite", battleId, accept });
  }

  answerBattlefieldWarInvite(battleId: number, accept: boolean): void {
    this.calls.push({ kind: "entryInvite", battleId, accept });
    this.battlefieldWarInvite = undefined;
  }

  leaveBattlefieldQueue(battleId: number): void {
    this.calls.push({ kind: "exit", battleId });
    if (this.battlefieldQueuedId === battleId) this.battlefieldQueuedId = 0;
  }

  leaveBattlefield(): void {
    this.calls.push({ kind: "hearth" });
  }

  currentServerTime(): number | undefined {
    return undefined;
  }

  reset(): void {
    this.calls.length = 0;
    this.queues[0] = NO_QUEUE;
    this.queues[1] = NO_QUEUE;
    this.battlefieldQueuedId = 0;
    this.battlefieldQueuedZoneId = 0;
    this.battlefieldWarInvite = undefined;
    this.areaId = 0;
  }
}
