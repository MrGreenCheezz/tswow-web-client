import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  PROGRAM_WARMUP_DEPTH_VARIANTS, ProgramWarmup, shadowDepthStandIn,
} from "../dist/code/browser/ProgramWarmup.js";

/**
 * A renderer stand-in that records what `compile` saw: the objects, the render target bound at
 * that moment and the context scene's fog. `ready` decides what `isReady` answers.
 */
function fakeRenderer({ shadows = true } = {}) {
  const records = new Map();
  const state = { ready: false, target: null, compiles: [] };
  const record = (material) => {
    if (!records.has(material)) records.set(material, {});
    return records.get(material);
  };
  return {
    state,
    shadowMap: { enabled: shadows },
    extensions: { has: () => true },
    properties: { get: record },
    getRenderTarget: () => state.target,
    setRenderTarget(target) { state.target = target; },
    compile(scene, camera, targetScene) {
      const seen = { target: state.target, fog: targetScene?.fog ?? null, environment: targetScene?.environment ?? null,
        objects: [], materials: new Set() };
      scene.traverse((object) => {
        if (!object.material) return;
        seen.objects.push(object);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          seen.materials.add(material);
          const entry = record(material);
          if (!entry.programs) {
            const program = { program: {}, isReady: () => state.ready, getUniforms() {} };
            entry.programs = new Map([["key", program]]);
            entry.currentProgram = program;
          }
        }
      });
      state.compiles.push(seen);
      return seen.materials;
    },
  };
}

function world() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x112233, 10, 200);
  scene.environment = new THREE.Texture();
  scene.add(new THREE.DirectionalLight());
  return scene;
}

test("the shadow stand-in copies exactly what three's shadow map copies onto its depth material", () => {
  const map = new THREE.Texture();
  const leaf = new THREE.MeshStandardMaterial({ map, alphaTest: 224 / 255, side: THREE.DoubleSide });
  const depth = shadowDepthStandIn(leaf);
  assert.ok(depth instanceof THREE.MeshDepthMaterial);
  assert.equal(depth.depthPacking, THREE.BasicDepthPacking, "three's own depth material packing");
  assert.equal(depth.side, THREE.DoubleSide);
  assert.equal(depth.map, map);
  assert.equal(depth.alphaTest, 224 / 255);
  assert.equal(shadowDepthStandIn(new THREE.MeshStandardMaterial()).side, THREE.BackSide,
    "PCF shadows draw a front-sided caster's back faces");
  assert.equal(shadowDepthStandIn(new THREE.MeshLambertMaterial({ side: THREE.BackSide })).side, THREE.FrontSide);
  const explicit = new THREE.MeshStandardMaterial();
  explicit.shadowSide = THREE.DoubleSide;
  assert.equal(shadowDepthStandIn(explicit).side, THREE.DoubleSide);
  // The renderer's own caster policy: lit, opaque, normally blended, depth-writing.
  assert.equal(shadowDepthStandIn(new THREE.MeshBasicMaterial()), undefined);
  assert.equal(shadowDepthStandIn(new THREE.MeshStandardMaterial({ transparent: true })), undefined);
  assert.equal(shadowDepthStandIn(new THREE.MeshStandardMaterial({ depthWrite: false })), undefined);
  assert.equal(shadowDepthStandIn(new THREE.MeshStandardMaterial({ blending: THREE.AdditiveBlending })), undefined);
});

test("depth variants compile once, offscreen, with the world's lights and without its fog", () => {
  const renderer = fakeRenderer();
  const target = world();
  const warmup = new ProgramWarmup(renderer, target);
  const geometry = new THREE.BufferGeometry();
  const map = new THREE.Texture();
  const bodies = [0, 1, 2].map(() => new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ map })));
  const leaves = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide }));
  const glow = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true }));
  for (const object of [...bodies, leaves, glow]) warmup.registerObject(object);
  const camera = new THREE.PerspectiveCamera();
  const screen = { name: "screen" };
  renderer.state.target = screen;
  warmup.tick(camera);
  const depthCompile = renderer.state.compiles.find((seen) => [...seen.materials].every((m) => m.isMeshDepthMaterial));
  assert.ok(depthCompile, "the depth variants have a compile of their own");
  assert.equal(depthCompile.objects.length, 2, "three skinned bodies share one variant; leaves are another");
  assert.ok(depthCompile.target && depthCompile.target !== screen, "compiled against an offscreen target");
  assert.equal(depthCompile.fog, null, "the shadow pass draws with no fog");
  assert.equal(depthCompile.environment, null);
  assert.equal(depthCompile.objects.filter((object) => object.isSkinnedMesh).length, 1);
  assert.equal(renderer.state.target, screen, "the caller's render target is restored");
  assert.equal(warmup.depthPrograms, 2);
  for (const object of [...bodies, leaves]) warmup.registerObject(object);
  const before = renderer.state.compiles.length;
  warmup.tick(camera);
  assert.equal(renderer.state.compiles.filter((seen, index) => index >= before
    && [...seen.materials].some((m) => m.isMeshDepthMaterial)).length, 0, "nothing new to warm");
  warmup.reset();
  assert.equal(warmup.depthPrograms, 0);
});

test("without shadows no depth variant is warmed, and the variant count is bounded", () => {
  const off = fakeRenderer({ shadows: false });
  const quiet = new ProgramWarmup(off, world());
  quiet.registerObject(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
  quiet.tick(new THREE.PerspectiveCamera());
  assert.equal(off.state.compiles.some((seen) => [...seen.materials].some((m) => m.isMeshDepthMaterial)), false);
  assert.equal(quiet.depthPrograms, 0);

  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, world());
  // Distinct uv channels make distinct variants; far more of them than the bound.
  for (let channel = 0; channel < PROGRAM_WARMUP_DEPTH_VARIANTS + 8; channel++) {
    const map = new THREE.Texture();
    map.channel = channel;
    warmup.registerObject(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map })));
  }
  for (let frame = 0; frame < 40; frame++) warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(warmup.depthPrograms, PROGRAM_WARMUP_DEPTH_VARIANTS);
});

test("a material is linked once its warmed or drawn programs report ready", () => {
  const renderer = fakeRenderer({ shadows: false });
  const warmup = new ProgramWarmup(renderer, world());
  const geometry = new THREE.BufferGeometry();
  const warmed = new THREE.MeshBasicMaterial();
  const drawn = new THREE.MeshBasicMaterial();
  const fresh = new THREE.MeshBasicMaterial();
  assert.equal(warmup.isLinked(warmed, geometry, "mesh"), false);
  warmup.registerObject(new THREE.Mesh(geometry, warmed));
  warmup.tick(new THREE.PerspectiveCamera());
  assert.equal(warmup.isLinked(warmed, geometry, "mesh"), false, "compiled, still linking");
  renderer.state.ready = true;
  assert.equal(warmup.isLinked(warmed, geometry, "mesh"), true);
  // A material an earlier draw already compiled counts as well; one nobody compiled does not.
  renderer.properties.get(drawn).programs = new Map([["key", { program: {}, isReady: () => true, getUniforms() {} }]]);
  assert.equal(warmup.isLinked(drawn, geometry, "mesh"), true);
  assert.equal(warmup.isLinked(fresh, geometry, "mesh"), false);
});

test("a new WMO room is held out of the frame until its programs are linked, and never for long", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const attach = source.slice(source.indexOf("  #updateWmoGroups("), source.indexOf("  #holdWmoGroupUntilWarm("));
  assert.match(attach, /node\.add\(rendered\.mesh\);\s*this\.#holdWmoGroupUntilWarm\(rendered\.mesh\);/);
  const draw = source.slice(source.indexOf("  draw(\n"), source.indexOf("\n  #resetFrameCounters(): void {"));
  const tick = draw.indexOf("this.#programWarmup.tick(this.#camera);");
  const release = draw.indexOf("this.#releaseWarmWmoGroups();");
  const submit = draw.indexOf("this.#renderer.render(this.#scene, this.#camera);");
  assert.ok(tick >= 0 && release > tick && submit > release,
    "held rooms are released after the warm pass settles and before the frame is submitted");
  const hold = source.slice(source.indexOf("  #holdWmoGroupUntilWarm("), source.indexOf("  #wmoGroupMesh("));
  assert.match(hold, /frames >= WMO_WARM_HOLD_FRAMES/);
  assert.match(hold, /this\.#wmoGroupsPending \+= this\.#wmoWarmHolds\.size;/,
    "readiness counts a held room as one not yet on screen");
  assert.match(source, /const WMO_WARM_HOLD_FRAMES = \d+;/);
});
