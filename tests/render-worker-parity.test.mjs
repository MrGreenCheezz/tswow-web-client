// 22.10 ARC-2 live fix — the owner's two freeze recordings (with and without `?renderworker=1`): the worker's renderer
// must end up with the graphics state the in-page one gets from the same settings, a DPR the page pushes must move the
// worker's pixel ratio as the page's settings apply moves the in-page one, and the FPS line must not show the
// interface's rate as the world's.
import assert from "node:assert/strict";
import test from "node:test";
import { RenderWorkerClient } from "../dist/code/browser/RenderWorkerClient.js";
import { applyRenderCommand } from "../dist/code/browser/RenderWorkerCommands.js";
import { applyRendererGraphicsSettings } from "../dist/code/browser/RendererGraphicsSettings.js";
import { RenderWorkerSession } from "../dist/code/browser/RenderWorkerSession.js";
import { WorkerRenderHost } from "../dist/code/browser/WorkerRenderHost.js";
import { fpsCounterText } from "../dist/code/browser/ui/FpsCounterText.js";

/** The graphics half of the owner's settings in both recordings of 22.10 (identical there). */
const OWNER = {
  renderScale: 100, autoQuality: false, lightingQuality: 2, wmoOcclusion: true, characterAtlasAnisotropy: true,
  experimentalAerialHeightFog: true, experimentalTerrainMicroNormals: true, experimentalWaterFresnel: true,
  experimentalWaterMicroWaves: true, experimentalWaterSunSparkle: true, experimentalWaterFoam: true,
  experimentalVegetationWind: true, experimentalWindGusts: true, experimentalRainStreaks: true,
  experimentalRainSplashes: true, experimentalWetSurfaces: true, experimentalLightning: true,
  experimentalAmbientMotes: true, experimentalWeatherSounds: true, underwaterOverlay: true, fullscreenGlow: true,
  godRays: true, godRayStrength: 175, experimentalFantasyGlow: true, experimentalCinematicGrade: true,
  cinematicStrength: 150, experimentalCinematicBloom: true, experimentalSunScattering: true,
  experimentalAmbientOcclusion: true, experimentalLowSunRimLight: true, experimentalWaterSunGlitter: true,
  experimentalWaterSkyReflection: true, experimentalSceneryShadows: true, objectDistance: 150, grassRadius: 140,
  grassDense: true, grassDensity: 4,
};

/** A renderer that keeps each setter's last arguments: the state the calls leave it in. */
function stateRecorder() {
  const state = new Map();
  const calls = [];
  const target = new Proxy({}, {
    get(_, method) {
      if (method === "then") return undefined;
      return (...args) => { calls.push(method); state.set(method, args); return undefined; };
    },
  });
  return { state, calls, target };
}

function proxyOnto(renderer, cover) {
  const tasks = [];
  const port = { postMessage(message) {
    for (const command of structuredClone(message).commands ?? []) {
      applyRenderCommand(renderer, command, (present) => present ? cover : undefined);
    }
  } };
  const steps = new Proxy({}, { get: () => () => {} });
  const proxy = new RenderWorkerClient(port, { clientsUrl: () => "ws://127.0.0.1:8090/auth", steps,
    queueTask: (run) => tasks.push(run) });
  return { proxy, flush: () => { for (const task of tasks.splice(0)) task(); } };
}

test("the owner's settings leave the worker's renderer in the in-page renderer's state, through a world's life", () => {
  const pageCover = { page: true }, workerCover = { worker: true };
  const direct = stateRecorder();
  const forwarded = stateRecorder();
  const { proxy, flush } = proxyOnto(forwarded.target, workerCover);
  const both = (run) => { run(direct.target, workerCover); run(proxy, pageCover); flush(); };
  // Settings before a world, the realm's end, the world's entry, then the repeats every settings change makes.
  both((renderer) => applyRendererGraphicsSettings(renderer, OWNER, undefined));
  both((renderer) => { renderer.clearTerrain(); renderer.clearWorldResources(); renderer.setGroundCover(undefined); });
  for (let apply = 0; apply < 3; apply++) both((renderer, cover) => applyRendererGraphicsSettings(renderer, OWNER, cover));
  assert.deepEqual(forwarded.state, structuredClone(direct.state));
  assert.deepEqual(forwarded.state.get("setGodRayStrength"), [1.75]);
  assert.deepEqual(forwarded.state.get("setCinematicStrength"), [1.5]);
  assert.deepEqual(forwarded.state.get("setGroundCover"), [workerCover, 140, true, 4]);
  assert.ok(forwarded.calls.length < direct.calls.length, "repeats are not sent");
});

test("a DPR the page pushes re-derives the worker's pixel ratio from the render scale, as a settings apply does", () => {
  const renderer = stateRecorder();
  const host = new WorkerRenderHost({ devicePixelRatio: 1, cssWidth: 800, cssHeight: 600, query: "", pageHidden: false },
    undefined);
  const session = new RenderWorkerSession({ postMessage() {}, requestAnimationFrame: () => 0 }, host, renderer.target);
  session.handle({ type: "commands", commands: [{ method: "setRenderScale", args: [0.75] }] });
  renderer.calls.length = 0;
  session.handle({ type: "host", host: { devicePixelRatio: 1, cssWidth: 900, cssHeight: 600, query: "", pageHidden: false } });
  assert.deepEqual(renderer.calls, [], "a resize alone is the renderer's own observer's business");
  session.handle({ type: "host", host: { devicePixelRatio: 0.9, cssWidth: 900, cssHeight: 600, query: "", pageHidden: false } });
  assert.deepEqual(renderer.calls, ["setRenderScale"]);
  assert.deepEqual(renderer.state.get("setRenderScale"), [0.75]);
  assert.equal(host.devicePixelRatio(), 0.9);
});

test("the FPS line names the world's rate when a worker draws it", () => {
  assert.equal(fpsCounterText(59.6, 16.7, 18.2), "60 FPS · кадр 16.7 мс · макс. 18.2 мс");
  assert.equal(fpsCounterText(59.9, 16.7, 18.2, 50.6), "мир 51 FPS · интерфейс 60 FPS · кадр 16.7 мс · макс. 18.2 мс");
});
