/**
 * 06.10-P1-00b: which model-texture failures of a bench scene are textures the corpus does not have.
 *
 * A model may name a texture the client's archives do not contain (the gateway answers 404; the
 * HD gryphon roost in Stormwind names `World\Expansion05\Doodads\WaterfallDrops.blp`). The game
 * draws such a texture as the loader's opaque white pixel and carries on, but the loader counts it
 * as a terminal error like any other, and the bench harness refuses a scene with errors.
 *
 * The ledger watches the page's texture fetches and image decodes. A scene's errors are explained
 * by missing textures only when every error is a model-texture error, at least one texture URL
 * answered 404, and no texture fetch failed in any other way and no image decode failed at all —
 * then every terminal failure of the model texture loaders can only be one of those 404s. Anything
 * else (a 500, a cut stream, an undecodable image, a world-texture or tile error) keeps the scene
 * refused, as before.
 */
export interface KnownMissingTextureLedger {
  /** Texture URLs (path and query) the asset server answered 404. */
  readonly missing: ReadonlySet<string>;
  /** Texture fetches that failed other than by 404, plus image decodes that failed. */
  readonly otherFailures: number;
}

interface LedgerTarget {
  fetch: typeof fetch;
  createImageBitmap?: unknown;
}

/** Whether `url` is a model-texture route of the asset server (`/texture?path=…`). */
function textureKey(input: unknown, origin: string): string | undefined {
  let href: string;
  if (typeof input === "string") href = input;
  else if (input instanceof URL) href = input.href;
  else if (input && typeof (input as { url?: unknown }).url === "string") href = (input as { url: string }).url;
  else return undefined;
  let url: URL;
  try { url = new URL(href, origin); } catch { return undefined; }
  return url.pathname === "/texture" ? url.pathname + url.search : undefined;
}

/** Wraps `target.fetch` and `target.createImageBitmap`; returns the live ledger. */
export function installKnownMissingTextureLedger(target: LedgerTarget, origin: string): KnownMissingTextureLedger {
  const missing = new Set<string>();
  const ledger = { missing, otherFailures: 0 };
  const originalFetch = target.fetch;
  target.fetch = async function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const key = textureKey(input, origin);
    let response: Response;
    try {
      response = await originalFetch.call(this, input, init);
    } catch (error) {
      if (key !== undefined) ledger.otherFailures++;
      throw error;
    }
    if (key !== undefined && !response.ok) {
      if (response.status === 404) missing.add(key);
      else ledger.otherFailures++;
    }
    return response;
  } as typeof fetch;
  const originalDecode = target.createImageBitmap;
  if (typeof originalDecode === "function") {
    target.createImageBitmap = async function (this: unknown, ...args: unknown[]) {
      try {
        return await (originalDecode as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      } catch (error) {
        ledger.otherFailures++;
        throw error;
      }
    };
  }
  return ledger;
}

/** True when a scene's `errors` are all model-texture failures that the ledger attributes to 404s. */
export function errorsAreKnownMissingTextures(
  status: { readonly errors: number; readonly modelTexturesErrors: number },
  ledger: KnownMissingTextureLedger,
): boolean {
  return status.errors > 0 && status.errors === status.modelTexturesErrors
    && ledger.missing.size > 0 && ledger.otherFailures === 0;
}
