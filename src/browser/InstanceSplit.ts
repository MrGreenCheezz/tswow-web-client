/**
 * 25.10 (12.10): a doodad with blended batches instanced by its opaque ones.
 *
 * A bucket (`#updateInstances`) draws every copy of a model at once, and three sorts *objects*, so a
 * blended batch drawn through a bucket would lose its back-to-front order among the copies: a model
 * with any transparent material stayed out of the buckets whole. In Dalaran that kept 268 draws of
 * such models (crystal trees, ice rocks, banners) and 193 of the sconces and lanterns out — 1 or 2
 * opaque batches each beside a glow or a leaf card.
 *
 * Now such a model is split by its groups: the bucket draws a twin of the model's geometry holding
 * only its opaque groups (alpha-keyed ones included: their order is a hint about overdraw, nothing
 * else), and each copy keeps drawing its blended groups itself, through a twin holding only those —
 * same object, same distance, same order among the blended draws as before. Both twins share the
 * model's attribute map, index and bounding volumes, and are disposed with it, never before.
 *
 * The bucket's material array keeps its length with every blended slot taken by `SPLIT_HOLE`, an
 * invisible blended material no group of the opaque twin names: the warm pass then links no
 * instanced program for a batch the bucket never draws, and the shadow flags read the bucket as
 * they read the copy — a model with a blended batch casts no sun shadow (`#applySceneryShadowFlags`
 * wants every material eligible), so neither does its bucket.
 */

import * as THREE from "three";

export interface InstanceSplit {
  /** The model's opaque groups: what the bucket draws. */
  readonly opaque: THREE.BufferGeometry;
  /** The model's blended groups: what each covered copy still draws. */
  readonly blended: THREE.BufferGeometry;
}

/** The never-drawn stand-in for a blended slot of a split bucket's material array. */
export const SPLIT_HOLE: THREE.Material = new THREE.MeshBasicMaterial({
  transparent: true, visible: false, name: "instance-split-hole",
});

function twin(source: THREE.BufferGeometry, groups: readonly THREE.GeometryGroup[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.attributes = source.attributes;
  geometry.morphAttributes = source.morphAttributes;
  geometry.morphTargetsRelative = source.morphTargetsRelative;
  if (source.index !== null) geometry.setIndex(source.index);
  if (source.boundingSphere === null) source.computeBoundingSphere();
  geometry.boundingSphere = source.boundingSphere;
  geometry.boundingBox = source.boundingBox;
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  return geometry;
}

const SPLITS = new WeakMap<THREE.BufferGeometry, Map<string, InstanceSplit>>();

/**
 * How a built model is instanced: `undefined` — whole (no blended group); `null` — not at all (no
 * opaque group, a single non-grouped blended material, or a narrowed draw range); otherwise its split.
 */
export function instanceSplit(
  geometry: THREE.BufferGeometry,
  materials: THREE.Material | readonly THREE.Material[],
): InstanceSplit | null | undefined {
  if (!Array.isArray(materials)) return (materials as THREE.Material).transparent ? null : undefined;
  const list = materials as readonly THREE.Material[];
  const groups = geometry.groups;
  if (groups.length === 0) return list.every((material) => !material.transparent) ? undefined : null;
  let opaque = 0, blended = 0;
  let key = "";
  for (const group of groups) {
    const material = list[group.materialIndex ?? 0];
    const transparent = material?.transparent === true;
    if (transparent) blended++; else opaque++;
    key += transparent ? "b" : "o";
  }
  if (blended === 0) return undefined;
  if (opaque === 0) return null;
  if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return null;
  let byKey = SPLITS.get(geometry);
  if (!byKey) {
    byKey = new Map();
    SPLITS.set(geometry, byKey);
    const splits = byKey;
    geometry.addEventListener("dispose", () => {
      for (const split of splits.values()) { split.opaque.dispose(); split.blended.dispose(); }
      splits.clear();
    });
  }
  let split = byKey.get(key);
  if (!split) {
    const isBlended = (group: THREE.GeometryGroup): boolean => list[group.materialIndex ?? 0]?.transparent === true;
    split = Object.freeze({
      opaque: twin(geometry, groups.filter((group) => !isBlended(group))),
      blended: twin(geometry, groups.filter(isBlended)),
    });
    byKey.set(key, split);
  }
  return split;
}

/** The bucket's material array: the model's own with each blended slot taken by `SPLIT_HOLE`. */
export function splitInstanceMaterials(materials: readonly THREE.Material[]): THREE.Material[] {
  return materials.map((material) => material.transparent ? SPLIT_HOLE : material);
}
