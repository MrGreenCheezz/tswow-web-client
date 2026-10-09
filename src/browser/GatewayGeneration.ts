// The gateway's cache generation in tile URLs (10.12, browser half).
//
// The gateway serves twelve heavy per-tile and per-model routes (terrain, vmap environment, visual
// environment, collision and environment models, splat, terrain layers, horizon, minimap index,
// item and creature icons; src/gateway/CachePolicy.ts `tileCacheControl`) immutable for a year when
// the URL carries `g=<cacheGeneration>` equal to its own, and revalidated when `g` is another one.
// `cacheGeneration` is published in `/client/patch-status?summary=1`, which PatchChainChanged.ts reads
// at page start and again whenever it probes; that read files the value here, and every tile client
// passes its URL through `withGeneration`.
//
// - An older gateway publishes no `cacheGeneration`: nothing is appended, the URLs and the cache
//   lifetimes are exactly what they were.
// - Until the first read answers, URLs carry no `g` either (the route's previous lifetime), except
//   on a page the patch banner reloaded: there a one-off token stands in until the gateway speaks,
//   so nothing loaded in that window can come out of a cache entry the reload was meant to bypass.
// - A changed generation (gateway restart, dataset epoch, patch publish) changes every later URL,
//   so a tile fetched after the change can never be served from an immutable copy of the old one.
//   Nothing already loaded is fetched again because of it: the change costs no requests by itself.
//
// Cost on the request path: one `startsWith` and one string concatenation per request; nothing per
// frame.

interface GenerationState {
  /** Normalised origin of the gateway that published `generation` (no trailing slash). */
  origin: string | undefined;
  generation: string | undefined;
  /** Banner reload: stands in for `generation` until the gateway has answered once. */
  bypass: string | undefined;
  /** `?g=…` and `&g=…`, built once per change rather than once per request. */
  first: string;
  next: string;
}

const state: GenerationState = { origin: undefined, generation: undefined, bypass: undefined, first: "", next: "" };

/** What the gateway may put in `cacheGeneration` (CachePolicy.ts: hex nonce + hex epoch + 8 hex). */
const GENERATION_SHAPE = /^[0-9A-Za-z]{1,64}$/;

function normaliseOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

function rebuild(): void {
  const value = state.generation ?? state.bypass;
  state.first = value === undefined ? "" : `?g=${value}`;
  state.next = value === undefined ? "" : `&g=${value}`;
}

/** The generation the gateway at `origin` last published, if any. */
export function gatewayCacheGeneration(): string | undefined {
  return state.generation;
}

/**
 * Files what a `/client/patch-status` answer from `origin` said. `value` is its `cacheGeneration`
 * field: absent or malformed (a gateway built before 10.12) clears it, so no `g` is sent. Returns
 * whether the generation changed.
 */
export function noteGatewayCacheGeneration(origin: string, value: unknown): boolean {
  const normalised = normaliseOrigin(origin);
  const generation = typeof value === "string" && GENERATION_SHAPE.test(value) ? value : undefined;
  const changed = generation !== state.generation || normalised !== state.origin;
  state.origin = normalised;
  state.generation = generation;
  // The gateway has spoken: from here on it is its generation or nothing.
  state.bypass = undefined;
  rebuild();
  return changed;
}

/**
 * For a page started by the patch banner's reload: until the gateway answers, tile URLs carry a
 * token no cache entry can match. `origin` is the gateway the page will ask.
 */
export function beginGatewayCacheBypass(origin: string, token: string): void {
  if (state.generation !== undefined || !GENERATION_SHAPE.test(token)) return;
  const normalised = normaliseOrigin(origin);
  if (!normalised) return;
  state.origin = normalised;
  state.bypass = token;
  rebuild();
}

/** `url` with `g=<generation>` when it is a URL of the gateway that published one, else `url`. */
export function withGeneration(url: string): string {
  const origin = state.origin;
  if (state.first === "" || origin === undefined || !url.startsWith(origin)) return url;
  // `origin` followed by a port digit would be another origin (`:8090` vs `:80901`): the next
  // character must start the path.
  const after = url.charCodeAt(origin.length);
  if (after !== 47 /* / */ && after !== 63 /* ? */ && url.length !== origin.length) return url;
  return url + (url.indexOf("?", origin.length) < 0 ? state.first : state.next);
}

/** `?g=<token>` and nothing else: the only query `withGeneration` adds to a URL without one. */
const GENERATION_SEARCH = /^\?g=[0-9A-Za-z]{1,64}$/;

/**
 * `path` when it is an item or spell icon URL of the gateway at `origin` — what `ItemMetadata` hands
 * FrameXML as a texture name — else `undefined`. The query may only be the cache generation that
 * `withGeneration` put there: before 10.12 any query was refused, and an icon URL that now ends in
 * `?g=…` would otherwise be wrapped as `/texture?path=http://…` and draw nothing.
 */
export function trustedGatewayIconUrl(path: string, origin: string): string | undefined {
  // Nearly every name FrameXML resolves is a game path (`Interface\…`): no `new URL` that throws.
  if (!/^https?:/i.test(path)) return undefined;
  let absolute: URL;
  try {
    absolute = new URL(path);
  } catch {
    return undefined;
  }
  return absolute.origin === origin && absolute.username === "" && absolute.password === ""
    && (absolute.search === "" || GENERATION_SEARCH.test(absolute.search)) && absolute.hash === ""
    && /^(?:\/item-icon\/|\/spell-icon\/)\d+$/.test(absolute.pathname)
    ? absolute.href
    : undefined;
}

/** For tests. */
export function resetGatewayGeneration(): void {
  state.origin = undefined;
  state.generation = undefined;
  state.bypass = undefined;
  rebuild();
}
