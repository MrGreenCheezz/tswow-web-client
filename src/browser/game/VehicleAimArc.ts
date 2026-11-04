import { missileAim, missileLaunch, flyMissile, type MissileSegmentHit, type Vec3 } from "../../world/MissileTrajectory.js";
import { unitVehicleSeat } from "../../world/VehicleSeatModel.js";
import type { SpellMissileEntry } from "../../world/SpellMissileDbc.js";
import type { VehicleEntry } from "../../world/VehicleDbc.js";
import { spellMissiles } from "../SpellMissileClient.js";
import { vehicleCatalog } from "../VehicleClient.js";
import { game } from "./Context.js";
import { muzzleOf, worldSegmentHit } from "./MissileShot.js";
import { vehicleAimInput, vehicleAimPower } from "./VehicleAim.js";

/**
 * 11.02 (04.11): the arc a steered siege engine shows from its muzzle to where the shot would land, and the mark on the ground
 * there — Wow.exe 3.3.5a's UnitMissileTrajectory_C 0x006fda20 (called each frame from 0x0079ac1c, read from the disassembly;
 * .runtime/re-2026-11-04). 53 of the dataset's 412 Vehicle rows ask for it. Which one is on show:
 *
 * - Vehicle Flags 0x800000: always. 0x1000000: while the seat has 0x300 and not 0x2000001 (0x005f9830). 0x2000000: for a seat
 *   with 0xc00, or while the pitch has just changed (0x006fbf80 from 0x005fb3a0). 0x4000000: for a seat with 0x2000001 and a unit
 *   that may turn (0x005fa110, left out here: its virtual call). 0x8000000: while a spell with a missile is being cast or armed.
 * - Each but the first and last lingers once its cause has gone: full for MsslTrgtTurn/Pitch/MouseLingering less the fade,
 *   the fade being half of it and at most 1 s, then down to nothing.
 * - The spell: the unit's cast or the armed spell when it has a missile, then the last shown, then the first of the ten bar
 *   slots holding a spell (types 1 and 8 to 17) with one.
 *
 * The flight is 0x006fcd60's with no random (`random` undefined, the middles of the pairs). Left out: MsslTrgtImpactModel
 * (Interface\Vehicles\Vehicle_Target_0x.mdx, the 3D mark over the ground one) and the facing and power of a mover the keys do
 * not move.
 */

/** Vehicle Flags that ask for the arc (0x006fda20). */
export const ARC_ALWAYS = 0x0080_0000;
export const ARC_TURN = 0x0100_0000;
export const ARC_PITCH = 0x0200_0000;
export const ARC_MOUSE = 0x0400_0000;
export const ARC_SPELL = 0x0800_0000;
const ARC_ANY = ARC_ALWAYS | ARC_TURN | ARC_PITCH | ARC_MOUSE | ARC_SPELL;

const SEAT_ARC_TURN = 0x300;
const SEAT_ARC_TURN_NOT = 0x200_0001;
const SEAT_ARC_PITCH = 0xc00;
const SEAT_ARC_MOUSE = 0x200_0001;

/** What the arc lingers on (0x00ca0ac4): nothing, or the column it counts from. */
export const enum ArcCause { None = 0, Turn = 1, Pitch = 2, Mouse = 3 }

/** Why the arc is up this frame: `shown` at full, or the cause to linger on afterwards. */
export function vehicleArcCause(vehicleFlags: number, seatFlags: number, pitchChanged: boolean, spellArmed: boolean):
  { readonly shown: boolean; readonly cause: ArcCause } {
  if ((vehicleFlags & ARC_ALWAYS) !== 0) return { shown: true, cause: ArcCause.None };
  if ((vehicleFlags & ARC_TURN) !== 0 && (seatFlags & SEAT_ARC_TURN) !== 0 && (seatFlags & SEAT_ARC_TURN_NOT) === 0) {
    return { shown: true, cause: ArcCause.Turn };
  }
  if ((vehicleFlags & ARC_PITCH) !== 0 && (pitchChanged || (seatFlags & SEAT_ARC_PITCH) !== 0)) return { shown: true, cause: ArcCause.Pitch };
  if ((vehicleFlags & ARC_MOUSE) !== 0 && (seatFlags & SEAT_ARC_MOUSE) !== 0) return { shown: true, cause: ArcCause.Mouse };
  if ((vehicleFlags & ARC_SPELL) !== 0 && spellArmed) return { shown: true, cause: ArcCause.None };
  return { shown: false, cause: ArcCause.None };
}

/** The most a lingering arc takes to fade (0x009e2ebc). */
const ARC_FADE_SECONDS = 1;

/** The arc's strength over time (0x00ca0ab8): full while up, then the lingering of what put it up. */
export class VehicleArcOpacity {
  #cause = ArcCause.None;
  #since = 0;

  /** Strength 0…1 this frame. `now` in ms. */
  step(now: number, shown: boolean, cause: ArcCause, lingering: (cause: ArcCause) => number): number {
    if (shown) {
      this.#cause = cause;
      this.#since = 0;
      return 1;
    }
    if (this.#cause === ArcCause.None) return 0;
    if (this.#since === 0) this.#since = now;
    const seconds = lingering(this.#cause);
    const fade = Math.min(seconds * 0.5, ARC_FADE_SECONDS);
    const past = now - (this.#since + (seconds - fade) * 1000);
    if (past < 0) return 1;
    const left = fade <= 0 ? 0 : 1 - past / (fade * 1000);
    if (left <= 0) {
      this.#cause = ArcCause.None;
      this.#since = 0;
      return 0;
    }
    return left;
  }
}

/** A bar slot's word as PetSpells holds it: the spell or the command, under its type (0x005a79a0). */
export function barSlotSpell(packed: number): number | undefined {
  const type = (packed >>> 24) & 0x3f;
  return type === 1 || (type > 7 && type < 0x12) ? packed & 0xffffff : undefined;
}

/** Which spell's flight the arc shows (0x006fda20). */
export function vehicleArcSpell(casting: number | undefined, armed: number | undefined, last: number | undefined,
  bar: readonly { readonly packed: number }[] | undefined, missile: (spellId: number) => SpellMissileEntry | undefined):
  { readonly spellId: number; readonly armed: boolean } | undefined {
  const current = casting || armed;
  if (current && missile(current) !== undefined) return { spellId: current, armed: true };
  if (last !== undefined && missile(last) !== undefined) return { spellId: last, armed: false };
  for (const slot of bar ?? []) {
    const spell = barSlotSpell(slot.packed);
    if (spell !== undefined && missile(spell) !== undefined) return { spellId: spell, armed: false };
  }
  return undefined;
}

/** What the renderer draws: the flight's points from the fire point on, world coordinates, and the look of the row. */
export interface VehicleAimArcShape {
  /** x, y, z of each point, the first being the fire point and the last the impact. */
  readonly points: Float32Array;
  readonly facing: number;
  readonly opacity: number;
  readonly width: number;
  readonly endOpacity: number;
  readonly arcSpeed: number;
  readonly arcRepeat: number;
  readonly arcTexture: string;
  readonly impactTexture: string;
  readonly impactRadius: number;
}

/** The flight as points (0x006fcd60 with the points asked for): no random, so one frame's arc matches the next. */
export function vehicleArcPoints(missile: SpellMissileEntry, vehicle: VehicleEntry, pitch: number, power: number, facing: number,
  fire: Readonly<Vec3>, hit: MissileSegmentHit): Float32Array {
  const aim = missileAim(missile, vehicle, pitch, power);
  const launch = missileLaunch(missile, aim, facing, fire);
  const points: number[] = [fire.x, fire.y, fire.z];
  flyMissile(launch, missile.gravity, missile.maxDuration, hit, points);
  return Float32Array.from(points);
}

const opacity = new VehicleArcOpacity();
let lastSpell: number | undefined;
let lastPitch: number | undefined;
let lastKey = "";
let lastPoints: Float32Array | undefined;
let showing = false;

let muzzleUnit: bigint | undefined;

function clear(): void {
  lastPoints = undefined;
  lastKey = "";
  if (showing) game.renderer?.setVehicleAimArc(undefined);
  showing = false;
}

/** The renderer places the muzzle of the unit the keys move, for the arc and the cast alike (game/MissileShot.ts). */
function askMuzzle(guid: bigint | undefined): void {
  if (guid === muzzleUnit) return;
  muzzleUnit = guid;
  game.renderer?.setMuzzleUnit(guid);
}

/** One frame (game/Loop.ts). Cheap for everyone not steering a unit with such a row. */
export function updateVehicleAimArc(armedSpell: number | undefined): void {
  const world = game.world;
  const moverGuid = world?.controlledGuid;
  const catalog = vehicleCatalog();
  const mover = moverGuid === undefined ? undefined : world?.state.objects.get(moverGuid);
  const vehicle = mover?.vehicleId && catalog ? catalog.vehicle(mover.vehicleId) : undefined;
  const selfGuid = world?.state.selfGuid;
  askMuzzle(vehicle === undefined ? undefined : moverGuid);
  if (world === undefined || moverGuid === undefined || mover?.position === undefined || vehicle === undefined
    || catalog === undefined || selfGuid === undefined || (vehicle.flags & ARC_ANY) === 0) {
    clear();
    return;
  }
  const missiles = spellMissiles(game.gatewayOrigin, true);
  const missile = (spellId: number): SpellMissileEntry | undefined => missiles?.trajectoryMissile(spellId);
  const spell = vehicleArcSpell(world.casts.get(moverGuid)?.spellId, armedSpell, lastSpell, world.petSpells?.bar, missile);
  const entry = spell === undefined ? undefined : missile(spell.spellId);
  if (spell === undefined || entry === undefined) {
    clear();
    return;
  }
  lastSpell = spell.spellId;
  const input = vehicleAimInput();
  const pitch = input?.moverPitch() ?? mover.pitch ?? 0;
  const pitchChanged = lastPitch !== undefined && lastPitch !== pitch;
  lastPitch = pitch;
  const seat = unitVehicleSeat(catalog, world.state.objects, selfGuid);
  const { shown, cause } = vehicleArcCause(vehicle.flags, seat?.seat.flags ?? 0, pitchChanged, spell.armed);
  const strength = opacity.step(performance.now(), shown, cause, (which) => which === ArcCause.Turn ? vehicle.msslTrgtTurnLingering
    : which === ArcCause.Pitch ? vehicle.msslTrgtPitchLingering : vehicle.msslTrgtMouseLingering);
  if (strength <= 0) {
    clear();
    return;
  }
  const position = mover.position;
  const power = vehicleAimPower();
  const fire = muzzleOf(moverGuid) ?? position;
  const key = `${spell.spellId}|${fire.x}|${fire.y}|${fire.z}|${position.orientation}|${pitch}|${power}`;
  if (key !== lastKey || lastPoints === undefined) {
    const mapId = world.mapId;
    lastPoints = vehicleArcPoints(entry, vehicle, pitch, power, position.orientation, fire,
      (from, to) => worldSegmentHit(mapId, from, to));
    lastKey = key;
  }
  showing = true;
  game.renderer?.setVehicleAimArc({
    points: lastPoints, facing: position.orientation, opacity: strength,
    width: vehicle.msslTrgtArcWidth, endOpacity: vehicle.msslTrgtEndOpacity,
    arcSpeed: vehicle.msslTrgtArcSpeed, arcRepeat: vehicle.msslTrgtArcRepeat,
    arcTexture: vehicle.msslTrgtArcTexture.trim(), impactTexture: vehicle.msslTrgtImpactTexture.trim(),
    impactRadius: vehicle.msslTrgtImpactTexRadius,
  });
}
