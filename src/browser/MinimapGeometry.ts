import { TERRAIN_GRID_SIZE } from "./Terrain.js";

/**
 * Where a world position lands on a map, in one place and with no DOM anywhere near it.
 *
 * Everything here follows the one convention the rest of this client already uses, taken from
 * `TerrainTile`: **world X runs north and world Y runs west**, so both a tile index and a pixel
 * inside it are `32 - value / 533.33`. North is up and east is right on the screen, which means a
 * screen column grows as world Y *falls* and a screen row grows as world X *falls*.
 *
 * That is worth stating because the radar this replaces had it mirrored: `SimpleScene` projected
 * blips through the camera's right vector negated, so east and west swapped. A minimap that
 * disagrees with the terrain under it is worse than no minimap, so nothing here is derived from
 * the camera.
 */

/** Every minimap BLP in the retail archives is 256×256; a tile is one ADT cell. */
export const MINIMAP_TILE_PIXELS = 256;

/** 2.0833… yards to the pixel. */
export const MINIMAP_YARDS_PER_PIXEL = TERRAIN_GRID_SIZE / MINIMAP_TILE_PIXELS;

/** The tile grid's origin: 64 tiles across, with the world origin at the centre of tile 32. */
const GRID_CENTER = 32;

export interface MinimapPixel {
  /** Grows southward, i.e. as world X falls. */
  row: number;
  /** Grows eastward, i.e. as world Y falls. */
  column: number;
}

export interface MinimapTile {
  gridX: number;
  gridY: number;
}

/** The pixel on the whole 64×64-tile sheet, fractional part included. */
export function minimapPixel(worldX: number, worldY: number): MinimapPixel {
  return {
    row: MINIMAP_TILE_PIXELS * (GRID_CENTER - worldX / TERRAIN_GRID_SIZE),
    column: MINIMAP_TILE_PIXELS * (GRID_CENTER - worldY / TERRAIN_GRID_SIZE),
  };
}

/**
 * Which tile a position falls in.
 *
 * `Math.floor`, not `Math.trunc` as `terrainGrid` uses: inside the grid the two agree, but past
 * +17,066 yards trunc rounds towards zero and hands back tile 0, which then passes a `>= 0` bounds
 * check and paints the far corner of the world under the character.
 */
export function minimapTileOf(worldX: number, worldY: number): MinimapTile {
  return {
    gridX: Math.floor(GRID_CENTER - worldX / TERRAIN_GRID_SIZE),
    gridY: Math.floor(GRID_CENTER - worldY / TERRAIN_GRID_SIZE),
  };
}

export interface WorldPoint {
  x: number;
  y: number;
}

/**
 * Where one thing sits relative to another on a round minimap, in pixels from the centre.
 *
 * `facing` rotates the map so the character's own heading points up, which is the original
 * client's rotating mode; leave it undefined for north up. Orientation zero is north, i.e. +X.
 */
export function minimapBlip(
  player: WorldPoint,
  object: WorldPoint,
  yardsPerPixel: number,
  facing?: number,
): MinimapPixel {
  const deltaX = object.x - player.x;
  const deltaY = object.y - player.y;
  if (facing === undefined) {
    return { row: -deltaX / yardsPerPixel, column: -deltaY / yardsPerPixel };
  }
  // The same delta read in the character's own frame: forward along the heading, rightward across
  // it. Facing north, right is east, which is falling Y — the same handedness as above.
  const forward = deltaX * Math.cos(facing) + deltaY * Math.sin(facing);
  const rightward = deltaX * Math.sin(facing) - deltaY * Math.cos(facing);
  return { row: -forward / yardsPerPixel, column: rightward / yardsPerPixel };
}

/**
 * The exact inverse of `minimapBlip`: which world position a point on the frame stands over.
 *
 * Kept next to the forward projection rather than open-coded at the click handler, because the
 * two have to agree about the sign of the rotation and a mismatch is invisible until a ping lands
 * somewhere nobody clicked.
 */
export function minimapWorldAt(
  player: WorldPoint,
  point: MinimapPixel,
  yardsPerPixel: number,
  facing?: number,
): WorldPoint {
  if (facing === undefined) {
    return { x: player.x - point.row * yardsPerPixel, y: player.y - point.column * yardsPerPixel };
  }
  const forward = -point.row * yardsPerPixel;
  const rightward = point.column * yardsPerPixel;
  return {
    x: player.x + forward * Math.cos(facing) + rightward * Math.sin(facing),
    y: player.y + forward * Math.sin(facing) - rightward * Math.cos(facing),
  };
}

/** Pushes a blip back onto the rim, so something out of range still says which way it lies. */
export function clampToCircle(blip: MinimapPixel, radius: number): MinimapPixel {
  const distance = Math.hypot(blip.row, blip.column);
  if (distance <= radius || distance === 0) return blip;
  const scale = radius / distance;
  return { row: blip.row * scale, column: blip.column * scale };
}

/**
 * The rectangle a `WorldMapArea` row covers, in world units.
 *
 * The names are the DBC's and they do not mean what they look like: `LocTop` and `LocBottom` bound
 * world **X**, `LocLeft` and `LocRight` bound world **Y**, and in every ground row `left > right`
 * and `top > bottom` — because both axes run backwards against the screen.
 */
export interface MapAreaBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Normalised position inside a world-map image: `u` rightward (east), `v` downward (south). */
export interface MapPoint {
  u: number;
  v: number;
}

/**
 * The drawable part of the 3.3.5 world-map detail frame.
 *
 * The twelve source textures are still 256px tiles (and therefore occupy 1024x768 when laid out),
 * but Blizzard's `WorldMapDetailFrame` is 1002x668.  Its frame clips the spare right column and
 * bottom row; markers use this clipped frame's dimensions, not the backing tile grid's dimensions.
 */
export const WORLD_MAP_FRAME_WIDTH = 1002;
export const WORLD_MAP_FRAME_HEIGHT = 668;

/** True when the row has a usable rectangle at all; a great many rows are four zeroes. */
export function hasMapBounds(area: MapAreaBounds): boolean {
  return area.top !== area.bottom && area.left !== area.right;
}

export function worldMapPoint(area: MapAreaBounds, worldX: number, worldY: number): MapPoint {
  return {
    u: (area.left - worldY) / (area.left - area.right),
    v: (area.top - worldX) / (area.top - area.bottom),
  };
}

/** The inverse, for a click on the map: which world position that pixel stands over. */
export function worldMapWorld(area: MapAreaBounds, point: MapPoint): WorldPoint {
  return {
    x: area.top - point.v * (area.top - area.bottom),
    y: area.left - point.u * (area.left - area.right),
  };
}
