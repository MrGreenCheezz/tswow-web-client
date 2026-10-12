/**
 * 3.53: the quest text markers Wow.exe expands before a quest window's text reaches Lua.
 *
 * The giver's pages and the quest log handed Lua the server's text verbatim, so the stock QuestFrame
 * and QuestLogFrame printed «Приветствую, $N.$B$BСлышишь зов…» — markers instead of the player.
 * Wow.exe runs every such text through one parser (`QuestTextParser.cpp`, 0x00579590) when it keeps
 * it: the giver's greeting, detail, progress and reward pages (0x0058c5a0, read back by
 * GetGreetingText/GetQuestText/GetProgressText/GetRewardText), the objectives (0x0058c720,
 * GetObjectiveText), and both strings of GetQuestLogQuestText (0x005e0340). The title is not parsed.
 *
 * The parser (0x00578f20) copies everything up to a `$`, skips any digits after it, and reads one
 * letter — case-insensitive except where noted:
 * - `B` a line break (the byte 0x0a at 0x009e64dc);
 * - `N` the player's name;
 * - `C`/`R` the player's class/race name; the lower-case letter passes it through `_strlwr`, which in
 *   the C locale lowers only the ASCII letters, so a ruRU name keeps its capital;
 * - `G` `<male>:<female>;` (0x00576cd0): leading spaces skipped, the chosen part's trailing spaces
 *   dropped; an optional third part (`<male>:<female>:C;` or `:R;`) only switches whose grammatical
 *   gender decides, and is never printed;
 * - `T` the same two-part choice (a PvP rank title would win, and 3.3.5 has none);
 * - anything else leaves the `$` and the letter standing (the parser appends "$" and goes on).
 * `D`, `E`, `K`, `W` and `A` (durations, numbers and achievement data from the marker's digits) do
 * not occur in quest text and are left standing too. Colour escapes and `|3-N(…)` declensions are
 * not the parser's: the FontString draws them.
 */
export interface FrameXmlQuestTextSubject {
  readonly name: string | undefined;
  readonly className: string | undefined;
  readonly raceName: string | undefined;
  readonly female: boolean;
}

/** `_strlwr` in the C locale: A–Z only. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * The `$G`/`$T` choice from `at` (just past the letter): the chosen part, and the index of the last
 * character the marker consumes (its `;`). Malformed — no `:` or no `;` after it — Wow.exe appends
 * nothing and its caller then steps over one more character, which `end` reproduces.
 */
function genderChoice(text: string, at: number, female: boolean, threePart: boolean):
  { readonly part: string; readonly end: number } {
  let start = at;
  while (text[start] === " ") start += 1;
  const colon = text.indexOf(":", start);
  if (start >= text.length || colon < 0) return { part: "", end: start };
  const semicolon = text.indexOf(";", colon);
  if (semicolon < 0) return { part: "", end: start };
  const second = threePart ? text.indexOf(":", colon + 1) : -1;
  const third = second >= 0 && second + 1 < semicolon ? second : -1;
  let from = start;
  let to = colon;
  if (female) {
    from = colon + 1;
    while (text[from] === " ") from += 1;
    to = third >= 0 ? third : semicolon;
  }
  return { part: text.slice(from, Math.max(from, to)).replace(/ +$/, ""), end: semicolon };
}

export function frameXmlQuestText(text: string, subject: FrameXmlQuestTextSubject): string {
  if (!text.includes("$")) return text;
  let out = "";
  let at = 0;
  for (;;) {
    const dollar = text.indexOf("$", at);
    if (dollar < 0 || dollar + 1 >= text.length) break;
    out += text.slice(at, dollar);
    let cursor = dollar + 1;
    while (cursor < text.length && text[cursor]! >= "0" && text[cursor]! <= "9") cursor += 1;
    const letter = text[cursor] ?? "";
    let value: string | undefined;
    let end = cursor;
    switch (letter) {
      case "B": case "b": value = "\n"; break;
      case "N": case "n": value = subject.name || undefined; break;
      case "C": case "c":
        value = subject.className ? (letter === "c" ? asciiLower(subject.className) : subject.className) : undefined;
        break;
      case "R": case "r":
        value = subject.raceName ? (letter === "r" ? asciiLower(subject.raceName) : subject.raceName) : undefined;
        break;
      case "G": case "g": case "T": case "t": {
        const choice = genderChoice(text, cursor + 1, subject.female, letter === "G" || letter === "g");
        value = choice.part;
        end = choice.end;
        break;
      }
      default: break;
    }
    if (value === undefined) {
      // Unknown, or a fact this reader has not got: the marker stays as it was written.
      out += text.slice(dollar, cursor + (letter ? 1 : 0));
      at = cursor + (letter ? 1 : 0);
      continue;
    }
    out += value;
    at = end + 1;
  }
  return out + text.slice(at);
}
