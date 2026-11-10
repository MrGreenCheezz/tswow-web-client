import type { DeathReleaseLocation } from "./DeathProtocol.js";

/**
 * 3.13 (11.11): the spirit healer's mark on the minimap, as Wow.exe 12340 keeps it
 * (.runtime/re-2026-11-11/minimap/spirit.c, spirit2.c, enter.c).
 *
 * - `SMSG_DEATH_RELEASE_LOC` (handler 0x006e2e90, case 0x378: map id, x, y, z) passes the point on to 0x0051f690
 *   while the player's PLAYER_FLAGS lack GHOST (0x10) — the release packet comes before the field update that makes
 *   the ghost — and passes map −1 and the origin while they have it.
 * - 0x0051f690 keeps the point for the world map, and sets the minimap's mark (0x007f4a00) only when the map id is the
 *   current map or −1; for another map the mark is left as it was.
 * - The mark is a client mark of 0x007f44a0's list: named SPIRIT_HEALER_RELEASE_RED, importance −1, flags 0x2 (an icon
 *   within 0.8 of the radius), POIIcons icon 8, a guide arrow farther out up to 694.44 yards. At the origin it is
 *   nothing, which is how map −1 (TrinityCore's `ResurrectPlayer`) clears it.
 * - It is cleared too when GHOST leaves PLAYER_FLAGS (0x006df710) and at login (0x00528010), never by a teleport.
 *
 * A mark outlives the ghost only by the flag edge, so a reader that shows it only while the player is a ghost shows
 * what Wow.exe does; the value here is what the client holds.
 */
export interface SpiritHealerMark {
  readonly x: number;
  readonly y: number;
}

/** POIIcons cell of the mark (0x007f4a00 writes 8, the corpse's cell). */
export const SPIRIT_HEALER_POI_ICON = 8;

/** The mark after a release packet: `ghost` is the player's GHOST flag as the packet arrives. */
export function spiritHealerMarkAfterRelease(
  previous: SpiritHealerMark | undefined,
  release: DeathReleaseLocation,
  currentMapId: number | undefined,
  ghost: boolean,
): SpiritHealerMark | undefined {
  if (ghost) return undefined;
  if (release.mapId !== -1 && release.mapId !== currentMapId) return previous;
  return release.x === 0 && release.y === 0 ? undefined : { x: release.x, y: release.y };
}
