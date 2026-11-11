/**
 * Wow.exe's macro cache text (5.37): what the original client keeps in account-data slots 4 (account)
 * and 5 (character) and in `macros-cache.txt`, read and written the way Wow.exe reads and writes it.
 *
 * A block per macro, CRLF after every line:
 *
 *     MACRO <id> "<name>" <icon>
 *     <body line>
 *     ...
 *     END
 *
 * The writer (Wow.exe 0x005668f0) prints `MACRO %d "%s" %s` with the macro's id, its name and its icon
 * name — the texture's name without `Interface\Icons\` (0x00566ac0 puts that prefix back to draw it) —
 * then every non-empty line of the body and `END`. Nothing is escaped. Macros go out in the order the
 * client lists them: per set, sorted by name without case (0x00566240 qsorts with 0x00564a80, `_strnicmp`).
 *
 * The reader (0x00567c10) splits the text on CR and LF, so blank lines vanish. Outside a block a line
 * whose first space-separated word is `MACRO` (any case) opens one while the set holds fewer than 36
 * (0x24): the next word is the id (Storm's atoi, 0x0076f0d0); an id of 0, or one already held, skips
 * the line; an id below the set's base (0 account, 0x1000000 character, 0x00a0f834) has the base added;
 * then the name and the icon are Storm tokens over ` "\r\n` (0x0076f1e0, quote-aware), the name cut to 63
 * bytes and the icon to 255; an empty name skips the line. Inside a block a line that is `END` (any case)
 * closes it, any other line is added with a LF after it, up to 1023 bytes, and the closed body keeps its
 * first 256 characters (0x005663a0). Lines outside a block that are not a header are ignored, and so are
 * the body lines after a skipped header. A block never closed keeps its name and icon and no body.
 *
 * DOM-free and pure: no store, no world.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Ids at or above these belong to a set (Wow.exe 0x00a0f834): account, character. */
export const WOW_ACCOUNT_MACRO_BASE = 0;
export const WOW_CHARACTER_MACRO_BASE = 0x1000000;
/** Macros the reader takes per set (0x00567c10, `< 0x24`). */
export const WOW_MACROS_READ_PER_SET = 36;
/** The name and icon fields of Wow.exe's macro record: 64 and 256 bytes with the terminator. */
export const WOW_MACRO_NAME_BYTES = 63;
export const WOW_MACRO_ICON_BYTES = 255;
/** A closed body keeps this many characters (0x005663a0). */
export const WOW_MACRO_BODY_CHARS = 256;
/** The line and body buffers of the reader: 0x400 bytes with the terminator. */
const WOW_LINE_BYTES = 1023;
const WOW_BODY_BYTES = 1023;
/** The icon CreateMacro stores for the first icon of the list, the question mark. */
export const WOW_DEFAULT_MACRO_ICON = "INV_Misc_QuestionMark";

/** One macro as Wow.exe holds it. */
export interface WowMacro {
  /** Wow.exe's own id: what its action buttons hold. Account ids from 1, character from 0x1000001. */
  readonly id: number;
  readonly name: string;
  /** The icon's texture name under `Interface\Icons\`, possibly empty. */
  readonly icon: string;
  /** Lines joined by LF, each with a LF after it, as GetMacroBody answers in Wow.exe. */
  readonly body: string;
}

interface Cursor {
  readonly text: string;
  at: number;
}

/**
 * Storm's SStrTokenize (Wow.exe 0x0076f1e0) over a JS string: leading delimiters are skipped; when the
 * delimiters include a quote, a quote opens or closes a quoted run in which delimiters are kept, and a
 * quote met after some text ends the token without being consumed.
 */
export function stormToken(cursor: Cursor, delimiters: string): string {
  const { text } = cursor;
  const quotes = delimiters.includes("\"");
  let at = cursor.at;
  let quoted = false;
  while (at < text.length && delimiters.includes(text[at]!)) {
    if (quotes && text[at] === "\"") {
      quoted = true;
      at += 1;
      break;
    }
    at += 1;
  }
  let token = "";
  while (at < text.length) {
    const char = text[at]!;
    if (quotes && char === "\"") {
      if (token.length > 0 && !quoted) break;
      quoted = !quoted;
      at += 1;
      if (!quoted) break;
      continue;
    }
    if (!quoted && delimiters.includes(char)) {
      at += 1;
      break;
    }
    token += char;
    at += 1;
  }
  cursor.at = at;
  return token;
}

/** Storm's atoi (0x0076f0d0): an optional minus, decimal digits, 32-bit wrap; anything else is 0. */
export function stormAtoi(text: string): number {
  const negative = text.startsWith("-");
  let at = negative ? 1 : 0;
  let value = 0;
  while (at < text.length) {
    const digit = text.charCodeAt(at) - 0x30;
    if (digit < 0 || digit > 9) break;
    value = (value * 10 + digit) >>> 0;
    at += 1;
  }
  return negative ? -value | 0 : value | 0;
}

/** `_strnicmp` folds A–Z only. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * The first `max` bytes of the UTF-8 text. A character the cut would split is dropped whole (Wow.exe
 * keeps its leading bytes, which no decoder of this text could show anyway).
 */
function cutBytes(text: string, max: number): string {
  const bytes = ENCODER.encode(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return DECODER.decode(bytes.subarray(0, end));
}

function cutChars(text: string, max: number): string {
  let count = 0;
  let at = 0;
  for (const char of text) {
    if (count === max) return text.slice(0, at);
    count += 1;
    at += char.length;
  }
  return text;
}

/** `SStrNCat` into a buffer of `max` bytes plus the terminator. */
function appendBytes(text: string, more: string, max: number): string {
  const room = max - byteLength(text);
  return room <= 0 ? text : text + cutBytes(more, room);
}

/** The set's id base: 0 for the account's macros, 0x1000000 for a character's. */
export function wowMacroBase(characterSet: boolean): number {
  return characterSet ? WOW_CHARACTER_MACRO_BASE : WOW_ACCOUNT_MACRO_BASE;
}

/**
 * The macros Wow.exe reads from this text for one set, in the text's order.
 *
 * One rule is narrower than Wow.exe's: the reader skips an id that any macro already in memory holds,
 * including the other set's; here only this text's macros are looked at.
 */
export function parseWowMacroText(text: string, characterSet: boolean): WowMacro[] {
  const base = wowMacroBase(characterSet);
  const macros: { id: number; name: string; icon: string; body: string }[] = [];
  let open: { id: number; name: string; icon: string; body: string } | undefined;
  let body = "";
  const lines: Cursor = { text, at: 0 };
  while (lines.at < text.length) {
    const line = cutBytes(stormToken(lines, "\r\n"), WOW_LINE_BYTES);
    if (line === "") continue;
    if (open === undefined) {
      const words: Cursor = { text: line, at: 0 };
      if (asciiLower(stormToken(words, " ")) !== "macro" || macros.length >= WOW_MACROS_READ_PER_SET) continue;
      let id = stormAtoi(stormToken(words, " "));
      if (id === 0 || macros.some((macro) => macro.id === id)) continue;
      if (id < base) id = (id + base) | 0;
      const name = cutBytes(stormToken(words, " \"\r\n"), WOW_MACRO_NAME_BYTES);
      if (name === "") continue;
      const icon = cutBytes(stormToken(words, " \"\r\n"), WOW_MACRO_ICON_BYTES);
      open = { id, name, icon, body: "" };
      macros.push(open);
      body = "";
      continue;
    }
    if (asciiLower(line) === "end") {
      open.body = cutChars(body, WOW_MACRO_BODY_CHARS);
      open = undefined;
      continue;
    }
    body = appendBytes(appendBytes(body, line, WOW_BODY_BYTES), "\n", WOW_BODY_BYTES);
  }
  return macros;
}

/** `_strnicmp` of two names (0x00564a80): UTF-8 bytes with A–Z folded, unsigned. */
export function compareWowMacroNames(left: string, right: string): number {
  const a = ENCODER.encode(asciiLower(left));
  const b = ENCODER.encode(asciiLower(right));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** The order Wow.exe lists a set in, and writes it in: by name without case (stable here on ties). */
export function sortWowMacros(macros: readonly WowMacro[]): WowMacro[] {
  return [...macros].sort((left, right) => compareWowMacroNames(left.name, right.name));
}

/** The text Wow.exe writes for one set (0x005668f0): an empty set is an empty text. */
export function serialiseWowMacroText(macros: readonly WowMacro[]): string {
  let text = "";
  for (const macro of sortWowMacros(macros)) {
    text += `MACRO ${macro.id | 0} "${macro.name}" ${macro.icon}\r\n`;
    for (const line of macro.body.split(/[\r\n]+/)) if (line !== "") text += `${line}\r\n`;
    text += "END\r\n";
  }
  return text;
}
