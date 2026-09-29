/**
 * SHA-1 in plain TypeScript, for pages that have no Web Crypto digest.
 *
 * `crypto.subtle` exists only in a secure context: HTTPS, or a loopback address. A page served to
 * players as `http://<public address>/` has none, and SRP6 login hashes with SHA-1 throughout, so
 * without this fallback such a page could never log in. The protocol itself is unchanged — it is
 * the same SRP6 the original client runs over plain TCP.
 */
export function sha1(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.byteLength * 8;
  // Message, 0x80, zero padding to 56 mod 64, then the 64-bit big-endian bit length.
  const padded = new Uint8Array((((bytes.byteLength + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.byteLength - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.byteLength; block += 64) {
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(block + index * 4);
    for (let index = 16; index < 80; index++) {
      const value = (w[index - 3] ?? 0) ^ (w[index - 8] ?? 0) ^ (w[index - 14] ?? 0) ^ (w[index - 16] ?? 0);
      w[index] = (value << 1) | (value >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index++) {
      const [f, k] = index < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : index < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : index < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[index] ?? 0)) >>> 0;
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
  [h0, h1, h2, h3, h4].forEach((word, index) => out.setUint32(index * 4, word));
  return digest;
}
