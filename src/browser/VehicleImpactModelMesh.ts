import * as THREE from "three";
import {
  applyGlobalSequenceBones, buildSkinnedTemplateFrom, disposeSkinnedInstance, instantiateSkinned,
  type SkinnedInstance, type SkinnedTemplate,
} from "./AnimatedModel.js";
import { updateBatchAppearance, type BuiltModel } from "./ModelBuild.js";
import type { ProjectedBatch } from "./ProjectedDecals.js";
import type { WvmModel } from "./Wvm.js";
import { impactModelScale, type VehicleAimArcShape } from "./VehicleAimArcShape.js"; // worker-safe: no page context

/**
 * 11.02 (15.11, vehicle9): MsslTrgtImpactModel on screen — the volume marks of a steered siege engine's aim, as Wow.exe
 * 3.3.5a's UnitMissileTrajectory_C places them (0x006fda20, .runtime/re-2026-10-03/l1102e/r2.c; the loader 0x006fe9b0 and
 * the drop 0x006fbfa0 in .runtime/re-2026-11-15/vehicle8/b2.c; 0x004f5e80 and 0x008251d0 in re-2026-11-15/vehicle9/c1.c):
 *
 * - Each frame the arc's flight is found, each loaded model i stands at the impact, turned to the mover's facing and scaled
 *   so that its bounding radius becomes MsslTrgtImpactRadius[i] (0x008251d0: identity, the yaw, the scale, then the point).
 *   0x004f5e80 reads the radius at +0xb8 of the M2 header (after the bounding box at +0xa0), which is the WVM header's
 *   `bounds.radius` (tools/m2.mjs `readBounds`); a model without one takes the radius itself (`impactModelScale`).
 * - The model's alpha (+0x178) is the arc's strength, so it fades with the arc's lingering; once the strength is 0 the
 *   draw callback drops it (0x006fbfa0) — here `hide`.
 * - The models are loaded when the unit the keys move changes and let go when it changes again (0x006fe9b0 → 0x006fbf00):
 *   here built on the first frame the file is there and kept while the path stays the same.
 *
 * Loaded and built the way a spell's effect model is (WorldRenderer3D `#updateVisuals`): the same `model(path)` request,
 * every geoset, the rig with the global-sequence bones (Vehicle_Target_02 spins on two of them), the batches' own colour and
 * weight tracks on the wall clock, and the batches M2 flag 4 marks projected onto the ground (ProjectedDecals.ts; all four of
 * Vehicle_Target_02's are). In the page and the render worker alike: this runs inside the renderer, which is where both are.
 * Until a model has arrived nothing of it shows; the impact texture's mark (VehicleAimArcMesh.ts) is drawn independently.
 */

/** What the renderer lends: a build of a model, and the projected batches' registry. */
export interface ImpactModelHost {
  build(model: WvmModel, path: string): BuiltModel;
  /** Hands the batches the build kept out of the mesh to the decal pass, for as long as `mesh` is in the scene. */
  project(mesh: THREE.Mesh, batches: readonly ProjectedBatch[] | undefined): void;
}

interface Slot {
  path: string;
  node: THREE.Group;
  /** Undefined until the file has arrived and been built. */
  built: BuiltModel | undefined;
  wvm: WvmModel | undefined;
  mesh: THREE.Mesh | undefined;
  skinned: SkinnedInstance | undefined;
  template: SkinnedTemplate | undefined;
  /** Every material of the build, the projected batches' included, and each one's opacity as built. */
  materials: THREE.Material[];
  baseOpacity: number[];
}

/** The placement 0x008251d0 gives one model this frame: the impact point (world), the facing and the scale. */
export function impactModelPlacement(shape: Pick<VehicleAimArcShape, "points" | "facing">, radius: number, boundsRadius: number):
  { x: number; y: number; z: number; yaw: number; scale: number } | undefined {
  const last = shape.points.length - 3;
  if (last < 0) return undefined;
  return {
    x: shape.points[last]!, y: shape.points[last + 1]!, z: shape.points[last + 2]!,
    yaw: shape.facing, scale: impactModelScale(radius, boundsRadius),
  };
}

/** The models of the arc, two slots at most, as 0x006fe9b0 loads them. */
export class VehicleImpactModelMesh {
  readonly #group = new THREE.Group();
  readonly #host: ImpactModelHost;
  readonly #slots: (Slot | undefined)[] = [];

  constructor(parent: THREE.Object3D, host: ImpactModelHost) {
    this.#host = host;
    this.#group.name = "vehicle-impact-models";
    this.#group.visible = false;
    parent.add(this.#group);
  }

  /** How many of the slots have a built model (tests, diagnostics). */
  get builtCount(): number {
    let count = 0;
    for (const slot of this.#slots) if (slot?.built !== undefined) count++;
    return count;
  }

  hide(): void {
    this.#group.visible = false;
  }

  /**
   * The frame's arc (`now` in ms, the wall clock the models' global loops run on). `model`: the decoded file, or undefined while
   * it is on its way (`EnvironmentClient.model`, which queues it).
   */
  update(shape: VehicleAimArcShape, now: number, model: (path: string) => WvmModel | undefined): void {
    const models = shape.impactModels ?? [];
    const strength = Math.max(0, Math.min(1, shape.opacity));
    // 0x006fbfa0: a strength of nothing drops the drawn models.
    this.#group.visible = strength > 0 && models.length > 0;
    for (let index = 0; index < Math.max(models.length, this.#slots.length); index++) {
      const wanted = models[index];
      let slot = this.#slots[index];
      if (slot !== undefined && slot.path !== wanted?.path) {
        this.#dispose(slot);
        slot = this.#slots[index] = undefined;
      }
      if (wanted === undefined || !this.#group.visible) continue;
      slot ??= this.#slots[index] = this.#slot(wanted.path);
      if (slot.built === undefined && !this.#build(slot, model)) continue;
      const placement = impactModelPlacement(shape, wanted.radius, slot.wvm!.bounds.radius);
      if (placement === undefined || !(placement.scale > 0) || !Number.isFinite(placement.scale)) {
        slot.node.visible = false;
        continue;
      }
      slot.node.visible = true;
      slot.node.position.set(placement.x, placement.z, -placement.y);
      slot.node.rotation.set(0, placement.yaw, 0);
      slot.node.scale.setScalar(placement.scale);
      this.#animate(slot, strength, now);
    }
  }

  #slot(path: string): Slot {
    const node = new THREE.Group();
    node.visible = false;
    this.#group.add(node);
    return {
      path, node, built: undefined, wvm: undefined, mesh: undefined, skinned: undefined, template: undefined, materials: [], baseOpacity: [],
    };
  }

  /** The spell effect's build (WorldRenderer3D `#updateVisuals`), once the file is in. */
  #build(slot: Slot, model: (path: string) => WvmModel | undefined): boolean {
    const wvm = model(slot.path);
    if (wvm === undefined) return false;
    const built = this.#host.build(wvm, slot.path);
    slot.wvm = wvm;
    slot.built = built;
    for (const material of new Set<THREE.Material>([...built.materials, ...(built.projected ?? []).map((batch) => batch.material)])) {
      // The model's alpha fades every batch with the arc (+0x178), an opaque one too.
      material.transparent = true;
      slot.materials.push(material);
      slot.baseOpacity.push(material.opacity);
    }
    const rig = wvm.skeleton;
    if (rig !== undefined) {
      // An emitter-only or clip-less rig still needs its skeleton for the global-sequence bones, as a spell model's does.
      const templateRig = rig.clips.length === 0 && rig.animations.length === 0 ? { ...rig, animations: [0] } : rig;
      const template = buildSkinnedTemplateFrom(built.geometry, templateRig, built.height);
      if (template !== undefined) {
        slot.template = template;
        slot.skinned = instantiateSkinned(template, built.materials);
        slot.node.add(slot.skinned.root);
        this.#host.project(slot.skinned.mesh, built.projected);
        return true;
      }
    }
    if (built.materials.length > 0 || built.projected !== undefined) {
      slot.mesh = new THREE.Mesh(built.geometry, built.materials);
      slot.node.add(slot.mesh);
      this.#host.project(slot.mesh, built.projected);
    }
    return true;
  }

  #animate(slot: Slot, strength: number, now: number): void {
    const materials = slot.materials;
    for (let index = 0; index < materials.length; index++) materials[index]!.opacity = slot.baseOpacity[index]!;
    // The batches' own colour and weight tracks first, then the model's alpha over every batch, projected ones included
    // (ProjectedDecals reads the batch material's opacity each frame).
    updateBatchAppearance(slot.built!.animatedBatches, now);
    for (const material of materials) material.opacity *= strength;
    if (slot.skinned !== undefined && slot.template !== undefined) {
      applyGlobalSequenceBones(slot.skinned, slot.template, slot.wvm!.globalSequences, now);
    }
  }

  #dispose(slot: Slot): void {
    this.#group.remove(slot.node);
    disposeSkinnedInstance(slot.skinned);
    const built = slot.built;
    if (built !== undefined) {
      built.geometry.dispose();
      for (const material of slot.materials) material.dispose();
      for (const texture of new Set(built.ownedTextures)) texture.dispose();
    }
    slot.built = undefined;
    slot.skinned = undefined;
    slot.mesh = undefined;
  }

  dispose(): void {
    for (const slot of this.#slots) if (slot !== undefined) this.#dispose(slot);
    this.#slots.length = 0;
    this.#group.parent?.remove(this.#group);
  }
}
