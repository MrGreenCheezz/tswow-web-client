// 05.10-A7b-9 (7.18): a visible box where an environment model will never come.
//
// In ordinary play a placement whose model the client does not ship, or that came back as the
// server's collision hull, is drawn as nothing — a box in the street would be worse than a gap. But
// a gap cannot be pointed at: «the inn has no sign» could be a stand-in, a cull or a missing file.
// While the diagnostics window is open the renderer outlines each such placement instead, coloured
// by reason, over its MODF extents when it has them and as a small cube at its pin otherwise.
//
// The window renews a short lease every time it redraws, so closing it (or the window going away
// any other way) takes the boxes down within a second without a hook on the close path.

import * as THREE from "three";
import type { EnvironmentObject } from "../gateway/VMapProtocol.js";
import type { EnvironmentStandInReason } from "./StandIn.js";

/** The reasons that get a box: a model on its way is not worth flagging. */
export type EnvironmentStandInMarkerReason = Exclude<EnvironmentStandInReason, "pending">;

export const ENVIRONMENT_STAND_IN_MARKER_COLOURS: Readonly<Record<EnvironmentStandInMarkerReason, number>> = {
  hull: 0xff9a1f,
  missing: 0xff2a2a,
  failed: 0xd22aff,
};

/** How long one diagnostics redraw keeps the boxes up; the window redraws every half second. */
export const ENVIRONMENT_STAND_IN_MARKER_LEASE_MS = 1_500;

/** Size of the cube drawn at the pin of a placement with no extents, in yards. */
export const ENVIRONMENT_STAND_IN_MARKER_PIN_SIZE = 2;

/** A scene-space box: centre and edge lengths. */
export interface EnvironmentStandInMarkerBox {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

/**
 * Where the box goes. World `(x, y, z)` is scene `(x, z, -y)`, the same mapping the stand-in
 * canopy and `placeEnvironmentNode` use; `bounds` are world-space MODF extents.
 */
export function environmentStandInMarkerBox(object: EnvironmentObject): EnvironmentStandInMarkerBox {
  const bounds = object.bounds;
  if (bounds) {
    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minZ + bounds.maxZ) / 2,
      z: -(bounds.minY + bounds.maxY) / 2,
      width: Math.max(1, bounds.maxX - bounds.minX),
      height: Math.max(1, bounds.maxZ - bounds.minZ),
      depth: Math.max(1, bounds.maxY - bounds.minY),
    };
  }
  const size = ENVIRONMENT_STAND_IN_MARKER_PIN_SIZE;
  return { x: object.x, y: object.z + size / 2, z: -object.y, width: size, height: size, depth: size };
}

interface Marker {
  readonly line: THREE.LineSegments;
  source: EnvironmentObject;
  reason: EnvironmentStandInMarkerReason;
  seen: number;
}

export class EnvironmentStandInMarkers {
  readonly group = new THREE.Group();
  readonly #markers = new Map<number, Marker>();
  #geometry: THREE.EdgesGeometry | undefined;
  readonly #materials = new Map<EnvironmentStandInMarkerReason, THREE.LineBasicMaterial>();
  #leaseUntil = Number.NEGATIVE_INFINITY;
  #on = false;
  #frame = 0;

  constructor() {
    this.group.name = "environmentStandInMarkers";
  }

  /** Keeps the boxes up until `untilMs` (the `performance.now()` clock). */
  showUntil(untilMs: number): void {
    this.#leaseUntil = untilMs;
  }

  get size(): number {
    return this.#markers.size;
  }

  /** Starts one admission walk; answers whether marks are wanted on it. */
  beginFrame(nowMs: number): boolean {
    this.#on = nowMs < this.#leaseUntil;
    this.#frame++;
    return this.#on;
  }

  mark(object: EnvironmentObject, reason: EnvironmentStandInMarkerReason): void {
    if (!this.#on) return;
    let marker = this.#markers.get(object.id);
    if (marker && marker.source !== object) {
      this.#remove(object.id, marker);
      marker = undefined;
    }
    if (!marker) {
      const line = new THREE.LineSegments(this.#edges(), this.#material(reason));
      const box = environmentStandInMarkerBox(object);
      line.position.set(box.x, box.y, box.z);
      line.scale.set(box.width, box.height, box.depth);
      line.frustumCulled = false;
      line.updateMatrix();
      line.matrixAutoUpdate = false;
      line.updateMatrixWorld(true);
      marker = { line, source: object, reason, seen: this.#frame };
      this.#markers.set(object.id, marker);
      this.group.add(line);
    } else if (marker.reason !== reason) {
      marker.reason = reason;
      marker.line.material = this.#material(reason);
    }
    marker.seen = this.#frame;
  }

  /** Drops the boxes of placements not marked on this walk, or all of them once the lease ran out. */
  endFrame(): void {
    if (this.#markers.size === 0) return;
    for (const [id, marker] of this.#markers) {
      if (!this.#on || marker.seen !== this.#frame) this.#remove(id, marker);
    }
  }

  clear(): void {
    for (const [id, marker] of this.#markers) this.#remove(id, marker);
  }

  dispose(): void {
    this.clear();
    this.#geometry?.dispose();
    this.#geometry = undefined;
    for (const material of this.#materials.values()) material.dispose();
    this.#materials.clear();
  }

  #remove(id: number, marker: Marker): void {
    this.group.remove(marker.line);
    this.#markers.delete(id);
  }

  #edges(): THREE.EdgesGeometry {
    if (!this.#geometry) {
      const box = new THREE.BoxGeometry(1, 1, 1);
      this.#geometry = new THREE.EdgesGeometry(box);
      box.dispose();
    }
    return this.#geometry;
  }

  #material(reason: EnvironmentStandInMarkerReason): THREE.LineBasicMaterial {
    let material = this.#materials.get(reason);
    if (!material) {
      material = new THREE.LineBasicMaterial({ color: ENVIRONMENT_STAND_IN_MARKER_COLOURS[reason], fog: false });
      this.#materials.set(reason, material);
    }
    return material;
  }
}
