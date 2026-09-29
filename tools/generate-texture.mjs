// Publishes one client texture, keyed on its path in the archives.
//
// Model textures used to be named `{modelHash}-{index}.png`, so the same BLP was extracted,
// decoded, encoded, downloaded and uploaded to the GPU once per model that referenced it: the
// published cache held 1,092 files for 646 distinct images. Keying on the path instead means one
// file, one URL and one GPU texture per texture, however many models want it — the same thing the
// terrain layers already did.

import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blpToPng } from "./blp-png.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { stampGenerated, stampSidecar, writeFileAtomic } from "./source-stamp.mjs";
// The route's own validator, out of the build rather than copied into a ninth regex. Д6 merged six
// of these and its review found an eighth; this file held the one nobody counted, and the two
// classes had drifted far enough to matter — see `validTexturePath` below.
//
// Out of `dist/code` because that is the only import that cannot drift: the class lives in
// TypeScript the gateway compiles, and a `.mjs` copy of it would be exactly the defect being
// fixed. Nothing that runs this file can be short of a build — the gateway spawns it and the
// gateway *is* `dist/code/gateway/main.js`, `npm test` builds before it runs, and the two npm
// scripts that reach it come after `npm run build` in the README's own order.
import { validAssetPath } from "../dist/code/gateway/AssetPath.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What this generator exits with when the client simply does not hold what it was asked for.
 *
 * Any other exit code is a run that failed on its way — a decoder that threw, a chain that would
 * not open, a child that was killed — and the gateway turns the two into different status codes:
 * a missing source is a 404 the browser takes as final, everything else a 500 it retries on Т6's
 * backoff. Before this every failure of `/texture` answered 404, so one dead child cost a
 * character his legs for the life of the tab.
 *
 * `SOURCE_MISSING_EXIT` in `src/gateway/Gateway.ts` is the other half of this agreement, and
 * `npm test` asserts the two are the same number.
 */
export const SOURCE_MISSING_EXIT = 3;

/** The failure that earns that exit code: the path is well formed and the chain has no such file. */
export class SourceMissing extends Error {}

/** Stable name for a texture. Case and separators vary between references to the same file. */
export function textureId(mpqPath) {
  return createHash("sha1").update(`texture-v1\0${mpqPath.replaceAll("/", "\\").toLowerCase()}`).digest("hex");
}

export function textureDirectory() {
  return resolve(root, process.env.TEXTURE_DIR ?? "data/textures");
}

/**
 * True for a path that could name a texture inside the archives — the route's class, not a second one.
 *
 * This used to be `/^[A-Za-z0-9_ .&()\\-]{1,240}\.blp$/i`: ASCII only, no apostrophe, no forward
 * slash, capped at 240 where the route caps at 260. Measured over the 111,800 `.blp` paths this
 * dataset can ask for, 21 pass the route and were refused here — every one of them for an
 * apostrophe. Eight are boss skins (`creature\KelThuzad\Kel'Thuzad.blp`, Mal'Ganis, three Kael'thas
 * models, Sha'keer), six are achievement icons, and seven are world-map tiles for Eversong Woods,
 * Ghostlands and Hellfire, which `WorldMap.ts` fetches for a shipped feature.
 *
 * The damage was not a 400. Д6 deliberately put the apostrophe *into* the gateway's class, so the
 * route accepts these paths and hands them here, and a generator that throws a plain `Error` exits
 * 1 rather than `SOURCE_MISSING_EXIT` — which the route reads as "the generator died" and answers
 * 500, and Т6's browser-side ladder then retries three times. Measured on the live gateway before
 * this change: `Kel'Thuzad.blp` 500 in 0.52 s, `Sha'keerSkinTan.blp` 500 in 0.63 s, three doomed
 * child processes per path per session.
 */
export function validTexturePath(value) {
  return validAssetPath(value, { extensions: ["blp"] });
}

export async function publishTexture(mpqPath, archives) {
  if (!validTexturePath(mpqPath)) throw new Error(`${mpqPath} is not a usable texture path`);
  const destination = join(textureDirectory(), `${textureId(mpqPath)}.png`);
  try {
    await access(destination);
    // Published, but only counted as cached once it can say what it was published from. All 1,276
    // pictures under `data/textures` on this machine predate stamps, and the gateway only ever
    // calls a generator for a file that is *missing* — so taking "there is a file there" as the
    // whole test is what would leave them unstamped, and therefore unwatched, for good.
    await access(stampSidecar(destination));
    return { destination, cached: true };
  } catch {
    // Not published yet, or published before it carried a stamp.
  }
  const blp = await archives.read(mpqPath);
  if (!blp) throw new SourceMissing(`${mpqPath} is not in the client`);
  const png = blpToPng(blp);
  await mkdir(dirname(destination), { recursive: true });
  // Renamed into place: the texture worker and the model worker can publish the same picture at
  // once while the route is reading it (see `writeFileAtomic`).
  await writeFileAtomic(destination, png);
  // Which copy of the BLP this came from, so a module that replaces it is not served this one for
  // the rest of the machine's life: the key is the path, and the path did not change.
  await stampGenerated(destination, archives, { paths: [mpqPath] });
  return { destination, cached: false, bytes: png.length };
}

// Run directly: node tools/generate-texture.mjs "Tileset\Elwynn\ElwynnGrassBase.blp"
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const requested = process.argv.slice(2);
  if (requested.length === 0) throw new Error("Usage: node tools/generate-texture.mjs <mpq-path...>");
  const archives = await clientArchives(clientDirectory());
  try {
    let published = 0;
    for (const path of requested) {
      const result = await publishTexture(path.replaceAll("/", "\\"), archives);
      if (!result.cached) published++;
    }
    console.log(`Published ${published} of ${requested.length} textures (${requested.length - published} already cached)`);
  } catch (error) {
    // The one failure the caller can do something with, said in the only way that survives the
    // process boundary. Everything else keeps the stack and the exit code node gives it.
    if (!(error instanceof SourceMissing)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    // Closed on the way out however it went: the run before this left the chain open on a throw.
    archives.close();
  }
}
