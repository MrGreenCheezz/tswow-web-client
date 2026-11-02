import { diagnosticsWindow, gameMenuToggle, gameWindows } from "./Dom.js";
import { Panel } from "./Widgets.js";
import { game } from "../game/Context.js";
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

function cancelPendingLogout(): void {
  const world = game.world;
  if (!world || world.logout?.result !== 0 || world.loggedOut || logoutCancelRequested) return;
  logoutCancelRequested = true;
  world.cancelLogout();
  if (logoutCancelButton) {
    logoutCancelButton.disabled = true;
    logoutCancelButton.textContent = "Ожидание подтверждения…";
  }
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

function menuButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

/**
 * Opens the stock GameMenuFrame, or closes it if it is open. Before the interface is published, or
 * after its gate refused, there is no menu; the refusal says why (FrameXmlFallbackNotices.ts).
 */
export function toggleGameMenu(): void {
  toggleFrameXmlGameMenu();
  gameMenuToggle.setAttribute("aria-expanded", String(frameXmlGameMenuOpen()));
}

/** True while the menu is up, so Escape knows whether it is opening or closing something. */
export function gameMenuOpen(): boolean {
  return frameXmlGameMenuOpen();
}

/** A new character starts with a closed menu even if the old world ended under it. */
export function closeGameMenu(): void {
  closeFrameXmlGameMenu();
  gameMenuToggle.setAttribute("aria-expanded", "false");
}
