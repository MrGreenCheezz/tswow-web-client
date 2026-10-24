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
  ribbonCapacity,
  createParticleSystem, createQuadBuffers, createRibbonSystem,
  primeParticleSystem, stepParticles, stepParticlesCatchUp,
  resetParticleSystem, resetRibbonSystem, stepRibbon, stepRibbonCatchUp,
  writeParticleQuads, writeRibbonStrip, particleQuadsPerParticle, // 23.10 (6.27)
  PARTICLE_FLAG_SCALE_WITH_EMITTER, PARTICLE_FLAG_TAIL, PARTICLE_FLAG_UNFOGGED, PARTICLE_FLAG_XY_QUAD, // 23.10 (6.27)
  PARTICLE_FLAG_UNLIT, // 25.10 (6.27)
  type BillboardView, type EmitterFrame, type ParticleGlow, type ParticleSystem, type QuadBuffers, type RibbonSystem,
} from "./Particles.js";
import { installSpellParticleLook, spellParticleLookOf } from "./SpellParticleLook.js"; // 23.10 (6.27)
import { BLEND_ADD, BLEND_BLEND_ADD, BLEND_NO_ALPHA_ADD } from "./Wvm.js"; // 23.10 (6.27)
import { renderSwitches } from "./RenderSwitches.js"; // 12.08
import { MATERIAL_UNFOGGED, TEXTURE_TYPE_OWN, textureUrl, type WvmModel } from "./Wvm.js";
import { withHdModelTexture } from "./HdWorldTextures.js"; // 24.10 (7.48 step 3)
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
  /** 25.10 (6.27): a particle emitter without record 0x1 takes the scene's light (`EffectUpdateOptions.particleLight`). */
  readonly lit?: boolean;
  /**
   * 13.10 6.15: a further texture of a ribbon. Wow.exe's CRibbonEmitter render (0x00980b70) draws the one strip
   * once per material/texture pair; this entry shares the leader's geometry and buffers, has its own material,
   * and only follows the leader's draw range — it owns no simulation and does not free the shared geometry.
   */
  readonly follows?: DrawnEmitter;
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
  /** 13.10 6.15: the sequence-table slot the model plays; per-sequence emitter tracks read it (Wow.exe 0x0082d2f0). */
  sequence?: number | undefined;
  /** 25.10 (6.27): the camera (distance thinning) and the ground (record 0x2000), as `EmitterFrame` takes them. */
  viewX?: number | undefined;
  viewY?: number | undefined;
  viewZ?: number | undefined;
  ground?: ((x: number, z: number) => number | undefined) | undefined;
}

export interface EffectUpdateOptions {
  /** Only true for a newly resolved async spell model, never for a normal frame delta. */
  catchUp?: boolean;
  /** Seed one active particle emitter at age zero without simulating past its authored first frame. */
  firstBurst?: boolean;
  /** Local animation clock for that seed; global-sequence tracks continue using `worldMs`. */
  firstBurstAnimationMs?: number;
  /**
   * 12.08: the view the effects are drawn in. A particle emitter whose quads cannot reach it is
   * still simulated, but writes, uploads and draws nothing this frame (`particlesOutside`).
   */
  frustum?: THREE.Frustum;
  /** 23.10 (6.27): summed glow of the particles drawn this frame (the enhanced profile's spell light). */
  glow?: ParticleGlow;
  /**
   * 25.10 (6.27): the light a lit particle takes this frame — the scene's model light on a quad whose normal is the
   * world's up (`particleLightColour`). Wow.exe draws an emitter without record 0x1 with lighting on (CParticleMat bit 1
   * → GxVBF_PNCT, 0x0097e730) and every vertex normal s_particleNormal = the view matrix's c row (0x0097a390) — the
   * world's z in the view space the quads are written in. Absent: unlit.
   */
  particleLight?: { r: number; g: number; b: number };
}

/**
 * 25.10 (6.27): the light on a lit particle: ambient + diffuse · max(0, n · l), each channel at most 1 (the vertex
 * light clamps), n the particle's normal (the world's up, 0x0097a390) and l towards the sun, scene axes.
 */
export function particleLightColour(
  ambient: { r: number; g: number; b: number }, diffuse: { r: number; g: number; b: number },
  toSun: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number },
  out: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  const facing = Math.max(0, toSun.x * normal.x + toSun.y * normal.y + toSun.z * normal.z);
  out.r = Math.min(1, Math.max(0, ambient.r + diffuse.r * facing));
  out.g = Math.min(1, Math.max(0, ambient.g + diffuse.g * facing));
  out.b = Math.min(1, Math.max(0, ambient.b + diffuse.b * facing));
  return out;
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
    /**
     * 23.10 (6.27): «Живые эффекты заклинаний» (SpellParticleLook.ts) — frame blending, soft ground and glow
     * on a spell's particles; enhanced profile only, and it replaces `fantasyGlow` on those materials.
     */
    livingSpells?: boolean;
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
      // 24.10 (7.48 step 3): a scenery emitter's own texture (a waterfall's spray) may come as the world set's copy.
      const base = options.loadTexture(withHdModelTexture(textureUrl(options.baseUrl, slot.path)));
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
    const seedOffset = Math.imul(index, 0x9e3779b1) >>> 0;
    const particles = createParticleSystem(emitter, model.globalSequences, (seed + seedOffset) >>> 0);
    // 13.10 6.15: room for the pool Wow.exe would give this emitter (`particleCapacity`), not a flat 256.
    // 23.10 (6.27): times the quads one particle draws (head, tail or both, 0x00978d00).
    const living = options.livingSpells === true;
    const buffers = createQuadBuffers(particles.capacity * particleQuadsPerParticle(emitter), living);
    // 23.10 (6.27): the record's 0x8 is its unfogged bit (CParticleMat → M2 material 0x2, 0x008214e0); until
    // 23.10 every particle was fogged. Its sidedness and blend follow from the blend type.
    const materialFlags = (emitter.flags & PARTICLE_FLAG_UNFOGGED) !== 0 ? MATERIAL_UNFOGGED : 0;
    const drawn = buildDrawn(buffers, map, emitter.blendType, materialFlags, living ? undefined : options.fantasyGlow,
      undefined, living ? { soft: (emitter.flags & PARTICLE_FLAG_XY_QUAD) === 0 } : undefined);
    emitters.push({
      ...drawn,
      buffers,
      bone: emitter.bone,
      seedOffset,
      particles,
      ...((emitter.flags & PARTICLE_FLAG_UNLIT) === 0 ? { lit: true } : {}), // 25.10 (6.27)
    });
    group.add(drawn.mesh);
  });

  model.ribbonEmitters.forEach((ribbon) => {
    // 13.10 6.15: every texture of the ribbon with its own material, as 0x00980b70 draws them, in record order;
    // the first resolvable one carries the simulation.
    let leader: DrawnEmitter | undefined;
    let buffers: (QuadBuffers & { indices: Uint16Array }) | undefined;
    let geometry: THREE.BufferGeometry | undefined;
    ribbon.textures.forEach((slot, pass) => {
      const map = texture(slot);
      if (!map) return;
      const material = ribbon.materials[pass] ?? ribbon.materials[0];
      // The flags, not only the blend mode. A ribbon *does* have a material — `tools/m2.mjs`
      // resolves it and WVM7 carries both halves — and only half of it was arriving here: of the 854
      // ribbons under `spells\`, **827 carry `MATERIAL_UNFOGGED`** and every one of them was being
      // fogged, because `MeshBasicMaterial.fog` defaults to `true` and nothing said otherwise.
      if (!leader) {
        // 13.10 6.15: the ring of 0x009808a0 — ceil(lifetime · ceil(rate)) + 2 edges — less one: quads join edges.
        buffers = createQuadBuffers(Math.max(1, ribbonCapacity(ribbon) - 1));
        const drawn = buildDrawn(
          buffers, map, material?.blendMode ?? 2, material?.flags ?? 0, options.fantasyGlow,
        );
        geometry = drawn.geometry;
        leader = {
          ...drawn,
          buffers,
          bone: ribbon.bone,
          seedOffset: 0,
          ribbon: createRibbonSystem(ribbon, model.globalSequences),
        };
        emitters.push(leader);
        group.add(drawn.mesh);
        return;
      }
      const drawn = buildDrawn(
        buffers!, map, material?.blendMode ?? 2, material?.flags ?? 0, options.fantasyGlow, geometry,
      );
      emitters.push({ ...drawn, buffers: buffers!, bone: ribbon.bone, seedOffset: 0, follows: leader });
      group.add(drawn.mesh);
    });
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
  shared?: THREE.BufferGeometry, // 13.10 6.15: a further ribbon texture draws the leader's strip again
  living?: { soft: boolean }, // 23.10 (6.27): the living spell look (SpellParticleLook.ts)
): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material } {
  const geometry = shared ?? new THREE.BufferGeometry();
  if (!shared) {
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
    if (buffers.uvs2 && buffers.blends) { // 23.10 (6.27): frame blending's next cell, living spells only
      const uv2 = new THREE.BufferAttribute(buffers.uvs2, 2);
      const blend = new THREE.BufferAttribute(buffers.blends, 1);
      uv2.setUsage(THREE.DynamicDrawUsage);
      blend.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("uv2Cell", uv2);
      geometry.setAttribute("cellBlend", blend);
    }
  }

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
  // One pass whatever the blend. three draws a transparent two-sided material twice — back faces,
  // then front — so that a closed shape composites in order, and on every draw of every frame it
  // marks the material changed for each pass (`setProgram` re-derives the program parameters and
  // walks the program cache twice: ~4 KB of garbage and tens of microseconds per quad batch). A
  // quad cloud has no inside: every billboard faces the eye, so the back-face pass draws nothing,
  // and a ribbon's segments face where the strip happens to fly. Their order is the spawn order
  // in one pass exactly as it was in two. `applyBlendMode` had already allowed this for additive
  // blends; the ordering argument for keeping alpha blends on two passes is about closed meshes.
  material.forceSinglePass = true;
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

  if (living) {
    // 23.10 (6.27): after the fog step, so the soft fade and the glow see the fogged colour's alpha.
    installSpellParticleLook(material, {
      additive: blendMode === BLEND_ADD || blendMode === BLEND_NO_ALPHA_ADD || blendMode === BLEND_BLEND_ADD,
      srcAlphaBlend: blendMode !== BLEND_NO_ALPHA_ADD && blendMode !== BLEND_BLEND_ADD,
      soft: living.soft,
      frameBlend: geometry.getAttribute("uv2Cell") !== undefined,
    });
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Drawn after the world and before nothing: particles are transparent, and three sorts
  // transparent objects by distance, which is as good an order as they can be given.
  mesh.renderOrder = 3;
  return { mesh, geometry, material };
}

const EMITTER_FRAME: EmitterFrame = {
  matrix: [], animationMs: 0, worldMs: 0, animationStartMs: undefined, worldStartMs: undefined, sequence: undefined,
  viewX: undefined, viewY: undefined, viewZ: undefined, ground: undefined, // 25.10 (6.27)
};

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
    if (drawn.follows) {
      // 13.10 6.15: a further texture of a ribbon draws whatever its leader wrote this frame (listed after it).
      drawn.mesh.visible = drawn.follows.mesh.visible;
      continue;
    }
    // One object refilled per emitter: the steps below only read it (a fresh object with the
    // optional clocks spread in was two or three allocations per emitter per frame).
    const emitterFrame = EMITTER_FRAME;
    emitterFrame.matrix = frame.matrixFor(drawn.bone);
    emitterFrame.animationMs = frame.animationMs;
    emitterFrame.worldMs = frame.worldMs;
    emitterFrame.animationStartMs = frame.animationStartMs;
    emitterFrame.worldStartMs = frame.worldStartMs;
    emitterFrame.sequence = frame.sequence; // 13.10 6.15
    emitterFrame.viewX = frame.viewX; // 25.10 (6.27)
    emitterFrame.viewY = frame.viewY;
    emitterFrame.viewZ = frame.viewZ;
    emitterFrame.ground = frame.ground;
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
      // 12.08: off screen, nothing it would write could be seen; the next visible frame writes
      // every quad again from the simulation, so skipping is exact. In the city bench ≈ 90 % of
      // the emitters drawn were outside the view, every one of them written, uploaded and drawn.
      if (options.frustum && particlesOutside(drawn.particles, options.frustum, drawn.mesh.matrixWorld)) {
        drawn.geometry.setDrawRange(0, 0);
        drawn.mesh.visible = false;
        continue;
      }
      quads = writeParticleQuads(drawn.particles, view, drawn.buffers, options.glow);
      // 25.10 (6.27): a lit emitter's quads take the scene's light through the material colour (no recompile).
      if (drawn.lit) {
        const light = options.particleLight;
        (drawn.material as THREE.MeshBasicMaterial).color.setRGB(light?.r ?? 1, light?.g ?? 1, light?.b ?? 1);
      }
    } else if (drawn.ribbon) {
      if (options.catchUp) stepRibbonCatchUp(drawn.ribbon, seconds, emitterFrame);
      else stepRibbon(drawn.ribbon, seconds, emitterFrame);
      quads = writeRibbonStrip(drawn.ribbon, drawn.buffers);
    }
    drawn.geometry.setDrawRange(0, quads * 6);
    // 12.08: three binds the program and submits even an empty range; an empty emitter is hidden.
    drawn.mesh.visible = quads > 0;
    if (quads === 0) continue;
    // Only the part that was written: uploading the whole allowance every frame is the difference
    // between one campfire's worth of traffic and two hundred and fifty-six.
    markUpdated(drawn.geometry.getAttribute("position") as THREE.BufferAttribute, quads * 4);
    markUpdated(drawn.geometry.getAttribute("uv") as THREE.BufferAttribute, quads * 4);
    markUpdated(drawn.geometry.getAttribute("color") as THREE.BufferAttribute, quads * 4);
    if (drawn.buffers.uvs2) { // 23.10 (6.27)
      markUpdated(drawn.geometry.getAttribute("uv2Cell") as THREE.BufferAttribute, quads * 4);
      markUpdated(drawn.geometry.getAttribute("cellBlend") as THREE.BufferAttribute, quads * 4);
    }
  }
}

/** 23.10 (6.27): the ground under a living spell effect (scene y), for its particles' soft fade. */
export function setModelEffectsGround(effects: ModelEffects, ground: number): void {
  for (const emitter of effects.emitters) {
    const look = spellParticleLookOf(emitter.material);
    if (look) look.spellGround.value = ground;
  }
}

const SCALE_MAXIMA = new WeakMap<object, number>();
const OUTSIDE_BOX = new THREE.Box3();

/** The largest value an emitter's scale ramp reaches (keys bound a linear ramp); 1 without one. */
function scaleMaximum(emitter: ParticleSystem["emitter"]): number {
  const ramp = emitter.scale;
  if (!ramp) return 1;
  let maximum = SCALE_MAXIMA.get(ramp);
  if (maximum === undefined) {
    maximum = 0;
    for (let index = 0; index < ramp.values.length; index++) maximum = Math.max(maximum, Math.abs(ramp.values[index]!));
    SCALE_MAXIMA.set(ramp, maximum);
  }
  return maximum;
}

/**
 * 12.08: whether every quad this system would write lies outside `frustum` — a conservative
 * answer from the simulation alone, without writing. Each quad stays within its half-diagonal of
 * its particle (any spin, billboard or emitter plane), sized by the scale ramp's largest key and
 * the particle's own factors, and, in model space, carried through the emitter's matrix; a pinned
 * streak runs between the particle and its birth point. Twinkle, which can grow a quad past the
 * ramp, turns the test off.
 */
export function particlesOutside(system: ParticleSystem, frustum: THREE.Frustum, meshWorld: THREE.Matrix4): boolean {
  const particles = system.particles;
  if (particles.length === 0) return false;
  const emitter = system.emitter;
  // 25.10 (6.27): twinkle grows a quad by at most the larger end of its range (0x0097be80), so it widens the bound
  // instead of turning the test off — it is on by default now.
  const twinkle = renderSwitches.particleTwinkle
    ? Math.max(1, Math.abs(emitter.twinkleScaleMin), Math.abs(emitter.twinkleScaleMax)) : 1;
  // 23.10 (6.27): a tail reaches back along the velocity for at most `tailLength` seconds (0x0097be80).
  const tail = (emitter.flags & PARTICLE_FLAG_TAIL) !== 0 ? Math.max(0, emitter.tailLength) : 0;
  const m = system.matrix;
  const modelSpace = system.modelSpace;
  // 23.10 (6.27): a quad's corners are ±scale (0x00b2d5b4), times the emitter's scale only with 0x20.
  const frameScale = (emitter.flags & PARTICLE_FLAG_SCALE_WITH_EMITTER) !== 0 ? Math.hypot(m[0]!, m[1]!, m[2]!) : 1;
  const sizeBound = Math.SQRT2 * scaleMaximum(emitter) * frameScale * twinkle;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let radius = 0;
  const extend = (x: number, y: number, z: number): void => {
    if (modelSpace) {
      const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      x = wx; y = wy; z = wz;
    }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (let index = 0; index < particles.length; index++) {
    const particle = particles[index]!;
    extend(particle.x, particle.y, particle.z);
    if (tail > 0) extend(particle.x - particle.vx * tail, particle.y - particle.vy * tail, particle.z - particle.vz * tail);
    const size = sizeBound * Math.max(Math.abs(particle.scaleX), Math.abs(particle.scaleY));
    if (size > radius) radius = size;
  }
  // A non-finite coordinate or size: say "inside" and let the writer decide, as before.
  if (!Number.isFinite(minX + minY + minZ + maxX + maxY + maxZ + radius)) return false;
  OUTSIDE_BOX.min.set(minX - radius, minY - radius, minZ - radius);
  OUTSIDE_BOX.max.set(maxX + radius, maxY + radius, maxZ + radius);
  OUTSIDE_BOX.applyMatrix4(meshWorld);
  return !frustum.intersectsBox(OUTSIDE_BOX);
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
    if (drawn.follows) continue; // 13.10 6.15: the leader rewinds the shared strip
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
    if (!drawn.follows) drawn.geometry.dispose(); // 13.10 6.15: a further ribbon texture borrows its leader's
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
