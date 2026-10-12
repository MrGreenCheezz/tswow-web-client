/**
 * 10.01 — what an authserver's answers on one connection said about the password.
 *
 * The gateway does not speak the auth protocol: it relays bytes. To count failed logins per player it
 * reads the authserver -> browser half of one `/auth` connection, only up to the first answer that
 * decides the attempt, and never the browser -> authserver half (so it never sees the account name,
 * and the password never crosses the gateway at all — SRP6 runs in the browser).
 *
 * Why one verdict per connection is the whole story (TrinityCore `authserver/Server/AuthSession.cpp`):
 * `HandleLogonChallenge`, `HandleLogonProof` and `HandleReconnectChallenge` each set `_status =
 * STATUS_CLOSED` first and only a success moves it on, and `ReadHandler` closes the socket on any
 * command that does not match the status. So a connection carries at most one challenge and one
 * proof, and a second password needs a second connection — which is what the limiter refuses.
 *
 * The answers read (wire layout of 3.3.5a, as `LogonChallengeCallback` and friends write it):
 * - `AUTH_LOGON_CHALLENGE` (0x00): cmd, 0, result. A non-zero result ends the connection's login;
 *   `WOW_FAIL_UNKNOWN_ACCOUNT` there is a guessed account name and counts. Zero is followed by
 *   B[32], g_len, g, N_len, N, salt[32], version challenge[16], security flags and the flags' extras,
 *   and then — once the browser has sent its proof — by:
 * - `AUTH_LOGON_PROOF` (0x01): cmd, error. Zero is the one success; `WOW_FAIL_UNKNOWN_ACCOUNT` is a
 *   wrong password or authenticator code (the core answers both with 4, `HandleLogonProof`).
 * - `AUTH_RECONNECT_CHALLENGE` (0x02): cmd, result. An unknown account there counts, or the reconnect
 *   path would enumerate account names for free; anything else is neither (a reconnect proof needs
 *   the 40-byte session key, and the core closes the socket on a wrong one without answering).
 * `WOW_FAIL_INCORRECT_PASSWORD` (5) is not sent by this core but is the protocol's own word for it, so
 * it counts too. Bans, suspensions, version and database refusals are not password failures.
 */

/** A failed or a successful password check; `other` decides nothing (a ban, a refusal, the unknown). */
export type AuthLoginVerdict = "failure" | "success" | "other";

const AUTH_LOGON_CHALLENGE = 0x00;
const AUTH_LOGON_PROOF = 0x01;
const AUTH_RECONNECT_CHALLENGE = 0x02;
const WOW_SUCCESS = 0x00;
const WOW_FAIL_UNKNOWN_ACCOUNT = 0x04;
const WOW_FAIL_INCORRECT_PASSWORD = 0x05;
const SECURITY_PIN = 0x01;
const SECURITY_MATRIX = 0x02;
const SECURITY_TOKEN = 0x04;

/**
 * The longest prefix a verdict can need: a successful challenge answer with g and N at their largest
 * (255 bytes each) and every security extra (20 + 12 + 1), plus the proof answer's two bytes. Holding
 * no more than this is what keeps a connection's watch bounded whatever the authserver sends.
 */
export const AUTH_VERDICT_PREFIX_LIMIT = 3 + 32 + 1 + 255 + 1 + 255 + 32 + 16 + 1 + 33 + 2;

function wrongAccountOrPassword(result: number): boolean {
  return result === WOW_FAIL_UNKNOWN_ACCOUNT || result === WOW_FAIL_INCORRECT_PASSWORD;
}

/** Length of a successful `AUTH_LOGON_CHALLENGE` answer, or `undefined` until enough of it is here. */
function challengeAnswerLength(bytes: Uint8Array): number | undefined {
  const gLengthAt = 3 + 32;
  const gLength = bytes[gLengthAt];
  if (gLength === undefined) return undefined;
  const nLengthAt = gLengthAt + 1 + gLength;
  const nLength = bytes[nLengthAt];
  if (nLength === undefined) return undefined;
  const flagsAt = nLengthAt + 1 + nLength + 32 + 16;
  const flags = bytes[flagsAt];
  if (flags === undefined) return undefined;
  // The same extras the browser skips (`challengeSecurityExtraLength`, src/auth/AuthProtocol.ts).
  const extra = (flags & SECURITY_PIN ? 20 : 0) + (flags & SECURITY_MATRIX ? 12 : 0) + (flags & SECURITY_TOKEN ? 1 : 0);
  return flagsAt + 1 + extra;
}

/**
 * The verdict of the first bytes the authserver sent on a connection, or `undefined` while more are
 * needed. Pure, and decided within {@link AUTH_VERDICT_PREFIX_LIMIT} bytes for any input.
 */
export function authLoginVerdict(bytes: Uint8Array): AuthLoginVerdict | undefined {
  const command = bytes[0];
  if (command === undefined) return undefined;
  if (command === AUTH_RECONNECT_CHALLENGE) {
    const result = bytes[1];
    if (result === undefined) return undefined;
    return wrongAccountOrPassword(result) ? "failure" : "other";
  }
  if (command !== AUTH_LOGON_CHALLENGE) return "other";
  const challengeResult = bytes[2];
  if (challengeResult === undefined) return undefined;
  if (challengeResult !== WOW_SUCCESS) return wrongAccountOrPassword(challengeResult) ? "failure" : "other";
  const proofAt = challengeAnswerLength(bytes);
  if (proofAt === undefined) return undefined;
  const proofCommand = bytes[proofAt];
  if (proofCommand === undefined) return undefined;
  if (proofCommand !== AUTH_LOGON_PROOF) return "other";
  const proofResult = bytes[proofAt + 1];
  if (proofResult === undefined) return undefined;
  if (proofResult === WOW_SUCCESS) return "success";
  return wrongAccountOrPassword(proofResult) ? "failure" : "other";
}

/**
 * Feeds one connection's authserver bytes, chunk by chunk as TCP delivers them, and reports the
 * verdict once. Holds at most {@link AUTH_VERDICT_PREFIX_LIMIT} bytes; after the verdict it holds none.
 */
export class AuthAnswerWatch {
  #held = new Uint8Array(0);
  #verdict: AuthLoginVerdict | undefined;
  readonly #onVerdict: (verdict: AuthLoginVerdict) => void;

  constructor(onVerdict: (verdict: AuthLoginVerdict) => void) {
    this.#onVerdict = onVerdict;
  }

  get verdict(): AuthLoginVerdict | undefined {
    return this.#verdict;
  }

  feed(chunk: Uint8Array): void {
    if (this.#verdict !== undefined || chunk.byteLength === 0) return;
    const room = AUTH_VERDICT_PREFIX_LIMIT - this.#held.byteLength;
    const taken = chunk.subarray(0, room);
    const held = new Uint8Array(this.#held.byteLength + taken.byteLength);
    held.set(this.#held);
    held.set(taken, this.#held.byteLength);
    this.#held = held;
    // Undecided at the limit cannot happen for the layouts above; it is "other" rather than a buffer
    // that grows with whatever an unexpected backend keeps sending.
    const verdict = authLoginVerdict(held) ?? (held.byteLength >= AUTH_VERDICT_PREFIX_LIMIT ? "other" : undefined);
    if (verdict === undefined) return;
    this.#verdict = verdict;
    this.#held = new Uint8Array(0);
    this.#onVerdict(verdict);
  }
}
