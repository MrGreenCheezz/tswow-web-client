/**
 * The escape sequences 3.3.5 hides inside every widget string.
 *
 * A FontString's text is not plain text: the client's own interface writes colour, line breaks and
 * hyperlinks into it with a pipe escape, and a renderer that hands the string to `textContent`
 * shows the code. Measured on the live glue screen before this existed — `AccountLoginUIText` read
 * `|CFFb90908|r`, both edit-box placeholders read `|cffB5AF80Account Name` / `|cffB5AF80Password`,
 * the save-password label read `|cffDFD8B5Запомнить пароль`, and the three realm-wizard game-type
 * buttons carried `|cffff0000(PvP)|r` and its two siblings.
 *
 * The set implemented here is the one 3.3.5 defines:
 *
 * - `|cAARRGGBB` opens a colour, `|r` closes it. Nested colours are a stack — FrameXML nests them
 *   inside links — so `|r` restores the colour that was open before rather than clearing to none.
 * - `|n` is a line break.
 * - `||` is a literal pipe. It is checked before every other escape, because `||c` is the text
 *   "|c" and not a colour.
 * - `|Hlinktype:data|htext|h` is a hyperlink: the display text is rendered, the link payload is
 *   dropped. The glue screens have no action to take on a link — there is no chat and no item
 *   query behind this screen — so the payload is deliberately ignored rather than carried.
 * - `|Tpath:size|t` is an inline icon. There is no picture to put in a text run here, so the
 *   sequence is dropped whole; leaving it alone would print a texture path in the middle of a
 *   sentence, which is strictly worse than a missing icon.
 * - `|3-N(text)` is the Russian case marker GlobalStrings uses (`SET_FRIENDNOTE_LABEL` «Заметка о
 *   |3-5(%s):», `PLAYER_LEVEL`). The client replaces the whole escape with the word in case N
 *   before anything else is read, and so does this parser: `FrameXmlDeclension.ts` is the port of
 *   the executable's declension, dictionary and rule tables, and its header has the evidence.
 * - `|4one:few:many;` is a plural that agrees with the number written before it — 135 of the
 *   dataset's ruRU GlobalStrings carry one, the aura tooltip's «Осталось: %d
 *   |4минута:минуты:минут;» and every combat-log amount among them. The client formats the number in
 *   first and resolves the escape when it draws the string, so it is resolved here: with three
 *   forms by the Russian rule (1, 21 … one; 2-4, 22-24 … few; the rest, and 11-14, many), with two
 *   by the English one (1 or not), against the last number in the text before it.
 *
 * Case: the escape letters are matched case-insensitively. `AccountLogin.xml` in this client's own
 * patch chain writes `|CFFb90908|r` with a capital C, and the module ships that string as the
 * screen's own subtitle — a client that refused it would be showing the raw code to the owner's
 * players, so the shipping data is the evidence that the real parser accepts both cases.
 *
 * Nothing is ever silently deleted except a sequence named above: an unrecognised `|x` comes back
 * as the two characters that were written, so a malformed escape shows itself instead of eating
 * the rest of the line.
 */

import { expandFrameXmlDeclension } from "./FrameXmlDeclension.js";

export interface FrameXmlTextRun {
  readonly text: string;
  /** CSS colour of the run, `#rrggbbaa`, when a colour escape was open. */
  readonly color?: string | undefined;
  /** In-game message frames retain the Lua hyperlink payload; glue text omits it. */
  readonly hyperlink?: string | undefined;
}

const HEX = /^[0-9a-fA-F]{8}$/;

/** The last whole number written in `text`, the one a `|4` plural agrees with. */
function lastNumber(text: string): number | undefined {
  const match = /(\d+)(?:[.,]\d+)?\D*$/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** One form of a `|4one:few:many;` (or `|4one:other;`) plural for `count`; see the header. */
function pluralForm(forms: readonly string[], count: number | undefined): string {
  const last = forms[forms.length - 1] ?? "";
  if (count === undefined || forms.length < 2) return last;
  if (forms.length === 2) return count === 1 ? forms[0]! : last;
  const hundreds = count % 100;
  const tens = hundreds % 10;
  if (hundreds >= 11 && hundreds <= 14) return forms[2]!;
  return tens === 1 ? forms[0]! : tens >= 2 && tens <= 4 ? forms[1]! : forms[2]!;
}

/** True while `at` points at a `|` that opens the named escape letter, either case. */
function escapeAt(text: string, at: number, letter: string): boolean {
  const next = text[at + 1];
  return next !== undefined && next.toLowerCase() === letter;
}

/**
 * One widget string split into coloured runs.
 *
 * Never throws. Runs with the same colour are merged as they are appended, so a string with no
 * escapes at all comes back as exactly one uncoloured run — which is what lets the renderer keep
 * its cheap `textContent` path for the overwhelming majority of widgets.
 */
export function parseFrameXmlText(text: string, preserveLinks = false): FrameXmlTextRun[] {
  // The client's own order: `SetText` resolves the `|3` declensions over the whole string first
  // (they may wrap a coloured or linked name), and the display escapes are read from the result.
  if (text.includes("|3")) text = expandFrameXmlDeclension(text);
  const runs: FrameXmlTextRun[] = [];
  const colors: string[] = [];
  let pending = "";
  let hyperlink: string | undefined;

  const flush = (): void => {
    if (pending === "") return;
    const color = colors[colors.length - 1];
    const last = runs[runs.length - 1];
    if (last && last.color === color && last.hyperlink === hyperlink) {
      runs[runs.length - 1] = { ...last, text: last.text + pending };
    } else runs.push({ text: pending, ...(color === undefined ? {} : { color }),
      ...(hyperlink === undefined ? {} : { hyperlink }) });
    pending = "";
  };

  let at = 0;
  while (at < text.length) {
    const character = text[at]!;
    if (character !== "|") {
      pending += character;
      at += 1;
      continue;
    }
    // `||` first: it is the escape for the escape character itself.
    if (text[at + 1] === "|") {
      pending += "|";
      at += 2;
      continue;
    }
    if (escapeAt(text, at, "c") && HEX.test(text.slice(at + 2, at + 10))) {
      const argb = text.slice(at + 2, at + 10).toLowerCase();
      flush();
      colors.push(`#${argb.slice(2)}${argb.slice(0, 2)}`);
      at += 10;
      continue;
    }
    if (escapeAt(text, at, "r")) {
      flush();
      colors.pop();
      at += 2;
      continue;
    }
    if (escapeAt(text, at, "n")) {
      pending += "\n";
      at += 2;
      continue;
    }
    if (escapeAt(text, at, "h")) {
      // Either half of a link: `|H…` opens one (the payload runs to the next `|h`) and a bare
      // `|h` closes the display text. Both are markers, so both simply disappear.
      const payload = text[at + 1] === "H" ? text.indexOf("|h", at + 2) : -1;
      if (preserveLinks) {
        flush();
        hyperlink = payload < 0 ? undefined : text.slice(at + 2, payload);
      }
      at = payload < 0 ? at + 2 : payload + 2;
      continue;
    }
    if (escapeAt(text, at, "t")) {
      // `|T…|t`: an inline icon opens with `|T` and closes with `|t`. A stray `|t` is just dropped.
      const close = text[at + 1] === "T" ? text.indexOf("|t", at + 2) : -1;
      at = close < 0 ? at + 2 : close + 2;
      continue;
    }
    if (text[at + 1] === "4") {
      // Unterminated, it is shown as written, like any other malformed escape.
      const close = text.indexOf(";", at + 2);
      if (close >= 0) {
        let before = pending;
        for (let index = runs.length - 1; index >= 0 && !/\d/.test(before); index -= 1) before = runs[index]!.text + before;
        pending += pluralForm(text.slice(at + 2, close).split(":"), lastNumber(before));
        at = close + 1;
        continue;
      }
    }
    // Not an escape this build knows. Keep the pipe as written.
    pending += character;
    at += 1;
  }
  flush();
  return runs;
}

/** The same string with every escape resolved and no colour — what a plain reader sees. */
export function plainFrameXmlText(text: string): string {
  let joined = "";
  for (const run of parseFrameXmlText(text)) joined += run.text;
  return joined;
}

/** Whether a string carries anything the parser would change. Cheap enough to call per frame. */
export function hasFrameXmlEscapes(text: string): boolean {
  return text.includes("|");
}
