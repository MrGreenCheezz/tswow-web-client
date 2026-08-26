import * as THREE from "three";
import {
  applyBillboardBones, instantiateSkinned,
  type SkinnedInstance,
  type SkinnedTemplate,
} from "./AnimatedModel.js";
import { portraitCameraSpec } from "./PortraitCamera.js";
import type { BuiltModel } from "./ModelBuild.js";
import type { WvmModel } from "./Wvm.js";

export const PORTRAIT_SLOTS = ["player", "target", "focus", "tot", "pet"] as const;
export type PortraitSlot = (typeof PORTRAIT_SLOTS)[number];

export interface PortraitTarget {
  guid: bigint | undefined;
  canvas: HTMLCanvasElement | undefined;
}

const EMPTY_PORTRAIT_TARGET = { guid: undefined, canvas: undefined } as const;

/** The already-built model data borrowed by a portrait; no geometry or material is owned here. */
export interface PortraitSource {
  key: string;
  /** The cache key, kept separate from `key` when an atlas repaint generation changes. */
  buildKey?: string;
  model: WvmModel;
  built: BuiltModel;
  template?: SkinnedTemplate | undefined;
  /** Live world bones are borrowed read-only; their transforms are copied once into the snapshot. */
  liveBones?: readonly THREE.Bone[] | undefined;
  scale: number;
}

export type PortraitSourceProvider = (guid: bigint) => PortraitSource | undefined;

interface PortraitSurface {
  group: THREE.Group;
  target: THREE.WebGLRenderTarget;
  root: THREE.Object3D | undefined;
  skinned: SkinnedInstance | undefined;
  sourceKey: string | undefined;
  output: HTMLCanvasElement | undefined;
  pixels: Uint8Array;
  flipped: Uint8ClampedArray;
  width: number;
  height: number;
  dirty: boolean;
  /** A portrait is deliberately a single posed snapshot, not a second animated unit. */
  staticPoseCaptured: boolean;
  /** The target GUID matters even when two units share the same appearance/build key. */
  sourceGuid: bigint | undefined;
}

export interface PortraitRendererOptions {
  /** Reserved for source compatibility; portraits are now painted once per invalidation. */
  repaintIntervalMs?: number;
}

/**
 * Renders five small model views through the world's existing WebGLRenderer.
 *
 * A WebGL texture cannot be used as an `<img>` or CSS background. The only browser-safe bridge is a
 * readback into a 2D canvas. Render targets therefore live for the lifetime of a slot and are only
 * resized when that slot's canvas changes size; static portraits are read back only when invalidated.
 */
export class PortraitRenderer {
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  readonly #ambient = new THREE.HemisphereLight(0xd8e7ff, 0x30261c, 1.7);
  readonly #key = new THREE.DirectionalLight(0xffe2b2, 2.2);
  readonly #slotGroups = new Map<PortraitSlot, THREE.Group>();
  readonly #surfaces = new Map<PortraitSlot, PortraitSurface>();
  readonly #targets = new Map<PortraitSlot, PortraitTarget>();
  readonly #targetGuids = new Set<bigint>();
  readonly #source: PortraitSourceProvider;

  constructor(renderer: THREE.WebGLRenderer, source: PortraitSourceProvider,
    options: PortraitRendererOptions = {}) {
    this.#renderer = renderer;
    this.#source = source;
    // Keep accepting the old option while intentionally ignoring it. A static portrait has no
    // animation cadence to throttle: readback happens only after a model/target/size invalidation.
    void options;
    this.#scene.add(this.#ambient, this.#key);
    for (const slot of PORTRAIT_SLOTS) {
      // The scene and lights are shared, but each slot owns an isolated group. Only the group
      // being painted is visible during a readback; otherwise all five roots overlap in one pass.
      const group = new THREE.Group();
      group.name = `portrait-${slot}`;
      group.visible = false;
      this.#slotGroups.set(slot, group);
      this.#scene.add(group);
    }
    this.#key.position.set(2, 4, 3);
    this.#scene.background = null;
  }

  /** Allocation-free hot-path query used while posing world units. */
  hasTarget(guid: bigint): boolean {
    return this.#targetGuids.has(guid);
  }

  /**
   * Whether a world unit still needs one pose step before its static portrait can be painted.
   *
   * The query itself allocates no temporary collections: the world pose loop asks it for every
   * drawn unit, so it only walks the fixed five slots and reads existing surface/canvas state
   * before resolving the current source key for matching clean slots. A successful snapshot
   * clears the answer until a target, model, or backing-store size invalidates it.
   */
  needsPose(guid: bigint): boolean {
    for (const slot of PORTRAIT_SLOTS) {
      const target = this.#targets.get(slot);
      if (target?.guid !== guid || !target.canvas) continue;
      const surface = this.#surfaces.get(slot);
      if (!surface || surface.dirty || !surface.staticPoseCaptured || surface.sourceGuid !== guid) return true;
      const width = Math.max(1, target.canvas.width || 96);
      const height = Math.max(1, target.canvas.height || 96);
      if (surface.width !== width || surface.height !== height) return true;
      // Atlas generations are folded into source.key. Resolve the current source only after the
      // cheap surface checks above, so ordinary non-portrait units still pay no provider call.
      const source = this.#source(guid);
      if (!source || surface.sourceKey !== source.key) return true;
    }
    return false;
  }

  setTargets(targets: ReadonlyMap<PortraitSlot, PortraitTarget>): void {
    this.#targetGuids.clear();
    for (const slot of PORTRAIT_SLOTS) {
      const next = targets.get(slot) ?? EMPTY_PORTRAIT_TARGET;
      const previous = this.#targets.get(slot);
      this.#targets.set(slot, next);
      if (next.guid !== undefined) this.#targetGuids.add(next.guid);
      const surface = this.#surfaces.get(slot);
      if (previous?.guid !== next.guid || previous?.canvas !== next.canvas) {
        if (surface) surface.dirty = true;
        // Keep the old class/creature image as fallback while the new model is loading; a stale
        // 3D readback must not remain visible through a target transition.
        this.#clearCanvas(previous?.canvas);
        this.#clearCanvas(next.canvas);
      }
    }
  }

  targetGuids(): ReadonlySet<bigint> {
    return this.#targetGuids;
  }

  /** Build keys that must be kept alive by the unit cache eviction pass. */
  liveBuildKeys(): Set<string> {
    const live = new Set<string>();
    for (const target of this.#targets.values()) {
      if (target.guid === undefined) continue;
      const source = this.#source(target.guid);
      if (source) live.add(source.buildKey ?? source.key);
    }
    return live;
  }

  /** Render invalidated portraits. Returns the number of readbacks performed. */
  render(_now = performance.now()): number {
    let rendered = 0;
    for (const slot of PORTRAIT_SLOTS) {
      const target = this.#targets.get(slot);
      if (!target?.canvas || target.guid === undefined) {
        this.#markUnavailable(slot);
        continue;
      }
      const source = this.#source(target.guid);
      if (!source) {
        this.#markUnavailable(slot);
        continue;
      }
      const surface = this.#surface(slot, target.canvas);
      const sourceKey = source.key;
      if (surface.sourceKey !== sourceKey || surface.sourceGuid !== target.guid) {
        this.#replaceModel(surface, source);
        surface.sourceKey = sourceKey;
        surface.sourceGuid = target.guid;
        surface.dirty = true;
      }
      surface.output = target.canvas;
      if (!surface.dirty) continue;
      // Capture the current world pose once. The independent portrait rig is intentionally not
      // advanced by a mixer and must not keep following the animated world unit on later calls.
      this.#captureStaticPose(surface, source);
      if (this.#paint(slot, surface, source)) {
        surface.dirty = false;
        rendered++;
      }
    }
    return rendered;
  }

  clear(): void {
    for (const surface of this.#surfaces.values()) {
      this.#disposeModel(surface);
      surface.target.dispose();
      this.#clearCanvas(surface.output);
    }
    this.#surfaces.clear();
    this.#targets.clear();
    this.#targetGuids.clear();
  }

  dispose(): void {
    this.clear();
    this.#scene.clear();
  }

  #surface(slot: PortraitSlot, canvas: HTMLCanvasElement): PortraitSurface {
    // Use the backing store only. clientWidth/clientHeight are zero for a display:none frame and
    // must not make a portrait target depend on whether its parent is currently visible.
    const width = Math.max(1, canvas.width || 96);
    const height = Math.max(1, canvas.height || 96);
    let surface = this.#surfaces.get(slot);
    if (!surface) {
      const target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true, stencilBuffer: false,
        generateMipmaps: false,
      });
      surface = {
        group: this.#slotGroups.get(slot)!,
        target, root: undefined, skinned: undefined, sourceKey: undefined, output: canvas,
        pixels: new Uint8Array(width * height * 4),
        flipped: new Uint8ClampedArray(width * height * 4),
        width, height, dirty: true, staticPoseCaptured: false, sourceGuid: undefined,
      };
      this.#surfaces.set(slot, surface);
    } else if (surface.width !== width || surface.height !== height) {
      surface.target.setSize(width, height);
      surface.pixels = new Uint8Array(width * height * 4);
      surface.flipped = new Uint8ClampedArray(width * height * 4);
      surface.width = width;
      surface.height = height;
      surface.dirty = true;
    }
    return surface;
  }

  #replaceModel(surface: PortraitSurface, source: PortraitSource): void {
    this.#disposeModel(surface);
    let root: THREE.Object3D;
    if (source.template) {
      const instance = instantiateSkinned(source.template, source.built.materials);
      surface.skinned = instance;
      root = instance.root;
    } else {
      const mesh = new THREE.Mesh(source.built.geometry, source.built.materials);
      mesh.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      surface.skinned = undefined;
      root = mesh;
    }
    root.scale.setScalar(source.scale > 0 ? source.scale : 1);
    surface.group.add(root);
    surface.root = root;
    surface.staticPoseCaptured = false;
  }

  #disposeModel(surface: PortraitSurface): void {
    if (surface.skinned) {
      surface.skinned.mixer.stopAllAction();
      surface.skinned.mixer.uncacheRoot(surface.skinned.root);
      surface.skinned.skeleton.dispose();
    }
    surface.root?.removeFromParent();
    surface.root = undefined;
    surface.skinned = undefined;
    surface.sourceKey = undefined;
    surface.sourceGuid = undefined;
    surface.staticPoseCaptured = false;
  }

  #captureStaticPose(surface: PortraitSurface, source: PortraitSource): void {
    if (surface.staticPoseCaptured) return;
    const skinned = surface.skinned;
    if (!skinned) {
      surface.staticPoseCaptured = true;
      return;
    }
    // A source without a live rig is still a valid static portrait: instantiateSkinned's rest
    // pose is the deterministic fallback. Do not retry on every render and accidentally animate
    // when a world unit later changes state.
    if (source.liveBones) {
      const bones = skinned.skeleton.bones;
      for (let index = 0; index < bones.length; index++) {
        const pose = source.liveBones[index];
        const bone = bones[index];
        if (!pose || !bone) continue;
        bone.position.copy(pose.position);
        bone.quaternion.copy(pose.quaternion);
        bone.scale.copy(pose.scale);
      }
    }
    surface.staticPoseCaptured = true;
  }

  #paint(slot: PortraitSlot, surface: PortraitSurface, source: PortraitSource): boolean {
    if (!surface.root || !surface.output) return false;
    const spec = portraitCameraSpec({
      camera: source.model.portraitCamera,
      bounds: source.model.bounds,
      visibleBounds: source.built.geometry.boundingBox ? {
        min: [
          source.built.geometry.boundingBox.min.x,
          source.built.geometry.boundingBox.min.y,
          source.built.geometry.boundingBox.min.z,
        ],
        max: [
          source.built.geometry.boundingBox.max.x,
          source.built.geometry.boundingBox.max.y,
          source.built.geometry.boundingBox.max.z,
        ],
      } : undefined,
      attachments: source.model.attachments,
      scale: source.scale,
    });
    this.#camera.fov = spec.fov;
    this.#camera.near = spec.near;
    this.#camera.far = spec.far;
    this.#camera.aspect = surface.width / surface.height;
    this.#camera.position.set(...spec.position);
    this.#camera.lookAt(...spec.target);
    this.#camera.updateProjectionMatrix();
    this.#camera.updateMatrixWorld(true);
    if (surface.skinned) {
      surface.root.updateMatrixWorld(true);
      // The world unit may already have billboarded its own bones against the world camera. Apply
      // the billboard rule again on this independent rig so cards/glows face the portrait camera.
      if (source.template) applyBillboardBones(surface.skinned, source.template, this.#camera);
      surface.root.updateMatrixWorld(true);
      // Skeleton.update reads each bone's world matrix, so update the independent hierarchy first.
      surface.skinned.skeleton.update();
    } else {
      surface.root.updateMatrixWorld(true);
    }

    const previousTarget = this.#renderer.getRenderTarget();
    const previousViewport = this.#renderer.getViewport(new THREE.Vector4());
    const previousScissor = this.#renderer.getScissor(new THREE.Vector4());
    const previousScissorTest = this.#renderer.getScissorTest();
    const previousClear = this.#renderer.getClearColor(new THREE.Color());
    const previousAlpha = this.#renderer.getClearAlpha();
    const previousAutoClear = this.#renderer.autoClear;
    const previousVisibility = [...this.#slotGroups.values()]
      .map((group) => [group, group.visible] as const);
    try {
      for (const group of this.#slotGroups.values()) group.visible = group === surface.group;
      this.#renderer.setRenderTarget(surface.target);
      this.#renderer.setViewport(0, 0, surface.width, surface.height);
      this.#renderer.setScissor(0, 0, surface.width, surface.height);
      this.#renderer.setScissorTest(false);
      this.#renderer.setClearColor(0x000000, 0);
      this.#renderer.autoClear = true;
      this.#renderer.clear(true, true, true);
      this.#renderer.render(this.#scene, this.#camera);
      this.#renderer.readRenderTargetPixels(surface.target, 0, 0, surface.width, surface.height, surface.pixels);
      const rowBytes = surface.width * 4;
      for (let y = 0; y < surface.height; y++) {
        const from = (surface.height - y - 1) * rowBytes;
        surface.flipped.set(surface.pixels.subarray(from, from + rowBytes), y * rowBytes);
      }
      const context = surface.output.getContext("2d");
      if (!context) return false;
      const image = context.createImageData(surface.width, surface.height);
      image.data.set(surface.flipped);
      context.putImageData(image, 0, 0);
      surface.output.dataset["portraitReady"] = "true";
      surface.output.dataset["portraitSlot"] = slot;
      return true;
    } catch {
      this.#markUnavailable(slot);
      return false;
    } finally {
      this.#renderer.autoClear = previousAutoClear;
      this.#renderer.setClearColor(previousClear, previousAlpha);
      // Select the original framebuffer first: three may apply a target's own viewport/scissor when
      // it becomes current, so restoring those before the target would lose the caller's state.
      this.#renderer.setRenderTarget(previousTarget);
      this.#renderer.setScissorTest(previousScissorTest);
      this.#renderer.setScissor(previousScissor);
      this.#renderer.setViewport(previousViewport);
      for (const [group, visible] of previousVisibility) group.visible = visible;
    }
  }

  #markUnavailable(slot: PortraitSlot): void {
    const target = this.#targets.get(slot);
    const surface = this.#surfaces.get(slot);
    if (target?.canvas) {
      target.canvas.dataset["portraitReady"] = "false";
      this.#clearCanvas(target.canvas);
    }
    if (surface) {
      surface.output = target?.canvas;
      surface.dirty = true;
      // A temporary model/cache miss must not leave an old portrait instance retained off-screen;
      // the next successful source will build a fresh independent instance.
      this.#disposeModel(surface);
    }
  }

  #clearCanvas(canvas: HTMLCanvasElement | undefined): void {
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.dataset["portraitReady"] = "false";
  }
}
