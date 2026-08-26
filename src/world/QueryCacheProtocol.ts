import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: QueryPackets.cpp (`QueryCreatureResponse::Write`,
// `QueryItemSingleResponse::Write`), QueryHandler.cpp `HandleQueryPageText`, ItemHandler.cpp
// (`HandleItemNameQueryOpcode`, `HandleItemTextQuery`).
//
// This is the replacement for the original client's `WDB` files. That client wrote every query
// answer to disk and read it back on the next login, which is why it needs
// `SMSG_CLIENTCACHE_VERSION` to tell it when to throw the files away. Nothing is written to disk
// here: an answer is kept for the session and asked for again next time, which costs a packet at
// login and removes a whole class of stale-cache bug.

/** `MAX_KILL_CREDIT` in CreatureData.h. */
export const MAX_KILL_CREDIT = 2;
/** `MAX_CREATURE_MODELS`: four display ids, and a creature picks one at spawn. */
export const MAX_CREATURE_MODELS = 4;
/** `MAX_CREATURE_QUEST_ITEMS`: six, always all six, zero-padded. */
export const MAX_CREATURE_QUEST_ITEMS = 6;

/** `MAX_ITEM_PROTO_STATS`, `_DAMAGES`, `_SPELLS`, `_SOCKETS` in ItemTemplate.h. */
export const MAX_ITEM_PROTO_STATS = 10;
export const MAX_ITEM_PROTO_DAMAGES = 2;
export const MAX_ITEM_PROTO_SPELLS = 5;
export const MAX_ITEM_PROTO_SOCKETS = 3;
/** `MAX_SPELL_SCHOOL`: the seven resistances, physical first. */
export const MAX_SPELL_SCHOOL = 7;

/**
 * The bit the core sets on the entry to mean "there is no such row".
 *
 * `entry | (Allow ? 0 : 0x80000000)` — so a refusal is not an empty body or an error code, it is
 * the same word with its top bit on and nothing after it. Read the entry without masking and a
 * missing creature 448 becomes creature 2147483896.
 */
export const QUERY_MISSING_FLAG = 0x8000_0000;

export interface CreatureTemplate {
  entry: number;
  /** False when the server has no such row; every field below is then at its default. */
  found: boolean;
  name: string;
  /** The second name — the guild-like line under a boss, and the title on a vendor. */
  subName: string;
  /** "Directions" on a guard, and the icon name on anything that has one. */
  cursorName: string;
  flags: number;
  creatureType: number;
  creatureFamily: number;
  /** Rank: normal, elite, rare elite, boss, rare. */
  classification: number;
  /** Kill credit is given to these entries instead of this one. */
  proxyCreatureIds: number[];
  displayIds: number[];
  healthModifier: number;
  powerModifier: number;
  /** A racial leader: worth honor to kill. */
  leader: boolean;
  questItems: number[];
  movementId: number;
}

/**
 * What a creature is, asked once per entry and kept.
 *
 * Three of the arrays have no counts and are always written in full — two kill-credit entries, four
 * display ids and six quest items — while the two strings between them are terminated. The three
 * empty strings after the name are the localised name slots the core never fills: they are three
 * bare zero bytes, and skipping them because they look like padding moves everything after by three.
 */
export function parseCreatureQueryResponse(payload: Uint8Array): CreatureTemplate {
  const reader = new PacketReader(payload);
  const raw = reader.u32();
  const entry = raw & ~QUERY_MISSING_FLAG;
  const found = (raw & QUERY_MISSING_FLAG) === 0;
  const template: CreatureTemplate = {
    entry, found, name: "", subName: "", cursorName: "", flags: 0, creatureType: 0, creatureFamily: 0,
    classification: 0, proxyCreatureIds: [], displayIds: [], healthModifier: 0, powerModifier: 0,
    leader: false, questItems: [], movementId: 0,
  };
  if (!found) {
    reader.assertFinished();
    return template;
  }

  template.name = reader.cString();
  // name2, name3, name4: three empty strings the core writes as three zero bytes and never fills.
  reader.cString();
  reader.cString();
  reader.cString();
  template.subName = reader.cString();
  template.cursorName = reader.cString();
  template.flags = reader.u32();
  template.creatureType = reader.u32();
  template.creatureFamily = reader.u32();
  template.classification = reader.u32();
  for (let index = 0; index < MAX_KILL_CREDIT; index++) template.proxyCreatureIds.push(reader.u32());
  for (let index = 0; index < MAX_CREATURE_MODELS; index++) template.displayIds.push(reader.u32());
  template.healthModifier = reader.f32();
  template.powerModifier = reader.f32();
  template.leader = reader.u8() !== 0;
  for (let index = 0; index < MAX_CREATURE_QUEST_ITEMS; index++) template.questItems.push(reader.u32());
  template.movementId = reader.u32();
  reader.assertFinished();
  return template;
}

export interface ItemStat {
  type: number;
  /** Signed: a cursed item can carry a negative stat. */
  value: number;
}

export interface ItemDamage {
  min: number;
  max: number;
  type: number;
}

export interface ItemSpell {
  spellId: number;
  /** On use, on equip, chance on hit, soulstone, on use with no delay. */
  trigger: number;
  /** Written as `-abs(charges)`, so it arrives negative and comes back as its absolute value. */
  charges: number;
  cooldown: number;
  category: number;
  categoryCooldown: number;
}

export interface ItemSocket {
  color: number;
  content: number;
}

export interface ItemTemplate {
  entry: number;
  found: boolean;
  itemClass: number;
  subClass: number;
  soundOverrideSubclass: number;
  name: string;
  displayInfoId: number;
  quality: number;
  flags: number;
  flags2: number;
  buyPrice: number;
  sellPrice: number;
  inventoryType: number;
  allowableClass: number;
  allowableRace: number;
  itemLevel: number;
  requiredLevel: number;
  requiredSkill: number;
  requiredSkillRank: number;
  requiredSpell: number;
  requiredHonorRank: number;
  requiredCityRank: number;
  requiredReputationFaction: number;
  requiredReputationRank: number;
  maxCount: number;
  stackable: number;
  containerSlots: number;
  /** Only the stats the item actually has: this block *is* counted, unlike every other one here. */
  stats: ItemStat[];
  scalingStatDistribution: number;
  scalingStatValue: number;
  damage: ItemDamage[];
  resistances: number[];
  delay: number;
  ammoType: number;
  rangedModRange: number;
  spells: ItemSpell[];
  bonding: number;
  description: string;
  pageText: number;
  languageId: number;
  pageMaterial: number;
  startQuest: number;
  lockId: number;
  material: number;
  sheath: number;
  randomProperty: number;
  randomSuffix: number;
  block: number;
  itemSet: number;
  maxDurability: number;
  area: number;
  map: number;
  bagFamily: number;
  totemCategory: number;
  sockets: ItemSocket[];
  socketBonus: number;
  gemProperties: number;
  requiredDisenchantSkill: number;
  armorDamageModifier: number;
  duration: number;
  itemLimitCategory: number;
  holidayId: number;
}

/**
 * Everything about an item, in one long fixed packet.
 *
 * The one counted block is the stats, and it is counted because an item's stat list is genuinely
 * variable; the damages, resistances, spells and sockets are all fixed-length and zero-padded, so
 * a reader that tries to infer their lengths from the data finds nothing to infer from.
 *
 * The spell block is the trap. An empty spell slot is not zeros: the core writes `0, 0, 0, -1, 0,
 * -1` — the two cooldowns are −1 and the rest are zero — so testing a slot for "all zero" keeps
 * five empty spells on every item. And a real slot's charge count is written as `-abs(charges)`,
 * which means a wand with 5 charges arrives as −5 and an item with unlimited charges arrives as 0.
 */
export function parseItemQueryResponse(payload: Uint8Array): ItemTemplate {
  const reader = new PacketReader(payload);
  const raw = reader.u32();
  const template = emptyItemTemplate(raw & ~QUERY_MISSING_FLAG, (raw & QUERY_MISSING_FLAG) === 0);
  if (!template.found) {
    reader.assertFinished();
    return template;
  }

  template.itemClass = reader.u32();
  template.subClass = reader.u32();
  template.soundOverrideSubclass = reader.i32();
  template.name = reader.cString();
  // Name2, Name3, Name4: three zero bytes the core writes and never fills.
  reader.cString();
  reader.cString();
  reader.cString();
  template.displayInfoId = reader.u32();
  template.quality = reader.u32();
  template.flags = reader.u32();
  template.flags2 = reader.u32();
  template.buyPrice = reader.i32();
  template.sellPrice = reader.u32();
  template.inventoryType = reader.u32();
  // Bit masks, and unsigned at the source: "any class" is 0xFFFFFFFF, not −1. Reading them signed
  // would make every unrestricted item look restricted to a negative class.
  template.allowableClass = reader.u32();
  template.allowableRace = reader.u32();
  template.itemLevel = reader.u32();
  template.requiredLevel = reader.u32();
  template.requiredSkill = reader.u32();
  template.requiredSkillRank = reader.u32();
  template.requiredSpell = reader.u32();
  template.requiredHonorRank = reader.u32();
  template.requiredCityRank = reader.u32();
  template.requiredReputationFaction = reader.u32();
  template.requiredReputationRank = reader.u32();
  template.maxCount = reader.i32();
  template.stackable = reader.i32();
  template.containerSlots = reader.u32();

  const statCount = reader.u32();
  for (let index = 0; index < statCount; index++) {
    template.stats.push({ type: reader.u32(), value: reader.i32() });
  }
  template.scalingStatDistribution = reader.u32();
  template.scalingStatValue = reader.u32();
  for (let index = 0; index < MAX_ITEM_PROTO_DAMAGES; index++) {
    template.damage.push({ min: reader.f32(), max: reader.f32(), type: reader.u32() });
  }
  for (let index = 0; index < MAX_SPELL_SCHOOL; index++) template.resistances.push(reader.u32());
  template.delay = reader.u32();
  template.ammoType = reader.u32();
  template.rangedModRange = reader.f32();
  for (let index = 0; index < MAX_ITEM_PROTO_SPELLS; index++) {
    template.spells.push({
      spellId: reader.i32(),
      trigger: reader.u32(),
      // `uint32(-abs(charges))` on the wire, so the absolute value is exactly what was meant —
      // and taking it rather than negating avoids handing back `-0` for an empty slot, which is
      // not equal to `0` under `Object.is` and so not equal to it in a strict test either.
      charges: Math.abs(reader.i32()),
      cooldown: reader.i32(),
      category: reader.u32(),
      categoryCooldown: reader.i32(),
    });
  }
  template.bonding = reader.u32();
  template.description = reader.cString();
  template.pageText = reader.u32();
  template.languageId = reader.u32();
  template.pageMaterial = reader.u32();
  template.startQuest = reader.u32();
  template.lockId = reader.u32();
  template.material = reader.i32();
  template.sheath = reader.u32();
  template.randomProperty = reader.i32();
  template.randomSuffix = reader.i32();
  template.block = reader.u32();
  template.itemSet = reader.u32();
  template.maxDurability = reader.u32();
  template.area = reader.u32();
  template.map = reader.u32();
  template.bagFamily = reader.u32();
  template.totemCategory = reader.u32();
  for (let index = 0; index < MAX_ITEM_PROTO_SOCKETS; index++) {
    template.sockets.push({ color: reader.u32(), content: reader.u32() });
  }
  template.socketBonus = reader.u32();
  template.gemProperties = reader.u32();
  template.requiredDisenchantSkill = reader.u32();
  template.armorDamageModifier = reader.f32();
  template.duration = reader.u32();
  template.itemLimitCategory = reader.u32();
  template.holidayId = reader.u32();
  reader.assertFinished();
  return template;
}

/** An empty spell slot: `0, 0, 0, -1, 0, -1`, which is not the same as all zero. */
export function hasItemSpell(spell: ItemSpell): boolean {
  return spell.spellId > 0;
}

function emptyItemTemplate(entry: number, found: boolean): ItemTemplate {
  return {
    entry, found, itemClass: 0, subClass: 0, soundOverrideSubclass: 0, name: "", displayInfoId: 0,
    quality: 0, flags: 0, flags2: 0, buyPrice: 0, sellPrice: 0, inventoryType: 0, allowableClass: 0,
    allowableRace: 0, itemLevel: 0, requiredLevel: 0, requiredSkill: 0, requiredSkillRank: 0,
    requiredSpell: 0, requiredHonorRank: 0, requiredCityRank: 0, requiredReputationFaction: 0,
    requiredReputationRank: 0, maxCount: 0, stackable: 0, containerSlots: 0, stats: [],
    scalingStatDistribution: 0, scalingStatValue: 0, damage: [], resistances: [], delay: 0,
    ammoType: 0, rangedModRange: 0, spells: [], bonding: 0, description: "", pageText: 0,
    languageId: 0, pageMaterial: 0, startQuest: 0, lockId: 0, material: 0, sheath: 0,
    randomProperty: 0, randomSuffix: 0, block: 0, itemSet: 0, maxDurability: 0, area: 0, map: 0,
    bagFamily: 0, totemCategory: 0, sockets: [], socketBonus: 0, gemProperties: 0,
    requiredDisenchantSkill: 0, armorDamageModifier: 0, duration: 0, itemLimitCategory: 0,
    holidayId: 0,
  };
}

export interface ItemSetName {
  entry: number;
  name: string;
  inventoryType: number;
}

/**
 * The name of an item *set*, despite the opcode's name — `GetItemSetNameEntry`, not the item.
 *
 * It is what a random-suffix item ("of the Bear") is titled with, and it is the one query in this
 * group that answers nothing at all when the row is missing: no packet, no missing-bit, silence.
 * A caller that waits for an answer waits forever.
 */
export function parseItemNameQueryResponse(payload: Uint8Array): ItemSetName {
  const reader = new PacketReader(payload);
  const name: ItemSetName = { entry: reader.u32(), name: reader.cString(), inventoryType: reader.u32() };
  reader.assertFinished();
  return name;
}

export interface ItemText {
  /** Zero when there is no text; the guid is then absent too. */
  guid: bigint;
  text: string;
}

/**
 * The text written inside an item — a letter taken out of the mailbox, a scroll.
 *
 * The leading byte is inverted: 0 means there *is* text and 1 means there is none, which is the
 * opposite of how every other flag in the protocol reads, and the packet stops right there when it
 * is 1.
 */
export function parseItemTextQueryResponse(payload: Uint8Array): ItemText {
  const reader = new PacketReader(payload);
  const missing = reader.u8() !== 0;
  if (missing) {
    reader.assertFinished();
    return { guid: 0n, text: "" };
  }
  const text: ItemText = { guid: reader.u64(), text: reader.cString() };
  reader.assertFinished();
  return text;
}

export interface PageText {
  pageId: number;
  text: string;
  /** Zero on the last page. The server walks the chain itself and sends one packet per page. */
  nextPageId: number;
}

/**
 * One page of a book or a sign.
 *
 * Asking for the first page fetches the whole book: `HandleQueryPageText` loops on `NextPageID` and
 * sends a packet per page, so a client that asks for page 1 and expects one answer will treat the
 * rest as unhandled. A missing page answers with the literal text "Item page missing." and a next
 * page of zero rather than with a missing-bit, so there is nothing to test but the string.
 */
export function parsePageTextQueryResponse(payload: Uint8Array): PageText {
  const reader = new PacketReader(payload);
  const page: PageText = { pageId: reader.u32(), text: reader.cString(), nextPageId: reader.u32() };
  reader.assertFinished();
  return page;
}

/** The guid is optional to the server — it logs it and looks the row up by entry. */
export function buildCreatureQuery(entry: number, guid = 0n): Uint8Array {
  return new PacketWriter().u32(entry).u64(guid).toUint8Array();
}

/** Entry only: this one carries no guid at all, unlike its three neighbours. */
export function buildItemQuery(entry: number): Uint8Array {
  return new PacketWriter().u32(entry).toUint8Array();
}

export function buildItemNameQuery(entry: number, guid = 0n): Uint8Array {
  return new PacketWriter().u32(entry).u64(guid).toUint8Array();
}

/** Guid only: the text belongs to the instance of the item, not to its template. */
export function buildItemTextQuery(itemGuid: bigint): Uint8Array {
  return new PacketWriter().u64(itemGuid).toUint8Array();
}

export function buildPageTextQuery(pageId: number, guid = 0n): Uint8Array {
  return new PacketWriter().u32(pageId).u64(guid).toUint8Array();
}
