/**
 * Plan item 3.19: the CVars the stock UI writes survive the session, `SetCVar`'s third argument
 * raises `CVAR_UPDATE`, and the modified clicks survive too.
 *
 * - **CVAR_UPDATE.** Wow.exe's FrameXML `SetCVar` (0x514c10) sets the value and, when a third
 *   argument is present, signals event 0x12a `CVAR_UPDATE` with two strings: that argument (the
 *   panel's event name, e.g. `STATUS_TEXT_DISPLAY`) and the value it just wrote (`""` for nil).
 *   A read-only or unknown CVar raises an error before the write and signals nothing. Stock
 *   listeners: TextStatusBar.lua:13-27 (status text on the bars), TargetFrame.lua:222/861 (target
 *   debuffs, target cast bar), Blizzard_ArenaUI.lua:27, UnitFrame.lua, FloatingChatFrame.lua.
 * - **Persistence.** The client keeps its CVars in Config.wtf. Here a CVar the stock UI wrote into
 *   the neutral map (FrameXmlNeutralApi.ts) is kept in browser storage and seeded back before the
 *   corpus runs, so VARIABLES_LOADED reads it. Names a browser setting carries
 *   (FrameXmlSettingsCVar.ts) persist with that setting and are skipped; read-only names never
 *   reach the map. Only written names are kept, not every registered default.
 * - **Modified clicks.** `SetModifiedClick` (Wow.exe 0x55fb90) rebinds an action; the client saves
 *   those with its key bindings. Here they go to the same record.
 */

import type { GlueLuaVm } from "../glue/GlueLua.js";
import { FRAME_XML_SETTINGS_CVARS, FRAME_XML_WEBCLIENT_CVARS } from "./FrameXmlSettingsCVar.js";

/** Where the record lives: `localStorage`, or a test's map. */
export interface FrameXmlCVarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FrameXmlCVarRecord {
  readonly cvars: Readonly<Record<string, string>>;
  readonly modifiedClicks: Readonly<Record<string, string>>;
}

/**
 * The storage key; one record per account, as Config.wtf is one file per installation. Only Latin
 * letters are folded, as the core folds account names (Utf8ToUpperOnlyLatin) and the saved-variable
 * key does (FrameXmlSavedVariables.ts): names differing in Cyrillic case are different accounts.
 */
export function frameXmlCVarStorageKey(account: string): string {
  return `webclient.framexml.cvars.v1:${account.replace(/[A-Z]/g, (letter) => letter.toLowerCase())}`;
}

/** A value longer than this is not kept (the stock UI writes short strings). */
export const FRAMEXML_CVAR_MAX_VALUE = 256;
/** At most this many CVar names and this many modified clicks are kept. */
export const FRAMEXML_CVAR_MAX_NAMES = 512;
/** Writes are gathered this long before the record is stored. */
export const FRAMEXML_CVAR_PERSIST_DELAY_MS = 500;

const NAME = /^[A-Za-z0-9_]{1,64}$/;

function readRecord(text: string | null | undefined): { cvars: Map<string, string>; clicks: Map<string, string> } {
  const cvars = new Map<string, string>();
  const clicks = new Map<string, string>();
  if (!text) return { cvars, clicks };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { cvars, clicks }; }
  const copy = (from: unknown, into: Map<string, string>, lower: boolean): void => {
    if (!from || typeof from !== "object" || Array.isArray(from)) return;
    for (const [name, value] of Object.entries(from as Record<string, unknown>)) {
      if (into.size >= FRAMEXML_CVAR_MAX_NAMES) break;
      if (!NAME.test(name) || typeof value !== "string" || value.length > FRAMEXML_CVAR_MAX_VALUE) continue;
      into.set(lower ? name.toLowerCase() : name, value);
    }
  };
  const record = parsed as { cvars?: unknown; modifiedClicks?: unknown };
  copy(record?.cvars, cvars, true);
  copy(record?.modifiedClicks, clicks, false);
  return { cvars, clicks };
}

/**
 * The persisted record: read once at boot, written back a moment after the last change and at
 * close. A storage that throws (private window, quota) leaves the session's values in place.
 */
export class FrameXmlCVarStore {
  readonly #storage: FrameXmlCVarStorage;
  readonly #key: string;
  readonly #cvars: Map<string, string>;
  readonly #clicks: Map<string, string>;
  readonly #schedule: (run: () => void, ms: number) => () => void;
  #cancel: (() => void) | undefined;
  #pending = false;

  constructor(storage: FrameXmlCVarStorage, key: string, schedule?: (run: () => void, ms: number) => () => void) {
    this.#storage = storage;
    this.#key = key;
    let text: string | null = null;
    try { text = storage.getItem(key); } catch { text = null; }
    const { cvars, clicks } = readRecord(text);
    this.#cvars = cvars;
    this.#clicks = clicks;
    this.#schedule = schedule ?? ((run, ms) => {
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    });
  }

  record(): FrameXmlCVarRecord {
    return { cvars: Object.fromEntries(this.#cvars), modifiedClicks: Object.fromEntries(this.#clicks) };
  }

  /** A CVar the stock UI wrote (lower-cased name). Returns whether it is kept. */
  noteCVar(name: string, value: string): boolean {
    return this.#note(this.#cvars, name.toLowerCase(), value);
  }

  /** A modified click the stock UI rebound. Returns whether it is kept. */
  noteClick(action: string, binding: string): boolean {
    return this.#note(this.#clicks, action, binding);
  }

  #note(into: Map<string, string>, name: string, value: string): boolean {
    if (!NAME.test(name) || value.length > FRAMEXML_CVAR_MAX_VALUE) return false;
    if (!into.has(name) && into.size >= FRAMEXML_CVAR_MAX_NAMES) return false;
    if (into.get(name) === value) return true;
    into.set(name, value);
    this.#pending = true;
    this.#cancel?.();
    this.#cancel = this.#schedule(() => { this.#cancel = undefined; this.#write(); }, FRAMEXML_CVAR_PERSIST_DELAY_MS);
    return true;
  }

  /** Store now if anything is pending (the boot's close). */
  flush(): void {
    if (!this.#pending) return;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#write();
  }

  #write(): void {
    if (!this.#pending) return;
    this.#pending = false;
    try { this.#storage.setItem(this.#key, JSON.stringify(this.record())); } catch { /* the session keeps its values */ }
  }
}

/** Lower-cased names a browser setting carries: they persist with the setting, not here. */
export const FRAMEXML_CVAR_SETTINGS_NAMES: readonly string[] = Object.freeze([
  ...FRAME_XML_SETTINGS_CVARS, ...FRAME_XML_WEBCLIENT_CVARS,
].map((row) => row.cvar.toLowerCase()));

/**
 * Wraps the finished `SetCVar` (the neutral map composed with the seam's settings) and the neutral
 * `SetModifiedClick`, and seeds the saved values into the neutral map. Runs after the neutral and
 * seam preludes and before the corpus first touches either name.
 */
export const FRAMEXML_CVAR_PERSISTENCE_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local values, readOnly = __fxCVarValues, __fxCVarReadOnly or {}
  local skip = {}
  for _, name in ipairs(__fxCVarSettingsNames or {}) do skip[name] = true end
  local raise, noteCVar, noteClick = __fxRaiseEvent, __fxNoteCVar, __fxNoteClick
  local type, tostring, lower, select = type, tostring, string.lower, select

  if type(values) == "table" then
    for _, row in ipairs(__fxCVarSavedValues or {}) do
      local key, value = row[1], row[2]
      if type(key) == "string" and type(value) == "string" and not readOnly[key] and not skip[key] then
        values[key] = value
      end
    end
  end

  local setCVar = impl.SetCVar
  if setCVar ~= nil then
    impl.SetCVar = function(...)
      local name, value = ...
      local key = type(name) == "string" and name ~= "" and lower(name) or nil
      local result = setCVar(...)
      if key == nil or readOnly[key] then return result end
      local text = value == nil and "" or tostring(value)
      if type(values) == "table" and not skip[key] and values[key] == text and noteCVar then
        noteCVar(key, text)
      end
      if select("#", ...) >= 3 then
        local eventName = select(3, ...)
        -- lua_isstring, as 0x514c10 tests it: a string or a number, not a boolean or a table.
        local kind = type(eventName)
        if (kind == "string" or kind == "number") and raise then raise("CVAR_UPDATE", tostring(eventName), text) end
      end
      return result
    end
  end

  local setClick, getClick = impl.SetModifiedClick, impl.GetModifiedClick
  if setClick ~= nil then
    for _, row in ipairs(__fxModifiedClicksSaved or {}) do
      if type(row[1]) == "string" and type(row[2]) == "string" then setClick(row[1], row[2]) end
    end
    impl.SetModifiedClick = function(action, binding, ...)
      local result = setClick(action, binding, ...)
      if noteClick and type(action) == "string" and type(binding) == "string"
        and getClick ~= nil and getClick(action) == binding then
        noteClick(action, binding)
      end
      return result
    end
  end
end
`;

export interface FrameXmlCVarPersistenceHost {
  /** Signals a UI event to every registered frame (the boot's pump). */
  readonly raise: (event: string, ...args: readonly unknown[]) => unknown;
  /** The saved record; absent, nothing is seeded or kept (events are still raised). */
  readonly store?: FrameXmlCVarStore | undefined;
}

/** Installs the host functions, the saved values and the wrapper chunk into a booted neutral VM. */
export function installFrameXmlCVarPersistence(
  vm: Pick<GlueLuaVm, "setGlobal" | "registerGlobal" | "execute">, host: FrameXmlCVarPersistenceHost,
  chunk = "framexml-boot",
): void {
  const record = host.store?.record();
  vm.setGlobal("__fxCVarSettingsNames", [...FRAMEXML_CVAR_SETTINGS_NAMES]);
  vm.setGlobal("__fxCVarSavedValues", Object.entries(record?.cvars ?? {}));
  vm.setGlobal("__fxModifiedClicksSaved", Object.entries(record?.modifiedClicks ?? {}));
  vm.registerGlobal("__fxRaiseEvent", (args) => {
    if (typeof args[0] === "string") host.raise(args[0], ...args.slice(1));
    return [];
  });
  vm.registerGlobal("__fxNoteCVar", (args) => {
    if (typeof args[0] === "string" && typeof args[1] === "string") host.store?.noteCVar(args[0], args[1]);
    return [];
  });
  vm.registerGlobal("__fxNoteClick", (args) => {
    if (typeof args[0] === "string" && typeof args[1] === "string") host.store?.noteClick(args[0], args[1]);
    return [];
  });
  const loaded = vm.execute(FRAMEXML_CVAR_PERSISTENCE_PRELUDE, `@${chunk}:cvars`);
  if (!loaded.ok) throw new Error(`framexml cvar persistence failed: ${loaded.error}`);
}
