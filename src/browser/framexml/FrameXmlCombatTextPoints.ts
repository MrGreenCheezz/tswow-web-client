/**
 * Plan item 3.01 (06.11): the COMBAT_TEXT_UPDATE messages no combat-log entry raises, as Wow.exe 3.3.5a (12340)
 * raises them (Ghidra read-only, 06.11; .runtime/re-2026-11-06/301). Each goes out after its chat line and, unlike
 * an entry's message, whoever the combat-text unit is.
 *
 * - FACTION (0x0050b8c0): (the Faction.dbc name, the delta) for a reported standing change that is not generic
 *   (FactionStandingReport.ts), of a faction whose row is known.
 * - HONOR_GAINED for SMSG_PVP_CREDIT (0x0050b6d0): without a victim, the honor once COMBATLOG_HONORAWARD has text;
 *   with one, only while the victim is a unit in sight (0x004d4db0, mask 8), the honor is at least 1 and
 *   COMBATLOG_HONORGAIN (a rank of 0 or more) or COMBATLOG_HONORGAIN_NO_RANK has text.
 * - A quest turned in (0x006d0e10): HONOR_GAINED with the honor word over ten, rounded down (0x0088b9c0 is
 *   __ftol2), when the word is above 0; then ARENA_POINTS_GAINED when the points are above 0. Wow.exe raises them
 *   once the quest's cache row is there (0x0067de90 asks for a missing one); here at once.
 */

import type { FrameXmlCombatTextMessage } from "./FrameXmlCombatTextLog.js";

/** The `FACTION_STANDING_REPORTED` a standing change raised. */
export function frameXmlFactionText(report: { readonly delta: number; readonly generic: boolean },
  name: string | undefined): FrameXmlCombatTextMessage | undefined {
  return !report.generic && report.delta !== 0 && name ? ["FACTION", name, report.delta] : undefined;
}

/** SMSG_PVP_CREDIT's message; `victimInSight` is whether the victim is a unit the client holds. */
export function frameXmlHonorCreditText(
  credit: { readonly honor: number; readonly victimGuid: bigint; readonly victimRank: number },
  victimInSight: boolean, globalString: (name: string) => string | undefined,
): FrameXmlCombatTextMessage | undefined {
  const honor = credit.honor | 0;
  if (credit.victimGuid === 0n) return globalString("COMBATLOG_HONORAWARD") ? ["HONOR_GAINED", honor] : undefined;
  if (!victimInSight || honor < 1) return undefined;
  const key = (credit.victimRank | 0) >= 0 ? "COMBATLOG_HONORGAIN" : "COMBATLOG_HONORGAIN_NO_RANK";
  return globalString(key) ? ["HONOR_GAINED", honor] : undefined;
}

/** SMSG_QUESTGIVER_QUEST_COMPLETE's messages, in order. */
export function frameXmlQuestRewardTexts(points: { readonly honorWord: number; readonly arenaPoints: number }):
  readonly FrameXmlCombatTextMessage[] {
  const messages: FrameXmlCombatTextMessage[] = [];
  if ((points.honorWord | 0) > 0) messages.push(["HONOR_GAINED", Math.floor((points.honorWord >>> 0) / 10)]);
  if ((points.arenaPoints | 0) > 0) messages.push(["ARENA_POINTS_GAINED", points.arenaPoints | 0]);
  return messages;
}
