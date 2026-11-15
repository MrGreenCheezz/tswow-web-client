/**
 * 4.15 (15.11): how close the player must stand to use a game object — Wow.exe 3.3.5a 12340, Ghidra read-only
 * (`.runtime/re-2026-11-15/go8/`, earlier `.runtime/re-2026-11-15/quest5/` and `.runtime/re-2026-11-04/go-range.txt`).
 *
 * A click on a game object (0x0070F680) asks its type helper whether it can be used (vtable slot 7). The common
 * version 0x00711470 ends with the reach test, slot 8, 0x0070FA70, which every helper keeps; a miss is ERR_USE_TOO_FAR
 * (0xF0) and nothing is sent. The reach is the helper's range (helper+0xC), set by its constructor:
 * - 5 yards from the common constructor 0x007124B0 (0x00A33574), kept by most types and by the transport helpers
 *   (0x00713250: types 11, 15, 35), the map object (14, 0x0070C510), the camera (13, 0x0070C9A0), the dungeon
 *   difficulty object (31, 0x00712820) and the destructible building (33, 0x007128D0);
 * - 5.5555553 (0x00A33570) for types 2, 9, 24, 26 and 27; 10 (0x00A33578) for the binder, type 4 (0x0070C4E0);
 *   3 (0x00A3357C) for the chair, 7 (0x0070C6A0), and the barber chair, 32 (0x0070C7F0); 100 (0x00A33580) for the
 *   fishing bobber, 17 (0x00712700); 0 for the area damage object, 12 (0x00712590).
 *
 * 0x0070FA70 measures from a box, not from the centre:
 * - type 8 (spell focus): the centre's squared distance against the range squared (inclusive);
 * - every other type: the display's box — `GameObjectDisplayInfo.GeoBox` (table 0x00AD3950, +0x30..+0x44), else the
 *   model's own box (0x00824F00 → 0x004F5E20; a door, type 0, takes its model's current box, 0x0082CED0) — scaled by
 *   OBJECT_FIELD_SCALE_X, grown by the range on every side, and tested against the player's position carried into the
 *   object's frame (its world matrix without the scale, 0x004C1BF0(1/scale) → 0x004C2FC0 → 0x004C21B0), strictly
 *   inside (0x006CB930);
 * - an object whose lock the player can open with a spell (0x0070F160) uses that spell's range (0x00802C30) instead.
 *
 * The chairs add their seats (0x00711DB0, slot 7 of both): after the common test, some seat must be closer than the
 * range (squared, strict), else ERR_USE_TOO_FAR. The seats (0x0070C700 → 0x004F55F0) are `n` points along the model's
 * own y axis, one scaled yard apart and centred on the object: y = (i − (n − 1)·0.5) for i < n (0x009E1130 = 1,
 * 0x009F70E8 = 0.5). The barber chair (0x00711EB0) then also refuses a changed form — UNIT_FIELD_DISPLAYID unlike
 * UNIT_FIELD_NATIVEDISPLAYID — or a mount, with ERR_NOT_WHILE_SHAPESHIFTED (0x1C1).
 *
 * This client has the model's box as the renderer draws it (`GameObjectPickBox.ts`: the M2 header box, which
 * GeoBox repeats for a display, or a WMO's group union) placed, turned and scaled — the eight corners the click overlay
 * reads (`RenderResults.gameObjectCorners`). Without them (the model not drawn yet, or beyond the overlay's 100 yards)
 * the centre is measured against the range, as before.
 */

/** ERR_USE_TOO_FAR, the error 0x00711470 and 0x00711DB0 give for a reach miss. */
export const ERR_USE_TOO_FAR = 0xf0;
/** ERR_NOT_WHILE_SHAPESHIFTED, the barber chair's refusal (0x00711EB0). */
export const ERR_NOT_WHILE_SHAPESHIFTED = 0x1c1;

const SPELL_FOCUS = 8;
const CHAIR = 7;
const BARBER_CHAIR = 32;

/** The type helper's range, helper+0xC (see the module comment). */
export function gameObjectUseRange(type: number): number {
  switch (type) {
    case 2: case 9: case 24: case 26: case 27: return 5.5555553;
    case 4: return 10;
    case CHAIR: case BARBER_CHAIR: return 3;
    case 12: return 0;
    case 17: return 100;
    default: return 5;
  }
}

type Point = Readonly<{ x: number; y: number; z: number }>;

/**
 * Whether `point` lies strictly inside the box of `corners` (eight world corners, `placedBoxCorners`' order: bit 0
 * max x, bit 1 max y, bit 2 max z) grown by `range` on every side, in the box's own axes (0x006CB930).
 * Undefined when the corners do not make a box.
 */
export function insideGrownBox(corners: ArrayLike<number>, range: number, point: Point): boolean | undefined {
  const ox = corners[0]!, oy = corners[1]!, oz = corners[2]!;
  const axes: [number, number, number][] = [
    [corners[3]! - ox, corners[4]! - oy, corners[5]! - oz],
    [corners[6]! - ox, corners[7]! - oy, corners[8]! - oz],
    [corners[12]! - ox, corners[13]! - oy, corners[14]! - oz],
  ];
  const lengths = axes.map(([x, y, z]) => Math.hypot(x, y, z));
  if (!lengths.every(Number.isFinite)) return undefined;
  // A flat box (a sign, a rug) has one zero edge: its direction is the cross product of the other two.
  const flats = lengths.filter((length) => length < 1e-6).length;
  if (flats > 1) return undefined;
  const directions = axes.map((axis, index) => {
    if (lengths[index]! >= 1e-6) return axis.map((value) => value / lengths[index]!) as [number, number, number];
    const a = axes[(index + 1) % 3]!, b = axes[(index + 2) % 3]!;
    const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const size = Math.hypot(normal[0]!, normal[1]!, normal[2]!);
    return normal.map((value) => value / size) as [number, number, number];
  });
  if (!directions.every((direction) => direction.every(Number.isFinite))) return undefined;
  const dx = point.x - ox, dy = point.y - oy, dz = point.z - oz;
  for (let index = 0; index < 3; index++) {
    const [ux, uy, uz] = directions[index]!;
    const along = dx * ux + dy * uy + dz * uz;
    if (!(-range < along && along < lengths[index]! + range)) return false;
  }
  return true;
}

export interface GameObjectReachQuery {
  /** The object's GO type. */
  readonly type: number;
  /** The player's position (the feet, as 0x0070FA70 reads it through the player's vtable +0x2C). */
  readonly player: Point;
  /** The object's position. */
  readonly position: Point;
  /** The drawn box's eight world corners, when the renderer has them. */
  readonly corners?: ArrayLike<number> | undefined;
  /** A lock-opening spell's maximum range, which replaces the helper's (0x0070F160 → 0x00802C30). */
  readonly spellRange?: number | undefined;
}

/** 0x0070FA70: the player within the object's reach (see the module comment). */
export function gameObjectInReach(query: GameObjectReachQuery): boolean {
  const range = query.spellRange ?? gameObjectUseRange(query.type);
  const { player, position } = query;
  const dx = player.x - position.x, dy = player.y - position.y, dz = player.z - position.z;
  const distanceSq = dx * dx + dy * dy + dz * dz;
  if (query.type === SPELL_FOCUS) return distanceSq <= range * range;
  if (query.corners !== undefined && query.corners.length >= 24) {
    const inside = insideGrownBox(query.corners, range, player);
    if (inside !== undefined) return inside;
  }
  return distanceSq <= range * range;
}

/**
 * The seats of a chair (0x0070C700 → 0x004F55F0): `count` points along the object's own y axis — its facing turned a
 * quarter left — one yard × `scale` apart, centred on its position.
 */
export function chairSeats(position: Point, orientation: number, scale: number, count: number): Point[] {
  const seats: Point[] = [];
  const sideX = -Math.sin(orientation), sideY = Math.cos(orientation);
  for (let index = 0; index < count; index++) {
    const along = (index - (count - 1) * 0.5) * scale;
    seats.push({ x: position.x + sideX * along, y: position.y + sideY * along, z: position.z });
  }
  return seats;
}

/** 0x00711DB0's own part: some seat closer than the range (squared, strict). */
export function nearAChairSeat(player: Point, seats: readonly Point[], range: number): boolean {
  const limit = range * range;
  return seats.some((seat) => {
    const dx = player.x - seat.x, dy = player.y - seat.y, dz = player.z - seat.z;
    return dx * dx + dy * dy + dz * dz < limit;
  });
}

/** Whether `type` is one of the two chair helpers that add the seat test (0x00711DB0). */
export function chairHelper(type: number): boolean {
  return type === CHAIR || type === BARBER_CHAIR;
}

/**
 * How many seats a chair helper has (its vtable +0xB0): a chair's template data word 0 (0x00710240 asks 0x00746190
 * for property 0xB, which the chair's table 0x00A36F34 lists first), the barber chair one (0x008C8DE0 returns 1).
 */
export function chairSeatCount(type: number, data: readonly number[] | undefined): number {
  if (type === BARBER_CHAIR) return 1;
  if (type !== CHAIR) return 0;
  const count = data?.[0] ?? 0;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export interface GameObjectUseQuery extends GameObjectReachQuery {
  /** The object's facing, for a chair's seats. */
  readonly orientation: number;
  /** OBJECT_FIELD_SCALE_X (1 when unset). */
  readonly scale: number;
  /** The template's data words; a chair's seats need them, so a chair without one is not judged by its seats. */
  readonly data?: readonly number[] | undefined;
}

/**
 * The reach half of slot 7 (0x00711470's last test, and 0x00711DB0's seats for the chairs): true when the original
 * would not answer ERR_USE_TOO_FAR.
 */
export function gameObjectWithinUseReach(query: GameObjectUseQuery): boolean {
  if (!gameObjectInReach(query)) return false;
  if (!chairHelper(query.type) || query.data === undefined) return true;
  const range = gameObjectUseRange(query.type);
  const seats = chairSeats(query.position, query.orientation, query.scale, chairSeatCount(query.type, query.data));
  return nearAChairSeat(query.player, seats, range);
}
