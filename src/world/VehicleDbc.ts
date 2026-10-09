// 11.02-F1: the four vehicle tables of the client data — Vehicle.dbc, VehicleSeat.dbc,
// VehicleUIIndicator.dbc and VehicleUIIndSeat.dbc — as `GET /dbc/vehicles?v=1` carries them
// (gateway/VehicleMetadata.ts) and as the page holds them (browser/VehicleClient.ts).
//
// Every column of every row travels, in the file's column order: the seat model (VehicleSeatModel.ts),
// the stock vehicle UI's C API (slice F2), the vehicle camera (G) and the passenger poses (H) all read
// this one table, and most of what they read is client data the core never loads. TrinityCore skips
// Vehicle columns 38-39 and VehicleSeat columns 46-57 ('x' in DBCfmt.h:141-142, commented out in
// DBCStructure.h:1788-1876); their types and names here are tswow's client definitions
// (tswow-scripts/wotlk/dbc/Vehicle.ts, VehicleSeat.ts — PowerDisplayID[3], the Camera* floats), and on
// this dataset they read as such (Vehicle 38-39 only 0 and -1; VehicleSeat 46-57 floats between -6.5
// and 60). The two indicator tables are not loaded by the core at all: tswow's VehicleUIIndicator.ts
// (ID, BackgroundTexture) and VehicleUIIndSeat.ts (ID, VehicleUIIndicatorID, VirtualSeatIndex, XPos,
// YPos), and Wow.exe reads the same offsets (0x00614d90 row+4 = indicator id; 0x00614ef0 row+8, +0xc,
// +0x10 = virtual seat index and the two floats).
//
// Format characters: 'n' the id, 'u' an unsigned 32-bit word (the flag words, which use bit 31),
// 'i' a signed 32-bit integer (UiSkin is -1 on four seats, PowerDisplayID[1..2] on two vehicles),
// 'f' a float, 's' a string.

/** The route's shape: `/dbc/vehicles?v=` this. Bump with every change of shape. */
export const VEHICLE_CATALOG_VERSION = 1;
export const VEHICLE_CATALOG_PATHNAME = "/dbc/vehicles";

/** 40 columns: DBCfmt.h:141 `niffffiiiiiiiifffffffffffffffssssfifiixx` with Flags unsigned and 38-39 read. */
export const VEHICLE_FORMAT = "nu" + "f".repeat(4) + "i".repeat(8) + "f".repeat(15) + "ssss" + "fifi" + "iii";
/** 58 columns: DBCfmt.h:142 `niiffffffffffiiiiiifffffffiiifffiiiiiiiffiiiiixxxxxxxxxxxx`, flag words unsigned, 46-57 read. */
export const VEHICLE_SEAT_FORMAT = "nui" + "f".repeat(10) + "i".repeat(6) + "f".repeat(7) + "iii" + "fff" + "i".repeat(7)
  + "ff" + "iiii" + "u" + "f".repeat(12);
export const VEHICLE_UI_INDICATOR_FORMAT = "ns";
export const VEHICLE_UI_IND_SEAT_FORMAT = "niiff";

/** `MAX_VEHICLE_SEATS` (DBCStructure.h:1786): the seat slots 0…7 of a Vehicle row. */
export const MAX_VEHICLE_SEATS = 8;

/** Vehicle.dbc column indices (DBCStructure.h:1788-1820; 38-39 from tswow's Vehicle.ts). */
export const VEHICLE_COLUMN = Object.freeze({
  ID: 0, Flags: 1, TurnSpeed: 2, PitchSpeed: 3, PitchMin: 4, PitchMax: 5,
  /** SeatID[8], columns 6-13: a VehicleSeat id per slot, 0 for none. */
  SeatID: 6,
  MouseLookOffsetPitch: 14, CameraFadeDistScalarMin: 15, CameraFadeDistScalarMax: 16, CameraPitchOffset: 17,
  FacingLimitRight: 18, FacingLimitLeft: 19,
  MsslTrgtTurnLingering: 20, MsslTrgtPitchLingering: 21, MsslTrgtMouseLingering: 22, MsslTrgtEndOpacity: 23,
  MsslTrgtArcSpeed: 24, MsslTrgtArcRepeat: 25, MsslTrgtArcWidth: 26,
  /** MsslTrgtImpactRadius[2], columns 27-28. */
  MsslTrgtImpactRadius: 27,
  MsslTrgtArcTexture: 29, MsslTrgtImpactTexture: 30,
  /** MsslTrgtImpactModel[2], columns 31-32. */
  MsslTrgtImpactModel: 31,
  CameraYawOffset: 33, UiLocomotionType: 34, MsslTrgtImpactTexRadius: 35, VehicleUIIndicatorID: 36,
  /** PowerDisplayID[3], columns 37-39; the core reads only the first. */
  PowerDisplayID: 37,
});

/** VehicleSeat.dbc column indices (DBCStructure.h:1822-1876; 46-57 from tswow's VehicleSeat.ts). */
export const VEHICLE_SEAT_COLUMN = Object.freeze({
  ID: 0, Flags: 1, AttachmentID: 2, AttachmentOffsetX: 3, AttachmentOffsetY: 4, AttachmentOffsetZ: 5,
  EnterPreDelay: 6, EnterSpeed: 7, EnterGravity: 8, EnterMinDuration: 9, EnterMaxDuration: 10,
  EnterMinArcHeight: 11, EnterMaxArcHeight: 12, EnterAnimStart: 13, EnterAnimLoop: 14,
  RideAnimStart: 15, RideAnimLoop: 16, RideUpperAnimStart: 17, RideUpperAnimLoop: 18,
  ExitPreDelay: 19, ExitSpeed: 20, ExitGravity: 21, ExitMinDuration: 22, ExitMaxDuration: 23,
  ExitMinArcHeight: 24, ExitMaxArcHeight: 25, ExitAnimStart: 26, ExitAnimLoop: 27, ExitAnimEnd: 28,
  PassengerYaw: 29, PassengerPitch: 30, PassengerRoll: 31, PassengerAttachmentID: 32,
  VehicleEnterAnim: 33, VehicleExitAnim: 34, VehicleRideAnimLoop: 35,
  VehicleEnterAnimBone: 36, VehicleExitAnimBone: 37, VehicleRideAnimLoopBone: 38,
  VehicleEnterAnimDelay: 39, VehicleExitAnimDelay: 40, VehicleAbilityDisplay: 41,
  EnterUISoundID: 42, ExitUISoundID: 43, UiSkin: 44, FlagsB: 45,
  CameraEnteringDelay: 46, CameraEnteringDuration: 47, CameraExitingDelay: 48, CameraExitingDuration: 49,
  CameraOffsetX: 50, CameraOffsetY: 51, CameraOffsetZ: 52, CameraPosChaseRate: 53, CameraFacingChaseRate: 54,
  CameraEnteringZoom: 55, CameraSeatZoomMin: 56, CameraSeatZoomMax: 57,
});

/** One row on the wire: the file's columns in order; a float that is not finite travels as null. */
export type VehicleDbcRow = readonly (number | string | null)[];

/** The route's answer. Rows in file order. */
export interface VehicleCatalogAnswer {
  readonly version: number;
  readonly vehicles: readonly VehicleDbcRow[];
  readonly seats: readonly VehicleDbcRow[];
  readonly indicators: readonly VehicleDbcRow[];
  readonly indicatorSeats: readonly VehicleDbcRow[];
}

export interface VehicleEntry {
  readonly id: number;
  /** `VehicleFlags` (VehicleDefines.h:38-49), VehicleSeatModel.ts `VEHICLE_FLAGS`. */
  readonly flags: number;
  readonly turnSpeed: number;
  readonly pitchSpeed: number;
  readonly pitchMin: number;
  readonly pitchMax: number;
  /** A VehicleSeat id per slot 0…7; 0 is no seat (the slot is skipped, not the end of the list). */
  readonly seatIds: readonly number[];
  readonly mouseLookOffsetPitch: number;
  readonly cameraFadeDistScalarMin: number;
  readonly cameraFadeDistScalarMax: number;
  readonly cameraPitchOffset: number;
  readonly facingLimitRight: number;
  readonly facingLimitLeft: number;
  readonly msslTrgtTurnLingering: number;
  readonly msslTrgtPitchLingering: number;
  readonly msslTrgtMouseLingering: number;
  readonly msslTrgtEndOpacity: number;
  readonly msslTrgtArcSpeed: number;
  readonly msslTrgtArcRepeat: number;
  readonly msslTrgtArcWidth: number;
  readonly msslTrgtImpactRadius: readonly [number, number];
  readonly msslTrgtArcTexture: string;
  readonly msslTrgtImpactTexture: string;
  readonly msslTrgtImpactModel: readonly [string, string];
  readonly cameraYawOffset: number;
  readonly uiLocomotionType: number;
  readonly msslTrgtImpactTexRadius: number;
  /** VehicleUIIndicator id; 0 is none (the stock seat indicator unloads). */
  readonly vehicleUIIndicatorId: number;
  readonly powerDisplayIds: readonly [number, number, number];
}

export interface VehicleSeatEntry {
  readonly id: number;
  /** `VehicleSeatFlags` (DBCEnums.h:469-503), VehicleSeatModel.ts `VEHICLE_SEAT_FLAGS`. */
  readonly flags: number;
  readonly attachmentId: number;
  readonly attachmentOffset: { readonly x: number; readonly y: number; readonly z: number };
  readonly enterPreDelay: number;
  readonly enterSpeed: number;
  readonly enterGravity: number;
  readonly enterMinDuration: number;
  readonly enterMaxDuration: number;
  readonly enterMinArcHeight: number;
  readonly enterMaxArcHeight: number;
  readonly enterAnimStart: number;
  readonly enterAnimLoop: number;
  readonly rideAnimStart: number;
  readonly rideAnimLoop: number;
  readonly rideUpperAnimStart: number;
  readonly rideUpperAnimLoop: number;
  readonly exitPreDelay: number;
  readonly exitSpeed: number;
  readonly exitGravity: number;
  readonly exitMinDuration: number;
  readonly exitMaxDuration: number;
  readonly exitMinArcHeight: number;
  readonly exitMaxArcHeight: number;
  readonly exitAnimStart: number;
  readonly exitAnimLoop: number;
  readonly exitAnimEnd: number;
  readonly passengerYaw: number;
  readonly passengerPitch: number;
  readonly passengerRoll: number;
  readonly passengerAttachmentId: number;
  readonly vehicleEnterAnim: number;
  readonly vehicleExitAnim: number;
  readonly vehicleRideAnimLoop: number;
  readonly vehicleEnterAnimBone: number;
  readonly vehicleExitAnimBone: number;
  readonly vehicleRideAnimLoopBone: number;
  readonly vehicleEnterAnimDelay: number;
  readonly vehicleExitAnimDelay: number;
  readonly vehicleAbilityDisplay: number;
  readonly enterUISoundId: number;
  readonly exitUISoundId: number;
  /** -1, 0 or 1 on this dataset; VehicleSeatModel.ts `vehicleSkinName`. */
  readonly uiSkin: number;
  /** `VehicleSeatFlagsB` (DBCEnums.h:505-517), VehicleSeatModel.ts `VEHICLE_SEAT_FLAGS_B`. */
  readonly flagsB: number;
  readonly cameraEnteringDelay: number;
  readonly cameraEnteringDuration: number;
  readonly cameraExitingDelay: number;
  readonly cameraExitingDuration: number;
  readonly cameraOffset: { readonly x: number; readonly y: number; readonly z: number };
  readonly cameraPosChaseRate: number;
  readonly cameraFacingChaseRate: number;
  readonly cameraEnteringZoom: number;
  readonly cameraSeatZoomMin: number;
  readonly cameraSeatZoomMax: number;
}

export interface VehicleUIIndicatorSeat {
  /** The VehicleUIIndSeat row id. */
  readonly id: number;
  /** 1-based, as `UnitVehicleSeatInfo("player", index)` takes it. */
  readonly virtualSeatIndex: number;
  /** Fractions of the 128×128 indicator, from its top-left corner. */
  readonly x: number;
  readonly y: number;
}

export interface VehicleUIIndicator {
  readonly id: number;
  readonly backgroundTexture: string;
  /**
   * Its VehicleUIIndSeat rows by ascending row id — `GetVehicleUIIndicatorSeat(id, i)` is the i-th:
   * Wow.exe 0x00614d90 walks the table's ids from 1 to the largest and keeps the rows of this indicator.
   */
  readonly seats: readonly VehicleUIIndicatorSeat[];
}

/** A row's value in column `column`, as `format` declares it; undefined when the value is not that type. */
function cell(row: VehicleDbcRow, column: number, format: string): number | string | undefined {
  const kind = format[column];
  const value = row[column];
  if (kind === "s") return typeof value === "string" ? value : undefined;
  if (kind === "f") {
    if (value === null) return Number.NaN;
    return typeof value === "number" ? value : undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (kind === "u") return value >= 0 && value <= 0xffff_ffff ? value : undefined;
  if (kind === "n") return value > 0 && value <= 0x7fff_ffff ? value : undefined;
  return value >= -0x8000_0000 && value <= 0x7fff_ffff ? value : undefined;
}

/** Every column of `row` checked against `format`; undefined for a row of another shape. */
function checkedRow(row: unknown, format: string): (number | string)[] | undefined {
  if (!Array.isArray(row) || row.length !== format.length) return undefined;
  const values: (number | string)[] = [];
  for (let column = 0; column < format.length; column++) {
    const value = cell(row as VehicleDbcRow, column, format);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function vehicleEntry(row: readonly (number | string)[]): VehicleEntry {
  const n = (column: number): number => row[column] as number;
  const s = (column: number): string => row[column] as string;
  const C = VEHICLE_COLUMN;
  return Object.freeze({
    id: n(C.ID), flags: n(C.Flags), turnSpeed: n(C.TurnSpeed), pitchSpeed: n(C.PitchSpeed),
    pitchMin: n(C.PitchMin), pitchMax: n(C.PitchMax),
    seatIds: Object.freeze(Array.from({ length: MAX_VEHICLE_SEATS }, (_, slot) => n(C.SeatID + slot))),
    mouseLookOffsetPitch: n(C.MouseLookOffsetPitch),
    cameraFadeDistScalarMin: n(C.CameraFadeDistScalarMin), cameraFadeDistScalarMax: n(C.CameraFadeDistScalarMax),
    cameraPitchOffset: n(C.CameraPitchOffset), facingLimitRight: n(C.FacingLimitRight), facingLimitLeft: n(C.FacingLimitLeft),
    msslTrgtTurnLingering: n(C.MsslTrgtTurnLingering), msslTrgtPitchLingering: n(C.MsslTrgtPitchLingering),
    msslTrgtMouseLingering: n(C.MsslTrgtMouseLingering), msslTrgtEndOpacity: n(C.MsslTrgtEndOpacity),
    msslTrgtArcSpeed: n(C.MsslTrgtArcSpeed), msslTrgtArcRepeat: n(C.MsslTrgtArcRepeat), msslTrgtArcWidth: n(C.MsslTrgtArcWidth),
    msslTrgtImpactRadius: Object.freeze([n(C.MsslTrgtImpactRadius), n(C.MsslTrgtImpactRadius + 1)] as const),
    msslTrgtArcTexture: s(C.MsslTrgtArcTexture), msslTrgtImpactTexture: s(C.MsslTrgtImpactTexture),
    msslTrgtImpactModel: Object.freeze([s(C.MsslTrgtImpactModel), s(C.MsslTrgtImpactModel + 1)] as const),
    cameraYawOffset: n(C.CameraYawOffset), uiLocomotionType: n(C.UiLocomotionType),
    msslTrgtImpactTexRadius: n(C.MsslTrgtImpactTexRadius), vehicleUIIndicatorId: n(C.VehicleUIIndicatorID),
    powerDisplayIds: Object.freeze([n(C.PowerDisplayID), n(C.PowerDisplayID + 1), n(C.PowerDisplayID + 2)] as const),
  });
}

function vehicleSeatEntry(row: readonly (number | string)[]): VehicleSeatEntry {
  const n = (column: number): number => row[column] as number;
  const C = VEHICLE_SEAT_COLUMN;
  return Object.freeze({
    id: n(C.ID), flags: n(C.Flags), attachmentId: n(C.AttachmentID),
    attachmentOffset: Object.freeze({ x: n(C.AttachmentOffsetX), y: n(C.AttachmentOffsetY), z: n(C.AttachmentOffsetZ) }),
    enterPreDelay: n(C.EnterPreDelay), enterSpeed: n(C.EnterSpeed), enterGravity: n(C.EnterGravity),
    enterMinDuration: n(C.EnterMinDuration), enterMaxDuration: n(C.EnterMaxDuration),
    enterMinArcHeight: n(C.EnterMinArcHeight), enterMaxArcHeight: n(C.EnterMaxArcHeight),
    enterAnimStart: n(C.EnterAnimStart), enterAnimLoop: n(C.EnterAnimLoop),
    rideAnimStart: n(C.RideAnimStart), rideAnimLoop: n(C.RideAnimLoop),
    rideUpperAnimStart: n(C.RideUpperAnimStart), rideUpperAnimLoop: n(C.RideUpperAnimLoop),
    exitPreDelay: n(C.ExitPreDelay), exitSpeed: n(C.ExitSpeed), exitGravity: n(C.ExitGravity),
    exitMinDuration: n(C.ExitMinDuration), exitMaxDuration: n(C.ExitMaxDuration),
    exitMinArcHeight: n(C.ExitMinArcHeight), exitMaxArcHeight: n(C.ExitMaxArcHeight),
    exitAnimStart: n(C.ExitAnimStart), exitAnimLoop: n(C.ExitAnimLoop), exitAnimEnd: n(C.ExitAnimEnd),
    passengerYaw: n(C.PassengerYaw), passengerPitch: n(C.PassengerPitch), passengerRoll: n(C.PassengerRoll),
    passengerAttachmentId: n(C.PassengerAttachmentID),
    vehicleEnterAnim: n(C.VehicleEnterAnim), vehicleExitAnim: n(C.VehicleExitAnim), vehicleRideAnimLoop: n(C.VehicleRideAnimLoop),
    vehicleEnterAnimBone: n(C.VehicleEnterAnimBone), vehicleExitAnimBone: n(C.VehicleExitAnimBone),
    vehicleRideAnimLoopBone: n(C.VehicleRideAnimLoopBone),
    vehicleEnterAnimDelay: n(C.VehicleEnterAnimDelay), vehicleExitAnimDelay: n(C.VehicleExitAnimDelay),
    vehicleAbilityDisplay: n(C.VehicleAbilityDisplay),
    enterUISoundId: n(C.EnterUISoundID), exitUISoundId: n(C.ExitUISoundID),
    uiSkin: n(C.UiSkin), flagsB: n(C.FlagsB),
    cameraEnteringDelay: n(C.CameraEnteringDelay), cameraEnteringDuration: n(C.CameraEnteringDuration),
    cameraExitingDelay: n(C.CameraExitingDelay), cameraExitingDuration: n(C.CameraExitingDuration),
    cameraOffset: Object.freeze({ x: n(C.CameraOffsetX), y: n(C.CameraOffsetY), z: n(C.CameraOffsetZ) }),
    cameraPosChaseRate: n(C.CameraPosChaseRate), cameraFacingChaseRate: n(C.CameraFacingChaseRate),
    cameraEnteringZoom: n(C.CameraEnteringZoom), cameraSeatZoomMin: n(C.CameraSeatZoomMin),
    cameraSeatZoomMax: n(C.CameraSeatZoomMax),
  });
}

/**
 * The four tables by id. A later row with an id already seen replaces it, as an id index filled in
 * file order does (the core's DBCStorage and Wow.exe's record-by-id array alike); this dataset has none.
 */
export class VehicleCatalog {
  readonly #vehicles = new Map<number, VehicleEntry>();
  readonly #seats = new Map<number, VehicleSeatEntry>();
  readonly #indicators = new Map<number, VehicleUIIndicator>();

  constructor(
    vehicles: readonly VehicleEntry[],
    seats: readonly VehicleSeatEntry[],
    indicators: readonly { id: number; backgroundTexture: string }[],
    indicatorSeats: readonly (VehicleUIIndicatorSeat & { indicatorId: number })[],
  ) {
    for (const row of vehicles) this.#vehicles.set(row.id, row);
    for (const row of seats) this.#seats.set(row.id, row);
    const byId = new Map<number, VehicleUIIndicatorSeat & { indicatorId: number }>();
    for (const row of indicatorSeats) byId.set(row.id, row);
    const ascending = [...byId.values()].sort((left, right) => left.id - right.id);
    const backgrounds = new Map<number, string>();
    for (const row of indicators) backgrounds.set(row.id, row.backgroundTexture);
    for (const [id, backgroundTexture] of backgrounds) {
      const own = ascending.filter((seat) => seat.indicatorId === id)
        .map(({ id: seatId, virtualSeatIndex, x, y }) => Object.freeze({ id: seatId, virtualSeatIndex, x, y }));
      this.#indicators.set(id, Object.freeze({ id, backgroundTexture, seats: Object.freeze(own) }));
    }
  }

  get vehicleCount(): number {
    return this.#vehicles.size;
  }

  get seatCount(): number {
    return this.#seats.size;
  }

  /** The Vehicle.dbc row; undefined for an id the table does not hold (or 0). */
  vehicle(id: number | undefined): VehicleEntry | undefined {
    return id === undefined ? undefined : this.#vehicles.get(id);
  }

  /** The VehicleSeat.dbc row by its own id (not a slot index — see `seatInSlot`). */
  seat(id: number | undefined): VehicleSeatEntry | undefined {
    return id === undefined ? undefined : this.#seats.get(id);
  }

  /**
   * The seat row of slot `slot` of vehicle `vehicleId` — Wow.exe 0x00756ec0: a slot past 7, a zero
   * SeatID or one the table does not hold is no seat.
   */
  seatInSlot(vehicleId: number | undefined, slot: number): VehicleSeatEntry | undefined {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_VEHICLE_SEATS) return undefined;
    const id = this.vehicle(vehicleId)?.seatIds[slot];
    return id ? this.#seats.get(id) : undefined;
  }

  /** `GetVehicleUIIndicator(id)`: the texture and, in `seats`, the indicator's seat buttons. */
  indicator(id: number | undefined): VehicleUIIndicator | undefined {
    return id === undefined ? undefined : this.#indicators.get(id);
  }
}

/**
 * One route answer, checked: undefined unless it is this version's shape. A row of another shape is
 * skipped rather than failing the catalog (the rest of the vehicles still work).
 */
export function vehicleCatalogFrom(data: unknown, version = VEHICLE_CATALOG_VERSION): VehicleCatalog | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const answer = data as Partial<Record<keyof VehicleCatalogAnswer, unknown>>;
  if (answer.version !== version) return undefined;
  const { vehicles, seats, indicators, indicatorSeats } = answer;
  if (!Array.isArray(vehicles) || !Array.isArray(seats) || !Array.isArray(indicators) || !Array.isArray(indicatorSeats)) {
    return undefined;
  }
  const rows = (list: unknown[], format: string): (number | string)[][] => {
    const kept: (number | string)[][] = [];
    for (const row of list) {
      const checked = checkedRow(row, format);
      if (checked) kept.push(checked);
    }
    return kept;
  };
  return new VehicleCatalog(
    rows(vehicles, VEHICLE_FORMAT).map(vehicleEntry),
    rows(seats, VEHICLE_SEAT_FORMAT).map(vehicleSeatEntry),
    rows(indicators, VEHICLE_UI_INDICATOR_FORMAT).map((row) => ({ id: row[0] as number, backgroundTexture: row[1] as string })),
    rows(indicatorSeats, VEHICLE_UI_IND_SEAT_FORMAT).map((row) => ({
      id: row[0] as number, indicatorId: row[1] as number, virtualSeatIndex: row[2] as number,
      x: row[3] as number, y: row[4] as number,
    })),
  );
}
