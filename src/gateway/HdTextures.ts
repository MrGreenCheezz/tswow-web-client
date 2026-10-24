/**
 * 23.10 (7.48): the HD texture sets `tools/upscale-textures.mjs` builds (client textures upscaled on the GPU),
 * as the `/texture`, `/terrain-layer` and `/visual/texture` routes serve them.
 *
 * A request that carries `hd=<generation>` (the browser adds it only for the paths of a set, and only with the
 * enhanced setting «Чёткие текстуры эффектов» / «Чёткие текстуры мира» on) is answered from a set when that set holds
 * the texture and the entry's source stamp still matches the client — otherwise with the original, exactly as
 * without `hd`. The faithful and comparison profiles never send `hd`, so they are never served anything but the
 * originals.
 *
 * - Effects (`/texture?path=…&hd=`): `<directory>/<set>/<id>.png` with `id` = sha1(`hd-texture-v1\0<path>`), the
 *   same name the tool writes, from any set but `world`. The file name is computed here from the validated path;
 *   nothing from the request or from a manifest is joined into a file name, and set names are taken only from
 *   directory entries of a fixed shape.
 * - World (23.10, step 2): the `world` set's GPU-compressed copies, `<directory>/world/<id>.wht` (BC7 with its mip
 *   chain, tools/hd-texture-bc7.mjs), answered as `application/x-webclient-hd-texture`. The browser asks for them
 *   only with BPTC support and reads the container's magic, so an original PNG answered instead is drawn as
 *   before. Neither route names a texture path, so the manifest maps them back: a ground layer's id is
 *   sha1(`terrain-layer-v1|v2\0<path>`) (tools/generate-terrain-splat.mjs), a building texture is known by the sha1
 *   of the original PNG `/visual/texture/<hash>-<n>.png` serves (`compressed.originalPng`, the same `blpToPng`
 *   bytes). Only a path the manifest lists is ever looked up; the file name is still computed from it here.
 * - Scenery models (24.10, step 3): `/texture?path=…&hd=` for a path the world set lists with a compressed copy (not a
 *   ground texture) is answered with that `.wht` — doodads, trees, skyboxes and WMO second textures. The browser asks
 *   so only for the scenery folders and only from loaders that take a container (HdWorldTextures.ts); an effect
 *   path is never in the world set, so the effects' PNG answers are unchanged.
 * - The generation: a digest of every set's `manifest.json`, re-read when its size or time changes and at most once
 *   a `refreshMs`, published in `/client/patch-status` as `hdTextureGeneration`. An HD answer is immutable only
 *   under the current asset generation *and* the current HD generation; anything else (an original answered to an
 *   `hd` request, a URL of an older set) is revalidated, so a set that is built or rebuilt later reaches the
 *   browser on its next request.
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
/** 23.10 (7.48): the set whose entries are served compressed to the world routes (and never as PNG). */
export const HD_WORLD_SET = "world";
/** 23.10 (7.48): what a compressed HD answer is sent as (tools/hd-texture-bc7.mjs `CONTAINER_CONTENT_TYPE`). */
export const HD_TEXTURE_CONTENT_TYPE = "application/x-webclient-hd-texture";
/** 23.10 (7.48): the ground layer id namespaces (tools/generate-terrain-splat.mjs). */
const TERRAIN_LAYER_NAMESPACES = ["terrain-layer-v1", "terrain-layer-v2"] as const;
/** Set directory names the gateway will look into. */
const SET_NAME = /^[a-z0-9-]{1,32}$/;
const MANIFEST = "manifest.json";
const SHA1 = /^[0-9a-f]{40}$/;
/** 23.10 (7.48): building PNG digests remembered (by file name, size and time); past this the memo starts over. */
const DIGEST_MEMO_LIMIT = 16384;

/** The file name of one HD texture (tools/upscale-textures.mjs `hdTextureId`). */
export function hdTextureId(texturePath: string): string {
  return createHash("sha1").update(`${HD_TEXTURE_NAMESPACE}\0${texturePath.replaceAll("/", "\\").toLowerCase()}`).digest("hex");
}

/** 23.10 (7.48): the `/terrain-layer/<id>.png` ids a ground texture path is published under. */
export function terrainLayerIds(texturePath: string): string[] {
  const key = texturePath.replaceAll("/", "\\").toLowerCase();
  return TERRAIN_LAYER_NAMESPACES.map((namespace) => createHash("sha1").update(`${namespace}\0${key}`).digest("hex"));
}

/** `HD_TEXTURES`: on unless it says 0/false/off/no. */
export function parseHdTexturesEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env["HD_TEXTURES"]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

interface WorldIndex {
  /** Ground layer id → texture path. */
  readonly terrainLayers: ReadonlyMap<string, string>;
  /** sha1 of an original building PNG → texture path. */
  readonly buildingPngs: ReadonlyMap<string, string>;
  /**
   * 24.10 (7.48 step 3): the paths `/texture?path=…&hd=` may be answered compressed for — every entry with a
   * compressed copy but the ground (whose copy is laid out on the terrain array's 512 side, opaque).
   */
  readonly modelTextures: ReadonlySet<string>;
}

const EMPTY_WORLD_INDEX: WorldIndex = { terrainLayers: new Map(), buildingPngs: new Map(), modelTextures: new Set() };

interface SetSnapshot {
  readonly names: readonly string[];
  readonly generation: string | undefined;
  readonly world: WorldIndex;
}

interface ManifestRead {
  readonly size: number;
  readonly mtimeMs: number;
  readonly bytes: Buffer;
  readonly world: WorldIndex | undefined;
}

/**
 * 23.10 (7.48): the world set's lookups out of its manifest — only entries that have a compressed copy, only
 * well-formed keys. A manifest that does not parse yields none (the routes then answer originals).
 */
export function worldIndexOf(manifest: Buffer | string): WorldIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof manifest === "string" ? manifest : manifest.toString("utf8"));
  } catch {
    return EMPTY_WORLD_INDEX;
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== "object") return EMPTY_WORLD_INDEX;
  const terrainLayers = new Map<string, string>();
  const buildingPngs = new Map<string, string>();
  const modelTextures = new Set<string>();
  for (const [path, entry] of Object.entries(entries as Record<string, unknown>)) {
    const compressed = (entry as { compressed?: { originalPng?: unknown } } | null)?.compressed;
    if (!compressed || typeof compressed !== "object") continue;
    const key = path.replaceAll("/", "\\").toLowerCase();
    if (key.startsWith("tileset\\")) {
      for (const id of terrainLayerIds(key)) terrainLayers.set(id, key);
      continue;
    }
    modelTextures.add(key); // 24.10 (7.48 step 3)
    if (typeof compressed.originalPng === "string" && SHA1.test(compressed.originalPng)) {
      buildingPngs.set(compressed.originalPng, key);
    }
  }
  return { terrainLayers, buildingPngs, modelTextures };
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
  /** 23.10 (7.48): each set's manifest as last read, so an unchanged one is neither re-read nor re-parsed. */
  readonly #manifests = new Map<string, ManifestRead>();
  /** 23.10 (7.48): building PNG file → its digest, while its size and time stay. */
  readonly #pngDigests = new Map<string, { size: number; mtimeMs: number; sha1: string }>();

  constructor(directory: string, options: HdTextureSetsOptions = {}) {
    this.directory = directory;
    this.#refreshMs = options.refreshMs ?? 2000;
    this.#now = options.now ?? Date.now;
    this.#onStale = options.onStale;
    this.#staleRetryMs = options.staleRetryMs ?? 60_000;
  }

  async #readManifest(name: string): Promise<ManifestRead | undefined> {
    const file = join(this.directory, name, MANIFEST);
    try {
      const info = await stat(file);
      const known = this.#manifests.get(name);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known;
      const bytes = await readFile(file);
      const read: ManifestRead = { size: info.size, mtimeMs: info.mtimeMs, bytes,
        world: name === HD_WORLD_SET ? worldIndexOf(bytes) : undefined };
      this.#manifests.set(name, read);
      return read;
    } catch {
      this.#manifests.delete(name);
      return undefined;
    }
  }

  async #read(): Promise<SetSnapshot> {
    let entries: string[];
    try {
      entries = (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && SET_NAME.test(entry.name)).map((entry) => entry.name).sort();
    } catch {
      return { names: [], generation: undefined, world: EMPTY_WORLD_INDEX };
    }
    const hash = createHash("sha1").update(HD_TEXTURE_NAMESPACE);
    const names: string[] = [];
    let world = EMPTY_WORLD_INDEX;
    for (const name of entries) {
      const manifest = await this.#readManifest(name);
      if (!manifest) continue;
      names.push(name);
      if (manifest.world) world = manifest.world;
      hash.update(`\0${name}\0${manifest.bytes.length}\0`).update(manifest.bytes);
    }
    return { names, generation: names.length === 0 ? undefined : hash.digest("hex").slice(0, 20), world };
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

  /** A set's file for `id` when it is there and `isCurrent` accepts its stamp; reports a stale one. */
  async #look(name: string, file: string, isCurrent: (file: string) => Promise<boolean>): Promise<string | undefined> {
    try {
      if (!(await stat(file)).isFile()) return undefined;
    } catch {
      return undefined;
    }
    if (await isCurrent(file)) return file;
    const told = this.#staleToldAt.get(name);
    if (this.#onStale && (told === undefined || this.#now() - told >= this.#staleRetryMs)) {
      this.#staleToldAt.set(name, this.#now());
      this.#onStale(name);
    }
    return undefined;
  }

  /**
   * The HD PNG for a texture path the caller has already validated, or undefined: the first set but `world` that
   * holds a file for it and whose stamp `isCurrent` accepts.
   */
  async find(texturePath: string, isCurrent: (file: string) => Promise<boolean>): Promise<string | undefined> {
    const id = `${hdTextureId(texturePath)}.png`;
    for (const name of (await this.#current()).names) {
      if (name === HD_WORLD_SET) continue; // 23.10 (7.48): its PNGs are the compressor's input, not answers
      const file = await this.#look(name, join(this.directory, name, id), isCurrent);
      if (file) return file;
    }
    return undefined;
  }

  /** 23.10 (7.48): the compressed HD copy of a texture path the world set lists, when current. */
  async #findCompressed(texturePath: string, isCurrent: (file: string) => Promise<boolean>): Promise<string | undefined> {
    const snapshot = await this.#current();
    if (!snapshot.names.includes(HD_WORLD_SET)) return undefined;
    return this.#look(HD_WORLD_SET, join(this.directory, HD_WORLD_SET, `${hdTextureId(texturePath)}.wht`), isCurrent);
  }

  /**
   * 24.10 (7.48 step 3): the compressed HD copy of a scenery texture asked for on `/texture?path=…&hd=` (a path the
   * route has validated) — only when the world set lists it with a compressed copy and it is not a ground texture.
   */
  async findModelTexture(texturePath: string, isCurrent: (file: string) => Promise<boolean>): Promise<string | undefined> {
    const key = texturePath.replaceAll("/", "\\").toLowerCase();
    if (!(await this.#current()).world.modelTextures.has(key)) return undefined;
    return this.#findCompressed(key, isCurrent);
  }

  /** 23.10 (7.48): the compressed HD copy for a `/terrain-layer/<id>.png` id (40 hex, validated by the route). */
  async findTerrainLayer(layerId: string, isCurrent: (file: string) => Promise<boolean>): Promise<string | undefined> {
    const path = (await this.#current()).world.terrainLayers.get(layerId);
    return path === undefined ? undefined : this.#findCompressed(path, isCurrent);
  }

  /**
   * 23.10 (7.48): the compressed HD copy for a building texture, by the original PNG the route would serve
   * (`file`, a path the route computed). Its digest is remembered while the file's size and time stay.
   */
  async findBuildingTexture(file: string, isCurrent: (file: string) => Promise<boolean>): Promise<string | undefined> {
    const world = (await this.#current()).world;
    if (world.buildingPngs.size === 0) return undefined;
    let sha1: string;
    try {
      const info = await stat(file);
      const known = this.#pngDigests.get(file);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) {
        sha1 = known.sha1;
      } else {
        sha1 = createHash("sha1").update(await readFile(file)).digest("hex");
        if (this.#pngDigests.size >= DIGEST_MEMO_LIMIT) this.#pngDigests.clear();
        this.#pngDigests.set(file, { size: info.size, mtimeMs: info.mtimeMs, sha1 });
      }
    } catch {
      return undefined;
    }
    const path = world.buildingPngs.get(sha1);
    return path === undefined ? undefined : this.#findCompressed(path, isCurrent);
  }
}
