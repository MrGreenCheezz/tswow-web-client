/**
 * М1 «Серверное подтверждение»: the questions the server asks and then waits on — the innkeeper's
 * «make this place home?» (`SMSG_BINDER_CONFIRM`), the trainer's talent-reset quote
 * (`MSG_TALENT_WIPE_CONFIRM`) and the instance lock (`SMSG_INSTANCE_LOCK_WARNING_QUERY`) — as
 * `WorldClient` holds them until they are answered, and the rules the two answering surfaces share:
 * the stock dialogs (FrameXmlPopups.ts) and the native prompts (InteractionPrompts.ts). The wire
 * formats live with their families (CharacterProgressProtocol.ts, InstanceProtocol.ts).
 *
 * Each pending request is a new object per packet and only a packet replaces it: the stock model
 * compares identities, so a copy of the same question would ask it twice.
 */
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { isPlayerGhost } from "./Fields.js";
import { fieldFloat, isWorldObjectDead, type WorldObjectState, type WorldState } from "./WorldState.js";

/**
 * The `4.0f` of `GetNPCIfCanInteractWith` (Player.cpp:2325-2327, "taken from
 * CGGameUI::SetInteractTarget"): `creature->IsWithinDistInMap(player, creature->GetCombatReach() + 4)`.
 */
export const NPC_INTERACTION_BASE = 4;

/** `SMSG_BINDER_CONFIRM`: an innkeeper asks whether to make this place home. */
export interface BinderConfirmRequest {
  readonly guid: bigint;
  /** `performance.now()` when it arrived. */
  readonly receivedAt: number;
}

/** `MSG_TALENT_WIPE_CONFIRM` with a guid: a trainer quotes the price of a talent reset. */
export interface TalentWipeRequest {
  readonly guid: bigint;
  /** Copper, `Player::ResetTalentsCost`. */
  readonly cost: number;
  readonly receivedAt: number;
}

/** `SMSG_INSTANCE_LOCK_WARNING_QUERY`: bind to this instance now, or leave it. */
export interface InstanceLockRequest {
  /** `performance.now()` + the packet's milliseconds: the server's own deadline. */
  readonly expiresAt: number;
  /** `1 << DungeonEncounter.Bit` for each boss already killed in this instance. */
  readonly encounterMask: number;
  readonly previouslySaved: boolean;
  /** The map and difficulty it was asked on: SMSG_NEW_WORLD and SMSG_INSTANCE_DIFFICULTY precede it. */
  readonly mapId: number;
  readonly difficulty: number;
  readonly receivedAt: number;
}

/**
 * What an answer to the talent-reset quote did: `sent` the confirmation; `declined` — nothing is
 * sent, the talents stay; `unaffordable` — not sent, because `HandleTalentWipeConfirmOpcode` returns
 * without a word when the money is short ("client should display the error by itself",
 * SkillHandler.cpp:77); `none` — nothing was pending.
 */
export type TalentWipeAnswer = "sent" | "declined" | "unaffordable" | "none";

function combatReach(object: WorldObjectState): number {
  const reach = fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset);
  return reach !== undefined && reach > 0 ? reach : 0;
}

function selfOf(state: WorldState): WorldObjectState | undefined {
  const selfGuid = state.selfGuid;
  return selfGuid === undefined ? undefined : state.objects.get(selfGuid);
}

/**
 * The core's NPC interaction range: `IsWithinDistInMap(player, npcReach + 4)` adds both combat
 * reaches again (`_IsWithinDist`, Object.cpp:1153-1172) and compares strictly (`IsInDist`,
 * Position.h:149-150) — distance < 4 + 2·npcReach + playerReach. Undefined while either position is
 * unknown (mid-teleport). The spirit healer's CheckSpiritHealerDist is the same check.
 */
export function withinNpcInteraction(player: WorldObjectState, npc: WorldObjectState): boolean | undefined {
  if (!player.position || !npc.position) return undefined;
  const distance = Math.hypot(
    npc.position.x - player.position.x, npc.position.y - player.position.y, npc.position.z - player.position.z,
  );
  return distance < NPC_INTERACTION_BASE + 2 * combatReach(npc) + combatReach(player);
}

/**
 * Whether the NPC that asked can still take the answer (`GetNPCIfCanInteractWith`): one this client
 * no longer sees (out of view, another map) or a dead one cannot; while a position is unknown
 * nothing is decided.
 */
export function withinInteractionDistance(state: WorldState, npcGuid: bigint): boolean {
  const npc = state.objects.get(npcGuid);
  if (!npc || isWorldObjectDead(npc)) return false;
  const self = selfOf(state);
  return !self || (withinNpcInteraction(self, npc) ?? true);
}

/**
 * `PLAYER_FIELD_COINAGE` against a price. Unknown only while the player's object is missing; once it
 * exists a missing field is zero, because a CREATE block leaves zero fields out (Object.cpp:490).
 */
export function canAfford(state: WorldState, cost: number): boolean {
  const self = selfOf(state);
  return !self || (self.fields.get(UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset) ?? 0) >= cost;
}

/**
 * Whether the player may answer an NPC at all: `HandleBinderActivateOpcode` returns at once for a
 * player who is not alive (NPCHandler.cpp:292) — a body or a released ghost. Unknown counts as alive.
 */
export function playerAlive(state: WorldState): boolean {
  const self = selfOf(state);
  return !self || (!isWorldObjectDead(self) && !isPlayerGhost(self));
}
