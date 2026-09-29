/**
 * The ruRU client's `|3-N(word)` declension, ported from its executable.
 *
 * GlobalStrings writes a Russian case into a string with `|3-N(…)`: `SET_FRIENDNOTE_LABEL` is
 * «Заметка о |3-5(%s):», `TRADE_WITH_QUESTION` «Предложить обмен |3-2(%s)?», `PLAYER_LEVEL`
 * «%2$s, |3-6(%3$s) %1$s-го уровня». 311 GlobalStrings lines carry one (cases 1–8 in this
 * client), and until this the renderer kept the word as written — «Заметка о Аэлинда:».
 *
 * Everything below was read out of the 3.3.5a (12340) ruRU `Wow.exe` (`F:/Circle`, the same image
 * as `CleanWow.exe`) with `dumpbin /disasm`; the addresses are that image's:
 *
 * - `0x482110` is the string pass `SetText` runs for `|1`…`|4`, and `0x481E90` its `|3` handler:
 *   after `|3`, a digit makes the pair literal; `-` and a digit select the case number (anything
 *   else reads the `3` itself as the number); one `(` is skipped; the word runs to the first `)`
 *   — no nesting — or to the end of the string, and is replaced by `0x7E0A50`'s answer.
 * - `0x7E0A50` declines one word, in this order: a word that opens with `|` keeps its escapes and
 *   declines only the text after them (up to `]` or `|`, so `|cff…Имя|r` and `|H…|h[Имя]|h` work);
 *   a word whose first character is not in U+0400–U+04FF comes back unchanged (`0x76E270`); for
 *   cases 1–5 the player and pet name caches answer first with the declined names the server sent;
 *   then `DeclinedWord.dbc` + `DeclinedWordCases.dbc` (exact match, `strncmp`) — a listed word with
 *   no row for that case is left as it is; then, for a `Name-Realm` word, the name caches again with
 *   the part before `-`; and last, for cases 1–5 only, the rule engine below with gender 2 and
 *   declension set 0. Anything else is unchanged.
 * - `0x76E330` is the rule engine that the Lua `DeclineName(name, gender, set)` also calls:
 *   `0x76DE70` lower-cases the word (Latin, Latin-1, Œ, Cyrillic, Ё only) and picks the rule whose
 *   ending pattern is longest (first rule wins a tie, first matching pattern per rule), then cuts
 *   the rule's own ending off to get the stem; `0x76E0B0` appends one of 71 five-case suffix rows
 *   (`0xADC0A8`) and capitalises the first letter. `RULES` is the 55-record table at `0xADCE88`
 *   (9 patterns × 5 UTF-16 slots, gender, stem ending, the suffix row for each of 3 sets, where 71
 *   means none); every slot in both tables is a contiguous run, so each is written as a string.
 *
 * Measured over the real tables: «Аэлинда» → case 5 «Аэлинде», «Джайна» → case 2 «Джайне»,
 * «Кролик» → case 1 «Кролика». The DBC pair is the client's own dictionary for the 29,426 names,
 * professions, zones and schools it lists, and the only source of the special cases 6–10
 * (`Огонь` 6 → «урона от огня», `Штормград` 8 → «Штормград подвергается», `Паладин` 6 →
 * «паладин»); it reaches this module through `setFrameXmlDeclensionSource`, from the host.
 */

/** The two lookups the client makes outside its own rule tables. */
export interface FrameXmlDeclensionSource {
  /**
   * `DeclinedWord.dbc` + `DeclinedWordCases.dbc` for one exact word: the form for `grammaticalCase`,
   * `null` when the word is listed but has no row for that case (the client then keeps the word),
   * `undefined` when the word is not listed.
   */
  readonly word?: ((word: string, grammaticalCase: number) => string | null | undefined) | undefined;
  /**
   * The name caches: the five declined forms (genitive first) a player or pet name carries, as
   * `SMSG_NAME_QUERY_RESPONSE` delivers them on a realm with declined names; `undefined` otherwise.
   */
  readonly name?: ((name: string) => readonly string[] | undefined) | undefined;
}

let source: FrameXmlDeclensionSource = {};
/** The gateway fetch of the dictionary in flight or done; see `loadFrameXmlDeclensionDictionary`. */
let dictionaryLoad: Promise<boolean> | undefined;
/** Bumped by every replacement of the source, so a load that began before one installs nothing. */
let sourceGeneration = 0;

/**
 * Install (or with `undefined`, drop) the host's dictionary and name caches. Strings already drawn
 * were declined without them; `FrameXmlDomRenderer.refreshDeclinedText` draws those again. It
 * replaces a dictionary `loadFrameXmlDeclensionDictionary` installed, which a later load fetches anew.
 */
export function setFrameXmlDeclensionSource(next: FrameXmlDeclensionSource | undefined): void {
  source = next ?? {};
  dictionaryLoad = undefined;
  sourceGeneration += 1;
}

/** `0xADC0A8`: 71 rows of five case suffixes (genitive … prepositional). */
const SUFFIXES: readonly (readonly string[])[] = [
  ",,,,",
  "я,ю,я,ем,е",
  "ка,ку,ка,ком,ке",
  "ока,оку,ока,оком,оке",
  "ка,ку,ек,ком,ке",
  "ека,еку,ека,еком,еке",
  "ек,еку,ек,еком,еке",
  "ька,ьку,ька,ьком,ьке",
  "ека,еку,ека,еком,еке",
  "йка,йку,йка,йком,йке",
  "ека,еку,ека,еком,еке",
  "йца,йцу,йца,йцем,йце",
  "ца,цу,ца,цом,це",
  "еца,ецу,еца,ецом,еце",
  "и,е,у,ой,е",
  "и,и,ю,ей,и",
  "и,е,ю,ей,е",
  "ени,ени,я,енем,ени",
  "ого,ому,ого,ым,ом",
  "оя,ою,оя,оем,ое",
  "ого,ому,ого,ым,ом",
  "ыя,ыю,ыя,ыем,ые",
  "его,ему,его,им,ем",
  "ия,ию,ия,ием,ии",
  "ей,ей,ую,ей,ей",
  "ой,ой,ую,ой,ой",
  "аи,ае,аю,аей,ае",
  "ей,ей,юю,ей,ей",
  "яи,яе,яю,яей,яе",
  "ого,ому,ое,ым,ом",
  "я,ю,оя,оем,ое",
  "ои,ое,ою,оей,ое",
  "его,ему,его,им,ем",
  "ея,ею,ея,еем,ее",
  "еи,ее,ею,еей,ее",
  "а,у,о,ом,е",
  "я,ю,е,ем,е",
  "я,ю,е,ем,и",
  "я,ю,е,ем,е",
  "и,е,ю,ей,е",
  "я,ю,я,ем,е",
  "и,и,ь,ью,и",
  "и,е,у,ей,е",
  "ы,е,у,ей,е",
  "ы,е,у,ой,е",
  "а,у,а,ем,е",
  "а,у,а,ом,е",
  "а,у,а,ом,е",
  "егося,емуся,егося,имся,емся",
  "егося,емуся,егося,имся,емся",
  "ейся,ейся,уюся,ейся,ейся",
  "ихся,имся,ихся,имися,ихся",
  "ого,ому,ого,им,ом",
  "я,ю,ё,ём,е",
  "ня,ню,ня,нем,не",
  "еня,еню,еня,енем,ене",
  "ени,ени,ень,енью,ени",
  "ня,ню,ня,нем,не",
  "ёня,ёню,ёня,ёнем,ёне",
  "ёни,ёни,ёнь,ёнью,ёни",
  "тя,тю,тя,тем,те",
  "оти,оти,оть,отью,оти",
  "а,у,е,ем,е",
  "ька,ьку,ька,ьком,ьке",
  "ёка,ёку,ёка,ёком,ёке",
  "ьца,ьцу,ьца,ьцем,ьце",
  "еца,ецу,еца,ецом,еце",
  "ьца,ьцу,ьца,ьцом,ьце",
  "ёца,ёцу,ёца,ёцом,ёце",
  "ца,цу,ца,цом,це",
  "ёца,ёцу,ёца,ёцом,ёце",
].map((row) => row.split(","));

/** The "no suffix row" value in a rule's set column. */
const NO_SET = 71;

interface DeclensionRule {
  readonly patterns: readonly string[];
  /** 0 and 1 are the two genders `DeclineName` distinguishes; 2 applies to both. */
  readonly gender: number;
  /** The ending cut off the word before a suffix is appended. */
  readonly strip: string;
  /** The suffix row for each of the three declension sets. */
  readonly sets: readonly [number, number, number];
}

/** `0xADCE88`: the 55 rules, as `[patterns, gender, stem ending, set 0, set 1, set 2]`. */
const RULES: readonly DeclensionRule[] = ([
  ["и,у,ы,э,ю,аа", 2, "", 0, 71, 71],
  ["ай,ей,уй,эй,юй,яй,ёй", 0, "й", 1, 0, 71],
  ["ай,ей,уй,эй,юй,яй", 1, "й", 0, 1, 71],
  ["ок", 2, "ок", 2, 3, 0],
  ["чек,шек", 0, "ек", 4, 5, 0],
  ["чек", 1, "ек", 4, 6, 0],
  ["лек,мек,нек,рек,сек,тек", 2, "ек", 8, 7, 0],
  ["аек,еек,иек,уек,ёек", 2, "ек", 9, 10, 0],
  ["аец,еец,иец,оец,уец,ыец,эец,юец,яец", 2, "ец", 11, 0, 71],
  ["ец", 2, "ец", 12, 13, 0],
  ["ка,га,ха", 2, "а", 14, 0, 71],
  ["ия", 2, "я", 15, 0, 71],
  ["ея,ёя", 2, "я", 16, 0, 71],
  ["емя", 2, "я", 17, 0, 71],
  ["ой", 2, "ой", 18, 19, 0],
  ["ый", 2, "ый", 20, 21, 0],
  ["ий", 2, "ий", 22, 23, 52],
  ["чая,щая", 2, "ая", 24, 0, 71],
  ["ая", 2, "ая", 25, 26, 0],
  ["яя", 2, "яя", 27, 28, 0],
  ["ое", 0, "ое", 29, 30, 0],
  ["ое", 1, "ое", 29, 31, 0],
  ["ее", 0, "ее", 32, 33, 0],
  ["ее", 1, "ее", 32, 34, 0],
  ["о", 2, "о", 0, 35, 71],
  ["ие", 2, "е", 37, 0, 0],
  ["е", 2, "е", 0, 38, 71],
  ["я", 2, "я", 39, 0, 71],
  ["ь", 0, "ь", 40, 41, 0],
  ["ь", 1, "ь", 41, 40, 0],
  ["ча,ша,ща,жа", 2, "а", 42, 0, 71],
  ["ца", 2, "а", 43, 0, 71],
  ["а", 2, "а", 44, 0, 71],
  ["ч,щ,ж,ш,ж", 0, "", 45, 46, 0],
  ["ч,щ,ж,ш,ж", 1, "", 0, 45, 46],
  ["", 0, "", 47, 0, 71],
  ["", 1, "", 0, 47, 71],
  ["ийся", 2, "ийся", 48, 0, 71],
  ["ееся", 2, "ееся", 49, 0, 71],
  ["аяся", 2, "аяся", 50, 0, 71],
  ["иеся", 2, "иеся", 51, 0, 71],
  ["ё", 2, "ё", 0, 53, 71],
  ["ень", 0, "ень", 54, 55, 0],
  ["ень", 1, "ень", 0, 54, 56],
  ["ёнь", 0, "ёнь", 57, 58, 0],
  ["ёнь", 1, "ёнь", 0, 57, 59],
  ["оть", 0, "оть", 60, 61, 0],
  ["оть", 1, "оть", 61, 60, 0],
  ["ще,ше,че,це", 2, "е", 62, 0, 71],
  ["лёк,мёк,нёк,рёк,сёк,тёк", 2, "ёк", 63, 64, 0],
  ["аёк,еёк,иёк,уёк", 2, "ёк", 9, 10, 0],
  ["аёц,еёц,иёц,оёц,уёц,ыёц,эёц,юёц,яёц", 2, "ёц", 11, 0, 71],
  ["лец", 2, "ец", 65, 66, 0],
  ["лёц", 2, "ёц", 67, 68, 0],
  ["ёц", 2, "ёц", 69, 70, 0],
] as const).map(([patterns, gender, strip, set0, set1, set2]) => ({
  patterns: patterns ? patterns.split(",") : [],
  gender,
  strip,
  sets: [set0, set1, set2] as const,
}));

/** The rule `DeclineName` starts from before any pattern matches: 36 for gender 1, 35 otherwise. */
const DEFAULT_RULE_MALE = 35;
const DEFAULT_RULE_FEMALE = 36;

/** `0x7E1180`: the executable's own lower case — Latin, Latin-1 (0xD7 included), Œ and Cyrillic. */
function lowerCode(code: number): number {
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0xc0 && code <= 0xde) || (code >= 0x410 && code <= 0x42f)) {
    return code + 0x20;
  }
  if (code === 0x152) return 0x153;
  if (code === 0x401) return 0x451;
  return code;
}

/** `0x7E1130`: its upper case, the same ranges the other way. */
function upperCode(code: number): number {
  if ((code >= 0x61 && code <= 0x7a) || (code >= 0xe0 && code <= 0xfe) || (code >= 0x430 && code <= 0x44f)) {
    return code - 0x20;
  }
  if (code === 0x153) return 0x152;
  if (code === 0x451) return 0x401;
  return code;
}

function lowerWord(word: string): string {
  let lowered = "";
  for (let index = 0; index < word.length; index += 1) lowered += String.fromCharCode(lowerCode(word.charCodeAt(index)));
  return lowered;
}

function capitalised(text: string): string {
  return text.length === 0 ? text : String.fromCharCode(upperCode(text.charCodeAt(0))) + text.slice(1);
}

/** `0x76DE70`: the rule a word falls under and the length of its stem. */
function classify(word: string, gender: number): { readonly rule: number; readonly stem: number } {
  let rule = gender === 1 ? DEFAULT_RULE_FEMALE : DEFAULT_RULE_MALE;
  let stem = word.length;
  let best = 0;
  for (let index = 0; index < RULES.length; index += 1) {
    const candidate = RULES[index]!;
    if (candidate.gender !== 2 && gender !== 2 && gender !== candidate.gender) continue;
    // The first pattern that ends the word is the rule's match; a longer one than any rule before
    // it takes the word.
    const pattern = candidate.patterns.find((ending) => word.length >= ending.length && word.endsWith(ending));
    if (pattern === undefined || pattern.length <= best) continue;
    best = pattern.length;
    rule = index;
    // The stem ends where the rule's own ending stops matching, the mismatched letter included.
    const strip = candidate.strip;
    let kept = word.length;
    for (let at = strip.length - 1; at >= 0 && kept > 0; at -= 1) {
      kept -= 1;
      if (word.charCodeAt(kept) !== strip.charCodeAt(at)) break;
    }
    stem = kept;
  }
  return { rule, stem };
}

/**
 * `DeclineName(name, gender, set)` — `0x76E330`: the five case forms (genitive … prepositional),
 * or `undefined` where the client answers nothing (a set outside 0–2, or one the rule lacks).
 */
export function declineFrameXmlName(name: string, gender: number, set = 0): string[] | undefined {
  if (!Number.isInteger(set) || set < 0 || set > 2) return undefined;
  const word = lowerWord(name);
  const { rule, stem } = classify(word, gender);
  const row = RULES[rule]!.sets[set as 0 | 1 | 2];
  if (row === NO_SET) return undefined;
  // Row 0 declines nothing: every case is the word itself, first letter up, the rest lowered.
  if (row === 0) return Array.from({ length: 5 }, () => capitalised(word));
  const base = word.slice(0, stem);
  return SUFFIXES[row]!.map((suffix) => capitalised(base + suffix));
}

/** `GetNumDeclensionSets(name, gender)` — `0x76E2B0`: how many of the three sets the rule has. */
export function frameXmlDeclensionSetCount(name: string, gender: number): number {
  const { rule } = classify(lowerWord(name), gender);
  return RULES[rule]!.sets.filter((row) => row !== NO_SET).length;
}

/**
 * The Lua side of the two functions (`0x4DD020` and its FrameXML twin): the gender argument is a
 * `UnitSex` value looked up in `{2, 3, 1}` (`0x9F3CD0`) — male, female, neutral — anything else
 * meaning neutral, and the set is 1-based. `DeclineName` answers five strings or five nils.
 * GlueApi.ts binds both for the glue's ruRU declension step (`GlueLocalizationPost.lua`).
 */
export function frameXmlLuaDeclineName(name: string, sex: unknown, set: unknown): (string | undefined)[] {
  const forms = declineFrameXmlName(name, luaGender(sex), typeof set === "number" ? Math.trunc(set) - 1 : -1);
  return forms ?? [undefined, undefined, undefined, undefined, undefined];
}

/** `GetNumDeclensionSets(name, sex)` with the same argument mapping. */
export function frameXmlLuaDeclensionSetCount(name: string, sex: unknown): number {
  return frameXmlDeclensionSetCount(name, luaGender(sex));
}

function luaGender(sex: unknown): number {
  const index = typeof sex === "number" ? [2, 3, 1].indexOf(sex) : -1;
  return index < 0 ? 2 : index;
}

/** `0x76E270`: only a word that opens with a Cyrillic letter (U+0400–U+04FF) is declined. */
function cyrillic(word: string): boolean {
  const first = word.charCodeAt(0);
  return first >= 0x400 && first <= 0x4ff;
}

/** A declined name from the caches, or `undefined`. */
function cachedName(name: string, grammaticalCase: number): string | undefined {
  if (grammaticalCase < 1 || grammaticalCase > 5) return undefined;
  const forms = source.name?.(name);
  const form = forms?.[grammaticalCase - 1];
  return form === undefined || form === "" ? undefined : form;
}

/** `0x7E0A50`: one word in one case, the way the client's `|3` handler declines it. */
export function declineFrameXmlWord(word: string, grammaticalCase: number): string {
  if (word.startsWith("|")) return declineEscapedWord(word, grammaticalCase);
  if (!cyrillic(word)) return word;
  const cached = cachedName(word, grammaticalCase);
  if (cached !== undefined) return cached;
  const listed = source.word?.(word, grammaticalCase);
  if (listed !== undefined) return listed ?? word;
  const hyphen = word.indexOf("-");
  if (hyphen >= 0) {
    // `Name-Realm`: the caches know the name, and the realm part is kept as written.
    const prefix = cachedName(word.slice(0, hyphen), grammaticalCase);
    if (prefix !== undefined) return prefix + word.slice(hyphen);
  }
  if (grammaticalCase < 1 || grammaticalCase > 5) return word;
  return declineFrameXmlName(word, 2, 0)?.[grammaticalCase - 1] ?? word;
}

/**
 * The link path of `0x7E0A50`: every leading escape is copied (`|c` with its eight digits, `|H…|h`,
 * `|T…|t`, any other letter by itself), one `[` is kept, and only the text up to `]` or `|` is
 * declined; the rest follows as written.
 */
function declineEscapedWord(word: string, grammaticalCase: number): string {
  let at = 0;
  let copied = "";
  while (word[at] === "|") {
    const letter = word[at + 1];
    if (letter === undefined) return word;
    copied += "|";
    at += 1;
    if (letter === "C" || letter === "c") {
      const end = Math.min(word.length, at + 9);
      copied += word.slice(at, end);
      at = end;
    } else if (letter === "H" || letter === "T") {
      const close = word.indexOf(`|${letter === "H" ? "h" : "t"}`, at);
      if (close < 0) return copied + word.slice(at);
      copied += word.slice(at, close + 2);
      at = close + 2;
    } else {
      copied += letter;
      at += 1;
    }
  }
  if (word[at] === "[") {
    copied += "[";
    at += 1;
  }
  let end = at;
  while (end < word.length && word[end] !== "]" && word[end] !== "|") end += 1;
  return copied + declineFrameXmlWord(word.slice(at, end), grammaticalCase) + word.slice(end);
}

/**
 * `0x481E90`: every `|3` escape in `text` resolved, the rest of the string untouched. `||` is the
 * escaped pipe and is passed over whole, as the client's scan (`0x482110`) does.
 */
export function expandFrameXmlDeclension(text: string): string {
  let at = text.indexOf("|");
  if (at < 0) return text;
  let out = "";
  let from = 0;
  while (at >= 0 && at < text.length) {
    const next = text[at + 1];
    if (next === "|") {
      at = text.indexOf("|", at + 2);
      continue;
    }
    if (next !== "3" || isDigit(text[at + 2])) {
      at = text.indexOf("|", at + 1);
      continue;
    }
    out += text.slice(from, at);
    // `|3-N`: the number after the dash; without a dash and a digit, the `3` is the number.
    let cursor = text[at + 2] === "-" && isDigit(text[at + 3]) ? at + 3 : at + 1;
    let grammaticalCase = 0;
    while (isDigit(text[cursor])) {
      grammaticalCase = grammaticalCase * 10 + (text.charCodeAt(cursor) - 48);
      cursor += 1;
    }
    if (text[cursor] === "(") cursor += 1;
    let close = text.indexOf(")", cursor);
    const word = text.slice(cursor, close < 0 ? text.length : close);
    out += declineFrameXmlWord(word, grammaticalCase);
    if (close < 0) close = text.length - 1;
    from = close + 1;
    at = text.indexOf("|", from);
  }
  return out + text.slice(from);
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

/** FNV-1a over a word's UTF-8 bytes: the dictionary's key, so none of its words is ever decoded. */
const FNV_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** 65,536 buckets for the client's 29,426 words. */
const WORD_BUCKET_BITS = 16;
/** Words indexed between two looks at `FrameXmlDeclinedWordIndex.step`'s deadline. */
const WORD_INDEX_BATCH = 512;
/** One slice of the page's dictionary build; see `loadFrameXmlDeclensionDictionary`. */
const DICTIONARY_SLICE_MS = 3;

/** The client's dictionary, indexed a batch at a time; see `frameXmlDeclinedWordIndex`. */
export interface FrameXmlDeclinedWordIndex {
  /** Index words until `due()` answers true between two batches; true once every word is in. */
  step(due: () => boolean): boolean;
  /** `FrameXmlDeclensionSource.word`; it knows the words indexed so far. */
  readonly word: (word: string, grammaticalCase: number) => string | null | undefined;
}

/**
 * The client's dictionary from the two DBC files, as `0x7E08E0` builds it: words in record order,
 * each pointing at its first `DeclinedWordCases` row, which must follow the words' order (both files
 * in this client are sorted by word id); a word without rows is left out, so it falls through to the
 * rule engine. A word is matched on its exact bytes, the client's `strncmp`, through a hash of them:
 * decoding the 29,426 words into a string map was one 26-32 ms task on the rich route (headless
 * Chrome) and kept 3.6 MiB of strings; the typed index is 5.4-7.3 ms there, keeps 0.5 MiB, and is
 * built in batches (`step`). Case strings are decoded when first asked for.
 */
export function frameXmlDeclinedWordIndex(words: Uint8Array, cases: Uint8Array): FrameXmlDeclinedWordIndex {
  const wordTable = wdbc(words, "DeclinedWord", 2);
  const caseTable = wdbc(cases, "DeclinedWordCases", 4);
  // Open hashing in typed arrays: each bucket's newest word, each word's older bucket-mate, and
  // each word's first case row.
  const buckets = new Int32Array(1 << WORD_BUCKET_BITS).fill(-1);
  const older = new Int32Array(wordTable.count);
  const firstRow = new Int32Array(wordTable.count);
  let next = 0;
  let row = 0;
  const step = (due: () => boolean): boolean => {
    while (next < wordTable.count) {
      for (const end = Math.min(wordTable.count, next + WORD_INDEX_BATCH); next < end; next += 1) {
        const id = wordTable.field(next, 0);
        while (row < caseTable.count && caseTable.field(row, 1) < id) row += 1;
        if (row >= caseTable.count) {
          next = wordTable.count;
          break;
        }
        if (caseTable.field(row, 1) !== id) continue;
        const bucket = wordTable.hash(wordTable.field(next, 1)) >>> (32 - WORD_BUCKET_BITS);
        older[next] = buckets[bucket] ?? -1;
        buckets[bucket] = next;
        firstRow[next] = row;
      }
      if (next < wordTable.count && due()) return false;
    }
    return true;
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  // UTF-8 is at most three bytes per UTF-16 unit; grown for a longer word, never shrunk.
  let scratch = new Uint8Array(96);
  const forms = new Map<number, string>();
  const word = (text: string, grammaticalCase: number): string | null | undefined => {
    if (scratch.length < text.length * 3) scratch = new Uint8Array(text.length * 3);
    const length = encoder.encodeInto(text, scratch).written ?? 0;
    let hash = FNV_BASIS;
    for (let at = 0; at < length; at += 1) hash = Math.imul(hash ^ (scratch[at] ?? 0), FNV_PRIME);
    // A bucket runs newest first, so the last match is the word's first listing. The client's hash
    // keeps both of a duplicated word; which one a lookup meets first is not settled here. Three
    // words are listed twice in this client, each with one case per copy.
    let found = -1;
    for (let at = buckets[hash >>> (32 - WORD_BUCKET_BITS)] ?? -1; at >= 0; at = older[at] ?? -1) {
      if (wordTable.equals(wordTable.field(at, 1), scratch, length)) found = at;
    }
    if (found < 0) return undefined;
    const id = wordTable.field(found, 0);
    for (let index = firstRow[found] ?? caseTable.count; index < caseTable.count; index += 1) {
      if (caseTable.field(index, 1) !== id) return null;
      const listed = caseTable.field(index, 2);
      if (listed > grammaticalCase) return null;
      if (listed === grammaticalCase) {
        let form = forms.get(index);
        if (form === undefined) forms.set(index, form = caseTable.text(decoder, caseTable.field(index, 3)));
        return form;
      }
    }
    return null;
  };
  return { step, word };
}

/** The whole dictionary, indexed at once (tests, tools); the page builds it in slices. */
export function frameXmlDeclinedWordsFromDbc(
  words: Uint8Array,
  cases: Uint8Array,
): (word: string, grammaticalCase: number) => string | null | undefined {
  const index = frameXmlDeclinedWordIndex(words, cases);
  index.step(() => false);
  return index.word;
}

/**
 * The gateway's `/dbc/declined-words` body (src/gateway/DeclinedWords.ts): DeclinedWord.dbc's length
 * as a little-endian uint32, DeclinedWord.dbc, then DeclinedWordCases.dbc. Throws on any other shape.
 */
function declinedWordBodyIndex(body: Uint8Array): FrameXmlDeclinedWordIndex {
  if (body.byteLength < 4) throw new Error("the declined-word body is too short");
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
  if (4 + length > body.byteLength) throw new Error("the declined-word body is truncated");
  return frameXmlDeclinedWordIndex(body.subarray(4, 4 + length), body.subarray(4 + length));
}

/** `declinedWordBodyIndex`, indexed at once. */
export function frameXmlDeclinedWordsFromBody(
  body: Uint8Array,
): (word: string, grammaticalCase: number) => string | null | undefined {
  const index = declinedWordBodyIndex(body);
  index.step(() => false);
  return index.word;
}

/** A new task, so the page draws a frame between two slices of the dictionary build. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Fetch the client's dictionary from the gateway once per page and install it beside whatever name
 * caches the source already has. Resolves true once installed — the caller then redraws what is on
 * screen with `FrameXmlDomRenderer.refreshDeclinedText` — and false when the gateway has no such
 * route (a gateway built before it answers 404), cannot be reached, or sends another shape: the
 * rule engine alone declines then, cases 1-5 of single words. Only a success is kept; a later call
 * (the next mount) asks again, so a gateway restarted mid-session is picked up.
 */
export function loadFrameXmlDeclensionDictionary(
  gatewayOrigin: string,
  fetcher: (url: string) => Promise<Pick<Response, "ok" | "status" | "arrayBuffer">> = (url) => fetch(url),
): Promise<boolean> {
  if (dictionaryLoad) return dictionaryLoad;
  const generation = sourceGeneration;
  const load = (async () => {
    try {
      const response = await fetcher(new URL("/dbc/declined-words?v=1", gatewayOrigin).href);
      if (!response.ok) throw new Error(`declined-word gateway returned ${response.status}`);
      const index = declinedWordBodyIndex(new Uint8Array(await response.arrayBuffer()));
      // In slices of a few milliseconds, a task each: this lands while the world is being entered,
      // and the whole index would be one 5-7 ms task, more on the E-cores Chrome often runs on.
      // Rich route: three tasks, the longest 3.5-3.7 ms.
      for (;;) {
        const until = performance.now() + DICTIONARY_SLICE_MS;
        if (index.step(() => performance.now() >= until)) break;
        await nextTask();
        if (generation !== sourceGeneration) return false;
      }
      if (generation !== sourceGeneration) return false;
      source = { ...source, word: index.word };
      return true;
    } catch {
      return false;
    }
  })();
  dictionaryLoad = load;
  void load.then((installed) => {
    if (!installed && generation === sourceGeneration) dictionaryLoad = undefined;
  });
  return load;
}

function wdbc(bytes: Uint8Array, name: string, fields: number): {
  readonly count: number;
  field(record: number, column: number): number;
  text(decoder: TextDecoder, offset: number): string;
  /** FNV-1a of the string at `offset`, as the lookup hashes a word's UTF-8. */
  hash(offset: number): number;
  /** Whether the string at `offset` is exactly `other`'s first `length` bytes. */
  equals(offset: number, other: Uint8Array, length: number): boolean;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (bytes.byteLength < 20 || magic !== "WDBC") throw new Error(`${name}.dbc is not a WDBC file`);
  const count = view.getUint32(4, true);
  const fieldCount = view.getUint32(8, true);
  const size = view.getUint32(12, true);
  const strings = 20 + count * size;
  if (fieldCount !== fields || size !== fields * 4 || strings + view.getUint32(16, true) > bytes.byteLength) {
    throw new Error(`${name}.dbc has an unexpected layout (${fieldCount} fields, ${size} bytes)`);
  }
  return {
    count,
    field: (record, column) => view.getUint32(20 + record * size + column * 4, true),
    text: (decoder, offset) => {
      const start = strings + offset;
      let end = start;
      while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
      return decoder.decode(bytes.subarray(start, end));
    },
    hash: (offset) => {
      let hash = FNV_BASIS;
      for (let at = strings + offset; at < bytes.byteLength; at += 1) {
        const byte = bytes[at] ?? 0;
        if (byte === 0) break;
        hash = Math.imul(hash ^ byte, FNV_PRIME);
      }
      return hash;
    },
    equals: (offset, other, length) => {
      const start = strings + offset;
      if (start + length > bytes.byteLength) return false;
      for (let at = 0; at < length; at += 1) if (bytes[start + at] !== other[at]) return false;
      return (bytes[start + length] ?? 0) === 0;
    },
  };
}
