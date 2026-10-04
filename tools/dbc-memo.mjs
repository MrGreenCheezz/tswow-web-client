// A table read once per version of its file, for the long-lived generator worker (10.20).
//
// A generator run as its own process opened its DBC on every run. Inside `tools/asset-worker.mjs`
// the same code would either re-read the table per job (ItemDisplayInfo is read for every icon) or,
// cached naively, go on answering out of the table as it was when the worker started — after a
// `build data` that is a stale icon under a fresh stamp. So the cache key is the file itself: path,
// size, modification time and inode, taken by one `stat` per job. The gateway also recycles the
// workers when its dataset poll sees the DBCs change (`onDatasetChanged`), so this is the second of
// two guards rather than the only one.

import { stat } from "node:fs/promises";

const memo = new Map();

/** `build()`'s value for `file` as it is now; rebuilt whenever the file's identity changes. */
export async function memoByFile(file, build) {
  const info = await stat(file, { bigint: true });
  const key = `${info.size}:${info.mtimeNs}:${info.ino}`;
  const hit = memo.get(file);
  if (hit && hit.key === key) return hit.value;
  const value = await build();
  memo.set(file, { key, value });
  return value;
}

/** For tests. */
export function forgetMemoisedFiles() {
  memo.clear();
}
