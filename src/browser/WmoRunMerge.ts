/**
 * 25.10 (12.10): a room's opaque runs that share one material drawn as one range.
 *
 * A WMO room is one mesh with a group per run (`WmoGeometry.ts`), and runs whose material records,
 * textures, blend and light end in the same cache key share one material (`#wmoRunMaterial`). Three
 * still draws each group on its own; the census of 25.10 found 314 room draws over 273 (mesh,
 * material) pairs in Stormwind's trade district.
 *
 * Three sorts opaque draws by material and then by distance, and the groups of one mesh share its
 * distance, so the runs of one opaque material in a room are already drawn back to back, in group
 * order. One group over their ranges in that order (the same index where they are adjacent, an index
 * of its own where other runs lie between) draws the same triangles in the same order: the frame is
 * the same. A transparent run keeps its own group — it is ordered among the room's other blended runs
 * by its place in the group list.
 *
 * The derived geometry shares the room's attribute map and bounding volumes and is disposed with it
 * (never before: it shares the source's buffers).
 */

import * as THREE from "three";

/** For each group, the first group drawn with it (itself when alone); undefined when nothing merges. */
export function wmoRunMergePattern(
  groups: readonly THREE.GeometryGroup[],
  materials: readonly THREE.Material[],
): Int32Array | undefined {
  if (groups.length < 2) return undefined;
  const pattern = new Int32Array(groups.length);
  const firstOf = new Map<THREE.Material, number>();
  let merged = false;
  for (let index = 0; index < groups.length; index++) {
    const material = materials[groups[index]!.materialIndex ?? 0];
    if (material === undefined || material.transparent) { pattern[index] = index; continue; }
    const first = firstOf.get(material);
    if (first === undefined) { firstOf.set(material, index); pattern[index] = index; }
    else { pattern[index] = first; merged = true; }
  }
  return merged ? pattern : undefined;
}

/**
 * The room's geometry with its groups merged by `pattern`, groups in the order of their first member
 * and members in group order; null when it cannot be (a non-indexed room whose members are apart).
 */
export function wmoRunMergedGeometry(source: THREE.BufferGeometry, pattern: Int32Array): THREE.BufferGeometry | null {
  const groups = source.groups;
  const members = new Map<number, number[]>();
  for (let index = 0; index < groups.length; index++) {
    const first = pattern[index]!;
    let list = members.get(first);
    if (!list) { list = []; members.set(first, list); }
    list.push(index);
  }
  // Same index when every merged state's members follow each other in the index and in group order.
  let adjacent = true;
  let total = 0;
  for (const list of members.values()) {
    for (let at = 0; at < list.length; at++) {
      const group = groups[list[at]!]!;
      total += group.count;
      if (at > 0) {
        const previous = groups[list[at - 1]!]!;
        if (previous.start + previous.count !== group.start) adjacent = false;
      }
    }
  }
  const index = source.index;
  if (!Number.isFinite(total) || (!adjacent && index === null)) return null;
  if (source.drawRange.start !== 0 || source.drawRange.count !== Infinity) return null;
  const merged = new THREE.BufferGeometry();
  merged.attributes = source.attributes;
  merged.morphAttributes = source.morphAttributes;
  merged.morphTargetsRelative = source.morphTargetsRelative;
  if (source.boundingSphere === null) source.computeBoundingSphere();
  merged.boundingSphere = source.boundingSphere;
  merged.boundingBox = source.boundingBox;
  if (adjacent) {
    if (index !== null) merged.setIndex(index);
    for (const [first, list] of members) {
      let count = 0;
      for (const member of list) count += groups[member]!.count;
      merged.addGroup(groups[list[0]!]!.start, count, groups[first]!.materialIndex);
    }
  } else {
    const from = index!.array as Uint16Array | Uint32Array;
    const copy = from instanceof Uint16Array ? new Uint16Array(total) : new Uint32Array(total);
    let at = 0;
    for (const [first, list] of members) {
      const start = at;
      for (const member of list) {
        const group = groups[member]!;
        copy.set(from.subarray(group.start, group.start + group.count), at);
        at += group.count;
      }
      merged.addGroup(start, at - start, groups[first]!.materialIndex);
    }
    merged.setIndex(new THREE.BufferAttribute(copy, 1));
  }
  return merged;
}

const MERGED = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry | null>>();

/**
 * The geometry a room mesh draws with: `source` itself when no two of its opaque runs share a
 * material, otherwise its merged twin, made once per source and material pattern.
 */
export function wmoRoomDrawGeometry(source: THREE.BufferGeometry, materials: readonly THREE.Material[]): THREE.BufferGeometry {
  const pattern = wmoRunMergePattern(source.groups, materials);
  if (pattern === undefined) return source;
  let byPattern = MERGED.get(source);
  if (!byPattern) {
    byPattern = new Map();
    MERGED.set(source, byPattern);
    const twins = byPattern;
    source.addEventListener("dispose", () => {
      for (const twin of twins.values()) twin?.dispose();
      twins.clear();
    });
  }
  const key = pattern.join(",");
  let merged = byPattern.get(key);
  if (merged === undefined) {
    merged = wmoRunMergedGeometry(source, pattern);
    byPattern.set(key, merged);
  }
  return merged ?? source;
}
