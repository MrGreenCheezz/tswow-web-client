/**
 * 3.13 (12.10): the gossip POI on the minimap, where Wow.exe's minimap draws it (the engine, not Lua; the
 * lifetime is GossipPoi.ts).
 *
 * Wow.exe 0x007f44a0, each POI against the player: within 0.8 of the minimap's radius (0x00a34c18) and with flag
 * 0x2 (record +0x40) it is an icon on the map — a cell of Interface\Minimap\POIIcons, loaded with the minimap's
 * other art at 0x005832f0: 14 columns of 18-pixel cells on the 256-pixel sheet, the icon the 16 pixels inside
 * (WorldMap_GetPOITextureCoords, WorldMapFrame.lua:496-513, cuts the same cells); inside that radius without the
 * flag it is not drawn. Farther, within 694.44 yards (0x00a41e00), it is one of the (at most three) guide arrows
 * on the rim pointing at it — Interface\Minimap\Rotating-MinimapGuideArrow, the same load.
 */
import { minimapBlip, type MinimapPixel, type WorldPoint } from "../MinimapGeometry.js";
import type { GossipPoiMark } from "../GossipPoi.js";

export const MINIMAP_POI_ICONS_TEXTURE = "Interface\\Minimap\\POIIcons";
export const MINIMAP_GUIDE_ARROW_TEXTURE = "Interface\\Minimap\\Rotating-MinimapGuideArrow";

const ICON_COLUMNS = 14;
const ICON_CELL = 18;
const ICON_SIZE = 16;
/** Wow.exe 0x00a34c18: 0.8 of the minimap's radius. */
const NEAR_FRACTION = 0.8;
/** Wow.exe 0x00a41e00: 694.44446 yards. */
const FAR_YARDS = 694.44446;
/** AreaPOI/gossip flag 0x2: shown on the minimap (0x007f44a0). */
const FLAG_MINIMAP = 0x2;
/** The stock minimap's box, UI units (Minimap.xml: 140×140): the canvas is drawn at this size's scale. */
const MINIMAP_UNITS = 140;
/** The guide arrow's box on the rim, UI units — an estimate; the art is a 32-unit cell. */
const ARROW_UNITS = 32;

export type GossipPoiPlacement =
  | { readonly kind: "icon"; readonly point: MinimapPixel }
  | { readonly kind: "arrow"; readonly angle: number };

/**
 * Where the POI goes: an icon at its pixel, an arrow at an angle (radians clockwise from up), or nothing.
 * `radiusYards` is the circle's radius in yards, `facing` the heading when the map rotates with the player.
 */
export function gossipPoiPlacement(
  poi: GossipPoiMark,
  player: WorldPoint,
  radiusYards: number,
  yardsPerPixel: number,
  facing?: number,
): GossipPoiPlacement | undefined {
  if (!(radiusYards > 0) || !(yardsPerPixel > 0)) return undefined;
  const distance = Math.hypot(poi.x - player.x, poi.y - player.y);
  if (distance / radiusYards <= NEAR_FRACTION) {
    return (poi.flags & FLAG_MINIMAP) !== 0
      ? { kind: "icon", point: minimapBlip(player, poi, yardsPerPixel, facing) }
      : undefined;
  }
  if (distance > FAR_YARDS) return undefined;
  const direction = minimapBlip(player, poi, 1, facing);
  return { kind: "arrow", angle: Math.atan2(direction.column, -direction.row) };
}

/** The POIIcons cell of an icon index, in sheet pixels. */
export function minimapPoiIconCell(icon: number): { readonly x: number; readonly y: number; readonly size: number } {
  const index = Math.max(0, Math.trunc(icon));
  return {
    x: (index % ICON_COLUMNS) * ICON_CELL + (ICON_CELL - ICON_SIZE) / 2,
    y: Math.floor(index / ICON_COLUMNS) * ICON_CELL + (ICON_CELL - ICON_SIZE) / 2,
    size: ICON_SIZE,
  };
}

export interface MinimapPoiArt {
  readonly icons?: CanvasImageSource | undefined;
  readonly arrow?: CanvasImageSource | undefined;
}

/** Draw the placement on the minimap canvas, centred in its `radius`-pixel circle (CSS pixels, no transform). */
export function drawGossipPoi(
  context: CanvasRenderingContext2D,
  radius: number,
  placement: GossipPoiPlacement | undefined,
  art: MinimapPoiArt,
  poi: GossipPoiMark,
): void {
  if (!placement) return;
  const unit = (radius * 2) / MINIMAP_UNITS;
  if (placement.kind === "icon") {
    if (!art.icons) return;
    const cell = minimapPoiIconCell(poi.icon);
    const size = ICON_SIZE * unit;
    context.drawImage(art.icons, cell.x, cell.y, cell.size, cell.size,
      radius + placement.point.column - size / 2, radius + placement.point.row - size / 2, size, size);
    return;
  }
  if (!art.arrow) return;
  const size = ARROW_UNITS * unit;
  context.save();
  context.translate(radius, radius);
  context.rotate(placement.angle);
  context.drawImage(art.arrow, -size / 2, -radius, size, size);
  context.restore();
}
