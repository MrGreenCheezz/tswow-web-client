/**
 * Cascaded sun shadows for the enhanced lighting qualities.
 *
 * One directional light per cascade, each with a zero intensity: the world materials replace
 * three's light integration (`WorldLighting.ts`) and only read the maps, matrices and shadow
 * parameters three binds for shadow-casting directional lights. The world-light shader picks, for
 * every fragment, the nearest cascade whose map covers it, blends across the border into the next
 * one, and fades the whole term out over the last stretch of `shadowDistance` measured from the
 * camera — so there is no edge anywhere that moves with the character.
 *
 * - The view-fitted cascades each enclose one slice of the view frustum in a sphere. A sphere
 *   depends only on the slice, the field of view and the aspect ratio, so the map keeps one texel
 *   size while the camera turns; its centre is snapped to whole texels in the light plane, so it
 *   does not crawl while the camera moves. They are rendered every frame and carry every caster:
 *   units, scenery and the WMO stand-ins.
 * - The outermost cascade is a camera-centred disc. It is rotation invariant by construction, so it
 *   is cached and re-rendered only when the camera leaves its margin, the sun turns, its casters
 *   change, or a refresh interval passes. It draws only the large static casters (`SHADOW_FAR_LAYER`)
 *   — never units, whose shadow in a stale map would be a ghost.
 *
 * Which casters each cascade draws is decided by layers, not by `castShadow`: three's shadow pass
 * tests every mesh against the layers of the camera it is handed, so each cascade is rendered here
 * with a camera whose layers name its casters. That is done by wrapping `shadowMap.render`, which
 * three calls from inside `render()` after the scene's matrices and skeletons are current and
 * before anything is drawn — the one point where a cascade can be both fresh and bound.
 */

import * as THREE from "three";
import {
  directionalShadowBasis, frustumSliceSphere, stabiliseDirectionalShadowCenter,
  type LightingProfile,
} from "./LightingQuality.js";

/** Depth-only WMO stand-ins live here: shadow cameras draw them, the view camera never does. */
export const SHADOW_PROXY_LAYER = 29;
/** Large static casters carry this layer as well as their own, and the cached cascade draws only them. */
export const SHADOW_FAR_LAYER = 30;

/** How far towards the sun, in yards, a caster may stand and still reach a view-fitted cascade. */
export const SHADOW_CASTER_REACH = 500;
/**
 * The same for the cached outermost cascade, which the terrain and the WDL horizon cast into: a
 * 300-yard mountain at a ten-degree sun throws its shadow 1,700 yards, and the ridge between the
 * player and a low sun is usually well past 500. The map's depth range grows with it; the bias is
 * expressed in yards, so nothing else changes.
 */
export const SHADOW_FAR_CASTER_REACH = 1400;
/** Share of a map, from its edge inwards, over which a cascade hands over to the next one. */
export const SHADOW_CASCADE_BLEND = 0.08;
/** World-space PCF blur a cascade aims for, in yards, before its texel clamp. */
const SHADOW_BLUR_YARDS = 0.15;
/** Overlap of each view-fitted slice with the one before it, as a fraction of that slice's end. */
const SLICE_OVERLAP = 0.85;

export interface ShadowCascadeStats {
  /** Map resolution, texels per side. */
  readonly mapSize: number;
  /** Half-width of the map in yards. */
  readonly extent: number;
  /** Yards per texel. */
  readonly texel: number;
  /** Whether this cascade was rendered on the last frame that rendered any. */
  readonly rendered: boolean;
  /** Draw calls of its last render. */
  readonly drawCalls: number;
  /** CPU submission time of its last render, in milliseconds. */
  readonly cpuMs: number;
  /** Renders since the cascades were configured. */
  readonly renders: number;
}

export interface ShadowCascadeSnapshot {
  readonly cascades: readonly ShadowCascadeStats[];
  /** Frames the cascades were updated on since they were configured. */
  readonly frames: number;
  /** Retained-but-hidden scenery made visible for the last shadow pass only. */
  readonly shadowOnlyCasters: number;
}

interface CascadeState {
  light: THREE.DirectionalLight;
  camera: THREE.Camera;
  lights: THREE.DirectionalLight[];
  /** The cached camera-centred disc, which reaches further towards the sun for its casters. */
  far: boolean;
  mapSize: number;
  extent: number;
  texel: number;
  scheduled: boolean;
  rendered: boolean;
  drawCalls: number;
  cpuMs: number;
  renders: number;
}

type ShadowRender = (this: THREE.WebGLShadowMap, lights: THREE.Light[], scene: THREE.Object3D, camera: THREE.Camera) => void;

/**
 * Whether the cached cascade has to be rendered again.
 *
 * `offset` is the camera's distance from the cascade's centre measured in the light plane, which is
 * the only movement that can carry the fade radius towards the map's edge.
 */
export function farCascadeStale(input: {
  dirty: boolean;
  framesSinceRender: number;
  refreshFrames: number;
  offset: number;
  margin: number;
  sunDot: number;
}): boolean {
  return input.dirty
    || input.framesSinceRender >= input.refreshFrames
    || !(input.offset <= input.margin * 0.5)
    || !(input.sunDot >= 0.999995);
}

export class CascadedSunShadows {
  readonly #primary: THREE.DirectionalLight;
  readonly #fade: { value: THREE.Vector3 };
  readonly #cascades: CascadeState[] = [];
  readonly #extras: THREE.DirectionalLight[] = [];
  #scene: THREE.Scene | undefined;
  #profile: LightingProfile | undefined;
  #installed: THREE.WebGLRenderer | undefined;
  #shadowOnly: ((on: boolean) => number) | undefined;
  #shadowOnlyCount = 0;
  #boundedCasters: ((out: THREE.Mesh[]) => void) | undefined;
  readonly #boundedList: THREE.Mesh[] = [];
  readonly #boundedHidden: THREE.Mesh[] = [];
  #boundedCulled = 0;
  readonly #basis = { right: new THREE.Vector3(), up: new THREE.Vector3() };
  readonly #boundedBox = new THREE.Box3();
  readonly #boundedCorner = new THREE.Vector3();
  #frames = 0;
  // Far-cascade cache state.
  #farDirty = true;
  #farRenderedFrame = -Infinity;
  readonly #farCenter = new THREE.Vector3();
  readonly #farSun = new THREE.Vector3();
  // Scratch.
  readonly #sun = new THREE.Vector3();
  readonly #forward = new THREE.Vector3();
  readonly #center = new THREE.Vector3();
  readonly #delta = new THREE.Vector3();

  /**
   * `primary` is the renderer's existing sun, which becomes cascade 0 while cascades are on and is
   * handed back untouched when they are off. `fade` is the world-light uniform the shader reads.
   */
  constructor(primary: THREE.DirectionalLight, fade: { value: THREE.Vector3 }) {
    this.#primary = primary;
    this.#fade = fade;
  }

  get active(): boolean {
    return this.#cascades.length > 0;
  }

  /** Every shadow-casting light this owns while active, nearest cascade first. */
  get lights(): readonly THREE.DirectionalLight[] {
    return this.#cascades.map((cascade) => cascade.light);
  }

  get stats(): ShadowCascadeSnapshot {
    return Object.freeze({
      cascades: Object.freeze(this.#cascades.map((cascade) => Object.freeze({
        mapSize: cascade.mapSize,
        extent: cascade.extent,
        texel: cascade.texel,
        rendered: cascade.rendered,
        drawCalls: cascade.drawCalls,
        cpuMs: cascade.cpuMs,
        renders: cascade.renders,
      }))),
      frames: this.#frames,
      shadowOnlyCasters: this.#shadowOnlyCount,
    });
  }

  /**
   * Called with `true` just before the cascades render and `false` just after; returns how many
   * hidden casters it showed. The renderer uses it to let retained scenery that is outside the view
   * — and therefore hidden — still cast into it.
   */
  setShadowOnlyCasters(toggle: ((on: boolean) => number) | undefined): void {
    this.#shadowOnly = toggle;
  }

  /**
   * Casters whose bounding sphere is far larger than a cascade — terrain tiles, a third of a mile
   * across — and which three's sphere test would therefore draw into every cascade every frame.
   * Before each cascade renders, the ones whose box, projected onto the light plane, misses the
   * cascade's square are hidden for that render only (the frame's own draw list is already built
   * by then, so the view never notices). `collect` pushes the current meshes; called per render.
   */
  setBoundedCasters(collect: ((out: THREE.Mesh[]) => void) | undefined): void {
    this.#boundedCasters = collect;
  }

  /** Bounded casters hidden from the last cascade render, for diagnostics. */
  get boundedCastersCulled(): number {
    return this.#boundedCulled;
  }

  /** Hides the bounded casters this cascade cannot see; `#showBounded` restores them. */
  #hideBoundedOutside(cascade: CascadeState): void {
    const collect = this.#boundedCasters;
    if (!collect) return;
    const list = this.#boundedList;
    list.length = 0;
    collect(list);
    const { right, up } = this.#basis;
    const centre = cascade.light.target.position;
    const centreR = centre.dot(right);
    const centreU = centre.dot(up);
    const extent = cascade.extent;
    const box = this.#boundedBox;
    const corner = this.#boundedCorner;
    for (const mesh of list) {
      if (!mesh.visible || !mesh.castShadow || !mesh.layers.test(cascade.camera.layers)) continue;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingBox) continue;
      box.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
      for (let index = 0; index < 8; index++) {
        corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z);
        const r = corner.dot(right);
        const u = corner.dot(up);
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
      }
      if (maxR < centreR - extent || minR > centreR + extent || maxU < centreU - extent || minU > centreU + extent) {
        mesh.visible = false;
        this.#boundedHidden.push(mesh);
      }
    }
    list.length = 0;
  }

  #showBounded(): void {
    const hidden = this.#boundedHidden;
    this.#boundedCulled = hidden.length;
    for (const mesh of hidden) mesh.visible = true;
    hidden.length = 0;
  }

  /** Forget the cached cascade: its casters, the sun or the configuration changed. */
  invalidateFar(): void {
    this.#farDirty = true;
  }

  /**
   * Apply a lighting profile. Zero cascades detaches every added light and gives the primary back
   * exactly as the single-map path had it, so quality 0 keeps its light count and programs.
   */
  configure(scene: THREE.Scene, renderer: THREE.WebGLRenderer, profile: LightingProfile): void {
    this.#install(renderer);
    this.#scene = scene;
    this.#profile = profile;
    const count = profile.shadowMapSize > 0 ? Math.max(0, Math.floor(profile.shadowCascades)) : 0;
    // Extra lights leave the scene first; they are re-added in order, after the primary, so their
    // shadow index in three's uniform arrays is their cascade index.
    for (const light of this.#extras) scene.remove(light);
    this.#cascades.length = 0;
    this.#fade.value.set(0, 0, 0);
    // Detached cascades keep no GPU memory.
    for (const [index, light] of this.#extras.entries()) {
      if (index + 1 >= count && light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
    }
    if (count === 0) {
      this.#primary.shadow.autoUpdate = true;
      this.#primary.shadow.camera.up.set(0, 1, 0);
      return;
    }
    for (let index = 0; index < count; index++) {
      let light = this.#primary;
      if (index > 0) {
        light = this.#extras[index - 1] ?? this.#createExtra(index);
        scene.add(light);
      }
      const far = index === count - 1;
      const mapSize = far ? profile.shadowFarMapSize : profile.shadowMapSize;
      if (light.shadow.mapSize.x !== mapSize || light.shadow.mapSize.y !== mapSize) {
        light.shadow.map?.dispose();
        light.shadow.map = null;
        light.shadow.mapSize.set(mapSize, mapSize);
      }
      light.castShadow = true;
      light.intensity = 0;
      light.shadow.autoUpdate = false;
      light.shadow.needsUpdate = false;
      light.shadow.intensity = profile.shadowIntensity;
      const camera = new THREE.Camera();
      if (far) {
        camera.layers.set(SHADOW_FAR_LAYER);
      } else {
        camera.layers.set(0);
        camera.layers.enable(SHADOW_PROXY_LAYER);
      }
      this.#cascades.push({
        light, camera, lights: [light], far, mapSize, extent: 0, texel: 0,
        scheduled: false, rendered: false, drawCalls: 0, cpuMs: 0, renders: 0,
      });
    }
    this.#fade.value.set(profile.shadowFadeStart, profile.shadowDistance, SHADOW_CASCADE_BLEND);
    this.#farDirty = true;
    this.#frames = 0;
  }

  #createExtra(index: number): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(0xffffff, 0);
    light.name = `sun-cascade-${index}`;
    this.#extras.push(light);
    return light;
  }

  /**
   * Place every cascade for this frame's camera and decide which ones render. The camera's world
   * matrix must already be current; `sun` points towards the sun.
   */
  update(camera: THREE.PerspectiveCamera, sun: THREE.Vector3, frame: number): void {
    const profile = this.#profile;
    if (!profile || this.#cascades.length === 0) return;
    const length = sun.length();
    if (!(length > 0)) return;
    const direction = this.#sun.copy(sun).divideScalar(length);
    const basis = directionalShadowBasis(direction);
    if (!basis) return;
    this.#basis.right.set(basis.right.x, basis.right.y, basis.right.z);
    this.#basis.up.set(basis.up.x, basis.up.y, basis.up.z);
    this.#frames++;
    camera.getWorldDirection(this.#forward);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(camera.zoom, 1e-6);
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    const last = this.#cascades.length - 1;
    for (let index = 0; index < last; index++) {
      const cascade = this.#cascades[index]!;
      const near = index === 0 ? camera.near : profile.shadowCascadeSplits[index - 1]! * SLICE_OVERLAP;
      const far = profile.shadowCascadeSplits[index] ?? profile.shadowDistance;
      const sphere = frustumSliceSphere(near, far, tanHalf, aspect);
      // Whole half-yards, so a resize by a pixel does not change the texel size every frame.
      const extent = Math.ceil(sphere.radius * 2) / 2;
      this.#center.copy(camera.position).addScaledVector(this.#forward, sphere.depth);
      this.#place(cascade, this.#center, direction, basis.up, extent);
      cascade.scheduled = true;
    }
    const farCascade = this.#cascades[last]!;
    const margin = Math.max(16, profile.shadowDistance * 0.1);
    const extent = Math.ceil(profile.shadowDistance + margin);
    this.#delta.copy(camera.position).sub(this.#farCenter);
    // Only light-plane movement moves the disc towards the map's edge.
    const offset = Math.hypot(
      this.#delta.x * basis.right.x + this.#delta.y * basis.right.y + this.#delta.z * basis.right.z,
      this.#delta.x * basis.up.x + this.#delta.y * basis.up.y + this.#delta.z * basis.up.z,
    );
    const stale = farCascadeStale({
      dirty: this.#farDirty || farCascade.extent !== extent || farCascade.light.shadow.map === null,
      framesSinceRender: frame - this.#farRenderedFrame,
      refreshFrames: Math.max(1, profile.shadowFarRefreshFrames),
      offset,
      margin,
      sunDot: this.#farSun.dot(direction),
    });
    if (stale) {
      this.#place(farCascade, camera.position, direction, basis.up, extent);
      this.#farCenter.copy(camera.position);
      this.#farSun.copy(direction);
      this.#farRenderedFrame = frame;
      this.#farDirty = false;
      farCascade.scheduled = true;
    }
  }

  #place(
    cascade: CascadeState,
    center: THREE.Vector3,
    direction: THREE.Vector3,
    up: { x: number; y: number; z: number },
    extent: number,
  ): void {
    const snapped = stabiliseDirectionalShadowCenter(center, direction, extent, cascade.mapSize);
    const { light } = cascade;
    const shadow = light.shadow;
    const camera = shadow.camera as THREE.OrthographicCamera;
    const reach = extent + (cascade.far ? SHADOW_FAR_CASTER_REACH : SHADOW_CASTER_REACH);
    light.target.position.set(snapped.x, snapped.y, snapped.z);
    light.position.copy(light.target.position).addScaledVector(direction, reach);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    camera.up.set(up.x, up.y, up.z);
    const depth = reach + extent;
    if (camera.right !== extent || camera.far !== depth) {
      camera.left = -extent;
      camera.right = extent;
      camera.top = extent;
      camera.bottom = -extent;
      camera.near = 0.5;
      camera.far = depth;
      camera.updateProjectionMatrix();
    }
    const texel = (2 * extent) / cascade.mapSize;
    cascade.extent = extent;
    cascade.texel = texel;
    // Depth bias in the map's normalised depth, normal offset in yards: both grow with the texel so
    // a coarse cascade neither acnes nor detaches a near one's contact shadows.
    shadow.bias = -(0.08 + 0.75 * texel) / (depth - camera.near);
    shadow.normalBias = 0.03 + 0.9 * texel;
    shadow.radius = Math.min(3, Math.max(1, SHADOW_BLUR_YARDS / texel));
  }

  /**
   * 06.10-shadow: whether a sphere (scene space) overlaps the light-plane square of any view-fitted
   * cascade as last placed — the only maps a unit's shadow can be drawn into (the cached cascade
   * never draws units). The renderer admits an off-screen unit for its shadow only when this holds.
   * False before the first placement. Allocation-free.
   */
  viewFittedCovers(x: number, y: number, z: number, radius: number): boolean {
    const { right, up } = this.#basis;
    const r = x * right.x + y * right.y + z * right.z;
    const u = x * up.x + y * up.y + z * up.z;
    for (const cascade of this.#cascades) {
      if (cascade.far || !(cascade.extent > 0)) continue;
      const centre = cascade.light.target.position;
      const reach = cascade.extent + radius;
      if (Math.abs(r - centre.dot(right)) <= reach && Math.abs(u - centre.dot(up)) <= reach) return true;
    }
    return false;
  }

  /** Visits the added cascades' live render targets; the primary's are its owner's to report. */
  visitMaps(visit: (owner: THREE.DirectionalLight, target: THREE.RenderTarget) => void): void {
    for (const light of this.#extras) {
      if (light.shadow.map) visit(light, light.shadow.map);
      if (light.shadow.mapPass) visit(light, light.shadow.mapPass);
    }
  }

  /** Releases the added lights' maps; the primary's are its owner's. */
  disposeMaps(): void {
    for (const light of this.#extras) light.shadow.dispose();
    this.#farDirty = true;
  }

  dispose(): void {
    if (this.#scene) for (const light of this.#extras) this.#scene.remove(light);
    this.disposeMaps();
    this.#cascades.length = 0;
  }

  #install(renderer: THREE.WebGLRenderer): void {
    if (this.#installed === renderer) return;
    this.#installed = renderer;
    const shadowMap = renderer.shadowMap;
    const original = shadowMap.render as unknown as ShadowRender;
    const owner = this;
    const others: THREE.Light[] = [];
    const wrapped: ShadowRender = function (lights, scene, camera) {
      const cascades = owner.#cascades;
      if (cascades.length === 0) {
        original.call(this, lights, scene, camera);
        return;
      }
      others.length = 0;
      let ours = 0;
      for (const light of lights) {
        if (cascades.some((cascade) => cascade.light === light)) ours++;
        else others.push(light);
      }
      if (others.length > 0) original.call(this, others, scene, camera);
      others.length = 0;
      if (ours === 0) return;
      let any = false;
      for (const cascade of cascades) if (cascade.scheduled && lights.includes(cascade.light)) any = true;
      if (!any) return;
      for (const cascade of cascades) cascade.rendered = false;
      owner.#shadowOnlyCount = owner.#shadowOnly?.(true) ?? 0;
      try {
        for (const cascade of cascades) {
          if (!cascade.scheduled || !lights.includes(cascade.light)) continue;
          cascade.scheduled = false;
          cascade.light.shadow.needsUpdate = true;
          const calls = renderer.info.render.calls;
          const started = performance.now();
          owner.#hideBoundedOutside(cascade);
          try {
            original.call(this, cascade.lights, scene, cascade.camera);
          } finally {
            owner.#showBounded();
          }
          cascade.cpuMs = performance.now() - started;
          cascade.drawCalls = renderer.info.render.calls - calls;
          cascade.rendered = true;
          cascade.renders++;
        }
      } finally {
        owner.#shadowOnly?.(false);
      }
    };
    shadowMap.render = wrapped as unknown as typeof shadowMap.render;
  }
}
