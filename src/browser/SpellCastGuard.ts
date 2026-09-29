import type { WorldClient } from "../world/WorldClient.js";
import type { WorldObjectState } from "../world/WorldState.js";
import { POWER, readField } from "../world/Fields.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { game } from "./game/Context.js";
import { spellButtonUsable, type SpellMetadata } from "./SpellMetadata.js";

/** The local reasons a browser action can be rejected before it reaches the realm. */
export type SpellCastBlockReason =
  | "world"
  | "unknown"
  | "passive"
  | "cooldown"
  /** Held until its aura ends (`WorldClient.isSpellOnHold`): the realm answers NOT_READY, and there is no sweep. */
  | "hold"
  | "global-cooldown"
  | "power"
  | "dead";

/** `POWER_HEALTH` in TrinityCore's spell power enum. */
const POWER_HEALTH = -2;
const costFieldBits = new DataView(new ArrayBuffer(4));

/**
 * The resource cost represented by a DBC row and the visible school aura update fields, in the
 * same raw units as the power update fields. SpellInfo::CalcPowerCost starts with ManaCost, adds
 * ManaCostPct of the caster's base power, applies the flat school modifier, then the school
 * multiplier. Spell-family modifiers are handled by spellPowerAvailable below.
 * `undefined` means the client lacks enough information to preflight safely and lets the server decide.
 */
export function spellPowerCost(
  metadata: Pick<SpellMetadata, "powerType" | "powerCost" | "powerCostPercent" | "schoolMask">,
  self: WorldObjectState,
): number | undefined {
  if (!Number.isFinite(metadata.powerCost) || !Number.isFinite(metadata.powerCostPercent)) return undefined;
  const flat = metadata.powerCost;
  let cost = flat;
  if (metadata.powerCostPercent !== 0 && metadata.powerType !== POWER.rune && metadata.powerType !== POWER.runicPower) {
    const base = spellPowerBase(metadata.powerType, self);
    if (base === undefined) return undefined;
    cost += Math.trunc(base * metadata.powerCostPercent / 100);
  }
  // The selected core logs this percentage path as unimplemented for both rune power types;
  // it uses ManaCost alone rather than a speculative max-power field.
  const school = firstSpellSchool(metadata.schoolMask);
  if (school === undefined) return undefined;
  const flatSchool = self.fields.get(UPDATE_FIELDS.UNIT_FIELD_POWER_COST_MODIFIER.offset + school);
  const multiplierBits = self.fields.get(UPDATE_FIELDS.UNIT_FIELD_POWER_COST_MULTIPLIER.offset + school);
  costFieldBits.setUint32(0, multiplierBits ?? 0, true);
  const multiplier = costFieldBits.getFloat32(0, true);
  if (!Number.isFinite(multiplier)) return undefined;
  // The update stream stores the signed flat modifier as an unsigned 32-bit slot. Match the
  // core's float32 multiplication before truncating to int32 so boundary values stay aligned.
  cost = Math.trunc(Math.fround(Math.fround(cost + ((flatSchool ?? 0) | 0)) * Math.fround(1 + multiplier)));
  return Math.max(0, cost);
}

function firstSpellSchool(mask: number): number | undefined {
  if (!Number.isInteger(mask)) return undefined;
  for (let school = 0; school < 7; school++) if ((mask & (1 << school)) !== 0) return school;
  // GetFirstSchoolInMask falls back to SPELL_SCHOOL_NORMAL for an empty/unknown mask.
  return 0;
}

/** The current pool for the spell's declared power type, not the unit's active display type. */
export function spellPowerPool(
  metadata: Pick<SpellMetadata, "powerType">,
  self: WorldObjectState,
): number | undefined {
  if (metadata.powerType === POWER_HEALTH) return readField(self, "UNIT_FIELD_HEALTH");
  if (!Number.isInteger(metadata.powerType) || metadata.powerType < POWER.mana || metadata.powerType > POWER.runicPower) return undefined;
  return self.fields.get(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + metadata.powerType);
}

/** Whether this spell's known flat/percent cost fits its matching current resource pool. */
export function spellPowerAvailable(
  world: WorldClient,
  metadata: Pick<SpellMetadata, "powerType" | "powerCost" | "powerCostPercent" | "schoolMask">,
): boolean {
  const selfGuid = world.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
  if (!self) return true;
  const cost = spellPowerCost(metadata, self);
  const pool = spellPowerPool(metadata, self);
  // Unknown fields/power types are deliberately allowed: the realm has the authoritative values.
  if (cost === undefined || pool === undefined || cost <= pool) return true;
  // SMSG_SET_*_SPELL_MODIFIER has a SPELLMOD_COST aggregate but omits its source aura, family,
  // charges and conditional applicability. A local denial would be a guess while any cost mod
  // is active; send the cast and let SpellInfo::CalcPowerCost make the authoritative decision.
  for (const modifier of world.spellModifiers.values()) if (modifier.op === 14) return true;
  return false;
}

function spellPowerBase(powerType: number, self: WorldObjectState): number | undefined {
  if (powerType === POWER.mana) return readField(self, "UNIT_FIELD_BASE_MANA");
  if (powerType === POWER_HEALTH) return readField(self, "UNIT_FIELD_BASE_HEALTH");
  if (!Number.isInteger(powerType) || powerType < POWER.mana || powerType > POWER.runicPower
    || powerType === POWER.rune || powerType === POWER.runicPower) return undefined;
  return self.fields.get(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + powerType);
}

/**
 * The shared preflight for browser-owned spell actions.
 *
 * `WorldClient` deliberately has no DBC or UI dependency, so it cannot answer passive, recovery,
 * global-cooldown or power questions. Keeping those checks here lets tracking, talents and module
 * windows avoid dismounting for a request the browser already knows it will not send, while the
 * realm remains authoritative for the final result.
 */
export function spellCastBlockReason(
  world: WorldClient,
  spellId: number,
  now = performance.now(),
): SpellCastBlockReason | undefined {
  if (world.state.selfGuid === undefined) return "world";
  if (!world.knownSpells.some((spell) => spell.id === spellId)) return "unknown";
  const metadata = game.spells.get(spellId);
  if (!metadata) return "unknown";
  if (!spellButtonUsable(metadata)) return "passive";

  // Reapplying the currently active mount is a cancel-only operation. Its old spell recovery,
  // global cooldown and power cost must not make the toggle unavailable.
  if (typeof world.isActiveMountSpell === "function" && world.isActiveMountSpell(spellId)) return undefined;
  // Dead characters cast nothing: the server would refuse, but a local notice beats silence.
  // Silence/stun/disarm/school-lock prechecks stay server-authoritative: the update stream
  // carries no mechanic table, and inventing flag bits would block legal casts.
  const selfGuid = world.controlledGuid ?? world.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
  if (self && (self.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset) ?? 1) <= 0) return "dead";
  if (world.cooldownRemaining(spellId, now) > 0) return "cooldown";
  if (world.isSpellOnHold?.(spellId)) return "hold";
  if (metadata.startRecoveryTime > 0 && game.globalCooldownUntil > now) return "global-cooldown";

  if (!spellPowerAvailable(world, metadata)) return "power";
  return undefined;
}

/** Used by callers that only need the allow/deny result. */
export function spellCastAllowed(world: WorldClient, spellId: number, now = performance.now()): boolean {
  return spellCastBlockReason(world, spellId, now) === undefined;
}
