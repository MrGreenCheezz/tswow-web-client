import * as THREE from "three";
import { WorldSubmissionCapture, type WorldSubmissionSnapshot } from "./WorldSubmissionCapture.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import {
  appearsDead, fieldFloat, isWorldObjectDead, splineAnimationTier, type WorldObjectState, type WorldPosition, type WorldState,
} from "../world/WorldState.js";
import { sceneYaw, toRenderAxes, type Quat } from "../world/GameObjectRotation.js";
import { passengerGameObjectTilt } from "../world/TransportPassengers.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT,
  CAMERA_EYE_BODY_SHARE, CAMERA_FIRST_PERSON_DISTANCE, CAMERA_FOV_DEGREES, CAMERA_PIVOT_BODY_SHARE,
  cameraBodyHeight, createCamera, type HeightSampler,
} from "./SimpleScene.js";
import { ENVIRONMENT_FAR_RANGE, ENVIRONMENT_RANGE, ENVIRONMENT_RESIDENT_HYSTERESIS, ENVIRONMENT_STREAM_RANGE, TERRAIN_GRID_SIZE, modelKey, terrainGrid, type EnvironmentClient, type EnvironmentModel, type EnvironmentObject, type TerrainClient } from "./Terrain.js";
import { terrainGeometryData, terrainGeometrySteps, type TerrainGeometryData } from "./TerrainGeometry.js";
export { terrainGeometryData, terrainHeightField, terrainNormals, surfaceNormal, type TerrainGeometryData } from "./TerrainGeometry.js";
import { TerrainStreamingWindow, terrainTileKey, type TerrainStreamingPlan } from "./TerrainStreaming.js";
import { ProgramWarmup, programWarmupKind, WarmHold, type ProgramWarmupKind } from "./ProgramWarmup.js";
import { useFloatUniformSetters } from "./FloatUniformSetters.js";
import { ShaderProgramTrace, type ShaderProgramEvent } from "./ShaderProgramTrace.js";
import { EnvironmentSpatialIndex } from "./EnvironmentSpatialIndex.js";
import {
  selectGameObjectAdmission, selectUnitAdmission, stableBoundedTopKWhere,
  type UnitAdmissionCandidate,
} from "./RenderAdmission.js";
import {
  applyTerrainSplat, setTerrainSplatMicroNormals, type TerrainSplatClient,
} from "./TerrainSplat.js";
import {
  GROUND_COVER_BUDGET, GROUND_COVER_MARGIN, GROUND_COVER_MAX_RADIUS, createGroundCoverCellCache,
  groundCoverRecipeSource, hypot2, scatterGroundCover, writeGroundCoverInstanceMatrices,
  type GroundCoverBatch, type GroundCoverClient, type GroundCoverField,
} from "./GroundCover.js";
import { createGroundCoverFadeUniforms, type GroundCoverFadeUniforms } from "./GroundCoverFade.js";
import { skyboxAnimationTimeMs } from "./LightClient.js";
import type { LightSample, ResolvedColour } from "./LightTypes.js";
import { LocalLightSelection, modelFixtureLights, sampleFixtureLight } from "./LocalLighting.js";
import {
  GOD_RAY_STRENGTH_SCALE_MAX, godRayStrengthScale, lightingProfile, shadowMaterialEligible,
  stabiliseDirectionalShadowCenter, unitCastsEnhancedShadow, withToneShoulder, toneShoulder,
  type LightingProfile,
} from "./LightingQuality.js";
import {
  CascadedSunShadows, SHADOW_FAR_LAYER, SHADOW_PROXY_LAYER, type ShadowCascadeSnapshot,
} from "./CascadedShadows.js";
import {
  applyHorizonAerialFog, applyWorldLight, createWorldLightUniforms,
  setWorldLightAerialFog, setWorldLightDaylight, setWorldLightImmersiveStrength, setWorldLightUniforms,
  setWorldLightRim, setWorldLightIndoor, setWorldLightShadowSuppressed,
  type WorldLightUniforms,
} from "./WorldLighting.js";
import { CinematicPost, type CinematicProfile } from "./CinematicPost.js";
import {
  LIQUID_CELL_YARDS, applyFallbackLiquidShaderProfile, applyLiquidShaderProfile,
  buildLiquidMaterial, copyWaterSkyBands, createWaterShaderSharedUniforms,
  liquidClassOf, updateLiquidMaterial, WATER_FALLBACK_OPACITY, WaterDetailNormalMaps, liquidCalmOf,
  type LiquidClass, type LiquidMaterial, type LiquidTextureClient, type WaterShaderSharedUniforms,
} from "./Water.js";
import { DAY_HALF_MINUTES } from "../world/GameTimeProtocol.js";
import { DUEL_OUT_OF_BOUNDS_YARDS } from "../world/DuelProtocol.js";
import type { EnchantGlow } from "./ItemEnchantments.js";
import type { GameObjectDisplayMetadata } from "./GameObjectMetadata.js";
import type { CreatureModelMetadata, UnitModel } from "./CreatureModelClient.js";
import { ANIMATION_IDS } from "../generated/animations.js";
import {
  M2_TO_SCENE, actionAnimation, addSkinnedClips, mergeSkinnedClips, animatesAsDoodad, applyBillboardBones,
  applyGlobalSequenceBones, buildSkinnedTemplate,
  disposeSkinnedInstance,
  ACTION_ANIMATION_BLEND, animationBlend, animationFadeWindow, clipBlendTime, pendingActionFate,
  pendingActionExpired, commitLocomotion,
  buildSkinnedTemplateFrom, chooseAnimation, instantiateSkinned, isUnitFlying, isUnitMoving, poseAnimation,
  poseAnimationFamily, type AnimationRequestFamily,
  animationTransition, isTerminalUnitPose, needsSidecarAnimations, poseTransition, resolveActionAnimation,
  resolveAnimation, resolveSpellVisualAnimation, spellVisualAnimationCandidates,
  ACTION_SIDECAR_WAIT, LOOP_ANIMATION_BLEND, SHOOT_METADATA_WAIT, mountSpecialAnimation,
  clipMovingSpeed, mountGaitTimeScale, mountPose, mountPoseTransition, unitTravelSpeed,
  isLocomotionGait, locomotionAuthoredSpeed, measuredTravelSpeed, unitGaitTimeScale, spawnFadeFactor,
  weaponPose,
  applyStrafeYaw, stepStrafeYaw, strafeYawBonesFor, strafeYawTarget,
  fastPoseProgramFor, writeGlobalSequenceLocals,
  type RigSkeleton, type SkinnedInstance, type SkinnedTemplate, type UnitAction, type UnitPose,
} from "./AnimatedModel.js";
import {
  UnitActionQueue, animationPlaysOnUpperBody, heldClipPlaysOnce, locomotionUnderlayClip,
  unitActionDisplay, unitActionEndsOnMovement,
  type ShownUnitAction, type UnitActionDisplay, type UnitActionEntry, type UnitActionLayer, type UnitActionPayload,
} from "./UnitActionArbiter.js";
import { FastPoseState, type FastPoseProgram } from "./FastPose.js";
import { SharedPose, pagePoseEngine, type PoseEngine, type PoseEngineStats } from "./PoseEngine.js";
import {
  EVERY_GEOSET, applyBlendMode, buildModel, characterSlots, cloneMaterialFaded, fadeMaterial,
  setBuiltModelFantasyGlow,
  unitGeosets, updateBatchColours, worldCharacterGeosets,
  type AnimatedBatch, type BuiltModel, type GeosetChoice, type TextureSlots,
} from "./ModelBuild.js";
import {
  MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE, MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION,
  createInstancedModelPlacementLocalLightMaterials, createModelPlacementLocalLightMaterials,
  createModelPlacementTintMaterials, disposeModelPlacementTintMaterials, modelPlacementTintColour,
  type ModelPlacementTint,
} from "./ModelPlacementTint.js";
import {
  BuiltModelCache, disposeEvictedBuiltModels, knownGeometryBufferBytes,
  type BuiltModelCacheStats, type EvictedBuiltModel,
} from "./BuiltModelCache.js";
import {
  ModelTextureLoader, type ModelTextureLease, type ModelTextureResidencyStats,
} from "./TextureLoad.js";
import { WarmLeasePool } from "./AssetWarmup.js";
import {
  WORLD_MATERIAL_CACHE_COUNT_LIMIT, WorldMaterialCache,
  type WorldMaterialEntry, type WorldMaterialResidencyStats,
} from "./WorldMaterialCache.js";
import { FrameBuildBudget } from "./FrameBuildBudget.js";
import { UnitSceneGroup } from "./UnitSceneGroup.js";
import { StandInLedger, type StandInReason, type StandInReport, type StandInWearing } from "./StandIn.js";
import {
  ATTACHMENT_HELM, ATTACHMENT_MOUNT_SEAT, ATTACHMENT_SHOULDER_RIGHT,
  TEXTURE_TYPE_BODY, TEXTURE_TYPE_OBJECT_SKIN, modelOwnTexturePaths, textureUrl, type WvmModel,
} from "./Wvm.js";
import {
  attachmentHeight, attachmentOffset, attachmentPoint, attachmentRotation, boneOf, mountNesting, mountSeatOffset,
} from "./Attachment.js";
import {
  wmoDoodadInAperture, wmoDoodadRoomVisible, wmoFloorLight, wmoInteriorGroupAt, wmoInteriorOnly, wmoLandFogAt,
  wmoRunIsInterior, type WmoDoodadRooms, type WmoFog, type WmoGroup, type WmoModel, type WmoRun,
} from "./WmoModel.js";
import { WmoGeometryBuild } from "./WmoGeometryBuild.js";
import {
  canonicalCollisionModelName,
  type StaticWmoFloor, type StaticWmoPlacementIdentity,
} from "./game/CollisionSource.js";
import { viewSubjectIn } from "./game/ViewSubject.js"; // 11.02-I
import { VehiclePassengerPoser } from "./VehiclePassengerPose.js"; // 11.02-H
import { vehicleCatalog } from "./VehicleClient.js"; // 11.02-H
import { drawnUnitPosition } from "./VehiclePassengerOverlay.js"; // 11.02-tails
import { selectWmoPortalGroups } from "./WmoOcclusion.js";
import {
  animatesAsGameObject, customGameObjectAnimation, gameObjectPose,
  GO_TYPE_MO_TRANSPORT, GO_TYPE_TRANSPORT,
} from "./GameObjectAnimation.js";
import {
  TransportPathClient, placeOnTransportPath, sampleTransportPath,
} from "./TransportPath.js";
import { liftPhaseMs } from "./LiftClock.js";
import {
  HORIZON_FAR_PLANE, HorizonClient, buildHorizonGeometry, horizonTiles,
} from "./Horizon.js";
import {
  billboardView, buildModelEffects, disposeModelEffects, resetModelEffects, setModelEffectsFantasyGlow,
  updateModelEffects,
  visitModelEffectsResources, type ModelEffects,
} from "./ParticleRender.js";
import { WeatherEffect, advanceWeather, weatherDensity, type WeatherFade } from "./WeatherEffect.js";
import { VEGETATION_WIND_CULL_PADDING, VEGETATION_WIND_TIME } from "./VegetationWind.js";
import {
  AtmosphereEffects, DEFAULT_ATMOSPHERE_PROFILE, applyPrecipitationHaze, atmosphereProfileActive, atmosphereQuality,
  isThunderState, normaliseAtmosphereProfile,
  type AtmosphereFrame, type AtmosphereProfile,
} from "./AtmosphereEffects.js";
import { setTerrainWetness, setWaterRainRipples, setWmoWetness, trackWmoWetSurface } from "./WetSurfaces.js";
import {
  FrameCadenceClock, FrameClock, makeRendererTelemetrySnapshot, shouldReselect,
  type RendererTelemetrySnapshot,
} from "./RenderStats.js";
import {
  visitGeometryBuffers, visitMaterialTextures, type RetainedResourceVisitor,
} from "./ResourceAccounting.js";
import {
  GpuTimer, MAX_PENDING_GPU_QUERIES, createWebGlGpuTimer,
  type GpuTimerUnavailableReason,
} from "./GpuTimer.js";
import { renderBenchmarkGpuObserver } from "./RenderBenchmarkRuntime.js";
import type { BenchmarkRendererReadinessInput } from "./RenderBenchmarkReadiness.js";
import { weatherIsBlack, weatherKind, type Weather } from "../world/WorldMessageProtocol.js";
import type { BillboardView } from "./Particles.js";
import {
  missileDirection, missilePoint,
  spellVisualTransformEuler, spellVisualTransformOffset,
  type SpellVisualPlan, type VisualAnimation, type VisualAnimationMode, type VisualInstance,
} from "./SpellVisuals.js";
import type { SpellVisualEffectTransform } from "../gateway/SpellVisual.js";
import {
  isPlayerGhost, isUnitCreeping, unitAppearance, unit as unitFields,
  type UnitAuraAppearance,
} from "../world/Fields.js";
import { UNIT_FLAG_IN_COMBAT, UNIT_FLAG_UNINTERACTIBLE } from "../world/FactionRules.js";
import { UNIT_STAND_STATE_STAND } from "../world/CharacterProgressProtocol.js";
import type { CollisionLiquid, CollisionModel } from "../world/CollisionFormat.js";

/** One deterministic evolution step supplied by an offline render replay. */
export interface RenderFrameTime {
  readonly nowMs: number;
  readonly elapsedSeconds: number;
  readonly frameIndex: number;
}

/** Receipt proving that one frame reached the renderer's sky and world submissions. */
export interface WorldSubmissionReceipt {
  readonly submitted: true;
  readonly submissionSerial: number;
}

export interface BuiltModelResidencyStats {
  readonly builtModels: Readonly<BuiltModelCacheStats>;
  readonly builtUnits: Readonly<BuiltModelCacheStats>;
  readonly legacyGeometry: Readonly<LegacyGeometryResidencyStats>;
  readonly wmoGroups: Readonly<WmoGroupGeometryResidencyStats>;
}

export interface LegacyGeometryResidencyStats extends BuiltModelCacheStats {
  /** Distinct exact legacy geometry entries borrowed by retained wrappers. */
  readonly pinnedCount: number;
  readonly pinnedKnownBufferBytes: number;
  /** Retained environment, game-object, unit, and sky borrowers. */
  readonly borrowerCount: number;
}

export interface WmoGroupGeometryResidencyStats extends BuiltModelCacheStats {
  /** Distinct exact cache entries borrowed by attached group meshes. */
  readonly pinnedCount: number;
  readonly pinnedKnownBufferBytes: number;
  /** Placement-local meshes; several may borrow one pinned cache entry. */
  readonly wrapperCount: number;
  /** Exact WMO-kind entries in the shared bounded world-material cache. */
  readonly materialEntries: number;
}

export interface WorldRendererGraphicsReadback {
  readonly lightingQuality: number;
  readonly renderScalePercent: number;
  readonly wmoOcclusion: boolean;
  readonly characterAtlasAnisotropy: boolean;
  readonly grassRadius: number;
  readonly grassDense: boolean;
  /** Whether the depth tint and waterline pass may run at all this session. */
  readonly underwaterOverlay: boolean;
  /** Classic bloom leaf. The frame stays direct only when this and God rays are both inactive. */
  readonly fullscreenGlow: boolean;
  /** Account leaf for the depth-aware screen-space sun shafts. */
  readonly godRays: boolean;
  readonly experimentalShaderProfile: Readonly<ExperimentalShaderProfile>;
}

/** Renderer-level default-OFF baseline; account settings enable the reversible world effects. */
export interface ExperimentalShaderProfile {
  /** Height-weighted outdoor fog and daylight scatter, converging to Light.dbc at the far plane. */
  readonly aerialHeightFog: boolean;
  readonly terrainMicroNormals: boolean;
  readonly waterFresnel: boolean;
  readonly waterMicroWaves: boolean;
  readonly waterSunSparkle: boolean;
  /** Depth-keyed shoreline foam for terrain water/ocean; fallback and glowing liquids stay neutral. */
  readonly waterFoam: boolean;
  /** GPU sway for strictly classified static foliage and ground-cover materials. */
  readonly vegetationWind: boolean;
  /** Local additive spell energy plus magma/slime self-emission; no post-process or extra pass. */
  readonly fantasyGlow: boolean;
}

export const DEFAULT_EXPERIMENTAL_SHADER_PROFILE: Readonly<ExperimentalShaderProfile> = Object.freeze({
  aerialHeightFog: false,
  terrainMicroNormals: false,
  waterFresnel: false,
  waterMicroWaves: false,
  waterSunSparkle: false,
  waterFoam: false,
  vegetationWind: false,
  fantasyGlow: false,
});

/**
 * The liquid surface the camera is looking through, pushed in by whoever owns the collision query.
 *
 * The renderer deliberately does not sample liquid itself: the terrain client and the WMO floor
 * group are both the loop's, and the same pair already decides the light slot. This is that same
 * answer, kept instead of thrown away.
 */
export interface UnderwaterSurface {
  /** World Z of the surface, which the scene draws as Y. */
  readonly height: number;
  /** `LiquidType.dbc` row, or 0 where only the map file's flag byte is known. */
  readonly entry: number;
  /** The map file's liquid flag byte; 0 for a WMO's own `MLIQ` grid. */
  readonly flags: number;
}

/**
 * How thick the crossing is, in yards of world.
 *
 * The near plane's half-height and nothing else, because that is exactly the slab of world the
 * near plane spans and therefore the only depth range over which part of it can be above the
 * surface while the rest is under (wowee `renderer.cpp:2871-2875`). A flat number here would be
 * wrong the moment the field of view or the near plane moves.
 */
export function underwaterCrossingBand(nearPlane: number, fovYDegrees: number): number {
  if (!Number.isFinite(nearPlane) || !Number.isFinite(fovYDegrees)) return UNDERWATER_MIN_BAND;
  const half = Math.tan(Math.max(0, Math.min(179, fovYDegrees)) * Math.PI / 360);
  return Math.max(UNDERWATER_MIN_BAND, Math.max(0, nearPlane) * half);
}

const UNDERWATER_MIN_BAND = 0.05;

/**
 * Which of the reference's two tints a liquid takes.
 *
 * Canal water is the darker, faster-fogging one, and its three `LiquidType.dbc` rows are named by
 * the reference itself (`renderer.cpp:2911-2913`: 5, 13, 17). Row 13 is «WMO Water», which is what
 * the extractor writes into `LIQU` for the models under Stormwind — so the city's canals and its
 * flooded rooms answer with the same tint from either source.
 */
export function underwaterLiquidIsCanal(entry: number): boolean {
  return entry === 5 || entry === 13 || entry === 17;
}

/** The reference's two tints, in the display space they are blended in. */
export const UNDERWATER_CANAL_TINT: readonly [number, number, number] = Object.freeze([0.01, 0.04, 0.10]);
export const UNDERWATER_LAKE_TINT: readonly [number, number, number] = Object.freeze([0.03, 0.09, 0.18]);
/** Where the tint starts, matching what the water plane itself was contributing at the surface. */
export const UNDERWATER_SURFACE_HANDOFF = 0.38;
/** Where it stops. Past this the view is dark enough that more is a black screen, not deep water. */
export const UNDERWATER_MAX_FOG = 0.75;

/**
 * How strongly the tint covers the view at a given depth.
 *
 * Not from zero: until the eye passes the surface the view is darkened by looking *through* the
 * water plane, whose own alpha runs towards 0.9 with depth, and once the eye is under, that plane
 * is behind the camera and contributes nothing. Starting near zero made submerging brighten the
 * scene, which is backwards — so it starts where the plane left off and deepens from there.
 */
export function underwaterFogStrength(depth: number, canal: boolean): number {
  const under = Number.isFinite(depth) ? Math.max(0, depth) : 0;
  const depthFog = 1 - Math.exp(-under * (canal ? 0.25 : 0.12));
  const strength = UNDERWATER_SURFACE_HANDOFF + depthFog * (UNDERWATER_MAX_FOG - UNDERWATER_SURFACE_HANDOFF);
  return Math.min(UNDERWATER_MAX_FOG, Math.max(UNDERWATER_SURFACE_HANDOFF, strength));
}

export interface UnderwaterOverlayFrame {
  /** Yards below the surface, floored at zero: the band above it is shaded, not un-shaded. */
  readonly depth: number;
  readonly canal: boolean;
  readonly tint: readonly [number, number, number];
  /** Opacity where the whole view is under. */
  readonly fogStrength: number;
  /** Whether a seam is still on screen. False once the near plane is wholly under the surface. */
  readonly crossing: boolean;
}

/**
 * Everything the overlay draws with, or nothing at all — which is the ordinary answer.
 *
 * Undefined means the frame is exactly the frame this client drew before the effect existed: no
 * extra scene, no extra draw call, no uniform written.
 */
export function underwaterOverlayFrame(
  surface: Readonly<UnderwaterSurface> | undefined,
  eyeZ: number,
  band: number,
  liquidClass: LiquidClass,
): UnderwaterOverlayFrame | undefined {
  if (!surface || !Number.isFinite(surface.height) || !Number.isFinite(eyeZ)) return undefined;
  // Water and ocean only, and this is a decision rather than an omission: both of the reference's
  // tints are water, there is no authored number anywhere for what magma or slime look like from
  // the inside, and a dark blue screen in a lava lake is a wrong answer where nothing is merely a
  // missing one. Swimming in either is fatal within seconds in any case.
  if (liquidClass !== "water" && liquidClass !== "ocean") return undefined;
  const crossingBand = Number.isFinite(band) && band > 0 ? band : UNDERWATER_MIN_BAND;
  const eyeDepth = surface.height - eyeZ;
  // From a near plane's half-height *above* the surface: standing in a lake looking across it, the
  // water in front of the near-plane cut is not drawn at all, and those pixels are looking through
  // water. Safe only because the seam below is geometric — a pixel whose ray enters the world above
  // the surface still comes out untouched, so the band costs nothing where there is no water.
  if (!(eyeDepth > -crossingBand)) return undefined;
  const canal = underwaterLiquidIsCanal(surface.entry);
  return {
    depth: Math.max(0, eyeDepth),
    canal,
    tint: canal ? UNDERWATER_CANAL_TINT : UNDERWATER_LAKE_TINT,
    fogStrength: underwaterFogStrength(eyeDepth, canal),
    crossing: eyeDepth < crossingBand,
  };
}

export interface FormalRenderSurfaceStamp {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly systemDpr: number;
  readonly effectivePixelRatio: number;
  readonly contextLost: boolean;
  readonly contextGeneration: number;
}

/** WebGLRenderer.render silently returns while its context is lost; a receipt must not. */
export function webGlContextCanSubmit(
  context: Readonly<{ isContextLost: () => boolean }> | undefined,
): boolean {
  if (!context) return false;
  try {
    return context.isContextLost() === false;
  } catch {
    return false;
  }
}

/** Renderer-only state that a fixed WorldState replay cannot reproduce. */
export interface ReplayEpochBoundaryState {
  readonly renderFrameActive: boolean;
  readonly transientVisuals: number;
  readonly persistentStateVisuals: number;
  readonly pendingVisualAnimations: number;
  readonly pendingUnitActions: number;
  readonly pendingGameObjectAnimations: number;
  readonly pendingMountSpecials?: number;
}

/** Pure guard shared by the renderer boundary and focused replay tests. */
export function validateReplayEpochBoundary(state: ReplayEpochBoundaryState): void {
  if (state.renderFrameActive) {
    throw new Error("cannot reset replay epoch during an active render frame");
  }
  if (state.transientVisuals > 0
    || state.persistentStateVisuals > 0
    || state.pendingVisualAnimations > 0
    || state.pendingUnitActions > 0
    || state.pendingGameObjectAnimations > 0
    || (state.pendingMountSpecials ?? 0) > 0) {
    throw new Error("cannot reset replay epoch with renderer-only transient requests");
  }
}

/** Prevents live wall time and deterministic replay tickets from crossing epoch boundaries. */
export function validateRenderEvolutionMode(replayEpochActive: boolean, frameTimeProvided: boolean): void {
  if (replayEpochActive && !frameTimeProvided) {
    throw new Error("active replay epoch requires RenderFrameTime");
  }
  if (!replayEpochActive && frameTimeProvided) {
    throw new Error("RenderFrameTime requires an active replay epoch");
  }
}

/** Runtime boundary for replay tickets before they can drive renderer-owned clocks. */
export function validateRenderFrameTime(value: unknown): asserts value is RenderFrameTime {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("RenderFrameTime must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["nowMs"] !== "number"
    || !Number.isFinite(candidate["nowMs"])
    || candidate["nowMs"] < 0) {
    throw new RangeError("RenderFrameTime.nowMs must be a finite non-negative number");
  }
  if (typeof candidate["elapsedSeconds"] !== "number"
    || !Number.isFinite(candidate["elapsedSeconds"])
    || candidate["elapsedSeconds"] < 0) {
    throw new RangeError("RenderFrameTime.elapsedSeconds must be a finite non-negative number");
  }
  if (typeof candidate["frameIndex"] !== "number"
    || !Number.isSafeInteger(candidate["frameIndex"])
    || candidate["frameIndex"] < 0) {
    throw new RangeError("RenderFrameTime.frameIndex must be a non-negative safe integer");
  }
}

/** Validates and detaches a replay ticket from caller-owned mutable state. */
export function cloneRenderFrameTime(value: unknown): Readonly<RenderFrameTime> {
  validateRenderFrameTime(value);
  return Object.freeze({
    nowMs: value.nowMs,
    elapsedSeconds: value.elapsedSeconds,
    frameIndex: value.frameIndex,
  });
}

/** EQUIPMENT_SLOT_*: which of the nineteen visible-item words an item came from. */
/**
 * How far a doodad standing on the terrain is kept. The default fog closes at 640 m, so 300 m adds
 * a useful outer ring while keeping the visible placement count under the existing budget.
 */
export { ENVIRONMENT_RANGE };

/** Names renderer-built resources by both logical asset key and world/session identity. */
export function worldResourceCacheKey(epoch: number, key: string): string {
  return `${epoch}|${key}`;
}

/**
 * Loud shader errors in development, silent fast links in production builds.
 *
 * three fetches info logs on every program link while `checkShaderErrors` is on; the official
 * guidance is to disable it in production for performance gain. Unit tests run without a Vite
 * env, which reads as development and keeps the checks.
 */
export function rendererDebugShaderErrors(): boolean {
  const env = (import.meta as ImportMeta & { readonly env?: { readonly DEV?: unknown } }).env;
  return env?.DEV !== false;
}

/** Exact material identity within one decoded WMO parent and renderer world/session. */
export function wmoRunMaterialCacheKey(
  parentToken: string,
  materialIndex: number,
  textureUrl: string,
  blendMode: number,
  materialFlags: number,
  interior: boolean,
): string {
  return JSON.stringify([
    parentToken, "wmo-run", materialIndex, textureUrl, blendMode, materialFlags, interior,
  ]);
}

interface WmoInteriorFogUniforms {
  readonly colour: { value: THREE.Color };
  readonly near: { value: number };
  readonly far: { value: number };
}

/**
 * Gives an interior WMO surface the room's MFOG without replacing the scene's outdoor fog.
 *
 * Three's stock fog uniforms are scene-wide. Rewriting those while the camera is under a roof also
 * paints terrain, units and the sky seen through a doorway with a tavern's short peach fog. This
 * small material-local substitution keeps Light.dbc authoritative outside while retaining the
 * authored room distances and colour on the interior surfaces that own them.
 */
export function applyWmoInteriorFog(
  material: THREE.MeshBasicMaterial,
  uniforms: WmoInteriorFogUniforms,
): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  const marker = "#include <fog_fragment>";
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    const occurrences = shader.fragmentShader.split(marker).length - 1;
    if (occurrences !== 1) {
      throw new Error(`interior WMO fog expected one fog marker, found ${occurrences}`);
    }
    shader.uniforms.wowWmoFogColour = uniforms.colour;
    shader.uniforms.wowWmoFogNear = uniforms.near;
    shader.uniforms.wowWmoFogFar = uniforms.far;
    shader.fragmentShader = `
      uniform vec3 wowWmoFogColour;
      uniform float wowWmoFogNear;
      uniform float wowWmoFogFar;
      ${shader.fragmentShader}`.replace(marker, `
      #ifdef USE_FOG
        float wowWmoFogFactor = smoothstep(wowWmoFogNear, wowWmoFogFar, vFogDepth);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, wowWmoFogColour, wowWmoFogFactor);
      #endif`);
  };
  material.customProgramCacheKey = () => `${previousKey}|wmo-interior-fog-v1`;
  material.needsUpdate = true;
}

export type LegacyGeometryDomain = "static" | "skinned";

/** Exact legacy geometry identity within one decoded parent and renderer world/session. */
export function legacyGeometryCacheKey(
  parentToken: string,
  domain: LegacyGeometryDomain,
): string {
  return JSON.stringify([parentToken, "legacy-geometry", domain]);
}

/** Exact legacy run material; ordinals keep repeated/non-monotonic material indexes disjoint. */
export function legacyRunMaterialCacheKey(
  parentToken: string,
  runOrdinal: number,
  materialIndex: number,
  textureUrl: string,
  blendMode: number,
  materialFlags: number,
): string {
  return JSON.stringify([
    parentToken, "legacy-run", runOrdinal, materialIndex, textureUrl, blendMode, materialFlags,
  ]);
}

/** Exact decoded-parent transition that can invalidate a retained legacy GPU resource bundle. */
export function legacyDecodedModelReplaced(
  retainedModel: EnvironmentModel | undefined,
  retainedHasLegacyResources: boolean,
  currentModel: EnvironmentModel | undefined,
): boolean {
  if (!currentModel) return false;
  const currentIsLegacy = currentModel.wvm === undefined && currentModel.wmo === undefined;
  return (retainedHasLegacyResources || currentIsLegacy) && retainedModel !== currentModel;
}

export interface WmoGroupResourceBorrower<TGeometry> {
  readonly entry: TGeometry;
  readonly materialEntries: readonly WorldMaterialEntry[];
  readonly mesh: THREE.Object3D;
}

/** Adds only wrappers physically attached to their placement node to the exact live-pin sets. */
export function collectAttachedWmoGroupResourcePins<TGeometry>(
  parent: THREE.Object3D,
  borrowers: Iterable<WmoGroupResourceBorrower<TGeometry>>,
  geometryPins: Set<TGeometry>,
  materialPins: Set<WorldMaterialEntry>,
): number {
  let wrapperCount = 0;
  for (const borrower of borrowers) {
    if (borrower.mesh.parent !== parent) continue;
    geometryPins.add(borrower.entry);
    for (const materialEntry of borrower.materialEntries) materialPins.add(materialEntry);
    wrapperCount++;
  }
  return wrapperCount;
}

export interface LegacyResourceBorrower<TGeometry> {
  readonly legacyGeometry?: TGeometry;
  readonly materialEntries?: readonly WorldMaterialEntry[];
}

/** Pins one retained legacy borrower's resources; 1 when it borrowed anything, else 0. */
export function pinLegacyResources<TGeometry>(
  borrower: LegacyResourceBorrower<TGeometry>,
  geometryPins: Set<TGeometry>,
  materialPins: Set<WorldMaterialEntry>,
): 0 | 1 {
  const entries = borrower.materialEntries;
  const count = entries === undefined ? 0 : entries.length;
  if (!borrower.legacyGeometry && count === 0) return 0;
  if (borrower.legacyGeometry) geometryPins.add(borrower.legacyGeometry);
  for (let index = 0; index < count; index++) materialPins.add(entries![index]!);
  return 1;
}

/** Pins every retained legacy borrower, including intentionally hidden budget-dormant wrappers. */
export function collectLegacyResourcePins<TGeometry>(
  borrowers: Iterable<LegacyResourceBorrower<TGeometry>>,
  geometryPins: Set<TGeometry>,
  materialPins: Set<WorldMaterialEntry>,
): number {
  let borrowerCount = 0;
  for (const borrower of borrowers) borrowerCount += pinLegacyResources(borrower, geometryPins, materialPins);
  return borrowerCount;
}

/** Applies the one canonical sampling policy shared by WMO and legacy materials using this base. */
export function configureWmoCanonicalTexture(texture: THREE.Texture, anisotropy: number): void {
  let changed = false;
  if (texture.colorSpace !== THREE.SRGBColorSpace) {
    texture.colorSpace = THREE.SRGBColorSpace;
    changed = true;
  }
  if (texture.wrapS !== THREE.RepeatWrapping) {
    texture.wrapS = THREE.RepeatWrapping;
    changed = true;
  }
  if (texture.wrapT !== THREE.RepeatWrapping) {
    texture.wrapT = THREE.RepeatWrapping;
    changed = true;
  }
  // v = 0 is the top row in the client's own convention, and three flips on upload.
  if (texture.flipY !== false) {
    texture.flipY = false;
    changed = true;
  }
  if (texture.anisotropy !== anisotropy) {
    texture.anisotropy = anisotropy;
    changed = true;
  }
  // TextureLoader returns an empty base before its image callback runs. Marking that handle for
  // upload increments its version and makes WebGLTextures warn on the first draw (`image === null`);
  // the loader marks it after the image arrives. Loaded/data textures still need the immediate mark.
  if (changed && texture.image !== null && texture.image !== undefined) texture.needsUpdate = true;
}

export type BuiltModelResourceDomain = "model" | "unit";

/** Keeps shared template ownership disjoint even when two logical assets use the same raw key. */
export function worldBuiltModelCacheKey(
  epoch: number,
  domain: BuiltModelResourceDomain,
  key: string,
): string {
  return worldResourceCacheKey(epoch, `${domain}|${key}`);
}

/** Near quota for outdoor WMOs; loose M2s have their own `ENVIRONMENT_SCENERY_BUDGET`. */
const ENVIRONMENT_BUDGET = 320;
/** Hidden placements retained from roughly three previous camera sectors for a bounded 360° turn. */
export const ENVIRONMENT_WARM_EXTERIOR_BUDGET = 960;
/**
 * Warm-cap enforcement cadence, in submitted frames (~0.5 s at 60 fps). Eviction is invisible
 * (warm residents are hidden), so it does not need to run on the frame the overflow appears.
 */
const WARM_PRUNE_INTERVAL_FRAMES = 30;
/**
 * A WMO's own doodads — the tables, kegs and book stacks inside a building — are drawn on a much
 * shorter leash. They arrive as placements without their source-room ordinal, so WMO portal
 * traversal cannot classify them; distance and the camera frustum remain the conservative filter.
 * Sixty yards is about the point where a doorway stops showing anything of the room behind it.
 */
const INTERIOR_RANGE = 60;
/**
 * The leash of a room of an interior-only WMO (`wmoInteriorOnly`) the camera or player stands in,
 * and of its doodads, which then follow their MODR rooms rather than distance. A dungeon's halls
 * outrun sixty yards: in Gundrak it kept 4–8 of 24 rooms and 29–52 of 962 doodads from each spot
 * measured, and the 149–166 torches and braziers past it left doorways open onto the outdoor sky.
 * Portals decide what shows inside: 14–23 of the 24 rooms are culled from eleven views measured.
 * The rest costs 12–374 more draws and 0.2–3.1 ms more CPU a frame on P-cores (from 1.1–2.0 ms),
 * the most facing a wall across the 250-yard hub; a 150-yard doodad leash dropped far lanterns and
 * skull pikes from the long views to save 0.2–2.1 ms of it, so the doodads keep the rooms' leash.
 */
const INTERIOR_ONLY_RANGE = ENVIRONMENT_RANGE;

/**
 * NDC slack around the screen rectangle a room is seen through. Admission reads the portal walk
 * of the frame before (a frame or two behind the camera), so an edge doodad is kept, not late.
 */
const INTERIOR_ONLY_APERTURE_MARGIN = 0.1;

/** Rooms of one interior-only placement shown this frame, one byte per group. */
interface InteriorOnlyRooms {
  readonly model: WmoModel;
  readonly visible: Uint8Array;
  /** Per group, the NDC rectangle it is seen through (`selectWmoPortalGroups`), when `clipped`. */
  readonly apertures: Float32Array;
  /** The scene-to-clip matrix those rectangles were projected with. */
  readonly clip: Float32Array;
  /** This frame's rooms came from the portal walk, so `apertures` hold. */
  clipped: boolean;
  /** Rewritten every frame the placement is updated; stale rooms answer nothing. */
  live: boolean;
  serial: number;
  /** The environment snapshot whose doodads were bound to these rooms. */
  bound?: readonly EnvironmentObject[];
  /** A bound doodad's retained scene-space sphere, once its model is built. */
  sphereOf?: (object: EnvironmentObject) => EnvironmentVisibilitySphere | undefined;
  floorAt?: { x: number; y: number; z: number };
  floor?: [number, number, number] | undefined;
  /** The far-leash candidate rooms, for the player position they were chosen at. */
  farAt?: { x: number; y: number; z: number };
  far?: readonly number[];
}

/** A doodad of an interior-only placement: its rooms, and its answer for one `serial` of them. */
interface InteriorOnlyDoodad {
  readonly rooms: InteriorOnlyRooms;
  readonly table: WmoDoodadRooms;
  readonly ordinal: number;
  at: number;
  shown: boolean | undefined;
}

/** Doodads of interior-only placements, keyed to their ordinal in the tile's doodad list. */
const INTERIOR_ONLY_DOODADS = new WeakMap<EnvironmentObject, InteriorOnlyDoodad>();
/** Live interior-only placements; zero keeps the per-placement lookups off every other map. */
let interiorOnlyRoomsLive = 0;

/**
 * A bound doodad's visibility; undefined (plain leash) when nothing binds it. Shown while one of
 * its MODR rooms is and, when the rooms came through portals, while its sphere reaches the screen
 * rectangle one of them is seen through — the client culls a room's doodads by its portal view
 * too. From eight Gundrak views that trimmed 0–63 draws (up to 313 doodads, the 360-slot interior
 * quota refilling with visible ones) with identical stills; the camera's own hall is seen whole.
 * Asked by each admission tier in turn, so answered once per frame of room state.
 */
function interiorOnlyDoodadShown(object: EnvironmentObject): boolean | undefined {
  if (interiorOnlyRoomsLive === 0 || object.interior !== true) return undefined;
  const entry = INTERIOR_ONLY_DOODADS.get(object);
  if (!entry || !entry.rooms.live) return undefined;
  if (entry.at !== entry.rooms.serial) {
    entry.at = entry.rooms.serial;
    entry.shown = interiorOnlyDoodadVisible(entry, object);
  }
  return entry.shown;
}

function interiorOnlyDoodadVisible(entry: InteriorOnlyDoodad, object: EnvironmentObject): boolean | undefined {
  const { rooms, table, ordinal } = entry;
  const shown = wmoDoodadRoomVisible(table, ordinal, rooms.visible);
  if (shown !== true || !rooms.clipped) return shown;
  // Not yet built: no sphere to project, and admitting it is how it gets one.
  const sphere = rooms.sphereOf?.(object);
  return sphere === undefined
    || wmoDoodadInAperture(table, ordinal, rooms.visible, rooms.apertures, rooms.clip, sphere, INTERIOR_ONLY_APERTURE_MARGIN);
}

/** Goldshire Inn alone authors 338 placements; static repeats collapse into instanced draws later. */
const INTERIOR_BUDGET = 360;
/**
 * LOD-1: how far big shells stay admitted.
 *
 * Past the near leash the ridge kept nothing — buildings ended at 250–400 yards against an empty
 * horizon, and every approach was a pop. Large WMO placements and their outdoor shell groups
 * hold this second leash instead of the near one, on their own small quota, so a city keeps its
 * skyline without spending the near budget on it. Owned by Terrain.js (the tile footprint must
 * cover it); re-exported here beside the admission code that reads it.
 */
export { ENVIRONMENT_FAR_RANGE };
/** Far-tier quota on top of the near one: near trees must never lose to a far castle. */
const ENVIRONMENT_FAR_BUDGET = 48;
/** New environment nodes built per frame; the rest of the admitted set waits for the next one. */
const ENVIRONMENT_BUILD_BUDGET = 16;
/** WMO room builds per submitted frame across every admitted building; the rest wait their turn. */
const WMO_GROUP_BUILD_BUDGET = 6;
/** Frames a new room waits for its programs before it is drawn anyway (the old first-draw cost). */
const WMO_WARM_HOLD_FRAMES = 30;
/** Frames a new instanced doodad mesh waits for its programs before it replaces its copies anyway. */
const INSTANCE_WARM_HOLD_FRAMES = 30;
/** Cap on how long a new doodad, game-object visual or emitter set waits for its programs. */
const VISUAL_WARM_HOLD_FRAMES = 30;
/**
 * Frames a unit's new body — or a weapon, helmet or mount hung on a unit already on screen — waits
 * hidden for its programs before it is drawn anyway (the old first-draw cost). See
 * `#holdUnitUntilWarm`.
 */
const UNIT_WARM_HOLD_FRAMES = 30;
/**
 * The player's own first appearance waits at most this many frames, and once its model has been
 * on screen it never waits again: the player is the one unit whose absence is always noticed.
 */
const UNIT_WARM_HOLD_SELF_FRAMES = 6;
/**
 * Frames the end of a fade keeps its private copies, drawn at full opacity, while the shared
 * programs it gives the unit back to finish linking. See `#unitFadeReturnWaits`.
 */
const UNIT_FADE_RETURN_HOLD_FRAMES = 30;
/**
 * How long a player's model waits for visible-item rows its appearance was resolved without,
 * in the renderer's clock, before the partial look is built anyway. See `#appearanceWaits`.
 */
const APPEARANCE_PENDING_WAIT_MS = 1500;
/** Any factor strictly between 0 and 1 fades into the same program; see `createFadeProgramTwin`. */
const UNIT_FADE_TWIN_FACTOR = 0.5;
/**
 * New terrain tiles built per frame; the rest of a tile crossing waits for the next frames.
 *
 * Crossing a tile border lands up to five new tiles at once (three on an edge, five on a
 * corner), and one cold build is height sampling, normals and water scanning over 129×129
 * vertices — five of those in one frame was the measured 65 ms walking hitch. The player's
 * own tile is exempt and settles the same frame: a hole underfoot reads worse than any
 * ring pop-in a tile away.
 */
const TERRAIN_BUILD_BUDGET = 1;
/**
 * Maximum cooperative repair steps per frame, even on clocks with coarse resolution.
 * Neighbour revisions, own-data revisions and liquid-strip arrivals share the time budget.
 */
const TERRAIN_REPAIR_STEPS = 128;
/** Cooperative CPU preparation; one upload/final buffer allocation can overrun this soft budget. */
const TERRAIN_PREPARE_MS = 1.5;
const TERRAIN_PREPARE_STEPS = 12;
/**
 * Single-frame camera snap that masks an instant appearance.
 *
 * A flick (or a teleport retarget) moves tens of degrees in 16 ms: motion hides a tree that
 * simply shows up, while a tree caught mid-growth reads as broken. Past this angle the frame's
 * first sights skip the grow-in and read whole at once.
 */
const CAMERA_FLICK_RADIANS = 0.3;
/** Submitted frames of grow-in suppression after a snap (~0.2 s at 60 fps). */
const CAMERA_FLICK_SUPPRESS_FRAMES = 12;
/** Sustained turn rate that keeps suppression alive while the sweep continues. */
const CAMERA_FAST_TURN_RATE = 3.0;
/** LOD-1 for vegetation: trees hold a longer leash and grow in instead of popping. */
export const ENVIRONMENT_VEGETATION_RANGE = 600;
/**
 * Loose outdoor M2 scenery is drawn to a distance scaled by its own size, as the stock client
 * does (its «Детализация ландшафта», `environmentDetail`, is a multiplier on exactly this).
 *
 * The leash used to be a count: the 320 nearest visible placements. In Elwynn forest that quota
 * was full at 275–290 yards, 149 of its slots held fences, swamp plants and pebbles, and of the
 * 553 big trees in a view only 87 were drawn; from the air the forest visibly ended in a ring
 * around the player that moved with every turn and pitch. Measured on the source vertex radius
 * (`admissionRadius` × placement scale): canopy trees (22–100 yards) and an Elwynn mid tree (~12)
 * hold the whole leash, a pine (~9) 460 yards, a bush (~5) 255, a fence 220, a post or a barrel
 * the 90-yard floor.
 */
export const ENVIRONMENT_SCENERY_RANGE_PER_YARD = 50;
/** Shortest size-scaled leash: small clutter stays near, but never pops at the player's feet. */
export const ENVIRONMENT_SCENERY_MIN_RANGE = 90;
/** Longest size-scaled leash at detail 1; the stock 1.5 detail stretches it to the far leash. */
export const ENVIRONMENT_SCENERY_MAX_RANGE = ENVIRONMENT_VEGETATION_RANGE;
/** The stock `environmentDetail` slider's range (VideoOptionsPanels.lua: 0.5–1.5, step 0.25). */
export const ENVIRONMENT_DETAIL_MIN = 0.5;
export const ENVIRONMENT_DETAIL_MAX = 1.5;
/**
 * Safety quota for loose outdoor M2 scenery, ranked by the share of its own leash already
 * covered: an overloaded view sheds the farthest-for-its-size first, which reads as a lower
 * detail setting instead of a hole. Size leashes keep a normal view well under it: measured over
 * the Elwynn tiles, a forest or Goldshire view holds 330–520 visible scenery at detail 1 and up
 * to ~770 at 1.5 — about as many draws as the old 320+48 quotas, spent on trees instead of pebbles.
 */
export const ENVIRONMENT_SCENERY_BUDGET = 1_024;
/** Grow-in length in submitted frames (~0.5 s at 60 fps). */
const VEGETATION_GROWTH_FRAMES = 30;
/** Slow grow-in for far first sights: subtle at 400+ yards, where the tree is a few pixels. */
const VEGETATION_GROWTH_FAR_FRAMES = 45;
/** Quick soften for near first sights: enough to take the edge off, too fast to read as growing. */
const VEGETATION_GROWTH_NEAR_FRAMES = 12;
/** Scale a tree starts growing from. */
const VEGETATION_GROWTH_FROM = 0.25;
/** A placement only earns the far leash when its wire box is at least this wide, in yards. */
const ENVIRONMENT_FAR_MIN_DIAGONAL = 120;
/** Outdoor shell groups below this width keep the near leash; the skyline holds the far one. */
const WMO_SHELL_FAR_MIN_DIAGONAL = 120;
/** WMOs are room-heavy; keep their exterior shell on a smaller leash than loose outdoor objects. */
const WMO_EXTERIOR_RANGE = 250;
/** Outdoor shell groups big enough to read as skyline hold the far leash instead. */
const WMO_SHELL_FAR_RANGE = ENVIRONMENT_FAR_RANGE;
/** Interior counterpart of {@link ENVIRONMENT_WARM_EXTERIOR_BUDGET}: three previous view sectors. */
export const ENVIRONMENT_WARM_INTERIOR_BUDGET = 1_080;
/**
 * Frustum slack for environment admission, in yards.
 *
 * A one-yard margin flickers placements on the frustum edge every time the camera breathes;
 * an eight-yard band keeps the edge row admitted through small turns, so a sweep reveals
 * residents instead of builds. Off-screen admissions are still frustum-culled by three.js at
 * draw and stay a small ring, not a second scene.
 */
const ENVIRONMENT_FRUSTUM_MARGIN = 8;

/** MOMT flag 0x04: this material is drawn from both sides. Everything else is back-face culled. */
const WMO_MATERIAL_UNCULLED = 0x04;

export interface RankedEnvironmentObject {
  object: EnvironmentObject;
  distance: number;
  /** The draw leash this placement was ranked against; see {@link environmentDrawRange}. */
  range?: number;
}

/** Clamps a requested `environmentDetail` into the stock slider's range; junk reads as 1. */
export function environmentDetailScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(ENVIRONMENT_DETAIL_MAX, Math.max(ENVIRONMENT_DETAIL_MIN, value));
}

/**
 * The size-scaled draw leash of a loose outdoor M2, or undefined when its size is unknown.
 *
 * Size is the placement's source vertex radius around its origin times its scale — the same
 * conservative sphere cold admission already culls with. Rigged and emitter models publish no
 * radius and keep the legacy name-based leash instead. Distance stays horizontal from the
 * player, like every other leash here, so flying height never pushes the ground's trees out.
 */
export function environmentSceneryRange(object: EnvironmentObject, detail = 1): number | undefined {
  const radius = object.admissionRadius;
  if (object.kind !== "m2" || object.interior === true || radius === undefined
    || !Number.isFinite(radius) || radius < 0
    || !Number.isFinite(object.scale) || object.scale <= 0) return undefined;
  const sized = Math.min(ENVIRONMENT_SCENERY_MAX_RANGE,
    Math.max(ENVIRONMENT_SCENERY_MIN_RANGE, radius * object.scale * ENVIRONMENT_SCENERY_RANGE_PER_YARD));
  // The far leash is the streaming footprint's own limit (Terrain.ts ENVIRONMENT_STREAM_RANGE).
  return Math.min(ENVIRONMENT_FAR_RANGE, sized * environmentDetailScale(detail));
}

/**
 * How far a placement is drawn from the player, horizontally: rooms 60 (400 for the doodads of an
 * interior-only WMO, whose rooms then decide), big WMO shells 750, sized M2 scenery by
 * {@link environmentSceneryRange}, and everything else the legacy name-based leash (vegetation 600,
 * else 400). The detail multiplier scales M2s only.
 */
export function environmentDrawRange(object: EnvironmentObject, detail = 1): number {
  if (object.interior === true) {
    return interiorOnlyDoodadShown(object) === undefined ? INTERIOR_RANGE : INTERIOR_ONLY_RANGE;
  }
  if (environmentFarEligible(object)) return ENVIRONMENT_FAR_RANGE;
  const legacy = environmentVegetation(object) ? ENVIRONMENT_VEGETATION_RANGE : ENVIRONMENT_RANGE;
  if (object.kind !== "m2") return legacy;
  const sized = environmentSceneryRange(object, detail);
  if (sized !== undefined) return sized;
  return Math.min(ENVIRONMENT_FAR_RANGE, legacy * environmentDetailScale(detail));
}

/** A retained static model's already-transformed scene-space visibility sphere. */
export interface EnvironmentVisibilitySphere {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

/** A static M2's source vertex sphere before its mesh or retained bounds have been built. */
export function environmentSourceVisibilitySphere(
  object: EnvironmentObject,
  vertexPadding = 0,
): EnvironmentVisibilitySphere | undefined {
  const radius = object.admissionRadius;
  if (object.kind !== "m2" || object.interior === true || radius === undefined
    || !Number.isFinite(radius) || radius < 0
    || !Number.isFinite(vertexPadding) || vertexPadding < 0
    || !Number.isFinite(object.scale) || object.scale <= 0) return undefined;
  const scaled = (radius + vertexPadding) * object.scale;
  if (!Number.isFinite(scaled) || !Number.isFinite(object.x)
    || !Number.isFinite(object.y) || !Number.isFinite(object.z)) return undefined;
  return { x: object.x, y: object.z, z: -object.y, radius: scaled };
}

/**
 * Extra yards past each draw leash before a resident is released.
 *
 * Load distances and unload distances must differ, or a player standing on the boundary
 * loads and unloads the same placements every frame. Draw admission keeps the strict leash;
 * disposal uses this wider one, so the boundary an object crosses to appear is not the
 * boundary it crosses to disappear. Memory stays bounded by the warm LRU budgets.
 */
export { ENVIRONMENT_RESIDENT_HYSTERESIS };

/**
 * Per-frame model prefetch scan: how many candidates are examined for warming.
 *
 * A full sweep of a dense tile set takes seconds, which is fine — prefetch is a background
 * warming, not admission. Frustum turns are covered because the sweep is position-circular:
 * whatever the camera faces next was likely touched recently.
 */
const ENVIRONMENT_PREFETCH_SCAN = 256;
/** Model requests issued per frame by the prefetch sweep. The background lane absorbs them. */
const ENVIRONMENT_PREFETCH_BUDGET = 32;

/**
 * Exact distance residents in source order, before visibility and the three draw quotas.
 *
 * Keeping this answer unbudgeted is what lets a camera turn replace hidden near objects with
 * visible farther ones without rescanning every loaded tile or performing a resource lookup.
 */
export function environmentCandidatesInRange(
  objects: readonly EnvironmentObject[],
  player: Pick<WorldPosition, "x" | "y">,
  detail = 1,
): RankedEnvironmentObject[] {
  const candidates: RankedEnvironmentObject[] = [];
  // Indexed: the footprint is tens of thousands of placements, and an iterator result per
  // element is measurable garbage on every reselection.
  for (let index = 0; index < objects.length; index++) {
    const object = objects[index]!;
    const distance = placementDistance(object, player);
    const range = environmentDrawRange(object, detail);
    if (distance < range) candidates.push({ object, distance, range });
  }
  return candidates;
}

/**
 * Residents: the loaded zone. Same shape as the draw candidates, but every leash is widened
 * by {@link ENVIRONMENT_RESIDENT_HYSTERESIS}.
 *
 * Disposal — and only disposal — reads this set. An object between the draw leash and this one
 * is invisible but fully retained: models stay resolved, nodes stay built, and a turn back
 * flips visibility with no fetch, no build, no grow-in. This is the architectural split the
 * turn pop-in needed: frustum and budget decide what is *drawn*, position decides what is
 * *kept*, and the two boundaries never coincide.
 */
export function environmentResidentsInRange(
  objects: readonly EnvironmentObject[],
  player: Pick<WorldPosition, "x" | "y">,
  detail = 1,
): RankedEnvironmentObject[] {
  const residents: RankedEnvironmentObject[] = [];
  for (let index = 0; index < objects.length; index++) {
    const object = objects[index]!;
    const distance = placementDistance(object, player);
    const range = environmentDrawRange(object, detail);
    if (distance < range + ENVIRONMENT_RESIDENT_HYSTERESIS) residents.push({ object, distance, range });
  }
  return residents;
}

/**
 * Wrapped angular distance between two camera angles, in radians.
 *
 * Pure so the flick detector stays testable without a renderer: ±π wraparound must not read a
 * teleport behind the camera as a full turn, nor a full turn as standing still.
 */
export function cameraAngleDelta(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const delta = Math.abs(to - from) % (Math.PI * 2);
  return delta > Math.PI ? Math.PI * 2 - delta : delta;
}

/** Diagonal of a wire box in yards, or undefined when the box is missing or malformed. */
export function environmentBoundsDiagonal(bounds: EnvironmentObject["bounds"]): number | undefined {
  if (!bounds) return undefined;
  const dx = bounds.maxX - bounds.minX;
  const dy = bounds.maxY - bounds.minY;
  const dz = bounds.maxZ - bounds.minZ;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)
    || dx < 0 || dy < 0 || dz < 0) return undefined;
  return Math.hypot(dx, dy, dz);
}

/**
 * Model names worth warming this frame, picked position-circularly rather than by visibility.
 *
 * The admitted loop fetches only what the camera faces *now*; a turn would cold-fetch the rest.
 * This sweep touches near placements the camera is not facing so their models are resolving or
 * resolved before the turn reveals them. It never builds nodes, materials or textures — only the
 * client's background-lane model queue, which dedupes by key, promotes to critical on real
 * demand, and stays bounded by its own limits. Far shells are excluded deliberately: a 26 MB
 * city model is fetched when admitted, not speculatively.
 *
 * Pure in its inputs (candidates, content predicate, cursor) so turn simulations can drive it
 * without a renderer. The cursor rotates through source order; a changed candidate identity
 * must not restart it on movement, or a dense scene keeps warming only its first entries.
 */
export interface PrefetchScan {
  /** Model paths to request, deduplicated, in scan order. */
  names: string[];
  /** Cursor value for the next call. */
  nextCursor: number;
}

/** Small models warm before their draw leash; distant WMO shells still load on admission. */
export function environmentModelPrefetchEligible({ object, distance, range }: RankedEnvironmentObject): boolean {
  if (object.kind === "wmo" && distance > MODEL_RANGE) return false;
  // The leash the resident was ranked with (size- and detail-scaled for M2 scenery).
  return distance < (range ?? environmentDrawRange(object)) + ENVIRONMENT_RESIDENT_HYSTERESIS;
}

export function selectPrefetchModels(
  candidates: readonly RankedEnvironmentObject[],
  hasContent: (id: number) => boolean,
  cursor: number,
  scan = ENVIRONMENT_PREFETCH_SCAN,
  budget = ENVIRONMENT_PREFETCH_BUDGET,
): PrefetchScan {
  const total = candidates.length;
  if (total === 0 || budget <= 0 || scan <= 0) return { names: [], nextCursor: 0 };
  const start = ((Math.floor(cursor) % total) + total) % total;
  const end = start + Math.min(scan, total);
  const names: string[] = [];
  const seen = new Set<string>();
  let at = start;
  for (; at < end && names.length < budget; at++) {
    const candidate = candidates[at % total]!;
    const { object } = candidate;
    if (!environmentModelPrefetchEligible(candidate)) continue;
    if (hasContent(object.id)) continue;
    if (seen.has(object.name)) continue;
    seen.add(object.name);
    names.push(object.name);
  }
  return { names, nextCursor: at % total };
}

/**
 * Whether a placement earns the far leash: a big outdoor WMO, measured on its wire box.
 *
 * M2 placements carry no bounds, and small WMO doodads read as clutter past the near leash, so
 * both stay near. Interiors never go far: rooms are worth nothing until the player is at the door.
 */
export function environmentFarEligible(object: EnvironmentObject): boolean {
  if (object.kind !== "wmo" || object.interior === true) return false;
  const diagonal = environmentBoundsDiagonal(object.bounds);
  return diagonal !== undefined && diagonal >= ENVIRONMENT_FAR_MIN_DIAGONAL;
}

const vegetationKindCache = new WeakMap<EnvironmentObject, boolean>();

/**
 * Whether a placement is vegetation, for the grow-in leash.
 *
 * Name-matched like the tree stand-in, and cached per placement snapshot: the range pass runs on
 * every reselect over tens of thousands of placements, and a regex each would be its own profile
 * entry. Tile reloads hand over new snapshot objects, so the cache cannot go stale.
 */
export function environmentVegetation(object: EnvironmentObject): boolean {
  if (object.interior === true) return false;
  let known = vegetationKindCache.get(object);
  if (known === undefined) {
    known = standInKind(object) === "tree";
    vegetationKindCache.set(object, known);
  }
  return known;
}

/**
 * Grow-in scale at `serial`: `VEGETATION_GROWTH_FROM` to 1, ease-out cubic.
 *
 * Pure in submission serials rather than wall time so a hitch does not fast-forward the growth:
 * serials only advance on frames that actually submitted.
 */
export function vegetationGrowthScale(startedAt: number, serial: number, span = VEGETATION_GROWTH_FRAMES): number {
  const window = span > 0 && Number.isFinite(span) ? span : VEGETATION_GROWTH_FRAMES;
  const t = Math.max(0, Math.min(1, (serial - startedAt) / window));
  const eased = 1 - (1 - t) * (1 - t) * (1 - t);
  return VEGETATION_GROWTH_FROM + (1 - VEGETATION_GROWTH_FROM) * eased;
}

/**
 * Conservative allocation-free placement/frustum test over data already held by the renderer.
 *
 * WMO wire bounds are world AABBs and map to scene `(x, z, -y)`. Ordinary M2 placements do not
 * carry those bounds, so an exact retained static sphere may refine them on later frames. Missing,
 * inverted, malformed or overflowed inputs fail open; this predicate never resolves a model.
 */
export function environmentObjectVisibleInFrustum(
  object: EnvironmentObject,
  planes: readonly UnitFrustumPlane[],
  margin = ENVIRONMENT_FRUSTUM_MARGIN,
  retainedSphere?: EnvironmentVisibilitySphere,
): boolean {
  if (!Number.isFinite(margin) || margin < 0 || planes.length === 0) return true;
  // Validate every plane first: a malformed later plane must not let an earlier one false-negative.
  for (let index = 0; index < planes.length; index++) {
    const plane = planes[index];
    if (!plane) return true;
    const { x: nx, y: ny, z: nz } = plane.normal;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)
      || !Number.isFinite(plane.constant)) return true;
    const normalLengthSquared = nx * nx + ny * ny + nz * nz;
    if (!(normalLengthSquared > 0) || !Number.isFinite(normalLengthSquared)) return true;
  }

  const bounds = object.bounds;
  if (bounds === undefined) {
    if (!retainedSphere) return true;
    return unitSphereVisibleInFrustum(
      retainedSphere.x,
      retainedSphere.y,
      retainedSphere.z,
      retainedSphere.radius,
      planes,
      margin,
    );
  }
  const { minX, minY, minZ, maxX, maxY, maxZ } = bounds;
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)
    || !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)
    || minX > maxX || minY > maxY || minZ > maxZ) return true;

  // Scene bounds: x=[minX,maxX], y=[minZ,maxZ], z=[-maxY,-minY]. The positive vertex is the
  // point furthest along the plane normal; if even it is outside, the complete AABB is outside.
  for (let index = 0; index < planes.length; index++) {
    const plane = planes[index]!;
    const { x: nx, y: ny, z: nz } = plane.normal;
    const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const x = nx >= 0 ? maxX : minX;
    const y = ny >= 0 ? maxZ : minZ;
    const z = nz >= 0 ? -minY : -maxY;
    const distance = nx * x + ny * y + nz * z + plane.constant;
    if (!Number.isFinite(distance)) return true;
    if (distance < -margin * normalLength) return false;
  }
  return true;
}

/** Which admission quota a candidate competes in. */
type EnvironmentAdmissionTier = "near" | "scenery" | "far" | "interior";

function environmentAdmissionTier({ object, distance }: RankedEnvironmentObject): EnvironmentAdmissionTier | undefined {
  // An interior-only building's doodad is admitted while one of its MODR rooms is shown: the
  // room answer moves with the camera every frame, the 400-yard candidate list does not.
  if (object.interior === true) {
    return distance > ENVIRONMENT_RANGE || interiorOnlyDoodadShown(object) === false ? undefined : "interior";
  }
  // Loose outdoor M2s are one quota at every distance: their own size already set the leash.
  if (object.kind === "m2") return "scenery";
  if (distance <= ENVIRONMENT_RANGE) return "near";
  // The far tier is its own quota: nearest-first over a merged list would spend the whole near
  // budget before a castle 500 yards out ever got a slot.
  return environmentFarEligible(object) || environmentVegetation(object) ? "far" : undefined;
}

/**
 * Share of its own leash a scenery candidate has used up: 0 at the player, 1 at the leash.
 * Ranking by it makes an overloaded quota shed the far-for-its-size first — a canopy tree at
 * 500 yards outranks a pebble at 80 — which reads as a lower detail setting, not as a hole.
 */
function environmentSceneryScore({ object, distance, range }: RankedEnvironmentObject): number {
  const leash = range ?? environmentDrawRange(object);
  return leash > 0 && Number.isFinite(leash) ? distance / leash : distance;
}

/**
 * Visibility first, then independent stable quotas: near WMOs, loose M2 scenery, far WMO shells
 * and interiors. Everything but scenery is nearest-first.
 */
export function selectEnvironmentAdmission(
  candidates: readonly RankedEnvironmentObject[],
  planes: readonly UnitFrustumPlane[],
  retainedSphereOf?: (object: EnvironmentObject) => EnvironmentVisibilitySphere | undefined,
  vertexPadding = 0,
): RankedEnvironmentObject[] {
  const pick = (tier: EnvironmentAdmissionTier, budget: number,
    score: (candidate: RankedEnvironmentObject) => number): RankedEnvironmentObject[] => {
    const eligible = (candidate: RankedEnvironmentObject): boolean => {
      if (environmentAdmissionTier(candidate) !== tier) return false;
      // A hand-built list is held to the same strict leash the candidate pass applies.
      if (tier === "scenery" && candidate.distance >= (candidate.range ?? environmentDrawRange(candidate.object))) {
        return false;
      }
      const retainedSphere = candidate.object.bounds === undefined
        ? retainedSphereOf?.(candidate.object)
          ?? environmentSourceVisibilitySphere(candidate.object, vertexPadding)
        : undefined;
      return environmentObjectVisibleInFrustum(
        candidate.object,
        planes,
        ENVIRONMENT_FRUSTUM_MARGIN,
        retainedSphere,
      );
    };
    return stableBoundedTopKWhere(candidates, eligible, budget, score);
  };
  const nearest = ({ distance }: RankedEnvironmentObject) => distance;
  return [
    ...pick("near", ENVIRONMENT_BUDGET, nearest),
    ...pick("scenery", ENVIRONMENT_SCENERY_BUDGET, environmentSceneryScore),
    ...pick("far", ENVIRONMENT_FAR_BUDGET, nearest),
    ...pick("interior", INTERIOR_BUDGET, nearest),
  ];
}

/**
 * Which of a tile's placements are drawn this frame, nearest first.
 *
 * Two budgets, not one. A tile's WMO doodads outnumber everything standing on the ground by five
 * to one — the Goldshire tile holds 1,302 terrain placements against 6,638 of them — and they all
 * sit clustered inside the buildings, so ranking the merged set by distance spent the entire
 * allowance on the inn's cutlery: standing at the Lion's Pride, the 320th nearest object was
 * 39.5 m away and nine in ten of them were utensils, jars, bottles and book stacks. Every tree
 * and both buildings lost their draw call to a fork. Elwynn was bare while Dun Morogh, which has
 * almost no interiors, looked right — which is why it took this long to see. The 300-yard outer
 * leash now keeps those districts eligible from a ridge while the 320-object cap stays unchanged.
 */
export function selectEnvironment(objects: readonly EnvironmentObject[], player: WorldPosition): RankedEnvironmentObject[] {
  return selectEnvironmentAdmission(environmentCandidatesInRange(objects, player), []);
}

/**
 * How far the player is from a placement — from the building, not from the pin that placed it.
 *
 * A WMO is one placement point and a box that can be enormous. Stormwind's point sits near the
 * Valley of Heroes and its box is 1488 by 1488 yards, so measuring to the point put Old Town 260
 * metres away, the Mage Quarter 331, Cathedral Square 413 and the Dwarven District 508 — all of
 * them past the former 230-metre range, which is to say the city vanished as soon as a player
 * walked into it. Measured to the box, every one of them is zero: the player is standing inside the
 * building. The 300-metre leash now keeps the outer districts eligible from a ridge.
 *
 * Anything without a box is its own point, which is what a tree is.
 */
export function placementDistance(object: EnvironmentObject, player: Pick<WorldPosition, "x" | "y">): number {
  const bounds = object.bounds;
  // `hypot2` is `Math.hypot` double for double, without the 80 bytes the builtin allocates per
  // call: this runs for every placement of the footprint on every reselection.
  if (!bounds) return hypot2(object.x - player.x, object.y - player.y);
  const outsideX = Math.max(bounds.minX - player.x, 0, player.x - bounds.maxX);
  const outsideY = Math.max(bounds.minY - player.y, 0, player.y - bounds.maxY);
  return hypot2(outsideX, outsideY);
}

/**
 * Where each of a building's rooms stands in the scene.
 *
 * Computed once when the building is placed, because a placement does not move: what changes from
 * frame to frame is the player. The corners go through the same permutation the group's vertices
 * do, so the box keeps its mesh.
 */
export function wmoGroupBoxes(model: WmoModel, object: EnvironmentObject): (THREE.Box3 | undefined)[] {
  const node = placeEnvironmentNode(new THREE.Group(), object);
  node.updateMatrixWorld(true);
  const corner = new THREE.Vector3();
  return model.groups.map((group) => {
    // Keep malformed source bounds explicitly untrusted. The corresponding distance pass treats
    // an absent box as visible rather than dropping valid geometry; portal and fog code also fail
    // open from the retained raw bounds.
    if (group.boundsValid === false || !validWmoBounds(group.bounds)) return undefined;
    const box = new THREE.Box3();
    for (const x of [group.bounds.minX, group.bounds.maxX]) {
      for (const y of [group.bounds.minY, group.bounds.maxY]) {
        for (const z of [group.bounds.minZ, group.bounds.maxZ]) {
          box.expandByPoint(corner.set(-x, z, y).applyMatrix4(node.matrixWorld));
        }
      }
    }
    return box;
  });
}

function validWmoBounds(bounds: WmoGroup["bounds"]): boolean {
  return Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.minZ)
    && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY) && Number.isFinite(bounds.maxZ)
    && bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY && bounds.minZ <= bounds.maxZ;
}

/**
 * Which of a building's rooms are worth drawing from where the player is standing.
 *
 * Interiors on a short leash and the outdoor shell on the long one, because the two answer
 * different questions: the shell is the city's skyline and has to be there from the ridge, while a
 * room is worth nothing until the player is at its door. Exterior and transition boundary runs
 * inside an indoor group widen that group's leash as one AABB; the box still caps the added work,
 * while a ridge outside the city continues to select only the outdoor shell. On the real
 * Stormwind corpus this changes the five district candidates to 68–108 groups and 203,371–304,158
 * triangles; the measured ridge remains one 20,639-triangle outdoor group. This remains the
 * authoritative fallback
 * and the candidate ceiling. `WmoOcclusion` may refine it only from a confirmed indoor group; old
 * artifacts, open air, invalid graphs and the 14 Stormwind groups with no portals keep this answer.
 * `roomRange` is the room leash: sixty yards, or `INTERIOR_ONLY_RANGE` once the camera or the
 * player stands in a building of rooms alone, where the portals then decide.
 */
export function wmoGroupsInRange(
  model: WmoModel,
  boxes: readonly (THREE.Box3 | undefined)[],
  player: WorldPosition,
  roomRange = INTERIOR_RANGE,
): number[] {
  const x = player.x;
  const z = -player.y;
  const chosen: number[] = [];
  for (const [index, group] of model.groups.entries()) {
    const box = boxes[index];
    if (group.triangleCount === 0) continue;
    // No trustworthy AABB is conservative evidence that this non-empty group may be visible.
    if (!box) {
      chosen.push(index);
      continue;
    }
    // MOGP's indoor bit describes the room, not every triangle in it. Exterior and transition runs
    // are commonly its outward wall/door seam; keeping those on the interior leash creates holes
    // beside nearby towers. The box is still this group's AABB, so the longer range never grows to
    // the whole WMO. Groups wide enough to read as skyline hold the far leash with the placement
    // that earned it; small exterior bits keep the near one.
    const range = group.exterior || !group.indoor
      ? wmoShellRange(box)
      : roomRange;
    const outsideX = Math.max(box.min.x - x, 0, x - box.max.x);
    const outsideZ = Math.max(box.min.z - z, 0, z - box.max.z);
    if (Math.hypot(outsideX, outsideZ) < range) chosen.push(index);
  }
  return chosen;
}

/** Outdoor shell leash by group width: skyline holds far, small bits stay near. */
export function wmoShellRange(box: THREE.Box3): number {
  const dx = box.max.x - box.min.x;
  const dy = box.max.y - box.min.y;
  const dz = box.max.z - box.min.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)
    || dx < 0 || dy < 0 || dz < 0) return WMO_EXTERIOR_RANGE;
  return Math.hypot(dx, dy, dz) >= WMO_SHELL_FAR_MIN_DIAGONAL ? WMO_SHELL_FAR_RANGE : WMO_EXTERIOR_RANGE;
}

/**
 * Puts a built model where the tile says it stands.
 *
 * Its own function because there are two ways to build the mesh — the WVM5 path with the client's
 * own materials, and the older one — and only the second used to reach the placement at the end of
 * the method. The first returned early, so every M2 doodad in the world was built correctly and
 * then drawn at the map's origin, unrotated and unscaled: Elwynn's trees, fences and signposts
 * were not missing, they were all standing in a heap in the middle of the Eastern Kingdoms. WMOs
 * kept working because buildings still go through the older path.
 */
export function placeEnvironmentNode(node: THREE.Object3D, object: EnvironmentObject): THREE.Object3D {
  node.position.set(object.x, object.z, -object.y);
  if (object.quaternionX !== undefined && object.quaternionY !== undefined && object.quaternionZ !== undefined && object.quaternionW !== undefined) {
    node.quaternion.set(object.quaternionX, object.quaternionY, object.quaternionZ, object.quaternionW).normalize();
  } else node.quaternion.setFromRotationMatrix(mappedVmapRotation(object.rotationX, object.rotationY, object.rotationZ));
  node.scale.setScalar(object.scale);
  return node;
}

/**
 * What a placement with no model of its own is drawn as while it waits for one.
 *
 * Two answers. A name that reads as vegetation gets a trunk and a canopy, because that is what it
 * is about to become. Every other placement gets **nothing**: a generic cone is loader state, not
 * world art, and on a cold cache dozens of them used to flash between the terrain and real models.
 * A placement carrying `bounds` is the especially expensive case: `bounds` is the MODF extents
 * record, which `tools/adt-placements.mjs` writes for WMO placements and for nothing else, so that
 * branch only ever ran for buildings — and it filled the whole extents box with one flat fallback
 * mesh, the least saturated large shape this renderer can draw (S=10.3%, against the
 * missing-texture green's 16.8%). That is the grey cube the player reported standing in Orgrimmar.
 *
 * Measured over Orgrimmar's four tiles: 3,131 placements, exactly 6 carrying bounds, all six WMOs.
 * The two visible from outside are the city itself — 1,270 × 1,406 × 269 yards, in range from
 * 100% of the lattice points over those tiles and with the camera outside it on the whole Durotar
 * approach — and Ragefire's cave mouth, 35 yards from the Cleft of Shadow. The smallest of the six
 * is 37.5 × 36.4 × 22.7 yards, so no size cap tells a house from a hut here: the answer is none.
 *
 * An empty node while the model is on its way is honest; a grey house is not, and before the
 * `/visual/model` retry ladder in this same slice one failed request left it standing for the life
 * of the tab. The placement is still ranked, and still swapped for the real building when it lands.
 *
 * Exported and pure so the six real MODF boxes can be driven through it without a WebGL context,
 * the way `selectEnvironment` and `placementDistance` already are.
 */
export function standInKind(object: EnvironmentObject): "tree" | "none" {
  if (/tree|oak|pine|willow|bush|shrub/i.test(object.name)) return "tree";
  return "none";
}

/**
 * Whether one unit node may be shown on this frame.
 *
 * `UNIT_FLAG_UNINTERACTIBLE` marks spell triggers, aura anchors and quest bunnies that the server
 * expects to stand invisibly. Suppress only our capsule stand-in: if such a unit has authored art,
 * `#clearUnitNode` removes `body` and the model remains visible. The player is never hidden by a
 * transient flag, while first person still hides their real body as before.
 */
export function unitContentVisible(
  object: WorldObjectState,
  self: boolean,
  firstPerson: boolean,
  standIn: boolean,
): boolean {
  if (self && firstPerson) return false;
  if (!standIn || self) return true;
  return ((unitFields.flags(object) ?? 0) & UNIT_FLAG_UNINTERACTIBLE) === 0;
}

/**
 * How large the server says this unit is, on top of the size its display record asks for.
 *
 * `OBJECT_FIELD_SCALE_X` had exactly two readers in this client — `#updateGameObjects` below and
 * the player's own collision height (`input/Movement.ts:220`) — so every unit was drawn at
 * `CreatureDisplayInfo.CreatureModelScale` alone. That is not the size: the server writes this
 * field from `Unit::RecalculateObjectScale` (`Unit.cpp:11127-11133`), and it carries
 * `creature_template.scale` (`Creature::GetNativeObjectScale`, `Creature.cpp:3443-3446`), every
 * hunter pet's per-level `CreatureFamily` scale (`Pet.cpp:2010-2027`) and every scale aura on top.
 * Measured: 78 of 29 923 `creature_template` rows carry a scale other than 1 (0,40…9,86); 39 of
 * the 40 rows of `CreatureFamily.dbc` carry `MinScale > 0`, and the two columns are two ranges —
 * `MinScale` 0,30…1,00, `MaxScale` 0,50…1,40 — so a pet's drawn size runs from a level-1
 * devilsaur's 0,30 to a level-60 crab's 1,40. Every hunter pet below its `MaxScaleLevel` was the
 * wrong size; at or above it `Pet::GetNativeObjectScale` returns `MaxScale` flat, and seven hunter
 * families carry exactly 1,0 there — wolf, bear, boar, gorilla, scorpid, silithid, worm, all at
 * level 60 — which is the size they already had. And 527 of 49 842 rows of `Spell.dbc` carry
 * `SPELL_AURA_MOD_SCALE` (61, in 517 effect slots) or `SPELL_AURA_MOD_SCALE_2` (239, in 10),
 * the two ids being the core's own (`SpellAuraDefines.h:141` and `:319`).
 *
 * The floor is the core's own and not the game object's 0,05: `scaleMin = TYPEID_PLAYER ? 0.1 :
 * 0.01`. There is no ceiling, in the core or here — `Object::SetObjectScale` (`Object.h:96`) writes
 * whatever it is handed, and a cap of our own would draw a boss smaller than the server's collision
 * says it is. A field that has not arrived, or a zero, is one.
 */
export function unitObjectScale(object: WorldObjectState): number {
  const scale = fieldFloat(object, UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset);
  if (scale === undefined || !(scale > 0)) return 1;
  return Math.max(object.typeId === 4 ? 0.1 : 0.01, scale);
}

const PLAYER_VISIBLE_ITEM_STRIDE = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset
  - UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const PLAYER_HEAD_ITEM = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const PLAYER_SHOULDER_ITEM = PLAYER_HEAD_ITEM + 2 * PLAYER_VISIBLE_ITEM_STRIDE;
const PLAYER_MAIN_HAND_ITEM = PLAYER_HEAD_ITEM + 15 * PLAYER_VISIBLE_ITEM_STRIDE;
const PLAYER_OFF_HAND_ITEM = PLAYER_HEAD_ITEM + 16 * PLAYER_VISIBLE_ITEM_STRIDE;
const PLAYER_RANGED_ITEM = PLAYER_HEAD_ITEM + 17 * PLAYER_VISIBLE_ITEM_STRIDE;

/** Whether raw wire fields already require a silhouette beyond a retained unit's body WVM. */
export function unitWireHasCompositeSilhouette(object: WorldObjectState): boolean {
  const mountDisplayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset) ?? 0;
  if (mountDisplayId !== 0) return true;
  if (object.typeId !== 4) return false;
  return (object.fields.get(PLAYER_HEAD_ITEM) ?? 0) !== 0
    || (object.fields.get(PLAYER_SHOULDER_ITEM) ?? 0) !== 0
    || (object.fields.get(PLAYER_MAIN_HAND_ITEM) ?? 0) !== 0
    || (object.fields.get(PLAYER_OFF_HAND_ITEM) ?? 0) !== 0
    || (object.fields.get(PLAYER_RANGED_ITEM) ?? 0) !== 0;
}

/** Moving game-object types cannot use a placement-local static silhouette. */
export function gameObjectWireIsMovingTransport(
  object: Pick<WorldObjectState, "fields">,
): boolean {
  const bytes = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset);
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return false;
  const type = (bytes >>> 8) & 0xff;
  return type === GO_TYPE_TRANSPORT || type === GO_TYPE_MO_TRANSPORT;
}

/** A retained static game-object sphere in model space, before the placement scale is applied. */
export interface GameObjectRestSphere {
  readonly center: Readonly<{ x: number; y: number; z: number }>;
  readonly radius: number;
}

/** Conservative origin-centred radius for a static game-object model. */
export function conservativeGameObjectVisibilityRadius(
  bounds: GameObjectRestSphere,
  drawnScale: number,
): number | undefined {
  return conservativeGameObjectVisibilityRadiusValues(
    bounds.center.x, bounds.center.y, bounds.center.z, bounds.radius, drawnScale);
}

/** Allocation-free scalar form for the per-candidate static game-object hot path. */
export function conservativeGameObjectVisibilityRadiusValues(
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  drawnScale: number,
): number | undefined {
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(centerZ)
    || !Number.isFinite(radius) || !Number.isFinite(drawnScale)
    || radius < 0 || !(drawnScale > 0)) return undefined;
  const result = (Math.hypot(centerX, centerY, centerZ) + radius) * drawnScale;
  return Number.isFinite(result) ? result : undefined;
}

/** Structural sphere data read from an already-built geometry without allocating Three.js objects. */
export interface UnitRestSphere {
  readonly center: Readonly<{ x: number; y: number; z: number }>;
  readonly radius: number;
}

/**
 * An origin-centred sphere enclosing both authored and currently measured unit silhouettes.
 *
 * Undefined means the admission pass must fail open. M2-to-scene and facing are rotations around
 * the origin, so enclosing the model there keeps this conservative without per-unit transforms.
 */
export function conservativeUnitVisibilityRadius(
  bounds: Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number]; radius: number }>,
  builtSphere: UnitRestSphere,
  drawnScale: number,
  currentHeight: number,
): number | undefined {
  const minX = bounds.min[0];
  const minY = bounds.min[1];
  const minZ = bounds.min[2];
  const maxX = bounds.max[0];
  const maxY = bounds.max[1];
  const maxZ = bounds.max[2];
  const headerRadius = bounds.radius;
  const builtX = builtSphere.center.x;
  const builtY = builtSphere.center.y;
  const builtZ = builtSphere.center.z;
  const builtRestRadius = builtSphere.radius;
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)
    || !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)
    || !Number.isFinite(headerRadius)
    || !Number.isFinite(builtX) || !Number.isFinite(builtY) || !Number.isFinite(builtZ)
    || !Number.isFinite(builtRestRadius) || !Number.isFinite(drawnScale) || !Number.isFinite(currentHeight)
    || minX > maxX || minY > maxY || minZ > maxZ
    || headerRadius < 0 || builtRestRadius < 0 || !(drawnScale > 0) || !(currentHeight > 0)) {
    return undefined;
  }
  const cornerX = Math.max(Math.abs(minX), Math.abs(maxX));
  const cornerY = Math.max(Math.abs(minY), Math.abs(maxY));
  const cornerZ = Math.max(Math.abs(minZ), Math.abs(maxZ));
  const cornerRadius = Math.sqrt(cornerX * cornerX + cornerY * cornerY + cornerZ * cornerZ);
  const builtRadius = Math.sqrt(builtX * builtX + builtY * builtY + builtZ * builtZ) + builtRestRadius;
  const radius = Math.max(cornerRadius, headerRadius, builtRadius) * drawnScale;
  const conservative = Math.max(radius, currentHeight);
  return Number.isFinite(conservative) ? conservative : undefined;
}

/**
 * How far past the body's own conservative sphere hanging gear can reach, in yards at scale 1: a
 * two-hander held out at arm's length, a guard's spear, a pauldron's spikes. Measured against the
 * client's item models, the longest weapons are under three yards; one more yard is margin.
 */
export const UNIT_GEAR_SILHOUETTE_ALLOWANCE = 4;

/** The mount a rider sits on, measured the way the body is: its own conservative sphere and its saddle height. */
export interface CompositeUnitMount {
  /** `conservativeUnitVisibilityRadius` of the mount at its own scale. */
  readonly radius: number;
  /** How high the saddle is above the mount's feet, at scale. */
  readonly seat: number;
}

/**
 * The sphere that encloses a body together with what is hanging off it and what it rides.
 *
 * A rider's sphere is the body's, lifted by the saddle; the mount's is its own; the unit is
 * inside the larger of the two. Gear adds a fixed reach, scaled with the unit, because it is
 * attached to bones that already lie inside the body's bounds. Anything non-finite fails open
 * (undefined) like the body's own radius does.
 */
export function compositeUnitVisibilityRadius(
  body: number,
  unitScale: number,
  gear: boolean,
  mount: CompositeUnitMount | undefined,
): number | undefined {
  if (!Number.isFinite(body) || body < 0 || !Number.isFinite(unitScale) || !(unitScale > 0)) return undefined;
  let radius = body;
  if (mount) {
    if (!Number.isFinite(mount.radius) || mount.radius < 0 || !Number.isFinite(mount.seat) || mount.seat < 0) {
      return undefined;
    }
    radius = Math.max(mount.radius, body + mount.seat);
  }
  if (gear) radius += UNIT_GEAR_SILHOUETTE_ALLOWANCE * Math.max(1, unitScale);
  return Number.isFinite(radius) ? radius : undefined;
}

/** Plane data needed for a numeric sphere/frustum test. */
export interface UnitFrustumPlane {
  readonly normal: Readonly<{ x: number; y: number; z: number }>;
  readonly constant: number;
}

/** Numeric, allocation-free sphere test; malformed camera/sphere data deliberately fails open. */
export function unitSphereVisibleInFrustum(
  x: number,
  y: number,
  z: number,
  radius: number,
  planes: readonly UnitFrustumPlane[],
  margin: number,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
    || !Number.isFinite(radius) || !Number.isFinite(margin)
    || radius < 0 || margin < 0 || planes.length === 0) {
    return true;
  }
  // Validate every plane first: one malformed later plane must fail open even when an earlier
  // valid plane would reject the sphere.
  for (let index = 0; index < planes.length; index++) {
    const plane = planes[index];
    if (!plane) return true;
    const { x: nx, y: ny, z: nz } = plane.normal;
    const constant = plane.constant;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)
      || !Number.isFinite(constant)) return true;
    const normalLengthSquared = nx * nx + ny * ny + nz * nz;
    if (!(normalLengthSquared > 0) || !Number.isFinite(normalLengthSquared)) return true;
  }
  for (let index = 0; index < planes.length; index++) {
    const plane = planes[index];
    if (!plane) return true;
    const { x: nx, y: ny, z: nz } = plane.normal;
    const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const distance = nx * x + ny * y + nz * z + plane.constant;
    if (!Number.isFinite(distance)) return true;
    if (distance < -(radius + margin) * normalLength) return false;
  }
  return true;
}

/**
 * Whether the mount already under a rider represents the display record that is on the wire now.
 *
 * The build cache deliberately ignores display id: two horse colours that name the same M2 and
 * texture slots should share geometry. The instance cannot. CreatureDisplayInfo rows sharing that
 * build may carry different scale or `MountHeight`; a direct mount/taxi/vehicle swap must therefore
 * rebuild the instance even when `modelKey` is unchanged. Keeping the comparison pure gives that
 * distinction a regression test without constructing a WebGL renderer.
 */
export function mountInstanceMatches(
  current: Pick<UnitModel, "id" | "model" | "textures" | "scale" | "mountHeight"> | undefined,
  next: Pick<UnitModel, "id" | "model" | "textures" | "scale" | "mountHeight">,
): boolean {
  return current !== undefined
    && current.id === next.id
    && current.scale === next.scale
    && current.mountHeight === next.mountHeight
    && modelKey(current.model, current.textures) === modelKey(next.model, next.textures);
}

/**
 * Whether a model that has arrived is worth putting on the screen.
 *
 * `EnvironmentClient` answers with two quite different things under one type. A `/visual/model`
 * artifact is a model: `wvm` for an M2, `wmo` for a building, `visual: true` on both and on the
 * older shapes. What `Terrain.#loadModel`'s `/environment/model/<basename>` fallback answers with
 * is the *server's* vmap collision hull — bare vertices and indices, no textures, no groups, no
 * flag — and drawing it is drawing a building's shadow: one flat untextured mesh in whatever
 * colour `#material` picks from the file's name.
 *
 * Exported, and one function rather than a line in each caller, because the two callers must not
 * disagree: `#buildGameObject` has had this guard since «серые коробки больше не рисуются вовсе»
 * and the environment path was still drawing every hull that came back.
 */
export function legacyVisualHasRenderableMaterial(model: EnvironmentModel): boolean {
  // `visual` is the decoder contract: every WVM1/2/3 visual artifact sets it, whereas the
  // `/environment/model` collision fallback never does. Do not use texture presence as the trust
  // boundary. The legacy generator explicitly permits an unresolved/absent material and renders
  // that authored group in its flat fallback colour; requiring every URL would hide the whole model.
  return model.visual === true && model.vertices.length >= 9 && model.indices.length >= 3;
}

export function drawableModel(model: EnvironmentModel | undefined): model is EnvironmentModel {
  return model !== undefined
    && (model.wvm !== undefined || model.wmo !== undefined || legacyVisualHasRenderableMaterial(model));
}

/**
 * Whether a placement can be drawn as one of many copies of a single mesh.
 *
 * Three things disqualify one, and only the third is subtle. A building is drawn a room at a time
 * and has no single mesh at all. A stand-in shape is not the model. And a model that carries
 * emitters must keep its own object: `#updateEffects` places a torch's sparks by reading the world
 * matrix of the mesh that holds the torch, and an instance has no object to read — the sparks
 * would all be left standing at the map's origin.
 *
 * Measured on this client's baked artifacts, seven of 148 models carry any emitter at all.
 */
export function instanceable(model: { wvm?: WvmModel | undefined; wmo?: unknown } | undefined): boolean {
  if (!model?.wvm || model.wmo) return false;
  return model.wvm.particleEmitters.length + model.wvm.ribbonEmitters.length === 0;
}

/**
 * And whether what was built out of it can be, which is a different question.
 *
 * A transparent material has to be drawn back to front, and three sorts *objects* — so a hundred
 * copies that used to be a hundred entries in that sorted list become one, and the copies stop
 * being ordered among themselves. A blended doodad drawn in buffer order shows through the one in
 * front of it. Opaque and alpha-tested runs do not care: their order is a hint about overdraw and
 * nothing else.
 */
export function instanceableBuild(materials: THREE.Material | readonly THREE.Material[]): boolean {
  const list = Array.isArray(materials) ? materials : [materials as THREE.Material];
  return list.every((material) => !material.transparent);
}

/**
 * How large to make an instanced draw for this many copies.
 *
 * `InstancedMesh` fixes its capacity when it is built, so growing in powers of two is what stops
 * one more barrel walking into range from rebuilding the buffer. Never below two, because below
 * two there is nothing to instance.
 */
export function instanceCapacity(count: number): number {
  const wanted = Math.max(INSTANCE_MINIMUM, Math.ceil(count));
  return 1 << Math.ceil(Math.log2(wanted));
}

/**
 * The camera the world is drawn through.
 *
 * A function rather than a `new` in the field list so that what it is built with can be asserted
 * about: the far plane was raised to `HORIZON_FAR_PLANE` by slice R5, which imported the constant
 * into this file and never applied it, and the camera went on stopping at 900 yards while the
 * horizon reached 2,133. A test that only compares two constants cannot catch that.
 *
 * The near plane is what decides depth precision and not the far one — at 0.25 near, a point 800
 * yards out resolves to 0.153 yards either way whether the far plane is 900 or 4,000.
 */
export function buildWorldCamera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 16 / 9, WORLD_CAMERA_NEAR_PLANE, HORIZON_FAR_PLANE);
}

/** Named because the underwater crossing is measured in it and not only compiled into a camera. */
export const WORLD_CAMERA_NEAR_PLANE = 0.25;

/**
 * The crossing band of the world camera, for the callers that have to sample liquid before the
 * renderer sees it. The renderer re-derives it from its own camera, so the two cannot drift.
 */
export const UNDERWATER_CROSSING_BAND = underwaterCrossingBand(WORLD_CAMERA_NEAR_PLANE, CAMERA_FOV_DEGREES);

/**
 * How many segments a selection ring is drawn with.
 *
 * Forty-eight is where a ring of one to two yards stops looking like a polygon at the distance a
 * player actually stands from its target. The cost is ninety-six vertices rewritten per frame per
 * ring, of which there are at most two.
 */
export const SELECTION_RING_SEGMENTS = 48;
/** How far up or down the ring is allowed to follow the ground before it stops trying. */
export const SELECTION_RING_RELIEF = 1.5;

/**
 * The ring under a unit's feet: three concentric circles, the middle one opaque and the outer two
 * transparent, so the band has a soft edge without a texture to fetch.
 *
 * Positions are written every frame by `updateSelectionRing`; only the winding and the colours are
 * fixed, so the geometry is built once per ring and never rebuilt.
 */
export function buildSelectionRingGeometry(segments = SELECTION_RING_SEGMENTS): THREE.BufferGeometry {
  const rings = 3;
  const geometry = new THREE.BufferGeometry();
  const vertices = rings * (segments + 1);
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  const colours = new Float32Array(vertices * 4);
  for (let ring = 0; ring < rings; ring++) {
    for (let step = 0; step <= segments; step++) {
      const offset = (ring * (segments + 1) + step) * 4;
      colours[offset] = 1;
      colours[offset + 1] = 1;
      colours[offset + 2] = 1;
      colours[offset + 3] = ring === 1 ? 1 : 0;
    }
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 4));
  const indices: number[] = [];
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let step = 0; step < segments; step++) {
      const inner = ring * (segments + 1) + step;
      const outer = inner + segments + 1;
      indices.push(inner, outer, outer + 1, inner, outer + 1, inner + 1);
    }
  }
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Lays the ring on the ground the unit is standing on.
 *
 * The height field is sampled around the ring rather than at its centre, but what is taken from it
 * is the *difference* from the centre and not the height itself: indoors there is no height field
 * worth reading — a floor is collision geometry, and the sampler answers with the terrain far
 * below — so the ring hangs off the unit's own feet and only borrows the slope. On open ground the
 * two are the same number. The relief is clamped, because a unit standing on the lip of a cliff
 * would otherwise wear a ring with one side of it forty yards down.
 */
export function updateSelectionRing(
  geometry: THREE.BufferGeometry,
  centre: { x: number; y: number; z: number },
  radius: number,
  ground: HeightSampler | undefined,
  segments = SELECTION_RING_SEGMENTS,
): void {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const radii = [radius * 0.82, radius * 0.93, radius];
  const middle = ground?.(centre.x, centre.y);
  for (let ring = 0; ring < radii.length; ring++) {
    const reach = radii[ring] ?? radius;
    for (let step = 0; step <= segments; step++) {
      const angle = (step / segments) * Math.PI * 2;
      const x = centre.x + Math.cos(angle) * reach;
      const y = centre.y + Math.sin(angle) * reach;
      const here = middle === undefined ? undefined : ground?.(x, y);
      const relief = here === undefined || middle === undefined
        ? 0
        : Math.max(-SELECTION_RING_RELIEF, Math.min(SELECTION_RING_RELIEF, here - middle));
      const z = centre.z + relief + 0.08;
      position.setXYZ(ring * (segments + 1) + step, x, z, -y);
    }
  }
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
}

/**
 * Turns a built model node into a ghost, in place, and answers the shells it now owns.
 *
 * Every mesh's material is cloned before it is made translucent: the originals belong to the
 * shared built/world caches and are drawn by every ordinary placement of the same model. The
 * clones keep the same textures, which are not this owner's to release; only the clone itself is
 * disposed when the reticle leaves. A node with no drawable mesh answers nothing, and the caller
 * then shows no ghost at all rather than an empty one.
 */
function ghostModelMaterials(root: THREE.Object3D): THREE.Material[] {
  const clones: THREE.Material[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true || mesh.material === undefined) return;
    const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const copies = sources.map((source) => {
      const copy = source.clone();
      copy.transparent = true;
      copy.opacity = Math.min(0.55, Number.isFinite(source.opacity) ? source.opacity : 1);
      copy.depthWrite = false;
      copy.side = THREE.DoubleSide;
      clones.push(copy);
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? copies : copies[0]!;
  });
  return clones;
}

import {
  CharacterAtlasClient, appearanceKey, configureCharacterAtlasTexture,
  type CharacterAppearance, type CharacterAtlasResidencyStats,
} from "./CharacterAtlas.js";
import { PortraitRenderer, type PortraitSource, type PortraitSlot, type PortraitTarget } from "./PortraitRenderer.js";

interface RenderedEnvironment {
  actual: boolean;
  node: THREE.Object3D;
  /** `env:<id>`, the emitter set's key, built on the first frame that asks and kept. */
  effectKey?: string;
  /** Exact immutable placement snapshot represented by this retained node. */
  source: EnvironmentObject;
  /** Draw admission is separate from `node.visible`, which instancing may deliberately clear. */
  admitted: boolean;
  interior: boolean;
  /** Submission serial of the most recent admitted frame, used by the bounded hidden LRU. */
  lastAdmittedFrame: number;
  /** Conservative scene sphere stamped only for a static, emitter-free retained M2. */
  visibilitySphere?: EnvironmentVisibilitySphere;
  /** Exact cache entry borrowed by this placement, when it is a built WVM model. */
  built?: BuiltModel;
  /** Exact decoded legacy parent and resources borrowed by this retained placement. */
  decodedModel?: EnvironmentModel;
  legacyGeometry?: LegacyGeometryEntry;
  materialEntries?: readonly WorldMaterialEntry[];
  /** Per-placement material ids carrying immutable albedo or indoor-light state. */
  tintMaterials?: readonly THREE.Material[];
  /**
   * The mesh inside the node, whose world matrix is the model's own frame.
   *
   * The node is placed and turned; the mesh inside it additionally carries the rotation that maps
   * model space into the scene. An emitter's position is written in model space, so it is the
   * inner matrix it has to be transformed by and not the outer one.
   */
  visual?: THREE.Object3D;
  wvm?: WvmModel;
  /**
   * The model's own water, one mesh per liquid grid, standing in the scene rather than on the node.
   *
   * Not hung on the placement: three orders transparent objects by the origin of the object, and a
   * building's origin is one corner of it — Stormwind's is by the Valley of Heroes, a quarter of a
   * mile from the canals. A sheet of water hung there would sort against every other transparent
   * thing in the city as if it were at that corner. Each sheet is its own object centred on its own
   * water instead, which is what the tile's water gets for nothing by being a mesh per tile.
   */
  liquid?: THREE.Mesh[];
  /** The liquid-strip generation the sheets were built at, so a late strip rebuilds them. */
  liquidGeneration?: number;
  /** A WMO drawn room by room, with the boxes that decide which rooms those are. */
  wmo?: PlacedWmo;
  /**
   * Which built model this placement is a copy of, when it is one that can be instanced.
   *
   * Absent for a building, for a stand-in shape, and for anything whose model carries emitters —
   * an instance has no `Object3D` of its own, and `#updateEffects` places a torch's sparks by
   * reading the matrix of the placement's mesh.
   */
  instanceKey?: string;
  /** `instanceKey` plus the light lane, built once: the bucket this copy joins in `#updateInstances`. */
  instanceBucket?: string;
  /** Its world matrix, computed once when it was placed. Nothing in the environment ever moves. */
  instanceMatrix?: THREE.Matrix4;
  /**
   * Submission serial the grow-in started on, for vegetation only.
   *
   * While set, the node scales from `VEGETATION_GROWTH_FROM` to 1 instead of popping, its
   * matrices stay live, and instancing waits: an instance matrix is exact placement state, and
   * a tree mid-growth is not exact. Cleared with the freeze when it settles.
   */
  growthStartedAt?: number;
  /** Grow-in length in frames for this placement: slow for far trees, quick for near ones. */
  growthTotal?: number;
  /**
   * Whether this placement has ever been seen grown or whole.
   *
   * A tree returning from frustum culling or a settled budget churn reads full opacity at once:
   * during a fast camera turn motion masks an instant appearance, while a tree inflating
   * mid-turn reads as broken. Only the first sight eases in.
   */
  everVisible?: boolean;
  /**
   * A rig, for the scenery that has one.
   *
   * "Nothing in the environment ever moves" is true of the mill and false of the sails on it.
   * A placement with this set is the exception to every optimisation around it: its matrices are
   * not frozen, it is not instanced, and it costs a mixer step on every frame it is close enough
   * and on screen.
   */
  skinned?: SkinnedInstance;
  template?: SkinnedTemplate;
  /** The model path, kept so the held-back clips can be asked for by name. */
  model?: string;
}

interface PlacedWmo {
  /** Visual ADT id, used only after a raw-vmap placement has matched by name and transform. */
  visualId: number;
  name: string;
  model: WmoModel;
  /** Each group's box in scene space, transformed once when the building was placed. */
  boxes: (THREE.Box3 | undefined)[];
  /** Model coordinates through WMO's axis conversion and this static placement into the scene. */
  modelToWorld: THREE.Matrix4;
  worldToModel: THREE.Matrix4;
  /** Only meshes attached for the final distance/portal demand remain in this map. */
  built: Map<number, RenderedWmoGroup>;
  /**
   * Player position the cached distance selection below was computed for, if any.
   * `wmoGroupsInRange` is pure in (model, boxes, player): an exactly unchanged player gets
   * the identical set back, so standing still inside a city skips hundreds of box-distance
   * evaluations per building per frame. The portal refinement above it still runs every frame
   * — it reads the camera, which moves without the player.
   */
  rangePlayer?: { x: number; y: number; z: number };
  rangeGroups?: readonly number[];
}

/** The sole renderer owner of one converted WMO group geometry. */
interface WmoGroupGeometryEntry {
  readonly cacheKey: string;
  readonly epoch: number;
  readonly groupIndex: number;
  readonly geometry: THREE.BufferGeometry;
}

/** The sole renderer owner of one legacy static or skinned geometry/template. */
interface LegacyGeometryEntry {
  readonly cacheKey: string;
  readonly epoch: number;
  readonly domain: LegacyGeometryDomain;
  readonly geometry: THREE.BufferGeometry;
  readonly template?: SkinnedTemplate;
}

/** One placement-local borrower; its exact materials remain owned by the world-material cache. */
interface RenderedWmoGroup {
  readonly entry: WmoGroupGeometryEntry;
  readonly materialEntries: readonly WorldMaterialEntry[];
  readonly mesh: THREE.Mesh;
}

const WMO_PLACEMENT_POSITION_EPSILON = 1e-4;
const WMO_PLACEMENT_ANGLE_EPSILON = 1e-4;
const WMO_PLACEMENT_SCALE_EPSILON = 1e-6;

function angleDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return Math.min(delta, 360 - delta);
}

/** Match the server's raw vmap spawn to visual ADT art without comparing their unrelated ids. */
export function staticWmoPlacementMatches(
  raw: Readonly<StaticWmoPlacementIdentity>,
  visual: Readonly<EnvironmentObject>,
): boolean {
  return visual.kind === "wmo"
    && canonicalCollisionModelName(visual.name) === raw.canonicalModelName
    && Math.abs(visual.x - raw.x) <= WMO_PLACEMENT_POSITION_EPSILON
    && Math.abs(visual.y - raw.y) <= WMO_PLACEMENT_POSITION_EPSILON
    && Math.abs(visual.z - raw.z) <= WMO_PLACEMENT_POSITION_EPSILON
    && angleDistance(visual.rotationX, raw.rotationX) <= WMO_PLACEMENT_ANGLE_EPSILON
    && angleDistance(visual.rotationY, raw.rotationY) <= WMO_PLACEMENT_ANGLE_EPSILON
    && angleDistance(visual.rotationZ, raw.rotationZ) <= WMO_PLACEMENT_ANGLE_EPSILON
    && Math.abs(visual.scale - raw.scale) <= WMO_PLACEMENT_SCALE_EPSILON;
}

/** Zero or more than one visual match is ambiguous and must leave the zone fog in force. */
export function uniqueVisualWmoPlacement(
  raw: Readonly<StaticWmoPlacementIdentity>,
  objects: readonly EnvironmentObject[],
): EnvironmentObject | undefined {
  let match: EnvironmentObject | undefined;
  for (const object of objects) {
    if (!staticWmoPlacementMatches(raw, object)) continue;
    if (match) return undefined;
    match = object;
  }
  return match;
}

/**
 * `uniqueVisualWmoPlacement` remembered for as long as its inputs hold.
 *
 * The floor under the player is asked on every frame, and on a city street it names the same
 * static WMO for minutes at a time, while the scan behind the answer walks every placement of the
 * loaded footprint — 42,797 around Stormwind — normalising a model name per WMO. Both inputs are
 * exact identities: `objectsAround` hands back the same array until a tile lands or leaves, and a
 * collision placement carries a key that is stable within its map. Equal inputs, equal answer, and
 * the scan runs only when either changes.
 */
export class UniqueVisualWmoPlacementCache {
  #objects: readonly EnvironmentObject[] | undefined;
  #key: string | undefined;
  #map: number | undefined;
  #result: EnvironmentObject | undefined;

  lookup(raw: Readonly<StaticWmoPlacementIdentity>, objects: readonly EnvironmentObject[]): EnvironmentObject | undefined {
    if (objects === this.#objects && raw.key === this.#key && raw.map === this.#map) return this.#result;
    this.#result = uniqueVisualWmoPlacement(raw, objects);
    this.#objects = objects;
    this.#key = raw.key;
    this.#map = raw.map;
    return this.#result;
  }
}

/** Resolve MFOG only from the visual group proven by the winning collision-floor triangle. */
export function locatedWmoFog(
  model: Pick<WmoModel, "groups" | "fogs">,
  floor: Pick<StaticWmoFloor, "groupIndex" | "groupFlags">,
  camera: { x: number; y: number; z: number },
): WmoFog | undefined {
  const group = model.groups[floor.groupIndex];
  // Collision and visual groups come from the same source WMO and preserve file order. Flags and
  // the model-space box are independent guards: any format/cache drift fails closed to zone fog.
  if (!group || group.flags !== floor.groupFlags || !group.indoor) return undefined;
  const bounds = group.bounds;
  if (group.boundsValid === false || !validWmoBounds(bounds)) return undefined;
  const epsilon = 1e-3;
  if (camera.x < bounds.minX - epsilon || camera.x > bounds.maxX + epsilon
    || camera.y < bounds.minY - epsilon || camera.y > bounds.maxY + epsilon
    || camera.z < bounds.minZ - epsilon || camera.z > bounds.maxZ + epsilon) return undefined;
  return wmoLandFogAt(model, group, camera.x, camera.y, camera.z);
}

/**
 * A door, a chest, a lever, a lift: something the server owns, that moves or opens.
 *
 * Kept apart from `RenderedEnvironment` because a doodad is placed once and is then scenery, while
 * one of these is re-read every frame — its state byte can change, its lift can be mid-travel, and
 * a custom animation can arrive for it out of nowhere.
 */
interface RenderedGameObject extends PosedModel {
  actual: boolean;
  node: THREE.Object3D;
  /** `obj:<guid>`, the emitter set's key, built on the first frame that asks and kept. */
  effectKey?: string;
  /** Exact cache entry borrowed by this object, when it is a built WVM model. */
  built?: BuiltModel;
  /** Exact decoded legacy parent and resources borrowed while this object is retained. */
  decodedModel?: EnvironmentModel;
  legacyGeometry?: LegacyGeometryEntry;
  materialEntries?: readonly WorldMaterialEntry[];
  /** The mesh carrying the model-space rotation, for an unrigged model's emitters. */
  visual?: THREE.Object3D;
  wvm?: WvmModel;
  wmo?: PlacedWmo;
  /** The model path, so the poses it held back can be asked for by name. */
  model?: string;
  /** The state byte it was last drawn in. Undefined until the first draw, which is what snaps. */
  state?: number;
  /** Display/scale/entry tuple for which the retained static WVM bounds are trusted. */
  admissionDisplayId?: number;
  admissionScale?: number;
  admissionEntry?: number;
  /**
   * When the object first became visible, in the renderer's clock, for the spawn fade.
   *
   * Units already ease in this way; doors and chests popped at full opacity on the same frame
   * their model arrived. Preserved across display rebuilds so a door that changes state does
   * not fade twice; cleared with the record itself.
   */
  admittedAt?: number | undefined;
  /**
   * The opacity currently applied: 1 once settled. Compared edge-triggered like the units so a
   * settled object costs nothing per frame, and quantized so a fade borrows a bounded handful
   * of private material copies instead of one per frame.
   */
  fadedOpacity?: number | undefined;
  /** Which meshes are wearing private faded copies, and the shared arrays they gave back. */
  opacityBorrows?: MaterialBorrow[];
  /** Metadata-cache revision that last proved the display id still maps to `model`. */
  admissionMetadataRevision?: number;
  /** `OBJECT_FIELD_ENTRY`: what a transport path is keyed on. Not the display id. */
  entry: number;
  /** Where it stands when it is not travelling — a lift's path is an offset from this. */
  base: WorldPosition;
  /** How far into its cycle it was at `phaseAt`, so the rest is counted locally. */
  phaseMs?: number | undefined;
  phaseAt?: number | undefined;
}

interface RenderedTerrain {
  material: THREE.MeshLambertMaterial;
  mesh: THREE.Mesh;
  /** Revision of this tile and its eight neighbours, which is what terrain/water edges borrow. */
  revision: number;
  /** Revision of this tile alone: changes here also reopen holes and replace the interior. */
  ownRevision: number;
  /** Whether the ground textures have arrived and the blending shader is in place. */
  splatted: boolean;
  /** Which liquid strips had arrived when these surfaces were built. */
  liquidGeneration: number;
  /** One mesh per liquid class the tile contains. */
  water?: THREE.Mesh[];
  /** Hidden splats upload one texture per quiet frame, before they become visible. */
  textureWarmup?: THREE.Texture[];
}

interface PreparedTerrain {
  data: TerrainGeometryData;
  water: Map<LiquidClass, THREE.BufferGeometry>;
}

interface TerrainPreparation {
  key: string;
  grid: { x: number; y: number };
  revision: number;
  ownRevision: number;
  liquidGeneration: number;
  steps: Generator<void, PreparedTerrain, void>;
}

interface PreparedTerrainRepair {
  data?: TerrainGeometryData;
  boundingSphere?: THREE.Sphere;
  water?: Map<LiquidClass, THREE.BufferGeometry>;
}

interface TerrainRepair {
  key: string;
  map: number;
  grid: { x: number; y: number };
  rendered: RenderedTerrain;
  client: TerrainClient | undefined;
  revision: number;
  ownRevision: number;
  liquidGeneration: number;
  steps: Generator<void, PreparedTerrainRepair, void>;
}

/**
 * Everything it takes to pose a model: the rig, this copy of it, and what it is playing.
 *
 * Shared by units and game objects because the playing is identical — a door swinging and an orc
 * swinging are one mixer, one clip and one crossfade. What differs is entirely in the choosing,
 * and that is deliberately not here: a chest asked for an idle pose the way a unit is asked comes
 * back with its lid closing on a loop.
 */
interface PosedModel {
  skinned: SkinnedInstance | undefined;
  template: SkinnedTemplate | undefined;
  /** The locomotion/idle action, kept alive underneath a transient overlay when needed. */
  action: THREE.AnimationAction | undefined;
  animationId: number;
  /** The semantic action currently owning the full-body mixer slot, when it is not locomotion. */
  actionKind?: UnitAction;
  /** Optional upper-body action. Its filtered clip owns no lower-body tracks. */
  overlayAction?: THREE.AnimationAction;
  overlayAnimationId?: number;
  /** The semantic action owning the upper-body slot; needed to cancel a real ranged pose. */
  overlayActionKind?: UnitAction;
  overlayPreservesLocomotion?: boolean;
  /** End of the upper-body fade window, set once the one-shot reaches its fade start. */
  overlayFadeUntil?: number;
  /** A one-shot playing over the pose — a jump landing, a swing, an emote — and when it ends. */
  overlayUntil: number;
  /**
   * When the travelling gait now playing may be replaced by another one. See `commitLocomotion`.
   *
   * Zero whenever the model is not in a gait at all, so nothing but a stride ever carries a
   * deadline. Both a unit and the mount under it have one, because both change gait on their own.
   */
  gaitCommittedUntil?: number;
  /** The template `flatPoseProgram` was resolved for; see `#flatPose`. */
  flatPoseTemplate?: SkinnedTemplate;
  flatPoseProgram?: FastPoseProgram | undefined;
}

/** Which unit wears a ring and what colour it is, as the interface works it out. */
export interface SelectionRing {
  guid: bigint;
  /** Packed 24-bit colour: red for a hostile target, yellow for neutral, green for friendly. */
  colour: number;
}

interface RenderedSelectionRing {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

/**
 * The ground reticle the aiming flow resolves each frame: where the cast would land, the spell's
 * own area radius in yards (zero when it names none) and the surfaces under the ring.
 */
export interface GroundTargetPreview {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** False when the point is beyond the spell's own range: the rings warn instead of promising. */
  inRange: boolean;
  ground?: HeightSampler | undefined;
}

/**
 * The duel flag's bounds ring: where the planted flag stands and whether the duelist is inside.
 *
 * Pushed rather than resolved here because the renderer knows nothing about duels; the loop
 * resolves the flag guid to a position every frame, like the selection rings do for units.
 */
export interface DuelRing {
  x: number;
  y: number;
  z: number;
  /** False once `SMSG_DUEL_OUTOFBOUNDS` has arrived and until the way back in. */
  inBounds: boolean;
}

/** The translucent model of a game object a placing spell is about to create. */
export interface GameObjectPreview {
  model: string;
  x: number;
  y: number;
  z: number;
  orientation: number;
  scale: number;
}

interface RenderedUnit extends PosedModel {
  node: THREE.Group;
  /** `unit:<guid>`, the emitter set's key, built on the first frame that asks and kept. */
  effectKey?: string;
  /** Exact appearance build borrowed by the body currently standing in the node. */
  built: BuiltModel | undefined;
  /** Legacy fallback ownership is separate from appearance/WVM builds. */
  decodedModel?: EnvironmentModel;
  legacyGeometry?: LegacyGeometryEntry;
  materialEntries?: readonly WorldMaterialEntry[];
  /** Last shadow policy applied to this model tree; undefined when its children change. */
  shadowCaster: boolean | undefined;
  /** The stand-in capsule, present until a skinned model for the display id has arrived. */
  body: THREE.Mesh | undefined;
  material: THREE.MeshStandardMaterial;
  /** What the unit was doing last frame, so a takeoff and a landing can be told apart. */
  pose: UnitPose | undefined;
  /**
   * When the unit first became visible, in the renderer's clock, for the spawn fade.
   *
   * Set on first visibility rather than on record creation: streamed content is created whole
   * seconds before it is drawn, and fading from creation would be over before the first pixel.
   * Units returning from frustum culling keep their stamp and read full opacity at once.
   */
  admittedAt?: number | undefined;
  /**
   * Where the node stood on the previous posed frame, for stride-tempo measurement.
   *
   * A mover's packets name where it is going, never how fast its legs go: the replay rate of a
   * gait is presentational, and the only honest speed available for every unit — self included,
   * whose forced rates live on the client rather than on the object — is the distance the drawn
   * node actually covers per second.
   */
  strideX: number;
  strideY: number;
  strideZ: number;
  strideReady: boolean;
  /** Yards a second from the last stride measurement, or undefined before the second frame. */
  strideSpeed: number | undefined;
  /** Last rig and its staggered animation clock; a newly attached rig always gets its first pose. */
  animationClock?: UnitAnimationClock;
  animationClockRig?: SkinnedInstance;
  animationClockMountRig?: SkinnedInstance | undefined;
  height: number;
  radius: number;
  scale: number;
  dead: boolean;
  tint: number;
  /**
   * The model and appearance currently standing in `node`, or "" while it is still a capsule.
   *
   * Without this a unit was bound once and never again: a druid shifting form, a mount, a
   * polymorph and every change of armour left the first model it happened to get. It is also what
   * makes the model-less branch idempotent — that one used to add another mesh every frame.
  */
  applied: string;
  /** Display/object-scale pair for which `wvm` is known to be the live wire appearance. */
  admissionDisplayId?: number;
  admissionObjectScale?: number;
  /** Whether the settled appearance declares gear hanging outside the body's own WVM bounds. */
  admissionHasAuthoredAttachments?: boolean;
  /**
   * Helmets, pauldrons and weapons hanging off the bones, by `slot/side`. They arrive after the
   * body — each is its own download — so they are attached as they turn up rather than waited for.
   */
  attached: Map<string, THREE.Object3D>;
  /**
   * How tall the model standing in this node is, in its own space, before any scale.
   *
   * `unit.height` is not that number the whole time: while the unit is riding it is the saddle plus
   * the body, and while it is a capsule it is the pill's combat reach. So the body's own height is
   * kept here, once, by whichever branch of `#attachSkinnedModel` built it — the rigged one had it
   * in `template.height` all along and the static one computed it and dropped it on the floor,
   * which is why dismounting used to leave a rigless creature's name plate at saddle height for the
   * rest of the object's life.
   */
  bodyHeight?: number;
  /** The file the emitters come from, kept so the effects pass does not re-resolve the model. */
  wvm?: WvmModel;
  /** For an unrigged model, the mesh that carries the model-space rotation. */
  visual?: THREE.Object3D;
  /** The second model this one is riding, once it has been built. See `#updateMount`. */
  mount?: RenderedMount;
  /**
   * How opaque this unit is drawn right now: 1 for everything the server says nothing about.
   *
   * The value that is *applied*, not the one that is wanted — the two are compared to make the
   * application edge-triggered, which is the reference client's own shape for this
   * (`entity_spawner.cpp:110-117`: remember the last answer per guid and touch the renderer only
   * when it changes).
   */
  unitOpacity: number;
  /** Which meshes are wearing private faded copies, and the shared arrays they gave back. */
  opacityBorrows?: MaterialBorrow[];
  /**
   * The body (`unitWarmBody`) the warm hold last let onto the screen. A body that is not this one
   * is new, and is checked against the warm pass before it is drawn; see `#holdUnitUntilWarm`.
   */
  warmShown?: THREE.Object3D;
  /** Whether a model, not just the capsule, has been on screen: the player's is never hidden again. */
  modelShown?: boolean;
  /** Frames a finished fade has kept its copies waiting for the shared programs; see `#unitFadeReturnWaits`. */
  fadeReturnFrames?: number;
  /** When, in the renderer's clock, this player's look was first seen with item rows pending. */
  appearancePendingSince?: number;
  /** Whether the server says this unit is sneaking, for the pose. See `unitAppearance`. */
  stealthed?: boolean;
  /**
   * How far the lower body is currently turned off the facing, in radians. See `strafeYawTarget`.
   *
   * Per unit and not per model: two humans strafing in opposite directions share one template and
   * one set of clips, and the turn is the only part of the pose that is theirs alone.
   */
  strafeYaw?: number;
}

/**
 * One mesh that has put its shared material array aside and is wearing private faded copies.
 *
 * The shared array is kept by identity rather than rebuilt, because giving *exactly* it back is
 * what makes the restore a restore: the build cache hands the same array to every unit of the same
 * appearance, and a rebuilt one would quietly leave this unit off the shared clock that
 * `updateBatchAppearance` runs.
 */
export interface MaterialBorrow {
  mesh: THREE.Mesh;
  shared: THREE.Material | THREE.Material[];
  clones: THREE.Material[];
}

/**
 * Puts private faded copies on every mesh given and records what each one gave up.
 *
 * The single-material case is kept single rather than promoted to a one-element array: a mesh's
 * `material` shape is what three's group handling reads, and handing an array to geometry with no
 * groups draws nothing at all.
 */
export function borrowFadedMaterials(
  meshes: Iterable<THREE.Mesh>, factor: number,
): MaterialBorrow[] {
  const borrows: MaterialBorrow[] = [];
  for (const mesh of meshes) {
    const shared = mesh.material;
    const clones = (Array.isArray(shared) ? shared : [shared])
      .map((material) => cloneMaterialFaded(material, factor));
    mesh.material = Array.isArray(shared) ? clones : clones[0]!;
    borrows.push({ mesh, shared, clones });
  }
  return borrows;
}

/** Changes fade uniforms without releasing the materials that own the compiled programs. */
export function updateBorrowedMaterials(borrows: readonly MaterialBorrow[], factor: number): void {
  for (const borrow of borrows) {
    for (let index = 0; index < borrow.clones.length; index++) {
      const source = Array.isArray(borrow.shared) ? borrow.shared[index]! : borrow.shared;
      fadeMaterial(borrow.clones[index]!, factor, source);
    }
  }
}

/** Hands every shared array back by identity and disposes the copies that stood in for it. */
export function returnBorrowedMaterials(borrows: readonly MaterialBorrow[]): void {
  for (const borrow of borrows) {
    borrow.mesh.material = borrow.shared;
    for (const clone of borrow.clones) clone.dispose();
  }
}

/**
 * A never-drawn material with the program-relevant state of every faded copy of `source`.
 *
 * `cloneMaterialFaded` at any factor strictly between 0 and 1 compiles one program: `transparent`
 * is the same at every such factor, a positive alpha test stays positive (`FADE_ALPHA_TEST_FLOOR`),
 * and opacity, colour and the threshold itself are uniforms. So one stand-in per shared material
 * lets the warm pass link the program of every unit's fade copy of it before the first of those
 * copies exists, and answers `isLinked` for all of them — a copy made per unit would have to wait
 * in the warm queue itself.
 */
export function createFadeProgramTwin(source: THREE.Material): THREE.Material {
  return cloneMaterialFaded(source, UNIT_FADE_TWIN_FACTOR);
}

/** The stand-in capsule's material, and the recipe its two program stand-ins are made from. */
export function createUnitCapsuleMaterial(
  tint: number,
  worldLight: WorldLightUniforms,
  transparent = false,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.72, metalness: 0.05, transparent });
  applyWorldLight(material, worldLight, "surface");
  return material;
}

/** What a unit's warm hold is about: its rigged body, its rigless mesh, or its capsule. */
export function unitWarmBody(unit: {
  readonly skinned?: SkinnedInstance | undefined;
  readonly visual?: THREE.Object3D | undefined;
  readonly body?: THREE.Mesh | undefined;
}): THREE.Object3D | undefined {
  return unit.skinned?.mesh ?? unit.visual ?? unit.body;
}

/** Whether `object` still hangs somewhere below `ancestor`. */
function hangsUnder(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let node = object.parent; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

/**
 * The horse, the wyvern or the taxi gryphon standing under a rider.
 *
 * A whole second model with a rig, a mixer and a pose of its own, because that is what it is:
 * `Unit::Mount` (`Unit.cpp:8668-8673`) writes one `UNIT_FIELD_MOUNTDISPLAYID` and nothing else, and
 * `WorldSession::SendDoFlight` (`TaxiHandler.cpp:121-131`) reaches the same call, so a flight path
 * arrives here too. It is posed from the rider's own movement flags — the mount is the thing doing
 * the moving — and the rider is parented to its saddle bone rather than merely floated above it, so
 * a galloping horse carries the character with it.
 */
interface RenderedMount extends PosedModel {
  /** What is built and standing there, under the same name `#unitKey` gives a unit's own model. */
  key: string;
  /** Exact cache entry borrowed by this mount. */
  built: BuiltModel;
  /** The mount's own frame inside `unit.node`; `#seatRider` explains the scale it carries. */
  node: THREE.Group;
  /** Kept for `#requestAnimations`, which asks for a gait by model path. */
  metadata: UnitModel;
  wvm: WvmModel;
  /** The display record's own scale, which is the mount's and not the rider's. */
  scale: number;
  /** How high the saddle is above the mount's feet, already at `scale`. `mountSeatOffset`. */
  seat: number;
  /**
   * The mount's own pose last frame — the rider's, sanitised by `mountPose` — so a takeoff and a
   * landing can be told apart down here too. The rider has had one since the jump one-shots were
   * written; the horse under it never did, which is why it had no JumpStart or JumpEnd at all.
   */
  pose?: UnitPose;
}

/**
 * One model a spell is showing: the flourish in a caster's hand, a bolt in the air, a flash on
 * whatever it hit.
 *
 * It is a fourth kind of thing in this scene, and it had to be. A doodad is keyed by its place in
 * a tile, a game object and a unit by their GUID, and a spell effect by none of those — it is
 * keyed by the cast that made it, lives for a second, and may be following a bone that belongs to
 * somebody else.
 */
interface RenderedVisual {
  instance: VisualInstance;
  /** The cast that owns this node, so an interrupted cast cannot clear another cast's effects. */
  handle: SpellVisualHandle;
  /** Stable for as long as this instance lives, so its emitters keep their own seed. */
  key: string;
  node: THREE.Group;
  /**
   * The model's own frame inside the node, and the thing the emitters are placed against.
   *
   * It exists whether or not there is a mesh, and there very often is not: of the fourteen
   * most-used spell effect models, five have no vertices at all and every one of the fourteen has
   * emitters. A spell in this game is a particle system with an occasional quad in it, so the
   * frame cannot be something only a mesh brings.
   */
  frame: THREE.Object3D;
  /** The mesh, once the file has arrived, for the models that have one. */
  visual: THREE.Object3D | undefined;
  /** Spell builds are per instance so animated alpha/weight tracks use the cast's local clock. */
  built: BuiltModel | undefined;
  wvm: WvmModel | undefined;
  /** Spell M2s can carry a rig even when they have no visible vertices. */
  skinned: SkinnedInstance | undefined;
  template: SkinnedTemplate | undefined;
  action: THREE.AnimationAction | undefined;
  /** Original packet lifetime; loader grace must never become the final visual lifetime. */
  authoredEndsAt: number;
  loadDeadline: number | undefined;
  /** Separate bounded gate for composite effect readiness; unlike loadDeadline it does not alter cleanup. */
  effectsLoadDeadline: number;
  /** Model/particle clock origin; cold one-shots rebase here when their WVM arrives late. */
  playbackStartedAt: number | undefined;
  /** First frame this visual was an eligible emitter candidate, before the shared effect budget. */
  effectsEligibleAt: number | undefined;
  /** Shared local origin installed when this visual's due phase passes the readiness barrier. */
  phaseOriginAt: number | undefined;
  /** Persistent phase state; a late asset response cannot resurrect a failed composite. */
  effectsPhaseStatus: VisualEffectPhaseStatus;
  /** Exact cached-base borrows, admitted once and retained through mesh/emitter cleanup. */
  textureLeases: Map<string, ModelTextureLease>;
  /**
   * The authored offset from the anchor bone's pivot to the attachment point, in the bone's frame.
   *
   * Cached with the model it was read out of, and recomputed only when that model changes — a
   * druid shifting form, a polymorph, a unit rebuilt after a display change. The lookup is a
   * linear scan of the model's attachment table and this runs for every bone-anchored effect on
   * every frame; the placement itself must not pay for it.
   */
  boneOffset?: THREE.Vector3;
  boneOffsetSource?: WvmModel;
}

/** Opaque ownership token returned by {@link WorldRenderer3D.playSpellVisual}. */
export interface SpellVisualHandle {
  readonly id: number;
}

/** A budget entry carrying enough ownership information to keep a composite cast intact. */
export interface VisualEffectBudgetEntry {
  key: string;
  distance: number;
  handleId: number;
  phaseKey?: string;
}

export type VisualEffectPhaseStatus = "pending" | "ready" | "failed";

/** Readiness of one active model in a composite spell kit, before the shared effect budget. */
export interface VisualEffectReadinessEntry {
  phaseKey: string;
  startedAt: number;
  modelReady: boolean;
  /** Every referenced mesh/emitter texture has completed, not merely the WVM model bytes. */
  assetsReady?: boolean;
  /** A referenced texture failed permanently; the whole phase is suppressed atomically. */
  assetsFailed?: boolean;
  activeUntil: number;
  loadDeadline?: number;
  failed?: boolean;
  /** Aggregate state persisted on each member; all members of a phase normally agree. */
  phaseStatus?: VisualEffectPhaseStatus;
  /** Missiles/held visuals cannot be rebased after their authored window. */
  rebasable?: boolean;
}

/** Stable readiness key for one due phase of one cast; later impact phases remain independent. */
export function visualEffectPhaseKey(handleId: number, startedAt: number): string {
  return `${handleId}:${startedAt}`;
}

/** Failed phase keys are purged atomically so a late model cannot leave a sibling alive. */
export function failedVisualEffectPhaseKeys(
  entries: readonly Pick<VisualEffectReadinessEntry, "phaseKey" | "phaseStatus">[],
): Set<string> {
  return new Set(entries.filter((entry) => entry.phaseStatus === "failed")
    .map((entry) => entry.phaseKey));
}

/** Geometry follows the phase gate while the parent node remains available for root transforms. */
export function visualEffectContentVisible(
  started: boolean,
  phaseStatus: VisualEffectPhaseStatus | undefined,
): boolean {
  return started && phaseStatus === "ready";
}

/**
 * Returns the tri-state status of each due phase before it is admitted as one unit.
 *
 * A missing model is pending until its bounded request grace; after that it is failed and suppresses
 * the whole phase. Future phases are omitted, while an authored-expired phase remains pending when
 * its persistent state has not settled; this prevents a short kit from being retired before its
 * shared release, without letting an unbounded failed aura freeze the barrier forever.
 */
export function visualEffectPhaseStatuses(
  entries: readonly VisualEffectReadinessEntry[],
  now: number,
): Map<string, VisualEffectPhaseStatus> {
  const states = new Map<string, VisualEffectPhaseStatus>();
  const byPhase = new Map<string, VisualEffectReadinessEntry[]>();
  for (const entry of entries) {
    // A future impact phase must not hold back a cast that is already due. It becomes a readiness
    // group only on its own first active frame.
    if (entry.startedAt > now) continue;
    let phase = byPhase.get(entry.phaseKey);
    if (!phase) {
      phase = [];
      byPhase.set(entry.phaseKey, phase);
    }
    phase.push(entry);
  }
  for (const [phaseKey, phase] of byPhase) {
    const persistentFailed = phase.some((entry) => entry.failed || entry.assetsFailed === true
      || entry.phaseStatus === "failed");
    if (persistentFailed) {
      states.set(phaseKey, "failed");
      continue;
    }
    const ready = (entry: VisualEffectReadinessEntry): boolean =>
      entry.modelReady && entry.assetsReady !== false;
    const persistentReady = phase.length > 0 && phase.every((entry) =>
      entry.phaseStatus === "ready" && ready(entry));
    if (persistentReady) {
      states.set(phaseKey, "ready");
      continue;
    }
    const hasActiveMember = phase.some((entry) => entry.activeUntil > now);
    // The authored lifetime is not a readiness deadline. Keep a short-lived loaded sibling in
    // this phase while another member can still resolve, otherwise both nodes can be retired on
    // the same frame and the composite never gets its shared release origin.
    const hasPendingMember = phase.some((entry) => !entry.failed && !entry.assetsFailed
      && entry.phaseStatus !== "failed" && !ready(entry)
      && entry.loadDeadline !== undefined && now < entry.loadDeadline);
    const hasPersistentPending = phase.some((entry) => entry.phaseStatus === "pending");
    const hasGraceWindow = phase.some((entry) => entry.loadDeadline !== undefined && now < entry.loadDeadline);
    // If every member has already ended and none is still inside request grace, this is a genuinely
    // expired phase and must not keep a persistent aura/impact in the barrier forever.
    if (!hasActiveMember && !hasPendingMember && !hasPersistentPending
      && !(phase.every(ready) && hasGraceWindow)) continue;
    if (phase.every(ready)) {
      // A flight/held member cannot be rewound after its authored window. Failing the phase keeps
      // its already-loaded siblings from appearing as a one-frame partial kit.
      if (phase.some((entry) => entry.rebasable === false && entry.activeUntil <= now)) {
        states.set(phaseKey, "failed");
      } else {
        states.set(phaseKey, "ready");
      }
      continue;
    }
    if (phase.some((entry) => !ready(entry)
      && (entry.loadDeadline === undefined || now >= entry.loadDeadline))) {
      states.set(phaseKey, "failed");
    } else {
      states.set(phaseKey, "pending");
    }
  }
  return states;
}

/**
 * Selects spell effect entries without splitting one cast's kit.
 *
 * The renderer uses this as a deterministic, distance-ranked policy; keeping it pure makes the
 * intermittent half-kit failure testable without constructing a WebGL context. A readiness set
 * may additionally hold a due phase at the gate while one of its active models is still loading.
 */
export function selectVisualEffectGroups<T extends VisualEffectBudgetEntry>(
  entries: readonly T[], budget: number, readyPhaseKeys?: ReadonlySet<string>,
): { selected: T[]; droppedGroups: number } {
  const sorted = [...entries].sort((left, right) => left.distance - right.distance
    || left.handleId - right.handleId || left.key.localeCompare(right.key));
  const groups = new Map<number, T[]>();
  for (const entry of sorted) {
    let group = groups.get(entry.handleId);
    if (!group) {
      group = [];
      groups.set(entry.handleId, group);
    }
    group.push(entry);
  }
  const selected: T[] = [];
  let count = 0;
  let droppedGroups = 0;
  const limit = Math.max(0, Math.floor(Number.isFinite(budget) ? budget : 0));
  for (const group of groups.values()) {
    if (readyPhaseKeys && group.some((entry) => entry.phaseKey === undefined
      || !readyPhaseKeys.has(entry.phaseKey))) {
      droppedGroups++;
      continue;
    }
    // A malformed kit larger than the entire allowance must not bypass the hard cap.  Splitting
    // it would recreate the half-kit bug, so drop that kit as one unit and let a later frame try
    // again when the competing effects have gone away.
    if (group.length > limit || count + group.length > limit) {
      droppedGroups++;
      continue;
    }
    selected.push(...group);
    count += group.length;
  }
  return { selected, droppedGroups };
}

/**
 * Finds due spell phases whose complete authored root set cannot be admitted this frame.
 *
 * A phase is one visual kit, not one distance-ranked emitter. If a due member has temporarily
 * lost its attachment/root, or a due emitter member is outside the effect range, admitting a
 * nearby sibling would expose only part of the authored effect and would start the shared clock
 * before the missing member can participate. Keep this policy pure so mixed-distance and root
 * availability cases stay regression-testable without constructing a renderer.
 */
export interface VisualEffectAdmissionEntry {
  groupKey: string;
  due: boolean;
  rootVisible: boolean;
  hasEmitter: boolean;
  distance: number;
}

export function rejectedVisualEffectGroups(
  entries: readonly VisualEffectAdmissionEntry[], effectRange: number,
): Set<string> {
  const rejected = new Set<string>();
  const range = Number.isFinite(effectRange) ? Math.max(0, effectRange) : 0;
  for (const entry of entries) {
    if (!entry.due) continue;
    if (!entry.rootVisible || (entry.hasEmitter
      && (!Number.isFinite(entry.distance) || entry.distance > range))) {
      rejected.add(entry.groupKey);
    }
  }
  return rejected;
}

/**
 * Catch-up time for a newly built spell emitter set. A finite fit-to-model visual is rebased to its
 * async model resolution, so it has age zero even when the packet was already visible; it must not
 * be advanced by an invented pre-roll. Its active emitters receive an explicit zero-time first-burst
 * prime in `ParticleRender`. Missiles and held/aura visuals retain their bounded real local age.
 */
/** Async simulation is a priming aid, not a second frame loop; longer ages start from this bound. */
export const SPELL_VFX_CATCHUP_MAX_MS = 1_000;

export function spellEffectPrimeSeconds(
  instance: Pick<VisualInstance, "fitToModel" | "flight" | "modelPlayback">,
  ageMs: number,
  playbackStartedAt?: number,
  startedAt?: number,
  firstEligible = true,
): number {
  // A model resolved before its scheduled start keeps `playbackStartedAt === startedAt`. Its
  // first visible RAF may still be a few milliseconds late, but that is not async age to catch
  // up: the emitter set did not exist on any visible frame yet. Only that first eligible frame may
  // use the emitter-aware authored-time burst; a later budget/range admission must retain real age.
  if (firstEligible && instance.fitToModel === true && instance.flight === undefined
    && instance.modelPlayback !== "hold"
    && Number.isFinite(playbackStartedAt) && Number.isFinite(startedAt)
    && playbackStartedAt! <= startedAt!) return 0;
  const age = Math.min(SPELL_VFX_CATCHUP_MAX_MS, Math.max(0, Number.isFinite(ageMs) ? ageMs : 0)) / 1000;
  return age;
}

/** Shared local origin for finite one-shot members admitted from one due phase. */
export function spellEffectPhaseOrigin(
  instance: Pick<VisualInstance, "fitToModel" | "flight" | "modelPlayback">,
  phaseOriginAt: number | undefined,
  fallbackOrigin: number | undefined,
): number | undefined {
  return instance.fitToModel === true && instance.flight === undefined
    && instance.modelPlayback !== "hold" && Number.isFinite(phaseOriginAt)
    ? phaseOriginAt : fallbackOrigin;
}

/**
 * Whether a newly-built effect may receive the zero-time emitter burst.
 *
 * This is deliberately narrower than the async catch-up path. A missile or a held/aura model
 * must keep its real local age; adding a particle after catch-up would be an extra, unauthored
 * burst. A finite fit-to-model one-shot may be primed either when its model origin was ready at
 * the authored start (the first visible RAF can then have a positive age), or on the same frame a
 * late model is rebased (age is exactly zero). Delayed async age remains catch-up only.
 */
export function spellEffectNeedsFirstBurst(
  instance: Pick<VisualInstance, "fitToModel" | "flight" | "modelPlayback">,
  firstEligible: boolean,
  playbackStartedAt: number | undefined,
  startedAt: number,
  ageMs: number,
  primeSeconds: number,
): boolean {
  const originIsPreloaded = Number.isFinite(playbackStartedAt)
    && playbackStartedAt! <= startedAt;
  const lateResolveIsAtZero = Number.isFinite(playbackStartedAt)
    && playbackStartedAt! > startedAt
    && Math.max(0, Number.isFinite(ageMs) ? ageMs : 0) === 0;
  return instance.fitToModel === true
    && instance.flight === undefined
    && instance.modelPlayback !== "hold"
    && firstEligible
    && (originIsPreloaded || lateResolveIsAtZero)
    && primeSeconds === 0;
}

/** Whether a scheduled spell instance has reached its first visible frame. */
export function visualHasStarted(instance: VisualInstance, now: number): boolean {
  return now >= instance.startedAt;
}

/** Progress of a visual flight, clamped so late frames cannot overshoot either endpoint. */
export function visualFlightProgress(instance: VisualInstance, now: number): number {
  if (!instance.flight) return 0;
  const life = instance.endsAt - instance.startedAt;
  if (!(life > 0)) return 1;
  return Math.max(0, Math.min(1, (now - instance.startedAt) / life));
}

/** Future animation scheduling is inclusive: the frame at its authored time may play it. */
export function visualAnimationIsDue(animation: VisualAnimation, now: number): boolean {
  // Keep hand-authored/legacy plans (which predate `at`) immediate while all plans produced by
  // SpellVisuals use the absolute timestamp. This is also safer than parking an undefined time in
  // the future queue forever.
  return !Number.isFinite(animation.at) || now >= animation.at;
}

/** Actual local origin for a finite one-shot model that was resolved after its authored start. */
export function visualPlaybackOrigin(instance: VisualInstance, resolvedAt: number): number {
  if (instance.fitToModel && !instance.flight && instance.modelPlayback !== "hold"
    && resolvedAt > instance.startedAt) return resolvedAt;
  return instance.startedAt;
}

/** Minimum playback window retained from the selected origin, with model duration bounded. */
export function visualPlaybackWindow(
  instance: VisualInstance,
  modelDurationMs = 0,
  authoredEndsAt = instance.endsAt,
): number {
  const authored = Number.isFinite(authoredEndsAt)
    ? Math.max(0, authoredEndsAt - instance.startedAt) : 0;
  const model = Math.min(MODEL_VFX_MAX_MS, Math.max(0, modelDurationMs));
  return Math.max(authored, model);
}

const TERRAIN_SUBDIVISIONS = 128;
const SKY_COLOR = 0x35506a;

/**
 * The terrain's surface model is diffuse-only by design. The ground has no authored specular or
 * metal channel; using `MeshStandardMaterial` here added a dielectric highlight to every splat,
 * which was especially conspicuous on the densely repeated grass textures. Lambert still consumes
 * the geometry normals, scene lights and fog, and its `map_fragment` remains available to the splat
 * shader patch.
 */
export function buildTerrainMaterial(worldLight?: WorldLightUniforms): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0x426b45 });
  if (worldLight) applyWorldLight(material, worldLight, "terrain");
  return material;
}
/** Depth to assume where the ground under a liquid cell is not known, so the shore still fades. */
const DEEP_WATER_YARDS = 10;

/** MLIQ values may come from a decoded collision model or an injected runtime model. */
function finiteFloat32(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

/**
 * Keep malformed liquid out of BufferGeometry and GLSL while leaving the model's solid groups
 * usable. The dimensions/length checks also make the corner indexing below total and bounded.
 */
export function isValidWmoLiquid(value: unknown): value is CollisionLiquid {
  try {
    if (typeof value !== "object" || value === null) return false;
    const liquid = value as CollisionLiquid;
    const { tilesX, tilesY, cornerX, cornerY, cornerZ, type } = liquid;
    if (!Number.isSafeInteger(tilesX) || tilesX < 1
      || !Number.isSafeInteger(tilesY) || tilesY < 1
      || !Number.isSafeInteger(type) || type < 0 || type > 0xffffffff
      || !finiteFloat32(cornerX) || !finiteFloat32(cornerY) || !finiteFloat32(cornerZ)
      || !(liquid.heights instanceof Float32Array) || !(liquid.flags instanceof Uint8Array)) return false;
    const corners = (tilesX + 1) * (tilesY + 1);
    const cells = tilesX * tilesY;
    if (!Number.isSafeInteger(corners) || !Number.isSafeInteger(cells)
      || liquid.heights.length !== corners || liquid.flags.length !== cells) return false;
    for (let corner = 0; corner < corners; corner++) {
      if (!finiteFloat32(liquid.heights[corner]!)) return false;
    }
    for (let cell = 0; cell < cells; cell++) {
      // Uint8Array guarantees this range, but retaining the explicit check documents the runtime
      // contract and keeps this guard safe if the wire representation changes later.
      const flag = liquid.flags[cell]!;
      if (!Number.isInteger(flag) || flag < 0 || flag > 0xff) return false;
    }
    // Reject arithmetic overflow as well as non-finite source fields; these are the extrema used
    // by the per-cell positions and UVs below.
    return finiteFloat32(cornerX + tilesX * LIQUID_CELL_YARDS)
      && finiteFloat32(cornerY + tilesY * LIQUID_CELL_YARDS);
  } catch {
    // Runtime/injected model data is not trusted; a hostile getter must not break rendering.
    return false;
  }
}

/**
 * Converts the four corner heights into the material's per-vertex depth values. Keeping this as a
 * small pure function makes the shared-corner contract explicit: two quads that sample the same
 * water/ground corner receive the same fade value instead of each inheriting its centre depth.
 */
export function waterCornerDepths(waterHeights: readonly number[], groundHeights: readonly number[], fallback = DEEP_WATER_YARDS): number[] {
  return waterHeights.map((water, index) => {
    const ground = groundHeights[index];
    return ground !== undefined && Number.isFinite(ground) ? Math.max(0, water - ground) : fallback;
  });
}

/** The small part of a terrain liquid answer needed to resolve one shared water corner. */
export interface WaterCornerSample {
  height: number;
  type: number;
  entry: number;
  /** Kept on the sample for documentation: a uniform level is just as valid as cell heights. */
  cells: boolean;
}

/**
 * A shared corner is the mean of the wet, same-class cells around it.
 *
 * `cells` describes the representation of the source tile, not a different liquid body.  A tile
 * with no per-cell array carries one valid level for every wet cell, so excluding it used to make
 * a per-cell/uniform boundary keep a visible step.  The terrain format has no body id beyond the
 * class/entry answer already used by the renderer; adjacency plus that class is the bounded body
 * test.  Undefined samples are dry or not loaded and are deliberately ignored rather than
 * inventing a quad outside the water mask.  The caller supplies at most the four cells sharing a
 * corner, so this helper cannot fan out into more tile lookups.  `neighbours` excludes `base`; the
 * caller already has the current cell and must not count it a second time.
 */
export function waterCornerHeight(
  base: WaterCornerSample,
  neighbours: readonly (WaterCornerSample | undefined)[],
  liquidClass: LiquidClass,
  classes?: ReadonlyMap<number, LiquidClass>,
): number {
  let total = 0;
  let count = 0;
  const add = (sample: WaterCornerSample | undefined): void => {
    if (!sample || !Number.isFinite(sample.height)) return;
    if (liquidClassOf(sample.type, sample.entry, classes) !== liquidClass) return;
    total += sample.height;
    count++;
  };
  add(base);
  for (const sample of neighbours) add(sample);
  return count > 0 ? total / count : base.height;
}

/** A neighbour can only change a water corner when this tile already has a wet surface. */
export function shouldRefreshWaterForNeighbour(water: readonly unknown[] | undefined): boolean {
  return water !== undefined;
}

const UNIT_DRAW_DISTANCE = 220;
/**
 * How far a model's emitters are simulated, and how many sets run at once.
 *
 * A campfire at eighty metres is a few orange pixels and a hundred particles of arithmetic, and
 * the Goldshire tile alone holds more braziers, torches and candles than a frame has room for.
 * Both numbers are flat until slice R8, which is where cost stops being guessed at.
 */
/**
 * Beyond this a placement keeps its stand-in shape rather than downloading its model.
 *
 * The same radius the selection uses, and it was not always: it was 180 against the selection's
 * former 230, and the fifty yards between them were a band where a placement was ranked, kept and drawn
 * as a cone. Probed across the world, that band held a stand-in on 67% of points and averaged 36
 * of them per point — a permanent ring of grey cones around a standing player. Raising it does not
 * draw more: `ENVIRONMENT_BUDGET` still decides how many placements are admitted on a frame. The
 * bounded warm LRU may retain prior nodes, but it never starts a model request for a hidden entry.
 */
export const MODEL_RANGE = ENVIRONMENT_RANGE;
/**
 * The world's furniture: doors, chests, mailboxes, lifts, campfires, and the collision hulls a
 * city is full of.
 *
 * Both numbers are new. There was no budget at all and the radius was a bare `120` written into
 * the filter, so the worst measured circle in a city built and posed 739 nodes every frame, and
 * whatever was over the horizon was rebuilt from nothing the moment it came back.
 */
export const GAMEOBJECT_RANGE = 120;
export const GAMEOBJECT_BUDGET = 96;
/** Spawn-fade quantization for game objects: at most six private material generations per fade. */
const GAMEOBJECT_FADE_STEPS = 6;
/** Extra world-space padding around a conservative static game-object sphere. */
const GAMEOBJECT_FRUSTUM_MARGIN = 1;
/**
 * How near a piece of scenery has to be before it is worth animating, and how many may be.
 *
 * A banner waving at two hundred yards is a mixer step and a bone upload for something two pixels
 * wide. The radius is the emitter radius for the same reason — that is the distance at which small
 * motion stops being visible — and the budget is what stops a courtyard full of rigged doodads
 * from costing more than the creatures standing in it.
 */
export const DOODAD_ANIMATION_RANGE = 90;
export const DOODAD_ANIMATION_BUDGET = 48;
const EFFECT_RANGE = 90;
/** Squared form, so per-frame range checks avoid `Math.hypot`/`sqrt` (sort order is identical). */
const EFFECT_RANGE_SQUARED = EFFECT_RANGE * EFFECT_RANGE;
const EFFECT_BUDGET = 32;
/**
 * New emitter-set builds per frame. Geometry, materials and first texture uploads are all
 * synchronous, so an uncapped burst — a fight starting, a street turning — lands in one frame.
 */
const EFFECT_BUILD_BUDGET = 6;
/** And a separate allowance for what the spells are doing, so the two do not evict each other. */
const VISUAL_EFFECT_BUDGET = 24;
/** A malformed/very long effect clip must not turn a finite packet visual into a permanent node. */
const MODEL_VFX_MAX_MS = 5_000;
/** Time to keep a finite model-backed one-shot alive while its WVM is still loading. */
const MODEL_VFX_LOAD_GRACE_MS = 3_000;
/**
 * How many built looks to keep. A build is a private set of GPU buffers — a human male is about
 * 346 KiB of vertices and indices — so the cache cannot be unbounded now that its key is the
 * costume rather than the race. Well above a full raid, and only looks nobody is wearing go.
 */
export const BUILT_MODEL_CACHE_COUNT_LIMIT = 256;
export const BUILT_MODEL_CACHE_KNOWN_BUFFER_BYTE_LIMIT = 64 * 1024 * 1024;
export const BUILT_UNIT_CACHE_COUNT_LIMIT = 96;
export const BUILT_UNIT_CACHE_KNOWN_BUFFER_BYTE_LIMIT = 64 * 1024 * 1024;
export const WMO_GROUP_GEOMETRY_CACHE_COUNT_LIMIT = 256;
export const WMO_GROUP_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT = 64 * 1024 * 1024;
export const LEGACY_GEOMETRY_CACHE_COUNT_LIMIT = 256;
export const LEGACY_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT = 64 * 1024 * 1024;
export const WMO_WORLD_TEXTURE_CACHE_COUNT_LIMIT = 256;
export const WMO_WORLD_TEXTURE_CACHE_KNOWN_BYTE_LIMIT = 128 * 1024 * 1024;
/**
 * How many units are drawn at once, and how few placements of one model are worth instancing.
 *
 * The unit budget is distance-ranked like every other one here, and it is generous: a full raid
 * against a boss is 40 plus the boss, and this leaves room for the pets and the trash around it.
 * What it stops is a capital city on a holiday, where the grid holds hundreds and the ones behind
 * the player cost a skeleton apiece.
 *
 * Two is the instancing threshold because that is where it starts winning: one draw instead of
 * two. Measured on the nine tiles around Stormwind — 42,797 placements — the selection at six
 * positions inside the city was 120 placements over 8 to 14 distinct models, a ratio of 8.6 to
 * 15.1, and 133 of 148 placements at the gates were of a model that appears more than once.
 */
const UNIT_BUDGET = 64;
/**
 * Character animation LOD rings, in yards.
 *
 * The owner's report on the old rings (full rate inside 16 yards, 6 in a crowd, then 10–20 poses a
 * second): creatures near the edge of the screen "visibly start to twitch". The reference client in
 * CPPClientExample/wowee throttles bones only past 45 yards (every second frame) and 90 (every
 * fourth), and records why: throttling from 10 yards made locomotion a slideshow. The rings are
 * theirs; what pays for full-rate poses inside them is the flat pose (`FastPoseState`).
 */
export const UNIT_ANIMATION_NEAR_DISTANCE = 45;
export const UNIT_ANIMATION_FAR_DISTANCE = 90;

/** Milliseconds between bone poses: every frame near, then 30 and 20 poses a second. */
export function unitAnimationCadenceMs(distance: number, important: boolean): number {
  if (important || distance < UNIT_ANIMATION_NEAR_DISTANCE) return 0;
  if (distance < UNIT_ANIMATION_FAR_DISTANCE) return 1000 / 30;
  return 1000 / 20;
}

export interface UnitAnimationClock {
  pendingSeconds: number;
  nextStepAtMs: number | undefined;
  previousNowMs: number | undefined;
  intervalMs: number;
  /** Stable [0, 1) phase to spread a crowd's bone work across frames. */
  phase: number;
}

/** Returns accumulated mixer time when a pose is due, or undefined when its last pose can be reused. */
export function stepUnitAnimationClock(
  clock: UnitAnimationClock, nowMs: number, elapsedSeconds: number, intervalMs: number,
): number | undefined {
  clock.pendingSeconds += Math.max(0, elapsedSeconds);
  const rewound = clock.previousNowMs !== undefined && nowMs < clock.previousNowMs;
  clock.previousNowMs = nowMs;
  if (rewound || clock.intervalMs !== intervalMs || clock.nextStepAtMs === undefined || intervalMs === 0) {
    clock.intervalMs = intervalMs;
    clock.nextStepAtMs = intervalMs > 0 ? nowMs + intervalMs * (0.5 + clock.phase) : undefined;
  } else if (nowMs < clock.nextStepAtMs) {
    return undefined;
  } else {
    // Keep the original stagger after a slow frame; one mixer step consumes all elapsed time.
    clock.nextStepAtMs += intervalMs * (1 + Math.floor((nowMs - clock.nextStepAtMs) / intervalMs));
  }
  const pending = clock.pendingSeconds;
  clock.pendingSeconds = 0;
  return pending;
}
/** Extra world-space padding around a conservative unit sphere to avoid edge-of-screen pop-in. */
const UNIT_FRUSTUM_MARGIN = 1;
const INSTANCE_MINIMUM = 2;
const UNIT_DEFAULT_HEIGHT = 2;
const UNIT_DEFAULT_RADIUS = 0.45;
const SELF_TINT = 0x4fc47f;
const PLAYER_TINT = 0x5aa2e8;
const CORPSE_TINT = 0x6c6a63;
/** Scratch for the per-display creature tint in `#drawUnit`: `getHex` copies the value out. */
const unitTintScratch = new THREE.Color();
/**
 * Placeholder gait for the capsule stand-ins: a slight bob while a unit is moving. Delete it
 * together with the capsules once skinned M2 models carry their own animations.
 */
const UNIT_BOB_AMPLITUDE = 0.055;
const UNIT_BOB_RATE = 0.012;
const ANIMATION_BLEND = LOOP_ANIMATION_BLEND;
/**
 * How long a one-shot waits for keyframes that have been asked for and have not landed.
 *
 * Long enough for a fetch over a local gateway and short enough that a wave never arrives as a
 * surprise: a gesture that turns up a second late is worse than one that did not happen.
 */
const ACTION_CLIP_WAIT = 900;
/** `SMSG_MOUNTSPECIAL_ANIM` is fire-and-forget; keep it while the mount rig/sidecar catches up. */
const MOUNT_SPECIAL_WAIT = ACTION_CLIP_WAIT;
/**
 * How long a prewarmed spell model keeps being asked for.
 *
 * The request is repeated every frame rather than made once, for two reasons the environment
 * client makes plain: a queued model outside the frame's own footprint is pruned at the end of
 * that frame (`#pruneModelWork`), and a decoded one outside it is an eviction candidate. Asking
 * again is what turns a hopeful request into a resident model. It ends: forty-five seconds is
 * about the longest a player leaves a cast bar and comes back to the same fight.
 */
const SPELL_PREWARM_TTL_MS = 45_000;
/** Distinct model paths held warm at once. One cast is two to four; this is a fight's worth. */
const SPELL_PREWARM_PATH_LIMIT = 24;

function isMaterial(value: unknown): value is THREE.Material {
  return typeof value === "object" && value !== null
    && (value as { readonly isMaterial?: unknown }).isMaterial === true;
}

function visitBuiltModelResources(visitor: RetainedResourceVisitor, built: BuiltModel): void {
  visitGeometryBuffers(visitor, built, built.geometry);
  visitMaterialTextures(visitor, built.materials);
  for (const texture of built.ownedTextures) visitor.referenceGpuTexture(built, texture);
}

function visitSkinnedTemplateResources(visitor: RetainedResourceVisitor, template: SkinnedTemplate): void {
  visitGeometryBuffers(visitor, template, template.geometry);
  visitor.referenceCpu(template, template.parents);
  visitor.referenceCpu(template, template.pivots);
  visitor.referenceCpu(template, template.flags);
  for (const clip of template.clips.values()) {
    for (const track of clip.tracks) {
      if (ArrayBuffer.isView(track.times)) visitor.referenceCpu(clip, track.times);
      if (ArrayBuffer.isView(track.values)) visitor.referenceCpu(clip, track.values);
    }
  }
}

function disposeBuiltModelResources(
  built: BuiltModel,
  geometries: Set<THREE.BufferGeometry>,
  materials: Set<THREE.Material>,
  textures: Set<THREE.Texture>,
): void {
  if (!geometries.has(built.geometry)) {
    geometries.add(built.geometry);
    built.geometry.dispose();
  }
  for (const material of built.materials) {
    if (materials.has(material)) continue;
    materials.add(material);
    material.dispose();
  }
  for (const texture of built.ownedTextures) {
    if (textures.has(texture)) continue;
    textures.add(texture);
    texture.dispose();
  }
}

export class WorldRenderer3D {
  #worldSubmissionCapture: WorldSubmissionCapture | undefined;

  /** Local diagnostic capture only; ordinary frames never install submission hooks. */
  setWorldSubmissionCapture(enabled: boolean): void {
    if (enabled) this.#worldSubmissionCapture ??= new WorldSubmissionCapture();
    else this.#worldSubmissionCapture = undefined;
  }

  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  /** Programs of newly built content, compiled before the frame that would have paid for them. */
  readonly #programWarmup: ProgramWarmup;
  /** The same, for the two leaf scenes: neither shares the world pass's fog or lights. */
  readonly #skyWarmup: ProgramWarmup;
  readonly #overlayWarmup: ProgramWarmup;
  /** And for the full-screen glow chain, whose four passes belong to no traversable node. */
  readonly #glowWarmup: ProgramWarmup;
  /**
   * `getMaxAnisotropy()` is a GL-state query; the answer cannot change without a new context.
   * Seven build paths used to ask it on every model/effect build — including per spell cast —
   * so it is read once and reused.
   */
  #cachedAnisotropy: number | undefined;
  readonly #gpuTimer: GpuTimer<WebGLQuery>;
  readonly #scene = new THREE.Scene();
  /** Background pass: authored transparent sky layers must be drawn before world depth exists. */
  readonly #skyScene = new THREE.Scene();
  readonly #camera = buildWorldCamera();
  readonly #environmentGroup = new THREE.Group();
  /**
   * Instanced scenery draws, kept apart from the placements they stand in for.
   *
   * three's shadow pass walks the scene graph in child order and draws every solid caster with one
   * shared depth material. Each time that material's next object is instanced where the last was
   * not, or the reverse, three re-derives the program parameters and looks the program up again
   * (`setProgram` → `getProgram`: about 2 KB of garbage and a cache-key walk per switch). Buckets
   * added among the placements that arrived around them switched on every bucket, in and out, in
   * every cascade — the movement route's allocation profile put 215 MB in 20 s on that path. Grouped
   * here, after the plain scenery, a pass switches once. Main-pass order is unaffected: three sorts
   * its render lists by material and depth, never by graph order.
   */
  readonly #instanceGroup = new THREE.Group();
  /**
   * Indoor-light instance buckets, after the outdoor ones. An outdoor bucket carries an instance
   * colour attribute and an indoor one carries a light attribute instead, and three's program for
   * the shared depth material differs between the two (`instancingColor`): interleaved by creation
   * order, the shadow pass re-derived it on every bucket — 18 of a city frame's 24 derivations in
   * the bench census (`sceneStats.parameterDerivations`); split, it does so once per cascade.
   */
  readonly #localLightInstanceGroup = new THREE.Group();
  /** Rigged scenery (banners, flags): skinned casters grouped for the same reason as `#instanceGroup`. */
  readonly #animatedEnvironmentGroup = new THREE.Group();
  readonly #gameObjectGroup = new THREE.Group();
  /** Spell visuals live in world coordinates, like the particles they are mostly made of. */
  readonly #visualGroup = new THREE.Group();
  readonly #unitGroup = new THREE.Group();
  /**
   * Where every particle in the world is drawn, in world coordinates and with no transform.
   *
   * One group rather than one per model, because a spark does not belong to the thing that made
   * it: a torch carried past leaves its sparks standing in the air behind it, and parenting them
   * to the torch would drag them along like a bunch of balloons.
   */
  readonly #effectGroup = new THREE.Group();
  /** Authored M2 sky model, camera-locked; the procedural dome remains the fallback. */
  readonly #skyboxGroup = new THREE.Group();
  /** Cloned sky materials need the same global-sequence updates as the shared model build. */
  #skyboxAnimatedBatches: AnimatedBatch[] = [];
  /** Skybox emitters are camera-relative, but still use the normal effect integrator. */
  #skyboxModel: WvmModel | undefined;
  /** Exact shared model build borrowed by the live authored sky. */
  #skyboxBuilt: BuiltModel | undefined;
  #skyboxDecodedModel: EnvironmentModel | undefined;
  #skyboxLegacyGeometry: LegacyGeometryEntry | undefined;
  #skyboxMaterialEntries: readonly WorldMaterialEntry[] | undefined;
  #skyboxVisual: THREE.Object3D | undefined;
  #skyboxSkinned: SkinnedInstance | undefined;
  #skyboxTemplate: SkinnedTemplate | undefined;
  #skyboxAction: THREE.AnimationAction | undefined;
  #skyboxAnimationMs = 0;
  /** Live emitter sets, by `kind:id`. Per placement, never shared: two campfires are two fires. */
  readonly #effects = new Map<string, { effects: ModelEffects; source: WvmModel }>();
  /** Everything the spells currently in the air are showing, in world coordinates. */
  readonly #visuals: RenderedVisual[] = [];
  #visualSequence = 0;
  /** Animations from future spell impacts, held out of #actions until their absolute start. */
  readonly #pendingVisualAnimations: Array<{
    animation: VisualAnimation;
    at: number;
    handle: SpellVisualHandle;
  }> = [];
  readonly #billboard: BillboardView = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
  readonly #boneMatrix = new THREE.Matrix4();
  readonly #environment = new Map<number, RenderedEnvironment>();
  /**
   * Cheap static measurements survive warm-node eviction without retaining their source objects.
   * EnvironmentClient's bounded tile residency owns the keys; this WeakMap owns no model/node/GPU
   * resource and disappears with an evicted immutable placement identity.
   */
  #environmentVisibilitySpheres = new WeakMap<EnvironmentObject, EnvironmentVisibilitySphere>();
  readonly #gameObjects = new Map<bigint, RenderedGameObject>();
  /** Last metadata revision reconciled with all retained game-object admission stamps. */
  #gameObjectMetadataRevision: number | undefined;
  /** Custom animations that arrived before the frame that could play them. */
  readonly #gameObjectAnimations = new Map<bigint, number>();
  readonly #units = new Map<bigint, RenderedUnit>();
  /** 11.02-H: vehicle passengers' seat poses and their place on the vehicle (VehiclePassengerPose.ts). */
  readonly #vehiclePassengers = new VehiclePassengerPoser();
  /** 11.02-tails: scratch for a marked passenger's drawn place, read at once by `#updateSelectionRings`. */
  readonly #ringSeatDrawn = { x: 0, y: 0, z: 0 };
  /** Mount-special packets can arrive before the rider or mount has been admitted and built. */
  readonly #mountSpecials = new Map<bigint, number>();
  /**
   * The rings under the target and the focus, and who they are under.
   *
   * Two meshes rather than one per unit: only two units in the world ever wear one, and rebuilding
   * a geometry when the target changes would be a new buffer every time the player pressed Tab.
   */
  readonly #selectionRings = new Map<"target" | "focus", RenderedSelectionRing>();
  /**
   * The aiming reticle: a point marker and, when the spell names an area radius, its ring.
   *
   * Built on first aim and kept for the session like the selection rings; the meshes are hidden
   * and disposed the moment the reticle is released. Pushed rather than resolved here because the
   * renderer knows nothing about spells or pointers.
   */
  #groundTarget: GroundTargetPreview | undefined;
  readonly #groundTargetRings = new Map<"point" | "radius", RenderedSelectionRing>();
  /**
   * The duel bounds ring, built on the first duelling frame and kept for the session like the
   * selection rings. One mesh: there is only ever one duel flag in the world.
   */
  #duelRing: DuelRing | undefined;
  #duelRingMesh: RenderedSelectionRing | undefined;
  #enchantGlow: ((object: WorldObjectState, slot: number) => EnchantGlow | undefined) | undefined;
  /**
   * The ghost of a placing spell's game object, and the borrowed build it was made from.
   *
   * Only the cloned materials are this owner's; geometry, textures and the built/world caches it
   * borrows are pinned in the eviction pass and shared with every ordinary placement of the model.
   */
  #gameObjectPreview: GameObjectPreview | undefined;
  #gameObjectPreviewNode: {
    model: string;
    node: THREE.Object3D;
    materials: THREE.Material[];
    built?: BuiltModel;
    legacyGeometry?: LegacyGeometryEntry;
    materialEntries?: readonly WorldMaterialEntry[];
  } | undefined;
  /** Rain, snow, sand or fog over the camera. Built on first use: it needs the texture route. */
  #weather: WeatherEffect | undefined;
  /** The last packet, by identity, so its `abrupt` flag is honoured once rather than every frame. */
  #weatherPacket: Weather | undefined;
  #weatherFade: WeatherFade = { kind: "fine", density: 0, storm: 0 };
  #weatherAbrupt = false;
  /** Wind/weather/ambient leaves (AtmosphereEffects.ts); created on the first non-OFF profile. */
  #atmosphere: AtmosphereEffects | undefined;
  #atmosphereProfile: Readonly<AtmosphereProfile> = DEFAULT_ATMOSPHERE_PROFILE;
  #atmosphereFrame: AtmosphereFrame | undefined;
  readonly #atmosphereBuffer = new THREE.Vector2();
  #atmosphereVegetationAt = Number.NEGATIVE_INFINITY;
  #atmosphereMeadow = 0;
  #atmosphereForest = 0;
  #selection: { target: SelectionRing | undefined; focus: SelectionRing | undefined } = { target: undefined, focus: undefined };
  /**
   * The poses the packets asked for — a swing, a cast, an emote, an aura's stance — by unit.
   *
   * Kept here rather than on the unit because they arrive from the network between frames, for
   * units that may not even be on screen yet, and because the animation they resolve to depends on
   * what the unit turns out to be holding when it is drawn. Each unit's requests are ordered by
   * `UnitActionQueue` (state > cast > melee > reaction > emote); an entry disappears with its unit.
   */
  readonly #actions = new Map<bigint, UnitActionQueue<UnitActionPayload, ShownUnitAction>>();
  /** Whether the camera is inside the player, which is the one unit that then must not be drawn. */
  #firstPerson = false;
  /** null marks a model that has downloaded but carries no usable skeleton. */
  readonly #skinnedTemplates = new Map<string, SkinnedTemplate | null>();
  /** Geometry and materials for one doodad model, shared by every placement of it. */
  readonly #builtModels = new BuiltModelCache<BuiltModel>({
    count: BUILT_MODEL_CACHE_COUNT_LIMIT,
    knownBufferBytes: BUILT_MODEL_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  });
  /**
   * The same, for units — one entry per model *and appearance*, because geoset choice and slot
   * resolution both change what is built. Kept apart from the doodad cache because this one is
   * evicted: the key space is every look in view rather than every model in the world.
   */
  readonly #builtUnits = new BuiltModelCache<BuiltModel>({
    count: BUILT_UNIT_CACHE_COUNT_LIMIT,
    knownBufferBytes: BUILT_UNIT_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  });
  /** One name per appearance, so the digest is computed once per look rather than once a frame. */
  readonly #appearanceKeys = new WeakMap<CharacterAppearance, string>();
  /** Bodies, mounts and equipment share one per-frame construction/upload admission slice. */
  readonly #unitBuildBudget = new FrameBuildBudget();
  readonly #unitAnimationBudget = new FrameBuildBudget(2, 1);
  /** Count caps alone allow several expensive ready models to block the same frame. */
  readonly #environmentBuildBudget = new FrameBuildBudget(ENVIRONMENT_BUILD_BUDGET, 2);
  readonly #wmoGroupBuildBudget = new FrameBuildBudget(WMO_GROUP_BUILD_BUDGET, 2);
  readonly #wmoGeometryBuild = new WmoGeometryBuild();
  readonly #gameObjectBuildBudget = new FrameBuildBudget(2, 2);
  readonly #unitAnimationPrefetch = new Map<SkinnedTemplate, string>();
  /** The interface's aura-derived appearance fallback. See `setUnitAuraAppearance`. */
  #auraAppearance: ReadonlyMap<bigint, UnitAuraAppearance> = new Map();
  /** Where the gateway serves textures from, derived from the terrain client on first use. */
  #baseUrl = "";
  /** Monotonic realm/session identity for built caches and asynchronous renderer completions. */
  #worldResourceEpoch = 0;
  /** Composes a player body from its base skin, face, scalp, facial hair and underwear. */
  #atlases: CharacterAtlasClient | undefined;
  /** Raw looks requested by admitted units before a successful build can populate `unit.applied`. */
  readonly #atlasFrameDemands = new Set<string>();
  /** Raw looks carried by units actually admitted through this frame's draw pass. */
  readonly #atlasFrameActive = new Set<string>();
  /** Max body-atlas anisotropy is opt-in pending R1 A/B bandwidth telemetry; 1 remains the default. */
  #characterAtlasAnisotropyEnabled = false;
  /** Reversible graphics leaves; aerial fog shares one uniform pair with world and horizon. */
  #experimentalShaderProfile: Readonly<ExperimentalShaderProfile> = DEFAULT_EXPERIMENTAL_SHADER_PROFILE;
  #renderScale = 1;
  /** While true, UI portrait ownership cannot pin or retain units in a fixed replay. */
  #formalBenchmarkIsolation = false;
  /** Loss/restoration invalidates the GPU resource epoch even when dimensions later match again. */
  #webGlContextGeneration = 0;
  #disposed = false;
  readonly #contextLostListener = (): void => { this.#webGlContextGeneration++; };
  readonly #contextRestoredListener = (): void => {
    this.#webGlContextGeneration++;
    // three rebuilt its program cache (and the array the float setters hook) before this listener.
    useFloatUniformSetters(this.#renderer);
  };
  /** Five UI model views, all rendered through the one world WebGLRenderer. */
  readonly #portraits: PortraitRenderer;
  /** Unit radius 0.5 and length 1 give a capsule exactly two units tall, so scaling is a ratio. */
  readonly #unitBodyGeometry = new THREE.CapsuleGeometry(0.5, 1, 4, 12);
  readonly #unitFacingGeometry = new THREE.ConeGeometry(0.16, 0.42, 4);
  /** Bounded exact owners for legacy static geometry and legacy unit templates. */
  readonly #legacyGeometries = new BuiltModelCache<LegacyGeometryEntry>({
    count: LEGACY_GEOMETRY_CACHE_COUNT_LIMIT,
    knownBufferBytes: LEGACY_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  });
  #legacyModelKeys = new WeakMap<EnvironmentModel, string>();
  #legacySkinnedFailures = new WeakSet<EnvironmentModel>();
  #legacyModelSerial = 0;
  /** One converted group per exact decoded WMO parent and index. Placements borrow its geometry. */
  readonly #wmoGeometries = new BuiltModelCache<WmoGroupGeometryEntry>({
    count: WMO_GROUP_GEOMETRY_CACHE_COUNT_LIMIT,
    knownBufferBytes: WMO_GROUP_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  });
  /** Completed this frame but waiting for material admission; protect until the next frame. */
  readonly #wmoPreparedGeometryPins = new Set<WmoGroupGeometryEntry>();
  /**
   * Freshly attached rooms kept hidden until the programs of their runs are linked, with the frames
   * each has waited. See `#releaseWarmWmoGroups`.
   */
  readonly #wmoWarmHolds = new Map<THREE.Mesh, number>();
  /** New doodad and game-object visuals waiting for their programs; see `#wvmNode`. */
  readonly #visualWarmHold = new WarmHold(VISUAL_WARM_HOLD_FRAMES, (object) => this.#visualProgramsWarm(object as THREE.Mesh));
  /**
   * New emitter sets waiting for their programs; see `#updateEffects`.
   *
   * A set is built, registered with the warm pass and drawn on the same frame, so a blend of
   * emitter switches the world had not drawn yet linked its program inside the submit — the city
   * bench's one 34 ms frame at its eighteenth second, on every run. Held like a new visual, the
   * link runs in the warm pass and the set appears a frame or two later, mid-life.
   */
  readonly #effectWarmHold = new WarmHold(VISUAL_WARM_HOLD_FRAMES, (object) => this.#effectProgramsWarm(object));
  /** Session-local exact parent identities used only to make cache keys stable and compact. */
  #wmoModelKeys = new WeakMap<WmoModel, string>();
  #wmoModelSerial = 0;
  /** Dedicated canonical world bases; WMO and legacy materials own exact leases through the cache. */
  #worldMaterialTextures = new ModelTextureLoader({
    cache: true,
    limits: {
      count: WMO_WORLD_TEXTURE_CACHE_COUNT_LIMIT,
      knownLogicalTextureBytes: WMO_WORLD_TEXTURE_CACHE_KNOWN_BYTE_LIMIT,
    },
  });
  /** Exact bounded WMO and legacy run materials. Recreated with their texture lane between realms. */
  #worldMaterials = new WorldMaterialCache(this.#worldMaterialTextures, {
    limits: { count: WORLD_MATERIAL_CACHE_COUNT_LIMIT },
  });
  /** Settled/disposed lanes accumulate here so readiness never moves backwards on replacement. */
  #worldMaterialGenerationOffset = 0;
  readonly #foliageGeometry = new THREE.DodecahedronGeometry(1, 1);
  readonly #trunkGeometry = new THREE.CylinderGeometry(0.35, 0.5, 2, 7);
  /**
   * Weather textures have their own surface flags and no fallback. World-model surfaces use the
   * exact leased cache below instead; keeping this loader weather-only prevents an unbounded second
   * URL cache from silently reappearing beside it.
   */
  readonly #textureLoader = new THREE.TextureLoader();
  /** Generic world textures are not URL-cached here, so readiness owns one counter per request. */
  #worldTexturesPending = 0;
  /** Current terminal generic texture failures; a later successful load clears its URL. */
  readonly #worldTextureErrors = new Set<string>();
  /** Monotonic settle generation, including synchronous loader throws. */
  #worldTextureGeneration = 0;
  /**
   * Model textures — a character's hair, its armour, a creature's skin — through the client's one
   * loader for them, shared with `character-lab.html` so that it stays one path.
   *
   * The lab exists to show what the renderer draws; a second loader beside this one would have its
   * own idea of what a failed fetch looks like, and that is precisely the behaviour under study.
   */
  readonly #textures = new ModelTextureLoader();
  /** Scoped cache for spell mesh/emitter maps; ordinary model builds retain their own disposal ownership. */
  readonly #spellTextures = new ModelTextureLoader({ cache: true });
  readonly #worldLight = createWorldLightUniforms();
  readonly #localLightSelection = new LocalLightSelection();
  readonly #localLightSample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };
  readonly #localLightMatrix = new THREE.Matrix4();
  readonly #zoneFogColour = new THREE.Color(SKY_COLOR);
  #zoneFogNear = 180;
  #zoneFogFar = 640;
  /** Shared by WMO-only materials; reset to the zone each frame, then optionally set to MFOG. */
  readonly #wmoInteriorFog: WmoInteriorFogUniforms = {
    colour: { value: new THREE.Color(SKY_COLOR) },
    near: { value: 180 },
    far: { value: 640 },
  };
  /** The Light.dbc slot is selected by the camera eye; land MFOG must not overwrite it underwater. */
  #underwater = false;
  /**
   * The liquid surface over the camera this frame, or nothing where the eye is nowhere near one.
   *
   * Separate from `#underwater` above, which is a boolean about a light slot and stays one: the
   * screen effect starts a near plane's half-height *before* the eye crosses, so the two answers
   * are true over different intervals and neither can be derived from the other.
   */
  #underwaterSurface: Readonly<UnderwaterSurface> | undefined;
  /** The account's leaf switch. Off restores the exact two-render frame that pre-dates the pass. */
  #underwaterOverlayEnabled = true;
  /** Collision-selected static WMO floor and its one unambiguous visual placement this frame. */
  #wmoFloor: StaticWmoFloor | undefined;
  #wmoFogVisualId: number | undefined;
  /** The floor's visual placement, found by a scan of every loaded placement only when its inputs change. */
  readonly #wmoFloorVisuals = new UniqueVisualWmoPlacementCache();
  /** Authored fog proposed by that exact placement/group; applied once after traversal. */
  #wmoFogCandidate: { fog: WmoFog; key: string } | undefined;

  #loadTexture(url: string): THREE.Texture {
    return this.#textures.load(url);
  }

  #acquireSpellTexture(visual: RenderedVisual, url: string): THREE.Texture {
    let lease = visual.textureLeases.get(url);
    if (!lease) {
      lease = this.#spellTextures.acquire(url, visual);
      visual.textureLeases.set(url, lease);
    }
    return lease.texture;
  }

  /** The owner token every prewarmed lease carries, so pressure diagnostics can name the holder. */
  readonly #spellWarmOwner = Object.freeze({ owner: "spell-prewarm" });
  /**
   * Prewarmed spell texture claims.
   *
   * These are held by nobody visible: no cast owns them, no phase is waiting on them, and
   * `#spellTextures.evictUnleased()` runs at the end of every frame. Without a claim the prewarm
   * would fetch a texture and then let it be thrown away before the cast that wanted it — the trap
   * this pool exists for. Bounded by cap, TTL and teardown; see `WarmLeasePool`.
   */
  readonly #spellWarmTextures = new WarmLeasePool((url) => {
    try {
      return this.#spellTextures.acquire(url, this.#spellWarmOwner);
    } catch {
      // A lost cache request is not worth failing a frame over; the real cast still loads it.
      return undefined;
    }
  });
  /** Prewarmed model paths and when each claim expires. Insertion order is the LRU order. */
  readonly #spellPrewarmPaths = new Map<string, number>();

  /**
   * Starts fetching what a cast is about to draw, before it draws it.
   *
   * A cold spell used to pay three serial round trips *after* the cast: metadata, then the model
   * (first asked for inside `#updateVisuals`), then its textures, with the whole phase held
   * invisible until the last one landed. This is the seam that spends the cast bar instead.
   */
  prewarmSpellModels(paths: readonly string[]): void {
    for (const path of paths) this.prewarmSpellModel(path);
  }

  prewarmSpellModel(path: string): void {
    if (!path) return;
    // Zero means "not stamped yet": the deadline is set by the first pump that sees it, on the
    // frame clock. A packet handler has no access to that clock, and under a formal replay it is
    // not `performance.now()` at all — a mixed pair of clocks would expire claims at random.
    // Re-warming moves the path to the back of the LRU and restarts its lifetime.
    this.#spellPrewarmPaths.delete(path);
    this.#spellPrewarmPaths.set(path, 0);
    while (this.#spellPrewarmPaths.size > SPELL_PREWARM_PATH_LIMIT) {
      const oldest = this.#spellPrewarmPaths.keys().next();
      if (oldest.done) break;
      this.#spellPrewarmPaths.delete(oldest.value);
    }
  }

  /**
   * One frame's worth of prewarming, inside the environment client's own resource frame.
   *
   * Being inside it is the whole point: a model asked for outside the frame is not part of its
   * footprint, so the request is pruned when the frame commits and the decoded answer is an
   * eviction candidate the moment it arrives. Asking again every frame keeps the claim honest,
   * and the TTL is what makes it stop.
   */
  #pumpSpellPrewarm(now: number, client: EnvironmentClient | undefined): void {
    if (this.#spellPrewarmPaths.size === 0) {
      this.#spellWarmTextures.expire(now);
      return;
    }
    for (const [path, expiresAt] of [...this.#spellPrewarmPaths]) {
      if (expiresAt === 0) {
        this.#spellPrewarmPaths.set(path, now + SPELL_PREWARM_TTL_MS);
      } else if (now >= expiresAt) {
        this.#spellPrewarmPaths.delete(path);
        continue;
      }
      // "normal", never "critical": what is on screen now outranks what might be cast in a second.
      const prewarmed = client?.model(path, "normal");
      if (!prewarmed?.wvm) continue;
      // The model is here, so its own texture list is knowable — which collapses the second and
      // third round trips into one. The claims below are what keep them collapsed.
      for (const texturePath of modelOwnTexturePaths(prewarmed.wvm)) {
        this.#spellWarmTextures.warm(textureUrl(this.#baseUrl, texturePath), now);
      }
    }
    this.#spellWarmTextures.expire(now);
  }

  /**
   * All direct world TextureLoader calls pass through this wrapper. The callbacks remain unchanged
   * for callers, while the readiness counter is balanced exactly once for synchronous and normal
   * asynchronous completion (including a misbehaving loader that calls both callbacks).
   */
  #loadWorldTexture(
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): THREE.Texture {
    const epoch = this.#worldResourceEpoch;
    let settled = false;
    this.#worldTexturesPending++;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      if (epoch !== this.#worldResourceEpoch) return;
      this.#worldTexturesPending--;
      this.#worldTextureGeneration++;
      if (success) this.#worldTextureErrors.delete(url);
      else this.#worldTextureErrors.add(url);
    };
    try {
      return this.#textureLoader.load(
        url,
        (texture) => {
          settle(true);
          if (epoch === this.#worldResourceEpoch) onLoad?.(texture);
        },
        onProgress,
        (error) => {
          settle(false);
          if (epoch === this.#worldResourceEpoch) onError?.(error);
        },
      );
    } catch (error) {
      settle(false);
      throw error;
    }
  }

  /**
   * Readiness of every authored texture a spell model can expose.
   *
   * WVM bytes and geometry are intentionally allowed to arrive before images, but a spell phase
   * must not become visible in that interval: alpha/additive maps otherwise make the same Judgement
   * kit look like a hammer on one frame and particles on the next.  Calling `load` here also
   * prefetches emitter-only slots before the effects budget builds them, so mesh and particle parts
   * share one cached request and one release decision.
   */
  #spellAssetState(visual: RenderedVisual): { ready: boolean; failed: boolean } {
    let pending = false;
    let failed = false;
    for (const path of modelOwnTexturePaths(visual.wvm!)) {
      const texture = this.#acquireSpellTexture(visual, textureUrl(this.#baseUrl, path));
      const status = this.#spellTextures.status(texture);
      if (status === "failed") failed = true;
      if (status !== "ready") pending = true;
    }
    return { ready: !pending && !failed, failed };
  }
  readonly #terrains = new Map<string, RenderedTerrain>();
  /** The far horizon: one mesh for every distant tile, rebuilt when the player changes tile. */
  #horizon: { mesh: THREE.Mesh; key: string } | undefined;
  readonly #horizonMaterial = new THREE.MeshBasicMaterial({ color: 0x4a6b4f, fog: true });
  readonly #wmoMaterial = new THREE.MeshStandardMaterial({ color: 0x927d62, roughness: 0.92, side: THREE.DoubleSide, flatShading: true });
  readonly #m2Material = new THREE.MeshStandardMaterial({ color: 0x73835e, roughness: 0.95, side: THREE.DoubleSide, flatShading: true });
  readonly #stoneMaterial = new THREE.MeshStandardMaterial({ color: 0x747b80, roughness: 1, side: THREE.DoubleSide, flatShading: true });
  readonly #woodMaterial = new THREE.MeshStandardMaterial({ color: 0x765138, roughness: 1, side: THREE.DoubleSide, flatShading: true });
  readonly #metalMaterial = new THREE.MeshStandardMaterial({ color: 0x66727a, roughness: 0.66, metalness: 0.42, side: THREE.DoubleSide, flatShading: true });
  readonly #foliageMaterial = new THREE.MeshStandardMaterial({ color: 0x3f743d, roughness: 1, flatShading: true });
  /** At most one lazy stand-in per liquid class; water hooks are attached only to water/ocean. */
  readonly #fallbackLiquidMaterials = new Map<LiquidClass, THREE.MeshBasicMaterial>();
  /** A zero-energy directional light retained solely so three builds and samples its shadow map. */
  readonly #sun = new THREE.DirectionalLight(0xffffff, 0);
  /**
   * Lighting qualities 1 and 2 split the sun's map into cascades; `#sun` becomes cascade 0 and is
   * handed back unchanged at quality 0. See CascadedShadows.ts.
   */
  readonly #sunCascades = new CascadedSunShadows(this.#sun, this.#worldLight.wowShadowFade);
  /** Retained scenery shown for the shadow pass only, restored right after it. */
  readonly #shadowOnlyNodes: THREE.Object3D[] = [];
  readonly #sunOffset = new THREE.Vector3(0, 400, 0);
  /** Allocation-free solar projection scratch; unlike #sunOffset, this may go below the horizon. */
  readonly #godRaySun = new THREE.Vector3();
  readonly #godRayCameraForward = new THREE.Vector3();
  readonly #godRayCameraUp = new THREE.Vector3();
  readonly #godRayProjection = new THREE.Vector3();
  readonly #godRayScreenSource: GodRayScreenSource = {
    ndcX: 0, ndcY: 0, visibilityY: 0, facing: 0,
  };
  #lightingProfile: LightingProfile = lightingProfile(0, { shadowMaps: false, maxTextureSize: 0 });
  readonly #skyUniforms = {
    skyTop: { value: new THREE.Color(0x001f49) },
    skyUpper: { value: new THREE.Color(0x3aa2cf) },
    skyMiddle: { value: new THREE.Color(0x99dcf5) },
    skyLower: { value: new THREE.Color(0xafdae0) },
    skyHorizon: { value: new THREE.Color(0xb4b4b4) },
    skyFog: { value: new THREE.Color(SKY_COLOR) },
  };
  readonly #sky = buildSky(this.#skyUniforms);
  /**
   * The underwater pass, held ready and drawn on the frames that ask for it.
   *
   * `time` is written from the frame's own `now`, like the water materials' clock beside it, so a
   * deterministic replay ripples the same seam twice. Nothing here is per-frame allocated: the
   * uniform objects are the ones the material compiled against.
   */
  readonly #underwaterUniforms = {
    invViewProj: { value: new THREE.Matrix4() },
    /** rgb tint, a = opacity when the whole view is under. */
    tint: { value: new THREE.Vector4(0, 0, 0, 0) },
    /** World Z of the surface, which this scene compares against its own Y. */
    waterZ: { value: 0 },
    /** x = meniscus half-thickness, y = seconds, z = ripple amplitude, w = 1 while a seam is on screen. */
    params: { value: new THREE.Vector4(UNDERWATER_MENISCUS_YARDS, 0, UNDERWATER_RIPPLE_YARDS, 1) },
  };
  readonly #overlayScene = new THREE.Scene();
  /** Clip space is already what the triangle is written in, so this camera adds nothing to it. */
  readonly #overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly #underwaterOverlay = buildUnderwaterOverlay(this.#underwaterUniforms);
  /**
   * The shared full-screen chain, born as the classic `ffxGlow` and also used by optional sun shafts.
   *
   * The materials and the triangle exist for the life of the renderer and cost nothing while the
   * leaf is off — no program is compiled until something is drawn with them. The render targets are
   * the expensive half, and they exist only while the leaf is on (`#syncFullscreenGlowTargets`).
   */
  readonly #glowPasses = buildFullscreenGlowPasses();
  /**
   * The enhanced cinematic leaves (grade, bloom, scattering, occlusion), composited from the same
   * capture. Inactive - the default - means the renderer never calls into it and the classic
   * composite or the direct path is the frame. `CinematicPost.ts` carries the argument.
   */
  readonly #cinematic = new CinematicPost();
  /** Scratch for the per-frame light push; never reallocated. */
  readonly #cinematicSun = new THREE.Vector3();
  readonly #cinematicLight = {
    diffuse: { r: 1, g: 1, b: 1 }, ambient: { r: 1, g: 1, b: 1 }, fog: { r: 1, g: 1, b: 1 },
    fogFar: 640, sun: { x: 0, y: 1, z: 0 }, storm: 0, underwater: false, indoors: false,
    glow: undefined as number | undefined,
  };
  /** The account's cinematic leaves; the effective profile is empty while lighting quality is 0. */
  #cinematicRequested: Readonly<Partial<CinematicProfile>> | undefined;
  /** Frames since scenery shadow flags were last reconciled with the streamed environment. */
  #sceneryShadowFrame = 0;
  /** Whether any environment mesh may currently carry cast/receive flags set by that leaf. */
  #sceneryShadowsApplied = false;
  /** Fold of the meshes the cached shadow cascade drew; a different fold re-renders it. */
  #sceneryFarCasters = 0;
  /** Each attached WMO room's depth-only shadow stand-in, or null where it has no solid run. */
  readonly #wmoShadowProxies = new WeakMap<THREE.Mesh, THREE.Mesh | null>();
  /** Water profile with the cinematic water leaves folded in; rebuilt only when either changes. */
  #cinematicWaterProfile: Readonly<ExperimentalShaderProfile & {
    waterSunGlitter: boolean; waterSkyReflection: boolean;
  }> | undefined;
  /** Default ON: this is how the original client looks. Off is the exact pre-P4 direct path. */
  #fullscreenGlowEnabled = true;
  /** Faithful-plus leaf. Default OFF until the player explicitly accepts the extra depth pass. */
  #godRaysEnabled = false;
  /**
   * «Сила солнечных лучей» / 100, over the profile ceiling on both shaft paths. It never decides
   * whether the effect runs: `#godRaysActive` reads the switch and the lighting quality only.
   */
  #godRayStrengthScale = 1;
  /**
   * `LightParams.Glow` where the camera stands, already blended across volumes by `LightClient`.
   *
   * Zero is an ordinary authored answer, not an absence: Ironforge (light 16) and Dalaran (light
   * 1802) both author exactly 0 while Darnassus authors 1. Held here rather than read per frame
   * because `draw()` may not reach into the loop's clients.
   */
  #glowStrength = 0;
  #glowTargets: GlowChainTargets | undefined;
  readonly #liquidMaterials = new Map<LiquidClass, LiquidMaterial>();
  readonly #waterShaderUniforms: WaterShaderSharedUniforms = createWaterShaderSharedUniforms();
  /** Ripple normal maps for the enhanced water; fetched only once a cinematic water leaf is on. */
  readonly #waterDetailMaps = new WaterDetailNormalMaps(this.#waterShaderUniforms);
  #liquidTextures: LiquidTextureClient | undefined;
  #lightSample: LightSample | undefined;
  #lightTime = 0;
  #skyboxPath: string | undefined;
  #skyboxLoadedPath: string | undefined;
  #realModels = 0;
  #lastFrame = performance.now();
  /** Present only between deterministic replay epoch boundaries. */
  #replaySeed: number | undefined;
  /** Lifetime proof serial for successful sky + world submissions; replay resets never rewind it. */
  #submissionSerial = 0;
  /** Previous frame's camera angles; undefined until the first drawn frame. */
  #lastCameraYaw: number | undefined;
  #lastCameraPitch: number | undefined;
  /** Smoothed camera turn rate in radians per second, for sustained-sweep suppression. */
  #cameraTurnRate = 0;
  /** Grow-ins stay suppressed while the submission serial is below this. */
  #turnSuppressUntilSerial = 0;
  /** Submission serial the WMO room-build budget was last reset on. */
  #wmoGroupBuildSerial = -1;
  /** WMO rooms built since that reset, across every admitted building. */
  #wmoGroupBuilds = 0;
  #wmoGroupsPending = 0;
  /** The last two seconds of frame times, and what the last frame cost the GPU. */
  readonly #frames = new FrameClock();
  readonly #cadence = new FrameCadenceClock();
  /** One outer renderer envelope may contain the world pass and several dirty portrait passes. */
  #renderFrameDepth = 0;
  #renderFrameStartedAt: number | undefined;
  #renderFrameGpuActive = false;
  #renderFrameAutoReset = true;
  #drawCalls = 0;
  #triangles = 0;
  /**
   * Milliseconds per draw phase of the last `draw()` call, mutated in place and never reallocated.
   *
   * Read through {@link drawPhaseMs} right after `draw()` returns: a later draw overwrites it,
   * and the loop copies the numbers into a hitch record rather than retaining the object. This
   * is what tells a JS-side build burst (terrain/env/units) apart from driver-side submission
   * cost (texture uploads and program compiles inside the two `renderer.render` calls).
   */
  readonly #drawPhaseMs: Record<string, number> = {
    setup: 0,
    terrain: 0,
    env: 0,
    ground: 0,
    objects: 0,
    units: 0,
    visuals: 0,
    warm: 0,
    evict: 0,
    submit: 0,
    "units.appearance": 0,
    "units.pose": 0,
    "units.presentation": 0,
    "submit.sky": 0,
    "submit.world": 0,
    "submit.postprocess": 0,
  };
  /**
   * Crowd poses on a worker (`PoseEngine.ts`): the page's engine when the page is cross-origin
   * isolated, otherwise undefined and every flat pose stays `FastPoseState`.
   */
  readonly #poseEngine: PoseEngine | undefined = pagePoseEngine();
  /** How many units were drawn last frame, and how many the budget turned away. */
  #unitsDrawn = 0;
  #unitsDropped = 0;
  #unitAnimationNear = 0;
  #unitAnimationMedium = 0;
  #unitAnimationFar = 0;
  #unitAnimationCritical = 0;
  #unitAnimationFull = 0;
  /** Of the posed units, those posed through the flat pose rather than Three's bone objects. */
  #unitAnimationFlat = 0;
  #unitAnimationSkipped = 0;
  /** Rigs a reader asked a bone of that their flat pose does not compute; they keep Three's path. */
  readonly #fullPoseRigs = new WeakSet<RigSkeleton>();
  /** Which of the units drawn last frame are still capsules, and what stopped each of them. */
  readonly #standIns = new StandInLedger();
  #gameObjectsDrawn = 0;
  #gameObjectsDropped = 0;
  #doodadsPosed = 0;
  /** Optional portal refinement applies only to static environment WMOs, never live objects. */
  #wmoOcclusion = true;
  #wmoPortalModels = 0;
  #wmoPortalCandidates = 0;
  #wmoPortalCulled = 0;
  /**
   * The same pair for emitters, and what the GPU is holding.
   *
   * Both are here because a defect was argued about with neither: an emitter budget that is never
   * reached and a texture count that never stops growing look identical from outside, and the
   * client measured neither. The texture and geometry counts are three's own tally of live GPU
   * objects, so a leak shows as a number that only rises while the player stands still.
   */
  #effectsDrawn = 0;
  #effectsDropped = 0;
  /** Unbudgeted distance residents, kept until the player has walked far enough to change them. */
  #environmentCandidates: RankedEnvironmentObject[] = [];
  /** Loaded-zone residents: the draw set plus the hysteresis band. Disposal reads this. */
  #environmentResidents: RankedEnvironmentObject[] = [];
  #residentMembership: {
    source: readonly RankedEnvironmentObject[];
    values: ReadonlyMap<number, EnvironmentObject>;
  } | undefined;
  #admittedMembership: {
    source: readonly RankedEnvironmentObject[];
    values: ReadonlySet<number>;
  } | undefined;
  /** Prefetch sweep state: the candidate array the cursor rotates through, if any. */
  #prefetchCandidates: readonly RankedEnvironmentObject[] | undefined;
  #prefetchCursor = 0;
  #prefetchNames: readonly string[] = [];
  #environmentCandidatesAt: { x: number; y: number; generation: number } | undefined;
  /** The stock `environmentDetail` multiplier on M2 scenery leashes; see `setEnvironmentDetail`. */
  #environmentDetail = 1;
  /** Frame on which the candidate set above was last reselected; the grass rebuild avoids it. */
  #environmentReselectedSerial = -1;
  /** Last submitted frame the warm caps were enforced on; see `WARM_PRUNE_INTERVAL_FRAMES`. */
  #warmPruneAtSerial = -WARM_PRUNE_INTERVAL_FRAMES;
  /** Admitted set reused on calm skipped frames; see the admission gate in `#updateEnvironment`. */
  #lastAdmitted: RankedEnvironmentObject[] | undefined;
  /** Candidate array the cached admission was computed from; a new one always recomputes. */
  #admissionCandidates: readonly RankedEnvironmentObject[] | undefined;
  /** Placements currently growing in; while zero the growth scan is skipped entirely. */
  #growingVegetation = 0;
  /** Bumped whenever `objectsAround` hands over a different array, which is when a tile lands. */
  #environmentGeneration = 0;
  readonly #terrainWindow = new TerrainStreamingWindow();
  #terrainPlan: TerrainStreamingPlan | undefined;
  #terrainPreparation: TerrainPreparation | undefined;
  #terrainRepair: TerrainRepair | undefined;
  #terrainRepairsPending = 0;
  #environmentObjects: readonly EnvironmentObject[] | undefined;
  #environmentSpatialIndex: EnvironmentSpatialIndex | undefined;
  /** One `InstancedMesh` per repeated doodad model, and the placements it stands in for. */
  /** Bucket lists reused across `#updateInstances` rebuilds; see there. */
  readonly #instanceBuckets = new Map<string, RenderedEnvironment[]>();
  readonly #instances = new Map<string, {
    mesh: THREE.InstancedMesh;
    capacity: number;
    built: BuiltModel;
    /** Placement-owned material and attribute state for an indoor-light bucket. */
    localLight?: {
      materials: readonly THREE.Material[];
      attribute: THREE.InstancedBufferAttribute;
    };
  }>();
  readonly #instanceTint = new THREE.Color();
  /** Set when a placement is made or dropped: the matrices themselves never change. */
  #instancesDirty = false;
  /**
   * Шаг 19: fresh instanced meshes kept hidden until the warm pass has linked their programs, with
   * the frames waited and the copies that keep drawing as their own nodes meanwhile.
   */
  readonly #instanceWarmHolds = new Map<THREE.InstancedMesh, { frames: number; nodes: THREE.Object3D[] }>();
  /**
   * Units whose new body waits hidden for its programs (`#holdUnitUntilWarm`): frames waited, the
   * cap, where the paused fade clock last stood, and what `#drawUnit` wanted shown on which frame.
   */
  readonly #unitWarmHolds = new Map<RenderedUnit, {
    frames: number; readonly cap: number; clockAt: number; visible: boolean; serial: number;
  }>();
  /** Weapons, helmets and mounts hung on a unit already on screen, hidden until their programs link. */
  readonly #unitPartWarmHolds = new Map<THREE.Mesh, { readonly unit: RenderedUnit; frames: number }>();
  /** Unit meshes whose fade stand-ins are registered; each is looked at once, when it is hung. */
  readonly #unitWarmTracked = new WeakSet<THREE.Object3D>();
  /**
   * One program stand-in per shared unit material for all of its faded copies
   * (`createFadeProgramTwin`), with the source state it was made from and its disposal.
   */
  readonly #fadeTwins = new WeakMap<THREE.Material, {
    readonly twin: THREE.Material; readonly version: number; readonly key: string; readonly drop: () => void;
  }>();
  /** The capsule's opaque and translucent program stand-ins, shared by every pill. */
  #capsuleTwins: { readonly opaque: THREE.Material; readonly faded: THREE.Material } | undefined;
  /**
   * The grass, kept entirely apart from the placements above.
   *
   * A field of three and a half thousand tufts must never reach `#environment`: that map costs one
   * `Object3D`, one entry and one model lookup each, and `selectEnvironment` ranks what is in it.
   * Ground cover has no ids, no bounds and nothing to rank — it is scattered from a recipe inside
   * its own radius and written straight into one instanced draw per model.
   */
  readonly #groundCoverGroup = new THREE.Group();
  readonly #groundCoverFade = createGroundCoverFadeUniforms();
  readonly #groundCoverMeshes = new Map<string, {
    mesh: THREE.InstancedMesh;
    capacity: number;
    built: BuiltModel;
  }>();
  #groundCover: GroundCoverClient | undefined;
  #groundCoverRadius = 0;
  #groundCoverDense = true;
  /** Multiplier over the authored per-cell density; rescatters through `#groundCoverSettings`. */
  #groundCoverDensity = 2;
  #groundCoverField: GroundCoverField | undefined;
  /** Models whose artifact has not arrived yet, retried on the frames between rebuilds. */
  readonly #groundCoverPending = new Set<string>();
  #groundCoverAt: { x: number; y: number; map: number; generation: number } | undefined;
  /**
   * Cells the last scatter grew, valid for one map and one generation. A rebuild four yards on
   * shares nearly all of them, and reusing them gives exactly the field a fresh scatter would.
   */
  #groundCoverCells = createGroundCoverCellCache();
  #groundCoverCellsKey: string | undefined;
  /** Frame a walked rebuild last waited on; it waits at most one frame in a row. */
  #groundCoverDeferredSerial = -1;
  /** Bumped by a setting, so a radius the player has just moved takes effect on the next frame. */
  #groundCoverSettings = 0;
  /** Selected scatter state survives a frame; drawn is recomputed from submitted meshes each frame. */
  #groundCoverSelected = 0;
  #groundCoverSelectionDroppedCells = 0;
  #groundCoverDrawn = 0;
  readonly #frustum = new THREE.Frustum();
  readonly #frustumMatrix = new THREE.Matrix4();
  readonly #unitSphere = new THREE.Sphere();
  readonly #wmoModelToClip = new THREE.Matrix4();
  readonly #wmoCameraModel = new THREE.Vector3();
  readonly #wmoViewerModel = new THREE.Vector3();
  /** Whether the character is under a roof, answered by the collision floor and told to us. */
  #indoors = false;
  /**
   * The collision models, which is where a building's own water lives.
   *
   * A WMO carries liquid the tile underneath knows nothing about — Stormwind's canals are five
   * grids inside the city model, and the map file has no liquid under the city at all — and the
   * extractor already copies that grid into the `.vmo` the collision route serves. It was being
   * read and thrown away in two lines; now it travels, and this is the client that has it.
   */
  #collisionModels: ((name: string) => CollisionModel | undefined) | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    // Before the first material: three copies `tonemapping_pars_fragment` into every program it
    // builds and does not put the chunk's text in the program cache key, so a later swap would
    // leave already-compiled shaders on the old curve.
    THREE.ShaderChunk.tonemapping_pars_fragment = withToneShoulder(THREE.ShaderChunk.tonemapping_pars_fragment);
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    // three fetches shader info logs on every program link while this is on. The official
    // guidance is to disable it in production for performance gain; development (and unit tests,
    // where there is no Vite env at all) keeps the loud shader errors.
    this.#renderer.debug.checkShaderErrors = rendererDebugShaderErrors();
    useFloatUniformSetters(this.#renderer);
    canvas.addEventListener("webglcontextlost", this.#contextLostListener);
    canvas.addEventListener("webglcontextrestored", this.#contextRestoredListener);
    this.#gpuTimer = createWebGlGpuTimer(this.#renderer.getContext(), renderBenchmarkGpuObserver);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.CustomToneMapping;
    this.#portraits = new PortraitRenderer(this.#renderer, (guid) => this.#portraitSource(guid));
    // Fog and background share a colour, otherwise the horizon shows the seam between them. Both
    // are only the starting values now: `updateLighting` replaces them from the map's own tables as
    // soon as the world clock and the light volumes have arrived.
    this.#scene.background = new THREE.Color(SKY_COLOR);
    this.#scene.fog = new THREE.Fog(SKY_COLOR, 180, 640);
    // The main scene is rendered after the sky pass with autoClear disabled. Keeping its
    // background null prevents WebGLBackground from clearing the authored sky before world depth
    // is composited; #skyScene owns both the procedural dome and transparent LightSkybox batches.
    this.#skyScene.background = this.#scene.background;
    this.#scene.background = null;
    this.#skyboxGroup.renderOrder = 0;
    this.#skyScene.add(this.#sky, this.#skyboxGroup);
    // Its own scene, so nothing in the world pass can sort against it and nothing here can be
    // drawn by accident: this scene is submitted only by `#drawUnderwaterOverlay`, and only on the
    // frames where the camera is in or entering liquid.
    this.#overlayScene.add(this.#underwaterOverlay);
    // Stand-ins and legacy merged artifacts do not pass through ModelBuild, but removing the
    // HemisphereLight must not turn them black. Give every shared lit fallback the same authored
    // equation before any of them can compile.
    for (const material of [
      this.#wmoMaterial, this.#m2Material, this.#stoneMaterial,
      this.#woodMaterial, this.#metalMaterial,
    ]) applyWorldLight(material, this.#worldLight, "surface");
    applyWorldLight(this.#foliageMaterial, this.#worldLight, "foliage");
    applyHorizonAerialFog(this.#horizonMaterial, this.#worldLight);
    // Names only label the branches for diagnostics; nothing resolves these groups by name.
    this.#environmentGroup.name = "environment";
    this.#animatedEnvironmentGroup.name = "animatedEnvironment";
    this.#instanceGroup.name = "instances";
    this.#localLightInstanceGroup.name = "localLightInstances";
    this.#groundCoverGroup.name = "groundCover";
    this.#gameObjectGroup.name = "gameObjects";
    this.#unitGroup.name = "units";
    this.#effectGroup.name = "effects";
    this.#visualGroup.name = "visuals";
    this.#scene.add(this.#sun, this.#sun.target,
      this.#environmentGroup, this.#animatedEnvironmentGroup, this.#instanceGroup, this.#localLightInstanceGroup,
      this.#groundCoverGroup, this.#gameObjectGroup, this.#unitGroup, this.#effectGroup, this.#visualGroup);
    this.#programWarmup = new ProgramWarmup(this.#renderer, this.#scene);
    // The two leaf scenes compile their own variants — neither has the world's fog — and both are
    // first drawn at a moment the player is looking: a zone's LightSkybox appears on a flight path,
    // the underwater pass on the first dive. The dome and the overlay triangle are the only
    // materials they own, so they are parked here and warmed on the first frames of the world.
    this.#skyWarmup = new ProgramWarmup(this.#renderer, this.#skyScene);
    this.#overlayWarmup = new ProgramWarmup(this.#renderer, this.#overlayScene);
    this.#glowWarmup = new ProgramWarmup(this.#renderer, this.#glowPasses.scene);
    this.#skyWarmup.registerObject(this.#sky);
    this.#overlayWarmup.registerObject(this.#underwaterOverlay);
    // The glow chain swaps one quad's material between four passes, so the materials are parked
    // rather than the node: the setting can be switched on at any moment, and the first frame it
    // is on must not be the frame that compiles all four.
    for (const pass of [
      this.#glowPasses.extract, this.#glowPasses.blur,
      this.#glowPasses.godRays, this.#glowPasses.composite,
    ]) {
      this.#glowWarmup.registerMaterial(pass, this.#glowPasses.quad.geometry);
    }
    for (const pass of this.#cinematic.materials) {
      this.#glowWarmup.registerMaterial(pass, this.#cinematic.quad.geometry);
    }
    // One line, once per renderer: without this extension the link blocks whoever calls it, and
    // precompiling then only moves the cost into the build phases instead of off the frame.
    console.info("[webclient] прогрев шейдеров: KHR_parallel_shader_compile "
      + (this.#programWarmup.parallelCompile ? "есть" : "нет"));
    this.setLightingQuality(1);
  }

  /** Shader-program warm-up state, for the hitch detail line and the diagnostics panel. */
  get programWarmup(): ProgramWarmup {
    return this.#programWarmup;
  }

  #shaderProgramTrace: ShaderProgramTrace | undefined;

  /** No scene traversal or WebGL queries; disabled outside the explicit one-minute capture. */
  setShaderProgramCapture(enabled: boolean): void {
    this.#shaderProgramTrace = enabled
      ? new ShaderProgramTrace(this.#renderer.info.programs, performance.now()) : undefined;
  }

  drainShaderProgramCapture(): readonly ShaderProgramEvent[] | undefined {
    return this.#shaderProgramTrace?.drain();
  }

  /**
   * Sky, sun and fog for where the camera is and what time it is there.
   *
   * Everything here used to be a constant: one sky colour compiled in, fog from 180 to 640 metres
   * in every zone on every map, and a sun placed once when the scene was built and never moved.
   * `time` is in the half-minutes of a game day the light bands are keyed on.
   */
  updateLighting(sample: LightSample | undefined, time: number | undefined, underwater = false): void {
    this.#underwater = underwater;
    this.#waterShaderUniforms.underwater.value = underwater ? 1 : 0;
    // A map transition can render one or more frames while its Light.dbc metadata is still
    // loading. Do not let the previous map's authored dome survive that gap (Dalaran's dome is
    // especially conspicuous); the normal procedural sky remains the safe fallback.
    if (!sample) {
      this.#lightSample = undefined;
      this.#skyboxPath = undefined;
      this.#lightTime = 0;
      // No table, no authored glow. The chain still runs while the leaf is on, adding nothing —
      // which is what a map transition should look like rather than a screen that pulses.
      this.#glowStrength = 0;
      this.#resetLightingDefaults();
      this.#waterShaderUniforms.underwater.value = underwater ? 1 : 0;
      return;
    }
    this.#lightSample = sample;
    // Clamped here rather than at the uniform so the readback and the shader can never disagree.
    this.#glowStrength = glowAddStrength(sample.glow);
    this.#skyboxPath = sample.skyboxPath;
    if (time !== undefined && Number.isFinite(time)) this.#lightTime = time;
    this.#syncAerialFog();
    const { colours } = sample;
    const set = (target: THREE.Color, colour: ResolvedColour) => target.setRGB(colour.r, colour.g, colour.b, THREE.SRGBColorSpace);

    set(this.#skyUniforms.skyTop.value, colours.skyTop);
    set(this.#skyUniforms.skyUpper.value, colours.skyUpper);
    set(this.#skyUniforms.skyMiddle.value, colours.skyMiddle);
    set(this.#skyUniforms.skyLower.value, colours.skyLower);
    set(this.#skyUniforms.skyHorizon.value, colours.skyHorizon);
    set(this.#skyUniforms.skyFog.value, colours.fog);

    const fog = this.#scene.fog as THREE.Fog;
    set(fog.color, colours.fog);
    set(this.#skyScene.background as THREE.Color, colours.fog);
    fog.near = sample.fogStart;
    fog.far = Math.max(sample.fogStart + 1, sample.fogEnd);
    this.#zoneFogColour.copy(fog.color);
    this.#zoneFogNear = fog.near;
    this.#zoneFogFar = fog.far;

    // These are multipliers, not colours to decode. WorldLighting keeps their numeric display-space
    // values, scales both together for headroom, and performs their one gamma conversion only at
    // the final multiplication in the shader.
    setWorldLightUniforms(this.#worldLight, colours.ambient, colours.diffuse);
    this.#waterShaderUniforms.sunColour.value.copy(this.#worldLight.wowDiffuse.value);
    this.#waterShaderUniforms.sunDirection.value.copy(this.#worldLight.wowSunDirection.value);
    this.#waterShaderUniforms.skyColour.value.copy(this.#zoneFogColour);
    // The sky-reflection leaf mirrors the same authored bands the dome is drawn with (linear here).
    copyWaterSkyBands(this.#waterShaderUniforms, this.#skyUniforms);

    if (time !== undefined) {
      const direction = sunDirection(time);
      this.#worldLight.wowSunDirection.value.set(direction.x, direction.y, direction.z);
      this.#waterShaderUniforms.sunDirection.value.copy(this.#worldLight.wowSunDirection.value);
      this.#sunOffset.set(direction.x, direction.y, direction.z).multiplyScalar(400);
      this.#sun.position.copy(this.#sun.target.position).add(this.#sunOffset);
    }
    // Standing in an interior-only building, world-lit models take the room's baked light through
    // the doodads' indoor equation (`setWorldLightIndoor`) and no sun shadow; the sky, fog and grade
    // keep the zone's sample. One global switch: such a building shows nothing lit from outside.
    const room = this.#interiorLight;
    if (room) {
      setWorldLightIndoor(this.#worldLight, room, MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION);
      this.#waterShaderUniforms.sunColour.value.copy(this.#worldLight.wowDiffuse.value);
      this.#waterShaderUniforms.sunDirection.value.copy(this.#worldLight.wowSunDirection.value);
    }
    setWorldLightShadowSuppressed(this.#worldLight, room !== undefined);
    this.#syncCinematicLight(sample);
  }

  /** Rim light and the cinematic grade follow the zone's bands and the visible sun; no allocation. */
  #syncCinematicLight(sample: LightSample | undefined): void {
    const profile = this.#cinematic.profile;
    const sun = godRaySunDirection(this.#lightTime, this.#cinematicSun);
    // Water glints and the mirrored sun follow the visible disc, which sets; the key light does not.
    this.#waterShaderUniforms.visibleSun.value.copy(sun);
    setWorldLightRim(this.#worldLight,
      profile.rimLight && sample !== undefined && !this.#underwater && this.#interiorLight === undefined, sun.y);
    this.#syncSceneryShadows(false);
    if (!this.#cinematic.active) return;
    const light = this.#cinematicLight;
    if (sample) {
      const { colours } = sample;
      light.diffuse.r = colours.diffuse.r; light.diffuse.g = colours.diffuse.g; light.diffuse.b = colours.diffuse.b;
      light.ambient.r = colours.ambient.r; light.ambient.g = colours.ambient.g; light.ambient.b = colours.ambient.b;
      light.fog.r = colours.fog.r; light.fog.g = colours.fog.g; light.fog.b = colours.fog.b;
      light.fogFar = Math.max(sample.fogStart + 1, sample.fogEnd);
      light.glow = sample.glow;
    }
    light.sun.x = sun.x; light.sun.y = sun.y; light.sun.z = sun.z;
    light.storm = this.#weatherFade.storm;
    light.underwater = this.#underwater;
    light.indoors = this.#indoors;
    this.#cinematic.updateLight(sample ? light : undefined);
  }

  /**
   * The cinematic leaves of the enhanced-graphics preset. All off - the default and what the
   * comparison profile sends - leaves every existing path exactly as it was: no capture is forced,
   * no uniform differs, no material variant changes.
   */
  setCinematicProfile(profile: Readonly<Partial<CinematicProfile>> | undefined): void {
    this.#cinematicRequested = profile === undefined ? undefined : { ...profile };
    this.#applyCinematicProfile();
  }

  /**
   * «Сила кинематографичных эффектов» as a multiplier (setting percent / 100, 0..1.5): scales the
   * grade, bloom and sun glare, the aerial scattering and the sun shafts together. Only the
   * cinematic leaves read it, so with them off (and always at lighting quality 0) it changes nothing.
   */
  setCinematicStrength(strength: number): void {
    this.#cinematic.setStrength(strength);
  }

  /**
   * Lighting quality 0 is the faithful 3.3.5a frame, so it overrides every cinematic leaf the
   * account asked for; the request is kept and comes back with quality 1 or 2.
   */
  #applyCinematicProfile(): void {
    const profile = this.#lightingProfile.quality === 0 ? undefined : this.#cinematicRequested;
    const before = this.#cinematic.profile;
    const postChanged = this.#cinematic.setProfile(profile);
    const next = this.#cinematic.profile;
    if (before.waterSunGlitter !== next.waterSunGlitter || before.waterSkyReflection !== next.waterSkyReflection) {
      this.#cinematicWaterProfile = undefined;
      for (const [liquidClass, material] of this.#liquidMaterials) {
        applyLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
      }
    }
    // The ripple normal maps are fetched on the first request only; quality 0 never gets here with a leaf on.
    if (next.waterSunGlitter || next.waterSkyReflection) this.#waterDetailMaps.request();
    this.#syncCinematicLight(this.#lightSample);
    if (postChanged) this.#cinematic.settle();
    if (before.sceneryShadows !== next.sceneryShadows) this.#syncSceneryShadows(true);
    if (postChanged) this.#syncFullscreenGlowTargets();
  }

  /**
   * Static scenery joins the existing directional shadow map while its leaf is on and the lighting
   * quality has a map at all. Streamed tiles and lazily built WMO rooms arrive between calls, so the
   * environment is reconciled every thirtieth light push (one walk, no allocation per mesh) rather
   * than at each of the places that add to it. Off, the flags are cleared once and the environment
   * is never walked again.
   *
   * M2 doodads (trees, lamps, statues) cast and receive; terrain already receives. The large ones
   * (`SCENERY_FAR_SHADOW_MIN_RADIUS`) also enter the cached outermost cascade through its layer.
   *
   * A WMO group never casts itself: every run is its own draw, and letting each room group cast
   * measured ~360 shadow-pass draws in the Stormwind trade district. Groups with outdoor surfaces
   * cast through one depth-only stand-in each instead (`#syncWmoShadows`), which draws the group's
   * solid runs in as few ranges as they allow. Only a room's exterior-lit runs receive; its interior
   * runs are unlit and never read the sun's map, so no roof can darken a floor lit by baked light.
   */
  #syncSceneryShadows(force: boolean): void {
    // In an interior-only building the sun's term is suppressed for every receiver, so its casters
    // would only cost shadow-pass draws.
    const wanted = this.#cinematic.profile.sceneryShadows && this.#lightingProfile.shadowMapSize > 0
      && this.#interiorLight === undefined;
    if (!wanted && !this.#sceneryShadowsApplied) return;
    this.#sceneryShadowFrame++;
    if (!force && wanted && this.#sceneryShadowFrame % 30 !== 0) return;
    const cascades = this.#sunCascades.active;
    // Which meshes the cached cascade draws, folded into one number: a change means it is stale.
    let farCasters = 0;
    const apply = (node: THREE.Object3D, include: boolean): void => {
      node.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || child.userData[WMO_SHADOW_PROXY] === true) return;
        let eligible = wanted && include;
        if (eligible) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          eligible = materials.length > 0 && materials.every((material: THREE.Material) => shadowMaterialEligible({
            lit: material instanceof THREE.MeshLambertMaterial
              || material instanceof THREE.MeshPhongMaterial
              || material instanceof THREE.MeshStandardMaterial,
            transparent: material.transparent,
            normalBlending: material.blending === THREE.NormalBlending,
            depthWrite: material.depthWrite,
          }));
        }
        // Small props (crates, flowers, bottles) cost a shadow-pass draw each and barely read in a
        // 1024-texel map over 92 yards; trees, statues, lamp posts and awnings are what cast.
        let casts = eligible;
        let radius = 0;
        if (casts) {
          const geometry = child.geometry as THREE.BufferGeometry;
          if (!geometry.boundingSphere) geometry.computeBoundingSphere();
          const scale = child instanceof THREE.InstancedMesh ? 1 : child.matrixWorld.getMaxScaleOnAxis();
          radius = (geometry.boundingSphere?.radius ?? 0) * scale;
          casts = radius >= SCENERY_SHADOW_MIN_RADIUS;
        }
        if (child.castShadow !== casts) child.castShadow = casts;
        if (child.receiveShadow !== eligible) child.receiveShadow = eligible;
        const far = casts && cascades && radius >= SCENERY_FAR_SHADOW_MIN_RADIUS;
        if (far) {
          child.layers.enable(SHADOW_FAR_LAYER);
          farCasters = (farCasters + child.id * 2654435761) % 4294967296;
        } else child.layers.disable(SHADOW_FAR_LAYER);
      });
    };
    for (const rendered of this.#environment.values()) {
      apply(rendered.node, rendered.wmo === undefined);
      if (rendered.wmo) farCasters = (farCasters + this.#syncWmoShadows(rendered.wmo, wanted)) % 4294967296;
    }
    for (const { mesh } of this.#instances.values()) apply(mesh, true);
    // Ground cover receives only: a tuft is too small to cast, but lit grass on shadowed ground
    // washes a tree's shadow out.
    for (const { mesh } of this.#groundCoverMeshes.values()) {
      if (mesh.receiveShadow !== wanted) mesh.receiveShadow = wanted;
    }
    // The ground casts too: a hill shades its far slope and the valley beyond it at a low sun, the
    // one shadow every zone has and the reference client's most visible one. A tile is one mesh
    // (32,768 triangles), so it costs the near cascades a draw or two where their light frustum
    // crosses it, and the cached cascade — which the WDL horizon also casts into, for the ridges
    // past the loaded ring — redraws them only when it redraws at all.
    for (const terrain of this.#terrains.values()) {
      const mesh = terrain.mesh;
      if (mesh.castShadow !== wanted) mesh.castShadow = wanted;
      if (wanted && cascades) {
        mesh.layers.enable(SHADOW_FAR_LAYER);
        farCasters = (farCasters + mesh.id * 2654435761) % 4294967296;
      } else mesh.layers.disable(SHADOW_FAR_LAYER);
    }
    if (this.#horizon) {
      const mesh = this.#horizon.mesh;
      const casts = wanted && cascades;
      if (mesh.castShadow !== casts) mesh.castShadow = casts;
      if (casts) {
        mesh.layers.enable(SHADOW_FAR_LAYER);
        farCasters = (farCasters + mesh.id * 2654435761) % 4294967296;
      } else mesh.layers.disable(SHADOW_FAR_LAYER);
    }
    this.#sceneryShadowsApplied = wanted;
    if (farCasters !== this.#sceneryFarCasters) {
      this.#sceneryFarCasters = farCasters;
      this.#sunCascades.invalidateFar();
    }
  }

  /**
   * Shadow flags of one placed WMO's attached rooms; returns a fold of the stand-ins that cast.
   *
   * A group receives wherever it has exterior-lit runs, which is decided per run and not by MOGP's
   * indoor bit: the Stormwind trade-district street at (-8835, 634) sits in an indoor-flagged group,
   * drawn in exterior batches (see `wmoRunIsInterior`), and the bit alone left it unshadowed. Its interior runs are unlit
   * `MeshBasicMaterial`s that never sample the map, so a room's inside cannot be darkened by it.
   *
   * A group with outdoor surfaces — not indoor, or indoor with exterior-lit runs, which are the
   * street-facing walls and roofs of rooms — casts through one
   * stand-in: its geometry's position and index buffers, shared rather than copied, drawn over the
   * merged ranges of its solid runs, on the shadow layers only. Translucent, additive and
   * alpha-tested runs (glass, glows, grilles) cast nothing rather than a solid slab.
   */
  #syncWmoShadows(placed: PlacedWmo, wanted: boolean): number {
    let fold = 0;
    for (const [index, built] of placed.built) {
      const group = placed.model.groups[index];
      if (!group) continue;
      const { mesh } = built;
      const receives = wanted && (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        .some((material) => material instanceof THREE.MeshStandardMaterial);
      if (mesh.receiveShadow !== receives) mesh.receiveShadow = receives;
      if (mesh.castShadow) mesh.castShadow = false;
      const casts = wanted && this.#sunCascades.active && (!group.indoor || group.exterior);
      let proxy = this.#wmoShadowProxies.get(mesh);
      if (casts && proxy === undefined) {
        const geometry = wmoShadowProxyGeometry(mesh.geometry, mesh.material);
        if (geometry) {
          proxy = new THREE.Mesh(geometry, [WMO_SHADOW_PROXY_MATERIAL]);
          proxy.userData[WMO_SHADOW_PROXY] = true;
          proxy.layers.set(SHADOW_PROXY_LAYER);
          proxy.layers.enable(SHADOW_FAR_LAYER);
          proxy.matrixAutoUpdate = false;
          proxy.receiveShadow = false;
          mesh.add(proxy);
          proxy.matrixWorld.multiplyMatrices(mesh.matrixWorld, proxy.matrix);
          this.#wmoShadowProxies.set(mesh, proxy);
        } else {
          this.#wmoShadowProxies.set(mesh, null);
        }
      }
      if (!proxy) continue;
      if (proxy.castShadow !== casts) proxy.castShadow = casts;
      if (proxy.visible !== casts) proxy.visible = casts;
      if (casts) fold = (fold + proxy.id * 2654435761) % 4294967296;
    }
    return fold;
  }

  /**
   * Shows retained scenery the view did not admit to the shadow cameras only.
   *
   * Scenery outside the view frustum is hidden, and a hidden node casts nothing — so the tree just
   * behind the camera, or beside the frame, would drop its shadow out of the ground it falls on,
   * and shadows would come and go at the screen's edges as the camera turns. Three has already built
   * this frame's draw lists when it asks for shadows, so what is shown here reaches the shadow maps
   * and never the view; the cascades hide it again straight after. Interior doodads, stand-ins and
   * WMO placements (whose hidden rooms are detached anyway) are left alone.
   */
  readonly #shadowOnlyToggle = (on: boolean): number => {
    const nodes = this.#shadowOnlyNodes;
    if (!on) {
      for (const node of nodes) node.visible = false;
      nodes.length = 0;
      return 0;
    }
    if (!this.#sceneryShadowsApplied) return 0;
    for (const rendered of this.#environment.values()) {
      if (rendered.admitted || !rendered.actual || rendered.interior || rendered.wmo
        || rendered.node.visible) continue;
      rendered.node.visible = true;
      nodes.push(rendered.node);
    }
    return nodes.length;
  };

  /** Terrain tiles and the horizon: the casters a cascade culls by their light-plane footprint. */
  readonly #boundedShadowCasters = (out: THREE.Mesh[]): void => {
    for (const terrain of this.#terrains.values()) out.push(terrain.mesh);
    if (this.#horizon) out.push(this.#horizon.mesh);
  };

  /** Per-cascade shadow numbers for diagnostics and the look-dev harness; empty at quality 0. */
  get shadowCascadeStats(): ShadowCascadeSnapshot {
    return this.#sunCascades.stats;
  }

  get cinematicProfile(): Readonly<CinematicProfile> {
    return this.#cinematic.profile;
  }

  /**
   * The liquid surface over the camera, pushed once a frame beside `updateLighting`.
   *
   * A push rather than a query, for the reason every other world fact on this class is a push:
   * `draw()` is not allowed to reach into the loop's clients, and the pair that answers this — the
   * terrain tile and the authoritative WMO floor group — has already been asked this frame for the
   * light slot. Undefined is the ordinary answer and costs the frame nothing.
   */
  setUnderwaterSurface(surface: Readonly<UnderwaterSurface> | undefined): void {
    this.#underwaterSurface = surface === undefined
      ? undefined
      : Object.freeze({ height: surface.height, entry: surface.entry, flags: surface.flags });
  }

  /**
   * The account's switch for the underwater screen effect.
   *
   * Off is not a weaker effect: `#drawUnderwaterOverlay` returns before it looks at anything, so the
   * frame is the same two renders it was before this slice, down to the draw-call count.
   */
  setUnderwaterOverlay(enabled: boolean): void {
    this.#underwaterOverlayEnabled = enabled === true;
  }

  /**
   * The account's switch for the classic full-screen glow. It owns the capture unless the separate
   * sun-shaft leaf is active; with both off the frame returns to the direct path.
   *
   * Binary on purpose. A zone that authors no glow (Ironforge, Dalaran) still pays the chain while
   * the leaf is on, because the alternative — dropping to the direct path whenever the strength
   * rounds to zero — would swap the whole colour pipeline as the player walks through a door, and
   * would make "off is the pre-P4 frame" an assertion about the light table rather than about the
   * switch. Off releases the render targets outright when the sun-shaft leaf is also inactive; one
   * enabled effect keeps their shared capture rather than allocating a second full-frame buffer.
   */
  setFullscreenGlow(enabled: boolean): void {
    const next = enabled === true;
    if (this.#fullscreenGlowEnabled === next) return;
    this.#fullscreenGlowEnabled = next;
    if (!next && !this.#godRaysActive() && !this.#cinematic.active) this.#disposeFullscreenGlowTargets();
    else this.#syncFullscreenGlowTargets();
  }

  /**
   * Enables the optional depth-aware sun shafts.
   *
   * Quality zero is deliberately still the direct/baseline grade. Switching the leaf or crossing
   * that quality boundary rebuilds the scene target because depth is sampled only while the effect
   * can actually run; OFF does not leave a full-resolution depth texture or an MSAA depth resolve
   * behind.
   */
  setGodRays(enabled: boolean): void {
    const next = enabled === true;
    if (this.#godRaysEnabled === next) return;
    this.#godRaysEnabled = next;
    this.#syncFullscreenGlowTargets();
  }

  /**
   * «Сила солнечных лучей» as a multiplier (setting percent / 100, 0..GOD_RAY_STRENGTH_SCALE_MAX)
   * over the lighting quality's shaft ceiling, on both paths: the classic radial pass and
   * CinematicPost's march. Stored only. It enables nothing — quality 0 and the leaf's own switch
   * still decide in `#godRaysActive` — so no depth target is rebuilt and nothing is reallocated;
   * dragging the slider costs the next frame one multiplication.
   */
  setGodRayStrength(scale: number): void {
    this.#godRayStrengthScale = godRayStrengthScale(scale);
  }

  #godRaysActive(): boolean {
    return this.#godRaysEnabled && this.#lightingProfile.godRayStrength > 0;
  }

  /** Restore the same neutral sky/light state used while a map's Light.dbc rows are loading. */
  #resetLightingDefaults(): void {
    this.#worldLight.wowLocalLightCount.value = 0;
    this.#syncAerialFog();
    this.#skyUniforms.skyTop.value.set(0x001f49);
    this.#skyUniforms.skyUpper.value.set(0x3aa2cf);
    this.#skyUniforms.skyMiddle.value.set(0x99dcf5);
    this.#skyUniforms.skyLower.value.set(0xafdae0);
    this.#skyUniforms.skyHorizon.value.set(0xb4b4b4);
    this.#skyUniforms.skyFog.value.set(SKY_COLOR);

    const fog = this.#scene.fog as THREE.Fog;
    fog.color.set(SKY_COLOR);
    fog.near = 180;
    fog.far = 640;
    this.#zoneFogColour.copy(fog.color);
    this.#zoneFogNear = fog.near;
    this.#zoneFogFar = fog.far;
    const background = this.#skyScene.background;
    if (background instanceof THREE.Color) background.set(SKY_COLOR);

    setWorldLightUniforms(
      this.#worldLight,
      { r: 0xc9 / 255, g: 0xe2 / 255, b: 0xf4 / 255 },
      { r: 1, g: 0xf0 / 255, b: 0xcf / 255 },
    );
    this.#waterShaderUniforms.sunDirection.value.set(0, 1, 0);
    this.#waterShaderUniforms.sunColour.value.copy(this.#worldLight.wowDiffuse.value);
    this.#waterShaderUniforms.skyColour.value.copy(this.#zoneFogColour);
    this.#waterShaderUniforms.underwater.value = 0;
    this.#sun.intensity = 0;
    this.#sunOffset.set(0, 400, 0);
    this.#worldLight.wowSunDirection.value.set(0, 1, 0);
    this.#sun.position.copy(this.#sun.target.position).add(this.#sunOffset);
  }

  /** The sun's physical elevation gates golden-hour haze; the night key's floor never enters it. */
  #syncAerialFog(): void {
    const elevation = -Math.cos((this.#lightTime / DAY_HALF_MINUTES) * Math.PI * 2);
    setWorldLightDaylight(this.#worldLight, this.#lightSample === undefined ? 1 : elevation);
    // No sun-facing haze inside an interior-only building: its "sun" is the rooms' fixed key.
    setWorldLightAerialFog(this.#worldLight,
      this.#experimentalShaderProfile.aerialHeightFog && this.#lightSample !== undefined && !this.#underwater
        && this.#interiorLight === undefined,
      elevation);
  }

  /** Restore outdoor fog globally and make it the WMO-material fallback for this frame. */
  #restoreZoneFog(): void {
    const fog = this.#scene.fog as THREE.Fog;
    fog.color.copy(this.#zoneFogColour);
    fog.near = this.#zoneFogNear;
    fog.far = this.#zoneFogFar;
    this.#wmoInteriorFog.colour.value.copy(this.#zoneFogColour);
    this.#wmoInteriorFog.near.value = this.#zoneFogNear;
    this.#wmoInteriorFog.far.value = this.#zoneFogFar;
  }

  /** Immutable renderer-only telemetry for diagnostics and benchmark capture. */
  get telemetry(): Readonly<RendererTelemetrySnapshot> & {
    readonly animationLod: Readonly<{
      near: number; medium: number; far: number; critical: number;
      full: number; flat: number; skipped: number;
    }>;
    readonly worldSubmission?: WorldSubmissionSnapshot;
  } {
    const snapshot = makeRendererTelemetrySnapshot({
      cpu: this.#frames.snapshot(),
      gpu: this.#gpuTimer.reading,
      observedFps: this.#cadence.fps,
      drawCalls: this.#drawCalls,
      triangles: this.#triangles,
      unitsDrawn: this.#unitsDrawn,
      unitsDropped: this.#unitsDropped,
      gameObjectsDrawn: this.#gameObjectsDrawn,
      gameObjectsDropped: this.#gameObjectsDropped,
      effectsDrawn: this.#effectsDrawn,
      effectsDropped: this.#effectsDropped,
      groundCoverDrawn: this.#groundCoverDrawn,
      groundCoverSelected: this.#groundCoverSelected,
      groundCoverSelectionDroppedCells: this.#groundCoverSelectionDroppedCells,
      groundCoverResidentMeshes: this.#groundCoverMeshes.size,
      wmoPortalModels: this.#wmoPortalModels,
      wmoPortalCandidates: this.#wmoPortalCandidates,
      wmoPortalCulled: this.#wmoPortalCulled,
      textureCount: this.#renderer.info.memory.textures,
      geometryCount: this.#renderer.info.memory.geometries,
    });
    const animationLod = Object.freeze({
      near: this.#unitAnimationNear,
      medium: this.#unitAnimationMedium,
      far: this.#unitAnimationFar,
      critical: this.#unitAnimationCritical,
      full: this.#unitAnimationFull,
      flat: this.#unitAnimationFlat,
      skipped: this.#unitAnimationSkipped,
    });
    const worldSubmission = this.#worldSubmissionCapture?.snapshot();
    return worldSubmission === undefined
      ? Object.freeze({ ...snapshot, animationLod })
      : Object.freeze({ ...snapshot, animationLod, worldSubmission });
  }

  /** Exact exposed geometry-array residency for every bounded renderer geometry cache. */
  get builtModelResidencyStats(): Readonly<BuiltModelResidencyStats> {
    const { geometryPins: pins, wrapperCount } = this.#wmoGroupBorrowers();
    let pinnedKnownBufferBytes = 0;
    for (const entry of pins) pinnedKnownBufferBytes += knownGeometryBufferBytes(entry.geometry);
    const legacy = this.#legacyResourceBorrowers();
    let legacyPinnedKnownBufferBytes = 0;
    for (const entry of legacy.geometryPins) {
      legacyPinnedKnownBufferBytes += knownGeometryBufferBytes(entry.geometry);
    }
    return Object.freeze({
      builtModels: this.#builtModels.stats,
      builtUnits: this.#builtUnits.stats,
      legacyGeometry: Object.freeze({
        ...this.#legacyGeometries.stats,
        pinnedCount: legacy.geometryPins.size,
        pinnedKnownBufferBytes: legacyPinnedKnownBufferBytes,
        borrowerCount: legacy.borrowerCount,
      }),
      wmoGroups: Object.freeze({
        ...this.#wmoGeometries.stats,
        pinnedCount: pins.size,
        pinnedKnownBufferBytes,
        wrapperCount,
        materialEntries: this.#worldMaterials.entryCount("wmo-run"),
      }),
    });
  }

  /** Combined exact bounded WMO/legacy material and canonical-base residency. */
  get worldMaterialResidencyStats(): Readonly<WorldMaterialResidencyStats> {
    return this.#worldMaterials.residencyStats;
  }

  /** Exact cached spell bases; private material clones are accounted through their live users. */
  get spellTextureResidencyStats(): Readonly<ModelTextureResidencyStats> {
    return this.#spellTextures.residencyStats;
  }

  /** Exact browser-side character atlas/source residency, absent before the first character look. */
  get characterAtlasResidencyStats(): Readonly<CharacterAtlasResidencyStats> | undefined {
    return this.#atlases?.residencyStats;
  }

  /** Immutable renderer-owned work snapshot consumed by the benchmark warm-up barrier. */
  get benchmarkReadiness(): Readonly<BenchmarkRendererReadinessInput> {
    const atlas = this.#atlases?.stats;
    const worldMaterialTextures = this.#worldMaterials.textureReadiness;
    const persistentStateVisuals = this.#visuals.filter((visual) => visual.key.startsWith("state:")).length;
    return Object.freeze({
      renderFrameActive: this.#renderFrameDepth > 0,
      gpuQueriesPending: this.#gpuTimer.reading.pending,
      modelTexturesPending: this.#textures.stats.pending + this.#spellTextures.stats.pending,
      modelTexturesErrors: this.#textures.stats.error + this.#spellTextures.stats.error,
      modelTexturesGeneration: this.#textures.stats.generation + this.#spellTextures.stats.generation,
      worldTexturesPending: this.#worldTexturesPending + worldMaterialTextures.pending,
      wmoGroupsPending: this.#wmoGroupsPending,
      terrainRepairsPending: this.#terrainRepairsPending,
      worldTexturesErrors: this.#worldTextureErrors.size + worldMaterialTextures.error,
      worldTexturesGeneration: this.#worldTextureGeneration
        + this.#worldMaterialGenerationOffset
        + worldMaterialTextures.generation + this.#worldMaterials.revision,
      groundCoverModelsPending: this.#groundCoverPending.size,
      transientVisuals: this.#visuals.length - persistentStateVisuals,
      persistentStateVisuals,
      pendingVisualAnimations: this.#pendingVisualAnimations.length,
      pendingUnitActions: this.#actions.size,
      pendingGameObjectAnimations: this.#gameObjectAnimations.size,
      // No atlas exists before the first character appearance; that is an explicit idle owner,
      // not a missing readiness field.
      characterAtlasPending: atlas === undefined ? 0 : atlas.pending,
      characterAtlasErrors: atlas === undefined ? 0 : atlas.error,
      characterAtlasGeneration: atlas === undefined ? 0 : atlas.generation,
    });
  }

  /** Visits live scenes plus every renderer-owned cache retained between frames. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    const visit = (object: THREE.Object3D): void => {
      const geometry = (object as THREE.Object3D & { geometry?: unknown }).geometry;
      if (geometry instanceof THREE.BufferGeometry) {
        visitGeometryBuffers(
          visitor,
          object,
          geometry,
          object instanceof THREE.InstancedMesh ? object : undefined,
        );
      }
      if (object instanceof THREE.SkinnedMesh) {
        const skeleton = object.skeleton;
        if (skeleton.boneMatrices) visitor.referenceCpu(skeleton, skeleton.boneMatrices);
        if (skeleton.boneTexture) visitor.referenceGpuTexture(skeleton, skeleton.boneTexture);
      }
      if (object instanceof THREE.InstancedMesh) {
        const morphTexture = (object as THREE.InstancedMesh & { morphTexture?: THREE.Texture | null }).morphTexture;
        if (morphTexture) visitor.referenceGpuTexture(object, morphTexture);
      }
      const material = (object as THREE.Object3D & { material?: unknown }).material;
      if (isMaterial(material)) {
        visitMaterialTextures(visitor, material);
      } else if (Array.isArray(material)) {
        visitMaterialTextures(visitor, material as readonly (THREE.Material | undefined)[]);
      }
    };
    this.#scene.traverse(visit);
    this.#skyScene.traverse(visit);
    // The third live scene, held between frames like the other two. It owns no texture at all —
    // the tint, the ripple and the meniscus are arithmetic — so what this registers is one 36-byte
    // position buffer and nothing else; the visitor is still the right place for it, because a
    // resource nobody visits is a resource nobody can be shown to have released.
    this.#overlayScene.traverse(visit);
    // The fourth, and the one whose material is swapped between post passes: the traversal sees the
    // triangle's buffer and whichever pass material happens to be mounted. That is the whole of what
    // these materials own — the samplers they declare point at the render targets below, which are
    // registered as render targets and not as loose textures.
    this.#glowPasses.scene.traverse(visit);
    this.#cinematic.scene.traverse(visit);
    this.#atlases?.visitRetainedResources(visitor);

    for (const built of this.#builtModels.values()) visitBuiltModelResources(visitor, built);
    for (const built of this.#builtUnits.values()) visitBuiltModelResources(visitor, built);
    for (const template of this.#skinnedTemplates.values()) {
      if (template) visitSkinnedTemplateResources(visitor, template);
    }
    for (const entry of this.#legacyGeometries.values()) {
      if (entry.template) visitSkinnedTemplateResources(visitor, entry.template);
      else visitGeometryBuffers(visitor, entry, entry.geometry);
    }
    if (this.#skyboxTemplate) visitSkinnedTemplateResources(visitor, this.#skyboxTemplate);
    for (const entry of this.#effects.values()) {
      visitModelEffectsResources(visitor, entry.effects, entry.effects);
    }
    for (const visual of this.#visuals) {
      if (visual.template) visitSkinnedTemplateResources(visitor, visual.template);
    }

    for (const entry of this.#wmoGeometries.values()) visitGeometryBuffers(visitor, this, entry.geometry);
    this.#worldMaterials.visitRetainedResources(visitor);
    for (const geometry of [
      this.#unitBodyGeometry, this.#unitFacingGeometry, this.#foliageGeometry, this.#trunkGeometry,
    ]) visitGeometryBuffers(visitor, this, geometry);
    for (const liquid of this.#liquidMaterials.values()) visitMaterialTextures(visitor, liquid.material);
    for (const material of this.#fallbackLiquidMaterials.values()) visitMaterialTextures(visitor, material);
    // Strips may be loaded but not yet bound to a material; retain the cache owner independently.
    this.#liquidTextures?.visitRetainedResources(visitor);
    this.#waterDetailMaps.visitRetainedResources(visitor);
    this.#spellTextures.visitRetainedResources(visitor);
    this.#weather?.visitRetainedResources(visitor);
    this.#atmosphere?.visitRetainedResources(visitor);
    if (!this.#formalBenchmarkIsolation) this.#portraits.visitRetainedResources(visitor);

    const shadow = this.#sun.shadow;
    if (shadow.map) visitor.referenceGpuRenderTarget(this.#sun, shadow.map);
    if (shadow.mapPass) visitor.referenceGpuRenderTarget(this.#sun, shadow.mapPass);
    this.#sunCascades.visitMaps((light, target) => visitor.referenceGpuRenderTarget(light, target));

    // Every buffer of the glow chain, by the same precedent as the shadow map above it. The scene
    // target asks for multisampling, so `referenceGpuRenderTarget` files it under
    // `unknownTopologyResources` and declines to guess its auxiliary bytes; the two half-resolution
    // buffers ask for none and are measured exactly.
    const glow = this.#glowTargets;
    if (glow) {
      for (const target of [glow.scene, glow.blurA, glow.blurB]) {
        visitor.referenceGpuRenderTarget(this, target);
      }
    }
    // The cinematic leaves' bloom mips and occlusion buffers, present only while a post leaf is on.
    for (const target of this.#cinematic.renderTargets) visitor.referenceGpuRenderTarget(this, target);
  }

  /**
   * What the last frame cost, in the words the status line uses.
   *
   * Every budget in this file carries a comment saying slice R8 is where its number stops being
   * guessed at, and until this existed none of them could be: the client measured nothing. Tail
   * percentiles make repeated pressure comparable between runs; the worst frame remains beside
   * them because a rare stutter can still fall above p99 in this two-second window.
   */
  /**
   * Live per-phase timings of the last `draw()` call, in milliseconds.
   *
   * The object is reused every frame: read it right after `draw()` returns and copy the numbers
   * (the hitch ring does exactly this) rather than retaining it. Zeroed with the frame counters,
   * so a frame that returns early leaves zeros instead of the previous frame's phases.
   */
  get drawPhaseMs(): Readonly<Record<string, number>> {
    return this.#drawPhaseMs;
  }

  /**
   * What the last submit allocated: compiled programs, uploaded textures, created geometries.
   *
   * Reused every submit like the phase timings. A submit spike with new programs is shader
   * compilation; with new textures but no programs it is uploads; with neither it is pure
   * command submission, culling and sorting on the CPU.
   */
  get drawSubmitStats(): Readonly<{ programs: number; textures: number; geometries: number }> {
    return this.#submitStats;
  }

  /** Programs/textures/geometries the last submit added; reused, never retained. */
  readonly #submitStats: { programs: number; textures: number; geometries: number } = {
    programs: 0,
    textures: 0,
    geometries: 0,
  };

  #programCount(): number {
    try {
      const programs = (this.#renderer.info as unknown as { programs?: readonly unknown[] }).programs;
      return Array.isArray(programs) ? programs.length : 0;
    } catch {
      return 0;
    }
  }

  #textureCount(): number {
    try {
      return this.#renderer.info.memory.textures;
    } catch {
      return 0;
    }
  }

  #geometryCount(): number {
    try {
      return this.#renderer.info.memory.geometries;
    } catch {
      return 0;
    }
  }

  #recordSubmitStats(programsBefore: number, texturesBefore: number, geometriesBefore: number): void {
    this.#submitStats.programs = this.#programCount() - programsBefore;
    this.#submitStats.textures = this.#textureCount() - texturesBefore;
    this.#submitStats.geometries = this.#geometryCount() - geometriesBefore;
  }

  get status(): string {
    // One immutable read supplies every timing/counter below, so status does not independently
    // sort the CPU ring and poll the GPU queue a second time.
    const telemetry = this.telemetry;
    const frames = telemetry.cpu;
    const gpu = telemetry.gpu;
    const gpuQueue = `${gpu.pending}/${MAX_PENDING_GPU_QUERIES}${gpu.dropped > 0 ? `, пропущено ${gpu.dropped}` : ""}`;
    const gpuCost = gpu.status === "available"
      ? ` · GPU ${gpu.average.toFixed(2)} мс (p95 ${gpu.p95.toFixed(2)}, p99 ${gpu.p99.toFixed(2)}, последний ${gpu.milliseconds.toFixed(2)}, q ${gpuQueue})`
      : gpu.status === "pending"
        ? ` · GPU ожидание (q ${gpuQueue})`
        : ` · GPU недоступен: ${gpu.reason} (q ${gpuQueue})`;
    const cadence = telemetry.observedFps > 0 ? ` · ${telemetry.observedFps.toFixed(0)} к/с` : "";
    const cost = frames.count === 0
      ? ""
      : `${cadence} · CPU render ${frames.average.toFixed(1)} мс (p95 ${frames.p95.toFixed(1)}, p99 ${frames.p99.toFixed(1)}, худший ${frames.worst.toFixed(1)})`
        + ` · вызовов ${telemetry.drawCalls} · ${(telemetry.triangles / 1000).toFixed(0)}k тр.`;
    const dropped = telemetry.unitsDropped > 0 ? ` (+${telemetry.unitsDropped} за бюджетом)` : "";
    // Game objects had no counter at all, which is why nothing could say that a city puts 739 of
    // them inside the draw radius — the number had to be measured from outside the client.
    const objects = telemetry.gameObjectsDropped > 0
      ? `${telemetry.gameObjectsDrawn} (+${telemetry.gameObjectsDropped} за бюджетом)`
      : `${telemetry.gameObjectsDrawn}`;
    const effects = telemetry.effectsDropped > 0
      ? `${telemetry.effectsDrawn} (+${telemetry.effectsDropped} за бюджетом)`
      : `${telemetry.effectsDrawn}`;
    // Terrain apart from the city: the whole point of the far-terrain work is a number that moves,
    // and beside Stormwind's own hundred thousand triangles the ring's contribution is invisible.
    let terrainTriangles = 0;
    let terrainVisible = 0;
    for (const rendered of this.#terrains.values()) {
      if (!rendered.mesh.visible) continue;
      terrainVisible++;
      terrainTriangles += triangleCount(rendered.mesh.geometry);
      for (const mesh of rendered.water ?? []) terrainTriangles += triangleCount(mesh.geometry);
    }
    // The field's own count and the draws standing in for it, because the two questions a bare
    // ground raises are "is anything there" and "what is it costing" — and 3,525 tufts in eleven
    // draws and 3,525 in 3,525 draws look identical from anywhere else.
    const cover = telemetry.groundCoverSelected > 0 || telemetry.groundCoverResidentMeshes > 0
      ? ` · трава ${telemetry.groundCoverDrawn}/${telemetry.groundCoverSelected} (${telemetry.groundCoverResidentMeshes} кеш-меш.)${telemetry.groundCoverSelectionDroppedCells > 0 ? ` (+${telemetry.groundCoverSelectionDroppedCells} клеток за бюджетом)` : ""}`
      : "";
    const occlusion = !this.#wmoOcclusion
      ? " · WMO portals выкл."
      : telemetry.wmoPortalModels > 0
        ? ` · WMO portals ${telemetry.wmoPortalModels}: скрыто ${telemetry.wmoPortalCulled}/${telemetry.wmoPortalCandidates}`
        : "";
    return `WebGL · terrain ${terrainVisible}/${this.#terrains.size} (${(terrainTriangles / 1000).toFixed(0)}k тр.)`
      + ` · окружение ${this.#environment.size}`
      + ` · mesh ${this.#realModels} · инстансы ${this.#instances.size}${cover}${occlusion}`
      + ` · объекты ${objects}${this.#doodadsPosed > 0 ? ` · анимировано ${this.#doodadsPosed}` : ""}`
      + ` · юниты ${telemetry.unitsDrawn}${dropped} · эмиттеры ${effects} · fx ${this.#visuals.length}${cost}${gpuCost}`
      + ` · GPU тек ${telemetry.textureCount} гео ${telemetry.geometryCount}`;
  }

  /** Actual requestAnimationFrame cadence published for diagnostics and `world.fps` bindings. */
  get fps(): number {
    return this.#cadence.fps;
  }

  /** Reads the renderer's current ratio without changing any renderer state. */
  get pixelRatio(): number {
    return this.#renderer.getPixelRatio();
  }

  /** Renderer-owned applied values, after every clamp/capability fallback. */
  get benchmarkGraphicsConfiguration(): Readonly<WorldRendererGraphicsReadback> {
    return Object.freeze({
      lightingQuality: this.#lightingProfile.quality,
      renderScalePercent: this.#renderScale * 100,
      wmoOcclusion: this.#wmoOcclusion,
      characterAtlasAnisotropy: this.#characterAtlasAnisotropyEnabled,
      grassRadius: this.#groundCoverRadius,
      grassDense: this.#groundCoverDense,
      underwaterOverlay: this.#underwaterOverlayEnabled,
      fullscreenGlow: this.#fullscreenGlowEnabled,
      godRays: this.#godRaysEnabled,
      experimentalShaderProfile: this.#experimentalShaderProfile,
    });
  }

  /** Reads the compact faithful-plus seam without touching any material or shader program. */
  get experimentalShaderProfile(): Readonly<ExperimentalShaderProfile> {
    return this.#experimentalShaderProfile;
  }

  /** Cheap per-submission proof that no resize/DPR/context epoch entered the measured stream. */
  get formalRenderSurfaceStamp(): Readonly<FormalRenderSurfaceStamp> {
    let contextLost = true;
    try { contextLost = !webGlContextCanSubmit(this.#renderer.getContext()); } catch { /* fail closed */ }
    const systemDpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio : 1;
    return Object.freeze({
      cssWidth: this.#canvas.clientWidth,
      cssHeight: this.#canvas.clientHeight,
      backingWidth: this.#canvas.width,
      backingHeight: this.#canvas.height,
      systemDpr,
      effectivePixelRatio: this.#renderer.getPixelRatio(),
      contextLost,
      contextGeneration: this.#webGlContextGeneration,
    });
  }

  beginFormalBenchmarkIsolation(): void {
    if (this.#formalBenchmarkIsolation) throw new Error("formal renderer isolation is already active");
    this.#formalBenchmarkIsolation = true;
  }

  endFormalBenchmarkIsolation(): void {
    this.#formalBenchmarkIsolation = false;
  }

  /** Observes RAF cadence without changing animation elapsed or renderer CPU measurement. */
  observeFrame(timestamp: number): number | undefined {
    return this.#cadence.observe(timestamp);
  }

  /** Starts the next observed RAF interval at the next callback, without crossing a run boundary. */
  resetFrameCadence(): void {
    this.#cadence.reset();
  }

  /** Rebase the clamped live animation clock before leaving or returning from deterministic replay. */
  resetRenderEvolutionClock(): void {
    this.#lastFrame = performance.now();
  }

  /** Whether renderer-owned temporal state is currently driven by a deterministic replay epoch. */
  get replayEpochActive(): boolean {
    return this.#replaySeed !== undefined;
  }

  /**
   * Rewinds renderer-owned temporal evolution without releasing any warmed cache or GPU resource.
   *
   * Network-authored transient requests are deliberately a hard boundary. They are absent from a
   * world replay snapshot, so silently clearing them would make the run deterministic by changing
   * the scene being measured.
   */
  resetReplayEpoch(rngSeed: number): void {
    if (!Number.isInteger(rngSeed) || rngSeed < 0 || rngSeed > 0xffffffff) {
      throw new RangeError("replay rngSeed must be a uint32");
    }
    validateReplayEpochBoundary({
      renderFrameActive: this.#renderFrameDepth > 0,
      transientVisuals: this.#visuals.filter((visual) => !visual.key.startsWith("state:")).length,
      persistentStateVisuals: this.#visuals.filter((visual) => visual.key.startsWith("state:")).length,
      pendingVisualAnimations: this.#pendingVisualAnimations.length,
      pendingUnitActions: this.#actions.size,
      pendingGameObjectAnimations: this.#gameObjectAnimations.size,
      pendingMountSpecials: this.#mountSpecials.size,
    });

    const seed = rngSeed >>> 0;
    this.#replaySeed = seed;
    this.#lastFrame = performance.now();
    this.#frames.reset();
    this.#cadence.reset();
    this.#gpuTimer.resetEpoch();
    this.#renderer.info.reset();
    this.#resetFrameCounters();

    // Scenery has one looping Stand action which can stay installed; setTime rewinds it in place.
    for (const rendered of this.#environment.values()) rendered.skinned?.mixer.setTime(0);
    if (this.#skyboxSkinned) {
      this.#skyboxSkinned.mixer.setTime(0);
      this.#skyboxAnimationMs = 0;
    }

    // Live objects must derive their first pose from the fixed WorldState, not from the last live
    // frame's state/overlay/transport anchors.
    for (const rendered of this.#gameObjects.values()) {
      if (rendered.skinned) {
        rendered.skinned.mixer.stopAllAction();
        rendered.skinned.mixer.setTime(0);
      }
      rendered.action = undefined;
      rendered.animationId = -1;
      delete rendered.actionKind;
      delete rendered.overlayAction;
      delete rendered.overlayAnimationId;
      delete rendered.overlayActionKind;
      rendered.overlayPreservesLocomotion = false;
      delete rendered.overlayFadeUntil;
      rendered.overlayUntil = 0;
      delete rendered.state;
      delete rendered.phaseMs;
      delete rendered.phaseAt;
    }
    for (const unit of this.#units.values()) {
      if (unit.skinned) {
        unit.skinned.mixer.stopAllAction();
        unit.skinned.mixer.setTime(0);
      }
      unit.action = undefined;
      unit.animationId = -1;
      delete unit.actionKind;
      delete unit.overlayAction;
      delete unit.overlayAnimationId;
      delete unit.overlayActionKind;
      unit.overlayPreservesLocomotion = false;
      delete unit.overlayFadeUntil;
      unit.overlayUntil = 0;
      unit.pose = undefined;
      const mount = unit.mount;
      if (mount?.skinned) {
        mount.skinned.mixer.stopAllAction();
        mount.skinned.mixer.setTime(0);
      }
      if (mount) {
        mount.action = undefined;
        mount.animationId = -1;
        delete mount.actionKind;
        delete mount.overlayAction;
        delete mount.overlayAnimationId;
        delete mount.overlayActionKind;
        mount.overlayPreservesLocomotion = false;
        delete mount.overlayFadeUntil;
        mount.overlayUntil = 0;
      }
    }

    this.#weatherPacket = undefined;
    this.#weatherFade = { kind: "fine", density: 0, storm: 0 };
    this.#weatherAbrupt = false;
    this.#weather?.reset(0);
    this.#weather?.set(this.#weatherFade, false);
    this.#atmosphere?.reset();
    this.#atmosphereVegetationAt = Number.NEGATIVE_INFINITY;
    for (const [key, held] of this.#effects) {
      if (held.effects !== EMPTY_EFFECTS) {
        resetModelEffects(held.effects, modelEffectSeed(key, seed));
      }
    }
  }

  /** Leaves deterministic evolution and rebases live wall clocks without touching warmed state. */
  endReplayEpoch(): void {
    if (this.#renderFrameDepth > 0) {
      throw new Error("cannot end replay epoch during an active render frame");
    }
    this.#replaySeed = undefined;
    this.#lastFrame = performance.now();
    this.#cadence.reset();
  }

  /** Height of the drawn body, so the 2D overlay can put a name plate right above it. */
  unitHeight(guid: bigint): number | undefined {
    return this.#units.get(guid)?.height;
  }

  /** Where the camera orbits this unit: the shoulder of the body actually standing there. */
  unitPivotHeight(guid: bigint): number {
    return this.#bodyHeight(guid, ATTACHMENT_SHOULDER_RIGHT, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT);
  }

  /** And where its eye is, for first person: the point a helmet hangs from. */
  unitEyeHeight(guid: bigint): number {
    return this.#bodyHeight(guid, ATTACHMENT_HELM, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT);
  }

  /**
   * Supplies the same built appearance the world unit uses, but never the unit's live Object3D.
   * PortraitRenderer creates its own static mesh or skinned instance from these shared resources.
   */
  #portraitSource(guid: bigint): PortraitSource | undefined {
    const unit = this.#units.get(guid);
    if (!unit?.wvm || !unit.applied) return undefined;
    const built = this.#builtUnits.get(this.#builtCacheKey(this.#builtUnits, unit.applied));
    if (!built) return undefined;
    const atlasGeneration = this.#atlases?.generation(unit.applied) ?? 0;
    return {
      key: `${unit.applied}@atlas:${atlasGeneration}`,
      buildKey: unit.applied,
      model: unit.wvm,
      built,
      template: unit.template ?? undefined,
      liveBones: unit.skinned?.skeleton.bones,
      scale: unit.scale,
    };
  }

  /**
   * A height on a unit's body, from its own model where there is one.
   *
   * `unit.height` is only a body height once a real model has been applied. Before that it is
   * whatever `#shapeCapsule` last wrote, which is the clamped combat reach the stand-in pill was
   * shaped to — 4.4 times the bounding radius on most creatures — so it is offered to the chain
   * only when the capsule is gone. `#clearUnitNode` drops `body` the moment a model goes in, and
   * that is the test: a unit still wearing a pill has nothing to measure.
   *
   * The saddle is added on top, outside `cameraBodyHeight`'s clamp, and both halves of that are
   * deliberate. A point on a body belongs in wowee's 0..3 band (`camera_controller.hpp:384`) —
   * that band is about where a camera hangs on a *character* — while the mount underneath is a
   * second height with nothing to do with it, and clamping the sum would have thrown most of the
   * correction away: a human's helm point is 2.0272 and its shoulder 1.7254, so on a RidingHorse
   * (seat 1.8657, scale 1) the true eye is 3.8929 and the true shoulder 3.5911, both over the 3.
   * Without this the slice made the player's own view worse than before it: the camera stayed on
   * the ground while the character went up, which in first person is a camera inside the horse.
   */
  #bodyHeight(guid: bigint, point: number, share: number, fallback: number): number {
    const unit = this.#units.get(guid);
    const attachment = unit?.wvm ? attachmentHeight(unit.wvm, point) : undefined;
    // `#seatRider` writes the saddle into `unit.height` too, so it is taken back out before the
    // body share is measured against it and put back once, not twice.
    const seat = unit?.mount?.seat ?? 0;
    const body = unit && !unit.body && unit.height - seat > 0 ? unit.height - seat : undefined;
    // 11.02-H: a passenger drawn on its vehicle's seat point is that much higher than its own place.
    const vehicleSeatLift = unit === undefined ? 0 : this.#vehiclePassengers.seatLift(unit.node);
    return cameraBodyHeight(
      attachment === undefined ? undefined : attachment * (unit?.scale ?? 1),
      body, share, fallback) + seat + vehicleSeatLift; // 11.02-H: + vehicleSeatLift
  }

  /**
   * Which units drawn on the last frame are still capsules, and what stopped each of them.
   *
   * The counter the diagnostics window shows. Five things can leave a unit a stand-in and three of
   * them are permanent after one failure, so the reason is the whole of the report: "capsules: 4"
   * is a symptom, "capsules: 4, model has not downloaded, display 21935" is a defect with an
   * address. Data only — the window formats it, and a test drives the ledger without either.
   */
  standInReport(): StandInReport {
    return this.#standIns.report();
  }

  /**
   * Shows everything one cast asks for, and plays the pose that goes with it.
   *
   * The plan arrives already worked out — which models, where, and between which two moments —
   * because none of that needs a scene and all of it is worth being able to assert. What is left
   * here is the part that does: putting a node in the world and taking it away again.
   */
  playSpellVisual(plan: SpellVisualPlan): SpellVisualHandle {
    const now = performance.now();
    const handle: SpellVisualHandle = Object.freeze({ id: ++this.#visualSequence });
    for (const instance of plan.instances) {
      const loadDeadline = instance.fitToModel && !instance.flight && Number.isFinite(instance.endsAt)
        ? Math.max(now, instance.startedAt) + MODEL_VFX_LOAD_GRACE_MS : undefined;
      const node = new THREE.Group();
      const frame = new THREE.Object3D();
      node.add(frame);
      // Future instances are kept in the scene so their model can preload, but remain hidden until
      // the authored start time; particle simulation is gated separately in the effects pass.
      node.visible = visualHasStarted(instance, now);
      this.#visualGroup.add(node);
      this.#visuals.push({
        instance, handle, key: `fx:${this.#visualSequence++}`, node, frame,
        visual: undefined, built: undefined, wvm: undefined, skinned: undefined, template: undefined,
        action: undefined,
        authoredEndsAt: instance.endsAt, loadDeadline, effectsLoadDeadline:
          Math.max(now, instance.startedAt) + MODEL_VFX_LOAD_GRACE_MS,
        playbackStartedAt: undefined,
        effectsEligibleAt: undefined, phaseOriginAt: undefined, effectsPhaseStatus: "pending",
        textureLeases: new Map(),
      });
    }
    // One unit cannot play two action clips at once. Composite rows often provide both
    // ImpactKit and TargetImpactKit for the same target/time; installing both in a Map<guid,...>
    // used to make the last one win, while minor packet/model timing changes changed which kit was
    // last and made casts appear to alternate. Keep the first authored action for one slot and
    // retain every distinct future phase.
    const animationSlots = new Set<string>();
    for (const animation of plan.animations) {
      const slot = `${animation.guid}:${Number.isFinite(animation.at) ? animation.at : "now"}`;
      if (animationSlots.has(slot)) continue;
      animationSlots.add(slot);
      const at = animation.at;
      if (!visualAnimationIsDue(animation, now)) {
        this.#pendingVisualAnimations.push({ animation, at, handle });
        continue;
      }
      this.#setUnitAnimation(animation, "visual", handle);
    }
    return handle;
  }

  /** Remove spell FX/state and only their particle bookkeeping; portraits and world scenery stay. */
  clearSpellVisuals(): void {
    this.#pendingVisualAnimations.length = 0;
    for (const visual of this.#visuals) {
      this.#visualGroup.remove(visual.node);
      this.#dropEffects(visual.key);
      this.#disposeRenderedVisual(visual);
    }
    this.#visuals.length = 0;
    // The poses go with them. Whatever is on show is released on the unit's next pose pass, which
    // cross-fades it into the unit's own pose instead of cutting it.
    for (const [guid, queue] of this.#actions) {
      queue.removeWhere((entry) => entry.payload.source === "visual");
      if (queue.idle) this.#actions.delete(guid);
    }
  }

  /** Remove only one cast's nodes, emitters and not-yet-started animation requests. */
  cancelSpellVisual(handle: SpellVisualHandle): void {
    for (let index = this.#pendingVisualAnimations.length - 1; index >= 0; index--) {
      if (this.#pendingVisualAnimations[index]!.handle === handle) this.#pendingVisualAnimations.splice(index, 1);
    }
    for (let index = this.#visuals.length - 1; index >= 0; index--) {
      const visual = this.#visuals[index]!;
      if (visual.handle !== handle) continue;
      this.#visualGroup.remove(visual.node);
      this.#dropEffects(visual.key);
      this.#disposeRenderedVisual(visual);
      this.#visuals.splice(index, 1);
    }
    // Only this cast's poses. A released pose is faded into the unit's own pose on its next pass
    // (a stopped action used to snap the hands 0.6–1.0 yd between two frames at every cast end).
    for (const [guid, queue] of this.#actions) {
      queue.removeWhere((entry) => entry.owner === handle);
      if (queue.idle) this.#actions.delete(guid);
    }
  }

  /** Extend or shorten one cast without restarting its particles or creating another node. */
  retimeSpellVisual(handle: SpellVisualHandle, endsAt: number): void {
    if (!Number.isFinite(endsAt)) return;
    const now = performance.now();
    for (const visual of this.#visuals) {
      if (visual.handle !== handle || !(visual.instance.endsAt > now)) continue;
      visual.instance.endsAt = Math.max(visual.instance.startedAt, endsAt);
      if (visual.instance.fitToModel && !visual.instance.flight && Number.isFinite(endsAt)) {
        visual.authoredEndsAt = visual.instance.endsAt;
      }
    }
    for (const pending of this.#pendingVisualAnimations) {
      if (pending.handle !== handle) continue;
      if (pending.animation.mode === "hold") {
        pending.animation.hold = Math.max(0, endsAt - pending.animation.at);
      }
      if (pending.animation.followUp?.mode === "hold") {
        pending.animation.followUp.hold = Math.max(0, endsAt - pending.animation.at);
      }
    }
    // A held pose's end is its entry's `until` — with a lead-in too, whose follow-up is the hold.
    for (const queue of this.#actions.values()) {
      for (const entry of queue.entries) {
        if (entry.owner === handle && entry.held) entry.until = endsAt;
      }
    }
  }

  /**
   * The lasting marks a unit's auras put on it, reconciled against what is already showing.
   *
   * A state kit is the one phase with no end of its own: the frost on a chilled target and the
   * glow on a blessed one last exactly as long as the aura does, which is a thing the packets say
   * and the visual tables do not. So this takes the whole picture at once and works out the
   * difference — anything new is added, anything gone is taken away, and anything unchanged is
   * left exactly where it is rather than restarted, which would make every effect in a raid blink
   * on every aura anybody gained.
   */
  /**
   * The see-through auras the interface knows about, by unit.
   *
   * Pushed in rather than read, for the same reason `setStateVisuals` is: `game.spells` and
   * `world.auras` live in the DOM application's context object, and this renderer is imported by
   * node tests that have no DOM at all. The map is small by construction — only units carrying one
   * of the two auras are in it — and is replaced whole on every aura change, so a unit that loses
   * its stealth simply stops being in it.
   *
   * It is the *fallback* half of the appearance and not the authority; `UNIT_FIELD_BYTES_1` byte 2
   * wins wherever it arrives. `unitAppearance` in `world/Fields.ts` carries that layering and the
   * reason for it.
   */
  setUnitAuraAppearance(byUnit: ReadonlyMap<bigint, UnitAuraAppearance>): void {
    this.#auraAppearance = byUnit;
  }

  setStateVisuals(byUnit: ReadonlyMap<bigint, readonly StateVisual[]>): void {
    const wanted = new Set<string>();
    for (const [guid, effects] of byUnit) {
      for (const effect of effects) wanted.add(stateVisualKey(guid, effect));
    }
    for (let index = this.#visuals.length - 1; index >= 0; index--) {
      const visual = this.#visuals[index]!;
      if (!visual.key.startsWith("state:") || wanted.has(visual.key)) continue;
      this.#visualGroup.remove(visual.node);
      this.#dropEffects(visual.key);
      this.#disposeRenderedVisual(visual);
      this.#visuals.splice(index, 1);
    }
    const showing = new Set(this.#visuals.map((visual) => visual.key));
    for (const [guid, effects] of byUnit) {
      for (const effect of effects) {
        const key = stateVisualKey(guid, effect);
        if (showing.has(key)) continue;
        const node = new THREE.Group();
        const frame = new THREE.Object3D();
        node.add(frame);
        this.#visualGroup.add(node);
        this.#visuals.push({
          instance: {
            path: effect.path,
            scale: effect.scale,
            anchor: guid,
            attachment: effect.attachment,
            startedAt: 0,
            // Nothing but losing the aura takes it away.
            endsAt: Number.POSITIVE_INFINITY,
            modelPlayback: "hold",
            ...(effect.transform ? { transform: effect.transform } : {}),
          },
          handle: Object.freeze({ id: ++this.#visualSequence }),
          key, node, frame, visual: undefined, built: undefined, wvm: undefined,
          skinned: undefined, template: undefined, action: undefined,
          authoredEndsAt: Number.POSITIVE_INFINITY, loadDeadline: undefined,
          effectsLoadDeadline: performance.now() + MODEL_VFX_LOAD_GRACE_MS,
          playbackStartedAt: undefined, effectsEligibleAt: undefined, phaseOriginAt: undefined,
          effectsPhaseStatus: "pending",
          textureLeases: new Map(),
        });
      }
    }
  }

  /**
   * Places every live visual and retires the ones whose moment has passed.
   *
   * Three kinds, and the difference between them is only where the node goes: a bolt reads its
   * place off its own flight, an effect on somebody reads it off their bone, and a rune on the
   * ground stays where it was put.
   */
  /**
   * What the server says the weather is here.
   *
   * Called every frame with whatever `WorldClient` is holding, rather than wired to the event: the
   * renderer can be built after the packet has already landed, and a weather that only arrived
   * through an event would then never be drawn at all. The packet object is compared by identity,
   * because that is what tells a new packet from the same one being handed over again — and the
   * difference matters for exactly one field, `abrupt`, which is set when the player has just
   * zoned in and must not cost a five-second dissolve from a clear sky.
   */
  setWeather(weather: Weather | undefined): void {
    if (weather === this.#weatherPacket) return;
    this.#weatherPacket = weather;
    this.#weatherAbrupt = weather?.abrupt ?? false;
  }

  /**
   * How far the storm sky has rolled in, 0 to 1, for whoever is resolving the light.
   *
   * Read a frame after it is advanced, which is the whole of the lag: a five-second fade sampled
   * one frame late is sixteen milliseconds of a five-second change.
   */
  get weatherStorm(): number {
    return this.#weatherFade.storm;
  }

  /**
   * Moves the weather towards what the packet asked for, and draws it.
   *
   * Nothing falls indoors, and what counts as indoors is `setIndoors`'s business rather than this
   * one's: rain through the roof of every building in Stormwind is the first thing anybody would
   * notice, and so is a city where it never rains at all.
   */
  #updateWeather(elapsed: number): void {
    const packet = this.#weatherPacket;
    const kind = packet ? weatherKind(packet.state) : "fine";
    const wanted = { kind, density: packet ? weatherDensity(kind, packet.intensity) : 0 };
    this.#weatherFade = advanceWeather(this.#weatherFade, wanted, elapsed, this.#weatherAbrupt);
    this.#weatherAbrupt = false;
    if (this.#weatherFade.kind === "fine" && this.#weatherFade.density <= 0) {
      // Nothing falling. The effect is kept — a shower that stops is usually followed by another —
      // but every per-frame cost behind this line, `#cameraIndoors` included, stops with it.
      this.#weather?.set(this.#weatherFade, false);
      return;
    }
    if (!this.#baseUrl) return;
    if (!this.#weather) {
      this.#weather = new WeatherEffect((path) => this.#loadWorldTexture(
        textureUrl(this.#baseUrl, path),
        (image) => {
          image.colorSpace = THREE.SRGBColorSpace;
          // v = 0 is the top row in the client's own convention, and three flips on upload.
          image.flipY = false;
          image.needsUpdate = true;
        },
      ));
      this.#scene.add(this.#weather.object);
      this.#programWarmup.registerObject(this.#weather.object);
    }
    this.#weather.set(
      this.#indoors ? { ...this.#weatherFade, density: 0 } : this.#weatherFade,
      packet ? weatherIsBlack(packet.state) : false,
    );
    this.#weather.update(this.#camera.position, elapsed);
  }

  /**
   * The wind/weather/ambient leaves (AtmosphereEffects.ts). OFF — the default, the comparison
   * profile and teardown — creates nothing and wraps no material.
   */
  setAtmosphereEffects(profile: Readonly<Partial<AtmosphereProfile>> | undefined): void {
    // All OFF (the comparison profile, a fresh account) never even builds the controller.
    if (!this.#atmosphere && !atmosphereProfileActive(normaliseAtmosphereProfile(profile))) return;
    this.#atmosphere ??= new AtmosphereEffects(this.#scene, (path) => this.#loadAtmosphereTexture(path));
    const previous = this.#atmosphereProfile;
    if (!this.#atmosphere.setProfile(profile)) return;
    const next = this.#atmosphere.profile;
    this.#atmosphereProfile = next;
    if (previous.wetSurfaces !== next.wetSurfaces || previous.rainSplashes !== next.rainSplashes) {
      for (const terrain of this.#terrains.values()) {
        if (terrain.splatted) setTerrainWetness(terrain.material, next.wetSurfaces, next.rainSplashes);
      }
      setWmoWetness(next.wetSurfaces, next.rainSplashes);
      for (const [liquidClass, liquid] of this.#liquidMaterials) {
        if (liquidClass === "water" || liquidClass === "ocean") setWaterRainRipples(liquid.material, next.rainSplashes);
      }
      for (const [liquidClass, material] of this.#fallbackLiquidMaterials) {
        if (liquidClass === "water" || liquidClass === "ocean") setWaterRainRipples(material, next.rainSplashes);
      }
    }
  }

  get atmosphereProfile(): Readonly<AtmosphereProfile> {
    return this.#atmosphereProfile;
  }

  /** Diagnostics and local testing: the live atmosphere controller, if any leaf was ever enabled. */
  get atmosphere(): AtmosphereEffects | undefined {
    return this.#atmosphere;
  }

  #loadAtmosphereTexture(path: string): THREE.Texture | undefined {
    if (!this.#baseUrl) return undefined;
    return this.#loadWorldTexture(textureUrl(this.#baseUrl, path), (image) => {
      image.colorSpace = THREE.SRGBColorSpace;
      image.flipY = false;
      image.needsUpdate = true;
    });
  }

  /**
   * Where rain lands: the terrain, or the surface of terrain liquid above it — a splash on a lake
   * bed would show through the water.
   */
  readonly #atmosphereSurfaceAt: HeightSampler = (x, y) => {
    const ground = this.#atmosphereGround?.(x, y);
    const liquid = this.#atmosphereTerrain?.liquidAt(this.#atmosphereMap, x, y)?.height;
    if (liquid === undefined || !Number.isFinite(liquid)) return ground;
    return ground === undefined ? liquid : Math.max(ground, liquid);
  };
  #atmosphereGround: HeightSampler | undefined;
  #atmosphereTerrain: TerrainClient | undefined;
  #atmosphereMap: number | undefined;

  #updateAtmosphere(
    player: { x: number; y: number; z: number }, map: number | undefined,
    heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined, now: number, elapsed: number,
  ): void {
    const atmosphere = this.#atmosphere!;
    if (!atmosphereProfileActive(atmosphere.profile)) return;
    this.#atmosphereGround = heightAt;
    this.#atmosphereTerrain = terrainClient;
    this.#atmosphereMap = map;
    // Vegetation around the character, about once a second: trees among the placed scenery and
    // how much ground cover the field is drawing. Cheap and allocation-light at that rate.
    if (now - this.#atmosphereVegetationAt > 1000 || now < this.#atmosphereVegetationAt) {
      this.#atmosphereVegetationAt = now;
      let trees = 0;
      for (const rendered of this.#environment.values()) {
        const source = rendered.source;
        if (source.kind !== "m2" || source.interior) continue;
        const dx = source.x - player.x;
        const dy = source.y - player.y;
        if (dx * dx + dy * dy > 38 * 38) continue;
        if (/tree|canopy|sapling|bush/i.test(source.name)) trees++;
      }
      let tufts = 0;
      for (const { mesh } of this.#groundCoverMeshes.values()) tufts += mesh.count;
      this.#atmosphereForest = Math.min(1, trees / 6);
      this.#atmosphereMeadow = Math.min(1, tufts / 1500);
    }
    const frame = this.#atmosphereFrame ??= {
      camera: this.#camera, feet: new THREE.Vector3(), heightAt: undefined, seconds: 0, elapsed: 0,
      map: undefined, weather: undefined, fade: this.#weatherFade, thunder: false, indoors: false,
      underwater: false, sunDirection: this.#worldLight.wowSunDirection.value,
      sunColour: this.#worldLight.wowDiffuse.value, ambient: this.#worldLight.wowAmbient.value,
      daylight: 1, skyColour: this.#zoneFogColour, pixelScale: 500, quality: 1, meadow: 0, forest: 0,
    };
    frame.camera = this.#camera;
    frame.feet.set(player.x, player.z, -player.y);
    frame.heightAt = heightAt ? this.#atmosphereSurfaceAt : undefined;
    frame.seconds = now / 1000;
    frame.elapsed = elapsed;
    frame.map = map;
    frame.weather = this.#weather;
    frame.fade = this.#weatherFade;
    frame.thunder = isThunderState(this.#weatherPacket?.state);
    frame.indoors = this.#indoors;
    frame.underwater = this.#underwater;
    frame.daylight = this.#worldLight.wowDaylight.value;
    this.#renderer.getDrawingBufferSize(this.#atmosphereBuffer);
    frame.pixelScale = this.#camera.projectionMatrix.elements[5]! * this.#atmosphereBuffer.y * 0.5;
    frame.quality = atmosphereQuality(this.#renderScale);
    frame.meadow = this.#atmosphereMeadow;
    frame.forest = this.#atmosphereForest;
    atmosphere.update(frame);
    // The rain veil: the zone fog pulled in while it rains (0 while rainStreaks is OFF). The fog
    // was restored from the zone's Light.dbc values at the top of this submission, so this never
    // accumulates; interior WMO fog has its own uniforms and is left alone.
    if (atmosphere.haze > 0 && !this.#underwater) applyPrecipitationHaze(this.#scene.fog as THREE.Fog, atmosphere.haze);
  }

  /**
   * Closes the frame's interior-only notes: rooms not updated this frame stop binding their
   * doodads, the room light moves on to the next `updateLighting`, and the procedural dome goes
   * while the camera stands in a room of such a building — it has no window to the sky, and the
   * dome only showed through doorways into rooms the 60-yard leash had not drawn (a sky-blue hole
   * at noon over Gundrak's Moorabi stairs). The sky pass still clears to the zone's fog colour.
   */
  #settleInteriorOnly(): void {
    for (const [id, rooms] of this.#interiorOnlyRooms) {
      if (rooms.serial === this.#submissionSerial) continue;
      if (rooms.live) {
        rooms.live = false;
        interiorOnlyRoomsLive--;
        this.#environmentCandidatesAt = undefined;
      }
      this.#interiorOnlyRooms.delete(id);
    }
    this.#interiorLight = this.#interiorOnlyFloor;
    this.#interiorOnlyFloor = undefined;
    this.#sky.visible = !this.#interiorOnlyCamera;
    this.#interiorOnlyCamera = false;
  }

  /**
   * Loads the LightSkybox model named by the active light profile and keeps it at the camera. The
   * procedural dome is deliberately left in place underneath: old archives often have a Light row
   * without a matching M2, and an unavailable optional model must not turn a whole zone black.
   */
  #updateSkybox(camera: THREE.Camera, client: EnvironmentClient | undefined): void {
    this.#settleInteriorOnly();
    // The original client does not draw a camera-centred outdoor sky inside a WMO. The procedural
    // gradient remains the indoor fallback, while authored sky geometry and its emitters are
    // removed as soon as the collision query says the player is under a roof.
    const wanted = this.#indoors ? undefined : this.#skyboxPath;
    if (!wanted) {
      if (this.#skyboxGroup.children.length > 0) this.#clearSkybox();
      this.#skyboxLoadedPath = undefined;
      return;
    }
    if (!client) return;
    const model = client.model(wanted, "background");
    if (!model || !drawableModel(model)) return;
    const replacesLegacy = this.#skyboxLoadedPath === wanted
      && legacyDecodedModelReplaced(
        this.#skyboxDecodedModel,
        this.#skyboxLegacyGeometry !== undefined,
        model,
      );
    if (this.#skyboxLoadedPath !== wanted || replacesLegacy) {
      this.#clearSkybox();
      const object: EnvironmentObject = {
        id: -1, name: wanted, kind: "m2", x: 0, y: 0, z: 0,
        rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
      };
      let built: BuiltModel | undefined;
      let node: THREE.Object3D;
      if (model.wvm?.skeleton && animatesAsDoodad(model.wvm.skeleton)) {
        // DalaranSkyBox and the other authored zone skies carry a real M2 rig. The ordinary
        // scenery path intentionally uses a static build for most doodads, but doing that here
        // leaves the 320-second aurora/cloud clip in its bind pose forever.
        const key = `sky|${wanted}`;
        const cacheKey = this.#builtCacheKey(this.#builtModels, key);
        built = this.#wvmBuild(this.#builtModels, key, wanted, model.wvm, undefined, undefined, true);
        let template = this.#skinnedTemplates.get(cacheKey);
        if (template === undefined) {
          template = buildSkinnedTemplateFrom(built.geometry, model.wvm.skeleton, built.height) ?? null;
          this.#skinnedTemplates.set(cacheKey, template);
        }
        if (template) {
          const instance = instantiateSkinned(template, built.materials);
          node = new THREE.Group();
          node.add(instance.root);
          node.userData["visual"] = instance.mesh;
          this.#skyboxSkinned = instance;
          this.#skyboxTemplate = template;
          this.#skyboxAction = undefined;
        } else {
          // A malformed/empty rig must not hide a usable mesh. The static build is still a valid
          // fallback and the optional procedural dome remains underneath it.
          node = this.#modelNode(object, model);
          built = this.#builtModels.get(this.#builtCacheKey(this.#builtModels, wanted));
        }
      } else {
        node = this.#modelNode(object, model);
        built = model.wvm
          ? this.#builtModels.get(this.#builtCacheKey(this.#builtModels, wanted))
          : undefined;
      }
      // LightSkybox names an M2 directly, not an ADT placement. `#modelNode` normally receives a
      // tile placement and consequently uses the ADT frame; sky models use the ordinary M2 frame
      // (the same quarter turn as units and spell models).
      if (model.wvm && !this.#skyboxSkinned) {
        const visual = node.userData["visual"];
        if (visual instanceof THREE.Object3D) visual.quaternion.copy(M2_TO_SCENE);
      }
      // Sky materials are authored as M2 batches, but they must not receive the world sun or fog,
      // and must never write/test depth. Clone the material rather than mutating the shared model
      // cache: the same path may also be present as an ordinary world doodad.
      node.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const source = Array.isArray(child.material) ? child.material : [child.material];
        child.material = source.map((value) => {
          const map = (value as THREE.MeshStandardMaterial).map ?? null;
          const material = new THREE.MeshBasicMaterial({
            map, color: (value as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0xffffff),
            transparent: value.transparent, opacity: value.opacity, alphaTest: value.alphaTest,
            // M2's material flags already describe the dome's winding/culling. Do not force
            // BackSide here: the authored sky may use inward winding with FrontSide, or explicitly
            // request DoubleSide, and changing that flag makes some layers disappear.
            side: value.side,
            depthTest: false, depthWrite: false,
            vertexColors: value.vertexColors,
          });
          material.blending = value.blending;
          material.premultipliedAlpha = value.premultipliedAlpha;
          material.fog = false;
          const animated = built?.animatedBatches.find((batch) => batch.material === value);
          if (animated) this.#skyboxAnimatedBatches.push({ ...animated, material });
          return material;
        });
        child.renderOrder = -0.5;
      });
      // After the clones above, not inside `#modelNode`: a sky material is a new MeshBasicMaterial
      // with fog switched off, and only the sky scene's context compiles that exact program.
      this.#skyWarmup.registerObject(node);
      this.#skyboxBuilt = built;
      this.#skyboxDecodedModel = model.wvm === undefined && model.wmo === undefined
        ? model
        : undefined;
      const legacyGeometry = node.userData["legacyGeometry"];
      this.#skyboxLegacyGeometry = legacyGeometry as LegacyGeometryEntry | undefined;
      const materialEntries = node.userData["worldMaterialEntries"];
      this.#skyboxMaterialEntries = Array.isArray(materialEntries)
        ? materialEntries as readonly WorldMaterialEntry[]
        : undefined;
      this.#skyboxGroup.add(node);
      this.#skyboxModel = model.wvm;
      const visual = node.userData["visual"];
      this.#skyboxVisual = visual instanceof THREE.Object3D ? visual : node;
      this.#skyboxLoadedPath = wanted;
    }
    this.#skyboxGroup.position.copy(camera.position);
  }

  /** Pose the authored sky at the current Light.dbc time after its camera-relative node is placed. */
  #updateSkyboxAnimation(): void {
    const instance = this.#skyboxSkinned;
    const template = this.#skyboxTemplate;
    if (!instance || !template) return;
    const clip = template.clips.get(ANIMATION_IDS.Stand) ?? template.clips.values().next().value;
    if (clip && this.#skyboxAction === undefined) {
      this.#skyboxAction = instance.mixer.clipAction(clip);
      this.#skyboxAction.setLoop(THREE.LoopRepeat, Infinity);
      this.#skyboxAction.play();
    }
    // A LightSkybox clip is a game-day presentation (Dalaran's 320s track crossfades day, sunset
    // and night), not a 320-second wall-clock loop. Set the mixer explicitly so a stalled tab or a
    // fast frame rate cannot make the sky drift away from the LightClient's sampled bands.
    const durationMs = clip && Number.isFinite(clip.duration) ? clip.duration * 1000 : 0;
    this.#skyboxAnimationMs = skyboxAnimationTimeMs(this.#lightTime, durationMs);
    instance.mixer.setTime(this.#skyboxAnimationMs / 1000);
    if (this.#skyboxModel) applyGlobalSequenceBones(instance, template,
      this.#skyboxModel.globalSequences, this.#waterShaderUniforms.time.value * 1000);
    applyBillboardBones(instance, template, this.#camera);
    instance.root.updateWorldMatrix(true, true);
  }

  #clearSkybox(): void {
    this.#skyboxAnimatedBatches = [];
    this.#skyboxModel = undefined;
    this.#skyboxBuilt = undefined;
    this.#skyboxDecodedModel = undefined;
    this.#skyboxLegacyGeometry = undefined;
    this.#skyboxMaterialEntries = undefined;
    this.#skyboxVisual = undefined;
    disposeSkinnedInstance(this.#skyboxSkinned);
    this.#skyboxSkinned = undefined;
    this.#skyboxTemplate = undefined;
    this.#skyboxAction = undefined;
    this.#skyboxAnimationMs = 0;
    for (const child of [...this.#skyboxGroup.children]) {
      this.#skyboxGroup.remove(child);
      this.#skyWarmup.unregisterObject(child);
      child.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) material.dispose();
      });
    }
  }

  /**
   * Whether the character is under a roof.
   *
   * Told rather than worked out here, and by the collision world rather than by the artwork. The
   * rule this replaces asked whether the character's point was inside the axis-aligned box of any
   * group the file marks indoor — which in a city is not a question about rooms. Stormwind is 276
   * indoor groups out of 284, and their boxes are districts up to 322 by 236 yards, stacked and
   * overlapping: measured, 59.4% of the surface of the city's own outdoor groups fell inside one
   * of them, so the rain was switched off over the Trade District, the Cathedral Square, the Old
   * Town, the Mage Quarter, the Dwarven District, the Park and the canals alike. Only the Valley
   * of Heroes came out in the open.
   *
   * The character and not the camera. In third person the camera trails behind and above, so
   * testing it stops the rain while the player is standing in the open next to a doorway, and
   * starts it again when the camera clips through a wall.
   */
  setIndoors(indoors: boolean): void {
    this.#indoors = indoors;
  }

  /**
   * The last `setIndoors` answer — the floor under the character is a WMO group without MOGP 0x8.
   * Read, not recomputed, by the stock UI's ZONE_CHANGED_INDOORS test (`playerIndoors`).
   */
  get indoors(): boolean {
    return this.#indoors;
  }

  /** Where to find a model's own liquid. Told once, like everything else the frame hands over. */
  setCollisionModels(models: ((name: string) => CollisionModel | undefined) | undefined): void {
    this.#collisionModels = models;
  }

  /**
   * «Дальность прорисовки объектов»: the stock client's `environmentDetail` multiplier (0.5–1.5)
   * on every M2 scenery leash. Clamped; a change reselects the candidates on the next frame, and
   * residents past the new leash leave through the ordinary hysteresis and warm caps.
   */
  setEnvironmentDetail(detail: number): void {
    const next = environmentDetailScale(detail);
    if (next === this.#environmentDetail) return;
    this.#environmentDetail = next;
    this.#environmentCandidatesAt = undefined;
  }

  /** The applied `environmentDetail` multiplier. */
  get environmentDetail(): number {
    return this.#environmentDetail;
  }

  /**
   * Where the ground-cover recipes come from, how far the field reaches and how thickly it grows.
   *
   * Pushed rather than read, the same way the render scale is: the settings window calls this the
   * moment either option changes, and a radius of zero takes the whole field down. `dense` is the
   * density unit — see `ScatterOptions.perCell` in `GroundCover.ts` for why that is a question at
   * all and what the two answers look like on screen.
   *
   * Called with no client at all when a world is left, which is the same thing the collision
   * models above are told and for the same reason: the recipes belong to the realm just left, and
   * a field standing in the scene while the next one loads is a meadow from the wrong zone.
   */
  setGroundCover(client: GroundCoverClient | undefined,
    radius = this.#groundCoverRadius, dense = this.#groundCoverDense,
    density = this.#groundCoverDensity): void {
    const clamped = Math.max(0, Math.min(GROUND_COVER_MAX_RADIUS, Number.isFinite(radius) ? radius : 0));
    const scale = Number.isFinite(density) && density > 0 ? Math.min(4, density) : 1;
    if (this.#groundCover === client && this.#groundCoverRadius === clamped && this.#groundCoverDense === dense
      && this.#groundCoverDensity === scale) return;
    this.#groundCover = client;
    this.#groundCoverRadius = clamped;
    this.#groundCoverDense = dense;
    this.#groundCoverDensity = scale;
    this.#groundCoverSettings++;
    if (!client) this.#clearGroundCover();
  }

  /** Discards the current field when a world transfer changes the source of terrain data. */
  invalidateGroundCover(): void {
    this.#clearGroundCover();
  }

  /**
   * The water inside a building, laid in the scene at the placement's own frame.
   *
   * One mesh per grid, each with its geometry recentred on itself and the offset moved into the
   * mesh's position, so the sort key three uses is where the water actually is.
   *
   * Depth is not in the file. `MLIQ` stores four bytes before each height and they are flow, not
   * depth — measured, all zero on every vertex of the four canal grids — and TrinityCore does not
   * carry them at all. The shore fade the tile's water draws is therefore not available here, and
   * rather than invent a number the sheet is drawn at full depth. What it would take to do better
   * is a floor query per corner against the collision the client already holds; that is a
   * measurement to take, not a look to guess at.
   */
  #buildWmoLiquid(object: EnvironmentObject): THREE.Mesh[] | undefined {
    const model = this.#collisionModels?.(object.name);
    if (!model) return undefined;
    const frame = placeEnvironmentNode(new THREE.Object3D(), object);
    frame.updateMatrix();
    const toScene = new THREE.Matrix4().copy(frame.matrix)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(ADT_MODEL_TO_SCENE));
    const meshes: THREE.Mesh[] = [];
    for (const group of model.groups) {
      const liquid = group.liquid;
      if (!liquid || !isValidWmoLiquid(liquid)) continue;
      const positions: number[] = [];
      const uvs: number[] = [];
      const depths: number[] = [];
      const indices: number[] = [];
      for (let cellY = 0; cellY < liquid.tilesY; cellY++) {
        for (let cellX = 0; cellX < liquid.tilesX; cellX++) {
          // The low nibble is the cell's own mask, and 0x0f is the file saying "nothing here".
          if ((liquid.flags[cellY * liquid.tilesX + cellX]! & 0x0f) === 0x0f) continue;
          const base = positions.length / 3;
          for (const [stepX, stepY] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
            const cornerX = liquid.cornerX + (cellX + stepX) * LIQUID_CELL_YARDS;
            const cornerY = liquid.cornerY + (cellY + stepY) * LIQUID_CELL_YARDS;
            const height = liquid.heights[(cellY + stepY) * (liquid.tilesX + 1) + (cellX + stepX)]!;
            positions.push(cornerX, cornerY, height);
            // The same continuous tiling the terrain's water uses, in the model's own frame so the
            // pattern does not swim when the building is turned.
            uvs.push(cornerY / LIQUID_CELL_YARDS, cornerX / LIQUID_CELL_YARDS);
            depths.push(DEEP_WATER_YARDS);
          }
          indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
      if (indices.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute("liquidDepth", new THREE.Float32BufferAttribute(depths, 1));
      // WMO pools, canals and moats are still water to the enhanced ripples (Water `liquidCalmOf`).
      geometry.setAttribute("liquidCalm", new THREE.Float32BufferAttribute(new Float32Array(depths.length).fill(liquidCalmOf(liquid.type, true)), 1));
      geometry.setIndex(indices);
      geometry.applyMatrix4(toScene);
      // Recentred so the object's origin is the water's own middle, which is the key three sorts by.
      geometry.computeBoundingSphere();
      const centre = geometry.boundingSphere?.center.clone() ?? new THREE.Vector3();
      geometry.translate(-centre.x, -centre.y, -centre.z);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const liquidClass = liquidClassOf(0, liquid.type, this.#liquidTextures?.classes);
      const mesh = new THREE.Mesh(geometry, this.#liquidMaterial(liquidClass)?.material
        ?? this.#fallbackLiquidMaterial(liquidClass));
      mesh.position.copy(centre);
      mesh.renderOrder = 1;
      meshes.push(mesh);
    }
    return meshes.length > 0 ? meshes : undefined;
  }

  /** Drops a placement's water, which is the renderer's own and not shared with anything. */
  #dropWmoLiquid(rendered: RenderedEnvironment): void {
    for (const mesh of rendered.liquid ?? []) {
      mesh.geometry.dispose();
      this.#scene.remove(mesh);
    }
    delete rendered.liquid;
  }

  /**
   * Who is wearing a ring this frame.
   *
   * Told rather than asked: the renderer has the world state but not the faction table, and the
   * colour of a ring is the same answer the plate over the head gives. `draw` already takes
   * fifteen parameters, and the target is not something it needs in order to draw the world.
   */
  setSelection(target: SelectionRing | undefined, focus: SelectionRing | undefined): void {
    this.#selection = { target, focus };
  }

  /**
   * The ground reticle: where the click would land and the effect radius to draw around it.
   *
   * `undefined` clears it at once rather than on the next drawn frame, because the cancel paths
   * (right click, Escape, a world change) must not leave a ring on the ground for a frame that a
   * hidden world panel may not even draw.
   */
  setGroundTargetPreview(preview: GroundTargetPreview | undefined): void {
    this.#groundTarget = preview;
    if (!preview) this.#disposeGroundTargetRings();
  }

  /**
   * The duel flag's ring, `undefined` the moment there is no duel to bound.
   *
   * Cleared at once rather than on the next drawn frame, for the same reason as the reticle:
   * the end of a duel must not leave a 50-yard ring on the ground behind it.
   */
  setDuelRing(ring: DuelRing | undefined): void {
    this.#duelRing = ring;
    if (!ring) this.#disposeDuelRing();
  }

  /**
   * The enchant glow tint for a worn weapon slot.
   *
   * Pushed like the selection rather than threaded through `draw()`: the formal benchmark pins
   * the submission's trailing arguments, and a resolver set looks exactly like the model
   * callbacks the loop already pushes. Absent while the enchant table is loading — blades then
   * draw unlit, like helmets whose model has not arrived.
   */
  setEnchantGlow(
    resolve: ((object: WorldObjectState, slot: number) => EnchantGlow | undefined) | undefined,
  ): void {
    this.#enchantGlow = resolve;
  }

  /** The placing spell's ghost model; `undefined` removes it immediately. */
  setGameObjectPreview(preview: GameObjectPreview | undefined): void {
    this.#gameObjectPreview = preview;
    if (!preview) this.#disposeGameObjectPreview();
  }

  /** Assigns the five DOM outputs. The render targets themselves remain owned by the renderer. */
  setPortraitTargets(targets: ReadonlyMap<PortraitSlot, PortraitTarget>): void {
    this.#portraits.setTargets(targets);
  }

  /** True only when the shared world model/build is ready for a non-empty static portrait. */
  portraitSourceReady(guid: bigint): boolean {
    return this.#portraitSource(guid) !== undefined;
  }

  /** Submits dirty portrait readbacks after the world pass. */
  renderPortraits(now = performance.now()): number {
    try {
      return this.#portraits.render(now);
    } finally {
      this.#shaderProgramTrace?.mark("portraits", this.#renderer.info.programs, performance.now());
    }
  }

  /** Marks a RAF in which the world renderer was intentionally not submitted (loading/hidden UI). */
  markFrameNotRendered(): void {
    this.#resetFrameCounters();
  }

  /**
   * Starts one renderer-owned frame around world update/submission and dirty portrait readback.
   *
   * The depth makes an accidental nested pair harmless: only the outer pair resets/restores
   * three.js counters and owns the single GPU query. Telemetry is best-effort and never throws into
   * the animation loop; a failed setup simply leaves this frame unsampled.
   */
  beginRenderFrame(): void {
    this.#renderFrameDepth++;
    if (this.#renderFrameDepth !== 1) return;
    this.#renderFrameStartedAt = performance.now();
    this.#renderFrameGpuActive = false;
    this.#renderFrameAutoReset = this.#renderer.info.autoReset;
    try {
      this.#renderer.info.reset();
      this.#renderer.info.autoReset = false;
      this.#renderFrameGpuActive = this.#gpuTimer.beginFrame();
    } catch {
      // Instrumentation must never stop a drawable frame or leave three's global counter mode set.
      try { this.#renderer.info.autoReset = this.#renderFrameAutoReset; } catch { /* best effort */ }
      this.#renderFrameDepth = 0;
      this.#renderFrameStartedAt = undefined;
      this.#renderFrameGpuActive = false;
    }
  }

  /**
   * Closes the outer renderer frame. Safe as a no-op without a matching begin and non-throwing even
   * if WebGL context loss makes query finalization or counter reads fail.
   */
  endRenderFrame(): number | undefined {
    if (this.#renderFrameDepth === 0) return undefined;
    this.#renderFrameDepth--;
    if (this.#renderFrameDepth !== 0) return undefined;

    const endedAt = performance.now();
    const startedAt = this.#renderFrameStartedAt;
    const gpuActive = this.#renderFrameGpuActive;
    this.#renderFrameStartedAt = undefined;
    this.#renderFrameGpuActive = false;
    try {
      if (gpuActive) this.#gpuTimer.endFrame();
    } catch {
      // GpuTimer is already defensive; this boundary also protects the RAF if its contract changes.
    } finally {
      try {
        // autoReset=false keeps sky, world and every dirty portrait in this one renderer.info sum.
        this.#drawCalls = this.#renderer.info.render.calls;
        this.#triangles = this.#renderer.info.render.triangles;
      } catch {
        this.#drawCalls = 0;
        this.#triangles = 0;
      } finally {
        try { this.#renderer.info.autoReset = this.#renderFrameAutoReset; } catch { /* best effort */ }
      }
    }
    if (startedAt === undefined) return undefined;
    const elapsed = endedAt - startedAt;
    this.#frames.add(elapsed);
    return elapsed;
  }

  /** Drops pending GPU queries and starts a clean diagnostic timing epoch. */
  resetGpuTimingEpoch(): GpuTimerUnavailableReason | undefined {
    return this.#gpuTimer.resetEpoch();
  }

  /** Drops all portrait instances, render targets and output pixels on a world-context change. */
  clearPortraits(): void {
    this.#portraits.clear();
  }

  /** Detaches every terrain material before its splat textures can be released. */
  public clearTerrain(): void {
    this.#cancelTerrainRepair();
    this.#terrainRepairsPending = 0;
    for (const [key, rendered] of this.#terrains) this.#removeTerrain(key, rendered);
    this.#cancelTerrainPreparation();
    this.#terrainWindow.clear();
    this.#terrainPlan = undefined;
  }

  /**
   * Drops everything owned by the current realm/session while keeping the renderer and permanent
   * scene shell ready for the next one. Safe to call repeatedly.
   */
  clearWorldResources(): void {
    this.#worldResourceEpoch++;
    this.#worldTexturesPending = 0;
    this.#worldTextureErrors.clear();
    this.#worldTextureGeneration++;
    // Programs park themselves on materials; a world's materials are about to be disposed, and a
    // stand-in left over from it would compile a program nothing will ever draw.
    this.#programWarmup.reset();
    this.#wmoWarmHolds.clear();
    this.#instanceWarmHolds.clear();
    this.#unitWarmHolds.clear();
    this.#unitPartWarmHolds.clear();
    this.#visualWarmHold.clear();
    this.#effectWarmHold.clear();
    this.#skyWarmup.reset();
    this.#overlayWarmup.reset();
    this.#glowWarmup.reset();

    this.clearSpellVisuals();
    // Prewarm claims belong to the session that made them. Releasing before the cache is cleared
    // below leaves no lease pointing at a record that is about to be disposed.
    this.#spellWarmTextures.clear();
    this.#spellPrewarmPaths.clear();
    for (const rendered of this.#environment.values()) this.#disposeEnvironment(rendered);
    this.#environment.clear();
    for (const rendered of this.#gameObjects.values()) this.#disposeGameObject(rendered);
    this.#gameObjects.clear();
    this.#gameObjectAnimations.clear();
    for (const unit of this.#units.values()) {
      this.#unitGroup.remove(unit.node);
      this.#clearUnitNode(unit);
      unit.material.dispose();
    }
    this.#units.clear();
    this.#actions.clear();
    this.#mountSpecials.clear();
    for (const key of [...this.#effects.keys()]) this.#dropEffects(key);

    this.#clearSkybox();
    // All world-material borrowers are detached before the shared material/base lane is drained.
    this.#worldMaterials.dispose();
    this.#worldMaterialGenerationOffset += this.#worldMaterialTextures.stats.generation
      + this.#worldMaterials.revision;

    const disposedLegacyGeometries = new Set<THREE.BufferGeometry>();
    for (const entry of this.#legacyGeometries.values()) {
      if (disposedLegacyGeometries.has(entry.geometry)) continue;
      disposedLegacyGeometries.add(entry.geometry);
      entry.geometry.dispose();
    }
    this.#legacyGeometries.clear();
    this.#legacyModelKeys = new WeakMap<EnvironmentModel, string>();
    this.#legacySkinnedFailures = new WeakSet<EnvironmentModel>();
    this.#legacyModelSerial = 0;

    this.#worldMaterialTextures = new ModelTextureLoader({
      cache: true,
      limits: {
        count: WMO_WORLD_TEXTURE_CACHE_COUNT_LIMIT,
        knownLogicalTextureBytes: WMO_WORLD_TEXTURE_CACHE_KNOWN_BYTE_LIMIT,
      },
    });
    this.#worldMaterials = new WorldMaterialCache(this.#worldMaterialTextures, {
      limits: { count: WORLD_MATERIAL_CACHE_COUNT_LIMIT },
    });
    this.clearTerrain();
    if (this.#horizon) {
      this.#scene.remove(this.#horizon.mesh);
      this.#horizon.mesh.geometry.dispose();
      this.#horizon = undefined;
    }
    this.#clearGroundCover();
    for (const key of [...this.#instances.keys()]) this.#dropInstance(key);
    for (const ring of this.#selectionRings.values()) {
      this.#scene.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      ring.material.dispose();
    }
    this.#selectionRings.clear();
    this.#disposeGroundTargetRings();
    this.#groundTarget = undefined;
    this.#disposeDuelRing();
    this.#duelRing = undefined;
    this.#enchantGlow = undefined;
    this.#disposeGameObjectPreview();
    this.#gameObjectPreview = undefined;
    this.#portraits.clear();

    // Before the weather: the atmosphere hands the weather its faithful material back.
    this.#atmosphere?.dispose();
    this.#atmosphere = undefined;
    this.#atmosphereProfile = DEFAULT_ATMOSPHERE_PROFILE;
    setWmoWetness(false, false);
    this.#atmosphereFrame = undefined;
    this.#atmosphereVegetationAt = Number.NEGATIVE_INFINITY;
    if (this.#weather) {
      this.#scene.remove(this.#weather.object);
      this.#weather.dispose();
      this.#weather = undefined;
    }
    for (const liquid of this.#liquidMaterials.values()) liquid.material.dispose();
    this.#liquidMaterials.clear();
    for (const material of this.#fallbackLiquidMaterials.values()) material.dispose();
    this.#fallbackLiquidMaterials.clear();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    for (const built of this.#builtModels.values()) {
      disposeBuiltModelResources(built, geometries, materials, textures);
    }
    for (const built of this.#builtUnits.values()) {
      disposeBuiltModelResources(built, geometries, materials, textures);
    }
    this.#builtModels.clear();
    this.#builtUnits.clear();
    this.#skinnedTemplates.clear();
    this.#wmoGeometryBuild.clear();
    for (const entry of this.#wmoGeometries.values()) {
      if (geometries.has(entry.geometry)) continue;
      geometries.add(entry.geometry);
      entry.geometry.dispose();
    }
    this.#wmoGeometries.clear();
    this.#wmoPreparedGeometryPins.clear();
    this.#wmoModelKeys = new WeakMap<WmoModel, string>();
    this.#wmoModelSerial = 0;
    this.#atlases?.dispose();
    this.#atlases = undefined;
    this.#atlasFrameDemands.clear();
    this.#atlasFrameActive.clear();
    this.#textures.clear();
    this.#spellTextures.clear();

    this.#baseUrl = "";
    this.#environmentObjects = undefined;
    this.#environmentSpatialIndex = undefined;
    this.#environmentVisibilitySpheres = new WeakMap();
    this.#environmentGeneration++;
    this.#environmentCandidates = [];
    this.#environmentResidents = [];
    this.#residentMembership = undefined;
    this.#admittedMembership = undefined;
    this.#prefetchCandidates = undefined;
    this.#prefetchCursor = 0;
    this.#prefetchNames = [];
    this.#environmentCandidatesAt = undefined;
    this.#warmPruneAtSerial = -WARM_PRUNE_INTERVAL_FRAMES;
    this.#lastAdmitted = undefined;
    this.#admissionCandidates = undefined;
    this.#growingVegetation = 0;
    this.#terrainPlan = undefined;
    this.#instancesDirty = false;
    this.#groundCover = undefined;
    this.#groundCoverAt = undefined;
    this.#groundCoverCells = createGroundCoverCellCache();
    this.#groundCoverCellsKey = undefined;
    this.#environmentReselectedSerial = -1;
    this.#liquidTextures = undefined;
    this.#collisionModels = undefined;
    this.#lightSample = undefined;
    this.#lightTime = 0;
    this.#skyboxPath = undefined;
    this.#skyboxLoadedPath = undefined;
    this.#wmoFloor = undefined;
    this.#wmoFogVisualId = undefined;
    this.#wmoFogCandidate = undefined;
    this.#indoors = false;
    this.#underwater = false;
    // The switch itself is the account's and survives a realm change; the surface is one frame's
    // observation and must not tint the first frame of the next world.
    this.#underwaterSurface = undefined;
    // Same rule for the glow: the leaf is the account's, the strength is the zone's. A client
    // sitting on the character screen holds neither the number nor the buffers behind it — the
    // targets come back on the first frame of the next world, from `#resize`.
    this.#glowStrength = 0;
    this.#disposeFullscreenGlowTargets();
    this.#selection = { target: undefined, focus: undefined };
    this.#weatherPacket = undefined;
    this.#weatherFade = { kind: "fine", density: 0, storm: 0 };
    this.#weatherAbrupt = false;
    this.#replaySeed = undefined;
    this.#realModels = 0;
    this.#experimentalShaderProfile = DEFAULT_EXPERIMENTAL_SHADER_PROFILE;
    this.#waterShaderUniforms.time.value = 0;
    VEGETATION_WIND_TIME.value = 0;
    this.#resetLightingDefaults();
    this.#frames.reset();
    this.#cadence.reset();
    this.#gpuTimer.resetEpoch();
    this.#renderer.info.reset();
    this.#renderer.renderLists.dispose();
    this.#sun.shadow.dispose();
    this.#sunCascades.disposeMaps();
    this.#resetFrameCounters();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clearWorldResources();
    this.#canvas.removeEventListener("webglcontextlost", this.#contextLostListener);
    this.#canvas.removeEventListener("webglcontextrestored", this.#contextRestoredListener);
    this.#canvasSizeObserver?.disconnect();
    this.#canvasSizeObserver = undefined;
    this.#observedCanvasSize = undefined;
    this.#portraits.dispose();
    this.#gpuTimer.dispose();
    this.#waterDetailMaps.dispose();
    this.#disposeFullscreenGlowTargets();
    for (const geometry of [
      this.#unitBodyGeometry, this.#unitFacingGeometry, this.#foliageGeometry, this.#trunkGeometry,
      this.#sky.geometry, this.#underwaterOverlay.geometry, this.#glowPasses.quad.geometry,
    ]) geometry.dispose();
    for (const material of [
      this.#horizonMaterial, this.#wmoMaterial, this.#m2Material, this.#stoneMaterial,
      this.#woodMaterial, this.#metalMaterial, this.#foliageMaterial,
      ...(Array.isArray(this.#sky.material) ? this.#sky.material : [this.#sky.material]),
      ...(Array.isArray(this.#underwaterOverlay.material)
        ? this.#underwaterOverlay.material : [this.#underwaterOverlay.material]),
      // All four by name, not the one the quad happens to be wearing: the pass materials are
      // swapped onto it during a frame, so a traversal would find at most one of them.
      this.#glowPasses.extract, this.#glowPasses.blur, this.#glowPasses.composite,
      this.#glowPasses.godRays,
    ]) material.dispose();
    this.#sunCascades.dispose();
    this.#scene.clear();
    this.#skyScene.clear();
    this.#overlayScene.clear();
    this.#glowPasses.scene.clear();
    this.#renderer.dispose();
  }

  /**
   * The rings, laid on whatever the two marked units are standing on.
   *
   * Drawn in the scene rather than on the 2D overlay, which is the whole point of the item: the
   * overlay's ring was a circle projected around a point at one height, so on any slope worth
   * noticing half of it sank into the hill and the other half floated. This one is geometry, and
   * it is depth-tested like everything else — a target behind a wall no longer has a ring painted
   * over the wall.
   */
  #updateSelectionRings(state: WorldState, heightAt: HeightSampler | undefined): void {
    for (const kind of ["target", "focus"] as const) {
      const wanted = this.#selection[kind];
      const object = wanted === undefined ? undefined : state.objects.get(wanted.guid);
      const position = object === undefined ? undefined : drawnUnitPosition(object, this.#ringSeatDrawn); // 11.02-tails: on the seat
      // A corpse keeps no ring: the renderer lays a dead body down at its full length, so a ring
      // round its feet would sit at one end of it and read as a ring round nothing.
      if (!wanted || !object || !position || isWorldObjectDead(object)) {
        const stale = this.#selectionRings.get(kind);
        if (stale) {
          this.#scene.remove(stale.mesh);
          stale.mesh.geometry.dispose();
          stale.material.dispose();
          this.#selectionRings.delete(kind);
        }
        continue;
      }
      let ring = this.#selectionRings.get(kind);
      if (!ring) {
        const material = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          // Written into no depth buffer and tested against the real one: the ring is on the
          // ground, so a wall in front of it must hide it, and nothing behind it must be hidden by
          // it. The polygon offset is what keeps it off the surface it is lying on.
          depthWrite: false,
          side: THREE.DoubleSide,
          // A flat ring on the ground has one facing per eye; one pass composites as two.
          forceSinglePass: true,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
          toneMapped: false,
        });
        const mesh = new THREE.Mesh(buildSelectionRingGeometry(), material);
        mesh.frustumCulled = false;
        ring = { mesh, material };
        this.#selectionRings.set(kind, ring);
        this.#scene.add(mesh);
      }
      ring.material.color.setHex(wanted.colour);
      ring.material.opacity = kind === "target" ? 0.85 : 0.5;
      const height = this.#units.get(wanted.guid)?.height ?? UNIT_DEFAULT_HEIGHT;
      const radius = Math.max(0.6, Math.min(6, height * 0.38)) * (kind === "target" ? 1 : 0.82);
      updateSelectionRing(ring.mesh.geometry, position, radius, heightAt);
    }
  }

  /**
   * The aiming reticle's two rings, laid on the surfaces the click resolver used.
   *
   * The point marker is always there; the radius ring only when the spell's own `EffectRadius`
   * names one, so a single-target ground spell shows where it lands and nothing wider. Colours are
   * chosen to disagree with every selection ring in the world: a pale point and a green area.
   */
  #updateGroundTargetRings(): void {
    const preview = this.#groundTarget;
    if (!preview) {
      this.#disposeGroundTargetRings();
      return;
    }
    const wanted: Array<{ kind: "point" | "radius"; radius: number; colour: number; opacity: number }> = [
      { kind: "point", radius: 0.75, colour: preview.inRange ? 0xfff2c0 : 0xff8a7a, opacity: 0.95 },
    ];
    if (preview.radius >= 1) {
      wanted.push({
        kind: "radius", radius: preview.radius,
        colour: preview.inRange ? 0x63d6a0 : 0xff5f4a, opacity: 0.55,
      });
    }
    for (const entry of wanted) {
      let ring = this.#groundTargetRings.get(entry.kind);
      if (!ring) {
        const mesh = new THREE.Mesh(buildSelectionRingGeometry(), new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          forceSinglePass: true,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
          toneMapped: false,
        }));
        mesh.frustumCulled = false;
        ring = { mesh, material: mesh.material as THREE.MeshBasicMaterial };
        this.#groundTargetRings.set(entry.kind, ring);
        this.#scene.add(mesh);
      }
      ring.material.color.setHex(entry.colour);
      ring.material.opacity = entry.opacity;
      updateSelectionRing(ring.mesh.geometry, preview, entry.radius, preview.ground);
    }
    const kinds = new Set(wanted.map((entry) => entry.kind));
    for (const [kind, ring] of [...this.#groundTargetRings]) {
      if (kinds.has(kind)) continue;
      this.#scene.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      ring.material.dispose();
      this.#groundTargetRings.delete(kind);
    }
  }

  #disposeGroundTargetRings(): void {
    for (const ring of this.#groundTargetRings.values()) {
      this.#scene.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      ring.material.dispose();
    }
    this.#groundTargetRings.clear();
  }

  /**
   * The duel bounds ring at the planted flag, drawn at the server's own out-of-bounds distance.
   *
   * Green while the duelist is inside, the reticle's out-of-range red once `SMSG_DUEL_OUTOFBOUNDS`
   * has arrived. No ring at all when the flag object has not streamed in: a ring at a guessed
   * point would bound the wrong forty (fifty) yards.
   */
  #updateDuelRing(heightAt: HeightSampler | undefined): void {
    const ring = this.#duelRing;
    if (!ring) {
      this.#disposeDuelRing();
      return;
    }
    let mesh = this.#duelRingMesh;
    if (!mesh) {
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        toneMapped: false,
      });
      const built = new THREE.Mesh(buildSelectionRingGeometry(), material);
      built.frustumCulled = false;
      mesh = { mesh: built, material };
      this.#duelRingMesh = mesh;
      this.#scene.add(built);
    }
    mesh.material.color.setHex(ring.inBounds ? 0x63d6a0 : 0xff5f4a);
    mesh.material.opacity = 0.55;
    updateSelectionRing(mesh.mesh.geometry, ring, DUEL_OUT_OF_BOUNDS_YARDS, heightAt);
  }

  #disposeDuelRing(): void {
    if (!this.#duelRingMesh) return;
    this.#scene.remove(this.#duelRingMesh.mesh);
    this.#duelRingMesh.mesh.geometry.dispose();
    this.#duelRingMesh.material.dispose();
    this.#duelRingMesh = undefined;
  }

  /**
   * The placing spell's ghost, placed and scaled from the preview the aiming flow resolved.
   *
   * The model is built once through the ordinary environment path and then cloned material by
   * material: geometry and textures stay the caches', only the translucent shells belong here.
   * A model that has not arrived, or one that turned out to be a building, leaves nothing — the
   * rings still show, and the next frame tries the model again.
   */
  #updateGameObjectPreview(client: EnvironmentClient | undefined): void {
    const preview = this.#gameObjectPreview;
    if (!preview) {
      this.#disposeGameObjectPreview();
      return;
    }
    let ghost = this.#gameObjectPreviewNode;
    if (ghost?.model !== preview.model) {
      this.#disposeGameObjectPreview();
      const model = client?.model(preview.model, "normal");
      if (!model || !drawableModel(model) || model.wmo !== undefined) return;
      const placement: EnvironmentObject = {
        id: -1, kind: "m2", name: preview.model, x: 0, y: 0, z: 0,
        rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
      };
      const node = this.#modelNode(placement, model);
      const materials = ghostModelMaterials(node);
      if (materials.length === 0) return;
      ghost = {
        model: preview.model, node, materials,
        ...(node.userData["builtModel"] ? { built: node.userData["builtModel"] as BuiltModel } : {}),
        ...(node.userData["legacyGeometry"]
          ? { legacyGeometry: node.userData["legacyGeometry"] as LegacyGeometryEntry } : {}),
        ...(Array.isArray(node.userData["worldMaterialEntries"])
          ? { materialEntries: node.userData["worldMaterialEntries"] as readonly WorldMaterialEntry[] } : {}),
      };
      this.#gameObjectPreviewNode = ghost;
      this.#gameObjectGroup.add(node);
    }
    if (!ghost) return;
    ghost.node.position.set(preview.x, preview.z, -preview.y);
    ghost.node.quaternion.setFromRotationMatrix(mappedVmapRotation(
      0, THREE.MathUtils.radToDeg(preview.orientation), 0));
    ghost.node.scale.setScalar(Math.max(0.05, Math.min(40, preview.scale)));
  }

  #disposeGameObjectPreview(): void {
    const ghost = this.#gameObjectPreviewNode;
    if (!ghost) return;
    this.#gameObjectGroup.remove(ghost.node);
    for (const material of ghost.materials) material.dispose();
    this.#gameObjectPreviewNode = undefined;
  }

  #anisotropy(): number {
    return this.#cachedAnisotropy ??= this.#renderer.capabilities.getMaxAnisotropy();
  }

  #updateVisuals(now: number, elapsed: number, client: EnvironmentClient | undefined): void {
    // First, and before the early return below: prewarming is for the casts that have *not* started
    // yet, so it must run on frames where there is nothing to draw.
    this.#pumpSpellPrewarm(now, client);
    // Keep future impact poses out of the unit action map until their authored arrival. Removing
    // the queue entry before starting it makes the transition exactly-once even when a frame is
    // long or the same unit receives another action later in the cast.
    for (let index = 0; index < this.#pendingVisualAnimations.length;) {
      const pending = this.#pendingVisualAnimations[index]!;
      if (!visualAnimationIsDue(pending.animation, now)) {
        index++;
        continue;
      }
      this.#pendingVisualAnimations.splice(index, 1);
      this.#setUnitAnimation(pending.animation, "visual", pending.handle);
    }
    // Propagate a request-grace timeout to every member before authored-lifetime cleanup runs. This
    // is the persistent terminal transition that prevents a loaded sibling from becoming a partial
    // kit while its missing missile/impact is being removed on the same frame.
    this.#markExpiredSpellEffectPhases(now);
    // A terminal phase owns no visible model or emitter resources. Purge every member before the
    // loader loop below can observe a late WVM and rebuild a failed aura/missile.
    this.#purgeFailedSpellEffectPhases();
    // Single reverse pass: the triple map/filter/map this replaces allocated three short-lived
    // arrays on every frame with live visuals.
    for (let index = this.#visuals.length - 1; index >= 0; index--) {
      const visual = this.#visuals[index]!;
      if (visual.instance.endsAt > now
        || this.#phaseNeedsSettlement(visual, now)
        || (visual.loadDeadline !== undefined && now < visual.loadDeadline)) continue;
      this.#visualGroup.remove(visual.node);
      this.#dropEffects(visual.key);
      this.#disposeRenderedVisual(visual);
      this.#visuals.splice(index, 1);
    }
    if (this.#visuals.length === 0) return;

    for (const visual of this.#visuals) {
      const { instance } = visual;
      const started = visualHasStarted(instance, now);
      if (!visual.wvm) {
        // Keyed on the path alone, so a fireball's bolt is one download however many are in the
        // air. `model` queues the request and answers undefined until it lands.
        const model = client?.model(instance.path, "critical");
        if (model?.wvm) {
          visual.wvm = model.wvm;
          // A successful WVM response resolves loading regardless of whether it has geometry,
          // bones, or clips. The grace is only for the request, never a fallback lifetime.
          visual.loadDeadline = undefined;
          const resolvedOrigin = instance.modelPlayback === "hold" && instance.startedAt === 0
            ? now : visualPlaybackOrigin(instance, now);
          visual.playbackStartedAt = spellEffectPhaseOrigin(instance,
            visual.phaseOriginAt, resolvedOrigin);
          if (instance.fitToModel && !instance.flight && Number.isFinite(visual.authoredEndsAt)) {
            const window = visualPlaybackWindow(instance, 0, visual.authoredEndsAt);
            if (window > 0) {
              instance.endsAt = Math.max(visual.authoredEndsAt,
                (visual.playbackStartedAt ?? instance.startedAt) + window);
            }
          }
          // Every geoset, and keyed apart from the doodad build of the same path. An effect
          // model's submeshes are not variants of one another the way a character's hairstyles
          // are — there is nothing to choose between, and choosing shows a third of the effect.
          const rig = model.wvm.skeleton;
          // Spell materials carry local alpha/weight tracks. They must not share the scenery cache:
          // #updateBatchColours advances scenery on the wall clock, while a cast needs its own
          // phase origin so Judgement cannot alternate between a visible hammer and a faded batch
          // merely because another cast or a slow frame happened at a different timestamp.
          const built = buildModel(model.wvm, {
            modelPath: instance.path,
            baseUrl: this.#baseUrl,
            loadTexture: (url) => this.#acquireSpellTexture(visual, url),
            borrowLoadedTextures: true,
            privateLoadedTextureViews: true,
            geosets: EVERY_GEOSET,
            skinned: Boolean(rig),
            anisotropy: this.#anisotropy(),
            worldLight: this.#worldLight,
            fantasyGlow: this.#experimentalShaderProfile.fantasyGlow,
          });
          visual.built = built;
          if (rig) {
            // A spell WVM is allowed to be emitter-only. It still needs a real skeleton and
            // mixer: emitter bone matrices are sampled from the same rig as a visible mesh.
            // A spell owns this template for the life of its visual. Sharing a template would
            // share its geometry and, more importantly, make disposing one cast invalidate another
            // cast's local materials/clock.
            const templateRig = rig.clips.length === 0 && rig.animations.length === 0
              ? { ...rig, animations: [0] } : rig;
            let template = buildSkinnedTemplateFrom(built.geometry, templateRig, built.height) ?? null;
            if (template && template.clips.size === 0) {
              template.clips.set(0, new THREE.AnimationClip("spell-default", 1, []));
            }
            visual.template = template ?? undefined;
            if (visual.template) {
              visual.skinned = instantiateSkinned(visual.template, built.materials);
              visual.frame.add(visual.skinned.root);
              this.#programWarmup.registerObject(visual.skinned.root);
              const clip = visual.template.clips.get(0) ?? visual.template.clips.values().next().value;
              if (clip) {
                const action = visual.skinned.mixer.clipAction(clip);
                action.reset();
                const modelLoop = instance.modelPlayback === "hold";
                action.setLoop(modelLoop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
                action.clampWhenFinished = !modelLoop;
                action.play();
                const age = Math.max(0, (now - (visual.playbackStartedAt ?? instance.startedAt)) / 1000);
                action.time = Math.min(clip.duration, age);
                visual.action = action;
                // Finite, non-flight visuals may not be cut off before their authored model clip.
                // Flight endpoints and packet/aura-owned lifetimes are deliberately untouched.
                if (instance.fitToModel && !instance.flight && Number.isFinite(instance.endsAt)) {
                  const modelMs = Math.min(MODEL_VFX_MAX_MS, Math.max(0, clip.duration * 1000));
                  const window = visualPlaybackWindow(instance, modelMs, visual.authoredEndsAt);
                  if (window > 0) {
                    instance.endsAt = Math.max(visual.authoredEndsAt,
                      (visual.playbackStartedAt ?? instance.startedAt) + window);
                  }
                }
              }
            }
          } else if (built.materials.length > 0) {
            // Only when there is something to draw: many effect models are emitters and nothing
            // else, so the frame remains the emitter anchor without a placeholder mesh.
            const mesh = new THREE.Mesh(built.geometry, built.materials);
            visual.visual = mesh;
            visual.frame.add(mesh);
            this.#programWarmup.registerObject(mesh);
          }
        }
      }

      // Preloading/building a future model is intentional, but neither its transform nor its
      // emitters may become visible before the schedule says so.
      visual.node.visible = started;
      if (!started) continue;

      if (visual.skinned) {
        visual.skinned.mixer.update(elapsed);
        applyGlobalSequenceBones(visual.skinned, visual.template!, visual.wvm!.globalSequences, now);
      }

      if (instance.flight) {
        const progress = visualFlightProgress(instance, now);
        missilePoint(instance.flight.from, instance.flight.to, progress, _flightPoint);
        visual.node.position.set(_flightPoint.x, _flightPoint.z, -_flightPoint.y);
        // Pointed along the actual 3D flight tangent: a bolt drawn facing wherever the model
        // happened to face is a bolt flying sideways, and yaw alone leaves an upward/downward
        // shot visibly flat. The helper converts the server's (x, y, z-up) tangent into this
        // scene's (x, y-up, -z) frame and rotates model +X onto it.
        spellVisualFlightQuaternion(instance.flight.from, instance.flight.to, progress, visual.node.quaternion);
        this.#orientVisualFrame(visual);
        visual.node.scale.setScalar(instance.scale);
        this.#applySpellBillboards(visual);
        continue;
      }

      if (instance.anchor !== undefined && instance.attachment < 0) {
        const unit = this.#units.get(instance.anchor);
        const root = unit?.skinned?.root ?? unit?.node;
        if (!unit || !root) {
          // A state/world-bound visual follows the unit; do not leave it at the first position
          // (or at the origin) while the unit is off-screen or between model forms.
          visual.node.visible = false;
          continue;
        }
        root.updateWorldMatrix(true, false);
        root.matrixWorld.decompose(visual.node.position, visual.node.quaternion, _scratchScale);
        visual.node.scale.setScalar(instance.scale * _scratchScale.x);
        this.#orientVisualFrame(visual, Boolean(unit.skinned));
        this.#applySpellVisualTransform(visual, Boolean(unit.skinned));
        this.#applySpellBillboards(visual);
        continue;
      }

      if (instance.anchor !== undefined && instance.attachment >= 0) {
        const bone = this.#attachmentBone(instance.anchor, instance.attachment);
        visual.node.visible = bone !== undefined || instance.position !== undefined;
        if (bone) {
          // The bone's frame already carries the unit's placement and the quarter turn that maps
          // model space into the scene, so the effect's own model space is the bone's and it
          // needs no rotation of its own — the same reason a sword hung on a hand needs none.
          // What a sword *does* get and this used to skip is the authored offset from the bone's
          // pivot to the point itself: an item is parented to the bone and `#attachModel` copies
          // that offset into its local position, while a spell effect is a top-level node and had
          // only the decomposed pivot. See `#spellAttachmentOffset` for what that cost.
          placeOnAttachmentBone(bone.matrixWorld,
            this.#spellAttachmentOffset(visual, instance.anchor, instance.attachment),
            instance.scale, visual.node);
          this.#orientVisualFrame(visual, true);
          this.#applySpellVisualTransform(visual, true);
          this.#applySpellBillboards(visual);
          continue;
        }
        // The unit is gone, or has not been built yet. Fall through to whatever place the plan
        // recorded rather than leaving the effect at the world origin.
      }

      // Everything that flies has already been placed and skipped; what is left stands still.
      const at = instance.position;
      if (at) {
        visual.node.position.set(at.x, at.z, -at.y);
        visual.node.rotation.set(0, 0, 0);
        this.#orientVisualFrame(visual);
        this.#applySpellVisualTransform(visual);
        visual.node.scale.setScalar(instance.scale);
      }
      this.#applySpellBillboards(visual);
    }
  }

  /** A free-standing effect is drawn in model space, so its frame carries the turn into the scene. */
  #faceModelSpace(visual: RenderedVisual): void {
    visual.frame.quaternion.copy(M2_TO_SCENE);
  }

  #orientVisualFrame(visual: RenderedVisual, unitRig = false): void {
    // A free-standing skinned root owns M2_TO_SCENE and a free-standing plain mesh needs it on
    // the frame. A unit/bone matrix already contains that quarter-turn, however: plain attached
    // effects therefore use an identity frame, while skinned attached effects cancel their root's
    // own copy. Without the inverse, target-bound skinned effects received M2_TO_SCENE twice and
    // appeared rotated sideways relative to the target.
    if (unitRig) {
      visual.frame.quaternion.copy(visual.skinned ? M2_FROM_SCENE : IDENTITY_QUATERNION);
    } else if (visual.skinned) {
      visual.frame.quaternion.identity();
    } else {
      this.#faceModelSpace(visual);
    }
  }

  /** Applies a SpellVisualKitModelAttach transform after the anchor frame is resolved. */
  #applySpellVisualTransform(visual: RenderedVisual, attachedToUnit = false): void {
    applySpellVisualTransformFrame(visual.frame, visual.instance.transform, attachedToUnit,
      Boolean(visual.skinned));
  }

  #applySpellBillboards(visual: RenderedVisual): void {
    // Placement and the local pose are complete. Billboards refresh only their ancestor paths;
    // #updateEffects propagates the full rig before emitter reads, otherwise scene render does it.
    // An eager pass here (or before placement) would walk the same spell bones again this frame.
    if (visual.skinned && visual.template) applyBillboardBones(visual.skinned, visual.template, this.#camera, false);
  }

  /**
   * The bone on a unit that an attachment id names, if that unit is on screen and rigged.
   *
   * A spell hangs its flourish on SpellRightHand, not on the hand a sword goes in — measured on a
   * human they are 3 centimetres apart, and on a creature with no hands at all the spell points
   * are still there while the item ones may not be.
   */
  #attachmentBone(guid: bigint, attachment: number): THREE.Bone | undefined {
    const unit = this.#units.get(guid);
    if (!unit?.skinned || !unit.wvm) return undefined;
    const bone = boneOf(unit.wvm, unit.skinned, attachment);
    // Unit billboards defer their full matrix pass to render. Spell visuals read this bone's
    // world matrix before that pass, so refresh only the attachment's ancestor path now.
    bone?.updateWorldMatrix(true, false);
    return bone;
  }

  /**
   * How far the attachment point sits from the pivot of the bone carrying it.
   *
   * Not a formality. Measured over the client's own rigs with `tools/mpq.mjs` — 40 character
   * models and the first 1,185 creature models that carry attachments — the nine points a spell
   * kit can ask for occur 7,080 times and **98 of them are not on their bone's pivot**. On playable
   * models: TaurenMale's head is 0.753 yards away from it, its chest 0.405, GnomeMale's head 0.381,
   * TrollFemale's chest 0.160; 20 of the 243 character placements are offset, over 14 of the 40
   * models. The largest anywhere is 2.759 yards, on `ArgentWarhorse2`'s ground point. Until now a
   * head kit on a tauren was drawn three quarters of a yard inside its skull, and the reason was
   * that this branch decomposed the bone matrix and stopped there.
   */
  #spellAttachmentOffset(visual: RenderedVisual, guid: bigint, attachment: number): THREE.Vector3 | undefined {
    const unit = this.#units.get(guid);
    if (!unit?.wvm || !unit.template) return undefined;
    if (visual.boneOffsetSource !== unit.wvm) {
      visual.boneOffsetSource = unit.wvm;
      visual.boneOffset = attachmentOffset(unit.wvm, unit.template.pivots, attachment);
    }
    return visual.boneOffset;
  }

  draw(
    state: WorldState,
    map: number | undefined,
    heightAt: HeightSampler | undefined,
    terrainClient: TerrainClient | undefined,
    objects: readonly EnvironmentObject[],
    environmentClient: EnvironmentClient | undefined,
    gameObjectMetadata: ((displayId: number) => GameObjectDisplayMetadata | undefined) | undefined,
    cameraYaw = 0,
    cameraPitch = CAMERA_DEFAULT_PITCH,
    cameraDistance = CAMERA_DEFAULT_DISTANCE,
    creatureModel?: (object: WorldObjectState) => UnitModel | undefined,
    splatClient?: TerrainSplatClient,
    liquidTextures?: LiquidTextureClient,
    transportPaths?: TransportPathClient,
    horizonClient?: HorizonClient,
    /** How far the camera wanted to be, where `cameraDistance` is how far a wall let it. */
    cameraAnchorDistance = cameraDistance,
    /**
     * Whether a display id has been answered, which is the only thing that tells the two waiting
     * stand-ins apart: `creatureModel` returns undefined both when the display record has not come
     * back and when it has but the player's appearance has not. Diagnostics only — nothing is drawn
     * differently for the answer.
     */
    displayAnswered?: (displayId: number) => boolean,
    /**
     * How high on the character the camera hangs this frame — its shoulder in third person, its
     * eye in first. Worked out once a frame by the loop and handed to every camera the frame
     * builds, so the world, the plates and the bubbles agree on where the arm is hinged.
     */
    cameraPivotHeight = CAMERA_DEFAULT_PIVOT_HEIGHT,
    /**
     * The display record of whatever this unit is riding, resolved the same way its own is.
     *
     * Its own argument rather than something read off `creatureModel`, because it answers a
     * different field — `UNIT_FIELD_MOUNTDISPLAYID`, which until now had exactly one reader in the
     * whole repository (`WindowBindings.ts:331`, a boolean for module windows).
     */
    mountModel?: (object: WorldObjectState) => UnitModel | undefined,
    /** Exact static WMO floor under this frame's camera, from the server's collision geometry. */
    wmoFloor?: StaticWmoFloor,
    frameTime?: RenderFrameTime,
    /** Monotonic revision of the cache behind `gameObjectMetadata`; absent means fail-open. */
    gameObjectMetadataRevision?: number,
  ): WorldSubmissionReceipt | undefined {
    validateRenderEvolutionMode(this.#replaySeed !== undefined, frameTime !== undefined);
    const evolutionTime = frameTime === undefined
      ? undefined
      : cloneRenderFrameTime(frameTime);
    // Every value below describes this submission attempt, never a live cache. Reset before the
    // player guard so loading/teleport frames cannot repeat the last populated scene's numbers.
    this.#resetFrameCounters();
    this.#wmoFogCandidate = undefined;
    this.#wmoFloor = undefined;
    this.#wmoFogVisualId = undefined;
    this.#restoreZoneFog();
    // 11.02-I: what the camera is built around (game/ViewSubject.ts) — the character, or a possessed
    // unit or far sight eye once in view. The camera, the sun and every streamed ring are centred on it.
    const player = viewSubjectIn(state);
    if (!player?.position) {
      this.clearTerrain();
      splatClient?.setActiveTiles(undefined, []);
      terrainClient?.setActiveTiles(undefined, []);
      // Nothing is drawn on this frame, so nothing is a capsule on it either. Said rather than
      // left alone: the ledger is read every half-second while the diagnostics window is open, and
      // during world enter or a teleport it would otherwise keep answering with the last frame the
      // player was standing in.
      this.#portraits.clear();
      return undefined;
    }
    let submissionContext: WebGLRenderingContext | WebGL2RenderingContext;
    try {
      submissionContext = this.#renderer.getContext();
    } catch {
      return undefined;
    }
    if (!webGlContextCanSubmit(submissionContext)) return undefined;
    if (wmoFloor && wmoFloor.placement.map === map) {
      const visual = this.#wmoFloorVisuals.lookup(wmoFloor.placement, objects);
      if (visual) {
        this.#wmoFloor = wmoFloor;
        this.#wmoFogVisualId = visual.id;
      }
    }
    this.#liquidTextures = liquidTextures;
    // Zero orbit distance puts the camera inside the character's own head, where its body fills
    // the screen. Hidden rather than dropped, so leaving first person costs no rebuild.
    this.#firstPerson = cameraAnchorDistance <= CAMERA_FIRST_PERSON_DISTANCE;
    // Phase marks are plain numbers beside the phase calls: nine pairs of `performance.now()`
    // cost about a microsecond and tell a JS-side build burst apart from driver-side submission.
    let drawPhaseAt = performance.now();
    this.#resize();
    this.#updateCamera(player.position, cameraYaw, cameraPitch, cameraDistance, cameraPivotHeight);
    this.#syncSun(player.position);
    let now: number;
    let elapsed: number;
    if (evolutionTime === undefined) {
      now = performance.now();
      // Animation mixers advance by real time, clamped so a backgrounded tab does not jump.
      elapsed = Math.min(0.1, Math.max(0, (now - this.#lastFrame) / 1000));
      this.#lastFrame = now;
    } else {
      now = evolutionTime.nowMs;
      elapsed = evolutionTime.elapsedSeconds;
    }
    for (const [guid, until] of this.#mountSpecials) {
      if (now >= until) this.#mountSpecials.delete(guid);
    }
    // How violently the camera is turning: a single-frame snap past `CAMERA_FLICK_RADIANS`,
    // or a sustained sweep past `CAMERA_FAST_TURN_RATE`, suppresses grow-ins briefly. Motion
    // masks an instant appearance, while a tree caught mid-growth reads as broken — so the
    // frames that need masking most are exactly the ones that must not grow.
    if (this.#lastCameraYaw !== undefined && this.#lastCameraPitch !== undefined && elapsed > 0) {
      const snap = Math.hypot(
        cameraAngleDelta(this.#lastCameraYaw, cameraYaw),
        cameraAngleDelta(this.#lastCameraPitch, cameraPitch),
      );
      const instant = snap / elapsed;
      this.#cameraTurnRate += (instant - this.#cameraTurnRate) * 0.3;
      if (snap > CAMERA_FLICK_RADIANS || this.#cameraTurnRate > CAMERA_FAST_TURN_RATE) {
        this.#turnSuppressUntilSerial = this.#submissionSerial + CAMERA_FLICK_SUPPRESS_FRAMES;
      }
    } else {
      this.#cameraTurnRate = 0;
    }
    this.#lastCameraYaw = cameraYaw;
    this.#lastCameraPitch = cameraPitch;
    // Water programs borrow one stable set of uniforms; mutate values rather than allocating per
    // material or per frame.  The clock is wall time so its phase also remains stable for a hidden
    // water surface that returns to the scene later in the same world session.
    this.#waterShaderUniforms.time.value = now / 1000;
    VEGETATION_WIND_TIME.value = now / 1000;
    this.#waterShaderUniforms.underwater.value = this.#underwater ? 1 : 0;
    this.#waterShaderUniforms.sunDirection.value.copy(this.#worldLight.wowSunDirection.value);
    this.#waterShaderUniforms.sunColour.value.copy(this.#worldLight.wowDiffuse.value);
    this.#drawPhaseMs.setup = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    this.#updateTerrain(player.position, map, heightAt, terrainClient, splatClient);
    this.#updateHorizon(player.position, map, horizonClient);
    this.#drawPhaseMs.terrain = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    this.#updateEnvironment(player.position, objects, environmentClient, elapsed);
    this.#applyWmoFogCandidate();
    this.#updateSkybox(this.#camera, environmentClient);
    this.#updateSkyboxAnimation();
    this.#drawPhaseMs.env = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    // After the environment, because it borrows that pass's model queue and its built geometry.
    this.#updateGroundCover(player.position, map, heightAt, terrainClient, environmentClient);
    this.#drawPhaseMs.ground = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    this.#updateGameObjects(state, player.position, environmentClient, gameObjectMetadata,
      gameObjectMetadataRevision, transportPaths, now, elapsed);
    this.#drawPhaseMs.objects = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    this.#updateUnits(state, player.position, now, elapsed, environmentClient, creatureModel, displayAnswered,
      mountModel);
    // After the units, because a ring is sized from the body the pass above measured.
    this.#updateSelectionRings(state, heightAt);
    // The aiming reticle and the placing spell's ghost, after the model passes above have stocked
    // their caches and before anything is submitted.
    this.#updateGroundTargetRings();
    this.#updateDuelRing(heightAt);
    this.#updateGameObjectPreview(environmentClient);
    this.#drawPhaseMs.units = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    // Before the emitters and after the units: a flourish in somebody's hand reads their bone,
    // and its own emitters then read the flourish.
    this.#updateVisuals(now, elapsed, environmentClient);
    // After everything has been placed and posed, and before anything is drawn: an emitter reads
    // the matrix of the bone it hangs on, and that matrix is only right once the pose is.
    this.#updateEffects(player.position, now, elapsed);
    this.#updateFixtureLights(now);
    // New weather materials must enter the same warm pass as every other first-frame draw.
    this.#updateWeather(elapsed);
    if (this.#atmosphere) this.#updateAtmosphere(player.position, map, heightAt, terrainClient, now, elapsed);
    this.#drawPhaseMs.visuals = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    // Programs for everything the passes above just built, handed to the driver before this frame
    // submits them: the link then runs while the rest of the frame does, and the uniform locations
    // are fetched on the first frame the driver reports ready — not inside a visible submit.
    this.#shaderProgramTrace?.mark("prepare", this.#renderer.info.programs, performance.now());
    this.#programWarmup.tick(this.#camera);
    this.#releaseWarmWmoGroups();
    this.#visualWarmHold.release();
    this.#effectWarmHold.release();
    this.#releaseWarmInstances();
    this.#releaseWarmUnits();
    this.#skyWarmup.tick(this.#camera);
    this.#overlayWarmup.tick(this.#camera);
    this.#glowWarmup.tick(this.#camera);
    this.#shaderProgramTrace?.mark("warm", this.#renderer.info.programs, performance.now());
    this.#drawPhaseMs.warm = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    // Last admission point for renderer-owned geometry caches. Every live borrower above now
    // carries its exact entry identity, so inactive LRU entries can be disposed without path guesses.
    this.#evictWmoResources();
    this.#evictBuiltModelCaches();
    // Spell bases are released only after complete phase admission/cleanup above; this is the
    // first point where every live mesh/emitter borrower holds its exact record lease.
    this.#spellTextures.evictUnleased();
    this.#drawPhaseMs.evict = performance.now() - drawPhaseAt;
    drawPhaseAt = performance.now();
    // These are the admitted, non-empty effect groups and instance matrices handed to this frame's
    // scene submission. Cached entries are deliberately not counted by the telemetry getter.
    for (const held of this.#effects.values()) {
      if (held.effects !== EMPTY_EFFECTS) this.#effectsDrawn++;
    }
    for (const { mesh } of this.#groundCoverMeshes.values()) this.#groundCoverDrawn += mesh.count;
    this.#updateBatchColours(now);
    for (const [liquidClass, material] of this.#liquidMaterials) {
      updateLiquidMaterial(material, liquidClass, this.#lightSample, now / 1000);
    }
    // The dome is the sky, so it has no place of its own: it goes wherever the camera is.
    this.#sky.position.copy(this.#camera.position);
    // Skybox M2 batches commonly use alpha/additive blend modes. In a single scene Three.js puts
    // those transparent draws after opaque terrain and units, so depthTest=false would wash the
    // world with clouds. Draw the procedural dome and authored sky in a dedicated prepass, then
    // clear only depth and draw the world over it.
    const autoClear = this.#renderer.autoClear;
    if (!Number.isSafeInteger(this.#submissionSerial)
      || this.#submissionSerial >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("world submission serial exhausted");
    }
    // The one offscreen path this client has: classic glow and the optional sun shafts share the
    // same captured frame. With both leaves off, undefined is the original direct path down to the
    // absence of a `setRenderTarget` call, and every consumer below is a no-op on it.
    const submitProgramsBefore = this.#programCount();
    const submitTexturesBefore = this.#textureCount();
    const submitGeometriesBefore = this.#geometryCount();
    const glow = this.#beginFullscreenGlow();
    // Detailed clocks run only during an explicit capture. These overlap their parent phases.
    const detailedCapture = this.#shaderProgramTrace !== undefined;
    let submitPartAt = detailedCapture ? performance.now() : 0;
    try {
      this.#renderer.autoClear = true;
      this.#renderer.render(this.#skyScene, this.#camera);
      if (detailedCapture) this.#drawPhaseMs["submit.sky"] = performance.now() - submitPartAt;
      this.#shaderProgramTrace?.mark("sky", this.#renderer.info.programs, performance.now());
      this.#renderer.autoClear = false;
      this.#renderer.clearDepth();
      // Three resolves an MSAA target at the end of every render call. The radial pass needs the
      // world's depth once, not the empty sky depth or the unchanged overlay depth.
      if (glow?.godRays) glow.scene.resolveDepthBuffer = true;
      if (detailedCapture) submitPartAt = performance.now();
      if (this.#worldSubmissionCapture) {
        this.#worldSubmissionCapture.render(this.#renderer, this.#scene, this.#camera);
      } else this.#renderer.render(this.#scene, this.#camera);
      if (detailedCapture) this.#drawPhaseMs["submit.world"] = performance.now() - submitPartAt;
      this.#shaderProgramTrace?.mark("world", this.#renderer.info.programs, performance.now());
      if (detailedCapture) submitPartAt = performance.now();
      // The underwater tint and its waterline, over the finished world and under nothing. Inside
      // this try because it borrows the same `autoClear = false` the world pass runs on — with
      // clearing on it would wipe the frame it is meant to tint — and before the context proof so
      // that a context lost during the overlay is still caught by it. Returns having drawn nothing
      // at all unless the camera is in or entering liquid.
      this.#drawUnderwaterOverlay(now);
      this.#shaderProgramTrace?.mark("overlay", this.#renderer.info.programs, performance.now());
      // Keep depth resolving through the optional overlay render: in r185 the false path invalidates
      // the attached depth texture after a draw rather than merely skipping its blit.
      if (glow?.godRays) glow.scene.resolveDepthBuffer = false;
      // Composed with the overlay rather than over it: the tint is part of the frame the glow
      // blooms, exactly as it is part of the frame the direct path shows.
      this.#composeFullscreenGlow(glow);
      if (detailedCapture) this.#drawPhaseMs["submit.postprocess"] = performance.now() - submitPartAt;
      this.#shaderProgramTrace?.mark("postprocess", this.#renderer.info.programs, performance.now());
      this.#drawPhaseMs.submit = performance.now() - drawPhaseAt;
      this.#recordSubmitStats(submitProgramsBefore, submitTexturesBefore, submitGeometriesBefore);
      if (!webGlContextCanSubmit(submissionContext)) return undefined;
    } finally {
      this.#renderer.autoClear = autoClear;
      // A throw anywhere above would otherwise leave the renderer bound to the scene target, and
      // the next thing to draw — a portrait, the next frame's sky — would land inside it.
      this.#endFullscreenGlow(glow);
      // Poses no draw asked for are finished too, so no worker is still writing into the arena
      // while anything else (a portrait, the next frame's admission) runs.
      this.#poseEngine?.endFrame();
    }
    const submissionSerial = this.#submissionSerial + 1;
    if (!Number.isSafeInteger(submissionSerial)) {
      throw new RangeError("world submission serial exhausted");
    }
    this.#submissionSerial = submissionSerial;
    this.#drawPhaseMs.submit = performance.now() - drawPhaseAt;
    this.#recordSubmitStats(submitProgramsBefore, submitTexturesBefore, submitGeometriesBefore);
    return Object.freeze({ submitted: true as const, submissionSerial });
  }

  #resetFrameCounters(): void {
    this.#drawCalls = 0;
    this.#wmoGroupsPending = 0;
    this.#triangles = 0;
    // Unrolled rather than looped: this runs on every frame, including non-submitted ones.
    this.#drawPhaseMs.setup = 0;
    this.#drawPhaseMs.terrain = 0;
    this.#drawPhaseMs.env = 0;
    this.#drawPhaseMs.ground = 0;
    this.#drawPhaseMs.objects = 0;
    this.#drawPhaseMs.units = 0;
    this.#drawPhaseMs.visuals = 0;
    this.#drawPhaseMs.warm = 0;
    this.#drawPhaseMs.evict = 0;
    this.#drawPhaseMs.submit = 0;
    this.#drawPhaseMs["units.appearance"] = 0;
    this.#drawPhaseMs["units.pose"] = 0;
    this.#drawPhaseMs["units.presentation"] = 0;
    this.#drawPhaseMs["submit.sky"] = 0;
    this.#drawPhaseMs["submit.world"] = 0;
    this.#drawPhaseMs["submit.postprocess"] = 0;
    this.#submitStats.programs = 0;
    this.#submitStats.textures = 0;
    this.#submitStats.geometries = 0;
    this.#unitsDrawn = 0;
    this.#unitsDropped = 0;
    this.#unitAnimationNear = 0;
    this.#unitAnimationMedium = 0;
    this.#unitAnimationFar = 0;
    this.#unitAnimationCritical = 0;
    this.#unitAnimationFull = 0;
    this.#unitAnimationFlat = 0;
    this.#unitAnimationSkipped = 0;
    this.#gameObjectsDrawn = 0;
    this.#gameObjectsDropped = 0;
    this.#doodadsPosed = 0;
    this.#effectsDrawn = 0;
    this.#effectsDropped = 0;
    this.#groundCoverDrawn = 0;
    this.#standIns.idle();
    this.#wmoPortalModels = 0;
    this.#wmoPortalCandidates = 0;
    this.#wmoPortalCulled = 0;
  }

  /**
   * The depth tint and the waterline, when the eye is in or entering liquid.
   *
   * Everything about this pass is decided before a single GL call: the switch, then whether there
   * is a surface at all, then whether the eye is within a near plane's half-height of it. Only when
   * all three say yes does the scene reach the renderer — so on every dry frame, and on every frame
   * of a client with the option off, this costs one boolean and a comparison.
   *
   * Written below `#resetFrameCounters` on purpose: the submission test slices `draw()`'s body
   * between those two members and asserts that nothing else submits inside it, and a helper sitting
   * in that gap would have been read as part of the frame it is called from.
   */
  #drawUnderwaterOverlay(now: number): void {
    if (!this.#underwaterOverlayEnabled) return;
    const surface = this.#underwaterSurface;
    if (!surface) return;
    const frame = underwaterOverlayFrame(
      surface,
      // The camera's own height, not the one the caller sampled with: the scene draws world Z as Y,
      // and this is the eye the seam is being solved for.
      this.#camera.position.y,
      underwaterCrossingBand(this.#camera.near, this.#camera.fov),
      liquidClassOf(surface.flags, surface.entry, this.#liquidTextures?.classes),
    );
    if (!frame) return;
    const uniforms = this.#underwaterUniforms;
    // world -> clip is `projectionMatrix * matrixWorldInverse`, so its inverse is this pair the
    // other way round. Both are already up to date: the camera was placed and composed at the top
    // of the frame, and three refreshed the projection on the last resize.
    uniforms.invViewProj.value
      .multiplyMatrices(this.#camera.matrixWorld, this.#camera.projectionMatrixInverse);
    uniforms.tint.value.set(frame.tint[0], frame.tint[1], frame.tint[2], frame.fogStrength);
    uniforms.waterZ.value = surface.height;
    // Seconds from the frame's clock — the same one the water materials take, which under a formal
    // replay is the replay's and never `performance.now()`.
    uniforms.params.value.set(
      UNDERWATER_MENISCUS_YARDS, now / 1000, UNDERWATER_RIPPLE_YARDS, frame.crossing ? 1 : 0,
    );
    this.#renderer.render(this.#overlayScene, this.#overlayCamera);
  }

  /**
   * Points the frame at the offscreen buffer, or leaves the renderer exactly as it was.
   *
   * Written below `#resetFrameCounters` for the same reason `#drawUnderwaterOverlay` is: the
   * submission test reads the source between `draw(` and that member as the frame itself, and a
   * helper that submits, sitting in the gap, would be read as part of it.
   */
  #beginFullscreenGlow(): GlowChainTargets | undefined {
    if (!this.#fullscreenGlowEnabled && !this.#godRaysActive() && !this.#cinematic.active) return undefined;
    const targets = this.#glowTargets;
    // Allocation happens in `#resize`, which `draw()` has already called. Nothing here retries it:
    // a frame with no buffers is a frame drawn the direct way, not a frame not drawn.
    if (!targets) return undefined;
    if (targets.godRays) targets.scene.resolveDepthBuffer = false;
    this.#renderer.setRenderTarget(targets.scene);
    return targets;
  }

  /**
   * Optional glow, optional depth-aware radial scattering, and one composite onto the canvas.
   *
   * The classic path remains its bright pass and two separable half-resolution blurs. Sun shafts
   * add one half-resolution draw and reuse blurB only after the vertical bloom has left its result
   * in blurA. Every pass reads and writes display-referred colour, so the composite only adds.
   */
  #composeFullscreenGlow(targets: GlowChainTargets | undefined): void {
    if (!targets) return;
    const { uniforms, quad, scene, camera } = this.#glowPasses;

    let glowTexture: THREE.Texture = targets.scene.texture;
    if (this.#fullscreenGlowEnabled) {
      uniforms.source.value = targets.scene.texture;
      quad.material = this.#glowPasses.extract;
      this.#renderer.setRenderTarget(targets.blurA);
      this.#renderer.render(scene, camera);

      quad.material = this.#glowPasses.blur;
      uniforms.source.value = targets.blurA.texture;
      uniforms.direction.value.set(GLOW_BLUR_SPREAD / targets.halfWidth, 0);
      this.#renderer.setRenderTarget(targets.blurB);
      this.#renderer.render(scene, camera);

      uniforms.source.value = targets.blurB.texture;
      uniforms.direction.value.set(0, GLOW_BLUR_SPREAD / targets.halfHeight);
      this.#renderer.setRenderTarget(targets.blurA);
      this.#renderer.render(scene, camera);
      glowTexture = targets.blurA.texture;
    }

    let raysTexture: THREE.Texture = targets.scene.texture;
    // Under the cinematic chain the sun-shaft leaf is drawn by CinematicPost's own two-pass march
    // (longer, per time of day, off-screen aware); the classic radial pass is skipped, not stacked.
    // The quality's share of the ceiling times the account's shaft multiplier; CinematicPost bounds
    // it the same way `godRayVisibility` bounds the classic path's.
    const cinematicShafts = this.#cinematic.active && this.#godRaysActive() && this.#lightSample !== undefined
      && !this.#underwater
      ? Math.min(1, this.#lightingProfile.godRayStrength / GOD_RAY_FULL_STRENGTH) * this.#godRayStrengthScale : 0;
    const rayStrength = this.#cinematic.active ? 0 : this.#prepareGodRays(targets);
    if (rayStrength > 0) {
      quad.material = this.#glowPasses.godRays;
      this.#renderer.setRenderTarget(targets.blurB);
      this.#renderer.render(scene, camera);
      raysTexture = targets.blurB.texture;
    }

    if (this.#cinematic.active) {
      const depth = targets.scene.depthTexture;
      this.#cinematic.render(this.#renderer, {
        scene: targets.scene.texture,
        depth: targets.godRays && depth instanceof THREE.DepthTexture && !this.#underwater ? depth : null,
        glow: glowTexture,
        glowStrength: this.#fullscreenGlowEnabled ? this.#glowStrength : 0,
        rays: raysTexture,
        rayStrength,
        shafts: cinematicShafts,
        camera: this.#camera,
        width: targets.width,
        height: targets.height,
        contextGeneration: targets.contextGeneration,
        renderScale: this.#renderScale,
        // Frame-count smoothing keeps deterministic replays deterministic.
        elapsedSeconds: 1 / 60,
      });
      return;
    }

    uniforms.source.value = targets.scene.texture;
    uniforms.glow.value = glowTexture;
    uniforms.strength.value = this.#fullscreenGlowEnabled ? this.#glowStrength : 0;
    uniforms.rays.value = raysTexture;
    uniforms.rayStrength.value = rayStrength;
    quad.material = this.#glowPasses.composite;
    this.#renderer.setRenderTarget(null);
    this.#renderer.render(scene, camera);
  }

  /** Project the physical sun and populate the radial pass without allocating per frame. */
  #prepareGodRays(targets: GlowChainTargets): number {
    const depth = targets.scene.depthTexture;
    if (!targets.godRays || !(depth instanceof THREE.DepthTexture)
      || !this.#godRaysActive() || !this.#lightSample || this.#underwater) return 0;

    const sun = godRaySunDirection(this.#lightTime, this.#godRaySun);
    const elevation = sun.y;
    const source = godRayScreenSource(
      this.#camera,
      sun,
      this.#godRayScreenSource,
      this.#godRayProjection,
      this.#godRayCameraForward,
      this.#godRayCameraUp,
    );
    const strength = godRayVisibility(
      source.ndcX,
      source.visibilityY,
      elevation,
      source.facing,
      this.#lightingProfile.godRayStrength,
      this.#weatherFade.storm,
      this.#godRayStrengthScale,
    );
    if (strength <= 0) return 0;

    const uniforms = this.#glowPasses.uniforms;
    uniforms.depth.value = depth;
    uniforms.sunUv.value.set(source.ndcX * 0.5 + 0.5, source.ndcY * 0.5 + 0.5);
    uniforms.aspect.value = targets.width / targets.height;
    const diffuse = this.#worldLight.wowDiffuse.value;
    const peak = Math.max(diffuse.r, diffuse.g, diffuse.b);
    if (!(peak > 1e-6)) return 0;
    // Light.dbc's diffuse channels are display-space multipliers. Normalising preserves their hue
    // while the bounded profile strength decides energy; no colour-space conversion belongs here.
    uniforms.rayColour.value.setRGB(
      diffuse.r / peak,
      diffuse.g / peak,
      diffuse.b / peak,
      THREE.LinearSRGBColorSpace,
    );
    return strength;
  }

  /** Hands the canvas back. A no-op on the direct path, including the `setRenderTarget` itself. */
  #endFullscreenGlow(targets: GlowChainTargets | undefined): void {
    if (!targets) return;
    if (targets.godRays) targets.scene.resolveDepthBuffer = false;
    this.#renderer.setRenderTarget(null);
    // Nothing outside the frame should keep the buffers bound to a sampler either: a stale
    // reference here would pin a target that `#disposeFullscreenGlowTargets` has already released.
    this.#glowPasses.uniforms.source.value = null;
    this.#glowPasses.uniforms.glow.value = null;
    this.#glowPasses.uniforms.depth.value = null;
    this.#glowPasses.uniforms.rays.value = null;
    this.#glowPasses.uniforms.rayStrength.value = 0;
    this.#cinematic.release();
  }

  /**
   * Allocates, resizes and releases the chain's buffers.
   *
   * Called from `#resize` (so every frame agrees with the drawing buffer) and from
   * `setRenderScale` (which changes that buffer outside a frame). Three questions decide it and all
   * three are cheap: is the leaf on, is the canvas a sane size, and is this the context the buffers
   * were made for — a lost/restored context bumps `#webGlContextGeneration` and every GL object
   * behind these targets is gone with it.
   */
  #syncFullscreenGlowTargets(): void {
    // "godRays" on the targets means "owns a resolved depth texture"; the cinematic leaves that
    // read depth ask for the same attachment rather than a second full-frame buffer.
    const godRays = this.#godRaysActive() || this.#cinematic.needsDepth;
    if (!this.#fullscreenGlowEnabled && !godRays && !this.#cinematic.active) {
      this.#disposeFullscreenGlowTargets();
      return;
    }
    const size = glowChainSize(this.#canvas.width, this.#canvas.height);
    if (!size) {
      this.#disposeFullscreenGlowTargets();
      return;
    }
    const current = this.#glowTargets;
    if (current
      && current.width === size.width && current.height === size.height
      && current.godRays === godRays
      && current.contextGeneration === this.#webGlContextGeneration) return;
    this.#disposeFullscreenGlowTargets();
    this.#glowTargets = this.#createFullscreenGlowTargets(size, godRays);
  }

  /**
   * The three buffers, at the sample count this context can actually give them.
   *
   * **The scene target is display-referred, and that is the whole of P4b.** three decides both the
   * tone curve and the output colour space of a pass from one flag on the bound target. In three
   * **0.185.1** (`renderers/webgl/WebGLPrograms.js`, and the same pair again in
   * `WebGLRenderer.setProgram` and `UniformsUtils.getUnlitUniformColorSpace`) it reads
   * `material.toneMapped && (currentRenderTarget === null || currentRenderTarget.isXRRenderTarget
   * === true)` for the curve, and takes `outputColorSpace` from `currentRenderTarget.texture
   * .colorSpace` in that same case rather than forcing the working space. WebGL render targets are
   * otherwise treated as intermediates: the world would arrive linear and un-curved.
   *
   * Flagging this one target and giving its texture `SRGBColorSpace` therefore makes every world
   * material finish exactly where it finishes on the canvas — custom shoulder, then sRGB encode —
   * so transparent and additive batches blend in *display* space, which is what the original
   * client's un-gamma'd `B8G8R8A8_UNORM` backbuffer did. P4 measured the cost of not doing this:
   * one additive card read `255,255,255` on the direct path against `208,201,251` through the
   * chain, over the 370 048 pixels it covered. Spell effects, water sparkle and P3's underwater
   * tint are exactly the things this plan exists to protect, so the flag is the cheaper price.
   *
   * `internalFormat: "RGBA8"` is the other half, and is documented `RenderTarget` option rather
   * than anything private: an `SRGBColorSpace` byte texture is otherwise allocated `SRGB8_ALPHA8`,
   * and the hardware would then encode a second time on store and decode on sample — a round trip
   * that survives in value but not in eight bits, precisely where the glow lives. `RGBA8` keeps the
   * bytes the shader wrote, which is what the canvas does with them.
   *
   * **`isXRRenderTarget` is three's own internal flag, not its public contract.** An upgrade may
   * rename or re-purpose it, and if it does, this target silently goes back to linear and un-curved
   * with no composite left to correct it. Three tripwires, in order of loudness: the assignment is
   * verified to have stuck on the line below; `tests/fullscreen-glow.test.mjs` asserts both
   * expressions against the real `node_modules/three` source, so a version that moves them fails
   * the suite; and the journal's tone-parity harness (direct vs chain at strength 0, expected 0
   * everywhere) is the measurement a three upgrade has to re-run, not just the unit tests.
   *
   * **Precision.** Eight bits, with no extension test at all. The buffer holds display-referred
   * values, so this is the canvas's own precision, not the eight bits of *linear* whose dark
   * quarter P4 measured collapsing (max Δ 6, 11.3% of channels). Dropping the half-float
   * preference halves all three buffers: 6.22 MB → 3.11 MB at 960×540, and 24.88 MB → 12.44 MB
   * at 1920×1080.
   *
   * **Multisampling.** `antialias: true` on the canvas is a request about the *default* framebuffer
   * and buys an offscreen path nothing, so the scene target asks for its own four samples. three
   * clamps that to the driver's `maxSamples`, and the clamped number is stored rather than the
   * request, because it is what `ResourceAccounting` will report. A multisampled target's auxiliary
   * allocations are deliberately unmeasurable — `referenceGpuRenderTarget` files it under
   * `unknownTopologyResources` rather than inventing bytes for it.
   * Glow alone still discards multisample depth. The opt-in shaft pass attaches a depth texture and
   * resolves it because that is the silhouette mask it samples; disabling the leaf rebuilds this
   * same target without either cost.
   *
   * Synchronous construction/setup failure is not fatal: it leaves `#glowTargets` undefined and
   * the next frame draws the direct way. Three allocates the underlying FBO lazily on first bind,
   * so later driver/context failure is handled by the frame's normal context-submission proof.
   */
  #createFullscreenGlowTargets(size: GlowChainSize, godRays: boolean): GlowChainTargets | undefined {
    let samples = 0;
    try {
      samples = Math.max(0, Math.min(4, this.#renderer.capabilities.maxSamples));
    } catch {
      // A restricted or lost context still gets the single-sample chain if it can allocate one at
      // all, and the direct path if it cannot.
    }
    // Collected as they are made, so a synchronous constructor/setup failure does not leave earlier
    // targets behind with nothing holding them.
    const made: THREE.WebGLRenderTarget[] = [];
    try {
      const depthTexture = godRays
        ? new THREE.DepthTexture(size.width, size.height, THREE.UnsignedIntType)
        : null;
      if (depthTexture) {
        depthTexture.name = "fullscreen-god-rays-depth";
        depthTexture.minFilter = THREE.NearestFilter;
        depthTexture.magFilter = THREE.NearestFilter;
      }
      const scene = new THREE.WebGLRenderTarget(size.width, size.height, {
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        internalFormat: "RGBA8",
        depthBuffer: true,
        depthTexture,
        stencilBuffer: false,
        // The baseline glow path still skips the resolve. Sun shafts opt into it because their
        // radial pass samples the finished world depth after the MSAA scene has been resolved.
        resolveDepthBuffer: godRays,
        samples,
      });
      made.push(scene);
      // The flag itself, assigned rather than passed because it is not a constructor option — this
      // is the one line a three upgrade has to be re-read against.
      (scene as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      if ((scene as unknown as { isXRRenderTarget?: unknown }).isXRRenderTarget !== true) {
        // A three that refuses the flag would hand back a linear, un-curved frame that nothing in
        // this chain corrects any more. No chain at all is the honest answer, not a wrong one.
        throw new Error("three no longer accepts isXRRenderTarget on a WebGLRenderTarget");
      }
      scene.texture.name = "fullscreen-glow-scene";
      const half = (name: string): THREE.WebGLRenderTarget => {
        // Left at the default colour space on purpose. These hold the bright pass's display-space
        // excess, written raw by materials that include no `colorspace_fragment`; making them sRGB
        // would have the hardware encode on store and decode on sample around a value that is
        // already display-referred, and cost eight-bit precision for nothing.
        const target = new THREE.WebGLRenderTarget(size.halfWidth, size.halfHeight, {
          type: THREE.UnsignedByteType,
          depthBuffer: false,
          stencilBuffer: false,
        });
        made.push(target);
        target.texture.name = name;
        return target;
      };
      const blurA = half("fullscreen-glow-blur-a");
      const blurB = half("fullscreen-glow-blur-b");
      return Object.freeze({
        ...size,
        scene,
        blurA,
        blurB,
        godRays,
        contextGeneration: this.#webGlContextGeneration,
        samples,
      });
    } catch {
      for (const target of made) {
        try { target.dispose(); } catch { /* best effort after a partial synchronous setup failure */ }
      }
      return undefined;
    }
  }

  #disposeFullscreenGlowTargets(): void {
    const targets = this.#glowTargets;
    if (!targets) return;
    this.#glowTargets = undefined;
    this.#glowPasses.uniforms.source.value = null;
    this.#glowPasses.uniforms.glow.value = null;
    this.#glowPasses.uniforms.depth.value = null;
    this.#glowPasses.uniforms.rays.value = null;
    this.#glowPasses.uniforms.rayStrength.value = 0;
    for (const target of [targets.scene, targets.blurA, targets.blurB]) target.dispose();
    this.#cinematic.dispose();
  }

  /**
   * Lighting quality changes a bounded soft grade, nearby fixture-light budget and shadow-map
   * resolution. Quality 0 keeps the authored baseline exact; higher grades add the optional pass
   * without allowing a context that cannot allocate the requested shadow texture to break lighting.
   */
  setLightingQuality(quality: number): void {
    const oldGodRaysActive = this.#godRaysActive();
    let shadowMaps = false;
    try {
      shadowMaps = !this.#renderer.getContext().isContextLost();
    } catch {
      // A restricted or already-lost context still gets tone/exposure and authored scene lights.
    }
    const next = lightingProfile(quality, {
      shadowMaps,
      maxTextureSize: this.#renderer.capabilities.maxTextureSize,
    });
    const oldMapSize = this.#lightingProfile.shadowMapSize;
    this.#lightingProfile = next;
    setWorldLightImmersiveStrength(this.#worldLight, next.immersiveStrength);
    if (next.localLights === 0) this.#worldLight.wowLocalLightCount.value = 0;

    // r185 has physically-correct light units as its only path. Keep the established colour
    // pipeline for every quality so switching the optional pass never reinterprets textures — the
    // reference client's shoulder is the curve on all three. Quality now varies bounded ALU grade
    // and shadow work; authored ambient/diffuse multipliers cannot change with a graphics preset.
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.CustomToneMapping;
    this.#renderer.toneMappingExposure = next.exposure;
    this.#sun.intensity = 0;

    const shadows = next.shadowMapSize > 0;
    this.#renderer.shadowMap.enabled = shadows;
    this.#renderer.shadowMap.type = THREE.PCFShadowMap;
    this.#sun.castShadow = shadows;
    if (oldMapSize !== next.shadowMapSize) {
      this.#sun.shadow.map?.dispose();
      this.#sun.shadow.map = null;
    }
    // Map sizes, extents, bias and blur all belong to the cascades (CascadedShadows.ts), which
    // place every map from the camera each frame. Quality 0 hands the sun back as it was.
    this.#sunCascades.setShadowOnlyCasters(this.#shadowOnlyToggle);
    this.#sunCascades.setBoundedCasters(this.#boundedShadowCasters);
    this.#sunCascades.configure(this.#scene, this.#renderer, next);
    for (const terrain of this.#terrains.values()) terrain.mesh.receiveShadow = shadows;
    this.#syncSceneryShadows(true);
    this.#applyCinematicProfile();
    // No material is mutated. Existing unit trees are reclassified once on their next draw.
    for (const unit of this.#units.values()) unit.shadowCaster = undefined;
    if (oldGodRaysActive !== this.#godRaysActive()) this.#syncFullscreenGlowTargets();
  }

  /** Moving light and target together preserves the authored direction while centring its map. */
  #syncSun(player: WorldPosition): void {
    if (this.#sunCascades.active) {
      // Inside a building made only of rooms the sun's shadow term is faded to nothing
      // (`setWorldLightShadowSuppressed`), yet placing the cascades schedules their passes — 30 to
      // 60 shadow draws a frame in Gundrak for a term no pixel shows. Unplaced, none is scheduled;
      // the first frame back outside places and renders them all again.
      if (this.#interiorLight !== undefined) return;
      // The camera was placed just before this; the cascades fit themselves to what it sees.
      this.#sunCascades.update(this.#camera, this.#sunOffset, this.#submissionSerial);
      return;
    }
    const center = stabiliseDirectionalShadowCenter(
      { x: player.x, y: player.z, z: -player.y },
      this.#sunOffset,
      this.#lightingProfile.shadowExtent,
      this.#lightingProfile.shadowMapSize,
    );
    this.#sun.target.position.set(center.x, center.y, center.z);
    this.#sun.position.copy(this.#sun.target.position).add(this.#sunOffset);
    this.#sun.target.updateMatrixWorld();
  }

  /**
   * Keeps private materials for the whole spawn/stealth fade and updates only their fade values.
   * Disposing and cloning them on every opacity step drops Three's last program reference, so
   * the next render recompiles the identical shader. Restore the shared array only at full
   * opacity, or when the body/equipment being borrowed changes.
   *
   * `keepFaded` (`#unitFadeReturnWaits`) holds the copies — or the translucent capsule — at full
   * opacity for one more frame instead of giving the shared materials back. The copies' programs
   * are the ones `createFadeProgramTwin` warmed when the meshes were hung, so a borrow queues
   * nothing of its own for the warm pass.
   */
  #applyUnitOpacity(unit: RenderedUnit, wanted: number, keepFaded = false): void {
    const stale = this.#unitOpacityStale(unit);
    // Full opacity still worn translucent is a fade that has not been given back yet, so it is
    // never "already applied": the frame that stops keeping it has to reach the release below.
    const lingering = wanted >= 1 && (unit.opacityBorrows !== undefined || unit.material.transparent);
    if (wanted === unit.unitOpacity && !stale && !lingering) return;
    if (!stale && unit.opacityBorrows && (wanted < 1 || keepFaded)) {
      unit.unitOpacity = wanted;
      unit.material.opacity = wanted;
      updateBorrowedMaterials(unit.opacityBorrows, wanted);
      return;
    }
    this.#releaseUnitOpacity(unit);
    unit.unitOpacity = wanted;
    // The stand-in pill's material is this unit's own — built per unit in `#drawUnit` — so it is
    // faded in place. `needsUpdate` because `transparent` and `alphaTest` are program state.
    const translucent = wanted < 1 || keepFaded;
    if (unit.material.transparent !== translucent) {
      unit.material.transparent = translucent;
      unit.material.needsUpdate = true;
      // Same reason as below: the shadow policy is decided from `transparent` and early-returns on
      // the answer it recorded. A unit wearing only a pill has no borrows to reset it for it.
      unit.shadowCaster = undefined;
    }
    unit.material.opacity = wanted;
    // Kept at full opacity through a change of what it wears: the new set is borrowed at 1.
    if (!translucent) return;
    const borrows = borrowFadedMaterials(this.#unitOpacityMeshes(unit), wanted);
    if (borrows.length > 0) unit.opacityBorrows = borrows;
    // The shadow policy is decided from `material.transparent`, and it early-returns while the
    // recorded answer still stands. Forgetting it here is what makes a unit that fades without
    // otherwise changing stop casting a solid shadow on the same frame it fades.
    unit.shadowCaster = undefined;
  }

  /** Gives every borrowed material array back and disposes the copies. Exactly reverses the above. */
  #releaseUnitOpacity(unit: RenderedUnit): void {
    const borrows = unit.opacityBorrows;
    if (!borrows) return;
    returnBorrowedMaterials(borrows);
    delete unit.opacityBorrows;
    unit.shadowCaster = undefined;
  }

  /**
   * The meshes a game object's spawn fade may borrow.
   *
   * The rigged mesh, else the single static one. WMO game objects (gunships, portcullises) are
   * deliberately excluded: fading dozens of room meshes would trade one pop for a material-clone
   * storm, and at their size the rooms arrive behind fog anyway.
   */
  #gameObjectFadeMeshes(rendered: RenderedGameObject): THREE.Mesh[] {
    if (rendered.wmo !== undefined) return [];
    if (rendered.skinned) return [rendered.skinned.mesh];
    if (rendered.visual instanceof THREE.Mesh) return [rendered.visual];
    return [];
  }

  /**
   * Eases a fresh game object in over the unit spawn window.
   *
   * The authored six opacity steps share one set of private materials. Settled objects cost
   * one comparison; changing an opacity step does not release their compiled shader programs.
   */
  #applyGameObjectOpacity(rendered: RenderedGameObject, now: number): void {
    if (rendered.fadedOpacity === 1) return;
    const meshes = this.#gameObjectFadeMeshes(rendered);
    const raw = meshes.length === 0 ? 1 : spawnFadeFactor(rendered.admittedAt, now);
    const wanted = Math.round(raw * GAMEOBJECT_FADE_STEPS) / GAMEOBJECT_FADE_STEPS;
    const current = rendered.opacityBorrows;
    const sameMeshes = current !== undefined && current.length === meshes.length
      && current.every((borrow, index) => borrow.mesh === meshes[index]);
    if (wanted === rendered.fadedOpacity && sameMeshes) return;
    if (current && sameMeshes && wanted < 1) {
      rendered.fadedOpacity = wanted;
      updateBorrowedMaterials(current, wanted);
      return;
    }
    if (current) {
      returnBorrowedMaterials(current);
      delete rendered.opacityBorrows;
    }
    rendered.fadedOpacity = wanted;
    if (wanted >= 1 || meshes.length === 0) return;
    const borrows = borrowFadedMaterials(meshes, wanted);
    if (borrows.length > 0) {
      rendered.opacityBorrows = borrows;
      for (const borrow of borrows) this.#programWarmup.registerObject(borrow.mesh);
    }
  }

  /**
   * Whether what this unit is wearing has changed under a fade that is already applied.
   *
   * A weapon drawn, a mount climbed onto or a helm that finished downloading while the unit is
   * translucent arrives opaque, and none of those changes the wanted opacity — so the comparison
   * against `unit.unitOpacity` alone would never notice. Asked only of units that are already
   * faded, over a list that is at most a body, a mount and three attachments.
   */
  #unitOpacityStale(unit: RenderedUnit): boolean {
    if (unit.unitOpacity >= 1) return false;
    const borrows = unit.opacityBorrows;
    let count = 0;
    for (const mesh of this.#unitOpacityMeshes(unit)) {
      count++;
      if (!borrows?.some((borrow) => borrow.mesh === mesh)) return true;
    }
    return count !== (borrows?.length ?? 0);
  }

  /**
   * Every mesh a unit's fade has to reach.
   *
   * The body, whichever of the two forms it took; the equipment hanging off its bones, because the
   * reference client learnt the same lesson and wrote it down (`character_renderer.cpp:3651-3653`:
   * "keep the whole visual together instead of leaving opaque weapons floating on a translucent
   * stealthed creature"); and the mount under it, which the reference client does not do because it
   * has no second model there — a rogue cannot mount in stealth, but a ghost rides a horse to its
   * corpse and an invisible player keeps whatever they were riding.
   */
  * #unitOpacityMeshes(unit: RenderedUnit): Generator<THREE.Mesh> {
    if (unit.skinned) yield unit.skinned.mesh;
    else if (unit.visual instanceof THREE.Mesh) yield unit.visual;
    for (const node of unit.attached.values()) if (node instanceof THREE.Mesh) yield node;
    const mount = unit.mount;
    if (!mount) return;
    if (mount.skinned) yield mount.skinned.mesh;
    else for (const node of mount.node.children) if (node instanceof THREE.Mesh) yield node;
  }

  #applyUnitShadow(unit: RenderedUnit, enabled: boolean): void {
    if (unit.shadowCaster === enabled) return;
    unit.node.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const eligible = materials.length > 0 && materials.every((material) => shadowMaterialEligible({
        lit: material instanceof THREE.MeshLambertMaterial
          || material instanceof THREE.MeshPhongMaterial
          || material instanceof THREE.MeshStandardMaterial,
        transparent: material.transparent,
        normalBlending: material.blending === THREE.NormalBlending,
        depthWrite: material.depthWrite,
      }));
      node.castShadow = enabled && eligible;
      node.receiveShadow = enabled && eligible;
    });
    unit.shadowCaster = enabled;
  }


  /**
   * Refine the existing WMO distance set with authored room portals. Disabled means the exact
   * pre-option path; legacy/damaged artifacts also take that path automatically.
   */
  setWmoOcclusion(enabled: boolean): void {
    this.#wmoOcclusion = enabled;
  }

  /**
   * Opts character body atlases into the renderer's maximum anisotropy. Disabled by default pending
   * R1 A/B bandwidth telemetry; toggling it updates cached atlas textures in place and can roll back
   * to the baseline 1 without changing their identity.
   */
  setCharacterAtlasAnisotropy(enabled: boolean): void {
    if (this.#characterAtlasAnisotropyEnabled === enabled) return;
    this.#characterAtlasAnisotropyEnabled = enabled;
    this.#atlases?.setAnisotropy(enabled ? this.#anisotropy() : 1);
  }

  /**
   * Applies the reversible graphics leaves. Aerial, terrain and water changes are pushed into
   * existing materials without changing their owned resources.
   * Missing/undefined input is the exact default-OFF baseline used by teardown and old callers.
   */
  setExperimentalShaderProfile(
    profile: Readonly<Partial<ExperimentalShaderProfile>> | undefined,
  ): void {
    const next = Object.freeze({
      aerialHeightFog: profile?.aerialHeightFog === true,
      terrainMicroNormals: profile?.terrainMicroNormals === true,
      waterFresnel: profile?.waterFresnel === true,
      waterMicroWaves: profile?.waterMicroWaves === true,
      waterSunSparkle: profile?.waterSunSparkle === true,
      waterFoam: profile?.waterFoam === true,
      vegetationWind: profile?.vegetationWind === true,
      fantasyGlow: profile?.fantasyGlow === true,
    });
    const current = this.#experimentalShaderProfile;
    if (current.aerialHeightFog === next.aerialHeightFog
      && current.terrainMicroNormals === next.terrainMicroNormals
      && current.waterFresnel === next.waterFresnel
      && current.waterMicroWaves === next.waterMicroWaves
      && current.waterSunSparkle === next.waterSunSparkle
      && current.waterFoam === next.waterFoam
      && current.vegetationWind === next.vegetationWind
      && current.fantasyGlow === next.fantasyGlow) return;
    this.#experimentalShaderProfile = next;
    if (current.aerialHeightFog !== next.aerialHeightFog) this.#syncAerialFog();
    for (const terrain of this.#terrains.values()) {
      if (terrain.splatted) setTerrainSplatMicroNormals(terrain.material, next.terrainMicroNormals);
    }
    for (const [liquidClass, material] of this.#liquidMaterials) {
      applyLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
    }
    for (const [liquidClass, material] of this.#fallbackLiquidMaterials) {
      applyFallbackLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
    }
    if (current.vegetationWind !== next.vegetationWind) this.#rebuildVegetationWindModels();
    if (current.fantasyGlow !== next.fantasyGlow) {
      const spellEffectKeys = new Set(this.#visuals.map((visual) => visual.key));
      for (const visual of this.#visuals) {
        if (visual.built) setBuiltModelFantasyGlow(visual.built, next.fantasyGlow);
      }
      for (const [key, held] of this.#effects) {
        if (spellEffectKeys.has(key)) setModelEffectsFantasyGlow(held.effects, next.fantasyGlow);
      }
    }
  }

  /** Re-admits only static WVM scenery whose material cache variant changes with GPU wind. */
  #rebuildVegetationWindModels(): void {
    for (const [id, rendered] of [...this.#environment]) {
      if (!rendered.wvm || rendered.skinned) continue;
      this.#environmentVisibilitySpheres.delete(rendered.source);
      this.#removeEnvironment(id, rendered);
    }
    // Ground cover is all WVM and owns only instance buffers; its static/wind builds remain
    // separate bounded cache entries and the next frame repopulates the current variant.
    this.#clearGroundCover();
  }

  /**
   * How many pixels the world is drawn into, as a share of the window.
   *
   * The only graphics option this client has, and the cheapest one there is: a city is mostly
   * fill — nine tiles of ground through a four-layer splat shader, and every one of them is
   * shaded per pixel — so three quarters of the width is a bit over half the shading. The browser
   * scales the result back up, which is softer and not smaller.
   */
  setRenderScale(scale: number): void {
    const clamped = Math.max(0.5, Math.min(1, Number.isFinite(scale) ? scale : 1));
    this.#renderScale = clamped;
    const wanted = Math.min(window.devicePixelRatio || 1, 2) * clamped;
    if (Math.abs(this.#renderer.getPixelRatio() - wanted) > 1e-4) {
      this.#renderer.setPixelRatio(wanted);
      // The size is remembered in CSS pixels, so changing the ratio has to re-derive the buffer.
      this.#renderer.setSize(Math.max(1, this.#canvas.clientWidth), Math.max(1, this.#canvas.clientHeight), false);
    }
    // Outside the branch, and that is a measured decision rather than caution: setting the scale to
    // the value it already holds returns early, and a settings apply that does exactly that is the
    // ordinary case. With the sync inside, a renderer that had just been switched back on stayed
    // without buffers until something else resized it.
    this.#syncFullscreenGlowTargets();
  }

  /** The canvas's CSS size as the last layout left it; see `#canvasCssSize`. */
  #observedCanvasSize: { width: number; height: number } | undefined;
  #canvasSizeObserver: ResizeObserver | undefined;

  /**
   * The canvas's CSS size, without laying the page out to learn it.
   *
   * `clientWidth`/`clientHeight` at the top of every frame came after the game loop had already
   * written the HUD's text and styles for that frame, so the read made the browser recompute style
   * and layout for the document — with the stock FrameXML interface, some fifteen thousand
   * elements — before the first draw call. A `ResizeObserver` is told after each layout that
   * changed the canvas, before that frame is painted, so the next frame reads two numbers. Rounded
   * the way `clientWidth` rounds, so the drawing buffer and the camera aspect stay what they were.
   * Until the first observation, and where there is no observer at all (tests), the read is as
   * before. `SimpleScene` made the same change for the overlay canvas.
   */
  #canvasCssSize(): { width: number; height: number } {
    if (this.#observedCanvasSize) return this.#observedCanvasSize;
    if (!this.#canvasSizeObserver && typeof ResizeObserver === "function") {
      this.#canvasSizeObserver = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) {
          this.#observedCanvasSize = {
            width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height),
          };
        }
      });
      this.#canvasSizeObserver.observe(this.#canvas);
    }
    return { width: this.#canvas.clientWidth, height: this.#canvas.clientHeight };
  }

  #resize(): void {
    const size = this.#canvasCssSize();
    const width = Math.max(1, size.width);
    const height = Math.max(1, size.height);
    const pixelRatio = this.#renderer.getPixelRatio();
    // `Math.floor`, which is what `setSize` writes. Rounding here instead meant that at a
    // fractional pixel ratio — which the render scale setting now makes ordinary — the comparison
    // never agreed and the buffer was re-sized on every frame for ever.
    if (this.#canvas.width !== Math.floor(width * pixelRatio) || this.#canvas.height !== Math.floor(height * pixelRatio)) {
      this.#renderer.setSize(width, height, false);
      this.#camera.aspect = width / height;
      this.#camera.updateProjectionMatrix();
    }
    // Unconditional and cheap: three number comparisons on the ordinary frame. It has to be outside
    // the branch above because the canvas is not the only thing that invalidates the buffers — a
    // lost and restored context leaves every dimension exactly where it was.
    this.#syncFullscreenGlowTargets();
  }

  /** Sample nearby outdoor flame/glow fixtures after posing, including instanced street lamps. */
  #updateFixtureLights(now: number): void {
    const selection = this.#localLightSelection;
    selection.begin(this.#lightingProfile.localLights);
    if (this.#lightingProfile.localLights > 0) {
      const visit = (rendered: {
        wvm?: WvmModel | undefined;
        visual?: THREE.Object3D | undefined;
        skinned?: SkinnedInstance | undefined;
        template?: SkinnedTemplate | undefined;
        instanceMatrix?: THREE.Matrix4 | undefined;
      },
        name: string, placement: THREE.Object3D): void => {
        const model = rendered.wvm;
        if (!model) return;
        const fixtures = modelFixtureLights(model, name);
        if (fixtures.length === 0) return;
        // Reject distant fixtures before propagating animated bones. Expand by the authored
        // source offset, placement scale and a swing margin so tall/hanging lamps are retained.
        let sourceOffset = 0;
        for (const fixture of fixtures) {
          sourceOffset = Math.max(sourceOffset, Math.hypot(fixture.position[0], fixture.position[1], fixture.position[2]));
        }
        const scale = Math.max(Math.abs(placement.scale.x), Math.abs(placement.scale.y), Math.abs(placement.scale.z));
        const reach = 64 + (sourceOffset + 16) * scale;
        if (placement.position.distanceToSquared(this.#camera.position) > reach * reach) return;
        const root = rendered.skinned?.root ?? rendered.visual;
        if (!root && !rendered.instanceMatrix) return;
        // Only the handful of actual fixtures need matrix propagation. Instanced lamps already
        // retain their complete model-to-world matrix; node.visible is false on that path.
        if (rendered.skinned) root?.updateWorldMatrix(true, true);
        else if (!rendered.instanceMatrix) root?.updateWorldMatrix(true, false);
        const fallback = rendered.instanceMatrix ?? root!.matrixWorld;
        const animationMs = (rendered.skinned?.mixer.time ?? now / 1000) * 1000;
        for (const fixture of fixtures) {
          const bone = rendered.skinned?.skeleton.bones[fixture.bone];
          const inverse = rendered.template?.boneInverses[fixture.bone];
          const matrix = bone && inverse
            ? this.#localLightMatrix.multiplyMatrices(bone.matrixWorld, inverse) : fallback;
          if (sampleFixtureLight(fixture, model, matrix, animationMs, now, this.#localLightSample)) {
            selection.add(this.#localLightSample, this.#camera.position);
          }
        }
      };
      for (const rendered of this.#environment.values()) {
        // Indoor WMO lamps already contribute baked room lighting. Keep their pools confined to
        // that path instead of shining an unshadowed point through the building's exterior wall.
        // Outdoor retained lamps remain active when the fixture is just outside the camera view.
        if (rendered.interior || rendered.source.localLight) continue;
        visit(rendered, rendered.source.name, rendered.node);
      }
      for (const rendered of this.#gameObjects.values()) {
        if (rendered.node.visible && rendered.model) visit(rendered, rendered.model, rendered.node);
      }
    }
    selection.write(this.#worldLight, this.#camera.matrixWorldInverse);
  }

  /**
   * Steps every emitter near the player, and builds or drops the sets as things come and go.
   *
   * Two budgets, both deliberate. Range, because a campfire eighty metres off is a few pixels of
   * orange and a hundred and twenty particles of arithmetic; and a count, because a city block
   * holds more braziers than a frame has room for. Both are distance-ranked rather than
   * first-come, so what is dropped is what is furthest away rather than whatever happened to be
   * iterated last. Slice R8 is where they stop being flat numbers.
   */
  #updateEffects(player: WorldPosition, now: number, elapsed: number): void {
    if (!this.#baseUrl) return;
    billboardView(this.#camera, this.#billboard);

    const wanted: {
      key: string;
      wvm: WvmModel;
      /** Squared world distance: identical sort order to the real one, without per-frame sqrt. */
      distance: number;
      posed?: PosedModel;
      visual?: THREE.Object3D;
      spell?: RenderedVisual;
      spellFirstEligible?: boolean;
      phaseKey?: string;
    }[] = [];
    const nearSquared = (x: number, y: number, z: number): number => {
      const dx = x - player.x;
      const dy = y - player.y;
      const dz = z - player.z;
      return dx * dx + dy * dy + dz * dz;
    };

    // `forEach`, and a key built once per record: this walks every retained placement, game
    // object and unit on every frame, and iterator results plus a fresh key string for each
    // emitter-bearing one were a measurable share of the frame's garbage.
    this.#environment.forEach((rendered, id) => {
      if (!rendered.admitted || !rendered.wvm
        || rendered.wvm.particleEmitters.length + rendered.wvm.ribbonEmitters.length === 0) return;
      const at = rendered.node.position;
      const distance = nearSquared(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE_SQUARED) return;
      const entry: (typeof wanted)[number] = { key: rendered.effectKey ??= `env:${id}`, wvm: rendered.wvm, distance };
      if (rendered.visual) entry.visual = rendered.visual;
      wanted.push(entry);
    });
    if (this.#skyboxModel && this.#skyboxVisual
      && this.#skyboxModel.particleEmitters.length + this.#skyboxModel.ribbonEmitters.length > 0) {
      // A LightSkybox is not a terrain placement, so it is absent from #environment. Include its
      // camera-relative emitters explicitly; otherwise cloud/spark systems in authored zone skies
      // silently disappear even though the mesh itself loaded.
      wanted.push({ key: "skybox", wvm: this.#skyboxModel, distance: 0, visual: this.#skyboxVisual });
    }
    this.#gameObjects.forEach((rendered, guid) => {
      if (!rendered.node.visible || !rendered.wvm
        || rendered.wvm.particleEmitters.length + rendered.wvm.ribbonEmitters.length === 0) return;
      // Same rule as the units below: something to hang the emitters on, or they are drawn at the
      // world origin. A rigged game object has bones; an unrigged one has its mesh.
      if (!rendered.skinned && !rendered.visual) return;
      const at = rendered.node.position;
      const distance = nearSquared(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE_SQUARED) return;
      const entry: (typeof wanted)[number] = {
        key: rendered.effectKey ??= `obj:${guid}`, wvm: rendered.wvm, distance, posed: rendered,
      };
      if (rendered.visual) entry.visual = rendered.visual;
      wanted.push(entry);
    });
    this.#units.forEach((unit, guid) => {
      if (!unit.wvm || unit.wvm.particleEmitters.length + unit.wvm.ribbonEmitters.length === 0) return;
      // A unit halfway through changing model — a druid shifting, a body whose atlas has not
      // composed yet — still remembers which file its emitters came from and has nothing to hang
      // them on. Emitting anyway would put its sparks at the world origin, because that is what a
      // missing frame is.
      if (!unit.skinned && !unit.visual) return;
      const at = unit.node.position;
      const distance = nearSquared(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE_SQUARED) return;
      const entry: (typeof wanted)[number] = { key: unit.effectKey ??= `unit:${guid}`, wvm: unit.wvm, distance, posed: unit };
      if (unit.visual) entry.visual = unit.visual;
      wanted.push(entry);
    });

    // Spell visuals are ranked and budgeted apart from the scenery, for the same reason a tile's
    // own doodads are ranked apart from what stands on the ground: a fight is a burst of two
    // dozen short-lived effects, and merged into one list they would put out every campfire in
    // the zone for a second and then hand them back.
    // `handleId` is stored at push time so the budget call below needs no per-frame spread copy.
    const visuals: Array<(typeof wanted)[number] & { handleId: number }> = [];
    const phaseStatuses = visualEffectPhaseStatuses(this.#visuals.map((visual) => {
      const assets = visual.wvm === undefined
        ? { ready: false, failed: false }
        : this.#spellAssetState(visual);
      return {
        phaseKey: visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt),
        startedAt: visual.instance.startedAt,
        modelReady: visual.wvm !== undefined,
        assetsReady: assets.ready,
        assetsFailed: assets.failed,
        activeUntil: visual.instance.endsAt,
        loadDeadline: visual.effectsLoadDeadline,
        phaseStatus: visual.effectsPhaseStatus,
        rebasable: visual.instance.fitToModel === true && visual.instance.flight === undefined
          && visual.instance.modelPlayback !== "hold",
      };
    }), now);
    const readyPhaseKeys = new Set<string>();
    for (const [phaseKey, status] of phaseStatuses) {
      if (status === "ready") readyPhaseKeys.add(phaseKey);
    }
    for (const visual of this.#visuals) {
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      const phaseStatus = phaseStatuses.get(phaseKey);
      if (phaseStatus !== undefined) visual.effectsPhaseStatus = phaseStatus;
      // Final visibility also includes the emitter budget, which is applied after all phases are
      // grouped below. Keep content hidden until that atomic decision is available.
      visual.frame.visible = false;
    }
    // Keep the admission decision atomic before distance ranking. A due member whose attachment
    // root is unavailable, or whose emitter root is outside EFFECT_RANGE, makes the whole phase
    // ineligible; otherwise a nearby sibling could start the shared clock while the missing member
    // later appears halfway through the cycle.
    const phaseEmitterGroups = new Set<string>();
    for (const visual of this.#visuals) {
      if (visual.wvm !== undefined
        && visual.wvm.particleEmitters.length + visual.wvm.ribbonEmitters.length > 0) {
        phaseEmitterGroups.add(
          `${visual.handle.id}:${visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt)}`);
      }
    }
    const phaseAdmissionRejected = rejectedVisualEffectGroups(this.#visuals.map((visual) => {
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      const at = visual.node.position;
      return {
        groupKey: `${visual.handle.id}:${phaseKey}`,
        due: visualHasStarted(visual.instance, now),
        rootVisible: visual.node.visible,
        hasEmitter: phaseEmitterGroups.has(`${visual.handle.id}:${phaseKey}`),
        // This policy compares against a real range, so keep real (not squared) distance here.
        distance: Math.sqrt(nearSquared(at.x, -at.z, at.y)),
      };
    }), EFFECT_RANGE);
    for (const visual of this.#visuals) {
      // A future visual may already have its WVM and built geometry, but it must not age particle
      // or ribbon emitters before its authored start. Root-bound effects are also hidden while
      // their unit is unavailable, so they cannot accidentally simulate at the origin.
      if (!visual.node.visible) continue;
      if (!visual.wvm || visual.wvm.particleEmitters.length + visual.wvm.ribbonEmitters.length === 0) continue;
      const at = visual.node.position;
      const distance = nearSquared(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE_SQUARED) continue;
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      if (!readyPhaseKeys.has(phaseKey)) continue;
      if (phaseAdmissionRejected.has(`${visual.handle.id}:${phaseKey}`)) continue;
      const firstEligible = visual.effectsEligibleAt === undefined;
      visuals.push({ key: visual.key, wvm: visual.wvm, distance, visual: visual.frame, spell: visual,
        spellFirstEligible: firstEligible, phaseKey, handleId: visual.handle.id });
    }
    // A cast is a composite: cast/missile/impact kits must either all get an emitter slot or none
    // of them do. Trimming this flat list by model used to leave a valid-looking half-kit, and a
    // tiny attachment movement could change which half won the distance sort from one frame to
    // the next. Group by ownership and use a stable id tie-breaker so it cannot alternate.
    const budgeted = selectVisualEffectGroups(
      visuals,
      VISUAL_EFFECT_BUDGET, readyPhaseKeys,
    );
    const selectedVisuals = budgeted.selected.filter((entry) =>
      !phaseAdmissionRejected.has(`${entry.handleId}:${entry.phaseKey ?? ""}`));
    for (const entry of selectedVisuals) {
      const spell = entry.spell;
      if (spell && spell.effectsEligibleAt === undefined) spell.effectsEligibleAt = now;
    }
    const selectedSpellGroups = new Set(selectedVisuals.map((entry) =>
      `${entry.handleId}:${entry.phaseKey ?? ""}`));
    // Meshes do not consume emitter slots, but they are still part of the same authored kit. If a
    // phase is rejected by the effect budget or root/range admission, hide every member (hammer and
    // particles together) rather than drawing the mesh alone and making the cast look incomplete.
    for (const visual of this.#visuals) {
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      const groupKey = `${visual.handle.id}:${phaseKey}`;
      const phaseStatus = phaseStatuses.get(phaseKey);
      const hasEmitterMember = phaseEmitterGroups.has(groupKey);
      const groupSelected = !hasEmitterMember || selectedSpellGroups.has(groupKey);
      const groupAdmitted = !phaseAdmissionRejected.has(groupKey);
      visual.frame.visible = visualEffectContentVisible(visual.node.visible, phaseStatus)
        && groupSelected && groupAdmitted;
    }

    // Install the shared local origin only after the effect budget admits the complete phase. A
    // ready-but-unselected kit stays at age zero while hidden; otherwise Judgement could be admitted
    // several frames later with its hammer already faded and its particles already aged.
    for (const visual of this.#visuals) {
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      const groupKey = `${visual.handle.id}:${phaseKey}`;
      const phaseHasEmitters = phaseEmitterGroups.has(groupKey);
      const admitted = !phaseAdmissionRejected.has(groupKey)
        && (!phaseHasEmitters || selectedSpellGroups.has(groupKey));
      if (!readyPhaseKeys.has(phaseKey)) continue;
      if (!admitted) {
        visual.phaseOriginAt = undefined;
        continue;
      }
      if (visual.phaseOriginAt !== undefined) continue;
      const phaseOrigin = spellEffectPhaseOrigin(visual.instance, now, undefined);
      if (phaseOrigin === undefined) continue;
      visual.phaseOriginAt = phaseOrigin;
      visual.playbackStartedAt = phaseOrigin;
      if (visual.action) {
        visual.action.reset();
        visual.action.play();
        visual.action.time = 0;
      }
      const modelMs = visual.action ? Math.max(0, visual.action.getClip().duration * 1000) : 0;
      if (Number.isFinite(visual.instance.endsAt)) {
        const window = visualPlaybackWindow(visual.instance, modelMs, visual.authoredEndsAt);
        if (window > 0) {
          visual.instance.endsAt = Math.max(visual.authoredEndsAt, phaseOrigin + window);
        }
      }
    }

    // Spell batch alpha/weight tracks are local to their admitted phase release. Keeping these
    // materials out of #builtModels prevents scenery from sharing them; sampling them here also
    // prevents a global wall-clock modulo from making Judgement's hammer appear on one cast and
    // disappear on the next.
    for (const visual of this.#visuals) {
      if (!visual.built) continue;
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      const groupKey = `${visual.handle.id}:${phaseKey}`;
      if (!readyPhaseKeys.has(phaseKey)
        || phaseAdmissionRejected.has(groupKey)
        || (phaseEmitterGroups.has(groupKey) && !selectedSpellGroups.has(groupKey))) continue;
      const origin = visual.phaseOriginAt ?? visual.playbackStartedAt ?? visual.instance.startedAt;
      updateBatchColours(visual.built.animatedBatches, Math.max(0, now - origin), now);
    }

    wanted.sort((left, right) => left.distance - right.distance);
    this.#effectsDropped = budgeted.droppedGroups + Math.max(0, wanted.length - EFFECT_BUDGET);
    if (wanted.length > EFFECT_BUDGET) wanted.length = EFFECT_BUDGET;
    wanted.push(...selectedVisuals);

    const live = new Set<string>();
    for (const entry of wanted) live.add(entry.key);
    // Deleting during Map iteration is safe; the spread copy this replaces allocated per frame.
    for (const key of this.#effects.keys()) {
      if (!live.has(key)) this.#dropEffects(key);
    }

    let effectBuilds = 0;
    for (const entry of wanted) {
      let held = this.#effects.get(entry.key);
      // Rebuilt when the model itself changes — a druid shifting form, a chest opening — because
      // the emitters belong to the file, not to the placement.
      if (held && held.source !== entry.wvm) {
        this.#dropEffects(entry.key);
        held = undefined;
      }
      let newEffects = false;
      if (!held) {
        // New emitter sets are the frame-spike source when a fight starts or a street turns:
        // geometry, materials and first texture uploads, all synchronous. Spread them over
        // frames — a skipped entry is simply rebuilt on a later one, and spell catch-up
        // simulates the missed age, so nothing is lost but the hitch.
        if (effectBuilds >= EFFECT_BUILD_BUDGET) continue;
        const built = buildModelEffects(entry.wvm, {
          baseUrl: this.#baseUrl,
          loadTexture: (url) => entry.spell
            ? this.#acquireSpellTexture(entry.spell, url)
            : this.#loadTexture(url),
          ...(entry.spell ? { privateTextureViews: true } : {}),
          // Two campfires side by side must not flicker in step, and the key is stable across
          // frames so one campfire does not restart its noise every time it is rebuilt.
          seed: modelEffectSeed(entry.key, this.#replaySeed),
          ...(entry.spell ? { fantasyGlow: this.#experimentalShaderProfile.fantasyGlow } : {}),
        });
        if (!built) {
          // Nothing drawable — every emitter's texture is a slot the client has to fill. Remember
          // it as an empty set so the resolution is not attempted again every frame.
          this.#effects.set(entry.key, { effects: EMPTY_EFFECTS, source: entry.wvm });
          continue;
        }
        held = { effects: built, source: entry.wvm };
        this.#effects.set(entry.key, held);
        this.#effectGroup.add(built.group);
        this.#programWarmup.registerObject(built.group);
        // Hidden until the warm pass has linked its programs; see `#effectWarmHold`.
        this.#effectWarmHold.hold(built.group);
        effectBuilds++;
        newEffects = true;
      }
      if (held.effects === EMPTY_EFFECTS) continue;

      const posed = entry.posed;
      const skinned = entry.spell?.skinned ?? posed?.skinned;
      const inverses = entry.spell?.template?.boneInverses ?? posed?.template?.boneInverses;
      // The pose is set by the mixer as local transforms; the world matrices behind them are only
      // recomputed by the render call, which has not happened yet this frame. It has to be
      // `updateWorldMatrix(true, …)` — the other one composes against whatever the parent's
      // `matrixWorld` already holds and walks only downwards, so a unit's bones would be placed
      // where the unit stood last frame.
      if (skinned) skinned.root.updateWorldMatrix(true, true);
      else entry.visual?.updateWorldMatrix(true, false);

      // Never `#boneMatrix`, which the loop below overwrites: a bone that turned out to be missing
      // would then be placed wherever the previous emitter's bone happened to be. Nothing reaches
      // the identity — an entry with no frame at all is filtered out above.
      const fallback = (skinned?.root ?? entry.visual)?.matrixWorld ?? IDENTITY_MATRIX;
      const matrixFor = (bone: number): ArrayLike<number> => {
        const target = skinned?.skeleton.bones[bone];
        if (!target || !inverses?.[bone]) return fallback.elements;
        // The skinning matrix, which is what a vertex weighted wholly to this bone is moved by —
        // and an emitter's position is written in the same space as a vertex.
        return this.#boneMatrix.multiplyMatrices(target.matrixWorld, inverses[bone]!).elements;
      };
      const spellAgeMs = entry.spell
        ? Math.max(0, now - (entry.spell.playbackStartedAt ?? entry.spell.instance.startedAt))
        : undefined;
      // A model can resolve hundreds of milliseconds after its packet. Prime a newly-created
      // spell system to the real local age only when it actually has one. A finite one-shot whose
      // model was already ready before its scheduled start has no visible emitter frame to catch
      // up; its active emitters get a zero-time first burst in ParticleRender, so a short
      // enabled/lifespan window cannot be consumed before the first visible frame. Scenery keeps
      // its ordinary frame delta.
      const newSpellEffects = newEffects && entry.spell !== undefined;
      const firstEligible = entry.spellFirstEligible === true;
      const primeSeconds = newEffects && entry.spell
        ? spellEffectPrimeSeconds(entry.spell.instance, spellAgeMs!,
          entry.spell.playbackStartedAt, entry.spell.instance.startedAt, firstEligible) : elapsed;
      const catchUp = newSpellEffects && primeSeconds > 0;
      const firstBurst = newSpellEffects && entry.spell !== undefined
        && spellEffectNeedsFirstBurst(entry.spell.instance, firstEligible,
          entry.spell.playbackStartedAt, entry.spell.instance.startedAt, spellAgeMs!, primeSeconds);
      updateModelEffects(held.effects, primeSeconds, {
        matrixFor,
        // A unit's emitters follow the clip it is playing; a doodad has no clip to follow, so its
        // tracks run on the wall clock and wrap on the span of their own keys. A game object is
        // either kind — a brazier has no clip, a door that is opening does.
        animationMs: entry.spell
          ? (entry.spell.action ? entry.spell.action.time * 1000 : spellAgeMs!)
          : (posed?.action ? posed.action.time * 1000 : now),
        worldMs: now,
        ...(newEffects && entry.spell ? {
          // The catch-up integrator samples keyed tracks along the local interval instead of
          // repeating the final clock value at each 100 ms substep.
          animationStartMs: Math.max(0,
            (entry.spell.action ? entry.spell.action.time * 1000 : spellAgeMs!) - primeSeconds * 1000),
          worldStartMs: now - primeSeconds * 1000,
        } : {}),
      }, this.#billboard, {
        // These predicates are mutually exclusive: an aged async visual is integrated only over
        // its bounded real local age, while an age-zero finite one-shot gets one emitter-aware
        // burst without consuming its authored enabled/lifespan window.
        catchUp,
        firstBurst,
        ...(firstBurst ? { firstBurstAnimationMs: 0 } : {}),
      });
    }
  }

  #markExpiredSpellEffectPhases(now: number): void {
    const phases = new Map<string, RenderedVisual[]>();
    for (const visual of this.#visuals) {
      if (visual.instance.startedAt > now) continue;
      const key = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      let members = phases.get(key);
      if (!members) {
        members = [];
        phases.set(key, members);
      }
      members.push(visual);
    }
    for (const members of phases.values()) {
      if (members.some((visual) => visual.effectsPhaseStatus === "failed")) continue;
      if (!members.some((visual) => visual.effectsPhaseStatus === "pending"
        && !visual.wvm && now >= visual.effectsLoadDeadline)) continue;
      for (const visual of members) visual.effectsPhaseStatus = "failed";
    }
  }

  #purgeFailedSpellEffectPhases(): void {
    const failedPhaseKeys = failedVisualEffectPhaseKeys(this.#visuals.map((visual) => ({
      phaseKey: visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt),
      phaseStatus: visual.effectsPhaseStatus,
    })));
    if (failedPhaseKeys.size === 0) return;
    for (let index = this.#visuals.length - 1; index >= 0; index--) {
      const visual = this.#visuals[index]!;
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      if (!failedPhaseKeys.has(phaseKey)) continue;
      this.#visualGroup.remove(visual.node);
      this.#dropEffects(visual.key);
      this.#disposeRenderedVisual(visual);
      this.#visuals.splice(index, 1);
    }
  }

  /** Keep every member of a phase alive until its persistent pending state is settled. */
  #phaseNeedsSettlement(target: RenderedVisual, now: number): boolean {
    const phaseKey = visualEffectPhaseKey(target.handle.id, target.instance.startedAt);
    const members = this.#visuals.filter((peer) =>
      visualEffectPhaseKey(peer.handle.id, peer.instance.startedAt) === phaseKey
      && peer.instance.startedAt <= now);
    if (!members.some((peer) => peer.effectsPhaseStatus === "pending")) return false;
    // If every model is already here, leave one final frame for #updateEffects to atomically mark
    // the phase ready (or fail an expired non-rebasable member) and install the shared origin.
    if (members.every((peer) => peer.wvm !== undefined)) return true;
    return members.some((peer) => !peer.wvm && now < peer.effectsLoadDeadline);
  }

  #dropEffects(key: string): void {
    const held = this.#effects.get(key);
    if (!held) return;
    this.#effects.delete(key);
    if (held.effects !== EMPTY_EFFECTS) {
      this.#programWarmup.unregisterObject(held.effects.group);
      this.#effectWarmHold.forget(held.effects.group);
      disposeModelEffects(held.effects);
    }
  }

  #disposeRenderedVisual(visual: RenderedVisual): void {
    this.#programWarmup.unregisterObject(visual.frame);
    disposeSkinnedInstance(visual.skinned);
    visual.skinned = undefined;
    visual.template = undefined;
    visual.action = undefined;
    // Spell geometry/materials and every private material Texture view are per visual after the
    // local-clock split. Clear the field before disposal so a repeated teardown cannot free any of
    // them twice. Cached bases are absent from ownedTextures and remain pinned until the final loop.
    const built = visual.built;
    visual.built = undefined;
    if (built) {
      built.geometry.dispose();
      for (const material of new Set(built.materials)) material.dispose();
      for (const texture of new Set(built.ownedTextures)) texture.dispose();
    }
    // Every borrower (including particle materials dropped above) is detached before base release.
    for (const lease of visual.textureLeases.values()) lease.release();
    visual.textureLeases.clear();
  }

  /**
   * Moves every batch the files paint to where its tracks say it is on this frame.
   *
   * Over the builds and not over the placements, and that is the whole reason it is cheap: a
   * material belongs to the build that made it and every copy of that model shares it, so a street
   * of forty lamps is one entry here rather than forty. Measured both ways on this machine over
   * the four tiles of Orgrimmar and the two hundred models the spell-visual table names first —
   * 658 builds, 97 of them with a batch that moves, 365 moving batches between them — the pass
   * costs **0.076 ms** a frame against a 16.7 ms budget, 0.21 µs a batch. Per placement it would
   * be the same arithmetic multiplied by 9,245, which is how many M2 placements those four tiles
   * hold; that none of those 9,245 uses a model with a moving batch is luck, not a design.
   *
   * Every build is walked rather than only the ones on screen: the list to walk is the cache
   * itself, and a build with nothing moving costs one `length` read. Deciding which are off screen
   * would cost more than doing the work.
   */
  #updateBatchColours(now: number): void {
    // Maintenance over every resident entry is not a cache hit and deliberately leaves LRU order
    // unchanged; only get/build demand in #wvmBuild and exact borrower lookups touches an entry.
    for (const built of this.#builtModels.values()) updateBatchColours(built.animatedBatches, now);
    for (const built of this.#builtUnits.values()) updateBatchColours(built.animatedBatches, now);
    // Sky texture/weight tracks are keyed to the same local game-day clip as its skeleton. Global
    // sequence tracks still receive `now` through the third argument.
    updateBatchColours(this.#skyboxAnimatedBatches, this.#skyboxAnimationMs, now);
  }

  #updateCamera(player: WorldPosition, yaw: number, pitch: number, distance: number, pivotHeight: number): void {
    const camera = createCamera(player, yaw, pitch, distance, { pivotHeight });
    this.#camera.position.set(camera.position.x, camera.position.z, -camera.position.y);
    const target = {
      x: camera.position.x + camera.forward.x * 30,
      y: camera.position.y + camera.forward.y * 30,
      z: camera.position.z + camera.forward.z * 30,
    };
    this.#camera.lookAt(target.x, target.z, -target.y);
    // Composed here rather than left to the render call at the end of the frame. Two things read
    // the camera's world matrix before then — the billboard bones as each unit is posed, and the
    // billboard basis every particle quad is built on — and both would otherwise be turning to
    // face where the camera was last frame, which shows on anything that spins on the spot.
    this.#camera.updateMatrixWorld();
  }

  #updateTerrain(player: WorldPosition, map: number | undefined, heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined, splatClient: TerrainSplatClient | undefined): void {
    const center = terrainGrid(player.x, player.y);
    if (map === undefined || !center) {
      this.clearTerrain();
      splatClient?.setActiveTiles(undefined, []);
      terrainClient?.setActiveTiles(undefined, []);
      return;
    }
    const plan = this.#terrainWindow.update(map, player.x, player.y, !this.#formalBenchmarkIsolation)!;
    if (plan !== this.#terrainPlan) {
      this.#terrainPlan = plan;
      terrainClient?.setActiveTiles(map, plan.dependencies);
      // Borrowers leave first. The splat owner may only dispose textures after their materials.
      for (const [key, rendered] of this.#terrains) {
        if (!plan.retainedKeys.has(key)) this.#removeTerrain(key, rendered);
        else {
          rendered.mesh.visible = plan.visibleKeys.has(key);
          for (const water of rendered.water ?? []) water.visible = rendered.mesh.visible;
        }
      }
      splatClient?.setActiveTiles(map, plan.retained);
    }
    const grids = plan.visible;
    // A tile's normals are sampled a step outside its own edge, while water corners also borrow
    // diagonal cells. Its revision therefore counts all eight neighbours: a tile built while one
    // of them was still downloading has an extrapolated edge or shoreline, and without this it
    // would keep it for as long as the player stands there.
    //
    // New ground remains immediately available underfoot. Existing ground keeps its exact old
    // geometry while neighbour/own-data/water repairs run cooperatively, including on the centre
    // tile: speculative dependency arrivals must not trigger two full tile scans in one frame.
    let terrainBuilds = 0;
    this.#terrainRepairsPending = 0;
    const pendingRepair = this.#terrainRepair;
    if (pendingRepair && (pendingRepair.map !== map || pendingRepair.client !== terrainClient
      || !plan.visibleKeys.has(pendingRepair.key)
      || this.#terrains.get(pendingRepair.key) !== pendingRepair.rendered
      || (terrainClient?.tileRevision(map, pendingRepair.grid) ?? 0) !== pendingRepair.revision
      || (terrainClient?.ownRevision(map, pendingRepair.grid) ?? 0) !== pendingRepair.ownRevision
      || (this.#liquidTextures?.generation ?? 0) !== pendingRepair.liquidGeneration)) {
      this.#cancelTerrainRepair();
    }
    for (const grid of grids) {
      const key = `${map}/${grid.x}/${grid.y}`;
      const revision = terrainClient?.tileRevision(map, grid) ?? 0;
      const ownRevision = terrainClient?.ownRevision(map, grid) ?? 0;
      // The tile under the player is exempt from the budgets below: one tile is bounded
      // work, and a hole underfoot for even a frame reads worse than any ring pop-in.
      const isCenterTile = grid.x === center.x && grid.y === center.y;
      const rendered = this.#terrains.get(key);
      if (!rendered) {
        if (!isCenterTile && terrainBuilds >= TERRAIN_BUILD_BUDGET) continue;
        if (this.#terrainPreparation?.key === key) this.#cancelTerrainPreparation();
        this.#buildTerrain(key, map, grid, revision, ownRevision, player, heightAt, terrainClient);
        terrainBuilds++;
      } else if (rendered.ownRevision !== ownRevision || rendered.revision !== revision
        || rendered.liquidGeneration !== (this.#liquidTextures?.generation ?? 0)) {
        this.#terrainRepairsPending++;
        if (!this.#terrainRepair) {
          this.#cancelTerrainPreparation();
          const geometry = rendered.ownRevision !== ownRevision || rendered.revision !== revision;
          const water = rendered.ownRevision !== ownRevision
            || rendered.liquidGeneration !== (this.#liquidTextures?.generation ?? 0)
            || shouldRefreshWaterForNeighbour(rendered.water);
          this.#terrainRepair = {
            key, map, grid, rendered, client: terrainClient, revision, ownRevision,
            liquidGeneration: this.#liquidTextures?.generation ?? 0,
            steps: this.#repairTerrainSteps(map, grid, { ...player }, heightAt, terrainClient, geometry, water),
          };
        }
      }
      // A budgeted-out tile has no entry until its build runs on a later frame.
      const settled = this.#terrains.get(key);
      if (settled) this.#updateTerrainSplat(map, grid, settled, splatClient);
    }
    // Visible repairs take precedence over speculative CPU work and texture uploads.
    if (terrainBuilds === 0 && this.#terrainRepair) this.#advanceTerrainRepair();
    else if (terrainBuilds === 0 && this.#terrainRepairsPending === 0) {
      this.#prepareTerrain(map, player, heightAt, terrainClient, splatClient, plan);
    }
  }

  #cancelTerrainPreparation(): void {
    // Delegated generators release any completed water surfaces in their finally block.
    this.#terrainPreparation?.steps.return(undefined as never);
    this.#terrainPreparation = undefined;
  }

  #cancelTerrainRepair(): void {
    const job = this.#terrainRepair;
    this.#terrainRepair = undefined;
    job?.steps.return(undefined as never);
  }

  *#repairTerrainSteps(map: number, grid: { x: number; y: number }, player: WorldPosition,
    heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined,
    geometry: boolean, water: boolean): Generator<void, PreparedTerrainRepair, void> {
    const data = geometry ? yield* terrainGeometrySteps(grid, player, heightAt,
      terrainClient ? (x, y) => terrainClient.isHole(map, x, y) : undefined) : undefined;
    const boundingSphere = data ? yield* this.#terrainBoundingSphereSteps(data.positions) : undefined;
    yield;
    const surfaces = water ? yield* this.#waterGeometrySteps(map, grid, heightAt, terrainClient) : undefined;
    return { ...(data ? { data } : {}), ...(boundingSphere ? { boundingSphere } : {}),
      ...(surfaces ? { water: surfaces } : {}) };
  }

  /** Match Three's bounds exactly without moving two full vertex scans into the commit frame. */
  *#terrainBoundingSphereSteps(positions: Float32Array): Generator<void, THREE.Sphere, void> {
    const bounds = new THREE.Box3(), vertex = new THREE.Vector3();
    for (let at = 0; at < positions.length; at += 3) {
      bounds.expandByPoint(vertex.fromArray(positions, at));
      if ((at / 3 + 1) % 1024 === 0) yield;
    }
    const sphere = new THREE.Sphere();
    bounds.getCenter(sphere.center);
    let radiusSq = 0;
    for (let at = 0; at < positions.length; at += 3) {
      radiusSq = Math.max(radiusSq, sphere.center.distanceToSquared(vertex.fromArray(positions, at)));
      if ((at / 3 + 1) % 1024 === 0) yield;
    }
    sphere.radius = Math.sqrt(radiusSq);
    return sphere;
  }

  #advanceTerrainRepair(): void {
    const job = this.#terrainRepair;
    if (!job) return;
    const deadline = performance.now() + TERRAIN_PREPARE_MS;
    try {
      for (let step = 0; step < TERRAIN_REPAIR_STEPS && performance.now() < deadline; step++) {
        const result = job.steps.next();
        if (!result.done) continue;
        this.#terrainRepair = undefined;
        this.#commitTerrainRepair(job, result.value);
        this.#terrainRepairsPending--;
        break;
      }
    } catch (error) {
      this.#cancelTerrainRepair();
      throw error;
    }
  }

  /** Prepare replacements before releasing old visible resources; revisions publish with them. */
  #commitTerrainRepair(job: TerrainRepair, prepared: PreparedTerrainRepair): void {
    let geometry: THREE.BufferGeometry | undefined;
    const water: THREE.Mesh[] = [];
    try {
      if (prepared.data) geometry = this.#terrainGeometryFromData(prepared.data, prepared.boundingSphere);
      for (const [liquidClass, surface] of prepared.water ?? []) {
        const mesh = new THREE.Mesh(surface, this.#liquidMaterial(liquidClass)?.material
          ?? this.#fallbackLiquidMaterial(liquidClass));
        mesh.renderOrder = 1;
        mesh.visible = job.rendered.mesh.visible;
        water.push(mesh);
      }
    } catch (error) {
      geometry?.dispose();
      for (const surface of prepared.water?.values() ?? []) surface.dispose();
      throw error;
    }
    const rendered = job.rendered;
    if (geometry) {
      this.#programWarmup.unregisterObject(rendered.mesh);
      const previous = rendered.mesh.geometry;
      rendered.mesh.geometry = geometry;
      this.#programWarmup.registerObject(rendered.mesh);
      previous.dispose();
    }
    if (prepared.water) {
      for (const previous of rendered.water ?? []) {
        this.#programWarmup.unregisterObject(previous);
        this.#scene.remove(previous);
        previous.geometry.dispose();
      }
      if (water.length > 0) rendered.water = water;
      else delete rendered.water;
      for (const mesh of water) {
        this.#scene.add(mesh);
        this.#programWarmup.registerObject(mesh);
      }
    }
    rendered.revision = job.revision;
    rendered.ownRevision = job.ownRevision;
    rendered.liquidGeneration = job.liquidGeneration;
  }

  #prepareTerrain(map: number, player: WorldPosition, heightAt: HeightSampler | undefined,
    terrainClient: TerrainClient | undefined, splatClient: TerrainSplatClient | undefined,
    plan: TerrainStreamingPlan): void {
    const pending = this.#terrainPreparation;
    if (pending && (!plan.prepare.some(grid => terrainTileKey(map, grid) === pending.key)
      || terrainClient?.tileRevision(map, pending.grid) !== pending.revision
      || (this.#liquidTextures?.generation ?? 0) !== pending.liquidGeneration)) {
      this.#cancelTerrainPreparation();
    }
    if (!terrainClient || !heightAt || plan.prepare.length === 0) return;
    const deadline = performance.now() + TERRAIN_PREPARE_MS;
    let uploaded = false;
    let requestedSplat = false;
    for (const grid of plan.prepare) {
      const key = terrainTileKey(map, grid);
      // Empty map tiles have no ground textures; wait for their own CPU answer before asking.
      const hasGround = terrainClient.ownRevision(map, grid) > 0
        && terrainClient.heightAt(map, (31.5 - grid.x) * TERRAIN_GRID_SIZE,
          (31.5 - grid.y) * TERRAIN_GRID_SIZE) !== undefined;
      // One new speculative tile request per frame, and at most two pending splat tiles.
      if (hasGround && splatClient && !requestedSplat && splatClient.stats.active < 2) {
        const active = splatClient.stats.active;
        const rendered = this.#terrains.get(key);
        if (rendered) this.#updateTerrainSplat(map, grid, rendered, splatClient);
        else splatClient.get(map, grid);
        requestedSplat = splatClient.stats.active > active;
      }
      const rendered = this.#terrains.get(key);
      const texture = !uploaded ? rendered?.textureWarmup?.shift() : undefined;
      if (texture) {
        this.#renderer.initTexture(texture);
        uploaded = true;
      }
    }
    if (performance.now() >= deadline) return;
    if (!this.#terrainPreparation) {
      for (const grid of plan.prepare) {
        const key = terrainTileKey(map, grid);
        if (this.#terrains.has(key)) continue;
        let ready = true;
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const neighbour = { x: grid.x + ox, y: grid.y + oy };
            if (neighbour.x < 0 || neighbour.x >= 64 || neighbour.y < 0 || neighbour.y >= 64) continue;
            if (terrainClient.ownRevision(map, neighbour) > 0) continue;
            ready = false;
            // Active visible downloads always have the network first. At most two CPU requests.
            if (terrainClient.stats.active < 2) {
              terrainClient.isReady(map, (31.5 - neighbour.x) * TERRAIN_GRID_SIZE,
                (31.5 - neighbour.y) * TERRAIN_GRID_SIZE);
            }
          }
        }
        if (!ready) continue;
        // A missing map tile must not acquire a speculative plane at an earlier player height.
        if (terrainClient.heightAt(map, (31.5 - grid.x) * TERRAIN_GRID_SIZE,
          (31.5 - grid.y) * TERRAIN_GRID_SIZE) === undefined) continue;
        this.#terrainPreparation = {
          key, grid, revision: terrainClient.tileRevision(map, grid),
          ownRevision: terrainClient.ownRevision(map, grid),
          liquidGeneration: this.#liquidTextures?.generation ?? 0,
          steps: this.#prepareTerrainSteps(map, grid, { ...player }, heightAt, terrainClient),
        };
        break;
      }
    }
    const job = this.#terrainPreparation;
    if (!job) return;
    for (let step = 0; step < TERRAIN_PREPARE_STEPS && performance.now() < deadline; step++) {
      const result = job.steps.next();
      if (!result.done) continue;
      this.#terrainPreparation = undefined;
      const material = buildTerrainMaterial(this.#worldLight);
      const mesh = new THREE.Mesh(this.#terrainGeometryFromData(result.value.data), material);
      mesh.visible = false;
      mesh.receiveShadow = this.#lightingProfile.shadowMapSize > 0;
      const rendered: RenderedTerrain = {
        mesh, material, revision: job.revision, ownRevision: job.ownRevision,
        liquidGeneration: job.liquidGeneration, splatted: false,
      };
      this.#terrains.set(job.key, rendered);
      this.#scene.add(mesh);
      this.#programWarmup.registerObject(mesh);
      this.#installWater(rendered, result.value.water);
      if (!requestedSplat && splatClient && splatClient.stats.active < 2) {
        this.#updateTerrainSplat(map, job.grid, rendered, splatClient);
      }
      break;
    }
  }

  *#prepareTerrainSteps(map: number, grid: { x: number; y: number }, player: WorldPosition,
    heightAt: HeightSampler, terrainClient: TerrainClient): Generator<void, PreparedTerrain, void> {
    const data = yield* terrainGeometrySteps(grid, player, heightAt, (x, y) => terrainClient.isHole(map, x, y));
    yield;
    const water = yield* this.#waterGeometrySteps(map, grid, heightAt, terrainClient);
    return { data, water };
  }

  #removeTerrain(key: string, rendered: RenderedTerrain): void {
    if (this.#terrainRepair?.rendered === rendered) this.#cancelTerrainRepair();
    this.#scene.remove(rendered.mesh);
    this.#programWarmup.unregisterObject(rendered.mesh);
    rendered.mesh.geometry.dispose();
    rendered.material.dispose();
    for (const mesh of rendered.water ?? []) {
      this.#programWarmup.unregisterObject(mesh);
      this.#scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.#terrains.delete(key);
  }

  /**
   * The ground beyond the ring, from the client's own low-resolution copy of the world.
   *
   * Rebuilt when the player crosses into another tile, which is once every 533 yards, and never
   * per frame: it is forty-odd tiles of static geometry and its own accuracy is a whole yard, so
   * there is nothing in it that changes as the camera moves.
   */
  #updateHorizon(player: WorldPosition, map: number | undefined, horizonClient: HorizonClient | undefined): void {
    const centre = map === undefined ? undefined : terrainGrid(player.x, player.y);
    const world = horizonClient?.get(map);
    if (!centre || !world) {
      if (this.#horizon) {
        this.#scene.remove(this.#horizon.mesh);
        this.#horizon.mesh.geometry.dispose();
        this.#horizon = undefined;
      }
      return;
    }
    const key = `${map}/${centre.x}/${centre.y}/${horizonClient?.revision ?? 0}`;
    if (this.#horizon?.key === key) return;
    if (this.#horizon) {
      this.#scene.remove(this.#horizon.mesh);
      this.#horizon.mesh.geometry.dispose();
    }
    const tiles = horizonTiles(world, centre);
    if (tiles.length === 0) {
      this.#horizon = undefined;
      return;
    }
    const mesh = new THREE.Mesh(buildHorizonGeometry(tiles), this.#horizonMaterial);
    // The default order, which is to say after the sky. The dome is `renderOrder -1` and writes
    // neither depth nor a depth test, so anything sharing that order is painted over by it —
    // measured as a horizon that loaded, selected its 63 tiles, built its mesh and never appeared.
    mesh.renderOrder = 0;
    this.#horizon = { mesh, key };
    this.#scene.add(mesh);
  }

  #buildTerrain(key: string, map: number, grid: { x: number; y: number }, revision: number, ownRevision: number, player: WorldPosition, heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined): void {
    // Terrain has authored diffuse colour and vertex normals, but no specular/metal channel.
    // Lambert keeps the terrain's no-specular contract and fog while the shared shader supplies
    // authored world light: a Standard material always contributes a dielectric highlight, even
    // at roughness .96, which made the splat field read like wet plastic in daylight.
    const material = buildTerrainMaterial(this.#worldLight);
    const mesh = new THREE.Mesh(this.#terrainGeometry(map, grid, player, heightAt, terrainClient), material);
    mesh.receiveShadow = this.#lightingProfile.shadowMapSize > 0;
    const rendered: RenderedTerrain = { material, mesh, revision, ownRevision, splatted: false, liquidGeneration: this.#liquidTextures?.generation ?? 0 };
    this.#terrains.set(key, rendered);
    this.#scene.add(mesh);
    this.#programWarmup.registerObject(mesh);
    this.#replaceWater(rendered, map, grid, heightAt, terrainClient);
  }

  /**
   * The ground used to be one baked picture per tile — under two pixels per metre, with every
   * texture smeared across a whole chunk. Now the shader blends the original ground textures at
   * their own resolution, so this only has to hand the material its ingredients once they arrive.
   */
  #updateTerrainSplat(map: number, grid: { x: number; y: number }, rendered: RenderedTerrain, splatClient: TerrainSplatClient | undefined): void {
    if (rendered.splatted || !splatClient) return;
    const splat = splatClient.get(map, grid);
    if (!splat) return;
    splat.layers.anisotropy = this.#anisotropy();
    applyTerrainSplat(rendered.material, splat);
    setTerrainSplatMicroNormals(rendered.material, this.#experimentalShaderProfile.terrainMicroNormals);
    setTerrainWetness(rendered.material, this.#atmosphereProfile.wetSurfaces, this.#atmosphereProfile.rainSplashes);
    rendered.splatted = true;
    if (!rendered.mesh.visible) {
      rendered.textureWarmup = [splat.layers, splat.alpha, splat.index];
      if (splat.colours) rendered.textureWarmup.push(splat.colours);
    }
    // The splat hook and the micro-normal switch are part of the material's program cache key, so
    // the unsplatted variant warmed at build time is not the one this tile will draw.
    this.#programWarmup.registerObject(rendered.mesh);
  }

  /**
   * One surface per liquid class, because a lake and a lava pool are not the same thing.
   *
   * The class comes out of the map file's own per-cell flag byte, which was being read and thrown
   * away: everything drew as one translucent blue sheet with a hard edge at the shore. Each cell
   * also carries how deep it is over the ground under it, which is what fades that edge.
   */
  #replaceWater(rendered: RenderedTerrain, map: number, grid: { x: number; y: number }, heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined): void {
    for (const mesh of rendered.water ?? []) {
      this.#programWarmup.unregisterObject(mesh);
      mesh.geometry.dispose();
      this.#scene.remove(mesh);
    }
    delete rendered.water;
    this.#installWater(rendered, this.#waterGeometry(map, grid, heightAt, terrainClient));
  }

  #installWater(rendered: RenderedTerrain, surfaces: Map<LiquidClass, THREE.BufferGeometry>): void {
    const meshes: THREE.Mesh[] = [];
    for (const [liquidClass, geometry] of surfaces) {
      const mesh = new THREE.Mesh(geometry, this.#liquidMaterial(liquidClass)?.material
        ?? this.#fallbackLiquidMaterial(liquidClass));
      mesh.renderOrder = 1;
      mesh.visible = rendered.mesh.visible;
      meshes.push(mesh);
      this.#scene.add(mesh);
      this.#programWarmup.registerObject(mesh);
    }
    if (meshes.length > 0) rendered.water = meshes;
  }

  /**
   * The material for one liquid class, or nothing until its animation strip has arrived.
   *
   * The flat sheet stands in meanwhile. A tile is rebuilt when its own data changes, so the
   * stand-in is what the first second or two of a lake looks like on a cold cache and no longer.
   */
  #liquidMaterial(liquidClass: LiquidClass): LiquidMaterial | undefined {
    const built = this.#liquidMaterials.get(liquidClass);
    if (built) return built;
    const strip = this.#liquidTextures?.get(liquidClass);
    if (!strip) return undefined;
    const material = buildLiquidMaterial(liquidClass, strip);
    applyLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
    if (liquidClass === "water" || liquidClass === "ocean") {
      setWaterRainRipples(material.material, this.#atmosphereProfile.rainSplashes);
    }
    this.#liquidMaterials.set(liquidClass, material);
    return material;
  }

  /**
   * A bounded, per-class stand-in for a liquid whose animated strip has not arrived yet.  Keeping
   * this separate from the strip material means a water profile can never affect a magma/slime
   * fallback merely because all four classes previously borrowed one blue material.
   */
  #fallbackLiquidMaterial(liquidClass: LiquidClass): THREE.MeshBasicMaterial {
    const existing = this.#fallbackLiquidMaterials.get(liquidClass);
    if (existing) return existing;
    const material = new THREE.MeshBasicMaterial({
      color: 0x2d7fa5,
      fog: true,
      transparent: true,
      opacity: WATER_FALLBACK_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
      // A height field composites the same in one pass as in three's two; see `Water.ts`.
      forceSinglePass: true,
    });
    applyFallbackLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
    if (liquidClass === "water" || liquidClass === "ocean") {
      setWaterRainRipples(material, this.#atmosphereProfile.rainSplashes);
    }
    this.#fallbackLiquidMaterials.set(liquidClass, material);
    return material;
  }

  #waterProfile(): Readonly<{
    waterFresnel: boolean;
    waterMicroWaves: boolean;
    waterSunSparkle: boolean;
    waterFoam: boolean;
    fantasyGlow: boolean;
    waterSunGlitter?: boolean;
    waterSkyReflection?: boolean;
  }> {
    const { waterSunGlitter, waterSkyReflection } = this.#cinematic.profile;
    if (!waterSunGlitter && !waterSkyReflection) return this.#experimentalShaderProfile;
    const cached = this.#cinematicWaterProfile;
    const current = this.#experimentalShaderProfile;
    if (cached && cached.waterFresnel === current.waterFresnel && cached.waterMicroWaves === current.waterMicroWaves
      && cached.waterSunSparkle === current.waterSunSparkle && cached.waterFoam === current.waterFoam
      && cached.fantasyGlow === current.fantasyGlow && cached.waterSunGlitter === waterSunGlitter
      && cached.waterSkyReflection === waterSkyReflection) return cached;
    this.#cinematicWaterProfile = Object.freeze({ ...current, waterSunGlitter, waterSkyReflection });
    return this.#cinematicWaterProfile;
  }

  #waterGeometry(map: number, grid: { x: number; y: number }, heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined): Map<LiquidClass, THREE.BufferGeometry> {
    const steps = this.#waterGeometrySteps(map, grid, heightAt, terrainClient);
    let result = steps.next();
    while (!result.done) result = steps.next();
    return result.value;
  }

  *#waterGeometrySteps(map: number, grid: { x: number; y: number }, heightAt: HeightSampler | undefined,
    terrainClient: TerrainClient | undefined): Generator<void, Map<LiquidClass, THREE.BufferGeometry>, void> {
    const surfaces = new Map<LiquidClass, { positions: number[]; uvs: number[]; depths: number[]; calm: number[]; indices: number[] }>();
    // A water quad used to get one height and one depth for all four vertices.  That made the
    // alpha/deep-colour transition follow the 4.16-yard cell grid, which is especially obvious
    // on shallow shores.  Keep the look-up bounded to this tile: neighbouring cells are cached,
    // so every shared corner is sampled once even though the quads intentionally remain separate
    // (a dry cell must not be pulled into a wet surface).
    //
    // Numeric cache keys and scalar locals: the loop below runs 16,384 cells per tile, and the
    // previous revision allocated a template string per sample plus a dozen small arrays per wet
    // cell (offsets, neighbours, corners, grounds, depths). Same samples, same means, no garbage.
    // Key space: world coordinates stay within ±2^25 milliyards (maps end at ±17,067 yards), so
    // `(x * 2^26) + y` is exact in a double.
    const liquidCache = new Map<number, ReturnType<NonNullable<TerrainClient["liquidAt"]>> | undefined>();
    const groundCache = new Map<number, number>();
    const sampleKey = (x: number, y: number): number =>
      (Math.round(x * 1000) + 33554432) * 67108864 + (Math.round(y * 1000) + 33554432);
    const sampleLiquid = (x: number, y: number) => {
      const key = sampleKey(x, y);
      if (!liquidCache.has(key)) liquidCache.set(key, terrainClient?.liquidAt(map, x, y));
      return liquidCache.get(key);
    };
    const sampleGround = (x: number, y: number) => {
      const key = sampleKey(x, y);
      let ground = groundCache.get(key);
      if (ground === undefined) {
        ground = heightAt?.(x, y) ?? Number.NEGATIVE_INFINITY;
        groundCache.set(key, ground);
      }
      return ground;
    };
    // Reused across every corner of the tile: `waterCornerHeight` only reads it synchronously,
    // and the mean it computes does not depend on neighbour order.
    const neighbourScratch: (ReturnType<NonNullable<TerrainClient["liquidAt"]>> | undefined)[] = [];
    const cornerLiquidHeight = (
      liquid: NonNullable<ReturnType<NonNullable<TerrainClient["liquidAt"]>>>,
      liquidClass: LiquidClass,
      x: number,
      y: number,
      row: number,
      column: number,
    ): number => {
      // x0/y0 are the +x/+y sides of the cell.  The two adjacent cell centres are therefore
      // [current,+one cell] on that side and [-one cell,current] on the other side — the same
      // three neighbours the offset tables below used to enumerate, without the tables.
      const rowSign = row === 0 ? 1 : -1;
      const columnSign = column === 0 ? 1 : -1;
      neighbourScratch.length = 0;
      neighbourScratch.push(
        sampleLiquid(x + rowSign * LIQUID_CELL_YARDS, y),
        sampleLiquid(x, y + columnSign * LIQUID_CELL_YARDS),
        sampleLiquid(x + rowSign * LIQUID_CELL_YARDS, y + columnSign * LIQUID_CELL_YARDS),
      );
      return waterCornerHeight(liquid, neighbourScratch, liquidClass, this.#liquidTextures?.classes);
    };
    // Same formula as `waterCornerDepths`, inlined so a wet cell costs no arrays: a surface
    // below the ground sample is not negative depth, it is a shore.
    const cornerDepth = (water: number, ground: number): number =>
      ground !== undefined && Number.isFinite(ground) ? Math.max(0, water - ground) : DEEP_WATER_YARDS;
    for (let row = 0; row < TERRAIN_SUBDIVISIONS; row++) {
      const x0 = (32 - grid.x - row / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
      const x1 = (32 - grid.x - (row + 1) / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
      for (let column = 0; column < TERRAIN_SUBDIVISIONS; column++) {
        const y0 = (32 - grid.y - column / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
        const y1 = (32 - grid.y - (column + 1) / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
        const x = (x0 + x1) / 2;
        const y = (y0 + y1) / 2;
        const liquid = sampleLiquid(x, y);
        const ground = sampleGround(x, y);
        if (!liquid) continue;
        // Where the file carries a height per cell, the cell's own answer is the mask: the -500
        // filler `liquidAt` already rejects marks every dry cell of the rectangle, and comparing
        // against the ground on top of that erased water the client really has — 1,857 of 41,203
        // wet cells over eight measured tiles, 26.4% of one of them, every one of them a shore or
        // a stream bed where the surface sits a little below the terrain sample at the cell's
        // middle. Where there is no per-cell height — 1,729 of the 3,196 tiles with liquid — the
        // chunk flag is the finest mask that exists, and the ground test is all that keeps a
        // tile-wide level off the hillsides.
        if (!liquid.cells && liquid.height < ground + 0.02) continue;
        const liquidClass = liquidClassOf(liquid.type, liquid.entry, this.#liquidTextures?.classes);
        let surface = surfaces.get(liquidClass);
        if (!surface) {
          surface = { positions: [], uvs: [], depths: [], calm: [], indices: [] };
          surfaces.set(liquidClass, surface);
        }
        const base = surface.positions.length / 3;
        const h00 = cornerLiquidHeight(liquid, liquidClass, x, y, 0, 0);
        const h10 = cornerLiquidHeight(liquid, liquidClass, x, y, 1, 0);
        const h01 = cornerLiquidHeight(liquid, liquidClass, x, y, 0, 1);
        const h11 = cornerLiquidHeight(liquid, liquidClass, x, y, 1, 1);
        surface.positions.push(
          x0, h00 + 0.04, -y0,
          x1, h10 + 0.04, -y0,
          x0, h01 + 0.04, -y1,
          x1, h11 + 0.04, -y1,
        );
        // World coordinates decide the UVs, so the surface tiles continuously across cells and
        // across the tile boundary rather than restarting at each quad.
        surface.uvs.push(
          y0 / LIQUID_CELL_YARDS, x0 / LIQUID_CELL_YARDS,
          y0 / LIQUID_CELL_YARDS, x1 / LIQUID_CELL_YARDS,
          y1 / LIQUID_CELL_YARDS, x0 / LIQUID_CELL_YARDS,
          y1 / LIQUID_CELL_YARDS, x1 / LIQUID_CELL_YARDS,
        );
        // Ground is sampled at each corner too; using the centre for all four vertices was the
        // other source of the square shoreline pattern.
        surface.depths.push(
          cornerDepth(h00, sampleGround(x0, y0)),
          cornerDepth(h10, sampleGround(x1, y0)),
          cornerDepth(h01, sampleGround(x0, y1)),
          cornerDepth(h11, sampleGround(x1, y1)),
        );
        const calm = liquidCalmOf(liquid.entry);
        surface.calm.push(calm, calm, calm, calm);
        surface.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
      if ((row + 1) % 4 === 0) yield;
    }
    const built = new Map<LiquidClass, THREE.BufferGeometry>();
    let transferred = false;
    try {
      for (const [liquidClass, surface] of surfaces) {
        yield;
        if (surface.indices.length === 0) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.positions, 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(surface.uvs, 2));
        geometry.setAttribute("liquidDepth", new THREE.Float32BufferAttribute(surface.depths, 1));
        geometry.setAttribute("liquidCalm", new THREE.Float32BufferAttribute(surface.calm, 1));
        geometry.setIndex(surface.indices);
        geometry.computeVertexNormals();
        built.set(liquidClass, geometry);
      }
      transferred = true;
      return built;
    } finally {
      if (!transferred) for (const geometry of built.values()) geometry.dispose();
    }
  }

  /**
   * One tile's authored V9/V8 diamond ground, with neighbour-aware normals at its outer edge.
   *
   * An unqualified `computeVertexNormals` averages only the faces this mesh owns, and a vertex on
   * the tile's edge has faces on one side of it, so every tile boundary carried a lit seam: measured along
   * the join between tiles 49-31 and 50-31, a one-sided normal is 6.8 to 14.0 degrees off the
   * field's own on average and 33.6 to 97.9 at worst. A vertex next to a hole lost its faces the
   * same way. Sampling the field a step out in each direction has neither problem — the sampler
   * reads whichever tile the point falls in, so with the neighbour loaded the two sides of a join
   * agree to between 0.005 and 0.046 degrees — and it costs a skirt of one vertex around the edge
   * rather than a second pass over the mesh.
   *
   * What the skirt costs instead is a dependency on a tile the player may not have yet. A sample
   * that lands in a tile which has not arrived used to fall back to the player's own height, which
   * is not a height field at all: that reads as 19 to 102 degrees of error along the edge and 151
   * at worst — an order of magnitude worse than the seam it replaced. The fallback now continues
   * the tile's own last two rows, which measures 1.1 to 5.3 degrees, and `tileRevision` counts the
   * eight neighbours so the tile is rebuilt properly once the real ground lands.
  */
  #terrainGeometry(map: number, grid: { x: number; y: number }, player: WorldPosition, heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined): THREE.BufferGeometry {
    return this.#terrainGeometryFromData(terrainGeometryData(
      grid, player, heightAt,
      terrainClient ? (x, y) => terrainClient.isHole(map, x, y) : undefined,
    ));
  }

  #terrainGeometryFromData({ positions, normals, uvs, indices }: TerrainGeometryData, boundingSphere?: THREE.Sphere): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    if (boundingSphere) geometry.boundingSphere = boundingSphere;
    else geometry.computeBoundingSphere();
    return geometry;
  }

  #updateEnvironment(player: WorldPosition, objects: readonly EnvironmentObject[], client: EnvironmentClient | undefined, elapsed = 0): void {
    // The gateway's origin only becomes known once a client exists; models resolve their own
    // texture URLs against it.
    if (client && !this.#baseUrl) this.#baseUrl = client.baseUrl;
    // The full-scan ranking baseline was 1.26 ms in Stormwind: 42,797 placements over nine tiles,
    // sorted from scratch on every frame including the ones where the player stood still. The
    // static index is built only when EnvironmentClient hands over a new snapshot identity/
    // generation; this frame performs local exact selection after its query. The live leash is
    // 300 yards, so four yards of walking cannot change the answer's resident snapshot.
    // `objectsAround` hands back the same array while nothing has landed, so its identity is the
    // other half of the question and is exact.
    if (objects !== this.#environmentObjects) {
      this.#environmentObjects = objects;
      this.#environmentSpatialIndex = new EnvironmentSpatialIndex(objects);
      this.#environmentGeneration++;
    }
    if (shouldReselect(this.#environmentCandidatesAt, player, this.#environmentGeneration)) {
      const pool = this.#environmentSpatialIndex?.queryCached(
        player.x, player.y, ENVIRONMENT_STREAM_RANGE,
      ).objects ?? objects;
      this.#environmentCandidates = environmentCandidatesInRange(pool, player, this.#environmentDetail);
      // The loaded zone: strictly wider than every draw leash, so the line an object crosses
      // to appear is never the line it crosses to disappear. Draw admission below still reads
      // the strict set; disposal reads this one.
      this.#environmentResidents = environmentResidentsInRange(pool, player, this.#environmentDetail);
      this.#environmentCandidatesAt = {
        x: player.x,
        y: player.y,
        generation: this.#environmentGeneration,
      };
      this.#environmentReselectedSerial = this.#submissionSerial;
    }

    // Camera visibility changes without player movement, so only the distance candidates use the
    // four-yard cache. This pass is wire/retained-state only and precedes every model/group/liquid
    // lookup below.
    this.#frustumMatrix.multiplyMatrices(this.#camera.projectionMatrix, this.#camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#frustumMatrix);
    // Draw admission at half rate while the camera is calm: a slow frustum moves less between
    // frames than the eight-yard margin admits, while a fast sweep keeps every-frame admission —
    // a stale edge set there would show holes, not late trees. New candidate sets always
    // recompute, so a landing tile is never a frame late. Builds, rooms and growth all key off
    // membership, which changes slowly by construction (hysteresis plus build budgets).
    let admitted = this.#lastAdmitted;
    if (admitted === undefined
      || this.#admissionCandidates !== this.#environmentCandidates
      || this.#cameraTurnRate > CAMERA_FAST_TURN_RATE
      || (this.#submissionSerial & 1) === 0) {
      admitted = selectEnvironmentAdmission(
        this.#environmentCandidates,
        this.#frustum.planes,
        (object) => {
          const rendered = this.#environment.get(object.id);
          return rendered?.source === object
            ? rendered.visibilitySphere
            : this.#environmentVisibilitySpheres.get(object);
        },
        this.#experimentalShaderProfile.vegetationWind ? VEGETATION_WIND_CULL_PADDING : 0,
      );
      this.#lastAdmitted = admitted;
      this.#admissionCandidates = this.#environmentCandidates;
    }
    // These ranked arrays are replaced on reselection/admission, never edited in place.
    // Keep only the current membership; live resource, room and growth work below still runs.
    if (this.#residentMembership?.source !== this.#environmentResidents) {
      const values = new Map<number, EnvironmentObject>();
      for (const { object } of this.#environmentResidents) values.set(object.id, object);
      this.#residentMembership = { source: this.#environmentResidents, values };
    }
    const inRange = this.#residentMembership.values;
    if (this.#admittedMembership?.source !== admitted) {
      const values = new Set<number>();
      for (const { object } of admitted) values.add(object.id);
      this.#admittedMembership = { source: admitted, values };
    }
    const drawn = this.#admittedMembership.values;
    for (const [id, rendered] of this.#environment) {
      if (!inRange.has(id)) {
        this.#removeEnvironment(id, rendered);
        continue;
      }
      // A tile reload may reuse a numeric placement id. Its old transform/model cannot lend bounds
      // or a node to the new immutable snapshot, even while both happen to be in the same range.
      if (rendered.source !== inRange.get(id)) {
        this.#removeEnvironment(id, rendered);
        continue;
      }
      this.#setEnvironmentAdmitted(rendered, drawn.has(id));
    }
    if (this.#submissionSerial - this.#warmPruneAtSerial >= WARM_PRUNE_INTERVAL_FRAMES) {
      this.#warmPruneAtSerial = this.#submissionSerial;
      this.#pruneWarmEnvironment();
    }

    this.#realModels = 0;
    // Node builds (geometry compose, material setup, WMO box transforms) are the turn-frame
    // hitch: a 180° snap can newly admit hundreds of placements at once. Cap them per frame —
    // a skipped admission is retried on the next one while it is still admitted, so a sweep
    // ramps in over frames instead of landing in one.
    let environmentBuilds = 0;
    this.#environmentBuildBudget.begin();
    for (const { object, distance } of admitted) {
      // The same distance the ranking used: to the building rather than to the pin, or a city is
      // ranked in but still swapped for its stand-in box from most of its own streets. Far-tier
      // shells and far vegetation resolve their model too — the rooms stay on the near leash
      // below, so a far castle costs its shell groups and not its interior. An admitted M2 is
      // inside its own size-scaled leash, so it always resolves: a big rock at 500 yards is art.
      const model = distance < MODEL_RANGE || object.kind === "m2" || environmentFarEligible(object)
        || environmentVegetation(object)
        ? client?.model(object.name, "normal") : undefined;
      let rendered = this.#environment.get(object.id);
      const replacesWmo = rendered !== undefined && model !== undefined
        && (rendered.wmo !== undefined || model.wmo !== undefined)
        && rendered.wmo?.model !== model.wmo;
      const replacesLegacy = rendered !== undefined && legacyDecodedModelReplaced(
        rendered.decodedModel,
        rendered.legacyGeometry !== undefined,
        model,
      );
      const replacesWvm = rendered !== undefined && model?.wvm !== undefined
        && rendered.wvm !== undefined && rendered.wvm !== model.wvm;
      if (!rendered || (!rendered.actual && model) || replacesWmo || replacesLegacy || replacesWvm) {
        // A first sight that already grew keeps its stamp across a display rebuild, so a tree
        // that changes state does not grow twice. A model landing on a loading stand-in starts
        // unstamped and eases in below.
        if (environmentBuilds >= ENVIRONMENT_BUILD_BUDGET) continue;
        if (!this.#environmentBuildBudget.take()) continue;
        const everVisible = rendered?.everVisible;
        if (rendered) {
          this.#disposeEnvironment(rendered);
          // The replaced node's emitters go with it: they were placed against a matrix that is
          // about to stop being updated.
          this.#dropEffects(`env:${object.id}`);
        }
        // A building is placed empty and filled a room at a time; everything else is one mesh —
        // unless it has a rig, in which case it is a skinned mesh with a mixer of its own.
        const building = model?.wmo ? this.#wmoNode(object, model.wmo) : undefined;
        const rig = building ? undefined : this.#doodadRig(object, model, distance);
        const node = building?.node ?? rig?.node ?? this.#environmentNode(object, model);
        rendered = {
          actual: Boolean(model),
          node,
          source: object,
          admitted: true,
          interior: object.interior === true,
          lastAdmittedFrame: this.#submissionSerial,
        };
        if (model && model.wvm === undefined && model.wmo === undefined) {
          rendered.decodedModel = model;
        }
        const borrowedBuild = node.userData["builtModel"];
        if (borrowedBuild) rendered.built = borrowedBuild as BuiltModel;
        const legacyGeometry = node.userData["legacyGeometry"];
        if (legacyGeometry) rendered.legacyGeometry = legacyGeometry as LegacyGeometryEntry;
        const materialEntries = node.userData["worldMaterialEntries"];
        if (Array.isArray(materialEntries)) {
          rendered.materialEntries = materialEntries as readonly WorldMaterialEntry[];
        }
        const tintMaterials = node.userData["modelPlacementTintMaterials"];
        if (Array.isArray(tintMaterials)) rendered.tintMaterials = tintMaterials as readonly THREE.Material[];
        if (model?.wvm) rendered.wvm = model.wvm;
        if (building) rendered.wmo = building.placed;
        if (rig) {
          rendered.skinned = rig.instance;
          rendered.template = rig.template;
          rendered.model = object.name;
        }
        const visual = node.userData["visual"];
        if (visual instanceof THREE.Object3D) rendered.visual = visual;
        if (everVisible) rendered.everVisible = true;
        this.#environment.set(object.id, rendered);
        // Rigged scenery draws skinned; see `#instanceGroup` for why the kinds keep to themselves.
        (rendered.skinned ? this.#animatedEnvironmentGroup : this.#environmentGroup).add(node);
        // Vegetation grows in instead of popping — but only on real content at first sight,
        // and never mid-sweep: the turn tracker in `draw()` suppresses it while a snap or a
        // fast sweep is in flight, because motion masks an instant appearance there. Loading
        // cones appear as they always have, and anything seen before (frustum re-entry,
        // settled budget churn) reads whole at once.
        // Matrices stay live until it settles, and instancing waits — an instance matrix is
        // exact placement state, and a tree mid-growth is not exact. Rigged placements are
        // exempt: their sails are already live.
        const suppressGrowth = this.#submissionSerial < this.#turnSuppressUntilSerial;
        const growing = environmentVegetation(object) && rendered.skinned === undefined
          && rendered.actual && rendered.visual !== undefined && !everVisible && !suppressGrowth;
        if (growing) {
          rendered.everVisible = true;
          rendered.growthStartedAt = this.#submissionSerial;
          this.#growingVegetation++;
          rendered.growthTotal = distance > ENVIRONMENT_RANGE
            ? VEGETATION_GROWTH_FAR_FRAMES
            : VEGETATION_GROWTH_NEAR_FRAMES;
          // Multiplied over the placement's own scale, which `placeEnvironmentNode` already set:
          // growing from the authored size, not from one.
          node.scale.setScalar(object.scale * VEGETATION_GROWTH_FROM);
        } else if (rendered.actual && rendered.visual !== undefined) {
          // Shown whole — suppressed mid-sweep, exempt, or simply seen — so stamping it now
          // keeps a later calm frame from shrinking it into a grow-in it already survived.
          rendered.everVisible = true;
        }
        // Nothing in the environment ever moves, so its matrices are composed once here instead of
        // once per object per frame. About seven hundred objects stop recomposing a local matrix
        // and a world matrix sixty times a second to arrive at the number they already had.
        //
        // Except the ones with a rig in them. A mixer writes bone matrices every frame and the
        // whole point of writing them is that they are read afterwards; freezing the subtree would
        // pose the skeleton and then draw last frame's pose for ever. The outer node is still
        // frozen — the mill does not move, only its sails do. Growing trees are the second
        // exception, and the one that was missed first: with `matrixAutoUpdate` off, the scale
        // the growth pass writes never recomposes, so the tree sat at a quarter for thirty
        // frames and then jumped whole.
        node.matrixAutoUpdate = !growing;
        node.updateMatrix();
        node.updateMatrixWorld(true);
        // Frozen down to the leaves, buildings included. `Object3D.updateMatrixWorld` recurses
        // into its children whatever the parent's own flags say, so a room hung on a frozen
        // building afterwards still multiplies itself by the building's world matrix and lands
        // where it belongs — measured, because the first version of this exempted buildings on the
        // assumption that it would not. Freezing only the outer node would leave the mesh inside
        // it composing and multiplying its own matrix sixty times a second for no reason. Growing
        // trees skip the freeze until they settle; the growth pass owns their matrices meanwhile.
        if (!rendered.skinned && !growing) {
          node.traverse((part: THREE.Object3D) => {
            part.matrixAutoUpdate = false;
            part.matrixWorldAutoUpdate = false;
          });
        }
        const visibilitySphere = this.#environmentVisibilitySphere(rendered);
        if (visibilitySphere) {
          rendered.visibilitySphere = visibilitySphere;
          this.#environmentVisibilitySpheres.set(object, visibilitySphere);
        } else if (model) {
          // A temporary cache miss/stand-in is not evidence against the last exact static sphere.
          // Delete it only when a resolved replacement proves this placement is no longer safe.
          this.#environmentVisibilitySpheres.delete(object);
        }
        // Which placements can be drawn as copies of one mesh. A building cannot — it is drawn a
        // room at a time — and neither can a model with emitters, whose sparks are placed by
        // reading the matrix of this very mesh. A growing tree joins the instances when it
        // settles; its mid-growth matrix is not exact placement state.
        if (!growing) this.#assignEnvironmentInstance(rendered, object, visual, model);
        this.#instancesDirty = true;
        environmentBuilds++;
      }
      // Every frame, not only on the frame it was placed: the rooms worth drawing change as the
      // player walks through the building, and the ones that were asked for land later.
      if (rendered.wmo) {
        if (model?.wmo === rendered.wmo.model) {
          this.#updateWmoGroups(rendered.wmo, player, rendered.node, client, true);
        } else {
          // An undefined answer after dormancy, or a replacement parent, cannot revive old rooms.
          this.#clearWmoGroups(rendered.wmo, rendered.node);
        }
      }
      // The building's own water. Attempted every frame until it is built because the collision
      // model it comes from arrives on its own schedule, and rebuilt when the animation strip
      // lands — the same reason the tile's water carries a generation.
      if (object.kind === "wmo" && rendered.actual) {
        const generation = this.#liquidTextures?.generation ?? 0;
        // `liquidGeneration` is set as soon as the model has been *seen*, whether or not it had
        // any water in it, so a dry building is asked once rather than every frame for as long as
        // the player stands near it. Of 53 placed models on this dataset, three carry liquid.
        if (rendered.liquidGeneration !== generation && this.#collisionModels?.(object.name)) {
          this.#dropWmoLiquid(rendered);
          rendered.liquidGeneration = generation;
          const sheets = this.#buildWmoLiquid(object);
          if (sheets) {
            rendered.liquid = sheets;
            for (const mesh of sheets) this.#scene.add(mesh);
          }
        }
      }
      if (rendered.actual) this.#realModels++;
    }
    this.#prefetchEnvironmentModels(client);
    this.#updateVegetationGrowth(client);
    this.#poseDoodads(player, client, elapsed);
    this.#updateInstances();
  }

  /**
   * Warms models in the resident band, including just beyond the visible distance.
   *
   * The admitted loop fetches only what is on screen *now*; without this, every turn cold-fetches
   * what it reveals. The sweep is position-circular and frustum-blind by design — streaming
   * follows the player, visibility follows the camera — and it only ever touches the client's
   * background-lane queue, which dedupes, promotes to critical on real demand, and stays bounded
   * by its own limits. No nodes, materials or textures are built here.
   *
   * Every fourth submitted frame is enough: warming is best-effort background work by design
   * ("a full sweep takes seconds, which is fine"), and the per-frame scan touches 256
   * candidates with a lookup each. The cursor persists, so coverage only rotates more slowly.
   */
  #prefetchEnvironmentModels(client: EnvironmentClient | undefined): void {
    if (!client) return;
    const candidates = this.#environmentResidents;
    if (this.#prefetchCandidates !== candidates) {
      this.#prefetchCandidates = candidates;
      this.#prefetchNames = [...new Set(candidates
        .filter(environmentModelPrefetchEligible).map(({ object }) => object.name))];
      // A four-yard move changes the candidate array, not the progress through the warm sweep.
    }
    client.retainModelPrefetch(this.#prefetchNames);
    if ((this.#submissionSerial & 3) !== 0) return;
    const { names, nextCursor } = selectPrefetchModels(candidates, (id) => {
      const rendered = this.#environment.get(id);
      return rendered !== undefined
        && (rendered.built !== undefined || rendered.wmo !== undefined
          || rendered.decodedModel !== undefined || rendered.legacyGeometry !== undefined);
    }, this.#prefetchCursor);
    this.#prefetchCursor = nextCursor;
    for (const name of names) client.prefetchModel(name);
  }

  /**
   * Advances vegetation grow-ins and settles the finished ones.
   *
   * Only a node transform moves: no material is cloned, no transparency is toggled, so a forest
   * coming into range costs matrix composes on its growing trees and nothing else. A settled tree
   * is frozen exactly like any other placement and joins the instances it waited out of.
   */
  #updateVegetationGrowth(client: EnvironmentClient | undefined): void {
    // Nothing is growing: skip the scan over every retained placement. The counter is exact —
    // incremented where growth starts, decremented where it settles or its node is disposed —
    // so a skipped frame can never leave a tree small.
    if (this.#growingVegetation <= 0) return;
    let settled = false;
    for (const rendered of this.#environment.values()) {
      const startedAt = rendered.growthStartedAt;
      if (startedAt === undefined || !rendered.admitted) continue;
      const node = rendered.node;
      const baseScale = rendered.source.scale;
      const total = rendered.growthTotal ?? VEGETATION_GROWTH_FRAMES;
      if (this.#submissionSerial - startedAt >= total) {
        node.scale.setScalar(baseScale);
        node.updateMatrix();
        node.updateMatrixWorld(true);
        node.traverse((part: THREE.Object3D) => {
          part.matrixAutoUpdate = false;
          part.matrixWorldAutoUpdate = false;
        });
        delete rendered.growthStartedAt;
        delete rendered.growthTotal;
        this.#growingVegetation--;
        this.#assignEnvironmentInstance(
          rendered,
          rendered.source,
          rendered.visual,
          client?.model(rendered.source.name, "background"),
        );
        settled = true;
        continue;
      }
      // The render loop recomposes this subtree on its own (`matrixAutoUpdate` stayed on), but
      // same-frame readers — the emitter pass, the instance clone at settle — need it now.
      node.scale.setScalar(baseScale * vegetationGrowthScale(startedAt, this.#submissionSerial, total));
      node.updateMatrix();
    }
    if (settled) this.#instancesDirty = true;
  }

  /** Shares one mesh across placements when the model allows copies of itself. */
  #assignEnvironmentInstance(
    rendered: RenderedEnvironment,
    object: EnvironmentObject,
    visual: unknown,
    model: EnvironmentModel | undefined,
  ): void {
    const instanceKey = this.#vegetationBuildKey(object.name);
    const built = instanceable(model)
      ? this.#builtModels.get(this.#builtCacheKey(this.#builtModels, instanceKey))
      : undefined;
    if (
      visual instanceof THREE.Object3D
      && built
      && instanceableBuild(built.materials)
    ) {
      rendered.instanceKey = instanceKey;
      rendered.instanceMatrix = visual.matrixWorld.clone();
    }
  }

  /** Changes draw membership without changing ownership of the retained placement. */
  #setEnvironmentAdmitted(rendered: RenderedEnvironment, admitted: boolean): void {
    if (admitted) rendered.lastAdmittedFrame = this.#submissionSerial;
    if (rendered.admitted === admitted) return;
    rendered.admitted = admitted;
    this.#instancesDirty = true;
    if (admitted) {
      // The instance pass may hide this node again after installing it in an InstancedMesh.
      rendered.node.visible = true;
      for (const mesh of rendered.liquid ?? []) mesh.visible = true;
      return;
    }
    rendered.node.visible = false;
    for (const mesh of rendered.liquid ?? []) mesh.visible = false;
    // WMO room wrappers are demand-side resources. Keep the parent warm, not every hidden room.
    if (rendered.wmo) this.#clearWmoGroups(rendered.wmo, rendered.node);
  }

  /** Removes one placement after it leaves range or loses the bounded warm LRU. */
  #removeEnvironment(id: number, rendered: RenderedEnvironment): void {
    this.#disposeEnvironment(rendered);
    delete rendered.liquidGeneration;
    this.#environment.delete(id);
    this.#dropEffects(`env:${id}`);
    this.#instancesDirty = true;
  }

  /**
   * Caps warm hidden residents independently by class. Current draw admission is never an LRU
   * victim; three previous quota-sized sectors remain available for a bounded 360° camera turn.
   *
   * Enforcement runs at most every thirty submitted frames rather than on every one: eviction
   * delayed half a second is invisible (warm residents are hidden by definition), while the
   * scan itself walks every retained placement and allocates two arrays plus a closure each
   * time. Overflow between runs is bounded by the per-frame build budgets.
   */
  #pruneWarmEnvironment(): void {
    const exterior: Array<[number, RenderedEnvironment]> = [];
    const interior: Array<[number, RenderedEnvironment]> = [];
    for (const entry of this.#environment) {
      const rendered = entry[1];
      if (rendered.admitted) continue;
      (rendered.interior ? interior : exterior).push(entry);
    }
    const evict = (entries: Array<[number, RenderedEnvironment]>, budget: number): void => {
      const overflow = entries.length - budget;
      if (overflow <= 0) return;
      entries.sort((left, right) => left[1].lastAdmittedFrame - right[1].lastAdmittedFrame
        || left[0] - right[0]);
      for (let index = 0; index < overflow; index++) {
        const entry = entries[index];
        if (entry) this.#removeEnvironment(entry[0], entry[1]);
      }
    };
    evict(exterior, ENVIRONMENT_WARM_EXTERIOR_BUDGET);
    evict(interior, ENVIRONMENT_WARM_INTERIOR_BUDGET);
  }

  /** Returns a current static M2 sphere without consulting any resource client. */
  #environmentVisibilitySphere(rendered: RenderedEnvironment): EnvironmentVisibilitySphere | undefined {
    if (rendered.skinned || rendered.wmo || rendered.decodedModel || rendered.legacyGeometry
      || !rendered.wvm || !rendered.built || !rendered.visual) return undefined;
    if (rendered.wvm.particleEmitters.length > 0 || rendered.wvm.ribbonEmitters.length > 0) {
      return undefined;
    }
    const sphere = rendered.built.geometry.boundingSphere;
    if (!sphere || !Number.isFinite(sphere.center.x) || !Number.isFinite(sphere.center.y)
      || !Number.isFinite(sphere.center.z) || !Number.isFinite(sphere.radius) || sphere.radius < 0) {
      return undefined;
    }
    const matrix = rendered.visual.matrixWorld.elements;
    const x = matrix[0]! * sphere.center.x + matrix[4]! * sphere.center.y
      + matrix[8]! * sphere.center.z + matrix[12]!;
    const y = matrix[1]! * sphere.center.x + matrix[5]! * sphere.center.y
      + matrix[9]! * sphere.center.z + matrix[13]!;
    const z = matrix[2]! * sphere.center.x + matrix[6]! * sphere.center.y
      + matrix[10]! * sphere.center.z + matrix[14]!;
    const scaleX = Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!);
    const scaleY = Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!);
    const scaleZ = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
    const scale = Math.max(scaleX, scaleY, scaleZ);
    // Admission covers simultaneous sway on both local horizontal axes, even though only a strict
    // subset of this build's alpha-key batches may actually carry wind.
    const radius = (sphere.radius
      + (this.#experimentalShaderProfile.vegetationWind ? VEGETATION_WIND_CULL_PADDING : 0)) * scale;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
      || !Number.isFinite(radius) || radius < 0) return undefined;
    return { x, y, z, radius };
  }

  /** Releases one scenery placement while leaving its shared model build in the cache. */
  #disposeEnvironment(rendered: RenderedEnvironment): void {
    this.#programWarmup.unregisterObject(rendered.node);
    // Paired with the increment where growth starts: a disposed node never settles, so the
    // counter follows the flag rather than the settle path.
    if (rendered.growthStartedAt !== undefined) {
      delete rendered.growthStartedAt;
      delete rendered.growthTotal;
      this.#growingVegetation--;
    }
    disposeSkinnedInstance(rendered.skinned);
    delete rendered.skinned;
    delete rendered.template;
    disposeModelPlacementTintMaterials(rendered.tintMaterials);
    delete rendered.tintMaterials;
    if (rendered.wmo) this.#clearWmoGroups(rendered.wmo, rendered.node);
    rendered.node.removeFromParent();
    this.#dropWmoLiquid(rendered);
  }

  /**
   * Advances the scenery that moves.
   *
   * Only a handful of placements have a rig at all — of 405 published WVM artifacts on this
   * dataset, 60 carry a skeleton — and this loop still walks all of them rather than keeping a
   * second list, because the environment map is already in hand and the branch is one field read.
   *
   * The pose itself is `Stand`, looping, and that is the whole of the chooser. A doodad has no
   * state to read and nothing to react to: whatever a bird does when it is being a bird is what
   * the artist put in its Stand, and it is the reason the model was rigged in the first place.
   */
  #poseDoodads(player: WorldPosition, client: EnvironmentClient | undefined, elapsed: number): void {
    this.#frustumMatrix.multiplyMatrices(this.#camera.projectionMatrix, this.#camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#frustumMatrix);

    const posed: Array<{ rendered: RenderedEnvironment; distance: number }> = [];
    // `forEach` rather than `for…of`: the iterator protocol hands back a result object per
    // entry, and this walks every retained placement on every frame.
    this.#environment.forEach((rendered) => {
      if (!rendered.admitted || !rendered.skinned || !rendered.template) return;
      const at = rendered.node.position;
      // The node is in the scene's frame, where y is up and world y is negated.
      const distance = hypot2(at.x - player.x, -at.z - player.y);
      if (distance > DOODAD_ANIMATION_RANGE) return;
      // Off screen it is still where it is, and it will be back; it simply does not have to be
      // posed while nobody can see it.
      if (!this.#frustum.intersectsObject(rendered.skinned.mesh)) return;
      posed.push({ rendered, distance });
    });
    posed.sort((left, right) => left.distance - right.distance);
    this.#doodadsPosed = Math.min(posed.length, DOODAD_ANIMATION_BUDGET);

    for (let index = 0; index < this.#doodadsPosed; index++) {
      const { rendered } = posed[index]!;
      const template = rendered.template!;
      const instance = rendered.skinned!;
      if (!template.merged && rendered.model && client && !template.clips.has(ANIMATION_IDS.Stand)) {
        // The clips a model ships with are the locomotion set; anything else is in the sidecar and
        // is one request away. The exact rig is coalesced by the environment sidecar scheduler.
        const clips = client.animations(rendered.model, template.parents.length, "background");
        if (clips) {
          addSkinnedClips(template, clips);
          template.merged = true;
        }
      }
      const clip = template.clips.get(ANIMATION_IDS.Stand);
      if (clip && instance.mixer.existingAction(clip) === null) {
        const action = instance.mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
      }
      instance.mixer.update(elapsed);
      if (rendered.wvm) applyGlobalSequenceBones(instance, template, rendered.wvm.globalSequences,
        this.#waterShaderUniforms.time.value * 1000);
      applyBillboardBones(instance, template, this.#camera);
    }
  }

  /**
   * Draws every repeated doodad once instead of once per copy.
   *
   * Geometry and materials were already shared — two copies of a barrel have been one set of GPU
   * buffers since the model cache existed — but each copy was still its own `Mesh` and therefore
   * its own draw call. Measured inside Stormwind, the selection is 120 placements over 8 to 14
   * distinct models: the same picture in 8 to 14 draws.
   *
   * The placements keep their nodes. Nothing is recomputed here — the matrix was taken when the
   * placement was made and the environment never moves. Membership follows explicit draw admission,
   * not `node.visible`: an admitted instance hides its source node, while a warm-hidden placement
   * must be absent from this mesh entirely. Models with emitters stay uninstanced because an instance
   * has no object frame from which a torch's sparks could be placed.
   */
  #updateInstances(): void {
    // Only when the membership has changed. The matrices never do — the environment does not move
    // — so on an ordinary frame there is nothing here to recompute, and the slice's own rule is
    // that a per-frame rebuild has to earn its place.
    if (!this.#instancesDirty) return;
    this.#instancesDirty = false;
    // The bucket lists and each placement's bucket key are kept between rebuilds: a rebuild runs on
    // every admission flip — continuously while the camera turns — and building the key string and
    // a fresh array per bucket each time was 131 MB of the movement route's 20 s allocation profile.
    const byModel = this.#instanceBuckets;
    for (const list of byModel.values()) list.length = 0;
    this.#environment.forEach((rendered) => {
      if (!rendered.admitted || !rendered.instanceKey || !rendered.instanceMatrix) return;
      // A local-light shader has deliberately unwrapped the outdoor world-light hook. It must
      // never share an InstancedMesh/material array with an outdoor placement of the same model.
      const bucket = rendered.instanceBucket
        ??= `${rendered.instanceKey}\0${rendered.source.localLight ? "local" : "world"}`;
      const list = byModel.get(bucket);
      if (list) list.push(rendered);
      else byModel.set(bucket, [rendered]);
    });
    for (const [key, list] of byModel) {
      if (list.length === 0) byModel.delete(key);
    }

    for (const [key, list] of byModel) {
      if (list.length < INSTANCE_MINIMUM) {
        for (const rendered of list) this.#showAsPlain(rendered);
        this.#dropInstance(key);
        continue;
      }
      const modelKey = list[0]!.instanceKey!;
      const built = this.#builtModels.get(this.#builtCacheKey(this.#builtModels, modelKey));
      if (!built) continue;
      const locallyLit = list[0]!.source.localLight !== undefined;
      let entry = this.#instances.get(key);
      let freshMesh = false;
      // An `InstancedMesh` fixes its capacity when it is made, so it is grown in powers of two
      // rather than rebuilt every time one more barrel comes into range.
      if (!entry || entry.capacity < list.length) {
        this.#dropInstance(key);
        freshMesh = true;
        const capacity = instanceCapacity(list.length);
        const localLight = locallyLit ? {
          materials: createInstancedModelPlacementLocalLightMaterials(built.materials),
          attribute: new THREE.InstancedBufferAttribute(new Uint8Array(capacity * 3), 3, true),
        } : undefined;
        if (localLight) built.geometry.setAttribute(MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE, localLight.attribute);
        const mesh = new THREE.InstancedMesh(
          built.geometry,
          localLight?.materials ?? built.materials,
          capacity,
        );
        // One sphere over every copy, spread across the whole selection radius, so per-object
        // culling was never going to help here — and would only have been asked a hundred times.
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        entry = localLight
          ? { mesh, capacity, built, localLight }
          : { mesh, capacity, built };
        this.#instances.set(key, entry);
        (localLight ? this.#localLightInstanceGroup : this.#instanceGroup).add(mesh);
      }
      for (const [index, rendered] of list.entries()) {
        entry.mesh.setMatrixAt(index, rendered.instanceMatrix!);
        const localLight = rendered.source.localLight;
        if (entry.localLight && localLight) {
          entry.localLight.attribute.setXYZ(index, localLight[0], localLight[1], localLight[2]);
        } else {
          entry.mesh.setColorAt(
            index,
            modelPlacementTintColour(rendered.source.tint, this.#instanceTint),
          );
        }
        rendered.node.visible = false;
      }
      entry.mesh.count = list.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
      if (entry.localLight) entry.localLight.attribute.needsUpdate = true;
      if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true;
      // `setMatrixAt` does not invalidate it, and three computes it once and keeps it: left alone,
      // the sphere would be the centroid of whichever copies happened to be in range first.
      entry.mesh.computeBoundingSphere();
      // Registered after the colours, not at creation: `setColorAt` is what gives the mesh its
      // `instanceColor` attribute, and that attribute is part of the program three compiles.
      if (freshMesh) this.#programWarmup.registerObject(entry.mesh);
      // Шаг 19: a new instanced variant is drawn only once the warm pass has linked its programs.
      // Until then the copies keep drawing as their own nodes, whose plain-mesh programs are warm:
      // nothing pops, and no program is built and linked inside the submission (the movement
      // route's last compile frame, an 11 ms first draw).
      if (freshMesh && !this.#instancedMeshWarm(entry.mesh)) {
        this.#instanceWarmHolds.set(entry.mesh, { frames: 0, nodes: [] });
      }
      const hold = this.#instanceWarmHolds.get(entry.mesh);
      if (hold) {
        entry.mesh.visible = false;
        hold.nodes = list.map((rendered) => rendered.node);
        for (const rendered of list) this.#showAsPlain(rendered);
      }
    }

    // Deleting during Map iteration is safe; the spread copy this replaces allocated per rebuild.
    for (const key of this.#instances.keys()) {
      if (!byModel.has(key)) this.#dropInstance(key);
    }
  }

  /**
   * A copy that draws as its own node again — its bucket dropped below `INSTANCE_MINIMUM`, or a
   * fresh bucket is still linking — is shown with its plain program warmed first.
   *
   * A copy instanced from the moment it was placed has only ever drawn through the bucket, whose
   * program is the instanced variant; its own plain variant may never have been compiled. Shown
   * outright, it linked that variant inside the submit: the city bench's 36 ms frame at the
   * eighteenth second, named by the bench's link attribution as a foliage mesh whose program key
   * went from the instanced to the plain packing. Registering it again is free when it is warm,
   * and `hold` leaves a warm mesh alone.
   */
  #showAsPlain(rendered: RenderedEnvironment): void {
    rendered.node.visible = true;
    const visual = rendered.node.userData["visual"];
    if (visual instanceof THREE.Mesh) {
      this.#programWarmup.registerObject(rendered.node);
      this.#visualWarmHold.hold(visual);
    }
  }

  /** After the warm pass: swaps each held instanced mesh in for its copies once it is warm. */
  #releaseWarmInstances(): void {
    for (const [mesh, hold] of this.#instanceWarmHolds) {
      if (!mesh.parent) {
        // Dropped while waiting (`#dropInstance`); its copies were given back by the caller.
        this.#instanceWarmHolds.delete(mesh);
      } else if (hold.frames >= INSTANCE_WARM_HOLD_FRAMES || this.#instancedMeshWarm(mesh)) {
        for (const node of hold.nodes) node.visible = false;
        mesh.visible = true;
        this.#instanceWarmHolds.delete(mesh);
      } else {
        hold.frames++;
      }
    }
  }

  #instancedMeshWarm(mesh: THREE.InstancedMesh): boolean {
    const kind = programWarmupKind(mesh);
    if (!kind) return true;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material && !this.#programWarmup.isWarm(material, mesh.geometry, kind)) return false;
    }
    return true;
  }

  /**
   * Keeps a unit's new body out of every pass until each program it will draw with has linked.
   *
   * A fresh unit put on private translucent fade copies (`#applyUnitOpacity`) on the frame its model
   * was first drawn, so the driver linked their programs inside the submission: city-arrival
   * measured seven such links in the arriving crowd, first draws of 24–149 ms. A body that is not
   * ready now waits hidden until `ProgramWarmup.isLinked` holds for every program it will use — the
   * shared materials of every mesh it wears (body, equipment, mount), the stand-ins of their fade
   * copies (`#fadeTwin`) while it fades, the capsule's pair while it is one — and is let go after the
   * warm pass that links the last of them (`#releaseWarmUnits`), or after its cap regardless, which
   * is the old first-draw cost and never a unit that stays missing.
   *
   * Hiding is all it changes. Admission, poses, shadows, selection, plates and portraits run as
   * before, and the spawn fade's clock stands still while nothing is drawn: the stamp moves forward
   * by every held frame, so the unit is already dressed at the opacity it will be shown with and the
   * fade starts on the first frame anybody can see it. The player's own model is never hidden once
   * it has been on screen; its first appearance may wait, for at most UNIT_WARM_HOLD_SELF_FRAMES.
   */
  #holdUnitUntilWarm(unit: RenderedUnit, self: boolean, presented: boolean, appearanceOpacity: number,
    now: number): boolean {
    const hold = this.#unitWarmHolds.get(unit);
    if (hold) {
      if (unit.admittedAt !== undefined) unit.admittedAt += now - hold.clockAt;
      hold.clockAt = now;
      hold.visible = presented;
      hold.serial = this.#submissionSerial;
      return true;
    }
    const body = unitWarmBody(unit);
    if (!presented || body === undefined || body === unit.warmShown) return false;
    const fading = appearanceOpacity * spawnFadeFactor(unit.admittedAt, now) < 1;
    if ((self && unit.modelShown === true) || this.#unitProgramsReady(unit, fading)) {
      this.#markUnitShown(unit, body);
      return false;
    }
    this.#unitWarmHolds.set(unit, {
      frames: 0, cap: self ? UNIT_WARM_HOLD_SELF_FRAMES : UNIT_WARM_HOLD_FRAMES,
      clockAt: now, visible: presented, serial: this.#submissionSerial,
    });
    return true;
  }

  /** After the warm pass: lets each held unit and part on screen once it is ready or its wait is over. */
  #releaseWarmUnits(): void {
    for (const [unit, hold] of this.#unitWarmHolds) {
      if (!unit.node.parent) {
        // Left the scene while waiting: out of range, or taken apart by a world clear.
        this.#unitWarmHolds.delete(unit);
        continue;
      }
      // A unit this frame did not draw keeps waiting: admission hid its node and its clock was not
      // stopped for this frame, so it is let go on the next frame that draws it.
      const drawn = hold.serial === this.#submissionSerial;
      if (!drawn || (hold.frames < hold.cap
        && !this.#unitProgramsReady(unit, unit.unitOpacity < 1 || unit.opacityBorrows !== undefined))) {
        hold.frames++;
        continue;
      }
      this.#unitWarmHolds.delete(unit);
      const body = unitWarmBody(unit);
      if (body) this.#markUnitShown(unit, body);
      unit.node.visible = hold.visible && !this.#vehiclePassengers.hides(unit.node); // 11.02-H-review
    }
    for (const [part, hold] of this.#unitPartWarmHolds) {
      if (!hold.unit.node.parent || !hangsUnder(part, hold.unit.node)) {
        // Taken off again, or its unit is gone: whatever hangs it next is a new mesh, tracked anew.
        part.visible = true;
        this.#unitPartWarmHolds.delete(part);
        continue;
      }
      const fading = hold.unit.unitOpacity < 1 || hold.unit.opacityBorrows !== undefined;
      if (hold.frames < UNIT_WARM_HOLD_FRAMES && !this.#unitMeshProgramsReady(hold.unit, part, fading)) {
        hold.frames++;
        continue;
      }
      part.visible = true;
      this.#unitPartWarmHolds.delete(part);
    }
  }

  /** Records the body the warm hold let on screen, and whether it was a model rather than a pill. */
  #markUnitShown(unit: RenderedUnit, body: THREE.Object3D): void {
    unit.warmShown = body;
    if (body !== unit.body) unit.modelShown = true;
  }

  /**
   * Queues the fade stand-ins of every mesh just hung on a unit, and holds back a part — a weapon, a
   * helmet, a mount — that arrives on a unit already on screen until its own programs link.
   *
   * Registering the stand-ins when a mesh is hung, rather than when a fade borrows its copies, is what
   * lets the warm pass link them before any copy is drawn: a spawn fade begins on the frame a unit is
   * first shown, which used to be the very frame its copies were first registered. The player's own
   * parts are never held back (see UNIT_WARM_HOLD_SELF_FRAMES).
   */
  #trackUnitMeshes(unit: RenderedUnit, self: boolean): void {
    if (unit.body) {
      const capsule = this.#capsulePrograms();
      this.#programWarmup.registerMaterial(capsule.opaque, this.#unitBodyGeometry, "mesh", "unit");
      this.#programWarmup.registerMaterial(capsule.faded, this.#unitBodyGeometry, "mesh", "unit");
    }
    const body = unitWarmBody(unit);
    const onScreen = !self && body !== undefined && body === unit.warmShown && !this.#unitWarmHolds.has(unit);
    const fading = unit.unitOpacity < 1 || unit.opacityBorrows !== undefined;
    for (const mesh of this.#unitOpacityMeshes(unit)) {
      if (this.#unitWarmTracked.has(mesh)) continue;
      this.#unitWarmTracked.add(mesh);
      const kind = programWarmupKind(mesh);
      if (!kind) continue;
      const borrow = unit.opacityBorrows?.find((entry) => entry.mesh === mesh);
      const shared = borrow ? borrow.shared : mesh.material;
      for (const material of Array.isArray(shared) ? shared : [shared]) {
        if (material) this.#programWarmup.registerMaterial(this.#fadeTwin(material), mesh.geometry, kind, "unit");
      }
      if (!onScreen || mesh === body || this.#unitMeshProgramsReady(unit, mesh, fading)) continue;
      mesh.visible = false;
      this.#unitPartWarmHolds.set(mesh, { unit, frames: 0 });
    }
  }

  /**
   * Whether drawing this unit now, and after its fade, links nothing: the shared materials of every
   * mesh it wears and, while it fades, the stand-ins of their faded copies; the capsule's pair while
   * it is one. Whatever is not linked is queued (again, if its keeper was evicted), so every wait has
   * the warm pass working towards its end.
   */
  #unitProgramsReady(unit: RenderedUnit, fading: boolean): boolean {
    let ready = unit.body === undefined || this.#capsuleProgramsReady(fading);
    for (const mesh of this.#unitOpacityMeshes(unit)) {
      if (!this.#unitMeshProgramsReady(unit, mesh, fading)) ready = false;
    }
    return ready;
  }

  /** `#unitProgramsReady` for one mesh; a borrowed mesh answers for the shared array it lent. */
  #unitMeshProgramsReady(unit: RenderedUnit, mesh: THREE.Mesh, fading: boolean): boolean {
    const kind = programWarmupKind(mesh);
    if (!kind) return true;
    const borrow = unit.opacityBorrows?.find((entry) => entry.mesh === mesh);
    const shared = borrow ? borrow.shared : mesh.material;
    let ready = true;
    for (const material of Array.isArray(shared) ? shared : [shared]) {
      if (!material) continue;
      if (!this.#unitProgramLinked(material, mesh.geometry, kind)) ready = false;
      if (fading && !this.#unitProgramLinked(this.#fadeTwin(material), mesh.geometry, kind)) ready = false;
    }
    return ready;
  }

  /** Linked, or else in the warm pass's hands: queued again only if nothing is working on it. */
  #unitProgramLinked(material: THREE.Material, geometry: THREE.BufferGeometry, kind: ProgramWarmupKind): boolean {
    const warmup = this.#programWarmup;
    if (warmup.isLinked(material, geometry, kind)) return true;
    if (!warmup.isTracked(material, geometry, kind)) warmup.registerMaterial(material, geometry, kind, "unit");
    return false;
  }

  /** The pill's two programs: the opaque one it settles into and, while it fades, the translucent one. */
  #capsuleProgramsReady(fading: boolean): boolean {
    const capsule = this.#capsulePrograms();
    const opaque = this.#unitProgramLinked(capsule.opaque, this.#unitBodyGeometry, "mesh");
    const faded = !fading || this.#unitProgramLinked(capsule.faded, this.#unitBodyGeometry, "mesh");
    return opaque && faded;
  }

  /**
   * Stand-ins for the two programs every capsule draws with. The pills' own materials are per unit —
   * the tint is theirs — and are faded in place, so none of them can answer for the others; and the
   * opaque program was never compiled ahead at all: city-arrival linked it inside the frame an
   * arriving unit's capsule finished its fade, a 149 ms draw.
   */
  #capsulePrograms(): { readonly opaque: THREE.Material; readonly faded: THREE.Material } {
    return this.#capsuleTwins ??= {
      opaque: createUnitCapsuleMaterial(0xffffff, this.#worldLight),
      faded: createUnitCapsuleMaterial(0xffffff, this.#worldLight, true),
    };
  }

  /**
   * The program stand-in for every faded copy of one shared unit material (`createFadeProgramTwin`),
   * made once and dropped with its source when the build owning the source is disposed. It is a
   * snapshot, so a source whose program switches moved since (`version`, its cache key) gets a new one.
   */
  #fadeTwin(source: THREE.Material): THREE.Material {
    const existing = this.#fadeTwins.get(source);
    const key = source.customProgramCacheKey();
    if (existing && existing.version === source.version && existing.key === key) return existing.twin;
    if (existing) existing.drop();
    const twin = createFadeProgramTwin(source);
    const drop = (): void => {
      source.removeEventListener("dispose", drop);
      if (this.#fadeTwins.get(source)?.twin === twin) this.#fadeTwins.delete(source);
      twin.dispose();
    };
    source.addEventListener("dispose", drop);
    this.#fadeTwins.set(source, { twin, version: source.version, key, drop });
    return twin;
  }

  /**
   * Whether a fade that has just come back to full opacity keeps its private copies one frame more,
   * drawn at full opacity so it already looks finished, because a shared program it hands the unit
   * back to has not linked — a keeper evicted mid-fade, or a hold that ran out. At most
   * UNIT_FADE_RETURN_HOLD_FRAMES frames; then the copies go back regardless (the old first-draw cost).
   */
  #unitFadeReturnWaits(unit: RenderedUnit, wanted: number): boolean {
    if (wanted < 1 || (unit.opacityBorrows === undefined && !unit.material.transparent)) {
      if (unit.fadeReturnFrames !== undefined) delete unit.fadeReturnFrames;
      return false;
    }
    const frames = unit.fadeReturnFrames ?? 0;
    if (frames >= UNIT_FADE_RETURN_HOLD_FRAMES || this.#unitProgramsReady(unit, false)) return false;
    unit.fadeReturnFrames = frames + 1;
    return true;
  }

  /**
   * The grass around the player, scattered from the tile's recipe and drawn one model at a time.
   *
   * Distance fade follows the player every frame through shared shader uniforms. Scatter and
   * matrix uploads run on the same four-yard step as environment ranking, retaining a margin
   * beyond the visible radius. Uploads also run when a pending model arrives, so a stationary
   * player does not have to walk before newly loaded grass appears.
   */
  #updateGroundCover(player: WorldPosition, map: number | undefined, heightAt: HeightSampler | undefined,
    terrainClient: TerrainClient | undefined, client: EnvironmentClient | undefined): void {
    const cover = this.#groundCover;
    const radius = this.#groundCoverRadius;
    if (!cover || map === undefined || radius <= 0) {
      if (this.#groundCoverMeshes.size > 0 || this.#groundCoverField) this.#clearGroundCover();
      return;
    }
    // Uniforms follow every movement frame; scatter and instance-buffer uploads stay on their
    // four-yard cadence. Scene x/z correspond to world x/-y.
    this.#groundCoverFade.centre.value.set(player.x, -player.y);
    this.#groundCoverFade.radius.value = radius;
    const table = cover.table();
    if (!table) return;

    // The generation carries three separate reasons to scatter again: a recipe landed, the effect
    // table landed, or the player changed a setting. The distance carries the fourth. A sum works
    // because neither half ever goes down, so no change in either can leave the total where it was.
    const generation = cover.generation + this.#groundCoverSettings;
    const sample = heightAt ?? ((x: number, y: number) => terrainClient?.heightAt(map, x, y));
    const sameField = this.#groundCoverAt?.map === map && this.#groundCoverAt.generation === generation
      && this.#groundCoverField !== undefined;
    // Walking reaches the environment's four-yard step and this one on the same frame. When the
    // environment has just re-ranked, a walked rebuild waits one frame (a tenth of a yard at a
    // run, inside the four-yard margin) so the two never stack into one long frame.
    const due = this.#groundCoverAt?.map !== map || shouldReselect(this.#groundCoverAt, player, generation);
    const wait = due && sameField && this.#environmentReselectedSerial === this.#submissionSerial
      && this.#groundCoverDeferredSerial !== this.#submissionSerial - 1;
    if (wait) this.#groundCoverDeferredSerial = this.#submissionSerial;
    if (due && !wait) {
      this.#groundCoverAt = { x: player.x, y: player.y, map, generation };
      const cellsKey = `${map}|${generation}`;
      if (this.#groundCoverCellsKey !== cellsKey) {
        this.#groundCoverCellsKey = cellsKey;
        this.#groundCoverCells = createGroundCoverCellCache();
      }
      this.#groundCoverField = scatterGroundCover({
        cells: this.#groundCoverCells,
        // The previous field's maps and arrays are written over rather than made again: a
        // four-yard rebuild of a 40,000-tuft field allocated 8 MB, and at a mount's pace that was
        // three such rebuilds a second feeding the full collections the owner's recordings show.
        reuse: this.#groundCoverField,
        recipe: groundCoverRecipeSource(cover, map),
        table,
        centre: player,
        // Generated wider than it is drawn, so that at its stalest — a whole step of walking after
        // the last rebuild — the field still reaches the radius on the side being walked towards.
        radius: radius + GROUND_COVER_MARGIN,
        drawRadius: radius,
        deferDistanceFade: true,
        perCell: this.#groundCoverDense,
        densityScale: this.#groundCoverDensity,
        // The cap scales with the density for the same reason the density does: a thicker meadow
        // is more tufts, not the same tufts cut off closer. Nearest-first still owns the far edge.
        cap: Math.round(GROUND_COVER_BUDGET * this.#groundCoverDensity),
        heightAt: sample,
      });
      this.#groundCoverPending.clear();
      for (const key of [...this.#groundCoverMeshes.keys()]) {
        if (!this.#groundCoverField.models.has(key)) this.#dropGroundCoverMesh(key);
      }
      for (const [path, batch] of this.#groundCoverField.models) this.#placeGroundCover(path, batch, client);
      this.#groundCoverSelected = this.#groundCoverField.total;
      this.#groundCoverSelectionDroppedCells = this.#groundCoverField.cellsDropped;
    } else if (this.#groundCoverPending.size > 0 && this.#groundCoverField) {
      for (const path of [...this.#groundCoverPending]) {
        const batch = this.#groundCoverField.models.get(path);
        if (batch) this.#placeGroundCover(path, batch, client);
      }
    }
  }

  /** One model's share of the field, as a single instanced draw. */
  #placeGroundCover(path: string, batch: GroundCoverBatch, client: EnvironmentClient | undefined): void {
    const model = client?.model(path, "background");
    if (!model?.wvm) {
      // Asked for once by `model()` itself; this only remembers to look again next frame.
      this.#groundCoverPending.add(path);
      return;
    }
    this.#groundCoverPending.delete(path);
    // Neither `instanceable` nor `instanceableBuild` is consulted, and that is deliberate. The
    // first asks about emitters, and 0 of the 484 ground-cover models carries one. The second
    // refuses a blended material because three sorts transparent objects and instances lose their
    // order — true, and not worth a draw call each for the 13 of 484 models that are blend mode 2:
    // a field of grass sorted back to front would be thousands of draws to stop one tuft showing
    // faintly through another.
    // A placed scenery copy of the same M2 must not inherit ground-cover clipping.
    const buildKey = "ground-cover|" + this.#vegetationBuildKey(path);
    const built = this.#wvmBuild(
      this.#builtModels, buildKey, path, model.wvm, undefined, undefined, false, undefined,
      this.#experimentalShaderProfile.vegetationWind, this.#groundCoverFade,
    );
    let entry = this.#groundCoverMeshes.get(path);
    if (!entry || entry.capacity < batch.x.length) {
      this.#dropGroundCoverMesh(path);
      const capacity = instanceCapacity(batch.x.length);
      const mesh = new THREE.InstancedMesh(built.geometry, built.materials, capacity);
      // One sphere over a field that surrounds the camera is no use to anybody, and the field is
      // rebuilt on a step rather than per frame, so there is nothing for culling to save.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Tufts standing in a tree's shadow take it too; they never cast (see #syncSceneryShadows).
      mesh.receiveShadow = this.#sceneryShadowsApplied;
      this.#programWarmup.registerObject(mesh);
      entry = { mesh, capacity, built };
      this.#groundCoverMeshes.set(path, entry);
      this.#groundCoverGroup.add(mesh);
    }
    // Straight into the instance buffer: the same sixteen numbers `groundCoverMatrix` composes,
    // without a `Matrix4` compose and a `setMatrixAt` copy per tuft (1.0 ms against 1.6 ms for
    // 40,000, and no garbage). The capacity check above is what keeps the writer in range.
    entry.mesh.count = writeGroundCoverInstanceMatrices(batch, entry.mesh.instanceMatrix.array as Float32Array);
    entry.mesh.instanceMatrix.needsUpdate = true;
    // `setMatrixAt` does not invalidate it, and three keeps the first one it computed. Nothing
    // culls this mesh (`frustumCulled` is off, for the draw and the shadow pass alike), so the
    // sphere is left for whoever first asks — three computes a null one on demand — rather than
    // walking every tuft on each four-yard rebuild.
    entry.mesh.boundingSphere = null;
  }

  #dropGroundCoverMesh(path: string): void {
    const entry = this.#groundCoverMeshes.get(path);
    if (!entry) return;
    this.#groundCoverGroup.remove(entry.mesh);
    this.#programWarmup.unregisterObject(entry.mesh);
    // The geometry and materials belong to `#builtModels` and are shared with every other copy of
    // the model; only the instance matrix buffer is this mesh's own.
    entry.mesh.dispose();
    this.#groundCoverMeshes.delete(path);
  }

  #clearGroundCover(): void {
    for (const path of [...this.#groundCoverMeshes.keys()]) this.#dropGroundCoverMesh(path);
    this.#groundCoverPending.clear();
    this.#groundCoverField = undefined;
    this.#groundCoverAt = undefined;
    this.#groundCoverCells = createGroundCoverCellCache();
    this.#groundCoverCellsKey = undefined;
    this.#groundCoverSelected = 0;
    this.#groundCoverSelectionDroppedCells = 0;
  }

  /** Takes one model's instanced draw away and shows the placements it was standing in for. */
  #dropInstance(key: string): void {
    const entry = this.#instances.get(key);
    if (!entry) return;
    entry.mesh.removeFromParent();
    this.#programWarmup.unregisterObject(entry.mesh);
    if (entry.localLight) {
      if (entry.built.geometry.getAttribute(MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE)
        === entry.localLight.attribute) {
        entry.built.geometry.deleteAttribute(MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE);
      }
      disposeModelPlacementTintMaterials(entry.localLight.materials);
    }
    // Ordinary geometry/materials belong to the model cache. The matrix buffer and optional local
    // light attribute/material shells belong only to this mesh.
    entry.mesh.dispose();
    this.#instances.delete(key);
  }

  /**
   * Geometry and materials for one WVM5 model in one appearance, cached on the two together
   * because geoset choice and slot resolution both change what is drawn.
   */
  #worldCacheKey(key: string): string {
    return worldResourceCacheKey(this.#worldResourceEpoch, key);
  }

  #builtCacheKey(cache: BuiltModelCache<BuiltModel>, key: string): string {
    return worldBuiltModelCacheKey(
      this.#worldResourceEpoch,
      cache === this.#builtUnits ? "unit" : "model",
      key,
    );
  }

  /** Static and wind materials may share geometry bytes, but never a cached material build. */
  #vegetationBuildKey(path: string): string {
    return this.#experimentalShaderProfile.vegetationWind ? `vegetation-wind|${path}` : path;
  }

  /** Compact exact identity for one decoded legacy parent; cache entries retain only this token. */
  #legacyModelKey(model: EnvironmentModel): string {
    let parentKey = this.#legacyModelKeys.get(model);
    if (!parentKey) {
      this.#legacyModelSerial++;
      parentKey = this.#worldCacheKey(`legacy-parent:${this.#legacyModelSerial}`);
      this.#legacyModelKeys.set(model, parentKey);
    }
    return parentKey;
  }

  #legacyStaticGeometry(model: EnvironmentModel): LegacyGeometryEntry {
    const cacheKey = legacyGeometryCacheKey(this.#legacyModelKey(model), "static");
    let entry = this.#legacyGeometries.get(cacheKey);
    if (entry) return entry;

    const positions = new Float32Array(model.vertices.length);
    for (let index = 0; index < model.vertices.length; index += 3) {
      positions[index] = -model.vertices[index]!;
      positions[index + 1] = model.vertices[index + 2]!;
      positions[index + 2] = model.vertices[index + 1]!;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (model.uvs?.length === model.vertices.length / 3 * 2) {
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(model.uvs, 2));
    }
    geometry.setIndex(model.indices);
    for (const [ordinal, group] of (model.groups ?? []).entries()) {
      geometry.addGroup(group.start, group.count, ordinal);
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    entry = Object.freeze({
      cacheKey,
      epoch: this.#worldResourceEpoch,
      domain: "static" as const,
      geometry,
    });
    this.#legacyGeometries.set(cacheKey, entry);
    return entry;
  }

  #legacySkinnedGeometry(model: EnvironmentModel): LegacyGeometryEntry | undefined {
    if (this.#legacySkinnedFailures.has(model)) return undefined;
    const cacheKey = legacyGeometryCacheKey(this.#legacyModelKey(model), "skinned");
    let entry = this.#legacyGeometries.get(cacheKey);
    if (entry) return entry;
    const template = buildSkinnedTemplate(model);
    if (!template) {
      this.#legacySkinnedFailures.add(model);
      return undefined;
    }
    entry = Object.freeze({
      cacheKey,
      epoch: this.#worldResourceEpoch,
      domain: "skinned" as const,
      geometry: template.geometry,
      template,
    });
    this.#legacyGeometries.set(cacheKey, entry);
    return entry;
  }

  /** One exact material per legacy run, with canonical bases shared with WMO materials by URL. */
  #legacyMaterials(model: EnvironmentModel): {
    readonly entries: readonly WorldMaterialEntry[];
    readonly materials: THREE.Material | THREE.Material[];
  } {
    const parentToken = this.#legacyModelKey(model);
    const sourceUrls = model.textureUrls ?? [model.textureUrl ?? ""];
    const urls = sourceUrls.length > 0 ? sourceUrls : [""];
    const groups = model.groups;
    const runs = groups?.length
      ? groups.map((group, ordinal) => ({
        ordinal,
        materialIndex: group.material,
        url: urls[group.material] ?? "",
        blendMode: group.blendMode ?? 0,
        flags: group.flags ?? 0,
      }))
      : urls.map((url, ordinal) => ({
        ordinal,
        materialIndex: ordinal,
        url,
        blendMode: 0,
        flags: WMO_MATERIAL_UNCULLED,
      }));
    const entries = runs.map((run) => this.#worldMaterials.getOrCreate({
      key: legacyRunMaterialCacheKey(
        parentToken,
        run.ordinal,
        run.materialIndex,
        run.url,
        run.blendMode,
        run.flags,
      ),
      kind: "legacy-run",
      ...(run.url ? { textureUrl: run.url } : {}),
      createMaterial: (texture) => {
        if (texture) {
          configureWmoCanonicalTexture(
            texture,
            this.#anisotropy(),
          );
        }
        const value = new THREE.MeshStandardMaterial({
          color: run.url ? 0xffffff : 0x71845e,
          roughness: 0.92,
          ...(texture ? { map: texture } : {}),
        });
        value.side = (run.flags & WMO_MATERIAL_UNCULLED) !== 0
          ? THREE.DoubleSide
          : THREE.FrontSide;
        applyBlendMode(value, run.blendMode);
        applyWorldLight(value, this.#worldLight, "surface");
        trackWmoWetSurface(value);
        return value;
      },
    }));
    const materials = entries.map((entry) => entry.material);
    return {
      entries: Object.freeze(entries),
      materials: materials.length === 1 ? materials[0]! : materials,
    };
  }

  #wvmBuild(cache: BuiltModelCache<BuiltModel>, key: string, modelPath: string, wvm: WvmModel,
    slots: TextureSlots | undefined, geosets: GeosetChoice | undefined, skinned: boolean,
    slotTextures?: ReadonlyMap<number, THREE.Texture>, vegetationWind = false,
    groundCoverFade?: GroundCoverFadeUniforms): BuiltModel {
    const cacheKey = this.#builtCacheKey(cache, key);
    let built = cache.get(cacheKey);
    if (built) return built;
    built = buildModel(wvm, {
      modelPath,
      baseUrl: this.#baseUrl,
      loadTexture: (url) => this.#loadTexture(url),
      deduplicateLoadedTextures: true,
      coalesceAdjacentBatches: cache === this.#builtUnits,
      ...(slots ? { slots } : {}),
      ...(geosets ? { geosets } : {}),
      ...(slotTextures ? { slotTextures } : {}),
      skinned,
      anisotropy: this.#anisotropy(),
      worldLight: this.#worldLight,
      vegetationWind,
      ...(groundCoverFade ? { groundCoverFade } : {}),
    });
    const externalKeys = cache === this.#builtUnits && slotTextures?.has(TEXTURE_TYPE_BODY)
      ? [key]
      : [];
    cache.set(cacheKey, built, externalKeys);
    return built;
  }

  /**
   * A rig for a piece of scenery, when the model has one and the placement is close enough.
   *
   * Answering `undefined` is the normal case, and it is what leaves the placement on the static
   * path it has always been on. Everything about the alternative is more expensive: a skinned
   * build is a second copy of the geometry with bone weights on it, an instance is a skeleton
   * and a mixer, and neither can join the instanced draw — so this is gated twice, on distance
   * here and on a budget in the pose loop.
   *
   * **The cache key has to be its own.** `#wvmNode` has very likely already put this model into
   * `#builtModels` under its bare path, built with the skinned flag off and therefore with no
   * `skinIndex` attribute on it. Sharing that entry binds a `SkinnedMesh` to geometry with no
   * weights, and three draws it in the bind pose — silently, which is the worst way to be wrong.
   */
  #doodadRig(object: EnvironmentObject, model: EnvironmentModel | undefined, distance: number):
  { node: THREE.Object3D; instance: SkinnedInstance; template: SkinnedTemplate } | undefined {
    const wvm = model?.wvm;
    const rig = wvm?.skeleton;
    if (!wvm || !rig || distance > DOODAD_ANIMATION_RANGE || !animatesAsDoodad(rig)) return undefined;

    const key = `anim|${object.name}`;
    const cacheKey = this.#builtCacheKey(this.#builtModels, key);
    let template = this.#skinnedTemplates.get(cacheKey);
    if (template === undefined) {
      const built = this.#wvmBuild(this.#builtModels, key, object.name, wvm, undefined, undefined, true);
      template = buildSkinnedTemplateFrom(built.geometry, rig, built.height) ?? null;
      this.#skinnedTemplates.set(cacheKey, template);
    }
    if (!template) return undefined;
    const built = this.#wvmBuild(this.#builtModels, key, object.name, wvm, undefined, undefined, true);
    const placementMaterials = object.localLight
      ? createModelPlacementLocalLightMaterials(built.materials, object.localLight)
      : createModelPlacementTintMaterials(built.materials, object.tint);
    const instance = instantiateSkinned(template, placementMaterials ?? built.materials);
    // The tile's frame and not the unit path's, the same half turn `#wvmNode` applies: an animated
    // signpost and the static one beside it have to agree about which way they face.
    instance.root.quaternion.copy(ADT_MODEL_TO_SCENE);
    const node = placeEnvironmentNode(new THREE.Group(), object);
    node.add(instance.root);
    node.userData["builtModel"] = built;
    if (placementMaterials) node.userData["modelPlacementTintMaterials"] = placementMaterials;
    this.#programWarmup.registerObject(node);
    return { node, instance, template };
  }

  #wvmNode(
    name: string,
    wvm: WvmModel,
    tint?: ModelPlacementTint,
    localLight?: ModelPlacementTint,
  ): THREE.Object3D {
    const buildKey = this.#vegetationBuildKey(name);
    const built = this.#wvmBuild(
      this.#builtModels, buildKey, name, wvm, undefined, undefined, false, undefined,
      this.#experimentalShaderProfile.vegetationWind,
    );
    const placementMaterials = localLight
      ? createModelPlacementLocalLightMaterials(built.materials, localLight)
      : createModelPlacementTintMaterials(built.materials, tint);
    const mesh = new THREE.Mesh(built.geometry, placementMaterials ?? built.materials);
    // Not the unit rotation. A doodad is turned by the rotation its tile gives it, and that
    // rotation is already expressed in the frame `VMAP_TO_THREE` converts to — both
    // `mappedVmapRotation` here and `worldDoodad` in the tile generator conjugate by it. A
    // rotation stated in one frame has to act on geometry converted into the same one, so the
    // mesh follows the tile's frame and not the unit path's. The two differ by half a turn about
    // the vertical, which a tree hides and a signpost does not.
    mesh.quaternion.copy(ADT_MODEL_TO_SCENE);
    const node = new THREE.Group();
    node.add(mesh);
    node.userData["visual"] = mesh;
    node.userData["builtModel"] = built;
    if (placementMaterials) node.userData["modelPlacementTintMaterials"] = placementMaterials;
    this.#programWarmup.registerObject(node);
    // The node was drawn on the frame its model was placed, so a doodad or game object with a new
    // material linked its program inside the submission: 48–118 ms frames while running through the
    // open world (live recording 27.09). Held, it appears a frame or two later with nothing to link.
    this.#visualWarmHold.hold(mesh);
    return node;
  }

  /** Whether a doodad or game-object visual can draw without linking or querying a program. */
  #visualProgramsWarm(mesh: THREE.Mesh): boolean {
    const kind = programWarmupKind(mesh);
    if (!kind) return true;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material && !this.#programWarmup.isWarm(material, mesh.geometry, kind)) return false;
    }
    return true;
  }

  /** Whether every emitter mesh of an effect set's group draws with warm programs. */
  #effectProgramsWarm(group: THREE.Object3D): boolean {
    for (const child of group.children) {
      if (child instanceof THREE.Mesh && !this.#visualProgramsWarm(child)) return false;
    }
    return true;
  }

  /**
   * A WWM1 building: an empty node its rooms are hung on as they are needed.
   *
   * Nothing is built here. Which of a model's groups are worth drawing depends on where the player
   * is standing, and for a city that is a handful of the 286 — so the node is placed, every
   * group's box is transformed once into the scene, and the frame loop fills it in.
   */
  #wmoNode(object: EnvironmentObject, model: WmoModel): { node: THREE.Object3D; placed: PlacedWmo } {
    const node = placeEnvironmentNode(new THREE.Group(), object);
    node.updateMatrixWorld(true);
    const modelToWorld = node.matrixWorld.clone().multiply(VMAP_TO_THREE);
    return {
      node,
      placed: {
        visualId: object.id,
        name: object.name,
        model,
        boxes: wmoGroupBoxes(model, object),
        modelToWorld,
        worldToModel: modelToWorld.clone().invert(),
        built: new Map(),
      },
    };
  }

  #wmoModelKey(model: WmoModel): string {
    let parentKey = this.#wmoModelKeys.get(model);
    if (!parentKey) {
      this.#wmoModelSerial++;
      parentKey = this.#worldCacheKey(`wmo-parent:${this.#wmoModelSerial}`);
      this.#wmoModelKeys.set(model, parentKey);
    }
    return parentKey;
  }

  #wmoGroupCacheKey(model: WmoModel, index: number): string {
    return `${this.#wmoModelKey(model)}#${index}`;
  }

  /** Detaches placement-local borrowers without disposing their shared geometry or materials. */
  #clearWmoGroups(placed: PlacedWmo, node: THREE.Object3D): void {
    for (const { mesh } of placed.built.values()) {
      this.#programWarmup.unregisterObject(mesh);
      node.remove(mesh);
    }
    placed.built.clear();
  }

  /** Interior-only placements by visual id; retired by `#updateSkybox` once not updated. */
  readonly #interiorOnlyRooms = new Map<number, InteriorOnlyRooms>();
  /** This frame: the camera stands in a room of an interior-only building, which has no sky. */
  #interiorOnlyCamera = false;
  /** This frame: the baked light of the floor under the player in such a building. */
  #interiorOnlyFloor: [number, number, number] | undefined;
  /** Room light for world-lit models, applied by `updateLighting` from the last frame noting one. */
  #interiorLight: [number, number, number] | undefined;

  #interiorOnlyRoomsOf(placed: PlacedWmo): InteriorOnlyRooms {
    const model = placed.model;
    let rooms = this.#interiorOnlyRooms.get(placed.visualId);
    if (!rooms || rooms.model !== model) {
      if (rooms?.live) interiorOnlyRoomsLive--;
      rooms = {
        model, visible: new Uint8Array(model.groups.length), apertures: new Float32Array(model.groups.length * 4),
        clip: new Float32Array(16), clipped: false, live: false, serial: -1,
      };
      this.#interiorOnlyRooms.set(placed.visualId, rooms);
    }
    return rooms;
  }

  /**
   * Whether the camera or the player stands in a room of a building of rooms alone; leaves both
   * points in model space for the portal walk. Seen from outside, such a building keeps the room
   * leash and its doodads their distance one: with no room to start from the portal walk returns
   * every candidate, so a far leash there would draw all its rooms and furniture behind the walls.
   */
  #enteredInteriorOnly(placed: PlacedWmo, player: WorldPosition): boolean {
    const camera = this.#wmoCameraModel.copy(this.#camera.position).applyMatrix4(placed.worldToModel);
    const feet = this.#wmoViewerModel.set(player.x, player.z, -player.y).applyMatrix4(placed.worldToModel);
    return wmoInteriorGroupAt(placed.model, camera.x, camera.y, camera.z) >= 0
      || wmoInteriorGroupAt(placed.model, feet.x, feet.y, feet.z) >= 0;
  }

  /** The rooms of an entered interior-only building on the far leash, cached per player position. */
  #interiorOnlyRange(placed: PlacedWmo, player: WorldPosition): readonly number[] {
    const rooms = this.#interiorOnlyRoomsOf(placed);
    const at = rooms.farAt;
    if (!rooms.far || !at || at.x !== player.x || at.y !== player.y || at.z !== player.z) {
      rooms.far = wmoGroupsInRange(placed.model, placed.boxes, player, INTERIOR_ONLY_RANGE);
      rooms.farAt = { x: player.x, y: player.y, z: player.z };
    }
    return rooms.far;
  }

  /**
   * One entered interior-only building's frame: which rooms show and therefore which of its
   * doodads, whether the camera stands in a room, and the baked light of the floor under the player.
   *
   * The doodads are bound once per environment snapshot. `generate-visual-tile.mjs` ids them
   * -(placement * 1e6 + ordinal + 1), and the ordinal indexes WME4's table of the placement's set;
   * binding changes their leash, so the distance pass is asked to run again. `clipped` says the
   * rooms came through portals, whose screen rectangles were written into `rooms.apertures`.
   */
  #noteInteriorOnly(placed: PlacedWmo, player: WorldPosition, selected: readonly number[], clipped: boolean): void {
    const model = placed.model;
    const rooms = this.#interiorOnlyRoomsOf(placed);
    rooms.visible.fill(0);
    for (const index of selected) rooms.visible[index] = 1;
    rooms.clipped = clipped;
    // The same frame's camera as the portal walk: `#updateEnvironment` set it before admission.
    if (clipped) rooms.clip.set(this.#frustumMatrix.elements);
    rooms.serial = this.#submissionSerial;
    if (!rooms.live) {
      rooms.live = true;
      interiorOnlyRoomsLive++;
    }
    rooms.sphereOf ??= (object) => {
      const rendered = this.#environment.get(object.id);
      return rendered?.source === object ? rendered.visibilitySphere : this.#environmentVisibilitySpheres.get(object);
    };
    const objects = this.#environmentObjects;
    if (objects && rooms.bound !== objects) {
      rooms.bound = objects;
      const tables = model.doodadRooms ?? [];
      const table = tables[this.#environment.get(placed.visualId)?.source.doodadSet ?? 0] ?? tables[0];
      if (table) {
        for (const object of objects) {
          if (object.interior !== true || object.id >= 0) continue;
          const code = -object.id - 1;
          const parent = Math.floor(code / 1_000_000);
          if (parent !== placed.visualId) continue;
          INTERIOR_ONLY_DOODADS.set(object, { rooms, table, ordinal: code - parent * 1_000_000, at: -1, shown: undefined });
        }
      }
      this.#environmentCandidatesAt = undefined;
    }
    const camera = this.#wmoCameraModel;
    if (wmoInteriorGroupAt(model, camera.x, camera.y, camera.z) >= 0) this.#interiorOnlyCamera = true;
    const feet = this.#wmoViewerModel.set(player.x, player.z, -player.y).applyMatrix4(placed.worldToModel);
    const at = rooms.floorAt;
    if (!at || at.x !== feet.x || at.y !== feet.y || at.z !== feet.z) {
      rooms.floorAt = { x: feet.x, y: feet.y, z: feet.z };
      // A jump or a doodad bridge can lose the floor for a frame; inside a room keep the last one.
      const floor = wmoFloorLight(model, feet.x, feet.y, feet.z);
      if (floor || wmoInteriorGroupAt(model, feet.x, feet.y, feet.z) < 0) rooms.floor = floor;
    }
    if (rooms.floor) this.#interiorOnlyFloor = rooms.floor;
  }

  /** Builds and attaches only the rooms in the final distance/portal demand. */
  #updateWmoGroups(
    placed: PlacedWmo,
    player: WorldPosition,
    node: THREE.Object3D,
    client: EnvironmentClient | undefined,
    staticEnvironment = false,
  ): void {
    // Same inputs, same set: the player standing still re-asks the identical question for every
    // admitted building sixty times a second.
    let distanceGroups = placed.rangeGroups;
    if (distanceGroups === undefined
      || placed.rangePlayer?.x !== player.x
      || placed.rangePlayer?.y !== player.y
      || placed.rangePlayer?.z !== player.z) {
      distanceGroups = wmoGroupsInRange(placed.model, placed.boxes, player);
      placed.rangePlayer = { x: player.x, y: player.y, z: player.z };
      placed.rangeGroups = distanceGroups;
    }
    const fogPlacement = staticEnvironment && placed.visualId === this.#wmoFogVisualId;
    // A building of rooms alone that the camera or the player has entered is chosen through its
    // portals from the far leash (a dungeon's halls outrun sixty yards); seen from outside it keeps
    // the room leash like any other building.
    const entered = staticEnvironment && wmoInteriorOnly(placed.model) && this.#enteredInteriorOnly(placed, player);
    const roomLeash = distanceGroups;
    if (entered) distanceGroups = this.#interiorOnlyRange(placed, player);
    let selected: readonly number[] = distanceGroups;
    let clipped = false;
    if (fogPlacement || (staticEnvironment && this.#indoors) || entered) {
      this.#wmoCameraModel.copy(this.#camera.position).applyMatrix4(placed.worldToModel);
      if (fogPlacement) this.#considerWmoFog(placed, this.#wmoCameraModel);
      if (staticEnvironment && (this.#indoors || entered) && this.#wmoOcclusion && placed.model.portals) {
        this.#wmoViewerModel.set(player.x, player.z, -player.y).applyMatrix4(placed.worldToModel);
        this.#wmoModelToClip
          .multiplyMatrices(this.#camera.matrixWorldInverse, placed.modelToWorld)
          .premultiply(this.#camera.projectionMatrix);
        const portalSelection = selectWmoPortalGroups(
          placed.model.groups,
          placed.model.portals,
          distanceGroups,
          this.#wmoCameraModel,
          this.#wmoModelToClip.elements,
          this.#wmoViewerModel,
          entered ? this.#interiorOnlyRoomsOf(placed).apertures : undefined,
        );
        if (portalSelection.used) {
          selected = portalSelection.groups;
          clipped = entered;
          this.#wmoPortalModels++;
          this.#wmoPortalCandidates += portalSelection.candidates;
          this.#wmoPortalCulled += portalSelection.culled;
        }
      }
    }
    // The far leash stands on the portal walk. Without one — WMO occlusion switched off, or a camera
    // in no room — the building keeps the sixty-yard rooms rather than every room in 400 yards.
    if (entered && !clipped) selected = roomLeash;
    if (entered) this.#noteInteriorOnly(placed, player, selected, clipped);
    const wanted = new Set(selected);
    const missing: number[] = [];
    // Room builds (geometry compose, material setup, uploads) are the building-shaped turn
    // hitch: a newly admitted castle can want dozens of rooms on one frame. Build at most a
    // few per submitted frame across every admitted building — shells first, because they are
    // the skyline — and let the rest wait: `placed.built` persists, so a skipped room is simply
    // attached on a later frame. Detaches below are never capped: hiding is cheap and exact.
    if (this.#wmoGroupBuildSerial !== this.#submissionSerial) {
      this.#wmoGroupBuildSerial = this.#submissionSerial;
      this.#wmoGroupBuilds = 0;
      this.#wmoGroupBuildBudget.begin();
    }
    const buildable: number[] = [];
    for (const [index, group] of placed.model.groups.entries()) {
      const built = placed.built.get(index);
      if (!wanted.has(index)) {
        if (built) {
          this.#programWarmup.unregisterObject(built.mesh);
          node.remove(built.mesh);
          placed.built.delete(index);
        }
        continue;
      }
      if (built) {
        const retained = this.#wmoGeometries.get(this.#wmoGroupCacheKey(placed.model, index));
        if (retained === built.entry) continue;
        // A wrapper may never outlive its exact cache entry or decoded parent.
        this.#programWarmup.unregisterObject(built.mesh);
        node.remove(built.mesh);
        placed.built.delete(index);
      }
      if (!group.mesh) {
        missing.push(index);
        continue;
      }
      this.#wmoGeometryBuild.retain(this.#wmoGroupCacheKey(placed.model, index), group.mesh, this.#submissionSerial);
      buildable.push(index);
    }
    const shellFirst = (left: number, right: number): number => {
      const leftGroup = placed.model.groups[left]!;
      const rightGroup = placed.model.groups[right]!;
      const leftShell = leftGroup.exterior || !leftGroup.indoor ? 0 : 1;
      const rightShell = rightGroup.exterior || !rightGroup.indoor ? 0 : 1;
      return leftShell - rightShell || left - right;
    };
    // Even two rooms can exceed the elapsed slice; always put the visible shell first.
    if (buildable.length > 1) buildable.sort(shellFirst);
    let attached = 0;
    for (const index of buildable) {
      if (this.#wmoGroupBuilds >= WMO_GROUP_BUILD_BUDGET) break;
      const rendered = this.#wmoGroupMesh(placed.model, index);
      if (!rendered) continue;
      this.#wmoGroupBuilds++;
      attached++;
      placed.built.set(index, rendered);
      node.add(rendered.mesh);
      this.#holdWmoGroupUntilWarm(rendered.mesh);
    }
    this.#wmoGroupsPending += buildable.length - attached;
    // A model that came whole has nothing to ask for, and asking would be a request per frame.
    if (missing.length > 0 && !placed.model.complete) client?.requestModelGroups(placed.name, missing);
  }

  /** Keep the one collision-proven room answer; render order and asynchronous meshes do not vote. */
  #considerWmoFog(placed: PlacedWmo, camera: THREE.Vector3): void {
    const floor = this.#wmoFloor;
    if (!floor || placed.visualId !== this.#wmoFogVisualId) return;
    const fog = locatedWmoFog(placed.model, floor, camera);
    if (!fog) return;
    const key = `${floor.placement.key}#${floor.groupId}:${floor.groupIndex}`;
    const current = this.#wmoFogCandidate;
    if (!current || key < current.key) this.#wmoFogCandidate = { fog, key };
  }

  /** Apply the one room chosen above only to interior WMO materials; outdoor fog stays intact. */
  #applyWmoFogCandidate(): void {
    const candidate = this.#wmoFogCandidate;
    if (this.#underwater || !candidate) return;
    const { end, scale, colour } = candidate.fog.land;
    this.#wmoInteriorFog.colour.value.setRGB(
      colour[0] / 255,
      colour[1] / 255,
      colour[2] / 255,
      THREE.SRGBColorSpace,
    );
    this.#wmoInteriorFog.near.value = end * scale;
    this.#wmoInteriorFog.far.value = end;
  }

  /**
   * Keeps a room just attached out of both passes until its run materials have linked programs.
   *
   * A room's materials are registered with the warm pass when it is built, and it used to be drawn
   * on that same frame, so the driver linked every new program inside the submission: on the
   * movement route two interior-fog runs of one room cost a 48 ms frame. Held, the room appears a
   * frame or two later with nothing to link. It is shown after WMO_WARM_HOLD_FRAMES regardless,
   * which is the old first-draw cost, never a room that stays missing.
   */
  #holdWmoGroupUntilWarm(mesh: THREE.Mesh): void {
    if (this.#wmoGroupProgramsReady(mesh)) return;
    mesh.visible = false;
    this.#wmoWarmHolds.set(mesh, 0);
  }

  /** After the warm pass: shows every held room whose programs are ready or whose wait is over. */
  #releaseWarmWmoGroups(): void {
    for (const [mesh, frames] of this.#wmoWarmHolds) {
      if (!mesh.parent) {
        // Detached while waiting: whatever attaches it again holds it again.
        mesh.visible = true;
        this.#wmoWarmHolds.delete(mesh);
      } else if (frames >= WMO_WARM_HOLD_FRAMES || this.#wmoGroupProgramsReady(mesh)) {
        mesh.visible = true;
        this.#wmoWarmHolds.delete(mesh);
      } else {
        this.#wmoWarmHolds.set(mesh, frames + 1);
      }
    }
    // A held room is a room not yet on screen: readiness waits for it like for one not yet built.
    this.#wmoGroupsPending += this.#wmoWarmHolds.size;
  }

  #wmoGroupProgramsReady(mesh: THREE.Mesh): boolean {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!this.#programWarmup.isLinked(material, mesh.geometry, "mesh")) return false;
    }
    return true;
  }

  /** One room's mesh: its geometry converted into the scene, its light computed, its runs split. */
  #wmoGroupMesh(model: WmoModel, index: number): RenderedWmoGroup | undefined {
    const group = model.groups[index];
    const source = group?.mesh;
    if (!group || !source) return undefined;
    const cacheKey = this.#wmoGroupCacheKey(model, index);
    let entry = this.#wmoGeometries.get(cacheKey);
    if (!entry) {
      const geometry = this.#wmoGeometryBuild.request(cacheKey, model, index, this.#submissionSerial);
      if (!geometry) return undefined;
      entry = Object.freeze({
        cacheKey,
        epoch: this.#worldResourceEpoch,
        groupIndex: index,
        geometry,
      });
      this.#wmoGeometries.set(cacheKey, entry);
    }
    if (!this.#wmoGroupBuildBudget.take()) {
      this.#wmoPreparedGeometryPins.add(entry);
      return undefined;
    }
    const runEntries = source.runs.map((run) => this.#wmoRunMaterial(model, group, run));
    const materialEntries = Object.freeze([...new Set(runEntries)]);
    const materials = runEntries.map((materialEntry) => materialEntry.material);
    const mesh = new THREE.Mesh(entry.geometry, materials.length === 1 ? materials[0]! : materials);
    this.#programWarmup.registerObject(mesh);
    return { entry, materialEntries, mesh };
  }

  /**
   * The material for one run: a texture, the state the artist drew it with, and its light.
   *
   * An interior run is unlit and multiplied by the light computed for its vertices, because that
   * light is the whole of what the room has — the sun is outside it, and shading a candle-lit
   * cellar with the sky would be a second sun in a windowless room. An exterior run is lit by the
   * scene like everything else standing in the open.
   *
   * Which of the two a run is takes the group as well as the batch — see {@link wmoRunIsInterior}.
   * Nothing here reads the baked colours on an exterior run, and after the group joined the rule
   * that is no longer because they are white: of the 138,396 vertices reached by interior batches
   * inside Dalaran's non-indoor groups, 67.1% are pure black, and 92.8% of Stormwind's 50,336.
   * `vertexColors` therefore stays off on this branch, and turning it on would be a second bug and
   * not a nicety: the group has one `color` attribute, computed once for the whole group by the
   * interior formula above, so a street would be shaded with the light of the cellar beneath it.
   */
  #wmoRunMaterial(
    model: WmoModel,
    group: WmoGroup,
    run: WmoRun,
  ): WorldMaterialEntry {
    const interior = wmoRunIsInterior(group, run);
    const url = model.textureUrls[run.material] ?? "";
    const key = wmoRunMaterialCacheKey(
      this.#wmoModelKey(model),
      run.material,
      url,
      run.blendMode,
      run.materialFlags,
      interior,
    );
    return this.#worldMaterials.getOrCreate({
      key,
      kind: "wmo-run",
      ...(url ? { textureUrl: url } : {}),
      createMaterial: (texture) => {
        if (texture) {
          configureWmoCanonicalTexture(
            texture,
            this.#anisotropy(),
          );
        }
        const value = interior
          ? new THREE.MeshBasicMaterial({
            color: url ? 0xffffff : 0x71845e,
            vertexColors: true,
            ...(texture ? { map: texture } : {}),
          })
          : new THREE.MeshStandardMaterial({
            color: url ? 0xffffff : 0x71845e,
            roughness: 0.92,
            ...(texture ? { map: texture } : {}),
          });
        value.side = (run.materialFlags & WMO_MATERIAL_UNCULLED) !== 0
          ? THREE.DoubleSide
          : THREE.FrontSide;
        applyBlendMode(value, run.blendMode);
        if (value instanceof THREE.MeshBasicMaterial) {
          applyWmoInteriorFog(value, this.#wmoInteriorFog);
        } else if (value instanceof THREE.MeshStandardMaterial) {
          applyWorldLight(value, this.#worldLight, "surface");
          trackWmoWetSurface(value);
        }
        return value;
      },
    });
  }

  #modelNode(object: EnvironmentObject, model: EnvironmentModel): THREE.Object3D {
    // A WVM5 model carries its own materials: blend modes, two-sidedness, wrap flags and the draw
    // order the client uses. Building from those is what turns a doodad from one flat
    // double-sided cut-out into the surfaces the artist authored.
    if (model.wvm) {
      return placeEnvironmentNode(
        this.#wvmNode(object.name, model.wvm, object.tint, object.localLight),
        object,
      );
    }
    const entry = this.#legacyStaticGeometry(model);
    const { entries: materialEntries, materials } = this.#legacyMaterials(model);
    const mesh = new THREE.Mesh(entry.geometry, materials);
    let node: THREE.Object3D = mesh;
    if (!model.visual && /tree|oak|pine|willow|bush|shrub/i.test(object.name)) {
      entry.geometry.computeBoundingBox();
      const bounds = entry.geometry.boundingBox;
      if (bounds) {
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const canopy = new THREE.Mesh(this.#foliageGeometry, this.#foliageMaterial);
        canopy.position.set(center.x, bounds.max.y - size.y * 0.23, center.z);
        canopy.scale.set(Math.max(1, size.x * 0.62), Math.max(1, size.y * 0.28), Math.max(1, size.z * 0.62));
        const group = new THREE.Group();
        group.add(mesh, canopy);
        node = group;
      }
    }
    node.userData["legacyGeometry"] = entry;
    node.userData["worldMaterialEntries"] = materialEntries;
    this.#programWarmup.registerObject(node);
    return placeEnvironmentNode(node, object);
  }

  /** Clears every part of the proof used to cull a retained static game object. */
  #clearGameObjectAdmissionTrust(rendered: RenderedGameObject): void {
    delete rendered.admissionDisplayId;
    delete rendered.admissionScale;
    delete rendered.admissionEntry;
    delete rendered.admissionMetadataRevision;
  }

  /**
   * Reconciles retained bounds with a changed metadata cache before visibility classification.
   *
   * The lookup passed here is cache-only in both live callers. It runs only when that cache's
   * revision changes, outside the candidate pass, and never asks the model scheduler for work.
   */
  #refreshGameObjectAdmissionTrust(
    metadata: ((displayId: number) => GameObjectDisplayMetadata | undefined) | undefined,
    metadataRevision: number | undefined,
  ): void {
    const revision = typeof metadataRevision === "number"
      && Number.isSafeInteger(metadataRevision) && metadataRevision >= 0
      ? metadataRevision
      : undefined;
    if (revision === undefined) {
      if (this.#gameObjectMetadataRevision === undefined) return;
      this.#gameObjectMetadataRevision = undefined;
      for (const rendered of this.#gameObjects.values()) this.#clearGameObjectAdmissionTrust(rendered);
      return;
    }
    if (revision === this.#gameObjectMetadataRevision) return;
    this.#gameObjectMetadataRevision = revision;
    for (const rendered of this.#gameObjects.values()) {
      const modelName = rendered.admissionDisplayId === undefined
        ? undefined
        : metadata?.(rendered.admissionDisplayId)?.model;
      if (modelName !== undefined && modelName === rendered.model) {
        rendered.admissionMetadataRevision = revision;
      } else {
        this.#clearGameObjectAdmissionTrust(rendered);
      }
    }
  }

  /** A trustworthy current static WVM silhouette, or undefined to fail open. */
  #gameObjectVisibilityRadius(
    object: WorldObjectState,
    rendered: RenderedGameObject | undefined,
  ): number | undefined {
    if (!rendered || !rendered.actual
      || rendered.wmo || rendered.decodedModel || rendered.legacyGeometry
      || rendered.skinned || !rendered.wvm || !rendered.built) return undefined;
    if (this.#gameObjectMetadataRevision === undefined
      || rendered.admissionMetadataRevision !== this.#gameObjectMetadataRevision) return undefined;
    if (!Array.isArray(rendered.wvm.particleEmitters) || !Array.isArray(rendered.wvm.ribbonEmitters)
      || rendered.wvm.particleEmitters.length > 0 || rendered.wvm.ribbonEmitters.length > 0) return undefined;
    if (gameObjectWireIsMovingTransport(object)) return undefined;

    const bytes = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset);
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0xffffffff)) {
      return undefined;
    }
    const displayId = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset) ?? 0;
    const entry = gameObjectEntry(object);
    const scale = gameObjectScale(object);
    if (!Number.isSafeInteger(displayId) || displayId < 0
      || entry === undefined || scale === undefined) return undefined;
    if (rendered.admissionDisplayId !== displayId || rendered.admissionScale !== scale
      || rendered.admissionEntry !== entry) return undefined;

    const bounds = rendered.wvm.bounds;
    const min = bounds?.min;
    const max = bounds?.max;
    const headerRadius = bounds?.radius;
    if (!min || !max || min.length !== 3 || max.length !== 3
      || !Number.isFinite(min[0]) || !Number.isFinite(min[1]) || !Number.isFinite(min[2])
      || !Number.isFinite(max[0]) || !Number.isFinite(max[1]) || !Number.isFinite(max[2])
      || !Number.isFinite(headerRadius) || headerRadius < 0
      || min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return undefined;
    const centerX = (min[0] + max[0]) / 2;
    const centerY = (min[1] + max[1]) / 2;
    const centerZ = (min[2] + max[2]) / 2;
    const halfRadius = Math.hypot(
      (max[0] - min[0]) / 2,
      (max[1] - min[1]) / 2,
      (max[2] - min[2]) / 2,
    );
    if (!Number.isFinite(halfRadius)) return undefined;
    const authored = conservativeGameObjectVisibilityRadiusValues(
      centerX, centerY, centerZ, Math.max(headerRadius, halfRadius), scale);
    const sphere = rendered.built.geometry.boundingSphere;
    if (!sphere) return undefined;
    const measured = conservativeGameObjectVisibilityRadiusValues(
      sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius, scale);
    if (authored === undefined || measured === undefined) return undefined;
    return Math.max(authored, measured);
  }

  /**
   * The doors, chests, levers and lifts around the player: built once, read every frame.
   *
   * Everything above this line in the file draws scenery, which is placed and then left alone.
   * These are the server's own objects and none of that holds: the state byte says whether a door
   * is open and changes while it is watched, a lift is somewhere different every frame, and a
   * custom animation can arrive for any of them at any time. The whole pass used to sit inside
   * "have we built this yet", which is why a door that opened stayed shut until the player walked
   * away and back.
   */
  #updateGameObjects(
    state: WorldState,
    player: WorldPosition,
    client: EnvironmentClient | undefined,
    metadata: ((displayId: number) => GameObjectDisplayMetadata | undefined) | undefined,
    metadataRevision: number | undefined,
    paths: TransportPathClient | undefined,
    now: number,
    elapsed: number,
  ): void {
    this.#gameObjectBuildBudget.begin();
    // A cache revision may remap an already-retained display id. Revalidate those rare changes
    // before the candidate pass so an old off-screen WVM cannot cull the request for its replacement.
    this.#refreshGameObjectAdmissionTrust(metadata, metadataRevision);

    // Compose the camera before the budget. Static WVM silhouettes can be culled without touching
    // metadata, model, image, transport-path or any other resource-triggering lookup.
    this.#frustumMatrix.multiplyMatrices(this.#camera.projectionMatrix, this.#camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#frustumMatrix);

    // The target and the focus bypass visibility, but only after the ordinary distance resident
    // range has accepted them. A clicked chest must not vanish behind a nearer crowd, while a stale
    // target far outside the resident range must not keep its model warm forever.
    const pinned = new Set<bigint>();
    if (this.#selection.target) pinned.add(this.#selection.target.guid);
    if (this.#selection.focus) pinned.add(this.#selection.focus.guid);

    const candidates: UnitAdmissionCandidate<WorldObjectState>[] = [];
    for (const object of state.objects.values()) {
      if (object.typeId !== 5 || !object.position) continue;
      const distance = hypot2(object.position.x - player.x, object.position.y - player.y);
      if (distance > GAMEOBJECT_RANGE) continue;
      const isPinned = pinned.has(object.guid);
      const radius = this.#gameObjectVisibilityRadius(object, this.#gameObjects.get(object.guid));
      const visible = isPinned || radius === undefined || unitSphereVisibleInFrustum(
        object.position.x,
        object.position.z,
        -object.position.y,
        radius,
        this.#frustum.planes,
        GAMEOBJECT_FRUSTUM_MARGIN,
      );
      candidates.push({
        value: object,
        distance: Number.isFinite(distance) ? distance : Number.MAX_VALUE,
        pinned: isPinned,
        visible,
      });
    }
    const admission = selectGameObjectAdmission(candidates, GAMEOBJECT_BUDGET);
    this.#gameObjectsDropped = admission.dropped;
    this.#gameObjectsDrawn = admission.admitted.length;
    // In range and over the budget are two different things, exactly as they are for units. The
    // latter keeps the object's rig, model and animation state, but its WMO room meshes are
    // detached below because an invisible object has no live group-geometry demand.
    const inRange = new Set(candidates.map(({ value }) => value.guid));

    const drawn = new Set<bigint>();
    for (const { value: object } of admission.admitted) {
      drawn.add(object.guid);
      const position = object.position!;
      const displayId = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset) ?? 0;
      const modelName = metadata?.(displayId)?.model;
      const model = modelName ? client?.model(modelName, "normal") : undefined;
      let rendered = this.#gameObjects.get(object.guid);
      const replacesWmo = rendered !== undefined && model !== undefined
        && (rendered.wmo !== undefined || model.wmo !== undefined)
        && rendered.wmo?.model !== model.wmo;
      const replacesLegacy = rendered !== undefined && legacyDecodedModelReplaced(
        rendered.decodedModel,
        rendered.legacyGeometry !== undefined,
        model,
      );
      const replacesModel = rendered !== undefined && model !== undefined && modelName !== undefined
        && rendered.model !== modelName;
      const replacesWvm = rendered !== undefined && model?.wvm !== undefined
        && rendered.wvm !== undefined && rendered.wvm !== model.wvm;
      let replacementDeferred = rendered !== undefined && (replacesWmo || replacesLegacy || replacesModel || replacesWvm);
      if ((!rendered || (!rendered.actual && model && modelName)
        || replacesWmo || replacesLegacy || replacesModel || replacesWvm)
        && this.#gameObjectBuildBudget.take()) {
        // A display swap mid-life keeps the spawn stamp so a door that changes state does not
        // fade twice; a first model arrival starts unstamped and eases in below.
        const admittedAt = rendered?.admittedAt;
        if (rendered) {
          this.#disposeGameObject(rendered);
          this.#dropEffects(`obj:${object.guid}`);
        }
        const environmentObject: EnvironmentObject = {
          id: Number(object.guid & 0xffffffffn),
          kind: modelName?.toLowerCase().endsWith(".wmo") ? "wmo" : "m2",
          name: modelName ?? `gameobject-${displayId}`,
          x: position.x,
          y: position.y,
          z: position.z,
          rotationX: 0,
          rotationY: THREE.MathUtils.radToDeg(position.orientation),
          rotationZ: 0,
          // The server's own scale, which used to be the literal 1. A mailbox and the Dark Portal
          // are the same model at different sizes on more objects than one would expect.
          scale: clampSize(fieldFloat(object, UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset), 1, 0.05, 40),
        };
        rendered = this.#buildGameObject(environmentObject, object, model, modelName);
        replacementDeferred = false;
        if (admittedAt !== undefined) rendered.admittedAt = admittedAt;
        this.#gameObjects.set(object.guid, rendered);
        this.#gameObjectGroup.add(rendered.node);
      }

      // A deferred replacement keeps its current body and transform updates. A first sight
      // has no node yet; its authoritative world state stays available to the next frame.
      if (!rendered) continue;
      rendered.node.visible = true;
      this.#placeGameObject(rendered, object, position, paths, now);
      // A new display/scale is trusted only after metadata and the model response prove that the
      // retained WVM is the one now on the wire. `#placeGameObject` applies the current scale first
      // so a changed scale can never stamp old geometry as current.
      this.#stampGameObjectAdmission(rendered, object, modelName, model);
      // A building-shaped game object — a portcullis, a gunship — is drawn a room at a time like
      // any other WMO, and asks for the rooms it needs as it comes into range.
      if (rendered.wmo) {
        if (model?.wmo === rendered.wmo.model) {
          this.#updateWmoGroups(rendered.wmo, player, rendered.node, client);
        } else if (!replacementDeferred) {
          this.#clearWmoGroups(rendered.wmo, rendered.node);
        }
      }
      // Fresh doors and chests ease in over the spawn window like units instead of popping with
      // their model. The stamp is set on first drawable content, not on record creation, so a
      // model that lands seconds later still fades.
      if (rendered.admittedAt === undefined
        && this.#gameObjectFadeMeshes(rendered).length > 0) {
        rendered.admittedAt = now;
      }
      this.#applyGameObjectOpacity(rendered, now);
      // Posing costs a mixer step and a bone upload. A door swinging behind the camera still has
      // to be placed — it is where it is — but it does not have to be animated.
      //
      // The test is against the skinned mesh and never against `rendered.node`, and that is not a
      // preference. `Frustum.intersectsObject` reads `object.geometry.boundingSphere` for anything
      // without a `boundingSphere` of its own, and every game-object node is a `THREE.Group` — no
      // geometry, so the read throws. It threw inside `draw`, `draw` is one call inside a frame
      // wrapped in a single `try`, and `updateLoadingScreen` runs *after* it: one invisible
      // TypeError per frame left the world unrendered behind a loading screen that never lifted.
      //
      // An object with no rig has nothing to cull anyway — `#poseGameObject` only remembers its
      // state byte and returns — so it is cheaper to pose it than to work out whether to.
      if (rendered.skinned) {
        // Frustum.intersectsObject applies the local sphere through matrixWorld. A warm-hidden
        // transport may have moved since its last submitted frame, so refresh the newly applied
        // placement before deciding whether its rig is worth posing on this same frame.
        rendered.skinned.mesh.updateWorldMatrix(true, false);
      }
      if (rendered.skinned === undefined || this.#frustum.intersectsObject(rendered.skinned.mesh)) {
        this.#poseGameObject(rendered, object, client, now, elapsed);
      }
    }
    // Budget-dormant objects keep their cheap outer state, but WMO rooms cease to be live borrowers.
    for (const [guid, rendered] of this.#gameObjects) {
      if (inRange.has(guid) && !drawn.has(guid)) {
        if (rendered.wmo) this.#clearWmoGroups(rendered.wmo, rendered.node);
        rendered.node.visible = false;
      }
    }
    for (const [guid, rendered] of this.#gameObjects) {
      if (inRange.has(guid)) continue;
      this.#disposeGameObject(rendered);
      this.#gameObjects.delete(guid);
      this.#gameObjectAnimations.delete(guid);
      this.#dropEffects(`obj:${guid}`);
    }
  }

  /** Records the exact wire identity for which a retained static WVM measurement is current. */
  #stampGameObjectAdmission(
    rendered: RenderedGameObject,
    object: WorldObjectState,
    modelName: string | undefined,
    model: EnvironmentModel | undefined,
  ): void {
    if (!modelName || !model || rendered.model !== modelName
      || this.#gameObjectMetadataRevision === undefined) {
      this.#clearGameObjectAdmissionTrust(rendered);
      return;
    }
    const displayId = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset) ?? 0;
    const entry = gameObjectEntry(object);
    const scale = gameObjectScale(object);
    if (!Number.isSafeInteger(displayId) || displayId < 0 || entry === undefined || scale === undefined) {
      this.#clearGameObjectAdmissionTrust(rendered);
      return;
    }
    rendered.admissionDisplayId = displayId;
    rendered.admissionEntry = entry;
    rendered.admissionScale = scale;
    rendered.admissionMetadataRevision = this.#gameObjectMetadataRevision;
  }

  /** Releases one live game-object rig while preserving its shared geometry and materials. */
  #disposeGameObject(rendered: RenderedGameObject): void {
    this.#programWarmup.unregisterObject(rendered.node);
    if (rendered.opacityBorrows) {
      returnBorrowedMaterials(rendered.opacityBorrows);
      delete rendered.opacityBorrows;
    }
    disposeSkinnedInstance(rendered.skinned);
    rendered.skinned = undefined;
    rendered.template = undefined;
    rendered.action = undefined;
    if (rendered.wmo) this.#clearWmoGroups(rendered.wmo, rendered.node);
    this.#gameObjectGroup.remove(rendered.node);
  }

  /** One game object's node, rigged when the model has something a door could play. */
  #buildGameObject(
    placement: EnvironmentObject,
    object: WorldObjectState,
    model: EnvironmentModel | undefined,
    modelName: string | undefined,
  ): RenderedGameObject {
    const rendered: RenderedGameObject = {
      actual: Boolean(model),
      node: new THREE.Group(),
      skinned: undefined,
      template: undefined,
      action: undefined,
      animationId: -1,
      overlayUntil: 0,
      entry: object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0,
      base: { x: placement.x, y: placement.y, z: placement.z, orientation: THREE.MathUtils.degToRad(placement.rotationY) },
    };
    if (modelName) rendered.model = modelName;
    if (model && model.wvm === undefined && model.wmo === undefined) {
      rendered.decodedModel = model;
    }

    if (model?.wmo) {
      const building = this.#wmoNode(placement, model.wmo);
      rendered.node = building.node;
      rendered.wmo = building.placed;
      return rendered;
    }
    if (model?.wvm) rendered.wvm = model.wvm;

    // A rig only where there is something to play with it. 18,385 of the client's 22,112 readable
    // game object models declare nothing but Stand, and building a skinned mesh for each of those
    // would pay for a mixer, a skeleton and a per-bone upload to hold a crate still.
    const rig = model?.wvm?.skeleton;
    if (model?.wvm && rig && modelName && animatesAsGameObject(new Set(rig.animations))) {
      // `go|`, never the bare path: `#wvmBuild` caches on the key alone, and the doodad path has
      // already put this model in the same cache with no skin weights at all. Sharing that entry
      // binds a SkinnedMesh to geometry with no `skinIndex`, which three draws in the bind pose
      // without complaining — a door that never opens and never says why.
      const key = `go|${modelName}`;
      const cacheKey = this.#builtCacheKey(this.#builtModels, key);
      const built = this.#wvmBuild(this.#builtModels, key, modelName, model.wvm, undefined, undefined, true);
      let template = this.#skinnedTemplates.get(cacheKey);
      if (template === undefined) {
        template = buildSkinnedTemplateFrom(built.geometry, rig, built.height) ?? null;
        this.#skinnedTemplates.set(cacheKey, template);
      }
      if (template) {
        const instance = instantiateSkinned(template, built.materials);
        // The tile's frame, not the unit path's: a game object is turned by the same conversion a
        // doodad is, and the two differ by half a turn about the vertical. Whatever that half turn
        // is worth, an animated door and the static door beside it must agree about it.
        instance.root.quaternion.copy(ADT_MODEL_TO_SCENE);
        rendered.node = placeEnvironmentNode(new THREE.Group(), placement);
        rendered.node.add(instance.root);
        this.#programWarmup.registerObject(instance.root);
        rendered.skinned = instance;
        rendered.template = template;
        rendered.built = built;
        return rendered;
      }
    }

    // No art, no shape — and this is the one place in the renderer where that is the right answer.
    //
    // A tree coming into range gets a stand-in because it is on its way to being a tree. A game
    // object is not: either its display row named a model and the model resolved, or what came
    // back was the server's own collision hull, which has no textures, no groups and no faces
    // worth looking at. Drawn through the legacy material path those become a flat grey box, and
    // 261 of the 739 objects inside the draw radius on the worst measured circle are exactly that
    // — which is what the grey boxes standing in the middle of a paved square are.
    //
    // Nothing is lost by leaving them out. The hit list `pick` scans is built by the 2D overlay
    // from the object's own position and does not ask the renderer anything, so a mailbox with no
    // art is still a mailbox that can be clicked and used.
    const node = drawableModel(model)
      ? this.#modelNode(placement, model)
      : placeEnvironmentNode(new THREE.Group(), placement);
    rendered.node = node;
    const borrowedBuild = node.userData["builtModel"];
    if (borrowedBuild) rendered.built = borrowedBuild as BuiltModel;
    const legacyGeometry = node.userData["legacyGeometry"];
    if (legacyGeometry) rendered.legacyGeometry = legacyGeometry as LegacyGeometryEntry;
    const materialEntries = node.userData["worldMaterialEntries"];
    if (Array.isArray(materialEntries)) {
      rendered.materialEntries = materialEntries as readonly WorldMaterialEntry[];
    }
    const visual = node.userData["visual"];
    if (visual instanceof THREE.Object3D) rendered.visual = visual;
    return rendered;
  }

  /**
   * Where the object stands this frame: its spawn point, or a point on the path it runs.
   *
   * A lift's path is an offset in its own frame, so the spawn yaw turns it before it is added —
   * which matters for the seventeen entries that travel horizontally and for nothing else, since
   * 65 of the 82 are a plain vertical shaft. The phase comes from the server so that two players
   * watching the same lift see it in the same place.
   */
  #placeGameObject(
    rendered: RenderedGameObject,
    object: WorldObjectState,
    position: WorldPosition,
    paths: TransportPathClient | undefined,
    now: number,
  ): void {
    rendered.base = { x: position.x, y: position.y, z: position.z, orientation: position.orientation };
    const nextEntry = gameObjectEntry(object) ?? 0;
    if (nextEntry !== rendered.entry) {
      rendered.entry = nextEntry;
      // A transport path is part of the retained identity. Do not carry the
      // old path's phase into a newly admitted entry.
      delete rendered.phaseMs;
      delete rendered.phaseAt;
    }
    const scale = gameObjectScale(object);
    if (scale !== undefined) rendered.node.scale.setScalar(scale);
    if (Number.isFinite(position.orientation)) {
      // `mappedVmapRotation(0, o, 0)` in closed form (a turn about scene +y): no four Matrix4 per
      // object per frame.
      sceneYaw(position.orientation, GAME_OBJECT_TILT);
      rendered.node.quaternion.set(GAME_OBJECT_TILT.x, GAME_OBJECT_TILT.y, GAME_OBJECT_TILT.z, GAME_OBJECT_TILT.w);
      // 5.27: a leaning bridge or a toppled pillar carries more rotation than its yaw. The tilt is
      // in world axes, so it goes on after the yaw; a level object has none and is left as it was.
      // 11.01-D: aboard a ship the local rotation is in the ship's frame (TransportPassengers.ts).
      if (passengerGameObjectTilt(object, position.orientation, GAME_OBJECT_TILT)) {
        toRenderAxes(GAME_OBJECT_TILT, GAME_OBJECT_TILT);
        rendered.node.quaternion.premultiply(GAME_OBJECT_TILT_SCENE.set(
          GAME_OBJECT_TILT.x, GAME_OBJECT_TILT.y, GAME_OBJECT_TILT.z, GAME_OBJECT_TILT.w));
      }
    }
    const path = rendered.entry > 0 ? paths?.path(rendered.entry) : undefined;
    if (!path || path.period <= 0 || path.frames.length === 0) {
      rendered.node.position.set(position.x, position.z, -position.y);
      return;
    }
    // 11.01-B: the phase the physics stands the character on (LiftClock.ts): anchored when the
    // create block was read rather than at first sight, and re-anchored by a new create block.
    const offset = sampleTransportPath(path, liftPhaseMs(object, path.period, now));
    const at = placeOnTransportPath(rendered.base, offset);
    rendered.node.position.set(at.x, at.z, -at.y);
  }

  /**
   * What the object should be showing, and playing it.
   *
   * The state byte is the whole of the input; everything else is the choosing, which lives in
   * `GameObjectAnimation.ts` and deliberately shares nothing with the unit chooser.
   */
  #poseGameObject(
    rendered: RenderedGameObject,
    object: WorldObjectState,
    client: EnvironmentClient | undefined,
    now: number,
    elapsed: number,
  ): void {
    const bytes = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset) ?? 0;
    const state = bytes & 0xff;
    const template = rendered.template;
    if (!template || !rendered.skinned) {
      // Nothing to play it with. The state is still remembered, so a model that finishes loading
      // mid-swing snaps to where the door already is rather than swinging from the beginning.
      rendered.state = state;
      this.#gameObjectAnimations.delete(object.guid);
      return;
    }

    const custom = this.#gameObjectAnimations.get(object.guid);
    if (custom !== undefined) {
      this.#gameObjectAnimations.delete(object.guid);
      const animation = customGameObjectAnimation(custom);
      if (animation !== undefined) {
        this.#requestGameObjectPoses(rendered, [animation], client);
        this.#playAnimation(rendered, animation, false, now);
      }
    }

    if (now >= rendered.overlayUntil) {
      const pose = gameObjectPose(state, rendered.state, template.animations);
      if (pose) {
        this.#requestGameObjectPoses(rendered, [pose.animation], client);
        this.#playAnimation(rendered, pose.animation, !pose.once, now);
      }
    }
    rendered.state = state;
    rendered.skinned.mixer.update(elapsed);
    if (rendered.wvm) applyGlobalSequenceBones(rendered.skinned, template,
      rendered.wvm.globalSequences, now);
    applyBillboardBones(rendered.skinned, template, this.#camera);
  }

  /**
   * Fetches the poses a door declared and did not ship with.
   *
   * The locomotion set travels with every model and none of 146–156 is in it, so a door's swing is
   * always in the sidecar: the artifact says the model has it, the clip is one request away. The
   * environment sidecar scheduler coalesces requests for the exact decoded rig.
   */
  #requestGameObjectPoses(rendered: RenderedGameObject, wanted: readonly number[], client: EnvironmentClient | undefined): void {
    const template = rendered.template;
    if (!client || !template || !rendered.model || template.merged) return;
    if (wanted.every((animation) => template.clips.has(animation) || !template.animations.has(animation))) return;
    const clips = client.animations(rendered.model, template.parents.length, "normal");
    if (!clips) return;
    addSkinnedClips(template, clips);
    template.merged = true;
  }

  /**
   * A custom animation, held until the frame that can play it.
   *
   * `SMSG_GAMEOBJECT_CUSTOM_ANIM` is fire-and-forget: the server sends it once, to whoever is in
   * range at that moment, and never repeats it. The object it names may not be built yet — its
   * model is a download — so the number waits for one frame rather than being dropped on arrival.
   */
  playGameObjectAnimation(guid: bigint, animation: number): void {
    if (this.#gameObjects.has(guid)) this.#gameObjectAnimations.set(guid, animation);
  }

  /**
   * Queues the mount trick named by `SMSG_MOUNTSPECIAL_ANIM`.
   *
   * The packet carries the rider's guid, but the animation belongs to the mounted model underneath
   * it. Keep the ticket until that model is admitted and its exact ground/flying clip is available;
   * otherwise a mount loading on the same frame as the packet silently loses the one-shot.
   */
  playMountSpecial(guid: bigint): void {
    if (guid === 0n) return;
    this.#mountSpecials.set(guid, performance.now() + MOUNT_SPECIAL_WAIT);
  }

  /**
   * A trustworthy current silhouette, or undefined when admission must fail open.
   *
   * Gear and mounts used to fail open outright, so in a city every player — head, shoulders and a
   * weapon are the rule there — was "visible" wherever it stood, took one of the 64 draw slots
   * ahead of a creature that was actually on screen, and was drawn in the main and shadow passes
   * from behind the camera. Now the body's sphere is widened by what hangs off it: a fixed reach
   * for gear (`UNIT_GEAR_SILHOUETTE_ALLOWANCE`) and the mount's own measured sphere lifted by its
   * saddle. Only what cannot be measured yet fails open: a mount that is on the wire but not built,
   * a body that is still a capsule, emitters (a beam anchored to a bone reaches where no bound says).
   */
  #unitVisibilityRadius(object: WorldObjectState, unit: RenderedUnit | undefined): number | undefined {
    if (!unit || unit.body || !unit.wvm || !unit.built
      || unit.decodedModel || unit.legacyGeometry
      || unit.admissionHasAuthoredAttachments === undefined
      || unit.wvm.particleEmitters.length > 0 || unit.wvm.ribbonEmitters.length > 0) return undefined;
    const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
    const rawObjectScale = fieldFloat(object, UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset);
    if (rawObjectScale !== undefined && (!Number.isFinite(rawObjectScale) || !(rawObjectScale > 0))) return undefined;
    const objectScale = unitObjectScale(object);
    if (unit.admissionDisplayId !== displayId || unit.admissionObjectScale !== objectScale
      || !Number.isFinite(objectScale)) return undefined;
    const builtSphere = unit.built.geometry.boundingSphere;
    if (!builtSphere) return undefined;
    const body = conservativeUnitVisibilityRadius(unit.wvm.bounds, builtSphere, unit.scale, unit.height);
    if (body === undefined) return undefined;
    let mount: CompositeUnitMount | undefined;
    const mountDisplayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset) ?? 0;
    if (mountDisplayId !== 0 || unit.mount) {
      // On the wire but not standing under the rider yet: composite, and not measurable.
      if (!unit.mount) return undefined;
      const mountSphere = unit.mount.built.geometry.boundingSphere;
      if (!mountSphere) return undefined;
      const radius = conservativeUnitVisibilityRadius(
        unit.mount.wvm.bounds, mountSphere, unit.mount.scale, Math.max(unit.mount.seat, 1),
      );
      if (radius === undefined) return undefined;
      mount = { radius, seat: unit.mount.seat };
    }
    const gear = unitWireHasCompositeSilhouette(object) || unit.attached.size > 0
      || unit.admissionHasAuthoredAttachments;
    return compositeUnitVisibilityRadius(body, unit.scale, gear, mount);
  }

  /**
   * Players and creatures used to exist only as flat markers painted over the picture, so a hill
   * never hid anything. They are stand-in capsules in the real scene now: depth-sorted, lit and
   * occluded like everything else, and ready to be swapped for skinned M2 models.
   */
  #updateUnits(
    state: WorldState,
    player: WorldPosition,
    now: number,
    elapsed: number,
    client: EnvironmentClient | undefined,
    creatureModel: ((object: WorldObjectState) => UnitModel | undefined) | undefined,
    displayAnswered: ((displayId: number) => boolean) | undefined,
    mountModel: ((object: WorldObjectState) => UnitModel | undefined) | undefined,
  ): void {
    // The question is always "what is a capsule now", so the ledger starts empty every frame.
    this.#standIns.begin();
    // Every pose job of an earlier frame is final before this frame publishes its own.
    this.#poseEngine?.endFrame();
    this.#unitBuildBudget.begin();
    this.#unitAnimationBudget.begin();
    this.#unitAnimationPrefetch.clear();
    this.#atlasFrameDemands.clear();
    this.#atlasFrameActive.clear();
    this.#vehiclePassengers.begin(state.objects, vehicleCatalog()); // 11.02-H
    // The frustum is composed before admission so invisible neighbours do not consume the same
    // budget as the units on screen. Numeric sphere tests below allocate nothing per candidate.
    this.#frustumMatrix.multiplyMatrices(this.#camera.projectionMatrix, this.#camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#frustumMatrix);

    // Ranked and capped rather than taken as they come out of the grid, for the same reason the
    // environment is: what is dropped has to be what is furthest away and not whatever the map
    // happened to iterate last. The character itself, its target and its focus enter ahead of every
    // ordinary unit and bypass both range and visibility.
    const candidates: UnitAdmissionCandidate<WorldObjectState>[] = [];
    const pinned = new Set<bigint>();
    if (state.selfGuid !== undefined) pinned.add(state.selfGuid);
    if (this.#selection.target) pinned.add(this.#selection.target.guid);
    if (this.#selection.focus) pinned.add(this.#selection.focus.guid);
    if (!this.#formalBenchmarkIsolation) {
      for (const guid of this.#portraits.targetGuids()) pinned.add(guid);
    }
    for (const object of state.objects.values()) {
      if ((object.typeId !== 3 && object.typeId !== 4) || !object.position) continue;
      const isPinned = pinned.has(object.guid);
      const distance = hypot2(object.position.x - player.x, object.position.y - player.y);
      if (distance > UNIT_DRAW_DISTANCE && !isPinned) continue;
      const radius = isPinned ? undefined : this.#unitVisibilityRadius(object, this.#units.get(object.guid));
      const visible = isPinned || radius === undefined || unitSphereVisibleInFrustum(
        object.position.x,
        object.position.z,
        -object.position.y,
        radius,
        this.#frustum.planes,
        UNIT_FRUSTUM_MARGIN,
      );
      candidates.push({
        value: object,
        distance: Number.isFinite(distance) ? distance : Number.MAX_VALUE,
        pinned: isPinned,
        visible,
      });
    }
    const admission = selectUnitAdmission(candidates, UNIT_BUDGET);
    this.#unitsDropped = admission.dropped;
    this.#unitsDrawn = admission.admitted.length;
    // In range and over the budget are two different things, and only the first is a reason to
    // take a unit apart. The removal loop below disposes the material, drops the effects and —
    // worse — empties `#actions`, which is where a swing or an emote waits for a unit that has
    // not been drawn yet. Evicting at rank 65 threw those away on the frame they arrived, and in
    // a crowd the 64th and 65th swap places constantly, so every swap was a full rebuild.
    const inRange = new Set(candidates.map(({ value }) => value.guid));

    const drawn = new Set<bigint>();
    for (const [rank, { value: object, distance }] of admission.admitted.entries()) {
      drawn.add(object.guid);
      this.#drawUnit(object, state.selfGuid === object.guid, distance, now, elapsed, client, creatureModel, displayAnswered,
        mountModel,
        unitCastsEnhancedShadow(rank, distance, this.#lightingProfile));
      const rendered = this.#units.get(object.guid);
      if (rendered?.applied) this.#atlasFrameActive.add(rendered.applied);
    }
    // 11.02-H: vehicle passengers onto their seats, now that every vehicle stands and is posed.
    this.#vehiclePassengers.place(admission.admitted, drawn, this.#units); // 11.02-H-review
    // Current poses across the whole crowd get first use of the animation slice. Spend any
    // remainder on the resident sidecars so future actions keep the original prefetch behaviour.
    for (const [template, path] of this.#unitAnimationPrefetch) {
      this.#prefetchSidecarAnimations(template, path, client);
    }
    this.#unitAnimationPrefetch.clear();
    // What visibility or the budget turned away keeps everything it has and is simply not shown.
    for (const [guid, unit] of this.#units) {
      if (inRange.has(guid) && !drawn.has(guid)) unit.node.visible = false;
    }
    for (const [guid, unit] of this.#units) {
      if (inRange.has(guid)) continue;
      this.#unitGroup.remove(unit.node);
      this.#clearUnitNode(unit);
      unit.material.dispose();
      this.#units.delete(guid);
      this.#actions.delete(guid);
      this.#dropEffects(`unit:${guid}`);
    }
    // A body that painted without one of its layers — trousers whose picture the gateway failed to
    // generate — is nobody's business but the atlas's from here: the unit is built, its `applied`
    // is set, and the loop above will not ask about it again. This is the only thing that comes
    // back for it, and the repaint lands in the canvas its material is already sampling. One
    // comparison on a frame with nothing due, which is every frame but a handful.
    this.#atlases?.refresh();
  }

  /**
   * Every attached WMO group mesh is a live geometry/material borrower. Placement wrappers are
   * distinct, while exact cache entries are shared across copies of one decoded parent.
   */
  #wmoGroupBorrowers(): {
    readonly geometryPins: ReadonlySet<WmoGroupGeometryEntry>;
    readonly materialPins: ReadonlySet<WorldMaterialEntry>;
    readonly wrapperCount: number;
  } {
    const geometryPins = new Set<WmoGroupGeometryEntry>();
    const materialPins = new Set<WorldMaterialEntry>();
    let wrapperCount = 0;
    const visit = (placed: PlacedWmo | undefined, node: THREE.Object3D): void => {
      if (!placed) return;
      wrapperCount += collectAttachedWmoGroupResourcePins(
        node,
        placed.built.values(),
        geometryPins,
        materialPins,
      );
    };
    this.#environment.forEach((rendered) => visit(rendered.wmo, rendered.node));
    this.#gameObjects.forEach((rendered) => visit(rendered.wmo, rendered.node));
    return { geometryPins, materialPins, wrapperCount };
  }

  /** Every retained legacy wrapper is a borrower, whether or not this frame submitted it. */
  #legacyResourceBorrowers(): {
    readonly geometryPins: ReadonlySet<LegacyGeometryEntry>;
    readonly materialPins: ReadonlySet<WorldMaterialEntry>;
    readonly borrowerCount: number;
  } {
    const geometryPins = new Set<LegacyGeometryEntry>();
    const materialPins = new Set<WorldMaterialEntry>();
    // `forEach` over each map rather than one generator chained over the three: a generator hands
    // back a result object for every placement it yields, and this runs on every submitted frame
    // over every retained placement (42 MB of them in 20 s of the movement route's profile).
    let borrowerCount = 0;
    const pin = (borrower: LegacyResourceBorrower<LegacyGeometryEntry>): void => {
      borrowerCount += pinLegacyResources(borrower, geometryPins, materialPins);
    };
    this.#environment.forEach(pin);
    this.#gameObjects.forEach(pin);
    this.#units.forEach(pin);
    const skyboxLegacyGeometry = this.#skyboxLegacyGeometry;
    const skyboxMaterialEntries = this.#skyboxMaterialEntries;
    if (skyboxLegacyGeometry || skyboxMaterialEntries) {
      pin({
        ...(skyboxLegacyGeometry ? { legacyGeometry: skyboxLegacyGeometry } : {}),
        ...(skyboxMaterialEntries ? { materialEntries: skyboxMaterialEntries } : {}),
      });
    }
    const ghost = this.#gameObjectPreviewNode;
    if (ghost?.legacyGeometry || ghost?.materialEntries) {
      pin({
        ...(ghost.legacyGeometry ? { legacyGeometry: ghost.legacyGeometry } : {}),
        ...(ghost.materialEntries ? { materialEntries: ghost.materialEntries } : {}),
      });
    }
    return { geometryPins, materialPins, borrowerCount };
  }

  /** Soft-caps exact WMO and legacy resources after final frame admission. */
  #evictWmoResources(): void {
    this.#wmoGeometryBuild.finishFrame(this.#submissionSerial);
    const wmo = this.#wmoGroupBorrowers();
    const legacy = this.#legacyResourceBorrowers();
    const geometryPins = this.#wmoPreparedGeometryPins.size > 0
      ? new Set([...wmo.geometryPins, ...this.#wmoPreparedGeometryPins]) : wmo.geometryPins;
    for (const { built } of this.#wmoGeometries.evictUnpinned(geometryPins)) {
      built.geometry.dispose();
    }
    this.#wmoPreparedGeometryPins.clear();
    for (const { built } of this.#legacyGeometries.evictUnpinned(legacy.geometryPins)) {
      built.geometry.dispose();
    }
    const materialPins = new Set<WorldMaterialEntry>(wmo.materialPins);
    for (const entry of legacy.materialPins) materialPins.add(entry);
    this.#worldMaterials.commitPins(materialPins);
  }

  /**
   * Soft-caps both built caches after every frame borrower has been admitted and recorded.
   *
   * Pins are exact BuiltModel identities carried by live borrowers. If pins alone exceed a limit,
   * the overflow remains visible in stats and is retried after those borrowers leave.
   */
  #evictBuiltModelCaches(): void {
    // Pins are only needed when an entry might leave the cache. Steady-state frames still commit
    // atlas ownership below, but need not scan every retained scenery borrower for zero evictions.
    const modelPins = this.#builtModels.needsEviction ? new Set<BuiltModel>() : undefined;
    if (modelPins) {
      if (this.#skyboxBuilt) modelPins.add(this.#skyboxBuilt);
      if (this.#gameObjectPreviewNode?.built) modelPins.add(this.#gameObjectPreviewNode.built);
      for (const rendered of this.#environment.values()) {
        if (rendered.built) modelPins.add(rendered.built);
      }
      for (const rendered of this.#gameObjects.values()) {
        if (rendered.built) modelPins.add(rendered.built);
      }
      for (const entry of this.#instances.values()) modelPins.add(entry.built);
      for (const entry of this.#groundCoverMeshes.values()) modelPins.add(entry.built);
    }

    const unitPins = this.#builtUnits.needsEviction ? new Set<BuiltModel>() : undefined;
    const atlases = this.#atlases;
    const liveAtlases = new Set<string>();
    const activeAtlases = new Set<string>();
    for (const key of this.#atlasFrameDemands) {
      liveAtlases.add(key);
      activeAtlases.add(key);
    }
    for (const key of this.#atlasFrameActive) activeAtlases.add(key);
    // Formal isolation suppresses prospective UI ownership, not physical ownership: an existing
    // portrait root still borrows these resources and may be reused after isolation ends.
    if (unitPins) for (const built of this.#portraits.retainedBuilds()) unitPins.add(built);
    for (const key of this.#portraits.retainedBuildKeys()) {
      liveAtlases.add(key);
      if (!this.#formalBenchmarkIsolation) activeAtlases.add(key);
    }
    if (!this.#formalBenchmarkIsolation) {
      if (unitPins) for (const built of this.#portraits.liveBuilds()) unitPins.add(built);
      for (const key of this.#portraits.liveBuildKeys()) {
        liveAtlases.add(key);
        activeAtlases.add(key);
      }
    }
    for (const unit of this.#units.values()) {
      if (unitPins && unit.built) unitPins.add(unit.built);
      if (unit.applied) {
        liveAtlases.add(unit.applied);
      }
      if (unitPins) {
        if (unit.mount) unitPins.add(unit.mount.built);
        for (const node of unit.attached.values()) {
          const built = node.userData["builtModel"];
          if (built) unitPins.add(built as BuiltModel);
        }
      }
    }

    const evictedModels = modelPins ? this.#builtModels.evictUnpinned(modelPins) : [];
    const evictedUnits = unitPins ? this.#builtUnits.evictUnpinned(unitPins) : [];
    // Steady-state frames evict nothing: skip the retained-array copy and the dispose scan
    // entirely rather than rebuilding an O(cache) array to dispose zero entries.
    if (evictedModels.length > 0 || evictedUnits.length > 0) {
      const evicted: EvictedBuiltModel<BuiltModel>[] = [...evictedModels, ...evictedUnits];
      for (const entry of evicted) this.#skinnedTemplates.delete(entry.key);
      disposeEvictedBuiltModels(evicted, [
        ...this.#builtModels.values(),
        ...this.#builtUnits.values(),
      ]);
    }

    // An inactive in-budget appearance still samples its composed body atlas. Cache residency,
    // rather than only a currently attached borrower, therefore owns this external dependency.
    for (const key of this.#builtUnits.retainedExternalKeys()) liveAtlases.add(key);

    // Pending/failed no-paint looks do not increase atlas.size. Prune their ownership every frame
    // against exact current demands so an invisible capsule cannot deadlock formal readiness.
    atlases?.pruneInactiveWork(activeAtlases);

    // Exact active pins may exceed either soft budget. The immutable residency stats expose that
    // overflow, and the unconditional commit converges as soon as the footprint shrinks.
    atlases?.commitPins(liveAtlases, activeAtlases);
  }

  #drawUnit(
    object: WorldObjectState,
    self: boolean,
    distance: number,
    now: number,
    elapsed: number,
    client: EnvironmentClient | undefined,
    creatureModel: ((object: WorldObjectState) => UnitModel | undefined) | undefined,
    displayAnswered: ((displayId: number) => boolean) | undefined,
    mountModel: ((object: WorldObjectState) => UnitModel | undefined) | undefined,
    shadowCaster: boolean,
  ): void {
    const detailedCapture = this.#shaderProgramTrace !== undefined;
    let unitPartAt = detailedCapture ? performance.now() : 0;
    const position = object.position!;
    const dead = isWorldObjectDead(object);
    const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
    const tint = dead ? CORPSE_TINT
      : self ? SELF_TINT
        : object.typeId === 4 ? PLAYER_TINT
          : unitTintScratch.setHSL((displayId * 0.113) % 1, 0.42, 0.46).getHex();
    // The server publishes the real silhouette of every creature; use it instead of one size.
    const radius = clampSize(fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset), UNIT_DEFAULT_RADIUS, 0.2, 6);
    const reach = clampSize(fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset), radius * 4.4, 0.6, 22);
    const capsuleHeight = Math.max(0.8, Math.min(14, reach));

    let unit = this.#units.get(object.guid);
    if (!unit) {
      // One recipe with the capsule's program stand-ins (`#capsulePrograms`), so they cannot drift.
      const material = createUnitCapsuleMaterial(tint, this.#worldLight);
      const body = new THREE.Mesh(this.#unitBodyGeometry, material);
      const facing = new THREE.Mesh(this.#unitFacingGeometry, material);
      facing.rotation.z = -Math.PI / 2;
      const node = new UnitSceneGroup();
      node.add(body, facing);
      unit = {
        node, built: undefined, shadowCaster: undefined, body, material,
        skinned: undefined, template: undefined, action: undefined,
        animationId: -1, pose: undefined, overlayUntil: 0,
        strideX: 0, strideY: 0, strideZ: 0, strideReady: false, strideSpeed: undefined,
        height: 0, radius: 0, scale: 1, dead: !dead, tint: tint ^ 1, applied: "",
        attached: new Map(), unitOpacity: 1,
      };
      this.#units.set(object.guid, unit);
      this.#unitGroup.add(node);
    }

    // What the server says this unit should look like, before anything is built or posed: the pose
    // half is read by `#animateUnit` below and the opacity half is applied once the model, the
    // mount and the attachments have all settled.
    const auras = this.#auraAppearance.get(object.guid);
    const appearance = unitAppearance({
      creep: isUnitCreeping(object),
      stealthAura: auras?.stealth === true,
      invisibilityAura: auras?.invisibility === true,
      ghost: isPlayerGhost(object),
    });
    unit.stealthed = appearance.stealth;

    const metadata = creatureModel?.(object);
    let currentWvm = false;
    let currentObjectScale = 1;
    // Rebuilt whenever the model or the look changes, rather than once and never again. The key
    // is only recorded when a model is really standing there, so a unit whose file or body
    // texture has not arrived yet is tried again on the next frame.
    let standIn: StandInReason | undefined;
    if (metadata) {
      const key = this.#unitKey(metadata);
      // This lookup already happened in #updateAttachments on every applied frame. Keeping the
      // exact answer here lets a re-decoded legacy parent (or a legacy/WVM format transition)
      // replace the old body without adding another request or retaining a stale GPU bundle.
      const decodedModel = client?.model(metadata.model, "critical");
      const replacesLegacy = legacyDecodedModelReplaced(
        unit.decodedModel,
        unit.legacyGeometry !== undefined,
        decodedModel,
      );
      // A player's look resolved without some of its item rows is not built yet, for a bounded wait:
      // building it made every player twice, bare and then dressed (`#appearanceWaits`).
      const appearanceWaits = this.#appearanceWaits(unit, metadata, now);
      if (key !== unit.applied || replacesLegacy) {
        standIn = appearanceWaits ? "appearance"
          : this.#attachSkinnedModel(unit, metadata, key, decodedModel, client);
      }
      if (unit.applied === key) {
        if (unit.template) this.#unitAnimationPrefetch.set(unit.template, metadata.model);
        this.#updateAttachments(unit, metadata, object, client, decodedModel);
        // How big, now that the model standing there is the one this record describes. The display
        // record's own scale is only half of the answer and `unitObjectScale` is the other; the
        // product is recomputed rather than multiplied into what is already applied, so a scale
        // aura that lands and falls off leaves the unit exactly the size it started.
        //
        // The capsule is deliberately not scaled: `Creature::SetObjectScale`
        // (`Creature.cpp:3448-3457`) and `Player::SetObjectScale` (`Player.cpp:2031-2036`) multiply
        // BOUNDINGRADIUS and COMBATREACH by the same number before sending them, and `#shapeCapsule`
        // builds the pill out of those two — scaling its node as well would square every giant.
        currentObjectScale = unitObjectScale(object);
        const drawn = metadata.scale * currentObjectScale;
        if (drawn !== unit.scale) {
          // `height` is the model's own height times the scale it was bound at, and the two have to
          // move together: the name plate sits on it (`unitHeight`) and so does the camera pivot.
          unit.height = (unit.height / unit.scale) * drawn;
          unit.scale = drawn;
          unit.node.scale.setScalar(drawn);
        }
        currentWvm = unit.wvm !== undefined && unit.built !== undefined;
      }
    } else {
      // A display id of zero is a display that will never be answered, which is the same wait as
      // one that has not been answered yet and is counted with it.
      standIn = displayAnswered?.(displayId) ? "appearance" : "display";
    }
    // `body` is the capsule itself, and `#clearUnitNode` drops it the moment a real model goes in —
    // the same test `#shapeCapsule` makes before it bothers to shape anything. So `capsule` counts
    // the units the player is actually looking at a pill instead of, and `model` the ones standing
    // in the look they have already left while the next one fails to build. Both are stand-ins and
    // only the first is a capsule: the guard used to be `unit.body !== undefined` alone, so the one
    // case Ж0.3 was written for — the display id moved and its record has not come back, the player
    // still wearing their own body — was the one case the ledger never mentioned.
    const wearing: StandInWearing = unit.body === undefined ? "model" : "capsule";
    const shown = unitContentVisible(object, self, false, unit.body !== undefined);
    if (standIn && shown) this.#standIns.note(object.guid, displayId, standIn, metadata?.model, wearing);
    // After the unit's own scale is settled and before it is posed: the seat is measured against
    // `unit.scale`, and the pose the rider takes depends on whether the mount is really there.
    this.#updateMount(unit, mountModel?.(object), client);
    if (unit.mount?.template) {
      this.#unitAnimationPrefetch.set(unit.mount.template, unit.mount.metadata.model);
    }
    if (currentWvm) {
      unit.admissionDisplayId = displayId;
      unit.admissionObjectScale = currentObjectScale;
      unit.admissionHasAuthoredAttachments = (metadata?.appearance?.attached.length ?? 0) > 0;
    } else {
      delete unit.admissionDisplayId;
      delete unit.admissionObjectScale;
      delete unit.admissionHasAuthoredAttachments;
    }

    if (detailedCapture) {
      const at = performance.now();
      this.#drawPhaseMs["units.appearance"]! += at - unitPartAt;
      unitPartAt = at;
    }
    const moving = !dead && isUnitMoving(object.movementFlags, object.motion !== undefined);
    // Placed before it is posed, not after. A billboard bone is turned against the frame its own
    // parents are in, and a unit still standing where it was last frame turns its cards to face
    // where the camera was relative to *that* — visible on anything that spins on the spot.
    unit.node.position.set(position.x, position.z, -position.y);
    unit.node.rotation.y = position.orientation;
    const content = unitContentVisible(object, self, this.#firstPerson, unit.body !== undefined);
    // First person hides the *rider*, not what the rider is sitting on. The mount's group hangs
    // inside `unit.node` (`#attachMount`), so hiding the node as one took the horse with it and the
    // player rode a saddle-height camera through the world with nothing under it; 3.3.5 draws the
    // mount in first person. Only this one case is split — a stand-in hidden by
    // `UNIT_FLAG_UNINTERACTIBLE` is somebody else's unit and stays hidden whole.
    const hiddenRider = !content && self && this.#firstPerson && unit.mount !== undefined;
    const presented = content || hiddenRider;
    if (presented && unit.admittedAt === undefined) unit.admittedAt = now;
    // Whatever this frame hung on the unit — a body, a mount, a sword — has the stand-ins of its fade
    // copies queued for the warm pass now; `shadowCaster` is forgotten by every path that changes
    // the tree, so a settled unit pays one comparison. A body the warm pass has not linked yet is
    // then kept out of the frame, fade clock stopped, until it has (`#holdUnitUntilWarm`).
    if (unit.shadowCaster === undefined) this.#trackUnitMeshes(unit, self);
    const held = this.#holdUnitUntilWarm(unit, self, presented, appearance.opacity, now);
    unit.node.visible = presented && !held;
    if (unit.mount) {
      const rider = unit.skinned?.root ?? unit.visual;
      if (rider) rider.visible = !hiddenRider;
    }
    if (unit.skinned && unit.template) {
      this.#animateUnit(unit, object, dead, self, distance, now, elapsed, client, metadata);
    } else {
      this.#shapeCapsule(unit, tint, radius, capsuleHeight, dead, moving, now);
    }
    if (detailedCapture) {
      const at = performance.now();
      this.#drawPhaseMs["units.pose"]! += at - unitPartAt;
      unitPartAt = at;
    }
    // After everything that can change what is hanging on this unit — the body, the mount and the
    // attachments — and before the shadow policy, which reads `material.transparent` and must see
    // the faded copies rather than the shared originals. Fresh units ease in over the spawn fade
    // window so streamed crowds arrive instead of popping; appearance opacity (ghosts, spirits)
    // multiplies, it is never replaced. A held unit is dressed here exactly as it will be drawn on
    // the frame it is let go — its clock is stopped, not skipped.
    const opacity = appearance.opacity * spawnFadeFactor(unit.admittedAt, now);
    this.#applyUnitOpacity(unit, opacity, this.#unitFadeReturnWaits(unit, opacity));
    this.#applyUnitShadow(unit, shadowCaster);
    if (detailedCapture) this.#drawPhaseMs["units.presentation"]! += performance.now() - unitPartAt;
  }

  /**
   * A name for exactly what will be built: the model file, the texture slots the display record
   * fills, and the appearance.
   *
   * The download is keyed on the model path alone and must stay that way — one HumanMale.m2 for
   * every human male alive. What is built from it is not shared: every playable display record has
   * an empty texture-slot string, so keying the geometry, the materials and the composed body on
   * `model|textures` gave all fifteen thousand character displays 41 keys between them, and the
   * first human male in view decided the skin, the face, the hair and the armour of every human
   * male after him.
   */
  #unitKey(metadata: UnitModel): string {
    const base = modelKey(metadata.model, metadata.textures);
    const appearance = metadata.appearance;
    if (!appearance) return base;
    // The client interns one object per look, so the digest is computed once per look rather than
    // once per unit per frame.
    //
    // Which is also why a look that gains a field reaches a unit already wearing its model: the
    // interning is on object identity, and nothing mutates an appearance in place — a look whose
    // answer has changed arrives from `CreatureModelClient` as a *new* object, gets a digest of
    // its own, and `key !== unit.applied` rebuilds it. `Frames.unitModel` rebuilds the metadata
    // wrapper every frame but hands back the same interned appearance inside it, so this stays one
    // digest per look and not one per frame. What the WeakMap cannot fix is a stale *answer*:
    // `playerAppearance` caches by look and never asks twice, so a gateway restarted underneath a
    // running tab is seen only after a reload.
    let name = this.#appearanceKeys.get(appearance);
    if (name === undefined) {
      name = appearanceKey(appearance);
      this.#appearanceKeys.set(appearance, name);
    }
    return `${base}#${name}`;
  }

  /**
   * Whether a player's model waits for the visible-item rows its appearance was resolved without.
   *
   * `Frames.unitModelFor` answers with the look made from the item rows already loaded and says the
   * rest are pending. Building that answer built every player twice — bare, then dressed a moment
   * later: two body atlases, two texture sets and two spawn fades, the first of them thrown away.
   * So the unit keeps whatever it stands in (its capsule, or the look it already wears) until the
   * rows arrive, and for at most APPEARANCE_PENDING_WAIT_MS on the renderer's clock; after that the
   * partial look is built exactly as before, so a row that never comes still leaves a model, and the
   * full look replaces it whenever the row does come.
   */
  #appearanceWaits(unit: RenderedUnit, metadata: UnitModel, now: number): boolean {
    if (metadata.appearancePending !== true) {
      if (unit.appearancePendingSince !== undefined) delete unit.appearancePendingSince;
      return false;
    }
    // A replay epoch rewinds the clock; the wait restarts from there rather than lasting until the
    // rewound clock catches up with the old stamp.
    if (unit.appearancePendingSince === undefined || now < unit.appearancePendingSince) {
      unit.appearancePendingSince = now;
    }
    return now - unit.appearancePendingSince < APPEARANCE_PENDING_WAIT_MS;
  }

  /**
   * Swaps the stand-in capsule for the real model as soon as its skeleton has downloaded.
   *
   * Returns what stopped it, or undefined when the unit is now wearing its model. Every early
   * return here leaves a capsule standing, and three of them leave it standing for good, so the
   * reason is carried out rather than inferred from the outside.
   */
  #attachSkinnedModel(unit: RenderedUnit, metadata: UnitModel, key: string,
    model: EnvironmentModel | undefined, client?: EnvironmentClient): StandInReason | undefined {
    // The download is keyed on the model path alone now, so every appearance of a race shares one
    // file; only the geometry and materials built below vary with the appearance.
    if (!model) return "artifact";

    if (model.wvm) {
      const appearance = metadata.appearance;
      const slots = characterSlots(metadata.textures, appearance);
      const character = model.wvm.textures.some((slot) => slot.type === TEXTURE_TYPE_BODY);

      // A character's body is five textures painted into one 512x512 image; the composite is not
      // a file, so it is handed to the builder directly rather than resolved by path. Until it is
      // ready the unit keeps its stand-in — a face arriving a frame late beats a bare skin.
      let supplied: Map<number, THREE.Texture> | undefined;
      if (character && appearance && appearance.body.length > 0) {
        this.#atlasFrameDemands.add(key);
        this.#atlases ??= new CharacterAtlasClient(this.#baseUrl);
        const body = this.#atlases.get(key);
        if (!body) {
          void this.#atlases.compose(key, appearance.body);
          return "atlas";
        }
        // The composed body is supplied as an existing texture, so configure its sampling here
        // rather than making ModelBuild mutate every texture handed in by a caller.
        configureCharacterAtlasTexture(body, this.#characterAtlasAnisotropyEnabled
          ? this.#anisotropy() : 1);
        supplied = new Map([[TEXTURE_TYPE_BODY, body]]);
      }

      // Which geosets: the gateway resolved the hairstyle, the three facial-hair pieces and the
      // ears from the appearance bytes. Everything else in the file stays hidden, which is what
      // stops twelve hairstyles and twelve cloaks drawing on one tauren, and stops every humanoid
      // wearing the death knight eye glow that is the only 17xx variant a human model carries.
      //
      // A model with no appearance is either a character that needs the measured bare-character
      // set, or a pre-composed creature whose M2 authored all of its body parts as submeshes. The
      // latter must not be reduced to geoset 0: child models put their legs in 401/501/503 and
      // bespoke creatures use the same ids for real geometry, not appearance choices. The rule
      // lives in `ModelBuild` beside `characterSlots`.
      // Failed templates are cached: they must not consume every subsequent frame's budget.
      if (this.#skinnedTemplates.get(this.#builtCacheKey(this.#builtUnits, key)) === null) return "template";
      if (!this.#unitBuildBudget.take()) return "queued";
      const geosets = worldCharacterGeosets(model.wvm, appearance, character);
      const { built, rigged } = this.#buildRigged(key, metadata.model, model.wvm, slots, geosets,
        supplied, client);
      if (rigged === undefined) {
        // No rig at all: 9.5% of the client's creature models have none, and a static mesh is
        // far better than the coloured capsule they used to keep forever.
        const mesh = new THREE.Mesh(built.geometry, built.materials);
        mesh.quaternion.copy(M2_TO_SCENE);
        this.#programWarmup.registerObject(mesh, "unit");
        this.#clearUnitNode(unit);
        unit.node.add(mesh);
        unit.skinned = undefined;
        unit.template = undefined;
        unit.wvm = model.wvm;
        unit.visual = mesh;
        unit.scale = metadata.scale;
        unit.node.scale.setScalar(metadata.scale);
        unit.bodyHeight = built.height;
        unit.height = built.height * metadata.scale;
        unit.applied = key;
        unit.built = built;
        return undefined;
      }
      if (!rigged) return "template";
      this.#useSkinned(unit, metadata, key, rigged, instantiateSkinned(rigged, built.materials), built);
      unit.wvm = model.wvm;
      // A rigged unit is posed through its bones, so there is no single mesh matrix to fall back
      // on and the emitter frames come from the skeleton instead.
      delete unit.visual;
      return undefined;
    }

    if (this.#legacySkinnedFailures.has(model)) return "template";
    if (!this.#unitBuildBudget.take()) return "queued";
    const legacy = this.#legacySkinnedGeometry(model);
    const template = legacy?.template;
    if (!legacy || !template) return "template";
    const { entries, materials } = this.#legacyMaterials(model);
    this.#useSkinned(unit, metadata, key, template, instantiateSkinned(template, materials));
    unit.decodedModel = model;
    unit.legacyGeometry = legacy;
    unit.materialEntries = entries;
    return undefined;
  }

  /**
   * Geometry, materials and — when the file has a skeleton — the rig built from them, under one key.
   *
   * Lifted out of `#attachSkinnedModel` unchanged so the mount can use it: a horse is built exactly
   * the way a creature is, only with no appearance and with every geoset the file carries. The
   * three states of `rigged` are three different answers and each has its own caller behaviour:
   * `undefined` the model has no skeleton, `null` it has one that would not build, a template it
   * is ready.
   */
  #buildRigged(key: string, path: string, wvm: WvmModel, slots: TextureSlots, geosets: GeosetChoice,
    supplied?: ReadonlyMap<number, THREE.Texture>, client?: EnvironmentClient):
  { built: BuiltModel; rigged: SkinnedTemplate | null | undefined } {
    const built = this.#wvmBuild(this.#builtUnits, key, path, wvm, slots, geosets,
      Boolean(wvm.skeleton), supplied);
    const rig = wvm.skeleton;
    if (!rig) return { built, rigged: undefined };
    const cacheKey = this.#builtCacheKey(this.#builtUnits, key);
    let rigged = this.#skinnedTemplates.get(cacheKey);
    if (rigged === undefined) {
      rigged = buildSkinnedTemplateFrom(built.geometry, rig, built.height) ?? null;
      this.#skinnedTemplates.set(cacheKey, rigged);
    }
    if (rigged) this.#prefetchSidecarAnimations(rigged, path, client, true);
    return { built, rigged };
  }

  /**
   * Asks for the held-back keyframes as soon as a rig exists, rather than when a pose needs one.
   *
   * `animations` is every id the model can play and `clips` is the ones that travelled inside it —
   * so a difference between the two sizes *is* the sidecar. Until now nothing asked for it until a
   * frame wanted a pose that was inside it, which is how a character stood in the saddle and how
   * the first cast after a rebuild was dropped: the whole request had to be made, queued, fetched
   * and decoded inside the window that action waited in. Measured here, HumanMale declares 199
   * animations and carries 17 clips — the other 182 are this request, 9,833,124 bytes of it.
   * Every armour change rebuilds this template with `merged: false`, and that is exactly the moment
   * to ask again — `merged` and the environment client's own in-flight ledger make the repeat free.
   *
   * "background" priority on purpose: this must never take a lane from the model of the unit that
   * is standing in front of the player right now.
   */
  #prefetchSidecarAnimations(template: SkinnedTemplate, path: string,
    client: EnvironmentClient | undefined, requestOnly = false): void {
    if (!client || template.merged) return;
    if (template.animations.size <= template.clips.size) return;
    const clips = client.animations(path, template.parents.length, "background");
    if (!clips || requestOnly) return;
    // A cached sidecar can contain hundreds of clips. Compile only a small slice here;
    // a later pose request gives its missing animation priority over the remaining tail.
    if (!this.#unitAnimationBudget.take()) return;
    template.merged = mergeSkinnedClips(template, clips, { maxClips: 16, milliseconds: 1 }).complete;
  }

  /**
   * Puts the second model under a rider, takes it away again, and keeps the rider in its saddle.
   *
   * Before this the field went nowhere: `UNIT_FIELD_MOUNTDISPLAYID` had one reader in the whole
   * repository (`WindowBindings.ts:331`, a boolean), so a mounted player and a player on a taxi
   * both walked through the air at running speed. The server never touches DISPLAYID for either —
   * `Unit::Mount` (`Unit.cpp:8668-8673`) writes the mount field and `UNIT_FLAG_MOUNT` and nothing
   * else — so the second model is the client's whole job.
   */
  #updateMount(unit: RenderedUnit, metadata: UnitModel | undefined,
    client: EnvironmentClient | undefined): void {
    if (!metadata) {
      this.#dropMount(unit);
      return;
    }
    // The model and its skins, and deliberately *not* `#unitKey`: a mount is built with no
    // appearance, and 2,404 is display 2404 whether the horse is being ridden or standing in the
    // stable beside it. Where the record carries no appearance the two paths agree on the key and
    // on every argument below it, so the horse under the player and the horse next to it are one
    // build. Where it does carry one — every `Character\` display does — `#unitKey` appends a
    // digest, so the unit's own key is a different string and the two cannot poison each other.
    const key = modelKey(metadata.model, metadata.textures);
    if (!mountInstanceMatches(unit.mount?.metadata, metadata)) {
      const wvm = client?.model(metadata.model, "critical")?.wvm;
      // Still downloading. Whatever is under the rider now stays there: on a first mount that is
      // nothing and the character walks for a frame or two, and on a change of mount it is the
      // previous one, which beats dropping them to the ground and putting them back.
      if (wvm && this.#unitBuildBudget.take()) {
        this.#attachMount(unit, metadata, key, wvm, client);
      }
    }
    this.#seatRider(unit);
  }

  /** Builds the mount and hangs it in the unit's node; the rider is seated separately. */
  #attachMount(unit: RenderedUnit, metadata: UnitModel, key: string, wvm: WvmModel,
    client?: EnvironmentClient): void {
    this.#dropMount(unit);
    // The same two decisions `#attachSkinnedModel` makes for a creature with no appearance, and
    // made by the same two functions rather than by a copy of their answers. For the 2,952 mount
    // displays of this dataset that means every geoset the file authored: a horse put its mane,
    // its tail and its barding in submeshes, and the bare-character set would take it apart.
    const { built, rigged } = this.#buildRigged(key, metadata.model, wvm,
      characterSlots(metadata.textures, undefined),
      unitGeosets(undefined, wvm.textures.some((slot) => slot.type === TEXTURE_TYPE_BODY)),
      undefined, client);
    const node = new THREE.Group();
    let skinned: SkinnedInstance | undefined;
    if (rigged) {
      skinned = instantiateSkinned(rigged, built.materials);
      node.add(skinned.root);
    } else {
      // The unrigged tenth of the table, and the rigs that would not build. A statue of a horse
      // still puts the rider where a rider belongs.
      const mesh = new THREE.Mesh(built.geometry, built.materials);
      mesh.quaternion.copy(M2_TO_SCENE);
      mesh.frustumCulled = false;
      node.add(mesh);
    }
    unit.node.add(node);
    this.#programWarmup.registerObject(node, "unit");
    unit.mount = {
      key, built, node, metadata, wvm, skinned, template: rigged ?? undefined,
      action: undefined, animationId: -1, overlayUntil: 0,
      scale: metadata.scale,
      seat: mountSeatOffset(wvm, metadata.mountHeight, metadata.scale),
    };
    unit.shadowCaster = undefined;
  }

  /**
   * Hangs the rider off the saddle bone, and keeps the two nested scales in step.
   *
   * The pair of scales is `mountNesting`, and it is recomputed every frame rather than at build
   * time: a scale aura landing on a rider moves `unit.scale` under a mount that was built long
   * before, and two `setScalar` calls a frame is not worth a comparison to avoid.
   */
  #seatRider(unit: RenderedUnit): void {
    const mount = unit.mount;
    if (!mount) return;
    const nesting = mountNesting(unit.scale, mount.scale);
    // Before the rider is looked for, because how large the horse is drawn does not depend on
    // whether anybody is on it. Below this line the two used to leave together, so a unit whose
    // display id never answered — П1's permanent stand-in — kept a mount at scale 1: FrostWurm,
    // whose `CreatureModelScale` is 0.75, a third too large with a coloured pill inside it.
    mount.node.scale.setScalar(nesting.mount);
    // `visual` as well as `skinned`, because a rider need not be rigged either: 9.5% of the
    // client's creature models are not, and a static one left at the origin would stand inside the
    // horse rather than on it. Both objects carry `M2_TO_SCENE` and nothing else, so the same
    // moves work on either.
    const rider = unit.skinned?.root ?? unit.visual;
    // And the pill is not a rider. It is a placeholder for one, drawn at the unit's own feet, so
    // while there is a horse there it is hidden rather than left sticking out of the saddle: the
    // mount is authored art and the capsule is not, and the ledger still counts the unit as a
    // stand-in either way (`#drawUnit` notes it before this runs).
    this.#showCapsule(unit, false);
    if (!rider) return;

    const bone = mount.skinned && mount.template
      ? boneOf(mount.wvm, mount.skinned, ATTACHMENT_MOUNT_SEAT) : undefined;
    if (bone && mount.template) {
      if (rider.parent !== bone) bone.add(rider);
      // The mount's own root already turned M2 space into the scene's, so inside its bones the
      // rider sits in plain M2 space and must not turn a second time.
      rider.quaternion.identity();
      rider.position.copy(attachmentOffset(mount.wvm, mount.template.pivots, ATTACHMENT_MOUNT_SEAT));
      rider.scale.setScalar(nesting.rider);
    } else {
      // The nine models of the table that name no saddle. The rider is simply lifted, in the
      // unit's node — which is already scaled by the rider — so the seat is divided by that.
      if (rider.parent !== unit.node) unit.node.add(rider);
      rider.quaternion.copy(M2_TO_SCENE);
      rider.position.set(0, mount.seat / unit.scale, 0);
      rider.scale.setScalar(1);
    }
    // Or the name plate hangs inside the horse: the plate sits on `unit.height`, which until now
    // was the character's own height above its own feet, and its feet are now two yards up.
    // `bodyHeight` and not `template.height`, so the rigless tenth of the models gets its head
    // counted too — that branch used to read zero here and put the plate on the saddle.
    unit.height = mount.seat + (unit.bodyHeight ?? 0) * unit.scale;
  }

  /**
   * The stand-in pill and the arrow beside it, which are one placeholder and are hidden as one.
   *
   * `#shapeCapsule` writes the arrow's own visibility, but only on a change of the dead flag, so
   * anything that hides it has to put it back itself rather than wait for that to notice.
   */
  #showCapsule(unit: RenderedUnit, visible: boolean): void {
    if (!unit.body) return;
    unit.body.visible = visible;
    const facing = unit.node.children[1];
    if (facing) facing.visible = visible && !unit.dead;
  }

  /** Takes the mount away, puts the rider back on the ground, and lets go of its rig. */
  #dropMount(unit: RenderedUnit): void {
    const mount = unit.mount;
    if (!mount) return;
    const rider = unit.skinned?.root ?? unit.visual;
    if (rider) {
      unit.node.add(rider);
      rider.quaternion.copy(M2_TO_SCENE);
      rider.position.set(0, 0, 0);
      rider.scale.setScalar(1);
      // Riding in first person hides the rider and leaves the horse (`#drawUnit`); dismounting has
      // to give it back, because from here on the whole node is hidden or shown as one again.
      rider.visible = true;
    }
    this.#showCapsule(unit, true);
    // The same ritual `#clearUnitNode` performs on a unit's own instance, and for the same reason:
    // a discarded instance that keeps its bones and its mixer leaks one of each per dismount.
    this.#programWarmup.unregisterObject(mount.node);
    disposeSkinnedInstance(mount.skinned);
    mount.node.removeFromParent();
    delete unit.mount;
    unit.shadowCaster = undefined;
    // The body's own height back, for the rigless branch as well as the rigged one. Nothing else
    // writes `unit.height` for a unit that has a model — `#shapeCapsule` returns on `if (!body)`
    // and `#attachSkinnedModel` writes it only when the key changes — so a rider that came down
    // without this kept the saddle in `unit.height` for good, and its name plate and the camera's
    // own fallback with it: 1.866 on anything that had once sat on a RidingHorse, whatever its
    // real height. The guard was `if (unit.template)`, which is precisely the branch that is
    // undefined for a model with no rig.
    if (unit.bodyHeight !== undefined) unit.height = unit.bodyHeight * unit.scale;
  }

  /**
   * Hangs a character's helmet, pauldrons and weapons off its bones, and takes them away again.
   *
   * Run every frame rather than once, because each item is a separate download that arrives after
   * the body it belongs on. It is cheap when there is nothing to do: one map lookup per worn
   * piece. What the unit is holding is compared by name, so a weapon that has not changed is left
   * exactly where it is rather than rebuilt.
   *
   * A weapon shows while it is drawn; stowed, the back-carried kind (two-handers, staves,
   * bows and shields, read off `stowedOnBack` in `Attachment.ts`) rides `ATTACHMENT_BACK` and a
   * stowed one-hander rides its own hip, blade down. A helmet and a pauldron are always worn
   * and are not affected.
   */
  #updateAttachments(unit: RenderedUnit, metadata: UnitModel, object: WorldObjectState,
    client: EnvironmentClient | undefined, decodedModel: EnvironmentModel | undefined): void {
    const attached = metadata.appearance?.attached;
    const instance = unit.skinned;
    const template = unit.template;
    const wvm = decodedModel?.wvm;
    if (!instance || !template || !wvm || wvm.attachments.length === 0) {
      if (unit.attached.size > 0) this.#detachAll(unit);
      return;
    }

    // UNIT_FIELD_BYTES_2 byte 0 is the sheath state, and it names which weapon is out rather than
    // whether one is: 0 everything put away, 1 the melee weapons drawn, 2 the ranged one drawn.
    const sheath = (object.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset) ?? 0) & 0xff;
    const wanted = new Map<string, { point: number; model: string; texture: string; build: string; glow: EnchantGlow | undefined }>();
    for (const item of attached ?? []) {
      const point = attachmentPoint(item, sheath);
      if (point === undefined) continue;
      const glow = this.#enchantGlow?.(object, item.slot);
      const glowKey = glow === undefined ? "0" : `${glow.color.toString(16)}@${glow.intensity}`;
      // The point rides in the key: drawing or sheathing moves the blade between bones, and a key
      // without it would leave the mesh hanging off the hand it was built on.
      wanted.set(`${item.slot}/${item.side}`, {
        point, model: item.model, texture: item.texture, build: `${item.model}#${item.texture}#${glowKey}#${point}`, glow,
      });
    }

    for (const [where, node] of unit.attached) {
      // Compared on the build, not the model. Two items commonly share one M2 and differ only in
      // ModelTexture — a Dragonmaw Shortsword and an Assassins' Short Blade are both
      // Sword_1H_Horde_A_01 — and comparing paths left the first one's skin on the second.
      // The glow rides in the key too, so enchanting and disenchanting rebuild the blade.
      if (wanted.get(where)?.build === node.userData["build"]) continue;
      this.#disposeAttachedGlow(node);
      node.removeFromParent();
      unit.attached.delete(where);
      unit.shadowCaster = undefined;
    }

    for (const [where, item] of wanted) {
      if (unit.attached.has(where)) continue;
      const bone = boneOf(wvm, instance, item.point);
      if (!bone) continue;
      const itemModel = client?.model(item.model, "critical")?.wvm;
      // Still downloading, or the client ships no mesh for this piece on this race — several
      // helmets are deliberately empty for some races. Either way, try again next frame.
      if (!itemModel) continue;
      if (!this.#unitBuildBudget.take()) continue;

      const key = item.build;
      const built = this.#wvmBuild(this.#builtUnits, key, item.model, itemModel,
        new Map(item.texture ? [[TEXTURE_TYPE_OBJECT_SKIN, item.texture]] : []), EVERY_GEOSET, false);
      // An enchanted blade borrows the build's geometry but never its materials: the emissive
      // lives on clones this mesh owns, because the cached originals are drawn by every
      // unenchanted placement of the same model. Unlit batches take no emissive and keep the
      // shared material — a glow card is already light, not a surface to light.
      let materials: THREE.Material[] = built.materials;
      let glowClones: THREE.Material[] | undefined;
      if (item.glow) {
        glowClones = [];
        materials = built.materials.map((material) => {
          if (!(material instanceof THREE.MeshStandardMaterial)) return material;
          const clone = material.clone();
          clone.emissive.setHex(item.glow!.color);
          clone.emissiveIntensity = item.glow!.intensity;
          glowClones!.push(clone);
          return clone;
        });
      }
      const mesh = new THREE.Mesh(built.geometry, materials);
      // Rigid equipment has geometry-local bounds. Three transforms them by this frame's
      // bone-driven matrixWorld for each camera, including the shadow camera.
      mesh.frustumCulled = true;
      mesh.userData["build"] = key;
      mesh.userData["builtModel"] = built;
      if (glowClones !== undefined) mesh.userData["glowClones"] = glowClones;
      mesh.position.copy(attachmentOffset(wvm, template.pivots, item.point));
      // Hip-sheathed blades point down the leg rather than forward from the grip.
      const hang = attachmentRotation(item.point);
      if (hang) mesh.quaternion.copy(hang);
      bone.add(mesh);
      this.#programWarmup.registerObject(mesh, "unit");
      unit.attached.set(where, mesh);
      unit.shadowCaster = undefined;
    }
  }

  /** Releases an attached mesh's queued warmup and own glow clones. Its build stays cached. */
  #disposeAttachedGlow(node: THREE.Object3D): void {
    this.#programWarmup.unregisterObject(node);
    const clones = node.userData["glowClones"] as THREE.Material[] | undefined;
    if (!clones) return;
    for (const clone of clones) clone.dispose();
    node.userData["glowClones"] = undefined;
  }

  #detachAll(unit: RenderedUnit): void {
    for (const node of unit.attached.values()) {
      this.#disposeAttachedGlow(node);
      node.removeFromParent();
    }
    unit.attached.clear();
    unit.shadowCaster = undefined;
  }

  /**
   * Empties a unit's node, whatever is in it: the stand-in capsule, a static mesh or a rigged
   * instance. Rebinding runs this every time the look changes, so a discarded instance has to let
   * go of its bones and its mixer or a busy street leaks one of each per costume change.
   */
  #clearUnitNode(unit: RenderedUnit): void {
    this.#programWarmup.unregisterObject(unit.node);
    // Before anything is unparented or disposed, while the meshes that borrowed still exist: the
    // shared arrays go back to builds that are about to be handed to somebody else, and the copies
    // are disposed here rather than left to the meshes that are being thrown away.
    this.#releaseUnitOpacity(unit);
    // And the wanted value is forgotten with the model, so whatever stands here next is faded from
    // scratch instead of inheriting a "already at 0.35" that no mesh is wearing any more.
    unit.unitOpacity = 1;
    // First, because the rider's root is a child of one of the mount's bones while it is up there
    // and `unit.node.remove` below would not reach it — the instance would be emptied out of the
    // scene with its mixer and its skeleton still live, hanging off a horse nobody can see.
    this.#dropMount(unit);
    this.#detachAll(unit);
    // Hard: the mixer this overlay belongs to is disposed three lines down, so there is nothing
    // for a fade to run on and nothing that could see it.
    this.#clearOverlay(unit, true);
    const previous = unit.skinned;
    disposeSkinnedInstance(previous);
    unit.node.remove(...unit.node.children);
    unit.shadowCaster = undefined;
    unit.body = undefined;
    unit.built = undefined;
    delete unit.wvm;
    delete unit.visual;
    delete unit.decodedModel;
    delete unit.legacyGeometry;
    delete unit.materialEntries;
    unit.skinned = undefined;
    unit.template = undefined;
    // Whatever goes in next writes its own; until it does there is no body to be the height of, and
    // a stale one would put the next capsule's name plate on the last model's head.
    delete unit.bodyHeight;
    unit.action = undefined;
    unit.animationId = -1;
    delete unit.admissionDisplayId;
    delete unit.admissionObjectScale;
    delete unit.admissionHasAuthoredAttachments;
    // A pose carried across a change of model would have the new one land from a jump the old one
    // took, so the unit starts again from whatever the next frame says it is doing.
    unit.pose = undefined;
    unit.overlayUntil = 0;
  }

  #useSkinned(unit: RenderedUnit, metadata: CreatureModelMetadata, key: string,
    template: SkinnedTemplate, instance: SkinnedInstance, built?: BuiltModel): void {
    this.#clearUnitNode(unit);
    unit.node.add(instance.root);
    // Retain the opaque program before spawn fading temporarily borrows transparent materials, on
    // the unit budget scenery streaming cannot evict (the fade copies' stand-ins join it in
    // `#trackUnitMeshes`, on this same frame).
    this.#programWarmup.registerObject(instance.root, "unit");
    unit.skinned = instance;
    unit.template = template;
    unit.built = built;
    // The record's own scale, and only for the moment: `#drawUnit` multiplies the server's
    // `OBJECT_FIELD_SCALE_X` into `unit.scale` on this same frame, and from then on the field means
    // the size the unit is *drawn* at — which is what the portrait, the name plate and the camera
    // pivot each want. `height` is kept as its multiple, here and there.
    unit.scale = metadata.scale;
    unit.node.scale.setScalar(metadata.scale);
    unit.bodyHeight = template.height;
    unit.height = template.height * metadata.scale;
    unit.animationId = -1;
    delete unit.actionKind;
    unit.applied = key;
  }

  /**
   * A pose the spell visuals asked for, in the layer its phase belongs to.
   *
   * `hold` is how long a held pose lasts — the cast time for a precast, the aura for a state — and
   * a one-shot runs once and ends. A lead-in (`StartAnimID`) plays once, then hands over to the
   * kit's own `AnimID`; the entry is held when that follow-up is.
   */
  #setUnitAnimation(animation: VisualAnimation, source: "external" | "visual",
    visualHandle?: SpellVisualHandle): void {
    const now = performance.now();
    const at = Number.isFinite(animation.at) ? animation.at : now;
    const primary = animation.followUp ?? animation;
    const held = (primary.mode ?? (primary.hold > 0 ? "hold" : "once")) === "hold";
    // A held pose ends at its authored moment; a one-shot may still start for the sidecar window.
    // A late frame therefore cannot resurrect a hold whose end has already passed.
    const until = held ? (primary.hold > 0 ? at + primary.hold : 0) : now + ACTION_SIDECAR_WAIT;
    this.#submitUnitAction(animation.guid, {
      layer: animation.layer ?? (held ? "cast" : "reaction"),
      held,
      until,
      ...(visualHandle === undefined ? {} : { owner: visualHandle }),
      payload: {
        wanted: [animation.animation],
        action: undefined,
        stage: animation.followUp ? "lead" : "main",
        ...(animation.followUp
          ? { followUp: { animation: animation.followUp.animation, mode: animation.followUp.mode } }
          : {}),
        sequenceAt: 0,
        waitUntil: now + ACTION_CLIP_WAIT,
        sidecarWaitUntil: now + ACTION_SIDECAR_WAIT,
        source,
      },
    }, now);
  }

  /** A swing or a shot (melee layer) — or, for the unused spell kinds, a cast. */
  playUnitAction(guid: bigint, action: UnitAction, hold = 0): void {
    const now = performance.now();
    const layer: UnitActionLayer = action === "precast" || action === "cast" || action === "channel" ? "cast"
      : action === "loot" ? "emote" : "melee";
    this.#submitUnitAction(guid, {
      layer,
      held: hold > 0,
      until: now + (hold > 0 ? hold : ACTION_SIDECAR_WAIT),
      payload: {
        wanted: [], action, stage: "main", sequenceAt: 0,
        // Shoot is delivered before a player's appearance/item rows can be complete, so it gets a
        // bounded metadata window longer than the ordinary animation-sidecar wait; a newer shot
        // replaces an older one in the melee layer, which is the stale-shot guard.
        waitUntil: now + (action === "shoot" ? SHOOT_METADATA_WAIT : ACTION_CLIP_WAIT),
        // A shoot never reaches this deadline: `pendingActionExpired` still retires it at its own
        // metadata window, which is deliberately left alone.
        sidecarWaitUntil: now + ACTION_SIDECAR_WAIT,
        source: "external",
      },
    }, now);
  }

  /** An emote, which the server names by animation rather than by kind. */
  playUnitEmote(guid: bigint, animation: number, hold = 0): void {
    const now = performance.now();
    this.#submitUnitAction(guid, {
      layer: "emote",
      held: hold > 0,
      until: now + (hold > 0 ? hold : ACTION_SIDECAR_WAIT),
      payload: {
        wanted: [animation], action: undefined, stage: "main", sequenceAt: 0,
        waitUntil: now + ACTION_CLIP_WAIT, sidecarWaitUntil: now + ACTION_SIDECAR_WAIT,
        source: "external",
      },
    }, now);
  }

  /** Stop only a held precast/channel; ordinary one-shots and locomotion are untouched. */
  cancelUnitAction(guid: bigint): void {
    const queue = this.#actions.get(guid);
    if (!queue) return;
    queue.removeWhere((entry) => entry.layer === "cast" && entry.held);
    if (queue.idle) this.#actions.delete(guid);
  }

  #submitUnitAction(guid: bigint, request: Parameters<UnitActionQueue<UnitActionPayload, ShownUnitAction>["submit"]>[0],
    now: number): void {
    let queue = this.#actions.get(guid);
    if (!queue) {
      queue = new UnitActionQueue<UnitActionPayload, ShownUnitAction>();
      this.#actions.set(guid, queue);
    }
    queue.submit(request, now);
    if (queue.idle) this.#actions.delete(guid);
  }

  /**
   * Puts the unit in the pose the server says it is in, and plays the one-shot that belongs
   * between two poses.
   *
   * The pose is read from the movement flags of the last packet about this unit — including the
   * player's own, because the client writes its flags into the state as it sends them. So the
   * character swims because it told the server it is swimming, which is the only version of
   * "swimming" that matters; there is no second, local notion that could disagree with it.
   */
  #animateUnit(unit: RenderedUnit, object: WorldObjectState, dead: boolean, self: boolean,
    distance: number, now: number, elapsed: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): void {
    const template = unit.template!;
    const skinned = unit.skinned!;
    const hadPendingAction = this.#actions.has(object.guid);
    const previousAction = unit.action;
    const previousOverlayAction = unit.overlayAction;
    const previousMountAction = unit.mount?.action;
    const pose: UnitPose = {
      // A feigned death lies down too (`appearsDead`): the pose follows the dead flag the server
      // raises, while `dead` itself stays the health-based answer targeting and loot rely on.
      dead: dead || appearsDead(object),
      movementFlags: object.movementFlags,
      spline: object.motion !== undefined,
      // Flight is authoritative in the ordinary movement word. A spline can carry its own
      // flying bit while the word is absent, so preserve that server-side fallback as well.
      flight: isUnitFlying(object.movementFlags, object.motion?.flying === true),
      // The spline says how far it goes and how long it takes, which is the only honest speed
      // available for a unit nobody is driving: the walking flag is never set for one.
      ...(object.motion && object.motion.duration > 0
        ? { speed: object.motion.totalLength / (object.motion.duration / 1000) }
        : {}),
      standState: unitFields.standState(object) ?? UNIT_STAND_STATE_STAND,
      // Which tier a hovering unit animates on: the server's word, not the movement bit's. A unit
      // whose byte has not arrived is on the ground tier, which is what the core writes by default.
      // A spline's own tier (a drake's takeoff or landing) overrides it once its effect begins.
      animationTier: splineAnimationTier(object, now) ?? unitFields.animationTier(object) ?? 0,
      // The built mount rather than the field, so a rider whose horse has not downloaded keeps
      // running instead of gliding along in the seated pose with nothing underneath.
      mounted: unit.mount !== undefined,
      // Worked out once per frame in `#drawUnit`, because the same answer decides the fade. Only
      // the stealth half reaches the pose: an invisible mage walks normally.
      stealth: unit.stealthed === true,
    };
    // 11.02-H: the vehicle seat this unit sits in, when the tables know it; absent otherwise.
    const vehicleSeat = unit.mount === undefined ? this.#vehiclePassengers.seatPose(object) : undefined;
    if (vehicleSeat !== undefined) pose.vehicleSeat = vehicleSeat;
    // Stride tempo before anything poses: the gait scaler below reads it, and the node already
    // stands where this frame drew it.
    unit.strideSpeed = this.#strideSpeed(unit, unit.node.position, elapsed);
    // The mount is the thing that walks, swims and flies, so it takes the same pose the rider
    // would have taken on foot — but only the travelling half of it. The sanitising is `mountPose`
    // and it happens inside `#poseMount`, which is the only place that holds the mount's own clips
    // and can therefore let an airborne pose fail open. Chosen here and stepped below with the
    // rider's, for the same off-screen reason.
    //
    // The speed is the rider's, because the rider is the unit the server sends rates for; the
    // horse is a display id with no movement of its own. It is what turns the authored stride into
    // a gait: without it a hasted mount replays a 6.94 yd/s stride while travelling at 14.
    this.#poseMount(unit, object.guid, pose, now, client,
      unitTravelSpeed(pose, object.speeds, object.runSpeed));

    // A transition one-shot owns the unit until it is over: a landing that is crossfaded away after
    // two frames is a landing nobody sees. Packet poses no longer gate the pass — `#poseUnit` runs
    // under them every frame, which is how a cast moves to the upper body the frame the unit starts
    // moving and how a stronger request takes over at once (`#showUnitAction` clears the gate).
    // A death clip is a terminal one-shot. Once it has clamped, leave it alone until health
    // changes; otherwise the normal per-frame pose pass resets the same action and the corpse
    // visibly dies forever. A true -> false transition is always allowed through, so respawn
    // immediately selects the live pose even if the death clip had not finished yet.
    const terminalPose = isTerminalUnitPose(pose);
    // A moving cast intentionally owns only the upper body. Death/corpse is terminal, however:
    // leaving that overlay alive makes a dead unit keep casting or shooting until its authored
    // fade window ends. Clear it before selecting the terminal base pose.
    if (terminalPose && unit.overlayPreservesLocomotion === true) this.#clearOverlay(unit);
    const previousTerminalPose = unit.pose === undefined ? undefined
      : isTerminalUnitPose(unit.pose);
    const deathTransition = previousTerminalPose !== terminalPose;
    const terminalAction = unit.overlayAction ?? unit.action;
    const terminalAnimationId = unit.overlayAnimationId ?? unit.animationId;
    const terminalDeath = terminalPose && !deathTransition
      && terminalAnimationId === ANIMATION_IDS.Death
      && terminalAction?.clampWhenFinished === true;
    if (deathTransition || unit.overlayPreservesLocomotion === true
      || (now >= unit.overlayUntil && !terminalDeath)) {
      this.#poseUnit(unit, object.guid, pose, now, client, metadata);
    }
    unit.pose = pose;
    // Chosen and scheduled above whatever happens next: a clip queued while the unit is off
    // screen must be the one playing when it returns. An invisible unit retains the old paused
    // mixer policy; a visible distant unit instead accumulates every skipped frame's elapsed time
    // and advances the rig on its next scheduled pose tick.
    this.#unitSphere.center.copy(unit.node.position);
    this.#unitSphere.radius = Math.max(1, unit.height);
    // A static portrait needs one current world pose before its independent snapshot is painted;
    // after that, an offscreen target has no reason to advance its live mixer just for the HUD.
    const portraitNeedsPose = this.#portraits.needsPose(object.guid);
    const mount = unit.mount;
    if (!portraitNeedsPose && !this.#frustum.intersectsSphere(this.#unitSphere)) {
      skinned.skeleton.setPoseFrozen(true);
      mount?.skinned?.skeleton.setPoseFrozen(true);
      return;
    }
    // Server actions, combat, selection and bone-attached emitters need every pose. Small authored
    // billboard cards use the distance cadence too: common character bodies have two of them,
    // and exempting every such body would disable crowd LOD entirely.
    // The ordinary locomotion/idle crowd can reuse a pose for a few render frames; its mixer
    // receives all elapsed time in one step, so clip phase and one-shot duration do not slow down.
    const important = self || this.#selection.target?.guid === object.guid
      || this.#selection.focus?.guid === object.guid
      || ((object.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset) ?? 0) & UNIT_FLAG_IN_COMBAT) !== 0
      || hadPendingAction || this.#actions.has(object.guid) || portraitNeedsPose
      || unit.action !== previousAction || unit.overlayAction !== previousOverlayAction
      || mount?.action !== previousMountAction
      || (unit.action?.loop === THREE.LoopOnce && unit.action.isRunning())
      || unit.overlayAction?.isRunning() === true
      || (mount?.action?.loop === THREE.LoopOnce && mount.action.isRunning())
      || this.#mountSpecials.has(object.guid)
      || (unit.wvm !== undefined && unit.wvm.particleEmitters.length + unit.wvm.ribbonEmitters.length > 0)
      || (mount?.wvm !== undefined && mount.wvm.particleEmitters.length + mount.wvm.ribbonEmitters.length > 0);
    const cadenceMs = unitAnimationCadenceMs(distance, important);
    if (important) this.#unitAnimationCritical++;
    else if (cadenceMs === 0) this.#unitAnimationNear++;
    else if (distance < UNIT_ANIMATION_FAR_DISTANCE) this.#unitAnimationMedium++;
    else this.#unitAnimationFar++;
    if (unit.animationClockRig !== skinned || unit.animationClockMountRig !== mount?.skinned
      || unit.animationClock === undefined) {
      unit.animationClockRig = skinned;
      unit.animationClockMountRig = mount?.skinned;
      // Mix low and high GUID words before taking the phase: sequential local GUIDs must not all
      // spend their animation slice on the same frame.
      const mixedGuid = object.guid ^ (object.guid >> 32n);
      unit.animationClock = {
        pendingSeconds: 0, nextStepAtMs: undefined, previousNowMs: undefined, intervalMs: 0,
        phase: Number((mixedGuid * 137n) % 251n) / 251,
      };
    }
    const poseElapsed = stepUnitAnimationClock(unit.animationClock, now, elapsed, cadenceMs);
    if (poseElapsed === undefined) {
      this.#unitAnimationSkipped++;
      skinned.skeleton.setPoseFrozen(true);
      mount?.skinned?.skeleton.setPoseFrozen(true);
      return;
    }
    this.#unitAnimationFull++;
    // The flat pose when this frame allows one: the same mixer clock and blend, for only the bones
    // something draws or reads, with none of the per-bone scene-graph writes. See `FastPoseState`.
    const flat = !portraitNeedsPose && this.#strafeYawIdle(unit, template, pose)
      ? this.#flatPose(unit, unit.wvm, mount?.skinned === undefined) : undefined;
    const mountFlat = flat === undefined || !mount?.skinned ? undefined : this.#flatPose(mount, mount.wvm, false);
    if (flat !== undefined && (mount?.skinned === undefined || mountFlat !== undefined)) {
      this.#unitAnimationFlat++;
      // The mount first, as below: the rider hangs off its saddle and its billboards face the
      // camera from where that saddle is this frame. Global sequences have the last word over the
      // clips, as `applyGlobalSequenceBones` has after `mixer.update`.
      if (mount?.skinned && mount.template && mountFlat instanceof FastPoseState) {
        mountFlat.advance(mount.skinned.mixer, poseElapsed);
        if (mount.wvm) writeGlobalSequenceLocals(mount.template, mount.wvm.globalSequences, now, mountFlat);
        mountFlat.compose(mount.skinned.root, this.#camera);
        mount.skinned.skeleton.setFastPoseActive(true, mount.skinned.mixer);
      }
      flat.advance(skinned.mixer, poseElapsed);
      // The worker's pose applies the global sequences inside its step; this one right here.
      if (unit.wvm) {
        if (flat instanceof SharedPose) flat.globalSequences(template, unit.wvm.globalSequences, now);
        else writeGlobalSequenceLocals(template, unit.wvm.globalSequences, now, flat);
      }
      // The worker's compose publishes the step; the rig's first reader completes it.
      flat.compose(skinned.root, this.#camera);
      skinned.skeleton.setFastPoseActive(true, skinned.mixer);
      return;
    }
    // Leaving the flat pose makes this step write every bound bone again; see `setFastPoseActive`.
    skinned.skeleton.setFastPoseActive(false, skinned.mixer);
    if (mount?.skinned) mount.skinned.skeleton.setFastPoseActive(false, mount.skinned.mixer);
    skinned.skeleton.setPoseFrozen(false);
    skinned.mixer.update(poseElapsed);
    if (unit.wvm) applyGlobalSequenceBones(skinned, template, unit.wvm.globalSequences, now);
    // The legs into the direction of travel, over the clip the mixer just wrote. Self and remote
    // alike: the flags this reads are the ones in the last packet about the unit, and the player's
    // own are written into that state as they are sent.
    this.#applyStrafeYaw(unit, template, pose, poseElapsed);
    // Before the rider's billboards, because the rider hangs off one of these bones: a card turned
    // against a saddle that has not moved yet is a card turned against last frame.
    if (mount?.skinned && mount.template) {
      mount.skinned.skeleton.setPoseFrozen(false);
      mount.skinned.mixer.update(poseElapsed);
      if (mount.wvm) applyGlobalSequenceBones(mount.skinned, mount.template,
        mount.wvm.globalSequences, now);
      applyBillboardBones(mount.skinned, mount.template, this.#camera, false);
    }
    // After the pose and not before it: a billboard bone overwrites what the mixer just wrote to
    // it, which is the whole point of the flag. The render pass propagates the final pose;
    // explicit spell attachment and emitter readers refresh the matrices they need beforehand.
    applyBillboardBones(skinned, template, this.#camera, false);
  }

  /**
   * This model's flat pose, or undefined when it has to be posed through Three's bone objects.
   *
   * The program computes the bones the geometry draws plus every bone something outside the
   * palette reads by index — attachment points (weapons, a saddle's rider, spell anchors) and
   * particle and ribbon emitters — with their ancestors. A reader that still asks for a bone
   * outside it sends the rig back to Three's path for good; additive layers go back per frame.
   */
  #flatPose(model: PosedModel, wvm: WvmModel | undefined, shareable: boolean): FastPoseState | SharedPose | undefined {
    const skinned = model.skinned, template = model.template;
    if (!skinned || !template) return undefined;
    const skeleton = skinned.skeleton;
    if (skeleton.takeFullPoseRequest()) this.#fullPoseRigs.add(skeleton);
    if (this.#fullPoseRigs.has(skeleton) || !FastPoseState.supports(skinned.mixer)) return undefined;
    if (model.flatPoseTemplate !== template) {
      const read: number[] = [];
      if (wvm) {
        for (const attachment of wvm.attachments) read.push(attachment.bone);
        for (const emitter of wvm.particleEmitters) read.push(emitter.bone);
        for (const ribbon of wvm.ribbonEmitters) read.push(ribbon.bone);
      }
      model.flatPoseTemplate = template;
      model.flatPoseProgram = fastPoseProgramFor(template, read);
    }
    const program = model.flatPoseProgram;
    if (program === undefined) return undefined;
    // The pose worker when there is one and this rig can be posed there this step; see `SharedPose`.
    const engine = this.#poseEngine;
    if (shareable && engine?.usable) {
      const shared = skeleton.sharedPose(program, engine, skinned.mixer, template, wvm?.globalSequences);
      if (shared) return shared;
    }
    return skeleton.fastPose(program);
  }

  /** The pose worker's counters since the last reset, or undefined when there is no worker. */
  poseWorkerStats(reset = false): (PoseEngineStats & { readonly workersReady: number; readonly failure?: string }) | undefined {
    const engine = this.#poseEngine;
    if (!engine) return undefined;
    const failure = engine.failure;
    const stats = { ...engine.stats, workersReady: engine.workersReady, ...(failure === undefined ? {} : { failure }) };
    if (reset) engine.resetStats();
    return stats;
  }

  /**
   * Whether the strafe turn has nothing to do this frame: no turn standing and none wanted. The
   * turn is a bone-object correction on Three's path, so a unit mid-turn stays there until it has
   * unwound to zero.
   */
  #strafeYawIdle(unit: RenderedUnit, template: SkinnedTemplate, pose: UnitPose): boolean {
    if ((unit.strafeYaw ?? 0) !== 0) return false;
    return strafeYawBonesFor(template) === undefined
      || strafeYawTarget(pose, unit.action ? unit.animationId : undefined) === 0;
  }

  /**
   * Turns this unit's lower body toward where it is actually going.
   *
   * The owner's report: "the legs should point into the direction of movement; right now the
   * animation runs forward while the character travels at an angle". The original turns the lower
   * body procedurally and keeps the torso on the facing; the table, the rate and the reason each
   * row is what it is live in `strafeYawTarget`, out where a test can drive them.
   *
   * The turn is stepped every frame the unit is posed, including the frames its target is zero, so
   * releasing a strafe key unwinds at the same bounded rate it wound up at. The bones are resolved
   * once per rig and remembered on the template; a rig that cannot answer gets no turn at all and
   * still keeps its stored angle at zero.
   */
  #applyStrafeYaw(unit: RenderedUnit, template: SkinnedTemplate, pose: UnitPose,
    elapsed: number): void {
    const bones = strafeYawBonesFor(template);
    // The clip that is really playing, because a rig with an authored sidestep needs no turn for a
    // pure strafe and a rig without one needs the whole quarter.
    const target = bones === undefined
      ? 0 : strafeYawTarget(pose, unit.action ? unit.animationId : undefined);
    const yaw = stepStrafeYaw(unit.strafeYaw ?? 0, target, elapsed);
    unit.strafeYaw = yaw;
    if (bones && unit.skinned) applyStrafeYaw(unit.skinned, bones, yaw);
  }

  /**
   * The gait of the horse, chosen from the travelling half of the rider's pose and from nothing
   * else about the rider.
   *
   * Three things happen here that did not before, and all three are the same defect seen from
   * different sides — the rider's whole state was reaching the mount.
   *
   * (1) `mountPose` takes off everything that is not travel: the stand state and death. A sitting
   * rider used to sit the horse down and a dead one used to play its Death.
   * (2) The mount gets the jump one-shots the rider deliberately does not. `poseTransition`
   * refuses every mounted pose, which is right for the character in the saddle and left the animal
   * under it snapping between its gait and its airborne loop with nothing in between.
   * (3) The gait is replayed at the speed the unit is actually travelling rather than at the one
   * its author built the stride for. Only the persistent gait is scaled; a one-shot — the special,
   * a takeoff, a landing — keeps its authored timing, and so does the rider.
   *
   * `SMSG_MOUNTSPECIAL_ANIM` is the one protocol edge that addresses the mount indirectly: its
   * payload is the rider guid, while the one-shot is authored on the mount node. It is handled
   * before the gait and then the normal gait resumes when the clip's authored duration ends.
   */
  #poseMount(unit: RenderedUnit, guid: bigint, rider: UnitPose, now: number,
    client: EnvironmentClient | undefined, speed?: number): void {
    const mount = unit.mount;
    if (!mount?.skinned || !mount.template) return;
    // The mount's own clips decide whether an airborne pose can be answered at all, which is why
    // the sanitising cannot happen at the call site.
    const pose = mountPose(rider, mount.template.clips);

    const specialUntil = this.#mountSpecials.get(guid);
    if (specialUntil !== undefined) {
      if (now >= specialUntil) {
        this.#mountSpecials.delete(guid);
      } else {
        const animation = mountSpecialAnimation(pose.flight === true);
        if (animation !== undefined) {
          // The special sequence is commonly external to the mount M2. Request it through the
          // same exact-rig sidecar route as the gait, then consume the ticket only after a clip
          // really exists. A missing/unsupported sequence therefore never replaces the gait.
          this.#requestAnimations(mount.template, [animation], client, mount.metadata);
          if (mount.template.clips.has(animation)) {
            this.#playAnimation(mount, animation, false, now, true);
            this.#mountSpecials.delete(guid);
            mount.pose = pose;
            return;
          }
        }
      }
    }

    // The mount's `action` is normally the persistent gait. A special is a full-body one-shot,
    // and must keep owning the mount until its authored window ends or the gait would restart it
    // on every frame and make the trick invisible. A takeoff and a landing are the same shape and
    // are held by the same guard.
    //
    // The remembered pose is updated even while the one-shot owns the mount, and that is not
    // bookkeeping: leaving it behind would make the ground -> air change fire again the moment
    // JumpStart's window closed, and the horse would take off twice on one jump.
    if (mount.action?.loop === THREE.LoopOnce && mount.action.isRunning()
      && now < mount.overlayUntil) {
      mount.pose = pose;
      return;
    }

    // The mount's own poseTransition. `resolveAnimation` and not the seat resolver: this is the
    // animal's locomotion, in the same family as any unit's, and a rig without a takeoff clip
    // simply gets undefined and keeps its gait — Gryphon carries none of 37/38/39/40.
    const transition = mountPoseTransition(mount.pose, pose);
    const takeoff = transition === undefined
      ? undefined
      : resolveAnimation(mount.template.clips, [transition]);
    if (takeoff !== undefined) {
      this.#playAnimation(mount, takeoff, false, now);
      mount.pose = pose;
      return;
    }

    // The horse changes gait when the rider strafes and the rider does not — the seat pose is
    // chosen before any movement arm reaches `poseAnimation` — so the mount needs the same commit
    // window a unit has, and needs it more: a rider circling a target asks the animal for a new
    // stride twice a second. The window is applied here, between choosing and playing, so that both
    // the play call and the gait scaling below are told the same thing: what is really playing.
    const wanted = chooseAnimation(mount.template.clips, pose);
    const chosen = wanted === undefined
      ? undefined
      : { animation: this.#commitGait(mount, wanted.animation, now), loop: wanted.loop };
    if (chosen) {
      this.#playAnimation(mount, chosen.animation, chosen.loop, now);
      // After the play call and never before it: `#playAnimation` puts every action it starts or
      // restarts back on the authored rate, so a gait scaled first would be flattened again.
      this.#applyMountGait(mount, chosen.animation, chosen.loop, speed);
    }
    this.#requestAnimations(mount.template, poseAnimation(pose).wanted, client, mount.metadata);
    mount.pose = pose;
  }

  /**
   * Replays the mount's stride at the speed the unit is really travelling.
   *
   * The stride is authored for one speed — RidingHorse's Run for 6.9444 yards a second, its Walk
   * for 2.5 — and the renderer used to play every one of them at exactly that rate whatever the
   * unit was doing, which is the skating the owner reports: a mount at +100% covers 14 yards a
   * second with a stride built for 7.
   *
   * The rate is read back off the action rather than remembered, because `#playAnimation` resets
   * it to 1 whenever it starts or restarts a clip and a cached copy would go stale on exactly
   * those frames. `mountGaitTimeScale` quantises, so this comparison fails — and the write
   * happens — only when the speed has really moved a step.
   */
  #applyMountGait(mount: RenderedMount, animation: number, loop: boolean, speed: number | undefined): void {
    const action = mount.action;
    if (!action || !loop) return;
    const scale = mountGaitTimeScale(speed, clipMovingSpeed(mount.template?.clips.get(animation)));
    if (Math.abs(action.getEffectiveTimeScale() - scale) > 1e-6) action.setEffectiveTimeScale(scale);
  }

  /**
   * How fast the drawn node is really travelling, in yards a second.
   *
   * Measured off the node rather than read off the wire: the mover's packets name destinations,
   * and only the forced-rate table (which lives on the client for self) names speeds. Teleports
   * and update snaps cross more ground in a frame than any stride — the same 25 yards the glide
   * path snaps past — and read as no measurement rather than as a sprint.
   *
   * `elapsed` is seconds, the unit `mixer.update` and the rest of this file run on.
   */
  #strideSpeed(unit: RenderedUnit, position: THREE.Vector3, elapsed: number): number | undefined {
    const previous = unit.strideReady ? { x: unit.strideX, y: unit.strideY, z: unit.strideZ } : undefined;
    unit.strideX = position.x;
    unit.strideY = position.y;
    unit.strideZ = position.z;
    unit.strideReady = true;
    if (!previous) return undefined;
    return measuredTravelSpeed(
      Math.hypot(position.x - previous.x, position.y - previous.y, position.z - previous.z), elapsed);
  }

  /**
   * Replays a unit's stride at its measured travelling speed.
   *
   * The mount version of this fixed the skating; units had the same defect everywhere speeds
   * change — sprint, slow, and every strafe, whose sidestep is authored standstill. Only looping
   * locomotion gaits are touched, so one-shots (takeoff, landing, reactions) keep authored timing
   * and the airborne loop keeps its ballistic rate. The rate is read back off the action because
   * `#playAnimation` resets it to 1 whenever it starts or restarts a clip.
   */
  #applyUnitGait(unit: RenderedUnit, animation: number, loop: boolean): void {
    const action = unit.action;
    if (!action || !loop || !isLocomotionGait(animation)) return;
    const scale = unitGaitTimeScale(
      unit.strideSpeed, locomotionAuthoredSpeed(unit.template?.clips, animation, unit.strideSpeed));
    if (Math.abs(action.getEffectiveTimeScale() - scale) > 1e-6) action.setEffectiveTimeScale(scale);
  }

  /**
   * The unit's pose for this frame: a packet pose if one owns it, over or instead of its own.
   *
   * Which request owns the unit is `UnitActionQueue`'s answer; where it is drawn is decided here.
   * Over plain standing it takes the whole body. Over any other base — moving, mounted, swimming,
   * sitting, crouched — an upper-body-capable pose plays on the upper layer while the base keeps
   * every track the pose does not key, and a whole-body pose gives way unless it is an aura state.
   */
  #poseUnit(unit: RenderedUnit, guid: bigint, pose: UnitPose, now: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): void {
    const display = this.#showUnitAction(unit, guid, pose, now, client, metadata);
    if (display === "full") return;
    if (display === "upper") {
      this.#poseBase(unit, pose, now, client, metadata, unit.overlayAction?.getClip());
      return;
    }
    // Nothing of the packets' on show: an overlay left behind by anything is faded, not kept.
    if (unit.overlayPreservesLocomotion === true) this.#clearOverlay(unit);

    const transition = poseTransition(unit.pose, pose);
    const overlay = transition === undefined ? undefined : resolveAnimation(unit.template!.clips, [transition]);
    if (overlay !== undefined) {
      this.#playAnimation(unit, overlay, false, now);
      return;
    }
    this.#poseBase(unit, pose, now, client, metadata);
  }

  /** Settles and shows this unit's packet pose; the part of the body it took, or undefined. */
  #showUnitAction(unit: RenderedUnit, guid: bigint, pose: UnitPose, now: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): "full" | "upper" | undefined {
    const queue = this.#actions.get(guid);
    if (!queue) return undefined;
    // A pose put on a model that has since been rebuilt is no longer on show anywhere.
    if (queue.shown && !this.#unitShows(unit, queue.shown)) queue.shown = undefined;
    const display = this.#settleUnitAction(unit, queue, pose, now, client, metadata);
    if (queue.idle) this.#actions.delete(guid);
    return display;
  }

  #unitShows(unit: RenderedUnit, shown: ShownUnitAction): boolean {
    return shown.slot === "full" ? unit.action === shown.action : unit.overlayAction === shown.action;
  }

  #settleUnitAction(unit: RenderedUnit, queue: UnitActionQueue<UnitActionPayload, ShownUnitAction>,
    pose: UnitPose, now: number, client: EnvironmentClient | undefined,
    metadata: UnitModel | undefined): "full" | "upper" | undefined {
    if (isTerminalUnitPose(pose)) {
      queue.clear();
      this.#releaseUnitAction(unit, queue);
      return undefined;
    }
    // Before anything expires: a lead-in's follow-up inherits its entry, and with it the deadline.
    for (const entry of queue.entries) this.#advanceLeadIn(entry, now);
    queue.expire(now);
    if (isUnitMoving(pose.movementFlags, pose.spline)) {
      queue.removeWhere((entry) => unitActionEndsOnMovement(entry.layer, entry.held));
    }
    // The base is idle when the unit's own pose is plain standing; anything else keeps the legs.
    const baseIdle = poseAnimation(pose).wanted[0] === ANIMATION_IDS.Stand;
    for (let entry = queue.top(); entry !== undefined; entry = queue.top()) {
      const animation = this.#entryAnimation(unit, entry, now, client, metadata);
      if (animation === "drop") {
        queue.remove(entry);
        continue;
      }
      if (animation === "wait") break;
      // Upper-body only where the rig has a cut for it: a rig with no leg branches keeps the whole
      // clip as its "overlay", and drawing that over a gait would slide the action's own legs.
      const overlay = unit.template!.overlayClips?.get(animation);
      const upperBody = animationPlaysOnUpperBody(animation) && overlay !== undefined
        && overlay !== unit.template!.clips.get(animation) && overlay.tracks.length > 0;
      const display: UnitActionDisplay = unitActionDisplay(entry.layer, upperBody, baseIdle);
      if (display === "yield") {
        // A one-shot that cannot be drawn over this base is over; a hold waits for the base to settle.
        if (entry.held) break;
        queue.remove(entry);
        continue;
      }
      this.#startUnitAction(unit, queue, entry, animation, display, now);
      return display;
    }
    this.#releaseUnitAction(unit, queue);
    return undefined;
  }

  /** A lead-in whose clip has run hands its entry over to the kit's own pose. */
  #advanceLeadIn(entry: UnitActionEntry<UnitActionPayload>, now: number): void {
    const pending = entry.payload;
    if (pending.stage !== "lead" || !pending.followUp || pending.sequenceAt === 0 || now < pending.sequenceAt) return;
    pending.stage = "main";
    pending.wanted = [pending.followUp.animation];
    pending.sequenceAt = 0;
    pending.waitUntil = now + ACTION_CLIP_WAIT;
    pending.sidecarWaitUntil = now + ACTION_SIDECAR_WAIT;
    delete pending.waitingForClip;
    entry.started = false;
    if (!entry.held) entry.until = now + ACTION_SIDECAR_WAIT;
  }

  /**
   * The clip a queued pose resolves to on this rig now, or whether to wait for its keyframes.
   *
   * A spell kit asks for what it might end up playing, promotions included: the pose that answers
   * a kit naming 31/32/33 on a character is 51/52/53/54, and the request list is what decides
   * whether those keyframes are ever fetched. A missing clip waits only while the model promises
   * it and the sidecar is really coming (`pendingActionFate`).
   */
  #entryAnimation(unit: RenderedUnit, entry: UnitActionEntry<UnitActionPayload>, now: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): number | "wait" | "drop" {
    const pending = entry.payload;
    const template = unit.template!;
    // Before resolving clips: a sidecar or appearance answer that arrives after the deadline must
    // not revive the shot that was already stale. Both deadlines are about starting; a pose that
    // has started runs to its own hand-back.
    if (!entry.started) {
      if (pendingActionExpired(pending.action, pending.stage === "main" && entry.held, now, pending.waitUntil)) {
        return "drop";
      }
      if (pending.waitingForClip && now >= pending.sidecarWaitUntil) return "drop";
    }
    const shootMetadataPending = pending.action === "shoot"
      && (metadata === undefined || metadata.appearance === undefined || metadata.appearancePending === true);
    // Do not use the inventory-type fallback while the live item row is unresolved: INVTYPE 26 is
    // shared by guns and wands, so choosing gun here would consume the one-shot before subclass 19
    // can arrive. Once the metadata settles, weaponPose selects the exact ranged release.
    const actionWeapon = pending.action === undefined || shootMetadataPending
      ? "unarmed"
      : weaponPose(metadata?.appearance?.attached, pending.action === "shoot" ? "ranged" : "melee");
    const wanted = pending.action === undefined ? pending.wanted : actionAnimation(pending.action, actionWeapon);
    const resolve = (available: ReadonlySet<number> | Map<number, unknown>): number | undefined =>
      pending.action === undefined
        ? resolveSpellVisualAnimation(available, wanted)
        : resolveActionAnimation(available, pending.action, actionWeapon);
    let animation = resolve(template.clips);
    if (animation === undefined) {
      if (now >= pending.sidecarWaitUntil) return "drop";
      pending.waitingForClip = true;
      const compilationPending = this.#requestAnimations(template,
        pending.action === undefined ? spellVisualAnimationCandidates(wanted) : wanted, client, metadata);
      // A resident sidecar can still be queued for CPU work: a clip completed by this slice plays now.
      animation = resolve(template.clips);
      if (animation === undefined) {
        const fate = pendingActionFate({
          hasClip: false,
          promised: resolve(template.animations) !== undefined,
          metadataPending: shootMetadataPending,
          // Asked of the client that owns the request, not inferred from the frame: the difference
          // between keyframes that are missing and keyframes that are being downloaded is the
          // difference between dropping the first cast and playing it a moment late.
          sidecarInFlight: compilationPending || (metadata !== undefined
            && client?.animationsInFlight(metadata.model, template.parents.length) === true),
          now,
          waitUntil: pending.waitUntil,
          sidecarWaitUntil: pending.sidecarWaitUntil,
        });
        return fate === "wait" ? "wait" : "drop";
      }
    }
    delete pending.waitingForClip;
    return animation;
  }

  /**
   * Puts one settled pose on show, on the part of the body `display` names.
   *
   * Nothing is ever stopped here. A pose taking over cross-fades from whatever held the slot; a
   * pose moving between the whole body and the upper layer (the unit started or stopped moving)
   * continues at its own phase; and a held pose replacing a one-shot of the same clip — a channel
   * after its release — keeps the running clip rather than restarting it.
   */
  #startUnitAction(unit: RenderedUnit, queue: UnitActionQueue<UnitActionPayload, ShownUnitAction>,
    entry: UnitActionEntry<UnitActionPayload>, animation: number, display: "full" | "upper", now: number): void {
    const template = unit.template!;
    const pending = entry.payload;
    // A lead-in plays once whatever follows it; a hold loops unless it is a one-way motion.
    const loop = pending.stage === "main" && entry.held && !heldClipPlaysOnce(animation);
    const shown = queue.shown;
    if (shown?.entry === entry && shown.animation === animation && shown.slot === display) return;
    const running = shown !== undefined && shown.animation === animation && shown.action.isRunning();
    if (running && shown.slot === display && entry.held) {
      // The same clip, now held: change how it ends, not where it is.
      shown.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      shown.action.clampWhenFinished = !loop;
      queue.shown = { ...shown, entry };
    } else if (running && shown.slot !== display && shown.entry === entry) {
      // The unit started or stopped moving under this pose: move it to the other layer at its phase.
      const phase = shown.action.time;
      if (display === "upper") {
        this.#playAnimation(unit, animation, loop, now, true, true, pending.action);
        if (unit.overlayAction) unit.overlayAction.time = phase;
      } else {
        this.#playAnimation(unit, animation, loop, now, true, false, pending.action);
        if (unit.action) unit.action.time = phase;
        this.#clearOverlay(unit);
      }
      queue.shown = this.#shownAs(unit, entry, animation, display);
    } else {
      if (display === "full" && unit.overlayPreservesLocomotion === true) this.#clearOverlay(unit);
      if (shown !== undefined && shown.animation === animation && shown.slot === display) {
        // A new one-shot of the clip already playing starts it again.
        shown.action.reset();
        shown.action.setEffectiveTimeScale(1);
        shown.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        shown.action.clampWhenFinished = !loop;
        shown.action.play();
      } else {
        this.#playAnimation(unit, animation, loop, now, true, display === "upper", pending.action);
      }
      queue.shown = this.#shownAs(unit, entry, animation, display);
    }
    // A packet pose never gates the pose pass: the next frame must still be able to move it to the
    // upper body, hand it back, or let a stronger request in.
    if (display === "full") unit.overlayUntil = 0;
    if (entry.started) return;
    entry.started = true;
    const clip = (display === "upper" ? template.overlayClips?.get(animation) : undefined) ?? template.clips.get(animation);
    // Handed back one blend before the clip ends, so the base pose cross-fades in as it finishes.
    const handBack = now + Math.max(0, ((clip?.duration ?? 0) - ACTION_ANIMATION_BLEND) * 1000);
    if (pending.stage === "lead") {
      pending.sequenceAt = handBack;
      if (!entry.held) entry.until = handBack + ACTION_SIDECAR_WAIT;
    } else if (!entry.held) {
      entry.until = handBack;
    }
  }

  #shownAs(unit: RenderedUnit, entry: UnitActionEntry<UnitActionPayload>, animation: number,
    slot: "full" | "upper"): ShownUnitAction | undefined {
    const action = slot === "full" ? unit.action : unit.overlayAction;
    return action === undefined ? undefined : { entry, animation, slot, action };
  }

  /**
   * Lets go of the pose on show without stopping it: the base pose chosen next cross-fades from a
   * released whole-body pose, and a released upper layer fades out over the gait. The cut this
   * replaced snapped the spell hands 0.92–1.0 yd (precast → Stand) and 1.1–1.55 yd (channel →
   * Stand) between two frames on HumanMale at every cast end, interrupt and channel end.
   */
  #releaseUnitAction(unit: RenderedUnit, queue: UnitActionQueue<UnitActionPayload, ShownUnitAction>): void {
    const shown = queue.shown;
    if (!shown) return;
    queue.shown = undefined;
    if (shown.slot === "upper") {
      if (unit.overlayAction === shown.action) this.#clearOverlay(unit);
      return;
    }
    if (unit.action === shown.action) unit.overlayUntil = 0;
  }

  /**
   * Holds a travelling gait for the length of its own blend before letting the next one in.
   *
   * The whole of the commit window's state is one deadline per model; the policy is
   * `commitLocomotion`, which is where the measurements and the reason are written. Only a gait
   * replacing a gait can ever be delayed, and only by 150 ms, so the answer this returns is the one
   * the pose pass asked for on every frame that is not inside a stride change.
   *
   * `chosen.loop` may be passed through unchanged by every caller: `chooseAnimation` returns
   * `loop: false` for exactly one animation, Death, and Death is not one of the gaits this can
   * hold, so a held answer is always a loop and the caller's flag is always already true.
   */
  #commitGait(unit: PosedModel, animation: number, now: number): number {
    const commit = commitLocomotion(
      unit.action ? unit.animationId : undefined, animation, unit.gaitCommittedUntil ?? 0, now,
    );
    unit.gaitCommittedUntil = commit.committedUntil;
    return commit.animation;
  }

  /**
   * Selects and updates only the persistent locomotion/stance layer.
   *
   * `overlay` is the upper-body pose playing over it, when one is: the base then plays the same
   * gait minus every track that pose keys (`locomotionUnderlayClip`), so each bone has one owner
   * instead of the even average Three's normalised blend made of two weight-1 layers.
   */
  #poseBase(unit: RenderedUnit, pose: UnitPose, now: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined, overlay?: THREE.AnimationClip): void {
    const chosen = chooseAnimation(unit.template!.clips, pose);
    if (chosen) {
      const gait = this.#commitGait(unit, chosen.animation, now);
      const full = overlay === undefined ? undefined : unit.template!.clips.get(gait);
      this.#playAnimation(unit, gait, chosen.loop, now, false, false, undefined,
        full === undefined || overlay === undefined ? undefined : locomotionUnderlayClip(full, overlay));
      this.#applyUnitGait(unit, gait, chosen.loop);
    }
    // What the pose asked for that this model has but has not downloaded yet. Asking is cheap and
    // the client only lets one request per model through. Deliberately the pose's own list and not
    // the committed gait: what may be drawn a fraction of a second from now still has to be here.
    this.#requestAnimations(unit.template!, poseAnimation(pose).wanted, client, metadata,
      poseAnimationFamily(pose));
  }

  #playAnimation(
    unit: PosedModel,
    animation: number,
    loop: boolean,
    now: number,
    fullDuration = false,
    preserveLocomotion = false,
    actionKind?: UnitAction,
    /** The base in another cut than the model's own — the gait under an upper-body pose. */
    baseClip?: THREE.AnimationClip,
  ): void {
    const template = unit.template!;
    const clip = preserveLocomotion
      ? (template.overlayClips?.get(animation) ?? template.clips.get(animation))
      : (baseClip ?? template.clips.get(animation));
    // Only record the animation once it is really playing, otherwise a model missing the clip
    // would be marked as switched and stay frozen in whatever it was doing before.
    if (!clip) return;
    const wantedLoop = loop ? THREE.LoopRepeat : THREE.LoopOnce;
    if (preserveLocomotion) {
      const current = unit.overlayAction;
      if (animation === unit.overlayAnimationId && current) {
        if (current.loop === wantedLoop && current.isRunning()) return;
        current.reset();
        // An action can be reused after a caller changed its local time scale. Reset it here so
        // authored clip timing is always the baseline; cross-fade must not inherit a fast cast.
        current.setEffectiveTimeScale(1);
        current.setLoop(wantedLoop, Infinity);
        current.clampWhenFinished = !loop;
        current.play();
        if (actionKind === undefined) delete unit.overlayActionKind;
        else unit.overlayActionKind = actionKind;
        delete unit.overlayFadeUntil;
        const fade = animationFadeWindow(clip.duration, fullDuration);
        unit.overlayUntil = loop ? 0 : now + fade.start * 1000;
        return;
      }
      const previous = current;
      const next = unit.skinned!.mixer.clipAction(clip);
      next.reset();
      next.setEffectiveTimeScale(1);
      next.setLoop(wantedLoop, Infinity);
      next.clampWhenFinished = !loop;
      next.setEffectiveWeight(1);
      next.play();
      if (previous && previous !== next) {
        const blend = animationBlend(previous.loop === THREE.LoopRepeat, loop, clipBlendTime(clip));
        const transition = animationTransition(previous.isRunning(), true);
        if (transition === "stop") previous.stop();
        else if (transition === "crossfade") next.crossFadeFrom(previous, blend.duration, blend.warp);
        else if (transition === "fade") {
          // Deliberately not `crossFadeFrom`: it synchronises the two actions' clocks, and this
          // predecessor is a finished one-shot clamped on its last frame with no clock to
          // synchronise. Two independent ramps do the same visual job — the clamped pose goes out
          // over the same window the new one comes in — without the time coupling.
          previous.fadeOut(blend.duration);
          next.fadeIn(blend.duration);
        }
      }
      unit.overlayAction = next;
      unit.overlayAnimationId = animation;
      if (actionKind === undefined) delete unit.overlayActionKind;
      else unit.overlayActionKind = actionKind;
      unit.overlayPreservesLocomotion = true;
      delete unit.overlayFadeUntil;
      const fade = animationFadeWindow(clip.duration, fullDuration);
      unit.overlayUntil = loop ? 0 : now + fade.start * 1000;
      return;
    }

    if (animation === unit.animationId && unit.action && unit.action.getClip() !== clip
      && unit.action.isRunning() && unit.action.loop === wantedLoop) {
      // The same pose in another cut — the gait with or without the tracks an upper-body pose owns.
      // Swapped at the same phase and rate and cross-faded, so the legs see no seam (both cuts key
      // them identically) and the upper body hands over between the layers across the blend.
      const previous = unit.action;
      const next = unit.skinned!.mixer.clipAction(clip);
      next.reset();
      next.setEffectiveTimeScale(previous.getEffectiveTimeScale());
      next.setLoop(wantedLoop, Infinity);
      next.clampWhenFinished = !loop;
      next.setEffectiveWeight(1);
      next.time = previous.time;
      next.play();
      next.crossFadeFrom(previous, ACTION_ANIMATION_BLEND, false);
      unit.action = next;
      return;
    }
    if (animation === unit.animationId && unit.action && unit.action.getClip() === clip) {
      // A startAnimation and its primary animation may intentionally resolve to the same clip.
      // The phase still has to change LoopOnce -> LoopRepeat for a held precast.
      // A mixer can stop a one-shot when it reaches its end. Re-start a stopped action even when
      // its loop mode matches, otherwise the unit can remain on its final frame forever.
      if (unit.action.loop === wantedLoop && unit.action.isRunning()) return;
      unit.action.reset();
      // Reused actions retain their local timeScale across clips; animation data is authored in
      // seconds, so make the default playback rate explicit before every restart.
      unit.action.setEffectiveTimeScale(1);
      unit.action.setLoop(wantedLoop, Infinity);
      unit.action.clampWhenFinished = !loop;
      unit.action.play();
      if (actionKind === undefined) delete unit.actionKind;
      else unit.actionKind = actionKind;
      // Restarting the same clip ends the same way it would have if it were a different one, so
      // it leaves the same blend window free. See the tail comment at the bottom of this method.
      const blendDuration = loop ? ANIMATION_BLEND : ACTION_ANIMATION_BLEND;
      unit.overlayUntil = loop ? 0 : now + Math.max(0, clip.duration * 1000 - blendDuration * 1000);
      return;
    }
    const previous = unit.action;
    const next = unit.skinned!.mixer.clipAction(clip);
    next.reset();
    next.setEffectiveTimeScale(1);
    next.setLoop(wantedLoop, Infinity);
    next.clampWhenFinished = !loop;
    next.setEffectiveWeight(1);
    next.play();
    if (previous && previous !== next) {
      const blend = animationBlend(previous.loop === THREE.LoopRepeat, loop, clipBlendTime(clip));
      const transition = animationTransition(previous.isRunning(), true);
      if (transition === "stop") previous.stop();
      else if (transition === "crossfade") next.crossFadeFrom(previous, blend.duration, blend.warp);
      else if (transition === "fade") {
        // The same independent pair as the overlay branch above, and the one that matters most:
        // this is where a finished cast, landing or reaction handed over. `previous.stop()` here
        // dropped its clamped last frame to nothing on the tick the next pose appeared at weight
        // 1 — one frame of visible snap, on every completed one-shot in the game.
        previous.fadeOut(blend.duration);
        next.fadeIn(blend.duration);
      }
    }
    unit.action = next;
    unit.animationId = animation;
    if (actionKind === undefined) delete unit.actionKind;
    else unit.actionKind = actionKind;
    // A one-shot holds the unit for its own length, less the blend that takes it away again — and
    // that subtraction is not optional. `fullDuration` (a spell visual's own animation) used to
    // subtract nothing, so the pose pass came back for the unit at the exact millisecond the clip
    // ended, by which time the action had finished and was no longer running: the transition was
    // the hard `stop()` above and a standing cast always snapped into Stand. The moving cast never
    // showed it, because its overlay branch runs `animationFadeWindow` and hands over early. Both
    // paths now leave the same blend window free, and the difference between them is gone.
    const blendDuration = loop ? ANIMATION_BLEND : ACTION_ANIMATION_BLEND;
    unit.overlayUntil = loop ? 0 : now + Math.max(0, clip.duration * 1000 - blendDuration * 1000);
  }

  /**
   * Hands exclusive ownership of the bones back to the base layer.
   *
   * Softly by default: the overlay is released rather than cut, so a cancelled cast, a shot that
   * was called off, or an upper-body action reaching the end of its window fades out over the
   * action window while `#poseBase` cross-fades the gait back from its lower-body cut to the whole
   * clip over the same window. `stop()` here removed the pose from the mixer between two frames.
   * The action stays scheduled through the fade, and the cached action remains available for a
   * later reset()/play().
   *
   * `hard` is for the paths where the pose must be gone and not merely fading: the instance is
   * being torn down and its mixer with it.
   */
  #clearOverlay(unit: PosedModel, hard = false): void {
    if (hard) unit.overlayAction?.stop();
    else unit.overlayAction?.fadeOut(ACTION_ANIMATION_BLEND);
    delete unit.overlayAction;
    delete unit.overlayAnimationId;
    delete unit.overlayActionKind;
    unit.overlayPreservesLocomotion = false;
    delete unit.overlayFadeUntil;
    unit.overlayUntil = 0;
  }

  /**
   * Fetches the poses this model has but did not ship with, once one is wanted.
   *
   * A character model carries around 1.5 MiB of keyframes and a tenth of that is locomotion, so
   * the rest travels separately. Nothing is requested until something would play it: a wolf that
   * never fights never downloads its attacks.
   */
  #requestAnimations(template: SkinnedTemplate, wanted: readonly number[], client: EnvironmentClient | undefined,
    metadata: UnitModel | undefined, family: AnimationRequestFamily = "any"): boolean {
    if (!client || !metadata) return false;
    // Only when the model claims the pose and has not built it: otherwise every stand-in creature
    // would ask for a set it does not have. The rule itself is `needsSidecarAnimations`, out in
    // `AnimatedModel` where a test can drive it without a renderer — the seated pose was never
    // fetched at all and nothing at this level could show it. `family` says which boundary the
    // list belongs to, so the request is decided by the same one that will decide the drawing.
    if (!needsSidecarAnimations(template, wanted, family)) return false;
    const clips = client.animations(metadata.model, template.parents.length, "critical");
    if (!clips) return false;
    if (!this.#unitAnimationBudget.take()) return true;
    const merged = mergeSkinnedClips(template, clips, { wanted, maxClips: 16, milliseconds: 1 });
    // Once, even if a clip in there turned out to be unbuildable: otherwise a model with one bad
    // sequence walks the whole block again on every frame it is on screen.
    template.merged = merged.complete;
    return !merged.complete;
  }

  #shapeCapsule(unit: RenderedUnit, tint: number, radius: number, height: number, dead: boolean, moving: boolean, now: number): void {
    const body = unit.body;
    if (!body) return;
    if (unit.tint !== tint) {
      unit.tint = tint;
      unit.material.color.setHex(tint);
    }
    if (unit.height !== height || unit.radius !== radius) {
      unit.height = height;
      unit.radius = radius;
      body.scale.set(radius / 0.5, height / 2, radius / 0.5);
      const facing = unit.node.children[1] as THREE.Mesh | undefined;
      facing?.position.set(radius + 0.16, height * 0.62, 0);
      facing?.scale.setScalar(Math.max(0.6, Math.min(2.4, radius / UNIT_DEFAULT_RADIUS)));
    }
    if (unit.dead !== dead) {
      unit.dead = dead;
      // A felled unit lies along its facing instead of standing in place.
      body.rotation.z = dead ? Math.PI / 2 : 0;
      const facing = unit.node.children[1];
      if (facing) facing.visible = !dead;
    }
    const bob = moving ? Math.abs(Math.sin(now * UNIT_BOB_RATE)) * UNIT_BOB_AMPLITUDE * (height / UNIT_DEFAULT_HEIGHT) : 0;
    body.position.y = dead ? radius : height / 2 + bob;
  }

  /**
   * What one environment placement is drawn as: its model, its stand-in, or nothing at all.
   *
   * The third answer is what this path was missing. `#buildGameObject` has had the `drawable`
   * guard since the grey boxes in the paved square were traced to it; the environment path was
   * written before it and never got it, so `model ? #modelNode(…) : #fallbackNode(…)` drew
   * *anything* that came back. What comes back when `/visual/model` fails is the server's own
   * collision hull, from the `/environment/model/<basename>` fallback in `Terrain.#loadModel`:
   * vertices and indices, no textures, no groups, no `visual` flag. `#material` paints that flat —
   * `0x927d62` for a WMO — and for Orgrimmar it is 283,165 vertices and 379,079 triangles of the
   * city's collision shell, 7.6 MiB on the wire, standing where the city should be. 251 of that
   * zone's 470 model paths have such a hull to serve.
   *
   * A model that has *not* come back still gets its stand-in: that one is on its way, and the
   * whole point of a stand-in is the second or two before it lands. A hull is not on its way — it
   * has arrived and is unusable — so it gets an empty node, which is the answer the game-object
   * path settled on for the same reason.
   */
  #environmentNode(object: EnvironmentObject, model: EnvironmentModel | undefined): THREE.Object3D {
    if (drawableModel(model)) return this.#modelNode(object, model);
    return model ? new THREE.Group() : this.#fallbackNode(object);
  }

  #fallbackNode(object: EnvironmentObject): THREE.Object3D {
    const kind = standInKind(object);
    if (kind === "tree") {
      const height = object.bounds ? Math.max(3, object.bounds.maxZ - object.bounds.minZ) : 5;
      const width = object.bounds ? Math.max(2, Math.max(object.bounds.maxX - object.bounds.minX, object.bounds.maxY - object.bounds.minY)) : 3;
      const x = object.bounds ? (object.bounds.minX + object.bounds.maxX) / 2 : object.x;
      const y = object.bounds ? (object.bounds.minY + object.bounds.maxY) / 2 : object.y;
      const z = object.bounds?.minZ ?? object.z;
      const group = new THREE.Group();
      const trunk = new THREE.Mesh(this.#trunkGeometry, this.#woodMaterial);
      const canopy = new THREE.Mesh(this.#foliageGeometry, this.#foliageMaterial);
      trunk.position.set(x, z + height * 0.32, -y);
      trunk.scale.set(1, height * 0.32, 1);
      canopy.position.set(x, z + height * 0.72, -y);
      canopy.scale.set(width * 0.55, height * 0.32, width * 0.55);
      group.add(trunk, canopy);
      return group;
    }
    return new THREE.Group();
  }

}

/**
 * Where the key light stands at a given time of day, as a unit vector in scene space.
 *
 * North is +X and west is +Y in the world, so east is -Y, which the scene draws as +Z: the source
 * comes up out of +Z, crosses over and goes down into -Z.
 *
 * Two things it must never do. It must not go below the horizon, because the light would come up
 * through the ground and there is no second source for the night — the night is carried by the
 * diffuse band, which the file turns blue on its own. And it must never point straight down, which
 * is what the old `max(0.22, -cos)` did at both midnight and noon: with the east-west term at zero
 * the vector normalised to (0,1,0), every vertical face got `N·L` of exactly zero, and the whole
 * of the light landed on the ground. Measured at midnight that is 6.19 stops between the ground
 * and a standing figure, against a reference of 3.16 — the black silhouette is a shape problem
 * before it is a brightness one.
 *
 * The floor and the arc are unchanged, so dawn and dusk keep the low sun they had. What is new is
 * the tilt on X, the axis the old vector never used, and it is largest exactly where the east-west
 * term vanishes.
 */
export function sunDirection(time: number): { x: number; y: number; z: number } {
  const angle = (time / DAY_HALF_MINUTES) * Math.PI * 2;
  const east = Math.sin(angle);
  const overhead = -Math.cos(angle);
  const x = overhead * SUN_TILT;
  const y = Math.max(SUN_FLOOR, overhead);
  const length = Math.hypot(x, y, east) || 1;
  return { x: x / length, y: y / length, z: east / length };
}

/** How far above the horizon the source is kept when the sun itself would be below it. */
const SUN_FLOOR = 0.22;
/** The north-south lean that keeps midnight and noon off the pole. */
const SUN_TILT = 0.35;

/**
 * The visible solar source, unlike `sunDirection`, is allowed to set below the horizon.
 *
 * The world key light deliberately stays above the ground at night so models retain readable
 * shaping. Reusing it for a visible source would put bright shafts into a midnight sky. This is the
 * same east/noon phase and north-south tilt, with the physical elevation restored.
 */
export function godRaySunDirection(time: number, target = new THREE.Vector3()): THREE.Vector3 {
  const safeTime = Number.isFinite(time) ? time : 0;
  const angle = (safeTime / DAY_HALF_MINUTES) * Math.PI * 2;
  const elevation = -Math.cos(angle);
  return target.set(elevation * SUN_TILT, elevation, Math.sin(angle)).normalize();
}

export interface GodRayScreenSource {
  ndcX: number;
  /** Shader source position; a high source is pinned tangent outside the viewport. */
  ndcY: number;
  /** Unpinned physical Y used solely to keep the upper-edge strength transition continuous. */
  visibilityY: number;
  /** Camera-to-sun alignment in the ground plane; vertical camera limits must not hide daylight. */
  facing: number;
}

/**
 * Projects the physical sun into the radial pass without requiring the orbit camera to point at it.
 *
 * A normal ground camera looks down at the character and cannot reach the high daytime sun. Once
 * that source crosses above the view plane, its azimuth is projected along the horizon and the
 * synthetic disc is parked tangent to the top edge. The source is still rejected when the camera
 * turns away horizontally; only the camera's intentionally limited vertical orbit is ignored.
 */
export function godRayScreenSource(
  camera: THREE.PerspectiveCamera,
  sun: THREE.Vector3,
  target: GodRayScreenSource = { ndcX: 0, ndcY: 0, visibilityY: 0, facing: 0 },
  projection = new THREE.Vector3(),
  cameraForward = new THREE.Vector3(),
  cameraUp = new THREE.Vector3(),
): GodRayScreenSource {
  camera.getWorldDirection(cameraForward);
  const directFacing = cameraForward.dot(sun);
  const flatSunLength = Math.hypot(sun.x, sun.z);
  const flatCameraLength = Math.hypot(cameraForward.x, cameraForward.z);
  const facing = flatSunLength > 1e-9 && flatCameraLength > 1e-9
    ? (cameraForward.x * sun.x + cameraForward.z * sun.z) / (flatCameraLength * flatSunLength)
    : 0;
  const distance = Math.max(1, camera.far * 0.9);
  projection.copy(sun).multiplyScalar(distance).add(camera.position).project(camera);
  const physicalNdcY = projection.y;

  cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
  const upperPlane = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV() * 0.5))
    * Math.max(directFacing, 0);
  const aboveUpperPlane = cameraUp.dot(sun) > upperPlane;
  // A high source may be behind the camera's vertical view plane even while its azimuth is ahead.
  // The upper-frustum-plane test distinguishes that case from turning away horizontally. Re-project
  // the azimuth on the horizon only after the physical projection has gone behind; while it remains
  // in front, its X is already stable and must survive the upper-plane crossing unchanged.
  if (sun.y > 0 && facing > 0.02 && aboveUpperPlane) {
    if (directFacing <= 0) {
      projection.set(sun.x / flatSunLength, 0, sun.z / flatSunLength)
        .multiplyScalar(distance)
        .add(camera.position)
        .project(camera);
    }
    projection.y = GOD_RAY_SOURCE_TOP_NDC;
  }

  target.ndcX = projection.x;
  target.ndcY = projection.y;
  target.visibilityY = directFacing > 0 ? physicalNdcY : GOD_RAY_SOURCE_TOP_NDC;
  target.facing = facing;
  return target;
}

function smoothRamp(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Final bounded strength after day, view, screen-edge and weather fades, times the account's
 * shaft multiplier.
 *
 * NDC is used rather than UV so zero is the screen centre and one is an edge. `strength` is the
 * quality profile's ceiling and stays clamped to one; `scale` («Сила солнечных лучей» / 100) is
 * applied last and bounded by `GOD_RAY_STRENGTH_SCALE_MAX`, so 1 reproduces the unscaled value
 * bit for bit. Invalid inputs fail closed: this value reaches a display-space additive composite
 * and must never become NaN.
 */
export function godRayVisibility(
  ndcX: number,
  ndcY: number,
  elevation: number,
  facing: number,
  strength: number,
  storm: number,
  scale = 1,
): number {
  if (![ndcX, ndcY, elevation, facing, strength, storm, scale].every(Number.isFinite)) return 0;
  const boundedStrength = Math.max(0, Math.min(1, strength));
  const boundedScale = Math.max(0, Math.min(GOD_RAY_STRENGTH_SCALE_MAX, scale));
  // Above the frame the physical source settles to a restrained carry rather than vanishing. The
  // radial material keeps its synthetic disc tangent outside the viewport, so this reveals shafts
  // without painting a fake sun over the scene.
  const visibilityY = Math.min(ndcY, GOD_RAY_TOP_FULL_NDC);
  const edgeDistance = Math.min(1 - Math.abs(ndcX), 1 - Math.abs(visibilityY));
  const onScreen = smoothRamp(0, 0.18, edgeDistance);
  const offscreenCarry = 1 - (1 - GOD_RAY_OFFSCREEN_CARRY)
    * smoothRamp(GOD_RAY_TOP_FULL_NDC, GOD_RAY_TOP_SETTLE_NDC, ndcY);
  const daylight = smoothRamp(0.01, 0.16, elevation);
  const inFront = smoothRamp(0.02, 0.18, facing);
  const weather = 1 - Math.max(0, Math.min(1, storm));
  return boundedStrength * onScreen * offscreenCarry * daylight * inFront * weather * boundedScale;
}

/** Triangles a geometry stands for, indexed or not, without touching the GPU to ask. */
function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  return (geometry.getAttribute("position")?.count ?? 0) / 3;
}

/**
 * The sky as the client's own tables describe it: four authored bands from the zenith down, and
 * the fog colour where the ground would be, so the horizon has no seam in it.
 *
 * A dome rather than a flat background because those four colours are a gradient and a background
 * is one colour. It is drawn first, writes no depth and takes no fog, and follows the camera so
 * its own size never matters.
 */
function buildSky(uniforms: {
  skyTop: { value: THREE.Color }; skyUpper: { value: THREE.Color }; skyMiddle: { value: THREE.Color };
  skyLower: { value: THREE.Color }; skyHorizon: { value: THREE.Color }; skyFog: { value: THREE.Color };
}): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 skyTop;
      uniform vec3 skyUpper;
      uniform vec3 skyMiddle;
      uniform vec3 skyLower;
      uniform vec3 skyHorizon;
      uniform vec3 skyFog;
      varying vec3 vDirection;
      void main() {
        // Five authored bands, and they are not evenly spaced: almost all of the visible change
        // is in the last few degrees above the horizon, which is where the lower three sit.
        float height = clamp(vDirection.y, -1.0, 1.0);
        vec3 colour = mix(skyHorizon, skyLower, smoothstep(0.0, 0.05, height));
        colour = mix(colour, skyMiddle, smoothstep(0.05, 0.14, height));
        colour = mix(colour, skyUpper, smoothstep(0.14, 0.36, height));
        colour = mix(colour, skyTop, smoothstep(0.36, 0.85, height));
        colour = mix(skyFog, colour, smoothstep(-0.06, 0.01, height));
        gl_FragColor = vec4(colour, 1.0);
        // The same two steps every lit material ends with. Without them the sky is the one thing
        // in the frame that is neither tone mapped nor encoded, and the horizon shows the seam
        // against the fog, which is the whole thing the bottom band exists to hide.
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  // Inside the far plane. The dome is centred on the camera, so a radius past it would be clipped
  // away in a ring around the horizon rather than drawn.
  mesh.scale.setScalar(800);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

/** How thick the meniscus is, in yards of water — a property of the water, not of the view. */
export const UNDERWATER_MENISCUS_YARDS = 0.030;
/** How far the seam's height wanders, so the cut is not a perfectly straight line. */
export const UNDERWATER_RIPPLE_YARDS = 0.004;

/**
 * The underwater tint and its waterline: one triangle, no texture, no render target.
 *
 * Where the split falls is worked out from the surface itself rather than from a line pushed in
 * screen space. Each pixel asks where its own ray enters the world — the point it sees on the near
 * plane, which is the plane the water is actually cutting across — and compares that point's height
 * against the surface. The seam then lands on the water at any pitch, roll or height, because it is
 * the same test the water is passing or failing. A screen-space line drifted off the water the
 * moment the camera pitched, which is why the reference client stopped drawing one
 * (`wowee/assets/shaders/overlay.frag.glsl`).
 *
 * Written straight to `gl_FragColor` with neither tone mapping nor an encode, and that is measured
 * rather than assumed: the reference presents through `VK_FORMAT_B8G8R8A8_UNORM`
 * (`wowee/src/rendering/vk_context.cpp:1026`), so its constants are display-space values blended
 * over display-space pixels — exactly the buffer this pass blends into here.
 */
export function buildUnderwaterOverlay(uniforms: {
  invViewProj: { value: THREE.Matrix4 };
  tint: { value: THREE.Vector4 };
  waterZ: { value: number };
  params: { value: THREE.Vector4 };
}): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms,
    // Over everything, tested against nothing, writing nothing. The world pass has already put its
    // depth down and this must not read it, disturb it, or be sorted against it.
    depthTest: false,
    depthWrite: false,
    transparent: true,
    fog: false,
    toneMapped: false,
    vertexShader: `
      varying vec2 vUV;
      void main() {
        // The position attribute is already in clip space, and the ortho camera is the identity
        // over it. One triangle rather than two: no seam down the diagonal, one vertex fewer.
        vUV = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: `
      uniform mat4 invViewProj;
      uniform vec4 tint;
      uniform float waterZ;
      uniform vec4 params;
      varying vec2 vUV;
      void main() {
        // z = -1 is the near plane here. The reference writes 0 because Vulkan's clip volume runs
        // 0..1 in depth; WebGL's runs -1..1, and using its number would have unprojected the middle
        // of the frustum instead of its front face.
        vec4 clip = vec4(vUV.x * 2.0 - 1.0, vUV.y * 2.0 - 1.0, -1.0, 1.0);
        vec4 world = invViewProj * clip;
        world /= (abs(world.w) > 1e-6) ? world.w : 1e-6;

        // A touch of ripple on the surface height, so the seam is not a perfect straight cut. In
        // world units, so it does not change with the view. The scene's x and z are the world's
        // two horizontal axes (its y is the world's up), so the phase is taken from those.
        float surface = waterZ
                      + (sin(world.x * 1.7 + params.y * 1.9)
                       + sin(world.z * 2.3 - params.y * 1.4)) * params.z;

        float below = surface - world.y;      // positive: this pixel's ray starts under water
        float soft = max(params.x, 1e-4);

        // params.w == 0 means fully submerged with no seam left to draw: tint everything rather
        // than testing a plane that is behind the camera.
        float submerged = (params.w < 0.5) ? 1.0 : smoothstep(-soft, soft, below);

        // The meniscus: water climbing the glass at the seam. A slim band centred on the surface,
        // darker and denser than the water either side of it. Without it the crossing is a cut
        // between two flat colours, which is what a split screen looks like and not what a lens
        // half in the water looks like.
        float meniscus = (params.w < 0.5)
                       ? 0.0
                       : (1.0 - smoothstep(0.0, soft * 1.8, abs(below)));

        float alpha = clamp(tint.a * submerged + meniscus * 0.55, 0.0, 1.0);
        vec3 rgb = tint.rgb * (1.0 - 0.45 * meniscus);
        gl_FragColor = vec4(rgb, alpha);
      }`,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -1, -1, 0,
    3, -1, 0,
    -1, 3, 0,
  ], 3));
  const mesh = new THREE.Mesh(geometry, material);
  // The triangle deliberately reaches outside the ortho box; culling it by its bounds would drop
  // the only draw this scene has.
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Where the full-screen glow starts, as a *linear* value.
 *
 * Taken from the tone curve rather than chosen: the shoulder is the identity below 0.9 and
 * compresses above it, so 0.9 is the exact linear value at which this client's own output curve
 * declares a channel to be a white core rather than a colour. What the shoulder is already bending
 * is what the glow blooms, and nothing under it moves at all.
 *
 * Without a bright pass the effect would be a uniform veil: adding the blurred *whole* frame at
 * Darnassus's authored 1.0 doubles the picture. The original client haloes lamps, water sparkle and
 * spell energy, not the ground between them.
 */
export const GLOW_BRIGHT_KNEE = 0.9;

/**
 * three's `sRGBTransferOETF`, one channel at a time.
 *
 * Constants transcribed from `colorspace_pars_fragment.glsl.js` — including its `0.41666` rather
 * than an exact `1 / 2.4` — so this is the encode the world's own materials end with and not a
 * near-miss of it.
 */
function srgbTransferOETF(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 0.41666) - 0.055;
}

/**
 * The same knee, in the display-referred values the offscreen buffer now holds (P4b).
 *
 * The scene target is display-referred: the world's own materials run the shoulder and the sRGB
 * encode into it exactly as they do into the canvas, so the bright pass reads screen values, not
 * linear ones. Comparing those against the linear 0.9 would start the bloom at linear 0.787 and
 * haze pixels the curve is not bending yet — the same constant read in the wrong space, which
 * `tests/tone-mapping.test.mjs` already names as a live hazard for this client.
 *
 * Derived rather than retyped: the linear knee through the curve (the identity there, and every
 * quality profile leaves `exposure` at 1.0) and then through the encode above. 0.9547 in screen
 * units, sRGB 243 in bytes.
 */
export const GLOW_BRIGHT_KNEE_DISPLAY = srgbTransferOETF(toneShoulder(GLOW_BRIGHT_KNEE));

/**
 * How much room is left above that knee — the whole range the white core occupies on screen.
 *
 * 0.045312, or twelve of 255 levels, and it is small for a reason: the shoulder's asymptote is 1.0,
 * so *every* linear value from 0.9 to infinity is folded into [0.9, 1.0] and then encoded into
 * [0.9547, 1]. A bright pass that subtracted the knee and stopped would therefore hand the blur an
 * excess of at most 0.045 where P4's unbounded linear buffer handed it 0.7 for the same quad, and
 * the halo measured four bytes tall against P4's 121. Dividing by this restores the effect without
 * inventing a number: what the blur receives is how far into the white core a pixel is, as a
 * fraction of the white core itself. Both profiles are in the P4b journal entry.
 */
export const GLOW_BRIGHT_HEADROOM = 1 - GLOW_BRIGHT_KNEE_DISPLAY;

/**
 * The most of the blurred frame the composite is allowed to add back.
 *
 * One, and measured rather than picked: across this dataset's 850 `LightParams` rows every authored
 * `Glow` lies in [0, 1] — 47 rows at exactly 0, 152 at exactly 1, median 0.50, mean 0.5288 — so the
 * clamp is the range the artists actually used and cannot quietly change a single authored zone.
 * It exists for a hand-edited or corrupt table, not for the shipped one.
 */
export const GLOW_MAX_STRENGTH = 1;

/** Nine-tap Gaussian collapsed onto five bilinear taps; offsets are in texels along one axis. */
const GLOW_BLUR_OFFSETS: readonly [number, number] = [1.3846153846, 3.2307692308];
const GLOW_BLUR_WEIGHTS: readonly [number, number, number] = [0.2270270270, 0.3162162162, 0.0702702703];

/**
 * How many half-resolution texels one unit of the kernel above is worth.
 *
 * A nine-tap Gaussian at unit spacing reaches about three texels, which at half resolution is a
 * six-pixel halo — a rim light, not the wide soft bloom the original client puts around a lamp.
 * Spreading the same five taps is what buys the width without a third pass, and how far they can be
 * spread before the kernel stops being a Gaussian and starts being five separate lobes was
 * measured, not assumed: see the profile in the slice's journal entry.
 */
export const GLOW_BLUR_SPREAD = 2;

/**
 * Yards of bounding radius below which a scenery mesh receives but does not cast the sun shadow.
 * In the Stormwind trade district this halves the extra shadow-pass draws of the scenery leaf.
 */
export const SCENERY_SHADOW_MIN_RADIUS = 1.5;

/**
 * Yards of bounding radius from which a scenery mesh also casts into the cached outermost cascade:
 * trees, large rocks, statues. Smaller casters reach only the cascades rendered every frame, which
 * cover them for as far as their shadow still reads.
 */
export const SCENERY_FAR_SHADOW_MIN_RADIUS = 3;

/** `userData` key marking a WMO room's depth-only shadow stand-in. */
const WMO_SHADOW_PROXY = "wowShadowProxy";

/**
 * The stand-ins' material. No view camera ever draws them — they live on the shadow layers only —
 * so all it tells three's depth pass is to draw both faces: a WMO roof is often a single sheet.
 */
const WMO_SHADOW_PROXY_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });

const WMO_SHADOW_PROXY_GEOMETRIES = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry | null>();

/**
 * One room geometry's stand-in for the shadow pass, cached per geometry: the same position and index
 * buffers, and one group per stretch of consecutive solid runs, so a room whose solid runs are
 * contiguous is one depth draw however many textures it has. Null when nothing in it is solid.
 *
 * It shares the source's buffers, so it is disposed with the source and never on its own: three
 * deletes an attribute's GL buffer whenever any geometry holding it is disposed.
 */
export function wmoShadowProxyGeometry(
  source: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
): THREE.BufferGeometry | null {
  const cached = WMO_SHADOW_PROXY_GEOMETRIES.get(source);
  if (cached !== undefined) return cached;
  const position = source.getAttribute("position") as THREE.BufferAttribute | undefined;
  const index = source.getIndex();
  const materials = Array.isArray(material) ? material : [material];
  const solid = (entry: THREE.Material | undefined): boolean => entry !== undefined && entry.visible
    && !entry.transparent && entry.depthWrite && !(entry.alphaTest > 0);
  const groups = source.groups.length > 0
    ? source.groups
    : [{ start: 0, count: index ? index.count : position?.count ?? 0, materialIndex: 0 }];
  const ranges: { start: number; count: number }[] = [];
  for (const group of groups) {
    if (!solid(materials[group.materialIndex ?? 0])) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.count === group.start) last.count += group.count;
    else ranges.push({ start: group.start, count: group.count });
  }
  if (!position || ranges.length === 0) {
    WMO_SHADOW_PROXY_GEOMETRIES.set(source, null);
    return null;
  }
  const proxy = new THREE.BufferGeometry();
  proxy.setAttribute("position", position);
  if (index) proxy.setIndex(index);
  for (const range of ranges) proxy.addGroup(range.start, range.count, 0);
  if (!source.boundingSphere) source.computeBoundingSphere();
  proxy.boundingSphere = source.boundingSphere?.clone() ?? null;
  source.addEventListener("dispose", () => proxy.dispose());
  WMO_SHADOW_PROXY_GEOMETRIES.set(source, proxy);
  return proxy;
}

/** Fixed compile-time loop bound: enough radial detail at half resolution without dynamic indexing. */
export const GOD_RAY_SAMPLES = 24;
/** The high lighting quality's shaft ceiling; the cinematic shafts take their share of it. */
const GOD_RAY_FULL_STRENGTH = lightingProfile(2).godRayStrength;
/** Radius of the synthetic solar source in aspect-corrected screen UVs. */
const GOD_RAY_SOURCE_RADIUS = 0.12;
/** Upper edge of the existing 0.18-NDC in-frame fade: below this, behaviour is unchanged. */
const GOD_RAY_TOP_FULL_NDC = 0.82;
/** A high source has settled to its bounded carry before reaching the tangent shader position. */
const GOD_RAY_TOP_SETTLE_NDC = 1.18;
/** Subtle off-screen daylight without turning the whole clear sky into a veil. */
const GOD_RAY_OFFSCREEN_CARRY = 1 / 3;
/** UV 1 + source radius, converted to NDC: the synthetic disc is tangent above the viewport. */
const GOD_RAY_SOURCE_TOP_NDC = (1 + GOD_RAY_SOURCE_RADIUS) * 2 - 1;

/**
 * How much of the blurred frame this zone's authored number adds back.
 *
 * Absent, non-finite or negative is no glow — the frame the chain composites is then the frame the
 * direct path would have drawn, which is what makes "leaf ON, strength 0" a testable identity and
 * not a hedge. Ironforge and Dalaran author exactly that.
 */
export function glowAddStrength(glow: number | undefined): number {
  if (glow === undefined || !Number.isFinite(glow)) return 0;
  return Math.max(0, Math.min(GLOW_MAX_STRENGTH, glow));
}

export interface GlowChainSize {
  readonly width: number;
  readonly height: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * The drawing buffer and the half-resolution buffers the blur runs in.
 *
 * Floor rather than round, and floored at one: a 1-pixel-wide canvas halves to zero, and a zero
 * dimension is a render target the driver refuses to allocate. An odd width halves to the smaller
 * side, so the blur never samples past the frame it came from.
 */
export function glowChainSize(width: number, height: number): GlowChainSize | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  const full = { width: Math.floor(width), height: Math.floor(height) };
  if (full.width < 1 || full.height < 1) return undefined;
  return Object.freeze({
    width: full.width,
    height: full.height,
    halfWidth: Math.max(1, Math.floor(full.width / 2)),
    halfHeight: Math.max(1, Math.floor(full.height / 2)),
  });
}

/** The three buffers of the chain, and the surface epoch they were allocated against. */
interface GlowChainTargets extends GlowChainSize {
  /**
   * Sky, world and the underwater overlay, at drawing-buffer size, display-referred: the same
   * bytes the canvas would have received. See `#createFullscreenGlowTargets` for how that is made
   * to happen and what it rests on.
   */
  readonly scene: THREE.WebGLRenderTarget;
  /** Half resolution: the bright pass lands in A, the horizontal blur in B, the vertical back in A. */
  readonly blurA: THREE.WebGLRenderTarget;
  readonly blurB: THREE.WebGLRenderTarget;
  /** Whether the scene target owns the resolved depth texture the radial pass requires. */
  readonly godRays: boolean;
  /** `#webGlContextGeneration` at allocation; a lost/restored context invalidates all three. */
  readonly contextGeneration: number;
  /** What the driver actually gave the scene target, after three's own clamp to `maxSamples`. */
  readonly samples: number;
}

export interface FullscreenGlowPasses {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly quad: THREE.Mesh;
  readonly extract: THREE.ShaderMaterial;
  readonly blur: THREE.ShaderMaterial;
  readonly godRays: THREE.ShaderMaterial;
  readonly composite: THREE.ShaderMaterial;
  readonly uniforms: {
    readonly source: { value: THREE.Texture | null };
    readonly glow: { value: THREE.Texture | null };
    readonly rays: { value: THREE.Texture | null };
    readonly depth: { value: THREE.DepthTexture | null };
    /** One texel along the axis being blurred, in UV. */
    readonly direction: { value: THREE.Vector2 };
    readonly strength: { value: number };
    readonly sunUv: { value: THREE.Vector2 };
    readonly aspect: { value: number };
    readonly rayColour: { value: THREE.Color };
    readonly rayStrength: { value: number };
  };
}

/**
 * The classic glow, depth-aware sun-shaft and composite materials, on one full-screen triangle.
 *
 * All four colour passes read and write display-referred pixels, and that is the whole of P4b. The scene target
 * is flagged so three keeps grading and encoding the world into it (`#createFullscreenGlowTargets`
 * carries the argument and the tripwires), which means the curve and the sRGB encode have already
 * run, per material, before any of these passes sees a texel. So the composite is an add and
 * nothing else: re-applying the shoulder here would bend an already-bent frame, and re-applying
 * the encode would gamma it twice.
 *
 * That is also why the bright pass and the blurs are correct rather than merely cheap. They smear
 * screen values, which is what `ffxGlow` smeared: the reference's backbuffer is
 * `VK_FORMAT_B8G8R8A8_UNORM` with no gamma anywhere in its fragment shaders, so its halo is built
 * from the same numbers a screenshot would show.
 *
 * `toneMapped: false` on all four, and no `colorspace_fragment` in any of them: three must not add
 * a second grade on the composite's way to the canvas.
 */
export function buildFullscreenGlowPasses(): FullscreenGlowPasses {
  const uniforms = {
    source: { value: null as THREE.Texture | null },
    glow: { value: null as THREE.Texture | null },
    rays: { value: null as THREE.Texture | null },
    depth: { value: null as THREE.DepthTexture | null },
    direction: { value: new THREE.Vector2(0, 0) },
    strength: { value: 0 },
    sunUv: { value: new THREE.Vector2(0.5, 0.5) },
    aspect: { value: 1 },
    rayColour: { value: new THREE.Color(1, 1, 1) },
    rayStrength: { value: 0 },
  };
  const vertexShader = `
      varying vec2 vUV;
      void main() {
        // Clip space already, exactly like the underwater overlay: one triangle, no camera.
        vUV = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`;
  const pass = (fragmentShader: string, own: Record<string, unknown>): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
      uniforms: own as THREE.ShaderMaterial["uniforms"],
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      blending: THREE.NoBlending,
    });

  const extract = pass(`
      uniform sampler2D source;
      varying vec2 vUV;
      void main() {
        // One bilinear tap, not four: a half-resolution pixel centre lands exactly on the corner
        // between four full-resolution texels, so the hardware returns their average for free.
        vec3 colour = texture2D(source, vUV).rgb;
        // Display-referred, so bounded: see GLOW_BRIGHT_HEADROOM for why the excess is normalised
        // rather than passed on raw, and what each of the two measures on a hard-edged quad.
        gl_FragColor = vec4(
          max(colour - ${GLOW_BRIGHT_KNEE_DISPLAY.toFixed(6)}, 0.0) / ${GLOW_BRIGHT_HEADROOM.toFixed(6)},
          1.0);
      }`, { source: uniforms.source });

  const blur = pass(`
      uniform sampler2D source;
      uniform vec2 direction;
      varying vec2 vUV;
      void main() {
        vec3 sum = texture2D(source, vUV).rgb * ${GLOW_BLUR_WEIGHTS[0].toFixed(10)};
        sum += (texture2D(source, vUV + direction * ${GLOW_BLUR_OFFSETS[0].toFixed(10)}).rgb
              + texture2D(source, vUV - direction * ${GLOW_BLUR_OFFSETS[0].toFixed(10)}).rgb)
              * ${GLOW_BLUR_WEIGHTS[1].toFixed(10)};
        sum += (texture2D(source, vUV + direction * ${GLOW_BLUR_OFFSETS[1].toFixed(10)}).rgb
              + texture2D(source, vUV - direction * ${GLOW_BLUR_OFFSETS[1].toFixed(10)}).rgb)
              * ${GLOW_BLUR_WEIGHTS[2].toFixed(10)};
        gl_FragColor = vec4(sum, 1.0);
      }`, { source: uniforms.source, direction: uniforms.direction });

  const godRays = pass(`
      uniform sampler2D depth;
      uniform vec2 sunUv;
      uniform float aspect;
      uniform vec3 rayColour;
      varying vec2 vUV;

      float clearSky(vec2 uv) {
        // Clear depth is exactly one. Geometry remains below this even near the far fog plane, so
        // silhouettes, terrain and buildings stop the synthetic source instead of tinting it.
        return step(1.0, texture2D(depth, uv).r);
      }

      void main() {
        vec2 delta = (sunUv - vUV) / float(${GOD_RAY_SAMPLES});
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        vec2 sampleUv = vUV + delta * jitter;
        float decay = 1.0;
        float scattered = 0.0;
        float transmittance = 1.0;
        for (int i = 0; i < ${GOD_RAY_SAMPLES}; i++) {
          vec2 fromSun = (sampleUv - sunUv) * vec2(aspect, 1.0);
          float source = 1.0 - smoothstep(0.0, ${GOD_RAY_SOURCE_RADIUS.toFixed(3)}, length(fromSun));
          float sky = clearSky(sampleUv);
          // A single silhouette edge may leak softly over its own antialiased pixel, while several
          // covered steps compound rapidly and stop a shaft behind a roof or mountain.
          transmittance *= mix(0.72, 1.0, sky);
          scattered += sky * source * decay * transmittance;
          decay *= 0.94;
          sampleUv += delta;
        }
        // The bounded gain exposes the streak without allowing the dense source core to exceed one;
        // the quality profile applies the final, much smaller display-space strength in composite.
        float shaft = min(scattered * 0.70, 1.0);
        gl_FragColor = vec4(rayColour * shaft, 1.0);
      }`, {
        depth: uniforms.depth,
        sunUv: uniforms.sunUv,
        aspect: uniforms.aspect,
        rayColour: uniforms.rayColour,
      });

  const composite = pass(`
      uniform sampler2D source;
      uniform sampler2D glow;
      uniform sampler2D rays;
      uniform float strength;
      uniform float rayStrength;
      varying vec2 vUV;
      void main() {
        // Both taps are already the bytes the canvas would have held, so this is the entire
        // composite: no curve, no encode, nothing to put back. At strength 0 it is a copy, which
        // is what makes "leaf ON, no authored glow" byte-identical to the direct frame.
        gl_FragColor = vec4(
          texture2D(source, vUV).rgb
          + texture2D(glow, vUV).rgb * strength
          + texture2D(rays, vUV).rgb * rayStrength,
          1.0);
      }`, {
        source: uniforms.source,
        glow: uniforms.glow,
        rays: uniforms.rays,
        strength: uniforms.strength,
        rayStrength: uniforms.rayStrength,
      });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -1, -1, 0,
    3, -1, 0,
    -1, 3, 0,
  ], 3));
  const quad = new THREE.Mesh(geometry, extract);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  return Object.freeze({
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    quad,
    extract,
    blur,
    godRays,
    composite,
    uniforms,
  });
}

/** Scratch for `#placeGameObject`'s tilt (5.27), so placing a game object allocates nothing more. */
const GAME_OBJECT_TILT: Quat = { x: 0, y: 0, z: 0, w: 1 };
const GAME_OBJECT_TILT_SCENE = new THREE.Quaternion();

const VMAP_TO_THREE = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

/**
 * The same conversion as a quaternion, for a model whose vertices are not baked through it.
 *
 * The older artifact applies `VMAP_TO_THREE` to every vertex while it is being decoded; a WVM5
 * model keeps its vertices in model space, so its mesh carries the conversion as a rotation
 * instead. It has to be this one and not the unit path's `M2_TO_SCENE`, because every doodad
 * rotation that reaches here — the tile's Euler angles through `mappedVmapRotation`, and a WMO
 * doodad's quaternion through the tile generator — is conjugated by `VMAP_TO_THREE` at the point
 * it is written.
 */
export const ADT_MODEL_TO_SCENE = new THREE.Quaternion().setFromRotationMatrix(VMAP_TO_THREE);

const SCENE_UP = new THREE.Vector3(0, 1, 0);
const _coverPosition = new THREE.Vector3();
const _coverQuaternion = new THREE.Quaternion();
const _coverYaw = new THREE.Quaternion();
const _coverScale = new THREE.Vector3();

/**
 * Where one tuft of ground cover stands, as the matrix its instanced draw is given.
 *
 * The scatter works in world coordinates because that is the frame the recipe, the height field
 * and the player are all in; the scene's is (x, z, -y). The turn is about the scene's own vertical
 * and is applied *after* the model-to-scene conversion, so it is a yaw in the world and not a roll
 * in model space — the same conversion `#wvmNode` puts on a placed doodad's mesh, for the same
 * reason: these vertices are in model space and the artifact does not bake it in.
 */
export function groundCoverMatrix(batch: GroundCoverBatch, index: number, target = new THREE.Matrix4()): THREE.Matrix4 {
  _coverPosition.set(batch.x[index]!, batch.z[index]!, -batch.y[index]!);
  _coverQuaternion.copy(_coverYaw.setFromAxisAngle(SCENE_UP, batch.yaw[index]!)).multiply(ADT_MODEL_TO_SCENE);
  _coverScale.setScalar(batch.scale[index]!);
  return target.compose(_coverPosition, _coverQuaternion, _coverScale);
}

/**
 * A model whose emitters resolved to nothing, remembered so the answer is worked out once.
 *
 * Every emitter of such a model names a texture slot the client has to fill, which a particle
 * never can. Without this the resolution — and the failure — would be repeated every frame for
 * every placement in range.
 */
const EMPTY_EFFECTS: ModelEffects = {
  group: new THREE.Group(), emitters: [], textures: [], disposeTextures: false,
};

/** The frame an emitter falls back to when the bone it names is not in the rig. */
const IDENTITY_MATRIX = new THREE.Matrix4();
/** One lasting mark an aura leaves on a unit. */
export interface StateVisual {
  spellId: number;
  path: string;
  attachment: number;
  scale: number;
  /** Stable authored occurrence for duplicate model-attach rows; never an array position. */
  occurrence?: string;
  transform?: SpellVisualEffectTransform;
}

/** Compose an authored local rotation with the M2 conversion for each visual attachment case. */
export function composeSpellVisualTransform(
  transform: SpellVisualEffectTransform,
  attachedToUnit: boolean,
  skinned: boolean,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  const rotation = spellVisualTransformEuler(transform);
  const local = _spellVisualLocalRotation.setFromEuler(
    _spellVisualEuler.set(rotation.x, rotation.y, rotation.z, rotation.order));
  if (!skinned) {
    return attachedToUnit
      ? target.copy(local)
      : target.copy(M2_TO_SCENE).multiply(local);
  }
  // A skinned effect owns M2_TO_SCENE on its root. Free effects need B*R*B^-1, while an effect
  // copied from a unit bone already has B in its node and therefore needs R*B^-1 in its frame.
  return attachedToUnit
    ? target.copy(local).multiply(M2_FROM_SCENE)
    : target.copy(M2_TO_SCENE).multiply(local).multiply(M2_FROM_SCENE);
}

/**
 * A bone-anchored spell effect's place in the world, offset and all.
 *
 * A spell effect is a top-level node whose transform is copied off a bone rather than a child of
 * that bone, because its lifetime belongs to the cast and not to the unit. The consequence is that
 * everything a parented item gets from the hierarchy has to be applied here by hand — and one
 * thing was not: the M2 attachment table stores a *point*, and the bone's frame is the model
 * translated to the bone's **pivot**, so the point is the pivot plus an authored offset. Sending
 * that offset through the bone's own world matrix is exactly what parenting would have done to it,
 * rotation and scale included, and reduces to the previous behaviour when the offset is zero.
 *
 * Exported for its own test rather than left inside `#updateVisuals`: it is three lines of matrix
 * arithmetic whose failure is invisible on nine models out of ten.
 */
export function placeOnAttachmentBone(
  boneMatrixWorld: THREE.Matrix4,
  offset: THREE.Vector3 | undefined,
  scale: number,
  node: THREE.Object3D,
): void {
  boneMatrixWorld.decompose(node.position, node.quaternion, _scratchScale);
  node.scale.setScalar(scale * _scratchScale.x);
  if (offset && offset.lengthSq() > 0) node.position.copy(offset).applyMatrix4(boneMatrixWorld);
}

/** Apply the complete authored transform to the resolved effect frame. */
export function applySpellVisualTransformFrame(
  frame: THREE.Object3D,
  transform: SpellVisualEffectTransform | undefined,
  attachedToUnit: boolean,
  skinned: boolean,
): void {
  frame.position.set(0, 0, 0);
  if (!transform) return;
  const offset = spellVisualTransformOffset(transform, attachedToUnit);
  frame.position.set(offset.x, offset.y, offset.z);
  frame.quaternion.copy(composeSpellVisualTransform(transform, attachedToUnit, skinned));
}

/**
 * Stable across frames and unique per authored occurrence, so an unchanged effect is never
 * restarted and two equal model-attach rows are not collapsed into one node.
 *
 * Model-attach occurrences carry their DBC row id. The fallback occurrence is intentionally empty:
 * legacy kit effects are already distinguished by their attachment/path, while using an array
 * index here would make a reordered response restart unrelated effects.
 */
export function stateVisualKey(guid: bigint, effect: StateVisual): string {
  const transform = effect.transform
    ? [effect.transform.offset, effect.transform.rotation] : undefined;
  return `state:${JSON.stringify([
    guid.toString(), effect.spellId, effect.occurrence ?? "", effect.attachment,
    effect.path, effect.scale, transform,
  ])}`;
}


const _flightPoint = { x: 0, y: 0, z: 0 };
const _flightDirection = { x: 0, y: 0, z: 0 };
const _sceneFlightDirection = new THREE.Vector3();
const _sceneUp = new THREE.Vector3(0, 1, 0);
const _scenePitchAxis = new THREE.Vector3(0, 0, 1);
const _flightYaw = new THREE.Quaternion();
const _flightPitch = new THREE.Quaternion();
const _spellVisualEuler = new THREE.Euler();
const _spellVisualLocalRotation = new THREE.Quaternion();
const _spellVisualRotation = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3();
const IDENTITY_QUATERNION = new THREE.Quaternion();
/** The inverse is needed when a spell model is parented to a unit/bone matrix already in scene space. */
const M2_FROM_SCENE = M2_TO_SCENE.clone().invert();

/**
 * Rotation for a spell model whose local forward axis is M2 +X.
 *
 * Spell endpoints use the server's x/y horizontal plane and z-up coordinates. The world scene is
 * x/y-up/-z, so the converted tangent is what the outer node must face; the inner model frame is
 * still handled by `#orientVisualFrame` for plain and skinned models alike.
 */
export function spellVisualFlightQuaternion(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  progress: number,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  // Keep the path math in SpellVisuals, which has no scene dependency, and only swap axes here.
  missileDirection(from, to, progress, _flightDirection);
  _sceneFlightDirection.set(_flightDirection.x, _flightDirection.z, -_flightDirection.y);
  if (_sceneFlightDirection.lengthSq() < 1e-12) return target.identity();
  const horizontal = Math.hypot(_sceneFlightDirection.x, _sceneFlightDirection.z);
  const yaw = Math.atan2(-_sceneFlightDirection.z, _sceneFlightDirection.x);
  const pitch = Math.atan2(_sceneFlightDirection.y, horizontal);
  // M2 +X is the model's forward axis. A scene yaw around +Y followed by a local +Z pitch maps
  // it to (cos(pitch)cos(yaw), sin(pitch), -cos(pitch)sin(yaw)) without introducing roll.
  return target.copy(_flightYaw.setFromAxisAngle(_sceneUp, yaw))
    .multiply(_flightPitch.setFromAxisAngle(_scenePitchAxis, pitch));
}

/** A stable seed from a placement's key, so one campfire's flicker survives being rebuilt. */
function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

/** Stable live placement seed, or a replay-seed/placement-key avalanche for deterministic runs. */
export function modelEffectSeed(key: string, replaySeed?: number): number {
  const placement = hashKey(key);
  if (replaySeed === undefined) return placement;
  if (!Number.isInteger(replaySeed) || replaySeed < 0 || replaySeed > 0xffffffff) {
    throw new RangeError("replay seed must be a uint32");
  }
  let mixed = (replaySeed + placement) >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d) >>> 0;
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function clampSize(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || value <= 0 ? fallback : Math.max(minimum, Math.min(maximum, value));
}

/** Current transport identity, with malformed present wire values kept distinguishable from absent. */
function gameObjectEntry(object: WorldObjectState): number | undefined {
  const raw = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset);
  if (raw === undefined) return 0;
  return Number.isSafeInteger(raw) && raw >= 0 && raw <= 0xffffffff ? raw : undefined;
}

/** Effective object scale, with malformed present wire values kept distinguishable from absent. */
function gameObjectScale(object: WorldObjectState): number | undefined {
  const raw = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset);
  if (raw === undefined) return 1;
  const value = fieldFloat(object, UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset);
  if (value === undefined || !(value > 0)) return undefined;
  return Math.max(0.05, Math.min(40, value));
}

function mappedVmapRotation(rotationX: number, rotationY: number, rotationZ: number): THREE.Matrix4 {
  const source = new THREE.Matrix4()
    .makeRotationZ(THREE.MathUtils.degToRad(rotationY))
    .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(rotationX)))
    .multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(rotationZ)));
  return new THREE.Matrix4().copy(VMAP_TO_THREE).multiply(source).multiply(VMAP_TO_THREE);
}
