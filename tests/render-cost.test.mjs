import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  FRAME_WINDOW, FrameCadenceClock, FrameClock, FullFrameClock, LONG_FRAME_THRESHOLD_MS,
  makeRenderTelemetrySnapshot, makeRendererTelemetrySnapshot,
  RESELECT_DISTANCE, shouldReselect,
} from "../dist/code/browser/RenderStats.js";
import {
  instanceCapacity, instanceable, instanceableBuild, placeEnvironmentNode, ADT_MODEL_TO_SCENE,
} from "../dist/code/browser/WorldRenderer3D.js";
import { buildModel } from "../dist/code/browser/ModelBuild.js";

test("the frame clock reports work duration without presenting its reciprocal as real FPS", () => {
  const clock = new FrameClock(100);
  assert.equal(clock.average, 0, "nothing measured is zero and not a division by it");
  assert.equal(clock.worst, 0);

  for (let frame = 0; frame < 95; frame++) clock.add(16);
  for (let frame = 0; frame < 5; frame++) clock.add(80);
  assert.equal(clock.count, 100);
  assert.ok(Math.abs(clock.average - 19.2) < 1e-9, `${clock.average}`);
  // The whole reason the worst frame is reported beside the mean: this run stutters five times a
  // second and its mean says 19 ms, which reads as a comfortable sixty. A ninety-fifth percentile
  // would say 16 here — 95% of these frames really are good — which is why it is the maximum.
  assert.equal(clock.worst, 80);
});

test("frame cadence uses consecutive RAF timestamps and leaves the first frame as a baseline", () => {
  const cadence = new FrameCadenceClock(4);
  assert.equal(cadence.observe(1_000), undefined);
  assert.equal(cadence.fps, 0);
  assert.equal(cadence.observe(1_016), 16);
  assert.equal(cadence.observe(1_034), 18);
  assert.equal(cadence.fps, 1000 / 17);
  cadence.observe(Number.NaN);
  assert.equal(cadence.fps, 1000 / 17);
  cadence.reset();
  assert.equal(cadence.fps, 0);

  const monotonic = new FrameCadenceClock(4);
  assert.equal(monotonic.observe(1_034), undefined);
  assert.equal(monotonic.observe(900), undefined); // Must not replace the valid baseline.
  assert.equal(monotonic.observe(1_050), 16);
  assert.equal(monotonic.fps, 62.5);
});

test("the full-frame clock measures callback work, including throws, but not idle time", () => {
  let time = 100;
  const clock = new FullFrameClock(8, () => time);

  clock.measure(() => { time += 4; });
  time += 1_000; // Time between animation callbacks must not enter the next sample.
  assert.throws(() => clock.measure(() => {
    time += 9;
    throw new Error("frame failed");
  }), /frame failed/);

  assert.deepEqual(clock.snapshot(), {
    count: 2,
    average: 6.5,
    worst: 9,
    longFrames: 0,
    p50: 4,
    p95: 9,
    p99: 9,
  });
});

test("the full-frame clock's stateful path rejects misuse and records failed work", () => {
  let time = 100;
  const clock = new FullFrameClock(8, () => time);

  assert.throws(() => clock.end(), /before begin/);
  clock.begin();
  assert.throws(() => clock.begin(), /while active/);
  time += 12;
  assert.equal(clock.end(), 12);
  assert.equal(clock.snapshot().count, 1);
  assert.equal(clock.snapshot().worst, 12);

  let failedElapsed = 0;
  assert.throws(() => {
    clock.begin();
    try {
      time += 7;
      throw new Error("frame failed");
    } finally {
      // A caller's finally block is what closes the stateful path around a throwing frame.
      failedElapsed = clock.end();
    }
  }, /frame failed/);
  assert.equal(failedElapsed, 7);
  assert.equal(clock.snapshot().count, 2);
  assert.equal(clock.snapshot().worst, 12);
});

test("render telemetry is immutable and keeps renderer counters separate from full-frame CPU", () => {
  const fullFrame = new FrameClock(4);
  fullFrame.add(16);
  const rendererCpu = new FrameClock(4);
  rendererCpu.add(5);
  const renderer = makeRendererTelemetrySnapshot({
    cpu: rendererCpu.snapshot(),
    gpu: { status: "pending", pending: 1, dropped: 2 },
    observedFps: 59.94,
    drawCalls: 7,
    triangles: 1_024,
    unitsDrawn: 12,
    unitsDropped: 3,
    gameObjectsDrawn: 20,
    gameObjectsDropped: 4,
    effectsDrawn: 5,
    effectsDropped: 1,
    groundCoverDrawn: 32,
    groundCoverSelected: 64,
    groundCoverSelectionDroppedCells: 2,
    groundCoverResidentMeshes: 3,
    wmoPortalModels: 2,
    wmoPortalCandidates: 11,
    wmoPortalCulled: 6,
    textureCount: 18,
    geometryCount: 9,
  });
  const resources = {
    terrain: { resident: 1, failed: 2, active: 3, typedPayloadBytes: 4 },
    environment: {
      residentTiles: 5, knownMissingTiles: 6, failedTiles: 7, activeTiles: 8, residentObjects: 9,
      residentModels: 10, knownMissingModels: 11, deferredModels: 12, failedModels: 13,
      queuedModels: 14, activeModels: 15, queuedGroups: 16, activeGroups: 17,
      deferredGroups: 18, failedGroups: 19, residentAnimations: 20, failedAnimations: 21,
      deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 22,
    },
    terrainSplat: { resident: 20, failed: 21, active: 22, decodedLayerBytes: 23, layerRequestEntries: 24 },
    assetWarmup: { accepted: 25, queued: 26, active: 27, closed: false },
  };
  const capture = makeRenderTelemetrySnapshot(1234, fullFrame.snapshot(), renderer, resources);

  assert.equal(capture.capturedAt, 1234);
  assert.equal(capture.fullFrame.average, 16);
  assert.equal(capture.renderer.cpu.average, 5);
  assert.equal(capture.renderer.observedFps, 59.94);
  assert.deepEqual(capture.renderer, renderer);
  assert.deepEqual(capture.resources, resources);
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.fullFrame), true);
  assert.equal(Object.isFrozen(capture.renderer), true);
  assert.equal(Object.isFrozen(capture.renderer.cpu), true);
  assert.equal(Object.isFrozen(capture.renderer.gpu), true);
  assert.equal(Object.isFrozen(capture.resources), true);
  for (const resource of Object.values(capture.resources)) assert.equal(Object.isFrozen(resource), true);
  assert.equal(capture.renderer.textureCount, 18);
  assert.equal(capture.renderer.geometryCount, 9);
  assert.equal(capture.renderer.groundCoverDrawn, 32);
  assert.equal(capture.renderer.groundCoverSelected, 64);
  assert.equal(Object.hasOwn(capture.renderer, "residentBytes"), false,
    "telemetry exposes exact object counts, not guessed byte claims");
  assert.throws(() => { capture.renderer.drawCalls = 99; }, TypeError);
  assert.throws(() => { capture.resources.terrain.resident = 99; }, TypeError);
  assert.throws(() => { capture.resources.environment = undefined; }, TypeError);
  assert.throws(() => { capture.resources = {}; }, TypeError);
});

test("the renderer envelope spans draw entry through dirty portrait readback and restores in finally", async () => {
  const [rendererSource, loopSource] = await Promise.all([
    readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8"),
  ]);
  const beginStart = rendererSource.indexOf("  beginRenderFrame(): void {");
  const endStart = rendererSource.indexOf("  endRenderFrame(): number | undefined {");
  const portraitCleanup = rendererSource.indexOf("  /** Drops all portrait instances", endStart);
  assert.ok(beginStart >= 0 && endStart > beginStart && portraitCleanup > endStart,
    "renderer envelope source boundaries must exist");
  const begin = rendererSource.slice(
    beginStart,
    endStart,
  );
  const end = rendererSource.slice(
    endStart,
    portraitCleanup,
  );
  const drawStart = rendererSource.indexOf("  draw(\n");
  const drawEnd = rendererSource.indexOf("  /**\n   * Lighting quality", drawStart);
  const frameStart = loopSource.indexOf("function frame(now: number): void {");
  const frameEnd = loopSource.indexOf("export function animate(now: number): void {");
  assert.ok(drawStart >= 0 && drawEnd > drawStart && frameStart >= 0 && frameEnd > frameStart,
    "draw/frame source boundaries must exist");
  const draw = rendererSource.slice(drawStart, drawEnd);
  const frame = loopSource.slice(frameStart, frameEnd);
  assert.ok(frame.indexOf("game.renderer?.markFrameNotRendered();") < frame.indexOf("renderer.beginRenderFrame();"),
    "a loading/hidden/throwing pre-render frame clears stale submission counters");

  assert.ok(begin.indexOf("performance.now()") < begin.indexOf("this.#renderer.info.reset()"),
    "CPU timing begins before renderer counter setup and draw entry");
  assert.equal((begin.match(/this\.#renderer\.info\.reset\(\)/g) ?? []).length, 1);
  assert.equal((begin.match(/this\.#gpuTimer\.beginFrame\(\)/g) ?? []).length, 1);
  assert.equal(draw.includes("this.#renderer.info.reset()"), false,
    "the world pass cannot reset away portrait-inclusive counters");
  assert.equal(draw.includes("this.#gpuTimer.beginFrame()"), false,
    "the world pass cannot open a second GPU query");
  assert.equal(end.includes("finally {"), true);
  assert.equal((end.match(/this\.#gpuTimer\.endFrame\(\)/g) ?? []).length, 1);
  assert.ok(end.indexOf("this.#gpuTimer.endFrame()") < end.indexOf("this.#renderer.info.render.calls"));
  assert.ok(end.indexOf("this.#renderer.info.render.calls") < end.indexOf("this.#renderer.info.autoReset ="),
    "counters are read after all passes and before the saved auto-reset mode is restored");

  const envelopeStart = frame.indexOf("renderer.beginRenderFrame();");
  const worldDraw = frame.indexOf("renderer.draw(", envelopeStart);
  const portraits = frame.indexOf("renderer.renderPortraits(now);", worldDraw);
  const envelopeEnd = frame.indexOf("renderer.endRenderFrame();", portraits);
  assert.ok(envelopeStart >= 0 && envelopeStart < worldDraw && worldDraw < portraits && portraits < envelopeEnd);
  assert.equal(frame.slice(portraits, envelopeEnd).includes("} finally {"), true,
    "a throwing world/portrait pass still closes the renderer envelope");
});

test("draw clears per-frame admission counters before a player-less early return", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const resetStart = source.indexOf("  #resetFrameCounters(): void {");
  const resetEnd = source.indexOf("\n  }", resetStart);
  const resets = source.slice(resetStart, resetEnd);
  const drawStart = source.indexOf("  draw(\n");
  const draw = source.slice(drawStart, source.indexOf("    if (wmoFloor", drawStart));
  const playerGuard = draw.indexOf("if (!player?.position)");
  assert.ok(resetStart >= 0 && resetEnd > resetStart && drawStart >= 0 && playerGuard >= 0);
  assert.ok(draw.indexOf("this.#resetFrameCounters();") < playerGuard,
    "draw entry resets counters before its player-less return");
  for (const reset of [
    "this.#drawCalls = 0;", "this.#triangles = 0;", "this.#unitsDrawn = 0;",
    "this.#unitsDropped = 0;", "this.#gameObjectsDrawn = 0;", "this.#gameObjectsDropped = 0;",
    "this.#doodadsPosed = 0;", "this.#effectsDrawn = 0;", "this.#effectsDropped = 0;",
    "this.#groundCoverDrawn = 0;", "this.#wmoPortalModels = 0;",
    "this.#wmoPortalCandidates = 0;", "this.#wmoPortalCulled = 0;", "this.#standIns.idle();",
  ]) {
    assert.equal(resets.includes(reset), true, `${reset} must be part of the shared reset`);
  }
  assert.equal(draw.includes("this.#groundCoverSelected = 0;"), false,
    "selection state may survive, but groundCoverDrawn is the frame-submission count");
});

test("animate re-arms exactly one RAF even when frame work or final telemetry throws", async () => {
  const source = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const animateStart = source.indexOf("export function animate(now: number): void {");
  const animateEnd = source.indexOf("export function startRenderLoop(): void {");
  assert.ok(animateStart >= 0 && animateEnd > animateStart, "animate source boundaries must exist");
  const animate = source.slice(animateStart, animateEnd);
  assert.equal((animate.match(/requestAnimationFrame\(animate\)/g) ?? []).length, 1);
  const clockEnd = animate.indexOf("fullFrameClock.end()");
  const outerFinally = animate.lastIndexOf("} finally {", clockEnd);
  const checkpoint = animate.indexOf("captureRenderTelemetry(now)", clockEnd);
  const raf = animate.indexOf("requestAnimationFrame(animate)", clockEnd);
  assert.ok(outerFinally >= 0 && clockEnd > outerFinally && checkpoint > clockEnd && raf > checkpoint,
    "resource capture is outside the full-frame CPU sample and still precedes RAF re-arm");
  assert.equal(animate.slice(clockEnd, raf).includes("} finally {"), true,
    "RAF scheduling is itself the finally of full-frame finalization");
});

test("render telemetry keeps an immutable empty resources aggregate when clients are absent", () => {
  const fullFrame = new FrameClock(1).snapshot();
  const capture = makeRenderTelemetrySnapshot(7, fullFrame, undefined);
  assert.deepEqual(capture.resources, {});
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.resources), true);
  assert.throws(() => { capture.resources.terrain = {}; }, TypeError);
});

test("the frame snapshot uses nearest-rank percentiles and is immutable", () => {
  const clock = new FrameClock(4);
  clock.add(40);
  clock.add(10);
  clock.add(30);
  clock.add(20);
  clock.add(5); // Wrap the ring: the live window is now 10, 30, 20, 5.

  const snapshot = clock.snapshot();
  assert.deepEqual(snapshot, {
    count: 4,
    average: 16.25,
    worst: 30,
    longFrames: 0,
    p50: 10,
    p95: 30,
    p99: 30,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => { snapshot.p50 = 999; }, TypeError);
});

test("the frame snapshot handles incomplete, one-frame and reset windows", () => {
  const clock = new FrameClock(8);
  clock.add(40);
  clock.add(10);
  clock.add(30);
  assert.deepEqual(clock.snapshot(), {
    count: 3,
    average: 80 / 3,
    worst: 40,
    longFrames: 0,
    p50: 30,
    p95: 40,
    p99: 40,
  });

  const single = new FrameClock(1);
  single.add(17);
  assert.deepEqual(single.snapshot(), {
    count: 1,
    average: 17,
    worst: 17,
    longFrames: 0,
    p50: 17,
    p95: 17,
    p99: 17,
  });

  clock.reset();
  assert.deepEqual(clock.snapshot(), {
    count: 0,
    average: 0,
    worst: 0,
    longFrames: 0,
    p50: 0,
    p95: 0,
    p99: 0,
  });
});

test("the long-frame count uses a strict 50 ms boundary and the live ring window", () => {
  assert.equal(LONG_FRAME_THRESHOLD_MS, 50);
  const clock = new FrameClock(3);
  clock.add(50);
  clock.add(50.001);
  clock.add(75);
  assert.equal(clock.snapshot().longFrames, 2, "exactly 50 ms is not long");

  clock.add(16); // Drops the 50 ms sample; the two long samples remain in the window.
  assert.equal(clock.snapshot().longFrames, 2);
  clock.add(17); // Drops the 50.001 ms sample too.
  assert.equal(clock.snapshot().longFrames, 1);
});

test("the frame window forgets, so a hitch does not haunt the reading forever", () => {
  const clock = new FrameClock(4);
  clock.add(100);
  clock.add(10);
  clock.add(10);
  clock.add(10);
  assert.ok(Math.abs(clock.average - 32.5) < 1e-9);
  // One more frame pushes the hitch out of the window entirely.
  clock.add(10);
  assert.equal(clock.count, 4);
  assert.ok(Math.abs(clock.average - 10) < 1e-9, `${clock.average}`);
  assert.equal(clock.worst, 10);
});

test("a frame time that is not a number is dropped rather than poisoning the mean", () => {
  const clock = new FrameClock(8);
  clock.add(16);
  clock.add(Number.NaN);
  clock.add(Number.POSITIVE_INFINITY);
  clock.add(-5);
  assert.equal(clock.count, 1);
  assert.equal(clock.average, 16);
  assert.deepEqual(clock.snapshot(), {
    count: 1,
    average: 16,
    worst: 16,
    longFrames: 0,
    p50: 16,
    p95: 16,
    p99: 16,
  });
  clock.reset();
  assert.equal(clock.count, 0);
  assert.equal(clock.average, 0);
  assert.equal(FRAME_WINDOW, 120, "two seconds at sixty");
});

test("the environment ranking is not redone for four yards of walking", () => {
  // It costs 1.26 ms a frame in Stormwind at the former 230-yard leash — 42,797 placements ranked
  // from scratch, standing still included. The live leash is 300 yards, but the placement budget
  // remains capped and four yards still cannot change what it picks.
  const at = { x: 100, y: 200, generation: 3 };
  assert.equal(shouldReselect(undefined, { x: 0, y: 0 }, 0), true, "the first frame has no answer yet");
  assert.equal(shouldReselect(at, { x: 100, y: 200 }, 3), false);
  assert.equal(shouldReselect(at, { x: 103, y: 200 }, 3), false);
  assert.equal(shouldReselect(at, { x: 100 + RESELECT_DISTANCE, y: 200 }, 3), true);
  assert.equal(shouldReselect(at, { x: 103, y: 203 }, 3), true, "diagonally is still a distance");
  // A tile landing adds placements, and standing still must not hide them.
  assert.equal(shouldReselect(at, { x: 100, y: 200 }, 4), true);
});

test("a model with emitters is never drawn as an instance", () => {
  // An instance has no object of its own, and `#updateEffects` places a torch's sparks by reading
  // the world matrix of the mesh holding the torch. Instancing one leaves its sparks at the map's
  // origin — visible from anywhere, and nowhere near the torch.
  const plain = { wvm: { particleEmitters: [], ribbonEmitters: [] } };
  assert.equal(instanceable(plain), true);
  assert.equal(instanceable({ wvm: { particleEmitters: [{}], ribbonEmitters: [] } }), false);
  assert.equal(instanceable({ wvm: { particleEmitters: [], ribbonEmitters: [{}] } }), false);
  // A building is drawn a room at a time and has no single mesh to copy.
  assert.equal(instanceable({ ...plain, wmo: {} }), false);
  // A stand-in shape is not the model.
  assert.equal(instanceable(undefined), false);
  assert.equal(instanceable({}), false);
});

test("a doodad with a blended material is not instanced", () => {
  // three sorts transparent *objects*, so a hundred copies that used to be a hundred entries in
  // that sorted list become one and stop being ordered among themselves — a blended doodad drawn
  // in buffer order shows through the one in front of it. Opaque and alpha-tested runs do not
  // care: their order is a hint about overdraw and nothing else.
  const opaque = new THREE.MeshBasicMaterial();
  const blended = new THREE.MeshBasicMaterial({ transparent: true });
  const cutout = new THREE.MeshBasicMaterial({ alphaTest: 224 / 255 });
  assert.equal(instanceableBuild(opaque), true);
  assert.equal(instanceableBuild(blended), false);
  assert.equal(instanceableBuild(cutout), true, "an alpha gate is not transparency");
  assert.equal(instanceableBuild([opaque, cutout]), true);
  assert.equal(instanceableBuild([opaque, blended]), false, "one blended run is enough");
});

test("an instanced draw grows in powers of two and never below two", () => {
  assert.equal(instanceCapacity(1), 2);
  assert.equal(instanceCapacity(2), 2);
  assert.equal(instanceCapacity(3), 4);
  assert.equal(instanceCapacity(4), 4);
  assert.equal(instanceCapacity(5), 8);
  assert.equal(instanceCapacity(24), 32);
  // The measured shape of the problem: inside Stormwind the selection is about 120 placements over
  // 8 to 14 distinct models, so the largest group is tens and not thousands.
  assert.equal(instanceCapacity(120), 128);
});

test("an instance matrix is the placement's own, so a copy stands where its node did", () => {
  // The whole safety of instancing rests on this: nothing is recomputed, the matrix is taken from
  // the mesh that would otherwise have been drawn. If the two ever disagreed, every barrel in
  // Stormwind would move.
  const object = {
    id: 1, kind: "m2", name: "BARRELLOWPOLY.M2",
    x: -8913.25, y: 554.5, z: 93.75,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1.25,
    quaternionX: 0, quaternionY: Math.SQRT1_2, quaternionZ: 0, quaternionW: Math.SQRT1_2,
  };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.quaternion.copy(ADT_MODEL_TO_SCENE);
  const node = placeEnvironmentNode(new THREE.Group(), object);
  node.add(mesh);
  node.matrixAutoUpdate = false;
  node.updateMatrix();
  node.updateMatrixWorld(true);
  const instance = mesh.matrixWorld.clone();

  // The same placement built the ordinary way, drawn with the matrix three would have composed.
  const reference = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  reference.quaternion.copy(ADT_MODEL_TO_SCENE);
  const referenceNode = placeEnvironmentNode(new THREE.Group(), object);
  referenceNode.add(reference);
  referenceNode.updateMatrixWorld(true);
  for (let element = 0; element < 16; element++) {
    assert.ok(Math.abs(instance.elements[element] - reference.matrixWorld.elements[element]) < 1e-9,
      `element ${element}: ${instance.elements[element]} vs ${reference.matrixWorld.elements[element]}`);
  }
});

test("a frozen placement keeps its matrix, and a room hung on it afterwards still lands", () => {
  // Placed scenery stops composing its matrices, which is only safe if two things hold: the frozen
  // node keeps the world matrix it was given, and a child added *after* the freeze still gets one.
  // The second is why buildings were at first exempted — wrongly: `updateMatrixWorld` recurses
  // into children whatever the parent's flags say, so a room hung on a frozen building lands.
  const scene = new THREE.Group();
  const node = placeEnvironmentNode(new THREE.Group(), {
    id: 2, kind: "wmo", name: "Stormwind.wmo",
    x: -8913.25, y: 554.5, z: 93.75,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  });
  scene.add(node);
  node.matrixAutoUpdate = false;
  node.updateMatrix();
  node.updateMatrixWorld(true);
  node.traverse((part) => {
    part.matrixAutoUpdate = false;
    part.matrixWorldAutoUpdate = false;
  });
  const frozen = node.matrixWorld.clone();

  const room = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  room.position.set(1, 2, 3);
  node.add(room);
  // A whole-scene update, which is what every frame does.
  scene.updateMatrixWorld(true);

  for (let element = 0; element < 16; element++) {
    assert.ok(Math.abs(node.matrixWorld.elements[element] - frozen.elements[element]) < 1e-9,
      "the frozen node kept its own placement");
  }
  const expected = new THREE.Vector3(1, 2, 3).applyMatrix4(frozen);
  assert.ok(Math.abs(room.matrixWorld.elements[12] - expected.x) < 1e-6, "the late room is placed");
  assert.ok(Math.abs(room.matrixWorld.elements[13] - expected.y) < 1e-6);
  assert.ok(Math.abs(room.matrixWorld.elements[14] - expected.z) < 1e-6);
});

test("a built model carries a bounding sphere that encloses it, computed once", () => {
  // Without one, three computes it lazily on the first frame the doodad is drawn — a second walk
  // over every vertex, on the worst frame to spend it. It has to enclose, or frustum culling drops
  // the model while part of it is still on screen.
  const positions = new Float32Array([0, 0, 0, 3, 0, 0, 0, 4, 0, -1, -2, 5]);
  const model = {
    positions,
    normals: new Float32Array(positions.length),
    uv0: new Float32Array(positions.length / 3 * 2),
    uv1: new Float32Array(positions.length / 3 * 2),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [{ submesh: 0, textures: [], uvSets: [0, 0], blendMode: 0, materialFlags: 0, renderFlags: 0, priority: 0, uvAnimation: -1, colour: -1, alpha: -1 }],
    textures: [],
    bounds: { min: [-1, -2, 0], max: [3, 4, 5], radius: 1 },
    particleEmitters: [], ribbonEmitters: [],
  };
  const built = buildModel(model, { modelPath: "X.M2", baseUrl: "", loadTexture: () => new THREE.Texture() });
  const sphere = built.geometry.boundingSphere;
  assert.ok(sphere, "the sphere is supplied rather than left to be computed later");
  const point = new THREE.Vector3();
  for (let index = 0; index < positions.length; index += 3) {
    point.set(positions[index], positions[index + 1], positions[index + 2]);
    assert.ok(sphere.containsPoint(point), `vertex ${index / 3} is outside the sphere`);
  }
  // And the file's own radius of 1 is nowhere near enough to hold it, which is why the box is used.
  assert.ok(sphere.radius > 1);
});
