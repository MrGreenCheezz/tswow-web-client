// 15.11 (7.66 last stretch, 7.58; fade9): a doodad fades over the last yards of its class distance, measured from the
// camera to its sphere's centre in 3D (Wow.exe 0x00791cb0, 0x0078f570), instead of popping at a distance taken across the
// ground from the player.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  DOODAD_CLASS_FADES, doodadCandidateSlack, doodadFadeAlpha, doodadFirstSightFades, doodadViewAlpha, doodadViewDistance,
  doodadViewMeasured,
} from "../dist/code/browser/DoodadFade.js";
import {
  DoodadFadeInstances, doodadFadeFragment, doodadFadeMaterial, doodadFadeVertex,
} from "../dist/code/browser/DoodadFadeInstances.js";
import { clearDoodadModelBoxes, recordDoodadModelBox } from "../dist/code/browser/DoodadReach.js";
import { admitEnvironmentInto, environmentRankInRange } from "../dist/code/browser/WorldRenderer3D.js";

const m2 = (name, extra = {}) => ({
  id: 1, kind: "m2", name, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, ...extra,
});
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test("0x00791cb0: whole inside D − L, a linear ramp to 0 at D, above 0.99 whole, at or below 0.01 not drawn", () => {
  assert.deepEqual(DOODAD_CLASS_FADES, [5, 10, 15, 20, 50]);
  // Class 1 at environmentDetail 1: D = 100, L = 10.
  assert.equal(doodadFadeAlpha(50, 100, 10), 1);
  assert.equal(doodadFadeAlpha(90, 100, 10), 1, "the fade starts at D − L");
  close(doodadFadeAlpha(95, 100, 10), 0.5, "half way");
  close(doodadFadeAlpha(92.5, 100, 10), 0.75, "a quarter in");
  assert.equal(doodadFadeAlpha(90.05, 100, 10), 1, "0.995 counts as whole (0x009e2ff4)");
  assert.equal(doodadFadeAlpha(99.95, 100, 10), 0, "0.005 is not drawn (0x009f1968)");
  assert.equal(doodadFadeAlpha(99.9, 100, 10), 0, "0.01 is not drawn either");
  assert.equal(doodadFadeAlpha(100, 100, 10), 0);
  assert.equal(doodadFadeAlpha(140, 100, 10), 0);
  // Class 4: the last 50 yards of 1250.
  close(doodadFadeAlpha(1225, 1250, 50), 0.5, "class 4");
});

test("the faithful levels measure from the camera to the sphere's centre in 3D; the enhanced from the player", () => {
  clearDoodadModelBoxes();
  // A bush whose box's longest side is 10 yards: class 2, 200 yards at detail 1, a 15-yard fade.
  recordDoodadModelBox("bush.m2", { min: [-5, -2, 0], max: [5, 2, 6] });
  const bush = m2("bush.m2", { x: 0, y: 0, z: 0 });
  const sphere = { x: 0, y: 3, z: 0 };
  const faithful = { eye: { x: 0, y: 3, z: 190 }, player: { x: 0, y: 0 }, camera3d: true };
  close(doodadViewDistance(bush, sphere, faithful), 190, "scene axes: the eye straight out along z");
  close(doodadViewAlpha(bush, 200, sphere, faithful, 1), 1 - (190 - 185) / 15, "class 2 in its band");
  // From the air: 120 yards across the ground but 160 up — 200 in 3D, past the class distance.
  const air = { eye: { x: 0, y: 163, z: -120 }, player: { x: 0, y: -120 }, camera3d: true };
  assert.equal(doodadViewAlpha(bush, 200, sphere, air, 1), 0, "from the air the bush is gone as in Wow.exe");
  // The enhanced levels keep their own leash (here 120), measured across the ground from the player, live.
  const enhanced = { eye: { x: 0, y: 0, z: 0 }, player: { x: 0, y: 110 }, camera3d: false };
  close(doodadViewAlpha(bush, 120, sphere, enhanced, 1), 1 - (110 - 105) / 15, "the enhanced leash's last 15 yards");
  assert.equal(doodadViewAlpha(m2("unknown.m2"), 120, undefined, enhanced, 1), 1, "no fade before the class is known");
  assert.equal(doodadViewAlpha(m2("bush.m2", { biodome: true }), 120, sphere, enhanced, 1), 1, "a biodome never fades (0x800)");
  assert.equal(doodadViewMeasured(m2("bush.m2", { interior: true })), false, "map objects' doodads keep their rooms' leash");
  assert.equal(doodadFirstSightFades(bush, 110, 120), true, "a first sight in the band: the fade brings it in");
  assert.equal(doodadFirstSightFades(bush, 50, 120), false);
});

test("admission takes a measured doodad's leash under the view; candidates carry the camera's slack", () => {
  clearDoodadModelBoxes();
  recordDoodadModelBox("bush.m2", { min: [-5, -2, 0], max: [5, 2, 6] });
  const near = m2("bush.m2", { id: 1, x: 150, y: 0 });
  const behind = m2("bush.m2", { id: 2, x: -230, y: 0 });
  const player = { x: 0, y: 0 };
  const strict = environmentRankInRange([near, behind], player, 1, 1277, true);
  assert.deepEqual(strict.candidates.map((c) => c.object.id), [1], "without the slack only the leash");
  const ranked = environmentRankInRange([near, behind], player, 1, 1277, true, true);
  assert.deepEqual(ranked.candidates.map((c) => c.object.id), [1, 2], "230 < 200 + 60: still a candidate");
  assert.equal(doodadCandidateSlack(near, true), 60);
  assert.equal(doodadCandidateSlack(near, false), 4);
  const admit = (view) => admitEnvironmentInto(ranked.candidates, [], undefined, 0, [], undefined, undefined, true, view)
    .map((c) => c.object.id);
  assert.deepEqual(admit(undefined), [1], "no view: the ground distance from the ranking");
  // The camera 40 yards behind the player towards the second bush, at its height: 190 yards from either in 3D.
  const back = { eye: { x: -40, y: 0, z: 0 }, player, camera3d: true };
  assert.deepEqual(admit(back), [1, 2], "the camera has it within 200 yards: Wow.exe draws it");
  // The camera 200 yards up: the near bush is 250 yards away in 3D.
  const up = { eye: { x: 0, y: 200, z: 0 }, player, camera3d: true };
  assert.deepEqual(admit(up), [], "from 200 yards up both are past the class distance");
});

test("7.58 from the air: a tree whose trunk is below the view and whose crown is in it is admitted, whole", () => {
  clearDoodadModelBoxes();
  // A 20-yard tree: class 3, 750 yards at detail 1; its sphere's centre 10 yards up, radius 12.
  recordDoodadModelBox("tree.m2", { min: [-6, -6, 0], max: [6, 6, 20] });
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.2, 2000);
  camera.position.set(0, 150, 0); // flying 150 yards up
  camera.rotation.set(THREE.MathUtils.degToRad(-35), 0, 0, "YXZ"); // looking ahead (−z = map +y) and down
  camera.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(matrix);
  // The bottom edge of the view on the ground: find a spot where the foot is out of view and the crown's top in it.
  let spot;
  for (let ahead = 20; ahead < 400; ahead += 0.5) {
    const foot = frustum.containsPoint(new THREE.Vector3(0, 0, -ahead));
    const top = frustum.containsPoint(new THREE.Vector3(0, 20, -ahead));
    if (!foot && top) { spot = ahead; break; }
  }
  assert.ok(spot !== undefined, "such a spot exists under this camera");
  const tree = m2("tree.m2", { id: 7, x: 0, y: spot, z: 0, admissionRadius: 12 });
  const sphere = { x: 0, y: 10, z: -spot, radius: 12 };
  const player = { x: 0, y: 0 };
  const view = { eye: { x: 0, y: 150, z: 0 }, player, camera3d: true };
  const ranked = environmentRankInRange([tree], player, 1, 1277, true, true);
  const admitted = admitEnvironmentInto(ranked.candidates, frustum.planes, () => sphere, 0, [], undefined, undefined, true, view);
  assert.deepEqual(admitted.map((c) => c.object.id), [7], "its sphere is in view: admitted");
  assert.equal(doodadViewAlpha(tree, ranked.candidates[0].range, sphere, view, 1), 1, "well inside 730 yards: whole");
  // The same tree pushed past its class distance in 3D is the only thing that drops it — as in Wow.exe.
  const far = m2("tree.m2", { id: 8, x: 0, y: 745, z: 0, admissionRadius: 12 });
  const farSphere = { x: 0, y: 10, z: -745, radius: 12 };
  assert.equal(doodadViewAlpha(far, 750, farSphere, view, 1), 0, "758 yards in 3D from 150 up: past 750");
});

test("the fade copies: alpha times the copy's after the fog, cut at 0.01, transparent, a key of their own", () => {
  const vertex = doodadFadeVertex(THREE.ShaderLib.lambert.vertexShader);
  assert.match(vertex, /^attribute float doodadFade;/);
  assert.match(vertex, /void main\(\) \{\n\tvDoodadFade = doodadFade;/);
  const fragment = doodadFadeFragment(THREE.ShaderLib.lambert.fragmentShader);
  assert.match(fragment, /#include <dithering_fragment>\n\tif \( vDoodadFade <= 0\.01 \) discard;\n\tgl_FragColor\.a \*= vDoodadFade;/);
  assert.ok(fragment.indexOf("vDoodadFade <=") > fragment.indexOf("#include <fog_fragment>"), "after the fog");
  assert.ok(fragment.indexOf("vDoodadFade <=") > fragment.indexOf("#include <alphatest_fragment>"),
    "after the cut-out: a·f > t·f is a > t, the authored cut-out");
  const source = new THREE.MeshLambertMaterial({ opacity: 1 });
  source.alphaTest = 224 / 255;
  source.customProgramCacheKey = () => "wvm-fog-1";
  const copy = doodadFadeMaterial(source);
  assert.equal(copy.transparent, true, "an opaque or cut-out batch blends while it fades (fadeMaterial's rule)");
  assert.equal(copy.depthWrite, source.depthWrite, "depth as authored");
  assert.equal(copy.alphaTest, source.alphaTest);
  assert.equal(copy.customProgramCacheKey(), "wvm-fog-1|doodad-fade");
  assert.equal(doodadFadeMaterial(source), copy, "one copy per source");
  let chained = 0;
  source.onBeforeCompile = () => { chained++; };
  const shader = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  copy.onBeforeCompile(shader, undefined);
  assert.equal(chained, 1, "the source's chain runs first");
  assert.match(shader.fragmentShader, /gl_FragColor\.a \*= vDoodadFade/);
});

test("the fade pass claims its copies only once its programs are warm, and says when the claimed set changes", () => {
  let warm = false;
  let registered = 0;
  const pass = new DoodadFadeInstances({ register: () => { registered++; }, unregister: () => {}, warm: () => warm });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const materials = [new THREE.MeshLambertMaterial()];
  const a = {}, b = {};
  const run = (entries) => {
    pass.begin();
    for (const [owner, alpha] of entries) pass.add("bush", owner, geometry, materials, new THREE.Matrix4(), undefined, alpha);
    return pass.commit();
  };
  assert.equal(run([[a, 0.5]]), false, "not warm: nothing claimed, the copy stays in its bucket");
  assert.equal(pass.claims(a), false);
  assert.equal(registered, 1);
  assert.equal(pass.group.children[0].visible, false);
  warm = true;
  assert.equal(run([[a, 0.5]]), true, "warm: claimed");
  assert.equal(pass.claims(a), true);
  const mesh = pass.group.children[0];
  assert.equal(mesh.visible, true);
  assert.equal(mesh.renderOrder, -1, "first among the transparent draws, as the opaque doodads it stands in for");
  assert.equal(mesh.count, 1);
  assert.equal(mesh.geometry.getAttribute("doodadFade").getX(0), 0.5);
  assert.equal(mesh.geometry.getAttribute("position"), geometry.getAttribute("position"), "the model's buffers are shared");
  assert.notEqual(mesh.geometry, geometry, "the model's own geometry is not touched");
  assert.equal(geometry.getAttribute("doodadFade"), undefined);
  assert.equal(run([[a, 0.25]]), false, "a new alpha alone changes no claim");
  assert.equal(mesh.geometry.getAttribute("doodadFade").getX(0), 0.25);
  assert.equal(run([[a, 0.25], [b, 0.75]]), true, "one more copy");
  assert.equal(run([]), true, "none left");
  assert.equal(pass.claims(a), false);
  assert.equal(pass.meshes, 0);
});
