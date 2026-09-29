/**
 * The stock Video/Audio/Interface options frames, loaded into the running VM on their first open.
 *
 * The chain (FRAMEXML_OPTIONS_TOC, stock TOC 37-45) is ordinary FrameXML, not a load-on-demand
 * add-on, so `boot.loadAddon` cannot fetch it. This module does what the boot does for the base TOC,
 * scoped to those files: read and scan them through the boot's own corpus cache, extend the stub
 * floor with the C API they call, run them by GlueLoader's rules into the same VM and bridge, then
 * deliver VARIABLES_LOADED and PLAYER_ENTERING_WORLD to the frames they created — the two events
 * their panels initialize on, which the rest of the interface received at boot.
 *
 * Two stock contracts the late load has to keep:
 *
 * - InterfaceOptions_AddCategory files a panel with the client's own categories only while
 *   `issecure()` is true (InterfaceOptionsFrame.lua:586). This VM answers false (GlueLua.ts), and
 *   measured over the MPQ vertical every one of the 15 stock panels then landed in the «AddOns» tab
 *   sorted by name, with the «Game» tab empty. The chain's own code — and the «WebClient» category
 *   built after it — runs with `issecure()` true, as Blizzard's code does in the client; each
 *   synchronous step of the load drops it back to false, so no other Lua ever runs inside that window.
 * - InterfaceOptionsFrame_OnLoad seeds the uvar globals with their stock defaults. A uvar the host
 *   had already set (the world mount's WORLD_PVP_OBJECTIVES_DISPLAY = "1") would be overwritten by
 *   opening a window, so every uvar that had a value keeps it: its CVar is set to it before the
 *   panels read their CVars, and the global is restored after.
 *
 * The owner follows the lazy LoD recipe (FrameXmlMacroBindingLod.ts): nothing at boot, the first
 * open loads, reconciles the renderer, gates, and only then shows; a failed load or gate demotes the
 * route for good and the native settings window opens instead.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import {
  FRAME_XML_FONT_ELEMENT, FRAME_XML_WIDGET_TYPES, type FrameXmlElement, type FrameXmlFrame,
} from "../ui/framexml_compat/FrameXmlTypes.js";
import { frameXmlAttribute, parseFrameXml } from "../ui/framexml_compat/FrameXmlParser.js";
import {
  normalizeGluePath, parseGlueToc, resolveGluePath, type GlueFileProvider, type GlueTocEntry,
} from "../glue/GlueLoader.js";
import { GlueLoadScheduler } from "../glue/GlueLoadScheduler.js";
import { FrameXmlCorpus, FRAMEXML_OPTIONS_TOC } from "./FrameXmlCorpus.js";
import { frameXmlStubPlanAsync } from "./FrameXmlStubPlan.js";
import { FRAME_XML_SETTINGS_CVARS } from "./FrameXmlSettingsCVar.js";
import {
  frameXmlOptionsAdoptSource, frameXmlOptionsCategorySource, frameXmlOptionsWebClientGroups,
  FRAMEXML_OPTIONS_BEFORE_EVENTS_SOURCE, FRAMEXML_OPTIONS_WEBCLIENT_PANEL,
} from "./FrameXmlOptions.js";
import {
  publishFrameXmlOptions, type FrameXmlOptionsOwner, type FrameXmlOptionsWindow,
} from "./FrameXmlOptionsController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** The synthetic TOC the chain is read and run through, beside the real one. */
export const FRAMEXML_OPTIONS_TOC_PATH = "interface/framexml/__webclient-options.toc";
const INTERFACE_OPTIONS_LUA = "interface/framexml/interfaceoptionsframe.lua";
const HOST_GLOBAL = "__fxWebClientOptions";
const SECURE_GLOBAL = "__fxWebClientOptionsSecure";

/** What the «WebClient» category asks of the page. */
export interface FrameXmlOptionsHost {
  /** Settings.applySettingsPreset: one of the native window's graphics profiles, as one write. */
  preset(kind: "enhanced" | "comparison"): void;
  /** Where the settings are kept, as the native window's footer says it. */
  storageNote(): string;
  /**
   * Whether the native chat dock is on screen, so that its «Чат» settings do something. Absent: it
   * is not (the stock chat is the chat).
   */
  nativeChat?(): boolean;
}

export interface FrameXmlOptionsChainResult {
  readonly ok: boolean;
  readonly message?: string;
  /** Files read for the chain (its synthetic TOC not counted) and their UTF-8 bytes. */
  readonly files: number;
  readonly bytes: number;
  /** Frames the chain and the «WebClient» category created. */
  readonly widgets: number;
  /** Top-level frames the loader produced (the frames themselves are parented into UIParent). */
  readonly roots: readonly FrameXmlFrame[];
  /** Stock controls greyed out as unavailable. */
  readonly disabled: number;
}

/** The uvars InterfaceOptionsFrame.lua seeds, read from the file before it runs: [uvar, cvar]. */
function uvarRows(source: string | undefined): readonly (readonly [string, string])[] {
  if (!source) return [];
  const rows: (readonly [string, string])[] = [];
  const pattern = /\[\s*"([A-Z0-9_]+)"\s*\]\s*=\s*\{\s*default\s*=\s*"[^"]*"\s*,\s*cvar\s*=\s*"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) rows.push([match[1]!, match[2]!]);
  return rows;
}

function errorTotal(boot: Pick<FrameXmlBoot, "errorCount" | "bridge">): number {
  return boot.errorCount + boot.bridge.diagnostics.length;
}

/**
 * GlueLoader's walk (GlueLoader.ts load/loadXml/applyDeclaration/loadLua, in its order and with its
 * rules) over sources already read, synchronously, one TOC entry at a time.
 *
 * Synchronous because the renderer reconciles on every mutation made outside a batch, and a batch
 * cannot span an `await`: through GlueLoader, measured on the rich route, the first open ran 1,096
 * renderer passes — each a full structural walk of ~22,000 frames — for 8.0 s. One batch per entry
 * makes it one pass per entry, and the secure window of each entry ends with it.
 */
class SyncChainLoader {
  readonly missing: string[] = [];
  readonly diagnostics: string[] = [];
  readonly roots: FrameXmlFrame[] = [];
  readonly #seenXml = new Set<string>();

  constructor(
    private readonly boot: Pick<FrameXmlBoot, "vm" | "bridge">,
    private readonly sources: ReadonlyMap<string, string>,
  ) {}

  entry(entry: GlueTocEntry): void {
    if (entry.kind === "lua") this.lua(entry.path);
    else this.xml(entry.path, 0);
  }

  private read(path: string): string | undefined {
    const source = this.sources.get(normalizeGluePath(path));
    if (source === undefined || source === "") {
      this.missing.push(path);
      return undefined;
    }
    return source;
  }

  private lua(path: string): void {
    const source = this.read(path);
    if (source === undefined) return;
    const before = this.boot.vm.errors.length;
    this.boot.vm.executeReported(source, `@${path}`);
    for (const message of this.boot.vm.errors.slice(before)) this.diagnostics.push(`${path}: ${message}`);
  }

  private xml(path: string, depth: number): void {
    if (depth > 16) {
      this.diagnostics.push(`${path}: Include depth exceeds 16`);
      return;
    }
    if (this.#seenXml.has(path)) return;
    this.#seenXml.add(path);
    const source = this.read(path);
    if (source === undefined) return;
    const parsed = parseFrameXml(source);
    for (const message of parsed.diagnostics) this.diagnostics.push(`${path}: ${message}`);
    if (!parsed.root) return;
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    const children = parsed.root.name === "Ui" ? parsed.root.children : [parsed.root];
    for (const element of children) this.declaration(element, path, directory, depth);
  }

  private declaration(element: FrameXmlElement, path: string, directory: string, depth: number): void {
    if (element.name === "Script") {
      const file = frameXmlAttribute(element, "file");
      if (file) {
        const resolved = resolveGluePath(directory, file);
        if (resolved) this.lua(resolved);
        else this.diagnostics.push(`${path}: Script file "${file}" escapes the interface tree`);
        return;
      }
      const body = element.text.trim();
      if (body) {
        const before = this.boot.vm.errors.length;
        this.boot.vm.executeReported(body, `@${path}:Script`);
        for (const message of this.boot.vm.errors.slice(before)) this.diagnostics.push(`${path}: ${message}`);
      }
      return;
    }
    if (element.name === "Include") {
      const file = frameXmlAttribute(element, "file");
      const resolved = file ? resolveGluePath(directory, file) : undefined;
      if (resolved) this.xml(resolved, depth + 1);
      else this.diagnostics.push(`${path}: Include file "${file ?? ""}" is unusable`);
      return;
    }
    const virtual = /^(?:1|true|yes)$/i.test(frameXmlAttribute(element, "virtual")?.trim() ?? "");
    if (element.name === FRAME_XML_FONT_ELEMENT || virtual) {
      this.boot.bridge.registerTemplateElement(element, path);
      return;
    }
    if (!FRAME_XML_WIDGET_TYPES.has(element.name)) return;
    const frame = this.boot.vm.withCallingSource(path, () => this.boot.bridge.instantiate(element));
    if (frame && !frame.parent) this.roots.push(frame);
  }
}

const nextTask = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Load the chain and the «WebClient» category into `boot`'s VM, and initialize them.
 * `closed` cancels at the next task boundary (a world torn down mid-load).
 */
export async function loadFrameXmlOptionsChain(
  boot: FrameXmlBoot,
  host: FrameXmlOptionsHost,
  closed: () => boolean = () => false,
): Promise<FrameXmlOptionsChainResult> {
  const failure = (message: string, files = 0, bytes = 0): FrameXmlOptionsChainResult =>
    ({ ok: false, message, files, bytes, widgets: 0, roots: [], disabled: 0 });
  const toc = `## Interface: 30300\n${FRAMEXML_OPTIONS_TOC.join("\n")}\n`;
  const provider: GlueFileProvider = {
    read: async (path) => normalizeGluePath(path) === FRAMEXML_OPTIONS_TOC_PATH ? toc : await boot.corpus.read(path),
  };
  const checkClosed = (): void => {
    if (closed()) throw new Error("FrameXML options load cancelled");
  };
  // The boot's slicing for the reading half: a task boundary every 8 ms.
  const scheduler = new GlueLoadScheduler();
  const slice = async (): Promise<void> => {
    await scheduler.checkpoint();
    checkClosed();
  };
  // The same walk the boot makes: every file the loader will reach, read through the boot's cache
  // (the gateway's /client/file, once) before the first chunk runs.
  let scan: Awaited<ReturnType<FrameXmlCorpus["scan"]>>;
  try {
    scan = await new FrameXmlCorpus(provider, { checkpoint: slice }).scan(FRAMEXML_OPTIONS_TOC_PATH);
  } catch (error) {
    return failure(`options chain could not be read: ${String(error)}`);
  }
  const files = scan.files.filter((file) => file.kind !== "toc");
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (scan.missing.length > 0 || scan.unparsable.length > 0) {
    return failure(`options chain incomplete: ${[...scan.missing, ...scan.unparsable.map((entry) => entry.file)].join(", ")}`,
      files.length, bytes);
  }
  const sources = new Map<string, string>();
  for (const file of files) sources.set(file.path, await provider.read(file.path) ?? "");
  const plan = await frameXmlStubPlanAsync(scan.chunks, slice);
  const uvars = uvarRows(sources.get(INTERFACE_OPTIONS_LUA));
  checkClosed();

  const vm = boot.vm;
  // The boot's stub floor, extended as FrameXmlAddonRuntime extends it for a LoD add-on.
  vm.setGlobal("__fxOptionsApiNames", [...plan.apiNames]);
  vm.setGlobal("__fxOptionsMethodNames", [...plan.methodNames]);
  vm.setGlobal("__fxOptionsFontNames", [...scan.fontObjects]);
  const extended = vm.execute(`
    for index = 1, #__fxOptionsApiNames do __fxApi[__fxOptionsApiNames[index]] = true end
    for index = 1, #__fxOptionsMethodNames do __fxMethodNames[__fxOptionsMethodNames[index]] = true end
    for index = 1, #__fxOptionsFontNames do __fxFontNames[__fxOptionsFontNames[index]] = true end
    __fxOptionsApiNames, __fxOptionsMethodNames, __fxOptionsFontNames = nil, nil, nil
    local insecure = issecure
    local function secure() return true end
    ${SECURE_GLOBAL} = function(on) if on then issecure = secure else issecure = insecure end end
  `, "@webclient/options-stub-floor");
  if (!extended.ok) return failure(`the stub floor could not be extended: ${extended.error}`, files.length, bytes);
  const secureRef = vm.globalFunction(SECURE_GLOBAL);
  vm.setGlobal(SECURE_GLOBAL, undefined);
  if (!secureRef) return failure("the secure window could not be installed", files.length, bytes);
  /** Run `operation` as one render transaction with `issecure()` true: Blizzard's own code. */
  const secureBatch = <T>(operation: () => T): T => boot.bridge.runInMutationBatch(() => {
    vm.call(secureRef, [true], 0);
    try { return operation(); } finally { vm.call(secureRef, [false], 0); }
  });

  vm.registerGlobal(HOST_GLOBAL, (args) => {
    const action = String(args[0] ?? "");
    try {
      if (action === "note") return [host.storageNote()];
      if (action === "nativeChat") return [host.nativeChat?.() === true];
      // The category's Lua reads back what moved (FrameXmlOptions.ts frameXmlOptionsCategorySource).
      if (action === "preset" && (args[1] === "enhanced" || args[1] === "comparison")) host.preset(args[1]);
    } catch (error) {
      console.warn(`[FrameXML options] ${action}: ${String(error)}`);
    }
    return [];
  });

  const snapshot = new Map<string, string>();
  for (const [uvar] of uvars) {
    const value = vm.globalString(uvar);
    if (value !== undefined) snapshot.set(uvar, value);
  }
  const before = new Set(boot.bridge.frames);
  const errorsBefore = errorTotal(boot);
  const loader = new SyncChainLoader(boot, sources);
  let disabled = 0;
  try {
    for (const entry of parseGlueToc(toc, "interface/framexml/")) {
      secureBatch(() => loader.entry(entry));
      if (loader.missing.length > 0 || loader.diagnostics.length > 0) {
        return failure(loader.missing.length > 0 ? `missing ${loader.missing[0]}` : loader.diagnostics[0]!, files.length, bytes);
      }
      await nextTask();
      checkClosed();
    }
    // The rest in one transaction: the category, the panels' first events and the adoption.
    const ok = secureBatch(() => {
      boot.bridge.registerFontObjects();
      if (!vm.executeReported(frameXmlOptionsCategorySource(frameXmlOptionsWebClientGroups()), "@webclient/options-category")) {
        return false;
      }
      // A uvar the host set before the load keeps its value: its (non-host) CVar is made to say it,
      // so the panels read it back, and the global is put back after their setup.
      const hostCVars = new Set(FRAME_XML_SETTINGS_CVARS.map((row) => row.cvar.toLowerCase()));
      const kept = uvars.filter(([uvar, cvar]) => snapshot.has(uvar) && !hostCVars.has(cvar.toLowerCase()));
      if (kept.length > 0) {
        vm.executeReported(`local rows = ...
          for index = 1, #rows, 2 do
            local cvar, value = rows[index], rows[index + 1]
            if GetCVar(cvar) ~= value then SetCVar(cvar, value) end
          end`, "@webclient/options-uvars", [kept.flatMap(([uvar, cvar]) => [cvar, snapshot.get(uvar)!])]);
      }
      vm.executeReported(FRAMEXML_OPTIONS_BEFORE_EVENTS_SOURCE, "@webclient/options-before-events");
      const created = boot.bridge.frames.filter((frame) => !before.has(frame));
      // VARIABLES_LOADED, then PLAYER_ENTERING_WORLD, as the client orders them — to these frames
      // only: everything else received both at boot and must not run its handlers twice.
      for (const event of ["VARIABLES_LOADED", "PLAYER_ENTERING_WORLD"]) {
        for (const frame of created.filter((candidate) => candidate.registeredEvents.has(event))) {
          if (frame.registeredEvents.has(event)) boot.bridge.fireScript(frame, "OnEvent", event);
        }
      }
      const adopt = vm.compileFunction(frameXmlOptionsAdoptSource(), "webclient/options-adopt", []);
      if (!adopt) return false;
      try { disabled = Number(vm.call(adopt, [], 1)[0] ?? 0); } finally { vm.release(adopt); }
      for (const [uvar, value] of snapshot) vm.setGlobal(uvar, value);
      return true;
    });
    if (!ok) return failure("the WebClient category or its adoption failed", files.length, bytes);
  } catch (error) {
    return failure(`options chain failed: ${String(error)}`, files.length, bytes);
  } finally {
    vm.release(secureRef);
  }
  if (errorTotal(boot) !== errorsBefore) {
    return failure(`options initialization raised ${errorTotal(boot) - errorsBefore} error(s)`, files.length, bytes);
  }
  return {
    ok: true, files: files.length, bytes,
    widgets: boot.bridge.frames.length - before.size, roots: loader.roots, disabled,
  };
}

// ---- the gate ------------------------------------------------------------------------------------

/** The three stock frames and their «Окей»/«Отмена» buttons, in the order the routes name them. */
const WINDOW_FRAMES = [
  ["video", "VideoOptionsFrame"],
  ["audio", "AudioOptionsFrame"],
  ["interface", "InterfaceOptionsFrame"],
] as const;

export interface FrameXmlOptionsFrames {
  readonly video: FrameXmlFrame;
  readonly audio: FrameXmlFrame;
  readonly interface: FrameXmlFrame;
}

function descendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function rendered(renderer: Pick<FrameXmlDomRenderer, "elementFor">, frame: FrameXmlFrame): boolean {
  const element = renderer.elementFor(frame);
  return !!element && element.getAttribute("data-framexml-name") === frame.name
    && element.getAttribute("data-framexml-type") === frame.type;
}

/**
 * Structural, rendered and transactional proof that the three frames can be the options windows:
 * each the named Frame under UIParent, hidden, drawn, with its OnShow/OnHide, and an Okay and a
 * Cancel Button inside it with an OnClick; the «WebClient» category registered; then one silent
 * ShowUIPanel/HideUIPanel per frame shows and hides it with no new Lua error or bridge diagnostic.
 */
export function frameXmlOptionsGate(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlOptionsFrames | undefined {
  try {
    const frames: Partial<Record<(typeof WINDOW_FRAMES)[number][0], FrameXmlFrame>> = {};
    for (const [key, name] of WINDOW_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      // Video/AudioOptionsFrame.xml declare no parent (two of the loader's roots); InterfaceOptions
      // is UIParent's.
      if (!frame || frame.type !== "Frame" || (frame.parent && frame.parent.name !== "UIParent") || frame.visible
        || !rendered(renderer, frame)
        || !boot.bridge.hasScript(frame, "OnShow") || !boot.bridge.hasScript(frame, "OnHide")) return undefined;
      for (const button of ["Okay", "Cancel"]) {
        const control = boot.bridge.getFrame(`${name}${button}`);
        if (!control || control.type !== "Button" || !descendsFrom(control, frame)
          || !rendered(renderer, control) || !boot.bridge.hasScript(control, "OnClick")) return undefined;
      }
      frames[key] = frame;
    }
    const category = boot.bridge.getFrame(FRAMEXML_OPTIONS_WEBCLIENT_PANEL);
    if (!category || !frames.interface || !descendsFrom(category, frames.interface)) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/options-gate", `
      local shown = 0
      for _, frame in ipairs({ VideoOptionsFrame, AudioOptionsFrame, InterfaceOptionsFrame }) do
        ShowUIPanel(frame)
        if frame:IsShown() then shown = shown + 1 end
        HideUIPanel(frame)
        if frame:IsShown() then return -1 end
      end
      return shown
    `, 1);
    if (!probe || probe[0] !== 3 || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics
      || WINDOW_FRAMES.some(([key]) => frames[key]!.visible)) return undefined;
    return { video: frames.video!, audio: frames.audio!, interface: frames.interface! };
  } catch {
    return undefined;
  }
}

// ---- the lazy owner ------------------------------------------------------------------------------

export interface FrameXmlOptionsOwnerSpec {
  readonly host: FrameXmlOptionsHost;
  /** The stock frames cannot be used; `wanted` is the window the player is waiting for, if any. */
  readonly onFailure: (wanted: FrameXmlOptionsWindow | undefined) => void;
}

export interface FrameXmlLazyOptionsOwner extends FrameXmlOptionsOwner {
  /** The first load's measurement, once it has settled. */
  readonly result: FrameXmlOptionsChainResult | undefined;
  /** Settles when the first load (and its show) has finished; undefined before the first open. */
  readonly settled: Promise<void> | undefined;
}

function showSource(window: FrameXmlOptionsWindow, fromGameMenu: boolean): string {
  const frame = window === "video" ? "VideoOptionsFrame" : window === "audio" ? "AudioOptionsFrame" : "InterfaceOptionsFrame";
  // GameMenuFrame's own buttons: ShowUIPanel, then the menu to return to (GameMenuFrame.xml:58-91).
  const lastFrame = fromGameMenu ? `${frame}.lastFrame = GameMenuFrame` : "";
  const category = window === "webclient" ? `InterfaceOptionsFrame_OpenToCategory(${FRAMEXML_OPTIONS_WEBCLIENT_PANEL})` : "";
  return `ShowUIPanel(${frame}) ${lastFrame} ${category}`;
}

export function createLazyFrameXmlOptionsOwner(
  boot: FrameXmlBoot,
  renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync" | "elementFor">,
  spec: FrameXmlOptionsOwnerSpec,
): FrameXmlLazyOptionsOwner {
  let frames: FrameXmlOptionsFrames | undefined;
  let pending: Promise<void> | undefined;
  let wanted: { readonly window: FrameXmlOptionsWindow; readonly fromGameMenu: boolean } | undefined;
  let failed = false;
  let disposed = false;
  let result: FrameXmlOptionsChainResult | undefined;
  const all = (): readonly FrameXmlFrame[] => frames ? [frames.video, frames.audio, frames.interface] : [];
  const openFrames = (): readonly FrameXmlFrame[] => all().filter((frame) => boot.bridge.isVisible(frame));
  const fail = (): void => {
    if (failed || disposed) return;
    failed = true;
    const waiting = wanted?.window;
    wanted = undefined;
    for (const frame of openFrames()) {
      try { boot.bridge.Hide(frame); } catch { /* the native window takes over either way */ }
    }
    try { spec.onFailure(waiting); } catch { /* the route already answers false */ }
  };
  const cancel = (frame: FrameXmlFrame): void => {
    boot.bridge.runInMutationBatch(() => { boot.vm.executeReported(`${frame.name}Cancel:Click()`, "@webclient/options-cancel"); });
    if (boot.bridge.isVisible(frame)) boot.bridge.Hide(frame);
  };
  const show = (request: { readonly window: FrameXmlOptionsWindow; readonly fromGameMenu: boolean }): void => {
    wanted = undefined;
    const target = request.window === "video" ? frames!.video : request.window === "audio" ? frames!.audio : frames!.interface;
    const errors = errorTotal(boot);
    // One options frame at a time, as the center UI panel slot keeps it in the client.
    for (const frame of openFrames()) if (frame !== target) cancel(frame);
    boot.bridge.runInMutationBatch(() => {
      boot.vm.executeReported(showSource(request.window, request.fromGameMenu), "@webclient/options-show");
    });
    if (errorTotal(boot) !== errors) {
      // The player is waiting for this window: the native one opens in its place.
      wanted = request;
      fail();
    }
  };
  const load = async (): Promise<void> => {
    try {
      result = await loadFrameXmlOptionsChain(boot, spec.host, () => disposed);
      if (disposed) return;
      if (!result.ok) {
        console.warn(`[FrameXML options] not loaded: ${result.message ?? "unknown"}`);
        fail();
        return;
      }
      // Three tasks rather than one: the first reconciliation creates the DOM for ~2,700 widgets.
      await nextTask();
      if (disposed) return;
      if (result.roots.length > 0) renderer.addRoots(result.roots);
      renderer.sync();
      await nextTask();
      if (disposed) return;
      frames = frameXmlOptionsGate(boot, renderer);
      if (!frames) {
        console.warn("[FrameXML options] gate refused the loaded frames");
        fail();
        return;
      }
      if (wanted) show(wanted);
    } catch (error) {
      console.warn(`[FrameXML options] ${String(error)}`);
      fail();
    }
  };
  return {
    get failed() { return failed; },
    get result() { return result; },
    get settled() { return pending; },
    isOpen: () => !disposed && !failed && (frames ? openFrames().length > 0 : wanted !== undefined),
    open: (window, fromGameMenu) => {
      if (disposed || failed) return false;
      wanted = { window, fromGameMenu };
      if (frames) {
        show(wanted);
        return !failed;
      }
      pending ??= load();
      return true;
    },
    close: () => {
      const waiting = wanted !== undefined && !frames;
      wanted = undefined;
      if (disposed || failed || !frames) return waiting;
      const open = openFrames();
      for (const frame of open) cancel(frame);
      return open.length > 0;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      wanted = undefined;
      for (const frame of openFrames()) {
        try { boot.bridge.Hide(frame); } catch { /* teardown */ }
      }
      frames = undefined;
    },
  };
}

// ---- the extra action bars -----------------------------------------------------------------------

/**
 * The four extra bars' uvars (SHOW_MULTI_ACTIONBAR_1..4), from the browser settings, as the client
 * restores them before PLAYER_ENTERING_WORLD. MultiActionBars.lua reads only these globals and
 * nothing set them here, so with the stock HUD the extra bars never showed whatever the setting
 * said. Applied now and whenever the settings change (the native window, the stock Action Bars
 * panel through SetActionBarToggles), and only when a value differs, with the stock updates
 * InterfaceOptions_UpdateMultiActionBars itself runs.
 */
const ACTION_BARS_SOURCE = `
local b1, b2, b3, b4 = GetActionBarToggles()
local function on(value) if value then return "1" end end
b1, b2, b3, b4 = on(b1), on(b2), on(b3), on(b4)
local function current(value) if value and value ~= "0" then return "1" end end
if current(SHOW_MULTI_ACTIONBAR_1) ~= b1 or current(SHOW_MULTI_ACTIONBAR_2) ~= b2
  or current(SHOW_MULTI_ACTIONBAR_3) ~= b3 or current(SHOW_MULTI_ACTIONBAR_4) ~= b4 then
  SHOW_MULTI_ACTIONBAR_1, SHOW_MULTI_ACTIONBAR_2, SHOW_MULTI_ACTIONBAR_3, SHOW_MULTI_ACTIONBAR_4 = b1, b2, b3, b4
  MultiActionBar_Update()
  UIParent_ManageFramePositions()
end
`;

export function installFrameXmlOptionsActionBars(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  watchSettings?: (listener: () => void) => () => void,
): () => void {
  if (!boot.bridge.getFrame("MultiBarBottomLeft")) return () => {};
  // Compiled once: every settings change (a slider drag included) runs it.
  const update = boot.vm.compileFunction(ACTION_BARS_SOURCE, "webclient/options-action-bars", []);
  if (!update) return () => {};
  let stopped = false;
  const apply = (): void => {
    if (!stopped) boot.bridge.runInMutationBatch(() => { boot.vm.call(update, [], 0); });
  };
  apply();
  const stop = watchSettings?.(apply);
  return (): void => {
    if (stopped) return;
    stopped = true;
    stop?.();
    try { boot.vm.release(update); } catch { /* the VM may already be closed */ }
  };
}

/** The world mount's one call: the lazy owner, published, and the extra bars following the settings. */
export function mountFrameXmlOptions(
  boot: FrameXmlBoot,
  renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync" | "elementFor">,
  host: FrameXmlOptionsHost & {
    /** Open the native window on the section the stock frame would have shown. */
    openNative(window: FrameXmlOptionsWindow): void;
    watchSettings?(listener: () => void): () => void;
  },
): () => void {
  const owner = createLazyFrameXmlOptionsOwner(boot, renderer, {
    host,
    onFailure: (wanted) => { if (wanted) host.openNative(wanted); },
  });
  const unpublish = publishFrameXmlOptions(owner);
  const stopBars = installFrameXmlOptionsActionBars(boot, host.watchSettings ? (listener) => host.watchSettings!(listener) : undefined);
  return (): void => {
    stopBars();
    unpublish();
  };
}
