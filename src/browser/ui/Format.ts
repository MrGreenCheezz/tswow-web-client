/**
 * Turning numbers into the words the interface shows.
 *
 * Kept apart from the panels because a panel imports the DOM handles and cannot be loaded outside
 * a browser at all, and these are exactly the parts worth testing: thresholds, rounding, plurals.
 */

/** Copper as the server counts it, in gold, silver and copper. */
export function formatMoney(copper: number): string {
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const bronze = copper % 100;
  // The trailing copper is dropped once there is silver above it, the way the original client
  // drops it: "12з 40с" rather than "12з 40с 0м".
  const parts = [gold ? `${gold}з` : "", silver ? `${silver}с` : "", bronze || !copper ? `${bronze}м` : ""];
  return parts.filter(Boolean).join(" ");
}

/** Seconds as the played-time packet counts them. */
export function formatPlayed(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days} д ${hours} ч` : hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

/**
 * Reputation ranks by the standing the server sends. The thresholds are the client's own; a
 * faction whose base standing is not zero — a few of the racial ones — will read one rank out
 * until `Faction.dbc` is loaded and its base can be added back.
 */
const REPUTATION_RANKS: ReadonlyArray<readonly [number, string]> = [
  [42_000, "Превознесение"], [21_000, "Почтение"], [9_000, "Уважение"], [3_000, "Дружелюбие"],
  [0, "Нейтралитет"], [-3_000, "Недружелюбие"], [-6_000, "Враждебность"], [-42_000, "Ненависть"],
];

export function reputationRank(standing: number): string {
  return REPUTATION_RANKS.find(([threshold]) => standing >= threshold)?.[1] ?? "Ненависть";
}

/**
 * The same eight words by rank number rather than by standing.
 *
 * An item's `RequiredReputationRank` is a `ReputationRank` — 0 is hated, 7 is exalted — and the
 * table above is written the other way round, best first, because that is the order a threshold
 * search wants. One subtraction rather than a second copy of the words.
 */
export function reputationRankName(rank: number): string {
  return REPUTATION_RANKS[REPUTATION_RANKS.length - 1 - rank]?.[1] ?? "Ненависть";
}

/**
 * How long ago something happened, from a count of seconds.
 *
 * The guild logs carry a duration rather than a timestamp — the server subtracts before writing —
 * so this needs no agreement about clocks between the two sides.
 */
export function formatAgo(seconds: number): string {
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} д назад`;
}

/**
 * What to call something whose row has not arrived.
 *
 * The interface printed four different things for this — `Spell 1234`, `Item 4306`, `предмет 4306`
 * and a bare `#1234` — three of them in English, in an interface that is otherwise entirely
 * Russian. A player cannot tell an untranslated label from a missing one, so there is one.
 */
export function unknownLabel(kind: "заклинание" | "предмет" | "задание" | "фракция", id: number): string {
  const capital = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${capital} ${id}`;
}
