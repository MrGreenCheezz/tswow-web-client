// 25.10 (7.50): publishes the index of models that give light by themselves — every M2 of the client's
// archive chain that declares an `M2Light` point light — as one small JSON beside the visual models:
// `lit-models.json`, `{ version: 1, models: ["world\\...\\stormwindgypsywagon01.m2", ...] }` (lower case,
// backslashes, sorted). The gateway serves it as `/visual/lit-models` (src/gateway/LitModelIndexRoute.ts).
//
// Why: the browser learns which models light before their placements are built (`LightTemplateCatalog.ts`).
// The enhanced profile's heuristic — flame and glow cards, unlit lamp glass and lantern panes, fire
// emitters — only ever looks at a model whose file name reads as a lamp, torch or fire
// (`fixtureNameCandidate`), so the browser already knows those from the placement's name. A model's own
// M2 lights are the one way a model with any other name lights (`m2PointLights` in LocalLighting.ts), and
// only the file says so: `StormwindGypsyWagon01.m2` hangs a lantern on a wagon and switched on 112 yards
// from the player on the Goldshire -> Stormwind run, when its first placement was built. This index names
// those models, so the browser asks for them as it asks for lamps.
//
// The records are read with the code the model generator publishes them with (`readLights`, tools/m2.mjs,
// into WVM9's light table) and kept by the same test the browser's derivation applies (`m2PointLights`):
// type 1 (point) and a finite position. Whether a light is lit at time 0 is left to the browser's
// derivation once the model arrives — an entry here only makes the model wanted early.
//
// One pass over the chain: ~22,500 models, each read whole (the light table sits anywhere in the file).
// Run by the gateway on the first request (`generateLitModelIndex`), or directly:
//   node tools/generate-lit-model-index.mjs [--out <file>]

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLights } from "./m2.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { sourceStamp, writeFileAtomic, writeSourceStamp } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The answer's shape; `/visual/lit-models?v=` names it (src/world/LitModelIndex.ts). */
export const LIT_MODEL_INDEX_VERSION = 1;
export const LIT_MODEL_INDEX_FILE = "lit-models.json";

/** `M2Light.type` 1; type 0 (directional) lights nothing in the world (LocalLighting.ts `M2_LIGHT_POINT`). */
const M2_LIGHT_POINT = 1;

export function visualModelsDirectory() {
  return resolve(root, process.env.VISUAL_MODEL_DIR ?? "data/visual-models");
}

/** Whether an M2 file's bytes declare a point light the browser lights with (`m2PointLights`). */
export function declaresPointLight(bytes) {
  if (!bytes || bytes.length < 0x110 || bytes.subarray(0, 4).toString("latin1") !== "MD20") return false;
  // A cheap no: most models have an empty light table, and `readLights` would walk the sequences first.
  if (bytes.readUInt32LE(0x108) === 0) return false;
  return readLights(bytes).some((light) => light.type === M2_LIGHT_POINT && light.position.every(Number.isFinite));
}

/** Every `.m2` of the chain that declares a point light, lower case with backslashes, sorted. */
export async function litModelsOf(archives, onProgress) {
  const paths = [...await archives.list("")].filter((path) => path.endsWith(".m2")).sort();
  const lit = [];
  let read = 0;
  for (const path of paths) {
    let bytes;
    try {
      bytes = await archives.read(path);
    } catch {
      continue; // An unreadable entry lights nothing, as the model route would publish nothing.
    }
    read++;
    try {
      if (declaresPointLight(bytes)) lit.push(path);
    } catch {
      // A malformed table: the generator's `parseM2` would refuse the model too.
    }
    if (onProgress && read % 2000 === 0) onProgress(read, paths.length);
  }
  return { models: lit, paths, read };
}

/** Writes the index and its source stamp (one entry per archive, not per model). */
export async function publishLitModelIndex(archives, destination = resolve(visualModelsDirectory(), LIT_MODEL_INDEX_FILE)) {
  const started = performance.now();
  const { models, paths, read } = await litModelsOf(archives);
  await mkdir(dirname(destination), { recursive: true });
  await writeFileAtomic(destination, JSON.stringify({ version: LIT_MODEL_INDEX_VERSION, models }));
  // Every model was an input. The per-path stamp is ~22,500 entries (35 MB) naming the same few archives,
  // so it is folded: one source per winning archive (its first path) and every archive of the chain — the
  // winners and those searched above them — as a plain file, so a patch that rewrites any of them in place
  // (size or mtime) republishes the index. A loose overlay directory that gains a model is not seen until
  // the chain changes; the index then only misses that model's early ask, as before this route.
  const stamp = await sourceStamp(archives, { paths });
  const sources = new Map();
  const files = new Map();
  for (const source of stamp.sources) {
    if (!sources.has(source.name)) sources.set(source.name, { ...source, aboveArchives: undefined, above: [] });
    if (source.kind === "archive") files.set(source.file, { file: source.file, size: source.size, mtimeMs: source.mtimeMs });
    for (const archive of source.aboveArchives ?? []) files.set(archive.file, archive);
  }
  await writeSourceStamp(destination, { ...stamp, sources: [...sources.values()], files: [...stamp.files, ...files.values()] });
  return { destination, models: models.length, scanned: paths.length, read, ms: performance.now() - started };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
  const archives = await clientArchives(clientDirectory());
  try {
    const result = await publishLitModelIndex(archives, out);
    console.log(`Lit model index: ${result.models} of ${result.scanned} models (${result.read} read) in ${result.ms.toFixed(0)} ms -> ${result.destination}`);
  } finally {
    archives.close();
  }
}
