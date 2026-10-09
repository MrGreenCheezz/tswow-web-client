// Where an equipped item hangs on the character wearing it.
//
// These three were module-private helpers in `WorldRenderer3D` until `character-lab.html` had to
// hang a helmet on a character without importing the whole renderer to do it. The reviewer's
// finding was that the lab drew a helmed character bare-headed — the gateway's `attached` list was
// read by nobody — and a second copy of «which point, or none at all» in the lab would have made
// every observation the page produces evidence about the copy instead of about the client.
//
// Nothing here builds anything or touches the scene beyond the one bone it is asked for.

import * as THREE from "three";
import type { AttachedModel } from "../gateway/CharacterAppearance.js";
import type { SkinnedInstance } from "./AnimatedModel.js";
import {
  ATTACHMENT_BACK, ATTACHMENT_HAND_LEFT, ATTACHMENT_HAND_RIGHT, ATTACHMENT_HELM,
  ATTACHMENT_HIP_LEFT, ATTACHMENT_HIP_RIGHT, ATTACHMENT_MOUNT_SEAT,
  ATTACHMENT_SHIELD, ATTACHMENT_SHOULDER_LEFT, ATTACHMENT_SHOULDER_RIGHT, type WvmModel,
} from "./Wvm.js";

const EQUIPMENT_SLOT_HEAD = 0;
const EQUIPMENT_SLOT_SHOULDERS = 2;
const EQUIPMENT_SLOT_MAINHAND = 15;
const EQUIPMENT_SLOT_OFFHAND = 16;
const EQUIPMENT_SLOT_RANGED = 17;
/** INVTYPE_WEAPON: one-handers of every school, daggers and fists included. */
const INVENTORY_TYPE_WEAPON = 13;
/** INVTYPE_SHIELD. */
const INVENTORY_TYPE_SHIELD = 14;
/** INVTYPE_2HWEAPON: every two-hander rides the back when stowed. */
const INVENTORY_TYPE_2HWEAPON = 17;
/** INVTYPE_WEAPONMAINHAND / INVTYPE_WEAPONOFFHAND: the hand-locked one-handers. */
const INVENTORY_TYPE_MAINHAND = 21;
const INVENTORY_TYPE_OFFHAND = 22;
// 05.10-A7a-H: INVTYPE_RANGED/RANGEDRIGHT and the bow/gun/crossbow subclasses left with the ranged
// clause of `stowedOnBack` (see there).
/** UNIT_FIELD_BYTES_2 byte 0: which weapon is drawn, if any. */
export const SHEATH_UNARMED = 0;
export const SHEATH_MELEE = 1;
export const SHEATH_RANGED = 2;

/**
 * Whether a stowed weapon rides the back.
 *
 * Grounded in `Item.dbc` `SheatheType` over this dataset rather than in the slot alone: every
 * two-hander carries 1, every staff 2, every shield 4, while one-handers and daggers carry 3 and
 * fist weapons 7. Bows, guns and crossbows carry 0, and 05.10-A7a-H (6.08, review G2): Wow.exe hangs
 * a stowed ranged weapon by that SheatheType (0x0072b7f0(1, …) → 0x004eacd0) and type 0 has no point,
 * so the ranged slot never rides the back here. The rare ranged item with type 1–4 hangs through
 * `SheathPoints.worldAttachmentPoint` when its type is known.
 */
export function stowedOnBack(item: AttachedModel): boolean {
  if (item.inventoryType === INVENTORY_TYPE_2HWEAPON) return true;
  if (item.slot === EQUIPMENT_SLOT_OFFHAND && item.inventoryType === INVENTORY_TYPE_SHIELD) return true;
  // 05.10-A7a-H: the ranged slot (bows, guns, crossbows by subclass since review A7a-B) no longer rides it.
  return false;
}

/**
 * Whether a stowed weapon rides the hip.
 *
 * The one-handers: `INVTYPE_WEAPON` in either hand and the hand-locked `MAINHAND`/`OFFHAND`
 * types. The dataset agrees — those rows carry `SheatheType` 3 — and the reference client hangs
 * exactly these at the hip points. A stowed shield deliberately stays out: it rides the back,
 * where held shields already prove point 0 is the forearm mount rather than a second back.
 */
export function stowedOnHip(item: AttachedModel): boolean {
  if (item.slot !== EQUIPMENT_SLOT_MAINHAND && item.slot !== EQUIPMENT_SLOT_OFFHAND) return false;
  return item.inventoryType === INVENTORY_TYPE_WEAPON
    || item.inventoryType === INVENTORY_TYPE_MAINHAND
    || item.inventoryType === INVENTORY_TYPE_OFFHAND;
}

/**
 * The local turn a hung piece needs beyond the bone it hangs from.
 *
 * Item models are authored for the grip, blade forward along +X. Hands hold them as authored;
 * hips do not — the reference client turns the long axis down alongside the leg (a quarter turn
 * about Y), and the bone frame here is the same M2 frame it turns in, so the same quarter turn
 * applies with no conjugation.
 */
const HIP_SHEATH_ROTATION = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

export function attachmentRotation(point: number): THREE.Quaternion | undefined {
  if (point !== ATTACHMENT_HIP_RIGHT && point !== ATTACHMENT_HIP_LEFT) return undefined;
  return HIP_SHEATH_ROTATION.clone();
}

/**
 * Which point on the character an equipped item hangs from, or undefined when it should not be
 * drawn at all.
 *
 * The slot decides, not the inventory type: a one-handed weapon is INVTYPE_WEAPON in either hand.
 * The shoulders are the one slot with two pieces, and they are two separate meshes rather than one
 * mirrored — LShoulder_Mail_B_01 and RShoulder_Mail_B_01 are different files.
 *
 * The sheath state names which weapon is out, not whether one is: at state 2 it is the bow that is
 * held and the melee weapons that are stowed. A stowed two-hander or shield rides the back
 * (`ATTACHMENT_BACK`); a stowed one-hander rides its own hip — right hip for the main hand, left
 * for the off hand — like the reference client hangs them. A stowed ranged weapon is not drawn
 * (05.10-A7a-H: SheatheType 0, see `stowedOnBack`).
 */
export function attachmentPoint(item: AttachedModel, sheath: number): number | undefined {
  switch (item.slot) {
    case EQUIPMENT_SLOT_HEAD: return ATTACHMENT_HELM;
    case EQUIPMENT_SLOT_SHOULDERS:
      return item.side === "left" ? ATTACHMENT_SHOULDER_LEFT : ATTACHMENT_SHOULDER_RIGHT;
    case EQUIPMENT_SLOT_MAINHAND:
      if (sheath === SHEATH_MELEE) return ATTACHMENT_HAND_RIGHT;
      if (stowedOnBack(item)) return ATTACHMENT_BACK;
      return stowedOnHip(item) ? ATTACHMENT_HIP_RIGHT : undefined;
    case EQUIPMENT_SLOT_OFFHAND:
      if (sheath === SHEATH_MELEE) {
        // A shield rides the forearm rather than being gripped.
        return item.inventoryType === INVENTORY_TYPE_SHIELD ? ATTACHMENT_SHIELD : ATTACHMENT_HAND_LEFT;
      }
      if (stowedOnBack(item)) return ATTACHMENT_BACK;
      return stowedOnHip(item) ? ATTACHMENT_HIP_LEFT : undefined;
    case EQUIPMENT_SLOT_RANGED:
      // A bow, gun or crossbow is carried in the forward hand, which is the left one.
      if (sheath === SHEATH_RANGED) return ATTACHMENT_HAND_LEFT;
      return stowedOnBack(item) ? ATTACHMENT_BACK : undefined;
    default: return undefined;
  }
}

/** Why a piece the gateway named is not on the character, for a panel that has to say so. */
export function attachmentRefusal(item: AttachedModel, sheath: number): string | undefined {
  if (attachmentPoint(item, sheath) !== undefined) return undefined;
  if (item.slot === EQUIPMENT_SLOT_MAINHAND || item.slot === EQUIPMENT_SLOT_OFFHAND) {
    return "оружие без ножен — тип не встаёт ни в руку, ни на бедро, ни на спину";
  }
  if (item.slot === EQUIPMENT_SLOT_RANGED) return "стрелковое убрано — клиент его не рисует";
  // Every other visible slot is armour the geosets and the body atlas carry: it is worn, not hung.
  return "слот не привязывается — вещь носится геосетами и атласом";
}

/**
 * How high above its own feet a model carries one attachment point, before display scale.
 *
 * The rest of this file hangs meshes on bones; this reads the same table for a measurement. The
 * camera wants to know where a character's shoulder is without waiting for the unit to be posed,
 * and the attachment table is the only thing in the artifact that says it per model rather than
 * per race: measured over the 20 playable displays the shoulder point runs from 0.823 yards on a
 * gnome to 2.667 on a tauren, against one flat 2.031 in `CreatureModelData.CollisionHeight` for
 * five of them.
 *
 * M2 space, so `z` is up and the model's origin sits between its feet.
 */
export function attachmentHeight(wvm: WvmModel, point: number): number | undefined {
  return wvm.attachments.find((candidate) => candidate.id === point)?.position[2];
}

/**
 * How high above a mount's feet its rider sits, at the scale the mount is drawn.
 *
 * Three answers, in the order the evidence deserves. Counted over this dataset's whole
 * `CreatureDisplayInfo` — 24,262 rows, because the server may put any display id in
 * `UNIT_FIELD_MOUNTDISPLAYID` — 19,533 are answered by the first, 29 by the second, 4,692 by the
 * third and 8 have no readable model.
 *
 * 1. The saddle the artist placed, `attachment 0` ("MountMain"). 405 of the 414 rows of
 *    `CreatureModelData` with a `MountHeight` carry it, and 403 of those 405 agree with the column
 *    to within 0.0001 — RidingHorse, display 2404, reads 1.8657 both ways. Where it exists the
 *    renderer does not use this number at all: it hangs the rider off that bone, which bobs with
 *    the gait. This is what the *name plate* is put on, and what the fallbacks are measured against.
 * 2. `CreatureModelData.MountHeight`, for one of the nine rows that name a height and no point:
 *    FrostWurm (8.139, and display 17255 draws it at 0.75), superzombie, ForsakenCatapult twice,
 *    FacelessGeneral, and the four Argent Tournament squire and gruntling children. Which of the
 *    nine a player can actually sit on is not a question the client's own tables answer —
 *    `SPELL_AURA_MOUNTED` names a *creature_template entry*, not a display
 *    (`SpellAuraEffects.cpp:2633`, and `:2646-2652` resolves it through
 *    `ObjectMgr::ChooseDisplayId`) — so this branch is kept for the column that fills it rather
 *    than claimed for any one mount. An earlier version of this comment said FrostWurm was "the one
 *    of the nine a mount aura reaches"; nothing on this side of the wire can measure that.
 * 3. Four fifths of the tallest *vertex*, for a model that names neither — Threshadon, MineSpider,
 *    IronForgeSteamTank and WarpStalker among 642 distinct models, whose attachment tables hold no
 *    point 0 at all and, in the tank's case, no attachment whatsoever. The ladder under it is the
 *    reference client's, rung for rung (`wowee/src/core/entity_spawner_processing.cpp:1715-1729`),
 *    and so is the source it measures: that code walks `modelData->vertices` and says why two lines
 *    above it, "M2 header bounds can be inaccurate" (`:1707-1708`). They are. `wvm.bounds` is the
 *    header's own box, animation extents and all (`tools/m2.mjs:308`; this repository already
 *    measured it overstating the drawn mesh by more than a quarter on 704 of 1,077 models), and
 *    reading the seat out of it put the rider over the mount's head: on the 642 the median error
 *    is +0.90 yards in model space, above a yard on 310 of them and above three on 137. Threshadon
 *    4.146
 *    against 2.696, MineSpider 3.674 against 1.569, WarpStalker 4.135 against 2.188 — and
 *    ElementalEarth, whose header box runs −110.74…19.96 because it covers the boulders the
 *    elemental throws while its mesh is −0.17…3.07, 15.97 against 2.45. IronForgeSteamTank is the
 *    one of the four whose header equals its mesh, which is why it read correctly and hid the rest.
 *    The two lower rungs matter as much as the fraction: they catch the 127 models under a yard and
 *    a quarter tall, and the two `InvisibleStalker` files whose header box is uninitialised
 *    (−3.4e38), where the old expression returned 0 and sat the rider on the hooves.
 *
 * The guess assumes the tallest part of the model is over the seat — true of a horse, false of a
 * motorcycle, as the reference client's own comment says. It is the last resort precisely for that.
 *
 * M2 space, so `z` is up; the caller multiplies nothing else in.
 */
export function mountSeatOffset(wvm: WvmModel, mountHeight: number, scale: number): number {
  const seat = attachmentHeight(wvm, ATTACHMENT_MOUNT_SEAT);
  if (seat !== undefined && seat > 0) return seat * scale;
  if (Number.isFinite(mountHeight) && mountHeight > 0) return mountHeight * scale;
  return mountSeatGuess(wvm) * scale;
}

/** What the last resort has to fall back on when a model is flat, or has no vertices at all. */
const MOUNT_SEAT_DEFAULT = 1.8;

/**
 * The reference client's guess, off the drawn vertices, rung for rung.
 *
 * `entity_spawner_processing.cpp:1715-1729`: tight z bounds over the vertices, and then
 * `maxZ * 0.8`, `(maxZ - minZ) * 0.75`, `1.8` — each taken only when the one before it lands under
 * a yard, which is a rider standing inside the mount. A model shorter than half a yard is not
 * measured at all and takes the constant, exactly as `extentZ > 0.5f` does there.
 */
function mountSeatGuess(wvm: WvmModel): number {
  const positions = wvm.positions;
  if (positions.length < 3) return MOUNT_SEAT_DEFAULT;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 2; index < positions.length; index += 3) {
    const z = positions[index]!;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const extent = maxZ - minZ;
  if (!(extent > 0.5)) return MOUNT_SEAT_DEFAULT;
  const eightyPercent = maxZ * 0.8;
  if (eightyPercent >= 1) return eightyPercent;
  const threeQuarters = extent * 0.75;
  return threeQuarters >= 1 ? threeQuarters : MOUNT_SEAT_DEFAULT;
}

/**
 * The two scales that let a mount and its rider share one node, which are each other's reciprocal.
 *
 * The rider's node already carries the rider's own scale and everything below it inherits that. The
 * mount is not the rider's size, so its group divides that scale out again; and the rider, which
 * hangs off one of the mount's bones and is therefore *inside* the mount's scale, multiplies it
 * back. Written once, and as a pair, because the failure mode of getting one of them without the
 * other is a giant on a normal horse or the reverse — and both look deliberate.
 *
 * Neither argument can be zero: the gateway clamps a display scale to 0.01…50, and П1's
 * `unitObjectScale` clamps the wire's own multiplier the way `Unit::RecalculateObjectScale` does.
 */
export function mountNesting(unitScale: number, mountScale: number): { mount: number; rider: number } {
  const rider = unitScale / mountScale;
  return { mount: 1 / rider, rider };
}

/** The bone object carrying one attachment point, or undefined when the model has no such point. */
export function boneOf(wvm: WvmModel, instance: SkinnedInstance, point: number): THREE.Bone | undefined {
  const attachment = wvm.attachments.find((candidate) => candidate.id === point);
  return attachment ? instance.skeleton.bones[attachment.bone] : undefined;
}

/**
 * Where an attached mesh sits inside the bone it hangs from.
 *
 * The bone's own frame is model space translated to its pivot, and the root already carries the
 * turn from M2 space into the scene — so the item needs the offset from that pivot and nothing
 * else. In this client that offset is always zero, but it is applied rather than assumed.
 */
export function attachmentOffset(wvm: WvmModel, pivots: Float32Array, point: number): THREE.Vector3 {
  const attachment = wvm.attachments.find((candidate) => candidate.id === point);
  if (!attachment) return new THREE.Vector3();
  return new THREE.Vector3(
    attachment.position[0] - (pivots[attachment.bone * 3] ?? 0),
    attachment.position[1] - (pivots[attachment.bone * 3 + 1] ?? 0),
    attachment.position[2] - (pivots[attachment.bone * 3 + 2] ?? 0));
}
