import { CAMERA_FOV_DEGREES, createCamera, type Camera, type Vector3 } from "../SimpleScene.js";
import { cameraPivotHeight, game } from "./Context.js";
import { viewSubjectPosition } from "./ViewSubject.js"; // 11.02-I
import { spellCastBlockReason } from "../SpellCastGuard.js";
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { worldObject } from "../../world/Fields.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import { CAMERA_TERRAIN_ESCAPE_DEPTH } from "./Collision.js";
import { armItemTarget, cancelItemTarget, isItemTargetSpell, spellTargetsObject } from "./SpellCursor.js";

/**
 * Ground-target (reticle) casts: Blizzard, Flamestrike and friends do not take the selection.
 *
 * The wire already carries an explicit destination (`buildCastSpell` with `TARGET_FLAG_DEST_LOCATION`);
 * what was missing is choosing it. Before this the client always sent the selection's (or its own)
 * position, so every area spell landed where the target stood rather than where the player pointed.
 * The server still decides the outcome; this only chooses the requested landing point.
 */

/** Mirrors `SPELL_REQUIRED_TARGET_MODE.Ground` from the gateway targeting contract (v11). */
export const GROUND_TARGET_MODE = 3;
/** Sentinel range rows (`Anywhere`) carry no usable distance. */
const UNLIMITED_RANGE = 50000;
/** Ray march granularity and reach when the spell names no usable range. */
const MARCH_STEP_YARDS = 1;
const MARCH_FALLBACK_YARDS = 100;

export interface GroundPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A spell enters the reticle flow only through its contract mode — never a guessed id list. */
export function isGroundTargetSpell(metadata: { requiredTargetMode?: number } | undefined): boolean {
  return metadata?.requiredTargetMode === GROUND_TARGET_MODE;
}

/** Pending reticle cast, owned by the shared context so a world change clears it. */
export function pendingGroundTarget(): number | undefined {
  return game.groundTarget;
}

/** The item a pending reticle belongs to, if it was armed by using an item. */
export function pendingGroundTargetItem(): { bag: number; slot: number; guid: bigint } | undefined {
  return game.groundTargetItem;
}

export function beginGroundTarget(spellId: number): boolean {
  if (!game.world) return false;
  // One pending spell at a time: the reticle replaces a cursor waiting for an item (SpellCursor.ts).
  cancelItemTarget();
  game.groundTarget = spellId;
  // A fresh arming owns no item: the click below must not inherit a previous item reticle's
  // bag and slot. The item flow sets `groundTargetItem` itself right after this returns.
  game.groundTargetItem = undefined;
  return true;
}

export function cancelGroundTarget(): void {
  game.groundTarget = undefined;
  game.groundTargetItem = undefined;
  // The reticle's rings and any placing ghost are indication, not state: drop them with the arming
  // rather than on the next drawn frame, which a hidden world panel may not reach.
  game.renderer?.setGroundTargetPreview(undefined);
  game.renderer?.setGameObjectPreview(undefined);
}

/**
 * `ItemSpelltriggerType` values that spend the item on use (0), as a soulstone (4), on use
 * without delay (5) or by teaching (6) — the same family the tooltip calls «при использовании».
 * Equip (1) and proc (2) triggers never pass through `CMSG_USE_ITEM`.
 */
export const ITEM_USE_TRIGGERS: ReadonlySet<number> = new Set([0, 4, 5, 6]);

/** What using the item would cast: the first use-trigger spell, if any. */
export function itemUseSpellId(
  template: { spells?: ReadonlyArray<{ spellId: number; trigger: number }> } | undefined,
): number | undefined {
  const spells = template?.spells;
  if (!spells) return undefined;
  for (const spell of spells) {
    if (ITEM_USE_TRIGGERS.has(spell.trigger) && Number.isSafeInteger(spell.spellId) && spell.spellId > 0) {
      return spell.spellId;
    }
  }
  return undefined;
}

export interface ItemUseRef {
  readonly bag: number;
  readonly slot: number;
  readonly guid: bigint;
  readonly entry: number;
}

/** A bag slot as the inventory keeps it: address plus whatever item is standing in it. */
export interface InventorySlotRef {
  readonly bag: number;
  readonly slot: number;
  readonly guid: bigint;
  readonly item?: WorldObjectState | undefined;
}

/**
 * Item use from any bag/equipped slot UI: reticle when the item's own spell needs ground.
 *
 * The entry is read off the slot's item rather than passed separately, so a moved item keeps
 * working: the bar stores what to use, callers resolve where it is, and this resolves what it
 * is. An empty or entry-less slot sends the use straight through.
 */
export function requestInventoryItemUse(slot: InventorySlotRef, send: () => void): void {
  const entry = slot.item === undefined ? 0 : worldObject.entry(slot.item) ?? 0;
  requestItemUse({ bag: slot.bag, slot: slot.slot, guid: slot.guid, entry }, send);
}

/**
 * Routes an item use through the reticle when the item's own spell needs a ground point.
 *
 * The template comes from the session query cache (`SMSG_ITEM_QUERY_SINGLE_RESPONSE`); when it
 * has not arrived yet the use goes out exactly as before and the server decides — failing open
 * here is what keeps a first-ever use working instead of eating the click. When the template
 * is in hand but the spell's DBC row is not, the same applies: a plain use the realm refuses
 * is a server error the player can read, while a swallowed click is not.
 */
export function requestItemUse(
  ref: ItemUseRef,
  send: () => void,
  templates?: { get(entry: number): { spells?: ReadonlyArray<{ spellId: number; trigger: number }> } | undefined },
  spells?: Map<number, Pick<SpellMetadata, "requiredTargetMode" | "itemOrObject">>,
  waited = false,
): void {
  const world = game.world;
  if (!world) {
    send();
    return;
  }
  const template = (templates ?? world.itemTemplates)?.get(ref.entry);
  const spellId = itemUseSpellId(template);
  const metadata = spellId === undefined ? undefined : (spells ?? game.spells).get(spellId);
  if (spellId !== undefined && isGroundTargetSpell(metadata) && beginGroundTarget(spellId)) {
    game.groundTargetItem = { bag: ref.bag, slot: ref.slot, guid: ref.guid };
    world.onSpellStatus?.("Кликните по земле для выбора точки · правый клик или Esc — отмена", false);
    return;
  }
  // An item whose own spell waits for an item (a poison, a sharpening stone, an enchanting scroll)
  // raises the item-target cursor instead of a targetless use the realm would refuse (2.05).
  if (spellId !== undefined && isItemTargetSpell(metadata)) {
    cancelGroundTarget();
    if (armItemTarget(world, spellId, { bag: ref.bag, slot: ref.slot, guid: ref.guid }, spellTargetsObject(metadata))) {
      world.onSpellStatus?.("Выберите предмет · правый клик или Esc — отмена", false);
      return;
    }
  }
  // The item's spell row has not been asked for yet: a targetless use of a poison is a refusal the
  // player cannot act on, so the row is fetched once and the use decided after it (failing open).
  const client = game.spellMetadataClient;
  if (spellId !== undefined && metadata === undefined && spells === undefined && !waited && client) {
    const decide = (): void => {
      if (game.world !== world) return;
      requestItemUse(ref, send, templates, undefined, true);
    };
    void client.load([spellId]).then((loaded) => {
      if (game.world !== world || game.spellMetadataClient !== client) return;
      for (const [id, row] of loaded) game.spells.set(id, row);
      decide();
    }, decide);
    return;
  }
  send();
}

/**
 * Routes a direct cast through the reticle when the spell needs a ground point.
 *
 * Callers that bypass `castSpell` with their own preflight (mount summons, tracking toggles,
 * profession openers, module commands) keep their behaviour for every other spell; a ground
 * spell arms targeting first and the `send` closure never runs. The hint travels through the
 * world's own status line rather than the notice overlay, which keeps this module free of DOM
 * for the DOM-less unit tests. The click-time `castSpellAt` repeats the full guard chain, so a
 * cast that became illegal while aiming still fails loudly instead of sending a stale request.
 */
export function requestSpellCast(spellId: number, send: () => void): void {
  const world = game.world;
  const metadata: Pick<SpellMetadata, "requiredTargetMode" | "itemOrObject"> | undefined = game.spells.get(spellId);
  if (world && isGroundTargetSpell(metadata) && spellCastBlockReason(world, spellId) === undefined
    && beginGroundTarget(spellId)) {
    world.onSpellStatus?.("Кликните по земле для выбора точки · правый клик или Esc — отмена", false);
    return;
  }
  // Disenchant, Prospecting, Milling, Feed Pet: the spell waits for the item it goes on (2.05).
  if (world && isItemTargetSpell(metadata) && spellCastBlockReason(world, spellId) === undefined) {
    cancelGroundTarget();
    if (armItemTarget(world, spellId, undefined, spellTargetsObject(metadata))) {
      world.onSpellStatus?.("Выберите предмет · правый клик или Esc — отмена", false);
      return;
    }
  }
  send();
}

function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!(length > 0)) return { x: 0, y: 0, z: 1 };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

/**
 * The view ray through a canvas pixel, inverting `projectPoint` in SimpleScene: a pixel right of
 * centre carries a positive `right` component over `forward`, and one below centre a negative `up`
 * component, both scaled by the pixel focal length of the 52-degree vertical field of view.
 */
export function screenRay(
  camera: Camera, canvasWidth: number, canvasHeight: number, pixelX: number, pixelY: number,
): { origin: Vector3; direction: Vector3 } {
  const focal = canvasHeight / (2 * Math.tan(CAMERA_FOV_DEGREES * Math.PI / 360));
  return {
    origin: camera.position,
    direction: normalize({
      x: camera.forward.x + camera.right.x * ((pixelX - canvasWidth / 2) / focal)
        - camera.up.x * ((pixelY - canvasHeight / 2) / focal),
      y: camera.forward.y + camera.right.y * ((pixelX - canvasWidth / 2) / focal)
        - camera.up.y * ((pixelY - canvasHeight / 2) / focal),
      z: camera.forward.z + camera.right.z * ((pixelX - canvasWidth / 2) / focal)
        - camera.up.z * ((pixelY - canvasHeight / 2) / focal),
    }),
  };
}

function rayPoint(origin: Vector3, direction: Vector3, distance: number): Vector3 {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
    z: origin.z + direction.z * distance,
  };
}

/**
 * Walks a ray until it sinks into the ground, then bisects the landing point.
 *
 * `groundHeightAt` answers the highest walkable height under a column (terrain heightfield,
 * collision floors, or their maximum) and `undefined` where nothing is loaded there. Columns
 * without an answer are stepped over rather than treated as sea level, so an unloaded tile can
 * never become a cast at zero.
 */
export function rayGroundPoint(
  origin: Vector3,
  direction: Vector3,
  maxDistance: number,
  groundHeightAt: (x: number, y: number, refZ: number) => number | undefined,
): GroundPoint | undefined {
  if (!(maxDistance > 0)) return undefined;
  let previousDistance = 0;
  let previousHeight = origin.z - (groundHeightAt(origin.x, origin.y, origin.z) ?? Number.NEGATIVE_INFINITY);
  for (let distance = MARCH_STEP_YARDS; distance <= maxDistance; distance += MARCH_STEP_YARDS) {
    const point = rayPoint(origin, direction, distance);
    const ground = groundHeightAt(point.x, point.y, point.z);
    if (ground === undefined) {
      previousDistance = distance;
      previousHeight = Number.POSITIVE_INFINITY;
      continue;
    }
    const height = point.z - ground;
    if (previousHeight > 0 && height <= 0) {
      let low = previousDistance;
      let high = distance;
      for (let step = 0; step < 12; step += 1) {
        const mid = (low + high) / 2;
        const probe = rayPoint(origin, direction, mid);
        const probeGround = groundHeightAt(probe.x, probe.y, probe.z);
        if (probeGround === undefined || probe.z - probeGround > 0) low = mid;
        else high = mid;
      }
      const landing = rayPoint(origin, direction, high);
      const landingGround = groundHeightAt(landing.x, landing.y, landing.z);
      if (landingGround === undefined) return undefined;
      return { x: landing.x, y: landing.y, z: landingGround };
    }
    previousDistance = distance;
    previousHeight = height;
  }
  return undefined;
}

/** Every surface one ground query can land on, as the streamed world answers for a column. */
export interface GroundColumnSources {
  readonly heightAt?: ((x: number, y: number) => number | undefined) | undefined;
  readonly isHole?: ((x: number, y: number) => boolean) | undefined;
  readonly floorUnder?: ((x: number, y: number, fromZ: number, minZ: number) => number | undefined) | undefined;
  /** The heightfield is an invisible ceiling over the query: the collision floor is the ground. */
  readonly terrainIsCeiling?: boolean | undefined;
}

/**
 * The highest surface that can be stood on under one column.
 *
 * The same rule the click resolver uses: the heightfield answers unless it is an authored hole or
 * a ceiling over the player, and the collision floor in the given band competes with it.
 */
export function groundColumnHeight(x: number, y: number, refZ: number, sources: GroundColumnSources): number | undefined {
  const terrain = sources.terrainIsCeiling || sources.isHole?.(x, y) ? undefined : sources.heightAt?.(x, y);
  const floor = sources.floorUnder?.(x, y, refZ + 1, refZ - 200);
  let best: number | undefined;
  for (const candidate of [terrain, floor]) {
    if (candidate !== undefined && Number.isFinite(candidate)
      && (best === undefined || candidate > best)) best = candidate;
  }
  return best;
}

/**
 * Whether the player stands under the heightfield: a cave, a WMO basement, the inside of a bridge.
 *
 * The camera rig has always known this (`boomLimits`), and the same rule has to gate a reticle in
 * that cellar: the ADT above is an invisible ceiling and the authored collision floor is the ground.
 */
export function terrainIsCeilingAt(
  player: WorldPosition, pivotHeight: number,
  heightAt: ((x: number, y: number) => number | undefined) | undefined,
): boolean {
  const terrain = heightAt?.(player.x, player.y);
  return terrain !== undefined && Number.isFinite(terrain)
    && player.z + pivotHeight < terrain - CAMERA_TERRAIN_ESCAPE_DEPTH;
}

/** The live world's surfaces and ceiling rule, for the click resolver and the reticle ring alike. */
export function liveGroundSources(position: WorldPosition | undefined): GroundColumnSources {
  const world = game.world;
  if (!world || !position) return {};
  const mapId = world.mapId;
  const heightAt = mapId === undefined ? undefined : (x: number, y: number) => game.terrain?.heightAt(mapId, x, y);
  return {
    heightAt,
    isHole: mapId === undefined ? undefined : (x, y) => game.terrain?.isHole(mapId, x, y) ?? false,
    floorUnder: game.collision === undefined
      ? undefined : (x, y, fromZ, minZ) => game.collision?.world.floorUnder(x, y, fromZ, minZ),
    terrainIsCeiling: terrainIsCeilingAt(position, cameraPivotHeight(), heightAt),
  };
}

/** The largest area radius the spell's effects declare, in yards; zero when it names none. */
export function spellEffectRadius(metadata: { effectRadius?: readonly number[] } | undefined): number {
  let radius = 0;
  for (const value of metadata?.effectRadius ?? []) {
    if (typeof value === "number" && Number.isFinite(value)
      && value > radius && value < UNLIMITED_RANGE) radius = value;
  }
  return radius;
}

export interface GroundTargetInputs {
  readonly player: WorldPosition;
  readonly yaw: number;
  readonly viewPitch: number;
  readonly view: number;
  readonly pivotHeight: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly pixelX: number;
  readonly pixelY: number;
  /** Cast radius from the player; the ray itself starts behind and above them at the camera. */
  readonly targetRange: number;
  readonly heightAt?: ((x: number, y: number) => number | undefined) | undefined;
  readonly isHole?: ((x: number, y: number) => boolean) | undefined;
  readonly floorUnder?: ((x: number, y: number, fromZ: number, minZ: number) => number | undefined) | undefined;
  /** Overrides the cave rule when the caller has already measured it. */
  readonly terrainIsCeiling?: boolean | undefined;
}

/** The drawn camera's ray against the streamed world, in the units CMSG_CAST_SPELL carries. */
export function screenGroundPoint(inputs: GroundTargetInputs): GroundPoint | undefined {
  const camera = createCamera(
    inputs.player, inputs.yaw, inputs.viewPitch, inputs.view, { pivotHeight: inputs.pivotHeight },
  );
  const ray = screenRay(camera, inputs.canvasWidth, inputs.canvasHeight, inputs.pixelX, inputs.pixelY);
  // Spell range is measured from the caster, but the picking ray starts at the camera. At maximum
  // zoom even a point at the caster's feet is more than a short item range away from the ray origin.
  const rayReach = Math.max(0, inputs.view) + Math.max(0, inputs.pivotHeight)
    + Math.max(0, inputs.targetRange);
  const terrainIsCeiling = inputs.terrainIsCeiling
    ?? terrainIsCeilingAt(inputs.player, inputs.pivotHeight, inputs.heightAt);
  return rayGroundPoint(ray.origin, ray.direction, rayReach,
    (x, y, refZ) => groundColumnHeight(x, y, refZ, {
      heightAt: inputs.heightAt,
      isHole: inputs.isHole,
      floorUnder: inputs.floorUnder,
      terrainIsCeiling,
    }));
}

/** How far the reticle may reach for this spell; `undefined` means the row names no distance. */
export function groundTargetRange(rangeMax: number): number | undefined {
  if (!Number.isFinite(rangeMax) || rangeMax <= 0 || rangeMax >= UNLIMITED_RANGE) return undefined;
  return rangeMax;
}

/**
 * The horizontal range check the click and the live reticle share.
 *
 * The tolerance is the two yards the click has always allowed — the server measures the same
 * distance with its own bounding radius, and a point that is refused at exactly the limit would
 * read as a broken reticle. An unlimited range always fits.
 */
export function groundPointInRange(
  point: { x: number; y: number }, player: { x: number; y: number }, range: number | undefined,
): boolean {
  return range === undefined
    || Math.hypot(point.x - player.x, point.y - player.y) <= range + 2;
}

/**
 * Resolves a canvas click into a cast destination using the live world.
 *
 * Returns `undefined` when the ray meets no loaded ground (sky, unloaded tile) rather than a
 * fabricated point: the caller keeps the reticle open instead of sending a cast at nowhere.
 */
export function resolveGroundTarget(
  clientX: number, clientY: number, canvasWidth: number, canvasHeight: number, targetRange: number,
): GroundPoint | undefined {
  const world = game.world;
  // 11.02-I: the ray leaves the camera the world was drawn with, which is built around the view
  // subject (ViewSubject.ts): a possessed unit or a far sight eye once in view. The range is still
  // the caster's (`groundPointInRange` at the callers).
  const position = viewSubjectPosition(world);
  if (!world || !position) return undefined;
  const boundedRange = Math.max(0, targetRange);
  return screenGroundPoint({
    player: position,
    yaw: game.camera.yaw,
    viewPitch: game.camera.viewPitch,
    view: game.camera.view,
    pivotHeight: cameraPivotHeight(),
    canvasWidth,
    canvasHeight,
    pixelX: clientX,
    pixelY: clientY,
    targetRange: boundedRange > 0 ? boundedRange : MARCH_FALLBACK_YARDS,
    ...liveGroundSources(position),
  });
}
