/**
 * 10.30 (15.11): registration and password change from the login screen, written straight into the `auth`
 * database (the owner's decision of 15.11: the database, not SOAP). The HTTP side is AccountRoutes.ts; the
 * database is reached only through an injected {@link SqlRunner} (AccountSql.ts), which is all a test replaces.
 *
 * What is written is what the core itself writes:
 * - a new account: TrinityCore's `LOGIN_INS_ACCOUNT` and `LOGIN_INS_REALM_CHARACTERS_INIT` (LoginDatabase.cpp,
 *   run by AccountMgr::CreateAccount) — name, salt, verifier, empty `reg_mail`/`email`, `joindate` NOW(), then
 *   the `realmcharacters` rows of every account that has none — here in one transaction, so a client killed
 *   halfway leaves nothing. AzerothCore has the same two statements.
 * - a new password: `LOGIN_UPD_LOGON` (AccountMgr::ChangePassword) — salt and verifier by account id — and, in
 *   the same statement, a fresh session key (below).
 * The salt and verifier come from the browser (SrpRegistration.ts); the gateway never receives a password.
 *
 * A password change is accepted only for an account the caller proved it owns: the browser logs in to the
 * authserver with the old password first (a real SRP6 login through `/auth`), which leaves that login's
 * session key K and `last_login = NOW()` in the account row (`LOGIN_UPD_LOGONPROOF`, one statement), and then
 * sends an HMAC-SHA1 under K over the name, a single-use nonce from this gateway and the new salt and verifier
 * (AccountWire.ts `passwordChangeMessage`). The gateway accepts K only while that login is at most
 * {@link FRESH_LOGIN_SECONDS} old by the database's own clock, and the UPDATE that writes the new verifier
 * replaces K with 40 random bytes on condition that K is still the stored one: a key is good for one change,
 * two racing changes cannot both pass, and an old key read from a backup is worthless (review F3). Never NULL:
 * the authserver's reconnect reads the key as 40 bytes and asserts on NULL (`ReconnectChallengeCallback`).
 *
 * Limits, all in memory: per address (the socket's, IPv6 by /64 as the login limit groups them) and
 * overall, sliding windows, checked and reserved inside the one-at-a-time database queue (review F1); the
 * overall change budget counts only changes that proved ownership (review F2). The log gets the account name,
 * the outcome and the address group key — the same key the 10.01 login limiter already logs — never a salt,
 * a verifier, a key or the client's error text.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  accountNameProblem, bytesToHex, hexToBytes, PASSWORD_NONCE_BYTES, passwordChangeMessage, upperLatin,
  type AccountRouteError,
} from "../auth/AccountWire.js";
import { SRP_MODULUS, verifierValue } from "../auth/SrpRegistration.js";
import { MYSQL_DUPLICATE_ENTRY, type SqlOutcome, type SqlRunner, type SqlStatement } from "./AccountSql.js";

export interface AccountLimits {
  /** Requests of any account route per address within `requestWindowMs`. */
  readonly requestsPerAddress: number;
  readonly requestWindowMs: number;
  /** Accounts created per address, and by everyone, within `accountWindowMs`. */
  readonly accountsPerAddress: number;
  readonly accountsOverall: number;
  readonly accountWindowMs: number;
  /** Password changes tried per address, and changes made by everyone, within `changeWindowMs`. */
  readonly changesPerAddress: number;
  readonly changesOverall: number;
  readonly changeWindowMs: number;
  /** How long a change nonce lives, how many may be outstanding, and how many per address. */
  readonly nonceTtlMs: number;
  readonly maxNonces: number;
  readonly maxNoncesPerAddress: number;
  /** Addresses remembered by the counters before the oldest is forgotten. */
  readonly maxAddresses: number;
  /** Database operations in the queue (the running one included) before `busy`. */
  readonly maxQueued: number;
}

export const ACCOUNT_LIMIT_DEFAULTS: AccountLimits = Object.freeze({
  requestsPerAddress: 20,
  requestWindowMs: 10 * 60_000,
  accountsPerAddress: 3,
  accountsOverall: 30,
  accountWindowMs: 60 * 60_000,
  changesPerAddress: 5,
  changesOverall: 60,
  changeWindowMs: 60 * 60_000,
  nonceTtlMs: 2 * 60_000,
  maxNonces: 1000,
  maxNoncesPerAddress: 3,
  maxAddresses: 10_000,
  maxQueued: 16,
});

/** How old the authserver login behind a password change may be, by the database's clock (review F3). */
export const FRESH_LOGIN_SECONDS = 300;

export interface AccountAnswer {
  readonly status: number;
  readonly body: { readonly error: AccountRouteError } | Readonly<Record<string, string | boolean>>;
}

const refuse = (status: number, error: AccountRouteError): AccountAnswer => ({ status, body: { error } });

/**
 * Sliding-window counters by key, at most `maxKeys` per-address keys (the oldest is forgotten first). The overall
 * keys (`…:*`) live apart and are never evicted, so many addresses cannot reset the overall budgets (second look).
 */
class WindowCounters {
  readonly #hits = new Map<string, number[]>();
  readonly #overall = new Map<string, number[]>();
  readonly #maxKeys: number;
  readonly #now: () => number;

  constructor(maxKeys: number, now: () => number) {
    this.#maxKeys = maxKeys;
    this.#now = now;
  }

  #mapOf(key: string): Map<string, number[]> {
    return key.endsWith(":*") ? this.#overall : this.#hits;
  }

  count(key: string, windowMs: number): number {
    const map = this.#mapOf(key);
    const list = map.get(key);
    if (!list) return 0;
    const now = this.#now();
    const recent = list.filter((time) => now - time < windowMs);
    if (recent.length === 0) map.delete(key);
    else map.set(key, recent);
    return recent.length;
  }

  note(key: string): void {
    const map = this.#mapOf(key);
    const list = map.get(key) ?? [];
    map.delete(key);
    list.push(this.#now());
    map.set(key, list);
    while (this.#hits.size > this.#maxKeys) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
  }

  /** Gives back the latest `note` of `key` (a reservation that wrote nothing). */
  unnote(key: string): void {
    this.#mapOf(key).get(key)?.pop();
  }
}

// The statements, constants all; values only ever travel as parameters (AccountSql.ts).
const BEGIN = "START TRANSACTION";
const COMMIT = "COMMIT";
const INSERT_ACCOUNT = "INSERT INTO account (username, salt, verifier, reg_mail, email, joindate) VALUES (?, ?, ?, ?, ?, NOW())";
const INIT_REALM_CHARACTERS = "INSERT INTO realmcharacters (realmid, acctid, numchars) SELECT realmlist.id, account.id, 0"
  + " FROM realmlist, account LEFT JOIN realmcharacters ON acctid = account.id WHERE acctid IS NULL";
const ACCOUNT_COLUMNS = "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account'";
const FRESH_LOGIN = `last_login >= NOW() - INTERVAL ${FRESH_LOGIN_SECONDS} SECOND`;
/** TrinityCore keeps the authserver's key in `session_key_auth`; AzerothCore in `session_key`. */
const KEY_STATEMENTS = {
  session_key_auth: {
    read: `SELECT id, HEX(session_key_auth) FROM account WHERE username = ? AND ${FRESH_LOGIN}`,
    write: `UPDATE account SET salt = ?, verifier = ?, session_key_auth = ? WHERE id = ? AND session_key_auth = ? AND ${FRESH_LOGIN}`,
  },
  session_key: {
    read: `SELECT id, HEX(session_key) FROM account WHERE username = ? AND ${FRESH_LOGIN}`,
    write: `UPDATE account SET salt = ?, verifier = ?, session_key = ? WHERE id = ? AND session_key = ? AND ${FRESH_LOGIN}`,
  },
} as const;
const ROWS_CHANGED = "SELECT ROW_COUNT()";

type SessionKeyColumn = keyof typeof KEY_STATEMENTS;

const SALT_BYTES = 32;
const VERIFIER_BYTES = 32;
const SESSION_KEY_BYTES = 40;
const PROOF_BYTES = 20;

export interface AccountServiceOptions {
  readonly run: SqlRunner;
  readonly limits?: Partial<AccountLimits>;
  /** Names nobody may register (upper-cased on the way in); refused as a taken name is. */
  readonly reserved?: readonly string[];
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** One line per outcome: the account name, what happened, the address group key. */
  readonly log?: (line: string) => void;
}

function record(body: unknown): Record<string, unknown> | undefined {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

function nonZero(bytes: Uint8Array): boolean {
  return bytes.some((byte) => byte !== 0);
}

/** A verifier the authserver can use: 0 < v < N. */
function usableVerifier(bytes: Uint8Array): boolean {
  const value = verifierValue(bytes);
  return value > 0n && value < SRP_MODULUS;
}

/** The account name of a request, upper-cased as the core stores it, or undefined. */
function requestName(value: unknown): string | undefined {
  return typeof value === "string" && accountNameProblem(value) === undefined ? upperLatin(value) : undefined;
}

export class AccountSelfService {
  readonly #run: SqlRunner;
  readonly #limits: AccountLimits;
  readonly #reserved: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #random: (size: number) => Uint8Array;
  readonly #log: (line: string) => void;
  readonly #counters: WindowCounters;
  readonly #nonces = new Map<string, { readonly name: string; readonly address: string; readonly expires: number }>();
  #queue: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #sessionKeyColumn: SessionKeyColumn | undefined;

  constructor(options: AccountServiceOptions) {
    this.#run = options.run;
    this.#limits = { ...ACCOUNT_LIMIT_DEFAULTS, ...options.limits };
    this.#reserved = new Set((options.reserved ?? []).map((name) => upperLatin(name.trim())).filter(Boolean));
    this.#now = options.now ?? Date.now;
    this.#random = options.randomBytes ?? ((size) => randomBytes(size));
    this.#log = options.log ?? ((line) => console.log(line));
    this.#counters = new WindowCounters(this.#limits.maxAddresses, this.#now);
  }

  /** `POST /account/register` `{ username, salt, verifier }` (hex). */
  async register(address: string, body: unknown): Promise<AccountAnswer> {
    if (!this.#admitRequest(address)) return refuse(429, "too-many");
    const fields = record(body);
    const name = requestName(fields?.["username"]);
    if (name === undefined) return refuse(400, "bad-name");
    const salt = hexToBytes(fields?.["salt"], SALT_BYTES);
    const verifier = hexToBytes(fields?.["verifier"], VERIFIER_BYTES);
    if (!salt || !nonZero(salt) || !verifier || !usableVerifier(verifier)) return refuse(400, "bad-request");
    if (this.#reserved.has(name)) {
      this.#log(`Account ${name}: registration refused (reserved) from ${address}`);
      return refuse(409, "taken");
    }
    if (this.#accountBudgetSpent(address)) return refuse(429, "too-many");
    return await this.#serialised(async () => {
      // Checked and reserved here, one request at a time: parallel requests cannot all pass a count of 0 (review F1).
      if (this.#accountBudgetSpent(address)) return refuse(429, "too-many");
      this.#counters.note(`account:${address}`);
      this.#counters.note("account:*");
      const giveBack = (): void => {
        this.#counters.unnote(`account:${address}`);
        this.#counters.unnote("account:*");
      };
      const schema = await this.#schema();
      if (schema !== "ok") {
        giveBack();
        return this.#schemaRefusal(name, "registration", schema, address);
      }
      const outcome = await this.#execute([
        { text: BEGIN, params: [] },
        { text: INSERT_ACCOUNT, params: [name, salt, verifier, "", ""] },
        { text: INIT_REALM_CHARACTERS, params: [] },
        { text: COMMIT, params: [], commitPoint: true },
      ]);
      if (!outcome.ok && outcome.uncertain) return this.#uncertain(name, "registration", address); // reservation kept
      if (!outcome.ok && outcome.errno === MYSQL_DUPLICATE_ENTRY) {
        giveBack();
        this.#log(`Account ${name}: registration refused (taken) from ${address}`);
        return refuse(409, "taken");
      }
      if (!outcome.ok) {
        giveBack();
        return this.#failed(name, "registration", outcome.errno, address);
      }
      this.#log(`Account ${name}: registered from ${address}`);
      return { status: 201, body: { ok: true, username: name } };
    });
  }

  /** `POST /account/password/nonce` `{ username }`: a single-use nonce for one change. Never reads the database. */
  passwordNonce(address: string, body: unknown): AccountAnswer {
    if (!this.#admitRequest(address)) return refuse(429, "too-many");
    const name = requestName(record(body)?.["username"]);
    if (name === undefined) return refuse(400, "bad-name");
    const now = this.#now();
    let mine = 0;
    for (const [nonce, entry] of this.#nonces) {
      if (entry.expires <= now) this.#nonces.delete(nonce);
      else if (entry.address === address) mine++;
    }
    // A few outstanding per address, so one address cannot hold the whole store (review F7j).
    if (mine >= this.#limits.maxNoncesPerAddress) return refuse(429, "too-many");
    if (this.#nonces.size >= this.#limits.maxNonces) return refuse(503, "busy");
    const nonce = bytesToHex(this.#random(PASSWORD_NONCE_BYTES));
    this.#nonces.set(nonce, { name, address, expires: now + this.#limits.nonceTtlMs });
    return { status: 200, body: { nonce } };
  }

  /** `POST /account/password` `{ username, nonce, salt, verifier, proof }` (hex). */
  async changePassword(address: string, body: unknown): Promise<AccountAnswer> {
    if (!this.#admitRequest(address)) return refuse(429, "too-many");
    const fields = record(body);
    const name = requestName(fields?.["username"]);
    if (name === undefined) return refuse(400, "bad-name");
    const nonce = hexToBytes(fields?.["nonce"], PASSWORD_NONCE_BYTES);
    const salt = hexToBytes(fields?.["salt"], SALT_BYTES);
    const verifier = hexToBytes(fields?.["verifier"], VERIFIER_BYTES);
    const proof = hexToBytes(fields?.["proof"], PROOF_BYTES);
    if (!nonce || !salt || !nonZero(salt) || !verifier || !usableVerifier(verifier) || !proof) return refuse(400, "bad-request");
    const limits = this.#limits;
    if (this.#counters.count(`change:${address}`, limits.changeWindowMs) >= limits.changesPerAddress
      || this.#counters.count("change:*", limits.changeWindowMs) >= limits.changesOverall) {
      return refuse(429, "too-many");
    }
    // Single use whatever happens next: a nonce is spent by the first request that names it.
    const nonceHex = bytesToHex(nonce);
    const issued = this.#nonces.get(nonceHex);
    this.#nonces.delete(nonceHex);
    if (!issued || issued.name !== name || issued.expires <= this.#now()) {
      this.#log(`Account ${name}: password change refused (no valid nonce) from ${address}`);
      return refuse(403, "not-proven");
    }
    // Every attempt counts for its address; only a proven change counts for everyone (review F2).
    this.#counters.note(`change:${address}`);
    return await this.#serialised(async () => {
      const schema = await this.#schema();
      if (schema !== "ok") return this.#schemaRefusal(name, "password change", schema, address);
      const statements = KEY_STATEMENTS[this.#sessionKeyColumn!];
      const read = await this.#execute([{ text: statements.read, params: [name] }]);
      if (!read.ok) return this.#failed(name, "password change", read.errno, address);
      const row = read.rows[0];
      const id = row ? Number(row[0]) : Number.NaN;
      const key = hexToBytes(row?.[1], SESSION_KEY_BYTES);
      const expected = key ? createHmac("sha1", key).update(passwordChangeMessage(name, nonce, salt, verifier)).digest() : undefined;
      // The same answer for no such account, no login, a login too old and a wrong proof.
      if (!Number.isSafeInteger(id) || id <= 0 || !key || !expected || !timingSafeEqual(expected, proof)) {
        this.#log(`Account ${name}: password change refused (not proven) from ${address}`);
        return refuse(403, "not-proven");
      }
      const fresh = this.#random(SESSION_KEY_BYTES);
      const update = await this.#execute([
        { text: statements.write, params: [salt, verifier, fresh, id, key], commitPoint: true },
        { text: ROWS_CHANGED, params: [] },
      ]);
      if (!update.ok && update.uncertain) return this.#uncertain(name, "password change", address);
      if (!update.ok) return this.#failed(name, "password change", update.errno, address);
      if (update.rows[0]?.[0] !== "1") {
        // Another change used this key first, or the login went stale between the read and the write.
        this.#log(`Account ${name}: password change refused (key no longer current) from ${address}`);
        return refuse(403, "not-proven");
      }
      this.#counters.note("change:*");
      this.#log(`Account ${name}: password changed from ${address}`);
      return { status: 200, body: { ok: true } };
    });
  }

  #accountBudgetSpent(address: string): boolean {
    const limits = this.#limits;
    return this.#counters.count(`account:${address}`, limits.accountWindowMs) >= limits.accountsPerAddress
      || this.#counters.count("account:*", limits.accountWindowMs) >= limits.accountsOverall;
  }

  #admitRequest(address: string): boolean {
    const key = `request:${address}`;
    if (this.#counters.count(key, this.#limits.requestWindowMs) >= this.#limits.requestsPerAddress) return false;
    this.#counters.note(key);
    return true;
  }

  async #serialised(work: () => Promise<AccountAnswer>): Promise<AccountAnswer> {
    if (this.#queued >= this.#limits.maxQueued) return refuse(503, "busy");
    this.#queued++;
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => undefined);
    try {
      return await next;
    } finally {
      this.#queued--;
    }
  }

  async #execute(statements: readonly SqlStatement[]): Promise<SqlOutcome> {
    try {
      return await this.#run(statements);
    } catch {
      return { ok: false, errno: undefined };
    }
  }

  /** The columns both cores share, read once; the key column decides TrinityCore or AzerothCore. */
  async #schema(): Promise<"ok" | "unreachable" | "unsupported"> {
    if (this.#sessionKeyColumn !== undefined) return "ok";
    const outcome = await this.#execute([{ text: ACCOUNT_COLUMNS, params: [] }]);
    if (!outcome.ok) return "unreachable";
    const columns = new Set(outcome.rows.map((row) => (row[0] ?? "").toLowerCase()));
    if (!["id", "username", "salt", "verifier", "reg_mail", "email", "joindate", "last_login"].every((column) => columns.has(column))) {
      return "unsupported";
    }
    this.#sessionKeyColumn = columns.has("session_key_auth") ? "session_key_auth"
      : columns.has("session_key") ? "session_key" : undefined;
    return this.#sessionKeyColumn === undefined ? "unsupported" : "ok";
  }

  #schemaRefusal(name: string, what: string, schema: "unreachable" | "unsupported", address: string): AccountAnswer {
    this.#log(`Account ${name}: ${what} failed (${schema === "unsupported" ? "auth database has an unknown account table" : "auth database unreachable"}) from ${address}`);
    return refuse(503, schema === "unsupported" ? "unsupported-schema" : "unavailable");
  }

  #failed(name: string, what: string, errno: number | undefined, address: string): AccountAnswer {
    this.#log(`Account ${name}: ${what} failed (database error ${errno === undefined ? "unknown" : String(errno)}) from ${address}`);
    return refuse(503, "unavailable");
  }

  /** The run ended (timeout, lost connection) at or after its commit point: the write may have happened (review F7a). */
  #uncertain(name: string, what: string, address: string): AccountAnswer {
    this.#log(`Account ${name}: ${what} outcome unknown (ended at the commit point) from ${address}`);
    return refuse(504, "uncertain");
  }
}
