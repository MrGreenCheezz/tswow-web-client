import { openDbcFile } from "./Dbc.js";

/** The four surfaces the client ships an animation strip for. */
export const LIQUID_CLASSES = ["water", "ocean", "magma", "slime"] as const;
export type LiquidClass = (typeof LIQUID_CLASSES)[number];

/**
 * Which of the four surfaces each `LiquidType.dbc` row is drawn as.
 *
 * Not `SoundBank`, which is what this client used until now and what the map file's four-way flag
 * repeats. The bank is the sound a swimmer makes, and it disagrees with the picture on one row in
 * this dataset: 181 "Orange Slime" is bank 0 — water — and names `XTEXTURES\LavaOrange`. It sits
 * on 49 chunks of Northrend, every one of them drawn as a blue river.
 *
 * The row's own texture decides instead, because that is the question being asked: which of the
 * four strips looks like this liquid. `XTextures\river` is water, `ocean` is ocean, anything named
 * lava — `lava`, `LavaGreen`, `LavaOrange` — is magma, and `slime` is slime. Row 100 "Basic
 * Procedural Water" names a reflection map rather than a family and falls back to its bank.
 */
export function liquidClassFromTexture(texture: string, soundBank: number): LiquidClass {
  const path = texture.toLowerCase();
  if (path.includes("lava")) return "magma";
  if (path.includes("slime")) return "slime";
  if (path.includes("ocean")) return "ocean";
  if (path.includes("river")) return "water";
  return LIQUID_CLASSES[soundBank] ?? "water";
}

/**
 * Every row of the table, by id. Twenty-six rows in this dataset, so it travels whole.
 *
 * The map file records a `LiquidType` id per chunk, and until now the client stepped over it and
 * read the four-way flag beside it. Both are kept: 1,561 of the 3,196 tiles that have liquid at
 * all carry no per-chunk arrays, and on those the header's own id is the only thing there is.
 */
export async function loadLiquidClasses(dbcDirectory: string): Promise<Record<number, LiquidClass>> {
  const types = await openDbcFile(dbcDirectory, "LiquidType");
  const classes: Record<number, LiquidClass> = {};
  for (const row of types.rows()) {
    const id = types.id(row);
    if (id <= 0) continue;
    classes[id] = liquidClassFromTexture(types.string(row, "Texture", 0), types.int(row, "SoundBank"));
  }
  return classes;
}

// ---- 05.10-A7b-5 (7.09 data): the whole LiquidType row, for `/dbc/liquid-types?v=2` ----------

/** One `LiquidType` row as the browser needs it to pick a strip, a material and the light. */
export interface LiquidTypeRow {
  id: number;
  name: string;
  flags: number;
  /** 0 water, 1 ocean, 2 magma, 3 slime — the swimmer's sound, and the plan's shading key (7.09). */
  soundBank: number;
  /**
   * The strip family: the lower-cased file name of `Texture[0]` without `.%d.blp` — `lake_a`,
   * `ocean_h`, `lava`, `slime`, `fast_a`, `lavagreen`, `lavaorange` — or of a single texture
   * (`basicreflectionmap` for row 100). Lower-cased because archive paths are case-blind and the
   * table spells the same family two ways (`XTEXTURES\LavaOrange` beside `XTextures\lava`).
   */
  family: string;
  /** `Texture[0..5]` as authored, empty slots dropped from the end. */
  textures: string[];
  materialId: number;
  /** `LiquidMaterial.LVF` and `.Flags` for `materialId`; absent when the table or row is missing. */
  vertexFormat?: number;
  materialFlags?: number;
  lightId: number;
  maxDarkenDepth: number;
  fogDarken: number;
  ambDarken: number;
  dirDarken: number;
  /** `Float[18]` and `Int[4]` as stored; what they mean is not established (line-A7b 7.09). */
  floatParams: number[];
  intParams: number[];
}

export interface LiquidTypesV2 {
  version: 2;
  /** The v1 body, unchanged, so a browser can move to v2 without losing its class lookup. */
  classes: Record<number, LiquidClass>;
  rows: Record<number, LiquidTypeRow>;
}

/** The strip family of a `LiquidType.Texture[0]` path. */
export function liquidFamily(texture: string): string {
  const file = texture.replaceAll("/", "\\").split("\\").pop() ?? "";
  return file.replace(/(?:\.%d)?\.blp$/i, "").toLowerCase();
}

export async function loadLiquidRows(dbcDirectory: string): Promise<LiquidTypesV2> {
  const [types, materials] = await Promise.all([
    openDbcFile(dbcDirectory, "LiquidType"),
    openDbcFile(dbcDirectory, "LiquidMaterial").catch(() => undefined),
  ]);
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  const classes: Record<number, LiquidClass> = {};
  const rows: Record<number, LiquidTypeRow> = {};
  for (const row of types.rows()) {
    const id = types.id(row);
    if (id <= 0) continue;
    const textures = Array.from({ length: 6 }, (_, slot) => types.string(row, "Texture", slot));
    while (textures.length > 0 && !textures[textures.length - 1]) textures.pop();
    const soundBank = types.int(row, "SoundBank");
    classes[id] = liquidClassFromTexture(textures[0] ?? "", soundBank);
    const materialId = types.int(row, "MaterialID");
    const materialRow = materials && materialId > 0 ? materials.rowOf(materialId) : undefined;
    rows[id] = {
      id,
      name: types.string(row, "Name"),
      flags: types.int(row, "Flags"),
      soundBank,
      family: liquidFamily(textures[0] ?? ""),
      textures,
      materialId,
      ...(materials && materialRow !== undefined
        ? { vertexFormat: materials.int(materialRow, "LVF"), materialFlags: materials.int(materialRow, "Flags") }
        : {}),
      lightId: types.int(row, "LightID"),
      maxDarkenDepth: finite(types.float(row, "MaxDarkenDepth")),
      fogDarken: finite(types.float(row, "FogDarkenIntensity")),
      ambDarken: finite(types.float(row, "AmbDarkenIntensity")),
      dirDarken: finite(types.float(row, "DirDarkenIntensity")),
      floatParams: Array.from({ length: 18 }, (_, slot) => finite(types.float(row, "Float", slot))),
      intParams: Array.from({ length: 4 }, (_, slot) => types.int(row, "Int", slot)),
    };
  }
  return { version: 2, classes, rows };
}
