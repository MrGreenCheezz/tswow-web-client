/**
 * WORK_PLAN 4.17, stage 1: the page side of HtmlFallbackLog.ts. Temporary, it goes with the HTML interface.
 *
 * Twice a second it looks at what HTML is on screen. A look rather than hooks in each window: the windows have many routes in, and a route nobody remembered is
 * exactly what this is here to find. An appearance is one console line; `htmlFallbacks()` answers the whole
 * log, which survives a reload and a relog, with the gates that failed, so `copy(htmlFallbacks())` after a
 * session hands all of it over.
 */

import {
  HtmlFallbackLog, parseHtmlFallbackLog, STOCK_NOT_UP, visibleHtmlSurfaces, type HtmlFallbackEntry,
} from "./HtmlFallbackLog.js";
import { NATIVE_LANES_REPLACED, nativeHudReplaced } from "./NativeHudReplacement.js";

const STORAGE_KEY = "webclient.html-fallbacks";
const LOOK_MS = 500;

function readSaved(): HtmlFallbackEntry[] {
  try {
    return parseHtmlFallbackLog(localStorage.getItem(STORAGE_KEY));
  } catch {
    return []; // Site data blocked: this session's log only.
  }
}

function save(entries: readonly HtmlFallbackEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Site data blocked or full: the log stays readable until the page closes.
  }
}

/** Starts the watch for one world; the answer ends it. */
export function watchHtmlFallbacks(): () => void {
  const viewport = document.getElementById("world-viewport");
  if (viewport === null) return () => undefined;
  const log = new HtmlFallbackLog(readSaved());
  const none: ReadonlySet<string> = new Set();

  const look = (): void => {
    const now = Date.now();
    const visible = nativeHudReplaced(NATIVE_LANES_REPLACED) ? visibleHtmlSurfaces(viewport) : new Set([STOCK_NOT_UP]);
    const appeared = log.observe(visible, now);
    if (appeared.length === 0) return;
    for (const name of appeared) console.warn(`[html-fallback] ${name}`);
    save(log.entries(now));
  };

  const report = (): { surfaces: HtmlFallbackEntry[]; gates: unknown } => ({
    surfaces: log.entries(Date.now()),
    gates: (window as { frameXmlWorld?: () => { fallbacks?: unknown } }).frameXmlWorld?.().fallbacks,
  });
  Object.defineProperty(window, "htmlFallbacks", { configurable: true, value: report });
  const timer = window.setInterval(look, LOOK_MS);
  return () => {
    window.clearInterval(timer);
    log.observe(none, Date.now());
    save(log.entries(Date.now()));
    if (Object.getOwnPropertyDescriptor(window, "htmlFallbacks")?.value === report) {
      Reflect.deleteProperty(window, "htmlFallbacks");
    }
  };
}
