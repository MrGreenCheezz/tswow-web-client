/**
 * Macro options — the `[conditions] action; [conditions] action` text behind `/cast`, `/target`,
 * `/stopmacro` and a state driver's `[combat] show; hide` — parsed and evaluated once, for the stock
 * interface (`SecureCmdOptionParse`, FrameXmlChatApi.ts) and the native commands (CombatCommands.ts)
 * alike. Pure: the world is asked through a {@link MacroContext}.
 *
 * The grammar, as the 3.3.5 client reads it (Wow.exe 12340: 0x5f0df0 the clauses, 0x5f0bb0 a group,
 * 0x5f0040 a condition, 0x5ef5c0 a group's evaluation):
 *
 * - Clauses are separated by `;` outside brackets and tried in order; the first that holds answers
 *   its action text. A clause with no brackets always holds.
 * - A clause is zero or more groups `[...]`, then its action. Groups are alternatives: the first
 *   whose conditions all hold answers, with that group's target. An empty group `[]` holds.
 * - Inside a group, conditions are separated by `,` and must all hold. A condition is `word`,
 *   `word:a/b` (a slash is «any of») or `noword[:a/b]` (the negation). `@unit` or `target=unit` names
 *   the group's target, wherever in the group it is written; the unit conditions ask about that
 *   target, `target` when the group names none — and when the target is empty (`[@]`), which is
 *   also answered as no target. A target alone is not a condition, so a group holding nothing else
 *   always holds.
 * - Words, the `no` prefix and `target=` are compared case-sensitively (`strncmp`); argument values
 *   are not. The words are the client's own: the cluster before `.\UIMacroOptions.cpp` — cursor,
 *   unithasvehicleui, vehicleui, spec, channeling, worn, equipped, bonusbar, bar, actionbar, btn,
 *   button, mod, modifier, form, stance, stealth, mounted, flying, swimming, outdoors, indoors,
 *   flyable, dead, harm, help, exists — plus combat, group, party, raid and pet
 *   (docs/implementation/probes/A2/probe-macro-conditions.out.txt).
 * - A word the client does not know is reported once — ERR_UNKNOWN_MACRO_OPTION_S, through
 *   {@link installMacroOptionErrorSink} — and holds, as the client's default handler does (`no`
 *   still negates it). `known` and `canexitvehicle` are later clients' and are such words here.
 * - Whitespace around every part is ignored. An unclosed `[` is a syntax error: that clause answers
 *   nothing and evaluation stops there.
 *
 * The answer is the chosen action text and, when the group named one, its target: exactly the
 * `action, target` pair `SecureCmdOptionParse` returns; `undefined` is its nil.
 *
 * Cost: the stock state driver evaluates every registered option string five times a second
 * (SecureStateDriver.lua:81-104), so a string is parsed once ({@link macroOptions}) and evaluation
 * is a walk over the parsed conditions with one context call each.
 */

/**
 * What a macro condition asks the world. Every member is optional: one a context leaves out
 * answers «no» (false, 0, nothing), which is also the answer while this client has no data for it.
 * Unit members take a lower-case unit token (`target`, `focus`, `party1`, …).
 */
export interface MacroContext {
  /**
   * `mod[:X]`: `IsModifiedClick(X)` — keys (`SHIFT`, `LCTRL`, `ALT-SHIFT` …, case-insensitive) that
   * must all be held, or a modified-click action (`SELFCAST`); undefined asks «any modifier».
   */
  modifier?(key?: string): boolean;
  /** `btn:N`: the mouse button the running macro was started with; «LeftButton» when it has none. */
  button?(): string | undefined;
  /** `combat`: the player or the pet is in combat. */
  combat?(): boolean;
  exists?(unit: string): boolean;
  /** `dead`: dead or a ghost. */
  dead?(unit: string): boolean;
  /** `harm`: the player can attack the unit. */
  harm?(unit: string): boolean;
  /** `help`: the player can assist the unit. */
  help?(unit: string): boolean;
  /** `party`: a member of the player's party, the player aside; `raid`: of the party or the raid. */
  inParty?(unit: string): boolean;
  inRaid?(unit: string): boolean;
  /** `group[:party|raid]`: the kind of group the player is in, if any. */
  group?(): "party" | "raid" | undefined;
  /** `stance:N`/`form:N`: `GetShapeshiftForm(true)` — the stance bar slot of the form; 0 without one. */
  stance?(): number;
  /** `bonusbar:N`: `GetBonusBarOffset()`; 0 without a bonus bar. */
  bonusBar?(): number;
  /** `actionbar:N`/`bar:N`: `GetActionBarPage()`. */
  actionBar?(): number;
  /** `spec:N`: the 1-based active talent group; 0 while unknown. */
  spec?(): number;
  /** `channeling[:name]`: the channelled spell's name, "" when unnamed yet, undefined when not channelling. */
  channeling?(): string | undefined;
  /** `pet[:name|family]`: the player's pet, if one is out. */
  pet?(): MacroPet | undefined;
  mounted?(): boolean;
  swimming?(): boolean;
  flying?(): boolean;
  stealth?(): boolean;
  flyable?(): boolean;
  indoors?(): boolean;
  outdoors?(): boolean;
  /** `equipped:type`/`worn:type`: an item of that class or subclass is equipped. */
  equipped?(type: string): boolean;
  vehicleUi?(): boolean;
  unitHasVehicleUi?(unit: string): boolean;
  /** `cursor`: something is on the cursor. */
  cursor?(): boolean;
}

export interface MacroPet {
  readonly name?: string | undefined;
  readonly family?: string | undefined;
}

export interface MacroCondition {
  /**
   * The canonical word; the aliases are folded: modifier → mod, button → btn, form → stance,
   * bar → actionbar, worn → equipped. For an unknown word, the word as written (after `no`).
   */
  readonly name: string;
  /** False for a word the client does not know; such a condition holds. */
  readonly known: boolean;
  readonly negated: boolean;
  /** The `:a/b` arguments, trimmed; undefined when none were written. */
  readonly args: readonly string[] | undefined;
}

export interface MacroGroup {
  /** The `@unit` / `target=unit` of the group, as written; undefined for none or an empty one. */
  readonly target: string | undefined;
  readonly conditions: readonly MacroCondition[];
}

export interface MacroClause {
  /** Empty: the clause always holds. */
  readonly groups: readonly MacroGroup[];
  readonly text: string;
  /** Why the clause cannot be read; evaluation answers nothing when it reaches it. */
  readonly error?: string;
}

export interface ParsedMacroOptions {
  readonly clauses: readonly MacroClause[];
  /** The first clause's syntax error, if any clause has one. */
  readonly error: string | undefined;
  /** The words the client does not know, in order, as ERR_UNKNOWN_MACRO_OPTION_S names them. */
  readonly unknown: readonly string[];
}

export interface MacroOptionResult {
  readonly text: string;
  /** The target the holding group named; absent when it named none. */
  readonly target?: string;
}

const ALIASES: ReadonlyMap<string, string> = new Map([
  ["modifier", "mod"], ["button", "btn"], ["form", "stance"], ["bar", "actionbar"], ["worn", "equipped"],
]);

/** Every canonical condition word (see the module comment for where the list comes from). */
export const MACRO_CONDITION_WORDS: ReadonlySet<string> = new Set([
  "mod", "btn", "stance", "bonusbar", "actionbar", "spec", "group", "channeling", "pet", "equipped",
  "vehicleui", "unithasvehicleui", "combat", "dead", "exists", "harm", "help", "party", "raid", "stealth",
  "mounted", "swimming", "flying", "flyable", "indoors", "outdoors", "cursor",
]);

const UNCLOSED = "не закрыта скобка «[»";

/** A group's target token: undefined when `raw` is not one. `strncmp`, as the client compares. */
function targetOf(raw: string): string | undefined {
  if (raw.startsWith("@")) return raw.slice(1).trim();
  if (raw.startsWith("target=")) return raw.slice("target=".length).trim();
  return undefined;
}

function parseCondition(raw: string): MacroCondition {
  // The client tests the prefix before the word: `no` and at least one more character.
  const negated = raw.length >= 3 && raw.startsWith("no");
  const body = negated ? raw.slice(2) : raw;
  const colon = body.indexOf(":");
  const word = (colon < 0 ? body : body.slice(0, colon)).trim();
  const written = colon < 0 ? []
    : body.slice(colon + 1).split("/").map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  const args = written.length > 0 ? Object.freeze(written) : undefined;
  const name = ALIASES.get(word) ?? word;
  return Object.freeze({ name, known: MACRO_CONDITION_WORDS.has(name), negated, args });
}

function parseGroup(inside: string): MacroGroup {
  let target: string | undefined;
  const conditions: MacroCondition[] = [];
  for (const part of inside.split(",")) {
    const raw = part.trim();
    if (raw.length === 0) continue;
    const unit = targetOf(raw);
    if (unit === undefined) conditions.push(parseCondition(raw));
    else target = unit.length > 0 ? unit : undefined;
  }
  return Object.freeze({ target, conditions: Object.freeze(conditions) });
}

function parseClause(raw: string): MacroClause {
  const groups: MacroGroup[] = [];
  let rest = raw.trim();
  while (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return Object.freeze({ groups: Object.freeze(groups), text: "", error: UNCLOSED });
    groups.push(parseGroup(rest.slice(1, close)));
    rest = rest.slice(close + 1).trimStart();
  }
  return Object.freeze({ groups: Object.freeze(groups), text: rest.trim() });
}

/** Split on `;` outside brackets. An unclosed `[` keeps the rest of the string in its clause. */
function splitClauses(source: string): string[] {
  const clauses: string[] = [];
  let inside = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") inside = true;
    else if (char === "]") inside = false;
    else if (char === ";" && !inside) {
      clauses.push(source.slice(start, index));
      start = index + 1;
    }
  }
  clauses.push(source.slice(start));
  return clauses;
}

/** Parse an option string. Never throws: broken syntax is reported in `error` and on its clause. */
export function parseMacroOptions(source: string): ParsedMacroOptions {
  const clauses = splitClauses(source).map(parseClause);
  const error = clauses.find((clause) => clause.error !== undefined)?.error;
  const unknown: string[] = [];
  for (const clause of clauses) {
    for (const group of clause.groups) {
      for (const condition of group.conditions) if (!condition.known) unknown.push(condition.name);
    }
  }
  return Object.freeze({ clauses: Object.freeze(clauses), error, unknown: Object.freeze(unknown) });
}

/** How many distinct option strings stay parsed; a state driver has a handful, a macro a few more. */
const PARSED_LIMIT = 512;
const parsed = new Map<string, ParsedMacroOptions>();

/** {@link parseMacroOptions}, remembered: the same string is parsed once. */
export function macroOptions(source: string): ParsedMacroOptions {
  let options = parsed.get(source);
  if (options === undefined) {
    options = parseMacroOptions(source);
    if (parsed.size >= PARSED_LIMIT) parsed.clear();
    parsed.set(source, options);
  }
  return options;
}

/** Where ERR_UNKNOWN_MACRO_OPTION_S goes: the stock UI's error line, or the native notices. */
export type MacroOptionErrorSink = (word: string) => void;

const errorSinks: MacroOptionErrorSink[] = [];
/** The option strings whose unknown words were reported: once each, as the client parses once. */
const reported = new WeakSet<ParsedMacroOptions>();

/** Put a sink over the current one until the returned function takes it off. */
export function installMacroOptionErrorSink(sink: MacroOptionErrorSink): () => void {
  errorSinks.push(sink);
  return () => {
    const index = errorSinks.lastIndexOf(sink);
    if (index >= 0) errorSinks.splice(index, 1);
  };
}

function reportUnknown(options: ParsedMacroOptions): void {
  if (options.unknown.length === 0 || reported.has(options)) return;
  reported.add(options);
  const sink = errorSinks[errorSinks.length - 1];
  if (sink) for (const word of options.unknown) sink(word);
}

/** The button names SecureActionButton hands RunMacro, and the numbers `btn:N` gives them. */
const BUTTON_NUMBERS: ReadonlyMap<string, string> = new Map([
  ["leftbutton", "1"], ["rightbutton", "2"], ["middlebutton", "3"], ["button4", "4"], ["button5", "5"],
]);

function buttonMatches(button: string, wanted: string): boolean {
  const name = button.toLowerCase();
  const arg = wanted.toLowerCase();
  return arg === name || BUTTON_NUMBERS.get(name) === arg;
}

/** A numeric condition compares its arguments only: bare, `[bonusbar]` never holds (0x5ef200-0x5ef2e0). */
function numberMatches(value: number, args: readonly string[] | undefined): boolean {
  if (args === undefined) return false;
  for (const arg of args) if (Number(arg) === value) return true;
  return false;
}

/** A named condition: without arguments «there is one», otherwise one of them, case aside. */
function nameMatches(names: readonly (string | undefined)[], args: readonly string[] | undefined): boolean {
  if (args === undefined) return true;
  for (const arg of args) {
    const wanted = arg.toLowerCase();
    for (const name of names) if (name !== undefined && name.toLowerCase() === wanted) return true;
  }
  return false;
}

function conditionValue(condition: MacroCondition, unit: string, context: MacroContext): boolean {
  const args = condition.args;
  switch (condition.name) {
    case "mod":
      if (args === undefined) return context.modifier?.() ?? false;
      for (const arg of args) if (context.modifier?.(arg)) return true;
      return false;
    case "btn": {
      // No button — a key, a chat line, a state driver — is «LeftButton» (Wow.exe 0x5ef0d0).
      if (args === undefined) return false;
      const button = context.button?.() ?? "LeftButton";
      for (const arg of args) if (buttonMatches(button, arg)) return true;
      return false;
    }
    case "stance": {
      // Bare `[stance]` is «any form» (0x5eefb0), unlike the other numeric words.
      const stance = context.stance?.() ?? 0;
      return args === undefined ? stance !== 0 : numberMatches(stance, args);
    }
    case "bonusbar": return numberMatches(context.bonusBar?.() ?? 0, args);
    case "actionbar": return numberMatches(context.actionBar?.() ?? 0, args);
    case "spec": return numberMatches(context.spec?.() ?? 0, args);
    case "group": {
      // `group:party` holds in a raid too; bare, any group (0x5eeed0).
      const kind = context.group?.();
      if (kind === undefined) return false;
      if (args === undefined) return true;
      for (const arg of args) {
        const wanted = arg.toLowerCase();
        if (wanted === "party" || (wanted === "raid" && kind === "raid")) return true;
      }
      return false;
    }
    case "channeling": {
      const spell = context.channeling?.();
      return spell !== undefined && nameMatches([spell], args);
    }
    case "pet": {
      const pet = context.pet?.();
      return pet !== undefined && nameMatches([pet.name, pet.family], args);
    }
    case "equipped":
      if (args === undefined) return false;
      for (const arg of args) if (context.equipped?.(arg)) return true;
      return false;
    case "vehicleui": return context.vehicleUi?.() ?? false;
    case "unithasvehicleui": return context.unitHasVehicleUi?.(unit) ?? false;
    case "combat": return context.combat?.() ?? false;
    case "dead": return context.dead?.(unit) ?? false;
    case "exists": return context.exists?.(unit) ?? false;
    case "harm": return context.harm?.(unit) ?? false;
    case "help": return context.help?.(unit) ?? false;
    case "party": return context.inParty?.(unit) ?? false;
    case "raid": return context.inRaid?.(unit) ?? false;
    case "stealth": return context.stealth?.() ?? false;
    case "mounted": return context.mounted?.() ?? false;
    case "swimming": return context.swimming?.() ?? false;
    case "flying": return context.flying?.() ?? false;
    case "flyable": return context.flyable?.() ?? false;
    case "indoors": return context.indoors?.() ?? false;
    case "outdoors": return context.outdoors?.() ?? false;
    case "cursor": return context.cursor?.() ?? false;
    default: return false;
  }
}

function groupHolds(group: MacroGroup, context: MacroContext, defaultTarget: string): boolean {
  const unit = (group.target ?? defaultTarget).toLowerCase();
  for (const condition of group.conditions) {
    // An unknown word is the client's default handler, which answers true.
    const value = condition.known ? conditionValue(condition, unit, context) : true;
    if (value === condition.negated) return false;
  }
  return true;
}

/**
 * The action the options choose in `context`, with the holding group's target; undefined when no
 * clause holds or a clause reached is broken. `defaultTarget` is the unit a group without a target
 * asks about. The first evaluation of a string reports its unknown words.
 */
export function evaluateMacroOptions(
  options: ParsedMacroOptions | string,
  context: MacroContext,
  defaultTarget = "target",
): MacroOptionResult | undefined {
  const parsedOptions = typeof options === "string" ? macroOptions(options) : options;
  reportUnknown(parsedOptions);
  for (const clause of parsedOptions.clauses) {
    if (clause.error !== undefined) return undefined;
    if (clause.groups.length === 0) return { text: clause.text };
    for (const group of clause.groups) {
      if (!groupHolds(group, context, defaultTarget)) continue;
      return group.target === undefined ? { text: clause.text } : { text: clause.text, target: group.target };
    }
  }
  return undefined;
}
