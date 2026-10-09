/**
 * Plan item 3.13 (04.10, L6): where `QuestPOIUpdateIcons` puts each quest's icon, as Wow.exe 3.3.5a 12340
 * does it (0x5e5740 → 0x5e2eb0; read 2026-10-04 from the disassembly, descriptions only).
 *
 * - The icon blob (per quest of the POI table, in its order): of the blobs that count for the quest's
 *   objective mask and whose centroid is on the displayed map, the one with the lowest priority, then the
 *   one whose centroid is nearest the player (squared yards, kept as a float). The search starts at
 *   priority 10, so a blob above priority 10 never carries the icon. The icon starts at that centroid.
 * - The spread runs only on an area map (a dungeon floor has none). R = 24 × trunc(|LocLeft − LocRight|)
 *   / 1024 yards: two 12-pixel icon halves (the float at 0xad1014) on a 1024-pixel map (0xa1c8a0).
 *   Every quest whose objectives are not all met takes part (0x5e0ea0 asked strictly: a quest with
 *   nothing to do is not «met» there). Its y is scaled by 0.7500188 first (0xa1c89c). Then up to 20
 *   rounds (0xad1264): every pair whose integer squared distance is below R² pushes both apart by
 *   (trunc(dx·R/d), trunc(dy·R/d)); a pair on one spot takes the next of (0, 2), (1, −2), (−2, 1) as its
 *   direction and only the earlier of the two moves; a quest whose icon blob is one point does not
 *   move. When the largest push component exceeds 0.05 R (0x9f1958), every push is scaled to it
 *   (truncated); a round without a push ends the spread. y is scaled back by 1.3333 (0xa1c894).
 * - Met quests: with the CVar POIShiftComplete above 0.001 (registered with "0.6" by 0x5e71a0), each met
 *   quest after the first that lies within POIShiftComplete × 100 squared yards of an earlier met one is
 *   shifted by the next of (50, 86), (−86, 50), (−50, 86), (−90, 10) times POIShiftComplete (truncated).
 * Positions stay whole world yards; `QuestPOIGetIconInfo` (0x5e0590) maps the stored one at each call.
 *
 * Not known: the x87 precision Wow.exe runs this at (Direct3D may lower it to 24 bits); here the float
 * constants are Math.fround'ed and the arithmetic is double, which only differs at exact boundaries.
 */

/** 0xad1014: half an icon, in pixels of a 1024-pixel map (0xa1c8a0 = 1/1024). */
const ICON_HALF_PIXELS = 12;
const MAP_PIXELS = 1024;
/** 0xad1264. */
export const QUEST_POI_SPREAD_ROUNDS = 20;
/** 0x9f1958: the largest push component per round, as a fraction of R. */
const PUSH_CAP = Math.fround(0.05);
/** 0xa1c89c / 0xa1c894: y is squeezed before the spread and stretched after it. */
const Y_SQUEEZE = Math.fround(0.7500187754631042);
const Y_STRETCH = Math.fround(1.3333);
/** 0xa1c898: the running maximum's start. */
const MAX_START = -9_999_999;
/** The icon search's starting priority (0x5e2fd7). */
export const QUEST_POI_ICON_PRIORITY_LIMIT = 10;
/** POIShiftComplete's registered default (0x9f3548). */
export const QUEST_POI_SHIFT_COMPLETE_DEFAULT = 0.6;
/** 0x9e1134 and 0x9e8cc8. */
const SHIFT_MIN = Math.fround(0.001);
const SHIFT_SCALE = 100;
/** The pushes of a pair on one spot, in turn (0x5e324c). */
const SAME_SPOT: readonly (readonly [number, number])[] = Object.freeze([[0, 2], [1, -2], [-2, 1]]);
/** The shifts of a met quest next to an earlier one, in turn (0x5e374b). */
const MET_SHIFT: readonly (readonly [number, number])[] = Object.freeze([[50, 86], [-86, 50], [-50, 86], [-90, 10]]);

/** One quest's icon while it is laid out: whole world yards. */
export interface QuestPoiIconSeat {
  x: number;
  y: number;
  /** The icon blob has more than one point (0x5e3165). */
  readonly movable: boolean;
  /** 0x5e0ea0(slot, 1): every objective met, and there was at least one. */
  readonly met: boolean;
}

/** The blob fields the icon search reads. */
export interface QuestPoiIconCandidate {
  readonly objectiveIndex: number;
  readonly priority?: number | undefined;
}

/**
 * The icon blob of one quest (0x5e2fc0..0x5e30df): `eligible` says whether a blob counts for the mask
 * and its centroid is on the displayed map; `centroid` is its whole-yard centre.
 */
export function questPoiIconBlob<Blob extends QuestPoiIconCandidate>(
  blobs: readonly Blob[] | undefined,
  eligible: (blob: Blob) => boolean,
  centroid: (blob: Blob) => { readonly x: number; readonly y: number },
  player: { readonly x: number; readonly y: number } | undefined,
): Blob | undefined {
  let best: Blob | undefined;
  let bestPriority = QUEST_POI_ICON_PRIORITY_LIMIT;
  let bestDistance = Number.MAX_VALUE;
  for (const blob of blobs ?? []) {
    if (!eligible(blob)) continue;
    const priority = (blob.priority ?? 0) | 0;
    const centre = centroid(blob);
    const dx = Math.abs((player?.x ?? 0) - centre.x);
    const dy = Math.abs((player?.y ?? 0) - centre.y);
    const distance = dy * dy + dx * dx;
    if (priority < bestPriority || (distance < bestDistance && priority === bestPriority)) {
      best = blob;
      bestPriority = priority;
      // Kept in a float local (0x5e30ba).
      bestDistance = Math.fround(distance);
    }
  }
  return best;
}

/** The pushes of one round, by seat (0x5e32d0..0x5e3441); `turn` carries the same-spot direction on. */
export function questPoiPushRound(seats: readonly QuestPoiIconSeat[], r: number, r2: number, pushX: Int32Array, pushY: Int32Array,
  turn: { next: number }): void {
  pushX.fill(0);
  pushY.fill(0);
  for (let i = 0; i < seats.length; i++) {
    const a = seats[i]!;
    for (let j = i + 1; j < seats.length; j++) {
      const b = seats[j]!;
      let dx = (a.x - b.x) | 0;
      let dy = (a.y - b.y) | 0;
      // Integer squares and sum, as the client's IMUL/ADD (0x5e3354..0x5e3366).
      const d2 = (Math.imul(dy, dy) + Math.imul(dx, dx)) | 0;
      if (!(d2 < r2)) continue;
      if (d2 === 0) {
        const [sx, sy] = SAME_SPOT[turn.next]!;
        dx = sx;
        dy = sy;
        turn.next = (turn.next + 1) % SAME_SPOT.length;
      }
      const scale = r / Math.sqrt(dx * dx + dy * dy);
      const px = Math.trunc(dx * scale);
      const py = Math.trunc(dy * scale);
      if (a.movable) { pushX[i] = pushX[i]! + px; pushY[i] = pushY[i]! + py; }
      if (d2 !== 0 && b.movable) { pushX[j] = pushX[j]! - px; pushY[j] = pushY[j]! - py; }
    }
  }
}

/**
 * The spread of 0x5e31d8..0x5e382b over the quests' icons, in place. `mapWidthYards` is the displayed
 * WorldMapArea's |LocLeft − LocRight|, undefined on a dungeon floor or with no area map (no spread at
 * all then); `shiftComplete` is the POIShiftComplete CVar.
 */
export function questPoiSpreadIcons(seats: readonly QuestPoiIconSeat[], mapWidthYards: number | undefined,
  shiftComplete: number): void {
  if (mapWidthYards === undefined || !Number.isFinite(mapWidthYards)) return;
  const open = seats.filter((seat) => !seat.met);
  const met = seats.filter((seat) => seat.met);
  const r = (ICON_HALF_PIXELS + ICON_HALF_PIXELS) * Math.trunc(Math.abs(mapWidthYards)) / MAP_PIXELS;
  // R, the cap and R² are kept as floats (0x5e326d, 0x5e3278, 0x5e327d).
  const r32 = Math.fround(r);
  const cap = Math.fround(PUSH_CAP * r);
  const r2 = Math.fround(r * r);
  for (const seat of open) seat.y = Math.trunc(seat.y * Y_SQUEEZE);
  const pushX = new Int32Array(open.length);
  const pushY = new Int32Array(open.length);
  const turn = { next: 0 };
  for (let round = 0; round < QUEST_POI_SPREAD_ROUNDS; round++) {
    questPoiPushRound(open, r32, r2, pushX, pushY, turn);
    let largest = MAX_START;
    for (let index = 0; index < open.length; index++) {
      largest = Math.max(largest, Math.abs(pushX[index]!), Math.abs(pushY[index]!));
    }
    if (largest === 0) break;
    if (cap < largest) {
      const factor = cap / largest;
      for (let index = 0; index < open.length; index++) {
        pushX[index] = Math.trunc(pushX[index]! * factor);
        pushY[index] = Math.trunc(pushY[index]! * factor);
      }
    }
    for (let index = 0; index < open.length; index++) {
      open[index]!.x += pushX[index]!;
      open[index]!.y += pushY[index]!;
    }
  }
  const shift = Math.fround(shiftComplete);
  if (SHIFT_MIN < shift && met.length > 1) {
    const near = shift * SHIFT_SCALE;
    const depth = new Int32Array(met.length);
    for (let k = 1; k < met.length; k++) {
      const a = met[k]!;
      for (let j = k - 1; j >= 0; j--) {
        const b = met[j]!;
        const dy = (a.y - b.y) | 0;
        const dx = (a.x - b.x) | 0;
        if (((Math.imul(dy, dy) + Math.imul(dx, dx)) | 0) < near) {
          depth[k] = depth[j]! + 1;
          break;
        }
      }
    }
    let next = 0;
    for (let k = 1; k < met.length; k++) {
      if (depth[k] === 0) continue;
      const [sx, sy] = MET_SHIFT[next]!;
      next = (next + 1) & 3;
      met[k]!.x += Math.trunc(sx * shift);
      met[k]!.y += Math.trunc(shift * sy);
    }
  }
  for (const seat of open) seat.y = Math.trunc(seat.y * Y_STRETCH);
}

/** POIShiftComplete as the client reads a CVar's float: unset or unreadable is the default. */
export function questPoiShiftComplete(value: string | undefined): number {
  if (value === undefined) return QUEST_POI_SHIFT_COMPLETE_DEFAULT;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}
