/**
 * 22.10 (7.35): the sun direction the cascades are rendered with moves in steps, not every frame.
 *
 * The time of day runs continuously, so the key light turns a little on every frame. Each turn
 * rotates the light plane the cascades are built in (`directionalShadowBasis`): the texel grid then
 * slides across every surface and the depth each texel stores changes, and snapping the centre to
 * whole texels cannot stop that. Lit walls and roofs that sit within a texel's depth of their own
 * stored depth (grazing faces, the PCF footprint at an edge) showed the grid as stripes and moiré
 * that crawled on their own, cyclically, while nothing in the scene moved.
 *
 * Holding the shadow direction until the sun has turned by `SHADOW_SUN_STEP_RADIANS` keeps the
 * maps fixed between steps. A step moves a shadow's tip by its length times the step (0.15 degrees:
 * 5 cm on a 20-yard shadow); at the server's ordinary clock a step comes every 36 seconds. A jump
 * larger than a step (a new time from the server, a teleport to another sky) is taken at once.
 * The lighting itself (N.L, the grade) keeps the exact sun; only the shadow maps step.
 */

/** How far the sun turns before the cascades take its new direction. */
export const SHADOW_SUN_STEP_RADIANS = (0.15 * Math.PI) / 180;
const STEP_COS = Math.cos(SHADOW_SUN_STEP_RADIANS);

export interface ShadowSunVector {
  x: number;
  y: number;
  z: number;
}

/** Holds a unit direction until the input leaves a cone of `SHADOW_SUN_STEP_RADIANS` around it. */
export class SteppedShadowSun {
  readonly #held: ShadowSunVector = { x: 0, y: 1, z: 0 };
  #valid = false;

  /**
   * The direction to render the shadows with for this unit-length `sun`; written into `out`.
   * Returns whether it changed since the last call.
   */
  step(sun: Readonly<ShadowSunVector>, out: ShadowSunVector): boolean {
    const held = this.#held;
    const dot = held.x * sun.x + held.y * sun.y + held.z * sun.z;
    const changed = !this.#valid || !(dot >= STEP_COS);
    if (changed) {
      held.x = sun.x;
      held.y = sun.y;
      held.z = sun.z;
      this.#valid = true;
    }
    out.x = held.x;
    out.y = held.y;
    out.z = held.z;
    return changed;
  }
}
