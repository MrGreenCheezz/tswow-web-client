interface BrowserLocation {
  protocol: string;
  hostname: string;
}

type PublicEnvironment = {
  VITE_GATEWAY_ORIGIN?: string;
  VITE_GATEWAY_ALLOWED_ORIGINS?: string;
  VITE_CLIENT_LOCALE?: string;
};

/** What `glue/FrontDoor.gatewayOverride` checks a `?gateway=` link against (10.03). */
export interface GatewayPolicy {
  /** `location.hostname` of the page itself. */
  readonly pageHostname: string;
  /** The gateway the page would use with no override (`VITE_GATEWAY_ORIGIN` or `<host>:8090`). */
  readonly defaultOrigin: string;
  /** `VITE_GATEWAY_ALLOWED_ORIGINS` plus the origins this browser was told to trust by hand. */
  readonly allowedOrigins: readonly string[];
}

/** `localStorage` key holding a JSON array of extra gateway origins this browser trusts. */
export const GATEWAY_ALLOWED_STORAGE_KEY = "webclient.gatewayAllowed";

/** Origins this browser was told to trust by hand; a broken or blocked storage is an empty list. */
export function storedGatewayAllowList(storage?: Pick<Storage, "getItem"> | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(GATEWAY_ALLOWED_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    // Site data blocked (the getter throws) or a hand-typed value that is not JSON: trust nothing extra.
    return [];
  }
}

/**
 * The gateway policy of the page it runs in: its host, its compiled default gateway, the build's
 * allow-list (`VITE_GATEWAY_ALLOWED_ORIGINS`, comma separated) and this browser's own list.
 */
export function gatewayPolicy(
  location: BrowserLocation,
  configuredAllowed = publicEnvironment().VITE_GATEWAY_ALLOWED_ORIGINS,
  storage?: Pick<Storage, "getItem"> | null,
  configuredDefault = publicEnvironment().VITE_GATEWAY_ORIGIN,
): GatewayPolicy {
  return {
    pageHostname: location.hostname,
    defaultOrigin: gatewayOrigin(location, configuredDefault),
    allowedOrigins: [
      ...(configuredAllowed ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
      ...storedGatewayAllowList(storage),
    ],
  };
}

/** `gatewayPolicy` of the current page; outside a browser there is no page and nothing is trusted. */
export function pageGatewayPolicy(): GatewayPolicy {
  const location = (globalThis as { location?: BrowserLocation }).location;
  if (!location) return { pageHostname: "", defaultOrigin: "", allowedOrigins: [] };
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  return gatewayPolicy(location, undefined, storage);
}

function publicEnvironment(): PublicEnvironment {
  return (import.meta as ImportMeta & { readonly env?: PublicEnvironment }).env ?? {};
}

/** HTTP(S) origin used for gateway metadata and as the base for its WebSocket routes. */
export function gatewayOrigin(location: BrowserLocation, configured = publicEnvironment().VITE_GATEWAY_ORIGIN): string {
  const explicit = configured?.trim().replace(/\/+$/, "");
  if (explicit) {
    const parsed = new URL(explicit);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("VITE_GATEWAY_ORIGIN must use http:// or https://");
    }
    return parsed.origin;
  }
  return `${location.protocol === "https:" ? "https" : "http"}://${location.hostname}:8090`;
}

export function gatewayWebSocketUrl(location: BrowserLocation, route = "/auth"): string {
  const url = new URL(route, gatewayOrigin(location));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** Four-character locale sent in the 3.3.5a logon challenge. */
export function clientLocale(configured = publicEnvironment().VITE_CLIENT_LOCALE): string {
  const locale = configured?.trim() || "ruRU";
  if (!/^[a-z]{2}[A-Z]{2}$/.test(locale)) throw new Error(`Invalid VITE_CLIENT_LOCALE: ${locale}`);
  return locale;
}
