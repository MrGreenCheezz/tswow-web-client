/**
 * 10.16 — telling "the server is not there" from "the login screen is broken".
 *
 * The glue screens are fetched file by file from the gateway (`GlueLoader.createHttpFileProvider`).
 * A gateway that is restarting, or a patch chain that failed for a moment, answered one 5xx and the
 * whole front door fell back to the DOM forms — which need the same gateway and so were no help.
 * Network failures and 5xx are now retried on a short ladder; when the ladder runs out the failure
 * is a `GlueServerUnavailableError`, which `main.ts` shows as «server unavailable» with a retry
 * instead of the fallback forms. A 4xx, a 404 (the normal "file absent") and the 409 patch-chain
 * banner are not retried: waiting cannot change them.
 *
 * No imports: `main.ts` pulls this into the page's first chunk, which must not carry the Lua VM.
 */

/** A non-2xx answer from the gateway, with the status kept so the retry rule can read it. */
export class GlueHttpStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GlueHttpStatusError";
    this.status = status;
  }
}

/** The ladder ran out: the gateway at `origin` did not answer usefully. */
export class GlueServerUnavailableError extends Error {
  readonly origin: string;
  readonly cause: unknown;
  constructor(origin: string, cause: unknown) {
    super(`Сервер недоступен: ${origin}`);
    this.name = "GlueServerUnavailableError";
    this.origin = origin;
    this.cause = cause;
  }
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/** `fetch` rejects with a `TypeError` when the connection itself failed; 5xx is the server's word. */
export function isRetryableGlueFailure(error: unknown): boolean {
  if (error instanceof GlueHttpStatusError) return RETRYABLE_STATUS.has(error.status);
  return error instanceof TypeError;
}

/** Short on purpose: the login screen is the first thing a player sees; 6 s in all. */
export const GLUE_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];

export interface RetryOptions {
  readonly delaysMs?: readonly number[];
  readonly isRetryable?: (error: unknown) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `attempt` once plus once per delay while it fails retryably; the last failure is thrown. */
export async function retrying<T>(attempt: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? GLUE_RETRY_DELAYS_MS;
  const isRetryable = options.isRetryable ?? isRetryableGlueFailure;
  const sleep = options.sleep ?? realSleep;
  for (let index = 0; ; index++) {
    try {
      return await attempt();
    } catch (error) {
      if (index >= delays.length || !isRetryable(error)) throw error;
      await sleep(delays[index]!);
    }
  }
}

/**
 * One cheap question to the gateway: can it serve the login screen's TOC now? `true` for a 2xx or
 * a 404 (the route answered), `false` for anything that would have failed the load again.
 */
export async function probeGlueServer(
  origin: string,
  doFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<boolean> {
  try {
    const url = new URL("/client/file", origin);
    url.searchParams.set("path", "Interface\\GlueXML\\GlueXML.toc");
    const response = await doFetch(url.href, { headers: { accept: "text/plain" }, cache: "no-store" });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export interface UnavailableScreenOptions {
  /** The element the notice covers (`#glue-host`); the notice is appended as its last child. */
  readonly container: HTMLElement;
  readonly origin: string;
  /** Asks the gateway; `true` means the page may load again. */
  readonly probe: () => Promise<boolean>;
  /** What "load again" is. `location.reload()` in the page: a half-built stage is not reusable. */
  readonly onAvailable: () => void;
  readonly intervalMs?: number;
  readonly document?: Document;
}

/**
 * «Сервер недоступен» with a countdown, a «Повторить» button and an automatic retry every
 * `intervalMs` (10 s) — paused while the tab is hidden, so an abandoned tab does not poll forever.
 * Returns a function that stops it.
 */
export function showGlueServerUnavailable(options: UnavailableScreenOptions): () => void {
  const doc = options.document ?? document;
  const interval = options.intervalMs ?? 10_000;
  const box = doc.createElement("div");
  box.className = "glue-unavailable";
  box.setAttribute("role", "alert");
  box.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;"
    + "justify-content:center;gap:12px;background:#000c;color:#f5d67b;font:16px sans-serif;"
    + "text-align:center;z-index:10001;pointer-events:auto";
  const title = doc.createElement("div");
  title.textContent = `Сервер недоступен: ${options.origin}`;
  const line = doc.createElement("div");
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "Повторить";
  box.append(title, line, button);
  options.container.querySelector(":scope > .glue-unavailable")?.remove();
  options.container.append(box);

  let remaining = Math.ceil(interval / 1000);
  let busy = false;
  let stopped = false;
  const render = (): void => {
    line.textContent = busy ? "Проверка…" : `Повтор через ${remaining} с`;
  };
  const attempt = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    render();
    const up = await options.probe().catch(() => false);
    busy = false;
    if (stopped) return;
    if (up) {
      stop();
      options.onAvailable();
      return;
    }
    remaining = Math.ceil(interval / 1000);
    render();
  };
  const timer = setInterval(() => {
    if (busy || doc.hidden) return;
    remaining -= 1;
    if (remaining <= 0) void attempt();
    else render();
  }, 1000);
  button.addEventListener("click", () => void attempt());
  render();
  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
