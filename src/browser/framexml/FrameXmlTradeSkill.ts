/**
 * The stock Blizzard_TradeSkillUI's C API (`Blizzard_TradeSkillUI.lua`) over this client's own
 * profession data: the learned skill lines (`PLAYER_SKILL_INFO_1_1`), the known recipe spells with
 * their `SkillLineAbility` rows (`/dbc/talents`), each recipe's reagents and output (`/dbc/spells`
 * v10+), the carried items, and the native craft queue in `ui/Professions.ts`.
 *
 * Facts measured against the stock 3.3.5 Lua, this dataset and the active TrinityCore that shape it:
 *
 * * The window is the client's. SPELL_EFFECT_TRADE_SKILL (47) does nothing on the server
 *   (`Spell::EffectTradeSkill`, SpellEffects.cpp:2845-2855), so TRADE_SKILL_SHOW is this model's
 *   edge, fired when the owner opens a line — never before Blizzard_TradeSkillUI is loaded, because
 *   UIParent answers the event with `UIParentLoadAddOn` (UIParent.lua:975-980), which reports a
 *   load failure for an add-on this host has not loaded yet.
 * * Repeat crafting is client memory as well: the server sees one CMSG_CAST_SPELL per item. DoTradeSkill
 *   therefore hands the count to the native queue (`FrameXmlTradeSkillCraft`), and
 *   UPDATE_TRADESKILL_RECAST follows that queue's remaining count.
 * * TradeSkillRankFrame runs TradeSkillFrame_Update on SKILL_LINES_CHANGED even while the window is
 *   hidden (Blizzard_TradeSkillUI.xml:273-276), and that compares `rank < 75`: GetTradeSkillLine
 *   answers the client's closed-state "UNKNOWN", 0, 0 rather than nothing.
 * * The headings are the made item's `ItemSubClass.DisplayName` — the subclass the stock verbs
 *   (`CollapseTradeSkillSubClass`, `GetTradeSkillSubClasses`) are named after. «Топор» names both
 *   one- and two-handed axes on this dataset, so the headings are keyed by that name. A recipe that
 *   makes no item (an enchant) has no heading. Within a heading the recipes run from the highest
 *   `TrivialSkillLineRankLow` down, then by name; the live client's own order is an owner check.
 * * `altVerb` — the Create button's word for a recipe that makes no item — is the skill line's
 *   `SkillLine.AlternateVerb_lang` (164 «Выковать», 333 «Зачаровать», 165 «Украсить» on this
 *   dataset). `/dbc/talents` does not carry that column yet; until it does, an enchant answers the
 *   client's own ENSCRIBE («Зачаровать»), which is the measured value for Enchanting (the Lua prelude
 *   below resolves it).
 * * Rows are held still between the reads of one redraw: they are rebuilt only by a command (a
 *   filter, a heading) or by the per-frame check that fires TRADE_SKILL_UPDATE. A late item reply
 *   therefore reshapes the list at the next update, never in the middle of TradeSkillFrame_Update.
 *
 * Linked trade skills (`|Htrade:` chat links, `IsTradeSkillLinked`) stay closed: the link's recipe
 * bitmask is the client's internal encoding over SkillLineAbility order and nothing here can verify
 * it offline, so GetTradeSkillListLink answers nil and the stock link button stays hidden.
 */
import type { SpellMetadata } from "../SpellMetadata.js";
import type { SpellSkillAbilityInfo } from "../../gateway/TalentMetadata.js";
import type { WorldObjectState, WorldState } from "../../world/WorldState.js";
import {
  craftableCount, learnedProfessions, professionOpener, professionRecipes, professionSpellSkill, recipeAcceptsItem,
  recipeDifficulty, recipeRequiresItem, type ProfessionData,
} from "../ui/ProfessionRules.js";
import { effectiveSkill, readSkills } from "../ui/Skills.js";
import { entryOf, playerInventory, stackCount, type ItemSlotState } from "../Inventory.js";
import { itemChatLink } from "../ui/ChatLink.js";
import { formatSpellDescription } from "../ui/SpellText.js";
import { globalString } from "../../generated/globalStrings.js";
import { frameXmlNativeTargeting, runFrameXmlNativeEscape } from "./FrameXmlGameMenuController.js";

/** SharedDefines.h: SPELL_EFFECT_CREATE_ITEM and SPELL_EFFECT_CREATE_ITEM_2. */
const ITEM_CREATION_EFFECTS: readonly number[] = [24, 157];
/** `CHAT_LINK_COLOR_ENCHANT`/`_TRADE` (SharedDefines.h:3216-3219), the colour Hyperlinks.cpp checks. */
const ENCHANT_LINK_COLOR = "ffffd000";
/** The Lua prelude turns this into the client's ENSCRIBE string (see the file comment). */
export const FRAMEXML_TRADESKILL_ENSCRIBE = "__fxEnscribe";
/** The stock input box takes three digits (`TradeSkillInputBox letters="3"`). */
export const FRAMEXML_TRADESKILL_REPEAT_MAX = 999;
/** How often the open window re-reads skills, recipes, bags and item replies, in seconds. */
const CHECK_SECONDS = 0.25;

/** `InventoryType` to the GlobalStrings.lua name the stock inventory-slot filter lists (via the prelude). */
const INVENTORY_TYPE_TOKENS: Readonly<Record<number, string>> = {
  1: "INVTYPE_HEAD", 2: "INVTYPE_NECK", 3: "INVTYPE_SHOULDER", 4: "INVTYPE_BODY", 5: "INVTYPE_CHEST",
  6: "INVTYPE_WAIST", 7: "INVTYPE_LEGS", 8: "INVTYPE_FEET", 9: "INVTYPE_WRIST", 10: "INVTYPE_HAND",
  11: "INVTYPE_FINGER", 12: "INVTYPE_TRINKET", 13: "INVTYPE_WEAPON", 14: "INVTYPE_SHIELD",
  15: "INVTYPE_RANGED", 16: "INVTYPE_CLOAK", 17: "INVTYPE_2HWEAPON", 18: "INVTYPE_BAG",
  19: "INVTYPE_TABARD", 21: "INVTYPE_WEAPONMAINHAND", 22: "INVTYPE_WEAPONOFFHAND",
  23: "INVTYPE_HOLDABLE", 24: "INVTYPE_AMMO", 25: "INVTYPE_THROWN", 26: "INVTYPE_RANGEDRIGHT",
  27: "INVTYPE_QUIVER", 28: "INVTYPE_RELIC",
};

/** A robe (20) is a chest piece to the slot filter: INVTYPE_ROBE and INVTYPE_CHEST are one word. */
function slotType(inventoryType: number): number {
  return inventoryType === 20 ? 5 : inventoryType;
}

export type FrameXmlTradeSkillType = "optimal" | "medium" | "easy" | "trivial";

/** One learned trade skill line as GetTradeSkillLine reports it. */
export interface FrameXmlTradeSkillLine {
  readonly skillId: number;
  readonly name: string;
  readonly value: number;
  readonly max: number;
  /** Both skill bonuses together: GetTradeSkillLine's fourth value. */
  readonly modifier: number;
  /** `SkillLine.AlternateVerb_lang`, when the metadata carries it. */
  readonly alternateVerb?: string | undefined;
}

export interface FrameXmlTradeSkillRecipeSource {
  readonly spell: SpellMetadata;
  /** The recipe's `SkillLineAbility` row for this line: the difficulty bands. */
  readonly ability?: SpellSkillAbilityInfo | undefined;
}

export interface FrameXmlTradeSkillItem {
  readonly name: string;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
}

/** The `item_template` facts the headings, slot filter, level filter and an enchant's target need. */
export interface FrameXmlTradeSkillItemClass {
  readonly itemClass: number;
  readonly subClass: number;
  readonly inventoryType: number;
  readonly requiredLevel?: number | undefined;
}

/**
 * The native craft path (`ui/Professions.ts`), which owns the repeat queue and its cast tracking.
 * Every verdict stays the server's; these only send, stop and report.
 */
export interface FrameXmlTradeSkillCraft {
  /** Queue `count` casts of a known recipe; false when nothing was sent. */
  craft(spellId: number, count: number): boolean;
  /** One enchant cast on a carried item; false when nothing was sent. */
  castOnItem?(spellId: number, itemGuid: bigint): boolean;
  /** StopTradeSkillRepeat: the queue ends after the cast in flight. */
  stop(): void;
  /** Casts still to go, the one in flight included; 0 while nothing is crafting. */
  remaining(): number;
}

/** What the model reads; the live world and the canned fixture both answer it. */
export interface FrameXmlTradeSkillSource {
  /** The learned profession line with this id, or undefined when the character has none. */
  line(skillId: number): FrameXmlTradeSkillLine | undefined;
  /** The known recipes of a line. */
  recipes(skillId: number): readonly FrameXmlTradeSkillRecipeSource[];
  /** Carried item counts by entry. */
  carried(): ReadonlyMap<number, number>;
  /** TotemCategory ids of the carried items, when the host knows them. */
  toolCategories?(): ReadonlySet<number>;
  /** Whole seconds of cooldown left on a recipe; 0 when ready. */
  cooldown(spellId: number): number;
  /** Cache-only item presentation; a C-API read never starts a fetch. */
  item(entry: number): FrameXmlTradeSkillItem | undefined;
  itemClass(entry: number): FrameXmlTradeSkillItemClass | undefined;
  /** `ItemSubClass.DisplayName_lang`, cache-only. */
  subclassName(itemClass: number, subClass: number): string | undefined;
  /** The recipe's description with its markers filled in. */
  description?(spell: SpellMetadata): string | undefined;
  /** Load item metadata outside a C-API read; `onChanged` runs once something arrived. */
  prefetch?(entries: readonly number[], onChanged: () => void): void;
  /** The item class facts of a carried item, for an enchant's target. */
  carriedItem?(guid: bigint): FrameXmlTradeSkillItemClass | undefined;
  readonly craft?: FrameXmlTradeSkillCraft | undefined;
  /** The world this source reads; when it changes the window closes (a new character, a new world). */
  token?(): unknown;
  /** The line a profession's opener spell opens; without it, the spell's own SPELL_EFFECT_SKILL (118) row. */
  openerSkill?(spell: SpellMetadata): number | undefined;
}

interface FrameXmlTradeSkillPump {
  fire(event: string, ...args: readonly unknown[]): number;
  now(): number;
}

interface HeaderRow {
  readonly kind: "header";
  readonly name: string;
  readonly expanded: boolean;
}

interface RecipeRow {
  readonly kind: "recipe";
  readonly spell: SpellMetadata;
  readonly ability: SpellSkillAbilityInfo | undefined;
  readonly type: FrameXmlTradeSkillType;
  readonly header: string | undefined;
  /** The made item, or undefined for an enchant or another item-less recipe. */
  readonly item: number | undefined;
  readonly makeIndex: number;
  readonly available: number | undefined;
}

type Row = HeaderRow | RecipeRow;

interface Snapshot {
  readonly line: FrameXmlTradeSkillLine;
  readonly rows: readonly Row[];
  readonly subclasses: readonly string[];
  /** Normalised inventory types, ascending (the slot filter's order). */
  readonly slots: readonly number[];
}

const DIFFICULTY_TYPES: Readonly<Record<string, FrameXmlTradeSkillType>> = {
  orange: "optimal", yellow: "medium", green: "easy", gray: "trivial",
};

function madeItem(spell: SpellMetadata): { entry: number; index: number } | undefined {
  const effects = spell.effects ?? [];
  for (let index = 0; index < effects.length; index += 1) {
    const entry = spell.effectItemType?.[index] ?? 0;
    if (ITEM_CREATION_EFFECTS.includes(effects[index] ?? 0) && entry > 0) return { entry, index };
  }
  return undefined;
}

function enchantLink(spellId: number, text: string): string {
  return `|c${ENCHANT_LINK_COLOR}|Henchant:${spellId}|h[${text}]|h|r`;
}

/**
 * One owner of the stock trade skill C API. Which line is open, the selection, the collapsed
 * headings and the filters are client memory, as they are in the client; everything else is read
 * from the source each time the rows are rebuilt.
 */
export class FrameXmlTradeSkillModel {
  readonly #source: FrameXmlTradeSkillSource;
  #pump: FrameXmlTradeSkillPump | undefined;
  #muted = false;
  /** The open trade skill line; undefined while no trade skill is open. */
  #skillId: number | undefined;
  /** TRADE_SKILL_SHOW went out for the open line and TRADE_SKILL_CLOSE has not. */
  #shown = false;
  #token: unknown;
  #snapshot: Snapshot | undefined;
  #selected: number | undefined;
  readonly #collapsed = new Set<string>();
  #subClassFilter = 0;
  #slotFilter = 0;
  #nameFilter = "";
  #levelMin = 0;
  #levelMax = 0;
  #onlyMakeable = false;
  /** An enchant's DoTradeSkill waiting for the item it goes on; changed only through #setTargeting. */
  #targeting: number | undefined;
  readonly #targetingObservers = new Set<(armed: boolean) => void>();
  readonly #deferred: string[] = [];
  #signature = "";
  #checkedAt = Number.NEGATIVE_INFINITY;
  #remaining = 0;
  readonly #prefetched = new Set<number>();

  constructor(source: FrameXmlTradeSkillSource) {
    this.#source = source;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlTradeSkillPump): void {
    this.detach();
    this.#pump = pump;
  }

  detach(): void {
    this.#pump = undefined;
    this.#reset();
  }

  /** Forget the open line without an event (a torn-down VM, a failed owner). */
  release(): void {
    this.#reset();
  }

  #reset(): void {
    this.#skillId = undefined;
    this.#shown = false;
    this.#token = undefined;
    this.#snapshot = undefined;
    this.#setTargeting(undefined);
    this.#deferred.length = 0;
    this.#signature = "";
    this.#checkedAt = Number.NEGATIVE_INFINITY;
  }

  /** Run a transactional probe (the owner's gate) without a packet or an event. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** The open line, whether or not its window is showing. */
  get skillId(): number | undefined { return this.#skillId; }
  get showing(): boolean { return this.#shown; }
  /** The enchant waiting for an item (SpellCanTargetItem), if any. */
  get targeting(): number | undefined { return this.#targeting; }

  /**
   * Follow the enchant cursor going up (true) and down: the host draws the client's cast cursor
   * meanwhile. The returned function stops following.
   */
  observeTargeting(observer: (armed: boolean) => void): () => void {
    this.#targetingObservers.add(observer);
    return () => { this.#targetingObservers.delete(observer); };
  }

  #setTargeting(spellId: number | undefined): void {
    const was = this.#targeting !== undefined;
    this.#targeting = spellId;
    if (was === (spellId !== undefined)) return;
    for (const observer of [...this.#targetingObservers]) {
      try { observer(spellId !== undefined); } catch { /* a cursor is presentation; the model goes on */ }
    }
  }

  /**
   * IsSelectedSpell/IsCurrentAction for a profession's opener: true while that line's window shows,
   * which is why stock SpellBookFrame and ActionButton repaint on TRADE_SKILL_SHOW/CLOSE.
   */
  openerShowing(spell: SpellMetadata | undefined): boolean {
    if (!this.#shown || this.#skillId === undefined || !spell || !professionOpener(spell)) return false;
    const skillId = this.#source.openerSkill ? this.#source.openerSkill(spell) : professionSpellSkill(spell, undefined);
    return skillId === this.#skillId;
  }

  /** Whether the character has this profession line, i.e. whether `open` would take it. */
  canOpen(skillId: number): boolean {
    return this.#source.line(skillId) !== undefined;
  }

  /**
   * Make `skillId` the open line. A different line starts from the client's defaults: no filter,
   * every heading open and no selection; the same line keeps what the player left.
   */
  open(skillId: number): boolean {
    if (!this.#source.line(skillId)) return false;
    if (skillId !== this.#skillId) {
      this.#selected = undefined;
      this.#collapsed.clear();
      this.#subClassFilter = 0;
      this.#slotFilter = 0;
      this.#nameFilter = "";
      this.#levelMin = 0;
      this.#levelMax = 0;
      this.#setTargeting(undefined);
    }
    this.#skillId = skillId;
    this.#token = this.#source.token?.();
    this.#snapshot = undefined;
    this.#signature = this.#dataSignature();
    this.#checkedAt = this.#pump?.now() ?? Number.NEGATIVE_INFINITY;
    // Each opening asks again for what is still missing; the metadata client keeps its own backoff.
    this.#prefetched.clear();
    this.#prefetch();
    return true;
  }

  /** TRADE_SKILL_SHOW for the open line (the owner calls this once Blizzard_TradeSkillUI is gated). */
  show(): boolean {
    const pump = this.#pump;
    if (!pump || this.#skillId === undefined || this.#muted) return false;
    this.#shown = true;
    this.#remaining = this.#source.craft?.remaining() ?? 0;
    // Anything queued for the previous paint is stale: SHOW repaints everything.
    this.#deferred.length = 0;
    pump.fire("TRADE_SKILL_SHOW");
    return true;
  }

  /**
   * CloseTradeSkill: the open line closes, the repeat queue stops after its cast and an enchant
   * waiting for a target is dropped. TRADE_SKILL_CLOSE is synchronous — UIParent answers it with
   * HideUIPanel (UIParent.lua:982-986), which is inert for a window already hiding — so a SHOW for
   * the next line can never be overtaken by a stale close.
   */
  close(): void {
    if (this.#muted) return;
    const wasShown = this.#shown;
    const wasOpen = this.#skillId !== undefined;
    this.#reset();
    if (wasOpen) this.#source.craft?.stop();
    if (wasShown) this.#pump?.fire("TRADE_SKILL_CLOSE");
  }

  /** Per rendered frame: deferred events, the repeat count, and a data change (bags, skill, replies). */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    if (this.#skillId !== undefined && this.#source.token && this.#source.token() !== this.#token) {
      this.close();
      return;
    }
    if (this.#shown) {
      const remaining = this.#source.craft?.remaining() ?? 0;
      if (remaining !== this.#remaining) {
        this.#remaining = remaining;
        this.#queue("UPDATE_TRADESKILL_RECAST");
      }
      const now = pump.now();
      if (now - this.#checkedAt >= CHECK_SECONDS) {
        this.#checkedAt = now;
        const signature = this.#dataSignature();
        if (signature !== this.#signature) {
          this.#signature = signature;
          if (!this.#source.line(this.#skillId!)) {
            // The profession was unlearned while its window was open.
            this.close();
            return;
          }
          this.#snapshot = undefined;
          this.#prefetch();
          this.#queue("TRADE_SKILL_UPDATE");
        }
      }
    }
    if (this.#deferred.length === 0) return;
    const events = this.#deferred.splice(0);
    for (const event of events) {
      if (!this.#shown) break;
      pump.fire(event);
    }
  }

  /** Events raised from inside a C-API call go out on the next frame, never re-entering the caller. */
  #queue(event: string): void {
    if (this.#muted || !this.#shown || this.#deferred.includes(event)) return;
    this.#deferred.push(event);
  }

  // ---- the rows --------------------------------------------------------------------------

  #current(): Snapshot | undefined {
    if (this.#skillId === undefined) return undefined;
    this.#snapshot ??= this.#build(this.#skillId);
    return this.#snapshot;
  }

  #build(skillId: number): Snapshot | undefined {
    const source = this.#source;
    const line = source.line(skillId);
    if (!line) return undefined;
    const carried = source.carried();
    const recipes: RecipeRow[] = source.recipes(skillId).map(({ spell, ability }) => {
      const made = madeItem(spell);
      const facts = made ? source.itemClass(made.entry) : undefined;
      const header = facts ? source.subclassName(facts.itemClass, facts.subClass) || undefined : undefined;
      const difficulty = recipeDifficulty(
        { skillId, step: 0, value: line.value, max: line.max, temporaryBonus: 0, permanentBonus: 0 }, ability);
      return {
        kind: "recipe", spell, ability, type: DIFFICULTY_TYPES[difficulty] ?? "trivial", header,
        item: made?.entry, makeIndex: made?.index ?? -1, available: craftableCount(spell, carried),
      };
    });
    const byName = (left: string, right: string): number => left.localeCompare(right, "ru");
    const subclasses = [...new Set(recipes.map((row) => row.header).filter((name): name is string => !!name))]
      .sort(byName);
    const slots = [...new Set(recipes.flatMap((row) => this.#slotsOf(row)))].sort((left, right) => left - right);
    const wantedHeader = this.#subClassFilter > 0 ? subclasses[this.#subClassFilter - 1] : undefined;
    const wantedSlot = this.#slotFilter > 0 ? slots[this.#slotFilter - 1] : undefined;
    const query = this.#nameFilter.toLocaleLowerCase("ru");
    const visible = recipes.filter((row) => {
      if (wantedHeader !== undefined && row.header !== wantedHeader) return false;
      if (wantedSlot !== undefined && !this.#slotsOf(row).includes(wantedSlot)) return false;
      if (this.#onlyMakeable && !(row.available === Infinity || (row.available ?? 0) > 0)) return false;
      if (query) {
        const itemName = row.item === undefined ? undefined : source.item(row.item)?.name;
        if (!row.spell.name.toLocaleLowerCase("ru").includes(query)
          && !(itemName?.toLocaleLowerCase("ru").includes(query) ?? false)) return false;
      }
      if (this.#levelMin > 0 || this.#levelMax > 0) {
        const level = row.item === undefined ? undefined : source.itemClass(row.item)?.requiredLevel;
        if (level === undefined || level < this.#levelMin || level > Math.max(this.#levelMin, this.#levelMax)) return false;
      }
      return true;
    });
    const order = (left: RecipeRow, right: RecipeRow): number =>
      (right.ability?.trivialSkillLineRankLow ?? 0) - (left.ability?.trivialSkillLineRankLow ?? 0)
      || (right.ability?.trivialSkillLineRankHigh ?? 0) - (left.ability?.trivialSkillLineRankHigh ?? 0)
      || byName(left.spell.name, right.spell.name);
    const rows: Row[] = visible.filter((row) => row.header === undefined).sort(order);
    for (const header of subclasses) {
      const members = visible.filter((row) => row.header === header);
      if (members.length === 0) continue;
      const expanded = !this.#collapsed.has(header);
      rows.push({ kind: "header", name: header, expanded });
      if (expanded) rows.push(...members.sort(order));
    }
    return { line, rows, subclasses, slots };
  }

  /** The inventory types a recipe's result goes on: the made item's, or an enchant's allowed slots. */
  #slotsOf(row: RecipeRow): number[] {
    if (row.item !== undefined) {
      const type = this.#source.itemClass(row.item)?.inventoryType ?? 0;
      return INVENTORY_TYPE_TOKENS[slotType(type)] ? [slotType(type)] : [];
    }
    const mask = row.spell.equippedItemInvTypes ?? 0;
    const types: number[] = [];
    for (let type = 1; type <= 28; type += 1) {
      if ((mask & (1 << type)) !== 0 && INVENTORY_TYPE_TOKENS[slotType(type)] && !types.includes(slotType(type))) {
        types.push(slotType(type));
      }
    }
    return types;
  }

  #row(index: unknown): Row | undefined {
    const number = typeof index === "number" ? index : typeof index === "string" ? Number(index) : NaN;
    if (!Number.isInteger(number) || number < 1) return undefined;
    return this.#current()?.rows[number - 1];
  }

  #recipe(index: unknown): RecipeRow | undefined {
    const row = this.#row(index);
    return row?.kind === "recipe" ? row : undefined;
  }

  /** What makes a repaint necessary: the line, the recipes, the reagents carried and item replies. */
  #dataSignature(): string {
    const skillId = this.#skillId;
    if (skillId === undefined) return "";
    const source = this.#source;
    const line = source.line(skillId);
    if (!line) return "-";
    const carried = source.carried();
    const categories = source.toolCategories?.();
    const parts: string[] = [`${line.value}:${line.max}:${line.modifier}:${line.name}`];
    for (const { spell } of source.recipes(skillId)) {
      const made = madeItem(spell);
      const facts = made ? source.itemClass(made.entry) : undefined;
      let part = `${spell.id}:${spell.reagents === undefined ? "?" : ""}`;
      if (made) {
        part += `${source.item(made.entry) ? "i" : ""}${facts ? `c${facts.itemClass}.${facts.subClass}` : ""}`
          + `${facts && source.subclassName(facts.itemClass, facts.subClass) ? "n" : ""}`;
      }
      for (const reagent of spell.reagents ?? []) {
        part += `,${reagent.itemId}x${carried.get(reagent.itemId) ?? 0}${source.item(reagent.itemId) ? "i" : ""}`;
      }
      for (const tool of spell.tools ?? []) part += `,t${tool}${carried.has(tool) ? 1 : 0}`;
      for (const category of spell.requiredToolCategories ?? []) part += `,k${category}${categories?.has(category) ? 1 : 0}`;
      if (source.cooldown(spell.id) > 0) part += ",cd";
      parts.push(part);
    }
    return parts.join("|");
  }

  /** Ask once for every made item and reagent the cache does not have. */
  #prefetch(): void {
    const skillId = this.#skillId;
    const source = this.#source;
    if (skillId === undefined || !source.prefetch) return;
    const wanted = new Set<number>();
    for (const { spell } of source.recipes(skillId)) {
      const made = madeItem(spell);
      if (made) wanted.add(made.entry);
      for (const reagent of spell.reagents ?? []) wanted.add(reagent.itemId);
      for (const tool of spell.tools ?? []) wanted.add(tool);
    }
    const missing = [...wanted].filter((entry) => entry > 0 && !this.#prefetched.has(entry)
      && (!source.item(entry) || !source.itemClass(entry)));
    if (missing.length === 0) return;
    for (const entry of missing) this.#prefetched.add(entry);
    source.prefetch(missing, () => { this.#checkedAt = Number.NEGATIVE_INFINITY; });
  }

  // ---- reads -----------------------------------------------------------------------------

  /** GetTradeSkillLine: name, rank, max rank, modifier — "UNKNOWN", 0, 0 while nothing is open. */
  line(): readonly [string, number, number, number] {
    const line = this.#current()?.line;
    return line ? [line.name, line.value, line.max, line.modifier] : ["UNKNOWN", 0, 0, 0];
  }

  count(): number {
    return this.#current()?.rows.length ?? 0;
  }

  /** GetTradeSkillInfo: skillName, skillType, numAvailable, isExpanded, altVerb. */
  info(index: unknown): readonly unknown[] | undefined {
    const row = this.#row(index);
    if (!row) return undefined;
    if (row.kind === "header") return [row.name, "header", 0, row.expanded];
    const available = row.available === undefined || row.available === Infinity ? 0 : row.available;
    return [row.spell.name, row.type, available, false, this.#altVerb(row)];
  }

  #altVerb(row: RecipeRow): string | undefined {
    if (row.item !== undefined) return undefined;
    const verb = this.#current()?.line.alternateVerb;
    if (verb) return verb;
    return recipeRequiresItem(row.spell) ? FRAMEXML_TRADESKILL_ENSCRIBE : undefined;
  }

  /** GetFirstTradeSkill: the first recipe row, 0 when the list has none. */
  first(): number {
    const rows = this.#current()?.rows ?? [];
    const index = rows.findIndex((row) => row.kind === "recipe");
    return index + 1;
  }

  selectionIndex(): number {
    if (this.#selected === undefined) return 0;
    const rows = this.#current()?.rows ?? [];
    return rows.findIndex((row) => row.kind === "recipe" && row.spell.id === this.#selected) + 1;
  }

  select(index: unknown): void {
    const row = this.#recipe(index);
    if (row) this.#selected = row.spell.id;
  }

  icon(index: unknown): string | undefined {
    const row = this.#recipe(index);
    if (!row) return undefined;
    const texture = row.item === undefined ? undefined : this.#source.item(row.item)?.texture;
    return texture ?? (row.spell.iconPath || undefined);
  }

  /** GetTradeSkillNumMade: the made stack's range, `EffectBasePoints + 1` to `+ EffectDieSides`. */
  numMade(index: unknown): readonly [number, number] {
    const row = this.#recipe(index);
    if (!row) return [0, 0];
    if (row.makeIndex < 0) return [1, 1];
    const base = row.spell.effectBasePoints[row.makeIndex] ?? 0;
    const sides = Math.max(1, row.spell.effectDieSides[row.makeIndex] ?? 1);
    return [Math.max(1, base + 1), Math.max(1, base + sides)];
  }

  numReagents(index: unknown): number {
    return this.#recipe(index)?.spell.reagents?.length ?? 0;
  }

  #reagent(index: unknown, reagent: unknown): { itemId: number; count: number } | undefined {
    const row = this.#recipe(index);
    const number = typeof reagent === "number" ? reagent : Number(reagent);
    return row && Number.isInteger(number) && number >= 1 ? row.spell.reagents?.[number - 1] : undefined;
  }

  /** GetTradeSkillReagentInfo: name, texture, count, playerCount; the name waits for the item reply. */
  reagentInfo(index: unknown, reagent: unknown): readonly unknown[] | undefined {
    const wanted = this.#reagent(index, reagent);
    if (!wanted) return undefined;
    const item = this.#source.item(wanted.itemId);
    return [item?.name, item?.texture, wanted.count, this.#source.carried().get(wanted.itemId) ?? 0];
  }

  reagentLink(index: unknown, reagent: unknown): string | undefined {
    const wanted = this.#reagent(index, reagent);
    const item = wanted ? this.#source.item(wanted.itemId) : undefined;
    return wanted && item ? itemChatLink(wanted.itemId, item.quality ?? 1, item.name) : undefined;
  }

  /** GetTradeSkillItemLink: the made item, or the enchant itself for a recipe that makes none. */
  itemLink(index: unknown): string | undefined {
    const row = this.#recipe(index);
    if (!row) return undefined;
    if (row.item === undefined) return enchantLink(row.spell.id, row.spell.name);
    const item = this.#source.item(row.item);
    return item ? itemChatLink(row.item, item.quality ?? 1, item.name) : undefined;
  }

  /**
   * GetTradeSkillRecipeLink: `[Skill: Recipe]`, the alternate text TrinityCore's enchant link
   * validator accepts beside the bare spell name (Hyperlinks.cpp:230-260).
   */
  recipeLink(index: unknown): string | undefined {
    const row = this.#recipe(index);
    const line = this.#current()?.line;
    return row && line ? enchantLink(row.spell.id, `${line.name}: ${row.spell.name}`) : undefined;
  }

  /** GetTradeSkillTools: name/has pairs for BuildColoredListString (`Totem` items, `TotemCategory`). */
  tools(index: unknown): readonly unknown[] {
    const row = this.#recipe(index);
    if (!row) return [];
    const carried = this.#source.carried();
    const categories = this.#source.toolCategories?.();
    const answer: unknown[] = [];
    for (const tool of row.spell.tools ?? []) {
      const name = this.#source.item(tool)?.name;
      if (name) answer.push(name, carried.has(tool));
    }
    for (const [slot, category] of (row.spell.requiredToolCategories ?? []).entries()) {
      const name = row.spell.requiredToolNames?.[slot];
      if (name) answer.push(name, categories?.has(category) ?? false);
    }
    return answer;
  }

  cooldown(index: unknown): number | undefined {
    const row = this.#recipe(index);
    const seconds = row ? this.#source.cooldown(row.spell.id) : 0;
    return seconds > 0 ? seconds : undefined;
  }

  description(index: unknown): string | undefined {
    const row = this.#recipe(index);
    const text = row ? this.#source.description?.(row.spell) ?? row.spell.description : undefined;
    return text ? text : undefined;
  }

  repeatCount(): number {
    const remaining = this.#source.craft?.remaining() ?? 0;
    return remaining > 0 ? remaining : 1;
  }

  // ---- filters and headings ----------------------------------------------------------------

  subclasses(): readonly string[] {
    return this.#current()?.subclasses ?? [];
  }

  /** GetTradeSkillInvSlots: GlobalStrings names, resolved by the prelude. */
  slotTokens(): readonly string[] {
    return (this.#current()?.slots ?? []).map((type) => INVENTORY_TYPE_TOKENS[type]!);
  }

  subClassFilter(index: unknown): boolean {
    const number = Number(index);
    return number === 0 ? this.#subClassFilter === 0 : Number.isInteger(number) && this.#subClassFilter === number;
  }

  slotFilter(index: unknown): boolean {
    const number = Number(index);
    return number === 0 ? this.#slotFilter === 0 : Number.isInteger(number) && this.#slotFilter === number;
  }

  /** SetTradeSkillSubClassFilter(index, onOff, exclusive): stock always asks for one, exclusively. */
  setSubClassFilter(index: unknown, on: boolean): void {
    const number = Number(index);
    if (!Number.isInteger(number) || number < 0) return;
    const next = on ? number : number === this.#subClassFilter ? 0 : this.#subClassFilter;
    if (next === this.#subClassFilter) return;
    this.#subClassFilter = next;
    this.#filtered();
  }

  setSlotFilter(index: unknown, on: boolean): void {
    const number = Number(index);
    if (!Number.isInteger(number) || number < 0) return;
    const next = on ? number : number === this.#slotFilter ? 0 : this.#slotFilter;
    if (next === this.#slotFilter) return;
    this.#slotFilter = next;
    this.#filtered();
  }

  /** SetTradeSkillItemNameFilter; nil (the level search's call) clears it. */
  setNameFilter(value: unknown): void {
    const next = typeof value === "string" ? value.trim() : "";
    if (next === this.#nameFilter) return;
    this.#nameFilter = next;
    this.#filtered();
  }

  setLevelFilter(min: unknown, max: unknown): void {
    const low = Math.max(0, Math.trunc(Number(min)) || 0);
    const high = Math.max(0, Math.trunc(Number(max)) || 0);
    if (low === this.#levelMin && high === this.#levelMax) return;
    this.#levelMin = low;
    this.#levelMax = high;
    this.#filtered();
  }

  onlyMakeable(value: unknown): void {
    const next = value !== undefined && value !== null && value !== false && value !== 0;
    if (next === this.#onlyMakeable) return;
    this.#onlyMakeable = next;
    this.#filtered();
  }

  #filtered(): void {
    this.#snapshot = undefined;
    this.#queue("TRADE_SKILL_FILTER_UPDATE");
  }

  /** Expand/CollapseTradeSkillSubClass: index 0 is every heading (the collapse-all button). */
  setExpanded(index: unknown, expanded: boolean): void {
    const snapshot = this.#current();
    if (!snapshot) return;
    const number = Number(index);
    let changed = false;
    if (number === 0) {
      if (expanded) {
        changed = this.#collapsed.size > 0;
        this.#collapsed.clear();
      } else {
        for (const header of snapshot.subclasses) {
          if (!this.#collapsed.has(header)) { this.#collapsed.add(header); changed = true; }
        }
      }
    } else {
      const row = this.#row(number);
      if (row?.kind !== "header" || row.expanded === expanded) return;
      if (expanded) this.#collapsed.delete(row.name); else this.#collapsed.add(row.name);
      changed = true;
    }
    if (!changed) return;
    // The stock header click repaints on its own stack (TradeSkillSkillButton_OnClick); the
    // collapse-all button relies on the TRADE_SKILL_UPDATE that follows on the next frame.
    this.#snapshot = undefined;
    this.#queue("TRADE_SKILL_UPDATE");
  }

  // ---- commands --------------------------------------------------------------------------

  /**
   * DoTradeSkill(index, repeat): a recipe that makes something goes to the native queue with its
   * count; an enchant waits for the item it goes on, as the client's targeting cursor does.
   */
  doTradeSkill(index: unknown, repeat: unknown): void {
    if (this.#muted || !this.#shown) return;
    const row = this.#recipe(index);
    const craft = this.#source.craft;
    if (!row || !craft) return;
    if (recipeRequiresItem(row.spell)) {
      this.#setTargeting(row.spell.id);
      return;
    }
    const count = Math.max(1, Math.min(FRAMEXML_TRADESKILL_REPEAT_MAX, Math.trunc(Number(repeat)) || 1));
    this.#setTargeting(undefined);
    craft.craft(row.spell.id, count);
  }

  /**
   * StopTradeSkillRepeat for the open line. With none open it is inert: TradeSkillRankFrame runs
   * TradeSkillFrame_Update on every SKILL_LINES_CHANGED while hidden, and that calls this whenever
   * GetTradeSkillLine's closed "UNKNOWN" differs from CURRENT_TRADESKILL — which would otherwise cut
   * a queue the native craft window started (a skill-up from crafting raises that event).
   */
  stopRepeat(): void {
    if (this.#muted || this.#skillId === undefined) return;
    this.#source.craft?.stop();
  }

  /**
   * An item was clicked while an enchant waits for one (UseContainerItem, PickupInventoryItem):
   * true when the click was the target's — it is then consumed whether or not the item fits.
   *
   * The enchant is looked up among the line's recipes, not the rows on show: a filter or a collapsed
   * heading may hide it while the cursor is up, as neither drops the client's spell cursor.
   */
  targetItem(guid: bigint | undefined): boolean {
    const spellId = this.#targeting;
    if (spellId === undefined || this.#muted) return false;
    const skillId = this.#skillId;
    const spell = skillId === undefined ? undefined
      : this.#source.recipes(skillId).find((recipe) => recipe.spell.id === spellId)?.spell;
    if (!spell) {
      // The recipe is gone (unlearned): the cursor has nothing left to cast and the click is a click.
      this.#setTargeting(undefined);
      return false;
    }
    if (guid === undefined || guid === 0n) return true;
    const facts = this.#source.carriedItem?.(guid);
    if (!facts) return true;
    // The client refuses an item the enchant cannot go on without sending anything, keeps the cursor
    // and says so in the error frame; ProfessionRules' check is the one the native picker lists by.
    if (!recipeAcceptsItem(spell, facts)) {
      const refusal = globalString("SPELL_FAILED_BAD_TARGETS");
      if (refusal) this.#pump?.fire("UI_ERROR_MESSAGE", refusal);
      return true;
    }
    this.#setTargeting(undefined);
    this.#source.craft?.castOnItem?.(spellId, guid);
    return true;
  }

  /** SpellStopTargeting for the enchant cursor; true when there was one. */
  cancelTargeting(): boolean {
    if (this.#targeting === undefined) return false;
    this.#setTargeting(undefined);
    return true;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlTradeSkillHost {
  readonly tradeSkill?: FrameXmlTradeSkillModel | undefined;
}

export type FrameXmlTradeSkillBinding = (host: FrameXmlTradeSkillHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

const read = (answer: (model: FrameXmlTradeSkillModel, args: readonly unknown[]) => readonly unknown[],
  closed: readonly unknown[] = NOTHING): FrameXmlTradeSkillBinding =>
  (host, args) => host.tradeSkill ? answer(host.tradeSkill, args) : closed;

const command = (run: (model: FrameXmlTradeSkillModel, args: readonly unknown[]) => void): FrameXmlTradeSkillBinding =>
  (host, args) => { if (host.tradeSkill) run(host.tradeSkill, args); return NOTHING; };

/**
 * The flat C API Blizzard_TradeSkillUI calls, plus SpellCanTargetItem for the enchant cursor
 * (ContainerFrameItemButton_OnClick, ContainerFrame.lua:698, routes a bag click to UseContainerItem
 * while it answers true). `GetTradeSkillSubClasses`/`GetTradeSkillInvSlots` answer varargs.
 *
 * That cursor is the client's spell cursor, so SpellIsTargeting and SpellStopTargeting answer for
 * it before the native ground reticle, which the game menu's escape steps own (Controls.ts,
 * FrameXmlGameMenuController.ts; FrameXmlGameMenuOwner leaves a seam-bound name to the seam). Stock
 * ToggleGameMenu stops at SpellStopTargeting, so one Escape drops the waiting enchant and the next
 * reaches CloseAllWindows; the secure "stop" action and a unit frame's right click drop it too
 * (SecureTemplates.lua:396-400, :564-567).
 */
export const FRAMEXML_TRADESKILL_BINDINGS: Readonly<Record<string, FrameXmlTradeSkillBinding>> = Object.freeze({
  GetTradeSkillLine: read((model) => model.line(), ["UNKNOWN", 0, 0, 0]),
  GetNumTradeSkills: read((model) => [model.count()], [0]),
  GetTradeSkillInfo: read((model, args) => model.info(args[0]) ?? NOTHING),
  GetFirstTradeSkill: read((model) => [model.first()], [0]),
  GetTradeSkillSelectionIndex: read((model) => [model.selectionIndex()], [0]),
  SelectTradeSkill: command((model, args) => model.select(args[0])),
  GetTradeSkillIcon: read((model, args) => optional(model.icon(args[0]))),
  GetTradeSkillNumMade: read((model, args) => model.numMade(args[0]), [0, 0]),
  GetTradeSkillNumReagents: read((model, args) => [model.numReagents(args[0])], [0]),
  GetTradeSkillReagentInfo: read((model, args) => model.reagentInfo(args[0], args[1]) ?? NOTHING),
  GetTradeSkillReagentItemLink: read((model, args) => optional(model.reagentLink(args[0], args[1]))),
  GetTradeSkillItemLink: read((model, args) => optional(model.itemLink(args[0]))),
  GetTradeSkillRecipeLink: read((model, args) => optional(model.recipeLink(args[0]))),
  GetTradeSkillTools: read((model, args) => model.tools(args[0])),
  GetTradeSkillCooldown: read((model, args) => optional(model.cooldown(args[0]))),
  GetTradeSkillDescription: read((model, args) => optional(model.description(args[0]))),
  GetTradeskillRepeatCount: read((model) => [model.repeatCount()], [1]),
  DoTradeSkill: command((model, args) => model.doTradeSkill(args[0], args[1])),
  StopTradeSkillRepeat: command((model) => model.stopRepeat()),
  CloseTradeSkill: command((model) => model.close()),
  ExpandTradeSkillSubClass: command((model, args) => model.setExpanded(args[0], true)),
  CollapseTradeSkillSubClass: command((model, args) => model.setExpanded(args[0], false)),
  GetTradeSkillSubClasses: read((model) => model.subclasses()),
  GetTradeSkillInvSlots: read((model) => model.slotTokens()),
  GetTradeSkillSubClassFilter: read((model, args) => [model.subClassFilter(args[0])], [false]),
  GetTradeSkillInvSlotFilter: read((model, args) => [model.slotFilter(args[0])], [false]),
  SetTradeSkillSubClassFilter: command((model, args) => model.setSubClassFilter(args[0], truthy(args[1]))),
  SetTradeSkillInvSlotFilter: command((model, args) => model.setSlotFilter(args[0], truthy(args[1]))),
  SetTradeSkillItemNameFilter: command((model, args) => model.setNameFilter(args[0])),
  SetTradeSkillItemLevelFilter: command((model, args) => model.setLevelFilter(args[0], args[1])),
  TradeSkillOnlyShowMakeable: command((model, args) => model.onlyMakeable(args[0])),
  IsTradeSkillLinked: () => [false],
  GetTradeSkillListLink: () => NOTHING,
  SpellCanTargetItem: read((model) => [model.targeting !== undefined], [false]),
  SpellIsTargeting: (host) => host.tradeSkill?.targeting !== undefined || frameXmlNativeTargeting() ? [1] : NOTHING,
  SpellStopTargeting: (host) =>
    host.tradeSkill?.cancelTargeting() === true || runFrameXmlNativeEscape("stopTargeting") ? [1] : NOTHING,
});

/**
 * The Lua half: GetTradeSkillInfo's enchant verb and GetTradeSkillInvSlots' names are GlobalStrings.lua
 * words (ENSCRIBE, INVTYPE_*), which only the VM holds. Unresolved tokens are passed through.
 */
export const FRAMEXML_TRADESKILL_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local info = rawget(_G, "__fxSeam_GetTradeSkillInfo")
  local slots = rawget(_G, "__fxSeam_GetTradeSkillInvSlots")
  if impl ~= nil and info ~= nil then
    local rawget = rawget
    impl.GetTradeSkillInfo = function(index)
      local name, kind, available, expanded, verb = info(index)
      if verb == "${FRAMEXML_TRADESKILL_ENSCRIBE}" then verb = rawget(_G, "ENSCRIBE") end
      return name, kind, available, expanded, verb
    end
  end
  if impl ~= nil and slots ~= nil then
    local rawget, unpack = rawget, table.unpack
    impl.GetTradeSkillInvSlots = function()
      local names = { slots() }
      for index = 1, #names do names[index] = rawget(_G, names[index]) or names[index] end
      return unpack(names)
    end
  end
end
`;

// ---- the live source --------------------------------------------------------------------------

/** What the live source reads of `WorldClient` (structurally). */
export interface FrameXmlTradeSkillWorld {
  readonly state: WorldState;
  readonly knownSpells: readonly { readonly id: number }[];
  cooldownRemaining(spellId: number, now: number): number;
  itemTemplate?(entry: number): (FrameXmlTradeSkillItemClass & {
    readonly found?: boolean; readonly totemCategory?: number;
  }) | undefined;
}

/** The host facts only the world mount has: profession tables, subclass words and the craft queue. */
export interface FrameXmlTradeSkillLiveHost {
  /**
   * `/dbc/talents` (TalentClient): skill lines, spell to skill, SkillLineAbility rows. A skill line
   * that carries `alternateVerb` (SkillLine.AlternateVerb_lang) supplies GetTradeSkillInfo's verb.
   */
  professionData(): ProfessionData | undefined;
  subclassName(itemClass: number, subClass: number): string | undefined;
  readonly craft?: FrameXmlTradeSkillCraft | undefined;
  /** Every spell row the client holds, for a description's `$12345s1` markers. */
  spells?(): ReadonlyMap<number, SpellMetadata> | undefined;
}

/** The LiveWorldSeam context fields the live source reads. */
export interface FrameXmlTradeSkillLiveContext {
  readonly world: () => FrameXmlTradeSkillWorld | undefined;
  readonly spell: (id: number) => SpellMetadata | undefined;
  readonly itemInfo?: (entry: number) => FrameXmlTradeSkillItem | undefined;
  readonly prefetchQuestMetadata?: (itemIds: readonly number[], spellIds: readonly number[], onChanged: () => void) => void;
  readonly monotonic: () => number;
  readonly tradeSkill?: FrameXmlTradeSkillLiveHost | undefined;
}

function carriedSlots(world: FrameXmlTradeSkillWorld): ItemSlotState[] {
  const inventory = typeof world.state.objects?.get === "function" ? playerInventory(world.state) : undefined;
  return inventory ? [...inventory.equipment, ...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)] : [];
}

function selfObject(world: FrameXmlTradeSkillWorld): WorldObjectState | undefined {
  const self = world.state.selfGuid;
  return self === undefined ? undefined : world.state.objects.get(self);
}

/**
 * The source over the live world: the same reads `ui/Professions.ts` makes (`learnedProfessions`,
 * `professionRecipes`, the carried slots), so the stock window and the native one list the same
 * professions and recipes.
 */
export function liveFrameXmlTradeSkillSource(context: FrameXmlTradeSkillLiveContext): FrameXmlTradeSkillSource {
  const known = (world: FrameXmlTradeSkillWorld): SpellMetadata[] => world.knownSpells
    .map(({ id }) => context.spell(id)).filter((spell): spell is SpellMetadata => spell !== undefined);
  const template = (entry: number): FrameXmlTradeSkillItemClass | undefined => {
    const row = context.world()?.itemTemplate?.(entry);
    return row && row.found !== false ? row : undefined;
  };
  return {
    line: (skillId) => {
      const world = context.world();
      const data = context.tradeSkill?.professionData();
      const self = world ? selfObject(world) : undefined;
      if (!world || !self || !data) return undefined;
      const skill = learnedProfessions(readSkills(self), known(world), data).find((entry) => entry.skillId === skillId);
      const meta = data.skillLine(skillId);
      if (!skill || !meta) return undefined;
      // `/dbc/talents` does not carry the column yet (see the file comment); read it when it does.
      const verb = (meta as { readonly alternateVerb?: unknown }).alternateVerb;
      return {
        skillId, name: meta.name, value: skill.value, max: skill.max,
        modifier: effectiveSkill(skill) - skill.value, alternateVerb: typeof verb === "string" && verb ? verb : undefined,
      };
    },
    recipes: (skillId) => {
      const world = context.world();
      const data = context.tradeSkill?.professionData();
      if (!world || !data) return [];
      return professionRecipes(skillId, known(world), data).map((spell) => ({
        spell, ability: data.spellAbilitiesOf?.(spell.id)?.find((row) => row.skillLine === skillId),
      }));
    },
    carried: () => {
      const world = context.world();
      const counts = new Map<number, number>();
      if (!world) return counts;
      for (const slot of carriedSlots(world)) {
        const entry = entryOf(slot.item);
        if (entry > 0) counts.set(entry, (counts.get(entry) ?? 0) + stackCount(slot));
      }
      return counts;
    },
    toolCategories: () => {
      const world = context.world();
      const categories = new Set<number>();
      if (!world?.itemTemplate) return categories;
      for (const slot of carriedSlots(world)) {
        const category = world.itemTemplate(entryOf(slot.item))?.totemCategory ?? 0;
        if (category > 0) categories.add(category);
      }
      return categories;
    },
    cooldown: (spellId) => {
      const world = context.world();
      return world ? Math.ceil(Math.max(0, world.cooldownRemaining(spellId, context.monotonic())) / 1000) : 0;
    },
    item: (entry) => context.itemInfo?.(entry),
    itemClass: template,
    subclassName: (itemClass, subClass) => context.tradeSkill?.subclassName(itemClass, subClass),
    description: (spell) => {
      const spells = context.tradeSkill?.spells?.();
      return formatSpellDescription(spell.description, spell, spells ? { spells } : {}) || undefined;
    },
    prefetch: (entries, onChanged) => context.prefetchQuestMetadata?.(entries, [], onChanged),
    carriedItem: (guid) => {
      const world = context.world();
      const slot = world ? carriedSlots(world).find((entry) => entry.guid === guid && entry.item) : undefined;
      return slot ? template(entryOf(slot.item)) : undefined;
    },
    craft: context.tradeSkill?.craft,
    token: () => context.world(),
    // The route ui/Spellbook.ts and input/Actions.ts take from an opener to openProfession.
    openerSkill: (spell) => professionSpellSkill(spell, context.tradeSkill?.professionData()),
  };
}

interface SubclassRow {
  readonly itemClass: number;
  readonly subClass: number;
  readonly name: string;
}

/** Retry waits after a failed `/dbc/item-subclasses` read; asked on demand, never on a timer. */
const SUBCLASS_RETRY_MS: readonly number[] = [2_000, 10_000, 60_000];

/**
 * `ItemSubClass.DisplayName_lang` by class and subclass, read once from the gateway's
 * `/dbc/item-subclasses` (119 rows, the route the item tooltip already uses). The tooltip's own
 * accessor hides every word the slot row leaves off (DisplayFlags bit 0) — which is every heading a
 * trade skill has («Зелья», «Металл и камень») — so the headings keep their own copy.
 */
export function createFrameXmlSubclassNames(
  origin: () => string | undefined,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): (itemClass: number, subClass: number) => string | undefined {
  let table: ReadonlyMap<string, string> | undefined;
  let pending = false;
  let failures = 0;
  let retryAt = 0;
  const load = (): void => {
    const base = origin();
    if (!base || pending || now() < retryAt) return;
    pending = true;
    void (async () => {
      try {
        const response = await fetcher(`${base}/dbc/item-subclasses?v=1`);
        if (!response.ok) throw new Error(`item subclasses answered ${response.status}`);
        const value: unknown = await response.json();
        if (!Array.isArray(value)) throw new Error("item subclasses are not a list");
        const rows = value.filter((row): row is SubclassRow => !!row && typeof row === "object"
          && Number.isInteger((row as SubclassRow).itemClass) && Number.isInteger((row as SubclassRow).subClass)
          && typeof (row as SubclassRow).name === "string");
        table = new Map(rows.map((row) => [`${row.itemClass}:${row.subClass}`, row.name]));
      } catch {
        failures += 1;
        retryAt = now() + SUBCLASS_RETRY_MS[Math.min(failures, SUBCLASS_RETRY_MS.length) - 1]!;
      } finally {
        pending = false;
      }
    })();
  };
  return (itemClass, subClass) => {
    if (!table) {
      load();
      return undefined;
    }
    return table.get(`${itemClass}:${subClass}`) || undefined;
  };
}

/** The model LiveWorldSeam holds: inert (every line closed) until the mount supplies its host. */
export function createLiveFrameXmlTradeSkill(context: FrameXmlTradeSkillLiveContext): FrameXmlTradeSkillModel {
  return new FrameXmlTradeSkillModel(liveFrameXmlTradeSkillSource(context));
}
