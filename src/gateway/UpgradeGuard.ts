import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * The WebSocket upgrade path of the gateway, in two pieces that cannot end the process (1.03).
 *
 * Node takes its own error handling off a socket the moment it hands it to a server's `upgrade`
 * listener. From then on a throw out of the listener is an uncaught exception — `new URL("//[::1",
 * …)` throws ERR_INVALID_URL, one request's worth of attack — and so is an `error` event with nobody
 * listening: a peer's RST that beats a refusal's own write (`write ECONNRESET`), or that arrives on a
 * refused socket left half-open by `socket.end()` alone (`read ECONNRESET`). Either one ended the
 * gateway, and under `online/start-server.bat` the page the players load with it.
 *
 * So `routeUpgrade` returns every refusal as data rather than throwing, and `refuseUpgrade` is the one
 * way a refusal is written: an `error` listener before the first byte, the answer, then `destroy`, so
 * nothing is left half-open for a later RST to land on. The gateway's one Origin rule lives here too
 * ({@link originAllowed}), shared with every HTTP route. Pure: nothing here knows about `ws`.
 */

/** Every status the upgrade path refuses with. */
export type UpgradeRefusal = 400 | 403 | 404 | 500 | 503;

export type UpgradeRoute = { kind: "auth" | "world" } | { kind: "refuse"; status: UpgradeRefusal };

export interface UpgradeRouteOptions {
  allowedOrigins: readonly string[];
}

const REASONS: Readonly<Record<UpgradeRefusal, string>> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** How long a refused peer that will not take its answer may keep the socket. */
const REFUSAL_TIMEOUT_MS = 5_000;

/**
 * Whether a request's Origin may use the gateway: the one rule for every HTTP route (Gateway.ts) and
 * for the WebSocket upgrade. An exact entry of `allowed`, or any Origin when `allowed` holds `*`; a
 * request that sends no Origin at all is refused either way. It is a header the caller writes, so
 * this is a resource rule and not authentication.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): origin is string {
  return origin !== undefined && (allowed.includes("*") || allowed.includes(origin));
}

/**
 * Where an upgrade goes, or the status it is refused with.
 *
 * The Origin comes first ({@link originAllowed}), so a page on a foreign origin is refused before
 * anything it wrote is parsed. A path that does not parse is a 400 — the client is told why — rather
 * than the exception it used to be.
 */
export function routeUpgrade(request: Pick<IncomingMessage, "headers" | "url">, options: UpgradeRouteOptions): UpgradeRoute {
  if (!originAllowed(request.headers.origin, options.allowedOrigins)) return { kind: "refuse", status: 403 };
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://gateway.local").pathname;
  } catch {
    return { kind: "refuse", status: 400 };
  }
  if (pathname === "/auth") return { kind: "auth" };
  if (pathname === "/world") return { kind: "world" };
  return { kind: "refuse", status: 404 };
}

/**
 * Answers `status` on an upgrade socket and closes it for good.
 *
 * `end()` alone half-closes: the answer goes out, but the socket stays open until the peer closes
 * its side — measured on the model of this handler, 200 refusals left 200 sockets open — and a
 * later RST on it is an unhandled `error`. Hence the listener before the write and `destroy` once the
 * answer is out; the timeout covers a peer that never takes the answer at all. Never throws.
 */
export function refuseUpgrade(socket: Duplex, status: UpgradeRefusal): void {
  socket.on("error", () => socket.destroy());
  try {
    if (socket.destroyed) return;
    if (socket instanceof Socket) socket.setTimeout(REFUSAL_TIMEOUT_MS, () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  } catch {
    socket.destroy();
  }
}
