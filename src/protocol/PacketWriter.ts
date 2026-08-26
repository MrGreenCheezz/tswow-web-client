const encoder = new TextEncoder();
const MAX_GUID = 0xffff_ffff_ffff_ffffn;
const MIN_I64 = -0x8000_0000_0000_0000n;
const MAX_I64 = 0x7fff_ffff_ffff_ffffn;

export class PacketWriter {
  // ponytail: number[] is simplest for small packets; replace with a growable Uint8Array only if profiling requires it.
  readonly #bytes: number[] = [];

  get length(): number {
    return this.#bytes.length;
  }

  #fixed(length: number, write: (view: DataView) => void): this {
    const bytes = new Uint8Array(length);
    write(new DataView(bytes.buffer));
    for (const byte of bytes) this.#bytes.push(byte);
    return this;
  }

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  // i8, i16, i64 and f64 exist for the tswow custom-packet codec: every numeric write over there is
  // `memcpy` of a C++ type (`CustomPacketBase.h:48-52`), so a module can put any of the twelve on
  // the wire, and only these four had no writer.
  i8(value: number): this {
    return this.#fixed(1, (view) => view.setInt8(0, value));
  }

  u16(value: number): this {
    return this.#fixed(2, (view) => view.setUint16(0, value, true));
  }

  i16(value: number): this {
    return this.#fixed(2, (view) => view.setInt16(0, value, true));
  }

  u32(value: number): this {
    return this.#fixed(4, (view) => view.setUint32(0, value, true));
  }

  i32(value: number): this {
    return this.#fixed(4, (view) => view.setInt32(0, value, true));
  }

  u64(value: bigint): this {
    if (value < 0n || value > MAX_GUID) throw new RangeError("u64 is outside the unsigned 64-bit range");
    return this.#fixed(8, (view) => view.setBigUint64(0, value, true));
  }

  i64(value: bigint): this {
    if (value < MIN_I64 || value > MAX_I64) throw new RangeError("i64 is outside the signed 64-bit range");
    return this.#fixed(8, (view) => view.setBigInt64(0, value, true));
  }

  f32(value: number): this {
    return this.#fixed(4, (view) => view.setFloat32(0, value, true));
  }

  f64(value: number): this {
    return this.#fixed(8, (view) => view.setFloat64(0, value, true));
  }

  bytes(value: Uint8Array): this {
    // One at a time rather than a spread: a spread passes every byte as a call argument, which
    // throws RangeError once the payload is large enough (measured limit here is ~100k).
    for (const byte of value) this.#bytes.push(byte);
    return this;
  }

  cString(value: string): this {
    if (value.includes("\0")) throw new TypeError("CString cannot contain a null byte");
    return this.bytes(encoder.encode(value)).u8(0);
  }

  packedGuid(value: bigint): this {
    if (value < 0n || value > MAX_GUID) throw new RangeError("GUID is outside the unsigned 64-bit range");

    let mask = 0;
    const packed = [];
    for (let index = 0; index < 8; index++) {
      const byte = Number((value >> BigInt(index * 8)) & 0xffn);
      if (byte !== 0) {
        mask |= 1 << index;
        packed.push(byte);
      }
    }
    this.u8(mask);
    for (const byte of packed) this.#bytes.push(byte);
    return this;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}
