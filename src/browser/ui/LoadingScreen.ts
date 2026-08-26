/**
 * The curtain between the character list and the world.
 *
 * There was none, and the gap it hides is real: `enterWorld` awaits exactly one packet and then
 * returns, while twelve asset clients are still fetching. Every progress line it writes goes into
 * the diagnostics window, which is hidden — so what the player actually saw was the login screen
 * vanishing and a blue-green gradient sitting there until terrain tiles happened to arrive.
 *
 * The condition for taking it down is the honest one and had to be invented: there is no packet
 * that says "the world is ready". It comes down when the ground under the character has been
 * asked for and answered, or after a ceiling — because a curtain that never lifts is worse than
 * an empty world you can walk around in.
 */

import { game } from "../game/Context.js";
import { syncMovement } from "../input/Movement.js";

/** Long enough for a slow first tile, short enough not to look broken. */
const MAX_WAIT_MS = 20_000;

interface Parts {
  root: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  hint: HTMLElement;
}

let parts: Parts | undefined;
let shownAt = 0;
let lastStatus = "";
let worldReady = false;

function build(): Parts | undefined {
  const panel = document.getElementById("world-panel");
  if (!panel) return undefined;
  const root = document.createElement("div");
  root.id = "loading-screen";
  root.className = "loading-screen";
  const title = document.createElement("strong");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const bar = document.createElement("div");
  bar.className = "loading-bar";
  bar.append(document.createElement("i"));
  const hint = document.createElement("p");
  hint.className = "loading-hint";
  root.append(title, bar, status, hint);
  panel.append(root);
  return { root, title, status, hint };
}

export function loadingScreenVisible(): boolean {
  return parts !== undefined && !parts.root.hidden;
}

/** Raised the moment the world panel appears, before anything has been fetched. */
export function showLoadingScreen(characterName: string, hint = ""): void {
  parts ??= build();
  if (!parts) return;
  shownAt = performance.now();
  lastStatus = "";
  worldReady = false;
  game.worldLoading = true;
  parts.root.hidden = false;
  parts.title.textContent = `Вход в мир · ${characterName}`;
  parts.status.textContent = "Соединение с миром…";
  parts.hint.textContent = hint;
}

/** Whatever the client is waiting for right now, in the player's own words. */
export function loadingStatus(text: string): void {
  if (!parts || parts.root.hidden || text === lastStatus) return;
  lastStatus = text;
  parts.status.textContent = text;
}

export function hideLoadingScreen(): void {
  const wasLoading = game.worldLoading;
  if (parts) parts.root.hidden = true;
  worldReady = true;
  game.worldLoading = false;
  // A key can be pressed while the curtain owns the screen. Reconcile it after opening, when the
  // movement gate is down; a cleared axis was reset by releaseAllInput and needs no delayed stop
  // because the teleport itself established the destination state on the server.
  if (wasLoading) syncMovement();
}

export function resetLoadingScreen(): void {
  hideLoadingScreen();
  shownAt = 0;
  worldReady = false;
  game.worldLoading = false;
}

/** Whether local movement and gravity may run for the current destination. */
export function worldPhysicsReady(): boolean {
  return !game.worldLoading || worldReady;
}

/**
 * Takes the curtain down when there is something behind it.
 *
 * The ground and collision around the character are both required. A terrain height by itself is
 * not enough: an upper floor can be several dozen yards above the heightfield, and running gravity
 * before its VMAP groups arrive is exactly how a teleport drops the player through a building.
 * The ceiling is still there because a map with no tile or no collision extraction must degrade to
 * the terrain-only client rather than holding the player at a black screen forever.
 */
export function updateLoadingScreen(now: number): void {
  if (!loadingScreenVisible()) return;
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const position = self?.position;

  if (!world || world.mapId === undefined) {
    loadingStatus("Ожидание мира…");
  } else if (!position) {
    loadingStatus("Ожидание персонажа…");
  } else {
    // No transfer generation token is needed here: readiness is sampled from the live map and
    // self position every frame, and CollisionSource.reset() invalidates the old tile set before
    // this probe can release the new destination.
    const terrainReady = game.terrain?.isReady(world.mapId, position.x, position.y) === true;
    game.collision?.refresh(world.mapId, position.x, position.y);
    const collisionReady = game.collision?.isReady(world.mapId, position.x, position.y) === true;
    if (!terrainReady) {
      loadingStatus("Загрузка ландшафта…");
    } else if (!collisionReady) {
      loadingStatus("Загрузка коллизии…");
    } else {
      worldReady = true;
      hideLoadingScreen();
      return;
    }
  }

  if (now - shownAt > MAX_WAIT_MS) {
    // A missing extractor asset must not make a character permanently unplayable. Physics remains
    // conservative for unresolved terrain (it treats it as "wait"), and the status line explains
    // why this was a degraded release when the diagnostics pane is opened.
    loadingStatus("Мир загружается дольше обычного — продолжаем в безопасном режиме…");
    worldReady = true;
    hideLoadingScreen();
  }
}
