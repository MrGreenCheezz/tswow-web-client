// 23.10 (7.48): running Real-ESRGAN ncnn-vulkan (BSD-3) over a directory of PNG work pictures.
//
// The executable and its models live in `.runtime/tools/realesrgan/` (downloaded by the owner's leave on 23.10,
// never part of the repository); `REALESRGAN_DIR` points elsewhere. One run per directory: the model is loaded
// once and every picture in the directory goes through the GPU in turn.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { repositoryRoot } from "./paths.mjs";

/**
 * The models this tool knows, with the scales it asks each one for. realesr-animevideov3 ships ×2 and ×3 models
 * too, but on this machine (RTX 5070 Ti, the ncnn build in the release) they lose the Vulkan device
 * ("vkQueueSubmit failed -4") and still exit 0 with noise in the output file; ×4 never did. So ×2 is ×4 and a 2×2
 * box downsample (`downsample` below), which is also what the ×4-only models need.
 */
export const MODELS = {
  "realesr-animevideov3": [4],
  "realesrgan-x4plus": [4],
  "realesrgan-x4plus-anime": [4],
};

export function upscalerDirectory() {
  return resolve(process.env.REALESRGAN_DIR ?? join(repositoryRoot, ".runtime", "tools", "realesrgan"));
}

/** The executable, or a thrown explanation of where it was looked for. */
export function upscalerExecutable(directory = upscalerDirectory()) {
  const executable = join(directory, process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan");
  if (!existsSync(executable)) {
    throw new Error(`Real-ESRGAN ncnn-vulkan is not at ${executable}; set REALESRGAN_DIR to the folder that holds it`);
  }
  return executable;
}

/** The scale a model is asked for to reach `target`: the target itself when native, else the model's ×4. */
export function nativeScale(model, target) {
  const scales = MODELS[model];
  if (!scales) throw new Error(`Unknown model ${model}; known: ${Object.keys(MODELS).join(", ")}`);
  return scales.includes(target) ? target : Math.max(...scales);
}

/**
 * Upscales every PNG in `input` into `output` (same names) at `scale` with `model`.
 * Resolves with the run's wall time in ms; rejects with the tool's stderr tail on a non-zero exit.
 */
export function upscaleDirectory({ input, output, model, scale, gpu, tileSize = 0, threads = "1:2:2" }) {
  const directory = upscalerDirectory();
  const executable = upscalerExecutable(directory);
  const args = ["-i", input, "-o", output, "-n", model, "-s", String(scale), "-m", join(directory, "models"),
    "-f", "png", "-t", String(tileSize), "-j", threads];
  if (gpu !== undefined) args.push("-g", String(gpu));
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: directory, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdout.on("data", () => undefined);
    child.on("error", reject);
    child.on("close", (code) => {
      // The tool exits 0 after a lost device (see MODELS), so its own complaint is the failure signal.
      if (code === 0 && !/failed/i.test(stderr)) resolvePromise(Date.now() - started);
      else reject(new Error(`realesrgan-ncnn-vulkan exited ${code}: ${stderr.trim().split("\n").slice(-5).join(" | ")}`));
    });
  });
}

/** A 2×2 (or n×n) box downsample of straight RGBA/RGB pixels, for a ×4 model asked for ×2. */
export function downsample(image, factor, channels = 4) {
  if (factor === 1) return image;
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Uint8Array(width * height * channels);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < channels; channel++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) sum += image.data[((y * factor + dy) * image.width + x * factor + dx) * channels + channel];
        }
        data[(y * width + x) * channels + channel] = Math.round(sum / area);
      }
    }
  }
  return { width, height, data };
}
