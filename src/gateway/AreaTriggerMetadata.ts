// The volumes behind `CMSG_AREATRIGGER` (plan item 2.01): AreaTrigger.dbc, served once per page as
// `/dbc/area-triggers?v=1` (CatalogRoutes.ts) and checked by the browser every frame
// (browser/game/AreaTriggers.ts).
//
// Everything a trigger does — an instance portal, a tavern's rest flag, an «explore» objective, a
// battleground flag capture, a TSWoW `AreaTrigger.OnTrigger` script — is the server's decision
// (`WorldSession::HandleAreaTriggerOpcode`, MiscHandler.cpp:725). What the server cannot do is
// notice that the player walked in: that is the client's report, and the client needs the volume.
//
// Not in the generated DBC_LAYOUTS; read with TrinityCore's own format for build 12340,
// `AreaTriggerEntryfmt = "niffffffff"` (DBCfmt.h:28), field order DBCStructure.h's AreaTriggerEntry:
// {ID, ContinentID, Pos.X, Pos.Y, Pos.Z, Radius, BoxLength, BoxWidth, BoxHeight, BoxYaw} — ten
// fields, forty bytes, no strings. Measured on this dataset: 1,220 rows (48,821 bytes, the same
// bytes as the client's own file), 687 spheres and 533 boxes on 97 maps, at most 182 on one map.

import { readFixed, type FixedRows } from "./DbcFixed.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const AREA_TRIGGERS_VERSION = 1;

/** `AreaTriggerEntryfmt = "niffffffff"`: an id, a map and eight floats. */
export const AREA_TRIGGER_LAYOUT = Object.freeze({ fieldCount: 10, recordSize: 40 });

/**
 * One trigger as the route carries it: `[id, map, x, y, z, radius, length, width, height, yaw]`.
 *
 * Server coordinates, the same X/Y the movement packets carry. `radius > 0` is a sphere and the box
 * fields are then ignored, exactly as `Player::IsInAreaTriggerRadius` ignores them (131 spheres
 * carry both). `yaw` is the file's value — three rows hold 10 and 90. The core folds it into
 * [0, 2π) when it builds the centre's `Position` (Position.h:33), which leaves its sine and cosine as
 * they are, so neither end folds it.
 */
export type AreaTriggerRow = [
  id: number, map: number, x: number, y: number, z: number,
  radius: number, length: number, width: number, height: number, yaw: number,
];

export interface AreaTriggerCatalog {
  version: number;
  /** Ascending by id. */
  triggers: AreaTriggerRow[];
}

/**
 * The shortest decimal that is still the same single-precision number.
 *
 * `readFloatLE` widens 76.027 to 76.0270004272461, and JSON would carry every one of those digits:
 * about twice the bytes for nothing, since `Math.fround` of the short form is the file's float
 * exactly. Nine significant digits always round-trip a float; most of these need five.
 */
export function shortestFloat(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return 0;
  for (let digits = 1; digits < 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return candidate;
  }
  return value;
}

/** The catalog out of already-checked rows; pure, so a test can feed it a synthetic file. */
export function areaTriggerCatalog(rows: FixedRows): AreaTriggerCatalog {
  const triggers: AreaTriggerRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    const id = rows.int(row, 0);
    const map = rows.int(row, 1);
    const floats = [2, 3, 4, 5, 6, 7, 8, 9].map((field) => rows.float(row, field));
    // A row the core could never match: no id to be sent by, or a number JSON cannot carry.
    if (id <= 0 || map < 0 || !floats.every(Number.isFinite)) continue;
    const [x, y, z, radius, length, width, height, yaw] = floats.map(shortestFloat) as [
      number, number, number, number, number, number, number, number,
    ];
    triggers.push([id, map, x, y, z, radius, length, width, height, yaw]);
  }
  triggers.sort((left, right) => left[0] - right[0]);
  return { version: AREA_TRIGGERS_VERSION, triggers };
}

export async function loadAreaTriggers(dbcDirectory: string): Promise<AreaTriggerCatalog> {
  return areaTriggerCatalog(await readFixed(dbcDirectory, "AreaTrigger", AREA_TRIGGER_LAYOUT));
}
