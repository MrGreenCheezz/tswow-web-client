/**
 * 15.11 (7.08 slice B): the square of map chunks around the camera in which Wow.exe keeps and draws the detailed
 * terrain (its MCNK chunks), and the ADT tiles that square touches.
 *
 * Wow.exe 0x00780860, once a frame from the camera position:
 * - it builds the camera's projection (0x006bf370, vertical fov = the camera's fov × 0.6 (0x009f5ad4), its aspect,
 *   near and far) and reads one corner of the view frustum back (0x006bf6d0) as a distance `d`;
 * - the far-clip box is the camera ± far clip (0x00cd779c…0x00cd77b0), and the window's half-size in yards is
 *   1.25 × far clip (0x00a33a50) when `d` is under the far clip, else `d` held to at most twice the far clip;
 * - n = 1 − ftol(−0.03 × that) chunks (0x00a3e714; 0x0088b9c0 truncates);
 * - the camera's chunk is rint((17066.67 − p) × 0.03 − 0.5) on each axis (0x009e2acc, 0x00a3e4ec, 0x00adef40);
 * - the inner window is [(c − n) & ~1, ((c + n) & ~1) + 1], the outer one two chunks wider each side
 *   (0x00cd77c8…0x00cd77e4); when the outer window reaches fewer than 8 chunks past the camera on the second axis
 *   both are widened by the shortfall; everything is held to 0…1023.
 * Users: 0x007b5950 loads the ADTs the outer window touches (forcing those meeting the inner one), 0x007d6bf0 creates
 * and draws the chunks inside the outer window and deletes those outside it (0x007d6a90); the frustum then culls.
 *
 * The corner `d` is read from the stack after 0x006bf6d0; that it is the far corner's distance (far × √(1 + tan²v +
 * tan²h)) is inferred from the code and confirmed by the stand: at far clip 1277 and fov 90° (vertical 54°, aspect
 * 16:9) it gives 1,841.7 yd, n = 56 and an outer window of ±58 chunks (≈ 1,933 yd); Wow.exe's own frames drew
 * terrain chunks up to 54 chunks from the camera's (fog6-n-icecrown; 48 in the Borean Tundra), which the reading of
 * n from the far clip alone (±41) cannot reach.
 */

import { WOW_FAR_CLIP } from "./ShapedFogSet.js";

/** Yards per map chunk (one sixteenth of an ADT tile). */
export const CHUNK_SIZE = 1600 / 48;
/** Chunks per ADT side. */
export const CHUNKS_PER_TILE = 16;
/** The map's chunks per side (64 tiles). */
export const MAP_CHUNKS = 1024;
/** Half the map's width in yards: the world origin's distance from the map's corner (0x009e2acc). */
const MAP_HALF = 17066.666;
/** Wow.exe's fov multiplier for the projection (0x009f5ad4). */
export const WOW_PROJECTION_FOV_SCALE = 0.6;
/** Wow.exe's stock camera fov (radians) and the stand's aspect, as the stand's K lines record them. */
export const WOW_CAMERA_FOV = Math.PI / 2;

export interface ChunkRect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export interface DetailChunkWindow {
  /** The camera's chunk, on Wow.exe's chunk axes (x from world x, y from world y). */
  readonly cameraX: number;
  readonly cameraY: number;
  /** n: the window's half-size in chunks before the even alignment. */
  readonly reach: number;
  /** The tiles meeting it are force-loaded. */
  readonly inner: ChunkRect;
  /** The chunks inside it are kept and drawn. */
  readonly outer: ChunkRect;
}

/** The distance of the view frustum's far corner from the eye: far × √(1 + tan²(v/2) + tan²(h/2)). */
export function frustumCornerDistance(far: number, verticalFov: number, aspect: number): number {
  const v = Math.tan(verticalFov / 2);
  const h = v * aspect;
  return far * Math.sqrt(1 + v * v + h * h);
}

/** The original's corner for a camera fov (as the `farclip`/fov CVars give it) and aspect. */
export function wowFrustumCornerDistance(farClip: number, cameraFov = WOW_CAMERA_FOV, aspect = 16 / 9): number {
  return frustumCornerDistance(farClip, cameraFov * WOW_PROJECTION_FOV_SCALE, aspect);
}

/** The window's half-size in yards from the far clip and the frustum corner (0x00780a35…0x00780a63). */
export function detailWindowYards(farClip: number, cornerDistance: number): number {
  if (!(cornerDistance >= farClip)) return 1.25 * farClip;
  return Math.min(cornerDistance, 2 * farClip);
}

/** n = 1 − ftol(−0.03 × yards): ftol truncates toward zero. */
export function detailWindowReach(yards: number): number {
  return 1 - Math.trunc(Math.fround(-0.03) * yards);
}

/** A world coordinate's chunk on its axis: rint((17066.67 − p) × 0.03 − 0.5), x87 round-to-nearest-even. */
export function worldChunk(position: number): number {
  const value = Math.fround((MAP_HALF - position) * Math.fround(0.03)) - 0.5;
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const clampChunk = (value: number) => Math.min(MAP_CHUNKS - 1, Math.max(0, value));

/** Wow.exe 0x00780860: the inner and outer chunk windows around the camera at world (x, y). */
export function detailChunkWindow(x: number, y: number, farClip: number, cornerDistance: number): DetailChunkWindow {
  const n = detailWindowReach(detailWindowYards(farClip, cornerDistance));
  const cx = worldChunk(x);
  const cy = worldChunk(y);
  const innerX0 = (cx - n) & ~1;
  const innerX1 = ((cx + n) & ~1) + 1;
  const innerY0 = (cy - n) & ~1;
  const innerY1 = ((cy + n) & ~1) + 1;
  let outerX0 = innerX0 - 2;
  let outerX1 = innerX1 + 2;
  let outerY0 = innerY0 - 2;
  let outerY1 = innerY1 + 2;
  // At least eight chunks past the camera on the second axis (0x00780bf5…0x00780c5a); only a far clip under about
  // 130 yards is that short.
  if (outerY1 - cy < 8) {
    const short = 8 - (outerY1 - cy);
    outerX0 = (outerX0 - short) & ~1;
    outerY0 = (outerY0 - short) & ~1;
    outerY1 = ((outerY1 + short) & ~1) + 1;
    outerX1 = ((outerX1 + short) & ~1) + 1;
  }
  return {
    cameraX: cx, cameraY: cy, reach: n,
    inner: { x0: clampChunk(innerX0), x1: clampChunk(innerX1), y0: clampChunk(innerY0), y1: clampChunk(innerY1) },
    outer: { x0: clampChunk(outerX0), x1: clampChunk(outerX1), y0: clampChunk(outerY0), y1: clampChunk(outerY1) },
  };
}

/** The ADT tiles a chunk rectangle touches (tile = chunk >> 4), as a tile rectangle. */
export function chunkRectTiles(rect: ChunkRect): ChunkRect {
  return {
    x0: rect.x0 >> 4, x1: rect.x1 >> 4,
    y0: rect.y0 >> 4, y1: rect.y1 >> 4,
  };
}

/** The tile rectangle of the detailed window around a camera at world (x, y). */
export function detailWindowTiles(x: number, y: number, farClip: number, cornerDistance: number): ChunkRect {
  return chunkRectTiles(detailChunkWindow(x, y, farClip, cornerDistance).outer);
}

/**
 * See {@link TerrainDetailWindowState.fullReach}. Measured 15.11 (lookdev ABBA in one page, 1280×720, enhanced level,
 * five Northrend views and Stormwind; .runtime/lane-2026-11-15/farland12-report.md): every window tile in full detail
 * costs +0.5…0.8 ms GPU, +0.4…1.7 ms CPU and +500…700 MB of ground textures; the 5×5 in full and the rest mid-detail
 * +0.1…0.6 ms GPU, +0.1…0.8 ms CPU and +140…270 MB; the 3×3 in full and the rest mid-detail nothing measurable
 * (GPU −0.06…+0.48, CPU +0.0…+0.4, no texture memory). The owner's frame budget keeps the last.
 */
export const TERRAIN_WINDOW_FULL_REACH = 1;

/**
 * The renderer's side: the window's tile rectangle for the camera this frame, the same object while it does not
 * change (the streaming plan and the horizon key on it), and the switch that hides the far tiles (the bench's
 * `terrainWindow` cost toggle) without dropping them.
 */
export class TerrainDetailWindowState {
  /** Off: the far tiles stay built but hidden and the horizon covers them, as before 7.08 slice B. */
  drawn = true;
  /**
   * The window's tiles within this many tiles (Chebyshev) of the player's are built at full detail; the rest are
   * drawn by the horizon's mid-detail ring from their own heights (HorizonLodRing.ts). 64: every tile in full.
   */
  fullReach = TERRAIN_WINDOW_FULL_REACH;
  #rect: ChunkRect | undefined;
  #cx = -1;
  #cy = -1;
  #fov = 0;
  #aspect = 0;
  #farClip = 0;

  /**
   * The window around a camera at world (x, y) with the renderer camera's own vertical fov (degrees) and aspect:
   * the original's rule over this client's projection, at the original's far clip.
   */
  tiles(x: number, y: number, verticalFovDegrees: number, aspect: number, farClip = WOW_FAR_CLIP): ChunkRect | undefined {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this.#rect = undefined;
    // Per frame: nothing is built while the camera stays in its chunk under the same projection.
    const cx = worldChunk(x), cy = worldChunk(y);
    if (this.#rect && cx === this.#cx && cy === this.#cy && verticalFovDegrees === this.#fov && aspect === this.#aspect
      && farClip === this.#farClip) return this.#rect;
    this.#cx = cx;
    this.#cy = cy;
    this.#fov = verticalFovDegrees;
    this.#aspect = aspect;
    this.#farClip = farClip;
    const corner = frustumCornerDistance(farClip, verticalFovDegrees * Math.PI / 180, aspect);
    const next = detailWindowTiles(x, y, farClip, corner);
    const rect = this.#rect;
    if (rect && rect.x0 === next.x0 && rect.x1 === next.x1 && rect.y0 === next.y0 && rect.y1 === next.y1) return rect;
    return this.#rect = next;
  }

  /** The rectangle the horizon leaves to the terrain: the window while it is drawn. */
  get drawnRect(): ChunkRect | undefined {
    return this.drawn ? this.#rect : undefined;
  }
}

/**
 * How far the drawn detailed ground reaches from (x, y) in every direction: the distance to the nearest edge of the
 * rectangle of tiles that are drawn (`drawn` tells which), never less than the tile the point stands on. The fog of
 * a map without a WDL closes inside it (DistanceFog.ts `shapedFogEnd`).
 */
export function detailedGroundReach(x: number, y: number, tiles: ChunkRect,
  drawn: (gridX: number, gridY: number) => boolean): number {
  const tileSize = CHUNK_SIZE * CHUNKS_PER_TILE;
  const gx = 32 - x / tileSize;
  const gy = 32 - y / tileSize;
  const centreX = Math.floor(gx);
  const centreY = Math.floor(gy);
  // Grow a square ring by ring while every tile of the next ring (inside the window) is drawn.
  let ring = 0;
  for (let next = 1; next <= 64; next++) {
    let complete = true;
    for (let tx = centreX - next; tx <= centreX + next && complete; tx++) {
      for (let ty = centreY - next; ty <= centreY + next; ty++) {
        if (Math.max(Math.abs(tx - centreX), Math.abs(ty - centreY)) !== next) continue;
        if (tx < tiles.x0 || tx > tiles.x1 || ty < tiles.y0 || ty > tiles.y1 || !drawn(tx, ty)) { complete = false; break; }
      }
    }
    if (!complete) break;
    ring = next;
  }
  const inside = Math.min(gx - (centreX - ring), centreX + ring + 1 - gx, gy - (centreY - ring), centreY + ring + 1 - gy);
  return inside * tileSize;
}
