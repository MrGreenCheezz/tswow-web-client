// Loading one client texture into three.js, and what happens when it is not there.
//
// This lived as a private method on `WorldRenderer3D` until the character lab needed it. The lab's
// whole point is to exercise the shipping path rather than a copy of it, and a copy is exactly
// what a second `TextureLoader` in the lab would have been — with its own idea of what a failed
// fetch looks like, which is the one behaviour the lab exists to observe.

import * as THREE from "three";

export type ModelTextureStatus = "pending" | "ready" | "failed";

interface TextureEntry {
  readonly texture: THREE.Texture;
  status: ModelTextureStatus;
}

/** One opaque white pixel, RGBA. Shared: every failure wants the same four bytes. */
const MISSING_PIXEL = new Uint8Array([255, 255, 255, 255]);

/**
 * A texture, and a visible answer when there is not one.
 *
 * `TextureLoader.load` is fire-and-forget: the object it returns is filled in later or is left
 * as it was, and nothing downstream is told which. The error callback is the only place that
 * knows, and swapping in an opaque pixel there is what keeps an alpha-keyed material — hair,
 * foliage, a cloth fringe — from disappearing entirely rather than merely looking wrong.
 */
export class ModelTextureLoader {
  readonly #loader = new THREE.TextureLoader();
  /** Whether this loader owns a URL cache. The ordinary model loader keeps its historical per-build ownership. */
  readonly #cacheEnabled: boolean;
  /** One in-flight/GPU texture per URL, so geometry and emitters cannot race separate placeholders. */
  readonly #entries = new Map<string, TextureEntry>();
  readonly #byTexture = new WeakMap<THREE.Texture, TextureEntry>();

  constructor(options: { cache?: boolean } = {}) {
    this.#cacheEnabled = options.cache === true;
  }

  /**
   * What a texture becomes when its fetch fails: one opaque white pixel.
   *
   * A failed load leaves `map` pointing at a transparent placeholder, and a hair card is drawn
   * with `alphaTest = 224/255` — so every fragment of it is discarded and the character is bald.
   * Not untextured, not pink, not a missing-texture chequer: *bald*, which is indistinguishable
   * from a character who chose to be. One opaque pixel makes the failure look like a failure.
   *
   * It never worked. Until now this assigned a `DataTexture`'s `{data, width, height}` onto the
   * plain `THREE.Texture` that `TextureLoader.load` hands back, and three decides which upload
   * path an image takes by the `isDataTexture` flag alone (`WebGLTextures.js:972` in 0.185.1) —
   * so the pixel went down the `HTMLImageElement` branch, `texSubImage2D` was called with a bare
   * object, and `WebGLState.js:1004-1016` caught the resulting `TypeError` and turned it into a
   * console line. What was left bound was the 1×1 storage three had just allocated, zero-filled:
   * transparent black, which is the very thing the opaque pixel exists to avoid.
   *
   * The object the material holds is therefore turned into a data texture rather than handed one:
   * the flag, the image shape and the four settings `DataTexture`'s own constructor applies. It is
   * a one-way change — a texture that failed is never filled in afterwards — so nothing can end up
   * flagged as data while holding an image.
   */
  load(url: string): THREE.Texture {
    if (this.#cacheEnabled) {
      const existing = this.#entries.get(url);
      if (existing) return existing.texture;
    }

    // The callbacks run after the binding is initialised in the browser, so naming the entry here
    // is safe and is the only way to reach the object the loader is filling in.  Keep the failed
    // state separate from the opaque diagnostic pixel: spell phases must suppress a failed asset,
    // while ordinary world models may still use that pixel as their visible fallback.
    let entry: TextureEntry | undefined;
    let texture: THREE.Texture | undefined;
    // The browser loader is asynchronous, but keeping completion until the returned texture is
    // assigned also makes this safe for test loaders and cache layers that invoke callbacks inline.
    let completion: ModelTextureStatus | undefined;
    const ready = () => {
      if (!entry) {
        // Failure is terminal even if a non-conforming loader reports a late success before the
        // returned texture has been assigned to its entry.
        if (completion === "failed") return;
        completion = "ready";
        return;
      }
      if (entry.status === "failed") return;
      entry.status = "ready";
      if (texture) texture.needsUpdate = true;
    };
    const failed = () => {
      if (!entry) {
        completion = "failed";
        return;
      }
      if (entry.status === "failed") return;
      entry.status = "failed";
      if (texture) substituteMissingPixel(texture);
    };
    texture = this.#loader.load(url, ready, undefined, failed);
    entry = { texture, status: completion ?? "pending" };
    if (completion === "failed") substituteMissingPixel(texture);
    if (this.#cacheEnabled) this.#entries.set(url, entry);
    this.#byTexture.set(texture, entry);
    return texture;
  }

  /** Current network/GPU readiness for the texture returned by {@link load}. */
  status(texture: THREE.Texture): ModelTextureStatus {
    return this.#byTexture.get(texture)?.status ?? "failed";
  }

  /** Current status for a URL, without starting a request. */
  statusOf(url: string): ModelTextureStatus | undefined {
    return this.#entries.get(url)?.status;
  }
}

/**
 * Turns one texture into the opaque white pixel, in place.
 *
 * Exported so a test can assert the shape three's uploader requires without a WebGL context: the
 * flag that picks the branch, and the four fields `DataTexture` sets that a `Texture` does not.
 */
export function substituteMissingPixel(texture: THREE.Texture): void {
  texture.image = { data: MISSING_PIXEL, width: 1, height: 1 };
  (texture as THREE.Texture & { isDataTexture?: boolean }).isDataTexture = true;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
}
