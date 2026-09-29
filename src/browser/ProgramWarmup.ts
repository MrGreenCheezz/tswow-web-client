/**
 * Compiles the shader programs of freshly built content before the frame that first draws them.
 *
 * A material's program is created and linked the first time it is submitted, and on the machines
 * this client is judged on that link costs tens of milliseconds of driver time inside
 * `render.submit` — the hitch ring shows the shape of it exactly: `[сабмит: шейдеры +4]` with no
 * texture or geometry uploads at all. This class hands the same work to the driver earlier. The
 * freshly built objects are mirrored by cheap stand-ins in a private scene, `renderer.compile`
 * initialises their programs with the world pass's own lights, fog and environment, and the
 * uniform locations — the other half of a first draw — are fetched once the driver reports the
 * program ready instead of on the first submitted frame.
 *
 * The stand-ins are never drawn and are dropped as soon as they have served. Small, inert material
 * copies retain the compiled programs under the same cache keys: disposing a transient spawn-fade
 * material no longer destroys the last program owner and forces the next spawn to compile again.
 * Their asset references are detached after compilation and their program ownership is bounded,
 * scenery and unit looks each on a budget of their own (`ProgramWarmupRetention`).
 * Missing a warm-up costs
 * nothing but the old first-draw behaviour, so the queue is deliberately allowed to overflow and
 * every failure is counted rather than thrown.
 */

import * as THREE from "three";

/** The two `WebGLProgram` calls this module makes, structurally. */
interface WarmProgram {
  /** Three clears the handle in WebGLProgram.destroy, even when a WebGL query would not throw. */
  readonly program: WebGLProgram | undefined;
  isReady(): boolean | null;
  getUniforms(): unknown;
}

/** three's per-material record, as far as this module reads it. */
interface MaterialRecord {
  currentProgram?: WarmProgram;
  programs?: Map<string, WarmProgram>;
  uniforms?: unknown;
  uniformsList?: unknown;
  environment?: unknown;
  envMap?: unknown;
  fog?: unknown;
}

interface WarmedVariant {
  readonly programs: readonly WarmProgram[];
  readonly keeperKey: string | undefined;
}

interface ProgramKeeper {
  readonly material: THREE.Material;
  readonly programs: readonly WarmProgram[];
  /** Which budget the keeper is charged to; a scenery keeper a unit asks for becomes a unit one. */
  retention: ProgramWarmupRetention;
}

interface PendingWarmup {
  proxy: THREE.Object3D;
  readonly material: THREE.Material;
  readonly kind: ProgramWarmupKind;
  readonly variant: string;
  readonly owners: Map<object, { geometry: THREE.BufferGeometry; mesh?: THREE.Object3D }>;
  readonly geometryListeners: Map<THREE.BufferGeometry, () => void>;
  readonly materialDispose: () => void;
  /** Upgraded, never downgraded, when another registration of the same variant asks for units. */
  retention: ProgramWarmupRetention;
}

/** The object classes whose programs differ by their defines. */
export type ProgramWarmupKind = "mesh" | "skinned" | "instanced" | "instanced-colour";

/**
 * Which retained-program budget a registration is charged to.
 *
 * Scenery streams: a city turn registers dozens of doodad and room variants, and with one shared
 * budget that churn evicted the keepers of unit looks seen a second earlier. A unit's spawn-fade
 * copies are the programs that need a keeper most — nothing else draws them between two arrivals of
 * the same look — so they are retained apart, where only other unit looks compete for the room.
 */
export type ProgramWarmupRetention = "scene" | "unit";

/**
 * Programs one flush may hand to the driver.
 *
 * Shader source assembly is JavaScript and runs on this thread, so a burst — a tile of scenery, a
 * camp of units — is given one small batch per frame and the rest waits. Whatever the cap leaves
 * behind simply keeps the old first-draw cost, which is the failure mode this class is allowed to
 * degrade into. Measured bursts are four to six programs (`[сабмит: шейдеры +4]`), so one batch
 * covers a typical burst while a long queue drains over a handful of frames.
 */
export const PROGRAM_WARMUP_BATCH = 4;
/**
 * How long one frame's warm pass keeps handing batches to `renderer.compile`, after the first.
 *
 * A fixed four a frame was measured falling behind in the owner's client: entering a crowded part
 * of Stormwind the queue grew from 61 to 727 variants in six seconds (scenery, equipment, fade
 * stand-ins of every new look), so a unit's registrations waited hundreds of frames behind it, its
 * hold ran out, and its programs linked inside the frame anyway — eight such frames of 84-327 ms
 * in one recording. Most queued variants resolve to a program three already has, which costs a
 * material clone and a cache-key lookup, a tenth of a millisecond; so the pass keeps going while it
 * is cheap and stops once this much of the frame is spent. A variant that needs a new program costs
 * its shader assembly whatever the budget, and the budget only decides whether the next batch starts.
 */
export const PROGRAM_WARMUP_BUDGET_MS = 3;
/** Count both sides separately; a two-sided owner consumes two entries of this budget. */
export const PROGRAM_WARMUP_RETAINED_PROGRAMS = 64;
/**
 * Programs retained for unit looks (`"unit"` registrations), on top of the scenery budget above.
 *
 * Sized from the city-arrival trace (`bench/results/2026-09-27T07-18-14-217Z`): the Stormwind
 * square with seventeen displays draws its units with ten programs — eight skinned (opaque one- and
 * two-sided, alpha-tested, the translucent fade copies with both passes, one unlit fog batch; five
 * prepared, three first linked mid-run, and each of those three linked a second time after its last
 * owner was dropped) plus the capsule's opaque/translucent pair. Mounts and weapons add the same
 * shapes unskinned. 64 is six times that and still a bounded number of idle driver programs.
 * Overflow evicts the least recently registered unit keeper, and only a program no live material
 * draws is destroyed: the next arrival of that look waits hidden for the warm pass instead of
 * linking inside the frame.
 */
export const PROGRAM_WARMUP_UNIT_RETAINED_PROGRAMS = 64;

function retainedBudget(retention: ProgramWarmupRetention): number {
  return retention === "unit" ? PROGRAM_WARMUP_UNIT_RETAINED_PROGRAMS : PROGRAM_WARMUP_RETAINED_PROGRAMS;
}
/**
 * Shadow-pass depth programs kept alive by the warm pass. A depth program depends only on the
 * object class and on the few caster-material switches three's shadow map copies onto its depth
 * material (`WebGLShadowMap.getDepthMaterial`), so a world has a handful of them, not one per model.
 */
export const PROGRAM_WARMUP_DEPTH_VARIANTS = 32;

/** Three's PCF shadow side for a caster material side (`WebGLShadowMap`'s `shadowSide`). */
const SHADOW_SIDE: Readonly<Record<number, THREE.Side>> = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

/**
 * The depth material three's PCF shadow map would draw `material` with, as far as its program is
 * concerned, or undefined when the material cannot cast (the renderer's own shadow policy:
 * lit, opaque, normally blended and depth-writing).
 */
export function shadowDepthStandIn(material: THREE.Material): THREE.MeshDepthMaterial | undefined {
  const lit = material instanceof THREE.MeshLambertMaterial || material instanceof THREE.MeshPhongMaterial
    || material instanceof THREE.MeshStandardMaterial;
  if (!lit || !material.visible || material.transparent || material.blending !== THREE.NormalBlending
    || !material.depthWrite) return undefined;
  const source = material as THREE.Material & { map?: THREE.Texture | null; alphaMap?: THREE.Texture | null };
  const depth = new THREE.MeshDepthMaterial();
  depth.side = material.shadowSide ?? SHADOW_SIDE[material.side] ?? THREE.BackSide;
  depth.alphaTest = material.alphaToCoverage ? 0.5 : material.alphaTest;
  depth.map = source.map ?? null;
  depth.alphaMap = source.alphaMap ?? null;
  return depth;
}

/** The program-relevant switches of a depth stand-in; equal strings compile the same program. */
function depthVariant(depth: THREE.MeshDepthMaterial, geometry: THREE.BufferGeometry, kind: ProgramWarmupKind): string {
  return `${kind}|${depth.side}|${depth.alphaTest > 0}|${depth.map?.channel ?? -1}|${depth.alphaMap?.channel ?? -1}`
    + `|${geometryVariant(geometry, depth)}`;
}

/** The class of program an object would compile, or undefined for anything not submitted. */
export function programWarmupKind(object: THREE.Object3D): ProgramWarmupKind | undefined {
  if ((object as THREE.InstancedMesh).isInstancedMesh) {
    return (object as THREE.InstancedMesh).instanceColor ? "instanced-colour" : "instanced";
  }
  if ((object as THREE.SkinnedMesh).isSkinnedMesh) return "skinned";
  if ((object as THREE.Mesh).isMesh) return "mesh";
  return undefined;
}

/**
 * A stand-in carrying the same parameters three reads off an object: the shared geometry (morph
 * targets, uv sets, vertex colours all come from it), the material itself, and the class switches
 * that change the program — skinning, instancing and the instanced colour attribute.
 */
export function programWarmupProxy(
  object: THREE.Object3D | undefined,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  kind: ProgramWarmupKind,
): THREE.Object3D {
  if (kind === "instanced" || kind === "instanced-colour") {
    const proxy = new THREE.InstancedMesh(geometry, material, 1);
    const colour = object === undefined ? null : (object as THREE.InstancedMesh).instanceColor;
    if (kind === "instanced-colour" && colour) proxy.instanceColor = colour;
    return proxy;
  }
  if (kind === "skinned") return new THREE.SkinnedMesh(geometry, material);
  return new THREE.Mesh(geometry, material);
}

/**
 * `scene` as `renderer.compile` reads it for a program key, without the walk.
 *
 * three r185 `WebGLRenderer.compile(scene, camera, targetScene)` finds its lights with
 * `targetScene.traverseVisible` and reads only `fog`, `environment` and `environmentRotation` off
 * it for the program (`WebGLPrograms.getParameters`, `WebGLRenderer.getProgram`). Handed the world
 * scene, every warm batch walked the whole world for its one to three directional lights: a batch
 * of four materials whose programs exist took 1.1-2.1 ms in a 26,662-node graph (64 rigs of 228
 * bones and 12,000 scenery nodes; Node 22, three over a no-op WebGL2) and takes 0.22 ms through
 * this view. It has the scene as its prototype, so fog and environment are the live ones, and
 * visits only `lights` that are shown down from the scene — what `projectObject` gathers for the
 * real draw, so the key is the one the draw derives (tests/program-warmup-light-view.test.mjs).
 */
export function programWarmupLightView(
  scene: THREE.Scene,
  lights: () => readonly THREE.Object3D[],
): THREE.Scene {
  const view = Object.create(scene) as THREE.Scene;
  view.traverseVisible = (callback: (object: THREE.Object3D) => unknown): void => {
    for (const light of lights()) if (shownFrom(light, scene)) callback(light);
  };
  return view;
}

/** Whether `object` hangs below `root` with itself and every ancestor visible, as a draw sees it. */
function shownFrom(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) return true;
  }
  return false;
}

function holdsLight(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => { if ((child as THREE.Light).isLight) found = true; });
  return found;
}

export class ProgramWarmup {
  /** The renderer whose program cache is being filled. */
  readonly #renderer: THREE.WebGLRenderer;
  /** Where lights, fog and the environment are read from: the world scene the content joins. */
  readonly #target: THREE.Scene;
  /** `#target` as the compile reads it (`programWarmupLightView`); the depth pass's has no fog. */
  readonly #lightView: THREE.Scene;
  readonly #depthLightView: THREE.Scene;
  /** The lights `#target` holds, found by one walk; undefined until the next compile walks again. */
  #lights: THREE.Object3D[] | undefined;
  /** Stand-ins wait here, never rendered, emptied by every flush. */
  readonly #scene = new THREE.Scene();
  readonly #pending: PendingWarmup[] = [];
  readonly #pendingByVariant = new WeakMap<THREE.Material, Map<string, PendingWarmup>>();
  readonly #pendingByOwner = new WeakMap<object, Set<PendingWarmup>>();
  /** Programs the driver is still linking; their uniform locations are fetched when ready. */
  readonly #settling: WarmProgram[] = [];
  /** A linked program can be shared by multiple material and geometry variants. */
  #seenPrograms = new WeakSet<WarmProgram>();
  /** Programs whose uniform locations this pass fetched: a first draw of them queries nothing. */
  #settled = new WeakSet<WarmProgram>();
  /** Variants this warm pass completed, keyed by a bounded hint rather than Three's private key. */
  #warmed = new WeakMap<THREE.Material, Map<string, WarmedVariant>>();
  /** Ordinary compiled material owners keep transient spawn/effect programs alive between uses. */
  readonly #keepers = new Map<string, ProgramKeeper>();
  /**
   * Shadow depth variants seen, waiting and compiled. Three links a caster's depth program the first
   * time the shadow pass draws it, inside the frame — measured on the movement route as one 49 ms
   * frame when alpha-tested scenery first cast. The ordinary warm pass never reaches those programs.
   */
  readonly #depthVariants = new Set<string>();
  readonly #depthPending: Array<{ readonly proxy: THREE.Object3D; readonly material: THREE.MeshDepthMaterial }> = [];
  readonly #depthKeepers: THREE.MeshDepthMaterial[] = [];
  readonly #depthScene = new THREE.Scene();
  #depthTarget: THREE.WebGLRenderTarget | undefined;
  /** Retained program references per budget; `#keepers` is one LRU order over both. */
  readonly #retained: Record<ProgramWarmupRetention, number> = { scene: 0, unit: 0 };
  #programs = 0;
  #uniformLocations = 0;
  #batches = 0;
  #failures = 0;

  constructor(renderer: THREE.WebGLRenderer, target: THREE.Scene) {
    this.#renderer = renderer;
    this.#target = target;
    this.#lightView = programWarmupLightView(target, () => this.#targetLights());
    // The shadow pass draws with the world's lights but none of its fog or environment.
    this.#depthLightView = Object.create(this.#lightView) as THREE.Scene;
    this.#depthLightView.fog = null;
    this.#depthLightView.environment = null;
    // Every light this client adds hangs off a scene's root — the world's sun and the shadow
    // cascades `CascadedSunShadows.configure` adds and removes, the portrait rig — so the root's
    // own additions are what can grow the set; a removed one is dropped by the view's visibility
    // walk. A light hung deeper is found by the next walk a root light triggers, and until then
    // costs a warm-up for a key the draw will not use, never a wrong picture.
    target.addEventListener("childadded", ({ child }) => {
      if (this.#lights !== undefined && holdsLight(child)) this.#lights = undefined;
    });
  }

  #targetLights(): readonly THREE.Object3D[] {
    let lights = this.#lights;
    if (lights === undefined) {
      const found: THREE.Object3D[] = [];
      this.#target.traverse((object) => { if ((object as THREE.Light).isLight) found.push(object); });
      this.#lights = lights = found;
    }
    return lights;
  }

  /** Programs this class has handed to the driver. */
  get programs(): number {
    return this.#programs;
  }

  /** Programs whose uniform locations were fetched in the warm pass, not by a first draw. */
  get uniformLocations(): number {
    return this.#uniformLocations;
  }

  /** Flushes that had something to do; zero means nothing new was ever built. */
  get batches(): number {
    return this.#batches;
  }

  /** Shader chains that threw while warming; the real draw keeps its own error contract. */
  get failures(): number {
    return this.#failures;
  }

  /** Variants parked for a later flush, after this frame's batch. */
  get queued(): number {
    return this.#pending.length + this.#depthPending.length;
  }

  /** Shadow depth programs compiled ahead of the shadow pass. */
  get depthPrograms(): number {
    return this.#depthKeepers.length;
  }

  /** Bounded retained program references; includes both sides of transparent materials. */
  get retainedPrograms(): number {
    return this.#retained.scene + this.#retained.unit;
  }

  /** The part of `retainedPrograms` charged to unit looks (`PROGRAM_WARMUP_UNIT_RETAINED_PROGRAMS`). */
  get retainedUnitPrograms(): number {
    return this.#retained.unit;
  }

  /** Whether the driver can link off the main thread, which is what makes warming a win. */
  get parallelCompile(): boolean {
    return this.#renderer.extensions.has("KHR_parallel_shader_compile");
  }

  /**
   * Parks every submitted mesh under `object` for the next flush.
   *
   * Registration borrows geometry and material until the next flush, when an owned material copy
   * acquires the compiled programs. Registering the same material again for the same class variant is
   * free. The hint includes material.version and customProgramCacheKey, so explicit material
   * changes queue a new variant. Three still decides the complete scene-dependent program key.
   * `retention` picks the budget the compiled programs are kept under (see ProgramWarmupRetention).
   */
  registerObject(object: THREE.Object3D | undefined, retention: ProgramWarmupRetention = "scene"): void {
    if (!object) return;
    object.traverse((child) => {
      const kind = programWarmupKind(child);
      if (!kind) return;
      const mesh = child as THREE.Mesh;
      const geometry = mesh.geometry;
      const material = mesh.material;
      if (!geometry || !material) return;
      for (const entry of Array.isArray(material) ? material : [material]) {
        if (entry) this.#registerMesh(mesh, geometry, entry, kind, retention);
      }
    });
  }

  /** Drop this owner's queued borrow while preserving other live owners of the same variant. */
  unregisterObject(object: THREE.Object3D): void {
    object.traverse(child => {
      for (const entry of [...this.#pendingByOwner.get(child) ?? []]) this.#removeOwner(entry, child);
    });
  }

  /**
   * Parks one material whose mesh is not in hand — a full-screen pass, or a material that lives
   * outside any traversable node. `mesh` is only read for the instanced variants.
   */
  registerMaterial(
    material: THREE.Material,
    geometry: THREE.BufferGeometry,
    kind: ProgramWarmupKind = "mesh",
    retention: ProgramWarmupRetention = "scene",
  ): void {
    this.#registerMesh(undefined, geometry, material, kind, retention);
  }

  /**
   * Whether drawing this material now would link nothing: either the warm pass compiled its variant,
   * or a draw already did, and the driver reports every one of those programs linked. A caller that
   * can hold a new object back for a frame or two asks this before showing it.
   */
  isLinked(material: THREE.Material, geometry: THREE.BufferGeometry, kind: ProgramWarmupKind): boolean {
    const warmed = this.#warmed.get(material)?.get(warmupVariant(geometry, material, kind));
    const record = this.#renderer.properties.get(material) as MaterialRecord | undefined;
    const programs = warmed?.programs.length ? warmed.programs
      : record?.programs?.size ? [...record.programs.values()] : [];
    if (programs.length === 0) return false;
    for (const program of programs) {
      if (program.program === undefined) return false;
      try {
        if (program.isReady() !== true) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether this variant is already in the warm pass's hands — queued, or compiled with every
   * program still alive, linked or linking — so registering it again would change nothing. A caller
   * waiting on `isLinked` every frame asks this first rather than registering the same variant anew.
   */
  isTracked(material: THREE.Material, geometry: THREE.BufferGeometry, kind: ProgramWarmupKind): boolean {
    const variant = warmupVariant(geometry, material, kind);
    if (this.#pendingByVariant.get(material)?.has(variant)) return true;
    const warmed = this.#warmed.get(material)?.get(variant);
    return warmed !== undefined && warmed.programs.length > 0
      && warmed.programs.every(program => program.program !== undefined);
  }

  /**
   * Stricter than `isLinked`: true only when this pass compiled this exact variant and fetched the
   * uniform locations of every one of its programs, so a first draw links and queries nothing.
   * `isLinked` also accepts the programs a draw made for *other* variants of the material — right
   * for a room's own runs, wrong for an instanced copy of a model whose plain-mesh programs exist.
   */
  isWarm(material: THREE.Material, geometry: THREE.BufferGeometry, kind: ProgramWarmupKind): boolean {
    const warmed = this.#warmed.get(material)?.get(warmupVariant(geometry, material, kind));
    if (!warmed || warmed.programs.length === 0) return false;
    for (const program of warmed.programs) {
      if (program.program === undefined || !this.#settled.has(program)) return false;
    }
    return true;
  }

  /**
   * One frame's worth: settle what the driver finished, then hand over batches — the first always,
   * more while the frame's `PROGRAM_WARMUP_BUDGET_MS` lasts.
   */
  tick(camera: THREE.Camera): void {
    this.#settle();
    this.#tickDepth(camera);
    const started = performance.now();
    do {
      if (this.#pending.length === 0) return;
      this.#compileBatch(this.#takeBatch(), camera);
    } while (performance.now() - started < PROGRAM_WARMUP_BUDGET_MS);
  }

  /**
   * The next batch, unit registrations first. A held unit is invisible until its programs link, and
   * it waits for at most its hold's cap; a scenery variant waits for nothing but its first draw, which
   * it may make without being warmed at all. First in, first out within each kind.
   */
  #takeBatch(): PendingWarmup[] {
    const batch: PendingWarmup[] = [];
    for (let index = 0; index < this.#pending.length && batch.length < PROGRAM_WARMUP_BATCH;) {
      if (this.#pending[index]!.retention === "unit") batch.push(this.#pending.splice(index, 1)[0]!);
      else index++;
    }
    if (batch.length < PROGRAM_WARMUP_BATCH) batch.push(...this.#pending.splice(0, PROGRAM_WARMUP_BATCH - batch.length));
    return batch;
  }

  #compileBatch(batch: readonly PendingWarmup[], camera: THREE.Camera): void {
    for (const entry of batch) this.#forgetPending(entry);
    this.#scene.fog = this.#target.fog;
    this.#scene.environment = this.#target.environment;
    const owners = new Map<PendingWarmup, THREE.Material>();
    for (const entry of batch) {
      let owner: THREE.Material | undefined;
      try {
        owner = entry.material.clone();
        // Material.clone deliberately omits custom shader hooks. Keep them only through compile;
        // their closures and texture uniforms are detached before parking this inert owner.
        owner.onBeforeCompile = entry.material.onBeforeCompile;
        const key = warmupCacheKey(entry.material);
        owner.customProgramCacheKey = () => key;
        (entry.proxy as THREE.Mesh).material = owner;
        owners.set(entry, owner);
        this.#scene.add(entry.proxy);
      } catch {
        owners.delete(entry);
        owner?.dispose();
        this.#scene.remove(entry.proxy);
        this.#failures++;
      }
    }
    if (owners.size === 0) return;
    this.#batches++;
    let materials: Set<THREE.Material> | undefined;
    try {
      materials = compileWith(this.#renderer, this.#scene, camera, this.#lightView);
    } catch {
      // A shader chain that refuses to compile is a defect the real draw reports on its own; the
      // warm pass is not the place to turn it into a broken frame.
      this.#failures++;
    } finally {
      for (const entry of batch) this.#scene.remove(entry.proxy);
    }
    for (const [entry, owner] of owners) {
      if (!materials?.has(owner)) {
        owner.dispose();
        continue;
      }
      const record = this.#renderer.properties.get(owner) as MaterialRecord | undefined;
      const programs = record?.programs ? [...new Set(record.programs.values())]
        : record?.currentProgram ? [record.currentProgram] : [];
      for (const program of programs) this.#queueProgram(program);
      const keeperKey = this.#retainOwner(owner, record, programs, entry.retention);
      let warmed = this.#warmed.get(entry.material);
      if (!warmed) {
        warmed = new Map();
        this.#warmed.set(entry.material, warmed);
      }
      warmed.set(entry.variant, { programs, keeperKey });
    }
  }

  #retainOwner(
    owner: THREE.Material,
    record: MaterialRecord | undefined,
    programs: readonly WarmProgram[],
    retention: ProgramWarmupRetention,
  ): string | undefined {
    if (!record?.programs?.size || programs.length === 0) {
      owner.dispose();
      return undefined;
    }
    // Use Three's exact keys, including lights, fog, skinning and front/back pass differences.
    const key = JSON.stringify([...record.programs.keys()].sort());
    const existing = this.#keepers.get(key);
    if (existing && existing.programs.every(program => program.program !== undefined)) {
      this.#touchKeeper(key, existing, retention);
      owner.dispose();
      return key;
    }
    if (existing) this.#dropKeeper(key, existing);
    if (programs.length > retainedBudget(retention)) {
      owner.dispose();
      return undefined;
    }
    // The keeper is never drawn or compiled again. Release borrowed asset references, including
    // texture uniforms injected by onBeforeCompile; replacing containers never changes shared
    // uniform.value objects belonging to live materials.
    detachKeeperResources(owner, record);
    this.#keepers.set(key, { material: owner, programs, retention });
    this.#retained[retention] += programs.length;
    this.#evictKeepers(retention);
    return key;
  }

  /**
   * Marks a keeper most recently used. A unit registration of a program a scenery keeper holds
   * moves that keeper onto the unit budget, where scenery churn can no longer reach it.
   */
  #touchKeeper(key: string, keeper: ProgramKeeper, retention: ProgramWarmupRetention): void {
    this.#keepers.delete(key);
    this.#keepers.set(key, keeper);
    if (retention !== "unit" || keeper.retention === "unit") return;
    this.#retained.scene -= keeper.programs.length;
    keeper.retention = "unit";
    this.#retained.unit += keeper.programs.length;
    this.#evictKeepers("unit");
  }

  /** Least recently used first, and only keepers charged to the budget that overflowed. */
  #evictKeepers(retention: ProgramWarmupRetention): void {
    const budget = retainedBudget(retention);
    while (this.#retained[retention] > budget) {
      let oldest: [string, ProgramKeeper] | undefined;
      for (const entry of this.#keepers) {
        if (entry[1].retention === retention) {
          oldest = entry;
          break;
        }
      }
      if (!oldest) break;
      this.#dropKeeper(oldest[0], oldest[1]);
    }
  }

  #dropKeeper(key: string, keeper: ProgramKeeper): void {
    this.#keepers.delete(key);
    this.#retained[keeper.retention] -= keeper.programs.length;
    keeper.material.dispose();
  }

  #queueProgram(program: WarmProgram): void {
    if (this.#seenPrograms.has(program)) return;
    this.#seenPrograms.add(program);
    this.#programs++;
    this.#settling.push(program);
  }

  /** Forgets everything parked. Called when a world's resources are dropped. */
  reset(): void {
    for (const entry of [...this.#pending]) this.#cancelPending(entry);
    this.#lights = undefined;
    this.#settling.length = 0;
    this.#seenPrograms = new WeakSet();
    this.#settled = new WeakSet();
    this.#warmed = new WeakMap();
    for (const [key, keeper] of this.#keepers) this.#dropKeeper(key, keeper);
    for (const { material } of this.#depthPending.splice(0)) material.dispose();
    for (const material of this.#depthKeepers.splice(0)) material.dispose();
    this.#depthVariants.clear();
    this.#depthTarget?.dispose();
    this.#depthTarget = undefined;
  }

  #registerMesh(
    mesh: THREE.Object3D | undefined,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    kind: ProgramWarmupKind,
    retention: ProgramWarmupRetention,
  ): void {
    this.#registerDepth(mesh, geometry, material, kind);
    const variant = warmupVariant(geometry, material, kind);
    const warmed = this.#warmed.get(material)?.get(variant);
    if (warmed && warmed.programs.length > 0 && warmed.programs.every(program => program.program !== undefined)) {
      const keeper = warmed.keeperKey === undefined ? undefined : this.#keepers.get(warmed.keeperKey);
      if (keeper && warmed.keeperKey !== undefined) this.#touchKeeper(warmed.keeperKey, keeper, retention);
      return;
    }
    let variants = this.#pendingByVariant.get(material);
    if (!variants) {
      variants = new Map();
      this.#pendingByVariant.set(material, variants);
    }
    let entry = variants.get(variant);
    if (!entry) {
      entry = {
        proxy: programWarmupProxy(mesh, geometry, material, kind), material, kind, variant,
        owners: new Map(), geometryListeners: new Map(),
        materialDispose: () => { if (entry) this.#cancelPending(entry); },
        retention,
      };
      variants.set(variant, entry);
      material.addEventListener("dispose", entry.materialDispose);
      this.#pending.push(entry);
    } else if (retention === "unit") {
      entry.retention = "unit";
    }
    const owner = mesh ?? material;
    if (entry.owners.has(owner)) return;
    entry.owners.set(owner, mesh ? { geometry, mesh } : { geometry });
    let ownerEntries = this.#pendingByOwner.get(owner);
    if (!ownerEntries) {
      ownerEntries = new Set();
      this.#pendingByOwner.set(owner, ownerEntries);
    }
    ownerEntries.add(entry);
    if (!entry.geometryListeners.has(geometry)) {
      const onDispose = () => {
        for (const [borrower, source] of [...entry.owners]) {
          if (source.geometry === geometry) this.#removeOwner(entry, borrower);
        }
      };
      geometry.addEventListener("dispose", onDispose);
      entry.geometryListeners.set(geometry, onDispose);
    }
  }

  /**
   * Parks the shadow depth program this mesh would cast with, once per program-relevant variant.
   * Only while the renderer draws shadows at all; whether this exact mesh ends up casting is decided
   * later by the renderer, and a variant warmed for a mesh that never casts costs one idle program.
   */
  #registerDepth(
    mesh: THREE.Object3D | undefined,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    kind: ProgramWarmupKind,
  ): void {
    if (this.#renderer.shadowMap?.enabled !== true) return;
    if (this.#depthVariants.size >= PROGRAM_WARMUP_DEPTH_VARIANTS) return;
    const depth = shadowDepthStandIn(material);
    if (!depth) return;
    const variant = depthVariant(depth, geometry, kind);
    if (this.#depthVariants.has(variant)) {
      depth.dispose();
      return;
    }
    this.#depthVariants.add(variant);
    this.#depthPending.push({ proxy: programWarmupProxy(mesh, geometry, depth, kind), material: depth });
  }

  /**
   * Compiles parked depth variants the way the shadow pass will ask for them: bound to an offscreen
   * target (linear output, no tone mapping) and with the world's lights but none of its fog or
   * environment, which the shadow pass never passes to its draws.
   */
  #tickDepth(camera: THREE.Camera): void {
    if (this.#depthPending.length === 0) return;
    const batch = this.#depthPending.splice(0, PROGRAM_WARMUP_BATCH);
    for (const { proxy } of batch) this.#depthScene.add(proxy);
    const previous = this.#renderer.getRenderTarget();
    let materials: Set<THREE.Material> | undefined;
    try {
      this.#depthTarget ??= new THREE.WebGLRenderTarget(1, 1);
      this.#renderer.setRenderTarget(this.#depthTarget);
      materials = compileWith(this.#renderer, this.#depthScene, camera, this.#depthLightView);
    } catch {
      this.#failures++;
    } finally {
      this.#renderer.setRenderTarget(previous);
      for (const { proxy } of batch) this.#depthScene.remove(proxy);
    }
    for (const { material } of batch) {
      const record = this.#renderer.properties.get(material) as MaterialRecord | undefined;
      const programs = record?.programs ? [...new Set(record.programs.values())]
        : record?.currentProgram ? [record.currentProgram] : [];
      if (!materials?.has(material) || programs.length === 0) {
        material.dispose();
        continue;
      }
      for (const program of programs) this.#queueProgram(program);
      // The owner of the programs from here on; it never draws, so it keeps no texture either.
      if (record) detachKeeperResources(material, record);
      this.#depthKeepers.push(material);
    }
  }

  #removeOwner(entry: PendingWarmup, owner: object): void {
    const source = entry.owners.get(owner);
    if (!source) return;
    entry.owners.delete(owner);
    const entries = this.#pendingByOwner.get(owner);
    entries?.delete(entry);
    if (entries?.size === 0) this.#pendingByOwner.delete(owner);
    let geometryStillBorrowed = false;
    for (const other of entry.owners.values()) {
      if (other.geometry === source.geometry) {
        geometryStillBorrowed = true;
        break;
      }
    }
    if (!geometryStillBorrowed) {
      const listener = entry.geometryListeners.get(source.geometry);
      if (listener) source.geometry.removeEventListener("dispose", listener);
      entry.geometryListeners.delete(source.geometry);
    }
    if (entry.owners.size === 0) {
      this.#cancelPending(entry);
      return;
    }
    if ((entry.proxy as THREE.Mesh).geometry === source.geometry) {
      const next = entry.owners.values().next().value!;
      entry.proxy = programWarmupProxy(next.mesh, next.geometry, entry.material, entry.kind);
    }
  }

  #cancelPending(entry: PendingWarmup): void {
    const index = this.#pending.indexOf(entry);
    if (index >= 0) this.#pending.splice(index, 1);
    this.#forgetPending(entry);
  }

  #forgetPending(entry: PendingWarmup): void {
    const variants = this.#pendingByVariant.get(entry.material);
    if (variants?.get(entry.variant) === entry) variants.delete(entry.variant);
    if (variants?.size === 0) this.#pendingByVariant.delete(entry.material);
    entry.material.removeEventListener("dispose", entry.materialDispose);
    for (const [geometry, listener] of entry.geometryListeners) {
      geometry.removeEventListener("dispose", listener);
    }
    entry.geometryListeners.clear();
    for (const owner of entry.owners.keys()) {
      const entries = this.#pendingByOwner.get(owner);
      entries?.delete(entry);
      if (entries?.size === 0) this.#pendingByOwner.delete(owner);
    }
    entry.owners.clear();
  }

  /** Fetches the uniform locations of every program the driver has finished linking. */
  #settle(): void {
    if (this.#settling.length === 0) return;
    const waiting: WarmProgram[] = [];
    for (const program of this.#settling) {
      if (program.program === undefined) continue;
      let ready: boolean | null = false;
      try {
        ready = program.isReady();
      } catch {
        // A program freed with its world has nothing left to answer with; drop it rather than
        // keep asking a destroyed object every frame.
        this.#failures++;
        continue;
      }
      // WebGL returns null for an invalid/lost handle; it is not a still-linking program.
      if (ready === null) continue;
      if (!ready) {
        waiting.push(program);
        continue;
      }
      try {
        program.getUniforms();
        this.#uniformLocations++;
        this.#settled.add(program);
      } catch {
        this.#failures++;
      }
    }
    this.#settling.length = 0;
    for (const program of waiting) this.#settling.push(program);
  }
}

/**
 * The warm-pass identity of one material on one class of object.
 *
 * `Material.version` changes when built-in flags/maps/defines request a new Three program.
 * The custom key alone does not cover those switches. Scene-dependent variants are still
 * settled by Three on the real draw; this is a bounded hint, not a copy of its private key.
 */
function warmupVariant(geometry: THREE.BufferGeometry, material: THREE.Material, kind: ProgramWarmupKind): string {
  return `${kind}|${geometryVariant(geometry, material)}|${material.version}|${warmupCacheKey(material)}`;
}

/** Finite layout switches read by Three; geometry identity would grow this hint without bound. */
function geometryVariant(geometry: THREE.BufferGeometry, material: THREE.Material): string {
  const flags = Number(geometry.hasAttribute("position"))
    | (Number(geometry.hasAttribute("normal")) << 1)
    | (Number(geometry.hasAttribute("tangent")) << 2)
    | (Number(material.vertexColors && geometry.getAttribute("color")?.itemSize === 4) << 3);
  const morph = geometry.morphAttributes;
  return `${flags}/${morph.position?.length ?? -1}/${morph.normal?.length ?? -1}/${morph.color?.length ?? -1}`;
}

/** A parked material owns programs, never assets or source-material closures. */
function detachKeeperResources(material: THREE.Material, record: MaterialRecord): void {
  const fields = material as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if ((value as THREE.Texture | null)?.isTexture) fields[key] = null;
  }
  if ((material as THREE.ShaderMaterial).isShaderMaterial) {
    (material as THREE.ShaderMaterial).uniforms = {};
    (material as THREE.ShaderMaterial).uniformsGroups = [];
  }
  material.userData = {};
  material.onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
  record.uniforms = {};
  record.uniformsList = null;
  record.environment = null;
  record.envMap = null;
  record.fog = null;
}

/** `customProgramCacheKey` can refuse on a half-applied profile; the real draw would too. */
function warmupCacheKey(material: THREE.Material): string {
  try {
    return material.customProgramCacheKey();
  } catch {
    return "unavailable";
  }
}

/**
 * `renderer.compile`, which the type set of three 0.185.1 does not declare.
 *
 * The third argument matters: lights and shadows are gathered from the target scene, so the
 * programs come out with the world pass's own light counts rather than an empty scene's. It is a
 * light view of that scene (`programWarmupLightView`), not the scene itself, so nothing walks it.
 */
function compileWith(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Object3D,
  camera: THREE.Camera,
  targetScene: THREE.Object3D,
): Set<THREE.Material> {
  const compilable = renderer as THREE.WebGLRenderer & {
    compile(scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Object3D): Set<THREE.Material>;
  };
  return compilable.compile(scene, camera, targetScene);
}

/**
 * Objects kept out of every pass until `ready` says the programs they will draw with are warm, and
 * shown after `maxFrames` warm passes regardless — the old first-draw cost, never an object that
 * stays missing. `release` belongs after the frame's warm pass and before its submission.
 */
/** Bench-only trace of hold decisions (`bench/run.mjs --trace` collects `window.__benchDebug`). */
function benchDebug(event: string, object: THREE.Object3D, frames?: number): void {
  const sink = (globalThis as { __benchDebug?: unknown[] }).__benchDebug;
  if (!Array.isArray(sink)) return;
  const mesh = object as THREE.Mesh;
  const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
  sink.push({ at: performance.now(), event, object: object.uuid.slice(0, 8), frames,
    materials: materials.map((material) => material.uuid.slice(0, 8)) });
}

export class WarmHold {
  readonly #held = new Map<THREE.Object3D, number>();
  readonly #maxFrames: number;
  readonly #ready: (object: THREE.Object3D) => boolean;

  constructor(maxFrames: number, ready: (object: THREE.Object3D) => boolean) {
    this.#maxFrames = maxFrames;
    this.#ready = ready;
  }

  /** How many objects are waiting. */
  get size(): number {
    return this.#held.size;
  }

  /** Hides `object` until its programs are warm; one that is warm already is left alone. */
  hold(object: THREE.Object3D): void {
    if (this.#held.has(object)) return;
    if (this.#ready(object)) {
      benchDebug("hold-skip-warm", object);
      return;
    }
    object.visible = false;
    this.#held.set(object, 0);
    benchDebug("hold", object);
  }

  /** Shows every held object that is warm now or has waited `maxFrames` passes. */
  release(): void {
    for (const [object, frames] of this.#held) {
      const warm = this.#ready(object);
      if (frames >= this.#maxFrames || warm) {
        object.visible = true;
        this.#held.delete(object);
        benchDebug(warm ? "release-warm" : "release-cap", object, frames);
      } else {
        this.#held.set(object, frames + 1);
      }
    }
  }

  /** Forgets one hold without touching the object: its owner is dropping it. */
  forget(object: THREE.Object3D): void {
    this.#held.delete(object);
  }

  /** Forgets every hold (a world reset disposes the objects themselves). */
  clear(): void {
    this.#held.clear();
  }
}
