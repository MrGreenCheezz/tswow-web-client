/**
 * 11.10: the rules of Wow.exe 3.3.5a 12340's description parser (QuestTextParser.cpp; the marker after
 * a `$` is read by 0x00579e50, read 2026-10-11) that `SpellText.ts` needs beyond the plain markers:
 *
 * * `$/N;` and `$*N;` before a marker scale it. 0x00579e50 reads N with the client's atoi
 *   (0x0076f0d0: an optional `-`, then digits; anything else stops it, nothing at all is 0) and
 *   multiplies by it or by its reciprocal, in floats; an N of 0 leaves the factor 1. The factor
 *   reaches only `s S m M o O e f F`: «на $/1000;S1 сек.» is a talent's 500 ms written in seconds,
 *   «$/10;s2 ед. ярости» rage in tenths. On every other marker the prefix is read and ignored.
 *   12.10: a negative N is a negative factor, as atoi gives it (11.10 left it as written; stock
 *   Spell.dbc has none, 19 different positive ones over 654 markers).
 * * The number those six write: the scaled |min| and |max| are «whole» when within 0.001 of an
 *   integer (0x009e1134), and a whole one is written `%d` (0x009e289c) of the integer it is near;
 *   one that is not is written `%.1f` (0x00a116ec) by `m`, `M` and a single `S`, and by `s`/`o` as the
 *   integer below it (0x00577370). A range of two values: `%d - %d` (INT_SPELL_POINTS_SPREAD_TEMPLATE)
 *   or, for `S` with a fraction, `%.1f - %.1f` (SPELL_POINTS_SPREAD_TEMPLATE) — this client writes its
 *   ranges with the en dash `SpellText.ts` has always used, so only the numbers follow Wow.exe here.
 * * The number a plural agrees with (the global 0x00beb660): the maximum of a range, the minimum for
 *   `m`, and 2 for a value with a fraction.
 * * `$l<form>:<form>…;` picks a form by 0x00817d10's rule, which 0x00405dd0 sets from the index of
 *   the client's locale in its nine-entry table (0x00ad2fe0): 1, 2, 4 and 5 count «n > 1», 8 the
 *   three Russian forms (11-14 → 2, last digit 1 → 0, 2-4 → 1, else 2), the rest «n ≠ 1». The table's
 *   strings were not dumped; its order is taken as the client's locale order (enUS koKR frFR deDE
 *   zhCN zhTW esES esMX ruRU — the order of every locstring column), which makes 8 ruRU and 2 frFR.
 *   Past the last form written, the last one (0x00576ef0).
 */

/** 0x009e1134: how close to an integer a value must be to be written as one. */
const WHOLE_EPSILON = Math.fround(0.001);

/**
 * 12.10: the client's atoi (0x0076f0d0), which the factor, a `$12345` spell id and a `$?s12345`
 * condition all read their number with: an optional `-`, then decimal digits, stopping at anything
 * else; no digit at all is 0. (No whitespace is skipped, unlike the C library's.)
 */
export function spellTextAtoi(text: string): number {
  const negative = text.startsWith("-");
  let value = 0;
  for (let index = negative ? 1 : 0; index < text.length; index++) {
    const digit = text.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) break;
    value = (value * 10 + digit) | 0;
  }
  return negative ? -value | 0 : value;
}

/**
 * The factor a `$/N;` or `$*N;` prefix gives (0x00579e50: `(float)atoi(N)`, 1 for 0, its reciprocal
 * for `/`). 12.10: always a number — a negative N is a negative factor, as the client computes it.
 */
export function spellTextFactor(operator: string, text: string): number {
  const whole = Math.fround(spellTextAtoi(text));
  if (whole === 0) return 1;
  return operator === "/" ? Math.fround(1 / whole) : whole;
}

/** The integer 0x00579e50 writes for a non-negative value, and whether the value counts as whole. */
function rounded(value: number): { readonly integer: number; readonly whole: boolean } {
  const floor = Math.floor(value);
  const ceil = Math.ceil(value);
  const nearCeil = ceil - value < WHOLE_EPSILON;
  const whole = value - floor < WHOLE_EPSILON || nearCeil;
  return { integer: whole && nearCeil && floor !== ceil ? ceil : floor, whole };
}

/** `%.1f`, as the client's printf writes it. */
function oneDecimal(value: number): string {
  return value.toFixed(1);
}

/** What one of `s S m M o O` writes for the effect's `min`..`max`, scaled by `factor`. */
export interface SpellTextValue {
  readonly text: string;
  /** The number a following `$l` agrees with. */
  readonly plural: number;
}

export function spellTextEffectValue(letter: string, min: number, max: number, factor: number): SpellTextValue {
  const low = Math.fround(Math.abs(min) * factor);
  const high = Math.fround(Math.abs(max) * factor);
  const lo = rounded(low);
  const hi = rounded(high);
  if (letter === "m") return lo.whole ? { text: String(lo.integer), plural: lo.integer } : { text: oneDecimal(low), plural: 2 };
  const plural = hi.whole ? hi.integer : 2;
  if (letter === "M") return { text: hi.whole ? String(hi.integer) : oneDecimal(high), plural };
  if (min === max) {
    return { text: !lo.whole && letter === "S" ? oneDecimal(low) : String(lo.integer), plural };
  }
  if (lo.whole && hi.whole) return { text: `${lo.integer}–${hi.integer}`, plural };
  if (letter === "S") return { text: `${oneDecimal(low)}–${oneDecimal(high)}`, plural };
  // The integer form of a range with a fraction: the low end truncated, a fractional high end
  // raised past its integer part.
  return { text: `${Math.trunc(low)}–${hi.whole ? hi.integer : Math.trunc(high) + 1}`, plural };
}

/** 0x00ad2fe0's order, the index 0x00405dd0 gives 0x00817d00. */
const LOCALES = ["enUS", "koKR", "frFR", "deDE", "zhCN", "zhTW", "esES", "esMX", "ruRU"] as const;

/** 0x00817d10: which form of a `$l` a number takes in `locale`. */
export function spellTextPluralIndex(locale: string, count: number): number {
  const index = LOCALES.indexOf(locale as typeof LOCALES[number]);
  const n = Math.trunc(count);
  if (index === 8) {
    const hundreds = n % 100;
    if (hundreds >= 11 && hundreds <= 14) return 2;
    const last = n % 10;
    if (last === 1) return 0;
    return last >= 2 && last <= 4 ? 1 : 2;
  }
  if (index === 1 || index === 2 || index === 4 || index === 5) return n > 1 ? 1 : 0;
  return n !== 1 ? 1 : 0;
}

/**
 * 0x00576ef0: the form at `index` of `$l…;`'s colon-separated forms (`forms` is the text between the
 * `l` and the `;`), leading spaces skipped and trailing ones cut. 12.10: past the last form it walks
 * into the `;` and copies nothing — «$lсекунду:секунд;» after a 5 is empty in the client, not
 * «секунд» as 11.10 had it.
 */
export function spellTextPluralForm(forms: string, index: number): string {
  const parts = forms.split(":");
  return index < parts.length ? parts[index]!.replace(/^ +/, "").replace(/ +$/, "") : "";
}

// ---- 12.10: the rest of what 0x00579e50 writes ------------------------------------------------

/** C's `%.Nf` of a float the client passes to its printf as a double (MSVC rounds a tie away from zero, as `toFixed` does). */
export function spellTextFixed(value: number, decimals: number): string {
  return Math.fround(value).toFixed(decimals);
}

/** x87 `fistp` under the default control word, which is how 0x00579980 turns a `${…}` into the number a `$l` agrees with. */
export function spellTextRoundEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  const rounded = fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return rounded === 0 ? 0 : rounded;
}

/** 0x005773b0: a tie away from zero — the control word set to truncate around `fistp` of `x ± 0.5` (`$F`). */
export function spellTextRoundAway(value: number): number {
  const rounded = Math.trunc(value > 0 ? value + 0.5 : value - 0.5);
  return rounded === 0 ? 0 : rounded;
}

/** The units 0x0061a960, 0x0061a9e0 and 0x0061aee0 measure a time in, largest first, in milliseconds. */
const DURATION_UNITS = [
  { suffix: "DAYS", ms: 86_400_000 },
  { suffix: "HOURS", ms: 3_600_000 },
  { suffix: "MIN", ms: 60_000 },
  { suffix: "SEC", ms: 1_000 },
] as const;

/** The unit a time is written in: the largest one it reaches (0x0061a960's `<` comparisons). */
function durationUnit(milliseconds: number): typeof DURATION_UNITS[number] {
  return DURATION_UNITS.find((unit) => unit.ms === 1_000 || milliseconds >= unit.ms)!;
}

/** 0x0061a960 with the 0.01 both `$d` and `$t` pass: whether the time is whole in its own unit (float maths, reciprocal constants). */
export function spellTextWholeTime(milliseconds: number): boolean {
  const unit = durationUnit(milliseconds);
  const scaled = Math.fround(Math.fround(milliseconds) * Math.fround(1 / unit.ms));
  return scaled - Math.floor(scaled) < Math.fround(0.01);
}

/** 0x0061aee0's value in the unit: seconds and minutes by a reciprocal, hours and days by a division. */
function timeInUnit(milliseconds: number, unit: typeof DURATION_UNITS[number]): number {
  const value = Math.fround(milliseconds);
  return unit.ms >= 3_600_000 ? Math.fround(value / unit.ms) : Math.fround(value * Math.fround(1 / unit.ms));
}

/**
 * The ruRU client's own lines (GlobalStrings.lua 4288-4291, 6933-6937), for a checkout whose generated
 * table predates them: since 12.10 the generator takes the four `SPELL_DURATION_*` templates by name
 * too (`npm run strings:generate`). The generated string, when there is one, wins (Spellbook.ts's
 * STOCK_SPELL_STRINGS idiom).
 */
const DURATION_STRINGS: Readonly<Record<string, string>> = {
  INT_SPELL_DURATION_DAYS: "%d д", INT_SPELL_DURATION_HOURS: "%d ч",
  INT_SPELL_DURATION_MIN: "%d мин", INT_SPELL_DURATION_SEC: "%d сек",
  SPELL_DURATION_DAYS: "%.2f д", SPELL_DURATION_HOURS: "%.2f ч",
  SPELL_DURATION_MIN: "%.2f мин", SPELL_DURATION_SEC: "%.2f сек",
  SPELL_DURATION_UNTIL_CANCELLED: "до отмены", // :6937
};

/** A duration string: the generated GlobalStrings entry, else the client's own line above. */
export function spellTextDurationString(name: string, lookup: (name: string) => string | undefined): string {
  return lookup(name) ?? DURATION_STRINGS[name] ?? "";
}

/**
 * `$d`/`$D` as 0x00579e50 writes the milliseconds 0x00800a70 gives: below 1, SPELL_DURATION_UNTIL_CANCELLED;
 * whole in its unit (0x0061a960), INT_SPELL_DURATION_<unit> with the count 0x0061a9e0 divides out
 * (truncating; its 60-minute and 24-hour rollovers are out of reach of these thresholds); otherwise
 * SPELL_DURATION_<unit> with the float 0x0061aee0 works out, `%.2f` — 90 s is «1.50 мин», 2.5 s «2.50 сек».
 */
export function spellTextDuration(milliseconds: number, lookup: (name: string) => string | undefined): string {
  if (milliseconds < 1) return spellTextDurationString("SPELL_DURATION_UNTIL_CANCELLED", lookup);
  const unit = durationUnit(milliseconds);
  if (spellTextWholeTime(milliseconds)) {
    const count = Math.floor(milliseconds / unit.ms);
    return spellTextDurationString(`INT_SPELL_DURATION_${unit.suffix}`, lookup).replace("%d", String(count));
  }
  const scaled = Math.max(0, timeInUnit(milliseconds, unit));
  return spellTextDurationString(`SPELL_DURATION_${unit.suffix}`, lookup).replace("%.2f", spellTextFixed(scaled, 2));
}

/**
 * `$t` as 0x00579e50 writes a period in milliseconds: `%d` of the whole seconds when the period is
 * whole in its unit (0x0061a960 with 0.01), else `%.2f` of the seconds (the format at 0x00a11670) —
 * a 1.5 s tick is «1.50».
 */
export function spellTextPeriod(milliseconds: number): string {
  if (spellTextWholeTime(milliseconds)) return String(Math.trunc(milliseconds / 1000));
  return spellTextFixed(Math.fround(milliseconds * Math.fround(0.001)), 2);
}
