import type { IncomingHttpHeaders } from "node:http";
import { isLoopbackAddress } from "./ModuleIndex.js";

/**
 * 10.04 — when `PUT /modules/…` may write.
 *
 * The route is the one place this process writes to the disk, and what it writes (`/modules/*`
 * windows and styles) is served to every player. Two layers:
 *
 * 1. At start-up (`assertModuleWritePolicy`): `MODULE_UI_WRITE=1` is accepted only on a gateway
 *    that is loopback-only in both directions — bound to loopback and trusting only loopback page
 *    origins. `ALLOWED_ORIGINS=*` next to writing would let any page open in the owner's browser
 *    send the `PUT` from `127.0.0.1` (the preflight echoes its origin), and the socket check alone
 *    would wave it through. The gateway refuses to start rather than quietly switching the write
 *    off, so the owner notices and fixes the one variable that is wrong.
 * 2. Per request (`moduleWriteRefusal`): even on such a gateway the request itself has to look
 *    local — loopback socket, loopback `Origin` and no proxy headers (a reverse proxy on this machine
 *    makes every visitor's socket look local).
 */

export interface ModuleWriteSettings {
  readonly moduleWrite: boolean;
  readonly host: string;
  readonly allowedOrigins: readonly string[];
}

/** Hostname of a loopback address, in any spelling `URL` or an operator might give it. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
    || host === "::ffff:127.0.0.1";
}

/** An `Origin` value naming a page on this machine: `http(s)://127.x`, `localhost` or `[::1]`. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/** Why this configuration may not write, or `undefined` when it may (or writing is off). */
export function moduleWritePolicyProblem(settings: ModuleWriteSettings): string | undefined {
  if (!settings.moduleWrite) return undefined;
  const problems: string[] = [];
  if (!isLoopbackHostname(settings.host)) problems.push(`GATEWAY_HOST=${settings.host}`);
  if (settings.allowedOrigins.includes("*")) problems.push("ALLOWED_ORIGINS contains *");
  const foreign = settings.allowedOrigins.filter((origin) => origin !== "*" && !isLoopbackOrigin(origin));
  if (foreign.length > 0) problems.push(`ALLOWED_ORIGINS has non-loopback ${foreign.join(", ")}`);
  if (problems.length === 0) return undefined;
  return "MODULE_UI_WRITE=1 requires GATEWAY_HOST=127.0.0.1 and ALLOWED_ORIGINS listing only loopback "
    + `pages (no *, no other hosts); now: ${problems.join("; ")}. `
    + "Set MODULE_UI_WRITE=0 or make the gateway loopback-only.";
}

/** Throws before the gateway starts when writing is asked for on a gateway that is not local. */
export function assertModuleWritePolicy(settings: ModuleWriteSettings): void {
  const problem = moduleWritePolicyProblem(settings);
  if (problem !== undefined) throw new Error(problem);
}

const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"] as const;

/** Why this one `PUT` is refused, or `undefined` when it looks like the owner's own page. */
export function moduleWriteRefusal(headers: IncomingHttpHeaders, peer: string | undefined): string | undefined {
  if (!isLoopbackAddress(peer)) return "peer is not loopback";
  for (const name of PROXY_HEADERS) {
    if (headers[name] !== undefined) return `forwarded request (${name})`;
  }
  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  if (!isLoopbackOrigin(origin)) return "origin is not loopback";
  // No `Sec-Fetch-Site` rule: a browser calls localhost:5173 -> 127.0.0.1:8090 "cross-site" although
  // both are this machine, and the route has already required this exact Origin in ALLOWED_ORIGINS
  // (loopback-only whenever writing is on), so the header could only refuse the owner's own page.
  return undefined;
}
