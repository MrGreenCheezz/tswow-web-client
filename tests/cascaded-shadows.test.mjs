import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  CascadedSunShadows, SHADOW_CASCADE_BLEND, SHADOW_FAR_IDLE_REFRESH_MS, SHADOW_FAR_LAYER, SHADOW_PROXY_LAYER,
  farCascadeReason, farCascadeStale,
} from "../dist/code/browser/CascadedShadows.js";
import {
  SHADOW_FADE_FRACTION, frustumSliceSphere, lightingProfile,
} from "../dist/code/browser/LightingQuality.js";
import {
  WORLD_LIGHT_BODY, applyWorldLight, createWorldLightUniforms,
} from "../dist/code/browser/WorldLighting.js";
import { wmoShadowProxyGeometry } from "../dist/code/browser/WorldRenderer3D.js";

/** A renderer stand-in with exactly what the cascades touch: a shadow map to wrap and a draw counter. */
function fakeRenderer() {
  const calls = [];
  const renderer = {
    info: { render: { calls: 0 } },
    shadowMap: {
      render(lights, scene, camera) {
        calls.push({
          lights: [...lights], camera, needsUpdate: lights.map((light) => light.shadow.needsUpdate), scene,
          meshes: scene.isScene ? null : scene.children.flatMap((group) => group.children),
          shown: scene.isScene ? null : scene.children.flatMap((group) => group.children).map((mesh) => mesh.visible),
        });
        renderer.info.render.calls += lights.length;
        // three allocates a light's map on its first shadow render.
        for (const light of lights) light.shadow.map ??= { dispose() {} };
      },
    },
  };
  return { renderer, calls };
}

function makeCamera() {
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 4000);
  camera.position.set(-9600, 60, 300);
  camera.lookAt(-9570, 55, 330);
  camera.updateMatrixWorld();
  return camera;
}

function setup(quality = 2, maxTextureSize = 4096) {
  const scene = new THREE.Scene();
  const primary = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(primary, primary.target);
  const uniforms = createWorldLightUniforms();
  const cascades = new CascadedSunShadows(primary, uniforms.wowShadowFade);
  const { renderer, calls } = fakeRenderer();
  const profile = lightingProfile(quality, { shadowMaps: true, maxTextureSize });
  cascades.configure(scene, renderer, profile);
  return { scene, primary, uniforms, cascades, renderer, calls, profile };
}

/** Texel coordinates of a world point in one cascade's current map. */
function texelOf(light, point) {
  light.shadow.updateMatrices(light);
  const coord = point.clone().applyMatrix4(light.shadow.matrix);
  return { u: coord.x * light.shadow.mapSize.x, v: coord.y * light.shadow.mapSize.y };
}

const fraction = (value) => value - Math.floor(value);
const sunTowards = new THREE.Vector3(0.19, 0.53, -0.84);

test("lighting profiles: quality 0 has no cascades; 1 is fewer and smaller; 2 is the full set", () => {
  const off = lightingProfile(0, { shadowMaps: true, maxTextureSize: 16384 });
  assert.equal(off.shadowCascades, 0);
  assert.deepEqual(off.shadowCascadeSplits, []);
  assert.equal(off.shadowDistance, 0);
  assert.equal(off.shadowFarMapSize, 0);

  const balanced = lightingProfile(1, { shadowMaps: true, maxTextureSize: 4096 });
  const high = lightingProfile(2, { shadowMaps: true, maxTextureSize: 4096 });
  assert.equal(balanced.shadowCascades, 2);
  assert.equal(high.shadowCascades, 3);
  assert.equal(balanced.shadowCascadeSplits.length, balanced.shadowCascades - 1);
  assert.equal(high.shadowCascadeSplits.length, high.shadowCascades - 1);
  assert.ok(balanced.shadowDistance < high.shadowDistance);
  assert.ok(balanced.shadowFarMapSize <= high.shadowFarMapSize);
  for (const profile of [balanced, high]) {
    // The fade covers the last ~22% of the reach, measured from the camera.
    assert.ok(Math.abs(profile.shadowFadeStart - profile.shadowDistance * (1 - SHADOW_FADE_FRACTION)) < 1e-9);
    assert.ok(SHADOW_FADE_FRACTION >= 0.2 && SHADOW_FADE_FRACTION <= 0.25);
    // Units cast only inside the per-frame cascades.
    assert.ok(profile.shadowExtent <= profile.shadowCascadeSplits.at(-1));
    const splits = profile.shadowCascadeSplits;
    for (let index = 1; index < splits.length; index++) assert.ok(splits[index] > splits[index - 1]);
    assert.ok(splits.at(-1) < profile.shadowFadeStart);
  }

  assert.equal(lightingProfile(2, { shadowMaps: true, maxTextureSize: 1024 }).shadowFarMapSize, 1024);
  const small = lightingProfile(2, { shadowMaps: true, maxTextureSize: 512 });
  assert.equal(small.shadowCascades, 2, "a 512-limited context gets balanced's cascade set");
  assert.equal(small.shadowFarMapSize, 512);
  assert.equal(lightingProfile(2, { shadowMaps: false, maxTextureSize: 16384 }).shadowCascades, 0);
});

test("a slice sphere encloses its frustum slice and depends on nothing that turns with the camera", () => {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(26));
  for (const [near, far, aspect] of [[0.25, 28, 16 / 9], [23.8, 90, 16 / 9], [0.25, 45, 4 / 3], [40, 200, 21 / 9]]) {
    const sphere = frustumSliceSphere(near, far, tanHalf, aspect);
    for (const depth of [near, far]) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const x = sx * depth * tanHalf * aspect;
          const y = sy * depth * tanHalf;
          const distance = Math.hypot(x, y, depth - sphere.depth);
          assert.ok(distance <= sphere.radius + 1e-9, `corner outside ${near}-${far}`);
        }
      }
    }
    assert.ok(sphere.depth <= far && sphere.depth >= 0);
  }
});

test("view-fitted cascades keep their texel grid while the camera moves and turns", () => {
  const { cascades, scene } = setup(2);
  const camera = makeCamera();
  const lights = cascades.lights;
  assert.equal(lights.length, 3);
  const probe = new THREE.Vector3(-9585, 54, 318);
  const extents = lights.map(() => new Set());
  const phases = lights.map(() => undefined);
  let frame = 0;
  for (const [dx, dz, yaw] of [[0, 0, 0], [0.013, 0.007, 0], [0.4, -0.31, 0.02], [1.7, 0.9, 0.3], [3.1, 2.2, -0.5]]) {
    camera.position.set(-9600 + dx, 60, 300 + dz);
    camera.rotation.set(0, yaw, 0);
    camera.rotateX(-0.25);
    camera.updateMatrixWorld();
    cascades.update(camera, sunTowards, ++frame);
    // Only the view-fitted cascades move every frame; the cached one is checked separately.
    for (let index = 0; index < lights.length - 1; index++) {
      const light = lights[index];
      extents[index].add(light.shadow.camera.right);
      const { u, v } = texelOf(light, probe);
      const phase = [fraction(u), fraction(v)];
      if (phases[index] === undefined) phases[index] = phase;
      // A snapped map slides by whole texels: a static point keeps its sub-texel position.
      assert.ok(Math.abs(phases[index][0] - phase[0]) < 1e-3 || Math.abs(Math.abs(phases[index][0] - phase[0]) - 1) < 1e-3,
        `cascade ${index} u phase ${phases[index][0]} -> ${phase[0]}`);
      assert.ok(Math.abs(phases[index][1] - phase[1]) < 1e-3 || Math.abs(Math.abs(phases[index][1] - phase[1]) - 1) < 1e-3,
        `cascade ${index} v phase ${phases[index][1]} -> ${phase[1]}`);
    }
  }
  for (let index = 0; index < lights.length - 1; index++) {
    assert.equal(extents[index].size, 1, `cascade ${index} changed its size while the camera turned`);
  }
  assert.ok(lights[0].shadow.camera.right < lights[1].shadow.camera.right);
  assert.ok(lights.slice(1).every((light) => scene.children.includes(light)), "added cascades join the scene");
});

test("the outermost cascade is cached and re-rendered only when it must be", () => {
  const { cascades, renderer, calls, profile, scene } = setup(2);
  const camera = makeCamera();
  const lights = cascades.lights;
  const far = lights.at(-1);
  // 144 Hz unless a test moves the clock itself (P2-02b: the interval also waits on the clock).
  let farRendered = 0;
  cascades.setFarRenderListener(() => farRendered++);
  const renderFrame = (frame, ms = frame * 6.944) => {
    cascades.update(camera, sunTowards, frame, ms);
    calls.length = 0;
    renderer.shadowMap.render(lights, scene, camera);
    return calls.map((call) => call.lights[0]);
  };
  assert.deepEqual(renderFrame(1), lights, "the first frame renders every cascade");
  assert.deepEqual(renderFrame(2), lights.slice(0, -1), "a still camera leaves the cached cascade alone");
  camera.position.x += 3;
  camera.updateMatrixWorld();
  assert.equal(renderFrame(3).includes(far), false, "a few yards stay inside its margin");
  camera.position.x += 40;
  camera.updateMatrixWorld();
  assert.equal(renderFrame(4).includes(far), true, "leaving the margin re-renders it");
  assert.equal(renderFrame(5).includes(far), false);
  assert.equal(renderFrame(5 + profile.shadowFarRefreshFrames).includes(far), false,
    "P2-02b: the frame interval alone no longer re-draws an unchanged map");
  const idle = 4 * 6.944 + SHADOW_FAR_IDLE_REFRESH_MS;
  assert.equal(renderFrame(6 + profile.shadowFarRefreshFrames, idle - 1).includes(far), false, "just short of the clock interval");
  assert.equal(renderFrame(7 + profile.shadowFarRefreshFrames, idle).includes(far), true, "the clock interval re-renders it");
  assert.equal(renderFrame(8 + profile.shadowFarRefreshFrames, idle + 4000).includes(far), false,
    "and the frame interval still holds it back right after a render, however much time passed");
  cascades.invalidateFar();
  assert.equal(renderFrame(9 + profile.shadowFarRefreshFrames, idle + 4001).includes(far), true, "a caster change re-renders it");
  assert.equal(renderFrame(10 + profile.shadowFarRefreshFrames, idle + 4002).includes(far), false);
  const turned = new THREE.Vector3(0.3, 0.5, -0.8);
  cascades.update(camera, turned, 11 + profile.shadowFarRefreshFrames, idle + 4003);
  calls.length = 0;
  renderer.shadowMap.render(lights, scene, camera);
  assert.equal(calls.some((call) => call.lights[0] === far), true, "a turned sun re-renders it");
  // P2-02b: a rigged far caster keeps the frame interval; without one the clock holds it back.
  const renderTurned = (frame, ms) => {
    cascades.update(camera, turned, frame, ms);
    calls.length = 0;
    renderer.shadowMap.render(lights, scene, camera);
    return calls.some((call) => call.lights[0] === far);
  };
  const R = profile.shadowFarRefreshFrames;
  assert.equal(renderTurned(11 + 2 * R, idle + 4003 + R * 6.944), false, "still: the clock holds it back");
  cascades.setFarAnimated(true);
  assert.equal(renderTurned(12 + 2 * R, idle + 4003 + (R + 1) * 6.944), true, "animated: the frame interval re-renders it");
  assert.equal(renderTurned(13 + 2 * R, idle + 4003 + (R + 2) * 6.944), false, "and not again on the next frame");
  cascades.setFarAnimated(false);
  assert.equal(renderTurned(13 + 3 * R, idle + 4003 + (2 * R + 2) * 6.944), false);

  assert.equal(farCascadeStale({ dirty: false, framesSinceRender: 1, refreshFrames: 30, offset: 5, margin: 20, sunDot: 1 }), false);
  assert.equal(farCascadeStale({ dirty: false, framesSinceRender: 1, refreshFrames: 30, offset: 11, margin: 20, sunDot: 1 }), true);
  assert.equal(farCascadeStale({ dirty: false, framesSinceRender: 1, refreshFrames: 30, offset: Number.NaN, margin: 20, sunDot: 1 }), true);
  // P2-02b: without a clock the frame interval decides as before; with one, both must have passed.
  assert.equal(farCascadeStale({ dirty: false, framesSinceRender: 30, refreshFrames: 30, offset: 5, margin: 20, sunDot: 1 }), true);
  assert.equal(farCascadeStale({ dirty: false, framesSinceRender: 30, refreshFrames: 30, offset: 5, margin: 20, sunDot: 1, msSinceRender: 1999, idleRefreshMs: 2000 }), false);
  assert.equal(farCascadeStale({ dirty: false, framesSinceRender: 30, refreshFrames: 30, offset: 5, margin: 20, sunDot: 1, msSinceRender: 2000, idleRefreshMs: 2000 }), true);
  assert.equal(farCascadeStale({ dirty: false, framesSinceRender: 29, refreshFrames: 30, offset: 5, margin: 20, sunDot: 1, msSinceRender: 9000, idleRefreshMs: 2000 }), false);
  // One reason per render, the first that holds.
  const base = { dirty: false, extentChanged: false, framesSinceRender: 1, refreshFrames: 30, offset: 5, margin: 20, sunDot: 1, msSinceRender: 10, idleRefreshMs: 2000 };
  assert.equal(farCascadeReason(base), undefined);
  assert.equal(farCascadeReason({ ...base, dirty: true, offset: 50 }), "dirty");
  assert.equal(farCascadeReason({ ...base, extentChanged: true, offset: 50 }), "extent");
  assert.equal(farCascadeReason({ ...base, offset: 50, sunDot: 0.5 }), "offset");
  assert.equal(farCascadeReason({ ...base, sunDot: 0.5 }), "sun");
  assert.equal(farCascadeReason({ ...base, framesSinceRender: 30, msSinceRender: 2000 }), "interval");
  const snapshot = cascades.stats;
  assert.equal(snapshot.farReasons.dirty + snapshot.farReasons.offset + snapshot.farReasons.sun + snapshot.farReasons.interval
    + snapshot.farReasons.extent, snapshot.cascades.at(-1).renders, "every cached render has one reason");
  assert.ok(snapshot.cascades.every((cascade) => cascade.cpuMsTotal >= cascade.cpuMsMax && cascade.drawCallsTotal >= 0));
  assert.equal(farRendered, snapshot.cascades.at(-1).renders, "the listener hears every cached render, and nothing else");
  // Scheduled but never rendered (the far light left out of the call): no reason is counted.
  cascades.invalidateFar();
  cascades.update(camera, turned, 14 + 3 * R, idle + 9000);
  renderer.shadowMap.render(lights.slice(0, -1), scene, camera);
  assert.deepEqual(cascades.stats.farReasons, snapshot.farReasons);
  assert.equal(farRendered, snapshot.cascades.at(-1).renders);
});

test("each cascade is drawn through a camera whose layers name its casters", () => {
  const { cascades, renderer, calls, scene } = setup(2);
  const camera = makeCamera();
  let shown = 0;
  let hidden = 0;
  cascades.setShadowOnlyCasters((on) => {
    if (on) shown++;
    else hidden++;
    return on ? 7 : 0;
  });
  cascades.update(camera, sunTowards, 1);
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.lights.length, 1);
    assert.deepEqual(call.needsUpdate, [true], "three is asked to render exactly this cascade");
  }
  const near = calls[0].camera.layers;
  const farLayers = calls[2].camera.layers;
  assert.ok(near.isEnabled(0) && near.isEnabled(SHADOW_PROXY_LAYER) && !near.isEnabled(SHADOW_FAR_LAYER));
  assert.ok(farLayers.isEnabled(SHADOW_FAR_LAYER) && !farLayers.isEnabled(0),
    "units and small props never reach the cached cascade");
  assert.equal(shown, 1);
  assert.equal(hidden, 1, "hidden casters are hidden again after the cascades render");
  assert.equal(cascades.stats.shadowOnlyOwners, 7);
  assert.deepEqual(cascades.stats.cascades.map((cascade) => cascade.drawCalls), [1, 1, 1]);

  // A render of some other scene passes straight through with its own lights.
  calls.length = 0;
  const other = new THREE.DirectionalLight();
  renderer.shadowMap.render([other], scene, camera);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lights[0], other);
});

test("with a caster list each cascade walks the list's root; other lights still walk the scene", async () => {
  const { ShadowCasterList, ShadowCasterRoot } = await import("../dist/code/browser/ShadowCasterList.js");
  const { cascades, renderer, scene, calls } = setup(2);
  const camera = makeCamera();
  const list = new ShadowCasterList();
  const tree = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  tree.castShadow = true;
  scene.add(tree);
  list.set(tree, true);
  let toggled = 0;
  cascades.setShadowOnlyCasters(() => { toggled++; return 0; });
  cascades.setCasterList(list);
  cascades.update(camera, sunTowards, 1);
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.scene instanceof ShadowCasterRoot, "three walks the list's root, not the scene");
    assert.deepEqual(call.meshes, [tree]);
  }
  assert.equal(toggled, 0, "the shadow-only toggle is not called while a list is set");

  // Lights that are not cascades still get the scene.
  calls.length = 0;
  renderer.shadowMap.render([new THREE.DirectionalLight()], scene, camera);
  assert.equal(calls[0].scene, scene);

  // Without a list the scene and the toggle come back.
  cascades.setCasterList(undefined);
  calls.length = 0;
  cascades.update(camera, sunTowards, 2);
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.ok(calls.every((call) => call.scene === scene));
  assert.equal(toggled, 2, "on and off once");
});

test("a hidden legacy placement that is its own owner casts through gate 2, shown for the pass only", async () => {
  const { ShadowCasterList } = await import("../dist/code/browser/ShadowCasterList.js");
  const { cascades, renderer, scene, calls } = setup(2);
  const camera = makeCamera();
  const list = new ShadowCasterList();
  // `#modelNode`'s legacy path: the placement node is the mesh itself, hidden while not admitted.
  const legacy = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  legacy.castShadow = true;
  legacy.visible = false;
  scene.add(legacy);
  list.set(legacy, true, legacy, () => 2, {});
  cascades.setCasterList(list);
  cascades.update(camera, sunTowards, 1);
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.meshes, [legacy]);
    assert.deepEqual(call.shown, [true], "three stops at a hidden object: it is shown while the cascades render");
  }
  assert.equal(legacy.visible, false, "hidden again for the view");
  assert.equal(cascades.stats.shadowOnlyOwners, 1);
  // Gate 1 keeps it hidden and out.
  list.set(legacy, true, legacy, () => 1, {});
  calls.length = 0;
  cascades.update(camera, sunTowards, 2);
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.ok(calls.every((call) => call.meshes.length === 0));
  assert.equal(legacy.visible, false);
});

test("quality 0 hands the sun back untouched and keeps the shadow pass a pass-through", () => {
  const { cascades, scene, primary, uniforms, renderer, calls } = setup(2);
  const extras = cascades.lights.slice(1);
  cascades.configure(scene, renderer, lightingProfile(0, { shadowMaps: true, maxTextureSize: 4096 }));
  assert.equal(cascades.active, false);
  assert.equal(cascades.lights.length, 0);
  for (const light of extras) assert.equal(scene.children.includes(light), false);
  assert.equal(primary.shadow.autoUpdate, true);
  assert.deepEqual(primary.shadow.camera.up.toArray(), [0, 1, 0]);
  assert.deepEqual(uniforms.wowShadowFade.value.toArray(), [0, 0, 0]);
  const camera = makeCamera();
  cascades.update(camera, sunTowards, 1);
  renderer.shadowMap.render([primary], scene, camera);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].camera, camera, "the view camera is handed through unchanged");

  // Back on: the added lights rejoin after the primary, so their shadow index is their cascade.
  cascades.configure(scene, renderer, lightingProfile(1, { shadowMaps: true, maxTextureSize: 4096 }));
  assert.equal(cascades.lights.length, 2);
  assert.equal(cascades.lights[0], primary);
  assert.ok(scene.children.indexOf(cascades.lights[1]) > scene.children.indexOf(primary));
  assert.deepEqual(uniforms.wowShadowFade.value.toArray(),
    [120 * (1 - SHADOW_FADE_FRACTION), 120, SHADOW_CASCADE_BLEND]);
});

test("the world-light shader walks every cascade, blends at map edges and fades from the camera", () => {
  assert.match(WORLD_LIGHT_BODY, /#pragma unroll_loop_start\s+for \( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i \+\+ \)/);
  assert.match(WORLD_LIGHT_BODY, /vDirectionalShadowCoord\[ i \]/);
  assert.match(WORLD_LIGHT_BODY, /smoothstep\( wowShadowFade\.x, wowShadowFade\.y, length\( vViewPosition \) \)/);
  assert.match(WORLD_LIGHT_BODY, /wowShadowLeft \*= 1\.0 - wowCascadeWeight/);
  const uniforms = createWorldLightUniforms();
  const material = new THREE.MeshStandardMaterial();
  applyWorldLight(material, uniforms, "surface");
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  assert.equal(shader.uniforms.wowShadowFade, uniforms.wowShadowFade);
  assert.match(shader.fragmentShader, /#ifdef USE_SHADOWMAP\nuniform vec3 wowShadowFade;\n#endif/,
    "the fade uniform only exists where a shadow map does, so quality 0 compiles the same program");
});

test("a WMO room's shadow stand-in shares its buffers and merges its solid runs", () => {
  const source = new THREE.BufferGeometry();
  source.setAttribute("position", new THREE.BufferAttribute(new Float32Array(30), 3));
  source.setIndex(new THREE.BufferAttribute(new Uint16Array(30), 1));
  source.addGroup(0, 6, 0);
  source.addGroup(6, 6, 1);
  source.addGroup(12, 6, 2);
  source.addGroup(18, 6, 3);
  source.addGroup(24, 6, 4);
  const solid = new THREE.MeshStandardMaterial();
  const glass = new THREE.MeshStandardMaterial({ transparent: true });
  const grille = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
  const room = new THREE.MeshBasicMaterial();
  const proxy = wmoShadowProxyGeometry(source, [solid, room, glass, solid, grille]);
  assert.ok(proxy);
  assert.equal(proxy.getAttribute("position"), source.getAttribute("position"), "no copy of the vertices");
  assert.equal(proxy.getIndex(), source.getIndex(), "no copy of the indices");
  assert.deepEqual(proxy.groups.map(({ start, count }) => [start, count]), [[0, 12], [18, 6]],
    "consecutive solid runs are one draw; glass and alpha-tested grilles cast nothing");
  assert.equal(wmoShadowProxyGeometry(source, [solid]), proxy, "cached per source geometry");
  let disposed = false;
  proxy.addEventListener("dispose", () => { disposed = true; });
  source.dispose();
  assert.equal(disposed, true, "the stand-in goes with its source and never on its own");

  const unlit = new THREE.BufferGeometry();
  unlit.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  unlit.addGroup(0, 3, 0);
  assert.equal(wmoShadowProxyGeometry(unlit, [glass]), null);
});
