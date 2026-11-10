/**
 * 3.13 (07.11): which points of interest the minimap marks, as Wow.exe 0x007f44a0 sorts them (.runtime/re-2026-11-07/313).
 *
 * Its list is the AreaPOI of the map with flag 0x1, last record first (0x007f6730), and after them the client's own
 * marks: the guard's POI (SMSG_GOSSIP_POI, 0x007f4870), the corpse (CORPSE_RED, importance −1, flags 0x2, icon 8;
 * 0x007f4990) and the spirit healer (0x007f4a00). Each one at the origin is nothing. Within 0.8 of the circle's
 * radius (0x00a34c18) it is an icon of POIIcons when its flags have 0x2, otherwise nothing. Farther it may be one of
 * the guide arrows: within 694.44 yards (0x00a41e00), the corpse at any distance; of those at most three are kept,
 * the lowest importance first and the nearer of two equal ones — a new one takes the place of the worst kept, which is
 * the highest importance and, between equals, the farther. 0x007f4b60 copies the three with their names; the
 * minimap draws an AreaPOI's with Rotating-MinimapArrow, the corpse's with the corpse arrow, the others with the guide
 * arrow (0x0057d860), and over a building's own minimap only the client's marks and AreaPOI with flag 0x100.
 */
import type { WorldPoint } from "../MinimapGeometry.js";

/** 0x00a34c18. */
const NEAR_FRACTION = 0.8;
/** 0x00a41e00. */
const FAR_YARDS = 694.44446;
const MAX_ARROWS = 3;
/** AreaPOI flags: on the minimap inside the circle; kept over a building's minimap (0x007f4b60). */
const FLAG_ICON = 0x2;
const FLAG_INSIDE = 0x100;

/** 11.11: "spiritHealer" is 0x007f4a00's mark (world/SpiritHealerMark.ts); unlike the corpse it keeps the 694-yard limit. */
export type MinimapGuideKind = "areaPoi" | "gossip" | "corpse" | "spiritHealer";

export interface MinimapGuideCandidate extends WorldPoint {
  readonly kind: MinimapGuideKind;
  readonly importance: number;
  readonly flags: number;
}

export interface MinimapGuideMarks<T extends MinimapGuideCandidate> {
  readonly icons: readonly T[];
  /** In the order of their slots, which is the order the tooltip names them. */
  readonly arrows: readonly T[];
}

/** `candidates` in Wow.exe's order (see above); `radiusYards` is the circle's radius. */
export function minimapGuideMarks<T extends MinimapGuideCandidate>(
  candidates: readonly T[],
  player: WorldPoint,
  radiusYards: number,
): MinimapGuideMarks<T> {
  const icons: T[] = [];
  const slots: { candidate: T; distance: number }[] = [];
  let worst = -1;
  for (const candidate of candidates) {
    if (candidate.x === 0 && candidate.y === 0) continue;
    const distance = Math.hypot(candidate.x - player.x, candidate.y - player.y);
    if (radiusYards > 0 && distance / radiusYards <= NEAR_FRACTION) {
      if ((candidate.flags & FLAG_ICON) !== 0) icons.push(candidate);
      continue;
    }
    if (distance > FAR_YARDS && candidate.kind !== "corpse") continue;
    if (worst < 0) {
      slots.push({ candidate, distance });
    } else {
      const kept = slots[worst]!;
      if (candidate.importance < kept.candidate.importance
        || (candidate.importance === kept.candidate.importance && distance < kept.distance)) {
        slots[worst] = { candidate, distance };
      }
    }
    if (slots.length === MAX_ARROWS) {
      worst = 0;
      for (let index = 1; index < MAX_ARROWS; index++) {
        const at = slots[worst]!;
        const other = slots[index]!;
        if (at.candidate.importance < other.candidate.importance
          || (at.candidate.importance === other.candidate.importance && at.distance < other.distance)) worst = index;
      }
    }
  }
  return { icons, arrows: slots.map((slot) => slot.candidate) };
}

/** Whether a kept arrow is drawn over a building's own minimap (0x0057d860 with 0x00bf5f10 set). */
export function minimapGuideArrowInside(candidate: MinimapGuideCandidate): boolean {
  return candidate.kind !== "areaPoi" || (candidate.flags & FLAG_INSIDE) !== 0;
}
