/**
 * What the in-world corpus asks of the host, measured from its own text.
 *
 * The glue slice could enumerate its C API by hand: seventy files, fourteen unanswered globals. The
 * in-world corpus cannot be enumerated by hand at all — measured here, `Interface\FrameXML` names
 * **1313** globals in call position that nothing in the corpus itself defines. So the stub table is
 * derived rather than written, and this module is the derivation.
 *
 * Why a *static* seed set instead of "manufacture a stub for every global that misses":
 * `_G["ActionButton" .. index]` is how FrameXML walks its own widgets, and it walks until it runs
 * out. A universal fallback answers that probe with a function, the probe reads as truthy, the next
 * line indexes it, and the file dies — the exact failure the glue widget layer already warns about
 * for methods (`GlueWidgets.ts`: "a universal fallback … would silently take the wrong branch").
 * A name the corpus *calls* and never *defines* is, by construction, a host function; a name it only
 * reads is not. That distinction is the whole discriminator, and it is a fact about the text.
 *
 * Nothing here executes Lua. The scan is a lexical pass whose only job is to sort names into
 * "the host owes this" and "leave it nil", and to count the call sites so the gold list has numbers
 * before a single chunk has run.
 */

/** One Lua chunk: a `.lua` file, or one inline `<Script>` body out of an XML file. */
export interface FrameXmlLuaChunk {
  readonly file: string;
  readonly source: string;
}

export interface FrameXmlStubPlan {
  /** Globals called but never defined by the corpus — the host's C-API budget. */
  readonly apiNames: ReadonlySet<string>;
  /** `:Name(` spellings the corpus never assigns itself — the widget-method budget. */
  readonly methodNames: ReadonlySet<string>;
  /** Static call sites per API name, highest first when iterated in insertion order. */
  readonly apiCallSites: ReadonlyMap<string, number>;
  readonly methodCallSites: ReadonlyMap<string, number>;
  /**
   * Every `:Name(` in the corpus, including the ones the attached-method rule removed.
   *
   * Kept because the rule has false negatives worth seeing: `SetAttribute` has 138 call sites and
   * is excluded only because `RestrictedFrames.lua` declares it on a proxy table, so the honest
   * inventory line for it is "138 sites, excluded, promoted by measurement" rather than "0 sites".
   */
  readonly allMethodCallSites: ReadonlyMap<string, number>;
  /** Names the corpus defines for itself; they are deliberately *not* stubbed. */
  readonly definedGlobals: number;
  /** Method names the corpus attaches to its own tables; also not stubbed. */
  readonly attachedMethods: number;
  readonly chunks: number;
}

/**
 * Lua's own vocabulary, plus the 5.1 compatibility layer `GlueLua.ts` already installs.
 *
 * These are excluded from the plan because they exist before the corpus runs. The shim list is not
 * re-derived here — it is the same set that module documents as measured against GlueXML, and a
 * name that is present costs nothing to exclude twice.
 */
const LUA_KEYWORDS: ReadonlySet<string> = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

const LUA_BASE: ReadonlySet<string> = new Set([
  "assert", "collectgarbage", "dofile", "error", "getmetatable", "ipairs", "load", "loadfile",
  "loadstring", "next", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset",
  "require", "select", "setmetatable", "tonumber", "tostring", "type", "unpack", "xpcall",
  "string", "table", "math", "os", "io", "debug", "coroutine", "package", "_G", "_VERSION",
  // 5.1 names 5.3 dropped. They are *not* stubbed as C API: either the VM answers them or the
  // corpus that needs them is measured as failing, which is the point of slice F1's item (3).
  "setfenv", "getfenv", "gcinfo", "newproxy",
]);

const GLUE_SHIMS: ReadonlySet<string> = new Set([
  "strlen", "strsub", "strupper", "strlower", "strfind", "strmatch", "strrep", "strbyte", "strchar",
  "format", "gsub", "gmatch", "gfind", "tinsert", "tremove", "tconcat", "sort", "getn",
  "abs", "ceil", "floor", "max", "min", "mod", "random", "sqrt", "date", "time", "clock",
  "strjoin", "strconcat", "strtrim", "strsplit", "strreplace", "wipe", "getglobal", "setglobal",
  "securecall", "issecure", "debuginfo", "seterrorhandler", "geterrorhandler", "frexp", "ldexp",
  "pow", "message",
]);

/** Names the plan never stubs, exported so a test can pin the boundary rather than re-derive it. */
export const FRAMEXML_PRE_EXISTING_NAMES: ReadonlySet<string> = new Set([
  ...LUA_BASE, ...GLUE_SHIMS,
]);

/**
 * Blank out comments and string literals so a regex pass sees code only.
 *
 * Not a Lua lexer, and it does not need to be: every construct that can *hide* an identifier is
 * either a comment or a string, and all four spellings of those (`--`, `--[=[`, quoted, `[=[`) are
 * consumed here. String bodies collapse to `""` rather than vanishing, so a call written as
 * `f"literal"` still reads as a call and the surrounding token boundaries do not move.
 */
export function stripLuaText(source: string): string {
  let out = "";
  let index = 0;
  const length = source.length;
  const longBracket = (at: number): string | undefined => {
    const match = /^\[(=*)\[/.exec(source.slice(at, at + 32));
    return match ? `]${match[1] ?? ""}]` : undefined;
  };
  while (index < length) {
    const char = source[index]!;
    if (char === "-" && source[index + 1] === "-") {
      const closing = longBracket(index + 2);
      if (closing) {
        const end = source.indexOf(closing, index + 2);
        index = end < 0 ? length : end + closing.length;
        out += "\n";
        continue;
      }
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? length : newline;
      continue;
    }
    if (char === '"' || char === "'") {
      index += 1;
      while (index < length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        const inner = source[index]!;
        index += 1;
        if (inner === char || inner === "\n") break;
      }
      out += '""';
      continue;
    }
    const closing = longBracket(index);
    if (closing) {
      const end = source.indexOf(closing, index);
      index = end < 0 ? length : end + closing.length;
      out += '""';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** `<Script>…</Script>` bodies written inline, i.e. every one without a `file=` attribute. */
export function frameXmlInlineScripts(xml: string): readonly string[] {
  const bodies: string[] = [];
  const pattern = /<Script\b(?![^>]*\bfile\s*=)[^>]*>([\s\S]*?)<\/Script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) bodies.push(match[1] ?? "");
  return bodies;
}

const GLOBAL_FUNCTION = /(^|\n)[ \t]*function[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;
const GLOBAL_ASSIGNMENT = /(^|\n)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[^=]/g;
const LOCAL_DECLARATION = /\blocal\b[ \t]+(?:function[ \t]+)?([A-Za-z_][A-Za-z0-9_, \t]*)/g;
const CALL_POSITION = /(^|[^\w.:])([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;
const METHOD_CALL = /:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;
/** `x.Name = `, `x:Name = ` and `function x.Name(` / `function x:Name(` — the corpus' own methods. */
const ATTACHED_METHOD = /[.:][ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*[A-Za-z_{"']/g;
const METHOD_DEFINITION = /\bfunction[ \t]+[A-Za-z_][A-Za-z0-9_.]*[.:]([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;

/**
 * Remove comments while retaining quoted strings.
 *
 * The ordinary scan deliberately erases strings because it only wants executable identifiers.
 * Export discovery is different: legacy libraries often publish themselves as
 * `_G[LIBRARY_MAJOR] = library`, where `LIBRARY_MAJOR` is a local string constant. Keeping the
 * literal lets us prove that the global is supplied by the add-on before the neutral API floor is
 * installed, without special-casing LibStub or any other library name.
 */
function stripLuaComments(source: string): string {
  let out = "";
  let index = 0;
  const longBracket = (at: number): string | undefined => {
    const match = /^\[(=*)\[/.exec(source.slice(at, at + 32));
    return match ? `]${match[1] ?? ""}]` : undefined;
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"' || char === "'") {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index]!;
        out += inner;
        index += 1;
        if (inner === "\\" && index < source.length) {
          out += source[index]!;
          index += 1;
        } else if (inner === quote || inner === "\n") break;
      }
      continue;
    }
    if (char === "-" && source[index + 1] === "-") {
      const closing = longBracket(index + 2);
      if (closing) {
        const end = source.indexOf(closing, index + 2);
        index = end < 0 ? source.length : end + closing.length;
        out += "\n";
        continue;
      }
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    const closing = longBracket(index);
    if (closing) {
      const end = source.indexOf(closing, index + closing.length);
      const until = end < 0 ? source.length : end + closing.length;
      out += source.slice(index, until);
      index = until;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const STRING_CONSTANT = /\b(?:local[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:,[^=\r\n]*)?=[ \t]*(["'])([A-Za-z_][A-Za-z0-9_]*)\2/g;
const LITERAL_GLOBAL_ASSIGNMENT = /\b_G[ \t]*\[[ \t]*(["'])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\][ \t]*=[^=]/g;
const LITERAL_SETGLOBAL = /\bsetglobal[ \t]*\([ \t]*(["'])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*,/g;

/** Globals an add-on publishes through the legacy `_G[...]`/`setglobal` forms. */
function indexedGlobalAssignments(source: string): ReadonlySet<string> {
  const code = stripLuaComments(source);
  const result = new Set<string>();
  let match: RegExpExecArray | null;
  LITERAL_GLOBAL_ASSIGNMENT.lastIndex = 0;
  while ((match = LITERAL_GLOBAL_ASSIGNMENT.exec(code)) !== null) result.add(match[2]!);
  LITERAL_SETGLOBAL.lastIndex = 0;
  while ((match = LITERAL_SETGLOBAL.exec(code)) !== null) result.add(match[2]!);

  const constants = new Map<string, string>();
  STRING_CONSTANT.lastIndex = 0;
  while ((match = STRING_CONSTANT.exec(code)) !== null) constants.set(match[1]!, match[3]!);
  for (const [variable, value] of constants) {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const indexed = new RegExp(`\\b_G[ \\t]*\\[[ \\t]*${escaped}[ \\t]*\\][ \\t]*=[^=]`);
    const setter = new RegExp(`\\bsetglobal[ \\t]*\\([ \\t]*${escaped}[ \\t]*,`);
    if (indexed.test(code) || setter.test(code)) result.add(value);
  }
  return result;
}

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/**
 * Derive the stub budget from the corpus' own text.
 *
 * Two passes, because order matters: a name defined in the last file is still defined for the first
 * one, so every definition in the whole corpus is collected before any call site is judged.
 */
export function frameXmlStubPlan(chunks: readonly FrameXmlLuaChunk[]): FrameXmlStubPlan {
  const stripped = chunks.map((chunk) => stripLuaText(chunk.source));
  const defined = new Set<string>();
  const attached = new Set<string>();
  for (let index = 0; index < stripped.length; index += 1) {
    const source = stripped[index]!;
    let match: RegExpExecArray | null;
    GLOBAL_FUNCTION.lastIndex = 0;
    while ((match = GLOBAL_FUNCTION.exec(source)) !== null) defined.add(match[2]!);
    GLOBAL_ASSIGNMENT.lastIndex = 0;
    while ((match = GLOBAL_ASSIGNMENT.exec(source)) !== null) defined.add(match[2]!);
    ATTACHED_METHOD.lastIndex = 0;
    while ((match = ATTACHED_METHOD.exec(source)) !== null) attached.add(match[1]!);
    METHOD_DEFINITION.lastIndex = 0;
    while ((match = METHOD_DEFINITION.exec(source)) !== null) attached.add(match[1]!);
    for (const name of indexedGlobalAssignments(chunks[index]!.source)) defined.add(name);
  }

  const apiCallSites = new Map<string, number>();
  const methodCallSites = new Map<string, number>();
  const allMethodCallSites = new Map<string, number>();
  for (const source of stripped) {
    // Locals are per chunk, because that is their scope. A file-local `function Update()` must not
    // suppress a *different* file's call to a global of the same name — and, more importantly, must
    // not be stubbed here, because its own chunk defines it.
    const locals = new Set<string>();
    let match: RegExpExecArray | null;
    LOCAL_DECLARATION.lastIndex = 0;
    while ((match = LOCAL_DECLARATION.exec(source)) !== null) {
      for (const part of (match[1] ?? "").split(",")) {
        const name = part.trim();
        if (name) locals.add(name);
      }
    }
    CALL_POSITION.lastIndex = 0;
    while ((match = CALL_POSITION.exec(source)) !== null) {
      const name = match[2]!;
      if (LUA_KEYWORDS.has(name) || FRAMEXML_PRE_EXISTING_NAMES.has(name)) continue;
      if (defined.has(name) || locals.has(name)) continue;
      bump(apiCallSites, name);
    }
    METHOD_CALL.lastIndex = 0;
    while ((match = METHOD_CALL.exec(source)) !== null) {
      const name = match[1]!;
      bump(allMethodCallSites, name);
      if (attached.has(name)) continue;
      bump(methodCallSites, name);
    }
  }

  const byCount = (entries: Map<string, number>): Map<string, number> =>
    new Map([...entries].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));

  const api = byCount(apiCallSites);
  const methods = byCount(methodCallSites);
  return {
    apiNames: new Set(api.keys()),
    methodNames: new Set(methods.keys()),
    apiCallSites: api,
    methodCallSites: methods,
    allMethodCallSites: byCount(allMethodCallSites),
    definedGlobals: defined.size,
    attachedMethods: attached.size,
    chunks: chunks.length,
  };
}
