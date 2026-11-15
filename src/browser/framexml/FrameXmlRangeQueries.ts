/**
 * widgets5 batch 2 (15.11): world C functions the census found unanswered in the live mount too (no binding,
 * no direct registration in src) — read from Wow.exe 3.3.5a (12340), notes .runtime/re-2026-11-15/widgets5/g5.c,
 * g6.c (read-only Ghidra; behaviour described, no code copied).
 *
 * - `IsItemInRange(item, unit)` (0x0051c9c0): the item by number (`lua_isnumber`) or by an `item:` link / item-cache
 *   name (0x00709de0); its on-use spell; the player; the unit token (0x0060abf0 — a non-string fails, nothing is
 *   answered); then the same range rule as IsActionInRange (0x00809610, FrameXmlActionRange.ts): 1 in range, 0 out,
 *   nothing when the item, its spell, the player or the unit is missing or the spell cannot take the unit.
 * - `GetItemFamily(item)` (0x00510f20): the item cache record's BagFamily (+0x1b8); nothing for an uncached item.
 * - `GetShapeshiftForm(flag)` (0x0053de10 → 0x0053d4b0): 0 without a player, or with `flag` while the player's
 *   form byte is 0 (0x0071af70); otherwise the stance bar walked from its last entry down, the first entry whose
 *   aura or form is up (0x00802cb0 — the same test GetShapeshiftFormInfo's "active" answers) gives its 1-based
 *   index; none up: the count plus one when the form byte is set, else 0. `flag` is read by 0x00815500 (default 0).
 * - `IsWindowsClient()` (0x004dce40): the number 1 (the world's table 0x00ac80b0; glue has its own answer).
 *
 * Not done here (functions not read far enough): IsSpellInRange (0x00541c60 — the same range rule, but its
 * argument parser 0x00540670 decompiles with unresolved registers: slot vs. name, rank, "pet"), ItemHasRange
 * (0x00801650's range pair and 0x00482900), IsCurrentItem (0x00805fc0), IsHelpfulItem/IsHarmfulItem (0x007fe1b0),
 * GetSpellCount (0x00801770), GetCoinTextureString (0x007e7e10's text), FindSpellBookSlotByID (0x0053b4e0 answers
 * the book array's 0-based index; whether the binding adds 1 is in 0x0084e2d0's caller, read, but the book arrays
 * 0x00be6d88/0x00be7d98 are not mapped to this client's book order).
 */
import type { FrameXmlSeamBinding, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";

/** What the bindings ask of a world seam; a seam without them answers nothing. */
export interface FrameXmlRangeQuerySeam {
  itemInRange?(item: number | string, unit: string): number | undefined;
  itemFamily?(item: number | string): number | undefined;
  shapeshiftFormIndex?(flag: boolean): number;
}

/** 0x00815500 with default 0: no argument or nil false, boolean as is, number when not 0. */
function flagOf(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  return false;
}

/** The item argument as Wow.exe takes it: a number (or numeric string) truncated, else the string. */
export function frameXmlItemArgument(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return undefined;
  const number = value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : value;
}

/** 0x00709de0: an `item:` anywhere names its id; else the item cache's record of that name. */
export function frameXmlItemNamed(
  text: string, templates: ReadonlyMap<number, { readonly found?: boolean; readonly name: string }> | undefined,
): number | undefined {
  const link = text.indexOf("item:");
  if (link >= 0) {
    const id = Number.parseInt(text.slice(link + 5), 10);
    return Number.isSafeInteger(id) && id !== 0 ? id : undefined;
  }
  if (!templates) return undefined;
  const wanted = text.toLowerCase();
  for (const [entry, template] of templates) if (template.found && template.name.toLowerCase() === wanted) return entry;
  return undefined;
}

/** 0x0053d4b0 over the stance bar's entries (`active` per entry, in bar order). */
export function frameXmlShapeshiftFormIndex(active: readonly boolean[], formByteSet: boolean, flag: boolean): number {
  if (flag && !formByteSet) return 0;
  for (let index = active.length; index > 0; index -= 1) if (active[index - 1]) return index;
  return formByteSet ? active.length + 1 : 0;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function querySeam(seam: FrameXmlWorldSeam): FrameXmlRangeQuerySeam {
  return seam as unknown as FrameXmlRangeQuerySeam;
}

export const FRAMEXML_RANGE_QUERY_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  IsItemInRange: (seam, args) => {
    const item = frameXmlItemArgument(args[0]);
    if (item === undefined || typeof args[1] !== "string") return NOTHING;
    const answer = querySeam(seam).itemInRange?.(item, args[1]);
    return answer === undefined ? NOTHING : [answer];
  },
  GetItemFamily: (seam, args) => {
    const item = frameXmlItemArgument(args[0]);
    const family = item === undefined ? undefined : querySeam(seam).itemFamily?.(item);
    return family === undefined ? NOTHING : [family];
  },
  GetShapeshiftForm: (seam, args) => [querySeam(seam).shapeshiftFormIndex?.(flagOf(args[0])) ?? 0],
  IsWindowsClient: () => [1],
});
