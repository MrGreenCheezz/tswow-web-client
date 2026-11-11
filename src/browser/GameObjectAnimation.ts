import { ANIMATION_FALLBACK, ANIMATION_IDS } from "../generated/animations.js";
import { GO_DESPAWN_ANIM_INDEX } from "../world/GameObjectDespawn.js";
import {
  PLAYBACK_BACKWARD, PLAYBACK_FORWARD, PLAYBACK_HOLD_FIRST, fallbackPlayback, playbackHolds, type PlaybackMode,
} from "./AnimationPlayback.js";

/**
 * What a game object is doing, from the one byte the server sends about it.
 *
 * `GAMEOBJECT_BYTES_1` byte 0 is the whole of it: `GO_STATE_ACTIVE`, `GO_STATE_READY` or
 * `GO_STATE_DESTROYED`. There is no packet that says "play the door opening" — the state changes
 * and the client is expected to know that a door which was closed and is now open swings on the
 * way. That is what this decides.
 *
 * 11.11 (6.03): as Wow.exe 3.3.5a 12340 decides it. The state callback (0x00711050, registered for
 * BYTES_1 byte 0 by 0x007140a0) hands the old and the new state to the object's behaviour (vt+0x30,
 * 0x0070d690), which turns the pair into one of thirteen animation *kinds*; a kind is an animation id
 * by the table at 0x00ada938 (Spawn, Closed, Open, Opened, Close, Destroy, Destroyed, Rebuild,
 * Custom0–3, Despawn). 0x0070d510 sets the kind, 0x0070d1e0 plays it through `CM2Model::SetBoneSequence`
 * (0x00832ab0, so through AnimationData's fallback and its playback modes, 0x00826350 — see
 * `AnimationPlayback.ts`) and sets a timer for one clip length, and when it runs out 0x0070d7e0 moves
 * a transition on to its hold (Open → Opened, Close and Rebuild → Closed, Destroy → Destroyed) and
 * plays a hold again — a hold loops. Custom animations (`SMSG_GAMEOBJECT_CUSTOM_ANIM`, 0x0070be90 →
 * 0x0070bde0, index < 4) are kinds 8–11, played only when the model has the clip (0x0070c480), and
 * hand back to the state's hold when they end.
 *
 * What the player saw before: a hold was a one-shot replayed at its end, so a door whose model has
 * Open but no Opened swung open again every 0.6–1 s for as long as it stood open; a missing Close
 * played nothing instead of Open backwards; a closed chest drew its bind pose instead of Close held
 * on its last frame; a door closed mid-swing jumped to the start of Close. Doors are still not
 * a creature standing still: nothing here goes through the unit chooser.
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

/** The kinds of 0x0070d690 / 0x0070d7e0, indices into the table at 0x00ada938. */
export const GO_KIND_SPAWN = 0;
export const GO_KIND_CLOSED = 1;
export const GO_KIND_OPENING = 2;
export const GO_KIND_OPENED = 3;
export const GO_KIND_CLOSING = 4;
export const GO_KIND_DESTROYING = 5;
export const GO_KIND_DESTROYED = 6;
export const GO_KIND_REBUILDING = 7;
export const GO_KIND_CUSTOM0 = 8;
export const GO_KIND_DESPAWN = 12;

/** 0x00ada938: kind → AnimationData id. Read by name; a neutral table may lack the rarer rows. */
const KIND_ANIMATIONS: readonly (number | undefined)[] = [
  "Spawn", "Closed", "Open", "Opened", "Close", "Destroy", "Destroyed", "Rebuild",
  "Custom0", "Custom1", "Custom2", "Custom3", "Despawn",
].map((name) => ANIMATION_IDS[name]);

const CLOSE = ANIMATION_IDS.Close;
const CLOSED = ANIMATION_IDS.Closed;
const OPEN = ANIMATION_IDS.Open;
const OPENED = ANIMATION_IDS.Opened;
const DESTROY = ANIMATION_IDS.Destroy;
const DESTROYED = ANIMATION_IDS.Destroyed;
const STAND = ANIMATION_IDS.Stand;

/**
 * The four animations `SMSG_GAMEOBJECT_CUSTOM_ANIM` can name, and the only four it may.
 *
 * The packet carries a `uint32` the core fills from two different places. Two of its twelve call
 * sites pass a real index — 0 to 3 — and the generic ones pass `GAMEOBJECT_BYTES_1` byte 3, which
 * is animation *progress*: across 92,845 world spawns that byte is 100 on 55,259 of them and 255
 * on 30,223. Read as an animation id it names nothing; Wow.exe drops anything not below 4
 * (0x0070be90).
 */
export const CUSTOM_ANIMATIONS = [ANIMATION_IDS.Custom0, ANIMATION_IDS.Custom1, ANIMATION_IDS.Custom2, ANIMATION_IDS.Custom3];

export { GO_DESPAWN_ANIM_INDEX }; // 11.11 (6.03): SMSG_GAMEOBJECT_DESPAWN_ANIM as custom index 4 (kind 12, Despawn)

/**
 * The kind a state change asks for, as 0x0070d690 turns (old, new) into one (for an object whose
 * `GAMEOBJECT_DYNAMIC` high half is 0xFFFF, which the core writes for every type but the transports,
 * and those have behaviours of their own). `previous` undefined is the first sight: the same state
 * twice, so the hold — a door the player walks up to while it stands open is open, it does not swing.
 *
 * Note the asymmetries, which are the original's: only READY → ACTIVE swings open and only
 * READY → DESTROYED collapses; DESTROYED → ACTIVE is the open hold at once, DESTROYED → READY rebuilds.
 */
export function gameObjectStateKind(state: number, previous: number | undefined): number | undefined {
  const old = previous ?? state;
  if (state === GO_STATE_ACTIVE) return old !== GO_STATE_READY ? GO_KIND_OPENED : GO_KIND_OPENING;
  if (state === GO_STATE_READY) {
    if (old === GO_STATE_ACTIVE) return GO_KIND_CLOSING;
    if (old === GO_STATE_DESTROYED) return GO_KIND_REBUILDING;
    return GO_KIND_CLOSED;
  }
  if (state === GO_STATE_DESTROYED) return old !== GO_STATE_READY ? GO_KIND_DESTROYED : GO_KIND_DESTROYING;
  return undefined;
}

/**
 * What a kind becomes when its timer runs out (0x0070d7e0): a transition its hold, a hold itself again
 * (replayed — a hold loops), Spawn and the customs the current state's hold, Despawn nothing more.
 */
export function gameObjectNextKind(kind: number, state: number): number | undefined {
  switch (kind) {
    case GO_KIND_OPENING: return GO_KIND_OPENED;
    case GO_KIND_CLOSING: case GO_KIND_REBUILDING: return GO_KIND_CLOSED;
    case GO_KIND_DESTROYING: return GO_KIND_DESTROYED;
    case GO_KIND_CLOSED: case GO_KIND_OPENED: case GO_KIND_DESTROYED: return kind;
    case GO_KIND_DESPAWN: return undefined;
    default: return gameObjectStateKind(state, state);
  }
}

/** Whether a kind is a hold (0x0070d7e0 replays it; it plays as a loop). */
export function gameObjectKindHolds(kind: number): boolean {
  return kind === GO_KIND_CLOSED || kind === GO_KIND_OPENED || kind === GO_KIND_DESTROYED;
}

/**
 * The animation a kind requests, and whether it is frozen on its first frame (speed 0), as 0x0070d1e0
 * picks it. A model that has the kind's own animation plays it. One that lacks it is steered, for the
 * door's four, before AnimationData's fallback ever sees the request:
 *   Close missing, Open missing too → Closed;
 *   Closed missing, Close missing → Open frozen on its first frame, or with no Open either, Stand;
 *   Open missing, Close missing → Destroy if the model has it, else Opened;
 *   Opened missing, Open missing → Close frozen on its first frame if the model has it, else Destroyed.
 * Otherwise the request stays, and the model's fallback (`gameObjectClip`) plays it — Closed as Close
 * held on its last frame, Close as Open backwards, Opened as Open held, and so on.
 */
export function gameObjectKindRequest(kind: number, has: (animation: number) => boolean):
  { animation: number; frozen: boolean } | undefined {
  const animation = KIND_ANIMATIONS[kind];
  if (animation === undefined) return undefined;
  if (has(animation)) return { animation, frozen: false };
  if (animation === CLOSE) return { animation: has(OPEN) ? CLOSE : CLOSED, frozen: false };
  if (animation === CLOSED) {
    if (has(CLOSE)) return { animation: CLOSED, frozen: false };
    return has(OPEN) ? { animation: OPEN, frozen: true } : { animation: STAND, frozen: false };
  }
  if (animation === OPEN) {
    if (has(CLOSE)) return { animation: OPEN, frozen: false };
    return { animation: has(DESTROY) ? DESTROY : OPENED, frozen: false };
  }
  if (animation === OPENED) {
    if (has(OPEN)) return { animation: OPENED, frozen: false };
    return has(CLOSE) ? { animation: CLOSE, frozen: true } : { animation: DESTROYED, frozen: false };
  }
  return { animation, frozen: false };
}

const MAX_HOPS = 8;

/**
 * The clip a request plays on a model and how (0x00832ab0 → 0x00826350): the request itself, or the first
 * id down AnimationData's fallback chain the model has, in the mode the rows walked add up to. Frozen is
 * 0x0070d1e0's speed 0 on a clip the model has: its first frame. Undefined when nothing on the chain is
 * there — the model stays as it is.
 */
export function gameObjectClip(request: { animation: number; frozen: boolean }, has: (animation: number) => boolean,
  fallback: Readonly<Record<number, number>> = ANIMATION_FALLBACK): { animation: number; mode: PlaybackMode } | undefined {
  let id: number | undefined = request.animation;
  for (let hop = 0; id !== undefined && !has(id); hop++) {
    if (hop >= MAX_HOPS) return undefined;
    id = fallback[id];
  }
  if (id === undefined) return undefined;
  if (request.frozen) return { animation: id, mode: PLAYBACK_HOLD_FIRST };
  return { animation: id, mode: fallbackPlayback(request.animation, id) };
}

/** What a game object's model should be playing, and from where. */
export interface GameObjectPlay {
  readonly kind: number;
  readonly animation: number;
  readonly mode: PlaybackMode;
  /** A hold loops; a transition or a custom plays once. A held frame is held whatever this says. */
  readonly loop: boolean;
  /** How far into the kind its playing starts, 0–1 of its length (a reversed swing starts mid-way). */
  readonly fraction: number;
  /** Bumped on every (re)start; the renderer starts the clip again when it changes. */
  readonly serial: number;
  /** When the kind started, on the caller's clock: a clip that arrives late starts where it would be. */
  readonly startedAt: number;
}

/**
 * One game object's animation state, stepped every frame it is drawn.
 *
 * Per-frame cost: a compare of the state byte and of the clock; a new `GameObjectPlay` only when a kind
 * starts. `seconds` answers a clip's length once it is built (`undefined` while its sidecar is on the
 * way: a transition then waits, anchored at its start, rather than being skipped).
 */
export class GameObjectAnimator {
  #state: number | undefined;
  #kind: number | undefined;
  #fraction = 0;
  #startedAt = 0;
  #endsAt: number | undefined;
  #serial = 0;
  #play: GameObjectPlay | undefined;

  get kind(): number | undefined { return this.#kind; }

  /** The state byte this frame. A change (or the first sight) sets the kind 0x0070d690 picks. */
  observe(state: number, now: number): void {
    if (state === this.#state) return;
    const previous = this.#state;
    this.#state = state;
    const kind = gameObjectStateKind(state, previous);
    if (kind !== undefined) this.#setKind(kind, now);
  }

  /**
   * `SMSG_GAMEOBJECT_CUSTOM_ANIM`: the index, played only when the model has the clip (0x0070c480).
   * `GO_DESPAWN_ANIM_INDEX` is `SMSG_GAMEOBJECT_DESPAWN_ANIM` (0x0070bef0: the same table, one row on — Despawn).
   */
  custom(index: number, has: (animation: number) => boolean, now: number): void {
    if (!Number.isInteger(index) || index < 0 || index > GO_DESPAWN_ANIM_INDEX) return;
    const kind = index === GO_DESPAWN_ANIM_INDEX ? GO_KIND_DESPAWN : GO_KIND_CUSTOM0 + index;
    const animation = KIND_ANIMATIONS[kind];
    if (animation === undefined || !has(animation)) return;
    this.#setKind(kind, now, true);
  }

  /**
   * The play for this frame: moves a kind whose clip has run out on (0x0070d7e0) and answers what is to
   * be shown. `seconds(id)` is a built clip's length.
   */
  frame(now: number, has: (animation: number) => boolean,
    seconds: (animation: number) => number | undefined): GameObjectPlay | undefined {
    for (let guard = 0; guard < 4 && this.#kind !== undefined; guard++) {
      const play = this.#resolve(has);
      if (play === undefined) {
        // Nothing on the chain to play: a transition is over at once, a hold leaves the model as it is.
        const next = gameObjectKindHolds(this.#kind) || this.#state === undefined ? undefined
          : gameObjectNextKind(this.#kind, this.#state);
        if (next === undefined || next === this.#kind) return undefined;
        this.#setKind(next, now);
        continue;
      }
      if (play.loop) return play;
      if (this.#endsAt === undefined) {
        const length = seconds(play.animation);
        if (length === undefined) return play; // the clip is still on the way
        // A held frame (a frozen or held fallback) has a timer of nothing: 0x0070d1e0 sets it to now.
        this.#endsAt = playbackHolds(play.mode) ? this.#startedAt
          : this.#startedAt + length * (1 - this.#fraction) * 1000;
      }
      if (now < this.#endsAt) return play;
      const next = this.#state === undefined ? undefined : gameObjectNextKind(this.#kind, this.#state);
      if (next === undefined) return play;
      this.#setKind(next, this.#endsAt);
    }
    return this.#play;
  }

  /**
   * Until when a destroyed object must stay drawn: the end of the clip its kind is playing, unless the kind is a hold.
   * 0x0070d1e0 pins the object (0x004d4d60 → 0x007433e0(1)) for every kind but the three holds, and the clip's end
   * (0x0070d7e0 / 0x0070c430) unpins it (0x004d77e0), which deletes an object whose destroy came in meanwhile (GO+0xbc
   * bit 0x100000). Undefined when nothing holds it — a hold, or a clip that never started — so it goes at once.
   */
  pinnedUntil(now: number, has: (animation: number) => boolean,
    seconds: (animation: number) => number | undefined): number | undefined {
    const play = this.frame(now, has, seconds);
    if (play === undefined || play.loop || this.#endsAt === undefined) return undefined;
    return this.#endsAt > now ? this.#endsAt : undefined;
  }

  #setKind(kind: number, now: number, always = false): void {
    if (!always && kind === this.#kind) return;
    // 0x0070d510: an opening closed (or a closing opened, a collapse rebuilt…) before its end starts the
    // other from the same point of the swing: at one less the fraction already played.
    let fraction = 0;
    const current = this.#kind;
    const reverses = (current === GO_KIND_OPENING && kind === GO_KIND_CLOSING)
      || (current === GO_KIND_CLOSING && kind === GO_KIND_OPENING)
      || (current === GO_KIND_DESTROYING && kind === GO_KIND_REBUILDING)
      || (current === GO_KIND_REBUILDING && kind === GO_KIND_DESTROYING);
    if (reverses && this.#endsAt !== undefined && this.#endsAt > this.#startedAt) {
      const played = this.#fraction + (1 - this.#fraction) * ((now - this.#startedAt) / (this.#endsAt - this.#startedAt));
      if (played >= 0 && played <= 1) fraction = 1 - played;
    }
    this.#kind = kind;
    this.#fraction = fraction;
    this.#startedAt = now;
    this.#endsAt = undefined;
    this.#serial++;
    this.#play = undefined;
  }

  #resolve(has: (animation: number) => boolean): GameObjectPlay | undefined {
    const kind = this.#kind;
    if (kind === undefined) return undefined;
    if (this.#play !== undefined && this.#play.kind === kind && this.#play.serial === this.#serial) return this.#play;
    const request = gameObjectKindRequest(kind, has);
    const clip = request === undefined ? undefined : gameObjectClip(request, has);
    if (clip === undefined) return undefined;
    this.#play = {
      kind, animation: clip.animation, mode: clip.mode, loop: gameObjectKindHolds(kind),
      fraction: this.#fraction, serial: this.#serial, startedAt: this.#startedAt,
    };
    return this.#play;
  }
}

/**
 * Where in its clip a play stands `elapsed` seconds after it started, as the mixer's time: forwards from
 * the fraction, or for a clip played backwards from the mirrored point down. A held frame is set by
 * `applyPlayback` and has no time of its own here.
 */
export function gameObjectClipTime(play: GameObjectPlay, length: number, elapsed: number): number | undefined {
  if (playbackHolds(play.mode)) return undefined;
  const run = play.fraction * length + Math.max(0, elapsed);
  const at = play.loop && length > 0 ? run % length : Math.min(length, run);
  return play.mode === PLAYBACK_BACKWARD ? length - at : play.mode === PLAYBACK_FORWARD ? at : undefined;
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
  // 11.11 (6.03): Rebuild (kind 7) and Despawn (kind 12) are played too.
  for (const name of ["Rebuild", "Despawn"]) {
    const animation = ANIMATION_IDS[name];
    if (animation !== undefined && animations.has(animation)) return true;
  }
  return false;
}
