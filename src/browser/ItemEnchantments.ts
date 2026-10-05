import type { ItemEnchantmentData, ItemEnchantmentInfo, GemPropertyInfo } from "../gateway/ItemEnchantments.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "../world/WorldState.js";

export type { ItemEnchantmentInfo, GemPropertyInfo };

export class ItemEnchantmentClient {
  readonly enchantments = new Map<number, ItemEnchantmentInfo>();
  readonly gems = new Map<number, GemPropertyInfo>();
  #pending: Promise<void> | undefined;
  ready = false;

  constructor(readonly origin: string) {}

  load(refresh = false): Promise<void> {
    if (this.ready && !refresh) return Promise.resolve();
    if (refresh) this.ready = false;
    this.#pending ??= this.#load().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  readonly visuals = new Map<number, readonly string[]>();
  /** 05.10-A7a-E (6.14): ItemVisuals id → five slots (model path or null), from the answer's `slots`. */
  readonly itemVisualSlots = new Map<number, readonly (string | null)[]>();
  /** 05.10-A7a-E (6.14): ItemDisplayInfo id → ItemVisual id, from the answer's `displayVisual`. */
  readonly displayVisuals = new Map<number, number>();

  async #load(): Promise<void> {
    // `v=2`: the rows gained `flags` (SpellItemEnchantment.Flags, 2.05). The route does not read the
    // query, so a gateway not yet restarted answers the old shape and `flags` stays undefined.
    const response = await fetch(`${this.origin}/dbc/item-enchantments?v=2`);
    if (!response.ok) throw new Error(`Не удалось загрузить сведения о камнях (${response.status})`);
    const data = await response.json() as ItemEnchantmentData;
    if (!Array.isArray(data.enchantments) || !Array.isArray(data.gems)
      || !data.enchantments.every((row) => Number.isInteger(row.id) && typeof row.name === "string"
        && Number.isInteger(row.gemItemId) && Number.isInteger(row.conditionId)
        && (row.visual === undefined || Number.isInteger(row.visual))
        && (row.flags === undefined || Number.isInteger(row.flags)))
      || !data.gems.every((row) => Number.isInteger(row.id) && Number.isInteger(row.enchantmentId)
        && Number.isInteger(row.color))) throw new Error("Некорректные сведения о камнях");
    this.enchantments.clear();
    this.gems.clear();
    this.visuals.clear();
    this.itemVisualSlots.clear(); // 05.10-A7a-E
    this.displayVisuals.clear(); // 05.10-A7a-E
    for (const enchantment of data.enchantments) this.enchantments.set(enchantment.id, enchantment);
    for (const gem of data.gems) this.gems.set(gem.id, gem);
    // An older gateway sends no visuals: glow stays off rather than failing the whole table.
    const visuals = (data as { visuals?: Record<string, readonly string[]> }).visuals;
    if (visuals && typeof visuals === "object") {
      for (const [id, models] of Object.entries(visuals)) {
        const enchantId = Number(id);
        if (Number.isInteger(enchantId) && Array.isArray(models)
          && models.every((model) => typeof model === "string" && model.length > 0)) {
          this.visuals.set(enchantId, [...models]);
        }
      }
    }
    // 05.10-A7a-E (6.14): optional, additive; a malformed entry is skipped, never the whole table.
    const slots = (data as { slots?: Record<string, unknown> }).slots;
    if (slots && typeof slots === "object") {
      for (const [id, five] of Object.entries(slots)) {
        const visualId = Number(id);
        if (Number.isInteger(visualId) && Array.isArray(five) && five.length === 5
          && five.every((path) => path === null || (typeof path === "string" && path.length > 0))) {
          this.itemVisualSlots.set(visualId, Object.freeze([...five] as (string | null)[]));
        }
      }
    }
    const displays = (data as { displayVisual?: Record<string, unknown> }).displayVisual;
    if (displays && typeof displays === "object") {
      for (const [id, visual] of Object.entries(displays)) {
        const displayId = Number(id);
        if (Number.isInteger(displayId) && Number.isInteger(visual)) this.displayVisuals.set(displayId, visual as number);
      }
    }
    this.ready = true;
  }

  /** The glow model files the dataset resolves for this enchant id, if any. */
  glowModels(enchantId: number): readonly string[] {
    return this.visuals.get(enchantId) ?? NO_GLOW_MODELS; // 05.10-A7a-E2: one shared empty list, asked per frame
  }

  /** 05.10-A7a-E (6.14): the five ItemVisuals slots of this enchant's ItemVisual, if it has any. */
  glowSlots(enchantId: number): readonly (string | null)[] | undefined {
    const visual = this.enchantments.get(enchantId)?.visual;
    return visual ? this.itemVisualSlots.get(visual) : undefined;
  }

  /** 05.10-A7a-E (6.14): the five slots of a display's own ItemVisual (a legendary's glow), if any. */
  displayGlowSlots(displayId: number): readonly (string | null)[] | undefined {
    const visual = this.displayVisuals.get(displayId);
    return visual ? this.itemVisualSlots.get(visual) : undefined;
  }
}

/**
 * 05.10-A7a-E (6.14): which five slots glow on a weapon: an enchantment's ItemVisual wins over the display's
 * own (the enchant ids in the order they are tried — temporary before permanent).
 */
export function glowSlots(
  enchantIds: readonly number[],
  displayId: number | undefined,
  source: Pick<ItemEnchantmentClient, "glowSlots" | "displayGlowSlots">,
): readonly (string | null)[] | undefined {
  for (const id of enchantIds) {
    if (id <= 0) continue;
    const slots = source.glowSlots(id);
    if (slots) return slots;
  }
  return displayId !== undefined && displayId > 0 ? source.displayGlowSlots(displayId) : undefined;
}

/**
 * An enchant's glow as a tint, read off the glow model filenames the dataset resolved.
 *
 * The original client hangs the glow's M2 (MDX) particle models on the weapon. This client does
 * render M2 particles (ParticleRender.ts), but it does not attach an enchant's glow model to the
 * weapon, so the glow is an emissive tint in the art's own colour family. Colours come from the
 * colour words the artists put in the filenames (`RedGlow_High`, `WhiteFlame_Low`) and from the
 * element words of the imbue families (`Shaman_Fire`, `PoisonDrip`, `FrozenRuneWeapon_State`).
 * Intensity follows the tier word: High strongest, Low softest.
 *
 * Four famous models carry no colour word at all — `ExecutionerGlow`, `DisintigrateGlow`,
 * `Battleground…` (`BattlemasterGlow`), `SpellSurgeGlow` — and get no tint rather than a guessed
 * one. `MongooseGlow` reads green and `SavageryGlow` red-orange off the art family they belong
 * to; `SkullBalls` (the Black Magic proc) reads shadow-violet off the proc's school.
 */
export interface EnchantGlow {
  color: number;
  /** Emissive strength: High 0.9, Med 0.65, Low 0.45; 0 when only `slots` say anything. */
  intensity: number;
  /**
   * 05.10-A7a-E (6.14): the ItemVisuals slots to hang as effect models (WeaponGlow.ts). When the weapon model
   * has the attachments for them the renderer draws those and no tint; otherwise the tint stays.
   */
  slots?: readonly (string | null)[];
}

const ENCHANT_GLOW_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/white/i, 0xf2f5f8],
  [/black/i, 0x2a2a3a],
  [/red/i, 0xff3b30],
  [/green/i, 0x37c95a],
  [/blue/i, 0x3f8fdd],
  [/yellow/i, 0xffd24a],
  [/purple/i, 0xa64ee8],
  [/orange/i, 0xff7a1a],
  [/fire/i, 0xff5a1a],
  [/frost|icy|frozen/i, 0x9fd8ff],
  [/rock/i, 0xa89878],
  [/wind/i, 0xd8f4ff],
  [/poison/i, 0x4fd06a],
  [/sparkle/i, 0xe8ecf2],
  [/holy/i, 0xffe9a8],
];

const ENCHANT_GLOW_NAMED: Readonly<Record<string, number>> = {
  mongoose: 0x4fd06a,
  savagery: 0xff5a2a,
  skull: 0x8a4de8,
};

const ENCHANT_GLOW_TIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/high/i, 0.9],
  [/med/i, 0.65],
  [/low/i, 0.45],
];

export function enchantGlowTint(models: readonly string[]): EnchantGlow | undefined {
  for (const model of models) {
    const file = model.split("\\").pop() ?? model;
    const lowered = file.toLowerCase();
    const word = ENCHANT_GLOW_WORDS.find(([pattern]) => pattern.test(file))?.[1]
      ?? Object.entries(ENCHANT_GLOW_NAMED).find(([name]) => lowered.includes(name))?.[1];
    if (word === undefined) continue;
    const intensity = ENCHANT_GLOW_TIERS.find(([pattern]) => pattern.test(file))?.[1] ?? 0.65;
    return { color: word, intensity };
  }
  return undefined;
}

let cached: ItemEnchantmentClient | undefined;
export function itemEnchantments(origin: string): ItemEnchantmentClient {
  if (cached?.origin !== origin) cached = new ItemEnchantmentClient(origin);
  return cached;
}

/** Item.h: each enchantment occupies id/duration/charges; sockets are slots 2..4,
 * socket bonus is slot 5, a blacksmith/buckle prismatic socket is slot 6. */
export function itemEnchantmentIds(item: WorldObjectState): number[] {
  return Array.from({ length: 7 }, (_, slot) =>
    item.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + slot * 3) ?? 0);
}

/**
 * The enchant ids on a worn weapon, read off the unit rather than off the item.
 *
 * `PLAYER_VISIBLE_ITEM_N_ENCHANTMENT` is one word holding two shorts (`SetUInt16Value` in
 * `Player.cpp`): the permanent enchant low, the temporary one (poison, oil, stone) high. It is
 * PUBLIC, so every player's blade carries it — no item object needed, which is also why this
 * works for strangers whose inventory never streams. `equipmentSlot` is the `EQUIPMENT_SLOT_*`
 * the visible-item words are indexed by, 15/16/17 for the weapons.
 */
export function visibleItemEnchants(
  object: WorldObjectState, equipmentSlot: number,
): { perm: number; temp: number } {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  const word = object.fields.get(first + equipmentSlot * stride + 1) ?? 0;
  return { perm: word & 0xffff, temp: (word >>> 16) & 0xffff };
}

/** Equipment slots whose attachment is a weapon the original client glows. */
const GLOW_WEAPON_SLOTS: ReadonlySet<number> = new Set([15, 16, 17]);

/**
 * The glow tint for one worn piece, if the dataset resolves one.
 *
 * Weapon slots only — a helmet never glows in the original client no matter what the table
 * says. The temporary enchant wins over the permanent one: oil over mongoose reads as oil,
 * which is what the brighter, fresher coat does on screen too.
 */
export function attachedGlowTint(
  object: WorldObjectState, equipmentSlot: number,
  glowModels: (enchantId: number) => readonly string[],
): EnchantGlow | undefined {
  if (object.typeId !== 4 || !GLOW_WEAPON_SLOTS.has(equipmentSlot)) return undefined;
  const { perm, temp } = visibleItemEnchants(object, equipmentSlot);
  for (const id of [temp, perm]) {
    if (id <= 0) continue;
    const tint = enchantGlowTint(glowModels(id));
    if (tint) return tint;
  }
  return undefined;
}

/**
 * 05.10-A7a-E (6.14): the glow of one worn weapon — its slots (the effect models) and the tint fallback, from
 * the first of the temporary and the permanent enchant that has either.
 *
 * 05.10-A7a-E2: and, when neither has one, the display's own ItemVisual (a legendary's glow) — for a player's
 * weapon and for a creature's held one (`UNIT_VIRTUAL_ITEM_SLOT_ID`, slots 15–17), through the attached piece's
 * `displayId` (absent from an older gateway: no display glow, as before). Called per worn weapon per frame, so
 * the answer is one remembered object per enchant and per display, re-made only when the source's arrays change.
 */
export function attachedGlow(
  object: WorldObjectState, equipmentSlot: number,
  source: Pick<ItemEnchantmentClient, "glowModels" | "glowSlots" | "displayGlowSlots">,
  displayId?: number,
): EnchantGlow | undefined {
  if (!GLOW_WEAPON_SLOTS.has(equipmentSlot)) return undefined;
  if (object.typeId === 4) {
    const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
    const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
    const word = object.fields.get(first + equipmentSlot * stride + 1) ?? 0; // visibleItemEnchants, without its object
    const glow = enchantGlowOf(source, (word >>> 16) & 0xffff) ?? enchantGlowOf(source, word & 0xffff);
    if (glow) return glow;
  } else if (object.typeId !== 3) {
    return undefined;
  }
  return displayId !== undefined && displayId > 0 ? displayGlowOf(source, displayId) : undefined;
}

// 05.10-A7a-E2: remembered glows, per source (the page's one client; a test's literal).
type GlowSource = Pick<ItemEnchantmentClient, "glowModels" | "glowSlots" | "displayGlowSlots">;
interface RememberedGlow {
  slots: readonly (string | null)[] | undefined;
  models: readonly string[] | undefined;
  glow: EnchantGlow | undefined;
}
const NO_GLOW_MODELS: readonly string[] = Object.freeze([]);
const rememberedGlows = new WeakMap<object, { enchants: Map<number, RememberedGlow>; displays: Map<number, RememberedGlow> }>();

function glowMemo(source: GlowSource): { enchants: Map<number, RememberedGlow>; displays: Map<number, RememberedGlow> } {
  let memo = rememberedGlows.get(source);
  if (!memo) {
    memo = { enchants: new Map(), displays: new Map() };
    rememberedGlows.set(source, memo);
  }
  return memo;
}

function enchantGlowOf(source: GlowSource, enchantId: number): EnchantGlow | undefined {
  if (enchantId <= 0) return undefined;
  const slots = source.glowSlots(enchantId);
  const models = source.glowModels(enchantId);
  const memo = glowMemo(source).enchants;
  const known = memo.get(enchantId);
  if (known && known.slots === slots && known.models === models) return known.glow;
  const tint = enchantGlowTint(models);
  const glow = slots || tint ? { color: tint?.color ?? 0, intensity: tint?.intensity ?? 0, ...(slots ? { slots } : {}) } : undefined;
  memo.set(enchantId, { slots, models, glow });
  return glow;
}

/**
 * The display's own glow: its slots only. No tint stand-in: the tint predates this path and stays where it
 * already was (an enchant on a weapon the effects cannot be hung on); a display glow never had one, and
 * inventing it for the 153 attachment-less displays (wands, orbs, bows) is not a fallback but a new guess.
 */
function displayGlowOf(source: GlowSource, displayId: number): EnchantGlow | undefined {
  const slots = source.displayGlowSlots(displayId);
  const memo = glowMemo(source).displays;
  const known = memo.get(displayId);
  if (known && known.slots === slots) return known.glow;
  const glow = slots ? { color: 0, intensity: 0, slots } : undefined;
  memo.set(displayId, { slots, models: undefined, glow });
  return glow;
}

export function itemSocketColors(sockets: readonly { color: number }[], enchantments: readonly number[] = []): number[] {
  const colors = Array.from({ length: 3 }, (_, index) => sockets[index]?.color ?? 0);
  const extra = colors.indexOf(0);
  if ((enchantments[6] ?? 0) > 0 && extra >= 0) colors[extra] = 14;
  return colors;
}

/** Ordinary colours may mismatch (losing the bonus); only meta vs ordinary is a hard gate. */
export function gemFitsSocket(socketColor: number, gemColor: number): boolean {
  return socketColor > 0 && gemColor > 0 && (socketColor === 1) === (gemColor === 1);
}

export function socketColorName(color: number): string {
  return ({ 1: "Особое гнездо", 2: "Красное гнездо", 4: "Жёлтое гнездо", 8: "Синее гнездо", 14: "Радужное гнездо" } as Record<number, string>)[color]
    ?? "Гнездо";
}
