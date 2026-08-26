import { concatBytes } from "../auth/Srp6.js";
import type { BinaryByteStream } from "../transport/WebSocketByteStream.js";
import { WorldCrypt } from "./WorldCrypt.js";

const MAX_WORLD_PAYLOAD = 16 * 1024 * 1024;

/**
 * What the worldserver will accept from a client, counting the four opcode bytes.
 *
 * `ClientPktHeader::IsValidSize` is `size >= 4 && size < 10240` (`WorldSocket.cpp:708-712`; `:230`
 * takes the opcode back out of `size` afterwards).
 */
export const WORLD_CLIENT_PACKET_LIMIT = 10_240;

/** The largest payload `send` may carry: the limit is exclusive and the four opcode bytes are inside it. */
export const MAX_CLIENT_WORLD_PAYLOAD = WORLD_CLIENT_PACKET_LIMIT - 1 - 4;

export interface WorldPacket {
  opcode: number;
  payload: Uint8Array;
}

export class WorldConnection {
  readonly #stream: BinaryByteStream;
  #crypt: WorldCrypt | undefined;

  constructor(stream: BinaryByteStream) {
    this.#stream = stream;
  }

  async enableEncryption(sessionKey: Uint8Array): Promise<void> {
    if (this.#crypt) throw new Error("World header encryption is already enabled");
    this.#crypt = await WorldCrypt.create(sessionKey);
  }

  send(opcode: number, payload: Uint8Array = new Uint8Array()): void {
    const size = payload.byteLength + 4;
    // Every outbound opcode, not only the custom ones. The guard used to be `size > 0xffff`, a
    // ceiling 6.4 times the server's own: all 55,296 sizes from 10,240 to 65,535 passed it and were
    // then answered with `CloseSocket()`, because a header failing `IsValidSize` is not refused but
    // hung up on. Better to throw here, where the caller can be told which packet was too big,
    // than to lose the session to a silent disconnect.
    if (size >= WORLD_CLIENT_PACKET_LIMIT) {
      throw new RangeError(
        `Client world packet 0x${opcode.toString(16)} is ${size} bytes with its opcode,`
        + ` at or over WORLD_CLIENT_PACKET_LIMIT (${WORLD_CLIENT_PACKET_LIMIT}): the worldserver closes the socket on it`,
      );
    }

    const header = new Uint8Array(6);
    header[0] = size >>> 8;
    header[1] = size & 0xff;
    new DataView(header.buffer).setUint32(2, opcode, true);
    this.#stream.send(concatBytes(this.#crypt ? this.#crypt.encryptClientHeader(header) : header, payload));
  }

  async read(): Promise<WorldPacket> {
    let first = await this.#stream.readExactly(1);
    if (this.#crypt) first = this.#crypt.decryptServerHeader(first);
    const large = ((first[0] ?? 0) & 0x80) !== 0;

    let rest = await this.#stream.readExactly(large ? 4 : 3);
    if (this.#crypt) rest = this.#crypt.decryptServerHeader(rest);
    const header = concatBytes(first, rest);
    const size = large
      ? (((header[0] ?? 0) & 0x7f) << 16) | ((header[1] ?? 0) << 8) | (header[2] ?? 0)
      : ((header[0] ?? 0) << 8) | (header[1] ?? 0);
    const opcodeOffset = large ? 3 : 2;
    const opcode = (header[opcodeOffset] ?? 0) | ((header[opcodeOffset + 1] ?? 0) << 8);
    const payloadLength = size - 2;
    if (payloadLength < 0 || payloadLength > MAX_WORLD_PAYLOAD) throw new RangeError(`Invalid world payload size ${payloadLength}`);

    return { opcode, payload: await this.#stream.readExactly(payloadLength) };
  }

  close(): void {
    this.#stream.close();
  }
}
