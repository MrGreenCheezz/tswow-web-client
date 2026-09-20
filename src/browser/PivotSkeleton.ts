import * as THREE from "three";

const offset = new THREE.Matrix4();
const identity = new THREE.Matrix4();

/** M2 bind poses translate to bone pivots. Preserve general Skeleton semantics for other poses. */
export class PivotSkeleton extends THREE.Skeleton {
  override update(): void {
    const bones = this.bones, inverses = this.boneInverses, palette = this.boneMatrices!;
    for (let i = 0; i < bones.length; i++) {
      const matrix = bones[i]?.matrixWorld ?? identity;
      const inverse = inverses[i]!;
      const b = inverse.elements, a = matrix.elements;
      const base = i * 16;
      // Inverses are public and can be changed by bind/pose or their caller. Check the actual
      // values, not their identity. Non-finite worlds retain Three's full IEEE arithmetic.
      if (b[0] !== 1 || b[1] !== 0 || b[2] !== 0 || b[3] !== 0
        || b[4] !== 0 || b[5] !== 1 || b[6] !== 0 || b[7] !== 0
        || b[8] !== 0 || b[9] !== 0 || b[10] !== 1 || b[11] !== 0 || b[15] !== 1
        || !Number.isFinite(a[0]! + a[1]! + a[2]! + a[3]! + a[4]! + a[5]! + a[6]! + a[7]!
          + a[8]! + a[9]! + a[10]! + a[11]! + a[12]! + a[13]! + a[14]! + a[15]!)) {
        offset.multiplyMatrices(matrix, inverse).toArray(palette, base);
        continue;
      }
      for (let j = 0; j < 12; j++) palette[base + j] = a[j]!;
      const x = b[12]!, y = b[13]!, z = b[14]!;
      palette[base + 12] = a[0]! * x + a[4]! * y + a[8]! * z + a[12]!;
      palette[base + 13] = a[1]! * x + a[5]! * y + a[9]! * z + a[13]!;
      palette[base + 14] = a[2]! * x + a[6]! * y + a[10]! * z + a[14]!;
      palette[base + 15] = a[3]! * x + a[7]! * y + a[11]! * z + a[15]!;
    }
    if (this.boneTexture !== null) this.boneTexture.needsUpdate = true;
  }
}
