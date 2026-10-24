/**
 * P2-01a: the shadow pass's casters as a flat list instead of a walk of the scene graph.
 *
 * Three's shadow pass (`WebGLShadowMap.renderObject`) walks the whole scene for every cascade:
 * every placement node, room group, unit and attachment is visited twice a frame although only
 * the meshes flagged `castShadow` can draw. The renderer registers each caster here where it writes
 * that flag; once a frame `beginFrame` picks the entries whose chain of parents is visible (so
 * warm holds, hidden rooms and hidden units keep working by themselves) and that their owner's gate
 * admits; `fill` hands them to three under a synthetic root, sorted by kind. Layers, the light
 * frustum, depth materials and `objects.update` stay three's: the set of draws is the one the walk
 * would have made, only the nodes that cannot draw are no longer visited.
 *
 * The entries stay where they are in the scene graph, so `scene.updateMatrixWorld()` keeps their
 * matrices current; the root and its kind groups live outside the scene and are never updated.
 */

import * as THREE from "three";

/**
 * 0 — does not cast now; 1 — casts when its whole chain is visible; 2 — "shadow-only": the owner's
 * own `visible` is ignored (retained scenery the view did not admit still casts into the view),
 * the rest of the chain is checked as usual.
 *
 * Limit of 0: it only keeps the entry itself out of the root. An entry nested under an active
 * registered ancestor is drawn by three's recursion through that ancestor whatever its own gate
 * says, so 0 does not silence it there (no gate answers 0 today; a caller that needs it under a
 * registered ancestor must also clear `castShadow`).
 */
export type CasterGate = (ref: unknown) => 0 | 1 | 2;

/** Kind order three's depth material is shared across: each boundary re-derives its program. */
export const SHADOW_CASTER_KINDS = ["plain", "instanced", "instanced-colour", "skinned"] as const;
export type ShadowCasterKind = typeof SHADOW_CASTER_KINDS[number];
const BUCKETS = SHADOW_CASTER_KINDS.length * 2;
/**
 * Frames a detached entry is kept before it is dropped: a room or attachment hung back soon casts
 * at once.
 *
 * Contract: once dropped, an entry is gone even if the same object is hung back into the scene
 * later — it casts again only from the next `set(mesh, true)`. Any path that re-attaches a cached
 * node (pooled attachments, reused unit meshes) must re-`set` its casters, or rely on a writer that
 * re-sets every caster it flags (the unit shadow policy does whenever `shadowCaster` is forgotten).
 * Since P2-02a the scenery sync no longer re-sets scenery on a cadence: placements, instance
 * buckets and WMO rooms are set where they are built, settled, made or hung, and in the walk on a
 * leaf or room-light transition. A path that re-hangs a cached scenery node must call the
 * renderer's `#sceneryShadowsForPlacement`, `#sceneryShadowsForInstance` or `#syncWmoRoomShadow`.
 */
export const SHADOW_CASTER_PRUNE_FRAMES = 600;

interface Entry {
  readonly mesh: THREE.Mesh;
  owner: THREE.Object3D | undefined;
  gate: CasterGate | undefined;
  ref: unknown;
  /** Has an alpha-keyed group: three gives it a private depth-material clone. */
  alphaKey: boolean;
  dead: boolean;
  detached: number;
  /** Frame it was last active; an active ancestor entry covers it. */
  active: number;
}

export interface ShadowCasterListStats {
  /** Registered entries. */
  entries: number;
  /** Entries handed to the cascades on the last frame. */
  emitted: number;
  /** Active entries left out because an active registered ancestor already reaches them. */
  nested: number;
  /** Entries dropped since construction because their chain stopped reaching the scene. */
  pruned: number;
  /**
   * Owners whose casters reach the shadow pass only through gate 2 (the owner itself hidden), last
   * frame. Not the count of the pre-P2-01 shadow-only toggle, which counted every node it showed,
   * casting or not: hence the different name.
   */
  shadowOnlyOwners: number;
  /** Emitted entries per kind, in `SHADOW_CASTER_KINDS` order. */
  readonly byKind: number[];
  /** Active-chain entries per gate answer 0 / 1 / 2. */
  readonly byGate: number[];
}

export function shadowCasterKind(mesh: THREE.Mesh): number {
  const instanced = mesh as THREE.InstancedMesh;
  if (instanced.isInstancedMesh) return instanced.instanceColor ? 2 : 1;
  return (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 3 : 0;
}

function alphaKeyed(mesh: THREE.Mesh): boolean {
  const material = mesh.material;
  if (Array.isArray(material)) {
    for (const item of material) if (item && item.alphaTest > 0 && ((item as THREE.MeshStandardMaterial).map || (item as THREE.MeshStandardMaterial).alphaMap)) return true;
    return false;
  }
  return material.alphaTest > 0 && Boolean((material as THREE.MeshStandardMaterial).map || (material as THREE.MeshStandardMaterial).alphaMap);
}

/** The synthetic root three walks instead of the scene: its children are the kind groups. */
export class ShadowCasterRoot extends THREE.Object3D {
  readonly groups: THREE.Object3D[] = [];
  constructor() {
    super();
    this.name = "shadowCasters";
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    for (let index = 0; index < BUCKETS; index++) {
      const group = new THREE.Object3D();
      group.matrixAutoUpdate = false;
      group.matrixWorldAutoUpdate = false;
      this.groups.push(group);
    }
  }
}

export class ShadowCasterList {
  readonly #entries = new Map<THREE.Mesh, Entry>();
  readonly #order: Entry[] = [];
  #dead = 0;
  #frame = 0;
  /** Active entries with children: the only ones that can cover another entry. */
  readonly #covers = new Set<THREE.Object3D>();
  readonly #buckets: THREE.Object3D[][] = Array.from({ length: BUCKETS }, () => []);
  readonly #shown = new Set<THREE.Object3D>();
  /** Gate-2 casters that are their own owner and hidden: shown around the pass (see showShadowOnly). */
  readonly #selfOwned: THREE.Object3D[] = [];
  readonly stats: ShadowCasterListStats = {
    entries: 0, emitted: 0, nested: 0, pruned: 0, shadowOnlyOwners: 0,
    byKind: SHADOW_CASTER_KINDS.map(() => 0), byGate: [0, 0, 0],
  };

  /**
   * Registers or drops a caster; call it wherever `castShadow` is written, with the same value.
   * `owner` is the node whose own `visible` gate 2 ignores and `ref` what `gate` is asked about
   * (positional rather than an options object: the scenery sync calls this for every mesh).
   */
  set(mesh: THREE.Mesh, casts: boolean, owner?: THREE.Object3D, gate?: CasterGate, ref?: unknown): void {
    const existing = this.#entries.get(mesh);
    if (!casts) {
      if (existing) this.#drop(existing);
      return;
    }
    if (existing) {
      existing.owner = owner;
      existing.gate = gate;
      existing.ref = ref;
      existing.alphaKey = alphaKeyed(mesh);
      return;
    }
    const entry: Entry = { mesh, owner, gate, ref, alphaKey: alphaKeyed(mesh), dead: false, detached: 0, active: -1 };
    this.#entries.set(mesh, entry);
    this.#order.push(entry);
    this.stats.entries = this.#entries.size;
  }

  has(mesh: THREE.Mesh): boolean {
    return this.#entries.has(mesh);
  }

  #drop(entry: Entry): void {
    entry.dead = true;
    this.#entries.delete(entry.mesh);
    this.#dead++;
    this.stats.entries = this.#entries.size;
  }

  /** Forgets every entry (the renderer's world went away). */
  clear(): void {
    for (const entry of this.#order) entry.dead = true;
    this.#order.length = 0;
    this.#entries.clear();
    this.#dead = 0;
    for (const bucket of this.#buckets) bucket.length = 0;
    this.stats.entries = 0;
  }

  /**
   * Picks this frame's casters, once per frame before the first cascade renders. An entry is
   * active when its chain of parents reaches `scene` with every node visible — its owner excepted
   * under gate 2 — and its gate is not 0. One with an active registered ancestor is left to three's
   * own recursion through that ancestor, so nothing is drawn twice.
   */
  beginFrame(scene: THREE.Object3D): void {
    const frame = ++this.#frame;
    const order = this.#order;
    if (this.#dead > 0) {
      let write = 0;
      for (let read = 0; read < order.length; read++) {
        const entry = order[read]!;
        if (!entry.dead) order[write++] = entry;
      }
      order.length = write;
      this.#dead = 0;
    }
    const stats = this.stats;
    const byGate = stats.byGate;
    byGate[0] = 0; byGate[1] = 0; byGate[2] = 0;
    const covers = this.#covers;
    covers.clear();
    const shown = this.#shown;
    shown.clear();
    const selfOwned = this.#selfOwned;
    selfOwned.length = 0;
    let active = 0;
    for (let index = 0; index < order.length; index++) {
      const entry = order[index]!;
      const mesh = entry.mesh;
      const gate = entry.gate === undefined ? 1 : entry.gate(entry.ref);
      const skip = gate === 2 ? entry.owner : undefined;
      let visible = mesh.visible || mesh === skip;
      let node: THREE.Object3D = mesh;
      for (let parent = node.parent; parent !== null; parent = node.parent) {
        if (visible && !parent.visible && parent !== skip) visible = false;
        node = parent;
      }
      if (node !== scene) {
        if (++entry.detached >= SHADOW_CASTER_PRUNE_FRAMES) {
          this.#drop(entry);
          stats.pruned++;
        }
        continue;
      }
      entry.detached = 0;
      if (!visible) continue;
      byGate[gate] = (byGate[gate] ?? 0) + 1;
      if (gate === 0) continue;
      if (skip !== undefined && !skip.visible) {
        shown.add(skip);
        if (skip === mesh) selfOwned.push(mesh);
      }
      entry.active = frame;
      active++;
      if (mesh.children.length > 0) covers.add(mesh);
    }
    stats.shadowOnlyOwners = shown.size;
    shown.clear();
    const buckets = this.#buckets;
    for (const bucket of buckets) bucket.length = 0;
    const byKind = stats.byKind;
    for (let index = 0; index < byKind.length; index++) byKind[index] = 0;
    let nested = 0;
    for (let index = 0; index < order.length; index++) {
      const entry = order[index]!;
      if (entry.active !== frame || entry.dead) continue;
      const mesh = entry.mesh;
      if (covers.size > 0) {
        let covered = false;
        for (let parent = mesh.parent; parent !== null; parent = parent.parent) {
          if (covers.has(parent)) { covered = true; break; }
        }
        if (covered) { nested++; continue; }
      }
      const kind = shadowCasterKind(mesh);
      byKind[kind]!++;
      buckets[kind * 2 + (entry.alphaKey ? 1 : 0)]!.push(mesh);
    }
    covers.clear();
    stats.nested = nested;
    stats.emitted = active - nested;
    stats.entries = this.#entries.size;
  }

  /**
   * Three's shadow walk stops at an object whose own `visible` is false, and the root hands it the
   * entries themselves: a gate-2 entry that is its own owner (a legacy placement whose node is the
   * mesh) would be skipped. Call this after `beginFrame`, before the cascades render, and
   * `hideShadowOnly` in their `finally` — the old shadow-only toggle's show/hide, for these alone.
   */
  showShadowOnly(): void {
    for (const mesh of this.#selfOwned) mesh.visible = true;
  }

  hideShadowOnly(): void {
    for (const mesh of this.#selfOwned) mesh.visible = false;
  }

  /**
   * Hands this frame's casters to `root`, kind by kind; odd views take the kinds in the mirrored
   * order, so consecutive cascades meet on the same kind and three keeps its depth program across
   * the boundary. Returns the number of meshes handed over.
   */
  fill(root: ShadowCasterRoot, view: number): number {
    const groups = root.groups;
    const buckets = this.#buckets;
    const children = root.children;
    children.length = 0;
    let count = 0;
    for (let index = 0; index < BUCKETS; index++) {
      const slot = (view & 1) === 0 ? index : BUCKETS - 1 - index;
      const group = groups[slot]!;
      // The kind group borrows the bucket as its children; their `parent` stays the scene's.
      group.children = buckets[slot]!;
      count += group.children.length;
      children.push(group);
    }
    return count;
  }
}

/**
 * Three's shadow walk (`WebGLShadowMap.renderObject`, r185) as a pure function, for tests and the
 * bench census: pushes every mesh three would draw for `camera`'s layers inside `frustum`. `shown`
 * stands for nodes a caller makes visible for the shadow pass only.
 */
export function referenceShadowWalk(
  object: THREE.Object3D,
  camera: THREE.Camera,
  frustum: THREE.Frustum,
  out: THREE.Mesh[],
  shown?: (node: THREE.Object3D) => boolean,
): void {
  if (!object.visible && !(shown?.(object) ?? false)) return;
  const mesh = object as THREE.Mesh;
  if (object.layers.test(camera.layers) && mesh.isMesh && mesh.castShadow
    && (!object.frustumCulled || frustum.intersectsObject(object))) out.push(mesh);
  for (const child of object.children) referenceShadowWalk(child, camera, frustum, out, shown);
}

/** Draw calls three makes for one mesh in the shadow pass: one per group with a visible material. */
export function shadowDrawCount(mesh: THREE.Mesh): number {
  const material = mesh.material;
  if (!Array.isArray(material)) return material.visible ? 1 : 0;
  let count = 0;
  for (const group of mesh.geometry.groups) {
    const item = material[group.materialIndex ?? 0];
    if (item && item.visible) count++;
  }
  return count;
}
