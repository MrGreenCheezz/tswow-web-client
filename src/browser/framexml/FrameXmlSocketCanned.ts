/**
 * A scripted socketing world for the canned seam, the offline preview and the tests: one socketed
 * head piece, four gems in the backpack (one a stack) and a recorded `CMSG_SOCKET_GEMS`.
 *
 * The gems are this dataset's (measured through the gateway: `/dbc/item-enchantments` for the
 * GemProperties colour and enchantment, `/data/items` for the ruRU name and quality,
 * ItemDisplayInfo.InventoryIcon for the picture). The head piece is the fixture's own — entry
 * 900001 names no row — because its socket layout lives in the world database's item_template,
 * which is not read offline.
 */
import {
  FrameXmlSocketModel, type FrameXmlSocketCarried, type FrameXmlSocketGemFacts, type FrameXmlSocketTarget,
} from "./FrameXmlSocketModel.js";
import { frameXmlSocketItemLink } from "./FrameXmlSocketLive.js";

export interface CannedFrameXmlSocketGem extends FrameXmlSocketGemFacts {
  readonly entry: number;
  readonly name: string;
  readonly texture: string;
  readonly quality: number;
  readonly color: number;
  readonly enchantmentId: number;
}

/** GemProperties 1287/1304/1295/1381 and their SpellItemEnchantment rows 3518/3531/3532/3621. */
export const FRAMEXML_CANNED_GEMS: readonly CannedFrameXmlSocketGem[] = Object.freeze([
  { entry: 40111, name: "Рельефный багровый рубин", texture: "Interface\\Icons\\INV_Jewelcrafting_Gem_37", quality: 4, color: 2, enchantmentId: 3518 },
  { entry: 40128, name: "Мягкий царский янтарь", texture: "Interface\\Icons\\INV_Jewelcrafting_Gem_38", quality: 4, color: 4, enchantmentId: 3531 },
  { entry: 40119, name: "Цельный величественный циркон", texture: "Interface\\Icons\\INV_Jewelcrafting_Gem_42", quality: 4, color: 8, enchantmentId: 3532 },
  { entry: 41285, name: "Хаотический алмаз небесного сияния", texture: "Interface\\Icons\\INV_Jewelcrafting_IceDiamond_02", quality: 3, color: 1, enchantmentId: 3621 },
]);

export interface CannedFrameXmlSocketItem {
  readonly guid: bigint;
  readonly entry: number;
  readonly name: string;
  readonly texture: string;
  readonly quality: number;
  readonly sockets: readonly number[];
  readonly enchantments: number[];
  flags: number;
}

/** The fixture's head piece: meta, red and yellow sockets, the meta one already holding its diamond. */
export const FRAMEXML_CANNED_SOCKET_ITEM_ENTRY = 900001;

export class CannedFrameXmlSocketWorld {
  /** Equipment slot (1..19) → item. */
  readonly equipment = new Map<number, CannedFrameXmlSocketItem>();
  /** Carried items by native bag/slot key `bag:slot` (the backpack is 255/23..38). */
  readonly carried = new Map<string, FrameXmlSocketCarried>();
  /** What the bag cursor holds; tests and the preview set it, as the stock bag click would. */
  cursor: bigint | undefined;
  readonly sent: { readonly itemGuid: bigint; readonly gems: readonly bigint[] }[] = [];
  readonly splits: { readonly guid: bigint; readonly bag: number; readonly slot: number }[] = [];
  #nextGuid = 0x4000_0200n;
  #clock = 0;
  model: FrameXmlSocketModel | undefined;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.equipment.clear();
    this.carried.clear();
    this.cursor = undefined;
    this.sent.length = 0;
    this.splits.length = 0;
    this.equipment.set(1, {
      guid: 0x4000_0100n, entry: FRAMEXML_CANNED_SOCKET_ITEM_ENTRY, name: "Шлем гранильщика",
      texture: "Interface\\Icons\\INV_Helmet_24", quality: 4, sockets: [1, 2, 4],
      enchantments: [0, 0, 3621, 0, 0, 0, 0], flags: 0,
    });
    this.#put({ guid: 0x4000_0101n, entry: 40111, count: 1, bag: 255, slot: 23 });
    this.#put({ guid: 0x4000_0102n, entry: 40128, count: 3, bag: 255, slot: 24 });
    this.#put({ guid: 0x4000_0103n, entry: 40119, count: 1, bag: 255, slot: 26 });
    this.#put({ guid: 0x4000_0104n, entry: 41285, count: 1, bag: 255, slot: 27 });
  }

  #put(item: FrameXmlSocketCarried): void {
    this.carried.set(`${item.bag}:${item.slot}`, item);
  }

  byGuid(guid: bigint): FrameXmlSocketCarried | undefined {
    for (const item of this.carried.values()) if (item.guid === guid) return item;
    return undefined;
  }

  /** The server's side of the last split: the separated gem lands in the free slot it named. */
  landSplit(): void {
    const split = this.splits.shift();
    const source = split && this.byGuid(split.guid);
    if (!split || !source) return;
    this.#put({ ...source, count: source.count - 1 });
    this.#put({ guid: this.#nextGuid++, entry: source.entry, count: 1, bag: split.bag, slot: split.slot });
  }

  /** The server's side of the last CMSG_SOCKET_GEMS: gems spent, enchantments written, the result. */
  answer(): void {
    const sent = this.sent.shift();
    if (!sent) return;
    const item = [...this.equipment.values()].find((candidate) => candidate.guid === sent.itemGuid);
    if (!item) return;
    sent.gems.forEach((guid, socket) => {
      const gem = guid !== 0n ? this.byGuid(guid) : undefined;
      const facts = gem && FRAMEXML_CANNED_GEMS.find((row) => row.entry === gem.entry);
      if (!gem || !facts) return;
      item.enchantments[2 + socket] = facts.enchantmentId;
      this.carried.delete(`${gem.bag}:${gem.slot}`);
    });
    this.model?.result(sent.itemGuid);
  }

  /** The canned clock, in seconds; tests advance it past a split's wait. */
  advance(seconds: number): void {
    this.#clock += seconds;
  }

  get now(): number { return this.#clock; }

  itemAt(target: FrameXmlSocketTarget): CannedFrameXmlSocketItem | undefined {
    if (target.location === 0 && target.bag === 0) return this.equipment.get(target.slot);
    return undefined;
  }
}

export function createCannedFrameXmlSocket(): { readonly model: FrameXmlSocketModel; readonly world: CannedFrameXmlSocketWorld } {
  const world = new CannedFrameXmlSocketWorld();
  const gem = (entry: number): CannedFrameXmlSocketGem | undefined => FRAMEXML_CANNED_GEMS.find((row) => row.entry === entry);
  const model = new FrameXmlSocketModel({
    item: (target) => {
      const item = world.itemAt(target);
      return item ? { ...item, enchantments: [...item.enchantments] } : undefined;
    },
    carried: (guid) => world.byGuid(guid),
    carriedAt: (bag, slot) => world.carried.get(`${bag}:${slot}`),
    cursor: () => (world.cursor === undefined ? undefined : world.byGuid(world.cursor)),
    clearCursor: () => { world.cursor = undefined; },
    pickup: (guid) => { world.cursor = guid; },
    gem: (entry) => {
      const facts = gem(entry);
      if (facts) return facts;
      const item = [...world.equipment.values()].find((candidate) => candidate.entry === entry);
      return item ? { name: item.name, texture: item.texture, quality: item.quality } : undefined;
    },
    enchantmentGem: (enchantmentId) => FRAMEXML_CANNED_GEMS.find((row) => row.enchantmentId === enchantmentId)?.entry,
    itemLink: (entry, enchantments) => {
      const facts = gem(entry) ?? [...world.equipment.values()].find((candidate) => candidate.entry === entry);
      return facts ? frameXmlSocketItemLink(entry, facts.name, facts.quality, enchantments, 0, 0, 80) : undefined;
    },
    splitOne: (guid) => {
      const source = world.byGuid(guid);
      if (!source || source.count <= 1) return undefined;
      for (let slot = 23; slot <= 38; slot += 1) {
        if (!world.carried.has(`255:${slot}`)) {
          world.splits.push({ guid, bag: 255, slot });
          return { bag: 255, slot };
        }
      }
      return undefined;
    },
    socketGems: (itemGuid, gems) => {
      world.sent.push({ itemGuid, gems: [...gems] });
      return true;
    },
    now: () => world.now,
  });
  world.model = model;
  return { model, world };
}
