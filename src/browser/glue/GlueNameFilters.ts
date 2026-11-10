import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "../CatalogClient.js";

/**
 * 1.19 (11.11): the name filters of the client's own name check — NamesProfanity, ChatProfanity and NamesReserved
 * (`/dbc/name-filters?v=1`, gateway/NameFilterMetadata.ts) — as Wow.exe 3.3.5a 12340 compiles and applies them
 * (read-only Ghidra, .runtime/re-2026-11-11/glue):
 *
 * - 0x7e2250 compiles each row with 0x83df20(…, flags 1): the POSIX wrapper of the bundled PCRE (0x8418f0 is
 *   `pcre_compile`, 0x847610 `pcre_exec`), options UTF8 | NO_UTF8_CHECK | CASELESS. A row that does not compile is
 *   skipped.
 * - The bundled PCRE is patched: its escape table (0xa464a0, from '0') maps `\<` and `\>` to escape −4, the one 'b'
 *   maps to — so both are a word boundary `\b`. PCRE of that age has no Unicode properties here (no script-name
 *   table in the binary): a word character is an ASCII letter, digit or '_', and CASELESS folds ASCII letters only.
 *   So `\<Разбойник\>` never matches (a Cyrillic letter is not a word character on either side of the boundary),
 *   while `\<focus\>` refuses "Focus".
 * - 0x7e18c0, after the letters of the name passed its walk, tries the client locale's lists in the order profane
 *   (when asked), chat profanity (when asked), reserved (when asked): any pattern found anywhere in the name ends
 *   the check with code 8 — `CHAR_NAME_RESERVED` (87 + 8; 0x6b0f90 adds 0x57), the same for all three lists. The
 *   length limit (0x7e1e90) is judged only after them.
 *
 * Here a pattern is rewritten for a JavaScript RegExp without the `u` and `i` flags, whose `\b` and `\w` are the
 * same ASCII ones: `\<`/`\>` become `\b`, ASCII letters outside an escape are lower-cased, and the name is matched
 * with its ASCII letters lower-cased — PCRE's ASCII-only caseless match. A pattern that uses PCRE syntax a RegExp
 * would read differently (\A, \Z, \z, \G, \Q…\E, \X, \C, \p, \P, \e, \a, POSIX classes, possessive or atomic
 * groups) is skipped rather than misread; none of the ruRU rows does.
 */

export interface GlueNameFilterTables {
  readonly profane: readonly RegExp[];
  readonly chat: readonly RegExp[];
  readonly reserved: readonly RegExp[];
}

/** The lists a name check consults, as its caller passes them (0x6b0f90 and the pet's 0x7e1f00: all three). */
export interface GlueNameFilterUse {
  readonly profane: boolean;
  readonly chat: boolean;
  readonly reserved: boolean;
}

export const GLUE_NAME_FILTERS_ALL: GlueNameFilterUse = Object.freeze({ profane: true, chat: true, reserved: true });

/** Escapes whose PCRE meaning a RegExp without `u` would read as a plain letter. */
const PCRE_ONLY_ESCAPES = new Set(["A", "Z", "z", "G", "Q", "E", "X", "C", "p", "P", "e", "a"]);

/** One DBC pattern as a RegExp with PCRE's meaning, or undefined when it cannot be carried over. */
export function glueNameFilterRegExp(pattern: string): RegExp | undefined {
  if (/\(\?>|[*+?}]\+|\[\[:/.test(pattern)) return undefined;
  let source = "";
  for (let at = 0; at < pattern.length; at++) {
    const character = pattern[at]!;
    if (character === "\\") {
      const next = pattern[at + 1];
      if (next === undefined) return undefined;
      at++;
      if (next === "<" || next === ">") source += "\\b";
      else if (PCRE_ONLY_ESCAPES.has(next)) return undefined;
      else source += `\\${next}`;
      continue;
    }
    source += character >= "A" && character <= "Z" ? character.toLowerCase() : character;
  }
  try {
    return new RegExp(source);
  } catch {
    // 0x7e2250 skips a row its compiler refuses; a row this one refuses is skipped the same way.
    return undefined;
  }
}

/** ASCII letters lower-cased, the rest as written: the subject of an ASCII-only caseless match. */
function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** 0x7e18c0's table step: whether any consulted list finds its pattern in the name (→ `CHAR_NAME_RESERVED`). */
export function glueNameFiltered(
  name: string,
  tables: GlueNameFilterTables | undefined,
  use: GlueNameFilterUse = GLUE_NAME_FILTERS_ALL,
): boolean {
  if (!tables) return false;
  const subject = asciiLower(name);
  const hit = (list: readonly RegExp[]): boolean => list.some((pattern) => pattern.test(subject));
  return (use.profane && hit(tables.profane)) || (use.chat && hit(tables.chat)) || (use.reserved && hit(tables.reserved));
}

/**
 * The lists 0x7e2250 built for the realm the character entered the world from: they are the client's globals
 * (0xd37e28…), so the pet's name check in the world (0x7e1f00, FrameXmlPetDeclension.ts) reads the same ones.
 * Set by the glue as it hands the character over; none before — no table step.
 */
let worldNameFilters: GlueNameFilterTables | undefined;

export function setGlueWorldNameFilters(tables: GlueNameFilterTables | undefined): void {
  worldNameFilters = tables;
}

export function glueWorldNameFilters(): GlueNameFilterTables | undefined {
  return worldNameFilters;
}

export const NAME_FILTERS_ROUTE_VERSION = 1;
export const NAME_FILTERS_ROUTE_PATH = `/dbc/name-filters?v=${NAME_FILTERS_ROUTE_VERSION}`;

/** The route's answer compiled: the client locale's lists (that locale's rows and the -1 rows). */
export interface GlueNameFilterCatalog {
  /** The client locale index the lists are for (enUS 0 … ruRU 8). */
  readonly locale: number;
  readonly tables: GlueNameFilterTables;
}

function patterns(value: unknown): RegExp[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return (value as string[]).map(glueNameFilterRegExp).filter((entry): entry is RegExp => entry !== undefined);
}

/** Validate and compile a route answer; undefined when its shape is not the route's. */
export function glueNameFilterCatalogFrom(data: unknown, version = NAME_FILTERS_ROUTE_VERSION): GlueNameFilterCatalog | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; locale?: unknown; profane?: unknown; chat?: unknown; reserved?: unknown };
  if (value.version !== version || !Number.isInteger(value.locale) || (value.locale as number) < 0) return undefined;
  const profane = patterns(value.profane);
  const chat = patterns(value.chat);
  const reserved = patterns(value.reserved);
  if (!profane || !chat || !reserved) return undefined;
  return Object.freeze({ locale: value.locale as number, tables: Object.freeze({ profane, chat, reserved }) });
}

/**
 * Whether the client compiled its own locale's lists for the realm: 0x7e2250 builds them only for the locale bits of
 * the realm category's LocaleMask (all of them for 0); without a row 0x4dab40 passes the client locale's own bit.
 */
export function glueNameFiltersActive(localeMask: number | undefined, locale: number): boolean {
  const mask = localeMask === undefined ? 2 ** locale : localeMask >>> 0;
  return mask === 0 || Math.floor(mask / 2 ** locale) % 2 === 1;
}

/**
 * The lists in the browser, asked once per page. A gateway older than the route answers 404 and the check goes
 * without them, as before — the server still refuses such a name.
 */
export class GlueNameFilterClient {
  readonly #catalog: RetryingCatalogClient<GlueNameFilterCatalog>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, NAME_FILTERS_ROUTE_PATH,
      (data) => glueNameFilterCatalogFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The compiled lists; undefined until they land. Starts the first cycle if none has run. */
  catalog(): GlueNameFilterCatalog | undefined {
    const value = this.#catalog.value;
    if (value) return value;
    void this.#catalog.load();
    return undefined;
  }
}
