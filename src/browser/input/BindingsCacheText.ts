/**
 * Wow.exe's key bindings cache text (5.37): what account-data slots 2 (the account's set) and 3 (the
 * character's) hold, and what `bindings-cache.wtf` is a copy of.
 *
 * The grammar, as Wow.exe 12340 reads and writes it:
 *  - the reader (0x005641c0) splits the text into lines (0x0076f1e0 over CR/LF, empty lines skipped),
 *    skips leading spaces and tabs, and knows three line kinds, compared without case (0x0076e780 is
 *    `_strnicmp`): `BINDINGMODE n` (n below 4 sets the mode of the lines after it; anything else leaves
 *    it), `bind KEY COMMAND` (the key is the first space-delimited token, the command the rest of the
 *    line; an empty command is NONE, 0x00562ed0) and `modifiedclick KEY ACTION` (0x0055e180). Every other
 *    line is skipped, and is not written back by Wow.exe;
 *  - the writer (0x0055f1b0) writes, for each of the four modes that has one, `BINDINGMODE n` and then
 *    `bind KEY COMMAND` for every key whose binding is not the default file's (the node's bit 0, set only
 *    by DefaultBindings.wtf, 0x00562ed0), then `modifiedclick KEY ACTION` for every modified click that
 *    is not the default; every line ends in CRLF. `bind KEY NONE` is how a default key is taken away.
 *  - the four key aliases of punctuation are read for the whole key only (LEFTBRACKET is `[`, PLUS is
 *    `=`, …, 0x00562ed0), so `SHIFT-LEFTBRACKET` is not one.
 *
 * This module only reads lines and puts them back; which bindings they mean is `BindingsCacheTable.ts`.
 * A line this client does not understand is kept as it was read, in its mode, and written back.
 *
 * DOM-free and pure.
 */

/** The four binding modes Wow.exe keeps (`BINDINGMODE 0..3`); this client binds in mode 0 only. */
export const BINDING_MODE_COUNT = 4;

export type BindingsCacheLine =
  /** `bind KEY COMMAND` in `mode`. `command` is the rest of the line as read, `NONE` for an empty one. */
  | { readonly kind: "bind"; readonly mode: number; readonly key: string; readonly command: string; readonly raw: string }
  /** `modifiedclick KEY ACTION`: mode-free. */
  | { readonly kind: "click"; readonly raw: string }
  /** Anything else, kept in the mode it was read in. `BINDINGMODE` lines are not kept: they are rewritten. */
  | { readonly kind: "other"; readonly mode: number; readonly raw: string };

const CRLF = "\r\n";

/** 0x0076f0d0: an optional minus and the leading digits; no digits is 0. */
function leadingInteger(text: string): number {
  const match = /^(-?)(\d*)/.exec(text)!;
  const value = match[2] === "" ? 0 : Number(match[2]);
  return match[1] === "-" ? -value : value;
}

/** The lines of a bindings cache text, in order. Lines of `BINDINGMODE` set the mode and are not returned. */
export function parseBindingsCacheText(text: string): BindingsCacheLine[] {
  const lines: BindingsCacheLine[] = [];
  let mode = 0;
  for (const piece of text.split(/[\r\n]+/)) {
    const line = piece.replace(/^[ \t]+/, "");
    if (line === "") continue;
    const head = line.slice(0, 14).toLowerCase();
    if (head.startsWith("bindingmode ")) {
      const value = leadingInteger(line.slice(12));
      // Unsigned in Wow.exe: a negative number is huge and ignored like 4 and above.
      if (value >= 0 && value < BINDING_MODE_COUNT) mode = value;
      else lines.push({ kind: "other", mode, raw: line });
      continue;
    }
    if (head.startsWith("bind ")) {
      const rest = line.slice(5).replace(/^ +/, "");
      const space = rest.indexOf(" ");
      const key = space < 0 ? rest : rest.slice(0, space);
      const command = space < 0 ? "" : rest.slice(space + 1);
      if (key === "") {
        lines.push({ kind: "other", mode, raw: line });
        continue;
      }
      lines.push({ kind: "bind", mode, key, command: command === "" ? "NONE" : command, raw: line });
      continue;
    }
    if (head.startsWith("modifiedclick ")) {
      lines.push({ kind: "click", raw: line });
      continue;
    }
    lines.push({ kind: "other", mode, raw: line });
  }
  return lines;
}

/** One `bind` line as Wow.exe's writer spells it. */
export function bindLine(key: string, command: string): string {
  return `bind ${key} ${command}`;
}

/**
 * Lines back into text in the writer's layout: each mode that has lines under its `BINDINGMODE n`, in
 * mode order, then the modified clicks; CRLF after every line. No lines at all is the empty text.
 */
export function renderBindingsCacheText(lines: readonly BindingsCacheLine[]): string {
  const byMode: string[][] = Array.from({ length: BINDING_MODE_COUNT }, () => []);
  const clicks: string[] = [];
  for (const line of lines) {
    if (line.kind === "click") clicks.push(line.raw);
    else byMode[line.mode]!.push(line.raw);
  }
  let text = "";
  byMode.forEach((raws, mode) => {
    if (raws.length === 0) return;
    text += `BINDINGMODE ${mode}${CRLF}`;
    for (const raw of raws) text += raw + CRLF;
  });
  for (const raw of clicks) text += raw + CRLF;
  return text;
}

/** The punctuation names Wow.exe reads for a whole key (0x00562ed0), as the characters it binds. */
const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  LEFTBRACKET: "[", RIGHTBRACKET: "]", SLASH: "/", BACKSLASH: "\\", SEMICOLON: ";", APOSTROPHE: "'",
  COMMA: ",", PERIOD: ".", TILDE: "`", PLUS: "=", MINUS: "-",
});

/** A key as Wow.exe stores it: one of the punctuation names is its character, anything else is itself. */
export function canonicalBindingKey(key: string): string {
  return KEY_ALIASES[key.toUpperCase()] ?? key;
}
