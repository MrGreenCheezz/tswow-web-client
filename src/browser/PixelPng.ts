/**
 * 22.10 ARC-2 S6a: a screenshot of a WebGL drawing buffer where `canvas.toDataURL` cannot be used — an OffscreenCanvas
 * owned by a worker has none, and its drawing buffer is cleared once the task that drew it ends. The pixels are read
 * synchronously right after the draw (`readDrawingBuffer`), then encoded as a PNG data URL (`pngDataUrl`) at leisure.
 */

/** RGBA rows top-down, as an image file stores them. */
export interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

/** The default framebuffer's pixels now (call in the task that drew them), rows flipped to top-down. */
export function readDrawingBuffer(gl: WebGLRenderingContext | WebGL2RenderingContext): PixelImage {
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const bottomUp = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
  gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  return { width, height, rgba: flipRows(bottomUp, width, height) };
}

/** Bottom-up rows (as `readPixels` gives them) to top-down. */
export function flipRows(pixels: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const row = width * 4;
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y++) out.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return out;
}

/** A lossless PNG of the image as a `data:image/png;base64,…` URL, through a 2D OffscreenCanvas. */
export async function pngDataUrl(image: PixelImage): Promise<string> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PixelPng: no 2d context");
  context.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  return `data:image/png;base64,${base64(bytes)}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
