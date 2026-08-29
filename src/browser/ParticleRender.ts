// Hanging a model's emitters on the scene graph.
//
// The split is the one the rest of the renderer already uses: `Particles.ts` decides where a
// spark is and what colour it is, and this decides which buffer that goes in, which material
// draws it and when the whole lot is thrown away. Nothing here knows the rules; nothing there
// knows three.js.
//
// Particles are written in world coordinates into a group with no transform of its own, which is
// what a trail needs — a torch carried past you leaves its sparks behind rather than dragging
// them along. The emitter's own frame arrives once per step as a matrix, and the only thing that
// differs between a campfire on a hillside and a spell effect on a character's hand is where that
// matrix comes from.

import * as THREE from "three";
import { applyBlendMode, applyFogMode, privateTextureView } from "./ModelBuild.js";
import {
  EMITTER_CAPACITY, RIBBON_CAPACITY,
  createParticleSystem, createQuadBuffers, createRibbonSystem,
  primeParticleSystem, stepParticles, stepParticlesCatchUp,
  resetParticleSystem, resetRibbonSystem, stepRibbon, stepRibbonCatchUp,
  writeParticleQuads, writeRibbonStrip,
  type BillboardView, type ParticleSystem, type QuadBuffers, type RibbonSystem,
} from "./Particles.js";
import { MATERIAL_UNFOGGED, TEXTURE_TYPE_OWN, textureUrl, type WvmModel } from "./Wvm.js";
import type { ResourceOwnerId, RetainedResourceVisitor } from "./ResourceAccounting.js";

/** One emitter: its simulation, the buffers it fills and the mesh those buffers are attached to. */
interface DrawnEmitter {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly buffers: QuadBuffers;
  readonly bone: number;
  /** Particle-emitter index folded into its build seed; retained for exact epoch rewinds. */
  readonly seedOffset: number;
  readonly particles?: ParticleSystem;
  readonly ribbon?: RibbonSystem;
}

interface ParticleFantasyGlowBinding {
  previousCompile: THREE.Material["onBeforeCompile"];
  previousKey: string;
  enabled: boolean;
}

const PARTICLE_FANTASY_GLOW_BINDINGS = new WeakMap<THREE.Material, ParticleFantasyGlowBinding>();

/**
 * Everything one model instance emits, and the one group it all lives in.
 *
 * Per instance rather than per model: two campfires standing side by side must not share a
 * particle, and the simulation is the only part of a model that cannot be cached across
 * placements.
 */
export interface ModelEffects {
  readonly group: THREE.Group;
  readonly emitters: DrawnEmitter[];
  /** Exact Texture objects/views this effect retains, deduplicated by authored path. */
  readonly textures: THREE.Texture[];
  /** False only for callers that deliberately hand this instance externally-owned Texture objects. */
  readonly disposeTextures: boolean;
}

/** Applies a profile toggle to already-spawned spell emitters without resetting their simulation. */
export function setModelEffectsFantasyGlow(effects: ModelEffects, enabled: boolean): void {
  for (const emitter of effects.emitters) {
    const binding = PARTICLE_FANTASY_GLOW_BINDINGS.get(emitter.material);
    if (!binding || binding.enabled === enabled) continue;
    binding.enabled = enabled;
    emitter.material.needsUpdate = true;
  }
}

/** Visits the exact typed backing stores retained by an effect simulation. */
export function visitModelEffectsResources(
  visitor: RetainedResourceVisitor,
  ownerId: ResourceOwnerId,
  effects: ModelEffects,
): void {
  const seen = new WeakSet<object>();
  const reference = (view: ArrayBufferView | undefined): void => {
    if (!view) return;
    const backing = view.buffer as object;
    if (seen.has(backing)) return;
    seen.add(backing);
    visitor.referenceCpu(ownerId, view);
  };

  for (const emitter of effects.emitters) {
    if (emitter.particles) {
      reference(emitter.particles.matrix);
      reference(emitter.particles.globalSequences);
    }
    if (emitter.ribbon) reference(emitter.ribbon.globalSequences);
  }
}

/** Where each emitter of a model is this frame, and what time it is for its tracks. */
export interface EffectFrame {
  /**
   * The column-major world matrix an emitter on this bone is placed by.
   *
   * For a rigged model that is `bone.matrixWorld * boneInverse[bone]` — the skinning matrix, which
   * is what a vertex weighted entirely to that bone is transformed by, and an emitter's position
   * is written in the same space as a vertex. For a static one it is the node's own world matrix,
   * whatever bone the emitter names.
   */
  matrixFor(bone: number): ArrayLike<number>;
  animationMs: number;
  worldMs: number;
  /** Start clocks for explicit async catch-up; omitted on ordinary render frames. */
  animationStartMs?: number;
  worldStartMs?: number;
}

export interface EffectUpdateOptions {
  /** Only true for a newly resolved async spell model, never for a normal frame delta. */
  catchUp?: boolean;
  /** Seed one active particle emitter at age zero without simulating past its authored first frame. */
  firstBurst?: boolean;
  /** Local animation clock for that seed; global-sequence tracks continue using `worldMs`. */
  firstBurstAnimationMs?: number;
}

/**
 * Builds every emitter a model carries, or nothing if it carries none.
 *
 * An emitter whose texture cannot be resolved is dropped rather than drawn untextured: these are
 * almost all additive, and an additive quad with no map is a white card the size of the effect.
 */
export function buildModelEffects(
  model: WvmModel,
  options: {
    baseUrl: string;
    loadTexture: (url: string) => THREE.Texture;
    /** Set false when the callback is a shared scoped cache rather than an instance owner. */
    disposeTextures?: boolean;
    /** Clone each loaded base once per effect path before mutating its sampler state. */
    privateTextureViews?: boolean;
    /** Seeds the emitters, so two placements of one model do not spark in lockstep. */
    seed?: number;
    /** Single-pass additive lift for spell-owned emitters; never set for world ambience. */
    fantasyGlow?: boolean;
  },
): ModelEffects | undefined {
  if (model.particleEmitters.length === 0 && model.ribbonEmitters.length === 0) return undefined;

  const group = new THREE.Group();
  // Particles are world-space and their extent changes every frame; there is nothing stable to
  // cull them against until slice R8 gives every emitter a bound of its own.
  group.frustumCulled = false;
  const emitters: DrawnEmitter[] = [];
  const textures: THREE.Texture[] = [];
  const loaded = new Map<string, THREE.Texture>();
  const seed = options.seed ?? 1;
  const disposeTextures = options.privateTextureViews === true || options.disposeTextures !== false;

  const texture = (slotIndex: number): THREE.Texture | undefined => {
    const slot = model.textures[slotIndex];
    // Only a self-named slot: a particle never draws a character's skin, and a slot the client
    // has to fill is a slot this build cannot resolve on its own.
    if (!slot || slot.type !== TEXTURE_TYPE_OWN || !slot.path) return undefined;
    let value = loaded.get(slot.path);
    if (!value) {
      const base = options.loadTexture(textureUrl(options.baseUrl, slot.path));
      value = options.privateTextureViews === true ? privateTextureView(base) : base;
      value.colorSpace = THREE.SRGBColorSpace;
      // The client's UVs put v = 0 at the top of the image; three's default upload flips it.
      value.flipY = false;
      // Flip-book cells are addressed by their own sub-rectangle, so a stray UV must clamp rather
      // than pull in the tile on the far side of the atlas.
      value.wrapS = THREE.ClampToEdgeWrapping;
      value.wrapT = THREE.ClampToEdgeWrapping;
      loaded.set(slot.path, value);
      textures.push(value);
    }
    return value;
  };

  model.particleEmitters.forEach((emitter, index) => {
    const map = texture(emitter.texture);
    if (!map) return;
    const buffers = createQuadBuffers(EMITTER_CAPACITY);
    // An emitter record carries no material flags of its own — only a blend type — so its fog and
    // its sidedness follow from that alone.
    const drawn = buildDrawn(buffers, map, emitter.blendType, 0, options.fantasyGlow);
    const seedOffset = Math.imul(index, 0x9e3779b1) >>> 0;
    emitters.push({
      ...drawn,
      buffers,
      bone: emitter.bone,
      seedOffset,
      particles: createParticleSystem(emitter, model.globalSequences, (seed + seedOffset) >>> 0),
    });
    group.add(drawn.mesh);
  });

  model.ribbonEmitters.forEach((ribbon) => {
    const map = texture(ribbon.textures[0] ?? -1);
    if (!map) return;
    const buffers = createQuadBuffers(RIBBON_CAPACITY);
    const material = ribbon.materials[0];
    // The flags, not only the blend mode. A ribbon *does* have a material — `tools/m2.mjs`
    // resolves it and WVM7 carries both halves — and only half of it was arriving here: of the 854
    // ribbons under `spells\`, **827 carry `MATERIAL_UNFOGGED`** and every one of them was being
    // fogged, because `MeshBasicMaterial.fog` defaults to `true` and nothing said otherwise.
    const drawn = buildDrawn(
      buffers, map, material?.blendMode ?? 2, material?.flags ?? 0, options.fantasyGlow,
    );
    emitters.push({
      ...drawn,
      buffers,
      bone: ribbon.bone,
      seedOffset: 0,
      ribbon: createRibbonSystem(ribbon, model.globalSequences),
    });
    group.add(drawn.mesh);
  });

  if (emitters.length === 0) {
    if (disposeTextures) {
      for (const value of textures) value.dispose();
    }
    return undefined;
  }
  return { group, emitters, textures, disposeTextures };
}

function buildDrawn(
  buffers: QuadBuffers & { indices: Uint16Array },
  map: THREE.Texture,
  blendMode: number,
  materialFlags: number,
  fantasyGlow: boolean | undefined,
): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material } {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(buffers.positions, 3);
  const uv = new THREE.BufferAttribute(buffers.uvs, 2);
  const color = new THREE.BufferAttribute(buffers.colors, 4);
  position.setUsage(THREE.DynamicDrawUsage);
  uv.setUsage(THREE.DynamicDrawUsage);
  color.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", position);
  geometry.setAttribute("uv", uv);
  geometry.setAttribute("color", color);
  geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
  geometry.setDrawRange(0, 0);

  // Unlit, and not because a flag said so. The two bits that would decide it are named "lit" and
  // "unlightning" and 52% of the client's emitters set both, so neither can be read; what settles
  // it is that eight in ten particle emitters are additive — 4,335 of the 5,562 under `spells\`
  // — and an additive quad shaded as if it were a surface is ruined, while an unlit one that
  // should have been shaded merely looks bright.
  //
  // Two-sided for the same kind of reason, and `MATERIAL_TWO_SIDED` is deliberately not read here
  // either: 850 of the 854 ribbons under `spells\` set it, and a ribbon's winding follows the
  // direction it is flying, so the four that do not would blink out whenever their strip happened
  // to turn away from the eye.
  const material = new THREE.MeshBasicMaterial({
    map,
    vertexColors: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  applyBlendMode(material, blendMode);
  // Whatever the blend mode decided, a particle never writes depth: a cloud of them is drawn back
  // to front by accident of spawn order, and one that wrote depth would punch holes in the rest.
  material.depthWrite = false;
  material.transparent = true;
  // And it is never a cut-out. `applyBlendMode` sets a 224/255 alpha gate for blend mode 1, which
  // is right for hair cards and foliage and fatal here: a particle's alpha is its texture's times
  // its opacity ramp, and a ramp that fades in from zero would fail that gate for most of its
  // life. Ten of the client's emitters use mode 1, and every one of them would draw nothing.
  material.alphaTest = 0;
  // Whether distance may take this quad away, out of the file rather than out of the blend mode.
  // `MATERIAL_UNFOGGED` is the author saying it may not; for everything else `applyFogMode` decides
  // what fog means for the way it composites, which for an additive quad is "dim it", never "mix
  // the fog colour in".
  material.fog = (materialFlags & MATERIAL_UNFOGGED) === 0;
  applyFogMode(material, blendMode);
  if (fantasyGlow !== undefined && (blendMode === 3 || blendMode === 4)) {
    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey();
    const binding: ParticleFantasyGlowBinding = { previousCompile, previousKey, enabled: fantasyGlow };
    PARTICLE_FANTASY_GLOW_BINDINGS.set(material, binding);
    material.onBeforeCompile = (shader, renderer) => {
      binding.previousCompile.call(material, shader, renderer);
      if (!binding.enabled) return;
      const marker = "#include <color_fragment>";
      if (shader.fragmentShader.split(marker).length - 1 !== 1) {
        throw new Error("Particle fantasy glow expected exactly one MeshBasic color marker");
      }
      shader.fragmentShader = shader.fragmentShader.replace(marker, `${marker}
      /* particle-fantasy-glow-v1 */
      float particleFantasyEnergy = smoothstep(0.08, 0.92, diffuseColor.a);
      diffuseColor.rgb *= 1.20 + particleFantasyEnergy * 0.24;`);
    };
    material.customProgramCacheKey = () => binding.enabled
      ? `${binding.previousKey}|particle-fantasy-glow-v1`
      : binding.previousKey;
    if (fantasyGlow) material.needsUpdate = true;
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Drawn after the world and before nothing: particles are transparent, and three sorts
  // transparent objects by distance, which is as good an order as they can be given.
  mesh.renderOrder = 3;
  return { mesh, geometry, material };
}

/**
 * Steps every emitter of one model and refills its buffers.
 *
 * `seconds` is the same clamped frame time the animation mixers advance on, so a backgrounded tab
 * comes back to a campfire rather than to a single frame containing four seconds of smoke. The
 * explicit `catchUp` option is reserved for a newly resolved async spell model and has its own
 * one-second bound.
 */
export function updateModelEffects(
  effects: ModelEffects,
  seconds: number,
  frame: EffectFrame,
  view: BillboardView,
  options: EffectUpdateOptions = {},
): void {
  for (const drawn of effects.emitters) {
    const matrix = frame.matrixFor(drawn.bone);
    const emitterFrame = {
      matrix, animationMs: frame.animationMs, worldMs: frame.worldMs,
      ...(frame.animationStartMs === undefined ? {} : { animationStartMs: frame.animationStartMs }),
      ...(frame.worldStartMs === undefined ? {} : { worldStartMs: frame.worldStartMs }),
    };
    let quads = 0;
    if (drawn.particles) {
      if (options.firstBurst) {
        const primeFrame = options.firstBurstAnimationMs === undefined
          ? emitterFrame
          : { ...emitterFrame, animationMs: options.firstBurstAnimationMs };
        primeParticleSystem(drawn.particles, primeFrame);
      }
      if (options.catchUp) stepParticlesCatchUp(drawn.particles, seconds, emitterFrame);
      else stepParticles(drawn.particles, seconds, emitterFrame);
      quads = writeParticleQuads(drawn.particles, view, drawn.buffers);
    } else if (drawn.ribbon) {
      if (options.catchUp) stepRibbonCatchUp(drawn.ribbon, seconds, emitterFrame);
      else stepRibbon(drawn.ribbon, seconds, emitterFrame);
      quads = writeRibbonStrip(drawn.ribbon, drawn.buffers);
    }
    drawn.geometry.setDrawRange(0, quads * 6);
    if (quads === 0) continue;
    // Only the part that was written: uploading the whole allowance every frame is the difference
    // between one campfire's worth of traffic and two hundred and fifty-six.
    markUpdated(drawn.geometry.getAttribute("position") as THREE.BufferAttribute, quads * 4);
    markUpdated(drawn.geometry.getAttribute("uv") as THREE.BufferAttribute, quads * 4);
    markUpdated(drawn.geometry.getAttribute("color") as THREE.BufferAttribute, quads * 4);
  }
}

/**
 * Rewinds all simulations and dynamic draw buffers in place.
 *
 * Geometry, attributes, materials, textures and authored global-sequence arrays keep their exact
 * identities. Only values produced by temporal evolution are cleared.
 */
export function resetModelEffects(effects: ModelEffects, seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError("model-effects seed must be a uint32");
  }
  for (const drawn of effects.emitters) {
    if (drawn.particles) resetParticleSystem(drawn.particles, (seed + drawn.seedOffset) >>> 0);
    if (drawn.ribbon) resetRibbonSystem(drawn.ribbon);
    drawn.buffers.positions.fill(0);
    drawn.buffers.uvs.fill(0);
    drawn.buffers.colors.fill(0);
    drawn.geometry.setDrawRange(0, 0);
    for (const name of ["position", "uv", "color"]) {
      (drawn.geometry.getAttribute(name) as THREE.BufferAttribute).clearUpdateRanges();
    }
  }
}

function markUpdated(attribute: THREE.BufferAttribute, vertices: number): void {
  attribute.addUpdateRange(0, vertices * attribute.itemSize);
  attribute.needsUpdate = true;
}

/** Frees everything one instance's effects own. Geometry and material are per instance, so both go. */
export function disposeModelEffects(effects: ModelEffects): void {
  effects.group.removeFromParent();
  for (const drawn of effects.emitters) {
    drawn.geometry.dispose();
    drawn.material.dispose();
  }
  if (effects.disposeTextures) {
    for (const texture of effects.textures) texture.dispose();
  }
  effects.group.clear();
}

/**
 * The camera's right and up in the scene, which is all a billboard needs.
 *
 * Taken from the camera's world matrix rather than from its quaternion so that it is right
 * whatever the camera is parented to — and the renderer's camera is parented to nothing, which is
 * exactly the case where the two agree and the difference would never be noticed.
 */
export function billboardView(camera: THREE.Camera, out: BillboardView): BillboardView {
  const m = camera.matrixWorld.elements;
  const rightLength = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const upLength = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  out.rightX = m[0]! / rightLength;
  out.rightY = m[1]! / rightLength;
  out.rightZ = m[2]! / rightLength;
  out.upX = m[4]! / upLength;
  out.upY = m[5]! / upLength;
  out.upZ = m[6]! / upLength;
  return out;
}
