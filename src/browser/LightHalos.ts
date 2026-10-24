/**
 * 22.10 (7.36): the soft halo around a lit fixture — the light seen in the night air around a
 * lantern, brazier or campfire, which the pool on the ground alone does not give (owner, 22.10:
 * «мягкий ореол»). Cinematic profile only.
 *
 * One instanced quad per selected fixture light, drawn additively in the scene after the opaque
 * world: a tight bright core and a wide faint skirt (the haze the light scatters in), both fading
 * to nothing at the quad's edge. The quad is pulled towards the camera by its radius so the wall a
 * lamp hangs on does not cut it in half, and depth-tested so a wall in front still hides it.
 *
 * One `ShaderMaterial` built with the renderer and kept visible with zero instances when there is
 * nothing to draw: its program is compiled at the first frame, never mid-play, and the instance
 * count is the only thing a frame changes.
 */
import * as THREE from "three";
import { WORLD_LOCAL_LIGHT_LIMIT } from "./WorldLighting.js";

/** World radius of a halo quad, yards. */
export const LIGHT_HALO_RADIUS = 3.2;
/** Halo strength per unit of the light's colour · intensity, at night and full selection weight. */
export const LIGHT_HALO_STRENGTH = 0.6;
/** Share of the halo that remains by day (the sun outshines a lantern). */
export const LIGHT_HALO_DAY_SHARE = 0.08;
/** Camera distance over which a halo fades out, yards: none past the second number. */
export const LIGHT_HALO_FADE: readonly [number, number] = Object.freeze([48, 64]);

/**
 * 22.10 (7.36): weight of the halo's tight core against its wide skirt (`LIGHT_HALO_SKIRT`). Owner,
 * 22.10: the halo and the spill are good, the source itself burns. The core lies on the lamp's own
 * glass and glow card, which the client already draws at full brightness: at 0.75 a Goldshire
 * lantern read 2.5 times the faithful profile's luma; the skirt is what reads as the light in the air.
 */
export const LIGHT_HALO_CORE = 0.2;
/** Weight of the halo's wide skirt. */
export const LIGHT_HALO_SKIRT = 0.25;

/**
 * CPU twin of the halo's radial profile at `r` (0 centre … 1 quad edge): a gaussian core and a
 * wide skirt, scaled so the edge is exactly zero.
 */
export function lightHaloProfile(r: number): number {
  if (!Number.isFinite(r) || r < 0 || r >= 1) return 0;
  const edge = 1 - r * r;
  return (LIGHT_HALO_CORE * Math.exp(-18 * r * r) + LIGHT_HALO_SKIRT * Math.exp(-3.5 * r * r)) * edge * edge;
}

/** CPU twin of the halo strength's day/night and distance weight. */
export function lightHaloWeight(daylight: number, cameraDistance: number): number {
  const day = Math.max(0, Math.min(1, Number.isFinite(daylight) ? daylight : 1));
  const [near, far] = LIGHT_HALO_FADE;
  const t = Math.max(0, Math.min(1, (cameraDistance - near) / (far - near)));
  const fade = 1 - t * t * (3 - 2 * t);
  return (LIGHT_HALO_DAY_SHARE + (1 - LIGHT_HALO_DAY_SHARE) * (1 - day)) * (Number.isFinite(cameraDistance) ? fade : 0);
}

const VERTEX = /* glsl */ `
attribute vec4 haloCentre;
attribute vec3 haloColour;
varying vec2 vHaloUv;
varying vec3 vHaloColour;
varying float vHaloDistance; // 24.10 (7.50)
void main() {
  vHaloUv = position.xy;
  vHaloColour = haloColour;
  vec4 centre = viewMatrix * vec4( haloCentre.xyz, 1.0 );
  // A yard towards the camera (never past the near plane), so the wall a lantern hangs on does not
  // halve its core; not further, or a lamp behind a wall would be pulled out in front of it.
  float pull = min( 1.0, max( -centre.z - 0.5, 0.0 ) );
  centre.xyz += normalize( -centre.xyz ) * pull;
  centre.xy += position.xy * haloCentre.w;
  vHaloDistance = -centre.z;
  gl_Position = projectionMatrix * centre;
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vHaloUv;
varying vec3 vHaloColour;
varying float vHaloDistance;
// 24.10 (7.50): drawn after the screen-space pools into a target without depth (drawLate): the
// resolved world depth is read here instead. x on, yz one over the target's size; projection[2][2], [3][2].
uniform highp sampler2D haloSceneDepth;
uniform vec3 haloDepthTest;
uniform vec2 haloProjection;
void main() {
  float r2 = dot( vHaloUv, vHaloUv );
  if ( r2 >= 1.0 ) discard;
  if ( haloDepthTest.x > 0.5 ) {
    float ndc = texture2D( haloSceneDepth, gl_FragCoord.xy * haloDepthTest.yz ).r * 2.0 - 1.0;
    if ( vHaloDistance > haloProjection.y / ( ndc + haloProjection.x ) ) discard;
  }
  float edge = 1.0 - r2;
  float profile = ( ${LIGHT_HALO_CORE.toFixed(3)} * exp( -18.0 * r2 ) + ${LIGHT_HALO_SKIRT.toFixed(3)} * exp( -3.5 * r2 ) ) * edge * edge;
  gl_FragColor = vec4( vHaloColour * profile, 1.0 );
}
`;

export class LightHalos {
  readonly mesh: THREE.InstancedMesh;
  readonly #centres: THREE.InstancedBufferAttribute;
  readonly #colours: THREE.InstancedBufferAttribute;
  readonly #capacity: number;
  /** 24.10 (7.50): the late draw's depth test (`drawLate`); off for the ordinary draw in the world pass. */
  readonly #depthUniforms = {
    haloSceneDepth: { value: null as THREE.Texture | null },
    haloDepthTest: { value: new THREE.Vector3() },
    haloProjection: { value: new THREE.Vector2() },
  };

  /**
   * 22.10 (7.46): `capacity` and `name` let the far glows (`FarLightGlows.ts`) keep their own,
   * larger instance set over the same shader source, so three shares the one program.
   */
  constructor(capacity = WORLD_LOCAL_LIGHT_LIMIT, name = "lightHalos") {
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.#capacity = Math.max(1, Math.floor(capacity));
    this.#centres = new THREE.InstancedBufferAttribute(new Float32Array(this.#capacity * 4), 4);
    this.#colours = new THREE.InstancedBufferAttribute(new Float32Array(this.#capacity * 3), 3);
    this.#centres.setUsage(THREE.DynamicDrawUsage);
    this.#colours.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("haloCentre", this.#centres);
    geometry.setAttribute("haloColour", this.#colours);
    const material = new THREE.ShaderMaterial({
      uniforms: this.#depthUniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.#capacity);
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 3;
  }

  /** Starts a frame's halos; `begin` + `add`… + `end`. */
  begin(): void {
    this.mesh.count = 0;
  }

  /** One light: scene position, linear colour, colour strength (intensity × selection weight). */
  add(position: THREE.Vector3, colour: THREE.Vector3, strength: number, daylight: number, camera: THREE.Vector3): void {
    const weight = LIGHT_HALO_STRENGTH * strength * lightHaloWeight(daylight, position.distanceTo(camera));
    if (!(weight > 0.002)) return;
    this.addGlow(position.x, position.y, position.z, LIGHT_HALO_RADIUS,
      colour.x * weight, colour.y * weight, colour.z * weight);
  }

  /** 22.10 (7.46): one quad as given — centre, world radius and the final additive colour. */
  addGlow(x: number, y: number, z: number, radius: number, red: number, green: number, blue: number): void {
    const index = this.mesh.count;
    if (index >= this.#capacity) return;
    const centres = this.#centres.array as Float32Array;
    const colours = this.#colours.array as Float32Array;
    centres[index * 4] = x;
    centres[index * 4 + 1] = y;
    centres[index * 4 + 2] = z;
    centres[index * 4 + 3] = radius;
    colours[index * 3] = red;
    colours[index * 3 + 1] = green;
    colours[index * 3 + 2] = blue;
    this.mesh.count = index + 1;
  }

  end(): void {
    if (this.mesh.count === 0) return;
    this.#centres.addUpdateRange(0, this.mesh.count * 4);
    this.#colours.addUpdateRange(0, this.mesh.count * 3);
    this.#centres.needsUpdate = true;
    this.#colours.needsUpdate = true;
  }

  /**
   * 24.10 (7.50): draws this frame's quads now, into the bound target — after the screen-space pools
   * (`LightPoolPass.ts`), so their colour is never taken for a lit surface's and multiplied up. With
   * `depth` (the resolved world depth of a `width` × `height` frame) the test is the shader's, for a
   * target with no depth buffer; without it, the bound target's own depth buffer. The caller hid the
   * mesh from the world pass and shows it again after the frame.
   */
  drawLate(renderer: THREE.WebGLRenderer, camera: THREE.Camera, depth: THREE.Texture | null, width: number, height: number): void {
    if (this.mesh.count === 0) return;
    const material = this.mesh.material as THREE.ShaderMaterial;
    const u = this.#depthUniforms;
    const projection = camera.projectionMatrix.elements;
    u.haloSceneDepth.value = depth;
    u.haloDepthTest.value.set(depth ? 1 : 0, 1 / Math.max(1, width), 1 / Math.max(1, height));
    u.haloProjection.value.set(projection[10]!, projection[14]!);
    material.depthTest = depth === null;
    const autoClear = renderer.autoClear;
    this.mesh.visible = true;
    try {
      renderer.autoClear = false;
      renderer.render(this.mesh, camera);
    } finally {
      renderer.autoClear = autoClear;
      this.mesh.visible = false;
      material.depthTest = true;
      u.haloDepthTest.value.x = 0;
      u.haloSceneDepth.value = null;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
