/**
 * HTTP cache classes for gateway answers (10.12).
 *
 * Before this, 24 `/dbc/*` answers carried `public, max-age=3600` and the heavy tile routes
 * `max-age=3600`/`86400`: after a `build data` the browser went on using the old tables for up to an
 * hour and the old tiles for up to a day, and the patch banner's `location.reload()` revalidates the
 * page, not its sub-resources. Three classes replace the literals:
 *
 * - `dataset` — answers built in memory from the dataset (the `/dbc/*` tables). Revalidated on
 *   every use (`max-age=0, must-revalidate`) with a strong ETag that names this *process* and the
 *   dataset fingerprint's epoch. Every such answer is a function of the gateway's code, the memoised
 *   dataset indexes and the URL; the indexes are dropped exactly when the epoch moves, and a restart
 *   (new code) draws a new process nonce. So the tag can be compared **before** the route runs: a
 *   match is a 304 that never builds the body.
 * - `tile` — heavy per-tile and per-model answers. With `g=<cacheGeneration>` in the URL equal to
 *   this process's generation the answer is immutable for a year; a `g` from another generation is
 *   revalidated (`max-age=0`), and a URL without `g` keeps the route's previous lifetime, so a
 *   browser that has not learned `g` yet behaves exactly as before.
 * - `content` — URLs that carry the hash of their bytes: immutable.
 *
 * `Vary: Origin` on the revalidated classes: the answer echoes the caller's Origin in
 * `access-control-allow-origin`, so a shared cache must not hand one origin's copy to another.
 */

import { randomBytes } from "node:crypto";

/** Bumped when the tag layout changes, so an old browser copy never matches a new tag by accident. */
export const CACHE_TAG_SCHEMA = "d1";

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "public, max-age=0, must-revalidate";
/** The lifetimes tile routes had before 10.12, kept for a URL without `g` (an older page). */
export const LEGACY_TILE_HOUR = "public, max-age=3600";
export const LEGACY_TILE_DAY = "public, max-age=86400";

/** A per-process random part for tags and generations: a restart may serve different code. */
export function processCacheNonce(): string {
  return randomBytes(6).toString("hex");
}

/** The strong validator of every `dataset` answer from this process at this dataset epoch. */
export function datasetEtag(nonce: string, epoch: number): string {
  return `"${CACHE_TAG_SCHEMA}-${nonce}-${epoch.toString(16)}"`;
}

/**
 * The value a browser puts in `g=` to make tile answers immutable: changes with a restart, a new
 * dataset epoch (DBC or archive change) or a new patch generation.
 */
export function cacheGeneration(nonce: string, epoch: number, patchGeneration: string): string {
  return `${nonce}${epoch.toString(16)}${patchGeneration.slice(0, 8)}`;
}

/**
 * `If-None-Match` against one tag, with the weak comparison RFC 9110 §13.1.2 asks for: `W/` is
 * ignored (a compressing proxy weakens tags) and `*` matches anything.
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const bare = etag.startsWith("W/") ? etag.slice(2) : etag;
  for (const value of (Array.isArray(header) ? header.join(",") : header).split(",")) {
    const candidate = value.trim();
    if (candidate === "*") return true;
    if ((candidate.startsWith("W/") ? candidate.slice(2) : candidate) === bare) return true;
  }
  return false;
}

/** Headers of a `dataset` answer (200 or 304). */
export function datasetCacheHeaders(etag: string): Record<string, string> {
  return { "cache-control": REVALIDATE, etag, vary: "Origin" };
}

/**
 * `cache-control` of a `tile` answer for this request's `g`. `legacy` is the lifetime the route
 * had before 10.12, kept for URLs that carry no `g`.
 */
export function tileCacheControl(requested: string | null, current: string, legacy: string): string {
  if (requested === null) return legacy;
  return requested === current ? IMMUTABLE : REVALIDATE;
}

/** The `/dbc/*` answers that used `max-age=3600` and are built only from the dataset. */
const DATASET_ROUTES: ReadonlySet<string> = new Set([
  "/dbc/spell-kit-sounds", "/dbc/sounds", "/dbc/spells", "/dbc/locks", "/dbc/factions",
  "/dbc/world-state-ui", "/dbc/battlegrounds", "/dbc/taxi", "/dbc/areas", "/dbc/reputation",
  "/dbc/slot-prices", "/dbc/barber-styles", "/dbc/barber-cost", "/dbc/character-stats", "/dbc/talents",
  "/dbc/gameobjects", "/dbc/transport-paths", "/dbc/liquid-types", "/dbc/loading-screens",
  "/dbc/ground-effects", "/dbc/character-creation", "/dbc/char-start-outfit", "/dbc/weapon-sounds",
]);

/** Whether `pathname` is one of the `dataset` routes (the set above plus `/dbc/light/<map>`). */
export function isDatasetCacheRoute(pathname: string): boolean {
  return DATASET_ROUTES.has(pathname) || /^\/dbc\/light\/\d{1,4}$/.test(pathname);
}
