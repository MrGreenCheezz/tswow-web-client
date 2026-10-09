import { diagnosticsWindow, gameMenuToggle, gameWindows } from "./Dom.js";
import { Panel } from "./Widgets.js";
import { toggleKeyBindingsWindow } from "./KeyBindings.js";
import { openGuildWindow } from "./Guild.js";
import { openGuildBank } from "./GuildBank.js";
import { toggleCalendar } from "./Calendar.js";
import { toggleSocialPanel } from "./SocialPanel.js";
import { toggleProfessionList } from "./Professions.js";
import { toggleLfgWindow } from "./Social.js";
import { toggleScoreboard } from "./Scoreboard.js";
import { toggleArenaWindow } from "./ArenaWindow.js";
import { toggleSettingsWindow } from "./Settings.js";
import { toggleMacroWindow } from "./Macros.js";
import { toggleGmTickets } from "./GmTickets.js";
import { game } from "../game/Context.js";
import { confirmPanel } from "./Widgets.js";
import { showUnhandledOpcodes } from "./Diagnostics.js";
import { playUiSound } from "../game/GameSounds.js";
import type { WorldClient } from "../../world/WorldClient.js";
import {
  closeFrameXmlGameMenu,
  frameXmlGameMenuOpen,
  toggleFrameXmlGameMenu,
} from "../framexml/FrameXmlGameMenuController.js";
import { frameXmlPopupsPublished, registerFrameXmlQuitIntent } from "../framexml/FrameXmlPopupsController.js";
import { logoutCountdownText, logoutRemaining } from "./LogoutCountdown.js";

/**
 * What Escape opens when nothing else is open.
 *
 * Written to be the measure of the widget kit: the page markup says nothing about this window, and
 * building it from scratch — draggable, remembered where it was put, closable — is the code below.
 * The bindings window hangs off it the way the original client hangs its own off Escape.
 */
let menu: Panel | undefined;
let logoutMenuButton: HTMLButtonElement | undefined;
let logoutCountdown: Panel | undefined;
let logoutCancelButton: HTMLButtonElement | undefined;
let logoutCountdownWorld: WorldClient | undefined;
let logoutCancelRequested = false;
/** 4.13: when the granted response arrived (performance.now), the clock the countdown runs from. */
let logoutStartedAt: number | undefined;
/** The visible count, and a screen-reader copy that changes only every five seconds. */
let logoutCountdownLine: HTMLElement | undefined;
let logoutCountdownAnnounce: HTMLElement | undefined;
let logoutCountdownTimer: ReturnType<typeof setInterval> | undefined;
/** How often the count is redrawn: a quarter second keeps `ceil` on the right second. */
const LOGOUT_TICK_MS = 250;
const LOGOUT_ANNOUNCE_EVERY_S = 5;

/** Writes the line for the time left: the stock CAMP/QUIT text, then «Ожидание сервера…» at 0. */
function tickLogoutCountdown(): void {
  // A panel taken down some other way stops its own clock on the next tick.
  if (!logoutCountdown?.visible) {
    stopLogoutTicks();
    return;
  }
  const world = logoutCountdownWorld;
  if (!world || logoutStartedAt === undefined || !logoutCountdownLine) return;
  const remaining = logoutRemaining(logoutStartedAt, performance.now(), world.logout?.instant === true);
  // The server decides the moment (SMSG_LOGOUT_COMPLETE); past the count the panel waits for it.
  const text = remaining === undefined || remaining <= 0
    ? "Ожидание сервера…"
    : logoutCountdownText(remaining, logoutIsQuit());
  if (logoutCountdownLine.textContent !== text) logoutCountdownLine.textContent = text;
  const announce = logoutCountdownAnnounce;
  if (announce && announce.textContent !== text && (remaining === undefined || remaining <= 0
    || remaining % LOGOUT_ANNOUNCE_EVERY_S === 0 || announce.textContent === "")) {
    announce.textContent = text;
  }
}

function startLogoutTicks(): void {
  tickLogoutCountdown();
  logoutCountdownTimer ??= setInterval(tickLogoutCountdown, LOGOUT_TICK_MS);
}

function stopLogoutTicks(): void {
  if (logoutCountdownTimer !== undefined) clearInterval(logoutCountdownTimer);
  logoutCountdownTimer = undefined;
}
/**
 * Stock «Выход из игры» (`Quit()`). A browser tab cannot quit the game; the nearest equivalent is
 * what quitting leaves behind — the character logged out by the server and the account signed
 * out. So Quit asks for the ordinary logout and, when the server completes it, leaves to the
 * account login screen (`leaveWorld("relogin")`) instead of the character list a plain Logout
 * returns to. `leave` is handed in by the FrameXML mount, which reaches the app layer lazily.
 */
let quitRequest: { readonly world: WorldClient; readonly leave: () => void } | undefined;

function syncLogoutMenuButton(): void {
  if (!logoutMenuButton) return;
  const pending = game.world?.logout?.result === 0 && !game.world.loggedOut;
  logoutMenuButton.textContent = pending ? logoutCancelRequested ? "Отмена выхода…" : "Отменить выход" : "Выйти из мира";
  logoutMenuButton.disabled = pending && logoutCancelRequested;
}

function cancelPendingLogout(): void {
  const world = game.world;
  if (!world || world.logout?.result !== 0 || world.loggedOut || logoutCancelRequested) return;
  logoutCancelRequested = true;
  world.cancelLogout();
  if (logoutCancelButton) {
    logoutCancelButton.disabled = true;
    logoutCancelButton.textContent = "Ожидание подтверждения…";
  }
  syncLogoutMenuButton();
}

/** The stock CAMP popup offers CancelLogout throughout the server's pending logout. */
export function updateLogoutPending(world: WorldClient, pending: boolean): void {
  // EnterWorld calls this first in its LOGOUT_CHANGED handler, before its own leaveWorld("logout"),
  // and WorldClient has already set `loggedOut` for a completion. Leaving here for a requested
  // Quit makes that handler's `game.world !== world` guard skip the character-list route.
  if (!pending && quitRequest?.world === world) {
    const request = quitRequest;
    quitRequest = undefined;
    if (world.loggedOut) {
      request.leave();
      return;
    }
  }
  if (pending) {
    if (game.world !== world) return;
    if (logoutCountdownWorld !== world) {
      logoutCancelRequested = false;
      logoutStartedAt = undefined;
    }
    logoutCountdownWorld = world;
    // Counted from the first granted response; a later sync of the same logout keeps the clock.
    logoutStartedAt ??= performance.now();
    // The stock CAMP dialog counts the server's twenty seconds while the popup owner is published
    // (FrameXmlPopups.ts fires PLAYER_CAMPING); its button is CancelLogout, which reaches the same
    // cancelPendingLogout, so the request state above stays shared and nothing cancels twice.
    if (frameXmlPopupsPublished()) {
      stopLogoutTicks();
      logoutCountdown?.hide();
      syncLogoutMenuButton();
      return;
    }
    if (!logoutCountdown) {
      logoutCountdown = new Panel({ id: "logout-countdown", title: "Выход из мира", className: "logout-countdown", closeButton: false });
      logoutCountdown.root.setAttribute("role", "dialog");
      logoutCountdown.root.setAttribute("aria-label", "Ожидание выхода из мира");
      const message = document.createElement("p");
      message.className = "logout-countdown-time";
      message.setAttribute("aria-hidden", "true");
      logoutCountdownLine = message;
      // What a screen reader hears: the same line, every five seconds rather than every second.
      const announce = document.createElement("p");
      announce.className = "logout-countdown-announce";
      announce.setAttribute("aria-live", "polite");
      logoutCountdownAnnounce = announce;
      logoutCancelButton = menuButton("Отменить выход", cancelPendingLogout);
      logoutCountdown.body.append(message, announce, logoutCancelButton);
    }
    if (logoutCancelButton) {
      logoutCancelButton.disabled = logoutCancelRequested;
      logoutCancelButton.textContent = logoutCancelRequested ? "Ожидание подтверждения…" : "Отменить выход";
    }
    const opening = !logoutCountdown.visible;
    logoutCountdown.show();
    startLogoutTicks();
    if (opening) logoutCancelButton?.focus();
  } else if (logoutCountdownWorld === world) {
    resetLogoutPending();
  }
  syncLogoutMenuButton();
}

/**
 * Hand the countdown to whichever surface owns it now: the stock popup owner was just published
 * (the native panel steps aside) or torn down (a logout still counting gets its native panel back).
 */
export function syncLogoutCountdownOwner(): void {
  const world = game.world;
  if (world && world.logout?.result === 0 && !world.loggedOut) updateLogoutPending(world, true);
  else if (frameXmlPopupsPublished()) {
    stopLogoutTicks();
    logoutCountdown?.hide();
  }
}

/** Called on every world teardown, including a lost connection with no logout packet. */
export function resetLogoutPending(): void {
  quitRequest = undefined;
  stopLogoutTicks();
  logoutCountdown?.hide();
  logoutCountdownWorld = undefined;
  logoutStartedAt = undefined;
  if (logoutCountdownAnnounce) logoutCountdownAnnounce.textContent = "";
  logoutCancelRequested = false;
  syncLogoutMenuButton();
}

/**
 * `Quit()`: the ordinary logout request, remembered so its completion leaves to the login screen.
 * A pending logout keeps its countdown; asking again only records the Quit intent.
 */
export function requestQuitToLogin(leave: () => void): void {
  const world = game.world;
  if (!world || world.loggedOut) return;
  quitRequest = { world, leave };
  if (world.logout?.result !== 0) world.requestLogout();
}

/** `CancelLogout()`: the same cancel the countdown's button sends, and the Quit intent goes too. */
export function cancelLogoutRequest(): void {
  quitRequest = undefined;
  cancelPendingLogout();
}

/** Whether the server is counting a logout down (the stock CAMP popup's lifetime). */
export function logoutPending(): boolean {
  return game.world?.logout?.result === 0 && !game.world.loggedOut;
}

/** Whether the logout the server is counting was asked for by `Quit()`: stock QUIT, not CAMP. */
export function logoutIsQuit(): boolean {
  return quitRequest !== undefined && quitRequest.world === game.world && logoutPending();
}

/**
 * `ForceQuit()`, QUIT's «Выйти сейчас»: leave for the login screen now rather than when the server
 * completes the logout — the client closes at once and leaves the character to the server's
 * countdown. Only a Quit this module is counting leaves early; the Quit intent is spent.
 */
export function forceQuitToLogin(): void {
  const request = quitRequest;
  if (!request || request.world !== game.world || !logoutPending()) return;
  quitRequest = undefined;
  request.leave();
}

// The stock QUIT dialog (FrameXmlPopups.ts) reads the Quit intent through the popup controller,
// which the world seam imports without pulling the native UI in.
registerFrameXmlQuitIntent({ quitting: logoutIsQuit, forceQuit: forceQuitToLogin });

/** «Диагностика»: the native diagnostics window and its unhandled-opcode list. */
export function openDiagnosticsWindow(): void {
  diagnosticsWindow.hidden = false;
  showUnhandledOpcodes();
  playUiSound("windowOpen");
}

/** «Сбросить раскладку окон»: every movable window back to its default place. */
export function resetWindowLayout(): void {
  gameWindows.resetLayout();
}

/** Escape closes the stock CAMP popup by asking the server to cancel the pending logout. */
export function logoutCountdownOpen(): boolean { return logoutCountdown?.visible ?? false; }
export function cancelLogoutCountdown(): void { cancelPendingLogout(); }

interface AddonMenuButton {
  readonly label: string;
  run(): void;
  element?: HTMLButtonElement;
}
const addonButtons = new Set<AddonMenuButton>();

function mountAddonButton(panel: Panel, entry: AddonMenuButton): void {
  entry.element = menuButton(entry.label, () => { panel.hide(); entry.run(); });
  panel.body.append(entry.element);
}

/** Expose TSWoW GameMenuFrame actions in the browser menu. */
export function registerGameMenuAddonButton(label: string, run: () => void): () => void {
  const entry: AddonMenuButton = { label, run };
  addonButtons.add(entry);
  if (menu) mountAddonButton(menu, entry);
  return () => { entry.element?.remove(); addonButtons.delete(entry); };
}

function menuButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function build(): Panel {
  const panel = new Panel({ id: "game-menu", title: "Меню", className: "game-menu" });
  panel.root.setAttribute("role", "dialog");
  panel.root.setAttribute("aria-label", "Меню игры");
  const syncExpandedState = (): void => {
    gameMenuToggle.setAttribute("aria-expanded", String(panel.visible));
    // Do not strand keyboard focus in a subtree that has just become hidden through one of its
    // actions or its close button.
    if (!panel.visible && panel.root.contains(document.activeElement)) gameMenuToggle.focus();
  };
  new MutationObserver(syncExpandedState).observe(panel.root, { attributes: true, attributeFilter: ["hidden"] });
  panel.body.append(
    menuButton("Продолжить", () => panel.hide()),
    menuButton("Управление", () => {
      panel.hide();
      toggleKeyBindingsWindow();
    }),
    // Slice I9. Six windows that had no entry point at all — the guild's was typing `/groster`.
    menuButton("Гильдия", () => { panel.hide(); openGuildWindow(); }),
    menuButton("Банк гильдии", () => { panel.hide(); openGuildBank(); }),
    menuButton("Календарь", () => { panel.hide(); toggleCalendar(); }),
    menuButton("Друзья и поиск", () => { panel.hide(); toggleSocialPanel(); }),
    menuButton("Профессии", () => { panel.hide(); toggleProfessionList(); }),
    menuButton("Поиск подземелий", () => { panel.hide(); toggleLfgWindow(); }),
    menuButton("Таблица боя", () => { panel.hide(); toggleScoreboard(); }),
    menuButton("Арена", () => { panel.hide(); toggleArenaWindow(); }),
    menuButton("Диагностика", () => {
      panel.hide();
      openDiagnosticsWindow();
    }),
    menuButton("Настройки", () => { panel.hide(); toggleSettingsWindow(); }),
    menuButton("Макросы", () => { panel.hide(); toggleMacroWindow(); }),
    menuButton("Помощь игрового мастера", () => { panel.hide(); toggleGmTickets(); }),
    menuButton("Сбросить раскладку окон", () => resetWindowLayout()),
    // Leaving the world properly rather than by closing the tab. The server takes twenty seconds
    // over it out of combat and refuses outright in it, which is what the answer packet says.
    logoutButton(panel),
  );
  for (const entry of addonButtons) mountAddonButton(panel, entry);
  return panel;
}

/**
 * Opens the menu, or closes it if it is already open. Built on first use, not at start-up.
 *
 * The stock GameMenuFrame answers first once the FrameXML mount has published it; this Panel is
 * the fallback while it is not (native UI mode, a failed gate, before the mount completes).
 */
export function toggleGameMenu(): void {
  if (toggleFrameXmlGameMenu()) {
    // The stock menu may have been opened over a native one left from before publication.
    if (menu?.visible) menu.hide();
    gameMenuToggle.setAttribute("aria-expanded", String(frameXmlGameMenuOpen()));
    return;
  }
  menu ??= build();
  syncLogoutMenuButton();
  menu.toggle();
  gameMenuToggle.setAttribute("aria-expanded", String(menu.visible));
  if (menu.visible) menu.body.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

/** True while the menu is up, so Escape knows whether it is opening or closing something. */
export function gameMenuOpen(): boolean {
  return frameXmlGameMenuOpen() || (menu?.visible ?? false);
}

/** A new character starts with a closed menu even if the old world ended under it. */
export function closeGameMenu(): void {
  closeFrameXmlGameMenu();
  menu?.hide();
  gameMenuToggle.setAttribute("aria-expanded", "false");
}

/**
 * «Выйти из мира».
 *
 * `CMSG_LOGOUT_REQUEST` was plumbed by slice P8 and never called. The server answers with a delay
 * — twenty seconds standing, none while resting — or with a refusal, and both come back on
 * `LOGOUT_CHANGED`, which the world wiring turns into a notice.
 */
function logoutButton(panel: Panel): HTMLButtonElement {
  const button = menuButton("Выйти из мира", () => {
    const world = game.world;
    if (!world) return;
    if (world.logout?.result === 0 && !world.loggedOut) {
      panel.hide();
      cancelPendingLogout();
      return;
    }
    confirmPanel(button, {
      title: "Выйти из мира?",
      lines: ["Сервер выведет персонажа через несколько секунд и не выведет вовсе в бою."],
      confirm: "Выйти",
      danger: true,
      onConfirm: () => {
        panel.hide();
        world.requestLogout();
      },
    });
  });
  logoutMenuButton = button;
  return button;
}
