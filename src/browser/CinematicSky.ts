/**
 * 22.10 (7.30): the sky and its clouds leave the cinematic chain as the faithful frame has them.
 * Owner, 22.10: the clouds still have a strange colour — make them look normal, as on the faithful
 * profile, with the sky and the clouds past the grade and the glow. The partial fixes before this
 * (a per-channel clamp, a fifth of the grade, a highlight knee on cloud cores) each left some of
 * the chain on the sky, and some of its colour with it.
 *
 * So a sky texel (no geometry in the resolved depth) is written exactly as the classic composite
 * writes every texel: the captured scene plus the zone's glow (and the classic rays, zero under the
 * chain), clamped per channel as the client's eight-bit frame is. No occlusion, haze, shafts,
 * volume beams, bloom, grade, vignette or dither touch it. The sun disc and its glare are the
 * client's own quads in the sky scene (`SkyCelestials`), so they are already in the capture.
 *
 * Which texels are sky needs the depth, so the grade leaf asks for it too (`cinematicNeedsDepth`):
 * without depth the sky used to take the full grade. Under water there is no depth (and no sky).
 */

/** CPU twin of `CINEMATIC_SKY_GLSL`: one display-space sky texel out of the composite. */
export function cinematicSkyTexel(
  scene: readonly [number, number, number],
  glow: readonly [number, number, number],
  glowStrength: number,
  rays: readonly [number, number, number] = [0, 0, 0],
  rayStrength = 0,
): [number, number, number] {
  const channel = (index: 0 | 1 | 2): number =>
    Math.min(1, Math.max(0, scene[index] + glow[index] * glowStrength + rays[index] * rayStrength));
  return [channel(0), channel(1), channel(2)];
}

/**
 * GLSL statement for the composite, right after `display` (scene + glow + rays) and `sky` are known:
 * a sky texel is finished here, the classic composite's bytes.
 */
export const CINEMATIC_SKY_GLSL = /* glsl */ `
  if (sky) {
    gl_FragColor = vec4(clamp(display, vec3(0.0), vec3(1.0)), 1.0);
    return;
  }`;
