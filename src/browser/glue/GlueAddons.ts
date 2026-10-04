import type { GlueLuaVm } from "./GlueLua.js";

/**
 * «Модификации» on the character-select screen (10.09): the stock `AddonList.lua` over the add-ons
 * this gateway serves (`/client/addons`, the same list the in-world interface loads).
 *
 * The glue C API as `AddonList.lua` reads it: `GetNumAddOns()`, `GetAddOnInfo(i)` →
 * `name, title, notes, url, loadable, reason, security, newVersion`, `GetAddOnEnableState(character,
 * i)` → 0/1/2, `EnableAddOn/DisableAddOn([character,] i | name)`, `Enable/DisableAllAddOns`,
 * `SaveAddOns()` (OK) and `ResetAddOns()` (Cancel). One state for all characters: a per-character
 * choice is accepted and applied to all of them.
 *
 * What is saved is the list of switched-off names, per gateway origin, in this browser. Whether
 * the world then skips them is the in-world mount's business (another lane); until it reads this
 * list the switch is remembered but changes nothing in the world.
 */

export interface GlueAddonEntry {
  readonly name: string;
  readonly loadOnDemand: boolean;
}

export const GLUE_ADDONS_STORAGE_PREFIX = "webclient.glue.addons:";

export interface GlueAddonListOptions {
  /** The gateway's add-on list; a failure is an empty list, as a gateway without add-ons is. */
  readonly load: () => Promise<readonly GlueAddonEntry[]>;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Gateway origin: the saved choice belongs to one server's add-ons. */
  readonly origin: string;
}

export class GlueAddonList {
  readonly #options: GlueAddonListOptions;
  #addons: readonly GlueAddonEntry[] = [];
  /** Lower-cased names switched off, as saved. */
  #saved = new Set<string>();
  /** The same, with the dialog's unsaved clicks. */
  #pending = new Set<string>();
  #ready: Promise<void> | undefined;

  constructor(options: GlueAddonListOptions) {
    this.#options = options;
    this.#saved = this.#read();
    this.#pending = new Set(this.#saved);
  }

  /** Starts the one request; safe to call again. */
  load(): Promise<void> {
    this.#ready ??= this.#options.load()
      .then((addons) => { this.#addons = addons; })
      .catch(() => { this.#addons = []; });
    return this.#ready;
  }

  get addons(): readonly GlueAddonEntry[] {
    return this.#addons;
  }

  /** Names switched off as saved — what a world mount would skip. */
  disabledNames(): readonly string[] {
    return this.#addons.filter((addon) => this.#saved.has(addon.name.toLowerCase())).map((addon) => addon.name);
  }

  #key(): string {
    return `${GLUE_ADDONS_STORAGE_PREFIX}${this.#options.origin}`;
  }

  #read(): Set<string> {
    try {
      const parsed: unknown = JSON.parse(this.#options.storage?.getItem(this.#key()) ?? "[]");
      return new Set(Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase())
        : []);
    } catch {
      return new Set();
    }
  }

  /** 1-based index or a name, as the client takes either. */
  #find(value: unknown): GlueAddonEntry | undefined {
    if (typeof value === "string" && !/^\d+$/.test(value)) {
      const wanted = value.toLowerCase();
      return this.#addons.find((addon) => addon.name.toLowerCase() === wanted);
    }
    const index = Math.trunc(Number(value));
    return Number.isFinite(index) ? this.#addons[index - 1] : undefined;
  }

  /** `EnableAddOn(character, i)` and `EnableAddOn(i)` both exist; the index is the last argument. */
  #target(args: readonly unknown[]): GlueAddonEntry | undefined {
    return this.#find(args.length >= 2 ? args[1] : args[0]);
  }

  install(vm: GlueLuaVm): void {
    vm.registerGlobal("GetNumAddOns", () => [this.#addons.length]);
    vm.registerGlobal("GetAddOnInfo", (args) => {
      const addon = this.#find(args[0]);
      if (!addon) return [];
      // name, title, notes, url, loadable, reason, security, newVersion. The route names the folder
      // only, so the title is the name; a load-on-demand add-on is not loaded at start-up.
      return [
        addon.name, addon.name, undefined, undefined,
        !addon.loadOnDemand, addon.loadOnDemand ? "DEMAND_LOADED" : undefined, "INSECURE", false,
      ];
    });
    vm.registerGlobal("GetAddOnEnableState", (args) => {
      const addon = this.#find(args.length >= 2 ? args[1] : args[0]);
      if (!addon) return [0];
      return [this.#pending.has(addon.name.toLowerCase()) ? 0 : 2];
    });
    vm.registerGlobal("GetAddOnDependencies", () => []);
    vm.registerGlobal("EnableAddOn", (args) => {
      const addon = this.#target(args);
      if (addon) this.#pending.delete(addon.name.toLowerCase());
      return [];
    });
    vm.registerGlobal("DisableAddOn", (args) => {
      const addon = this.#target(args);
      if (addon) this.#pending.add(addon.name.toLowerCase());
      return [];
    });
    vm.registerGlobal("EnableAllAddOns", () => {
      this.#pending.clear();
      return [];
    });
    vm.registerGlobal("DisableAllAddOns", () => {
      for (const addon of this.#addons) this.#pending.add(addon.name.toLowerCase());
      return [];
    });
    vm.registerGlobal("SaveAddOns", () => {
      this.#saved = new Set(this.#pending);
      try {
        this.#options.storage?.setItem(this.#key(), JSON.stringify([...this.#saved].sort()));
      } catch {
        // Site data blocked: the choice lasts for this page, which is all a locked browser allows.
      }
      return [];
    });
    vm.registerGlobal("ResetAddOns", () => {
      this.#pending = new Set(this.#saved);
      return [];
    });
  }
}

/** The C-API names `GlueAddonList.install` answers; `GlueApi` stops stubbing them. */
export const GLUE_ADDON_GLOBALS: ReadonlySet<string> = new Set([
  "GetNumAddOns", "GetAddOnInfo", "GetAddOnEnableState", "GetAddOnDependencies", "EnableAddOn",
  "DisableAddOn", "EnableAllAddOns", "DisableAllAddOns", "SaveAddOns", "ResetAddOns",
]);
