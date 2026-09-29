/**
 * The offline flight master: a real slice of this dataset's TaxiNodes/TaxiPath catalog (measured
 * through the gateway's `/dbc/taxi`: ruRU names, world X/Y/Z, mount creature ids, path costs) and
 * the Eastern Kingdoms flight-map square (`WorldMapContinent` row 1's TaxiMin/TaxiMax, with the
 * `WorldMapArea` continent row 14 kept as the older gateway's stand-in), with a scripted world that
 * records every command, for `CannedWorldSeam` and its tests.
 *
 * The canned Alliance player stands at Stormwind (node 2) and has discovered Sentinel Hill,
 * Lakeshire, Ironforge, Thelsamar, Darkshire and Menethil; Southshore and Refuge Pointe are not
 * discovered, so they read NONE and stay hidden. Thelsamar and Menethil are two hops away through
 * Ironforge, which is what makes the stock route lines visible.
 */
import { EventBus } from "../../world/EventBus.js";
import type { TaxiMenu } from "../../world/TaxiProtocol.js";
import type { TaxiCatalog, TaxiNodeMetadata, TaxiPathMetadata } from "../TaxiMetadata.js";
import type { MapAreaBounds } from "../MinimapGeometry.js";
import { FrameXmlTaxiModel, frameXmlTaxiMapBounds, type FrameXmlTaxiContext, type FrameXmlTaxiWorld } from "./FrameXmlTaxi.js";

type NodeRow = readonly [id: number, x: number, y: number, z: number, name: string, horde: number, alliance: number];

/** TaxiNodes.dbc rows on map 0, measured through /dbc/taxi. */
const NODES: readonly NodeRow[] = [
  [2, -8840.56, 489.7, 109.61, "Штормград, Элвин", 0, 541],
  [4, -10629.29, 1036.95, 34.02, "Сторожевой холм, Западный Край", 0, 541],
  [5, -9429.1, -2231.4, 68.65, "Приозерье, Красногорье", 0, 541],
  [6, -4821.78, -1155.44, 502.21, "Стальгорн, Дун Морог", 0, 541],
  [7, -3792.26, -783.29, 9.06, "Гавань Менетилов, Болотина", 0, 541],
  [8, -5421.91, -2930.01, 347.25, "Телcамар, озеро Лок Модан", 0, 541],
  [12, -10515.46, -1261.65, 41.34, "Темнолесье, Сумеречный лес", 0, 541],
  [14, -711.48, -515.48, 26.11, "Южнобережье, Хилсбрад", 0, 541],
  [16, -1240.53, -2515.11, 22.16, "Опорный пункт, Арати", 0, 541],
];

/** TaxiPath.dbc rows among those nodes: id, from, to, cost in copper. */
const PATHS: readonly (readonly [id: number, from: number, to: number, cost: number])[] = [
  [6, 2, 4, 110], [7, 4, 2, 110], [8, 5, 2, 210], [9, 2, 5, 210], [12, 6, 2, 50], [13, 2, 6, 50],
  [15, 8, 6, 110], [16, 6, 8, 110], [17, 7, 6, 330], [18, 6, 7, 330], [22, 12, 2, 330], [23, 2, 12, 330],
  [26, 14, 6, 330], [27, 6, 14, 330], [30, 16, 6, 530], [31, 6, 16, 530], [249, 4, 5, 210],
  [250, 4, 12, 330], [252, 12, 4, 110], [254, 5, 4, 110], [257, 5, 12, 330], [258, 12, 5, 210],
  [265, 8, 7, 330], [266, 7, 8, 110],
];

export const FRAMEXML_CANNED_TAXI_CATALOG: TaxiCatalog = Object.freeze({
  nodes: Object.freeze(NODES.map(([id, x, y, z, name, horde, alliance]): TaxiNodeMetadata => Object.freeze({
    id, mapId: 0, x, y, z, name, mountCreatureIds: Object.freeze([horde, alliance]) as unknown as readonly [number, number],
  }))),
  paths: Object.freeze(PATHS.map(([id, from, to, cost]): TaxiPathMetadata => Object.freeze({ id, from, to, cost }))),
});

/**
 * WorldMapContinent row 1 (map 0): `TaxiMin` (-16530, -16530), `TaxiMax` (12270, 12270), read from
 * this dataset's DBC — the square TAXIMAP0 is drawn for.
 */
export const FRAMEXML_CANNED_TAXI_CONTINENT_ROW = Object.freeze({
  mapId: 0,
  taxiMin: Object.freeze([-16530, -16530]) as unknown as readonly [number, number],
  taxiMax: Object.freeze([12270, 12270]) as unknown as readonly [number, number],
});

/** WorldMapArea row 14 ("Azeroth", map 0, area 0): the stand-in for a gateway without `taxiMin`. */
export const FRAMEXML_CANNED_TAXI_WORLD_MAP_AREA: MapAreaBounds = Object.freeze({
  left: 18171.970703125, right: -22569.2109375, top: 11176.34375, bottom: -15973.34375,
});

/** The flight map rectangle the canned flight master draws with. */
export const FRAMEXML_CANNED_TAXI_CONTINENT: MapAreaBounds = Object.freeze(
  frameXmlTaxiMapBounds(FRAMEXML_CANNED_TAXI_CONTINENT_ROW, FRAMEXML_CANNED_TAXI_WORLD_MAP_AREA)!,
);

export const FRAMEXML_CANNED_TAXI_MASTER = 0xF130000160000352n;

export const FRAMEXML_CANNED_TAXI_MENU: TaxiMenu = Object.freeze({
  guid: FRAMEXML_CANNED_TAXI_MASTER,
  currentNode: 2,
  knownNodes: [2, 4, 5, 6, 7, 8, 12],
});

export type FrameXmlCannedTaxiCall =
  | { readonly kind: "take"; readonly guid: bigint; readonly nodes: readonly number[] }
  | { readonly kind: "close" };

/** `WorldClient`'s taxi fields, events and commands; commands only record. */
export class FrameXmlCannedTaxiWorld implements FrameXmlTaxiWorld {
  readonly events = new EventBus<{ TAXI_MENU: TaxiMenu; TAXI_CHANGED: { guid: bigint; reply: number } }>();
  readonly calls: FrameXmlCannedTaxiCall[] = [];
  taxiMenu: TaxiMenu | undefined;

  /** `SMSG_SHOWTAXINODES` from the canned flight master. */
  open(menu: TaxiMenu = FRAMEXML_CANNED_TAXI_MENU): void {
    this.taxiMenu = menu;
    this.events.emit("TAXI_MENU", menu);
  }

  /** `SMSG_ACTIVATETAXIREPLY`: 0 takes off (the map closes), anything else keeps it open. */
  reply(reply: number): void {
    const menu = this.taxiMenu;
    if (!menu) return;
    if (reply === 0) this.taxiMenu = undefined;
    this.events.emit("TAXI_CHANGED", { guid: menu.guid, reply });
  }

  takeTaxi(guid: bigint, nodes: readonly number[]): void {
    this.calls.push({ kind: "take", guid, nodes: [...nodes] });
  }

  closeTaxiMenu(): void {
    this.calls.push({ kind: "close" });
    this.taxiMenu = undefined;
  }
}

export function createCannedFrameXmlTaxi(
  context: Partial<Omit<FrameXmlTaxiContext, "world">> = {},
): { readonly model: FrameXmlTaxiModel; readonly world: FrameXmlCannedTaxiWorld } {
  const world = new FrameXmlCannedTaxiWorld();
  const model = new FrameXmlTaxiModel({
    world: () => world,
    catalog: context.catalog ?? (() => FRAMEXML_CANNED_TAXI_CATALOG),
    ...(context.loadCatalog ? { loadCatalog: context.loadCatalog } : {}),
    continent: context.continent ?? ((mapId) => mapId === 0 ? FRAMEXML_CANNED_TAXI_CONTINENT : undefined),
    playerFaction: context.playerFaction ?? (() => "Alliance"),
    unitOnTaxi: context.unitOnTaxi ?? (() => false),
  });
  return { model, world };
}
