// A7a 6.16г census (05.10): interpolation types (0 step, 1 linear, 2 hermite, 3 bezier) of bone tracks.
// A channel counts when any of its sequences has keys; split creature/character vs the rest.
import { arr, fits, family, inc, top } from "./corpus.mjs";

const BONE = 88;

export function createProbe() {
  const all = new Map(), units = new Map(), byKind = new Map(), nonLinearExamples = new Map();
  let models = 0, bones = 0;
  return {
    withSkin: false,
    visit(path, model) {
      if (model.readUInt32LE(4) !== 264) return;
      models++;
      const block = arr(model, 0x2c);
      if (block.count > 2048 || !fits(model, block, BONE)) return;
      const fam = family(path);
      const isUnit = fam === "creature" || fam === "character";
      for (let i = 0; i < block.count; i++) {
        bones++;
        for (const [kind, off] of [["T", 16], ["R", 36], ["S", 56]]) {
          const at = block.offset + i * BONE + off;
          const type = model.readUInt16LE(at);
          const times = arr(model, at + 4);
          if (times.count === 0 || times.count > 4096 || !fits(model, times, 8)) continue;
          let keyed = false;
          for (let s = 0; s < times.count; s++) if (model.readUInt32LE(times.offset + s * 8) > 0) { keyed = true; break; }
          if (!keyed) continue;
          inc(all, type);
          if (isUnit) inc(units, type);
          inc(byKind, `${kind}${type}`);
          if (type !== 1) inc(nonLinearExamples, `${fam}:${path.split("\\").pop()}`);
        }
      }
    },
    report() {
      const share = (m) => { const n = [...m.values()].reduce((a, b) => a + b, 0); return `${[...m].sort().map(([k, v]) => `type${k}x${v}`).join(" ")} (non-linear ${(100 * (n - (m.get(1) ?? 0)) / Math.max(1, n)).toFixed(3)}% of ${n})`; };
      console.log("== probe-interp (6.16г)");
      console.log(`models ${models}, bones ${bones}`);
      console.log("all keyed bone channels:", share(all));
      console.log("creature+character channels:", share(units));
      console.log("by kind:", top(byKind, 12));
      console.log("models with non-linear channels (top):", top(nonLinearExamples, 10), `— ${nonLinearExamples.size} models`);
    },
  };
}
