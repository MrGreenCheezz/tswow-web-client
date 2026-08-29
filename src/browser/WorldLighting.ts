import * as THREE from "three";

/** A display-space light multiplier, as the bands in Light.dbc store it. */
export interface WorldLightColour {
  r: number;
  g: number;
  b: number;
}

export interface WorldLightPair {
  ambient: WorldLightColour;
  diffuse: WorldLightColour;
}

/** Shared by every authored outdoor material; changing a value updates all compiled programs. */
export interface WorldLightUniforms {
  wowSunDirection: { value: THREE.Vector3 };
  wowDiffuse: { value: THREE.Color };
  wowAmbient: { value: THREE.Color };
  /** Reversible ALU-only warm-key/cool-fill grade; zero is the exact authored equation. */
  wowImmersiveStrength: { value: number };
}

/**
 * Bring the brightest channel of ambient + diffuse down to one without changing their ratio.
 *
 * Light.dbc stores multipliers, not colours to decode. Scaling both terms by one number is the
 * reference client's answer to the 82% of profiles whose noon sum would otherwise clip one
 * channel before another and change hue.
 */
export function applyLightHeadroom(
  ambient: Readonly<WorldLightColour>,
  diffuse: Readonly<WorldLightColour>,
): WorldLightPair {
  const peak = Math.max(
    ambient.r + diffuse.r,
    ambient.g + diffuse.g,
    ambient.b + diffuse.b,
  );
  const scale = peak > 1 ? 1 / peak : 1;
  return {
    ambient: { r: ambient.r * scale, g: ambient.g * scale, b: ambient.b * scale },
    diffuse: { r: diffuse.r * scale, g: diffuse.g * scale, b: diffuse.b * scale },
  };
}

/**
 * CPU twin of the outdoor shader, useful both for fallback light and deterministic acceptance.
 *
 * `nightness` is for the reference fallback used when no authored light volume exists. A sampled
 * Light.dbc profile has already followed its own bands through the night and must pass zero here,
 * otherwise midnight is darkened twice.
 */
export function worldLightFactor(
  ambient: Readonly<WorldLightColour>,
  diffuse: Readonly<WorldLightColour>,
  ndotl: number,
  shadow: number,
  nightness: number,
  kind: WorldLightKind,
): WorldLightColour {
  const night = Math.max(0, Math.min(1, nightness));
  const ambientScale = 0.3 + 0.7 * (1 - night);
  const diffuseScale = 0.2 + 0.8 * (1 - night);
  // wowee applies the procedural fallback's night tint before headroom. Authored Light.dbc
  // samples pass nightness=0 and therefore keep their own already-interpolated night bands.
  const scaled = applyLightHeadroom(
    {
      r: ambient.r * ambientScale,
      g: ambient.g * ambientScale,
      b: ambient.b * ambientScale + night * 0.1,
    },
    {
      r: diffuse.r * diffuseScale,
      g: diffuse.g * diffuseScale,
      b: diffuse.b * diffuseScale,
    },
  );
  const nl = kind === "terrain"
    ? Math.max(Math.abs(ndotl), 0.2)
    : kind === "foliage" ? Math.abs(ndotl) : Math.max(ndotl, 0);
  const direct = nl * Math.max(0, shadow);
  return {
    r: scaled.ambient.r + scaled.diffuse.r * direct,
    g: scaled.ambient.g + scaled.diffuse.g * direct,
    b: scaled.ambient.b + scaled.diffuse.b * direct,
  };
}

export function createWorldLightUniforms(
  ambient: Readonly<WorldLightColour> = { r: 0.55, g: 0.58, b: 0.62 },
  diffuse: Readonly<WorldLightColour> = { r: 0.45, g: 0.42, b: 0.38 },
): WorldLightUniforms {
  const uniforms: WorldLightUniforms = {
    wowSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    wowDiffuse: { value: new THREE.Color() },
    wowAmbient: { value: new THREE.Color() },
    wowImmersiveStrength: { value: 0 },
  };
  setWorldLightUniforms(uniforms, ambient, diffuse);
  return uniforms;
}

/** Update the shared grade without recompiling any material program. */
export function setWorldLightImmersiveStrength(uniforms: WorldLightUniforms, strength: number): number {
  const bounded = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  uniforms.wowImmersiveStrength.value = bounded;
  return bounded;
}

/** Update the shared values without replacing the uniform objects already bound to programs. */
export function setWorldLightUniforms(
  uniforms: WorldLightUniforms,
  ambient: Readonly<WorldLightColour>,
  diffuse: Readonly<WorldLightColour>,
): WorldLightPair {
  const scaled = applyLightHeadroom(ambient, diffuse);
  // These are display-space multipliers. Marking the inputs as linear is how Color.setRGB keeps
  // their numeric values intact; the shader converts the final multiplier with pow(..., 2.2).
  uniforms.wowAmbient.value.setRGB(
    scaled.ambient.r, scaled.ambient.g, scaled.ambient.b, THREE.LinearSRGBColorSpace,
  );
  uniforms.wowDiffuse.value.setRGB(
    scaled.diffuse.r, scaled.diffuse.g, scaled.diffuse.b, THREE.LinearSRGBColorSpace,
  );
  return scaled;
}

export const WORLD_LIGHT_PARS = /* glsl */ `
uniform vec3 wowSunDirection;
uniform vec3 wowDiffuse;
uniform vec3 wowAmbient;
uniform float wowImmersiveStrength;
`;

/** The three includes replaced together, avoiding three's first BRDF and shadow lookup entirely. */
export const WORLD_LIGHT_TARGET = [
  "#include <lights_fragment_begin>",
  "#include <lights_fragment_maps>",
  "#include <lights_fragment_end>",
].join("\n\t");

/** Replaces three's physically-correct light integration after maps and normals have been read. */
export const WORLD_LIGHT_BODY = /* glsl */ `
vec3 wowViewSunDirection = normalize( ( viewMatrix * vec4( wowSunDirection, 0.0 ) ).xyz );
float wowDot = dot( normalize( normal ), wowViewSunDirection );
#if defined( WOW_LIGHT_TERRAIN )
  float wowNL = max( abs( wowDot ), 0.2 );
#elif defined( WOW_LIGHT_FOLIAGE )
  float wowNL = abs( wowDot );
#else
  float wowNL = max( wowDot, 0.0 );
#endif
float wowShadow = 1.0;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if ( receiveShadow ) {
    wowShadow = getShadow(
      directionalShadowMap[ 0 ],
      directionalLightShadows[ 0 ].shadowMapSize,
      directionalLightShadows[ 0 ].shadowIntensity,
      directionalLightShadows[ 0 ].shadowBias,
      directionalLightShadows[ 0 ].shadowRadius,
      vDirectionalShadowCoord[ 0 ]
    );
  }
#endif
vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );

// A single-shader cinematic separation: cool skylight in shade, a restrained warm key on the
// sunward side and a view-dependent edge which keeps dark silhouettes readable. It deliberately
// owns no texture, render target, light or extra pass. The uniform branch is coherent for the
// whole draw and skips the extra rim/fill/key ALU at quality zero instead of merely mixing it away.
vec3 wowLight = wowAuthoredLight;
if ( wowImmersiveStrength > 0.0001 ) {
  float wowWrappedKey = clamp( ( wowDot + 0.20 ) / 1.20, 0.0, 1.0 );
  float wowViewFacing = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
  float wowRim = pow( 1.0 - wowViewFacing, 3.0 );
  vec3 wowCoolFill = wowAmbient * vec3( 0.86, 0.95, 1.12 )
    * ( 1.0 + 0.16 * ( 1.0 - wowNL ) );
  vec3 wowWarmKey = wowDiffuse * vec3( 1.10, 1.02, 0.88 ) * ( wowWrappedKey * wowShadow );
  vec3 wowImmersiveLight = wowCoolFill + wowWarmKey
    + vec3( 0.07, 0.11, 0.18 ) * wowRim * ( 0.35 + 0.65 * ( 1.0 - wowShadow ) );
  #if defined( WOW_LIGHT_TERRAIN )
    float wowImmersiveSurfaceStrength = wowImmersiveStrength * 0.30;
  #elif defined( WOW_LIGHT_FOLIAGE )
    float wowImmersiveSurfaceStrength = wowImmersiveStrength * 0.50;
  #else
    float wowImmersiveSurfaceStrength = wowImmersiveStrength;
  #endif
  wowLight = mix( wowAuthoredLight, min( wowImmersiveLight, vec3( 1.15 ) ), wowImmersiveSurfaceStrength );
}
reflectedLight.directDiffuse = diffuseColor.rgb * pow( wowLight, vec3( 2.2 ) );
reflectedLight.indirectDiffuse = vec3( 0.0 );
reflectedLight.directSpecular = vec3( 0.0 );
reflectedLight.indirectSpecular = vec3( 0.0 );
`;

interface WorldLightBinding {
  readonly uniforms: WorldLightUniforms;
  readonly kind: WorldLightKind;
  /** Hook and cache key that existed before the outer world-light wrapper was installed. */
  readonly previousCompile: THREE.Material["onBeforeCompile"];
  readonly previousKey: string;
}

const WORLD_LIGHT_BINDINGS = new WeakMap<THREE.Material, WorldLightBinding>();
const WORLD_LIGHT_KEY = "world-light-r185-v2";

export type WorldLightKind = "surface" | "terrain" | "foliage";
export type WorldLitMaterial = THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;

/**
 * Clone a material shell for a portrait without importing world-only shader state.
 *
 * Three.js Material.clone() deliberately resets `onBeforeCompile` and
 * `customProgramCacheKey`, which is unsafe for model materials: the build may have an authored
 * second-layer/fog chain, and `applyWorldLight` adds one outer wrapper around that chain. For a
 * world-lit source restore the hook/key captured before that wrapper; for every other source carry
 * the current hook/key through unchanged. Maps and all ordinary material flags remain shared/copied
 * by Material.clone(), while the returned shell is owned by its caller and has no world binding.
 */
export function cloneMaterialForPortrait(material: THREE.Material): THREE.Material {
  const binding = WORLD_LIGHT_BINDINGS.get(material);
  const previousCompile = binding?.previousCompile ?? material.onBeforeCompile;
  const previousKey = binding?.previousKey ?? material.customProgramCacheKey();
  const clone = material.clone();
  clone.onBeforeCompile = previousCompile;
  clone.customProgramCacheKey = () => previousKey;
  return clone;
}

/**
 * Add the authored world-light equation after every hook already installed on the material.
 *
 * M2 can already carry two texture/fog substitutions and terrain has its splat substitution. The
 * previous handler and cache key are therefore part of this handler rather than overwritten.
 */
export function applyWorldLight(
  material: WorldLitMaterial,
  uniforms: WorldLightUniforms,
  kind: WorldLightKind,
): void {
  const existing = WORLD_LIGHT_BINDINGS.get(material);
  if (existing) {
    if (existing.uniforms !== uniforms || existing.kind !== kind) {
      throw new Error("World light material was rebound with conflicting uniforms or surface mode");
    }
    return;
  }

  const previousCompile = material.onBeforeCompile;
  // Evaluate before replacing onBeforeCompile. Material's default key is the handler's source,
  // and evaluating it afterwards would describe this wrapper rather than the hook it preserves.
  const pristine = previousCompile === THREE.Material.prototype.onBeforeCompile
    && material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
  const previousKey = pristine ? "" : material.customProgramCacheKey();
  const binding: WorldLightBinding = {
    uniforms,
    kind,
    previousCompile,
    previousKey,
  };
  WORLD_LIGHT_BINDINGS.set(material, binding);

  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.wowSunDirection = binding.uniforms.wowSunDirection;
    shader.uniforms.wowDiffuse = binding.uniforms.wowDiffuse;
    shader.uniforms.wowAmbient = binding.uniforms.wowAmbient;
    shader.uniforms.wowImmersiveStrength = binding.uniforms.wowImmersiveStrength;
    const unindentedTarget = WORLD_LIGHT_TARGET.replaceAll("\n\t", "\n");
    const target = shader.fragmentShader.includes(WORLD_LIGHT_TARGET)
      ? WORLD_LIGHT_TARGET
      // Three's stock shaders indent these directives with one tab. A prior hook is allowed to
      // reformat whitespace, so accept the unindented form too while still requiring all three.
      : unindentedTarget;
    const occurrences = shader.fragmentShader.split(target).length - 1;
    if (occurrences !== 1) {
      throw new Error(`World light expected one three.js light integration block, found ${occurrences}`);
    }
    const define = binding.kind === "terrain"
      ? "#define WOW_LIGHT_TERRAIN\n"
      : binding.kind === "foliage" ? "#define WOW_LIGHT_FOLIAGE\n" : "";
    shader.fragmentShader = `${define}${WORLD_LIGHT_PARS}\n${shader.fragmentShader}`
      .replace(target, WORLD_LIGHT_BODY);
  };
  material.customProgramCacheKey = () => [
    previousKey,
    `${WORLD_LIGHT_KEY}:${binding.kind}`,
  ].filter(Boolean).join("|");
  material.needsUpdate = true;
}
