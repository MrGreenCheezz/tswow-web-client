/**
 * Macros: fifty-four slots, a name, a body, and the rules around both.
 *
 * There is no macro opcode in 3.3.5 — none at all. A macro is client state, and the server's only
 * involvement is carrying the blob in two of its eight account-data slots. Which means the storage
 * format is the client's own business, and it has to be: the retail client's layout is written by
 * closed C code, is documented by no packet, and appears in no FrameXML — `Blizzard_MacroUI.lua`
 * even has its `SaveMacros()` call commented out. Nothing on this machine could decode it. So this
 * is JSON, and macros here will not be shared with a retail client on the same account. Neither
 * are the key bindings or the window layout, which is the same trade already made.
 *
 * The three limits below are the real client's, read off its own frame definition: thirty-six
 * account macros and eighteen character ones in one flat 1-based namespace, sixteen characters of
 * name, two hundred and fifty-five of body.
 *
 * DOM-free.
 */

/** `MAX_ACCOUNT_MACROS` and `MAX_CHARACTER_MACROS` in Blizzard_MacroUI.lua. */
export const MAX_ACCOUNT_MACROS = 36;
export const MAX_CHARACTER_MACROS = 18;
export const MAX_MACROS = MAX_ACCOUNT_MACROS + MAX_CHARACTER_MACROS;
/** The macro frame is a six-wide grid. */
export const MACROS_PER_ROW = 6;
/** `letters` on the two edit boxes of Blizzard_MacroUI.xml. */
export const MACRO_NAME_LIMIT = 16;
export const MACRO_BODY_LIMIT = 255;

export interface Macro {
  /** One-based, as the client numbers them: 1..36 account, 37..54 character. */
  index: number;
  name: string;
  body: string;
}

/** Whether an index belongs to the account's shared set or to this character's own. */
export function isAccountMacro(index: number): boolean {
  return index >= 1 && index <= MAX_ACCOUNT_MACROS;
}

export function macroIndexes(accountSet: boolean): number[] {
  return accountSet
    ? Array.from({ length: MAX_ACCOUNT_MACROS }, (_, offset) => offset + 1)
    : Array.from({ length: MAX_CHARACTER_MACROS }, (_, offset) => MAX_ACCOUNT_MACROS + offset + 1);
}

export function findMacro(macros: readonly Macro[], index: number): Macro | undefined {
  return macros.find((macro) => macro.index === index);
}

/** The lowest free slot in the half the player is looking at, or nothing when it is full. */
export function nextFreeMacro(macros: readonly Macro[], accountSet: boolean): number | undefined {
  return macroIndexes(accountSet).find((index) => findMacro(macros, index) === undefined);
}

export function trimMacroName(name: string): string {
  return name.trim().slice(0, MACRO_NAME_LIMIT);
}

export function trimMacroBody(body: string): string {
  return body.slice(0, MACRO_BODY_LIMIT);
}

/**
 * A body as the lines that will be run.
 *
 * Blank lines are dropped and leading spaces trimmed, because a macro is usually written with the
 * text box's own wrapping in mind. Conditionals — `[combat]`, `[@target]`, `[mod:shift]` — are
 * **not** handled: the real client evaluates them in a restricted environment this client has no
 * equivalent of, and quietly ignoring a conditional would run the wrong half of a macro. A line
 * that carries one is refused by `macroProblems` instead.
 */
export function macroLines(body: string): string[] {
  return body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

const CONDITIONAL = /\[[^\]]*\]/;

/**
 * What is wrong with a macro, in words, or nothing.
 *
 * Said before it is saved rather than discovered when it does nothing: a macro that silently
 * skips the line it could not understand is worse than one that refuses to be written.
 */
export function macroProblems(name: string, body: string): string[] {
  const problems: string[] = [];
  if (trimMacroName(name).length === 0) problems.push("У макроса должно быть имя.");
  if (body.length > MACRO_BODY_LIMIT) {
    problems.push(`Тело длиннее ${MACRO_BODY_LIMIT} символов (${body.length}).`);
  }
  const lines = macroLines(body);
  if (lines.length === 0) problems.push("Тело пустое — макрос ничего не сделает.");
  if (lines.some((line) => CONDITIONAL.test(line))) {
    problems.push("Условия в квадратных скобках этот клиент пока не понимает — строка выполнится целиком.");
  }
  return problems;
}

/** Replaces or adds one macro, keeping the list sorted by slot. */
export function putMacro(macros: readonly Macro[], macro: Macro): Macro[] {
  const rest = macros.filter((entry) => entry.index !== macro.index);
  return [...rest, macro].sort((left, right) => left.index - right.index);
}

export function removeMacro(macros: readonly Macro[], index: number): Macro[] {
  return macros.filter((macro) => macro.index !== index);
}

/** Only the half that lives in this slot, because the two blobs are stored separately. */
export function macrosForSet(macros: readonly Macro[], accountSet: boolean): Macro[] {
  return macros.filter((macro) => isAccountMacro(macro.index) === accountSet);
}

export function parseMacros(text: string): Macro[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const macros: Macro[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const index = typeof row["index"] === "number" ? row["index"] : 0;
    if (!Number.isInteger(index) || index < 1 || index > MAX_MACROS) continue;
    macros.push({
      index,
      name: trimMacroName(typeof row["name"] === "string" ? row["name"] : ""),
      body: trimMacroBody(typeof row["body"] === "string" ? row["body"] : ""),
    });
  }
  return macros.sort((left, right) => left.index - right.index);
}

export function serialiseMacros(macros: readonly Macro[]): string {
  return JSON.stringify(macros.map((macro) => ({ index: macro.index, name: macro.name, body: macro.body })));
}

/** What a bar slot shows for a macro: four letters, the way the original client abbreviates. */
export function macroLabel(macro: Macro | undefined, index: number): string {
  const name = macro?.name.trim();
  return name && name.length > 0 ? name.slice(0, 4) : `М${index}`;
}
