/**
 * Plan item 3.01 (06.11): which entries of one SMSG_SET_FACTION_STANDING Wow.exe 3.3.5a (12340) reports, as its
 * handler 0x005d20a0 decides before handing them to 0x0050b8c0 (the CHAT_MSG_COMBAT_FACTION_CHANGE line and
 * COMBAT_TEXT_UPDATE("FACTION"); Ghidra read-only, 06.11). It reads the faction's flags as they were before the
 * packet changes them:
 * - a standing equal to the stored one reports nothing;
 * - FACTION_FLAG_RIVAL (0x40): every such entry, the _GENERIC line (no amount, no combat text) when the faction is
 *   also FACTION_FLAG_HIDDEN (0x4);
 * - any other faction: only the packet's first entry, and not a hidden faction.
 */

const FACTION_FLAG_HIDDEN = 0x04;
const FACTION_FLAG_RIVAL = 0x40;

/** One reported change: the list slot, the standing's delta and whether only the generic line is said. */
export interface FactionStandingReport {
  readonly listId: number;
  readonly delta: number;
  readonly generic: boolean;
}

/**
 * The report for the packet's entry `index`, or undefined; `flags` and `previous` are the slot's flags and standing
 * before the entry (0 for a slot the list never named, as Wow.exe's zeroed table holds).
 */
export function factionStandingReport(index: number, listId: number, flags: number, previous: number,
  standing: number): FactionStandingReport | undefined {
  if (standing === previous) return undefined;
  const hidden = (flags & FACTION_FLAG_HIDDEN) !== 0;
  if ((flags & FACTION_FLAG_RIVAL) === 0) {
    return index === 0 && !hidden ? { listId, delta: standing - previous, generic: false } : undefined;
  }
  return { listId, delta: standing - previous, generic: hidden };
}
