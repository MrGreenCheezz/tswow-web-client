/**
 * PLAYER_LEAVING_WORLD and PLAYER_ENTERING_WORLD across a loading screen.
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra): the stock UI's world edges belong to the active player
 * object. Its creation (0x006e8280 → 0x006e7f50) ends in the world entry (0x00528010), which raises
 * PLAYER_ENTERING_WORLD (with PLAYER_LOGIN first, once per UI); its destruction (0x006e6020) runs the
 * world exit (0x00528c30), which raises PLAYER_LEAVING_WORLD. Each is guarded by an «in the world»
 * flag, so they alternate. A worldport (SMSG_NEW_WORLD) clears the object manager: the character is
 * destroyed behind the loading screen and created again on the new map once the realm has the
 * MSG_MOVE_WORLDPORT_ACK — so every loading screen is one leave and one entry. A teleport within the
 * map (MSG_MOVE_TELEPORT) keeps the object and raises neither.
 *
 * This client keeps the character's object through the gap (WorldClient's SMSG_NEW_WORLD handler), so
 * the edges are taken from what the realm sends: `WORLD_TRANSFER` is the leave, and the next creation
 * of the character's own object (TrinityCore sends it after the ACK, Player::SendInitialPacketsAfterAddToMap)
 * is the entry. The session's first entry is FrameXmlBoot's exercise, not this model.
 */

import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";
import { frameXmlWorldExitEvents } from "./FrameXmlWorldExit.js"; // L5c 3.18

export const FRAMEXML_PLAYER_LEAVING_WORLD = "PLAYER_LEAVING_WORLD";
export const FRAMEXML_PLAYER_ENTERING_WORLD = "PLAYER_ENTERING_WORLD";

type Unsubscribe = () => void;

/** The two buses the model listens to, as narrow as it needs them. */
export interface FrameXmlWorldEntrySources {
  /** WorldClient.events: the packet facts. */
  readonly world?: { on(name: "WORLD_TRANSFER", listener: (payload: { mapId: number }) => void): Unsubscribe } | undefined;
  /** WorldStore.events: the state facts, delivered once per flush. */
  readonly store?: { on(name: "OBJECT_CREATED", listener: (payload: { guid: bigint }) => void): Unsubscribe } | undefined;
  /** The character's own guid. */
  readonly selfGuid: () => bigint | undefined;
  /** L5c 3.18: a cinematic plays (CINEMATIC_STOP leads the exit); this client skips them, so absent is «no». */
  readonly inCinematic?: (() => boolean) | undefined;
}

export interface FrameXmlWorldEntry {
  attach(pump: FrameXmlSeamPump, sources: FrameXmlWorldEntrySources): void;
  detach(): void;
  /** Between a leave and the entry that follows it. */
  readonly transferring: boolean;
}

export function createFrameXmlWorldEntry(): FrameXmlWorldEntry {
  let pump: FrameXmlSeamPump | undefined;
  let transferring = false;
  let unsubscribe: Unsubscribe[] = [];
  return {
    get transferring() {
      return transferring;
    },
    attach(next, sources) {
      pump = next;
      // Attached in the world: the boot's exercise raises this session's first entry.
      transferring = false;
      const leave = sources.world?.on("WORLD_TRANSFER", () => {
        if (!pump || transferring) return;
        transferring = true;
        // L5c 3.18: the whole world exit (0x00528c30) — [CINEMATIC_STOP,] INSTANCE_LOCK_STOP, then the leave.
        for (const event of frameXmlWorldExitEvents(sources.inCinematic?.() === true)) pump.fire(event);
      });
      const enter = sources.store?.on("OBJECT_CREATED", ({ guid }) => {
        if (!pump || !transferring || guid !== sources.selfGuid()) return;
        transferring = false;
        pump.fire(FRAMEXML_PLAYER_ENTERING_WORLD);
      });
      unsubscribe = [leave, enter].filter((off): off is Unsubscribe => off !== undefined);
    },
    detach() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      pump = undefined;
      transferring = false;
    },
  };
}
