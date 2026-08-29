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
  | "global-cooldown"
  | "power";

/** `POWER_HEALTH` in TrinityCore's spell power enum. */
const POWER_HEALTH = -2;

/**
 * The unmodified resource cost represented by a DBC row, in the same raw units as update fields.
 * Flat cost and percentage cost are alternatives in WotLK data, never a sum. `undefined` means
 * the client lacks enough information to preflight safely and must let the server decide.
 * This is intentionally an unmodified estimate: aura, talent and class-specific cost modifiers
 * are not reconstructed from the update stream and therefore must not be invented here.
 */
export function spellPowerCost(
  metadata: Pick<SpellMetadata, "powerType" | "powerCost" | "powerCostPercent">,
  self: WorldObjectState,
): number | undefined {
  if (metadata.powerCost > 0) return metadata.powerCost;
  if (metadata.powerCostPercent <= 0 || !Number.isFinite(metadata.powerCostPercent)) return 0;
  const base = spellPowerBase(metadata.powerType, self);
  return base === undefined ? undefined : Math.floor(base * metadata.powerCostPercent / 100);
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
  metadata: Pick<SpellMetadata, "powerType" | "powerCost" | "powerCostPercent">,
): boolean {
  const selfGuid = world.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
  if (!self) return true;
  const cost = spellPowerCost(metadata, self);
  const pool = spellPowerPool(metadata, self);
  // Unknown fields/power types are deliberately allowed: the realm has the authoritative values.
  return cost === undefined || pool === undefined || cost <= pool;
}

function spellPowerBase(powerType: number, self: WorldObjectState): number | undefined {
  if (powerType === POWER.mana) return readField(self, "UNIT_FIELD_BASE_MANA");
  if (powerType === POWER_HEALTH) return readField(self, "UNIT_FIELD_BASE_HEALTH");
  // Rune power has no reliable max-power base in the client update stream; leave percentage
  // costs unknown so the realm remains authoritative rather than guessing from a stale slot.
  if (!Number.isInteger(powerType) || powerType < POWER.mana || powerType > POWER.runicPower || powerType === POWER.rune) return undefined;
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
  if (world.cooldownRemaining(spellId, now) > 0) return "cooldown";
  if (metadata.startRecoveryTime > 0 && game.globalCooldownUntil > now) return "global-cooldown";

  if (!spellPowerAvailable(world, metadata)) return "power";
  return undefined;
}

/** Used by callers that only need the allow/deny result. */
export function spellCastAllowed(world: WorldClient, spellId: number, now = performance.now()): boolean {
  return spellCastBlockReason(world, spellId, now) === undefined;
}
