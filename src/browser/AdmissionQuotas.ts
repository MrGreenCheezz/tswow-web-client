/**
 * 15.11 (7.05, far8): the admission quotas on the faithful lighting levels.
 *
 * Wow.exe counts nothing: a doodad is kept by its size class's distance and the frustum (0x00791cb0, 0x0078fb60 bands),
 * a map object while its box meets the far-clip box (0x007b6110), with an occlusion test on top (0x0078fc40) — no
 * quota anywhere (far7). Measured on lookdev stills at lighting level 3 (`.runtime/lane-2026-11-15/far8-report.md`):
 * the far tier's 48 never filled (1 in Stormwind, 13 in Dalaran and Netherstorm), while the scenery quota (1,024) was
 * full in Dalaran, cutting doodads inside their class distance, and the interior quota (360) was full in Stormwind once
 * the rooms seen from the street reach as far as the original's (7.03). So on these levels the quotas are lifted: what
 * the distance rules and the frustum admit is drawn. The enhanced levels keep their quotas.
 */
export const FAITHFUL_ADMISSION_QUOTA = 1 << 20;

/** The quota a tier admits with: `budget` on the enhanced levels, {@link FAITHFUL_ADMISSION_QUOTA} on the faithful ones. */
export function admissionQuota(budget: number, faithful: boolean): number {
  return faithful ? Math.max(budget, FAITHFUL_ADMISSION_QUOTA) : budget;
}
