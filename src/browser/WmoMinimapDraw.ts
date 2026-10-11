/**
 * 05.10-A7b-4 (7.14, drawing): a building's baked minimap tiles in the minimap circle.
 *
 * Inside a building with bakes (dungeons, the Stockade, Ironforge, Undercity, Stormwind…) the client shows the
 * building's own top-down pictures instead of the ADT minimap. The bakes are `<root>_<group>_<x>_<y>.blp`
 * (A7b-3); the model space they lie in is the collision model's (vmap4_extractor `wmo.cpp` copies the MOGP
 * boxes), which the vmap placement turns into the world (game/Collision.ts `transformCollisionMesh`).
 *
 * 12.10 (7.27): what the 05.10 slice left as switches is settled. Which tiles, their rectangles and their
 * order are Wow.exe's (`WmoMinimapGate.ts`, `WmoMinimapSelect.ts`); how a picture lies on its rectangle is
 * the quad of 0x0057E7F0 — top-left at (minX, maxY), right along +X, down along −Y, half a texel in from each
 * edge — and the corpus agrees (numbers at `wmoMinimapPictureCorners`). The old readings `north-up`
 * (the default) and `model-xy`, and the `floor-group`/`storey` choice, are gone with their switch.
 *
 * Cost per repaint (≤ 10 Hz idle): for each selected tile, two subtractions and a multiply per corner and one
 * `drawImage`; the world corners were computed when the tiles were selected, nothing is allocated here.
 */

import type { WmoMinimapTileList } from "./WmoMinimapSelect.js";

/** A vmap placement (`CollisionPlacement`). */
export interface WmoMinimapPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationX: number;
  readonly rotationY: number;
  readonly rotationZ: number;
  readonly scale: number;
}

/** The rotation of `transformCollisionMesh`, as nine numbers, and the scale. */
function placementMatrix(placement: WmoMinimapPlacement, out: Float64Array): void {
  const yaw = placement.rotationY * Math.PI / 180;
  const pitch = placement.rotationX * Math.PI / 180;
  const roll = placement.rotationZ * Math.PI / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  out[0] = cy * cp; out[1] = cy * sp * sr - sy * cr; out[2] = cy * sp * cr + sy * sr;
  out[3] = sy * cp; out[4] = sy * sp * sr + cy * cr; out[5] = sy * sp * cr - cy * sr;
  out[6] = -sp; out[7] = cp * sr; out[8] = cp * cr;
  out[9] = placement.scale || 1;
}

const MATRIX = new Float64Array(10);

/** Model space to world space, exactly `transformCollisionMesh` for one point; written into `out`. */
export function wmoModelToWorld(
  placement: WmoMinimapPlacement, x: number, y: number, z: number, out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  placementMatrix(placement, MATRIX);
  const m = MATRIX;
  const s = m[9]!;
  out.x = placement.x - s * (m[0]! * x + m[1]! * y + m[2]! * z);
  out.y = placement.y - s * (m[3]! * x + m[4]! * y + m[5]! * z);
  out.z = placement.z + s * (m[6]! * x + m[7]! * y + m[8]! * z);
  return out;
}

/** World space to model space, exactly `inverseTransformCollisionPoint`; written into `out`. */
export function wmoWorldToModel(
  placement: WmoMinimapPlacement, x: number, y: number, z: number, out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  placementMatrix(placement, MATRIX);
  const m = MATRIX;
  const s = m[9]!;
  const rx = (placement.x - x) / s;
  const ry = (placement.y - y) / s;
  const rz = (z - placement.z) / s;
  out.x = m[0]! * rx + m[3]! * ry + m[6]! * rz;
  out.y = m[1]! * rx + m[4]! * ry + m[7]! * rz;
  out.z = m[2]! * rx + m[5]! * ry + m[8]! * rz;
  return out;
}

/** Sheet pixels per world yard of the ADT minimap (`MINIMAP_TILE_PIXELS / TERRAIN_GRID_SIZE`). */
const SHEET_PIXELS_PER_YARD = 256 / (1600 / 3);

/**
 * The canvas affine `[a, b, c, d, e, f]` that draws the unit square as tile `at` of `list` (its world corners
 * from `wmoMinimapPictureCorners`), for a canvas translated to the character (`player`, world) and scaled
 * `scale` screen pixels to the sheet pixel — the frame `ui/Minimap.ts` `drawTiles` draws the ADT tiles in
 * (column east = world Y falling, row south = world X falling).
 */
export function wmoMinimapTileAffine(
  list: Pick<WmoMinimapTileList, "world">, at: number, player: { readonly x: number; readonly y: number }, scale: number,
  out: Float64Array,
): Float64Array {
  const world = list.world;
  const k = SHEET_PIXELS_PER_YARD * scale;
  out[0] = -world[at * 6 + 3]! * k;
  out[1] = -world[at * 6 + 2]! * k;
  out[2] = -world[at * 6 + 5]! * k;
  out[3] = -world[at * 6 + 4]! * k;
  out[4] = -(world[at * 6 + 1]! - player.y) * k;
  out[5] = -(world[at * 6]! - player.x) * k;
  return out;
}

/** A bake as the picture cache hands it out (`ImageBitmap`). */
export type WmoMinimapPicture = CanvasImageSource & { readonly width: number; readonly height: number };

const AFFINE = new Float64Array(6);

/**
 * Draws the selected tiles of `list` in its order on a context already translated to the circle's centre
 * (and turned, in the rotating mode). `reach` is the circle's radius in yards: a tile wholly beyond it in X
 * or Y is skipped (the query box is three radii across, turned into the model and back, so up to ~36 tiles
 * reach the list where 9–16 meet the circle). Returns how many pictures were drawn.
 */
export function drawWmoMinimap(
  context: Pick<CanvasRenderingContext2D, "save" | "restore" | "transform" | "drawImage">,
  list: Pick<WmoMinimapTileList, "count" | "order" | "hashes" | "world" | "reach">,
  picture: (hash: string) => WmoMinimapPicture | undefined,
  player: { readonly x: number; readonly y: number },
  scale: number,
  reach: number,
): number {
  let drawn = 0;
  const bounds = list.reach;
  for (let index = 0; index < list.count; index++) {
    const at = list.order[index]!;
    const hash = list.hashes[at];
    if (hash === undefined) continue;
    if (bounds[at * 4]! > player.x + reach || bounds[at * 4 + 2]! < player.x - reach
      || bounds[at * 4 + 1]! > player.y + reach || bounds[at * 4 + 3]! < player.y - reach) continue;
    const image = picture(hash);
    if (!image) continue;
    wmoMinimapTileAffine(list, at, player, scale, AFFINE);
    context.save();
    context.transform(AFFINE[0]!, AFFINE[1]!, AFFINE[2]!, AFFINE[3]!, AFFINE[4]!, AFFINE[5]!);
    // 0x0057E7F0's UVs run from half a texel to one less half a texel; a hair over the unit square, as the
    // ADT tiles' half pixel, keeps the canvas's antialiased edges from showing background between tiles.
    const width = image.width, height = image.height;
    if (width >= 2 && height >= 2) context.drawImage(image, 0.5, 0.5, width - 1, height - 1, -0.002, -0.002, 1.004, 1.004);
    else context.drawImage(image, -0.002, -0.002, 1.004, 1.004);
    context.restore();
    drawn++;
  }
  return drawn;
}
