/**
 * 25.10 (6.27 indoors): lamps — the living spells' lights (`SpellLights.ts`) and every other entry of
 * the forward local-light set — on the surfaces that do not take the world light: a WMO room's inside
 * (MeshBasic × its baked MOCV, `WorldRenderer3D` `#wmoRunMaterial`) and a room doodad lit by its MODD
 * colour (`ModelPlacementTint.ts`). Outdoors those lamps are the world light's fixture loop
 * (`WORLD_LIGHT_BODY`); in here they are the same loop body (`LIGHT_LAMPS_GLSL`, cut from it), added over
 * the surface's own light, so a fireball in Gundrak lights the walls and the statues it passes.
 *
 * The term is compiled into those programs only while lamps can light anything at all: an enhanced
 * level with a local-light budget (`indoorLampsWanted`). On the faithful levels the programs and their
 * keys are exactly the ones they were; switching the level re-keys the tracked materials once.
 */
import * as THREE from "three";
import { LIGHT_LAMPS_GLSL, LIGHT_POOL_DARKNESS_GLSL, LIGHT_POOL_LAMP_GLSL } from "./LightPoolGlsl.js";
import { WORLD_LIGHT_PARS, type WorldLightUniforms } from "./WorldLighting.js";

/** Appended to a program's key while the term is compiled in. */
export const INDOOR_LAMPS_KEY = "indoor-lamps-v1";

type Shader = Parameters<THREE.Material["onBeforeCompile"]>[0];

interface IndoorLampState {
  enabled: boolean;
  readonly materials: Set<THREE.Material>;
}

const STATES = new WeakMap<WorldLightUniforms, IndoorLampState>();
const ENABLED = new WeakMap<THREE.Material, () => boolean>();

function state(uniforms: WorldLightUniforms): IndoorLampState {
  let found = STATES.get(uniforms);
  if (!found) {
    found = { enabled: false, materials: new Set() };
    STATES.set(uniforms, found);
  }
  return found;
}

/** Whether a lighting profile lights anything with lamps: an immersive grade and a local-light budget. */
export function indoorLampsWanted(profile: { readonly localLights: number; readonly immersiveStrength: number }): boolean {
  return profile.localLights > 0 && profile.immersiveStrength > 0;
}

/** Turns the term on or off for every material bound to `uniforms`; returns how many programs re-key. */
export function setIndoorLampsEnabled(uniforms: WorldLightUniforms, enabled: boolean): number {
  const current = state(uniforms);
  if (current.enabled === enabled) return 0;
  current.enabled = enabled;
  for (const material of current.materials) material.needsUpdate = true;
  return current.materials.size;
}

export function indoorLampsEnabled(uniforms: WorldLightUniforms): boolean {
  return STATES.get(uniforms)?.enabled === true;
}

/** Whether `material` compiles the term now (tests and diagnostics). */
export function indoorLampsDrawing(material: THREE.Material): boolean {
  return ENABLED.get(material)?.() === true;
}

const LAMP_UNIFORMS = [
  "wowAmbient", "wowDiffuse", "wowSunDirection", "wowImmersiveStrength", "wowDaylight", "wowRimStrength",
  "wowHighSunKey", "wowLocalLightCount", "wowLocalLightPosition", "wowLocalLightColour", "wowLocalLightPool",
  "wowShadowAlpha", "wowLampIndoor",
] as const satisfies readonly (keyof WorldLightUniforms)[];

/** The declarations and functions the term needs, ahead of a fragment shader. */
function declareLamps(shader: Shader, uniforms: WorldLightUniforms): void {
  for (const name of LAMP_UNIFORMS) shader.uniforms[name] = uniforms[name];
  shader.fragmentShader = `${WORLD_LIGHT_PARS}\n${LIGHT_POOL_LAMP_GLSL}\n${LIGHT_POOL_DARKNESS_GLSL}\n${LIGHT_LAMPS_GLSL}\n${shader.fragmentShader}`;
}

/** Wraps `material`'s hook and key: `inject` runs after the hooks already there, only while enabled. */
function wrap(material: THREE.Material, uniforms: WorldLightUniforms, inject: (shader: Shader) => void): void {
  if (ENABLED.has(material)) return;
  const current = state(uniforms);
  const previousCompile = material.onBeforeCompile;
  const pristine = previousCompile === THREE.Material.prototype.onBeforeCompile
    && material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
  const previousKey = material.customProgramCacheKey.bind(material);
  ENABLED.set(material, () => current.enabled);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    if (!current.enabled) return;
    declareLamps(shader, uniforms);
    inject(shader);
  };
  // A material with no hook of its own keeps three's default key (its handler's source) while off.
  const pristineKey = pristine ? previousCompile.toString() : "";
  material.customProgramCacheKey = () => {
    const before = pristine ? pristineKey : previousKey();
    return current.enabled ? `${before}|${INDOOR_LAMPS_KEY}` : before;
  };
  current.materials.add(material);
  const untrack = (): void => {
    material.removeEventListener("dispose", untrack);
    current.materials.delete(material);
  };
  material.addEventListener("dispose", untrack);
  material.needsUpdate = true;
}

const PROJECT_VERTEX = "#include <project_vertex>";
const COLOR_FRAGMENT = "#include <color_fragment>";
const ROOM_OUTGOING = "vec3 outgoingLight = reflectedLight.indirectDiffuse;";

const ROOM_VERTEX_PARS = /* glsl */ `
varying vec3 vWowLampView;
varying vec3 vWowLampNormal;
`;

const ROOM_VERTEX = /* glsl */ `
  vWowLampView = - mvPosition.xyz;
  vec3 wowLampObjectNormal = normal;
  #ifdef USE_INSTANCING
    wowLampObjectNormal = mat3( instanceMatrix ) * wowLampObjectNormal;
  #endif
  vWowLampNormal = normalMatrix * wowLampObjectNormal;
  #ifdef FLIP_SIDED
    vWowLampNormal = - vWowLampNormal;
  #endif
`;

const ROOM_FRAGMENT = /* glsl */ `
  {
    // 25.10 (6.27 indoors): the lamps over the room's baked light (MOCV: linear, so ^(1/2.2) is the
    // display-space light the forward grade would add them to).
    float wowLampNormalLength = length( vWowLampNormal );
    vec3 wowLampNormal = wowLampNormalLength > 0.0001 ? vWowLampNormal / wowLampNormalLength : normalize( vWowLampView );
    #ifdef DOUBLE_SIDED
      wowLampNormal *= gl_FrontFacing ? 1.0 : - 1.0;
    #endif
    vec3 wowRoomLamps = lightLamps( wowLampNormal, vWowLampView );
    if ( max( max( wowRoomLamps.r, wowRoomLamps.g ), wowRoomLamps.b ) > 0.0 ) {
      #if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR )
        vec3 wowRoomBase = pow( max( vColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
      #else
        vec3 wowRoomBase = vec3( 1.0 );
      #endif
      outgoingLight += wowLampAlbedo * lightLampsOver( wowRoomBase, wowRoomLamps );
    }
  }
`;

function once(source: string, marker: string): boolean {
  return source.split(marker).length - 1 === 1;
}

/**
 * The term on a WMO room run (MeshBasic, MOCV as vertex colour). Install it after the run's own hooks
 * and before the relief, which wraps whatever it finds. A program without the markers is left as it was.
 */
export function applyIndoorLampsToRoom(material: THREE.MeshBasicMaterial, uniforms: WorldLightUniforms): void {
  wrap(material, uniforms, (shader) => {
    if (!once(shader.vertexShader, PROJECT_VERTEX) || !once(shader.fragmentShader, COLOR_FRAGMENT)
      || !once(shader.fragmentShader, ROOM_OUTGOING)) {
      throw new Error("Indoor lamps expected one project-vertex, colour and outgoing-light marker");
    }
    shader.vertexShader = `${ROOM_VERTEX_PARS}${shader.vertexShader}`
      .replace(PROJECT_VERTEX, `${PROJECT_VERTEX}${ROOM_VERTEX}`);
    shader.fragmentShader = `${ROOM_VERTEX_PARS}${shader.fragmentShader}`
      // The texture's colour before the MOCV multiplies it: the albedo the lamps light.
      .replace(COLOR_FRAGMENT, `vec3 wowLampAlbedo = diffuseColor.rgb;\n${COLOR_FRAGMENT}`)
      .replace(ROOM_OUTGOING, `${ROOM_OUTGOING}${ROOM_FRAGMENT}`);
  });
}

/** The line of `ModelPlacementTint`'s indoor-M2 body the doodad term follows. */
export const INDOOR_DOODAD_LIGHT_LINE = "reflectedLight.directDiffuse = diffuseColor.rgb * pow( modelPlacementAuthoredLight, vec3( 2.2 ) );";

const DOODAD_FRAGMENT = /* glsl */ `
      // 25.10 (6.27 indoors): the lamps over the doodad's MODD light, as over a room's wall.
      reflectedLight.directDiffuse += diffuseColor.rgb
        * lightLampsOver( modelPlacementAuthoredLight, lightLamps( normalize( normal ), vViewPosition ) );`;

/**
 * The term on a room doodad's indoor-M2 material (MeshStandard whose light block
 * `ModelPlacementTint.ts` replaced). Install it after that hook.
 */
export function applyIndoorLampsToDoodad(material: THREE.MeshStandardMaterial, uniforms: WorldLightUniforms): void {
  wrap(material, uniforms, (shader) => {
    if (!once(shader.fragmentShader, INDOOR_DOODAD_LIGHT_LINE)) {
      throw new Error("Indoor lamps expected the indoor-M2 light line once");
    }
    shader.fragmentShader = shader.fragmentShader.replace(INDOOR_DOODAD_LIGHT_LINE, `${INDOOR_DOODAD_LIGHT_LINE}${DOODAD_FRAGMENT}`);
  });
}
