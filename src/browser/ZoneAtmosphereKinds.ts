/**
 * 7.40 (owner's wish, 22.10): what kind of place the player stands in, for «Атмосфера зон» — mist in a marsh, light
 * under a canopy, sea haze on a coast, close air in a cave, blown snow on cold heights.
 *
 * This is the one place in the renderer whose target is not Wow.exe: the enhanced graphics only. The place is read
 * from data the client already holds, never from a list of zone names:
 *
 * - marsh  — the terrain's liquid (the map file's per-cell flag, `Terrain.liquidAt`): inland water or slime that is
 *            shallow over its own bed (≤ {@link MARSH_SHALLOW_DEPTH} yards) around the player, who stands low, near
 *            its level. A lake is deep and a river narrow; a swamp is a wide sheet of shallow water.
 * - coast  — ocean (flag 0x02) within {@link COAST_REACH} yards, the player not far above its level.
 * - forest — the scenery trees round the player (`tree|canopy|sapling|bush` in the placed model names within 38
 *            yards — the count the renderer already takes for the ambient motes).
 * - cave   — the camera inside an indoor group (MOGP 0x2000, not 0x8) of a WMO whose own file name says cave, mine,
 *            cavern, tunnel, grotto or burrow.
 * - cold   — snow-white ground in the map's colour picture (the minimap bakes, 16 texels a tile, the horizon's own
 *            `/horizon/<map>/colour.png`) round the player, or snow falling, raised on a height above the ground
 *            around (prominence).
 *
 * Each kind has its own weight 0..1 (they are not shares of one whole: a snowy coast is both), eased toward the
 * sampled target over {@link ZONE_WEIGHT_TIME_CONSTANT} seconds so walking from a meadow into a swamp fades in.
 */

/** Inland water at most this deep over its bed counts as marsh water. */
export const MARSH_SHALLOW_DEPTH = 2.5;
/** Ocean this close counts toward a coast. */
export const COAST_REACH = 100;
/** Seconds for the weights to cover ~63 % of a change. */
export const ZONE_WEIGHT_TIME_CONSTANT = 3;

/** The map file's liquid flags (Water.ts). */
const LIQUID_WATER = 0x01;
const LIQUID_OCEAN = 0x02;
const LIQUID_SLIME = 0x08;
/** MOGP flags of the camera's WMO group: 0x8 outdoor, 0x2000 indoor. */
const GROUP_OUTDOOR = 0x8;
const GROUP_INDOOR = 0x2000;

const CAVE_NAME = /cave|cavern|mine|tunnel|grotto|burrow/i;
const TREE_NAME = /tree|canopy|sapling|bush/i;

export type ZoneKind = "marsh" | "forest" | "coast" | "cave" | "cold";
export const ZONE_KINDS: readonly ZoneKind[] = Object.freeze(["marsh", "forest", "coast", "cave", "cold"]);

export type ZoneWeights = Record<ZoneKind, number>;

export function zeroZoneWeights(): ZoneWeights {
  return { marsh: 0, forest: 0, coast: 0, cave: 0, cold: 0 };
}

/** What the sampler reads round a point; every share is 0..1. */
export interface ZoneSample {
  /** Ring points within 60 yards over inland water or slime at most {@link MARSH_SHALLOW_DEPTH} deep. */
  shallow: number;
  /** Ring points within 60 yards over any inland water or slime. */
  inland: number;
  /** Ring points within {@link COAST_REACH} yards over ocean. */
  ocean: number;
  /** The player's ground above the inland water level nearby (yards); +Infinity without inland water. */
  aboveInland: number;
  /** The player's ground above the ocean level nearby (yards); +Infinity without ocean. */
  aboveOcean: number;
  /** The player's ground above the mean ground 60–100 yards round (yards); 0 when unknown. */
  prominence: number;
  /** Scenery trees within 38 yards. */
  trees: number;
  /** The camera is in an indoor group of a cave or mine WMO. */
  caveRoom: boolean;
  /** 0..1 snow-white ground round the player in the map's colour picture; 0 when the picture is not in. */
  snowGround: number;
  /** 0..1 snow falling (the weather fade's density while it snows). */
  snowing: number;
}

export function emptyZoneSample(): ZoneSample {
  return {
    shallow: 0, inland: 0, ocean: 0, aboveInland: Infinity, aboveOcean: Infinity, prominence: 0, trees: 0,
    caveRoom: false, snowGround: 0, snowing: 0,
  };
}

function clamp01(value: number): number {
  return value <= 0 || !Number.isFinite(value) ? 0 : value >= 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** The target weight of each kind for one sample. Pure; tested. */
export function zoneKindTargets(sample: Readonly<ZoneSample>, out: ZoneWeights = zeroZoneWeights()): ZoneWeights {
  // Standing low by the water: within 2 yards of its level fully, nothing from 10 up.
  const lowInland = 1 - smoothstep(2, 10, sample.aboveInland);
  // Measured shares (atmos8-points.mjs): Swamp of Sorrows 0.22, Dustwallow 0.16–0.24, a lake rim in Elwynn 0.08.
  out.marsh = clamp01(smoothstep(0.05, 0.25, sample.shallow) * (0.35 + 0.65 * lowInland)
    + 0.25 * smoothstep(0.3, 0.7, sample.inland) * lowInland * smoothstep(0.02, 0.1, sample.shallow));
  out.coast = smoothstep(0.04, 0.35, sample.ocean) * (1 - smoothstep(12, 45, sample.aboveOcean));
  out.forest = smoothstep(4, 14, sample.trees);
  out.cave = sample.caveRoom ? 1 : 0;
  const height = smoothstep(4, 40, sample.prominence);
  out.cold = clamp01(Math.max(smoothstep(0.15, 0.6, sample.snowGround), 0.8 * clamp01(sample.snowing))
    * (0.65 + 0.35 * height));
  // Under a cave roof the outdoors is not there to be read: the terrain above is someone else's weather.
  if (sample.caveRoom) {
    out.marsh = 0;
    out.coast = 0;
    out.forest = 0;
    out.cold = 0;
  }
  return out;
}

/** Eases `current` toward `target` over `elapsed` seconds; writes and returns `current`. */
export function advanceZoneWeights(current: ZoneWeights, target: Readonly<ZoneWeights>, elapsed: number): ZoneWeights {
  const step = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.5, elapsed)) : 0;
  const k = 1 - Math.exp(-step / ZONE_WEIGHT_TIME_CONSTANT);
  for (const kind of ZONE_KINDS) {
    const next = current[kind] + (target[kind] - current[kind]) * k;
    current[kind] = Math.abs(next - target[kind]) < 1e-3 ? target[kind] : next;
  }
  return current;
}

/** What the sampler asks of the terrain, in WoW world coordinates (x north, y west, z up). */
export interface ZoneTerrainProbe {
  groundAt(x: number, y: number): number | undefined;
  liquidAt(x: number, y: number): { readonly height: number; readonly type: number } | undefined;
}

/** Ring radii (yards) and directions of the terrain sample: 1 + 4 × 12 points. */
const RING_RADII = [12, 30, 60, 100] as const;
const RING_DIRECTIONS = 12;
const INLAND_REACH = 60;

/**
 * Reads the terrain round (x, y) into `out`: the liquid shares, the levels and the prominence. About fifty height and
 * liquid lookups on resident tiles; the renderer calls it about once a second.
 */
export function sampleZoneTerrain(probe: ZoneTerrainProbe, x: number, y: number, out: ZoneSample): ZoneSample {
  let inlandPoints = 0;
  let oceanPoints = 0;
  let shallow = 0;
  let inland = 0;
  let ocean = 0;
  let inlandLevel = -Infinity;
  let oceanLevel = -Infinity;
  let farGround = 0;
  let farCount = 0;
  const here = probe.groundAt(x, y);
  const visit = (px: number, py: number, radius: number): void => {
    const ground = probe.groundAt(px, py);
    const liquid = probe.liquidAt(px, py);
    if (radius >= 60 && ground !== undefined && Number.isFinite(ground)) {
      farGround += liquid && liquid.height > ground ? liquid.height : ground;
      farCount++;
    }
    const isOcean = liquid !== undefined && (liquid.type & LIQUID_OCEAN) !== 0;
    const isInland = liquid !== undefined && !isOcean && (liquid.type & (LIQUID_WATER | LIQUID_SLIME)) !== 0;
    if (radius <= INLAND_REACH) {
      inlandPoints++;
      if (isInland && ground !== undefined && liquid!.height > ground) {
        inland++;
        if (liquid!.height - ground <= MARSH_SHALLOW_DEPTH) shallow++;
        inlandLevel = Math.max(inlandLevel, liquid!.height);
      }
    }
    oceanPoints++;
    if (isOcean && (ground === undefined || liquid!.height > ground)) {
      ocean++;
      oceanLevel = Math.max(oceanLevel, liquid!.height);
    }
  };
  visit(x, y, 0);
  for (const radius of RING_RADII) {
    for (let i = 0; i < RING_DIRECTIONS; i++) {
      // Each ring turned by half a step against the one inside it, so the rays do not line up.
      const angle = ((i + (radius === 30 || radius === 100 ? 0.5 : 0)) / RING_DIRECTIONS) * Math.PI * 2;
      visit(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, radius);
    }
  }
  out.shallow = inlandPoints > 0 ? shallow / inlandPoints : 0;
  out.inland = inlandPoints > 0 ? inland / inlandPoints : 0;
  out.ocean = oceanPoints > 0 ? ocean / oceanPoints : 0;
  const ground = here !== undefined && Number.isFinite(here) ? here : undefined;
  out.aboveInland = ground !== undefined && Number.isFinite(inlandLevel) ? Math.max(0, ground - inlandLevel) : Infinity;
  out.aboveOcean = ground !== undefined && Number.isFinite(oceanLevel) ? Math.max(0, ground - oceanLevel) : Infinity;
  out.prominence = ground !== undefined && farCount > 0 ? ground - farGround / farCount : 0;
  return out;
}

/** Scenery trees within `radius` yards of (x, y); `objects` are the placed models (world coordinates). */
export function countZoneTrees(
  objects: Iterable<{ readonly kind: string; readonly name: string; readonly x: number; readonly y: number }>,
  x: number, y: number, radius = 38,
): number {
  let trees = 0;
  const r2 = radius * radius;
  for (const object of objects) {
    if (object.kind !== "m2") continue;
    const dx = object.x - x;
    const dy = object.y - y;
    if (dx * dx + dy * dy > r2) continue;
    if (TREE_NAME.test(object.name)) trees++;
  }
  return trees;
}

/** Whether the camera's WMO group is a cave or mine room: an indoor group of a WMO named so. */
export function caveRoom(modelName: string | undefined, groupFlags: number | undefined): boolean {
  if (!modelName || groupFlags === undefined) return false;
  if ((groupFlags & GROUP_INDOOR) === 0 || (groupFlags & GROUP_OUTDOOR) !== 0) return false;
  const base = modelName.slice(Math.max(modelName.lastIndexOf("\\"), modelName.lastIndexOf("/")) + 1);
  return CAVE_NAME.test(base);
}

/** The map colour picture: 64 tiles of {@link MAP_COLOUR_TEXELS} texels a side, RGBA, row = world X. */
export const MAP_COLOUR_TEXELS = 16;
const TILE_SIZE = 1600 / 3;

export interface MapColourPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** 0..1: how much one sRGB texel looks like snow — bright, nearly grey, never warmer than it is blue. Pure; tested. */
export function snowTexel(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  if (max <= 0) return 0;
  const light = (r + g + b) / (3 * 255);
  const saturation = (max - Math.min(r, g, b)) / max;
  const cool = b >= r * 0.92 ? 1 : 0;
  return smoothstep(0.52, 0.7, light) * (1 - smoothstep(0.12, 0.28, saturation)) * cool;
}

/**
 * The snow share of the 5 × 5 texels (about 170 yards) round (x, y) in the map's colour picture. The picture's row is
 * the tile row along world X and its column the one along world Y, as the horizon lays it (`Horizon.ts writeUv`).
 */
export function mapSnowShare(pixels: MapColourPixels, x: number, y: number): number {
  const row = Math.floor((32 - x / TILE_SIZE) * MAP_COLOUR_TEXELS);
  const column = Math.floor((32 - y / TILE_SIZE) * MAP_COLOUR_TEXELS);
  let sum = 0;
  let count = 0;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const r = row + dr;
      const c = column + dc;
      if (r < 0 || c < 0 || r >= pixels.height || c >= pixels.width) continue;
      const at = (r * pixels.width + c) * 4;
      if (pixels.data[at + 3]! < 8) continue; // no tile there
      sum += snowTexel(pixels.data[at]!, pixels.data[at + 1]!, pixels.data[at + 2]!);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}
