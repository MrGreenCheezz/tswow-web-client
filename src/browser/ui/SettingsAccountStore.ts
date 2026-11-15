/**
 * The settings over the account's data, beside Wow.exe's own (5.37).
 *
 * Until 5.37 the whole settings blob went to account-data slot 1 as this client's JSON — the slot Wow.exe
 * keeps the character's `SET` lines in, so each client's write erased the other's. Now:
 *  - the settings that are stock CVars of slot 0 or 1 in Wow.exe (`SettingsCVarSlots.ts`) are read from and
 *    written to those slots as Wow.exe's `SET` lines (`CVarCacheText.ts`), every other line of the slot
 *    written back as it was read; so are the stock interface's own CVars of those slots (trackedQuests,
 *    minimapZoom, …), for the FrameXML VM (`StockCVarSlots.ts`);
 *  - every other setting — this client's own, and the stock ones Wow.exe keeps on the machine — goes to
 *    slot 6 beside the window layout (`input/InputAccount.ts`, `settings` of its envelope): Wow.exe never asks
 *    for or writes slot 6 in play (see `InputAccount.parseSlot6Envelope`), and an unknown `SET` name would be
 *    dropped by its next write of slot 0/1 (0x007681f0). So the settings follow the character to any machine.
 *
 * The rules (review of 15.11):
 *  - nothing is applied or written before slots 0, 1 and 6 have all answered; the answers are the truth. A slot
 *    of Wow.exe's lines with no line for a registered CVar means that CVar's registered default, as Wow.exe reads
 *    it (0x00767030 writes no line for a default); slot 6 with no settings means the defaults. This browser's copy
 *    only stands in before the answers (and while slot 6 holds another client's text: then the character's own
 *    copy here, never another character's);
 *  - a setting or stock CVar changed while the answers travel keeps its new value and is written after them;
 *  - what is known to be on the server (the base each write is built on) moves only with the server's
 *    `SMSG_UPDATE_ACCOUNT_DATA_COMPLETE` for that slot; a text the core would drop (over 0xFFFF, MiscHandler.cpp:914)
 *    is not sent, and the player is told;
 *  - slot 1 holding this client's JSON of before 5.37 is read for the character's CVars and this client's own
 *    settings; slot 6 is written first, and slot 1 is rewritten as `SET` lines only once the server has confirmed
 *    slot 6 — never while slot 6 holds another client's text. The account's slot 0 is not touched by it;
 *  - everything per character or per account is reset at `attach`: the next login in the same page gets nothing
 *    of the one before.
 *
 * The same face as the `AccountStore` it replaces (`value`, `set`, `attach`, `accept`, `flush`, `detach`).
 */

import type { AccountStoreWorld } from "../AccountStore.js";
import {
  cvarTextOfSettings, frameXmlSettingsCVarRow, settingValueOfCVarText, type FrameXmlSettingsCVarDefinition,
} from "../framexml/FrameXmlSettingsCVar.js";
import { WOW_CVAR_REGISTRY, wowCVar, wowCVarSlot } from "../framexml/WowCVarRegistry.js";
import { ACCOUNT_DATA_WRITE_LIMIT, utf8Length } from "../input/BindingsAccount.js";
import { slot6IsOurs, slot6Settings, slot6WithSettings } from "../input/InputAccount.js";
import { cvarLineValue, parseCVarCacheText, renderCVarCacheText, withCVarValues, type CVarCacheLine } from "./CVarCacheText.js";
import { defaultSettings, parseSettings, serialiseSettings, type SettingValues } from "./SettingsModel.js";
import { CHARACTER_CONFIG_SLOT, SETTINGS_CVAR_SLOTS, type ConfigSlot, type SettingsCVarSlot } from "./SettingsCVarSlots.js";
import type { StockCVarSlots } from "./StockCVarSlots.js";

/** How long a change waits for its neighbours: a slider would otherwise send a packet per step. */
const SAVE_DELAY_MS = 1_500;
/** PER_CHARACTER_LAYOUT_CACHE: the window layout's envelope, which carries this client's own settings. */
export const SETTINGS_ENVELOPE_SLOT = 6;
type StoreSlot = ConfigSlot | typeof SETTINGS_ENVELOPE_SLOT;
const ALL_SLOTS: readonly StoreSlot[] = [0, 1, SETTINGS_ENVELOPE_SLOT];

export interface MappedRow extends SettingsCVarSlot {
  readonly binding: FrameXmlSettingsCVarDefinition;
}

export interface SettingsAccountStoreOptions {
  /** The `localStorage` key of this browser's copy of the settings (and, with a suffix, each character's). */
  readonly mirrorKey: string;
  readonly rows?: readonly SettingsCVarSlot[];
  /** A slot's text was not sent: the core would drop it without a word (over the account-data size limit). */
  readonly onRefused?: (slot: number) => void;
}

function storage(): Storage | undefined {
  try {
    return globalThis.window?.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function readItem(key: string): string | undefined {
  try {
    return storage()?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeItem(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // A blocked store costs the copy, not the setting.
  }
}

/** Wow.exe compares a value with its default without case (0x00767030 through 0x0076e780). */
function sameText(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class SettingsAccountStore implements StockCVarSlots {
  readonly #options: SettingsAccountStoreOptions;
  readonly #rows: readonly MappedRow[];
  /** Settings ids that live in config slots; every other id is slot 6's. */
  readonly #cvarSettings: ReadonlySet<string>;
  #value: SettingValues;
  #world: AccountStoreWorld | undefined;
  readonly #answered = new Set<StoreSlot>();
  /** All three answers are in and applied. */
  #applied = false;
  /** Each slot's text as the server is known to hold it: the answer, then each confirmed write. */
  readonly #confirmed = new Map<StoreSlot, string>();
  /** The text last sent to a slot and not yet confirmed. */
  readonly #sent = new Map<StoreSlot, string>();
  /** Slot 1 holds this client's JSON of before 5.37 until its rewrite is confirmed. */
  #legacy = false;
  /** Slot 6 holds text that is not this client's envelope: left alone. */
  #foreign6 = false;
  /** Slot 6 is known to hold this client's own settings: the old JSON may then be rewritten. */
  #ownOnServer = false;
  /** Settings and stock CVars changed while the answers travelled: they keep their value over them. */
  readonly #early = new Set<string>();
  readonly #earlyStock = new Set<string>();
  /** The slot CVars of the stock interface, by lower-cased name: the slots' values, then the interface's writes. */
  readonly #stock = new Map<string, string>();
  /** The slots' values of stock CVars as answered, for the VM. */
  #stockRows: (readonly [string, string])[] = [];
  readonly #stockListeners = new Set<(rows: readonly (readonly [string, string])[]) => void>();
  readonly #timers = new Map<StoreSlot, number>();
  /** Raised when the answers changed what is shown. */
  onLoaded: ((value: SettingValues) => void) | undefined;

  constructor(options: SettingsAccountStoreOptions) {
    this.#options = options;
    this.#rows = mappedSettingsCVarRows(options.rows);
    this.#cvarSettings = new Set(this.#rows.map((row) => row.binding.setting));
    const mirror = readItem(options.mirrorKey);
    this.#value = (mirror === undefined ? undefined : parseSettings(mirror)) ?? defaultSettings();
  }

  get value(): SettingValues {
    return this.#value;
  }

  /** Points the store at a world and asks for the three slots. Nothing of the last login is kept. */
  attach(world: AccountStoreWorld): void {
    this.#cancelAll();
    this.#world = world;
    this.#answered.clear();
    this.#applied = false;
    this.#confirmed.clear();
    this.#sent.clear();
    this.#legacy = false;
    this.#foreign6 = false;
    this.#ownOnServer = false;
    this.#early.clear();
    this.#earlyStock.clear();
    this.#stock.clear();
    this.#stockRows = [];
    for (const slot of ALL_SLOTS) world.requestAccountData(slot);
  }

  detach(): void {
    this.flush();
    this.#world = undefined;
  }

  /** The character's own copy here: where slot 6 holds another client's text, it stands in. */
  #characterMirrorKey(): string | undefined {
    const world = this.#world;
    const guid = world?.state.selfGuid;
    return world?.realmName && guid !== undefined ? `${this.#options.mirrorKey}:${world.realmName}/${guid.toString()}` : undefined;
  }

  #mirror(value: SettingValues): void {
    const text = serialiseSettings(value);
    writeItem(this.#options.mirrorKey, text);
    const own = this.#characterMirrorKey();
    if (own !== undefined) writeItem(own, text);
  }

  #text(slot: StoreSlot): string {
    return this.#world?.accountData.get(slot)?.text ?? "";
  }

  /**
   * `ACCOUNT_DATA_CHANGED`: the three answers (true when the last one changed the settings), then a slot's
   * `SMSG_UPDATE_ACCOUNT_DATA_COMPLETE` for a write — what the server is now known to hold.
   */
  accept(type: number): boolean {
    if ((type !== 0 && type !== 1 && type !== SETTINGS_ENVELOPE_SLOT) || !this.#world) return false;
    if (this.#applied) {
      this.#confirm(type);
      return false;
    }
    this.#answered.add(type);
    if (this.#answered.size < ALL_SLOTS.length) return false;
    return this.#applyAnswers();
  }

  /** A write of the slot reached the server (WorldClient keeps the text it sent as the slot's). */
  #confirm(slot: StoreSlot): void {
    const text = this.#text(slot);
    this.#confirmed.set(slot, text);
    if (this.#sent.get(slot) === text) this.#sent.delete(slot);
    if (slot === CHARACTER_CONFIG_SLOT && this.#legacy && parseSettings(text) === undefined) this.#legacy = false;
    if (slot === SETTINGS_ENVELOPE_SLOT && slot6Settings(text) !== undefined && !this.#ownOnServer) {
      this.#ownOnServer = true;
      // The old JSON's own settings are safe in slot 6 now: slot 1 may become Wow.exe's lines.
      if (this.#legacy) this.#schedule(CHARACTER_CONFIG_SLOT);
    }
  }

  #applyAnswers(): boolean {
    this.#applied = true;
    for (const slot of ALL_SLOTS) this.#confirmed.set(slot, this.#text(slot));
    const next: SettingValues = { ...this.#value };
    const take = (id: string, value: boolean | number | undefined): void => {
      if (value !== undefined && !this.#early.has(id)) next[id] = value;
    };
    const characterText = this.#text(1);
    const json = characterText === "" ? undefined : parseSettings(characterText);
    this.#legacy = json !== undefined;
    const lines = new Map<ConfigSlot, CVarCacheLine[]>([
      [0, parseCVarCacheText(this.#text(0))],
      [1, json !== undefined ? [] : parseCVarCacheText(characterText)],
    ]);
    // This client's own settings: slot 6's, else the old JSON's, else the defaults.
    const envelope = this.#text(SETTINGS_ENVELOPE_SLOT);
    this.#foreign6 = !slot6IsOurs(envelope);
    const own = this.#foreign6 ? undefined : slot6Settings(envelope);
    this.#ownOnServer = own !== undefined;
    let ownValues: SettingValues;
    if (own !== undefined) ownValues = parseSettings(JSON.stringify(own)) ?? defaultSettings();
    else if (json !== undefined) ownValues = json;
    else if (this.#foreign6) {
      const key = this.#characterMirrorKey();
      const copy = key === undefined ? undefined : readItem(key);
      ownValues = (copy === undefined ? undefined : parseSettings(copy)) ?? defaultSettings();
    } else ownValues = defaultSettings();
    for (const [id, value] of Object.entries(ownValues)) if (!this.#cvarSettings.has(id)) take(id, value);
    // The CVar rows: the slot's line, else the registered default; the old JSON for slot 1's when it is there.
    // The one-time carry-over of the old JSON: the character keeps exactly what it played with here — a row the
    // JSON does not name is this client's former default (parseSettings fills it), and where that is not Wow.exe's
    // default `slotText` writes it as an explicit line, so Wow.exe shows the same. That slot was never Wow.exe's
    // to read, so no choice of the original's is overridden. Slot 0's rows are account-wide and are not carried:
    // a missing line there may be Wow.exe's or another character's choice of the default.
    for (const row of this.#rows) {
      if (row.slot === CHARACTER_CONFIG_SLOT && json !== undefined) {
        take(row.binding.setting, json[row.binding.setting]);
        continue;
      }
      const value = cvarLineValue(lines.get(row.slot)!, row.cvar) ?? row.wowDefault;
      take(row.binding.setting, settingValueOfCVarText(row.binding, value));
    }
    // The stock interface's slot CVars, the same way; the slots' values are what its writes compare with.
    const stockRows: (readonly [string, string])[] = [];
    for (const registration of WOW_CVAR_REGISTRY.values()) {
      const key = registration.name.toLowerCase();
      const slot = wowCVarSlot(key);
      if (slot === undefined || this.#isSettingCVar(key)) continue;
      if (this.#earlyStock.has(key)) continue;
      const value = cvarLineValue(lines.get(slot)!, registration.name) ?? registration.defaultValue;
      if (value === undefined) continue;
      this.#stock.set(key, value);
      stockRows.push([registration.name, value]);
    }
    this.#stockRows = stockRows;
    for (const listener of [...this.#stockListeners]) {
      try { listener(stockRows); } catch (error) { console.error("[settings] stock CVar listener failed", error); }
    }
    const changed = Object.keys(next).some((id) => next[id] !== this.#value[id]);
    this.#value = next;
    this.#mirror(next);
    // The old JSON: slot 6 first (slot 1 follows its confirmation, `#confirm`); nothing while slot 6 is foreign.
    if (this.#legacy && !this.#foreign6) this.#schedule(this.#ownOnServer ? CHARACTER_CONFIG_SLOT : SETTINGS_ENVELOPE_SLOT);
    for (const slot of this.#slotsOf(this.#early, this.#earlyStock)) this.#schedule(slot);
    this.#early.clear();
    this.#earlyStock.clear();
    if (changed) this.onLoaded?.(next);
    return changed;
  }

  #isSettingCVar(lowerName: string): boolean {
    return this.#rows.some((row) => row.cvar.toLowerCase() === lowerName);
  }

  /** The slots a set of changed settings and stock CVars touch. */
  #slotsOf(ids: ReadonlySet<string>, stock: ReadonlySet<string>): Set<StoreSlot> {
    const slots = new Set<StoreSlot>();
    for (const id of ids) {
      const row = this.#rows.find((entry) => entry.binding.setting === id);
      slots.add(row ? row.slot : SETTINGS_ENVELOPE_SLOT);
    }
    for (const name of stock) {
      const slot = wowCVarSlot(name);
      if (slot !== undefined) slots.add(slot);
    }
    return slots;
  }

  /** Records new settings, keeps them in this browser at once and schedules the slots they touch. */
  set(value: SettingValues): void {
    const previous = this.#value;
    this.#value = value;
    this.#mirror(value);
    const ids = new Set([...Object.keys(previous), ...Object.keys(value)].filter((id) => previous[id] !== value[id]));
    if (ids.size === 0 || !this.#world) return;
    if (!this.#applied) {
      for (const id of ids) this.#early.add(id);
      return;
    }
    for (const slot of this.#slotsOf(ids, new Set())) this.#schedule(slot);
  }

  // ---- StockCVarSlots: the FrameXML VM's side.

  rows(): readonly (readonly [string, string])[] {
    return this.#stockRows;
  }

  note(name: string, value: string): boolean {
    const registration = wowCVar(name);
    const slot = wowCVarSlot(name);
    if (!registration || slot === undefined || this.#isSettingCVar(registration.name.toLowerCase())) return false;
    if (!this.#world) return true;
    const key = registration.name.toLowerCase();
    if (!this.#applied) {
      this.#stock.set(key, value);
      this.#earlyStock.add(key);
      return true;
    }
    if (this.#stock.get(key) === value) return true;
    this.#stock.set(key, value);
    this.#schedule(slot);
    return true;
  }

  subscribe(listener: (rows: readonly (readonly [string, string])[]) => void): () => void {
    this.#stockListeners.add(listener);
    return () => { this.#stockListeners.delete(listener); };
  }

  /** Sends pending writes now. Called when a world is left, so nothing is lost with it. */
  flush(): void {
    for (const slot of [...this.#timers.keys()]) {
      this.#cancel(slot);
      this.#write(slot);
    }
  }

  #schedule(slot: StoreSlot): void {
    if (!this.#world || !this.#applied) return;
    if (slot === SETTINGS_ENVELOPE_SLOT && this.#foreign6) return;
    this.#cancel(slot);
    this.#timers.set(slot, window.setTimeout(() => {
      this.#timers.delete(slot);
      this.#write(slot);
    }, SAVE_DELAY_MS));
  }

  #cancel(slot: StoreSlot): void {
    const timer = this.#timers.get(slot);
    if (timer !== undefined) window.clearTimeout(timer);
    this.#timers.delete(slot);
  }

  #cancelAll(): void {
    for (const slot of [...this.#timers.keys()]) this.#cancel(slot);
  }

  #write(slot: StoreSlot): void {
    const world = this.#world;
    if (!world || !this.#applied) return;
    let text: string;
    if (slot === SETTINGS_ENVELOPE_SLOT) {
      // Built on the slot's latest text: the layout store writes the same slot (its windows are kept).
      const current = this.#text(slot);
      if (!slot6IsOurs(current)) return;
      text = slot6WithSettings(current, ownSettings(this.#value, this.#cvarSettings));
      if (text === current) return;
    } else {
      // The old JSON stays until slot 6 is known to hold what it carried.
      if (slot === CHARACTER_CONFIG_SLOT && this.#legacy && (this.#foreign6 || !this.#ownOnServer)) return;
      const base = this.#legacy && slot === CHARACTER_CONFIG_SLOT ? [] : parseCVarCacheText(this.#confirmed.get(slot) ?? "");
      const stock = new Map([...this.#stock].filter(([name]) => wowCVarSlot(name) === slot));
      text = slotText(base, this.#rows.filter((row) => row.slot === slot), this.#value, stock);
      if (text === (this.#sent.get(slot) ?? this.#confirmed.get(slot))) return;
    }
    if (utf8Length(text) > ACCOUNT_DATA_WRITE_LIMIT) {
      this.#options.onRefused?.(slot);
      return;
    }
    this.#sent.set(slot, text);
    void world.saveAccountData(slot, text).catch(() => {
      // A refused save costs the round trip: what the server holds is unchanged, and the next change sends again.
    });
  }
}

/** The settings slot 6 keeps: this client's serialised blob (values off their default) less the CVar rows. */
export function ownSettings(values: SettingValues, cvarSettings: ReadonlySet<string>): Record<string, unknown> {
  const blob = JSON.parse(serialiseSettings(values)) as Record<string, unknown>;
  for (const id of cvarSettings) delete blob[id];
  return blob;
}

/**
 * A config slot's text: the slot's lines with each setting row and each stock CVar brought to its value — a
 * line that already means that value stays as written; a value equal to Wow.exe's registered default has no line
 * (0x00767030 writes none, and a missing line reads as the default); any other value is `SET name "value"`.
 */
export function slotText(
  lines: readonly CVarCacheLine[], rows: readonly MappedRow[], values: SettingValues,
  stock: ReadonlyMap<string, string> = new Map(),
): string {
  const changes = new Map<string, string | undefined>();
  for (const row of rows) {
    const ours = cvarTextOfSettings(row.binding, values);
    const oursValue = settingValueOfCVarText(row.binding, ours);
    const line = cvarLineValue(lines, row.cvar);
    if (line !== undefined && settingValueOfCVarText(row.binding, line) === oursValue) continue;
    if (settingValueOfCVarText(row.binding, row.wowDefault) === oursValue) {
      if (line !== undefined) changes.set(row.cvar, undefined);
      continue;
    }
    changes.set(row.cvar, ours);
  }
  for (const [key, value] of stock) {
    const registration = wowCVar(key);
    if (!registration) continue;
    const line = cvarLineValue(lines, registration.name);
    if (line !== undefined && line === value) continue;
    if (registration.defaultValue !== undefined && sameText(value, registration.defaultValue)) {
      if (line !== undefined) changes.set(registration.name, undefined);
      continue;
    }
    changes.set(registration.name, value);
  }
  return renderCVarCacheText(changes.size === 0 ? lines : withCVarValues(lines, changes));
}

/** The rows of a slot table that have a setting here. */
export function mappedSettingsCVarRows(rows: readonly SettingsCVarSlot[] = SETTINGS_CVAR_SLOTS): readonly MappedRow[] {
  return rows.flatMap((row) => {
    const binding = frameXmlSettingsCVarRow(row.cvar);
    return binding ? [{ ...row, binding }] : [];
  });
}
