import { globalString } from "../../generated/globalStrings.js";
import type { VehicleCatalog, VehicleSeatEntry } from "../../world/VehicleDbc.js";
import {
  canEjectPassengerFromSeat, canExitVehicle, canSwitchVehicleSeats, isVehicleAimAngleAdjustable, unitControllingVehicle,
  unitVehicleGuid, unitVehicleSeat, unitVehicleSeatCount, unitVehicleSeatInfo, vehicleSkinName, VEHICLE_SEAT_FLAGS,
  VEHICLE_SEAT_FLAGS_B,
} from "../../world/VehicleSeatModel.js";
import {
  ejectableOccupant, isUsingVehicleControls, isVehicleAimPowerAdjustable, passengerEnterArgs, passengerSeatOf,
  switchableVehicleSeat, vehicleAimEvents, vehicleEnterArgs, vehiclePassengersSignature, type PassengerSeat,
} from "../../world/VehicleUi.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { frameXmlWorldObjects } from "./FrameXmlWorldObjects.js"; // seam-sweep

/**
 * 11.02-F2: vehicles in the stock UI — the C API VehicleMenuBar.lua, MainMenuBar.lua, PlayerFrame.lua,
 * PartyMemberFrame.lua and BonusActionBarFrame.lua call, and the events they listen to, as Wow.exe 3.3.5a
 * 12340 answers and raises them. The seat rules are world/VehicleSeatModel.ts (11.02-F1) and
 * world/VehicleUi.ts; this file keeps the client state the events follow and answers the C API over
 * it (`frameXmlWithVehicle`). The vehicle's own bar on the main bar (VehicleMenuBarActionButton1–6 on
 * slots 121–126, keys 1–=) is the possess model's main-bar bit with the seat's VehicleAbilityDisplay
 * (FrameXmlPossess.ts, VehicleUi.ts `vehicleBarOnMainBar`).
 *
 * Without the vehicle tables (`/dbc/vehicles` not landed, or a gateway older than the route) nothing is
 * known about any seat: every name answers as it did before this slice and no event is raised.
 *
 * The C API (registration table, Ghidra read-only): UnitHasVehicleUI 0x00613740 (seat CAN_CAST,
 * boolean), UnitInVehicle 0x006133d0 and UnitUsingVehicle 0x006134a0 (1 or nil; usage error without a
 * string), UnitControllingVehicle 0x00613570, UnitInVehicleControlSeat 0x00613700 (CAN_CONTROL),
 * UnitTargetsVehicleInRaidUI 0x00613780 (FlagsB 0x8), UnitVehicleSkin 0x006137d0 (a string, nothing
 * without a seat), UnitVehicleSeatCount 0x00613830, UnitVehicleSeatInfo 0x006138c0 (five values:
 * controlType, occupant name, realm, ejectable, canSwitchSeats; nothing without the seat),
 * GetVehicleUIIndicator 0x00614e60 / GetVehicleUIIndicatorSeat 0x00614ef0 (usage errors without
 * numbers), CanExitVehicle 0x005fb9c0, CanSwitchVehicleSeats 0x005fba10 and IsUsingVehicleControls
 * 0x005fb970 (1 or nil), CanSwitchVehicleSeat 0x00608580 (boolean), VehicleExit 0x005fb660 (without
 * CAN_ENTER_OR_EXIT the UI error SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW), VehiclePrevSeat 0x005fb6d0 /
 * VehicleNextSeat 0x005fb720 (CAN_SWITCH), UnitSwitchToVehicleSeat 0x006139b0, CanEjectPassengerFromSeat
 * 0x00613d20 / EjectPassengerFromSeat 0x00613e10 (usage errors), IsVehicleAimAngleAdjustable 0x005f9f70
 * and IsVehicleAimPowerAdjustable 0x005f9fe0 (1 or nil). The unit's seat (0x00613600): in view, its
 * transport's seat row; a party member out of view, the VehicleSeat id SMSG_PARTY_MEMBER_STATS names.
 *
 * The events: UNIT_ENTERING_VEHICLE/UNIT_ENTERED_VEHICLE ("%s%b%s%s%b%d", 0x00748810), UNIT_EXITING_VEHICLE
 * ("%s") and UNIT_EXITED_VEHICLE ("%s%s", 0x00749650) on the character's seat changes (0x00749fb0's state
 * table: entering or switching — ENTERING then ENTERED; leaving — EXITING then EXITED), and for a party
 * member on its stats' seat (0x006cf740 flag 0x80000: a row — ENTERING+ENTERED with no vehicle, so
 * indicator 0; none — EXITING+EXITED); VEHICLE_PASSENGERS_CHANGED (0x0074ad70) when a passenger of the
 * character's root vehicle comes, goes or moves; PLAYER_GAINS_VEHICLE_DATA ("%s%d", 0x0074bbd0) and
 * PLAYER_LOSES_VEHICLE_DATA ("%s", 0x0074bc50) when the character's own vehicle kit comes and goes;
 * VEHICLE_UPDATE (0x00747f40) when the active mover changes, then 0x0074c5a0's VEHICLE_ANGLE_SHOW,
 * VEHICLE_POWER_SHOW and VEHICLE_ANGLE_UPDATE. After a UI reload Wow.exe announces the character's seat
 * once more (0x00749ed0 from 0x0052af40: ENTERING and ENTERED for "player"); the first poll after
 * `attach` does the same.
 *
 * Not repeated: the passenger's entering/exiting animation states 1-2/4-5 (Wow.exe raises ENTERED only
 * when the jump lands; here the seat is taken at once, so ENTERING and ENTERED come together); the sound
 * names of EnterUISoundID/ExitUISoundID ("" — SoundEntries is not served, no stock handler reads them);
 * the in-view party/raid passenger path of 0x0074ad70 and raid tokens (0x0060bb70's full token list:
 * here "player" and party1-4); VEHICLE_UPDATE at world entry (0x00717c50 — here only a change that
 * involves a mover other than the character, so ordinary play raises nothing new); 0x0074ba40's test in
 * the SHOW events; VEHICLE_ANGLE_UPDATE on later pitch changes (slice E, aiming).
 */

/** The world facts the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlVehicleWorld {
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, WorldObjectState>;
    readonly revision?: number;
  };
  readonly controlledGuid?: bigint | undefined;
  readonly partyStats?: ReadonlyMap<bigint, { readonly vehicleSeat?: number | undefined }>;
  leaveVehicle?(): void;
  changeVehicleSeat?(next: boolean): void;
  takeVehicleSeat?(vehicleGuid: bigint, seat: number): void;
  ejectPassenger?(passengerGuid: bigint): void;
}

export interface FrameXmlVehicleContext {
  readonly world: () => FrameXmlVehicleWorld | undefined;
  /** The vehicle tables (browser/VehicleClient.ts `vehicleCatalog`); undefined until they land. */
  readonly catalog: () => VehicleCatalog | undefined;
  /** The seam's unit tokens to a guid. */
  readonly unitGuid: (unit: string) => bigint | undefined;
  /** The party members in party1…party4 order (none in a raid); their stats can name a seat. */
  readonly partyGuids?: () => readonly bigint[];
  /** A unit's name as UnitName answers it; undefined while not known. */
  readonly nameOf?: (guid: bigint) => string | undefined;
}

interface FrameXmlVehiclePump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const FRAMEXML_VEHICLE_EVENTS = Object.freeze({
  entering: "UNIT_ENTERING_VEHICLE",
  entered: "UNIT_ENTERED_VEHICLE",
  exiting: "UNIT_EXITING_VEHICLE",
  exited: "UNIT_EXITED_VEHICLE",
  passengers: "VEHICLE_PASSENGERS_CHANGED",
  gains: "PLAYER_GAINS_VEHICLE_DATA",
  loses: "PLAYER_LOSES_VEHICLE_DATA",
  update: "VEHICLE_UPDATE",
} as const);

const NOTHING: readonly unknown[] = Object.freeze([]);

/** The model an attached stock seam holds: the chat API's VehicleExit asks it (FrameXmlChatApi.ts). */
let liveModel: FrameXmlVehicleModel | undefined;

/** The attached stock seam's vehicle model, undefined while none is attached. */
export function frameXmlVehicleLive(): FrameXmlVehicleModel | undefined {
  return liveModel;
}

/**
 * VehicleExit until the chat API installs its own (which asks the same model): the stub floor would
 * otherwise leave VehicleMenuBarLeaveButton's `OnClick function="VehicleExit"` without an answer. And
 * UnitVehicleSeatInfo's occupant name: the host's `false` (taken, name not known yet) is UNKNOWNOBJECT.
 */
export const FRAMEXML_VEHICLE_PRELUDE = `
do
  local exit = rawget(_G, "__fxSeam_WebClientVehicleExit")
  if exit ~= nil and rawget(_G, "VehicleExit") == nil then
    VehicleExit = function() exit() end
  end
  local seatInfo = rawget(_G, "__fxSeam_UnitVehicleSeatInfo")
  if seatInfo ~= nil and __fxNeutralImpl ~= nil then
    __fxNeutralImpl.UnitVehicleSeatInfo = function(...)
      local controlType, occupant, realm, ejectable, canSwitch = seatInfo(...)
      if occupant == false then occupant = UNKNOWNOBJECT end
      return controlType, occupant, realm, ejectable, canSwitch
    end
  end
end`;

function sameSeat(left: PassengerSeat | undefined, right: PassengerSeat | undefined): boolean {
  return left?.vehicleGuid === right?.vehicleGuid && left?.slot === right?.slot;
}

export class FrameXmlVehicleModel {
  readonly #context: FrameXmlVehicleContext;
  #pump: FrameXmlVehiclePump | undefined;
  /** The state was read once since attach (with the tables): later polls compare against it. */
  #primed = false;
  #selfSeat: PassengerSeat | undefined;
  #selfKit = 0;
  #mover: bigint | undefined;
  #passengers: string | undefined;
  #revision: number | undefined;
  /** Each party member's last stats seat (VehicleSeat id, 0 for none). */
  readonly #partySeats = new Map<bigint, number>();

  constructor(context: FrameXmlVehicleContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlVehiclePump): void {
    this.detach();
    this.#pump = pump;
    this.#primed = false;
    liveModel = this;
  }

  detach(): void {
    this.#pump = undefined;
    this.#primed = false;
    this.#partySeats.clear();
    if (liveModel === this) liveModel = undefined;
  }

  /** The tables are here: the C API answers from them, and the polls raise the events. */
  get active(): boolean {
    return this.#context.catalog() !== undefined;
  }

  /** Bring the state up to the world and raise what Wow.exe raises on the way (see the head). */
  tick(): void {
    const pump = this.#pump;
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    if (!pump || !world || !catalog) return;
    const objects = frameXmlWorldObjects(world); // seam-sweep
    const selfGuid = world.state.selfGuid;
    const self = selfGuid === undefined ? undefined : objects.get(selfGuid);
    const seat = passengerSeatOf(objects, selfGuid);
    const kit = self?.vehicleId ?? 0;
    const mover = world.controlledGuid;
    if (!this.#primed) {
      // A reload (or the tables' arrival): what the client already holds, and the seat announced once
      // more — 0x00749ed0 raises ENTERING and ENTERED for the character only.
      this.#primed = true;
      this.#selfSeat = seat;
      this.#selfKit = kit;
      this.#mover = mover;
      this.#revision = world.state.revision;
      this.#passengers = vehiclePassengersSignature(catalog, objects, selfGuid);
      this.#partySeats.clear();
      for (const guid of this.#context.partyGuids?.() ?? []) this.#partySeats.set(guid, world.partyStats?.get(guid)?.vehicleSeat ?? 0);
      if (seat !== undefined) this.#announceEnter(pump, ["player"], passengerEnterArgs(catalog, objects, seat));
      return;
    }
    if (!sameSeat(seat, this.#selfSeat)) {
      const was = this.#selfSeat;
      this.#selfSeat = seat;
      if (seat !== undefined) this.#announceEnter(pump, ["player"], passengerEnterArgs(catalog, objects, seat));
      else if (was !== undefined) this.#announceExit(pump, ["player"]);
    }
    // The passengers of the character's root vehicle: walked only when the world moved.
    const revision = world.state.revision;
    if (revision === undefined || revision !== this.#revision) {
      this.#revision = revision;
      const passengers = vehiclePassengersSignature(catalog, objects, selfGuid);
      const was = this.#passengers ?? "";
      this.#passengers = passengers;
      if (passengers !== undefined && passengers !== was) pump.fire(FRAMEXML_VEHICLE_EVENTS.passengers);
    }
    this.#tickParty(pump, world, catalog);
    if (kit !== this.#selfKit) {
      const had = this.#selfKit;
      this.#selfKit = kit;
      if (kit !== 0) pump.fire(FRAMEXML_VEHICLE_EVENTS.gains, "player", catalog.vehicle(kit)?.vehicleUIIndicatorId ?? 0);
      else if (had !== 0) pump.fire(FRAMEXML_VEHICLE_EVENTS.loses, "player");
    }
    if (mover !== this.#mover) {
      const was = this.#mover;
      this.#mover = mover;
      // Ordinary play (the character as its own mover, before and after) raises nothing new.
      const involvesOther = (was !== undefined && was !== selfGuid) || (mover !== undefined && mover !== selfGuid);
      if (involvesOther) {
        const moverObject = mover === undefined ? undefined : objects.get(mover);
        if (moverObject !== undefined) pump.fire(FRAMEXML_VEHICLE_EVENTS.update);
        for (const [event, ...args] of vehicleAimEvents(catalog, moverObject)) pump.fire(event, ...args);
      }
    }
  }

  /** 0x006cf740's flag 0x80000: a party member's stats seat came or went. */
  #tickParty(pump: FrameXmlVehiclePump, world: FrameXmlVehicleWorld, catalog: VehicleCatalog): void {
    const guids = this.#context.partyGuids?.() ?? [];
    for (let index = 0; index < guids.length; index++) {
      const guid = guids[index]!;
      const now = world.partyStats?.get(guid)?.vehicleSeat ?? 0;
      const was = this.#partySeats.get(guid);
      this.#partySeats.set(guid, now);
      if (was === undefined || was === now) continue;
      const unit = `party${index + 1}`;
      const row = catalog.seat(now);
      if (row !== undefined) this.#announceEnter(pump, [unit], vehicleEnterArgs(row, 0));
      else this.#announceExit(pump, [unit]);
    }
    if (this.#partySeats.size > guids.length) {
      for (const guid of [...this.#partySeats.keys()]) if (!guids.includes(guid)) this.#partySeats.delete(guid);
    }
  }

  #announceEnter(pump: FrameXmlVehiclePump, units: readonly string[], args: readonly unknown[]): void {
    for (const unit of units) pump.fire(FRAMEXML_VEHICLE_EVENTS.entering, unit, ...args);
    for (const unit of units) pump.fire(FRAMEXML_VEHICLE_EVENTS.entered, unit, ...args);
  }

  #announceExit(pump: FrameXmlVehiclePump, units: readonly string[]): void {
    for (const unit of units) pump.fire(FRAMEXML_VEHICLE_EVENTS.exiting, unit);
    for (const unit of units) pump.fire(FRAMEXML_VEHICLE_EVENTS.exited, unit, "");
  }

  // ---- the C API -------------------------------------------------------------------------------

  #world(): FrameXmlVehicleWorld | undefined {
    return this.#context.world();
  }

  #guid(unit: unknown): bigint | undefined {
    if (typeof unit !== "string" && typeof unit !== "number") return undefined;
    const guid = this.#context.unitGuid(String(unit).toLowerCase());
    return guid === undefined || guid === 0n ? undefined : guid;
  }

  /** 0x00613600: the unit's seat row — in view its transport's, a party member out of view its stats'. */
  seatOf(unit: unknown): VehicleSeatEntry | undefined {
    const catalog = this.#context.catalog();
    const world = this.#world();
    const guid = this.#guid(unit);
    if (!catalog || !world || guid === undefined) return undefined;
    if (frameXmlWorldObjects(world).has(guid)) return unitVehicleSeat(catalog, frameXmlWorldObjects(world), guid)?.seat; // seam-sweep
    const seatId = world.partyStats?.get(guid)?.vehicleSeat ?? 0;
    return seatId > 0 ? catalog.seat(seatId) : undefined;
  }

  /**
   * The "vehicle" unit token (Wow.exe 0x0060abf0): the character's transport while it rides a vehicle
   * (0x004f6250) — here a vehicle in view; undefined without the tables or off a vehicle.
   */
  vehicleUnitGuid(): bigint | undefined {
    const world = this.#world();
    if (!world || !this.active) return undefined;
    return unitVehicleGuid(frameXmlWorldObjects(world), world.state.selfGuid ?? 0n); // seam-sweep
  }

  /** UnitInVehicle/UnitUsingVehicle: the unit in view sits in a vehicle in view (the F1 model's passenger). */
  inVehicle(unit: unknown): boolean {
    const world = this.#world();
    const guid = this.#guid(unit);
    return world !== undefined && guid !== undefined && unitVehicleGuid(frameXmlWorldObjects(world), guid) !== undefined; // seam-sweep
  }

  controlling(unit: unknown): boolean {
    const world = this.#world();
    const guid = this.#guid(unit);
    return world !== undefined && guid !== undefined && unitControllingVehicle(frameXmlWorldObjects(world), guid); // seam-sweep
  }

  seatCount(unit: unknown): number {
    const catalog = this.#context.catalog();
    const world = this.#world();
    const guid = this.#guid(unit);
    return catalog && world && guid !== undefined ? unitVehicleSeatCount(catalog, frameXmlWorldObjects(world), guid) : 0; // seam-sweep
  }

  /** `UnitVehicleSeatInfo(unit, index)`: controlType, occupant, realm, ejectable, canSwitchSeats; nothing without a seat. */
  seatInfo(unit: unknown, index: unknown): readonly unknown[] {
    const catalog = this.#context.catalog();
    const world = this.#world();
    const guid = this.#guid(unit);
    const position = typeof index === "number" ? Math.trunc(index) : Math.trunc(Number(index));
    if (!catalog || !world || guid === undefined || !Number.isFinite(position)) return NOTHING;
    const info = unitVehicleSeatInfo(catalog, frameXmlWorldObjects(world), guid, position); // seam-sweep
    if (!info) return NOTHING;
    // An occupant whose name the client does not hold yet is `false` here; FRAMEXML_VEHICLE_PRELUDE turns it
    // into the Lua global UNKNOWNOBJECT, so the seat still reads as taken (VehicleSeatIndicator_Update).
    const occupant = info.occupantGuid === undefined ? undefined : this.#context.nameOf?.(info.occupantGuid) ?? false;
    return [info.controlType, occupant, undefined, info.ejectable, info.canSwitchSeats];
  }

  #self(): bigint | undefined {
    return this.#world()?.state.selfGuid;
  }

  canExit(): boolean {
    const catalog = this.#context.catalog();
    const world = this.#world();
    return catalog !== undefined && world !== undefined && canExitVehicle(catalog, frameXmlWorldObjects(world), this.#self()); // seam-sweep
  }

  canSwitch(): boolean {
    const catalog = this.#context.catalog();
    const world = this.#world();
    return catalog !== undefined && world !== undefined && canSwitchVehicleSeats(catalog, frameXmlWorldObjects(world), this.#self()); // seam-sweep
  }

  usingControls(): boolean {
    const catalog = this.#context.catalog();
    const world = this.#world();
    return catalog !== undefined && world !== undefined && isUsingVehicleControls(catalog, frameXmlWorldObjects(world), this.#self()); // seam-sweep
  }

  aimAngleAdjustable(): boolean {
    const catalog = this.#context.catalog();
    const world = this.#world();
    return catalog !== undefined && world !== undefined && isVehicleAimAngleAdjustable(catalog, frameXmlWorldObjects(world), this.#self()); // seam-sweep
  }

  aimPowerAdjustable(): boolean {
    const catalog = this.#context.catalog();
    const world = this.#world();
    return catalog !== undefined && world !== undefined && isVehicleAimPowerAdjustable(catalog, frameXmlWorldObjects(world), this.#self()); // seam-sweep
  }

  canEject(index: number): boolean {
    const catalog = this.#context.catalog();
    const world = this.#world();
    return catalog !== undefined && world !== undefined && canEjectPassengerFromSeat(catalog, frameXmlWorldObjects(world), this.#self(), index); // seam-sweep
  }

  /**
   * `VehicleExit()` (0x005fb660): the exit (WorldClient picks DISMISS or REQUEST_EXIT, 0x0074c7f0), or —
   * from a seat without CAN_ENTER_OR_EXIT — the UI error SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW (0x005216f0).
   */
  exit(): void {
    const world = this.#world();
    if (!world) return;
    if (this.canExit()) {
      world.leaveVehicle?.();
      return;
    }
    this.#pump?.fire("UI_ERROR_MESSAGE", globalString("SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW") ?? "SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW");
  }

  /** `VehiclePrevSeat()` / `VehicleNextSeat()`: a step, only from a seat with CAN_SWITCH. */
  step(next: boolean): void {
    if (this.canSwitch()) this.#world()?.changeVehicleSeat?.(next);
  }

  /** `UnitSwitchToVehicleSeat(unit, index)`: only for the character, to a free switchable seat. */
  switchTo(unit: unknown, index: unknown): void {
    const catalog = this.#context.catalog();
    const world = this.#world();
    const guid = this.#guid(unit);
    if (!catalog || !world || guid === undefined || guid !== world.state.selfGuid) return;
    const position = typeof index === "number" ? Math.trunc(index) : Math.trunc(Number(index));
    const target = switchableVehicleSeat(catalog, frameXmlWorldObjects(world), guid, position); // seam-sweep
    if (target) world.takeVehicleSeat?.(target.vehicleGuid, target.slot);
  }

  /** `EjectPassengerFromSeat(index)`: the occupant of that seat of the mover's root vehicle. */
  eject(index: number): void {
    const catalog = this.#context.catalog();
    const world = this.#world();
    if (!catalog || !world) return;
    const mover = world.controlledGuid ?? world.state.selfGuid;
    const occupant = ejectableOccupant(catalog, frameXmlWorldObjects(world), mover, index); // seam-sweep
    if (occupant !== undefined) world.ejectPassenger?.(occupant);
  }

  /** `GetVehicleUIIndicator(id)`: the texture and the number of seat buttons; nothing for no row. */
  indicator(id: number): readonly unknown[] {
    const row = this.#context.catalog()?.indicator(id);
    return row ? [row.backgroundTexture, row.seats.length] : NOTHING;
  }

  /** `GetVehicleUIIndicatorSeat(id, index)`: the virtual seat and the button's x, y; nothing past the last. */
  indicatorSeat(id: number, index: number): readonly unknown[] {
    const seat = this.#context.catalog()?.indicator(id)?.seats[index - 1];
    return seat ? [seat.virtualSeatIndex, seat.x, seat.y] : NOTHING;
  }
}

// ---- the bindings ----------------------------------------------------------------------------------

type VehicleBinding<Host> = (host: Host, args: readonly unknown[]) => readonly unknown[];

function vehicleOf(host: unknown): FrameXmlVehicleModel | undefined {
  const model = (host as { readonly vehicle?: unknown } | undefined)?.vehicle;
  return model instanceof FrameXmlVehicleModel && model.active ? model : undefined;
}

/** Lua's `lua_isnumber` and the integer the C function reads; throws the usage line otherwise. */
function integer(value: unknown, usage: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new Error(usage);
  return Math.trunc(number);
}

/** `lua_isstring`: a string or a number; the unit functions that check it raise their usage line. */
function unitArgument(value: unknown, usage: string): unknown {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(usage);
  return value;
}

const one = (truth: boolean): readonly unknown[] => (truth ? [1] : NOTHING);

/** What a name answered before slice F2 (the neutral table, FrameXmlNeutralApi.ts), for a seam without tables. */
const BEFORE: Readonly<Record<string, readonly unknown[]>> = Object.freeze({
  UnitHasVehicleUI: Object.freeze([false]),
  UnitInVehicle: Object.freeze([false]),
});

/**
 * The seam's binding table with the vehicle answers in front. A seam without the model, or without
 * the vehicle tables, answers exactly as before: the neutral answers of UnitHasVehicleUI and
 * UnitInVehicle, the existing VehicleExit, and nothing for the rest (the stub floor's answer).
 */
export function frameXmlWithVehicle<Host>(
  bindings: Readonly<Record<string, VehicleBinding<Host>>>,
): Record<string, VehicleBinding<Host>> {
  const fallback = (name: string, host: Host, args: readonly unknown[]): readonly unknown[] =>
    bindings[name]?.(host, args) ?? BEFORE[name] ?? NOTHING;
  const answer = (name: string, call: (model: FrameXmlVehicleModel, args: readonly unknown[]) => readonly unknown[]):
    VehicleBinding<Host> => (host, args) => {
    const model = vehicleOf(host);
    return model ? call(model, args) : fallback(name, host, args);
  };
  const wrapped: Record<string, VehicleBinding<Host>> = {
    UnitHasVehicleUI: answer("UnitHasVehicleUI", (model, args) =>
      [((model.seatOf(args[0])?.flags ?? 0) & VEHICLE_SEAT_FLAGS.CAN_CAST) !== 0]),
    UnitInVehicle: answer("UnitInVehicle", (model, args) =>
      one(model.inVehicle(unitArgument(args[0], 'Usage: UnitInVehicle("unit")')))),
    UnitUsingVehicle: answer("UnitUsingVehicle", (model, args) =>
      one(model.inVehicle(unitArgument(args[0], 'Usage: UnitUsingVehicle("unit")')))),
    UnitControllingVehicle: answer("UnitControllingVehicle", (model, args) => [model.controlling(args[0])]),
    UnitInVehicleControlSeat: answer("UnitInVehicleControlSeat", (model, args) =>
      [((model.seatOf(args[0])?.flags ?? 0) & VEHICLE_SEAT_FLAGS.CAN_CONTROL) !== 0]),
    UnitTargetsVehicleInRaidUI: answer("UnitTargetsVehicleInRaidUI", (model, args) =>
      [((model.seatOf(args[0])?.flagsB ?? 0) & VEHICLE_SEAT_FLAGS_B.TARGETS_IN_RAIDUI) !== 0]),
    UnitVehicleSkin: answer("UnitVehicleSkin", (model, args) => {
      const seat = model.seatOf(args[0]);
      return seat ? [vehicleSkinName(seat.uiSkin)] : NOTHING;
    }),
    UnitVehicleSeatCount: answer("UnitVehicleSeatCount", (model, args) => [model.seatCount(args[0])]),
    UnitVehicleSeatInfo: answer("UnitVehicleSeatInfo", (model, args) => model.seatInfo(args[0], args[1])),
    GetVehicleUIIndicator: answer("GetVehicleUIIndicator", (model, args) =>
      model.indicator(integer(args[0], "Usage: GetVehicleUIIndicator(indicatorID)"))),
    GetVehicleUIIndicatorSeat: answer("GetVehicleUIIndicatorSeat", (model, args) => {
      const usage = "Usage: GetVehicleUIIndicatorSeat(indicatorID, indicatorSeatIndex)";
      return model.indicatorSeat(integer(args[0], usage), integer(args[1], usage));
    }),
    CanExitVehicle: answer("CanExitVehicle", (model) => one(model.canExit())),
    CanSwitchVehicleSeats: answer("CanSwitchVehicleSeats", (model) => one(model.canSwitch())),
    CanSwitchVehicleSeat: answer("CanSwitchVehicleSeat", (model) => [model.canSwitch()]),
    IsUsingVehicleControls: answer("IsUsingVehicleControls", (model) => one(model.usingControls())),
    IsVehicleAimAngleAdjustable: answer("IsVehicleAimAngleAdjustable", (model) => one(model.aimAngleAdjustable())),
    IsVehicleAimPowerAdjustable: answer("IsVehicleAimPowerAdjustable", (model) => one(model.aimPowerAdjustable())),
    // VehicleExit itself belongs to the chat API (FrameXmlChatApi.ts, which asks `frameXmlVehicleLive`);
    // this host name stands in until that installs (FRAMEXML_VEHICLE_PRELUDE).
    WebClientVehicleExit: answer("WebClientVehicleExit", (model) => {
      model.exit();
      return NOTHING;
    }),
    VehiclePrevSeat: answer("VehiclePrevSeat", (model) => {
      model.step(false);
      return NOTHING;
    }),
    VehicleNextSeat: answer("VehicleNextSeat", (model) => {
      model.step(true);
      return NOTHING;
    }),
    UnitSwitchToVehicleSeat: answer("UnitSwitchToVehicleSeat", (model, args) => {
      model.switchTo(args[0], args[1]);
      return NOTHING;
    }),
    CanEjectPassengerFromSeat: answer("CanEjectPassengerFromSeat", (model, args) =>
      [model.canEject(integer(args[0], "Usage: CanEjectPassengerFromSeat(seatIndex)"))]),
    EjectPassengerFromSeat: answer("EjectPassengerFromSeat", (model, args) => {
      model.eject(integer(args[0], "Usage: EjectPassengerFromSeat(seatIndex)"));
      return NOTHING;
    }),
  };
  return { ...bindings, ...wrapped };
}
