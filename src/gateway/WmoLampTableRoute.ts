/**
 * 24.10 (7.50): `GET /visual/wmo-lamps?path=<WMO path>&v=1` — one building's lamp table
 * (`src/world/WmoLampTable.ts`): the lantern centres of its open-air groups, so the browser lights a
 * city's lamp posts as soon as the building's root is in, before its groups arrive.
 *
 * Built lazily from the WWM artifact `/visual/model` already published (`<hash>.bin` and its
 * `<hash>.gNNN.bin` groups), on the first request for a model, and kept beside it as
 * `<hash>.lamps.json`; nothing is regenerated and the WMO artifact's version does not move. The kept
 * table is used while it is newer than the root it was read from — a republished root (a patch, a
 * cache namespace bump) is read again. Building it reads only the open-air groups and yields the event
 * loop between them, so a city's first table does not hold other requests for its whole read.
 *
 * Shape of the answers, like its siblings: Origin refused 403; a wrong `v` or `path` 400 (with CORS);
 * a model the client does not ship 404; a failed read 500, which the browser retries; a hit 200, kept
 * for good when the URL names the current visual generation (`vg=`, AssetGeneration.ts). A gateway
 * older than this route answers 404 from its fallback, which the browser reads as "no table" and lights
 * the lamp posts as their groups arrive, as before (`WmoLampTableClient.ts`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { respondFile } from "./FileResponse.js";
import { originAllowed } from "./UpgradeGuard.js";
import { WMO_LAMP_TABLE_ROUTE, WMO_LAMP_TABLE_VERSION, buildWmoLampTable } from "../world/WmoLampTable.js";

export { WMO_LAMP_TABLE_ROUTE } from "../world/WmoLampTable.js";

export interface WmoLampTableRouteOptions {
  readonly visualModelsDirectory: string;
  readonly allowedOrigins: readonly string[];
  /** The `/visual/model` rules for a path (`validVisualModelPath`). */
  readonly validPath: (path: string) => boolean;
  /** The artifact's name (`visualModelHash`). */
  readonly hash: (path: string) => string;
  /** Publishes the model's artifact on its lane (`generateVisualModel`); absent: a missing artifact is a 404. */
  readonly generate?: ((path: string, hash: string) => Promise<void>) | undefined;
  /** Drops a stale root (the dataset fingerprint), before it is read. */
  readonly ensureCurrent?: ((file: string) => Promise<void>) | undefined;
  /** Whether a failure means the model is not in the client (404) rather than a failed read (500). */
  readonly absent: (error: unknown) => boolean;
  readonly cacheControl: (requestedGeneration: string | null) => string;
}

/** Tables being built, by artifact: concurrent requests for one city share one read. */
export type WmoLampTableBuilds = Map<string, Promise<void>>;

/** Milliseconds the last table built took, for the tests and the log. */
export const wmoLampTableStats = { builds: 0, lastMs: 0, lastGroups: 0 };

function refuse(response: ServerResponse, status: number, origin: string | undefined): void {
  response.writeHead(status, origin ? { "access-control-allow-origin": origin } : {}).end();
}

async function mtime(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const arrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * Reads the root and its groups and writes `<hash>.lamps.json`. A root without one of its group files is a
 * half-published artifact: it is published again, once, and read from the start.
 */
async function buildTable(directory: string, hash: string, rootFile: string, tableFile: string,
  regenerate: (() => Promise<void>) | undefined): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await buildOnce(directory, hash, rootFile, tableFile);
      return;
    } catch (error) {
      if (attempt > 0 || !regenerate || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await regenerate();
    }
  }
}

async function buildOnce(directory: string, hash: string, rootFile: string, tableFile: string): Promise<void> {
  const started = performance.now();
  const before = await stat(rootFile);
  const root = await readFile(rootFile);
  const groupFile = (index: number) => join(directory, `${hash}.g${String(index).padStart(3, "0")}.bin`);
  const table = await buildWmoLampTable(arrayBuffer(root), async (index) => arrayBuffer(await readFile(groupFile(index))),
    () => yieldLoop());
  const data = JSON.stringify(table);
  const after = await stat(rootFile);
  if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
    // Read across a republish: not kept; the page's retry reads the new artifact.
    throw Object.assign(new Error("WMO artifact changed while its lamp table was read"), { code: "EAGAIN" });
  }
  const temporary = `${tableFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data);
  try {
    await rename(temporary, tableFile);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  wmoLampTableStats.builds++;
  wmoLampTableStats.lastMs = performance.now() - started;
  wmoLampTableStats.lastGroups = table.groups.length;
}

/** Answers `/visual/wmo-lamps`; false leaves every other path to the rest of the gateway. */
export async function serveWmoLampTableRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  builds: WmoLampTableBuilds,
  options: WmoLampTableRouteOptions,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== WMO_LAMP_TABLE_ROUTE) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const path = (url.searchParams.get("path") ?? "").replaceAll("/", "\\");
  if (url.searchParams.get("v") !== String(WMO_LAMP_TABLE_VERSION) || !options.validPath(path)
    || !path.toLowerCase().endsWith(".wmo")) {
    refuse(response, 400, origin);
    return true;
  }
  const directory = options.visualModelsDirectory;
  const hash = options.hash(path);
  // Only the hash names a file: the request's text never reaches a path.
  const rootFile = join(directory, `${hash}.bin`);
  const tableFile = join(directory, `${hash}.lamps.json`);
  const regenerate = options.generate ? () => options.generate!(path, hash) : undefined;
  try {
    await options.ensureCurrent?.(rootFile);
    let rootTime = await mtime(rootFile);
    if (rootTime === undefined) {
      if (!regenerate) throw Object.assign(new Error("no artifact"), { code: "ENOENT" });
      await regenerate();
      rootTime = await mtime(rootFile);
      if (rootTime === undefined) throw Object.assign(new Error("no artifact"), { code: "ENOENT" });
    }
    const tableTime = await mtime(tableFile);
    if (tableTime === undefined || tableTime < rootTime) {
      let build = builds.get(hash);
      if (!build) {
        build = buildTable(directory, hash, rootFile, tableFile, regenerate).finally(() => builds.delete(hash));
        builds.set(hash, build);
      }
      await build;
    }
    await respondFile(request, response, tableFile, {
      origin, contentType: "application/json; charset=utf-8",
      cacheControl: options.cacheControl(url.searchParams.get("vg")),
    });
  } catch (error) {
    if (!response.headersSent) refuse(response, options.absent(error) ? 404 : 500, origin);
  }
  return true;
}
