/**
 * 24.10 (7.50): what light the last frame drew, for the bench's light trace (`bench/lookdev.mjs
 * --light-trace`). Owner, 24.10: lamps visibly switch on while the world streams in. The trace
 * records, frame by frame, where every light is and how strong it was drawn, so the distance at
 * which each one first appears can be measured before and after a change. Diagnostics only: never
 * called on a played frame.
 */
import type * as THREE from "three";
import type { LocalLightSelection } from "./LocalLighting.js";
import type { LightPools } from "./LightPools.js";

/** One frame's lights in world coordinates (x north, y west, z up), four floats each. */
export interface LightCensusFrame {
  /** Selected pools: x, y, z, written strength. */
  readonly near: number[];
  /** Halos and far glows drawn: x, y, z, the brightest channel of the quad's colour. */
  readonly glows: number[];
  /** 24.10 (7.50): screen-space pools drawn (`LightPools.ts`): x, y, z, the brightest channel of the light's colour · weight. */
  readonly pools: number[];
}

function pushScene(out: number[], x: number, y: number, z: number, value: number): void {
  // Scene (x, z, -y) back to the world's (x, y, z).
  out.push(x, -z, y, value);
}

function pushInstances(out: number[], mesh: THREE.InstancedMesh): void {
  const centres = mesh.geometry.getAttribute("haloCentre")?.array as ArrayLike<number> | undefined;
  const colours = mesh.geometry.getAttribute("haloColour")?.array as ArrayLike<number> | undefined;
  if (!centres || !colours) return;
  for (let index = 0; index < mesh.count; index++) {
    const strength = Math.max(colours[index * 3]!, colours[index * 3 + 1]!, colours[index * 3 + 2]!);
    pushScene(out, centres[index * 4]!, centres[index * 4 + 1]!, centres[index * 4 + 2]!, strength);
  }
}

/** The pools the selection wrote, every halo or far glow quad of the frame, and the screen-space pools. */
export function lightCensus(selection: LocalLightSelection, halos: readonly THREE.InstancedMesh[],
  screen?: LightPools): LightCensusFrame {
  const near: number[] = [];
  selection.forEachWritten((position, strength) => pushScene(near, position.x, position.y, position.z, strength));
  const glows: number[] = [];
  for (const mesh of halos) pushInstances(glows, mesh);
  const pools: number[] = [];
  for (let index = 0; screen && index < screen.count; index++) {
    const at = index * 4;
    pushScene(pools, screen.scene[at]!, screen.scene[at + 1]!, screen.scene[at + 2]!, screen.scene[at + 3]!);
  }
  return { near, glows, pools };
}
