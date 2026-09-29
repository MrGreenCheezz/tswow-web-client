/**
 * What the world-entry curtain shows: the stock 3.3.5a loading screen.
 *
 * The client's own picture is per map: `Map.LoadingScreenID` names a `LoadingScreens.dbc` row, and
 * the row names a 1024x1024 BLP that is drawn stretched over a 4:3 box — or, on a widescreen
 * display when the row's `HasWideScreen` is set, its `…Wide.blp` twin stretched over the whole
 * screen. The gateway resolves the two tables (`/dbc/loading-screens`, one small answer a session)
 * and serves the BLPs as PNG through `/texture`, the same route every other client picture takes.
 *
 * Under the picture sits the stock bar: `Interface\Glues\LoadingBar\Loading-BarBorder` (512x64,
 * its see-through inner slot measured at x 34..478, y 21..42), `Loading-BarFill` stretched inside
 * that slot, and `Loading-BarGlow`'s spark riding the fill's leading edge.
 */

/** One map's art, as `/dbc/loading-screens` answers it. */
export interface LoadingScreenArt {
  readonly file: string;
  readonly wide?: string;
}

export const LOADING_BAR_BORDER = "Interface\\Glues\\LoadingBar\\Loading-BarBorder.blp";
export const LOADING_BAR_FILL = "Interface\\Glues\\LoadingBar\\Loading-BarFill.blp";
export const LOADING_BAR_GLOW = "Interface\\Glues\\LoadingBar\\Loading-BarGlow.blp";

/**
 * Past this width-to-height ratio the display counts as widescreen. A hair above 4:3 so that a
 * 1280x1024 (5:4) or a 1024x768 window never takes the wide art, and a 16:10 or 16:9 one always does.
 */
export const LOADING_WIDE_ASPECT = 1.4;

/** Which picture a map shows at this aspect, or undefined when the map names no loading screen. */
export function loadingScreenPicture(
  art: LoadingScreenArt | undefined,
  aspect: number,
): { readonly path: string; readonly wide: boolean } | undefined {
  if (!art?.file) return undefined;
  if (art.wide && Number.isFinite(aspect) && aspect > LOADING_WIDE_ASPECT) return { path: art.wide, wide: true };
  return { path: art.file, wide: false };
}

/** The gateway's HTTP origin for its WebSocket URL (`ws://host:8090/auth` → `http://host:8090`). */
export function gatewayHttpOrigin(gatewayWebSocketUrl: string): string | undefined {
  try {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    return url.origin;
  } catch {
    return undefined;
  }
}

/** The PNG the gateway serves for one archive picture. */
export function loadingTextureUrl(origin: string, path: string): string {
  return `${origin}/texture?path=${encodeURIComponent(path.replaceAll("/", "\\"))}`;
}

/**
 * How far the bar is filled for each thing the curtain waits on.
 *
 * There is no byte count to report — the stock client's bar is its own file queue — so the bar
 * follows the barrier's stages instead and creeps toward each stage's ceiling while it waits, which
 * is what keeps a slow terrain tile from looking like a frozen screen.
 */
export const LOADING_STAGE_PROGRESS = {
  connecting: 0.12,
  character: 0.3,
  terrain: 0.62,
  collision: 0.84,
  soak: 0.96,
  done: 1,
} as const;
export type LoadingStage = keyof typeof LOADING_STAGE_PROGRESS;

/** Approach time constant, in milliseconds: about two thirds of the way to the ceiling per second. */
const LOADING_PROGRESS_TAU_MS = 900;

/**
 * One frame of the bar: move `current` toward `ceiling` by the elapsed time, never backwards and
 * never past it (a new transfer resets the bar explicitly).
 */
export function loadingProgressStep(current: number, ceiling: number, elapsedMs: number): number {
  const from = Math.max(0, Math.min(1, Number.isFinite(current) ? current : 0));
  const to = Math.max(0, Math.min(1, ceiling));
  if (to <= from) return from;
  const dt = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  return from + (to - from) * (1 - Math.exp(-dt / LOADING_PROGRESS_TAU_MS));
}

/**
 * The per-map table, fetched once per gateway origin and shared by every curtain after it.
 *
 * A failure is not remembered: the next transfer asks again, so a gateway restarted onto a build
 * that has the route starts showing art without a page reload.
 */
export class LoadingScreenArtTable {
  readonly #fetch: typeof fetch;
  #origin: string | undefined;
  #table: Readonly<Record<string, LoadingScreenArt>> | undefined;
  #pending: Promise<Readonly<Record<string, LoadingScreenArt>> | undefined> | undefined;

  constructor(fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.#fetch = fetcher;
  }

  /** The art for a map, once the table is here. */
  get(mapId: number): LoadingScreenArt | undefined {
    return this.#table?.[String(mapId)];
  }

  /** Resolves with the table for this origin; undefined when the gateway did not answer. */
  load(origin: string): Promise<Readonly<Record<string, LoadingScreenArt>> | undefined> {
    if (this.#origin !== origin) {
      this.#origin = origin;
      this.#table = undefined;
      this.#pending = undefined;
    }
    if (this.#table) return Promise.resolve(this.#table);
    this.#pending ??= (async () => {
      try {
        const response = await this.#fetch(`${origin}/dbc/loading-screens`);
        if (!response.ok) throw new Error(`loading screens: gateway returned ${response.status}`);
        const value = await response.json() as unknown;
        if (!value || typeof value !== "object") throw new Error("loading screens: malformed table");
        const table: Record<string, LoadingScreenArt> = {};
        for (const [id, row] of Object.entries(value as Record<string, unknown>)) {
          const art = row as Partial<LoadingScreenArt> | null;
          if (!art || typeof art.file !== "string" || !art.file) continue;
          table[id] = typeof art.wide === "string" && art.wide ? { file: art.file, wide: art.wide } : { file: art.file };
        }
        if (this.#origin === origin) this.#table = table;
        return table;
      } catch {
        return undefined;
      } finally {
        if (this.#origin === origin) this.#pending = undefined;
      }
    })();
    return this.#pending;
  }
}
