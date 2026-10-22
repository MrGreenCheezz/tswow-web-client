/**
 * 22.10 ARC-2 S6b: the world renderer as the client's page uses it (`game.renderer`) — the members the page calls,
 * taken from WorldRenderer3D. Both the in-page renderer and the render worker's proxy (RenderWorkerClient.ts) are
 * one: the proxy forwards the commands and answers the reads from what the worker last reported, which is why a few
 * reads may be undefined here (nothing reported yet) where the in-page renderer always has a value.
 */

import type { ProgramWarmup } from "./ProgramWarmup.js";
import type { ShadowCascadeSnapshot } from "./CascadedShadows.js";
import type { WorldStandInReport } from "./StandIn.js";
import type { WorldRenderer3D, WorldRendererGraphicsReadback } from "./WorldRenderer3D.js";
import type { RenderWorkerClient } from "./RenderWorkerClient.js";

/** The commands: each is a message to a worker renderer, a direct call to the in-page one. */
export type ClientRendererCommand =
  | "setRenderScale" | "setLightingQuality" | "setWmoOcclusion" | "setCharacterAtlasAnisotropy"
  | "setExperimentalShaderProfile" | "setUnderwaterOverlay" | "setFullscreenGlow" | "setGodRays" | "setGodRayStrength"
  | "setCinematicProfile" | "setCinematicStrength" | "setAtmosphereEffects" | "setEnvironmentDetail" | "setGroundCover"
  | "invalidateGroundCover" | "clearPortraits" | "clearTerrain" | "clearWorldResources"
  | "setWeather" | "setIndoors" | "updateLighting" | "setUnderwaterSurface" | "setSelection" | "setGroundTargetPreview"
  | "setGameObjectPreview" | "setDuelRing" | "setUnitAuraAppearance" | "setStateVisuals"
  | "playSpellVisual" | "cancelSpellVisual" | "retimeSpellVisual" | "clearSpellVisuals" | "prewarmSpellModels"
  | "playUnitAction" | "releaseUnitAction" | "setMeleeTargets" | "playUnitReaction" | "playUnitEmote" | "cancelUnitAction"
  | "playMountSpecial" | "playGameObjectAnimation" | "showEnvironmentStandInMarkers" | "setWorldSubmissionCapture"
  | "setShaderProgramCapture" | "resetFrameCadence" | "resetGpuTimingEpoch";

/** The frame's own calls (game/Loop.ts) and the pushed records. */
export type ClientRendererFrame =
  | "observeFrame" | "markFrameNotRendered" | "beginRenderFrame" | "endRenderFrame" | "renderPortraits" | "draw"
  | "setRenderInputs" | "setRenderLookups" | "setPortraitTargets" | "collisionModelWants" | "unitModelWants"
  | "results" | "drawPhaseMs" | "drawSubmitStats" | "drainShaderProgramCapture" | "visitRetainedResources"
  | "poseWorkerStats" | "webGlIdentity" | "benchmarkWebGl";

/** The warm-up counters the page prints (the hitch line, the freeze recording). */
export type ProgramWarmupCounters = Pick<ProgramWarmup, "programs" | "uniformLocations" | "batches" | "failures" | "queued"
  | "depthPrograms" | "retainedPrograms" | "retainedUnitPrograms" | "parallelCompile">;

export interface ClientRenderer extends Pick<WorldRenderer3D, ClientRendererCommand | ClientRendererFrame> {
  readonly telemetry: WorldRenderer3D["telemetry"] | undefined;
  readonly programWarmup: ProgramWarmupCounters | undefined;
  readonly shadowCascadeStats: ShadowCascadeSnapshot | undefined;
  readonly benchmarkGraphicsConfiguration: Readonly<WorldRendererGraphicsReadback> | undefined;
  readonly pixelRatio: number | undefined;
  standInReport(): WorldStandInReport | undefined;
  /** Present on the render worker's proxy only: the page's way to the parts that exist only there. */
  readonly renderWorker?: RenderWorkerClient;
}

/**
 * The in-page renderer behind `renderer`, for the paths that patch or read it directly (the formal benchmark). A
 * worker renderer has no such object on the page; the error names the flag that made it so.
 */
export function inPageRenderer(renderer: ClientRenderer): WorldRenderer3D {
  if (renderer.renderWorker !== undefined) {
    // 22.10 (12.14): the desktop app runs it in a worker by default; the way back to the page is named.
    throw new Error("this path needs the in-page world renderer; the page runs it in a worker"
      + " (open with ?renderworker=0, or set «Где рисуется мир» to 2 and restart)");
  }
  return renderer as WorldRenderer3D;
}
