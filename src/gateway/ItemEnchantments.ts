import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbcFile } from "./Dbc.js";

export interface ItemEnchantmentInfo {
  id: number;
  name: string;
  gemItemId: number;
  conditionId: number;
  /** `ItemVisual` (field 31): the glow the original client hangs on the enchanted item. */
  visual: number;
  /**
   * `Flags` (field 32; the client's record offset 0x40): `ENCHANTMENT_CAN_SOULBOUND` (0x01) binds
   * the item it goes on — BIND_ENCHANT and TRADE_POTENTIAL_BIND_ENCHANT (plan item 2.05, Wow.exe
   * 0x005210d0 and 0x007073e0) and `Spell::CheckItems`' SPELL_FAILED_NOT_TRADEABLE. Optional since the
   * browser's `?v=2`: an older gateway does not send it.
   */
  flags?: number;
  /**
   * 06.11 (3.12): the three effects in place, `[type, min, max, arg]` (fields 2-13; type 0 an empty one) — what
   * a random property adds to the stat table (Wow.exe 0x0061f940, 0x0061f980). Absent when all three are
   * empty, and from a gateway older than the browser's `?v=3`.
   */
  effects?: ItemEnchantmentEffect[];
}

/** 06.11 (3.12): one SpellItemEnchantment effect: type, EffectPointsMin, EffectPointsMax, EffectArg. */
export type ItemEnchantmentEffect = [type: number, min: number, max: number, arg: number];

/** 06.11 (3.12): an ItemRandomProperties row: the name suffix and the five enchantments of slots 7-11. */
export interface ItemRandomPropertyInfo {
  id: number;
  name: string;
  enchantments: number[];
}

/** 06.11 (3.12): an ItemRandomSuffix row: as a property, with each enchantment's share of the suffix factor. */
export interface ItemRandomSuffixInfo extends ItemRandomPropertyInfo {
  /** AllocationPct, in hundredths of a per cent (0x00707650 multiplies by 0.0001f). */
  allocation: number[];
}

/** 06.11 (3.12): a RandPropPoints row: an item level's suffix factors by quality and slot column. */
export interface RandPropPointsInfo {
  level: number;
  epic: number[];
  rare: number[];
  uncommon: number[];
}

export interface GemPropertyInfo {
  id: number;
  enchantmentId: number;
  color: number;
}

export interface ItemEnchantmentData {
  enchantments: ItemEnchantmentInfo[];
  gems: GemPropertyInfo[];
  /** Enchant id to the glow model paths its `ItemVisual` resolves to, through `ItemVisuals`
   * slots into `ItemVisualEffects` models. Only enchants with at least one resolvable model are
   * listed; anything else glows nothing, by data rather than by code. */
  visuals: Record<string, string[]>;
  /**
   * 05.10-A7a-E (6.14): ItemVisuals id → its five slots, each the effect model (`.mdx` renamed to `.m2`)
   * or null — slot i is hung on the weapon model's attachment i (browser/WeaponGlow.ts), so the slot
   * number must survive, which `visuals` (flattened, deduplicated) does not keep. Additive under `?v=2`:
   * an older gateway sends no key and the page keeps the tint.
   */
  slots?: Record<string, (string | null)[]>;
  /** 05.10-A7a-E (6.14): ItemDisplayInfo id → ItemVisual (column 23), for the displays that name one. */
  displayVisual?: Record<string, number>;
  /** 06.11 (3.12): the random property tables, when the dataset has them (additive under `?v=3`). */
  randomProperties?: ItemRandomPropertyInfo[];
  randomSuffixes?: ItemRandomSuffixInfo[];
  randPropPoints?: RandPropPointsInfo[];
}

/** 3.3.5 DBCStructure.h: SpellItemEnchantment is 38 uint32 fields, Name[16] at 14,
 * SrcItemID at 33. Gameplay DBCs come from the active dataset, including TSWoW rows. */
export function readItemEnchantments(data: Buffer): ItemEnchantmentInfo[] {
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "WDBC"
    || data.readUInt32LE(8) !== 38 || data.readUInt32LE(12) !== 152) {
    throw new Error("Invalid 3.3.5 SpellItemEnchantment.dbc layout");
  }
  const count = data.readUInt32LE(4);
  const strings = 20 + count * 152;
  if (strings + data.readUInt32LE(16) !== data.length) throw new Error("Invalid enchantment string block");
  const rows: ItemEnchantmentInfo[] = [];
  for (let row = 0; row < count; row++) {
    const at = 20 + row * 152;
    const field = (index: number): number => data.readUInt32LE(at + index * 4);
    let name = "";
    // Same locale policy as the other gameplay metadata: ruRU, enUS, then any populated locale.
    for (const locale of [8, 0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]) {
      const offset = field(14 + locale);
      if (offset === 0) continue;
      const end = data.indexOf(0, strings + offset);
      if (strings + offset >= data.length || end < 0) throw new Error("Invalid enchantment name offset");
      name = data.toString("utf8", strings + offset, end);
      if (name) break;
    }
    const info: ItemEnchantmentInfo = { id: field(0), name, gemItemId: field(33), conditionId: field(34), visual: field(31), flags: field(32) };
    // 06.11 (3.12): the effects in place; the points are signed.
    const effects = [0, 1, 2].map((effect): ItemEnchantmentEffect => [field(2 + effect),
      data.readInt32LE(at + (5 + effect) * 4), data.readInt32LE(at + (8 + effect) * 4), field(11 + effect)]);
    if (effects.some(([type]) => type !== 0)) info.effects = effects;
    rows.push(info);
  }
  return rows;
}

/** 06.11 (3.12): a 3.3.5 WDBC of `fields` words a row, read the way the enchantments above are. */
function wdbc(data: Buffer, table: string, fields: number): {
  count: number; word(row: number, field: number): number; text(row: number, first: number): string;
} {
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "WDBC"
    || data.readUInt32LE(8) !== fields || data.readUInt32LE(12) !== fields * 4) {
    throw new Error(`Invalid 3.3.5 ${table}.dbc layout`);
  }
  const count = data.readUInt32LE(4);
  const strings = 20 + count * fields * 4;
  if (strings + data.readUInt32LE(16) !== data.length) throw new Error(`Invalid ${table} string block`);
  const word = (row: number, field: number): number => data.readUInt32LE(20 + (row * fields + field) * 4);
  return {
    count,
    word,
    // Name[16] from `first`: ruRU, enUS, then any populated locale, as above.
    text: (row, first) => {
      for (const locale of [8, 0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]) {
        const offset = word(row, first + locale);
        if (offset === 0) continue;
        const end = data.indexOf(0, strings + offset);
        if (strings + offset >= data.length || end < 0) throw new Error(`Invalid ${table} name offset`);
        const name = data.toString("utf8", strings + offset, end);
        if (name) return name;
      }
      return "";
    },
  };
}

/** 06.11 (3.12): ItemRandomProperties.dbc — ID, InternalName, Enchantment[5] (2-6), Name[16] (7-22), flags. */
export function readItemRandomProperties(data: Buffer): ItemRandomPropertyInfo[] {
  const table = wdbc(data, "ItemRandomProperties", 24);
  return Array.from({ length: table.count }, (_, row) => ({
    id: table.word(row, 0), name: table.text(row, 7), enchantments: [2, 3, 4, 5, 6].map((field) => table.word(row, field)),
  }));
}

/**
 * 06.11 (3.12): ItemRandomSuffix.dbc — ID, Name[16] (1-16), flags, InternalName (18), Enchantment[5] (19-23),
 * AllocationPct[5] (24-28).
 */
export function readItemRandomSuffixes(data: Buffer): ItemRandomSuffixInfo[] {
  const table = wdbc(data, "ItemRandomSuffix", 29);
  return Array.from({ length: table.count }, (_, row) => ({
    id: table.word(row, 0), name: table.text(row, 1),
    enchantments: [19, 20, 21, 22, 23].map((field) => table.word(row, field)),
    allocation: [24, 25, 26, 27, 28].map((field) => table.word(row, field)),
  }));
}

/** 06.11 (3.12): RandPropPoints.dbc — ItemLevel, Epic[5] (1-5), Superior[5] (6-10), Good[5] (11-15). */
export function readRandPropPoints(data: Buffer): RandPropPointsInfo[] {
  const table = wdbc(data, "RandPropPoints", 16);
  const five = (row: number, first: number): number[] => [0, 1, 2, 3, 4].map((index) => table.word(row, first + index));
  return Array.from({ length: table.count }, (_, row) => ({
    level: table.word(row, 0), epic: five(row, 1), rare: five(row, 6), uncommon: five(row, 11),
  }));
}

/** A table the dataset may not ship: missing reads as undefined, a corrupt one still fails. */
async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The glow models behind `ItemVisual` ids.
 *
 * `ItemVisuals` names five attachment slots per visual and `ItemVisualEffects` names the model
 * file for each — `Spells\Enchantments\*.mdx` for weapon glows. Slot references that are empty
 * (0, -1, 0xFFFF) or point outside the effects table are skipped: some dataset rows carry such
 * references, and a glow must never be invented for them.
 */
export async function loadEnchantVisuals(directory: string): Promise<Map<number, string[]>> {
  const [visuals, effects] = await Promise.all([
    openDbcFile(directory, "ItemVisuals"), openDbcFile(directory, "ItemVisualEffects"),
  ]);
  const models = new Map<number, string>();
  for (const row of effects.rows()) {
    const model = effects.string(row, "Model");
    if (model) models.set(effects.id(row), model);
  }
  const resolved = new Map<number, string[]>();
  for (const row of visuals.rows()) {
    const paths: string[] = [];
    for (let slot = 0; slot < 5; slot++) {
      const model = models.get(visuals.int(row, "Slot", slot));
      if (model && !paths.includes(model)) paths.push(model);
    }
    if (paths.length > 0) resolved.set(visuals.id(row), paths);
  }
  return resolved;
}

/**
 * The glow tables are client art, not gameplay: a minimal dataset may not ship them, and the
 * endpoint's primary readers (socketing, tooltips) must keep working. Missing files mean no
 * glows; corrupt ones still fail the request.
 */
/** 05.10-A7a-E (6.14): the effect model a slot names, as the archive has it (`.mdx` → `.m2`). */
function effectModelPath(model: string): string {
  return model.toLowerCase().endsWith(".mdx") ? `${model.slice(0, -4)}.m2` : model;
}

/**
 * 05.10-A7a-E (6.14): ItemVisuals with its slot numbers kept, and ItemDisplayInfo.ItemVisual. Rows with no
 * resolvable slot are left out; empty references (0, −1, outside the effects table) are null.
 */
export async function loadItemVisualSlots(directory: string): Promise<{
  slots: Map<number, (string | null)[]>;
  displayVisual: Map<number, number>;
}> {
  const [visuals, effects, displays] = await Promise.all([
    openDbcFile(directory, "ItemVisuals"), openDbcFile(directory, "ItemVisualEffects"),
    openDbcFile(directory, "ItemDisplayInfo"),
  ]);
  const models = new Map<number, string>();
  for (const row of effects.rows()) {
    const model = effects.string(row, "Model");
    if (model) models.set(effects.id(row), effectModelPath(model));
  }
  const slots = new Map<number, (string | null)[]>();
  for (const row of visuals.rows()) {
    const five: (string | null)[] = [];
    for (let slot = 0; slot < 5; slot++) five.push(models.get(visuals.int(row, "Slot", slot)) ?? null);
    if (five.some((path) => path !== null)) slots.set(visuals.id(row), five);
  }
  const displayVisual = new Map<number, number>();
  for (const row of displays.rows()) {
    const visual = displays.int(row, "ItemVisual");
    if (visual > 0 && slots.has(visual)) displayVisual.set(displays.id(row), visual);
  }
  return { slots, displayVisual };
}

async function loadItemVisualSlotsOptional(directory: string): Promise<Awaited<ReturnType<typeof loadItemVisualSlots>> | undefined> {
  try {
    return await loadItemVisualSlots(directory);
  } catch (error) {
    if (error instanceof Error && /could not be read/.test(error.message)) return undefined;
    throw error;
  }
}

async function loadEnchantVisualsOptional(directory: string): Promise<Map<number, string[]>> {
  try {
    return await loadEnchantVisuals(directory);
  } catch (error) {
    // `openDbcFile` wraps a missing file into a DbcError, keeping the path in the message but
    // not the errno — so the absence is recognised by the message it is wrapped in.
    if (error instanceof Error && /could not be read/.test(error.message)) return new Map();
    throw error;
  }
}

export async function loadItemEnchantments(directory: string): Promise<ItemEnchantmentData> {
  const [enchants, gems, visuals, itemVisuals, properties, suffixes, points] = await Promise.all([
    readFile(join(directory, "SpellItemEnchantment.dbc")), openDbcFile(directory, "GemProperties"),
    loadEnchantVisualsOptional(directory),
    loadItemVisualSlotsOptional(directory), // 05.10-A7a-E
    readOptional(join(directory, "ItemRandomProperties.dbc")), // 06.11 (3.12)
    readOptional(join(directory, "ItemRandomSuffix.dbc")),
    readOptional(join(directory, "RandPropPoints.dbc")),
  ]);
  const enchantments = readItemEnchantments(enchants);
  const models: Record<string, string[]> = {};
  for (const enchantment of enchantments) {
    const paths = visuals.get(enchantment.visual);
    if (paths) models[enchantment.id] = paths;
  }
  return {
    enchantments,
    gems: Array.from({ length: gems.records }, (_, row) => ({
      id: gems.int(row, "ID"), enchantmentId: gems.int(row, "Enchant_ID"), color: gems.int(row, "Type"),
    })),
    visuals: models,
    // 05.10-A7a-E (6.14): the slot-preserving view and the display map, when the tables are there.
    ...(itemVisuals ? {
      slots: Object.fromEntries(itemVisuals.slots),
      displayVisual: Object.fromEntries(itemVisuals.displayVisual),
    } : {}),
    // 06.11 (3.12): a property with no name and no enchantment says nothing and is left out.
    ...(properties ? {
      randomProperties: readItemRandomProperties(properties).filter((row) => row.name || row.enchantments.some((id) => id > 0)),
    } : {}),
    ...(suffixes ? { randomSuffixes: readItemRandomSuffixes(suffixes) } : {}),
    ...(points ? { randPropPoints: readRandPropPoints(points) } : {}),
  };
}
