import { diagnosticsWindow, gameMenuToggle, gameWindows } from "./Dom.js";
import { Panel } from "./Widgets.js";
import { toggleKeyBindingsWindow } from "./KeyBindings.js";
import { openGuildWindow } from "./Guild.js";
import { openGuildBank } from "./GuildBank.js";
import { toggleCalendar } from "./Calendar.js";
import { toggleSocialPanel } from "./SocialPanel.js";
import { toggleScoreboard } from "./Scoreboard.js";
import { toggleArenaWindow } from "./ArenaWindow.js";
import { toggleSettingsWindow } from "./Settings.js";
import { toggleMacroWindow } from "./Macros.js";
import { game } from "../game/Context.js";
import { confirmPanel } from "./Widgets.js";
import { showUnhandledOpcodes } from "./Diagnostics.js";
import { playUiSound } from "../game/GameSounds.js";

/**
 * What Escape opens when nothing else is open.
 *
 * Written to be the measure of the widget kit: the page markup says nothing about this window, and
 * building it from scratch — draggable, remembered where it was put, closable — is the thirty lines
 * below. Its own contents are deliberately thin; a settings panel and leaving the world belong to
 * the system slice of the plan, and leaving the world needs opcodes the client does not send yet.
 * The bindings window hangs off it the way the original client hangs its own off Escape.
 */
let menu: Panel | undefined;

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
    menuButton("Таблица боя", () => { panel.hide(); toggleScoreboard(); }),
    menuButton("Арена", () => { panel.hide(); toggleArenaWindow(); }),
    menuButton("Диагностика", () => {
      panel.hide();
      diagnosticsWindow.hidden = false;
      showUnhandledOpcodes();
      playUiSound("windowOpen");
    }),
    menuButton("Настройки", () => { panel.hide(); toggleSettingsWindow(); }),
    menuButton("Макросы", () => { panel.hide(); toggleMacroWindow(); }),
    menuButton("Сбросить раскладку окон", () => gameWindows.resetLayout()),
    // Leaving the world properly rather than by closing the tab. The server takes twenty seconds
    // over it out of combat and refuses outright in it, which is what the answer packet says.
    logoutButton(panel),
  );
  for (const entry of addonButtons) mountAddonButton(panel, entry);
  return panel;
}

/** Opens the menu, or closes it if it is already open. Built on first use, not at start-up. */
export function toggleGameMenu(): void {
  menu ??= build();
  menu.toggle();
  gameMenuToggle.setAttribute("aria-expanded", String(menu.visible));
  if (menu.visible) menu.body.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

/** True while the menu is up, so Escape knows whether it is opening or closing something. */
export function gameMenuOpen(): boolean {
  return menu?.visible ?? false;
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
  return button;
}
