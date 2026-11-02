import { isLootable, isPlayerGhost } from "../../world/Fields.js";
import {
  QUEST_STATUS_AVAILABLE, QUEST_STATUS_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_REWARD_REP, QUEST_STATUS_REWARD,
  QUEST_STATUS_REWARD2, QUEST_STATUS_REWARD_REP,
} from "../../world/QuestProtocol.js";
import { isWorldObjectDead, type WorldObjectState, type WorldState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import {
  MINIMAP_TILE_PIXELS, MINIMAP_YARDS_PER_PIXEL, clampToCircle, minimapBlip, minimapPixel,
  minimapTileOf, minimapWorldAt, type MinimapPixel, type WorldPoint,
} from "../MinimapGeometry.js";
import {
  MINIMAP_CORPSE_ARROW_TEXTURE, MINIMAP_CORPSE_POI_ICON, MINIMAP_DEFAULT_INDOOR_ZOOM, MINIMAP_DEFAULT_OUTDOOR_ZOOM,
  MINIMAP_GROUP_ARROW_TEXTURE, MINIMAP_ICON_UNITS, MINIMAP_MASK_TEXTURE, MINIMAP_OBJECT_CELL, MINIMAP_OBJECT_ICONS_TEXTURE,
  MINIMAP_PARTY_BLIPS_TEXTURE, MINIMAP_PARTY_CELL, MINIMAP_PLAYER_ARROW_TEXTURE, MINIMAP_PLAYER_ARROW_UNITS,
  MINIMAP_POI_ARROW_TEXTURE, MINIMAP_RIM_ARROW_UNITS, MINIMAP_RIM_FRACTION, MINIMAP_TILE_SHIFT_FRACTION, MINIMAP_TOWN_CELL,
  MINIMAP_UNITS, MINIMAP_ZOOM_LEVELS, minimapPartyCell, minimapPastRim, minimapPoiHasArrow, minimapQuestCell, minimapRimAngle,
  minimapRimPois, minimapTileTint, minimapTrackedCell, minimapYards, minimapZoomIndex, type MinimapIconCell, type MinimapRimPoi,
} from "./MinimapArt.js"; // 03.11
import { townTrackedCell, trivialQuestsTracked } from "./TownTracking.js"; // 03.11
import { unit as unitField } from "../../world/Fields.js";
import { reactionTo } from "../game/Targeting.js";
import { formatGameTime, halfMinuteOfDay } from "../../world/GameTimeProtocol.js";
import { rightRail } from "./Dom.js";
import { settingOn, watchSettingsApplied } from "./Settings.js";
import { skinnable, slot } from "./Slots.js";
import { toggleTrackingMenu, trackingMatcher } from "./Tracking.js";
import { toggleWorldMap } from "./WorldMap.js";
import { setTip } from "./Widgets.js";
import { partyBlipMembers } from "../game/PartyPositions.js";
import { activeGossipPoi, type GossipPoiMark } from "../GossipPoi.js"; // 3.13
import {
  drawGossipPoi, gossipPoiPlacement, minimapPoiIconCell, MINIMAP_GUIDE_ARROW_TEXTURE, MINIMAP_POI_ICONS_TEXTURE,
} from "./MinimapGossipPoi.js"; // 3.13
// 05.10-A7b-4 (7.13/7.14): the located area (WMO room → grid → map) and the building's own minimap.
import { drawLiveWmoMinimap, liveAreaIdAt, liveIndoorZoneTexts, liveWmoMinimapApplies, liveWmoMinimapRevision } from "../AreaLocatorLive.js";

/**
 * The minimap: the client's own baked tiles under the character, with the zone name and the
 * clock the original client puts around them.
 *
 * What this replaces was a radar — a dark circle with a dot per nearby object, projected through
 * the *camera's* right vector, which put east on the left. Nothing here is derived from the
 * camera: every position goes through `MinimapGeometry`, which follows the same axes as the
 * terrain mesh under it.
 *
 * The frame is built at runtime rather than declared in `index.html`, because `Dom.ts` resolves
 * every id in the page when it is imported and throws on a missing one — a panel that may or may
 * not exist cannot live there. It is deliberately *not* registered with the window manager: it is
 * part of the permanent interface like the action bar, not a window to be dragged and remembered.
 */

const STORAGE_KEY = "webclient.minimap";
/** How often the zone under the character is recounted; every frame is a lookup for nothing. */
const ZONE_INTERVAL = 250;

interface MinimapSettings {
  /** 03.11: the client's two zooms, `minimapZoom` and `minimapInsideZoom`: a step of MinimapArt's tables, 0 the widest. */
  outsideZoom: number;
  insideZoom: number;
  /** Whether the map turns with the character, as the original client can be set to. */
  rotate: boolean;
}

interface MinimapParts {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  clock: HTMLElement;
  zone: HTMLElement;
  subzone: HTMLElement;
}

let parts: MinimapParts | undefined;
/** How often the map repaints on its own when nothing it shows has moved. */
const MINIMAP_IDLE_REDRAW_MS = 100;
let lastDrawAt = Number.NEGATIVE_INFINITY;
let lastDrawKey = "";
let lastDrawWorld: unknown;
/** The state revision the blips were last looked at, and what they were on the canvas. */
let lastDrawRevision = Number.NaN;
let lastBlipSignature: readonly unknown[] = [];
let settings: MinimapSettings = readSettings();
let zoneCheckedAt = 0;
let zoneAreaId = 0;
interface MinimapPing {
  x: number;
  y: number;
  until: number;
  /** Set only on a local marker until the matching immediate server echo arrives. */
  optimisticUntil: number | undefined;
}

/** Pings in world units. The packet arrives for anyone in the party. */
const pings: MinimapPing[] = [];
const LOCAL_PING_ECHO_WINDOW = 1_000;
// The wire packet is f32 while the local projection is a double, so exact equality is too strict.
const PING_MATCH_EPSILON = 0.01;

const ADOPTED_STYLE_NAMES = [
  "display", "position", "left", "right", "top", "bottom", "width", "height", "transform",
  "transformOrigin", "zIndex", "opacity", "visibility", "pointerEvents",
] as const;
type AdoptedStyleName = typeof ADOPTED_STYLE_NAMES[number];

interface MinimapCanvasAdoption {
  readonly canvas: HTMLCanvasElement;
  readonly target: HTMLElement;
  readonly nativeParent: HTMLElement;
  readonly nativeNextSibling: Node | null;
  readonly propagationGuards: ReadonlyArray<{
    readonly type: "mousedown" | "mouseup" | "click";
    readonly listener: EventListener;
  }>;
  readonly styles: Readonly<Record<AdoptedStyleName, string | undefined>>;
  readonly className: string;
  readonly hidden: boolean;
  readonly dataset: Readonly<Record<string, string>>;
  readonly width: number;
  readonly height: number;
  cleaned: boolean;
  cleanup: () => void;
}

let activeMinimapAdoption: MinimapCanvasAdoption | undefined;

function readSettings(): MinimapSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<MinimapSettings> | null;
    return {
      outsideZoom: minimapZoomIndex(stored?.outsideZoom, MINIMAP_DEFAULT_OUTDOOR_ZOOM),
      insideZoom: minimapZoomIndex(stored?.insideZoom, MINIMAP_DEFAULT_INDOOR_ZOOM),
      rotate: stored?.rotate === true,
    };
  } catch {
    return { outsideZoom: MINIMAP_DEFAULT_OUTDOOR_ZOOM, insideZoom: MINIMAP_DEFAULT_INDOOR_ZOOM, rotate: false };
  }
}

function writeSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A browser with storage turned off still gets a minimap; it just forgets the zoom.
  }
}

function build(): MinimapParts {
  const root = document.createElement("div");
  root.id = "minimap";
  root.className = "minimap";

  const clock = document.createElement("div");
  clock.className = "minimap-clock";
  const canvas = document.createElement("canvas");
  canvas.id = "minimap-canvas";
  canvas.setAttribute("aria-label", "Миникарта");
  setTip(canvas, "Щелчок — метка на миникарте группы");
  const zone = document.createElement("div");
  zone.className = "minimap-zone";
  const subzone = document.createElement("div");
  subzone.className = "minimap-subzone";
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Minimap needs a 2D canvas context");

  const controls = document.createElement("div");
  controls.className = "minimap-controls";
  const out = controlButton("−", "Отдалить", () => changeZoom(-1));
  const into = controlButton("+", "Приблизить", () => changeZoom(1));
  const rotate = controlButton("⟳", "Вращать карту по направлению взгляда", () => {
    // Through the settings store rather than straight into the local copy: rotation is one of the
    // options the settings window owns, and the two would otherwise disagree.
    onRotateToggled?.(!settings.rotate);
    setMinimapRotation(!settings.rotate);
  });
  controls.append(
    out,
    into,
    rotate,
    controlButton("👁", "Слежение", () => toggleTrackingMenu()),
    controlButton("🗺", "Карта мира (M)", () => toggleWorldMap()),
  );
  showControlState(out, into, rotate);

  root.append(clock, canvas, controls, zone, subzone);
  // The two places a module may reach on the minimap (М7): the button row, which a patch fills
  // beside the zoom and tracking buttons, and the clock, which it may hide. Declared here rather
  // than at module load because the whole frame is built at runtime.
  slot("minimap/buttons", controls);
  slot("minimap/clock", clock);
  skinnable("minimap", root);
  // The right-hand rail rather than the viewport: the minimap, the quest tracker and the boss and
  // arena frames share one column, instead of four boxes guessing a `top` and overlapping.
  // The map is the rail's fixed anchor. Tracker/boss/arena surfaces are secondary content and
  // must not push it down when they acquire rows, so publish it first once and let the rail stack
  // everything else beneath it.
  rightRail.insertBefore(root, rightRail.children[0] ?? null);

  // A click puts the world position under the cursor on the party's minimaps, as stock
  // Minimap_OnClick does on any click inside the circle (Minimap.lua:177-188, OnMouseUp). Ctrl+click
  // stays the same ping; `click` is the primary button only (the others are `auxclick`). Reading
  // the position back needs the same projection that drew it.
  canvas.addEventListener("click", (event) => onCanvasClick(event, canvas));
  return { root, canvas, context, clock, zone, subzone };
}

function readStyle(style: CSSStyleDeclaration, name: AdoptedStyleName): string | undefined {
  const value = (style as unknown as Record<string, string>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function writeStyle(style: CSSStyleDeclaration, name: AdoptedStyleName, value: string | undefined): void {
  const mutable = style as unknown as Record<string, string>;
  mutable[name] = value ?? "";
}

function numericCssPixels(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/i.exec(value);
  if (!match) return undefined;
  const pixels = Number(match[1]);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : undefined;
}

function positiveDimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function restoreDataset(canvas: HTMLCanvasElement, dataset: Readonly<Record<string, string>>): void {
  const mutable = canvas.dataset as unknown as Record<string, string | undefined>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, dataset);
}

function restoreMinimapCanvasAdoption(record: MinimapCanvasAdoption): void {
  if (record.cleaned) return;
  record.cleaned = true;
  if (activeMinimapAdoption === record) activeMinimapAdoption = undefined;

  for (const guard of record.propagationGuards) record.canvas.removeEventListener(guard.type, guard.listener);
  for (const name of ADOPTED_STYLE_NAMES) writeStyle(record.canvas.style, name, record.styles[name]);
  record.canvas.className = record.className;
  record.canvas.hidden = record.hidden;
  restoreDataset(record.canvas, record.dataset);
  record.canvas.width = record.width;
  record.canvas.height = record.height;

  const sibling = record.nativeNextSibling;
  if (sibling && sibling.parentNode === record.nativeParent) {
    record.nativeParent.insertBefore(record.canvas, sibling);
  } else {
    record.nativeParent.append(record.canvas);
  }
}

function targetDimension(target: HTMLElement, name: "width" | "height"): number | undefined {
  const authored = numericCssPixels(readStyle(target.style, name));
  if (authored !== undefined) return authored;
  const layout = positiveDimension(target[name === "width" ? "offsetWidth" : "offsetHeight"]);
  if (layout !== undefined) return layout;
  return positiveDimension(target[name === "width" ? "clientWidth" : "clientHeight"]);
}

function targetSize(target: HTMLElement): number | undefined {
  const width = targetDimension(target, "width");
  const height = targetDimension(target, "height");
  return width !== undefined && height !== undefined ? Math.min(width, height) : width ?? height;
}

function syncAdoptedCanvasGeometry(record: MinimapCanvasAdoption): number | undefined {
  // Keep the CSS box tied to the authored slot when its inline dimensions are changed after the
  // one-time adoption. A conditional write avoids dirtying style/layout when nothing changed.
  const width = readStyle(record.target.style, "width") ?? "100%";
  const height = readStyle(record.target.style, "height") ?? "100%";
  if (readStyle(record.canvas.style, "width") !== width) writeStyle(record.canvas.style, "width", width);
  if (readStyle(record.canvas.style, "height") !== height) writeStyle(record.canvas.style, "height", height);
  return targetSize(record.target);
}

function adoptedMinimapSize(canvas: HTMLCanvasElement): number | undefined {
  const adoption = activeMinimapAdoption;
  return adoption?.canvas === canvas ? syncAdoptedCanvasGeometry(adoption) : undefined;
}

/**
 * Borrow the one native minimap canvas for the stock FrameXML `Minimap` frame.
 *
 * The canvas already belongs to the TypeScript minimap update loop. This helper only moves that
 * node into the authored slot and gives it the slot's current geometry; it never creates a canvas,
 * context, renderer or readback path. It is inserted as the first child so the stock FrameXML
 * buttons, pings and backdrop remain painted above the map. The canvas remains `pointer-events: auto`
 * while adopted so its existing Ctrl-click ping path stays live. Small `stopPropagation` guards on
 * mousedown/mouseup/click keep the same event from reaching the authored Minimap handlers; they do
 * not use `stopImmediatePropagation`, so the canvas's own click listener still runs. Clearing the
 * parent restores the FrameXML ancestor's effective visibility without mirroring its changing
 * hidden bit on every frame.
 *
 * A returned cleanup is idempotent and restores the native parent/sibling order, all adopted inline
 * styles, hidden/dataset/class state and backing dimensions. Missing or detached inputs are safe
 * no-ops. If the first world update has not run yet, a valid target causes the normal minimap
 * parts to materialize once so the same canvas can be adopted without a mount race.
 */
export function adoptMinimapCanvas(target: HTMLElement | undefined): (() => void) | undefined {
  if (!target || !target.parentElement || target === parts?.canvas) return undefined;
  // Real DOM nodes expose `isConnected`; test doubles used by the UI tests intentionally do not.
  if (target.isConnected === false) return undefined;

  if (activeMinimapAdoption?.target === target) return activeMinimapAdoption.cleanup;
  activeMinimapAdoption?.cleanup();

  // The FrameXML mount can arrive before the first world tick. Building here still creates only
  // the one renderer-owned canvas/context used by updateMinimap; failure leaves the page untouched.
  if (!parts) {
    try {
      parts = build();
    } catch {
      return undefined;
    }
  }
  const canvas = parts.canvas;
  const context = parts.context;
  const nativeParent = canvas.parentElement;
  if (!context || !nativeParent || canvas.isConnected === false || target === canvas) return undefined;

  const styles = Object.fromEntries(
    ADOPTED_STYLE_NAMES.map((name) => [name, readStyle(canvas.style, name)]),
  ) as Record<AdoptedStyleName, string | undefined>;
  const record = {
    canvas,
    target,
    nativeParent,
    nativeNextSibling: canvas.nextSibling,
    propagationGuards: (["mousedown", "mouseup", "click"] as const).map((type) => ({
      type,
      listener: (event: Event) => event.stopPropagation(),
    })),
    styles,
    className: canvas.className,
    hidden: canvas.hidden,
    dataset: { ...canvas.dataset },
    width: canvas.width,
    height: canvas.height,
    cleaned: false,
    cleanup: () => {},
  } as MinimapCanvasAdoption;
  record.cleanup = () => restoreMinimapCanvasAdoption(record);

  try {
    const firstChild = target.firstChild ?? target.children[0] ?? null;
    target.insertBefore(canvas, firstChild);

    // The slot itself supplies the position in MinimapCluster. Inside that slot the canvas fills
    // the authored box; copying the frame's left/top would position it twice.
    writeStyle(canvas.style, "display", "block");
    writeStyle(canvas.style, "position", "absolute");
    writeStyle(canvas.style, "left", "0px");
    writeStyle(canvas.style, "right", undefined);
    writeStyle(canvas.style, "top", "0px");
    writeStyle(canvas.style, "bottom", undefined);
    writeStyle(canvas.style, "width", readStyle(target.style, "width") ?? "100%");
    writeStyle(canvas.style, "height", readStyle(target.style, "height") ?? "100%");
    writeStyle(canvas.style, "transform", undefined);
    writeStyle(canvas.style, "transformOrigin", undefined);
    // FrameXML descendants carry positive draw-layer/frame-level z indices. Keep this underlay at
    // the bottom of the slot so those controls and the authored border remain visible.
    writeStyle(canvas.style, "zIndex", "0");
    writeStyle(canvas.style, "opacity", undefined);
    writeStyle(canvas.style, "visibility", undefined);
    // The native canvas owns map clicks while adopted. The guards leave its own click listener
    // running but stop the same event from bubbling into FrameXML Minimap's OnMouseUp path.
    writeStyle(canvas.style, "pointerEvents", "auto");
    // A blank authored texture may be hidden, but the live canvas follows the Minimap ancestor.
    canvas.hidden = false;

    for (const guard of record.propagationGuards) canvas.addEventListener(guard.type, guard.listener);

    resize(canvas, context, targetSize(target));
  } catch (error) {
    record.cleanup();
    throw error;
  }
  activeMinimapAdoption = record;
  return record.cleanup;
}

/** The two zoom buttons grey out at the ends of the range, and the rotate button says it is on. */
function showControlState(out: HTMLButtonElement, into: HTMLButtonElement, rotate: HTMLButtonElement): void {
  const index = currentZoomIndex();
  out.disabled = index <= 0;
  into.disabled = index >= MINIMAP_ZOOM_LEVELS - 1;
  rotate.classList.toggle("is-active", settings.rotate);
  rotate.setAttribute("aria-pressed", String(settings.rotate));
}

function controlButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "minimap-button";
  setTip(button, title);
  // The glyph is decoration; the name has to be readable by something that cannot see it.
  button.setAttribute("aria-label", title);
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** `Minimap_ZoomIn`/`Minimap_ZoomOut` (MINIMAPZOOMIN/OUT, 3.11): the + and − buttons' step. */
export function zoomMinimap(direction: "in" | "out"): void {
  changeZoom(direction === "in" ? 1 : -1);
}

/**
 * 03.11: whether the map under the character is a building's pictures, which is what Wow.exe keys its second zoom on:
 * in Stormwind's streets `IsIndoors` is nil and Minimap:SetZoom still writes `minimapInsideZoom`.
 */
let insideNow = false;

function currentZoomIndex(): number {
  return insideNow ? settings.insideZoom : settings.outsideZoom;
}

/** Yards across the circle right now. */
function currentYards(): number {
  return minimapYards(insideNow, currentZoomIndex());
}

function changeZoom(step: number): void {
  setMinimapZoomIndex(currentZoomIndex() + step);
}

function setMinimapZoomIndex(index: number): void {
  if (!Number.isFinite(index)) return;
  const next = Math.max(0, Math.min(MINIMAP_ZOOM_LEVELS - 1, Math.trunc(index)));
  if (next === currentZoomIndex()) return;
  settings = insideNow ? { ...settings, insideZoom: next } : { ...settings, outsideZoom: next };
  writeSettings();
  refreshMinimapControls();
}

/** Called by the bus when someone in the party marks a spot. */
/**
 * Turns rotation on or off from wherever it was asked for.
 *
 * The button on the minimap and the checkbox in the settings window are the same setting, so both
 * come through here and the button repaints itself either way.
 */
export function setMinimapRotation(rotate: boolean): void {
  if (settings.rotate === rotate) return;
  settings = { ...settings, rotate };
  writeSettings();
  refreshMinimapControls();
}

/**
 * 3.11: the TOGGLEMINIMAP key on the native HUD — the stock `ToggleMinimap()` hides and shows the map
 * (Minimap.lua); this is the session's choice, as the stock frame's shown state is not saved either.
 */
let hiddenByKey = false;

export function toggleMinimapShown(): void {
  hiddenByKey = !hiddenByKey;
}

// The stock Minimap draws this same canvas, so the account's value reaches it whoever applied it.
watchSettingsApplied(() => { setMinimapRotation(settingOn("minimapRotate")); });

/** Called when the setting changes elsewhere, so the round button matches the checkbox. */
export function refreshMinimapControls(): void {
  const buttons = parts?.root.querySelectorAll<HTMLButtonElement>(".minimap-button");
  if (!buttons) return;
  const [out, into, rotate] = [...buttons];
  if (out && into && rotate) showControlState(out, into, rotate);
}

/** Set by whoever owns the settings blob, so a click on the map writes it back to the account. */
export let onRotateToggled: ((rotate: boolean) => void) | undefined;

export function watchMinimapRotation(handler: (rotate: boolean) => void): void {
  onRotateToggled = handler;
}

function pushMinimapPing(x: number, y: number, now: number, optimistic = false): void {
  pings.push({
    x,
    y,
    until: now + 5_000,
    optimisticUntil: optimistic ? now + LOCAL_PING_ECHO_WINDOW : undefined,
  });
  if (pings.length > 8) pings.shift();
}

/** Add a server ping, absorbing only the matching echo of a recent local marker. */
export function addMinimapPing(x: number, y: number, now = performance.now()): void {
  for (let index = pings.length - 1; index >= 0; index--) {
    const ping = pings[index]!;
    if (ping.optimisticUntil === undefined || now > ping.optimisticUntil) continue;
    if (Math.abs(ping.x - x) > PING_MATCH_EPSILON || Math.abs(ping.y - y) > PING_MATCH_EPSILON) continue;
    // Keep the original marker and stop treating it as pending. A later same-coordinate packet
    // is a real additional ping rather than another echo of this one.
    ping.optimisticUntil = undefined;
    return;
  }
  pushMinimapPing(x, y, now);
}

function addOptimisticMinimapPing(x: number, y: number, now = performance.now()): void {
  pushMinimapPing(x, y, now, true);
}

/** The quickest a click repeats a ping: the server relays every MSG_MINIMAP_PING to the group. */
export const MINIMAP_CLICK_PING_INTERVAL_MS = 500;
let lastClickPingAt = Number.NEGATIVE_INFINITY;

/**
 * Whether a click at `point` (pixels from the centre) pings: inside the circle, as stock's
 * `sqrt(x² + y²) < width / 2`, and not sooner than {@link MINIMAP_CLICK_PING_INTERVAL_MS} after the
 * last one, so a double click is one ping.
 */
export function minimapClickPings(point: MinimapPixel, size: number, now: number, lastAt: number): boolean {
  if (!(size > 0) || Math.hypot(point.column, point.row) >= size / 2) return false;
  return now - lastAt >= MINIMAP_CLICK_PING_INTERVAL_MS;
}

function onCanvasClick(event: MouseEvent, canvas: HTMLCanvasElement): void {
  const box = canvas.getBoundingClientRect();
  const size = Math.min(box.width, box.height);
  const point = { column: event.clientX - box.left - box.width / 2, row: event.clientY - box.top - box.height / 2 };
  const now = performance.now();
  if (!minimapClickPings(point, size, now, lastClickPingAt)) return;
  lastClickPingAt = now;
  pingMinimapAt(point, size);
}

function playerOf(state: WorldState | undefined): WorldObjectState | undefined {
  if (!state || state.selfGuid === undefined) return undefined;
  return state.objects.get(state.selfGuid);
}

function currentCanvasSize(canvas: HTMLCanvasElement): number {
  return adoptedMinimapSize(canvas)
    ?? numericCssPixels(readStyle(canvas.style, "width"))
    ?? positiveDimension(canvas.clientWidth)
    ?? 160;
}

function pingMinimapAt(point: MinimapPixel, size: number): void {
  const world = game.world;
  const self = playerOf(world?.state);
  if (!world || !self?.position || !(size > 0)) return;
  const { x, y } = minimapWorldAt(
    self.position,
    point,
    currentYards() / size,
    settings.rotate ? self.position.orientation : undefined,
  );
  // Record before sending so a synchronous test/server echo is absorbed as well as an async one.
  addOptimisticMinimapPing(x, y);
  world.pingMinimap(x, y);
}

/** Structural match for GlueWidgets' optional live Minimap adapter; kept UI-local to avoid coupling. */
export interface MinimapWidgetAdapter {
  readonly getZoom: () => number;
  readonly getZoomLevels: () => number;
  readonly setZoom: (zoom: number) => void;
  readonly pingLocation: (x: number, y: number) => void;
}

/** The stable bridge for stock Minimap.lua's zoom and local-pixel ping calls. */
export const minimapWidgetAdapter: MinimapWidgetAdapter = {
  getZoom: currentZoomIndex,
  getZoomLevels: () => MINIMAP_ZOOM_LEVELS,
  setZoom: setMinimapZoomIndex,
  pingLocation: (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const canvas = parts?.canvas;
    if (!canvas) return;
    // FrameXML's local Y grows upward; the canvas projection's row grows downward.
    pingMinimapAt({ column: x, row: -y }, currentCanvasSize(canvas));
  },
};

/** Called once a frame. Cheap when nothing has moved; the tiles are drawn from cached bitmaps. */
export function updateMinimap(now: number): void {
  const world = game.world;
  const self = playerOf(world?.state);
  if (!world || !self?.position || world.mapId === undefined || hiddenByKey) { // 3.11: hiddenByKey
    if (parts && !parts.root.hidden) parts.root.hidden = true;
    return;
  }
  parts ??= build();
  if (parts.root.hidden) parts.root.hidden = false;

  const size = resize(parts.canvas, parts.context, adoptedMinimapSize(parts.canvas));
  insideNow = liveWmoMinimapApplies(world.mapId, self.position); // 03.11
  // The canvas is a repaint, not a transform: sixty passes a second cost the same when nothing
  // has changed, and nothing that matters lands between two of them while the player stands still.
  // The clock keeps the map honest at a much lower rate, and anything that moves — the character,
  // the wheel, the zone's tiles, the state itself — asks for the frame immediately. A live ping is
  // the one thing that animates on its own, so it redraws at the frame rate it always did.
  const animating = pings.length > 0;
  // 3.13: the guard's POI while it lives (GossipPoi.ts: 480 s, or until the player is within 10 yards).
  const poi = activeGossipPoi(world, now, self.position);
  const poiOnMap = poi && poi.mapId === world.mapId ? poi : undefined;
  const key = `${world.mapId}|${Math.round(self.position.x * 8)}|${Math.round(self.position.y * 8)}`
    + `|${Math.round(self.position.orientation * 256)}|${size}`
    + `|${game.minimapTiles?.revision ?? -1}|${currentYards()}|${settings.rotate ? 1 : 0}|${game.mapArt?.revision ?? -1}`
    + `|${liveWmoMinimapRevision()}` // 05.10-A7b-4 (7.14): the floor's building and its answer
    + `|${poiOnMap ? `${poiOnMap.x},${poiOnMap.y},${poiOnMap.icon},${poiOnMap.flags}` : "-"}`;
  // The state is what the blips are made of, and it used to be in the key as its revision — which
  // every packet about anybody moves, so in a crowd the whole circle was repainted every frame for
  // neighbours far outside it. When the revision has moved, the blips are collected (one walk of
  // the object table, which the repaint needs anyway) and compared with the ones on the canvas;
  // only a blip that appeared, went or moved asks for the frame.
  const stateMoved = world.state.revision !== lastDrawRevision || lastDrawWorld !== world;
  lastDrawRevision = world.state.revision;
  let blips = stateMoved ? collectBlips(self.position, world.state) : undefined;
  let signature = blips === undefined ? undefined : blipSignature(blips);
  const blipsMoved = signature !== undefined && !sameBlipSignature(signature, lastBlipSignature);
  // A different world is never the same picture, whatever its numbers say; and nothing else the
  // map draws is allowed to lag by more than the idle interval, so a missed input is a tenth of a
  // second of staleness rather than a frozen map.
  const moved = key !== lastDrawKey || lastDrawWorld !== world || blipsMoved;
  if (!moved && !animating && now - lastDrawAt < MINIMAP_IDLE_REDRAW_MS) {
    updateLabels(parts, world, self.position, now);
    return;
  }
  lastDrawKey = key;
  lastDrawWorld = world;
  lastDrawAt = now;
  if (blips === undefined || signature === undefined) {
    blips = collectBlips(self.position, world.state);
    signature = blipSignature(blips);
  }
  lastBlipSignature = signature;
  drawMinimap(parts.context, size, world.mapId, self.position, blips, now, poiOnMap);
  updateLabels(parts, world, self.position, now);
}

/** 03.11: device pixels a drawing unit takes on the screen, asked of the layout once a second. */
let backingRatio = 0;
let backingRatioAt = Number.NEGATIVE_INFINITY;
let backingRatioSize = 0;

/**
 * The stock frame is 140 units and the interface scales them with a transform: at 1080 lines it takes 197 pixels of the
 * screen, and a backing store of 140 would be stretched over them. Wow.exe draws into the frame's pixels.
 */
function canvasBackingRatio(canvas: HTMLCanvasElement, size: number): number {
  const now = performance.now();
  if (backingRatio === 0 || size !== backingRatioSize || now - backingRatioAt >= 1000) {
    backingRatioAt = now;
    backingRatioSize = size;
    const device = window.devicePixelRatio || 1;
    const box = canvas.getBoundingClientRect?.();
    const shown = box ? Math.min(box.width, box.height) : 0;
    backingRatio = shown > 0 && size > 0 ? Math.min(4, (shown * device) / size) : Math.min(2, device);
  }
  return backingRatio;
}

/** CSS pixels for drawing, device pixels for the backing store: the same scheme the scene uses. */
function resize(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, authoredSize?: number): number {
  const size = authoredSize ?? (canvas.clientWidth || numericCssPixels(readStyle(canvas.style, "width")) || 160);
  const ratio = canvasBackingRatio(canvas, size);
  const pixels = Math.round(size * ratio);
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return size;
}

/**
 * 03.11: in Wow.exe's order, read from its draw calls: the map through Textures\\MinimapMask, the party, the object icons,
 * the arrows on the rim, and the character's arrow over all of it. Only the map is masked; the rest is cut by the
 * FrameXML border drawn over the canvas. The building's pictures come out of a render target cleared to black, so the
 * circle is black where they end; the terrain tiles have nothing behind them.
 */
function drawMinimap(
  context: CanvasRenderingContext2D,
  size: number,
  mapId: number,
  position: { x: number; y: number; z?: number; orientation: number },
  blips: MinimapBlips,
  now: number,
  poi?: GossipPoiMark,
): void {
  const radius = size / 2;
  const yards = currentYards();
  const facing = settings.rotate ? position.orientation : undefined;
  context.clearRect(0, 0, size, size);
  context.save();
  if (insideNow) {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, size, size);
  }
  context.translate(radius, radius);
  if (settings.rotate) context.rotate(position.orientation);
  // 05.10-A7b-4 (7.14): in an interior room of a building with bakes, its pictures replace the ADT tiles.
  // 12.10 (7.27): wherever Wow.exe 0x007F5BA0 chooses the building minimap (Stormwind's streets too).
  if (!drawLiveWmoMinimap(context, mapId, position, size / (yards / MINIMAP_YARDS_PER_PIXEL), yards / 2)) {
    drawTiles(context, size, mapId, position);
  }
  context.restore();
  maskMap(context, size);

  context.save();
  context.translate(radius, radius);
  drawIcons(context, size, position, blips, facing);
  drawPings(context, radius, position, yards / size, now, facing);
  drawRimArrows(context, size, position, blips, facing);
  context.restore();

  // 3.13: the guard's POI — its POIIcons cell near, a guide arrow on the rim farther (MinimapGossipPoi.ts).
  if (poi) {
    const placement = gossipPoiPlacement(poi, position, yards / 2, yards / size, facing);
    drawGossipPoi(context, radius, placement, {
      icons: game.mapArt?.bitmap(MINIMAP_POI_ICONS_TEXTURE),
      arrow: placement?.kind === "arrow" ? game.mapArt?.bitmap(MINIMAP_GUIDE_ARROW_TEXTURE) : undefined,
    }, poi);
  }

  drawPlayerArrow(context, size, position.orientation);
}

/** Keeps the map only where the mask says; a plain circle until the mask has landed. */
function maskMap(context: CanvasRenderingContext2D, size: number): void {
  const mask = game.mapArt?.bitmap(MINIMAP_MASK_TEXTURE);
  context.save();
  context.globalCompositeOperation = "destination-in";
  if (mask) {
    context.drawImage(mask, 0, 0, size, size);
  } else {
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawTiles(
  context: CanvasRenderingContext2D,
  size: number,
  mapId: number,
  position: WorldPoint,
): void {
  const tiles = game.minimapTiles;
  if (!tiles) return;
  // Screen pixels per sheet pixel. The sheet is 256 pixels to an ADT cell, whatever the zoom.
  const yards = currentYards();
  const scale = size / (yards / MINIMAP_YARDS_PER_PIXEL);
  const centre = minimapPixel(position.x, position.y);
  const here = minimapTileOf(position.x, position.y);
  // Enough cells to cover the circle's corners at this zoom, which is one either side even at the
  // widest: a tile is 533 yards and the widest circle is 467.
  const reach = Math.ceil(yards / 2 / (MINIMAP_TILE_PIXELS * MINIMAP_YARDS_PER_PIXEL)) + 1;
  context.imageSmoothingEnabled = true;
  const shift = size * MINIMAP_TILE_SHIFT_FRACTION;
  context.translate(-shift, -shift);
  // 03.11: only over the tiles that are there: where there is none the circle stays empty, not tinted.
  const lit = new Path2D();
  for (let gridX = here.gridX - reach; gridX <= here.gridX + reach; gridX++) {
    for (let gridY = here.gridY - reach; gridY <= here.gridY + reach; gridY++) {
      const bitmap = tiles.tile(mapId, gridX, gridY);
      if (!bitmap) continue;
      // A tile's own corner on the sheet, then where that corner falls on the screen. `row` is
      // south and `column` is east, which is down and right — the same as the canvas.
      const left = (gridY * MINIMAP_TILE_PIXELS - centre.column) * scale;
      const top = (gridX * MINIMAP_TILE_PIXELS - centre.row) * scale;
      const side = MINIMAP_TILE_PIXELS * scale;
      // Half a pixel of overlap: neighbouring tiles otherwise show a hairline of background
      // between them wherever the scale lands on a fraction.
      context.drawImage(bitmap, left, top, side + 0.5, side + 0.5);
      lit.rect(left, top, side + 0.5, side + 0.5);
    }
  }
  const tint = currentTileTint(mapId, position);
  if (tint) {
    context.save();
    context.globalCompositeOperation = "multiply";
    context.fillStyle = tint;
    context.fill(lit);
    context.restore();
  }
}

/** 03.11: the world light where the character stands, as the multiplier of the terrain tiles; undefined until it has landed. */
function currentTileTint(mapId: number, position: WorldPoint): string | undefined {
  const time = game.world?.currentGameTime();
  const sample = time ? game.light?.sample(mapId, position.x, position.y, halfMinuteOfDay(time)) : undefined;
  if (!sample) return undefined;
  const [r, g, b] = minimapTileTint(sample.colours.ambient, sample.colours.diffuse);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

type IconSheet = "party" | "objects" | "poi";

interface Blip {
  /** Where it stands in the world; projected onto the circle only when it is painted. */
  at: WorldPoint;
  sheet: IconSheet;
  cell: MinimapIconCell;
}

/** Something past the map, told by an arrow on the rim. */
interface RimArrow {
  at: WorldPoint;
  texture: string;
}

/** Everything the state contributes to the circle, in painter order. */
interface MinimapBlips {
  readonly blips: readonly Blip[];
  readonly arrows: readonly RimArrow[];
}

/**
 * The blips as plain values, in painter order: two equal signatures paint the same icons.
 *
 * World positions rather than circle pixels, so the character's own small steps stay with the
 * rounded key that has always decided them, and only something else moving asks from here.
 */
function blipSignature(collected: MinimapBlips): unknown[] {
  const signature: unknown[] = [];
  for (const blip of collected.blips) signature.push(blip.at.x, blip.at.y, blip.sheet, blip.cell.column, blip.cell.row);
  signature.push(collected.arrows.length);
  for (const arrow of collected.arrows) signature.push(arrow.at.x, arrow.at.y, arrow.texture);
  return signature;
}

function sameBlipSignature(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

/** How far inside the rim a ping is parked, in pixels: at the full radius it would sit under the border. */
const BLIP_RIM_INSET = 4;

/** The world position a blip is kept at: a copy, so the signature is what was collected. */
function blipAt(point: WorldPoint): WorldPoint {
  return { x: point.x, y: point.y };
}

/** 03.11: the AreaPOI of this map that may get an arrow, recounted when the snapshot or the map changes. */
let rimPois: { data: object; mapId: number; list: readonly MinimapRimPoi[] } | undefined;

function rimPoisOfMap(mapId: number | undefined): readonly MinimapRimPoi[] {
  const data = game.areas?.snapshot();
  if (!data || mapId === undefined) return [];
  if (rimPois?.data !== data || rimPois.mapId !== mapId) rimPois = { data, mapId, list: minimapRimPois(data.areaPois, mapId) };
  return rimPois.list;
}

/**
 * Every icon and arrow the state puts on the circle, gathered in one walk of the object table.
 *
 * 03.11, measured on rings of fake objects round the character: past the circle nothing gets an icon, and only the
 * party, the corpse and the AreaPOI get an arrow. A target, a lootable body and a plain NPC get nothing at all; a quest
 * giver's icon wins over tracking.
 */
function collectBlips(position: WorldPoint, state: WorldState): MinimapBlips {
  const world = game.world;
  const radiusYards = currentYards() / 2;
  const blips: Blip[] = [];
  const arrows: RimArrow[] = [];

  // 4.06: a member out of sight stays, at the whole-yard position SMSG_PARTY_MEMBER_STATS carries.
  if (world?.group?.members.length) {
    for (const member of partyBlipMembers(world, (zoneId) => game.areas?.area(zoneId)?.mapId)) {
      // The member record is a fresh copy per collection, so it is the blip's position as it is.
      if (minimapPastRim(position, member, radiusYards)) {
        arrows.push({ at: member, texture: MINIMAP_GROUP_ARROW_TEXTURE });
      } else {
        // Out of sight the class is the name answer's, as it is for Wow.exe.
        const object = state.objects.get(member.guid);
        const classId = object ? unitField.classId(object) : world.names?.details?.(member.guid)?.classId;
        blips.push({ at: member, sheet: "party", cell: minimapPartyCell(classId) });
      }
    }
  }

  // A single pass covers quest marks and tracking. In a crowded city this otherwise walked the
  // whole object table twice on every repaint while moving.
  const reachSquared = radiusYards * radiusYards;
  const questStatus = world?.questGiverStatus;
  const tracks = trackingMatcher(state, world?.mapId);
  const trivial = trivialQuestsTracked();
  for (const object of state.objects.values()) {
    const objectPosition = object.position;
    if (!objectPosition || (object.typeId !== 3 && object.typeId !== 4 && object.typeId !== 5)) continue;
    const dx = objectPosition.x - position.x;
    const dy = objectPosition.y - position.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared > reachSquared) continue;
    const status = object.typeId !== 5 ? questStatus?.get(object.guid) : undefined;
    const quest = status === undefined ? undefined : minimapQuestCell(status, trivial);
    if (quest) {
      blips.push({ at: blipAt(objectPosition), sheet: "objects", cell: quest });
      continue;
    }
    const town = townTrackedCell(object);
    if (town) {
      blips.push({ at: blipAt(objectPosition), sheet: "objects", cell: town });
      continue;
    }
    if (tracks?.(object, distanceSquared)) {
      blips.push({
        at: blipAt(objectPosition),
        sheet: "objects",
        cell: object.typeId === 5 ? MINIMAP_TOWN_CELL : minimapTrackedCell(reactionTo(object)),
      });
    }
  }

  // The player's own corpse: a tombstone on the map, an arrow at any distance past it. Only on the same map: an
  // instance corpse is reported at its entrance map (`CorpseLocation.mapId`), and a mark there would be wrong.
  const self = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  const corpse = self && isPlayerGhost(self) ? world?.corpse : undefined;
  if (corpse?.found && corpse.mapId === world?.mapId) {
    const at = { x: corpse.x, y: corpse.y };
    if (minimapPastRim(position, at, radiusYards)) arrows.push({ at, texture: MINIMAP_CORPSE_ARROW_TEXTURE });
    else blips.push({ at, sheet: "poi", cell: { column: MINIMAP_CORPSE_POI_ICON, row: 0 } });
  }

  // Quest markers, drawn as the centre of the blob rather than its outline: the frame is 140
  // units across and a polygon on it is a smudge. Not measured: the stand has no quest log.
  for (const blobs of world?.questPoi.values() ?? []) {
    for (const blob of blobs) {
      if (blob.map !== world?.mapId || blob.points.length === 0) continue;
      let x = 0;
      let y = 0;
      for (let index = 0; index < blob.points.length; index++) {
        const point = blob.points[index]!;
        x += point.x / blob.points.length;
        y += point.y / blob.points.length;
      }
      blips.push({ at: { x, y }, sheet: "objects", cell: MINIMAP_TOWN_CELL });
    }
  }

  // 03.11: the towns of AreaPOI.dbc, but not over a building's pictures: neither the inn nor the city had one.
  if (!insideNow) {
    for (const poi of rimPoisOfMap(world?.mapId)) {
      if (minimapPoiHasArrow(position, poi, radiusYards)) arrows.push({ at: poi, texture: MINIMAP_POI_ARROW_TEXTURE });
    }
  }
  return { blips, arrows };
}

const ICON_SHEETS: Readonly<Record<IconSheet, string>> = {
  party: MINIMAP_PARTY_BLIPS_TEXTURE,
  objects: MINIMAP_OBJECT_ICONS_TEXTURE,
  poi: MINIMAP_POI_ICONS_TEXTURE,
};

/** The context stands at the centre of the circle. An icon whose sheet has not landed waits for it. */
function drawIcons(
  context: CanvasRenderingContext2D,
  size: number,
  position: WorldPoint,
  collected: MinimapBlips,
  facing: number | undefined,
): void {
  const yardsPerPixel = currentYards() / size;
  const side = MINIMAP_ICON_UNITS * (size / MINIMAP_UNITS);
  for (const blip of collected.blips) {
    const bitmap = game.mapArt?.bitmap(ICON_SHEETS[blip.sheet]);
    if (!bitmap) continue;
    const point = minimapBlip(position, blip.at, yardsPerPixel, facing);
    let sx: number, sy: number, cell: number;
    if (blip.sheet === "poi") {
      const poi = minimapPoiIconCell(blip.cell.column);
      sx = poi.x; sy = poi.y; cell = poi.size;
    } else {
      cell = blip.sheet === "party" ? MINIMAP_PARTY_CELL : MINIMAP_OBJECT_CELL;
      sx = blip.cell.column * cell; sy = blip.cell.row * cell;
    }
    context.drawImage(bitmap, sx, sy, cell, cell, point.column - side / 2, point.row - side / 2, side, side);
  }
}

function drawPings(
  context: CanvasRenderingContext2D,
  radius: number,
  position: WorldPoint,
  yardsPerPixel: number,
  now: number,
  facing: number | undefined,
): void {
  for (let index = pings.length - 1; index >= 0; index--) {
    const ping = pings[index]!;
    if (ping.until <= now) {
      pings.splice(index, 1);
      continue;
    }
    const point = clampToCircle(minimapBlip(position, ping, yardsPerPixel, facing), radius - BLIP_RIM_INSET);
    const age = 1 - (ping.until - now) / 5_000;
    context.beginPath();
    context.arc(point.column, point.row, 3 + age * 10, 0, Math.PI * 2);
    context.strokeStyle = `rgba(255, 227, 110, ${(1 - age).toFixed(2)})`;
    context.lineWidth = 2;
    context.stroke();
  }
}

/** The context stands at the centre. Each arrow's picture points up, turned towards what it names. */
function drawRimArrows(
  context: CanvasRenderingContext2D,
  size: number,
  position: WorldPoint,
  collected: MinimapBlips,
  facing: number | undefined,
): void {
  const side = MINIMAP_RIM_ARROW_UNITS * (size / MINIMAP_UNITS);
  const centre = (size / 2) * MINIMAP_RIM_FRACTION;
  for (const arrow of collected.arrows) {
    const bitmap = game.mapArt?.bitmap(arrow.texture);
    if (!bitmap) continue;
    context.save();
    context.rotate(minimapRimAngle(position, arrow.at, facing));
    context.drawImage(bitmap, -side / 2, -centre - side / 2, side, side);
    context.restore();
  }
}

function drawPlayerArrow(context: CanvasRenderingContext2D, size: number, orientation: number): void {
  const bitmap = game.mapArt?.bitmap(MINIMAP_PLAYER_ARROW_TEXTURE);
  if (!bitmap) return;
  const side = MINIMAP_PLAYER_ARROW_UNITS * (size / MINIMAP_UNITS);
  context.save();
  context.translate(size / 2, size / 2);
  // With the map turning under it the arrow is always up; with north up it turns instead. The sign
  // is the inverse of the rotation the frame was drawn with.
  if (!settings.rotate) context.rotate(-orientation);
  context.drawImage(bitmap, -side / 2, -side / 2, side, side);
  context.restore();
}

function updateLabels(
  view: MinimapParts,
  world: NonNullable<typeof game.world>,
  position: WorldPoint,
  now: number,
): void {
  const time = world.currentGameTime(now);
  const clockText = time ? formatGameTime(time) : "";
  // The clock changes once a game minute but used to be formatted and written 60 times a second.
  if (view.clock.textContent !== clockText) view.clock.textContent = clockText;

  // The server never says which sub-area the character is in — `SMSG_INIT_WORLD_STATES` arrives on
  // a zone change and there is no packet at all for a sub-area — so it is counted from the map
  // tile's own 16×16 area grid, which is the ground half of what `Map::GetAreaId` does.
  if (now - zoneCheckedAt < ZONE_INTERVAL) return;
  zoneCheckedAt = now;
  // 05.10-A7b-4 (7.13): the located area — a WMO room's WMOAreaTable area, the grid, then Map.AreaTableID.
  const areaId = liveAreaIdAt(world.mapId, position.x, position.y);
  if (areaId !== zoneAreaId) zoneAreaId = areaId;
  const areas = game.areas;
  const area = areas?.area(zoneAreaId);
  const zone = areas?.zoneOf(zoneAreaId);
  // 05.10-A7b-4 (7.13): a room's names over the outdoor ones (AreaLocator.ts `indoorZoneTexts`).
  const texts = liveIndoorZoneTexts(
    zone?.name ?? areas?.map(world.mapId ?? 0)?.name ?? "",
    area && zone && area.id !== zone.id ? area.name : "",
    area?.name ?? "",
  );
  const zoneText = texts.zoneText;
  if (view.zone.textContent !== zoneText) view.zone.textContent = zoneText;
  const subzoneText = texts.subZoneText;
  if (view.subzone.textContent !== subzoneText) view.subzone.textContent = subzoneText;
}

/**
 * The area the character is standing in, counted from the map tile's own 16×16 area grid.
 *
 * Cached between frames because the world map asks for it too, and computed on demand when it is
 * asked for before the frame has run — opening the map is not a reason to be told "nowhere".
 */
export function currentAreaId(): number {
  if (zoneAreaId !== 0) return zoneAreaId;
  const world = game.world;
  const self = playerOf(world?.state);
  if (world && self?.position) {
    zoneAreaId = liveAreaIdAt(world.mapId, self.position.x, self.position.y); // 05.10-A7b-4
  }
  return zoneAreaId;
}

/**
 * 1.17: a far teleport within the map. The cached zone belongs to the point that was left, so the
 * next frame re-reads it at once instead of waiting out `ZONE_INTERVAL`; the frame stays shown, its
 * pings (same map, same coordinates) stay, and the old name stands until that frame replaces it.
 */
export function forgetMinimapZone(): void {
  zoneAreaId = 0;
  zoneCheckedAt = 0;
  lastDrawKey = "";
}

/** Dropped when leaving a realm, so the next one does not inherit a zone name or a ping. */
export function forgetMinimap(): void {
  zoneAreaId = 0;
  zoneCheckedAt = 0;
  pings.length = 0;
  // The canvas keeps its pixels through a world change; the next frame must not be skipped on the
  // strength of a key that describes the world that just left.
  lastDrawKey = "";
  lastDrawWorld = undefined;
  lastDrawAt = Number.NEGATIVE_INFINITY;
  lastDrawRevision = Number.NaN;
  lastBlipSignature = [];
  if (parts) {
    parts.zone.textContent = "";
    parts.subzone.textContent = "";
    parts.root.hidden = true;
  }
}

/** Re-exported for the tracking menu and the world map, which share the frame's own settings. */
export function minimapSettings(): Readonly<MinimapSettings> {
  return settings;
}
