/**
 * 10.30 (15.11): the HTTP side of the login screen's account forms (AccountSelfService.ts does the work).
 *
 *   GET  /account/status            {"enabled":true|false} — the login screen asks before it offers the forms
 *   POST /account/register          {username, salt, verifier}
 *   POST /account/password/nonce    {username} → {nonce}
 *   POST /account/password          {username, nonce, salt, verifier, proof}
 *
 * Mounted always, answering only the page origins the gateway already allows (ALLOWED_ORIGINS; anything else
 * 403 with no body). Off unless `GATEWAY_ACCOUNTS=1`: then `status` says `enabled:false` and every POST is
 * 403 `{"error":"disabled"}`. A POST must be `application/json` (which also makes every browser ask the
 * preflight first) and at most 2 KiB. The peer is the socket's address, never a header.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AccountRouteError } from "../auth/AccountWire.js";
import { loginAttemptKey } from "./LoginAttemptLimiter.js";
import type { AccountAnswer, AccountSelfService } from "./AccountSelfService.js";
import { originAllowed } from "./UpgradeGuard.js";

export const ACCOUNT_ROUTE_PREFIX = "/account/";
const POST_ROUTES = new Set(["/account/register", "/account/password/nonce", "/account/password"]);
const MAX_BODY_BYTES = 2048;

/** `GATEWAY_ACCOUNTS`: off unless it says 1/true/on/yes. */
export function parseAccountRoutesEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env["GATEWAY_ACCOUNTS"]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/** `GATEWAY_ACCOUNTS_RESERVED`: comma-separated names nobody may register. */
export function parseReservedAccountNames(env: NodeJS.ProcessEnv): string[] {
  return (env["GATEWAY_ACCOUNTS_RESERVED"] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

export interface AccountRouteOptions {
  /** Absent: the routes answer «disabled». */
  readonly service: AccountSelfService | undefined;
  readonly allowedOrigins: readonly string[];
  readonly peerAddress: (request: IncomingMessage) => string | undefined;
}

function answer(response: ServerResponse, origin: string, status: number, body: AccountAnswer["body"]): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "access-control-allow-origin": origin,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  response.end(data);
}

const refusal = (error: AccountRouteError): AccountAnswer["body"] => ({ error });

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += part.byteLength;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      return undefined;
    }
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Answers the request when it is one of these routes; false otherwise. */
export async function serveAccountRoute(
  request: IncomingMessage, response: ServerResponse, pathname: string, options: AccountRouteOptions,
): Promise<boolean> {
  const isStatus = pathname === "/account/status";
  if (!isStatus && !POST_ROUTES.has(pathname)) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": isStatus ? "GET" : "POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    }).end();
    return true;
  }
  if (isStatus) {
    if (request.method !== "GET") {
      response.writeHead(405, { "access-control-allow-origin": origin, allow: "GET" }).end();
      return true;
    }
    answer(response, origin, 200, { enabled: options.service !== undefined });
    return true;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { "access-control-allow-origin": origin, allow: "POST" }).end();
    return true;
  }
  const service = options.service;
  if (service === undefined) {
    answer(response, origin, 403, refusal("disabled"));
    return true;
  }
  const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    answer(response, origin, 415, refusal("bad-request"));
    return true;
  }
  const body = await readJson(request);
  if (body === undefined) {
    if (!response.destroyed) answer(response, origin, 400, refusal("bad-request"));
    return true;
  }
  const address = loginAttemptKey(options.peerAddress(request));
  const result = pathname === "/account/register" ? await service.register(address, body)
    : pathname === "/account/password/nonce" ? service.passwordNonce(address, body)
      : await service.changePassword(address, body);
  answer(response, origin, result.status, result.body);
  return true;
}
