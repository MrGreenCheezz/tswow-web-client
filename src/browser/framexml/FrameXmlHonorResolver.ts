import type { WorldObjectState } from "../../world/WorldState.js";
import { readField, readShorts } from "../../world/Fields.js";

/** The type id written by the 3.3.5 object update block for a player. */
const TYPEID_PLAYER = 4;

/**
 * Honor values which the replicated 3.3.5 player fields can answer.
 *
 * The deliberately explicit `undefined` members are part of the contract: this snapshot does
 * not pretend to know a retired PvP rank, rank progress, or lifetime contribution.  In
 * particular, PLAYER_FIELD_BYTES2 is not decoded here just because it contains unrelated player
 * bits; a future HonorFrame adapter must not turn those unknown bits into a rank.
 */
export interface FrameXmlHonorSnapshot {
  readonly todayHonorableKills: number;
  readonly yesterdayHonorableKills: number;
  readonly todayContribution: number;
  readonly yesterdayContribution: number;
  readonly lifetimeHonorableKills: number;
  readonly honorCurrency: number;
  readonly arenaCurrency: number;

  /** Not represented by the authoritative fields in this client. */
  readonly lifetimeContribution: undefined;
  /** Retired PvP rank data is not replicated in a truthful form here. */
  readonly rank: undefined;
  /** Retired PvP rank-progress data is not replicated in a truthful form here. */
  readonly rankProgress: undefined;
}

const UNAVAILABLE = Object.freeze({
  lifetimeContribution: undefined,
  rank: undefined,
  rankProgress: undefined,
});

/**
 * Resolve the player's PvP/Honor update fields without filling gaps with fake zeros.
 *
 * `Player.cpp` in the local 3.3.5 reference reads `PLAYER_FIELD_KILLS` low with
 * `PAIR32_LOPART` and writes the rollover as `MAKE_PAIR32(0, kills_today)`; therefore the low
 * short is today's honorable kills and the high short is yesterday's.  `WorldState` stores every
 * update-field word as an unsigned u32, and `readShorts` preserves that low/high order.
 *
 * A complete snapshot is required because the fields are independent update words.  Until all
 * six required words (the packed KILLS word plus five scalar words) have arrived, returning a
 * partial row would force a FrameXML caller to invent the
 * missing values.  The returned object is frozen so a Lua adapter cannot mutate the cached view.
 */
export function resolveFrameXmlHonorSnapshot(
  player: WorldObjectState | undefined,
): FrameXmlHonorSnapshot | undefined {
  if (!player || player.typeId !== TYPEID_PLAYER) return undefined;

  const kills = readShorts(player, "PLAYER_FIELD_KILLS");
  const todayContribution = readField(player, "PLAYER_FIELD_TODAY_CONTRIBUTION");
  const yesterdayContribution = readField(player, "PLAYER_FIELD_YESTERDAY_CONTRIBUTION");
  const lifetimeHonorableKills = readField(player, "PLAYER_FIELD_LIFETIME_HONORABLE_KILLS");
  const honorCurrency = readField(player, "PLAYER_FIELD_HONOR_CURRENCY");
  const arenaCurrency = readField(player, "PLAYER_FIELD_ARENA_CURRENCY");
  if (
    !kills
    || todayContribution === undefined
    || yesterdayContribution === undefined
    || lifetimeHonorableKills === undefined
    || honorCurrency === undefined
    || arenaCurrency === undefined
  ) return undefined;

  // The wire fields are uint32 words. `readField` intentionally exposes raw words, so normalize
  // here at the resolver boundary; this also keeps manually constructed negative JS numbers from
  // becoming signed honor totals while preserving every 32-bit bit pattern.
  const snapshot: FrameXmlHonorSnapshot = {
    todayHonorableKills: kills[0],
    yesterdayHonorableKills: kills[1],
    todayContribution: todayContribution >>> 0,
    yesterdayContribution: yesterdayContribution >>> 0,
    lifetimeHonorableKills: lifetimeHonorableKills >>> 0,
    honorCurrency: honorCurrency >>> 0,
    arenaCurrency: arenaCurrency >>> 0,
    ...UNAVAILABLE,
  };
  return Object.freeze(snapshot);
}
