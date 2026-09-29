import {
  HITINFO_CRITICAL, HITINFO_CRUSHING, HITINFO_GLANCING, HITINFO_MISS,
  VICTIMSTATE_BLOCKS, VICTIMSTATE_DEFLECTS, VICTIMSTATE_DODGE, VICTIMSTATE_EVADES, VICTIMSTATE_IMMUNE,
  VICTIMSTATE_INTERRUPT, VICTIMSTATE_PARRY,
} from "../../world/CombatProtocol.js";
import {
  AURA_OBS_MOD_HEALTH, AURA_OBS_MOD_POWER, AURA_PERIODIC_DAMAGE, AURA_PERIODIC_DAMAGE_PERCENT,
  AURA_PERIODIC_ENERGIZE, AURA_PERIODIC_HEAL,
} from "../../world/SpellLogProtocol.js";
import type { UnitCombatEvent } from "../../world/UnitCombat.js";

/**
 * `UNIT_COMBAT`'s `action` argument: the keys of CombatFeedback.lua's `CombatFeedbackText`, plus
 * the three it words itself (WOUND shows the number, HEAL and ENERGIZE show theirs in colour).
 */
export type FrameXmlCombatAction =
  | "WOUND" | "HEAL" | "ENERGIZE"
  | "MISS" | "RESIST" | "DODGE" | "PARRY" | "BLOCK" | "EVADE" | "IMMUNE" | "DEFLECT" | "ABSORB"
  | "REFLECT" | "INTERRUPT";

/**
 * `UNIT_COMBAT`'s `descriptor`: CombatFeedback.lua sizes a WOUND, HEAL or ENERGIZE by CRITICAL,
 * CRUSHING and GLANCING, and words a zero-damage WOUND by ABSORB, BLOCK or RESIST (else «MISS»).
 */
export type FrameXmlCombatDescriptor = "" | "CRITICAL" | "CRUSHING" | "GLANCING" | "ABSORB" | "BLOCK" | "RESIST";

/** The arguments of one `UNIT_COMBAT(unit, action, descriptor, damage, damageType)`, before the unit is named. */
export interface FrameXmlCombatFeedback {
  readonly targetGuid: bigint;
  readonly casterGuid: bigint;
  readonly action: FrameXmlCombatAction;
  readonly descriptor: FrameXmlCombatDescriptor;
  /** The number the indicator prints for WOUND/HEAL/ENERGIZE; 0 for the worded actions. */
  readonly amount: number;
  /**
   * The school *mask*, as CombatFeedback.lua compares it: `type ~= SCHOOL_MASK_PHYSICAL` (0x01)
   * paints a WOUND yellow, so a melee blow has to arrive as 1 and not as 0 to stay white.
   */
  readonly school: number;
}

/** `SCHOOL_MASK_PHYSICAL` in CombatFeedback.lua and `SpellSchoolMask` alike. */
export const SCHOOL_MASK_PHYSICAL = 0x01;

/** `SpellMissInfo` (SharedDefines.h) by value; 8 is the core's own «one of these 2 is temp-immune». */
const MISS_ACTIONS: Readonly<Record<number, FrameXmlCombatAction>> = Object.freeze({
  1: "MISS", 2: "RESIST", 3: "DODGE", 4: "PARRY", 5: "BLOCK", 6: "EVADE", 7: "IMMUNE", 8: "IMMUNE",
  9: "DEFLECT", 10: "ABSORB", 11: "REFLECT",
});

/** `VictimState` values that name what the victim did instead of taking the swing. */
const VICTIM_ACTIONS: Readonly<Record<number, FrameXmlCombatAction>> = Object.freeze({
  [VICTIMSTATE_DODGE]: "DODGE", [VICTIMSTATE_PARRY]: "PARRY", [VICTIMSTATE_INTERRUPT]: "INTERRUPT",
  // A block that swallows the whole swing is VICTIMSTATE_BLOCKS (Unit::CalculateMeleeDamage);
  // a partial one stays VICTIMSTATE_HIT with HITINFO_BLOCK and prints the damage that got through.
  [VICTIMSTATE_BLOCKS]: "BLOCK", [VICTIMSTATE_EVADES]: "EVADE", [VICTIMSTATE_IMMUNE]: "IMMUNE",
  [VICTIMSTATE_DEFLECTS]: "DEFLECT",
});

/** What a wound that did no damage is worded as: the part that stopped it, in the order the client prints. */
function zeroWoundDescriptor(absorbed: number, blocked: number, resisted: number): FrameXmlCombatDescriptor {
  return absorbed > 0 ? "ABSORB" : blocked > 0 ? "BLOCK" : resisted > 0 ? "RESIST" : "";
}

/**
 * The `UNIT_COMBAT` arguments for one combat packet, or nothing when the packet shows nothing over
 * a portrait (a leech tick, a spell log with no target reaction, an empty damage shield).
 *
 * Pure on purpose: the packet facts come from UnitCombat.ts and the wording rules from
 * CombatFeedback.lua, and the table in tests/framexml-combat-feedback.test.mjs walks every branch.
 */
export function combatFeedbackOf(event: UnitCombatEvent): FrameXmlCombatFeedback | undefined {
  switch (event.source) {
    case "melee": {
      const { swing } = event;
      const base = { targetGuid: swing.victim, casterGuid: swing.attacker, amount: 0 } as const;
      // Melee is physical unless the weapon adds a school; the first sub-damage names the school.
      const school = swing.damages[0]?.schoolMask ?? SCHOOL_MASK_PHYSICAL;
      if ((swing.hitInfo & HITINFO_MISS) !== 0) return { ...base, action: "MISS", descriptor: "", school };
      const reaction = VICTIM_ACTIONS[swing.victimState];
      if (reaction !== undefined) return { ...base, action: reaction, descriptor: "", school };
      let descriptor: FrameXmlCombatDescriptor = (swing.hitInfo & HITINFO_CRITICAL) !== 0 ? "CRITICAL"
        : (swing.hitInfo & HITINFO_CRUSHING) !== 0 ? "CRUSHING"
          : (swing.hitInfo & HITINFO_GLANCING) !== 0 ? "GLANCING" : "";
      if (swing.damage === 0) {
        const absorbed = swing.damages.reduce((sum, part) => sum + part.absorbed, 0);
        const resisted = swing.damages.reduce((sum, part) => sum + part.resisted, 0);
        descriptor = zeroWoundDescriptor(absorbed, swing.blocked, resisted);
      }
      return { ...base, action: "WOUND", descriptor, amount: swing.damage, school };
    }
    case "spellDamage": {
      const { log } = event;
      const descriptor: FrameXmlCombatDescriptor = log.damage > 0
        ? (log.critical ? "CRITICAL" : "")
        : zeroWoundDescriptor(log.absorbed, log.blocked, log.resisted);
      return {
        targetGuid: log.targetGuid, casterGuid: log.casterGuid, action: "WOUND", descriptor,
        amount: log.damage, school: log.schoolMask,
      };
    }
    case "heal": {
      const { log } = event;
      return {
        targetGuid: log.targetGuid, casterGuid: log.casterGuid, action: "HEAL",
        descriptor: log.critical ? "CRITICAL" : "", amount: log.amount, school: 0,
      };
    }
    case "energize": {
      const { log } = event;
      return {
        targetGuid: log.targetGuid, casterGuid: log.casterGuid, action: "ENERGIZE", descriptor: "",
        amount: log.amount, school: 0,
      };
    }
    case "periodic": {
      const { log } = event;
      const common = { targetGuid: log.targetGuid, casterGuid: log.casterGuid } as const;
      if (log.auraType === AURA_PERIODIC_DAMAGE || log.auraType === AURA_PERIODIC_DAMAGE_PERCENT) {
        const descriptor: FrameXmlCombatDescriptor = log.amount > 0
          ? (log.critical ? "CRITICAL" : "")
          : zeroWoundDescriptor(log.absorbed, 0, log.resisted);
        return { ...common, action: "WOUND", descriptor, amount: log.amount, school: log.schoolMask };
      }
      if (log.auraType === AURA_PERIODIC_HEAL || log.auraType === AURA_OBS_MOD_HEALTH) {
        return { ...common, action: "HEAL", descriptor: log.critical ? "CRITICAL" : "", amount: log.amount, school: 0 };
      }
      if (log.auraType === AURA_PERIODIC_ENERGIZE || log.auraType === AURA_OBS_MOD_POWER) {
        return { ...common, action: "ENERGIZE", descriptor: "", amount: log.amount, school: 0 };
      }
      // Leeches and the aura types the core writes nothing for: no number belongs over a portrait.
      return undefined;
    }
    case "miss": {
      const action = MISS_ACTIONS[event.missInfo];
      if (action === undefined) return undefined;
      return { targetGuid: event.targetGuid, casterGuid: event.casterGuid, action, descriptor: "", amount: 0, school: 0 };
    }
    case "damageShield": {
      const { log } = event;
      if (log.damage <= 0) return undefined;
      return {
        targetGuid: log.targetGuid, casterGuid: log.casterGuid, action: "WOUND", descriptor: "",
        amount: log.damage, school: log.schoolMask,
      };
    }
    case "immune":
    case "resist": {
      const { log } = event;
      return {
        targetGuid: log.targetGuid, casterGuid: log.casterGuid,
        action: event.source === "immune" ? "IMMUNE" : "RESIST", descriptor: "", amount: 0, school: 0,
      };
    }
    default:
      return undefined;
  }
}

/** The unit tokens whose stock frames register `UNIT_COMBAT`, plus the party the same way the client does. */
export const FRAMEXML_COMBAT_FEEDBACK_UNITS: readonly string[] = Object.freeze([
  "player", "pet", "target", "focus", "targettarget", "party1", "party2", "party3", "party4",
]);

/**
 * Every `UNIT_COMBAT` argument list one event produces: one per watched token the target
 * currently is. A target that is both «target» and «party2» is told twice, as the client does.
 */
export function frameXmlUnitCombatArgs(
  feedback: FrameXmlCombatFeedback,
  unitGuid: (unit: string) => bigint | undefined,
): readonly (readonly [unit: string, action: string, descriptor: string, amount: number, school: number])[] {
  const lines: (readonly [string, string, string, number, number])[] = [];
  for (const unit of FRAMEXML_COMBAT_FEEDBACK_UNITS) {
    if (unitGuid(unit) === feedback.targetGuid) {
      lines.push([unit, feedback.action, feedback.descriptor, feedback.amount, feedback.school]);
    }
  }
  return lines;
}
