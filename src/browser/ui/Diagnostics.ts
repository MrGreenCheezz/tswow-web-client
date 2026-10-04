import { game } from "../game/Context.js";
import { gatewayOrigin as defaultGatewayOrigin } from "../Environment.js";
import { bootPatchGeneration, describePatchState, patchChainChanged, readPatchStatus } from "../PatchChainChanged.js";
import { STAND_IN_REASON_LABELS, standInSummary } from "../StandIn.js";
import {
  capsuleReasons, capsuleStatus, customPacketList, customPacketModules, customPacketStatus, customPacketWarnings, diagnosticsPackets,
  diagnosticsState, diagnosticsTabs, diagnosticsWindow, diagnosticsWindows,
  modulePatchExample, moduleWindowBuilder, moduleWindowExample, moduleWindowList, moduleWindowProblems,
  moduleWindowStatus, moduleWindowStudio,
  unhandledOpcodeList, unhandledStatus,
} from "./Dom.js";
import { Tabs } from "./Widgets.js";
import { packetsChanged, packetsView, type PacketsCounters } from "./PacketsModel.js";
import { buildPacketDiagnosticsReport } from "./PacketDiagnosticsReport.js";
import { drawPacketsTab } from "./PacketsTab.js";
import { patchRegistry, windowRegistry } from "./WindowRegistry.js";
import { moduleWindowHost, setModuleStyle } from "./ModuleClient.js";
import type { ModuleLoader } from "./ModuleLoader.js";
import {
  drawWindowsTab, loadModulePatch, loadModuleWindow, windowsSignature, windowsView,
} from "./WindowsTab.js";
import { registerWindowBuilderAction, toggleWindowBuilder } from "./WindowBuilder.js";

/** The diagnostics window: which opcodes the world loop dropped, which units are still pills, and what the modules are saying. */

/**
 * How many units are stand-in capsules right now, and what stopped each of them.
 *
 * Every live report of this client's render faults so far has said "there is a green pill where
 * the innkeeper should be", which names the symptom and nothing else. There are five ways to end
 * up there, three of them permanent after a single failure, and the fix for each is a different
 * slice — so this window prints the reason and the display id, and the next report can be acted on.
 */
export function showStandIns(): void {
  const report = game.renderer?.standInReport();
  if (!report) {
    capsuleStatus.className = "muted";
    capsuleStatus.textContent = "Капсулы: рендер ещё не запущен.";
    capsuleReasons.replaceChildren();
    return;
  }
  capsuleStatus.className = report.total > 0 || report.stale > 0 ? "error" : "muted";
  capsuleStatus.textContent = standInSummary(report);
  capsuleReasons.replaceChildren(
    ...report.samples.map((sample) => {
      const row = document.createElement("p");
      const model = sample.model ? ` · ${sample.model}` : "";
      // Which of the two a sample is matters more than the reason does: a pill is a unit nobody
      // can identify, and a stale model is a unit identified as the wrong thing.
      const wearing = sample.wearing === "model" ? " · в прежней модели" : "";
      row.textContent = `display ${sample.displayId} · ${STAND_IN_REASON_LABELS[sample.reason]}${wearing}${model}`;
      return row;
    }),
  );
}

/** The «Патчи» line; built on first use, above the capsule counter. */
let patchLine: HTMLParagraphElement | undefined;
let patchCheckedAt = Number.NEGATIVE_INFINITY;
let patchPending = false;
/**
 * The full answer runs `tools/patch-status.mjs` in a gateway child (the gateway memoises it for 30 s),
 * so a window that is refreshed on every packet asks at most this often.
 */
const PATCH_STATUS_INTERVAL_MS = 10_000;

/**
 * Which client patch generation this page booted with, against what the gateway serves now.
 *
 * After a TSWoW build the two part ways, and the rest of this window cannot say why a texture is
 * white or the interface would not mount: the gateway is refusing client-media requests (409)
 * until it is restarted, or it has been restarted and this page is still the old one. The same
 * sentence as the banner, plus the gateway's one-line summary of the lettered patches and TSAddons.
 */
export function showPatchStatus(): void {
  if (!patchLine) {
    patchLine = document.createElement("p");
    patchLine.id = "patch-status";
    patchLine.className = "muted";
    patchLine.textContent = "Патчи: ожидание шлюза…";
    capsuleStatus.before(patchLine);
  }
  if (diagnosticsWindow.hidden || patchPending) return;
  const now = performance.now();
  if (now - patchCheckedAt < PATCH_STATUS_INTERVAL_MS) return;
  patchPending = true;
  patchCheckedAt = now;
  const line = patchLine;
  void readPatchStatus(game.gatewayOrigin ?? defaultGatewayOrigin(window.location)).then((read) => {
    const description = describePatchState(bootPatchGeneration(), read, { pageLatched: patchChainChanged() });
    const summary = read.kind === "ok" ? read.status.client?.summaryLine : undefined;
    line.className = description.tone === "error" || description.tone === "warning" ? "error" : "muted";
    const sentence = description.text.charAt(0).toLowerCase() + description.text.slice(1);
    line.textContent = `Патчи: ${sentence}${typeof summary === "string" && summary ? ` · ${summary}` : ""}`;
  }).finally(() => { patchPending = false; });
}

// Every opcode the world loop could not route. `webclientUnhandledOpcodes()` in the console
// dumps the same list with payload samples, which is the seed for the phase 10 replay corpus.
//
// The capsule counter is refreshed from here as well, because this is the one function every path
// that opens or refreshes the diagnostics window already calls.
export function showUnhandledOpcodes(): void {
  showStandIns();
  showPatchStatus();
  const summary = game.world?.unhandledOpcodes.summary() ?? [];
  const packetErrors = game.world?.packetErrors.summary() ?? [];
  const packetErrorCount = game.world?.packetErrors.count ?? 0;
  const missing = summary.filter((entry) => entry.count > 0);
  // The object-update counters (5.26) and the syncs that found no path (5.02): an update packet
  // that broke part-way is also in the error list above, but only here is what it cost counted.
  const state = game.world?.state;
  const updateFailures = state?.updateBlockFailures ?? 0;
  const syncDropped = state?.splineSyncDropped ?? 0;
  const worldNote = updateFailures || syncDropped
    ? ` · сбоев обновлений объектов: ${updateFailures} (потеряно блоков: ${state?.updateBlocksLost ?? 0})`
      + ` · синхронизаций сплайна без пути: ${syncDropped}`
    : "";
  // Accepted on purpose without an effect (5.29, world/IgnoredOpcodes.ts): counted, not hidden.
  const ignored = game.world?.ignoredOpcodes.counts();
  const ignoredTotal = ignored ? ignored["by-design"] + ignored.planned + ignored.unplanned + ignored.unregistered : 0;
  const ignoredNote = ignored && ignoredTotal
    ? ` · принято без эффекта: по замыслу ${ignored["by-design"]}, запланировано ${ignored.planned}, без пункта плана ${ignored.unplanned + ignored.unregistered}`
    : "";
  unhandledStatus.className = missing.length || packetErrorCount || updateFailures ? "error" : "muted";
  unhandledStatus.textContent = missing.length || packetErrorCount
    ? `Опкоды без обработчика: ${missing.length} (${missing.reduce((total, entry) => total + entry.count, 0)} пакетов) · ошибки пакетов: ${packetErrorCount}${worldNote}${ignoredNote}`
    : `Опкоды: необработанных пакетов и ошибок пока нет.${worldNote}${ignoredNote}`;
  unhandledOpcodeList.replaceChildren(
    ...packetErrors.slice(0, 20).map((entry) => {
      const row = document.createElement("p");
      row.className = "error";
      row.textContent = `Ошибка ${entry.opcode} ${entry.name} · ${entry.count} раз · ${entry.message}`;
      return row;
    }),
    ...summary.slice(0, 20).map((entry) => {
      const row = document.createElement("p");
      row.className = entry.count ? "" : "muted";
      const dropped = entry.droppedDuringLogin ? ` · при логине ${entry.droppedDuringLogin}` : "";
      row.textContent = `${entry.opcode} ${entry.name} · ${entry.count}${dropped} · ${entry.bytes} Б`;
      return row;
    }),
  );
  // The two lists move together: a custom packet lands in both, once as `CMSG_EMOTE` above and
  // once under its own inner opcode below, and seeing one change without the other reads as a
  // packet that arrived twice.
  showCustomPackets();
}

/**
 * The «Пакеты» pane: what the tswow modules on this realm are saying.
 *
 * Separate from the list above because a custom packet is counted there exactly once, as
 * `CMSG_EMOTE`, whichever module message it was — the number that identifies it is inside the
 * body, past the six-byte header. Which schema claims which opcode, what the last message decoded
 * to, and the raw bytes of anything unclaimed are shown here or nowhere.
 */
export function showCustomPackets(): void {
  const world = game.world;
  const loader = game.modules;
  drawPacketsTab(
    {
      status: customPacketStatus, modules: customPacketModules,
      list: customPacketList, warnings: customPacketWarnings,
    },
    packetsView({
      opcodes: world?.customPackets.summary() ?? [],
      transportWarnings: world?.customPacketBuffer.warnings ?? [],
      problems: world?.customPackets.problems ?? [],
      files: loader?.files ?? [],
      loadProblems: loader?.problems ?? [],
    }),
  );
}

/** What {@link updateCustomPackets} last drew, or nothing while the pane has never been drawn. */
let drawn: PacketsCounters | undefined;

/**
 * The pane, once a frame, and only while it is on screen.
 *
 * It needs its own cue because it is the one list here that nothing else announces: the
 * unhandled-opcode list beside it is redrawn when `onUnhandledOpcodesChanged` fires, which is once
 * per *newly seen* opcode, and a message on an opcode a schema claims is never filed as unhandled
 * at all. So after the first packet the counters this pane exists to show stood still, and the way
 * to see the second one was to close the window and open it again.
 *
 * Guarded on both the window and the pane, the way `showWorldState` guards its cards: a pane that
 * is not being looked at costs one comparison a frame. The comparison is against counters that
 * only ever go up, so «nothing moved» is exact rather than a guess, and a busy module redraws at
 * most once a frame.
 */
export function updateCustomPackets(): void {
  if (diagnosticsWindow.hidden || diagnosticsPackets.hidden) return;
  const world = game.world;
  const loader = game.modules;
  const now: PacketsCounters = {
    revision: world?.customPackets.revision ?? 0,
    warnings: world?.customPacketBuffer.warningCount ?? 0,
    files: loader?.files.length ?? 0,
    problems: loader?.problems.length ?? 0,
  };
  if (!packetsChanged(drawn, now)) return;
  drawn = now;
  showCustomPackets();
}

/**
 * The strip that switches the window's three panes.
 *
 * The kit's `Tabs` rather than a hand-rolled strip: three windows had already grown one of those
 * before it was worth writing once, and this one gets the accessibility for free.
 */
const tabs = new Tabs();
tabs.set([
  { id: "state", title: "Состояние" },
  { id: "packets", title: "Пакеты" },
  { id: "windows", title: "Окна" },
], "state");
tabs.onSelect = (id) => {
  diagnosticsState.hidden = id !== "state";
  diagnosticsPackets.hidden = id !== "packets";
  diagnosticsWindows.hidden = id !== "windows";
  if (id === "packets") showCustomPackets();
  if (id === "windows") showModuleWindows();
};
diagnosticsTabs.replaceChildren(tabs.root);

/* ---------------------------------------------------------------------------------------------
 * The «Окна» pane
 * ------------------------------------------------------------------------------------------- */

/** Whatever the last parse had to say. Kept here because a window that failed has no handle. */
const windowProblems: string[] = [];

export function showModuleWindows(): void {
  drawWindowsTab(
    { status: moduleWindowStatus, list: moduleWindowList, problems: moduleWindowProblems },
    windowsView(
      windowRegistry.list(),
      [...windowProblems, ...(game.modules?.problems ?? [])],
      patchRegistry.list(),
    ),
  );
}

/**
 * Opens one of the two example definitions kept beside the client.
 *
 * `examples/module-example/ui/` is served as it stands by the dev server, so this needs no module
 * on disk, no livescript and no gateway route — which is the whole point: the renderer is checked
 * against the owner's own screen before the loader that will fetch it exists.
 */
async function openExample(file: string, module: string): Promise<void> {
  const result = await loadModuleWindow(
    [`/examples/module-example/ui/${file}`, `${game.gatewayOrigin ?? ""}/modules/ui/${module}/${file}`],
    { module, registry: windowRegistry, host: moduleWindowHost() },
  );
  windowProblems.length = 0;
  windowProblems.push(...result.problems);
  showModuleWindows();
}

/** The example patch while it is on, so taking it off does not depend on the id in the file. */
let examplePatch: string | undefined;

/** The module name the example is loaded under, and so the `<style>` node it writes and clears. */
const EXAMPLE_PATCH_MODULE = "example";

/**
 * The example patch, applied and taken off again by the same button (М7).
 *
 * A toggle rather than an «apply», because the half of a patch that is worth watching is the half
 * that undoes it: pressing it twice has to leave the target frame exactly as it was, and that is
 * something to look at rather than only to assert on a fake document.
 *
 * The stylesheet goes on and comes off with it. Without that the button did two of the file's three
 * edits — the line went, the button appeared — and the third, the re-skin, put a class on the frame
 * with no rule anywhere behind it, so the one thing the plan's «перекрашивает окно» names showed
 * nothing at all.
 */
async function togglePatchExample(): Promise<void> {
  windowProblems.length = 0;
  if (examplePatch !== undefined) {
    patchRegistry.remove(examplePatch);
    setModuleStyle(EXAMPLE_PATCH_MODULE, "");
    examplePatch = undefined;
    showModuleWindows();
    return;
  }
  const module = EXAMPLE_PATCH_MODULE;
  const file = "target-extras.json";
  const result = await loadModulePatch(
    [`/examples/module-example/ui/${file}`, `${game.gatewayOrigin ?? ""}/modules/ui/${module}/${file}`],
    {
      module, registry: patchRegistry, windows: windowRegistry, host: moduleWindowHost(),
      setStyle: setModuleStyle,
    },
  );
  examplePatch = result.patch?.id;
  windowProblems.push(...result.problems);
  showModuleWindows();
}

moduleWindowExample.addEventListener("click", () => { void openExample("example.json", "example"); });
moduleWindowStudio.addEventListener("click", () => { void openExample("proverochnyy-ekran.json", "test"); });
modulePatchExample.addEventListener("click", () => { void togglePatchExample(); });
moduleWindowBuilder.addEventListener("click", () => { toggleWindowBuilder(); });
// Offered from here rather than from the editor's own module scope, so that «есть такая команда»
// does not depend on somebody having pressed the button: this file is loaded by the render loop on
// every session, and the editor's panel is still built only on the first press. The action ships
// unbound — the player gives it a key in the bindings window if they want one.
registerWindowBuilderAction();

/** What the pane last drew, so a live window's counters do not rebuild it sixty times a second. */
let drawnWindows = "";
/**
 * The loader this pane has asked to watch its files, or nothing.
 *
 * The *loader* and not a flag, because there is a second way this can change: a second login
 * replaces `game.modules` while the pane is still open, and a flag would leave the new loader
 * unwatched for as long as nobody closed the window.
 */
let watchedModules: ModuleLoader | undefined;

/**
 * The «Окна» pane's once-a-frame cue, guarded exactly as the «Пакеты» pane's is.
 *
 * It also owns the hot-reload poll, and that is deliberate: re-reading the index every two seconds
 * is a directory scan on the other side of a socket, and the one moment it is worth paying for is
 * while somebody is looking at the pane that lists what was loaded. Opening the pane asks for one
 * poll immediately, so an author who has just saved a file does not sit out the first interval.
 */
export function updateModuleWindowList(): void {
  const watching = !diagnosticsWindow.hidden && !diagnosticsWindows.hidden;
  const wanted = watching ? game.modules : undefined;
  if (wanted !== watchedModules) {
    watchedModules?.watch(false);
    watchedModules = wanted;
    if (wanted) {
      wanted.watch(true);
      void wanted.poll();
    }
  }
  if (!watching) return;
  const live = windowRegistry.list();
  const signature = windowsSignature(
    live,
    windowProblems.length + (game.modules?.problems.length ?? 0),
    patchRegistry.list(),
  );
  if (signature === drawnWindows) return;
  drawnWindows = signature;
  showModuleWindows();
}

// Saves shareable traffic metadata. Raw samples, decoded module values and free-form errors stay
// in local diagnostics memory because any of them can contain chat, account or session data.
export function saveUnhandledOpcodeReport(): void {
  const report = buildPacketDiagnosticsReport(game.world);
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, undefined, 1)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `packet-diagnostics-${report.recordedAt.replaceAll(":", "-").slice(0, 19)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
