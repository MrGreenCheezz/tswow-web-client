import * as THREE from "three";
import type { IUniform, WebGLProgramParametersWithUniforms, WebGLRenderer } from "three";
import {
  BLEND_ALPHA_KEY,
  MATERIAL_NO_DEPTH_TEST,
  MATERIAL_NO_DEPTH_WRITE,
  type WvmBatch,
  type WvmModel,
} from "./Wvm.js";

/** The one clock shared by every installed wind material. The renderer updates `.value` once/frame. */
export const VEGETATION_WIND_TIME: IUniform<number> = { value: 0 };
export const VEGETATION_WIND_MARKER = "vegetation-wind-v1";
export const VEGETATION_WIND_TIME_UNIFORM = "uVegetationWindTime";
export const VEGETATION_WIND_MAX_AMPLITUDE = 0.35;
/** x gets full amplitude and local y half; culling must cover their simultaneous radial reach. */
export const VEGETATION_WIND_CULL_PADDING = Math.hypot(
  VEGETATION_WIND_MAX_AMPLITUDE, VEGETATION_WIND_MAX_AMPLITUDE * 0.5,
);

const BEGIN_VERTEX = "#include <begin_vertex>";
const WIND_POSITIVE_TOKENS = new Set([
  "branch", "branches", "bush", "bushes", "canopy", "cactus", "catus", "coral", "fern",
  "flower", "flowers", "foliage", "frond", "fronds", "grass", "herb", "herbs", "kelp", "leaf",
  "leaves", "moss", "needle", "needles", "palm", "plant", "plants", "reed", "reeds", "rush",
  "rushes", "sapling", "saplings", "seaweed", "shrub", "shrubs", "tree", "trees", "vine",
  "underbrush", "vines", "vineyard", "weed", "weeds",
]);
const WIND_REJECTED_TOKENS = new Set([
  "armor", "bark", "banner", "barrier", "box", "cage", "cloth", "curtain",
  "facade", "fur", "hair", "handle", "hollow", "house", "hut", "huts", "ice", "lamp",
  "log", "pole", "rock", "roof", "root", "roots", "rope", "sack", "sign", "skull", "smoke",
  "snow", "spell", "stand", "stick", "sticks", "stone", "stump", "trunk", "wall",
  "weapon", "web",
]);
const WIND_BOTANICAL_DIRECTORIES = new Set([
  "bush", "bushes", "coral", "ferns", "flowers", "foliage", "grass", "plants", "seaplants",
  "shrubs", "trees", "vines", "vineyard",
]);
const WIND_RIGID_MODEL_DIRECTORIES = new Set([
  "animalheads", "ballandhoop", "barbershop", "sacks", "treehuts",
]);
// Unlit alpha cards are still authored solid foliage (cattails, magical leaves and Felweed in the
// stock corpus) and vertex deformation is independent of their lighting branch. Only materials
// that opt out of depth are effect/overlay cards unsafe to classify as world vegetation.
const WIND_REJECTED_FLAGS = MATERIAL_NO_DEPTH_TEST | MATERIAL_NO_DEPTH_WRITE;

/**
 * A material-independent profile. `baseZ` and `height` are in the WVM model's local z-up frame.
 * The profile is intentionally numeric and finite: it is embedded into GLSL as constants so a
 * bad caller cannot turn a shader replacement into source text.
 */
export interface VegetationWindProfile {
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
  readonly baseZ: number;
  readonly height: number;
}

/** Bounds plus stable model identity produce visibly distinct but deterministic plant motion. */
export function vegetationWindProfile(
  bounds: Pick<WvmModel, "bounds">["bounds"], modelPath = "",
): VegetationWindProfile | undefined {
  const baseZ = bounds.min[2];
  const topZ = bounds.max[2];
  const height = topZ - baseZ;
  if (!Number.isFinite(baseZ) || !Number.isFinite(height) || height <= 1e-4) return undefined;
  const lowerPath = modelPath.toLowerCase();
  const familyFrequency = lowerPath.length === 0
    ? 1.25
    : /(grass|reed|rush|flower|weed|herb)/.test(lowerPath)
      ? 1.9
      : /(tree|canopy|sapling)/.test(lowerPath)
        ? 0.92
        : 1.42;
  const identity = modelPath ? stablePathUnit(modelPath) : 0;
  return Object.freeze({
    amplitude: Math.min(VEGETATION_WIND_MAX_AMPLITUDE, Math.max(0.012, height * 0.025)),
    frequency: modelPath ? familyFrequency * (0.92 + identity * 0.16) : familyFrequency,
    phase: identity * Math.PI * 2,
    baseZ,
    height,
  });
}

interface SafeWindProfile extends VegetationWindProfile {
  readonly inverseHeight: number;
}

/**
 * Whether a resolved first texture is a deliberately narrow botanical name.
 *
 * Structural words still veto a match (`TreeBark`, `OakTrunk`, mixed rock atlases). Botanical
 * words include the ordinary tree/bush/shrub families because the alpha-key batch gate below
 * already excludes their opaque trunks. The caller passes the resolved MPQ path before
 * `textureUrl` adds the gateway URL.
 */
export function isBotanicalTexturePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || !/\.blp$/i.test(path)) return false;
  const basenameTokens = botanicalBasenameTokens(path);
  if (basenameTokens.length === 0) return false;
  // Exact camel/separator tokens avoid accidental English substrings (`STREET` is not `tree`,
  // `FREEDOM` is not `reed`). The suffix lane is for compact uppercase MPQ names such as
  // `DUSKWOODTREECANOPY11`, where authored word boundaries no longer exist.
  if (hasRejectedBotanicalStem(basenameTokens)) return false;
  return hasBotanicalStem(basenameTokens);
}

function isBotanicalModelPath(path: string): boolean {
  if (!/\.m2$/i.test(path)) return false;
  const basename = botanicalBasenameTokens(path);
  if (hasRejectedBotanicalStem(basename)) return false;
  if (hasBotanicalStem(basename)) return true;
  const segments = path.split(/[\\/]/).slice(0, -1)
    .flatMap((segment) => botanicalTokens(segment));
  return segments.some((token) => WIND_BOTANICAL_DIRECTORIES.has(token));
}

function isRigidWindModelPath(path: string): boolean {
  if (!/\.m2$/i.test(path)) return false;
  const directories = path.split(/[\\/]/).slice(0, -1)
    .map((segment) => segment.toLowerCase().replace(/[^a-z]+/g, ""));
  if (directories.some((segment) => WIND_RIGID_MODEL_DIRECTORIES.has(segment))) return true;
  const basename = botanicalBasenameTokens(path);
  return basename.includes("stand") && (basename.includes("flower") || basename.includes("plant"));
}

/**
 * Terrain detail doodads use terse zone-family names and a shared atlas whose filename often says
 * only `Details` (and sometimes also `Rock`). The model identity is the authored semantic here:
 * `DskGra03`, `WesGra02`, `CSGras01`, `CSShrub01`, and their peers are alpha-card ground cover just
 * like the previously special-cased `ElwGra01-08` family. Keeping the exact NoDXT/Detail directory
 * and the terminal family+two-digit shape excludes rocks and ordinary props.
 */
function isAuthoredGroundCoverModelPath(path: string): boolean {
  return /^world[\\/]nodxt[\\/]detail[\\/][^\\/]*(?:gra|gras|grass|shrub)\d{2}\.m2$/i.test(path);
}

function hasBotanicalStem(tokens: readonly string[]): boolean {
  if (tokens.some((token) => WIND_POSITIVE_TOKENS.has(token))) return true;
  return tokens.some((token) =>
    /(?:branches?|bush(?:es)?|canopy|cactus|catus|coral|fern|flowers?|foliage|fronds?|grass|herbs?|kelp|leaf|leaves|moss|needles?|palm|plants?[a-z]?|reeds?|saplings?|seaweed|shrubs?|trees?|underbrush|vines?|vineyard|weeds?)$/.test(token)
      || (/rush(?:es)?$/.test(token) && !/brush(?:es)?$/.test(token)));
}

function hasRejectedBotanicalStem(tokens: readonly string[]): boolean {
  if (tokens.some((token) => WIND_REJECTED_TOKENS.has(token))) return true;
  const compact = tokens.join("");
  // Strong structural suffixes also cover all-uppercase compounds (`TREEBARK`, `TREEWEB`). `wood`
  // is terminal only: it is rigid in `TreeWood`, but part of a zone name in `DuskwoodTreeCanopy`.
  return /(?:armor|bark|banner|barrier|cage|cloth|curtain|hollow|rock|roof|roots?|rope|skull|sticks?|stone|stump|trunk|wall|weapon|web)/.test(compact)
    || /(?:box|facade|handle|house|huts?|log|pole|sack|smoke|snow|stand)(?:skin|copy)?$/.test(compact)
    || compact.startsWith("sack")
    || compact.endsWith("wood");
}

function botanicalTokens(path: string): string[] {
  return path.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function botanicalBasenameTokens(path: string): string[] {
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return botanicalTokens(path.slice(separator + 1).replace(/\.(?:blp|m2)$/i, ""));
}

/** Stable [0, 1) identity; no frame/load-order randomness enters a material cache key. */
function stablePathUnit(path: string): number {
  let hash = 0x811c9dc5;
  for (const code of path.toLowerCase()) {
    hash ^= code.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * Conservative batch gate for a world build.
 *
 * `texturePath` is the already-resolved first (diffuse) WVM texture. The model is deliberately
 * checked for one visible batch per submesh: buildModel draws an entire submesh for every batch,
 * so winding one of two batches would leave a second static draw of the same triangles behind.
 * `modelPath` also recovers safe alpha-card foliage whose generic texture has no botanical word;
 * a structural texture still vetoes it. The exact Elwynn ground-cover family remains the one mixed
 * rock/flower atlas exception.
 */
export function isVegetationWindBatch(
  model: Pick<WvmModel, "batches" | "submeshes">,
  batchIndex: number,
  texturePath: string,
  modelPath?: string,
): boolean {
  if (!Number.isInteger(batchIndex) || batchIndex < 0) return false;
  const batch = model.batches[batchIndex];
  if (!batch || !isSafeWindBatch(batch)) return false;
  // Some rigid props reuse outdoor foliage textures verbatim (a stuffed bear uses a shrub skin;
  // herb sacks use Stranglekelp). Model-family evidence must veto those before texture evidence can
  // admit them, while mixed scenery such as vine-covered bridges remains eligible per submesh.
  if (isRigidWindModelPath(modelPath ?? "")) return false;
  // Ground-cover cards use shared zone atlases whose names often contain no botanical word (or
  // contain `rock`). Their exact authored model family supplies the missing semantic while the
  // alpha-key/single-submesh gates below remain unchanged.
  const isAuthoredGroundCover = isAuthoredGroundCoverModelPath(modelPath ?? "");
  const textureTokens = botanicalBasenameTokens(texturePath);
  const hardRejectedTexture = hasRejectedBotanicalStem(textureTokens);
  const namedModelFoliage = isBotanicalModelPath(modelPath ?? "") && !hardRejectedTexture;
  if (!isBotanicalTexturePath(texturePath) && !namedModelFoliage && !isAuthoredGroundCover) return false;
  const submesh = model.submeshes[batch.submesh];
  if (!submesh || submesh.indexCount <= 0) return false;

  let sameSubmesh = 0;
  for (const candidate of model.batches) {
    const candidateSubmesh = model.submeshes[candidate.submesh];
    if (candidate.submesh === batch.submesh && candidateSubmesh && candidateSubmesh.indexCount > 0) {
      sameSubmesh++;
    }
  }
  return sameSubmesh === 1;
}

function isSafeWindBatch(batch: WvmBatch): boolean {
  return batch.blendMode === BLEND_ALPHA_KEY
    && (batch.materialFlags & WIND_REJECTED_FLAGS) === 0;
}

/** A stable cache-key fragment for the exact shader constants installed by a profile. */
export function vegetationWindProfileKey(profile: VegetationWindProfile): string | undefined {
  const safe = safeProfile(profile);
  if (!safe) return undefined;
  return `${VEGETATION_WIND_MARKER}:${numberText(safe.amplitude)}:${numberText(safe.frequency)}:`
    + `${numberText(safe.phase)}:${numberText(safe.baseZ)}:${numberText(safe.height)}`;
}

/**
 * Installs a vertex-only wind step while preserving an existing onBeforeCompile chain.
 *
 * `undefined` is OFF and is a strict no-op: no property, hook, key or uniform is touched. This
 * function must only be called on a separately cached vegetation build; it never clones or mutates
 * another material's shared state.
 */
export function installVegetationWind(
  material: THREE.Material,
  profile: VegetationWindProfile | undefined,
): void {
  if (profile === undefined) return;
  const safe = safeProfile(profile);
  if (!safe) return;

  const installed = installedProfiles.get(material);
  const profileKey = vegetationWindProfileKey(safe)!;
  if (installed !== undefined) {
    if (installed !== profileKey) throw new Error("Vegetation wind profile already installed");
    return;
  }

  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
    previousCompile.call(material, shader, renderer);
    if (!shader.vertexShader.includes(BEGIN_VERTEX)) {
      throw new Error("Vegetation wind requires the three.js <begin_vertex> shader chunk");
    }
    shader.uniforms[VEGETATION_WIND_TIME_UNIFORM] = VEGETATION_WIND_TIME;
    shader.vertexShader = `uniform float ${VEGETATION_WIND_TIME_UNIFORM};\n`
      + shader.vertexShader.replace(BEGIN_VERTEX, `${BEGIN_VERTEX}\n${windBody(safe)}`);
  };
  material.customProgramCacheKey = () => `${previousKey}|${profileKey}`;
  installedProfiles.set(material, profileKey);
}

const installedProfiles = new WeakMap<THREE.Material, string>();

function windBody(profile: SafeWindProfile): string {
  const amplitude = numberText(profile.amplitude);
  const crossFrequency = numberText(profile.frequency * 0.73);
  const frequency = numberText(profile.frequency);
  const phase = numberText(profile.phase);
  const baseZ = numberText(profile.baseZ);
  const inverseHeight = numberText(profile.inverseHeight);
  return [
    `// ${VEGETATION_WIND_MARKER}`,
    "vec3 vegetationWindWorldOrigin = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;",
    "#ifdef USE_INSTANCING",
    "vegetationWindWorldOrigin = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;",
    "#endif",
    `float vegetationWindAnchor = clamp( ( position.z - ${baseZ} ) * ${inverseHeight}, 0.0, 1.0 );`,
    "float vegetationWindBend = vegetationWindAnchor * vegetationWindAnchor;",
    `float vegetationWindPhase = dot( vegetationWindWorldOrigin.xz, vec2( 0.071, 0.113 ) ) + ${phase};`,
    `float vegetationWindWave = sin( ${VEGETATION_WIND_TIME_UNIFORM} * ${frequency} + vegetationWindPhase );`,
    `float vegetationWindCross = sin( ${VEGETATION_WIND_TIME_UNIFORM} * ${crossFrequency} + vegetationWindPhase * 1.37 );`,
    `transformed.x += ${amplitude} * vegetationWindBend * vegetationWindWave;`,
    // M2 is z-up before the renderer's model-to-scene rotation, so both horizontal sway axes are
    // local x/y. Moving local z here would visibly stretch the tree or grass vertically.
    `transformed.y += ${amplitude} * 0.5 * vegetationWindBend * vegetationWindCross;`,
  ].join("\n");
}

function safeProfile(profile: VegetationWindProfile): SafeWindProfile | undefined {
  if (!profile || !Number.isFinite(profile.amplitude) || profile.amplitude <= 0 || profile.amplitude > 100) {
    return undefined;
  }
  if (!Number.isFinite(profile.frequency) || profile.frequency <= 0 || profile.frequency > 100) {
    return undefined;
  }
  if (!Number.isFinite(profile.phase) || Math.abs(profile.phase) > 1_000_000) return undefined;
  if (!Number.isFinite(profile.baseZ) || Math.abs(profile.baseZ) > 100_000) return undefined;
  if (!Number.isFinite(profile.height) || profile.height <= 0 || profile.height > 100_000) return undefined;
  return { ...profile, inverseHeight: 1 / profile.height };
}

function numberText(value: number): string {
  const rounded = Number(value.toFixed(8));
  const text = rounded.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" || text === "0" ? "0.0" : text.includes(".") ? text : `${text}.0`;
}
