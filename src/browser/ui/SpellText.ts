import { globalString } from "../../generated/globalStrings.js";
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { clientLocale } from "../Environment.js";
import {
  spellTextAtoi, spellTextDuration, spellTextEffectValue, spellTextFactor, spellTextFixed, spellTextPeriod,
  spellTextPluralForm, spellTextPluralIndex, spellTextRoundAway, spellTextRoundEven,
} from "./SpellTextWowRules.js"; // 11.10
import { spellConditionBranch } from "./SpellTextCondition.js"; // 12.10
import { evaluateSpellExpression, type SpellExpressionEnvironment, type SpellTextRecord } from "./SpellTextExpression.js"; // 12.10
import { spellTextCastSpeed, spellTextPlayerSex, type SpellTextPlayer } from "./SpellTextPlayer.js"; // 12.10
import { spellTextBlock, spellTextVariable, spellTextVariables, type SpellTextVariable } from "./SpellTextVariables.js"; // 12.10

/**
 * What a spell description says, once its markers have been worked out.
 *
 * A `Spell.dbc` description is not a sentence — it is a template. «Наносит противнику $s1 ед.
 * урона от магии льда» is what 22,599 of the 31,749 spells with a Russian description look like.
 *
 * DOM-free on purpose, like `ChatLink` and `EmoteRules`: this is the half with the grammar in it
 * and it has to be testable without a page.
 *
 * 12.10: the whole of Wow.exe 3.3.5a 12340's description writer (QuestTextParser.cpp, read
 * 2026-10-11/12), not a subset of it. 0x0057abc0 builds the `$<name>` table from the spell's
 * SpellDescriptionVariables row (SpellTextVariables.ts), then 0x0057aaf0 copies the text up to each
 * `$` and hands the rest to 0x00579e50, which reads `${…}` (SpellTextExpression.ts), `$<name>`, an
 * optional `$/N;`/`$*N;` factor, an optional spell id, the marker letter and its effect digit; `$?`
 * goes to 0x00579ba0 (SpellTextCondition.ts) and the chosen branch is written by 0x0057aaf0 again.
 * Over the base dataset every marker now has the client's answer (the census in the 12.10 report).
 *
 * **When the client itself gives up.** A marker 0x00579e50 cannot read — a letter it has no case
 * for (`$%`, `$ `), a spell id its Spell.dbc lacks (`$4187s1`), a factor written after the id
 * (`$45548/5;s1`), an undefined `$<name>`, a `${…}` that fails — makes 0x0057aaf0 write `$` and go
 * on from wherever the reading stopped. That is what the original client shows for those rows, and
 * this writes the same; the dataset's few such rows are listed in the 12.10 report.
 *
 * **When this client does not know yet.** A column an older gateway does not serve (before
 * `/dbc/spells?v=18`), or another spell's row still on its way, is not a fact the client would lack:
 * the marker is then left exactly as written, and the tooltip is redrawn when the row lands.
 */

/** `MAX_SPELL_EFFECTS`. Every effect column of the table is three wide. */
const EFFECTS = 3;

/** The fields of a spell this needs. A subset, so a test does not have to build a whole row. */
export type SpellNumbers = Pick<SpellMetadata,
  "effectBasePoints" | "effectDieSides" | "effectPeriod" | "effectChainTargets"
  | "effectRadius" | "duration" | "maxDuration" | "procChance">
  // 11.10: `$q` reads EffectMiscValue and `$r` the range; 12.10: the `v=18` columns (SpellTextRecord).
  & SpellTextRecord & Partial<Pick<SpellMetadata, "descriptionVariables" | "rangeMax">>;

/** Values that are only known for the unit whose tooltip is open. */
export interface SpellDescriptionContext {
  /** Other spell rows referenced by `$12345s1`/`$12345d`. */
  spells?: ReadonlyMap<number, SpellNumbers>;
  /**
   * 12.10: whether the gateway has answered for an id `spells` lacks (SpellMetadataClient.answered).
   * False: the row is on its way and its marker stays as written; true or absent: the client has no
   * such row, and 0x00579e50 fails on it.
   */
  answered?: (id: number) => boolean;
  /**
   * 12.10: the active player (SpellTextPlayer.ts). Absent is Wow.exe without one: every `${…}` name
   * reads 0, every `$?` term is false, `$g` fails (unless `female` says), `$c` is -1 and `$p` 0.
   */
  player?: SpellTextPlayer;
  /**
   * 11.10: the active player's sex for `$g<male>:<female>;`. 12.10: when absent, read from `player`
   * (byte 2 of UNIT_FIELD_BYTES_0, 0x00579e50).
   */
  female?: boolean;
  /** 12.10: `$z`, the AreaTable name of the hearthstone's area; absent, HOME_INN as 0x00579e50 writes it. */
  homeName?: string;
}

/**
 * How long, in the words the client's own `GlobalStrings.lua` uses for it. 12.10: exactly what `$d`
 * writes (SpellTextWowRules.ts spellTextDuration: 90 s is «1.50 мин»), and "" for nothing at all.
 */
export function formatDuration(milliseconds: number): string {
  return milliseconds <= 0 ? "" : spellTextDuration(milliseconds, globalString);
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

/** 11.10: the locale whose plural rule `$l` follows; the client's own, ruRU by default. */
function descriptionLocale(): string {
  try {
    return clientLocale();
  } catch {
    return "ruRU";
  }
}

/** SPELL_ATTR3_NO_DONE_BONUS, SPELL_ATTR5_START_PERIODIC_AT_APPLY, SPELL_ATTR5_HASTE_AFFECT_DURATION. */
const ATTR3_NO_DONE_BONUS = 0x20000000;
const ATTR5_START_PERIODIC_AT_APPLY = 0x200;
const ATTR5_HASTE_AFFECT_DURATION = 0x2000;

/** 0x00579e50's answer for one marker: what it wrote, where its reading stopped, and whether it succeeded. */
interface Marked { readonly text: string; readonly end: number; readonly ok: boolean }

/** One description being written: the spell, its `$<name>` table and the number a `$l` agrees with. */
class DescriptionWriter {
  /** DAT_00beb660: the last number a marker set for `$l`. */
  plural = 0;
  readonly locale = descriptionLocale();
  readonly variables: SpellTextVariable[];
  readonly environment: SpellExpressionEnvironment;

  constructor(readonly spell: SpellNumbers, readonly context: SpellDescriptionContext) {
    this.environment = {
      spell,
      row: (id) => this.row(id),
      ...(context.player ? { player: context.player } : {}),
      variable: (name) => spellTextVariable(this.variables, name)?.value ?? 0,
      duration: (record) => this.duration(record, true),
      cost: (record) => this.cost(record),
    };
    // 0x0057abc0: the table first, from the description's own spell, against the table so far.
    this.variables = spellTextVariables(spell.descriptionVariables, context.player, (body, table) => {
      const result = evaluateSpellExpression(body, {
        ...this.environment,
        variable: (name) => spellTextVariable(table, name)?.value ?? 0,
      });
      return result.kind === "value" ? result.value : undefined;
    });
  }

  /** Another row: this one, the map's, "pending" while the gateway has not answered, undefined when there is none. */
  row(id: number): SpellNumbers | undefined | "pending" {
    if (this.spell.id === id) return this.spell;
    const row = this.context.spells?.get(id);
    if (row) return row;
    return this.context.answered && !this.context.answered(id) ? "pending" : undefined;
  }

  /**
   * 0x00800a70: the SpellDuration row's milliseconds, capped by its MaxDuration, and — for `$d` with
   * an active player and a periodic effect — scaled by UNIT_MOD_CAST_SPEED when SPELL_ATTR5_HASTE_AFFECT_DURATION
   * is set and SPELL_ATTR3_NO_DONE_BONUS is not. Left out: DurationPerLevel and the spell modifiers
   * (columns and talent data this client does not carry), and the aura-316 path (0x007283a0).
   */
  duration(record: SpellTextRecord, hasted: boolean): number | undefined {
    if (record.duration === undefined) return undefined;
    let ms = Math.min(record.duration, record.maxDuration ?? record.duration);
    const player = this.context.player;
    if (hasted && player && (record.effectPeriod ?? []).some((period) => period !== 0)) {
      const [, , , attr3 = 0, , attr5 = 0] = record.attributes ?? [];
      const speed = spellTextCastSpeed(player);
      if ((attr5 & ATTR5_HASTE_AFFECT_DURATION) !== 0 && (attr3 & ATTR3_NO_DONE_BONUS) === 0 && speed >= Math.fround(0.001)) {
        ms = spellTextRoundEven(Math.fround(Math.fround(ms) * speed));
      }
    }
    return ms;
  }

  /**
   * 0x008012f0 for `$c`: ManaCost plus ManaCostPct of the base 0x0071b770 gives, not below 0. Left
   * out: ManaCostPerLevel, the school cost modifiers and the spell modifiers. -1 without a player.
   */
  cost(record: SpellTextRecord): number | undefined {
    const player = this.context.player;
    if (!player) return -1;
    if (record.powerCost === undefined || record.powerCostPercent === undefined) return undefined;
    let cost = record.powerCost;
    if (record.powerCostPercent !== 0) {
      const base = player.basePower?.(record.powerType ?? 0);
      if (base === undefined) return undefined;
      cost += Math.trunc((base * record.powerCostPercent) / 100);
    }
    return cost < 1 ? 0 : cost;
  }

  /** The sex `$g` uses: the context's, else the player's; undefined without either. */
  sex(): number | undefined {
    if (this.context.female !== undefined) return this.context.female ? 1 : 0;
    return this.context.player ? spellTextPlayerSex(this.context.player) : undefined;
  }

  /** 0x0057aaf0: the text with every `$` handed to 0x00579e50, a failed one written as `$`. */
  expand(text: string): { readonly out: string; readonly ok: boolean } {
    let out = "";
    let ok = true;
    let from = 0;
    for (let at = text.indexOf("$"); at >= 0; at = text.indexOf("$", from)) {
      out += text.slice(from, at);
      const marked = this.marker(text, at + 1);
      out += marked.text;
      if (!marked.ok) {
        out += "$";
        ok = false;
      }
      from = marked.end;
    }
    return { out: out + text.slice(from), ok };
  }

  /** 0x00579e50 from `start`, the character after the `$`. */
  marker(text: string, start: number): Marked {
    const fail = (end: number): Marked => ({ text: "", end, ok: false });
    // A fact this client does not have yet: the marker as written, from its `$` to its end.
    const asWritten = (end: number): Marked => ({ text: `$${text.slice(start, end)}`, end, ok: true });
    const first = text[start];
    if (first === "{") {
      const close = text.indexOf("}", start);
      if (close >= 0) return this.block(text, start, close);
    }
    if (first === "<") {
      const close = text.indexOf(">", start);
      if (close >= 0) {
        // 0x00577c40: at most 14 characters of the name, compared case-sensitively.
        const variable = spellTextVariable(this.variables, text.slice(start + 1, Math.min(close, start + 15)));
        if (!variable) return fail(start);
        this.plural = variable.rounded;
        return { text: variable.text, end: close + 1, ok: true };
      }
    }
    let at = start;
    let factor = 1;
    if ((first === "/" || first === "*") && text.indexOf(";", start) >= 0) {
      const semicolon = text.indexOf(";", start);
      factor = spellTextFactor(first, text.slice(start + 1, semicolon));
      at = semicolon + 1;
    }
    let record: SpellNumbers | undefined | "pending" = this.spell;
    const digits = /^\d*/.exec(text.slice(at))![0];
    if (digits) {
      at += digits.length;
      record = this.row(spellTextAtoi(digits));
    }
    const letter = text[at];
    const effectDigit = text.charCodeAt(at + 1) - 49;
    const indexed = effectDigit >= 0 && effectDigit < 9;
    const effect = indexed && effectDigit <= 2 ? effectDigit : 0;
    const end = at + (letter === undefined ? 0 : 1) + (indexed ? 1 : 0);
    if (record === "pending") return asWritten(end);
    if (record === undefined) return fail(at);
    const spell = record;
    const integer = (value: number | undefined, plural = true): Marked => {
      if (value === undefined) return asWritten(end);
      if (plural) this.plural = value;
      return { text: String(value), end, ok: true };
    };
    switch (letter) {
      case "?": {
        const chosen = spellConditionBranch(text, at + 1, this.context.player);
        if (!("branch" in chosen)) return { text: "", end: chosen.at, ok: true };
        const written = this.expand(chosen.branch);
        // 0x00579ba0 writes `$` after a branch that failed, and fails itself.
        return written.ok ? { text: written.out, end: chosen.after, ok: true }
          : { text: `${written.out}$`, end: chosen.after, ok: false };
      }
      case "A": case "a": {
        // The SpellRadius row's radius, truncated (0x0088b9c0), 0 with no row.
        const radius = spell.effectRadius?.[effect];
        return radius === undefined ? asWritten(end) : { text: String(Math.trunc(radius)), end, ok: true };
      }
      case "B": case "b": {
        const points = spell.effectPointsPerCombo?.[effect];
        return integer(points === undefined ? undefined : Math.trunc(points));
      }
      case "C": case "c": return integer(this.cost(spell), false);
      case "D": case "d": {
        const ms = this.duration(spell, true);
        return ms === undefined ? asWritten(end) : { text: spellTextDuration(ms, globalString), end, ok: true };
      }
      case "E": case "e": {
        const value = spell.effectMultipleValue?.[effect];
        return value === undefined ? asWritten(end)
          : { text: spellTextFixed(Math.fround(value * factor), 1), end, ok: true };
      }
      case "F": {
        const value = spell.effectDamageMultiplier?.[effect];
        return value === undefined ? asWritten(end)
          : { text: String(spellTextRoundAway(Math.fround(value * factor))), end, ok: true };
      }
      case "f": {
        const value = spell.effectDamageMultiplier?.[effect];
        return value === undefined ? asWritten(end)
          : { text: spellTextFixed(Math.fround(value * factor), 1), end, ok: true };
      }
      case "G": case "g": {
        const sex = this.sex();
        if (sex === undefined) return fail(at + 1);
        const gendered = this.gender(text, at + 1, sex);
        const after = gendered.end + (gendered.end < text.length ? 1 : 0);
        return gendered.text === undefined ? asWritten(after) : { text: gendered.text, end: after, ok: true };
      }
      case "H": case "h": return integer(spell.procChance);
      case "I": case "i": return integer(spell.maxAffectedTargets);
      case "L": case "l": return this.pluralForm(text, at + 1);
      case "M": case "O": case "S": case "m": case "o": case "s": return this.value(spell, letter, effect, factor, end);
      case "N": case "n": return integer(spell.procCharges);
      // 0x007ff100: ManaPerSecond (its per-level part and the cost modifier left out); 0 without a player.
      case "P": case "p": return integer(this.context.player ? spell.manaPerSecond : 0, false);
      case "Q": case "q": return integer(spell.effectMiscValue?.[effect]);
      // SpellRange's RangeMax[0] (+0xc), raised to the next integer (0x0050f450, 0x0088b9c0).
      case "R": case "r": return integer(spell.rangeMax === undefined ? undefined : Math.ceil(spell.rangeMax));
      case "T": case "t": {
        const period = this.period(spell, effect);
        return period === undefined ? asWritten(end) : { text: spellTextPeriod(period), end, ok: true };
      }
      case "U": case "u": return integer(spell.stackAmount);
      case "V": case "v": return integer(spell.maxTargetLevel);
      case "X": case "x": return integer(spell.effectChainTargets?.[effect]);
      // DAT_00c9d534's AreaTable name (row +0x2c), HOME_INN without one (GlobalStrings.lua:4178).
      case "Z": case "z": return { text: this.context.homeName ?? globalString("HOME_INN") ?? "ваша таверна", end, ok: true };
      default: return fail(at);
    }
  }

  /** 0x00579980: a `${…}` block, its `.N` and the number it leaves for `$l`. */
  block(text: string, start: number, close: number): Marked {
    const after = text.slice(close + 1, close + 3);
    const decimals = /^\.[1-9]/.test(after) ? 2 : 0;
    const end = close + 1 + decimals;
    const result = evaluateSpellExpression(text.slice(start + 1, close), this.environment);
    if (result.kind === "unavailable") return { text: `$${text.slice(start, end)}`, end, ok: true };
    if (result.kind === "error") return { text: "", end, ok: false };
    const written = spellTextBlock(result.value, after);
    this.plural = written.rounded;
    return { text: written.text, end, ok: true };
  }

  /**
   * `s S m M o O`: 0x007ff770's min and max (the caster-level part and spell modifiers left out), for
   * `o` times the duration over the period — a period of 0 counts as 5000 ms, SPELL_ATTR5_START_PERIODIC_AT_APPLY
   * adds one period, and no duration is 0 — then 11.10's factor and rounding rules.
   */
  value(spell: SpellNumbers, letter: string, effect: number, factor: number, end: number): Marked {
    const base = spell.effectBasePoints[effect] ?? 0;
    const sides = spell.effectDieSides[effect] ?? 0;
    let min = Math.fround(base + 1);
    let max = Math.fround(base + Math.max(1, sides));
    if (letter === "o" || letter === "O") {
      const period = (spell.effectPeriod[effect] ?? 0) === 0 ? 5000 : spell.effectPeriod[effect]!;
      const ms = period > 0 ? this.duration(spell, false) ?? 0 : 0;
      if (ms > 0) {
        const extra = ((spell.attributes?.[5] ?? 0) & ATTR5_START_PERIODIC_AT_APPLY) !== 0 ? period : 0;
        const span = Math.fround(extra + ms);
        min = Math.fround(Math.fround(min * span) / Math.fround(period));
        max = Math.fround(Math.fround(max * span) / Math.fround(period));
      } else {
        min = 0;
        max = 0;
      }
    }
    const written = spellTextEffectValue(letter, min, max, factor);
    this.plural = written.plural;
    return { text: written.text, end, ok: true };
  }

  /**
   * `$t`: 5000 ms for a spell whose ProcTypeMask has bit 0, else the effect's period (0 is written
   * «0»), hasted by UNIT_MOD_CAST_SPEED when the first periodic effect's spell has SPELL_ATTR5_HASTE_AFFECT_DURATION
   * without SPELL_ATTR3_NO_DONE_BONUS. A gateway before `v=18` (no ProcTypeMask) still answers a
   * non-zero period.
   */
  period(spell: SpellNumbers, effect: number): number | undefined {
    const mask = spell.procTypeMask;
    let period = spell.effectPeriod[effect] ?? 0;
    if (mask === undefined && period === 0) return undefined;
    if (mask !== undefined && (mask & 1) !== 0) return 5000;
    const player = this.context.player;
    const [, , , attr3 = 0, , attr5 = 0] = spell.attributes ?? [];
    if (player && spell.effectPeriod.some((value) => value !== 0)
      && (attr5 & ATTR5_HASTE_AFFECT_DURATION) !== 0 && (attr3 & ATTR3_NO_DONE_BONUS) === 0) {
      const speed = spellTextCastSpeed(player);
      if (speed >= Math.fround(0.001)) period = spellTextRoundEven(Math.fround(Math.fround(period) * speed));
    }
    return period;
  }

  /**
   * 0x00576cd0 from `from` (after the `g`): the first form for 0, the second for anything else; the
   * reading ends at the `;`. A third form whose first letter is a Latin C or R asks 0x0071a620 or
   * 0x0071a540 for the sex instead, which this does not read: no text (left as written). A form
   * list without its `:` or `;` writes nothing and leaves the reading after the spaces.
   */
  gender(text: string, from: number, sex: number): { readonly text: string | undefined; readonly end: number } {
    let at = from;
    while (text[at] === " ") at++;
    if (at >= text.length) return { text: "", end: at };
    const colon = text.indexOf(":", at);
    if (colon < 0) return { text: "", end: at };
    let second = text.indexOf(":", colon + 1);
    const semicolon = text.indexOf(";", colon);
    if (semicolon < 0) return { text: "", end: at };
    if (second >= 0 && second + 1 < semicolon) {
      if (/[CcRr]/.test(text[second + 1]!)) return { text: undefined, end: semicolon };
    } else {
      second = -1;
    }
    let form: string;
    if (sex !== 0) {
      let begin = colon + 1;
      while (text[begin] === " ") begin++;
      form = text.slice(begin, second >= 0 ? second : semicolon);
    } else {
      form = text.slice(at, colon);
    }
    return { text: form.replace(/ +$/, ""), end: semicolon };
  }

  /** 0x00576ef0 from `from` (after the `l`): the form the plural number takes; nothing without a `;`. */
  pluralForm(text: string, from: number): Marked {
    let at = from;
    while (text[at] === " ") at++;
    const semicolon = text.indexOf(";", at);
    if (at >= text.length || semicolon < 0) return { text: "", end: at, ok: true };
    const index = spellTextPluralIndex(this.locale, this.plural);
    return { text: spellTextPluralForm(text.slice(at, semicolon), index), end: semicolon + 1, ok: true };
  }
}

/**
 * 11.10: the other Spell.dbc rows a description's markers read (`$12345s1`, `$/10;29131o1`, and the
 * `$57810m1` of a SpellDescriptionVariables formula when that text is passed too), for a caller that
 * fetches rows to fetch them too.
 */
export function spellDescriptionReferences(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(/\$(?:[/*][^;$]*;)?(\d+)[a-zA-Z]/g)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * 12.10: every row a spell's description (or aura description — the description when it has none, as
 * Spellbook.stockSpellTooltip draws it) and its SpellDescriptionVariables formulas read.
 */
export function spellDescriptionRows(spell: Pick<SpellMetadata, "description"> & Partial<Pick<SpellMetadata,
  "auraDescription" | "descriptionVariables">>, aura = false): number[] {
  const text = aura && spell.auraDescription ? spell.auraDescription : spell.description;
  return spellDescriptionReferences(`${text}\n${spell.descriptionVariables ?? ""}`);
}

/** A description with its markers filled in, as Wow.exe's 0x0057abc0 writes it (see the module comment). */
export function formatSpellDescription(text: string, spell: SpellNumbers | undefined,
  context: SpellDescriptionContext = {}): string {
  if (!text) return "";
  if (!spell) return text;
  return new DescriptionWriter(spell, context).expand(text).out;
}
