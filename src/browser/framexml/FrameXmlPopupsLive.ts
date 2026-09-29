/**
 * The live facts FrameXmlPopups.ts reads, derived from the player's update fields and the seam's
 * own unit resolver, so LiveWorldSeam constructs the popup model with one block.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { isPlayerGhost, readField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { fieldFloat, isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import type { FrameXmlPopupsContext, FrameXmlPopupsCursorItem } from "./FrameXmlPopups.js";
import { frameXmlQuitIntent } from "./FrameXmlPopupsController.js";

/** `INTERACTION_DISTANCE` (ObjectDefines.h:24), measured between combat reaches as the server does. */
const INTERACTION_DISTANCE = 5;
/** Stock unit tokens a group member can hold: four party slots, forty raid slots. */
const GROUP_TOKENS: readonly string[] = Object.freeze([
  ...Array.from({ length: 4 }, (_, index) => `party${index + 1}`),
  ...Array.from({ length: 40 }, (_, index) => `raid${index + 1}`),
]);

export interface FrameXmlPopupsLiveHost {
  world(): WorldClient | undefined;
  /** The player's own object, as the seam resolves `"player"`. */
  self(): WorldObjectState | undefined;
  /** The seam's unit-token resolver (`partyN`, `raidN`, `target` …). */
  unitGuid(unit: string): bigint | undefined;
  playerLevel(): number;
  spellName(id: number): string | undefined;
  /** The seam's one stock bag cursor (the bags, mail and trade share it). */
  cursorItem?(): FrameXmlPopupsCursorItem | undefined;
  pickupItem?(bag: number, slot: number): boolean;
  clearCursor?(): void;
  monotonic(): number;
}

function reach(object: WorldObjectState): number {
  const value = fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset);
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The popup model's context over a live world. */
export function frameXmlPopupsLiveContext(host: FrameXmlPopupsLiveHost): FrameXmlPopupsContext {
  return {
    world: () => host.world(),
    playerLife: () => {
      const player = host.self();
      if (!player) return undefined;
      // A released ghost can carry positive health; PLAYER_FLAGS_GHOST is the server's word for it.
      return isPlayerGhost(player) ? "ghost" : isWorldObjectDead(player) ? "dead" : "alive";
    },
    playerPosition: () => {
      const player = host.self();
      const mapId = host.world()?.mapId;
      const position = player?.position;
      if (!player || !position || mapId === undefined) return undefined;
      return { mapId, x: position.x, y: position.y, z: position.z, reach: reach(player) };
    },
    playerFieldBytes: () => {
      const player = host.self();
      return player ? readField(player, "PLAYER_FIELD_BYTES") : undefined;
    },
    selfResurrectSpell: () => {
      const player = host.self();
      return player ? readField(player, "PLAYER_SELF_RES_SPELL") : undefined;
    },
    playerLevel: () => host.playerLevel(),
    unitGuid: (unit) => host.unitGuid(unit),
    unitToken: (guid) => {
      if (guid === host.world()?.state.selfGuid) return "player";
      return GROUP_TOKENS.find((token) => host.unitGuid(token) === guid);
    },
    spellName: (id) => host.spellName(id),
    areaName: (zoneId) => game.areas?.area(zoneId)?.name,
    spiritHealerInRange: (guid) => {
      const world = host.world();
      const player = host.self();
      const healer = world?.state.objects.get(guid);
      if (!player?.position || !healer?.position) return undefined;
      const distance = Math.hypot(
        healer.position.x - player.position.x, healer.position.y - player.position.y,
        healer.position.z - player.position.z,
      );
      return distance <= INTERACTION_DISTANCE + reach(player) + reach(healer);
    },
    // GameMenu.ts's Quit intent, registered with the popup controller (absent: CAMP, as before).
    quitting: () => frameXmlQuitIntent()?.quitting() === true,
    forceQuit: () => frameXmlQuitIntent()?.forceQuit(),
    cursorItem: () => host.cursorItem?.(),
    pickupItem: (bag, slot) => host.pickupItem?.(bag, slot) ?? false,
    clearCursor: () => host.clearCursor?.(),
    monotonic: () => host.monotonic(),
  };
}
