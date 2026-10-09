import { hmacSha1 } from "../auth/Sha1.js";

const SERVER_ENCRYPTION_KEY = Uint8Array.of(
  0xcc, 0x98, 0xae, 0x04, 0xe8, 0x97, 0xea, 0xca, 0x12, 0xdd, 0xc0, 0x93, 0x42, 0x91, 0x53, 0x57,
);
const SERVER_DECRYPTION_KEY = Uint8Array.of(
  0xc2, 0xb3, 0x72, 0x3c, 0xc6, 0xae, 0xd9, 0xb5, 0x34, 0x3c, 0x53, 0xee, 0x2f, 0x43, 0x67, 0xce,
);

class Rc4 {
  readonly #state = Uint8Array.from({ length: 256 }, (_, index) => index);
  #i = 0;
  #j = 0;

  constructor(key: Uint8Array) {
    if (key.byteLength === 0) throw new RangeError("RC4 key cannot be empty");
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + (this.#state[i] ?? 0) + (key[i % key.byteLength] ?? 0)) & 0xff;
      const value = this.#state[i] ?? 0;
      this.#state[i] = this.#state[j] ?? 0;
      this.#state[j] = value;
    }
    this.process(new Uint8Array(1024));
  }

  process(input: Uint8Array): Uint8Array {
    const output = new Uint8Array(input.byteLength);
    for (let offset = 0; offset < input.byteLength; offset++) {
      this.#i = (this.#i + 1) & 0xff;
      this.#j = (this.#j + (this.#state[this.#i] ?? 0)) & 0xff;
      const value = this.#state[this.#i] ?? 0;
      this.#state[this.#i] = this.#state[this.#j] ?? 0;
      this.#state[this.#j] = value;
      const keyByte = this.#state[((this.#state[this.#i] ?? 0) + (this.#state[this.#j] ?? 0)) & 0xff] ?? 0;
      output[offset] = (input[offset] ?? 0) ^ keyByte;
    }
    return output;
  }

  /**
   * What `process` would make of the first `length` bytes of `input`, into `output`, without moving
   * the cipher: the keystream runs on a copy of the state. For a header that may not be whole yet —
   * a stream cipher advanced over a partial packet could never be put back.
   */
  peek(input: Uint8Array, output: Uint8Array, length: number): void {
    const state = PEEK_STATE;
    state.set(this.#state);
    let i = this.#i;
    let j = this.#j;
    for (let offset = 0; offset < length; offset++) {
      i = (i + 1) & 0xff;
      j = (j + state[i]!) & 0xff;
      const value = state[i]!;
      state[i] = state[j]!;
      state[j] = value;
      output[offset] = input[offset]! ^ state[(state[i]! + state[j]!) & 0xff]!;
    }
  }
}

/** Scratch for `Rc4.peek`: synchronous, so one is enough. */
const PEEK_STATE = new Uint8Array(256);

export class WorldCrypt {
  readonly #incoming: Rc4;
  readonly #outgoing: Rc4;

  private constructor(incomingKey: Uint8Array, outgoingKey: Uint8Array) {
    this.#incoming = new Rc4(incomingKey);
    this.#outgoing = new Rc4(outgoingKey);
  }

  /**
   * Keys both directions from the session key, as TrinityCore's WorldSocket does.
   *
   * Plain {@link hmacSha1} and not `crypto.subtle`: a page on `http://<public address>/` has no
   * `subtle`, and this was the one step of the login that still needed it (1.02). Two HMACs of 40
   * bytes cost microseconds. Still async, as its callers expect.
   */
  static async create(sessionKey: Uint8Array): Promise<WorldCrypt> {
    if (sessionKey.byteLength !== 40) throw new RangeError("World session key must be 40 bytes");
    return new WorldCrypt(hmacSha1(SERVER_ENCRYPTION_KEY, sessionKey), hmacSha1(SERVER_DECRYPTION_KEY, sessionKey));
  }

  decryptServerHeader(header: Uint8Array): Uint8Array {
    return this.#incoming.process(header);
  }

  /** `decryptServerHeader` of the first `length` bytes of `raw` into `out`, leaving the cipher where it was. */
  peekServerHeader(raw: Uint8Array, length: number, out: Uint8Array): void {
    this.#incoming.peek(raw, out, length);
  }

  encryptClientHeader(header: Uint8Array): Uint8Array {
    return this.#outgoing.process(header);
  }
}

