/**
 * 24.10 (7.50): the screen-space lamp pools (`LightPools.ts` picks and weighs the lamps). Runs on the
 * cinematic chain's resolved scene and depth, before anything reads them, and hands back the frame
 * with the pools in it; the bloom, haze, grade and composite then see it as they would a forward pool.
 *
 * Three passes, two of them at half resolution:
 * 1. normals — one per half-resolution texel from the full-resolution depth (the flatter neighbour
 *    on each axis, as the occlusion pass takes it), so a lamp's fragments read one texel, not five;
 * 2. light — one instanced quad per lamp over its pool's screen bounds, added up: the surface at
 *    the texel (depth → view position, its normal) lit by the forward fixture term itself
 *    (`LIGHT_POOL_LAMP_GLSL`, cut from `WORLD_LIGHT_BODY`);
 * 3. apply — full resolution, only where some pool reached: the half-resolution light brought up
 *    depth-aware (no pool bleeds onto a figure standing before a lit wall), and added to the surface
 *    as the forward shader would have added it. The capture is `albedo · L^2.2` (sRGB-encoded, the
 *    shoulder is the identity below 0.9), where L is the light the surface took — rebuilt here from
 *    the same uniforms (`LIGHT_POOL_LIT_GLSL`: the enhanced grade and the forward lamps) under the sun
 *    shadow the surface wrote into the capture's alpha this frame (`WORLD_SHADOW_ALPHA_GLSL`); a texel
 *    that wrote none (alpha one: sky, unlit glass, lit windows, blended overlays) is left as it is.
 *    So `albedo = linear / L^2.2` and the pooled colour is `albedo · min( L + pool, 1 )^2.2`; the
 *    albedo is capped (`LIGHT_POOL_ALBEDO_CAP`) so an unlit texel (a lit window, lamp glass, a glow)
 *    whose brightness is not albedo · L is not multiplied up.
 *
 * Like the forward pool it casts no shadow: a lamp lights what lies within its reach and faces it
 * (the wrap takes nothing from a face turned away), whichever side of a wall the camera is on.
 */
import * as THREE from "three";
import { CINEMATIC_POOL_REACH } from "./CinematicLights.js";
import { COLOUR_PARS, VERTEX, VIEW_PARS } from "./CinematicPost.js";
import { LIGHT_POOL_DARKNESS_GLSL, LIGHT_POOL_LAMP_GLSL, LIGHT_POOL_LIT_GLSL } from "./LightPoolGlsl.js";
import { LIGHT_POOL_INSTANCE_FLOATS, LIGHT_POOL_LIMIT, type LightPools } from "./LightPools.js";
import { WORLD_LIGHT_PARS, WORLD_SHADOW_ALPHA_SCALE, type WorldLightUniforms } from "./WorldLighting.js";

/**
 * Largest linear albedo the apply pass believes (its brightest channel; the hue is kept). Unlit
 * texels are already left out by their alpha (`WORLD_SHADOW_ALPHA_GLSL`); this bounds what an error
 * in the light estimate can make of the rest.
 */
export const LIGHT_POOL_ALBEDO_CAP = 1;

/** One half-resolution normal per texel from the full-resolution depth. */
const NORMALS = /* glsl */ `
uniform vec2 depthTexel;
varying vec2 vUV;
${VIEW_PARS}
vec3 positionAt(vec2 uv) { return cinematicViewPosition(uv, texture2D(depthTexture, uv).r); }
void main() {
  vec2 uv = (floor(vUV / depthTexel) + 0.5) * depthTexel;
  float depth = texture2D(depthTexture, uv).r;
  if (depth >= 1.0) { gl_FragColor = vec4(0.5, 0.5, 1.0, 0.0); return; }
  vec3 p = cinematicViewPosition(uv, depth);
  vec3 left = positionAt(uv - vec2(depthTexel.x, 0.0));
  vec3 right = positionAt(uv + vec2(depthTexel.x, 0.0));
  vec3 down = positionAt(uv - vec2(0.0, depthTexel.y));
  vec3 up = positionAt(uv + vec2(0.0, depthTexel.y));
  vec3 dx = abs(right.z - p.z) < abs(p.z - left.z) ? right - p : p - left;
  vec3 dy = abs(up.z - p.z) < abs(p.z - down.z) ? up - p : p - down;
  vec3 n = normalize(cross(dx, dy));
  if (dot(n, p) > 0.0) n = -n;
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

const LIGHT_VERTEX = /* glsl */ `
attribute vec4 poolLamp;
attribute vec4 poolColour;
uniform vec2 poolProjection; // projection[0][0], projection[1][1]
uniform float poolNear;
varying vec4 vPoolLamp;
varying vec3 vPoolColour;
varying float vPoolDarkness;
${WORLD_LIGHT_PARS}
${LIGHT_POOL_DARKNESS_GLSL}
void main() {
  vPoolLamp = poolLamp;
  vPoolColour = poolColour.rgb;
  vPoolDarkness = lightPoolDarkness();
  // The pool's reach as the forward shader takes it (wowPoolReach): an M2 light's own, else at least the pool's.
  float reach = poolLamp.w < 0.0 ? -poolLamp.w : max(poolLamp.w, ${CINEMATIC_POOL_REACH.toFixed(1)});
  vec3 c = poolLamp.xyz;
  float zNear = -c.z - reach;
  float zFar = -c.z + reach;
  vec2 lo = vec2(-1.0);
  vec2 hi = vec2(1.0);
  if (zFar <= poolNear) {
    lo = vec2(2.0);
    hi = vec2(2.0);
  } else if (zNear > poolNear) {
    // The projected corners of the sphere's view-space box: x/z is extreme at the box's near or far face.
    vec2 a = (c.xy - reach) * poolProjection;
    vec2 b = (c.xy + reach) * poolProjection;
    lo = max(min(a / zNear, a / zFar), vec2(-1.0));
    hi = min(max(b / zNear, b / zFar), vec2(1.0));
  }
  gl_Position = vec4(mix(lo, hi, position.xy * 0.5 + 0.5), 0.0, 1.0);
}`;

const LIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D poolNormals;
uniform vec2 depthTexel;
uniform vec2 poolTexel;
varying vec4 vPoolLamp;
varying vec3 vPoolColour;
varying float vPoolDarkness;
${VIEW_PARS}
${WORLD_LIGHT_PARS}
${LIGHT_POOL_LAMP_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy * poolTexel;
  vec2 duv = (floor(uv / depthTexel) + 0.5) * depthTexel;
  float depth = texture2D(depthTexture, duv).r;
  if (depth >= 1.0) discard;
  vec3 p = cinematicViewPosition(duv, depth);
  vec3 toLamp = vPoolLamp.xyz - p;
  float reach = vPoolLamp.w < 0.0 ? -vPoolLamp.w : max(vPoolLamp.w, ${CINEMATIC_POOL_REACH.toFixed(1)});
  if (dot(toLamp, toLamp) >= reach * reach) discard;
  vec3 n = texture2D(poolNormals, uv).xyz * 2.0 - 1.0;
  gl_FragColor = vec4(lightPoolLamp(vPoolLamp, vPoolColour, n, -p, vPoolDarkness), 1.0);
}`;

const APPLY = /* glsl */ `
uniform sampler2D source;
uniform sampler2D poolLight;
uniform sampler2D poolNormals;
uniform vec2 depthTexel;
uniform vec2 poolTexel;
uniform vec3 poolSunView;
uniform float poolDebug; // the bench's view of the pool light alone (setDebug)
varying vec2 vUV;
${COLOUR_PARS}
${VIEW_PARS}
${WORLD_LIGHT_PARS}
${LIGHT_POOL_LIT_GLSL}
float poolTapWeight(vec2 tuv, float z, float bilinear) {
  vec2 duv = (floor(tuv / depthTexel) + 0.5) * depthTexel;
  float tz = -cinematicViewPosition(duv, texture2D(depthTexture, duv).r).z;
  return bilinear / (0.02 + abs(tz - z) / max(z, 0.5) * 40.0);
}
void main() {
  vec4 texel = texture2D(source, vUV);
  vec3 scene = texel.rgb;
  vec3 quick = texture2D(poolLight, vUV).rgb;
  if (poolDebug > 0.5 && poolDebug < 1.5) { gl_FragColor = vec4(min(quick, vec3(1.0)), 1.0); return; }
  if (max(quick.r, max(quick.g, quick.b)) < 0.5 / 255.0) { gl_FragColor = vec4(scene, 1.0); return; }
  float depth = texture2D(depthTexture, vUV).r;
  if (depth >= 1.0) { gl_FragColor = vec4(scene, 1.0); return; }
  vec3 p = cinematicViewPosition(vUV, depth);
  float z = -p.z;
  // Depth-aware upsampling of the four half-resolution texels around this one.
  vec2 h = vUV / poolTexel - 0.5;
  vec2 cell = floor(h);
  vec2 f = h - cell;
  vec2 uv00 = (cell + vec2(0.5, 0.5)) * poolTexel;
  vec2 uv10 = (cell + vec2(1.5, 0.5)) * poolTexel;
  vec2 uv01 = (cell + vec2(0.5, 1.5)) * poolTexel;
  vec2 uv11 = (cell + vec2(1.5, 1.5)) * poolTexel;
  float w00 = poolTapWeight(uv00, z, (1.0 - f.x) * (1.0 - f.y));
  float w10 = poolTapWeight(uv10, z, f.x * (1.0 - f.y));
  float w01 = poolTapWeight(uv01, z, (1.0 - f.x) * f.y);
  float w11 = poolTapWeight(uv11, z, f.x * f.y);
  vec3 pool = (texture2D(poolLight, uv00).rgb * w00 + texture2D(poolLight, uv10).rgb * w10
    + texture2D(poolLight, uv01).rgb * w01 + texture2D(poolLight, uv11).rgb * w11)
    / max(w00 + w10 + w01 + w11, 1e-5);
  if (max(pool.r, max(pool.g, pool.b)) < 0.5 / 255.0) { gl_FragColor = vec4(scene, 1.0); return; }
  // An opaque lit surface wrote its sun shadow here (WORLD_SHADOW_ALPHA_GLSL); anything at one is not
  // one (unlit glass, a lit window, a blended overlay) and keeps its colour.
  if (texel.a > ${((1 + WORLD_SHADOW_ALPHA_SCALE) / 2).toFixed(3)}) { gl_FragColor = vec4(scene, 1.0); return; }
  float shadow = clamp(texel.a / ${WORLD_SHADOW_ALPHA_SCALE.toFixed(3)}, 0.0, 1.0);
  vec2 best = w00 >= max(w10, max(w01, w11)) ? uv00 : w10 >= max(w01, w11) ? uv10 : w01 >= w11 ? uv01 : uv11;
  vec3 n = texture2D(poolNormals, best).xyz * 2.0 - 1.0;
  // The light this surface was drawn with (the forward lamps in it), and the pool on top, both under one.
  vec3 lit = max(lightPoolLit(n, -p, poolSunView, shadow), vec3(0.02));
  vec3 total = min(lit + pool, vec3(1.0));
  vec3 litPow = pow(lit, vec3(2.2));
  vec3 linear = cinematicToLinear(scene);
  vec3 albedo = linear / litPow;
  // Bounded as a whole, so the hue holds: under a blue night light a red channel's estimate runs high first.
  albedo *= min(1.0, ${LIGHT_POOL_ALBEDO_CAP.toFixed(3)} / max(max(albedo.r, albedo.g), max(albedo.b, 1e-4)));
  if (poolDebug > 1.5) { gl_FragColor = vec4(poolDebug > 2.5 ? albedo : lit, 1.0); return; }
  linear += albedo * max(pow(total, vec3(2.2)) - litPow, vec3(0.0));
  gl_FragColor = vec4(cinematicToDisplay(linear), 1.0);
}`;

/** Copies the frame's first `count` instances into `attribute` and marks only those for upload. */
function upload(attribute: THREE.InstancedBufferAttribute, values: Float32Array, count: number): void {
  const floats = count * LIGHT_POOL_INSTANCE_FLOATS;
  (attribute.array as Float32Array).set(values.subarray(0, floats));
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, floats);
  attribute.needsUpdate = true;
}

/** What a frame hands the pass. */
export interface LightPoolFrame {
  readonly scene: THREE.Texture;
  readonly depth: THREE.DepthTexture;
  readonly camera: THREE.PerspectiveCamera;
  readonly width: number;
  readonly height: number;
  readonly contextGeneration: number;
  readonly pools: LightPools;
  /**
   * Drawn into the pooled frame after the pools, with the world depth for its own test: the additive
   * halos and far glows, which the apply pass must not take for a lit surface (`LightHalos.drawLate`).
   */
  readonly late?: ((renderer: THREE.WebGLRenderer, depth: THREE.Texture, width: number, height: number) => void) | undefined;
}

interface Targets {
  readonly width: number;
  readonly height: number;
  readonly contextGeneration: number;
  readonly normals: THREE.WebGLRenderTarget;
  readonly light: THREE.WebGLRenderTarget;
  readonly pooled: THREE.WebGLRenderTarget;
}

export class LightPoolPass {
  readonly #worldLight: WorldLightUniforms;
  readonly #uniforms = {
    source: { value: null as THREE.Texture | null },
    poolLight: { value: null as THREE.Texture | null },
    poolNormals: { value: null as THREE.Texture | null },
    depthTexture: { value: null as THREE.Texture | null },
    inverseProjection: { value: new THREE.Matrix4() },
    depthTexel: { value: new THREE.Vector2() },
    poolTexel: { value: new THREE.Vector2() },
    poolProjection: { value: new THREE.Vector2() },
    poolNear: { value: 0.1 },
    poolSunView: { value: new THREE.Vector3(0, 1, 0) },
    poolDebug: { value: 0 },
  };
  readonly #normals: THREE.ShaderMaterial;
  readonly #light: THREE.ShaderMaterial;
  readonly #apply: THREE.ShaderMaterial;
  readonly #quadScene = new THREE.Scene();
  readonly #quad: THREE.Mesh;
  readonly #lightScene = new THREE.Scene();
  readonly #lightGeometry = new THREE.InstancedBufferGeometry();
  readonly #lampAttribute: THREE.InstancedBufferAttribute;
  readonly #colourAttribute: THREE.InstancedBufferAttribute;
  readonly #camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly #clearColour = new THREE.Color();
  #targets: Targets | undefined;
  #halfFloat: boolean | undefined;

  constructor(worldLight: WorldLightUniforms) {
    this.#worldLight = worldLight;
    // The world light's own uniform objects: the deferred term reads the very values the forward one does.
    const world = worldLight as unknown as Record<string, { value: unknown }>;
    const shared = { ...world, ...this.#uniforms } as unknown as THREE.ShaderMaterial["uniforms"];
    const pass = (vertexShader: string, fragmentShader: string, blending: THREE.Blending): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        uniforms: shared, vertexShader, fragmentShader, depthTest: false, depthWrite: false, fog: false,
        toneMapped: false, blending,
      });
    this.#normals = pass(VERTEX, NORMALS, THREE.NoBlending);
    this.#light = pass(LIGHT_VERTEX, LIGHT_FRAGMENT, THREE.AdditiveBlending);
    this.#apply = pass(VERTEX, APPLY, THREE.NoBlending);
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.#quad = new THREE.Mesh(triangle, this.#apply);
    this.#quad.frustumCulled = false;
    this.#quadScene.add(this.#quad);
    const geometry = this.#lightGeometry;
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.#lampAttribute = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_POOL_LIMIT * LIGHT_POOL_INSTANCE_FLOATS),
      LIGHT_POOL_INSTANCE_FLOATS).setUsage(THREE.DynamicDrawUsage);
    this.#colourAttribute = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_POOL_LIMIT * LIGHT_POOL_INSTANCE_FLOATS),
      LIGHT_POOL_INSTANCE_FLOATS).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("poolLamp", this.#lampAttribute);
    geometry.setAttribute("poolColour", this.#colourAttribute);
    geometry.instanceCount = 0;
    const lights = new THREE.Mesh(geometry, this.#light);
    lights.frustumCulled = false;
    this.#lightScene.add(lights);
  }

  /** Normals, light and apply, in that order (the renderer warms them up). */
  get materials(): readonly THREE.ShaderMaterial[] {
    return [this.#normals, this.#light, this.#apply];
  }

  /** Bench only: shows the half-resolution pool light itself in place of the frame. */
  setDebug(mode: number): void {
    this.#uniforms.poolDebug.value = mode;
  }

  /** The instanced quads the light pass draws (for the warm-up). */
  get lightGeometry(): THREE.BufferGeometry {
    return this.#lightGeometry;
  }

  /** Buffers currently allocated, for resource accounting. */
  get renderTargets(): readonly THREE.WebGLRenderTarget[] {
    const targets = this.#targets;
    return targets ? [targets.normals, targets.light, targets.pooled] : [];
  }

  /**
   * Draws the frame's pools; returns the pooled frame, or undefined when there is nothing to draw
   * (no pool in view, or the buffers could not be made) and the capture stands as it is.
   */
  render(renderer: THREE.WebGLRenderer, frame: Readonly<LightPoolFrame>): THREE.Texture | undefined {
    const count = frame.pools.count;
    if (count === 0) return undefined;
    const targets = this.#sync(renderer, frame);
    if (!targets) return undefined;
    const u = this.#uniforms;
    const camera = frame.camera;
    const projection = camera.projectionMatrix.elements;
    u.inverseProjection.value.copy(camera.projectionMatrixInverse);
    u.depthTexture.value = frame.depth;
    u.depthTexel.value.set(1 / Math.max(1, frame.width), 1 / Math.max(1, frame.height));
    u.poolTexel.value.set(1 / targets.light.width, 1 / targets.light.height);
    u.poolProjection.value.set(projection[0]!, projection[5]!);
    u.poolNear.value = camera.near;
    u.poolSunView.value.copy(this.#worldLight.wowSunDirection.value).transformDirection(camera.matrixWorldInverse);

    upload(this.#lampAttribute, frame.pools.lamps, count);
    upload(this.#colourAttribute, frame.pools.colours, count);
    this.#lightGeometry.instanceCount = count;

    const quad = this.#quad;
    quad.material = this.#normals;
    renderer.setRenderTarget(targets.normals);
    renderer.render(this.#quadScene, this.#camera);

    u.poolNormals.value = targets.normals.texture;
    renderer.setRenderTarget(targets.light);
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.#clearColour);
    const autoClear = renderer.autoClear;
    try {
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.autoClear = false;
      renderer.render(this.#lightScene, this.#camera);
    } finally {
      renderer.autoClear = autoClear;
      renderer.setClearColor(this.#clearColour, clearAlpha);
    }

    u.source.value = frame.scene;
    u.poolLight.value = targets.light.texture;
    quad.material = this.#apply;
    renderer.setRenderTarget(targets.pooled);
    renderer.render(this.#quadScene, this.#camera);
    frame.late?.(renderer, frame.depth, frame.width, frame.height);
    return targets.pooled.texture;
  }

  /** Drops sampler references to frame-owned textures once the frame is composed. */
  release(): void {
    const u = this.#uniforms;
    u.source.value = null;
    u.depthTexture.value = null;
    u.poolLight.value = null;
    u.poolNormals.value = null;
  }

  dispose(): void {
    const targets = this.#targets;
    this.#targets = undefined;
    this.release();
    targets?.normals.dispose();
    targets?.light.dispose();
    targets?.pooled.dispose();
  }

  #sync(renderer: THREE.WebGLRenderer, frame: Readonly<LightPoolFrame>): Targets | undefined {
    const current = this.#targets;
    if (current && current.width === frame.width && current.height === frame.height
      && current.contextGeneration === frame.contextGeneration) return current;
    this.dispose();
    if (this.#halfFloat === undefined || current?.contextGeneration !== frame.contextGeneration) {
      try {
        this.#halfFloat = renderer.extensions.has("EXT_color_buffer_float")
          || renderer.extensions.has("EXT_color_buffer_half_float");
      } catch {
        this.#halfFloat = false;
      }
    }
    const made: THREE.WebGLRenderTarget[] = [];
    try {
      const target = (width: number, height: number, name: string, options: THREE.RenderTargetOptions): THREE.WebGLRenderTarget => {
        const buffer = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height),
          { depthBuffer: false, stencilBuffer: false, ...options });
        buffer.texture.name = name;
        made.push(buffer);
        return buffer;
      };
      const halfWidth = Math.floor(frame.width / 2);
      const halfHeight = Math.floor(frame.height / 2);
      this.#targets = Object.freeze({
        width: frame.width,
        height: frame.height,
        contextGeneration: frame.contextGeneration,
        normals: target(halfWidth, halfHeight, "light-pool-normals",
          { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
        light: target(halfWidth, halfHeight, "light-pool-light",
          { type: this.#halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType }),
        pooled: target(frame.width, frame.height, "light-pool-scene", { type: THREE.UnsignedByteType }),
      });
      return this.#targets;
    } catch {
      for (const buffer of made) {
        try { buffer.dispose(); } catch { /* best effort */ }
      }
      return undefined;
    }
  }
}
