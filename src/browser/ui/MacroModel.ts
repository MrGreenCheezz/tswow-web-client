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
  /**
   * The icon's texture path, as the stock macro window picks it (`Interface\Icons\…`). Absent on
   * every macro the native window wrote, which shows the question mark; an older client reading a
   * blob with it simply drops the field, so the saved format stays readable both ways.
   */
  icon?: string;
}

/** What a macro with no icon of its own shows: GetMacroIconInfo(1) of the client's list. */
export const MACRO_DEFAULT_ICON = "Interface\\Icons\\INV_Misc_QuestionMark";
/** A stored icon is a texture path under Interface\, printable and short. */
const MACRO_ICON = /^Interface\\[\x20-\x7e]{1,200}$/i;

export function macroIcon(macro: Macro | undefined): string {
  return macro?.icon ?? MACRO_DEFAULT_ICON;
}

/** A texture path fit to store, or undefined. */
export function validMacroIcon(value: unknown): string | undefined {
  return typeof value === "string" && MACRO_ICON.test(value) ? value : undefined;
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
 * text box's own wrapping in mind. `#showtooltip` lines are display-only and skipped at run time.
 * A single `[@unit]` prefix (target/focus/self/player/pet) is allowed and resolved at run time;
 * any other `[condition]` is refused by `macroProblems` instead of silently running the wrong half.
 */
export function macroLines(body: string): string[] {
  return body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Units a macro may name with `[@unit]`. Everything else is a condition, not a target. */
export const MACRO_UNITS = new Set(["target", "focus", "self", "player", "pet", "mouseover"]);

const SHOWTOOLTIP = /^#showtooltip\b/i;
/** A `[@unit]` token anywhere in a combat line (`/cast [@target] Fireball`). */
const TARGET_TOKEN = /\[@([A-Za-z]+)\]/;

export function stripShowtooltip(line: string): string | undefined {
  return SHOWTOOLTIP.test(line) ? undefined : line;
}

export function macroTargetUnit(line: string): { unit: string; rest: string } | undefined {
  const match = line.match(TARGET_TOKEN);
  if (!match) return undefined;
  return { unit: match[1]!.toLowerCase(), rest: line.replace(match[0], " ").replace(/\s+/g, " ").trim() };
}

/** All `[@...]` tokens in a line, lowercased. */
export function macroTargetTokens(line: string): string[] {
  return [...line.matchAll(/\[@([A-Za-z]+)\]/g)].map((match) => match[1]!.toLowerCase());
}

const CONDITIONAL = /[\[\]]/;

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
  const lines = macroLines(body).filter((line) => stripShowtooltip(line) !== undefined);
  if (lines.length === 0) problems.push("Тело пустое — макрос ничего не сделает.");
  // A combat line starts with /cast or /use; the [@unit] token may sit after the command.
  const withoutTokens = (line: string): string => line.replace(/\[@[A-Za-z]+\]/g, " ");
  const combat = lines.filter((line) => /^\/(cast|use)(?:\s|$)/i.test(withoutTokens(line).trim()));
  // Only a single known [@unit] token on /cast is allowed; an item target needs a different
  // CMSG_USE_ITEM target block and cannot silently use the current selection instead.
  if (combat.some((line) => {
    const tokens = macroTargetTokens(line);
    if (tokens.length > 1 || tokens.some((token) => !MACRO_UNITS.has(token))
      || (/^\/use\b/i.test(line) && tokens.length > 0)) return true;
    return CONDITIONAL.test(withoutTokens(line));
  })) {
    problems.push("Для /cast доступна одна [@цель] (target, focus, self, player, pet, mouseover); условия и адресный /use не поддерживаются.");
  }
  if (combat.length > 1) problems.push("За одно нажатие допускается только одна команда /cast или /use.");
  if (combat.some((line) => {
    const target = macroTargetUnit(line);
    const rest = (target?.rest ?? line).trim();
    const match = rest.match(/^\/(cast|use)\s+(.+)$/i);
    if (!match) return true;
    const argument = match[2]!.trim();
    // ID or a spell/item name; names resolve at run time against the spellbook/inventory.
    // A leftover [@...] inside the argument means the token sat in an unparseable spot.
    return argument.length === 0 || argument.length > 64 || /[;\n]/.test(argument) || CONDITIONAL.test(argument);
  })) {
    problems.push("Формат боевой команды: /cast ID|Имя или /use ID|Имя, опционально [@цель].");
  }
  return problems;
}

/** Replaces or adds one macro, keeping the list sorted by slot. */
export function putMacro(macros: readonly Macro[], macro: Macro): Macro[] {
  const rest = macros.filter((entry) => entry.index !== macro.index);
  return [...rest, macro].sort((left, right) => left.index - right.index);
}

/**
 * What the native window's «Сохранить» writes: the name and body typed there, in its slot. The icon
 * is the stock window's to choose (the native one has no picker), so a save here keeps it.
 */
export function nativeMacroEdit(existing: Macro | undefined, index: number, name: string, body: string): Macro {
  return {
    index, name: trimMacroName(name), body: trimMacroBody(body),
    ...(existing?.icon === undefined ? {} : { icon: existing.icon }),
  };
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
    const icon = validMacroIcon(row["icon"]);
    macros.push({
      index,
      name: trimMacroName(typeof row["name"] === "string" ? row["name"] : ""),
      body: trimMacroBody(typeof row["body"] === "string" ? row["body"] : ""),
      ...(icon === undefined ? {} : { icon }),
    });
  }
  return macros.sort((left, right) => left.index - right.index);
}

export function serialiseMacros(macros: readonly Macro[]): string {
  return JSON.stringify(macros.map((macro) => ({
    index: macro.index, name: macro.name, body: macro.body,
    ...(macro.icon === undefined ? {} : { icon: macro.icon }),
  })));
}

/** What a bar slot shows for a macro: four letters, the way the original client abbreviates. */
export function macroLabel(macro: Macro | undefined, index: number): string {
  const name = macro?.name.trim();
  return name && name.length > 0 ? name.slice(0, 4) : `М${index}`;
}
