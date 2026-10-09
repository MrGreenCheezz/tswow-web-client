// 6.22 / 6.16е / 6.16б (05.10-A7a-F2): how an M2 batch folds its texture stages, by the shader id
// the client resolved at load, instead of the 0/1/2 guess `ModelBuild.secondLayer` still applies to
// artifacts of the older generation.
//
// Where each piece comes from (notes under `.runtime/re-2026-10-05/A7a-F2/`, nothing copied):
//
// * The id itself — `(stage0 << 4) | stage1`, `| 8` on a sphere-mapped stage, 0x4000 for UV2,
//   0x8000 ids untouched — is resolved by the tool (`tools/m2-combiners.mjs`, Wow.exe va 0x836980)
//   and only reaches here on an extended artifact (`WvmModel.shaderIdsResolved`).
// * Which pixel program a stage pair gets is Wow.exe va 0x836600: one stage takes Opaque, Mod,
//   Decal, Add, Mod2x or Fade (6 and 7 fall to Mod); two stages take `Opaque_` or `Mod_` with
//   Opaque, Mod, Add, Mod2x, Mod2xNA or AddNA (anything else to `_Mod`), `Add_Mod`, and from a
//   Mod2x first stage `Mod_Mod2x` (second Mod) or `Mod2x_Mod2x`. Every other pair makes that
//   function fail; the client then draws `Mod_Mod` per the universal-modder note — the caller of
//   0x836600 was not opened, so that fallback is the one unverified link.
// * What each program computes is the client's own `Shaders\Pixel\arbfp1\Combiners_*.bls` (the
//   OpenGL path, readable text), read 05.10: e.g. Opaque_Mod2x is `rgb = t0·t1·d·2, a = t1.a·d.a·2`,
//   Opaque_AddNA is `rgb = t0·d + t1, a = d.a`, Add_Mod is `rgb = t1·(d + t0), a = t1.a·(d.a + t0.a)`.
// * The sphere map is `Shaders\Vertex\arbvp1\Diffuse_Env.bls`: u = normalize(view position),
//   n = normalize(view normal), r = 2n(n·u) − u, uv = 0.5 + 0.5·r.xy / |r + (0, 0, 1)| — in the
//   client's z-forward view space; three's view space looks down −z, which flips r.z below. Per
//   vertex, as there, and with no texture matrix (the program reads none). Two-stage programs read
//   UV set 0 for stage 0 and UV set 1 for stage 1 (`Diffuse_T1_T2`), whatever the coord combos say.
//
// The arithmetic runs in gamma space, as the client's does: the textures are decoded to linear by
// the sampler here, so each is taken back through the sRGB curve, folded, clamped, and returned.
// For a pure product that is the old linear product to within the curve's toe; it is the ×2, the
// ×4 and the additions that it changes — Opaque_Mod2x (4,387 batches, the most common pair) drew
// without its doubling before. On a lit material the terms the client adds after its lit colour
// (the second texture of an `Add` pair, …) go to `totalEmissiveRadiance` so three's lighting does not
// darken them; under full light the sum equals the client's.

import * as THREE from "three";
import {
  BLEND_OPAQUE, TEXTURE_TYPE_OWN, TEXTURE_WRAP_X, TEXTURE_WRAP_Y, textureUrl,
  type WvmBatch, type WvmModel, type WvmTextureTransform,
} from "./Wvm.js";

export const OP_OPAQUE = 0;
export const OP_MOD = 1;
export const OP_DECAL = 2;
export const OP_ADD = 3;
export const OP_MOD2X = 4;
export const OP_FADE = 5;
export const OP_MOD2X_NA = 6;
export const OP_ADD_NA = 7;
const STAGE_SPHERE = 0x8;
const SHADER_SPECIAL = 0x8000;

/** One resolved id, unpacked. `undefined` from `decodeShaderId` means a 0x8000 special id. */
export interface CombinerStages {
  readonly op0: number;
  readonly op1: number;
  readonly sphere0: boolean;
  readonly sphere1: boolean;
}

export function decodeShaderId(id: number): CombinerStages | undefined {
  if ((id & SHADER_SPECIAL) !== 0) return undefined;
  const stage0 = (id >> 4) & 0xf;
  const stage1 = id & 0xf;
  return {
    op0: stage0 & 7, op1: stage1 & 7,
    sphere0: (stage0 & STAGE_SPHERE) !== 0, sphere1: (stage1 & STAGE_SPHERE) !== 0,
  };
}

const SINGLE = ["Opaque", "Mod", "Decal", "Add", "Mod2x", "Fade"] as const;
const SECOND_OF_OPAQUE_OR_MOD: Record<number, string> = {
  [OP_OPAQUE]: "Opaque", [OP_ADD]: "Add", [OP_MOD2X]: "Mod2x", [OP_MOD2X_NA]: "Mod2xNA", [OP_ADD_NA]: "AddNA",
};

/**
 * The pixel program Wow.exe va 0x836600 picks, by name without the `Combiners_` prefix.
 * `fallback` is true when the client's function fails for the pair and `Mod_Mod` is drawn instead.
 */
export function combinerProgram(stages: 1 | 2, op0: number, op1: number): { name: string; fallback: boolean } {
  if (stages === 1) return { name: SINGLE[op0] ?? "Mod", fallback: false };
  if (op0 === OP_OPAQUE) return { name: `Opaque_${SECOND_OF_OPAQUE_OR_MOD[op1] ?? "Mod"}`, fallback: false };
  if (op0 === OP_MOD) {
    return { name: op1 === OP_OPAQUE ? "Mod_Opaque" : `Mod_${SECOND_OF_OPAQUE_OR_MOD[op1] ?? "Mod"}`, fallback: false };
  }
  if (op0 === OP_ADD && op1 === OP_MOD) return { name: "Add_Mod", fallback: false };
  if (op0 === OP_MOD2X && op1 === OP_MOD) return { name: "Mod_Mod2x", fallback: false };
  if (op0 === OP_MOD2X && op1 === OP_MOD2X) return { name: "Mod2x_Mod2x", fallback: false };
  return { name: "Mod_Mod", fallback: true };
}

/**
 * Each program as `lit` (multiplied by the diffuse d — what the client's lighting reaches), `add`
 * (added after it) and `alpha`, over gamma-space `d`, `t0`, `t1`. Transcribed from the arbfp1 text.
 */
const PROGRAMS: Record<string, { lit: string; add?: string; alpha: string }> = {
  Opaque: { lit: "t0.rgb * d.rgb", alpha: "d.a" },
  Mod: { lit: "t0.rgb * d.rgb", alpha: "t0.a * d.a" },
  Decal: { lit: "d.rgb * d.a", add: "t0.rgb * ( 1.0 - d.a )", alpha: "d.a" },
  Add: { lit: "d.rgb", add: "t0.rgb", alpha: "d.a + t0.a" },
  Mod2x: { lit: "t0.rgb * d.rgb * 2.0", alpha: "t0.a * d.a * 2.0" },
  Fade: { lit: "d.rgb * ( 1.0 - d.a )", add: "t0.rgb * d.a", alpha: "d.a" },
  Opaque_Opaque: { lit: "t0.rgb * t1.rgb * d.rgb", alpha: "d.a" },
  Opaque_Mod: { lit: "t0.rgb * t1.rgb * d.rgb", alpha: "t1.a * d.a" },
  Opaque_Add: { lit: "t0.rgb * d.rgb", add: "t1.rgb", alpha: "d.a + t1.a" },
  Opaque_Mod2x: { lit: "t0.rgb * t1.rgb * d.rgb * 2.0", alpha: "t1.a * d.a * 2.0" },
  Opaque_Mod2xNA: { lit: "t0.rgb * t1.rgb * d.rgb * 2.0", alpha: "d.a" },
  Opaque_AddNA: { lit: "t0.rgb * d.rgb", add: "t1.rgb", alpha: "d.a" },
  Mod_Opaque: { lit: "t0.rgb * t1.rgb * d.rgb", alpha: "t0.a * d.a" },
  Mod_Mod: { lit: "t0.rgb * t1.rgb * d.rgb", alpha: "t0.a * t1.a * d.a" },
  Mod_Add: { lit: "t0.rgb * d.rgb", add: "t1.rgb", alpha: "t0.a * d.a + t1.a" },
  Mod_Mod2x: { lit: "t0.rgb * t1.rgb * d.rgb * 2.0", alpha: "t0.a * t1.a * d.a * 2.0" },
  Mod_Mod2xNA: { lit: "t0.rgb * t1.rgb * d.rgb * 2.0", alpha: "t0.a * d.a" },
  Mod_AddNA: { lit: "t0.rgb * d.rgb", add: "t1.rgb", alpha: "t0.a * d.a" },
  Add_Mod: { lit: "t1.rgb * d.rgb", add: "t1.rgb * t0.rgb", alpha: "t1.a * ( d.a + t0.a )" },
  Mod2x_Mod2x: { lit: "t0.rgb * t1.rgb * d.rgb * 4.0", alpha: "t0.a * t1.a * d.a * 4.0" },
};

/** The structural shape of `ModelBuild`'s private `ShaderStep`. */
export interface CombinerStep {
  key: string;
  apply: (shader: { vertexShader: string; fragmentShader: string }) => void;
}

const PROJECT_VERTEX = "#include <project_vertex>";
const MAP_FRAGMENT = "#include <map_fragment>";
const ALPHAMAP_FRAGMENT = "#include <alphamap_fragment>";

/** The per-vertex sphere-map coordinates of `Diffuse_Env`, in three's view space. */
const SPHERE_VERTEX = `${PROJECT_VERTEX}
	#if defined( WVM_COMBINER_LIT ) || defined( USE_ENVMAP ) || defined( USE_SKINNING )
		vec3 wvmViewNormal = normalize( transformedNormal );
	#else
		vec3 wvmObjectNormal = normal;
		#ifdef USE_INSTANCING
			wvmObjectNormal = mat3( instanceMatrix ) * wvmObjectNormal;
		#endif
		vec3 wvmViewNormal = normalize( normalMatrix * wvmObjectNormal );
	#endif
	vec3 wvmEye = normalize( mvPosition.xyz );
	vec3 wvmReflect = 2.0 * wvmViewNormal * dot( wvmViewNormal, wvmEye ) - wvmEye;
	vWvmSphereUv = 0.5 + 0.5 * wvmReflect.xy / max( length( vec3( wvmReflect.xy, 1.0 - wvmReflect.z ) ), 1e-4 );`;

/**
 * The shader step for one resolved batch: replaces three's `map_fragment` with the client's
 * program and empties `alphamap_fragment` (the second stage rides the `alphaMap` sampler, as the
 * legacy layer did). `lit` is a MeshStandard material — its `add` terms go to emissive.
 */
export function combinerStep(stages: 1 | 2, decoded: CombinerStages, lit: boolean): CombinerStep {
  const program = combinerProgram(stages, decoded.op0, decoded.op1);
  const body = PROGRAMS[program.name] ?? PROGRAMS["Mod_Mod"]!;
  const sphere0 = decoded.sphere0;
  const sphere1 = stages === 2 && decoded.sphere1;
  const sphere = sphere0 || sphere1;
  const t0 = sphere0 ? "texture2D( map, vWvmSphereUv )" : "texture2D( map, vMapUv )";
  const t1 = sphere1 ? "texture2D( alphaMap, vWvmSphereUv )" : "texture2D( alphaMap, vAlphaMapUv )";
  const fragment = [
    `/* wvm-combiner: ${program.name}${program.fallback ? " (fallback)" : ""} */`,
    "{",
    "\tvec4 d = sRGBTransferOETF( vec4( max( diffuseColor.rgb, vec3( 0.0 ) ), diffuseColor.a ) );",
    "#ifdef USE_MAP",
    `\tvec4 t0 = sRGBTransferOETF( ${t0} );`,
    "#else",
    "\tvec4 t0 = vec4( 1.0 );",
    "#endif",
    stages === 2
      ? `#ifdef USE_ALPHAMAP\n\tvec4 t1 = sRGBTransferOETF( ${t1} );\n#else\n\tvec4 t1 = vec4( 1.0 );\n#endif`
      : "\tvec4 t1 = vec4( 1.0 );",
    `\tvec3 wvmLit = clamp( ${body.lit}, 0.0, 1.0 );`,
    `\tvec3 wvmSum = clamp( wvmLit${body.add ? ` + ${body.add}` : ""}, 0.0, 1.0 );`,
    "\tvec3 wvmLitLinear = sRGBTransferEOTF( vec4( wvmLit, 1.0 ) ).rgb;",
    lit && body.add
      ? "\tdiffuseColor.rgb = wvmLitLinear;\n\ttotalEmissiveRadiance += sRGBTransferEOTF( vec4( wvmSum, 1.0 ) ).rgb - wvmLitLinear;"
      : "\tdiffuseColor.rgb = sRGBTransferEOTF( vec4( wvmSum, 1.0 ) ).rgb;",
    `\tdiffuseColor.a = clamp( ${body.alpha}, 0.0, 1.0 );`,
    "}",
  ].join("\n");
  const key = `wvm-comb1-${program.name}-${sphere0 ? 1 : 0}${sphere1 ? 1 : 0}${lit && body.add ? "-e" : ""}`;
  return {
    key,
    apply: (shader) => {
      if (sphere) {
        shader.vertexShader = `${lit ? "#define WVM_COMBINER_LIT\n" : ""}varying vec2 vWvmSphereUv;\n`
          + shader.vertexShader.replace(PROJECT_VERTEX, SPHERE_VERTEX);
        shader.fragmentShader = `varying vec2 vWvmSphereUv;\n${shader.fragmentShader}`;
      }
      shader.fragmentShader = shader.fragmentShader
        .replace(MAP_FRAGMENT, fragment)
        .replace(ALPHAMAP_FRAGMENT, "");
    },
  };
}

/** What `ModelBuild` lends this module; kept structural so nothing here imports `ModelBuild`. */
export interface CombinerOptions {
  baseUrl: string;
  loadTexture: (url: string) => THREE.Texture;
  anisotropy?: number;
  privateLoadedTextureViews?: boolean;
  privateView: (texture: THREE.Texture) => THREE.Texture;
  /** Whether the batch's own vertices carry a second UV set that is not all zero. */
  authoredSecondUvSet: () => boolean;
}

/**
 * The resolved path for one batch: `undefined` when the batch keeps the legacy reading (a 0x8000
 * special id, or an artifact without resolved ids); otherwise the step to install — absent when
 * three's own `Mod` chunk already is the client's program — and the second stage's texture.
 */
export function resolvedCombiner(
  model: WvmModel, batch: WvmBatch, lit: boolean, options: CombinerOptions,
): { step?: CombinerStep; texture?: THREE.Texture } | undefined {
  if (model.shaderIdsResolved !== true) return undefined;
  const decoded = decodeShaderId(batch.shaderId);
  if (!decoded) return undefined;
  const texture = secondStageTexture(model, batch, decoded.sphere1, options);
  if (!texture) {
    // One stage — or a second stage this build cannot draw, folded as the first stage alone.
    const op = decoded.op0;
    const plainMod = op === OP_MOD || op === OP_MOD2X_NA || op === OP_ADD_NA
      || (op === OP_OPAQUE && batch.blendMode === BLEND_OPAQUE);
    if (plainMod && !decoded.sphere0) return {};
    return { step: combinerStep(1, decoded, lit) };
  }
  return { step: combinerStep(2, decoded, lit), texture };
}

function secondStageTexture(
  model: WvmModel, batch: WvmBatch, sphere: boolean, options: CombinerOptions,
): THREE.Texture | undefined {
  const index = batch.textures[1] ?? -1;
  if (index < 0) return undefined;
  // A non-sphere second stage reads UV set 1 (`Diffuse_T1_T2`); one that is all zero would paint the
  // corner texel over the batch, which is the case the legacy path also turns away.
  if (!sphere && !options.authoredSecondUvSet()) return undefined;
  const slot = model.textures[index];
  if (!slot || slot.type !== TEXTURE_TYPE_OWN || !slot.path) return undefined;
  const loaded = options.loadTexture(textureUrl(options.baseUrl, slot.path));
  const texture = options.privateLoadedTextureViews === true ? loaded : options.privateView(loaded);
  texture.wrapS = (slot.flags & TEXTURE_WRAP_X) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = (slot.flags & TEXTURE_WRAP_Y) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.anisotropy = options.anisotropy ?? 1;
  texture.channel = 1;
  // 6.16б: a second stage that names its own transform has its matrix written per frame.
  if (!sphere && secondUnitTransform(model, batch)) texture.matrixAutoUpdate = false;
  return texture;
}

/**
 * 6.16б: the `M2TextureTransform` the second stage's UVs run through, when it has one and is not a
 * sphere-map stage (`Diffuse_Env` reads no texture matrix). The 05.10 census: 687 two-unit batches
 * in 220 models name one; only the turn about Z is applied, as for the first unit.
 */
export function secondUnitTransform(model: WvmModel, batch: WvmBatch): WvmTextureTransform | undefined {
  if (model.shaderIdsResolved !== true) return undefined;
  const decoded = decodeShaderId(batch.shaderId);
  if (!decoded || decoded.sphere1) return undefined;
  const index = batch.textureTransform2 ?? -1;
  return index >= 0 ? model.textureTransforms[index] : undefined;
}
