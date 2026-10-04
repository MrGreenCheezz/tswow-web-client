import { cameraPivotHeight, game } from "./Context.js";
import { drainWorldState } from "../ui/WorldView.js";
import { updateDeathReclaimCountdown } from "../ui/Npc.js";
import { updateSpellCooldowns } from "../ui/Spellbook.js";
import { updateAuraDurations } from "../ui/Auras.js";
import { diagnosticsWindow, fullFrameStatus, renderStatus, worldPanel } from "../ui/Dom.js";
import { showStandIns } from "../ui/Diagnostics.js";
import { showPoseWorkerStatus } from "../ui/PoseWorkerStatus.js"; // L10 (10.18)
import { OPCODES } from "../../generated/opcodes.js";
import { formatGameTime, halfMinuteOfDay } from "../../world/GameTimeProtocol.js";
import { lightOverrideWeight } from "../LightClient.js";
import { mountModel, unitModel } from "../ui/Frames.js";
import {
  MOVEMENT_HEARTBEAT_INTERVAL, advancePhysics, isMoving, movementHeartbeat, sendMovement,
} from "../input/Movement.js";
import {
  EYE_LIQUID_SAMPLE_BAND, FLOOR_SEARCH_DEPTH, STEP_HEIGHT, eyeLiquidSurface, eyeUnderwater,
  type EyeLiquidSurface,
} from "./Physics.js";
import { collisionLiquidEyeSubmerged, collisionModelLiquidAtEye } from "./CollisionLiquid.js";
import { ENVIRONMENT_STREAM_RANGE, terrainGrid, terrainGridDependencyFootprint } from "../Terrain.js";
import { updateZoneSound } from "./ZoneSound.js";
import { updateWeatherSound } from "./WeatherAmbience.js";
import { updateCombatSounds } from "./CombatSounds.js";
import {
  CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PIVOT_HEIGHT, createCamera,
} from "../SimpleScene.js";
import { advanceCameraFrame, cameraAllowsUpwardOrbit } from "./CameraRig.js";
import { characterMotion } from "../input/Movement.js"; // L8 5.14
import { cameraWaterSurface } from "./CameraWater.js"; // L8 5.14
import { settingOn } from "../ui/Settings.js"; // L8 5.14
import { advanceCameraAutoFollow } from "../input/Controls.js";
import { updateGroundTargetPreview } from "./GroundTargetPreview.js";
import { updateAreaTriggers } from "./AreaTriggers.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import { moverGuid, moverObject, moverState } from "../input/Mover.js";
import { ViewSubjectTracker, viewIsOut, viewSubject } from "./ViewSubject.js"; // 11.02-I
import { FarSightLink } from "../../world/FarSight.js"; // 11.02-I
import { vehicleCamera } from "./VehicleCamera.js"; // 11.02-GF3
import { cameraViews } from "./CameraViews.js"; // DEC-B 3.11
import { vehicleCatalog } from "../VehicleClient.js"; // 11.02-GF3
import { attachedGlowTint, itemEnchantments } from "../ItemEnchantments.js";
import { updateCastBars } from "../ui/CastBar.js";
import { updateActionBar } from "../ui/ActionBar.js";
import { updateMirrorTimers } from "../ui/MirrorTimers.js";
import { currentAreaId, updateMinimap } from "../ui/Minimap.js";
import { updateWorldMap } from "../ui/WorldMap.js";
import { updateHeadOverlay } from "../ui/HeadOverlay.js";
import { plateSource, selectionRingColour } from "../ui/NamePlates.js";
import { updateCombatLog } from "../ui/CombatLog.js";
import { updateLootRolls } from "../ui/LootRolls.js";
import { updateReadyCheck } from "../ui/ReadyCheck.js";
import { updateScoreboard } from "../ui/Scoreboard.js";
import { updateDuel } from "../ui/Social.js";
import { updateInteractionPrompts } from "../ui/InteractionPrompts.js";
import { notice, updateNotices } from "../ui/Notices.js";
import { updatePetBar } from "../ui/PetBar.js";
import { updateTotems } from "../ui/Totems.js";
import { updateFpsCounter } from "../ui/FpsCounter.js";
import { autoQualityDue, autoQualityStatus, updateAutoQuality } from "../AutoQuality.js";
import { updateLoadingScreen, worldPhysicsReady } from "../ui/LoadingScreen.js";
import { updateCustomPackets, updateModuleWindowList } from "../ui/Diagnostics.js";
import { applyPortraitVisibility, clearPortraitTargets, syncPortraitTargets } from "../ui/Portraits.js";
import {
  FullFrameClock, LONG_FRAME_THRESHOLD_MS, makeRenderTelemetrySnapshot, summarizeFrameHitch,
  topSectionAverages, type FrameHitch, type RenderTelemetrySnapshot,
} from "../RenderStats.js";
import type { BenchmarkClientReadinessInput } from "../RenderBenchmarkReadiness.js";
import { ResourceAccountingLedger } from "../ResourceAccounting.js";
import { renderBenchmarkRuntime } from "../RenderBenchmarkRuntime.js";
import { formalRenderBenchmarkExclusiveActive } from "../RenderBenchmarkExclusiveLease.js";
import {
  beginPerformanceCaptureFrame, captureFrameSections, endPerformanceCaptureFrame, performanceCaptureActive,
} from "./PerformanceCapture.js";

/**
 * Per-frame metadata resolvers, hoisted out of the frame body.
 *
 * Each one only reads the live `game` singleton, so a shared function answers exactly what the
 * inline arrow it replaces answered — without allocating a closure sixty times a second. The
 * renderer/2D-scene calls below take them by identity every frame.
 */
function loopGameObjectDisplay(displayId: number): ReturnType<NonNullable<typeof game.gameObjectMetadata>["get"]> | undefined {
  return game.gameObjectMetadata?.get(displayId);
}

function loopCreatureDisplayAnswered(displayId: number): boolean {
  return game.creatureModels?.get(displayId) !== undefined;
}

function loopCreatureMetadata(entry: number): ReturnType<NonNullable<typeof game.creatureMetadata>["get"]> | undefined {
  return game.creatureMetadata?.get(entry);
}

function loopUnitHeight(guid: bigint): number | undefined {
  return game.renderer?.unitHeight(guid);
}

let lastFrame = performance.now();
let renderStatusShownAt = 0;
let fullFrameStatusShownAt = 0;
/** Full callback work, kept apart from the renderer's update/submit timer. */
const fullFrameClock = new FullFrameClock();

/**
 * The slowest recent frames, broken down by loop section, newest last.
 *
 * Every entry is a frame above {@link LONG_FRAME_THRESHOLD_MS}. Recording is a few numbers on
 * a slow frame only — fast frames allocate nothing — and the ring holds thirty, so walking
 * through a dense district keeps the evidence instead of overwriting it. `webclientHitches()`
 * prints the same ring in the console; the diagnostics status line shows the freshest entry.
 */
const HITCH_RING_SIZE = 30;
/** Console warnings are rarer than records: only a real sag, throttled while walking. */
const HITCH_WARN_THRESHOLD_MS = 120;
const HITCH_WARN_INTERVAL_MS = 10_000;
const hitchRing: FrameHitch[] = [];
let lastHitch: FrameHitch | undefined;
let lastHitchWarnedAt = 0;

/** The worst recent slow frames, newest last; empty until the first frame over 50 ms. */
export function recentFrameHitches(): readonly FrameHitch[] {
  return hitchRing;
}

/** The single slowest recorded frame, if any. */
export function lastFrameHitch(): FrameHitch | undefined {
  return lastHitch;
}

function recordFrameHitch(
  at: number,
  total: number,
  sections: Readonly<Record<string, number>>,
  detail?: string,
): void {
  if (!(total > LONG_FRAME_THRESHOLD_MS)) return;
  const hitch: FrameHitch = Object.freeze({
    at,
    total,
    sections: Object.freeze({ ...sections }),
    ...(detail === undefined ? {} : { detail }),
  });
  hitchRing.push(hitch);
  if (hitchRing.length > HITCH_RING_SIZE) hitchRing.splice(0, hitchRing.length - HITCH_RING_SIZE);
  lastHitch = hitch;
  if (total >= HITCH_WARN_THRESHOLD_MS && at - lastHitchWarnedAt >= HITCH_WARN_INTERVAL_MS) {
    lastHitchWarnedAt = at;
    console.warn(`[webclient] ${summarizeFrameHitch(hitch, 3)} — детали: webclientHitches()`);
  }
}

/**
 * Rolling section sums for the ordinary-frame baseline, reset on every status tick.
 *
 * The hitch ring above answers "what ate the 300 ms frame"; this answers "where do the
 * usual 13 ms go". One object, mutated in place — accumulating is a dozen numeric adds,
 * so it runs on every frame without allocating. Leaf sections only: the `render` parent
 * stays in hitch records, while the averages show its phases (`render.env`, …) plus the
 * portrait readback that otherwise hides inside the parent.
 */
const sectionSums: Record<string, number> = {};
let sectionSamples = 0;

function addSectionAverage(name: string, milliseconds: number): void {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
  sectionSums[name] = (sectionSums[name] ?? 0) + milliseconds;
}

/** Hottest average sections since the last status tick, and restarts the window. */
function takeSectionAverages(): string {
  const text = topSectionAverages(sectionSums, sectionSamples);
  for (const name of Object.keys(sectionSums)) sectionSums[name] = 0;
  sectionSamples = 0;
  return text;
}

/** One draw phase into the baseline sums; untyped reads are ignored rather than recorded. */
function addPhaseAverage(phases: Readonly<Record<string, number>>, name: string): void {
  const value = phases[name];
  if (typeof value === "number") addSectionAverage(`render.${name}`, value);
}

/** Captures the live renderer-triggered request owners without treating lifetime caches as queues. */
export function captureBenchmarkClientReadiness(): Readonly<BenchmarkClientReadinessInput> | undefined {
  const light = game.light;
  const liquids = game.liquids;
  const groundCover = game.groundCover;
  const horizon = game.horizon;
  const transportPaths = game.transportPaths;
  const creatureModels = game.creatureModels;
  const creatureMetadata = game.creatureMetadata;
  const gameObjectMetadata = game.gameObjectMetadata;
  const itemMetadata = game.itemMetadata;
  const collision = game.collision;
  if (!light || !liquids || !groundCover || !horizon || !transportPaths || !creatureModels
    || !creatureMetadata || !gameObjectMetadata || !itemMetadata || !collision) return undefined;
  return Object.freeze({
    light: light.stats,
    liquids: liquids.stats,
    groundCover: groundCover.stats,
    horizon: horizon.stats,
    transportPaths: transportPaths.stats,
    creatureModels: creatureModels.stats,
    creatureMetadata: creatureMetadata.stats,
    gameObjectMetadata: gameObjectMetadata.stats,
    itemMetadata: itemMetadata.stats,
    collision: collision.stats,
  });
}

/** Captures one immutable full-frame/renderer telemetry record for benchmark and diagnostics code. */
export function captureRenderTelemetry(capturedAt = performance.now()): Readonly<RenderTelemetrySnapshot> {
  const accounting = new ResourceAccountingLedger();
  game.terrain?.visitRetainedResources(accounting);
  game.terrainSplat?.visitRetainedResources(accounting);
  game.environment?.visitRetainedResources(accounting);
  game.liquids?.visitRetainedResources(accounting);
  game.groundCover?.visitRetainedResources(accounting);
  game.horizon?.visitRetainedResources(accounting);
  game.renderer?.visitRetainedResources(accounting);
  return makeRenderTelemetrySnapshot(capturedAt, fullFrameClock.snapshot(), game.renderer?.telemetry, {
    terrain: game.terrain?.stats,
    environment: game.environment?.stats,
    terrainSplat: game.terrainSplat?.stats,
    assetWarmup: game.assetWarmup?.stats,
    accounting: accounting.snapshot(),
  }, captureBenchmarkClientReadiness());
}
/** Consecutive frames that have thrown, reset by the first one that does not. */
let frameFailures = 0;
/** The last message reported, so a frame that throws every time says so once. */
let lastFrameError = "";
/** Long enough that the ordinary status line, written every 500 ms, does not overwrite the error. */
const FRAME_ERROR_HOLD = 2_000;
/**
 * The frame's camera, handed the two things only `game` knows: what is solid and how high the
 * ground is.
 *
 * The step itself lives in `CameraRig` — where the floor is asked about, what the boom is scanned
 * along and how both are eased — because that is where a test can drive it sixty times a second
 * without a frame. It used to live here, and the half that no test could reach is the half that
 * held a bug: the floor was sampled under a camera built at the full arm and then applied to the
 * arm a wall had granted, which on a street with a building behind it turned a -23.75-degree view
 * into a -85.00-degree one.
 */
function advanceCameraView(player: WorldPosition, map: number | undefined, elapsed: number,
  subject?: WorldObjectState): void {
  const terrain = game.terrain;
  const world = game.world;
  // 11.02-I: the camera's subject (ViewSubject.ts) — the character unless something else is watched.
  const self = subject ?? (world?.state.selfGuid === undefined
    ? undefined
    : world.state.objects.get(world.state.selfGuid));
  // Its toggles: the mover's (the character's own `movementState` when it moves itself, Mover.ts);
  // an object watched from afar has only its movement flags.
  const toggles = world === undefined || self === undefined || self.guid !== moverGuid(world)
    ? (self !== undefined && self.guid === world?.state.selfGuid ? world.movementState : undefined)
    : moverState(world);
  advanceCameraFrame(game.camera, player, cameraPivotHeight(), {
    collision: game.collision?.world,
    heightAt: terrain && map !== undefined ? (x, y) => terrain.heightAt(map, x, y) : undefined,
    // A flying mover is not standing on its own feet. Let the camera use the full upward orbit;
    // actual roofs/floors are still enforced by CollisionWorld in cameraFloorHeight.
    allowUpwardOrbit: cameraAllowsUpwardOrbit(self?.movementFlags ?? 0, toggles),
    waterZ: cameraWaterSurfaceOf(world, self, player), // L8 5.14
  }, elapsed);
}

/**
 * L8 5.14: the surface the boom stops at under the stock `cameraWaterCollision` (CameraWater.ts, on by default as
 * in Wow.exe): the water the mover's own feet last answered (the physics' query, WMO water included), while the
 * camera is on the mover and that answer is for this column; none otherwise.
 */
function cameraWaterSurfaceOf(world: typeof game.world, subject: WorldObjectState | undefined,
  player: WorldPosition): number | undefined {
  if (world === undefined || subject === undefined || subject.guid !== moverGuid(world)) return undefined;
  const liquid = characterMotion().liquid;
  if (liquid?.surface === undefined || !settingOn("cameraWaterCollision")) return undefined;
  return cameraWaterSurface(liquid, player.x, player.y);
}

/** 11.02-I: the camera's subject between frames, so a change of it clears the boom's eased limits. */
const viewTracker = new ViewSubjectTracker();
/** 11.02-I: `CMSG_FAR_SIGHT` as Wow.exe votes it (world/FarSight.ts). */
const farSightLink = new FarSightLink();

/** Last footprint handed to the terrain client; the ring only changes on tile borders. */
let lastTerrainFootprintKey = "";

function updateTerrainActiveTiles(world: typeof game.world): void {
  // 11.02-I: the ring the renderer re-pins, around the view subject (ViewSubject.ts) — the character,
  // or a possessed unit or far sight eye once in view; the two callers must name the same ring.
  const player = viewSubject(world);
  if (world?.mapId === undefined || !player?.position) {
    if (lastTerrainFootprintKey === "none") return;
    lastTerrainFootprintKey = "none";
    game.terrain?.setActiveTiles(undefined, []);
    return;
  }
  // The 5x5 ring is a pure function of the center tile: skip the 25-object build plus the
  // client's own Set/string/evict pass while standing still. The renderer's own #updateTerrain
  // re-pins the same ring on drawn frames; this call covers loading and hidden-panel frames.
  const center = terrainGrid(player.position.x, player.position.y);
  const key = center === undefined ? `${world.mapId}/none` : `${world.mapId}/${center.x}/${center.y}`;
  if (key === lastTerrainFootprintKey) return;
  lastTerrainFootprintKey = key;
  const grids = terrainGridDependencyFootprint(player.position.x, player.position.y);
  if (grids.length === 0) {
    game.terrain?.setActiveTiles(undefined, []);
    return;
  }
  game.terrain?.setActiveTiles(world.mapId, grids);
}

function frame(now: number): void {
  game.renderer?.setWorldSubmissionCapture(performanceCaptureActive());
  // Section marks are plain numbers: fast frames allocate nothing for the hitch ring, and only
  // a frame over 50 ms builds the record object at the end.
  const hitchStart = performance.now();
  const frameInterval = game.renderer?.observeFrame(now);
  if (frameInterval !== undefined) renderBenchmarkRuntime.recordFrameInterval(frameInterval);
  // Until this RAF actually reaches draw(), its public admission/submission counters describe an
  // empty frame. This also covers loading, a hidden world panel, or an exception in earlier UI work.
  game.renderer?.markFrameNotRendered();
  // 5.13: the physics takes the real frame (`advancePhysics` substeps and bounds it); the camera
  // and the animations keep the 0.1 s clamp.
  const elapsedRaw = (now - lastFrame) / 1000;
  const elapsed = Math.min(elapsedRaw, 0.1);
  lastFrame = now;
  const world = game.world;
  updateFpsCounter(now, !!world && !worldPanel.hidden && !document.hidden);
  // Everything the packets changed since the last frame is delivered here, once, before anything
  // reads it: a panel is woken by the fields it asked for rather than by every packet that lands.
  game.store?.flush();
  world?.state.updateMotions(now);
  game.spellVisualCoordinator?.tick(now);
  drainWorldState();
  updateDeathReclaimCountdown(now);
  updateTerrainActiveTiles(game.world);
  // 11.02-I: after the packets are in, whether or not the world is drawn this frame. A loading
  // screen (a login, a transfer) or no world starts the camera's subject over as well.
  farSightLink.update(world, game.worldLoading);
  if (!world || game.worldLoading) viewTracker.reset();
  const hitchState = performance.now();
  if (!world) {
    clearPortraitTargets();
    game.renderer?.clearPortraits();
    applyPortraitVisibility();
  }
  updateSpellCooldowns(now);
  updateAuraDurations(now);
  updateCastBars(now);
  updateActionBar(now);
  updateMirrorTimers(now);
  // Outside the `worldPanel.hidden` block below on purpose: the frame is part of the permanent
  // interface, and the scene returns early in states where the minimap still has something to say.
  updateMinimap(now);
  // The world map redraws only when the art it is waiting for lands, not every frame.
  updateWorldMap();
  // Nor does the «Пакеты» pane: it returns on the first comparison unless the window is open, the
  // pane is the one showing, and a counter moved since it was drawn. The «Окна» pane beside it is
  // guarded the same way and on the same idea, except that the numbers it prints move every frame:
  // it is redrawn when the *set* of windows or their open/closed state changed, and not before.
  updateCustomPackets();
  updateModuleWindowList();
  const hitchUi = performance.now();
  // Resolve the transfer barrier before physics.  A terrain tile can finish between frames, and
  // this is the first point at which both terrain and VMAP collision are known to be usable.
  updateLoadingScreen(now);
  // 5.23: the marks over heads are asked for as quest givers appear and as the quest log changes,
  // a few per frame (WorldClient.noticeObject/questLogChanged); the queue keeps a 60 s sweep
  // in place of the old five-second one.
  game.world?.pumpQuestGiverStatus?.(now);
  const hitchLoading = performance.now();
  // Sections of the world pass a frame never reached stay NaN and are skipped from the record:
  // a loading-screen hitch still reports its state/ui/loading/panels sections.
  let hitchPhysics = Number.NaN;
  let hitchCamera = Number.NaN;
  let hitchQuery = Number.NaN;
  let hitchLight = Number.NaN;
  let hitchRender = Number.NaN;
  let hitchScene = Number.NaN;
  let hitchOverlay = Number.NaN;
  /** Portrait readback hiding inside the render section; NaN while no world pass runs. */
  let hitchPortraitsMs = Number.NaN;
  const player = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!player?.position) {
    game.renderer?.clearTerrain();
    game.terrainSplat?.setActiveTiles(undefined, []);
  }
  if (world && player?.position && !worldPanel.hidden) {
    // What is solid around the player, before it is asked what it is standing on. Nearly every
    // frame this returns having done nothing at all. 11.02-I: around the unit the physics steps —
    // a possessed creature far from the character walks on the collision around itself (Mover.ts).
    const solidAround = moverObject(world)?.position ?? player.position;
    game.collision?.refresh(world.mapId, solidAround.x, solidAround.y);
    // Turning, walking, gravity, the jump arc, the water, and the walls. What used to be here was
    // six lines that stuck the character to the ground whenever it happened to be within six yards.
    if (worldPhysicsReady()) advancePhysics(elapsedRaw);
    // 2.01: CMSG_AREATRIGGER for a volume the step just entered, its heartbeat first (AreaTriggers.ts).
    updateAreaTriggers(now);
    hitchPhysics = performance.now();
    // Read after the step, not before: sending a packet replaces the state's position object, and
    // everything below draws the world around wherever the character now is.
    // 11.02-I: around the camera's subject (ViewSubject.ts) — the character, or the object
    // PLAYER_FARSIGHT names once it is in view (a possessed unit, a far sight eye). The boom, the
    // light, the streamed scenery and the ears below are built around it.
    const subject = viewSubject(world) ?? player;
    const position = subject.position ?? player.position ?? { x: 0, y: 0, z: 0, orientation: 0 };
    // Where the arm hangs on this particular character, read off the model that is standing there
    // and read once. Every camera below is built from this one pair of numbers rather than each
    // asking for itself, because the world, the plates and the bubbles are drawn through three
    // separate cameras that have to be the same camera.
    //
    // A gnome's shoulder is at 0.823 yards and a tauren's at 2.667; the constants underneath are
    // only in force until the player's own model has been built, and the change when it arrives is
    // instant rather than eased — the camera is recomputed every frame anyway, and the step is at
    // most a few tenths of a yard.
    // 11.02-I: the subject's model (a far sight DynamicObject has none: the constants).
    game.camera.pivotHeight = game.renderer?.unitPivotHeight(subject.guid) ?? CAMERA_DEFAULT_PIVOT_HEIGHT;
    game.camera.eyeHeight = game.renderer?.unitEyeHeight(subject.guid) ?? CAMERA_DEFAULT_EYE_HEIGHT;
    // 11.02-I: a new subject starts with nothing in the boom's way.
    viewTracker.settle(game.camera, subject.guid, world, game.worldLoading);
    // 11.02-GF3: the vehicle seat's camera (VehicleCamera.ts): the vehicle distance, a seat's zoom.
    vehicleCamera.update(world.state, vehicleCatalog(), game.camera, now);
    // DEC-B 3.11: a camera view's glide (CameraViews.ts); a new world is a new camera there.
    cameraViews.frame(game.camera, now, world, game.session?.username);
    // 5.14: the camera's own way back behind the character (cameraSmoothStyle), before the boom.
    // 11.02-I: not behind a facing that is not the player's to change (Wow.exe 0x005fa6b0).
    // DEC-B 3.11: nor while a view glides there (`&& !cameraViews.gliding`).
    if (!viewIsOut(world) && !cameraViews.gliding) advanceCameraAutoFollow(elapsed);
    // One ray a frame, and after the collision world has been stocked and the character has moved,
    // so it is asked about where the camera is going rather than about where it has been.
    advanceCameraView(position, world.mapId, elapsed, subject);

    // Only while the character is going somewhere: the server drops a mover that goes quiet, but
    // a character standing still has nothing to report. A fall counts as going somewhere.
    if (worldPhysicsReady() && isMoving() && now - movementHeartbeat.sentAt >= MOVEMENT_HEARTBEAT_INTERVAL) {
      sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    }
    hitchCamera = performance.now();
    const heightAt = (x: number, y: number) => game.terrain?.heightAt(world.mapId, x, y);
    // The pool covers the far tier, not just the near ring: placements between 400 and 750
    // yards (far shells, far vegetation) must exist in this array or no admission pass below
    // can ever see them. Include the resident/prefetch band beyond the draw leash as well;
    // tile residency follows the same footprint, bounded by the tile LRU.
    const environment = game.environment?.objectsAround(world.mapId, position.x, position.y, ENVIRONMENT_STREAM_RANGE) ?? [];
    // This observes the same already-requested placement list the renderer receives below. It
    // starts no terrain/environment tile fan-out of its own and never delays the frame or curtain.
    game.assetWarmup?.tick({ player, environment, actionButtons: world.actionButtons });
    hitchQuery = performance.now();
    // The sky, the sun and the fog belong to where the camera stands and to what time it is
    // there, so they are resolved per frame from the map's own light volumes.
    const gameTime = world.currentGameTime(now);
    // What the server says is falling here. Handed over every frame rather than on the event: the
    // renderer may not have existed when the packet landed.
    game.renderer?.setWeather(world.weather);
    // Whether the rain reaches the character, asked of the floor under their feet rather than of
    // the artwork around them: the same triangle the physics step just stood on, and the same
    // question `Map::IsOutdoors` answers on the server. Standing on terrain there is no collision
    // floor and no answer, which reads as open air.
    game.renderer?.setIndoors(
      game.collision?.world.indoorsAt(
        position.x, position.y, position.z + STEP_HEIGHT, position.z - FLOOR_SEARCH_DEPTH,
      ) ?? false,
    );
    const lightCamera = createCamera(
      position, game.camera.yaw, game.camera.viewPitch, game.camera.view,
      { pivotHeight: cameraPivotHeight() },
    );
    const cameraWmoFloor = game.collision?.staticWmoFloorUnder(
      world.mapId,
      lightCamera.position.x,
      lightCamera.position.y,
      lightCamera.position.z,
      lightCamera.position.z - FLOOR_SEARCH_DEPTH,
    );
    let underwaterSurface: EyeLiquidSurface | undefined;
    if (gameTime && world.mapId !== undefined) {
      const half = halfMinuteOfDay(gameTime);
      // The storm weight is the renderer's, because the fade between two skies is a rendering
      // clock rather than a fact the server states — `Light.dbc` has a clear set and a storm set
      // and nothing in between, so the crossfade has to be made somewhere.
      const storm = game.renderer?.weatherStorm ?? 0;
      const lightOverride = world.overrideLight;
      const overrideWeight = lightOverride
        ? lightOverrideWeight(now, world.overrideLightReceivedAt, lightOverride.milliseconds)
        : 1;
      const terrainLiquid = game.terrain?.liquidAt(world.mapId, lightCamera.position.x, lightCamera.position.y);
      const terrainUnderwater = eyeUnderwater(lightCamera.position.z, terrainLiquid);
      const collisionModel = cameraWmoFloor
        ? game.collision?.models.model(cameraWmoFloor.placement.modelName)
        : undefined;
      // One query for both questions. The band widens what is *reported* so the screen effect can
      // start while the near plane is still cutting the surface; the light slot below reads the
      // strict model-space comparison off the same hit, so its answer is the one it always was.
      const wmoLiquid = cameraWmoFloor && collisionModel
        ? collisionModelLiquidAtEye(
          collisionModel.groups,
          cameraWmoFloor.groupIndex,
          cameraWmoFloor.placement,
          lightCamera.position,
          EYE_LIQUID_SAMPLE_BAND,
        )
        : undefined;
      const wmoUnderwater = collisionLiquidEyeSubmerged(wmoLiquid);
      const underwater = terrainUnderwater || wmoUnderwater;
      // The same pair of answers the light slot just used, kept rather than thrown away: which
      // surface the screen is looking through, how high it is and which liquid it belongs to.
      // `LIQU` carries the `LiquidType.dbc` row and no flag byte; the map file carries both.
      underwaterSurface = eyeLiquidSurface(
        lightCamera.position.z,
        EYE_LIQUID_SAMPLE_BAND,
        wmoLiquid ? { height: wmoLiquid.worldHeight, entry: wmoLiquid.type, flags: 0 } : undefined,
        terrainLiquid
          ? { height: terrainLiquid.height, entry: terrainLiquid.entry, flags: terrainLiquid.type }
          : undefined,
      );
      const lightSample = game.light?.sample(
        world.mapId, position.x, position.y, half, storm, position.z,
        lightOverride?.overrideLightId, overrideWeight, lightOverride?.areaLightId,
        world.overrideLightFromId, underwater,
      );
      game.renderer?.updateLighting(lightSample, half, underwater);
    }
    // Pushed on every frame, including the ones with no game time and no light sample: a surface
    // left over from the last frame would tint a screen the camera has already climbed out of.
    game.renderer?.setUnderwaterSurface(underwaterSurface);
    // Who wears a ring on the ground. The focus keeps a dimmer one, and never a second ring under
    // the same feet when the two happen to be the same unit.
    const targetGuid = world.targetGuid;
    const focusGuid = game.focusGuid === targetGuid ? undefined : game.focusGuid;
    game.renderer?.setSelection(
      targetGuid === undefined
        ? undefined
        : { guid: targetGuid, colour: selectionRingColour(world.state.objects.get(targetGuid)) },
      focusGuid === undefined
        ? undefined
        : { guid: focusGuid, colour: selectionRingColour(world.state.objects.get(focusGuid)) },
    );
    // The reticle is resolved after the camera has been advanced for this frame, so the drawn ray
    // and the resolved point are the same geometry.
    updateGroundTargetPreview();
    // The duel flag's 50-yard ring, resolved from the world each frame like the selection rings.
    // No flag guid, or a flag object that has not streamed in, means no ring rather than a ring
    // at a guessed point; the prompt and the bounds chat lines remain the fallback.
    const duelFlag = world.duelFlag === undefined ? undefined : world.state.objects.get(world.duelFlag);
    const duelPosition = duelFlag?.position;
    game.renderer?.setDuelRing(duelPosition === undefined ? undefined : {
      x: duelPosition.x, y: duelPosition.y, z: duelPosition.z,
      inBounds: world.duelInBounds !== false,
    });
    syncPortraitTargets(game.renderer);
    // Enchant glows ride a pushed resolver like the selection: the renderer knows meshes,
    // the loop knows the gateway. Loading is kicked once and stays deduped in the client; until
    // it lands the blades draw unlit, exactly like helmets whose model has not arrived.
    const enchantClient = game.gatewayOrigin ? itemEnchantments(game.gatewayOrigin) : undefined;
    if (enchantClient && !enchantClient.ready) void enchantClient.load().catch(() => {});
    game.renderer?.setEnchantGlow(enchantClient?.ready
      ? (object: WorldObjectState, slot: number) =>
        attachedGlowTint(object, slot, (id) => enchantClient.glowModels(id))
      : undefined);
    hitchLight = performance.now();
    const renderer = game.renderer;
    if (renderer) {
      // One renderer frame includes resize/camera/sun setup, sky, world and every dirty portrait
      // render/readback. The nested finally closes the GPU query and restores renderer.info even if
      // either draw path throws; endRenderFrame itself is deliberately non-throwing.
      renderer.beginRenderFrame();
      try {
        renderer.draw(
          world.state,
          world.mapId,
          heightAt,
          game.terrain,
          environment,
          game.environment,
          loopGameObjectDisplay,
          game.camera.yaw,
          // The granted tilt and the granted distance, never the two the player's hands asked for:
          // `viewPitch` is `pitch` with the floor's say in it, exactly as `view` is `distance` with
          // the walls'. Every camera this frame builds has to be built out of the same pair.
          game.camera.viewPitch,
          game.camera.view,
          unitModel,
          game.terrainSplat,
          game.liquids,
          game.transportPaths,
          game.horizon,
          game.camera.distance,
          // Diagnostics only: `unitModel` returns undefined both while the display record is on its way
          // and while a player's appearance is, and the capsule counter has to tell those two apart.
          loopCreatureDisplayAnswered,
          cameraPivotHeight(),
          mountModel,
          cameraWmoFloor,
          undefined,
          game.gameObjectMetadata?.revision,
        );
        const hitchPortraitsAt = performance.now();
        renderer.renderPortraits(now);
        hitchPortraitsMs = performance.now() - hitchPortraitsAt;
      } finally {
        const rendererElapsed = renderer.endRenderFrame();
        if (rendererElapsed !== undefined) renderBenchmarkRuntime.recordRendererFrameCpu(rendererElapsed);
      }
    }
    hitchRender = performance.now();
    applyPortraitVisibility();
    // Writing the status line every frame forces a layout pass for text nobody reads that often.
    if (now - renderStatusShownAt > 500) {
      renderStatusShownAt = now;
      renderStatus.className = game.renderer ? "success" : "error";
      const clock = gameTime ? ` · ${formatGameTime(gameTime)}` : "";
      // The governor's effective scale, so a stepped-down frame explains itself instead of
      // reading as a broken renderer: at 40% the world is meant to look soft.
      const quality = game.renderer ? ` · ${autoQualityStatus().effective}%` : "";
      renderStatus.textContent = game.renderer ? `Render: ${game.renderer.status}${quality}${clock}` : "Render: WebGL недоступен, включён Canvas fallback";
      // The capsule counter is about what is on the screen right now, so it rides the same
      // half-second tick rather than going stale from the moment the window was opened.
      if (!diagnosticsWindow.hidden) showStandIns();
      // L10 (10.18): where crowd poses run (worker or main thread) and why, beside the frame times.
      if (!diagnosticsWindow.hidden) showPoseWorkerStatus(fullFrameStatus);
    }
    game.scene?.draw(
      world.state,
      heightAt,
      world.targetGuid,
      environment,
      loopCreatureMetadata,
      game.camera.yaw,
      game.camera.viewPitch,
      game.camera.view,
      game.renderer ? loopUnitHeight : undefined,
      plateSource(now),
      game.camera.distance,
      cameraPivotHeight(),
    );
    hitchScene = performance.now();
    // After both draw passes on purpose: the bubbles and the damage numbers are anchored with the
    // same camera those two used, and the physics step above has already replaced the position
    // object they hang from.
    updateHeadOverlay(now);
    // The ears go where the camera is and face where it faces, not where the character does: what
    // the player hears has to agree with what the player sees, and in this client those two part
    // company every time the camera is dragged around.
    //
    // The ears moved with the pivot, and much less than the boom did: measured at the default
    // pitch they stand 22.00 yards from the character against 22.20 before, because the default
    // boom was retuned to the distance the old rig really stood at. What changed is the spread
    // over the pitch range — 20.08..22.78 where it used to be 20.41..27.25 — so tilting the view
    // no longer quietens everything panned by distance by a fifth.
    if (game.sound) {
      const heard = createCamera(position, game.camera.yaw, game.camera.viewPitch, game.camera.view,
        { pivotHeight: cameraPivotHeight() });
      game.sound.setListener({
        x: heard.position.x, y: heard.position.y, z: heard.position.z,
        orientation: Math.atan2(heard.forward.y, heard.forward.x),
      });
    }
    updateZoneSound(now, gameTime?.minuteOfDay, currentAreaId());
    // Rain, wind and thunder over the zone's own ambience (experimentalWeatherSounds; OFF is silent).
    updateWeatherSound(now);
    hitchOverlay = performance.now();
  }
  // The draw phases live on the renderer and are overwritten by the next draw: read them here,
  // on the same tick, and copy the numbers into the record rather than retaining the object.
  // A frame whose draw threw keeps the zeroed phases from the frame counters, never stale ones.
  const drawPhases = game.renderer?.drawPhaseMs;
  updateCombatLog(now);
  // Outside the block above on purpose. The player's own death is a level on `UNIT_FIELD_HEALTH`
  // and not a packet, so it is looked at rather than listened for — and a character can die in a
  // frame where the world is not being drawn, which is every frame of a loading screen.
  updateCombatSounds();
  // Both of these count down on their own: the server announces a deadline and then says nothing
  // when it passes.
  updateLootRolls(now);
  updateReadyCheck(now);
  updateScoreboard(now);
  updateDuel(now);
  updateInteractionPrompts(now);
  updateNotices(now);
  updatePetBar(now);
  updateTotems(now);
  // The snapshot copies and sorts the frame ring, so it is only built when the governor is
  // actually due — at most every five seconds, not sixty times a second.
  if (autoQualityDue(now)) updateAutoQuality(now, () => fullFrameClock.snapshot());
  const hitchEnd = performance.now();
  const hitchTotal = hitchEnd - hitchStart;
  // The section breakdown is built only for a slow frame: fast frames keep their plain numbers
  // and allocate nothing for the hitch ring.
  if (hitchTotal > LONG_FRAME_THRESHOLD_MS || (performanceCaptureActive() && hitchTotal > 20)) {
    // Sections the frame never reached stay absent; `panels` covers everything after the last
    // one it did reach, so a loading-screen hitch still reports state/ui/loading/panels.
    const hitchSections: Record<string, number> = {
      state: hitchState - hitchStart,
      ui: hitchUi - hitchState,
      loading: hitchLoading - hitchUi,
    };
    let hitchPrevious = hitchLoading;
    const hitchInner: Array<[string, number]> = [
      ["physics", hitchPhysics],
      ["camera", hitchCamera],
      ["query", hitchQuery],
      ["light", hitchLight],
      ["render", hitchRender],
      ["scene", hitchScene],
      ["overlay", hitchOverlay],
    ];
    for (const [name, at] of hitchInner) {
      if (!Number.isFinite(at)) break;
      hitchSections[name] = at - hitchPrevious;
      hitchPrevious = at;
    }
    hitchSections.panels = hitchEnd - hitchPrevious;
    // Which part of the world pass ate it: a JS-side build burst (terrain/env/units) reads
    // differently from driver-side submission (texture uploads and program compiles).
    if (drawPhases !== undefined && Number.isFinite(hitchRender)) {
      for (const [name, ms] of Object.entries(drawPhases)) {
        if (typeof ms === "number" && Number.isFinite(ms) && ms > 0.05) {
          hitchSections[`render.${name}`] = ms;
        }
      }
    }
    // This is outside draw() but inside the render parent. Without it a portrait rebuild or
    // readback appears as an unexplained gap after an otherwise ordinary world submission.
    if (Number.isFinite(hitchPortraitsMs) && hitchPortraitsMs > 0.05) {
      hitchSections["render.portraits"] = hitchPortraitsMs;
    }
    // What the submit allocated: new programs mean shader compilation, new textures without
    // programs mean uploads, neither means pure CPU submission, culling and sorting.
    const submitStats = game.renderer?.drawSubmitStats;
    const warmup = game.renderer?.programWarmup;
    const warmupDetail = warmup === undefined ? ""
      : ` · прогрев: ${warmup.programs} прогр./${warmup.uniformLocations} униф.`
        + `${warmup.queued > 0 ? `, в очереди ${warmup.queued}` : ""}`
        + `${warmup.parallelCompile ? "" : ", линк синхронный"}`;
    const submitDetail = submitStats === undefined || !Number.isFinite(hitchRender)
      ? undefined
      : `сабмит: шейдеры ${formatSubmitDelta(submitStats.programs)}, `
        + `текстуры ${formatSubmitDelta(submitStats.textures)}, `
        + `геометрия ${formatSubmitDelta(submitStats.geometries)}${warmupDetail}`;
    recordFrameHitch(now, hitchTotal, hitchSections, submitDetail);
    captureFrameSections(hitchStart, hitchTotal, hitchSections, submitDetail);
  }
  // Baseline averages, every frame: numeric adds into the reused sums, no allocation. Unrolled
  // rather than looped over pairs: a pairs array would allocate on every frame.
  sectionSamples++;
  addSectionAverage("state", hitchState - hitchStart);
  addSectionAverage("ui", hitchUi - hitchState);
  addSectionAverage("loading", hitchLoading - hitchUi);
  let averageAt = hitchLoading;
  if (Number.isFinite(hitchPhysics)) {
    addSectionAverage("physics", hitchPhysics - averageAt);
    averageAt = hitchPhysics;
  }
  if (Number.isFinite(hitchCamera)) {
    addSectionAverage("camera", hitchCamera - averageAt);
    averageAt = hitchCamera;
  }
  if (Number.isFinite(hitchQuery)) {
    addSectionAverage("query", hitchQuery - averageAt);
    averageAt = hitchQuery;
  }
  if (Number.isFinite(hitchLight)) {
    addSectionAverage("light", hitchLight - averageAt);
    averageAt = hitchLight;
  }
  if (Number.isFinite(hitchRender)) {
    if (drawPhases !== undefined) {
      addPhaseAverage(drawPhases, "setup");
      addPhaseAverage(drawPhases, "terrain");
      addPhaseAverage(drawPhases, "env");
      addPhaseAverage(drawPhases, "ground");
      addPhaseAverage(drawPhases, "objects");
      addPhaseAverage(drawPhases, "units");
      addPhaseAverage(drawPhases, "visuals");
      addPhaseAverage(drawPhases, "evict");
      addPhaseAverage(drawPhases, "submit");
    }
    addSectionAverage("portraits", hitchPortraitsMs);
    averageAt = hitchRender;
  }
  if (Number.isFinite(hitchScene)) {
    addSectionAverage("scene", hitchScene - averageAt);
    averageAt = hitchScene;
  }
  if (Number.isFinite(hitchOverlay)) {
    addSectionAverage("overlay", hitchOverlay - averageAt);
    averageAt = hitchOverlay;
  }
  addSectionAverage("panels", hitchEnd - averageAt);
}

/** Signed submit-stat delta for the hitch line: `+14`, `0`, never `+-2`. */
function formatSubmitDelta(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta}`;
}

/**
 * One frame, and the guarantee that there will be another one.
 *
 * The re-arming call used to sit at the end of the frame body with nothing around it, so the first
 * exception anywhere in the frame was the last frame: the loop simply stopped being scheduled and
 * the world froze with no message. Every panel, every parser and every renderer path runs inside
 * here, so `animate` is the one place where that has to be untrue.
 *
 * The frame is re-armed in every case. A throwing frame is reported once per distinct message —
 * sixty identical lines a second is not a log, it is a denial of service on the console — and the
 * counter is what tells a single hiccup apart from a frame that will now throw forever.
 */
export function animate(now: number): void {
  let measuring = false;
  try {
    beginPerformanceCaptureFrame();
    // The exclusive gate is checked before clocks, stores, physics, UI, portraits, sound, or any
    // renderer mutation. Rebase live time so release cannot create a clamped catch-up step from the
    // benchmark's wall-clock duration; the shared outer finally keeps RAF alive for this early exit.
    if (formalRenderBenchmarkExclusiveActive()) {
      lastFrame = now;
      return;
    }
    try {
      fullFrameClock.begin();
      measuring = true;
      try {
        const environment = game.environment;
        environment?.beginResourceFrame();
        try {
          frame(now);
        } finally {
          environment?.endResourceFrame();
        }
        frameFailures = 0;
      } catch (error) {
        frameFailures++;
        renderBenchmarkRuntime.recordFrameFailure();
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastFrameError) {
          lastFrameError = message;
          console.error(`Frame ${frameFailures}:`, error);
        }
        // The status line below lives in the diagnostics window, which the markup marks `hidden` and
        // which opens on a key nobody is told about — so a frame that throws every time would freeze
        // the world with the explanation written somewhere nobody is looking. The second failure in a
        // row is the one worth saying out loud: the first can be a hiccup, and repeats of the same
        // text collapse into a count rather than a wall.
        if (frameFailures === 2) notice(`Кадр не рисуется: ${message}`);
        renderStatus.className = "error";
        renderStatus.textContent = `Кадр упал (${frameFailures}): ${message}`;
        // Nothing rewrites the line while frames are failing, so hold it until one succeeds.
        renderStatusShownAt = now + FRAME_ERROR_HOLD;
      }
      if (now - fullFrameStatusShownAt > 500) {
        fullFrameStatusShownAt = now;
        const snapshot = fullFrameClock.snapshot();
        fullFrameStatus.className = frameFailures > 0 ? "error" : "muted";
        let fullFrameText = snapshot.count === 0
          ? "CPU full-frame: ожидание кадра…"
          : `CPU full-frame: ${snapshot.average.toFixed(1)} мс (p50 ${snapshot.p50.toFixed(1)}, p95 ${snapshot.p95.toFixed(1)}, p99 ${snapshot.p99.toFixed(1)})`
            + (snapshot.longFrames > 0 ? ` · >${LONG_FRAME_THRESHOLD_MS} мс: ${snapshot.longFrames}` : "");
        // The freshest hitch, while it is fresh: walking hitches age out of the two-second ring
        // in a hundred frames, but this names the section that ate the frame for five seconds.
        const hitch = lastFrameHitch();
        if (hitch !== undefined && now - hitch.at < 5_000) {
          fullFrameText += ` · ${summarizeFrameHitch(hitch, 3)}`;
        }
        // Where the ordinary frames go, averaged over this half-second: the hitch line above
        // covers the spikes, this covers the baseline the spikes rise out of.
        const averages = takeSectionAverages();
        if (averages) fullFrameText += ` · среднее: ${averages}`;
        fullFrameStatus.textContent = fullFrameText;
      }
    } finally {
      try {
        if (measuring) {
          const cpuMs = fullFrameClock.end();
          renderBenchmarkRuntime.recordFullFrameCpu(cpuMs);
          endPerformanceCaptureFrame(now, cpuMs, frameFailures > 0);
        }
      } finally {
        // Resource flattening and GPU polling are diagnostic overhead, not application frame work,
        // so this checkpoint is deliberately outside the full-frame CPU envelope.
        if (renderBenchmarkRuntime.checkpointDue(now)) {
          renderBenchmarkRuntime.recordResourceCheckpoint(now, captureRenderTelemetry(now));
        }
      }
    }
  } finally {
    requestAnimationFrame(animate);
  }
}

/** Starts the frame loop. Everything the interface shows is refreshed from inside it. */
export function startRenderLoop(): void {
  requestAnimationFrame(animate);
}
