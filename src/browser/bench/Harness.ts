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
import { CharacterAtlasClient, appearanceKey, CREATURE_MODEL_VERSION } from "../CharacterAtlas.js";
import type { UnitModel } from "../CreatureModelClient.js";
import { buildModel, characterSlots, geosetList } from "../ModelBuild.js";
import { addSkinnedClips, buildSkinnedTemplateFrom, instantiateSkinned } from "../AnimatedModel.js";
import { decodeWvm9, decodeWvaAnimations, visualModelUrl, visualAnimationsUrl, TEXTURE_TYPE_BODY } from "../Wvm.js";
import { acquireRenderBenchmarkFormalGpuObserver } from "../RenderBenchmarkRuntime.js";
import { createWebGlGpuTimer } from "../GpuTimer.js";
import { UnitSceneGroup } from "../UnitSceneGroup.js";

interface Config {
  seed: number; width: number; height: number; pixelRatio: number; durationSeconds: number;
  warmupSeconds: number; timeoutSeconds: number; halfMinute: number;
  route: { map: number; x: number; y: number; dx: number; dy: number };
  graphics: { lightingQuality: number; grassRadius: number; grassDense: boolean; grassDensity: number; fullscreenGlow: boolean };
}
interface BenchWindow extends Window {
  __benchRenderers?: THREE.WebGLRenderer[];
  __bench?: { prepare(): Promise<unknown>; run(): Promise<unknown>; view(fraction: number): Promise<unknown>; state(): unknown };
}
const host = window as BenchWindow;
const config = await (await fetch('/config.json')).json() as Config;
const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'movement';
const diagnostic = params.has('diagnostic');
const canvas = document.querySelector('canvas')!;
const worldCrowd = scenario.startsWith('world-crowd-');
const movement = scenario === 'movement' || worldCrowd;
const count = scenario === 'movement' ? 10 : Number(scenario.split('-').at(-1));
if (![10, 50, 200].includes(count)) throw new Error('Invalid scenario');
const counters = { boneUpdates: 0, boneWorldUpdates: 0, hiddenUnitVisits: 0 };
if (diagnostic) {
  const update = THREE.Object3D.prototype.updateMatrixWorld;
  THREE.Object3D.prototype.updateMatrixWorld = function(force) {
    if ((this as THREE.Bone).isBone) counters.boneUpdates++;
    update.call(this, force);
  };
  const updateWorld = THREE.Object3D.prototype.updateWorldMatrix;
  THREE.Object3D.prototype.updateWorldMatrix = function(parents, children) {
    if ((this as THREE.Bone).isBone) counters.boneWorldUpdates++;
    updateWorld.call(this, parents, children);
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
let readiness: () => { pending: number; errors: number; details: unknown };
let phases: () => Readonly<Record<string, number>>;
let world: WorldRenderer3D | undefined;
let renderer: THREE.WebGLRenderer;
let lastFraction = 0;
let queryMs = 0;
let routeHeightMissing = 0;
let lastFrame = 0;
let preparingWorldCrowd = worldCrowd;

if (movement) {
  acquireRenderBenchmarkFormalGpuObserver(gpuObserver);
  world = new WorldRenderer3D(canvas);
  if (diagnostic) world.setWorldSubmissionCapture(true);
  const worldRenderer = world;
  renderer = host.__benchRenderers!.at(-1)!;
  if (!renderer?.info) throw new Error('Three.js renderer observation failed');
  const terrain = new TerrainClient(baseUrl);
  const environment = new EnvironmentClient(baseUrl);
  const splat = new TerrainSplatClient(baseUrl);
  const cover = new GroundCoverClient(baseUrl);
  const lighting = new LightClient(baseUrl);
  const liquids = new LiquidTextureClient(baseUrl);
  const horizon = new HorizonClient(baseUrl);
  world.setLightingQuality(config.graphics.lightingQuality);
  world.setFullscreenGlow(config.graphics.fullscreenGlow);
  world.setGroundCover(cover, config.graphics.grassRadius, config.graphics.grassDense, config.graphics.grassDensity);
  const state = new WorldState();
  const objects: WorldObjectState[] = [];
  for (let i = 0; i < count; i++) {
    const object: WorldObjectState = { guid: BigInt(i + 1), typeId: worldCrowd && i > 0 ? 3 : 4,
      position: { x: config.route.x, y: config.route.y, z: 60, orientation: Math.PI },
      movementFlags: worldCrowd && i > 0 ? 0 : MOVEMENT_FLAGS.forward, updateFlags: 0, targetGuid: undefined,
      runSpeed: 7, turnRate: undefined, motion: undefined, glide: undefined,
      transport: undefined, speeds: undefined, transportTime: undefined,
      fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, display.id],
        [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100], [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100]]) };
    state.objects.set(object.guid, object);
    objects.push(object);
  }
  state.selfGuid = objects[0]!.guid;
  const heightAt = (x: number, y: number) => terrain.heightAt(config.route.map, x, y);
  const modelOf = () => display;
  render = (seconds, elapsed, frame) => {
    lastFraction = Math.max(0, Math.min(1, seconds / config.durationSeconds));
    lastFrame = frame;
    const angle = lastFraction * Math.PI * 2;
    const x = config.route.x + (worldCrowd ? Math.cos(angle) * 22 : config.route.dx * lastFraction);
    const y = config.route.y + (worldCrowd ? Math.sin(angle) * 22 : config.route.dy * Math.sin(angle));
    const rows = Math.ceil(Math.sqrt(count - 1));
    const queryAt = performance.now();
    for (let i = 0; i < objects.length; i++) {
      const p = objects[i]!.position!;
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
      const scenery = environment.objectsAround(config.route.map, x, y, ENVIRONMENT_STREAM_RANGE);
      const p = objects[0]!.position!;
      worldRenderer.updateLighting(lighting.sample(config.route.map, x, y, config.halfMinute, 0, p.z), config.halfMinute);
      queryMs = performance.now() - queryAt;
      worldRenderer.beginRenderFrame();
      try {
        worldRenderer.draw(state, config.route.map, heightAt, terrain, scenery, environment,
          undefined, worldCrowd ? angle : Math.sin(lastFraction * Math.PI * 2) * .4, worldCrowd ? -.4 : -.22, worldCrowd ? 42 : 24,
          modelOf, splat, liquids, undefined, horizon, 24, () => true, 1.6,
          undefined, undefined, { nowMs: (worldCrowd
            ? preparingWorldCrowd ? 0 : config.warmupSeconds + seconds
            : seconds) * 1000, elapsedSeconds: elapsed, frameIndex: frame });
      } finally { worldRenderer.endRenderFrame(); }
    } finally { environment.endResourceFrame(); }
  };
  reset = () => worldRenderer.resetReplayEpoch(config.seed);
  phases = () => ({ query: queryMs, ...worldRenderer.drawPhaseMs });
  readiness = () => {
    const e = environment.stats, t = terrain.stats, s = splat.stats, r = worldRenderer.benchmarkReadiness;
    const async = [cover.stats, lighting.stats, liquids.stats, horizon.stats];
    const pending = e.activeTiles + e.activeModels + e.queuedModels + e.activeGroups + e.queuedGroups
      + e.activeAnimations + e.queuedAnimations + t.active + s.active
      + r.modelTexturesPending + r.worldTexturesPending + r.groundCoverModelsPending + r.characterAtlasPending
      + worldRenderer.programWarmup.queued + async.reduce((n, x) => n + x.pending, 0);
    const errors = e.failedModels + e.failedTiles + e.failedGroups + e.failedAnimations
      + r.modelTexturesErrors + r.worldTexturesErrors + r.characterAtlasErrors + t.failed + s.failed + async.reduce((n, x) => n + x.error, 0);
    return { pending, errors, details: { environment: e, terrain: t, splat: s, renderer: r,
      units: worldRenderer.telemetry.unitsDrawn, standIns: worldRenderer.standInReport() } };
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
    slots: characterSlots(display.textures, appearance), geosets: geosetList(appearance.geosets),
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
    gpuTimerReason: gpuReason ?? null };
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
  async prepare() {
    reset();
    // Retained NPCs must have been admitted around the whole square before timing.
    if (worldCrowd) for (let i = 0; i < 8; i++) await settle(i / 8);
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
    const columns = ['rafAtMs', 'intervalMs', 'cpuMs', ...phaseNames, 'calls', 'triangles', 'programs', 'geometries', 'textures', 'heapBytes',
      ...(diagnostic ? ['boneUpdates', 'boneWorldUpdates', 'hiddenUnitVisits'] : [])];
    const capacity = Math.ceil(config.durationSeconds * 2000);
    const samples = new Float64Array(capacity * columns.length);
    const worldSubmissions: Array<{ rafAtMs: number; sample: unknown }> = [];
    let nextSubmissionCheckpoint = 0;
    let frame = 0;
    // The seed frame is rendered before timing. Every recorded interval ends after the preceding draw.
    render(0, 0, frame++);
    const start = await nextFrame();
    let previous = start, sampleCount = 0;
    recording = true;
    performance.mark('bench-start');
    try {
      while (previous - start < config.durationSeconds * 1000) {
        const now = await nextFrame();
        const seconds = (now - start) / 1000;
        const at = performance.now();
        if (diagnostic) { counters.boneUpdates = 0; counters.boneWorldUpdates = 0; counters.hiddenUnitVisits = 0; }
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
      hardware: hardware(), readiness: readiness(), routeHeightMissing,
      telemetry: world?.telemetry ?? null, ...(diagnostic ? { worldSubmissions } : {}) };
  },
  async view(fraction) {
    await settle(fraction);
    reset();
    for (let frame = 0; frame <= 60; frame++) {
      await nextFrame(); render(fraction * config.durationSeconds, frame === 0 ? 0 : 1 / 60, frame);
    }
    // Serialize pixels in the same task as the draw, before the compositor clears the drawing buffer.
    return { png: canvas.toDataURL('image/png'), readiness: readiness() };
  },
  state: () => ({ scenario, fraction: lastFraction, frame: lastFrame, readiness: readiness() }),
};
