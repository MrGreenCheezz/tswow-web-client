/**
 * 3.13 (07.11): what the minimap says under the pointer, as Wow.exe's CGMinimapFrame does it (0x0057c720, slot 31 of
 * its vtable 0x00a11dd8, run on each mouse move over the frame; .runtime/re-2026-11-07/313).
 *
 * The engine, not Minimap.lua, owns this tooltip. On a move it hit-tests what it drew last, in a fixed order: the guide
 * arrows on the rim (at most three, MinimapGuideArrows.ts), the party's rim arrows, the raid's, the POI icons in the
 * circle (AreaPOI, the guard's mark, the corpse), then the blips list by list — list 0 the raid, 1 the party, 2–22 the
 * ObjectIcons cells, an object's list being its cell. An arrow is hit within 0.005 of the frame's scale of its centre
 * (0x009e3000, strictly), which is 6.4 frame units; an icon or a blip within 0.00625 of the screen (0x00beba58, both
 * edges included), which the frame's scale does not touch: 8 units at scale 1. Only when the set of hits changes does it
 * write: GameTooltip:SetOwner(Minimap, ANCHOR_CURSOR) (anchor 8, 0x0061ea00), the names one per line as the first line
 * in NORMAL_FONT_COLOR (0x006201c0 with the default 0x00ad2d2c), Show; an empty set, or leaving the frame with hits,
 * hides GameTooltip.
 */
import type { MinimapPixel } from "../MinimapGeometry.js";

/** 0x009e3000 × the frame's scale, over a frame unit (0.6 / 768 of the screen at scale 1): 6.4 units. */
export const MINIMAP_HOVER_ARROW_UNITS = 6.4;
/** 0x00beba58 (0.0125 × 0.5 of the screen) over a frame unit at scale 1. */
export const MINIMAP_HOVER_ICON_UNITS = 8;
/** 0x0057c720: a blip inside a building the player is not in is written grey. */
const GREY = "|cffb0b0b0";

export interface MinimapHoverMark {
  /** Frame units from the circle's centre, `row` down. */
  readonly point: MinimapPixel;
  readonly name: string | undefined;
}

export interface MinimapHoverBlip extends MinimapHoverMark {
  /** Wow.exe's list: 0 the raid, 1 the party, otherwise the ObjectIcons cell. */
  readonly list: number;
  readonly grey?: boolean;
  /** The creature's subname, shown for the profession-trainer tracker (its NPC flag mask has 0x40). */
  readonly subName?: string | undefined;
  /** An undiscovered flight master (list 13): its line under the name when colorblindMode is on. */
  readonly flightMaster?: boolean;
}

export interface MinimapHoverScene {
  readonly guideArrows: readonly MinimapHoverMark[];
  readonly partyArrows: readonly MinimapHoverMark[];
  readonly raidArrows: readonly MinimapHoverMark[];
  readonly poiIcons: readonly MinimapHoverMark[];
  readonly blips: readonly MinimapHoverBlip[];
}

export interface MinimapHoverHit {
  /** What Wow.exe compares between two moves: the category, the list and the place in it. */
  readonly key: string;
  readonly mark: MinimapHoverMark | MinimapHoverBlip;
  readonly blip: boolean;
}

/**
 * The hits under `cursor` (frame units from the centre) in the order the text is written. `scale` is the frame's
 * effective scale: it widens the icons' box in frame units, the arrows' does not move.
 */
export function minimapHoverHits(scene: MinimapHoverScene, cursor: MinimapPixel, scale: number): MinimapHoverHit[] {
  const hits: MinimapHoverHit[] = [];
  const half = MINIMAP_HOVER_ICON_UNITS / (scale > 0 ? scale : 1);
  const nearArrow = (point: MinimapPixel): boolean => Math.abs(cursor.column - point.column) < MINIMAP_HOVER_ARROW_UNITS
    && Math.abs(cursor.row - point.row) < MINIMAP_HOVER_ARROW_UNITS;
  const onIcon = (point: MinimapPixel): boolean => Math.abs(cursor.column - point.column) <= half
    && Math.abs(cursor.row - point.row) <= half;
  const marks = (prefix: string, list: readonly MinimapHoverMark[], test: (point: MinimapPixel) => boolean): void => {
    list.forEach((mark, index) => {
      if (test(mark.point)) hits.push({ key: `${prefix}${index}`, mark, blip: false });
    });
  };
  marks("g", scene.guideArrows, nearArrow);
  marks("p", scene.partyArrows, nearArrow);
  marks("r", scene.raidArrows, nearArrow);
  marks("i", scene.poiIcons, onIcon);
  const lists = new Map<number, MinimapHoverBlip[]>();
  for (const blip of scene.blips) {
    const list = lists.get(blip.list);
    if (list) list.push(blip);
    else lists.set(blip.list, [blip]);
  }
  for (const list of [...lists.keys()].sort((left, right) => left - right)) {
    lists.get(list)!.forEach((blip, index) => {
      if (onIcon(blip.point)) hits.push({ key: `b${list}:${index}`, mark: blip, blip: true });
    });
  }
  return hits;
}

/** Whether two sets of hits are the same to Wow.exe, which then leaves the tooltip as it is. */
export function sameMinimapHoverHits(left: readonly MinimapHoverHit[], right: readonly MinimapHoverHit[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index]!.key !== right[index]!.key) return false;
  return true;
}

export interface MinimapHoverStrings {
  /** The colorblindMode CVar. */
  readonly colorblind: boolean;
  /** MINIMAP_TRACKING_FLIGHTMASTER. */
  readonly flightMaster?: string | undefined;
}

/**
 * The tooltip's text: one entry per line. A mark's name goes as it is; a blip without a name (an object gone and no
 * name cached) is left out; a blip's own lines follow its name, each "\n <…>": the flight master's in colorblind mode,
 * then the subname.
 */
export function minimapHoverText(hits: readonly MinimapHoverHit[], strings: MinimapHoverStrings): string {
  const lines: string[] = [];
  for (const hit of hits) {
    const name = hit.mark.name;
    if (!hit.blip) {
      lines.push(name ?? "");
      continue;
    }
    if (name === undefined) continue;
    const blip = hit.mark as MinimapHoverBlip;
    let line = blip.grey ? GREY + name : name;
    if (blip.flightMaster && strings.colorblind && strings.flightMaster) line += `\n <${strings.flightMaster}>`;
    if (blip.subName) line += `\n <${blip.subName}>`;
    if (blip.grey) line += "|r";
    lines.push(line);
  }
  return lines.join("\n");
}
