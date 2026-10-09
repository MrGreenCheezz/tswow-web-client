// A7a 6.22 census (05.10): header flag 0x08 + texture_combiner_combos (M2Array<u16> at 0x130),
// (а) flagged models by family, (б) stage-operation pairs of two-stage batches and the share outside the
// pixel-shader pairs the note lists, (в) batches the copy pass would change, (г) env batches with coord −1.
import { arr, fits, family, inc, top, skinBatches, materials, lookup, textureNames } from "./corpus.mjs";

const OPS = ["Opaque", "Mod", "Decal", "Add", "Mod2x", "Fade", "Mod2xNA", "AddNA"];
const SECOND = ["Opaque", "Mod", "Add", "Mod2x", "Mod2xNA", "AddNA"];
const KNOWN = new Set([...SECOND.map((s) => `Opaque_${s}`), ...SECOND.map((s) => `Mod_${s}`), "Add_Mod", "Mod2x_Mod2x"]);
const ENV_NAME = /reflect|envmap|\benv|_env|chrome|metal/i;

export function createProbe() {
  const t = { models: 0, flagged: 0, flaggedBadArray: 0, twoStageFlagged: 0, unknownPairs: 0, copyModels: 0, copyBatches: 0, copyChanged: 0, copyChangedModels: 0, envBatches: 0, envCoordMinus1: 0, flaggedEnv: 0 };
  const flaggedFam = new Map(), pairs = new Map(), unflaggedTwo = new Map(), unflaggedOne = new Map(), comboLen = new Map(), changedFam = new Map(), changedFields = new Map();
  const flaggedExamples = [], changedExamples = [];
  return {
    withSkin: true,
    visit(path, model, skin) {
      if (!skin || model.readUInt32LE(4) !== 264) return;
      t.models++;
      const fam = family(path);
      const flags = model.readUInt32LE(0x10);
      const flagged = (flags & 0x08) !== 0;
      let ops = null;
      if (flagged) {
        t.flagged++; inc(flaggedFam, fam);
        if (flaggedExamples.length < 10) flaggedExamples.push(path.split("\\").pop());
        const block = arr(model, 0x130);
        if (block.count > 4096 || !fits(model, block, 2)) t.flaggedBadArray++;
        else { ops = Array.from({ length: block.count }, (_, i) => model.readUInt16LE(block.offset + i * 2)); inc(comboLen, block.count); }
      }
      const mats = materials(model);
      const batches = skinBatches(skin);
      const coords = lookup(model, 0x88), combos = lookup(model, 0x80);
      const names = textureNames(model);
      for (const b of batches) {
        const stages = Math.min(b.textureCount, 4);
        if (flagged && ops && stages >= 2) {
          t.twoStageFlagged++;
          let op0 = ops[b.shaderId] ?? -1, op1 = ops[b.shaderId + 1] ?? -1;
          if ((mats[b.materialIndex]?.blendMode ?? 0) === 0) op0 = 0;
          const key = `${OPS[op0] ?? op0}_${OPS[op1] ?? op1}`;
          inc(pairs, key);
          if (!KNOWN.has(key)) t.unknownPairs++;
        } else if (!flagged) {
          inc(stages >= 2 ? unflaggedTwo : unflaggedOne, `${fam}:sh${b.shaderId}`);
        }
        // (г) env layer: a second unit named like a reflection map.
        if (stages >= 2) {
          const second = (names[combos[b.textureComboIndex + 1]] ?? "").split("\\").pop() ?? "";
          if (ENV_NAME.test(second)) {
            t.envBatches++;
            if (coords[b.textureCoordComboIndex + 1] === 0xffff) t.envCoordMinus1++;
            if (flagged) t.flaggedEnv++;
          }
        }
      }
      // (в) copy pass: runs if any batch has materialLayer > 0; a batch whose materialIndex equals the
      // previous batch's takes its shaderId, textureCount, textureComboIndex, textureTransformComboIndex (chained).
      if (batches.some((b) => b.materialLayer > 0)) {
        t.copyModels++;
        let changedHere = false;
        const sim = batches.map((b) => ({ ...b }));
        for (let i = 1; i < sim.length; i++) {
          if (sim[i].materialIndex !== sim[i - 1].materialIndex) continue;
          t.copyBatches++;
          const fields = ["shaderId", "textureCount", "textureComboIndex", "textureTransformComboIndex"].filter((f) => sim[i][f] !== sim[i - 1][f]);
          if (fields.length) {
            t.copyChanged++; changedHere = true; inc(changedFam, fam);
            for (const f of fields) inc(changedFields, f);
            if (changedExamples.length < 10) changedExamples.push(`${path.split("\\").pop()}#${i}[${fields.join(",")}]`);
          }
          for (const f of ["shaderId", "textureCount", "textureComboIndex", "textureTransformComboIndex"]) sim[i][f] = sim[i - 1][f];
        }
        if (changedHere) t.copyChangedModels++;
      }
    },
    report() {
      console.log("== probe-combiners (6.22)");
      console.log(JSON.stringify(t));
      console.log("(а) flagged by family:", top(flaggedFam) || "none", "| combiner-array lengths:", top(comboLen, 6), "| examples:", flaggedExamples.join(" "));
      console.log("(б) flagged two-stage pairs:", top(pairs, 16) || "none");
      console.log("    unflagged two-stage shaderId:", top(unflaggedTwo, 12));
      console.log("    unflagged one-stage shaderId:", top(unflaggedOne, 8));
      console.log("(в) copy pass changed by family:", top(changedFam), "| fields:", top(changedFields), "| examples:", changedExamples.join(" "));
    },
  };
}
