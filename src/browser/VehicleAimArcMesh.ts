import * as THREE from "three";
import type { VehicleAimArcShape } from "./game/VehicleAimArc.js";
import type { HeightSampler } from "./SceneCamera.js";

/**
 * 11.02 (04.11): the aim arc on screen, as Wow.exe 0x006fda20 lays it out. The ribbon is a strip with two vertices at each point
 * of the flight, MsslTrgtArcWidth apart across the facing and level; the texture runs along it, scrolled by MsslTrgtArcSpeed and
 * repeated MsslTrgtArcRepeat times a point; the first pair has alpha 0, the rest go from the strength to the strength times
 * MsslTrgtEndOpacity. Both are drawn additive, without writing depth. The mark is MsslTrgtImpactTexture on a square of
 * ±MsslTrgtImpactTexRadius round the impact, laid here on the ground it covers (Wow.exe projects it on the world's surfaces).
 */

/** How many rows of the ribbon the buffer holds: 0x006fcd60 walks at most 200 steps, and the fire point. */
const ROWS = 202;
/** The mark's squares a side. */
const MARK_CELLS = 10;

/** One row's numbers, pure so that a test reads them without a GPU: the sides at this point, alpha and U. */
export function arcRibbonRow(shape: VehicleAimArcShape, index: number, count: number, scroll: number):
  { x: number; y: number; z: number; sideX: number; sideY: number; alpha: number; u: number } {
  const half = shape.width * 0.5;
  const delta = (shape.opacity * shape.endOpacity - shape.opacity) / Math.max(1, count - 1);
  const alpha = index === 0 ? 0 : Math.min(1, Math.max(0, shape.opacity + delta * index));
  return {
    x: shape.points[index * 3]!, y: shape.points[index * 3 + 1]!, z: shape.points[index * 3 + 2]!,
    sideX: -Math.sin(shape.facing) * half, sideY: Math.cos(shape.facing) * half,
    alpha, u: scroll + shape.arcRepeat * index,
  };
}

/** The texture's scroll at `seconds` after the arc came up: runs from 1 downward, wrapped (0x0088d93a). */
export function arcScroll(seconds: number, arcSpeed: number): number {
  const turned = seconds * arcSpeed;
  return 1 - (turned - Math.floor(turned));
}

function additive(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    toneMapped: false, forceSinglePass: true,
  });
}

/** The ribbon and the mark, built on the first arc and hidden between. */
export class VehicleAimArcMesh {
  readonly #group = new THREE.Group();
  readonly #ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly #mark: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly #load: (path: string) => THREE.Texture;
  #startedAt: number | undefined;

  constructor(parent: THREE.Object3D, load: (path: string) => THREE.Texture) {
    this.#load = load;
    const ribbon = new THREE.BufferGeometry();
    ribbon.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ROWS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    ribbon.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(ROWS * 2 * 2), 2).setUsage(THREE.DynamicDrawUsage));
    ribbon.setAttribute("color", new THREE.BufferAttribute(new Float32Array(ROWS * 2 * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const strip: number[] = [];
    for (let row = 0; row + 1 < ROWS; row++) strip.push(row * 2, row * 2 + 1, row * 2 + 2, row * 2 + 2, row * 2 + 1, row * 2 + 3);
    ribbon.setIndex(strip);
    this.#ribbon = new THREE.Mesh(ribbon, additive());
    this.#ribbon.frustumCulled = false;

    const side = MARK_CELLS + 1;
    const mark = new THREE.BufferGeometry();
    mark.setAttribute("position", new THREE.BufferAttribute(new Float32Array(side * side * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const uv = new Float32Array(side * side * 2);
    const cells: number[] = [];
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        uv[(row * side + column) * 2] = column / MARK_CELLS;
        uv[(row * side + column) * 2 + 1] = row / MARK_CELLS;
        if (row < MARK_CELLS && column < MARK_CELLS) {
          const at = row * side + column;
          cells.push(at, at + 1, at + side, at + side, at + 1, at + side + 1);
        }
      }
    }
    mark.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    mark.setIndex(cells);
    const markMaterial = additive();
    markMaterial.vertexColors = false;
    markMaterial.polygonOffset = true;
    markMaterial.polygonOffsetFactor = -4;
    markMaterial.polygonOffsetUnits = -4;
    this.#mark = new THREE.Mesh(mark, markMaterial);
    this.#mark.frustumCulled = false;

    this.#group.add(this.#ribbon, this.#mark);
    this.#group.visible = false;
    parent.add(this.#group);
  }

  hide(): void {
    this.#group.visible = false;
    this.#startedAt = undefined;
  }

  /** The frame's arc. `now` in ms; `heightAt` the renderer's ground sampler, world coordinates. */
  update(shape: VehicleAimArcShape, now: number, heightAt: HeightSampler | undefined): void {
    this.#group.visible = true;
    this.#startedAt ??= now;
    this.#updateRibbon(shape, arcScroll((now - this.#startedAt) / 1000, shape.arcSpeed));
    this.#updateMark(shape, heightAt);
  }

  #texture(material: THREE.MeshBasicMaterial, path: string, wrap: THREE.Wrapping): boolean {
    if (path === "") return false;
    if (material.userData["path"] !== path) {
      const texture = this.#load(path);
      texture.wrapS = wrap;
      material.map = texture;
      material.userData["path"] = path;
      material.needsUpdate = true;
    }
    return true;
  }

  #updateRibbon(shape: VehicleAimArcShape, scroll: number): void {
    this.#ribbon.visible = this.#texture(this.#ribbon.material, shape.arcTexture, THREE.RepeatWrapping);
    if (!this.#ribbon.visible) return;
    const geometry = this.#ribbon.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const count = Math.min(ROWS, shape.points.length / 3);
    for (let index = 0; index < count; index++) {
      const row = arcRibbonRow(shape, index, count, scroll);
      position.setXYZ(index * 2, row.x + row.sideX, row.z, -(row.y + row.sideY));
      position.setXYZ(index * 2 + 1, row.x - row.sideX, row.z, -(row.y - row.sideY));
      uv.setXY(index * 2, row.u, 0);
      uv.setXY(index * 2 + 1, row.u, 1);
      color.setXYZW(index * 2, 1, 1, 1, row.alpha);
      color.setXYZW(index * 2 + 1, 1, 1, 1, row.alpha);
    }
    position.needsUpdate = true;
    uv.needsUpdate = true;
    color.needsUpdate = true;
    geometry.setDrawRange(0, Math.max(0, count - 1) * 6);
  }

  #updateMark(shape: VehicleAimArcShape, heightAt: HeightSampler | undefined): void {
    const radius = shape.impactRadius;
    this.#mark.visible = radius > 0 && this.#texture(this.#mark.material, shape.impactTexture, THREE.ClampToEdgeWrapping);
    if (!this.#mark.visible) return;
    this.#mark.material.opacity = shape.opacity;
    const last = shape.points.length - 3;
    const cx = shape.points[last]!;
    const cy = shape.points[last + 1]!;
    const cz = shape.points[last + 2]!;
    const position = this.#mark.geometry.getAttribute("position") as THREE.BufferAttribute;
    const side = MARK_CELLS + 1;
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        const x = cx - radius + (2 * radius * column) / MARK_CELLS;
        const y = cy - radius + (2 * radius * row) / MARK_CELLS;
        position.setXYZ(row * side + column, x, heightAt?.(x, y) ?? cz, -y);
      }
    }
    position.needsUpdate = true;
  }

  dispose(): void {
    this.#group.parent?.remove(this.#group);
    this.#ribbon.geometry.dispose();
    this.#ribbon.material.dispose();
    this.#mark.geometry.dispose();
    this.#mark.material.dispose();
  }
}
