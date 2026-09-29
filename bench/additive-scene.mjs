import * as THREE from 'three';
import { decodeWvm9, decodeWvaAnimations, visualModelUrl, visualAnimationsUrl } from '../src/browser/Wvm.ts';
import { buildModel, EVERY_GEOSET, updateBatchAppearance, applyBlendMode, fadeMaterial } from '../src/browser/ModelBuild.ts';
import { buildSkinnedTemplateFrom, instantiateSkinned, addSkinnedClips, applyBillboardBones, applyGlobalSequenceBones } from '../src/browser/AnimatedModel.ts';
import { buildModelEffects, updateModelEffects, billboardView } from '../src/browser/ParticleRender.ts';

// Prototype only: exercise the exact current production material and animation paths,
// then toggle a single Three material property. Nothing installs this policy in the game.
const eligible = material => material instanceof THREE.MeshBasicMaterial
  && material.transparent && !material.depthWrite && material.blending === THREE.CustomBlending
  && material.blendEquation === THREE.AddEquation && material.blendDst === THREE.OneFactor
  && material.blendSrcAlpha === null && material.blendDstAlpha === null
  && (material.blendEquationAlpha === null || material.blendEquationAlpha === THREE.AddEquation)
  && [THREE.OneFactor, THREE.SrcAlphaFactor].includes(material.blendSrc);
const tick = () => new Promise(requestAnimationFrame);
const dist = values => {
  const s = values.toSorted((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: s[Math.ceil(s.length * .5) - 1], p95: s[Math.ceil(s.length * .95) - 1] };
};
const paths = [
  'Spells\\AmplifyMagic_Impact_Base.m2', 'Spells\\DarkRitual_PreCast_Base.m2',
  'SPELLS\\INSTANCEPORTAL_GREEN_25MAN_HEROIC.m2', 'spells\\holy_hammer_missile.m2',
  'Spells\\Shadow_Form_Precast.m2', 'spells\\hunter_rapidfire.m2',
];
async function run() {
  const checked = async url => { const r = await fetch(url); if (!r.ok) throw Error(`Asset ${r.status}: ${url}`); return r; };
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(1280, 720); renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x314157);
  scene.fog = new THREE.FogExp2(0x314157, .014);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445533, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.position.set(2, 6, 3); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(48, 1280 / 720, .1, 200);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshBasicMaterial({ color: 0x25353e }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.1; scene.add(ground);
  const occluder = new THREE.Mesh(new THREE.BoxGeometry(2, 7, 2), new THREE.MeshBasicMaterial({ color: 0x475366 }));
  occluder.position.set(0, 3, 0); scene.add(occluder);
  const pending = [], loader = new THREE.TextureLoader();
  const loadTexture = url => {
    let texture; pending.push(new Promise((resolve, reject) => { texture = loader.load(url, resolve, undefined, () => reject(Error(`Texture failed: ${url}`))); }));
    return texture;
  };
  const materials = [], objects = [], metadata = [], instances = [];
  for (const [index, path] of paths.entries()) {
    const model = decodeWvm9(await (await checked(visualModelUrl('', path))).arrayBuffer());
    const built = buildModel(model, { modelPath: path, baseUrl: '', loadTexture, geosets: EVERY_GEOSET,
      skinned: Boolean(model.skeleton), fantasyGlow: true, deduplicateLoadedTextures: true });
    let template;
    if (model.skeleton) {
      template = buildSkinnedTemplateFrom(built.geometry, model.skeleton, built.height);
      addSkinnedClips(template, decodeWvaAnimations(await (await checked(visualAnimationsUrl('', path))).arrayBuffer(), model.skeleton.parents.length));
    }
    metadata.push({ path, bones: model.skeleton?.parents.length ?? 0, groups: built.geometry.groups.length,
      eligibleGroups: built.materials.filter(m => eligible(m) && m.side === THREE.DoubleSide).length,
      particleEmitters: model.particleEmitters.length, ribbonEmitters: model.ribbonEmitters.length });
    // Each spell owns its material state, as it does in WorldRenderer3D.
    for (let placement = 0; placement < 6; placement++) {
      const ownMaterials = built.materials.map(source => {
        const clone = source.clone(); clone.onBeforeCompile = source.onBeforeCompile;
        clone.customProgramCacheKey = source.customProgramCacheKey;
        materials.push({ material: clone, source }); return clone;
      });
      let instance, root;
      if (template) {
        instance = instantiateSkinned(template, ownMaterials); root = instance.root;
        const clip = template.clips.get(0) ?? template.clips.values().next().value;
        if (clip) instance.mixer.clipAction(clip).play();
        instances.push(instance);
      } else { root = new THREE.Mesh(built.geometry, ownMaterials); root.rotation.x = -Math.PI / 2; }
      const wrapper = new THREE.Group(); wrapper.add(root); scene.add(wrapper);
      wrapper.position.set((placement - 2.5) * 4, 0, (index - 2.5) * 4);
      wrapper.scale.setScalar(Math.min(1, 3 / Math.max(1, built.height)));
      const effects = buildModelEffects(model, { baseUrl: '', loadTexture, seed: 12340 + index * 10 + placement, fantasyGlow: true });
      if (effects) {
        scene.add(effects.group);
        for (const emitter of effects.emitters) materials.push({ material: emitter.material, source: emitter.material.clone() });
      }
      objects.push({ model, built, instance, template, root, wrapper, effects });
    }
  }
  await Promise.all(pending);
  const shippingPolicyMatchesPrototype = materials.every(({ material }) => material.forceSinglePass === eligible(material));
  let keys = 0;
  for (const { material } of materials) {
    const key = material.customProgramCacheKey;
    material.customProgramCacheKey = function () { keys++; return key.call(this); };
  }
  const setPolicy = candidate => {
    for (const { material } of materials) {
      const next = candidate && eligible(material);
      if (next !== material.forceSinglePass) { material.forceSinglePass = next; material.needsUpdate = true; }
    }
  };
  const view = {}, matrix = new THREE.Matrix4();
  function pose(seconds, frame, fade = 1) {
    const angle = frame / 36 * Math.PI * 2;
    camera.position.set(Math.sin(angle) * 32, 12 + 5 * Math.sin(angle * .5), Math.cos(angle) * 32);
    camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
    billboardView(camera, view);
    for (const object of objects) {
      const { instance, template, model, root, built, effects } = object;
      updateBatchAppearance(built.animatedBatches, seconds * 1000);
      if (instance) {
        instance.mixer.setTime(seconds);
        applyGlobalSequenceBones(instance, template, model.globalSequences, seconds * 1000);
        applyBillboardBones(instance, template, camera);
      }
      root.updateWorldMatrix(true, true);
      if (effects) updateModelEffects(effects, 1 / 30, { animationMs: seconds * 1000, worldMs: seconds * 1000,
        matrixFor(bone) {
          return instance && bone >= 0 && instance.skeleton.bones[bone]
            ? matrix.multiplyMatrices(instance.skeleton.bones[bone].matrixWorld, instance.skeleton.boneInverses[bone]).elements
            : root.matrixWorld.elements;
        } }, view, { firstBurst: frame === 0 });
    }
    for (const { material, source } of materials) {
      // Fading only originally additive materials exercises the candidate without
      // turning the baseline's opaque/alpha control materials into new blend modes.
      if (eligible(source)) fadeMaterial(material, fade, source);
      else { material.opacity = source.opacity; material.visible = source.visible; material.color.copy(source.color); }
    }
  }
  const target = new THREE.WebGLRenderTarget(1280, 720);
  // Match the world's sRGB offscreen target: raw linear readback would make the
  // saved PNGs artificially dark and weaken visual inspection.
  target.texture.colorSpace = THREE.SRGBColorSpace;
  target.texture.internalFormat = 'RGBA8';
  target.isXRRenderTarget = true;
  const before = new Uint8Array(1280 * 720 * 4), after = new Uint8Array(before.length);
  const png = pixels => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const bytes = new Uint8ClampedArray(pixels.length);
    for (let y = 0; y < 720; y++) bytes.set(pixels.subarray(y * 5120, (y + 1) * 5120), (719 - y) * 5120);
    c.getContext('2d').putImageData(new ImageData(bytes, 1280, 720), 0, 0); return c.toDataURL();
  };
  const cases = [], images = {};
  renderer.setRenderTarget(target);
  for (let frame = 0; frame < 60; frame++) pose(frame / 60, frame);
  // Same poses and particle buffers are drawn twice; no simulation occurs between A/B.
  for (let frame = 0; frame < 36; frame++) {
    await tick(); pose(.4 + frame / 30, frame, frame % 3 === 0 ? .35 : 1);
    const counters = [];
    for (const candidate of [false, true]) {
      setPolicy(candidate); renderer.render(scene, camera); // compile outside the sampled draw
      keys = 0; const started = performance.now(); renderer.render(scene, camera);
      counters.push({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programParameterBuilds: keys,
        submitMs: performance.now() - started });
      renderer.readRenderTargetPixels(target, 0, 0, 1280, 720, candidate ? after : before);
    }
    let changedPixels = 0, maxChannelDelta = 0, totalDelta = 0;
    for (let i = 0; i < before.length; i += 4) {
      let changed = false;
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(before[i + channel] - after[i + channel]);
        if (delta) changed = true;
        maxChannelDelta = Math.max(maxChannelDelta, delta); totalDelta += delta;
      }
      if (changed) changedPixels++;
    }
    // Negative control: verify that the additive materials actually contribute
    // visible pixels. A match between two empty/transparent pictures is not QA.
    const saved = materials.filter(({ material }) => eligible(material)).map(({ material }) => [material, material.visible]);
    for (const [material] of saved) material.visible = false;
    renderer.render(scene, camera);
    const hidden = new Uint8Array(before.length);
    renderer.readRenderTargetPixels(target, 0, 0, 1280, 720, hidden);
    for (const [material, visible] of saved) material.visible = visible;
    let visibleAdditivePixels = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] !== hidden[i] || before[i + 1] !== hidden[i + 1] || before[i + 2] !== hidden[i + 2]) visibleAdditivePixels++;
    }
    cases.push({ frame, changedPixels, maxChannelDelta, meanChannelDelta: totalDelta / before.length,
      visibleAdditivePixels, before: counters[0], after: counters[1] });
    if ([0, 12, 24].includes(frame)) { images[`view-${frame}-before`] = png(before); images[`view-${frame}-after`] = png(after); }
  }
  // Interleaved diagnostic blocks: sample only submission, with readback/counters out
  // of the timed interval. External load still prevents accepting a full FPS gain.
  renderer.setRenderTarget(null); pose(1, 3);
  const samples = [[], []];
  for (let block = 0; block < 8; block++) {
    const mode = block % 4 === 0 || block % 4 === 3 ? 0 : 1;
    setPolicy(Boolean(mode));
    for (let frame = 0; frame < 70; frame++) {
      await tick(); const started = performance.now(); renderer.render(scene, camera);
      if (frame >= 10) samples[mode].push(performance.now() - started);
    }
  }
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { passed: cases.every(c => c.maxChannelDelta <= 1 && c.visibleAdditivePixels > 100), metadata, shippingPolicyMatchesPrototype,
    viewport: { width: 1280, height: 720, dpr: 1 }, three: THREE.REVISION,
    adapter: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    prototype: 'forceSinglePass for unlit additive materials with no depth writes',
    visualSummary: { cases: cases.length, exact: cases.filter(c => c.changedPixels === 0).length,
      maxChannelDelta: Math.max(...cases.map(c => c.maxChannelDelta)), maxChangedPixels: Math.max(...cases.map(c => c.changedPixels)),
      minVisibleAdditivePixels: Math.min(...cases.map(c => c.visibleAdditivePixels)),
      maxMeanChannelDelta: Math.max(...cases.map(c => c.meanChannelDelta)) },
    counterSummary: Object.fromEntries(['calls', 'triangles', 'programParameterBuilds'].map(key => [key,
      { before: dist(cases.map(c => c.before[key])), after: dist(cases.map(c => c.after[key])) }])),
    cpuSummary: { before: dist(samples[0]), after: dist(samples[1]), samplesPerMode: samples[0].length },
    cases, images };
}
run().then(result => { window.probeResult = result; }).catch(error => { window.probeError = String(error.stack ?? error); });
