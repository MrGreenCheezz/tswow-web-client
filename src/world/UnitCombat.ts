import type { AttackerState } from "./CombatProtocol.js";
import type {
  DamageShieldLog, PeriodicAuraLog, SpellDamageLog, SpellEnergizeLog, SpellHealLog, SpellLogPair,
} from "./SpellLogProtocol.js";

/**
 * One blow, heal, energize or miss, as the packet that reported it states it.
 *
 * `FLOATING_TEXT` is the same moment already worded for the number over a head; it drops the
 * school, the absorbed/blocked/resisted parts and the crushing/glancing bits, and melee never
 * reaches it at all. The stock hit indicator over the Player/Target/Pet portraits (`UNIT_COMBAT`,
 * CombatFeedback.lua) needs exactly those facts, so the world hands the parsed packet through and
 * leaves the wording to the interface (FrameXmlCombatFeedback.ts).
 */
export type UnitCombatEvent =
  | { readonly source: "melee"; readonly swing: AttackerState }
  | { readonly source: "spellDamage"; readonly log: SpellDamageLog }
  | { readonly source: "heal"; readonly log: SpellHealLog }
  | { readonly source: "energize"; readonly log: SpellEnergizeLog }
  | { readonly source: "periodic"; readonly log: PeriodicAuraLog }
  | {
    readonly source: "miss";
    readonly casterGuid: bigint;
    readonly targetGuid: bigint;
    readonly spellId: number;
    /** `SpellMissInfo` (SharedDefines.h): 1 miss … 11 reflect. */
    readonly missInfo: number;
  }
  | { readonly source: "damageShield"; readonly log: DamageShieldLog }
  | { readonly source: "immune"; readonly log: SpellLogPair }
  | { readonly source: "resist"; readonly log: SpellLogPair };
