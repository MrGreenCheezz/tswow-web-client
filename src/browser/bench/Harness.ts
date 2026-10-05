/** Local deterministic benchmark. Imports shipping render paths; never opens a world connection. */
import * as THREE from "three";
import { WorldRenderer3D } from "../WorldRenderer3D.js";
import { WorldState, type WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";
import { ANIMATION_IDS } from "../../generated/animations.js";
import { TerrainClient, EnvironmentClient, ENVIRONMENT_STREAM_RANGE } from "../Terrain.js";
import { TerrainSplatClient } from "../TerrainSplat.js";
import { GroundCoverClient } from "../GroundCover.js";
import { LightClient } from "../LightClient.js";
import { LiquidTextureClient } from "../Water.js";
import { HorizonClient } from "../Horizon.js";
import { environmentStandInsWith } from "../StandIn.js"; // 05.10-A7b-9 (7.18)
import { CharacterAtlasClient, appearanceKey, CREATURE_MODEL_VERSION } from "../CharacterAtlas.js";
import type { UnitModel } from "../CreatureModelClient.js";
import { buildModel, characterSlots } from "../ModelBuild.js"; // 05.10-A7a-G 6.18: geosetList → figureGeosets
import { figureGeosets } from "../FigureGeosets.js"; // 05.10-A7a-G 6.18
import { addSkinnedClips, buildSkinnedTemplateFrom, instantiateSkinned } from "../AnimatedModel.js";
import { decodeWvm9, decodeWvaAnimations, visualModelUrl, visualAnimationsUrl, TEXTURE_TYPE_BODY } from "../Wvm.js";
import { acquireRenderBenchmarkFormalGpuObserver } from "../RenderBenchmarkRuntime.js";
import { createWebGlGpuTimer } from "../GpuTimer.js";
import { UnitSceneGroup } from "../UnitSceneGroup.js";
import { applyRendererGraphicsSettings } from "../RendererGraphicsSettings.js";
import { defaultSettings, type SettingValues } from "../ui/SettingsModel.js";
import { nextBenchmarkFrame } from "./FrameClock.js";

interface Graphics {
  lightingQuality: number; grassRadius: number; grassDense: boolean; grassDensity: number; fullscreenGlow: boolean;
  godRays?: boolean;
}
interface Config {
  seed: number; width: number; height: number; pixelRatio: number; durationSeconds: number;
  warmupSeconds: number; timeoutSeconds: number; halfMinute: number;
  route: { map: number; x: number; y: number; dx: number; dy: number };
  graphics: Graphics;
  /** A dense city square: a fixed WMO floor, a mixed population and the live client's settings. */
  city: { map: number; x: number; y: number; z: number; population: number; spacing: number; walkers: number;
    orbit: number; pitch: number; displays: number[]; graphics: Graphics };
  /** `bench/run.mjs --settings`: a player's account settings, pushed like the page pushes them. */
  settings?: SettingValues;
  /**
   * `bench/lookdev.mjs`: a fixed camera (yaw, pitch, orbit) over the scenario's own route, a weather
   * packet handed to the renderer as the world would, and how many frames `view()` lets run
   * before it reads the pixels (rain, wind and the veil need a few seconds to settle). Never part
   * of a measurement: lookdev frames are looked at, not timed.
   */
  view?: { yaw: number; pitch: number; orbit: number };
  weather?: { state: number; intensity: number; abrupt: boolean } | null;
  viewFrames?: number;
}
interface BenchWindow extends Window {
  __benchRenderers?: THREE.WebGLRenderer[];
  __bench?: { prepare(): Promise<unknown>; run(): Promise<unknown>; view(fraction: number): Promise<unknown>;
    state(): unknown; setWorldSubmissionCapture(enabled: boolean): void; sceneStats(): unknown;
    lookdev(overrides: Partial<Config>): void; shadowStats(): unknown };
}
const host = window as BenchWindow;
const config = await (await fetch('/config.json')).json() as Config;
const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'movement';
const diagnostic = params.has('diagnostic');
// Name the draw behind every program linked inside a measured frame (`--links`); on under --diagnostic too.
const links = diagnostic || params.has('links');
const canvas = document.querySelector('canvas')!;
const worldCrowd = scenario.startsWith('world-crowd-');
/**
 * `city-arrival`: the city square without its crowd during preparation; the crowd then comes into
 * range while the clock runs, eight units a second, as it does when a rider enters a city. The
 * plain `city` builds everyone before timing, so it never measures a unit's first appearance.
 */
const arrival = scenario === 'city-arrival';
const ARRIVAL_GROUP = 8;
const city = scenario === 'city' || arrival;
const movement = scenario === 'movement' || worldCrowd || city;
const count = scenario === 'movement' ? 10 : city ? config.city.population : Number(scenario.split('-').at(-1));
if (!city && ![10, 50, 64, 200].includes(count)) throw new Error('Invalid scenario');
const graphics = city ? config.city.graphics : config.graphics;
const map = city ? config.city.map : config.route.map;
const counters = { boneUpdates: 0, boneWorldUpdates: 0, hiddenUnitVisits: 0 };
if (diagnostic) {
  const update = THREE.Object3D.prototype.updateMatrixWorld;
  THREE.Object3D.prototype.updateMatrixWorld = function(force) {
    if ((this as THREE.Bone).isBone) counters.boneUpdates++;
    update.call(this, force);
  };
  const updateWorld = THREE.Object3D.prototype.updateWorldMatrix;
  THREE.Object3D.prototype.updateWorldMatrix = function(parents, children, force) {
    if ((this as THREE.Bone).isBone) counters.boneWorldUpdates++;
    updateWorld.call(this, parents, children, force);
  };
  const updateUnit = UnitSceneGroup.prototype.updateMatrixWorld;
  UnitSceneGroup.prototype.updateMatrixWorld = function(force) {
    if (!this.visible) counters.hiddenUnitVisits++;
    updateUnit.call(this, force);
  };
}
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
let randomState = config.seed;
Math.random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 4294967296;
};
const baseUrl = location.origin;
async function checked(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Asset ${response.status}: ${url}`);
  return response;
}
const display = (await (await checked(`${baseUrl}/dbc/creature-models?v=${CREATURE_MODEL_VERSION}&ids=49`)).json() as UnitModel[])[0]!;
if (!display?.appearance) throw new Error('Display 49 has no real character appearance');
const cityDisplays = city
  ? await (await checked(`${baseUrl}/dbc/creature-models?v=${CREATURE_MODEL_VERSION}&ids=${config.city.displays.join(',')}`)).json() as UnitModel[]
  : [];
if (city && cityDisplays.length !== config.city.displays.length) throw new Error('City display missing');
const gpuSamplesMs: number[] = [];
let recording = false;
let gpuReason: string | undefined;
const gpuObserver = { onSample(ms: number) { if (recording) gpuSamplesMs.push(ms); },
  onUnavailable(reason: string) { gpuReason = reason; } };
const phaseNames = movement
  ? ['query', 'setup', 'terrain', 'env', 'ground', 'objects', 'units', 'visuals', 'warm', 'evict', 'submit']
  : ['animation', 'submit'];
let render: (seconds: number, elapsed: number, frame: number) => void;
let reset: () => void;
/** city-arrival: admits the units due by this many seconds into the measurement. */
let arrive: (seconds: number) => void = () => {};
let readiness: () => { pending: number; errors: number; details: unknown };
let phases: () => Readonly<Record<string, number>>;
let world: WorldRenderer3D | undefined;
let renderer: THREE.WebGLRenderer;
let lastFraction = 0;
let queryMs = 0;
let routeHeightMissing = 0;
let lastFrame = 0;
let preparingWorldCrowd = worldCrowd || city;
let lastScene: THREE.Object3D | undefined;
const textureUploads: Array<{ atMs: number; ms: number; type: string; width: number; height: number; depth: number }> = [];

if (movement) {
  acquireRenderBenchmarkFormalGpuObserver(gpuObserver);
  world = new WorldRenderer3D(canvas);
  if (diagnostic) world.setWorldSubmissionCapture(true);
  const worldRenderer = world;
  renderer = host.__benchRenderers!.at(-1)!;
  if (!renderer?.info) throw new Error('Three.js renderer observation failed');
  if (diagnostic) {
    // The world scene is the renderer's largest submission; sky, overlay and glow scenes are tiny.
    const submit = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
      if (!lastScene || scene.children.length >= lastScene.children.length) lastScene = scene;
      submit(scene, camera);
    };
    // Explicit texture uploads outside the draw: what kind, how large, and how long each took.
    const initTexture = renderer.initTexture.bind(renderer);
    renderer.initTexture = (texture) => {
      const at = performance.now();
      initTexture(texture);
      const image = texture.image as { width?: number; height?: number; depth?: number } | undefined;
      if (recording) textureUploads.push({ atMs: at, ms: performance.now() - at, type: texture.constructor.name,
        width: image?.width ?? 0, height: image?.height ?? 0, depth: image?.depth ?? 1 });
    };
  }
  const terrain = new TerrainClient(baseUrl);
  const environment = new EnvironmentClient(baseUrl);
  const splat = new TerrainSplatClient(baseUrl);
  const cover = new GroundCoverClient(baseUrl);
  const lighting = new LightClient(baseUrl);
  const liquids = new LiquidTextureClient(baseUrl);
  const horizon = new HorizonClient(baseUrl);
  world.setLightingQuality(graphics.lightingQuality);
  world.setFullscreenGlow(graphics.fullscreenGlow);
  if (graphics.godRays !== undefined) world.setGodRays(graphics.godRays);
  world.setGroundCover(cover, graphics.grassRadius, graphics.grassDense, graphics.grassDensity);
  // A player's own graphics options over the scenario's block: every leaf the page would push.
  if (config.settings) applyRendererGraphicsSettings(world, { ...defaultSettings(), ...config.settings }, cover);
  if (config.weather) world.setWeather(config.weather);
  const state = new WorldState();
  const objects: WorldObjectState[] = [];
  for (let i = 0; i < count; i++) {
    const npc = (worldCrowd || city) && i > 0;
    // City walkers run small loops; everyone else in a crowd stands, as vendors and guards do.
    const walking = city
      ? npc && i % Math.max(1, Math.floor(count / Math.max(1, config.city.walkers))) === 0
      : !npc;
    const displayId = city ? cityDisplays[i % cityDisplays.length]!.id : display.id;
    const object: WorldObjectState = { guid: BigInt(i + 1), typeId: npc ? 3 : 4,
      position: { x: config.route.x, y: config.route.y, z: 60, orientation: Math.PI },
      movementFlags: walking ? MOVEMENT_FLAGS.forward : 0, updateFlags: 0, targetGuid: undefined,
      runSpeed: 7, turnRate: undefined, motion: undefined, glide: undefined,
      transport: undefined, speeds: undefined, transportTime: undefined,
      fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId],
        [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100], [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100]]) };
    if (!arrival || i === 0) state.objects.set(object.guid, object);
    objects.push(object);
  }
  state.selfGuid = objects[0]!.guid;
  const heightAt = (x: number, y: number) => terrain.heightAt(map, x, y);
  const displayById = new Map(cityDisplays.map((model) => [model.id, model]));
  const modelOf = city
    ? (object: WorldObjectState) => displayById.get(object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0)
    : () => display;
  render = (seconds, elapsed, frame) => {
    lastFraction = Math.max(0, Math.min(1, seconds / config.durationSeconds));
    lastFrame = frame;
    const angle = lastFraction * Math.PI * 2;
    const centreX = city ? config.city.x : config.route.x;
    const centreY = city ? config.city.y : config.route.y;
    const x = city ? centreX : config.route.x + (worldCrowd ? Math.cos(angle) * 22 : config.route.dx * lastFraction);
    const y = city ? centreY : config.route.y + (worldCrowd ? Math.sin(angle) * 22 : config.route.dy * Math.sin(angle));
    const rows = Math.ceil(Math.sqrt(count - 1));
    const spacing = city ? config.city.spacing : 2.5;
    const queryAt = performance.now();
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i]!;
      const p = object.position!;
      if (city) {
        if (i === 0) { p.x = centreX; p.y = centreY; }
        else {
          const gridX = centreX + ((i - 1) % rows - (rows - 1) / 2) * spacing;
          const gridY = centreY + (Math.floor((i - 1) / rows) - (rows - 1) / 2) * spacing;
          const loop = object.movementFlags !== 0 ? seconds * 0.9 + i : 0;
          p.x = gridX + (object.movementFlags !== 0 ? Math.cos(loop) * 1.5 : 0);
          p.y = gridY + (object.movementFlags !== 0 ? Math.sin(loop) * 1.5 : 0);
          p.orientation = object.movementFlags !== 0 ? loop + Math.PI / 2 : (i * 2.39996) % (Math.PI * 2);
        }
        p.z = config.city.z;
        continue;
      }
      p.x = worldCrowd && i > 0 ? config.route.x + ((i - 1) % rows - (rows - 1) / 2) * 2.5
        : x + (i === 0 ? 0 : (i % 3) * 2 - 4);
      p.y = worldCrowd && i > 0 ? config.route.y + (Math.floor((i - 1) / rows) - (rows - 1) / 2) * 2.5
        : y + (i === 0 ? 0 : Math.ceil(i / 3) * 3);
      const height = heightAt(p.x, p.y);
      if (height !== undefined) p.z = height + .02;
      else if (recording && i === 0) routeHeightMissing++;
    }
    environment.beginResourceFrame();
    try {
      const scenery = environment.objectsAround(map, x, y, ENVIRONMENT_STREAM_RANGE);
      const p = objects[0]!.position!;
      worldRenderer.updateLighting(lighting.sample(map, x, y, config.halfMinute, 0, p.z), config.halfMinute);
      queryMs = performance.now() - queryAt;
      worldRenderer.beginRenderFrame();
      try {
        const crowdClock = worldCrowd || city;
        const view = config.view;
        worldRenderer.draw(state, map, heightAt, terrain, scenery, environment,
          undefined,
          view ? view.yaw : city ? angle : worldCrowd ? angle : Math.sin(lastFraction * Math.PI * 2) * .4,
          view ? view.pitch : city ? config.city.pitch : worldCrowd ? -.4 : -.22,
          view ? view.orbit : city ? config.city.orbit : worldCrowd ? 42 : 24,
          modelOf, splat, liquids, undefined, horizon, 24, () => true, 1.6,
          undefined, undefined, { nowMs: (crowdClock
            ? preparingWorldCrowd ? 0 : config.warmupSeconds + seconds
            : seconds) * 1000, elapsedSeconds: elapsed, frameIndex: frame });
      } finally { worldRenderer.endRenderFrame(); }
    } finally { environment.endResourceFrame(); }
  };
  reset = () => worldRenderer.resetReplayEpoch(config.seed);
  arrive = (seconds) => {
    const due = Math.min(objects.length, 1 + ARRIVAL_GROUP * Math.floor(seconds));
    for (let i = 1; i < due; i++) if (!state.objects.has(objects[i]!.guid)) state.objects.set(objects[i]!.guid, objects[i]!);
  };
  phases = () => ({ query: queryMs, ...worldRenderer.drawPhaseMs });
  // 05.10-A7b-9 (7.18): the environment stand-ins with the tile losses and retry waits of this run's clients.
  const benchStandIns = () => {
    const report = worldRenderer.standInReport();
    return { ...report, environment: environmentStandInsWith(report.environment,
      { environment, splat, light: lighting, horizon }) };
  };
  readiness = () => {
    const e = environment.stats, t = terrain.stats, s = splat.stats, r = worldRenderer.benchmarkReadiness;
    const async = [cover.stats, lighting.stats, liquids.stats, horizon.stats];
    const pending = e.activeTiles + e.activeModels + e.queuedModels + e.activeGroups + e.queuedGroups
      + e.activeAnimations + e.queuedAnimations + t.active + s.active
      + r.modelTexturesPending + r.worldTexturesPending + (r.wmoGroupsPending ?? 0)
      + (r.terrainRepairsPending ?? 0)
      + r.groundCoverModelsPending + r.characterAtlasPending
      + worldRenderer.programWarmup.queued + async.reduce((n, x) => n + x.pending, 0);
    const errors = e.failedModels + e.failedTiles + e.failedGroups + e.failedAnimations
      + r.modelTexturesErrors + r.worldTexturesErrors + r.characterAtlasErrors + t.failed + s.failed + async.reduce((n, x) => n + x.error, 0);
    return { pending, errors, details: { environment: e, terrain: t, splat: s, renderer: r,
      units: worldRenderer.telemetry.unitsDrawn, standIns: benchStandIns() } };
  };
} else {
  const appearance = display.appearance;
  const [modelBuffer, animationBuffer] = await Promise.all([
    checked(visualModelUrl(baseUrl, display.model)).then(r => r.arrayBuffer()),
    checked(visualAnimationsUrl(baseUrl, display.model)).then(r => r.arrayBuffer()),
  ]);
  const model = decodeWvm9(modelBuffer);
  if (!model.skeleton) throw new Error('Character skeleton missing');
  const atlas = new CharacterAtlasClient(baseUrl);
  const body = await atlas.compose(appearanceKey(appearance), appearance.body);
  if (!body) throw new Error('Character atlas missing');
  const textures: Promise<THREE.Texture>[] = [];
  const loader = new THREE.TextureLoader();
  const built = buildModel(model, { modelPath: display.model, baseUrl,
    slots: characterSlots(display.textures, appearance), geosets: figureGeosets(model, appearance), // 05.10-A7a-G 6.18
    slotTextures: new Map([[TEXTURE_TYPE_BODY, body]]), skinned: true,
    coalesceAdjacentBatches: true,
    loadTexture(url) {
      let texture!: THREE.Texture;
      textures.push(new Promise((resolve, reject) => { texture = loader.load(url, resolve, undefined, reject); }));
      return texture;
    } });
  await Promise.all(textures);
  const template = buildSkinnedTemplateFrom(built.geometry, model.skeleton, built.height);
  if (!template) throw new Error('Character template missing');
  addSkinnedClips(template, decodeWvaAnimations(animationBuffer, model.skeleton.parents.length));
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(config.pixelRatio);
  renderer.setSize(config.width, config.height, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x213243);
  scene.add(new THREE.HemisphereLight(0xe9f5ff, 0x6c5138, 2.4));
  const light = new THREE.DirectionalLight(0xffe2b9, 2.2);
  light.position.set(15, 24, 10);
  scene.add(light);
  const rows = Math.ceil(Math.sqrt(count));
  const instances = Array.from({ length: count }, (_, i) => {
    const instance = instantiateSkinned(template, built.materials);
    const clip = template.clips.get(i % 4 === 0 ? ANIMATION_IDS.Run : ANIMATION_IDS.Stand);
    if (!clip) throw new Error('Stand/Run clip missing');
    const action = instance.mixer.clipAction(clip).play();
    const offset = Math.random() * clip.duration;
    action.time = offset;
    instance.root.position.set((i % rows - (rows - 1) / 2) * 2.5, 0, (Math.floor(i / rows) - (rows - 1) / 2) * 2.5);
    scene.add(instance.root);
    return { instance, action, offset };
  });
  const camera = new THREE.PerspectiveCamera(42, config.width / config.height, .1, 500);
  const gpu = createWebGlGpuTimer(renderer.getContext(), gpuObserver);
  const times = { animation: 0, submit: 0 };
  reset = () => {
    for (const { instance, action, offset } of instances) {
      instance.mixer.setTime(0); action.time = offset; instance.mixer.update(0);
    }
    gpu.resetEpoch();
  };
  render = (seconds, elapsed, frame) => {
    lastFrame = frame;
    lastFraction = Math.max(0, Math.min(1, seconds / config.durationSeconds));
    const angle = .65 + lastFraction * .25;
    const distance = rows * 4.8;
    camera.position.set(Math.sin(angle) * distance, rows * 2.8, Math.cos(angle) * distance);
    camera.lookAt(0, 1, 0);
    const start = performance.now();
    for (const { instance } of instances) instance.mixer.update(elapsed);
    times.animation = performance.now() - start;
    const active = gpu.beginFrame();
    const submit = performance.now();
    renderer.render(scene, camera);
    times.submit = performance.now() - submit;
    if (active) gpu.endFrame();
  };
  phases = () => times;
  readiness = () => ({ pending: 0, errors: 0, details: { units: instances.length,
    bonesPerUnit: template.parents.length, trianglesPerUnit: built.geometry.index!.count / 3 } });
}

function hardware() {
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string : gl.getParameter(gl.RENDERER) as string,
    webgl: gl.getParameter(gl.VERSION) as string, antialias: gl.getContextAttributes()?.antialias,
    canvas: [canvas.width, canvas.height], pixelRatio: renderer.getPixelRatio(),
    gpuTimerReason: gpuReason ?? null, crossOriginIsolated: globalThis.crossOriginIsolated === true };
}
async function settle(fraction: number) {
  const deadline = performance.now() + config.timeoutSeconds * 1000;
  let stable = 0, frame = 0;
  while (performance.now() < deadline) {
    await nextFrame(); render(fraction * config.durationSeconds, 0, frame++);
    if (frame % 10 !== 0) continue;
    const status = readiness();
    stable = status.pending === 0 ? stable + 1 : 0;
    if (stable >= 6) {
      if (status.errors) throw new Error(`Asset errors: ${JSON.stringify(status)}`);
      return status;
    }
  }
  throw new Error(`Scene did not settle: ${JSON.stringify(readiness())}`);
}
host.__bench = {
  setWorldSubmissionCapture(enabled: boolean) {
    if (scenario !== 'world-crowd-50' || !world) throw new Error('Capture A/B requires world-crowd-50');
    world.setWorldSubmissionCapture(enabled);
  },
  async prepare() {
    reset();
    // Retained NPCs must have been admitted around the whole square before timing.
    if (worldCrowd || city) for (let i = 0; i < 8; i++) await settle(i / 8);
    await settle(0);
    // Admission happens at zero throughout preparation. Timed/views start after spawn fade,
    // without rewinding admission ages from the later preparation viewpoints into the future.
    preparingWorldCrowd = false;
    const start = await nextFrame();
    let previous = start, frame = 0;
    while (previous - start < config.warmupSeconds * 1000) {
      const now = await nextFrame();
      render(0, (now - previous) / 1000, frame++); previous = now;
    }
    await settle(0);
    return { scenario, count, hardware: hardware(), readiness: readiness() };
  },
  async run() {
    reset();
    routeHeightMissing = 0;
    gpuSamplesMs.length = 0;
    textureUploads.length = 0;
    const columns = ['rafAtMs', 'intervalMs', 'cpuMs', ...phaseNames, 'calls', 'triangles', 'programs', 'geometries', 'textures', 'heapBytes',
      ...(diagnostic ? ['boneUpdates', 'boneWorldUpdates', 'hiddenUnitVisits'] : [])];
    const capacity = Math.ceil(config.durationSeconds * 2000);
    const samples = new Float64Array(capacity * columns.length);
    const worldSubmissions: Array<{ rafAtMs: number; sample: unknown }> = [];
    const programLinks: Array<{ atMs: number; cpuMs: number; name: string; key: string; draw?: string }> = [];
    let linkedPrograms = renderer.info.programs?.length ?? 0;
    // The draw that made three link a program, named while it happens: the program count grows
    // inside `renderBufferDirect`, so the object, its branch and its material are known then.
    let linkingDraws: string[] = [];
    // Disposals that destroy a program (the last holder let go): who released the program a live mesh
    // then had to link again.
    const disposals: Array<{ atMs: number; uuid: string; type: string; key: string; programsBefore: number; programsAfter: number }> = [];
    if (links) {
      const dispose = THREE.Material.prototype.dispose;
      THREE.Material.prototype.dispose = function () {
        const before = renderer.info.programs?.length ?? 0;
        const key = (renderer.properties.get(this) as { currentProgram?: { cacheKey?: string } }).currentProgram?.cacheKey ?? "";
        dispose.call(this);
        const after = renderer.info.programs?.length ?? 0;
        if (after < before) disposals.push({ atMs: performance.now(), uuid: this.uuid.slice(0, 8), type: this.type, key: key.slice(-120), programsBefore: before, programsAfter: after });
      };
    }
    // Hold decisions (`WarmHold`) land in the same sink the trace mode reads; with --links alone the
    // sink is made here so a strict run can still say whether a linking mesh was ever held.
    const debugSink = (globalThis as { __benchDebug?: unknown[] });
    if (links && !Array.isArray(debugSink.__benchDebug)) debugSink.__benchDebug = [];
    if (links) {
      const directRun = renderer.renderBufferDirect;
      let inShadow = false;
      const shadowRun = renderer.shadowMap.render;
      renderer.shadowMap.render = function (...args) {
        inShadow = true;
        try { shadowRun.apply(this, args); } finally { inShadow = false; }
      };
      renderer.renderBufferDirect = function (...args) {
        const before = renderer.info.programs?.length ?? 0;
        // The program the material drew with until now, to diff against the one it links now.
        const previousKey = (renderer.properties.get(args[3] as THREE.Material) as { currentProgram?: { cacheKey?: string } })
          .currentProgram?.cacheKey ?? "(none)";
        const record = renderer.properties.get(args[3] as THREE.Material) as { programs?: Map<string, unknown> };
        const hadGlobal = previousKey !== "(none)" && (renderer.info.programs ?? []).some((p) => (p as { cacheKey?: string }).cacheKey === previousKey);
        const perMaterial = record.programs?.size ?? 0;
        try { directRun.apply(this, args); } finally {
          const after = renderer.info.programs?.length ?? 0;
          if (after > before) {
            const object = args[4] as THREE.Object3D & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean };
            const material = args[3] as THREE.Material & { map?: THREE.Texture | null };
            let node: THREE.Object3D = object;
            while (node.parent && node.parent.parent) node = node.parent;
            const kind = object.isInstancedMesh ? "instanced" : object.isSkinnedMesh ? "skinned" : "mesh";
            const build = object.userData["build"] ?? object.parent?.userData["build"] ?? "";
            linkingDraws.push(`${inShadow ? "shadow" : "main"}|${kind}|${node.type}:${node.name || node.children.length}`
              + `|${object.name || object.type}|${material.type}|t${material.transparent ? 1 : 0}|a${material.alphaTest > 0 ? 1 : 0}`
              + `|side${material.side}|${material.uuid.slice(0, 8)}|visible=${object.visible}|v${material.version}`
              + `|build=${String(build).slice(0, 80)}|key=${material.customProgramCacheKey().slice(-90)}`
              + `|hadGlobal=${hadGlobal}|perMaterial=${perMaterial}|previous=${previousKey}|now=${(renderer.properties.get(material) as { currentProgram?: { cacheKey?: string } }).currentProgram?.cacheKey ?? ""}`);
          }
        }
      };
    }
    let nextSubmissionCheckpoint = 0;
    let frame = 0;
    // The seed frame is rendered before timing. Every recorded interval ends after the preceding draw.
    render(0, 0, frame++);
    world?.poseWorkerStats(true);
    const start = await nextFrame();
    let previous = start, sampleCount = 0, repeatedRafCallbacks = 0;
    recording = true;
    performance.mark('bench-start');
    try {
      while (previous - start < config.durationSeconds * 1000) {
        const next = await nextBenchmarkFrame(previous, nextFrame);
        const now = next.timestamp;
        repeatedRafCallbacks += next.repeatedCallbacks;
        const seconds = (now - start) / 1000;
        const at = performance.now();
        if (diagnostic) { counters.boneUpdates = 0; counters.boneWorldUpdates = 0; counters.hiddenUnitVisits = 0; }
        if (arrival) arrive(seconds);
        render(seconds, (now - previous) / 1000, frame++);
        const cpuMs = performance.now() - at;
        const phase = phases(), info = renderer.info;
        const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
        if (sampleCount >= capacity) throw new Error('Frame capacity exceeded');
        const row = [now - start, now - previous, cpuMs, ...phaseNames.map(name => phase[name] ?? 0),
          info.render.calls, info.render.triangles, info.programs?.length ?? 0,
          info.memory.geometries, info.memory.textures, heap,
          ...(diagnostic ? [counters.boneUpdates, counters.boneWorldUpdates, counters.hiddenUnitVisits] : [])];
        samples.set(row, sampleCount++ * columns.length);
        // Every program three linked inside a measured frame, with the frame's cost: a link that
        // the warm pass did not get to first is a 20–40 ms frame, and its cache key names it.
        if (links) {
          const list = info.programs ?? [];
          if (list.length > linkedPrograms) {
            for (let index = linkedPrograms; index < list.length; index++) {
              programLinks.push({ atMs: now - start, cpuMs, name: list[index]!.name,
                key: (list[index] as { cacheKey?: string }).cacheKey ?? "",
                draw: linkingDraws[index - linkedPrograms] ?? linkingDraws.join(" ; ") });
            }
          }
          linkedPrograms = list.length;
          linkingDraws = [];
        }
        if (diagnostic && world && now >= nextSubmissionCheckpoint) {
          nextSubmissionCheckpoint = now + 500;
          worldSubmissions.push({ rafAtMs: now - start, sample: world.telemetry.worldSubmission });
        }
        previous = now;
      }
    } finally { recording = false; performance.mark('bench-end'); }
    const frames = Array.from({ length: sampleCount }, (_, index) =>
      Array.from(samples.subarray(index * columns.length, (index + 1) * columns.length)));
    return { scenario, count, columns, phaseNames, frames, gpuSamplesMs: [...gpuSamplesMs],
      hardware: hardware(), readiness: readiness(), routeHeightMissing, repeatedRafCallbacks,
      telemetry: world?.telemetry ?? null, poseWorker: world?.poseWorkerStats() ?? null,
      ...(diagnostic ? { worldSubmissions, textureUploads: [...textureUploads] } : {}),
      ...(links ? { programLinks, holdDebug: debugSink.__benchDebug ?? [], disposals } : {}) };
  },
  async view(fraction) {
    if (arrival) arrive(Number.POSITIVE_INFINITY);
    await settle(fraction);
    reset();
    // The replay reset forgets the weather packet, as a fresh world would; a lookdev still wants it.
    if (config.weather) world?.setWeather(config.weather);
    const frames = Math.max(1, Math.floor(config.viewFrames ?? 60));
    for (let frame = 0; frame <= frames; frame++) {
      await nextFrame(); render(fraction * config.durationSeconds, frame === 0 ? 0 : 1 / 60, frame);
    }
    // Serialize pixels in the same task as the draw, before the compositor clears the drawing buffer.
    return { png: canvas.toDataURL('image/png'), readiness: readiness() };
  },
  lookdev(overrides) {
    // Time of day, camera and weather for the next `view()`; nothing here is measured.
    Object.assign(config, overrides);
    // Clearing is abrupt too: a still taken while the last frame's storm fades out over five
    // seconds would carry its flattened grade and thinned haze into a clear-sky frame.
    if ('weather' in overrides) world?.setWeather(overrides.weather ?? { state: 0, intensity: 0, abrupt: true });
  },
  shadowStats: () => world ? { cascades: world.shadowCascadeStats, calls: renderer.info.render.calls } : null,
  state: () => ({ scenario, fraction: lastFraction, frame: lastFrame, readiness: readiness() }),
  sceneStats: () => {
    // Diagnostic census of the scene graph the renderer last submitted: where the per-frame
    // matrix traversal and projection walk actually spend their visits.
    const scene = lastScene;
    if (!scene) return null;
    const byBranch: Record<string, Record<string, number>> = {};
    const materials = new Set<string>();
    const visibleMaterials = new Set<string>();
    const walk = (node: THREE.Object3D, branch: string, visible: boolean): void => {
      const row = byBranch[branch] ??= { nodes: 0, autoUpdate: 0, meshes: 0, visibleMeshes: 0, skinned: 0,
        instanced: 0, bones: 0, hidden: 0, frustumCulled: 0, groups: 0 };
      row.nodes!++;
      if (node.matrixAutoUpdate) row.autoUpdate!++;
      const shown = visible && node.visible;
      if (!node.visible) row.hidden!++;
      if ((node as THREE.Bone).isBone) row.bones!++;
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        row.meshes!++;
        if (shown) row.visibleMeshes!++;
        if ((node as THREE.SkinnedMesh).isSkinnedMesh) row.skinned!++;
        if ((node as THREE.InstancedMesh).isInstancedMesh) row.instanced!++;
        if (mesh.frustumCulled) row.frustumCulled!++;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          materials.add(material.uuid);
          if (shown) visibleMaterials.add(material.uuid);
        }
        if (shown) row.groups! += Math.max(1, mesh.geometry.groups.length);
      }
      for (const child of node.children) walk(child, branch, shown);
    };
    for (const child of scene.children) walk(child, `${child.type}:${child.name || child.children.length}`, true);
    // One more frame with its main-pass submissions attributed to their scene branch.
    const draws: Record<string, { draws: number; materials: Set<string>; transparent: number; doubleSided: number;
      backPasses: number }> = {};
    const branchOf = (object: THREE.Object3D): string => {
      let node = object;
      while (node.parent && node.parent !== scene) node = node.parent;
      return `${node.type}:${node.name || node.children.length}`;
    };
    let shadowPass = false;
    const renderShadow = renderer.shadowMap.render;
    renderer.shadowMap.render = function (...args) {
      shadowPass = true;
      try { renderShadow.apply(this, args); } finally { shadowPass = false; }
    };
    // Which draws make three derive program parameters again (`setProgram` → `getProgram` →
    // `getParameters`, which ends in `material.customProgramCacheKey()`): every such derivation
    // is ~2 KB of garbage and a cache-key walk, and a material shared by objects of different
    // kinds pays it on every alternation. Counted per pass, object kind, branch and material.
    let currentDraw: { object: THREE.Object3D; material: THREE.Material; pass: string } | undefined;
    const derivations = new Map<string, number>();
    const cacheKey = THREE.Material.prototype.customProgramCacheKey;
    THREE.Material.prototype.customProgramCacheKey = function () {
      const draw = currentDraw;
      if (draw) {
        const object = draw.object as THREE.Object3D & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; instanceColor?: unknown };
        const kind = object.isInstancedMesh ? (object.instanceColor ? "instanced-colour" : "instanced")
          : object.isSkinnedMesh ? "skinned" : "mesh";
        const source = draw.material as THREE.Material & { map?: THREE.Texture | null };
        const depth = this as THREE.Material & { map?: THREE.Texture | null };
        const key = `${draw.pass}|${kind}|${branchOf(object)}|${this.type}|t${this.transparent ? 1 : 0}`
          + `|a${this.alphaTest > 0 ? 1 : 0}|m${depth.map ? 1 : 0}|${this.uuid.slice(0, 8)}`
          + `|src:${source.type}/${source.uuid.slice(0, 8)}`;
        derivations.set(key, (derivations.get(key) ?? 0) + 1);
      }
      return cacheKey.call(this);
    };
    // Shadow-pass draws by branch and object kind: what the cascades redraw, and how much of it is
    // scenery the view did not admit (shown for the shadow cameras only).
    const shadowDraws: Record<string, number> = {};
    const direct = renderer.renderBufferDirect;
    renderer.renderBufferDirect = function (...args) {
      const material = args[3] as THREE.Material, object = args[4] as THREE.Object3D;
      currentDraw = { object, material, pass: shadowPass ? "shadow" : args[1] === scene ? "main" : "other" };
      if (shadowPass) {
        const kind = (object as THREE.InstancedMesh).isInstancedMesh ? "instanced"
          : (object as THREE.SkinnedMesh).isSkinnedMesh ? "skinned" : "mesh";
        const key = `${branchOf(object)}|${kind}`;
        shadowDraws[key] = (shadowDraws[key] ?? 0) + 1;
      }
      if (!shadowPass && args[1] === scene) {
        const row = draws[branchOf(object)] ??= { draws: 0, materials: new Set(), transparent: 0,
          doubleSided: 0, backPasses: 0 };
        row.draws++;
        row.materials.add(material.uuid);
        if (material.transparent) row.transparent++;
        if (material.side === THREE.DoubleSide) row.doubleSided++;
        // Three splits a transparent two-sided draw into a back pass and a front pass.
        if (material.side === THREE.BackSide) row.backPasses++;
      }
      try { direct.apply(this, args); } finally { currentDraw = undefined; }
    };
    try { render(lastFraction * config.durationSeconds, 1 / 60, lastFrame + 1); }
    finally {
      renderer.renderBufferDirect = direct;
      renderer.shadowMap.render = renderShadow;
      THREE.Material.prototype.customProgramCacheKey = cacheKey;
    }
    const drawsByBranch = Object.fromEntries(Object.entries(draws).map(([branch, row]) =>
      [branch, { draws: row.draws, materials: row.materials.size, transparent: row.transparent, doubleSided: row.doubleSided,
        backPasses: row.backPasses }]));
    const byPass: Record<string, number> = {};
    for (const [key, count] of derivations) {
      const pass = key.slice(0, key.indexOf("|"));
      byPass[pass] = (byPass[pass] ?? 0) + count;
    }
    const parameterDerivations = {
      byPass,
      top: [...derivations.entries()].sort((left, right) => right[1] - left[1]).slice(0, 40)
        .map(([key, count]) => ({ key, count })),
    };
    // Every program three linked during the run, by its cache key: a diff of two sides' lists names
    // the variant one of them linked (a first-use link inside `submit` is a 20–40 ms frame).
    const programKeys = (renderer.info.programs ?? []).map((program) => ({
      name: program.name, usedTimes: program.usedTimes, key: (program as { cacheKey?: string }).cacheKey ?? "",
    }));
    return { byBranch, drawsByBranch, shadowDraws, materials: materials.size, visibleMaterials: visibleMaterials.size,
      programs: renderer.info.programs?.length ?? 0, parameterDerivations, programKeys };
  },
};
