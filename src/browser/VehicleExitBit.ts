// 11.02 (11.11): which seat Flags bit a leaving passenger goes by, as Wow.exe 3.3.5a 12340 picks it. Ghidra, read-only:
// .runtime/re-2026-10-03/l1102h/r4.c (0x0074bb60), .runtime/re-2026-11-11/transport/t1.c (0x0074be10), t1.lst and t4.lst
// (the call sites pass the passenger's own unit, `[passenger + 0xc]`). Pure.
//
// The bit is one or the other, never either, by the passenger unit's movement flags2 (unit+0x7d0) bit 0x40
// (MOVEMENTFLAG2_UNK7, UnitDefines.h:332):
// - the passenger's arc out (0x00749aa0) and its ExitAnimStart/Loop (0x00747b20): 0x8 with the bit, else 0x8000;
// - the vehicle's own VehicleExitAnim (0x0074be10, the leaving branch): 0x40000 with the bit, else 0x80000.
// This client keeps no flags2 per unit, and TrinityCore never sets 0x40 — the byte a monster move carries for it is
// always 0 (MovementPacketBuilder.cpp:48, 90) — so the callers' default 0 is the realm's value.

/** The passenger's movement flags2 bit that switches both choices. */
export const EXIT_FLAGS2_BIT = 0x40;

/** Seat Flags bit for the passenger's way out (arc and pose), 0x0074bb60. */
export function seatExitBit(flags2 = 0): number {
  return (flags2 & EXIT_FLAGS2_BIT) !== 0 ? 0x0000_0008 : 0x0000_8000;
}

/** Seat Flags bit for the vehicle's VehicleExitAnim, 0x0074be10. */
export function seatVehicleExitBit(flags2 = 0): number {
  return (flags2 & EXIT_FLAGS2_BIT) !== 0 ? 0x0004_0000 : 0x0008_0000;
}
