/**
 * P2-03a (UNT-1): one draw per unit body and pass — a material whose texture is chosen per vertex.
 *
 * A body is drawn in the passes the file authors it in: the skin atlas, the hair card, a cloak, a
 * second atlas run. Each pass was its own geometry group, so its own draw in the main pass and in
 * every shadow cascade, and its own material switch: a city crowd spent 3–7 draws per unit. The
 * passes of a body differ only in what this module carries per *slot* — which texture, a static
 * tint, whether it is alpha-keyed, whether it is two-sided — so adjacent passes fold into one group
 * and one `MeshStandardMaterial` that picks its slot from a vertex attribute (`wvmSlot`).
 *
 * Nothing about a fragment's arithmetic changes: the slot's texel is sampled at the same `vMapUv`
 * with the same sampler state, the tint multiplies in exactly where `material.color` and `opacity`
 * did (the carrier keeps white and 1, and `1·x` is exact), and the alpha-key threshold is the
 * material's own `alphaTest` gated per slot, so a fade copy scaling it still scales every slot. Two
 * things are new: every slot texture is sampled for every fragment (uniform control flow keeps the
 * hardware LOD the same as a lone sampler), and a single-sided slot inside a two-sided carrier
 * discards the faces culling would have dropped.
 *
 * The shadow pass needs the same per-slot answers, so a carrier with an alpha-keyed slot or with
 * mixed sides gets a depth material of its own (`slotDepthMaterialFor`), which the unit mesh carries
 * as `customDepthMaterial`. three copies `map`, `alphaTest` and `side` onto it from the group's
 * material on every draw (`WebGLShadowMap.getDepthMaterial`); this shader relies on nothing else.
 */

import * as THREE from "three";

/** Textures one carrier may sample: `map` plus `wvmMap1..3`. */
export const WVM_SLOT_SAMPLERS = 4;
/** Passes one carrier may fold. */
export const WVM_SLOT_ROWS = 8;
/** `wvmSlot` of a vertex no folded group draws. */
export const WVM_SLOT_NONE = 255;

/**
 * How far unit builds fold their passes. `coalesce` joins adjacent equal two-sided passes (no new
 * shader); `sameSide` folds adjacent foldable passes of one side into a slot carrier; `merged` also
 * folds across sides, carrying the side per slot.
 */
export type SlotFoldLevel = "off" | "coalesce" | "sameSide" | "merged";

export interface SlotRow {
  /** Index into the carrier's samplers: 0 is `map`, 1–3 `wvmMap1..3`. */
  sampler: number;
  /** Static colour and opacity of the pass (its tracks at time zero). */
  tint: readonly [number, number, number, number];
  /** Alpha-keyed (cut at the material's `alphaTest`) rather than opaque. */
  keyed: boolean;
  /** Two-sided pass. Read only by a `facing` carrier. */
  sided: boolean;
}

export interface SlotUniforms {
  wvmMap1: { value: THREE.Texture | null };
  wvmMap2: { value: THREE.Texture | null };
  wvmMap3: { value: THREE.Texture | null };
  wvmSlotSampler: { value: number[] };
  wvmSlotTint: { value: THREE.Vector4[] };
  wvmSlotKeyed: { value: number[] };
  wvmSlotSided: { value: number[] };
}

/** Uniform objects shared by a carrier, its fade and portrait copies and its depth material. */
export function createSlotUniforms(extraMaps: readonly THREE.Texture[], rows: readonly SlotRow[]): SlotUniforms {
  if (rows.length > WVM_SLOT_ROWS) throw new Error(`a slot carrier folds at most ${WVM_SLOT_ROWS} passes`);
  if (extraMaps.length > WVM_SLOT_SAMPLERS - 1) throw new Error(`a slot carrier samples at most ${WVM_SLOT_SAMPLERS} textures`);
  const sampler = new Array<number>(WVM_SLOT_ROWS).fill(0);
  const tint = Array.from({ length: WVM_SLOT_ROWS }, () => new THREE.Vector4(1, 1, 1, 1));
  const keyed = new Array<number>(WVM_SLOT_ROWS).fill(0);
  const sided = new Array<number>(WVM_SLOT_ROWS).fill(0);
  rows.forEach((row, index) => {
    sampler[index] = row.sampler;
    tint[index]!.set(row.tint[0], row.tint[1], row.tint[2], row.tint[3]);
    keyed[index] = row.keyed ? 1 : 0;
    sided[index] = row.sided ? 1 : 0;
  });
  return {
    wvmMap1: { value: extraMaps[0] ?? null },
    wvmMap2: { value: extraMaps[1] ?? null },
    wvmMap3: { value: extraMaps[2] ?? null },
    wvmSlotSampler: { value: sampler },
    wvmSlotTint: { value: tint },
    wvmSlotKeyed: { value: keyed },
    wvmSlotSided: { value: sided },
  };
}

const VERTEX_PARS = "attribute float wvmSlot;\nflat varying float vWvmSlot;\n";
const FRAGMENT_PARS = [
  "flat varying float vWvmSlot;",
  "uniform sampler2D wvmMap1;",
  "uniform sampler2D wvmMap2;",
  "uniform sampler2D wvmMap3;",
  `uniform float wvmSlotSampler[ ${WVM_SLOT_ROWS} ];`,
  `uniform vec4 wvmSlotTint[ ${WVM_SLOT_ROWS} ];`,
  `uniform float wvmSlotKeyed[ ${WVM_SLOT_ROWS} ];`,
  `uniform float wvmSlotSided[ ${WVM_SLOT_ROWS} ];`,
  "",
].join("\n");

/** Every sampler the carrier has, in uniform control flow, then the slot's one. */
function pickTexel(samplers: number): string {
  const lines = ["\tvec4 wvmTexel = texture2D( map, vMapUv );"];
  if (samplers > 1) {
    lines.push("\tfloat wvmSampler = wvmSlotSampler[ wvmS ];");
    for (let index = 1; index < samplers; index++) {
      lines.push(`\tvec4 wvmTexel${index} = texture2D( wvmMap${index}, vMapUv );`);
    }
    for (let index = 1; index < samplers; index++) {
      lines.push(`\tif ( wvmSampler > ${index - 1}.5 ) wvmTexel = wvmTexel${index};`);
    }
  }
  return lines.join("\n");
}

function replaceOnce(source: string, marker: string, replacement: string, what: string): string {
  const count = source.split(marker).length - 1;
  if (count !== 1) throw new Error(`slot material: expected one ${marker} in the ${what} shader, found ${count}`);
  return source.replace(marker, replacement);
}

/** The vertex half both the surface and the depth shader take. */
function slotVertex(shader: { vertexShader: string }): void {
  shader.vertexShader = replaceOnce(shader.vertexShader, "#include <common>", `#include <common>\n${VERTEX_PARS}`, "vertex");
  shader.vertexShader = replaceOnce(shader.vertexShader, "#include <uv_vertex>",
    "#include <uv_vertex>\n\tvWvmSlot = wvmSlot;", "vertex");
}

function bindUniforms(shader: { uniforms: Record<string, THREE.IUniform> }, uniforms: SlotUniforms): void {
  for (const [name, uniform] of Object.entries(uniforms)) shader.uniforms[name] = uniform;
}

/** What `onBeforeCompile` is handed, taken off the material's own signature. */
type ShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];

export interface SlotShaderStep {
  key: string;
  apply: (shader: ShaderSource) => void;
}

/**
 * The surface step, for the carrier's `onBeforeCompile` chain (before the world light). `samplers`
 * is how many textures it samples (1–4); `facing` that its slots differ in side.
 */
export function slotStep(uniforms: SlotUniforms, samplers: number, facing: boolean): SlotShaderStep {
  const n = Math.max(1, Math.min(WVM_SLOT_SAMPLERS, Math.floor(samplers)));
  // After every sample, so the discard cannot break the uniform flow the samples are taken in.
  const faces = facing ? [
    "#if defined( DOUBLE_SIDED )",
    "\tif ( wvmSlotSided[ wvmS ] < 0.5 && ! gl_FrontFacing ) discard;",
    "#elif defined( FLIP_SIDED )",
    "\tif ( wvmSlotSided[ wvmS ] < 0.5 ) discard;",
    "#endif",
  ].join("\n") : "";
  const map = [
    "int wvmS = int( vWvmSlot + 0.5 );",
    "#ifdef USE_MAP",
    pickTexel(n),
    "\tdiffuseColor = vec4( diffuseColor.rgb * wvmSlotTint[ wvmS ].rgb, diffuseColor.a * wvmSlotTint[ wvmS ].a ) * wvmTexel;",
    "#endif",
    faces,
  ].join("\n");
  const alphaTest = [
    "#ifdef USE_ALPHATEST",
    "\tif ( diffuseColor.a < alphaTest * wvmSlotKeyed[ wvmS ] ) discard;",
    "#endif",
  ].join("\n");
  return {
    key: `wvm-slots-v1:n${n}:f${facing ? 1 : 0}`,
    apply: (shader) => {
      bindUniforms(shader, uniforms);
      slotVertex(shader);
      shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <common>",
        `#include <common>\n${FRAGMENT_PARS}`, "fragment");
      shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <map_fragment>", map, "fragment");
      shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <alphatest_fragment>", alphaTest, "fragment");
    },
  };
}

const SLOT_DEPTH = new WeakMap<THREE.Material, THREE.MeshDepthMaterial>();
const SLOT_MAPS = new WeakMap<THREE.Material, readonly THREE.Texture[]>();
const FACING = new WeakSet<THREE.Material>();

/**
 * A carrier whose slots differ in side. Its fade copies must draw in one pass: three draws a
 * transparent two-sided material as all back faces, then all front faces, which would put every
 * two-sided slot's back faces (hair, cloak) under the whole translucent body for as long as a fade,
 * stealth or a ghost lasts. In one pass under `DOUBLE_SIDED` the slot shader already drops the back
 * faces of single-sided slots, and the triangles keep the authored order.
 */
export function markFacingCarrier(carrier: THREE.Material): void {
  FACING.add(carrier);
}

export function isFacingCarrier(material: THREE.Material): boolean {
  return FACING.has(material);
}

/**
 * The depth material for a carrier with a keyed slot or mixed sides. Depth alpha is the texel's,
 * as three's own depth shader has it (`diffuseColor = vec4(1.0)`, then the map), cut per slot at
 * the copied `alphaTest`; with `facing`, a single-sided slot keeps only back faces, which is what
 * `BackSide` — three's shadow side for a front-sided caster — draws.
 */
export function createSlotDepthMaterial(uniforms: SlotUniforms, samplers: number, facing: boolean): THREE.MeshDepthMaterial {
  const n = Math.max(1, Math.min(WVM_SLOT_SAMPLERS, Math.floor(samplers)));
  const depth = new THREE.MeshDepthMaterial();
  depth.name = "wvm-slot-depth";
  const map = [
    "int wvmS = int( vWvmSlot + 0.5 );",
    "#ifdef USE_MAP",
    pickTexel(n),
    "\tdiffuseColor *= wvmTexel;",
    "#endif",
    facing ? "\tif ( wvmSlotSided[ wvmS ] < 0.5 && gl_FrontFacing ) discard;" : "",
  ].join("\n");
  const alphaTest = [
    "#ifdef USE_ALPHATEST",
    "\tif ( diffuseColor.a < alphaTest * wvmSlotKeyed[ wvmS ] ) discard;",
    "#endif",
  ].join("\n");
  const key = `wvm-slot-depth-v1:n${n}:f${facing ? 1 : 0}`;
  depth.onBeforeCompile = (shader) => {
    bindUniforms(shader, uniforms);
    slotVertex(shader);
    shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <common>",
      `#include <common>\n${FRAGMENT_PARS}`, "depth fragment");
    shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <map_fragment>", map, "depth fragment");
    shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <alphatest_fragment>", alphaTest, "depth fragment");
  };
  depth.customProgramCacheKey = () => key;
  return depth;
}

/** Ties a depth material to its carrier; it is disposed with it. */
export function registerSlotDepth(carrier: THREE.Material, depth: THREE.MeshDepthMaterial): void {
  SLOT_DEPTH.set(carrier, depth);
  carrier.addEventListener("dispose", () => depth.dispose());
}

/** Gives a mesh made from a folded build its slot depth material (no-op for any other build). */
export function applySlotDepth(mesh: THREE.Mesh): void {
  const depth = slotDepthMaterialFor(mesh.material);
  if (depth) mesh.customDepthMaterial = depth;
}

/** The slot depth material a mesh drawing `material` must cast with, if any of its materials has one. */
export function slotDepthMaterialFor(material: THREE.Material | readonly THREE.Material[]): THREE.MeshDepthMaterial | undefined {
  if (!Array.isArray(material)) return SLOT_DEPTH.get(material as THREE.Material);
  for (const entry of material) {
    const depth = SLOT_DEPTH.get(entry);
    if (depth) return depth;
  }
  return undefined;
}

/** Records the carrier's extra textures (also set as `wvmMap1..3` properties, which accounting sees). */
export function registerSlotMaps(carrier: THREE.Material, maps: readonly THREE.Texture[]): void {
  SLOT_MAPS.set(carrier, maps);
  const holder = carrier as THREE.Material & Record<string, unknown>;
  maps.forEach((texture, index) => { holder[`wvmMap${index + 1}`] = texture; });
}

/** The carrier's textures besides `map`; empty for any other material. */
export function slotMapsOf(material: THREE.Material): readonly THREE.Texture[] {
  return SLOT_MAPS.get(material) ?? [];
}

/**
 * The `wvmSlot` attribute: each folded group's vertices take its slot; vertices no folded group
 * draws stay `WVM_SLOT_NONE`. Undefined when one vertex would need two slots — the build then does
 * not fold (a flat varying cannot be two values).
 */
export function buildSlotAttribute(
  vertexCount: number,
  indices: ArrayLike<number>,
  ranges: ReadonlyArray<{ start: number; count: number; slot: number }>,
): Uint8Array | undefined {
  const slots = new Uint8Array(vertexCount).fill(WVM_SLOT_NONE);
  for (const { start, count, slot } of ranges) {
    for (let at = start; at < start + count; at++) {
      const vertex = indices[at]!;
      const current = slots[vertex]!;
      if (current === WVM_SLOT_NONE) slots[vertex] = slot;
      else if (current !== slot) return undefined;
    }
  }
  return slots;
}
