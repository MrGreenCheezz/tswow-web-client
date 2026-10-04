/**
 * Key bindings and window positions in the account data (WORK_PLAN 4.12, М-A5-2), so they belong
 * to the player rather than to one browser profile; `localStorage` stays the mirror the first frame
 * is drawn from.
 *
 *  - Bindings: slot 2, `GLOBAL_BINDINGS_CACHE` (per account), in the envelope the owner's Unity
 *    client already keeps there (`BindingsAccount.ts`). The copy is merged, never replaced: rows
 *    this client does not know ride along, a row changed here while the answer travelled wins, and
 *    a slot holding anything but the envelope is left alone — not applied, never overwritten.
 *  - Window positions: slot 6, `PER_CHARACTER_LAYOUT_CACHE` (per character; the core drops a
 *    per-character slot written without a character, WorldSession.cpp:821-849), as
 *    `{"format":"wowclient-layout","version":1,"windows":{id:{left,top}}}`. The original client
 *    keeps its own layout text in the same slot; that text is likewise never applied or overwritten.
 *
 * Both are off until switched on ({@link INPUT_ACCOUNT_SYNC_KEYS}): sharing slot 2 with the Unity
 * client is the owner's call (IMPLEMENTATION_PLAN §5 row 16, §7), and slot 6 is shared with
 * Wow.exe's own layout cache for a character played in both. Off, nothing here sends or applies
 * anything and the two tables behave exactly as before.
 *
 * World-free in its logic: the world, the table and the window layout are handed in.
 */

import {
  ACCOUNT_DATA_WRITE_LIMIT, changedRows, mergeServerOverLocal, parseBindingsEnvelope, serialiseBindingsEnvelope,
  utf8Length, type BindingRow, type BindingsEnvelope,
} from "./BindingsAccount.js";

/** `AccountDataType` (SessionProtocol.ts): the two slots this module keeps. */
export const BINDINGS_ACCOUNT_SLOT = 2;
export const LAYOUT_ACCOUNT_SLOT = 6;
/** How long a change waits for its neighbours, as `AccountStore` waits. */
export const ACCOUNT_SAVE_DELAY_MS = 1_500;

/**
 * The switches, read from `localStorage` (`"on"` enables): one per slot, both off by default
 * until the owner rules (see the module comment).
 */
export const INPUT_ACCOUNT_SYNC_KEYS = {
  bindings: "webclient.account-sync.bindings",
  layout: "webclient.account-sync.layout",
} as const;

/** What a slot store needs from the world: `WorldClient` is one. */
export interface AccountWorld {
  requestAccountData(type: number): void;
  readonly accountData: ReadonlyMap<number, { readonly text: string }>;
  saveAccountData(type: number, text: string): Promise<void>;
}

/** The binding table's side (`Bindings.ts`). */
export interface BindingTableHost {
  tables(): { core: Readonly<Record<string, BindingRow>>; modules: Readonly<Record<string, BindingRow>> };
  apply(core: Readonly<Record<string, BindingRow>>, modules: Readonly<Record<string, BindingRow>>): void;
  onChanged(listener: () => void): () => void;
}

/** The window manager's side (`GameWindows.ts`). */
export interface LayoutHost {
  layout(): Readonly<Record<string, LayoutPlacement>>;
  apply(layout: Readonly<Record<string, LayoutPlacement>>): void;
  onChanged(listener: ((layout: Readonly<Record<string, LayoutPlacement>>) => void) | undefined): void;
}

export interface LayoutPlacement {
  readonly left: number;
  readonly top: number;
}

export interface AccountTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: AccountTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Whether a slot's switch is on (`localStorage[key] === "on"`); a blocked store answers off. */
export function accountSyncEnabled(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "on";
  } catch {
    return false;
  }
}

/** One slot's round trip: debounced writes, a pending write sent on leaving, a guard on foreign text. */
abstract class SlotSync {
  protected world: AccountWorld | undefined;
  /** The slot holds something that is not this envelope: hands off for the rest of the session. */
  protected foreign = false;
  /**
   * The server has answered for this slot since {@link attach}. Nothing is written before: the slot
   * may hold another client's text (Unity's envelope, Wow.exe's caches), and a change made while the
   * answer travels — an add-on's SetBinding at load, a window dragged — is merged over the answer.
   */
  #answered = false;
  #timer: unknown;

  constructor(
    protected readonly slot: number,
    protected readonly enabled: () => boolean,
    protected readonly timers: AccountTimers,
    protected readonly onForeign: ((slot: number) => void) | undefined,
  ) {}

  attach(world: AccountWorld): void {
    if (!this.enabled()) return;
    this.world = world;
    this.foreign = false;
    this.#answered = false;
    this.cancel();
    this.reset();
    world.requestAccountData(this.slot);
  }

  /** Sends a pending write now and lets go of the world. */
  detach(): void {
    this.flush();
    this.world = undefined;
  }

  flush(): void {
    if (this.#timer === undefined) return;
    this.timers.clear(this.#timer);
    this.#timer = undefined;
    this.write();
  }

  /** Takes the server's copy when this event is about this slot; answers whether it was applied. */
  accept(type: number): boolean {
    if (type !== this.slot || !this.world) return false;
    this.#answered = true;
    const stored = this.world.accountData.get(this.slot);
    if (!stored || stored.text === "") {
      // An empty slot is this client's to fill.
      this.schedule();
      return false;
    }
    if (!this.take(stored.text)) {
      if (!this.foreign) this.onForeign?.(this.slot);
      this.foreign = true;
      this.cancel();
      return false;
    }
    return true;
  }

  protected schedule(): void {
    if (!this.world || this.foreign || !this.#answered) return;
    this.cancel();
    this.#timer = this.timers.set(() => {
      this.#timer = undefined;
      this.write();
    }, ACCOUNT_SAVE_DELAY_MS);
  }

  protected cancel(): void {
    if (this.#timer !== undefined) this.timers.clear(this.#timer);
    this.#timer = undefined;
  }

  protected write(): void {
    const world = this.world;
    if (!world || this.foreign || !this.#answered) return;
    const text = this.text();
    if (utf8Length(text) > ACCOUNT_DATA_WRITE_LIMIT) return;
    void world.saveAccountData(this.slot, text).then(() => this.saved(), () => {
      // A refused save costs the round trip and nothing else: the mirror already has it.
    });
  }

  protected abstract reset(): void;
  /** Applies the server's text; false when it is not this envelope. */
  protected abstract take(text: string): boolean;
  protected abstract text(): string;
  protected saved(): void {}
}

/** Slot 2: the binding tables in the Unity client's envelope. */
export class BindingsAccountSync extends SlotSync {
  readonly #host: BindingTableHost;
  readonly #changedCore = new Set<string>();
  readonly #changedModules = new Set<string>();
  #last: ReturnType<BindingTableHost["tables"]>;
  /** The server's envelope as last merged: its unknown rows and `modifiedClicks` ride along. */
  #server: BindingsEnvelope | undefined;
  #applying = false;

  constructor(host: BindingTableHost, options: {
    enabled?: () => boolean; timers?: AccountTimers; onForeign?: (slot: number) => void;
  } = {}) {
    super(BINDINGS_ACCOUNT_SLOT, options.enabled ?? (() => accountSyncEnabled(INPUT_ACCOUNT_SYNC_KEYS.bindings)),
      options.timers ?? DEFAULT_TIMERS, options.onForeign);
    this.#host = host;
    this.#last = host.tables();
    host.onChanged(() => this.#changed());
  }

  protected reset(): void {
    this.#changedCore.clear();
    this.#changedModules.clear();
    this.#server = undefined;
    this.#last = this.#host.tables();
  }

  #changed(): void {
    if (this.#applying) return;
    const next = this.#host.tables();
    if (this.world) {
      for (const name of changedRows(this.#last.core, next.core)) this.#changedCore.add(name);
      for (const name of changedRows(this.#last.modules, next.modules)) this.#changedModules.add(name);
    }
    this.#last = next;
    this.schedule();
  }

  protected take(text: string): boolean {
    const server = parseBindingsEnvelope(text);
    if (!server) return false;
    const merged = mergeServerOverLocal(server, this.#host.tables(), this.#changedCore, this.#changedModules);
    this.#server = merged;
    this.#applying = true;
    try {
      this.#host.apply(merged.core, merged.modules);
    } finally {
      this.#applying = false;
    }
    this.#last = this.#host.tables();
    if (this.text() !== text) this.schedule();
    return true;
  }

  protected text(): string {
    const local = this.#host.tables();
    return serialiseBindingsEnvelope({
      core: { ...this.#server?.core, ...local.core },
      modules: { ...this.#server?.modules, ...local.modules },
      modifiedClicks: this.#server?.modifiedClicks ?? {},
    });
  }

  protected saved(): void {
    this.#changedCore.clear();
    this.#changedModules.clear();
  }
}

export const LAYOUT_ENVELOPE_FORMAT = "wowclient-layout";

/** The layout envelope, or undefined for any other text (the original client's layout cache among it). */
export function parseLayoutEnvelope(text: string): Record<string, LayoutPlacement> | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
  const value = root as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 3 || value["format"] !== LAYOUT_ENVELOPE_FORMAT || value["version"] !== 1) return undefined;
  const windows = value["windows"];
  if (!windows || typeof windows !== "object" || Array.isArray(windows)) return undefined;
  const result: Record<string, LayoutPlacement> = {};
  // Placements that are not two finite numbers are dropped, as the localStorage reader drops them.
  for (const [id, placement] of Object.entries(windows as Record<string, unknown>)) {
    if (!placement || typeof placement !== "object") continue;
    const { left, top } = placement as Record<string, unknown>;
    if (typeof left === "number" && Number.isFinite(left) && typeof top === "number" && Number.isFinite(top)) {
      result[id] = { left, top };
    }
  }
  return result;
}

export function serialiseLayoutEnvelope(windows: Readonly<Record<string, LayoutPlacement>>): string {
  return JSON.stringify({ format: LAYOUT_ENVELOPE_FORMAT, version: 1, windows });
}

/** Slot 6: the window positions. A window moved here while the answer travelled keeps its place. */
export class LayoutAccountSync extends SlotSync {
  readonly #host: LayoutHost;
  readonly #moved = new Set<string>();
  #last: Readonly<Record<string, LayoutPlacement>> = {};

  constructor(host: LayoutHost, options: {
    enabled?: () => boolean; timers?: AccountTimers; onForeign?: (slot: number) => void;
  } = {}) {
    super(LAYOUT_ACCOUNT_SLOT, options.enabled ?? (() => accountSyncEnabled(INPUT_ACCOUNT_SYNC_KEYS.layout)),
      options.timers ?? DEFAULT_TIMERS, options.onForeign);
    this.#host = host;
    host.onChanged((layout) => this.#changed(layout));
  }

  protected reset(): void {
    this.#moved.clear();
    this.#last = this.#host.layout();
  }

  #changed(layout: Readonly<Record<string, LayoutPlacement>>): void {
    if (this.world) {
      for (const id of new Set([...Object.keys(this.#last), ...Object.keys(layout)])) {
        const a = this.#last[id];
        const b = layout[id];
        if (a?.left !== b?.left || a?.top !== b?.top) this.#moved.add(id);
      }
    }
    this.#last = layout;
    this.schedule();
  }

  protected take(text: string): boolean {
    const server = parseLayoutEnvelope(text);
    if (!server) return false;
    const local = this.#host.layout();
    const merged: Record<string, LayoutPlacement> = { ...server };
    for (const id of this.#moved) {
      const placement = local[id];
      if (placement) merged[id] = placement;
      else delete merged[id];
    }
    this.#host.apply(merged);
    this.#last = this.#host.layout();
    if (this.text() !== text) this.schedule();
    return true;
  }

  protected text(): string {
    return serialiseLayoutEnvelope(this.#host.layout());
  }

  protected saved(): void {
    this.#moved.clear();
  }
}
