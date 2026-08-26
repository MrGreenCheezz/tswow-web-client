/**
 * Which module windows exist, which of them are open, and what Escape should do about it.
 *
 * Deliberately free of the DOM. A window is registered here as a handle — show, hide, update,
 * destroy — and never as an element, so the loader (М6), the chat command that opens a window, the
 * key binding that toggles one and `Windows.ts`'s Escape list can all reach the registry without
 * dragging `Dom.ts` and its 193 resolved elements in with them. `WindowRender.ts` is what turns a
 * definition into a handle; this file never builds one.
 *
 * Two rules decide the shape:
 *
 * * **An id belongs to one window.** Two modules that both call their screen `shop` are a refusal
 *   naming both, not a silent last-one-wins — an anchor, a slash command and a key binding all
 *   resolve through the id, and "which shop" has to have an answer.
 * * **`forget(module)` is exactly the inverse of `register`.** Unloading a module has to leave the
 *   client as it was, which is what М6's hot reload is built on: rebuild one window, put it back
 *   under the same element id, and `GameWindowManager` returns it to where the player dragged it.
 */

import type { LivePatch } from "./WindowPatch.js";
import type { ExpressionScope } from "./WindowExpression.js";
import type { LiveWindow } from "./WindowRender.js";
import type { ParsedWindow } from "./WindowSchema.js";

/**
 * One live window, as everything outside the renderer sees it.
 *
 * No `element` here on purpose: see the file header. {@link WindowRender.LiveWindow} adds it for
 * the caller that actually has a document.
 */
export interface RegisteredWindow {
  readonly id: string;
  readonly module: string;
  readonly definition: ParsedWindow;
  /** Whether Escape closes this one. The definition's `escClose`, carried so the list can ask. */
  readonly escClose: boolean;
  /**
   * Which roots of the published view this window's binding pass reads.
   *
   * Collected by the renderer as it binds rather than worked out from the definition, so it cannot
   * fall behind: an expression the pass evaluates is an expression that registered its roots.
   * `WindowBindings` assembles exactly the union of these and skips the rest, which is what keeps a
   * raid of forty out of a snapshot nobody reads one from.
   *
   * **Complete when the window is registered**, which is the contract {@link WindowRegistry.roots}
   * caches on. The one place that could break it is a `repeat`, whose rows are copies of a template
   * built on demand — so `WindowRender` builds the first row while it is building the window, and
   * says so where it does it.
   */
  readonly roots: ReadonlySet<string>;
  visible(): boolean;
  show(): void;
  hide(): void;
  /** One binding pass against a frozen snapshot of the published state. */
  update(snapshot: ExpressionScope): void;
  /** Takes the window off the screen and drops every listener it hung. */
  destroy(): void;
}

/**
 * @typeParam T what the caller's window handles actually are.
 *
 * Generic so that the client's own registry hands back {@link LiveWindow} — with its element and
 * its per-frame counters — while this file still knows nothing about the DOM. The import of
 * `LiveWindow` below is `import type`, so it is erased at compile time and the two files have no
 * runtime cycle between them.
 */
export class WindowRegistry<T extends RegisteredWindow = RegisteredWindow> {
  /** Registration order, which is the order the diagnostics tab lists them in. */
  readonly #windows = new Map<string, T>();
  /**
   * The union of every live window's roots, worked out once per change to the map.
   *
   * Cached rather than recomputed each frame because it moves when a window is registered or
   * dropped and at no other time, while the pass that reads it runs sixty times a second.
   */
  #roots: ReadonlySet<string> | undefined;

  /**
   * Adds a window, or says why it cannot be added.
   *
   * The refusal names both modules, because the author of the second one is very often not the
   * author of the first and «id "shop" уже занят» alone sends them looking in their own file.
   */
  register(window: T): string | undefined {
    const existing = this.#windows.get(window.id);
    if (existing) {
      return `окно "${window.id}" уже зарегистрировано модулем «${existing.module}»;`
        + ` модуль «${window.module}» переименовать`;
    }
    this.#windows.set(window.id, window);
    this.#roots = undefined;
    return undefined;
  }

  /**
   * Which roots of the published view any live window reads.
   *
   * The whole point of the answer is what is *not* in it: `WindowBindings` builds only these, so a
   * client whose one window reads `player.health` and `world.clock` never assembles the bags, the
   * quest log or a raid of forty. A registry with no windows answers the empty set, which nothing
   * asks for — the pass returns before it gets here.
   */
  roots(): ReadonlySet<string> {
    if (this.#roots) return this.#roots;
    const union = new Set<string>();
    for (const window of this.#windows.values()) for (const root of window.roots) union.add(root);
    this.#roots = union;
    return union;
  }

  get size(): number {
    return this.#windows.size;
  }

  has(id: string): boolean {
    return this.#windows.has(id);
  }

  window(id: string): T | undefined {
    return this.#windows.get(id);
  }

  definition(id: string): ParsedWindow | undefined {
    return this.#windows.get(id)?.definition;
  }

  list(): readonly T[] {
    return [...this.#windows.values()];
  }

  /** Every window a module put here, for the loader's unload and for the diagnostics list. */
  ofModule(module: string): readonly T[] {
    return this.list().filter((window) => window.module === module);
  }

  open(id: string): boolean {
    const window = this.#windows.get(id);
    if (!window) return false;
    window.show();
    return true;
  }

  close(id: string): boolean {
    const window = this.#windows.get(id);
    if (!window) return false;
    window.hide();
    return true;
  }

  toggle(id: string): boolean {
    const window = this.#windows.get(id);
    if (!window) return false;
    if (window.visible()) window.hide();
    else window.show();
    return true;
  }

  /** Drops one window: off the screen, out of the map, listeners and all. */
  remove(id: string): boolean {
    const window = this.#windows.get(id);
    if (!window) return false;
    this.#windows.delete(id);
    this.#roots = undefined;
    window.destroy();
    return true;
  }

  /** Drops every window one module registered. What it never registered it does not touch. */
  forget(module: string): number {
    let dropped = 0;
    for (const window of this.list()) {
      if (window.module !== module) continue;
      this.#windows.delete(window.id);
      this.#roots = undefined;
      window.destroy();
      dropped++;
    }
    return dropped;
  }

  /** Drops everything. Leaving a world takes the modules with it. */
  clear(): void {
    for (const window of this.list()) window.destroy();
    this.#windows.clear();
    this.#roots = undefined;
  }

  /**
   * One binding pass over every live window, against one frozen snapshot.
   *
   * Called once a frame from `drainWorldState`. A window's own {@link RegisteredWindow.update}
   * decides how much of itself it has to look at; a closed one costs its root conditions and
   * nothing else, which is what makes «двадцать окон в реестре» affordable.
   */
  update(snapshot: ExpressionScope): void {
    for (const window of this.#windows.values()) window.update(snapshot);
  }
}

/** The one registry the client uses. Tests build their own. */
export const windowRegistry = new WindowRegistry<LiveWindow>();

/**
 * The two halves of the Escape entry in `Windows.ts`.
 *
 * Only windows that asked for `escClose` count. A screen that did not ask must neither be shut by
 * Escape nor stop Escape from reaching the game menu — otherwise a module that leaves a HUD
 * overlay open silently takes the menu key away from the player.
 */
export function escapableWindowOpen(): boolean {
  return windowRegistry.list().some((window) => window.escClose && window.visible());
}

export function closeEscapableWindows(): void {
  for (const window of windowRegistry.list()) if (window.escClose && window.visible()) window.hide();
}

/* ---------------------------------------------------------------------------------------------
 * Patches — М7
 * ------------------------------------------------------------------------------------------- */

/**
 * One live patch, as everything outside `WindowPatch.ts` sees it.
 *
 * A patch is not a window and is deliberately not registered as one: it has no id to open, nothing
 * to close with Escape and nothing to anchor to. What it shares with a window is the two things the
 * once-a-frame pass needs — which roots of the published view it reads, and a way to be handed one
 * frozen snapshot.
 */
export interface RegisteredPatch {
  readonly id: string;
  readonly module: string;
  /** The built-in window the file says it is about, for the diagnostics list. */
  readonly target: string;
  readonly roots: ReadonlySet<string>;
  update(snapshot: ExpressionScope): void;
  /** Takes every edit back: the widgets out of their slots, the hides restored, the classes off. */
  destroy(): void;
}

/**
 * Which patches are live. The same two rules the window registry has, for the same two reasons.
 *
 * @typeParam T what the caller's patch handles actually are — `LivePatch` in the client.
 */
export class PatchRegistry<T extends RegisteredPatch = RegisteredPatch> {
  readonly #patches = new Map<string, T>();
  #roots: ReadonlySet<string> | undefined;

  /** Adds a patch, or says why it cannot be added. Two files with one id is two owners of one edit. */
  register(patch: T): string | undefined {
    const existing = this.#patches.get(patch.id);
    if (existing) {
      return `правка "${patch.id}" уже зарегистрирована модулем «${existing.module}»;`
        + ` модуль «${patch.module}» переименовать`;
    }
    this.#patches.set(patch.id, patch);
    this.#roots = undefined;
    return undefined;
  }

  roots(): ReadonlySet<string> {
    if (this.#roots) return this.#roots;
    const union = new Set<string>();
    for (const patch of this.#patches.values()) for (const root of patch.roots) union.add(root);
    this.#roots = union;
    return union;
  }

  get size(): number {
    return this.#patches.size;
  }

  has(id: string): boolean {
    return this.#patches.has(id);
  }

  patch(id: string): T | undefined {
    return this.#patches.get(id);
  }

  list(): readonly T[] {
    return [...this.#patches.values()];
  }

  remove(id: string): boolean {
    const patch = this.#patches.get(id);
    if (!patch) return false;
    this.#patches.delete(id);
    this.#roots = undefined;
    patch.destroy();
    return true;
  }

  forget(module: string): number {
    let dropped = 0;
    for (const patch of this.list()) {
      if (patch.module !== module) continue;
      this.#patches.delete(patch.id);
      this.#roots = undefined;
      patch.destroy();
      dropped++;
    }
    return dropped;
  }

  clear(): void {
    for (const patch of this.list()) patch.destroy();
    this.#patches.clear();
    this.#roots = undefined;
  }

  update(snapshot: ExpressionScope): void {
    for (const patch of this.#patches.values()) patch.update(snapshot);
  }
}

/** The one patch registry the client uses. Tests build their own. */
export const patchRegistry = new PatchRegistry<LivePatch>();
