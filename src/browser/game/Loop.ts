import { cameraPivotHeight, game } from "./Context.js";
import { drainWorldState } from "../ui/WorldView.js";
import { updateSpellCooldowns } from "../ui/Spellbook.js";
import { updateAuraDurations } from "../ui/Auras.js";
import { diagnosticsWindow, fullFrameStatus, renderStatus, worldPanel } from "../ui/Dom.js";
import { showStandIns } from "../ui/Diagnostics.js";
import { OPCODES } from "../../generated/opcodes.js";
import { formatGameTime, halfMinuteOfDay } from "../../world/GameTimeProtocol.js";
import { lightOverrideWeight } from "../LightClient.js";
import { mountModel, unitModel } from "../ui/Frames.js";
import {
  MOVEMENT_HEARTBEAT_INTERVAL, advancePhysics, isMoving, movementHeartbeat, sendMovement,
} from "../input/Movement.js";
import { FLOOR_SEARCH_DEPTH, STEP_HEIGHT, eyeUnderwater } from "./Physics.js";
import { eyeUnderCollisionModelLiquid } from "./CollisionLiquid.js";
import { ENVIRONMENT_RANGE, terrainGridDependencyFootprint } from "../Terrain.js";
import { updateZoneSound } from "./ZoneSound.js";
import { updateCombatSounds } from "./CombatSounds.js";
import {
  CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PIVOT_HEIGHT, createCamera,
} from "../SimpleScene.js";
import { advanceCameraFrame, cameraAllowsUpwardOrbit } from "./CameraRig.js";
import type { WorldPosition } from "../../world/WorldState.js";
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
import { notice, updateNotices } from "../ui/Notices.js";
import { updatePetBar } from "../ui/PetBar.js";
import { updateLoadingScreen, worldPhysicsReady } from "../ui/LoadingScreen.js";
import { updateCustomPackets, updateModuleWindowList } from "../ui/Diagnostics.js";
import { applyPortraitVisibility, clearPortraitTargets, syncPortraitTargets } from "../ui/Portraits.js";
import {
  FullFrameClock, LONG_FRAME_THRESHOLD_MS, makeRenderTelemetrySnapshot,
  type RenderTelemetrySnapshot,
} from "../RenderStats.js";
import type { BenchmarkClientReadinessInput } from "../RenderBenchmarkReadiness.js";
import { ResourceAccountingLedger } from "../ResourceAccounting.js";
import { renderBenchmarkRuntime } from "../RenderBenchmarkRuntime.js";
import { formalRenderBenchmarkExclusiveActive } from "../RenderBenchmarkExclusiveLease.js";
let lastFrame = performance.now();
let renderStatusShownAt = 0;
let fullFrameStatusShownAt = 0;
/** Full callback work, kept apart from the renderer's update/submit timer. */
const fullFrameClock = new FullFrameClock();

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
/** The marks over heads go stale as the player walks, so they are asked for again now and then. */
let questStatusAskedAt = 0;
/** Consecutive frames that have thrown, reset by the first one that does not. */
let frameFailures = 0;
/** The last message reported, so a frame that throws every time says so once. */
let lastFrameError = "";
/** Long enough that the ordinary status line, written every 500 ms, does not overwrite the error. */
const FRAME_ERROR_HOLD = 2_000;
const QUEST_STATUS_INTERVAL = 5_000;
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
function advanceCameraView(player: WorldPosition, map: number | undefined, elapsed: number): void {
  const terrain = game.terrain;
  const self = game.world?.state.selfGuid === undefined
    ? undefined
    : game.world.state.objects.get(game.world.state.selfGuid);
  advanceCameraFrame(game.camera, player, cameraPivotHeight(), {
    collision: game.collision?.world,
    heightAt: terrain && map !== undefined ? (x, y) => terrain.heightAt(map, x, y) : undefined,
    // A flying mover is not standing on its own feet. Let the camera use the full upward orbit;
    // actual roofs/floors are still enforced by CollisionWorld in cameraFloorHeight.
    allowUpwardOrbit: cameraAllowsUpwardOrbit(self?.movementFlags ?? 0, game.world?.movementState),
  }, elapsed);
}

function updateTerrainActiveTiles(world: typeof game.world): void {
  const player = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (world?.mapId === undefined || !player?.position) {
    game.terrain?.setActiveTiles(undefined, []);
    return;
  }
  const grids = terrainGridDependencyFootprint(player.position.x, player.position.y);
  if (grids.length === 0) {
    game.terrain?.setActiveTiles(undefined, []);
    return;
  }
  game.terrain?.setActiveTiles(world.mapId, grids);
}

function frame(now: number): void {
  const frameInterval = game.renderer?.observeFrame(now);
  if (frameInterval !== undefined) renderBenchmarkRuntime.recordFrameInterval(frameInterval);
  // Until this RAF actually reaches draw(), its public admission/submission counters describe an
  // empty frame. This also covers loading, a hidden world panel, or an exception in earlier UI work.
  game.renderer?.markFrameNotRendered();
  const elapsed = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  const world = game.world;
  // Everything the packets changed since the last frame is delivered here, once, before anything
  // reads it: a panel is woken by the fields it asked for rather than by every packet that lands.
  game.store?.flush();
  world?.state.updateMotions(now);
  game.spellVisualCoordinator?.tick(now);
  drainWorldState();
  updateTerrainActiveTiles(game.world);
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
  // Resolve the transfer barrier before physics.  A terrain tile can finish between frames, and
  // this is the first point at which both terrain and VMAP collision are known to be usable.
  updateLoadingScreen(now);
  if (game.world && now - questStatusAskedAt > QUEST_STATUS_INTERVAL) {
    questStatusAskedAt = now;
    game.world.requestQuestGiverStatus();
  }
  const player = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!player?.position) {
    game.renderer?.clearTerrain();
    game.terrainSplat?.setActiveTiles(undefined, []);
  }
  if (world && player?.position && !worldPanel.hidden) {
    // What is solid around the player, before it is asked what it is standing on. Nearly every
    // frame this returns having done nothing at all.
    game.collision?.refresh(world.mapId, player.position.x, player.position.y);
    // Turning, walking, gravity, the jump arc, the water, and the walls. What used to be here was
    // six lines that stuck the character to the ground whenever it happened to be within six yards.
    if (worldPhysicsReady()) advancePhysics(elapsed);
    // Read after the step, not before: sending a packet replaces the state's position object, and
    // everything below draws the world around wherever the character now is.
    const position = player.position ?? { x: 0, y: 0, z: 0, orientation: 0 };
    // Where the arm hangs on this particular character, read off the model that is standing there
    // and read once. Every camera below is built from this one pair of numbers rather than each
    // asking for itself, because the world, the plates and the bubbles are drawn through three
    // separate cameras that have to be the same camera.
    //
    // A gnome's shoulder is at 0.823 yards and a tauren's at 2.667; the constants underneath are
    // only in force until the player's own model has been built, and the change when it arrives is
    // instant rather than eased — the camera is recomputed every frame anyway, and the step is at
    // most a few tenths of a yard.
    game.camera.pivotHeight = game.renderer?.unitPivotHeight(player.guid) ?? CAMERA_DEFAULT_PIVOT_HEIGHT;
    game.camera.eyeHeight = game.renderer?.unitEyeHeight(player.guid) ?? CAMERA_DEFAULT_EYE_HEIGHT;
    // One ray a frame, and after the collision world has been stocked and the character has moved,
    // so it is asked about where the camera is going rather than about where it has been.
    advanceCameraView(position, world.mapId, elapsed);

    // Only while the character is going somewhere: the server drops a mover that goes quiet, but
    // a character standing still has nothing to report. A fall counts as going somewhere.
    if (worldPhysicsReady() && isMoving() && now - movementHeartbeat.sentAt >= MOVEMENT_HEARTBEAT_INTERVAL) {
      sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    }
    const heightAt = (x: number, y: number) => game.terrain?.heightAt(world.mapId, x, y);
    const environment = game.environment?.objectsAround(world.mapId, position.x, position.y, ENVIRONMENT_RANGE) ?? [];
    // This observes the same already-requested placement list the renderer receives below. It
    // starts no terrain/environment tile fan-out of its own and never delays the frame or curtain.
    game.assetWarmup?.tick({ player, environment, actionButtons: world.actionButtons });
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
      const terrainUnderwater = eyeUnderwater(
        lightCamera.position.z,
        game.terrain?.liquidAt(world.mapId, lightCamera.position.x, lightCamera.position.y),
      );
      const collisionModel = cameraWmoFloor
        ? game.collision?.models.model(cameraWmoFloor.placement.modelName)
        : undefined;
      const wmoUnderwater = Boolean(cameraWmoFloor && collisionModel
        && eyeUnderCollisionModelLiquid(
          collisionModel.groups,
          cameraWmoFloor.groupIndex,
          cameraWmoFloor.placement,
          lightCamera.position,
        ));
      const underwater = terrainUnderwater || wmoUnderwater;
      const lightSample = game.light?.sample(
        world.mapId, position.x, position.y, half, storm, position.z,
        lightOverride?.overrideLightId, overrideWeight, lightOverride?.areaLightId,
        world.overrideLightFromId, underwater,
      );
      game.renderer?.updateLighting(lightSample, half, underwater);
    }
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
    syncPortraitTargets(game.renderer);
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
          (displayId) => game.gameObjectMetadata?.get(displayId),
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
          (displayId) => game.creatureModels?.get(displayId) !== undefined,
          cameraPivotHeight(),
          mountModel,
          cameraWmoFloor,
          undefined,
          game.gameObjectMetadata?.revision,
        );
        renderer.renderPortraits(now);
      } finally {
        const rendererElapsed = renderer.endRenderFrame();
        if (rendererElapsed !== undefined) renderBenchmarkRuntime.recordRendererFrameCpu(rendererElapsed);
      }
    }
    applyPortraitVisibility();
    // Writing the status line every frame forces a layout pass for text nobody reads that often.
    if (now - renderStatusShownAt > 500) {
      renderStatusShownAt = now;
      renderStatus.className = game.renderer ? "success" : "error";
      const clock = gameTime ? ` · ${formatGameTime(gameTime)}` : "";
      renderStatus.textContent = game.renderer ? `Render: ${game.renderer.status}${clock}` : "Render: WebGL недоступен, включён Canvas fallback";
      // The capsule counter is about what is on the screen right now, so it rides the same
      // half-second tick rather than going stale from the moment the window was opened.
      if (!diagnosticsWindow.hidden) showStandIns();
    }
    game.scene?.draw(
      world.state,
      heightAt,
      world.targetGuid,
      environment,
      (entry) => game.creatureMetadata?.get(entry),
      game.camera.yaw,
      game.camera.viewPitch,
      game.camera.view,
      game.renderer ? (guid) => game.renderer?.unitHeight(guid) : undefined,
      plateSource(now),
      game.camera.distance,
      cameraPivotHeight(),
    );
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
  }
  updateCombatLog(now);
  // Outside the block above on purpose. The player's own death is a level on `UNIT_FIELD_HEALTH`
  // and not a packet, so it is looked at rather than listened for — and a character can die in a
  // frame where the world is not being drawn, which is every frame of a loading screen.
  updateCombatSounds();
  // Both of these count down on their own: the server announces a deadline and then says nothing
  // when it passes.
  updateLootRolls(now);
  updateReadyCheck(now);
  updateNotices(now);
  updatePetBar(now);
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
        fullFrameStatus.textContent = snapshot.count === 0
          ? "CPU full-frame: ожидание кадра…"
          : `CPU full-frame: ${snapshot.average.toFixed(1)} мс (p50 ${snapshot.p50.toFixed(1)}, p95 ${snapshot.p95.toFixed(1)}, p99 ${snapshot.p99.toFixed(1)})`
            + (snapshot.longFrames > 0 ? ` · >${LONG_FRAME_THRESHOLD_MS} мс: ${snapshot.longFrames}` : "");
      }
    } finally {
      try {
        if (measuring) renderBenchmarkRuntime.recordFullFrameCpu(fullFrameClock.end());
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
