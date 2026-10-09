/**
 * RND-12: the scenery group of the scene, which does not walk frozen placements every frame.
 *
 * Contract: the group stays at identity (it never has), and only a direct child's own
 * `matrixWorldNeedsUpdate` reopens its walk — a node hung under a frozen placement later writes its
 * own world matrix when it is hung (see the freeze in `#updateEnvironment`).
 *
 * three r185's `Object3D.updateMatrixWorld` recurses into every child whatever its flags say —
 * `matrixWorldAutoUpdate = false` only stops the child writing its own world matrix — and the scene
 * recomposes its own matrix every frame, so the walk arrives forced. Placements freeze both flags
 * once their matrices are composed (`#updateEnvironment`), so the render pass still visited each of
 * them and every mesh under them: about 2,900 calls a frame in the city bench, for matrices that
 * cannot change.
 *
 * A frozen child's world matrix depends only on its own frozen local matrix — refreshed explicitly
 * with `updateMatrixWorld(true)` wherever it changes (placement, a settling tree) — and on this
 * group's world matrix. So this group skips a child that keeps neither matrix up to date and has no
 * pending update, unless its own world matrix actually moved; every other child is walked exactly
 * as three walks it, forced or not. A room hung on a frozen building is frozen as it is hung
 * (`#updateWmoGroups`), and its shadow stand-in's world matrix is written when it is made.
 */

import * as THREE from "three";

export class StaticSceneryGroup extends THREE.Group {
  readonly #lastWorld = new THREE.Matrix4();
  #placed = false;

  override updateMatrixWorld(force?: boolean): void {
    if (this.matrixAutoUpdate) this.updateMatrix();
    let forced = force === true;
    if (this.matrixWorldNeedsUpdate || forced) {
      if (this.matrixWorldAutoUpdate) {
        if (this.parent === null) this.matrixWorld.copy(this.matrix);
        else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      forced = true;
    }
    // Belt and braces for the identity contract: were the group ever moved, its children would be
    // walked again (frozen ones keep their own matrices then, exactly as three leaves them).
    const moved = !this.#placed || !this.matrixWorld.equals(this.#lastWorld);
    if (moved) {
      this.#lastWorld.copy(this.matrixWorld);
      this.#placed = true;
    }
    const children = this.children;
    for (let index = 0, count = children.length; index < count; index++) {
      const child = children[index]!;
      if (moved || child.matrixAutoUpdate || child.matrixWorldAutoUpdate || child.matrixWorldNeedsUpdate) {
        child.updateMatrixWorld(forced);
      }
    }
  }
}
