export class ByteQueue {
  readonly #chunks: Uint8Array[] = [];
  #headOffset = 0;
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#chunks.push(bytes);
    this.#length += bytes.byteLength;
  }

  /**
   * Copies the first `length` bytes into `target` without consuming them; false when fewer are held.
   * For the few bytes of a packet header, so a byte loop rather than `set` over subarrays.
   */
  peek(target: Uint8Array, length: number): boolean {
    if (!Number.isInteger(length) || length < 0 || length > this.#length || length > target.byteLength) return false;
    let chunkIndex = 0;
    let chunk = this.#chunks[0];
    let offset = this.#headOffset;
    for (let written = 0; written < length; written++) {
      while (chunk && offset >= chunk.byteLength) {
        chunk = this.#chunks[++chunkIndex];
        offset = 0;
      }
      if (!chunk) throw new Error("ByteQueue accounting error");
      target[written] = chunk[offset++]!;
    }
    return true;
  }

  read(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > this.#length) {
      throw new RangeError(`ByteQueue needs ${length} bytes but has ${this.#length}`);
    }

    const output = new Uint8Array(length);
    let outputOffset = 0;
    while (outputOffset < length) {
      const head = this.#chunks[0];
      if (!head) throw new Error("ByteQueue accounting error");

      const available = head.byteLength - this.#headOffset;
      const count = Math.min(available, length - outputOffset);
      output.set(head.subarray(this.#headOffset, this.#headOffset + count), outputOffset);
      outputOffset += count;
      this.#headOffset += count;

      if (this.#headOffset === head.byteLength) {
        this.#chunks.shift();
        this.#headOffset = 0;
      }
    }
    this.#length -= length;
    return output;
  }
}

