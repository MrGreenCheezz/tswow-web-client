// A7a 6.16е census (05.10): two-unit batches under item\ — what marks the env (reflection) layer:
// second-texture name, raw textureCoordCombos value of each unit (0xFFFF = −1), shaderId.
import { family, inc, top, skinBatches, textureNames, lookup } from "./corpus.mjs";

const ENV_NAME = /reflect|envmap|\benv|_env|chrome|metal/i;

export function createProbe() {
  const stems = new Map(), envCoord = new Map(), envShader = new Map(), otherCoord = new Map(), envCoordFirst = new Map();
  const t = { itemModels: 0, twoUnit: 0, twoUnitModels: 0, envByName: 0, envByNameModels: 0, envCoordMinus1: 0, coordMinus1Any: 0, coordMinus1NotEnvName: 0,
    envByNameCoord0: 0, allFamiliesCoordMinus1Units: 0 };
  const coordMinus1ByFam = new Map();
  return {
    withSkin: true,
    visit(path, model, skin) {
      if (!skin || model.readUInt32LE(4) !== 264) return;
      const fam = family(path);
      const combos = lookup(model, 0x80), coords = lookup(model, 0x88);
      const names = textureNames(model);
      const batches = skinBatches(skin);
      // −1 coord units anywhere (6.22 (г) context).
      for (const b of batches) for (let u = 0; u < Math.min(b.textureCount, 4); u++) if (coords[b.textureCoordComboIndex + u] === 0xffff) { t.allFamiliesCoordMinus1Units++; inc(coordMinus1ByFam, fam); }
      if (fam !== "item") return;
      t.itemModels++;
      let any = false, anyEnv = false;
      for (const b of batches) {
        if (b.textureCount < 2) continue;
        t.twoUnit++; any = true;
        const second = names[combos[b.textureComboIndex + 1]] ?? "";
        const stem = (second.split("\\").pop() ?? "").toLowerCase() || "(replaceable)";
        inc(stems, stem.replace(/\d*\.blp$/, ""));
        const c0 = coords[b.textureCoordComboIndex], c1 = coords[b.textureCoordComboIndex + 1];
        const hasMinus1 = c0 === 0xffff || c1 === 0xffff;
        if (hasMinus1) t.coordMinus1Any++;
        if (ENV_NAME.test(stem)) {
          t.envByName++; anyEnv = true;
          inc(envCoord, `u0=${c0 === 0xffff ? -1 : c0},u1=${c1 === 0xffff ? -1 : c1}`);
          inc(envShader, b.shaderId);
          if (c1 === 0xffff) t.envCoordMinus1++;
          if (c1 === 0) t.envByNameCoord0++;
        } else {
          inc(otherCoord, `u0=${c0 === 0xffff ? -1 : c0},u1=${c1 === 0xffff ? -1 : c1}|sh${b.shaderId}`);
          if (hasMinus1) t.coordMinus1NotEnvName++;
        }
        inc(envCoordFirst, `sh${b.shaderId}`);
      }
      if (any) t.twoUnitModels++;
      if (anyEnv) t.envByNameModels++;
    },
    report() {
      console.log("== probe-armorreflect (6.16е)");
      console.log(JSON.stringify(t));
      console.log("item two-unit second-texture stems:", top(stems, 12));
      console.log("env-named batches: coord combos", top(envCoord, 8), "| shaderId", top(envShader, 8));
      console.log("other two-unit batches: coord|shader", top(otherCoord, 8));
      console.log("item two-unit shaderId:", top(envCoordFirst, 8));
      console.log("units with coord −1 by family:", top(coordMinus1ByFam));
    },
  };
}
