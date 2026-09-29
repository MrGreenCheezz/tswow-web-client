// The startup patch order recovered from the local WoW 3.3.5a build 12340 executable.
// This is a diagnostic model, not the resource policy used by WebClient/TSWoW.

function normalizedDataPath(path) {
  return typeof path === "string" ? path.replaceAll("/", "\\").toLowerCase() : "";
}

/**
 * Rank a patch that the studied executable's startup path enumerates for `locale`.
 * Wildcard paths are compared as full case-insensitive Data-relative paths: a locale
 * patch wins over every root patch, even when its suffix sorts earlier.
 */
export function originalStartupPatchRank(relativeDataPath, locale = "ruRU") {
  const path = normalizedDataPath(relativeDataPath);
  const local = locale.toLowerCase();
  const localeWildcardPrefix = `${local}\\patch-${local}-`;
  const localeWildcardSuffix = path.startsWith(localeWildcardPrefix)
    ? path.slice(localeWildcardPrefix.length) : "";
  if (path === "alternate.mpq") return { phase: 3, path };
  if (/^patch-[^\\]\.mpq$/.test(path)
      || /^[^\\]\.mpq$/.test(localeWildcardSuffix)) {
    return { phase: 2, path };
  }
  if (path === "patch.mpq") return { phase: 1, path: "1" };
  if (path === `${local}\\patch-${local}.mpq`) return { phase: 1, path: "0" };
  return undefined;
}

function compareRank(left, right) {
  if (left.phase !== right.phase) return right.phase - left.phase;
  if (left.path === right.path) return 0;
  return left.path < right.path ? 1 : -1;
}

/**
 * Compare the WebClient winner with the highest startup patch holder of one known path.
 * This models the explicit patch chain only. Unknown TSWoW sources above the candidate
 * make the native result indeterminate; base archives are below every modeled patch.
 */
export function compareOriginalPatchWinner(copies, locale = "ruRU") {
  const webClientWinner = copies[0] ?? null;
  const ranked = copies
    .map((copy) => ({ copy, rank: originalStartupPatchRank(copy.relativeDataPath, locale) }))
    .filter((item) => item.rank)
    .sort((left, right) => compareRank(left.rank, right.rank));
  const originalPatchWinner = ranked[0]?.copy ?? null;

  if (!originalPatchWinner || !webClientWinner) {
    return { status: "indeterminate", webClientWinner, originalPatchWinner };
  }
  if (!originalStartupPatchRank(webClientWinner.relativeDataPath, locale)) {
    return { status: "indeterminate", webClientWinner, originalPatchWinner };
  }
  const status = normalizedDataPath(originalPatchWinner.relativeDataPath)
    === normalizedDataPath(webClientWinner.relativeDataPath) ? "same" : "different";
  return { status, webClientWinner, originalPatchWinner };
}
