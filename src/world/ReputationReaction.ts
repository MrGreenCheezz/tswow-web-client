import { PacketReader } from "../protocol/PacketReader.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "./FactionRules.js";

/*
 * L15 5.05: the player's standing with a faction that keeps a reputation, as the 3.3.5a client keeps
 * and reads it — Wow.exe 12340, Ghidra read-only (.runtime/re-2026-10-04/l15-combat/g1.c;
 * .runtime/re-2026-10-03/l1102tails-review/r1.c; 0x007251c0 in .runtime/re-2026-09-30/gw-data/r2.c).
 *
 * Wow.exe keeps one 16-byte row per reputation list id at 0x00c22b70: the Faction.dbc id (+0), the
 * flags byte (+4), the race/class base standing (+8) and the wire's standing (+0xc).
 * * The rank (0x005d0600) is base + standing: 42000 and up exalted (7), 21000 revered (6), 9000
 *   honored (5), 3000 friendly (4), 0 neutral (3), -3000 unfriendly (2), -6000 hostile (1), below that
 *   hated (0) — TrinityCore's ReputationMgr::ReputationToRank draws the same edges. A faction with no
 *   row reads neutral.
 * * At war is bit FACTION_FLAG_AT_WAR 0x2 of the flags:
 *   - SMSG_INITIALIZE_FACTIONS (0x005d2e30) stores the server's flags as they come;
 *   - SMSG_SET_FACTION_STANDING (0x005d20a0) sets it when the new rank is below unfriendly and clears
 *     it when the rank went up. The core sets it the same way (ReputationMgr.cpp:402-403) and never
 *     clears it, so the client's copy is the one that walks back;
 *   - SMSG_SET_FACTION_ATWAR (0x005d0850: u32 list id, u8 flags) copies bit 0x2 — the core never sends it;
 *   - the reputation frame's own CMSG_SET_FACTION_ATWAR flips it locally (0x005d0a10,
 *     WorldClient.setFactionAtWar).
 * * The reactions of the player and a unit whose faction keeps a reputation (0x00718b30: Faction.dbc
 *   ReputationIndex ≥ 0), unless the player carries UNIT_FLAG2_IGNORE_REPUTATION or a forced reaction
 *   names the faction (read first, 0x005d06a0): the player's view of the unit (the branch at
 *   0x007253ca) is hostile (1) while at war and friendly (4) otherwise; the unit's view of the player
 *   (0x0071f770) is the player's rank. The first is what CanAttack (0x00729740 → 0x00514050) and Tab
 *   read; both are what the right-click gate 0x00729530 reads, which talks only at neutral (3) or better.
 */

/** ReputationRank, SharedDefines.h:204-212 (the numbers 0x007251c0 and 0x005d0600 return). */
export const REP_HATED = 0;
export const REP_HOSTILE = 1;
export const REP_UNFRIENDLY = 2;
export const REP_NEUTRAL = 3;
export const REP_FRIENDLY = 4;
export const REP_HONORED = 5;
export const REP_REVERED = 6;
export const REP_EXALTED = 7;

/** FACTION_FLAG_AT_WAR, ReputationMgr.h:38. */
export const FACTION_FLAG_AT_WAR = 0x02;

/** 0x005d0600: the rank of a total standing (base + the wire's standing). */
export function reputationRank(total: number): number {
  if (total >= 42_000) return REP_EXALTED;
  if (total >= 21_000) return REP_REVERED;
  if (total >= 9_000) return REP_HONORED;
  if (total >= 3_000) return REP_FRIENDLY;
  if (total >= 0) return REP_NEUTRAL;
  if (total >= -3_000) return REP_UNFRIENDLY;
  if (total >= -6_000) return REP_HOSTILE;
  return REP_HATED;
}

/**
 * 0x005d20a0 for one row of SMSG_SET_FACTION_STANDING: the flags after the standing moved from
 * `oldTotal` to `newTotal` (both with the base) — at war below unfriendly, peace when the rank rose.
 * (Wow.exe also marks a row that is neither visible nor hidden visible here; that bit is left to
 * SMSG_SET_FACTION_VISIBLE, which the core sends with every such change.)
 */
export function factionFlagsAfterStanding(flags: number, oldTotal: number, newTotal: number): number {
  const before = reputationRank(oldTotal);
  const after = reputationRank(newTotal);
  if (after < REP_UNFRIENDLY) return flags | FACTION_FLAG_AT_WAR;
  if (before < after) return flags & ~FACTION_FLAG_AT_WAR;
  return flags;
}

/** 0x005d0850: the flags after SMSG_SET_FACTION_ATWAR — only its bit 0x2 is copied. */
export function factionFlagsAfterAtWar(flags: number, wireFlags: number): number {
  return (wireFlags & FACTION_FLAG_AT_WAR) !== 0 ? flags | FACTION_FLAG_AT_WAR : flags & ~FACTION_FLAG_AT_WAR;
}

/** SMSG_SET_FACTION_ATWAR (0x313) as 0x005d0850 reads it: the list id and the flags byte. */
export function parseSetFactionAtWar(payload: Uint8Array): { listId: number; flags: number } {
  const reader = new PacketReader(payload);
  const listId = reader.u32();
  const flags = reader.u8();
  return { listId, flags };
}

/** The ranks in this client's three reactions, as a forced reaction is read: hostile ≤ 1, friendly ≥ 4. */
export function reactionOfRank(rank: number): number {
  return rank <= REP_HOSTILE ? REACTION_HOSTILE : rank >= REP_FRIENDLY ? REACTION_FRIENDLY : REACTION_NEUTRAL;
}

/**
 * The ranks as 0x00729530 judges them: it talks at neutral (3) or better, so an unfriendly rank (2)
 * — a forced Unfriendly, a player at -3000..-1 — refuses like a hostile one.
 */
export function interactionReactionOfRank(rank: number): number {
  return rank < REP_NEUTRAL ? REACTION_HOSTILE : rank >= REP_FRIENDLY ? REACTION_FRIENDLY : REACTION_NEUTRAL;
}

/** One Faction.dbc reputation row of the `/dbc/reputation` catalog (the parts read here). */
export interface ReputationBaseRow {
  readonly factionId: number;
  readonly raceMasks?: readonly number[];
  readonly classMasks?: readonly number[];
  readonly bases?: readonly number[];
}

/**
 * The base standing Faction.dbc gives a race and class: the first of the row's four entries whose
 * race mask holds the race (or is empty with a class mask) and whose class mask holds the class or is
 * empty (ReputationMgr::GetBaseReputation, ReputationMgr.cpp:97). 0 for no match — the rule of
 * FrameXmlReputationResolver.frameXmlReputationBase and Repair.ts, kept here for the world's use.
 */
export function reputationBaseFor(row: ReputationBaseRow | undefined, race: number, playerClass: number): number {
  if (!row) return 0;
  const raceMask = race > 0 ? 1 << (race - 1) : 0;
  const classMask = playerClass > 0 ? 1 << (playerClass - 1) : 0;
  for (let index = 0; index < 4; index++) {
    const races = row.raceMasks?.[index] ?? 0;
    const classes = row.classMasks?.[index] ?? 0;
    if (((races & raceMask) !== 0 || (races === 0 && classes !== 0))
      && ((classes & classMask) !== 0 || classes === 0)) return row.bases?.[index] ?? 0;
  }
  return 0;
}

/** The `/dbc/reputation` catalog: Faction.dbc rows by reputation list id. */
export interface ReputationRowCatalog {
  readonly factions: Readonly<Record<string, ReputationBaseRow>>;
}

/** Faction.dbc id → list id, once per catalog object (read on a click or a hover, never rebuilt). */
const listIds = new WeakMap<ReputationRowCatalog, ReadonlyMap<number, number>>();

/** The reputation list id Faction.dbc gives a faction (its ReputationIndex), undefined for none. */
export function reputationListIdOf(catalog: ReputationRowCatalog, factionId: number): number | undefined {
  let map = listIds.get(catalog);
  if (map === undefined) {
    const built = new Map<number, number>();
    for (const key in catalog.factions) {
      const id = catalog.factions[key]?.factionId;
      const listId = Number(key);
      if (id !== undefined && Number.isInteger(listId) && listId >= 0) built.set(id, listId);
    }
    map = built;
    listIds.set(catalog, map);
  }
  return map.get(factionId);
}

/**
 * Where the world client learns a list id's base standing for the player when a standing update comes
 * (the race/class row lives in the browser's catalog). The browser registers it (game/Targeting.ts);
 * undefined — no catalog, no player — leaves the at-war bit as it was.
 */
let baseSource: ((listId: number) => number | undefined) | undefined;

export function setReputationBaseSource(source: ((listId: number) => number | undefined) | undefined): void {
  baseSource = source;
}

export function reputationBaseOf(listId: number): number | undefined {
  return baseSource?.(listId);
}
