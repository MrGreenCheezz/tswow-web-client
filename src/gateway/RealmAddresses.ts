import { parseRealmList, REALM_LIST } from "../auth/AuthProtocol.js";
import { challengeAnswerLength } from "./AuthLoginVerdict.js";
import type { GatewayTarget } from "./Gateway.js";
import type { BackendDataSource } from "./LoginAttemptLimiter.js";

/**
 * 10.27 — the world socket goes where the realm list says, and nowhere else.
 *
 * Wow.exe opens the world connection on the `address` of the realm the player picked. The gateway
 * relays that choice: the page names the realm's address on `/world?realm=`, and the gateway connects
 * there only if its own authserver announced that address over this gateway. Anything else would make
 * the gateway a relay to any host a page asks for. The authserver is the one the gateway was configured
 * with (`AUTH_HOST`), so what it announces is the operator's word.
 *
 * Why the address is the right one for the gateway, not only for players: the authserver picks it per
 * client (TrinityCore `Realm::GetAddressForClient`, AzerothCore the same). A loopback client gets the
 * loopback or the local address, one inside `localSubnetMask` gets `localAddress`, anyone else
 * `address`. To the authserver the client is the gateway, so it hears the address it can reach.
 *
 * What is read: the authserver -> browser half of each `/auth` connection, as `AuthAnswerWatch` reads
 * it for 10.01, and never the browser's half. A connection carries one login (see AuthLoginVerdict.ts):
 * the challenge answer, the proof answer, and only after a successful proof the `REALM_LIST` answers,
 * each `0x10`, a 16-bit size and that many bytes. The proof answer of build 12340 is 32 bytes: cmd,
 * error, M2[20], account flags, survey id and login flags (`parseLogonProof`, src/auth/AuthProtocol.ts).
 * Anything out of that order stops the reading for the connection.
 */

/** The success answer to `AUTH_LOGON_PROOF` for build 12340. */
const PROOF_ANSWER_LENGTH = 32;
const AUTH_LOGON_CHALLENGE = 0x00;
const AUTH_LOGON_PROOF = 0x01;

/**
 * How long an announced address stays connectable. A world connection follows the realm list of the
 * same login, so this only has to outlast the character screen; every new realm list renews it.
 */
export const REALM_ADDRESS_TTL_MS = 24 * 60 * 60_000;
/** At most this many addresses are kept; the oldest goes first. */
export const REALM_ADDRESS_LIMIT = 64;

type Stage = "challenge" | "proof" | "realms" | "done";

/** Reads one `/auth` connection's authserver bytes and reports the addresses of each realm list. */
export class RealmListWatch {
  #held = new Uint8Array(0);
  #stage: Stage = "challenge";
  readonly #onRealms: (addresses: readonly string[]) => void;

  constructor(onRealms: (addresses: readonly string[]) => void) {
    this.#onRealms = onRealms;
  }

  /** False once the connection left the order above; nothing more is held or read. */
  get reading(): boolean {
    return this.#stage !== "done";
  }

  feed(chunk: Uint8Array): void {
    if (this.#stage === "done" || chunk.byteLength === 0) return;
    const held = new Uint8Array(this.#held.byteLength + chunk.byteLength);
    held.set(this.#held);
    held.set(chunk, this.#held.byteLength);
    let at = 0;
    for (;;) {
      const used = this.#step(held.subarray(at));
      if (used === 0) break;
      at += used;
    }
    this.#held = this.reading ? held.slice(at) : new Uint8Array(0);
  }

  /** Bytes taken by the next whole message, or 0 while it is incomplete or the reading has stopped. */
  #step(bytes: Uint8Array): number {
    if (this.#stage === "challenge") {
      if (bytes.byteLength < 3) return 0;
      if (bytes[0] !== AUTH_LOGON_CHALLENGE || bytes[2] !== 0) return this.#stop();
      const length = challengeAnswerLength(bytes);
      if (length === undefined || bytes.byteLength < length) return 0;
      this.#stage = "proof";
      return length;
    }
    if (this.#stage === "proof") {
      if (bytes.byteLength < 2) return 0;
      if (bytes[0] !== AUTH_LOGON_PROOF || bytes[1] !== 0) return this.#stop();
      if (bytes.byteLength < PROOF_ANSWER_LENGTH) return 0;
      this.#stage = "realms";
      return PROOF_ANSWER_LENGTH;
    }
    if (this.#stage !== "realms" || bytes.byteLength < 3) return 0;
    if (bytes[0] !== REALM_LIST) return this.#stop();
    const length = 3 + (bytes[1]! | (bytes[2]! << 8));
    if (bytes.byteLength < length) return 0;
    let addresses: string[];
    try {
      addresses = parseRealmList(bytes.subarray(0, length)).map((realm) => realm.address);
    } catch {
      return this.#stop();
    }
    this.#onRealms(addresses);
    return length;
  }

  #stop(): 0 {
    this.#stage = "done";
    return 0;
  }
}

/**
 * Host and port of a realm address, or `undefined` for one the gateway will not dial. The cores write
 * `address:port` (`ip::address::to_string()` and the port), so an IPv6 address arrives unbracketed and
 * the port is after the last colon; `[v6]:port` and host names are read too. No port is no address.
 */
export function parseRealmAddress(text: string): GatewayTarget | undefined {
  const colon = text.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const portText = text.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65_535) return undefined;
  let host = text.slice(0, colon);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "" || !/^[\x21-\x7e]+$/.test(host) || /[[\]/@]/.test(host)) return undefined;
  return { host, port };
}

/** The addresses the gateway's authserver announced, each until {@link REALM_ADDRESS_TTL_MS} after the last time. */
export class AnnouncedRealms {
  readonly #expires = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #limit: number;

  constructor({ ttlMs = REALM_ADDRESS_TTL_MS, limit = REALM_ADDRESS_LIMIT }: { ttlMs?: number; limit?: number } = {}) {
    this.#ttlMs = ttlMs;
    this.#limit = limit;
  }

  announce(addresses: readonly string[], now: number): void {
    for (const address of addresses) {
      if (parseRealmAddress(address) === undefined) continue;
      // Re-inserted, so the Map's order stays oldest-renewed first.
      this.#expires.delete(address);
      this.#expires.set(address, now + this.#ttlMs);
    }
    for (const address of this.#expires.keys()) {
      if (this.#expires.size <= this.#limit) break;
      this.#expires.delete(address);
    }
  }

  /** Where `/world?realm=address` connects, or `undefined` when the authserver never announced it. */
  target(address: string, now: number): GatewayTarget | undefined {
    const expires = this.#expires.get(address);
    if (expires === undefined) return undefined;
    if (expires <= now) {
      this.#expires.delete(address);
      return undefined;
    }
    return parseRealmAddress(address);
  }
}

/** Reads the realm lists of one `/auth` connection's authserver bytes into `realms`, until it leaves the order. */
export function watchRealmLists(backend: BackendDataSource, realms: AnnouncedRealms, now: () => number = Date.now): void {
  const watch = new RealmListWatch((addresses) => realms.announce(addresses, now()));
  const onData = (chunk: Buffer): void => {
    watch.feed(chunk);
    if (!watch.reading) backend.off("data", onData);
  };
  backend.on("data", onData);
}
