"use strict";

/**
 * L10 (10.17) — where the page's gateway is, decided without `electron` so `node --test` can
 * require it (tests/electron-gateway-target.test.mjs).
 *
 * The page finds its gateway by itself: VITE_GATEWAY_ORIGIN baked into the build, else the page's
 * own host on 8090 (src/browser/Environment.ts), and a `?gateway=` link to a gateway on the page's
 * host (src/browser/glue/FrontDoor.ts, 10.03). The shell needs the same address to wait for it and
 * to mark it secure, and used to assume <page host>:8090. A players' server whose gateway listens
 * elsewhere says so in the player app's server.json (`gatewayPort`, or `gatewayUrl` for another
 * host or TLS) or on the command line (--gateway-port, --gateway-url); the shell then opens the page
 * with that `?gateway=`, so page and shell agree. A gateway on another host is used by the page
 * only when its build trusts it (VITE_GATEWAY_ORIGIN or VITE_GATEWAY_ALLOWED_ORIGINS).
 */

/** The port the page uses with no VITE_GATEWAY_ORIGIN (Environment.gatewayOrigin). */
const DEFAULT_GATEWAY_PORT = 8090;

/**
 * `gatewayPort` and `gatewayUrl` of server.json (or of the command line, `label` naming it): absent
 * fields stay absent; a wrong one throws with the label and the value.
 */
function parseGatewaySettings(source, label = "server.json") {
  const settings = {};
  const port = source?.gatewayPort;
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${label}: gatewayPort must be a port number 1…65535, not ${typeof port === "string" ? JSON.stringify(port) : String(port)}`);
    }
    settings.gatewayPort = port;
  }
  const url = source?.gatewayUrl;
  if (url !== undefined) {
    let parsed;
    try {
      parsed = typeof url === "string" ? new URL(url) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error(`${label}: gatewayUrl must be http(s)://host[:port], not ${JSON.stringify(url)}`);
    }
    settings.gatewayUrl = parsed.origin;
  }
  return settings;
}

/** The command line's gateway, when it names one, replaces server.json's as a whole. */
function chooseGatewaySettings(fromFile, fromCommandLine) {
  return Object.keys(fromCommandLine ?? {}).length > 0 ? { ...fromCommandLine } : { ...(fromFile ?? {}) };
}

/** A `?gateway=` value read the way FrontDoor.parseGatewayOverride reads it, or undefined. */
function queryGateway(raw) {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    if (url.protocol === "ws:") return `http://${url.host}`;
    if (url.protocol === "wss:") return `https://${url.host}`;
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gateway of the page at `pageUrl`: `{ origin, hostname, port, pageUrl }`. Configured settings
 * win (`gatewayUrl`, then `gatewayPort` on the page's host) and are written into the returned
 * `pageUrl` as `?gateway=`; otherwise a `?gateway=` the address already carries, else the page's
 * host on 8090 in the page's scheme, with `pageUrl` returned unchanged.
 */
function gatewayTarget(pageUrl, settings = {}) {
  const page = new URL(pageUrl);
  const scheme = page.protocol === "https:" ? "https" : "http";
  const configured = settings.gatewayUrl
    ?? (settings.gatewayPort === undefined ? undefined : `${scheme}://${page.hostname}:${settings.gatewayPort}`);
  const gateway = new URL(configured ?? queryGateway(page.searchParams.get("gateway")) ?? `${scheme}://${page.hostname}:${DEFAULT_GATEWAY_PORT}`);
  if (configured !== undefined) page.searchParams.set("gateway", gateway.origin);
  return {
    origin: gateway.origin,
    hostname: gateway.hostname,
    port: Number(gateway.port) || (gateway.protocol === "https:" ? 443 : 80),
    pageUrl: configured === undefined ? pageUrl : page.href,
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * What `unsafely-treat-insecure-origin-as-secure` lists: a plain-http page on a non-loopback
 * address and its gateway when that is plain http too. Empty when the page is a secure context
 * already (https, or loopback).
 */
function insecureOriginsToTrust(pageUrl, gatewayOrigin) {
  const page = new URL(pageUrl);
  if (page.protocol !== "http:" || LOOPBACK_HOSTS.has(page.hostname)) return [];
  const gateway = new URL(gatewayOrigin);
  return gateway.protocol === "http:" ? [page.origin, gateway.origin] : [page.origin];
}

/**
 * The player app's server.json (build.mjs --player): the page, no CPU policy, and the gateway only
 * when it is not the page host's 8090, so a default build writes the same file as before.
 */
function playerServerConfig(url, settings = {}) {
  return {
    url,
    cpuClass: "none",
    priority: "normal",
    ...(settings.gatewayPort !== undefined && settings.gatewayPort !== DEFAULT_GATEWAY_PORT ? { gatewayPort: settings.gatewayPort } : {}),
    ...(settings.gatewayUrl !== undefined ? { gatewayUrl: settings.gatewayUrl } : {}),
  };
}

module.exports = {
  DEFAULT_GATEWAY_PORT, chooseGatewaySettings, gatewayTarget, insecureOriginsToTrust, parseGatewaySettings, playerServerConfig,
};
