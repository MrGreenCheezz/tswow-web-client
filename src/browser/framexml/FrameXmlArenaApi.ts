/**
 * The C functions stock Blizzard_ArenaUI reaches that no other seam answers: `GetNumArenaOpponents`
 * and the arena half of `IsInInstance`. Kept apart from the model (FrameXmlArena.ts) and the lazy
 * owner (FrameXmlArenaLod.ts) so the world seam's binding table imports nothing but this.
 *
 * `GetNumArenaOpponents` sizes ArenaEnemyBackground (UpdateArenaEnemyBackground,
 * Blizzard_ArenaUI.lua:315-320) and anchors WatchFrame under the last enemy frame
 * (UIParent_ManageFramePositions, UIParent.lua:1927-1930); outside a match it is 0.
 *
 * `IsInInstance` is the gate of both the load and the frames: UIParent's PLAYER_ENTERING_WORLD calls
 * `Arena_LoadUI()` only for instanceType "arena" (UIParent.lua:666-669), and
 * `ArenaEnemyFrames_UpdateVisible` shows the frames only there (Blizzard_ArenaUI.lua:105-112). The
 * neutral table answers `false, "none"` for every map (FrameXmlNeutralApi.ts); this binding answers
 * `true, "arena"` while SMSG_BATTLEFIELD_STATUS says a running arena match (the model's `inArena`),
 * and the neutral answer otherwise — dungeons and battlegrounds stay exactly as they were.
 */
import type { FrameXmlArenaOpponents } from "./FrameXmlArena.js";

/** The part of the world seam the bindings read. */
export interface FrameXmlArenaHost {
  readonly arena?: FrameXmlArenaOpponents | undefined;
}

const NOT_IN_INSTANCE: readonly [false, "none"] = Object.freeze([false, "none"] as const);
const IN_ARENA: readonly [true, "arena"] = Object.freeze([true, "arena"] as const);

export const FRAMEXML_ARENA_BINDINGS: Readonly<Record<string,
  (host: FrameXmlArenaHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetNumArenaOpponents: (host) => [host.arena?.count() ?? 0],
  IsInInstance: (host) => (host.arena?.inArena() ? IN_ARENA : NOT_IN_INSTANCE),
});
