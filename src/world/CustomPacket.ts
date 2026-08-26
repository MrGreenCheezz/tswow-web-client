import { MAX_CLIENT_WORLD_PAYLOAD } from "./WorldConnection.js";

/**
 * The tswow custom-packet transport.
 *
 * tswow gives a module two world opcodes and nothing else. Server to client rides `CMSG_EMOTE`'s
 * number, 0x102 — the comment in `CustomPacketDefines.h:27-31` says why: "I couldn't get the client
 * to accept higher message ids" — and client to server rides `CMSG_CUSTOM`, 0x51F, which
 * `Opcodes.cpp:1442` dispatches at `STATUS_LOGGEDIN`. Inside the world packet there is a packed
 * six-byte header and then a flat little-endian byte stream. Nothing else: no length, no checksum,
 * no type tag, and — despite what the modding notes claimed — no `u32` opcode prefix. That `u32`
 * is the world header's own `cmd` field (`ClientPktHeader{u16 size; u32 cmd}`), which
 * `WorldConnection.send` already writes; expecting a second copy inside the body would shift every
 * field by four bytes in both directions.
 *
 * This file mirrors TSWoW's `CustomPacketBuffer` (`source/misc/client-extensions/
 * CustomPackets/CustomPacketBuffer.cpp`) closely enough that a module author debugging against
 * tswow's own client sees the same eight refusals in the same order — and deliberately does not
 * mirror two of its habits, both marked below: the six-byte size skew, and reading past the end of
 * a message into the heap.
 */

/** `sizeof(CustomPacketHeader)`, `#pragma pack(1)`: three `uint16` (`CustomPacketChunk.h:9-15`). */
export const CUSTOM_HEADER_SIZE = 6;

/** `MAX_FRAGMENT_SIZE` (`CustomPacketDefines.h:19`): the whole fragment, header included. */
export const CUSTOM_MAX_FRAGMENT_SIZE = 30_000;

/**
 * `MIN_FRAGMENT_SIZE` (`CustomPacketDefines.h:20`). Every fragment of a multi-fragment message
 * except the last must be at least this big, or the server kicks the player
 * (`TSCustomPacket.cpp:119-122`). It is larger than anything the socket will carry from a client,
 * which is why {@link buildCustomPacket} never fragments.
 */
export const CUSTOM_MIN_FRAGMENT_SIZE = 25_000;

/** `BUFFER_QUOTA` (`CustomPacketDefines.h:23`): all of one connection's half-assembled messages. */
export const CUSTOM_BUFFER_QUOTA = 8_000_000;

/**
 * The largest custom body this client may send, 10,229 bytes.
 *
 * `ClientPktHeader::IsValidSize` is `size >= 4 && size < 10240` with the four opcode bytes counted
 * in (`WorldSocket.cpp:708-712`, `:230`), and a header that fails it is answered with
 * `CloseSocket()` (`:174-178`) rather than a refusal — so overshooting costs the session. Take the
 * six-byte custom header off what the socket will carry and 10,229 is what is left for the body.
 *
 * There is no way around it by fragmenting: a non-final fragment under {@link
 * CUSTOM_MIN_FRAGMENT_SIZE} is `TOO_SMALL_FRAGMENT`, which kicks the player, and 25,000 is more
 * than the socket accepts. A client-to-server message either fits in one fragment or cannot be
 * sent to this core at all.
 */
export const CUSTOM_MAX_SEND_BODY = MAX_CLIENT_WORLD_PAYLOAD - CUSTOM_HEADER_SIZE;

/**
 * The smallest custom body this client may send: one byte.
 *
 * `ReceivePacket`'s very first line is `if (size <= CustomHeaderSize) return _onError(NO_HEADER,
 * data)` (`CustomPacketBuffer.cpp:24-27`), and `size` there is `packet.size()`, the payload after
 * `WorldSocket` has taken the four opcode bytes back off (`WorldSession.cpp:1791-1794`,
 * `WorldSocket.cpp:230`). So a header and nothing after it is not an empty message but a kick —
 * `TSServerBuffer::OnError` with error 1. tswow's own writer cannot produce that frame (an empty
 * `CreateCustomPacket` leaves `m_chunks` empty and `buildMessages` returns nothing,
 * `CustomPacketBase.cpp:54-65`), which is why the hole only ever existed on this side.
 */
export const CUSTOM_MIN_SEND_BODY = 1;

/**
 * How long a half-delivered message may wait for its tail, in milliseconds.
 *
 * The server writes every fragment of one message in a single loop —
 * `TSPacketWrite::SendToPlayer` (`TSCustomPacket.cpp:20-31`) builds and sends them back to back in
 * one tick — so nothing but the socket can space them out. 30 seconds is the client's own
 * keep-alive period (`WorldClient.#startPing` sends `CMSG_PING` every 30,000 ms), i.e. the longest
 * silence this session already treats as "still connected"; a tail that has not arrived by then is
 * lost rather than late. Shorter would throw away real fragments on a slow link, and there is no
 * pressure to be aggressive: the {@link CUSTOM_BUFFER_QUOTA} already bounds what an abandoned tail
 * can hold.
 */
export const CUSTOM_TAIL_TIMEOUT_MS = 30_000;

/** Warnings kept for the diagnostics window; the oldest is dropped past this. */
const WARNING_LIMIT = 32;

export interface CustomPacketHeader {
  fragmentId: number;
  totalFrags: number;
  opcode: number;
}

export interface CustomPacketFragment {
  readonly header: CustomPacketHeader;
  /** The bytes after the header. Not a copy of the packet: a view into it. */
  readonly body: Uint8Array;
}

/** The eight refusals of `CustomPacketResult` that destroy the buffer (`CustomPacketBuffer.h:6-29`). */
export type CustomPacketError =
  | "NO_HEADER"
  | "HEADER_MISMATCH"
  | "INVALID_FRAG_COUNT"
  | "INVALID_FIRST_FRAG"
  | "INVALID_FRAG_ID"
  | "TOO_SMALL_FRAGMENT"
  | "TOO_BIG_FRAGMENT"
  | "OUT_OF_SPACE";

/**
 * The numbers the server puts in the kick message.
 *
 * `TSServerBuffer::OnError` kicks with `"Custom packet error: " + uint32(error)`
 * (`TSCustomPacket.cpp:119-122`), so a player who reports being thrown out with a bare number can
 * be told which of these it was.
 */
export const CUSTOM_PACKET_ERROR_CODES: Readonly<Record<CustomPacketError, number>> = {
  NO_HEADER: 0x1,
  HEADER_MISMATCH: 0x2,
  INVALID_FRAG_COUNT: 0x4,
  INVALID_FIRST_FRAG: 0x8,
  INVALID_FRAG_ID: 0x10,
  TOO_SMALL_FRAGMENT: 0x20,
  TOO_BIG_FRAGMENT: 0x40,
  OUT_OF_SPACE: 0x80,
};

export type CustomPacketWarningKind =
  /** A message arrived in more than one fragment, which tswow's own reader mis-reads. */
  | "reader-skew"
  /** A half-delivered message waited longer than the tail timeout and was thrown away. */
  | "abandoned-tail"
  /** A whole message arrived on an opcode that already had a partial waiting. */
  | "replaced-partial";

export interface CustomPacketWarning {
  readonly kind: CustomPacketWarningKind;
  readonly opcode: number;
  readonly totalFrags: number;
  /** Payload bytes involved: the assembled message, or what the discarded partial held. */
  readonly bytes: number;
  /** Ready to show in the diagnostics window. */
  readonly text: string;
}

export type CustomPacketReceipt =
  | { readonly kind: "message"; readonly opcode: number; readonly totalFrags: number; readonly body: Uint8Array }
  | { readonly kind: "fragment"; readonly opcode: number; readonly totalFrags: number; readonly received: number }
  | {
    readonly kind: "error";
    readonly error: CustomPacketError;
    /** The number `TSServerBuffer::OnError` would have kicked with. */
    readonly code: number;
    readonly header: CustomPacketHeader | undefined;
  };

export interface CustomPacketReassemblerOptions {
  readonly quota?: number;
  readonly maxFragmentSize?: number;
  readonly minFragmentSize?: number;
  readonly tailTimeoutMs?: number;
  /** Injected by the tests; `Date.now` in the client. */
  readonly clock?: () => number;
  readonly onWarning?: (warning: CustomPacketWarning) => void;
}

interface PendingMessage {
  totalFrags: number;
  lastFragmentId: number;
  bytes: number;
  updatedAt: number;
  readonly parts: Uint8Array[];
}

/** Reads the packed header. Throws rather than guessing when the fragment is shorter than one. */
export function readCustomHeader(payload: Uint8Array): CustomPacketHeader {
  if (payload.byteLength < CUSTOM_HEADER_SIZE) {
    throw new RangeError(`Custom fragment is ${payload.byteLength} bytes, shorter than its ${CUSTOM_HEADER_SIZE}-byte header`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { fragmentId: view.getUint16(0, true), totalFrags: view.getUint16(2, true), opcode: view.getUint16(4, true) };
}

/** Header and body, in the order `buildMessages` stamps them (`CustomPacketBase.cpp:54-65`). */
export function parseCustomFragment(payload: Uint8Array): CustomPacketFragment {
  return { header: readCustomHeader(payload), body: payload.subarray(CUSTOM_HEADER_SIZE) };
}

/**
 * One fragment carrying the whole message, which is the only shape a client can send.
 *
 * Bounded at both ends, and both ends are the same rule read in opposite directions. Above,
 * `RangeError` naming {@link CUSTOM_MAX_SEND_BODY} rather than splitting the body, because
 * splitting it is what would actually end the session — see that constant for the two limits that
 * close the door from both sides. Below, {@link CUSTOM_MIN_SEND_BODY}: one byte, because a
 * header-only frame is what the server calls `NO_HEADER`.
 */
export function buildCustomPacket(opcode: number, body: Uint8Array): Uint8Array {
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xffff) {
    throw new RangeError(`Custom opcode ${opcode} is not a uint16`);
  }
  if (body.byteLength < CUSTOM_MIN_SEND_BODY) {
    // The receiving half of this same file already refuses a six-byte fragment, because
    // `ReceivePacket` opens with `if (size <= CustomHeaderSize) return _onError(NO_HEADER, data)`
    // (`CustomPacketBuffer.cpp:24-27`) over `packet.size()` — the payload with the four opcode
    // bytes already taken back off (`WorldSocket.cpp:230`). On the server that refusal is a kick,
    // so the transport has to apply it in both directions and not only the one it reads. This is
    // not a corner: a message with no fields is exactly how "the player pressed Close" is spelled.
    throw new RangeError(
      `Custom packet ${opcode} has an empty body: the frame would be ${CUSTOM_HEADER_SIZE} bytes of header and`
      + ` nothing else, which the worldserver answers with NO_HEADER (${CUSTOM_PACKET_ERROR_CODES.NO_HEADER})`
      + " and a kick. Give the message at least one byte — a u8 the livescript ignores will do",
    );
  }
  if (body.byteLength > CUSTOM_MAX_SEND_BODY) {
    throw new RangeError(
      `Custom packet body is ${body.byteLength} bytes, over CUSTOM_MAX_SEND_BODY (${CUSTOM_MAX_SEND_BODY}):`
      + " the worldserver closes the socket on a larger frame and cannot be sent a second fragment",
    );
  }

  const fragment = new Uint8Array(CUSTOM_HEADER_SIZE + body.byteLength);
  const view = new DataView(fragment.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, opcode, true);
  fragment.set(body, CUSTOM_HEADER_SIZE);
  return fragment;
}

/**
 * The receiving half: fragments in, whole messages out.
 *
 * Two deliberate departures from `CustomPacketBuffer`, both of which are that file's bugs rather
 * than its protocol:
 *
 * 1. **Strict concatenation.** The C++ receive path builds a chunk whose `m_size` counts the
 *    header (`CustomPacketBuffer.cpp:40` → `CustomPacketChunk.cpp:10-13`) while its readers already
 *    skip it (`:70-73`), so a message spanning F fragments carries six junk bytes after each
 *    non-final fragment's payload once tswow reads it back. This joins payloads only, and warns
 *    with `reader-skew` so the module author learns that tswow's own Lua client will read that
 *    same message differently.
 * 2. **Bounds-checked reads.** `CustomPacketBase::Read` compares against that inflated total, so
 *    reading past a message's real end hands back heap bytes instead of the caller's default. The
 *    codec on top of this reader throws instead.
 *
 * Kept faithfully: the order of the eight checks, their names and their numbers, the per-connection
 * quota, and `_onError`'s habit of destroying everything half-assembled rather than only the
 * message that went wrong (`CustomPacketBuffer.cpp:99-104`).
 */
export class CustomPacketReassembler {
  readonly #quota: number;
  readonly #maxFragmentSize: number;
  readonly #minFragmentSize: number;
  readonly #tailTimeoutMs: number;
  readonly #clock: () => number;
  readonly #onWarning: ((warning: CustomPacketWarning) => void) | undefined;
  /**
   * Half-assembled messages by opcode.
   *
   * The C++ has one slot for the whole connection and takes the finished message's opcode from its
   * *last* fragment (`CustomPacketBuffer.cpp:119-134`), so two modules whose messages interleave
   * would splice into one. Nothing the server sends can interleave — `SendToPlayer` writes one
   * message's fragments back to back — so keying by opcode costs nothing and cannot be worse.
   */
  readonly #pending = new Map<number, PendingMessage>();
  #pendingBytes = 0;
  /** The last few warnings, for the diagnostics window. */
  readonly warnings: CustomPacketWarning[] = [];
  #warningCount = 0;

  constructor(options: CustomPacketReassemblerOptions = {}) {
    this.#quota = options.quota ?? CUSTOM_BUFFER_QUOTA;
    this.#maxFragmentSize = options.maxFragmentSize ?? CUSTOM_MAX_FRAGMENT_SIZE;
    this.#minFragmentSize = options.minFragmentSize ?? CUSTOM_MIN_FRAGMENT_SIZE;
    this.#tailTimeoutMs = options.tailTimeoutMs ?? CUSTOM_TAIL_TIMEOUT_MS;
    this.#clock = options.clock ?? Date.now;
    this.#onWarning = options.onWarning;
  }

  /** Payload bytes held for messages that are still missing fragments. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /**
   * How many warnings there have been in all, which `warnings.length` stops saying at 32.
   *
   * The diagnostics pane redraws when a number it shows moves, and a transport warning is one of
   * the things it shows. Past the thirty-second one the list stops growing and only its contents
   * change, so its length is no longer a change detector — this is.
   */
  get warningCount(): number {
    return this.#warningCount;
  }

  /** How many opcodes have a half-assembled message waiting. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * One fragment as it came out of the world packet, header included.
   *
   * The quota compares payload bytes; the server compares fragment bytes, because `Push` adds the
   * inflated `chnk.Size()` (`CustomPacketBase.cpp:85-89`). Everything held here is by construction
   * a non-final fragment, so each of them cleared {@link CUSTOM_MIN_FRAGMENT_SIZE} and carries at
   * least 25,000 − 6 = 24,994 payload bytes: an 8,000,000 quota holds at most
   * ⌊8 000 000 / 24 994⌋ = 320 of them, and the two ceilings are therefore at most 320 × 6 = 1,920
   * bytes apart — far too little to let anything through that the server would have refused.
   */
  receive(payload: Uint8Array): CustomPacketReceipt {
    this.sweep();

    // The order is `CustomPacketBuffer::ReceivePacket`'s (`:20-97`) and the order is the contract:
    // a 40,000-byte fragment with a zero `totalFrags` is TOO_BIG_FRAGMENT on this core, not
    // INVALID_FRAG_COUNT, and a module author matching kick codes against this list would be
    // misled by any other sequence.
    const header = payload.byteLength >= CUSTOM_HEADER_SIZE ? readCustomHeader(payload) : undefined;
    if (payload.byteLength <= CUSTOM_HEADER_SIZE) return this.#fail("NO_HEADER", header);
    if (payload.byteLength > this.#maxFragmentSize) return this.#fail("TOO_BIG_FRAGMENT", header);
    if (payload.byteLength + this.#pendingBytes > this.#quota) return this.#fail("OUT_OF_SPACE", header);

    const { body } = parseCustomFragment(payload);
    if (header === undefined) return this.#fail("NO_HEADER", header);
    if (header.totalFrags === 0) return this.#fail("INVALID_FRAG_COUNT", header);

    if (header.totalFrags === 1) {
      // A whole message. The C++ appends it to whatever partial is open and delivers the pair as
      // one message (`:47-49` → `AppendFragment(chnk, true)`), which hands a module a message with
      // somebody else's bytes glued to the front. Deliver the fragment on its own and say what was
      // thrown away instead.
      const abandoned = this.#pending.get(header.opcode);
      if (abandoned) {
        this.#drop(header.opcode);
        this.#warn({
          kind: "replaced-partial",
          opcode: header.opcode,
          totalFrags: abandoned.totalFrags,
          bytes: abandoned.bytes,
          text: `custom opcode ${header.opcode}: a whole message arrived while ${abandoned.bytes} bytes of a`
            + ` ${abandoned.totalFrags}-fragment message were still waiting; the partial was dropped`,
        });
      }
      return { kind: "message", opcode: header.opcode, totalFrags: 1, body: body.slice() };
    }

    const pending = this.#pending.get(header.opcode);
    if (!pending) {
      if (header.fragmentId !== 0) return this.#fail("INVALID_FIRST_FRAG", header);
      if (payload.byteLength < this.#minFragmentSize) return this.#fail("TOO_SMALL_FRAGMENT", header);
      this.#pending.set(header.opcode, {
        totalFrags: header.totalFrags,
        lastFragmentId: header.fragmentId,
        bytes: body.byteLength,
        updatedAt: this.#clock(),
        parts: [body.slice()],
      });
      this.#pendingBytes += body.byteLength;
      return { kind: "fragment", opcode: header.opcode, totalFrags: header.totalFrags, received: 1 };
    }

    if (pending.totalFrags !== header.totalFrags) return this.#fail("HEADER_MISMATCH", header);
    if (header.fragmentId !== pending.lastFragmentId + 1) return this.#fail("INVALID_FRAG_ID", header);

    const isLast = header.fragmentId === pending.totalFrags - 1;
    if (!isLast && payload.byteLength < this.#minFragmentSize) return this.#fail("TOO_SMALL_FRAGMENT", header);

    pending.parts.push(body.slice());
    pending.bytes += body.byteLength;
    pending.lastFragmentId = header.fragmentId;
    pending.updatedAt = this.#clock();
    this.#pendingBytes += body.byteLength;
    if (!isLast) {
      return { kind: "fragment", opcode: header.opcode, totalFrags: header.totalFrags, received: pending.parts.length };
    }

    const message = new Uint8Array(pending.bytes);
    let offset = 0;
    for (const part of pending.parts) {
      message.set(part, offset);
      offset += part.byteLength;
    }
    this.#drop(header.opcode);
    this.#warn({
      kind: "reader-skew",
      opcode: header.opcode,
      totalFrags: header.totalFrags,
      bytes: message.byteLength,
      text: `custom opcode ${header.opcode}: ${header.totalFrags} fragments joined into ${message.byteLength} bytes;`
        + ` tswow's own reader would see ${(header.totalFrags - 1) * CUSTOM_HEADER_SIZE} junk bytes in this message`,
    });
    return { kind: "message", opcode: header.opcode, totalFrags: header.totalFrags, body: message };
  }

  /**
   * Throws away messages whose tail never came.
   *
   * Runs at the top of every {@link receive}, which is enough: nothing else can add to the buffer,
   * and what an abandoned tail holds is already bounded by the quota. A caller with a frame clock
   * may call it directly to have the diagnostics window notice sooner.
   */
  sweep(now: number = this.#clock()): void {
    for (const [opcode, pending] of [...this.#pending]) {
      if (now - pending.updatedAt < this.#tailTimeoutMs) continue;
      this.#drop(opcode);
      this.#warn({
        kind: "abandoned-tail",
        opcode,
        totalFrags: pending.totalFrags,
        bytes: pending.bytes,
        text: `custom opcode ${opcode}: ${pending.parts.length} of ${pending.totalFrags} fragments`
          + ` (${pending.bytes} bytes) waited more than ${this.#tailTimeoutMs} ms for the rest and were dropped`,
      });
    }
  }

  /** Forgets every half-assembled message, as `_onError` does. Warnings are left alone. */
  reset(): void {
    this.#pending.clear();
    this.#pendingBytes = 0;
  }

  #drop(opcode: number): void {
    const pending = this.#pending.get(opcode);
    if (!pending) return;
    this.#pendingBytes -= pending.bytes;
    this.#pending.delete(opcode);
  }

  #fail(error: CustomPacketError, header: CustomPacketHeader | undefined): CustomPacketReceipt {
    // `_onError` destroys the whole buffer, not just the message that went wrong
    // (`CustomPacketBuffer.cpp:99-104`), and on the server the player is kicked immediately after.
    // Keeping the other partials here would leave this client assembling messages that the server
    // has already stopped believing in.
    this.reset();
    return { kind: "error", error, code: CUSTOM_PACKET_ERROR_CODES[error], header };
  }

  #warn(warning: CustomPacketWarning): void {
    this.warnings.push(warning);
    if (this.warnings.length > WARNING_LIMIT) this.warnings.shift();
    this.#warningCount++;
    this.#onWarning?.(warning);
  }
}
