/**
 * 07.11 (3.18): an add-on's metadata as Wow.exe keeps it for GetAddOnMetadata and GetAddOnInfo's title and notes
 * (.runtime/re-2026-11-07/318).
 *
 * The TOC reader 0x005f86a0 seeds «Title» with the folder name, then reads its "##" lines in order. Only a key that
 * begins — any case, `_strnicmp` — with Title, Notes, Author, Version or X- is metadata (0x005f85d0); Interface,
 * Dependencies, SavedVariables, LoadOnDemand, DefaultState and the rest go to the add-on's own fields and are not.
 * A key ends at the first ':' and loses its trailing spaces; after its last '-' a locale code (enUS … ruRU, the table
 * 0x00ad2fe0, compared over four letters) makes it the client's own — the key without the suffix — or, for another
 * locale, drops the line; any other suffix stays part of the key. The value is the rest of the line past the ':'s and
 * spaces after the key. A later line replaces an earlier one with the same key, and keys are looked up in any case
 * (0x0055f4d0: SStrHashHT and `_strnicmp`).
 */

const METADATA_PREFIXES = ["title", "notes", "author", "version", "x-"] as const;
/** 0x00ad2fe0. */
const LOCALES = ["enus", "kokr", "frfr", "dede", "zhcn", "zhtw", "eses", "esmx", "ruru"] as const;

/** The metadata of a TOC, keyed by the lower-cased key. */
export function frameXmlAddonMetadata(source: string, folder: string, locale: string): ReadonlyMap<string, string> {
  const table = new Map<string, string>([["title", folder]]);
  const ownLocale = locale.toLowerCase();
  // Wow.exe keeps a CRLF line's CR in the value (the tokenizer 0x0076f1e0 splits at '\n' only); it is dropped here,
  // where it would reach the DOM's text.
  for (const raw of source.replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("##")) continue;
    let at = 2;
    while (line[at] === " ") at++;
    const rest = line.slice(at);
    const lower = rest.toLowerCase();
    if (!METADATA_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    let colon = rest.indexOf(":");
    if (colon < 0) colon = rest.length;
    let keyEnd = colon;
    const dash = rest.lastIndexOf("-", colon - 1);
    if (dash >= 0) {
      const code = LOCALES.findIndex((candidate) => lower.startsWith(candidate, dash + 1));
      if (code >= 0) {
        if (LOCALES[code] !== ownLocale) continue;
        keyEnd = dash;
      }
    }
    while (keyEnd > 0 && rest[keyEnd - 1] === " ") keyEnd--;
    let valueStart = colon;
    while (rest[valueStart] === ":" || rest[valueStart] === " ") valueStart++;
    table.set(rest.slice(0, keyEnd).toLowerCase(), rest.slice(valueStart));
  }
  return table;
}

/**
 * The order 0x005f79a0 sorts the add-on list in (qsort with 0x005f7910): the titles, `_strnicmp` — A–Z folded to
 * a–z, then byte order, which for UTF-8 is code point order.
 */
export function compareFrameXmlAddonTitles(left: string, right: string): number {
  const fold = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const a = [...fold(left)];
  const b = [...fold(right)];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
