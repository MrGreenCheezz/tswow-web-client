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
import { settingOn } from "./Settings.js";
import {
  addFloater, expire, floaterOffset, floatingAmountText, putBubble,
  type Bubble, type Floater, type FloaterKind,
} from "./OverlayModel.js";

/**
 * How far above the crown of the head a bubble hangs, clear of the name plate on the canvas.
 *
 * Sixty-six rather than forty-two since slice R6. The plate itself reaches 43 pixels above a
 * target's head with a cast bar on it, and the raid mark and the quest mark are drawn above the
 * plate rather than inside it, which is another twelve.
 */
const BUBBLE_GAP_PX = 66;
const FLOATER_GAP_PX = 12;

const bubbles: Bubble[] = [];
const floaters: Floater[] = [];
/** The element showing each entry, so a frame is a transform write and not a rebuild. */
const bubbleNodes = new Map<bigint, HTMLElement>();
const floaterNodes = new Map<Floater, HTMLElement>();

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
  if (guid === 0n || !settingOn("floatingCombatText")) return;
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
  expire(bubbles, now);
  expire(floaters, now);
  if (bubbles.length === 0 && floaters.length === 0) {
    if (bubbleNodes.size > 0 || floaterNodes.size > 0) resetHeadOverlay();
    return;
  }
  const root = overlayLayer();
  const world = game.world;
  const state = world?.state;
  const selfGuid = state?.selfGuid;
  const player = selfGuid === undefined ? undefined : state?.objects.get(selfGuid)?.position;
  if (!root || !state || !player) return;

  const bounds = root.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  // `view` and not `distance`, `viewPitch` and not `pitch`: the bubbles have to hang off the
  // camera the world was drawn with, or they float away from the heads they belong to for as long
  // as a wall is holding it in or a floor is holding it up. The pivot height comes from the same
  // place for the same reason.
  const camera = createCamera(player, game.camera.yaw, game.camera.viewPitch, game.camera.view,
    { pivotHeight: cameraPivotHeight() });

  const liveBubbles = new Set<bigint>();
  for (const bubble of bubbles) {
    const anchor = anchorFor(bubble.guid, camera, width, height);
    const node = bubbleNodes.get(bubble.guid) ?? makeBubble(root, bubble.guid);
    if (!anchor) {
      node.hidden = true;
      liveBubbles.add(bubble.guid);
      continue;
    }
    node.hidden = false;
    if (node.textContent !== bubble.text) node.textContent = bubble.text;
    node.style.transform = `translate(-50%, -100%) translate(${Math.round(anchor.x)}px, ${Math.round(anchor.y - BUBBLE_GAP_PX)}px)`;
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
      node.hidden = true;
      continue;
    }
    const offset = floaterOffset(floater, now);
    node.hidden = false;
    node.style.opacity = offset.opacity.toFixed(2);
    node.style.transform = `translate(-50%, -100%) translate(${Math.round(anchor.x + offset.dx)}px, ${Math.round(anchor.y - FLOATER_GAP_PX + offset.dy)}px)`;
  }
  for (const [floater, node] of floaterNodes) {
    if (liveFloaters.has(floater)) continue;
    node.remove();
    floaterNodes.delete(floater);
  }
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
