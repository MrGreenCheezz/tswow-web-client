// Publishes one client interface file — Lua, XML, TOC or TTF — byte for byte, keyed on its path in
// the archives.
//
// Everything else this repository extracts is a *conversion*: a BLP becomes a PNG, an M2 becomes a
// WVM, an ADT becomes a tile. This one converts nothing, and that is the point of it. The GlueXML
// runtime the next slices build has to execute the files the game itself executes, which on the
// owner's server are not Blizzard's: `patch-ruRU-F.MPQ` is a directory pointed at
// `LoginScreenModule/assets`, and its `Interface\GlueXML\AccountLogin.{xml,lua}` and `GlueXML.toc`
// override the ones inside `locale-ruRU.MPQ`. Measured on this client with the chain this repo
// already ranks (`tools/mpq.mjs`): `Interface\GlueXML\GlueXML.toc` and `AccountLogin.lua` resolve to
// `patch-ruRU-F.MPQ`, `CharacterCreate.lua` to tswow's own `patch-ruRU-A.MPQ`, and nothing to the
// stock archives — so a route that opened `locale-ruRU.MPQ` directly would run the wrong login
// screen and there would be no error anywhere to say so.
//
// The cost of a miss is process start and opening the chain — the same ~285 ms `generate-sound.mjs`
// measured, of which the reading itself is under a millisecond for a file this size. Unlike a sound
// kit there is no row to publish a batch from: a `.toc` names the files that follow it, and reading
// that list is the runtime's job, not this tool's, because a Lua file may also be `Include`d from
// XML that has not been fetched yet.

import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { stampGenerated, stampSidecar } from "./source-stamp.mjs";
// The route's own validator, out of the build rather than copied into a second regex — the same
// arrangement `generate-texture.mjs` documents, and for the same reason: a class that lives in two
// places drifts, and the drift shows up as a 400 on a file the client really ships.
import { validAssetPath } from "../dist/code/gateway/AssetPath.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What this generator exits with when the chain does not hold what it was asked for.
 *
 * `SOURCE_MISSING_EXIT` in `src/gateway/Gateway.ts` is the other half of the agreement and the
 * tests pin the two together. A missing GlueXML file is a 404 the runtime takes as final — a `.toc`
 * lists optional files and the loader must be able to move past one — while a child that died is a
 * 500 it retries, and answering 404 for both would silently drop half a login screen.
 */
export const SOURCE_MISSING_EXIT = 3;

/** The failure that earns that exit code: the path is well formed and the chain has no such file. */
export class SourceMissing extends Error {}

/**
 * The four extensions the interface is made of.
 *
 * Deliberately not «any text file in the archives»: this route reads whatever the chain resolves,
 * including a module author's own patch directory, and the narrow list is what keeps it from
 * becoming a way to pull a DBC, a map or somebody's `realmlist.wtf` out of a client over HTTP.
 * BLP art already has `/texture` and models already have `/visual/model`, so nothing an interface
 * needs is missing from the set.
 */
export const CLIENT_FILE_EXTENSIONS = ["lua", "xml", "toc", "ttf"];

/** Stable name for one client file. Case and separators vary between references to the same file. */
export function clientFileId(mpqPath) {
  return createHash("sha1").update(`client-file-v1\0${mpqPath.replaceAll("/", "\\").toLowerCase()}`).digest("hex");
}

export function clientFileDirectory() {
  return resolve(root, process.env.CLIENT_FILE_DIR ?? "data/client-files");
}

/** True for a path that could name an interface file inside the archives. */
export function validClientFilePath(value) {
  return validAssetPath(value, { extensions: CLIENT_FILE_EXTENSIONS });
}

/**
 * Publishes one file under the cache's own name, with the extension kept.
 *
 * The extension rides on the filename rather than being recovered from the request because the
 * cache is also read by hand and by `restamp`: a directory of forty-character hashes with no
 * suffix says nothing about what is in it, and the four kinds here are served with two different
 * content types.
 */
export async function publishClientFile(mpqPath, archives) {
  const path = mpqPath.replaceAll("/", "\\");
  if (!validClientFilePath(path)) throw new Error(`${mpqPath} is not a usable client file path`);
  const destination = join(clientFileDirectory(), `${clientFileId(path)}${extname(path).toLowerCase()}`);
  try {
    await access(destination);
    // Published, and able to say what it was published from. A stampless entry is republished so
    // that it gains one: this family is new, so in practice that only happens to a cache written by
    // a build that crashed between the two writes.
    await access(stampSidecar(destination));
    return { destination, cached: true };
  } catch {
    // Not published yet, or published before its stamp was written.
  }
  const data = await archives.read(path);
  if (!data) throw new SourceMissing(`${path} is not in the client`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, data);
  // Which copy of it this came from. The key is the path and the path does not change when a module
  // drops a replacement into its patch directory, so without this the owner would edit
  // `AccountLogin.lua`, reload, and be served the copy from before the edit for the life of the
  // machine — which is precisely the workflow this route exists to support.
  await stampGenerated(destination, archives, { paths: [path] });
  return { destination, cached: false, bytes: data.length };
}

// Run directly: node tools/generate-client-file.mjs "Interface\GlueXML\GlueXML.toc"
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const requested = process.argv.slice(2);
  if (requested.length === 0) throw new Error("Usage: node tools/generate-client-file.mjs <mpq-path...>");
  const archives = await clientArchives(clientDirectory());
  try {
    let published = 0;
    for (const path of requested) {
      const result = await publishClientFile(path, archives);
      if (!result.cached) published++;
    }
    console.log(`Published ${published} of ${requested.length} client files (${requested.length - published} already cached)`);
  } catch (error) {
    // The one failure the caller can act on, said in the only way that survives the process
    // boundary. Everything else keeps its stack and the exit code node gives it.
    if (!(error instanceof SourceMissing)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
}
