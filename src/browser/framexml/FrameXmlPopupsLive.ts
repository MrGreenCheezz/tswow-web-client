/**
 * The live facts FrameXmlPopups.ts reads, derived from the player's update fields and the seam's
 * own unit resolver, so LiveWorldSeam constructs the popup model with one block.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { withinInteractionDistance, withinNpcInteraction } from "../../world/ConfirmationProtocol.js";
import { isPlayerGhost, readField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { fieldFloat, isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { dungeonEncounterClient } from "../DungeonEncounterClient.js";
import type { FrameXmlDungeonEncounter, FrameXmlPopupsContext, FrameXmlPopupsCursorItem } from "./FrameXmlPopups.js";
import { frameXmlPopupsTalentUiLoaded, frameXmlQuitIntent } from "./FrameXmlPopupsController.js";
import { frameXmlTalentOpen, toggleFrameXmlTalent } from "./FrameXmlTalentController.js";

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

/**
 * The page's DungeonEncounter rows of a map and difficulty (2.09 route), undefined until the table
 * lands; the stock finder's proposal counts its bosses with them too (FrameXmlLfd.ts).
 */
export function frameXmlLiveDungeonEncounters(mapId: number, difficulty: number): readonly FrameXmlDungeonEncounter[] | undefined {
  return dungeonEncounterClient(game.gatewayOrigin)?.encounters(mapId, difficulty);
}

/** The popup model's context over a live world. */
export function frameXmlPopupsLiveContext(host: FrameXmlPopupsLiveHost): FrameXmlPopupsContext {
  // 2.09: the boss table INSTANCE_LOCK's «Убито боссов: %d/%d» counts against, asked once per world
  // mount (a cycle that gave up starts again here) so it is in hand before a lock question arrives.
  dungeonEncounterClient(game.gatewayOrigin)?.retry();
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
    // The core's GetNPCIfCanInteractWith range (ConfirmationProtocol.ts); undefined while unknown.
    spiritHealerInRange: (guid) => {
      const player = host.self();
      const healer = host.world()?.state.objects.get(guid);
      return player && healer ? withinNpcInteraction(player, healer) : undefined;
    },
    // The innkeeper and the trainer: the rule WorldClient drops their questions by.
    npcInRange: (guid) => {
      const world = host.world();
      return world ? withinInteractionDistance(world.state, guid) : undefined;
    },
    // CONFIRM_BINDER's place: the terrain's area under the player, as the native minimap reads it —
    // SMSG_INIT_WORLD_STATES' area is where the zone was entered.
    playerAreaName: () => {
      const world = host.world();
      const position = host.self()?.position;
      if (!world || !position) return undefined;
      const areaId = game.terrain?.areaAt(world.mapId, position.x, position.y) ?? 0;
      return areaId > 0 ? game.areas?.area(areaId)?.name : undefined;
    },
    // CONFIRM_TALENT_WIPE waits for Blizzard_TalentUI in the published VM; its load is the published
    // talent owner's own (the N key's path), which also opens the tree the question is about.
    talentUi: () => {
      const loaded = frameXmlPopupsTalentUiLoaded();
      return loaded === undefined ? undefined : loaded ? "ready" : "idle";
    },
    loadTalentUi: () => { if (!frameXmlTalentOpen()) toggleFrameXmlTalent(); },
    // GameMenu.ts's Quit intent, registered with the popup controller (absent: CAMP, as before).
    quitting: () => frameXmlQuitIntent()?.quitting() === true,
    forceQuit: () => frameXmlQuitIntent()?.forceQuit(),
    cursorItem: () => host.cursorItem?.(),
    pickupItem: (bag, slot) => host.pickupItem?.(bag, slot) ?? false,
    clearCursor: () => host.clearCursor?.(),
    monotonic: () => host.monotonic(),
    // Undefined until the table lands (an older gateway: 404) — the model then leaves the lock to
    // the native prompt rather than print an invented total.
    dungeonEncounters: frameXmlLiveDungeonEncounters,
  };
}
