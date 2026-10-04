/**
 * 11.02-E: the aim of the unit the keys move, between the stock UI's VehicleAim* functions
 * (framexml/FrameXmlVehicleAim.ts), the missile solver (game/MissileShot.ts) and the movement code that
 * owns the pitch (input/Movement.ts registers itself here, so neither of the first two imports it).
 *
 * Wow.exe 3.3.5a 12340 (Ghidra, read-only; .runtime/re-2026-10-03/l1102e and l1102gf3): the aim angle
 * is the active mover's pitch — VehicleAimGetAngle 0x005f9e10 reads it (vfunc +0x14c), VehicleAimRequest*
 * 0x005fb820/0x005fb8c0 and VehicleAimIncrement/Decrement 0x005fb770/0x005fb7d0 set it through 0x005fb3a0
 * (the band, VEHICLE_ANGLE_UPDATE, the trajectory's dirty flag 0x006fbf80), and VehicleAimUpStart/Stop,
 * DownStart/Stop are the registration of PitchUpStart/Stop, PitchDownStart/Stop themselves (0x005fc8e0,
 * 0x005fc570, 0x005fc920, 0x005fc5c0). The aim power is one global float (0x00c24958, .bss so 0 until set):
 * VehicleAimSetNormPower 0x005f9f10 writes it, VehicleAimGetNormPower 0x005f9550 and the solver 0x005f96e0
 * read it.
 */
export interface VehicleAimInput {
  /** The active mover's pitch as the movement code holds it (radians, up positive). */
  moverPitch(): number;
  /** 0x005fb3a0 for the active mover: the pitch inside its band; false when the mover is not a vehicle whose pitch counts. */
  setMoverPitch(pitch: number): boolean;
  /** The pitch keys (PitchUp/DownStart/Stop), as the bindings press them. */
  pitchKey(direction: "up" | "down", down: boolean): void;
}

let input: VehicleAimInput | undefined;

/** Input/Movement.ts registers itself; tests register a stand-in. */
export function registerVehicleAimInput(next: VehicleAimInput | undefined): void {
  input = next;
}

export function vehicleAimInput(): VehicleAimInput | undefined {
  return input;
}

/** 0x00c24958: the aim power, 0 until VehicleAimSetNormPower; never reset (a client-wide global). */
let power = 0;

export function vehicleAimPower(): number {
  return power;
}

/** VehicleAimSetNormPower's store (0x005f9f10): below 0 is 0, 1 and above is 1. */
export function setVehicleAimPower(next: number): void {
  power = next < 0 ? 0 : next >= 1 ? 1 : next;
}
