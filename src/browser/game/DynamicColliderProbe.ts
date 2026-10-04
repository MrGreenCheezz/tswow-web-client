import type { CollisionWorld } from "./Collision.js";
import type { LiquidAnswer, TerrainProbe } from "./Physics.js";
import { STEP_HEIGHT } from "./Physics.js";
import type { CarrierPose } from "./TransportCollision.js";

/**
 * 11.01 slice B: the world as the physics asks it, plus the game objects the core keeps in its
 * dynamic tree near the character — a closed door, a lift's floor — each held in its own frame
 * (`TransportCollision`, slice A2: mesh `scale · v`, placed `pos + Rz(o) · local`, the core's
 * `GameObjectModel` frame, GameObjectModel.cpp:124-137, 174-175).
 *
 * Every question goes to the static world first and then to each collider in turn, with the point
 * turned into the collider's frame and the answer turned back: the highest floor, the lowest
 * ceiling, the wall push applied in sequence. Terrain, liquid, holes and readiness are the world's
 * alone — a door has no water and does not hold a tile back. One instance, re-pointed each frame;
 * the colliders live in an array the owner fills in place, so a query allocates nothing of its own
 * (`CollisionWorld.pushOut` itself returns a fresh pair, as it does for the static world).
 */

/** One game object's collision this frame: its mesh in its own frame and where that frame stands. */
export interface DynamicCollider {
  guid: bigint;
  world: CollisionWorld;
  /** The pose this frame (a lift's moves; a door's is its spawn). */
  readonly pose: CarrierPose;
}

const PUSH = { x: 0, y: 0 };

export class DynamicColliderProbe implements TerrainProbe {
  base: TerrainProbe;
  readonly colliders: DynamicCollider[] = [];
  /** How many of `colliders` count this frame. */
  count = 0;

  constructor(base: TerrainProbe) {
    this.base = base;
  }

  ground(x: number, y: number): number | undefined {
    return this.base.ground(x, y);
  }

  liquid(x: number, y: number, z: number): LiquidAnswer {
    return this.base.liquid(x, y, z);
  }

  hole(x: number, y: number): boolean {
    return this.base.hole(x, y);
  }

  loaded(x: number, y: number): boolean {
    return this.base.loaded?.(x, y) ?? true;
  }

  floor(x: number, y: number, fromZ: number, minZ: number): number | undefined {
    let best = this.base.floor?.(x, y, fromZ, minZ);
    for (let index = 0; index < this.count; index++) {
      const { world, pose } = this.colliders[index]!;
      const cos = Math.cos(pose.orientation);
      const sin = Math.sin(pose.orientation);
      const dx = x - pose.x;
      const dy = y - pose.y;
      const hit = world.floorUnder(dx * cos + dy * sin, dy * cos - dx * sin, fromZ - pose.z, minZ - pose.z);
      if (hit === undefined) continue;
      const z = hit + pose.z;
      if (best === undefined || z > best) best = z;
    }
    return best;
  }

  ceiling(x: number, y: number, fromZ: number, toZ: number): number | undefined {
    let best = this.base.ceiling?.(x, y, fromZ, toZ);
    for (let index = 0; index < this.count; index++) {
      const { world, pose } = this.colliders[index]!;
      const cos = Math.cos(pose.orientation);
      const sin = Math.sin(pose.orientation);
      const dx = x - pose.x;
      const dy = y - pose.y;
      const hit = world.ceilingAbove(dx * cos + dy * sin, dy * cos - dx * sin, fromZ - pose.z, toZ - pose.z);
      if (hit === undefined) continue;
      const z = hit + pose.z;
      if (best === undefined || z < best) best = z;
    }
    return best;
  }

  pushOut(x: number, y: number, z: number, radius: number, bodyHeight: number): { x: number; y: number } {
    let atX = x;
    let atY = y;
    const pushed = this.base.pushOut?.(x, y, z, radius, bodyHeight);
    if (pushed) {
      atX = pushed.x;
      atY = pushed.y;
    }
    for (let index = 0; index < this.count; index++) {
      const { world, pose } = this.colliders[index]!;
      const cos = Math.cos(pose.orientation);
      const sin = Math.sin(pose.orientation);
      const dx = atX - pose.x;
      const dy = atY - pose.y;
      const local = world.pushOut(dx * cos + dy * sin, dy * cos - dx * sin, z - pose.z, radius, bodyHeight, STEP_HEIGHT);
      atX = pose.x + local.x * cos - local.y * sin;
      atY = pose.y + local.x * sin + local.y * cos;
    }
    PUSH.x = atX;
    PUSH.y = atY;
    return PUSH;
  }
}
