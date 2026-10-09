/**
 * 05.10-A7b-4 (7.14, drawing): a building's baked minimap tiles in the minimap circle.
 *
 * Inside a WMO room that has bakes (dungeons, the Stockade, Ironforge, Undercity…) the client shows the
 * building's own top-down pictures instead of the ADT minimap. What is known (slice A7b-3, measured on 733
 * groups): a group's tiles are 128-yard squares counted from the minimum corner of its MOGP box, the first
 * number of `<root>_<group>_<x>_<y>.blp` along the model's X (`wmoMinimapCell`). The collision model's
 * group boxes are the same MOGP boxes (vmap4_extractor `wmo.cpp` copies `bbcorn1/bbcorn2`), in the same
 * model space the vmap placement turns into the world (game/Collision.ts `transformCollisionMesh`).
 *
 * What is NOT known from the files, and is therefore a named switch rather than a guess:
 *
 * - `WMO_MINIMAP_PICTURE_READING` — how a 256-pixel picture lies inside its 128-yard square. Two readings
 *   are implemented and tested: `north-up` (the ADT bakes' convention carried into model space: picture up
 *   = +X, picture right = −Y) and `model-xy` (picture right = +X, picture down = −Y). The paired frame of
 *   14.25 settles it; if neither matches, the table below takes the right one.
 * - `WMO_MINIMAP_GROUPS` — which groups are drawn: `floor-group` (only the group whose floor the character
 *   stands on — the plan's starting point) or `storey` (every group of the building whose box holds the
 *   character's model-space height). Same paired frame.
 *
 * Cost per repaint (the minimap repaints when something moved, ≤ 10 Hz idle): one inverse transform, a
 * walk over the drawn groups' cells (a handful) and one `drawImage` per cell; the affine is written into a
 * reused array.
 */

import { WMO_MINIMAP_TILE_SIZE } from "./WmoMinimapTiles.js";

export type WmoMinimapPictureReading = "north-up" | "model-xy";
export type WmoMinimapGroupChoice = "floor-group" | "storey";

/** 14.25 must settle both (see the module comment). */
export const WMO_MINIMAP_PICTURE_READING: WmoMinimapPictureReading = "north-up";
export const WMO_MINIMAP_GROUPS: WmoMinimapGroupChoice = "floor-group";

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

export interface WmoMinimapBox {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
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

/**
 * Where a picture's corners lie in model space, for a cell `[x0, x0 + 128] × [y0, y0 + 128]`: the model
 * point of picture (0, 0), and the model steps of picture right (u) and picture down (v), six numbers
 * `[ox, oy, ux, uy, vx, vy]`.
 */
export function wmoMinimapPictureFrame(
  reading: WmoMinimapPictureReading, x0: number, y0: number, out: Float64Array,
): Float64Array {
  const size = WMO_MINIMAP_TILE_SIZE;
  if (reading === "north-up") {
    // Up = +X, right = −Y: the top-left corner is (max X, max Y).
    out[0] = x0 + size; out[1] = y0 + size;
    out[2] = 0; out[3] = -size;
    out[4] = -size; out[5] = 0;
  } else {
    // Right = +X, down = −Y: the top-left corner is (min X, max Y).
    out[0] = x0; out[1] = y0 + size;
    out[2] = size; out[3] = 0;
    out[4] = 0; out[5] = -size;
  }
  return out;
}

/** Sheet pixels per world yard of the ADT minimap (`MINIMAP_TILE_PIXELS / TERRAIN_GRID_SIZE`). */
const SHEET_PIXELS_PER_YARD = 256 / (1600 / 3);

const FRAME = new Float64Array(6);
const WORLD = { x: 0, y: 0, z: 0 };

/**
 * The canvas affine `[a, b, c, d, e, f]` that draws a unit picture of cell (`cellX`, `cellY`) of a group
 * with box `box`, for a canvas translated to the character (`player`, world) and scaled `scale` screen
 * pixels to the sheet pixel — the frame `ui/Minimap.ts` `drawTiles` draws the ADT tiles in (column east
 * = world Y falling, row south = world X falling). `modelZ` is the character's model-space height (the
 * plane the picture is laid in; only a tilted placement makes it matter).
 */
export function wmoMinimapCellAffine(
  placement: WmoMinimapPlacement,
  box: Pick<WmoMinimapBox, "minX" | "minY">,
  cellX: number,
  cellY: number,
  modelZ: number,
  player: { readonly x: number; readonly y: number },
  scale: number,
  reading: WmoMinimapPictureReading,
  out: Float64Array,
): Float64Array {
  const frame = wmoMinimapPictureFrame(reading, box.minX + cellX * WMO_MINIMAP_TILE_SIZE, box.minY + cellY * WMO_MINIMAP_TILE_SIZE, FRAME);
  const k = SHEET_PIXELS_PER_YARD * scale;
  // Screen point of a model point: column = −(worldY − playerY), row = −(worldX − playerX), in sheet pixels.
  wmoModelToWorld(placement, frame[0]!, frame[1]!, modelZ, WORLD);
  const ox = -(WORLD.y - player.y) * k;
  const oy = -(WORLD.x - player.x) * k;
  wmoModelToWorld(placement, frame[0]! + frame[2]!, frame[1]! + frame[3]!, modelZ, WORLD);
  const ux = -(WORLD.y - player.y) * k - ox;
  const uy = -(WORLD.x - player.x) * k - oy;
  wmoModelToWorld(placement, frame[0]! + frame[4]!, frame[1]! + frame[5]!, modelZ, WORLD);
  const vx = -(WORLD.y - player.y) * k - ox;
  const vy = -(WORLD.x - player.x) * k - oy;
  out[0] = ux; out[1] = uy; out[2] = vx; out[3] = vy; out[4] = ox; out[5] = oy;
  return out;
}

/** Whether a group is drawn under `WMO_MINIMAP_GROUPS` for a character standing on `floorGroup`. */
export function wmoMinimapGroupDrawn(
  choice: WmoMinimapGroupChoice, groupIndex: number, floorGroup: number, box: WmoMinimapBox, modelZ: number,
): boolean {
  if (choice === "floor-group") return groupIndex === floorGroup;
  return groupIndex === floorGroup || (modelZ >= box.minZ && modelZ <= box.maxZ);
}

/** One group's cells as the tile client keeps them (`"<x>-<y>"` → md5). */
export type WmoMinimapCells = ReadonlyMap<string, string>;

export interface WmoMinimapDrawSource {
  /** The placement of the building (vmap), its collision groups' boxes, and the floor's group index. */
  readonly placement: WmoMinimapPlacement;
  readonly groups: readonly { readonly bounds: WmoMinimapBox }[];
  readonly floorGroup: number;
  /** A group's cells, undefined until known (asking may start a request). */
  cells(groupIndex: number): WmoMinimapCells | undefined;
  /** A picture by md5, undefined until it lands. */
  picture(hash: string): CanvasImageSource | undefined;
}

const AFFINE = new Float64Array(6);
const MODEL = { x: 0, y: 0, z: 0 };
const CELL = /^(\d{1,2})-(\d{1,2})$/;

/**
 * Draws the building's cells on a context already translated to the circle's centre (and turned, in the
 * rotating mode). Returns how many cells were drawn; 0 means nothing of the building is shown yet and the
 * caller keeps its ADT tiles.
 */
export function drawWmoMinimap(
  context: Pick<CanvasRenderingContext2D, "save" | "restore" | "transform" | "drawImage">,
  source: WmoMinimapDrawSource,
  player: { readonly x: number; readonly y: number; readonly z: number },
  scale: number,
  reading: WmoMinimapPictureReading = WMO_MINIMAP_PICTURE_READING,
  choice: WmoMinimapGroupChoice = WMO_MINIMAP_GROUPS,
): number {
  wmoWorldToModel(source.placement, player.x, player.y, player.z, MODEL);
  const modelZ = MODEL.z;
  let drawn = 0;
  for (let index = 0; index < source.groups.length; index++) {
    const box = source.groups[index]!.bounds;
    if (!wmoMinimapGroupDrawn(choice, index, source.floorGroup, box, modelZ)) continue;
    const cells = source.cells(index);
    if (!cells) continue;
    for (const [cell, hash] of cells) {
      const picture = source.picture(hash);
      if (!picture) continue;
      const match = CELL.exec(cell);
      if (!match) continue;
      wmoMinimapCellAffine(source.placement, box, Number(match[1]), Number(match[2]), modelZ, player, scale, reading, AFFINE);
      context.save();
      context.transform(AFFINE[0]!, AFFINE[1]!, AFFINE[2]!, AFFINE[3]!, AFFINE[4]!, AFFINE[5]!);
      // A hair over the unit square, as the ADT tiles' half pixel: no seam of background between cells.
      context.drawImage(picture, -0.002, -0.002, 1.004, 1.004);
      context.restore();
      drawn++;
    }
  }
  return drawn;
}
