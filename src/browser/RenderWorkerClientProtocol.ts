/**
 * 22.10 ARC-2 S6b: the client's messages to and from its world renderer in a DedicatedWorker (RenderWorker.worker.ts),
 * over the frame codec of RenderWorkerProtocol.ts. What the client adds to the bench's protocol:
 *
 * * `commands`: every renderer call the page makes outside the frame (game/Loop.ts setters, settings, spell visuals,
 *   emotes, clears…), in call order. They ride the next frame message, or go on their own at the end of the task
 *   that made them; the worker applies every message as it arrives, so the order is the page's.
 * * a frame carries, besides the world, which resource clients the worker draws with (`clients`: the page's own are
 *   another set after every world entry), where to ask the environment (`environmentAt`: the view subject the page
 *   asked `objectsAround` for) and the portrait targets.
 * * results carry the frame's report (the wants the page asks for, the draw phases) and, twice a second, the slower
 *   reads (telemetry, warm-up, shadows, pose worker, graphics readback).
 */

import type { BenchmarkEnvironmentInput } from "./BenchmarkManifest.js";
import type { ShadowCascadeSnapshot } from "./CascadedShadows.js";
import type { ClientRendererCommand, ProgramWarmupCounters } from "./ClientRenderer.js";
import type { PoseEngineStats } from "./PoseEngine.js";
import type { PortraitTargetInputs } from "./PortraitTargetData.js";
import type { RenderWorkerFrame, RenderWorkerResults } from "./RenderWorkerProtocol.js";
import type { ShaderProgramEvent } from "./ShaderProgramTrace.js";
import type { RenderWorkerDrawReadiness, RenderWorkerStatus } from "./RenderWorkerLoading.js"; // 22.10 (12.14)
import type { WorldStandInReport } from "./StandIn.js";
import type { WorldRenderer3D, WorldRendererGraphicsReadback } from "./WorldRenderer3D.js";

/**
 * How a command crosses. `setting`: the last value is what counts — a repeat with the same arguments is not sent
 * (RenderWorkerClient.ts `sameArgs`), and the last one is replayed onto an in-page renderer that takes over.
 * `state`: replayed too, but every call is sent (`setStateVisuals` retries a dropped state model on a repeat).
 * `action`: every call, never replayed.
 */
export type RenderCommandKind = "setting" | "state" | "action";

export const RENDER_WORKER_COMMANDS: Readonly<Record<ClientRendererCommand, RenderCommandKind>> = Object.freeze({
  setRenderScale: "setting", setLightingQuality: "setting", setWmoOcclusion: "setting",
  setCharacterAtlasAnisotropy: "setting", setExperimentalShaderProfile: "setting", setUnderwaterOverlay: "setting",
  setTerrainRelief: "setting", // 22.10 (7.47)
  setWmoRelief: "setting", // 22.10 (7.47 stage 2)
  setLivingSpells: "setting", // 23.10 (6.27)
  setHdEffectTextures: "setting", // 23.10 (7.48)
  setFullscreenGlow: "setting", setGodRays: "setting", setGodRayStrength: "setting", setCinematicProfile: "setting",
  setCinematicStrength: "setting", setAtmosphereEffects: "setting", setEnvironmentDetail: "setting",
  setGroundCover: "setting", setWeather: "setting", setIndoors: "setting", updateLighting: "setting",
  setUnderwaterSurface: "setting", setSelection: "setting", setGroundTargetPreview: "setting",
  setGameObjectPreview: "setting", setDuelRing: "setting", setUnitAuraAppearance: "setting",
  setWorldSubmissionCapture: "setting", setShaderProgramCapture: "setting",
  setStateVisuals: "state",
  invalidateGroundCover: "action", clearPortraits: "action", clearTerrain: "action", clearWorldResources: "action",
  playSpellVisual: "action", cancelSpellVisual: "action", retimeSpellVisual: "action", clearSpellVisuals: "action",
  prewarmSpellModels: "action", playUnitAction: "action", releaseUnitAction: "action", setMeleeTargets: "action",
  playUnitReaction: "action", playUnitEmote: "action", cancelUnitAction: "action", playMountSpecial: "action",
  playGameObjectAnimation: "action", showEnvironmentStandInMarkers: "action", resetFrameCadence: "action",
  resetGpuTimingEpoch: "action",
});

/**
 * The worker-only commands: `#idle` (the page drew no world this frame: stop drawing until the next frame message),
 * `#clearInputs`/`#clearLookups` (`setRenderInputs(undefined)`, `setRenderLookups(undefined)`), `#poseReset`
 * (`poseWorkerStats(true)`), `#standIns` (put the stand-in report into the next slow reports). 22.10 (12.14):
 * `#warmModels` ([path, priority]: a model the page's warm-up asks for, RenderWorkerModelWarmup.ts).
 */
export type RenderWorkerOwnCommand = "#idle" | "#clearInputs" | "#clearLookups" | "#poseReset" | "#standIns" | "#warmModels";

export interface RenderCommand {
  readonly method: ClientRendererCommand | RenderWorkerOwnCommand;
  readonly args: readonly unknown[];
}

/** The worker's resource clients: built from `url` (the gateway URL the page's took), another set when `key` moves. */
export interface RenderWorkerClientsKey {
  readonly key: number;
  readonly url: string;
}

/** What a client frame message carries besides the bench's frame. */
export interface ClientFrameExtra {
  readonly commands: readonly RenderCommand[];
  /** Undefined while the page draws without its clients (none before the first world). */
  readonly clients: RenderWorkerClientsKey | undefined;
  /** The view subject's x and y, where game/Loop.ts asked `objectsAround`; undefined: no environment. */
  readonly environmentAt: readonly [number, number] | undefined;
  readonly portraitTargets: PortraitTargetInputs | undefined;
}

export type ClientRenderFrame = RenderWorkerFrame & ClientFrameExtra;

export interface RenderWorkerCommandsMessage {
  readonly type: "commands";
  readonly commands: readonly RenderCommand[];
}

/** One drawn worker frame, for the page's after-draw work and its diagnostics. */
export interface RenderWorkerFrameReport {
  /** WMO placements whose collision model the draw missed (`collisionModelWants`). */
  readonly collisionWants: readonly string[];
  /** The units the draw admitted and read a model for, in its order (`unitModelWants`). */
  readonly unitWants: readonly bigint[];
  readonly drawPhaseMs: Readonly<Record<string, number>>;
  readonly drawSubmitStats: Readonly<{ programs: number; textures: number; geometries: number }>;
  /** The worker frame's whole CPU span (applying nothing: messages are applied as they arrive). */
  readonly cpuMs: number;
  /** The frame's animation-frame time on the page's clock. */
  readonly at: number;
  /** A draw that threw: its message (the page reports it as the loop reports a failed frame). */
  readonly frameError?: string;
  /** The shader programs a capture attributed this frame, on the page's clock. */
  readonly shaderPrograms?: readonly ShaderProgramEvent[];
  /** 22.10 (12.14): whether the worker's terrain has answered under the page's view subject (the loading curtain). */
  readonly readiness?: RenderWorkerDrawReadiness;
}

/** The slower reads, twice a second. */
export interface RenderWorkerSlowReport {
  readonly telemetry: WorldRenderer3D["telemetry"];
  readonly programWarmup: ProgramWarmupCounters;
  readonly shadowCascadeStats: ShadowCascadeSnapshot | undefined;
  readonly poseWorker: (PoseEngineStats & { readonly workersReady: number; readonly failure?: string }) | undefined;
  readonly graphics: Readonly<WorldRendererGraphicsReadback>;
  readonly pixelRatio: number;
  readonly webgl: BenchmarkEnvironmentInput["webgl"];
  readonly identity: { readonly version?: string; readonly adapter?: string };
  readonly standIns?: WorldStandInReport;
}

export interface ClientRenderResults extends RenderWorkerResults {
  readonly report?: RenderWorkerFrameReport;
  readonly slow?: RenderWorkerSlowReport;
  /** 22.10 (12.14): the worker's resource clients' status messages since the last results (the HUD's lines). */
  readonly statuses?: readonly RenderWorkerStatus[];
}

/** An error the worker caught and goes on after (a rejected fetch, a listener that threw): logged on the page. */
export interface RenderWorkerLog {
  readonly type: "log";
  readonly message: string;
}

/** The client's `init` driver part. */
export interface ClientRenderDriver {
  readonly client: true;
}
