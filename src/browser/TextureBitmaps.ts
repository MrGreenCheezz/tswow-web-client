/**
 * Client textures as `ImageBitmap`s, fetched by their path in the archives.
 *
 * Shared by the minimap and the world map because both want the same thing: a BLP out of the
 * client, decoded once and drawn to a 2D canvas many times. `/texture` publishes it as a PNG the
 * first time anyone asks, and thereafter serves it from disk.
 *
 * **`fetch`, never `<img src>`.** The gateway refuses a request that carries no `Origin` header,
 * and a browser does not send one for a plain image load, so an `<img>` pointed at `/texture` is a
 * silent 403. Everything here goes through `fetch` and `createImageBitmap`.
 */
export class TextureBitmapCache {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #maximum: number;
  /** Path to picture. `null` is "asked for and not there", which is never asked for again. */
  readonly #bitmaps = new Map<string, ImageBitmap | null>();
  readonly #loading = new Set<string>();
  #revision = 0;

  constructor(gatewayWebSocketUrl: string, maximum = 192) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#maximum = maximum;
  }

  /** Bumped by every picture that lands, so a canvas knows there is something new to draw. */
  get revision(): number {
    return this.#revision;
  }

  /** The picture, or undefined until it lands. Asking starts the download exactly once. */
  bitmap(path: string): ImageBitmap | undefined {
    const known = this.#bitmaps.get(path);
    if (known !== undefined) return known ?? undefined;
    if (!this.#loading.has(path)) {
      this.#loading.add(path);
      void this.#load(path);
    }
    return undefined;
  }

  /** Whether a path has been settled either way, which is how a caller stops probing for tiles. */
  settled(path: string): boolean {
    return this.#bitmaps.has(path);
  }

  clear(): void {
    for (const bitmap of this.#bitmaps.values()) bitmap?.close();
    this.#bitmaps.clear();
    this.#loading.clear();
    this.#revision++;
  }

  async #load(path: string): Promise<void> {
    try {
      // Low, as `<img>` would have been: the gateway is one HTTP/1.1 origin with six sockets, and a
      // minimap or world-map tile asked for at `fetch`'s default high priority took a socket ahead of
      // the unit skins an arriving crowd is waiting on (they stand as capsules until theirs land).
      const response = await fetch(`${this.#baseUrl}/texture?path=${encodeURIComponent(path)}`, { priority: "low" });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      this.#evict();
      this.#bitmaps.set(path, bitmap);
      this.#revision++;
    } catch (error) {
      // A missing picture is normal rather than exceptional: the world map probes for tiles it
      // cannot know the number of, and a map with no art is drawn without one.
      this.#bitmaps.set(path, null);
      this.#revision++;
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#loading.delete(path);
    }
  }

  /** Oldest first, which is insertion order for a Map and good enough for a walk across a zone. */
  #evict(): void {
    while (this.#bitmaps.size >= this.#maximum) {
      const oldest = this.#bitmaps.keys().next();
      if (oldest.done) return;
      this.#bitmaps.get(oldest.value)?.close();
      this.#bitmaps.delete(oldest.value);
    }
  }
}
