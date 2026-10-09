// Acknowledging the movement changes the server pushes.
//
// None of this existed, and its absence is the difference between a session that survives a
// portal and one that does not. Player::TeleportTo sends the new position and then waits: until
// the client acknowledges, HandleMovementOpcodes discards every movement packet the player sends
// (MovementHandler.cpp:285). So a hearthstone, a dungeon portal, a spirit-healer revive or the
// dungeon-finder button left the character frozen until relog.
//
// Speed is the same shape. Unit::SetSpeedRate pushes a PlayerMovementPendingChange and only
// applies the new rate in the ack handler, so a mount, a sprint or a hamstring did nothing at
// all — and the pending queue grew for the whole session.
//
// Layouts were read out of the core this project already generates its opcode table from, not
// guessed: MovementHandler.cpp for the client side and MovementPacketSender.cpp for the server's.

import { OPCODES } from "../generated/opcodes.js";
import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { MOVEMENT_FLAGS, readMovementInfo, writeMovementInfoBody, type MovementInfo } from "./MovementProtocol.js";

/** The nine rates the server can force, and the opcode pair that carries each. */
export const FORCED_SPEEDS = [
  { server: OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, ack: OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK, name: "run", extraByte: true },
  { server: OPCODES.SMSG_FORCE_RUN_BACK_SPEED_CHANGE, ack: OPCODES.CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK, name: "runBack", extraByte: false },
  { server: OPCODES.SMSG_FORCE_SWIM_SPEED_CHANGE, ack: OPCODES.CMSG_FORCE_SWIM_SPEED_CHANGE_ACK, name: "swim", extraByte: false },
  { server: OPCODES.SMSG_FORCE_SWIM_BACK_SPEED_CHANGE, ack: OPCODES.CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK, name: "swimBack", extraByte: false },
  { server: OPCODES.SMSG_FORCE_WALK_SPEED_CHANGE, ack: OPCODES.CMSG_FORCE_WALK_SPEED_CHANGE_ACK, name: "walk", extraByte: false },
  { server: OPCODES.SMSG_FORCE_TURN_RATE_CHANGE, ack: OPCODES.CMSG_FORCE_TURN_RATE_CHANGE_ACK, name: "turnRate", extraByte: false },
  { server: OPCODES.SMSG_FORCE_FLIGHT_SPEED_CHANGE, ack: OPCODES.CMSG_FORCE_FLIGHT_SPEED_CHANGE_ACK, name: "flight", extraByte: false },
  { server: OPCODES.SMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE, ack: OPCODES.CMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE_ACK, name: "flightBack", extraByte: false },
  { server: OPCODES.SMSG_FORCE_PITCH_RATE_CHANGE, ack: OPCODES.CMSG_FORCE_PITCH_RATE_CHANGE_ACK, name: "pitchRate", extraByte: false },
] as const;

export type ForcedSpeedName = (typeof FORCED_SPEEDS)[number]["name"];

const FORCED_SPEED_BY_OPCODE: ReadonlyMap<number, (typeof FORCED_SPEEDS)[number]> =
  new Map(FORCED_SPEEDS.map((entry) => [entry.server as number, entry]));

/**
 * Movement states the server toggles and expects an ack for.
 *
 * The server's half is one shape for all of them: packed guid and a counter, the collision height
 * alone adding its float (Player.cpp:27202-27278, Unit.cpp:8732-8735, :12247-12278). The ack's tail
 * is not. After the packed guid, the counter and the mover's MovementInfo the core reads
 * - nothing more for root, unroot and the gravity pair (MovementHandler.cpp:712-775, :823-863);
 * - the height again, as a float, for the collision height (:865-887);
 * - one more word for water walk, feather fall, hover and can-fly, set or unset alike (:666-710,
 *   :733-754, :777-798). The server sent no such word, so it is not an echo but the client's own:
 *   `apply`, 1 for the flag going on and 0 for it going off. This core skips it
 *   (`read_skip<uint32>`), yet an ack without it is four bytes short and never parses — on
 *   2026-09-28 Levitate's three acks each died in the handler with a ByteBufferException, and a
 *   can-fly ack the same way.
 *
 * `flag` is the MovementFlags bit the four families switch, which their ack echoes already changed.
 */
export const MOVEMENT_TOGGLES = [
  { server: OPCODES.SMSG_FORCE_MOVE_ROOT, ack: OPCODES.CMSG_FORCE_MOVE_ROOT_ACK, name: "root" },
  { server: OPCODES.SMSG_FORCE_MOVE_UNROOT, ack: OPCODES.CMSG_FORCE_MOVE_UNROOT_ACK, name: "unroot" },
  { server: OPCODES.SMSG_MOVE_WATER_WALK, ack: OPCODES.CMSG_MOVE_WATER_WALK_ACK, name: "waterWalk",
    flag: MOVEMENT_FLAGS.waterWalking, apply: 1 },
  { server: OPCODES.SMSG_MOVE_LAND_WALK, ack: OPCODES.CMSG_MOVE_WATER_WALK_ACK, name: "landWalk",
    flag: MOVEMENT_FLAGS.waterWalking, apply: 0 },
  { server: OPCODES.SMSG_MOVE_FEATHER_FALL, ack: OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, name: "featherFall",
    flag: MOVEMENT_FLAGS.fallingSlow, apply: 1 },
  { server: OPCODES.SMSG_MOVE_NORMAL_FALL, ack: OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, name: "normalFall",
    flag: MOVEMENT_FLAGS.fallingSlow, apply: 0 },
  { server: OPCODES.SMSG_MOVE_SET_HOVER, ack: OPCODES.CMSG_MOVE_HOVER_ACK, name: "hover",
    flag: MOVEMENT_FLAGS.hover, apply: 1 },
  { server: OPCODES.SMSG_MOVE_UNSET_HOVER, ack: OPCODES.CMSG_MOVE_HOVER_ACK, name: "unsetHover",
    flag: MOVEMENT_FLAGS.hover, apply: 0 },
  { server: OPCODES.SMSG_MOVE_SET_CAN_FLY, ack: OPCODES.CMSG_MOVE_SET_CAN_FLY_ACK, name: "canFly",
    flag: MOVEMENT_FLAGS.canFly, apply: 1 },
  { server: OPCODES.SMSG_MOVE_UNSET_CAN_FLY, ack: OPCODES.CMSG_MOVE_SET_CAN_FLY_ACK, name: "cannotFly",
    flag: MOVEMENT_FLAGS.canFly, apply: 0 },
  { server: OPCODES.SMSG_MOVE_GRAVITY_DISABLE, ack: OPCODES.CMSG_MOVE_GRAVITY_DISABLE_ACK, name: "gravityOff" },
  { server: OPCODES.SMSG_MOVE_GRAVITY_ENABLE, ack: OPCODES.CMSG_MOVE_GRAVITY_ENABLE_ACK, name: "gravityOn" },
  { server: OPCODES.SMSG_MOVE_SET_COLLISION_HGT, ack: OPCODES.CMSG_MOVE_SET_COLLISION_HGT_ACK, name: "collisionHeight", trailing: "f32" },
] as const;

const TOGGLE_BY_OPCODE: ReadonlyMap<number, (typeof MOVEMENT_TOGGLES)[number]> =
  new Map(MOVEMENT_TOGGLES.map((entry) => [entry.server as number, entry]));
/** The ack's tail is decided by the toggle's name, so the `SMSG_MULTIPLE_MOVES` blocks get it too. */
const TOGGLE_BY_NAME: ReadonlyMap<string, (typeof MOVEMENT_TOGGLES)[number]> =
  new Map(MOVEMENT_TOGGLES.map((entry) => [entry.name, entry]));

export interface ForcedSpeed {
  guid: bigint;
  counter: number;
  speed: number;
  name: ForcedSpeedName;
}

export interface MovementToggle {
  guid: bigint;
  counter: number;
  name: string;
  /** The height a collision-height change carries; no other toggle sends a value. */
  value: number | undefined;
  ackOpcode: number;
}

export interface NewWorld {
  mapId: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
}

export function isForcedSpeed(opcode: number): boolean {
  return FORCED_SPEED_BY_OPCODE.has(opcode);
}

export function isMovementToggle(opcode: number): boolean {
  return TOGGLE_BY_OPCODE.has(opcode);
}

/** The toggle an opcode names, for the blocks batched inside `SMSG_MULTIPLE_MOVES`. */
export function movementToggleFor(opcode: number): { name: string; ackOpcode: number } | undefined {
  const entry = TOGGLE_BY_OPCODE.get(opcode);
  return entry && { name: entry.name, ackOpcode: entry.ack };
}

/** `packedGuid, u32 counter, [u8 for run only], f32 speed` — MovementPacketSender.cpp:71-77. */
export function parseForcedSpeed(opcode: number, payload: Uint8Array): ForcedSpeed {
  const entry = FORCED_SPEED_BY_OPCODE.get(opcode);
  if (!entry) throw new Error(`Opcode 0x${opcode.toString(16)} is not a forced speed change`);
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const counter = reader.u32();
  // The run change carries one byte the client is expected to ignore, added in 2.1.0.
  if (entry.extraByte) reader.u8();
  const speed = reader.f32();
  return { guid, counter, speed, name: entry.name };
}

/** `packedGuid, u32 counter, MovementInfo, f32 speed` — HandleForceSpeedChangeAck. */
export function buildForcedSpeedAck(speed: ForcedSpeed, movement: MovementInfo): Uint8Array {
  const writer = new PacketWriter().packedGuid(speed.guid).u32(speed.counter);
  writeMovementInfoBody(writer, movement);
  return writer.f32(speed.speed).toUint8Array();
}

export function ackOpcodeForSpeed(name: ForcedSpeedName): number {
  const entry = FORCED_SPEEDS.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown speed ${name}`);
  return entry.ack;
}

/** `packedGuid, u32 counter`, and the collision height's float: all the server sends. */
export function parseMovementToggle(opcode: number, payload: Uint8Array): MovementToggle {
  const entry = TOGGLE_BY_OPCODE.get(opcode);
  if (!entry) throw new Error(`Opcode 0x${opcode.toString(16)} is not a movement toggle`);
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  // Root sends a timestamp rather than a counter, but it occupies the same word and the server
  // only checks that the ack echoes it.
  const counter = reader.remaining >= 4 ? reader.u32() : 0;
  const value = "trailing" in entry && reader.remaining >= 4 ? reader.f32() : undefined;
  return { guid, counter, name: entry.name, value, ackOpcode: entry.ack };
}

/**
 * `packedGuid, u32 counter, MovementInfo`, then the tail the core's handler reads: the apply word
 * for the four flag families, the height for the collision height, nothing for the rest.
 *
 * The echoed MovementInfo already has the family's bit set or cleared, so the ack agrees with every
 * movement packet after it (`movementFlags` in Movement.ts folds the same bits in from
 * `movementState`). This core reads that block and discards it (MovementHandler.cpp:680-686).
 */
export function buildMovementToggleAck(toggle: MovementToggle, movement: MovementInfo): Uint8Array {
  const entry = TOGGLE_BY_NAME.get(toggle.name);
  const switched = entry !== undefined && "apply" in entry ? entry : undefined;
  const flags = switched === undefined ? movement.flags
    : (switched.apply ? movement.flags | switched.flag : movement.flags & ~switched.flag) >>> 0;
  const writer = new PacketWriter().packedGuid(toggle.guid).u32(toggle.counter);
  writeMovementInfoBody(writer, { ...movement, flags });
  if (switched !== undefined) writer.u32(switched.apply);
  // `recvData >> newValue` reads the height unconditionally, so it is always written.
  else if (entry !== undefined && "trailing" in entry) writer.f32(toggle.value ?? 0);
  return writer.toUint8Array();
}

/** SMSG_NEW_WORLD: `u32 map, f32 x, f32 y, f32 z, f32 o`. */
export function parseNewWorld(payload: Uint8Array): NewWorld {
  const reader = new PacketReader(payload);
  const mapId = reader.u32();
  const x = reader.f32();
  const y = reader.f32();
  const z = reader.f32();
  const orientation = reader.f32();
  return { mapId, x, y, z, orientation };
}

/** SMSG_TRANSFER_PENDING: destination map; on a transport, entry and source map follow. */
export interface TransferPending {
  mapId: number;
  transportEntry?: number;
  sourceMapId?: number;
}

export function parseTransferPending(payload: Uint8Array): TransferPending {
  const reader = new PacketReader(payload);
  const mapId = reader.u32();
  if (reader.remaining === 0) return { mapId };
  if (reader.remaining !== 8) throw new RangeError("Invalid SMSG_TRANSFER_PENDING transport fields");
  const transportEntry = reader.u32();
  const sourceMapId = reader.u32();
  reader.assertFinished();
  return { mapId, transportEntry, sourceMapId };
}

/**
 * MSG_MOVE_TELEPORT_ACK, server side: `packedGuid, u32 counter, MovementInfo`. The reply is
 * `packedGuid, u32 counter, u32 time` — HandleMoveTeleportAck reads exactly those three.
 */
export function parseTeleportRequest(payload: Uint8Array): { guid: bigint; counter: number; movement: MovementInfo } {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const counter = reader.u32();
  const movement = readMovementInfo(reader);
  return { guid, counter, movement };
}

export function buildTeleportAck(guid: bigint, counter: number, time: number): Uint8Array {
  return new PacketWriter().packedGuid(guid).u32(counter).u32(time).toUint8Array();
}

/** MSG_MOVE_WORLDPORT_ACK carries no body; the core's handler ignores what it is given. */
export function buildWorldportAck(): Uint8Array {
  return new Uint8Array(0);
}

/**
 * `CMSG_MOVE_SPLINE_DONE`: packed mover, its MovementInfo at arrival, then the spline id.
 * TaxiHandler.cpp reads this at each flight segment's end; without it a cross-map taxi cannot
 * switch maps and the last segment cannot complete its client/server handshake.
 */
export function buildSplineDone(guid: bigint, movement: MovementInfo, splineId: number): Uint8Array {
  return writeMovementInfoBody(new PacketWriter().packedGuid(guid), movement).u32(splineId).toUint8Array();
}

// Slice P4's additions to the same conversation: a knock back to acknowledge, the batch of state
// changes a character logs in holding, and who is allowed to move what.

export interface KnockBack {
  guid: bigint;
  counter: number;
  /** The horizontal direction, as its cosine and sine. Cosine first, which is not the usual order. */
  directionCos: number;
  directionSin: number;
  /** Yards a second across the ground. */
  speedXY: number;
  /**
   * The vertical speed exactly as the wire carries it: `float(-speedZ)` (Unit.cpp:13237, :13672),
   * so negative is up. It goes into a MovementInfo jump block as it is (that block uses the same
   * sign); the physics wants `-speedZ` (`KnockbackImpulse.knockbackImpulse`).
   */
  speedZ: number;
}

/**
 * `SMSG_MOVE_KNOCK_BACK`: `packedGuid, u32 counter, f32 cos, f32 sin, f32 speedXY, f32 speedZ`.
 *
 * Three traps in six fields. The direction pair is written cosine-first here
 * (`Position.cpp:170-175` streams x then y) and **sine-first** in the `MSG_MOVE_KNOCK_BACK` the
 * server mirrors to everyone else and in the jump block of a MovementInfo — swapping them turns
 * the character ninety degrees. The vertical speed is written as `float(-speedZ)`, already
 * negated. And the counter is a literal zero at both senders, so it says nothing.
 *
 * Until the ack comes back the server has not moved the unit at all: `HandleMoveKnockBackAck`
 * (`MovementHandler.cpp:611`) is what commits the position.
 */
export function parseKnockBack(payload: Uint8Array): KnockBack {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const counter = reader.u32();
  const directionCos = reader.f32();
  const directionSin = reader.f32();
  const speedXY = reader.f32();
  return { guid, counter, directionCos, directionSin, speedXY, speedZ: reader.f32() };
}

/**
 * The mover's state right after a knock back (5.01): falling, from a fall clock of zero, along the
 * jump the server chose. This is what the acknowledgement must say, because `HandleMoveKnockBackAck`
 * stores it as the mover's movement and relays it with its jump block to everyone in range
 * (MovementHandler.cpp:651-663) — an acknowledgement that still says "standing" is a knock back
 * nobody else ever sees. The jump block keeps the wire's sign and the sine-first order of the
 * MovementInfo (`writeMovementInfoBody`); the packet to the victim had cosine first.
 */
export function knockBackMovement(knockBack: KnockBack, movement: MovementInfo): MovementInfo & Required<Pick<MovementInfo, "jump" | "fallTime">> {
  // L16-review: aboard a transport the block is in its frame, as Wow.exe writes it (0x006e9ff0 turns the
  // server's world direction by the transport's inverse matrix before the ACK) and as the heartbeats after
  // it carry it (MovementRide.rideImpulse); the carrier's heading is the world facing less the seat's.
  let cos = knockBack.directionCos;
  let sin = knockBack.directionSin;
  if (movement.transport) {
    const heading = movement.position.orientation - movement.transport.orientation;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    cos = knockBack.directionCos * c + knockBack.directionSin * s;
    sin = knockBack.directionSin * c - knockBack.directionCos * s;
  }
  return {
    ...movement,
    flags: (movement.flags | MOVEMENT_FLAGS.falling) & ~MOVEMENT_FLAGS.swimming,
    fallTime: 0,
    jump: { velocity: knockBack.speedZ, sinAngle: sin, cosAngle: cos, speed: knockBack.speedXY }, // L16-review: `sin`, `cos`
  };
}

/** `CMSG_MOVE_KNOCK_BACK_ACK`: `packedGuid, u32 counter, MovementInfo` — `MovementHandler.cpp:611`. */
export function buildKnockBackAck(knockBack: KnockBack, movement: MovementInfo): Uint8Array {
  const writer = new PacketWriter().packedGuid(knockBack.guid).u32(knockBack.counter);
  writeMovementInfoBody(writer, movement);
  return writer.toUint8Array();
}

/**
 * `SMSG_MULTIPLE_MOVES`: the state a character is already in when it enters the world.
 *
 * `u32 remainingBytes`, then blocks of `u8 size, u16 opcode, packedGuid, u32 counter`. Sent once
 * from `SendInitialPacketsAfterAddToMap` (`Player.cpp:23300`) and only when the character holds
 * at least one of root, feather fall, water walking or hover — so its absence is the normal case.
 *
 * Two ways to mis-read it. The size byte **includes** the two-byte opcode that follows it, so
 * skipping `size` bytes after reading the opcode overruns every block by two; and the leading
 * word is a byte count rather than a block count, so the loop ends at the buffer, not at a
 * number. Each block is a `SMSG_FORCE_*` / `SMSG_MOVE_*` body, and each still wants its own
 * acknowledgement — a character that never sends them is one the server keeps waiting for.
 */
export function parseMultipleMoves(payload: Uint8Array): { opcode: number; guid: bigint; counter: number }[] {
  const reader = new PacketReader(payload);
  reader.u32();
  const moves: { opcode: number; guid: bigint; counter: number }[] = [];
  while (reader.remaining > 3) {
    const size = reader.u8();
    const opcode = reader.u16();
    const guid = reader.packedGuid();
    const counter = reader.u32();
    moves.push({ opcode, guid, counter });
    // The block's own bookkeeping, checked rather than trusted: a size that does not match what
    // was read means this is not the packet it says it is, and reading on would be guessing.
    if (size !== 2 + counterBlockSize(guid) + 4) break;
  }
  return moves;
}

/** How many bytes a packed guid occupies: one mask byte plus its non-zero bytes. */
function counterBlockSize(guid: bigint): number {
  let bytes = 1;
  for (let value = guid; value > 0n; value >>= 8n) {
    if ((value & 0xffn) !== 0n) bytes++;
  }
  return bytes;
}

/**
 * `SMSG_CLIENT_CONTROL_UPDATE`: `packedGuid target, u8 allowed`.
 *
 * Who the client is allowed to move — normally its own character, and a creature or a vehicle
 * while it is possessing one. Answering matters more than it looks: the server drops every
 * movement packet from a client that has not named its mover with `CMSG_SET_ACTIVE_MOVER`
 * (`WorldSession::IsRightUnitBeingMoved`), and sends no error when it does. A client that ignores
 * this packet is one whose character silently stops moving.
 *
 * The reply to `allowed` spells the same guid the other way round — full eight bytes rather than
 * packed (`buildCharacterGuid`); the reply to a refusal does not (`buildNotActiveMover`).
 */
export function parseClientControlUpdate(payload: Uint8Array): { guid: bigint; allowed: boolean } {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  return { guid, allowed: reader.u8() !== 0 };
}

/**
 * `CMSG_MOVE_NOT_ACTIVE_MOVER`: the mover this client lets go of, **packed**.
 *
 * `HandleMoveNotActiveMover` reads `old_mover_guid.ReadAsPacked()` and discards the rest of the
 * packet (`MovementHandler.cpp:582-601`, the MovementInfo tail is "ignored for now"), unlike
 * `HandleSetActiveMoverOpcode`, which reads a whole uint64 (`:558-580`). The eight bytes this used
 * to share with the claim, read as packed, named some other guid. That changed only the log: the
 * server has already let go before this reply arrives — `Player::SetClientControl` →
 * `GameClient::SetMovedUnit(target, false)` → `RemoveAllowedMover` → `SetActivelyMovedUnit(nullptr)`
 * (`Player.cpp:24606`, `GameClient.cpp:37-46`) — so the handler logs "unset active mover FAILED"
 * either way (`:593`), now with the right guid in it. No MovementInfo follows: the core would throw
 * it away.
 */
export function buildNotActiveMover(guid: bigint): Uint8Array {
  return new PacketWriter().packedGuid(guid).toUint8Array();
}

/** `TransferAbortReason`, `Player.h:636-653`, worded for the player. */
const TRANSFER_ABORT_TEXT: Readonly<Record<number, string>> = {
  1: "Переход невозможен",
  2: "Подземелье заполнено",
  3: "Экземпляр не найден",
  4: "Слишком много подземелий",
  6: "В подземелье идёт бой",
  7: "Нужно дополнение",
  8: "Другая сложность",
  9: "Вход закрыт",
  10: "Слишком много подземелий на этом мире",
  11: "Нужна группа",
  15: "Только для своего мира",
  16: "Эта карта недоступна",
};

export interface TransferAborted {
  mapId: number;
  reason: number;
  /** The expansion, the difficulty or a message index — only three reasons carry one. */
  argument: number | undefined;
  text: string;
}

/**
 * `SMSG_TRANSFER_ABORTED`: `u32 map, u8 reason`, and one more byte for reasons 7, 8 and 9.
 *
 * The extra byte is conditional at the sender (`Player.cpp:23388-23395`), so reading a fixed six
 * bytes throws on every other refusal. Nothing is acknowledged and no teleport is left pending:
 * the player simply stays where they are, which is why saying so is the whole of the handling.
 */
export function parseTransferAborted(payload: Uint8Array): TransferAborted {
  const reader = new PacketReader(payload);
  const mapId = reader.u32();
  const reason = reader.u8();
  const argument = reader.remaining > 0 ? reader.u8() : undefined;
  return { mapId, reason, argument, text: TRANSFER_ABORT_TEXT[reason] ?? `переход отклонён (${reason})` };
}
