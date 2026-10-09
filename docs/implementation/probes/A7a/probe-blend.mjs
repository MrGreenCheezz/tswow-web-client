// A7a 6.16д census (05.10): batches drawn with BLEND_ALPHA (2) — by family, and how many also keep depth write.
import { family, inc, top, materials, skinBatches, textureNames, lookup } from "./corpus.mjs";

export function createProbe() {
  const blend = new Map(), alphaFam = new Map(), alphaModelsFam = new Map(), alphaTex = new Map();
  let batches = 0, alpha = 0, alphaNoDepthWrite = 0, alphaModels = 0, over6 = 0;
  return {
    withSkin: true,
    visit(path, model, skin) {
      if (!skin || model.readUInt32LE(4) !== 264) return;
      const mats = materials(model);
      const combos = lookup(model, 0x80);
      const names = textureNames(model);
      let any = false;
      for (const b of skinBatches(skin)) {
        const m = mats[b.materialIndex];
        if (!m) continue;
        batches++;
        inc(blend, m.blendMode);
        if (m.blendMode > 6) over6++;
        if (m.blendMode !== 2) continue;
        alpha++; any = true;
        if (m.flags & 0x20) alphaNoDepthWrite++;
        inc(alphaFam, family(path));
        const name = names[combos[b.textureComboIndex]] ?? "";
        const word = (name.split("\\").pop() ?? "").replace(/[_\d]*\.blp$/i, "").toLowerCase() || "(replaceable)";
        inc(alphaTex, word);
      }
      if (any) { alphaModels++; inc(alphaModelsFam, family(path)); }
    },
    report() {
      console.log("== probe-blend (6.16д)");
      console.log(`batches ${batches}; blend modes: ${[...blend].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x${v}`).join(" ")}; >6: ${over6}`);
      console.log(`BLEND_ALPHA batches ${alpha} in ${alphaModels} models; with material flag 0x20 (no depth write) ${alphaNoDepthWrite}`);
      console.log("  by family (batches):", top(alphaFam), "| (models):", top(alphaModelsFam));
      console.log("  first-texture stems:", top(alphaTex, 15));
    },
  };
}
