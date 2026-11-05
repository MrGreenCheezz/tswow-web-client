/**
 * 05.11 (6.44): how a unit's model leans with the ground, as Wow.exe does it.
 *
 * The M2 header's flags say whether a model leans at all (`flags & 3`): 0 stands upright whatever the ground does (every
 * character, 1,104 of the client's creature models), 1 pitches along its facing (wolf, horse, boar, raptor: 224), 3 also
 * rolls across it (kodo, spider, crab, basilisk: 104). A ridden unit asks its mount, and the rider goes with it.
 *
 * `CM2Model::SetWorldTransform` (0x0082DD80) builds the model's axes from the facing `f` and the ground normal `n`:
 *
 *   flags 1:  left = normalize(-f.y, f.x, 0)    forward = normalize(left × n)    up = forward × left
 *   flags 3:  left = normalize(n × f)           forward = left × n               up = n
 *
 * Neither moves the facing: the first keeps `left` level, the second keeps `left` square to `f`. So both are exactly
 * Ry(facing) · Rx(roll) · Rz(pitch) on the scene's axes, which is why a unit's `rotation.y` still reads as its facing.
 *
 * The normal is not the ground's at once: 0x007193F0 and 0x007197D0 step a kept normal towards it every frame, and a
 * surface steeper than about 69° is not taken up at all. Measured on the stand (`F:\WowOracle\tools\npc-tilt*.mjs`) on a
 * slope of 18°: a horse 18.1° facing uphill, 0.7° across, −18.1° downhill; a kodo 18.1° of roll across; a human 0. Jumped
 * to the flat, frames of 38 ms fell 3.9°, 3.4°, 3.1°: the kept normal's law with its time in seconds.
 */

/** `M2Header.flags` bits a model leans by. */
export const UNIT_TILT_PITCH = 1;
export const UNIT_TILT_ROLL = 3;

/** A ground normal in world axes, pointing up. */
export type GroundNormal = readonly [x: number, y: number, z: number];

/** What is left of the distance to the ground's normal after one second (Wow.exe's own constant). */
export const UNIT_TILT_LEFT_AFTER_A_SECOND = 0.0018;
/** The least vertical part of a normal the kept one follows: 0xA34BB8, the surface of about 69°. */
export const UNIT_TILT_MIN_UP = 0.3572124;

export interface UnitTiltAngles {
  /** About the scene's z, nose up when positive: `rotation.z` under the order YXZ. */
  pitch: number;
  /** About the scene's x: `rotation.x` under the order YXZ. */
  roll: number;
}

/** The model's lean on the ground normal `(nx, ny, nz)`, written into `out`. Any other `bits` than 1 and 3 stand upright. */
export function unitTiltAngles(
  bits: number, facing: number, nx: number, ny: number, nz: number, out: UnitTiltAngles,
): UnitTiltAngles {
  out.pitch = 0;
  out.roll = 0;
  if (bits !== UNIT_TILT_PITCH && bits !== UNIT_TILT_ROLL) return out;
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  const along = nx * cos + ny * sin;
  if (bits === UNIT_TILT_PITCH) {
    out.pitch = Math.atan2(-along, nz);
    return out;
  }
  const across = ny * cos - nx * sin;
  const length = Math.hypot(along, across, nz) || 1;
  out.pitch = Math.asin(Math.max(-1, Math.min(1, -along / length)));
  out.roll = Math.atan2(-across, nz);
  return out;
}

/** The normal a unit is drawn by: straight up until the ground says otherwise, then following it by Wow.exe's law. */
export class ShownGroundNormal {
  x = 0;
  y = 0;
  z = 1;

  /** One frame of `seconds`. No ground known, or a surface too steep: the kept normal stays as it is. */
  step(ground: GroundNormal | undefined, seconds: number): void {
    if (ground === undefined || !(ground[2] >= UNIT_TILT_MIN_UP)) return;
    const left = seconds > 0 ? UNIT_TILT_LEFT_AFTER_A_SECOND ** seconds : 1;
    this.x = ground[0] + (this.x - ground[0]) * left;
    this.y = ground[1] + (this.y - ground[1]) * left;
    this.z = ground[2] + (this.z - ground[2]) * left;
  }
}
