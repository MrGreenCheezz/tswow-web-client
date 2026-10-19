/**
 * `IsUsableAction(slot)` and `IsUsableSpell(spell)` (19.10), as Wow.exe 3.3.5a build 12340 answers them.
 *
 * Read from the binary (Ghidra over the local Wow.exe) and cross-checked against the named reconstruction
 * github.com/SatyPardus/wowdecomp (same build, `// OFFSET:` per function):
 *
 * - `IsUsableAction` (0x005a7e60) reads two per-slot caches: `m_slotUsable` and `m_slotNoMana`. Usable and not
 *   short of power → `1, nil`; usable but short → `nil, 1` (ActionButton_UpdateUsable tints the icon blue);
 *   otherwise `nil, nil` (grey). `IsUsableSpell` (0x00541680) asks the same two questions of a book spell.
 * - `CGActionBar::UpdateUsableAction` (0x005a9e20) fills one slot: a spell (an item's use spell, a macro's spell)
 *   passes `Spell_C_IsUsableAction` (0x0080b5d0) and then `noMana = !Spell_C_HaveSpellPower` (0x008017e0).
 *   **A cooldown is not one of its gates**: a recovering spell keeps its colour under the sweep.
 * - `CGActionBar::UpdateUsable` (0x005aa470) recomputes all 144 slots and raises ACTIONBAR_UPDATE_USABLE only when
 *   one of the pairs changed; `UpdateUsablePower` (0x005a8d30) does the same for the power half on a power change.
 *
 * `frameXmlSpellUsable` is 0x0080b5d0 + 0x008017e0 over the data this client has. Gates that need data it does not
 * have are open (usable), so a doubt never greys a button the original would not:
 * - the vehicle/possess player-flag restriction of 0x0080b5d0 (`Spell_C_IsRestrictedAbility`), charm cancelling;
 * - `Spell_C_SpellGetSpellIDForDifficulty` (the aura spell ids are taken as written);
 * - a DK's rune check (`CGRuneInfo::HasRunesForSpell` needs SpellRuneCost.dbc);
 * - `IsInFlyableZone` for AttributesExD 0x4000000 (flying mounts) and a disarm's per-hand slot masks;
 * - the gates whose columns a gateway started before 19.10 does not serve (shapeshift masks, aura states, aura spells,
 *   AuraInterruptFlags, the effects' class masks) — open until it is restarted.
 */
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { spellPowerCost, spellPowerPool } from "../SpellCastGuard.js";
import {
  actionRangeCanAssist, actionRangeCanAttack, actionRangeSameGroup, type ActionRangeHost,
} from "./FrameXmlActionRange.js";

/** One aura on a unit: its spell and the effect mask the aura flags carry (bits 0..2). */
export interface ActionUsableAura {
  readonly spellId: number;
  readonly flags: number;
}

/** An equipped item, as `EquippedItemMeetSpellRequirements` reads it. */
export interface ActionUsableEquipped {
  readonly itemClass: number;
  readonly subClass: number;
  /** `CGItem_C::IsUsable`: not broken (durability 0 of a non-zero maximum). */
  readonly usable: boolean;
  /** ItemSubClass.dbc flag 0x10 (needs no ammo) is not served; the template's AmmoType decides. */
  readonly ammoType: number;
}

/** What the check reads of the world. Every read is a cache read; none asks the realm. */
export interface ActionUsableHost {
  readonly range: ActionRangeHost;
  spell(id: number): SpellMetadata | undefined;
  auras(guid: bigint): readonly ActionUsableAura[];
  /** `m_bag.GetItemTypeCount(item, 0)`: carried, not banked. */
  itemCount(entry: number): number;
  /** `m_bag.FindTotemCategory(category, 0)`. */
  hasTotemCategory(category: number): boolean;
  /** Equipment slot 0..22. */
  equipped(slot: number): ActionUsableEquipped | undefined;
  /** `CGGameUI::GetComboPoints(target)`: the points when they are on that guid, else 0. */
  comboPoints(target: bigint): number;
  /** `CGGameUI::m_hasControl`: the last SMSG_CLIENT_CONTROL_UPDATE left the player its own character. */
  hasControl(): boolean;
  /** `Spell_C_IsActionOnHold`: held until its aura ends (WorldClient.isSpellOnHold). */
  onHold(spellId: number): boolean;
  /** Map.dbc InstanceType of the current map; undefined unknown. */
  instanceType(): number | undefined;
  /** `World::QueryOutdoors`; undefined while the renderer has not placed the player. */
  outdoors(): boolean | undefined;
  /** The `autoSelfCast`, `autoUnshift` and `autoDismountFlying` CVars. */
  cvar(name: "autoSelfCast" | "autoUnshift" | "autoDismountFlying"): boolean;
}

// UnitFlags / UnitFlags2 / PlayerFlags (SharedDefines.h, UnitDefines.h).
const UNIT_FLAG_PREPARATION = 0x20;
const UNIT_FLAG_IN_COMBAT = 0x80000;
const UNIT_FLAG_TAXI_FLIGHT = 0x100000;
const UNIT_FLAG_CONFUSED = 0x400000;
const UNIT_FLAG_FLEEING = 0x800000;
const PLAYER_FLAGS_ALLOW_ONLY_ABILITY = 0x800000;
const PLAYER_FLAGS_RESTRICTED = 0x1000000;
const PLAYER_FLAGS_GHOST = 0x10;
const UNIT_FLAG2_DISABLE_RANGED = 0x400;
const UNIT_VIS_FLAG_CREEP = 0x2;
const MOVEMENTFLAG_SWIMMING = 0x200000;
const MOVEMENTFLAG_FLYING = 0x2000000;
const POWER_HEALTH = -2;
const POWER_RUNE = 5;
// Aura types: 262 ABILITY_IGNORE_AURASTATE, 275 MOD_IGNORE_SHAPESHIFT, 36 MOD_SHAPESHIFT, 7 MOD_FEAR, 5 MOD_CONFUSE.
const AURA_IGNORE_AURASTATE = 262;
const AURA_IGNORE_SHAPESHIFT = 275;
const AURA_MOD_SHAPESHIFT = 36;
const AURA_MOD_FEAR = 7;
const AURA_MOD_CONFUSE = 5;
const SPELL_EFFECT_APPLY_AURA = 6;
const SPELL_EFFECT_TRADE_SKILL = 47;
const SPELL_EFFECT_ATTACK = 78;

function field(unit: WorldObjectState, name: keyof typeof UPDATE_FIELDS, index = 0): number {
  return (unit.fields.get(UPDATE_FIELDS[name].offset + index) ?? 0) >>> 0;
}

function attribute(spell: SpellMetadata, word: number): number {
  return (spell.attributes?.[word] ?? 0) >>> 0;
}

function guidField(unit: WorldObjectState, name: keyof typeof UPDATE_FIELDS): bigint {
  return (BigInt(field(unit, name, 1)) << 32n) | BigInt(field(unit, name));
}

/** `SpellRec::IsAffectedBy` (0x007fdec0): the same family, and the modifier effect's mask meets the spell's. */
function isAffectedBy(spell: SpellMetadata, modifier: SpellMetadata, effect: number): boolean {
  if (spell.spellClassSet !== modifier.spellClassSet) return false;
  const mask = modifier.effectSpellClassMask?.[effect];
  if (!mask) return false;
  return mask.some((word, index) => (word & (spell.spellClassMask[index] ?? 0)) !== 0);
}

/** `CGUnit_C::AffectedByAura` (wowdecomp Unit_C.cpp): an active effect of that type that affects the spell. */
function affectedByAura(unit: WorldObjectState, auraType: number, spell: SpellMetadata, host: ActionUsableHost): boolean {
  for (const aura of host.auras(unit.guid)) {
    const auraSpell = host.spell(aura.spellId);
    if (!auraSpell) continue;
    for (let effect = 0; effect < 3; effect++) {
      if (auraSpell.effectAura[effect] === auraType && (aura.flags & (1 << effect)) !== 0
        && isAffectedBy(spell, auraSpell, effect)) return true;
    }
  }
  return false;
}

/** `CGUnit_C::IgnoresAuraState` (0x0072aaf0): asked of the top of the unit's creator chain. */
function ignoresAuraState(unit: WorldObjectState, spell: SpellMetadata, host: ActionUsableHost): boolean {
  let owner = unit;
  for (let depth = 0; depth < 8; depth++) {
    const creator = guidField(owner, "UNIT_FIELD_CREATEDBY");
    const next = creator === 0n ? undefined : host.range.object(creator);
    if (!next) break;
    owner = next;
  }
  return affectedByAura(owner, AURA_IGNORE_AURASTATE, spell, host);
}

/** `CGUnit_C::HasAuraState` (0x00716160): bit state-1 of UNIT_FIELD_AURASTATE. */
function hasAuraState(unit: WorldObjectState, state: number): boolean {
  return (field(unit, "UNIT_FIELD_AURASTATE") & (1 << ((state - 1) & 31))) !== 0;
}

function hasAuraBySpellId(unit: WorldObjectState, spellId: number, host: ActionUsableHost): boolean {
  return host.auras(unit.guid).some((aura) => aura.spellId === spellId);
}

/** SpellCancelsAura (0x007fdfa0): the spell's immunity effects lift that aura effect. */
function cancelsAura(spell: SpellMetadata, aura: SpellMetadata, auraEffect: number): boolean {
  if ((attribute(spell, 1) & 0x8000) === 0 || (attribute(aura, 0) & 0x20000000) !== 0) return false;
  const effects = spell.effects ?? [];
  for (let effect = 0; effect < 3; effect++) {
    if (effects[effect] !== SPELL_EFFECT_APPLY_AURA) continue;
    const misc = spell.effectMiscValue[effect] ?? 0;
    switch (spell.effectAura[effect]) {
      case 38: if (misc === aura.effectAura[auraEffect]) return true; break;
      case 39: case 267:
        if ((attribute(aura, 2) & 0x4000000) === 0 && (aura.schoolMask & misc) !== 0) return true;
        break;
      case 41: if (misc === aura.dispelType) return true; break;
      case 77: if (misc === aura.mechanic || misc === aura.effectMechanic?.[auraEffect]) return true; break;
    }
  }
  return false;
}

/** `Spell_C_CancelsAuraEffect` (0x00804430): the unit carries that aura type and the spell lifts every one. */
function cancelsAuraEffect(unit: WorldObjectState, spell: SpellMetadata, auraType: number, host: ActionUsableHost): boolean {
  let found = false;
  for (const aura of host.auras(unit.guid)) {
    const auraSpell = host.spell(aura.spellId);
    if (!auraSpell) continue;
    for (let effect = 0; effect < 3; effect++) {
      if (auraSpell.effectAura[effect] !== auraType) continue;
      found = true;
      if (!cancelsAura(spell, auraSpell, effect)) return false;
    }
  }
  return found;
}

/** The current form's SpellShapeshiftForm Flags, through the MOD_SHAPESHIFT aura that made it; undefined unknown. */
function formFlags(unit: WorldObjectState, form: number, host: ActionUsableHost): number | undefined {
  for (const aura of host.auras(unit.guid)) {
    const auraSpell = host.spell(aura.spellId);
    if (!auraSpell) continue;
    for (let effect = 0; effect < 3; effect++) {
      if (auraSpell.effectAura[effect] === AURA_MOD_SHAPESHIFT && auraSpell.effectMiscValue[effect] === form) {
        return auraSpell.shapeshiftFormFlags;
      }
    }
  }
  return undefined;
}

function shapeshiftForm(unit: WorldObjectState): number {
  return (field(unit, "UNIT_FIELD_BYTES_2") >>> 24) & 0xff;
}

/** `CGUnit_C::CanAutoUnshift` (0x0071b130). */
function canAutoUnshift(unit: WorldObjectState, host: ActionUsableHost): boolean {
  if ((field(unit, "UNIT_FIELD_FLAGS") & UNIT_FLAG_TAXI_FLIGHT) !== 0) return false;
  if (unit.guid !== host.range.selfGuid || !host.cvar("autoUnshift")) return false;
  if ((unit.movementFlags & MOVEMENTFLAG_FLYING) !== 0 && !host.cvar("autoDismountFlying")) return false;
  const form = shapeshiftForm(unit);
  return form === 0 || ((formFlags(unit, form, host) ?? 0) & 0x100) === 0;
}

function maskHasForm(mask: readonly number[] | undefined, form: number): boolean {
  return form >= 0 && mask !== undefined && ((mask[form >>> 5] ?? 0) & (1 << (form & 31))) !== 0;
}

/**
 * `CGUnit_C::CheckShapeshiftRules` (0x0072bac0): undefined when the form allows the spell, else the reason —
 * 94 (SPELL_FAILED_ONLY_SHAPESHIFT) or 68 (SPELL_FAILED_NOT_SHAPESHIFT, which an automatic unshift may lift).
 */
function shapeshiftRefusal(unit: WorldObjectState, spell: SpellMetadata, host: ActionUsableHost): 68 | 94 | undefined {
  const form = shapeshiftForm(unit);
  const ignore = (): boolean => affectedByAura(unit, AURA_IGNORE_SHAPESHIFT, spell, host);
  if (maskHasForm(spell.shapeshiftExclude, form - 1)) return ignore() ? undefined : 68;
  if (maskHasForm(spell.shapeshiftMask, form - 1)) return undefined;
  const flags = form === 0 ? undefined : formFlags(unit, form, host);
  // IsShapeShifted (0x00721ca0): a form whose row has no 0x1 («stance») bit. An unknown row counts as a form.
  if (form !== 0 && ((flags ?? 0) & 0x1) === 0) {
    if ((attribute(spell, 0) & 0x10000) !== 0) return ignore() ? undefined : 68;
    if (((flags ?? 0) & 0x400) !== 0) return ignore() ? undefined : 68;
  } else if ((attribute(spell, 2) & 0x80000) !== 0) {
    return undefined;
  }
  const mask = spell.shapeshiftMask;
  if (mask !== undefined && (mask[0] !== 0 || mask[1] !== 0) && !ignore()) return 94;
  return undefined;
}

/** `Spell_C_HasNoReagentCost` (wowdecomp Spell_C.cpp, 0x00800d60). */
function noReagentCost(player: WorldObjectState, spell: SpellMetadata, host: ActionUsableHost): boolean {
  if ((field(player, "UNIT_FIELD_FLAGS") & UNIT_FLAG_PREPARATION) !== 0 && (attribute(spell, 5) & 0x2) !== 0) return true;
  const family = host.range.playerSpellFamily();
  if (!spell.spellClassSet || spell.spellClassSet !== family) return false;
  for (let word = 0; word < 3; word++) {
    if (((spell.spellClassMask[word] ?? 0) & field(player, "PLAYER_NO_REAGENT_COST_1", word)) !== 0) return true;
  }
  return false;
}

/** `Spell_C_HaveSpellTokens` (0x008091d0): tools, totem categories and reagents, for the active player only. */
function haveSpellTokens(unit: WorldObjectState, spell: SpellMetadata, host: ActionUsableHost): boolean {
  if (unit.guid !== host.range.selfGuid) return true;
  for (const tool of spell.tools ?? []) if (host.itemCount(tool) <= 0) return false;
  for (const category of spell.requiredToolCategories ?? []) if (!host.hasTotemCategory(category)) return false;
  if (noReagentCost(unit, spell, host)) return true;
  for (const reagent of spell.reagents ?? []) {
    if (host.itemCount(reagent.itemId) < reagent.count) return false;
  }
  return true;
}

/** `Spell_C_HaveEquippedSpellItems` (0x008093d0) with `checkAmmo`, for the active player only. */
function haveEquippedSpellItems(unit: WorldObjectState, spell: SpellMetadata, host: ActionUsableHost): boolean {
  if (unit.guid !== host.range.selfGuid) return true;
  const itemClass = spell.equippedItemClass ?? -1;
  const subclassMask = spell.equippedItemSubclass ?? 0;
  if (((spell.targets ?? 0) & 0x10) !== 0 || itemClass < 0 || subclassMask === 0) return true;
  const attrC = attribute(spell, 3);
  let slots = (attrC & 0x400) !== 0 ? 0x8000 : (attrC & 0x1000000) !== 0 ? 0x10000
    : (attribute(spell, 0) & 0x2) !== 0 ? 0x20000 : 0xffffffff;
  if ((field(unit, "UNIT_FIELD_FLAGS_2") & UNIT_FLAG2_DISABLE_RANGED) !== 0) slots &= ~0x20000;
  const meets = (mask: number): ActionUsableEquipped | undefined => {
    for (let slot = 0; slot < 23; slot++) {
      if (((mask >>> 0) & (1 << slot)) === 0) continue;
      const item = host.equipped(slot);
      if (item && item.usable && item.itemClass === itemClass && ((1 << item.subClass) & subclassMask) !== 0) return item;
    }
    return undefined;
  };
  const item = meets(slots);
  if (!item) return false;
  if ((attrC & 0x1000400) === 0x1000400 && !meets(0x10000)) return false;
  // The ammo half: a weapon whose template names an ammo type needs PLAYER_AMMO_ID.
  if (item.ammoType !== 0 && field(unit, "PLAYER_AMMO_ID") === 0) return false;
  return true;
}

/** `Spell_C_HaveSpellPower` (0x008017e0): false is IsUsableAction's `notEnoughMana`. */
export function frameXmlSpellHasPower(unit: WorldObjectState, spell: SpellMetadata): boolean {
  if (spell.powerType === POWER_RUNE) return true; // CGRuneInfo::HasRunesForSpell: SpellRuneCost.dbc is not served
  const cost = spellPowerCost(spell, unit);
  const pool = spellPowerPool(spell, unit);
  if (cost === undefined || pool === undefined) return true;
  return spell.powerType === POWER_HEALTH ? cost < pool : cost <= pool;
}

/**
 * `Spell_C_IsUsableAction` (0x0080b5d0): every gate but the power. `target` is the macro's target, else the
 * locked target is asked (`CGGameUI::m_lockedTarget`); `itemFlags` the item's template flags for an item slot.
 */
export function frameXmlSpellCastable(
  unit: WorldObjectState, spell: SpellMetadata, target: WorldObjectState | undefined, host: ActionUsableHost,
  itemFlags?: number,
): boolean {
  const effects = spell.effects ?? [];
  if (effects[0] === SPELL_EFFECT_TRADE_SKILL) return true;
  const attr0 = attribute(spell, 0);
  const isPlayer = unit.guid === host.range.selfGuid;
  const unitFlags = field(unit, "UNIT_FIELD_FLAGS");
  if (isPlayer) {
    const attack = effects[0] === SPELL_EFFECT_ATTACK || (attr0 & 0x2) !== 0;
    const flags = field(unit, "PLAYER_FLAGS");
    if ((flags & PLAYER_FLAGS_RESTRICTED) !== 0) { if (attack) return false; }
    else if (!attack && (flags & PLAYER_FLAGS_ALLOW_ONLY_ABILITY) !== 0) return false;
  }
  // IsDeadOrGhost (vfunc +0x128) unless SPELL_ATTR0_CASTABLE_WHILE_DEAD.
  // A unit whose health the cache has not been told is not taken for dead.
  const dead = unit.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset) === 0
    || (unit.typeId === 4 && (field(unit, "PLAYER_FLAGS") & PLAYER_FLAGS_GHOST) !== 0);
  if (dead && (attr0 & 0x800000) === 0) return false;
  const instanceType = host.instanceType();
  if (instanceType === 4) {
    if ((attribute(spell, 4) & 0x20000) === 0 && (spell.recoveryTime > 900000 || spell.categoryRecoveryTime > 900000
      || (attribute(spell, 4) & 0x10000) !== 0)) return false;
  } else if (instanceType !== undefined && (attribute(spell, 6) & 0x2) !== 0) {
    return false;
  }
  if (!host.hasControl()) {
    let allowed = false;
    if ((unitFlags & UNIT_FLAG_FLEEING) !== 0
      && ((attribute(spell, 5) & 0x20000) !== 0 || cancelsAuraEffect(unit, spell, AURA_MOD_FEAR, host))) allowed = true;
    if ((unitFlags & UNIT_FLAG_CONFUSED) !== 0
      && ((attribute(spell, 5) & 0x40000) !== 0 || cancelsAuraEffect(unit, spell, AURA_MOD_CONFUSE, host))) allowed = true;
    if (((unitFlags & UNIT_FLAG_TAXI_FLIGHT) === 0 || (attr0 & 0x1000000) === 0) && !allowed) return false;
  }
  if (((itemFlags ?? 0) & 0x10000000) === 0 && !haveSpellTokens(unit, spell, host)) return false;
  if (!haveEquippedSpellItems(unit, spell, host)) return false;
  const targetGuid = target?.guid;
  if ((attribute(spell, 1) & 0x500000) !== 0 && isPlayer) {
    if ((targetGuid === undefined || host.comboPoints(targetGuid) <= 0) && !ignoresAuraState(unit, spell, host)) return false;
  }
  const shapeshift = shapeshiftRefusal(unit, spell, host);
  if (shapeshift !== undefined && (shapeshift === 94 || !canAutoUnshift(unit, host))) return false;
  // CheckStealthRules (0x0072bc20): SPELL_ATTR0_ONLY_STEALTHED wants UNIT_FIELD_BYTES_1 byte 2's creep bit.
  if ((attr0 & 0x20000) !== 0 && ((field(unit, "UNIT_FIELD_BYTES_1") >>> 16) & UNIT_VIS_FLAG_CREEP) === 0
    && !affectedByAura(unit, AURA_IGNORE_SHAPESHIFT, spell, host)) return false;
  if ((attr0 & 0x10000000) !== 0 && (unitFlags & UNIT_FLAG_IN_COMBAT) !== 0 && !ignoresAuraState(unit, spell, host)) return false;
  const ignoring = (): boolean => ignoresAuraState(unit, spell, host);
  if (spell.casterAuraState && !hasAuraState(unit, spell.casterAuraState) && !ignoring()) return false;
  if (spell.excludeCasterAuraState && hasAuraState(unit, spell.excludeCasterAuraState) && !ignoring()) return false;
  if (spell.casterAuraSpell && !hasAuraBySpellId(unit, spell.casterAuraSpell, host) && !ignoring()) return false;
  if (spell.excludeCasterAuraSpell && hasAuraBySpellId(unit, spell.excludeCasterAuraSpell, host) && !ignoring()) return false;
  if (spell.targetAuraState || spell.excludeTargetAuraState || spell.targetAuraSpell || spell.excludeTargetAuraSpell) {
    let targetUnit = target;
    const implicit = spell.implicitTargetA?.[0] ?? 0;
    const friendlyImplicit = implicit === 21 || implicit === 35 || implicit === 57 || implicit === 61;
    if (host.cvar("autoSelfCast")
      && (!targetUnit || (friendlyImplicit && !actionRangeCanAssist(unit, targetUnit, false, host.range)))) {
      const self = host.range.selfGuid === undefined ? undefined : host.range.object(host.range.selfGuid);
      targetUnit = self;
    }
    if (targetUnit) {
      if (spell.targetAuraState && !hasAuraState(targetUnit, spell.targetAuraState) && !ignoring()) return false;
      if (spell.excludeTargetAuraState && hasAuraState(targetUnit, spell.excludeTargetAuraState) && !ignoring()) return false;
      if (spell.targetAuraSpell && !hasAuraBySpellId(targetUnit, spell.targetAuraSpell, host) && !ignoring()) return false;
      if (spell.excludeTargetAuraSpell && hasAuraBySpellId(targetUnit, spell.excludeTargetAuraSpell, host) && !ignoring()) return false;
      if (implicit === 6 && !actionRangeCanAttack(unit, targetUnit, host.range)) return false;
      if (implicit === 21 && !actionRangeCanAssist(unit, targetUnit, false, host.range)) return false;
      if (implicit === 35 && (!actionRangeSameGroup(unit, targetUnit, true, host.range)
        || !actionRangeCanAssist(unit, targetUnit, false, host.range))) return false;
      if ((implicit === 57 || implicit === 61) && (!actionRangeSameGroup(unit, targetUnit, false, host.range)
        || !actionRangeCanAssist(unit, targetUnit, false, host.range))) return false;
    } else if (spell.targetAuraState || spell.targetAuraSpell) {
      return false;
    }
  }
  if ((attr0 & 0x2000000) !== 0 && host.onHold(spell.id)) return false;
  const interrupt = spell.auraInterruptFlags ?? 0;
  const channel = (attribute(spell, 1) & 0x44) !== 0 ? (spell.channelInterruptFlags ?? 0) : 0;
  const swimming = (unit.movementFlags & MOVEMENTFLAG_SWIMMING) !== 0;
  if (((interrupt | channel) & 0x100) !== 0 && !swimming) return false;
  if (((interrupt | channel) & 0x80) !== 0 && swimming) return false;
  if ((attr0 & 0xc000) !== 0) {
    const outdoors = host.outdoors();
    if (outdoors === true && (attr0 & 0x4000) !== 0) return false;
    if (outdoors === false && (attr0 & 0x8000) !== 0) return false;
  }
  if ((attribute(spell, 3) & 0x800) !== 0 && instanceType !== undefined && instanceType !== 3) return false;
  if ((attribute(spell, 6) & 0x800) !== 0 && instanceType === 2) return false;
  return true;
}

/** `IsUsableAction`/`IsUsableSpell`'s pair for one spell: [usable, notEnoughMana]. */
export function frameXmlSpellUsable(
  unit: WorldObjectState, spell: SpellMetadata, target: WorldObjectState | undefined, host: ActionUsableHost,
  itemFlags?: number,
): readonly [boolean, boolean] {
  if (spell.passive) return [false, false];
  if (!frameXmlSpellCastable(unit, spell, target, host, itemFlags)) return [false, false];
  return frameXmlSpellHasPower(unit, spell) ? [true, false] : [false, true];
}

/**
 * Wow.exe 0x005a7b50: a TotemCategory id -> the element slots it serves (4 fire 0x1, 2 earth 0x2, 5 water 0x4,
 * 3 air 0x8, 21 the Master Totem 0xf); 0 for any other category. The gateway's `totemCategorySlotMask` twin.
 */
export function frameXmlTotemCategorySlotMask(category: number): number {
  switch (category) {
    case 2: return 0x2;
    case 3: return 0x8;
    case 4: return 0x1;
    case 5: return 0x4;
    case 21: return 0xf;
    default: return 0;
  }
}
