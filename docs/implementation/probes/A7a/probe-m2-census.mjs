// A7a срез 0 (05.10): one single-process pass over the F:/Circle M2 corpus feeding the per-item probes
// (emitters 6.15, uvtransform 6.16б, interp 6.16г, blend 6.16д, armorreflect 6.16е, combiners 6.22).
// Usage: node probe-m2-census.mjs [sample=1] [probe,probe,...]
import { walkM2 } from "./corpus.mjs";

const sample = Number(process.argv[2] ?? 1);
const wanted = (process.argv[3] ?? "emitters,uvtransform,interp,blend,armorreflect,combiners").split(",");
const probes = [];
for (const name of wanted) probes.push((await import(`./probe-${name}.mjs`)).createProbe());
const withSkin = probes.some((p) => p.withSkin);
const run = await walkM2((path, model, skin) => { for (const p of probes) p.visit(path, model, skin); }, { withSkin, sample });
console.log("walk:", JSON.stringify(run));
for (const p of probes) p.report();
