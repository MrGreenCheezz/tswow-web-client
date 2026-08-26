import { exploredZones, isAreaExplored } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import type { MapAreaInfo } from "../AreaClient.js";
import {
  hasMapBounds, worldMapPoint, worldMapWorld, WORLD_MAP_FRAME_HEIGHT, WORLD_MAP_FRAME_WIDTH,
} from "../MinimapGeometry.js";
import { currentAreaId } from "./Minimap.js";
import { Panel } from "./Widgets.js";

/**
 * The world map: the client's own parchment art, with the parts the character has not walked into
 * left dark.
 *
 * The art is not one picture. A zone map is twelve 256×256 tiles laid out four across and three
 * down, `Interface\WorldMap\<AreaName>\<AreaName><1..12>.blp` — and `AreaName` is a column of
 * `WorldMapArea`, because 3.3.5's table has no `TextureName` at all. Every one of the 107 names in
 * this dataset resolves; the eighteen multi-floor dungeons spell it `<Name><floor>_<n>.blp`.
 *
 * Exploration is the second layer and the reason the map is worth having. `WorldMapOverlay` names
 * a picture per discovered piece of a zone, and the piece is shown once any of the up-to-four
 * areas it lists has its bit set in `PLAYER_EXPLORED_ZONES_1`. The overlay's picture does **not**
 * live in a directory of its own — it sits in the parent zone's, which is the one thing about this
 * table that cannot be guessed: probed the obvious way the hit rate is 0 of 886, and probed in the
 * parent's directory it is 884.
 */

/** Four across and three down, 256 to a tile: the shape every world map picture is cut into. */
const TILE_COLUMNS = 4;
const TILE_ROWS = 3;
const TILE_SIZE = 256;
// The source art is four by three 256px tiles, but the original UI's detail frame clips it to
// 1002x668.  Keep drawing at tile coordinates and let the canvas clip the same spare right/bottom
// pixels; projecting markers into 1024x768 was the reason they drifted progressively across maps.
const ART_WIDTH = WORLD_MAP_FRAME_WIDTH;
const ART_HEIGHT = WORLD_MAP_FRAME_HEIGHT;

interface WorldMapParts {
  panel: Panel;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  picker: HTMLSelectElement;
  continentButton: HTMLButtonElement;
  status: HTMLElement;
}

let parts: WorldMapParts | undefined;
/** Which map area is on screen. Follows the character until the player picks another. */
let shownMapAreaId = 0;
let pinned = false;
/**
 * The art revision the canvas was last drawn at.
 *
 * Without it the map is a black rectangle: the pictures arrive over the next second or two and
 * `showWorldMap` is only called on events, so a player who opens the map and stands still sees the
 * empty backing colour for as long as they look at it. The minimap hid the same bug behind being
 * redrawn every frame.
 */
let drawnAtRevision = -1;
/**
 * Where the arrow was last drawn, quantised.
 *
 * The map redrew only when a picture landed, so the arrow, the party pins and the zone the map
 * follows were all frozen at whatever they were when the player opened it: walk across Elwynn with
 * the map open and the arrow stays where you opened it. Quantised because the alternative is
 * redrawing a parchment, its overlays, its quest blobs and its party pins sixty times a second for
 * a marker that has moved a fraction of a pixel — a yard is well under one pixel on a zone map, and
 * a tenth of a radian is about six degrees of arrow.
 */
let drawnAt: { x: number; y: number; orientation: number; area: number } | undefined;
/** A yard of walking and about six degrees of turning. */
const MAP_MOVE_STEP = 1;
const MAP_TURN_STEP = 0.1;

/** Called once a frame. Redraws when the art lands, and when the character has actually moved. */
export function updateWorldMap(): void {
  if (!parts?.panel.visible) return;
  const revision = game.mapArt?.revision ?? 0;
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const position = self?.position;
  const moved = position !== undefined && (
    drawnAt === undefined
    || drawnAt.area !== shownMapAreaId
    || Math.abs(position.x - drawnAt.x) >= MAP_MOVE_STEP
    || Math.abs(position.y - drawnAt.y) >= MAP_MOVE_STEP
    || Math.abs(position.orientation - drawnAt.orientation) >= MAP_TURN_STEP
  );
  if (revision === drawnAtRevision && !moved) return;
  showWorldMap();
  drawnAt = position
    ? { x: position.x, y: position.y, orientation: position.orientation, area: shownMapAreaId }
    : undefined;
}

export function toggleWorldMap(): void {
  parts ??= build();
  parts.panel.toggle();
  if (parts.panel.visible) {
    pinned = false;
    drawnAtRevision = -1;
    showWorldMap();
  }
}

export function worldMapOpen(): boolean {
  return parts?.panel.visible === true;
}

export function closeWorldMap(): void {
  parts?.panel.hide();
}

function build(): WorldMapParts {
  const panel = new Panel({ id: "world-map", title: "Карта мира", className: "world-map" });
  const bar = document.createElement("div");
  bar.className = "world-map-bar";
  const picker = document.createElement("select");
  picker.className = "world-map-picker";
  picker.addEventListener("change", () => {
    shownMapAreaId = Number(picker.value);
    pinned = true;
    showWorldMap();
  });
  const continentButton = document.createElement("button");
  continentButton.type = "button";
  continentButton.textContent = "Континент";
  continentButton.addEventListener("click", () => {
    const mapId = game.world?.mapId ?? 0;
    const continent = game.areas?.continentMapArea(mapId);
    if (!continent) return;
    shownMapAreaId = continent.id;
    pinned = true;
    showWorldMap();
  });
  const here = document.createElement("button");
  here.type = "button";
  here.textContent = "Где я";
  here.addEventListener("click", () => {
    pinned = false;
    showWorldMap();
  });
  bar.append(picker, continentButton, here);

  const canvas = document.createElement("canvas");
  canvas.className = "world-map-canvas";
  canvas.width = ART_WIDTH;
  canvas.height = ART_HEIGHT;
  canvas.setAttribute("aria-label", "Карта мира");
  const status = document.createElement("p");
  status.className = "muted world-map-status";

  panel.body.append(bar, canvas, status);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The world map needs a 2D canvas context");
  return { panel, canvas, context, picker, continentButton, status };
}

/** Redraws whatever is on screen. Cheap: the pictures are cached bitmaps. */
export function showWorldMap(): void {
  if (!parts?.panel.visible) return;
  const world = game.world;
  const areas = game.areas;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!world || !areas?.ready || world.mapId === undefined) {
    parts.status.textContent = "Данные зон ещё не загружены";
    return;
  }

  // Follow the character unless the player has picked a map to stay on.
  if (!pinned) {
    const here = areas.mapAreaOfArea(currentAreaId()) ?? areas.continentMapArea(world.mapId);
    if (here) shownMapAreaId = here.id;
  }
  const shown = areas.mapArea(shownMapAreaId) ?? areas.continentMapArea(world.mapId);
  if (!shown) {
    parts.status.textContent = `Для карты ${world.mapId} нет изображения`;
    parts.context.clearRect(0, 0, ART_WIDTH, ART_HEIGHT);
    return;
  }
  shownMapAreaId = shown.id;
  fillPicker(parts.picker, areas.mapAreasOf(world.mapId), shown.id);
  parts.panel.title = `Карта · ${zoneName(shown)}`;

  drawnAtRevision = game.mapArt?.revision ?? 0;
  drawArt(parts.context, shown);
  const explored = drawOverlays(parts.context, shown, self);
  drawMarkers(parts.context, shown, self);

  const overlays = areas.overlaysOf(shown.id).length;
  parts.status.textContent = overlays > 0
    ? `Исследовано областей: ${explored} из ${overlays}`
    : "У этой карты нет областей исследования";
}

function zoneName(mapArea: MapAreaInfo): string {
  const areas = game.areas;
  return (mapArea.areaId > 0 ? areas?.area(mapArea.areaId)?.name : undefined)
    ?? areas?.map(mapArea.mapId)?.name
    ?? mapArea.name;
}

function fillPicker(picker: HTMLSelectElement, mapAreas: readonly MapAreaInfo[], selected: number): void {
  const wanted = mapAreas.map((area) => `${area.id}:${zoneName(area)}`).join("|");
  if (picker.dataset["filled"] !== wanted) {
    picker.dataset["filled"] = wanted;
    picker.replaceChildren(...mapAreas.map((area) => {
      const option = document.createElement("option");
      option.value = String(area.id);
      option.textContent = zoneName(area);
      return option;
    }));
  }
  picker.value = String(selected);
}

/**
 * The parchment underneath. Twelve tiles, or the eighteen dungeons' `<floor>_<n>` spelling; a map
 * whose art has not arrived yet is left dark rather than half-drawn.
 */
function drawArt(context: CanvasRenderingContext2D, mapArea: MapAreaInfo): void {
  context.clearRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = "#120f0a";
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  const art = game.mapArt;
  if (!art) return;
  const floor = mapArea.defaultDungeonFloor > 0 ? String(mapArea.defaultDungeonFloor) : "";
  for (let index = 0; index < TILE_COLUMNS * TILE_ROWS; index++) {
    const path = `Interface\\WorldMap\\${mapArea.name}\\${mapArea.name}${floor ? `${floor}_` : ""}${index + 1}.blp`;
    const bitmap = art.bitmap(path);
    if (!bitmap) continue;
    context.drawImage(bitmap, (index % TILE_COLUMNS) * TILE_SIZE, Math.floor(index / TILE_COLUMNS) * TILE_SIZE);
  }
}

/**
 * The explored pieces, drawn over the parchment, and a veil over everything they do not cover.
 *
 * Blizzard draws it the other way round — the overlay art *is* the discovered land and the base is
 * the undiscovered version — so the veil here is this client's own, and it is deliberately light:
 * a map that hides the coastline is less useful than one that shades it.
 */
function drawOverlays(
  context: CanvasRenderingContext2D,
  mapArea: MapAreaInfo,
  self: WorldObjectState | undefined,
): number {
  const areas = game.areas;
  const art = game.mapArt;
  const overlays = areas?.overlaysOf(mapArea.id) ?? [];
  if (!areas || !art || overlays.length === 0) return 0;
  const words = self ? exploredZones(self) : undefined;

  let explored = 0;
  const veil = document.createElement("canvas");
  veil.width = ART_WIDTH;
  veil.height = ART_HEIGHT;
  const shade = veil.getContext("2d");
  if (!shade) return 0;
  shade.fillStyle = "rgba(6, 9, 12, 0.62)";
  shade.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  shade.globalCompositeOperation = "destination-out";

  for (const overlay of overlays) {
    const seen = words !== undefined && overlay.areaIds.some((areaId) => {
      const bit = areas.area(areaId)?.areaBit ?? 0;
      return bit > 0 && isAreaExplored(words, bit);
    });
    if (!seen) continue;
    explored++;
    // The tile grid the picture is cut into. The declared size is a hint — two of the shipped 886
    // rows carry more art than they declare — so a missing tile is skipped rather than fatal.
    const columns = Math.max(1, Math.ceil(overlay.width / TILE_SIZE));
    const rows = Math.max(1, Math.ceil(overlay.height / TILE_SIZE));
    for (let index = 0; index < columns * rows; index++) {
      const path = `Interface\\WorldMap\\${mapArea.name}\\${overlay.textureName}${index + 1}.blp`;
      const bitmap = art.bitmap(path);
      if (!bitmap) continue;
      const left = overlay.offsetX + (index % columns) * TILE_SIZE;
      const top = overlay.offsetY + Math.floor(index / columns) * TILE_SIZE;
      context.drawImage(bitmap, left, top);
      shade.drawImage(bitmap, left, top);
    }
  }

  context.drawImage(veil, 0, 0);
  return explored;
}

function drawMarkers(
  context: CanvasRenderingContext2D,
  mapArea: MapAreaInfo,
  self: WorldObjectState | undefined,
): void {
  if (!hasMapBounds(mapArea)) return;
  const world = game.world;

  // Quest markers. A blob names the `WorldMapArea` it belongs to itself, so it is drawn on the
  // map it says rather than on whichever one the character happens to be looking at, and its
  // points are plain world coordinates that mean nothing without this rectangle.
  for (const blobs of world?.questPoi.values() ?? []) {
    for (const blob of blobs) {
      if (blob.worldMapAreaId !== mapArea.id || blob.points.length === 0) continue;
      context.beginPath();
      for (const [index, point] of blob.points.entries()) {
        const at = worldMapPoint(mapArea, point.x, point.y);
        const x = at.u * ART_WIDTH;
        const y = at.v * ART_HEIGHT;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fillStyle = "#f0c94a33";
      context.strokeStyle = "#f0c94a";
      context.lineWidth = 2;
      context.fill();
      context.stroke();
    }
  }

  // Party first, so the character's own arrow sits over them rather than under.
  for (const member of world?.group?.members ?? []) {
    if (member.guid === world?.state.selfGuid) continue;
    const object = world?.state.objects.get(member.guid);
    if (!object?.position) continue;
    const point = worldMapPoint(mapArea, object.position.x, object.position.y);
    if (point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1) continue;
    context.beginPath();
    context.arc(point.u * ART_WIDTH, point.v * ART_HEIGHT, 6, 0, Math.PI * 2);
    context.fillStyle = "#65a9ff";
    context.fill();
    context.strokeStyle = "#04140c";
    context.lineWidth = 2;
    context.stroke();
  }

  if (!self?.position) return;
  const point = worldMapPoint(mapArea, self.position.x, self.position.y);
  if (point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1) return;
  context.save();
  context.translate(point.u * ART_WIDTH, point.v * ART_HEIGHT);
  context.rotate(-self.position.orientation);
  context.beginPath();
  context.moveTo(0, -11);
  context.lineTo(8, 9);
  context.lineTo(0, 5);
  context.lineTo(-8, 9);
  context.closePath();
  context.fillStyle = "#62e7a3";
  context.strokeStyle = "#04140c";
  context.lineWidth = 2;
  context.fill();
  context.stroke();
  context.restore();
}

/** For a test and for the world map's own click handling: the inverse of the projection above. */
export function worldMapPositionAt(mapArea: MapAreaInfo, u: number, v: number): { x: number; y: number } {
  return worldMapWorld(mapArea, { u, v });
}
