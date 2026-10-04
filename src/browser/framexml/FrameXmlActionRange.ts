import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * `IsActionInRange(slot [, unit])` (plan item 1.14b), as Wow.exe 3.3.5a build 12340 answers it:
 * 0x005a9d50 → 0x005a94c0 → 0x00809610. Nil when the slot holds no spell, the spell row is not known,
 * there is no target, or the target is not one the spell can take (0x00809610 answers false); else 1
 * or 0 by the range check 0x00803850. Read off the local Ghidra project (read-only), in this file's
 * own words:
 *
 * **Target validity (0x00809610).** The client's target mask starts as the low 16 bits of
 * `Spell.Targets` and gains bits from each `ImplicitTargetA` (only A): 1 CASTER clears UNIT_DEAD
 * (0x400); 5 PET means «the pet» and clears CORPSE_ALLY (0x8000); 6/53 add UNIT_ENEMY (0x80); 21/45
 * UNIT_ALLY (0x100); 23 GAMEOBJECT (0x800); 25, 63-71, 74, 75 UNIT (0x2); 26 GAMEOBJECT_ITEM (0x4000);
 * 35 UNIT_PARTY (0x8); 57/61 UNIT_RAID (0x4). A PET spell without UNIT is aimed at the player's pet
 * (with UNIT added). Then, by the target's type:
 * - a game object: valid when the mask holds GAMEOBJECT or GAMEOBJECT_ITEM;
 * - a unit: SPELL_ATTR5 0x800 (target of target, 0x007ffc40) may swap in the target's target; a
 *   UNIT_FLAG_NON_ATTACKABLE_2 unit needs SPELL_ATTR6 0x1000000; `TargetCreatureType` must hold the
 *   unit's creature type (0x0071f300); a dead unit (health < 1) needs UNIT_DYNFLAG_DEAD, a corpse or
 *   UNIT_DEAD bit in the mask, or SPELL_ATTR2 0x1; a living one must not have UNIT_DEAD in the mask;
 *   then any of: PARTY and in the party and assistable, RAID and in the raid and assistable, ALLY and
 *   assistable (SPELL_ATTR6 0x8 ignores the immunity flags), ENEMY and attackable, UNIT and not
 *   IMMUNE_TO_PC; else a dead player (or pet) with CORPSE_ALLY that can be assisted, or with
 *   CORPSE_ENEMY that cannot;
 * - anything else (items, and corpse objects, which this client does not model here): not valid.
 *
 * **Range (0x00802c30 → 0x00801650 → 0x007ff480).** Slot 1 (friendly) of the SpellRange row when the
 * caster can assist a unit target (0x007293d0), slot 0 when not; without a unit target, slot 1 when
 * 0x007fe1b0 calls the spell helpful. SPELL_ATTR0 ON_NEXT_SWING (0x404): 0..100 yards. Melee flag (1):
 * 0 .. max(5, reach + reach + 4/3). Ranged flag (2): min max(5, reach + reach + 4/3) + RangeMin, max
 * RangeMax + both reaches. Otherwise RangeMin/RangeMax, both reaches added to the max for a unit (and
 * to a non-zero min). 8/3 more when caster and a unit target both move, neither walks, and the row is
 * melee or the target is a player. SPELL_ATTR0 0x2 on a player: max × RangedModRange% of the ranged
 * weapon. SPELLMOD_RANGE (op 5, 0x007fd970) for the player's spell family, unless SPELL_ATTR3
 * 0x20000000: max = (max + flat) × (100 + pct)%. Then 0x00803850 compares 3D squared distances: in
 * range when min² ≤ d² ≤ max².
 *
 * Kept cheap because stock `ActionButton_OnUpdate` asks for every button every 0.2 s: no allocation
 * on the path beyond the guids the world map is keyed by.
 */

/** The spell row columns the check reads (`/dbc/spells?v=14`). */
export interface ActionRangeSpell {
  readonly targets?: number | undefined;
  readonly implicitTargetA?: readonly number[] | undefined;
  readonly implicitTargetB?: readonly number[] | undefined;
  readonly targetCreatureType?: number | undefined;
  readonly attributes?: readonly number[] | undefined;
  readonly effectAura?: readonly number[] | undefined;
  readonly rangeMin: number;
  readonly rangeMax: number;
  readonly rangeMinFriendly?: number | undefined;
  readonly rangeMaxFriendly?: number | undefined;
  readonly rangeFlags: number;
  readonly spellClassSet: number;
  readonly spellClassMask: readonly number[];
}

/** One SPELLMOD entry as `WorldClient.spellModifiers` keeps it (`effectIndex` is the family-mask bit). */
export interface ActionRangeModifier {
  readonly effectIndex: number;
  readonly op: number;
  readonly value: number;
  readonly pct: boolean;
}

/** What the world answers; `LiveWorldSeam` implements it over `WorldClient`. */
export interface ActionRangeHost {
  object(guid: bigint): WorldObjectState | undefined;
  /** REACTION_HOSTILE / _NEUTRAL / _FRIENDLY, or undefined when the faction tables are not there. */
  reaction(left: WorldObjectState, right: WorldObjectState): number | undefined;
  /** The creature template's type and type_flags; 0 for a player or an unknown template. */
  creatureType(unit: WorldObjectState): number;
  creatureTypeFlags(unit: WorldObjectState): number;
  /** The player's own guid, and whether a guid is in the player's party (same subgroup) / raid. */
  readonly selfGuid: bigint | undefined;
  inParty(guid: bigint): boolean;
  inRaid(guid: bigint): boolean;
  /** RangedModRange of the player's ranged-slot item, or undefined without one. */
  rangedModRange(): number | undefined;
  /** ChrClasses.SpellClassSet of the player's class; undefined when not known. */
  playerSpellFamily(): number | undefined;
  /** The player's SPELLMOD entries. */
  spellModifiers(): Iterable<ActionRangeModifier>;
}

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
const TYPEID_GAMEOBJECT = 5;

// TARGET_FLAG_* (SharedDefines.h SpellCastTargetFlags).
const TF_UNIT = 0x2;
const TF_UNIT_RAID = 0x4;
const TF_UNIT_PARTY = 0x8;
const TF_UNIT_ENEMY = 0x80;
const TF_UNIT_ALLY = 0x100;
const TF_CORPSE_ENEMY = 0x200;
const TF_UNIT_DEAD = 0x400;
const TF_GAMEOBJECT = 0x800;
const TF_GAMEOBJECT_ITEM = 0x4000;
const TF_CORPSE_ALLY = 0x8000;

// UnitFlags (UnitDefines.h).
const UF_NON_ATTACKABLE = 0x2;
const UF_PLAYER_CONTROLLED = 0x8;
const UF_NOT_ATTACKABLE_1 = 0x80;
const UF_IMMUNE_TO_PC = 0x100;
const UF_IMMUNE_TO_NPC = 0x200;
const UF_NON_ATTACKABLE_2 = 0x10000;
const UF_TAXI_FLIGHT = 0x100000;
const UF_UNINTERACTIBLE = 0x2000000;
const UNIT_DYNFLAG_DEAD = 0x20;
// UNIT_FIELD_BYTES_2 byte 1 (UnitPVPStateFlags).
const PVP_FLAG_PVP = 0x1;
const PVP_FLAG_UNK1 = 0x2;
const PVP_FLAG_FFA = 0x4;
const PVP_FLAG_SANCTUARY = 0x8;
const PLAYER_FLAGS_GHOST = 0x10;
// CREATURE_TYPE_FLAG_CAN_ASSIST / TREAT_AS_RAID_UNIT (read at +0xc of the creature cache, bits 12, 26).
const CREATURE_TYPE_FLAG_CAN_ASSIST = 0x1000;
const CREATURE_TYPE_FLAG_TREAT_AS_RAID_UNIT = 0x4000000;
// MovementFlags: FORWARD | STRAFE_LEFT | STRAFE_RIGHT | FALLING (the client's 0x100d), and WALKING.
const MOVING_MASK = 0x100d;
const MOVEMENTFLAG_WALKING = 0x100;

const SPELL_RANGE_MELEE = 1;
const SPELL_RANGE_RANGED = 2;
const ATTR0_RANGED = 0x2;
const ATTR0_ON_NEXT_SWING_ANY = 0x404;
const ATTR2_CAN_TARGET_DEAD = 0x1;
const ATTR3_NO_CASTER_MODIFIERS = 0x20000000;
const ATTR5_TARGET_OF_TARGET = 0x800;
const ATTR6_ASSIST_IGNORE_IMMUNE = 0x8;
const ATTR6_CAN_TARGET_UNTARGETABLE = 0x1000000;
const SPELLMOD_RANGE = 5;
/** `SPELL_AURA_DUMMY`: an A = CASTER effect with it does not make the spell helpful (0x007fe1b0). */
const SPELL_AURA_DUMMY = 4;

const NOMINAL_MELEE_RANGE = 5;
const MELEE_REACH_BONUS = 4 / 3;
const MOVING_LEEWAY = 8 / 3;
const NEXT_SWING_RANGE = 100;

const F_FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const F_DYNAMIC = UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset;
const F_HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const F_BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
const F_COMBAT_REACH = UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset;
const F_TARGET = UPDATE_FIELDS.UNIT_FIELD_TARGET.offset;
const F_CHARMED_BY = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
const F_CREATED_BY = UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset;
const F_SUMMON = UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset;
const F_PET_NUMBER = UPDATE_FIELDS.UNIT_FIELD_PETNUMBER.offset;
const F_PLAYER_FLAGS = UPDATE_FIELDS.PLAYER_FLAGS.offset;
const F_DUEL_ARBITER = UPDATE_FIELDS.PLAYER_DUEL_ARBITER.offset;
const F_DUEL_TEAM = UPDATE_FIELDS.PLAYER_DUEL_TEAM.offset;

const floatView = new DataView(new ArrayBuffer(4));

function word(object: WorldObjectState, index: number): number {
  return object.fields.get(index) ?? 0;
}

function float(object: WorldObjectState, index: number): number {
  const raw = object.fields.get(index);
  if (raw === undefined) return 0;
  floatView.setUint32(0, raw, true);
  return floatView.getFloat32(0, true);
}

function guidAt(object: WorldObjectState, index: number): bigint | undefined {
  const low = object.fields.get(index) ?? 0;
  const high = object.fields.get(index + 1) ?? 0;
  if (low === 0 && high === 0) return undefined;
  return (BigInt(high) << 32n) | BigInt(low >>> 0);
}

function isUnit(object: WorldObjectState): boolean {
  return object.typeId === TYPEID_UNIT || object.typeId === TYPEID_PLAYER;
}

function playerControlled(unit: WorldObjectState): boolean {
  return (word(unit, F_FLAGS) & UF_PLAYER_CONTROLLED) !== 0;
}

function pvpByte(unit: WorldObjectState): number {
  return (word(unit, F_BYTES_2) >>> 8) & 0xff;
}

function reach(unit: WorldObjectState): number {
  return float(unit, F_COMBAT_REACH);
}

/**
 * The player behind a unit (0x00718b70): its charmer or creator when it has one, else itself — if
 * that is a player; a charmed unit's creator's player one step further.
 */
function ownerPlayer(unit: WorldObjectState, host: ActionRangeHost): WorldObjectState | undefined {
  let current: WorldObjectState | undefined = unit;
  const master = guidAt(unit, F_CHARMED_BY) ?? guidAt(unit, F_CREATED_BY);
  if (master !== undefined) current = host.object(master);
  if (!current) return undefined;
  if (current.typeId === TYPEID_PLAYER) return current;
  const next = guidAt(current, F_CHARMED_BY) ?? guidAt(current, F_CREATED_BY);
  const upper = next === undefined ? undefined : host.object(next);
  return upper?.typeId === TYPEID_PLAYER ? upper : undefined;
}

/** Two players dueling each other: the same arbiter, different teams (0x007251c0). */
function dueling(left: WorldObjectState, right: WorldObjectState): boolean {
  const low = word(left, F_DUEL_ARBITER);
  const high = word(left, F_DUEL_ARBITER + 1);
  if (low === 0 && high === 0) return false;
  return low === word(right, F_DUEL_ARBITER) && high === word(right, F_DUEL_ARBITER + 1)
    && word(left, F_DUEL_TEAM) !== word(right, F_DUEL_TEAM);
}

/** The reaction in the client's 0..7 sense, collapsed to hostile < 2, neutral 3, friendly ≥ 4. */
function friendlyReaction(caster: WorldObjectState, target: WorldObjectState, host: ActionRangeHost): boolean {
  if (caster === target) return true;
  const casterOwner = playerControlled(caster) && playerControlled(target) ? ownerPlayer(caster, host) : undefined;
  const targetOwner = casterOwner ? ownerPlayer(target, host) : undefined;
  if (casterOwner && targetOwner && dueling(casterOwner, targetOwner)) return false;
  return host.reaction(caster, target) === REACTION_FRIENDLY;
}

function hostileReaction(caster: WorldObjectState, target: WorldObjectState, host: ActionRangeHost): boolean {
  if (caster === target) return false;
  const casterOwner = playerControlled(caster) && playerControlled(target) ? ownerPlayer(caster, host) : undefined;
  const targetOwner = casterOwner ? ownerPlayer(target, host) : undefined;
  if (casterOwner && targetOwner && dueling(casterOwner, targetOwner)) return true;
  return host.reaction(caster, target) === REACTION_HOSTILE;
}

/** 0x007293d0: the caster can assist the target (a heal, a buff). */
export function actionRangeCanAssist(
  caster: WorldObjectState, target: WorldObjectState, ignoreImmunity: boolean, host: ActionRangeHost,
): boolean {
  const targetFlags = word(target, F_FLAGS);
  if ((targetFlags & UF_UNINTERACTIBLE) !== 0) return false;
  const casterFlags = word(caster, F_FLAGS);
  if (!ignoreImmunity) {
    if ((casterFlags & UF_PLAYER_CONTROLLED) !== 0 && (targetFlags & UF_IMMUNE_TO_PC) !== 0) return false;
    if ((casterFlags & UF_PLAYER_CONTROLLED) === 0 && (targetFlags & UF_IMMUNE_TO_NPC) !== 0) return false;
  }
  if (!friendlyReaction(caster, target, host)) return false;
  if ((targetFlags & UF_PLAYER_CONTROLLED) === 0) {
    // A player assists a creature that is not PvP-flagged only when its template says so.
    if ((casterFlags & UF_PLAYER_CONTROLLED) !== 0 && !ignoreImmunity && (pvpByte(target) & PVP_FLAG_PVP) === 0) {
      return (host.creatureTypeFlags(target) & (CREATURE_TYPE_FLAG_CAN_ASSIST | CREATURE_TYPE_FLAG_TREAT_AS_RAID_UNIT)) !== 0;
    }
    return true;
  }
  const targetPvp = pvpByte(target);
  const casterPvp = pvpByte(caster);
  if ((targetPvp & PVP_FLAG_FFA) !== 0 && (casterPvp & PVP_FLAG_FFA) === 0) return false;
  if ((casterPvp & PVP_FLAG_SANCTUARY) !== 0 && (targetPvp & PVP_FLAG_SANCTUARY) === 0 && (targetPvp & PVP_FLAG_PVP) !== 0) return false;
  return true;
}

/** 0x00729740: the caster can attack the target. */
export function actionRangeCanAttack(caster: WorldObjectState, target: WorldObjectState, host: ActionRangeHost): boolean {
  if (caster === target) return false;
  if (target.typeId === TYPEID_PLAYER && (word(target, F_PLAYER_FLAGS) & PLAYER_FLAGS_GHOST) !== 0) return false;
  const targetFlags = word(target, F_FLAGS);
  if ((targetFlags & (UF_NON_ATTACKABLE | UF_TAXI_FLIGHT | UF_NOT_ATTACKABLE_1 | UF_NON_ATTACKABLE_2 | UF_UNINTERACTIBLE)) !== 0) return false;
  const casterFlags = word(caster, F_FLAGS);
  const casterPc = (casterFlags & UF_PLAYER_CONTROLLED) !== 0;
  const targetPc = (targetFlags & UF_PLAYER_CONTROLLED) !== 0;
  if (casterPc && (targetFlags & UF_IMMUNE_TO_PC) !== 0) return false;
  if (!casterPc && (targetFlags & UF_IMMUNE_TO_NPC) !== 0) return false;
  if (targetPc && (casterFlags & UF_IMMUNE_TO_PC) !== 0) return false;
  if (!targetPc && (casterFlags & UF_IMMUNE_TO_NPC) !== 0) return false;
  if (!casterPc && !targetPc) return hostileReaction(caster, target, host) || hostileReaction(target, caster, host);
  const casterPvp = pvpByte(caster);
  const targetPvp = pvpByte(target);
  if (casterPc && targetPc) {
    if (friendlyReaction(caster, target, host)) return false;
    const casterOwner = ownerPlayer(caster, host);
    const targetOwner = ownerPlayer(target, host);
    if (!casterOwner || !targetOwner) {
      if ((casterPvp & PVP_FLAG_SANCTUARY) !== 0) return false;
      return (targetPvp & PVP_FLAG_SANCTUARY) === 0;
    }
    if (dueling(casterOwner, targetOwner)) return true;
    if ((targetPvp & PVP_FLAG_PVP) === 0) {
      if ((casterPvp & PVP_FLAG_FFA) !== 0 && (targetPvp & PVP_FLAG_FFA) !== 0) return true;
      if ((casterPvp & PVP_FLAG_UNK1) === 0 && (targetPvp & PVP_FLAG_UNK1) === 0) return false;
    }
    if ((casterPvp & PVP_FLAG_SANCTUARY) !== 0) return false;
    return (targetPvp & PVP_FLAG_SANCTUARY) === 0;
  }
  if (casterPc && (targetPvp & PVP_FLAG_SANCTUARY) !== 0) return false;
  if (targetPc && (casterPvp & PVP_FLAG_SANCTUARY) !== 0) return false;
  return !friendlyReaction(caster, target, host);
}

/** 0x00718ca0 / 0x00718d70: the unit's player is in the caster's party (subgroup) or raid. */
function sameGroup(caster: WorldObjectState, target: WorldObjectState, raid: boolean, host: ActionRangeHost): boolean {
  if (caster === target) return true;
  if (raid && (host.creatureTypeFlags(target) & CREATURE_TYPE_FLAG_TREAT_AS_RAID_UNIT) !== 0) return true;
  if (!playerControlled(caster) || !playerControlled(target)) return false;
  const casterOwner = ownerPlayer(caster, host);
  const targetOwner = ownerPlayer(target, host);
  if (!casterOwner || !targetOwner) return false;
  // Either player in the local party/raid (0x005129f0 / 0x00512a00 ask about one guid each).
  return raid ? host.inRaid(targetOwner.guid) || host.inRaid(casterOwner.guid)
    : host.inParty(targetOwner.guid) || host.inParty(casterOwner.guid);
}

/** The implicit-target half of 0x00809610's mask; bit 16 set marks a PET implicit target. */
const PET_TARGET = 0x10000;
export function actionRangeTargetMask(spell: ActionRangeSpell): number {
  let mask = (spell.targets ?? 0) & 0xffff;
  const implicit = spell.implicitTargetA;
  if (!implicit) return mask;
  for (let index = 0; index < 3; index++) {
    switch (implicit[index] ?? 0) {
      case 1: mask &= ~TF_UNIT_DEAD; break;
      case 5: mask = (mask & ~TF_CORPSE_ALLY) | PET_TARGET; break;
      case 6: case 53: mask |= TF_UNIT_ENEMY; break;
      case 21: case 45: mask |= TF_UNIT_ALLY; break;
      case 23: mask |= TF_GAMEOBJECT; break;
      case 25: case 63: case 64: case 65: case 66: case 67: case 68: case 69: case 70: case 71: case 74: case 75:
        mask |= TF_UNIT; break;
      case 26: mask |= TF_GAMEOBJECT_ITEM; break;
      case 35: mask |= TF_UNIT_PARTY; break;
      case 57: case 61: mask |= TF_UNIT_RAID; break;
    }
  }
  return mask;
}

/** 0x007fe1b0: 1 helpful, 2 harmful, 0 neither — which SpellRange slot a spell without a unit target reads. */
export function actionRangeSpellKind(spell: ActionRangeSpell): number {
  const targets = spell.targets ?? 0;
  if ((targets & TF_UNIT_ALLY) !== 0) return 1;
  if ((targets & TF_UNIT_ENEMY) !== 0) return 2;
  const a = spell.implicitTargetA;
  const b = spell.implicitTargetB;
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index++) {
    if (harmfulImplicit(a[index] ?? 0) || harmfulImplicit(b[index] ?? 0)) return 2;
  }
  for (let index = 0; index < 3; index++) {
    const aura = spell.effectAura?.[index] ?? 0;
    if (helpfulImplicit(a[index] ?? 0, aura) || helpfulImplicit(b[index] ?? 0, aura)) return 1;
  }
  return 0;
}

function harmfulImplicit(target: number): boolean {
  switch (target) {
    case 2: case 6: case 15: case 16: case 24: case 28: case 53: case 54: case 93: return true;
    default: return false;
  }
}

function helpfulImplicit(target: number, aura: number): boolean {
  switch (target) {
    case 1: return aura !== SPELL_AURA_DUMMY;
    case 3: case 4: case 5: case 20: case 21: case 27: case 29: case 30: case 31: case 33: case 34: case 35:
    case 45: case 56: case 57: case 58: case 59: case 61: case 62: return true;
    default: return false;
  }
}

/**
 * The target the spell takes, or undefined when 0x00809610 refuses it. `target` is the unit the
 * question names (the current target by default); a PET spell looks at the pet instead.
 */
export function actionRangeTarget(
  spell: ActionRangeSpell, caster: WorldObjectState, target: WorldObjectState | undefined, host: ActionRangeHost,
): WorldObjectState | undefined {
  let mask = actionRangeTargetMask(spell);
  if ((mask & PET_TARGET) !== 0 && (mask & TF_UNIT) === 0) {
    const pet = guidAt(caster, F_SUMMON);
    target = pet === undefined ? undefined : host.object(pet);
    mask |= TF_UNIT;
  }
  if (!target) return undefined;
  if (target.typeId === TYPEID_GAMEOBJECT) return (mask & (TF_GAMEOBJECT | TF_GAMEOBJECT_ITEM)) !== 0 ? target : undefined;
  if (!isUnit(target)) return undefined;
  const attributes = spell.attributes;
  const attr2 = attributes?.[2] ?? 0;
  const attr5 = attributes?.[5] ?? 0;
  const attr6 = attributes?.[6] ?? 0;
  if ((attr5 & ATTR5_TARGET_OF_TARGET) !== 0) {
    const swapped = targetOfTarget(mask, caster, target, (attr6 & ATTR6_ASSIST_IGNORE_IMMUNE) !== 0, host);
    if (!swapped) return undefined;
    target = swapped;
  }
  const flags = word(target, F_FLAGS);
  if ((flags & UF_NON_ATTACKABLE_2) !== 0 && (attr6 & ATTR6_CAN_TARGET_UNTARGETABLE) === 0) return undefined;
  const creatureMask = spell.targetCreatureType ?? 0;
  if (creatureMask !== 0) {
    const type = host.creatureType(target);
    if (type === 0 || (creatureMask & (1 << ((type - 1) & 31))) === 0) return undefined;
  }
  const alive = (word(target, F_HEALTH) | 0) > 0;
  if (!alive) {
    if ((word(target, F_DYNAMIC) & UNIT_DYNFLAG_DEAD) === 0 && (mask & (TF_CORPSE_ALLY | TF_UNIT_DEAD | TF_CORPSE_ENEMY)) === 0
      && (attr2 & ATTR2_CAN_TARGET_DEAD) === 0) return undefined;
  } else if ((mask & TF_UNIT_DEAD) !== 0) {
    return undefined;
  }
  if (((mask & TF_UNIT_PARTY) !== 0 && sameGroup(caster, target, false, host) && actionRangeCanAssist(caster, target, false, host))
    || ((mask & TF_UNIT_RAID) !== 0 && sameGroup(caster, target, true, host) && actionRangeCanAssist(caster, target, false, host))
    || ((mask & TF_UNIT_ALLY) !== 0 && actionRangeCanAssist(caster, target, (attr6 & ATTR6_ASSIST_IGNORE_IMMUNE) !== 0, host))
    || ((mask & TF_UNIT_ENEMY) !== 0 && actionRangeCanAttack(caster, target, host))
    || ((mask & TF_UNIT) !== 0 && (flags & UF_IMMUNE_TO_PC) === 0)) {
    return target;
  }
  const player = target.typeId === TYPEID_PLAYER;
  if ((mask & TF_CORPSE_ALLY) === 0 || alive || (!player && word(target, F_PET_NUMBER) === 0)) {
    if ((mask & TF_CORPSE_ENEMY) === 0 || alive || !player) return undefined;
    return actionRangeCanAssist(caster, target, false, host) ? undefined : target;
  }
  return actionRangeCanAssist(caster, target, false, host) ? target : undefined;
}

/** 0x007ffc40: SPELL_ATTR5 0x800 — the target's target when the target itself does not fit. */
function targetOfTarget(
  mask: number, caster: WorldObjectState, target: WorldObjectState, ignoreImmunity: boolean, host: ActionRangeHost,
): WorldObjectState | undefined {
  const next = (): WorldObjectState | undefined => {
    const guid = guidAt(target, F_TARGET);
    const object = guid === undefined ? undefined : host.object(guid);
    return object && isUnit(object) ? object : undefined;
  };
  if ((mask & (TF_UNIT_RAID | TF_UNIT_PARTY | TF_UNIT_ALLY)) !== 0) {
    if (!actionRangeCanAttack(caster, target, host)) return target;
    const swapped = next();
    if (!swapped || !actionRangeCanAssist(caster, swapped, ignoreImmunity, host)) return undefined;
    if ((mask & TF_UNIT_PARTY) !== 0 && sameGroup(caster, swapped, false, host)) return swapped;
    if ((mask & TF_UNIT_RAID) !== 0 && sameGroup(caster, swapped, true, host)) return swapped;
    return (mask & TF_UNIT_ALLY) !== 0 ? swapped : undefined;
  }
  if ((mask & TF_UNIT_ENEMY) !== 0 && actionRangeCanAssist(caster, target, ignoreImmunity, host)) {
    const swapped = next();
    return swapped && actionRangeCanAttack(caster, swapped, host) ? swapped : undefined;
  }
  return target;
}

/** Scratch for {@link actionRangeLimits}: no allocation per question. */
const limits = { min: 0, max: 0 };

function moving(unit: WorldObjectState): boolean {
  return (unit.movementFlags & MOVING_MASK) !== 0 && (unit.movementFlags & MOVEMENTFLAG_WALKING) === 0;
}

/** 0x00801650 → 0x007ff480: the min and max yards for this caster, spell and (valid) target. */
export function actionRangeLimits(
  spell: ActionRangeSpell, caster: WorldObjectState, target: WorldObjectState, host: ActionRangeHost,
): { readonly min: number; readonly max: number } {
  const unitTarget = isUnit(target) ? target : undefined;
  const friendly = unitTarget ? actionRangeCanAssist(caster, unitTarget, false, host) : actionRangeSpellKind(spell) === 1;
  const attr0 = spell.attributes?.[0] ?? 0;
  limits.min = 0;
  if ((attr0 & ATTR0_ON_NEXT_SWING_ANY) !== 0) {
    limits.max = NEXT_SWING_RANGE;
    return limits;
  }
  const rangeMin = friendly ? spell.rangeMinFriendly ?? spell.rangeMin : spell.rangeMin;
  const rangeMax = friendly ? spell.rangeMaxFriendly ?? spell.rangeMax : spell.rangeMax;
  const casterReach = reach(caster);
  let max = 0;
  let bonus = 0;
  if ((spell.rangeFlags & SPELL_RANGE_MELEE) !== 0) {
    bonus = Math.max(NOMINAL_MELEE_RANGE, (unitTarget ? reach(unitTarget) : casterReach) + casterReach + MELEE_REACH_BONUS);
  } else {
    if ((spell.rangeFlags & SPELL_RANGE_RANGED) !== 0) {
      limits.min = Math.max(NOMINAL_MELEE_RANGE, (unitTarget ? reach(unitTarget) : casterReach) + casterReach + MELEE_REACH_BONUS) + rangeMin;
    } else {
      limits.min = rangeMin;
    }
    max = rangeMax;
    if (unitTarget) {
      bonus = casterReach + reach(unitTarget);
      if (limits.min !== 0 && (spell.rangeFlags & SPELL_RANGE_RANGED) === 0) limits.min += bonus;
    }
  }
  if (unitTarget && moving(caster) && moving(unitTarget)
    && ((spell.rangeFlags & SPELL_RANGE_MELEE) !== 0 || unitTarget.typeId === TYPEID_PLAYER)) {
    bonus += MOVING_LEEWAY;
  }
  if ((attr0 & ATTR0_RANGED) !== 0 && caster.typeId === TYPEID_PLAYER) {
    const modRange = host.rangedModRange();
    if (modRange !== undefined) max = modRange * 0.01 * max;
  }
  max = applyRangeModifiers(spell, max, host);
  limits.max = max + bonus;
  return limits;
}

/** 0x007fd970 op 5 over the spell's family mask: (max + flat) × (100 + pct)%, when any applies. */
function applyRangeModifiers(spell: ActionRangeSpell, max: number, host: ActionRangeHost): number {
  if (((spell.attributes?.[3] ?? 0) & ATTR3_NO_CASTER_MODIFIERS) !== 0) return max;
  const family = host.playerSpellFamily();
  if (family === undefined || spell.spellClassSet === 0 || spell.spellClassSet !== family) return max;
  let flat = 0;
  let pct = 0;
  for (const modifier of host.spellModifiers()) {
    if (modifier.op !== SPELLMOD_RANGE) continue;
    const bit = modifier.effectIndex;
    if (bit < 0 || bit >= 96) continue;
    if (((spell.spellClassMask[bit >>> 5] ?? 0) & (1 << (bit & 31))) === 0) continue;
    if (modifier.pct) pct += modifier.value;
    else flat += modifier.value;
  }
  if (flat === 0 && pct === 0) return max;
  return (flat + max) * Math.max(0, 100 + pct) * 0.01;
}

/**
 * The whole question: 1 in range, 0 out of it, undefined (nil) when 0x00809610 refuses the target or
 * a fact is missing — no spell row, a row from a gateway older than `/dbc/spells?v=14`, no position.
 */
export function frameXmlActionInRange(
  spell: ActionRangeSpell | undefined, caster: WorldObjectState | undefined, named: WorldObjectState | undefined,
  host: ActionRangeHost,
): 1 | 0 | undefined {
  if (!spell || spell.implicitTargetA === undefined || !caster?.position) return undefined;
  const target = actionRangeTarget(spell, caster, named, host);
  const at = target?.position;
  if (!target || !at) return undefined;
  const range = actionRangeLimits(spell, caster, target, host);
  const from = caster.position;
  const dx = at.x - from.x;
  const dy = at.y - from.y;
  const dz = at.z - from.z;
  const distance = dx * dx + dy * dy + dz * dz;
  if (range.min * range.min > distance) return 0;
  return range.max * range.max < distance ? 0 : 1;
}
