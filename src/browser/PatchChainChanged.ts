// «Патчи TSWoW обновились»: the one thing a page can do when the gateway's patch latch closes.
//
// A TSWoW `build addon` / `build data` rewrites the client patches under a running gateway, and the
// gateway then answers 409 `{ error: "client_patch_chain_changed" }` on every client-media route —
// interface files, textures, models, sounds, the add-on list — until it is restarted (Gateway.ts,
// `isClientVisualProfileRoute`). Before this file the browser read that as a generic failure: the
// glue screen said «returned 409», the FrameXML mount said «FrameXML не загрузился», the add-on list
// silently became empty, and a texture just stayed white. Nothing told the owner that one restart
// and one reload fix all of it.
//
// So a latched answer is recognised wherever it lands and raises exactly one banner, with a Reload
// button and, while it is up, what the gateway says about itself (`/client/patch-status`): stale
// and waiting for a manual restart, stale with its supervisor waiting for the build to settle, gone
// (restarting), or back with a new generation (reload now). The helpers that read the gateway
// (GlueLoader, FrameXmlClientAddons) check explicitly and throw `PatchChainChangedError`; every
// other fetch path is covered by `installPatchChainWatch`, which wraps `fetch` once at page start
// and inspects a clone of a 409 only, so the ordinary request path pays one status comparison.
//
// Two ways past that are closed by asking the gateway instead of waiting for a 409 (`probePatchChain`,
// one `?summary=1` read, rate-limited). An <img> or <audio> load never passes through `fetch`: its
// 409 is seen in the resource-timing entries, or by the loader's error callback
// (`suspectPatchChainChange`). And a page that asked for nothing while the gateway was latched never
// meets a 409 at all — the opt-in supervisor then restarts the gateway under it, and the next asset
// comes from a generation the page did not boot with. So the page also asks when the tab comes back
// and, at most every ten seconds, while it keeps loading from the gateway, and compares generations.

export const PATCH_CHAIN_CHANGED = "client_patch_chain_changed";
export const PATCH_CHAIN_CHANGED_MESSAGE = "Патчи TSWoW обновились — перезапустите шлюз и обновите страницу";

/** Thrown by a gateway reader that got the latch; `route` is the path that answered it. */
export class PatchChainChangedError extends Error {
  readonly route: string;

  constructor(route: string) {
    super(PATCH_CHAIN_CHANGED_MESSAGE);
    this.name = "PatchChainChangedError";
    this.route = route;
  }
}

export function isPatchChainChangedError(error: unknown): error is PatchChainChangedError {
  return error instanceof PatchChainChangedError;
}

/** What the readers here need of a response; the injected test fetchers carry only this much. */
export interface PatchResponseLike {
  readonly status: number;
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

/**
 * Whether this answer is the gateway's patch latch. A 409 alone is not enough — only the body says
 * it is this 409 — and reading the body consumes it, so a caller that still needs it passes a clone.
 */
export async function isPatchChainChangedResponse(response: PatchResponseLike): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const body = typeof response.json === "function"
      ? await response.json()
      : JSON.parse(await response.text!()) as unknown;
    return typeof body === "object" && body !== null && (body as { error?: unknown }).error === PATCH_CHAIN_CHANGED;
  } catch {
    return false;
  }
}

/** For a gateway reader: raise the banner and throw when `response` is the latch; else nothing. */
export async function throwIfPatchChainChanged(response: PatchResponseLike, route: string): Promise<void> {
  if (!await isPatchChainChangedResponse(response)) return;
  reportPatchChainChanged(route);
  throw new PatchChainChangedError(route);
}

/** The cheap half of `/client/patch-status` (src/gateway/PatchStatus.ts `PatchStatusSummary`). */
export interface PatchStatusSummaryLike {
  readonly generation: string;
  readonly startedAt?: string;
  readonly stale: boolean;
  readonly changedAt?: string | null;
  readonly supervised?: boolean;
  /** Only in the full answer: `tools/patch-status.mjs --json` for the disk as it is now. */
  readonly client?: { readonly summaryLine?: unknown; readonly generation?: unknown } | null;
  readonly clientError?: string;
}

export type PatchStatusRead =
  | { readonly kind: "ok"; readonly status: PatchStatusSummaryLike }
  /** The gateway answers, but was built before `/client/patch-status` (404). */
  | { readonly kind: "unsupported" }
  /** Nothing answers: the gateway is down, or being restarted. */
  | { readonly kind: "unreachable"; readonly error: string };

export interface PatchStateDescription {
  readonly tone: "error" | "warning" | "ok" | "muted";
  readonly text: string;
  /** A reload would now load the new patches. */
  readonly reload: boolean;
}

const shortGeneration = (generation: string): string => generation.slice(0, 8);

function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return ` в ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * One sentence about where the page and the gateway stand, for the banner and the Diagnostics line.
 *
 * `boot` is the generation the gateway served when this page started (`undefined` = not known yet,
 * `null` = that gateway could not say). `pageLatched` is whether this page has met the 409 itself:
 * a gateway that answered it and now says it is not stale can only be a restarted one, even when
 * the old one was too old to report a generation to compare. Pure, so every case is a test.
 */
export function describePatchState(
  boot: string | null | undefined,
  read: PatchStatusRead,
  options: { readonly pageLatched?: boolean } = {},
): PatchStateDescription {
  if (read.kind === "unreachable") {
    return { tone: "warning", text: "Шлюз не отвечает — вероятно, перезапускается.", reload: false };
  }
  if (read.kind === "unsupported") {
    return {
      tone: "muted",
      text: "Шлюз собран до /client/patch-status: поколение патчей неизвестно; после сборки TSWoW перезапустите его (restart-gateway.bat).",
      reload: false,
    };
  }
  const status = read.status;
  if (status.stale) {
    const when = clockTime(status.changedAt);
    return status.supervised
      ? {
        tone: "warning",
        text: `Шлюз увидел новые патчи${when} и перезапустится сам, когда сборка закончится и в мире никого не останется. Затем обновите страницу.`,
        reload: false,
      }
      : {
        tone: "error",
        text: `Шлюз увидел новые патчи${when}: перезапустите шлюз (restart-gateway.bat), затем обновите страницу.`,
        reload: false,
      };
  }
  if (boot && status.generation !== boot) {
    return {
      tone: "error",
      text: `Шлюз уже отдаёт поколение патчей ${shortGeneration(status.generation)}, а страница загружена с ${shortGeneration(boot)} — обновите страницу.`,
      reload: true,
    };
  }
  if (options.pageLatched) {
    return {
      tone: "ok",
      text: `Шлюз перезапущен (поколение патчей ${shortGeneration(status.generation)}) — обновите страницу.`,
      reload: true,
    };
  }
  return boot
    ? { tone: "ok", text: `Поколение патчей ${shortGeneration(status.generation)} — как при загрузке страницы.`, reload: false }
    : { tone: "muted", text: `Шлюз отдаёт поколение патчей ${shortGeneration(status.generation)}.`, reload: false };
}

/* ---------------------------------------------------------------------------------------------
 * The page-wide watch and its banner
 * ------------------------------------------------------------------------------------------- */

interface BannerElements {
  root: HTMLElement;
  detail: HTMLElement;
  reload: HTMLButtonElement;
}

interface WatchState {
  origin: (() => string | undefined) | undefined;
  /** undefined: not asked yet · null: the gateway could not say · string: its generation at boot. */
  bootGeneration: string | null | undefined;
  reported: boolean;
  banner: BannerElements | undefined;
  poll: ReturnType<typeof setInterval> | undefined;
  fetch: typeof globalThis.fetch | undefined;
  now: () => number;
  /** When the gateway was last asked about itself outside the banner's own poll. */
  lastProbeAt: number;
  probing: Promise<boolean> | undefined;
  /** Undoes what `installPatchChainWatch` attached besides the fetch wrapper. */
  detach: (() => void)[];
}

const state: WatchState = {
  origin: undefined, bootGeneration: undefined, reported: false, banner: undefined, poll: undefined, fetch: undefined,
  now: Date.now, lastProbeAt: Number.NEGATIVE_INFINITY, probing: undefined, detach: [],
};

/** How often the banner asks the gateway where it is, while it is up. The summary costs no child. */
const BANNER_POLL_MS = 3_000;
/** While the page keeps loading from the gateway, it asks where the gateway stands at most this often. */
const ACTIVITY_PROBE_MS = 10_000;
/** A failed load, a 409 an <img> met, or the tab coming back asks sooner — once per burst. */
const SUSPECT_PROBE_MS = 2_000;
const STATUS_ROUTE = "/client/patch-status";
const WATCHED = Symbol.for("webclient.patchChainWatch");

/** The generation the gateway served when this page started, once known. */
export function bootPatchGeneration(): string | null | undefined {
  return state.bootGeneration;
}

/** Whether the latch has been seen by this page. */
export function patchChainChanged(): boolean {
  return state.reported;
}

/** `/client/patch-status`, `summary` for the cheap in-process half. Never throws. */
export async function readPatchStatus(
  origin: string,
  options: { readonly summary?: boolean; readonly fetch?: typeof globalThis.fetch } = {},
): Promise<PatchStatusRead> {
  const doFetch = options.fetch ?? state.fetch ?? globalThis.fetch.bind(globalThis);
  const url = new URL(STATUS_ROUTE, origin);
  if (options.summary) url.searchParams.set("summary", "1");
  let response: Response;
  try {
    response = await doFetch(url.href, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch (error) {
    return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 404) return { kind: "unsupported" };
  if (!response.ok) return { kind: "unreachable", error: `${url.pathname} answered ${response.status}` };
  try {
    const status = await response.json() as PatchStatusSummaryLike;
    if (typeof status?.generation !== "string" || typeof status.stale !== "boolean") {
      return { kind: "unreachable", error: `${url.pathname} answered an unknown shape` };
    }
    return { kind: "ok", status };
  } catch (error) {
    return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
}

// Collapsed, the banner is a 15 px tab hanging from the top centre: above the stock
// WorldStateAlwaysUpFrame (TOP, y -15) and clear of the minimap, buffs and unit frames, so a
// player the supervisor deliberately keeps in the world can play on under it. It opens again by
// itself once a reload would load the new patches.
const BANNER_CSS = `
.patch-chain-banner {
  position: fixed; z-index: 2147483000; top: 10px; left: 50%; transform: translateX(-50%);
  box-sizing: border-box; width: max-content; max-width: min(760px, calc(100vw - 24px));
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 9px 14px;
  border: 1px solid #c9a24a; border-radius: 4px; background: #15100af2; color: #f2ead7;
  box-shadow: 0 4px 18px #000c; font: 13px/1.4 Inter, "Segoe UI", system-ui, sans-serif;
  pointer-events: auto;
}
.patch-chain-banner strong { color: #ffd52b; font-weight: 700; }
.patch-chain-banner-detail { order: 1; flex: 1 1 100%; color: #d8ccb0; }
.patch-chain-banner-detail[data-tone="error"] { color: #ff9a8a; }
.patch-chain-banner-detail[data-tone="ok"] { color: #9fe0a8; }
.patch-chain-banner button { min-height: 0; margin-left: auto; padding: 4px 12px; border: 0; border-radius: 3px; }
.patch-chain-banner button[data-ready="true"] { outline: 2px solid #ffd52b; }
.patch-chain-banner .patch-chain-banner-collapse {
  margin-left: 0; background: transparent; color: #d8ccb0; border: 1px solid #6b5a33;
}
.patch-chain-banner .patch-chain-banner-pill { display: none; }
.patch-chain-banner[data-collapsed="true"] {
  top: 0; padding: 0; gap: 0; border-top: 0; border-radius: 0 0 4px 4px; box-shadow: 0 2px 6px #0009;
}
.patch-chain-banner[data-collapsed="true"] > * { display: none; }
.patch-chain-banner[data-collapsed="true"] > .patch-chain-banner-pill {
  display: block; min-height: 0; margin: 0; padding: 0 10px; border: 0; border-radius: 0;
  background: transparent; color: #ffd52b; font: 700 11px/14px Inter, "Segoe UI", system-ui, sans-serif;
  cursor: pointer;
}
`;

function setBannerCollapsed(collapsed: boolean): void {
  if (state.banner) state.banner.root.dataset["collapsed"] = String(collapsed);
}

function renderBanner(route: string, initial?: PatchStateDescription): void {
  if (state.banner || typeof document === "undefined" || !document.body) return;
  const style = document.createElement("style");
  style.setAttribute("data-patch-chain-banner", "true");
  style.textContent = BANNER_CSS;
  document.head?.append(style);
  const root = document.createElement("div");
  root.id = "patch-chain-banner";
  root.className = "patch-chain-banner";
  root.setAttribute("role", "alert");
  const title = document.createElement("strong");
  title.textContent = PATCH_CHAIN_CHANGED_MESSAGE;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Обновить страницу";
  reload.addEventListener("click", () => window.location.reload());
  const detail = document.createElement("span");
  detail.className = "patch-chain-banner-detail";
  detail.textContent = initial?.text ?? `Шлюз ответил 409 client_patch_chain_changed на ${route}.`;
  if (initial) detail.dataset["tone"] = initial.tone;
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "patch-chain-banner-collapse";
  collapse.textContent = "Свернуть";
  collapse.addEventListener("click", () => setBannerCollapsed(true));
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "patch-chain-banner-pill";
  pill.textContent = "Патчи обновились";
  pill.title = PATCH_CHAIN_CHANGED_MESSAGE;
  pill.addEventListener("click", () => setBannerCollapsed(false));
  root.append(title, reload, detail, collapse, pill);
  root.dataset["collapsed"] = "false";
  document.body.append(root);
  state.banner = { root, detail, reload };
}

async function refreshBanner(): Promise<void> {
  const origin = state.origin?.();
  const banner = state.banner;
  if (!origin || !banner) return;
  const description = describePatchState(
    state.bootGeneration, await readPatchStatus(origin, { summary: true }), { pageLatched: true },
  );
  banner.detail.textContent = description.text;
  banner.detail.dataset["tone"] = description.tone;
  // The moment a reload would help is the one moment a collapsed banner must be seen again.
  if (description.reload && banner.reload.dataset["ready"] !== "true") setBannerCollapsed(false);
  banner.reload.dataset["ready"] = String(description.reload);
}

/**
 * The latch was seen: say so once. Idempotent — the first texture that hits it raises the banner,
 * the next five hundred do nothing. `initial` is what a probe already knows, shown until the poll.
 */
export function reportPatchChainChanged(route: string, initial?: PatchStateDescription): void {
  if (state.reported) return;
  state.reported = true;
  console.warn(`[patches] ${PATCH_CHAIN_CHANGED_MESSAGE} (${initial ? initial.text : `409 ${PATCH_CHAIN_CHANGED} на ${route}`})`);
  renderBanner(route, initial);
  if (state.origin && state.banner && state.poll === undefined) {
    void refreshBanner();
    state.poll = setInterval(() => { void refreshBanner(); }, BANNER_POLL_MS);
  }
}

/**
 * Asks the gateway where it stands and raises the banner when this page is behind it: the gateway
 * is latched, or it serves a generation other than the one this page booted with (restarted under
 * it). At most one read in flight and one per `minIntervalMs`; resolves whether the latch is known.
 */
export function probePatchChain(route: string, minIntervalMs = SUSPECT_PROBE_MS): Promise<boolean> {
  if (state.reported) return Promise.resolve(true);
  if (state.probing) return state.probing;
  const origin = state.origin?.();
  const now = state.now();
  if (!origin || now - state.lastProbeAt < minIntervalMs) return Promise.resolve(false);
  state.lastProbeAt = now;
  const probing = readPatchStatus(origin, { summary: true }).then((read) => {
    if (state.probing === probing) state.probing = undefined;
    if (state.reported) return true;
    if (read.kind !== "ok") return false;
    const boot = state.bootGeneration;
    if (!read.status.stale && (typeof boot !== "string" || read.status.generation === boot)) return false;
    reportPatchChainChanged(route, describePatchState(boot, read, { pageLatched: true }));
    return true;
  });
  state.probing = probing;
  return probing;
}

/** The path of `url` when it is one of the gateway's, else undefined. */
function gatewayPath(url: string): string | undefined {
  const origin = state.origin?.();
  if (!origin) return undefined;
  try {
    const parsed = new URL(url, typeof location === "undefined" ? origin : location.href);
    return parsed.origin === new URL(origin).origin ? parsed.pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For a loader that does not go through `fetch` — THREE's TextureLoader (an <img>), an <audio>
 * element — and so never sees the latch's body: its error callback passes the URL that failed.
 * A gateway URL makes the page ask the gateway (rate-limited); anything else is not ours to judge.
 */
export function suspectPatchChainChange(url: string): void {
  if (state.reported) return;
  const path = gatewayPath(url);
  if (path) void probePatchChain(path, SUSPECT_PROBE_MS);
}

/** A gateway answer that was not a 409: at most every ten seconds, is it still the boot generation? */
function noteGatewayActivity(url: string): void {
  if (state.reported || state.now() - state.lastProbeAt < ACTIVITY_PROBE_MS) return;
  const path = gatewayPath(url);
  // The status reads themselves are gateway traffic too; counting them would keep an idle page asking.
  if (path && path !== STATUS_ROUTE) void probePatchChain(path, ACTIVITY_PROBE_MS);
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function routeOf(input: RequestInfo | URL): string {
  try {
    return new URL(requestUrl(input)).pathname;
  } catch {
    return String(input);
  }
}

interface ResourceEntryLike {
  readonly name: string;
  readonly initiatorType?: string;
  /** Resource Timing 2; 0 or absent where the browser does not expose it. */
  readonly responseStatus?: number;
}

/**
 * Resource-timing entries cover what `fetch` does not: an <img> TextureLoader request and a media
 * element answer 409 there too. `fetch` entries are left to the wrapper, which reads the body.
 */
export function notePatchResourceEntries(entries: readonly ResourceEntryLike[]): void {
  if (state.reported || entries.length === 0) return;
  for (const entry of entries) {
    if (entry.responseStatus !== 409 || entry.initiatorType === "fetch") continue;
    const path = gatewayPath(entry.name);
    if (path) {
      void probePatchChain(path, SUSPECT_PROBE_MS);
      return;
    }
  }
  noteGatewayActivity(entries[entries.length - 1]!.name);
}

function observeResources(): void {
  const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof Observer !== "function" || !(Observer.supportedEntryTypes ?? []).includes("resource")) return;
  try {
    const observer = new Observer((list) => {
      notePatchResourceEntries(list.getEntries() as unknown as readonly ResourceEntryLike[]);
    });
    observer.observe({ type: "resource", buffered: false });
    state.detach.push(() => observer.disconnect());
  } catch {
    // No resource timing here: the fetch wrapper and the loaders' error callbacks still report.
  }
}

/** Coming back to the tab — typically from the TSWoW console that just ran a build — asks at once. */
function probeOnReturn(): void {
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    const visible = (): void => {
      if (document.visibilityState === "visible") void probePatchChain(STATUS_ROUTE, SUSPECT_PROBE_MS);
    };
    document.addEventListener("visibilitychange", visible);
    state.detach.push(() => document.removeEventListener("visibilitychange", visible));
  }
  const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
  if (typeof target.addEventListener === "function" && typeof target.removeEventListener === "function") {
    const focused = (): void => { void probePatchChain(STATUS_ROUTE, SUSPECT_PROBE_MS); };
    target.addEventListener("focus", focused);
    state.detach.push(() => target.removeEventListener?.("focus", focused));
  }
}

/**
 * Called once by the page (main.ts): wrap `fetch` so every gateway path is covered, and remember
 * which generation the gateway served when the page started, for the Diagnostics comparison and
 * for noticing a gateway restarted under the page.
 *
 * The wrapper only looks at a 409, and only at a clone of it: the caller still owns the body. Any
 * other answer costs one clock comparison, and a URL parse once per ten seconds.
 */
export function installPatchChainWatch(
  origin: () => string | undefined,
  options: { readonly now?: () => number } = {},
): void {
  state.origin = origin;
  if (options.now) state.now = options.now;
  const current = globalThis.fetch as typeof globalThis.fetch & { [WATCHED]?: true };
  if (current[WATCHED]) return;
  const original = current.bind(globalThis);
  state.fetch = original;
  const watched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await original(input, init);
    if (state.reported) return response;
    if (response.status === 409) {
      let copy: Response | undefined;
      try { copy = response.clone(); } catch { copy = undefined; }
      if (copy) {
        void isPatchChainChangedResponse(copy).then((latched) => {
          if (latched) reportPatchChainChanged(routeOf(input));
        });
      }
    } else if (state.now() - state.lastProbeAt >= ACTIVITY_PROBE_MS) {
      noteGatewayActivity(requestUrl(input));
    }
    return response;
  };
  Object.defineProperty(watched, WATCHED, { value: true });
  globalThis.fetch = watched as typeof globalThis.fetch;
  observeResources();
  probeOnReturn();
  const gateway = origin();
  if (gateway) {
    // The boot read counts as the first probe: activity asks again ten seconds from now.
    state.lastProbeAt = state.now();
    void readPatchStatus(gateway, { summary: true, fetch: original }).then((read) => {
      state.bootGeneration = read.kind === "ok" ? read.status.generation : null;
      // A page opened on an already latched gateway: every asset it asks for will be refused.
      if (read.kind === "ok" && read.status.stale) reportPatchChainChanged(STATUS_ROUTE);
    });
  }
}

/** For tests: forget the latch, the banner, the boot generation and the listeners. */
export function resetPatchChainWatch(): void {
  if (state.poll !== undefined) clearInterval(state.poll);
  state.banner?.root.remove();
  for (const detach of state.detach.splice(0)) detach();
  state.origin = undefined;
  state.bootGeneration = undefined;
  state.reported = false;
  state.banner = undefined;
  state.poll = undefined;
  state.fetch = undefined;
  state.now = Date.now;
  state.lastProbeAt = Number.NEGATIVE_INFINITY;
  state.probing = undefined;
}
