/**
 * HTTP cache classes for gateway answers (10.12).
 *
 * Before this, 24 `/dbc/*` answers carried `public, max-age=3600` and the heavy tile routes
 * `max-age=3600`/`86400`: after a `build data` the browser went on using the old tables for up to an
 * hour and the old tiles for up to a day, and the patch banner's `location.reload()` revalidates the
 * page, not its sub-resources. Three classes replace the literals:
 *
 * - `dataset` — answers built in memory from the dataset (the `/dbc/*` tables). Revalidated on
 *   every use (`max-age=0, must-revalidate`) with a strong ETag that names what they are built from
 *   (`servedIdentity`: the gateway's code, the dataset fingerprint, the configuration). Every such
 *   answer is a function of the gateway's code, the memoised dataset indexes and the URL; the indexes
 *   are dropped exactly when the fingerprint moves. So the tag can be compared **before** the route
 *   runs: a match is a 304 that never builds the body.
 * - `tile` — heavy per-tile and per-model answers. With `g=<cacheGeneration>` in the URL equal to
 *   this gateway's generation the answer is immutable for a year; a `g` from another generation is
 *   revalidated (`max-age=0`), and a URL without `g` keeps the route's previous lifetime, so a
 *   browser that has not learned `g` yet behaves exactly as before.
 * - `content` — URLs that carry the hash of their bytes: immutable.
 *
 * 25.10 (serve S2): until then the tag and `g` carried a random per-process nonce and the fingerprint's
 * epoch (which restarts at 0), so every gateway restart turned over every player's cache. They now name
 * the served inputs (`servedIdentity`), which survive a restart that changed none of them.
 *
 * `Vary: Origin` on the revalidated classes: the answer echoes the caller's Origin in
 * `access-control-allow-origin`, so a shared cache must not hand one origin's copy to another.
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * Bumped when the tag layout changes, so an old browser copy never matches a new tag by accident.
 * 25.10 (serve S2): `d2` — the tag and `g` name what is served, not the process.
 */
export const CACHE_TAG_SCHEMA = "d2";

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "public, max-age=0, must-revalidate";
/** The lifetimes tile routes had before 10.12, kept for a URL without `g` (an older page). */
export const LEGACY_TILE_HOUR = "public, max-age=3600";
export const LEGACY_TILE_DAY = "public, max-age=86400";

/**
 * A per-process random part, used only when nothing on disk vouches for what is served (no dataset or
 * archive walk): then a restart may serve anything, and tags and generations must not survive it.
 */
export function processCacheNonce(): string {
  return randomBytes(6).toString("hex");
}

/**
 * 25.10 (serve S2): what every `dataset` and `tile` answer is a function of.
 *
 * 10.12 drew a random nonce per process because "a restart may be new code", and counted the dataset's
 * epoch because a walk that sees a change must move the tag. Both guarantees are kept by naming the
 * inputs themselves instead of the process:
 *
 * - `codeIdentity` — a digest of the gateway's compiled modules (AssetGeneration.ts `gatewayCodeIdentity`):
 *   new code that could build a different body or shape is a new identity.
 * - `toolsIdentity` — a digest of the generator scripts that publish the tile caches (`tools/*.mjs`), so
 *   a changed generator invalidates what it may now publish differently.
 * - `configIdentity` — the directories and startup flags the routes read (`servedConfigIdentity`).
 * - `packagesIdentity` — the lock file: the installed packages the gateway and generators import.
 * - `dataTreeIdentity` — names, sizes and mtimes of the raw `maps/` and `vmaps/` trees, taken at startup
 *   (`/terrain` and the vmap routes serve those files as they are; no fingerprint half covers them).
 * - `salt` — `GATEWAY_CACHE_SALT`: the owner's manual bump when anything else slipped through.
 * - `dbcHash`, `archivesHash`, `chain` — the dataset fingerprint as it stands for this request; they move
 *   exactly when the epoch moved (`DatasetFingerprint`), and are the same after a restart.
 * - `patchGeneration` — the archive generation this process selected at startup (PatchStatus.ts).
 *
 * With neither half of the fingerprint known (no dataset or client watched) nothing vouches for the bytes:
 * `nonce` is then part of the identity, which is exactly 10.12's behaviour.
 */
export interface ServedIdentityInput {
  readonly codeIdentity: string;
  readonly toolsIdentity: string | undefined;
  readonly configIdentity: string;
  readonly packagesIdentity?: string | undefined;
  readonly dataTreeIdentity?: string | undefined;
  readonly salt?: string | undefined;
  readonly dbcHash: string | undefined;
  readonly archivesHash: string | undefined;
  readonly chain: string | undefined;
  readonly patchGeneration: string;
  readonly nonce: string;
}

/** 20 hex characters, inside the browser's `g` shape (GatewayGeneration.ts `GENERATION_SHAPE`). */
export function servedIdentity(input: ServedIdentityInput): string {
  const vouched = input.dbcHash !== undefined || input.archivesHash !== undefined;
  return createHash("sha1").update([
    CACHE_TAG_SCHEMA, `code:${input.codeIdentity}`, `tools:${input.toolsIdentity ?? "none"}`,
    `config:${input.configIdentity}`, `packages:${input.packagesIdentity ?? "none"}`,
    `data:${input.dataTreeIdentity ?? "none"}`, `salt:${input.salt ?? ""}`, `dbc:${input.dbcHash ?? "none"}`, `archives:${input.archivesHash ?? "none"}`,
    `chain:${input.chain ?? "none"}`, `patches:${input.patchGeneration}`, `process:${vouched ? "any" : input.nonce}`,
  ].join("\n")).digest("hex").slice(0, 20);
}

/**
 * A digest of the options that name what the routes read: every `…Directory` / `…File` path and the
 * startup flag that changes a body (`coordinatedVisuals`). Functions, ports, origins and the per-launch
 * `localAssetNonce` are left out — they decide who may ask, not what is answered.
 */
export function servedConfigIdentity(options: object): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options).sort(([left], [right]) => left.localeCompare(right))) {
    if ((/(?:Directory|File)$/.test(key) && typeof value === "string")
      || (key === "coordinatedVisuals" && typeof value === "boolean")) parts.push(`${key}=${String(value)}`);
    // `audioDbcDirectory: null` switches the audio overlay off, which absent does not.
    else if (/(?:Directory|File)$/.test(key) && value === null) parts.push(`${key}=null`);
  }
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 20);
}

/** The strong validator of every `dataset` answer served under this identity. */
export function datasetEtag(identity: string): string {
  return `"${CACHE_TAG_SCHEMA}-${identity}"`;
}

/**
 * The value a browser puts in `g=` to make tile answers immutable: the served identity, so it changes
 * with new code or generators, a dataset or archive change, or a new patch generation — and not with a
 * restart that changed none of them.
 */
export function cacheGeneration(identity: string): string {
  return identity;
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

/**
 * 25.10 (serve S2): the validator ContentEtag.ts gives a 200 that has none — its size and a digest of its
 * bytes, `"c1-<size>-<sha1/16>"`: the same after a restart, moved by any rewrite.
 */
export function contentEtag(data: Uint8Array): string {
  return `"c1-${data.byteLength.toString(16)}-${createHash("sha1").update(data).digest("hex").slice(0, 16)}"`;
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
