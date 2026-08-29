import { unit } from "../../world/Fields.js";
import { REACTION_FRIENDLY, REACTION_NEUTRAL, UNIT_FLAG_IN_COMBAT } from "../../world/FactionRules.js";
import { enemiesAround, nextTarget, type TargetCandidate } from "../../world/TargetSearch.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { FactionClient } from "../FactionClient.js";
import { createCamera } from "../SimpleScene.js";
import { cameraPivotHeight, game } from "./Context.js";

/**
 * Who the player can point at.
 *
 * The reaction is not on the wire in 3.3.5 — the server publishes a faction template id and the
 * client is expected to look the rest up itself — so this is where the table the gateway serves
 * meets the units in view. Until it lands everything reads neutral, which costs Tab and a plate
 * colour and nothing else.
 */
export function reactionBetween(
  self: WorldObjectState | undefined,
  object: WorldObjectState,
  factions: FactionClient | undefined,
): number {
  const mine = self ? unit.factionTemplate(self) : undefined;
  const theirs = unit.factionTemplate(object);
  if (mine === undefined || theirs === undefined) return REACTION_NEUTRAL;
  return factions?.reaction(mine, theirs) ?? REACTION_NEUTRAL;
}

/** The live wrapper retains the current world and faction client. */
export function reactionTo(object: WorldObjectState): number {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  return reactionBetween(self, object, game.factions);
}

/**
 * Who Tab can take, in the order it takes them: what the character faces first, then by distance.
 *
 * Attackable rather than hostile. In the original client Tab takes anything the player is allowed
 * to attack, which is the red units *and the yellow ones* — a boar minding its own business is a
 * Tab target and a guard is not. Requiring hostility dropped every neutral in the world, and since
 * the reaction also reads neutral for as long as the faction table has not arrived, the effect in
 * a town was a key that did nothing at all and gave no reason.
 *
 * The combat flag comes off the same `self` the position does, so it costs no extra read. It is
 * what keeps the body of the thing just killed out of the cycle until the fight is over: sorting
 * corpses last orders the list but does not shorten it, and the cycle wraps.
 */
export function enemyCandidates(): TargetCandidate[] {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!world || !self?.position) return [];
  return enemiesAround(
    world.state.objects.values(),
    self.position,
    world.state.selfGuid,
    (object) => reactionTo(object) !== REACTION_FRIENDLY,
    undefined,
    self.position.orientation,
    ((unit.flags(self) ?? 0) & UNIT_FLAG_IN_COMBAT) !== 0,
  );
}

/**
 * Tab. Steps to the next enemy along, or to the nearest when the current target has left the
 * list — which is what happens the moment the thing you were fighting dies.
 */
export function cycleEnemyTarget(step: 1 | -1 = 1): void {
  const world = game.world;
  if (!world) return;
  const guid = nextTarget(enemyCandidates(), world.targetGuid, step);
  if (guid === undefined) return;
  world.selectTarget(guid);
}

/** The focus target: a second unit the player keeps an eye on, kept here until a frame shows it. */
export function setFocusToTarget(): void {
  game.focusGuid = game.world?.targetGuid;
}

export function focusUnit(): WorldObjectState | undefined {
  const world = game.world;
  if (!world || game.focusGuid === undefined) return undefined;
  return world.state.objects.get(game.focusGuid);
}

/**
 * Lets go of a unit that has just told the people around it to stop keeping an eye on it.
 *
 * `SMSG_BREAK_TARGET`, which the world client cannot answer itself: the focus is a thing the
 * interface keeps and the world client has never heard of, so the packet is announced and answered
 * here. The two halves of `SPELL_EFFECT_FORCE_DESELECT` have to move together — a fear that took
 * the selection and left the focus pointed at the same caster is the half-done version of the
 * effect — and this is the half that is the focus's. The selection is the other packet's,
 * `SMSG_CLEAR_TARGET`, because this one is broadcast to bystanders as well when a passenger boards
 * a vehicle (`Unit::SendClearTarget`, `Vehicle.cpp:933`).
 */
export function clearFocusOn(guid: bigint): void {
  if (game.focusGuid === guid) game.focusGuid = undefined;
}

/**
 * How far short of a body the sight line stops, in yards.
 *
 * A unit standing against a wall, in a doorway or on a bridge has that geometry within arm's reach
 * of its own chest, and a line drawn all the way to the chest meets it. Stopping short is the
 * difference between "there is a building between us" and "they are standing next to a building".
 */
const SIGHT_MARGIN = 1.2;

/**
 * Whether a straight line from the camera to this unit is clear of the world.
 *
 * There has never been a visibility test here at all, and the forgiving click made its absence
 * worse rather than better: with a 12px slop around every box, a miss near a wall now reaches
 * more eagerly for whoever is standing behind it. One ray per click, not per frame — this runs
 * when a button is released and nowhere else.
 *
 * The line is aimed at the chest rather than the feet, because the feet are inside the floor the
 * unit is standing on, and every shot at them would report the floor.
 *
 * Anything unknown answers "visible". The collision world is streamed and it is empty for the
 * first seconds in a zone; a veto that fired on missing data would make the client unclickable
 * exactly when the player is most likely to be clicking.
 */
export function inSightFromCamera(guid: bigint): boolean {
  const world = game.world;
  const collision = game.collision?.world;
  if (!world || !collision || collision.size === 0) return true;
  const target = world.state.objects.get(guid);
  const position = target?.position;
  if (!position) return true;
  const self = world.state.selfGuid;
  if (guid === self) return true;
  const player = self === undefined ? undefined : world.state.objects.get(self)?.position;
  if (!player) return true;

  // The camera the world was last drawn with, down to the tilt a floor granted: the ray has to
  // leave from where the click was aimed from, not from where the drag asked to be.
  const camera = createCamera(player, game.camera.yaw, game.camera.viewPitch, game.camera.view,
    { pivotHeight: cameraPivotHeight() });
  const height = game.renderer?.unitHeight(guid) ?? 2;
  const chest = { x: position.x, y: position.y, z: position.z + height * 0.6 };
  const dx = chest.x - camera.position.x;
  const dy = chest.y - camera.position.y;
  const dz = chest.z - camera.position.z;
  const length = Math.hypot(dx, dy, dz);
  // Nose to nose with it. There is nothing left of the segment to test and no room for a wall.
  if (length <= SIGHT_MARGIN) return true;
  const stop = 1 - SIGHT_MARGIN / length;
  const to = {
    x: camera.position.x + dx * stop,
    y: camera.position.y + dy * stop,
    z: camera.position.z + dz * stop,
  };
  return collision.firstHit(camera.position, to) === undefined;
}
