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
import { formatGameTime } from "../../world/GameTimeProtocol.js";
import { rightRail } from "./Dom.js";
import { skinnable, slot } from "./Slots.js";
import { toggleTrackingMenu, trackingMatcher } from "./Tracking.js";
import { toggleWorldMap } from "./WorldMap.js";
import { setTip } from "./Widgets.js";
import { partyBlipMembers } from "../game/PartyPositions.js";
// 05.10-A7b-4 (7.13/7.14): the located area (WMO room → grid → map) and the building's own minimap.
import { drawLiveWmoMinimap, liveAreaIdAt, liveIndoorZoneTexts, liveWmoMinimapRevision } from "../AreaLocatorLive.js";

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

/** Yards across the circle. The middle one is about what the original client opens at. */
const ZOOM_LEVELS = [100, 133, 200, 266, 400] as const;
const STORAGE_KEY = "webclient.minimap";
/** How often the zone under the character is recounted; every frame is a lookup for nothing. */
const ZONE_INTERVAL = 250;

interface MinimapSettings {
  zoom: number;
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
    const zoom = ZOOM_LEVELS.indexOf((stored?.zoom ?? 0) as (typeof ZOOM_LEVELS)[number]) >= 0 ? stored!.zoom! : 266;
    return { zoom, rotate: stored?.rotate === true };
  } catch {
    return { zoom: 266, rotate: false };
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
  const out = controlButton("−", "Отдалить", () => changeZoom(1));
  const into = controlButton("+", "Приблизить", () => changeZoom(-1));
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
  const index = ZOOM_LEVELS.indexOf(settings.zoom as (typeof ZOOM_LEVELS)[number]);
  out.disabled = index >= ZOOM_LEVELS.length - 1;
  into.disabled = index <= 0;
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
  changeZoom(direction === "in" ? -1 : 1);
}

function changeZoom(step: number): void {
  const index = ZOOM_LEVELS.indexOf(settings.zoom as (typeof ZOOM_LEVELS)[number]);
  setMinimapZoomIndex((index < 0 ? ZOOM_LEVELS.length - 2 : index) + step);
}

function setMinimapZoomIndex(index: number): void {
  if (!Number.isFinite(index)) return;
  const next = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, Math.trunc(index)))];
  if (next === undefined || next === settings.zoom) return;
  settings = { ...settings, zoom: next };
  writeSettings();
  refreshMinimapControls();
}

/**
 * FrameXML's Minimap:GetZoom() is a distance index, where increasing the value zooms in.  The
 * native minimap stores the corresponding yards-across values in ascending order, so the bridge
 * has to reverse the index at this boundary.  Native +/- controls intentionally keep using the
 * local index above: their callbacks already express the correct visual direction.
 */
function frameXmlZoomIndex(): number {
  const index = ZOOM_LEVELS.indexOf(settings.zoom as (typeof ZOOM_LEVELS)[number]);
  return index >= 0 ? ZOOM_LEVELS.length - 1 - index : ZOOM_LEVELS.length - 2;
}

function setFrameXmlZoomIndex(index: number): void {
  if (!Number.isFinite(index)) return;
  const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, Math.trunc(index)));
  setMinimapZoomIndex(ZOOM_LEVELS.length - 1 - clamped);
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
    settings.zoom / size,
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
  getZoom: frameXmlZoomIndex,
  getZoomLevels: () => ZOOM_LEVELS.length,
  setZoom: setFrameXmlZoomIndex,
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
  if (!world || !self?.position || world.mapId === undefined) {
    if (parts && !parts.root.hidden) parts.root.hidden = true;
    return;
  }
  parts ??= build();
  if (parts.root.hidden) parts.root.hidden = false;

  const size = resize(parts.canvas, parts.context, adoptedMinimapSize(parts.canvas));
  // The canvas is a repaint, not a transform: sixty passes a second cost the same when nothing
  // has changed, and nothing that matters lands between two of them while the player stands still.
  // The clock keeps the map honest at a much lower rate, and anything that moves — the character,
  // the wheel, the zone's tiles, the state itself — asks for the frame immediately. A live ping is
  // the one thing that animates on its own, so it redraws at the frame rate it always did.
  const animating = pings.length > 0;
  const key = `${world.mapId}|${Math.round(self.position.x * 8)}|${Math.round(self.position.y * 8)}`
    + `|${Math.round(self.position.orientation * 256)}|${size}`
    + `|${game.minimapTiles?.revision ?? -1}|${settings.zoom}|${settings.rotate ? 1 : 0}`
    + `|${liveWmoMinimapRevision()}`; // 05.10-A7b-4 (7.14): the floor's building and its answer
  // The state is what the blips are made of, and it used to be in the key as its revision — which
  // every packet about anybody moves, so in a crowd the whole circle was repainted every frame for
  // neighbours far outside it. When the revision has moved, the blips are collected (one walk of
  // the object table, which the repaint needs anyway) and compared with the ones on the canvas;
  // only a blip that appeared, went or moved asks for the frame.
  const stateMoved = world.state.revision !== lastDrawRevision || lastDrawWorld !== world;
  lastDrawRevision = world.state.revision;
  let blips = stateMoved ? collectBlips(size / 2, self.position, world.state) : undefined;
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
    blips = collectBlips(size / 2, self.position, world.state);
    signature = blipSignature(blips);
  }
  lastBlipSignature = signature;
  drawMinimap(parts.context, size, world.mapId, self.position, blips, now);
  updateLabels(parts, world, self.position, now);
}

/** CSS pixels for drawing, device pixels for the backing store: the same scheme the scene uses. */
function resize(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, authoredSize?: number): number {
  const size = authoredSize ?? (canvas.clientWidth || numericCssPixels(readStyle(canvas.style, "width")) || 160);
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pixels = Math.round(size * ratio);
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return size;
}

function drawMinimap(
  context: CanvasRenderingContext2D,
  size: number,
  mapId: number,
  position: { x: number; y: number; z?: number; orientation: number },
  blips: MinimapBlips,
  now: number,
): void {
  const radius = size / 2;
  context.clearRect(0, 0, size, size);
  context.save();
  context.beginPath();
  context.arc(radius, radius, radius - 1, 0, Math.PI * 2);
  context.clip();
  context.fillStyle = "#0b1014";
  context.fillRect(0, 0, size, size);

  context.translate(radius, radius);
  if (settings.rotate) context.rotate(position.orientation);
  // 05.10-A7b-4 (7.14): in an interior room of a building with bakes, its pictures replace the ADT tiles.
  if (drawLiveWmoMinimap(context, mapId, position, size / (settings.zoom / MINIMAP_YARDS_PER_PIXEL)) === 0) {
    drawTiles(context, size, mapId, position);
  }
  drawBlips(context, radius, position, blips, now);
  context.restore();

  drawPlayerArrow(context, radius, position.orientation);

  context.beginPath();
  context.arc(radius, radius, radius - 1, 0, Math.PI * 2);
  context.strokeStyle = "#b79b58";
  context.lineWidth = 2;
  context.stroke();
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
  const scale = size / (settings.zoom / MINIMAP_YARDS_PER_PIXEL);
  const centre = minimapPixel(position.x, position.y);
  const here = minimapTileOf(position.x, position.y);
  // Enough cells to cover the circle's corners at this zoom, which is one either side even at the
  // widest: a tile is 533 yards and the widest circle is 400.
  const reach = Math.ceil(settings.zoom / 2 / (MINIMAP_TILE_PIXELS * MINIMAP_YARDS_PER_PIXEL)) + 1;
  context.imageSmoothingEnabled = true;
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
    }
  }
}

interface Blip {
  /** Where it stands in the world; projected onto the circle only when it is painted. */
  at: WorldPoint;
  colour: string;
  size: number;
  ring?: boolean;
}

interface QuestMark {
  at: WorldPoint;
  mark: string;
}

/** Everything the state contributes to the circle, in painter order. */
interface MinimapBlips {
  readonly blips: readonly Blip[];
  readonly questMarks: readonly QuestMark[];
}

/**
 * The blips as plain values, in painter order: two equal signatures paint the same dots.
 *
 * World positions rather than circle pixels, so the character's own small steps stay with the
 * rounded key that has always decided them, and only something else moving asks from here.
 */
function blipSignature(collected: MinimapBlips): unknown[] {
  const signature: unknown[] = [];
  for (const blip of collected.blips) signature.push(blip.at.x, blip.at.y, blip.colour, blip.size, blip.ring === true);
  signature.push(collected.questMarks.length);
  for (const mark of collected.questMarks) signature.push(mark.at.x, mark.at.y, mark.mark);
  return signature;
}

function sameBlipSignature(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * How far inside the rim every blip is parked, in pixels.
 *
 * The frame's edge is a 2 px stroke on the circle at `radius - 1` (`drawMinimap` above), so a dot
 * at the full radius would be sitting on it. Named rather than spelled out at each of the three
 * places it is used, because the corpse dot's *range* is worked out from it: the loop below clamps
 * every blip to `radius - BLIP_RIM_INSET`, so a dot admitted from further out than that would be
 * pinned to the same ring of pixels as every other dot out there.
 */
const BLIP_RIM_INSET = 4;

/**
 * The `!`/`?` over a quest giver on the minimap.
 *
 * The plate twin is `questMarkFor` in QuestLog.ts; kept as a separate pure function so the
 * minimap never imports the QuestLog's UI ring. Only "something here for you" statuses mark;
 * the rest draw nothing.
 */
export function minimapQuestMark(status: number): "!" | "?" | undefined {
  if (status === QUEST_STATUS_REWARD || status === QUEST_STATUS_REWARD2
    || status === QUEST_STATUS_REWARD_REP || status === QUEST_STATUS_LOW_LEVEL_REWARD_REP) return "?";
  if (status === QUEST_STATUS_AVAILABLE || status === QUEST_STATUS_AVAILABLE_REP
    || status === QUEST_STATUS_LOW_LEVEL_AVAILABLE || status === QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP) return "!";
  return undefined;
}

/** The world position a blip is kept at: a copy, so the signature is what was collected. */
function blipAt(point: WorldPoint): WorldPoint {
  return { x: point.x, y: point.y };
}

/** Every dot and mark the state puts on the circle, gathered in one walk of the object table. */
function collectBlips(radius: number, position: WorldPoint, state: WorldState): MinimapBlips {
  const world = game.world;
  const yardsPerPixel = settings.zoom / (radius * 2);
  const blips: Blip[] = [];

  // The party. The original client shows these and nothing else by default, and they are the one
  // thing a minimap is genuinely needed for.
  // 4.06: a member out of sight stays, at the whole-yard position SMSG_PARTY_MEMBER_STATS carries,
  // drawn smaller and paler so a rounded point does not pass for an exact one.
  if (world?.group?.members.length) {
    for (const member of partyBlipMembers(world, (zoneId) => game.areas?.area(zoneId)?.mapId)) {
      // The member record is a fresh copy per collection, so it is the blip's position as it is.
      blips.push(member.precise
        ? { at: member, colour: "#65a9ff", size: 3.5 }
        : { at: member, colour: "#65a9ff99", size: 2.5 });
    }
  }

  // The target, so that what the character is fighting is findable when it runs.
  const target = world?.targetGuid === undefined ? undefined : state.objects.get(world.targetGuid);
  if (target?.position && !isWorldObjectDead(target)) {
    blips.push({ at: blipAt(target.position), colour: "#ffe36e", size: 4, ring: true });
  }

  // Bodies that still hold something, strictly by `UNIT_DYNFLAG_LOOTABLE` — no guess from health,
  // no memory of who killed what. The reference client draws the same dot off the same bit
  // (`wowee/src/ui/game_screen_minimap.cpp:738-758`) and in the same yellow-green.
  //
  // Ranged rather than clamped, unlike the target above: a corpse is a place to walk back to, and
  // a dot pinned to the rim would say «somewhere that way» about every kill made in the zone.
  //
  // The range is the clamp's own radius rather than the circle's, and that is the whole of the
  // difference between saying it and doing it. `settings.zoom / 2` is exactly `radius` pixels, so
  // the four pixels the loop below insets by were four pixels of dots that had been clamped after
  // all: at the default 160 px frame and 266 yards across, 1.6625 yards to the pixel, every body
  // between 126.35 and 133 yards was drawn on the same circle of radius 76 — 5% of the radius and
  // 9.75% of the area of the map.
  //
  // A single pass covers corpses, quest marks and tracking. In a crowded city this otherwise
  // walked the whole object table twice on every repaint while moving.
  const reach = (radius - BLIP_RIM_INSET) * yardsPerPixel;
  const reachSquared = reach * reach;
  const questStatus = world?.questGiverStatus;
  const tracks = trackingMatcher(state, world?.mapId);
  // Keep tracked dots after loot dots in painter order, even though both are gathered together.
  const trackedBlips: Blip[] = [];
  const questMarks: QuestMark[] = [];
  for (const object of state.objects.values()) {
    const objectPosition = object.position;
    if (!objectPosition || (object.typeId !== 3 && object.typeId !== 4 && object.typeId !== 5)) continue;
    const dx = objectPosition.x - position.x;
    const dy = objectPosition.y - position.y;
    const distanceSquared = dx * dx + dy * dy;
    if (object.typeId === 3 && distanceSquared <= reachSquared) {
      if (isWorldObjectDead(object) && isLootable(object)) {
        blips.push({ at: blipAt(objectPosition), colour: "#b4e650", size: 3 });
      }
    }
    if ((object.typeId === 3 || object.typeId === 4) && questStatus !== undefined && distanceSquared <= reachSquared) {
      const status = questStatus.get(object.guid);
      const mark = status === undefined ? undefined : minimapQuestMark(status);
      if (mark) questMarks.push({ at: blipAt(objectPosition), mark });
    }
    if (tracks?.(object, distanceSquared)) {
      trackedBlips.push({ at: blipAt(objectPosition), colour: "#f2a63b", size: 3, ring: true });
    }
  }

  // Whatever the character is tracking. Which creatures and which resources those are is a pair of
  // bit fields the server keeps on the player; nothing announces them.
  for (const blip of trackedBlips) blips.push(blip);

  // The player's own corpse, so a ghost can walk back to it. Clamped to the rim by the
  // loop below like every other blip, which turns a far corpse into a direction instead of
  // hiding it. Only on the same map: an instance corpse is reported at its entrance map
  // (`CorpseLocation.mapId`), and a dot there would point at the wrong place.
  const self = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  const corpse = self && isPlayerGhost(self) ? world?.corpse : undefined;
  if (corpse?.found && corpse.mapId === world?.mapId) {
    blips.push({
      at: { x: corpse.x, y: corpse.y },
      colour: "#ff5a5a", size: 4, ring: true,
    });
  }

  // Quest givers: the same `!`/`?` the plates carry (`questMarkFor` in QuestLog.ts is the
  // canonical twin; this reads the status map directly so the minimap does not join the
  // QuestLog→Npc→Settings import ring). Text, not dots: a dot cannot say which of the two it is.
  // (Collected in the object pass above.)

  // Quest markers, drawn as the centre of the blob rather than its outline: the frame is 160
  // pixels across and a polygon on it is a smudge.
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
      blips.push({ at: { x, y }, colour: "#f0c94a", size: 3 });
    }
  }
  return { blips, questMarks };
}

function drawBlips(
  context: CanvasRenderingContext2D,
  radius: number,
  position: WorldPoint,
  collected: MinimapBlips,
  now: number,
): void {
  const yardsPerPixel = settings.zoom / (radius * 2);
  for (const blip of collected.blips) {
    const point = clampToCircle(minimapBlip(position, blip.at, yardsPerPixel), radius - BLIP_RIM_INSET);
    context.beginPath();
    context.arc(point.column, point.row, blip.size, 0, Math.PI * 2);
    context.fillStyle = blip.colour;
    context.fill();
    if (blip.ring) {
      context.strokeStyle = "#000000aa";
      context.lineWidth = 1;
      context.stroke();
    }
  }
  for (const { at: mapAt, mark } of collected.questMarks) {
    const at = clampToCircle(minimapBlip(position, mapAt, yardsPerPixel), radius - BLIP_RIM_INSET);
    context.font = "bold 11px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineWidth = 3;
    context.strokeStyle = "#1b1200";
    context.fillStyle = mark === "?" ? "#ffd24a" : "#7dd87d";
    context.strokeText(mark, at.column, at.row);
    context.fillText(mark, at.column, at.row);
  }

  drawPings(context, radius, position, yardsPerPixel, now);
}

function drawPings(
  context: CanvasRenderingContext2D,
  radius: number,
  position: WorldPoint,
  yardsPerPixel: number,
  now: number,
): void {
  for (let index = pings.length - 1; index >= 0; index--) {
    const ping = pings[index]!;
    if (ping.until <= now) {
      pings.splice(index, 1);
      continue;
    }
    const point = clampToCircle(minimapBlip(position, ping, yardsPerPixel), radius - BLIP_RIM_INSET);
    const age = 1 - (ping.until - now) / 5_000;
    context.beginPath();
    context.arc(point.column, point.row, 3 + age * 10, 0, Math.PI * 2);
    context.strokeStyle = `rgba(255, 227, 110, ${(1 - age).toFixed(2)})`;
    context.lineWidth = 2;
    context.stroke();
  }
}

function drawPlayerArrow(context: CanvasRenderingContext2D, radius: number, orientation: number): void {
  context.save();
  context.translate(radius, radius);
  // With the map turning under it the arrow is always up; with north up it turns instead. The sign
  // is the inverse of the rotation the frame was drawn with.
  if (!settings.rotate) context.rotate(-orientation);
  context.beginPath();
  context.moveTo(0, -7);
  context.lineTo(5, 6);
  context.lineTo(0, 3);
  context.lineTo(-5, 6);
  context.closePath();
  context.fillStyle = "#62e7a3";
  context.strokeStyle = "#04140c";
  context.lineWidth = 1;
  context.fill();
  context.stroke();
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
