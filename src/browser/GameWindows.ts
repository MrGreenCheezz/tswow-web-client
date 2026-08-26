const STORAGE_KEY = "webclient.window-layout";
const EDGE_MARGIN = 8;
/** Above the chat log (z 20) so a focused window is never hidden behind it. */
const BASE_Z_INDEX = 30;

export interface Placement {
  left: number;
  top: number;
}

/** How far each window in a cascade steps from the one under it, and how close counts as a clash. */
export const CASCADE_STEP = 28;
const CASCADE_NEAR = 24;

/**
 * Where a window opens the first time, when the stylesheet has nothing to say about it.
 *
 * `.game-window` gives every window `top: 92px` and no `left` at all, and only six of them have a
 * rule of their own — so the talents window, the skills window, the quest log, the calendar, the
 * scoreboard, the arena frames, the macro window and the bindings window all opened in exactly the
 * same place, each one hiding the last. They are draggable and their positions are remembered, so
 * this only decides where one lands before the player has moved it; that is precisely why it was
 * never noticed and precisely why it matters — it is what a new character sees.
 *
 * A cascade, like every windowing system since the eighties. It gives up rather than marching off
 * the screen: when the next step would not fit, the window takes the original place and overlaps,
 * because a window half off the bottom edge is worse than a window on top of another one.
 */
export function cascadePlacement(
  wanted: Placement,
  taken: readonly Placement[],
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  step = CASCADE_STEP,
): Placement {
  let candidate = { ...wanted };
  // Bounded by the number of windows already placed: each pass either stops, or steps past one
  // more of them, and no two of them share a place.
  for (let attempt = 0; attempt <= taken.length; attempt++) {
    const clash = taken.some((placement) =>
      Math.abs(placement.left - candidate.left) < CASCADE_NEAR
      && Math.abs(placement.top - candidate.top) < CASCADE_NEAR);
    if (!clash) return candidate;
    const next = { left: candidate.left + step, top: candidate.top + step };
    if (next.left + size.width > viewport.width - EDGE_MARGIN
      || next.top + size.height > viewport.height - EDGE_MARGIN) return { ...wanted };
    candidate = next;
  }
  return candidate;
}

interface Drag {
  element: HTMLElement;
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Free-floating game windows. The stylesheet only decides where a window appears the first time;
 * from then on it is pinned to pixel coordinates so it can be dragged by its header, raised by a
 * click and remembered across sessions.
 */
export class GameWindowManager {
  readonly #viewport: HTMLElement;
  readonly #windows: HTMLElement[] = [];
  /** The `hidden` watcher hung on each window, so {@link detach} can take it back down. */
  readonly #watchers = new Map<HTMLElement, MutationObserver>();
  readonly #placements = new Map<string, Placement>();
  #topZIndex = BASE_Z_INDEX;
  #drag: Drag | undefined;

  /** Where a window built at runtime has to be appended for the layout to reach it. */
  get viewport(): HTMLElement {
    return this.#viewport;
  }

  constructor(viewport: HTMLElement) {
    this.#viewport = viewport;
    for (const [id, placement] of Object.entries(readStoredLayout())) this.#placements.set(id, placement);
    window.addEventListener("resize", () => {
      for (const element of this.#windows) if (!element.hidden) this.#clamp(element);
    });
  }

  attach(element: HTMLElement): void {
    if (!element.id) throw new Error("A game window needs an id to remember its position");
    this.#windows.push(element);
    element.addEventListener("pointerdown", () => this.#raise(element));
    const header = element.querySelector("header");
    if (header) {
      header.classList.add("window-drag-handle");
      header.addEventListener("pointerdown", (event) => this.#startDrag(element, event));
    }
    // Windows are shown by clearing `hidden`, so that is where the first placement hooks in.
    const watcher = new MutationObserver(() => {
      if (!element.hidden) this.#place(element);
    });
    watcher.observe(element, { attributes: true, attributeFilter: ["hidden"] });
    this.#watchers.set(element, watcher);
    if (!element.hidden) this.#place(element);
  }

  /**
   * Forgets a window that has been thrown away rather than hidden.
   *
   * Nothing needed this while every window was built once: `attach` only ever added, and the list
   * was as long as the interface. A module window is rebuilt whenever its definition changes, and
   * without this each rebuild would leave behind an entry in `#windows` — walked on every resize —
   * and a live `MutationObserver` on a node nobody can see. The remembered placement stays: it is
   * keyed on the element id, the replacement carries the same one, and that is precisely how a
   * rebuilt window comes back where the player put it.
   */
  detach(element: HTMLElement): void {
    const at = this.#windows.indexOf(element);
    if (at >= 0) this.#windows.splice(at, 1);
    this.#watchers.get(element)?.disconnect();
    this.#watchers.delete(element);
  }

  #place(element: HTMLElement): void {
    const stored = this.#placements.get(element.id);
    if (stored) {
      this.#apply(element, stored.left, stored.top);
      return;
    }
    if (element.dataset.placed === "true") {
      this.#clamp(element);
      return;
    }
    // Take whatever the stylesheet laid out as the starting point, step it clear of whatever is
    // already open there, and then pin it.
    const viewport = this.#viewport.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const wanted = { left: bounds.left - viewport.left, top: bounds.top - viewport.top };
    const taken: Placement[] = [];
    for (const other of this.#windows) {
      if (other === element || other.hidden || other.dataset.placed !== "true") continue;
      taken.push({ left: Number.parseFloat(other.style.left) || 0, top: Number.parseFloat(other.style.top) || 0 });
    }
    const placed = cascadePlacement(wanted, taken,
      { width: bounds.width, height: bounds.height },
      { width: this.#viewport.clientWidth, height: this.#viewport.clientHeight });
    this.#apply(element, placed.left, placed.top);
  }

  #apply(element: HTMLElement, left: number, top: number): void {
    element.dataset.placed = "true";
    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.transform = "none";
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    this.#clamp(element);
  }

  #clamp(element: HTMLElement): void {
    const width = this.#viewport.clientWidth;
    const height = this.#viewport.clientHeight;
    const bounds = element.getBoundingClientRect();
    const maxLeft = Math.max(EDGE_MARGIN, width - bounds.width - EDGE_MARGIN);
    const maxTop = Math.max(EDGE_MARGIN, height - bounds.height - EDGE_MARGIN);
    const left = Math.min(Math.max(EDGE_MARGIN, Number.parseFloat(element.style.left) || 0), maxLeft);
    const top = Math.min(Math.max(EDGE_MARGIN, Number.parseFloat(element.style.top) || 0), maxTop);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  #raise(element: HTMLElement): void {
    if (Number.parseInt(element.style.zIndex, 10) === this.#topZIndex) return;
    this.#topZIndex++;
    element.style.zIndex = String(this.#topZIndex);
  }

  #startDrag(element: HTMLElement, event: PointerEvent): void {
    // The close button lives in the same header and must stay clickable.
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    this.#place(element);
    this.#raise(element);
    this.#drag = {
      element,
      pointerId: event.pointerId,
      offsetX: event.clientX - (Number.parseFloat(element.style.left) || 0),
      offsetY: event.clientY - (Number.parseFloat(element.style.top) || 0),
    };
    // Tracked on the window rather than through pointer capture, so the drag survives the cursor
    // leaving the header — which it always does once the window follows it.
    window.addEventListener("pointermove", this.#onPointerMove);
    window.addEventListener("pointerup", this.#onPointerUp);
    window.addEventListener("pointercancel", this.#onPointerUp);
    event.preventDefault();
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    const drag = this.#drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.element.style.left = `${event.clientX - drag.offsetX}px`;
    drag.element.style.top = `${event.clientY - drag.offsetY}px`;
    this.#clamp(drag.element);
    event.preventDefault();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (this.#drag && this.#drag.pointerId !== event.pointerId) return;
    this.#endDrag();
  };

  #endDrag(): void {
    const drag = this.#drag;
    this.#drag = undefined;
    window.removeEventListener("pointermove", this.#onPointerMove);
    window.removeEventListener("pointerup", this.#onPointerUp);
    window.removeEventListener("pointercancel", this.#onPointerUp);
    if (!drag) return;
    this.#placements.set(drag.element.id, {
      left: Number.parseFloat(drag.element.style.left) || 0,
      top: Number.parseFloat(drag.element.style.top) || 0,
    });
    writeStoredLayout(Object.fromEntries(this.#placements));
  }

  /** Drops every remembered position and lets the stylesheet lay the windows out again. */
  resetLayout(): void {
    this.#placements.clear();
    writeStoredLayout({});
    for (const element of this.#windows) {
      delete element.dataset.placed;
      element.style.removeProperty("left");
      element.style.removeProperty("top");
      element.style.removeProperty("right");
      element.style.removeProperty("bottom");
      element.style.removeProperty("transform");
      element.style.removeProperty("z-index");
    }
    this.#topZIndex = BASE_Z_INDEX;
    for (const element of this.#windows) if (!element.hidden) this.#place(element);
  }
}

function readStoredLayout(): Record<string, Placement> {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return {};
    const result: Record<string, Placement> = {};
    for (const [id, placement] of Object.entries(value as Record<string, unknown>)) {
      if (!placement || typeof placement !== "object") continue;
      const { left, top } = placement as Record<string, unknown>;
      if (typeof left === "number" && Number.isFinite(left) && typeof top === "number" && Number.isFinite(top)) {
        result[id] = { left, top };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredLayout(layout: Record<string, Placement>): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // A blocked or full localStorage only costs the remembered layout, never the session.
  }
}
