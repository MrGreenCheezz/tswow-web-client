import { readFile } from "node:fs/promises";
import { openDbc } from "./Dbc.js";

/**
 * The paths lifts and trams run on, out of `TransportAnimation.dbc`.
 *
 * The server does not move a `GAMEOBJECT_TYPE_TRANSPORT`: the relocation in `GameObject::Update`
 * is commented out, and the only thing it tells a client about one is a 16-bit phase. Everything
 * else — where the platform is at a given moment, and how long its round trip takes — is in this
 * table, which is why an elevator that nobody animates just stands there.
 *
 * A path is keyed on the game object's **template entry**, not on its display id: the same lift
 * model appears on several entries with different shafts. 82 entries in this dataset, 5,262
 * keyframes between them.
 */
export interface TransportKeyframe {
  /** Milliseconds into the cycle. */
  time: number;
  /** Offset from the object's spawn point, in its own frame. */
  x: number;
  y: number;
  z: number;
}

export interface TransportPath {
  entry: number;
  /** The cycle length: the largest `TimeIndex` the entry has. */
  period: number;
  frames: TransportKeyframe[];
}

/**
 * Reads every path in the table, merged by time.
 *
 * `SequenceID` is dropped on purpose, and that is the one decision here worth defending. It looks
 * like a path selector and is not: it names the animation the car itself plays at that moment —
 * entry 4170's rows read ShipStop(164) at rest, ShipStart(162) while it descends, ShipStop again
 * at the bottom — which is why 33 of the 49 multi-sequence entries have sequence ranges that
 * overlap in time. Filtering to sequence 0, which tswow's own `ElevatorKeyframes.getDefault()`
 * does, empties 32 of the 82 entries outright: the four Mesa Elevators, both Undervators and the
 * rest lose every row they have, and entry 4170's period becomes 0. The core does the same as
 * this does — `TransportMgr::AddPathNodeToTransport` keys on time alone.
 */
export function parseTransportPaths(payload: Uint8Array): Map<number, TransportPath> {
  const data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const dbc = openDbc(data, "TransportAnimation");

  const paths = new Map<number, TransportPath>();
  for (const row of dbc.rows()) {
    const entry = dbc.int(row, "TransportID");
    if (entry <= 0) continue;
    const frame: TransportKeyframe = {
      time: dbc.int(row, "TimeIndex"),
      x: dbc.float(row, "Pos", 0),
      y: dbc.float(row, "Pos", 1),
      z: dbc.float(row, "Pos", 2),
    };
    if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y) || !Number.isFinite(frame.z)) continue;
    let path = paths.get(entry);
    if (!path) {
      path = { entry, period: 0, frames: [] };
      paths.set(entry, path);
    }
    path.frames.push(frame);
    if (frame.time > path.period) path.period = frame.time;
  }
  for (const path of paths.values()) {
    path.frames.sort((left, right) => left.time - right.time);
  }
  return paths;
}

export async function loadTransportPaths(dbcDirectory: string): Promise<Map<number, TransportPath>> {
  return parseTransportPaths(await readFile(`${dbcDirectory}/TransportAnimation.dbc`));
}
