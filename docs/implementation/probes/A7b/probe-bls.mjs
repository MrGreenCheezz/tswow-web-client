// A7b probe (read-only): readable text inside the client's compiled arbfp1 shaders (terrain, liquid).
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
const archives = await clientArchives(clientDirectory());
const list = [...await archives.list("Shaders\\")];
for (const p of list.sort()) if (/vertex\\arbvp1\\.*(terrain|liquid|water|sky)/i.test(p)) console.log("VERT " + p);
const show = async (path, max = 2600) => {
  const d = await archives.read(path);
  console.log(`\n=== ${path}: ${d ? d.length + " bytes" : "absent"}`);
  if (!d) return;
  console.log("magic", d.subarray(0, 4).toString("latin1"));
  const text = d.toString("latin1").replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, "\n").replace(/\n{2,}/g, "\n");
  console.log(text.slice(0, max));
};
await show("Shaders\\Pixel\\arbfp1\\terrain2.bls", 3200);
await show("Shaders\\Pixel\\arbfp1\\psliquidwater.bls", 3200);
await show("Shaders\\Pixel\\arbfp1\\psliquidmagma.bls", 2200);
archives.close();
