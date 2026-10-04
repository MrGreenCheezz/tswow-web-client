/**
 * The stock ItemTextFrame's C API (ItemTextFrame.lua) over the two readers 3.3.5 TrinityCore
 * opens: a readable item and a book-like game object.
 *
 * * An item with `PageText` is read with `CMSG_READ_ITEM(bag, slot)`; `HandleReadItem`
 *   (ItemHandler.cpp:351-382) answers `SMSG_READ_ITEM_OK(guid)` when the player may use it. The
 *   title is the item's name, the first page its template's `PageText`, the paper `PageMaterial`.
 * * A goober with a page (`GameObject::Use`, GameObject.cpp:1817-1830) answers
 *   `SMSG_GAMEOBJECT_PAGETEXT(guid)`; its template carries the page in data[7] and the paper in
 *   data[9] (GameObjectData.h `goober.pageId/pageMaterial`). A type-9 TEXT object keeps them in
 *   data[0]/data[2]; this client offers no click on that type yet (GameObjectProtocol
 *   `USABLE_TYPES`), so only a caller that opens one explicitly reaches that branch.
 *
 * Pages are `CMSG_PAGE_TEXT_QUERY` answers (`WorldClient.pageText`, which fetches the whole chain:
 * the server walks `NextPageID` and sends a packet per page). The events follow the client: BEGIN
 * as soon as the reader knows what is open, READY when the page on screen has its text, READY again
 * for every page turn, CLOSED when it is put away. `ITEM_TEXT_TRANSLATION` belongs to a language
 * the reader cannot read — 3.3.5 TrinityCore sends no such page, so it is never raised.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { GameObjectTemplate } from "../../world/GameObjectProtocol.js";
import type { ItemTemplate, PageText } from "../../world/QueryCacheProtocol.js";
import { frameXmlItemCreator, frameXmlItemIsMailText } from "./FrameXmlItemTextMail.js"; // 5.28 (L6)

/** PageTextMaterial.dbc (this dataset, measured: 7 rows); stock builds `ItemText-<name>-*` from it. */
export const FRAMEXML_PAGE_MATERIALS: Readonly<Record<number, string>> = Object.freeze({
  1: "Parchment", 2: "Stone", 3: "Marble", 4: "Silver", 5: "Bronze", 6: "Valentine", 7: "Illidan",
});

/** `GAMEOBJECT_TYPE_TEXT` and `GAMEOBJECT_TYPE_GOOBER` (SharedDefines.h). */
const GO_TYPE_TEXT = 9;
const GO_TYPE_GOOBER = 10;
/** `ITEM_SPELLTRIGGER_ON_USE` (ItemTemplate.h). */
const SPELL_TRIGGER_ON_USE = 0;

export interface FrameXmlItemTextOpened {
  readonly kind: "item" | "object";
  readonly guid: bigint;
}

/** What a reader shows: its title, the first page and the paper. */
export interface FrameXmlItemTextSource {
  readonly title: string;
  readonly firstPage: number;
  readonly material: number;
  /** 5.28 (L6): a mail copy — the item's own text (CMSG_ITEM_TEXT_QUERY), no pages (FrameXmlItemTextMail.ts). */
  readonly mail?: boolean;
}

/** The item template fields a reader needs. */
export type FrameXmlItemTextItem = Pick<ItemTemplate, "found" | "name" | "pageText" | "pageMaterial" | "startQuest" | "spells">;

/** The world facts the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlItemTextWorld {
  readonly events?: {
    on(name: "ITEM_TEXT_OPENED", listener: (opened: FrameXmlItemTextOpened) => void): () => void;
    on(name: "QUERY_CACHE_CHANGED", listener: () => void): () => void;
  } | undefined;
  readonly state: { readonly objects: ReadonlyMap<bigint, { readonly fields: ReadonlyMap<number, number> }> };
  readonly itemTemplates: ReadonlyMap<number, FrameXmlItemTextItem>;
  readonly gameObjectTemplates: ReadonlyMap<number, Pick<GameObjectTemplate, "type" | "name" | "data"> | null>;
  /** The cached page, or undefined after asking the server for it (and the rest of its book). */
  pageText(pageId: number, guid?: bigint): PageText | undefined;
  /** `CMSG_READ_ITEM`; absent on a world that cannot send it. */
  readItem?(bag: number, slot: number): void;
  /** 5.28 (L6): a mail copy's text by item guid, once answered; `requestItemText` asks (CMSG_ITEM_TEXT_QUERY). */
  itemText?(itemGuid: bigint): string | undefined;
  requestItemText?(itemGuid: bigint): void;
  /** 5.28 (L6): the name cache ItemTextGetCreator reads (0x58a480 → 0x67d770). */
  readonly names?: { get(guid: bigint): string | undefined } | undefined;
  requestName?(guid: bigint): void;
}

/**
 * Whether right-clicking this item reads it rather than uses it: a page and nothing the server
 * would run instead — no on-use spell, no quest it starts (those open the quest dialog).
 */
export function frameXmlItemIsReadable(template: FrameXmlItemTextItem | undefined): boolean {
  return !!template?.found && template.pageText > 0 && template.startQuest <= 0
    && !template.spells.some((spell) => spell.spellId > 0 && spell.trigger === SPELL_TRIGGER_ON_USE);
}

/** Resolve what an open reader shows, once the template it names is in the cache. */
export function frameXmlItemTextSource(
  world: FrameXmlItemTextWorld,
  opened: FrameXmlItemTextOpened,
): FrameXmlItemTextSource | undefined {
  const object = world.state.objects.get(opened.guid);
  const entry = object?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (entry <= 0) return undefined;
  if (opened.kind === "item") {
    const template = world.itemTemplates.get(entry);
    // 5.28 (L6): ITEM_FIELD_FLAG_READABLE reads the item's own text, pages or not (Wow.exe 0x58a1a0).
    if (frameXmlItemIsMailText(object)) {
      return template?.found ? { title: template.name, firstPage: 0, material: template.pageMaterial, mail: true } : undefined;
    }
    return template?.found && template.pageText > 0
      ? { title: template.name, firstPage: template.pageText, material: template.pageMaterial }
      : undefined;
  }
  const template = world.gameObjectTemplates.get(entry);
  if (!template) return undefined;
  if (template.type === GO_TYPE_GOOBER && (template.data[7] ?? 0) > 0) {
    return { title: template.name, firstPage: template.data[7]!, material: template.data[9] ?? 0 };
  }
  if (template.type === GO_TYPE_TEXT && (template.data[0] ?? 0) > 0) {
    return { title: template.name, firstPage: template.data[0]!, material: template.data[2] ?? 0 };
  }
  return undefined;
}

export interface FrameXmlItemTextContext {
  world(): FrameXmlItemTextWorld | undefined;
}

interface FrameXmlItemTextPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

interface Reading {
  readonly opened: FrameXmlItemTextOpened;
  source: FrameXmlItemTextSource | undefined;
  /** The page ids turned through, first to current. */
  readonly pages: number[];
  begun: boolean;
  /** The page READY was last raised for (its index in `pages`). */
  readyAt: number | undefined;
  /** 5.28 (L6): a mail copy's text was asked for. */
  textAsked?: boolean;
}

/** One owner of the reader's C API and of the four ITEM_TEXT_* events. */
export class FrameXmlItemTextModel {
  readonly #context: FrameXmlItemTextContext;
  #pump: FrameXmlItemTextPump | undefined;
  #unsubscribe: (() => void)[] = [];
  #owned = false;
  #muted = false;
  #reading: Reading | undefined;
  #probe: { title: string; pages: readonly string[]; material: number; index: number } | undefined;
  /** 5.28 (L6): the creator whose name ItemTextGetCreator asked for, for the item it was asked on. */
  #creatorPending: { readonly item: bigint; readonly creator: bigint } | undefined;

  constructor(context: FrameXmlItemTextContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlItemTextPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe.push(world.events.on("ITEM_TEXT_OPENED", (opened) => this.open(opened)));
      // A page or a template arriving is what a waiting reader waits for.
      this.#unsubscribe.push(world.events.on("QUERY_CACHE_CHANGED", () => this.sync()));
    }
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
    this.#owned = false;
    this.#reading = undefined;
  }

  /** Whether the stock frame owns readers; nothing native reads, so this only gates the events. */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    if (!owned) this.#reading = undefined;
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** Answer every read from a synthetic book for the duration of `operation`, muted. */
  probe<T>(book: { title: string; pages: readonly string[]; material: number }, operation: () => T): T {
    const previous = this.#probe;
    this.#probe = { ...book, index: 0 };
    try { return this.muted(operation); } finally { this.#probe = previous; }
  }

  /** The server opened a reader (or a host caller did): start it, replacing any open one. */
  open(opened: FrameXmlItemTextOpened): void {
    if (!this.#owned) return;
    this.#reading = { opened, source: undefined, pages: [], begun: false, readyAt: undefined };
    this.sync();
  }

  /** Raise BEGIN once the source is known, READY once the current page has its text. */
  sync(): void {
    const pump = this.#pump;
    const reading = this.#reading;
    const world = this.#context.world();
    if (!pump || !this.#owned || !reading || !world || this.#probe) return;
    if (!reading.source) {
      const source = frameXmlItemTextSource(world, reading.opened);
      if (!source) return;
      reading.source = source;
      if (!source.mail) reading.pages.push(source.firstPage); // 5.28 (L6): a letter has no pages
    }
    // 5.28 (L6): a letter begins when its text is there (0x58a1a0 asks the cache, 0x589e90 reads it).
    if (reading.source.mail) {
      if (world.itemText?.(reading.opened.guid) === undefined) {
        if (!reading.textAsked) {
          reading.textAsked = true;
          world.requestItemText?.(reading.opened.guid);
        }
        return;
      }
      if (!reading.begun) {
        reading.begun = true;
        pump.fire("ITEM_TEXT_BEGIN");
      }
      if (reading.readyAt === 0) return;
      reading.readyAt = 0;
      pump.fire("ITEM_TEXT_READY");
      return;
    }
    if (!reading.begun) {
      reading.begun = true;
      pump.fire("ITEM_TEXT_BEGIN");
    }
    const index = reading.pages.length - 1;
    if (reading.readyAt === index) return;
    const page = world.pageText(reading.pages[index]!, reading.opened.guid);
    if (!page) return;
    reading.readyAt = index;
    pump.fire("ITEM_TEXT_READY");
  }

  #page(): PageText | undefined {
    const reading = this.#reading;
    const world = this.#context.world();
    if (!reading || !world || reading.readyAt === undefined || reading.source?.mail) return undefined; // 5.28 (L6)
    return world.pageText(reading.pages[reading.readyAt]!, reading.opened.guid);
  }

  // ---- reads ---------------------------------------------------------------------------------

  title(): string | undefined {
    return this.#probe?.title ?? this.#reading?.source?.title;
  }

  text(): string | undefined {
    const probe = this.#probe;
    if (probe) return probe.pages[probe.index];
    // 5.28 (L6): a letter's text is the item's own (0x589e90's mail branch).
    const reading = this.#reading;
    if (reading?.source?.mail) return this.#context.world()?.itemText?.(reading.opened.guid);
    return this.#page()?.text;
  }

  /**
   * 5.28 (L6): `ItemTextGetCreator` (0x58a480): the open item's ITEM_FIELD_CREATOR by name, from the name
   * cache; nil while unknown (asked for — its arrival raises BEGIN and READY again, see `tick`).
   */
  creator(): string | undefined {
    const reading = this.#reading;
    const world = this.#context.world();
    if (this.#probe || !reading || reading.opened.kind !== "item" || !world) return undefined;
    const creator = frameXmlItemCreator(world.state.objects.get(reading.opened.guid));
    if (creator === undefined) return undefined;
    const name = world.names?.get(creator);
    if (name !== undefined) return name;
    if (!this.#muted && this.#creatorPending?.creator !== creator) {
      this.#creatorPending = { item: reading.opened.guid, creator };
      world.requestName?.(creator);
    }
    return undefined;
  }

  /** 5.28 (L6): the asked creator name came for the item still open — BEGIN and READY again (0x58a450). */
  tick(): void {
    const pending = this.#creatorPending;
    if (!pending) return;
    const world = this.#context.world();
    if (world?.names?.get(pending.creator) === undefined) return;
    this.#creatorPending = undefined;
    const reading = this.#reading;
    if (!this.#owned || !this.#pump || !reading || reading.opened.guid !== pending.item || !reading.begun) return;
    this.#pump.fire("ITEM_TEXT_BEGIN");
    if (reading.readyAt !== undefined) this.#pump.fire("ITEM_TEXT_READY");
  }

  page(): number {
    const probe = this.#probe;
    if (probe) return probe.index + 1;
    const at = this.#reading?.readyAt;
    return at === undefined ? 1 : at + 1;
  }

  hasNextPage(): boolean {
    const probe = this.#probe;
    if (probe) return probe.index + 1 < probe.pages.length;
    return (this.#page()?.nextPageId ?? 0) > 0;
  }

  material(): string | undefined {
    const id = this.#probe?.material ?? this.#reading?.source?.material ?? 0;
    return FRAMEXML_PAGE_MATERIALS[id];
  }

  // ---- commands ------------------------------------------------------------------------------

  next(): void {
    const probe = this.#probe;
    if (probe) {
      if (probe.index + 1 < probe.pages.length) {
        probe.index += 1;
        this.#pump?.fire("ITEM_TEXT_READY");
      }
      return;
    }
    const reading = this.#reading;
    const next = this.#page()?.nextPageId ?? 0;
    if (!reading || next <= 0 || reading.readyAt !== reading.pages.length - 1) return;
    reading.pages.push(next);
    this.sync();
  }

  previous(): void {
    const probe = this.#probe;
    if (probe) {
      if (probe.index > 0) {
        probe.index -= 1;
        this.#pump?.fire("ITEM_TEXT_READY");
      }
      return;
    }
    const reading = this.#reading;
    if (!reading || reading.pages.length < 2 || reading.readyAt !== reading.pages.length - 1) return;
    reading.pages.pop();
    reading.readyAt = undefined;
    this.sync();
  }

  /** `CloseItemText` — ItemTextFrame's OnHide. No packet exists; the reader is forgotten. */
  close(): void {
    if (this.#muted || this.#probe || !this.#reading) return;
    this.#reading = undefined;
    this.#pump?.fire("ITEM_TEXT_CLOSED");
  }

  get reading(): boolean { return this.#reading !== undefined; }

  /**
   * UseContainerItem on a readable item sends `CMSG_READ_ITEM` instead of `CMSG_USE_ITEM`, as the
   * client does; false leaves the ordinary item use to the caller (also while unpublished, when
   * nothing could show the page).
   */
  useItem(bag: number, slot: number, template: FrameXmlItemTextItem | undefined, guid?: bigint): boolean {
    const world = this.#context.world();
    // 5.28 (L6): a mail copy (ITEM_FIELD_FLAG_READABLE) opens the reader itself, without CMSG_READ_ITEM;
    // using the item already open closes it (Wow.exe 0x708c20 → 0x58a1a0 with the toggle).
    if (this.#owned && world && guid !== undefined && frameXmlItemIsMailText(world.state.objects.get(guid))) {
      if (this.#muted) return true;
      if (this.#reading?.opened.guid === guid) this.close();
      else this.open({ kind: "item", guid });
      return true;
    }
    if (!this.#owned || !world?.readItem || !frameXmlItemIsReadable(template)) return false;
    if (!this.#muted) world.readItem(bag, slot);
    return true;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlItemTextHost {
  readonly itemText?: FrameXmlItemTextModel | undefined;
}

export type FrameXmlItemTextBinding = (host: FrameXmlItemTextHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

const withReader = (answer: (reader: FrameXmlItemTextModel) => readonly unknown[]): FrameXmlItemTextBinding =>
  (host) => host.itemText ? answer(host.itemText) : NOTHING;

const optional = (value: unknown): readonly unknown[] => value === undefined ? NOTHING : [value];

/** The flat C API. 5.28 (L6): `ItemTextGetCreator` is the open item's creator — a mail copy's sender. */
export const FRAMEXML_ITEM_TEXT_BINDINGS: Readonly<Record<string, FrameXmlItemTextBinding>> = Object.freeze({
  ItemTextGetItem: withReader((reader) => optional(reader.title())),
  ItemTextGetText: withReader((reader) => [reader.text() ?? ""]),
  ItemTextGetPage: withReader((reader) => [reader.page()]),
  ItemTextHasNextPage: withReader((reader) => [reader.hasNextPage()]),
  ItemTextGetMaterial: withReader((reader) => optional(reader.material())),
  ItemTextGetCreator: withReader((reader) => optional(reader.creator())), // 5.28 (L6)
  ItemTextNextPage: withReader((reader) => { reader.next(); return NOTHING; }),
  ItemTextPrevPage: withReader((reader) => { reader.previous(); return NOTHING; }),
  CloseItemText: withReader((reader) => { reader.close(); return NOTHING; }),
});
