import { minimapBlip, type WorldPoint } from "../MinimapGeometry.js";

/**
 * 7.57 (11.11): the minimap ping as Wow.exe 12340 raises it to the interface.
 *
 * The engine draws no ping of its own: the picture is stock Minimap.xml's `MinimapPing` frame
 * (UI-Minimap-Ping-Center/Expand/Rotate, MINIMAPPING_TIMER 5.5 s, the last 0.5 s fading), placed by
 * `Minimap_SetPing` from the event's two numbers. What the engine owns is the event:
 *
 * - `MSG_MINIMAP_PING` (handler 0x006e2e90, case 0x1d5) reads the guid and two floats and calls
 *   0x0057eb80. `Minimap:PingLocation` (0x0057ed70) calls the same function with the player's own
 *   guid right after sending the packet — and sends the packet only in a party or raid, while the
 *   event is raised either way. TrinityCore's relay (`HandleMinimapPingOpcode`) skips the pinger, so
 *   this local call is the only ping the pinger ever sees.
 * - 0x0057eb80 keeps the world point (0x00beba8c, read back by `Minimap:GetPingPosition` 0x0057efe0)
 *   and raises event 0x15f, `MINIMAP_PING` (the name table at 0x00c24eb0), with `"%s%f%f"`: a unit
 *   token, then the point relative to the player as a fraction of the circle's width — rotated by
 *   the facing when `rotateMinimap` is on, divided by twice the radius 0x007f3b90 answers (the
 *   yards across). The token is "player" unless the guid is a party member (`party%d`, the party
 *   list first) or a raid member (`raid%d`); any other guid — a Sentry Totem's — stays "player".
 * - The offset is taken once, when the event is raised; the stock frame then stays where it was put,
 *   it does not follow the point while the player walks.
 *
 * Nothing else reads the kept point: the minimap's tooltip engine (0x0057c720) has no line for a
 * ping, so 3.3.5 shows no "who pinged" name.
 */

/** `MINIMAP_PING`'s first argument (Wow.exe 0x0057eb80). */
export function minimapPingUnitToken(
  guid: bigint,
  selfGuid: bigint | undefined,
  partyUnit: (guid: bigint) => string | undefined,
  raidUnit: (guid: bigint) => string | undefined,
): string {
  if (guid === selfGuid) return "player";
  return partyUnit(guid) ?? raidUnit(guid) ?? "player";
}

/**
 * `MINIMAP_PING`'s second and third arguments, and `Minimap:GetPingPosition`'s answer: the ping's
 * offset from the player in fractions of the circle's width, x to the right and y up — what
 * `Minimap_SetPing` multiplies by `Minimap:GetWidth()`/`GetHeight()`. `facing` only while the map
 * rotates; the projection is the canvas's own, so the frame lands where the canvas draws that point.
 */
export function minimapPingFraction(
  player: WorldPoint,
  ping: WorldPoint,
  yardsAcross: number,
  facing: number | undefined,
): readonly [number, number] {
  if (!(yardsAcross > 0)) return [0, 0];
  const offset = minimapBlip(player, ping, yardsAcross, facing);
  // `+ 0` folds a negative zero, which Lua would print as "-0".
  return [offset.column + 0, -offset.row + 0];
}
