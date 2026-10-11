import { spellConditionBranch } from "./SpellTextCondition.js";
import type { SpellTextPlayer } from "./SpellTextPlayer.js";
import { spellTextFixed, spellTextRoundEven } from "./SpellTextWowRules.js";

/**
 * 12.10: the `$<name>` table Wow.exe builds from a spell's SpellDescriptionVariables row before it
 * writes the description (0x0057abc0 → 0x00579d60, read 2026-10-12), and the `${…}` block writer
 * both share (0x00579980).
 *
 * 0x00579d60 walks the row's text from `$` to `$`: a name is what lies between a `$` and the next
 * `=` (14 characters at most), and its value is the first `$` after the name — `${…}` is evaluated
 * at once (0x00579b30), `$?…` picks a branch (0x00579ba0 with its definition flag) and evaluates the
 * first `${…}` inside it. Anything else defines nothing: `$base=($pl-1)*3+10`, whose next `$` is the
 * `$pl`, is not a variable. A definition whose block fails leaves a nameless entry no one can find.
 * Entries are looked up in order, case-sensitively (strncmp), so the first of two equal names wins
 * and a later definition sees the earlier ones.
 */

/** One entry of the table: 0x38 bytes, name at +0, the written text at +0x10, the float at +0x30, the rounded int at +0x34. */
export interface SpellTextVariable {
  readonly name: string;
  readonly text: string;
  readonly value: number;
  readonly rounded: number;
}

/** A `${…}` block worked out: what 0x00579980 writes, the float it keeps and the int a `$l` agrees with. */
export type SpellTextBlock = { readonly text: string; readonly value: number; readonly rounded: number };

/**
 * 0x00579980's text and number: `%.0f`, or `%.Nf` when the `}` is followed by `.N` (N 1-9, two more
 * characters consumed), and the value rounded by `fistp`. `afterBrace` is the text right after the `}`.
 */
export function spellTextBlock(value: number, afterBrace: string): SpellTextBlock & { readonly consumed: number } {
  const decimals = /^\.[1-9]/.test(afterBrace) ? Number(afterBrace[1]) : 0;
  return {
    text: spellTextFixed(value, decimals), value: Math.fround(value), rounded: spellTextRoundEven(Math.fround(value)),
    consumed: decimals > 0 ? 2 : 0,
  };
}

/**
 * Builds the table. `evaluate` works out one block's body against the table so far (undefined:
 * Wow.exe's error, or a column the gateway has not served — either way the name stays undefined).
 */
export function spellTextVariables(source: string | undefined, player: SpellTextPlayer | undefined,
  evaluate: (body: string, table: readonly SpellTextVariable[]) => number | undefined): SpellTextVariable[] {
  const table: SpellTextVariable[] = [];
  if (!source) return table;
  const define = (name: string, body: string, afterBrace: string): void => {
    const value = evaluate(body, table);
    if (value === undefined) return;
    const block = spellTextBlock(value, afterBrace);
    table.push({ name, text: block.text.slice(0, 31), value: block.value, rounded: block.rounded });
  };
  let cursor = source.indexOf("$");
  while (cursor >= 0 && cursor < source.length) {
    const start = cursor + 1;
    cursor = start;
    const equals = source.indexOf("=", start);
    if (equals >= 0) {
      const name = source.slice(start, start + Math.min(equals - start, 14));
      const marker = source.indexOf("$", start);
      if (marker < 0) break;
      cursor = marker + 1;
      if (source[marker + 1] === "?") {
        const chosen = spellConditionBranch(source, marker + 2, player);
        if ("branch" in chosen) {
          cursor = chosen.after;
          // In the branch: its first `$`, the `{` after it and the `}` after that.
          const dollar = chosen.branch.indexOf("$");
          const open = dollar < 0 ? -1 : chosen.branch.indexOf("{", dollar);
          const close = open < 0 ? -1 : chosen.branch.indexOf("}", open);
          if (close >= 0) define(name, chosen.branch.slice(open + 1, close), chosen.branch.slice(close + 1, close + 3));
        } else {
          cursor = chosen.at;
        }
      } else if (source[marker + 1] === "{") {
        const close = source.indexOf("}", marker + 1);
        if (close >= 0) {
          define(name, source.slice(marker + 2, close), source.slice(close + 1, close + 3));
          cursor = close + 1;
        }
      }
    }
    cursor = source.indexOf("$", cursor);
  }
  return table;
}

/** 0x00577c40 and 0x005774d0: the first entry of that name. */
export function spellTextVariable(table: readonly SpellTextVariable[], name: string): SpellTextVariable | undefined {
  return table.find((entry) => entry.name === name);
}
