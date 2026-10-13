// 13.10 6.15: the emitters of the models hanging off a unit — its worn items (weapons, pauldrons, helmets) and
// the mount under it — and the sequence a model's emitters are sampled on.
//
// Wow.exe gives every CM2Model its own emitters whatever it hangs from: an attached item model is animated and
// drawn by the same CM2Model::Animate (0x00828a00) that walks the particle (0x008309c0) and ribbon emitters
// (0x0097f940/0x00980090) of any model, and the mount is a model like any other. Here the item is a rigid mesh on
// a bone (`WorldRenderer3D #updateAttachments`), so its emitters ride that mesh's frame — the item's own rig is not
// posed, as before for its batches — and the mount's ride its rig.

import type * as THREE from "three";
import type { WvmModel } from "./Wvm.js";

const ITEM_MODELS = new WeakMap<THREE.Object3D, WvmModel>();
const ITEM_KEYS = new WeakMap<THREE.Object3D, string>();

/** Remembers which item model an attached mesh was built from, for its emitters. */
export function rememberItemModel(node: THREE.Object3D, wvm: WvmModel): void {
  ITEM_MODELS.set(node, wvm);
}

/** The item model of an attached mesh, when it has emitters to run. */
export function emittingItemModel(node: THREE.Object3D): WvmModel | undefined {
  const wvm = ITEM_MODELS.get(node);
  return wvm && modelEmits(wvm) ? wvm : undefined;
}

/** A stable effect key for one attached piece, built once per mesh (no string per frame). */
export function itemEffectKey(node: THREE.Object3D, guid: string, where: string): string {
  let key = ITEM_KEYS.get(node);
  if (key === undefined) {
    key = `unit:${guid}:item:${where}`;
    ITEM_KEYS.set(node, key);
  }
  return key;
}

export function modelEmits(wvm: Pick<WvmModel, "particleEmitters" | "ribbonEmitters">): boolean {
  return wvm.particleEmitters.length + wvm.ribbonEmitters.length > 0;
}

/**
 * The sequence-table slot the clip of `action` plays (`WvmClip.variationIndex`, kept on the clip's userData by
 * AnimatedModel), or undefined when nothing plays or the artifact did not say.
 */
export function playingSequence(
  action: { getClip(): { userData: Record<string, unknown> } } | undefined,
): number | undefined {
  const slot = action?.getClip().userData["variationIndex"];
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 ? slot : undefined;
}
