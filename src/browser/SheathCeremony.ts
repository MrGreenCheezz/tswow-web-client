// 6.08 (12.10): drawing and putting away a weapon, as Wow.exe 3.3.5a 12340 plays it.
//
// Who plays it. Only the active player's own ToggleSheath: the Lua function (0x0051a6b0) calls
// 0x006e23a0, which ends in the sheath setter 0x00736d30(next, 0, 0). Every other caller passes 1 in
// the setter's second argument — the swing 0x006e2610 (1, 1, 0), the animation sync 0x00738180, the
// cast 0x0073b140, the opcode switch 0x00756800, Lua 0x007fa2e0 — and so does the UNIT_FIELD_BYTES_2
// callback 0x00737aa0, which is how another player's or a creature's sheath reaches the client:
// `0x00736d30(byte 0, 1, 1)` (for the active player only when its own state still matched the old
// value, so the echo of its own toggle is not applied twice). With 1 the setter lets go of whatever
// the shoulders play (0x00832840 on key bones 3 and 2) and moves the pieces at once (0x00731f40 →
// 0x007310a0): a creature or another player draws in an instant, as this client already drew them.
// With 0 it calls 0x00736b60, which starts the clips below and leaves the move to their events.
//
// What plays. 0x00736b60 (by the state being left) and 0x007367b0 / 0x007368b0 / 0x007369b0 call
// 0x00735820(model, keyBone, animation, −1, 0, 1.0f, 1, 1, 0) → `CM2Model::SetBoneSequence`
// (0x00832ab0): the main hand's arm on key bone 3 (ShoulderR), the off hand's on key bone 2
// (ShoulderL) — that bone and every bone below it with no sequence of its own. One arm per piece,
// not the upper body: the legs keep running, a hand closed round its weapon stays closed. The clip
// is HipSheath (90) when the piece's SheatheType is 3 or 7 (`(1 << type) & 0x88`), Sheath (89)
// otherwise, and a ranged weapon being put away (state 2 left) always plays Sheath (the literal 0x59
// in 0x00736b60). A gun, crossbow, wand or thrown weapon (INVTYPE 26, 25) is the right arm's, any
// other ranged piece — the bow — the left's (0x00736b60, 0x007369b0; 0x00732500 skips the other hand).
//
// When the piece moves. At the model's own event, not at either end of the clip: `$SHR` moves the
// main hand (0x00732650 at 0x732de1 → 0x00732500(…, 0, 0x100000)), `$SHL` the off hand (0x732b41 →
// 0x00732500(…, 1, 0x200000)), each fired by its own arm's clip. 0x00732500 moves the piece between
// the hand and its sheath point (0x007310a0, the hand closing round it or opening, 0x004e7700 /
// 0x004e7750) or hangs the ranged one (0x0072b7f0). The visual artifact carries no M2 event tracks,
// so the moments are read off the clean client's playable rigs (`SHEATH_EVENTS`, the `$SHR`/`$SHL`
// keys of sequences 89 and 90 as a fraction of the sequence); any other rig takes their median, 0.5.
//
// Guards (0x006e23a0, before anything is sent): the rig must have both Sheath and HipSheath
// (0x00825ee0(0x5a), (0x59)) and key bones 3 and 2 (0x008264b0), and neither arm may still be playing
// one of them (0x008267e0(3), (2)) — otherwise ToggleSheath does nothing at all, not even the packet.
//
// The state here is per unit (`SheathCeremony`, the renderer keeps the active player's) plus one
// module-level hand-off from the key binding to the renderer, which owns the rig the guards read.
// Per-frame cost: a few compares per hung piece while a ceremony lives; nothing otherwise.

/** AnimationData 89 and 90: Wow.exe passes the literals 0x59 and 0x5a. */
export const SHEATH_ANIMATION = 89;
export const HIP_SHEATH_ANIMATION = 90;
export const SHEATH_ANIMATIONS: readonly number[] = [SHEATH_ANIMATION, HIP_SHEATH_ANIMATION];
/** Key bones 0x00735820 is given: 3 ShoulderR for the main hand, 2 ShoulderL for the off hand. */
export const KEY_BONE_SHOULDER_RIGHT = 3;
export const KEY_BONE_SHOULDER_LEFT = 2;
/** The sheath states of UNIT_FIELD_BYTES_2 byte 0. */
const SHEATH_RANGED = 2;
const SLOT_MAIN_HAND = 15;
const SLOT_OFF_HAND = 16;
const SLOT_RANGED = 17;
/** INVTYPE_THROWN and INVTYPE_RANGEDRIGHT: the right hand's ranged pieces. */
const INVENTORY_TYPE_THROWN = 25;
const INVENTORY_TYPE_RANGED_RIGHT = 26;
/** The median `$SHR`/`$SHL` moment over the playable rigs, for any other rig. */
export const SHEATH_EVENT_MEDIAN = 0.5;
/**
 * How long a finished ceremony waits for the server's echo before the field is believed again. The
 * echo is a round trip; a refused toggle snaps back like 0x00738180's sync of the field into the state.
 */
export const SHEATH_ECHO_WAIT_MS = 2_000;
/** How long a toggle waits for the renderer to pick it up (the active player not drawn this frame). */
export const SHEATH_REQUEST_WAIT_MS = 500;

/**
 * `$SHR` and `$SHL` in Sheath (89) and HipSheath (90) as a fraction of the sequence, by rig:
 * [89 right, 89 left, 90 right, 90 left]. Read from the clean client's models (header v264, events
 * at 0x100, keys per sequence; the 6.08 probe in `.runtime/re-2026-10-11/glue-1110/`); the test reads
 * them again from the client when it is on the machine.
 */
export const SHEATH_EVENTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  humanmale: [0.5, 0.5, 0.567, 0.567],
  humanfemale: [0.466, 0.466, 0.667, 0.4],
  orcmale: [0.467, 0.467, 0.5, 0.5],
  orcfemale: [0.468, 0.468, 0.6, 0.6],
  dwarfmale: [0.467, 0.467, 0.501, 0.501],
  dwarffemale: [0.5, 0.5, 0.5, 0.5],
  nightelfmale: [0.5, 0.5, 0.534, 0.534],
  nightelffemale: [0.649, 0.649, 0.4, 0.334],
  scourgemale: [0.6, 0.6, 0.6, 0.6],
  scourgefemale: [0.5, 0.5, 0.5, 0.5],
  taurenmale: [0.533, 0.533, 0.534, 0.534],
  taurenfemale: [0.5, 0.5, 0.5, 0.5],
  gnomemale: [0.6, 0.6, 0.5, 0.5],
  gnomefemale: [0.6, 0.6, 0.5, 0.5],
  trollmale: [0.467, 0.467, 0.5, 0.5],
  trollfemale: [0.499, 0.499, 0.5, 0.5],
  bloodelfmale: [0.4, 0.4, 0.466, 0.466],
  bloodelffemale: [0.4, 0.4, 0.566, 0.566],
  draeneimale: [0.466, 0.466, 0.467, 0.467],
  draeneifemale: [0.466, 0.466, 0.5, 0.5],
};

/** The event moment of `animation` on the arm of `keyBone`, as a fraction of the clip. */
export function sheathEventFraction(model: string | undefined, animation: number, keyBone: number): number {
  const base = model?.replaceAll("/", "\\").split("\\").pop()?.replace(/\.(m2|mdx)$/i, "").toLowerCase();
  const row = base === undefined ? undefined : SHEATH_EVENTS[base];
  if (!row) return SHEATH_EVENT_MEDIAN;
  const column = (animation === HIP_SHEATH_ANIMATION ? 2 : 0) + (keyBone === KEY_BONE_SHOULDER_LEFT ? 1 : 0);
  return row[column]!;
}

/** 0x007367b0 and its siblings: HipSheath for SheatheType 3 (one-hander) and 7 (fist), Sheath otherwise. */
export function sheathAnimationFor(sheathe: number | undefined): number {
  return sheathe !== undefined && sheathe >= 0 && sheathe < 32 && ((1 << sheathe) & 0x88) !== 0
    ? HIP_SHEATH_ANIMATION : SHEATH_ANIMATION;
}

/** One piece the ceremony may move: a hand slot's item. */
export interface SheathPiece {
  readonly slot: number;
  readonly inventoryType: number;
  /** SheatheType, when known (`SheathPoints.sheatheOf`). */
  readonly sheathe: number | undefined;
}

/** Which arm carries a piece: the main hand and the right-hand ranged pieces 3, the rest 2. */
export function armOfPiece(piece: Pick<SheathPiece, "slot" | "inventoryType">): number | undefined {
  if (piece.slot === SLOT_MAIN_HAND) return KEY_BONE_SHOULDER_RIGHT;
  if (piece.slot === SLOT_OFF_HAND) return KEY_BONE_SHOULDER_LEFT;
  if (piece.slot !== SLOT_RANGED) return undefined;
  return piece.inventoryType === INVENTORY_TYPE_RANGED_RIGHT || piece.inventoryType === INVENTORY_TYPE_THROWN
    ? KEY_BONE_SHOULDER_RIGHT : KEY_BONE_SHOULDER_LEFT;
}

/** What one arm plays and which slots its event moves. */
export interface SheathArmPlan {
  readonly keyBone: number;
  readonly animation: number;
  readonly slots: readonly number[];
}

/**
 * The arms a change from `from` to `to` plays (0x00736b60): an arm plays when a piece it carries
 * changes its point — Sheath when it is putting a ranged piece away (state 2 left), otherwise the clip
 * of its hand piece when that moves, else of the ranged piece. `pointOf` is where a piece hangs in a
 * state (`SheathPoints.worldAttachmentPoint`); a piece hung nowhere in both has nothing to move.
 */
export function sheathArmPlans<Piece extends SheathPiece>(pieces: readonly Piece[], from: number, to: number,
  pointOf: (piece: Piece, sheath: number) => number | undefined): SheathArmPlan[] {
  const plans: SheathArmPlan[] = [];
  for (const keyBone of [KEY_BONE_SHOULDER_RIGHT, KEY_BONE_SHOULDER_LEFT]) {
    const moving = pieces.filter((piece) => armOfPiece(piece) === keyBone && pointOf(piece, from) !== pointOf(piece, to));
    if (moving.length === 0) continue;
    const hand = moving.find((piece) => piece.slot !== SLOT_RANGED);
    const ranged = moving.find((piece) => piece.slot === SLOT_RANGED);
    const animation = from === SHEATH_RANGED && ranged !== undefined ? SHEATH_ANIMATION
      : sheathAnimationFor((hand ?? ranged)!.sheathe);
    plans.push({ keyBone, animation, slots: moving.map((piece) => piece.slot) });
  }
  return plans;
}

/** One arm's clip, on the renderer's clock (ms). */
export interface SheathArm extends SheathArmPlan {
  readonly startAt: number;
  /** The `$SHR`/`$SHL` moment: the arm's pieces hang by `from` before it and by `to` from it. */
  readonly eventAt: number;
  readonly endAt: number;
  /** The clip's length and its blend window, in seconds; 0 for a clip this rig could not play. */
  readonly duration: number;
  readonly blend: number;
}

export interface SheathCeremony {
  readonly from: number;
  readonly to: number;
  readonly startedAt: number;
  readonly arms: readonly SheathArm[];
  /** Whether the field has shown `to` (the echo): from then on any other value is the server's own. */
  readonly echoed: boolean;
}

/**
 * The ceremony for `plans`, started at `now`. `clip` answers an animation's length and blend window
 * in seconds, or undefined when the rig has not built it (its sidecar still on the way): that arm's
 * pieces then move at once, as 0x00731f40 moves them, and nothing plays on it.
 */
export function beginSheathCeremony(plans: readonly SheathArmPlan[], from: number, to: number, now: number,
  clip: (animation: number) => { readonly duration: number; readonly blend: number } | undefined,
  eventFraction: (animation: number, keyBone: number) => number): SheathCeremony {
  const arms = plans.map((plan): SheathArm => {
    const shape = clip(plan.animation);
    const duration = shape !== undefined && Number.isFinite(shape.duration) && shape.duration > 0 ? shape.duration : 0;
    const fraction = Math.min(1, Math.max(0, eventFraction(plan.animation, plan.keyBone)));
    return {
      ...plan, startAt: now, eventAt: now + duration * fraction * 1000, endAt: now + duration * 1000,
      duration, blend: duration > 0 ? Math.min(shape!.blend, duration / 2) : 0,
    };
  });
  return { from, to, startedAt: now, arms, echoed: false };
}

/** The sheath state a slot's piece hangs by: `from` until its arm's event, `to` from it on. */
export function ceremonySheath(ceremony: SheathCeremony, slot: number, now: number): number {
  for (const arm of ceremony.arms) {
    if (arm.slots.includes(slot)) return now >= arm.eventAt ? ceremony.to : ceremony.from;
  }
  return ceremony.to;
}

/** Whether an arm of the ceremony is still playing its clip (0x006e23a0's 0x008267e0 guard). */
export function ceremonyBusyUntil(ceremony: SheathCeremony | undefined): number {
  let until = -Infinity;
  for (const arm of ceremony?.arms ?? []) if (arm.duration > 0 && arm.endAt > until) until = arm.endAt;
  return until;
}

/**
 * The ceremony for this frame, or undefined once it is over. The field (`UNIT_FIELD_BYTES_2` byte 0)
 * moved anywhere but the two ends, or back to `from` after the echo (a swing drawing the blade again,
 * 0x006e2610 → 0x00736d30(1, 1, 0)), is the server's word and wins at once — 0x00737aa0 → 0x00736d30
 * (byte, 1, 1) lets go of the arms and hangs every piece by it. Otherwise the ceremony lives until
 * its arms are done and the echo has come (or has had `SHEATH_ECHO_WAIT_MS` to come).
 */
export function settleSheathCeremony(ceremony: SheathCeremony | undefined, field: number,
  now: number): SheathCeremony | undefined {
  if (!ceremony) return undefined;
  if (field !== ceremony.to && (field !== ceremony.from || ceremony.echoed)) return undefined;
  const settled = field === ceremony.to && !ceremony.echoed ? { ...ceremony, echoed: true } : ceremony;
  for (const arm of settled.arms) if (now < arm.endAt) return settled;
  return field === settled.to || now >= settled.startedAt + SHEATH_ECHO_WAIT_MS ? undefined : settled;
}

/**
 * 0x006e23a0's rig guard: Sheath and HipSheath both claimed and key bones 3 and 2 present. A key
 * bone table that did not travel (an artifact from before visual-v24) refuses nothing.
 */
export function rigRefusesSheath(animations: ReadonlySet<number>, keyBones: Int16Array | undefined): boolean {
  if (!keyBones) return false;
  if (!animations.has(SHEATH_ANIMATION) || !animations.has(HIP_SHEATH_ANIMATION)) return true;
  const right = keyBones[KEY_BONE_SHOULDER_RIGHT];
  const left = keyBones[KEY_BONE_SHOULDER_LEFT];
  return right === undefined || right < 0 || left === undefined || left < 0;
}

// The hand-off between the key binding and the renderer, both on `performance.now()`.
let requested: { readonly to: number; readonly at: number } | undefined;
let rig: { readonly refuses: boolean; readonly busyUntil: number; readonly at: number } | undefined;

/** The active player toggled to `to` (after the packet went out): the renderer starts the clips. */
export function requestOwnSheath(to: number, now: number): void {
  requested = { to, at: now };
}

/** The toggle the renderer has not started yet, once; undefined when none or when it went stale. */
export function takeOwnSheathRequest(now: number): number | undefined {
  const request = requested;
  requested = undefined;
  return request !== undefined && now - request.at <= SHEATH_REQUEST_WAIT_MS ? request.to : undefined;
}

/** What the renderer last saw of the active player's rig: the guards' inputs. */
export function publishOwnSheathRig(refuses: boolean, busyUntil: number, now: number): void {
  rig = { refuses, busyUntil, at: now };
}

/**
 * Whether ToggleSheath does nothing now (0x006e23a0): the rig cannot play the clips, or an arm is
 * still playing one. A report older than a second (no rig drawn since) refuses nothing.
 */
export function ownSheathRefused(now: number): boolean {
  if (!rig || now - rig.at > 1_000) return false;
  return rig.refuses || now < rig.busyUntil;
}

/** What `stepOwnSheath` reads of the active player's rig. */
export interface OwnSheathRig {
  /** The model path, for the event moments (`SHEATH_EVENTS`). */
  readonly model: string | undefined;
  /** Every sequence the model claims (`SkinnedTemplate.animations`), and its key bone table. */
  readonly animations: ReadonlySet<number>;
  readonly keyBones: Int16Array | undefined;
  /** A built clip's length and blend window in seconds, or undefined when it is not built. */
  readonly clip: (animation: number) => { readonly duration: number; readonly blend: number } | undefined;
}

/**
 * One frame of the active player's sheath: the ceremony settled against the field, a pending toggle
 * started from the state on show (0x00736d30 sets `[+0xb5c]` and calls 0x00736b60 at once, before
 * any echo), and the guards' inputs published for the next ToggleSheath.
 */
export function stepOwnSheath<Piece extends SheathPiece>(ceremony: SheathCeremony | undefined, field: number,
  now: number, pieces: () => readonly Piece[], pointOf: (piece: Piece, sheath: number) => number | undefined,
  rig: OwnSheathRig): SheathCeremony | undefined {
  let next = settleSheathCeremony(ceremony, field, now);
  const to = takeOwnSheathRequest(now);
  if (to !== undefined) {
    const from = next?.to ?? field;
    if (to !== from) {
      next = beginSheathCeremony(sheathArmPlans(pieces(), from, to, pointOf), from, to, now, rig.clip,
        (animation, keyBone) => sheathEventFraction(rig.model, animation, keyBone));
    }
  }
  publishOwnSheathRig(rigRefusesSheath(rig.animations, rig.keyBones), ceremonyBusyUntil(next), now);
  return next;
}

/** Tests: forget the hand-off. */
export function resetOwnSheath(): void {
  requested = undefined;
  rig = undefined;
}
