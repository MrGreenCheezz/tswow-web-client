/**
 * 3.13 (12.10): the point of interest a gossip option pointed at — a city guard's directions — and how long it
 * stays, as Wow.exe keeps it (read-only Ghidra, `.runtime/re-2026-10-11/glue-1110/bf324-5..8.txt`).
 *
 * SMSG_GOSSIP_POI (0x0058a870) stores flags, x, y, icon, importance and name in the client's own POI slot 1
 * (0x007f4870: record 0x00d394e8, laid out like an AreaPOI row — importance +4, icon +8, x/y +0x30/+0x34, the
 * map it arrived on +0x3c, flags +0x40, name), sets its lifetime to 480 s (0x00d39440 = time + 0x1e0) and
 * rebuilds the world map's landmarks with it (0x00546310). The minimap's update (0x007f5ba0) clears it when the
 * time is up, and when the player comes within 10 yards of it (2D, squared distance under 100.0 at 0x009e8cc8),
 * rebuilding the landmarks again; the next SMSG_GOSSIP_POI replaces it. A POI at (0, 0) is none.
 *
 * WorldClient keeps the packet (`gossipPoi`, the map stamped on); this module adds the clock and the «reached»
 * rule, keyed by the packet object so a new POI starts over.
 */

/** Wow.exe 0x007f4870: 0x1e0 seconds. */
export const GOSSIP_POI_LIFETIME_MS = 480_000;
/** Wow.exe 0x007f5ba0 against 0x009e8cc8 (100.0): within 10 yards it is reached. */
const REACHED_SQUARED_YARDS = 100;

export interface GossipPoiMark {
  readonly flags: number;
  readonly x: number;
  readonly y: number;
  readonly icon: number;
  readonly importance: number;
  readonly name: string;
  /** The map the packet arrived on. */
  readonly mapId: number | undefined;
}

export interface GossipPoiWorld {
  readonly gossipPoi?: GossipPoiMark | undefined;
  readonly mapId?: number | undefined;
}

const firstSeen = new WeakMap<object, number>();
const gone = new WeakSet<object>();

/**
 * The live POI, or undefined once its time is up or the player reached it (`position`, the player's, on the
 * POI's own map). `now` is a monotonic millisecond clock (performance.now); the first sighting starts the clock.
 */
export function activeGossipPoi(
  world: GossipPoiWorld | undefined,
  now: number,
  position?: { readonly x: number; readonly y: number },
): GossipPoiMark | undefined {
  const poi = world?.gossipPoi;
  if (!poi || gone.has(poi) || (poi.x === 0 && poi.y === 0)) return undefined;
  const seen = firstSeen.get(poi);
  if (seen === undefined) firstSeen.set(poi, now);
  else if (now - seen >= GOSSIP_POI_LIFETIME_MS) {
    gone.add(poi);
    return undefined;
  }
  if (position && poi.mapId === world?.mapId) {
    const dx = position.x - poi.x;
    const dy = position.y - poi.y;
    if (dx * dx + dy * dy < REACHED_SQUARED_YARDS) {
      gone.add(poi);
      return undefined;
    }
  }
  return poi;
}
