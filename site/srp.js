// The registration half of WoW 3.3.5 SRP6, computed in the player's browser (site/site.js) so the
// password never leaves it: the server receives the salt and verifier TrinityCore stores, exactly as
// AccountMgr::CreateAccount makes them (SRP6::MakeRegistrationData):
//   v = g ^ SHA1(salt ‖ SHA1(UPPER(user) ":" UPPER(pass))) mod N, little-endian, 32 bytes each.
// Plain JS without imports: the landing page is served as it is, without a build. It has no Web
// Crypto either (plain http to a public address is not a secure context), hence the SHA-1 below —
// the same algorithm as src/auth/Sha1.ts.

const N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const G = 7n;

/** TrinityCore's limits (AccountMgr.h MAX_ACCOUNT_STR, MAX_PASS_STR) narrowed to what every client types alike. */
export const USERNAME_PATTERN = /^[A-Za-z0-9]{3,16}$/;
export const PASSWORD_PATTERN = /^[\x21-\x7e]{6,16}$/;

/** Utf8ToUpperOnlyLatin: only a–z change. */
export function upperLatin(value) {
  return value.replace(/[a-z]/g, (character) => character.toUpperCase());
}

export function sha1(bytes) {
  const bitLength = bytes.byteLength * 8;
  const padded = new Uint8Array((((bytes.byteLength + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.byteLength - 4, bitLength >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.byteLength; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) {
      const value = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (value << 1) | (value >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const digest = new Uint8Array(20);
  const out = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4].forEach((word, i) => out.setUint32(i * 4, word));
  return digest;
}

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function fromLittleEndian(bytes) {
  let value = 0n;
  for (let i = bytes.byteLength - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function toLittleEndian(value, length) {
  const output = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    output[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return output;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let factor = base % modulus;
  for (let power = exponent; power > 0n; power >>= 1n) {
    if (power & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
  }
  return result;
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `{ username, salt, verifier }` (hex) for the register request; `salt` is random unless given. */
export function registrationData(usernameInput, passwordInput, salt = crypto.getRandomValues(new Uint8Array(32))) {
  if (!USERNAME_PATTERN.test(usernameInput)) throw new RangeError("username");
  if (!PASSWORD_PATTERN.test(passwordInput)) throw new RangeError("password");
  const username = upperLatin(usernameInput);
  const identity = sha1(new TextEncoder().encode(`${username}:${upperLatin(passwordInput)}`));
  const x = fromLittleEndian(sha1(concat(salt, identity)));
  return { username, salt: toHex(salt), verifier: toHex(toLittleEndian(modPow(G, x, N), 32)) };
}

/** The modulus, for the server's sanity check of a verifier it receives. */
export const SRP_N = N;
