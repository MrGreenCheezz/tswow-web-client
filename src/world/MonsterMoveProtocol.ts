import { PacketReader } from "../protocol/PacketReader.js";

const MOVE_STOP = 1;
const MOVE_FACING_SPOT = 2;
const MOVE_FACING_TARGET = 3;
const MOVE_FACING_ANGLE = 4;
const FLAG_PARABOLIC = 0x00000800;
const FLAG_FLYING = 0x00002000;
const FLAG_CATMULL_ROM = 0x00040000;
const FLAG_CYCLIC = 0x00080000;
const FLAG_ANIMATION = 0x00200000;
const MAX_SPLINE_POINTS = 4096;

export interface SplinePoint {
  x: number;
  y: number;
  z: number;
}

export interface MonsterMove {
  guid: bigint;
  transportGuid: bigint | undefined;
  /** Signed seat index in SMSG_MONSTER_MOVE_TRANSPORT, alongside the transport GUID. */
  transportSeat: number | undefined;
  /** The server's spline id, echoed by CMSG_MOVE_SPLINE_DONE on arrival. */
  splineId: number;
  points: SplinePoint[];
  duration: number;
  cyclic: boolean;
  /** A server-side flight spline has no movement flags word of its own. */
  flying?: boolean;
  finalOrientation: number | undefined;
}

export function parseMonsterMove(payload: Uint8Array, transported = false): MonsterMove {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  let transportGuid: bigint | undefined;
  let transportSeat: number | undefined;
  if (transported) {
    transportGuid = reader.packedGuid();
    transportSeat = reader.i8();
  }
  reader.u8();
  const start = point(reader);
  const splineId = reader.u32();
  const moveType = reader.u8();
  let finalOrientation: number | undefined;
  if (moveType === MOVE_FACING_TARGET) reader.u64();
  else if (moveType === MOVE_FACING_ANGLE) finalOrientation = reader.f32();
  else if (moveType === MOVE_FACING_SPOT) point(reader);
  if (moveType === MOVE_STOP) {
    reader.assertFinished();
    return { guid, transportGuid, transportSeat, splineId, points: [start], duration: 0, cyclic: false, finalOrientation };
  }

  const flags = reader.u32();
  if (flags & FLAG_ANIMATION) {
    reader.u8();
    reader.u32();
  }
  const duration = reader.u32();
  if (flags & FLAG_PARABOLIC) {
    reader.f32();
    reader.u32();
  }
  const count = reader.u32();
  if (count > MAX_SPLINE_POINTS) throw new RangeError(`Invalid monster spline point count ${count}`);
  const points = [start];

  if (flags & (FLAG_FLYING | FLAG_CATMULL_ROM)) {
    for (let index = 0; index < count; index++) points.push(point(reader));
  } else if (count > 0) {
    const destination = point(reader);
    if (count > 1) {
      const middle = {
        x: (start.x + destination.x) / 2,
        y: (start.y + destination.y) / 2,
        z: (start.z + destination.z) / 2,
      };
      for (let index = 1; index < count; index++) {
        const offset = unpackXYZ(reader.u32());
        points.push({ x: middle.x - offset.x, y: middle.y - offset.y, z: middle.z - offset.z });
      }
    }
    points.push(destination);
  }
  reader.assertFinished();
  return {
    guid, transportGuid, transportSeat, splineId, points, duration, cyclic: (flags & FLAG_CYCLIC) !== 0,
    ...(flags & FLAG_FLYING ? { flying: true } : {}), finalOrientation,
  };
}

function point(reader: PacketReader): SplinePoint {
  return { x: reader.f32(), y: reader.f32(), z: reader.f32() };
}

function unpackXYZ(packed: number): SplinePoint {
  return {
    x: signed(packed & 0x7ff, 11) * 0.25,
    y: signed((packed >>> 11) & 0x7ff, 11) * 0.25,
    z: signed((packed >>> 22) & 0x3ff, 10) * 0.25,
  };
}

function signed(value: number, bits: number): number {
  const sign = 2 ** (bits - 1);
  return value >= sign ? value - 2 ** bits : value;
}
