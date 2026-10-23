// 23.10 (7.48): one worker of the world set's compression pass (tools/upscale-textures.mjs `compressSet`).
//
// Told `{ id, png, blp, mask, ground, destination }`: reads the HD PNG, puts a ground texture on the terrain array's
// side (512) with its `_s.blp` specular mask (`mask`, the BLP bytes, if any) in its alpha, encodes BC7 with its mip
// chain (tools/hd-texture-bc7.mjs) and renames the container into place.
// Answers `{ id, ok, width, height, levels, bytes, opaque, error, halfError, originalPng }` — `originalPng` is the
// sha1 of the PNG the gateway publishes for the same BLP (`blpToPng`, what `/visual/texture/<hash>-<n>.png` serves),
// by which the gateway finds a building's HD copy; `halfError` is the mean absolute difference between the decoded
// HD level of the original's size and the original (0–255, alpha-weighted colour), the faithfulness check.

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { PNG } from "pngjs";
import { decodeBlp } from "./blp.mjs";
import { blpToPng } from "./blp-png.mjs";
import { compressTexture, decodeBc7Image, decodeContainer, resampleWrapped } from "./hd-texture-bc7.mjs";

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
    if (job.ground) {
      // The ground's alpha is its specular mask, as the gateway's layer arrays carry it (the `_s.blp` alpha,
      // tools/generate-terrain-splat.mjs `specularMaskPng`), resampled to the HD side; opaque without one.
      image = resampleWrapped(image, GROUND_SIDE, GROUND_SIDE);
      const data = Uint8Array.from(image.data);
      const mask = job.mask ? resampleWrapped(decodeBlp(Buffer.from(job.mask)), GROUND_SIDE, GROUND_SIDE) : undefined;
      for (let at = 3; at < data.length; at += 4) data[at] = mask ? mask.data[at] : 255;
      image = { width: GROUND_SIDE, height: GROUND_SIDE, data };
    }
    const result = compressTexture(image);
    const temporary = `${job.destination}.${process.pid}-${job.id}.tmp`;
    writeFileSync(temporary, result.bytes);
    renameSync(temporary, job.destination);
    const blp = Buffer.from(job.blp);
    const originalPng = createHash("sha1").update(blpToPng(blp)).digest("hex");
    let halfError;
    try {
      const original = decodeBlp(blp);
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
