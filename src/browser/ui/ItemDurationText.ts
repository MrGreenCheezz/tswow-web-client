/**
 * Plan item 5.22 (04.10, L4): a timed item's line — «Исчезнет через 2 д.», «Срок действия: 5 минут»
 * — as Wow.exe 3.3.5a 12340's item tooltip writes it (0x006277f0, read-only Ghidra 2026-10-04,
 * described here in this file's words):
 *
 * * only for a record whose Duration is above 0; the number is the item object's time left
 *   (0x007070b0: its expiry stamp less the clock, 0 once past — the stamp follows
 *   ITEM_FIELD_DURATION, which SMSG_ITEM_TIME_UPDATE and the realm's per-second update keep), or the
 *   record's own Duration when there is no object (a link, a merchant's shelf); 0 still writes one;
 * * 0x0061a9e0 in seconds, rounding up: under a minute ITEM_DURATION_SEC with the seconds; under an
 *   hour ITEM_DURATION_MIN ⌈s/60⌉, where 60 reads as one HOURS; under a day ITEM_DURATION_HOURS
 *   ⌈s/3600⌉, where 24 reads as one DAYS; else ITEM_DURATION_DAYS ⌈s/86400⌉;
 * * white, after the durability line.
 */

/** The seconds the line shows, or undefined when the item writes none. */
export function itemDurationSeconds(templateDuration: number, left: number | undefined): number | undefined {
  if (!((templateDuration | 0) > 0)) return undefined;
  return left === undefined ? templateDuration | 0 : Math.max(0, Math.trunc(left));
}

/** 0x0061a9e0(…, "ITEM_DURATION", 0, round up, seconds): the GlobalStrings key and the number. */
export function itemDurationParts(seconds: number): { readonly key: string; readonly count: number } {
  const up = (unit: number): number => Math.floor((seconds - 1) / unit) + 1;
  if (seconds >= 86400) return { key: "ITEM_DURATION_DAYS", count: up(86400) };
  if (seconds >= 3600) {
    const hours = up(3600);
    return hours === 24 ? { key: "ITEM_DURATION_DAYS", count: 1 } : { key: "ITEM_DURATION_HOURS", count: hours };
  }
  if (seconds >= 60) {
    const minutes = up(60);
    return minutes === 60 ? { key: "ITEM_DURATION_HOURS", count: 1 } : { key: "ITEM_DURATION_MIN", count: minutes };
  }
  return { key: "ITEM_DURATION_SEC", count: Math.max(0, seconds) };
}
