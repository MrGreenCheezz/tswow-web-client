import type { GlueLoadCheckpoint } from "../glue/GlueLoadScheduler.js";
import {
  GlueLoader,
  type GlueFileProvider,
  parseGlueToc,
  resolveGluePath,
  normalizeGluePath,
} from "../glue/GlueLoader.js";
import { GlueLuaVm } from "../glue/GlueLua.js";
import type { FrameXmlSavedVariables } from "./FrameXmlSavedVariables.js";
import { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import { parseFrameXml } from "../ui/framexml_compat/FrameXmlParser.js";
import {
  FRAME_XML_WIDGET_TYPES,
  type FrameXmlElement,
  type FrameXmlFrame,
} from "../ui/framexml_compat/FrameXmlTypes.js";
import { frameXmlHandlerScripts } from "./FrameXmlCorpus.js";
import {
  frameXmlInlineScripts,
  frameXmlStubPlanAsync,
  type FrameXmlLuaChunk,
  type FrameXmlStubPlan,
} from "./FrameXmlStubPlan.js";

/** On-demand Blizzard modules supported by the in-world FrameXML host. */
export const FRAME_XML_TALENT_ADDON = "Blizzard_TalentUI";
export const FRAME_XML_TRAINER_ADDON = "Blizzard_TrainerUI";

/**
 * What this client does with each of the 3.3.5a client's own load-on-demand add-ons (plan item 3.18).
 *
 * * `owner` — a host owner loads and gates it on its window's first use (FrameXmlWorldMount.ts and
 *   the `FrameXml*Owner.ts`/`*Lod.ts` files), after preparing the host side it needs; a stock
 *   `LoadAddOn` of it answers `nil, "NOT_READY"` and leaves the load to the owner.
 * * `disabled` — deliberately not loaded yet: `LoadAddOn` answers `nil, "DISABLED"` at once, without
 *   reading a file. Blizzard_CombatText has no floating-text renderer to drive, Blizzard_DebugTools and
 *   Blizzard_GMSurveyUI have no host side. (L17 3.14: Blizzard_BattlefieldMinimap has its owner,
 *   FrameXmlBattlefieldMinimapLod.ts; in the addonsOnly mode FrameXmlBattlefieldMinimap.ts still refuses it.)
 *
 * A name missing here and from the client's add-on list is `MISSING`, as before. The client's own
 * AddOns directory (`/client/addons`) is the list's source; Blizzard_GMChatUI and Blizzard_VehicleUI
 * are left out until their items (8.17, 11.02).
 */
export type FrameXmlLodPolicy = "owner" | "disabled";

export const FRAMEXML_LOD_POLICY: Readonly<Record<string, FrameXmlLodPolicy>> = Object.freeze({
  Blizzard_AchievementUI: "owner",
  Blizzard_ArenaUI: "owner",
  Blizzard_AuctionUI: "owner",
  Blizzard_BarbershopUI: "owner",
  Blizzard_BindingUI: "owner",
  Blizzard_Calendar: "owner",
  Blizzard_GlyphUI: "owner",
  Blizzard_GuildBankUI: "owner",
  Blizzard_InspectUI: "owner",
  Blizzard_ItemSocketingUI: "owner",
  Blizzard_MacroUI: "owner",
  Blizzard_RaidUI: "owner",
  Blizzard_TalentUI: "owner",
  Blizzard_TimeManager: "owner",
  Blizzard_TokenUI: "owner",
  Blizzard_TradeSkillUI: "owner",
  Blizzard_TrainerUI: "owner",
  // 3.01: loaded by the world mount's loading window (FrameXmlCombatLogOwner.ts).
  Blizzard_CombatLog: "owner",
  // L17 3.14: loaded by FrameXmlBattlefieldMinimapLod.ts on the stock paths' first ask.
  Blizzard_BattlefieldMinimap: "owner",
  Blizzard_CombatText: "disabled",
  Blizzard_DebugTools: "disabled",
  Blizzard_GMSurveyUI: "disabled",
});

/**
 * `ADDON_NOT_READY`: the text `UIParentLoadAddOn` formats for this client's own reason (UIParent.lua:
 * 234-243 reads `_G["ADDON_" .. reason]`). The client has no such string — its `LoadAddOn` is
 * synchronous — so without it the stock `format` received nil and raised.
 */
export function frameXmlAddonNotReadyText(locale: string | undefined): string {
  return locale === "ruRU" ? "Ещё загружается — повторите" : "Still loading — try again";
}

const LOD_POLICY_BY_LOWER: ReadonlyMap<string, FrameXmlLodPolicy> = new Map(
  Object.entries(FRAMEXML_LOD_POLICY).map(([name, policy]) => [name.toLowerCase(), policy]),
);

/** A result that keeps missing/failing modules distinguishable from successful loads. */
export interface FrameXmlAddonRuntimeResult {
  readonly ok: boolean;
  readonly addon: string;
  readonly status: "loaded" | "already-loaded" | "missing" | "failed" | "closed";
  readonly message?: string;
  readonly dependencies: readonly string[];
  readonly loaded: readonly string[];
  readonly roots: readonly FrameXmlFrame[];
}

export interface FrameXmlAddonRuntimeOptions {
  readonly checkpoint?: GlueLoadCheckpoint;
  readonly provider: GlueFileProvider;
  readonly vm: GlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
  /** Existing glued modules, which must remain loaded and visible to legacy add-on queries. */
  readonly initialModules?: readonly string[];
  /** Load-on-demand names accepted by the synchronous C API status binding. */
  readonly loadOnDemand?: readonly string[];
  readonly onRoots?: (roots: readonly FrameXmlFrame[]) => void;
  readonly savedVariables?: FrameXmlSavedVariables;
}

interface AddonToc {
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly entries: ReturnType<typeof parseGlueToc>;
  readonly dependencies: readonly string[];
}

interface AddonRecord {
  readonly name: string;
  readonly lower: string;
  state: "loading" | "loaded" | "failed";
  promise?: Promise<FrameXmlAddonRuntimeResult>;
  result?: FrameXmlAddonRuntimeResult;
  settled?: boolean;
  cancel?: () => void;
  toc?: AddonToc;
}

const DEFAULT_LOAD_ON_DEMAND = Object.freeze([FRAME_XML_TALENT_ADDON, FRAME_XML_TRAINER_ADDON]);
// Blizzard LoD folders commonly use underscores; TSWoW's generated marker names commonly use
// hyphens (`retail-talents`, `tswow-store`). Both are single safe path segments.
// `!BugGrabber`-style loader folders are a longstanding WoW convention. Keep the name to one safe
// path segment while accepting the punctuation and leading digits the native add-on loader does.
const ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]*$/;

function canonicalName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return ADDON_NAME.test(name) ? name : undefined;
}

function metadata(source: string, key: string): string | undefined {
  const wanted = key.toLowerCase();
  for (const raw of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("##") || line.startsWith("###")) continue;
    const separator = line.indexOf(":", 2);
    if (separator < 0) continue;
    if (line.slice(2, separator).trim().toLowerCase() !== wanted) continue;
    return line.slice(separator + 1).trim();
  }
  return undefined;
}

function names(value: string | undefined): readonly string[] {
  if (!value) return [];
  const result: string[] = [];
  for (const raw of value.split(/[;,\s]+/)) {
    const name = canonicalName(raw);
    if (name && !result.some((entry) => entry.toLowerCase() === name.toLowerCase())) result.push(name);
  }
  return result;
}

function tocPath(name: string): string {
  const lower = name.toLowerCase();
  return `interface/addons/${lower}/${lower}.toc`;
}

function addonDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/**
 * Loads a load-on-demand add-on into an already booted FrameXML VM.
 *
 * The provider is deliberately asynchronous, so the host-facing operation is asynchronous too;
 * the Lua `IsAddOnLoaded` binding is only a status view. This prevents a synchronous Lua call from
 * claiming success while network/file IO is still in flight. Every successful load uses the boot's
 * existing `GlueLoader`, `FrameXmlUiBridge`, and template registry.
 */
export class FrameXmlAddonRuntime {
  readonly #checkpoint: GlueLoadCheckpoint | undefined;
  readonly #provider: GlueFileProvider;
  readonly #vm: GlueLuaVm;
  readonly #bridge: FrameXmlUiBridge;
  readonly #onRoots: ((roots: readonly FrameXmlFrame[]) => void) | undefined;
  readonly #savedVariables: FrameXmlSavedVariables | undefined;
  readonly #initialModules = new Map<string, string>();
  readonly #records = new Map<string, AddonRecord>();
  readonly #loadOnDemand: ReadonlySet<string>;
  #closed = false;

  constructor(options: FrameXmlAddonRuntimeOptions) {
    this.#checkpoint = options.checkpoint;
    this.#provider = options.provider;
    this.#vm = options.vm;
    this.#bridge = options.bridge;
    this.#onRoots = options.onRoots;
    this.#savedVariables = options.savedVariables;
    for (const value of options.initialModules ?? []) {
      const name = canonicalName(value);
      if (name) this.#initialModules.set(name.toLowerCase(), name);
    }
    this.#loadOnDemand = new Set(
      [...DEFAULT_LOAD_ON_DEMAND, ...(options.loadOnDemand ?? [])]
        .map((value) => canonicalName(value)?.toLowerCase())
        .filter((value): value is string => value !== undefined),
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Install the modules that the already-booted FrameXML TOC glued in. */
  setInitialModules(names: readonly string[]): void {
    if (this.#closed) return;
    this.#initialModules.clear();
    for (const value of names) {
      const name = canonicalName(value);
      if (name) this.#initialModules.set(name.toLowerCase(), name);
    }
  }

  isKnown(name: unknown): boolean {
    const canonical = canonicalName(name);
    if (!canonical) return false;
    const lower = canonical.toLowerCase();
    return this.#initialModules.has(lower) || this.#loadOnDemand.has(lower) || this.#records.has(lower)
      || LOD_POLICY_BY_LOWER.get(lower) === "owner";
  }

  isLoaded(name: unknown): boolean {
    const canonical = canonicalName(name);
    if (!canonical) return false;
    const lower = canonical.toLowerCase();
    return this.#initialModules.has(lower) || this.#records.get(lower)?.state === "loaded";
  }

  /** Synchronous C API view: it never reports a pending module as loaded. */
  status(name: unknown): readonly unknown[] {
    if (this.#closed) return [false, "CLOSED"];
    if (this.isLoaded(name)) return [true, true];
    return [false];
  }

  /**
   * `LoadAddOn(name)`. The client's is synchronous (0x00528920: it loads and answers 1, or nil and
   * the reason); files here arrive over the network, so a known add-on that is not in yet — one of
   * the client's add-ons, MSBTOptions for `/msbt` say — starts loading (the same idempotent
   * `loadAddon` the owners use) and answers `false, "NOT_READY"`; the next call after the load
   * answers `true`. An `owner` add-on (FRAMEXML_LOD_POLICY) answers `NOT_READY` and is left to its
   * owner; a `disabled` one answers `false, "DISABLED"` without reading a file.
   */
  loadStatus(name: unknown): readonly unknown[] {
    if (this.#closed) return [false, "CLOSED"];
    if (this.isLoaded(name)) return [true];
    const canonical = canonicalName(name);
    const lower = canonical?.toLowerCase();
    if (lower !== undefined && LOD_POLICY_BY_LOWER.get(lower) === "disabled"
      && !this.#initialModules.has(lower) && !this.#records.has(lower)) return [false, "DISABLED"];
    const previous = lower !== undefined ? this.#records.get(lower)?.result : undefined;
    if (previous?.status === "missing") return [false, "MISSING"];
    if (previous?.status === "failed") return [false, "FAILED"];
    if (previous?.status === "closed") return [false, "CLOSED"];
    // Unknown modules preserve the old FrameXML `MISSING` contract.
    if (!canonical || !this.isKnown(canonical)) return [false, "MISSING"];
    // An owner's add-on is loaded by its owner, which prepares the host side first (a bare Talent
    // UI load raised in the trainer test); the call only reports that it is not in yet.
    if (LOD_POLICY_BY_LOWER.get(canonical.toLowerCase()) === "owner") return [false, "NOT_READY"];
    if (this.#records.get(canonical.toLowerCase())?.state !== "loading") {
      void this.loadAddon(canonical).then((result) => {
        if (!result.ok && result.status !== "closed") {
          console.warn(`FrameXML LoadAddOn(${canonical}) did not load: ${result.message ?? result.status}`);
        }
      });
    }
    return [false, "NOT_READY"];
  }

  /**
   * Synchronous metadata view used while the already-read TOC's Lua files execute.
   *
   * L5c 3.18: Wow.exe's `GetAddOnMetadata` (0x00511430 → 0x005f74e0) looks the name up in the add-on
   * list the client scanned from Interface/AddOns at start — loaded or not — and pushes the key's value
   * or nil, never an error. So an installed add-on's TOC is answered before it loads (`primeMetadata`
   * read it), and a TSWoW module, glued into FrameXML.toc and absent from that list, answers nil.
   */
  metadata(name: unknown, key: unknown): readonly unknown[] {
    const canonical = canonicalName(name);
    if (!canonical || typeof key !== "string" || key.trim().length === 0) return [];
    const source = this.#records.get(canonical.toLowerCase())?.toc?.source
      ?? this.#installedTocs.get(canonical.toLowerCase()); // L5c 3.18
    const value = source !== undefined ? metadata(source, key) : undefined;
    return value === undefined ? [] : [value];
  }

  /** L5c 3.18: installed add-ons' TOC text, read before they load, for `GetAddOnMetadata`. */
  readonly #installedTocs = new Map<string, string>();

  /**
   * L5c 3.18: read the TOCs of installed add-ons (the client's own Interface/AddOns list) so
   * `GetAddOnMetadata` answers for those not loaded yet, as the client's start-up scan does. Reads go
   * through the same provider (the boot's cached corpus) the later load uses; one that fails is left
   * unanswered (nil), as a missing TOC is.
   */
  async primeMetadata(names: readonly string[]): Promise<void> {
    const wanted = new Map<string, string>();
    for (const value of names) {
      const canonical = canonicalName(value);
      const lower = canonical?.toLowerCase();
      if (!canonical || !lower || this.#initialModules.has(lower) || this.#installedTocs.has(lower)) continue;
      wanted.set(lower, canonical);
    }
    await Promise.all([...wanted].map(async ([lower, canonical]) => {
      try {
        const source = await this.#provider.read(tocPath(canonical));
        if (!this.#closed && typeof source === "string") this.#installedTocs.set(lower, source);
      } catch { /* not answered, as a missing TOC is not */ }
    }));
  }

  async loadAddon(name: string, ancestry: readonly string[] = []): Promise<FrameXmlAddonRuntimeResult> {
    const canonical = canonicalName(name);
    if (!canonical) return this.failure(String(name), "missing", "invalid add-on name");
    if (this.#closed) return this.failure(canonical, "closed", "FrameXML VM is closed");
    const lower = canonical.toLowerCase();
    if (ancestry.includes(lower)) {
      return this.failure(canonical, "failed", `add-on dependency cycle: ${[...ancestry, lower].join(" -> ")}`);
    }
    if (this.#initialModules.has(lower)) {
      return this.success(canonical, "already-loaded", [], [], []);
    }
    const existing = this.#records.get(lower);
    if (existing?.state === "loaded") {
      const prior = existing.result;
      return this.success(canonical, "already-loaded", prior?.dependencies ?? [], prior?.loaded ?? [], prior?.roots ?? []);
    }
    if (existing?.state === "loading" && existing.promise) return await existing.promise;
    if (existing?.state === "failed" && existing.result) return existing.result;

    const record: AddonRecord = { name: canonical, lower, state: "loading" };
    this.#records.set(lower, record);
    let resolvePending!: (result: FrameXmlAddonRuntimeResult) => void;
    const promise = new Promise<FrameXmlAddonRuntimeResult>((resolve) => {
      resolvePending = resolve;
    });
    record.promise = promise;
    record.cancel = () => {
      if (record.settled) return;
      record.settled = true;
      record.state = "failed";
      const result = this.failure(record.name, "closed", "FrameXML VM closed during add-on load");
      record.result = result;
      resolvePending(result);
    };
    void this.loadRecord(record, [...ancestry, lower]).then((result) => {
      if (record.settled) return;
      record.settled = true;
      resolvePending(result);
    }).catch((error) => {
      if (record.settled) return;
      record.settled = true;
      record.state = "failed";
      const result = this.failure(record.name, this.#closed ? "closed" : "failed",
        `add-on execution failed: ${String(error)}`);
      record.result = result;
      resolvePending(result);
    });
    return await promise;
  }

  /** `FrameXmlBoot.close()` calls this before destroying the shared VM. */
  close(): void {
    this.#closed = true;
    for (const record of this.#records.values()) {
      if (record.state === "loading") record.cancel?.();
    }
  }

  private success(
    addon: string,
    status: "loaded" | "already-loaded",
    dependencies: readonly string[],
    loaded: readonly string[],
    roots: readonly FrameXmlFrame[],
  ): FrameXmlAddonRuntimeResult {
    return Object.freeze({
      ok: true, addon, status,
      dependencies: Object.freeze([...dependencies]),
      loaded: Object.freeze([...loaded]),
      roots: Object.freeze([...roots]),
    });
  }

  private failure(
    addon: string,
    status: "missing" | "failed" | "closed",
    message: string,
    dependencies: readonly string[] = [],
    loaded: readonly string[] = [],
    roots: readonly FrameXmlFrame[] = [],
  ): FrameXmlAddonRuntimeResult {
    return Object.freeze({
      ok: false, addon, status, message,
      dependencies: Object.freeze([...dependencies]),
      loaded: Object.freeze([...loaded]),
      roots: Object.freeze([...roots]),
    });
  }

  private async readToc(name: string): Promise<AddonToc | FrameXmlAddonRuntimeResult> {
    const path = tocPath(name);
    let source: string | undefined;
    try {
      source = await this.#provider.read(path);
    } catch (error) {
      return this.failure(name, "failed", `failed to read ${path}: ${String(error)}`);
    }
    if (source === undefined || source.trim().length === 0) {
      return this.failure(name, "missing", `${name} is not installed (${path})`);
    }
    const entries = parseGlueToc(source, addonDirectory(path));
    return {
      name, path, source, entries,
      dependencies: names(metadata(source, "Dependencies")),
    };
  }

  private async loadRecord(record: AddonRecord, ancestry: readonly string[]): Promise<FrameXmlAddonRuntimeResult> {
    const toc = await this.readToc(record.name);
    if ("ok" in toc) {
      record.state = "failed";
      record.result = toc;
      return toc;
    }
    record.toc = toc;

    const dependencies: string[] = [];
    for (const dependency of toc.dependencies) {
      const result = await this.loadAddon(dependency, ancestry);
      dependencies.push(dependency);
      if (!result.ok) {
        const failed = this.failure(record.name, "failed", `dependency ${dependency}: ${result.message ?? result.status}`,
          dependencies, result.loaded, result.roots);
        record.state = "failed";
        record.result = failed;
        return failed;
      }
    }

    // Preflight the complete XML graph before GlueLoader can mutate the shared bridge. GlueLoader
    // intentionally ignores unsupported roots, which is useful for the historical FrameXML
    // corpus but would make a failed LoD add-on look loaded. This graph walk is still lazy: it only
    // runs after this add-on's LoadAddOn host operation starts, and the provider/cache coalesces
    // the reads that GlueLoader performs immediately afterwards.
    const preflight = await this.preflightXml(toc.entries
      .filter((entry) => entry.kind === "xml")
      .map((entry) => entry.path));
    if (preflight !== undefined) {
      const failed = this.failure(record.name, "failed", preflight, dependencies);
      record.state = "failed";
      record.result = failed;
      return failed;
    }

    // The base boot derives its fallback globals from the base corpus before running any Lua.
    // A LoD file is deliberately outside that scan, so derive the same plan for this add-on and
    // extend the already-installed tables before its first chunk executes. This keeps the add-on
    // in the shared VM/registry while still refusing to invent any typed Talent API: unresolved
    // calls get the existing neutral recorder, exactly as they do for the base corpus.
    const addonPlan = await this.stubPlan(toc.entries);
    if ("error" in addonPlan) {
      const failed = this.failure(record.name, "failed", addonPlan.error, dependencies);
      record.state = "failed";
      record.result = failed;
      return failed;
    }
    if (this.#closed) {
      const failed = this.failure(record.name, "closed", "FrameXML VM closed during add-on preparation",
        dependencies);
      record.state = "failed";
      record.result = failed;
      return failed;
    }
    let stubFloorExtended = false;
    try {
      stubFloorExtended = this.extendStubFloor(addonPlan.plan);
    } catch (error) {
      const failed = this.failure(record.name, this.#closed ? "closed" : "failed",
        `could not extend the FrameXML stub floor: ${String(error)}`, dependencies);
      record.state = "failed";
      record.result = failed;
      return failed;
    }
    if (!stubFloorExtended) {
      const failed = this.failure(record.name, "failed",
        "could not extend the FrameXML stub floor before add-on execution", dependencies);
      record.state = "failed";
      record.result = failed;
      return failed;
    }
    if (this.#closed) {
      const failed = this.failure(record.name, "closed", "FrameXML VM closed during add-on preparation",
        dependencies);
      record.state = "failed";
      record.result = failed;
      return failed;
    }

    this.#savedVariables?.registerToc(toc.source, record.name);
    const namespace = this.#vm.createTable();
    const loader = new GlueLoader({
      vm: this.#vm,
      bridge: this.#bridge,
      provider: this.#provider,
      checkpoint: async () => {
        if (this.#closed) throw new Error("FrameXML add-on load cancelled");
        await this.#checkpoint?.();
        if (this.#closed) throw new Error("FrameXML add-on load cancelled");
      },
      luaArguments: [record.name, namespace],
      maxFiles: 1024,
      maxDepth: 32,
    });
    let loaded: Awaited<ReturnType<GlueLoader["load"]>>;
    try {
      loaded = await loader.load(toc.path);
    } catch (error) {
      const failed = this.failure(record.name, this.#closed ? "closed" : "failed",
        `add-on execution failed: ${String(error)}`, dependencies);
      record.state = "failed";
      record.result = failed;
      return failed;
    } finally {
      this.#vm.release(namespace);
    }
    const messages = loaded.diagnostics.map((item) => `${item.file}: ${item.message}`);
    if (loaded.missing.length > 0 || messages.length > 0) {
      const failed = this.failure(record.name, "failed",
        loaded.missing.length > 0
          ? `missing resource: ${loaded.missing[0]}`
          : messages[0] ?? "add-on load failed",
        dependencies, loaded.loaded, loaded.roots);
      record.state = "failed";
      record.result = failed;
      return failed;
    }
    if (this.#closed) {
      const failed = this.failure(record.name, "closed", "FrameXML VM closed during add-on load",
        dependencies, loaded.loaded, loaded.roots);
      record.state = "failed";
      record.result = failed;
      return failed;
    }

    record.state = "loaded";
    const result = this.success(record.name, "loaded", dependencies, loaded.loaded, loaded.roots);
    record.result = result;
    this.#onRoots?.(loaded.roots);
    this.#savedVariables?.finishModule(record.name);
    // Match the client lifecycle: a LoD module is observable only once all of its files ran.
    this.#bridge.dispatchEvent("ADDON_LOADED", record.name);
    return result;
  }

  private async preflightXml(paths: readonly string[]): Promise<string | undefined> {
    const seen = new Set<string>();
    const walk = async (path: string): Promise<string | undefined> => {
      const normalized = normalizeGluePath(path);
      if (seen.has(normalized)) return undefined;
      seen.add(normalized);
      let source: string | undefined;
      try {
        source = await this.#provider.read(normalized);
      } catch (error) {
        return `${normalized} could not be read: ${String(error)}`;
      }
      if (source === undefined || source.trim().length === 0) return `${normalized} is missing`;
      const parsed = parseFrameXml(source);
      if (!parsed.ok || !parsed.root) return `${normalized} has a malformed XML root`;
      if (parsed.root.name !== "Ui" && !FRAME_XML_WIDGET_TYPES.has(parsed.root.name)) {
        return `${normalized} has unsupported XML root <${parsed.root.name}>`;
      }
      const directory = normalized.slice(0, normalized.lastIndexOf("/") + 1);
      const includes: string[] = [];
      const visit = (element: FrameXmlElement): void => {
        if (element.name === "Include") {
          const reference = element.attributes.file?.trim() ?? "";
          const target = reference ? resolveGluePath(directory, reference) : undefined;
          if (target) includes.push(target);
          else includes.push(`${normalized}/<invalid-include>`);
        }
        for (const child of element.children) visit(child);
      };
      visit(parsed.root);
      for (const include of includes) {
        if (include.endsWith("/<invalid-include>")) return `${normalized} has an invalid Include path`;
        const failure = await walk(include);
        if (failure !== undefined) return failure;
      }
      return undefined;
    };
    for (const path of paths) {
      const failure = await walk(path);
      if (failure !== undefined) return failure;
    }
    return undefined;
  }

  /**
   * Collect an add-on's Lua sources and XML handler bodies in execution-independent order.
   * `frameXmlStubPlan` only needs text, while GlueLoader below remains the authority for actual
   * execution order and widget creation. Includes/scripts are walked with the same path rules as
   * the preflight, so an unsupported or missing source cannot silently shrink the plan.
   */
  private async stubPlan(
    entries: ReturnType<typeof parseGlueToc>,
  ): Promise<{ readonly plan: FrameXmlStubPlan } | { readonly error: string }> {
    const chunks: FrameXmlLuaChunk[] = [];
    const seen = new Set<string>();
    const read = async (path: string): Promise<string | undefined | Error> => {
      try {
        return await this.#provider.read(normalizeGluePath(path));
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    };
    const visitLua = async (path: string): Promise<string | undefined> => {
      const normalized = normalizeGluePath(path);
      if (seen.has(normalized)) return undefined;
      seen.add(normalized);
      const source = await read(normalized);
      if (source instanceof Error) return `${normalized} could not be read: ${source.message}`;
      if (source === undefined || source.trim().length === 0) return `${normalized} is missing`;
      chunks.push({ file: normalized, source });
      return undefined;
    };
    const visitXml = async (path: string): Promise<string | undefined> => {
      const normalized = normalizeGluePath(path);
      if (seen.has(normalized)) return undefined;
      seen.add(normalized);
      const source = await read(normalized);
      if (source instanceof Error) return `${normalized} could not be read: ${source.message}`;
      if (source === undefined || source.trim().length === 0) return `${normalized} is missing`;
      const parsed = parseFrameXml(source);
      if (!parsed.ok || !parsed.root) return `${normalized} has a malformed XML root`;
      chunks.push(...frameXmlInlineScripts(source).map((body, index) => ({
        file: `${normalized}:Script[${index}]`, source: body,
      })));
      chunks.push(...frameXmlHandlerScripts(parsed.root, normalized));
      const directory = normalized.slice(0, normalized.lastIndexOf("/") + 1);
      const children = parsed.root.name === "Ui" ? parsed.root.children : [parsed.root];
      for (const child of children) {
        if (child.name === "Include") {
          const reference = child.attributes.file?.trim() ?? "";
          const target = reference ? resolveGluePath(directory, reference) : undefined;
          if (!target) return `${normalized} has an invalid Include path`;
          const failure = await visitXml(target);
          if (failure) return failure;
        } else if (child.name === "Script") {
          // A `<Script>` with no `file` is an inline body — `Blizzard_RaidUI.xml:1220` closes the
          // add-on with one — and `frameXmlInlineScripts` above has already taken its text. Only a
          // declared file has a path to resolve; refusing the inline form failed the whole module.
          if (child.attributes.file === undefined) continue;
          const reference = child.attributes.file.trim();
          const target = reference ? resolveGluePath(directory, reference) : undefined;
          if (!target) return `${normalized} has an invalid Script path`;
          const failure = await visitLua(target);
          if (failure) return failure;
        }
      }
      return undefined;
    };
    for (const entry of entries) {
      const failure = entry.kind === "lua"
        ? await visitLua(entry.path)
        : await visitXml(entry.path);
      if (failure) return { error: failure };
    }
    return { plan: await frameXmlStubPlanAsync(chunks, async () => {
      if (this.#closed) throw new Error("FrameXML add-on load cancelled");
      await this.#checkpoint?.();
      if (this.#closed) throw new Error("FrameXML add-on load cancelled");
    }) };
  }

  /** Add per-addon names to the prelude's live tables without replacing the shared VM state. */
  private extendStubFloor(plan: FrameXmlStubPlan): boolean {
    if (plan.apiNames.size === 0 && plan.methodNames.size === 0) return true;
    this.#vm.setGlobal("__fxAddonApiNames", [...plan.apiNames]);
    this.#vm.setGlobal("__fxAddonMethodNames", [...plan.methodNames]);
    try {
      const result = this.#vm.execute(`
        for index = 1, #__fxAddonApiNames do
          __fxApi[__fxAddonApiNames[index]] = true
        end
        for index = 1, #__fxAddonMethodNames do
          __fxMethodNames[__fxAddonMethodNames[index]] = true
        end
      `, "@FrameXmlAddonRuntime:stub-floor");
      return result.ok;
    } finally {
      // These are only transport globals for this one synchronous extension. Do not leave a Lua
      // table rooted from the VM after an add-on fails or the host closes the boot.
      if (!this.#closed) {
        this.#vm.setGlobal("__fxAddonApiNames", undefined);
        this.#vm.setGlobal("__fxAddonMethodNames", undefined);
      }
    }
  }
}

export function addonRuntimeTocPath(name: string): string | undefined {
  const canonical = canonicalName(name);
  return canonical ? normalizeGluePath(tocPath(canonical)) : undefined;
}
