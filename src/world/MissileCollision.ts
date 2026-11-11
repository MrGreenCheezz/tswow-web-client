import { buildUpdateProjectilePosition, type Vec3 } from "./MissileTrajectory.js";
import { SPELL_MISSILE_COLLISION_MASK, type SpellMissileEntry } from "./SpellMissileDbc.js";

/**
 * 11.02 (11.11): a trajectory missile that meets a unit on its way — `CMSG_UPDATE_PROJECTILE_POSITION` — as Wow.exe
 * 3.3.5a 12340 does it (Ghidra, read-only: .runtime/re-2026-11-11/vehicle2/v1-v4.c, refs1.txt; the flight itself
 * .runtime/re-2026-10-03/l1102e/r2-r4.c and .runtime/re-2026-10-11/glue-1110/1013-m1.txt).
 *
 * Who tests (the launcher 0x00732ff0 at 0x0073375c): Missile_C +0x68 gets 0x200000 when the caster is the active player
 * and nothing charms it (CHARMEDBY 0), or the caster's +0xa30 has 0x400 — the bit SMSG_CLIENT_CONTROL_UPDATE with allow 1
 * sets (0x0071c930): the unit this client moves, a vehicle it drives. Then 0x00700880, when the flight starts, and only
 * for a SpellMissile row with Flags & 0x3c, lays the path (0x006fcb60) and picks the units that may cross it:
 *
 * - The path (0x006fcb60): the fire point and the aim in the plane, the unit direction and its left normal, the
 *   horizontal length, the horizontal speed `speed × cos(elevation)` (the cosine by a cubic, 0x005fe800: with n the
 *   floor of elevation / π and f the rest, `1 − (6 − 4f) f²`, negated for an odd n; at least 1e-4) and the time
 *   `length / horizontal speed`. Aim and fire point closer than 0.001 in both x and y: the length is 1 along +x, the
 *   start moved 0.01 back, and the speed `0.01 / (distance / speed)` (`0.01` when the speed is under 1e-4).
 * - The candidates (0x004d4b30 over every object → 0x006fcaa0, at most 128): a unit, not the caster's root (the vehicle a
 *   passenger caster rides, 0x00748040, else the caster) nor riding it, that the row lets through (0x006fc4a0's head:
 *   a player by Flags & 0xc — 0x4 the ones the active player can attack (CanAttack 0x00729740), 0x8 the others, both
 *   every player; a creature by Flags & 0x30 the same way, 0x10/0x20, and only with its template's type_flags 0x80000
 *   CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES), with a reach key that is not −1 (`missileCollisionReach`). More than 15:
 *   a heap sort (0x006fc7d0, a min-heap, so the array ends largest first) and the first 15 stay.
 * - The sphere (0x006fbff0, then 0x006fc0a0 adds the row's CollisionRadius): the unit's world position (0x00717fc0, a
 *   passenger's through its transport) with the CreatureModelData of its display (0x00717a20): radius
 *   MissileCollisionRadius × scale, or CollisionHeight / 2 (unscaled) when that is not above 0; the centre pushed back
 *   along the path by MissileCollisionPush × scale, raised by MissileCollisionRaise × scale and then by the radius. No
 *   model row: radius 1, raised by 1. The scale is vfunc +0x7c (0x0071c0e0: unit +0xb3c × +0x9c × +0x98, × the mount's
 *   scale when mounted).
 * - Every frame of the flight (0x007015d0), after the step: the spheres are made again where the units are now
 *   (0x006fc9b0 → 0x006fc0a0) and the step's segment old → new is tested (0x006fc360, `missileSegmentHit`); a hit at
 *   a fraction above 0 puts the missile at that point of the segment and 0x00703640 sends `u64 caster | u32 spell |
 *   u8 castCount | f32 xyz` (the missile's own caster, spell and cast count), then the missile lands there (0x00703410).
 *
 * TrinityCore (SpellHandler.cpp:805-843) moves the current spell's destination to that point, recalculates the flight
 * delay and sends SMSG_SET_PROJECTILE_POSITION to the caster's set (MissileFlight.ts takes it on the drawn missiles).
 *
 * Not repeated here: the frame cadence (the tracker steps on its own timer, `MISSILE_COLLISION_STEP_MS`; the point sent
 * is where the path comes closest to the sphere's centre, so it barely depends on where the frames fall), one tracked
 * flight per cast (Wow.exe tests every Missile_C of the cast's visual), only CAST_FLAG_ADJUST_MISSILE flights (the
 * ballistic branch; a homing missile of such a row would be tested too), and the order of the object list (it decides
 * only between two spheres met in one step).
 */

/** 0x009e2ef4: the "nothing" every function here answers. */
export const MISSILE_COLLISION_NONE = -1;
/** 0x009e8cd0. */
const SMALL = 1e-4;
/** 0x009ea558: a step shorter than this tests nothing. */
const SEGMENT_MIN = 1e-5;
/** 0x009e1134 and 0x009f1968: the degenerate path's limits. */
const SAME_SPOT = 0.001;
const NUDGE = 0.01;
/** 0x009ea4c8: the key of a unit already behind the start. */
const BEHIND = 10000;
/** 0x00a1e8d4 (1 / π as a float). */
const INV_PI = 0.31830987;
/** 0x006fcaa0 stops at 0x80 candidates; 0x006fcb60 keeps 0xf. */
export const MISSILE_COLLISION_MAX_CANDIDATES = 128;
export const MISSILE_COLLISION_MAX_UNITS = 15;
/** CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES (SharedDefines.h), the bit 0x006fc4a0 reads at template +0xc. */
export const CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES = 0x0008_0000;

/** The row makes its missiles collide (0x00700880, 0x006fcd60: `row+4 & 0x3c`). */
export function missileCollides(row: Pick<SpellMissileEntry, "flags"> | undefined): boolean {
  return row !== undefined && (row.flags & SPELL_MISSILE_COLLISION_MASK) !== 0;
}

/** 0x006fcb60's cosine (0x005fe800 + the cubic). */
export function missileCollisionCosine(elevation: number): number {
  const x = elevation * INV_PI;
  const n = x > 0 ? Math.trunc(x) : Math.trunc(x) - 1;
  const f = x - n;
  const value = 1 - (6 - 4 * f) * f * f;
  return (n & 1) !== 0 ? -value : value;
}

/** 0x006fcb60's node: the path in the plane. */
export interface MissileCollisionPath {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly dirX: number;
  readonly dirY: number;
  /** The left normal (−dirY, dirX). */
  readonly perpX: number;
  readonly perpY: number;
  readonly length: number;
  /** Seconds, length / horizontal speed. */
  readonly time: number;
  readonly speed: number;
}

/** 0x006fcb60 from the fire point, the aim, the (folded) elevation and the launch speed. */
export function missileCollisionPath(fire: Readonly<Vec3>, aim: Readonly<Vec3>, elevation: number, speed: number): MissileCollisionPath {
  let startX = fire.x;
  const startY = fire.y;
  let dirX = aim.x - fire.x;
  let dirY = aim.y - fire.y;
  let length: number;
  let horizontal: number;
  if (Math.abs(dirX) >= SAME_SPOT || Math.abs(dirY) >= SAME_SPOT) {
    length = Math.sqrt(dirX * dirX + dirY * dirY);
    dirX /= length;
    dirY /= length;
    horizontal = missileCollisionCosine(elevation) * speed;
    if (horizontal < SMALL) horizontal = SMALL;
  } else {
    const seconds = speed > SMALL ? Math.hypot(aim.x - fire.x, aim.y - fire.y, aim.z - fire.z) / speed : 1;
    horizontal = NUDGE / seconds;
    startX -= NUDGE;
    dirX = 1;
    dirY = 0;
    length = 1;
  }
  return {
    startX, startY, endX: aim.x, endY: aim.y, dirX, dirY, perpX: -dirY, perpY: dirX,
    length, time: length / horizontal, speed: horizontal,
  };
}

/** A CreatureModelData row's columns 0x006fbff0 reads (+0x3c, +0x64, +0x68, +0x6c). */
export interface MissileCollisionModel {
  readonly collisionHeight: number;
  readonly missileCollisionRadius: number;
  readonly missileCollisionPush: number;
  readonly missileCollisionRaise: number;
}

/** A unit's body as 0x006fbff0 reads it. `model` undefined: no CreatureModelData for the display (0x00717a20 = 0). */
export interface MissileCollisionBody {
  readonly position: Readonly<Vec3>;
  readonly scale: number;
  readonly model: MissileCollisionModel | undefined;
}

export interface MissileCollisionSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** 0x006fbff0 + 0x006fc0a0's CollisionRadius: the sphere of a unit against `path`. */
export function missileCollisionSphere(body: MissileCollisionBody, path: Pick<MissileCollisionPath, "dirX" | "dirY">,
  row: Pick<SpellMissileEntry, "collisionRadius">,
  out: MissileCollisionSphere = { x: 0, y: 0, z: 0, r: 0 }): MissileCollisionSphere {
  out.x = body.position.x;
  out.y = body.position.y;
  out.z = body.position.z;
  const model = body.model;
  if (model === undefined) {
    out.r = 1;
  } else {
    const scale = body.scale;
    out.r = model.missileCollisionRadius <= 0 ? model.collisionHeight * 0.5 : scale * model.missileCollisionRadius;
    const push = model.missileCollisionPush * scale;
    out.x -= path.dirX * push;
    out.y -= path.dirY * push;
    out.z += scale * model.missileCollisionRaise;
  }
  out.z += out.r;
  out.r += Number.isFinite(row.collisionRadius) ? row.collisionRadius : 0;
  return out;
}

/**
 * 0x006fc4a0's geometry: whether a unit running at `maxSpeed` (the largest of its run, swim and flight speeds, mover
 * +0x94/+0x9c/+0xa4) can reach the path while the missile flies it, as a key that is larger the likelier, or −1.
 */
export function missileCollisionReach(path: MissileCollisionPath, sphere: Readonly<MissileCollisionSphere>, maxSpeed: number): number {
  const radius = sphere.r;
  if (!(radius >= SMALL)) return MISSILE_COLLISION_NONE;
  const ex = path.endX - sphere.x;
  const ey = path.endY - sphere.y;
  let before: number;
  if (path.speed <= maxSpeed) {
    before = MISSILE_COLLISION_NONE;
  } else {
    const across = Math.abs(path.perpX * ex + path.perpY * ey);
    const along = (path.perpY * across + sphere.y - path.startY) * path.dirY + path.dirX * (path.perpX * across + sphere.x - path.startX);
    if (along >= SMALL) {
      if (path.length <= along) before = MISSILE_COLLISION_NONE;
      else {
        const reach = (along / path.length) * path.time * maxSpeed + radius;
        before = (reach * reach - across * across) / along;
      }
    } else {
      const sx = path.startX - sphere.x;
      const sy = path.startY - sphere.y;
      before = (radius * radius - (sy * sy + sx * sx)) * BEHIND;
    }
  }
  const reach = path.time * maxSpeed + radius;
  const after = (reach * reach - (ey * ey + ex * ex)) / path.length;
  if (after > 0 && before < after) return after;
  if (before > 0) return before;
  return MISSILE_COLLISION_NONE;
}

/** What 0x006fc4a0's head asks of a unit. `canAttack` is CanAttack from the active player, undefined without one. */
export interface MissileCollisionUnitKind {
  readonly isPlayer: boolean;
  /** The creature template's type_flags; undefined when the template is not cached (+0x964 = 0). */
  readonly creatureTypeFlags: number | undefined;
  readonly canAttack: boolean | undefined;
}

/** 0x006fc4a0's head: the row's Flags let this unit be met. */
export function missileCollisionTargets(rowFlags: number, unit: MissileCollisionUnitKind): boolean {
  let mask: number;
  let shift: number;
  if (unit.isPlayer) {
    mask = rowFlags & 0xc;
    shift = 2;
  } else {
    mask = rowFlags & 0x30;
    shift = 4;
    if (mask !== 0 && ((unit.creatureTypeFlags ?? 0) & CREATURE_TYPE_FLAG_COLLIDE_WITH_MISSILES) === 0) return false;
  }
  if (mask === 0) return false;
  if (mask === 0xc << (shift - 2)) return true;
  if (unit.canAttack === undefined) return false;
  // The low bit of the pair: the attackable ones; the high bit: the others.
  return ((mask >> shift) & 1) !== 0 ? unit.canAttack : !unit.canAttack;
}

/** 0x006fcb60's cut (0x006fc7d0 sorts largest first): the units kept, in list order up to 15, else the 15 largest keys. */
export function missileCollisionKeep<T>(candidates: readonly { readonly unit: T; readonly key: number }[]): T[] {
  const list = candidates.length > MISSILE_COLLISION_MAX_UNITS
    ? [...candidates].sort((a, b) => b.key - a.key).slice(0, MISSILE_COLLISION_MAX_UNITS)
    : candidates;
  return list.map((entry) => entry.unit);
}

/**
 * 0x006fc360: the fraction of the step `from → to` at which it passes a sphere's centre closest — the first sphere, in
 * list order, whose centre lies ahead within the step and no further from the line than its radius — or −1.
 */
export function missileSegmentHit(from: Readonly<Vec3>, to: Readonly<Vec3>, spheres: readonly Readonly<MissileCollisionSphere>[]): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length < SEGMENT_MIN) return MISSILE_COLLISION_NONE;
  const inv = 1 / length;
  for (const sphere of spheres) {
    if (!(sphere.r > 0)) return MISSILE_COLLISION_NONE;
    const vx = sphere.x - from.x;
    const vy = sphere.y - from.y;
    const vz = sphere.z - from.z;
    const ahead = vy * (dy * inv) + vx * (dx * inv) + vz * (inv * dz);
    if (ahead >= 0 && vz * vz + vx * vx + vy * vy - ahead * ahead <= sphere.r * sphere.r && ahead <= length) return ahead * inv;
  }
  return MISSILE_COLLISION_NONE;
}

// ---- the ballistic flight (0x00700880 → 0x0076c070, 0x007015d0's 0x10000 branch) -----------------------------------

/** 0x00a32f74: the gravity of a missile without a SpellMissile row. */
export const MISSILE_DEFAULT_GRAVITY = 19.291105270385742;
const SOLVE_EPSILON = 1e-4;

/**
 * 0x0076c070: the parabola leaving at `elevation` that passes `delta` (aim − fire) under `gravity`.
 * 0 unsolvable, 1 degenerate, 2 solved (`out` = [time, vx, vy, vz, speed]).
 */
export function trajectoryLaunch(elevation: number, delta: Readonly<Vec3>, gravity: number, out: Float64Array): 0 | 1 | 2 {
  const cosine = Math.cos(elevation);
  const sine = Math.sin(elevation);
  const flat = Math.hypot(delta.x, delta.y);
  if (Math.abs(cosine) < SOLVE_EPSILON || Math.abs(flat) < SOLVE_EPSILON || Math.abs(gravity) < SOLVE_EPSILON) return 1;
  let squared = ((1 / cosine) * flat * sine - delta.z) / gravity;
  squared += squared;
  if (squared <= 0.009999999776482582) return 0;
  const time = Math.sqrt(squared);
  const speed = (flat / time) * (1 / cosine);
  out[0] = time;
  out[1] = speed * delta.x * (1 / flat) * cosine;
  out[2] = speed * (1 / flat) * cosine * delta.y;
  out[3] = sine * speed;
  if (out.length > 4) out[4] = speed;
  return 2;
}

/** 0x00700880: the elevation folded back into [−π/2, π/2] (a mirror at each end). */
export function foldElevation(elevation: number): number {
  const half = Math.PI / 2;
  if (elevation > half) return elevation - 2 * (elevation - half);
  if (elevation < -half) return elevation + 2 * (-half - elevation);
  return elevation;
}

/** A solved ballistic flight: launch velocity, gravity, clock scale (+0x120, +0x140, +0x130), and what 0x006fcb60 takes. */
export interface MissileBallistic {
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly gravity: number;
  readonly scale: number;
  /** The folded elevation it was solved at (0x00700880's local_8) and the launch speed (local_c). */
  readonly elevation: number;
  readonly speed: number;
}

const _solve = new Float64Array(5);

/** 0x00700880 for a trajectory: the flight, or undefined where Wow.exe flies the straight line instead. */
export function solveMissileBallistic(fire: Readonly<Vec3>, aim: Readonly<Vec3>, elevation: number, gravity: number,
  remainingMs: number): MissileBallistic | undefined {
  const delta = { x: aim.x - fire.x, y: aim.y - fire.y, z: aim.z - fire.z };
  const g = Number.isFinite(gravity) ? gravity : MISSILE_DEFAULT_GRAVITY;
  let folded = foldElevation(elevation);
  let result = trajectoryLaunch(folded, delta, g, _solve);
  if (result === 0) {
    folded = foldElevation(elevation + (g > 0 ? 0.01 : -0.01));
    result = trajectoryLaunch(folded, delta, g, _solve);
  }
  if (result !== 2) return undefined;
  const left = Math.max(remainingMs / 1000, SOLVE_EPSILON);
  const scale = _solve[0]! / left;
  return {
    vx: _solve[1]!, vy: _solve[2]!, vz: _solve[3]!, gravity: g,
    scale: scale < 0 ? 0 : scale >= 2 ? 2 : scale, elevation: folded, speed: _solve[4]!,
  };
}

/** 0x007015d0's 0x10000 branch: where the missile is `elapsedMs` after launch. */
export function ballisticPoint(fire: Readonly<Vec3>, flight: MissileBallistic, elapsedMs: number, out: Vec3): Vec3 {
  const tau = (elapsedMs / 1000) * flight.scale;
  out.x = fire.x + flight.vx * tau;
  out.y = fire.y + flight.vy * tau;
  out.z = fire.z + flight.vz * tau - flight.gravity * tau * tau * 0.5;
  return out;
}

// ---- the tracker -----------------------------------------------------------------------------------------------------

/** One unit as the world offers it to the selection. */
export interface MissileCollisionCandidate extends MissileCollisionUnitKind {
  readonly guid: bigint;
  /** The vehicle it rides (0x00748040), else undefined. */
  readonly root: bigint | undefined;
  /** max(run, swim, flight) speed. */
  readonly maxSpeed: number;
}

/** What the tracker reads of the world, now. */
export interface MissileCollisionWorld {
  /** Every unit in view, in the object list's order. */
  units(): Iterable<MissileCollisionCandidate>;
  /** The unit's body where it is now; undefined once it is gone. */
  body(guid: bigint): MissileCollisionBody | undefined;
}

/** A trajectory missile of this client's own cast (Missile_C with +0x68 0x200000 and a row with Flags & 0x3c). */
export interface MissileCollisionLaunch {
  readonly caster: bigint;
  /** 0x00700880's DAT_00ca0ae8: the caster's vehicle when it rides one, else the caster. */
  readonly exclude: bigint;
  readonly spellId: number;
  readonly castCount: number;
  readonly row: SpellMissileEntry;
  readonly fire: Readonly<Vec3>;
  readonly aim: Readonly<Vec3>;
  readonly elevation: number;
  readonly delayMs: number;
}

interface CollisionFlight {
  readonly launch: MissileCollisionLaunch;
  readonly flight: MissileBallistic;
  readonly path: MissileCollisionPath;
  readonly units: readonly bigint[];
  readonly startedAt: number;
  readonly endsAt: number;
  readonly last: Vec3;
}

/** 0x00700880's pick: the units kept for a flight's path. */
export function missileCollisionUnits(launch: Pick<MissileCollisionLaunch, "exclude" | "row">, path: MissileCollisionPath,
  world: MissileCollisionWorld): bigint[] {
  const candidates: { unit: bigint; key: number }[] = [];
  const sphere: MissileCollisionSphere = { x: 0, y: 0, z: 0, r: 0 };
  for (const unit of world.units()) {
    if (unit.guid === launch.exclude || (unit.root ?? unit.guid) === launch.exclude) continue;
    if (!missileCollisionTargets(launch.row.flags, unit)) continue;
    const body = world.body(unit.guid);
    if (body === undefined) continue;
    const key = missileCollisionReach(path, missileCollisionSphere(body, path, launch.row, sphere), unit.maxSpeed);
    if (key === MISSILE_COLLISION_NONE) continue;
    candidates.push({ unit: unit.guid, key });
    if (candidates.length >= MISSILE_COLLISION_MAX_CANDIDATES) break;
  }
  return missileCollisionKeep(candidates);
}

export interface MissileCollisionTimers {
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: MissileCollisionTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The tracker's step while a flight is tested (Wow.exe tests once a frame). */
export const MISSILE_COLLISION_STEP_MS = 1000 / 60;

/** The own collision missiles in flight, stepped on a timer while there are any. */
export class MissileCollisionTracker {
  readonly #send: (payload: Uint8Array) => void;
  readonly #timers: MissileCollisionTimers;
  readonly #now: () => number;
  readonly #flights: CollisionFlight[] = [];
  #world: MissileCollisionWorld | undefined;
  #timer: unknown;

  constructor(send: (payload: Uint8Array) => void, now: () => number = () => performance.now(),
    timers: MissileCollisionTimers = SYSTEM_TIMERS) {
    this.#send = send;
    this.#now = now;
    this.#timers = timers;
  }

  get size(): number {
    return this.#flights.length;
  }

  /** 0x00700880: the flight starts now; nothing is tracked when it has no units to meet or flies the straight line. */
  launch(launch: MissileCollisionLaunch, world: MissileCollisionWorld): boolean {
    if (!missileCollides(launch.row) || !(launch.delayMs > 0)) return false;
    const flight = solveMissileBallistic(launch.fire, launch.aim, launch.elevation, launch.row.gravity, launch.delayMs);
    if (flight === undefined) return false;
    const path = missileCollisionPath(launch.fire, launch.aim, flight.elevation, flight.speed);
    const units = missileCollisionUnits(launch, path, world);
    if (units.length === 0) return false;
    const now = this.#now();
    this.#flights.push({
      launch, flight, path, units, startedAt: now, endsAt: now + launch.delayMs,
      last: { x: launch.fire.x, y: launch.fire.y, z: launch.fire.z },
    });
    this.#world = world;
    this.#arm();
    return true;
  }

  /** One frame of every flight (0x007015d0): landed ones go, a met unit sends the packet and ends its flight. */
  step(now: number = this.#now()): void {
    const world = this.#world;
    const point = { x: 0, y: 0, z: 0 };
    for (let index = this.#flights.length - 1; index >= 0; index--) {
      const flight = this.#flights[index]!;
      if (world === undefined || now - flight.endsAt >= 0) {
        this.#flights.splice(index, 1);
        continue;
      }
      ballisticPoint(flight.launch.fire, flight.flight, now - flight.startedAt, point);
      const spheres: MissileCollisionSphere[] = [];
      for (const guid of flight.units) {
        const body = world.body(guid);
        if (body !== undefined) spheres.push(missileCollisionSphere(body, flight.path, flight.launch.row));
      }
      const t = missileSegmentHit(flight.last, point, spheres);
      if (t > 0) {
        const last = flight.last;
        const hit = { x: last.x + (point.x - last.x) * t, y: last.y + (point.y - last.y) * t, z: last.z + (point.z - last.z) * t };
        this.#flights.splice(index, 1);
        this.#send(buildUpdateProjectilePosition(flight.launch.caster, flight.launch.spellId, flight.launch.castCount, hit));
        continue;
      }
      flight.last.x = point.x;
      flight.last.y = point.y;
      flight.last.z = point.z;
    }
    if (this.#flights.length === 0) this.#world = undefined;
  }

  /** The session ends: nothing outlives it. */
  dispose(): void {
    this.#flights.length = 0;
    this.#world = undefined;
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  #arm(): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      this.step();
      if (this.#flights.length > 0) this.#arm();
    }, MISSILE_COLLISION_STEP_MS);
  }
}
