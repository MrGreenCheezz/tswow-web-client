/**
 * 10.30 (15.11): what the login screen's account forms and the gateway's `/account/*` routes agree on.
 * Shared by both halves, so it imports nothing (no DOM, no node).
 *
 * The rules are the core's (TrinityCore AccountMgr.h, AccountMgr::CreateAccount/ChangePassword):
 * an account name and a password are at most 16 characters (MAX_ACCOUNT_STR, MAX_PASS_STR) and are
 * stored upper-cased with `Utf8ToUpperOnlyLatin`, which changes a–z only. The core has no minimum and
 * no character set; this client narrows the set and nothing else: a name of Latin letters and digits,
 * a password of printable ASCII. Outside ASCII, what Wow.exe's own upper-casing does to a typed
 * letter is not established here, and a stored name the original client could not type the same way
 * would be an account nobody can log into with it.
 */

/** AccountMgr.h MAX_ACCOUNT_STR (TrinityCore 3.3.5). */
export const ACCOUNT_NAME_MAX = 16;
/** AccountMgr.h MAX_PASS_STR. */
export const ACCOUNT_PASSWORD_MAX = 16;

const NAME_PATTERN = /^[A-Za-z0-9]+$/;
const PASSWORD_PATTERN = /^[\x20-\x7e]+$/;

/** `Utf8ToUpperOnlyLatin`: only a–z change. */
export function upperLatin(value: string): string {
  return value.replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

/** Why a typed account name cannot be used, or undefined when it can. */
export function accountNameProblem(name: string): "empty" | "too-long" | "characters" | undefined {
  if (name.length === 0) return "empty";
  if (name.length > ACCOUNT_NAME_MAX) return "too-long";
  return NAME_PATTERN.test(name) ? undefined : "characters";
}

/** Why a typed password cannot be used, or undefined when it can. */
export function passwordProblem(password: string): "empty" | "too-long" | "characters" | undefined {
  if (password.length === 0) return "empty";
  if (password.length > ACCOUNT_PASSWORD_MAX) return "too-long";
  return PASSWORD_PATTERN.test(password) ? undefined : "characters";
}

/** Bytes of a nonce the gateway hands out for one password change. */
export const PASSWORD_NONCE_BYTES = 16;

/** The label the change proof starts with; a new proof format gets a new label. */
const PROOF_LABEL = "WebClient account password v1";

/**
 * What the password-change proof is an HMAC-SHA1 of, keyed with the session key K of an SRP6 login.
 *
 * The authserver writes K into `account.session_key_auth` (TrinityCore, `LOGIN_UPD_LOGONPROOF`; AzerothCore's
 * column is `session_key`) before it sends the proof answer (AuthSession::HandleLogonProof, DirectExecute), so
 * by the time the browser has a successful login the gateway can read the same K and check the HMAC. Only
 * someone who just proved the password to the authserver holds K; the gateway never sees the password.
 * The message binds the name, the gateway's single-use nonce and the new salt and verifier, so a captured
 * request cannot be replayed or have its new password swapped.
 */
export function passwordChangeMessage(
  name: string, nonce: Uint8Array, salt: Uint8Array, verifier: Uint8Array,
): Uint8Array {
  const head = `${PROOF_LABEL}\0${upperLatin(name)}\0`;
  const output = new Uint8Array(head.length + nonce.byteLength + salt.byteLength + verifier.byteLength);
  for (let index = 0; index < head.length; index++) output[index] = head.charCodeAt(index) & 0xff;
  let offset = head.length;
  for (const part of [nonce, salt, verifier]) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function bytesToHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

/** Lower- or upper-case hex of exactly `length` bytes, or undefined. */
export function hexToBytes(text: unknown, length: number): Uint8Array | undefined {
  if (typeof text !== "string" || text.length !== length * 2 || !/^[0-9a-fA-F]*$/.test(text)) return undefined;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** The answers' error codes, the same words in the gateway and on the login screen. */
export type AccountRouteError =
  | "disabled" | "bad-request" | "bad-name" | "taken" | "too-many" | "busy" | "unavailable" | "not-proven"
  | "unsupported-schema"
  /** The database did not answer in time after the write was sent: it may have happened (review F7a). */
  | "uncertain";
