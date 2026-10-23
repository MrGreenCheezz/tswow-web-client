/**
 * 23.10 (7.48): the HD texture sets `tools/upscale-textures.mjs` builds (client textures upscaled on the GPU),
 * as the `/texture` route serves them.
 *
 * A request that carries `hd=<generation>` (the browser adds it only for the paths of a set, and only with the
 * enhanced setting «Чёткие текстуры эффектов» on) is answered from a set when that set holds the path and the
 * entry's source stamp still matches the client — otherwise with the original, exactly as without `hd`. The
 * faithful and comparison profiles never send `hd`, so they are never served anything but the originals.
 *
 * - Where: `<directory>/<set>/<id>.png` with `id` = sha1(`hd-texture-v1\0<path>`), the same name the tool
 *   writes. The file name is computed here from the validated path; nothing from the request or from a manifest
 *   is joined into a file name, and set names are taken only from directory entries of a fixed shape.
 * - The generation: a digest of every set's `manifest.json`, re-read at most once a `refreshMs`, published in
 *   `/client/patch-status` as `hdTextureGeneration`. An HD answer is immutable only under the current visual
 *   generation *and* the current HD generation; anything else (an original answered to an `hd` request, a URL of
 *   an older set) is revalidated, so a set that is built or rebuilt later reaches the browser on its next request.
 * - The switch: `HD_TEXTURES=0` turns it off (no generation published, `hd` ignored). On by default for the
 *   owner's own play; `tools/start-server.mjs` (bat\32, serving other players) turns it off unless
 *   `PUBLIC_HD_TEXTURES=1` — whether players get the set is the owner's decision.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const HD_TEXTURE_NAMESPACE = "hd-texture-v1";
/** The query parameter an HD texture request carries: the HD generation the browser was told. */
export const HD_TEXTURE_PARAM = "hd";
/** Set directory names the gateway will look into. */
const SET_NAME = /^[a-z0-9-]{1,32}$/;
const MANIFEST = "manifest.json";

/** The file name of one HD texture (tools/upscale-textures.mjs `hdTextureId`). */
export function hdTextureId(texturePath: string): string {
  return createHash("sha1").update(`${HD_TEXTURE_NAMESPACE}\0${texturePath.replaceAll("/", "\\").toLowerCase()}`).digest("hex");
}

/** `HD_TEXTURES`: on unless it says 0/false/off/no. */
export function parseHdTexturesEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env["HD_TEXTURES"]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

interface SetSnapshot {
  readonly names: readonly string[];
  readonly generation: string | undefined;
}

export interface HdTextureSetsOptions {
  /** How long a read of the set directories is trusted (default 2 s). */
  readonly refreshMs?: number;
  readonly now?: () => number;
  /**
   * Told the name of a set that holds a copy whose stamp no longer matches the client — after a TSWoW build
   * republished the patch archives, typically every copy — at most once a `staleRetryMs` (default 60 s) per set.
   * The gateway runs `tools/upscale-textures.mjs --set <name> --restamp-only` (no GPU, seconds): copies whose BLP
   * bytes did not change are stamped again and served; the rest keep answering the original until a full run.
   */
  readonly onStale?: (set: string) => void;
  readonly staleRetryMs?: number;
}

/** The HD sets under one directory. */
export class HdTextureSets {
  readonly directory: string;
  readonly #refreshMs: number;
  readonly #now: () => number;
  #snapshot: SetSnapshot | undefined;
  #readAt = 0;
  #pending: Promise<SetSnapshot> | undefined;
  readonly #onStale: ((set: string) => void) | undefined;
  readonly #staleRetryMs: number;
  readonly #staleToldAt = new Map<string, number>();

  constructor(directory: string, options: HdTextureSetsOptions = {}) {
    this.directory = directory;
    this.#refreshMs = options.refreshMs ?? 2000;
    this.#now = options.now ?? Date.now;
    this.#onStale = options.onStale;
    this.#staleRetryMs = options.staleRetryMs ?? 60_000;
  }

  async #read(): Promise<SetSnapshot> {
    let entries: string[];
    try {
      entries = (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && SET_NAME.test(entry.name)).map((entry) => entry.name).sort();
    } catch {
      return { names: [], generation: undefined };
    }
    const hash = createHash("sha1").update(HD_TEXTURE_NAMESPACE);
    const names: string[] = [];
    for (const name of entries) {
      let manifest: Buffer;
      try {
        manifest = await readFile(join(this.directory, name, MANIFEST));
      } catch {
        continue;
      }
      names.push(name);
      hash.update(`\0${name}\0${manifest.length}\0`).update(manifest);
    }
    return { names, generation: names.length === 0 ? undefined : hash.digest("hex").slice(0, 20) };
  }

  async #current(): Promise<SetSnapshot> {
    if (this.#snapshot !== undefined && this.#now() - this.#readAt < this.#refreshMs) return this.#snapshot;
    this.#pending ??= this.#read().then((snapshot) => {
      this.#snapshot = snapshot;
      this.#readAt = this.#now();
      return snapshot;
    }).finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  /** The HD generation (20 hex), or undefined when there is no set at all. */
  async generation(): Promise<string | undefined> {
    return (await this.#current()).generation;
  }

  /**
   * The HD file for a texture path the caller has already validated, or undefined: the first set that holds a
   * file for it and whose stamp `isCurrent` accepts.
   */
  async find(texturePath: string, isCurrent: (file: string) => Promise<boolean>): Promise<string | undefined> {
    const id = `${hdTextureId(texturePath)}.png`;
    for (const name of (await this.#current()).names) {
      const file = join(this.directory, name, id);
      try {
        if (!(await stat(file)).isFile()) continue;
      } catch {
        continue;
      }
      if (await isCurrent(file)) return file;
      const told = this.#staleToldAt.get(name);
      if (this.#onStale && (told === undefined || this.#now() - told >= this.#staleRetryMs)) {
        this.#staleToldAt.set(name, this.#now());
        this.#onStale(name);
      }
    }
    return undefined;
  }
}
