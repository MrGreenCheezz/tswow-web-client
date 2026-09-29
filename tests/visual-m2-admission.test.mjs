import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  environmentCandidatesInRange, environmentSourceVisibilitySphere, selectEnvironmentAdmission,
} from "../dist/code/browser/WorldRenderer3D.js";
import { staticM2AdmissionRadius } from "../tools/m2.mjs";
import { clientArchives } from "../tools/mpq.mjs";
import { clientDirectory } from "../tools/paths.mjs";

const goldshireTile = new URL("../data/visual-tiles/0/49-31.json", import.meta.url);
const withGoldshireTile = { skip: existsSync(goldshireTile) ? false : "Goldshire visual tile is not prepared" };
let sourceClient;
try { sourceClient = clientDirectory(); } catch { /* Optional corpus on other machines. */ }
const withSourceClient = { skip: sourceClient ? false : "3.3.5a client is not available" };

test("source M2 admission uses all vertices around the placement origin and rejects moving art", withSourceClient, async () => {
  const archives = await clientArchives(sourceClient);
  try {
    const tree = await archives.read("WORLD\\AZEROTH\\ELWYNN\\PASSIVEDOODADS\\TREES\\ELWYNNTREEMID01.M2");
    const lamp = await archives.read("WORLD\\AZEROTH\\ELWYNN\\PASSIVEDOODADS\\LAMPPOST\\LAMPPOST.M2");
    assert.ok(tree && lamp);
    const radius = staticM2AdmissionRadius(tree);
    assert.ok(radius > 11.7, "the MD20 header radius alone is too small around the placement origin");
    assert.equal(staticM2AdmissionRadius(lamp), undefined, "the animated lamppost needs fail-open admission");
    const particles = Buffer.from(tree);
    particles.writeUInt32LE(1, 0x128);
    assert.equal(staticM2AdmissionRadius(particles), undefined);
    const malformed = Buffer.from(tree);
    malformed.writeUInt32LE(malformed.length, 0x40);
    assert.equal(staticM2AdmissionRadius(malformed), undefined);
    assert.equal(staticM2AdmissionRadius(Buffer.from(tree.subarray(0, 0x12c))), undefined,
      "a partial MD20 header must fail open without reading beyond the buffer");
    const embedded = Buffer.from(tree);
    embedded.writeUInt32LE(0, 0x40);
    assert.equal(staticM2AdmissionRadius(embedded), undefined,
      "the vertex table cannot point into the MD20 header");
  } finally {
    archives.close();
  }
});

test("unsafe or absent M2 admission radii fail open", () => {
  const object = {
    id: 1, kind: "m2", name: "Unknown.m2", x: -10, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  };
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const candidate = [{ object, distance: 10 }];
  assert.equal(environmentSourceVisibilitySphere(object), undefined);
  assert.equal(selectEnvironmentAdmission(candidate, [plane]).length, 1);
  assert.equal(environmentSourceVisibilitySphere({ ...object, admissionRadius: -1 }), undefined);
  assert.equal(selectEnvironmentAdmission([{ object: { ...object, admissionRadius: -1 }, distance: 10 }], [plane]).length, 1);
  assert.equal(selectEnvironmentAdmission([{ object: { ...object, admissionRadius: 0 }, distance: 10 }], [plane]).length, 0);
});

test("an authored Goldshire tree in the camera view survives cold scenery admission", withGoldshireTile, async () => {
  const objects = JSON.parse(await readFile(goldshireTile, "utf8"));
  const tree = objects.find((object) => object.id === 12096);
  assert.equal(tree?.name, "WORLD\\AZEROTH\\ELWYNN\\PASSIVEDOODADS\\TREES\\ELWYNNTREEMID01.M2");
  assert.ok(Number.isFinite(tree.admissionRadius) && tree.admissionRadius > 0,
    "the visual tile must carry a source-backed pre-admission radius for this static M2");

  const player = { x: -9461.82, y: 63.31, z: 56.23 };
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
  camera.position.set(player.x, player.z + 2, -player.y);
  camera.lookAt(tree.x, tree.z + 2, -tree.y);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  assert.equal(frustum.containsPoint(new THREE.Vector3(tree.x, tree.z + 2, -tree.y)), true);

  const admitted = selectEnvironmentAdmission(environmentCandidatesInRange(objects, player), frustum.planes);
  assert.equal(admitted.some(({ object }) => object.id === tree.id), true,
    "nearer M2s behind the camera must not exclude a tree inside the view");
});
