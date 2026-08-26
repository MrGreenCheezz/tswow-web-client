/**
 * The combat log as a history rather than as eight lines over the world.
 *
 * The overlay in `CombatLog.ts` shows the last eight lines and drops the rest, and it shows only
 * swings the player dealt or took — in a crowded place the alternative buries the two that matter.
 * A tab wants the opposite: everything, kept, scrollable. Both want the same sentence, so the
 * sentence is written here and both read it.
 *
 * Free of the DOM: this is the part that decides what a hit is called, and it is worth testing.
 */

import {
  VICTIMSTATE_DEFLECTS, VICTIMSTATE_DODGE, VICTIMSTATE_EVADES, VICTIMSTATE_IMMUNE,
  VICTIMSTATE_INTERRUPT, VICTIMSTATE_PARRY, type AttackerState, HITINFO_CRITICAL, HITINFO_CRUSHING,
  HITINFO_GLANCING, HITINFO_MISS,
} from "../../world/CombatProtocol.js";

/** `EnviromentalDamage`, in the server's own order. */
export const ENVIRONMENT_NAMES: Readonly<Record<number, string>> = {
  0: "Истощение", 1: "Утопление", 2: "Падение", 3: "Лава", 4: "Слизь", 5: "Огонь",
};

/** What the target did about a swing, when it did not simply take it. */
export const AVOIDED: Readonly<Record<number, string>> = {
  [VICTIMSTATE_DODGE]: "уклонение",
  [VICTIMSTATE_PARRY]: "парирование",
  [VICTIMSTATE_INTERRUPT]: "прервано",
  [VICTIMSTATE_EVADES]: "цель уклоняется",
  [VICTIMSTATE_IMMUNE]: "иммунитет",
  [VICTIMSTATE_DEFLECTS]: "отражено",
  // `VICTIMSTATE_BLOCKS` is deliberately absent: a block is partial, the swing still lands, and
  // how much it took off is already said by the `блок N` mark below.
};

export interface CombatLogEntry {
  readonly at: number;
  readonly text: string;
  /** The CSS class: `dealt`, `taken`, `crit`, `avoided`, `reward` or `muted`. */
  readonly kind: string;
  readonly casterGuid: bigint;
  readonly targetGuid: bigint;
  readonly spellId: number;
}

/** Long enough to scroll back through a fight, capped the same way the chat backlog is. */
export const COMBAT_LOG_HISTORY = 500;

export function pushCombatEntry(list: CombatLogEntry[], entry: CombatLogEntry): void {
  list.push(entry);
  if (list.length > COMBAT_LOG_HISTORY) list.splice(0, list.length - COMBAT_LOG_HISTORY);
}

export interface SwingText {
  readonly text: string;
  readonly kind: string;
  /** The damage the victim should see rise over their head, or undefined when nothing landed. */
  readonly amount: number | undefined;
  /** What to float instead of a number: «промах», «уклонение», and the rest. */
  readonly avoided: string | undefined;
}

/**
 * One melee swing, in words.
 *
 * Deliberately has no self-filter: the overlay applies one, the tab does not. A swing between two
 * strangers reads «Кабан → Волк: 47», which is noise on screen and history in a log.
 */
export function swingText(
  swing: AttackerState, selfGuid: bigint, displayName: (guid: bigint) => string,
): SwingText {
  const dealt = swing.attacker === selfGuid;
  const taken = swing.victim === selfGuid;
  const who = dealt
    ? `${displayName(swing.victim)}: `
    : taken
      ? `${displayName(swing.attacker)} → вы: `
      : `${displayName(swing.attacker)} → ${displayName(swing.victim)}: `;

  const avoided = (swing.hitInfo & HITINFO_MISS) !== 0 ? "промах" : AVOIDED[swing.victimState];
  if (avoided) {
    return { text: `${who}${avoided}`, kind: "avoided", amount: undefined, avoided };
  }

  const marks: string[] = [];
  const critical = (swing.hitInfo & HITINFO_CRITICAL) !== 0;
  if (critical) marks.push("крит");
  if ((swing.hitInfo & HITINFO_GLANCING) !== 0) marks.push("скользящий");
  if ((swing.hitInfo & HITINFO_CRUSHING) !== 0) marks.push("сокрушающий");
  if (swing.blocked > 0) marks.push(`блок ${swing.blocked}`);
  const absorbed = swing.damages.reduce((total, entry) => total + entry.absorbed, 0);
  const resisted = swing.damages.reduce((total, entry) => total + entry.resisted, 0);
  if (absorbed > 0) marks.push(`поглощено ${absorbed}`);
  if (resisted > 0) marks.push(`сопротивление ${resisted}`);

  const detail = marks.length > 0 ? ` (${marks.join(", ")})` : "";
  const kind = critical ? "crit" : dealt ? "dealt" : taken ? "taken" : "muted";
  return { text: `${who}${swing.damage}${detail}`, kind, amount: swing.damage, avoided: undefined };
}

/** The entry a swing becomes in the tab's history. */
export function swingEntry(
  swing: AttackerState, selfGuid: bigint, displayName: (guid: bigint) => string, at: number,
): CombatLogEntry {
  const written = swingText(swing, selfGuid, displayName);
  return {
    at, text: written.text, kind: written.kind,
    casterGuid: swing.attacker, targetGuid: swing.victim, spellId: 0,
  };
}
