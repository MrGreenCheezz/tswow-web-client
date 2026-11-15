/**
 * 10.30 (15.11): the login screen's account forms talking to the gateway (src/gateway/AccountRoutes.ts) and,
 * for a password change, to the authserver.
 *
 * The password stays in the page: a registration sends the name with the SRP6 salt and verifier computed here
 * (SrpRegistration.ts); a change first logs in to the authserver through `/auth` with the old password — the
 * same SRP6 login the login button makes (auth/login.ts) — and then proves that login to the gateway with an
 * HMAC under its session key over the new salt and verifier and a nonce the gateway issued
 * (AccountWire.ts `passwordChangeMessage`). The authserver connection is closed as soon as the login is done.
 */

import {
  bytesToHex, hexToBytes, PASSWORD_NONCE_BYTES, passwordChangeMessage, upperLatin, type AccountRouteError,
} from "../../auth/AccountWire.js";
import { loginToRealmList } from "../../auth/login.js";
import { hmacSha1 } from "../../auth/Sha1.js";
import { makeRegistrationData } from "../../auth/SrpRegistration.js";
import type { BinaryByteStream } from "../../transport/WebSocketByteStream.js";

export type GlueAccountOutcome =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly error: AccountRouteError | "network" }
  /** The authserver refused the old password (or could not be reached): the login's own error. */
  | { readonly ok: false; readonly error: "auth"; readonly cause: unknown };

export interface GlueAccountClientOptions {
  /** The gateway's origin, `http(s)://host:port`. */
  readonly gatewayOrigin: string;
  /** The gateway's `/auth` WebSocket URL. */
  readonly authUrl: string;
  readonly connect: (url: string) => Promise<BinaryByteStream>;
  readonly locale?: string;
  /** Injected by tests; the page's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  /** Injected by tests; 32 random bytes otherwise. */
  readonly salt?: () => Uint8Array;
}

const KNOWN_ERRORS: ReadonlySet<string> = new Set<AccountRouteError>([
  "disabled", "bad-request", "bad-name", "taken", "too-many", "busy", "unavailable", "not-proven", "unsupported-schema",
  "uncertain",
]);

export class GlueAccountClient {
  readonly #options: GlueAccountClientOptions;

  constructor(options: GlueAccountClientOptions) {
    this.#options = options;
  }

  /** Whether this gateway has the forms switched on (`GATEWAY_ACCOUNTS=1`); false when it cannot say. */
  async available(): Promise<boolean> {
    try {
      const response = await this.#fetch()(`${this.#options.gatewayOrigin}/account/status`, { cache: "no-store" });
      if (!response.ok) return false;
      const body = await response.json() as unknown;
      return typeof body === "object" && body !== null && (body as { enabled?: unknown }).enabled === true;
    } catch {
      return false;
    }
  }

  async register(name: string, password: string): Promise<GlueAccountOutcome> {
    const data = await makeRegistrationData(name, password, ...this.#salt());
    const answer = await this.#post("/account/register", {
      username: data.username, salt: bytesToHex(data.salt), verifier: bytesToHex(data.verifier),
    });
    return "error" in answer ? answer : { ok: true, username: data.username };
  }

  async changePassword(name: string, oldPassword: string, newPassword: string): Promise<GlueAccountOutcome> {
    const username = upperLatin(name);
    let stream: BinaryByteStream | undefined;
    let sessionKey: Uint8Array;
    try {
      stream = await this.#options.connect(this.#options.authUrl);
      sessionKey = (await loginToRealmList(stream, {
        username, password: oldPassword, locale: this.#options.locale ?? "ruRU",
      })).sessionKey;
    } catch (cause) {
      return { ok: false, error: "auth", cause };
    } finally {
      stream?.close();
    }
    const issued = await this.#post("/account/password/nonce", { username });
    if ("error" in issued) return issued;
    const nonce = hexToBytes(issued.body["nonce"], PASSWORD_NONCE_BYTES);
    if (!nonce) return { ok: false, error: "bad-request" };
    const data = await makeRegistrationData(username, newPassword, ...this.#salt());
    const proof = hmacSha1(sessionKey, passwordChangeMessage(username, nonce, data.salt, data.verifier));
    const answer = await this.#post("/account/password", {
      username, nonce: bytesToHex(nonce), salt: bytesToHex(data.salt), verifier: bytesToHex(data.verifier), proof: bytesToHex(proof),
    });
    return "error" in answer ? answer : { ok: true, username };
  }

  #fetch(): typeof fetch {
    return this.#options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  #salt(): [] | [Uint8Array] {
    return this.#options.salt ? [this.#options.salt()] : [];
  }

  async #post(path: string, body: Record<string, string>): Promise<
    { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly error: AccountRouteError | "network" }
  > {
    let response: Response;
    try {
      response = await this.#fetch()(`${this.#options.gatewayOrigin}${path}`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, error: "network" };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const fields = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
    if (response.ok) return { ok: true, body: fields };
    const error = fields["error"];
    if (typeof error === "string" && KNOWN_ERRORS.has(error)) return { ok: false, error: error as AccountRouteError };
    return { ok: false, error: response.status === 429 ? "too-many" : response.status === 403 ? "disabled" : "unavailable" };
  }
}
