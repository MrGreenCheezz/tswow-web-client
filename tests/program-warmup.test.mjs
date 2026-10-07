import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as THREE from "three";
import { disposeSkinnedInstance } from "../dist/code/browser/AnimatedModel.js";
import { disposeModelPlacementTintMaterials } from "../dist/code/browser/ModelPlacementTint.js";
import { dropDeathFade } from "../dist/code/browser/BatchDeathFade.js"; // 05.10 suite-fix: #clearUnitNode calls it since 05.10-A7a-F1
import { detachGlowAnchors } from "../dist/code/browser/WeaponGlow.js"; // 05.10 suite-fix: #disposeAttachedGlow calls it since 05.10-A7a-E
import {
  PROGRAM_WARMUP_BATCH, PROGRAM_WARMUP_BUDGET_MS, ProgramWarmup, programWarmupKind, programWarmupProxy,
} from "../dist/code/browser/ProgramWarmup.js";

/**
 * Runs `body` with `performance.now` on a clock that each `renderer.compile` call advances by
 * `clock.cost` milliseconds, so the warm pass's frame budget is exercised deterministically.
 */
function withCompileClock(renderer, cost, body) {
  const clock = { now: 1000, cost };
  const realNow = performance.now;
  const compile = renderer.compile;
  performance.now = () => clock.now;
  renderer.compile = (...args) => {
    clock.now += clock.cost;
    return compile.apply(renderer, args);
  };
  try {
    return body(clock);
  } finally {
    performance.now = realNow;
    renderer.compile = compile;
  }
}

/**
 * A renderer stand-in: `compile` collects the materials it is shown, exactly the way three's own
 * does, and records the scene it was given so the fog/environment mirroring can be asserted.
 */
function fakeRenderer({ ready = true, parallel = true } = {}) {
  const calls = [];
  const byMaterial = new Map();
  const state = { ready };
  return {
    calls,
    byMaterial,
    state,
    extensions: { has: (name) => parallel && name === "KHR_parallel_shader_compile" },
    properties: { get: (material) => ({ currentProgram: byMaterial.get(material) }) },
    compile(scene, camera, targetScene) {
      const objects = [];
      calls.push({ scene, camera, targetScene, objects });
      const materials = new Set();
      scene.traverse((object) => {
        if (!object.material) return;
        objects.push(object);
        for (const entry of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(entry);
          if (!byMaterial.has(entry)) {
            byMaterial.set(entry, {
              program: {},
              isReady: () => state.ready,
              uniformFetches: 0,
              getUniforms() {
                this.uniformFetches++;
              },
            });
          }
        }
      });
      return materials;
    },
  };
}

function targetScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x112233, 10, 200);
  return scene;
}

test("the warm-up mirrors the object classes three compiles separate programs for", () => {
  const material = new THREE.MeshBasicMaterial();
  const geometry = new THREE.BufferGeometry();
  assert.equal(programWarmupKind(new THREE.Mesh(geometry, material)), "mesh");
  assert.equal(programWarmupKind(new THREE.SkinnedMesh(geometry, material)), "skinned");
  assert.equal(programWarmupKind(new THREE.InstancedMesh(geometry, material, 1)), "instanced");
  const instanced = new THREE.InstancedMesh(geometry, material, 1);
  instanced.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
  assert.equal(programWarmupKind(instanced), "instanced-colour");
  assert.equal(programWarmupKind(new THREE.Group()), undefined);

  const skinned = new THREE.SkinnedMesh(geometry, material);
  const proxy = programWarmupProxy(skinned, geometry, material, "skinned");
  assert.equal(proxy.isSkinnedMesh, true);
  assert.equal(proxy.geometry, geometry, "the stand-in shares the geometry three reads attributes from");
  assert.equal(proxy.material, material, "and the material whose program is being compiled");
});

test("a registered object is compiled once, against the world scene's own lights and fog", () => {
  const renderer = fakeRenderer();
  const target = targetScene();
  const warmup = new ProgramWarmup(renderer, target);
  const material = new THREE.MeshStandardMaterial();
  const node = new THREE.Mesh(new THREE.BufferGeometry(), material);
  warmup.registerObject(node);
  assert.equal(warmup.queued, 1);
  assert.equal(renderer.calls.length, 0, "registration only parks the object");

  const camera = new THREE.PerspectiveCamera();
  warmup.tick(camera);
  assert.equal(renderer.calls.length, 1);
  // A light view of the world scene (`programWarmupLightView`): the scene is its prototype, so its
  // lights, shadows and fog are the world's, and compile does not walk the whole world for them.
  assert.equal(Object.getPrototypeOf(renderer.calls[0].targetScene), target,
    "lights and shadows come from the world scene");
  assert.equal(renderer.calls[0].targetScene.fog, target.fog);
  assert.equal(renderer.calls[0].scene.fog, target.fog, "fog decides USE_FOG in the program key");
  assert.equal(warmup.programs, 1);
  assert.equal(warmup.queued, 0);

  warmup.tick(camera);
  assert.equal(renderer.calls.length, 1, "the same material is never parked twice");

  // A profile change moves the material's program cache key, which is a different variant.
  material.customProgramCacheKey = () => "changed";
  warmup.registerObject(node);
  warmup.tick(camera);
  assert.equal(renderer.calls.length, 2, "a changed key is a variant that has to be compiled again");
});

test("a costly burst is spread over frames and the driver's link is not waited on", () => {
  const renderer = fakeRenderer({ ready: false });
  const warmup = new ProgramWarmup(renderer, targetScene());
  const camera = new THREE.PerspectiveCamera();
  const materials = [];
  for (let index = 0; index < PROGRAM_WARMUP_BATCH + 2; index++) {
    materials.push(new THREE.MeshBasicMaterial());
  }
  warmup.registerObject(new THREE.Group().add(
    ...materials.map((material) => new THREE.Mesh(new THREE.BufferGeometry(), material)),
  ));
  assert.equal(warmup.queued, PROGRAM_WARMUP_BATCH + 2);
  // A batch that spends the whole frame budget (new programs to assemble) is the last one this frame.
  withCompileClock(renderer, PROGRAM_WARMUP_BUDGET_MS, () => {
    warmup.tick(camera);
    assert.equal(renderer.calls.length, 1);
    assert.equal(warmup.programs, PROGRAM_WARMUP_BATCH, "one batch when it used up the frame");
    assert.equal(warmup.uniformLocations, 0, "an unfinished program is not queried for its uniforms");
    assert.equal(warmup.queued, 2);

    warmup.tick(camera);
    assert.equal(warmup.programs, PROGRAM_WARMUP_BATCH + 2);
    assert.equal(warmup.queued, 0);
  });

  renderer.state.ready = true;
  warmup.tick(camera);
  assert.equal(warmup.uniformLocations, PROGRAM_WARMUP_BATCH + 2,
    "uniform locations are fetched once the driver reports the program ready");
});

test("cheap batches keep going within the frame budget, so a long queue drains in a few frames", () => {
  const renderer = fakeRenderer({ ready: false });
  const warmup = new ProgramWarmup(renderer, targetScene());
  const camera = new THREE.PerspectiveCamera();
  const count = PROGRAM_WARMUP_BATCH * 10;
  warmup.registerObject(new THREE.Group().add(...Array.from({ length: count },
    () => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()))));
  const perBatch = PROGRAM_WARMUP_BUDGET_MS / 5;
  withCompileClock(renderer, perBatch, () => warmup.tick(camera));
  // Batches start while less than the budget is spent: at 0, 1/5, 2/5, 3/5 and 4/5 of it.
  assert.equal(renderer.calls.length, 5, "five cheap batches fit in one frame");
  assert.equal(warmup.queued, count - PROGRAM_WARMUP_BATCH * 5);
  withCompileClock(renderer, perBatch, () => warmup.tick(camera));
  assert.equal(warmup.queued, 0, "forty variants in two frames, not ten");
});

test("unit registrations are compiled before scenery that was queued ahead of them", () => {
  const renderer = fakeRenderer({ ready: false });
  const warmup = new ProgramWarmup(renderer, targetScene());
  const camera = new THREE.PerspectiveCamera();
  const scenery = Array.from({ length: PROGRAM_WARMUP_BATCH * 3 }, () => new THREE.MeshBasicMaterial());
  warmup.registerObject(new THREE.Group().add(
    ...scenery.map((material) => new THREE.Mesh(new THREE.BufferGeometry(), material))));
  const unit = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
  warmup.registerObject(new THREE.Group().add(
    ...unit.map((material) => new THREE.SkinnedMesh(new THREE.BufferGeometry(), material))), "unit");
  withCompileClock(renderer, PROGRAM_WARMUP_BUDGET_MS, () => warmup.tick(camera));
  const first = renderer.calls[0].objects.map((object) => object.material);
  assert.equal(first.length, PROGRAM_WARMUP_BATCH);
  assert.equal(first.filter((material) => material.isMeshStandardMaterial).length, unit.length,
    "the unit's variants lead the first batch although they were registered last");
  assert.equal(warmup.queued, scenery.length + unit.length - PROGRAM_WARMUP_BATCH);
});

test("a shader chain that refuses to answer is counted, not thrown", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, targetScene());
  const material = new THREE.MeshBasicMaterial();
  material.customProgramCacheKey = () => {
    throw new Error("profile not applied yet");
  };
  warmup.registerObject(new THREE.Mesh(new THREE.BufferGeometry(), material));
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(warmup.programs, 1, "the program is still warmed under the fallback key");
  assert.equal(warmup.failures, 0);
});

test("a destroyed program leaves the linking queue without querying a deleted WebGL handle", () => {
  const renderer = fakeRenderer({ ready: false });
  const warmup = new ProgramWarmup(renderer, targetScene());
  const material = new THREE.MeshBasicMaterial(), camera = new THREE.PerspectiveCamera();
  warmup.registerObject(new THREE.Mesh(new THREE.BufferGeometry(), material));
  warmup.tick(camera);
  const program = renderer.byMaterial.get(renderer.calls[0].objects[0].material);
  // Three's WebGLProgram.destroy clears this handle. A query need not throw: WebGL can return null.
  program.program = undefined;
  let queries = 0;
  program.isReady = () => { queries++; return null; };
  for (let i = 0; i < 4; i++) warmup.tick(camera);
  assert.equal(queries, 0, "destroyed programs must not be polled or retained across ticks");
  assert.equal(warmup.uniformLocations, 0);
  renderer.state.ready = true;
  warmup.registerObject(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
  warmup.tick(camera);
  warmup.tick(camera);
  assert.equal(warmup.uniformLocations, 1, "surviving programs still settle normally");

  const invalid = new THREE.MeshBasicMaterial();
  warmup.registerObject(new THREE.Mesh(new THREE.BufferGeometry(), invalid));
  warmup.tick(camera);
  let invalidQueries = 0;
  renderer.byMaterial.get(renderer.calls.at(-1).objects[0].material).isReady = () => { invalidQueries++; return null; };
  for (let i = 0; i < 4; i++) warmup.tick(camera);
  assert.equal(invalidQueries, 1, "a lost handle returning null is dropped after its first answer");
  assert.equal(warmup.uniformLocations, 1);
});

test("a material without a mesh is warmed for its own class", () => {
  const geometry = new THREE.BufferGeometry();
  const fullscreen = new THREE.ShaderMaterial();
  const instanced = new THREE.MeshBasicMaterial();

  const plain = new ProgramWarmup(fakeRenderer(), targetScene());
  plain.registerMaterial(fullscreen, geometry);
  plain.tick(new THREE.PerspectiveCamera());
  assert.equal(plain.programs, 1, "a full-screen pass is one plain draw");

  const renderer = fakeRenderer();
  const batched = new ProgramWarmup(renderer, targetScene());
  batched.registerMaterial(instanced, geometry, "instanced");
  batched.tick(new THREE.PerspectiveCamera());
  const proxy = renderer.calls[0].objects[0];
  assert.equal(proxy.isInstancedMesh, true, "the stand-in still carries the class switch");
});


test("removing terrain drops queued borrowers and permits a surviving shared material to warm again", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, targetScene());
  const material = new THREE.MeshLambertMaterial();
  const removed = new THREE.Mesh(new THREE.BufferGeometry(), material);
  const survivor = new THREE.Mesh(new THREE.BufferGeometry(), material);
  const other = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial());
  warmup.registerObject(removed);
  warmup.registerObject(other);
  assert.equal(warmup.queued, 2);
  warmup.unregisterObject(new THREE.Group().add(removed));
  removed.geometry.dispose();
  assert.equal(warmup.queued, 1);
  warmup.registerObject(survivor);
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(renderer.calls[0].objects.length, 2);
  assert.ok(renderer.calls[0].objects.every(proxy => proxy.geometry !== removed.geometry));
  assert.ok(renderer.calls[0].objects.some(proxy => proxy.geometry === survivor.geometry));
});

test("unregistering one mesh preserves a different material on shared geometry", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, targetScene());
  const geometry = new THREE.BufferGeometry();
  const removed = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const survivor = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial());
  warmup.registerObject(removed);
  warmup.registerObject(survivor);
  warmup.unregisterObject(removed);
  assert.equal(warmup.queued, 1);
  warmup.tick(new THREE.PerspectiveCamera());
  assert.deepEqual(renderer.calls[0].objects.map((object) => object.material.type), [survivor.material.type]);
  assert.notEqual(renderer.calls[0].objects[0].material, survivor.material,
    "the compiled owner must outlive disposal of the source material");
});

test("unregistering one borrower preserves a deduplicated live material", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, targetScene());
  const material = new THREE.MeshBasicMaterial();
  const removed = new THREE.Mesh(new THREE.BufferGeometry(), material);
  const survivor = new THREE.Mesh(new THREE.BufferGeometry(), material);
  warmup.registerObject(removed);
  warmup.registerObject(survivor);
  assert.equal(warmup.queued, 1);
  warmup.unregisterObject(removed);
  assert.equal(warmup.queued, 1);
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(renderer.calls[0].objects[0].geometry, survivor.geometry);
});

test("disposed queued resources are dropped without compiling them", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, targetScene());
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial();
  warmup.registerObject(new THREE.Mesh(geometry, material));
  geometry.dispose();
  assert.equal(warmup.queued, 0);
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(renderer.calls.length, 0);

  const next = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  warmup.registerObject(next);
  next.material.dispose();
  assert.equal(warmup.queued, 0);
});

test("failed compilation can be retried on a later registration", () => {
  const renderer = fakeRenderer();
  const compile = renderer.compile.bind(renderer);
  let fail = true;
  renderer.compile = (...args) => {
    if (fail) throw new Error("driver unavailable");
    return compile(...args);
  };
  const warmup = new ProgramWarmup(renderer, targetScene());
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  warmup.registerObject(mesh);
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(warmup.failures, 1);
  fail = false;
  warmup.registerObject(mesh);
  assert.equal(warmup.queued, 1);
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(warmup.programs, 1);
});

test("reset permits a queued variant to be registered again", () => {
  const warmup = new ProgramWarmup(fakeRenderer(), targetScene());
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  warmup.registerObject(mesh);
  warmup.reset();
  warmup.registerObject(mesh);
  assert.equal(warmup.queued, 1);
});

test("material version changes request a new warmup variant", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, targetScene());
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  const camera = new THREE.PerspectiveCamera();
  warmup.registerObject(mesh);
  warmup.tick(camera);
  material.map = new THREE.Texture();
  material.needsUpdate = true;
  warmup.registerObject(mesh);
  assert.equal(warmup.queued, 1);
  warmup.tick(camera);
  assert.equal(renderer.calls.length, 2);
});

test("queued dispose listeners are removed on compile, cancellation and reset", () => {
  const warmup = new ProgramWarmup(fakeRenderer(), targetScene());
  const mesh = () => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  const disposeListeners = (resource) => resource._listeners?.dispose?.length ?? 0;
  const compiled = mesh();
  warmup.registerObject(compiled);
  assert.equal(disposeListeners(compiled.geometry), 1);
  assert.equal(disposeListeners(compiled.material), 1);
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(disposeListeners(compiled.geometry), 0);
  assert.equal(disposeListeners(compiled.material), 0);

  const cancelled = mesh();
  warmup.registerObject(cancelled);
  warmup.unregisterObject(cancelled);
  assert.equal(disposeListeners(cancelled.geometry), 0);
  assert.equal(disposeListeners(cancelled.material), 0);

  const reset = mesh();
  warmup.registerObject(reset);
  warmup.reset();
  assert.equal(disposeListeners(reset.geometry), 0);
  assert.equal(disposeListeners(reset.material), 0);
});

test("new weather enters shader warmup before its first world submission", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const draw = source.slice(source.indexOf("  draw(\n"), source.indexOf("\n  #resetFrameCounters(): void {"));
  const weather = draw.indexOf("this.#updateWeather(elapsed);");
  const warmup = draw.indexOf("this.#programWarmup.tick(this.#camera);");
  const submit = draw.indexOf("this.#renderer.render(this.#scene, this.#camera);");
  assert.ok(weather >= 0 && warmup > weather && submit > warmup,
    "weather construction must precede warmup and its first visible submission");
});

test("renderer detach paths cancel queued borrowers while shared builds remain cached", async () => {
  // Execute the real teardown methods with lightweight scene state, without a browser renderer.
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("WorldRenderer3D.ts", source, ts.ScriptTarget.ES2022, true);
  const declaration = parsed.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === "WorldRenderer3D");
  const names = ["#disposeEnvironment", "#disposeGameObject", "#clearUnitNode", "#clearWmoGroups",
    "#disposeAttachedGlow", "#detachAll", "#dropMount"];
  const methods = names.map(name => declaration.members.find(m => m.name?.getText(parsed) === name)
    .getText(parsed).replaceAll("#", ""));
  const js = ts.transpileModule(`class Harness { ${methods.join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const Harness = Function("disposeSkinnedInstance", "disposeModelPlacementTintMaterials", "dropDeathFade", "detachGlowAnchors", js + "; return Harness;")(
    disposeSkinnedInstance, disposeModelPlacementTintMaterials, dropDeathFade, detachGlowAnchors);

  for (const path of ["environment", "gameObject", "unit", "wmo", "attachments", "mount"]) {
    const renderer = fakeRenderer(), warmup = new ProgramWarmup(renderer, targetScene());
    const geometry = new THREE.BufferGeometry(), material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material), node = new THREE.Group().add(mesh);
    const scene = new THREE.Group().add(node);
    let disposed = 0;
    geometry.addEventListener("dispose", () => disposed++);
    material.addEventListener("dispose", () => disposed++);
    warmup.registerObject(node);
    const harness = Object.assign(new Harness(), { programWarmup: warmup, environmentGroup: scene,
      gameObjectGroup: scene, dropWmoLiquid() {}, releaseUnitOpacity() {}, clearOverlay() {}, showCapsule() {} });
    if (path === "environment") harness.disposeEnvironment({ node });
    if (path === "gameObject") harness.disposeGameObject({ node });
    if (path === "unit") harness.clearUnitNode({ node, attached: new Map() });
    // P1-12b: a leaving room touches its geometry entry in the built-model cache.
    if (path === "wmo") {
      harness.wmoGeometries = new Map();
      harness.clearWmoGroups({ built: new Map([[0, { mesh, entry: { cacheKey: "room" } }]]) }, node);
    }
    if (path === "attachments") harness.detachAll({ attached: new Map([["hand", node]]) });
    if (path === "mount") harness.dropMount({ node: scene, mount: { node } });
    assert.equal(warmup.queued, 0, `${path}: detached cached meshes must not be compiled`);
    assert.equal(disposed, 0, `${path}: shared cache resources remain alive`);
    warmup.tick(new THREE.PerspectiveCamera());
    assert.equal(renderer.calls.length, 0);
    warmup.registerObject(new THREE.Mesh(geometry, material));
    warmup.tick(new THREE.PerspectiveCamera());
    assert.equal(renderer.calls.length, 1, `${path}: a new visible owner still warms`);
  }
});


test("shared material keeps RGB and RGBA geometry variants in the same warm batch", () => {
  const renderer = fakeRenderer(), warmup = new ProgramWarmup(renderer, targetScene());
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true });
  const rgb = new THREE.BoxGeometry(), rgba = rgb.clone();
  rgb.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(rgb.attributes.position.count * 3), 3));
  rgba.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(rgba.attributes.position.count * 4), 4));
  warmup.registerObject(new THREE.Group().add(new THREE.Mesh(rgb, material), new THREE.Mesh(rgba, material)));
  assert.equal(warmup.queued, 2, "vertex alpha changes the actual shader even when the material is shared");
  warmup.tick(new THREE.PerspectiveCamera());
  assert.deepEqual(renderer.calls[0].objects.map(o => o.geometry.attributes.color.itemSize), [3, 4]);
  warmup.registerObject(new THREE.Mesh(rgb.clone(), material));
  assert.equal(warmup.queued, 0, "an equivalent geometry layout still deduplicates without retaining geometry identities");
});

test("every linked variant of a material settles, including both transparent sides", () => {
  const renderer = fakeRenderer(), warmup = new ProgramWarmup(renderer, targetScene());
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true });
  const programs = [0, 1].map(() => ({ program: {}, isReady: () => true,
    uniformFetches: 0, getUniforms() { this.uniformFetches++; } }));
  renderer.properties.get = () => ({ currentProgram: programs[1], programs: new Map([["back", programs[0]], ["front", programs[1]]]) });
  warmup.registerObject(new THREE.Mesh(new THREE.BoxGeometry(), material));
  warmup.tick(new THREE.PerspectiveCamera());
  warmup.tick(new THREE.PerspectiveCamera());
  assert.deepEqual(programs.map(p => p.uniformFetches), [1, 1], "currentProgram alone misses the back-side variant");
  const another = material.clone();
  warmup.registerObject(new THREE.Mesh(new THREE.BoxGeometry(), another));
  warmup.tick(new THREE.PerspectiveCamera());
  warmup.tick(new THREE.PerspectiveCamera());
  assert.deepEqual(programs.map(p => p.uniformFetches), [1, 1], "a program shared by materials settles only once");
  assert.equal(warmup.programs, 2);
  assert.equal(warmup.uniformLocations, 2);
});
