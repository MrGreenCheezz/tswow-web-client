/** GT_MAX_LEVEL from the compatible core's DBCStructure.h; rows are implicit, not ID keyed. */
export const CHARACTER_STAT_MAX_LEVEL = 100;
/** DBCStructure.h uses 32 table rows per class, although only 25 ratings are exposed. */
export const CHARACTER_STAT_MAX_RATING = 32;

export interface CharacterStatCatalog {
  readonly spellCritBase: readonly number[];
  readonly spellCritPerIntellect: readonly number[];
  readonly combatRatingPerLevel?: readonly number[];
  readonly combatRatingScalar?: Readonly<Record<number, number>>;
}

/** DBCfmt.h declares both gtChanceToSpellCrit tables as one float per row (`f`). */
export function parseCharacterStatTable(bytes: Uint8Array): readonly number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || String.fromCharCode(...bytes.subarray(0, 4)) !== "WDBC") {
    throw new Error("Character stat table: expected WDBC");
  }
  const rows = view.getUint32(4, true);
  const strings = view.getUint32(16, true);
  if (view.getUint32(8, true) !== 1 || view.getUint32(12, true) !== 4
    || rows === 0 || rows > 8192 || strings > 1024 || 20 + rows * 4 + strings !== bytes.byteLength) {
    throw new Error("Character stat table: invalid 3.3.5 float table layout");
  }
  const values = Array.from({ length: rows }, (_, row) => view.getFloat32(20 + row * 4, true));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Character stat table: non-finite coefficient");
  }
  return values;
}

/** `gtOCTClassCombatRatingScalar` is `df`: explicit row ID followed by its float coefficient. */
export function parseCharacterRatingScalar(bytes: Uint8Array): Readonly<Record<number, number>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || String.fromCharCode(...bytes.subarray(0, 4)) !== "WDBC") {
    throw new Error("Character rating scalar: expected WDBC");
  }
  const rows = view.getUint32(4, true);
  const strings = view.getUint32(16, true);
  if (view.getUint32(8, true) !== 2 || view.getUint32(12, true) !== 8
    || rows === 0 || rows > 1024 || strings > 1024 || 20 + rows * 8 + strings !== bytes.byteLength) {
    throw new Error("Character rating scalar: invalid 3.3.5 indexed float table layout");
  }
  const values: Record<number, number> = {};
  for (let row = 0; row < rows; row++) {
    const id = view.getUint32(20 + row * 8, true);
    const coefficient = view.getFloat32(24 + row * 8, true);
    if (id < 1 || id > 1024 || Object.hasOwn(values, id) || !Number.isFinite(coefficient) || coefficient < 0) {
      throw new Error("Character rating scalar: invalid ID or coefficient");
    }
    values[id] = coefficient;
  }
  return values;
}

export function isCharacterStatCatalog(value: unknown): value is CharacterStatCatalog {
  if (!value || typeof value !== "object") return false;
  const { spellCritBase: base, spellCritPerIntellect: ratio,
    combatRatingPerLevel: ratings, combatRatingScalar: scalar } = value as Partial<CharacterStatCatalog>;
  const ratingDataValid = ratings === undefined && scalar === undefined
    || Array.isArray(ratings) && ratings.length >= 25 * CHARACTER_STAT_MAX_LEVEL && ratings.length <= 8192
      && ratings.every((coefficient: unknown) => typeof coefficient === "number" && Number.isFinite(coefficient) && coefficient >= 0)
      && !!scalar && typeof scalar === "object" && !Array.isArray(scalar)
      && Object.keys(scalar).length > 0
      && Object.entries(scalar).every(([id, coefficient]) => Number.isInteger(Number(id)) && Number(id) >= 1
        && Number(id) <= 1024 && typeof coefficient === "number" && Number.isFinite(coefficient) && coefficient >= 0);
  return Array.isArray(base) && base.length > 0 && base.length <= 32
    && Array.isArray(ratio) && ratio.length === base.length * CHARACTER_STAT_MAX_LEVEL
    && base.every((coefficient: unknown) => typeof coefficient === "number" && Number.isFinite(coefficient))
    && ratio.every((coefficient: unknown) => typeof coefficient === "number" && Number.isFinite(coefficient))
    && ratingDataValid;
}

/** Player.cpp::GetRatingBonusValue/GetRatingMultiplier; C API rating indices are one-based. */
export function characterCombatRatingBonus(
  catalog: CharacterStatCatalog | undefined, classId: number, level: number, ratingIndex: number, rating: number,
): number | undefined {
  if (!catalog || !Number.isInteger(classId) || classId < 1
    || !Number.isInteger(level) || level < 1 || !Number.isInteger(ratingIndex) || ratingIndex < 1 || ratingIndex > 25
    || !Number.isFinite(rating) || rating < 0) return undefined;
  const divisor = catalog.combatRatingPerLevel?.[(ratingIndex - 1) * CHARACTER_STAT_MAX_LEVEL
    + Math.min(level, CHARACTER_STAT_MAX_LEVEL) - 1];
  const scalar = catalog.combatRatingScalar?.[(classId - 1) * CHARACTER_STAT_MAX_RATING + ratingIndex];
  return divisor === undefined || divisor <= 0 || scalar === undefined ? undefined : rating * scalar / divisor;
}

/** Player.cpp::GetSpellCritFromIntellect: class base plus the effective STAT_INTELLECT contribution. */
export function spellCritFromIntellect(
  catalog: CharacterStatCatalog | undefined, classId: number, level: number, intellect: number,
): number | undefined {
  if (!catalog || !Number.isInteger(classId) || classId < 1
    || !Number.isInteger(level) || level < 1 || !Number.isFinite(intellect)) return undefined;
  const base = catalog.spellCritBase[classId - 1];
  const ratio = catalog.spellCritPerIntellect[(classId - 1) * CHARACTER_STAT_MAX_LEVEL
    + Math.min(level, CHARACTER_STAT_MAX_LEVEL) - 1];
  return base === undefined || ratio === undefined ? undefined : (base + intellect * ratio) * 100;
}
