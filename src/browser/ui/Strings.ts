/**
 * The client's own words for the native interface (WORK_PLAN 4.10, М-A5-4).
 *
 * `GlobalStrings.lua` of the dataset already says, in the realm's locale, most of what the native
 * panels spell out by hand. `nativeString` reads it through the generated table
 * (`src/generated/globalStrings.ts`, local data) and falls back to the literal the caller gives —
 * a clean checkout has no table, and its tests must still pass.
 *
 * Formatting is Lua `string.format`'s subset the file uses: `%s`, `%d`/`%i`, `%.Nf`, positional
 * `%1$s`…`%9$s`, and `%%`; the client's own escapes (`|4…;` plurals, `|3-N(…)` declensions, colours)
 * are then resolved by the FrameXML text reader, so the native panel shows what the original would.
 */

import { globalString } from "../../generated/globalStrings.js";
import { plainFrameXmlText } from "./framexml_compat/FrameXmlText.js";
import { unescapeLua } from "../../world/GlobalStringFormat.js"; // L7 4.14

type StringSource = (key: string) => string | undefined;

let source: StringSource | undefined;

/** A test's own table in place of the generated one; `undefined` restores it. */
export function setStringSource(next: StringSource | undefined): void {
  source = next;
}

const FORMAT = /%(?:([1-9])\$)?([-+ #0]*)(\d*)(?:\.(\d*))?([sdif%])/g;

/** C's flags and width over one converted value: `-` left-justifies, `0` pads a number with zeros, `+`/space sign it. */
function pad(text: string, flags: string, width: string, numeric: boolean): string {
  let body = text;
  if (numeric && !body.startsWith("-")) {
    if (flags.includes("+")) body = `+${body}`;
    else if (flags.includes(" ")) body = ` ${body}`;
  }
  const size = width === "" ? 0 : Number(width);
  if (body.length >= size) return body;
  if (flags.includes("-")) return body.padEnd(size);
  if (numeric && flags.includes("0")) {
    const sign = /^[-+ ]/.test(body) ? body[0]! : "";
    return sign + body.slice(sign.length).padStart(size - sign.length, "0");
  }
  return body.padStart(size);
}

/**
 * `string.format` over the subset above, with C's flags and width (`%0.2f`, `%5d`, `%-4s`, `%02d`);
 * a missing argument formats as an empty string or 0.
 */
export function formatGlobalString(template: string, args: readonly (string | number)[]): string {
  let next = 0;
  return template.replace(FORMAT, (_match, position: string | undefined, flags: string, width: string,
    precision: string | undefined, kind: string) => {
    if (kind === "%") return "%";
    const index = position === undefined ? next++ : Number(position) - 1;
    const value = args[index];
    if (kind === "s") return pad(value === undefined ? "" : String(value), flags, width, false);
    const number = Number(value ?? 0);
    if (!Number.isFinite(number)) return pad("0", flags, width, true);
    if (kind === "f") return pad(number.toFixed(precision === undefined ? 6 : Number(precision || 0)), flags, width, true);
    return pad(String(Math.trunc(number)), flags, width, true);
  });
}

/**
 * The client's text for `key`, formatted with `args`, or `fallback` formatted the same way when
 * the local table has no such key. Never throws.
 */
export function nativeString(key: string, fallback: string, ...args: (string | number)[]): string {
  const template = (source ?? globalString)(key);
  if (template === undefined) return formatGlobalString(fallback, args);
  // L7 4.14: the table keeps the Lua source's escapes verbatim (TIME_UNIT_DELIMITER is a backslash and 32, a space);
  // Lua resolves them when GlobalStrings.lua loads, so the template is read as Lua reads it.
  const formatted = formatGlobalString(unescapeLua(template), args);
  return formatted.includes("|") ? plainFrameXmlText(formatted) : formatted;
}
