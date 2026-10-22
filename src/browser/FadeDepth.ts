/**
 * 22.10 (7.42): whether a faded unit's private material copies write depth.
 *
 * `fadeMaterial` (ModelBuild.ts) leaves `depthWrite` as authored so a translucent body's far side
 * does not blend through its near side. The enhanced cinematic chain reads the scene's depth,
 * though: `CinematicSky.ts` treats depth-1 texels as sky, and the grade, haze, scattering and beams
 * all key on depth. A body faded nearly to nothing (the camera's subject at orbit ≈ 0.4, Wow.exe
 * 0x00606f90 → `CameraClip.ts`) still wrote depth over the sky, so the chain graded those texels as
 * ground and drew the body's silhouette as large faceted shapes. With the chain active a faded
 * copy writes no depth, which leaves its texels to whatever lies behind it — the sky stays sky.
 *
 * The faithful profile has no chain and keeps the authored state exactly; full opacity gives the
 * shared materials back, so an opaque unit always writes depth.
 */
export function fadedDepthWrite(authored: boolean, cinematicActive: boolean): boolean {
  return authored && !cinematicActive;
}
