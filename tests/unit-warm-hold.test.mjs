import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as THREE from "three";
import { WebGLPrograms } from "three/src/renderers/webgl/WebGLPrograms.js";
import {
  ProgramWarmup, programWarmupKind, PROGRAM_WARMUP_RETAINED_PROGRAMS, PROGRAM_WARMUP_UNIT_RETAINED_PROGRAMS,
} from "../dist/code/browser/ProgramWarmup.js";
import { FADE_ALPHA_TEST_FLOOR, applyBlendMode, cloneMaterialFaded } from "../dist/code/browser/ModelBuild.js";
import {
  borrowFadedMaterials, createFadeProgramTwin, createUnitCapsuleMaterial, returnBorrowedMaterials,
  unitWarmBody, updateBorrowedMaterials,
} from "../dist/code/browser/WorldRenderer3D.js";
import { spawnFadeFactor, SPAWN_FADE_WINDOW_MS } from "../dist/code/browser/AnimatedModel.js";
import { glowBodyMeshes } from "../dist/code/browser/WeaponGlowBody.js"; // 05.10: ревью E2
import { glowAnchorsOf } from "../dist/code/browser/WeaponGlow.js"; // 05.10: ревью E2
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";

// The unit warm hold (city-arrival: seven shader programs linked inside the frame a unit was first
// drawn, 24–149 ms each). The renderer half runs the real methods out of WorldRenderer3D.ts against a
// real ProgramWarmup whose renderer compiles instantly and links when the test says so.

const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("WorldRenderer3D.ts", source, ts.ScriptTarget.ES2022, true);
const rendererClass = parsed.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === "WorldRenderer3D");
const member = name => {
  const found = rendererClass.members.find(m => m.name?.getText(parsed) === name);
  assert.ok(found, name);
  return found.getText(parsed).replaceAll("#", "");
};
const moduleFunction = name => {
  const found = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(found, name);
  return found.getText(parsed);
};
const constant = name => {
  const match = source.match(new RegExp(`\\nconst ${name} = (\\d+);`));
  assert.ok(match, name);
  return Number(match[1]);
};
const UNIT_WARM_HOLD_FRAMES = constant("UNIT_WARM_HOLD_FRAMES");
const UNIT_WARM_HOLD_SELF_FRAMES = constant("UNIT_WARM_HOLD_SELF_FRAMES");
const UNIT_FADE_RETURN_HOLD_FRAMES = constant("UNIT_FADE_RETURN_HOLD_FRAMES");
const APPEARANCE_PENDING_WAIT_MS = constant("APPEARANCE_PENDING_WAIT_MS");

const Harness = (() => {
  const names = ["#holdUnitUntilWarm", "#releaseWarmUnits", "#markUnitShown", "#trackUnitMeshes",
    "#unitProgramsReady", "#unitMeshProgramsReady", "#unitProgramLinked", "#capsuleProgramsReady",
    "#capsulePrograms", "#fadeTwin", "#unitFadeReturnWaits", "#unitOpacityMeshes", "#applyUnitOpacity",
    "#releaseUnitOpacity", "#unitOpacityStale", "#appearanceWaits"];
  const code = ts.transpileModule(`${moduleFunction("hangsUnder")}\nclass Harness { ${names.map(member).join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const deps = {
    THREE, spawnFadeFactor, programWarmupKind, unitWarmBody, createFadeProgramTwin, createUnitCapsuleMaterial,
    borrowFadedMaterials, returnBorrowedMaterials, updateBorrowedMaterials,
    glowBodyMeshes, glowAnchorsOf, // 05.10: ревью E2 — `#unitOpacityMeshes` reaches the glow bodies
    UNIT_WARM_HOLD_FRAMES, UNIT_WARM_HOLD_SELF_FRAMES, UNIT_FADE_RETURN_HOLD_FRAMES, APPEARANCE_PENDING_WAIT_MS,
  };
  return Function(...Object.keys(deps), `${code}; return Harness;`)(...Object.values(deps));
})();

/**
 * Compiles instantly; a compiled program links when `state.ready` says so — a flag, or a predicate
 * over the material the warm pass compiled. Programs of materials other units drew are linked.
 */
function fakeRenderer() {
  const records = new Map();
  const state = { ready: false };
  const record = material => {
    let entry = records.get(material);
    if (!entry) records.set(material, entry = {});
    return entry;
  };
  return {
    state,
    shadowMap: { enabled: false },
    extensions: { has: () => true },
    properties: { get: record },
    getRenderTarget: () => null,
    setRenderTarget() {},
    /** Some other unit already drew this material, so three holds a linked program for it. */
    drawn(material) {
      record(material).programs = new Map([["drawn", { program: {}, isReady: () => true, getUniforms() {} }]]);
    },
    compile(scene) {
      const materials = new Set();
      scene.traverse(object => {
        if (!object.material) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          const entry = record(material);
          if (!entry.programs) {
            const isReady = () => (typeof state.ready === "function" ? state.ready(material) : state.ready);
            const made = { program: {}, isReady, getUniforms() {} };
            entry.programs = new Map([["key", made]]);
            entry.currentProgram = made;
          }
        }
      });
      return materials;
    },
  };
}

const camera = new THREE.PerspectiveCamera();

function rig() {
  const renderer = fakeRenderer();
  const h = new Harness();
  Object.assign(h, {
    programWarmup: new ProgramWarmup(renderer, new THREE.Scene()),
    unitWarmHolds: new Map(), unitPartWarmHolds: new Map(), unitWarmTracked: new WeakSet(),
    fadeTwins: new WeakMap(), capsuleTwins: undefined, worldLight: createWorldLightUniforms(),
    unitBodyGeometry: new THREE.CapsuleGeometry(0.5, 1, 4, 12), submissionSerial: 1,
    // 11.02-H-review: the release asks the vehicle poser whether a HIDE_PASSENGER seat hid the node.
    vehiclePassengers: { hides: () => false },
  });
  return { h, renderer };
}

function bodyMaterials() {
  const lit = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  applyBlendMode(lit, 1); // the 224/255 cut-out: hair, fringes
  const unlit = new THREE.MeshBasicMaterial();
  applyBlendMode(unlit, 2);
  return [lit, unlit];
}

/** A unit wearing a rigged body, hanging in the unit group like `#drawUnit` leaves it. */
function riggedUnit(materials = bodyMaterials()) {
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), materials);
  const root = new THREE.Group().add(mesh);
  const node = new THREE.Group().add(root);
  new THREE.Group().add(node);
  return {
    node, skinned: { mesh, root }, body: undefined, attached: new Map(), mount: undefined,
    material: new THREE.MeshStandardMaterial(), unitOpacity: 1, shadowCaster: undefined,
  };
}

/**
 * One `WorldRenderer3D.draw` for one unit, in the order the source is pinned to below: `#drawUnit`'s
 * tail (fade stamp, mesh tracking, hold, visibility, opacity, shadow), then the warm pass, then the
 * release, then the submission serial.
 */
function frame(h, unit, now, { self = false, opacity = 1, beforeTick } = {}) {
  if (unit.admittedAt === undefined) unit.admittedAt = now;
  if (unit.shadowCaster === undefined) h.trackUnitMeshes(unit, self);
  const held = h.holdUnitUntilWarm(unit, self, true, opacity, now);
  unit.node.visible = !held;
  const wanted = opacity * spawnFadeFactor(unit.admittedAt, now);
  h.applyUnitOpacity(unit, wanted, h.unitFadeReturnWaits(unit, wanted));
  unit.shadowCaster = true;
  beforeTick?.();
  h.programWarmup.tick(camera);
  h.releaseWarmUnits();
  h.submissionSerial++;
  return unit.node.visible;
}

function sharedOf(unit, mesh = unit.skinned.mesh) {
  return unit.opacityBorrows?.find(borrow => borrow.mesh === mesh)?.shared ?? mesh.material;
}

test("a fresh unit waits hidden until its shared and fade programs link, then fades in from zero", () => {
  const { h, renderer } = rig();
  const unit = riggedUnit();
  const [lit, unlit] = unit.skinned.mesh.material;
  assert.equal(frame(h, unit, 1000), false, "nothing is linked yet: the unit is not drawn");
  const copies = unit.skinned.mesh.material;
  assert.notEqual(copies, sharedOf(unit), "held, it already wears its fade copies at the opacity it will be shown with");
  assert.equal(unit.unitOpacity, 0);
  for (const material of [lit, unlit]) {
    const geometry = unit.skinned.mesh.geometry;
    assert.equal(h.programWarmup.isLinked(material, geometry, "skinned"), false);
    assert.equal(h.programWarmup.isLinked(h.fadeTwin(material), geometry, "skinned"), false);
  }
  assert.equal(frame(h, unit, 1016), false, "compiled, still linking");
  assert.equal(frame(h, unit, 1033), false);
  renderer.state.ready = true;
  assert.equal(frame(h, unit, 1050), true, "shown after the warm pass that links the last program");
  assert.equal(unit.unitOpacity, 0, "and its first visible frame is the fade's first frame");
  assert.equal(unit.skinned.mesh.material, copies, "drawn in the copies it was dressed in while hidden");
  assert.equal(frame(h, unit, 1050 + SPAWN_FADE_WINDOW_MS / 4), true);
  assert.equal(unit.unitOpacity, 0.25, "the fade clock ran only from the first visible frame");
  frame(h, unit, 1050 + SPAWN_FADE_WINDOW_MS);
  assert.deepEqual(unit.skinned.mesh.material, [lit, unlit], "the shared array is back once the fade is over");
  assert.equal(h.unitWarmHolds.size, 0);
});

test("the fade copies are part of the wait: linked shared programs alone do not release a fading unit", () => {
  const { h, renderer } = rig();
  const unit = riggedUnit();
  for (const material of unit.skinned.mesh.material) renderer.drawn(material);
  let queuedByBorrow;
  assert.equal(frame(h, unit, 0, {
    beforeTick: () => { queuedByBorrow = h.programWarmup.queued; },
  }), false, "the fade copies' program has never been built");
  assert.equal(queuedByBorrow, 2, "one stand-in per shared material is queued; the unit's own copies queue nothing");
  renderer.state.ready = true;
  assert.equal(frame(h, unit, 16), true);
  const other = riggedUnit(sharedOf(unit));
  assert.equal(frame(h, other, 32), true, "a second unit of the same look finds every program linked");
  assert.equal(other.unitOpacity, 0, "and starts its own fade on the frame it arrives");
});

test("a unit whose programs never link is drawn after UNIT_WARM_HOLD_FRAMES frames, as before", () => {
  const { h } = rig();
  const unit = riggedUnit();
  for (let index = 1; index <= UNIT_WARM_HOLD_FRAMES; index++) {
    assert.equal(frame(h, unit, index * 16), false, `frame ${index} is still within the cap`);
  }
  assert.equal(frame(h, unit, (UNIT_WARM_HOLD_FRAMES + 1) * 16), true);
  assert.equal(unit.unitOpacity, 0, "even released by the cap, the fade starts on the first visible frame");
});

test("a held unit the frame did not draw keeps waiting, and one that left the scene is forgotten", () => {
  const { h, renderer } = rig();
  const unit = riggedUnit();
  frame(h, unit, 0);
  renderer.state.ready = true;
  // Admission turned it away this frame: `#drawUnit` never ran, so nothing may show it.
  h.programWarmup.tick(camera);
  h.releaseWarmUnits();
  h.submissionSerial++;
  assert.equal(h.unitWarmHolds.size, 1);
  assert.equal(frame(h, unit, 50), true);
  const gone = riggedUnit();
  renderer.state.ready = false;
  frame(h, gone, 60);
  gone.node.removeFromParent();
  h.releaseWarmUnits();
  assert.equal(h.unitWarmHolds.has(gone), false);
});

test("11.02-H-review: a passenger a HIDE_PASSENGER seat hid stays hidden through its release", () => {
  const { h, renderer } = rig();
  const unit = riggedUnit();
  h.vehiclePassengers = { hides: (node) => node === unit.node };
  assert.equal(frame(h, unit, 0), false);
  renderer.state.ready = true;
  assert.equal(frame(h, unit, 16), false, "released, and still no model while it sits there");
  assert.equal(h.unitWarmHolds.size, 0, "the hold itself is over");
  h.vehiclePassengers = { hides: () => false };
  assert.equal(frame(h, unit, 32), true, "out of the seat: drawn");
});

test("the player's first appearance waits at most UNIT_WARM_HOLD_SELF_FRAMES, and is never hidden again", () => {
  const { h } = rig();
  const self = riggedUnit();
  for (let index = 1; index <= UNIT_WARM_HOLD_SELF_FRAMES; index++) {
    assert.equal(frame(h, self, index * 16, { self: true }), false);
  }
  assert.equal(frame(h, self, 1000, { self: true }), true);
  // A new body — an armour change, a shapeshift — whose programs nothing has linked, swapped in the
  // way `#clearUnitNode` and `#useSkinned` do it.
  h.releaseUnitOpacity(self);
  self.unitOpacity = 1;
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), bodyMaterials());
  self.skinned.root.clear();
  self.skinned = { mesh, root: self.skinned.root.add(mesh) };
  self.shadowCaster = undefined;
  assert.equal(frame(h, self, 5000, { self: true }), true, "the player's own model is never hidden once seen");
  const other = riggedUnit();
  assert.equal(frame(h, other, 5000), false, "anybody else's new body waits");
});

test("a capsule waits for the pill's programs, and the opaque one is linked before its fade ends", () => {
  const { h, renderer } = rig();
  const pill = createUnitCapsuleMaterial(0x335577, h.worldLight);
  const body = new THREE.Mesh(h.unitBodyGeometry, pill);
  const node = new THREE.Group().add(body);
  new THREE.Group().add(node);
  const unit = { node, skinned: undefined, body, attached: new Map(), material: pill, unitOpacity: 1, shadowCaster: undefined };
  assert.equal(frame(h, unit, 0), false);
  assert.equal(h.programWarmup.isLinked(h.capsulePrograms().opaque, h.unitBodyGeometry, "mesh"), false);
  renderer.state.ready = material => material.transparent;
  assert.equal(frame(h, unit, 8), false, "the translucent program it fades in with is not enough");
  renderer.state.ready = true;
  assert.equal(frame(h, unit, 16), true);
  assert.equal(pill.opacity, 0, "shown on the first frame of its fade");
  assert.equal(pill.transparent, true);
  assert.equal(h.programWarmup.isLinked(h.capsulePrograms().opaque, h.unitBodyGeometry, "mesh"), true,
    "the program the pill settles into was linked with the translucent one, not on the frame it is first drawn");
  frame(h, unit, 16 + SPAWN_FADE_WINDOW_MS);
  assert.equal(pill.transparent, false);
});

test("equipment hung on a unit already on screen waits for its own programs; the player's never does", () => {
  for (const self of [false, true]) {
    const { h, renderer } = rig();
    const unit = riggedUnit();
    renderer.state.ready = true;
    frame(h, unit, 0, { self });
    frame(h, unit, 16, { self });
    assert.equal(unit.node.visible, true);
    renderer.state.ready = false;
    const sword = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    unit.skinned.root.add(new THREE.Bone().add(sword));
    unit.attached.set("16/0", sword);
    unit.shadowCaster = undefined;
    frame(h, unit, 32, { self });
    assert.equal(unit.node.visible, true, "the unit itself stays on screen");
    assert.equal(sword.visible, self, self ? "the player's sword is drawn at once" : "a new sword waits for its program");
    renderer.state.ready = true;
    frame(h, unit, 48, { self });
    assert.equal(sword.visible, true);
    assert.equal(h.unitPartWarmHolds.size, 0);
  }
});

test("fade stand-ins are queued when a mesh is hung, before any fade asks for them", () => {
  const { h, renderer } = rig();
  const unit = riggedUnit();
  renderer.state.ready = true;
  frame(h, unit, 0);
  frame(h, unit, SPAWN_FADE_WINDOW_MS);
  assert.equal(unit.skinned.mesh.material, sharedOf(unit), "settled: nothing fades");
  const shield = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  unit.skinned.root.add(new THREE.Bone().add(shield));
  unit.attached.set("17/1", shield);
  unit.shadowCaster = undefined;
  frame(h, unit, SPAWN_FADE_WINDOW_MS + 16);
  assert.equal(shield.visible, true);
  assert.equal(h.programWarmup.isLinked(h.fadeTwin(shield.material), shield.geometry, "mesh"), true,
    "a stealth fade starting later finds its copies' program already linked");
});

test("a held part is let go at the cap, or dropped with the mesh it no longer hangs from", () => {
  const { h, renderer } = rig();
  const unit = riggedUnit();
  renderer.state.ready = true;
  frame(h, unit, 0);
  renderer.state.ready = false;
  const helm = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  const bone = new THREE.Bone().add(helm);
  unit.skinned.root.add(bone);
  unit.attached.set("1/0", helm);
  unit.shadowCaster = undefined;
  for (let index = 0; index < UNIT_WARM_HOLD_FRAMES; index++) {
    frame(h, unit, 16 + index);
    assert.equal(helm.visible, false);
  }
  frame(h, unit, 100);
  assert.equal(helm.visible, true, "shown at the cap regardless");
  const cloak = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  bone.add(cloak);
  unit.attached.set("15/0", cloak);
  unit.shadowCaster = undefined;
  frame(h, unit, 200);
  assert.equal(cloak.visible, false);
  cloak.removeFromParent();
  unit.attached.delete("15/0");
  h.releaseWarmUnits();
  assert.equal(h.unitPartWarmHolds.has(cloak), false, "a detached part leaves no hold behind");
});

test("a finished fade keeps its copies at full opacity until the shared programs link, capped", () => {
  const { h, renderer } = rig();
  const unit = riggedUnit();
  const shared = unit.skinned.mesh.material;
  renderer.state.ready = true;
  frame(h, unit, 0); // stand-ins and shared programs linked in one warm pass: shown, and fading
  const copies = unit.skinned.mesh.material;
  assert.notEqual(copies, shared);
  // Every keeper was dropped mid-fade and nothing else draws the shared materials.
  h.programWarmup.reset();
  renderer.state.ready = false;
  const end = SPAWN_FADE_WINDOW_MS + 10;
  for (let index = 0; index < UNIT_FADE_RETURN_HOLD_FRAMES; index++) {
    frame(h, unit, end + index);
    assert.equal(unit.skinned.mesh.material, copies, `frame ${index}: the copies stay while the shared programs link`);
    assert.equal(copies[0].opacity, shared[0].opacity, "at full opacity: the fade already looks finished");
    assert.equal(copies[0].alphaTest, shared[0].alphaTest);
  }
  frame(h, unit, end + UNIT_FADE_RETURN_HOLD_FRAMES);
  assert.equal(unit.skinned.mesh.material, shared, "given back at the cap regardless");
  assert.equal(unit.fadeReturnFrames, UNIT_FADE_RETURN_HOLD_FRAMES);
  frame(h, unit, end + UNIT_FADE_RETURN_HOLD_FRAMES + 1);
  assert.equal(unit.fadeReturnFrames, undefined, "a settled unit carries no count");

  const next = riggedUnit(bodyMaterials());
  const nextShared = next.skinned.mesh.material;
  renderer.state.ready = true;
  frame(h, next, 0);
  assert.notEqual(next.skinned.mesh.material, nextShared);
  frame(h, next, SPAWN_FADE_WINDOW_MS + 1);
  assert.equal(next.skinned.mesh.material, nextShared, "linked shared programs end the fade on its last frame");
});

test("a player's look with pending item rows waits for them, and for no longer than the cap", () => {
  const { h } = rig();
  const unit = riggedUnit();
  const pending = { appearancePending: true };
  assert.equal(h.appearanceWaits(unit, pending, 1000), true);
  assert.equal(h.appearanceWaits(unit, pending, 1000 + APPEARANCE_PENDING_WAIT_MS - 1), true);
  assert.equal(h.appearanceWaits(unit, pending, 1000 + APPEARANCE_PENDING_WAIT_MS), false,
    "a row that never arrives still leaves the partial look built");
  assert.equal(h.appearanceWaits(unit, { appearancePending: false }, 3000), false);
  assert.equal(unit.appearancePendingSince, undefined, "a settled look forgets the wait");
  assert.equal(h.appearanceWaits(unit, pending, 9000), true, "a later equipment change waits afresh");
  assert.equal(h.appearanceWaits(unit, pending, 100), true, "a rewound replay clock restarts the wait");
  assert.equal(h.appearanceWaits(unit, pending, 100 + APPEARANCE_PENDING_WAIT_MS), false);
  assert.equal(h.appearanceWaits(unit, {}, 0), false, "creatures carry no pending flag");

  const draw = source.slice(source.indexOf("  #drawUnit("), source.indexOf("\n  /**\n   * A name for exactly what will be built"));
  const wait = draw.indexOf("const appearanceWaits = this.#appearanceWaits(unit, metadata, now);");
  const build = draw.search(
    /standIn = appearanceWaits \? "appearance"\s*: this\.#attachSkinnedModel\(unit, metadata, key, decodedModel, client\);/);
  assert.ok(wait >= 0 && build > wait, "the body is not built while the look waits; the capsule or old look stays");
});

test("a faded cut-out keeps a positive threshold at every factor, so a fade never changes program", () => {
  for (let mode = 0; mode < 8; mode++) {
    const material = new THREE.MeshStandardMaterial({ opacity: 0.8 });
    applyBlendMode(material, mode);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    const borrows = borrowFadedMaterials([mesh], 0);
    const copy = mesh.material;
    const version = copy.version;
    for (const factor of [0, 1e-9, FADE_ALPHA_TEST_FLOOR / 2, 0.01, 0.5, 0.99, 1, 0]) {
      updateBorrowedMaterials(borrows, factor);
      assert.equal(copy.alphaTest > 0, material.alphaTest > 0, `blend ${mode} at ${factor}`);
      assert.equal(copy.version, version, `blend ${mode} at ${factor}: no program switch moved`);
      const fresh = cloneMaterialFaded(material, factor);
      assert.equal(fresh.alphaTest > 0, material.alphaTest > 0, `a fresh copy agrees at ${factor}`);
      fresh.dispose();
    }
    if (material.alphaTest > 0) {
      updateBorrowedMaterials(borrows, 0);
      assert.equal(copy.opacity, 0, "the first frame of a fade is still invisible");
      updateBorrowedMaterials(borrows, 0.35);
      assert.equal(copy.alphaTest, material.alphaTest * 0.35, "above the floor the cut-out is the authored one");
    }
    returnBorrowedMaterials(borrows);
  }
});

/** three r185's own parameter and cache-key code, over a renderer that holds only what they read. */
function programKeys() {
  const renderer = {
    getRenderTarget: () => null,
    state: { buffers: { depth: { getReversed: () => false } } },
    toneMapping: THREE.CustomToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: true, type: THREE.PCFShadowMap },
  };
  const programs = new WebGLPrograms(renderer, { get: () => null }, { has: () => true },
    { logarithmicDepthBuffer: false, precision: "highp", getMaxPrecision: precision => precision, vertexTextures: true },
    {}, { numPlanes: 0, numIntersection: 0 });
  const lights = { directional: [{}], point: [], spot: [], spotLightMap: [], rectArea: [], hemi: [{}],
    directionalShadowMap: [{}], pointShadowMap: [], spotShadowMap: [], numSpotLightShadowsWithMaps: 0, numLightProbes: 0 };
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 1, 100);
  return (material, object) =>
    programs.getProgramCacheKey(programs.getParameters(material, lights, [{}], scene, object, []));
}

test("one stand-in per shared material compiles the exact program of every unit's fade copy", () => {
  const key = programKeys();
  const light = createWorldLightUniforms();
  const texture = new THREE.Texture();
  let compared = 0;
  for (let mode = 0; mode < 8; mode++) {
    for (const Type of [THREE.MeshStandardMaterial, THREE.MeshBasicMaterial]) {
      for (const side of [THREE.FrontSide, THREE.DoubleSide]) {
        const shared = new Type({ map: texture, side });
        applyBlendMode(shared, mode);
        if (shared.isMeshStandardMaterial) applyWorldLight(shared, light, "surface");
        else shared.customProgramCacheKey = () => `wvm-fog-${mode}`;
        const body = new THREE.SkinnedMesh(new THREE.BoxGeometry(), shared);
        const twin = key(createFadeProgramTwin(shared), body);
        for (const factor of [0, 0.001, 0.2, 0.75, 0.999]) {
          assert.equal(key(cloneMaterialFaded(shared, factor), body), twin, `blend ${mode}, ${Type.name}, side ${side}, ${factor}`);
          compared++;
        }
        if (shared.alphaTest > 0) assert.notEqual(key(shared, body), twin, "the opaque original is a different program");
      }
    }
  }
  assert.equal(compared, 160);
  const pill = createUnitCapsuleMaterial(0x123456, light);
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1, 4, 12), pill);
  const opaque = createUnitCapsuleMaterial(0xffffff, light), faded = createUnitCapsuleMaterial(0xffffff, light, true);
  assert.equal(key(pill, capsule), key(opaque, capsule));
  pill.transparent = true;
  pill.needsUpdate = true;
  pill.opacity = 0.3;
  assert.equal(key(pill, capsule), key(faded, capsule), "a pill faded in place is the translucent stand-in's program");
  assert.equal(key(pill, new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 4), pill)), key(pill, capsule),
    "the facing cone draws with the capsule's program");
});

/** Three's acquire/release on Material.dispose, as tests/program-warmup-retention.test.mjs models it. */
function rendererWithProgramLifetimes() {
  const records = new Map(), programs = new Map();
  return {
    programs,
    extensions: { has: () => true },
    properties: { get: material => records.get(material) },
    compile(scene) {
      const materials = new Set();
      scene.traverse(mesh => {
        if (!mesh.isMesh) return;
        const material = mesh.material;
        materials.add(material);
        let record = records.get(material);
        if (!record) {
          record = { programs: new Map() };
          records.set(material, record);
          material.addEventListener("dispose", () => {
            for (const program of record.programs.values()) {
              if (--program.references === 0) {
                programs.delete(program.key);
                program.program = undefined;
              }
            }
            records.delete(material);
          });
        }
        const key = JSON.stringify([material.type, material.customProgramCacheKey(), !!mesh.isSkinnedMesh]);
        if (!record.programs.has(key)) {
          let program = programs.get(key);
          if (!program) programs.set(key, program = { key, references: 0, program: {}, isReady: () => true, getUniforms() {} });
          program.references++;
          record.programs.set(key, program);
          record.currentProgram = program;
        }
      });
      return materials;
    },
  };
}

function look(key) {
  const material = new THREE.MeshBasicMaterial();
  material.customProgramCacheKey = () => key;
  return new THREE.Mesh(new THREE.BufferGeometry(), material);
}

test("scenery churn cannot evict the programs kept for unit looks", () => {
  const renderer = rendererWithProgramLifetimes(), warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const fadeCopy = look("unit-fade");
  warmup.registerObject(fadeCopy, "unit");
  warmup.tick(camera);
  fadeCopy.material.dispose(); // the last unit of that look finished its fade
  assert.equal(warmup.retainedUnitPrograms, 1);
  for (let index = 0; index < PROGRAM_WARMUP_RETAINED_PROGRAMS * 2; index++) {
    warmup.registerObject(look(`doodad-${index}`));
    warmup.tick(camera);
  }
  assert.equal(warmup.retainedPrograms - warmup.retainedUnitPrograms, PROGRAM_WARMUP_RETAINED_PROGRAMS);
  assert.equal(warmup.retainedUnitPrograms, 1);
  assert.ok(renderer.programs.has(JSON.stringify(["MeshBasicMaterial", "unit-fade", false])),
    "the next arrival of that look finds its program alive");
});

test("unit looks evict least recently used among themselves, and a unit registration adopts a scenery keeper", () => {
  const renderer = rendererWithProgramLifetimes(), warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const shared = look("banner");
  warmup.registerObject(shared);
  warmup.registerObject(new THREE.Mesh(new THREE.BufferGeometry(), shared.material), "unit");
  warmup.tick(camera);
  assert.equal(warmup.retainedUnitPrograms, 1, "one unit registration while queued is enough to keep it for units");
  warmup.reset();
  const tree = look("tree");
  warmup.registerObject(tree);
  warmup.tick(camera);
  const looks = [];
  for (let index = 0; index < PROGRAM_WARMUP_UNIT_RETAINED_PROGRAMS; index++) {
    looks.push(look(`look-${index}`));
    warmup.registerObject(looks.at(-1), "unit");
    warmup.tick(camera);
  }
  assert.equal(warmup.retainedUnitPrograms, PROGRAM_WARMUP_UNIT_RETAINED_PROGRAMS);
  warmup.registerObject(looks[0], "unit");
  assert.equal(warmup.queued, 0, "touching a unit keeper refreshes it without compiling");
  warmup.registerObject(look("look-overflow"), "unit");
  warmup.tick(camera);
  assert.equal(warmup.retainedUnitPrograms, PROGRAM_WARMUP_UNIT_RETAINED_PROGRAMS);
  assert.equal(warmup.retainedPrograms - warmup.retainedUnitPrograms, 1, "the scenery keeper is not charged");
  warmup.registerObject(looks[0], "unit");
  assert.equal(warmup.queued, 0, "the recently touched look survives");
  warmup.registerObject(looks[1], "unit");
  assert.equal(warmup.queued, 1, "the least recently used look was evicted");
  warmup.tick(camera);
  warmup.registerObject(tree, "unit");
  assert.equal(warmup.retainedPrograms - warmup.retainedUnitPrograms, 0, "the tree's keeper moved to the unit budget");
  for (let index = 0; index < PROGRAM_WARMUP_RETAINED_PROGRAMS + 4; index++) {
    warmup.registerObject(look(`rock-${index}`));
    warmup.tick(camera);
  }
  warmup.registerObject(tree);
  assert.equal(warmup.queued, 0, "scenery churn no longer reaches the adopted keeper");
  warmup.reset();
  assert.equal(warmup.retainedPrograms, 0);
  assert.equal(warmup.retainedUnitPrograms, 0);
});

test("a fade stand-in follows its source: rebuilt when the source's program switches move, dropped with it", () => {
  const { h } = rig();
  const [lit] = bodyMaterials();
  const twin = h.fadeTwin(lit);
  assert.equal(h.fadeTwin(lit), twin, "one stand-in per shared material");
  assert.equal(twin.transparent, true);
  assert.ok(twin.alphaTest > 0 && twin.alphaTest < lit.alphaTest);
  let disposed = 0;
  twin.addEventListener("dispose", () => disposed++);
  lit.side = THREE.FrontSide;
  lit.needsUpdate = true;
  const fresh = h.fadeTwin(lit);
  assert.notEqual(fresh, twin, "a stand-in made before the change would compile the old program");
  assert.equal(fresh.side, THREE.FrontSide);
  assert.equal(disposed, 1);
  const key = lit.customProgramCacheKey();
  lit.customProgramCacheKey = () => `${key}|changed`;
  assert.notEqual(h.fadeTwin(lit), fresh, "a new cache key is a new program as well");
  const current = h.fadeTwin(lit);
  let dropped = 0;
  current.addEventListener("dispose", () => dropped++);
  lit.dispose();
  assert.equal(dropped, 1, "evicting the build drops its stand-ins");
  assert.equal(h.fadeTwins.has(lit), false);
});

test("a variant queued or compiled is tracked, so a waiting unit does not register it every frame", () => {
  const renderer = fakeRenderer(), warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const geometry = new THREE.BufferGeometry(), material = new THREE.MeshStandardMaterial();
  assert.equal(warmup.isTracked(material, geometry, "skinned"), false);
  warmup.registerMaterial(material, geometry, "skinned", "unit");
  assert.equal(warmup.isTracked(material, geometry, "skinned"), true, "queued");
  assert.equal(warmup.isTracked(material, geometry, "mesh"), false, "another class of object is another program");
  warmup.tick(camera);
  assert.equal(warmup.isLinked(material, geometry, "skinned"), false);
  assert.equal(warmup.isTracked(material, geometry, "skinned"), true, "compiled and still linking");
  warmup.reset();
  assert.equal(warmup.isTracked(material, geometry, "skinned"), false, "dropped with its world");

  const { h, renderer: slow } = rig();
  const unit = riggedUnit();
  const [lit] = unit.skinned.mesh.material;
  let registrations = 0;
  const register = h.programWarmup.registerMaterial.bind(h.programWarmup);
  h.programWarmup.registerMaterial = (...args) => {
    if (args[0] === lit) registrations++;
    register(...args);
  };
  for (let index = 0; index < 5; index++) frame(h, unit, index * 16);
  assert.equal(registrations, 1, "held five frames, registered once");
  slow.state.ready = true;
  assert.equal(frame(h, unit, 100), true);
});

test("the renderer holds and releases units in the order the harness above assumes", () => {
  const draw = source.slice(source.indexOf("  #drawUnit("), source.indexOf("\n  /**\n   * A name for exactly what will be built"));
  const order = [
    "if (presented && unit.admittedAt === undefined) unit.admittedAt = now;",
    "if (unit.shadowCaster === undefined) this.#trackUnitMeshes(unit, self);",
    "const held = this.#holdUnitUntilWarm(unit, self, presented, displayOpacity, now);", // 05.10-A7a-H 6.11а: aura opacity × CreatureModelAlpha
    "unit.node.visible = presented && !held;",
    "const opacity = displayOpacity * spawnFadeFactor(unit.admittedAt, now);", // 05.10-A7a-H 6.11а
    "this.#applyUnitOpacity(unit, opacity, this.#unitFadeReturnWaits(unit, opacity));",
    "this.#applyUnitShadow(unit, shadowCaster);",
  ].map(line => draw.indexOf(line));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), JSON.stringify(order));
  assert.ok(draw.indexOf("this.#updateMount(unit, mountModel?.(object), client);") < order[1],
    "every mesh the frame hangs — body, equipment, mount — is tracked on the frame it is hung");
  const frameSource = source.slice(source.indexOf("  draw(\n"), source.indexOf("\n  #resetFrameCounters(): void {"));
  const tick = frameSource.indexOf("this.#programWarmup.tick(this.#camera);");
  const release = frameSource.indexOf("this.#releaseWarmUnits();");
  const submit = frameSource.indexOf("this.#renderer.render(this.#scene, this.#camera);");
  assert.ok(frameSource.indexOf("this.#updateUnits(") < tick && tick < release && release < submit,
    "held units are released after the warm pass settles and before the frame is submitted");
  assert.match(source, /this\.#instanceWarmHolds\.clear\(\);\s*this\.#unitWarmHolds\.clear\(\);\s*this\.#unitPartWarmHolds\.clear\(\);/,
    "a world clear drops every unit hold");
  for (const call of ["registerObject(instance.root, \"unit\")", "registerObject(mesh, \"unit\")", "registerObject(node, \"unit\")"]) {
    assert.ok(source.includes(call), `unit builds are kept on the unit budget: ${call}`);
  }
  const opacity = member("#applyUnitOpacity");
  assert.doesNotMatch(opacity, /registerObject/, "a borrow queues nothing: the stand-ins were queued when the meshes were hung");
});
