/**
 * 05.10-A7a-F1: render switches for behaviours whose fidelity is decided by frames, not by code.
 *
 * Each one is a reading of the original client that the census confirmed is worth doing but that
 * only a frame of the original (lookdev, stage 14.25) can accept: until then the default is the
 * frame this client already drew. They are read when a material is built (`m2AlphaDepthWrite`) or
 * per particle (`particleTwinkle`), so a lookdev run sets them before the scene loads — either with
 * `setRenderSwitches` or, from a harness that cannot reach the module, by defining
 * `globalThis.webclientRenderSwitches = { … }` before the page's scripts run.
 *
 * * `m2AlphaDepthWrite` (6.16д) — whether an M2 batch in blend mode 2 (`BLEND_ALPHA`) keeps writing
 *   depth. On (today): only the material flags turn the write off. Off: the wowee reading, no depth
 *   write for alpha-blended batches. The census found 11,932 such batches in 6,431 models and not
 *   one carrying the no-depth-write flag 0x20, so the file never settles it per batch.
 * * `particleTwinkle` (6.15) — the per-frame size flicker and draw gate of `twinkleScale`/
 *   `twinklePercent` (`ParticleTwinkle.ts`). Off (today): every particle at ramp size.
 * * `m2Lights` (6.17, 05.10-A7a-F2) — whether a model that declares `M2Light` records is lit by them
 *   (`LocalLighting.ts`) instead of the file-name heuristic. Off (today): the heuristic for every
 *   model. The census values argue for frames first: the Elwynn guard tower's four torches end their
 *   attenuation at 1.89 yards and the undead campfire at 0.97, where the heuristic pools reach 7–8 —
 *   read as yards they light the fixture itself, not the ground around it.
 * * `wmoRoomFogOnScene` (7.12, 05.10-A7b-2) — while the camera stands in a WMO room with MFOG, its
 *   fog is the frame's fog for everything (doodads, units, particles, water, the street through the
 *   doorway), the client's one-fog-per-frame. Off by default like the others, keeping today's frame
 *   (only the room's interior runs take it); a paired frame of the original (14.25, a tavern door)
 *   decides whether it is turned on.
 * * `terrainSpecular` (7.16 Г, 05.10-A7b-7Г) — the ground's specular glint from the `_s.blp` masks
 *   (`TerrainSplat.ts`), on the classic path only. Off by default: the masks and the client's
 *   per-vertex form are settled, and the exponent `c[27].w` = 20 (05.10 review 7.16 Б/Г: 0x00A3FFF0),
 *   but its colour (`c[27].rgb`, the scene light's specular colour) is not read from Wow.exe —
 *   the program uses the sun's diffuse colour until a frame of the original (14.25)
 *   or a Ghidra reading says otherwise. Read when a tile's splat loads (masks are fetched only then).
 */
export interface RenderSwitches {
  m2AlphaDepthWrite: boolean;
  particleTwinkle: boolean;
  m2Lights: boolean; // 05.10-A7a-F2
  wmoRoomFogOnScene: boolean; // 05.10-A7b-2
  terrainSpecular: boolean; // 05.10-A7b-7Г
}

const DEFAULTS: Readonly<RenderSwitches> = Object.freeze({
  m2AlphaDepthWrite: true, particleTwinkle: false, m2Lights: false, // 05.10-A7a-F2: m2Lights
  // 05.10 (orchestrator): off until the 14.25 tavern-door frame — on, it reverses the 04.09 fix that
  // kept Goldshire's peach 83-yard MFOG off the street seen through the door.
  wmoRoomFogOnScene: false, // 05.10-A7b-2 (7.12)
  terrainSpecular: false, // 05.10-A7b-7Г (7.16 Г): c[27] unsettled
});

function initial(): RenderSwitches {
  const switches: RenderSwitches = { ...DEFAULTS };
  const preset = (globalThis as { webclientRenderSwitches?: unknown }).webclientRenderSwitches;
  if (preset && typeof preset === "object") applyPatch(switches, preset as Partial<RenderSwitches>);
  return switches;
}

function applyPatch(target: RenderSwitches, patch: Partial<RenderSwitches>): void {
  for (const key of Object.keys(DEFAULTS) as Array<keyof RenderSwitches>) {
    const value = patch[key];
    if (typeof value === "boolean") target[key] = value;
  }
}

/** The live switches. Read directly on hot paths; written only through `setRenderSwitches`. */
export const renderSwitches: Readonly<RenderSwitches> = initial();

/** Changes some switches; unknown keys and non-boolean values are ignored. Returns the result. */
export function setRenderSwitches(patch: Partial<RenderSwitches>): Readonly<RenderSwitches> {
  applyPatch(renderSwitches as RenderSwitches, patch);
  return renderSwitches;
}

/** Back to the defaults — what every test that flips a switch calls when it is done. */
export function resetRenderSwitches(): Readonly<RenderSwitches> {
  applyPatch(renderSwitches as RenderSwitches, DEFAULTS);
  return renderSwitches;
}
