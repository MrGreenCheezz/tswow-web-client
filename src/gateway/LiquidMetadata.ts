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
