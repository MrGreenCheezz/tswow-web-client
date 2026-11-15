import { upperLatin } from "./AccountWire.js";
import { concatBytes, sha1Bytes } from "./Srp6.js";

/**
 * 10.30 (15.11): the registration half of WoW 3.3.5's SRP6, in the browser, so the password never leaves
 * it: exactly what TrinityCore's AccountMgr::CreateAccount and ChangePassword store
 * (SRP6::MakeRegistrationData, SRP6.cpp):
 *   x = SHA1(salt ‖ SHA1(UPPER(name) ":" UPPER(password))), v = g^x mod N,
 * salt 32 random bytes, v 32 bytes little-endian — the same bytes the authserver later reads back as
 * `account.salt` and `account.verifier` for the login challenge. AzerothCore stores the same pair the same way.
 */

const WOW_N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const WOW_G = 7n;
const encoder = new TextEncoder();

export const SRP_SALT_BYTES = 32;
export const SRP_VERIFIER_BYTES = 32;

function fromLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.byteLength - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index] ?? 0);
  return value;
}

function toLittleEndian(value: bigint, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let rest = value;
  for (let index = 0; index < length; index++) {
    output[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return output;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = base % modulus;
  for (let power = exponent; power > 0n; power >>= 1n) {
    if (power & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
  }
  return result;
}

export interface SrpRegistrationData {
  /** The name as the core stores it: a–z upper-cased. */
  readonly username: string;
  readonly salt: Uint8Array;
  readonly verifier: Uint8Array;
}

/** Salt and verifier for `name` and `password`; the salt is random unless given (tests). */
export async function makeRegistrationData(
  name: string, password: string,
  salt: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(SRP_SALT_BYTES)),
): Promise<SrpRegistrationData> {
  if (salt.byteLength !== SRP_SALT_BYTES) throw new RangeError("SRP6 salt must be 32 bytes");
  const username = upperLatin(name);
  const identity = await sha1Bytes(encoder.encode(`${username}:${upperLatin(password)}`));
  const x = fromLittleEndian(await sha1Bytes(concatBytes(salt, identity)));
  return { username, salt: Uint8Array.from(salt), verifier: toLittleEndian(modPow(WOW_G, x, WOW_N), SRP_VERIFIER_BYTES) };
}

/** The modulus, for the gateway's range check of a verifier it receives. */
export const SRP_MODULUS = WOW_N;

/** A verifier as the number it encodes (little-endian). */
export function verifierValue(verifier: Uint8Array): bigint {
  return fromLittleEndian(verifier);
}
