import * as THREE from "three";
import "./ShapedFogChunk.js"; // the stock fog chunks this material includes call `wowFogFactor`; installed on import

/**
 * 7.40 «Атмосфера зон»: dust hanging in a cave's or mine's still air — a few hundred specks round the camera, slowly
 * sinking and drifting, dimly lit by the room's own light. Not in Wow.exe; the enhanced levels only.
 *
 * One draw of points. The specks live in a box that wraps round the camera (the weather cloud's trick), so nothing is
 * rebuilt as the player walks; their positions move in the vertex shader from a clock the CPU keeps small.
 */

export const DUST_COUNT = 420;
/** Side of the box the specks wrap in (yards). */
export const DUST_BOX = 18;

const VERTEX = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uPixelScale;
uniform vec3 uBox;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  // Each speck sinks slowly and sways on its own phase; the box wraps round the camera.
  vec3 drift = vec3( sin( uTime * 0.21 + aSeed.w * 6.28 ) * 0.6, -0.12 * uTime * ( 0.5 + aSeed.w ),
    cos( uTime * 0.17 + aSeed.w * 4.1 ) * 0.6 );
  vec3 local = mod( aSeed.xyz * uBox + drift - cameraPosition + 0.5 * uBox, uBox ) - 0.5 * uBox;
  vec3 world = cameraPosition + local;
  vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  float depth = max( -mvPosition.z, 0.05 );
  gl_PointSize = clamp( ( 0.05 + 0.04 * aSeed.w ) * uPixelScale / depth, 1.5, 8.0 );
  // Fades at the box's faces and right at the eye, and twinkles a little as it turns.
  vec3 edge = abs( local ) / ( 0.5 * uBox );
  float rim = 1.0 - smoothstep( 0.7, 1.0, max( max( edge.x, edge.y ), edge.z ) );
  vAlpha = rim * smoothstep( 0.4, 1.5, depth ) * ( 0.55 + 0.45 * sin( uTime * ( 0.8 + aSeed.w ) + aSeed.x * 20.0 ) );
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uOpacity;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float disc = 1.0 - smoothstep( 0.2, 0.5, length( c ) );
  float alpha = disc * vAlpha * uOpacity;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( uColour, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class ZoneDust {
  readonly object: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  #time = 0;

  constructor() {
    const seeds = new Float32Array(DUST_COUNT * 4);
    // A fixed scatter (no Math.random: replays and stills are deterministic).
    let s = 0x9e3779b9;
    const next = (): number => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    for (let i = 0; i < seeds.length; i++) seeds[i] = next();
    const geometry = new THREE.BufferGeometry();
    // Positions are made in the shader; three still wants a position attribute for the draw count.
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DUST_COUNT * 3), 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      name: "zone-cave-dust",
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 },
        uPixelScale: { value: 500 },
        uBox: { value: new THREE.Vector3(DUST_BOX, DUST_BOX * 0.6, DUST_BOX) },
        uColour: { value: new THREE.Color(1, 1, 1) },
        uOpacity: { value: 0 },
      }]),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.object = new THREE.Points(geometry, this.material);
    this.object.name = "zone-cave-dust";
    this.object.frustumCulled = false; // the box is wherever the camera is
    this.object.renderOrder = 3;
    this.object.visible = false;
  }

  /** `amount` 0..~2 (the cave weight times the setting's strength); `light` linear, the room's light. */
  update(amount: number, light: THREE.Color, pixelScale: number, elapsed: number): void {
    if (!(amount > 0.01)) {
      this.object.visible = false;
      return;
    }
    const step = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.25, elapsed)) : 0;
    // Wrapped well inside float precision; the drift's periods are much shorter.
    this.#time = (this.#time + step) % 2048;
    const u = this.material.uniforms;
    u["uTime"]!.value = this.#time;
    u["uPixelScale"]!.value = Number.isFinite(pixelScale) && pixelScale > 0 ? pixelScale : 500;
    // Dust shows the light it floats in, a little brighter than the walls round it.
    (u["uColour"]!.value as THREE.Color).setRGB(
      Math.min(1, 0.12 + light.r * 0.9), Math.min(1, 0.11 + light.g * 0.85), Math.min(1, 0.1 + light.b * 0.75));
    u["uOpacity"]!.value = Math.min(0.9, 0.6 * amount);
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  reset(): void {
    this.#time = 0;
    this.object.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
