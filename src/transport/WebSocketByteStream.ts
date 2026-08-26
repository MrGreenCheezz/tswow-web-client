import { ByteQueue } from "./ByteQueue.js";

export interface BinaryByteStream {
  send(bytes: Uint8Array): void;
  readExactly(length: number): Promise<Uint8Array>;
  close(): void;
}

interface Waiter {
  length: number;
  resolve(bytes: Uint8Array): void;
  reject(error: Error): void;
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
    socket.addEventListener("error", () => this.#fail(new Error("WebSocket transport failed")));
    socket.addEventListener("close", () => this.#fail(new Error("WebSocket transport closed")));
  }

  static connect(url: string): Promise<WebSocketByteStream> {
    const socket = new WebSocket(url);
    const stream = new WebSocketByteStream(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(stream), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
      socket.addEventListener("close", () => reject(new Error(`Connection to ${url} closed before opening`)), { once: true });
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
