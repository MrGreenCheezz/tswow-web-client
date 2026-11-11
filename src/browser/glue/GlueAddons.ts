import { GlueLuaRaise, type GlueLuaVm } from "./GlueLua.js";
import { GlueAddonStateList, type GlueAddonFiles } from "./GlueAddonStates.js";
import { compareFrameXmlAddonTitles, frameXmlAddonMetadata } from "../framexml/FrameXmlAddonMetadata.js";
import {
  FRAMEXML_CURRENT_INTERFACE, frameXmlAddonDependencies, frameXmlAddonInterface,
} from "../framexml/FrameXmlAddonStates.js";
import type { FrameXmlInstalledClientAddon } from "../framexml/FrameXmlClientAddons.js";

/**
 * «Модификации» on the character-select screen (10.09; 3.46, 11.11): the stock `AddonList.lua` over the add-ons the
 * gateway lists (`/client/addons`' `installed`, the client's Interface/AddOns), with the glue C API as Wow.exe 3.3.5a
 * 12340 answers it (read-only Ghidra, .runtime/re-2026-11-11/glue; the glue table at 0x00ac3f60):
 *
 * - `GetNumAddOns()` (0x511200) and `GetAddOnInfo(index)` (0x4dc560; "Usage: GetAddOnInfo(index)", an index out of
 *   range "AddOn index must be in the range of 1 to %d") → name, title, notes, url, loadable (1 or nil), reason,
 *   security, newVersion (1 or nil). The list is ordered by title (0x5f79a0), the title and notes are the TOC's (FrameXmlAddonMetadata.ts).
 *   `loadable`/`reason` are 0x5f7e90 with load-on-demand not allowed and no character: MISSING, DISABLED (off for
 *   every character), INCOMPATIBLE (`## Interface` below 20000), INTERFACE_VERSION (not 30300 while
 *   `checkAddonVersion` is on), a dependency's reason as DEP_…, and last DEMAND_LOADED for a load-on-demand add-on.
 *   Security is INSECURE for an add-on of the AddOns folder; `url` and `newVersion` nil (nothing here has them).
 * - `GetAddOnEnableState(character, index)` (0x4dc7c0), `EnableAddOn`/`DisableAddOn(character, index)` (0x4dc8a0,
 *   0x4dc9b0): the first argument a string or nil (nil — every character), the second an index; otherwise
 *   "Usage: …(\"character\", index)". `EnableAllAddOns`/`DisableAllAddOns(character)` (0x4dc960, 0x4dca70),
 *   `SaveAddOns()` (0x5f76a0), `ResetAddOns()` (0x5f91e0(0)) — the per-character states of GlueAddonStates.ts.
 * - `IsAddonVersionCheckEnabled()` (0x4dcae0 → 0x5f4ca0) is the `checkAddonVersion` CVar; `SetAddonVersionCheck(v)`
 *   (0x4dcb20 → 0x5f4cb0) sets it "1" or "0" from v read as a flag (0x815500: nil false, a number non-zero).
 *
 * As the character enters the world the states for it and the switch are handed to the world's add-on loader
 * (`glueWorldAddonStates`), as Wow.exe's world reads the same tables (0x5f7d70 for the current character).
 */

export const GLUE_ADDONS_STORAGE_PREFIX = "webclient-addons-v1";

/** The list as the gateway gives it (FrameXmlClientAddons.ts). */
export interface GlueAddonListing {
  readonly installed: readonly FrameXmlInstalledClientAddon[];
  /** Config.wtf's `checkAddonVersion` (Wow.exe default on). */
  readonly checkAddonVersion: boolean;
}

/** Who the states belong to: `WTF/Account/<account>/<realm>/<character>`. */
export interface GlueAddonIdentity {
  readonly account: string;
  readonly realm: string;
  /** The realm's characters, in list order. */
  readonly characters: readonly string[];
}

export interface GlueAddonListOptions {
  /** The gateway's add-on list; a failure is an empty list, as a gateway without add-ons is. */
  readonly load: () => Promise<GlueAddonListing>;
  /** An add-on's TOC text (Interface/AddOns/<name>/<name>.toc); undefined — not read. */
  readonly readToc?: (name: string) => Promise<string | undefined>;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** The logged-in account, the chosen realm and its characters; undefined before the character list. */
  readonly identity?: () => GlueAddonIdentity | undefined;
  /** `GetLocale()`: which `## Title-xxXX` is the client's. */
  readonly locale?: string;
}

/** The glue CVar table, for `checkAddonVersion` (GlueApi's `#cvars`, kept by GlueCVarStore). */
export interface GlueAddonCVars {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

interface GlueAddonEntry {
  readonly name: string;
  readonly title: string;
  readonly notes: string | undefined;
  readonly loadOnDemand: boolean;
  readonly toc: string | undefined;
}

/**
 * What the world reads of the glue's states for the character entering it. 3.46 (11.11): the same tables, not a copy, as
 * Wow.exe's world shares ADDONSTATELIST with the glue: the world's EnableAddOn/DisableAddOn and the `All` pair set the
 * character's table (0x00511840, 0x00511940, 0x00511900, 0x00511a00 → 0x5f90b0 with the character's name, 0x006b1060),
 * ResetDisabledAddOns reads it again from its file (0x00511a40 → 0x5f91e0(name)), and the world interface's unload saves
 * every changed table (0x00528f00 → 0x5f76a0) — FrameXmlWorldAddonApi.ts.
 */
export interface GlueWorldAddonStates {
  readonly character: string;
  /** Lower-case names of the installed add-ons and whether they are on for the character; kept current by `set`/`reset`. */
  readonly enabled: ReadonlyMap<string, boolean>;
  readonly checkAddonVersion: boolean;
  /** 0x5f90b0(addon, character, on): the add-on on or off in the character's table. */
  set?(addon: string, enabled: boolean): void;
  /** 0x5f91e0(character): the character's table again from its file, unsaved changes dropped. */
  reset?(): void;
  /** 0x5f76a0: every changed table to its file. */
  save?(): void;
}

let worldAddonStates: GlueWorldAddonStates | undefined;

/** The states the glue handed over with the character now in the world; undefined — none (another route in). */
export function glueWorldAddonStates(): GlueWorldAddonStates | undefined {
  return worldAddonStates;
}

export function setGlueWorldAddonStates(states: GlueWorldAddonStates | undefined): void {
  worldAddonStates = states;
}

const VERSION_CHECK_CVAR = "checkAddonVersion";
const OLDEST_INTERFACE = 20000;

function upperAscii(text: string): string {
  return text.replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

/** Lua 5.1's lua_isnumber + tonumber: a number, or a string that reads as one. */
function luaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return undefined;
  return Number(text);
}

/** The x87 store the client rounds an index with: to nearest, ties to even. */
function roundEven(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference < 0.5) return floor;
  if (difference > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * 0x815500: a Lua value as a flag — nil false, a boolean itself, a number non-zero; a string by 0x815400: first
 * character 0/F/N/f/n off, 1–9/T/Y/t/y on, else "off" and "disabled" off, "on" and "enabled" on (any case, 0xa09e84,
 * 0xa09e88); anything else the fallback.
 */
function luaFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const first = value[0] ?? "";
    if ("0FNfn".includes(first) && first !== "") return false;
    if ("123456789TYty".includes(first) && first !== "") return true;
    const word = value.toLowerCase();
    if (word === "off" || word === "disabled") return false;
    if (word === "on" || word === "enabled") return true;
  }
  return fallback;
}

export class GlueAddonList {
  readonly #options: GlueAddonListOptions;
  #addons: readonly GlueAddonEntry[] = [];
  #listing: GlueAddonListing = { installed: [], checkAddonVersion: true };
  #states: GlueAddonStateList;
  #identity: string | undefined;
  #cvars: GlueAddonCVars | undefined;
  #ready: Promise<void> | undefined;

  constructor(options: GlueAddonListOptions) {
    this.#options = options;
    this.#states = this.#newStates(undefined);
  }

  /** Starts the one request (and the TOC reads); safe to call again. */
  load(): Promise<void> {
    this.#ready ??= this.#load();
    return this.#ready;
  }

  async #load(): Promise<void> {
    let listing: GlueAddonListing;
    try {
      listing = await this.#options.load();
    } catch {
      listing = { installed: [], checkAddonVersion: true };
    }
    const locale = this.#options.locale ?? "ruRU";
    const addons = await Promise.all(listing.installed.map(async (addon): Promise<GlueAddonEntry> => {
      let toc: string | undefined;
      try { toc = await this.#options.readToc?.(addon.name); } catch { toc = undefined; }
      const metadata = toc === undefined ? undefined : frameXmlAddonMetadata(toc, addon.name, locale);
      return {
        name: addon.name, title: metadata?.get("title") ?? addon.name, notes: metadata?.get("notes"),
        loadOnDemand: addon.loadOnDemand, toc,
      };
    }));
    this.#listing = listing;
    // 0x5f79a0: the list in title order (0x5f7910 compares the titles).
    this.#addons = addons.sort((left, right) => compareFrameXmlAddonTitles(left.title, right.title));
    this.#sync(true);
  }

  get addons(): readonly { readonly name: string; readonly loadOnDemand: boolean }[] {
    return this.#addons;
  }

  #fileKey(identity: GlueAddonIdentity, character: string): string {
    return JSON.stringify([GLUE_ADDONS_STORAGE_PREFIX, upperAscii(identity.account), identity.realm, character]);
  }

  #newStates(identity: GlueAddonIdentity | undefined): GlueAddonStateList {
    const storage = this.#options.storage;
    const files: GlueAddonFiles = {
      read: (character) => {
        if (!identity) return undefined;
        try { return storage?.getItem(this.#fileKey(identity, character)) ?? undefined; } catch { return undefined; }
      },
      write: (character, text) => {
        if (!identity) return;
        try {
          storage?.setItem(this.#fileKey(identity, character), text);
        } catch {
          // Site data blocked: the choice lasts for this page, which is all a locked browser allows.
        }
      },
    };
    // The account's AddOns.txt is the gateway's profile: its explicit lines (an older gateway: its off ones).
    const account = (): ReadonlyMap<string, boolean> | undefined => {
      const lines = new Map<string, boolean>();
      for (const addon of this.#listing.installed) {
        const state = addon.profileState ?? (addon.enabled ? undefined : false);
        if (state !== undefined) lines.set(addon.name.toLowerCase(), state);
      }
      return lines.size > 0 ? lines : undefined;
    };
    const states = new GlueAddonStateList(files, account);
    states.setAddons(this.#listing.installed.map((addon) => ({ name: addon.name, defaultState: addon.defaultState ?? true })));
    return states;
  }

  /** The account and realm decide the files; the realm's characters decide the tables (0x4e3ca0). */
  #sync(rebuild = false): void {
    const identity = this.#options.identity?.();
    const key = identity ? JSON.stringify([upperAscii(identity.account), identity.realm]) : undefined;
    if (rebuild || key !== this.#identity) {
      this.#identity = key;
      this.#states = this.#newStates(identity);
    }
    this.#states.setCharacters(identity?.characters ?? []);
  }

  #versionCheck(): boolean {
    const value = this.#cvars?.get(VERSION_CHECK_CVAR);
    if (value === undefined) return this.#listing.checkAddonVersion;
    const number = Number.parseInt(value.trim(), 10);
    return Number.isFinite(number) && number !== 0;
  }

  /** 0x5f7e90(addon, allowLoD, …, no character): the reason it cannot load, or undefined when it can. */
  #reason(lower: string, allowLoD: boolean, checking: Set<string>): string | undefined {
    const addon = this.#addons.find((entry) => entry.name.toLowerCase() === lower);
    if (!addon) return "MISSING";
    if (checking.has(lower)) return undefined;
    if (this.#states.state(lower) === 0) return "DISABLED";
    if (addon.toc !== undefined) {
      const version = frameXmlAddonInterface(addon.toc);
      if (version < OLDEST_INTERFACE) return "INCOMPATIBLE";
      if (version !== FRAMEXML_CURRENT_INTERFACE && this.#versionCheck()) return "INTERFACE_VERSION";
      checking.add(lower);
      try {
        // Nothing is loaded on the glue screens (0x5f7630), so every dependency is judged, load-on-demand allowed.
        for (const dependency of frameXmlAddonDependencies(addon.toc)) {
          const reason = this.#reason(dependency.toLowerCase(), true, checking);
          if (reason !== undefined) return reason.startsWith("DEP_") ? reason : `DEP_${reason}`;
        }
      } finally {
        checking.delete(lower);
      }
    }
    return !allowLoD && addon.loadOnDemand ? "DEMAND_LOADED" : undefined;
  }

  /** The index argument at `at`, or the usage error; then the range check. */
  #indexed(args: readonly unknown[], at: number, usage: string): GlueAddonEntry {
    const number = luaNumber(args[at]);
    if (number === undefined) throw new GlueLuaRaise(usage);
    const addon = this.#addons[roundEven(number) - 1];
    if (!addon) throw new GlueLuaRaise(`AddOn index must be in the range of 1 to ${this.#addons.length}`);
    return addon;
  }

  /** `(character, index)`: a string, number or nil first — anything else, or no argument, is the usage error. */
  #characterIndexed(args: readonly unknown[], usage: string): { character: string | undefined; addon: GlueAddonEntry } {
    const first = args[0];
    const string = typeof first === "string" || typeof first === "number";
    if (!string && (args.length === 0 || first !== undefined)) throw new GlueLuaRaise(usage);
    const addon = this.#indexed(args, 1, usage);
    return { character: string ? String(first) : undefined, addon };
  }

  /** The states and the switch for the character entering the world (0x5f7d70(addon, character, 1)). */
  handOver(character: string): void {
    this.#sync();
    const states = this.#states;
    const enabled = new Map<string, boolean>();
    const refresh = (): void => {
      for (const addon of this.#addons) enabled.set(addon.name.toLowerCase(), states.state(addon.name, character) !== 0);
    };
    refresh();
    // 3.46 (11.11): the live table for the world's calls (GlueWorldAddonStates).
    setGlueWorldAddonStates(Object.freeze({
      character, enabled, checkAddonVersion: this.#versionCheck(),
      set: (addon: string, on: boolean) => { states.set(addon, character, on); refresh(); },
      reset: () => { states.resetCharacter(character); refresh(); },
      save: () => { states.save(); },
    }));
  }

  install(vm: GlueLuaVm, cvars?: GlueAddonCVars): void {
    this.#cvars = cvars;
    vm.registerGlobal("GetNumAddOns", () => [this.#addons.length]);
    vm.registerGlobal("GetAddOnInfo", (args) => {
      this.#sync();
      const addon = this.#indexed(args, 0, "Usage: GetAddOnInfo(index)");
      const reason = this.#reason(addon.name.toLowerCase(), false, new Set());
      // `loadable` and `newVersion` are pushed as 1 or nil (0x84e2a0(1.0) / 0x84e280).
      return [addon.name, addon.title, addon.notes, undefined, reason === undefined ? 1 : undefined, reason, "INSECURE", undefined];
    });
    vm.registerGlobal("GetAddOnEnableState", (args) => {
      this.#sync();
      const { character, addon } = this.#characterIndexed(args, 'Usage: GetAddOnEnableState("character", index)');
      return [this.#states.state(addon.name, character)];
    });
    // 0x4ddac0: the TOC's dependency names, by index only ("Usage: GetAddOnDependencies(index)").
    vm.registerGlobal("GetAddOnDependencies", (args) => {
      const addon = this.#indexed(args, 0, "Usage: GetAddOnDependencies(index)");
      return addon.toc === undefined ? [] : frameXmlAddonDependencies(addon.toc);
    });
    vm.registerGlobal("EnableAddOn", (args) => {
      this.#sync();
      const { character, addon } = this.#characterIndexed(args, 'Usage: EnableAddOn("character", index)');
      this.#states.set(addon.name, character, true);
      return [];
    });
    vm.registerGlobal("DisableAddOn", (args) => {
      this.#sync();
      const { character, addon } = this.#characterIndexed(args, 'Usage: DisableAddOn("character", index)');
      this.#states.set(addon.name, character, false);
      return [];
    });
    const all = (args: readonly unknown[], enabled: boolean): [] => {
      this.#sync();
      const first = args[0];
      const character = typeof first === "string" || typeof first === "number" ? String(first) : undefined;
      for (const addon of this.#addons) this.#states.set(addon.name, character, enabled);
      return [];
    };
    vm.registerGlobal("EnableAllAddOns", (args) => all(args, true));
    vm.registerGlobal("DisableAllAddOns", (args) => all(args, false));
    vm.registerGlobal("SaveAddOns", () => {
      this.#sync();
      this.#states.save();
      return [];
    });
    vm.registerGlobal("ResetAddOns", () => {
      this.#sync();
      this.#states.reset();
      return [];
    });
    vm.registerGlobal("IsAddonVersionCheckEnabled", () => [this.#versionCheck() ? 1 : undefined]);
    vm.registerGlobal("SetAddonVersionCheck", (args) => {
      this.#cvars?.set(VERSION_CHECK_CVAR, luaFlag(args[0], true) ? "1" : "0");
      return [];
    });
  }
}

/** The C-API names `GlueAddonList.install` answers; `GlueApi` stops stubbing them. */
export const GLUE_ADDON_GLOBALS: ReadonlySet<string> = new Set([
  "GetNumAddOns", "GetAddOnInfo", "GetAddOnEnableState", "GetAddOnDependencies", "EnableAddOn",
  "DisableAddOn", "EnableAllAddOns", "DisableAllAddOns", "SaveAddOns", "ResetAddOns",
  "IsAddonVersionCheckEnabled", "SetAddonVersionCheck",
]);
