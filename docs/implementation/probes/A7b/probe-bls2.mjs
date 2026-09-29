// A7b probe (read-only): more of the client's arbfp1/arbvp1 text — terrain vertex lighting, MapObj pixel programs.
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
const archives = await clientArchives(clientDirectory());
const list = [...await archives.list("Shaders\\")].sort();
for (const p of list) if (/(pixel|vertex)\\arbfp1?\\|arbvp1\\/i.test(p) && /mapobj|sky|cloud|starfield/i.test(p)) console.log("NAME " + p);
const firstProgram = (d) => {
  const text = d.toString("latin1").replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, "\n").replace(/\n{2,}/g, "\n");
  const first = text.indexOf("!!ARB");
  const second = text.indexOf("!!ARB", first + 5);
  return text.slice(first, second > 0 ? second : first + 3500);
};
for (const path of ["Shaders\\Vertex\\arbvp1\\terrain.bls", "Shaders\\Pixel\\arbfp1\\terrain0.bls", "Shaders\\Vertex\\arbvp1\\vsliquidmagma.bls",
  "Shaders\\Pixel\\arbfp1\\psliquidprocwater.bls"]) {
  const d = await archives.read(path);
  console.log(`\n=== ${path}: ${d ? d.length + " bytes" : "absent"}`);
  if (d) console.log(firstProgram(d).slice(0, 3800));
}
archives.close();
