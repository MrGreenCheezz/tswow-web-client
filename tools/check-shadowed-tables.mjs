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

import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_MEDIA_DBC_TABLES } from "./extract-visual-dbc-overlay.mjs";
import { openClientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";

const APPROVED_CLIENT_MEDIA = new Set([
  ...CLIENT_MEDIA_DBC_TABLES.map((table) => `${table}.dbc`.toLowerCase()),
]);

export function approvedClientMediaShadow(path) {
  return APPROVED_CLIENT_MEDIA.has(basename(path.replaceAll("\\", "/")).toLowerCase());
}

async function equalsDataset(chain, path, dataset) {
  if (!/^DBFilesClient\\[^\\/]+\.dbc$/i.test(path)) return false;
  try {
    const [active, built] = await Promise.all([
      chain.read(path),
      readFile(join(dataset, basename(path.replaceAll("\\", "/")))),
    ]);
    return active !== undefined && Buffer.from(active).equals(built);
  } catch {
    return false;
  }
}

/** What the gateway prints for one shadowed file. Exported so the wording is testable. */
export function shadowWarning(shadow) {
  const [winner, ...queued] = shadow.shadowedBy;
  return (
    `WARNING: ${shadow.path} is built into ${shadow.overlay}, but ${winner} outranks it in the ` +
    `WebClient archive chain, so this project's resource reads use that copy instead of the dataset build. ` +
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
      const media = shadowed.filter((shadow) => approvedClientMediaShadow(shadow.path));
      const mediaWinners = new Set(media.map((shadow) => shadow.shadowedBy[0]?.toLowerCase()));
      // The installed coordinated pack carries CreatureFamily beside its media DBCs. Tie that
      // exception to the same active source, as the full patch contract does; another archive's
      // unrelated CreatureFamily override remains actionable.
      const relatedCreatureFamily = shadowed.filter((shadow) =>
        basename(shadow.path.replaceAll("\\", "/")).toLowerCase() === "creaturefamily.dbc"
        && mediaWinners.has(shadow.shadowedBy[0]?.toLowerCase()));
      const intentional = [...media, ...relatedCreatureFamily];
      const intentionalSet = new Set(intentional);
      const candidates = shadowed.filter((shadow) => !intentionalSet.has(shadow));
      const byteIdentical = [];
      const actionable = [];
      const dataset = dbcDirectory();
      for (const shadow of candidates) {
        (await equalsDataset(chain, shadow.path, dataset) ? byteIdentical : actionable).push(shadow);
      }
      // console.warn is stderr, which is the stream the gateway relays; StormLib owns stdout here.
      if (intentional.length > 0) {
        console.warn(
          `INFO: ${intentional.length} intentional client-media override(s) outrank the dataset; `
          + "the gateway synchronized their structural profile and keeps them active.",
        );
      }
      if (byteIdentical.length > 0) {
        console.warn(
          `INFO: ${byteIdentical.length} later DBC override(s) are byte-identical to dataset/dbc; no action needed.`,
        );
      }
      for (const shadow of actionable) console.warn(shadowWarning(shadow));
      if (actionable.length > 0) {
        console.warn(
          `${actionable.length} actionable built table(s) shadowed, checked in `
          + `${Math.round(performance.now() - started)} ms`,
        );
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
