/**
 * A browser may start another realm connection while the previous WebSocket or world handshake is
 * still pending. Every asynchronous stage has to hand an obsolete socket back rather than making
 * it the current session after a different realm or account has already won.
 */
export class LatestConnection {
  #generation = 0;

  begin(): number {
    return ++this.#generation;
  }

  invalidate(): void {
    ++this.#generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  async accept<T extends { close(): void }>(generation: number, pending: Promise<T>): Promise<T | undefined> {
    const connection = await pending;
    if (this.isCurrent(generation)) return connection;
    connection.close();
    return undefined;
  }
}
