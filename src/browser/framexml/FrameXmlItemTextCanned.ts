/**
 * The offline reader: one readable item (a two-page parchment book) and one goober lectern (a
 * one-page stone plaque), with their page texts, in a scripted world that raises
 * `ITEM_TEXT_OPENED` and answers page queries from its cache. The wording is illustrative.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { EventBus } from "../../world/EventBus.js";
import type { GameObjectTemplate } from "../../world/GameObjectProtocol.js";
import type { PageText } from "../../world/QueryCacheProtocol.js";
import {
  FrameXmlItemTextModel, type FrameXmlItemTextItem, type FrameXmlItemTextOpened, type FrameXmlItemTextWorld,
} from "./FrameXmlItemText.js";

export const FRAMEXML_CANNED_BOOK_GUID = 0x4000000000000901n;
export const FRAMEXML_CANNED_PLAQUE_GUID = 0xF110000180000902n;
const BOOK_ENTRY = 2794;
const PLAQUE_ENTRY = 175740;

const PAGES: readonly PageText[] = [
  { pageId: 1131, text: "Давным-давно, когда Штормград был лишь заставой у реки, каменщики поклялись строить на века.", nextPageId: 1132 },
  { pageId: 1132, text: "Их знаки до сих пор видны на стенах собора — для того, кто умеет читать камень.", nextPageId: 0 },
  { pageId: 2201, text: "Здесь покоятся павшие защитники Златоземья.", nextPageId: 0 },
];

export type FrameXmlCannedItemTextCall =
  | { readonly kind: "read"; readonly bag: number; readonly slot: number }
  | { readonly kind: "page"; readonly pageId: number };

export class FrameXmlCannedItemTextWorld implements FrameXmlItemTextWorld {
  readonly events = new EventBus<{
    ITEM_TEXT_OPENED: FrameXmlItemTextOpened;
    QUERY_CACHE_CHANGED: { kind: "page"; id: number };
  }>();
  readonly calls: FrameXmlCannedItemTextCall[] = [];
  readonly state = {
    objects: new Map<bigint, { fields: Map<number, number> }>([
      [FRAMEXML_CANNED_BOOK_GUID, { fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, BOOK_ENTRY]]) }],
      [FRAMEXML_CANNED_PLAQUE_GUID, { fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, PLAQUE_ENTRY]]) }],
    ]),
  };
  readonly itemTemplates = new Map<number, FrameXmlItemTextItem>([
    [BOOK_ENTRY, { found: true, name: "Летопись каменщиков", pageText: 1131, pageMaterial: 1, startQuest: 0, spells: [] }],
  ]);
  readonly gameObjectTemplates = new Map<number, Pick<GameObjectTemplate, "type" | "name" | "data"> | null>([
    [PLAQUE_ENTRY, { type: 10, name: "Памятная плита", data: [0, 0, 0, 0, 0, 0, 0, 2201, 0, 2] }],
  ]);
  /** Pages the server has answered; `pageText` asks for the rest, as WorldClient does. */
  readonly pageTexts = new Map<number, PageText>();
  /** Whether a page query answers at once (the book's chain is then all in the cache). */
  answerPages = true;

  pageText(pageId: number): PageText | undefined {
    const known = this.pageTexts.get(pageId);
    if (known) return known;
    this.calls.push({ kind: "page", pageId });
    if (this.answerPages) queueMicrotask(() => this.answerPage(pageId));
    return undefined;
  }

  /** `SMSG_PAGE_TEXT_QUERY_RESPONSE` for one page and every page after it, one packet each. */
  answerPage(pageId: number): void {
    let page = PAGES.find((candidate) => candidate.pageId === pageId);
    while (page) {
      this.pageTexts.set(page.pageId, page);
      this.events.emit("QUERY_CACHE_CHANGED", { kind: "page", id: page.pageId });
      const next = page.nextPageId;
      page = next > 0 ? PAGES.find((candidate) => candidate.pageId === next) : undefined;
    }
  }

  readItem(bag: number, slot: number): void {
    this.calls.push({ kind: "read", bag, slot });
  }

  /** `SMSG_READ_ITEM_OK` for the book, or `SMSG_GAMEOBJECT_PAGETEXT` for the plaque. */
  open(kind: "item" | "object" = "item"): void {
    this.events.emit("ITEM_TEXT_OPENED", {
      kind, guid: kind === "item" ? FRAMEXML_CANNED_BOOK_GUID : FRAMEXML_CANNED_PLAQUE_GUID,
    });
  }
}

export function createCannedFrameXmlItemText(): {
  readonly model: FrameXmlItemTextModel;
  readonly world: FrameXmlCannedItemTextWorld;
} {
  const world = new FrameXmlCannedItemTextWorld();
  return { model: new FrameXmlItemTextModel({ world: () => world }), world };
}
