import { globalString } from "../generated/globalStrings.js";

/**
 * Fills a `GlobalStrings.lua` template the way the stock client prints it, for the world layer.
 *
 * The generated table keeps each string exactly as the Lua source wrote it
 * (`tools/generate-global-strings.mjs`: "Escapes are kept verbatim"), so a template still carries
 * its Lua escapes — `SPELL_FAILED_REQUIRES_AREA` is `…в зоне \"%s\".` with the backslashes in it —
 * besides the client's own markup. In order:
 * 1. Lua escapes: `\"`, `\'`, `\\`, `\n`, `\t` and `\ddd` become the characters Lua reads;
 * 2. placeholders: `%s`, `%d`/`%i`, `%f`/`%.Nf` in turn, positional `%N$s`/`%N$d`, and `%%`;
 *    a missing argument prints nothing rather than the placeholder;
 * 3. `|3-N(word)` — a grammatical case the ruRU client declines by table — keeps the word as it
 *    is: the declension tables live in the browser (`FrameXmlDeclension.ts`), and the world layer
 *    must not reach into it;
 * 4. `|4one:few:many;` (or `|4one:other;`) takes the form that agrees with the last number
 *    written before it, by the Russian rule — one, two to four, five and up, and 11 to 14 always
 *    the third;
 * 5. `|n` is a line break.
 */
export function formatGlobalString(template: string, args: readonly (string | number)[] = []): string {
  let next = 0;
  const filled = unescapeLua(template).replace(
    /%(?:(\d+)\$)?(?:\.(\d+))?([sdif%])/g,
    (whole, position: string | undefined, precision: string | undefined, kind: string) => {
      if (kind === "%") return position === undefined && precision === undefined ? "%" : whole;
      const value = args[position === undefined ? next++ : Number(position) - 1];
      if (value === undefined) return "";
      if (kind === "s") return String(value);
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number)) return String(value);
      if (kind === "f") return number.toFixed(precision === undefined ? 6 : Number(precision));
      return String(Math.trunc(number));
    },
  );
  const declined = filled.replace(/\|3-\d+\(([^)]*)\)/g, (_whole, word: string) => word);
  const plural = declined.replace(/\|4([^:;|]*):([^:;|]*)(?::([^;|]*))?;/g,
    (_whole, one: string, few: string, many: string | undefined, offset: number, text: string) =>
      pluralForm(lastNumberBefore(text, offset), one, few, many));
  return plural.replace(/\|n/g, "\n");
}

/**
 * A named template filled with `args`, or `fallback` filled the same way when this build has no
 * generated strings (a clean checkout ships the neutral facade without them).
 */
export function formatGlobalStringByName(name: string, args: readonly (string | number)[], fallback: string): string {
  return formatGlobalString(globalString(name) ?? fallback, args);
}

/** The escapes a Lua string literal resolves when GlobalStrings.lua is loaded. L7 4.14: exported for ui/Strings.ts. */
export function unescapeLua(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(/\\(\d{1,3}|.)/g, (_whole, escape: string) => {
    if (/^\d+$/.test(escape)) return String.fromCharCode(Number(escape));
    switch (escape) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      default: return escape;
    }
  });
}

function lastNumberBefore(text: string, offset: number): number {
  const numbers = text.slice(0, offset).match(/\d+/g);
  return numbers ? Number(numbers[numbers.length - 1]) : 1;
}

function pluralForm(count: number, one: string, few: string, many: string | undefined): string {
  if (many === undefined) return count === 1 ? one : few;
  const lastTwo = Math.abs(count) % 100;
  const last = lastTwo % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}
