import { farSightGuid } from "../../world/FarSight.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";

/**
 * 11.02-I: what the camera is built around — the character, or the object `PLAYER_FARSIGHT` names.
 *
 * Wow.exe 3.3.5a moves the camera's target (the guid at camera+0x88, 0x006066e0) in one place:
 * engaging far sight (0x006e2880 → 0x004f6f50), once the field's object is in view. That covers
 * every case the core has, because it writes the field whenever a unit's controls are taken
 * (`Player::SetClientControl`, Player.cpp:24594-24604: Mind Control, Eyes of the Beast, Eye of
 * Kilrogg, a vehicle's driving seat — even with moving disallowed) as well as for far sight proper
 * (a shaman's DynamicObject, `SPELL_AURA_BIND_SIGHT`, a cinematic's camera creature). The camera goes
 * home when the field is cleared, and when its object is not in view (0x006e2880, 0x004fa5f0) —
 * so a unit whose controls arrived before the field (`SMSG_CLIENT_CONTROL_UPDATE` is sent at once,
 * the field with the next update) is driven from the character's camera for that moment, as there.
 * Any object type is taken (0x004d4db0 with type mask 1); one without a position is not in view.
 *
 * Without far sight — nearly every frame — the answer is the character's own object, found with the
 * lookups the callers made before plus two reads of its fields, and nothing is allocated.
 *
 * Not modelled: once its object has left the view, Wow.exe keeps the camera home until the field
 * changes again (only a far sight DynamicObject re-engages on arrival, 0x00705230); here the camera
 * goes back to the object whenever it is in view.
 */

/** The parts of `WorldState` read here. */
export interface ViewSubjectState {
  readonly selfGuid: bigint | undefined;
  readonly objects: ReadonlyMap<bigint, WorldObjectState>;
}

/** The parts of `WorldClient` read here. */
export interface ViewSubjectWorld {
  readonly state: ViewSubjectState;
  readonly controlledGuid?: bigint | undefined;
}

/**
 * The object the camera is built around; undefined only while the character itself is not in view.
 * Takes the state alone, so the renderer and the plates resolve it from what they are handed.
 */
export function viewSubjectIn(state: ViewSubjectState | undefined): WorldObjectState | undefined {
  const self = state?.selfGuid;
  if (self === undefined) return undefined;
  const objects = state!.objects;
  const character = objects.get(self);
  if (character === undefined) return undefined;
  const view = farSightGuid(character);
  if (view === undefined || view === self) return character;
  const subject = objects.get(view);
  return subject?.position === undefined ? character : subject;
}

/** The same, for the live world client. */
export function viewSubject(world: ViewSubjectWorld | undefined): WorldObjectState | undefined {
  return viewSubjectIn(world?.state);
}

/** The camera subject's position, for the places that only build a camera from it. */
export function viewSubjectPosition(world: ViewSubjectWorld | undefined): WorldPosition | undefined {
  return viewSubject(world)?.position;
}

/** The unit the keys move (Mover.ts `moverGuid`, without its movement half). */
function moverOf(world: ViewSubjectWorld): bigint | undefined {
  const self = world.state.selfGuid;
  const controlled = world.controlledGuid;
  return controlled === undefined || controlled === self ? self : controlled;
}

/**
 * Whether the camera watches something the keys do not move. Wow.exe turns the mover with the
 * mouse only while the camera's target is the mover (0x005fb260 behind 0x005fa6b0, whose last test
 * is camera+0x88 against the mover's guid): under far sight proper the mouse turns the camera alone,
 * and the camera does not swing itself back behind a facing that is not the player's to change.
 * Under possession the field names the possessed unit, which is the mover: false, as without it.
 */
export function viewIsOut(world: ViewSubjectWorld | undefined): boolean {
  if (world === undefined) return false;
  const subject = viewSubject(world);
  if (subject === undefined) return false;
  // The objects themselves are compared: the subject is the map's own entry for its guid.
  const mover = moverOf(world);
  return mover === undefined || subject !== world.state.objects.get(mover);
}

/**
 * Whether the character's own body takes no movement input: it is the mover and its view is out on
 * an object in view. Wow.exe's shared movement precondition 0x005fa060 refuses while the mover is the
 * active player (0x004cee50) and the far sight latch is set; walking, strafing and turning ask it
 * (0x005fa0d0, 0x005fa110, 0x005fac90 → 0x005fbbc0, 0x005fae70). A possessed mover is not the active
 * player, so possession is never held by it. The latch there survives the object leaving the view;
 * here the hold ends with it.
 */
export function farSightHoldsBody(world: ViewSubjectWorld | undefined): boolean {
  if (world === undefined) return false;
  const self = world.state.selfGuid;
  if (self === undefined || moverOf(world) !== self) return false;
  const subject = viewSubject(world);
  return subject !== undefined && subject !== world.state.objects.get(self);
}

/** The parts of the camera rig a change of subject resets. */
export interface SubjectEasing {
  wallView: number;
  terrainView: number;
}

/**
 * Notices the subject changing between frames of one world. A new subject starts with nothing in
 * the boom's way: the eased wall and ground limits belong to where the old subject stood, and
 * easing them out over there would glide the camera for up to a second. The way in is instant
 * anyway (CameraRig.advanceCameraRig), so a wall at the new place still takes the boom at once.
 *
 * One per loop; a world change or a loading screen (a login, a transfer) starts it over, and the
 * first subject seen after that is only recorded.
 */
export class ViewSubjectTracker {
  #guid: bigint | undefined;
  #world: object | undefined;

  /** Returns whether the subject changed, after resetting the rig's limits if it did. */
  settle(rig: SubjectEasing, subject: bigint | undefined, world: object | undefined, loading: boolean): boolean {
    if (world !== this.#world || loading || subject === undefined) {
      this.#world = world;
      this.#guid = loading ? undefined : subject;
      return false;
    }
    if (subject === this.#guid) return false;
    const first = this.#guid === undefined;
    this.#guid = subject;
    if (first) return false;
    rig.wallView = Number.POSITIVE_INFINITY;
    rig.terrainView = Number.POSITIVE_INFINITY;
    return true;
  }

  reset(): void {
    this.#guid = undefined;
    this.#world = undefined;
  }
}
