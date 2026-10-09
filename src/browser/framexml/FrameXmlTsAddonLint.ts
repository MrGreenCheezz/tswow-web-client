/**
 * A hint to TSWoW module authors about a call that fails in the original client too (plan item 9.09).
 *
 * TypeScriptToLua turns `(_G as any).Name(…)` into `_G:Name(…)`: the method-call form passes `_G`
 * itself as the first argument, so a global function declared without `this: void` receives the
 * wrong arguments — retail-talents' `StaticPopup_Show(…)` looked up `StaticPopupDialogs[_G]` and
 * opened nothing, in Wow.exe as well (WORK_PLAN 0.5). The owner's rule (29.09): this client runs
 * such a call exactly as Wow.exe does and only says where it is. So the TSWoW blocks' Lua is scanned
 * once, with the corpus, for `_G:Name(`, `_G:Name "…"` and `_G:Name {…}` in code — not in comments or
 * strings — and each is reported with its file and line; nothing is changed.
 */

export interface FrameXmlGlobalSelfCall {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

/** The long-bracket level at `index` (`[[` → 0, `[==[` → 2), or -1. */
function longBracket(source: string, index: number): number {
  if (source[index] !== "[") return -1;
  let level = 0;
  let at = index + 1;
  while (source[at] === "=") { level++; at++; }
  return source[at] === "[" ? level : -1;
}

/** Every `_G:Name` method call in the code of one Lua source. */
export function frameXmlGlobalSelfCalls(source: string, file: string): FrameXmlGlobalSelfCall[] {
  const found: FrameXmlGlobalSelfCall[] = [];
  let line = 1;
  let index = 0;
  const length = source.length;
  const skipTo = (end: number): void => {
    for (let at = index; at < end && at < length; at++) if (source[at] === "\n") line++;
    index = Math.min(end, length);
  };
  while (index < length) {
    const char = source[index]!;
    if (char === "\n") { line++; index++; continue; }
    if (char === "-" && source[index + 1] === "-") {
      const level = longBracket(source, index + 2);
      if (level >= 0) {
        const close = source.indexOf(`]${"=".repeat(level)}]`, index + 4 + level);
        skipTo(close < 0 ? length : close + level + 2);
      } else {
        const end = source.indexOf("\n", index);
        index = end < 0 ? length : end;
      }
      continue;
    }
    if (char === "[") {
      const level = longBracket(source, index);
      if (level >= 0) {
        const close = source.indexOf(`]${"=".repeat(level)}]`, index + 2 + level);
        skipTo(close < 0 ? length : close + level + 2);
        continue;
      }
    }
    if (char === "\"" || char === "'") {
      let at = index + 1;
      while (at < length && source[at] !== char && source[at] !== "\n") at += source[at] === "\\" ? 2 : 1;
      skipTo(at + 1);
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      let end = index + 1;
      while (end < length && IDENTIFIER_PART.test(source[end]!)) end++;
      const word = source.slice(index, end);
      const before = index > 0 ? source[index - 1]! : "";
      if (word === "_G" && before !== "." && before !== ":") {
        let at = end;
        while (source[at] === " " || source[at] === "\t") at++;
        if (source[at] === ":" && source[at + 1] !== ":") {
          at++;
          while (source[at] === " " || source[at] === "\t") at++;
          let nameEnd = at;
          if (IDENTIFIER_START.test(source[at] ?? "")) {
            while (nameEnd < length && IDENTIFIER_PART.test(source[nameEnd]!)) nameEnd++;
            let after = nameEnd;
            while (source[after] === " " || source[after] === "\t") after++;
            const next = source[after];
            if (next === "(" || next === "\"" || next === "'" || next === "{" || longBracket(source, after) >= 0) {
              found.push({ file, line, name: source.slice(at, nameEnd) });
            }
          }
        }
      }
      index = end;
      continue;
    }
    index++;
  }
  return found;
}

/** Whether a corpus chunk belongs to a TSWoW block (`Interface/FrameXML/TSAddons/<module>/…`). */
export function frameXmlIsTsAddonChunk(file: string): boolean {
  return /(?:^|\/)tsaddons\//i.test(file.replaceAll("\\", "/"));
}

/** The hint's words, for the addon error log. */
export function frameXmlGlobalSelfCallHint(call: FrameXmlGlobalSelfCall): string {
  return `${call.file}:${call.line}: _G:${call.name}(…) передаёт _G первым аргументом — в Wow.exe вызов `
    + `тоже не работает. Объявите функцию с this: void и вызывайте ${call.name}(…) без _G.`;
}
