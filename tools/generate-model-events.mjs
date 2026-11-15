// 11.02 (04.11): publishes a model's M2 events, as one small JSON per model, for `/visual/model-events`. The WVM does not
// carry events and these few models do not call for rebuilding every model that has one.
//
// 15.11 (events8; 6.12, 5.05): version 2 serves every event the unit's model-event callback acts on, with its keys per
// sequence. Wow.exe 3.3.5a 12340 (Ghidra read-only, .runtime/re-2026-11-15/combat7/g3.c, events8/ids.txt): the callback
// 0x00732650 (registered by 0x0073e410 through 0x00734a40) compares the event id against 94 constants — footsteps and
// their sounds, `$SHL`/`$SHR` (the sheath hand-over, 0x00732500), `$CSL`/`$CSR`/`$CST` and `$BWR` (the queued missiles'
// launch point, 0x00715a50), and the ones it hands to the combat handler 0x00756240 (`$BWP`, `$CAH`, `$CPP`, `$CSS`,
// `$AH0`..`$AH3`, `$DTH`). `$AIM` is 0x006fcd60's (the steered shot) and is served too. An event's keys are the M2
// track's timestamps, one array per sequence slot; a sequence that keeps its keys outside the .m2 (no flag 0x20) keeps
// these timestamps in its `Model####-##.anim` too, so that file is read for it.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { m2Animations } from "./m2.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { stampGenerated } from "./source-stamp.mjs";
import { SourceMissing, SOURCE_MISSING_EXIT } from "./source-missing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `/visual/model-events?v=`; browser/VehicleMuzzle.ts `MODEL_EVENTS_VERSION`. */
export const MODEL_EVENTS_VERSION = 2;

/** The events a shot can leave from, by Wow.exe's reading order (version 1's whole set). */
const SHOT_EVENTS = new Set(["$AIM", "$CSL", "$CSR", "$CST"]);

/** Every id 0x00732650 compares against (events8/ids.txt), and 0x006fcd60's `$AIM`. */
export const ACTED_EVENTS = new Set([
  "$AIM",
  "$AH0", "$AH1", "$AH2", "$AH3", "$BL0", "$BL1", "$BL2", "$BL3", "$BR0", "$BR1", "$BR2", "$BR3", "$BRT", "$BTH",
  "$BWP", "$BWR", "$CAH", "$CPP", "$CSD", "$CSL", "$CSR", "$CSS", "$CST", "$DTH", "$ESD",
  "$FD1", "$FD2", "$FD3", "$FD4", "$FD5", "$FD6", "$FD7", "$FD8", "$FD9", "$FDX",
  "$FL0", "$FL1", "$FL2", "$FL3", "$FR0", "$FR1", "$FR2", "$FR3", "$FSD",
  "$RL0", "$RL1", "$RL2", "$RL3", "$RR0", "$RR1", "$RR2", "$RR3", "$SCD", "$SHL", "$SHR",
  "$SL0", "$SL1", "$SL2", "$SL3", "$SMD", "$SMG", "$SR0", "$SR1", "$SR2", "$SR3", "$TRD",
  "$VG0", "$VG1", "$VG2", "$VG3", "$VG4", "$VG5", "$VG6", "$VG7", "$VG8",
  "$VT0", "$VT1", "$VT2", "$VT3", "$VT4", "$VT5", "$VT6", "$VT7", "$VT8",
  "$WGG", "$WL0", "$WL1", "$WL2", "$WL3", "$WNG", "$WR0", "$WR1", "$WR2", "$WR3",
]);

/** M2 header +0x100: the events' count and offset; each entry is 36 bytes: id, data, bone, x, y, z, and a track. */
const HEADER_EVENTS = 0x100;
const EVENT_BYTES = 36;
/** Keys per sequence slot past this are not a real track. */
const MAX_KEYS = 4096;

function eventEntries(model) {
  const view = new DataView(model.buffer, model.byteOffset, model.byteLength);
  if (model.byteLength < HEADER_EVENTS + 8) return { view, entries: [] };
  const count = view.getUint32(HEADER_EVENTS, true);
  const offset = view.getUint32(HEADER_EVENTS + 4, true);
  if (count === 0 || count > 4096 || offset + count * EVENT_BYTES > model.byteLength) return { view, entries: [] };
  const entries = [];
  for (let index = 0; index < count; index++) {
    const at = offset + index * EVENT_BYTES;
    entries.push({ at, id: String.fromCharCode(model[at], model[at + 1], model[at + 2], model[at + 3]) });
  }
  return { view, entries };
}

/** The shot events of an M2, as they stand in the file (version 1's answer). */
export function shotEventsOf(model) {
  const { view, entries } = eventEntries(model);
  return entries.filter((entry) => SHOT_EVENTS.has(entry.id)).map(({ at, id }) => ({
    id, bone: view.getUint32(at + 8, true),
    x: view.getFloat32(at + 12, true), y: view.getFloat32(at + 16, true), z: view.getFloat32(at + 20, true),
  }));
}

/**
 * Version 2: every acted-on event with its keys per sequence, and the model's sequences. `animFiles` maps the
 * `####-##` suffix (tools/m2.mjs `animationFileSuffix`) to that `.anim`'s bytes; a sequence whose file is not there
 * gets no keys. The answer:
 *
 * - `sequences`: `[animationId, variation, duration]` for every sequence 0x00832ab0 can play (`m2Animations(asWowExe)`);
 * - `events`: `{ id, bone, x, y, z, keys: [[animationId, variation, [ms...]], ...] }`, plus `globalSequence` when the
 *   track runs on one (its keys are then on that loop's clock, not the sequence's).
 */
export function modelEventsOf(model, animFiles = new Map()) {
  const { view, entries } = eventEntries(model);
  const animations = m2Animations(model, { asWowExe: true });
  const sequences = animations.map((animation) => [animation.animationId, animation.variation ?? 0, animation.duration]);
  const events = [];
  for (const { at, id } of entries) {
    if (!ACTED_EVENTS.has(id)) continue;
    const globalSequence = view.getInt16(at + 26, true);
    const slots = view.getUint32(at + 28, true);
    const slotsAt = view.getUint32(at + 32, true);
    const keys = [];
    if (slots > 0 && slots <= 4096 && slotsAt + slots * 8 <= model.byteLength) {
      for (const animation of animations) {
        const slot = animation.sequenceIndex;
        if (slot >= slots) continue;
        const count = view.getUint32(slotsAt + slot * 8, true);
        const offset = view.getUint32(slotsAt + slot * 8 + 4, true);
        if (count === 0 || count > MAX_KEYS) continue;
        const source = animation.external === undefined ? model : animFiles.get(animation.external);
        if (!source || offset + count * 4 > source.byteLength) continue;
        const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
        const times = [];
        for (let key = 0; key < count; key++) times.push(sourceView.getUint32(offset + key * 4, true));
        keys.push([animation.animationId, animation.variation ?? 0, times]);
      }
    }
    events.push({
      id, bone: view.getUint32(at + 8, true),
      x: view.getFloat32(at + 12, true), y: view.getFloat32(at + 16, true), z: view.getFloat32(at + 20, true),
      keys, ...(globalSequence >= 0 ? { globalSequence } : {}),
    });
  }
  return { sequences, events };
}

/** The external `.anim` files an M2's acted-on event tracks may need. */
function animFilesNeeded(model) {
  const { entries } = eventEntries(model);
  if (!entries.some((entry) => ACTED_EVENTS.has(entry.id))) return [];
  const suffixes = new Set();
  for (const animation of m2Animations(model, { asWowExe: true })) {
    if (animation.external !== undefined) suffixes.add(animation.external);
  }
  return [...suffixes];
}

export function modelEventsId(mpqPath) {
  return createHash("sha1").update(`model-events-v${MODEL_EVENTS_VERSION}\0${mpqPath.replaceAll("/", "\\").toLowerCase()}`).digest("hex");
}

/** Publishes one model's events; run per model by the gateway. */
export async function publishModelEvents(path, archives, directory = resolve(root, process.env.VISUAL_MODEL_DIR ?? "data/visual-models")) {
  const mpqPath = path.replaceAll("/", "\\");
  const model = await archives.read(mpqPath);
  if (!model) throw new SourceMissing(`${mpqPath} is not in the client`);
  const base = mpqPath.replace(/\.m2$/i, "");
  const animFiles = new Map();
  const animPaths = [];
  for (const suffix of animFilesNeeded(model)) {
    const animPath = `${base}${suffix}.anim`;
    const bytes = await archives.read(animPath);
    if (!bytes) continue;
    animFiles.set(suffix, bytes);
    animPaths.push(animPath);
  }
  const destination = join(directory, `${modelEventsId(mpqPath)}.events.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(destination, JSON.stringify({ path: mpqPath, version: MODEL_EVENTS_VERSION, ...modelEventsOf(model, animFiles) }));
  await stampGenerated(destination, archives, { paths: [mpqPath, ...animPaths] });
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
