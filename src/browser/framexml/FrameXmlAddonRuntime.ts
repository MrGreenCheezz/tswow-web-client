import type { GlueLoadCheckpoint } from "../glue/GlueLoadScheduler.js";
import {
  GlueLoader,
  type GlueFileProvider,
  type GlueLoadResult,
  type GlueSyncFileSource,
  type GlueTocEntry,
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
  frameXmlStubPlan,
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

/**
 * 3.18 (owner, 12.10): what one prefetch came to, for the mount's preloader (FrameXmlLodPreload.ts).
 * `ok: false` with the provider's error in `message` when a file could not be read — the preloader
 * stops at a gateway that is down by that text — or with the reason the load itself will give.
 */
export interface FrameXmlAddonPrefetchResult {
  readonly ok: boolean;
  readonly message?: string;
}

export interface FrameXmlAddonRuntimeOptions {
  readonly checkpoint?: GlueLoadCheckpoint;
  readonly provider: GlueFileProvider;
  readonly vm: GlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
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

/**
 * 3.18 (owner, 12.10): one add-on's files read ahead of its `LoadAddOn` (`prefetch`) — every path its
 * load reads, normalized, an absent file as `undefined` — and the stub plan of their text. `complete`
 * once every read answered; a read that threw leaves it `incomplete`, and that add-on takes the
 * asynchronous path. Nothing of it has run.
 */
interface PrefetchedAddon {
  state: "pending" | "complete" | "incomplete";
  readonly files: Map<string, string | undefined>;
  dependencies: readonly string[];
  plan?: FrameXmlStubPlan;
  done?: Promise<FrameXmlAddonPrefetchResult>;
}

/**
 * One request an add-on load makes of whoever drives it (3.18): a file, a dependency's load, the stub
 * plan of its text, the run of its TOC. `loadAddon` answers them asynchronously, as it always did;
 * `LoadAddOn` of a prefetched add-on answers them from memory inside the call; `prefetch` drives the
 * reading part of the same walk, so the files it keeps are the files the load asks for.
 */
type AddonLoadStep =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "dependency"; readonly name: string; readonly ancestry: readonly string[] }
  | { readonly kind: "plan"; readonly chunks: readonly FrameXmlLuaChunk[] }
  | { readonly kind: "run"; readonly loader: GlueLoader; readonly path: string };

type AddonLoadSteps<T> = Generator<AddonLoadStep, T, unknown>;

function* readAddonFile(path: string): AddonLoadSteps<string | undefined> {
  return (yield { kind: "read", path }) as string | undefined;
}

const DEFAULT_LOAD_ON_DEMAND = Object.freeze([FRAME_XML_TALENT_ADDON, FRAME_XML_TRAINER_ADDON]);
// Blizzard LoD folders commonly use underscores; TSWoW's generated marker names commonly use
// hyphens (`retail-talents`, `tswow-store`). Both are single safe path segments.
// `!BugGrabber`-style loader folders are a longstanding WoW convention. Keep the name to one safe
// path segment while accepting the punctuation and leading digits the native add-on loader does.
const ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]*$/;
/** Reads a prefetch keeps in flight at once, as FrameXmlCorpus.prefetch does. */
const PREFETCH_CONCURRENCY = 8;

function canonicalName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return ADDON_NAME.test(name) ? name : undefined;
}

function metadata(source: string, key: string): string | undefined {
  const wanted = key.toLowerCase();
  for (const raw of source.replace(/^﻿/, "").split(/\r?\n/)) {
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

/** `LoadAddOn`'s reason for a load that ended without the add-on (the async path's next answer too). */
function loadAddOnFailure(result: FrameXmlAddonRuntimeResult): readonly unknown[] {
  if (result.status === "missing") return [false, "MISSING"];
  if (result.status === "closed") return [false, "CLOSED"];
  return [false, "FAILED"];
}

function warnLoadAddOnFailure(name: string, result: FrameXmlAddonRuntimeResult): void {
  if (!result.ok && result.status !== "closed") {
    console.warn(`FrameXML LoadAddOn(${name}) did not load: ${result.message ?? result.status}`);
  }
}

/** Every `<Include file>`/`<Script file>` an XML file names, at any depth: the prefetch's read-ahead. */
function xmlFileReferences(source: string, path: string): readonly string[] {
  const parsed = parseFrameXml(source);
  if (!parsed.root) return [];
  const directory = path.slice(0, path.lastIndexOf("/") + 1);
  const references: string[] = [];
  const visit = (element: FrameXmlElement): void => {
    if (element.name === "Include" || element.name === "Script") {
      const reference = element.attributes.file?.trim();
      const target = reference ? resolveGluePath(directory, reference) : undefined;
      if (target) references.push(target);
    }
    for (const child of element.children) visit(child);
  };
  visit(parsed.root);
  return references;
}

/**
 * Loads a load-on-demand add-on into an already booted FrameXML VM.
 *
 * The provider is deliberately asynchronous, so the host-facing operation is asynchronous too;
 * the Lua `IsAddOnLoaded` binding is only a status view. This prevents a synchronous Lua call from
 * claiming success while network/file IO is still in flight. Every successful load uses the boot's
 * existing `GlueLoader`, `FrameXmlUiBridge`, and template registry.
 *
 * 3.18 (owner, 12.10): the one synchronous load is `LoadAddOn` of a third-party add-on whose files
 * the mount's loading window already read (`prefetch`): the same steps (`loadSteps`), answered from
 * memory inside the call — Wow.exe's `LoadAddOn` reads and runs the add-on before it returns.
 */
export class FrameXmlAddonRuntime {
  readonly #checkpoint: GlueLoadCheckpoint | undefined;
  readonly #provider: GlueFileProvider;
  readonly #vm: GlueLuaVm;
  readonly #bridge: FrameXmlUiBridge;
  readonly #onRoots: ((roots: readonly FrameXmlFrame[]) => void) | undefined;
  readonly #savedVariables: FrameXmlSavedVariables | undefined;
  readonly #records = new Map<string, AddonRecord>();
  readonly #loadOnDemand: ReadonlySet<string>;
  /** 3.18 (owner, 12.10): third-party LoD add-ons read ahead of their `LoadAddOn`, by lower-case name. */
  readonly #prefetched = new Map<string, PrefetchedAddon>();
  #closed = false;

  /** The boot's checkpoint, refusing to go on once the VM is closed (the stub plan's and the loader's). */
  readonly #cancellable: GlueLoadCheckpoint = async () => {
    if (this.#closed) throw new Error("FrameXML add-on load cancelled");
    await this.#checkpoint?.();
    if (this.#closed) throw new Error("FrameXML add-on load cancelled");
  };

  constructor(options: FrameXmlAddonRuntimeOptions) {
    this.#checkpoint = options.checkpoint;
    this.#provider = options.provider;
    this.#vm = options.vm;
    this.#bridge = options.bridge;
    this.#onRoots = options.onRoots;
    this.#savedVariables = options.savedVariables;
    this.#loadOnDemand = new Set(
      [...DEFAULT_LOAD_ON_DEMAND, ...(options.loadOnDemand ?? [])]
        .map((value) => canonicalName(value)?.toLowerCase())
        .filter((value): value is string => value !== undefined),
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * An add-on the client has: installed in its AddOns list, or one of FRAMEXML_LOD_POLICY's owners.
   * 3.46: a TSWoW module is not — Wow.exe glues it into FrameXML.toc, where nothing makes it an
   * add-on (FrameXmlBoot.isModuleLoaded is the host's own knowledge of the modules).
   */
  isKnown(name: unknown): boolean {
    const canonical = canonicalName(name);
    if (!canonical) return false;
    const lower = canonical.toLowerCase();
    return this.#loadOnDemand.has(lower) || this.#records.has(lower)
      || LOD_POLICY_BY_LOWER.get(lower) === "owner";
  }

  isLoaded(name: unknown): boolean {
    const canonical = canonicalName(name);
    if (!canonical) return false;
    return this.#records.get(canonical.toLowerCase())?.state === "loaded";
  }

  /**
   * `IsAddOnLoaded(name)`: loaded, finished — never a pending add-on — or nil for any name not loaded,
   * as Wow.exe answers it. 3.46: a TSWoW module's name too; it is no add-on in Wow.exe.
   */
  status(name: unknown): readonly unknown[] {
    if (this.#closed) return [false, "CLOSED"];
    if (this.isLoaded(name)) return [true, true];
    return [undefined];
  }

  /**
   * `LoadAddOn(name)`. The client's is synchronous (0x00528920: it reads the add-on's files, runs
   * them and answers 1, or nil and the reason).
   *
   * 3.18 (owner, 12.10): a third-party add-on whose files the mount's loading window read
   * (`prefetch`) — it and every dependency not in yet — runs the same way, inside this call: its
   * dependencies first, its SavedVariables before its ADDON_LOADED, ADDON_LOADED before the answer,
   * which is 1 — so `/msbt`'s next line finds MSBTOptions (MSBTProfiles.lua:1554-1566).
   *
   * Any other known add-on not in yet — its prefetch unfinished or incomplete, one of the client's
   * add-ons never prefetched — starts loading over the network (the same idempotent `loadAddon` the
   * owners use) and answers `false, "NOT_READY"`; the next call after the load answers 1. An `owner`
   * add-on (FRAMEXML_LOD_POLICY) answers `NOT_READY` and is left to its owner; a `disabled` one
   * answers `false, "DISABLED"` without reading a file. 3.46: a TSWoW module's name is `MISSING`.
   */
  loadStatus(name: unknown): readonly unknown[] {
    if (this.#closed) return [false, "CLOSED"];
    if (this.isLoaded(name)) return [1];
    const canonical = canonicalName(name);
    const lower = canonical?.toLowerCase();
    if (lower !== undefined && LOD_POLICY_BY_LOWER.get(lower) === "disabled" && !this.#records.has(lower)) {
      return [false, "DISABLED"];
    }
    const previous = lower !== undefined ? this.#records.get(lower)?.result : undefined;
    if (previous !== undefined && !previous.ok) return loadAddOnFailure(previous);
    // Unknown modules preserve the old FrameXML `MISSING` contract.
    if (!canonical || lower === undefined || !this.isKnown(canonical)) return [false, "MISSING"];
    // An owner's add-on is loaded by its owner, which prepares the host side first (a bare Talent
    // UI load raised in the trainer test); the call only reports that it is not in yet.
    if (LOD_POLICY_BY_LOWER.get(lower) === "owner") return [false, "NOT_READY"];
    if (this.#records.get(lower)?.state !== "loading" && this.syncReady(canonical)) {
      const result = this.loadAddonNow(canonical);
      if (result !== undefined) {
        warnLoadAddOnFailure(canonical, result);
        return result.ok ? [1] : loadAddOnFailure(result);
      }
    }
    if (this.#records.get(lower)?.state !== "loading") {
      void this.loadAddon(canonical).then((result) => warnLoadAddOnFailure(canonical, result));
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
      if (!canonical || !lower || this.#installedTocs.has(lower)) continue;
      wanted.set(lower, canonical);
    }
    await Promise.all([...wanted].map(async ([lower, canonical]) => {
      try {
        const source = await this.#provider.read(tocPath(canonical));
        if (!this.#closed && typeof source === "string") this.#installedTocs.set(lower, source);
      } catch { /* not answered, as a missing TOC is not */ }
    }));
  }

  /**
   * 3.18 (owner, 12.10): read a third-party load-on-demand add-on's files into memory, ahead of its
   * `LoadAddOn` — its TOC, every file the TOC names and every file their XML pulls in through
   * `<Include file>`/`<Script file>`, recursively — by driving the reading part of `loadSteps` (the
   * TOC, the XML preflight, the stub plan's walk), so what is kept is exactly what the load will ask
   * for; the stub plan is derived here too. Then its dependencies not in yet, the same way. Nothing
   * runs: `IsAddOnLoaded` stays nil until a `LoadAddOn` runs it inside the call (`loadStatus`).
   *
   * The reads go through the boot's cached corpus, a level of files at a time (`warm`): over HTTP each
   * is a round trip. One that throws leaves the add-on to the asynchronous path, and its error in the
   * answer (the preloader stops at a gateway that is down). An add-on already loading, loaded or
   * failed needs nothing.
   */
  async prefetch(name: string): Promise<FrameXmlAddonPrefetchResult> {
    const canonical = canonicalName(name);
    if (!canonical) return { ok: false, message: "invalid add-on name" };
    if (this.#closed) return { ok: false, message: "FrameXML VM is closed" };
    const lower = canonical.toLowerCase();
    if (this.#records.has(lower)) return { ok: true };
    const existing = this.#prefetched.get(lower);
    if (existing?.done) return await existing.done;
    const entry: PrefetchedAddon = { state: "pending", files: new Map(), dependencies: [] };
    this.#prefetched.set(lower, entry);
    entry.done = this.prefetchInto(entry, canonical).then(({ complete, result }) => {
      entry.state = complete && !this.#closed ? "complete" : "incomplete";
      // Its load began meanwhile (an early LoadAddOn, an owner): these files are no longer wanted.
      if (this.#records.has(lower) && this.#prefetched.get(lower) === entry) this.#prefetched.delete(lower);
      return result;
    });
    return await entry.done;
  }

  private async prefetchInto(
    entry: PrefetchedAddon, name: string,
  ): Promise<{ readonly complete: boolean; readonly result: FrameXmlAddonPrefetchResult }> {
    let failure: { readonly error: unknown } | undefined;
    const read = async (path: string): Promise<string | undefined> => {
      const key = normalizeGluePath(path);
      if (entry.files.has(key)) return entry.files.get(key);
      try {
        const source = await this.#provider.read(key);
        entry.files.set(key, source);
        return source;
      } catch (error) {
        failure ??= { error };
        throw error;
      }
    };
    const drive = async <T>(steps: AddonLoadSteps<T>): Promise<T> => {
      let next = steps.next();
      while (!next.done) {
        const step = next.value;
        let answer: unknown;
        try {
          if (step.kind === "read") answer = await read(step.path);
          else if (step.kind === "plan") answer = entry.plan = await frameXmlStubPlanAsync(step.chunks, this.#cancellable);
          else throw new Error(`a prefetch does not ${step.kind}`); // the reading walks ask nothing else
        } catch (error) {
          next = steps.throw(error);
          continue;
        }
        next = steps.next(answer);
      }
      return next.value;
    };
    const unread = (): { readonly complete: false; readonly result: FrameXmlAddonPrefetchResult } => ({
      complete: false, result: { ok: false, message: `${name}: a file could not be read: ${String(failure?.error)}` },
    });
    try {
      const toc = await drive(this.readTocSteps(name));
      if (failure) return unread();
      // Not installed: LoadAddOn answers MISSING from these reads, as the asynchronous load would.
      if ("ok" in toc) return { complete: true, result: { ok: false, ...(toc.message ? { message: toc.message } : {}) } };
      entry.dependencies = toc.dependencies;
      await this.warm(toc.entries, read);
      if (failure) return unread();
      const preflight = await drive(this.preflightSteps(toc.entries
        .filter((tocEntry) => tocEntry.kind === "xml").map((tocEntry) => tocEntry.path)));
      if (failure) return unread();
      let result: FrameXmlAddonPrefetchResult = { ok: true };
      if (preflight !== undefined) {
        result = { ok: false, message: preflight }; // the load stops there too, before any Lua
      } else {
        const plan = await drive(this.stubPlanSteps(toc.entries));
        if (failure) return unread();
        if ("error" in plan) result = { ok: false, message: plan.error };
      }
      // The dependencies' own entries; whether they are complete is asked at the LoadAddOn
      // (`syncReady`). One already read or being read is not awaited: a cycle would wait on itself.
      for (const dependency of toc.dependencies) {
        if (this.#closed) break;
        const key = dependency.toLowerCase();
        if (this.#records.has(key) || this.#prefetched.has(key)) continue;
        const prefetched = await this.prefetch(dependency);
        if (!prefetched.ok && result.ok) {
          result = { ok: false, message: `dependency ${dependency}: ${prefetched.message ?? "not read"}` };
        }
      }
      return { complete: true, result };
    } catch (error) {
      return { complete: false, result: { ok: false, message: `${name}: prefetch failed: ${String(error)}` } };
    }
  }

  /**
   * Read ahead, a few at a time, what the walk then asks for one by one: the TOC's files, then what
   * their XML names, a level at a time — the walk only learns an XML file's references once it has
   * it. A superset is harmless; the walk after it decides what is kept. Stops at the first failure.
   */
  private async warm(
    entries: readonly GlueTocEntry[], read: (path: string) => Promise<string | undefined>,
  ): Promise<void> {
    const seen = new Set<string>();
    let level = entries.map((entry) => entry.path);
    while (level.length > 0 && !this.#closed) {
      const batch = [...new Set(level.map(normalizeGluePath))].filter((path) => !seen.has(path));
      for (const path of batch) seen.add(path);
      const sources = new Map<string, string | undefined>();
      let next = 0;
      let failed = false;
      const worker = async (): Promise<void> => {
        while (!failed && next < batch.length) {
          const path = batch[next++];
          if (path === undefined) return;
          try {
            sources.set(path, await read(path));
          } catch {
            failed = true; // `read` kept the error
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, batch.length) }, worker));
      if (failed) return;
      level = [...sources].flatMap(([path, source]) =>
        path.endsWith(".xml") && source ? xmlFileReferences(source, path) : []);
    }
  }

  /** 3.18: whether `loadAddonNow` can run it now — it and every dependency not in yet prefetched. */
  private syncReady(name: string, seen = new Set<string>()): boolean {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return true; // a cycle: the load answers it as the asynchronous one does
    seen.add(lower);
    const record = this.#records.get(lower);
    if (record !== undefined) return record.state !== "loading";
    const entry = this.#prefetched.get(lower);
    return entry?.state === "complete" && entry.dependencies.every((dependency) => this.syncReady(dependency, seen));
  }

  async loadAddon(name: string, ancestry: readonly string[] = []): Promise<FrameXmlAddonRuntimeResult> {
    const canonical = canonicalName(name);
    if (!canonical) return this.failure(String(name), "missing", "invalid add-on name");
    if (this.#closed) return this.failure(canonical, "closed", "FrameXML VM is closed");
    const lower = canonical.toLowerCase();
    if (ancestry.includes(lower)) {
      return this.failure(canonical, "failed", `add-on dependency cycle: ${[...ancestry, lower].join(" -> ")}`);
    }
    const existing = this.#records.get(lower);
    if (existing?.state === "loaded") {
      const prior = existing.result;
      return this.success(canonical, "already-loaded", prior?.dependencies ?? [], prior?.loaded ?? [], prior?.roots ?? []);
    }
    if (existing?.state === "loading" && existing.promise) return await existing.promise;
    if (existing?.state === "failed" && existing.result) return existing.result;

    const pending = this.beginRecord(canonical, lower);
    void this.loadRecord(pending.record, [...ancestry, lower]).then(pending.settle).catch(pending.fail);
    return await pending.promise;
  }

  /**
   * 3.18 (owner, 12.10): `loadAddon` inside the caller's stack, for a prefetched add-on — the same
   * `loadSteps`, answered from its prefetched files; a dependency not in yet runs the same way first.
   * `undefined` when it cannot: not prefetched, or not completely, or a load of it already on its way.
   *
   * A step the prefetch does not answer — impossible while the prefetch walks these same steps, and
   * met, if ever, before any Lua of the add-on: the TOC, the XML preflight and the stub plan's walk
   * read every file the run will — hands the started load to the asynchronous path (`undefined`, the
   * record loading), never a half-executed add-on.
   */
  private loadAddonNow(name: string, ancestry: readonly string[] = []): FrameXmlAddonRuntimeResult | undefined {
    const canonical = canonicalName(name);
    if (!canonical) return this.failure(String(name), "missing", "invalid add-on name");
    if (this.#closed) return this.failure(canonical, "closed", "FrameXML VM is closed");
    const lower = canonical.toLowerCase();
    if (ancestry.includes(lower)) {
      return this.failure(canonical, "failed", `add-on dependency cycle: ${[...ancestry, lower].join(" -> ")}`);
    }
    const existing = this.#records.get(lower);
    if (existing?.state === "loaded") {
      const prior = existing.result;
      return this.success(canonical, "already-loaded", prior?.dependencies ?? [], prior?.loaded ?? [], prior?.roots ?? []);
    }
    if (existing?.state === "loading") return undefined;
    if (existing?.state === "failed" && existing.result) return existing.result;
    const prefetched = this.#prefetched.get(lower);
    if (prefetched?.state !== "complete") return undefined;

    const pending = this.beginRecord(canonical, lower);
    const chain = [...ancestry, lower];
    let result: FrameXmlAddonRuntimeResult | undefined;
    try {
      result = this.driveSync(this.loadSteps(pending.record, chain), prefetched);
    } catch (error) {
      pending.fail(error);
      return pending.record.result;
    }
    if (result === undefined) {
      void this.loadRecord(pending.record, chain).then(pending.settle).catch(pending.fail);
      return undefined;
    }
    pending.settle(result);
    return result;
  }

  /** `FrameXmlBoot.close()` calls this before destroying the shared VM. */
  close(): void {
    this.#closed = true;
    for (const record of this.#records.values()) {
      if (record.state === "loading") record.cancel?.();
    }
    this.#prefetched.clear();
  }

  /** A new record, loading, with the promise every later `loadAddon` of it awaits. */
  private beginRecord(canonical: string, lower: string): {
    readonly record: AddonRecord;
    readonly promise: Promise<FrameXmlAddonRuntimeResult>;
    readonly settle: (result: FrameXmlAddonRuntimeResult) => void;
    readonly fail: (error: unknown) => void;
  } {
    const record: AddonRecord = { name: canonical, lower, state: "loading" };
    this.#records.set(lower, record);
    let resolvePending!: (result: FrameXmlAddonRuntimeResult) => void;
    const promise = new Promise<FrameXmlAddonRuntimeResult>((resolve) => {
      resolvePending = resolve;
    });
    record.promise = promise;
    const finish = (result: FrameXmlAddonRuntimeResult): void => {
      record.settled = true;
      this.#prefetched.delete(lower); // loaded or failed: LoadAddOn answers it without the files
      resolvePending(result);
    };
    record.cancel = () => {
      if (record.settled) return;
      record.state = "failed";
      const result = this.failure(record.name, "closed", "FrameXML VM closed during add-on load");
      record.result = result;
      finish(result);
    };
    return {
      record,
      promise,
      settle: (result) => {
        if (!record.settled) finish(result);
      },
      fail: (error) => {
        if (record.settled) return;
        record.state = "failed";
        const result = this.failure(record.name, this.#closed ? "closed" : "failed",
          `add-on execution failed: ${String(error)}`);
        record.result = result;
        finish(result);
      },
    };
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

  /** The asynchronous driver: every step awaited, as the load always ran. */
  private async loadRecord(record: AddonRecord, ancestry: readonly string[]): Promise<FrameXmlAddonRuntimeResult> {
    const steps = this.loadSteps(record, ancestry);
    let next = steps.next();
    while (!next.done) {
      const step = next.value;
      let answer: unknown;
      try {
        if (step.kind === "read") answer = await this.#provider.read(step.path);
        else if (step.kind === "dependency") answer = await this.loadAddon(step.name, step.ancestry);
        else if (step.kind === "plan") answer = await frameXmlStubPlanAsync(step.chunks, this.#cancellable);
        else answer = await step.loader.load(step.path);
      } catch (error) {
        next = steps.throw(error);
        continue;
      }
      next = steps.next(answer);
    }
    return next.value;
  }

  /**
   * 3.18 (owner, 12.10): the synchronous driver, from one add-on's prefetched files. The run reads
   * through a source that throws for a file not prefetched (reported as a provider failure, as the
   * asynchronous run reports one) — unreachable, the steps before it read every file it reads.
   * `undefined`: a read or a dependency it cannot answer, before any Lua of this add-on ran.
   */
  private driveSync<T>(steps: AddonLoadSteps<T>, prefetched: PrefetchedAddon): T | undefined {
    const files = prefetched.files;
    const source: GlueSyncFileSource = {
      read(path: string): string | undefined {
        const key = normalizeGluePath(path);
        if (!files.has(key)) throw new Error(`${key} was not prefetched`);
        return files.get(key);
      },
    };
    let next = steps.next();
    while (!next.done) {
      const step = next.value;
      let answer: unknown;
      if (step.kind === "read") {
        const key = normalizeGluePath(step.path);
        if (!files.has(key)) {
          steps.return(undefined as T);
          return undefined;
        }
        answer = files.get(key);
      } else if (step.kind === "dependency") {
        answer = this.loadAddonNow(step.name, step.ancestry);
        if (answer === undefined) {
          steps.return(undefined as T);
          return undefined;
        }
      } else if (step.kind === "plan") {
        // Derived from these same files by the prefetch; a pure function of their text.
        answer = prefetched.plan ?? frameXmlStubPlan(step.chunks);
      } else {
        try {
          answer = step.loader.loadSync(step.path, source);
        } catch (error) {
          next = steps.throw(error);
          continue;
        }
      }
      next = steps.next(answer);
    }
    return next.value;
  }

  private *readTocSteps(name: string): AddonLoadSteps<AddonToc | FrameXmlAddonRuntimeResult> {
    const path = tocPath(name);
    let source: string | undefined;
    try {
      source = yield* readAddonFile(path);
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

  /**
   * One add-on load, as steps (3.18): its drivers answer them asynchronously (`loadRecord`) or from
   * prefetched files inside `LoadAddOn` (`driveSync`); the order and every rule are the same.
   */
  private *loadSteps(record: AddonRecord, ancestry: readonly string[]): AddonLoadSteps<FrameXmlAddonRuntimeResult> {
    const toc = yield* this.readTocSteps(record.name);
    if ("ok" in toc) {
      record.state = "failed";
      record.result = toc;
      return toc;
    }
    record.toc = toc;

    const dependencies: string[] = [];
    for (const dependency of toc.dependencies) {
      const result = (yield { kind: "dependency", name: dependency, ancestry }) as FrameXmlAddonRuntimeResult;
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
    // runs after this add-on's LoadAddOn host operation starts (or in its prefetch, which reads and
    // keeps the same files), and the provider/cache coalesces the reads GlueLoader performs afterwards.
    const preflight = yield* this.preflightSteps(toc.entries
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
    const addonPlan = yield* this.stubPlanSteps(toc.entries);
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
      checkpoint: this.#cancellable,
      luaArguments: [record.name, namespace],
      maxFiles: 1024,
      maxDepth: 32,
    });
    let loaded: GlueLoadResult;
    try {
      loaded = (yield { kind: "run", loader, path: toc.path }) as GlueLoadResult;
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

  private *preflightSteps(paths: readonly string[]): AddonLoadSteps<string | undefined> {
    const seen = new Set<string>();
    function* walk(path: string): AddonLoadSteps<string | undefined> {
      const normalized = normalizeGluePath(path);
      if (seen.has(normalized)) return undefined;
      seen.add(normalized);
      let source: string | undefined;
      try {
        source = yield* readAddonFile(normalized);
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
        const failure = yield* walk(include);
        if (failure !== undefined) return failure;
      }
      return undefined;
    }
    for (const path of paths) {
      const failure = yield* walk(path);
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
  private *stubPlanSteps(
    entries: ReturnType<typeof parseGlueToc>,
  ): AddonLoadSteps<{ readonly plan: FrameXmlStubPlan } | { readonly error: string }> {
    const chunks: FrameXmlLuaChunk[] = [];
    const seen = new Set<string>();
    function* read(path: string): AddonLoadSteps<string | undefined | Error> {
      try {
        return yield* readAddonFile(normalizeGluePath(path));
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    }
    function* visitLua(path: string): AddonLoadSteps<string | undefined> {
      const normalized = normalizeGluePath(path);
      if (seen.has(normalized)) return undefined;
      seen.add(normalized);
      const source = yield* read(normalized);
      if (source instanceof Error) return `${normalized} could not be read: ${source.message}`;
      if (source === undefined || source.trim().length === 0) return `${normalized} is missing`;
      chunks.push({ file: normalized, source });
      return undefined;
    }
    function* visitXml(path: string): AddonLoadSteps<string | undefined> {
      const normalized = normalizeGluePath(path);
      if (seen.has(normalized)) return undefined;
      seen.add(normalized);
      const source = yield* read(normalized);
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
          const failure = yield* visitXml(target);
          if (failure) return failure;
        } else if (child.name === "Script") {
          // A `<Script>` with no `file` is an inline body — `Blizzard_RaidUI.xml:1220` closes the
          // add-on with one — and `frameXmlInlineScripts` above has already taken its text. Only a
          // declared file has a path to resolve; refusing the inline form failed the whole module.
          if (child.attributes.file === undefined) continue;
          const reference = child.attributes.file.trim();
          const target = reference ? resolveGluePath(directory, reference) : undefined;
          if (!target) return `${normalized} has an invalid Script path`;
          const failure = yield* visitLua(target);
          if (failure) return failure;
        }
      }
      return undefined;
    }
    for (const entry of entries) {
      const failure = entry.kind === "lua"
        ? yield* visitLua(entry.path)
        : yield* visitXml(entry.path);
      if (failure) return { error: failure };
    }
    // The drivers derive it: asynchronously with the boot's checkpoints, or from the prefetch's plan.
    const plan = (yield { kind: "plan", chunks }) as FrameXmlStubPlan;
    return { plan };
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
