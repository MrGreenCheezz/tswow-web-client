import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as THREE from "three";
import { GROUND_COVER_BUDGET, GROUND_COVER_MARGIN, createGroundCoverCellCache, groundCoverDistanceScale,
  groundCoverRecipeSource, scatterGroundCover } from "../dist/code/browser/GroundCover.js";
import { createGroundCoverFadeUniforms, installGroundCoverFade, GROUND_COVER_FADE_MARKER } from "../dist/code/browser/GroundCoverFade.js";
import { installVegetationWind, vegetationWindProfile } from "../dist/code/browser/VegetationWind.js";
import { shouldReselect } from "../dist/code/browser/RenderStats.js";
// Extract the production synchronous update rather than duplicate its reselection/fade logic.
function groundCoverRendererHarness() {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("renderer.ts", source, ts.ScriptTarget.ES2022, true);
  const renderer = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "WorldRenderer3D");
  const member = renderer.members.find(node => node.name?.getText(parsed) === "#updateGroundCover");
  assert.ok(member, "production ground-cover update exists");
  const method = member.getText(parsed).replaceAll("#", "");
  const js = ts.transpileModule(`class Harness { ${method} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // The field is reused across rebuilds, so a rebuild is counted by the scatter call, not by a
  // new field identity.
  const counted = (...args) => { scatterCalls++; return scatterGroundCover(...args); };
  const Harness = Function("shouldReselect", "scatterGroundCover", "groundCoverRecipeSource",
    "GROUND_COVER_MARGIN", "GROUND_COVER_BUDGET", "createGroundCoverCellCache", js + "; return Harness;")(
    shouldReselect, counted, groundCoverRecipeSource, GROUND_COVER_MARGIN, GROUND_COVER_BUDGET,
    createGroundCoverCellCache);
  return new Harness();
}
let scatterCalls = 0;

const recipe = { effects: new Uint32Array(1024).fill(7), winner: new Uint16Array(2048), noDoodad: new Uint8Array(2048) };
const table = { models: ["World\\NoDXT\\Detail\\ElwGra01.m2"], effects: { 7: { density: 2, terrain: 0, doodads: [[0, 1]] } } };
const centre = { x: -266, y: -266 };
const options = { recipe: () => recipe, table, centre, radius: 44, drawRadius: 40,
  perCell: true, cap: 100000, heightAt: () => 0 };
const placements = field => {
  const result = new Map();
  for (const batch of field.models.values()) for (let i = 0; i < batch.x.length; i++) {
    result.set(`${batch.x[i]}/${batch.y[i]}`, { x: batch.x[i], y: batch.y[i], scale: batch.scale[i] });
  }
  return result;
};

test("deferred distance fade retains the margin at stable authored scale across rebuilds", () => {
  const first = placements(scatterGroundCover({ ...options, deferDistanceFade: true }));
  assert.ok([...first.values()].some(p => Math.hypot(p.x - centre.x, p.y - centre.y) > 40),
    "prefetched tufts must already exist before they enter the visible radius");
  assert.ok([...first.values()].every(p => p.scale >= 0.8 && p.scale <= 1.15));
  const moved = { x: centre.x + GROUND_COVER_MARGIN - 0.01, y: centre.y };
  const next = placements(scatterGroundCover({ ...options, centre: moved, radius: 40, deferDistanceFade: true }));
  for (const [key, tuft] of next) {
    assert.ok(first.has(key), "walking less than one rebuild step must not reveal an ungenerated strip");
    assert.equal(first.get(key).scale, tuft.scale, "moving the scatter centre must not bake a new fade into matrices");
  }
  const original = placements(scatterGroundCover(options));
  for (const [key, tuft] of original) assert.equal(tuft.scale,
    first.get(key).scale * groundCoverDistanceScale(Math.hypot(tuft.x - centre.x, tuft.y - centre.y), 40),
    "the shader uses the existing distance curve, with the same authored size");
});

test("production movement updates fade uniforms without scatter uploads before the rebuild step", () => {
  const h = groundCoverRendererHarness();
  Object.assign(h, {
    groundCover: { table: () => table, get: () => recipe, generation: 0 },
    groundCoverFade: createGroundCoverFadeUniforms(), groundCoverRadius: 40,
    groundCoverSettings: 0, groundCoverDense: true, groundCoverDensity: 1,
    groundCoverMeshes: new Map(), groundCoverPending: new Set(),
    submissionSerial: 0, environmentReselectedSerial: -1,
  });
  let uploads = 0;
  h.placeGroundCover = () => { uploads++; };
  scatterCalls = 0;
  h.updateGroundCover(centre, 0, () => 0);
  const field = h.groundCoverField, firstUploads = uploads;
  assert.ok(firstUploads > 0);
  assert.equal(scatterCalls, 1);
  for (const delta of [0.1, 0.5, 1, GROUND_COVER_MARGIN - 0.01]) {
    const player = { x: centre.x + delta, y: centre.y };
    h.updateGroundCover(player, 0, () => 0);
    assert.deepEqual(h.groundCoverFade.centre.value.toArray(), [player.x, -player.y]);
    assert.equal(h.groundCoverFade.radius.value, 40);
    assert.equal(scatterCalls, 1, "no scatter for smooth movement");
    assert.equal(uploads, firstUploads, "no per-frame instance matrix uploads");
  }
  const moved = { x: centre.x + 4.1, y: centre.y };
  // The environment re-ranked on this very frame: the walked rebuild waits for the next one.
  h.submissionSerial = 7;
  h.environmentReselectedSerial = 7;
  h.updateGroundCover(moved, 0, () => 0);
  assert.equal(scatterCalls, 1, "a walked rebuild never shares a frame with the environment's");
  assert.equal(uploads, firstUploads);
  h.submissionSerial = 8;
  h.updateGroundCover(moved, 0, () => 0);
  assert.equal(scatterCalls, 2);
  assert.strictEqual(h.groundCoverField, field, "the rebuild writes over the field it had, not a new one");
  assert.ok(uploads > firstUploads);
  // It waits one frame, never two in a row, even if the environment re-ranks again.
  const next = { x: moved.x + 4.1, y: moved.y };
  h.submissionSerial = 20; h.environmentReselectedSerial = 20;
  h.updateGroundCover(next, 0, () => 0);
  assert.equal(scatterCalls, 2);
  h.submissionSerial = 21; h.environmentReselectedSerial = 21;
  h.updateGroundCover(next, 0, () => 0);
  assert.equal(scatterCalls, 3, "the second frame rebuilds regardless");
  // A new generation (a recipe landed, a setting changed) rebuilds at once, even on such a frame.
  h.environmentReselectedSerial = 8;
  h.groundCover.generation = 1;
  h.updateGroundCover(moved, 0, () => 0);
  assert.equal(scatterCalls, 4);
});

test("grass fade follows wind and keeps the same program while position and radius change", () => {
  const uniforms = createGroundCoverFadeUniforms();
  const material = new THREE.MeshBasicMaterial();
  const profile = vegetationWindProfile({ min: [0, 0, 0], max: [1, 1, 2], radius: 2 }, "World\\NoDXT\\Detail\\ElwGra01.m2");
  installVegetationWind(material, profile);
  installGroundCoverFade(material, uniforms);
  const programKey = material.customProgramCacheKey(), version = material.version;
  const shader = { uniforms: {}, vertexShader: "#include <begin_vertex>\n#include <project_vertex>", fragmentShader: "" };
  material.onBeforeCompile(shader, {});
  assert.strictEqual(shader.uniforms.uGroundCoverCentre, uniforms.centre);
  assert.strictEqual(shader.uniforms.uGroundCoverRadius, uniforms.radius);
  assert.ok(shader.vertexShader.indexOf("vegetationWindWave") < shader.vertexShader.indexOf("transformed *= groundCoverScale"));
  assert.ok(programKey.includes(GROUND_COVER_FADE_MARKER));
  uniforms.centre.value.set(1, 3);
  uniforms.radius.value = 80;
  assert.equal(material.customProgramCacheKey(), programKey);
  assert.equal(material.version, version, "a movement frame must not invalidate shader programs");
  const other = createGroundCoverFadeUniforms();
  assert.equal(other.radius.value, 0, "another renderer does not borrow this world's fade centre");
  material.dispose();
});
