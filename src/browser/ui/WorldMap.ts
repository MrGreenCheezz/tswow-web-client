import { exploredZones, isAreaExplored } from "../../world/Fields.js";
import {
  closeFrameXmlWorldMap, frameXmlWorldMapOpen, frameXmlWorldMapPublished,
  openFrameXmlWorldMap, toggleFrameXmlWorldMap,
} from "../framexml/FrameXmlWorldMapPublication.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import type { MapAreaInfo } from "../AreaClient.js";
import {
  hasMapBounds, worldMapWorld, WORLD_MAP_FRAME_HEIGHT, WORLD_MAP_FRAME_WIDTH,
} from "../MinimapGeometry.js";
import { currentAreaId } from "./Minimap.js";
import {
  questMapObjectiveMarkers, questMarkerProgress,
  type QuestMapObjectiveMarker, type QuestObjectiveNameResolver,
} from "./QuestObjectiveMarkers.js";
import { currentQuestLogEntries } from "./QuestLog.js";
import { Panel } from "./Widgets.js";
import {
  worldMapNavigate,
  type WorldMapHierarchy, type WorldMapNode, type WorldMapNodeKey, type WorldMapTarget,
} from "./WorldMapHierarchy.js";
import {
  questMarkerBelongsToNode, questMarkerMatchesFloor, questMarkerPlacement,
  worldMapBranchTarget, worldMapDescendantPlacement,
} from "./WorldMapQuestPlacement.js";

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
  upButton: HTMLButtonElement;
  breadcrumb: HTMLElement;
  markerLayer: HTMLElement;
  objectives: HTMLElement;
  status: HTMLElement;
}

let parts: WorldMapParts | undefined;
/** Which hierarchy node is on screen. Follows the character until the player picks another. */
let shownMapNodeKey: WorldMapNodeKey | undefined;
let hoveredMapNodeKey: WorldMapNodeKey | undefined;
let hoveredMapPoint: { u: number; v: number } | undefined;
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
/** The authored continent hit-map revision used for the last draw. */
let drawnZoneMapRevision = -1;
/** Quest progress/POI/metadata signature drawn into the map and its side list. */
let drawnQuestSignature = "";
let checkedQuestSignature = "";
let questSignatureCheckedAt = Number.NEGATIVE_INFINITY;
let drawnPartySignature = "";
const QUEST_SIGNATURE_INTERVAL_MS = 100;
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
let drawnAt: { x: number; y: number; orientation: number; area: WorldMapNodeKey | undefined } | undefined;
/** A yard of walking and about six degrees of turning. */
const MAP_MOVE_STEP = 1;
const MAP_TURN_STEP = 0.1;

/** Called once a frame. Redraws when the art lands, and when the character has actually moved. */
export function updateWorldMap(): void {
  if (!parts?.panel.visible) return;
  const revision = game.mapArt?.revision ?? 0;
  const zoneMapRevision = game.areas?.worldMapZoneMapRevision ?? 0;
  const questSignature = sampledQuestSignature(performance.now());
  const partySignature = currentPartySignature();
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const position = self?.position;
  const moved = position !== undefined && (
    drawnAt === undefined
    || drawnAt.area !== shownMapNodeKey
    || Math.abs(position.x - drawnAt.x) >= MAP_MOVE_STEP
    || Math.abs(position.y - drawnAt.y) >= MAP_MOVE_STEP
    || Math.abs(position.orientation - drawnAt.orientation) >= MAP_TURN_STEP
  );
  if (revision === drawnAtRevision && zoneMapRevision === drawnZoneMapRevision
    && questSignature === drawnQuestSignature
    && partySignature === drawnPartySignature && !moved) return;
  showWorldMap();
  drawnAt = position
    ? { x: position.x, y: position.y, orientation: position.orientation, area: shownMapNodeKey }
    : undefined;
}

export function toggleWorldMap(): void {
  if (toggleFrameXmlWorldMap()) {
    parts?.panel.hide();
    return;
  }
  parts ??= build();
  parts.panel.toggle();
  if (parts.panel.visible) {
    pinned = false;
    drawnAtRevision = -1;
    drawnZoneMapRevision = -1;
    drawnQuestSignature = "";
    questSignatureCheckedAt = Number.NEGATIVE_INFINITY;
    drawnPartySignature = "";
    showWorldMap();
  }
}

export function openWorldMap(): void {
  if (openFrameXmlWorldMap()) {
    parts?.panel.hide();
    return;
  }
  if (!parts?.panel.visible) toggleWorldMap();
}

export function worldMapOpen(): boolean {
  if (frameXmlWorldMapPublished()) return frameXmlWorldMapOpen();
  return parts?.panel.visible === true;
}

export function closeWorldMap(): void {
  closeFrameXmlWorldMap();
  parts?.panel.hide();
}

function build(): WorldMapParts {
  const panel = new Panel({ id: "world-map", title: "Карта мира", className: "world-map" });
  const bar = document.createElement("div");
  bar.className = "world-map-bar";
  const picker = document.createElement("select");
  picker.className = "world-map-picker";
  picker.setAttribute("aria-label", "Область карты");
  picker.addEventListener("change", () => {
    const hierarchy = game.areas?.worldMapHierarchy();
    const selected = hierarchy?.find(picker.value);
    if (!selected) return;
    shownMapNodeKey = selected.key;
    hoveredMapNodeKey = undefined;
    pinned = true;
    showWorldMap();
  });
  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.textContent = "Назад";
  upButton.addEventListener("click", () => zoomOutWorldMap());
  const here = document.createElement("button");
  here.type = "button";
  here.textContent = "Где я";
  here.addEventListener("click", () => {
    pinned = false;
    showWorldMap();
  });
  bar.append(picker, upButton, here);

  const breadcrumb = document.createElement("nav");
  breadcrumb.className = "world-map-breadcrumb";
  breadcrumb.setAttribute("aria-label", "Путь карты");

  const canvas = document.createElement("canvas");
  canvas.className = "world-map-canvas";
  canvas.width = ART_WIDTH;
  canvas.height = ART_HEIGHT;
  canvas.setAttribute("aria-label", "Карта мира");
  canvas.title = "ЛКМ — приблизить область, ПКМ — перейти на уровень выше";
  canvas.addEventListener("mousemove", (event) => {
    hoveredMapPoint = mapPointAt(event);
    const target = hoveredMapPoint ? mapTargetAtPoint(hoveredMapPoint.u, hoveredMapPoint.v) : undefined;
    const key = target?.node.key;
    canvas.style.cursor = key ? "pointer" : "default";
    if (key === hoveredMapNodeKey) return;
    hoveredMapNodeKey = key;
    showWorldMap();
  });
  canvas.addEventListener("mouseleave", () => {
    hoveredMapPoint = undefined;
    if (!hoveredMapNodeKey) return;
    hoveredMapNodeKey = undefined;
    canvas.style.cursor = "default";
    showWorldMap();
  });
  canvas.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    const target = mapTargetAt(event);
    if (!target) return;
    event.stopPropagation();
    showMapNode(target.node);
  });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zoomOutWorldMap();
  });
  const markerLayer = document.createElement("div");
  markerLayer.className = "world-map-marker-layer";
  markerLayer.setAttribute("aria-label", "Цели заданий на карте");
  const stage = document.createElement("div");
  stage.className = "world-map-stage";
  stage.append(canvas, markerLayer);

  const objectives = document.createElement("aside");
  objectives.className = "world-map-objectives";
  objectives.setAttribute("aria-label", "Цели заданий в этой области");
  objectives.addEventListener("click", (event) => event.stopPropagation());
  objectives.addEventListener("contextmenu", (event) => event.stopPropagation());
  const layout = document.createElement("div");
  layout.className = "world-map-layout";
  layout.append(stage, objectives);
  const status = document.createElement("p");
  status.className = "muted world-map-status";

  panel.body.append(bar, breadcrumb, layout, status);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The world map needs a 2D canvas context");
  return { panel, canvas, context, picker, upButton, breadcrumb, markerLayer, objectives, status };
}

function showMapNode(node: WorldMapNode): void {
  shownMapNodeKey = node.key;
  hoveredMapNodeKey = undefined;
  pinned = true;
  showWorldMap();
}

function zoomOutWorldMap(): void {
  const hierarchy = game.areas?.worldMapHierarchy();
  const current = hierarchy && shownMapNodeKey ? hierarchy.find(shownMapNodeKey) : undefined;
  if (!hierarchy || !current) return;
  const parent = worldMapNavigate(hierarchy, current, 2, 0, 0);
  if (parent) showMapNode(parent);
}

function mapPointAt(event: MouseEvent): { u: number; v: number } | undefined {
  if (!parts) return undefined;
  const bounds = parts.canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  return {
    u: (event.clientX - bounds.left) / bounds.width,
    v: (event.clientY - bounds.top) / bounds.height,
  };
}

function mapTargetAt(event: MouseEvent): WorldMapTarget | undefined {
  const point = mapPointAt(event);
  return point ? mapTargetAtPoint(point.u, point.v) : undefined;
}

/**
 * Original-client continent clicks come from the 128×128 ZMP, not overlapping zone rectangles.
 * A loading/ready-empty answer is authoritative; rectangles are only a compatibility fallback for
 * a custom continent which genuinely ships no mask.
 */
function mapTargetAtPoint(u: number, v: number): WorldMapTarget | undefined {
  const areas = game.areas;
  const hierarchy = areas?.worldMapHierarchy();
  const current = hierarchy && shownMapNodeKey ? hierarchy.find(shownMapNodeKey) : undefined;
  if (!areas || !hierarchy || !current) return undefined;
  if (current.kind === "area" && current.mapArea.areaId === 0) {
    const exact = areas.worldMapAreaAt(current.mapArea, u, v);
    if (exact.status !== "unavailable") {
      if (exact.status !== "ready" || !exact.mapArea) return undefined;
      const descendant = hierarchy.area(exact.mapArea.id);
      return descendant ? worldMapBranchTarget(hierarchy, current, descendant) : undefined;
    }
  }
  const child = worldMapNavigate(hierarchy, current, 0, u, v);
  return child ? hierarchy.targets(current).find((target) => target.node.key === child.key) : undefined;
}

/** Redraws whatever is on screen. Cheap: the pictures are cached bitmaps. */
export function showWorldMap(): void {
  if (!parts?.panel.visible) return;
  const world = game.world;
  const areas = game.areas;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const hierarchy = areas?.worldMapHierarchy();
  if (!world || !areas?.ready || !hierarchy || world.mapId === undefined) {
    parts.status.textContent = "Данные зон ещё не загружены";
    return;
  }

  // Follow the character unless the player has picked a map to stay on.
  if (!pinned) {
    const here = areas.mapAreaOfArea(currentAreaId()) ?? areas.continentMapArea(world.mapId);
    if (here) shownMapNodeKey = hierarchy.area(here.id)?.key;
  }
  const fallbackArea = areas.continentMapArea(world.mapId);
  const shown = (shownMapNodeKey ? hierarchy.find(shownMapNodeKey) : undefined)
    ?? (fallbackArea ? hierarchy.area(fallbackArea.id) : undefined)
    ?? hierarchy.root;
  if (!shown) {
    parts.status.textContent = `Для карты ${world.mapId} нет изображения`;
    parts.context.clearRect(0, 0, ART_WIDTH, ART_HEIGHT);
    return;
  }
  shownMapNodeKey = shown.key;
  fillPicker(parts.picker, hierarchy, shown);
  renderBreadcrumb(parts.breadcrumb, hierarchy, shown);
  const parent = hierarchy.parent(shown);
  parts.upButton.disabled = !parent;
  parts.upButton.textContent = parent ? `Назад: ${parent.name}` : "Верхний уровень";
  parts.panel.title = `Карта · ${shown.name}`;

  // Start the small authored hit-map request as soon as a continent opens, instead of making the
  // player's first click race the generator. The sampled cell is irrelevant; `hit` loads per map.
  const zoneMapStatus = shown.kind === "area" && shown.mapArea.areaId === 0
    ? areas.worldMapAreaAt(shown.mapArea, 0.5, 0.5).status
    : undefined;
  if (hoveredMapPoint) {
    const target = mapTargetAtPoint(hoveredMapPoint.u, hoveredMapPoint.v);
    hoveredMapNodeKey = target?.node.key;
    parts.canvas.style.cursor = target ? "pointer" : "default";
  }

  drawnAtRevision = game.mapArt?.revision ?? 0;
  drawnZoneMapRevision = areas.worldMapZoneMapRevision;
  const questMarkers = currentQuestMarkers();
  drawnQuestSignature = questSignatureOf(questMarkers);
  checkedQuestSignature = drawnQuestSignature;
  questSignatureCheckedAt = performance.now();
  drawnPartySignature = currentPartySignature();
  drawArt(parts.context, shown);
  let detail = `Дочерних областей: ${hierarchy.targets(shown).length}`;
  if (shown.kind === "area") {
    const explored = drawOverlays(parts.context, shown.mapArea, self);
    const overlays = areas.overlaysOf(shown.mapArea.id).length;
    detail = overlays > 0
      ? `Исследовано областей: ${explored} из ${overlays}`
      : detail;
  }
  drawMarkers(parts.context, shown, self, hierarchy, questMarkers);
  drawNavigationHighlight(parts.context, hierarchy, shown);
  const visibleQuestMarkers = renderQuestMarkers(parts, hierarchy, shown, questMarkers);
  const hitMapDetail = zoneMapStatus === "loading" ? " · Точная разметка регионов загружается" : "";
  parts.status.textContent = `${detail} · Целей заданий: ${visibleQuestMarkers}${hitMapDetail} · ЛКМ — приблизить · ПКМ — уровень выше`;
}

function renderBreadcrumb(
  breadcrumb: HTMLElement,
  hierarchy: WorldMapHierarchy,
  current: WorldMapNode,
): void {
  const path: WorldMapNode[] = [];
  let cursor: WorldMapNode | undefined = current;
  for (let depth = 0; cursor && depth < 128; depth++) {
    path.push(cursor);
    cursor = hierarchy.parent(cursor);
  }
  path.reverse();
  const children: Node[] = [];
  for (const [index, node] of path.entries()) {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "world-map-breadcrumb-separator";
      separator.textContent = "›";
      separator.setAttribute("aria-hidden", "true");
      children.push(separator);
    }
    if (node.key === current.key) {
      const label = document.createElement("strong");
      label.textContent = node.name;
      label.setAttribute("aria-current", "page");
      children.push(label);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = node.name;
    button.addEventListener("click", () => showMapNode(node));
    children.push(button);
  }
  breadcrumb.replaceChildren(...children);
}

function fillPicker(picker: HTMLSelectElement, hierarchy: WorldMapHierarchy, selected: WorldMapNode): void {
  const nodes = orderedMapNodes(hierarchy);
  if (!nodes.some((entry) => entry.node.key === selected.key)) nodes.push({ node: selected, depth: 1 });
  const wanted = nodes.map(({ node, depth }) => `${node.key}:${depth}:${node.name}`).join("|");
  if (picker.dataset["filled"] !== wanted) {
    picker.dataset["filled"] = wanted;
    picker.replaceChildren(...nodes.map(({ node, depth }) => {
      const option = document.createElement("option");
      option.value = node.key;
      option.textContent = `${"— ".repeat(depth)}${node.name}`;
      return option;
    }));
  }
  picker.value = selected.key;
}

function orderedMapNodes(hierarchy: WorldMapHierarchy): { node: WorldMapNode; depth: number }[] {
  const ordered: { node: WorldMapNode; depth: number }[] = [];
  const visited = new Set<WorldMapNodeKey>();
  const visit = (node: WorldMapNode, depth: number) => {
    if (visited.has(node.key)) return;
    visited.add(node.key);
    ordered.push({ node, depth });
    for (const child of hierarchy.children(node)) visit(child, depth + 1);
  };
  visit(hierarchy.root, 0);
  return ordered;
}

const questObjectiveName: QuestObjectiveNameResolver = (kind, id) => {
  const world = game.world;
  if (kind === "creature") {
    return game.creatureMetadata?.get(id)?.name ?? world?.creatureTemplates.get(id)?.name;
  }
  if (kind === "gameObject") return world?.gameObjectTemplates.get(id)?.name;
  return game.itemMetadata?.get(id)?.name ?? world?.itemTemplates.get(id)?.name;
};

function currentQuestMarkers(): QuestMapObjectiveMarker[] {
  const world = game.world;
  return world
    ? questMapObjectiveMarkers(currentQuestLogEntries(), world.questPoi, questObjectiveName)
    : [];
}

function questSignatureOf(markers: readonly QuestMapObjectiveMarker[]): string {
  return markers.map((marker) => [
    marker.questId, marker.poiIndex, marker.worldMapAreaId, marker.map, marker.floor,
    marker.state, marker.kind, marker.id ?? 0, marker.title, marker.label,
    marker.have ?? "?", marker.need ?? "?", marker.points.length,
    marker.centroid?.x ?? "?", marker.centroid?.y ?? "?",
  ].join(":")).join("|");
}

function sampledQuestSignature(now: number): string {
  if (now < questSignatureCheckedAt || now - questSignatureCheckedAt >= QUEST_SIGNATURE_INTERVAL_MS) {
    checkedQuestSignature = questSignatureOf(currentQuestMarkers());
    questSignatureCheckedAt = now;
  }
  return checkedQuestSignature;
}

function currentPartySignature(): string {
  const world = game.world;
  if (!world?.group) return "";
  return world.group.members.map((member) => {
    const position = world.state.objects.get(member.guid)?.position;
    return position
      ? `${member.guid}:${Math.round(position.x)}:${Math.round(position.y)}`
      : `${member.guid}:?`;
  }).join("|");
}

function markerDescription(marker: QuestMapObjectiveMarker): string {
  const progress = questMarkerProgress(marker);
  const floor = marker.floor > 0 ? ` · этаж ${marker.floor}` : "";
  return `${marker.title} — ${marker.label}${progress ? `: ${progress}` : ""}${floor}`;
}

function renderQuestMarkers(
  mapParts: WorldMapParts,
  hierarchy: WorldMapHierarchy,
  current: WorldMapNode,
  markers: readonly QuestMapObjectiveMarker[],
): number {
  const visible = markers.filter((marker) => questMarkerBelongsToNode(hierarchy, current, marker));
  const heading = document.createElement("h3");
  heading.textContent = "Цели заданий";
  const list = document.createElement("div");
  list.className = "world-map-objective-list";
  mapParts.markerLayer.replaceChildren();
  const pinCollisions = new Map<string, number>();

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted world-map-objective-empty";
    empty.textContent = "В этой части карты нет известных целей.";
    mapParts.objectives.replaceChildren(heading, empty);
    return 0;
  }

  for (const marker of visible) {
    const description = markerDescription(marker);
    const row = document.createElement("div");
    row.className = "world-map-objective-row";
    row.dataset["state"] = marker.state;
    row.dataset["kind"] = marker.kind;
    row.title = description;

    const ordinal = document.createElement("span");
    ordinal.className = "world-map-objective-number";
    ordinal.textContent = String(marker.ordinal);
    ordinal.setAttribute("aria-hidden", "true");
    const glyph = document.createElement("span");
    glyph.className = "world-map-objective-glyph";
    glyph.dataset["kind"] = marker.kind;
    glyph.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "world-map-objective-copy";
    const label = document.createElement("strong");
    label.textContent = marker.label;
    const quest = document.createElement("small");
    const progress = questMarkerProgress(marker);
    const floor = marker.floor > 0 ? ` · этаж ${marker.floor}` : "";
    quest.textContent = `${progress ? `${marker.title} · ${progress}` : marker.title}${floor}`;
    copy.append(label, quest);
    row.append(ordinal, glyph, copy);
    list.append(row);

    const placement = questMarkerMatchesFloor(current, marker)
      ? questMarkerPlacement(hierarchy, current, marker)
      : undefined;
    if (!placement) continue;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "world-map-quest-pin";
    pin.dataset["state"] = marker.state;
    pin.dataset["precision"] = placement.precision;
    pin.style.left = `${placement.point.u * 100}%`;
    pin.style.top = `${placement.point.v * 100}%`;
    const collisionKey = `${placement.point.u.toFixed(3)}:${placement.point.v.toFixed(3)}`;
    const collision = pinCollisions.get(collisionKey) ?? 0;
    pinCollisions.set(collisionKey, collision + 1);
    if (collision > 0) {
      const angle = collision * 2.399963229728653;
      const radius = 17 * Math.ceil(collision / 6);
      pin.style.setProperty("--quest-pin-x", `${Math.round(Math.cos(angle) * radius)}px`);
      pin.style.setProperty("--quest-pin-y", `${Math.round(Math.sin(angle) * radius)}px`);
    }
    pin.textContent = String(marker.ordinal);
    pin.title = placement.precision === "area" ? `${description} · область цели` : description;
    pin.setAttribute("aria-label", pin.title);
    pin.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.scrollIntoView?.({ block: "nearest" });
    });
    pin.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    mapParts.markerLayer.append(pin);
  }
  mapParts.objectives.replaceChildren(heading, list);
  return visible.length;
}

/**
 * The parchment underneath. Twelve tiles, or the eighteen dungeons' `<floor>_<n>` spelling; a map
 * whose art has not arrived yet is left dark rather than half-drawn.
 */
function drawArt(context: CanvasRenderingContext2D, node: WorldMapNode): void {
  context.clearRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = "#120f0a";
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  const art = game.mapArt;
  if (!art) return;
  const floor = node.kind === "area" && node.mapArea.defaultDungeonFloor > 0
    ? String(node.mapArea.defaultDungeonFloor)
    : "";
  for (let index = 0; index < TILE_COLUMNS * TILE_ROWS; index++) {
    const path = `Interface\\WorldMap\\${node.artName}\\${node.artName}${floor ? `${floor}_` : ""}${index + 1}.blp`;
    const bitmap = art.bitmap(path);
    if (!bitmap) continue;
    context.drawImage(bitmap, (index % TILE_COLUMNS) * TILE_SIZE, Math.floor(index / TILE_COLUMNS) * TILE_SIZE);
  }
}

function drawNavigationHighlight(
  context: CanvasRenderingContext2D,
  hierarchy: WorldMapHierarchy,
  current: WorldMapNode,
): void {
  if (!hoveredMapNodeKey) return;
  const target = hierarchy.targets(current).find((candidate) => candidate.node.key === hoveredMapNodeKey);
  if (!target) return;
  const left = target.rect.left * ART_WIDTH;
  const top = target.rect.top * ART_HEIGHT;
  const width = target.rect.width * ART_WIDTH;
  const height = target.rect.height * ART_HEIGHT;
  context.save();
  context.fillStyle = "rgba(240, 201, 74, 0.18)";
  context.strokeStyle = "#f0c94a";
  context.lineWidth = 3;
  context.fillRect(left, top, width, height);
  context.strokeRect(left, top, width, height);
  context.font = "bold 18px sans-serif";
  const labelWidth = Math.min(width, context.measureText(target.node.name).width + 18);
  const labelLeft = left + Math.max(0, (width - labelWidth) / 2);
  const labelTop = top + Math.max(0, (height - 30) / 2);
  context.fillStyle = "rgba(18, 15, 10, 0.88)";
  context.fillRect(labelLeft, labelTop, labelWidth, 30);
  context.fillStyle = "#f7df91";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(target.node.name, labelLeft + labelWidth / 2, labelTop + 15, Math.max(0, labelWidth - 10));
  context.restore();
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
  current: WorldMapNode,
  self: WorldObjectState | undefined,
  hierarchy: WorldMapHierarchy,
  questMarkers: readonly QuestMapObjectiveMarker[],
): void {
  const world = game.world;
  drawQuestAreas(context, current, hierarchy, questMarkers);
  const characterNode = currentCharacterMapNode(hierarchy);
  if (!world || !characterNode || world.mapId === undefined) return;

  // Party first, so the character's own arrow sits over them rather than under.
  for (const member of world.group?.members ?? []) {
    if (member.guid === world.state.selfGuid) continue;
    const object = world.state.objects.get(member.guid);
    if (!object?.position) continue;
    const placement = worldMapDescendantPlacement(
      hierarchy, current, characterNode, world.mapId, object.position,
    );
    if (!placement) continue;
    context.beginPath();
    context.arc(placement.point.u * ART_WIDTH, placement.point.v * ART_HEIGHT,
      placement.precision === "point" ? 6 : 8, 0, Math.PI * 2);
    context.fillStyle = "#65a9ff";
    context.fill();
    context.strokeStyle = "#04140c";
    context.lineWidth = 2;
    context.stroke();
  }

  if (!self?.position) return;
  const placement = worldMapDescendantPlacement(
    hierarchy, current, characterNode, world.mapId, self.position,
  );
  if (!placement) return;
  if (placement.precision === "area") {
    context.beginPath();
    context.arc(placement.point.u * ART_WIDTH, placement.point.v * ART_HEIGHT, 10, 0, Math.PI * 2);
    context.fillStyle = "#62e7a3";
    context.fill();
    context.strokeStyle = "#04140c";
    context.lineWidth = 3;
    context.stroke();
    return;
  }
  context.save();
  context.translate(placement.point.u * ART_WIDTH, placement.point.v * ART_HEIGHT);
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

function currentCharacterMapNode(hierarchy: WorldMapHierarchy): WorldMapNode | undefined {
  const areas = game.areas;
  const mapId = game.world?.mapId;
  if (!areas || mapId === undefined) return undefined;
  const mapArea = areas.mapAreaOfArea(currentAreaId()) ?? areas.continentMapArea(mapId);
  return mapArea ? hierarchy.area(mapArea.id) : undefined;
}

function drawQuestAreas(
  context: CanvasRenderingContext2D,
  current: WorldMapNode,
  hierarchy: WorldMapHierarchy,
  markers: readonly QuestMapObjectiveMarker[],
): void {
  if (current.kind !== "area" || !hasMapBounds(current.mapArea)) return;
  for (const marker of markers) {
    if (!questMarkerBelongsToNode(hierarchy, current, marker)
      || !questMarkerMatchesFloor(current, marker) || marker.points.length === 0) continue;
    const points = marker.points.flatMap((point) => {
      const at = hierarchy.displayPoint(current.mapArea, marker.map, point.x, point.y);
      return at && at.u >= 0 && at.u <= 1 && at.v >= 0 && at.v <= 1 ? [at] : [];
    });
    if (points.length === 0) continue;
    context.beginPath();
    if (points.length === 1) {
      context.arc(points[0]!.u * ART_WIDTH, points[0]!.v * ART_HEIGHT, 9, 0, Math.PI * 2);
    } else {
      points.forEach((point, index) => {
        const x = point.u * ART_WIDTH;
        const y = point.v * ART_HEIGHT;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    }
    context.fillStyle = marker.state === "failed" ? "#a940403d"
      : marker.state === "complete" || marker.state === "ready" ? "#62e7a33d" : "#f0c94a33";
    context.strokeStyle = marker.state === "failed" ? "#d96a63"
      : marker.state === "complete" || marker.state === "ready" ? "#62e7a3" : "#f0c94a";
    context.lineWidth = 2;
    context.fill();
    context.stroke();
  }
}

/** For a test and for the world map's own click handling: the inverse of the projection above. */
export function worldMapPositionAt(mapArea: MapAreaInfo, u: number, v: number): { x: number; y: number } {
  return worldMapWorld(mapArea, { u, v });
}
