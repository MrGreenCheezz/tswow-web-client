import { globalString } from "../../generated/globalStrings.js";
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";

/**
 * What a spell description says, once its markers have been worked out.
 *
 * A `Spell.dbc` description is not a sentence — it is a template. «Наносит противнику $s1 ед.
 * урона от магии льда» is what 22,599 of the 31,749 spells with a Russian description look like,
 * and until now every one of them reached the tooltip with the `$s1` still in it, because nothing
 * in this client had ever read a marker.
 *
 * DOM-free on purpose, like `ChatLink` and `EmoteRules`: this is the half with the grammar in it
 * and it has to be testable without a page.
 *
 * **What is deliberately left alone.** A marker this does not understand is returned untouched
 * rather than blanked. `$<name>` reads a row of `SpellDescriptionVariables` when the optional DBC
 * table is present; `$?a1234[…][…]` is a conditional on an aura the client cannot see;
 * `$12345s1` names another spell's effect and is left alone until that row is fetched into the live
 * context. Leaving them visible is ugly and honest; deleting them would turn "$s1 damage" into
 * "damage" and read as a finished sentence.
 */

/** `MAX_SPELL_EFFECTS`. Every effect column of the table is three wide. */
const EFFECTS = 3;

/** Milliseconds in the units a duration is written in. */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The fields of a spell this needs. A subset, so a test does not have to build a whole row. */
export type SpellNumbers = Pick<SpellMetadata,
  "effectBasePoints" | "effectDieSides" | "effectPeriod" | "effectChainTargets"
  | "effectRadius" | "duration" | "maxDuration" | "procChance">
  & Partial<Pick<SpellMetadata, "id" | "descriptionVariables">>;

/** Values that are only known for the unit whose tooltip is open. */
export interface SpellDescriptionContext {
  /** Other spell rows referenced by `$12345s1`/`$12345d`. */
  spells?: ReadonlyMap<number, SpellNumbers>;
  /** Built-in WoW formula values such as AP, SPH and MWS. */
  values?: Readonly<Record<string, number>>;
}

/** How long, in the words the client's own `GlobalStrings.lua` uses for it. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return "";
  const write = (name: string, fallback: string, value: number): string => {
    const template = globalString(name);
    // `%d` is Lua's, and the only substitution these four strings carry.
    return template ? template.replace("%d", String(value)) : `${value} ${globalString(fallback) || ""}`.trim();
  };
  if (milliseconds >= DAY && milliseconds % DAY === 0) return write("INT_SPELL_DURATION_DAYS", "DAYS", milliseconds / DAY);
  if (milliseconds >= HOUR && milliseconds % HOUR === 0) return write("INT_SPELL_DURATION_HOURS", "HOURS", milliseconds / HOUR);
  if (milliseconds >= MINUTE && milliseconds % MINUTE === 0) return write("INT_SPELL_DURATION_MIN", "MINUTES", milliseconds / MINUTE);
  // Seconds, rounded rather than truncated: 2,500 ms is «3 сек» on the real tooltip and not «2».
  return write("INT_SPELL_DURATION_SEC", "SECONDS", Math.round(milliseconds / SECOND));
}

/**
 * The range one effect rolls.
 *
 * The table stores the roll rather than the result: an effect gives `EffectBasePoints + 1` to
 * `EffectBasePoints + EffectDieSides`. Fireball rank 1 is 13 and 9 in the file and 14 to 22 on
 * the tooltip, which is the whole reason a description cannot simply print the stored number.
 */
export function effectRange(spell: SpellNumbers, effect: number): { min: number; max: number } {
  if (effect < 0 || effect >= EFFECTS) return { min: 0, max: 0 };
  const base = spell.effectBasePoints[effect] ?? 0;
  const sides = spell.effectDieSides[effect] ?? 0;
  return { min: Math.abs(base + 1), max: Math.abs(base + Math.max(1, sides)) };
}

/** How many times a periodic effect fires over the spell's own duration. At least one. */
export function effectTicks(spell: SpellNumbers, effect: number): number {
  const period = spell.effectPeriod[effect] ?? 0;
  if (period <= 0 || spell.duration <= 0) return 1;
  return Math.max(1, Math.floor(spell.duration / period));
}

/** One effect's number, as a word: a single value, or a range with an en dash. */
function amount(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

/**
 * A `$`-marker, resolved against the spell it belongs to, or `undefined` when it is not one of
 * the ones this understands.
 *
 * `letter` is the marker, `effect` the 1-based index that follows it where one does.
 */
function marker(letter: string, effect: number, spell: SpellNumbers): string | undefined {
  const index = effect - 1;
  const range = effectRange(spell, index);
  switch (letter) {
    // The value an effect gives. `$s` is the one the table uses most — 17,675 descriptions.
    case "s": case "S": return amount(range.min, range.max);
    case "m": return String(range.min);
    case "M": return String(range.max);
    // Everything a periodic effect adds up to over its own duration.
    case "o": case "O": {
      const ticks = effectTicks(spell, index);
      return amount(range.min * ticks, range.max * ticks);
    }
    // How often it ticks, in seconds.
    case "t": case "T": {
      const period = spell.effectPeriod[index] ?? 0;
      return period > 0 ? String(period / SECOND) : undefined;
    }
    case "a": case "A": {
      const radius = spell.effectRadius[index] ?? 0;
      return radius > 0 ? String(Math.round(radius)) : undefined;
    }
    case "x": {
      const targets = spell.effectChainTargets[index] ?? 0;
      return targets > 0 ? String(targets) : undefined;
    }
    case "h": return String(spell.procChance);
    // How long the whole spell lasts. Written without an index in every description that has it.
    case "d": return formatDuration(spell.duration) || undefined;
    case "D": return formatDuration(spell.maxDuration || spell.duration) || undefined;
    default: return undefined;
  }
}

function spellFor(id: number | undefined, spell: SpellNumbers,
  context: SpellDescriptionContext | undefined): SpellNumbers | undefined {
  if (id === undefined) return spell;
  if (spell.id === id) return spell;
  return context?.spells?.get(id);
}

function variableDefinitions(spell: SpellNumbers): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of (spell.descriptionVariables ?? "").split(/\r?\n/)) {
    const match = line.match(/^\$([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) result.set(match[1]!.toUpperCase(), match[2]!);
  }
  return result;
}

function numeric(value: number | undefined): string | undefined {
  return value !== undefined && Number.isFinite(value) ? String(value) : undefined;
}

/** Resolves one named operand in a `${...}` formula. */
function formulaName(name: string, spell: SpellNumbers, context: SpellDescriptionContext | undefined,
  definitions: ReadonlyMap<string, string>, resolving: Set<string>): string | undefined {
  const upper = name.toUpperCase();
  const values = context?.values;
  if (values) {
    const key = Object.keys(values).find((candidate) => candidate.toUpperCase() === upper);
    const direct = numeric(key === undefined ? undefined : values[key]);
    if (direct !== undefined) return direct;
  }
  // `$s1` and friends are legal operands too. A range/duration is deliberately not numeric.
  if (/^[smMotxhaAdD]$/i.test(name)) {
    const resolved = marker(name, 1, spell);
    return resolved !== undefined && /^-?\d+(\.\d+)?$/.test(resolved) ? resolved : undefined;
  }
  const source = definitions.get(upper);
  if (source === undefined || resolving.has(upper) || source.includes("$?")) return undefined;
  resolving.add(upper);
  // SpellDescriptionVariables stores named formulas as `$name=${...}`. The braces delimit the
  // description token; they are not part of the arithmetic grammar accepted by `evaluate`.
  const expression = source.trim().match(/^\$\{([\s\S]*)\}$/)?.[1] ?? source;
  const result = evaluate(expression, spell, context, definitions, resolving);
  resolving.delete(upper);
  return result;
}

/**
 * `${…}` — a small arithmetic expression over the same markers, evaluated rather than shown.
 *
 * 1,712 descriptions carry one. Deliberately narrow: digits, the four operators, brackets and
 * markers, and nothing else. Anything with a name, a comparison or a nested `$?` in it is left as
 * it stands, because a wrong number in a tooltip is worse than a visible marker.
 */
function evaluate(expression: string, spell: SpellNumbers, context?: SpellDescriptionContext,
  definitions: ReadonlyMap<string, string> = variableDefinitions(spell),
  resolving = new Set<string>()): string | undefined {
  const substituted = expression.replace(/\$<([A-Za-z][A-Za-z0-9_]*)>|\$(\d+)([A-Za-z])(\d?)|\$([A-Za-z]+)(\d?)/g,
    (whole, named: string | undefined, spellId: string | undefined,
      spellLetter: string | undefined, spellEffect: string,
      letters: string | undefined, digits: string) => {
      const name = named ?? letters!;
      // `$s1` is an effect marker; `$MWS`/`$AP` are built-in named operands.
      const resolved = named !== undefined
        ? formulaName(name, spell, context, definitions, resolving)
        : spellId !== undefined
          ? (() => {
            const source = spellFor(Number(spellId), spell, context);
            return source ? marker(spellLetter!, spellEffect ? Number(spellEffect) : 1, source) : undefined;
          })()
        : /^[a-zA-Z]$/.test(name) && digits
          ? marker(name, Number(digits), spell)
          : formulaName(name, spell, context, definitions, resolving);
      // A range is not a number and cannot go into arithmetic; neither can a duration in words.
      return resolved !== undefined && /^-?\d+(\.\d+)?$/.test(resolved) ? resolved : whole;
    });
  if (!/^[\d\s+\-*/().]+$/.test(substituted)) return undefined;
  try {
    // No identifiers survived the test above, so there is nothing here but arithmetic.
    const value = Function(`"use strict"; return (${substituted});`)() as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return String(Math.round(value * 100) / 100);
  } catch {
    return undefined;
  }
}

/**
 * A description with its markers filled in.
 *
 * The text is split on its `${…}` blocks and the two halves are treated differently, which is not
 * tidiness — it is the only way to keep a half-answered expression off the screen. Frostbolt's
 * «${$m2*$<mult>}» cannot be worked out, because `$<mult>` names a table this build does not have;
 * substituting the `$m2` inside it anyway would leave «${18*$<mult>}», which is neither an answer
 * nor the marker the artist wrote. A block that cannot be evaluated is therefore left exactly as
 * it stands, markers and all, and only the prose around it is filled in.
 */
export function formatSpellDescription(text: string, spell: SpellNumbers | undefined,
  context: SpellDescriptionContext = {}): string {
  if (!text) return "";
  if (!spell) return text;

  // A few custom rows use the legacy `$1{...}` spelling for an expression. It is the same
  // formula block as `${...}` with an effect prefix; accepting it keeps the literal marker out of
  // the tooltip without changing ordinary `$s1` effect markers.
  text = text.replace(/\$\d+\{/g, "${");

  /** The last number written out, which is what a plural has to agree with. */
  let last = 0;

  const definitions = variableDefinitions(spell);
  const fill = (part: string): string => part
    // `$12345s1` and `$12345d` refer to another Spell.dbc row. The current row is a valid
    // resolver too (`$21084d` is how Seal of Righteousness stores its own duration).
    .replace(/\$(\d+)([a-zA-Z])(\d?)/g,
      (whole, spellId: string, letter: string, effect: string) => {
        const source = spellFor(Number(spellId), spell, context);
        if (!source) return whole;
        const resolved = marker(letter, effect ? Number(effect) : 1, source);
        if (resolved === undefined) return whole;
        const number = Number(resolved.split("–")[0]);
        if (Number.isFinite(number)) last = number;
        return resolved;
      })
    .replace(/\$<([A-Za-z][A-Za-z0-9_]*)>/g,
      (whole, name: string) => formulaName(name, spell, context, definitions, new Set())
        ?? (context.values ? "значение зависит от характеристик" : whole))
    // Named built-ins may occur outside arithmetic in a few localized rows. Keep the one-letter
    // effect grammar above separate so `$s1` is not mistaken for a variable called `S1`.
    .replace(/\$([A-Za-z][A-Za-z0-9_]+)/g,
      (whole, name: string) => name.length > 1
        ? formulaName(name, spell, context, definitions, new Set()) ?? whole : whole)
    .replace(/\$(\d*)([a-zA-Z])(\d?)/g,
      (whole, spellId: string, letter: string, effect: string) => {
        if (spellId) return whole;
        const resolved = marker(letter, effect ? Number(effect) : 1, spell);
        if (resolved === undefined) return whole;
        const number = Number(resolved.split("–")[0]);
        if (Number.isFinite(number)) last = number;
        return resolved;
      });

  let result = "";
  let at = 0;
  // `matchAll(/\$\{...\}/)` stops at the first `}` and therefore cannot handle the nested
  // `${...}` blocks inside a DescriptionVariables conditional. Scan balanced braces instead.
  for (let index = 0; index < text.length;) {
    const start = text.indexOf("${", index);
    if (start < 0) break;
    let depth = 1;
    let end = start + 2;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}") depth--;
    }
    if (depth !== 0) break;
    const block = text.slice(start, end);
    result += fill(text.slice(at, start));
    const evaluated = evaluate(block.slice(2, -1), spell, context, definitions);
    result += evaluated ?? (context.values ? "значение зависит от характеристик" : block);
    at = end;
    index = end;
  }
  result += fill(text.slice(at));

  // `$l<one>:<many>;` — the plural form, chosen by the last number written out. Russian wants
  // three forms and the table gives two, so this picks the second for everything but one: that is
  // what the marker itself can express, and inventing a third would be inventing a rule.
  result = result.replace(/\$l([^:;]*):([^;]*);/gi, (_whole, one: string, many: string) =>
    (last === 1 ? one : many));

  // A line break — and only where nothing follows it. `$b1` is a different marker entirely: the
  // points an effect gains per combo point, which is what Eviscerate's five lines of
  // `${$m1+(($b1*1)+…)}` are made of. Breaking on it put newlines inside the arithmetic.
  return result.replace(/\$b(?!\d)/gi, "\n");
}
