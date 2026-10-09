import { setMissileShotSource, type MissileShotSource } from "../../world/MissileCast.js";
import { solveMissileShot, type MissileShot, type MissileSegmentHit, type Vec3 } from "../../world/MissileTrajectory.js";
import type { SpellMissileCatalog } from "../../world/SpellMissileDbc.js";
import type { VehicleCatalog } from "../../world/VehicleDbc.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { spellMissiles } from "../SpellMissileClient.js";
import { vehicleCatalog } from "../VehicleClient.js";
import { game } from "./Context.js";
import { vehicleAimInput, vehicleAimPower } from "./VehicleAim.js";

/**
 * 11.02-E: the page's missile solver for `WorldClient`'s trajectory casts (world/MissileCast.ts) — what
 * Wow.exe's 0x006fcd60 reads, from where this client keeps it:
 *
 * - the spell's SpellMissile row: browser/SpellMissileClient.ts (`/dbc/spell-missiles?v=1`);
 * - the caster's Vehicle row: its kit id (`vehicleId`, CREATE or SMSG_PLAYER_VEHICLE_DATA) in the vehicle
 *   tables (browser/VehicleClient.ts);
 * - the pitch: the movement code's (game/VehicleAim.ts) for the active mover, the last movement packet's
 *   for any other unit; the aim power: game/VehicleAim.ts; the facing: the unit's;
 * - the fire point: the unit's position — what 0x0071a720 falls back to while the model is not loaded.
 *   Not repeated: the model's "$AIM" M2 event (0x006fcd60 asks 0x008275f0 for the event 0x4d494124 in the
 *   model's event list, header +0x100/+0x104, 36-byte entries, and 0x008317e0 places it by its bone), the
 *   "$CSL"/"$CSR"/"$CST" cast events of 0x0071a720 and the SpellVisual missile attachment of 0x00720bf0 —
 *   a siege engine's muzzle stands a few yards above its feet, so a low shot lands nearer than Wow.exe's;
 * - the world's ray test (0x0077f310, mask 0x100111): the collision world's buildings and doodads
 *   (`CollisionWorld.firstHit`) and the terrain heightfield (holes and tiles not loaded are open air).
 */

/** How far apart the heightfield is sampled along one 0.1 s step (a 120 yd/s shell covers 12 yards). */
const TERRAIN_SAMPLE_YARDS = 2;
const TERRAIN_BISECT_STEPS = 12;

function sameMover(guid: bigint): boolean {
  const world = game.world;
  return world !== undefined && guid === (world.controlledGuid ?? world.state.selfGuid);
}

/** The pitch 0x006fcd60 reads for this unit (vfunc +0x14c). */
function unitPitch(guid: bigint, object: WorldObjectState): number {
  const input = vehicleAimInput();
  if (input !== undefined && sameMover(guid)) return input.moverPitch();
  return object.pitch ?? 0;
}

/**
 * The world's answer for one step: the first fraction of `from → to` that meets a building, a doodad or
 * the ground, or undefined. Allocates a probe point per call, called at most 200 times a cast.
 */
export function worldSegmentHit(mapId: number | undefined, from: Readonly<Vec3>, to: Readonly<Vec3>): number | undefined {
  let best = game.collision?.world.firstHit(from, to)?.t;
  const terrain = game.terrain;
  if (terrain === undefined || mapId === undefined) return best;
  const groundAt = (x: number, y: number): number | undefined =>
    terrain.isHole(mapId, x, y) ? undefined : terrain.heightAt(mapId, x, y);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const samples = Math.max(1, Math.ceil(length / TERRAIN_SAMPLE_YARDS));
  let previous = 0;
  for (let index = 1; index <= samples; index++) {
    const t = index / samples;
    if (best !== undefined && t > best) break;
    const z = from.z + (to.z - from.z) * t;
    const ground = groundAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (ground === undefined || z > ground) {
      previous = t;
      continue;
    }
    let low = previous;
    let high = t;
    for (let step = 0; step < TERRAIN_BISECT_STEPS; step++) {
      const mid = (low + high) / 2;
      const probe = groundAt(from.x + (to.x - from.x) * mid, from.y + (to.y - from.y) * mid);
      if (probe === undefined || from.z + (to.z - from.z) * mid > probe) low = mid;
      else high = mid;
    }
    if (best === undefined || high < best) best = high;
    break;
  }
  return best;
}

/** The solver over explicit tables (tests hand their own). */
export function missileShotFor(casterGuid: bigint, spellId: number, missiles: SpellMissileCatalog | undefined,
  vehicles: VehicleCatalog | undefined, hit: MissileSegmentHit, random: () => number = Math.random): MissileShot | undefined {
  const missile = missiles?.trajectoryMissile(spellId);
  const caster = game.world?.state.objects.get(casterGuid);
  const position = caster?.position;
  if (missile === undefined || caster === undefined || position === undefined) return undefined;
  const vehicle = caster.vehicleId ? vehicles?.vehicle(caster.vehicleId) : undefined;
  return solveMissileShot({
    missile, vehicle, moverPitch: unitPitch(casterGuid, caster), power: vehicleAimPower(),
    facing: position.orientation, fire: position,
  }, hit, random);
}

/** The page's source; registered when this module loads (input/Movement.ts imports it). */
export const pageMissileShotSource: MissileShotSource = {
  prime(): void {
    spellMissiles(game.gatewayOrigin, true);
  },
  trajectoryMissile(spellId) {
    return spellMissiles(game.gatewayOrigin)?.trajectoryMissile(spellId);
  },
  shot(casterGuid, spellId) {
    const mapId = game.world?.mapId;
    return missileShotFor(casterGuid, spellId, spellMissiles(game.gatewayOrigin), vehicleCatalog(),
      (from, to) => worldSegmentHit(mapId, from, to));
  },
};

setMissileShotSource(pageMissileShotSource);
