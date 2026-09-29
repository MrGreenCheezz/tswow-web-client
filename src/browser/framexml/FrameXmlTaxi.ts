/**
 * The stock TaxiFrame's C API (TaxiFrame.lua) over `SMSG_SHOWTAXINODES` and the gateway's
 * TaxiNodes/TaxiPath catalog (`/dbc/taxi`, TaxiMetadata.ts — the same one the native window plans
 * routes with).
 *
 * What TaxiFrame.lua needs, and where each answer comes from:
 *
 * * the node list — every TaxiNodes row on the current node's map that the player's team can fly
 *   (MountCreatureID[1] Alliance / [0] Horde, ObjectMgr::GetTaxiMountDisplayId), or has
 *   discovered; ordered by id so every index-addressed call walks one list;
 * * `TaxiNodeGetType` — CURRENT (the packet's node), NONE (not in the discovered mask: the button is
 *   hidden), REACHABLE (a route of discovered nodes exists, `reachableTaxiRoutes`) or DISTANT;
 * * `TaxiNodePosition` and the route ends — the node's world X/Y through the square the continent's
 *   flight map is drawn for, `WorldMapContinent.TaxiMin/TaxiMax` ({@link frameXmlTaxiMapBounds}),
 *   measured *up from the bottom*: TaxiFrame anchors buttons and route lines to TaxiMap's
 *   BOTTOMLEFT (TaxiFrame.lua:80, 140-142), while the world map's `worldMapPoint` counts v down
 *   from the top;
 * * `SetTaxiMap` — the continent picture `Interface\TaxiFrame\TAXIMAP<mapId>` (the client ships 0,
 *   1, 530 and 571, measured through /texture). It takes a Texture widget, so the world mount
 *   installs it with the bridge (`installFrameXmlTaxiMap`); the flat accessor lives here.
 *
 * `TAXIMAP_OPENED` waits for the catalog: without it every node would read NONE and stock would
 * show an empty map, then DrawOneHopLines would close it with ERR_TAXINOPATHS.
 */
import type { TaxiMenu } from "../../world/TaxiProtocol.js";
import { reachableTaxiRoutes, type TaxiCatalog, type TaxiNodeMetadata, type ReachableTaxiRoute } from "../TaxiMetadata.js";
import { hasMapBounds, worldMapPoint, type MapAreaBounds } from "../MinimapGeometry.js";

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlTaxiWorld {
  readonly taxiMenu?: TaxiMenu | undefined;
  readonly events?: {
    on(name: "TAXI_MENU" | "TAXI_CHANGED", listener: () => void): () => void;
  } | undefined;
  takeTaxi(guid: bigint, nodes: readonly number[]): void;
  closeTaxiMenu(): void;
}

/**
 * The world rectangle a continent's `TAXIMAP<mapId>` picture covers, as map bounds (left/right are
 * world Y, top/bottom world X, the way `worldMapPoint` reads them).
 *
 * `WorldMapContinent.TaxiMin/TaxiMax` hold the corners as world `[x, y]` — measured on this
 * dataset, EK -16530..12270 on both axes, Kalimdor x -11870..12470 and y -13370..10970, Outland x
 * -5867..6400 and y -1600..10670, Northrend x -3733..11730 and y -6933..8533: squares, like the
 * 512x512 pictures. Kalimdor's asymmetric corners settle the order: read as `[x, y]` all 52 of its
 * nodes land on the coast and the towns of TAXIMAP1, read as `[y, x]` a third fall in the sea.
 *
 * A gateway older than the `taxiMin` field (or a custom continent without the row) leaves the
 * continent's WorldMapArea rectangle (area 0) in its place — 1.5:1 where the picture is 1:1, so
 * nodes sit up to ~18 texture px off east-west (the acceptance review's measurement on EK), but on
 * the right continent and in the right order.
 */
export function frameXmlTaxiMapBounds(
  continent: { readonly taxiMin?: readonly [number, number]; readonly taxiMax?: readonly [number, number] } | undefined,
  worldMapArea: MapAreaBounds | undefined,
): MapAreaBounds | undefined {
  const min = continent?.taxiMin;
  const max = continent?.taxiMax;
  if (min && max && [...min, ...max].every(Number.isFinite)) {
    const bounds = { left: max[1], right: min[1], top: max[0], bottom: min[0] };
    if (hasMapBounds(bounds)) return bounds;
  }
  return worldMapArea;
}

/** A `WorldMapTransforms` row, as the area metadata (`/dbc/areas` `transforms`) carries it. */
export interface FrameXmlTaxiMapTransform {
  readonly mapId: number;
  readonly regionBottom: number;
  readonly regionTop: number;
  readonly regionLeft: number;
  readonly regionRight: number;
  readonly newMapId: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly newDungeonMapId?: number;
}

/**
 * Where the flight map draws a node. Quel'Thalas and the Draenei isles are map 530 in TaxiNodes,
 * but the client presents them on the Eastern Kingdoms and Kalimdor pictures: WorldMapTransforms
 * moves those regions of map 530 onto map 0 (row 2, offset -2400, +2400) and map 1 (row 3, offset
 * +10133.33, +17600), the same projection the world map applies (WorldMapHierarchy). Measured on
 * this dataset: Silvermoon, Tranquillien, Zul'Aman and the Sunwell's staging area land in
 * TAXIMAP0's Eversong/Ghostlands, the Exodar and Blood Watch on TAXIMAP1's Azuremyst isles — and
 * without it a Blood Elf or Draenei flight master opened Outland's picture with its own nodes off
 * the map. A node outside every region is drawn where it is.
 */
export function frameXmlTaxiDisplayNode(
  node: TaxiNodeMetadata,
  transforms: readonly FrameXmlTaxiMapTransform[] | undefined,
): TaxiNodeMetadata {
  const transform = transforms?.find((row) => row.mapId === node.mapId && row.newMapId !== node.mapId
    && (row.newDungeonMapId ?? 0) === 0
    && node.x >= Math.min(row.regionBottom, row.regionTop) && node.x <= Math.max(row.regionBottom, row.regionTop)
    && node.y >= Math.min(row.regionRight, row.regionLeft) && node.y <= Math.max(row.regionRight, row.regionLeft));
  return transform
    ? { ...node, mapId: transform.newMapId, x: node.x + transform.offsetX, y: node.y + transform.offsetY }
    : node;
}

export interface FrameXmlTaxiContext {
  world(): FrameXmlTaxiWorld | undefined;
  /** A catalog the host already holds; otherwise the model's `catalogSource` answers. */
  catalog?(): TaxiCatalog | undefined;
  /** Start (or join) the catalog fetch; the model re-syncs when it settles. */
  loadCatalog?(): Promise<unknown> | undefined;
  /** The rectangle a map id's flight map covers ({@link frameXmlTaxiMapBounds}). */
  continent(mapId: number): MapAreaBounds | undefined;
  /** WorldMapTransforms ({@link frameXmlTaxiDisplayNode}); absent, every node is drawn on its own map. */
  transforms?(): readonly FrameXmlTaxiMapTransform[] | undefined;
  playerFaction(): "Alliance" | "Horde" | undefined;
  /** `UNIT_FLAG_ON_TAXI` (0x00100000) on the unit, set by FlightPathMovementGenerator. */
  unitOnTaxi?(unit: string): boolean;
}

interface FrameXmlTaxiPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export type FrameXmlTaxiNodeType = "CURRENT" | "REACHABLE" | "DISTANT" | "NONE";

export interface FrameXmlTaxiNode {
  readonly node: TaxiNodeMetadata;
  readonly type: FrameXmlTaxiNodeType;
  /** The planned flight to this node; absent for the current, distant and unknown ones. */
  readonly route: ReachableTaxiRoute | undefined;
  /** `(u, v)` with v up from the bottom, or undefined when the continent has no rectangle. */
  readonly position: readonly [number, number] | undefined;
}

/** The flight map's view of the catalog's nodes ({@link frameXmlTaxiDisplayNode}). */
function displayNodes(
  catalog: TaxiCatalog,
  transforms: readonly FrameXmlTaxiMapTransform[] | undefined,
): readonly TaxiNodeMetadata[] {
  return transforms?.length ? catalog.nodes.map((node) => frameXmlTaxiDisplayNode(node, transforms)) : catalog.nodes;
}

/**
 * The flight map for one menu: the list stock indexes, each node's type, route and position. Pure,
 * so the canned seam and the tests plan exactly what the live client plans. Nodes are listed and
 * placed on the map they are *drawn* on (`transforms`); routes keep the catalog's ids.
 */
export function frameXmlTaxiNodes(
  menu: TaxiMenu,
  catalog: TaxiCatalog,
  continent: MapAreaBounds | undefined,
  faction: "Alliance" | "Horde" | undefined,
  transforms?: readonly FrameXmlTaxiMapTransform[],
): FrameXmlTaxiNode[] {
  const nodes = displayNodes(catalog, transforms);
  const current = nodes.find((node) => node.id === menu.currentNode);
  if (!current) return [];
  const known = new Set(menu.knownNodes);
  const routes = new Map(reachableTaxiRoutes(catalog, menu.currentNode, menu.knownNodes)
    .map((route) => [route.destination.id, route]));
  const bounds = continent && hasMapBounds(continent) ? continent : undefined;
  const mount = (node: TaxiNodeMetadata): number => faction === "Horde" ? node.mountCreatureIds[0]
    : faction === "Alliance" ? node.mountCreatureIds[1] : Math.max(...node.mountCreatureIds);
  return nodes
    .filter((node) => node.mapId === current.mapId && (node.id === current.id || known.has(node.id) || mount(node) > 0))
    .sort((left, right) => left.id - right.id)
    .map((node): FrameXmlTaxiNode => {
      const route = node.id === current.id ? undefined : routes.get(node.id);
      const type: FrameXmlTaxiNodeType = node.id === current.id ? "CURRENT"
        : !known.has(node.id) ? "NONE" : route ? "REACHABLE" : "DISTANT";
      const point = bounds ? worldMapPoint(bounds, node.x, node.y) : undefined;
      return { node, type, route, position: point ? [point.u, 1 - point.v] : undefined };
    });
}

/** The gateway catalog client (TaxiMetadata.ts `TaxiMetadataClient`) as the model uses it. */
export interface FrameXmlTaxiCatalogSource {
  readonly catalog: TaxiCatalog | undefined;
  load(): Promise<TaxiCatalog | undefined>;
}

/** One owner of the flight map's C API and of TAXIMAP_OPENED/CLOSED. */
export class FrameXmlTaxiModel {
  readonly #context: FrameXmlTaxiContext;
  /**
   * Set by the world mount, which knows the gateway origin: `/dbc/taxi` is fetched on the first
   * flight map, not at boot (the native window does the same).
   */
  catalogSource: FrameXmlTaxiCatalogSource | undefined;
  #pump: FrameXmlTaxiPump | undefined;
  #unsubscribe: (() => void)[] = [];
  #owned = false;
  #muted = false;
  /** The menu TAXIMAP_OPENED was raised for. */
  #shown: TaxiMenu | undefined;
  /** The menu a catalog fetch was started for. */
  #waitingFor: TaxiMenu | undefined;
  #nodes: FrameXmlTaxiNode[] = [];
  #probe: { menu: TaxiMenu; catalog: TaxiCatalog; continent: MapAreaBounds } | undefined;

  constructor(context: FrameXmlTaxiContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlTaxiPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe.push(world.events.on("TAXI_MENU", () => this.sync()));
      this.#unsubscribe.push(world.events.on("TAXI_CHANGED", () => this.sync()));
    }
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
    this.#owned = false;
    this.#shown = undefined;
  }

  /** Whether the stock frame owns flight maps; taking ownership replays an open menu. */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    this.#shown = undefined;
    if (owned) this.sync();
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** Answer every read from a synthetic map for the duration of `operation`, muted. */
  probe<T>(probe: { menu: TaxiMenu; catalog: TaxiCatalog; continent: MapAreaBounds }, operation: () => T): T {
    const previous = this.#probe;
    const previousNodes = this.#nodes;
    this.#probe = probe;
    this.#nodes = frameXmlTaxiNodes(probe.menu, probe.catalog, probe.continent, undefined);
    try { return this.muted(operation); } finally {
      this.#probe = previous;
      this.#nodes = previousNodes;
    }
  }

  /**
   * Raise the edge the world's flight map moved to: TAXIMAP_OPENED for a new menu once the catalog
   * is here (TaxiFrame_OnEvent builds the whole map from it), TAXIMAP_CLOSED once that menu is gone
   * (a flight began, another NPC was clicked, the window was closed).
   */
  sync(): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#probe) return;
    const world = this.#context.world();
    const menu = world?.taxiMenu;
    if (menu && menu !== this.#shown) {
      const catalog = this.#catalog();
      if (!catalog) {
        // One fetch per menu: a failed catalog answers at once and would otherwise spin sync/load.
        if (this.#waitingFor === menu) return;
        this.#waitingFor = menu;
        const loading = this.#context.loadCatalog?.() ?? this.catalogSource?.load();
        void Promise.resolve(loading).then(() => {
          if (this.#catalog()) this.sync();
          else if (this.#pump && this.#owned && this.#context.world()?.taxiMenu === menu) {
            // The native list plans from the same catalog, so it would fail too; say so as the
            // client says a refused flight.
            this.#pump.fire("UI_ERROR_MESSAGE", "Карта маршрутов недоступна.");
          }
        }, () => undefined);
        return;
      }
      this.#waitingFor = undefined;
      this.#shown = menu;
      const transforms = this.#context.transforms?.();
      this.#nodes = frameXmlTaxiNodes(menu, catalog, this.#continentOf(menu, catalog), this.#context.playerFaction(),
        transforms);
      pump.fire("TAXIMAP_OPENED");
      return;
    }
    if (!menu && this.#shown) {
      this.#shown = undefined;
      this.#nodes = [];
      pump.fire("TAXIMAP_CLOSED");
    }
  }

  #catalog(): TaxiCatalog | undefined {
    return this.#context.catalog?.() ?? this.catalogSource?.catalog;
  }

  /**
   * The flight map's rectangle; while the area metadata is not loaded (or a custom map has none)
   * the map's own node extent, padded by a tenth, stands in. The buttons are then spread
   * over the picture rather than on its coasts, but every node has a position: TaxiFrame_OnEvent
   * multiplies `TaxiNodePosition` unguarded (TaxiFrame.lua:59-60), and a nil would abort the map.
   */
  #continentOf(menu: TaxiMenu, catalog: TaxiCatalog): MapAreaBounds | undefined {
    const shown = displayNodes(catalog, this.#context.transforms?.());
    const mapId = shown.find((node) => node.id === menu.currentNode)?.mapId;
    if (mapId === undefined) return undefined;
    const continent = this.#context.continent(mapId);
    if (continent && hasMapBounds(continent)) return continent;
    const nodes = shown.filter((node) => node.mapId === mapId && (node.x !== 0 || node.y !== 0));
    if (nodes.length === 0) return undefined;
    const xs = nodes.map((node) => node.x);
    const ys = nodes.map((node) => node.y);
    const padX = Math.max(1, (Math.max(...xs) - Math.min(...xs)) / 10);
    const padY = Math.max(1, (Math.max(...ys) - Math.min(...ys)) / 10);
    return {
      left: Math.max(...ys) + padY, right: Math.min(...ys) - padY,
      top: Math.max(...xs) + padX, bottom: Math.min(...xs) - padX,
    };
  }

  get showing(): boolean { return this.#shown !== undefined; }

  onTaxi(unit: string): boolean { return this.#context.unitOnTaxi?.(unit) ?? false; }

  // ---- reads ---------------------------------------------------------------------------------

  #at(index: number): FrameXmlTaxiNode | undefined {
    return Number.isInteger(index) && index >= 1 ? this.#nodes[index - 1] : undefined;
  }

  numNodes(): number { return this.#nodes.length; }
  name(index: number): string { return this.#at(index)?.node.name ?? ""; }
  type(index: number): FrameXmlTaxiNodeType { return this.#at(index)?.type ?? "NONE"; }
  position(index: number): readonly [number, number] | undefined { return this.#at(index)?.position; }
  cost(index: number): number { return this.#at(index)?.route?.cost ?? 0; }
  numRoutes(index: number): number {
    const route = this.#at(index)?.route;
    return route ? route.nodes.length - 1 : 0;
  }

  /** One end (`end` 0 source, 1 destination) of hop `hop` of the flight to node `index`. */
  hopEnd(index: number, hop: number, end: 0 | 1): readonly [number, number] | undefined {
    const route = this.#at(index)?.route;
    if (!route || !Number.isInteger(hop) || hop < 1 || hop >= route.nodes.length) return undefined;
    const id = route.nodes[hop - 1 + end];
    return this.#nodes.find((entry) => entry.node.id === id)?.position;
  }

  /**
   * `GetTaxiMapID`: the map the flight map shows — the one the current node is drawn on, so a
   * Silvermoon flight master shows Eastern Kingdoms (0), not Outland (530).
   */
  mapId(): number | undefined {
    return this.#nodes.find((entry) => entry.type === "CURRENT")?.node.mapId;
  }

  /** `SetTaxiMap`'s picture: the client's own continent flight map. */
  mapTexture(): string | undefined {
    const mapId = this.mapId();
    return mapId === undefined ? undefined : `Interface\\TaxiFrame\\TAXIMAP${mapId}`;
  }

  // ---- commands ------------------------------------------------------------------------------

  /** `TakeTaxiNode(index)`: every hop the planner chose, one or express (`WorldClient.takeTaxi`). */
  take(index: number): void {
    const route = this.#at(index)?.route;
    if (!route || this.#muted || this.#probe) return;
    const world = this.#context.world();
    const menu = this.#shown;
    if (!world || !menu || world.taxiMenu !== menu) return;
    world.takeTaxi(menu.guid, route.nodes);
  }

  /** `CloseTaxiMap` — TaxiFrame's OnHide. The world forgets the menu; nothing goes on the wire. */
  close(): void {
    if (this.#muted || this.#probe) return;
    const world = this.#context.world();
    if (!world?.taxiMenu) return;
    world.closeTaxiMenu();
    // WorldClient raises no event for a local close; settle the stock edge here.
    this.sync();
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlTaxiHost {
  readonly taxi?: FrameXmlTaxiModel | undefined;
}

export type FrameXmlTaxiBinding = (host: FrameXmlTaxiHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : 0;
}

const withTaxi = (answer: (taxi: FrameXmlTaxiModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlTaxiBinding =>
  (host, args) => host.taxi ? answer(host.taxi, args) : NOTHING;

const coordinate = (end: 0 | 1, axis: 0 | 1): FrameXmlTaxiBinding => withTaxi((taxi, args) =>
  [taxi.hopEnd(integerArg(args[0]), integerArg(args[1]), end)?.[axis] ?? 0]);

/**
 * The flat C API. `SetTaxiMap` takes a Texture widget and is installed by the world mount with
 * the bridge (`installFrameXmlTaxiMap`); `WebClientTaxiMapTexture` is its flat accessor.
 */
export const FRAMEXML_TAXI_BINDINGS: Readonly<Record<string, FrameXmlTaxiBinding>> = Object.freeze({
  NumTaxiNodes: withTaxi((taxi) => [taxi.numNodes()]),
  TaxiNodeName: withTaxi((taxi, args) => [taxi.name(integerArg(args[0]))]),
  TaxiNodeGetType: withTaxi((taxi, args) => [taxi.type(integerArg(args[0]))]),
  TaxiNodePosition: withTaxi((taxi, args) => taxi.position(integerArg(args[0])) ?? NOTHING),
  TaxiNodeCost: withTaxi((taxi, args) => [taxi.cost(integerArg(args[0]))]),
  // Every route question names its destination (DrawOneHopLines never sets one), so there is no
  // state to keep: the planner answers each call for the node it is asked about.
  TaxiNodeSetCurrent: () => NOTHING,
  TakeTaxiNode: withTaxi((taxi, args) => { taxi.take(integerArg(args[0])); return NOTHING; }),
  GetNumRoutes: withTaxi((taxi, args) => [taxi.numRoutes(integerArg(args[0]))]),
  TaxiGetSrcX: coordinate(0, 0),
  TaxiGetSrcY: coordinate(0, 1),
  TaxiGetDestX: coordinate(1, 0),
  TaxiGetDestY: coordinate(1, 1),
  GetTaxiMapID: withTaxi((taxi) => {
    const mapId = taxi.mapId();
    return mapId === undefined ? NOTHING : [mapId];
  }),
  CloseTaxiMap: withTaxi((taxi) => { taxi.close(); return NOTHING; }),
  UnitOnTaxi: withTaxi((taxi, args) => [taxi.onTaxi(typeof args[0] === "string" ? args[0] : "")]),
  WebClientTaxiMapTexture: withTaxi((taxi) => {
    const texture = taxi.mapTexture();
    return texture === undefined ? NOTHING : [texture];
  }),
});
