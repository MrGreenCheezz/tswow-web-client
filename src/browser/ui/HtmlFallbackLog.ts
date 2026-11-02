/**
 * WORK_PLAN 4.17, stage 1: which HTML surfaces still reach the screen while the stock interface is up.
 *
 * The stock side opens its own frame first and an HTML window only when that fails, so whatever lands
 * here is what removing the HTML interface would take away from the player. Temporary: it goes with
 * the HTML interface. This file keeps the books and reads a page through a narrow shape;
 * HtmlFallbackWatch.ts is the part that runs in one.
 */

export interface HtmlFallbackEntry {
  readonly name: string;
  /** Separate appearances. */
  readonly times: number;
  /** Time on screen, ended appearances and the running one. */
  readonly shownMs: number;
  /** `Date.now()` of the first and the last appearance. */
  readonly firstAt: number;
  readonly lastAt: number;
}

/** Stands in the log for the time the HTML HUD is on screen because the stock one has not come up. */
export const STOCK_NOT_UP = "(оригинальный интерфейс ещё не поднялся)";

export class HtmlFallbackLog {
  readonly #entries = new Map<string, HtmlFallbackEntry>();
  /** What was on screen at the last look, and since when its time has not been counted. */
  readonly #showing = new Map<string, number>();

  constructor(saved: readonly HtmlFallbackEntry[] = []) {
    for (const entry of saved) this.#entries.set(entry.name, entry);
  }

  /** One look at the page. Answers the names that have just appeared. */
  observe(visible: ReadonlySet<string>, now: number): string[] {
    const appeared: string[] = [];
    for (const name of [...this.#showing.keys()]) {
      if (!visible.has(name)) this.#settle(name, now, true);
    }
    for (const name of visible) {
      if (this.#showing.has(name)) continue;
      const known = this.#entries.get(name);
      this.#entries.set(name, {
        name,
        times: (known?.times ?? 0) + 1,
        shownMs: known?.shownMs ?? 0,
        firstAt: known?.firstAt ?? now,
        lastAt: now,
      });
      this.#showing.set(name, now);
      appeared.push(name);
    }
    return appeared;
  }

  /** Worst offenders first; what is on screen now is counted up to `now`. */
  entries(now: number): HtmlFallbackEntry[] {
    for (const name of this.#showing.keys()) this.#settle(name, now, false);
    return [...this.#entries.values()].sort((a, b) => b.times - a.times || b.shownMs - a.shownMs);
  }

  #settle(name: string, now: number, ended: boolean): void {
    const since = this.#showing.get(name);
    const entry = this.#entries.get(name);
    if (since === undefined || entry === undefined) return;
    this.#entries.set(name, { ...entry, shownMs: entry.shownMs + Math.max(0, now - since), lastAt: now });
    if (ended) this.#showing.delete(name);
    else this.#showing.set(name, now);
  }
}

/** A saved log as this browser kept it; anything else is an empty one, never an error during play. */
export function parseHtmlFallbackLog(text: string | null): HtmlFallbackEntry[] {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is HtmlFallbackEntry => {
    const row = entry as Partial<HtmlFallbackEntry> | null;
    return typeof row?.name === "string" && typeof row.times === "number" && typeof row.shownMs === "number"
      && typeof row.firstAt === "number" && typeof row.lastAt === "number";
  });
}

/** The part of an element a look needs. */
export interface HtmlSurface {
  readonly id: string;
  readonly className: string;
  readonly children: ArrayLike<HtmlSurface>;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  checkVisibility(): boolean;
}

/** They only hold other surfaces: what counts is what is inside. */
const HOLDERS: ReadonlySet<string> = new Set([
  "bottom-hud", "bottom-hud-center", "hud-utilities", "left-rail", "secondary-frames", "target-rail", "right-rail",
]);

/** Not the HTML interface: the world's canvases, the stock interface, what stays after the removal. */
const NOT_HTML_INTERFACE: ReadonlySet<string> = new Set([
  "world-3d-canvas", "world-canvas", "framexml-world-host", "diagnostics-window",
]);

function surfaceName(surface: HtmlSurface): string {
  if (surface.id !== "") return `#${surface.id}`;
  const firstClass = surface.className.trim().split(/\s+/)[0] ?? "";
  return firstClass === "" ? "(без имени)" : `.${firstClass}`;
}

function collect(parent: HtmlSurface, into: Set<string>): void {
  for (let index = 0; index < parent.children.length; index++) {
    const child = parent.children[index];
    if (child === undefined || NOT_HTML_INTERFACE.has(child.id) || !child.checkVisibility()) continue;
    if (HOLDERS.has(child.id)) {
      collect(child, into);
      continue;
    }
    const box = child.getBoundingClientRect();
    if (box.width > 1 && box.height > 1) into.add(surfaceName(child));
  }
}

/** The named HTML surfaces on screen inside the world viewport. */
export function visibleHtmlSurfaces(viewport: HtmlSurface): Set<string> {
  const visible = new Set<string>();
  collect(viewport, visible);
  return visible;
}
