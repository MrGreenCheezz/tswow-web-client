/**
 * 22.10 (6.26): restart-stable asset generations, so a browser can keep what it loaded across sessions.
 *
 * The tile routes' `cacheGeneration` (CachePolicy.ts) carries a random per-process nonce, so every gateway
 * restart turns all of their URLs over and the browser loads them again. Character models, their animation
 * sidecars, their textures and the display/appearance answers do not need that: what they are made of is
 * named exactly by the inputs below, none of which is the process. Two generations are published in
 * `/client/patch-status` beside `cacheGeneration`:
 *
 * - `visualGeneration` — the archive chain the startup profile was selected against (the fingerprint's
 *   archive half and chain digest) plus the artifact namespaces of `/visual/*` and `/texture`. Every byte
 *   those routes serve is generated from those archives under those namespaces; an archive change after
 *   startup latches the routes into 409 until a restart (`isClientVisualProfileRoute`), and the restart
 *   publishes the new value. A URL that carries `vg=<visualGeneration>` is answered `immutable`.
 * - `metadataGeneration` — the gateway's own code (a digest of its compiled modules, since these answers are
 *   built in memory by it), the dataset's DBC half (`DatasetFingerprint.dbcHash`, which also covers the item
 *   and creature dumps and the visual DBC overlay) and the visual generation. A URL that carries
 *   `mg=<metadataGeneration>` is answered `immutable`; the browser also keys its persistent display rows on it.
 *
 * Without a client directory (no archive walk) there is no visual generation and nothing is promised: the
 * routes answer exactly as before. Each value is 20 hex characters, inside GatewayGeneration.ts's shape.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMMUTABLE, REVALIDATE } from "./CachePolicy.js";

/** Bumped when what a generation covers changes, so no old value can ever equal a new one. */
export const ASSET_GENERATION_SCHEMA = "asset-generation-1";

/** The query parameter a visual asset URL carries (`/visual/model`, `/visual/animations`, `/visual/doodads`, `/texture`). */
export const VISUAL_GENERATION_PARAM = "vg";
/** The query parameter a metadata URL carries (`/dbc/character-appearance`). */
export const METADATA_GENERATION_PARAM = "mg";

const LENGTH = 20;

function digest(parts: readonly string[]): string {
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, LENGTH);
}

export interface VisualGenerationInput {
  /** `DatasetFingerprint.archivesHash` of the startup walk; undefined without a client. */
  readonly archivesHash: string | undefined;
  /** `DatasetFingerprint.chain`. */
  readonly chain: string | undefined;
  /** The artifact namespaces the routes hash their files under (`visual-v24`, `visual-wmo-v27`, `texture-v1`). */
  readonly namespaces: readonly string[];
  /** Whether the coordinated visual DBC/geoset corrections are on (a startup choice). */
  readonly coordinatedVisuals: boolean;
}

/** The visual generation, or undefined when there is no archive walk to vouch for the bytes. */
export function visualGeneration(input: VisualGenerationInput): string | undefined {
  if (input.archivesHash === undefined) return undefined;
  return digest([ASSET_GENERATION_SCHEMA, "visual", `archives:${input.archivesHash}`, `chain:${input.chain ?? "none"}`,
    `coordinated:${input.coordinatedVisuals ? 1 : 0}`, ...[...input.namespaces].sort()]);
}

export interface MetadataGenerationInput {
  readonly codeIdentity: string;
  /** `DatasetFingerprint.dbcHash` as it stands for this request; undefined without a dataset walk. */
  readonly dbcHash: string | undefined;
  readonly visualGeneration: string | undefined;
}

/** The metadata generation, or undefined when either half is unknown. */
export function metadataGeneration(input: MetadataGenerationInput): string | undefined {
  if (input.dbcHash === undefined || input.visualGeneration === undefined) return undefined;
  return digest([ASSET_GENERATION_SCHEMA, "metadata", `code:${input.codeIdentity}`, `dbc:${input.dbcHash}`,
    `visual:${input.visualGeneration}`]);
}

/**
 * `cache-control` for an answer whose URL named generation `requested`: immutable only when it is the one
 * this process serves (and there is one); otherwise the route's own `fallback`.
 */
export function assetCacheControl(requested: string | null, current: string | undefined, fallback: string): string {
  return current !== undefined && requested === current ? IMMUTABLE : fallback;
}

/** The revalidated lifetime file routes keep for a URL without (or with another) `vg`. */
export const FILE_FALLBACK = REVALIDATE;

/** The code directories whose modules build the gateway's in-memory answers, relative to the code root. */
const CODE_DIRECTORIES = ["gateway", "world", "generated", "protocol"] as const;
const CODE_FILE = /\.(?:js|mjs|cjs|ts|json)$/;

/**
 * A digest of the gateway's code: every module file directly in the code directories, by name and bytes.
 * Read once per process (memoised); `root` is for tests. Unreadable directories count as empty.
 */
export function gatewayCodeIdentity(root?: string): Promise<string> {
  if (root === undefined) return defaultIdentity ??= computeCodeIdentity(dirname(dirname(fileURLToPath(import.meta.url))));
  return computeCodeIdentity(root);
}

let defaultIdentity: Promise<string> | undefined;

/** Files under `directory`, recursively, as sorted `/`-separated relative paths; `node_modules` and dot-entries skipped. */
async function listTree(directory: string): Promise<string[] | undefined> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  try {
    await walk("");
  } catch {
    return undefined;
  }
  return found.sort();
}

/** Files hashed by bytes above this size are hashed by size and mtime instead (no such file in `tools/` today). */
const MAX_HASHED_SCRIPT_BYTES = 4 * 1024 * 1024;

/**
 * 25.10 (serve S2): a digest of the generator tree (`tools/` — the scripts that publish the tile caches and
 * everything they load: `tools/dbd/*.dbd`, `tools/lua-wasm/`, …), recursively, by path and bytes; for
 * CachePolicy.ts `servedIdentity`. An unreadable directory is "none". Review fix: was the top level only.
 */
export async function scriptDirectoryIdentity(directory: string): Promise<string> {
  const hash = createHash("sha1").update(`${ASSET_GENERATION_SCHEMA}\0scripts-tree`);
  const files = await listTree(directory);
  if (files === undefined) return "none";
  for (const path of files) {
    try {
      const full = join(directory, path);
      const stats = await stat(full);
      if (stats.size > MAX_HASHED_SCRIPT_BYTES) {
        hash.update(`\0${path}\0${stats.size}\0${stats.mtimeMs}\0`);
        continue;
      }
      const bytes = await readFile(full);
      hash.update(`\0${path}\0${bytes.length}\0`).update(bytes);
    } catch {
      // Gone between the listing and the read: as if it had not been listed.
    }
  }
  return hash.digest("hex").slice(0, LENGTH);
}

/**
 * 25.10 (serve S2, review fix): a digest of a data tree by path, size and modification time — the extracted
 * `maps/` and `vmaps/` that `/terrain` and the vmap routes serve raw, which no fingerprint half covers. Taken
 * once at startup (a re-extraction in a running process is a dataset build, which moves the DBC half anyway).
 * Stats run 64 at a time. An unreadable directory is "none".
 */
export async function statTreeIdentity(directory: string): Promise<string> {
  const files = await listTree(directory);
  if (files === undefined) return "none";
  const lines: string[] = new Array(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const index = next++;
      const path = files[index]!;
      try {
        const stats = await stat(join(directory, path));
        lines[index] = `${path}|${stats.size}|${stats.mtimeMs}`;
      } catch {
        lines[index] = `${path}|gone`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, files.length) }, worker));
  return createHash("sha1").update(`${ASSET_GENERATION_SCHEMA}\0stat-tree\n${lines.join("\n")}`).digest("hex").slice(0, LENGTH);
}

/**
 * 25.10 (serve S2, review fix): the installed packages the gateway and the generators import (three, pngjs,
 * fflate, …), named by the lock file's bytes; "none" without one.
 */
export async function lockfileIdentity(file: string): Promise<string> {
  try {
    return createHash("sha1").update(await readFile(file)).digest("hex").slice(0, LENGTH);
  } catch {
    return "none";
  }
}

async function computeCodeIdentity(root: string): Promise<string> {
  const hash = createHash("sha1").update(ASSET_GENERATION_SCHEMA);
  for (const directory of CODE_DIRECTORIES) {
    let names: string[];
    try {
      names = (await readdir(join(root, directory), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && CODE_FILE.test(entry.name)).map((entry) => entry.name).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(root, directory, name));
      } catch {
        continue;
      }
      hash.update(`\0${directory}/${name}\0${bytes.length}\0`).update(bytes);
    }
  }
  return hash.digest("hex").slice(0, LENGTH);
}
