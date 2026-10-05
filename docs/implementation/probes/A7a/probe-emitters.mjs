// A7a 6.15 census (05.10): particle-emitter fields the renderer ignores — twinkle, tailCell,
// textureTileRotation, windTime, model particles — and emitters wanting more than 256 live particles.
// Standalone: `node probe-emitters.mjs [sample]`; also run in one pass by probe-m2-census.mjs.
import { readParticleEmitters } from "file:///F:/tswowRoot/WebClient/tools/m2-particles.mjs";
import { arr, family, inc, top } from "./corpus.mjs";

export function createProbe() {
  const fam = new Map();
  const total = { models: 0, modelsWithEmitters: 0, emitters: 0, twinkleSpeed: 0, twinklePercent: 0, twinklePercentPartial: 0, twinkleScale: 0,
    tailCellNonZero: 0, tailLength: 0, tileRotation: 0, windTime: 0, windVector: 0, modelParticle: 0, recursionModel: 0,
    over128: 0, over256: 0, over512: 0 };
  const tileValues = new Map(), percentValues = new Map(), scaleValues = new Map();
  const over256Examples = [];
  const modelExamples = [];
  return {
    roots: undefined,
    withSkin: false,
    visit(path, model) {
      if (model.readUInt32LE(4) !== 264) return;
      total.models++;
      const block = arr(model, 0x128);
      const emitters = readParticleEmitters(model, block);
      if (!emitters.length) return;
      total.modelsWithEmitters++;
      const f = fam.get(family(path)) ?? { emitters: 0, twinkle: 0, tail: 0, tile: 0, wind: 0, model: 0, over256: 0 };
      fam.set(family(path), f);
      for (let i = 0; i < emitters.length; i++) {
        const e = emitters[i];
        const at = block.offset + i * 476;
        total.emitters++; f.emitters++;
        if (e.twinkleSpeed > 0) total.twinkleSpeed++;
        const partial = e.twinklePercent > 0 && e.twinklePercent < 1;
        if (e.twinklePercent > 0) total.twinklePercent++;
        if (partial) total.twinklePercentPartial++;
        inc(percentValues, +e.twinklePercent.toFixed(2));
        const scaleVaries = Math.abs(e.twinkleScaleMin - 1) > 1e-3 || Math.abs(e.twinkleScaleMax - 1) > 1e-3;
        if (scaleVaries) { total.twinkleScale++; inc(scaleValues, `${+e.twinkleScaleMin.toFixed(2)}..${+e.twinkleScaleMax.toFixed(2)}`); }
        if (e.twinkleSpeed > 0 && (partial || scaleVaries)) f.twinkle++;
        const tail = e.tailCell.values;
        if (tail.some((v) => v !== 0)) { total.tailCellNonZero++; f.tail++; }
        if (e.tailLength !== 0) total.tailLength++;
        if (e.textureTileRotation !== 0) { total.tileRotation++; f.tile++; inc(tileValues, e.textureTileRotation); }
        if (e.windTime !== 0) { total.windTime++; f.wind++; }
        if (e.windVector.some((v) => v !== 0)) total.windVector++;
        // v264 record: geometry model filename at +0x18, recursion model filename at +0x20 (both M2Array<char>).
        const named = (off) => { const n = model.readUInt32LE(at + off), o = model.readUInt32LE(at + off + 4); return n > 0 && o + n <= model.length && model.subarray(o, o + n).toString("latin1").replaceAll(String.fromCharCode(0), "") !== ""; };
        if (named(0x18)) { total.modelParticle++; f.model++; if (modelExamples.length < 6) modelExamples.push(path.split("\\").pop()); }
        if (named(0x20)) total.recursionModel++;
        const peak = (track) => { let m = 0; for (const t of track.tracks) for (const v of t.values) if (Number.isFinite(v)) m = Math.max(m, v); return m; };
        const want = peak(e.emissionRate) * (1 + Math.max(0, e.emissionRateVary)) * (peak(e.lifespan) + Math.max(0, e.lifespanVary));
        if (want > 128) total.over128++;
        if (want > 256) { total.over256++; f.over256++; if (over256Examples.length < 8) over256Examples.push(`${path.split("\\").pop()}:${Math.round(want)}`); }
        if (want > 512) total.over512++;
      }
    },
    report() {
      console.log("== probe-emitters (6.15)");
      console.log(JSON.stringify(total));
      console.log("twinklePercent values:", top(percentValues, 8));
      console.log("twinkleScale ranges (≠1..1):", top(scaleValues, 8));
      console.log("textureTileRotation values:", top(tileValues, 8));
      console.log("model-particle examples:", modelExamples.join(" "));
      console.log("over 256 examples:", over256Examples.join(" "));
      for (const [k, v] of [...fam].sort((a, b) => b[1].emitters - a[1].emitters)) console.log(`  ${k}: ${JSON.stringify(v)}`);
    },
  };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`) {
  const { walkM2 } = await import("./corpus.mjs");
  const probe = createProbe();
  console.log(JSON.stringify(await walkM2((p, m, s) => probe.visit(p, m, s), { sample: Number(process.argv[2] ?? 1) })));
  probe.report();
}
