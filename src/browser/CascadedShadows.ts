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
import {
  SHADOW_CASTER_KINDS, ShadowCasterRoot, referenceShadowWalk, shadowCasterKind, shadowDrawCount,
  type ShadowCasterList,
} from "./ShadowCasterList.js";

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
/**
 * P2-02b: the cached cascade's refresh interval as a safety net on the clock. Its casters are static,
 * and the renderer re-renders it when what it draws changes (`invalidateFar` from the scenery folds
 * and dirty marks, the margin, the sun), so the frame interval (`shadowFarRefreshFrames`, 208 ms at
 * 144 Hz) mostly re-drew an unchanged map: 0.86 ms of CPU 2.8 times a second in the city bench. It
 * now also waits this long. A change none of those see (a warm-up hold of an instance copy) shows
 * up to this late; a posed rig among the far casters keeps the frame interval (`setFarAnimated`).
 */
export const SHADOW_FAR_IDLE_REFRESH_MS = 2000;
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
  /** P2-02b: CPU of every render since the cascades were configured, summed, and the largest one. */
  readonly cpuMsTotal: number;
  readonly cpuMsMax: number;
  /** P2-02b: draw calls of every render since the cascades were configured. */
  readonly drawCallsTotal: number;
}

/**
 * P2-02b: why the cached cascade was rendered again, one reason per render (the first that held,
 * in this order), counted since the cascades were configured.
 */
export interface FarCascadeReasons {
  /** Asked for (`invalidateFar`, a new configuration) or its map is gone. */
  readonly dirty: number;
  /** Its disc changed size (`shadowDistance`). */
  readonly extent: number;
  /** The camera left half its margin in the light plane. */
  readonly offset: number;
  /** The sun turned. */
  readonly sun: number;
  /** The refresh interval passed. */
  readonly interval: number;
}

export const FAR_CASCADE_REASONS = ["dirty", "extent", "offset", "sun", "interval"] as const;
export type FarCascadeReason = typeof FAR_CASCADE_REASONS[number];

/** The reason `farCascadeStale` holds for, in the order `FarCascadeReasons` counts them; undefined when fresh. */
export function farCascadeReason(input: {
  dirty: boolean;
  extentChanged: boolean;
  framesSinceRender: number;
  refreshFrames: number;
  offset: number;
  margin: number;
  sunDot: number;
  msSinceRender?: number | undefined;
  idleRefreshMs?: number | undefined;
}): FarCascadeReason | undefined {
  if (input.dirty) return "dirty";
  if (input.extentChanged) return "extent";
  if (!(input.offset <= input.margin * 0.5)) return "offset";
  if (!(input.sunDot >= 0.999995)) return "sun";
  if (farIntervalDue(input)) return "interval";
  return undefined;
}

export interface ShadowCascadeSnapshot {
  readonly cascades: readonly ShadowCascadeStats[];
  /** Frames the cascades were updated on since they were configured. */
  readonly frames: number;
  /**
   * Retained-but-hidden scenery cast for the last shadow pass only. With the caster list (P2-01a,
   * the renderer) it counts owners with an active gate-2 caster; renamed from `shadowOnlyCasters`,
   * which counted every node the old toggle showed, so recordings from before and after are not
   * compared as one series. Without a list it is still the toggle's return value.
   */
  readonly shadowOnlyOwners: number;
  /** P2-02b: why the cached cascade was re-rendered, since the cascades were configured. */
  readonly farReasons: FarCascadeReasons;
}

/** One cascade of the P2-01a census: three's walk of the scene against the list's root. */
export interface ShadowCasterCensusCascade {
  /** Meshes and draws (groups) three's walk of the scene would make. */
  readonly referenceMeshes: number;
  readonly referenceDraws: number;
  /** The same through the caster list's root. */
  readonly listMeshes: number;
  readonly listDraws: number;
  /** Draws in the reference only / in the list only. */
  readonly missing: number;
  readonly extra: number;
  /** Draws through the root per kind. */
  readonly drawsByKind: Readonly<Record<string, number>>;
  /** Draws through the root per the caller's classes (the renderer: gate and instancing). */
  readonly drawsByClass: Readonly<Record<string, number>>;
  /** A few missing / extra meshes, branch first, for diagnosis. */
  readonly samples: readonly string[];
}

export interface ShadowCasterCensus {
  readonly cascades: readonly ShadowCasterCensusCascade[];
  readonly entries: number;
  readonly emitted: number;
  readonly nested: number;
  readonly pruned: number;
  readonly shadowOnlyOwners: number;
  /** Entries with a visible chain per gate answer 0 / 1 / 2. */
  readonly byGate: readonly number[];
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
  cpuMsTotal: number;
  cpuMsMax: number;
  drawCallsTotal: number;
}

type ShadowRender = (this: THREE.WebGLShadowMap, lights: THREE.Light[], scene: THREE.Object3D, camera: THREE.Camera) => void;

/*
 * P2-01d: the cascades sample only the map's depth texture; three's depth materials also write a
 * packed depth colour into an RGBA8 attachment nobody reads. Three hands every shadow draw's depth
 * material (its private shared one, a clone per alpha-keyed source, or a custom one) to
 * `object.onBeforeShadow` just before `renderBufferDirect`, and `Object3D.prototype.onBeforeShadow`
 * is an empty default. Replacing that default once, and acting only while the cascades render,
 * turns `colorWrite` off on exactly those materials — it is not part of any program key, so no
 * program changes. A first try swapped `renderer.renderBufferDirect` around the cascades every
 * frame instead: city +0.54 ms CPU over three strict pairs (`series-p201d.json`), kept in
 * `.runtime/perf-step22/p201d1-nogo/`.
 *
 * Three shares its depth material (and the clones) with every other shadow render, so the flag is
 * handed back in `onAfterShadow`, right after the draw: any light that is not a cascade still draws
 * with colour, as before P2-01d. The colour mask three tracks does not change between two cascade
 * draws (both off), so the flip costs two property writes a draw and no GL call.
 */
let depthOnlyDepth = 0;
let depthOnlyInstalled = false;
/** The depth material this hook turned colour off on, for `onAfterShadow` to give it back. */
let depthOnlyFlipped: THREE.Material | null = null;

function installDepthOnlyHook(): void {
  if (depthOnlyInstalled) return;
  depthOnlyInstalled = true;
  const previous = THREE.Object3D.prototype.onBeforeShadow;
  THREE.Object3D.prototype.onBeforeShadow = function (
    renderer, object, camera, shadowCamera, geometry, depthMaterial, group,
  ): void {
    if (depthOnlyDepth > 0 && depthMaterial.colorWrite) {
      depthMaterial.colorWrite = false;
      depthOnlyFlipped = depthMaterial;
    }
    previous.call(this, renderer, object, camera, shadowCamera, geometry, depthMaterial, group);
  };
  const after = THREE.Object3D.prototype.onAfterShadow;
  THREE.Object3D.prototype.onAfterShadow = function (
    renderer, object, camera, shadowCamera, geometry, depthMaterial, group,
  ): void {
    if (depthOnlyFlipped === depthMaterial) {
      depthMaterial.colorWrite = true;
      depthOnlyFlipped = null;
    }
    after.call(this, renderer, object, camera, shadowCamera, geometry, depthMaterial, group);
  };
}

/** Whether the depth-only hook is acting now (tests). */
export function depthOnlyActive(): boolean {
  return depthOnlyDepth > 0;
}

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
  /** P2-02b: with both, the interval also waits `idleRefreshMs` on the clock. */
  msSinceRender?: number | undefined;
  idleRefreshMs?: number | undefined;
}): boolean {
  return input.dirty
    || farIntervalDue(input)
    || !(input.offset <= input.margin * 0.5)
    || !(input.sunDot >= 0.999995);
}

function farIntervalDue(input: { framesSinceRender: number; refreshFrames: number; msSinceRender?: number | undefined; idleRefreshMs?: number | undefined }): boolean {
  if (!(input.framesSinceRender >= input.refreshFrames)) return false;
  return input.msSinceRender === undefined || input.idleRefreshMs === undefined
    || !(input.msSinceRender < input.idleRefreshMs);
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
  #casterList: ShadowCasterList | undefined;
  readonly #casterRoot = new ShadowCasterRoot();
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
  #farRenderedAtMs = -Infinity;
  /** P2-02b: a far caster is animated, so the interval keeps to frames alone. */
  #farAnimated = false;
  /** P2-02b: the reason the scheduled far render was asked for, counted when it renders (-1: none). */
  #farPendingReason = -1;
  #farRenderListener: (() => void) | undefined;
  /** P2-02b: re-render reasons in `FAR_CASCADE_REASONS` order. */
  readonly #farReasons = [0, 0, 0, 0, 0];
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
        cpuMsTotal: cascade.cpuMsTotal,
        cpuMsMax: cascade.cpuMsMax,
        drawCallsTotal: cascade.drawCallsTotal,
      }))),
      frames: this.#frames,
      shadowOnlyOwners: this.#shadowOnlyCount,
      farReasons: Object.freeze({
        dirty: this.#farReasons[0]!, extent: this.#farReasons[1]!, offset: this.#farReasons[2]!,
        sun: this.#farReasons[3]!, interval: this.#farReasons[4]!,
      }),
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
   * P2-01a: with a caster list, each cascade is handed the list's synthetic root instead of the
   * scene (`ShadowCasterList.ts`); the list's gates replace the shadow-only toggle, which is then
   * not called. Without one, the scene is walked as before.
   */
  setCasterList(list: ShadowCasterList | undefined): void {
    this.#casterList = list;
    this.#casterRoot.children.length = 0;
  }

  /**
   * P2-01a census for the bench: for every cascade as last placed, three's walk of `scene` (with
   * `shown` standing in for the shadow-only toggle) against the walk of the list's root. Runs the
   * list's `beginFrame`, so call it between renders. Undefined without cascades or a list.
   */
  casterCensus(
    scene: THREE.Object3D,
    shown?: (node: THREE.Object3D) => boolean,
    classify?: (mesh: THREE.Mesh) => string | undefined,
  ): ShadowCasterCensus | undefined {
    const list = this.#casterList;
    if (!list || this.#cascades.length === 0) return undefined;
    list.beginFrame(scene);
    const branch = (mesh: THREE.Object3D): string => {
      let node = mesh;
      while (node.parent && node.parent !== scene) node = node.parent;
      return `${node.name || node.type}/${mesh.name || mesh.type}#${mesh.id}`;
    };
    const root = this.#casterRoot;
    const cascades = this.#cascades.map((cascade, view) => {
      cascade.light.shadow.updateMatrices(cascade.light);
      const frustum = cascade.light.shadow.getFrustum();
      const reference: THREE.Mesh[] = [];
      referenceShadowWalk(scene, cascade.camera, frustum, reference, shown);
      const listed: THREE.Mesh[] = [];
      list.fill(root, view);
      list.showShadowOnly();
      try {
        referenceShadowWalk(root, cascade.camera, frustum, listed);
      } finally {
        list.hideShadowOnly();
      }
      const inReference = new Map<THREE.Mesh, number>();
      for (const mesh of reference) inReference.set(mesh, (inReference.get(mesh) ?? 0) + 1);
      const inList = new Map<THREE.Mesh, number>();
      for (const mesh of listed) inList.set(mesh, (inList.get(mesh) ?? 0) + 1);
      let missing = 0, extra = 0;
      const samples: string[] = [];
      for (const [mesh, count] of inReference) {
        const lost = count - (inList.get(mesh) ?? 0);
        if (lost <= 0) continue;
        missing += lost * shadowDrawCount(mesh);
        if (samples.length < 6) samples.push(`missing ${branch(mesh)}`);
      }
      for (const [mesh, count] of inList) {
        const added = count - (inReference.get(mesh) ?? 0);
        if (added <= 0) continue;
        extra += added * shadowDrawCount(mesh);
        if (samples.length < 12) samples.push(`extra ${branch(mesh)}`);
      }
      const drawsByKind: Record<string, number> = {};
      for (const kind of SHADOW_CASTER_KINDS) drawsByKind[kind] = 0;
      const drawsByClass: Record<string, number> = {};
      let referenceDraws = 0, listDraws = 0;
      for (const mesh of reference) referenceDraws += shadowDrawCount(mesh);
      for (const mesh of listed) {
        const draws = shadowDrawCount(mesh);
        listDraws += draws;
        const kind = SHADOW_CASTER_KINDS[shadowCasterKind(mesh)]!;
        drawsByKind[kind] = (drawsByKind[kind] ?? 0) + draws;
        const label = classify?.(mesh);
        if (label !== undefined) drawsByClass[label] = (drawsByClass[label] ?? 0) + draws;
      }
      return Object.freeze({
        referenceMeshes: reference.length, referenceDraws, listMeshes: listed.length, listDraws,
        missing, extra, drawsByKind: Object.freeze(drawsByKind), drawsByClass: Object.freeze(drawsByClass),
        samples: Object.freeze(samples),
      });
    });
    root.children.length = 0;
    const stats = list.stats;
    return Object.freeze({
      cascades: Object.freeze(cascades), entries: stats.entries, emitted: stats.emitted, nested: stats.nested,
      pruned: stats.pruned, shadowOnlyOwners: stats.shadowOnlyOwners, byGate: Object.freeze([...stats.byGate]),
    });
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

  /**
   * P2-02b: whether a far caster moves on its own (a rigged doodad's sails): its shadow in the cached
   * map then refreshes on the frame interval as before, not on `SHADOW_FAR_IDLE_REFRESH_MS`.
   */
  setFarAnimated(animated: boolean): void {
    this.#farAnimated = animated;
  }

  /** P2-02b: called right after the cached cascade renders, so the caller can note what it drew. */
  setFarRenderListener(listener: (() => void) | undefined): void {
    this.#farRenderListener = listener;
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
        cpuMsTotal: 0, cpuMsMax: 0, drawCallsTotal: 0,
      });
    }
    this.#fade.value.set(profile.shadowFadeStart, profile.shadowDistance, SHADOW_CASCADE_BLEND);
    this.#farDirty = true;
    this.#frames = 0;
    this.#farReasons.fill(0);
  }

  #farRendered(): void {
    if (this.#farPendingReason >= 0) this.#farReasons[this.#farPendingReason]!++;
    this.#farPendingReason = -1;
    this.#farRenderListener?.();
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
  update(camera: THREE.PerspectiveCamera, sun: THREE.Vector3, frame: number, nowMs = performance.now()): void {
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
      msSinceRender: nowMs - this.#farRenderedAtMs,
      idleRefreshMs: this.#farAnimated ? undefined : SHADOW_FAR_IDLE_REFRESH_MS,
    });
    if (stale) {
      const reason = farCascadeReason({
        dirty: this.#farDirty || farCascade.light.shadow.map === null,
        extentChanged: farCascade.extent !== extent,
        framesSinceRender: frame - this.#farRenderedFrame,
        refreshFrames: Math.max(1, profile.shadowFarRefreshFrames),
        offset,
        margin,
        sunDot: this.#farSun.dot(direction),
        msSinceRender: nowMs - this.#farRenderedAtMs,
        idleRefreshMs: this.#farAnimated ? undefined : SHADOW_FAR_IDLE_REFRESH_MS,
      });
      // Counted when the render happens: a scheduled cascade three never renders is not a render.
      if (reason !== undefined) this.#farPendingReason = FAR_CASCADE_REASONS.indexOf(reason);
      this.#place(farCascade, camera.position, direction, basis.up, extent);
      this.#farCenter.copy(camera.position);
      this.#farSun.copy(direction);
      this.#farRenderedFrame = frame;
      this.#farRenderedAtMs = nowMs;
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
    installDepthOnlyHook();
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
      // P2-01a: the list picks its casters once for every cascade of this frame, before the first
      // `#hideBoundedOutside` touches a terrain tile's `visible`; its gates stand for the toggle.
      const list = owner.#casterList;
      const root = owner.#casterRoot;
      if (list) {
        list.beginFrame(scene);
        owner.#shadowOnlyCount = list.stats.shadowOnlyOwners;
      } else {
        owner.#shadowOnlyCount = owner.#shadowOnly?.(true) ?? 0;
      }
      depthOnlyDepth++;
      // Each cascade's `renderer.clear()` then clears depth only: the colour mask stays off until
      // the first draw that wants colour, which the restore below makes explicit.
      renderer.state?.buffers.color.setMask(false);
      try {
        // A gate-2 caster that is its own (hidden) owner: three would stop at its `visible`.
        list?.showShadowOnly();
        for (let view = 0; view < cascades.length; view++) {
          const cascade = cascades[view]!;
          if (!cascade.scheduled || !lights.includes(cascade.light)) continue;
          cascade.scheduled = false;
          cascade.light.shadow.needsUpdate = true;
          const calls = renderer.info.render.calls;
          const started = performance.now();
          owner.#hideBoundedOutside(cascade);
          try {
            if (list) list.fill(root, view);
            original.call(this, cascade.lights, list ? root : scene, cascade.camera);
          } finally {
            owner.#showBounded();
          }
          cascade.cpuMs = performance.now() - started;
          cascade.drawCalls = renderer.info.render.calls - calls;
          cascade.rendered = true;
          cascade.renders++;
          cascade.cpuMsTotal += cascade.cpuMs;
          if (cascade.cpuMs > cascade.cpuMsMax) cascade.cpuMsMax = cascade.cpuMs;
          cascade.drawCallsTotal += cascade.drawCalls;
          if (cascade.far) owner.#farRendered();
        }
      } finally {
        depthOnlyDepth--;
        // A draw that threw between the two hooks: give its material colour back here.
        if (depthOnlyFlipped) {
          depthOnlyFlipped.colorWrite = true;
          depthOnlyFlipped = null;
        }
        // Before P2-01d the last shadow draw always left the mask on; a clear between this pass and
        // the first main-pass draw (transmission, a manual clear) relies on that.
        renderer.state?.buffers.color.setMask(true);
        if (list) {
          list.hideShadowOnly();
          root.children.length = 0;
        } else {
          owner.#shadowOnly?.(false);
        }
      }
    };
    shadowMap.render = wrapped as unknown as typeof shadowMap.render;
  }
}
