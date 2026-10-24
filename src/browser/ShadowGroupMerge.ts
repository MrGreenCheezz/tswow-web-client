/**
 * 25.10 (12.10): one shadow draw per depth state of a caster, not one per material group.
 *
 * Three's shadow pass draws a mesh with a material array group by group (`WebGLShadowMap.renderObject`),
 * each with the depth material `getDepthMaterial` picks for that group's material. For an opaque group
 * that is three's one shared depth material, set to the group's shadow side; only an alpha-keyed group
 * (`map`/`alphaMap` under an `alphaTest`, displacement, clipping, alpha to coverage) gets a clone of its
 * own, and a mesh's `customDepthMaterial` takes the group's `side`, `map`, `alphaMap` and `alphaTest`.
 * So a barrel's five opaque batches were five identical depth draws: the census of 25.10 counted 384
 * shadow draws over ~190 such depth states in Stormwind, 341 over ~205 in Dalaran.
 *
 * Around the cascades the caster list swaps each such caster's geometry for a twin whose groups are its
 * depth states: the same attribute objects (and so the same GPU buffers), the same bounding sphere, and
 * either the same index with wider groups (members already adjacent) or an index of its own with each
 * state's ranges side by side. Depth-only draws of the same triangles with the same depth state write
 * the same depth in any order, so the cascade maps are the same bit for bit; the twin's group keeps
 * the first member's `materialIndex`, so the depth material, its side and the hooks see what they saw.
 *
 * A twin is shared by every mesh of one geometry with the same partition, and kept until the source
 * geometry is disposed (it shares its attributes: disposing it first would free the source's buffers).
 * A mesh's partition is checked every frame against what it was built from — the material array, each
 * material's version, visibility and sides, the custom depth material, the geometry — so a fade copy or
 * a swapped material takes effect on the frame it happens.
 */

import * as THREE from "three";

/** Three's PCF shadow side for a caster material side (`WebGLShadowMap`'s `shadowSide`). */
const SHADOW_SIDE: Readonly<Record<number, THREE.Side>> = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

/** Index entries a frame may copy into new twins; a large room waits for the next frame. */
export const SHADOW_MERGE_COPY_BUDGET = 1 << 18;

type DepthSource = THREE.Material & {
  map?: THREE.Texture | null;
  alphaMap?: THREE.Texture | null;
  displacementMap?: THREE.Texture | null;
  displacementScale?: number;
  wireframe?: boolean;
};

/**
 * What decides the depth draw of one group: `null` — not drawn (invisible material); the material
 * itself — a clone of its own (or a custom depth material reading its textures); otherwise a string of
 * the switches three copies onto its shared depth material that change the depth written.
 */
export function shadowDepthState(material: THREE.Material | undefined, custom: THREE.Material | undefined): unknown {
  if (material === undefined || !material.visible) return null;
  const source = material as DepthSource;
  const side = material.shadowSide ?? SHADOW_SIDE[material.side] ?? THREE.BackSide;
  const wireframe = source.wireframe === true ? 1 : 0;
  const clipped = Array.isArray(material.clippingPlanes) && material.clippingPlanes.length !== 0;
  const displaced = Boolean(source.displacementMap) && source.displacementScale !== 0;
  const keyed = material.alphaTest > 0 && Boolean(source.map || source.alphaMap);
  if (custom !== undefined) {
    // A custom depth material is drawn with the group's textures and threshold copied onto it.
    if (keyed || clipped || displaced || material.alphaToCoverage) return material;
    return `c${side}|${wireframe}`;
  }
  if (keyed || clipped || displaced || material.alphaToCoverage) return material;
  return `s${side}|${wireframe}`;
}

/**
 * For each group, the index of the first group in its depth state, or -1 when it is not drawn. Undefined
 * when merging would save nothing.
 */
export function shadowMergePattern(
  groups: readonly THREE.GeometryGroup[],
  materials: readonly (THREE.Material | undefined)[],
  custom: THREE.Material | undefined,
): Int32Array | undefined {
  if (groups.length < 2) return undefined;
  const pattern = new Int32Array(groups.length);
  const states: unknown[] = [];
  const firsts: number[] = [];
  let drawn = 0;
  for (let index = 0; index < groups.length; index++) {
    const state = shadowDepthState(materials[groups[index]!.materialIndex ?? 0], custom);
    if (state === null) { pattern[index] = -1; continue; }
    drawn++;
    const at = states.indexOf(state);
    if (at >= 0) pattern[index] = firsts[at]!;
    else { states.push(state); firsts.push(index); pattern[index] = index; }
  }
  return states.length < drawn ? pattern : undefined;
}

/** Index entries `shadowMergedGeometry` would copy for this pattern (0: the source index serves). */
export function shadowMergeCopyCount(source: THREE.BufferGeometry, pattern: Int32Array): number {
  const plan = mergePlan(source.groups, pattern);
  return plan.contiguous ? 0 : plan.total;
}

interface MergePlan {
  /** Per state, in order of first appearance: its first group and its member group indices by start. */
  firsts: number[];
  members: number[][];
  contiguous: boolean;
  total: number;
}

function mergePlan(groups: readonly THREE.GeometryGroup[], pattern: Int32Array): MergePlan {
  const byFirst = new Map<number, number[]>();
  let total = 0;
  for (let index = 0; index < groups.length; index++) {
    const first = pattern[index]!;
    if (first < 0) continue;
    let list = byFirst.get(first);
    if (!list) { list = []; byFirst.set(first, list); }
    list.push(index);
    total += groups[index]!.count;
  }
  const firsts = [...byFirst.keys()];
  const members = [...byFirst.values()];
  let contiguous = true;
  for (const list of members) {
    list.sort((left, right) => groups[left]!.start - groups[right]!.start);
    for (let at = 1; at < list.length; at++) {
      const previous = groups[list[at - 1]!]!;
      if (previous.start + previous.count !== groups[list[at]!]!.start) contiguous = false;
    }
  }
  return { firsts, members, contiguous, total };
}

/**
 * The twin of `source` whose groups are the depth states of `pattern`, or null when it cannot be built
 * (a non-indexed geometry whose states are not contiguous, or an infinite group count).
 */
export function shadowMergedGeometry(source: THREE.BufferGeometry, pattern: Int32Array): THREE.BufferGeometry | null {
  const groups = source.groups;
  const plan = mergePlan(groups, pattern);
  const index = source.index;
  if (!Number.isFinite(plan.total)) return null;
  // A narrowed draw range would cut a reordered index somewhere else.
  if (source.drawRange.start !== 0 || source.drawRange.count !== Infinity) return null;
  if (!plan.contiguous && index === null) return null;
  const twin = new THREE.BufferGeometry();
  // The same attribute map, so an attribute set on the source later is the twin's too.
  twin.attributes = source.attributes;
  twin.morphAttributes = source.morphAttributes;
  twin.morphTargetsRelative = source.morphTargetsRelative;
  if (source.boundingSphere === null) source.computeBoundingSphere();
  twin.boundingSphere = source.boundingSphere;
  twin.boundingBox = source.boundingBox;
  if (plan.contiguous) {
    if (index !== null) twin.setIndex(index);
    plan.members.forEach((list, state) => {
      let count = 0;
      for (const member of list) count += groups[member]!.count;
      twin.addGroup(groups[list[0]!]!.start, count, groups[plan.firsts[state]!]!.materialIndex);
    });
    return twin;
  }
  const from = index!.array as Uint16Array | Uint32Array;
  const copy = from instanceof Uint16Array ? new Uint16Array(plan.total) : new Uint32Array(plan.total);
  let at = 0;
  plan.members.forEach((list, state) => {
    const start = at;
    for (const member of list) {
      const group = groups[member]!;
      copy.set(from.subarray(group.start, group.start + group.count), at);
      at += group.count;
    }
    twin.addGroup(start, at - start, groups[plan.firsts[state]!]!.materialIndex);
  });
  twin.setIndex(new THREE.BufferAttribute(copy, 1));
  return twin;
}

interface MeshState {
  source: THREE.BufferGeometry;
  groupCount: number;
  custom: THREE.Material | undefined;
  materials: (THREE.Material | undefined)[];
  versions: number[];
  visible: boolean[];
  sides: number[];
  /** The twin to draw with, null when merging saves nothing or cannot be done. */
  twin: THREE.BufferGeometry | null;
}

/** Twins of one source geometry by pattern; disposed with the source. */
const TWINS = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry | null>>();

function twinFor(source: THREE.BufferGeometry, pattern: Int32Array): THREE.BufferGeometry | null {
  let byPattern = TWINS.get(source);
  if (!byPattern) {
    byPattern = new Map();
    TWINS.set(source, byPattern);
    const twins = byPattern;
    source.addEventListener("dispose", () => {
      // The source's buffers are released by three's own listener; a twin's dispose releases its own
      // index and its binding states (the shared attributes are already gone or go with the source).
      for (const twin of twins.values()) twin?.dispose();
      twins.clear();
    });
  }
  const key = pattern.join(",");
  let twin = byPattern.get(key);
  if (twin === undefined) {
    twin = shadowMergedGeometry(source, pattern);
    byPattern.set(key, twin);
  }
  return twin;
}

function stale(state: MeshState, mesh: THREE.Mesh, materials: readonly THREE.Material[]): boolean {
  if (state.source !== mesh.geometry || state.groupCount !== mesh.geometry.groups.length
    || state.custom !== mesh.customDepthMaterial || state.materials.length !== materials.length) return true;
  for (let index = 0; index < materials.length; index++) {
    const material = materials[index];
    if (material !== state.materials[index]) return true;
    if (material === undefined) continue;
    if (material.version !== state.versions[index] || material.visible !== state.visible[index]
      || (material.shadowSide ?? -1) * 4 + material.side !== state.sides[index]) return true;
  }
  return false;
}

/**
 * Swaps casters' geometries for their twins around the cascades (`swap` per caster after the list's
 * `beginFrame`, `restore` in the pass's `finally`). Not reentrant.
 */
export class ShadowGroupMerger {
  readonly #states = new WeakMap<THREE.Mesh, MeshState>();
  readonly #swapped: THREE.Mesh[] = [];
  readonly #originals: THREE.BufferGeometry[] = [];
  #budget = 0;
  /** Draws the last frame's swaps saved per cascade, and meshes swapped (bench, tests). */
  readonly stats = { meshes: 0, groupsSaved: 0, copiedIndices: 0 };

  begin(): void {
    this.#budget = SHADOW_MERGE_COPY_BUDGET;
    this.stats.meshes = 0;
    this.stats.groupsSaved = 0;
  }

  swap(mesh: THREE.Mesh): void {
    const material = mesh.material;
    if (!Array.isArray(material)) return;
    const geometry = mesh.geometry;
    if (geometry.groups.length < 2) return;
    let state = this.#states.get(mesh);
    if (state === undefined || stale(state, mesh, material)) {
      const pattern = shadowMergePattern(geometry.groups, material, mesh.customDepthMaterial);
      let twin: THREE.BufferGeometry | null = null;
      if (pattern !== undefined) {
        const copies = shadowMergeCopyCount(geometry, pattern);
        if (copies > this.#budget) return; // left as it is this frame; asked again on the next
        this.#budget -= copies;
        this.stats.copiedIndices += copies;
        twin = twinFor(geometry, pattern);
      }
      state = {
        source: geometry, groupCount: geometry.groups.length, custom: mesh.customDepthMaterial,
        materials: material.slice(), versions: material.map((item) => item?.version ?? 0),
        visible: material.map((item) => item?.visible ?? false),
        sides: material.map((item) => item === undefined ? 0 : (item.shadowSide ?? -1) * 4 + item.side),
        twin,
      };
      this.#states.set(mesh, state);
    }
    const twin = state.twin;
    if (twin === null) return;
    this.#swapped.push(mesh);
    this.#originals.push(geometry);
    mesh.geometry = twin;
    this.stats.meshes++;
    this.stats.groupsSaved += geometry.groups.length - twin.groups.length;
  }

  restore(): void {
    const swapped = this.#swapped;
    const originals = this.#originals;
    for (let index = 0; index < swapped.length; index++) swapped[index]!.geometry = originals[index]!;
    swapped.length = 0;
    originals.length = 0;
  }
}
