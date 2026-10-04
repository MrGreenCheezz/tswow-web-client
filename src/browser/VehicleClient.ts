import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";
import {
  VEHICLE_CATALOG_PATHNAME, VEHICLE_CATALOG_VERSION, vehicleCatalogFrom, type VehicleCatalog,
} from "../world/VehicleDbc.js";

/**
 * 11.02-F1: the vehicle tables in the page — Vehicle, VehicleSeat, VehicleUIIndicator and
 * VehicleUIIndSeat from `GET /dbc/vehicles?v=1` (gateway/VehicleMetadata.ts), all rows at once.
 *
 * The seat model (world/VehicleSeatModel.ts), the stock vehicle UI's C API (slice F2), the vehicle
 * camera (G) and the passenger poses (H) read `vehicleCatalog()` when they need a row; until it lands
 * it is undefined and each of them answers as if no unit were a vehicle — the behaviour before this
 * slice. Started at the world mount and stopped when the session is retired (EnterWorld.ts), never from
 * a frame. A gateway process older than the route answers 404; `RetryingCatalogClient` asks once more
 * after 15 s and then waits for the next world mount, which revives it (`retry`) — so a gateway
 * restarted between two logins is picked up without reloading the page.
 */

export const VEHICLE_ROUTE_PATH = `${VEHICLE_CATALOG_PATHNAME}?v=${VEHICLE_CATALOG_VERSION}`;

export class VehicleClient {
  /** The gateway's http origin these tables belong to. */
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<VehicleCatalog>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, VEHICLE_ROUTE_PATH, (data) => vehicleCatalogFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  get catalog(): VehicleCatalog | undefined {
    return this.#catalog.value;
  }

  load(): Promise<void> {
    return this.#catalog.load();
  }

  retry(): Promise<void> {
    return this.#catalog.retry();
  }

  /** Ends the retry schedule; tables already held are kept for the next mount. */
  stop(): void {
    this.#catalog.stop();
  }
}

let current: VehicleClient | undefined;

/**
 * Every world mount: the page's one vehicle client for this gateway. Kept across characters — the
 * rows belong to the dataset — and asked again only when they never arrived. Another gateway is
 * another client.
 */
export function startVehicleData(gatewayUrl: string, options: RetryingCatalogOptions = {}): VehicleClient {
  const origin = new URL(gatewayUrl.replace(/^ws/, "http")).origin;
  if (current?.origin !== origin) {
    current?.stop();
    current = new VehicleClient(origin, options);
  }
  void current.retry();
  return current;
}

/** The world session is retired: no retry keeps asking behind the character screen. */
export function stopVehicleData(): void {
  current?.stop();
}

/** The tables of the current gateway; undefined until they land (or against a gateway without the route). */
export function vehicleCatalog(): VehicleCatalog | undefined {
  return current?.catalog;
}
