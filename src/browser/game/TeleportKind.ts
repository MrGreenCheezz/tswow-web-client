import type { WorldPosition } from "../../world/WorldState.js";

/**
 * 1.17: how far a same-map teleport may go and still be treated as a step rather than a journey.
 *
 * The number is Wow.exe's own. When it applies a teleport to the unit the camera follows
 * (0x006ECF80), it compares the squared distance between the old and the new point — all three
 * axes — with 22500.0 (the float at 0x00A32904) and hands the result to 0x0074B620: over it, the
 * world is preloaded around the destination behind the loading screen (0x00781500 with its
 * second argument set, which draws the screen through 0x0040AB70 and tears it down through
 * 0x00409550); at or under it, the streaming centre simply moves (0x007815C0) and play goes on.
 */
export const NEAR_TELEPORT_YARDS = 150;

/**
 * "near": a step onto ground that has arrived. "hop" (5.36): a step whose ground is still on the wire — no
 * curtain, but gravity and movement wait for it (`holdUntilReady`). "far": a journey, behind the curtain.
 */
export type TeleportKind = "near" | "hop" | "far";

export interface TeleportClassification {
  /** Where the character stood before; undefined when it had no position yet. */
  origin: WorldPosition | undefined;
  destination: WorldPosition;
  /**
   * Whether terrain and collision have already answered at the destination. The stock client
   * loads synchronously; this one streams, so a short hop into ground nobody has fetched yet (a
   * blink into a building whose VMAP groups are still on the wire) must wait for it, or the first
   * physics frame falls through the floor.
   */
  destinationReady: boolean;
}

/**
 * Within `NEAR_TELEPORT_YARDS` of a known origin (strictly greater is far, as in Wow.exe): "near" onto ready
 * ground, "hop" onto ground still streaming. Everything else is "far".
 *
 * 5.36 (26.10, owner: «Скачок мага включает экран загрузки, хотя дистанция не большая»): a step onto unready
 * ground was "far" and brought the curtain up. The collision barrier is strict — every building group around
 * the point built — and the groups are built around where the character stands, so a 20-yard Blink often
 * landed among groups not yet built. Wow.exe never shows its curtain under 150 yards; the wait stays, unseen.
 */
export function classifyTeleport({ origin, destination, destinationReady }: TeleportClassification): TeleportKind {
  if (!origin) return "far";
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  const dz = destination.z - origin.z;
  if (dx * dx + dy * dy + dz * dz > NEAR_TELEPORT_YARDS * NEAR_TELEPORT_YARDS) return "far";
  return destinationReady ? "near" : "hop";
}
