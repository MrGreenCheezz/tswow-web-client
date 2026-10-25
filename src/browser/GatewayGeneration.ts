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
// - A changed generation (new gateway code or generators, a dataset or archive change, a patch publish;
//   25.10 serve S2: no longer a bare restart) changes every later URL,
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
  /** 22.10 (6.26): the restart-stable `visualGeneration` and `metadataGeneration` (gateway/AssetGeneration.ts). */
  visual: string | undefined;
  metadata: string | undefined;
  /** 23.10 (7.48): the gateway's HD texture generation (gateway/HdTextures.ts), absent when it serves none. */
  hd: string | undefined;
}

const state: GenerationState = {
  origin: undefined, generation: undefined, bypass: undefined, first: "", next: "", visual: undefined, metadata: undefined,
  hd: undefined, // 23.10 (7.48)
};

/** What the gateway may put in `cacheGeneration` (CachePolicy.ts `servedIdentity`: 20 hex since 25.10 serve S2). */
const GENERATION_SHAPE = /^[0-9A-Za-z]{1,64}$/;

function normaliseOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

function rebuild(): void {
  revision++; // 22.10 ARC-2 S4b
  rebuildQuery();
}

function rebuildQuery(): void {
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
  // 22.10 (6.26): another gateway's asset generations are not this one's.
  if (normalised !== state.origin) {
    state.visual = undefined;
    state.metadata = undefined;
    state.hd = undefined; // 23.10 (7.48)
  }
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

/**
 * 22.10 (6.26): files the restart-stable generations a `/client/patch-status` answer from `origin` carried
 * (`visualGeneration`, `metadataGeneration`); absent or malformed (an older gateway) clears each. Call after
 * `noteGatewayCacheGeneration` for the same answer. Returns whether either changed.
 */
export function noteGatewayAssetGenerations(origin: string, visual: unknown, metadata: unknown, hd?: unknown): boolean {
  const normalised = normaliseOrigin(origin);
  const nextVisual = normalised !== undefined && typeof visual === "string" && GENERATION_SHAPE.test(visual) ? visual : undefined;
  const nextMetadata = normalised !== undefined && typeof metadata === "string" && GENERATION_SHAPE.test(metadata)
    ? metadata : undefined;
  // 23.10 (7.48): `hdTextureGeneration`, absent while the gateway serves no HD set (or has them switched off).
  const nextHd = normalised !== undefined && typeof hd === "string" && GENERATION_SHAPE.test(hd) ? hd : undefined;
  const changed = nextVisual !== state.visual || nextMetadata !== state.metadata || nextHd !== state.hd
    || normalised !== state.origin;
  if (!changed) return false;
  state.origin = normalised;
  state.visual = nextVisual;
  state.metadata = nextMetadata;
  state.hd = nextHd;
  revision++;
  return true;
}

/** 23.10 (7.48): the HD texture generation the gateway last published, if any (HdEffectTextures.ts). */
export function gatewayHdTextureGeneration(): string | undefined {
  return state.hd;
}

/**
 * 23.10 (7.48): `url` with `hd=<hdTextureGeneration>` when it is a URL of the gateway that published one; the
 * gateway then answers from its HD set when the set holds the path (gateway/HdTextures.ts).
 */
export function withHdTextureGeneration(url: string): string {
  return appendParam(url, "hd", state.hd);
}

/** 22.10 (6.26): the visual generation the gateway last published, if any (persistent atlas keys). */
export function gatewayVisualGeneration(): string | undefined {
  return state.visual;
}

/** 22.10 (6.26): the metadata generation the gateway last published, if any (persistent display rows). */
export function gatewayMetadataGeneration(): string | undefined {
  return state.metadata;
}

/** 22.10 (6.26): the gateway origin those generations belong to. */
export function gatewayGenerationOrigin(): string | undefined {
  return state.origin;
}

function appendParam(url: string, name: string, value: string | undefined): string {
  const origin = state.origin;
  if (value === undefined || origin === undefined || !url.startsWith(origin)) return url;
  const after = url.charCodeAt(origin.length);
  if (after !== 47 /* / */ && after !== 63 /* ? */ && url.length !== origin.length) return url;
  return `${url}${url.indexOf("?", origin.length) < 0 ? "?" : "&"}${name}=${value}`;
}

/**
 * 22.10 (6.26): `url` with `vg=<visualGeneration>` when it is a URL of the gateway that published one: the gateway
 * then answers `/visual/*` and `/texture` immutable, so the browser keeps them across sessions and restarts.
 */
export function withVisualGeneration(url: string): string {
  return appendParam(url, "vg", state.visual);
}

/** 22.10 (6.26): `url` with `mg=<metadataGeneration>` (`/dbc/character-appearance`, `/dbc/creature-models`). */
export function withMetadataGeneration(url: string): string {
  return appendParam(url, "mg", state.metadata);
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

// ---- 22.10 ARC-2 S4b: the renderer's copy -------------------------------------------------------------
// The state above is one per JS realm. The page's is filled by PatchChainChanged.ts and read by its own clients
// (collision, icons, minimap); the renderer's clients (terrain, splat, ground cover, horizon) read their realm's,
// which takes the page's values pushed in RenderInputs.ts whenever they change. In the page both are one.

/** The page's generation state as plain data, with the revision of the last change. */
export interface GatewayGenerationPush {
  readonly revision: number;
  readonly origin: string | undefined;
  readonly generation: string | undefined;
  readonly bypass: string | undefined;
  /** 22.10 (6.26): absent from an older page's push. */
  readonly visual?: string | undefined;
  readonly metadata?: string | undefined;
  /** 23.10 (7.48): absent from an older page's push. */
  readonly hd?: string | undefined;
}

let revision = 0;
let lastPush: GatewayGenerationPush | undefined;

/** The current state; the same frozen record until it changes, so a frame allocates nothing. */
export function gatewayGenerationPush(): GatewayGenerationPush {
  if (lastPush === undefined || lastPush.revision !== revision) {
    lastPush = Object.freeze({ revision, origin: state.origin, generation: state.generation, bypass: state.bypass,
      visual: state.visual, metadata: state.metadata, hd: state.hd }); // 22.10 (6.26), 23.10 (7.48): hd
  }
  return lastPush;
}

/** The renderer's side: pushed state onto this realm's, without counting it as a change. */
export function applyGatewayGenerationPush(push: GatewayGenerationPush): void {
  state.origin = push.origin;
  state.generation = push.generation;
  state.bypass = push.bypass;
  state.visual = push.visual; // 22.10 (6.26)
  state.metadata = push.metadata;
  state.hd = push.hd; // 23.10 (7.48)
  rebuildQuery();
}

/** For tests. */
export function resetGatewayGeneration(): void {
  state.origin = undefined;
  state.generation = undefined;
  state.bypass = undefined;
  state.visual = undefined; // 22.10 (6.26)
  state.metadata = undefined;
  state.hd = undefined; // 23.10 (7.48)
  rebuild();
}
