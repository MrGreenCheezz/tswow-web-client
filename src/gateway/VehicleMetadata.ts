// 11.02-F1: the vehicle tables for the browser, `GET /dbc/vehicles?v=1` — a row of CatalogRoutes.ts
// (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped).
//
// Vehicle.dbc, VehicleSeat.dbc, VehicleUIIndicator.dbc and VehicleUIIndSeat.dbc, every row and every
// column in file order (the shape and the column names: world/VehicleDbc.ts). Each table's header is
// checked against its declared layout first, so a dataset built for another client is a 500 rather
// than rows read at the wrong offsets.
//
// All rows at once rather than `?ids=` batches, measured on this dataset (412 vehicles, 720 seats, 9
// indicators, 19 indicator seats): the whole answer is 172,207 bytes of JSON (17,746 gzipped; catalog
// routes are not compressed), parsed in under a millisecond; one vehicle with its seats and indicator
// is 480 bytes on average and 1,660 at most. The batches would be smaller in total, but the stock UI
// asks synchronously — UNIT_ENTERING_VEHICLE's skin and showVehicleUI, `UnitVehicleSeatInfo` for every
// seat button — at the moment the seat changes, and a seat's numbering needs the rows of every
// accessory vehicle on the root as well; a player's vehicle kit (SMSG_PLAYER_VEHICLE_DATA) names its id
// in the same breath as the seating. One request per page, at the world mount, has every row there
// before any of that happens.
//
// Floats travel in their shortest decimal form that reads back as the same single-precision value
// (0.6981317 rather than 0.6981316804885864); a float that is not finite travels as null (none on this
// dataset).

import { DbcError } from "./Dbc.js";
import { readFixed, type FixedLayout, type FixedRows } from "./DbcFixed.js";
import {
  VEHICLE_CATALOG_VERSION, VEHICLE_FORMAT, VEHICLE_SEAT_FORMAT, VEHICLE_UI_INDICATOR_FORMAT, VEHICLE_UI_IND_SEAT_FORMAT,
  type VehicleCatalogAnswer, type VehicleDbcRow,
} from "../world/VehicleDbc.js";

export const VEHICLES_VERSION = VEHICLE_CATALOG_VERSION;

const layoutOf = (format: string): FixedLayout => Object.freeze({ fieldCount: format.length, recordSize: format.length * 4 });

/** 40 fields, 160 bytes. */
export const VEHICLE_LAYOUT = layoutOf(VEHICLE_FORMAT);
/** 58 fields, 232 bytes. */
export const VEHICLE_SEAT_LAYOUT = layoutOf(VEHICLE_SEAT_FORMAT);
/** 2 fields, 8 bytes. */
export const VEHICLE_UI_INDICATOR_LAYOUT = layoutOf(VEHICLE_UI_INDICATOR_FORMAT);
/** 5 fields, 20 bytes. */
export const VEHICLE_UI_IND_SEAT_LAYOUT = layoutOf(VEHICLE_UI_IND_SEAT_FORMAT);

/** The shortest decimal that is the same float32; null for NaN or an infinity (JSON has neither). */
export function float32Json(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return candidate;
  }
  return value;
}

/** Every row of a table, every column read as `format` names it. */
export function formattedRows(table: string, rows: FixedRows, format: string): VehicleDbcRow[] {
  const out: VehicleDbcRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    const values: (number | string | null)[] = [];
    for (let column = 0; column < format.length; column++) {
      const kind = format[column];
      if (kind === "f") values.push(float32Json(rows.float(row, column)));
      else if (kind === "s") values.push(rows.string(row, column));
      else if (kind === "u") values.push(rows.int(row, column) >>> 0);
      else if (kind === "i" || kind === "n") values.push(rows.int(row, column));
      else throw new DbcError(`${table}: unknown format character ${kind}`);
    }
    out.push(values);
  }
  return out;
}

/** The answer out of already-checked tables; pure, so a test can feed it synthetic files. */
export function vehicleCatalogAnswer(tables: {
  vehicles: FixedRows; seats: FixedRows; indicators: FixedRows; indicatorSeats: FixedRows;
}): VehicleCatalogAnswer {
  return {
    version: VEHICLES_VERSION,
    vehicles: formattedRows("Vehicle", tables.vehicles, VEHICLE_FORMAT),
    seats: formattedRows("VehicleSeat", tables.seats, VEHICLE_SEAT_FORMAT),
    indicators: formattedRows("VehicleUIIndicator", tables.indicators, VEHICLE_UI_INDICATOR_FORMAT),
    indicatorSeats: formattedRows("VehicleUIIndSeat", tables.indicatorSeats, VEHICLE_UI_IND_SEAT_FORMAT),
  };
}

export async function loadVehicles(dbcDirectory: string): Promise<VehicleCatalogAnswer> {
  const [vehicles, seats, indicators, indicatorSeats] = await Promise.all([
    readFixed(dbcDirectory, "Vehicle", VEHICLE_LAYOUT),
    readFixed(dbcDirectory, "VehicleSeat", VEHICLE_SEAT_LAYOUT),
    readFixed(dbcDirectory, "VehicleUIIndicator", VEHICLE_UI_INDICATOR_LAYOUT),
    readFixed(dbcDirectory, "VehicleUIIndSeat", VEHICLE_UI_IND_SEAT_LAYOUT),
  ]);
  return vehicleCatalogAnswer({ vehicles, seats, indicators, indicatorSeats });
}
