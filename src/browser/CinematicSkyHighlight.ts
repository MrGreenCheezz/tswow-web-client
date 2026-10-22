/**
 * 22.10 (7.30): the cinematic chain's sky highlights, trimmed. Owner, 22.10: the sky is better, but
 * the clouds are still slightly too bright. With the clouds held still (Stormwind, owner settings),
 * the enhanced cloud cores were 0.94-1.17 of the faithful profile's mean luma, while the hottest of
 * them glared: noon core p98 220 (faithful 226) on a sky the chain had lifted from 95 to 112.
 *
 * Sky texels whose display-space luma is above `SKY_HIGHLIGHT_KNEE` rise at `SKY_HIGHLIGHT_SLOPE`
 * instead of one; the colour scales with its luma, so a cream cloud stays cream. Luma, not the
 * brightest channel, and a high knee: a clear sky's blue channel is near 0.7 before the chain, and
 * a knee at 0.5 on it (or at 0.6 on luma) darkened the blue sky with the clouds (105 -> 72). Now
 * the noon core p98 is 198, its mean 194 -> 186, the sky around it unchanged; dimmer cores and
 * dusk clouds sit under the knee. Only the cinematic composite runs it, so the faithful profile
 * (no post chain) keeps the client's frame byte for byte.
 */

/** Display-space luma above which the sky's highlights are compressed. */
export const SKY_HIGHLIGHT_KNEE = 0.72;
/** How fast the sky's luma rises past the knee (1: not at all compressed). */
export const SKY_HIGHLIGHT_SLOPE = 0.4;

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** CPU twin of `SKY_HIGHLIGHT_GLSL` for one display-space sky colour. */
export function skyHighlight(colour: readonly [number, number, number]): [number, number, number] {
  const y = luma(colour[0], colour[1], colour[2]);
  if (!(y > SKY_HIGHLIGHT_KNEE)) return [colour[0], colour[1], colour[2]];
  const scale = (SKY_HIGHLIGHT_KNEE + (y - SKY_HIGHLIGHT_KNEE) * SKY_HIGHLIGHT_SLOPE) / y;
  return [colour[0] * scale, colour[1] * scale, colour[2] * scale];
}

/** GLSL statement for the composite: `display` is the clamped display-space sky colour. */
export const SKY_HIGHLIGHT_GLSL = /* glsl */ `
    float skyLuma = dot(display, vec3(0.2126, 0.7152, 0.0722));
    if (skyLuma > ${SKY_HIGHLIGHT_KNEE.toFixed(3)}) {
      display *= (${SKY_HIGHLIGHT_KNEE.toFixed(3)} + (skyLuma - ${SKY_HIGHLIGHT_KNEE.toFixed(3)}) * ${SKY_HIGHLIGHT_SLOPE.toFixed(3)}) / skyLuma;
    }`;
