import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import type { WorldPosition } from "./WorldState.js";

/**
 * `MovementFlags`, from the core's `UnitDefines.h`. The whole enum rather than the six the client
 * used to be able to express: which of these are set is the entire difference between a character
 * that is walking, one that is falling and one that is swimming, and the server reads every one of
 * them straight out of the word below.
 */
export const MOVEMENT_FLAGS = {
  forward: 0x00000001,
  backward: 0x00000002,
  strafeLeft: 0x00000004,
  strafeRight: 0x00000008,
  turnLeft: 0x00000010,
  turnRight: 0x00000020,
  pitchUp: 0x00000040,
  pitchDown: 0x00000080,
  /** Walk mode is nothing but this bit; `MSG_MOVE_SET_WALK_MODE` only says which way it changed. */
  walking: 0x00000100,
  onTransport: 0x00000200,
  /** `MOVEMENTFLAG_DISABLE_GRAVITY`, the former "levitating". */
  disableGravity: 0x00000400,
  /** Must never be set together with anything in `moving`: the server treats that as a lie. */
  root: 0x00000800,
  falling: 0x00001000,
  fallingFar: 0x00002000,
  swimming: 0x00200000,
  ascending: 0x00400000,
  descending: 0x00800000,
  /** Allowed to fly, which the server grants; `flying` is the client saying it is doing so. */
  canFly: 0x01000000,
  flying: 0x02000000,
  splineElevation: 0x04000000,
  splineEnabled: 0x08000000,
  waterWalking: 0x10000000,
  fallingSlow: 0x20000000,
  hover: 0x40000000,
} as const;

/** `MOVEMENTFLAG_MASK_MOVING`: what the server counts as going somewhere, e.g. to stand a sitter up. */
export const MOVEMENT_MASK_MOVING = MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.backward
  | MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.strafeRight | MOVEMENT_FLAGS.falling
  | MOVEMENT_FLAGS.fallingFar | MOVEMENT_FLAGS.ascending | MOVEMENT_FLAGS.descending
  | MOVEMENT_FLAGS.splineElevation;

const ON_TRANSPORT = MOVEMENT_FLAGS.onTransport;
const FALLING = MOVEMENT_FLAGS.falling;
const SWIMMING = MOVEMENT_FLAGS.swimming;
const FLYING = MOVEMENT_FLAGS.flying;
const SPLINE_ELEVATION = MOVEMENT_FLAGS.splineElevation;
const ALWAYS_PITCH = 0x0020;
const INTERPOLATED_MOVEMENT = 0x0400;

export interface MovementInfo {
  flags: number;
  flags2: number;
  time: number;
  position: WorldPosition;
  /** Pitch, when swimming, flying, or explicitly allowed to pitch. */
  pitch?: number;
  /** Milliseconds since the fall began; the server uses it for fall damage. */
  fallTime?: number;
  /** The jump the fall started from: sine, cosine, horizontal speed and vertical velocity. */
  jump?: { velocity: number; sinAngle: number; cosAngle: number; speed: number };
  splineElevation?: number;
  transport?: {
    guid: bigint;
    x: number;
    y: number;
    z: number;
    orientation: number;
    time: number;
    seat: number;
    interpolatedTime?: number;
  };
}

export interface MovementPacket extends MovementInfo {
  guid: bigint;
}

export function buildMovementPacket(guid: bigint, flags: number, position: WorldPosition, time: number,
  extra: Omit<MovementInfo, "flags" | "flags2" | "time" | "position"> = {}): Uint8Array {
  return writeMovementInfo(new PacketWriter(), guid, { flags, flags2: 0, time, position, ...extra }).toUint8Array();
}

export function parseMovementPacket(payload: Uint8Array): MovementPacket {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const movement = readMovementInfo(reader);
  reader.assertFinished();
  return { guid, ...movement };
}

export function readMovementInfo(reader: PacketReader): MovementInfo {
  const flags = reader.u32();
  const flags2 = reader.u16();
  const time = reader.u32();
  const position = { x: reader.f32(), y: reader.f32(), z: reader.f32(), orientation: reader.f32() };
  const info: MovementInfo = { flags, flags2, time, position };

  // Everything below used to be read and thrown away, which was fine while the client only ever
  // received movement. An acknowledgement has to echo the mover's state back, so it has to be
  // kept — and a client that cannot write these fields can never set their flags either, which
  // is why jumping, falling and swimming were unreachable.
  if (flags & ON_TRANSPORT) {
    const guid = reader.packedGuid();
    const transport = {
      guid,
      x: reader.f32(),
      y: reader.f32(),
      z: reader.f32(),
      orientation: reader.f32(),
      time: reader.u32(),
      seat: reader.u8(),
    } as NonNullable<MovementInfo["transport"]>;
    if (flags2 & INTERPOLATED_MOVEMENT) transport.interpolatedTime = reader.u32();
    info.transport = transport;
  }
  if ((flags & (SWIMMING | FLYING)) !== 0 || (flags2 & ALWAYS_PITCH) !== 0) info.pitch = reader.f32();
  info.fallTime = reader.u32();
  if (flags & FALLING) {
    info.jump = { velocity: reader.f32(), sinAngle: reader.f32(), cosAngle: reader.f32(), speed: reader.f32() };
  }
  if (flags & SPLINE_ELEVATION) info.splineElevation = reader.f32();

  return info;
}

/**
 * The mirror of `readMovementInfo`. WorldSession::ReadMovementInfo expects exactly these fields
 * in exactly this order, and a byte out of place desynchronises the rest of the packet.
 */
export function writeMovementInfo(writer: PacketWriter, guid: bigint, info: MovementInfo): PacketWriter {
  writer.packedGuid(guid);
  return writeMovementInfoBody(writer, info);
}

/**
 * The MovementInfo alone, with no guid in front.
 *
 * WorldSession::ReadMovementInfo starts at the flags — the guid is always read separately by the
 * handler — so an acknowledgement that writes it twice desynchronises everything after it.
 */
export function writeMovementInfoBody(writer: PacketWriter, info: MovementInfo): PacketWriter {
  writer.u32(info.flags);
  writer.u16(info.flags2);
  writer.u32(info.time);
  writer.f32(info.position.x);
  writer.f32(info.position.y);
  writer.f32(info.position.z);
  writer.f32(info.position.orientation);

  if (info.flags & ON_TRANSPORT) {
    const transport = info.transport ?? { guid: 0n, x: 0, y: 0, z: 0, orientation: 0, time: 0, seat: 0 };
    writer.packedGuid(transport.guid);
    writer.f32(transport.x).f32(transport.y).f32(transport.z).f32(transport.orientation);
    writer.u32(transport.time);
    writer.u8(transport.seat);
    if (info.flags2 & INTERPOLATED_MOVEMENT) writer.u32(transport.interpolatedTime ?? 0);
  }
  if ((info.flags & (SWIMMING | FLYING)) !== 0 || (info.flags2 & ALWAYS_PITCH) !== 0) writer.f32(info.pitch ?? 0);
  writer.u32(info.fallTime ?? 0);
  if (info.flags & FALLING) {
    const jump = info.jump ?? { velocity: 0, sinAngle: 0, cosAngle: 0, speed: 0 };
    writer.f32(jump.velocity).f32(jump.sinAngle).f32(jump.cosAngle).f32(jump.speed);
  }
  if (info.flags & SPLINE_ELEVATION) writer.f32(info.splineElevation ?? 0);
  return writer;
}
