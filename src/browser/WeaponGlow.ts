// 05.10-A7a-E (6.14): enchantment glow as the original draws it — the ItemVisuals row's five effect models
// (ItemVisualEffects, `Spells\Enchantments\*.mdx` → .m2) hung on the weapon model's own attachments 0…4,
// slot i on attachment i — instead of an emissive tint guessed from the model's file name.
//
// Census (docs/implementation/probes/A7a/probe-weapon-attach.mjs): 548 of the 1,486 weapon and shield
// models carry exactly attachments {0, 1, 2, 3, 4}, 355 carry none; ItemVisuals has exactly five slots
// (filled 53/60/63/72/64 of 80 rows). Slot i ↔ attachment i is the strong hypothesis the spec records
// (5 = 5), still to be confirmed by a frame of the original (14.25). A slot whose attachment the weapon
// model lacks gets no effect; a weapon with none keeps the tint (ItemEnchantments.ts `enchantGlowTint`).
//
// The effect models are rigid children of the weapon mesh at the attachment's point in the item's model
// space; their emitters ride the renderer's ordinary emitter list (`#updateEffects`, anchored like a
// doodad: no skeleton, every emitter at the anchor's frame — bone-animated emitters of an effect model
// are therefore drawn at their rest frame, which is open point (3) of the spec).
// 05.10-A7a-E2: a model with its own mesh (17 of the effects) also gets a body (WeaponGlowBody.ts) — the mesh,
// animated by its own rig — and its emitters ride that rig; the emitter-only glows are as described above.

import * as THREE from "three";
import type { WvmModel } from "./Wvm.js";
import { disposeGlowBody, type GlowBody } from "./WeaponGlowBody.js"; // 05.10-A7a-E2

/** One effect to hang: the ItemVisuals slot, the weapon attachment id it goes on, the model path. */
export interface GlowPlacement {
  readonly slot: number;
  readonly attachment: number;
  readonly path: string;
}

/** ItemVisuals has five slots; slot i goes on the weapon model's attachment i. */
export const ITEM_VISUAL_SLOTS = 5;

/** The placements a weapon with these attachment ids gets from these five slots (null = empty slot). */
export function glowPlacement(
  attachmentIds: readonly number[],
  slots: readonly (string | null)[],
): GlowPlacement[] {
  const placements: GlowPlacement[] = [];
  for (let slot = 0; slot < ITEM_VISUAL_SLOTS; slot++) {
    const path = slots[slot];
    if (!path) continue;
    if (!attachmentIds.includes(slot)) continue;
    placements.push({ slot, attachment: slot, path });
  }
  return placements;
}

const slotKeys = new WeakMap<readonly (string | null)[], string>();

/**
 * A short, stable key for a five-slot set, to ride the weapon's build key (a different glow rebuilds the
 * blade). The client hands out one frozen array per ItemVisual, so this is one WeakMap lookup per frame.
 */
export function glowSlotsKey(slots: readonly (string | null)[] | undefined): string {
  if (!slots) return "";
  let key = slotKeys.get(slots);
  if (key === undefined) {
    key = `#${slots.map((path) => path ?? "").join("|")}`;
    slotKeys.set(slots, key);
  }
  return key;
}

/** A glow effect hung on a weapon mesh: its emitter key, its model once loaded, its anchor node. */
export interface GlowAnchor {
  readonly key: string;
  readonly path: string;
  readonly anchor: THREE.Object3D;
  wvm: WvmModel | undefined;
  /** 05.10-A7a-E2: the model's own geometry (WeaponGlowBody.ts); undefined until settled, null for none. */
  body?: GlowBody | null | undefined;
}

const GLOW_ANCHORS = "glowAnchors";

/**
 * Hangs one anchor per placement on `mesh` (the rigid weapon, in its model space), keyed
 * `${keyPrefix}:${slot}`. Returns them; they also ride `mesh.userData` for the per-frame passes.
 */
export function attachGlowAnchors(
  mesh: THREE.Object3D,
  itemModel: WvmModel,
  placements: readonly GlowPlacement[],
  keyPrefix: string,
): GlowAnchor[] {
  const anchors: GlowAnchor[] = [];
  for (const placement of placements) {
    const attachment = itemModel.attachments.find((candidate) => candidate.id === placement.attachment);
    if (!attachment) continue;
    const anchor = new THREE.Object3D();
    anchor.name = `glow:${placement.slot}`;
    anchor.position.set(attachment.position[0], attachment.position[1], attachment.position[2]);
    mesh.add(anchor);
    anchors.push({ key: `${keyPrefix}:${placement.slot}`, path: placement.path, anchor, wvm: undefined });
  }
  if (anchors.length > 0) mesh.userData[GLOW_ANCHORS] = anchors;
  return anchors;
}

/** The anchors a weapon mesh carries, if any. */
export function glowAnchorsOf(mesh: THREE.Object3D): readonly GlowAnchor[] | undefined {
  return mesh.userData[GLOW_ANCHORS] as GlowAnchor[] | undefined;
}

/** Asks for every anchor's effect model until it lands (`model` queues and answers undefined meanwhile). */
export function resolveGlowModels(mesh: THREE.Object3D, model: (path: string) => WvmModel | undefined): void {
  const anchors = glowAnchorsOf(mesh);
  if (!anchors) return;
  for (const anchor of anchors) if (!anchor.wvm) anchor.wvm = model(anchor.path);
}

/**
 * The emitter entries of one weapon's glows, for the renderer's list. 05.10-A7a-E2: a model with a rigged
 * body hands out that body, so its emitters follow the animated bones its mesh is drawn with.
 */
export function glowEmitterEntries<Entry>(
  mesh: THREE.Object3D,
  distance: number,
  make: (key: string, wvm: WvmModel, distance: number, anchor: THREE.Object3D, rig: GlowBody | undefined, fade: number) => Entry,
  out: { push(entry: Entry): unknown },
  fade = 1, // 05.10: ревью E2 — the unit's opacity, for the emitters (WeaponGlowBody.ts `fadeGlowEmitters`)
): void {
  const anchors = glowAnchorsOf(mesh);
  if (!anchors) return;
  for (const anchor of anchors) {
    const wvm = anchor.wvm;
    if (!wvm || wvm.particleEmitters.length + wvm.ribbonEmitters.length === 0) continue;
    const body = anchor.body;
    out.push(make(anchor.key, wvm, distance, anchor.anchor, body?.skinned ? body : undefined, fade)); // 05.10-A7a-E2; 05.10: ревью E2 fade
  }
}

/** A weapon mesh's glow anchors leave with it. */
export function detachGlowAnchors(mesh: THREE.Object3D): void {
  const anchors = glowAnchorsOf(mesh);
  if (!anchors) return;
  for (const anchor of anchors) {
    disposeGlowBody(anchor); // 05.10-A7a-E2: its rig goes with it
    anchor.anchor.removeFromParent();
  }
  mesh.userData[GLOW_ANCHORS] = undefined;
}
