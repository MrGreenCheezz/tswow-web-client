/**
 * One boot catalog from the gateway, patiently (the owner's report, 01.11).
 *
 * The world mount reads /dbc/battlegrounds and /dbc/lfg-dungeons before the stock interface boots, and
 * their answers decide whether stock PVPBattlegroundFrame, BattlefieldFrame, WorldStateScoreFrame,
 * MiniMapBattlefieldFrame and LFDParentFrame are published at all. The two used to get one try of five
 * seconds. Those requests start at world entry, behind the browser's six HTTP/1.1 connections per host
 * and the terrain and model requests already queued on them, so on a loaded gateway or a slow link they
 * timed out and every one of those windows fell back to the native one for the whole session.
 *
 * So: asked for at high priority, a longer try, and a repeat for what a repeat can cure — a dropped
 * connection, a timeout, a 5xx. A 4xx or a malformed body is the same on the next try, and is final.
 */

export const CATALOG_FETCH_DEFAULTS = Object.freeze({ attempts: 3, timeoutMs: 15_000, retryDelayMs: 1_000 });

export interface CatalogFetchOptions {
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly init?: RequestInit;
}

/** What the gateway refused for good: the caller's error text, with no repeat. */
class CatalogFetchRefused extends Error {}

function retryable(error: unknown): boolean {
  return !(error instanceof CatalogFetchRefused) && !(error instanceof SyntaxError);
}

/** The parsed JSON body of `url`; throws the last error once the tries are spent. */
export async function fetchCatalogJson(
  url: string,
  label: string,
  options: CatalogFetchOptions = {},
): Promise<unknown> {
  const attempts = Math.max(1, options.attempts ?? CATALOG_FETCH_DEFAULTS.attempts);
  const timeoutMs = options.timeoutMs ?? CATALOG_FETCH_DEFAULTS.timeoutMs;
  const retryDelayMs = options.retryDelayMs ?? CATALOG_FETCH_DEFAULTS.retryDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options.init, priority: "high", signal: controller.signal });
      if (!response.ok) {
        const message = `${label} gateway returned ${response.status}`;
        if (response.status >= 500) throw new Error(message);
        throw new CatalogFetchRefused(message);
      }
      return await response.json();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      console.warn(`[catalog] ${label}: try ${attempt} of ${attempts} failed (${String(error)}); asking again`);
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}
