/**
 * 05.10-A7b-3 (7.11 P2/P4): a WMO's MOMT table and MOSB, as WME5 of a `visual-wmo-v25` artifact.
 *
 * The layout is written down in `tools/wwm.mjs`. The table is optional like every other extension:
 * an artifact from before v25 (WME4 or WME3 last), or a section that fails its own checks, answers
 * no table, and a run then names no record — the renderer keeps drawing it from the run's texture,
 * blend mode and flags exactly as before. Nothing here is per-frame: it is decoded once per model.
 *
 * What the records mean comes from the client's own programs (`Shaders\Pixel\arbfp1\mapobj*.bls`,
 * first program of each; `.runtime/re-2026-10-05/A7b-3/probe-momt.out.txt`):
 * Diffuse `rgb = primary·tex0·2, a = tex0.a`; Opaque, Specular and Metal `rgb = primary·tex0·2,
 * a = primary.a` (the texture's alpha is not opacity); Env `+ tex0.a·tex1`; EnvMetal
 * `+ tex0.rgb·tex0.a·tex1` (texture 2 is the environment map, read through texcoord 1);
 * Composite `mix(tex1, tex0, secondary.a)·primary·2`.
 */

/**
 * MOMT `shader`. 05.10 review A7b-2: the order of Wow.exe's own table of MapObj pixel programs —
 * loaded by name into the handle array at 0x00D1C3F0 (code 0x007AFF1D…): Diffuse, Specular, Metal,
 * Env, Opaque, EnvMetal, Composite (`.runtime/re-2026-10-05/A7b-2-review/probe-shader-table.out.txt`).
 * The corpus agrees: 191 of the 192 shader-3 records carry an environment texture; 4 (Opaque) is in
 * none of the 25,034 records. (The slice first read 1 Opaque, 2 Specular, 3 Metal, 4 Env.)
 */
export const WMO_SHADER_DIFFUSE = 0;
export const WMO_SHADER_SPECULAR = 1;
export const WMO_SHADER_METAL = 2;
export const WMO_SHADER_ENV = 3;
export const WMO_SHADER_OPAQUE = 4;
export const WMO_SHADER_ENV_METAL = 5;
export const WMO_SHADER_COMPOSITE = 6;

/** MOMT flags (counts over the client's 25,034 records). */
export const WMO_MATERIAL_UNLIT = 0x01; // 495
export const WMO_MATERIAL_UNFOGGED = 0x02; // 6
export const WMO_MATERIAL_UNCULLED = 0x04; // 1,019
export const WMO_MATERIAL_EXTERIOR_LIGHT = 0x08; // 96
export const WMO_MATERIAL_SIDN = 0x10; // 323: lit by `sidnColour` at night (window glow)
export const WMO_MATERIAL_WINDOW = 0x20; // 102
export const WMO_MATERIAL_CLAMP_S = 0x40; // 659
export const WMO_MATERIAL_CLAMP_T = 0x80; // 688

export interface WmoMaterial {
  /** MOMT flags, verbatim. */
  flags: number;
  shader: number;
  blendMode: number;
  /** TerrainType of footsteps on it (0–10 in the client's files). */
  groundType: number;
  /** RGBA 0–255: the self-illumination colour a `WMO_MATERIAL_SIDN` material glows with. */
  sidnColour: [number, number, number, number];
  /** RGBA 0–255, MOMT +28. */
  diffColour: [number, number, number, number];
  /** RGBA 0–255, MOMT +40. */
  colour2: [number, number, number, number];
  /** The second texture's client path (EnvMetal's environment map …), or "" for none. */
  texture2: string;
}

const MAGIC_WME2 = "WME2";
const MAGIC_WME3 = "WME3";
const MAGIC_WME4 = "WME4";
const MAGIC_WME5 = "WME5";
const HEADER_SIZE = 20;
const MATERIAL_SIZE = 24;

function magicAt(bytes: Uint8Array, offset: number, magic: string): boolean {
  if (offset < 0 || offset + 4 > bytes.byteLength) return false;
  for (let index = 0; index < 4; index++) if (bytes[offset + index] !== magic.charCodeAt(index)) return false;
  return true;
}

/**
 * WME5 behind the chain that starts at WME2 (`extensionOffset`): WME2's length word finds WME3,
 * WME3's finds the next section, and a WME4 there is stepped over by its own.
 */
export function decodeWmoMaterialSection(
  bytes: Uint8Array,
  view: DataView,
  extensionOffset: number,
): { materials?: WmoMaterial[]; skybox?: string } {
  if (!magicAt(bytes, extensionOffset, MAGIC_WME2) || extensionOffset + 24 > bytes.byteLength) return {};
  const fogOffset = extensionOffset + view.getUint32(extensionOffset + 20, true);
  if (fogOffset <= extensionOffset || !magicAt(bytes, fogOffset, MAGIC_WME3) || fogOffset + 16 > bytes.byteLength) return {};
  let offset = fogOffset + view.getUint32(fogOffset + 12, true);
  if (offset <= fogOffset) return {};
  if (magicAt(bytes, offset, MAGIC_WME4)) {
    if (offset + 12 > bytes.byteLength) return {};
    const length = view.getUint32(offset + 8, true);
    if (length < 12) return {};
    offset += length;
  }
  if (!magicAt(bytes, offset, MAGIC_WME5) || offset + HEADER_SIZE > bytes.byteLength) return {};
  const count = view.getUint32(offset + 4, true);
  const stringCount = view.getUint32(offset + 8, true);
  const skyboxLength = view.getUint32(offset + 12, true);
  const end = offset + view.getUint32(offset + 16, true);
  if (count > 65_535 || stringCount > 65_534 || skyboxLength > 1000 || end > bytes.byteLength
    || offset + HEADER_SIZE + count * MATERIAL_SIZE > end) return {};
  const text = new TextDecoder();
  let at = offset + HEADER_SIZE + count * MATERIAL_SIZE;
  const strings: string[] = [];
  for (let index = 0; index < stringCount; index++) {
    if (at + 2 > end) return {};
    const size = view.getUint16(at, true);
    if (size > 1000 || at + 2 + size > end) return {};
    strings.push(text.decode(bytes.subarray(at + 2, at + 2 + size)));
    at += 2 + size;
  }
  if (at + skyboxLength > end || ((at + skyboxLength + 3) & ~3) !== end) return {};
  const skybox = skyboxLength > 0 ? text.decode(bytes.subarray(at, at + skyboxLength)) : undefined;
  const materials: WmoMaterial[] = [];
  const colour = (base: number): [number, number, number, number] =>
    [bytes[base]!, bytes[base + 1]!, bytes[base + 2]!, bytes[base + 3]!];
  for (let index = 0; index < count; index++) {
    const base = offset + HEADER_SIZE + index * MATERIAL_SIZE;
    const texture = view.getUint16(base + 20, true);
    if (texture > strings.length) return {};
    materials.push({
      flags: view.getUint32(base, true),
      shader: bytes[base + 4]!,
      blendMode: bytes[base + 5]!,
      groundType: bytes[base + 6]!,
      sidnColour: colour(base + 8),
      diffColour: colour(base + 12),
      colour2: colour(base + 16),
      texture2: texture === 0 ? "" : strings[texture - 1]!,
    });
  }
  return skybox === undefined ? { materials } : { materials, skybox };
}

/** The MOMT record a run is drawn with, or undefined (no table, an older artifact, a bad ordinal). */
export function wmoRunMaterial(
  model: { readonly materials?: readonly WmoMaterial[] | undefined },
  run: { readonly materialIndex?: number | undefined },
): WmoMaterial | undefined {
  const index = run.materialIndex;
  return index === undefined ? undefined : model.materials?.[index];
}
