import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as THREE from "three";

import {
  GOD_RAY_SAMPLES, buildFullscreenGlowPasses, buildWorldCamera, godRaySunDirection,
  godRayScreenSource, godRayVisibility,
} from "../dist/code/browser/WorldRenderer3D.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT, createCamera,
} from "../dist/code/browser/SimpleScene.js";
import {
  CAMERA_FEET_CLEARANCE, CAMERA_PITCH_LIMIT, cameraFloorPitch,
} from "../dist/code/browser/game/CameraRig.js";
import { defaultSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";

const hour = (value) => value * 120;
const worldCameraAtPitch = (pitch, yaw = 0) => {
  const rig = createCamera(
    { x: 0, y: 0, z: 0, orientation: 0 },
    yaw,
    pitch,
    CAMERA_DEFAULT_DISTANCE,
    { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT },
  );
  const camera = buildWorldCamera();
  camera.position.set(rig.position.x, rig.position.z, -rig.position.y);
  camera.lookAt(
    rig.position.x + rig.forward.x * 30,
    rig.position.z + rig.forward.z * 30,
    -(rig.position.y + rig.forward.y * 30),
  );
  camera.updateMatrixWorld();
  return camera;
};
const rendererSource = await readFile(
  new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");

test("the visible solar source sets at night while the shaping light remains independent", () => {
  assert.ok(godRaySunDirection(hour(0)).y < 0, "midnight is below the horizon");
  assert.ok(godRaySunDirection(hour(12)).y > 0, "noon is above the horizon");
  assert.ok(Math.abs(godRaySunDirection(hour(6)).y) < 1e-12, "sunrise is on the horizon");
  assert.ok(Math.abs(godRaySunDirection(hour(18)).y) < 1e-12, "sunset is on the horizon");

  const target = new THREE.Vector3();
  assert.equal(godRaySunDirection(hour(12), target), target,
    "the frame path can reuse its projection scratch without allocating");
  for (let time = 0; time < 2880; time += 37) {
    const direction = godRaySunDirection(time, target);
    assert.ok(Math.abs(direction.length() - 1) < 1e-12, `not normalised at ${time}`);
  }
  assert.equal(godRaySunDirection(Number.NaN, target).y < 0, true,
    "a malformed clock fails to the hidden midnight source");
});

test("visibility fades at the horizon, screen edge, camera back and storm", () => {
  assert.equal(godRayVisibility(0, 0, 1, 1, 0.2, 0), 0.2);
  assert.equal(godRayVisibility(1, 0, 1, 1, 0.2, 0), 0, "exact screen edge");
  assert.equal(godRayVisibility(1.1, 0, 1, 1, 0.2, 0), 0, "outside the frame");
  assert.equal(godRayVisibility(0, 0, 0, 1, 0.2, 0), 0, "on the horizon");
  assert.equal(godRayVisibility(0, 0, -0.1, 1, 0.2, 0), 0, "night");
  assert.equal(godRayVisibility(0, 0, 1, -0.1, 0.2, 0), 0, "behind the camera");
  assert.equal(godRayVisibility(0, 0, 1, 1, 0.2, 1), 0, "full storm");
  assert.ok(godRayVisibility(0.9, 0, 1, 1, 0.2, 0) > 0
    && godRayVisibility(0.9, 0, 1, 1, 0.2, 0) < 0.2,
  "the source fades before reaching the edge instead of popping there");
  assert.equal(godRayVisibility(0, 0, 1, 1, Number.NaN, 0), 0, "NaN fails closed");
});

test("lighting quality bounds the optional contribution and keeps quality zero exact", () => {
  assert.equal(lightingProfile(0).godRayStrength, 0);
  assert.equal(lightingProfile(1).godRayStrength, 0.12);
  assert.equal(lightingProfile(2).godRayStrength, 0.2);
});

test("enabling the sole god-rays switch is visible with default graphics settings", () => {
  const defaults = defaultSettings();
  const strength = lightingProfile(defaults.lightingQuality).godRayStrength;
  assert.equal(defaults.godRays, false, "the feature stays opt-in");
  assert.ok(strength > 0,
    "once the user enables the sole switch, the default quality must not silently gate it off");
  assert.ok(godRayVisibility(0, 0, 1, 1, strength, 0) > 0,
    "a centred noon sun in clear weather must reach the composite");
});

test("a legal ground camera receives clear-noon shafts from above the viewport", () => {
  const pitch = cameraFloorPitch(
    CAMERA_PITCH_LIMIT,
    CAMERA_DEFAULT_PIVOT_HEIGHT,
    CAMERA_DEFAULT_DISTANCE,
    CAMERA_FEET_CLEARANCE,
  );
  const camera = worldCameraAtPitch(pitch);

  const sun = godRaySunDirection(hour(12));
  const elevation = sun.y;
  const projected = sun.clone()
    .multiplyScalar(Math.max(1, camera.far * 0.9))
    .add(camera.position)
    .project(camera);
  assert.ok(projected.y > 1, "the physical noon sun is above the legal camera's viewport");
  const source = godRayScreenSource(camera, sun);
  assert.ok(Math.abs(source.ndcY - 1.24) < 1e-12,
    "the shader source is tangent outside the top edge");
  assert.ok(Math.abs(source.visibilityY - projected.y) < 1e-9,
    "the physical projection still owns the continuous upper-edge fade");
  assert.ok(godRayVisibility(
    source.ndcX,
    source.visibilityY,
    elevation,
    source.facing,
    lightingProfile(2).godRayStrength,
    0,
  ) > 0, "off-screen sunlight should still cast visible shafts into the top of the frame");
});

test("the default downward camera pins a vertically overhead source outside the top edge", () => {
  const camera = worldCameraAtPitch(CAMERA_DEFAULT_PITCH);
  const sun = godRaySunDirection(hour(12));
  const forward = camera.getWorldDirection(new THREE.Vector3());
  assert.ok(forward.dot(sun) < 0,
    "the physical noon source is vertically behind the ordinary downward camera");

  const source = godRayScreenSource(camera, sun);
  assert.ok(Math.abs(source.ndcX) < 1e-12, "the aligned solar azimuth stays centred");
  assert.ok(Math.abs(source.ndcY - 1.24) < 1e-12,
    "the synthetic disc is tangent outside the top edge at UV 1.12");
  assert.ok(Math.abs(source.visibilityY - 1.24) < 1e-12,
    "a vertically-behind source has settled to the bounded off-screen carry");
  assert.ok(Math.abs(source.facing - 1) < 1e-12,
    "vertical camera limits do not pretend the player turned away horizontally");
  assert.ok(Math.abs(godRayVisibility(
    source.ndcX,
    source.visibilityY,
    sun.y,
    source.facing,
    lightingProfile(2).godRayStrength,
    0,
  ) - (0.2 / 3)) < 1e-12, "off-screen noon carry is visible and strictly bounded");
});

test("screen-source projection preserves direct views and crosses the upper plane continuously", () => {
  const sun = godRaySunDirection(hour(12));
  const aimed = buildWorldCamera();
  aimed.position.set(0, 0, 0);
  aimed.lookAt(sun);
  aimed.updateMatrixWorld();
  const direct = godRayScreenSource(aimed, sun);
  assert.ok(Math.abs(direct.ndcX) < 1e-12 && Math.abs(direct.ndcY) < 1e-12);
  assert.ok(Math.abs(direct.visibilityY) < 1e-12);

  const below = godRayScreenSource(worldCameraAtPitch(THREE.MathUtils.degToRad(45)), sun);
  const above = godRayScreenSource(worldCameraAtPitch(THREE.MathUtils.degToRad(44)), sun);
  assert.ok(below.ndcY < 1, "the direct source remains inside immediately below the upper plane");
  assert.ok(Math.abs(above.ndcY - 1.24) < 1e-12,
    "only the shader coordinate is pinned after crossing the plane");
  const visible = (source, physicalSun = sun) => godRayVisibility(
    source.ndcX,
    source.visibilityY,
    physicalSun.y,
    source.facing,
    lightingProfile(2).godRayStrength,
    0,
  );
  assert.ok(Math.abs(visible(below) - visible(above)) < 0.03,
    "crossing the upper plane must not halve the contribution in one camera step");

  const angledYaw = 0.658407;
  const angledSun = godRaySunDirection(hour(11.6));
  const angledAbove = godRayScreenSource(
    worldCameraAtPitch(THREE.MathUtils.degToRad(52), angledYaw),
    angledSun,
  );
  const angledBelow = godRayScreenSource(
    worldCameraAtPitch(THREE.MathUtils.degToRad(52.05), angledYaw),
    angledSun,
  );
  assert.ok(Math.abs(angledAbove.ndcY - 1.24) < 1e-12 && angledBelow.ndcY < 1,
    "the angled fixture straddles the same upper plane");
  assert.ok(Math.abs(angledAbove.ndcX - angledBelow.ndcX) < 0.02,
    "a still-front physical X survives the upper-plane crossing");
  assert.ok(Math.abs(visible(angledAbove, angledSun) - visible(angledBelow, angledSun)) < 0.03,
    "nonzero yaw cannot turn the smooth upper fade into an on/off jump");
});

test("screen-source projection fails closed away from the sun and reuses caller scratch", () => {
  const camera = worldCameraAtPitch(CAMERA_DEFAULT_PITCH, Math.PI / 2);
  const noon = godRaySunDirection(hour(12));
  const target = { ndcX: 0, ndcY: 0, visibilityY: 0, facing: 0 };
  const projection = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  assert.equal(godRayScreenSource(camera, noon, target, projection, forward, up), target);
  assert.equal(godRayVisibility(
    target.ndcX, target.visibilityY, noon.y, target.facing, 0.2, 0,
  ), 0, "turning ninety degrees away removes the shafts");

  const midnight = godRaySunDirection(hour(0));
  const night = godRayScreenSource(camera, midnight, target, projection, forward, up);
  assert.equal(godRayVisibility(
    night.ndcX, night.visibilityY, midnight.y, night.facing, 0.2, 0,
  ), 0, "night remains exact zero");
  assert.equal(godRayVisibility(0, 0, 1, 1, 0.2, 1), 0, "storm remains exact zero");

  const flat = godRayScreenSource(
    camera, new THREE.Vector3(0, 1, 0), target, projection, forward, up,
  );
  assert.equal(godRayVisibility(
    flat.ndcX, flat.visibilityY, 1, flat.facing, 0.2, 0,
  ), 0, "a vertical vector has no invented solar azimuth");
  const invalid = godRayScreenSource(
    camera, new THREE.Vector3(Number.NaN, 0, 0), target, projection, forward, up,
  );
  assert.equal(godRayVisibility(
    invalid.ndcX, invalid.visibilityY, 1, invalid.facing, 0.2, 0,
  ), 0, "non-finite projection state fails closed before the composite");
});

test("the radial pass is fixed-cost, depth-aware and display-referred", () => {
  const passes = buildFullscreenGlowPasses();
  assert.equal(GOD_RAY_SAMPLES, 24);
  assert.match(passes.godRays.fragmentShader, /uniform sampler2D depth;/);
  assert.match(passes.godRays.fragmentShader,
    new RegExp(`for \\(int i = 0; i < ${GOD_RAY_SAMPLES}; i\\+\\+\\)`),
  "a compile-time loop avoids ANGLE dynamic indexing and a per-frame sample-count branch");
  assert.match(passes.godRays.fragmentShader, /step\(1\.0, texture2D\(depth, uv\)\.r\)/,
    "only clear sky emits; scene geometry occludes the source and march");
  assert.match(passes.godRays.fragmentShader, /transmittance \*= mix\(0\.72, 1\.0, sky\);/,
    "an occluder between the pixel and source compounds across the whole radial path");
  assert.match(passes.godRays.fragmentShader, /scattered \+= sky \* source \* decay \* transmittance;/);
  assert.match(passes.godRays.fragmentShader, /min\(scattered \* 0\.70, 1\.0\)/,
    "the off-screen source survives an eight-bit composite without raising its bounded peak");
  assert.match(passes.godRays.fragmentShader, /rayColour \* shaft/);
  assert.match(passes.composite.fragmentShader,
    /texture2D\(rays, vUV\)\.rgb \* rayStrength/);
  assert.equal(passes.godRays.uniforms.depth, passes.uniforms.depth);
  assert.equal(passes.composite.uniforms.rays, passes.uniforms.rays);
  for (const material of [passes.godRays, passes.composite]) {
    assert.equal(material.toneMapped, false);
    assert.equal(material.depthTest, false);
    assert.equal(material.depthWrite, false);
    assert.equal(material.fragmentShader.includes("colorspace_fragment"), false,
      "the captured frame is already display-referred; no second encode is allowed");
  }
});

test("three r185 resolves multisample depth only behind the target flag", async () => {
  const textures = await readFile(
    new URL(import.meta.resolve("three/src/renderers/webgl/WebGLTextures.js")), "utf8");
  assert.match(textures,
    /if \( renderTarget\.resolveDepthBuffer \) \{\s*if \( renderTarget\.depthBuffer \) mask \|= _gl\.DEPTH_BUFFER_BIT;/,
  "the sampled DepthTexture depends on the exact flag the shared target toggles around world draw");
  assert.match(textures,
    /_gl\.blitFramebuffer\( 0, 0, width, height, 0, 0, width, height, mask, _gl\.NEAREST \);/,
  "the multisample attachment is copied into the texture the radial shader samples");
});

test("the opt-in leaf shares capture with glow and pays depth only while active", async () => {
  const model = await readFile(new URL("../src/browser/ui/SettingsModel.ts", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  const definition = settingDefinition("godRays");
  assert.ok(definition);
  assert.equal(definition.kind, "boolean");
  assert.equal(definition.fallback, false);
  assert.equal(defaultSettings().godRays, false);
  assert.match(model, /id: "godRays", label: "Faithful-plus: солнечные лучи"/);
  assert.match(settings, /setGodRays\?\.\(settingBoolean\(values, "godRays"\)\)/);

  assert.match(rendererSource, /#godRaysEnabled = false;/);
  assert.match(rendererSource,
    /return this\.#godRaysEnabled && this\.#lightingProfile\.godRayStrength > 0;/);
  assert.match(rendererSource,
    /if \(!this\.#fullscreenGlowEnabled && !this\.#godRaysActive\(\)\) return undefined;/,
  "OFF/OFF retains the original direct sky-plus-world path");

  const sync = rendererSource.slice(
    rendererSource.indexOf("#syncFullscreenGlowTargets(): void {"),
    rendererSource.indexOf("#disposeFullscreenGlowTargets(): void {"));
  assert.match(sync, /current\.godRays === godRays/,
    "changing the depth topology invalidates an otherwise same-sized target");
  assert.match(sync, /new THREE\.DepthTexture\(size\.width, size\.height, THREE\.UnsignedIntType\)/);
  assert.match(sync, /resolveDepthBuffer: godRays,/,
    "glow alone keeps its no-depth-resolve baseline; shafts explicitly pay the resolve");
  assert.match(sync, /godRays,/);

  const draw = rendererSource.slice(
    rendererSource.indexOf("  draw("), rendererSource.indexOf("  #resetFrameCounters(): void {"));
  const enableResolve = draw.indexOf("if (glow?.godRays) glow.scene.resolveDepthBuffer = true;");
  const worldDraw = draw.indexOf("this.#renderer.render(this.#scene, this.#camera);", enableResolve);
  const overlayDraw = draw.indexOf("this.#drawUnderwaterOverlay(now);", worldDraw);
  const disableResolve = draw.indexOf("if (glow?.godRays) glow.scene.resolveDepthBuffer = false;", overlayDraw);
  assert.ok(enableResolve >= 0 && worldDraw > enableResolve && overlayDraw > worldDraw
    && disableResolve > overlayDraw,
  "sky skips depth resolve; world and a rare overlay draw preserve depth before the radial pass");

  const composeStart = rendererSource.indexOf(
    "#composeFullscreenGlow(targets: GlowChainTargets | undefined): void {",
  );
  const compose = rendererSource.slice(
    composeStart,
    rendererSource.indexOf("#endFullscreenGlow(", composeStart));
  const vertical = compose.indexOf("this.#renderer.setRenderTarget(targets.blurA);");
  const radial = compose.indexOf("quad.material = this.#glowPasses.godRays;", vertical);
  const reuse = compose.indexOf("this.#renderer.setRenderTarget(targets.blurB);", radial);
  assert.ok(vertical >= 0 && radial > vertical && reuse > radial,
    "blurB is reused only after vertical bloom has preserved its result in blurA");
  assert.match(compose, /!this\.#lightSample \|\| this\.#underwater\) return 0;/,
    "no authored sky and underwater views stay free of synthetic shafts");
  assert.match(compose, /this\.#weatherFade\.storm/);
});

test("depth samplers and the fourth material are released with the shared chain", () => {
  const dispose = rendererSource.slice(
    rendererSource.indexOf("  dispose(): void {"),
    rendererSource.indexOf("The rings, laid on whatever the two marked units"));
  assert.match(dispose, /this\.#glowPasses\.godRays,/);
  const release = rendererSource.slice(
    rendererSource.indexOf("#disposeFullscreenGlowTargets(): void {"),
    rendererSource.indexOf("setLightingQuality", rendererSource.indexOf("#disposeFullscreenGlowTargets(): void {")));
  assert.match(release, /this\.#glowPasses\.uniforms\.depth\.value = null;/);
  assert.match(release, /this\.#glowPasses\.uniforms\.rays\.value = null;/);
  assert.match(release, /for \(const target of \[targets\.scene, targets\.blurA, targets\.blurB\]\) target\.dispose\(\);/);
});
