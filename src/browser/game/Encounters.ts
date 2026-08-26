/**
 * Who the instance says is a boss, and who the arena says is the enemy team.
 *
 * Two lists the server never sends as lists, kept here rather than inside the frames that draw
 * them — because the module-window view reads the same two (`boss[i]`, `arena[i]`) and a second
 * copy of either would drift the first time one of them was corrected. `UnitFrames.ts` re-exports
 * what it used to own, so nothing outside had to be told.
 *
 * DOM-free on purpose: `WindowBindings.ts` is imported by a test that has no page, and reaching
 * `UnitFrames.ts` for these two would have dragged `Dom.ts` and its 193 resolved elements in.
 */

import { REACTION_HOSTILE } from "../../world/FactionRules.js";
import { STATUS_IN_PROGRESS } from "../../world/PvpProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "./Context.js";
import { reactionTo } from "./Targeting.js";

/** The five the original client draws. A sixth boss engaging replaces nothing; it is dropped. */
const MAX_BOSS_FRAMES = 5;
/** `MAX_ARENA_SLOT`-sized, but for the enemy team: five is the largest arena. */
const MAX_ARENA_FRAMES = 5;

/**
 * Which units the instance has told the client are bosses, in the order they engaged.
 *
 * `SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT` is one event at a time and carries no list, so the list
 * only exists because something keeps it. It is cleared when the world changes, or an encounter
 * frame from the last instance would sit on the screen in the next one.
 */
const engagedBosses: bigint[] = [];

export function bossEngaged(guid: bigint | undefined): void {
  if (guid === undefined || guid === 0n || engagedBosses.includes(guid)) return;
  if (engagedBosses.length >= MAX_BOSS_FRAMES) return;
  engagedBosses.push(guid);
}

export function bossDisengaged(guid: bigint | undefined): void {
  if (guid === undefined) {
    engagedBosses.length = 0;
    return;
  }
  const index = engagedBosses.indexOf(guid);
  if (index >= 0) engagedBosses.splice(index, 1);
}

export function forgetEncounters(): void {
  engagedBosses.length = 0;
}

/** A copy, so a binding pass or a frame repaint cannot push into the list itself. */
export function engagedBossGuids(): readonly bigint[] {
  return [...engagedBosses];
}

/**
 * Whether either queue slot says this character is standing in an arena right now.
 *
 * `SMSG_BATTLEFIELD_STATUS` is the only packet that says so: the arena marker byte and a status of
 * in-progress together. Neither alone is enough — a queued arena is also marked, and a battleground
 * in progress is also in progress.
 */
export function inArena(world: WorldClient): boolean {
  for (const queued of world.battlefieldQueues.values()) {
    if (queued.isArena && queued.status === STATUS_IN_PROGRESS) return true;
  }
  return false;
}

/**
 * The enemy arena team, as far as the client can tell.
 *
 * The hardest of the four lists and worth stating plainly: in 3.3.5 the server never names the
 * enemy team while the match is running. `MSG_PVP_LOG_DATA` would carry their guids, and
 * `HandlePVPLogDataOpcode` refuses it outright inside an arena until the match ends. So these are
 * the hostile players the client can actually see — which is what the original client does — capped
 * at five and ordered by guid, so the frames do not reshuffle every time somebody walks out of
 * range and back.
 */
export function arenaOpponentGuids(): readonly bigint[] {
  const world = game.world;
  if (!world || !inArena(world)) return [];
  const opponents: bigint[] = [];
  for (const object of world.state.objects.values()) {
    if (object.typeId !== 4 || object.guid === world.state.selfGuid) continue;
    if (reactionTo(object) !== REACTION_HOSTILE) continue;
    opponents.push(object.guid);
  }
  opponents.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return opponents.slice(0, MAX_ARENA_FRAMES);
}
