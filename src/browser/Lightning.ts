/**
 * Lightning for a thunderstorm (`experimentalLightning`).
 *
 * Only for `WEATHER_STATE_THUNDERS` (86): it is the one state TrinityCore's weather system sends
 * for a storm (`Weather::GetWeatherState`, WEATHER_TYPE_THUNDERS), and the client itself draws no
 * lightning for it. Nothing is invented about the server: no packet is read beyond the state and
 * intensity the renderer already holds, and nothing is sent.
 *
 * A strike is three draws for about half a second, and nothing at all between strikes:
 * - the sky lights up — a camera-centred sphere just inside the far plane, drawn with the depth
 *   test on, so it only covers pixels the world left empty (the world pass clears depth after
 *   the sky prepass), brightest towards the bolt;
 * - the bolt itself, a jagged ribbon a few hundred yards out, hidden by any hill in front of it;
 * - a faint full-frame lift so the ground flickers with the sky.
 *
 * Timing is deterministic (a seeded generator advanced only by strikes), so the bench replays it.
 */

import * as THREE from "three";

export const LIGHTNING_MIN_GAP_SECONDS = 5;
export const LIGHTNING_MAX_GAP_SECONDS = 17;
export const LIGHTNING_FLASH_SECONDS = 0.62;
const BOLT_SEGMENTS = 22;
const BRANCH_SEGMENTS = 9;
const BOLT_VERTICES = (BOLT_SEGMENTS + 1 + BRANCH_SEGMENTS + 1) * 2;

/**
 * Brightness of a strike `t` seconds after it began: a leader flash, a dimmer return and a longer
 * main stroke, as real strikes flicker two or three times. 0 outside [0, FLASH_SECONDS].
 */
export function lightningEnvelope(t: number): number {
  if (!(t >= 0) || t > LIGHTNING_FLASH_SECONDS) return 0;
  const pulse = (start: number, width: number, peak: number) => {
    const x = t - start;
    if (x < 0) return 0;
    return peak * Math.exp(-x / width);
  };
  return Math.min(1, pulse(0, 0.045, 0.75) + pulse(0.11, 0.035, 0.45) + pulse(0.22, 0.13, 1));
}

/** Seconds until the next strike, for a storm of `strength` 0..1 and a unit random draw. */
export function lightningGap(strength: number, unit: number): number {
  const s = Math.max(0.05, Math.min(1, strength));
  const span = LIGHTNING_MAX_GAP_SECONDS - LIGHTNING_MIN_GAP_SECONDS;
  return (LIGHTNING_MIN_GAP_SECONDS + span * Math.max(0, Math.min(1, unit))) / (0.55 + 0.45 * s);
}

const SKY_VERTEX = `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize( ( modelMatrix * vec4( position, 0.0 ) ).xyz );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
const SKY_FRAGMENT = `
  uniform float uFlash;
  uniform vec3 uBolt;
  uniform vec3 uColour;
  varying vec3 vDirection;
  void main() {
    float toward = max( dot( normalize( vDirection ), uBolt ), 0.0 );
    float above = smoothstep( -0.05, 0.25, vDirection.y );
    float glow = ( 0.22 + 0.78 * pow( toward, 6.0 ) ) * above;
    gl_FragColor = vec4( uColour * glow * uFlash, 1.0 );
  }`;
const BOLT_VERTEX = `
  attribute float edge;
  varying float vEdge;
  void main() {
    vEdge = edge;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
const BOLT_FRAGMENT = `
  uniform float uFlash;
  uniform vec3 uColour;
  varying float vEdge;
  void main() {
    float core = 1.0 - smoothstep( 0.15, 1.0, abs( vEdge ) );
    gl_FragColor = vec4( uColour * core * uFlash * 2.2, 1.0 );
  }`;
const LIFT_VERTEX = `
  void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;
const LIFT_FRAGMENT = `
  uniform float uFlash;
  uniform vec3 uColour;
  void main() { gl_FragColor = vec4( uColour * uFlash, 1.0 ); }`;

export class Lightning {
  readonly group = new THREE.Group();
  readonly #sky: THREE.Mesh;
  readonly #bolt: THREE.Mesh;
  readonly #lift: THREE.Mesh;
  readonly #skyUniforms = {
    uFlash: { value: 0 }, uBolt: { value: new THREE.Vector3(0, 1, 0) }, uColour: { value: new THREE.Color(0.62, 0.7, 0.95) },
  };
  readonly #boltUniforms = { uFlash: { value: 0 }, uColour: { value: new THREE.Color(0.85, 0.9, 1) } };
  readonly #liftUniforms = { uFlash: { value: 0 }, uColour: { value: new THREE.Color(0.55, 0.62, 0.8) } };
  readonly #boltPositions = new Float32Array(BOLT_VERTICES * 3);
  readonly #boltGeometry: THREE.BufferGeometry;
  readonly #points = new Float32Array((BOLT_SEGMENTS + 1) * 3);
  readonly #branch = new Float32Array((BRANCH_SEGMENTS + 1) * 3);
  readonly #scratch = new THREE.Vector3();
  readonly #side = new THREE.Vector3();
  #random = 0x6d2b79f5;
  #sinceStrike = Number.POSITIVE_INFINITY;
  #untilStrike = 3;
  #flash = 0;
  #strikes = 0;
  #strikeDistance = 0;
  #strikePan = 0;
  #strikeStrength = 0;

  constructor() {
    const skyGeometry = new THREE.SphereGeometry(1, 24, 12);
    this.#sky = new THREE.Mesh(skyGeometry, new THREE.ShaderMaterial({
      uniforms: this.#skyUniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, depthTest: true,
    }));
    this.#sky.frustumCulled = false;
    this.#sky.renderOrder = 5;

    this.#boltGeometry = new THREE.BufferGeometry();
    this.#boltGeometry.setAttribute("position", new THREE.BufferAttribute(this.#boltPositions, 3));
    const edges = new Float32Array(BOLT_VERTICES);
    for (let i = 0; i < BOLT_VERTICES; i++) edges[i] = i % 2 === 0 ? -1 : 1;
    this.#boltGeometry.setAttribute("edge", new THREE.BufferAttribute(edges, 1));
    const indices: number[] = [];
    const strip = (first: number, segments: number) => {
      for (let i = 0; i < segments; i++) {
        const a = first + i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    };
    strip(0, BOLT_SEGMENTS);
    strip((BOLT_SEGMENTS + 1) * 2, BRANCH_SEGMENTS);
    this.#boltGeometry.setIndex(indices);
    this.#bolt = new THREE.Mesh(this.#boltGeometry, new THREE.ShaderMaterial({
      uniforms: this.#boltUniforms, vertexShader: BOLT_VERTEX, fragmentShader: BOLT_FRAGMENT,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, depthTest: true,
    }));
    this.#bolt.frustumCulled = false;
    this.#bolt.renderOrder = 5;

    const liftGeometry = new THREE.BufferGeometry();
    liftGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.#lift = new THREE.Mesh(liftGeometry, new THREE.ShaderMaterial({
      uniforms: this.#liftUniforms, vertexShader: LIFT_VERTEX, fragmentShader: LIFT_FRAGMENT,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false,
    }));
    this.#lift.frustumCulled = false;
    this.#lift.renderOrder = 6;

    this.group.add(this.#sky, this.#bolt, this.#lift);
    this.group.visible = false;
  }

  /** 0..1 brightness of the flash this frame, for anyone else who wants to flicker with it. */
  get flash(): number { return this.#flash; }
  /**
   * How many strikes have happened (a counter the thunder listens to), and where the last one was:
   * its distance from the camera in yards, where it sits across the view (-1 left … 1 right, the
   * sine of its bearing from the camera's facing) and the storm strength it struck in (0..1).
   */
  get strikes(): number { return this.#strikes; }
  get strikeDistance(): number { return this.#strikeDistance; }
  get strikePan(): number { return this.#strikePan; }
  get strikeStrength(): number { return this.#strikeStrength; }

  #next(): number {
    this.#random = (Math.imul(this.#random ^ (this.#random >>> 15), 0x2c1b3c6d) + 0x1b873593) >>> 0;
    return (this.#random >>> 8) / 0x1000000;
  }

  /**
   * `storm` 0..1 is how much thunderstorm is on screen (0 disarms and hides everything);
   * `indoors` dims the flash to a glimpse through the windows.
   */
  update(camera: THREE.PerspectiveCamera, elapsed: number, storm: number, indoors: boolean): void {
    const step = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.25, elapsed)) : 0;
    if (storm <= 0.02) {
      this.#flash = 0;
      this.#sinceStrike = Number.POSITIVE_INFINITY;
      this.group.visible = false;
      return;
    }
    this.#sinceStrike += step;
    this.#untilStrike -= step;
    if (this.#untilStrike <= 0) {
      this.#untilStrike = lightningGap(storm, this.#next());
      this.#sinceStrike = 0;
      this.#strike(camera);
      this.#strikes++;
      this.#strikeStrength = Math.min(1, 0.4 + 0.6 * storm);
    }
    const envelope = lightningEnvelope(this.#sinceStrike);
    this.#flash = envelope * Math.min(1, 0.4 + 0.6 * storm) * (indoors ? 0.35 : 1);
    if (this.#flash <= 0.002) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const radius = camera.far * 0.9;
    this.#sky.position.copy(camera.position);
    this.#sky.scale.setScalar(radius);
    this.#skyUniforms.uFlash.value = this.#flash * 0.85;
    this.#boltUniforms.uFlash.value = indoors ? 0 : this.#flash;
    this.#liftUniforms.uFlash.value = this.#flash * 0.09;
  }

  /** Picks a place in front of the camera and draws a new bolt there. */
  #strike(camera: THREE.PerspectiveCamera): void {
    const forward = camera.getWorldDirection(this.#scratch);
    const offset = (this.#next() - 0.5) * 1.9;
    const yaw = Math.atan2(forward.z, forward.x) + offset;
    const distance = Math.min(camera.far * 0.6, 240 + this.#next() * 260);
    // Scene space is right-handed with y up, so the camera's right is forward × up and a bolt
    // `offset` radians clockwise of the facing lies sin(offset) of the way to the right.
    this.#strikeDistance = distance;
    this.#strikePan = Math.sin(offset);
    const baseX = camera.position.x + Math.cos(yaw) * distance;
    const baseZ = camera.position.z + Math.sin(yaw) * distance;
    const top = camera.position.y + 150 + this.#next() * 60;
    const bottom = camera.position.y - 20;
    this.#skyUniforms.uBolt.value.set(Math.cos(yaw), 0.45, Math.sin(yaw)).normalize();
    // Midpoint-free random walk downward: small sideways steps with a slow drift.
    let x = baseX + (this.#next() - 0.5) * 40;
    let z = baseZ + (this.#next() - 0.5) * 40;
    const drift = (this.#next() - 0.5) * 3;
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      const y = top + (bottom - top) * (i / BOLT_SEGMENTS);
      this.#points[i * 3] = x;
      this.#points[i * 3 + 1] = y;
      this.#points[i * 3 + 2] = z;
      x += drift + (this.#next() - 0.5) * 14;
      z += (this.#next() - 0.5) * 14;
    }
    const from = 4 + Math.floor(this.#next() * 8);
    let bx = this.#points[from * 3]!;
    let by = this.#points[from * 3 + 1]!;
    let bz = this.#points[from * 3 + 2]!;
    const lean = this.#next() < 0.5 ? -1 : 1;
    for (let i = 0; i <= BRANCH_SEGMENTS; i++) {
      this.#branch[i * 3] = bx;
      this.#branch[i * 3 + 1] = by;
      this.#branch[i * 3 + 2] = bz;
      bx += lean * (4 + this.#next() * 8);
      by -= 6 + this.#next() * 6;
      bz += (this.#next() - 0.5) * 10;
    }
    const width = distance / 140;
    this.#ribbon(camera, this.#points, BOLT_SEGMENTS, 0, width);
    this.#ribbon(camera, this.#branch, BRANCH_SEGMENTS, (BOLT_SEGMENTS + 1) * 2, width * 0.55);
    (this.#boltGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  #ribbon(camera: THREE.PerspectiveCamera, points: Float32Array, segments: number, firstVertex: number, width: number): void {
    for (let i = 0; i <= segments; i++) {
      const j = Math.min(segments, i + 1);
      const k = Math.max(0, i - 1);
      const tx = points[j * 3]! - points[k * 3]!;
      const ty = points[j * 3 + 1]! - points[k * 3 + 1]!;
      const tz = points[j * 3 + 2]! - points[k * 3 + 2]!;
      const vx = points[i * 3]! - camera.position.x;
      const vy = points[i * 3 + 1]! - camera.position.y;
      const vz = points[i * 3 + 2]! - camera.position.z;
      this.#side.set(ty * vz - tz * vy, tz * vx - tx * vz, tx * vy - ty * vx);
      const length = this.#side.length() || 1;
      this.#side.multiplyScalar(width / length);
      const taper = 1 - 0.6 * (i / segments);
      const v = (firstVertex + i * 2) * 3;
      this.#boltPositions[v] = points[i * 3]! - this.#side.x * taper;
      this.#boltPositions[v + 1] = points[i * 3 + 1]! - this.#side.y * taper;
      this.#boltPositions[v + 2] = points[i * 3 + 2]! - this.#side.z * taper;
      this.#boltPositions[v + 3] = points[i * 3]! + this.#side.x * taper;
      this.#boltPositions[v + 4] = points[i * 3 + 1]! + this.#side.y * taper;
      this.#boltPositions[v + 5] = points[i * 3 + 2]! + this.#side.z * taper;
    }
  }

  /** Forces the next strike to happen now (used by local testing and tests). */
  strikeSoon(): void {
    this.#untilStrike = 0;
  }

  reset(): void {
    this.#random = 0x6d2b79f5;
    this.#sinceStrike = Number.POSITIVE_INFINITY;
    this.#untilStrike = 3;
    this.#flash = 0;
    this.#strikes = 0;
    this.#strikeDistance = 0;
    this.#strikePan = 0;
    this.#strikeStrength = 0;
    this.group.visible = false;
  }

  dispose(): void {
    this.group.visible = false;
    for (const mesh of [this.#sky, this.#bolt, this.#lift]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  get meshes(): readonly THREE.Mesh[] { return [this.#sky, this.#bolt, this.#lift]; }
}
