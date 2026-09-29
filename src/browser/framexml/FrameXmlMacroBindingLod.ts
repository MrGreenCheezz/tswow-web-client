/**
 * What the two load-on-demand windows of this lane share: the ownership route between a stock
 * window and its native counterpart, and the lazy owner that loads the stock add-on on first open.
 *
 * The trainer's recipe (createLazyFrameXmlTrainerOwner): nothing is loaded at boot; the first open
 * runs `boot.loadAddon` (Lua's LoadAddOn is only a status view), hands the add-on's roots to the
 * renderer, reconciles, and shows the stock window only once a structural gate over the loaded tree
 * has passed. A failed load or gate demotes the owner for good and opens the native window the
 * player asked for, so a press is never lost. While the load is in flight nothing else opens: the
 * native window would be replaced a few frames later, and the request can be taken back by
 * pressing the same key again.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

export interface FrameXmlLodWindowOwner {
  isOpen(): boolean;
  /** Open (or start loading); false when this owner can no longer open anything. */
  show(): boolean;
  hide(): void;
  /** Whether a load or gate has failed; the route then answers false and the native window opens. */
  readonly failed: boolean;
  dispose(): void;
}

/**
 * The one published owner of a window and the questions the native module asks it. Every answer is
 * false while nothing usable is published, which leaves the native window in charge.
 */
export class FrameXmlLodWindowRoute {
  #owner: FrameXmlLodWindowOwner | undefined;

  publish(next: FrameXmlLodWindowOwner): () => void {
    const previous = this.#owner;
    if (previous && previous !== next) {
      try { previous.dispose(); } catch { /* a stale VM must not block the new owner */ }
    }
    this.#owner = next;
    let cleaned = false;
    return (): void => {
      if (cleaned) return;
      cleaned = true;
      if (this.#owner !== next) return;
      try { next.dispose(); } catch { /* mount teardown continues */ }
      this.#owner = undefined;
    };
  }

  #usable(): FrameXmlLodWindowOwner | undefined {
    const owner = this.#owner;
    return owner && !owner.failed ? owner : undefined;
  }

  published(): boolean {
    return this.#usable() !== undefined;
  }

  isOpen(): boolean {
    try { return this.#usable()?.isOpen() === true; } catch { return false; }
  }

  /** Open the stock window; false tells the caller to open its native one. */
  open(): boolean {
    const owner = this.#usable();
    if (!owner) return false;
    try { return owner.show(); } catch { return false; }
  }

  toggle(): boolean {
    const owner = this.#usable();
    if (!owner) return false;
    try {
      if (owner.isOpen()) {
        owner.hide();
        return true;
      }
      return owner.show();
    } catch {
      return false;
    }
  }

  /** Close the stock window if it is up; false when nothing stock was open. */
  close(): boolean {
    const owner = this.#owner;
    if (!owner) return false;
    try {
      const open = owner.isOpen();
      owner.hide();
      return open;
    } catch {
      return false;
    }
  }
}

export interface FrameXmlLodWindowSpec {
  /** The Blizzard add-on folder, e.g. `Blizzard_MacroUI`. */
  readonly addon: string;
  /** Data the window reads, fetched beside the add-on (the macro icon list). */
  readonly prepare?: () => Promise<void>;
  /** The structural gate over the loaded tree: the root, hidden, or undefined. */
  readonly gate: (boot: FrameXmlBoot, renderer: FrameXmlDomRenderer) => FrameXmlFrame | undefined;
  /** One-time adjustments once the gate has passed. */
  readonly adopt?: (boot: FrameXmlBoot, root: FrameXmlFrame, renderer: FrameXmlDomRenderer) => void;
  /** The stock open, in Lua (the button script the client runs). */
  readonly showSource: string;
  /** The close the host asks for (a key toggling the window shut, a world reset), in Lua. */
  readonly hideSource: string;
  /**
   * The stock window cannot be used. `wanted` is whether the player is waiting for it; the native
   * window opens then. Called once.
   */
  readonly onFailure: (wanted: boolean) => void;
}

function errorCount(boot: FrameXmlBoot): number {
  const total = (boot as FrameXmlBoot & { readonly errorCount?: unknown }).errorCount;
  return typeof total === "number" ? total : boot.vm.errors.length;
}

function diagnosticCount(boot: FrameXmlBoot): number {
  const diagnostics = (boot.bridge as typeof boot.bridge & { readonly diagnostics?: readonly unknown[] }).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics.length : 0;
}

/** The lazy owner: load on first show, gate, then the stock window's own show and hide. */
export function createFrameXmlLodWindowOwner(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  spec: FrameXmlLodWindowSpec,
): FrameXmlLodWindowOwner {
  let root: FrameXmlFrame | undefined;
  let pending = false;
  let wanted = false;
  let failed = false;
  let disposed = false;
  const fail = (): void => {
    if (failed || disposed) return;
    failed = true;
    const waiting = wanted;
    wanted = false;
    if (root) {
      try { boot.bridge.Hide(root); } catch { /* the native window takes over either way */ }
    }
    try { spec.onFailure(waiting); } catch { /* the route already answers false */ }
  };
  const showStock = (frame: FrameXmlFrame): void => {
    const errors = errorCount(boot);
    const diagnostics = diagnosticCount(boot);
    boot.bridge.runInMutationBatch(() => {
      boot.vm.executeReported(spec.showSource, `@webclient/${spec.addon}-show`);
    });
    // A Lua error or a bridge diagnostic is a broken window; a show the stock panel manager simply
    // declined (another UIPanel holding its place) is the client's own answer, and the next press
    // may succeed.
    if (errorCount(boot) > errors || diagnosticCount(boot) > diagnostics) fail();
    else if (!boot.bridge.isVisible(frame)) wanted = false;
  };
  const load = async (): Promise<void> => {
    try {
      const [result] = await Promise.all([boot.loadAddon(spec.addon), spec.prepare?.() ?? Promise.resolve()]);
      if (disposed) return;
      if (!result.ok) { fail(); return; }
      renderer.addRoots(result.roots);
      // The add-on parents its windows into UIParent, so its own root list can be empty.
      renderer.sync();
      const gated = spec.gate(boot, renderer);
      if (!gated) { fail(); return; }
      spec.adopt?.(boot, gated, renderer);
      root = gated;
      if (wanted) showStock(gated);
    } catch {
      fail();
    } finally {
      pending = false;
    }
  };
  return {
    get failed() { return failed; },
    isOpen: () => !disposed && !failed && (pending ? wanted : root !== undefined && boot.bridge.isVisible(root)),
    show: () => {
      if (disposed || failed) return false;
      wanted = true;
      if (root) {
        if (!boot.bridge.isVisible(root)) showStock(root);
        return !failed;
      }
      if (!pending) {
        pending = true;
        void load();
      }
      return true;
    },
    hide: () => {
      wanted = false;
      if (!root || !boot.bridge.isVisible(root)) return;
      boot.bridge.runInMutationBatch(() => {
        boot.vm.executeReported(spec.hideSource, `@webclient/${spec.addon}-hide`);
      });
      if (boot.bridge.isVisible(root)) boot.bridge.Hide(root);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      wanted = false;
      if (root) {
        try { boot.bridge.Hide(root); } catch { /* teardown */ }
      }
      root = undefined;
    },
  };
}

/**
 * Run `code` (a Lua function body returning `results` values) with the named globals replaced by
 * no-ops, restoring them afterwards: a gate's silent Show/Hide pass must not play sounds, open the
 * game menu or grey the bag buttons. Undefined on a Lua failure or a new reported error.
 */
export function frameXmlLodSilentProbe(
  boot: FrameXmlBoot,
  chunk: string,
  silenced: readonly string[],
  code: string,
  results: number,
): readonly unknown[] | undefined {
  const names = silenced.map((name) => JSON.stringify(name)).join(", ");
  const probe = boot.vm.compileFunction(`
local names = { ${names} }
local saved = {}
for index = 1, #names do saved[index] = _G[names[index]]; _G[names[index]] = function() end end
local results = { pcall(function() ${code} end) }
for index = 1, #names do _G[names[index]] = saved[index] end
if not results[1] then error(results[2], 0) end
return select(2, table.unpack(results, 1, ${results + 1}))
`, chunk, []);
  if (!probe) return undefined;
  try {
    const errors = errorCount(boot);
    const diagnostics = diagnosticCount(boot);
    const values = boot.vm.call(probe, [], results);
    return errorCount(boot) === errors && diagnosticCount(boot) === diagnostics ? values : undefined;
  } finally {
    boot.vm.release(probe);
  }
}

/**
 * A named frame of `type`, a descendant of `root`, drawn: inside `rootElement`, or in the strata
 * layer the renderer lifts a child of a higher frameStrata into (MacroFrame's HIGH
 * MacroFrameSelectedMacroButton and MacroEditButton are drawn beside it, not inside it).
 */
export function frameXmlLodChild(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  root: FrameXmlFrame,
  rootElement: HTMLElement,
  name: string,
  type: string,
): FrameXmlFrame | undefined {
  const frame = boot.bridge.getFrame(name);
  if (!frame || frame.type !== type) return undefined;
  let ancestor: FrameXmlFrame | undefined = frame;
  while (ancestor && ancestor !== root) ancestor = ancestor.parent;
  if (!ancestor) return undefined;
  const element = renderer.elementFor(frame);
  if (!element || element.getAttribute("data-framexml-name") !== name) return undefined;
  let node: HTMLElement | null = element;
  while (node && node !== rootElement) node = node.parentElement;
  if (node) return frame;
  return frame.frameStrata !== root.frameStrata ? frame : undefined;
}
