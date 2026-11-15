/**
 * Wow.exe's config cache text (5.37): what account-data slots 0 (the account's) and 1 (the character's)
 * hold, and what `config-cache.wtf` is a copy of — one `SET name "value"` line per CVar.
 *
 * Wow.exe 12340:
 *  - the reader (0x00766400) drops a UTF-8 byte order mark, splits the text into lines and hands each line
 *    that starts with `SET ` (any case, `_strnicmp`) to the console (0x007658a0); every other line is
 *    skipped. `SET` (0x007681f0) takes the name and the value as tokens over ` ,;\t"\r\n`, a value in
 *    quotes whole. A name no CVar has yet is made a CVar of no slot with that value as its default
 *    (0x00767fc0 with flags 0), so it is never written back to a slot;
 *  - the writer (0x007670e0 → 0x00767030 → 0x00766640) writes `SET %s "%s"\n` for every registered CVar of
 *    the slot's flag (0x10 account, 0x20 character; 0x00512890) whose value is not its default.
 *
 * This module reads and rewrites lines; which CVars mean which setting is `SettingsCVarSlots.ts`. A line it
 * does not change is written back exactly as it was read.
 *
 * DOM-free and pure.
 */

export type CVarCacheLine =
  | { readonly kind: "set"; readonly name: string; readonly value: string; readonly raw: string }
  | { readonly kind: "other"; readonly raw: string };

const DELIMITERS = " ,;\t\"\r\n";

/** 0x0076f1e0 over DELIMITERS: the next token of `text` from `at`, a quoted run taken whole. */
function token(text: string, at: number): { value: string; end: number } {
  let index = at;
  while (index < text.length && DELIMITERS.includes(text[index]!) && text[index] !== "\"") index += 1;
  if (text[index] === "\"") {
    const close = text.indexOf("\"", index + 1);
    const end = close < 0 ? text.length : close;
    return { value: text.slice(index + 1, end), end: Math.min(text.length, end + 1) };
  }
  let end = index;
  while (end < text.length && !DELIMITERS.includes(text[end]!)) end += 1;
  return { value: text.slice(index, end), end };
}

/** The text's lines; a `SET` line read as Wow.exe reads it, any other kept as it is. */
export function parseCVarCacheText(text: string): CVarCacheLine[] {
  const lines: CVarCacheLine[] = [];
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  for (const raw of body.split(/[\r\n]+/)) {
    if (raw === "") continue;
    if (raw.slice(0, 4).toUpperCase() !== "SET ") {
      lines.push({ kind: "other", raw });
      continue;
    }
    const name = token(raw, 4);
    if (name.value === "") {
      lines.push({ kind: "other", raw });
      continue;
    }
    const value = token(raw, name.end);
    lines.push({ kind: "set", name: name.value, value: value.value, raw });
  }
  return lines;
}

/** The value the last `SET` of a name gives it (names compared without case), or undefined. */
export function cvarLineValue(lines: readonly CVarCacheLine[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  let value: string | undefined;
  for (const line of lines) if (line.kind === "set" && line.name.toLowerCase() === wanted) value = line.value;
  return value;
}

/** One line as Wow.exe's writer spells it (0x00766640), without the line end. */
export function cvarSetLine(name: string, value: string): string {
  return `SET ${name} "${value}"`;
}

/**
 * The lines with some CVars given new values: the last line of each such name is rewritten in place (in
 * its own spelling of the name), a name with no line gets one at the end; `undefined` removes the
 * name's lines (its default, which Wow.exe does not write). Every other line stays as read.
 */
export function withCVarValues(lines: readonly CVarCacheLine[], values: ReadonlyMap<string, string | undefined>): CVarCacheLine[] {
  const lastIndex = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.kind === "set") lastIndex.set(line.name.toLowerCase(), index);
  });
  const wanted = new Map<string, [string, string | undefined]>();
  for (const [name, value] of values) wanted.set(name.toLowerCase(), [name, value]);
  const out: CVarCacheLine[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== "set") {
      out.push(line);
      return;
    }
    const key = line.name.toLowerCase();
    const change = wanted.get(key);
    if (!change) {
      out.push(line);
      return;
    }
    const value = change[1];
    if (value === undefined) return;
    if (lastIndex.get(key) !== index) {
      out.push(line);
      return;
    }
    out.push(line.value === value ? line : { kind: "set", name: line.name, value, raw: cvarSetLine(line.name, value) });
  });
  for (const [key, [name, value]] of wanted) {
    if (value === undefined || lastIndex.has(key)) continue;
    out.push({ kind: "set", name, value, raw: cvarSetLine(name, value) });
  }
  return out;
}

/** Lines back into text: Wow.exe ends every line with LF. No lines is the empty text. */
export function renderCVarCacheText(lines: readonly CVarCacheLine[]): string {
  return lines.map((line) => `${line.raw}\n`).join("");
}
