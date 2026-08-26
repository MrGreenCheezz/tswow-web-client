// Which of the tables tswow built the game client will not actually read.
//
// A patch directory is where a module's work lands, and it is not the top of the chain: an archive
// with a later letter beats it, and on this machine two do — `patch-ruRU-E.MPQ` and
// `patch-ruRU-D.MPQ` each carry `DBFilesClient\GameObjectDisplayInfo.dbc`, so E wins it from
// tswow's own build. That is invisible from every direction. The gateway reads its DBCs out of
// `dataset/dbc` and is unaffected; the game client reads the archive and shows the stale table; and
// a module author is left with a gameobject display that exists in the database, exists in the
// dataset, and does not exist in the game. So it is said out loud, once, at startup.
//
// It is a script rather than a few lines inside the gateway because reading an archive means
// StormLib's WebAssembly build, and Emscripten's heap only grows. Measured on this machine:
// importing `tools/mpq.mjs` takes the process from 34.5 to 43.6 MB of RSS, opening the chain takes
// it to 94.2, and `close()` gives back 0.1 of that — the heap goes from 16,777,216 to 60,424,192
// bytes in seven resizes and is never returned. A gateway that runs for days would hold ~62 MB for
// one line printed once. Here it dies with the process — 221 to 230 ms of work, 340 ms from the
// gateway's spawn to this process's exit — and StormLib's own chatter, "Initialized StormLib in
// debug mode" and one line per heap resize, all of it on stdout, dies with it too instead of
// landing in the middle of the gateway's log.
//
//   node tools/check-shadowed-tables.mjs [<client directory>] [--all]

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openClientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

/** What the gateway prints for one shadowed file. Exported so the wording is testable. */
export function shadowWarning(shadow) {
  const [winner, ...queued] = shadow.shadowedBy;
  return (
    `WARNING: ${shadow.path} is built into ${shadow.overlay}, but ${winner} outranks it in the ` +
    `client's archive chain, so the game client reads that copy and not the one the dataset built. ` +
    // Naming only the winner is what makes an operator's first repair the wrong one: taking the top
    // archive out promotes the next one carrying the path, which on this machine is an older copy
    // of the same table. Every one of them has to go, and the message says so up front.
    (queued.length === 0
      ? `Move ${winner} out of Data to put the module's table back in play.`
      : `Behind it, in order: ${queued.join(", ")} — each wins the path the moment the one above it ` +
        `goes, so all ${shadow.shadowedBy.length} have to leave Data before the module's copy is ` +
        `what the client reads.`));
}

// Run directly: the gateway spawns it, and it is worth running by hand after a build.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const started = performance.now();
  try {
    const directory = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? clientDirectory();
    // `DBFilesClient\` by default: it is the subtree where a shadow is silent — art that loses is
    // at least visible — and it is 245 of the 798 files here rather than all of them.
    const prefix = process.argv.includes("--all") ? "" : "DBFilesClient\\";
    const chain = await openClientArchives(directory);
    try {
      const shadowed = await chain.shadowedOverlayFiles(prefix);
      // console.warn is stderr, which is the stream the gateway relays; StormLib owns stdout here.
      for (const shadow of shadowed) console.warn(shadowWarning(shadow));
      if (shadowed.length > 0) {
        console.warn(`${shadowed.length} built table(s) shadowed, checked in ${Math.round(performance.now() - started)} ms`);
      }
    } finally {
      chain.close();
    }
  } catch (error) {
    // The reason only, with no stack and no prefix of its own: the gateway prints it behind "Not
    // checking the archive chain for shadowed tables", and StormLib's own rethrow would otherwise
    // put a WebAssembly stack trace in a log that is about a missing directory.
    console.warn(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
