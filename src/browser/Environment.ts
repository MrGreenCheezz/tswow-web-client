interface BrowserLocation {
  protocol: string;
  hostname: string;
}

type PublicEnvironment = {
  VITE_GATEWAY_ORIGIN?: string;
  VITE_CLIENT_LOCALE?: string;
};

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
