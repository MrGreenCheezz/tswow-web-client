import { ByteQueue } from "./ByteQueue.js";

export interface BinaryByteStream {
  send(bytes: Uint8Array): void;
  readExactly(length: number): Promise<Uint8Array>;
  close(): void;
  /**
   * The synchronous side (P1-21b1), optional so that a stream with only `readExactly` still works:
   * `WorldConnection.tryRead` checks for it with `typeof`. While a `readExactly` is waiting these
   * answer 0 / false / undefined — there is one reader, and it is the one already waiting.
   */
  readonly buffered?: number;
  /** Copies the first `length` buffered bytes into `target` without consuming them. */
  peek?(target: Uint8Array, length: number): boolean;
  /** Consumes `length` buffered bytes, or nothing and undefined when fewer are held. */
  readBuffered?(length: number): Uint8Array | undefined;
}

interface Waiter {
  length: number;
  resolve(bytes: Uint8Array): void;
  reject(error: Error): void;
}

/**
 * The socket closed under a read: the code and reason the other end closed it with. The gateway
 * says why it gave up in both (`bridge()` in Gateway.ts: 1011 with «Backend unavailable», «Backend
 * connection failed», «Client stopped responding»…), which is what a screen needs to tell a realm
 * that is down from a network that dropped; 1006 with no reason is a connection that simply died.
 */
export class TransportClosedError extends Error {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(code: number, reason: string, wasClean: boolean) {
    super(`WebSocket transport closed (${code}${reason ? `, ${reason}` : ""})`);
    this.name = "TransportClosedError";
    this.code = code;
    this.reason = reason;
    this.wasClean = wasClean;
  }
}

/** The socket never opened: nothing answered at `url`, or the gateway refused the upgrade. */
export class TransportConnectError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`Cannot connect to ${url}`);
    this.name = "TransportConnectError";
    this.url = url;
  }
}

export class WebSocketByteStream implements BinaryByteStream {
  readonly #socket: WebSocket;
  readonly #queue = new ByteQueue();
  readonly #waiters: Waiter[] = [];
  #failure: Error | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        this.#fail(new Error("Gateway returned a non-binary WebSocket message"));
        return;
      }
      this.#queue.push(new Uint8Array(event.data));
      this.#drain();
    });
    // A browser follows every `error` with a `close` (the WebSocket spec's "fail the connection"),
    // and only the close carries the code and the reason — so it is the close that fails the reads.
    socket.addEventListener("close", (event) => {
      this.#fail(new TransportClosedError(event.code, event.reason, event.wasClean));
    });
  }

  static connect(url: string): Promise<WebSocketByteStream> {
    const socket = new WebSocket(url);
    const stream = new WebSocketByteStream(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(stream), { once: true });
      socket.addEventListener("error", () => reject(new TransportConnectError(url)), { once: true });
      socket.addEventListener("close", () => reject(new TransportConnectError(url)), { once: true });
    });
  }

  send(bytes: Uint8Array): void {
    if (this.#socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket transport is not open");
    this.#socket.send(bytes);
  }

  readExactly(length: number): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 0) return Promise.reject(new RangeError("Invalid read length"));
    if (this.#queue.length >= length) return Promise.resolve(this.#queue.read(length));
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ length, resolve, reject });
    });
  }

  get buffered(): number {
    return this.#waiters.length > 0 ? 0 : this.#queue.length;
  }

  peek(target: Uint8Array, length: number): boolean {
    return this.#waiters.length === 0 && this.#queue.peek(target, length);
  }

  readBuffered(length: number): Uint8Array | undefined {
    if (this.#waiters.length > 0 || !Number.isInteger(length) || length < 0 || this.#queue.length < length) return undefined;
    return this.#queue.read(length);
  }

  close(): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close(1000);
    }
  }

  #drain(): void {
    while (this.#waiters[0] && this.#queue.length >= this.#waiters[0].length) {
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(this.#queue.read(waiter.length));
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}
