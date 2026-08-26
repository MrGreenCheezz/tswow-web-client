import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { decodeBlp } from "./blp.mjs";

/** Encodes a decoded BLP as PNG bytes. */
export function blpToPng(blp) {
  const image = decodeBlp(blp);
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png);
}

/**
 * Writes one BLP out as PNG, reporting why rather than swallowing the reason.
 *
 * The old shape returned a bare false for everything — a JPEG-content BLP, a BLP1 from older
 * authoring tools, an absent file, a full disk — so callers shipped silently untextured models
 * and nothing reached the log.
 */
export async function writeBlpAsPng(blp, target) {
  if (!blp) return { ok: false, reason: "the texture is not in the client" };
  try {
    await writeFile(target, blpToPng(blp));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Converts one BLP file to PNG. Returns false instead of throwing on an undecodable file. */
export async function convertBlpFile(source, target) {
  try {
    return (await writeBlpAsPng(await readFile(source), target)).ok;
  } catch {
    return false;
  }
}
