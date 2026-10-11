/**
 * 12.10 (7.27): the collision model's group index is not the WMO file's.
 *
 * The bakes (`<root>_<group>_…`) and the portal graph (MOPR) number groups as the WMO files do. The collision
 * floor the locator stands on numbers them as the `.vmo` does, and the vmap extractor leaves groups out:
 * 12.10 census of the 788 baked roots against this dataset's vmaps — 37 roots lose 48 groups (21 of them MOGP
 * 0x80), and 405 of 6,124 baked groups sit at another index in the `.vmo`: Stormwind loses groups 82 and
 * 93, which moves 163 of its 190 baked groups, Stormwind Harbor 215 of 300. The 05.10 slice looked the bakes
 * up by the collision index, so most of Stormwind's rooms showed a neighbour's picture.
 *
 * The visual WMO artifact keeps every group in file order (12.10: no baked root loses one in
 * `tools/wmo-visual.mjs`), so the two are lined up once per building: the `.vmo` is the file's groups in
 * order with some left out, and a kept group has the same MOGP flags and box in both. The same walk gives the
 * MOGP group ids the room walk needs (`wmoMinimapWalkStops`). A model that does not line up gives no answer,
 * and the caller keeps the terrain minimap.
 */

import { wmoMinimapWalkStops, type WmoMinimapBounds } from "./WmoMinimapSelect.js";

export interface WmoMinimapAlignment {
  /** File (visual) group index of each collision group; −1 never happens in an answer that lined up. */
  readonly visualOfCollision: Int32Array;
  /** 1 for a file group whose MOGP id 0x007AFC70 never walks into (known only for groups the `.vmo` keeps). */
  readonly stops: Uint8Array;
}

const SAME = 1e-3;

function sameBounds(left: WmoMinimapBounds, right: WmoMinimapBounds): boolean {
  return Math.abs(left.minX - right.minX) <= SAME && Math.abs(left.minY - right.minY) <= SAME
    && Math.abs(left.minZ - right.minZ) <= SAME && Math.abs(left.maxX - right.maxX) <= SAME
    && Math.abs(left.maxY - right.maxY) <= SAME && Math.abs(left.maxZ - right.maxZ) <= SAME;
}

/** Lines the collision groups up with the file's; undefined when some collision group has no partner. */
export function alignWmoMinimapGroups(
  visual: readonly { readonly bounds: WmoMinimapBounds; readonly flags: number }[],
  collision: readonly { readonly bounds: WmoMinimapBounds; readonly flags: number; readonly groupId: number }[],
): WmoMinimapAlignment | undefined {
  const visualOfCollision = new Int32Array(collision.length).fill(-1);
  const stops = new Uint8Array(visual.length);
  let next = 0;
  for (let index = 0; index < visual.length && next < collision.length; index++) {
    const kept = collision[next]!;
    const group = visual[index]!;
    if (group.flags !== kept.flags || !sameBounds(group.bounds, kept.bounds)) continue;
    visualOfCollision[next] = index;
    if (wmoMinimapWalkStops(kept.groupId)) stops[index] = 1;
    next++;
  }
  return next === collision.length ? { visualOfCollision, stops } : undefined;
}

const known = new WeakMap<object, { readonly collision: object; readonly answer: WmoMinimapAlignment | undefined }>();

/** `alignWmoMinimapGroups`, once per (visual groups, collision groups) pair. */
export function wmoMinimapAlignment(
  visual: readonly { readonly bounds: WmoMinimapBounds; readonly flags: number }[],
  collision: readonly { readonly bounds: WmoMinimapBounds; readonly flags: number; readonly groupId: number }[],
): WmoMinimapAlignment | undefined {
  const cached = known.get(visual);
  if (cached && cached.collision === collision) return cached.answer;
  const answer = alignWmoMinimapGroups(visual, collision);
  known.set(visual, { collision, answer });
  return answer;
}
