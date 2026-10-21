/**
 * 22.10 ARC-2 S2b: the ground under a ring, sampled where `WorldRenderer3D.updateSelectionRing` samples it —
 * so the ground reticle can reach the renderer as numbers instead of a sampler closing over the terrain and the
 * main thread's collision world (game/GroundTargetPreview.ts).
 *
 * The sample points are the ring's own vertices: three concentric bands of `segments + 1` points, the centre
 * first. The order and the skip rule (no centre height, no other sample) are the renderer's, so the heights
 * carry exactly the answers it would have asked for in the same frame.
 */

/**
 * How many segments a selection ring is drawn with.
 *
 * Forty-eight is where a ring of one to two yards stops looking like a polygon at the distance a
 * player actually stands from its target. The cost is ninety-six vertices rewritten per frame per
 * ring, of which there are at most two.
 */
export const SELECTION_RING_SEGMENTS = 48;

/** The three bands of a ring, as fractions of its radius: soft inner edge, opaque middle, soft outer edge. */
export const SELECTION_RING_BANDS: readonly number[] = [0.82, 0.93, 1];

/** The ground reticle's point marker radius (WorldRenderer3D `#updateGroundTargetRings`). */
export const GROUND_TARGET_POINT_RING = 0.75;

export type RingGround = (x: number, y: number) => number | undefined;

/** One ring's ground: the height at its centre and at each vertex, band by band; `around` is empty without a centre. */
export interface SelectionRingHeights {
  readonly middle: number | undefined;
  readonly around: readonly (number | undefined)[];
}

/** The reticle's two rings: the point marker always, the area ring when the spell names an area of a yard or more. */
export interface GroundTargetRingHeights {
  readonly point: SelectionRingHeights;
  readonly radius: SelectionRingHeights | undefined;
}

/** The area ring's radius, or none: drawn only when the spell's own `EffectRadius` reaches a yard. */
export function groundTargetAreaRing(radius: number): number | undefined {
  return radius >= 1 ? radius : undefined;
}

/** Samples `ground` at a ring's centre and vertices, in the order the renderer lays them. */
export function sampleSelectionRingHeights(
  centre: { readonly x: number; readonly y: number },
  radius: number,
  ground: RingGround | undefined,
  segments = SELECTION_RING_SEGMENTS,
): SelectionRingHeights {
  const middle = ground?.(centre.x, centre.y);
  const around: (number | undefined)[] = [];
  if (middle !== undefined && ground) {
    for (const band of SELECTION_RING_BANDS) {
      const reach = radius * band;
      for (let step = 0; step <= segments; step++) {
        const angle = (step / segments) * Math.PI * 2;
        around.push(ground(centre.x + Math.cos(angle) * reach, centre.y + Math.sin(angle) * reach));
      }
    }
  }
  return { middle, around };
}

/** Both reticle rings' ground, for the preview pushed to the renderer. */
export function sampleGroundTargetRings(
  centre: { readonly x: number; readonly y: number },
  radius: number,
  ground: RingGround | undefined,
): GroundTargetRingHeights {
  const area = groundTargetAreaRing(radius);
  return {
    point: sampleSelectionRingHeights(centre, GROUND_TARGET_POINT_RING, ground),
    radius: area === undefined ? undefined : sampleSelectionRingHeights(centre, area, ground),
  };
}
