// 24.10 (7.50): every lamp in view within 150 yards lays its warm pool — the forward set's 12 nearest
// as before, the rest in screen space (LightPools.ts, LightPoolPass.ts), handed over without a pop
// and never lit twice. Owner, 24.10 (trade district, night): the far lamps' glass glows, but a few
// yards on there is no pool on the cobbles.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  CINEMATIC_POOL_GLSL, CINEMATIC_POOL_REACH, LOCAL_LIGHT_FADE_BAND, WMO_LIGHT_RANK_SCALE, localLightSelectionFade,
} from "../dist/code/browser/CinematicLights.js";
import { FAR_LIGHT_STRIDE, FAR_LIGHT_WMO_SHARE, farLightSources } from "../dist/code/browser/FarLightGlows.js";
import { LIGHT_HALO_STRENGTH } from "../dist/code/browser/LightHalos.js";
import {
  LIGHT_POOL_FADE_OUT, LIGHT_POOL_LIMIT, LIGHT_POOL_RANGE, LightPools, lightPoolReach, lightPoolWeight,
} from "../dist/code/browser/LightPools.js";
import { LIGHT_POOL_DARKNESS_GLSL, LIGHT_POOL_LAMP_GLSL, LIGHT_POOL_LIT_GLSL } from "../dist/code/browser/LightPoolGlsl.js";
import { LightPoolPass } from "../dist/code/browser/LightPoolPass.js";
import { LocalLightSelection } from "../dist/code/browser/LocalLighting.js";
import { WORLD_LIGHT_BODY, WORLD_LOCAL_LIGHT_LIMIT, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";

const close = (a, b, epsilon = 1e-6, message = "") => assert.ok(Math.abs(a - b) < epsilon, `${message} ${a} != ${b}`);

/** A camera at the origin looking down -z (scene north), as the renderer's is after `updateMatrixWorld`. */
function camera() {
  const value = new THREE.PerspectiveCamera(60, 16 / 9, 0.2, 2000);
  value.updateMatrixWorld();
  value.updateProjectionMatrix();
  return value;
}

/** Far sources as `FarLightGlows` hands them: x, y, z, glow rgb, signed reach, share. */
function sources(lamps, generation = 1) {
  const values = new Float32Array(lamps.length * FAR_LIGHT_STRIDE);
  lamps.forEach((lamp, index) => {
    const share = lamp.share ?? 1;
    const glow = LIGHT_HALO_STRENGTH * (lamp.intensity ?? 1) * share;
    values.set([lamp.x ?? 0, lamp.y ?? 2, lamp.z, glow, glow * 0.56, glow * 0.2, lamp.reach ?? 8, share], index * FAR_LIGHT_STRIDE);
  });
  return { sources: values, sourceCount: lamps.length, sourceGeneration: generation };
}

test("the hand-over: what the forward set does not draw the screen-space pool does, with no step", () => {
  const cut = 30;
  let previous = 1;
  for (let rank = 0; rank <= LIGHT_POOL_RANGE - LIGHT_POOL_FADE_OUT; rank += 0.25) {
    const forward = localLightSelectionFade(rank, cut);
    const screen = lightPoolWeight(rank, cut);
    close(forward + screen, 1, 1e-9, `rank ${rank}:`);
    assert.ok(Math.abs(forward + screen - previous) < 1e-6);
    previous = forward + screen;
  }
  assert.equal(lightPoolWeight(10, cut), 0, "well inside the forward set: lit there only");
  assert.equal(lightPoolWeight(cut, cut), 1, "from the cut on: the whole of it here");
  assert.ok(lightPoolWeight(cut - LOCAL_LIGHT_FADE_BAND / 2, cut) > 0.4, "across the band: shared");
  assert.equal(lightPoolWeight(5, 0), 1, "no forward set: every lamp here");
});

test("the far end: faded out over the range's last stretch, not cut", () => {
  assert.equal(lightPoolWeight(LIGHT_POOL_RANGE - LIGHT_POOL_FADE_OUT, 20), 1);
  assert.ok(lightPoolWeight(LIGHT_POOL_RANGE - 3, 20) < 0.05);
  assert.equal(lightPoolWeight(LIGHT_POOL_RANGE, 20), 0);
  assert.equal(lightPoolWeight(LIGHT_POOL_RANGE + 10, 20), 0);
  assert.equal(lightPoolWeight(Number.NaN, 20), 0);
  assert.equal(lightPoolWeight(80, 20, 90), 1 - (3 - 2 * (2 / 3)) * (2 / 3) ** 2, "a capped list's own range");
});

test("the pool's reach: an M2 light's own, a heuristic lamp's at least the cinematic pool's", () => {
  assert.equal(lightPoolReach(8), CINEMATIC_POOL_REACH);
  assert.equal(lightPoolReach(24), 24);
  assert.equal(lightPoolReach(-20), 20);
});

test("every lamp in view within the range is drawn, weighed against the forward set", () => {
  const view = camera();
  const focus = new THREE.Vector3(0, 0, -12);
  const lamps = [];
  for (let z = -5; z >= -200; z -= 5) lamps.push({ z });
  lamps.push({ z: 60 }); // behind the camera, its pool well out of the view
  lamps.push({ x: 300, z: -40 }); // far off to the side
  const far = sources(lamps);
  const pools = new LightPools();
  const cut = 30;
  const drawn = pools.update(far, focus, cut, view);
  const seen = [];
  for (let index = 0; index < drawn; index++) seen.push(pools.lamps[index * 4 + 2]);
  for (const lamp of lamps) {
    const rank = Math.hypot((lamp.x ?? 0) - focus.x, 2 - focus.y, lamp.z - focus.z);
    const weight = lightPoolWeight(rank, cut);
    const expected = weight > 0.002 && lamp.z < 0 && (lamp.x ?? 0) === 0;
    assert.equal(seen.includes(lamp.z) && (lamp.x ?? 0) === 0, expected, `lamp at z ${lamp.z}, rank ${rank.toFixed(1)}`);
  }
  assert.ok(!seen.includes(60), "a lamp behind the camera whose pool cannot reach the view is left out");
  // The instance: the view-space centre, the light's own signed radius, and its colour · intensity · weight.
  const index = seen.indexOf(-100);
  const rank = Math.hypot(0, 2, 88);
  close(pools.lamps[index * 4 + 1], 2);
  assert.equal(pools.lamps[index * 4 + 3], 8, "the light's own radius, as wowLocalLightPosition.w carries it");
  close(pools.colours[index * 4], lightPoolWeight(rank, cut), 1e-6, "red = colour · intensity · weight:");
  close(pools.colours[index * 4 + 1], 0.56 * lightPoolWeight(rank, cut), 1e-6);
  assert.equal(pools.stats.drawn, drawn);
});

test("a lamp just behind the camera whose pool reaches into the view is kept", () => {
  const pools = new LightPools();
  const focus = new THREE.Vector3(0, 0, -12);
  assert.equal(pools.update(sources([{ z: 10 }]), focus, 0, camera()), 1, "its pool reaches 8 yards before the camera");
  assert.equal(pools.update(sources([{ z: 40 }], 2), focus, 0, camera()), 0);
});

test("a WMO lamp record ranks half as far again, as the selection ranks it, and keeps its own colour", () => {
  const view = camera();
  const focus = new THREE.Vector3(0, 0, -12);
  const pools = new LightPools();
  const far = sources([{ z: -40, share: FAR_LIGHT_WMO_SHARE, intensity: 0.8 }]);
  assert.equal(pools.update(far, focus, 20, view), 1);
  const rank = Math.hypot(0, 2, 28) * WMO_LIGHT_RANK_SCALE;
  close(pools.colours[0], 0.8 * lightPoolWeight(rank, 20), 1e-6, "the share is the glow's, not the light's:");
  assert.equal(pools.update(sources([{ z: -115, share: FAR_LIGHT_WMO_SHARE }], 2), focus, 20, view), 0,
    "103 yards off ranks 155: past the range");
  assert.equal(pools.update(sources([{ z: -100, share: FAR_LIGHT_WMO_SHARE }], 3), focus, 20, view), 1);
  const far88 = Math.hypot(0, 2, 88);
  close(pools.colours[0], lightPoolWeight(far88 * WMO_LIGHT_RANK_SCALE, 20), 1e-6, "88 yards off weighs as 132 (fading out):");
  assert.ok(pools.colours[0] < 0.7);
});

test("an M2 light keeps its negative reach (the client's falloff)", () => {
  const pools = new LightPools();
  assert.equal(pools.update(sources([{ z: -40, reach: -20 }]), new THREE.Vector3(0, 0, -12), 10, camera()), 1);
  assert.equal(pools.lamps[3], -20);
});

test("the cap: the nearest are kept and the farthest of them fade out before the first left out", () => {
  const view = camera();
  const focus = new THREE.Vector3(0, 0, -12);
  const lamps = [];
  for (let index = 0; index < 600; index++) lamps.push({ x: index % 2, z: -12 - index * 0.2 });
  const pools = new LightPools();
  const drawn = pools.update(sources(lamps), focus, 0, view);
  assert.ok(drawn <= LIGHT_POOL_LIMIT && drawn > 0, `drawn ${drawn}`);
  let farthest = 0;
  for (let index = 0; index < drawn; index++) farthest = Math.max(farthest, -pools.lamps[index * 4 + 2]);
  assert.ok(farthest < 12 + 256 * 0.2 - 3, `the nearest are kept, and the last of them faded out: ${farthest}`);
  assert.equal(pools.stats.picked, LIGHT_POOL_LIMIT);
});

test("re-picked only when the focus moves or the sources change; a frame only re-weights", () => {
  const view = camera();
  const pools = new LightPools();
  const far = sources([{ z: -40 }, { z: -70 }]);
  const focus = new THREE.Vector3(0, 0, -12);
  assert.equal(pools.update(far, focus, 10, view), 2);
  // A source moved in place without a new generation is not seen until a re-pick …
  far.sources[2] = -400;
  focus.z -= 1;
  assert.equal(pools.update(far, focus, 10, view), 1, "re-weighted: the moved lamp is now past the range");
  far.sources[2] = -40;
  // … and one that came into range in place is not drawn either: the frame re-weights the picked ones only.
  far.sources[FAR_LIGHT_STRIDE + 2] = -400;
  assert.equal(pools.update({ ...far, sourceGeneration: 2 }, focus, 10, view), 1, "a new list is picked again");
  far.sources[FAR_LIGHT_STRIDE + 2] = -70;
  focus.z -= 1;
  assert.equal(pools.update({ ...far, sourceGeneration: 2 }, focus, 10, view), 1, "not picked: not drawn");
  focus.z -= 4;
  assert.equal(pools.update({ ...far, sourceGeneration: 2 }, focus, 10, view), 2, "the focus moved: picked again");
  const none = pools.update({ sources: new Float32Array(0), sourceCount: 0, sourceGeneration: 3 }, focus, 10, view);
  assert.equal(none, 0);
  pools.clear();
  assert.equal(pools.count, 0);
});

test("the census counts the lamps in view by distance and who lit them", () => {
  const view = camera();
  const focus = new THREE.Vector3(0, 0, -12);
  const lamps = [];
  for (let z = -15; z >= -160; z -= 5) lamps.push({ z });
  const far = sources(lamps);
  const pools = new LightPools();
  pools.update(far, focus, 30, view);
  const census = pools.census(far, focus, 30, view);
  const total = census.inView.reduce((a, b) => a + b, 0);
  assert.equal(total, lamps.filter((lamp) => Math.hypot(0, 2, lamp.z + 12) < LIGHT_POOL_RANGE).length);
  census.inView.forEach((count, bin) => {
    assert.ok(census.forward[bin] + census.screen[bin] <= count + 1, `bin ${bin}`);
  });
  assert.equal(census.screen[0], 0, "the nearest bin is the forward set's");
  assert.ok(census.screen[4] > 0 && census.forward[4] === 0, "60-75 yards: screen-space only");
  pools.clear();
  assert.equal(pools.census(far, focus, 30, view).screen.reduce((a, b) => a + b, 0), 0, "off: none in screen space");
});

test("far sources carry the pool's reach and share", () => {
  const visual = new THREE.Object3D();
  const model = {
    positions: new Float32Array([0, 0, 4, 1, 0, 4, 0, 1, 4]),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ indexStart: 0, indexCount: 3 }],
    batches: [{ submesh: 0, materialFlags: 1, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 }],
    textures: [{ path: "Dungeons\\Textures\\Doodads\\StormwindLampGlass.blp" }],
    particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(),
  };
  const values = farLightSources({
    source: { id: 1, name: "World\\Generic\\Human\\Passive Doodads\\Lamps\\StormwindStreetLamp01.m2" },
    node: visual, visual, wvm: model,
  });
  assert.equal(values.length, FAR_LIGHT_STRIDE);
  assert.equal(values[6], 8, "the heuristic fixture's radius");
  assert.equal(values[7], 1, "a doodad lamp's whole share");
  // A model's own M2 point light (the guard tower's lanterns): its reach, negative for the client's falloff.
  const declared = { ...model, lights: [{ type: 1, position: [0, 0, 3], bone: -1 }] };
  const own = farLightSources({ source: { id: 2, name: "World\\Generic\\Human\\Passive Doodads\\GuardTower\\HumanGuardTower.m2" },
    node: visual, visual, wvm: declared });
  assert.equal(own.length, FAR_LIGHT_STRIDE);
  assert.equal(own[6], -20, "the client's reach, marked as the client's");
});

test("the deferred term is the forward shader's own text", () => {
  // The fixture term, the cinematic pool over it and the immersive scale, cut from WORLD_LIGHT_BODY.
  assert.ok(LIGHT_POOL_LAMP_GLSL.includes(CINEMATIC_POOL_GLSL));
  const clientFalloff = WORLD_LIGHT_BODY.slice(WORLD_LIGHT_BODY.indexOf("float wowClientFalloff"),
    WORLD_LIGHT_BODY.indexOf("wowLampTerm = max( wowLampFacing, 0.0 ) * wowClientFalloff"));
  assert.ok(clientFalloff.length > 40 && LIGHT_POOL_LAMP_GLSL.includes(clientFalloff));
  assert.match(LIGHT_POOL_LAMP_GLSL, /vec4 wowLampColour = vec4\( colour, 1\.0 \);/);
  assert.doesNotMatch(LIGHT_POOL_LAMP_GLSL, /wowLocalLightColour\[/, "the lamp is handed in, not read from the forward set");
  // The light a surface took: the enhanced grade and the forward set under one.
  assert.ok(LIGHT_POOL_LIT_GLSL.includes(`for ( int wowLightIndex = 0; wowLightIndex < ${WORLD_LOCAL_LIGHT_LIMIT};`));
  assert.ok(LIGHT_POOL_LIT_GLSL.includes("wowImmersiveLight / max( wowImmersivePeak, 1.0 )"));
  assert.match(LIGHT_POOL_LIT_GLSL,
    /wowLight = min\( wowLight \+ wowLampLight \* wowLampIndoor, vec3\( 1\.0 \+ 0\.50 \* wowLampIndoor \) \);\n\}\n  return wowLight;/);
  assert.match(LIGHT_POOL_DARKNESS_GLSL, /float wowDarkness = 1\.0 - smoothstep\( 0\.18, 0\.55, wowAmbientLuma \);\n  return wowDarkness;/);
});

test("every uniform a pool pass reads is declared in that pass", () => {
  const pass = new LightPoolPass(createWorldLightUniforms());
  for (const material of pass.materials) {
    for (const [stage, source] of [["vertex", material.vertexShader], ["fragment", material.fragmentShader]]) {
      const code = source.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
      for (const name of Object.keys(material.uniforms)) {
        if (!new RegExp(`\\b${name}\\b`).test(code)) continue;
        assert.match(code, new RegExp(`uniform (highp )?\\w+ ${name}(\\[[^\\]]+\\])?;`), `${stage}: ${name} is read but not declared`);
      }
    }
  }
  pass.dispose();
});

test("no pools in view: the pass draws nothing and the capture stands", () => {
  const pass = new LightPoolPass(createWorldLightUniforms());
  const pools = new LightPools();
  assert.equal(pass.render(/** never touched */ {}, { pools }), undefined);
  assert.equal(pass.renderTargets.length, 0);
});

test("the renderer's wiring: enhanced lights only, after the forward set, before the post chain reads the frame", async () => {
  const { readFile } = await import("node:fs/promises");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /if \(this\.#lightingProfile\.localLights > 0\) \{\n\s+this\.#lightPools\.update\(this\.#farLightGlows, focus, selection\.cut, this\.#camera\);/,
    "weighed against this frame's forward cut, ranked from the same focus");
  const compose = renderer.slice(renderer.indexOf("#composeFullscreenGlow(targets: GlowChainTargets | undefined): void {"));
  const pooled = compose.indexOf("sceneTexture = this.#lightPoolPass.render(");
  assert.ok(pooled > 0 && pooled < compose.indexOf("uniforms.source.value = sceneTexture;"), "the classic glow reads the pooled frame");
  assert.ok(pooled < compose.indexOf("scene: sceneTexture, // 24.10 (7.50)"), "and so does the cinematic chain");
  assert.match(compose.slice(0, pooled), /if \(this\.#cinematic\.active && this\.#lightPools\.count > 0\) \{/);
  assert.match(compose.slice(0, pooled), /targets\.godRays && depth instanceof THREE\.DepthTexture && !this\.#underwater/);
});

test("halos and far glows are drawn after the pools, tested against the world depth, then hidden again", async () => {
  const { LightHalos } = await import("../dist/code/browser/LightHalos.js");
  const halos = new LightHalos();
  const view = camera();
  const seen = [];
  const renderer = {
    autoClear: true,
    render(object, cameraUsed) {
      const material = object.material;
      seen.push({ visible: object.visible, depthTest: material.depthTest, test: material.uniforms.haloDepthTest.value.toArray(),
        projection: material.uniforms.haloProjection.value.toArray(), depth: material.uniforms.haloSceneDepth.value,
        autoClear: this.autoClear, camera: cameraUsed });
    },
  };
  halos.mesh.visible = false;
  halos.drawLate(renderer, view, null, 100, 50);
  assert.equal(seen.length, 0, "nothing to draw: no call");
  halos.addGlow(0, 2, -30, 3, 1, 0.5, 0.2);
  halos.end();
  const depth = new THREE.DepthTexture(100, 50);
  halos.drawLate(renderer, view, depth, 100, 50);
  assert.deepEqual(seen[0].test, [1, 0.01, 0.02]);
  assert.equal(seen[0].depthTest, false, "the pooled frame has no depth buffer: the shader tests");
  assert.equal(seen[0].visible, true);
  assert.equal(seen[0].autoClear, false, "drawn over the pooled frame");
  assert.equal(seen[0].depth, depth);
  close(seen[0].projection[0], view.projectionMatrix.elements[10]);
  close(seen[0].projection[1], view.projectionMatrix.elements[14]);
  assert.equal(halos.mesh.visible, false, "hidden again; the renderer shows it after the frame");
  assert.equal(halos.mesh.material.depthTest, true);
  assert.equal(halos.mesh.material.uniforms.haloDepthTest.value.x, 0, "the ordinary draw tests in hardware");
  assert.equal(renderer.autoClear, true);
  halos.drawLate(renderer, view, null, 100, 50);
  assert.equal(seen[1].depthTest, true, "without a depth texture: the bound target's own depth buffer");
  // The shader's test: the view distance from the depth texture, a quad farther than the world discarded.
  const fragment = halos.mesh.material.fragmentShader;
  assert.match(fragment, /if \( haloDepthTest\.x > 0\.5 \) \{\n\s+float ndc = texture2D\( haloSceneDepth, gl_FragCoord\.xy \* haloDepthTest\.yz \)\.r \* 2\.0 - 1\.0;\n\s+if \( vHaloDistance > haloProjection\.y \/ \( ndc \+ haloProjection\.x \) \) discard;/);
  const e = view.projectionMatrix.elements;
  const z = -30;
  const ndc = (e[10] * z + e[14]) / -z;
  close(e[14] / (ndc + e[10]), 30, 1e-3, "the distance the depth decodes to:");
  halos.dispose();
});

test("an opaque lit surface writes its sun shadow into alpha, only while the pools run; a blended one never", async () => {
  const { applyWorldLight, WORLD_SHADOW_ALPHA_GLSL } = await import("../dist/code/browser/WorldLighting.js");
  const compile = (material) => {
    const uniforms = createWorldLightUniforms();
    applyWorldLight(material, uniforms, "surface");
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader, {});
    return { shader, uniforms };
  };
  const opaque = compile(new THREE.MeshStandardMaterial());
  assert.equal(opaque.uniforms.wowShadowAlpha.value, 0, "off by default: every other frame and profile keeps its alpha");
  assert.equal(opaque.shader.uniforms.wowShadowAlpha, opaque.uniforms.wowShadowAlpha);
  const at = opaque.shader.fragmentShader.indexOf(WORLD_SHADOW_ALPHA_GLSL);
  assert.ok(at > opaque.shader.fragmentShader.indexOf("#include <dithering_fragment>"), "after the last chunk");
  assert.match(WORLD_SHADOW_ALPHA_GLSL, /if \( wowShadowAlpha > 0\.5 \) gl_FragColor\.a = 0\.94 \* clamp\( wowShadow, 0\.0, 1\.0 \);/);
  const material = new THREE.MeshStandardMaterial({ transparent: true });
  const blended = compile(material);
  assert.equal(blended.shader.fragmentShader.includes(WORLD_SHADOW_ALPHA_GLSL), false, "its alpha is its blending's");
  assert.match(material.customProgramCacheKey(), /:surface:blend$/, "and its program is not the opaque one's");
});

test("the forward selection reports the cut its lights fade towards", () => {
  const selection = new LocalLightSelection();
  const sample = { position: new THREE.Vector3(), colour: new THREE.Vector3(1, 1, 1), radius: 8, intensity: 1 };
  const origin = new THREE.Vector3();
  const uniforms = createWorldLightUniforms();
  selection.begin(2);
  for (const z of [5, 10, 20, 40]) {
    sample.position.set(0, 0, z);
    selection.add(sample, origin);
  }
  selection.write(uniforms, new THREE.Matrix4());
  assert.equal(selection.cut, 20, "the nearest left out");
  selection.begin(12);
  selection.add(sample, origin);
  selection.write(uniforms, new THREE.Matrix4());
  assert.equal(selection.cut, 64, "fewer than the limit: the selection's range");
  selection.begin(0);
  selection.write(uniforms, new THREE.Matrix4());
  assert.equal(selection.cut, 0, "no forward set");
});
