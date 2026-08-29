import * as THREE from "three";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { fieldFloat, isWorldObjectDead, type WorldObjectState, type WorldPosition, type WorldState } from "../world/WorldState.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT,
  CAMERA_EYE_BODY_SHARE, CAMERA_FIRST_PERSON_DISTANCE, CAMERA_FOV_DEGREES, CAMERA_PIVOT_BODY_SHARE,
  cameraBodyHeight, createCamera, type HeightSampler,
} from "./SimpleScene.js";
import { ENVIRONMENT_RANGE, TERRAIN_GRID_SIZE, modelKey, terrainGrid, type EnvironmentClient, type EnvironmentModel, type EnvironmentObject, type TerrainClient } from "./Terrain.js";
import { EnvironmentSpatialIndex } from "./EnvironmentSpatialIndex.js";
import {
  selectGameObjectAdmission, selectUnitAdmission, stableBoundedTopK,
  type UnitAdmissionCandidate,
} from "./RenderAdmission.js";
import {
  applyTerrainSplat, setTerrainSplatMicroNormals, type TerrainSplatClient,
} from "./TerrainSplat.js";
import {
  GROUND_COVER_MARGIN, GROUND_COVER_MAX_RADIUS, groundCoverRecipeSource, scatterGroundCover,
  type GroundCoverBatch, type GroundCoverClient, type GroundCoverField,
} from "./GroundCover.js";
import { skyboxAnimationTimeMs } from "./LightClient.js";
import type { LightSample, ResolvedColour } from "./LightTypes.js";
import {
  lightingProfile, shadowMaterialEligible, stabiliseDirectionalShadowCenter,
  unitCastsEnhancedShadow, withToneShoulder,
  type LightingProfile,
} from "./LightingQuality.js";
import {
  applyWorldLight, createWorldLightUniforms, setWorldLightImmersiveStrength, setWorldLightUniforms,
  type WorldLightUniforms,
} from "./WorldLighting.js";
import {
  LIQUID_CELL_YARDS, applyFallbackLiquidShaderProfile, applyLiquidShaderProfile,
  buildLiquidMaterial, createWaterShaderSharedUniforms,
  liquidClassOf, updateLiquidMaterial,
  type LiquidClass, type LiquidMaterial, type LiquidTextureClient, type WaterShaderSharedUniforms,
} from "./Water.js";
import { DAY_HALF_MINUTES } from "../world/GameTimeProtocol.js";
import type { GameObjectDisplayMetadata } from "./GameObjectMetadata.js";
import type { CreatureModelMetadata, UnitModel } from "./CreatureModelClient.js";
import { ANIMATION_IDS } from "../generated/animations.js";
import {
  M2_TO_SCENE, actionAnimation, addSkinnedClips, animatesAsDoodad, applyBillboardBones, buildSkinnedTemplate,
  disposeSkinnedInstance,
  ACTION_ANIMATION_BLEND, animationBlend, animationFadeWindow, pendingActionFate,
  pendingActionExpired,
  buildSkinnedTemplateFrom, chooseAnimation, instantiateSkinned, isUnitFlying, isUnitMoving, poseAnimation,
  animationTransition, isTerminalUnitPose, needsSidecarAnimations, poseTransition, resolveActionAnimation,
  resolveAnimation, resolveSpellVisualAnimation,
  LOOP_ANIMATION_BLEND, SHOOT_METADATA_WAIT, mountSpecialAnimation,
  shouldPromoteActionToLocomotionOverlay,
  weaponPose,
  type SkinnedInstance, type SkinnedTemplate, type UnitAction, type UnitPose,
} from "./AnimatedModel.js";
import {
  EVERY_GEOSET, applyBlendMode, buildModel, characterSlots, setBuiltModelFantasyGlow,
  unitGeosets, updateBatchColours, worldCharacterGeosets,
  type AnimatedBatch, type BuiltModel, type GeosetChoice, type TextureSlots,
} from "./ModelBuild.js";
import {
  BuiltModelCache, disposeEvictedBuiltModels, knownGeometryBufferBytes,
  type BuiltModelCacheStats, type EvictedBuiltModel,
} from "./BuiltModelCache.js";
import {
  ModelTextureLoader, type ModelTextureLease, type ModelTextureResidencyStats,
} from "./TextureLoad.js";
import {
  WORLD_MATERIAL_CACHE_COUNT_LIMIT, WorldMaterialCache,
  type WorldMaterialEntry, type WorldMaterialResidencyStats,
} from "./WorldMaterialCache.js";
import { StandInLedger, type StandInReason, type StandInReport, type StandInWearing } from "./StandIn.js";
import {
  ATTACHMENT_HELM, ATTACHMENT_MOUNT_SEAT, ATTACHMENT_SHOULDER_RIGHT,
  TEXTURE_TYPE_BODY, TEXTURE_TYPE_OBJECT_SKIN, modelOwnTexturePaths, textureUrl, type WvmModel,
} from "./Wvm.js";
import {
  attachmentHeight, attachmentOffset, attachmentPoint, boneOf, mountNesting, mountSeatOffset,
} from "./Attachment.js";
import {
  wmoLandFogAt, wmoRunIsInterior, wmoVertexLight,
  type WmoFog, type WmoGroup, type WmoModel, type WmoRun,
} from "./WmoModel.js";
import {
  canonicalCollisionModelName,
  type StaticWmoFloor, type StaticWmoPlacementIdentity,
} from "./game/CollisionSource.js";
import { selectWmoPortalGroups } from "./WmoOcclusion.js";
import {
  animatesAsGameObject, customGameObjectAnimation, gameObjectPose,
  GO_TYPE_MO_TRANSPORT, GO_TYPE_TRANSPORT,
} from "./GameObjectAnimation.js";
import {
  TransportPathClient, placeOnTransportPath, sampleTransportPath, transportPhaseMs,
} from "./TransportPath.js";
import {
  HORIZON_FAR_PLANE, HorizonClient, buildHorizonGeometry, horizonTiles,
} from "./Horizon.js";
import {
  billboardView, buildModelEffects, disposeModelEffects, resetModelEffects, setModelEffectsFantasyGlow,
  updateModelEffects,
  visitModelEffectsResources, type ModelEffects,
} from "./ParticleRender.js";
import { WeatherEffect, advanceWeather, weatherDensity, type WeatherFade } from "./WeatherEffect.js";
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
import { unit as unitFields } from "../world/Fields.js";
import { UNIT_FLAG_UNINTERACTIBLE } from "../world/FactionRules.js";
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
  readonly experimentalShaderProfile: Readonly<ExperimentalShaderProfile>;
}

/** Renderer-level default-OFF baseline; account settings enable the reversible terrain/water leaves. */
export interface ExperimentalShaderProfile {
  readonly aerialHeightFog: boolean;
  readonly terrainMicroNormals: boolean;
  readonly waterFresnel: boolean;
  readonly waterMicroWaves: boolean;
  readonly waterSunSparkle: boolean;
  /** Local additive spell energy plus magma/slime self-emission; no post-process or extra pass. */
  readonly fantasyGlow: boolean;
}

export const DEFAULT_EXPERIMENTAL_SHADER_PROFILE: Readonly<ExperimentalShaderProfile> = Object.freeze({
  aerialHeightFog: false,
  terrainMicroNormals: false,
  waterFresnel: false,
  waterMicroWaves: false,
  waterSunSparkle: false,
  fantasyGlow: false,
});

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

/** Pins every retained legacy borrower, including intentionally hidden budget-dormant wrappers. */
export function collectLegacyResourcePins<TGeometry>(
  borrowers: Iterable<LegacyResourceBorrower<TGeometry>>,
  geometryPins: Set<TGeometry>,
  materialPins: Set<WorldMaterialEntry>,
): number {
  let borrowerCount = 0;
  for (const borrower of borrowers) {
    const entries = borrower.materialEntries ?? [];
    if (!borrower.legacyGeometry && entries.length === 0) continue;
    if (borrower.legacyGeometry) geometryPins.add(borrower.legacyGeometry);
    for (const entry of entries) materialPins.add(entry);
    borrowerCount++;
  }
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
  if (changed) texture.needsUpdate = true;
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

const ENVIRONMENT_BUDGET = 320;
/** Hidden placements retained from roughly three previous camera sectors for a bounded 360° turn. */
export const ENVIRONMENT_WARM_EXTERIOR_BUDGET = 960;
/** WMOs are room-heavy; keep their exterior shell on a smaller leash than loose outdoor objects. */
const WMO_EXTERIOR_RANGE = 250;
/**
 * A WMO's own doodads — the tables, kegs and book stacks inside a building — are drawn on a much
 * shorter leash. The original client hides them behind the building's portals; with no portals
 * here, distance is the cheap stand-in, and 60 m is about the point where a doorway stops showing
 * anything of the room behind it.
 */
const INTERIOR_RANGE = 60;
const INTERIOR_BUDGET = 120;
/** Interior counterpart of {@link ENVIRONMENT_WARM_EXTERIOR_BUDGET}. */
export const ENVIRONMENT_WARM_INTERIOR_BUDGET = 360;
const ENVIRONMENT_FRUSTUM_MARGIN = 1;

/** MOMT flag 0x04: this material is drawn from both sides. Everything else is back-face culled. */
const WMO_MATERIAL_UNCULLED = 0x04;

export interface RankedEnvironmentObject {
  object: EnvironmentObject;
  distance: number;
}

/** A retained static model's already-transformed scene-space visibility sphere. */
export interface EnvironmentVisibilitySphere {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

/**
 * Exact distance residents in source order, before visibility and the two draw quotas.
 *
 * Keeping this answer unbudgeted is what lets a camera turn replace hidden near objects with
 * visible farther ones without rescanning every loaded tile or performing a resource lookup.
 */
export function environmentCandidatesInRange(
  objects: readonly EnvironmentObject[],
  player: Pick<WorldPosition, "x" | "y">,
): RankedEnvironmentObject[] {
  const candidates: RankedEnvironmentObject[] = [];
  for (const object of objects) {
    const distance = placementDistance(object, player);
    const range = object.interior === true ? INTERIOR_RANGE : ENVIRONMENT_RANGE;
    if (distance < range) candidates.push({ object, distance });
  }
  return candidates;
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

/** Visibility first, then the unchanged independent exterior/interior stable quotas. */
export function selectEnvironmentAdmission(
  candidates: readonly RankedEnvironmentObject[],
  planes: readonly UnitFrustumPlane[],
  retainedSphereOf?: (object: EnvironmentObject) => EnvironmentVisibilitySphere | undefined,
): RankedEnvironmentObject[] {
  const closest = (interior: boolean, budget: number): RankedEnvironmentObject[] => {
    function* eligible(): Generator<RankedEnvironmentObject> {
      for (const candidate of candidates) {
        if ((candidate.object.interior === true) !== interior) continue;
        const retainedSphere = candidate.object.bounds === undefined
          ? retainedSphereOf?.(candidate.object)
          : undefined;
        if (!environmentObjectVisibleInFrustum(
          candidate.object,
          planes,
          ENVIRONMENT_FRUSTUM_MARGIN,
          retainedSphere,
        )) continue;
        yield candidate;
      }
    }
    return stableBoundedTopK(eligible(), budget, ({ distance }) => distance);
  };
  return [...closest(false, ENVIRONMENT_BUDGET), ...closest(true, INTERIOR_BUDGET)];
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
  if (!bounds) return Math.hypot(object.x - player.x, object.y - player.y);
  const outsideX = Math.max(bounds.minX - player.x, 0, player.x - bounds.maxX);
  const outsideY = Math.max(bounds.minY - player.y, 0, player.y - bounds.maxY);
  return Math.hypot(outsideX, outsideY);
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
 */
export function wmoGroupsInRange(model: WmoModel, boxes: readonly (THREE.Box3 | undefined)[], player: WorldPosition): number[] {
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
    // the whole WMO.
    const range = group.exterior || !group.indoor ? WMO_EXTERIOR_RANGE : INTERIOR_RANGE;
    const outsideX = Math.max(box.min.x - x, 0, x - box.max.x);
    const outsideZ = Math.max(box.min.z - z, 0, z - box.max.z);
    if (Math.hypot(outsideX, outsideZ) < range) chosen.push(index);
  }
  return chosen;
}

/**
 * One tile's height field, plus a one-vertex skirt around it for the normals to lean on.
 *
 * The corners of that skirt are never sampled: `surfaceNormal` asks for the four neighbours of a
 * vertex and nothing else, so the corner cells would be four more tile downloads per ring — 25
 * against 21 — read by nobody.
 */
export function terrainHeightField(grid: { x: number; y: number }, player: WorldPosition, heightAt: HeightSampler | undefined): Float32Array {
  const side = TERRAIN_SUBDIVISIONS + 1;
  const step = TERRAIN_GRID_SIZE / TERRAIN_SUBDIVISIONS;
  const inside = 1 - TERRAIN_EDGE_EPSILON;
  const skirt = side + 2;
  const heights = new Float32Array(skirt * skirt);
  const at = (row: number, column: number) => (row + 1) * skirt + (column + 1);
  for (let row = -1; row <= side; row++) {
    // The far edge of a tile belongs to the next one, so a sample exactly on it would read across
    // the join; pulled a hair inside, it reads this tile's own last row.
    const u = Math.min(row / TERRAIN_SUBDIVISIONS, inside);
    const outsideRow = row < 0 || row > TERRAIN_SUBDIVISIONS;
    const sampleX = outsideRow
      ? (32 - grid.x) * TERRAIN_GRID_SIZE - row * step
      : (32 - grid.x - u) * TERRAIN_GRID_SIZE;
    for (let column = -1; column <= side; column++) {
      const outsideColumn = column < 0 || column > TERRAIN_SUBDIVISIONS;
      if (outsideRow && outsideColumn) continue;
      const v = Math.min(column / TERRAIN_SUBDIVISIONS, inside);
      const sampleY = outsideColumn
        ? (32 - grid.y) * TERRAIN_GRID_SIZE - column * step
        : (32 - grid.y - v) * TERRAIN_GRID_SIZE;
      const height = heightAt?.(sampleX, sampleY);
      // Inside the tile a missing sample means this tile's own data has not landed, and the flat
      // stand-in is what the player sees until it does. Outside it means a neighbour is missing —
      // or does not exist, which is true of 1,746 of the world's 5,744 tiles — and that is answered
      // by continuing this tile's own slope rather than by a constant.
      heights[at(row, column)] = height ?? (outsideRow || outsideColumn ? Number.NaN : player.z);
    }
  }
  for (let index = 0; index < side; index++) {
    fillOutside(heights, at(-1, index), at(0, index), at(1, index));
    fillOutside(heights, at(side, index), at(side - 1, index), at(side - 2, index));
    fillOutside(heights, at(index, -1), at(index, 0), at(index, 1));
    fillOutside(heights, at(index, side), at(index, side - 1), at(index, side - 2));
  }
  return heights;
}

/** The scene normals of a field returned by `terrainHeightField`, one per mesh vertex. */
export function terrainNormals(heights: Float32Array): Float32Array {
  const side = TERRAIN_SUBDIVISIONS + 1;
  const step = TERRAIN_GRID_SIZE / TERRAIN_SUBDIVISIONS;
  const skirt = side + 2;
  const heightOf = (row: number, column: number) => heights[(row + 1) * skirt + (column + 1)]!;
  const normals = new Float32Array(side * side * 3);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const normal = surfaceNormal(
        heightOf(row - 1, column), heightOf(row + 1, column),
        heightOf(row, column - 1), heightOf(row, column + 1), step);
      const at = (row * side + column) * 3;
      normals[at] = normal[0];
      normals[at + 1] = normal[1];
      normals[at + 2] = normal[2];
    }
  }
  return normals;
}

/**
 * A skirt sample the world could not answer, continued from the two rows inside it.
 *
 * `h[-1] = 2·h[0] − h[1]` — the tile's own slope carried one step further. Measured against the
 * fully-loaded truth on six joins, this leaves 1.1 to 5.3 degrees of error along the edge where
 * the player's height left 19 to 102, and clamping to the edge value left 2.4 to 13.0.
 */
function fillOutside(heights: Float32Array, outside: number, edge: number, inward: number): void {
  if (!Number.isNaN(heights[outside]!)) return;
  heights[outside] = 2 * heights[edge]! - heights[inward]!;
}

/**
 * The scene-space normal of a height field, from its four neighbours.
 *
 * World x runs north and y west with z up, and the scene draws that as (x, z, -y), so the world
 * normal `(-dz/dx, -dz/dy, 1)` arrives here with its last two components swapped and the middle
 * one uprighted. `north` and `south` are the heights a step either side along x, `west` and `east`
 * along y.
 */
export function surfaceNormal(north: number, south: number, west: number, east: number, step: number): [number, number, number] {
  const slopeX = (north - south) / (2 * step);
  const slopeY = (west - east) / (2 * step);
  const length = Math.hypot(slopeX, 1, slopeY) || 1;
  return [-slopeX / length, 1 / length, slopeY / length];
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
export function drawableModel(model: EnvironmentModel | undefined): model is EnvironmentModel {
  return model !== undefined && (model.wvm !== undefined || model.wmo !== undefined || model.visual === true);
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
  return new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 16 / 9, 0.25, HORIZON_FAR_PLANE);
}

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
  centre: WorldPosition,
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

import {
  CharacterAtlasClient, appearanceKey, configureCharacterAtlasTexture,
  type CharacterAppearance, type CharacterAtlasResidencyStats,
} from "./CharacterAtlas.js";
import { PortraitRenderer, type PortraitSource, type PortraitSlot, type PortraitTarget } from "./PortraitRenderer.js";

interface RenderedEnvironment {
  actual: boolean;
  node: THREE.Object3D;
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
  /** Its world matrix, computed once when it was placed. Nothing in the environment ever moves. */
  instanceMatrix?: THREE.Matrix4;
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
  /** Revision of this tile alone: only a change here moves a vertex or reopens a hole. */
  ownRevision: number;
  /** Whether the ground textures have arrived and the blending shader is in place. */
  splatted: boolean;
  /** Which liquid strips had arrived when these surfaces were built. */
  liquidGeneration: number;
  /** One mesh per liquid class the tile contains. */
  water?: THREE.Mesh[];
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

interface RenderedUnit extends PosedModel {
  node: THREE.Group;
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
/**
 * Height samples are nudged this far inside the tile. Exactly on the far edge the world
 * coordinate already belongs to the next grid cell, so an unclamped sample would read a
 * neighbour tile — and return nothing at all until that neighbour has been downloaded, which
 * left a cliff along every tile seam.
 */
const TERRAIN_EDGE_EPSILON = 1e-6;
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
const EFFECT_BUDGET = 32;
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
/** Extra world-space padding around a conservative unit sphere to avoid edge-of-screen pop-in. */
const UNIT_FRUSTUM_MARGIN = 1;
const INSTANCE_MINIMUM = 2;
const UNIT_DEFAULT_HEIGHT = 2;
const UNIT_DEFAULT_RADIUS = 0.45;
const SELF_TINT = 0x4fc47f;
const PLAYER_TINT = 0x5aa2e8;
const CORPSE_TINT = 0x6c6a63;
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
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #gpuTimer: GpuTimer<WebGLQuery>;
  readonly #scene = new THREE.Scene();
  /** Background pass: authored transparent sky layers must be drawn before world depth exists. */
  readonly #skyScene = new THREE.Scene();
  readonly #camera = buildWorldCamera();
  readonly #environmentGroup = new THREE.Group();
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
  /** Mount-special packets can arrive before the rider or mount has been admitted and built. */
  readonly #mountSpecials = new Map<bigint, number>();
  /**
   * The rings under the target and the focus, and who they are under.
   *
   * Two meshes rather than one per unit: only two units in the world ever wear one, and rebuilding
   * a geometry when the target changes would be a new buffer every time the player pressed Tab.
   */
  readonly #selectionRings = new Map<"target" | "focus", RenderedSelectionRing>();
  /** Rain, snow, sand or fog over the camera. Built on first use: it needs the texture route. */
  #weather: WeatherEffect | undefined;
  /** The last packet, by identity, so its `abrupt` flag is honoured once rather than every frame. */
  #weatherPacket: Weather | undefined;
  #weatherFade: WeatherFade = { kind: "fine", density: 0, storm: 0 };
  #weatherAbrupt = false;
  #selection: { target: SelectionRing | undefined; focus: SelectionRing | undefined } = { target: undefined, focus: undefined };
  /**
   * One-shots the packets asked for: a swing, a cast, an emote.
   *
   * Kept here rather than on the unit because they arrive from the network between frames, for
   * units that may not even be on screen yet, and because the animation they resolve to depends on
   * what the unit turns out to be holding when it is drawn.
   */
  readonly #actions = new Map<bigint, {
    wanted: number[];
    hold: number;
    loop: boolean;
    action: UnitAction | undefined;
    sequence?: { animation: number; mode: VisualAnimationMode; hold: number };
    sequenceAt: number;
    /**
     * How long a request may wait for keyframes that are still on their way.
     *
     * The whole chain was assembled and then broke here. Of the 165 emotes the table names, only
     * nine resolve to an animation that travels with every model; the other 156 are in the sidecar
     * and are one request away. The first frame that wants one finds no clip, sends the request
     * and — until now — deleted the record, so the emote was over before its keyframes landed. The
     * second one deleted it too, because the request had not come back yet either. **Two emotes
     * per model were lost every time, always, before anything could ever play.**
     */
    waitUntil: number;
    /** Held precasts/channels may be cancelled; ordinary one-shots and future impacts may not. */
    cancelable: boolean;
    source: "external" | "visual";
    /** Present for a visual action, and used to cancel only its owning cast. */
    visualHandle?: SpellVisualHandle;
  }>();
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
  /** R5.4 faithful-plus leaves; aerial remains a state-only/no-op branch. */
  #experimentalShaderProfile: Readonly<ExperimentalShaderProfile> = DEFAULT_EXPERIMENTAL_SHADER_PROFILE;
  #renderScale = 1;
  /** While true, UI portrait ownership cannot pin or retain units in a fixed replay. */
  #formalBenchmarkIsolation = false;
  /** Loss/restoration invalidates the GPU resource epoch even when dimensions later match again. */
  #webGlContextGeneration = 0;
  #disposed = false;
  readonly #contextLostListener = (): void => { this.#webGlContextGeneration++; };
  readonly #contextRestoredListener = (): void => { this.#webGlContextGeneration++; };
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
  readonly #zoneFogColour = new THREE.Color(SKY_COLOR);
  #zoneFogNear = 180;
  #zoneFogFar = 640;
  /** The Light.dbc slot is selected by the camera eye; land MFOG must not overwrite it underwater. */
  #underwater = false;
  /** Collision-selected static WMO floor and its one unambiguous visual placement this frame. */
  #wmoFloor: StaticWmoFloor | undefined;
  #wmoFogVisualId: number | undefined;
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
  readonly #sunOffset = new THREE.Vector3(0, 400, 0);
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
  readonly #liquidMaterials = new Map<LiquidClass, LiquidMaterial>();
  readonly #waterShaderUniforms: WaterShaderSharedUniforms = createWaterShaderSharedUniforms();
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
  /** How many units were drawn last frame, and how many the budget turned away. */
  #unitsDrawn = 0;
  #unitsDropped = 0;
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
  #environmentCandidatesAt: { x: number; y: number; generation: number } | undefined;
  /** Bumped whenever `objectsAround` hands over a different array, which is when a tile lands. */
  #environmentGeneration = 0;
  #environmentObjects: readonly EnvironmentObject[] | undefined;
  #environmentSpatialIndex: EnvironmentSpatialIndex | undefined;
  /** One `InstancedMesh` per repeated doodad model, and the placements it stands in for. */
  readonly #instances = new Map<string, {
    mesh: THREE.InstancedMesh;
    capacity: number;
    built: BuiltModel;
  }>();
  /** Set when a placement is made or dropped: the matrices themselves never change. */
  #instancesDirty = false;
  /**
   * The grass, kept entirely apart from the placements above.
   *
   * A field of three and a half thousand tufts must never reach `#environment`: that map costs one
   * `Object3D`, one entry and one model lookup each, and `selectEnvironment` ranks what is in it.
   * Ground cover has no ids, no bounds and nothing to rank — it is scattered from a recipe inside
   * its own radius and written straight into one instanced draw per model.
   */
  readonly #groundCoverGroup = new THREE.Group();
  readonly #groundCoverMeshes = new Map<string, {
    mesh: THREE.InstancedMesh;
    capacity: number;
    built: BuiltModel;
  }>();
  #groundCover: GroundCoverClient | undefined;
  #groundCoverRadius = 0;
  #groundCoverDense = true;
  #groundCoverField: GroundCoverField | undefined;
  /** Models whose artifact has not arrived yet, retried on the frames between rebuilds. */
  readonly #groundCoverPending = new Set<string>();
  #groundCoverAt: { x: number; y: number; map: number; generation: number } | undefined;
  /** Bumped by a setting, so a radius the player has just moved takes effect on the next frame. */
  #groundCoverSettings = 0;
  /** Selected scatter state survives a frame; drawn is recomputed from submitted meshes each frame. */
  #groundCoverSelected = 0;
  #groundCoverSelectionDroppedCells = 0;
  #groundCoverDrawn = 0;
  /** One matrix, written thousands of times a rebuild and read straight into the buffer. */
  readonly #coverMatrix = new THREE.Matrix4();
  readonly #frustum = new THREE.Frustum();
  readonly #frustumMatrix = new THREE.Matrix4();
  readonly #unitSphere = new THREE.Sphere();
  readonly #wmoModelToClip = new THREE.Matrix4();
  readonly #wmoCameraModel = new THREE.Vector3();
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
    // Stand-ins and legacy merged artifacts do not pass through ModelBuild, but removing the
    // HemisphereLight must not turn them black. Give every shared lit fallback the same authored
    // equation before any of them can compile.
    for (const material of [
      this.#wmoMaterial, this.#m2Material, this.#stoneMaterial,
      this.#woodMaterial, this.#metalMaterial,
    ]) applyWorldLight(material, this.#worldLight, "surface");
    applyWorldLight(this.#foliageMaterial, this.#worldLight, "foliage");
    this.#scene.add(this.#sun, this.#sun.target,
      this.#environmentGroup, this.#groundCoverGroup, this.#gameObjectGroup, this.#unitGroup,
      this.#effectGroup, this.#visualGroup);
    this.setLightingQuality(1);
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
      this.#resetLightingDefaults();
      this.#waterShaderUniforms.underwater.value = underwater ? 1 : 0;
      return;
    }
    this.#lightSample = sample;
    this.#skyboxPath = sample.skyboxPath;
    if (time !== undefined && Number.isFinite(time)) this.#lightTime = time;
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

    if (time !== undefined) {
      const direction = sunDirection(time);
      this.#worldLight.wowSunDirection.value.set(direction.x, direction.y, direction.z);
      this.#waterShaderUniforms.sunDirection.value.copy(this.#worldLight.wowSunDirection.value);
      this.#sunOffset.set(direction.x, direction.y, direction.z).multiplyScalar(400);
      this.#sun.position.copy(this.#sun.target.position).add(this.#sunOffset);
    }
  }

  /** Restore the same neutral sky/light state used while a map's Light.dbc rows are loading. */
  #resetLightingDefaults(): void {
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
    this.#waterShaderUniforms.underwater.value = 0;
    this.#sun.intensity = 0;
    this.#sunOffset.set(0, 400, 0);
    this.#worldLight.wowSunDirection.value.set(0, 1, 0);
    this.#sun.position.copy(this.#sun.target.position).add(this.#sunOffset);
  }

  /** MFOG is a frame override; the outdoor sample remains the fallback waiting underneath it. */
  #restoreZoneFog(): void {
    const fog = this.#scene.fog as THREE.Fog;
    fog.color.copy(this.#zoneFogColour);
    fog.near = this.#zoneFogNear;
    fog.far = this.#zoneFogFar;
  }

  /** Immutable renderer-only telemetry for diagnostics and benchmark capture. */
  get telemetry(): Readonly<RendererTelemetrySnapshot> {
    return makeRendererTelemetrySnapshot({
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
    this.#spellTextures.visitRetainedResources(visitor);
    this.#weather?.visitRetainedResources(visitor);
    if (!this.#formalBenchmarkIsolation) this.#portraits.visitRetainedResources(visitor);

    const shadow = this.#sun.shadow;
    if (shadow.map) visitor.referenceGpuRenderTarget(this.#sun, shadow.map);
    if (shadow.mapPass) visitor.referenceGpuRenderTarget(this.#sun, shadow.mapPass);
  }

  /**
   * What the last frame cost, in the words the status line uses.
   *
   * Every budget in this file carries a comment saying slice R8 is where its number stops being
   * guessed at, and until this existed none of them could be: the client measured nothing. Tail
   * percentiles make repeated pressure comparable between runs; the worst frame remains beside
   * them because a rare stutter can still fall above p99 in this two-second window.
   */
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
    for (const rendered of this.#terrains.values()) {
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
    return `WebGL · terrain ${this.#terrains.size} (${(terrainTriangles / 1000).toFixed(0)}k тр.)`
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
    return cameraBodyHeight(
      attachment === undefined ? undefined : attachment * (unit?.scale ?? 1),
      body, share, fallback) + seat;
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
      this.#setUnitAnimation(animation, "visual",
        (animation.mode ?? (animation.hold > 0 ? "hold" : "once")) === "hold", handle);
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
    for (const [guid, action] of this.#actions) {
      if (action.source !== "visual") continue;
      this.#stopActionIfPlaying(guid, action);
      this.#actions.delete(guid);
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
    for (const [guid, action] of this.#actions) {
      if (action.visualHandle !== handle) continue;
      this.#stopActionIfPlaying(guid, action);
      this.#actions.delete(guid);
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
    for (const action of this.#actions.values()) {
      if (action.visualHandle !== handle) continue;
      if (action.loop) action.hold = endsAt;
      if (action.sequence?.mode === "hold") action.sequence.hold = endsAt;
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
    }
    this.#weather.set(
      this.#indoors ? { ...this.#weatherFade, density: 0 } : this.#weatherFade,
      packet ? weatherIsBlack(packet.state) : false,
    );
    this.#weather.update(this.#camera.position, elapsed);
  }

  /**
   * Loads the LightSkybox model named by the active light profile and keeps it at the camera. The
   * procedural dome is deliberately left in place underneath: old archives often have a Light row
   * without a matching M2, and an unavailable optional model must not turn a whole zone black.
   */
  #updateSkybox(camera: THREE.Camera, client: EnvironmentClient | undefined): void {
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

  /** Where to find a model's own liquid. Told once, like everything else the frame hands over. */
  setCollisionModels(models: ((name: string) => CollisionModel | undefined) | undefined): void {
    this.#collisionModels = models;
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
    radius = this.#groundCoverRadius, dense = this.#groundCoverDense): void {
    const clamped = Math.max(0, Math.min(GROUND_COVER_MAX_RADIUS, Number.isFinite(radius) ? radius : 0));
    if (this.#groundCover === client && this.#groundCoverRadius === clamped && this.#groundCoverDense === dense) return;
    this.#groundCover = client;
    this.#groundCoverRadius = clamped;
    this.#groundCoverDense = dense;
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

  /** Assigns the five DOM outputs. The render targets themselves remain owned by the renderer. */
  setPortraitTargets(targets: ReadonlyMap<PortraitSlot, PortraitTarget>): void {
    this.#portraits.setTargets(targets);
  }

  /** Reads dirty portrait render targets into their 2D canvases after the world pass. */
  renderPortraits(now = performance.now()): number {
    return this.#portraits.render(now);
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
    for (const [key, rendered] of this.#terrains) this.#removeTerrain(key, rendered);
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

    this.clearSpellVisuals();
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
    this.#portraits.clear();

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
    for (const entry of this.#wmoGeometries.values()) {
      if (geometries.has(entry.geometry)) continue;
      geometries.add(entry.geometry);
      entry.geometry.dispose();
    }
    this.#wmoGeometries.clear();
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
    this.#environmentCandidatesAt = undefined;
    this.#instancesDirty = false;
    this.#groundCover = undefined;
    this.#groundCoverAt = undefined;
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
    this.#selection = { target: undefined, focus: undefined };
    this.#weatherPacket = undefined;
    this.#weatherFade = { kind: "fine", density: 0, storm: 0 };
    this.#weatherAbrupt = false;
    this.#replaySeed = undefined;
    this.#realModels = 0;
    this.#experimentalShaderProfile = DEFAULT_EXPERIMENTAL_SHADER_PROFILE;
    this.#waterShaderUniforms.time.value = 0;
    this.#resetLightingDefaults();
    this.#frames.reset();
    this.#cadence.reset();
    this.#gpuTimer.resetEpoch();
    this.#renderer.info.reset();
    this.#renderer.renderLists.dispose();
    this.#sun.shadow.dispose();
    this.#resetFrameCounters();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clearWorldResources();
    this.#canvas.removeEventListener("webglcontextlost", this.#contextLostListener);
    this.#canvas.removeEventListener("webglcontextrestored", this.#contextRestoredListener);
    this.#portraits.dispose();
    this.#gpuTimer.dispose();
    for (const geometry of [
      this.#unitBodyGeometry, this.#unitFacingGeometry, this.#foliageGeometry, this.#trunkGeometry,
      this.#sky.geometry,
    ]) geometry.dispose();
    for (const material of [
      this.#horizonMaterial, this.#wmoMaterial, this.#m2Material, this.#stoneMaterial,
      this.#woodMaterial, this.#metalMaterial, this.#foliageMaterial,
      ...(Array.isArray(this.#sky.material) ? this.#sky.material : [this.#sky.material]),
    ]) material.dispose();
    this.#scene.clear();
    this.#skyScene.clear();
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
      const position = object?.position;
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

  #updateVisuals(now: number, elapsed: number, client: EnvironmentClient | undefined): void {
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
      this.#setUnitAnimation(pending.animation, "visual",
        (pending.animation.mode ?? (pending.animation.hold > 0 ? "hold" : "once")) === "hold",
        pending.handle);
    }
    // Propagate a request-grace timeout to every member before authored-lifetime cleanup runs. This
    // is the persistent terminal transition that prevents a loaded sibling from becoming a partial
    // kit while its missing missile/impact is being removed on the same frame.
    this.#markExpiredSpellEffectPhases(now);
    // A terminal phase owns no visible model or emitter resources. Purge every member before the
    // loader loop below can observe a late WVM and rebuild a failed aura/missile.
    this.#purgeFailedSpellEffectPhases();
    const expired = this.#visuals
      .map((visual, index) => ({ visual, index }))
      .filter(({ visual }) => visual.instance.endsAt <= now
        && !this.#phaseNeedsSettlement(visual, now)
        && (visual.loadDeadline === undefined || now >= visual.loadDeadline))
      .map(({ index }) => index);
    for (const index of expired.reverse()) {
      const visual = this.#visuals[index]!;
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
            anisotropy: this.#renderer.capabilities.getMaxAnisotropy(),
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
          }
        }
      }

      // Preloading/building a future model is intentional, but neither its transform nor its
      // emitters may become visible before the schedule says so.
      visual.node.visible = started;
      if (!started) continue;

      if (visual.skinned) {
        visual.skinned.mixer.update(elapsed);
        visual.skinned.root.updateMatrixWorld(true);
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
          bone.matrixWorld.decompose(visual.node.position, visual.node.quaternion, _scratchScale);
          visual.node.scale.setScalar(instance.scale * _scratchScale.x);
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
    if (visual.skinned && visual.template) applyBillboardBones(visual.skinned, visual.template, this.#camera);
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
    return boneOf(unit.wvm, unit.skinned, attachment);
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
    const player = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
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
      const visual = uniqueVisualWmoPlacement(wmoFloor.placement, objects);
      if (visual) {
        this.#wmoFloor = wmoFloor;
        this.#wmoFogVisualId = visual.id;
      }
    }
    this.#liquidTextures = liquidTextures;
    // Zero orbit distance puts the camera inside the character's own head, where its body fills
    // the screen. Hidden rather than dropped, so leaving first person costs no rebuild.
    this.#firstPerson = cameraAnchorDistance <= CAMERA_FIRST_PERSON_DISTANCE;
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
    // Water programs borrow one stable set of uniforms; mutate values rather than allocating per
    // material or per frame.  The clock is wall time so its phase also remains stable for a hidden
    // water surface that returns to the scene later in the same world session.
    this.#waterShaderUniforms.time.value = now / 1000;
    this.#waterShaderUniforms.underwater.value = this.#underwater ? 1 : 0;
    this.#waterShaderUniforms.sunDirection.value.copy(this.#worldLight.wowSunDirection.value);
    this.#waterShaderUniforms.sunColour.value.copy(this.#worldLight.wowDiffuse.value);
    this.#updateTerrain(player.position, map, heightAt, terrainClient, splatClient);
    this.#updateHorizon(player.position, map, horizonClient);
    this.#updateEnvironment(player.position, objects, environmentClient, elapsed);
    this.#applyWmoFogCandidate();
    this.#updateSkybox(this.#camera, environmentClient);
    this.#updateSkyboxAnimation();
    // After the environment, because it borrows that pass's model queue and its built geometry.
    this.#updateGroundCover(player.position, map, heightAt, terrainClient, environmentClient);
    this.#updateGameObjects(state, player.position, environmentClient, gameObjectMetadata,
      gameObjectMetadataRevision, transportPaths, now, elapsed);
    this.#updateUnits(state, player.position, now, elapsed, environmentClient, creatureModel, displayAnswered,
      mountModel);
    // After the units, because a ring is sized from the body the pass above measured.
    this.#updateSelectionRings(state, heightAt);
    // Before the emitters and after the units: a flourish in somebody's hand reads their bone,
    // and its own emitters then read the flourish.
    this.#updateVisuals(now, elapsed, environmentClient);
    // After everything has been placed and posed, and before anything is drawn: an emitter reads
    // the matrix of the bone it hangs on, and that matrix is only right once the pose is.
    this.#updateEffects(player.position, now, elapsed);
    // Last admission point for renderer-owned geometry caches. Every live borrower above now
    // carries its exact entry identity, so inactive LRU entries can be disposed without path guesses.
    this.#evictWmoResources();
    this.#evictBuiltModelCaches();
    // Spell bases are released only after complete phase admission/cleanup above; this is the
    // first point where every live mesh/emitter borrower holds its exact record lease.
    this.#spellTextures.evictUnleased();
    // These are the admitted, non-empty effect groups and instance matrices handed to this frame's
    // scene submission. Cached entries are deliberately not counted by the telemetry getter.
    for (const held of this.#effects.values()) {
      if (held.effects !== EMPTY_EFFECTS) this.#effectsDrawn++;
    }
    for (const { mesh } of this.#groundCoverMeshes.values()) this.#groundCoverDrawn += mesh.count;
    this.#updateBatchColours(now);
    this.#updateWeather(elapsed);
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
    try {
      this.#renderer.autoClear = true;
      this.#renderer.render(this.#skyScene, this.#camera);
      this.#renderer.autoClear = false;
      this.#renderer.clearDepth();
      this.#renderer.render(this.#scene, this.#camera);
      if (!webGlContextCanSubmit(submissionContext)) return undefined;
    } finally {
      this.#renderer.autoClear = autoClear;
    }
    const submissionSerial = this.#submissionSerial + 1;
    if (!Number.isSafeInteger(submissionSerial)) {
      throw new RangeError("world submission serial exhausted");
    }
    this.#submissionSerial = submissionSerial;
    return Object.freeze({ submitted: true as const, submissionSerial });
  }

  #resetFrameCounters(): void {
    this.#drawCalls = 0;
    this.#triangles = 0;
    this.#unitsDrawn = 0;
    this.#unitsDropped = 0;
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
   * Lighting quality changes a bounded ALU grade, authored immersive-light strength and shadow-map
   * resolution. Quality 0 keeps the authored baseline exact; higher grades add the optional pass
   * without allowing a context that cannot allocate the requested shadow texture to break lighting.
   */
  setLightingQuality(quality: number): void {
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
    if (shadows) {
      this.#sun.shadow.mapSize.set(next.shadowMapSize, next.shadowMapSize);
      const camera = this.#sun.shadow.camera;
      camera.left = -next.shadowExtent;
      camera.right = next.shadowExtent;
      camera.top = next.shadowExtent;
      camera.bottom = -next.shadowExtent;
      camera.near = 1;
      camera.far = 800;
      camera.updateProjectionMatrix();
      this.#sun.shadow.intensity = next.shadowIntensity;
      this.#sun.shadow.bias = -0.00025;
      this.#sun.shadow.normalBias = 0.06;
      this.#sun.shadow.radius = next.shadowRadius;
      this.#sun.shadow.needsUpdate = true;
    }
    for (const terrain of this.#terrains.values()) terrain.mesh.receiveShadow = shadows;
    // No material is mutated. Existing unit trees are reclassified once on their next draw.
    for (const unit of this.#units.values()) unit.shadowCaster = undefined;
  }

  /** Moving light and target together preserves the authored direction while centring its map. */
  #syncSun(player: WorldPosition): void {
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

  /** Apply object flags only; shared model materials and their alpha/texture state remain intact. */
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
    this.#atlases?.setAnisotropy(enabled ? this.#renderer.capabilities.getMaxAnisotropy() : 1);
  }

  /**
   * Applies the six R5 faithful-plus leaves. Aerial remains a state-only/no-op leaf; terrain and
   * water changes are pushed into existing materials without changing their owned resources.
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
      fantasyGlow: profile?.fantasyGlow === true,
    });
    const current = this.#experimentalShaderProfile;
    if (current.aerialHeightFog === next.aerialHeightFog
      && current.terrainMicroNormals === next.terrainMicroNormals
      && current.waterFresnel === next.waterFresnel
      && current.waterMicroWaves === next.waterMicroWaves
      && current.waterSunSparkle === next.waterSunSparkle
      && current.fantasyGlow === next.fantasyGlow) return;
    this.#experimentalShaderProfile = next;
    for (const terrain of this.#terrains.values()) {
      if (terrain.splatted) setTerrainSplatMicroNormals(terrain.material, next.terrainMicroNormals);
    }
    for (const [liquidClass, material] of this.#liquidMaterials) {
      applyLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
    }
    for (const [liquidClass, material] of this.#fallbackLiquidMaterials) {
      applyFallbackLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
    }
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
    if (Math.abs(this.#renderer.getPixelRatio() - wanted) < 1e-4) return;
    this.#renderer.setPixelRatio(wanted);
    // The size is remembered in CSS pixels, so changing the ratio has to re-derive the buffer.
    this.#renderer.setSize(Math.max(1, this.#canvas.clientWidth), Math.max(1, this.#canvas.clientHeight), false);
  }

  #resize(): void {
    const width = Math.max(1, this.#canvas.clientWidth);
    const height = Math.max(1, this.#canvas.clientHeight);
    const pixelRatio = this.#renderer.getPixelRatio();
    // `Math.floor`, which is what `setSize` writes. Rounding here instead meant that at a
    // fractional pixel ratio — which the render scale setting now makes ordinary — the comparison
    // never agreed and the buffer was re-sized on every frame for ever.
    if (this.#canvas.width !== Math.floor(width * pixelRatio) || this.#canvas.height !== Math.floor(height * pixelRatio)) {
      this.#renderer.setSize(width, height, false);
      this.#camera.aspect = width / height;
      this.#camera.updateProjectionMatrix();
    }
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
      distance: number;
      posed?: PosedModel;
      visual?: THREE.Object3D;
      spell?: RenderedVisual;
      spellFirstEligible?: boolean;
      phaseKey?: string;
    }[] = [];
    const near = (x: number, y: number, z: number): number =>
      Math.hypot(x - player.x, y - player.y, z - player.z);

    for (const [id, rendered] of this.#environment) {
      if (!rendered.admitted || !rendered.wvm
        || rendered.wvm.particleEmitters.length + rendered.wvm.ribbonEmitters.length === 0) continue;
      const at = rendered.node.position;
      const distance = near(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE) continue;
      const entry: (typeof wanted)[number] = { key: `env:${id}`, wvm: rendered.wvm, distance };
      if (rendered.visual) entry.visual = rendered.visual;
      wanted.push(entry);
    }
    if (this.#skyboxModel && this.#skyboxVisual
      && this.#skyboxModel.particleEmitters.length + this.#skyboxModel.ribbonEmitters.length > 0) {
      // A LightSkybox is not a terrain placement, so it is absent from #environment. Include its
      // camera-relative emitters explicitly; otherwise cloud/spark systems in authored zone skies
      // silently disappear even though the mesh itself loaded.
      wanted.push({ key: "skybox", wvm: this.#skyboxModel, distance: 0, visual: this.#skyboxVisual });
    }
    for (const [guid, rendered] of this.#gameObjects) {
      if (!rendered.node.visible || !rendered.wvm
        || rendered.wvm.particleEmitters.length + rendered.wvm.ribbonEmitters.length === 0) continue;
      // Same rule as the units below: something to hang the emitters on, or they are drawn at the
      // world origin. A rigged game object has bones; an unrigged one has its mesh.
      if (!rendered.skinned && !rendered.visual) continue;
      const at = rendered.node.position;
      const distance = near(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE) continue;
      const entry: (typeof wanted)[number] = { key: `obj:${guid}`, wvm: rendered.wvm, distance, posed: rendered };
      if (rendered.visual) entry.visual = rendered.visual;
      wanted.push(entry);
    }
    for (const [guid, unit] of this.#units) {
      if (!unit.wvm || unit.wvm.particleEmitters.length + unit.wvm.ribbonEmitters.length === 0) continue;
      // A unit halfway through changing model — a druid shifting, a body whose atlas has not
      // composed yet — still remembers which file its emitters came from and has nothing to hang
      // them on. Emitting anyway would put its sparks at the world origin, because that is what a
      // missing frame is.
      if (!unit.skinned && !unit.visual) continue;
      const at = unit.node.position;
      const distance = near(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE) continue;
      const entry: (typeof wanted)[number] = { key: `unit:${guid}`, wvm: unit.wvm, distance, posed: unit };
      if (unit.visual) entry.visual = unit.visual;
      wanted.push(entry);
    }

    // Spell visuals are ranked and budgeted apart from the scenery, for the same reason a tile's
    // own doodads are ranked apart from what stands on the ground: a fight is a burst of two
    // dozen short-lived effects, and merged into one list they would put out every campfire in
    // the zone for a second and then hand them back.
    const visuals: (typeof wanted)[number][] = [];
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
    const readyPhaseKeys = new Set([...phaseStatuses]
      .filter(([, status]) => status === "ready").map(([phaseKey]) => phaseKey));
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
    const phaseEmitterGroups = new Set(this.#visuals
      .filter((visual) => visual.wvm !== undefined
        && visual.wvm.particleEmitters.length + visual.wvm.ribbonEmitters.length > 0)
      .map((visual) => `${visual.handle.id}:${visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt)}`));
    const phaseAdmissionRejected = rejectedVisualEffectGroups(this.#visuals.map((visual) => {
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      const at = visual.node.position;
      return {
        groupKey: `${visual.handle.id}:${phaseKey}`,
        due: visualHasStarted(visual.instance, now),
        rootVisible: visual.node.visible,
        hasEmitter: phaseEmitterGroups.has(`${visual.handle.id}:${phaseKey}`),
        distance: near(at.x, -at.z, at.y),
      };
    }), EFFECT_RANGE);
    for (const visual of this.#visuals) {
      // A future visual may already have its WVM and built geometry, but it must not age particle
      // or ribbon emitters before its authored start. Root-bound effects are also hidden while
      // their unit is unavailable, so they cannot accidentally simulate at the origin.
      if (!visual.node.visible) continue;
      if (!visual.wvm || visual.wvm.particleEmitters.length + visual.wvm.ribbonEmitters.length === 0) continue;
      const at = visual.node.position;
      const distance = near(at.x, -at.z, at.y);
      if (distance > EFFECT_RANGE) continue;
      const phaseKey = visualEffectPhaseKey(visual.handle.id, visual.instance.startedAt);
      if (!readyPhaseKeys.has(phaseKey)) continue;
      if (phaseAdmissionRejected.has(`${visual.handle.id}:${phaseKey}`)) continue;
      const firstEligible = visual.effectsEligibleAt === undefined;
      visuals.push({ key: visual.key, wvm: visual.wvm, distance, visual: visual.frame, spell: visual,
        spellFirstEligible: firstEligible, phaseKey });
    }
    // A cast is a composite: cast/missile/impact kits must either all get an emitter slot or none
    // of them do. Trimming this flat list by model used to leave a valid-looking half-kit, and a
    // tiny attachment movement could change which half won the distance sort from one frame to
    // the next. Group by ownership and use a stable id tie-breaker so it cannot alternate.
    const budgeted = selectVisualEffectGroups(
      visuals.map((visual) => ({ ...visual, handleId: visual.spell?.handle.id ?? 0 })),
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

    const live = new Set(wanted.map((entry) => entry.key));
    for (const key of [...this.#effects.keys()]) {
      if (!live.has(key)) this.#dropEffects(key);
    }

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
    if (held.effects !== EMPTY_EFFECTS) disposeModelEffects(held.effects);
  }

  #disposeRenderedVisual(visual: RenderedVisual): void {
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
    // The visible 3x3 borrows cardinal height samples and diagonal water corners from one tile
    // beyond itself. Pin the conservative clipped 5x5 dependency ring before any late load lands.
    const activeGrids = [];
    for (let offsetX = -2; offsetX <= 2; offsetX++) {
      for (let offsetY = -2; offsetY <= 2; offsetY++) {
        const x = center.x + offsetX;
        const y = center.y + offsetY;
        if (x >= 0 && x < 64 && y >= 0 && y < 64) activeGrids.push({ x, y });
      }
    }
    terrainClient?.setActiveTiles(map, activeGrids);
    const grids = [];
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const x = center.x + offsetX;
        const y = center.y + offsetY;
        if (x >= 0 && x < 64 && y >= 0 && y < 64) grids.push({ x, y });
      }
    }
    const visible = new Set(grids.map((grid) => `${map}/${grid.x}/${grid.y}`));
    for (const [key, rendered] of this.#terrains) {
      if (visible.has(key)) continue;
      this.#removeTerrain(key, rendered);
    }
    splatClient?.setActiveTiles(map, grids);
    // A tile's normals are sampled a step outside its own edge, while water corners also borrow
    // diagonal cells. Its revision therefore counts all eight neighbours: a tile built while one
    // of them was still downloading has an extrapolated edge or shoreline, and without this it
    // would keep it for as long as the player stands there.
    for (const grid of grids) {
      const key = `${map}/${grid.x}/${grid.y}`;
      const revision = terrainClient?.tileRevision(map, grid) ?? 0;
      const ownRevision = terrainClient?.ownRevision(map, grid) ?? 0;
      const rendered = this.#terrains.get(key);
      if (!rendered) this.#buildTerrain(key, map, grid, revision, ownRevision, player, heightAt, terrainClient);
      else if (rendered.ownRevision !== ownRevision) {
        rendered.revision = revision;
        rendered.ownRevision = ownRevision;
        rendered.liquidGeneration = this.#liquidTextures?.generation ?? 0;
        this.#rebuildTerrainGeometry(rendered, map, grid, player, heightAt, terrainClient);
      } else if (rendered.revision !== revision) {
        // A neighbour landed. Refresh the edge normals and water: water corners deliberately
        // sample adjacent liquid/ground cells, so leaving its old geometry here would preserve a
        // seam for the rest of the session. A known-dry tile cannot gain a wet quad from a
        // neighbour — liquid quads are emitted only for this tile's own cells — so skip its
        // 128×128 water scan. A tile with a surface still rebuilds because a shared corner may have
        // changed. This remains a load-time event (not a frame path).
        rendered.revision = revision;
        this.#refreshTerrainNormals(rendered, grid, player, heightAt);
        if (shouldRefreshWaterForNeighbour(rendered.water)) this.#replaceWater(rendered, map, grid, heightAt, terrainClient);
      } else if (rendered.liquidGeneration !== (this.#liquidTextures?.generation ?? 0)) {
        // The tile has not changed, but a liquid's animation strip has landed since its surfaces
        // were built, and they are still drawing with the stand-in sheet.
        rendered.liquidGeneration = this.#liquidTextures?.generation ?? 0;
        this.#replaceWater(rendered, map, grid, heightAt, terrainClient);
      }
      this.#updateTerrainSplat(map, grid, this.#terrains.get(key)!, splatClient);
    }
  }

  #removeTerrain(key: string, rendered: RenderedTerrain): void {
    this.#scene.remove(rendered.mesh);
    rendered.mesh.geometry.dispose();
    rendered.material.dispose();
    for (const mesh of rendered.water ?? []) {
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
    splat.layers.anisotropy = this.#renderer.capabilities.getMaxAnisotropy();
    applyTerrainSplat(rendered.material, splat);
    setTerrainSplatMicroNormals(rendered.material, this.#experimentalShaderProfile.terrainMicroNormals);
    rendered.splatted = true;
  }

  #rebuildTerrainGeometry(rendered: RenderedTerrain, map: number, grid: { x: number; y: number }, player: WorldPosition, heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined): void {
    rendered.mesh.geometry.dispose();
    rendered.mesh.geometry = this.#terrainGeometry(map, grid, player, heightAt, terrainClient);
    this.#replaceWater(rendered, map, grid, heightAt, terrainClient);
  }

  /** The same normals the geometry was built with, recomputed against a neighbour that has landed. */
  #refreshTerrainNormals(rendered: RenderedTerrain, grid: { x: number; y: number }, player: WorldPosition, heightAt: HeightSampler | undefined): void {
    const attribute = rendered.mesh.geometry.getAttribute("normal");
    if (!attribute) return;
    const heights = terrainHeightField(grid, player, heightAt);
    const normals = terrainNormals(heights);
    if (attribute.array.length !== normals.length) return;
    (attribute.array as Float32Array).set(normals);
    attribute.needsUpdate = true;
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
      mesh.geometry.dispose();
      this.#scene.remove(mesh);
    }
    delete rendered.water;
    const surfaces = this.#waterGeometry(map, grid, heightAt, terrainClient);
    const meshes: THREE.Mesh[] = [];
    for (const [liquidClass, geometry] of surfaces) {
      const mesh = new THREE.Mesh(geometry, this.#liquidMaterial(liquidClass)?.material
        ?? this.#fallbackLiquidMaterial(liquidClass));
      mesh.renderOrder = 1;
      meshes.push(mesh);
      this.#scene.add(mesh);
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
      opacity: 0.58,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    applyFallbackLiquidShaderProfile(material, liquidClass, this.#waterProfile(), this.#waterShaderUniforms);
    this.#fallbackLiquidMaterials.set(liquidClass, material);
    return material;
  }

  #waterProfile(): Readonly<{
    waterFresnel: boolean;
    waterMicroWaves: boolean;
    waterSunSparkle: boolean;
    fantasyGlow: boolean;
  }> {
    return this.#experimentalShaderProfile;
  }

  #waterGeometry(map: number, grid: { x: number; y: number }, heightAt: HeightSampler | undefined, terrainClient: TerrainClient | undefined): Map<LiquidClass, THREE.BufferGeometry> {
    const surfaces = new Map<LiquidClass, { positions: number[]; uvs: number[]; depths: number[]; indices: number[] }>();
    // A water quad used to get one height and one depth for all four vertices.  That made the
    // alpha/deep-colour transition follow the 4.16-yard cell grid, which is especially obvious
    // on shallow shores.  Keep the look-up bounded to this tile: neighbouring cells are cached,
    // so every shared corner is sampled once even though the quads intentionally remain separate
    // (a dry cell must not be pulled into a wet surface).
    const liquidCache = new Map<string, ReturnType<NonNullable<TerrainClient["liquidAt"]>> | undefined>();
    const groundCache = new Map<string, number>();
    const sampleKey = (x: number, y: number) => `${Math.round(x * 1000)}:${Math.round(y * 1000)}`;
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
    const cornerLiquidHeight = (
      liquid: NonNullable<ReturnType<NonNullable<TerrainClient["liquidAt"]>>>,
      liquidClass: LiquidClass,
      x: number,
      y: number,
      row: number,
      column: number,
    ): number => {
      // x0/y0 are the +x/+y sides of the cell.  The two adjacent cell centres are therefore
      // [current,+one cell] on that side and [-one cell,current] on the other side.
      const rowOffsets = row === 0 ? [0, 1] : [-1, 0];
      const columnOffsets = column === 0 ? [0, 1] : [-1, 0];
      const neighbours: NonNullable<ReturnType<NonNullable<TerrainClient["liquidAt"]>>>[] = [];
      for (const rowOffset of rowOffsets) {
        for (const columnOffset of columnOffsets) {
          if (rowOffset === 0 && columnOffset === 0) continue;
          const neighbour = sampleLiquid(x + rowOffset * LIQUID_CELL_YARDS, y + columnOffset * LIQUID_CELL_YARDS);
          if (neighbour) neighbours.push(neighbour);
        }
      }
      return waterCornerHeight(liquid, neighbours, liquidClass, this.#liquidTextures?.classes);
    };
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
          surface = { positions: [], uvs: [], depths: [], indices: [] };
          surfaces.set(liquidClass, surface);
        }
        const base = surface.positions.length / 3;
        const cornerHeights = [
          cornerLiquidHeight(liquid, liquidClass, x, y, 0, 0),
          cornerLiquidHeight(liquid, liquidClass, x, y, 1, 0),
          cornerLiquidHeight(liquid, liquidClass, x, y, 0, 1),
          cornerLiquidHeight(liquid, liquidClass, x, y, 1, 1),
        ];
        surface.positions.push(
          x0, cornerHeights[0]! + 0.04, -y0,
          x1, cornerHeights[1]! + 0.04, -y0,
          x0, cornerHeights[2]! + 0.04, -y1,
          x1, cornerHeights[3]! + 0.04, -y1,
        );
        // World coordinates decide the UVs, so the surface tiles continuously across cells and
        // across the tile boundary rather than restarting at each quad.
        for (const [cornerX, cornerY] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
          surface.uvs.push(cornerY! / LIQUID_CELL_YARDS, cornerX! / LIQUID_CELL_YARDS);
        }
        // Clamped: a surface below the ground sample is not negative depth, it is a shore, and the
        // fade reads the number as a distance.  Ground is sampled at each corner too; using the
        // centre for all four vertices was the other source of the square shoreline pattern.
        const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        const cornerGrounds = corners.map(([cornerX, cornerY]) => sampleGround(cornerX!, cornerY!));
        surface.depths.push(...waterCornerDepths(cornerHeights, cornerGrounds));
        surface.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
    const built = new Map<LiquidClass, THREE.BufferGeometry>();
    for (const [liquidClass, surface] of surfaces) {
      if (surface.indices.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(surface.uvs, 2));
      geometry.setAttribute("liquidDepth", new THREE.Float32BufferAttribute(surface.depths, 1));
      geometry.setIndex(surface.indices);
      geometry.computeVertexNormals();
      built.set(liquidClass, geometry);
    }
    return built;
  }

  /**
   * One tile's ground, with normals taken from the height field rather than from its own faces.
   *
   * `computeVertexNormals` averages the faces a vertex touches, and a vertex on the tile's edge
   * only has faces on one side of it, so every tile boundary carried a lit seam: measured along
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
    const side = TERRAIN_SUBDIVISIONS + 1;
    const step = TERRAIN_GRID_SIZE / TERRAIN_SUBDIVISIONS;
    const inside = 1 - TERRAIN_EDGE_EPSILON;
    const worldX = (row: number) => (32 - grid.x - Math.min(Math.max(row, 0), TERRAIN_SUBDIVISIONS) / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
    const worldY = (column: number) => (32 - grid.y - Math.min(Math.max(column, 0), TERRAIN_SUBDIVISIONS) / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;

    const heights = terrainHeightField(grid, player, heightAt);
    const heightOf = (row: number, column: number) => heights[(row + 1) * (side + 2) + (column + 1)]!;
    const normals = terrainNormals(heights);

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row < side; row++) {
      const x = worldX(row);
      for (let column = 0; column < side; column++) {
        positions.push(x, heightOf(row, column), -worldY(column));
        uvs.push(column / TERRAIN_SUBDIVISIONS, 1 - row / TERRAIN_SUBDIVISIONS);
      }
    }
    for (let row = 0; row < side - 1; row++) {
      for (let column = 0; column < side - 1; column++) {
        const x = (32 - grid.x - (row + 0.5) / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
        const y = (32 - grid.y - (column + 0.5) / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
        if (terrainClient?.isHole(map, x, y)) continue;
        const a = row * side + column;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
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
      const candidates = this.#environmentSpatialIndex?.query(
        player.x, player.y, ENVIRONMENT_RANGE,
      ).objects ?? objects;
      this.#environmentCandidates = environmentCandidatesInRange(candidates, player);
      this.#environmentCandidatesAt = {
        x: player.x,
        y: player.y,
        generation: this.#environmentGeneration,
      };
    }

    // Camera visibility changes without player movement, so only the distance candidates use the
    // four-yard cache. This pass is wire/retained-state only and precedes every model/group/liquid
    // lookup below.
    this.#frustumMatrix.multiplyMatrices(this.#camera.projectionMatrix, this.#camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#frustumMatrix);
    const admitted = selectEnvironmentAdmission(
      this.#environmentCandidates,
      this.#frustum.planes,
      (object) => {
        const rendered = this.#environment.get(object.id);
        return rendered?.source === object
          ? rendered.visibilitySphere
          : this.#environmentVisibilitySpheres.get(object);
      },
    );
    const inRange = new Map<number, EnvironmentObject>();
    for (const { object } of this.#environmentCandidates) inRange.set(object.id, object);
    const drawn = new Set<number>();
    for (const { object } of admitted) drawn.add(object.id);
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
    this.#pruneWarmEnvironment();

    this.#realModels = 0;
    for (const { object, distance } of admitted) {
      // The same distance the ranking used: to the building rather than to the pin, or a city is
      // ranked in but still swapped for its stand-in box from most of its own streets.
      const model = distance < MODEL_RANGE ? client?.model(object.name, "background") : undefined;
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
        if (model?.wvm) rendered.wvm = model.wvm;
        if (building) rendered.wmo = building.placed;
        if (rig) {
          rendered.skinned = rig.instance;
          rendered.template = rig.template;
          rendered.model = object.name;
        }
        const visual = node.userData["visual"];
        if (visual instanceof THREE.Object3D) rendered.visual = visual;
        this.#environment.set(object.id, rendered);
        this.#environmentGroup.add(node);
        // Nothing in the environment ever moves, so its matrices are composed once here instead of
        // once per object per frame. About seven hundred objects stop recomposing a local matrix
        // and a world matrix sixty times a second to arrive at the number they already had.
        //
        // Except the ones with a rig in them. A mixer writes bone matrices every frame and the
        // whole point of writing them is that they are read afterwards; freezing the subtree would
        // pose the skeleton and then draw last frame's pose for ever. The outer node is still
        // frozen — the mill does not move, only its sails do.
        node.matrixAutoUpdate = false;
        node.updateMatrix();
        node.updateMatrixWorld(true);
        // Frozen down to the leaves, buildings included. `Object3D.updateMatrixWorld` recurses
        // into its children whatever the parent's own flags say, so a room hung on a frozen
        // building afterwards still multiplies itself by the building's world matrix and lands
        // where it belongs — measured, because the first version of this exempted buildings on the
        // assumption that it would not. Freezing only the outer node would leave the mesh inside
        // it composing and multiplying its own matrix sixty times a second for no reason.
        if (!rendered.skinned) {
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
        // reading the matrix of this very mesh.
        const built = instanceable(model)
          ? this.#builtModels.get(this.#builtCacheKey(this.#builtModels, object.name))
          : undefined;
        if (visual instanceof THREE.Object3D && built && instanceableBuild(built.materials)) {
          rendered.instanceKey = object.name;
          rendered.instanceMatrix = visual.matrixWorld.clone();
        }
        this.#instancesDirty = true;
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
    this.#poseDoodads(player, client, elapsed);
    this.#updateInstances();
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
    const radius = sphere.radius * Math.max(scaleX, scaleY, scaleZ);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
      || !Number.isFinite(radius) || radius < 0) return undefined;
    return { x, y, z, radius };
  }

  /** Releases one scenery placement while leaving its shared model build in the cache. */
  #disposeEnvironment(rendered: RenderedEnvironment): void {
    disposeSkinnedInstance(rendered.skinned);
    delete rendered.skinned;
    delete rendered.template;
    if (rendered.wmo) this.#clearWmoGroups(rendered.wmo, rendered.node);
    this.#environmentGroup.remove(rendered.node);
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
    for (const rendered of this.#environment.values()) {
      if (!rendered.admitted || !rendered.skinned || !rendered.template) continue;
      const at = rendered.node.position;
      // The node is in the scene's frame, where y is up and world y is negated.
      const distance = Math.hypot(at.x - player.x, -at.z - player.y);
      if (distance > DOODAD_ANIMATION_RANGE) continue;
      // Off screen it is still where it is, and it will be back; it simply does not have to be
      // posed while nobody can see it.
      if (!this.#frustum.intersectsObject(rendered.skinned.mesh)) continue;
      posed.push({ rendered, distance });
    }
    posed.sort((left, right) => left.distance - right.distance);
    this.#doodadsPosed = Math.min(posed.length, DOODAD_ANIMATION_BUDGET);

    for (const { rendered } of posed.slice(0, DOODAD_ANIMATION_BUDGET)) {
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
    const byModel = new Map<string, RenderedEnvironment[]>();
    for (const rendered of this.#environment.values()) {
      if (!rendered.admitted || !rendered.instanceKey || !rendered.instanceMatrix) continue;
      const list = byModel.get(rendered.instanceKey);
      if (list) list.push(rendered);
      else byModel.set(rendered.instanceKey, [rendered]);
    }

    for (const [key, list] of byModel) {
      if (list.length < INSTANCE_MINIMUM) {
        for (const rendered of list) rendered.node.visible = true;
        this.#dropInstance(key);
        continue;
      }
      const built = this.#builtModels.get(this.#builtCacheKey(this.#builtModels, key));
      if (!built) continue;
      let entry = this.#instances.get(key);
      // An `InstancedMesh` fixes its capacity when it is made, so it is grown in powers of two
      // rather than rebuilt every time one more barrel comes into range.
      if (!entry || entry.capacity < list.length) {
        this.#dropInstance(key);
        const capacity = instanceCapacity(list.length);
        const mesh = new THREE.InstancedMesh(built.geometry, built.materials, capacity);
        // One sphere over every copy, spread across the whole selection radius, so per-object
        // culling was never going to help here — and would only have been asked a hundred times.
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        entry = { mesh, capacity, built };
        this.#instances.set(key, entry);
        this.#environmentGroup.add(mesh);
      }
      for (const [index, rendered] of list.entries()) {
        entry.mesh.setMatrixAt(index, rendered.instanceMatrix!);
        rendered.node.visible = false;
      }
      entry.mesh.count = list.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
      // `setMatrixAt` does not invalidate it, and three computes it once and keeps it: left alone,
      // the sphere would be the centroid of whichever copies happened to be in range first.
      entry.mesh.computeBoundingSphere();
    }

    for (const key of [...this.#instances.keys()]) {
      if (!byModel.has(key)) this.#dropInstance(key);
    }
  }

  /**
   * The grass around the player, scattered from the tile's recipe and drawn one model at a time.
   *
   * Two clocks, not one. The scatter itself runs on the same four-yard step the environment
   * ranking uses — measured at 0.234 ms for the densest fifty-yard window on the Goldshire ring,
   * plus 0.095 ms to compose 3,525 matrices, so about 2% of a sixteen-millisecond frame and only
   * on the frames it runs at all. The *upload* runs whenever a model that the field is waiting for
   * finally arrives, because the artifacts are fetched four at a time and a player standing still
   * would otherwise watch the ground stay bare until they walked.
   */
  #updateGroundCover(player: WorldPosition, map: number | undefined, heightAt: HeightSampler | undefined,
    terrainClient: TerrainClient | undefined, client: EnvironmentClient | undefined): void {
    const cover = this.#groundCover;
    const radius = this.#groundCoverRadius;
    if (!cover || map === undefined || radius <= 0) {
      if (this.#groundCoverMeshes.size > 0 || this.#groundCoverField) this.#clearGroundCover();
      return;
    }
    const table = cover.table();
    if (!table) return;

    // The generation carries three separate reasons to scatter again: a recipe landed, the effect
    // table landed, or the player changed a setting. The distance carries the fourth. A sum works
    // because neither half ever goes down, so no change in either can leave the total where it was.
    const generation = cover.generation + this.#groundCoverSettings;
    const sample = heightAt ?? ((x: number, y: number) => terrainClient?.heightAt(map, x, y));
    if (this.#groundCoverAt?.map !== map || shouldReselect(this.#groundCoverAt, player, generation)) {
      this.#groundCoverAt = { x: player.x, y: player.y, map, generation };
      this.#groundCoverField = scatterGroundCover({
        recipe: groundCoverRecipeSource(cover, map),
        table,
        centre: player,
        // Generated wider than it is drawn, so that at its stalest — a whole step of walking after
        // the last rebuild — the field still reaches the radius on the side being walked towards.
        radius: radius + GROUND_COVER_MARGIN,
        drawRadius: radius,
        perCell: this.#groundCoverDense,
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
    const built = this.#wvmBuild(this.#builtModels, path, path, model.wvm, undefined, undefined, false);
    let entry = this.#groundCoverMeshes.get(path);
    if (!entry || entry.capacity < batch.x.length) {
      this.#dropGroundCoverMesh(path);
      const capacity = instanceCapacity(batch.x.length);
      const mesh = new THREE.InstancedMesh(built.geometry, built.materials, capacity);
      // One sphere over a field that surrounds the camera is no use to anybody, and the field is
      // rebuilt on a step rather than per frame, so there is nothing for culling to save.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      entry = { mesh, capacity, built };
      this.#groundCoverMeshes.set(path, entry);
      this.#groundCoverGroup.add(mesh);
    }
    for (let index = 0; index < batch.x.length; index++) {
      entry.mesh.setMatrixAt(index, groundCoverMatrix(batch, index, this.#coverMatrix));
    }
    entry.mesh.count = batch.x.length;
    entry.mesh.instanceMatrix.needsUpdate = true;
    // `setMatrixAt` does not invalidate it, and three keeps the first one it computed.
    entry.mesh.computeBoundingSphere();
  }

  #dropGroundCoverMesh(path: string): void {
    const entry = this.#groundCoverMeshes.get(path);
    if (!entry) return;
    this.#groundCoverGroup.remove(entry.mesh);
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
    this.#groundCoverSelected = 0;
    this.#groundCoverSelectionDroppedCells = 0;
  }

  /** Takes one model's instanced draw away and shows the placements it was standing in for. */
  #dropInstance(key: string): void {
    const entry = this.#instances.get(key);
    if (!entry) return;
    this.#environmentGroup.remove(entry.mesh);
    // The geometry and the materials belong to the model cache and are shared with every other
    // copy of it; only the per-instance matrix buffer is this mesh's own.
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
            this.#renderer.capabilities.getMaxAnisotropy(),
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
    slotTextures?: ReadonlyMap<number, THREE.Texture>): BuiltModel {
    const cacheKey = this.#builtCacheKey(cache, key);
    let built = cache.get(cacheKey);
    if (built) return built;
    built = buildModel(wvm, {
      modelPath,
      baseUrl: this.#baseUrl,
      loadTexture: (url) => this.#loadTexture(url),
      ...(slots ? { slots } : {}),
      ...(geosets ? { geosets } : {}),
      ...(slotTextures ? { slotTextures } : {}),
      skinned,
      anisotropy: this.#renderer.capabilities.getMaxAnisotropy(),
      worldLight: this.#worldLight,
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
    const instance = instantiateSkinned(template, built.materials);
    // The tile's frame and not the unit path's, the same half turn `#wvmNode` applies: an animated
    // signpost and the static one beside it have to agree about which way they face.
    instance.root.quaternion.copy(ADT_MODEL_TO_SCENE);
    const node = placeEnvironmentNode(new THREE.Group(), object);
    node.add(instance.root);
    node.userData["builtModel"] = built;
    return { node, instance, template };
  }

  #wvmNode(name: string, wvm: WvmModel): THREE.Object3D {
    const built = this.#wvmBuild(this.#builtModels, name, name, wvm, undefined, undefined, false);
    const mesh = new THREE.Mesh(built.geometry, built.materials);
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
    return node;
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
    for (const { mesh } of placed.built.values()) node.remove(mesh);
    placed.built.clear();
  }

  /** Builds and attaches only the rooms in the final distance/portal demand. */
  #updateWmoGroups(
    placed: PlacedWmo,
    player: WorldPosition,
    node: THREE.Object3D,
    client: EnvironmentClient | undefined,
    staticEnvironment = false,
  ): void {
    const distanceGroups = wmoGroupsInRange(placed.model, placed.boxes, player);
    let selected: readonly number[] = distanceGroups;
    const fogPlacement = staticEnvironment && placed.visualId === this.#wmoFogVisualId;
    if (fogPlacement || (staticEnvironment && this.#indoors)) {
      this.#wmoCameraModel.copy(this.#camera.position).applyMatrix4(placed.worldToModel);
      if (fogPlacement) this.#considerWmoFog(placed, this.#wmoCameraModel);
      if (staticEnvironment && this.#indoors && this.#wmoOcclusion && placed.model.portals) {
        this.#wmoModelToClip
          .multiplyMatrices(this.#camera.matrixWorldInverse, placed.modelToWorld)
          .premultiply(this.#camera.projectionMatrix);
        const portalSelection = selectWmoPortalGroups(
          placed.model.groups,
          placed.model.portals,
          distanceGroups,
          this.#wmoCameraModel,
          this.#wmoModelToClip.elements,
        );
        if (portalSelection.used) {
          selected = portalSelection.groups;
          this.#wmoPortalModels++;
          this.#wmoPortalCandidates += portalSelection.candidates;
          this.#wmoPortalCulled += portalSelection.culled;
        }
      }
    }
    const wanted = new Set(selected);
    const missing: number[] = [];
    for (const [index, group] of placed.model.groups.entries()) {
      const built = placed.built.get(index);
      if (!wanted.has(index)) {
        if (built) {
          node.remove(built.mesh);
          placed.built.delete(index);
        }
        continue;
      }
      if (built) {
        const retained = this.#wmoGeometries.get(this.#wmoGroupCacheKey(placed.model, index));
        if (retained === built.entry) continue;
        // A wrapper may never outlive its exact cache entry or decoded parent.
        node.remove(built.mesh);
        placed.built.delete(index);
      }
      if (!group.mesh) {
        missing.push(index);
        continue;
      }
      const rendered = this.#wmoGroupMesh(placed.model, index);
      if (!rendered) continue;
      placed.built.set(index, rendered);
      node.add(rendered.mesh);
    }
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

  /** Apply the one room chosen above; absence deliberately leaves the restored zone fog intact. */
  #applyWmoFogCandidate(): void {
    const candidate = this.#wmoFogCandidate;
    if (this.#underwater || !candidate) return;
    const { end, scale, colour } = candidate.fog.land;
    const fog = this.#scene.fog as THREE.Fog;
    fog.color.setRGB(colour[0] / 255, colour[1] / 255, colour[2] / 255, THREE.SRGBColorSpace);
    fog.near = end * scale;
    fog.far = end;
  }

  /** One room's mesh: its geometry converted into the scene, its light computed, its runs split. */
  #wmoGroupMesh(model: WmoModel, index: number): RenderedWmoGroup | undefined {
    const group = model.groups[index];
    const source = group?.mesh;
    if (!group || !source) return undefined;
    const cacheKey = this.#wmoGroupCacheKey(model, index);
    let entry = this.#wmoGeometries.get(cacheKey);
    if (!entry) {
      const positions = new Float32Array(source.positions.length);
      for (let at = 0; at < source.positions.length; at += 3) {
        positions[at] = -source.positions[at]!;
        positions[at + 1] = source.positions[at + 2]!;
        positions[at + 2] = source.positions[at + 1]!;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(source.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
      let normals: Float32Array;
      if (source.normals) {
        // MONR is authored in model space. The model→scene permutation is (-x,z,y), so apply the
        // same mapping directly and never recompute normals that the artist supplied.
        const sceneNormals = new Float32Array(source.normals.length);
        for (let at = 0; at < source.normals.length; at += 3) {
          sceneNormals[at] = -source.normals[at]!;
          sceneNormals[at + 1] = source.normals[at + 2]!;
          sceneNormals[at + 2] = source.normals[at + 1]!;
        }
        geometry.setAttribute("normal", new THREE.BufferAttribute(sceneNormals, 3));
        normals = source.normals;
      } else {
        geometry.computeVertexNormals();
        // Back into model space to light it: the lamps are stated there, and the permutation above
        // is its own inverse, so the same three swaps undo it.
        const scene = geometry.getAttribute("normal").array as Float32Array;
        normals = new Float32Array(scene.length);
        for (let at = 0; at < scene.length; at += 3) {
          normals[at] = -scene[at]!;
          normals[at + 1] = scene[at + 2]!;
          normals[at + 2] = scene[at + 1]!;
        }
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(wmoVertexLight(source, normals, model.ambient, model.lights), 3));
      for (const [ordinal, run] of source.runs.entries()) geometry.addGroup(run.start, run.count, ordinal);
      geometry.computeBoundingSphere();
      entry = Object.freeze({
        cacheKey,
        epoch: this.#worldResourceEpoch,
        groupIndex: index,
        geometry,
      });
      this.#wmoGeometries.set(cacheKey, entry);
    }
    const runEntries = source.runs.map((run) => this.#wmoRunMaterial(model, group, run));
    const materialEntries = Object.freeze([...new Set(runEntries)]);
    const materials = runEntries.map((materialEntry) => materialEntry.material);
    return {
      entry,
      materialEntries,
      mesh: new THREE.Mesh(entry.geometry, materials.length === 1 ? materials[0]! : materials),
    };
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
            this.#renderer.capabilities.getMaxAnisotropy(),
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
        if (value instanceof THREE.MeshStandardMaterial) {
          applyWorldLight(value, this.#worldLight, "surface");
        }
        return value;
      },
    });
  }

  #modelNode(object: EnvironmentObject, model: EnvironmentModel): THREE.Object3D {
    // A WVM5 model carries its own materials: blend modes, two-sidedness, wrap flags and the draw
    // order the client uses. Building from those is what turns a doodad from one flat
    // double-sided cut-out into the surfaces the artist authored.
    if (model.wvm) return placeEnvironmentNode(this.#wvmNode(object.name, model.wvm), object);
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
      const distance = Math.hypot(object.position.x - player.x, object.position.y - player.y);
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
      if (!rendered || (!rendered.actual && model && modelName)
        || replacesWmo || replacesLegacy || replacesModel || replacesWvm) {
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
        this.#gameObjects.set(object.guid, rendered);
        this.#gameObjectGroup.add(rendered.node);
      }

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
        } else {
          this.#clearWmoGroups(rendered.wmo, rendered.node);
        }
      }
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
      rendered.node.quaternion.setFromRotationMatrix(mappedVmapRotation(
        0, THREE.MathUtils.radToDeg(position.orientation), 0));
    }
    const path = rendered.entry > 0 ? paths?.path(rendered.entry) : undefined;
    if (!path || path.period <= 0 || path.frames.length === 0) {
      rendered.node.position.set(position.x, position.z, -position.y);
      return;
    }
    if (rendered.phaseAt === undefined) {
      rendered.phaseMs = transportPhaseMs(
        object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset), object.transportTime, path.period);
      rendered.phaseAt = now;
    }
    const offset = sampleTransportPath(path, (rendered.phaseMs ?? 0) + (now - rendered.phaseAt));
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

  /** A trustworthy current WVM silhouette, or undefined when admission must fail open. */
  #unitVisibilityRadius(object: WorldObjectState, unit: RenderedUnit | undefined): number | undefined {
    if (unitWireHasCompositeSilhouette(object)) return undefined;
    if (!unit || unit.body || !unit.wvm || !unit.built
      || unit.decodedModel || unit.legacyGeometry || unit.mount || unit.attached.size > 0
      || unit.admissionHasAuthoredAttachments !== false
      || unit.wvm.particleEmitters.length > 0 || unit.wvm.ribbonEmitters.length > 0) return undefined;
    const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
    const rawObjectScale = fieldFloat(object, UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset);
    if (rawObjectScale !== undefined && (!Number.isFinite(rawObjectScale) || !(rawObjectScale > 0))) return undefined;
    const objectScale = unitObjectScale(object);
    if (unit.admissionDisplayId !== displayId || unit.admissionObjectScale !== objectScale
      || !Number.isFinite(objectScale)) return undefined;
    const builtSphere = unit.built.geometry.boundingSphere;
    if (!builtSphere) return undefined;
    return conservativeUnitVisibilityRadius(unit.wvm.bounds, builtSphere, unit.scale, unit.height);
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
    this.#atlasFrameDemands.clear();
    this.#atlasFrameActive.clear();
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
      const distance = Math.hypot(object.position.x - player.x, object.position.y - player.y);
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
      this.#drawUnit(object, state.selfGuid === object.guid, now, elapsed, client, creatureModel, displayAnswered,
        mountModel,
        unitCastsEnhancedShadow(rank, distance, this.#lightingProfile));
      const rendered = this.#units.get(object.guid);
      if (rendered?.applied) this.#atlasFrameActive.add(rendered.applied);
    }
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
    for (const rendered of this.#environment.values()) visit(rendered.wmo, rendered.node);
    for (const rendered of this.#gameObjects.values()) visit(rendered.wmo, rendered.node);
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
    const borrowers: LegacyResourceBorrower<LegacyGeometryEntry>[] = [
      ...this.#environment.values(),
      ...this.#gameObjects.values(),
      ...this.#units.values(),
    ];
    if (this.#skyboxLegacyGeometry || this.#skyboxMaterialEntries) {
      borrowers.push({
        ...(this.#skyboxLegacyGeometry ? { legacyGeometry: this.#skyboxLegacyGeometry } : {}),
        ...(this.#skyboxMaterialEntries ? { materialEntries: this.#skyboxMaterialEntries } : {}),
      });
    }
    const borrowerCount = collectLegacyResourcePins(borrowers, geometryPins, materialPins);
    return { geometryPins, materialPins, borrowerCount };
  }

  /** Soft-caps exact WMO and legacy resources after final frame admission. */
  #evictWmoResources(): void {
    const wmo = this.#wmoGroupBorrowers();
    const legacy = this.#legacyResourceBorrowers();
    for (const { built } of this.#wmoGeometries.evictUnpinned(wmo.geometryPins)) {
      built.geometry.dispose();
    }
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
    const modelPins = new Set<BuiltModel>();
    if (this.#skyboxBuilt) modelPins.add(this.#skyboxBuilt);
    for (const rendered of this.#environment.values()) {
      if (rendered.built) modelPins.add(rendered.built);
    }
    for (const rendered of this.#gameObjects.values()) {
      if (rendered.built) modelPins.add(rendered.built);
    }
    for (const entry of this.#instances.values()) modelPins.add(entry.built);
    for (const entry of this.#groundCoverMeshes.values()) modelPins.add(entry.built);

    const unitPins = new Set<BuiltModel>();
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
    for (const built of this.#portraits.retainedBuilds()) unitPins.add(built);
    for (const key of this.#portraits.retainedBuildKeys()) {
      liveAtlases.add(key);
      if (!this.#formalBenchmarkIsolation) activeAtlases.add(key);
    }
    if (!this.#formalBenchmarkIsolation) {
      for (const built of this.#portraits.liveBuilds()) unitPins.add(built);
      for (const key of this.#portraits.liveBuildKeys()) {
        liveAtlases.add(key);
        activeAtlases.add(key);
      }
    }
    for (const unit of this.#units.values()) {
      if (unit.built) unitPins.add(unit.built);
      if (unit.applied) {
        liveAtlases.add(unit.applied);
      }
      if (unit.mount) unitPins.add(unit.mount.built);
      for (const node of unit.attached.values()) {
        const built = node.userData["builtModel"];
        if (built) unitPins.add(built as BuiltModel);
      }
    }

    const evictedModels = this.#builtModels.evictUnpinned(modelPins);
    const evictedUnits = this.#builtUnits.evictUnpinned(unitPins);
    const evicted: EvictedBuiltModel<BuiltModel>[] = [...evictedModels, ...evictedUnits];
    for (const entry of evicted) this.#skinnedTemplates.delete(entry.key);
    disposeEvictedBuiltModels(evicted, [
      ...this.#builtModels.values(),
      ...this.#builtUnits.values(),
    ]);

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
    now: number,
    elapsed: number,
    client: EnvironmentClient | undefined,
    creatureModel: ((object: WorldObjectState) => UnitModel | undefined) | undefined,
    displayAnswered: ((displayId: number) => boolean) | undefined,
    mountModel: ((object: WorldObjectState) => UnitModel | undefined) | undefined,
    shadowCaster: boolean,
  ): void {
    const position = object.position!;
    const dead = isWorldObjectDead(object);
    const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
    const tint = dead ? CORPSE_TINT
      : self ? SELF_TINT
        : object.typeId === 4 ? PLAYER_TINT
          : new THREE.Color().setHSL((displayId * 0.113) % 1, 0.42, 0.46).getHex();
    // The server publishes the real silhouette of every creature; use it instead of one size.
    const radius = clampSize(fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset), UNIT_DEFAULT_RADIUS, 0.2, 6);
    const reach = clampSize(fieldFloat(object, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset), radius * 4.4, 0.6, 22);
    const capsuleHeight = Math.max(0.8, Math.min(14, reach));

    let unit = this.#units.get(object.guid);
    if (!unit) {
      const material = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.72, metalness: 0.05 });
      applyWorldLight(material, this.#worldLight, "surface");
      const body = new THREE.Mesh(this.#unitBodyGeometry, material);
      const facing = new THREE.Mesh(this.#unitFacingGeometry, material);
      facing.rotation.z = -Math.PI / 2;
      const node = new THREE.Group();
      node.add(body, facing);
      unit = {
        node, built: undefined, shadowCaster: undefined, body, material,
        skinned: undefined, template: undefined, action: undefined,
        animationId: -1, pose: undefined, overlayUntil: 0,
        height: 0, radius: 0, scale: 1, dead: !dead, tint: tint ^ 1, applied: "",
        attached: new Map(),
      };
      this.#units.set(object.guid, unit);
      this.#unitGroup.add(node);
    }

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
      if (key !== unit.applied || replacesLegacy) {
        standIn = this.#attachSkinnedModel(unit, metadata, key, decodedModel);
      }
      if (unit.applied === key) {
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
    if (currentWvm) {
      unit.admissionDisplayId = displayId;
      unit.admissionObjectScale = currentObjectScale;
      unit.admissionHasAuthoredAttachments = (metadata?.appearance?.attached.length ?? 0) > 0;
    } else {
      delete unit.admissionDisplayId;
      delete unit.admissionObjectScale;
      delete unit.admissionHasAuthoredAttachments;
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
    unit.node.visible = content || hiddenRider;
    if (unit.mount) {
      const rider = unit.skinned?.root ?? unit.visual;
      if (rider) rider.visible = !hiddenRider;
    }
    if (unit.skinned && unit.template) {
      this.#animateUnit(unit, object, dead, now, elapsed, client, metadata);
    } else {
      this.#shapeCapsule(unit, tint, radius, capsuleHeight, dead, moving, now);
    }
    this.#applyUnitShadow(unit, shadowCaster);
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
   * Swaps the stand-in capsule for the real model as soon as its skeleton has downloaded.
   *
   * Returns what stopped it, or undefined when the unit is now wearing its model. Every early
   * return here leaves a capsule standing, and three of them leave it standing for good, so the
   * reason is carried out rather than inferred from the outside.
   */
  #attachSkinnedModel(unit: RenderedUnit, metadata: UnitModel, key: string,
    model: EnvironmentModel | undefined): StandInReason | undefined {
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
          ? this.#renderer.capabilities.getMaxAnisotropy() : 1);
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
      const geosets = worldCharacterGeosets(model.wvm, appearance, character);
      const { built, rigged } = this.#buildRigged(key, metadata.model, model.wvm, slots, geosets, supplied);
      if (rigged === undefined) {
        // No rig at all: 9.5% of the client's creature models have none, and a static mesh is
        // far better than the coloured capsule they used to keep forever.
        const mesh = new THREE.Mesh(built.geometry, built.materials);
        mesh.quaternion.copy(M2_TO_SCENE);
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
    supplied?: ReadonlyMap<number, THREE.Texture>):
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
    return { built, rigged };
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
      if (!wvm) return;
      this.#attachMount(unit, metadata, key, wvm);
    }
    this.#seatRider(unit);
  }

  /** Builds the mount and hangs it in the unit's node; the rider is seated separately. */
  #attachMount(unit: RenderedUnit, metadata: UnitModel, key: string, wvm: WvmModel): void {
    this.#dropMount(unit);
    // The same two decisions `#attachSkinnedModel` makes for a creature with no appearance, and
    // made by the same two functions rather than by a copy of their answers. For the 2,952 mount
    // displays of this dataset that means every geoset the file authored: a horse put its mane,
    // its tail and its barding in submeshes, and the bare-character set would take it apart.
    const { built, rigged } = this.#buildRigged(key, metadata.model, wvm,
      characterSlots(metadata.textures, undefined),
      unitGeosets(undefined, wvm.textures.some((slot) => slot.type === TEXTURE_TYPE_BODY)));
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
   * A weapon shows only while it is drawn. Sheathed, the client puts it across the back or on the
   * hip, and which of those depends on the item's sheath type, which this does not have — so
   * rather than guess and hang a sword in the wrong place, a sheathed weapon is not drawn at all.
   * A helmet and a pauldron are always worn and are not affected.
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
    const wanted = new Map<string, { point: number; model: string; texture: string; build: string }>();
    for (const item of attached ?? []) {
      const point = attachmentPoint(item, sheath);
      if (point === undefined) continue;
      wanted.set(`${item.slot}/${item.side}`, {
        point, model: item.model, texture: item.texture, build: `${item.model}#${item.texture}`,
      });
    }

    for (const [where, node] of unit.attached) {
      // Compared on the build, not the model. Two items commonly share one M2 and differ only in
      // ModelTexture — a Dragonmaw Shortsword and an Assassins' Short Blade are both
      // Sword_1H_Horde_A_01 — and comparing paths left the first one's skin on the second.
      if (wanted.get(where)?.build === node.userData["build"]) continue;
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

      const key = item.build;
      const built = this.#wvmBuild(this.#builtUnits, key, item.model, itemModel,
        new Map(item.texture ? [[TEXTURE_TYPE_OBJECT_SKIN, item.texture]] : []), EVERY_GEOSET, false);
      const mesh = new THREE.Mesh(built.geometry, built.materials);
      // Carried around by an animated bone, so its rest-pose bounds say nothing about where it is.
      mesh.frustumCulled = false;
      mesh.userData["build"] = key;
      mesh.userData["builtModel"] = built;
      mesh.position.copy(attachmentOffset(wvm, template.pivots, item.point));
      bone.add(mesh);
      unit.attached.set(where, mesh);
      unit.shadowCaster = undefined;
    }
  }

  #detachAll(unit: RenderedUnit): void {
    for (const node of unit.attached.values()) node.removeFromParent();
    unit.attached.clear();
    unit.shadowCaster = undefined;
  }

  /**
   * Empties a unit's node, whatever is in it: the stand-in capsule, a static mesh or a rigged
   * instance. Rebinding runs this every time the look changes, so a discarded instance has to let
   * go of its bones and its mixer or a busy street leaks one of each per costume change.
   */
  #clearUnitNode(unit: RenderedUnit): void {
    // First, because the rider's root is a child of one of the mount's bones while it is up there
    // and `unit.node.remove` below would not reach it — the instance would be emptied out of the
    // scene with its mixer and its skeleton still live, hanging off a horse nobody can see.
    this.#dropMount(unit);
    this.#detachAll(unit);
    this.#clearOverlay(unit);
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
   * A pose the packets asked for, played over whatever the unit is otherwise doing.
   *
   * `hold` is how long it lasts: zero for a swing or an emote, which run once and end, and the
   * cast time for a stance that has to be held until something else says otherwise.
   */
  #setUnitAnimation(animation: VisualAnimation, source: "external" | "visual", cancelable: boolean,
    visualHandle?: SpellVisualHandle): void {
    const now = performance.now();
    const at = Number.isFinite(animation.at) ? animation.at : now;
    const mode = animation.mode ?? (animation.hold > 0 ? "hold" : "once");
    const loop = mode === "hold";
    const hold = loop && animation.hold > 0 ? at + animation.hold : 0;
    const ownsHeldSequence = animation.followUp?.mode === "hold";
    // A late frame must not resurrect an impact whose authored hold has already elapsed.
    if (loop && hold > 0 && hold <= now) return;
    this.#actions.set(animation.guid, {
      wanted: [animation.animation],
      hold,
      loop,
      action: undefined,
      ...(animation.followUp ? {
        sequence: {
          animation: animation.followUp.animation,
          mode: animation.followUp.mode,
          hold: animation.followUp.mode === "hold" && animation.followUp.hold > 0
            ? at + animation.followUp.hold : 0,
        },
      } : {}),
      sequenceAt: 0,
      waitUntil: now + ACTION_CLIP_WAIT,
      cancelable: cancelable || ownsHeldSequence,
      source,
      ...(visualHandle === undefined ? {} : { visualHandle }),
    });
  }

  playUnitAction(guid: bigint, action: UnitAction, hold = 0): void {
    const now = performance.now();
    this.#actions.set(guid, {
      wanted: [], hold: hold > 0 ? now + hold : 0, loop: hold > 0, action,
      // Shoot is delivered before a player's appearance/item rows can be complete. Keep only the
      // latest action for this guid (the map assignment is the stale-shot guard), and give that
      // action a bounded metadata window longer than the ordinary animation-sidecar wait.
      sequenceAt: 0, waitUntil: now + (action === "shoot" ? SHOOT_METADATA_WAIT : ACTION_CLIP_WAIT),
      cancelable: hold > 0,
      source: "external",
    });
  }

  /** An emote, which the server names by animation rather than by kind. */
  playUnitEmote(guid: bigint, animation: number, hold = 0): void {
    const now = performance.now();
    this.#actions.set(guid, {
      wanted: [animation], hold: hold > 0 ? now + hold : 0, loop: hold > 0,
      action: undefined, sequenceAt: 0, waitUntil: now + ACTION_CLIP_WAIT,
      cancelable: hold > 0,
      source: "external",
    });
  }

  /** Stop only an active held precast/channel; ordinary one-shots and locomotion are untouched. */
  cancelUnitAction(guid: bigint): void {
    const pending = this.#actions.get(guid);
    if (!pending?.cancelable) return;
    this.#stopActionIfPlaying(guid, pending);
    this.#actions.delete(guid);
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
  #animateUnit(unit: RenderedUnit, object: WorldObjectState, dead: boolean, now: number, elapsed: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): void {
    const template = unit.template!;
    const skinned = unit.skinned!;
    const pose: UnitPose = {
      dead,
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
      // The built mount rather than the field, so a rider whose horse has not downloaded keeps
      // running instead of gliding along in the seated pose with nothing underneath.
      mounted: unit.mount !== undefined,
    };
    // The mount is the thing that walks, swims and flies, so it takes the same pose the rider
    // would have taken on foot — with `mounted` off, or the horse would try to sit on itself.
    // Chosen here and stepped below with the rider's, for the same off-screen reason.
    this.#poseMount(unit, object.guid, { ...pose, mounted: false }, now, client);

    // A one-shot is removed from #actions as soon as its clip starts. If movement begins on the
    // following frame there is therefore no pending action left for #poseUnit to reclassify, and a
    // full-body cast would keep owning the legs until its fade deadline. Promote that still-running
    // one-shot once, at its current phase, before the ordinary pose pass gets to it.
    const moving = isUnitMoving(pose.movementFlags, pose.spline);
    if (unit.action && unit.action.isRunning()
      && shouldPromoteActionToLocomotionOverlay(
        moving, unit.overlayPreservesLocomotion === true, unit.actionKind, unit.action.loop,
      )) {
      this.#promoteActionToLocomotionOverlay(unit, now);
    }

    // A one-shot owns the unit until it is over: a landing that is crossfaded away after two
    // frames is a landing nobody sees. Three things can be playing, in this order of authority:
    // what the packets asked for, the transition between two poses, and the pose itself.
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
    // Chosen and scheduled above whatever happens next: a clip that is queued while the unit is
    // off screen has to be the one playing when it comes back on. What is skipped is only the
    // stepping — a mixer update writes every bone of the skeleton and uploads them, and for a unit
    // outside the frustum nothing reads the result. The clip does not advance while it is skipped,
    // which is what "not drawn" means and is invisible by construction.
    this.#unitSphere.center.copy(unit.node.position);
    this.#unitSphere.radius = Math.max(1, unit.height);
    // A static portrait needs one current world pose before its independent snapshot is painted;
    // after that, an offscreen target has no reason to advance its live mixer just for the HUD.
    const portraitNeedsPose = this.#portraits.needsPose(object.guid);
    if (!portraitNeedsPose && !this.#frustum.intersectsSphere(this.#unitSphere)) return;
    skinned.mixer.update(elapsed);
    // Before the rider's billboards, because the rider hangs off one of these bones: a card turned
    // against a saddle that has not moved yet is a card turned against last frame.
    const mount = unit.mount;
    if (mount?.skinned && mount.template) {
      mount.skinned.mixer.update(elapsed);
      applyBillboardBones(mount.skinned, mount.template, this.#camera);
    }
    // After the pose and not before it: a billboard bone overwrites what the mixer just wrote to
    // it, which is the whole point of the flag.
    applyBillboardBones(skinned, template, this.#camera);
  }

  /**
   * The gait of the horse, chosen from the same flags the rider was chosen from.
   *
   * `SMSG_MOUNTSPECIAL_ANIM` is the one protocol edge that addresses the mount indirectly: its
   * payload is the rider guid, while the one-shot is authored on the mount node. It is handled
   * before the gait and then the normal gait resumes when the clip's authored duration ends.
   */
  #poseMount(unit: RenderedUnit, guid: bigint, pose: UnitPose, now: number,
    client: EnvironmentClient | undefined): void {
    const mount = unit.mount;
    if (!mount?.skinned || !mount.template) return;

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
            return;
          }
        }
      }
    }

    // The mount's `action` is normally the persistent gait. A special is a full-body one-shot,
    // and must keep owning the mount until its authored window ends or the gait would restart it
    // on every frame and make the trick invisible.
    if (mount.action?.loop === THREE.LoopOnce && mount.action.isRunning()
      && now < mount.overlayUntil) return;

    const chosen = chooseAnimation(mount.template.clips, pose);
    if (chosen) this.#playAnimation(mount, chosen.animation, chosen.loop, now);
    this.#requestAnimations(mount.template, poseAnimation(pose).wanted, client, mount.metadata);
  }

  /** Move an already-started full-body one-shot to the filtered upper layer at its current phase. */
  #promoteActionToLocomotionOverlay(unit: RenderedUnit, now: number): void {
    const previous = unit.action;
    const animation = unit.animationId;
    const kind = unit.actionKind;
    const template = unit.template;
    const skinned = unit.skinned;
    if (!previous || animation < 0 || kind === undefined || !template || !skinned) return;
    const phase = Number.isFinite(previous.time) ? Math.max(0, previous.time) : 0;
    const clip = template.overlayClips?.get(animation);

    // Some unusual rigs have no upper-body tracks for an action. Stopping the full-body action is
    // still preferable to freezing locomotion; the base pose selected immediately afterwards owns
    // every bone again.
    previous.stop();
    unit.action = undefined;
    unit.animationId = -1;
    delete unit.actionKind;
    unit.overlayUntil = 0;
    if (!clip || clip.tracks.length === 0) return;

    const next = skinned.mixer.clipAction(clip);
    next.reset();
    next.setEffectiveTimeScale(1);
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    next.setEffectiveWeight(1);
    next.time = Math.min(clip.duration, phase);
    next.play();
    unit.overlayAction = next;
    unit.overlayAnimationId = animation;
    unit.overlayActionKind = kind;
    unit.overlayPreservesLocomotion = true;
    delete unit.overlayFadeUntil;
    unit.overlayUntil = now + Math.max(0,
      (clip.duration - next.time) * 1000 - ACTION_ANIMATION_BLEND * 1000);
  }

  #poseUnit(unit: RenderedUnit, guid: bigint, pose: UnitPose, now: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): void {
    // A locomotion-preserving action has its own filtered clip, so the base gait must keep being
    // selected even while that overlay is running. Once its authored window reaches the blend
    // start, fade the overlay into that already-playing base action instead of stopping it on the
    // boundary (which would snap the upper body to the gait's first frame).
    if (unit.overlayPreservesLocomotion === true) {
      if (now < unit.overlayUntil) {
        if (this.#playAction(unit, guid, pose, now, client, metadata)) return;
        this.#poseBase(unit, pose, now, client, metadata);
        return;
      }
      this.#poseBase(unit, pose, now, client, metadata);
      if (unit.overlayFadeUntil === undefined) {
        this.#beginOverlayFade(unit, now);
      } else if (now < unit.overlayFadeUntil) {
        return;
      }
      this.#clearOverlay(unit);
      this.#poseBase(unit, pose, now, client, metadata);
      return;
    }
    if (this.#playAction(unit, guid, pose, now, client, metadata)) return;

    const transition = poseTransition(unit.pose, pose);
    const overlay = transition === undefined ? undefined : resolveAnimation(unit.template!.clips, [transition]);
    if (overlay !== undefined) {
      this.#playAnimation(unit, overlay, false, now);
      return;
    }

    const chosen = chooseAnimation(unit.template!.clips, pose);
    if (chosen) this.#playAnimation(unit, chosen.animation, chosen.loop, now);
    // What the pose asked for that this model has but has not downloaded yet. Asking is cheap and
    // the client only lets one request per model through.
    this.#requestAnimations(unit.template!, poseAnimation(pose).wanted, client, metadata);
  }

  /** Selects and updates only the persistent locomotion/stance layer. */
  #poseBase(unit: RenderedUnit, pose: UnitPose, now: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): void {
    const chosen = chooseAnimation(unit.template!.clips, pose);
    if (chosen) this.#playAnimation(unit, chosen.animation, chosen.loop, now, false, false);
    this.#requestAnimations(unit.template!, poseAnimation(pose).wanted, client, metadata);
  }

  /** Stop a pending action only when the animation currently playing is the one it requested. */
  #stopActionIfPlaying(guid: bigint, pending: {
    wanted: number[];
    action: UnitAction | undefined;
  }): void {
    const unit = this.#units.get(guid);
    if (!unit?.template) return;
    // `weaponPose(undefined, "ranged")` deliberately has no answer: inventory type 26 is shared
    // by guns and wands. A cancel must nevertheless stop the clip that is actually playing, so
    // use the semantic owner recorded at play time instead of resolving an unarmed replacement.
    if (pending.action === "shoot") {
      if (unit.overlayActionKind === "shoot" && unit.overlayAction) {
        this.#clearOverlay(unit);
        return;
      }
      if (unit.actionKind === "shoot" && unit.action) {
        unit.action.stop();
        unit.action = undefined;
        unit.animationId = -1;
        delete unit.actionKind;
        unit.overlayUntil = 0;
        return;
      }
    }
    const wanted = pending.action === undefined
      ? pending.wanted
      : actionAnimation(pending.action, weaponPose(undefined, pending.action === "shoot" ? "ranged" : "melee"));
    const animation = pending.action === undefined
      ? resolveSpellVisualAnimation(unit.template.clips, wanted)
      : resolveActionAnimation(
        unit.template.clips,
        pending.action,
        weaponPose(undefined, pending.action === "shoot" ? "ranged" : "melee"),
      );
    if (animation === undefined) return;
    if (unit.overlayAction && unit.overlayAnimationId === animation) {
      this.#clearOverlay(unit);
      return;
    }
    if (unit.action && unit.animationId === animation) {
      unit.action.stop();
      unit.action = undefined;
      unit.animationId = -1;
      unit.overlayUntil = 0;
    }
  }

  /**
   * Plays whatever the packets asked this unit to do, if anything is pending.
   *
   * Going somewhere cancels it: a character that dances and then runs is running, and a cast that
   * is interrupted by a step should not hold the caster in a stance for the rest of its duration.
   */
  #playAction(unit: RenderedUnit, guid: bigint, pose: UnitPose, now: number,
    client: EnvironmentClient | undefined, metadata: UnitModel | undefined): boolean {
    const pending = this.#actions.get(guid);
    if (!pending) return false;
    let holding = pending.loop;
    const heldFollowUp = pending.sequence?.mode === "hold";
    const moving = isUnitMoving(pose.movementFlags, pose.spline);
    // A stance ends when its time is up, when the unit moves, or when it dies — and ending it
    // means handing the unit back to its pose, not playing the stance one last time.
    if (isTerminalUnitPose(pose) || (holding && (moving || pending.hold <= now)) || (heldFollowUp && moving)) {
      this.#actions.delete(guid);
      return false;
    }
    // Do this before resolving clips: a sidecar/appearance answer that arrives after the deadline
    // must not revive the one-shot that was already stale.
    if (pendingActionExpired(pending.action, holding, now, pending.waitUntil)) {
      this.#actions.delete(guid);
      return false;
    }
    if (pending.sequence && pending.sequenceAt > 0 && now >= pending.sequenceAt) {
      const next = pending.sequence;
      delete pending.sequence;
      pending.sequenceAt = 0;
      pending.wanted = [next.animation];
      pending.loop = next.mode === "hold";
      pending.hold = next.hold;
      holding = pending.loop;
    }
    const shootMetadataPending = pending.action === "shoot"
      && (metadata === undefined || metadata.appearance === undefined || metadata.appearancePending === true);
    // Do not use the inventory-type fallback while the live item row is unresolved: INVTYPE 26 is
    // shared by guns and wands, so choosing gun here would consume the one-shot before subclass 19
    // can arrive. Once the metadata settles, weaponPose selects the exact ranged release.
    const actionWeapon = pending.action === undefined || shootMetadataPending
      ? "unarmed"
      : weaponPose(metadata?.appearance?.attached, pending.action === "shoot" ? "ranged" : "melee");
    const wanted = pending.action === undefined
      ? pending.wanted
      : actionAnimation(pending.action, actionWeapon);
    const animation = pending.action === undefined
      ? resolveSpellVisualAnimation(unit.template!.clips, wanted)
      : resolveActionAnimation(unit.template!.clips, pending.action, actionWeapon);
    if (animation === undefined) {
      // The request is one fetch per model and it does not come back on this frame, so deleting
      // the record here threw the emote away before its own keyframes could possibly have landed.
      this.#requestAnimations(unit.template!, wanted, client, metadata);
      const fate = pendingActionFate({
        hasClip: false,
        promised: (pending.action === undefined
          ? resolveSpellVisualAnimation(unit.template!.animations, wanted)
          : resolveActionAnimation(unit.template!.animations, pending.action, actionWeapon)) !== undefined,
        metadataPending: shootMetadataPending,
        now,
        waitUntil: pending.waitUntil,
      });
      if (fate === "wait") return false;
      this.#actions.delete(guid);
      return false;
    }
    // Instant actions may arrive while a unit is translating. Keep the gait on the base layer and
    // filter the action's lower-body tracks so a spell/attack cannot freeze or snap the legs.
    const preserveLocomotion = moving && !holding
      && (pending.source === "visual" || pending.action !== undefined || pending.wanted.length > 0);
    if (preserveLocomotion) this.#poseBase(unit, pose, now, client, metadata);
    this.#playAnimation(
      unit, animation, holding, now, pending.source === "visual", preserveLocomotion, pending.action,
    );
    if (pending.sequence) {
      // Keep the owner alive until the lead-in's actual clip duration, then install the primary
      // pose. Do not let the ordinary pose scheduler replace the lead-in while it is playing.
      const clip = unit.template!.clips.get(animation);
      if (pending.sequenceAt === 0) {
        pending.sequenceAt = now + Math.max(0, (clip?.duration ?? 0) * 1000);
      }
      // The old full-body path used zero to keep the ordinary pose scheduler out of a lead-in.
      // A preserving overlay intentionally runs the base scheduler. Its last blend window is
      // handled by #beginOverlayFade, while the sequence owner still advances at authored time.
      if (preserveLocomotion) {
        const fade = animationFadeWindow(clip?.duration ?? 0, pending.source === "visual");
        unit.overlayUntil = now + Math.max(0,
          fade.start * 1000);
      } else {
        unit.overlayUntil = 0;
      }
      return true;
    }
    // A held stance stays pending so it is re-asserted after anything interrupts it; a one-shot is
    // over the moment it has been started.
    if (!holding) this.#actions.delete(guid);
    return true;
  }

  #playAnimation(
    unit: PosedModel,
    animation: number,
    loop: boolean,
    now: number,
    fullDuration = false,
    preserveLocomotion = false,
    actionKind?: UnitAction,
  ): void {
    const template = unit.template!;
    const clip = preserveLocomotion
      ? (template.overlayClips?.get(animation) ?? template.clips.get(animation))
      : template.clips.get(animation);
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
        const transition = animationTransition(previous.isRunning(), true);
        if (transition === "stop") previous.stop();
        else if (transition === "crossfade") {
          const blend = animationBlend(previous.loop === THREE.LoopRepeat, loop);
          next.crossFadeFrom(previous, blend.duration, blend.warp);
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

    if (animation === unit.animationId && unit.action) {
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
      const blendDuration = loop ? ANIMATION_BLEND : ACTION_ANIMATION_BLEND;
      unit.overlayUntil = loop ? 0 : now + Math.max(0,
        clip.duration * 1000 - (fullDuration ? 0 : blendDuration * 1000));
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
      const transition = animationTransition(previous.isRunning(), true);
      if (transition === "stop") previous.stop();
      else if (transition === "crossfade") {
        const blend = animationBlend(previous.loop === THREE.LoopRepeat, loop);
        next.crossFadeFrom(previous, blend.duration, blend.warp);
      }
    }
    unit.action = next;
    unit.animationId = animation;
    if (actionKind === undefined) delete unit.actionKind;
    else unit.actionKind = actionKind;
    // A one-shot holds the unit for its own length, less the blend that takes it away again.
    const blendDuration = loop ? ANIMATION_BLEND : ACTION_ANIMATION_BLEND;
    unit.overlayUntil = loop ? 0 : now + Math.max(0,
      clip.duration * 1000 - (fullDuration ? 0 : blendDuration * 1000));
  }

  /** Begins the short upper-body fade into the already-playing locomotion action. */
  #beginOverlayFade(unit: PosedModel, now: number): void {
    const overlay = unit.overlayAction;
    if (!overlay) {
      unit.overlayFadeUntil = now;
      return;
    }
    const duration = ACTION_ANIMATION_BLEND;
    // The gait is an independent layer and is already at weight 1. `crossFadeTo` would call
    // base.fadeIn(), temporarily reducing that weight to zero and making the filtered overlay's
    // legs appear to freeze. Fade only the upper layer; #poseBase keeps the locomotion action live.
    overlay.fadeOut(duration);
    unit.overlayFadeUntil = now + duration * 1000;
  }

  /** Stops an upper-body overlay and restores exclusive ownership to the base layer. */
  #clearOverlay(unit: PosedModel): void {
    unit.overlayAction?.stop();
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
    metadata: UnitModel | undefined): void {
    if (!client || !metadata) return;
    // Only when the model claims the pose and has not built it: otherwise every stand-in creature
    // would ask for a set it does not have. The rule itself is `needsSidecarAnimations`, out in
    // `AnimatedModel` where a test can drive it without a renderer — the seated pose was never
    // fetched at all and nothing at this level could show it.
    if (!needsSidecarAnimations(template, wanted)) return;
    const clips = client.animations(metadata.model, template.parents.length, "critical");
    if (!clips) return;
    addSkinnedClips(template, clips);
    // Once, even if a clip in there turned out to be unbuildable: otherwise a model with one bad
    // sequence walks the whole block again on every frame it is on screen.
    template.merged = true;
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
