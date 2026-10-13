import { isIP } from "node:net";
import { AuthAnswerWatch } from "./AuthLoginVerdict.js";

/**
 * 10.01 — failed logins counted per player address, in the gateway.
 *
 * Every player reaches TrinityCore through this process, so the authserver sees each of them as the
 * gateway's own address: its `WrongPass.*` ban would ban everybody at once (BanType 0 bans the IP),
 * an IP ban or an account locked to an IP means nothing, and with `WrongPass.MaxCount = 0` password
 * guessing is unlimited. The gateway is the one place that still knows who is calling, so it keeps
 * the count: each `/auth` connection is one attempt (the core allows one password per connection,
 * AuthLoginVerdict.ts), its verdict is read from the authserver's own answer, and an address that
 * fails `maxFailures` times within `windowMs` gets no new `/auth` relay for `lockoutMs`.
 *
 * Attempts still waiting for their answer count against the same budget, so a burst of parallel
 * connections cannot get more guesses in than the limit before the first failure lands: an address
 * has at most `maxFailures` failed-or-unanswered attempts at any moment. A success clears the
 * address's failures. A lockout clears them too, so after it the address has its full budget again
 * rather than being locked anew by one more mistake.
 *
 * The address is the socket's (`socketPeerAddress` in Gateway.ts), never a header: `X-Forwarded-For`
 * is written by whoever is calling, and trusting it would let a guesser name a new address for every
 * try. Behind a reverse proxy every player is the proxy's address and shares one budget — the
 * gateway is meant to face players directly (bat\32, serving players). Loopback is limited like any
 * other address; the gateway opens no `/auth` connections of its own, so nothing internal can be
 * locked out. The table is bounded: entries that hold nothing are dropped as they empty or when the
 * table is full, and past `maxEntries` the least recently used address is forgotten.
 */

export interface LoginAttemptLimits {
  /** Failed logins within `windowMs` that lock an address out. */
  readonly maxFailures: number;
  /** How long a failed login keeps counting. */
  readonly windowMs: number;
  /** How long a locked-out address gets no new `/auth` relay. */
  readonly lockoutMs: number;
  /** Addresses remembered at once; past it the least recently used one is forgotten. */
  readonly maxEntries: number;
}

export const LOGIN_ATTEMPT_DEFAULTS: LoginAttemptLimits = Object.freeze({
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
  maxEntries: 10_000,
});

/**
 * The WebSocket close code of a refused `/auth` relay. The browser reads it, not the reason
 * (`describeFailure` in src/browser/glue/GlueMessages.ts maps 4290 to the client's LOGIN_TOO_FAST,
 * shown in Russian), and a close after the handshake is the only refusal it can read: a failed
 * handshake reaches a page only as "cannot connect".
 */
export const LOGIN_REFUSED_CLOSE = 4290;

/** The close reason: for the log and devtools; a WebSocket close reason is at most 123 bytes. */
export function loginRefusalReason(retryAfterMs: number): string {
  return `Too many login attempts; retry in ${String(Math.max(1, Math.ceil(retryAfterMs / 1000)))} s`;
}

/** What one admitted connection reports back: its verdict once, or nothing when it closed undecided. */
export interface LoginAttempt {
  /** Idempotent: the first call wins, so a close after the verdict changes nothing. */
  settle(verdict?: "failure" | "success"): void;
}

export type LoginAdmission = { readonly ok: true; readonly attempt: LoginAttempt }
  | { readonly ok: false; readonly retryAfterMs: number };

export interface LoginLockout {
  readonly key: string;
  readonly failures: number;
  readonly windowMs: number;
  readonly lockoutMs: number;
}

interface Entry {
  /** When each failure still inside the window happened, oldest first. */
  failures: number[];
  /** Admitted connections that have not settled yet. */
  pending: number;
  /** Refuse until this time; 0 when not locked. */
  lockedUntil: number;
}

/**
 * The key an address is counted under: an IPv4 address as itself (also when the socket wrote it
 * IPv4-mapped, `::ffff:203.0.113.7`), an IPv6 one by its /64 — one subscriber's whole network, which
 * one person can walk address by address — and loopback `::1` as itself.
 */
export function loginAttemptKey(address: string | undefined): string {
  if (!address) return "unknown";
  const bare = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(bare) !== 6 || bare === "::1") return bare || "unknown";
  const [head = "", tail] = bare.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const headGroups = groups(head);
  // A dotted IPv4 tail fills two groups; only the first four groups matter here anyway.
  const tailCount = groups(tail).reduce((count, group) => count + (group.includes(".") ? 2 : 1), 0);
  const prefix: string[] = [];
  for (let index = 0; index < 4; index++) {
    const group = index < headGroups.length ? headGroups[index]
      : tail !== undefined && index >= 8 - tailCount ? groups(tail)[index - (8 - tailCount)] : "0";
    prefix.push(Number.parseInt(group ?? "0", 16).toString(16));
  }
  return `${prefix.join(":")}::/64`;
}

function checkedLimits(override: Partial<LoginAttemptLimits>): LoginAttemptLimits {
  const limits = { ...LOGIN_ATTEMPT_DEFAULTS, ...override };
  if (!Number.isInteger(limits.maxFailures) || limits.maxFailures < 1) throw new RangeError("Login maxFailures must be a positive integer");
  if (!Number.isInteger(limits.maxEntries) || limits.maxEntries < 1) throw new RangeError("Login maxEntries must be a positive integer");
  if (!Number.isFinite(limits.windowMs) || limits.windowMs <= 0) throw new RangeError("Login windowMs must be a positive number");
  if (!Number.isFinite(limits.lockoutMs) || limits.lockoutMs <= 0) throw new RangeError("Login lockoutMs must be a positive number");
  return Object.freeze(limits);
}

export interface LoginAttemptLimiterOptions {
  readonly limits?: Partial<LoginAttemptLimits>;
  readonly now?: () => number;
  /** Once per lockout, when it begins. */
  readonly onLockout?: (lockout: LoginLockout) => void;
}

export class LoginAttemptLimiter {
  readonly limits: LoginAttemptLimits;
  readonly #now: () => number;
  readonly #onLockout: ((lockout: LoginLockout) => void) | undefined;
  /** In least-recently-used order: every touch re-inserts its key at the end. */
  readonly #entries = new Map<string, Entry>();

  constructor(options: LoginAttemptLimiterOptions = {}) {
    this.limits = checkedLimits(options.limits ?? {});
    this.#now = options.now ?? Date.now;
    this.#onLockout = options.onLockout;
  }

  /** Addresses remembered now (for tests and the bound). */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Whether `key` may open one more `/auth` relay. An admitted attempt holds one slot of the budget
   * until it is settled: with its verdict, or with nothing when its connection closes undecided.
   */
  admit(key: string): LoginAdmission {
    const now = this.#now();
    let entry = this.#entries.get(key);
    if (entry) this.#prune(entry, now);
    if (entry && entry.lockedUntil > now) return { ok: false, retryAfterMs: entry.lockedUntil - now };
    if (entry && entry.failures.length + entry.pending >= this.limits.maxFailures) {
      // Busy rather than locked: the budget is taken by failures still in the window and by attempts
      // whose answer has not come yet. The oldest failure leaving the window frees a slot; an answer
      // usually comes within a second.
      const oldest = entry.failures[0];
      return { ok: false, retryAfterMs: oldest === undefined ? 1000 : oldest + this.limits.windowMs - now };
    }
    if (!entry) {
      this.#makeRoom(now);
      entry = { failures: [], pending: 0, lockedUntil: 0 };
    }
    entry.pending++;
    this.#touch(key, entry);
    const admitted = entry;
    let settled = false;
    return {
      ok: true,
      attempt: {
        settle: (verdict) => {
          if (settled) return;
          settled = true;
          this.#settle(key, admitted, verdict);
        },
      },
    };
  }

  #settle(key: string, admitted: Entry, verdict: "failure" | "success" | undefined): void {
    const now = this.#now();
    const current = this.#entries.get(key);
    // An entry forgotten under table pressure took its pending count with it; the verdict still lands.
    if (current === admitted) admitted.pending = Math.max(0, admitted.pending - 1);
    let entry = current;
    if (verdict === "failure" && !entry) {
      this.#makeRoom(now);
      entry = { failures: [], pending: 0, lockedUntil: 0 };
    }
    if (!entry) return;
    this.#prune(entry, now);
    if (verdict === "success") entry.failures = [];
    if (verdict === "failure") {
      entry.failures.push(now);
      if (entry.failures.length >= this.limits.maxFailures) {
        const failures = entry.failures.length;
        entry.failures = [];
        entry.lockedUntil = now + this.limits.lockoutMs;
        this.#onLockout?.({ key, failures, windowMs: this.limits.windowMs, lockoutMs: this.limits.lockoutMs });
      }
    }
    if (this.#holdsNothing(entry, now)) this.#entries.delete(key);
    else this.#touch(key, entry);
  }

  #prune(entry: Entry, now: number): void {
    const since = now - this.limits.windowMs;
    let expired = 0;
    while (expired < entry.failures.length && (entry.failures[expired] ?? now) <= since) expired++;
    if (expired > 0) entry.failures.splice(0, expired);
    if (entry.lockedUntil <= now) entry.lockedUntil = 0;
  }

  #holdsNothing(entry: Entry, now: number): boolean {
    this.#prune(entry, now);
    return entry.failures.length === 0 && entry.pending === 0 && entry.lockedUntil === 0;
  }

  #touch(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  /** Before a new key goes in: drop what holds nothing, then the least recently used, below the cap. */
  #makeRoom(now: number): void {
    if (this.#entries.size < this.limits.maxEntries) return;
    for (const [key, entry] of this.#entries) {
      if (this.#holdsNothing(entry, now)) this.#entries.delete(key);
    }
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < this.limits.maxEntries) break;
      this.#entries.delete(key);
    }
  }
}

/** The part of a `net.Socket` the watch needs: the authserver's bytes as they arrive. */
export interface BackendDataSource {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

/** The part of a `ws` WebSocket the watch needs: that the browser side is gone. */
export interface ClientCloseSource {
  once(event: "close", listener: () => void): unknown;
}

/**
 * Settles `attempt` from what the authserver answers on this bridge: the first deciding answer, or
 * nothing once the browser's side closes. The listener comes off the backend socket with the verdict,
 * so a session that goes on to the realm list costs nothing more.
 */
export function watchLoginAttempt(backend: BackendDataSource, client: ClientCloseSource, attempt: LoginAttempt): void {
  const watch = new AuthAnswerWatch((verdict) => {
    attempt.settle(verdict === "other" ? undefined : verdict);
  });
  const onData = (chunk: Buffer): void => {
    watch.feed(chunk);
    if (watch.verdict !== undefined) backend.off("data", onData);
  };
  backend.on("data", onData);
  client.once("close", () => attempt.settle());
}

/**
 * The limits from the environment, or `false` when switched off (`GATEWAY_LOGIN_MAX_FAILURES=0`).
 * Minutes, as `GATEWAY_RESTART_DEADLINE_MIN` is; a value out of range refuses to start the gateway
 * rather than quietly running without the limit.
 */
export function parseLoginAttemptEnv(env: NodeJS.ProcessEnv): LoginAttemptLimits | false {
  const text = (name: string) => (env[name] ?? "").trim();
  const maxText = text("GATEWAY_LOGIN_MAX_FAILURES");
  let maxFailures = LOGIN_ATTEMPT_DEFAULTS.maxFailures;
  if (maxText !== "") {
    const value = Number(maxText);
    if (!Number.isInteger(value) || value < 0 || value > 1000) {
      throw new Error(`GATEWAY_LOGIN_MAX_FAILURES: expected a whole number from 0 to 1000, got "${maxText}"`);
    }
    if (value === 0) return false;
    maxFailures = value;
  }
  const minutes = (name: string, fallbackMs: number): number => {
    const value = text(name);
    if (value === "") return fallbackMs;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1440) {
      throw new Error(`${name}: expected minutes above 0 and at most 1440, got "${value}"`);
    }
    return Math.round(parsed * 60_000);
  };
  return checkedLimits({
    maxFailures,
    windowMs: minutes("GATEWAY_LOGIN_WINDOW_MIN", LOGIN_ATTEMPT_DEFAULTS.windowMs),
    lockoutMs: minutes("GATEWAY_LOGIN_LOCKOUT_MIN", LOGIN_ATTEMPT_DEFAULTS.lockoutMs),
  });
}
