import { RenderBone } from "./RenderBone.js";

/** The ordinary Bone contract with a fused TRS/affine path for automatically managed rigs. */
export class RigMatrixBone extends RenderBone {
  override updateMatrixWorld(force?: boolean): void {
    const parent = this.parent;
    const a = parent?.matrixWorld.elements;
    if (!this.matrixAutoUpdate || this.matrixWorldAutoUpdate !== true || this.pivot !== null
      || (a && (a[3] !== 0 || a[7] !== 0 || a[11] !== 0 || a[15] !== 1))) {
      super.updateMatrixWorld(force);
      return;
    }

    const p = this.position, q = this.quaternion, s = this.scale;
    const px = p.x, py = p.y, pz = p.z;
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const sx = s.x, sy = s.y, sz = s.z;
    // Invalid transforms retain Three's full IEEE arithmetic, including its last matrix row.
    if (!Number.isFinite(px + py + pz + x + y + z + w + sx + sy + sz)) {
      super.updateMatrixWorld(force);
      return;
    }
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    // Same expression order as Matrix4.compose: bind poses and GPU palettes remain exact.
    const b0 = (1 - (yy + zz)) * sx, b1 = (xy + wz) * sx, b2 = (xz - wy) * sx;
    const b4 = (xy - wz) * sy, b5 = (1 - (xx + zz)) * sy, b6 = (yz + wx) * sy;
    const b8 = (xz + wy) * sz, b9 = (yz - wx) * sz, b10 = (1 - (xx + yy)) * sz;
    const local = this.matrix.elements, world = this.matrixWorld.elements;
    local[0] = b0; local[1] = b1; local[2] = b2; local[3] = 0;
    local[4] = b4; local[5] = b5; local[6] = b6; local[7] = 0;
    local[8] = b8; local[9] = b9; local[10] = b10; local[11] = 0;
    local[12] = px; local[13] = py; local[14] = pz; local[15] = 1;

    if (a) {
      const a0 = a[0]!, a1 = a[1]!, a2 = a[2]!;
      const a4 = a[4]!, a5 = a[5]!, a6 = a[6]!;
      const a8 = a[8]!, a9 = a[9]!, a10 = a[10]!;
      const a12 = a[12]!, a13 = a[13]!, a14 = a[14]!;
      const z0 = a12 * 0, z1 = a13 * 0, z2 = a14 * 0;
      world[0] = a0 * b0 + a4 * b1 + a8 * b2 + z0;
      world[1] = a1 * b0 + a5 * b1 + a9 * b2 + z1;
      world[2] = a2 * b0 + a6 * b1 + a10 * b2 + z2;
      world[3] = 0;
      world[4] = a0 * b4 + a4 * b5 + a8 * b6 + z0;
      world[5] = a1 * b4 + a5 * b5 + a9 * b6 + z1;
      world[6] = a2 * b4 + a6 * b5 + a10 * b6 + z2;
      world[7] = 0;
      world[8] = a0 * b8 + a4 * b9 + a8 * b10 + z0;
      world[9] = a1 * b8 + a5 * b9 + a9 * b10 + z1;
      world[10] = a2 * b8 + a6 * b9 + a10 * b10 + z2;
      world[11] = 0;
      world[12] = a0 * px + a4 * py + a8 * pz + a12;
      world[13] = a1 * px + a5 * py + a9 * pz + a13;
      world[14] = a2 * px + a6 * py + a10 * pz + a14;
      world[15] = 1;
    } else {
      this.matrixWorld.copy(this.matrix);
    }
    this.matrixWorldNeedsUpdate = false;
    // Automatic local recomposition forces descendants in Object3D as well. Do not skip
    // attachments, foreign Bone subclasses or children with manually controlled matrices.
    for (let i = 0, length = this.children.length; i < length; i++) this.children[i]!.updateMatrixWorld(true);
  }
}
