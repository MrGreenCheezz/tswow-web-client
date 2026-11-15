/**
 * Key bindings and window positions in the account data (WORK_PLAN 4.12, М-A5-2), so they belong
 * to the player rather than to one browser profile; `localStorage` stays the mirror the first frame
 * is drawn from.
 *
 *  - Bindings: slots 2 and 3, since 5.37 (15.11) in Wow.exe's own bindings cache text
 *    (`BindingsSlotSync.ts`); the JSON envelope written here before is still read there.
 *  - Window positions: slot 6, `PER_CHARACTER_LAYOUT_CACHE` (per character; the core drops a
 *    per-character slot written without a character, WorldSession.cpp:821-849), as
 *    `{"format":"wowclient-layout","version":1,"windows":{id:{left,top}}}`. Foreign text in the
 *    slot is likewise never applied or overwritten. (5.37: Wow.exe 12340's account-data table at
 *    0x00ad94e0 names a cache file for slots 0–5 and 7 and none for slot 6, so it keeps no text here.)
 *
 * Both are on unless switched off ({@link INPUT_ACCOUNT_SYNC_KEYS}): the owner ruled for them on 12.10
 * (WORK_PLAN 4.12), knowing that slot 2 is shared with the Unity client and slot 6 with Wow.exe's own
 * layout cache for a character played in both — which is why foreign text is never touched. Off,
 * nothing here sends or applies anything and the two tables stay this browser's own.
 *
 * World-free in its logic: the world, the table and the window layout are handed in.
 */

import { ACCOUNT_DATA_WRITE_LIMIT, utf8Length } from "./BindingsAccount.js";

/** `AccountDataType` (SessionProtocol.ts): the slot this module keeps (bindings: `BindingsSlotSync.ts`). */
export const LAYOUT_ACCOUNT_SLOT = 6;
/** How long a change waits for its neighbours, as `AccountStore` waits. */
export const ACCOUNT_SAVE_DELAY_MS = 1_500;

/**
 * The switches, read from `localStorage` (`"off"` disables): one per slot, both on by default since
 * the owner's ruling of 12.10 (see the module comment).
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

/**
 * Whether a slot's switch is on: anything but `localStorage[key] === "off"`. A blocked store answers
 * off — without a local mirror there is nothing to merge the server's copy into.
 */
export function accountSyncEnabled(key: string): boolean {
  try {
    const storage = globalThis.localStorage;
    return storage !== undefined && storage.getItem(key) !== "off";
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
    if (this.requestsSlot) world.requestAccountData(this.slot);
  }

  /**
   * Review 15.11: whether `attach` asks for the slot. Slot 6 is asked for by the settings store, which shares
   * it (ui/SettingsAccountStore.ts); one request per slot, both listen for the answer.
   */
  requestsSlot = true;

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
    // Review 15.11: the first answer only; a later event is the COMPLETE of a write (this store's or the
    // settings store's in slot 6) and re-reading it took back windows moved since that text was built.
    if (type !== this.slot || !this.world || this.#answered) return false;
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

// 5.37 (15.11): slot 2 (and 3) is `BindingsSlotSync.ts`, in Wow.exe's own bindings cache text; the envelope
// of before is only read there (`BindingsAccount.parseBindingsEnvelope`).

export const LAYOUT_ENVELOPE_FORMAT = "wowclient-layout";

/**
 * Slot 6's envelope as an object: `format`, `version`, `windows`, and since 5.37 (15.11) optionally `settings`
 * (this client's own settings, `ui/SettingsAccountStore.ts`); undefined for any other text.
 *
 * Why slot 6 may hold them (re-checked 15.11): Wow.exe 12340's account-data entry 6 names no cache file
 * (0x00ad9668 is null; its `layout-local.txt` at 0x00ad9664 is the local file 0x006b9be0 writes) and is
 * marked local (0x00ad9674 = 1): the account-data times handler 0x006b94c0 neither stores its time nor asks
 * for it, and 0x006b9440 arms no upload timer for it. The one path that sends it is the Lua
 * `UploadSettings()` (0x00511f90 → 0x006b9c60 → 0x006b9100), which would send it empty — the stock interface
 * never calls it, only an add-on or `/script` can.
 */
function parseSlot6Envelope(text: string): Record<string, unknown> | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
  const value = root as Record<string, unknown>;
  const keys = Object.keys(value);
  const settings = value["settings"];
  const withSettings = keys.length === 4 && settings !== undefined;
  if ((keys.length !== 3 && !withSettings) || value["format"] !== LAYOUT_ENVELOPE_FORMAT || value["version"] !== 1) return undefined;
  if (withSettings && (!settings || typeof settings !== "object" || Array.isArray(settings))) return undefined;
  const windows = value["windows"];
  if (!windows || typeof windows !== "object" || Array.isArray(windows)) return undefined;
  return value;
}

/** Whether a slot-6 text is this client's envelope (empty text counts: nothing is there to keep). */
export function slot6IsOurs(text: string): boolean {
  return text.trim() === "" || parseSlot6Envelope(text) !== undefined;
}

/** The envelope's `settings`, or undefined when it has none or the text is not the envelope. */
export function slot6Settings(text: string): Record<string, unknown> | undefined {
  const settings = parseSlot6Envelope(text)?.["settings"];
  return settings && typeof settings === "object" ? settings as Record<string, unknown> : undefined;
}

/** The envelope with new `settings`, the windows kept as the text has them. */
export function slot6WithSettings(text: string, settings: Readonly<Record<string, unknown>>): string {
  const windows = parseSlot6Envelope(text)?.["windows"] ?? {};
  return JSON.stringify({ format: LAYOUT_ENVELOPE_FORMAT, version: 1, windows, settings });
}

/** The layout envelope, or undefined for any other text (the original client's layout cache among it). */
export function parseLayoutEnvelope(text: string): Record<string, LayoutPlacement> | undefined {
  const value = parseSlot6Envelope(text);
  if (!value) return undefined;
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

/** The layout envelope; `settings` (5.37) ride along when given. */
export function serialiseLayoutEnvelope(windows: Readonly<Record<string, LayoutPlacement>>, settings?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(settings === undefined
    ? { format: LAYOUT_ENVELOPE_FORMAT, version: 1, windows }
    : { format: LAYOUT_ENVELOPE_FORMAT, version: 1, windows, settings });
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
    // 5.37: the settings the slot holds beside the windows (ui/SettingsAccountStore.ts) are kept as they are.
    const current = this.world?.accountData.get(this.slot)?.text ?? "";
    return serialiseLayoutEnvelope(this.#host.layout(), slot6Settings(current));
  }

  protected saved(): void {
    this.#moved.clear();
  }
}
