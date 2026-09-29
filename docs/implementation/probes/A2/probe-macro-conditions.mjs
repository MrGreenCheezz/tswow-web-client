// A2 (read-only): the macro-option keywords hard-coded in the 3.3.5a client binary.
// SecureCmdOptionParse is a C function (no stock Lua defines it), so the exe is the only ground truth
// for the list of conditionals. Printable strings around "unithasvehicleui" (the cluster of
// UIMacroOptions.cpp) and where the words missing from that cluster live.
import { readFile } from "node:fs/promises";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const anchor = exe.indexOf(Buffer.from("unithasvehicleui", "latin1"));
console.log("anchor", anchor);
const wide = exe.subarray(Math.max(0, anchor - 400), anchor + 700).toString("latin1");
console.log([...wide.matchAll(/[ -~]{2,}/g)].map((m) => m[0]).join(" | "));
// NUL-delimited whole-word hits, with their distance from the cluster.
for (const word of ["combat", "party", "raid", "group", "pet", "no", "target", "@", "known", "cursor", "talent", "noexists"]) {
  const needle = Buffer.concat([Buffer.from([0]), Buffer.from(word, "latin1"), Buffer.from([0])]);
  const hits = [];
  let at = exe.indexOf(needle);
  while (at >= 0 && hits.length < 40) {
    hits.push(at + 1 - anchor);
    at = exe.indexOf(needle, at + 1);
  }
  const near = hits.filter((distance) => Math.abs(distance) < 4000);
  console.log(`${word}: total>=${hits.length}, within 4000 bytes of cluster: ${near.join(",") || "-"}`);
}
