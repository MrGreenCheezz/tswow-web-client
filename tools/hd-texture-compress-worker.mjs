// 23.10 (7.48): one worker of the world set's compression pass (tools/upscale-textures.mjs `compressSet`).
//
// Told `{ id, png, blp, ground, destination }`: reads the HD PNG, puts a ground texture on the terrain array's side
// (512, opaque), encodes BC7 — level 0 the HD picture, level 1 onwards the original (tools/hd-texture-bc7.mjs) — and
// renames the container into place.
// Answers `{ id, ok, width, height, levels, bytes, opaque, error, halfError, originalPng }` — `originalPng` is the
// sha1 of the PNG the gateway publishes for the same BLP (`blpToPng`, what `/visual/texture/<hash>-<n>.png` serves),
// by which the gateway finds a building's HD copy; `halfError` is the mean absolute difference between the decoded
// level of the original's size (since pipeline v2 the original itself, so this is BC7's error) and the original
// (0–255, alpha-weighted colour), the faithfulness check.

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { PNG } from "pngjs";
import { decodeBlp } from "./blp.mjs";
import { blpToPng } from "./blp-png.mjs";
import { backProject, compressTexture, decodeBc7Image, decodeContainer, resampleWrapped } from "./hd-texture-bc7.mjs";

/** The side every ground layer of the HD terrain array has (the gateway's 256 layers × 2). */
export const GROUND_SIDE = 512;

function meanDifference(decoded, original) {
  let colour = 0;
  let weight = 0;
  for (let at = 0; at < original.data.length; at += 4) {
    const alpha = original.data[at + 3] / 255;
    if (alpha === 0) continue;
    for (let channel = 0; channel < 3; channel++) colour += alpha * Math.abs(decoded.data[at + channel] - original.data[at + channel]);
    weight += 3 * alpha;
  }
  return weight ? colour / weight : 0;
}

parentPort.on("message", (job) => {
  try {
    const png = PNG.sync.read(readFileSync(job.png));
    let image = { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
    const blpBytes = Buffer.from(job.blp);
    const source = decodeBlp(blpBytes);
    // Level 1 onwards is the original (see `compressTexture`'s `lower`): the ground's as the gateway lays it out
    // (resampled to the array's 256, opaque), a building's as decoded.
    let lower = source;
    // 24.10 (7.48 step 3): the network's picture back-projected onto the original (its drift in tone removed).
    image = backProject(image, source, job.wrap === true || job.ground);
    if (job.ground) {
      // The ground on the array's sides (the gateway resamples a layer that is not 256 the same way), opaque: the
      // terrain reads only colour from an HD layer (the specular glint keeps the originals, TerrainSplat.ts).
      const opaque = (picture, side) => {
        const data = Uint8Array.from(resampleWrapped(picture, side, side).data);
        for (let at = 3; at < data.length; at += 4) data[at] = 255;
        return { width: side, height: side, data };
      };
      image = opaque(image, GROUND_SIDE);
      lower = opaque(source, GROUND_SIDE / 2);
    }
    const result = compressTexture(image, { lower });
    const temporary = `${job.destination}.${process.pid}-${job.id}.tmp`;
    writeFileSync(temporary, result.bytes);
    renameSync(temporary, job.destination);
    const originalPng = createHash("sha1").update(blpToPng(blpBytes)).digest("hex");
    let halfError;
    try {
      const original = source;
      // The ground was resampled to 512: its original is compared on the array's own 256 side, as the gateway lays it.
      const reference = job.ground ? resampleWrapped(original, GROUND_SIDE / 2, GROUND_SIDE / 2) : original;
      if (job.ground) for (let at = 3; at < reference.data.length; at += 4) reference.data[at] = 255;
      const container = decodeContainer(result.bytes);
      const level = container.levels.find((candidate) => candidate.width === reference.width && candidate.height === reference.height);
      if (level) halfError = meanDifference(decodeBc7Image(level.data, level.width, level.height), reference);
    } catch {
      // The comparison is a report, not a gate (the upscale itself was gated by `fidelity`).
    }
    parentPort.postMessage({ id: job.id, ok: true, width: result.width, height: result.height, levels: result.levels,
      bytes: result.bytes.length, opaque: result.opaque, error: result.error, halfError, originalPng });
  } catch (error) {
    parentPort.postMessage({ id: job.id, ok: false, reason: error instanceof Error ? error.message : String(error) });
  }
});
