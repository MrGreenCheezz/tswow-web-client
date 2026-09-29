import * as THREE from "three";

/** The renderer owns unit visibility; hidden retained rigs need no render-time matrix traversal. */
export class UnitSceneGroup extends THREE.Group {
  override updateMatrixWorld(force?: boolean): void {
    if (!this.visible) return;
    super.updateMatrixWorld(force);
  }

  // Keep Object3D.updateWorldMatrix unchanged: explicit attachment, seat and portrait queries
  // must still be able to refresh a hidden unit's world transform on demand.
}
