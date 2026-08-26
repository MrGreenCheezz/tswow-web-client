import { ANIMATION_IDS } from "../generated/animations.js";

/**
 * What a game object is doing, from the one byte the server sends about it.
 *
 * `GAMEOBJECT_BYTES_1` byte 0 is the whole of it: `GO_STATE_ACTIVE`, `GO_STATE_READY` or
 * `GO_STATE_DESTROYED`. There is no packet that says "play the door opening" — the state changes
 * and the client is expected to know that a door which was closed and is now open swings on the
 * way. That is what this decides.
 *
 * Kept apart from the unit chooser on purpose, and this is the trap the slice turns on: asking
 * `resolveAnimation` for an idle pose on a chest walks the generated fallback chain 0 → Closed →
 * Close and returns **Close**, a clip the chest really has, so nothing errors and every chest in
 * the world plays its lid shutting, forever. `146 ↔ 148` is a two-cycle in that table, stopped
 * only by its hop cap. A door is not a creature standing still.
 */

/** `GO_STATE_ACTIVE`: open, or for a lift, stopped. */
export const GO_STATE_ACTIVE = 0;
/** `GO_STATE_READY`: closed, or for a lift, running. */
export const GO_STATE_READY = 1;
export const GO_STATE_DESTROYED = 2;

/** `GAMEOBJECT_TYPE_*`, byte 1 of the same word. Only the ones this file decides between. */
export const GO_TYPE_DOOR = 0;
export const GO_TYPE_BUTTON = 1;
export const GO_TYPE_CHEST = 3;
export const GO_TYPE_TRAP = 6;
export const GO_TYPE_GOOBER = 10;
/** The lift. Its state means running or stopped, and its motion comes from TransportAnimation. */
export const GO_TYPE_TRANSPORT = 11;
/** The ship. The server moves it and tells nobody; nothing here animates it. */
export const GO_TYPE_MO_TRANSPORT = 15;

const CLOSE = ANIMATION_IDS.Close;
const CLOSED = ANIMATION_IDS.Closed;
const OPEN = ANIMATION_IDS.Open;
const OPENED = ANIMATION_IDS.Opened;
const DESTROY = ANIMATION_IDS.Destroy;
const DESTROYED = ANIMATION_IDS.Destroyed;

/**
 * The four animations `SMSG_GAMEOBJECT_CUSTOM_ANIM` can name, and the only four it may.
 *
 * The packet carries a `uint32` the core fills from two different places. Two of its twelve call
 * sites pass a real index — 0 to 3 — and the generic ones pass `GAMEOBJECT_BYTES_1` byte 3, which
 * is animation *progress*: across 92,845 world spawns that byte is 100 on 55,259 of them and 255
 * on 30,223. Read as an animation id it names nothing, and a chooser that trusts it would look up
 * animation 100 on every use of every goober in the game.
 */
export const CUSTOM_ANIMATIONS = [ANIMATION_IDS.Custom0, ANIMATION_IDS.Custom1, ANIMATION_IDS.Custom2, ANIMATION_IDS.Custom3];

export interface GameObjectPose {
  animation: number;
  /** Plays once and clamps on its last frame; a looping pose is not a thing a door has. */
  once: boolean;
}

/**
 * Which animation a game object should be showing, or nothing at all.
 *
 * `previous` is the state this object was last seen in, or undefined the first time it is drawn —
 * and that distinction is the whole of the transition logic. A door the player walks up to while
 * it stands open must *be* open, not swing open in their face; a door that opens while they watch
 * must swing.
 *
 * Nothing is a real answer here. 412 of the 608 models that declare Closed build no clip for it,
 * because the closed pose **is** the bind pose — chest02, stormwinddoor and deadminedoor01 are all
 * like that, and g_levermetal is the exception. So a missing clip is the normal case, not a fault,
 * and where the hold pose is missing the transition clamped on its last frame is the same pose.
 */
export function gameObjectPose(
  state: number,
  previous: number | undefined,
  available: ReadonlySet<number>,
): GameObjectPose | undefined {
  const has = (animation: number): boolean => available.has(animation);
  const changed = previous !== undefined && previous !== state;

  if (state === GO_STATE_DESTROYED) {
    if (changed && has(DESTROY)) return { animation: DESTROY, once: true };
    if (has(DESTROYED)) return { animation: DESTROYED, once: true };
    return has(DESTROY) ? { animation: DESTROY, once: true } : undefined;
  }
  if (state === GO_STATE_ACTIVE) {
    if (changed && has(OPEN)) return { animation: OPEN, once: true };
    if (has(OPENED)) return { animation: OPENED, once: true };
    // No held-open pose: Open clamped on its last frame is that pose. This is the one fallback
    // edge the generated table gets right, and it is right for the same reason.
    return has(OPEN) ? { animation: OPEN, once: true } : undefined;
  }
  if (changed && has(CLOSE)) return { animation: CLOSE, once: true };
  return has(CLOSED) ? { animation: CLOSED, once: true } : undefined;
}

/**
 * The animation a custom-anim packet asks for, or nothing when the number is not one.
 *
 * Model support is thin — 232, 61, 26 and 6 of the client's game object models carry Custom0 to
 * Custom3 — so most of these packets have nothing to play even when the number is in range. That
 * is the model's business; this only decides whether the number means anything.
 */
export function customGameObjectAnimation(animation: number): number | undefined {
  return CUSTOM_ANIMATIONS[animation];
}

/** Whether a model's animation list holds anything this chooser could ever use. */
export function animatesAsGameObject(animations: ReadonlySet<number>): boolean {
  for (const animation of [CLOSE, CLOSED, OPEN, OPENED, DESTROY, DESTROYED, ...CUSTOM_ANIMATIONS]) {
    if (animations.has(animation)) return true;
  }
  return false;
}
