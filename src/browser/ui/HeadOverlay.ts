/**
 * Speech bubbles and rising damage numbers, over the heads they belong to.
 *
 * A layer of ordinary elements rather than more drawing on the 2D canvas: text on a canvas cannot
 * be selected, cannot be styled by the same stylesheet as the rest of the interface, and would
 * have to re-implement wrapping. The projection is the canvas overlay's own — `createCamera` and
 * `projectPoint` from `SimpleScene`, which the WebGL scene already agrees with to the pixel — so a
 * bubble sits on a head rather than near it.
 *
 * The layer is built at run time and is not a `Dom.ts` handle: it does not exist in the page, so
 * resolving it at start-up would throw before the world is ever entered.
 */

import { createCamera, projectPoint } from "../SimpleScene.js";
import { isWorldObjectDead } from "../../world/WorldState.js";
import { cameraPivotHeight, game } from "../game/Context.js";
import { plainChatText } from "./ChatLink.js";
import { currentQuestLogEntries } from "./QuestLog.js";
import {
  questMarkerProgress,
  questWorldObjectiveMarkers,
  type QuestObjectiveNameResolver,
  type QuestWorldObjectiveMarker,
} from "./QuestObjectiveMarkers.js";
import { settingOn } from "./Settings.js";
import {
  addFloater, expire, floaterOffset, floatingAmountText, floatingCombatTextRelevant, putBubble,
  removeIrrelevantFloaters, type Bubble, type Floater, type FloaterKind,
} from "./OverlayModel.js";

/**
 * How far above the crown of the head a bubble hangs, clear of the name plate on the canvas.
 *
 * Clear the target's name, readable health/cast rows and the raid/quest mark above them.
 */
const BUBBLE_GAP_PX = 84;
const FLOATER_GAP_PX = 12;
/** Keep the brass objective badge beside, rather than over, the existing nameplate stack. */
const QUEST_MARKER_X_PX = 86;
const QUEST_MARKER_GAP_PX = 10;
/** Quest/object membership changes on packets, not frames; cap the loaded-object scan at 10 Hz. */
const QUEST_MARKER_INTERVAL_MS = 100;

const bubbles: Bubble[] = [];
const floaters: Floater[] = [];
/** The element showing each entry, so a frame is a transform write and not a rebuild. */
const bubbleNodes = new Map<bigint, HTMLElement>();
const floaterNodes = new Map<Floater, HTMLElement>();
const questMarkerNodes = new Map<bigint, {
  root: HTMLElement;
  sigil: HTMLElement;
  progress: HTMLElement;
}>();

let cachedQuestMarkers: readonly QuestWorldObjectiveMarker[] = [];
let questMarkersWorld: typeof game.world;
let questMarkersCheckedAt = Number.NEGATIVE_INFINITY;

/**
 * Cached overlay size: `getBoundingClientRect` forces a sync layout, so it must not run per frame.
 * Where the page has a `ResizeObserver` the size is the one the observer last reported (see
 * `overlaySize`); only without one is it measured, at most once per TTL.
 */
let cachedBoundsWidth = 0;
let cachedBoundsHeight = 0;
let cachedBoundsAt = Number.NEGATIVE_INFINITY;
/** How long a measured overlay size stays valid; a resize lands on the next frame after this. */
const OVERLAY_BOUNDS_TTL_MS = 250;
/** The layer's content box as the last layout left it, and the observer reporting it. */
let observedBounds: { width: number; height: number } | undefined;
let boundsObserver: ResizeObserver | undefined;
let observedLayer: HTMLElement | undefined;

let layer: HTMLElement | undefined;

/** The class a bubble should carry, remembered until its element is made. */
const bubbleKind = new Map<bigint, string>();

function overlayLayer(): HTMLElement | undefined {
  if (layer?.isConnected) return layer;
  const viewport = document.getElementById("world-viewport");
  if (!viewport) return undefined;
  layer = document.createElement("div");
  layer.id = "head-overlay";
  layer.className = "head-overlay";
  viewport.append(layer);
  return layer;
}

/** Everything on the layer, dropped. Called when a world is left. */
export function resetHeadOverlay(): void {
  bubbles.length = 0;
  floaters.length = 0;
  bubbleNodes.clear();
  floaterNodes.clear();
  questMarkerNodes.clear();
  cachedQuestMarkers = [];
  questMarkersWorld = undefined;
  questMarkersCheckedAt = Number.NEGATIVE_INFINITY;
  cachedBoundsWidth = 0;
  cachedBoundsHeight = 0;
  cachedBoundsAt = Number.NEGATIVE_INFINITY;
  layer?.replaceChildren();
}

/**
 * What a unit just said, over its head.
 *
 * The markup goes first: a bubble showing `|cff1eff00|Hitem:…` would be showing the escape codes,
 * and a link in a bubble is not clickable anyway.
 */
export function showChatBubble(guid: bigint, text: string, kind = "chat-say"): void {
  const plain = plainChatText(text).trim();
  if (guid === 0n || !plain || !settingOn("chatBubbles")) return;
  putBubble(bubbles, guid, plain, performance.now());
  const node = bubbleNodes.get(guid);
  if (node) node.className = `chat-bubble ${kind}`;
  else bubbleKind.set(guid, kind);
}

export function showFloatingText(
  guid: bigint, kind: FloaterKind, amount: number, critical: boolean, text?: string | undefined,
): void {
  const world = game.world;
  if (!world || !floatingCombatTextRelevant(guid, world.state.selfGuid, world.targetGuid)
    || !settingOn("floatingCombatText")) return;
  addFloater(floaters, {
    guid, kind, critical, text: floatingAmountText(kind, amount, text),
  }, performance.now());
}

/**
 * One frame of the overlay.
 *
 * Called from the render loop after both draw passes, so the camera is the one they used and the
 * physics step has already replaced the player's position object for this frame.
 */
export function updateHeadOverlay(now: number): void {
  const world = game.world;
  const state = world?.state;
  const selfGuid = state?.selfGuid;
  expire(bubbles, now);
  expire(floaters, now);
  removeIrrelevantFloaters(floaters, selfGuid, world?.targetGuid);
  const worldMarkers = liveQuestMarkers(now);
  if (bubbles.length === 0 && floaters.length === 0 && worldMarkers.length === 0) {
    if (bubbleNodes.size > 0 || floaterNodes.size > 0 || questMarkerNodes.size > 0) resetHeadOverlay();
    return;
  }
  const root = overlayLayer();
  const player = selfGuid === undefined ? undefined : state?.objects.get(selfGuid)?.position;
  if (!root || !state || !player) return;

  measureOverlay(root, now);
  const width = cachedBoundsWidth;
  const height = cachedBoundsHeight;
  // `view` and not `distance`, `viewPitch` and not `pitch`: the bubbles have to hang off the
  // camera the world was drawn with, or they float away from the heads they belong to for as long
  // as a wall is holding it in or a floor is holding it up. The pivot height comes from the same
  // place for the same reason.
  const camera = createCamera(player, game.camera.yaw, game.camera.viewPitch, game.camera.view,
    { pivotHeight: cameraPivotHeight() });

  const liveQuestMarkerGuids = new Set<bigint>();
  for (const marker of worldMarkers) {
    const anchor = anchorFor(marker.guid, camera, width, height);
    const parts = questMarkerNodes.get(marker.guid) ?? makeQuestMarker(root, marker.guid);
    liveQuestMarkerGuids.add(marker.guid);
    if (!anchor) {
      if (!parts.root.hidden) parts.root.hidden = true;
      continue;
    }
    updateQuestMarker(parts, marker);
    if (parts.root.hidden) parts.root.hidden = false;
    const markerTransform = `translate(-50%, -100%) translate(${Math.round(anchor.x + QUEST_MARKER_X_PX)}px, ${Math.round(anchor.y - QUEST_MARKER_GAP_PX)}px)`;
    if (parts.root.style.transform !== markerTransform) parts.root.style.transform = markerTransform;
  }
  for (const [guid, parts] of questMarkerNodes) {
    if (liveQuestMarkerGuids.has(guid)) continue;
    parts.root.remove();
    questMarkerNodes.delete(guid);
  }

  const liveBubbles = new Set<bigint>();
  for (const bubble of bubbles) {
    const anchor = anchorFor(bubble.guid, camera, width, height);
    const node = bubbleNodes.get(bubble.guid) ?? makeBubble(root, bubble.guid);
    if (!anchor) {
      if (!node.hidden) node.hidden = true;
      liveBubbles.add(bubble.guid);
      continue;
    }
    if (node.hidden) node.hidden = false;
    if (node.textContent !== bubble.text) node.textContent = bubble.text;
    const bubbleTransform = `translate(-50%, -100%) translate(${Math.round(anchor.x)}px, ${Math.round(anchor.y - BUBBLE_GAP_PX)}px)`;
    if (node.style.transform !== bubbleTransform) node.style.transform = bubbleTransform;
    liveBubbles.add(bubble.guid);
  }
  for (const [guid, node] of bubbleNodes) {
    if (liveBubbles.has(guid)) continue;
    node.remove();
    bubbleNodes.delete(guid);
    bubbleKind.delete(guid);
  }

  const liveFloaters = new Set<Floater>();
  for (const floater of floaters) {
    const anchor = anchorFor(floater.guid, camera, width, height);
    const node = floaterNodes.get(floater) ?? makeFloater(root, floater);
    liveFloaters.add(floater);
    if (!anchor) {
      if (!node.hidden) node.hidden = true;
      continue;
    }
    const offset = floaterOffset(floater, now);
    if (node.hidden) node.hidden = false;
    const opacity = offset.opacity.toFixed(2);
    if (node.style.opacity !== opacity) node.style.opacity = opacity;
    const floaterTransform = `translate(-50%, -100%) translate(${Math.round(anchor.x + offset.dx)}px, ${Math.round(anchor.y - FLOATER_GAP_PX + offset.dy)}px)`;
    if (node.style.transform !== floaterTransform) node.style.transform = floaterTransform;
  }
  for (const [floater, node] of floaterNodes) {
    if (liveFloaters.has(floater)) continue;
    node.remove();
    floaterNodes.delete(floater);
  }
}

/**
 * The overlay's size into `cachedBoundsWidth`/`cachedBoundsHeight`, without laying the page out.
 *
 * The layer fills the viewport (`.head-overlay { inset: 0 }`, no border, padding or transform) and
 * changes size only with the window. Reading `getBoundingClientRect` every 250 ms still forced a
 * layout in the middle of a frame — after the frame had written the unit frames, the minimap and
 * this layer's own transforms — four times a second while anything hung over a head. A
 * `ResizeObserver` is told after each layout that changed the box, before that frame is painted, so
 * a frame reads a number instead: `SimpleScene`'s `#canvasSize` for the world canvas beside it. A
 * new layer (the old one was taken off the page) is observed afresh; until the first observation,
 * and where there is no observer at all (the tests), it is measured as before, once per TTL.
 */
function measureOverlay(root: HTMLElement, now: number): void {
  if (observedLayer !== root) {
    boundsObserver?.disconnect();
    boundsObserver = undefined;
    observedBounds = undefined;
    observedLayer = root;
    if (typeof ResizeObserver === "function") {
      boundsObserver = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) observedBounds = { width: entry.contentRect.width, height: entry.contentRect.height };
      });
      boundsObserver.observe(root);
    }
  }
  const observed = observedBounds;
  if (observed && observed.width > 0 && observed.height > 0) {
    cachedBoundsWidth = observed.width;
    cachedBoundsHeight = observed.height;
    return;
  }
  if (now - cachedBoundsAt >= OVERLAY_BOUNDS_TTL_MS || cachedBoundsWidth <= 0 || cachedBoundsHeight <= 0) {
    const bounds = root.getBoundingClientRect();
    cachedBoundsWidth = Math.max(1, bounds.width);
    cachedBoundsHeight = Math.max(1, bounds.height);
    cachedBoundsAt = now;
  }
}

const questTargetName: QuestObjectiveNameResolver = (kind, id) => {
  const world = game.world;
  if (kind === "creature") {
    return game.creatureMetadata?.get(id)?.name ?? world?.creatureTemplates.get(id)?.name;
  }
  if (kind === "gameObject") return world?.gameObjectTemplates.get(id)?.name;
  return game.itemMetadata?.get(id)?.name ?? world?.itemTemplates.get(id)?.name;
};

function liveQuestMarkers(now: number): readonly QuestWorldObjectiveMarker[] {
  const world = game.world;
  if (!world) {
    cachedQuestMarkers = [];
    questMarkersWorld = undefined;
    questMarkersCheckedAt = now;
    return cachedQuestMarkers;
  }
  if (questMarkersWorld !== world || now < questMarkersCheckedAt
    || now - questMarkersCheckedAt >= QUEST_MARKER_INTERVAL_MS) {
    questMarkersWorld = world;
    questMarkersCheckedAt = now;
    cachedQuestMarkers = questWorldObjectiveMarkers(
      currentQuestLogEntries(),
      world.state.objects.values(),
      questTargetName,
    );
  }
  return cachedQuestMarkers;
}

function makeQuestMarker(root: HTMLElement, guid: bigint): {
  root: HTMLElement;
  sigil: HTMLElement;
  progress: HTMLElement;
} {
  const marker = document.createElement("div");
  marker.className = "quest-world-marker";
  marker.setAttribute("aria-hidden", "true");
  const sigil = document.createElement("span");
  sigil.className = "quest-world-marker-sigil";
  const progress = document.createElement("span");
  progress.className = "quest-world-marker-progress";
  marker.append(sigil, progress);
  root.append(marker);
  const parts = { root: marker, sigil, progress };
  questMarkerNodes.set(guid, parts);
  return parts;
}

function updateQuestMarker(
  parts: { root: HTMLElement; sigil: HTMLElement; progress: HTMLElement },
  marker: QuestWorldObjectiveMarker,
): void {
  if (parts.root.dataset["kind"] !== marker.kind) parts.root.dataset["kind"] = marker.kind;
  if (parts.root.dataset["label"] !== marker.label) parts.root.dataset["label"] = marker.label;
  const objectiveCount = String(marker.objectives.length);
  if (parts.root.dataset["objectiveCount"] !== objectiveCount) parts.root.dataset["objectiveCount"] = objectiveCount;
  if (parts.sigil.dataset["kind"] !== marker.kind) parts.sigil.dataset["kind"] = marker.kind;
  const progressRows = marker.objectives.map(questMarkerProgress).filter((row) => row !== undefined);
  const progress = progressRows.length > 1 ? `${progressRows[0]} · +${progressRows.length - 1}` : progressRows[0] ?? "";
  if (parts.progress.textContent !== progress) parts.progress.textContent = progress;
  const progressHidden = progress.length === 0;
  if (parts.progress.hidden !== progressHidden) parts.progress.hidden = progressHidden;
  const title = marker.objectives.map((objective) => {
    const row = questMarkerProgress(objective);
    return row ? `${objective.label}: ${row}` : objective.label;
  }).join(" · ");
  if (parts.root.title !== title) parts.root.title = title;
}

/**
 * How high a lying body reaches, in yards.
 *
 * `WorldRenderer3D.#shapeCapsule` turns a dead unit a quarter turn and rests it at `radius`,
 * leaving `unit.height` at the standing figure — so a corpse is about as high off the ground as
 * an ordinary unit is wide, whatever `unitHeight` still answers.
 */
const CORPSE_CROWN_HEIGHT = 0.9;

/**
 * Where the crown of a unit's head is on screen, or undefined when it is not on screen at all.
 *
 * A corpse used to be skipped outright, because the renderer lays a dead unit down without
 * shortening it and anything hung from `position.z + unitHeight(guid)` floats a body's length
 * over an empty patch of ground. Dropping the body was the wrong half of that fix: the killing
 * blow's own number is raised at the instant health reaches zero, so it was the one number in a
 * fight that never appeared, and a creature that spoke as it died lost the bubble mid-sentence.
 * The body is kept and the anchor is brought down to it instead.
 */
function anchorFor(guid: bigint, camera: ReturnType<typeof createCamera>, width: number, height: number) {
  const object = game.world?.state.objects.get(guid);
  const position = object?.position;
  if (!object || !position) return undefined;
  const isUnit = object.typeId === 3 || object.typeId === 4;
  const standing = isUnit ? game.renderer?.unitHeight(guid) ?? 2 : 1.2;
  const crown = isWorldObjectDead(object) ? Math.min(standing, CORPSE_CROWN_HEIGHT) : standing;
  return projectPoint({ x: position.x, y: position.y, z: position.z + crown }, camera, width, height);
}

function makeBubble(root: HTMLElement, guid: bigint): HTMLElement {
  const node = document.createElement("div");
  node.className = `chat-bubble ${bubbleKind.get(guid) ?? "chat-say"}`;
  root.append(node);
  bubbleNodes.set(guid, node);
  return node;
}

function makeFloater(root: HTMLElement, floater: Floater): HTMLElement {
  const node = document.createElement("div");
  node.className = floater.critical ? "combat-float is-crit" : "combat-float";
  node.dataset["kind"] = floater.kind;
  node.textContent = floater.text;
  root.append(node);
  floaterNodes.set(floater, node);
  return node;
}
