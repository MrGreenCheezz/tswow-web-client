import type { VehicleCatalog, VehicleEntry } from "../../world/VehicleDbc.js";
import { VEHICLE_FLAGS, VEHICLE_SEAT_FLAGS, unitVehicleSeat, vehicleOf } from "../../world/VehicleSeatModel.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { setVehicleAimPower, vehicleAimInput, vehicleAimPower, type VehicleAimInput } from "../game/VehicleAim.js";
import { frameXmlWorldObjects } from "./FrameXmlWorldObjects.js"; // seam-sweep

/**
 * 11.02-E: the stock UI's aim — the VehicleAim* C API that VehicleMenuBar.xml's pitch buttons and slider
 * and Bindings.xml's VEHICLEAIM* bindings call, and VEHICLE_ANGLE_UPDATE that moves the slider's marker
 * (VehicleMenuBar.lua:820-845) — as Wow.exe 3.3.5a 12340 answers them (registration table 0x00ad1a48…
 * 0x00ad1aa0; Ghidra read-only, .runtime/re-2026-10-03/l1102e/r1-r2.c and l1102gf3/r1.c, r4.c):
 *
 * - VehicleAimGetAngle 0x005f9e10: the aimer's pitch (0x005f9d20: the vehicle the character drives from a
 *   CAN_CONTROL seat, else the character), 0 without one.
 * - VehicleAimGetNormAngle 0x005f9e60: that pitch over [PitchMin, PitchMax] with the aimer's CUSTOM_PITCH,
 *   else over ±π/2 (a unit with no row included); 0 when the span is under 1e-4 or there is no aimer.
 * - VehicleAimRequestAngle 0x005fb820: the active mover, when its Vehicle row has ADJUST_AIM_ANGLE 0x400,
 *   takes the number as its pitch (0x005fb3a0). VehicleAimRequestNormAngle 0x005fb8c0: the aimer with
 *   0x400 takes `min + (max − min) × n` over the same span as GetNormAngle.
 * - VehicleAimIncrement 0x005fb770 / VehicleAimDecrement 0x005fb7d0: the active mover's pitch plus or minus
 *   the number, 0.1 without one (0x009e3004) — no flag test (0x005fb4b0).
 * - VehicleAimUpStart/UpStop/DownStart/DownStop: PitchUpStart/PitchUpStop/PitchDownStart/PitchDownStop's own
 *   functions (0x005fc8e0, 0x005fc570, 0x005fc920, 0x005fc5c0 under both names).
 * - VehicleAimGetNormPower 0x005f9550: the global power (0x00c24958). VehicleAimSetNormPower 0x005f9f10:
 *   with an aimer, the number, below 0 → 0 and from 1 → 1.
 * - 0x005fb3a0 holds the pitch in the band (CUSTOM_PITCH, else ±π/2 for a unit with a row) and, unless the
 *   mover has FULL_SPEED_PITCHING, sets it and raises VEHICLE_ANGLE_UPDATE (0x005fa910: "%f%f", the pitch
 *   normalised over the mover's span and the pitch, only for a mover with a Vehicle row) when the row has
 *   0x400. Wow.exe also raises it every frame while the mover pitches by keys (0x005fab70 on MovementFlags
 *   0xc0), when the pitch keys stop (0x005fb1a0, 0x005face0) and on a mover change (0x0074c5a0 — raised
 *   by FrameXmlVehicle.ts); here the poll raises it whenever the mover's pitch has moved since the last poll.
 *
 * Only the active mover's pitch can be set (the movement code owns it, game/VehicleAim.ts): a request that
 * names another unit (an aimer that is not the mover) or a mover that is not a vehicle whose pitch counts
 * changes nothing. Without the vehicle tables every name answers as before this slice (nothing).
 * VehicleCameraZoomIn/Out (0x006018a0/0x006018b0 → CameraZoomIn/Out 0x006017e0/0x00601840) are not here:
 * the stock CameraZoomIn/Out are not implemented by this client either.
 */

export interface FrameXmlVehicleAimWorld {
  readonly state: {
    readonly selfGuid?: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  };
  readonly controlledGuid?: bigint | undefined;
}

export interface FrameXmlVehicleAimContext {
  readonly world: () => FrameXmlVehicleAimWorld | undefined;
  /** The vehicle tables (browser/VehicleClient.ts `vehicleCatalog`); undefined until they land. */
  readonly catalog: () => VehicleCatalog | undefined;
  /** The movement code's pitch (game/VehicleAim.ts); the registered one when absent. */
  readonly input?: () => VehicleAimInput | undefined;
}

interface FrameXmlVehicleAimPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const VEHICLE_ANGLE_UPDATE = "VEHICLE_ANGLE_UPDATE";
/** 0x009f1ff4 / 0x009e8d88 and 0x009e8cd0 (VehicleUi.ts uses the same three). */
const DEFAULT_PITCH_MIN = -Math.PI / 2;
const DEFAULT_PITCH_MAX = Math.PI / 2;
const PITCH_SPAN_EPSILON = 1e-4;
/** 0x009e3004: VehicleAimIncrement/Decrement's step without an argument. */
export const VEHICLE_AIM_DEFAULT_STEP = 0.1;
/** Vehicle FULLSPEEDPITCHING → MovementFlags2 FULL_SPEED_PITCHING 0x10, which 0x005fb3a0 tests. */
const FULL_SPEED_PITCHING = VEHICLE_FLAGS.FULLSPEEDPITCHING;

const NOTHING: readonly unknown[] = Object.freeze([]);

/** The span a pitch is normalised over (0x005f9e60, 0x005fa910, 0x005fb8c0). */
function pitchSpan(row: VehicleEntry | undefined): readonly [number, number] {
  return row !== undefined && (row.flags & VEHICLE_FLAGS.CUSTOM_PITCH) !== 0
    ? [row.pitchMin, row.pitchMax] : [DEFAULT_PITCH_MIN, DEFAULT_PITCH_MAX];
}

/** `(pitch − min) / (max − min)`, 0 for a span under 1e-4. */
export function normalizedVehiclePitch(row: VehicleEntry | undefined, pitch: number): number {
  const [min, max] = pitchSpan(row);
  const span = max - min;
  return Math.abs(span) <= PITCH_SPAN_EPSILON ? 0 : (pitch - min) / span;
}

/** Lua's `lua_isnumber`/`lua_tonumber`: a number, or a string that reads as one. */
function luaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isNaN(number) ? undefined : number;
  }
  return undefined;
}

export class FrameXmlVehicleAimModel {
  readonly #context: FrameXmlVehicleAimContext;
  #pump: FrameXmlVehicleAimPump | undefined;
  /** The mover and its pitch at the last poll (or the last request): the poll raises on a move. */
  #mover: bigint | undefined;
  #pitch: number | undefined;

  constructor(context: FrameXmlVehicleAimContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlVehicleAimPump): void {
    this.#pump = pump;
    this.#mover = undefined;
    this.#pitch = undefined;
  }

  detach(): void {
    this.#pump = undefined;
    this.#mover = undefined;
    this.#pitch = undefined;
  }

  /** The tables are here: the C API answers from them and the poll raises the event. */
  get active(): boolean {
    return this.#context.catalog() !== undefined;
  }

  #input(): VehicleAimInput | undefined {
    return (this.#context.input ?? vehicleAimInput)();
  }

  #moverGuid(world: FrameXmlVehicleAimWorld): bigint | undefined {
    return world.controlledGuid ?? world.state.selfGuid;
  }

  /** vfunc +0x14c: the movement code's pitch for the active mover, the last packet's for another unit. */
  #pitchOf(world: FrameXmlVehicleAimWorld, guid: bigint): number {
    const input = this.#input();
    if (input !== undefined && guid === this.#moverGuid(world)) return input.moverPitch();
    return frameXmlWorldObjects(world).get(guid)?.pitch ?? 0; // seam-sweep
  }

  /** 0x005f9d20: the vehicle the character drives (seat CAN_CONTROL), else the character; in view. */
  #aimer(world: FrameXmlVehicleAimWorld, catalog: VehicleCatalog): WorldObjectState | undefined {
    const self = world.state.selfGuid;
    if (self === undefined) return undefined;
    const seated = unitVehicleSeat(catalog, frameXmlWorldObjects(world), self); // seam-sweep
    const guid = seated && (seated.seat.flags & VEHICLE_SEAT_FLAGS.CAN_CONTROL) !== 0 ? seated.vehicleGuid : self;
    return frameXmlWorldObjects(world).get(guid); // seam-sweep
  }

  /** The poll: VEHICLE_ANGLE_UPDATE when the mover's pitch moved (a mover change is FrameXmlVehicle.ts's). */
  tick(): void {
    const pump = this.#pump;
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    if (!pump || !world || !catalog) return;
    const mover = this.#moverGuid(world);
    const row = mover === undefined ? undefined : vehicleOf(catalog, frameXmlWorldObjects(world).get(mover)); // seam-sweep
    const pitch = mover === undefined ? undefined : this.#pitchOf(world, mover);
    if (mover !== this.#mover) {
      this.#mover = mover;
      this.#pitch = pitch;
      return;
    }
    if (pitch === this.#pitch) return;
    this.#pitch = pitch;
    if (row !== undefined && pitch !== undefined) pump.fire(VEHICLE_ANGLE_UPDATE, normalizedVehiclePitch(row, pitch), pitch);
  }

  /** VehicleAimGetAngle. */
  angle(): number {
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    const aimer = world && catalog ? this.#aimer(world, catalog) : undefined;
    return world && aimer ? this.#pitchOf(world, aimer.guid) : 0;
  }

  /** VehicleAimGetNormAngle. */
  normAngle(): number {
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    const aimer = world && catalog ? this.#aimer(world, catalog) : undefined;
    if (!world || !catalog || !aimer) return 0;
    return normalizedVehiclePitch(vehicleOf(catalog, aimer), this.#pitchOf(world, aimer.guid));
  }

  /** VehicleAimRequestAngle(angle). */
  requestAngle(value: unknown): void {
    const angle = luaNumber(value);
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    const mover = world ? this.#moverGuid(world) : undefined;
    if (angle === undefined || !world || !catalog || mover === undefined) return;
    const row = vehicleOf(catalog, frameXmlWorldObjects(world).get(mover)); // seam-sweep
    if (row === undefined || (row.flags & VEHICLE_FLAGS.ADJUST_AIM_ANGLE) === 0) return;
    this.#setPitch(world, catalog, mover, angle);
  }

  /** VehicleAimRequestNormAngle(n). */
  requestNormAngle(value: unknown): void {
    const norm = luaNumber(value);
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    const aimer = world && catalog ? this.#aimer(world, catalog) : undefined;
    if (norm === undefined || !world || !catalog || !aimer) return;
    const row = vehicleOf(catalog, aimer);
    if (row === undefined || (row.flags & VEHICLE_FLAGS.ADJUST_AIM_ANGLE) === 0) return;
    const [min, max] = pitchSpan(row);
    this.#setPitch(world, catalog, aimer.guid, min + (max - min) * norm);
  }

  /** VehicleAimIncrement(step) / VehicleAimDecrement(step): `sign` 1 or −1. */
  step(value: unknown, sign: 1 | -1): void {
    const delta = luaNumber(value) ?? VEHICLE_AIM_DEFAULT_STEP;
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    const mover = world ? this.#moverGuid(world) : undefined;
    if (!world || !catalog || mover === undefined || !frameXmlWorldObjects(world).has(mover)) return; // seam-sweep
    this.#setPitch(world, catalog, mover, this.#pitchOf(world, mover) + sign * delta);
  }

  /** VehicleAimUpStart/Stop, DownStart/Stop: the pitch keys. */
  key(direction: "up" | "down", down: boolean): void {
    this.#input()?.pitchKey(direction, down);
  }

  /** VehicleAimGetNormPower. */
  normPower(): number {
    return vehicleAimPower();
  }

  /** VehicleAimSetNormPower(p): only with an aimer. */
  setNormPower(value: unknown): void {
    const power = luaNumber(value);
    const world = this.#context.world();
    const catalog = this.#context.catalog();
    if (power === undefined || !world || !catalog || !this.#aimer(world, catalog)) return;
    setVehicleAimPower(power);
  }

  /** 0x005fb3a0 for `guid`: only the active mover's pitch can be set here; then the event, as Wow.exe raises it. */
  #setPitch(world: FrameXmlVehicleAimWorld, catalog: VehicleCatalog, guid: bigint, pitch: number): void {
    const mover = this.#moverGuid(world);
    const input = this.#input();
    if (guid !== mover || input === undefined || !input.setMoverPitch(pitch)) return;
    const now = input.moverPitch();
    const row = vehicleOf(catalog, frameXmlWorldObjects(world).get(mover)); // seam-sweep
    // FULL_SPEED_PITCHING: no event now; Wow.exe raises it once the pitch is applied (0x005fb510) — the poll
    // here, which sees the pitch move. Otherwise the pitch is taken as seen, with the event when the row has 0x400.
    if (row !== undefined && (row.flags & FULL_SPEED_PITCHING) !== 0) return;
    this.#mover = mover;
    this.#pitch = now;
    if (row === undefined || (row.flags & VEHICLE_FLAGS.ADJUST_AIM_ANGLE) === 0) return;
    this.#pump?.fire(VEHICLE_ANGLE_UPDATE, normalizedVehiclePitch(row, now), now);
  }
}

// ---- the bindings ----------------------------------------------------------------------------------

type AimBinding<Host> = (host: Host, args: readonly unknown[]) => readonly unknown[];

function aimOf(host: unknown): FrameXmlVehicleAimModel | undefined {
  const model = (host as { readonly vehicleAim?: unknown } | undefined)?.vehicleAim;
  return model instanceof FrameXmlVehicleAimModel && model.active ? model : undefined;
}

/** The names this file answers (12; VehicleCameraZoomIn/Out are not among them). */
export const FRAMEXML_VEHICLE_AIM_NAMES: readonly string[] = Object.freeze([
  "VehicleAimGetAngle", "VehicleAimGetNormAngle", "VehicleAimRequestAngle", "VehicleAimRequestNormAngle",
  "VehicleAimIncrement", "VehicleAimDecrement", "VehicleAimUpStart", "VehicleAimUpStop", "VehicleAimDownStart",
  "VehicleAimDownStop", "VehicleAimGetNormPower", "VehicleAimSetNormPower",
]);

/**
 * The seam's binding table with the aim answers in front. A seam without the model, or without the vehicle
 * tables, answers as before (whatever the table had for the name, else nothing).
 */
export function frameXmlWithVehicleAim<Host>(
  bindings: Readonly<Record<string, AimBinding<Host>>>,
): Record<string, AimBinding<Host>> {
  const answer = (name: string, call: (model: FrameXmlVehicleAimModel, args: readonly unknown[]) => readonly unknown[]):
    AimBinding<Host> => (host, args) => {
    const model = aimOf(host);
    return model ? call(model, args) : bindings[name]?.(host, args) ?? NOTHING;
  };
  const act = (call: (model: FrameXmlVehicleAimModel, args: readonly unknown[]) => void) =>
    (model: FrameXmlVehicleAimModel, args: readonly unknown[]): readonly unknown[] => {
      call(model, args);
      return NOTHING;
    };
  const wrapped: Record<string, AimBinding<Host>> = {
    VehicleAimGetAngle: answer("VehicleAimGetAngle", (model) => [model.angle()]),
    VehicleAimGetNormAngle: answer("VehicleAimGetNormAngle", (model) => [model.normAngle()]),
    VehicleAimRequestAngle: answer("VehicleAimRequestAngle", act((model, args) => model.requestAngle(args[0]))),
    VehicleAimRequestNormAngle: answer("VehicleAimRequestNormAngle", act((model, args) => model.requestNormAngle(args[0]))),
    VehicleAimIncrement: answer("VehicleAimIncrement", act((model, args) => model.step(args[0], 1))),
    VehicleAimDecrement: answer("VehicleAimDecrement", act((model, args) => model.step(args[0], -1))),
    VehicleAimUpStart: answer("VehicleAimUpStart", act((model) => model.key("up", true))),
    VehicleAimUpStop: answer("VehicleAimUpStop", act((model) => model.key("up", false))),
    VehicleAimDownStart: answer("VehicleAimDownStart", act((model) => model.key("down", true))),
    VehicleAimDownStop: answer("VehicleAimDownStop", act((model) => model.key("down", false))),
    VehicleAimGetNormPower: answer("VehicleAimGetNormPower", (model) => [model.normPower()]),
    VehicleAimSetNormPower: answer("VehicleAimSetNormPower", act((model, args) => model.setNormPower(args[0]))),
  };
  return { ...bindings, ...wrapped };
}
