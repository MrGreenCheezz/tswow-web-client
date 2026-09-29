// A9 (read-only): does the 3.3.5a client binary carry the walkable-slope constant cos(50 deg)?
// The float is searched as a 4-byte little-endian value and as an 8-byte double; every hit is
// printed with the 16 bytes on each side read back as floats, which is how the neighbouring
// constants (other slope limits, step heights) can be recognised by eye.
import { readFile } from "node:fs/promises";

const exe = await readFile("F:/Circle/Wow.exe.clean").catch(() => readFile("F:/Circle/Wow.exe"));
const targets = [
  ["cos(50deg) f32", Math.cos(50 * Math.PI / 180), 4],
  ["cos(55deg) f32", Math.cos(55 * Math.PI / 180), 4],
  ["cos(45deg) f32", Math.cos(45 * Math.PI / 180), 4],
  ["cos(60deg) f32", Math.cos(60 * Math.PI / 180), 4],
];
function floatBytes(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return buffer;
}
for (const [label, value] of targets) {
  const needle = floatBytes(value);
  let from = 0;
  let hits = 0;
  const found = [];
  for (;;) {
    const at = exe.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    hits++;
    if (found.length < 6) {
      const around = [];
      for (let offset = -16; offset <= 16; offset += 4) {
        const index = at + offset;
        around.push(index >= 0 && index + 4 <= exe.length ? exe.readFloatLE(index).toPrecision(6) : "-");
      }
      found.push(`  @0x${at.toString(16)}: ${around.join(" ")}`);
    }
  }
  console.log(`${label} (${value.toFixed(7)}): ${hits} hits`);
  for (const line of found) console.log(line);
}
