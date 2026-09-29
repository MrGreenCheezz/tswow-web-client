import * as THREE from "three";

/**
 * The rig side of a bone whose world matrix can come from a flat pose instead of its own
 * position/quaternion/scale (see `FastPoseState`).
 */
export interface RenderBoneRig {
  readonly fastPoseActive: boolean;
  /**
   * Writes this rig's bone `index` world matrix from the flat pose; false when the pose does not
   * compute that bone. `refreshRoot` first brings the rig root's own world matrix up to date.
   */
  writeFastBoneWorld(index: number, target: THREE.Matrix4, refreshRoot: boolean): boolean;
  /** A reader needed a bone the flat pose does not compute: pose the whole rig next time. */
  requestFullPose(): void;
}

/** Internal rig bone: visible owns render traversal, not the animation or matrix-update policy. */
export class RenderBone extends THREE.Bone {
  /** Set only while its owning rig has a frozen pose and unchanged world root. */
  frozenMatrixBranch = false;
  /**
   * Whether this bone or one below it moves a vertex the rig's geometry draws. Only the rig that
   * owns the bone can know; a bone nobody has classified is treated as one that does.
   */
  skinBranch = true;
  /** The rig this bone belongs to and its index there, once a rig has claimed it. */
  rig: RenderBoneRig | undefined;
  rigIndex = -1;

  constructor() {
    super();
    this.visible = false;
    this.addEventListener("childadded", this.#refreshVisibility);
    this.addEventListener("childremoved", this.#refreshVisibility);
    // No per-instance property redefinition here (a lazy `rotation` accessor was tried): it drops
    // every bone into V8's dictionary mode, and each position/quaternion/matrix read on the hot
    // paths then costs a hash lookup. A flat-posed rig does not write bone quaternions at all.
  }

  // Callers control attachment visibility on the attachment itself. Any unmanaged object
  // (including an ordinary Bone) keeps this branch open: its descendants may change without
  // sending events here. Only managed bone-only paths are omitted from render traversal.
  readonly #refreshVisibility = (): void => {
    const visible = this.children.some((child) => !(child instanceof RenderBone) || child.visible);
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.parent instanceof RenderBone) this.parent.#refreshVisibility();
  };

  override updateMatrixWorld(force?: boolean): void {
    const rig = this.rig;
    if (rig !== undefined && rig.fastPoseActive) {
      // A flat-posed rig builds its palette from the pose, so the scene pass only has to place
      // what hangs on its bones: a weapon, a saddle's rider, an item. Bone-only branches are skipped.
      if (!this.visible) return;
      if (rig.writeFastBoneWorld(this.rigIndex, this.matrixWorld, false)) {
        this.matrixWorldNeedsUpdate = false;
        const children = this.children;
        for (let index = 0, count = children.length; index < count; index++) children[index]!.updateMatrixWorld(true);
        return;
      }
      rig.requestFullPose();
    }
    // A hidden managed branch has no attachments to place. When it is frozen its cached world
    // matrices are already the ones in the skeleton palette; when no drawn vertex follows any bone
    // in it, the palette never reads them. Either way the render pass need not visit it. Explicit
    // readers (emitters, spell anchors, billboards) use updateWorldMatrix, which this leaves alone.
    if (!this.visible && (this.frozenMatrixBranch || !this.skinBranch)) return;
    super.updateMatrixWorld(force);
  }

  // `force` is Three's own: a parent whose world matrix changed passes it down, and a child that
  // keeps its local matrix (a frozen bone) recomposes only because of it.
  override updateWorldMatrix(updateParents: boolean, updateChildren: boolean, force = false): void {
    const rig = this.rig;
    if (rig !== undefined && rig.fastPoseActive) {
      if (rig.writeFastBoneWorld(this.rigIndex, this.matrixWorld, updateParents)) {
        this.matrixWorldNeedsUpdate = false;
        if (updateChildren) {
          const children = this.children;
          for (let index = 0, count = children.length; index < count; index++) children[index]!.updateWorldMatrix(false, true, true);
        }
        return;
      }
      // A walk down from the root passes through bone-only branches nobody reads; leave them. A
      // bone somebody asked for by name, or one carrying an attachment, needs the whole rig.
      if (!updateParents && !this.visible) return;
      rig.requestFullPose();
    }
    super.updateWorldMatrix(updateParents, updateChildren, force);
  }

  override copy(source: THREE.Object3D, recursive = true): this {
    super.copy(source, recursive);
    this.#refreshVisibility();
    return this;
  }
}
