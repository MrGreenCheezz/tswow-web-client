/**
 * 22.10 (7.30): thin volume beams fade out. Owner, 22.10, at Orgrimmar's gate: one long, thin,
 * bright line crossed the whole frame — the lit sheet of air behind a narrow gap (between two of
 * the gate's tusks), seen side-on. The beam terms weigh a ray by its contrast with the shade around
 * it and saturate early, so a sheet one or two half-resolution texels wide came out as bright as a
 * canopy beam ten times its width.
 *
 * A beam's width is read from a ring of taps `VOLUME_WIDTH_TEXELS` out: inside a wide beam most of
 * the ring is as lit as the ray itself, across a thin one only the two taps along it are. The share
 * of the ray's contrast the ring keeps (`width`, 0 thin .. 1 wide) scales both beam terms through
 * `VOLUME_WIDTH_FROM`..`VOLUME_WIDTH_FULL`. Where there is hardly any contrast to measure a width
 * against, the terms are left as they were (they are small there anyway). The march is also
 * softened twice (`VOLUME_SOFTEN_PASSES`), so what is left of a narrow beam is wider and softer.
 *
 * Measured with the owner's settings (`.runtime/lane-sun/p2-*`), the beams' contribution (godRays on
 * minus off) and its thin part (minus a 10 px gaussian of itself), p99.5 / max of 255: Elwynn forest
 * side-on 15.5 / 40.4 -> 13.4 / 37.3 with the beam mean 21.7 -> 21.5 (the thin beams left of the
 * broad ones go, the broad ones stay); Goldshire 17.7 / 73.5 -> 16.6 / 57.0; the Durotar tusk-gap
 * beams p99 34.3 -> 29.9.
 */

/**
 * Times the march goes through the soften pass (`VOLUME_SOFTEN_GLSL`, one horizontal and one
 * vertical gaussian each): twice, a sigma of about four half-resolution texels rather than three.
 */
export const VOLUME_SOFTEN_PASSES = 2;
/** Half-resolution texels from the ray to the ring that measures its beam's width. */
export const VOLUME_WIDTH_TEXELS = 10;
/** Ring share of the ray's contrast below which a beam is gone (a thin line). */
export const VOLUME_WIDTH_FROM = 0.3;
/** Ring share of the ray's contrast from which a beam is kept whole (a wide beam). */
export const VOLUME_WIDTH_FULL = 0.65;
/** Contrast (lit share over the shade around) over which the width starts to count. */
export const VOLUME_WIDTH_CONTRAST_FROM = 0.02;
export const VOLUME_WIDTH_CONTRAST_FULL = 0.1;

const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = unit((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * CPU twin of `VOLUME_WIDTH_GLSL`'s `widthKeep`: the share of a beam kept for its width, from the
 * ray's own (narrow) lit share, the ring's mean lit share and the shade around (the wide ring).
 */
export function volumeBeamWidthKeep(narrow: number, ring: number, around: number): number {
  const contrast = unit(narrow) - unit(around);
  const width = unit((unit(ring) - unit(around)) / Math.max(contrast, 1e-3));
  const keep = smoothstep(VOLUME_WIDTH_FROM, VOLUME_WIDTH_FULL, width);
  const confidence = smoothstep(VOLUME_WIDTH_CONTRAST_FROM, VOLUME_WIDTH_CONTRAST_FULL, contrast);
  return 1 - confidence * (1 - keep);
}

/**
 * The composite's width term, after `VOLUME_SIDE_GLSL` (it reads `wideLit` and `wideAround`); it
 * scales `beam` and `sideBeam`. 23.10 (7.49): its ring taps are read against `refAir`, the air
 * `cinematicVolumeLight` reads the march against (CinematicSilhouettes.ts).
 */
export const VOLUME_WIDTH_GLSL = /* glsl */ `
    float ringLit = 0.0;
    for (int i = 0; i < 8; i++) {
      float angle = (float(i) + 0.5) * 0.7853982;
      vec2 ringTap = texture2D(volumeTexture, vUV + vec2(cos(angle), sin(angle)) * vt * ${VOLUME_WIDTH_TEXELS.toFixed(1)}).rg;
      // 23.10 (7.49): a ring tap of another reach (a walker before the beam) counts as the ray itself.
      ringLit += mix(wideLit, ringTap.r, volumeAirWeight(ringTap.g, refAir));
    }
    ringLit *= 0.125;
    float beamContrast = clamp(wideLit, 0.0, 1.0) - clamp(wideAround, 0.0, 1.0);
    float beamWidth = clamp((clamp(ringLit, 0.0, 1.0) - clamp(wideAround, 0.0, 1.0)) / max(beamContrast, 1e-3), 0.0, 1.0);
    float widthKeep = 1.0 - smoothstep(${VOLUME_WIDTH_CONTRAST_FROM.toFixed(3)}, ${VOLUME_WIDTH_CONTRAST_FULL.toFixed(3)}, beamContrast)
      * (1.0 - smoothstep(${VOLUME_WIDTH_FROM.toFixed(3)}, ${VOLUME_WIDTH_FULL.toFixed(3)}, beamWidth));
    beam *= widthKeep;
    sideBeam *= widthKeep;`;
