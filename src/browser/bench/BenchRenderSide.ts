/**
 * 22.10 ARC-2 S6a: the bench scene's renderer half — the renderer's own clients, the scenario's graphics pushed to
 * the renderer, and the readiness the harness settles on. Shared by the in-page harness (Harness.ts) and the render
 * worker of `--renderbridge worker` (BenchRender.worker.ts), so both build and judge the same renderer.
 */

import type { WorldRenderer3D } from "../WorldRenderer3D.js";
import { TerrainClient, EnvironmentClient } from "../Terrain.js";
import { TerrainSplatClient } from "../TerrainSplat.js";
import { GroundCoverClient } from "../GroundCover.js";
import { LightClient } from "../LightClient.js";
import { LiquidTextureClient } from "../Water.js";
import { HorizonClient } from "../Horizon.js";
import { environmentStandInsWith } from "../StandIn.js"; // 05.10-A7b-9 (7.18)
import { applyRendererGraphicsSettings } from "../RendererGraphicsSettings.js";
import { defaultSettings } from "../ui/SettingsModel.js";
import type { KnownMissingTextureLedger } from "./KnownMissingTextures.js";
import type { BenchConfig, BenchGraphics } from "./BenchScene.js";

export interface BenchClients {
  readonly terrain: TerrainClient;
  readonly environment: EnvironmentClient;
  readonly splat: TerrainSplatClient;
  readonly cover: GroundCoverClient;
  readonly lighting: LightClient;
  readonly liquids: LiquidTextureClient;
  readonly horizon: HorizonClient;
}

export interface BenchReadiness {
  pending: number;
  errors: number;
  details: unknown;
}

export function createBenchClients(baseUrl: string): BenchClients {
  const terrain = new TerrainClient(baseUrl);
  const environment = new EnvironmentClient(baseUrl);
  const splat = new TerrainSplatClient(baseUrl);
  const cover = new GroundCoverClient(baseUrl);
  const lighting = new LightClient(baseUrl);
  const liquids = new LiquidTextureClient(baseUrl);
  const horizon = new HorizonClient(baseUrl);
  return { terrain, environment, splat, cover, lighting, liquids, horizon };
}

/** The scenario's graphics block, then a player's own options over it, then the lookdev weather. */
export function configureBenchRenderer(world: WorldRenderer3D, config: BenchConfig, graphics: BenchGraphics,
  cover: GroundCoverClient): void {
  world.setLightingQuality(graphics.lightingQuality);
  world.setFullscreenGlow(graphics.fullscreenGlow);
  if (graphics.godRays !== undefined) world.setGodRays(graphics.godRays);
  world.setGroundCover(cover, graphics.grassRadius, graphics.grassDense, graphics.grassDensity);
  // A player's own graphics options over the scenario's block: every leaf the page would push.
  if (config.settings) applyRendererGraphicsSettings(world, { ...defaultSettings(), ...config.settings }, cover);
  if (config.weather) world.setWeather(config.weather);
}

/** Everything still loading and everything that failed, over the renderer and its clients. */
export function benchReadiness(world: WorldRenderer3D, clients: BenchClients,
  missingTextures: KnownMissingTextureLedger): BenchReadiness {
  const { environment, terrain, splat, cover, lighting, liquids, horizon } = clients;
  const e = environment.stats, t = terrain.stats, s = splat.stats, r = world.benchmarkReadiness;
  const async = [cover.stats, lighting.stats, liquids.stats, horizon.stats, horizon.detail.stats]; // 22.10 (7.44): detail
  const pending = e.activeTiles + e.activeModels + e.queuedModels + e.activeGroups + e.queuedGroups
    + e.activeAnimations + e.queuedAnimations + t.active + s.active
    + r.modelTexturesPending + r.worldTexturesPending + (r.wmoGroupsPending ?? 0)
    + (r.terrainRepairsPending ?? 0)
    + r.groundCoverModelsPending + r.characterAtlasPending
    + world.programWarmup.queued + async.reduce((n, x) => n + x.pending, 0)
    + world.horizonDetailPending; // 22.10 (7.44)
  const errors = e.failedModels + e.failedTiles + e.failedGroups + e.failedAnimations
    + r.modelTexturesErrors + r.worldTexturesErrors + r.characterAtlasErrors + t.failed + s.failed + async.reduce((n, x) => n + x.error, 0);
  // 05.10-A7b-9 (7.18): the environment stand-ins with the tile losses and retry waits of this run's clients.
  const report = world.standInReport();
  const standIns = { ...report, environment: environmentStandInsWith(report.environment,
    { environment, splat, light: lighting, horizon }) };
  return { pending, errors, details: { environment: e, terrain: t, splat: s, renderer: r,
    units: world.telemetry.unitsDrawn, standIns,
    knownMissingTextures: [...missingTextures.missing], textureOtherFailures: missingTextures.otherFailures } }; // 06.10-P1-00b
}
