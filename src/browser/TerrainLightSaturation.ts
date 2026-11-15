/**
 * 15.11 (7.07, terrain7): the ground's light on the faithful levels, as the client's terrain vertex program
 * computes it — `Shaders\Vertex\*\terrain.bls`: `DP3 N·L` → `MAX 0` / `MIN 1` → `MUL c[26]` → `ADD c[25]` →
 * `MIN 1`, i.e. min(1, ambient + diffuse · clamp(N·L, 0, 1)) per channel on the Light.dbc pair as authored.
 *
 * The world light hands every material the pair scaled by one number so its brightest channel sums to one
 * (`applyLightHeadroom`, wowee's answer). The client does not scale: the stand recorded c25 = (0.447, 0.361,
 * 0.447) and c26 = (0.486, 0.549, 0.635) on a Storm Peaks terrain draw (`F:\WowOracle\runs\fog6-n-stormpeaks.tsv`,
 * draw 619) — a pair whose blue sums to 1.082, set as it is. So sunlit ground keeps the red and green the
 * scaled pair took off it, and only the channel past one stops there (a hue shift the client has too).
 * Only `wowAuthoredLight` changes, which only the faithful levels draw with (the enhanced grade mixes from
 * its own base); `wowHighSunKey.y` is the factor the scale divided by (1 indoors and when nothing clipped).
 */

/** The world light's terrain sun term; other terrain hooks find their place by it, so it stays as it is. */
export const TERRAIN_SUN_TERM = "vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );";

/** The line that follows it on the ground: the authored pair rebuilt and saturated per channel. */
export const TERRAIN_CHANNEL_SATURATION = "wowAuthoredLight = min( max( ( wowAmbient + wowDiffuse * ( wowNL * wowShadow ) ) * wowHighSunKey.y, vec3( 0.0 ) ), vec3( 1.0 ) ); // 15.11 (7.07): terrain.bls, MIN 1 per channel";

/** Appends the saturation after the terrain sun term; a program without the term (or with two) is left alone. */
export function injectTerrainChannelSaturation(fragmentShader: string): string {
  if (!fragmentShader.includes("#define WOW_LIGHT_TERRAIN")) return fragmentShader;
  if (fragmentShader.split(TERRAIN_SUN_TERM).length !== 2) return fragmentShader;
  return fragmentShader.replace(TERRAIN_SUN_TERM, `${TERRAIN_SUN_TERM}\n${TERRAIN_CHANNEL_SATURATION}`);
}

/** CPU twin: the faithful ground light for the scaled pair the uniforms hold and the scale's inverse `peak`. */
export function terrainClassicLight(
  ambient: { r: number; g: number; b: number }, diffuse: { r: number; g: number; b: number },
  nl: number, shadow: number, peak: number,
): { r: number; g: number; b: number } {
  const direct = Math.max(0, nl) * shadow;
  const channel = (a: number, d: number) => Math.min(1, Math.max(0, (a + d * direct) * peak));
  return { r: channel(ambient.r, diffuse.r), g: channel(ambient.g, diffuse.g), b: channel(ambient.b, diffuse.b) };
}
