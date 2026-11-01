// TGA for the texture route. The archives hold BLPs, but a loose add-on can ship TGAs: WCollections
// has 161 of them, named in its XML and Lua without an extension. Wow.exe takes such a name as
// "the .blp, or else the .tga"; generate-texture.mjs does the same and comes here for the second half.
//
// Covers what 3.3.5 add-ons are authored in: uncompressed or RLE, 8-bit grey, 24-bit or 32-bit,
// either vertical origin. A colour-mapped or otherwise unusual file throws, which the route
// answers with a 500: it is a picture the client holds and this decoder could not read, not a
// missing file.

import { PNG } from "pngjs";

const TYPE_TRUE_COLOUR = 2;
const TYPE_GREY = 3;
const TYPE_RLE_TRUE_COLOUR = 10;
const TYPE_RLE_GREY = 11;

/** RGBA, top row first. */
export function decodeTga(bytes) {
  if (bytes.length < 18) throw new Error("TGA header is truncated");
  const idLength = bytes[0];
  const colourMapType = bytes[1];
  const type = bytes[2];
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const depth = bytes[16];
  const descriptor = bytes[17];
  const rle = type === TYPE_RLE_TRUE_COLOUR || type === TYPE_RLE_GREY;
  const grey = type === TYPE_GREY || type === TYPE_RLE_GREY;
  if (colourMapType !== 0 || !(grey || type === TYPE_TRUE_COLOUR || type === TYPE_RLE_TRUE_COLOUR)) {
    throw new Error(`TGA type ${type} with colour map ${colourMapType} is not supported`);
  }
  if (grey ? depth !== 8 : depth !== 24 && depth !== 32) throw new Error(`TGA depth ${depth} is not supported`);
  if (width === 0 || height === 0) throw new Error("TGA has no pixels");
  const stride = depth >>> 3;
  const count = width * height;
  let at = 18 + idLength;
  const data = Buffer.alloc(count * 4);
  const topDown = (descriptor & 0x20) !== 0;
  const write = (pixel, from) => {
    if (from + stride > bytes.length) throw new Error("TGA pixels are truncated");
    const row = Math.floor(pixel / width);
    const column = pixel - row * width;
    const y = topDown ? row : height - 1 - row;
    const out = (y * width + column) * 4;
    if (grey) {
      data[out] = data[out + 1] = data[out + 2] = bytes[from];
      data[out + 3] = 255;
    } else {
      data[out] = bytes[from + 2];
      data[out + 1] = bytes[from + 1];
      data[out + 2] = bytes[from];
      data[out + 3] = stride === 4 ? bytes[from + 3] : 255;
    }
  };
  if (!rle) {
    for (let pixel = 0; pixel < count; pixel += 1, at += stride) write(pixel, at);
  } else {
    for (let pixel = 0; pixel < count;) {
      if (at >= bytes.length) throw new Error("TGA packets are truncated");
      const packet = bytes[at];
      at += 1;
      const run = (packet & 0x7f) + 1;
      if (pixel + run > count) throw new Error("TGA packet runs past the image");
      if ((packet & 0x80) !== 0) {
        for (let index = 0; index < run; index += 1) write(pixel + index, at);
        at += stride;
      } else {
        for (let index = 0; index < run; index += 1, at += stride) write(pixel + index, at);
      }
      pixel += run;
    }
  }
  return { width, height, data };
}

export function tgaToPng(bytes) {
  const { width, height, data } = decodeTga(bytes);
  const png = new PNG({ width, height, deflateLevel: 9 });
  data.copy(png.data);
  return PNG.sync.write(png);
}
