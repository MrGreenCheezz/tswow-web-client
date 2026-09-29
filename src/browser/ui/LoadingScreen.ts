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
 *
 * What it looks like is the stock client's (see `LoadingScreenArt.ts`): the destination map's own
 * `LoadingScreens.dbc` picture — its `Wide` twin on a widescreen display — over black, and the
 * stock bar near the bottom. The status line stays, small, because it is the only place a slow
 * transfer says what it is waiting for.
 */

import { game } from "../game/Context.js";
import { syncMovement } from "../input/Movement.js";
import {
  LOADING_BAR_BORDER, LOADING_BAR_FILL, LOADING_BAR_GLOW, LOADING_STAGE_PROGRESS, LoadingScreenArtTable,
  gatewayHttpOrigin, loadingProgressStep, loadingScreenPicture, loadingTextureUrl, type LoadingStage,
} from "./LoadingScreenArt.js";

/** Long enough for a slow first tile, short enough not to look broken. */
const MAX_WAIT_MS = 20_000;

interface Parts {
  root: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  hint: HTMLElement;
  /** The picture's box: 4:3, or the whole screen for a `Wide` picture. */
  stage: HTMLElement;
  art: HTMLImageElement;
  bar: HTMLElement;
  barImages: HTMLImageElement[];
  /** The world panel the curtain covers; its box is the screen the picture is chosen for. */
  panel: HTMLElement;
}

/** Where the destination's art comes from; see {@link showLoadingScreen}. */
export interface LoadingScreenDestination {
  /** `Map.dbc` id of the map being entered. */
  readonly mapId: number;
  /** The gateway's WebSocket URL, as every other asset client is given it. */
  readonly gateway: string;
}

const artTable = new LoadingScreenArtTable();
let parts: Parts | undefined;
let shownAt = 0;
let lastStatus = "";
/** The bar: what it shows, the stage ceiling it creeps toward, and when it last moved. */
let progress = 0;
let progressCeiling: number = LOADING_STAGE_PROGRESS.connecting;
let progressAt = 0;
/** Bumped on every show, so a table or picture that lands for an old transfer is dropped. */
let showGeneration = 0;
let worldReady = false;
/**
 * Frames rendered behind the curtain after the physics barrier passes, before it lifts.
 *
 * The barrier answers "can the character stand here" (terrain + collision), not "is the first
 * panorama uploaded": programs compile and textures/geometries upload on first submit, so the
 * entry footprint's +6 shaders / +13 textures landed as 120–190 ms hitches on the first visible
 * frames. The loop keeps drawing behind the curtain either way — these frames just spend that
 * work where nobody feels it. Three is enough for the staged bulk plus stragglers; streaming
 * after the reveal stays staggered by the build budgets.
 */
let soakFrames = 0;
let soakArmed = false;
const ENTRY_SOAK_FRAMES = 3;

/** A picture from the archives; it is shown only once its pixels are here (`data-ready`). */
function picture(className: string): HTMLImageElement {
  const image = document.createElement("img");
  image.className = className;
  image.alt = "";
  image.decoding = "async";
  // The gateway answers a cross-origin picture only when the request names its origin.
  image.crossOrigin = "anonymous";
  image.onload = () => image.setAttribute("data-ready", "true");
  return image;
}

function build(): Parts | undefined {
  const panel = document.getElementById("world-panel");
  if (!panel) return undefined;
  const root = document.createElement("div");
  root.id = "loading-screen";
  root.className = "loading-screen";
  const stage = document.createElement("div");
  stage.className = "loading-stage";
  const art = picture("loading-art");
  // Who is entering and why it may take a moment: read out, not drawn — the stock screen has no
  // caption, only the picture and the bar.
  const copy = document.createElement("div");
  copy.className = "loading-copy";
  const title = document.createElement("strong");
  const hint = document.createElement("p");
  hint.className = "loading-hint";
  copy.append(title, hint);
  const status = document.createElement("p");
  status.className = "loading-status";
  status.setAttribute("role", "status");
  const bar = document.createElement("div");
  bar.className = "loading-bar";
  const slot = document.createElement("div");
  slot.className = "loading-bar-slot";
  const fill = document.createElement("div");
  fill.className = "loading-bar-fill";
  const fillImage = picture("loading-bar-fill-art");
  const glow = picture("loading-bar-glow");
  fill.append(fillImage, glow);
  slot.append(fill);
  const border = picture("loading-bar-border");
  bar.append(slot, border);
  stage.append(art, copy, status, bar);
  root.append(stage);
  panel.append(root);
  return { root, title, status, hint, stage, art, bar, barImages: [border, fillImage, glow], panel };
}

export function loadingScreenVisible(): boolean {
  return parts !== undefined && !parts.root.hidden;
}

function setProgress(value: number): void {
  progress = value;
  parts?.bar.style.setProperty("--loading-progress", value.toFixed(4));
}

/** Move the bar's ceiling to a stage; it only ever rises within one transfer. */
function reachStage(stage: LoadingStage): void {
  progressCeiling = Math.max(progressCeiling, LOADING_STAGE_PROGRESS[stage]);
}

function viewportAspect(panel: HTMLElement): number {
  const width = panel.clientWidth || (typeof window === "undefined" ? 0 : window.innerWidth);
  const height = panel.clientHeight || (typeof window === "undefined" ? 0 : window.innerHeight);
  return width > 0 && height > 0 ? width / height : 4 / 3;
}

/**
 * Put the destination's picture in, once the table and then its pixels are here. Until then the
 * curtain is the stock black with the bar, never a stale picture from the last map.
 */
function showArt(target: Parts, destination: LoadingScreenDestination | undefined, generation: number): void {
  target.art.removeAttribute("data-ready");
  target.art.removeAttribute("src");
  target.stage.setAttribute("data-wide", "false");
  const origin = destination ? gatewayHttpOrigin(destination.gateway) : undefined;
  if (!destination || !origin) return;
  for (const [index, path] of [LOADING_BAR_BORDER, LOADING_BAR_FILL, LOADING_BAR_GLOW].entries()) {
    const image = target.barImages[index];
    const url = loadingTextureUrl(origin, path);
    if (image && image.getAttribute("src") !== url) image.src = url;
  }
  const apply = (): void => {
    if (generation !== showGeneration || target.root.hidden) return;
    const chosen = loadingScreenPicture(artTable.get(destination.mapId), viewportAspect(target.panel));
    if (!chosen) return;
    target.stage.setAttribute("data-wide", chosen.wide ? "true" : "false");
    target.art.src = loadingTextureUrl(origin, chosen.path);
  };
  void artTable.load(origin).then(apply);
}

/**
 * Raised the moment the world panel appears, before anything has been fetched.
 *
 * `destination` names the map whose loading screen to show: the character's own map from the
 * character list on entry, the new map on a worldport. Without it the curtain is plain black.
 */
export function showLoadingScreen(characterName: string, hint = "", destination?: LoadingScreenDestination): void {
  parts ??= build();
  if (!parts) return;
  shownAt = performance.now();
  soakFrames = 0;
  soakArmed = false;
  lastStatus = "";
  worldReady = false;
  game.worldLoading = true;
  parts.root.hidden = false;
  parts.title.textContent = `Вход в мир · ${characterName}`;
  parts.status.textContent = "Соединение с миром…";
  parts.hint.textContent = hint;
  showGeneration += 1;
  progressCeiling = LOADING_STAGE_PROGRESS.connecting;
  progressAt = shownAt;
  setProgress(0);
  showArt(parts, destination, showGeneration);
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
  soakFrames = 0;
  soakArmed = false;
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
  // The bar creeps toward the ceiling of the stage reached so far (see LOADING_STAGE_PROGRESS).
  setProgress(loadingProgressStep(progress, progressCeiling, now - progressAt));
  progressAt = now;
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const position = self?.position;

  if (!world || world.mapId === undefined) {
    loadingStatus("Ожидание мира…");
  } else if (!position) {
    reachStage("character");
    loadingStatus("Ожидание персонажа…");
  } else {
    reachStage("terrain");
    // No transfer generation token is needed here: readiness is sampled from the live map and
    // self position every frame, and CollisionSource.reset() invalidates the old tile set before
    // this probe can release the new destination.
    const terrainReady = game.terrain?.isReady(world.mapId, position.x, position.y) === true;
    game.collision?.refresh(world.mapId, position.x, position.y);
    const collisionReady = game.collision?.isReady(world.mapId, position.x, position.y) === true;
    if (!terrainReady) {
      loadingStatus("Загрузка ландшафта…");
    } else if (!collisionReady) {
      reachStage("collision");
      loadingStatus("Загрузка коллизии…");
    } else {
      reachStage("soak");
      worldReady = true;
      releaseWhenSoaked();
      return;
    }
  }

  if (now - shownAt > MAX_WAIT_MS) {
    // A missing extractor asset must not make a character permanently unplayable. Physics remains
    // conservative for unresolved terrain (it treats it as "wait"), and the status line explains
    // why this was a degraded release when the diagnostics pane is opened.
    loadingStatus("Мир загружается дольше обычного — продолжаем в безопасном режиме…");
    worldReady = true;
    releaseWhenSoaked();
  }
}

/**
 * Drops the curtain only after the entry soak has rendered behind it (see `ENTRY_SOAK_FRAMES`).
 * Physics is already running on the first soaked frame (`worldReady` is set before this runs),
 * so the soak costs nothing but a few hidden frames and hides the first-panorama upload spike.
 */
function releaseWhenSoaked(): void {
  if (!soakArmed) {
    soakArmed = true;
    soakFrames = ENTRY_SOAK_FRAMES;
    // Three frames are too short to creep through: the bar shows the barrier passed at once.
    reachStage("soak");
    setProgress(Math.max(progress, LOADING_STAGE_PROGRESS.soak));
  }
  if (soakFrames > 0) {
    soakFrames--;
    loadingStatus("Подготовка первого кадра…");
    return;
  }
  hideLoadingScreen();
}
