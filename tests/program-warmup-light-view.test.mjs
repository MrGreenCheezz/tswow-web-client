import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ProgramWarmup, programWarmupLightView } from "../dist/code/browser/ProgramWarmup.js";

/**
 * A WebGL2 context on which every call succeeds and draws nothing, so the real three r185
 * `WebGLRenderer` runs its whole program path — parameters, cache keys, `onBeforeCompile`,
 * `acquireProgram` — and `renderer.info.programs` lists every program a compile or a draw linked.
 */
function fakeRenderer() {
  const numbers = new Map();
  const names = new Map();
  let next = 0x10000;
  const constant = (name) => {
    if (!numbers.has(name)) {
      numbers.set(name, next);
      names.set(next, name);
      next++;
    }
    return numbers.get(name);
  };
  const parameters = {
    VERSION: "WebGL 2.0", SHADING_LANGUAGE_VERSION: "WebGL GLSL ES 3.00",
    MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
    MAX_TEXTURE_SIZE: 4096, MAX_CUBE_MAP_TEXTURE_SIZE: 4096, MAX_VERTEX_ATTRIBS: 16,
    MAX_VERTEX_UNIFORM_VECTORS: 1024, MAX_VARYING_VECTORS: 30, MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
    MAX_SAMPLES: 4, MAX_3D_TEXTURE_SIZE: 2048, MAX_ARRAY_TEXTURE_LAYERS: 2048, MAX_RENDERBUFFER_SIZE: 4096,
    MAX_DRAW_BUFFERS: 8, MAX_COLOR_ATTACHMENTS: 8, MAX_UNIFORM_BUFFER_BINDINGS: 72,
  };
  let serial = 0;
  const handle = () => ({ id: ++serial });
  const methods = {
    getContextAttributes: () => ({ alpha: true, antialias: false, depth: true, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false }),
    isContextLost: () => false,
    getError: () => 0,
    getSupportedExtensions: () => ["EXT_color_buffer_float", "KHR_parallel_shader_compile"],
    getExtension: (name) => name === "KHR_parallel_shader_compile"
      ? { COMPLETION_STATUS_KHR: constant("COMPLETION_STATUS_KHR") }
      : name === "EXT_color_buffer_float" ? {} : null,
    getParameter: (pname) => {
      const name = names.get(pname);
      if (name === "VIEWPORT" || name === "SCISSOR_BOX") return new Int32Array([0, 0, 64, 64]);
      return parameters[name] ?? 0;
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getProgramParameter: (_program, pname) => (["ACTIVE_UNIFORMS", "ACTIVE_ATTRIBUTES", "ACTIVE_UNIFORM_BLOCKS"]
      .includes(names.get(pname)) ? 0 : true),
    getShaderParameter: () => true,
    getProgramInfoLog: () => "",
    getShaderInfoLog: () => "",
    checkFramebufferStatus: () => 0x8CD5,
    getUniformLocation: handle,
    getAttribLocation: () => -1,
    createBuffer: handle, createTexture: handle, createFramebuffer: handle, createRenderbuffer: handle,
    createVertexArray: handle, createProgram: handle, createShader: handle, createQuery: handle,
    fenceSync: handle,
  };
  const store = new Map();
  const canvas = { width: 64, height: 64, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {} };
  const gl = new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (property in methods) return methods[property];
      if (property === "canvas") return canvas;
      if (property === "drawingBufferWidth" || property === "drawingBufferHeight") return 64;
      if (store.has(property)) return store.get(property);
      if (/^[A-Z0-9_]+$/.test(property)) return constant(property);
      return () => undefined;
    },
    set(_target, property, value) {
      store.set(property, value);
      return true;
    },
  });
  canvas.getContext = () => gl;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.shadowMap.enabled = true;
  return renderer;
}

/** The world scene's shape: fog, the sun and two shadow cascades at the root, lots of scenery. */
function world({ cascades = 2, scenery = 3000 } = {}) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8899aa, 180, 640);
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.castShadow = true;
  scene.add(sun, sun.target);
  for (let index = 0; index < cascades; index++) {
    const light = new THREE.DirectionalLight(0xffffff, 0);
    light.castShadow = true;
    scene.add(light);
  }
  const group = new THREE.Group();
  for (let index = 0; index < scenery; index++) group.add(new THREE.Object3D());
  scene.add(group);
  return scene;
}

/** One object of every program class a unit or a doodad brings; the eligible ones cast. */
function content() {
  const map = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const skin = new THREE.BoxGeometry(1, 1, 1);
  const vertices = skin.getAttribute("position").count;
  skin.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(vertices * 4), 4));
  skin.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(vertices * 4).fill(0.25), 4));
  const skinned = new THREE.SkinnedMesh(skin, new THREE.MeshStandardMaterial({ map }));
  const bone = new THREE.Bone();
  skinned.add(bone);
  skinned.bind(new THREE.Skeleton([bone]));
  const objects = [
    new THREE.Mesh(box, new THREE.MeshStandardMaterial({ map })),
    new THREE.Mesh(box, new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide })),
    new THREE.Mesh(box, new THREE.MeshStandardMaterial({ map, transparent: true, side: THREE.DoubleSide })),
    new THREE.Mesh(box, new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false })),
    skinned,
    new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ map }), 4),
  ];
  for (const object of objects) {
    const material = object.material;
    // The renderer's own caster policy: lit, opaque, normally blended, depth-writing.
    object.castShadow = material.isMeshStandardMaterial && !material.transparent
      && material.blending === THREE.NormalBlending && material.depthWrite;
    object.receiveShadow = true;
    object.frustumCulled = false;
  }
  return objects;
}

function camera() {
  const value = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  value.position.set(0, 2, 8);
  return value;
}

const keys = (renderer) => renderer.info.programs.map((program) => program.cacheKey);

/** Counts whole-scene walks: the light view must not make `compile` walk the world per batch. */
function countWalks(scene) {
  const counter = { walks: 0 };
  const traverse = scene.traverse.bind(scene);
  const traverseVisible = scene.traverseVisible.bind(scene);
  scene.traverse = (callback) => { counter.walks++; return traverse(callback); };
  scene.traverseVisible = (callback) => { counter.walks++; return traverseVisible(callback); };
  counter.stop = () => { delete scene.traverse; delete scene.traverseVisible; };
  return counter;
}

test("the light view compiles exactly the programs the world draw links, walking the world once", () => {
  const renderer = fakeRenderer();
  const scene = world();
  const view = camera();
  // The live world has drawn frames before new content arrives. three r185 renders the shadow pass
  // before `setupLights`, so a depth key carries the previous frame's light counts (none on a
  // scene's very first frame); the warm pass keys depth programs with the current ones.
  renderer.render(scene, view);
  const warmup = new ProgramWarmup(renderer, scene);
  const objects = content();
  for (const object of objects) warmup.registerObject(object);
  const walks = countWalks(scene);
  let ticks = 0;
  while (warmup.queued > 0) {
    warmup.tick(view);
    ticks++;
  }
  walks.stop();
  assert.ok(ticks >= 2, "the queue took several batches");
  assert.equal(walks.walks, 1, "one walk finds the lights; no batch walks the world again");
  const warmed = keys(renderer);
  assert.ok(warmed.length >= 10, `main and depth variants were compiled (${warmed.length})`);

  for (const object of objects) scene.add(object);
  renderer.render(scene, view);
  assert.deepEqual(keys(renderer).filter((key) => !warmed.includes(key)), [],
    "the draw, shadow pass included, links nothing the warm pass had not compiled");

  // And the keys are the ones the whole world scene as compile's target produced before.
  const reference = fakeRenderer();
  const referenceScene = world();
  reference.render(referenceScene, view);
  for (const object of content()) {
    const standIns = new THREE.Scene();
    standIns.fog = referenceScene.fog;
    standIns.add(object);
    reference.compile(standIns, view, referenceScene);
  }
  const wholeScene = keys(reference);
  assert.ok(wholeScene.length > 0);
  assert.deepEqual(wholeScene.filter((key) => !warmed.includes(key)), [],
    "every key the whole-scene target derived, the light view derived too");
});

test("a light added at the root joins the next batch's key, and a hidden light is left out", () => {
  const renderer = fakeRenderer();
  const scene = world();
  const view = camera();
  renderer.render(scene, view);
  const warmup = new ProgramWarmup(renderer, scene);
  const first = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  warmup.registerObject(first);
  while (warmup.queued > 0) warmup.tick(view);

  // A fourth shadow-casting light after the view cached three (a cascade the profile added), and a
  // light under a hidden group, which the draw's own walk does not reach.
  const added = new THREE.DirectionalLight(0xffffff, 0);
  added.castShadow = true;
  scene.add(added);
  const hidden = new THREE.Group();
  hidden.visible = false;
  hidden.add(new THREE.PointLight(0xffffff, 1));
  scene.add(hidden);
  const second = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.3 }));
  warmup.registerObject(second);
  while (warmup.queued > 0) warmup.tick(view);
  const warmed = keys(renderer);

  scene.add(second);
  renderer.render(scene, view);
  const drawn = [...renderer.properties.get(second.material).programs.keys()];
  assert.equal(drawn.length, 1);
  assert.ok(warmed.includes(drawn[0]), "the draw found the program the warm pass compiled with four lights");
});

test("a light set the warm pass did not see is a key the draw has to link (the control)", () => {
  const renderer = fakeRenderer();
  const scene = world();
  const view = camera();
  renderer.render(scene, view);
  // Warmed against a world short of one cascade: the draw of the real world must link its own.
  const warmup = new ProgramWarmup(renderer, world({ cascades: 1 }));
  const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  warmup.registerObject(object);
  while (warmup.queued > 0) warmup.tick(view);
  const warmed = keys(renderer);
  scene.add(object);
  renderer.render(scene, view);
  assert.ok(keys(renderer).some((key) => !warmed.includes(key)), "a different light count is a different program");
});

test("the view reads the scene's live fog and environment and visits only its shown lights", () => {
  const scene = world({ scenery: 10 });
  const lights = [];
  scene.traverse((object) => { if (object.isLight) lights.push(object); });
  const view = programWarmupLightView(scene, () => lights);
  assert.equal(view.isScene, true);
  assert.equal(view.fog, scene.fog);
  scene.fog = new THREE.FogExp2(0x112233, 0.01);
  assert.equal(view.fog, scene.fog, "a fog swapped later is the one the next compile keys on");
  const visited = [];
  view.traverseVisible((object) => visited.push(object));
  assert.deepEqual(visited, lights);
  lights[1].visible = false;
  scene.remove(lights[2]);
  visited.length = 0;
  view.traverseVisible((object) => visited.push(object));
  assert.deepEqual(visited, [lights[0]], "hidden and detached lights are not gathered");
});
