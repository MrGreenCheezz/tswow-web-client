/**
 * Serving a published cache file with a validator taken from `stat`, not from its bytes (10.21 a,
 * mechanism М-A10-2).
 *
 * `respondRevalidated` read the whole file and hashed it with SHA-1 on every request, including the
 * ones it then answered 304: a 304 for HumanMale's 9.4 MB animation sidecar cost 8.8 ms of the
 * gateway's one thread (WORK_PLAN 10.21). The tag here is size, modification time in nanoseconds
 * and the file's index number, read from the open handle; a 304 never reads the file.
 *
 * - The index number catches a replacement by rename (every publisher writes a temporary file and
 *   renames it over the old one) that happens to keep the size and the timestamp.
 * - The `.src` stamp beside the file is deliberately *not* part of the tag: `tools/restamp.mjs`
 *   rewrites only the stamp, and a tag that moved with it would cost every browser a full download
 *   of bytes that did not change.
 * - The tag and the body come from the same open handle, so a file replaced between the two is
 *   never served under the other file's tag.
 */

import { open, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { etagMatches } from "./CachePolicy.js";

/** Bumped when the layout changes, so an old browser copy never matches a new tag by accident. */
export const FILE_TAG_SCHEMA = "e1";

/** The strong validator of one file version: `"e1-<size>-<mtimeNs>[-<ino>]"`, all hex. */
export function fileEtag(stats: Pick<BigIntStats, "size" | "mtimeNs" | "ino">): string {
  const parts = [FILE_TAG_SCHEMA, stats.size.toString(16), stats.mtimeNs.toString(16)];
  if (stats.ino !== 0n) parts.push(stats.ino.toString(16));
  return `"${parts.join("-")}"`;
}

export interface FileResponseOptions {
  readonly origin: string | undefined;
  readonly contentType: string;
  /** Run once when the file is missing, then the file is opened again (a generator). */
  readonly rebuild?: (() => Promise<unknown>) | undefined;
  /** Injectable for tests: how the file is opened. */
  readonly open?: (filename: string) => Promise<FileHandle>;
}

async function openOrRebuild(filename: string, options: FileResponseOptions): Promise<FileHandle> {
  const opener = options.open ?? ((name: string) => open(name, "r"));
  try {
    return await opener(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.rebuild) throw error;
    await options.rebuild();
    return opener(filename);
  }
}

/**
 * Answers one GET for `filename`: 304 when `If-None-Match` names the current tag (the file is
 * opened and `fstat`ed, never read), otherwise 200 with the bytes. Revalidating cache headers
 * (`max-age=0, must-revalidate`) as before; throws what opening or reading throws, before any
 * header is written, so the caller's error mapping (404 against 500) is unchanged.
 */
export async function respondFile(
  request: IncomingMessage, response: ServerResponse, filename: string, options: FileResponseOptions,
): Promise<void> {
  const handle = await openOrRebuild(filename, options);
  try {
    const etag = fileEtag(await handle.stat({ bigint: true }));
    const headers = {
      ...(options.origin ? { "access-control-allow-origin": options.origin } : {}),
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": options.contentType,
      etag,
    };
    if (etagMatches(request.headers["if-none-match"], etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    const data = await handle.readFile();
    response.writeHead(200, { ...headers, "content-length": data.byteLength });
    response.end(data);
  } finally {
    await handle.close();
  }
}
