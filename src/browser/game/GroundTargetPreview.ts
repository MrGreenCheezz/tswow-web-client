import { game } from "./Context.js";
import {
  groundColumnHeight, groundPointInRange, groundTargetRange, liveGroundSources, pendingGroundTarget,
  resolveGroundTarget, spellEffectRadius, type GroundPoint,
} from "./GroundTarget.js";
import { gameObjectPlacementEntry, gameObjectPreviewModel } from "./GameObjectPreview.js";
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import type { WorldPosition } from "../../world/WorldState.js";

/**
 * The live ground reticle: where the click would land, how wide the spell's area is, and what a
 * placing spell is about to create.
 *
 * The click path (`Controls.confirmGroundTargetAt`) resolves a point once, on release. This module
 * answers the same question every frame while the reticle is armed, from the pointer's last
 * position over the world canvas, and pushes it to the renderer: a point marker, the effect radius
 * from `SpellRadius.dbc`, and — for a spell whose first effect names a game object template with a
 * display model — a translucent ghost of that model at the landing point.
 *
 * The server still owns the cast; everything here is indication. Resolution reuses the exact
 * picking, cave/hole and range rules the click uses, so what is drawn is what would be sent.
 */

/** The same reach the click falls back to when the spell names no usable range. */
const FALLBACK_RANGE = 100;

interface CanvasPointer {
  readonly clientX: number;
  readonly clientY: number;
}

let pointer: CanvasPointer | undefined;
/** 5.17: whether the last frame's reticle point was one the click would take (in range, on ground). */
let reticleInRange: boolean | undefined;

/** 5.17: the reticle's last verdict, for the cast cursor (Cast or UnableCast); undefined when none. */
export function groundTargetInRange(): boolean | undefined {
  return reticleInRange;
}

/**
 * Remembers where the pointer last was, in viewport units.
 *
 * Called from the pointer path on every move and press, and deliberately not throttled: a mouse
 * move is one number pair, and the frame that reads it does the expensive work once. The canvas
 * rectangle is read there instead of here so a move cannot force a layout write mid-gesture.
 */
export function recordGroundTargetPointer(clientX: number, clientY: number): void {
  pointer = { clientX, clientY };
}

function canvasRect(): { left: number; top: number; width: number; height: number } | undefined {
  const canvas = (globalThis as { document?: Document }).document
    ?.getElementById?.("world-canvas") as HTMLCanvasElement | null | undefined;
  const rect = canvas?.getBoundingClientRect?.();
  return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
}

function groundRingSampler(player: WorldPosition, point: GroundPoint): (x: number, y: number) => number | undefined {
  const sources = liveGroundSources(player);
  return (x, y) => groundColumnHeight(x, y, point.z, sources);
}

/**
 * The ghost of the game object the spell would place, once its template and display have landed.
 *
 * Both answers are asynchronous and are asked for here, once per entry/display: the template over
 * `CMSG_GAMEOBJECT_QUERY` (a preview has no live object to ask with, so the guid is zero — the
 * server ignores it) and the display's model over `/dbc/gameobjects`. Until both are in hand this
 * answers nothing; the next frame asks again from the caches, which is why a cold first aim simply
 * shows the rings and the model appears a moment later.
 */
function gameObjectGhost(
  metadata: Pick<SpellMetadata, "effects" | "effectMiscValue"> | undefined,
  player: WorldPosition, point: GroundPoint,
): { model: string; x: number; y: number; z: number; orientation: number; scale: number } | undefined {
  const world = game.world;
  if (!world) return undefined;
  const entry = gameObjectPlacementEntry(metadata);
  if (entry === undefined) return undefined;
  const template = world.gameObjectTemplate(entry, 0n);
  if (!template) return undefined;
  const displayId = template.displayId;
  if (Number.isSafeInteger(displayId) && displayId > 0) {
    const model = game.gameObjectMetadata?.get(displayId)?.model;
    if (model === undefined) {
      void game.gameObjectMetadata?.load([displayId]).catch(() => undefined);
      return undefined;
    }
    const preview = gameObjectPreviewModel(entry, template, model);
    if (!preview) return undefined;
    return {
      model: preview.model,
      x: point.x, y: point.y, z: point.z,
      orientation: Number.isFinite(player.orientation) ? player.orientation : 0,
      scale: preview.scale,
    };
  }
  return undefined;
}

/**
 * One frame of the reticle, from the already-current camera and world.
 *
 * Called by the render loop after the camera has been advanced for the frame, so the drawn ray is
 * the one this resolves against. Leaving the reticle (or losing the pointer, the world or the
 * renderer) clears both pushes instead of freezing the last picture on the ground.
 */
export function updateGroundTargetPreview(): void {
  const renderer = game.renderer;
  if (!renderer) return;
  const spellId = pendingGroundTarget();
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const position = self?.position;
  const rect = spellId === undefined ? undefined : canvasRect();
  if (spellId === undefined || !world || !position || !pointer || !rect) {
    reticleInRange = undefined;
    renderer.setGroundTargetPreview(undefined);
    renderer.setGameObjectPreview(undefined);
    return;
  }
  const metadata = game.spells.get(spellId);
  const range = groundTargetRange(metadata?.rangeMax ?? 0);
  const point = resolveGroundTarget(
    pointer.clientX - rect.left, pointer.clientY - rect.top, rect.width, rect.height, range ?? FALLBACK_RANGE,
  );
  const inRange = point !== undefined && groundPointInRange(point, position, range);
  reticleInRange = inRange;
  renderer.setGroundTargetPreview(point ? {
    x: point.x, y: point.y, z: point.z,
    radius: spellEffectRadius(metadata),
    inRange,
    ground: groundRingSampler(position, point),
  } : undefined);
  // A point the click would refuse gets no ghost: the model is a promise about what is placed,
  // and the red rings beside it already say why the promise is not being made.
  renderer.setGameObjectPreview(point && inRange ? gameObjectGhost(metadata, position, point) : undefined);
}
