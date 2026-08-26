import { startGateway } from "./Gateway.js";
import { parseCharacterTextures } from "./CharacterTextures.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

function port(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * The generators are plain .mjs run before anything is compiled, so the machine's layout lives in
 * tools/paths.mjs and the gateway borrows it rather than keeping a second copy that can drift —
 * which is exactly what happened before: DBC_DIR moved the gateway's reads and left every
 * generator on the old dataset. The gateway already resolves all its other defaults against the
 * working directory, and start-gateway.bat cds here first.
 */
interface MachinePaths {
  clientDirectory(): string;
  dbcDirectory(): string;
  mapsDirectory(): string;
  vmapsDirectory(): string;
  interfaceDirectory(): string;
  moduleDirectories(): { root: string; inner: string; source: string }[];
}
const paths = await import(pathToFileURL(resolve(process.cwd(), "tools/paths.mjs")).href) as MachinePaths;

const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (host !== "127.0.0.1" && host !== "localhost" && allowedOrigins.includes("*")) {
  console.warn(
    `WARNING: the gateway is listening on ${host} and accepts any Origin, so anyone who can reach ` +
    `port ${port("GATEWAY_PORT", 8090)} gets an unauthenticated pipe to the auth and world servers. ` +
    `Set ALLOWED_ORIGINS to the page's real origin, and keep the port off the public internet.`);
}

/**
 * The client is only wanted here for its fingerprint: which archives and patch directories exist
 * and what is in them. A machine with no client still serves everything the dataset answers, so a
 * missing one costs the archive half of the watch rather than the process.
 */
let clientDirectory: string | undefined;
try {
  clientDirectory = paths.clientDirectory();
} catch (error) {
  console.warn(`Not watching the client archives: ${error instanceof Error ? error.message : String(error)}`);
}

const gateway = await startGateway({
  host,
  port: port("GATEWAY_PORT", 8090),
  auth: {
    host: process.env.AUTH_HOST ?? "127.0.0.1",
    port: port("AUTH_PORT", 3724),
  },
  world: {
    host: process.env.WORLD_HOST ?? "127.0.0.1",
    port: port("WORLD_PORT", 8085),
  },
  allowedOrigins,
  mapsDirectory: paths.mapsDirectory(),
  vmapsDirectory: paths.vmapsDirectory(),
  dbcDirectory: paths.dbcDirectory(),
  ...(clientDirectory === undefined ? {} : { clientDirectory }),
  creatureMetadataFile: process.env.CREATURE_METADATA_FILE ?? resolve(process.cwd(), "data/creatures.json"),
  itemMetadataFile: process.env.ITEM_METADATA_FILE ?? resolve(process.cwd(), "data/items.json"),
  itemIconsDirectory: process.env.ITEM_ICON_DIR ?? resolve(process.cwd(), "data/item-icons"),
  generateItemIcon: (displayId) => runAssetGenerator("generate-item-icon.mjs", [String(displayId)]),
  // `public/`, not `data/`: these two were filled by `build-assets.bat` and served beside the page
  // long before there was a route for them, and the whole point of the route is that what is
  // already published costs nothing. The env names match the generator's own.
  spellIconsDirectory: process.env.SPELL_ICON_DIR ?? resolve(process.cwd(), "public/icons"),
  generateSpellIcon: (iconId) => runAssetGenerator("generate-spell-icons.mjs", [String(iconId)]),
  creatureIconsDirectory: process.env.CREATURE_ICON_DIR ?? resolve(process.cwd(), "public/creature-icons"),
  generateCreatureIcon: (familyId) => runAssetGenerator("generate-spell-icons.mjs", ["--family", String(familyId)]),
  // Everything published before stamps existed — 23,025 of the 24,796 files under `data/` on this
  // machine, plus 3,204 icons in `public/` — gets one here, in two passes started once when the
  // gateway comes up and never on a request path. `tools/restamp.mjs` walks `data/` and derives
  // each entry's stamp from the inputs its own name names, rendering nothing; the icon pass does
  // the two directories in `public/`, where a 2 KB picture is cheap enough to prove as well. Their
  // stderr is relayed because that is where each of them says what it did — StormLib writes its
  // own startup banner and every heap resize to the children's stdout.
  restampCaches: async () => {
    // One after the other so that two processes are not on the archives at once, but neither is
    // the other's precondition: a `data/` that cannot be written must not cost `public/` its
    // stamps, and both failures are worth hearing rather than only the first.
    const failures: string[] = [];
    for (const [script, args, label] of [
      ["restamp.mjs", [], "Stamping the published cache"],
      ["generate-spell-icons.mjs", ["--restamp"], "Stamping the published icons"],
    ] as const) {
      try {
        await runAssetGenerator(script, [...args], label);
      } catch (error) {
        failures.push(`${label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
  },
  buildingsDirectory: process.env.BUILDINGS_DIR ?? paths.vmapsDirectory(),
  terrainTexturesDirectory: process.env.TERRAIN_TEXTURE_DIR ?? resolve(process.cwd(), "data/terrain-textures"),
  terrainLayersDirectory: process.env.TERRAIN_LAYER_DIR ?? resolve(process.cwd(), "data/terrain-layers"),
  generateTerrainTexture: (map, gridX, gridY) => runAssetGenerator("generate-terrain-tile.mjs", [String(map), String(gridX), String(gridY)]),
  generateTerrainSplat: (map, gridX, gridY) => runAssetGenerator("generate-terrain-splat.mjs", [String(map), String(gridX), String(gridY)]),
  visualTilesDirectory: process.env.VISUAL_TILE_DIR ?? resolve(process.cwd(), "data/visual-tiles"),
  generateVisualTile: (map, gridX, gridY) => runAssetGenerator("generate-visual-tile.mjs", [String(map), String(gridX), String(gridY)]),
  visualModelsDirectory: process.env.VISUAL_MODEL_DIR ?? resolve(process.cwd(), "data/visual-models"),
  horizonDirectory: process.env.HORIZON_DIR ?? resolve(process.cwd(), "data/horizon"),
  generateHorizon: (map) => runAssetGenerator("generate-horizon.mjs", [String(map)]),
  generateVisualModel: (path, hash) => runAssetGenerator("generate-visual-model.mjs", [path, hash]),
  texturesDirectory: process.env.TEXTURE_DIR ?? resolve(process.cwd(), "data/textures"),
  // World map art is asked for a tile at a time and is only ever wanted a whole picture at a
  // time — twelve for a zone, plus one to four for each exploration overlay painted over it. Sent
  // to the ordinary generator that is forty processes each opening twenty-two archives; sent here
  // the first miss publishes the whole run and the rest are already on disk.
  generateTexture: (path) => runAssetGenerator(
    path.replaceAll("/", "\\").toLowerCase().startsWith("interface\\worldmap\\")
      ? "generate-worldmap-art.mjs"
      : "generate-texture.mjs",
    [path],
  ),
  // Only on a machine that has a client: without one there is nothing to list, and the gateway
  // must then behave exactly as it did before Т7 — both spellings offered, the gendered one first.
  ...(clientDirectory === undefined ? {} : { listCharacterTextures }),
  minimapDirectory: process.env.MINIMAP_DIR ?? resolve(process.cwd(), "data/minimap"),
  generateMinimapIndex: (map) => runAssetGenerator("generate-minimap-index.mjs", [String(map)]),
  soundDirectory: process.env.SOUND_DIR ?? resolve(process.cwd(), "data/sound"),
  // One path in, a whole `SoundEntries` row out. The generator does nothing but read and write, so
  // every millisecond of a miss is process start and the twenty-two archives; a footstep kit asked
  // for a file at a time would pay that five times for two milliseconds of reading.
  generateSound: (path) => runAssetGenerator("generate-sound.mjs", [path]),
  liquidDirectory: process.env.LIQUID_DIR ?? resolve(process.cwd(), "data/liquid"),
  generateLiquidTexture: (liquidClass) => runAssetGenerator("generate-liquid-texture.mjs", [liquidClass]),
  // What the modules on this machine ship for this client: message schemas, window definitions and
  // stylesheets. Scanned per request rather than memoised, because the whole point of it is to
  // notice that a module author just saved a file.
  moduleDirectories: paths.moduleDirectories(),
  // The one route in this process that writes to the disk, and it stays shut unless it is asked
  // for by name. Even switched on it answers only a socket from this machine — see the route.
  moduleWrite: process.env["MODULE_UI_WRITE"] === "1",
});

/**
 * The archives' listing of the character pipeline's texture files, out of a child process.
 *
 * Not `runAssetGenerator`: that one wants the child's stderr only when it fails, and here — as in
 * the shadow check below, and for the same reason — the stderr *is* the answer. StormLib prints its
 * startup line and one line per heap resize on stdout, so stdout cannot carry a payload. Exit 0
 * means stderr is the listing; anything else means it is the reason there is none.
 *
 * Measured on this machine: 762 ms from spawn to exit, 36,027 paths, 2,507,555 bytes down the pipe.
 * It runs once, beside the DBC reads of the index that wants it, and again only when the archives
 * change under a running gateway.
 */
function listCharacterTextures(): Promise<readonly string[]> {
  return new Promise((resolveJob, rejectJob) => {
    let answer = "";
    const child = spawn(process.execPath, [resolve(process.cwd(), "tools/character-textures.mjs")], {
      cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => { answer += data; });
    child.once("error", rejectJob);
    child.once("exit", (code) => {
      if (code !== 0) {
        console.warn(`Not reading the archives for texture spellings: ${answer.trim() || `exit ${String(code)}`}`);
        rejectJob(new Error(answer.trim() || `character-textures.mjs exited with ${String(code)}`));
        return;
      }
      resolveJob([...parseCharacterTextures(answer)]);
    });
  });
}

/**
 * Runs one generator as a child process.
 *
 * The child's **exit code** rides out on the rejection, because it is the only part of a failure
 * that survives a crash: a generator that segfaults writes nothing to stderr at all, so a route
 * reading the message cannot tell "the archives do not hold this" from "the child died". The
 * gateway's `sourceMissing` reads exactly this field, and that is what decides 404 against 500.
 *
 * `relay` names the pass in the log and turns its stderr from a failure message into an answer:
 * the restamp passes write what they stamped there and say nothing on success otherwise, and their
 * stdout is StormLib's. Without it the child's stderr is only read to explain a non-zero exit.
 */
function runAssetGenerator(script: string, args: string[], relay?: string): Promise<void> {
  return new Promise((resolveJob, rejectJob) => {
    let errors = "";
    const child = spawn(process.execPath, [resolve(process.cwd(), "tools", script), ...args], {
      cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => { errors += data; });
    child.once("error", rejectJob);
    child.once("exit", (code) => {
      if (code === 0) {
        if (relay && errors.trim()) console.log(`${relay}: ${errors.trim().replaceAll("\n", "\n  ")}`);
        resolveJob();
        return;
      }
      const failure = new Error(errors || `${script} exited with ${String(code)}`) as Error & { exitCode?: number };
      if (code !== null) failure.exitCode = code;
      rejectJob(failure);
    });
  });
}

console.log(`WebClient gateway listening on ws://${gateway.host}:${gateway.port}/auth and /world`);

/**
 * Which of the tables tswow built the game client will not actually read — said once, at startup.
 *
 * A patch directory is where a module's work lands, and it is not the top of the chain: an archive
 * with a later letter beats it, and on this machine two do — `patch-ruRU-E.MPQ` and
 * `patch-ruRU-D.MPQ` both carry `DBFilesClient\GameObjectDisplayInfo.dbc`, so E wins it from
 * tswow's own build. That is invisible from every direction: the gateway reads its DBCs out of
 * `dataset/dbc` and is unaffected, the game client reads the archive and shows the stale table, and
 * a module author is left with a gameobject display that exists in the database, exists in the
 * dataset, and does not exist in the game. `tools/check-shadowed-tables.mjs` carries the check and
 * the wording; this is only where it is started and where its warnings are relayed.
 *
 * A child process and not an import, because the check needs an archive and an archive means
 * StormLib's WebAssembly build, whose heap only grows. Measured with the same expressions run
 * in-process: 34.5 MB of RSS before, 43.6 after the import, 94.2 after opening the chain, 96.3
 * after `close()` and a forced collection — so the gateway would carry ~62 MB for the rest of its
 * life for one line printed once, and its stdout would carry StormLib's own startup chatter as
 * well. Out here both die with the child: this process goes from 34.4 to 35.2 MB, and the child
 * takes 340 ms from spawn to exit while the gateway is already serving.
 */
if (clientDirectory !== undefined) {
  // Not `runAssetGenerator`: that one wants the child's stderr only when it fails, and here the
  // stderr *is* the answer. Nothing is awaited — the gateway is listening already and a shadowed
  // table is news, not a precondition.
  let warnings = "";
  const check = spawn(
    process.execPath,
    [resolve(process.cwd(), "tools/check-shadowed-tables.mjs"), clientDirectory],
    { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  check.stderr.setEncoding("utf8");
  check.stderr.on("data", (data: string) => { warnings += data; });
  check.once("error", (error: Error) => {
    console.warn(`Not checking the archive chain for shadowed tables: ${error.message}`);
  });
  check.once("exit", (code) => {
    if (code === 0) process.stderr.write(warnings);
    else console.warn(`Not checking the archive chain for shadowed tables: ${warnings.trim() || `exit ${String(code)}`}`);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await gateway.close();
    process.exit(0);
  });
}
