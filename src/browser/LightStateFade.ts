// 05.10-A7b-5 (7.15): how far the world light has turned into the death light.
//
// 11.11 (7.15): no turn at all. The 2-second fade here was the plan's choice; Wow.exe has none. The
// death slot is a single word, 0x00d38b58, which 0x004f7020 sets from the ghost's `ScreenEffect` row
// (row 1 "Ghost Screen Effect": slot 4) through 0x007ecec0 and clears through 0x007ecee0, and
// 0x007f3230 reads it on every frame: set, the slot's parameter set replaces the light outright;
// clear, the living light is back on the same frame. Nothing between the two blends (the only
// weighted mix there, 0x007ec220, is the storm's, 0x00d38b88). The row's other words (+0x20, +0x24:
// 462 and 36) go to 0x004c8fa0, the ambience and music, not to the light.
//
// The class keeps its shape so the world loop needs no change: it answers 0 or 1.

/** Milliseconds for a full turn between the living light and the death light: none (Wow.exe). */
export const GHOST_LIGHT_FADE_MS = 0;

export class GhostLightFade {
  /** The death light's weight for this frame: 1 for a ghost, 0 otherwise, switched at once. */
  weight(ghost: boolean, _now: number): number {
    return ghost ? 1 : 0;
  }

  /** Nothing to forget; kept for the callers that reset it on a new world. */
  reset(): void {}
}
