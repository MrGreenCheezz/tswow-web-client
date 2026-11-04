// 11.02 (04.11): publishes where a model's muzzle is: the M2 events a shot leaves from, `$AIM`, `$CSL`, `$CSR` and `$CST`
// (Wow.exe 0x006fcd60, 0x0071a720), as one small JSON per model, for `/visual/model-events`. The WVM does not carry events and
// these few models do not call for rebuilding every model that has one.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { stampGenerated } from "./source-stamp.mjs";
import { SourceMissing, SOURCE_MISSING_EXIT } from "./source-missing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The events a shot can leave from, by Wow.exe's reading order. */
const SHOT_EVENTS = new Set(["$AIM", "$CSL", "$CSR", "$CST"]);
/** M2 header +0x100: the events' count and offset; each entry is 36 bytes: id, data, bone, x, y, z, and a track. */
const HEADER_EVENTS = 0x100;
const EVENT_BYTES = 36;

/** The shot events of an M2, as they stand in the file. */
export function shotEventsOf(model) {
  const view = new DataView(model.buffer, model.byteOffset, model.byteLength);
  if (model.byteLength < HEADER_EVENTS + 8) return [];
  const count = view.getUint32(HEADER_EVENTS, true);
  const offset = view.getUint32(HEADER_EVENTS + 4, true);
  if (count === 0 || count > 4096 || offset + count * EVENT_BYTES > model.byteLength) return [];
  const events = [];
  for (let index = 0; index < count; index++) {
    const at = offset + index * EVENT_BYTES;
    const id = String.fromCharCode(model[at], model[at + 1], model[at + 2], model[at + 3]);
    if (!SHOT_EVENTS.has(id)) continue;
    events.push({
      id, bone: view.getUint32(at + 8, true),
      x: view.getFloat32(at + 12, true), y: view.getFloat32(at + 16, true), z: view.getFloat32(at + 20, true),
    });
  }
  return events;
}

export function modelEventsId(mpqPath) {
  return createHash("sha1").update(`model-events-v1\0${mpqPath.replaceAll("/", "\\").toLowerCase()}`).digest("hex");
}

/** Publishes one model's events; run per model by the gateway. */
export async function publishModelEvents(path, archives, directory = resolve(root, process.env.VISUAL_MODEL_DIR ?? "data/visual-models")) {
  const mpqPath = path.replaceAll("/", "\\");
  const model = await archives.read(mpqPath);
  if (!model) throw new SourceMissing(`${mpqPath} is not in the client`);
  const destination = join(directory, `${modelEventsId(mpqPath)}.events.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(destination, JSON.stringify({ path: mpqPath, events: shotEventsOf(model) }));
  await stampGenerated(destination, archives, { paths: [mpqPath] });
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const requested = process.argv.slice(2);
  if (requested.length === 0) throw new Error("Usage: node tools/generate-model-events.mjs <model.m2...>");
  const archives = await clientArchives(clientDirectory());
  try {
    for (const path of requested) await publishModelEvents(path, archives);
  } catch (error) {
    if (!(error instanceof SourceMissing)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
}
