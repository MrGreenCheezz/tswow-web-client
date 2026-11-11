import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { worldObject } from "./Fields.js";
import type { MissileCollisionBody, MissileCollisionCandidate, MissileCollisionLaunch, MissileCollisionModel,
  MissileCollisionWorld } from "./MissileCollision.js";
import { missileCollides } from "./MissileCollision.js";
import type { SpellGo } from "./SpellProtocol.js";
import type { SpellMissileEntry } from "./SpellMissileDbc.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * 11.02 (11.11): what MissileCollision.ts reads of this client's world, from where WorldClient keeps it, and the
 * launcher's test (0x00732ff0 at 0x0073375c) of which missiles are this client's to test.
 */

/** The page's half: a unit's model as the renderer knows it (CreatureModelData of its display, its drawn scale). */
export interface MissileCollisionModelSource {
  collisionModel(guid: bigint): { readonly scale: number; readonly model: MissileCollisionModel | undefined } | undefined;
}

/** WorldClient's half. */
export interface MissileCollisionFacts {
  readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  /** The cached creature template's type_flags of an entry, undefined while not cached. */
  creatureTypeFlags(entry: number): number | undefined;
  /** CanAttack (0x00729740) from the active player; undefined without one. */
  canAttack(object: WorldObjectState): boolean | undefined;
}

const TYPE_UNIT = 3;
const TYPE_PLAYER = 4;
/** The create block's defaults (Unit.cpp baseMoveSpeed): run 7, swim 4.722222, flight 7. */
const DEFAULT_RUN = 7;
const DEFAULT_SWIM = 4.722222;
const DEFAULT_FLIGHT = 7;

function isUnitType(object: WorldObjectState): boolean {
  return object.typeId === TYPE_UNIT || object.typeId === TYPE_PLAYER;
}

/** The mover's run, swim and flight speeds, the largest (0x006fc4a0: +0x94, +0x9c, +0xa4). */
export function missileCollisionMaxSpeed(object: WorldObjectState): number {
  const speeds = object.speeds;
  const run = speeds?.get("run") ?? object.runSpeed ?? DEFAULT_RUN;
  const swim = speeds?.get("swim") ?? DEFAULT_SWIM;
  const flight = speeds?.get("flight") ?? DEFAULT_FLIGHT;
  return Math.max(run, swim, flight);
}

/** The vehicle a unit rides: its transport when that is a unit (0x00748040 answers only for a vehicle passenger). */
function riddenVehicle(objects: ReadonlyMap<bigint, WorldObjectState>, object: WorldObjectState): bigint | undefined {
  const carrier = object.transport === undefined ? undefined : objects.get(object.transport.guid);
  return carrier !== undefined && isUnitType(carrier) ? carrier.guid : undefined;
}

/** The world as the tracker reads it. */
export function missileCollisionWorld(facts: MissileCollisionFacts, models: MissileCollisionModelSource): MissileCollisionWorld {
  return {
    *units(): Iterable<MissileCollisionCandidate> {
      for (const object of facts.objects.values()) {
        if (!isUnitType(object) || object.position === undefined) continue;
        const isPlayer = object.typeId === TYPE_PLAYER;
        yield {
          guid: object.guid,
          isPlayer,
          creatureTypeFlags: isPlayer ? undefined : facts.creatureTypeFlags(worldObject.entry(object) ?? 0),
          canAttack: facts.canAttack(object),
          root: riddenVehicle(facts.objects, object),
          maxSpeed: missileCollisionMaxSpeed(object),
        };
      }
    },
    body(guid: bigint): MissileCollisionBody | undefined {
      const position = facts.objects.get(guid)?.position;
      if (position === undefined) return undefined;
      const known = models.collisionModel(guid);
      return { position, scale: known?.scale ?? 1, model: known?.model };
    },
  };
}

/**
 * 0x00732ff0 at 0x0073375c: the missile is this client's to test (+0x68 0x200000) — the caster is the active player
 * with no CHARMEDBY, or the unit SMSG_CLIENT_CONTROL_UPDATE gave this client (+0xa30 0x400, 0x0071c930).
 */
export function ownsMissileCollision(caster: bigint, selfGuid: bigint | undefined, controlledGuid: bigint | undefined,
  objects: ReadonlyMap<bigint, WorldObjectState>): boolean {
  if (controlledGuid !== undefined && caster === controlledGuid) return true;
  if (selfGuid === undefined || caster !== selfGuid) return false;
  const self = objects.get(selfGuid);
  const charmedBy = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
  return (self?.fields.get(charmedBy) ?? 0) === 0 && (self?.fields.get(charmedBy + 1) ?? 0) === 0;
}

/**
 * The launch of a SMSG_SPELL_GO's trajectory missile (CAST_FLAG_ADJUST_MISSILE, the source and destination of its
 * targets) when its SpellMissile row collides; undefined otherwise. The excluded root is the caster's vehicle when it
 * rides one, else the caster (0x00700880: 0x00748040 on its passenger record).
 */
export function missileCollisionLaunch(go: SpellGo, row: SpellMissileEntry | undefined,
  objects: ReadonlyMap<bigint, WorldObjectState>): MissileCollisionLaunch | undefined {
  const adjust = go.adjustMissile;
  const fire = go.targets?.source;
  const aim = go.targets?.destination;
  if (row === undefined || !missileCollides(row) || adjust === undefined || fire === undefined || aim === undefined) return undefined;
  const caster = objects.get(go.casterUnit);
  return {
    caster: go.casterUnit,
    exclude: (caster === undefined ? undefined : riddenVehicle(objects, caster)) ?? go.casterUnit,
    spellId: go.spellId,
    castCount: go.castId,
    row,
    fire,
    aim,
    elevation: adjust.elevation,
    delayMs: adjust.delayMs,
  };
}
