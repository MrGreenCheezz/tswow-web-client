import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { ProgramWarmup, WarmHold } from "../dist/code/browser/ProgramWarmup.js";

/** A renderer stand-in: `compile` gives every material one program; `ready` is what it reports. */
function fakeRenderer() {
  const records = new Map();
  const state = { ready: false };
  const record = (material) => {
    if (!records.has(material)) records.set(material, {});
    return records.get(material);
  };
  return {
    state,
    shadowMap: { enabled: false },
    extensions: { has: () => true },
    properties: { get: record },
    getRenderTarget: () => null,
    setRenderTarget() {},
    compile(scene) {
      const materials = new Set();
      scene.traverse((object) => {
        if (!object.material) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          const entry = record(material);
          if (!entry.programs) {
            const made = { program: {}, isReady: () => state.ready, getUniforms() {} };
            entry.programs = new Map([["key", made]]);
            entry.currentProgram = made;
          }
        }
      });
      return materials;
    },
  };
}

test("WarmHold hides only what is not warm and shows it once warm or after its cap", () => {
  const ready = new Set();
  const hold = new WarmHold(3, (object) => ready.has(object));
  const warm = new THREE.Object3D(), cold = new THREE.Object3D(), never = new THREE.Object3D();
  ready.add(warm);
  hold.hold(warm);
  hold.hold(cold);
  hold.hold(never);
  hold.hold(cold);
  assert.equal(warm.visible, true, "a warm object is never hidden");
  assert.equal(cold.visible, false);
  assert.equal(never.visible, false);
  assert.equal(hold.size, 2, "holding twice is one hold");
  hold.release();
  assert.equal(cold.visible, false, "still compiling");
  ready.add(cold);
  hold.release();
  assert.equal(cold.visible, true, "shown on the pass that finds it warm");
  assert.equal(never.visible, false);
  hold.release();
  assert.equal(never.visible, false, "three passes waited");
  hold.release();
  assert.equal(never.visible, true, "shown after the cap: the old first-draw cost, never a missing object");
  assert.equal(hold.size, 0);
  const late = new THREE.Object3D();
  hold.hold(late);
  hold.clear();
  hold.release();
  assert.equal(late.visible, false, "a cleared hold belongs to a reset world and is not touched again");
  assert.equal(hold.size, 0);
});

test("a new visual waits for the warm pass to compile, link and query its program", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const camera = new THREE.PerspectiveCamera();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  const hold = new WarmHold(30, (object) => warmup.isWarm(object.material, object.geometry, "mesh"));
  const node = new THREE.Group();
  node.add(mesh);
  warmup.registerObject(node);
  hold.hold(mesh);
  assert.equal(mesh.visible, false, "registered, not compiled");
  warmup.tick(camera);
  hold.release();
  assert.equal(mesh.visible, false, "compiled, still linking: a draw now would wait for the driver");
  renderer.state.ready = true;
  warmup.tick(camera);
  hold.release();
  assert.equal(mesh.visible, true, "linked and queried by the warm pass: drawn with nothing left to do");
  // Another placement of the same model and material is warm from the start.
  const copy = new THREE.Mesh(mesh.geometry, mesh.material);
  hold.hold(copy);
  assert.equal(copy.visible, true);
});

test("the world renderer holds every model visual it places and releases them with the other holds", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const node = source.slice(source.indexOf("  #wvmNode("), source.indexOf("  #visualProgramsWarm("));
  const register = node.indexOf("this.#programWarmup.registerObject(node);");
  const held = node.indexOf("this.#visualWarmHold.hold(mesh);");
  assert.ok(register >= 0 && held > register, "held after its materials are registered with the warm pass");
  const warm = source.slice(source.indexOf("  #visualProgramsWarm("), source.indexOf("  #visualProgramsWarm(") + 500);
  assert.match(warm, /this\.#programWarmup\.isWarm\(material, mesh\.geometry, kind\)/);
  const draw = source.slice(source.indexOf("  draw(\n"), source.indexOf("\n  #resetFrameCounters(): void {"));
  const tick = draw.indexOf("this.#programWarmup.tick(this.#camera);");
  const released = draw.indexOf("this.#visualWarmHold.release();");
  const submit = draw.indexOf("this.#renderer.render(this.#scene, this.#camera);");
  assert.ok(tick >= 0 && released > tick && submit > released, "released after the warm pass, before the submission");
  assert.match(source, /new WarmHold\(VISUAL_WARM_HOLD_FRAMES, /);
  assert.match(source, /this\.#unitPartWarmHolds\.clear\(\);\s*this\.#visualWarmHold\.clear\(\);/, "a world reset drops the holds");
});

test("a forgotten hold is dropped without touching its object", () => {
  const hold = new WarmHold(3, () => false);
  const dropped = new THREE.Object3D(), kept = new THREE.Object3D();
  hold.hold(dropped);
  hold.hold(kept);
  hold.forget(dropped);
  assert.equal(hold.size, 1);
  for (let pass = 0; pass < 4; pass++) hold.release();
  assert.equal(dropped.visible, false, "its owner disposed it; the hold never shows it again");
  assert.equal(kept.visible, true, "the other hold still runs to its cap");
});

test("a new emitter set is held until its programs are warm, released in the warm phase, forgotten when dropped", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const effectsStart = source.indexOf("  #updateEffects(");
  const effectsEnd = source.indexOf("\n  #markExpiredSpellEffectPhases", effectsStart + 10);
  const effects = source.slice(effectsStart, effectsEnd);
  assert.match(effects, /this\.#programWarmup\.registerObject\(built\.group\);\s*\/\/[^\n]*\n\s*this\.#effectWarmHold\.hold\(built\.group\);/,
    "a freshly built set is registered with the warm pass and held on the same frame");
  assert.match(source, /this\.#visualWarmHold\.release\(\);\s*this\.#effectWarmHold\.release\(\);/,
    "the warm phase releases held sets next to the visual holds");
  const dropStart = source.indexOf("  #dropEffects(key: string): void {");
  const drop = source.slice(dropStart, source.indexOf("\n  }\n", dropStart));
  assert.match(drop, /this\.#effectWarmHold\.forget\(held\.effects\.group\);/, "a dropped set leaves the hold");
  assert.match(source, /this\.#visualWarmHold\.clear\(\);\s*this\.#effectWarmHold\.clear\(\);/, "a world reset drops every hold");
  const warmStart = source.indexOf("  #effectProgramsWarm(");
  const warm = source.slice(warmStart, source.indexOf("\n  }\n", warmStart));
  assert.match(warm, /child instanceof THREE\.Mesh && !this\.#visualProgramsWarm\(child\)/,
    "every emitter mesh of the group must be warm");
});
