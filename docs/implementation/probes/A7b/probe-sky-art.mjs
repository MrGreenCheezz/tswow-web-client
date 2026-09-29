// A7b probe (read-only on the client): decode the sky art to PNG beside this file and list what Stars.m2 references.
import { writeFile, mkdir } from "node:fs/promises";
import { PNG } from "file:///F:/tswowRoot/WebClient/node_modules/pngjs/lib/png.js";
import { decodeBlp } from "file:///F:/tswowRoot/WebClient/tools/blp.mjs";
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";

const out = "C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7b/sky-art";
await mkdir(out, { recursive: true });
const archives = await clientArchives(clientDirectory());
const blps = ["Textures\\SunCenter.blp", "Textures\\SunGlare.blp", "Textures\\Moon.blp", "Textures\\MoonGlare.blp", "Textures\\Moon02.blp",
  "Textures\\Moon02Glare.blp", "Environments\\Stars\\Stars.blp", "Environments\\Stars\\StarsAndClouds.blp"];
for (const path of blps) {
  const data = await archives.read(path);
  if (!data) { console.log(`${path}: absent`); continue; }
  const image = decodeBlp(data);
  // Composite over mid-grey so alpha shapes are visible, and write the alpha channel as its own strip.
  const png = new PNG({ width: image.width * 2, height: image.height });
  let opaque = 0, maxRgb = 0, sumA = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    const a = image.data[i + 3] / 255;
    sumA += a; if (a > 0.5) opaque++;
    maxRgb = Math.max(maxRgb, image.data[i], image.data[i + 1], image.data[i + 2]);
    const left = (y * image.width * 2 + x) * 4, right = (y * image.width * 2 + image.width + x) * 4;
    for (let c = 0; c < 3; c++) png.data[left + c] = Math.round(image.data[i + c] * a + 40 * (1 - a));
    png.data[left + 3] = 255;
    const g = image.data[i + 3];
    png.data[right] = png.data[right + 1] = png.data[right + 2] = g; png.data[right + 3] = 255;
  }
  const name = path.split("\\").pop().replace(/\.blp$/i, "");
  await writeFile(`${out}/${name}.png`, PNG.sync.write(png));
  console.log(`${path}: ${image.width}x${image.height}; alpha>0.5 on ${(100 * opaque / (image.width * image.height)).toFixed(1)}%, mean alpha ${(sumA / (image.width * image.height)).toFixed(2)}, max rgb ${maxRgb}`);
}
// M2: texture names + counts in the header (3.3.5: vertices at 0x3C/0x40, textures at 0x50/0x54).
function m2Info(data) {
  const cString = (o) => { let e = o; while (data[e]) e++; return data.toString("latin1", o, e); };
  const nTex = data.readUInt32LE(0x50), ofsTex = data.readUInt32LE(0x54);
  const textures = [];
  for (let i = 0; i < nTex; i++) {
    const at = ofsTex + i * 16;
    const type = data.readUInt32LE(at), len = data.readUInt32LE(at + 8), ofs = data.readUInt32LE(at + 12);
    textures.push(type === 0 && len > 0 ? cString(ofs) : `<type ${type}>`);
  }
  return { magic: data.toString("latin1", 0, 4), vertices: data.readUInt32LE(0x3C), textures };
}
for (const path of ["Environments\\Stars\\Stars.m2", "Environments\\Stars\\DeathSkybox.m2", "Environments\\Stars\\StormPeaks_SkyA.m2", "Environments\\Stars\\NagrandSkyBox.m2", "Environments\\Stars\\DalaranSkyBox.m2", "Environments\\Stars\\BladesEdgeSkyBox.m2", "Environments\\Stars\\Aurora.m2"]) {
  const data = await archives.read(path);
  if (!data) { console.log(`${path}: absent`); continue; }
  const info = m2Info(data);
  console.log(`${path}: ${info.magic} vertices ${info.vertices}; textures: ${info.textures.join(" | ")}`);
}
archives.close();
