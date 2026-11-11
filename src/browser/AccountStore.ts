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

/** What a store needs from the world: `WorldClient` is one. */
export type AccountStoreWorld = Pick<WorldClient, "requestAccountData" | "accountData" | "saveAccountData" | "realmName" | "state">;

export interface AccountStoreOptions<T> {
  /** One of the eight `AccountDataType` values. */
  slot: number;
  /** The `localStorage` key the same data is mirrored under. */
  mirrorKey: string;
  fallback: () => T;
  parse: (text: string) => T | undefined;
  serialise: (value: T) => string;
  /**
   * 4.16 (11.11): never write over a server copy this store cannot read (another client's text in the
   * slot); changes then stay in the mirror. The settings store sets it for slot 1, Wow.exe's config.
   */
  keepForeign?: boolean;
  /**
   * 5.37 (11.11): a per-character slot's mirror is that character's. The scope (the realm and the
   * character's guid) is added to `mirrorKey` when a world is attached; before that, and when it cannot be
   * told, nothing is mirrored and the store starts from `fallback`, never from another character's copy.
   */
  mirrorScope?: (world: AccountStoreWorld) => string | undefined;
  /**
   * 5.37 (11.11): the server's answer is the truth once it has arrived. Nothing is written before it,
   * so a change made while it travels cannot land on another client's text; and an empty answer — the
   * core answers a request for an empty slot with size 0 (MiscHandler.cpp HandleRequestAccountData), and
   * an erase leaves the slot empty with time 0 — means `fallback`, mirror included.
   */
  serverIsTruth?: boolean;
}

/** The realm and the character's guid: the per-character scope of a mirror (as SavedVariables keys it). */
export function characterMirrorScope(world: AccountStoreWorld): string | undefined {
  const guid = world.state.selfGuid;
  return guid === undefined || !world.realmName ? undefined : `${world.realmName}/${guid.toString()}`;
}

export class AccountStore<T> {
  readonly #options: AccountStoreOptions<T>;
  #value: T;
  #timer: number | undefined;
  #world: AccountStoreWorld | undefined;
  /** The key the mirror is kept under now; undefined while a scoped store has no scope. */
  #mirrorKey: string | undefined;
  /**
   * 4.16 (11.11): with `keepForeign`, the server's slot holds text this store cannot read — Wow.exe's
   * own config cache (`SET` lines in slot 1) when the same character also plays there. Such a slot is
   * never written over: changes stay in the mirror, and Wow.exe's copy survives.
   */
  #foreign = false;
  /** 5.37: the server has answered for the slot since `attach`. */
  #answered = false;
  /** Raised when the server's copy lands and differs from what was being shown. */
  onLoaded: ((value: T) => void) | undefined;

  constructor(options: AccountStoreOptions<T>) {
    this.#options = options;
    this.#mirrorKey = options.mirrorScope ? undefined : options.mirrorKey;
    this.#value = this.#readMirror() ?? options.fallback();
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
  attach(world: AccountStoreWorld): void {
    this.#world = world;
    this.#foreign = false;
    this.#answered = false;
    if (this.#options.mirrorScope) {
      const scope = this.#options.mirrorScope(world);
      this.#mirrorKey = scope === undefined ? undefined : `${this.#options.mirrorKey}:${scope}`;
      this.#value = this.#readMirror() ?? this.#options.fallback();
    }
    world.requestAccountData(this.#options.slot);
  }

  detach(): void {
    this.flush();
    this.#world = undefined;
  }

  /** Takes the server's copy, if this event was about this slot and it parsed. */
  accept(type: number): boolean {
    if (type !== this.#options.slot || !this.#world) return false;
    this.#answered = true;
    const stored = this.#world.accountData.get(this.#options.slot);
    if (!stored || stored.text === "") {
      this.#foreign = false;
      if (this.#options.serverIsTruth !== true) return false;
      // 5.37: the slot is empty on the server: nothing, not the mirror's copy.
      const empty = this.#options.fallback();
      this.#value = empty;
      this.#writeMirror(this.#options.serialise(empty));
      this.onLoaded?.(empty);
      return true;
    }
    const parsed = this.#options.parse(stored.text);
    // 4.16 (11.11): unreadable text that is there is another client's; an empty slot is free.
    this.#foreign = this.#options.keepForeign === true && parsed === undefined && stored.text.trim() !== "";
    if (parsed === undefined) return false;
    this.#value = parsed;
    this.#writeMirror(this.#options.serialise(parsed));
    this.onLoaded?.(parsed);
    return true;
  }

  /** Whether the server's slot holds another client's text, which this store leaves alone (4.16). */
  get foreign(): boolean {
    return this.#foreign;
  }

  /** Whether a write may go out now: a world, a slot that is not another client's, an answer when needed. */
  #mayWrite(): boolean {
    return this.#world !== undefined && !this.#foreign && (this.#answered || this.#options.serverIsTruth !== true);
  }

  /** Records a new value, mirrors it at once and schedules the round trip. */
  set(value: T): void {
    this.#value = value;
    const text = this.#options.serialise(value);
    this.#writeMirror(text);
    if (!this.#mayWrite()) return;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#mayWrite()) return;
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
    if (!this.#mayWrite()) return;
    void this.#world?.saveAccountData(this.#options.slot, this.#options.serialise(this.#value)).catch(() => {});
  }

  #readMirror(): T | undefined {
    if (this.#mirrorKey === undefined) return undefined;
    try {
      const text = window.localStorage?.getItem(this.#mirrorKey);
      return text === null || text === undefined ? undefined : this.#options.parse(text);
    } catch {
      return undefined;
    }
  }

  #writeMirror(text: string): void {
    if (this.#mirrorKey === undefined) return;
    try {
      window.localStorage?.setItem(this.#mirrorKey, text);
    } catch {
      // A blocked store costs the mirror, not the setting: the server's copy still stands.
    }
  }
}
