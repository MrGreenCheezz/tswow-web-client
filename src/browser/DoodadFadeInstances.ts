import * as THREE from "three";
import { modelPlacementTintColour, type ModelPlacementTint } from "./ModelPlacementTint.js";
import { DOODAD_FADE_GONE } from "./DoodadFade.js";

/**
 * 15.11 (7.66, the last stretch; fade9): draws the doodads inside their fade band (`DoodadFade.ts`) — a small share of
 * all — as copies of one mesh per model with a per-copy alpha, instead of popping them at their class distance.
 *
 * The instanced buckets share one material array per model and draw opaque or alpha-tested programs (`instanceableBuild`),
 * which cannot carry a per-copy alpha. A fading copy leaves its bucket for this pass's mesh of the same model, whose
 * materials are copies made once per source material: the same shader chain plus one step that multiplies the fragment's
 * alpha by the copy's `doodadFade` (an instanced attribute) at the very end, after the alpha test and the fog, and
 * transparent — as `fadeMaterial` fades a unit's opaque and cut-out batches by the model alpha (+0x178, the field the
 * doodad's fade writes in Wow.exe): the cut-out stays the authored one (a·f > t·f is a > t), depth is written as
 * authored. A copy at or below 0.01 is discarded, as 0x00791cb0 does not draw it. The program key is the source's plus
 * `|doodad-fade`, so a fade program is never shared with a plain one, and the step adds no uniform, so a reused program
 * needs nothing from a skipped compile.
 *
 * The attribute lives on a geometry of this pass's own that shares every buffer of the model's (index, attributes, groups):
 * the model's geometry is the buckets' and the plain nodes', and must not be disposed or rebound from here. Such a shell
 * is never disposed either — disposing it would delete the shared buffers — it is kept per model geometry and dropped
 * with it.
 *
 * A new mesh is drawn only once the program warm-up says its programs are linked (as a fresh bucket waits, Шаг 19);
 * until then its copies stay in their buckets, whole, and are not claimed.
 */
export const DOODAD_FADE_ATTRIBUTE = "doodadFade";
const DOODAD_FADE_KEY = "doodad-fade";

export interface DoodadFadeHooks {
  /** Parks a new mesh for the warm pass. */
  register(mesh: THREE.InstancedMesh): void;
  unregister(mesh: THREE.InstancedMesh): void;
  /** Whether every program the mesh draws with is linked. */
  warm(mesh: THREE.InstancedMesh): boolean;
}

interface FadeShell {
  readonly geometry: THREE.BufferGeometry;
  attribute: THREE.InstancedBufferAttribute;
}

interface FadeMesh {
  readonly mesh: THREE.InstancedMesh;
  /** 15.11 (fx11): the depth-only pass before it, over the same copies (`doodadFadeDepthMaterial`). */
  readonly depth: THREE.InstancedMesh;
  readonly source: THREE.BufferGeometry;
  readonly capacity: number;
  warm: boolean;
}

interface FadeMember {
  owner: object;
  matrix: THREE.Matrix4;
  tint: ModelPlacementTint | undefined;
  alpha: number;
}

const FADE_COPIES = new WeakMap<THREE.Material, THREE.Material>();
const SHELLS = new WeakMap<THREE.BufferGeometry, FadeShell>();

/** The vertex half of the step: the copy's alpha handed on. */
export function doodadFadeVertex(source: string): string {
  if (!source.includes("void main() {")) throw new Error("Doodad fade expected a main() in the vertex shader");
  return `attribute float ${DOODAD_FADE_ATTRIBUTE};\nvarying float vDoodadFade;\n`
    + source.replace("void main() {", `void main() {\n\tvDoodadFade = ${DOODAD_FADE_ATTRIBUTE};`);
}

/** The fragment half: the output's alpha times the copy's, after everything else; gone at 0.01 (0x009f1968). */
export function doodadFadeFragment(source: string): string {
  const body = `\tif ( vDoodadFade <= ${DOODAD_FADE_GONE.toFixed(2)} ) discard;\n\tgl_FragColor.a *= vDoodadFade;`;
  const marker = "#include <dithering_fragment>";
  const end = source.includes(marker)
    ? source.replace(marker, `${marker}\n${body}`)
    : source.replace(/}\s*$/, `${body}\n}\n`);
  return `varying float vDoodadFade;\n${end}`;
}

/**
 * The fade copy of one source material, made once: its shader chain as the source's at compile time plus the fade step;
 * transparent, every other property the source's (`syncFadeCopy` keeps colour, opacity and the cut-out in step).
 */
export function doodadFadeMaterial(source: THREE.Material): THREE.Material {
  const cached = FADE_COPIES.get(source);
  if (cached) return syncFadeCopy(cached, source);
  const copy = source.clone();
  copy.onBeforeCompile = (shader, renderer) => {
    source.onBeforeCompile.call(source, shader, renderer);
    shader.vertexShader = doodadFadeVertex(shader.vertexShader);
    shader.fragmentShader = doodadFadeFragment(shader.fragmentShader);
  };
  copy.customProgramCacheKey = () => `${source.customProgramCacheKey()}|${DOODAD_FADE_KEY}`;
  copy.transparent = true;
  FADE_COPIES.set(source, copy);
  return copy;
}

const DEPTH_COPIES = new WeakMap<THREE.Material, THREE.Material>();

/**
 * 15.11 (fx11, 7.66): the depth-only pass of one source material's fade copy, made once. Wow.exe draws a fading M2 in two
 * passes, every batch of the model each time (WowOracle frames s03, s06, s08, fog6-o-netherstorm, fx11-leaf-1/2: 102
 * fading copies, `.runtime/re-2026-11-15/fx11/fadecopies.txt`): first with colour writes off, no blending, depth written
 * with LESSEQUAL and the batch's own cull and alpha test (224 × α on a cut-out, s06 #2541: 136); then again with
 * SrcAlpha/InvSrcAlpha, depth still written, the same test. So only the copy's nearest surface shows, at its alpha: its
 * own inner layers (a tree's crowns behind crowns) do not show through it. The program is the fade copy's (same chain,
 * same key; colour writes are not part of a program), so it needs no warm-up of its own.
 */
export function doodadFadeDepthMaterial(source: THREE.Material): THREE.Material {
  const fade = doodadFadeMaterial(source);
  const cached = DEPTH_COPIES.get(fade);
  if (cached) return syncFadeCopy(cached, fade);
  const depth = fade.clone();
  depth.onBeforeCompile = fade.onBeforeCompile;
  depth.customProgramCacheKey = fade.customProgramCacheKey;
  depth.colorWrite = false;
  depth.depthWrite = true;
  depth.transparent = true;
  DEPTH_COPIES.set(fade, depth);
  return depth;
}

function syncFadeCopy(copy: THREE.Material, source: THREE.Material): THREE.Material {
  const from = source as THREE.Material & { color?: THREE.Color };
  const to = copy as THREE.Material & { color?: THREE.Color };
  if (from.color && to.color && !to.color.equals(from.color)) to.color.copy(from.color);
  if (to.opacity !== from.opacity) to.opacity = from.opacity;
  if (to.alphaTest !== from.alphaTest) to.alphaTest = from.alphaTest;
  return copy;
}

function fadeShell(source: THREE.BufferGeometry, capacity: number): FadeShell {
  let shell = SHELLS.get(source);
  if (!shell) {
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(source.index);
    for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
    for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
    geometry.name = `${source.name}|${DOODAD_FADE_KEY}`;
    shell = { geometry, attribute: new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1) };
    geometry.setAttribute(DOODAD_FADE_ATTRIBUTE, shell.attribute);
    SHELLS.set(source, shell);
  } else if (shell.attribute.count < capacity) {
    shell.attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    shell.geometry.setAttribute(DOODAD_FADE_ATTRIBUTE, shell.attribute);
  }
  shell.attribute.setUsage(THREE.DynamicDrawUsage);
  return shell;
}

function capacityFor(count: number): number {
  let capacity = 4;
  while (capacity < count) capacity *= 2;
  return capacity;
}

export class DoodadFadeInstances {
  /** Hung in the world scene by the renderer. */
  readonly group = new THREE.Group();
  readonly #hooks: DoodadFadeHooks;
  readonly #meshes = new Map<string, FadeMesh>();
  readonly #lists = new Map<string, { geometry: THREE.BufferGeometry; materials: THREE.Material | THREE.Material[]; members: FadeMember[]; used: number }>();
  #claimed = new Set<object>();
  #next = new Set<object>();
  readonly #tint = new THREE.Color();

  constructor(hooks: DoodadFadeHooks) {
    this.#hooks = hooks;
    this.group.name = "doodadFade";
  }

  /** Whether `owner`'s copy is drawn by this pass (and must be left out of its bucket and hidden). */
  claims(owner: object): boolean {
    return this.#claimed.has(owner);
  }

  /** Copies drawn by this pass after the last commit. */
  get claimed(): number {
    return this.#claimed.size;
  }

  /** Meshes this pass holds. */
  get meshes(): number {
    return this.#meshes.size;
  }

  begin(): void {
    for (const list of this.#lists.values()) list.used = 0;
    this.#next.clear();
  }

  /** One fading copy of the model `key` (its bucket's model) at `matrix` with the model alpha `alpha`. */
  add(
    key: string,
    owner: object,
    geometry: THREE.BufferGeometry,
    materials: THREE.Material | THREE.Material[],
    matrix: THREE.Matrix4,
    tint: ModelPlacementTint | undefined,
    alpha: number,
  ): void {
    let list = this.#lists.get(key);
    if (!list || list.geometry !== geometry) {
      list = { geometry, materials, members: list?.members ?? [], used: 0 };
      this.#lists.set(key, list);
    }
    list.materials = materials;
    const member = list.members[list.used];
    if (member) {
      member.owner = owner; member.matrix = matrix; member.tint = tint; member.alpha = alpha;
    } else {
      list.members.push({ owner, matrix, tint, alpha });
    }
    list.used++;
  }

  /**
   * Writes this run's copies and answers whether the set of claimed copies changed (the buckets then rebuild without
   * them, or with them back).
   */
  commit(): boolean {
    for (const [key, list] of this.#lists) {
      if (list.used === 0) {
        this.#drop(key);
        this.#lists.delete(key);
        continue;
      }
      let entry = this.#meshes.get(key);
      if (entry && (entry.source !== list.geometry || entry.capacity < list.used)) {
        this.#drop(key);
        entry = undefined;
      }
      if (!entry) {
        const capacity = capacityFor(list.used);
        const shell = fadeShell(list.geometry, capacity);
        const materials = Array.isArray(list.materials)
          ? list.materials.map(doodadFadeMaterial)
          : doodadFadeMaterial(list.materials);
        const mesh = new THREE.InstancedMesh(shell.geometry, materials, capacity);
        // Copies spread over the whole band of the view; one sphere over them would cull nothing.
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.name = `doodadFade:${key}`;
        // First among the transparent draws: the copies stand in for batches the opaque pass draws, and the scene's
        // own transparent layers drawn at the default order must cover them as they cover those. Sorted among them by
        // its origin (the world's), a fading tree at 1,100 yards was drawn after them, unveiled, as a dark shape in the
        // fog (lookdev, Netherstorm, objectDistance 150).
        mesh.renderOrder = -1;
        mesh.visible = false;
        // 15.11 (fx11): the original's depth-only pass first — every fading copy's, just before the colour passes. It
        // shares the copies' matrices (and colours, so its program is the colour pass's).
        const depthMaterials = Array.isArray(list.materials)
          ? list.materials.map(doodadFadeDepthMaterial)
          : doodadFadeDepthMaterial(list.materials);
        const depth = new THREE.InstancedMesh(shell.geometry, depthMaterials, capacity);
        depth.instanceMatrix = mesh.instanceMatrix;
        depth.frustumCulled = false;
        depth.castShadow = false;
        depth.receiveShadow = false;
        depth.name = `doodadFadeDepth:${key}`;
        depth.renderOrder = -2;
        depth.visible = false;
        entry = { mesh, depth, source: list.geometry, capacity, warm: false };
        this.#meshes.set(key, entry);
        this.group.add(mesh);
        this.group.add(depth);
      } else {
        const materials = entry.mesh.material;
        const depthMaterials = entry.depth.material;
        if (Array.isArray(materials) && Array.isArray(list.materials)) {
          for (let index = 0; index < materials.length; index++) syncFadeCopy(materials[index]!, list.materials[index]!);
        } else if (!Array.isArray(materials) && !Array.isArray(list.materials)) {
          syncFadeCopy(materials, list.materials);
        }
        if (Array.isArray(depthMaterials) && Array.isArray(materials)) {
          for (let index = 0; index < depthMaterials.length; index++) syncFadeCopy(depthMaterials[index]!, materials[index]!);
        } else if (!Array.isArray(depthMaterials) && !Array.isArray(materials)) {
          syncFadeCopy(depthMaterials, materials);
        }
      }
      const shell = SHELLS.get(list.geometry)!;
      const mesh = entry.mesh;
      for (let index = 0; index < list.used; index++) {
        const member = list.members[index]!;
        mesh.setMatrixAt(index, member.matrix);
        mesh.setColorAt(index, modelPlacementTintColour(member.tint, this.#tint));
        shell.attribute.setX(index, member.alpha);
      }
      mesh.count = list.used;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      shell.attribute.needsUpdate = true;
      if (!entry.warm) {
        // Registered once its colours exist: `setColorAt` gives it `instanceColor`, part of the program.
        if (mesh.userData["doodadFadeRegistered"] !== true) {
          mesh.userData["doodadFadeRegistered"] = true;
          this.#hooks.register(mesh);
        }
        entry.warm = this.#hooks.warm(mesh);
      }
      mesh.visible = entry.warm;
      const depth = entry.depth;
      depth.count = mesh.count;
      depth.instanceColor = mesh.instanceColor;
      depth.visible = entry.warm;
      if (entry.warm) {
        for (let index = 0; index < list.used; index++) this.#next.add(list.members[index]!.owner);
      }
      // Members past `used` keep no owners alive.
      for (let index = list.used; index < list.members.length; index++) {
        const member = list.members[index]!;
        member.owner = this; member.tint = undefined;
      }
    }
    const previous = this.#claimed;
    let changed = previous.size !== this.#next.size;
    if (!changed) {
      for (const owner of this.#next) {
        if (!previous.has(owner)) { changed = true; break; }
      }
    }
    this.#claimed = this.#next;
    this.#next = previous;
    return changed;
  }

  /** Drops every mesh (a world reset). */
  clear(): void {
    for (const key of [...this.#meshes.keys()]) this.#drop(key);
    this.#lists.clear();
    this.#claimed.clear();
    this.#next.clear();
  }

  #drop(key: string): void {
    const entry = this.#meshes.get(key);
    if (!entry) return;
    entry.mesh.removeFromParent();
    entry.depth.removeFromParent();
    this.#hooks.unregister(entry.mesh);
    // Only the copy matrix and colour buffers are this mesh's (the depth pass shares them, and goes with it); the shell,
    // its buffers and the fade copies are kept.
    entry.mesh.dispose();
    entry.depth.dispose();
    this.#meshes.delete(key);
  }
}
