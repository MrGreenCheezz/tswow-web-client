import type { WorldPosition } from "../../world/WorldState.js";
import { classifyTeleport, type TeleportKind } from "./TeleportKind.js";

/**
 * 1.17: what a same-map teleport costs, by kind.
 *
 * A map change (`onWorldChanged`) tears the world down: curtain, keys released, collision and
 * encounters forgotten, music stopped. A teleport within the map keeps the map. Wow.exe applies it
 * in place (0x0072D2D0 → the move queue → 0x006ECF80): position and facing set, the fall reset,
 * and its input control re-issues whatever movement keys are still held (0x007413F0 → 0x005FBBC0),
 * so a mage who blinks holding W keeps running. Only a move of more than 150 yards brings the
 * loading screen up (see `TeleportKind.ts`).
 *
 * Every effect is a function the caller supplies, so this file decides *which* run and the browser
 * (EnterWorld) owns *how*.
 */
export interface SameMapTeleportEffects {
  /** Drop the fall clock and jump arc; keys stay as they are (`Movement.ts` `resetCharacterMotion`). */
  resetCharacterMotion(): void;
  /** Ask for the collision around the destination (`CollisionSource.refresh`). */
  refreshCollision(mapId: number, x: number, y: number): void;
  /** Far only. */
  spellVisualsWorldChanged(): void;
  showLoadingScreen(mapId: number): void;
  /** Keys, autorun and the fall (`Controls.ts` `clearHeldKeys`). */
  clearHeldKeys(): void;
  invalidateGroundCover(): void;
  clearPortraitTargets(): void;
  /** Redraw the unit frames without forgetting the encounter (`showUnitFrames`, not `forgetUnitFrames`). */
  refreshUnitFrames(): void;
  /** Re-read the zone under the minimap without hiding it. */
  refreshMinimapZone(): void;
  /**
   * Near only: send START again for every movement key still held (`Movement.ts`
   * `reissueHeldMovement`). `Player::TeleportTo` cleared the server's movement flags
   * (Player.cpp:1731), and Wow.exe re-issues held keys once the ACK is out (0x007413F0, case 199
   * → 0x005FBBC0), so W held through a blink is running again on every screen, not only this one.
   */
  reissueHeldMovement(): void;
}

/**
 * Run the effects of one kind of same-map teleport. Never on either path: `collision.reset()`
 * (the map's collision stays valid), forgetting encounters, stopping music or zone sound — the map,
 * the boss and the track are the same ones.
 */
export function applySameMapTeleport(
  effects: SameMapTeleportEffects, kind: TeleportKind, mapId: number, destination: WorldPosition,
): void {
  effects.resetCharacterMotion();
  effects.refreshCollision(mapId, destination.x, destination.y);
  if (kind === "near") {
    effects.reissueHeldMovement();
    return;
  }
  effects.spellVisualsWorldChanged();
  effects.showLoadingScreen(mapId);
  effects.clearHeldKeys();
  effects.invalidateGroundCover();
  effects.clearPortraitTargets();
  effects.refreshUnitFrames();
  effects.refreshMinimapZone();
}

export interface SameMapTeleportHandler extends SameMapTeleportEffects {
  /** Terrain and collision both ready at the point (`terrain.isReady && collision.isReady`). */
  destinationReady(mapId: number, x: number, y: number): boolean;
}

/**
 * The whole `WorldClient.onSameMapTeleport` answer: classify, then apply. Returns the kind taken.
 * (`CollisionSource.isReady` itself starts the requests for a point it has not planned.)
 */
export function handleSameMapTeleport(
  handler: SameMapTeleportHandler, mapId: number, destination: WorldPosition, origin: WorldPosition | undefined,
): TeleportKind {
  const kind = classifyTeleport({
    origin, destination, destinationReady: handler.destinationReady(mapId, destination.x, destination.y),
  });
  applySameMapTeleport(handler, kind, mapId, destination);
  return kind;
}
