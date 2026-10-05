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
    rows.push({ id: field(0), name, gemItemId: field(33), conditionId: field(34), visual: field(31), flags: field(32) });
  }
  return rows;
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
  const [enchants, gems, visuals, itemVisuals] = await Promise.all([
    readFile(join(directory, "SpellItemEnchantment.dbc")), openDbcFile(directory, "GemProperties"),
    loadEnchantVisualsOptional(directory),
    loadItemVisualSlotsOptional(directory), // 05.10-A7a-E
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
  };
}
