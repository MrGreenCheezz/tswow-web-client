/**
 * The C function stock Blizzard_ArenaUI reaches that no other seam answers: `GetNumArenaOpponents`.
 * Kept apart from the model (FrameXmlArena.ts) and the lazy owner (FrameXmlArenaLod.ts) so the world
 * seam's binding table imports nothing but this.
 *
 * `GetNumArenaOpponents` sizes ArenaEnemyBackground (UpdateArenaEnemyBackground,
 * Blizzard_ArenaUI.lua:315-320) and anchors WatchFrame under the last enemy frame
 * (UIParent_ManageFramePositions, UIParent.lua:1927-1930); outside a match it is 0.
 *
 * `IsInInstance`, the gate of both the load and the frames (UIParent.lua:666-669,
 * Blizzard_ArenaUI.lua:105-112), is FrameXmlDifficulty.ts's: it answers 1, "arena" while
 * SMSG_BATTLEFIELD_STATUS says a running arena match (the model's `inArena`) and the map's
 * InstanceType otherwise.
 */
import type { FrameXmlArenaOpponents } from "./FrameXmlArena.js";

/** The part of the world seam the bindings read. */
export interface FrameXmlArenaHost {
  readonly arena?: FrameXmlArenaOpponents | undefined;
}

export const FRAMEXML_ARENA_BINDINGS: Readonly<Record<string,
  (host: FrameXmlArenaHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetNumArenaOpponents: (host) => [host.arena?.count() ?? 0],
});
