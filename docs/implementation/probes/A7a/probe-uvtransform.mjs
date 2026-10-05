// A7a 6.16б census (05.10): texture-transform rotation axes (quaternion x/y ≠ 0) and batches whose
// SECOND texture unit reaches a transform through textureTransformCombos.
import { arr, fits, family, inc, top, lookup, skinBatches } from "./corpus.mjs";

const TRACK = 20, RECORD = 60;

export function createProbe() {
  const t = { models: 0, modelsWithTransforms: 0, records: 0, rotationKeys: 0, rotationKeysOffZ: 0, rotationRecordsOffZ: 0,
    twoUnitBatches: 0, secondUnitTransform: 0, secondUnitOnly: 0, secondDiffers: 0, modelsSecondUnit: 0 };
  const fam = new Map(), offZExamples = [], secondExamples = [];
  return {
    withSkin: true,
    visit(path, model, skin) {
      if (model.readUInt32LE(4) !== 264) return;
      t.models++;
      const block = arr(model, 0x60);
      if (block.count > 0 && block.count < 4096 && fits(model, block, RECORD)) {
        t.modelsWithTransforms++;
        for (let i = 0; i < block.count; i++) {
          t.records++;
          const rot = block.offset + i * RECORD + TRACK;
          const seqTimes = arr(model, rot + 4), seqValues = arr(model, rot + 12);
          if (seqValues.count > 1024 || !fits(model, seqValues, 8)) continue;
          let off = false;
          for (let s = 0; s < Math.min(seqTimes.count, seqValues.count); s++) {
            const keys = arr(model, seqValues.offset + s * 8);
            if (keys.count > 20_000 || !fits(model, keys, 16)) continue;
            for (let k = 0; k < keys.count; k++) {
              const at = keys.offset + k * 16;
              t.rotationKeys++;
              const x = model.readFloatLE(at), y = model.readFloatLE(at + 4);
              if (Math.abs(x) > 1e-4 || Math.abs(y) > 1e-4) { t.rotationKeysOffZ++; off = true; }
            }
          }
          if (off) { t.rotationRecordsOffZ++; if (offZExamples.length < 8) offZExamples.push(path.split("\\").pop()); }
        }
      }
      if (!skin) return;
      const combos = lookup(model, 0x98);
      let hit = false;
      for (const b of skinBatches(skin)) {
        if (b.textureCount < 2) continue;
        t.twoUnitBatches++;
        const first = combos[b.textureTransformComboIndex], second = combos[b.textureTransformComboIndex + 1];
        const has = (v) => v !== undefined && v !== 0xffff && v < block.count;
        if (b.textureTransformComboIndex !== 0xffff && has(second)) {
          t.secondUnitTransform++; hit = true;
          if (!has(first)) t.secondUnitOnly++;
          if (first !== second) t.secondDiffers++;
          inc(fam, family(path));
          if (secondExamples.length < 8) secondExamples.push(path.split("\\").pop());
        }
      }
      if (hit) t.modelsSecondUnit++;
    },
    report() {
      console.log("== probe-uvtransform (6.16б)");
      console.log(JSON.stringify(t));
      console.log("records rotating off Z (examples):", offZExamples.join(" "));
      console.log("second-unit transform by family:", top(fam), "examples:", secondExamples.join(" "));
    },
  };
}
