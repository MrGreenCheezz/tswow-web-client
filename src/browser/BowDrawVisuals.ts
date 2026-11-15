// 5.05 (15.11, bow9): what the bow draw (BowDraw.ts) shows on a unit — the ranged weapon's own skeleton playing its
// sequences and the ammo model on HandArrow — and the clips of the unit it reads. The renderer (WorldRenderer3D.ts) hands
// the builds over through `BowDrawHost`, so the same code runs on the page and in the render worker.
//
// - The weapon (+0xb40, 0x00756040 / 0x0072afe0 / 0x00732650): a worn piece is a rigid mesh in this client. While the
//   draw has asked the weapon for a sequence, a skinned instance of the same model (its own rig, shared template and
//   build) hangs under that mesh with an identity transform — the mesh's frame is the item's M2 space, as for a glow
//   body (WeaponGlowBody.ts) — and the mesh itself leaves every camera's layers, so the bow is drawn once, by its rig.
//   BowPull and BowRelease travel in the model's animation sidecar and are asked for when wanted. The rig goes when the
//   mark goes, when the piece is rebuilt (moved to another point, unequipped) or when the unit's model is.
// - The ammo (+0xb44 on attachment 35, 0x00831630 / 0x008274f0): the display's model as 0x004eab50 makes it
//   (gateway/AmmoModels.ts, the flight model and its texture in the object-skin slot), a rigid mesh on the bone of
//   HandArrow at the attachment's offset.

import * as THREE from "three";
import type { AmmoModel } from "../gateway/AmmoModels.js";
import type { SpellAmmo } from "../world/SpellAmmo.js";
import { disposeSkinnedInstance, type SkinnedInstance, type SkinnedTemplate } from "./AnimatedModel.js";
import { attachmentOffset, boneOf } from "./Attachment.js";
import { BOW_PULL, BOW_RELEASE, BowDraw, WEAPON_STAND, type ShownClip, type WeaponSequence } from "./BowDraw.js";
import { ATTACHMENT_HAND_ARROW } from "./MissileLaunchWait.js";
import type { WvmModel } from "./Wvm.js";

/** The weapon's rig while it plays. */
export interface WornRig {
  /** The rigid piece it hangs under (`RenderedUnit.attached`). */
  readonly node: THREE.Object3D;
  /** The piece's own layers before the rig hid it. */
  readonly mask: number;
  readonly skinned: SkinnedInstance;
  readonly template: SkinnedTemplate;
  readonly built: object;
  readonly model: string;
  action: THREE.AnimationAction | undefined;
  /** The sequence last started on it. */
  applied: WeaponSequence | undefined;
}

/** One unit's draw and what it shows. */
export interface BowDrawUnit {
  readonly draw: BowDraw;
  rig: WornRig | undefined;
  arrow: THREE.Mesh | undefined;
  arrowKey: string | undefined;
  arrowBuilt: object | undefined;
  /** The clips of the last frame, reused (one per layer). */
  readonly base: MutableClip;
  readonly upper: MutableClip;
}

interface MutableClip {
  animation: number;
  variation: number;
  timeMs: number;
  durationMs: number;
  token: object;
}

export function newBowDrawUnit(): BowDrawUnit {
  const blank = (): MutableClip => ({ animation: -1, variation: 0, timeMs: 0, durationMs: 0, token: NO_TOKEN });
  return { draw: new BowDraw(), rig: undefined, arrow: undefined, arrowKey: undefined, arrowBuilt: undefined,
    base: blank(), upper: blank() };
}
const NO_TOKEN = {};

/**
 * The clip an action plays for `animation`, as the draw reads it: where it is and how long it is, and which variation
 * (`template.variations`; 0 when the rig has one cut). Undefined without an action or animation.
 */
export function shownClip(into: MutableClip, action: THREE.AnimationAction | undefined, animation: number | undefined,
  template: Pick<SkinnedTemplate, "variations"> | undefined): ShownClip | undefined {
  if (action === undefined || animation === undefined || animation < 0) return undefined;
  const clip = action.getClip();
  let variation = 0;
  const list = template?.variations?.get(animation);
  if (list !== undefined) {
    for (const entry of list) {
      if (entry.clip === clip || entry.overlay === clip) {
        variation = entry.variation;
        break;
      }
    }
  }
  into.animation = animation;
  into.variation = variation;
  into.timeMs = action.time * 1000;
  into.durationMs = clip.duration * 1000;
  into.token = action;
  return into;
}

/** What the renderer builds for the draw; undefined from a build: not this frame (loading, budget). */
export interface BowDrawHost {
  /** A rigid mesh of an item model with its object-skin texture, and the build it borrows. */
  rigid(model: string, texture: string): { mesh: THREE.Mesh; built: object } | undefined;
  /** A skinned instance of an item model; null: the model has no rig. */
  rigged(model: string, texture: string): { skinned: SkinnedInstance; template: SkinnedTemplate; built: object } | null | undefined;
  /** Asks for the sidecar clips `wanted` of a rig that lacks them. */
  clips(model: string, template: SkinnedTemplate, wanted: readonly number[]): void;
  /** The ammo display's model (AmmoModelClient); null: none. */
  ammoModel(ammo: SpellAmmo): AmmoModel | null | undefined;
  /** Shader warm-up bookkeeping for a hung object. */
  register(object: THREE.Object3D): void;
  unregister(object: THREE.Object3D): void;
}

/** The unit's model as the draw hangs things on it. */
export interface BowDrawBody {
  readonly skinned: SkinnedInstance | undefined;
  readonly template: SkinnedTemplate | undefined;
  readonly wvm: WvmModel | undefined;
  /** The piece in the ranged slot (`RenderedUnit.attached`), and its item. */
  readonly piece: THREE.Object3D | undefined;
  readonly item: { readonly model: string; readonly texture: string } | undefined;
}

const RIG_CLIPS: readonly number[] = [BOW_PULL, BOW_RELEASE];

/** One frame of what the draw shows: the arrow hung or not, the rig and its sequence; `elapsed` in seconds. */
export function syncBowDrawVisuals(unit: BowDrawUnit, body: BowDrawBody, host: BowDrawHost, now: number, elapsed: number): void {
  syncArrow(unit, body, host);
  syncRig(unit, body, host, now, elapsed);
}

function syncArrow(unit: BowDrawUnit, body: BowDrawBody, host: BowDrawHost): void {
  const draw = unit.draw;
  const model = draw.hung && draw.ammoDisplay > 0
    ? host.ammoModel({ displayId: draw.ammoDisplay, inventoryType: draw.ammoType }) : undefined;
  const bone = model && body.wvm && body.skinned ? boneOf(body.wvm, body.skinned, ATTACHMENT_HAND_ARROW) : undefined;
  const key = model && model.model && bone ? `${model.model}#${model.texture}` : undefined;
  if (unit.arrow !== undefined && (key === undefined || key !== unit.arrowKey || unit.arrow.parent !== bone)) dropArrow(unit, host);
  if (key === undefined || unit.arrow !== undefined || !model || !bone || !body.wvm || !body.template) return;
  const built = host.rigid(model.model, model.texture);
  if (built === undefined) return;
  built.mesh.position.copy(attachmentOffset(body.wvm, body.template.pivots, ATTACHMENT_HAND_ARROW));
  bone.add(built.mesh);
  unit.arrow = built.mesh;
  unit.arrowKey = key;
  unit.arrowBuilt = built.built;
}

function syncRig(unit: BowDrawUnit, body: BowDrawBody, host: BowDrawHost, now: number, elapsed: number): void {
  const weapon = unit.draw.weapon;
  const piece = body.piece;
  const item = body.item;
  if (unit.rig !== undefined && (weapon === undefined || piece === undefined || unit.rig.node !== piece
    || unit.rig.model !== item?.model)) dropRig(unit, host);
  if (weapon === undefined || piece === undefined || item === undefined) return;
  if (unit.rig === undefined) {
    const built = host.rigged(item.model, item.texture);
    if (!built) return;
    built.skinned.root.quaternion.identity();
    piece.add(built.skinned.root);
    const mask = piece.layers.mask;
    piece.layers.disableAll();
    unit.rig = { node: piece, mask, skinned: built.skinned, template: built.template, built: built.built, model: item.model,
      action: undefined, applied: undefined };
  }
  const rig = unit.rig;
  if (rig.applied !== weapon) {
    const clip = rig.template.clips.get(weapon.animation);
    if (clip === undefined && weapon.animation !== WEAPON_STAND && rig.template.animations.has(weapon.animation)) {
      host.clips(item.model, rig.template, RIG_CLIPS);
    } else {
      playWeapon(rig, weapon, clip, now);
    }
  }
  rig.skinned.mixer.update(Math.max(0, elapsed));
}

/** Starts the weapon's sequence where it would be by now: BowPull and BowRelease once and held, Stand on a loop. */
function playWeapon(rig: WornRig, weapon: WeaponSequence, clip: THREE.AnimationClip | undefined, now: number): void {
  rig.applied = weapon;
  const previous = rig.action;
  if (clip === undefined) {
    // Sequence 0 with no keys is the rest pose (the reader writes no clip for it).
    previous?.stop();
    rig.action = undefined;
    return;
  }
  const action = rig.skinned.mixer.clipAction(clip);
  const once = weapon.animation !== WEAPON_STAND;
  action.reset();
  action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = once;
  action.setEffectiveTimeScale(weapon.speed);
  action.setEffectiveWeight(1);
  action.play();
  const into = Math.max(0, (now - weapon.at) / 1000) * weapon.speed;
  action.time = once ? Math.min(into, clip.duration) : into % Math.max(clip.duration, 1e-3);
  if (previous !== undefined && previous !== action) previous.stop();
  rig.action = action;
}

export function dropRig(unit: BowDrawUnit, host: BowDrawHost): void {
  const rig = unit.rig;
  if (rig === undefined) return;
  unit.rig = undefined;
  rig.node.layers.mask = rig.mask;
  rig.skinned.root.removeFromParent();
  host.unregister(rig.skinned.root);
  disposeSkinnedInstance(rig.skinned);
}

export function dropArrow(unit: BowDrawUnit, host: BowDrawHost): void {
  const arrow = unit.arrow;
  if (arrow === undefined) return;
  unit.arrow = undefined;
  unit.arrowKey = undefined;
  unit.arrowBuilt = undefined;
  arrow.removeFromParent();
  host.unregister(arrow);
}

/** Everything the draw hung on the unit goes (the unit's model is rebuilt or the unit leaves). */
export function dropBowDrawVisuals(unit: BowDrawUnit | undefined, host: BowDrawHost): void {
  if (unit === undefined) return;
  dropRig(unit, host);
  dropArrow(unit, host);
}

/** The meshes the unit's fade and tint reach. */
export function* bowDrawMeshes(unit: BowDrawUnit | undefined): Generator<THREE.Mesh> {
  if (unit === undefined) return;
  if (unit.rig !== undefined) yield unit.rig.skinned.mesh;
  if (unit.arrow !== undefined) yield unit.arrow;
}

/** The builds the draw borrows, into the renderer's eviction pins. */
export function pinBowDrawBuilds(unit: BowDrawUnit | undefined, pins: { add(built: never): unknown }): void {
  if (unit === undefined) return;
  if (unit.rig !== undefined) pins.add(unit.rig.built as never);
  if (unit.arrowBuilt !== undefined) pins.add(unit.arrowBuilt as never);
}
