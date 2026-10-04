/**
 * L12-review (04.10), plan item 5.30: how long the global cooldown a cast request starts is predicted to
 * run — a bound the realm's own global cooldown never undercuts, so a prediction built on it never makes the
 * client refuse a cast the realm would take.
 *
 * The realm (TrinityCore Spell::TriggerGlobalCooldown, Spell.cpp:8693-8723) and Wow.exe 3.3.5a 12340
 * (0x00805d70, read-only Ghidra 2026-10-04) compute it the same way:
 * 1. StartRecoveryTime with SPELLMOD_GLOBAL_COOLDOWN (21) applied: (time + flat) × (100 + pct) / 100;
 * 2. then, for StartRecoveryCategory 133 at exactly 1500 ms and a spell that is not melee or ranged
 *    (DmgClass 2, 3) and has neither SPELL_ATTR0_REQ_AMMO (0x2) nor SPELL_ATTR0_ABILITY (0x10): times the
 *    caster's UNIT_MOD_CAST_SPEED, truncated and kept within 1000..1500 ms.
 * The realm keys the result by StartRecoveryCategory and starts none for category 0.
 *
 * L13 (04.10): rows from `/dbc/spells?v=17` carry StartRecoveryCategory, and with it the realm's rule holds
 * exactly: category 0 starts no global cooldown at all (Spell.cpp:8698), and only category 133 is hasted.
 *
 * What the client knows here is less, and every gap is taken on the shorter side:
 * - Rows from an older gateway carry no StartRecoveryCategory: a 1500-ms row is hasted as if it were 133 (true
 *   for all but 12 of the dataset's 2,141 non-passive 1500-ms book rows) — shorter than the realm's for those
 *   12 — and a category-0 row with a time is predicted as if it had a category (as before L13).
 * - DmgClass (`/dbc/spells?v=16`) and the attribute words (v=14) may be missing from an older gateway's row;
 *   a part that is missing does not exclude the haste.
 * - The SPELLMOD entries (SMSG_SET_FLAT/PCT_SPELL_MODIFIER) say only a family-mask bit, an op and a sum: a
 *   reducing entry on any bit of the spell's mask is applied, a lengthening one never (the realm also
 *   checks the aura's family, which can only drop reductions — and add the lengthenings left out here).
 * - The haste is applied only where it shortens: the realm's 1000-ms floor after a large reduction is
 *   left out too.
 *
 * Which spells a running global cooldown holds is the category's business too: PredictedGlobalCooldown.ts
 * (`globalCooldownEndFor`, L13).
 */
import { readField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/** SpellModOp SPELLMOD_GLOBAL_COOLDOWN (SharedDefines.h; Wow.exe 0x007fd970 with 0x15). */
export const SPELLMOD_GLOBAL_COOLDOWN = 21;

const GCD_FLOOR = 1000; // MIN_GCD (Spell.cpp:8672)
const GCD_CEILING = 1500; // MAX_GCD
const ATTR0_REQ_AMMO = 0x2;
const ATTR0_ABILITY = 0x10;
const DMG_CLASS_MELEE = 2;
const DMG_CLASS_RANGED = 3;
/** L13: the category the realm and Wow.exe haste (Spell.cpp:8711; 0x00805d70 compares it with 0x85). */
export const HASTED_GLOBAL_COOLDOWN_CATEGORY = 133;

/** The row columns read: StartRecoveryTime always; the rest when the gateway serves them. */
export interface GlobalCooldownRow {
  readonly startRecoveryTime: number;
  /** L13: StartRecoveryCategory (`/dbc/spells?v=17`); undefined from an older gateway. */
  readonly startRecoveryCategory?: number | undefined;
  readonly dmgClass?: number | undefined;
  readonly attributes?: readonly number[] | undefined;
  readonly spellClassMask?: readonly number[] | undefined;
}

/** One SPELLMOD entry as `WorldClient.spellModifiers` keeps it (`effectIndex` is the family-mask bit). */
export interface GlobalCooldownModifier {
  readonly effectIndex: number;
  readonly op: number;
  readonly value: number;
  readonly pct: boolean;
}

function maskHasBit(mask: readonly number[] | undefined, bit: number): boolean {
  if (!Number.isInteger(bit) || bit < 0 || bit >= 96) return false;
  // A row without its family mask takes every reduction: the shorter answer.
  if (!mask) return true;
  return ((mask[bit >>> 5] ?? 0) & (1 << (bit & 31))) !== 0;
}

/** Known to be off the haste rule: melee or ranged, or REQ_AMMO/ABILITY. Unknown counts as hasted. */
function excludedFromHaste(row: GlobalCooldownRow): boolean {
  const dmgClass = row.dmgClass;
  if (dmgClass === DMG_CLASS_MELEE || dmgClass === DMG_CLASS_RANGED) return true;
  return ((row.attributes?.[0] ?? 0) & (ATTR0_REQ_AMMO | ATTR0_ABILITY)) !== 0;
}

/**
 * The predicted duration in milliseconds; 0 for a spell off the global cooldown (or without a row).
 * `castSpeed` is the player's UNIT_MOD_CAST_SPEED (undefined when not known: no haste).
 */
export function predictedGlobalCooldownDuration(
  row: GlobalCooldownRow | undefined,
  castSpeed: number | undefined,
  modifiers: Iterable<GlobalCooldownModifier> | undefined,
): number {
  const base = row?.startRecoveryTime ?? 0;
  if (!row || !Number.isFinite(base) || base <= 0) return 0;
  const category = row.startRecoveryCategory; // L13
  if (category === 0) return 0; // L13: `if (!m_spellInfo->StartRecoveryCategory) return;` (Spell.cpp:8698)
  let duration = base;
  if (modifiers) {
    let flat = 0;
    let pct = 0;
    for (const modifier of modifiers) {
      if (modifier.op !== SPELLMOD_GLOBAL_COOLDOWN || !(modifier.value < 0)) continue;
      if (!maskHasBit(row.spellClassMask, modifier.effectIndex)) continue;
      if (modifier.pct) pct += modifier.value;
      else flat += modifier.value;
    }
    if (flat !== 0 || pct !== 0) duration = Math.trunc((duration + flat) * Math.max(0, 100 + pct) / 100);
  }
  // L13: a known category other than 133 is not hasted; an unknown one is (the shorter answer).
  if (base === GCD_CEILING && (category === undefined || category === HASTED_GLOBAL_COOLDOWN_CATEGORY)
    && !excludedFromHaste(row)) {
    const speed = castSpeed !== undefined && Number.isFinite(castSpeed) && castSpeed > 0 ? castSpeed : 1;
    // float × float, truncated (`int32(float(gcd) * GetFloatValue(UNIT_MOD_CAST_SPEED))`), then the interval.
    const hasted = Math.min(GCD_CEILING, Math.max(GCD_FLOOR,
      Math.trunc(Math.fround(Math.fround(duration) * Math.fround(speed)))));
    if (hasted < duration) duration = hasted;
  }
  return Math.max(0, duration);
}

/** The world parts read: the player's cast speed and SPELLMOD entries (`WorldClient`). */
export interface GlobalCooldownWorld {
  readonly state?: {
    readonly selfGuid?: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  } | undefined;
  readonly spellModifiers?: ReadonlyMap<string, GlobalCooldownModifier> | undefined;
}

/** The player's UNIT_MOD_CAST_SPEED, or undefined before the field arrived. */
export function playerCastSpeed(world: GlobalCooldownWorld | undefined): number | undefined {
  const state = world?.state;
  const selfGuid = state?.selfGuid;
  const self = selfGuid === undefined ? undefined : state?.objects.get(selfGuid);
  return self ? readField(self, "UNIT_MOD_CAST_SPEED") : undefined;
}

/** `predictedGlobalCooldownDuration` with the world's caster speed and SPELLMOD entries. */
export function globalCooldownDurationIn(world: GlobalCooldownWorld | undefined, row: GlobalCooldownRow | undefined): number {
  if (!row || !(row.startRecoveryTime > 0)) return 0;
  return predictedGlobalCooldownDuration(row, playerCastSpeed(world), world?.spellModifiers?.values());
}
