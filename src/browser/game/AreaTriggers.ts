import { game } from "./Context.js";
import { sendMovement } from "../input/Movement.js";
import { OPCODES } from "../../generated/opcodes.js";
import { unit } from "../../world/Fields.js";
import { serverControlsMovement } from "../../world/WorldState.js";

/**
 * Area triggers (plan item 2.01): which AreaTrigger.dbc volume the character is in, and the one
 * `CMSG_AREATRIGGER` that says so.
 *
 * Everything a trigger does is the server's — an instance portal, a tavern's rest flag, an
 * «explore» objective, a battleground flag capture, a TSWoW script — and all of it starts with the
 * client reporting the volume, because nothing on the server watches the player walk. The core then
 * checks the claim against where it last saw the mover (`HandleAreaTriggerOpcode`,
 * MiscHandler.cpp:725; `Player::IsInAreaTriggerRadius`, Player.cpp:2370), which is why the report is
 * always preceded by a heartbeat carrying the position that is inside.
 *
 * The model is the stock client's (Wow.exe 12340; addresses for the reader, no code taken): one
 * current trigger (the id at 0xc9d330), checked on a 100 ms timer (0x6dbe30). While the current
 * trigger still holds the position nothing else is tested (0x6dbed6–0x6dbeea); once it is left, the
 * map's volumes are scanned in DBC order and the first that holds the position is reported —
 * `MSG_MOVE_HEARTBEAT`, then `CMSG_AREATRIGGER` — and becomes current (0x6dbf38–0x6dbfde). So a tick
 * reports at most one volume, and of two overlapping ones only the first, until it is left. That is
 * also the core's own shape: one `inn_triggerId` (Player.cpp:27522), rechecked every zone tick. The
 * current trigger is forgotten on entering the world (0x6d2f70) and on a map change (0x6dbeb7) and by
 * nothing else — no teleport handler touches it, so the first tick after any transfer reports the
 * volume holding the arrival point: a hearthstone into an inn sets the rest flag, as it does in the
 * stock client. Only the current point is tested, never the path between two ticks. An unreleased
 * corpse is not checked at all (0x6dbe71); a ghost has 1 health (`Player::BuildPlayerRepop`) and is.
 *
 * The geometry is the core's, without its slack: a sphere is `distance <= radius` (the core allows
 * the player's 1.5-yard combat reach on top, `WorldObject::GetDistance`), and a box is
 * `Position::IsWithinBox` — the point turned back by the box's yaw, no margin. Server coordinates
 * throughout, the same X/Y as the movement packets.
 *
 * No DOM. The top half is pure (the volumes, `triggerContains`, `AreaTriggerTracker`); the bottom
 * half is the one watcher the render loop drives (`updateAreaTriggers`, Loop.ts).
 */

// ---- the volumes -------------------------------------------------------------------------------

/** A route row, `[id, map, x, y, z, radius, length, width, height, yaw]` (gateway/AreaTriggerMetadata.ts). */
export type AreaTriggerRow = readonly [
  id: number, map: number, x: number, y: number, z: number,
  radius: number, length: number, width: number, height: number, yaw: number,
];

export interface AreaTriggerVolume {
  readonly id: number;
  readonly mapId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Positive for a sphere, whose box fields are then ignored (131 rows carry both). */
  readonly radius: number;
  /** A box's half extents along its own axes: `BoxLength / 2`, `BoxWidth / 2`, `BoxHeight / 2`. */
  readonly halfLength: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  /**
   * Of the file's `BoxYaw`. The core folds it into [0, 2π) when it builds the centre's `Position`
   * (Position.h:33) — three rows hold 10 and 90 — which leaves the sine and cosine as they are.
   */
  readonly cos: number;
  readonly sin: number;
}

/** The volume a row describes; undefined for the three all-zero boxes, which nothing can enter. */
export function areaTriggerVolume(row: AreaTriggerRow): AreaTriggerVolume | undefined {
  const [id, mapId, x, y, z, radius, length, width, height, yaw] = row;
  if (radius > 0) {
    return Object.freeze({ id, mapId, x, y, z, radius, halfLength: 0, halfWidth: 0, halfHeight: 0, cos: 1, sin: 0 });
  }
  if (!(length > 0) && !(width > 0) && !(height > 0)) return undefined;
  return Object.freeze({
    id, mapId, x, y, z, radius: 0, halfLength: length / 2, halfWidth: width / 2, halfHeight: height / 2,
    cos: Math.cos(yaw), sin: Math.sin(yaw),
  });
}

/** Whether the point is inside the volume, as the core would judge it without the combat reach. */
export function triggerContains(trigger: AreaTriggerVolume, x: number, y: number, z: number): boolean {
  const dx = x - trigger.x;
  const dy = y - trigger.y;
  const dz = z - trigger.z;
  if (trigger.radius > 0) return dx * dx + dy * dy + dz * dz <= trigger.radius * trigger.radius;
  // IsWithinBox rotates the point by 2π − yaw: cos(2π − yaw) = cos yaw, sin(2π − yaw) = −sin yaw.
  const localX = dx * trigger.cos + dy * trigger.sin;
  const localY = dy * trigger.cos - dx * trigger.sin;
  return Math.abs(localX) <= trigger.halfLength
    && Math.abs(localY) <= trigger.halfWidth
    && Math.abs(dz) <= trigger.halfHeight;
}

const NO_TRIGGERS: readonly AreaTriggerVolume[] = Object.freeze([]);

/**
 * The catalog by map, each map's list in DBC order — ascending id, which is the order the stock
 * client scans in (the file is sorted by map, and by id within a map). One array per map for the
 * life of the index.
 */
export class AreaTriggerIndex {
  readonly #byMap = new Map<number, readonly AreaTriggerVolume[]>();
  readonly #byId = new Map<number, AreaTriggerVolume>();

  constructor(rows: Iterable<AreaTriggerRow>) {
    const byMap = new Map<number, AreaTriggerVolume[]>();
    for (const row of rows) {
      const volume = areaTriggerVolume(row);
      if (!volume || this.#byId.has(volume.id)) continue;
      this.#byId.set(volume.id, volume);
      let list = byMap.get(volume.mapId);
      if (!list) byMap.set(volume.mapId, list = []);
      list.push(volume);
    }
    for (const [mapId, list] of byMap) {
      list.sort((left, right) => left.id - right.id);
      this.#byMap.set(mapId, Object.freeze(list));
    }
  }

  /** Volumes indexed; rows without one are not counted. */
  get size(): number {
    return this.#byId.size;
  }

  get(id: number): AreaTriggerVolume | undefined {
    return this.#byId.get(id);
  }

  /** Every volume on the map, the same array on every call; empty for a map with none. */
  triggersOn(mapId: number): readonly AreaTriggerVolume[] {
    return this.#byMap.get(mapId) ?? NO_TRIGGERS;
  }
}

// ---- the current trigger -----------------------------------------------------------------------

export interface AreaTriggerPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The volumes on one map; undefined while the catalog has not arrived. */
export type AreaTriggerLookup = (mapId: number) => readonly AreaTriggerVolume[] | undefined;

/** The stock client's current trigger and the scan that replaces it (see the top of this file). */
export class AreaTriggerTracker {
  readonly #lookup: AreaTriggerLookup;
  #current: AreaTriggerVolume | undefined;
  #mapId: number | undefined;

  constructor(lookup: AreaTriggerLookup) {
    this.#lookup = lookup;
  }

  /** The id of the volume last reported and not yet left. */
  get current(): number | undefined {
    return this.#current?.id;
  }

  /** Entering the world: no current trigger. */
  clear(): void {
    this.#current = undefined;
    this.#mapId = undefined;
  }

  /**
   * One tick at `position` on `mapId`: the id to report, if any.
   *
   * `canFire` false — the loading curtain, a taxi or another server spline, no mover granted —
   * reports nothing and makes nothing current, so the volume is reported on the first tick the
   * report can go out; leaving the current volume is still noticed, so a volume left and re-entered
   * meanwhile is reported again.
   */
  update(mapId: number | undefined, position: AreaTriggerPoint | undefined, canFire: boolean): number | undefined {
    if (mapId === undefined || !position) return undefined;
    const triggers = this.#lookup(mapId);
    if (!triggers) return undefined;
    if (mapId !== this.#mapId) {
      this.#mapId = mapId;
      this.#current = undefined;
    }
    const current = this.#current;
    if (current) {
      if (triggerContains(current, position.x, position.y, position.z)) return undefined;
      this.#current = undefined;
    }
    if (!canFire) return undefined;
    for (const trigger of triggers) {
      if (!triggerContains(trigger, position.x, position.y, position.z)) continue;
      this.#current = trigger;
      return trigger.id;
    }
    return undefined;
  }
}

// ---- the watcher the render loop drives --------------------------------------------------------

/** The stock client's timer (0x6dbe30 re-arms itself for 100 ms). */
export const AREA_TRIGGER_TICK = 100;

/** Where the watcher's reports go: the page's movement sender and WorldClient, or a test's log. */
export interface AreaTriggerPorts {
  /** `MSG_MOVE_HEARTBEAT` with the position as it stands, so the core sees the player inside. */
  heartbeat(): void;
  /** `CMSG_AREATRIGGER`. */
  enter(id: number): void;
}

/** The catalog as the watcher reads it (AreaTriggerClient). */
export interface AreaTriggerSource {
  /** The volumes on one map; undefined until the catalog has landed. */
  triggersOn(mapId: number): readonly AreaTriggerVolume[] | undefined;
}

/**
 * One world session: the tracker on the stock client's 100 ms tick, and the order of the packets —
 * the heartbeat, then the id — so the core reads the report against a position inside the volume.
 * Packets of one session are handled in order, so there is no race.
 */
export class AreaTriggerWatcher {
  readonly #ports: AreaTriggerPorts;
  readonly #tracker: AreaTriggerTracker;
  #source: AreaTriggerSource | undefined;
  #nextTickAt = Number.NEGATIVE_INFINITY;
  /** Ticks that ran the check, and `CMSG_AREATRIGGER` packets handed to the port. */
  ticks = 0;
  reported = 0;

  constructor(ports: AreaTriggerPorts) {
    this.#ports = ports;
    this.#tracker = new AreaTriggerTracker((mapId) => this.#source?.triggersOn(mapId));
  }

  /** The id of the volume last reported and not yet left. */
  get current(): number | undefined {
    return this.#tracker.current;
  }

  /**
   * A world mount (the stock client's world enter) or a world leave (`undefined`): this catalog, no
   * current trigger, and the first frame checks at once. A character that logs in inside a volume —
   * a tavern — reports it on the first tick the report can go out.
   */
  start(source: AreaTriggerSource | undefined): void {
    this.#source = source;
    this.#tracker.clear();
    this.#nextTickAt = Number.NEGATIVE_INFINITY;
  }

  /** Every frame, after the physics step; checks when a tick is due. */
  frame(mapId: number | undefined, position: AreaTriggerPoint | undefined, canFire: boolean, now: number): void {
    if (now < this.#nextTickAt) return;
    this.#nextTickAt = now + AREA_TRIGGER_TICK;
    this.ticks++;
    const id = this.#tracker.update(mapId, position, canFire);
    if (id === undefined) return;
    this.#ports.heartbeat();
    this.#ports.enter(id);
    this.reported++;
  }
}

/** The page's watcher: `startAreaTriggers`/`stopAreaTriggers` (AreaTriggerClient.ts) run its sessions. */
export const areaTriggers = new AreaTriggerWatcher({
  heartbeat: () => sendMovement(OPCODES.MSG_MOVE_HEARTBEAT),
  enter: (id) => game.world?.enterAreaTrigger(id),
});

/**
 * Loop.ts, every frame, right after `advancePhysics`. Nothing at all for an unreleased corpse (health
 * 0); otherwise a tick, whose report can go out when the curtain is down (`game.worldLoading` gates
 * both physics and `sendMovement`), a mover is granted and no taxi or server spline holds the
 * character (the core ignores the packet in flight anyway).
 */
export function updateAreaTriggers(now: number): void {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return;
  const self = world.state.objects.get(world.state.selfGuid);
  const health = self ? unit.health(self) : undefined;
  if (health !== undefined && health <= 0) return;
  areaTriggers.frame(world.mapId, self?.position,
    !game.worldLoading && world.movementReady && !serverControlsMovement(self), now);
}
