/**
 * 15.11 (7.54): which outdoor groups of a placed WMO the terrain's horizon hides (`0x79a160` -> `0x78fdc0` on the
 * group's world box, flag 1: a corner nearer than 50 keeps it). Groups with MOGP 0x8 or 0x10000 are the ones
 * Wow.exe keeps as outdoor nodes (`0x7b3a10` handles exactly those two); rooms are reached through portals only.
 * The answer is read from the horizon's snapshots, so it may be asked after `TerrainHorizon.run`.
 */

import type { WmoBounds } from "./WmoModel.js";
import type { TerrainHorizon } from "./TerrainHorizon.js";

const NODE_FLAGS = 0x8 | 0x10000;

/**
 * Fills `out` (one byte per group, 1 = hidden) for a placement whose model space goes to Wow's world axes by
 * `modelToWorld` (column-major 4x4). False when the horizon is not active this frame (then `out` is all 0).
 */
export function wmoGroupsBehindHorizon(
  horizon: TerrainHorizon,
  groups: readonly { readonly bounds: WmoBounds; readonly flags: number }[],
  modelToWorld: ArrayLike<number>,
  out: Uint8Array,
): boolean {
  out.fill(0, 0, groups.length);
  if (!horizon.active) return false;
  const m = modelToWorld;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if ((group.flags & NODE_FLAGS) === 0) continue;
    const b = group.bounds;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const x = (corner & 1) !== 0 ? b.maxX : b.minX;
      const y = (corner & 2) !== 0 ? b.maxY : b.minY;
      const z = (corner & 4) !== 0 ? b.maxZ : b.minZ;
      const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    const bucket = horizon.bucketOf(minX, minY, minZ, maxX, maxY, maxZ);
    if (bucket > 0 && horizon.boxHidden(minX, minY, minZ, maxX, maxY, maxZ, bucket)) out[index] = 1;
  }
  return true;
}
