import type { CollisionBounds, CollisionLiquid } from "../../world/CollisionFormat.js";
import {
  inverseTransformCollisionPoint,
  transformCollisionMesh,
  type CollisionPlacement,
  type Vector3,
} from "./Collision.js";

/** VMAP/WMO liquid grid spacing: one ADT tile divided into 128 cells. */
export const VMAP_LIQUID_CELL_YARDS = 533.3333333333334 / 128;

export interface CollisionLiquidSample {
  /** Surface height in the WMO model's local coordinates. */
  height: number;
  type: number;
  cellX: number;
  cellY: number;
}

/**
 * Sample one `MLIQ` cell at a point in WMO model space.
 *
 * The interpolation follows the same diagonal as the rendered quad: `(00,10,01)` below `u+v=1`
 * and `(10,11,01)` above it. Bilinear interpolation would bow a non-planar cell away from the two
 * triangles the camera actually sees.
 */
export function sampleCollisionLiquid(
  liquid: CollisionLiquid,
  modelX: number,
  modelY: number,
): CollisionLiquidSample | undefined {
  if (!Number.isInteger(liquid.tilesX) || !Number.isInteger(liquid.tilesY)
    || liquid.tilesX <= 0 || liquid.tilesY <= 0
    || !Number.isFinite(modelX) || !Number.isFinite(modelY)
    || !Number.isFinite(liquid.cornerX) || !Number.isFinite(liquid.cornerY)) return undefined;

  const gridX = (modelX - liquid.cornerX) / VMAP_LIQUID_CELL_YARDS;
  const gridY = (modelY - liquid.cornerY) / VMAP_LIQUID_CELL_YARDS;
  // The mesh includes its outer edge, so an exact maximum belongs to the final cell with u/v = 1.
  if (gridX < 0 || gridY < 0 || gridX > liquid.tilesX || gridY > liquid.tilesY) return undefined;
  const cellX = Math.min(liquid.tilesX - 1, Math.floor(gridX));
  const cellY = Math.min(liquid.tilesY - 1, Math.floor(gridY));
  const cell = cellY * liquid.tilesX + cellX;
  const flags = liquid.flags[cell];
  if (flags === undefined || (flags & 0x0f) === 0x0f) return undefined;

  const stride = liquid.tilesX + 1;
  const h00 = liquid.heights[cellY * stride + cellX];
  const h10 = liquid.heights[cellY * stride + cellX + 1];
  const h01 = liquid.heights[(cellY + 1) * stride + cellX];
  const h11 = liquid.heights[(cellY + 1) * stride + cellX + 1];
  if (h00 === undefined || h10 === undefined || h01 === undefined || h11 === undefined
    || !Number.isFinite(h00) || !Number.isFinite(h10)
    || !Number.isFinite(h01) || !Number.isFinite(h11)) return undefined;

  const u = gridX - cellX;
  const v = gridY - cellY;
  const height = u + v <= 1
    ? h00 + (h10 - h00) * u + (h01 - h00) * v
    : h10 * (1 - v) + h11 * (u + v - 1) + h01 * (1 - u);
  return { height, type: liquid.type, cellX, cellY };
}

export interface CollisionLiquidEyeHit extends CollisionLiquidSample {
  groupIndex: number;
  groupId: number | undefined;
  /** Eye height in the WMO model's local coordinates. */
  eyeHeight: number;
  /**
   * The same surface point in world coordinates, which is what anything outside this file speaks.
   *
   * `height` is the MLIQ grid's own number and stays in the model's space; the renderer's overlay
   * compares the surface against a camera that stands in the world, so the placement transform has
   * to be applied somewhere and here is where the placement is already in hand.
   */
  worldHeight: number;
}

/**
 * Test the authoritative collision-floor group for a liquid surface above an eye point.
 *
 * `authoritativeGroupIndex` is deliberately required. Scanning every MLIQ in a WMO makes a wet
 * upper room mark a dry lower room as underwater whenever their x/y footprints overlap. The
 * selected floor group is the provenance we actually have; its model-space bounds are a second
 * fail-closed check against stale or vertically unrelated answers.
 *
 * `bandYards` widens the acceptance upwards by that many world yards, for the one caller that has
 * to know about a surface the eye has not passed yet: the near plane cuts the water before the eye
 * does, so the screen effect starts a near-plane half-height early. Zero — the default — is the
 * strict «the eye is under it» test that the light slot has always asked, unchanged. The band is
 * divided by the placement scale to reach model units, which is exact wherever the placement's z
 * axis is the world's; a tilted WMO costs a fraction of a yard on a band that is itself an eighth
 * of one.
 */
export function collisionModelLiquidAtEye(
  groups: readonly { bounds: CollisionBounds; groupId?: number; liquid?: CollisionLiquid }[],
  authoritativeGroupIndex: number,
  placement: CollisionPlacement,
  worldEye: Vector3,
  bandYards = 0,
): CollisionLiquidEyeHit | undefined {
  if (!Number.isInteger(authoritativeGroupIndex) || authoritativeGroupIndex < 0) return undefined;
  const group = groups[authoritativeGroupIndex];
  if (!group?.liquid) return undefined;
  const eye = inverseTransformCollisionPoint(worldEye, placement);
  if (!Number.isFinite(eye.x) || !Number.isFinite(eye.y) || !Number.isFinite(eye.z)) return undefined;
  const epsilon = 1e-4;
  const bounds = group.bounds;
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY) || !Number.isFinite(bounds.minZ)
    || !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.maxY) || !Number.isFinite(bounds.maxZ)) return undefined;
  if (eye.x < bounds.minX - epsilon || eye.x > bounds.maxX + epsilon
    || eye.y < bounds.minY - epsilon || eye.y > bounds.maxY + epsilon
    || eye.z < bounds.minZ - epsilon || eye.z > bounds.maxZ + epsilon) return undefined;
  const sample = sampleCollisionLiquid(group.liquid, eye.x, eye.y);
  if (!sample) return undefined;
  const scale = placement.scale || 1;
  const band = Number.isFinite(bandYards) && bandYards > 0 ? bandYards / Math.abs(scale) : 0;
  if (!(eye.z < sample.height + band)) return undefined;
  // Through the same transform the collision meshes go through, rather than a second copy of its
  // matrix: this file has one job with a sign in it and the mesh path is where that sign is proved.
  const placed = transformCollisionMesh(
    Float32Array.of(eye.x, eye.y, sample.height),
    Uint32Array.of(0),
    placement,
  );
  return {
    ...sample,
    groupIndex: authoritativeGroupIndex,
    groupId: group.groupId,
    eyeHeight: eye.z,
    worldHeight: placed[2]!,
  };
}

/**
 * Whether the eye of a hit is actually below the surface, rather than inside the crossing band.
 *
 * The predicate the light slot asks, kept on the hit so that one query answers both questions: a
 * band-widened lookup still says exactly what a band-free one would have said, and the two cannot
 * drift apart into two different ideas of «underwater». Model-space on both sides, deliberately —
 * that is the comparison `Map`'s own liquid test makes and the one the light slot was written on.
 */
export function collisionLiquidEyeSubmerged(hit: CollisionLiquidEyeHit | undefined): boolean {
  return hit !== undefined && hit.eyeHeight < hit.height;
}
