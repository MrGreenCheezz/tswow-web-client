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
 * CPU twin of the halo's radial profile at `r` (0 centre … 1 quad edge): a gaussian core and a
 * wide skirt, scaled so the edge is exactly zero.
 */
export function lightHaloProfile(r: number): number {
  if (!Number.isFinite(r) || r < 0 || r >= 1) return 0;
  const edge = 1 - r * r;
  return (0.75 * Math.exp(-18 * r * r) + 0.25 * Math.exp(-3.5 * r * r)) * edge * edge;
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
void main() {
  vHaloUv = position.xy;
  vHaloColour = haloColour;
  vec4 centre = viewMatrix * vec4( haloCentre.xyz, 1.0 );
  // A yard towards the camera (never past the near plane), so the wall a lantern hangs on does not
  // halve its core; not further, or a lamp behind a wall would be pulled out in front of it.
  float pull = min( 1.0, max( -centre.z - 0.5, 0.0 ) );
  centre.xyz += normalize( -centre.xyz ) * pull;
  centre.xy += position.xy * haloCentre.w;
  gl_Position = projectionMatrix * centre;
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vHaloUv;
varying vec3 vHaloColour;
void main() {
  float r2 = dot( vHaloUv, vHaloUv );
  if ( r2 >= 1.0 ) discard;
  float edge = 1.0 - r2;
  float profile = ( 0.75 * exp( -18.0 * r2 ) + 0.25 * exp( -3.5 * r2 ) ) * edge * edge;
  gl_FragColor = vec4( vHaloColour * profile, 1.0 );
}
`;

export class LightHalos {
  readonly mesh: THREE.InstancedMesh;
  readonly #centres: THREE.InstancedBufferAttribute;
  readonly #colours: THREE.InstancedBufferAttribute;

  constructor() {
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.#centres = new THREE.InstancedBufferAttribute(new Float32Array(WORLD_LOCAL_LIGHT_LIMIT * 4), 4);
    this.#colours = new THREE.InstancedBufferAttribute(new Float32Array(WORLD_LOCAL_LIGHT_LIMIT * 3), 3);
    this.#centres.setUsage(THREE.DynamicDrawUsage);
    this.#colours.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("haloCentre", this.#centres);
    geometry.setAttribute("haloColour", this.#colours);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, WORLD_LOCAL_LIGHT_LIMIT);
    this.mesh.name = "lightHalos";
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
    const index = this.mesh.count;
    if (index >= WORLD_LOCAL_LIGHT_LIMIT) return;
    const weight = LIGHT_HALO_STRENGTH * strength * lightHaloWeight(daylight, position.distanceTo(camera));
    if (!(weight > 0.002)) return;
    const centres = this.#centres.array as Float32Array;
    const colours = this.#colours.array as Float32Array;
    centres[index * 4] = position.x;
    centres[index * 4 + 1] = position.y;
    centres[index * 4 + 2] = position.z;
    centres[index * 4 + 3] = LIGHT_HALO_RADIUS;
    colours[index * 3] = colour.x * weight;
    colours[index * 3 + 1] = colour.y * weight;
    colours[index * 3 + 2] = colour.z * weight;
    this.mesh.count = index + 1;
  }

  end(): void {
    if (this.mesh.count === 0) return;
    this.#centres.addUpdateRange(0, this.mesh.count * 4);
    this.#colours.addUpdateRange(0, this.mesh.count * 3);
    this.#centres.needsUpdate = true;
    this.#colours.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
