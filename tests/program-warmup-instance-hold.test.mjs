import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { ProgramWarmup } from "../dist/code/browser/ProgramWarmup.js";

/** A renderer stand-in: `compile` gives every material one program; `ready` is what it reports. */
function fakeRenderer() {
  const records = new Map();
  const state = { ready: false, uniformFetches: 0 };
  const record = (material) => {
    if (!records.has(material)) records.set(material, {});
    return records.get(material);
  };
  const program = () => ({ program: {}, isReady: () => state.ready, getUniforms() { state.uniformFetches++; } });
  return {
    state,
    program,
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
            const made = program();
            entry.programs = new Map([["key", made]]);
            entry.currentProgram = made;
          }
        }
      });
      return materials;
    },
  };
}

function instanced(geometry, material) {
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.setColorAt(1, new THREE.Color(1, 0.5, 0.5));
  return mesh;
}

test("isWarm: only this variant, compiled by the warm pass, linked and with uniforms fetched", () => {
  const renderer = fakeRenderer();
  const warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial();
  const camera = new THREE.PerspectiveCamera();
  assert.equal(warmup.isWarm(material, geometry, "instanced-colour"), false, "nothing compiled yet");
  warmup.registerObject(instanced(geometry, material));
  warmup.tick(camera);
  assert.equal(warmup.isWarm(material, geometry, "instanced-colour"), false, "compiled, still linking");
  renderer.state.ready = true;
  assert.equal(warmup.isWarm(material, geometry, "instanced-colour"), false,
    "linked, but a first draw would still fetch the uniform locations itself");
  warmup.tick(camera);
  assert.equal(renderer.state.uniformFetches, 1, "the next warm pass fetched them");
  assert.equal(warmup.isWarm(material, geometry, "instanced-colour"), true);
  assert.equal(warmup.isWarm(material, geometry, "instanced"), false, "another variant of the same material");
  warmup.reset();
  assert.equal(warmup.isWarm(material, geometry, "instanced-colour"), false, "a reset forgets it");
});

test("isWarm does not accept the programs a draw made for another variant (isLinked does)", () => {
  const renderer = fakeRenderer();
  renderer.state.ready = true;
  const warmup = new ProgramWarmup(renderer, new THREE.Scene());
  const geometry = new THREE.BufferGeometry();
  const barrel = new THREE.MeshBasicMaterial();
  // The copies drew this material as plain meshes: three holds a linked program for that variant.
  renderer.properties.get(barrel).programs = new Map([["plain", renderer.program()]]);
  assert.equal(warmup.isLinked(barrel, geometry, "instanced-colour"), true);
  assert.equal(warmup.isWarm(barrel, geometry, "instanced-colour"), false,
    "the instanced program does not exist yet: drawing the instanced mesh now would build and link it");
});

test("a fresh instanced doodad mesh waits for its programs while its copies keep drawing", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const update = source.slice(source.indexOf("  #updateInstances(): void {"), source.indexOf("  #releaseWarmInstances(): void {"));
  const register = update.indexOf("if (freshMesh) this.#programWarmup.registerObject(entry.mesh);");
  const hold = update.indexOf("if (freshMesh && !this.#instancedMeshWarm(entry.mesh)) {");
  assert.ok(register >= 0 && hold > register, "held after registration, once the colours made the variant");
  assert.match(update, /if \(hold\) \{\s*entry\.mesh\.visible = false;\s*hold\.nodes = list\.map\(\(rendered\) => rendered\.node\);\s*for \(const rendered of list\) this\.#showAsPlain\(rendered\);/,
    "while held, the mesh is hidden and every copy it stands for is drawn as its own node, plain program first");
  assert.match(update, /if \(list\.length < INSTANCE_MINIMUM\) \{\s*for \(const rendered of list\) this\.#showAsPlain\(rendered\);\s*this\.#dropInstance\(key\);/,
    "a copy leaving a dropped bucket goes through the same plain-program hold");
  const showAsPlain = source.slice(source.indexOf("  #showAsPlain(rendered: RenderedEnvironment): void {"), source.indexOf("  #releaseWarmInstances(): void {"));
  assert.match(showAsPlain, /rendered\.node\.visible = true;/);
  assert.match(showAsPlain, /this\.#programWarmup\.registerObject\(rendered\.node\);\s*this\.#visualWarmHold\.hold\(visual\);/,
    "the plain variant is queued for the warm pass and the mesh waits for it (a warm mesh is left alone)");
  const release = source.slice(source.indexOf("  #releaseWarmInstances(): void {"), source.indexOf("  #instancedMeshWarm("));
  assert.match(release, /hold\.frames >= INSTANCE_WARM_HOLD_FRAMES \|\| this\.#instancedMeshWarm\(mesh\)/);
  assert.match(release, /for \(const node of hold\.nodes\) node\.visible = false;\s*mesh\.visible = true;/,
    "the swap hides the copies in the same frame the mesh appears: never both, never neither");
  assert.match(release, /if \(!mesh\.parent\) \{/, "a mesh dropped while held is forgotten");
  const warm = source.slice(source.indexOf("  #instancedMeshWarm("), source.indexOf("  #instancedMeshWarm(") + 600);
  assert.match(warm, /this\.#programWarmup\.isWarm\(material, mesh\.geometry, kind\)/);
  const draw = source.slice(source.indexOf("  draw(\n"), source.indexOf("\n  #resetFrameCounters(): void {"));
  const tick = draw.indexOf("this.#programWarmup.tick(this.#camera);");
  const released = draw.indexOf("this.#releaseWarmInstances();");
  const submit = draw.indexOf("this.#renderer.render(this.#scene, this.#camera);");
  assert.ok(tick >= 0 && released > tick && submit > released,
    "held meshes are released after the warm pass settles and before the frame is submitted");
  assert.match(source, /const INSTANCE_WARM_HOLD_FRAMES = \d+;/);
  assert.match(source, /this\.#wmoWarmHolds\.clear\(\);\s*this\.#instanceWarmHolds\.clear\(\);/, "a world reset drops every hold");
});
