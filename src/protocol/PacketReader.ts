const decoder = new TextDecoder();

export class PacketReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  #take(length: number): number {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) {
      throw new RangeError(`Packet underflow at ${this.#offset}: need ${length}, have ${this.remaining}`);
    }
    const offset = this.#offset;
    this.#offset += length;
    return offset;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  // i8, i16, i64 and f64 exist for the tswow custom-packet codec: every numeric write over there is
  // `memcpy` of a C++ type (`CustomPacketBase.h:48-52`), so a module can put any of the twelve on
  // the wire, and only these four had no reader.
  i8(): number {
    return this.#view.getInt8(this.#take(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2), true);
  }

  i16(): number {
    return this.#view.getInt16(this.#take(2), true);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), true);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), true);
  }

  u64(): bigint {
    return this.#view.getBigUint64(this.#take(8), true);
  }

  i64(): bigint {
    return this.#view.getBigInt64(this.#take(8), true);
  }

  f32(): number {
    return this.#view.getFloat32(this.#take(4), true);
  }

  f64(): number {
    return this.#view.getFloat64(this.#take(8), true);
  }

  bytes(length: number): Uint8Array {
    const offset = this.#take(length);
    return this.#bytes.slice(offset, offset + length);
  }

  cString(): string {
    const end = this.#bytes.indexOf(0, this.#offset);
    if (end < 0) throw new RangeError(`Unterminated string at ${this.#offset}`);
    const value = decoder.decode(this.#bytes.subarray(this.#offset, end));
    this.#offset = end + 1;
    return value;
  }

  packedGuid(): bigint {
    const mask = this.u8();
    let guid = 0n;
    for (let index = 0; index < 8; index++) {
      if (mask & (1 << index)) guid |= BigInt(this.u8()) << BigInt(index * 8);
    }
    return guid;
  }

  assertFinished(): void {
    if (this.remaining !== 0) throw new RangeError(`${this.remaining} unread packet bytes`);
  }
}
