import type { Quat } from "../../world/GameObjectRotation.js";
import { rotateByQuat } from "../../world/TransportTilt.js";
import { CollisionMesh, CollisionWorld } from "./Collision.js";

/**
 * 11.01 (15.11): the collision of a lift car turned beyond its heading by its TransportRotation.dbc keys (194301 and 194303
 * in the dataset; browser/TransportRotation.ts). Wow.exe's game object entity carries the object's whole matrix — the
 * rotation the model is drawn with (0x0070c700), which the path writes every frame (0x0070dc10) — so its floor tilts with
 * it. The colliders here keep a yaw-only frame (DynamicColliderProbe.ts: vertical rays, a level cylinder), so the tilt
 * goes into the mesh instead: the car's own mesh (`scale · v`, TransportCollision.ts) turned by the part of the rotation
 * beyond its heading, `tilt = conj(Rz(heading)) ⊗ rotation`, and stood in the frame of that heading. Rebuilt when the
 * tilt has moved on by more than {@link TILT_REBUILD_RADIANS}, or the car's own meshes changed.
 */

/** How far the tilt turns before the mesh is turned again: half a degree, 0.09 yd at 10 yd from the axis. */
export const TILT_REBUILD_RADIANS = Math.PI / 360;

/** The tilt of `rotation` beyond the heading `heading` (the rotation is `Rz(heading) ⊗ tilt`), into `out`. */
export function tiltBeyondHeading(rotation: Quat, heading: number, out: Quat): Quat {
  const s = Math.sin(heading / 2);
  const c = Math.cos(heading / 2);
  // conj(yaw) = (0, 0, −s, c); out = conj(yaw) ⊗ rotation.
  const { x, y, z, w } = rotation;
  out.x = c * x + s * y;
  out.y = c * y - s * x;
  out.z = c * z - s * w;
  out.w = c * w + s * z;
  return out;
}

/** The angle between two rotations. */
export function rotationAngle(a: Quat, b: Quat): number {
  const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
  return 2 * Math.acos(dot);
}

interface TiltedRecord {
  base: CollisionWorld;
  baseSize: number;
  readonly tilt: Quat;
  readonly world: CollisionWorld;
}

const POINT = { x: 0, y: 0, z: 0 };

/** The turned copies, one per car near the character. */
export class TiltedCarrierWorlds {
  readonly #records = new Map<bigint, TiltedRecord>();
  /** How many times a mesh set was turned (tests, diagnostics). */
  rebuilds = 0;

  /**
   * `base` (the car's mesh in its own frame) turned by `tilt`, in the frame of the heading. The same world instance per
   * car for as long as it is asked, so whatever keys on it (a collider record's box) sees one world.
   */
  world(guid: bigint, base: CollisionWorld, tilt: Quat): CollisionWorld {
    let record = this.#records.get(guid);
    if (record === undefined) {
      record = { base, baseSize: -1, tilt: { x: 0, y: 0, z: 0, w: 1 }, world: new CollisionWorld() };
      this.#records.set(guid, record);
    }
    if (record.base === base && record.baseSize === base.size && rotationAngle(record.tilt, tilt) <= TILT_REBUILD_RADIANS) {
      return record.world;
    }
    record.base = base;
    record.baseSize = base.size;
    record.tilt.x = tilt.x; record.tilt.y = tilt.y; record.tilt.z = tilt.z; record.tilt.w = tilt.w;
    record.world.clear();
    for (const id of base.ids()) {
      const mesh = base.get(id);
      if (mesh === undefined) continue;
      const source = mesh.triangles;
      const turned = new Float32Array(source.length);
      for (let index = 0; index + 2 < source.length; index += 3) {
        rotateByQuat(tilt, source[index]!, source[index + 1]!, source[index + 2]!, POINT);
        turned[index] = POINT.x;
        turned[index + 1] = POINT.y;
        turned[index + 2] = POINT.z;
      }
      record.world.set(id, new CollisionMesh(turned, mesh.runs), base.instanceOf(id) ?? id);
    }
    this.rebuilds++;
    return record.world;
  }

  /** Keeps only these cars. */
  retain(guids: ReadonlySet<bigint>): void {
    for (const guid of this.#records.keys()) if (!guids.has(guid)) this.#records.delete(guid);
  }

  /** The car is level again (its path holds it on a heading): its copy goes. */
  release(guid: bigint): void {
    this.#records.delete(guid);
  }

  clear(): void {
    this.#records.clear();
  }
}
