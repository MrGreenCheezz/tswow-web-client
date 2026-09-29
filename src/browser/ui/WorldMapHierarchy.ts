import type {
  AreaData, ContinentInfo, MapAreaInfo, MapTransformInfo,
} from "../../gateway/AreaMetadata.js";
import {
  hasMapBounds, worldMapPoint, WORLD_MAP_FRAME_HEIGHT, WORLD_MAP_FRAME_WIDTH,
} from "../MinimapGeometry.js";

export type WorldMapNodeKey = "cosmic" | `world:${number}` | `area:${number}`;

interface WorldMapNodeBase {
  key: WorldMapNodeKey;
  name: string;
  /** Directory and tile prefix under Interface\WorldMap. */
  artName: string;
}

export interface CosmicWorldMapNode extends WorldMapNodeBase {
  kind: "cosmic";
  key: "cosmic";
}

export interface WorldWorldMapNode extends WorldMapNodeBase {
  kind: "world";
  key: `world:${number}`;
  worldMapId: number;
}

export interface AreaWorldMapNode extends WorldMapNodeBase {
  kind: "area";
  key: `area:${number}`;
  mapArea: MapAreaInfo;
  continent?: ContinentInfo;
}

export type WorldMapNode = CosmicWorldMapNode | WorldWorldMapNode | AreaWorldMapNode;

export interface WorldMapTargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WorldMapTarget {
  node: WorldMapNode;
  rect: WorldMapTargetRect;
}

const COSMIC_OUTLAND_RECT = pixelRect(115, 90, 320, 320);
const COSMIC_AZEROTH_RECT = pixelRect(593, 255, 366, 366);

function pixelRect(left: number, top: number, width: number, height: number): WorldMapTargetRect {
  return {
    left: left / WORLD_MAP_FRAME_WIDTH,
    top: top / WORLD_MAP_FRAME_HEIGHT,
    width: width / WORLD_MAP_FRAME_WIDTH,
    height: height / WORLD_MAP_FRAME_HEIGHT,
  };
}

function clippedRect(left: number, top: number, right: number, bottom: number): WorldMapTargetRect | undefined {
  const clippedLeft = Math.max(0, Math.min(1, left));
  const clippedTop = Math.max(0, Math.min(1, top));
  const clippedRight = Math.max(0, Math.min(1, right));
  const clippedBottom = Math.max(0, Math.min(1, bottom));
  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return undefined;
  return {
    left: clippedLeft,
    top: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  };
}

/**
 * The navigation graph hidden in the 3.3.5 tables.
 *
 * `WorldMapContinent.WorldMapID` groups continents under a world overview, `DisplayMapID` moves a
 * zone drawn on a virtual physical map to the continent where the client presents it, and
 * `ParentWorldMapID` is the explicit local-map edge. Keeping those three rules together avoids
 * location allowlists and gives right-click one unambiguous parent at every level.
 */
export class WorldMapHierarchy {
  readonly root: CosmicWorldMapNode = {
    kind: "cosmic", key: "cosmic", name: "Космос", artName: "Cosmic",
  };

  readonly #nodes = new Map<WorldMapNodeKey, WorldMapNode>();
  readonly #parentByKey = new Map<WorldMapNodeKey, WorldMapNodeKey>();
  readonly #childrenByKey = new Map<WorldMapNodeKey, WorldMapNode[]>();
  readonly #continentByMap = new Map<number, ContinentInfo>();
  readonly #transformsByMap = new Map<number, MapTransformInfo[]>();

  constructor(data: Pick<AreaData, "areas" | "maps" | "mapAreas" | "continents" | "transforms">) {
    this.#nodes.set(this.root.key, this.root);
    const areaNames = new Map(data.areas.map((area) => [area.id, area.name]));
    const mapNames = new Map(data.maps.map((map) => [map.id, map.name]));
    const continentAreaByMap = new Map<number, MapAreaInfo>();
    const continentsByWorld = new Map<number, ContinentInfo[]>();

    for (const continent of data.continents) {
      this.#continentByMap.set(continent.mapId, continent);
      const list = continentsByWorld.get(continent.worldMapId) ?? [];
      list.push(continent);
      continentsByWorld.set(continent.worldMapId, list);
    }
    for (const transform of data.transforms) {
      const list = this.#transformsByMap.get(transform.mapId) ?? [];
      list.push(transform);
      this.#transformsByMap.set(transform.mapId, list);
    }
    for (const mapArea of data.mapAreas) {
      if (mapArea.areaId === 0) continentAreaByMap.set(mapArea.mapId, mapArea);
      const localized = mapArea.areaId > 0 ? areaNames.get(mapArea.areaId) : mapNames.get(mapArea.mapId);
      const node: AreaWorldMapNode = {
        kind: "area",
        key: `area:${mapArea.id}`,
        name: localized || mapArea.name,
        artName: mapArea.name,
        mapArea,
        ...(mapArea.areaId === 0 && this.#continentByMap.has(mapArea.mapId)
          ? { continent: this.#continentByMap.get(mapArea.mapId)! }
          : {}),
      };
      this.#nodes.set(node.key, node);
    }

    // A one-continent world (Outland in the stock data) is opened straight from Cosmic. A group
    // with several continents owns the stock World overview between Cosmic and those continents.
    for (const [worldMapId, continents] of continentsByWorld) {
      if (continents.length < 2) continue;
      const key = `world:${worldMapId}` as const;
      this.#nodes.set(key, {
        kind: "world", key, worldMapId,
        name: worldMapId === 1 ? "Азерот" : "Мир",
        artName: "World",
      });
      this.#setParent(key, this.root.key);
    }

    for (const mapArea of data.mapAreas) {
      const key = `area:${mapArea.id}` as const;
      let parent: WorldMapNodeKey | undefined;

      if (mapArea.parentWorldMapId > 0 && this.#nodes.has(`area:${mapArea.parentWorldMapId}`)) {
        parent = `area:${mapArea.parentWorldMapId}`;
      } else if (mapArea.areaId === 0) {
        const continent = this.#continentByMap.get(mapArea.mapId);
        const group = continent ? continentsByWorld.get(continent.worldMapId) : undefined;
        parent = continent && group && group.length > 1
          ? `world:${continent.worldMapId}`
          : this.root.key;
      } else {
        const displayMapId = mapArea.displayMapId >= 0 ? mapArea.displayMapId : mapArea.mapId;
        const continentArea = continentAreaByMap.get(displayMapId);
        parent = continentArea ? `area:${continentArea.id}` : undefined;
      }
      if (parent) this.#setParent(key, parent);
    }

    for (const list of this.#childrenByKey.values()) {
      list.sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
    }
  }

  #setParent(childKey: WorldMapNodeKey, parentKey: WorldMapNodeKey): void {
    if (childKey === parentKey || !this.#nodes.has(childKey) || !this.#nodes.has(parentKey)) return;
    this.#parentByKey.set(childKey, parentKey);
    const list = this.#childrenByKey.get(parentKey) ?? [];
    list.push(this.#nodes.get(childKey)!);
    this.#childrenByKey.set(parentKey, list);
  }

  node(key: WorldMapNodeKey): WorldMapNode {
    const node = this.#nodes.get(key);
    if (!node) throw new RangeError(`Unknown world-map node ${key}`);
    return node;
  }

  find(key: string): WorldMapNode | undefined {
    return this.#nodes.get(key as WorldMapNodeKey);
  }

  area(mapAreaId: number): AreaWorldMapNode | undefined {
    const node = this.#nodes.get(`area:${mapAreaId}`);
    return node?.kind === "area" ? node : undefined;
  }

  get all(): readonly WorldMapNode[] {
    return [...this.#nodes.values()];
  }

  parent(node: WorldMapNode): WorldMapNode | undefined {
    const key = this.#parentByKey.get(node.key);
    return key ? this.#nodes.get(key) : undefined;
  }

  children(node: WorldMapNode): readonly WorldMapNode[] {
    return this.#childrenByKey.get(node.key) ?? [];
  }

  targets(node: WorldMapNode): readonly WorldMapTarget[] {
    const children = this.children(node);
    if (node.kind === "cosmic") return this.#cosmicTargets(children);
    if (node.kind === "world") return children.flatMap((child) => {
      if (child.kind !== "area" || !child.continent) return [];
      const rect = continentWorldRect(child.continent);
      return rect ? [{ node: child, rect }] : [];
    });
    if (!hasMapBounds(node.mapArea)) return [];
    return children.flatMap((child) => {
      if (child.kind !== "area" || !hasMapBounds(child.mapArea)) return [];
      const bounds = this.#boundsInMap(child.mapArea, node.mapArea.mapId);
      if (!bounds) return [];
      const first = worldMapPoint(node.mapArea, bounds.top, bounds.left);
      const second = worldMapPoint(node.mapArea, bounds.bottom, bounds.right);
      const rect = clippedRect(
        Math.min(first.u, second.u), Math.min(first.v, second.v),
        Math.max(first.u, second.u), Math.max(first.v, second.v),
      );
      return rect ? [{ node: child, rect }] : [];
    });
  }

  #boundsInMap(mapArea: MapAreaInfo, targetMapId: number): MapAreaInfo | undefined {
    if (mapArea.mapId === targetMapId) return mapArea;
    if (mapArea.displayMapId !== targetMapId) return undefined;
    const centerX = (mapArea.top + mapArea.bottom) / 2;
    const centerY = (mapArea.left + mapArea.right) / 2;
    const transform = this.#transformAt(mapArea.mapId, targetMapId, centerX, centerY);
    // A ParentWorldMapID edge is still useful for breadcrumbs when its child is a dungeon on a
    // different coordinate sheet, but it must not invent a highlight rectangle there. Likewise,
    // a DisplayMapID row may only borrow a transform which owns the entire authored rectangle.
    // Testing all four corners makes a region boundary explicit instead of trusting its centre.
    if (!transform || ![
      [mapArea.top, mapArea.left],
      [mapArea.top, mapArea.right],
      [mapArea.bottom, mapArea.left],
      [mapArea.bottom, mapArea.right],
    ].every(([x, y]) => this.#transformAt(mapArea.mapId, targetMapId, x!, y!)?.id === transform.id)) {
      return undefined;
    }
    return {
      ...mapArea,
      top: mapArea.top + transform.offsetX,
      bottom: mapArea.bottom + transform.offsetX,
      left: mapArea.left + transform.offsetY,
      right: mapArea.right + transform.offsetY,
    };
  }

  #transformAt(
    mapId: number,
    targetMapId: number,
    x: number,
    y: number,
  ): MapTransformInfo | undefined {
    return this.#transformsByMap.get(mapId)?.find((transform) => transform.newMapId === targetMapId
      && x >= Math.min(transform.regionBottom, transform.regionTop)
      && x <= Math.max(transform.regionBottom, transform.regionTop)
      && y >= Math.min(transform.regionRight, transform.regionLeft)
      && y <= Math.max(transform.regionRight, transform.regionLeft));
  }

  projectPoint(
    mapId: number,
    targetMapId: number,
    x: number,
    y: number,
  ): { x: number; y: number } | undefined {
    if (mapId === targetMapId) return { x, y };
    const transform = this.#transformAt(mapId, targetMapId, x, y);
    return transform ? { x: x + transform.offsetX, y: y + transform.offsetY } : undefined;
  }

  /**
   * Project a player/POI from its physical map onto the map image currently being presented.
   *
   * The normalised result is intentionally absent when no authored transform owns the point. A
   * marker from Outland must disappear from Eastern Kingdoms instead of being drawn at a plausible
   * but false position just because both maps happen to use similarly sized coordinates.
   */
  displayPoint(
    mapArea: MapAreaInfo,
    sourceMapId: number,
    x: number,
    y: number,
  ): { u: number; v: number } | undefined {
    if (!hasMapBounds(mapArea)) return undefined;
    const projected = this.projectPoint(sourceMapId, mapArea.mapId, x, y);
    return projected ? worldMapPoint(mapArea, projected.x, projected.y) : undefined;
  }

  #cosmicTargets(children: readonly WorldMapNode[]): WorldMapTarget[] {
    // These are not guessed geography. They are the two hit frames authored by Blizzard in
    // WorldMapFrame.xml for the stock Cosmic art. Match them by graph shape, not map ids/names:
    // the one-continent branch is one planet, the multi-continent World branch is the other.
    const directContinent = children.find((child) => child.kind === "area" && child.mapArea.areaId === 0);
    const world = children.find((child) => child.kind === "world");
    if (directContinent && world) {
      return [
        { node: directContinent, rect: COSMIC_OUTLAND_RECT },
        { node: world, rect: COSMIC_AZEROTH_RECT },
      ];
    }
    return [];
  }
}

/** The client transform from an ADT boundary to its highlight rectangle on World/World*. */
function continentWorldRect(continent: ContinentInfo): WorldMapTargetRect | undefined {
  const toWorld = (boundary: number, offset: number) => ((boundary - 32) * continent.scale + offset + 32) / 64;
  const left = toWorld(continent.left, continent.offsetX);
  const right = toWorld(continent.right, continent.offsetX);
  const top = toWorld(continent.top, continent.offsetY);
  const bottom = toWorld(continent.bottom, continent.offsetY);
  return clippedRect(Math.min(left, right), Math.min(top, bottom), Math.max(left, right), Math.max(top, bottom));
}

/** Original map mouse semantics: secondary click goes up; primary click opens the smallest hit. */
export function worldMapNavigate(
  hierarchy: WorldMapHierarchy,
  current: WorldMapNode,
  button: number,
  u: number,
  v: number,
): WorldMapNode | undefined {
  if (button === 2) return hierarchy.parent(current);
  if (button !== 0) return undefined;
  return hierarchy.targets(current)
    .filter(({ rect }) => u >= rect.left && u <= rect.left + rect.width
      && v >= rect.top && v <= rect.top + rect.height)
    .sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height)[0]?.node;
}
