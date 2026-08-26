/**
 * The «Окна» pane of the diagnostics window, and the two buttons that open a module window with no
 * module on disk.
 *
 * A renderer nobody can look at is a renderer nobody can check. Until М6 brings the gateway route
 * and the loader, the only way to see one of these windows would be to write a livescript, and the
 * point of this pane is that the answer to "does the renderer draw the owner's screen" is a button
 * press rather than a server round trip.
 *
 * Hosts are arguments rather than imports from `Dom.ts`, for the reason `PacketsTab.ts` gives: that
 * file resolves 193 elements the moment it loads, and anything importing it can only run inside the
 * real page.
 */

import {
  parseWindowDefinition, parseWindowPatch, patchWidgets, walkWindowWidgets,
  type ParsedPatch, type ParsedWindow,
} from "./WindowSchema.js";
import { applyWindowPatch, type LivePatch } from "./WindowPatch.js";
import { renderWindow, type LiveWindow, type WindowRenderHost } from "./WindowRender.js";
import { checkWindowPatch, patchTargetProblems } from "./WindowActions.js";
import { prefixModuleCss } from "./ModuleLoader.js";
import { FILLABLE_SLOTS, SKINNABLE_WINDOWS, SLOT_NAMES } from "./Slots.js";
import type { PatchRegistry, WindowRegistry } from "./WindowRegistry.js";

export interface WindowsTabHosts {
  readonly status: HTMLElement;
  readonly list: HTMLElement;
  readonly problems: HTMLElement;
}

export interface ModuleWindowRow {
  readonly id: string;
  readonly module: string;
  readonly title: string;
  readonly open: boolean;
  readonly widgets: number;
  readonly counts: string;
}

export interface WindowsView {
  readonly status: string;
  readonly statusKind: "muted" | "success" | "error";
  readonly rows: readonly ModuleWindowRow[];
  readonly problems: readonly string[];
}

/** What the pane says, worked out from the registry alone so it can be checked without a document. */
export function windowsView(
  windows: readonly LiveWindow[],
  problems: readonly string[],
  patches: readonly LivePatch[] = [],
): WindowsView {
  const open = windows.filter((window) => window.visible()).length;
  const rows = windows.map((window): ModuleWindowRow => ({
    id: window.id,
    module: window.module,
    title: `${window.module}/${window.id}`,
    open: window.visible(),
    widgets: walkWindowWidgets(window.definition.screen).length,
    // The two numbers that say whether the once-a-frame pass is doing its job: how many
    // expressions the last tick evaluated, and how many of them actually moved. A window whose
    // second number never drops to zero is a window rewriting the DOM for nothing.
    counts: `выражений ${window.stats.evaluated}, изменилось ${window.stats.changed}`
      + `, нажатий ${window.actionPresses.asked} (выполнено ${window.actionPresses.ran})`,
  }));
  // A patch reads as a window with no window: its «open» is whether any built-in has actually given
  // it a place yet, which is the first thing an author asks — a patch of `quest-log/entry-actions`
  // is live and has nowhere to be until the log is opened, and a row saying «мест 0» says so.
  rows.push(...patches.map((patch): ModuleWindowRow => ({
    id: patch.id,
    module: patch.module,
    title: `${patch.module}/${patch.id} → ${patch.target}`,
    open: patch.filled > 0,
    widgets: patchWidgets(patch.definition).length,
    counts: `мест ${patch.filled}, выражений ${patch.stats.evaluated}, изменилось ${patch.stats.changed}`
      + `, нажатий ${patch.actionPresses.asked} (выполнено ${patch.actionPresses.ran})`,
  })));
  if (rows.length === 0) {
    return {
      status: "Окна модулей: ни одного окна не загружено. «Показать пример» рисует окно из"
        + " examples/module-example/ui без модуля на диске.",
      statusKind: "muted",
      rows,
      problems,
    };
  }
  const counted = patches.length
    ? `Окна модулей: ${windows.length}, открыто ${open}; правок ${patches.length}.`
    : `Окна модулей: ${windows.length}, открыто ${open}.`;
  return {
    // While this pane is open the loader re-reads the module index every two seconds, so a file
    // saved in the studio appears here without a page reload — said out loud, because the only
    // other way to find that out is to wait and notice.
    status: `${counted} Пока вкладка открыта, изменённые файлы модулей перечитываются каждые 2 с.`,
    statusKind: problems.length ? "error" : "success",
    rows,
    problems,
  };
}

function line(className: string, text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

export function drawWindowsTab(hosts: WindowsTabHosts, view: WindowsView): void {
  hosts.status.className = view.statusKind === "muted" ? "muted" : view.statusKind;
  hosts.status.textContent = view.status;
  hosts.list.replaceChildren(...view.rows.map((row) => {
    const node = document.createElement("div");
    node.className = row.open ? "module-window-row is-open" : "module-window-row";
    node.dataset["window"] = row.id;
    node.append(
      line("module-window-title", `${row.title} · ${row.open ? "открыто" : "закрыто"} · виджетов ${row.widgets}`),
      line("muted", row.counts),
    );
    return node;
  }));
  hosts.problems.replaceChildren(...view.problems.map((text) => line("error", text)));
}

/**
 * A signature of everything the pane draws, so it is redrawn when it changed and not before.
 *
 * The press counters are in it and `stats` is not, and the line between the two is the point. A
 * press is something the player did, and saying what happened to it is this pane's whole job until
 * М6 runs actions — a signature without it left «нажатий 0» standing after the button had been
 * pressed, which reads as "the press was not even noticed" rather than "noticed and not run".
 * `stats` moves on nearly every frame, so putting it here would redraw the pane sixty times a
 * second and there would be no guard left at all.
 */
export function windowsSignature(
  windows: readonly LiveWindow[],
  problems: number,
  patches: readonly LivePatch[] = [],
): string {
  const one = (window: LiveWindow): string =>
    `${window.id}:${window.visible() ? 1 : 0}:${window.actionPresses.asked}:${window.actionPresses.ran}`;
  // A patch's own moving number is how many places it currently has: opening the quest log gives it
  // twenty-five at once, and the pane has to redraw when that happens.
  const onePatch = (patch: LivePatch): string =>
    `${patch.id}:${patch.filled}:${patch.actionPresses.asked}:${patch.actionPresses.ran}`;
  return `${problems}|${windows.map(one).join(",")}|${patches.map(onePatch).join(",")}`;
}

/* ---------------------------------------------------------------------------------------------
 * Opening one without a module
 * ------------------------------------------------------------------------------------------- */

export interface WindowLoadResult {
  readonly window?: LiveWindow | undefined;
  readonly problems: readonly string[];
}

/**
 * Fetches a definition, parses it, draws it and registers it — the loader's own order.
 *
 * Several URLs rather than one, tried in turn, because there are two places the same file lives:
 * `examples/module-example/ui/…` beside the client (which the dev server hands over as it stands)
 * and `/modules/ui/<mod>/<file>` from the gateway, which is М6's route and does not exist yet.
 * Trying both means this button keeps working the day the route lands, and the failure message
 * names every address it tried rather than the last one.
 */
export async function loadModuleWindow(
  urls: readonly string[],
  options: { readonly module: string; readonly registry: WindowRegistry<LiveWindow>; readonly host: WindowRenderHost },
): Promise<WindowLoadResult> {
  const fetched = await fetchFirst(urls);
  if (!fetched.found) return { problems: fetched.problems };
  const problems = [...fetched.problems];
  const raw = fetched.raw;

  const parsed = parseWindowDefinition(raw, { module: options.module });
  problems.push(...parsed.problems);
  if (!parsed.window) return { problems };
  // Every problem the parse found is kept even when the window loaded: «замечание, окно грузится»
  // is a real outcome of `WindowSchema`'s three levels, and the pane is where an author reads it.
  return { window: openParsedWindow(parsed.window, options), problems };
}

/** Draws and registers one already-parsed definition, replacing whatever held its id before. */
export function openParsedWindow(
  definition: ParsedWindow,
  options: { readonly registry: WindowRegistry<LiveWindow>; readonly host: WindowRenderHost },
): LiveWindow {
  // Replaced rather than refused: pressing «Показать пример» twice has to give one window, and
  // this is the same rebuild-in-place М6's hot reload does — the element id is unchanged, so
  // `GameWindowManager` puts the new one back where the player dragged the old one.
  options.registry.remove(definition.id);
  const live = renderWindow(definition, options.host);
  options.registry.register(live);
  live.show();
  return live;
}

/** The first of several addresses that answers, with what the ones before it said. */
async function fetchFirst(urls: readonly string[]): Promise<{ raw: unknown; found: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`ответ ${response.status}`);
      return { raw: await response.json(), found: true, problems };
    } catch (error) {
      problems.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { raw: undefined, found: false, problems };
}

/* ---------------------------------------------------------------------------------------------
 * A patch, without a module either — М7
 * ------------------------------------------------------------------------------------------- */

export interface PatchLoadResult {
  readonly patch?: LivePatch | undefined;
  readonly problems: readonly string[];
}

/**
 * Fetches a patch file, checks it against this client's slots and applies it.
 *
 * The same order and the same checks the loader makes, so that the button in the diagnostics pane
 * proves the road a module's own file will take rather than a shortcut beside it: a patch naming a
 * slot this client has not got is refused here exactly as it would be on entering the world.
 *
 * The stylesheet included, which it was not at first. A patch does three things — hides, adds,
 * re-skins — and the re-skin is a class plus a `data-module` mark with a module's own rules behind
 * it; without the rules the button applied two thirds of the file and the third that «перекрашивает
 * окно» changed no pixel. `setStyle` is a seam and not an import so that this stays testable on the
 * fake document, and so that a caller with no head to write into can leave it out.
 */
export async function loadModulePatch(
  urls: readonly string[],
  options: {
    readonly module: string;
    readonly registry: PatchRegistry<LivePatch>;
    readonly windows: WindowRegistry<LiveWindow>;
    readonly host: WindowRenderHost;
    setStyle?(module: string, css: string): void;
  },
): Promise<PatchLoadResult> {
  const fetched = await fetchFirst(urls);
  if (!fetched.found) return { problems: fetched.problems };
  const problems = [...fetched.problems];

  const parsed = parseWindowPatch(fetched.raw, { module: options.module });
  problems.push(...parsed.problems);
  if (!parsed.patch) return { problems };
  const slots = {
    slotNames: new Set(SLOT_NAMES),
    fillableSlots: new Set(FILLABLE_SLOTS),
    skinnableWindows: new Set(SKINNABLE_WINDOWS),
  };
  const refusals = patchTargetProblems(parsed.patch, slots);
  problems.push(...refusals);
  if (refusals.length > 0) return { problems };
  // The action checks are notes here as they are in the loader — a `sendCustom` naming a schema
  // that is not loaded is the ordinary case in this pane, since nothing has loaded the module's
  // message file, and saying so is the point rather than a reason to refuse.
  problems.push(...checkWindowPatch(parsed.patch, {
    ...slots,
    windowIds: new Set(options.windows.list().map((window) => window.id)),
    message: () => undefined,
    soundKits: new Set<string>(),
  }));
  // Written even when the file carries no `css`, because pressing the button on a second file has
  // to take the first one's rules off: one node per module, and the module here is always the same.
  const scoped = prefixModuleCss(parsed.patch.css, options.module);
  problems.push(...scoped.problems.map((problem) => `${options.module}/${parsed.patch?.id}: ${problem}`));
  options.setStyle?.(options.module, scoped.css);
  return { patch: applyParsedPatch(parsed.patch, options), problems };
}

/** Applies one already-parsed patch, replacing whatever held its id before. */
export function applyParsedPatch(
  patch: ParsedPatch,
  options: { readonly registry: PatchRegistry<LivePatch>; readonly host: WindowRenderHost },
): LivePatch {
  options.registry.remove(patch.id);
  const live = applyWindowPatch(patch, options.host);
  options.registry.register(live);
  return live;
}
