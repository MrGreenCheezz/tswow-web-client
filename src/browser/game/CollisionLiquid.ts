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

/** A group's own liquid over a point inside it; `worldHeight` is the surface in world space. */
export interface CollisionLiquidHit extends CollisionLiquidSample {
  groupIndex: number;
  groupId: number | undefined;
  /** The point's height in the WMO model's local coordinates. */
  pointHeight: number;
  worldHeight: number;
}

/**
 * One WMO group's liquid over a point, whether the point is above or below the surface.
 *
 * The group is the one whose floor is under the point — the server asks exactly that group
 * (`ModelInstance::GetLiquidLevel` on `info.hitModel`) and no other, which is why a wet room never
 * floods the dry room above it. The point must also be inside the group's box, the other half of
 * the server's own test (`GroupModel::IsInsideObject`, `WorldModel.cpp:419-430`).
 *
 * `undefined` means the point is not inside this group, so the server would not have picked it;
 * `null` means it is inside and the group holds no water over it — which still matters, because an
 * interior group keeps the map file's water out as well.
 */
export function collisionModelLiquidAt(
  groups: readonly { bounds: CollisionBounds; groupId?: number; liquid?: CollisionLiquid }[],
  groupIndex: number,
  placement: CollisionPlacement,
  worldPoint: Vector3,
): CollisionLiquidHit | null | undefined {
  if (!Number.isInteger(groupIndex) || groupIndex < 0) return undefined;
  const group = groups[groupIndex];
  if (!group) return undefined;
  const point = inverseTransformCollisionPoint(worldPoint, placement);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return undefined;
  const epsilon = 1e-4;
  const bounds = group.bounds;
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY) || !Number.isFinite(bounds.minZ)
    || !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.maxY) || !Number.isFinite(bounds.maxZ)) return undefined;
  if (point.x < bounds.minX - epsilon || point.x > bounds.maxX + epsilon
    || point.y < bounds.minY - epsilon || point.y > bounds.maxY + epsilon
    || point.z < bounds.minZ - epsilon || point.z > bounds.maxZ + epsilon) return undefined;
  if (!group.liquid) return null;
  const sample = sampleCollisionLiquid(group.liquid, point.x, point.y);
  if (!sample) return null;
  // Through the same transform the collision meshes go through, rather than a second copy of its
  // matrix: this file has one job with a sign in it and the mesh path is where that sign is proved.
  const placed = transformCollisionMesh(
    Float32Array.of(point.x, point.y, sample.height),
    Uint32Array.of(0),
    placement,
  );
  return {
    ...sample,
    groupIndex,
    groupId: group.groupId,
    pointHeight: point.z,
    worldHeight: placed[2]!,
  };
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
  const hit = collisionModelLiquidAt(groups, authoritativeGroupIndex, placement, worldEye);
  if (!hit) return undefined;
  const scale = placement.scale || 1;
  const band = Number.isFinite(bandYards) && bandYards > 0 ? bandYards / Math.abs(scale) : 0;
  if (!(hit.pointHeight < hit.height + band)) return undefined;
  return {
    height: hit.height,
    type: hit.type,
    cellX: hit.cellX,
    cellY: hit.cellY,
    groupIndex: hit.groupIndex,
    groupId: hit.groupId,
    eyeHeight: hit.pointHeight,
    worldHeight: hit.worldHeight,
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

/** `GROUND_HEIGHT_TOLERANCE`, `SharedDefines.h:26`: how far under a floor a body still stands on it. */
const GROUND_HEIGHT_TOLERANCE = 0.05;
/** The `MOGP` bit `IsInWMOInterior` reads (`Map.cpp:2642-2645`): a room the map's water stays out of. */
export const WMO_INTERIOR_GROUP = 0x2000;

/** What the liquid rule needs to know about the WMO floor under a point, all in world space. */
export interface WmoLiquidFooting {
  floorZ: number;
  /** That floor's group's `MOGP` flags. */
  groupFlags: number;
  /** The group's own liquid over the point, when it holds any there. */
  liquid: { height: number; type: number } | undefined;
}

/**
 * The liquid a unit is in, chosen the way the server chooses it for every unit it moves.
 *
 * `Map::GetFullTerrainStatusForPosition` (`Map.cpp:2839-2969`), which `WorldObject::
 * UpdatePositionData` feeds to the breath timer and to `IsInWater`:
 * - the WMO floor counts only while the feet are on or above it, and it is above the map's ground
 *   or the feet are under that ground — a cellar under a field;
 * - its group's liquid counts only where the surface is above that floor, so a pool's grid running
 *   on under a raised walkway leaves the walkway dry;
 * - the map file's water counts only where it is not under the ground, the feet are not under the
 *   ground, no interior room is the floor, and it is above the WMO floor — and where it counts it
 *   wins over the room's own.
 *
 * `ground` and `mapLiquid` are the map file's answers (`TerrainClient.heightAt` / `liquidAt`,
 * which already reads the extractor's -500 as dry); `wmo` is undefined where no WMO floor is under
 * the feet.
 */
export function positionLiquid(
  z: number,
  wmo: WmoLiquidFooting | undefined,
  ground: number | undefined,
  mapLiquid: { height: number; type: number } | undefined,
): { height: number; type: number } | undefined {
  let footing = wmo;
  if (footing !== undefined && !(z >= footing.floorZ - GROUND_HEIGHT_TOLERANCE
    && (ground === undefined || z < ground - GROUND_HEIGHT_TOLERANCE || footing.floorZ > ground))) {
    footing = undefined;
  }
  let answer = footing?.liquid !== undefined && footing.liquid.height > footing.floorZ ? footing.liquid : undefined;
  const interior = footing !== undefined && (footing.groupFlags & WMO_INTERIOR_GROUP) !== 0;
  if (!interior && mapLiquid !== undefined && ground !== undefined
    && mapLiquid.height >= ground && z >= ground
    && (footing === undefined || mapLiquid.height > footing.floorZ)) {
    answer = mapLiquid;
  }
  return answer;
}
