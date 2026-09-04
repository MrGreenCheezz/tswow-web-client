export interface TaxiNodeMetadata {
  readonly id: number;
  readonly mapId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly name: string;
  readonly mountCreatureIds: readonly [number, number];
}

export interface TaxiPathMetadata {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly cost: number;
}

export interface TaxiCatalog {
  readonly nodes: readonly TaxiNodeMetadata[];
  readonly paths: readonly TaxiPathMetadata[];
}

export interface ReachableTaxiRoute {
  readonly destination: TaxiNodeMetadata;
  /** Every authored hop, ready for CMSG_ACTIVATETAXI or CMSG_ACTIVATETAXIEXPRESS. */
  readonly nodes: readonly number[];
  readonly cost: number;
}

interface RouteState {
  readonly at: number;
  readonly cost: number;
  readonly nodes: readonly number[];
}

function compareNodeLists(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function compareState(left: RouteState, right: RouteState): number {
  return left.cost - right.cost
    || left.nodes.length - right.nodes.length
    || compareNodeLists(left.nodes, right.nodes);
}

/**
 * Finds the cheapest directed route to each discovered destination.
 *
 * Intermediate stops are also required to be discovered. That matches the flight network the
 * server lets this character use and keeps a patched TaxiPath row from becoming a hidden shortcut.
 */
export function reachableTaxiRoutes(
  catalog: TaxiCatalog,
  currentNode: number,
  knownNodes: readonly number[],
): ReachableTaxiRoute[] {
  const byId = new Map(catalog.nodes.map((node) => [node.id, node]));
  if (!byId.has(currentNode)) return [];
  const allowed = new Set(knownNodes.filter((id) => byId.has(id)));
  allowed.add(currentNode);

  const outgoing = new Map<number, TaxiPathMetadata[]>();
  for (const path of catalog.paths) {
    if (!allowed.has(path.from) || !allowed.has(path.to) || path.cost < 0) continue;
    const edges = outgoing.get(path.from) ?? [];
    edges.push(path);
    outgoing.set(path.from, edges);
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) => left.cost - right.cost || left.to - right.to || left.id - right.id);
  }

  const best = new Map<number, RouteState>();
  const unsettled = new Map<number, RouteState>();
  unsettled.set(currentNode, { at: currentNode, cost: 0, nodes: [currentNode] });
  while (unsettled.size > 0) {
    let next: RouteState | undefined;
    for (const candidate of unsettled.values()) {
      if (!next || compareState(candidate, next) < 0) next = candidate;
    }
    if (!next) break;
    unsettled.delete(next.at);
    if (best.has(next.at)) continue;
    best.set(next.at, next);
    for (const edge of outgoing.get(next.at) ?? []) {
      if (best.has(edge.to)) continue;
      const candidate: RouteState = {
        at: edge.to,
        cost: next.cost + edge.cost,
        nodes: [...next.nodes, edge.to],
      };
      const previous = unsettled.get(edge.to);
      if (!previous || compareState(candidate, previous) < 0) unsettled.set(edge.to, candidate);
    }
  }

  const routes: ReachableTaxiRoute[] = [];
  for (const id of allowed) {
    if (id === currentNode) continue;
    const destination = byId.get(id);
    const route = best.get(id);
    if (!destination?.name || !route || route.nodes.length < 2) continue;
    routes.push({ destination, nodes: route.nodes, cost: route.cost });
  }
  routes.sort((left, right) => left.destination.name.localeCompare(right.destination.name, "ru")
    || left.cost - right.cost || compareNodeLists(left.nodes, right.nodes));
  return routes;
}

const TAXI_CATALOG_TIMEOUT_MS = 5_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validNode(value: unknown): value is TaxiNodeMetadata {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<TaxiNodeMetadata>;
  return Number.isInteger(node.id) && (node.id ?? 0) > 0
    && Number.isInteger(node.mapId)
    && finite(node.x) && finite(node.y) && finite(node.z)
    && typeof node.name === "string"
    && Array.isArray(node.mountCreatureIds) && node.mountCreatureIds.length === 2
    && node.mountCreatureIds.every((id) => Number.isInteger(id) && id >= 0);
}

function validPath(value: unknown): value is TaxiPathMetadata {
  if (!value || typeof value !== "object") return false;
  const path = value as Partial<TaxiPathMetadata>;
  return Number.isInteger(path.id) && (path.id ?? 0) > 0
    && Number.isInteger(path.from) && (path.from ?? 0) > 0
    && Number.isInteger(path.to) && (path.to ?? 0) > 0
    && Number.isInteger(path.cost) && (path.cost ?? -1) >= 0;
}

function validateCatalog(value: unknown): TaxiCatalog {
  if (!value || typeof value !== "object") throw new Error("malformed taxi catalog");
  const candidate = value as Partial<TaxiCatalog>;
  if (!Array.isArray(candidate.nodes) || !candidate.nodes.every(validNode)
    || !Array.isArray(candidate.paths) || !candidate.paths.every(validPath)) {
    throw new Error("malformed taxi catalog");
  }
  const ids = new Set(candidate.nodes.map((node) => node.id));
  if (ids.size !== candidate.nodes.length
    || candidate.paths.some((path) => !ids.has(path.from) || !ids.has(path.to))) {
    throw new Error("taxi catalog has duplicate or dangling nodes");
  }
  return Object.freeze({
    nodes: Object.freeze(candidate.nodes.map((node) => Object.freeze({
      ...node,
      mountCreatureIds: Object.freeze([...node.mountCreatureIds]) as unknown as readonly [number, number],
    }))),
    paths: Object.freeze(candidate.paths.map((path) => Object.freeze({ ...path }))),
  });
}

/** One session cache for the fixed TaxiNodes/TaxiPath catalog. */
export class TaxiMetadataClient {
  readonly #url: string;
  #catalog: TaxiCatalog | undefined;
  #pending: Promise<TaxiCatalog | undefined> | undefined;
  #failed = false;

  constructor(gatewayOrigin: string) {
    this.#url = new URL("/dbc/taxi", gatewayOrigin).href;
  }

  get catalog(): TaxiCatalog | undefined {
    return this.#catalog;
  }

  load(): Promise<TaxiCatalog | undefined> {
    if (this.#catalog) return Promise.resolve(this.#catalog);
    if (this.#pending) return this.#pending;
    if (this.#failed) return Promise.resolve(undefined);
    this.#pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TAXI_CATALOG_TIMEOUT_MS);
      try {
        const response = await fetch(this.#url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Taxi gateway returned ${response.status}`);
        this.#catalog = validateCatalog(await response.json());
        return this.#catalog;
      } catch {
        this.#failed = true;
        return undefined;
      } finally {
        clearTimeout(timeout);
        this.#pending = undefined;
      }
    })();
    return this.#pending;
  }
}
