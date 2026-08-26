/**
 * Where the client's own preferences live.
 *
 * The server has carried eight slots for exactly this since slice P8 — config, key bindings,
 * macros and the window layout, per account and per character — and nothing had ever written to
 * one. Settings sat in `localStorage` instead, which means they belong to a browser profile rather
 * than to a player: a second machine, a second browser, or a cleared site data and they are gone.
 *
 * So each store reads the server's copy when it arrives and writes back through
 * `CMSG_UPDATE_ACCOUNT_DATA`, with `localStorage` kept as a mirror rather than as the truth. The
 * mirror matters: an account-data blob only arrives after the request, and the interface is drawn
 * before that, so the first paint has to come from somewhere.
 *
 * Writes are debounced. A settings window with a slider in it would otherwise deflate and send a
 * packet per pixel.
 */

import type { WorldClient } from "../world/WorldClient.js";

/** How long a change waits for its neighbours before it goes out. */
const SAVE_DELAY_MS = 1_500;

export interface AccountStoreOptions<T> {
  /** One of the eight `AccountDataType` values. */
  slot: number;
  /** The `localStorage` key the same data is mirrored under. */
  mirrorKey: string;
  fallback: () => T;
  parse: (text: string) => T | undefined;
  serialise: (value: T) => string;
}

export class AccountStore<T> {
  readonly #options: AccountStoreOptions<T>;
  #value: T;
  #timer: number | undefined;
  #world: WorldClient | undefined;
  /** Raised when the server's copy lands and differs from what was being shown. */
  onLoaded: ((value: T) => void) | undefined;

  constructor(options: AccountStoreOptions<T>) {
    this.#options = options;
    this.#value = readMirror(options) ?? options.fallback();
  }

  get value(): T {
    return this.#value;
  }

  /**
   * Points the store at a world and asks for the slot.
   *
   * The answer arrives as `ACCOUNT_DATA_CHANGED`; whoever owns the store subscribes and calls
   * `accept`. Until then the mirror is what is shown.
   */
  attach(world: WorldClient): void {
    this.#world = world;
    world.requestAccountData(this.#options.slot);
  }

  detach(): void {
    this.flush();
    this.#world = undefined;
  }

  /** Takes the server's copy, if this event was about this slot and it parsed. */
  accept(type: number): boolean {
    if (type !== this.#options.slot) return false;
    const stored = this.#world?.accountData.get(this.#options.slot);
    if (!stored) return false;
    const parsed = this.#options.parse(stored.text);
    if (parsed === undefined) return false;
    this.#value = parsed;
    writeMirror(this.#options, this.#options.serialise(parsed));
    this.onLoaded?.(parsed);
    return true;
  }

  /** Records a new value, mirrors it at once and schedules the round trip. */
  set(value: T): void {
    this.#value = value;
    const text = this.#options.serialise(value);
    writeMirror(this.#options, text);
    if (!this.#world) return;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined;
      void this.#world?.saveAccountData(this.#options.slot, text).catch(() => {
        // A refused save costs the round trip and nothing else: the mirror already has it.
      });
    }, SAVE_DELAY_MS);
  }

  /** Sends a pending write now. Called when a world is left, so nothing is lost with it. */
  flush(): void {
    if (this.#timer === undefined) return;
    window.clearTimeout(this.#timer);
    this.#timer = undefined;
    void this.#world?.saveAccountData(this.#options.slot, this.#options.serialise(this.#value)).catch(() => {});
  }
}

function readMirror<T>(options: AccountStoreOptions<T>): T | undefined {
  try {
    const text = window.localStorage?.getItem(options.mirrorKey);
    return text === null || text === undefined ? undefined : options.parse(text);
  } catch {
    return undefined;
  }
}

function writeMirror<T>(options: AccountStoreOptions<T>, text: string): void {
  try {
    window.localStorage?.setItem(options.mirrorKey, text);
  } catch {
    // A blocked store costs the mirror, not the setting: the server's copy still stands.
  }
}
