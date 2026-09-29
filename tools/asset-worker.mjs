// A long-lived generator for the two families a zone asks for by the hundred: client textures and
// visual models.
//
// Every other miss in the gateway is a child process of its own, and for these two that was the
// whole cost. Measured on this machine (2026-09-28): a cold texture published by its own process
// takes a median 387 ms, of which ~45 ms is starting node and 181–192 ms is opening the thirty
// sources of the archive chain again; the same texture out of a chain that is already open takes
// 18 ms. A doodad model is 9–25 ms against ~450 ms, HumanMale 265 ms against 679 ms. On the owner's
// session of that evening the texture lane published one picture every 412 ms and ran for 226 s
// without a pause on arriving in Dalaran — 534 pictures, most of them NPCs a player was standing
// next to as capsules.
//
// So this process opens the chain once and takes jobs over the IPC channel `fork` gives it, one at
// a time, in the order they come. It never decides to stop by itself: the gateway
// (`src/gateway/AssetWorker.ts`) owns its lifetime — it retires it when it has been idle for a
// while, so the archives are not held open between visits, after a number of jobs or once its
// memory has grown (StormLib's WebAssembly heap only ever grows), and whenever the client's
// archives change under it. A decision taken on this side would race a job already on its way.
//
// Protocol, one JSON message each way per job:
//   → { id, kind: "texture", path }            publishTexture(path)
//   → { id, kind: "visual-model", path, hash }  publishVisualModel(path, hash)
//   ← { id, ok: true, rss }
//   ← { id, ok: false, missing, message, rss } `missing` is "the archives do not hold this"
// `missing` is what `SOURCE_MISSING_EXIT` is for a one-shot generator: the one failure the gateway
// answers 404 instead of 500.

import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { publishTexture, SourceMissing } from "./generate-texture.mjs";
import { publishVisualModel } from "./generate-visual-model.mjs";

if (typeof process.send !== "function") {
  throw new Error("tools/asset-worker.mjs is started by the gateway with an IPC channel, not by hand");
}

/** The chain, opened on the first job rather than at start so a spawn that is never used is free. */
let archives;
let queue = Promise.resolve();

process.on("message", (job) => {
  queue = queue.then(() => run(job));
});

// The gateway went away (closed, crashed or retired this worker): nothing is left to answer to.
process.on("disconnect", () => {
  try {
    archives?.close();
  } finally {
    process.exit(0);
  }
});

async function run(job) {
  const id = job?.id;
  try {
    archives ??= await clientArchives(clientDirectory());
    if (job.kind === "texture") await publishTexture(String(job.path).replaceAll("/", "\\"), archives);
    else if (job.kind === "visual-model") await publishVisualModel(String(job.path), String(job.hash), archives);
    else throw new Error(`Unknown asset job ${String(job?.kind)}`);
    reply({ id, ok: true });
  } catch (error) {
    reply({
      id,
      ok: false,
      missing: error instanceof SourceMissing,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function reply(message) {
  // The channel can close between the job and its answer when the gateway is shutting down.
  if (!process.connected) return;
  process.send({ ...message, rss: process.memoryUsage().rss });
}
